// biome-ignore-all lint/suspicious/noConsole: file uses console intentionally
/**
 * Chrome Native Host 纯 TypeScript 实现模块。
 *
 * 在 Claude Code 系统中，该模块提供 Chrome native messaging host 功能，
 * 之前由 Rust NAPI binding 实现，现已迁移为纯 TypeScript 实现：
 * - 通过 Unix domain socket / Windows named pipe 与 Chrome 扩展通信
 * - 处理 native messaging 协议（4 字节长度前缀的 JSON 消息帧）
 * - 管理 host 进程生命周期：启动、心跳检测、崩溃恢复
 * - 写入 native messaging host manifest 并注册到各浏览器配置目录
 *
 * Chrome Native Host - Pure TypeScript Implementation.
 * Previously implemented as a Rust NAPI binding, now in pure TypeScript.
 */

import {
  appendFile,
  chmod,
  mkdir,
  readdir,
  rmdir,
  stat,
  unlink,
} from 'fs/promises'
import { createServer, type Server, type Socket } from 'net'
import { homedir, platform } from 'os'
import { join } from 'path'
import { z } from 'zod'
import { lazySchema } from '../lazySchema.js'
import { jsonParse, jsonStringify } from '../slowOperations.js'
import { getSecureSocketPath, getSocketDir } from './common.js'

const VERSION = '1.0.0'
const MAX_MESSAGE_SIZE = 1024 * 1024 // 1MB - Max message size that can be sent to Chrome

const LOG_FILE =
  process.env.USER_TYPE === 'ant'
    ? join(homedir(), '.claude', 'debug', 'chrome-native-host.txt')
    : undefined

/**
 * 内部日志函数：将带时间戳的日志行写入调试文件（仅 ant 用户），同时输出到 stderr。
 *
 * 写文件采用 fire-and-forget 模式（void + catch），不阻塞调用方，
 * 确保事件处理器中调用也不会因 await 引发问题。
 */
function log(message: string, ...args: unknown[]): void {
  if (LOG_FILE) {
    // 生成 ISO 格式时间戳，便于日志对齐和排序
    const timestamp = new Date().toISOString()
    // 若有额外参数则序列化附加到消息末尾，无参数时为空字符串
    const formattedArgs = args.length > 0 ? ' ' + jsonStringify(args) : ''
    const logLine = `[${timestamp}] [Claude Chrome Native Host] ${message}${formattedArgs}\n`
    // Fire-and-forget: logging is best-effort and callers (including event
    // handlers) don't await
    // fire-and-forget：忽略写文件错误，保证调用方稳定性
    void appendFile(LOG_FILE, logLine).catch(() => {
      // Ignore file write errors
    })
  }
  // 同时输出到 stderr，便于调试时实时查看（不影响 stdout 的 native messaging 协议帧）
  console.error(`[Claude Chrome Native Host] ${message}`, ...args)
}
/**
 * 向 Chrome 扩展发送一条 native messaging 协议帧。
 *
 * Chrome native messaging 协议格式：
 * - 前 4 字节：消息体长度（小端 uint32）
 * - 随后 N 字节：UTF-8 编码的 JSON 消息体
 *
 * 所有输出均写入 stdout；stderr 专用于日志，两者不可混用。
 *
 * @param message 要发送的 JSON 字符串
 */
export function sendChromeMessage(message: string): void {
  // 将 JSON 字符串编码为 UTF-8 字节序列
  const jsonBytes = Buffer.from(message, 'utf-8')
  // 分配 4 字节缓冲区，写入小端序消息长度（native messaging 协议要求）
  const lengthBuffer = Buffer.alloc(4)
  lengthBuffer.writeUInt32LE(jsonBytes.length, 0)

  // 先写长度帧头，再写消息体，确保 Chrome 能正确分帧读取
  process.stdout.write(lengthBuffer)
  process.stdout.write(jsonBytes)
}

/**
 * Chrome Native Host 主入口函数：初始化 host 并持续处理来自 Chrome 的消息。
 *
 * 执行流程：
 * 1. 创建 ChromeNativeHost 实例并调用 start()，建立 Unix socket / Windows named pipe 监听
 * 2. 创建 ChromeMessageReader 实例，通过异步 stdin 读取 native messaging 帧
 * 3. 循环调用 messageReader.read()：stdin 关闭时返回 null，退出循环
 * 4. 每条消息分发给 host.handleMessage() 进行类型路由和转发
 * 5. 循环结束后调用 host.stop() 清理资源
 */
export async function runChromeNativeHost(): Promise<void> {
  log('Initializing...')

  // 创建 native host 服务端和消息读取器
  const host = new ChromeNativeHost()
  const messageReader = new ChromeMessageReader()

  // Start the native host server
  // 启动 socket 服务器，准备接受 MCP 客户端连接
  await host.start()

  // Process messages from Chrome until stdin closes
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  // 持续读取 Chrome 发来的消息，直到 stdin 关闭（Chrome 断开连接）
  while (true) {
    const message = await messageReader.read()
    if (message === null) {
      // stdin closed, Chrome disconnected
      // stdin 已关闭，Chrome 端已断开，退出主循环
      break
    }

    // 将消息路由给 host 处理（ping/get_status/tool_response/notification）
    await host.handleMessage(message)
  }

  // Stop the server
  // 清理所有 MCP 客户端连接和 socket 文件
  await host.stop()
}

const messageSchema = lazySchema(() =>
  z
    .object({
      type: z.string(),
    })
    .passthrough(),
)

type ToolRequest = {
  method: string
  params?: unknown
}

type McpClient = {
  id: number
  socket: Socket
  buffer: Buffer
}

class ChromeNativeHost {
  // 当前已连接的 MCP 客户端映射（clientId → McpClient）
  private mcpClients = new Map<number, McpClient>()
  // 自增客户端 ID，每次新连接递增，用于唯一标识每个 MCP 客户端
  private nextClientId = 1
  // Unix domain socket / Windows named pipe 服务器实例
  private server: Server | null = null
  // 服务器是否已启动的状态标志
  private running = false
  // 当前 socket 文件路径（Unix）或 pipe 名称（Windows）
  private socketPath: string | null = null

  /**
   * 启动 native host socket 服务器，监听 MCP 客户端连接。
   *
   * 执行步骤（非 Windows）：
   * 1. 迁移遗留路径：若 socketDir 以普通文件形式存在则删除（旧版兼容）
   * 2. 创建 socket 目录并设置 0700 权限（仅当前用户可访问）
   * 3. 扫描目录，清理所有僵尸 .sock 文件（进程已死但文件未删除）
   * 4. 创建 TCP/IPC 服务器，绑定 socketPath 并开始监听
   * 5. 监听成功后将 socket 文件权限设置为 0600
   */
  async start(): Promise<void> {
    // 已在运行则幂等返回，避免重复初始化
    if (this.running) {
      return
    }

    // 获取本次进程专属的安全 socket 路径（含 PID）
    this.socketPath = getSecureSocketPath()

    if (platform() !== 'win32') {
      const socketDir = getSocketDir()

      // Migrate legacy socket: if socket dir path exists as a file/socket, remove it
      // 兼容旧版：若 socketDir 路径已作为文件或 socket 存在，则删除，再创建目录
      try {
        const dirStats = await stat(socketDir)
        if (!dirStats.isDirectory()) {
          await unlink(socketDir)
        }
      } catch {
        // Doesn't exist, that's fine
        // 路径不存在属正常情况，无需处理
      }

      // Create socket directory with secure permissions
      // 以 0700 权限创建 socket 目录，防止其他用户访问
      await mkdir(socketDir, { recursive: true, mode: 0o700 })

      // Fix perms if directory already existed
      // 若目录已存在（权限可能不正确），强制修正为 0700
      await chmod(socketDir, 0o700).catch(() => {
        // Ignore
      })

      // Clean up stale sockets
      // 扫描目录，删除所属进程已退出的僵尸 .sock 文件
      try {
        const files = await readdir(socketDir)
        for (const file of files) {
          if (!file.endsWith('.sock')) {
            continue
          }
          // 从文件名中提取 PID
          const pid = parseInt(file.replace('.sock', ''), 10)
          if (isNaN(pid)) {
            continue
          }
          try {
            // kill(pid, 0)：不发送信号，仅检测进程是否存活
            process.kill(pid, 0)
            // Process is alive, leave it
            // 进程仍在运行，保留其 socket 文件
          } catch {
            // Process is dead, remove stale socket
            // 进程已死亡，清理对应的僵尸 socket 文件
            await unlink(join(socketDir, file)).catch(() => {
              // Ignore
            })
            log(`Removed stale socket for PID ${pid}`)
          }
        }
      } catch {
        // Ignore errors scanning directory
        // 扫描目录失败时静默忽略，不影响启动流程
      }
    }

    log(`Creating socket listener: ${this.socketPath}`)

    // 创建 IPC 服务器，每个新连接触发 handleMcpClient
    this.server = createServer(socket => this.handleMcpClient(socket))

    // 绑定 socket 路径并等待监听就绪
    await new Promise<void>((resolve, reject) => {
      this.server!.listen(this.socketPath!, () => {
        log('Socket server listening for connections')
        this.running = true
        resolve()
      })

      this.server!.on('error', err => {
        log('Socket server error:', err)
        reject(err)
      })
    })

    // Set permissions on Unix (after listen resolves so socket file exists)
    // 监听成功后 socket 文件已创建，此时设置 0600 权限确保仅当前用户可读写
    if (platform() !== 'win32') {
      try {
        await chmod(this.socketPath!, 0o600)
        log('Socket permissions set to 0600')
      } catch (e) {
        log('Failed to set socket permissions:', e)
      }
    }
  }

  /**
   * 停止 native host 服务器并清理所有资源。
   *
   * 执行步骤：
   * 1. 强制销毁所有已连接的 MCP 客户端 socket
   * 2. 关闭 IPC 服务器，等待关闭回调
   * 3. 删除 Unix socket 文件；若目录为空则一并删除
   */
  async stop(): Promise<void> {
    // 未运行则幂等返回
    if (!this.running) {
      return
    }

    // Close all MCP clients
    // 强制销毁所有 MCP 客户端 socket，释放连接资源
    for (const [, client] of this.mcpClients) {
      client.socket.destroy()
    }
    this.mcpClients.clear()

    // Close server
    // 关闭服务器监听，等待所有连接处理完毕
    if (this.server) {
      await new Promise<void>(resolve => {
        this.server!.close(() => resolve())
      })
      this.server = null
    }

    // Cleanup socket file
    // 删除 Unix socket 文件（Windows named pipe 由 OS 自动回收）
    if (platform() !== 'win32' && this.socketPath) {
      try {
        await unlink(this.socketPath)
        log('Cleaned up socket file')
      } catch {
        // ENOENT is fine, ignore
        // 文件已被其他进程删除属正常，忽略
      }

      // Remove directory if empty
      // 若 socket 目录已无其他文件则一并清理
      try {
        const socketDir = getSocketDir()
        const remaining = await readdir(socketDir)
        if (remaining.length === 0) {
          await rmdir(socketDir)
          log('Removed empty socket directory')
        }
      } catch {
        // Ignore
      }
    }

    this.running = false
  }

  async isRunning(): Promise<boolean> {
    return this.running
  }

  async getClientCount(): Promise<number> {
    return this.mcpClients.size
  }

  /**
   * 处理来自 Chrome 扩展的单条 native messaging JSON 消息。
   *
   * 消息类型路由：
   * - ping：回复 pong + 时间戳，用于心跳检测
   * - get_status：回复版本号
   * - tool_response：将 Chrome 工具执行结果广播给所有 MCP 客户端
   * - notification：将 Chrome 推送的通知广播给所有 MCP 客户端
   * - 未知类型：回复 error 帧，记录日志
   *
   * @param messageJson 来自 Chrome 的原始 JSON 字符串
   */
  async handleMessage(messageJson: string): Promise<void> {
    let rawMessage: unknown
    try {
      // 解析 JSON 字符串为原始对象
      rawMessage = jsonParse(messageJson)
    } catch (e) {
      log('Invalid JSON from Chrome:', (e as Error).message)
      // 解析失败时向 Chrome 返回错误帧
      sendChromeMessage(
        jsonStringify({
          type: 'error',
          error: 'Invalid message format',
        }),
      )
      return
    }
    // 用 Zod schema 校验消息结构（至少包含 type 字段）
    const parsed = messageSchema().safeParse(rawMessage)
    if (!parsed.success) {
      log('Invalid message from Chrome:', parsed.error.message)
      sendChromeMessage(
        jsonStringify({
          type: 'error',
          error: 'Invalid message format',
        }),
      )
      return
    }
    const message = parsed.data

    log(`Handling Chrome message type: ${message.type}`)

    switch (message.type) {
      case 'ping':
        // 心跳探测：回复 pong + 当前时间戳
        log('Responding to ping')

        sendChromeMessage(
          jsonStringify({
            type: 'pong',
            timestamp: Date.now(),
          }),
        )
        break

      case 'get_status':
        // 状态查询：回复 native host 版本号
        sendChromeMessage(
          jsonStringify({
            type: 'status_response',
            native_host_version: VERSION,
          }),
        )
        break

      case 'tool_response': {
        // 工具响应：将 Chrome 执行工具的结果转发给所有已连接的 MCP 客户端
        if (this.mcpClients.size > 0) {
          log(`Forwarding tool response to ${this.mcpClients.size} MCP clients`)

          // Extract the data portion (everything except 'type')
          // 去掉顶层 type 字段，仅保留业务数据部分转发给 MCP 客户端
          const { type: _, ...data } = message
          const responseData = Buffer.from(jsonStringify(data), 'utf-8')
          // 构造 4 字节长度前缀帧头
          const lengthBuffer = Buffer.alloc(4)
          lengthBuffer.writeUInt32LE(responseData.length, 0)
          const responseMsg = Buffer.concat([lengthBuffer, responseData])

          // 广播给所有 MCP 客户端
          for (const [id, client] of this.mcpClients) {
            try {
              client.socket.write(responseMsg)
            } catch (e) {
              log(`Failed to send to MCP client ${id}:`, e)
            }
          }
        }
        break
      }

      case 'notification': {
        // 通知转发：将 Chrome 推送的事件通知广播给所有 MCP 客户端
        if (this.mcpClients.size > 0) {
          log(`Forwarding notification to ${this.mcpClients.size} MCP clients`)

          // Extract the data portion (everything except 'type')
          // 同样去掉 type 字段，仅转发通知数据
          const { type: _, ...data } = message
          const notificationData = Buffer.from(jsonStringify(data), 'utf-8')
          const lengthBuffer = Buffer.alloc(4)
          lengthBuffer.writeUInt32LE(notificationData.length, 0)
          const notificationMsg = Buffer.concat([
            lengthBuffer,
            notificationData,
          ])

          // 广播给所有 MCP 客户端
          for (const [id, client] of this.mcpClients) {
            try {
              client.socket.write(notificationMsg)
            } catch (e) {
              log(`Failed to send notification to MCP client ${id}:`, e)
            }
          }
        }
        break
      }

      default:
        // 未知消息类型：记录日志并向 Chrome 返回错误帧
        log(`Unknown message type: ${message.type}`)

        sendChromeMessage(
          jsonStringify({
            type: 'error',
            error: `Unknown message type: ${message.type}`,
          }),
        )
    }
  }

  /**
   * 处理新连接的 MCP 客户端 socket。
   *
   * 注册三个事件监听器：
   * - data：将接收到的数据追加到客户端缓冲区，按 4+N 协议帧解包后转发给 Chrome
   * - error：记录错误日志
   * - close：从客户端映射中移除该客户端，并通知 Chrome 已断开连接
   *
   * @param socket 新连接的 MCP 客户端 socket
   */
  private handleMcpClient(socket: Socket): void {
    // 为该连接分配唯一 ID
    const clientId = this.nextClientId++
    const client: McpClient = {
      id: clientId,
      socket,
      buffer: Buffer.alloc(0),
    }

    // 注册客户端到映射中
    this.mcpClients.set(clientId, client)
    log(
      `MCP client ${clientId} connected. Total clients: ${this.mcpClients.size}`,
    )

    // Notify Chrome of connection
    // 通知 Chrome 扩展：有新的 MCP 客户端已连接
    sendChromeMessage(
      jsonStringify({
        type: 'mcp_connected',
      }),
    )

    socket.on('data', (data: Buffer) => {
      // 将新到达的数据追加到客户端私有缓冲区
      client.buffer = Buffer.concat([client.buffer, data])

      // Process complete messages
      // 循环解包：只要缓冲区中有完整的消息帧则持续处理
      while (client.buffer.length >= 4) {
        // 读取帧头中的消息体长度（小端 uint32）
        const length = client.buffer.readUInt32LE(0)

        // 消息长度为 0 或超过最大限制则视为非法，断开连接
        if (length === 0 || length > MAX_MESSAGE_SIZE) {
          log(`Invalid message length from MCP client ${clientId}: ${length}`)
          socket.destroy()
          return
        }

        if (client.buffer.length < 4 + length) {
          break // Wait for more data
          // 完整消息体尚未到达，等待下一次 data 事件
        }

        // 提取消息体字节并从缓冲区中移除已消费的帧
        const messageBytes = client.buffer.slice(4, 4 + length)
        client.buffer = client.buffer.slice(4 + length)

        try {
          // 将消息体解析为 ToolRequest 结构
          const request = jsonParse(
            messageBytes.toString('utf-8'),
          ) as ToolRequest
          log(
            `Forwarding tool request from MCP client ${clientId}: ${request.method}`,
          )

          // Forward to Chrome
          // 将 MCP 工具调用请求转发给 Chrome 扩展执行
          sendChromeMessage(
            jsonStringify({
              type: 'tool_request',
              method: request.method,
              params: request.params,
            }),
          )
        } catch (e) {
          log(`Failed to parse tool request from MCP client ${clientId}:`, e)
        }
      }
    })

    socket.on('error', err => {
      // 记录 socket 错误，由 close 事件负责清理
      log(`MCP client ${clientId} error: ${err}`)
    })

    socket.on('close', () => {
      log(
        `MCP client ${clientId} disconnected. Remaining clients: ${this.mcpClients.size - 1}`,
      )
      // 从客户端映射中移除已断开的客户端
      this.mcpClients.delete(clientId)

      // Notify Chrome of disconnection
      // 通知 Chrome 扩展：某个 MCP 客户端已断开
      sendChromeMessage(
        jsonStringify({
          type: 'mcp_disconnected',
        }),
      )
    })
  }
}

/**
 * Chrome native messaging 异步消息读取器。
 *
 * 背景：Bun 中同步读取 stdin 会导致崩溃，因此改用异步事件驱动读取：
 * - 构造函数订阅 stdin 的 data / end / error 事件，维护私有字节缓冲区
 * - read() 方法：若缓冲区中已有完整帧则立即返回；否则挂起 Promise，
 *   等待下一次 data 事件触发 tryProcessMessage() 解析并 resolve
 * - stdin 关闭或出错时，挂起的 Promise resolve(null)，通知调用方停止读取
 */
class ChromeMessageReader {
  // 接收到的未处理字节缓冲区，由 data 事件持续追加
  private buffer = Buffer.alloc(0)
  // 当前挂起等待消息的 resolve 回调；null 表示没有等待中的 read()
  private pendingResolve: ((value: string | null) => void) | null = null
  // stdin 是否已关闭（end 或 error 事件触发后置为 true）
  private closed = false

  constructor() {
    // 订阅 stdin data 事件：将新数据追加到缓冲区并尝试解帧
    process.stdin.on('data', (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk])
      this.tryProcessMessage()
    })

    // stdin 正常关闭（Chrome 断开连接）：标记关闭并 resolve 挂起的 Promise
    process.stdin.on('end', () => {
      this.closed = true
      if (this.pendingResolve) {
        this.pendingResolve(null)
        this.pendingResolve = null
      }
    })

    // stdin 读取错误（管道断裂等）：同样标记关闭并通知挂起的 Promise
    process.stdin.on('error', () => {
      this.closed = true
      if (this.pendingResolve) {
        this.pendingResolve(null)
        this.pendingResolve = null
      }
    })
  }

  /**
   * 尝试从当前缓冲区中解析一条完整的 native messaging 消息帧。
   *
   * 仅在存在挂起的 read() 调用（pendingResolve != null）时才执行：
   * 1. 缓冲区不足 4 字节（帧头未到齐）则直接返回继续等待
   * 2. 读取长度字段，若超出范围则视为非法消息，resolve(null) 终止读取
   * 3. 缓冲区不足 4+length 字节（消息体未到齐）则返回继续等待
   * 4. 提取消息体，消费已处理字节，resolve 字符串内容
   */
  private tryProcessMessage(): void {
    // 没有等待中的 Promise，无需处理
    if (!this.pendingResolve) {
      return
    }

    // Need at least 4 bytes for length prefix
    // 帧头（4 字节长度）尚未到齐，继续等待
    if (this.buffer.length < 4) {
      return
    }

    // 读取小端序消息长度
    const length = this.buffer.readUInt32LE(0)

    // 消息长度非法（0 或超过 1MB 上限），终止读取
    if (length === 0 || length > MAX_MESSAGE_SIZE) {
      log(`Invalid message length: ${length}`)
      this.pendingResolve(null)
      this.pendingResolve = null
      return
    }

    // Check if we have the full message
    // 消息体尚未完整到达，继续等待
    if (this.buffer.length < 4 + length) {
      return // Wait for more data
    }

    // Extract the message
    // 提取消息体字节，并从缓冲区中移除已消费的帧（帧头 + 消息体）
    const messageBytes = this.buffer.subarray(4, 4 + length)
    this.buffer = this.buffer.subarray(4 + length)

    // 将消息体解码为 UTF-8 字符串，resolve 等待中的 read()
    const message = messageBytes.toString('utf-8')
    this.pendingResolve(message)
    this.pendingResolve = null
  }

  /**
   * 异步读取下一条完整的 native messaging 消息帧。
   *
   * - 若 stdin 已关闭则立即返回 null
   * - 若缓冲区中已有完整帧则同步提取并返回
   * - 否则返回 Promise，等待 data 事件触发 tryProcessMessage() 解析后 resolve
   *   （为避免竞态，设置 pendingResolve 后立即再次调用 tryProcessMessage）
   *
   * @returns 消息 JSON 字符串，或 null（stdin 已关闭 / 消息非法）
   */
  async read(): Promise<string | null> {
    // stdin 已关闭，无需再等待
    if (this.closed) {
      return null
    }

    // Check if we already have a complete message buffered
    // 检查缓冲区中是否已有可直接解帧的完整消息
    if (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0)
      if (
        length > 0 &&
        length <= MAX_MESSAGE_SIZE &&
        this.buffer.length >= 4 + length
      ) {
        // 缓冲区已有完整帧，直接提取并返回，无需挂起 Promise
        const messageBytes = this.buffer.subarray(4, 4 + length)
        this.buffer = this.buffer.subarray(4 + length)
        return messageBytes.toString('utf-8')
      }
    }

    // Wait for more data
    // 缓冲区无完整帧，挂起 Promise 等待更多 data 事件
    return new Promise(resolve => {
      this.pendingResolve = resolve
      // In case data arrived between check and setting pendingResolve
      // 防止竞态：在设置 pendingResolve 前可能已有数据到达，立即尝试一次解帧
      this.tryProcessMessage()
    })
  }
}
