/**
 * @file SessionsWebSocket.ts
 * @description CCR 会话 WebSocket 客户端 —— 负责与 Anthropic API 建立持久化 WebSocket 连接，
 * 订阅远端 CCR 容器的消息流。
 *
 * 在整个 Claude Code 系统流程中的位置：
 *   RemoteSessionManager
 *     └─► SessionsWebSocket（本文件）
 *           ├─► Bun globalThis.WebSocket（Bun 运行时路径）
 *           └─► ws npm package（Node.js 运行时路径）
 *
 * 主要职责：
 *  1. 连接到 wss://api.anthropic.com/v1/sessions/ws/{sessionId}/subscribe
 *  2. 处理 WebSocket 消息，解析 JSON 并分发给上层回调
 *  3. 断线重连：普通断线最多重连 5 次（间隔 2 秒）
 *  4. 会话未找到（4001）：视为瞬时故障，最多重试 3 次（用于压缩期间的短暂失效）
 *  5. 永久关闭码（4003 未授权）：立即停止重连
 *  6. 心跳 ping：每 30 秒发送一次 ping，维持长连接活跃
 *  7. 双运行时支持：Bun（原生 WebSocket + headers）和 Node.js（ws 包）
 */

import { randomUUID } from 'crypto'
import { getOauthConfig } from '../constants/oauth.js'
import type { SDKMessage } from '../entrypoints/agentSdkTypes.js'
import type {
  SDKControlCancelRequest,
  SDKControlRequest,
  SDKControlRequestInner,
  SDKControlResponse,
} from '../entrypoints/sdk/controlTypes.js'
import { logForDebugging } from '../utils/debug.js'
import { errorMessage } from '../utils/errors.js'
import { logError } from '../utils/log.js'
import { getWebSocketTLSOptions } from '../utils/mtls.js'
import { getWebSocketProxyAgent, getWebSocketProxyUrl } from '../utils/proxy.js'
import { jsonParse, jsonStringify } from '../utils/slowOperations.js'

// 重连基础延迟（毫秒）：每次重连等待 2 秒后重试
const RECONNECT_DELAY_MS = 2000
// 最大重连尝试次数：超过后触发 onClose（永久断开）
const MAX_RECONNECT_ATTEMPTS = 5
// Ping 心跳间隔（毫秒）：每 30 秒发送一次 ping 维持连接
const PING_INTERVAL_MS = 30000

/**
 * 会话未找到（4001）的最大重试次数。
 * 压缩期间服务端可能短暂认为会话已过期，有限次重试可让客户端自动恢复。
 */
const MAX_SESSION_NOT_FOUND_RETRIES = 3

/**
 * 表示服务端永久拒绝连接的 WebSocket 关闭码集合。
 * 遇到这些关闭码时，客户端立即停止重连。
 * 注意：4001（会话未找到）由单独逻辑处理，支持有限次重试。
 */
const PERMANENT_CLOSE_CODES = new Set([
  4003, // unauthorized：未授权，不重连
])

/** WebSocket 内部状态机的状态类型 */
type WebSocketState = 'connecting' | 'connected' | 'closed'

/**
 * 通过 WebSocket 传输的所有消息类型的联合类型：
 * 包括业务消息（SDKMessage）和控制平面消息（SDKControlRequest/Response/CancelRequest）。
 */
type SessionsMessage =
  | SDKMessage
  | SDKControlRequest
  | SDKControlResponse
  | SDKControlCancelRequest

/**
 * 类型守卫：判断反序列化后的 unknown 值是否为合法的 SessionsMessage。
 *
 * 策略：只要具有字符串类型的 `type` 字段即视为合法。
 * 不使用硬编码白名单，以免后端新增消息类型时被静默丢弃。
 * 下游处理器（sdkMessageAdapter、RemoteSessionManager）负责处理未知类型。
 *
 * @param value 待检测的未知值
 * @returns 是否为 SessionsMessage
 */
function isSessionsMessage(value: unknown): value is SessionsMessage {
  if (typeof value !== 'object' || value === null || !('type' in value)) {
    return false
  }
  // 宽松策略：任何带字符串 type 字段的对象都视为合法消息
  return typeof value.type === 'string'
}

/**
 * SessionsWebSocket 事件回调集合，供 RemoteSessionManager 订阅。
 *
 * - onMessage：收到已解析的消息时触发
 * - onClose：连接永久关闭（服务端主动结束 或 重连次数耗尽）时触发
 * - onError：遇到 WebSocket 错误时触发
 * - onConnected：连接握手成功时触发
 * - onReconnecting：检测到瞬时断开并安排重连时触发（onClose 仅在永久断开时触发）
 */
export type SessionsWebSocketCallbacks = {
  onMessage: (message: SessionsMessage) => void
  onClose?: () => void
  onError?: (error: Error) => void
  onConnected?: () => void
  /** 检测到瞬时断开并正在重连退避时触发；永久断开时只触发 onClose。 */
  onReconnecting?: () => void
}

/**
 * Bun 原生 WebSocket 和 Node.js ws 包的公共接口。
 * 提取最小公共方法集，避免在业务逻辑中进行类型断言。
 */
type WebSocketLike = {
  close(): void
  send(data: string): void
  ping?(): void // Bun 和 ws 均支持 ping
}

/**
 * CCR 会话 WebSocket 客户端。
 *
 * 协议流程：
 *  1. 连接至 wss://api.anthropic.com/v1/sessions/ws/{sessionId}/subscribe?organization_uuid=...
 *  2. 通过 HTTP headers 完成 OAuth 鉴权（连接建立即视为已鉴权）
 *  3. 接收 SDKMessage 和控制消息流
 *  4. 支持通过 sendControlResponse / sendControlRequest 双向通信
 *
 * 状态机：
 *  closed → connecting → connected → closed（重连或永久断开）
 */
export class SessionsWebSocket {
  private ws: WebSocketLike | null = null           // 底层 WebSocket 实例
  private state: WebSocketState = 'closed'           // 当前连接状态
  private reconnectAttempts = 0                      // 累计重连尝试次数
  private sessionNotFoundRetries = 0                 // 4001 重试计数
  private pingInterval: NodeJS.Timeout | null = null // ping 心跳定时器
  private reconnectTimer: NodeJS.Timeout | null = null // 重连延迟定时器

  constructor(
    private readonly sessionId: string,
    private readonly orgUuid: string,
    private readonly getAccessToken: () => string, // 函数形式，支持令牌随时刷新
    private readonly callbacks: SessionsWebSocketCallbacks,
  ) {}

  /**
   * 建立与 CCR 会话订阅端点的 WebSocket 连接。
   *
   * 实现两条并行路径：
   *  - Bun 路径：使用 globalThis.WebSocket，通过 options 对象传递 headers 和 proxy
   *  - Node.js 路径：动态 import ws 包，通过构造函数选项传递 headers 和 agent
   *
   * 连接成功后立即启动心跳 ping，并重置重连计数器。
   * 若已在 connecting 状态，则忽略重复调用。
   */
  async connect(): Promise<void> {
    if (this.state === 'connecting') {
      logForDebugging('[SessionsWebSocket] Already connecting')
      return // 防止并发重复连接
    }

    this.state = 'connecting'

    // 构造 WebSocket 订阅 URL，将 HTTPS 基址转换为 WSS
    const baseUrl = getOauthConfig().BASE_API_URL.replace('https://', 'wss://')
    const url = `${baseUrl}/v1/sessions/ws/${this.sessionId}/subscribe?organization_uuid=${this.orgUuid}`

    logForDebugging(`[SessionsWebSocket] Connecting to ${url}`)

    // 每次连接前重新获取令牌，确保使用最新的 OAuth 令牌（防止令牌过期）
    const accessToken = this.getAccessToken()
    const headers = {
      Authorization: `Bearer ${accessToken}`,
      'anthropic-version': '2023-06-01', // API 版本标头
    }

    if (typeof Bun !== 'undefined') {
      // ——— Bun 运行时路径 ———
      // Bun 的 WebSocket 支持 headers 选项，但 DOM 类型不包含此扩展，使用类型断言绕过
      // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
      const ws = new globalThis.WebSocket(url, {
        headers,
        proxy: getWebSocketProxyUrl(url),  // 支持 HTTP/HTTPS 代理
        tls: getWebSocketTLSOptions() || undefined, // 支持 mTLS 证书配置
      } as unknown as string[])
      this.ws = ws

      ws.addEventListener('open', () => {
        logForDebugging(
          '[SessionsWebSocket] Connection opened, authenticated via headers',
        )
        this.state = 'connected'
        this.reconnectAttempts = 0          // 连接成功后重置重连计数
        this.sessionNotFoundRetries = 0     // 重置 4001 重试计数
        this.startPingInterval()            // 启动心跳 ping
        this.callbacks.onConnected?.()
      })

      ws.addEventListener('message', (event: MessageEvent) => {
        // 确保消息数据为字符串（Bun 可能传递非字符串类型）
        const data =
          typeof event.data === 'string' ? event.data : String(event.data)
        this.handleMessage(data)
      })

      ws.addEventListener('error', () => {
        const err = new Error('[SessionsWebSocket] WebSocket error')
        logError(err)
        this.callbacks.onError?.(err)
      })

      // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
      ws.addEventListener('close', (event: CloseEvent) => {
        logForDebugging(
          `[SessionsWebSocket] Closed: code=${event.code} reason=${event.reason}`,
        )
        this.handleClose(event.code) // 根据关闭码决定是否重连
      })

      ws.addEventListener('pong', () => {
        logForDebugging('[SessionsWebSocket] Pong received') // 仅记录日志，无需业务处理
      })
    } else {
      // ——— Node.js 运行时路径 ———
      const { default: WS } = await import('ws') // 动态导入，避免在 Bun 环境加载不必要模块
      const ws = new WS(url, {
        headers,
        agent: getWebSocketProxyAgent(url),  // 支持代理
        ...getWebSocketTLSOptions(),          // 支持 mTLS
      })
      this.ws = ws

      ws.on('open', () => {
        logForDebugging(
          '[SessionsWebSocket] Connection opened, authenticated via headers',
        )
        // 通过 headers 完成鉴权，open 事件即表示连接和鉴权均成功
        this.state = 'connected'
        this.reconnectAttempts = 0
        this.sessionNotFoundRetries = 0
        this.startPingInterval()
        this.callbacks.onConnected?.()
      })

      ws.on('message', (data: Buffer) => {
        this.handleMessage(data.toString()) // Buffer 转字符串后处理
      })

      ws.on('error', (err: Error) => {
        logError(new Error(`[SessionsWebSocket] Error: ${err.message}`))
        this.callbacks.onError?.(err)
      })

      ws.on('close', (code: number, reason: Buffer) => {
        logForDebugging(
          `[SessionsWebSocket] Closed: code=${code} reason=${reason.toString()}`,
        )
        this.handleClose(code)
      })

      ws.on('pong', () => {
        logForDebugging('[SessionsWebSocket] Pong received')
      })
    }
  }

  /**
   * 解析并分发收到的 WebSocket 消息。
   *
   * 流程：
   *  1. 将 JSON 字符串解析为 unknown 对象
   *  2. 使用 isSessionsMessage 类型守卫验证消息合法性
   *  3. 合法消息分发给 callbacks.onMessage，非法消息记录日志后忽略
   *  4. 解析失败时记录错误，不中断连接
   *
   * @param data 从 WebSocket 收到的原始字符串数据
   */
  private handleMessage(data: string): void {
    try {
      const message: unknown = jsonParse(data)

      if (isSessionsMessage(message)) {
        this.callbacks.onMessage(message) // 转发给 RemoteSessionManager 处理
      } else {
        logForDebugging(
          `[SessionsWebSocket] Ignoring message type: ${typeof message === 'object' && message !== null && 'type' in message ? String(message.type) : 'unknown'}`,
        )
      }
    } catch (error) {
      // JSON 解析失败时记录错误，继续保持连接（单条消息损坏不应导致断连）
      logError(
        new Error(
          `[SessionsWebSocket] Failed to parse message: ${errorMessage(error)}`,
        ),
      )
    }
  }

  /**
   * 处理 WebSocket 连接关闭事件，根据关闭码和当前状态决定重连策略。
   *
   * 关闭码处理逻辑：
   *  - PERMANENT_CLOSE_CODES（4003）：立即触发 onClose，不重连
   *  - 4001（会话未找到）：最多重试 MAX_SESSION_NOT_FOUND_RETRIES 次（压缩期间的瞬时状态）
   *  - 其他码且之前已连接：最多重连 MAX_RECONNECT_ATTEMPTS 次
   *  - 其他情况：触发 onClose
   *
   * @param closeCode WebSocket 关闭码
   */
  private handleClose(closeCode: number): void {
    this.stopPingInterval() // 停止心跳，避免向已关闭的连接发送 ping

    if (this.state === 'closed') {
      return // 已处于关闭状态（可能是 close() 主动调用后），忽略重复的关闭事件
    }

    this.ws = null

    const previousState = this.state
    this.state = 'closed'

    // 永久关闭码：服务端明确拒绝，不重连
    if (PERMANENT_CLOSE_CODES.has(closeCode)) {
      logForDebugging(
        `[SessionsWebSocket] Permanent close code ${closeCode}, not reconnecting`,
      )
      this.callbacks.onClose?.()
      return
    }

    // 4001（会话未找到）：压缩期间可能短暂出现，使用递增延迟进行有限次重试
    if (closeCode === 4001) {
      this.sessionNotFoundRetries++
      if (this.sessionNotFoundRetries > MAX_SESSION_NOT_FOUND_RETRIES) {
        logForDebugging(
          `[SessionsWebSocket] 4001 retry budget exhausted (${MAX_SESSION_NOT_FOUND_RETRIES}), not reconnecting`,
        )
        this.callbacks.onClose?.()
        return
      }
      // 使用 sessionNotFoundRetries * 基础延迟，实现线性退避
      this.scheduleReconnect(
        RECONNECT_DELAY_MS * this.sessionNotFoundRetries,
        `4001 attempt ${this.sessionNotFoundRetries}/${MAX_SESSION_NOT_FOUND_RETRIES}`,
      )
      return
    }

    // 普通断线：若之前处于已连接状态且未超过最大重连次数，则安排重连
    if (
      previousState === 'connected' &&
      this.reconnectAttempts < MAX_RECONNECT_ATTEMPTS
    ) {
      this.reconnectAttempts++
      this.scheduleReconnect(
        RECONNECT_DELAY_MS,
        `attempt ${this.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}`,
      )
    } else {
      // 重连次数耗尽或非连接状态断线，永久关闭
      logForDebugging('[SessionsWebSocket] Not reconnecting')
      this.callbacks.onClose?.()
    }
  }

  /**
   * 安排延迟重连，并通知上层正在重连中。
   *
   * 重连定时器存储在 reconnectTimer 中，可在 close() 时取消，
   * 防止主动断开后仍触发重连。
   *
   * @param delay 重连前等待的毫秒数
   * @param label 日志标签，用于区分不同重连原因
   */
  private scheduleReconnect(delay: number, label: string): void {
    this.callbacks.onReconnecting?.() // 通知上层重连中（UI 可显示"重新连接中…"）
    logForDebugging(
      `[SessionsWebSocket] Scheduling reconnect (${label}) in ${delay}ms`,
    )
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.connect() // 发起新连接
    }, delay)
  }

  /**
   * 启动心跳 ping 定时器。
   *
   * 每 PING_INTERVAL_MS 毫秒向服务端发送一次 ping，维持连接活跃，
   * 防止中间代理/负载均衡器因空闲超时关闭连接。
   * 调用前先停止已有定时器，防止重复启动。
   */
  private startPingInterval(): void {
    this.stopPingInterval() // 先清除可能存在的旧定时器

    this.pingInterval = setInterval(() => {
      if (this.ws && this.state === 'connected') {
        try {
          this.ws.ping?.() // ping? 是可选方法，Bun 和 ws 均支持
        } catch {
          // ping 发送失败时忽略异常，连接中断由 close 事件处理
        }
      }
    }, PING_INTERVAL_MS)
  }

  /**
   * 停止心跳 ping 定时器，清理 pingInterval 引用。
   */
  private stopPingInterval(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval)
      this.pingInterval = null
    }
  }

  /**
   * 通过 WebSocket 向 CCR 发送控制响应（如权限 allow/deny、错误响应）。
   *
   * 仅在已连接状态下发送，否则记录错误并返回。
   *
   * @param response 要发送的 SDKControlResponse 对象
   */
  sendControlResponse(response: SDKControlResponse): void {
    if (!this.ws || this.state !== 'connected') {
      logError(new Error('[SessionsWebSocket] Cannot send: not connected'))
      return
    }

    logForDebugging('[SessionsWebSocket] Sending control response')
    this.ws.send(jsonStringify(response)) // 序列化为 JSON 字符串后发送
  }

  /**
   * 通过 WebSocket 向 CCR 发送控制请求（如 interrupt 中断信号）。
   *
   * 每次发送时生成新的 randomUUID 作为 request_id，确保服务端能区分不同请求。
   *
   * @param request 控制请求的内容（SDKControlRequestInner，如 { subtype: 'interrupt' }）
   */
  sendControlRequest(request: SDKControlRequestInner): void {
    if (!this.ws || this.state !== 'connected') {
      logError(new Error('[SessionsWebSocket] Cannot send: not connected'))
      return
    }

    // 包装为完整的 SDKControlRequest，附加 type 和随机 request_id
    const controlRequest: SDKControlRequest = {
      type: 'control_request',
      request_id: randomUUID(), // 每次请求使用唯一 ID
      request,
    }

    logForDebugging(
      `[SessionsWebSocket] Sending control request: ${request.subtype}`,
    )
    this.ws.send(jsonStringify(controlRequest))
  }

  /**
   * 检查当前 WebSocket 是否处于已连接（connected）状态。
   *
   * @returns 已连接返回 true，其他状态返回 false
   */
  isConnected(): boolean {
    return this.state === 'connected'
  }

  /**
   * 主动关闭 WebSocket 连接，并清理所有定时器和状态。
   *
   * 执行步骤：
   *  1. 将 state 设为 'closed'，阻止 handleClose 触发重连
   *  2. 停止 ping 心跳定时器
   *  3. 取消待执行的重连定时器
   *  4. 关闭底层 WebSocket 并置空引用
   *
   * 注意：由于 state 已设为 closed，handleClose 回调中的重连逻辑不会触发。
   */
  close(): void {
    logForDebugging('[SessionsWebSocket] Closing connection')
    this.state = 'closed' // 先设置状态，阻止 close 事件触发重连
    this.stopPingInterval()

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer) // 取消待执行的重连
      this.reconnectTimer = null
    }

    if (this.ws) {
      // 关闭底层连接。
      // Bun：onX 处理器会在 ws 关闭后触发，但 state 已为 closed，handleClose 会提前返回。
      // Node.js ws：.on() 监听器在 ws.close() 后仍可能触发，但同样因 state 提前返回。
      this.ws.close()
      this.ws = null
    }
  }

  /**
   * 强制重新连接：关闭现有连接并在短暂延迟后重建。
   *
   * 适用场景：订阅通道因 CCR 容器重启而变为陈旧（stale）时，
   * 通过强制重连恢复消息接收。
   * 重置所有重连计数器，使重连配额恢复为满值。
   */
  reconnect(): void {
    logForDebugging('[SessionsWebSocket] Force reconnecting')
    this.reconnectAttempts = 0          // 重置普通重连计数
    this.sessionNotFoundRetries = 0     // 重置 4001 重试计数
    this.close()                        // 先关闭现有连接
    // 500ms 延迟后重连（短暂等待，让关闭事件完成传播）
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.connect()
    }, 500)
  }
}
