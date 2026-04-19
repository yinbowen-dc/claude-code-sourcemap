/**
 * 远程 IO 层 — SDK 模式下的双向流传输实现。
 *
 * 在整个 Claude Code 系统中的位置：
 * 本文件实现 RemoteIO 类，是 StructuredIO 的子类，专门用于通过网络传输协议
 * （WebSocket / SSE+POST / Hybrid）与远程 Claude Code Runner（CCR）进行双向通信。
 * 它是 SDK 模式（--sdk-url 参数）的核心 IO 实现，连接着：
 *   - 传输层（Transport/CCRClient）：接收来自服务端的 SDK 消息帧
 *   - StructuredIO（父类）：将接收到的数据解析为结构化的 StdinMessage/SDKMessage
 *   - 会话状态/元数据系统：通过监听器将状态变更上报给 CCR 后端
 *
 * 支持两种运行模式：
 *   - Bridge 模式（CLAUDE_CODE_ENVIRONMENT_KIND=bridge）：将 control_request 消息
 *     同步回显到 stdout，并启动 keep-alive 定时器防止 Envoy 空闲超时
 *   - BYOC Worker 模式：不需要 keep-alive，使用 CCRClient 管理 worker 生命周期
 */
import type { StdoutMessage } from 'src/entrypoints/sdk/controlTypes.js'
import { PassThrough } from 'stream'
import { URL } from 'url'
import { getSessionId } from '../bootstrap/state.js'
import { getPollIntervalConfig } from '../bridge/pollConfig.js'
import { registerCleanup } from '../utils/cleanupRegistry.js'
import { setCommandLifecycleListener } from '../utils/commandLifecycle.js'
import { isDebugMode, logForDebugging } from '../utils/debug.js'
import { logForDiagnosticsNoPII } from '../utils/diagLogs.js'
import { isEnvTruthy } from '../utils/envUtils.js'
import { errorMessage } from '../utils/errors.js'
import { gracefulShutdown } from '../utils/gracefulShutdown.js'
import { logError } from '../utils/log.js'
import { writeToStdout } from '../utils/process.js'
import { getSessionIngressAuthToken } from '../utils/sessionIngressAuth.js'
import {
  setSessionMetadataChangedListener,
  setSessionStateChangedListener,
} from '../utils/sessionState.js'
import {
  setInternalEventReader,
  setInternalEventWriter,
} from '../utils/sessionStorage.js'
import { ndjsonSafeStringify } from './ndjsonSafeStringify.js'
import { StructuredIO } from './structuredIO.js'
import { CCRClient, CCRInitError } from './transports/ccrClient.js'
import { SSETransport } from './transports/SSETransport.js'
import type { Transport } from './transports/Transport.js'
import { getTransportForUrl } from './transports/transportUtils.js'

/**
 * SDK 模式的双向流传输实现，继承自 StructuredIO。
 *
 * 通过 PassThrough 流将传输层接收到的数据桥接给父类的 NDJSON 解析器，
 * 并向上层提供 write() 接口将 StdoutMessage 发送回服务端。
 */
export class RemoteIO extends StructuredIO {
  private url: URL
  private transport: Transport
  /** 作为父类异步可迭代输入的 PassThrough 流 */
  private inputStream: PassThrough
  /** 是否运行在 bridge 拓扑下 */
  private readonly isBridge: boolean = false
  /** 是否处于调试模式（影响日志详细程度） */
  private readonly isDebug: boolean = false
  /** CCR v2 客户端（仅在 CLAUDE_CODE_USE_CCR_V2 时非 null） */
  private ccrClient: CCRClient | null = null
  /** keep-alive 定时器（仅 bridge 模式使用） */
  private keepAliveTimer: ReturnType<typeof setInterval> | null = null

  /**
   * 构造 RemoteIO 实例，完成以下初始化步骤：
   *
   * 1. 创建 PassThrough 流作为父类 StructuredIO 的输入源。
   * 2. 构建请求头（Authorization + x-environment-runner-version），
   *    以及用于断线重连时动态刷新 token 的 refreshHeaders 回调。
   * 3. 调用 getTransportForUrl 根据环境变量选择传输实现。
   * 4. 注册 onData 回调（将传输数据写入 inputStream）和 onClose 回调（结束流）。
   * 5. 若 CLAUDE_CODE_USE_CCR_V2 为真，初始化 CCRClient（必须在 transport.connect() 之前！），
   *    注册内部事件读写器、命令生命周期监听器、状态/元数据变更监听器。
   * 6. 调用 transport.connect() 建立连接。
   * 7. 若为 bridge 模式且 keep-alive 间隔 > 0，启动 keep-alive 定时器。
   * 8. 若提供了 initialPrompt，异步将其写入 inputStream（每个 chunk 附加换行符）。
   *
   * @param streamUrl        远程会话 URL（ws/wss 或通过 CCR v2 派生的 https）
   * @param initialPrompt    可选的初始提示输入流（用于首轮对话预填充）
   * @param replayUserMessages 是否在重连后重放用户消息（传递给 StructuredIO）
   */
  constructor(
    streamUrl: string,
    initialPrompt?: AsyncIterable<string>,
    replayUserMessages?: boolean,
  ) {
    // 创建 PassThrough 流作为 StructuredIO 的异步可迭代输入
    const inputStream = new PassThrough({ encoding: 'utf8' })
    super(inputStream, replayUserMessages)
    this.inputStream = inputStream
    this.url = new URL(streamUrl)

    // 构建初始请求头：Bearer token 用于会话入口认证
    const headers: Record<string, string> = {}
    const sessionToken = getSessionIngressAuthToken()
    if (sessionToken) {
      headers['Authorization'] = `Bearer ${sessionToken}`
    } else {
      logForDebugging('[remote-io] No session ingress token available', {
        level: 'error',
      })
    }

    // 若 Environment Runner 版本号可用（由 Environment Manager 设置），追加到请求头
    const erVersion = process.env.CLAUDE_CODE_ENVIRONMENT_RUNNER_VERSION
    if (erVersion) {
      headers['x-environment-runner-version'] = erVersion
    }

    // refreshHeaders 回调：断线重连时动态重新读取 token，
    // 避免使用已过期的旧 token
    const refreshHeaders = (): Record<string, string> => {
      const h: Record<string, string> = {}
      const freshToken = getSessionIngressAuthToken()
      if (freshToken) {
        h['Authorization'] = `Bearer ${freshToken}`
      }
      const freshErVersion = process.env.CLAUDE_CODE_ENVIRONMENT_RUNNER_VERSION
      if (freshErVersion) {
        h['x-environment-runner-version'] = freshErVersion
      }
      return h
    }

    // 根据 URL 协议和环境变量选择合适的传输实现
    this.transport = getTransportForUrl(
      this.url,
      headers,
      getSessionId(),
      refreshHeaders,
    )

    // 注册数据接收回调：将接收到的 NDJSON 数据写入 PassThrough 流
    this.isBridge = process.env.CLAUDE_CODE_ENVIRONMENT_KIND === 'bridge'
    this.isDebug = isDebugMode()
    this.transport.setOnData((data: string) => {
      this.inputStream.write(data)
      // bridge 调试模式下同时回显到 stdout，便于调试诊断
      if (this.isBridge && this.isDebug) {
        writeToStdout(data.endsWith('\n') ? data : data + '\n')
      }
    })

    // 注册连接关闭回调：结束 inputStream 以触发父类优雅退出
    this.transport.setOnClose(() => {
      // 结束输入流，让 StructuredIO 的 read() 循环自然退出
      this.inputStream.end()
    })

    // 初始化 CCR v2 客户端（处理心跳、epoch 管理、状态上报、事件写入）。
    // 注意：CCRClient 构造函数会同步注册 SSE received-ack 回调，
    // 因此 new CCRClient() 必须在 transport.connect() 之前执行，
    // 否则早期 SSE 帧会遇到未注册的 onEventCallback，导致投递确认静默丢失。
    if (isEnvTruthy(process.env.CLAUDE_CODE_USE_CCR_V2)) {
      // CCR v2 按定义使用 SSE+POST，getTransportForUrl 在同一 env var 下
      // 也返回 SSETransport，但两处检查分属不同文件——此处显式断言以确保
      // 未来解耦时能在此处快速失败，而非在 CCRClient 内部静默出错。
      if (!(this.transport instanceof SSETransport)) {
        throw new Error(
          'CCR v2 requires SSETransport; check getTransportForUrl',
        )
      }
      this.ccrClient = new CCRClient(this.transport, this.url)
      const init = this.ccrClient.initialize()
      // 将 worker 状态恢复 Promise 存储到父类属性，供 StructuredIO 使用
      this.restoredWorkerState = init.catch(() => null)
      init.catch((error: unknown) => {
        logForDiagnosticsNoPII('error', 'cli_worker_lifecycle_init_failed', {
          reason: error instanceof CCRInitError ? error.reason : 'unknown',
        })
        logError(
          new Error(`CCRClient initialization failed: ${errorMessage(error)}`),
        )
        // CCRClient 初始化失败属于不可恢复错误，触发优雅关闭
        void gracefulShutdown(1, 'other')
      })
      // 注册清理钩子：进程退出时关闭 CCRClient
      registerCleanup(async () => this.ccrClient?.close())

      // 注册内部事件写入器：用于将会话记录（transcript）以 CCR v2 内部事件格式持久化
      // 设置后，sessionStorage 将通过 CCR v2 而非 v1 Session Ingress 写入 transcript
      setInternalEventWriter((eventType, payload, options) =>
        this.ccrClient!.writeInternalEvent(eventType, payload, options),
      )

      // 注册内部事件读取器：用于会话恢复时重建对话状态
      // hydrateFromCCRv2InternalEvents() 会通过这两个读取器获取前台和子 agent 的历史事件
      setInternalEventReader(
        () => this.ccrClient!.readInternalEvents(),
        () => this.ccrClient!.readSubagentInternalEvents(),
      )

      // 命令生命周期 → 投递状态映射：started=processing, completed=processed
      const LIFECYCLE_TO_DELIVERY = {
        started: 'processing',
        completed: 'processed',
      } as const
      // 注册命令生命周期监听器：将工具调用的 started/completed 事件上报为投递状态
      setCommandLifecycleListener((uuid, state) => {
        this.ccrClient?.reportDelivery(uuid, LIFECYCLE_TO_DELIVERY[state])
      })
      // 注册会话状态变更监听器（如 idle/waiting/running）
      setSessionStateChangedListener((state, details) => {
        this.ccrClient?.reportState(state, details)
      })
      // 注册会话元数据变更监听器（如标题、摘要等）
      setSessionMetadataChangedListener(metadata => {
        this.ccrClient?.reportMetadata(metadata)
      })
    }

    // 所有回调注册完毕后才发起连接（setOnData 已注册，CCRClient 已注册 setOnEvent）
    void this.transport.connect()

    // Bridge 模式下启动 keep-alive 定时器，防止 Envoy 空闲超时（#21931）。
    // keep_alive 帧类型在到达客户端 UI 前会被过滤掉（Query.ts 和 structuredIO.ts 均丢弃它）。
    // 间隔来自 GrowthBook 配置（session_keepalive_interval_v2_ms，默认 120 秒）；
    // 值为 0 表示禁用。BYOC Worker 使用不同的网络路径，不需要此机制。
    const keepAliveIntervalMs =
      getPollIntervalConfig().session_keepalive_interval_v2_ms
    if (this.isBridge && keepAliveIntervalMs > 0) {
      this.keepAliveTimer = setInterval(() => {
        logForDebugging('[remote-io] keep_alive sent')
        void this.write({ type: 'keep_alive' }).catch(err => {
          logForDebugging(
            `[remote-io] keep_alive write failed: ${errorMessage(err)}`,
          )
        })
      }, keepAliveIntervalMs)
      // 允许 Node.js 进程在只剩此定时器时正常退出
      this.keepAliveTimer.unref?.()
    }

    // 注册清理钩子：进程退出时关闭传输连接和输入流
    registerCleanup(async () => this.close())

    // 若提供了初始提示，异步将其写入输入流作为首轮对话内容
    if (initialPrompt) {
      // 将初始提示逐 chunk 写入流；去除末尾换行符后统一追加，
      // 避免因 chunk 自带换行导致 structuredIO 解析到空行
      const stream = this.inputStream
      void (async () => {
        for await (const chunk of initialPrompt) {
          stream.write(String(chunk).replace(/\n$/, '') + '\n')
        }
      })()
    }
  }

  /**
   * 刷新所有待处理的内部事件（transcript 等）。
   * 若无 CCRClient 则立即返回已解析的 Promise。
   */
  override flushInternalEvents(): Promise<void> {
    return this.ccrClient?.flushInternalEvents() ?? Promise.resolve()
  }

  /**
   * 返回当前待处理的内部事件数量（用于优雅关闭前的等待判断）。
   */
  override get internalEventsPending(): number {
    return this.ccrClient?.internalEventsPending ?? 0
  }

  /**
   * 将输出消息发送到传输层。
   *
   * 流程：
   * 1. 若有 CCRClient（CCR v2 模式），通过 ccrClient.writeEvent 发送（支持 text_delta 合并等优化）。
   * 2. 否则直接通过 transport.write 发送（WebSocket / Hybrid 模式）。
   * 3. 在 bridge 模式下：control_request 类型的消息始终同步回显到 stdout，
   *    使 bridge 父进程能感知权限请求；其他消息仅在 debug 模式下回显。
   */
  async write(message: StdoutMessage): Promise<void> {
    if (this.ccrClient) {
      // CCR v2 路径：通过 CCRClient 写入（含 stream_event 缓冲和 text_delta 合并）
      await this.ccrClient.writeEvent(message)
    } else {
      // 非 CCR v2 路径：直接写入传输层
      await this.transport.write(message)
    }
    if (this.isBridge) {
      // bridge 模式：control_request 消息回显给父进程以处理权限弹窗
      if (message.type === 'control_request' || this.isDebug) {
        writeToStdout(ndjsonSafeStringify(message) + '\n')
      }
    }
  }

  /**
   * 优雅关闭：停止 keep-alive 定时器，关闭传输连接，结束输入流。
   */
  close(): void {
    // 停止 keep-alive 定时器（若存在）
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer)
      this.keepAliveTimer = null
    }
    // 关闭传输层连接（WebSocket/SSE）
    this.transport.close()
    // 结束 PassThrough 流，触发父类 read() 循环退出
    this.inputStream.end()
  }
}
