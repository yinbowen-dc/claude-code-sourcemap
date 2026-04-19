/**
 * SSE 传输层 — Server-Sent Events 读取 + HTTP POST 写入。
 *
 * 在整个 Claude Code 系统中的位置：
 * SSETransport 是 CCR v2（CLAUDE_CODE_USE_CCR_V2=true）的专用传输实现。
 * 与 WebSocketTransport 不同，它将读写通道分离：
 *   - 读取（服务端 → 客户端）：通过 SSE 流订阅 CCR v2 event stream 端点，
 *     每个 `event: client_event` 帧携带 StreamClientEvent proto JSON，
 *     transport 提取 payload 后以 NDJSON 格式传递给 StructuredIO 消费方。
 *   - 写入（客户端 → 服务端）：通过 HTTP POST 发送单条消息，
 *     失败时执行指数退避重试（最多 POST_MAX_RETRIES 次）。
 *
 * 关键特性：
 *   - 自动重连：SSE 连接断开后以指数退避（1s→30s，±25% 抖动）重连，
 *     总时间预算 10 分钟（RECONNECT_GIVE_UP_MS）后放弃并触发 onClose。
 *   - Last-Event-ID 恢复：重连时将 lastSequenceNum 作为 from_sequence_num
 *     查询参数和 Last-Event-ID 请求头，服务端从断点续传避免重放全量历史。
 *   - 活性检测：服务端每 15s 发送 keepalive，若 45s 无任何帧则视为连接死亡并重连。
 *   - 序列号去重：seenSequenceNums 防止重连期间重复帧被多次投递。
 *   - 永久错误（401/403/404）：立即转为 closed 状态，不重试。
 *
 * 使用方通过 getTransportForUrl 工厂函数选择此传输层（CLAUDE_CODE_USE_CCR_V2）。
 */
import axios, { type AxiosError } from 'axios'
import type { StdoutMessage } from 'src/entrypoints/sdk/controlTypes.js'
import { logForDebugging } from '../../utils/debug.js'
import { logForDiagnosticsNoPII } from '../../utils/diagLogs.js'
import { errorMessage } from '../../utils/errors.js'
import { getSessionIngressAuthHeaders } from '../../utils/sessionIngressAuth.js'
import { sleep } from '../../utils/sleep.js'
import { jsonParse, jsonStringify } from '../../utils/slowOperations.js'
import { getClaudeCodeUserAgent } from '../../utils/userAgent.js'
import type { Transport } from './Transport.js'

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// 重连指数退避的基础延迟（毫秒）
const RECONNECT_BASE_DELAY_MS = 1000
// 重连指数退避的最大延迟上限（毫秒）
const RECONNECT_MAX_DELAY_MS = 30_000
/** 重连时间预算上限（10 分钟）：超过后放弃重连并触发 onClose。 */
const RECONNECT_GIVE_UP_MS = 600_000
/** 活性检测超时（毫秒）：服务端每 15s 发送 keepalive，若 45s 无任何帧则视为死连接。 */
const LIVENESS_TIMEOUT_MS = 45_000

/**
 * 永久性 HTTP 错误码集合。
 * 收到这些状态码时传输层立即转为 closed，不执行重连。
 * 401/403 表示认证失败，404 表示会话不存在——均属不可恢复错误。
 */
const PERMANENT_HTTP_CODES = new Set([401, 403, 404])

// HTTP POST 重试配置（与 HybridTransport 保持一致）
const POST_MAX_RETRIES = 10   // 单条消息最多重试次数
const POST_BASE_DELAY_MS = 500 // POST 重试基础退避延迟（毫秒）
const POST_MAX_DELAY_MS = 8000 // POST 重试最大退避延迟（毫秒）

/** 预分配 TextDecoder 解码选项，避免在 readStream 中每帧都重新分配对象。 */
const STREAM_DECODE_OPTS: TextDecodeOptions = { stream: true }

/**
 * 预分配的 axios validateStatus 回调，关闭 axios 默认的 4xx/5xx 抛出行为，
 * 统一在 write() 方法中处理各状态码，避免每次请求都创建新的闭包对象。
 */
function alwaysValidStatus(): boolean {
  return true
}

// ---------------------------------------------------------------------------
// SSE 帧解析器
// ---------------------------------------------------------------------------

// SSE 帧的内部结构（符合 W3C SSE 规范）
type SSEFrame = {
  event?: string  // `event:` 字段，标识事件类型（如 client_event）
  id?: string     // `id:` 字段，用作序列号和 Last-Event-ID
  data?: string   // `data:` 字段，多行会被 \n 拼接
}

/**
 * 从文本缓冲区中增量解析 SSE 帧，返回已完整解析的帧列表和剩余未完成的缓冲区。
 *
 * SSE 规范要求帧之间以双换行符（\n\n）分隔；帧内部各字段以单换行符分隔。
 * 若最后一个 \n\n 之后还有数据，表示当前帧尚未完整接收，保留在 remaining 中等待下次数据到来。
 *
 * @internal 导出仅供测试使用
 */
export function parseSSEFrames(buffer: string): {
  frames: SSEFrame[]
  remaining: string
} {
  const frames: SSEFrame[] = []
  let pos = 0

  // SSE 帧以双换行符（\n\n）作为分隔符
  let idx: number
  while ((idx = buffer.indexOf('\n\n', pos)) !== -1) {
    const rawFrame = buffer.slice(pos, idx)
    pos = idx + 2

    // 跳过空白帧（纯 \n 序列等）
    if (!rawFrame.trim()) continue

    const frame: SSEFrame = {}
    let isComment = false

    for (const line of rawFrame.split('\n')) {
      if (line.startsWith(':')) {
        // SSE 注释行（如 `:keepalive`）——不携带数据，但能重置活性计时器
        isComment = true
        continue
      }

      const colonIdx = line.indexOf(':')
      if (colonIdx === -1) continue

      const field = line.slice(0, colonIdx)
      // 按 SSE 规范：冒号后若有一个前导空格则去除（仅去除一个）
      const value =
        line[colonIdx + 1] === ' '
          ? line.slice(colonIdx + 2)
          : line.slice(colonIdx + 1)

      switch (field) {
        case 'event':
          frame.event = value
          break
        case 'id':
          frame.id = value
          break
        case 'data':
          // 按 SSE 规范：多行 data: 字段以 \n 拼接
          frame.data = frame.data ? frame.data + '\n' + value : value
          break
        // 忽略其他字段（retry: 等）
      }
    }

    // 只投递有数据的帧，或纯注释帧（注释帧用于重置活性计时器）
    if (frame.data || isComment) {
      frames.push(frame)
    }
  }

  return { frames, remaining: buffer.slice(pos) }
}

// ---------------------------------------------------------------------------
// 类型定义
// ---------------------------------------------------------------------------

/**
 * SSETransport 的连接状态机：
 *   idle       — 初始状态，尚未发起连接
 *   connected  — SSE 流已建立并正在读取
 *   reconnecting — 连接断开后正在等待重连定时器
 *   closing    — close() 已被调用，正在清理资源
 *   closed     — 已完全关闭（永久错误或重连预算耗尽）
 */
type SSETransportState =
  | 'idle'
  | 'connected'
  | 'reconnecting'
  | 'closing'
  | 'closed'

/**
 * `event: client_event` SSE 帧的 data 字段载荷，对应 session_stream.proto 中的
 * StreamClientEvent 消息。Worker 订阅者只会收到 client_event 类型的帧
 * （delivery_update、session_update、ephemeral_event、catch_up_truncated
 *  仅投递给客户端通道，见 notifier.go 和 event_stream.go SubscriberClient guard）。
 */
export type StreamClientEvent = {
  event_id: string                    // 全局唯一事件 ID
  sequence_num: number                // 单调递增序列号，用于断点续传和去重
  event_type: string                  // 事件类型字符串
  source: string                      // 事件来源标识
  payload: Record<string, unknown>    // 内层载荷（NDJSON 投递给 StructuredIO 消费方）
  created_at: string                  // 事件创建时间（ISO8601）
}

// ---------------------------------------------------------------------------
// SSETransport
// ---------------------------------------------------------------------------

/**
 * SSE 读取 + HTTP POST 写入的双通道传输实现。
 *
 * 读取通道：通过 SSE 流订阅 CCR v2 event stream 端点，每个 `event: client_event`
 * 帧的 `data:` 字段包含 StreamClientEvent proto JSON；transport 提取 payload 后
 * 以 NDJSON 格式（末尾加 \n）传递给 onData 回调，供 StructuredIO 解析消费。
 *
 * 写入通道：通过 HTTP POST 将单条 StdoutMessage 发送到 postUrl，失败时以指数
 * 退避重试最多 POST_MAX_RETRIES 次；4xx（非 429）永久错误直接丢弃不重试。
 *
 * 状态机转换：
 *   idle → reconnecting（connect() 调用）
 *   reconnecting → connected（成功建立 SSE 流）
 *   connected → reconnecting（流中断，未超预算）
 *   connected/reconnecting → closed（永久 HTTP 错误 或 重连预算耗尽）
 *   任意 → closing → closed（close() 调用）
 */
export class SSETransport implements Transport {
  private state: SSETransportState = 'idle'
  private onData?: (data: string) => void                             // NDJSON 数据接收回调
  private onCloseCallback?: (closeCode?: number) => void             // 连接关闭回调
  private onEventCallback?: (event: StreamClientEvent) => void       // 原始 StreamClientEvent 回调（供 CCRClient 使用）
  private headers: Record<string, string>                            // 当前请求头（断线重连时会刷新）
  private sessionId?: string                                         // 调试日志用会话 ID
  private refreshHeaders?: () => Record<string, string>              // 断线重连时刷新 token 的回调
  private readonly getAuthHeaders: () => Record<string, string>      // 认证头获取函数（支持 Cookie/Bearer 双模式）

  // SSE 连接状态
  private abortController: AbortController | null = null             // 用于中止进行中的 fetch 请求
  private lastSequenceNum = 0                                        // 已接收序列号高水位，用于断点续传
  private seenSequenceNums = new Set<number>()                       // 已见序列号集合，防止重复投递

  // 重连状态
  private reconnectAttempts = 0                                      // 当前重连周期内的尝试次数（成功后重置）
  private reconnectStartTime: number | null = null                   // 重连周期开始时间（用于判断是否超预算）
  private reconnectTimer: NodeJS.Timeout | null = null               // 退避定时器句柄

  // 活性检测
  private livenessTimer: NodeJS.Timeout | null = null                // 45s 无帧则触发重连

  // POST URL（由 SSE URL 转换而来，去掉 /stream 后缀）
  private postUrl: string

  // Runtime epoch for CCR v2 event format

  constructor(
    private readonly url: URL,
    headers: Record<string, string> = {},
    sessionId?: string,
    refreshHeaders?: () => Record<string, string>,
    initialSequenceNum?: number,
    /**
     * 每实例独立的认证头获取函数。
     * 单会话调用方可省略，将读取进程全局环境变量 CLAUDE_CODE_SESSION_ACCESS_TOKEN。
     * 多会话并发调用方必须提供此参数——env var 路径是进程全局的，不同会话间会相互覆盖。
     */
    getAuthHeaders?: () => Record<string, string>,
  ) {
    this.headers = headers
    this.sessionId = sessionId
    this.refreshHeaders = refreshHeaders
    this.getAuthHeaders = getAuthHeaders ?? getSessionIngressAuthHeaders
    this.postUrl = convertSSEUrlToPostUrl(url)
    // 用调用方提供的高水位初始化 lastSequenceNum，使首次 connect()
    // 发送 from_sequence_num / Last-Event-ID，实现断点续传。
    // 若不初始化，新 SSETransport 实例每次都从序列号 0 开始，导致服务端回放全量历史。
    if (initialSequenceNum !== undefined && initialSequenceNum > 0) {
      this.lastSequenceNum = initialSequenceNum
    }
    logForDebugging(`SSETransport: SSE URL = ${url.href}`)
    logForDebugging(`SSETransport: POST URL = ${this.postUrl}`)
    logForDiagnosticsNoPII('info', 'cli_sse_transport_initialized')
  }

  /**
   * 返回当前已接收序列号的高水位。
   * 调用方（如 replBridge 的 onWorkReceived）在 close() 前读取此值，
   * 并将其作为 initialSequenceNum 传入下一个 SSETransport 实例，
   * 使服务端从正确位置续传，而非重放全量历史。
   */
  getLastSequenceNum(): number {
    return this.lastSequenceNum
  }

  /**
   * 发起 SSE 连接（或重连）。
   *
   * 流程：
   * 1. 状态检查：只允许从 idle 或 reconnecting 状态调用；其他状态直接返回。
   * 2. 构建 SSE URL：若 lastSequenceNum > 0，追加 from_sequence_num 查询参数。
   * 3. 构建请求头：获取最新认证头，若使用 Cookie 认证则删除 Authorization 头
   *    （避免双重认证头混淆服务端）。若有序列号，设置 Last-Event-ID 请求头。
   * 4. 发起 fetch：成功（2xx）则转为 connected 状态，调用 readStream() 读取流。
   * 5. 非 2xx：若为永久错误（401/403/404）则直接 closed，否则调用 handleConnectionError() 重连。
   * 6. 网络异常（fetch 抛出）：若为主动中止则忽略，否则调用 handleConnectionError()。
   */
  async connect(): Promise<void> {
    if (this.state !== 'idle' && this.state !== 'reconnecting') {
      logForDebugging(
        `SSETransport: Cannot connect, current state is ${this.state}`,
        { level: 'error' },
      )
      logForDiagnosticsNoPII('error', 'cli_sse_connect_failed')
      return
    }

    this.state = 'reconnecting'
    const connectStartTime = Date.now()

    // 构建 SSE URL，若有已接收序列号则追加 from_sequence_num 参数用于断点续传
    const sseUrl = new URL(this.url.href)
    if (this.lastSequenceNum > 0) {
      sseUrl.searchParams.set('from_sequence_num', String(this.lastSequenceNum))
    }

    // 构建请求头：合并已有 headers + 最新认证头。
    // 若认证方式为 Cookie（而非 Bearer token），则删除 Authorization 头，
    // 避免两种认证头同时存在时服务端认证拦截器产生歧义。
    const authHeaders = this.getAuthHeaders()
    const headers: Record<string, string> = {
      ...this.headers,
      ...authHeaders,
      Accept: 'text/event-stream',
      'anthropic-version': '2023-06-01',
      'User-Agent': getClaudeCodeUserAgent(),
    }
    if (authHeaders['Cookie']) {
      delete headers['Authorization']
    }
    // 设置 Last-Event-ID 请求头，服务端据此决定从哪个序列号开始推送
    if (this.lastSequenceNum > 0) {
      headers['Last-Event-ID'] = String(this.lastSequenceNum)
    }

    logForDebugging(`SSETransport: Opening ${sseUrl.href}`)
    logForDiagnosticsNoPII('info', 'cli_sse_connect_opening')

    this.abortController = new AbortController()

    try {
      // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
      const response = await fetch(sseUrl.href, {
        headers,
        signal: this.abortController.signal,
      })

      if (!response.ok) {
        const isPermanent = PERMANENT_HTTP_CODES.has(response.status)
        logForDebugging(
          `SSETransport: HTTP ${response.status}${isPermanent ? ' (permanent)' : ''}`,
          { level: 'error' },
        )
        logForDiagnosticsNoPII('error', 'cli_sse_connect_http_error', {
          status: response.status,
        })

        if (isPermanent) {
          // 永久错误（401/403/404）：直接关闭，不重连
          this.state = 'closed'
          this.onCloseCallback?.(response.status)
          return
        }

        this.handleConnectionError()
        return
      }

      if (!response.body) {
        logForDebugging('SSETransport: No response body')
        this.handleConnectionError()
        return
      }

      // 成功建立连接：记录耗时，重置重连计数器，启动活性计时器
      const connectDuration = Date.now() - connectStartTime
      logForDebugging('SSETransport: Connected')
      logForDiagnosticsNoPII('info', 'cli_sse_connect_connected', {
        duration_ms: connectDuration,
      })

      this.state = 'connected'
      this.reconnectAttempts = 0
      this.reconnectStartTime = null
      this.resetLivenessTimer()

      // 进入 SSE 流读取循环（阻塞直到流结束或出错）
      await this.readStream(response.body)
    } catch (error) {
      if (this.abortController?.signal.aborted) {
        // 主动调用 close() 导致 fetch 中止，属于正常关闭流程，忽略
        return
      }

      logForDebugging(
        `SSETransport: Connection error: ${errorMessage(error)}`,
        { level: 'error' },
      )
      logForDiagnosticsNoPII('error', 'cli_sse_connect_error')
      this.handleConnectionError()
    }
  }

  /**
   * 读取并处理 SSE 流体（ReadableStream<Uint8Array>）。
   *
   * 流程：
   * 1. 使用 TextDecoder（stream:true 模式）将字节流增量解码为字符串。
   * 2. 将解码内容追加到缓冲区，调用 parseSSEFrames() 提取完整帧。
   * 3. 每帧到达时重置活性计时器（包括 keepalive 注释帧）。
   * 4. 处理帧 id 字段：更新 lastSequenceNum 高水位；维护 seenSequenceNums
   *    去重集合（超 1000 条时清理低于高水位 200 的旧序列号）。
   * 5. 有 event 且有 data 的帧交由 handleSSEFrame() 处理；
   *    有 data 无 event 的帧记录诊断日志并丢弃。
   * 6. 流正常结束（done=true）或读取出错后，若非主动关闭则调用 handleConnectionError() 重连。
   */
  // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
  private async readStream(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, STREAM_DECODE_OPTS)
        const { frames, remaining } = parseSSEFrames(buffer)
        buffer = remaining

        for (const frame of frames) {
          // 任何帧（包括 keepalive 注释帧）均证明连接存活，重置活性计时器
          this.resetLivenessTimer()

          if (frame.id) {
            const seqNum = parseInt(frame.id, 10)
            if (!isNaN(seqNum)) {
              if (this.seenSequenceNums.has(seqNum)) {
                logForDebugging(
                  `SSETransport: DUPLICATE frame seq=${seqNum} (lastSequenceNum=${this.lastSequenceNum}, seenCount=${this.seenSequenceNums.size})`,
                  { level: 'warn' },
                )
                logForDiagnosticsNoPII('warn', 'cli_sse_duplicate_sequence')
              } else {
                this.seenSequenceNums.add(seqNum)
                // 防止 seenSequenceNums 无限增长：超过 1000 条时，
                // 清理远低于高水位的旧序列号（保留高水位附近 200 条用于去重）
                if (this.seenSequenceNums.size > 1000) {
                  const threshold = this.lastSequenceNum - 200
                  for (const s of this.seenSequenceNums) {
                    if (s < threshold) {
                      this.seenSequenceNums.delete(s)
                    }
                  }
                }
              }
              // 更新高水位（用于下次重连的 from_sequence_num）
              if (seqNum > this.lastSequenceNum) {
                this.lastSequenceNum = seqNum
              }
            }
          }

          if (frame.event && frame.data) {
            this.handleSSEFrame(frame.event, frame.data)
          } else if (frame.data) {
            // 有 data 但无 event 字段：可能是旧版服务端格式或 bug，记录诊断并丢弃
            logForDebugging(
              'SSETransport: Frame has data: but no event: field — dropped',
              { level: 'warn' },
            )
            logForDiagnosticsNoPII('warn', 'cli_sse_frame_missing_event_field')
          }
        }
      }
    } catch (error) {
      if (this.abortController?.signal.aborted) return
      logForDebugging(
        `SSETransport: Stream read error: ${errorMessage(error)}`,
        { level: 'error' },
      )
      logForDiagnosticsNoPII('error', 'cli_sse_stream_read_error')
    } finally {
      reader.releaseLock()
    }

    // 流正常结束（服务端主动关闭）——若非主动关闭则触发重连
    if (this.state !== 'closing' && this.state !== 'closed') {
      logForDebugging('SSETransport: Stream ended, reconnecting')
      this.handleConnectionError()
    }
  }

  /**
   * 处理单个 SSE 帧。event 字段标识帧变体；data 字段包含内层 proto JSON。
   *
   * Worker 订阅者只应收到 client_event 类型帧（见 notifier.go），其他类型
   * 表示服务端新增了 CC 尚不理解的事件类型，记录诊断日志以便在监控中发现。
   * 处理流程：
   * 1. 若非 client_event，记录警告并返回。
   * 2. 将 data 字段 JSON 解析为 StreamClientEvent。
   * 3. 若 payload 存在且有 type 字段，将其序列化为 NDJSON 后调用 onData 回调。
   * 4. 无论是否有 payload，调用 onEventCallback 传递完整 StreamClientEvent
   *    （供 CCRClient 处理 received-ack 等元数据）。
   */
  private handleSSEFrame(eventType: string, data: string): void {
    if (eventType !== 'client_event') {
      logForDebugging(
        `SSETransport: Unexpected SSE event type '${eventType}' on worker stream`,
        { level: 'warn' },
      )
      logForDiagnosticsNoPII('warn', 'cli_sse_unexpected_event_type', {
        event_type: eventType,
      })
      return
    }

    let ev: StreamClientEvent
    try {
      ev = jsonParse(data) as StreamClientEvent
    } catch (error) {
      logForDebugging(
        `SSETransport: Failed to parse client_event data: ${errorMessage(error)}`,
        { level: 'error' },
      )
      return
    }

    const payload = ev.payload
    if (payload && typeof payload === 'object' && 'type' in payload) {
      const sessionLabel = this.sessionId ? ` session=${this.sessionId}` : ''
      logForDebugging(
        `SSETransport: Event seq=${ev.sequence_num} event_id=${ev.event_id} event_type=${ev.event_type} payload_type=${String(payload.type)}${sessionLabel}`,
      )
      logForDiagnosticsNoPII('info', 'cli_sse_message_received')
      // 将内层 payload 序列化为 NDJSON，与 WebSocketTransport 消费方期望格式保持一致
      this.onData?.(jsonStringify(payload) + '\n')
    } else {
      logForDebugging(
        `SSETransport: Ignoring client_event with no type in payload: event_id=${ev.event_id}`,
      )
    }

    // 无论 payload 是否有效，都通知 onEventCallback（CCRClient 需要全量原始事件）
    this.onEventCallback?.(ev)
  }

  /**
   * 处理连接错误，执行指数退避重连或在预算耗尽时关闭。
   *
   * 流程：
   * 1. 清除活性计时器，若已是 closing/closed 则直接返回。
   * 2. 中止当前进行中的 fetch。
   * 3. 计算从重连周期开始以来的已用时间（elapsed）。
   * 4. 若 elapsed < RECONNECT_GIVE_UP_MS：刷新 headers，递增重连计数，
   *    按指数退避（±25% 抖动）设定下次重连定时器。
   * 5. 若超出预算：转为 closed 状态并触发 onCloseCallback。
   */
  private handleConnectionError(): void {
    this.clearLivenessTimer()

    if (this.state === 'closing' || this.state === 'closed') return

    // 中止当前进行中的 fetch（如有）
    this.abortController?.abort()
    this.abortController = null

    const now = Date.now()
    if (!this.reconnectStartTime) {
      // 记录本次重连周期的起始时间（首次断连时初始化）
      this.reconnectStartTime = now
    }

    const elapsed = now - this.reconnectStartTime
    if (elapsed < RECONNECT_GIVE_UP_MS) {
      // 清除旧定时器（若有）
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer)
        this.reconnectTimer = null
      }

      // 重连前刷新认证 headers，避免使用已过期的旧 token
      if (this.refreshHeaders) {
        const freshHeaders = this.refreshHeaders()
        Object.assign(this.headers, freshHeaders)
        logForDebugging('SSETransport: Refreshed headers for reconnect')
      }

      this.state = 'reconnecting'
      this.reconnectAttempts++

      // 指数退避：baseDelay * 2^(attempts-1)，上限 RECONNECT_MAX_DELAY_MS
      const baseDelay = Math.min(
        RECONNECT_BASE_DELAY_MS * Math.pow(2, this.reconnectAttempts - 1),
        RECONNECT_MAX_DELAY_MS,
      )
      // ±25% 抖动，防止多实例同时重连时的惊群效应
      const delay = Math.max(
        0,
        baseDelay + baseDelay * 0.25 * (2 * Math.random() - 1),
      )

      logForDebugging(
        `SSETransport: Reconnecting in ${Math.round(delay)}ms (attempt ${this.reconnectAttempts}, ${Math.round(elapsed / 1000)}s elapsed)`,
      )
      logForDiagnosticsNoPII('error', 'cli_sse_reconnect_attempt', {
        reconnectAttempts: this.reconnectAttempts,
      })

      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null
        void this.connect()
      }, delay)
    } else {
      // 重连时间预算耗尽：放弃重连，触发 onCloseCallback 通知上层
      logForDebugging(
        `SSETransport: Reconnection time budget exhausted after ${Math.round(elapsed / 1000)}s`,
        { level: 'error' },
      )
      logForDiagnosticsNoPII('error', 'cli_sse_reconnect_exhausted', {
        reconnectAttempts: this.reconnectAttempts,
        elapsedMs: elapsed,
      })
      this.state = 'closed'
      this.onCloseCallback?.()
    }
  }

  /**
   * 活性超时回调（绑定方法，提升为类属性以避免在每帧 resetLivenessTimer 中创建新闭包）。
   * 超时触发时中止当前连接并调用 handleConnectionError() 发起重连。
   */
  private readonly onLivenessTimeout = (): void => {
    this.livenessTimer = null
    logForDebugging('SSETransport: Liveness timeout, reconnecting', {
      level: 'error',
    })
    logForDiagnosticsNoPII('error', 'cli_sse_liveness_timeout')
    this.abortController?.abort()
    this.handleConnectionError()
  }

  /**
   * 重置活性检测计时器。
   * 每收到任意 SSE 帧（含 keepalive 注释帧）时调用，将超时窗口向后延迟 LIVENESS_TIMEOUT_MS。
   * 若 LIVENESS_TIMEOUT_MS 内没有任何帧到达，触发 onLivenessTimeout 重连。
   */
  private resetLivenessTimer(): void {
    this.clearLivenessTimer()
    this.livenessTimer = setTimeout(this.onLivenessTimeout, LIVENESS_TIMEOUT_MS)
  }

  /** 清除活性检测计时器（连接关闭或重连时调用，防止计时器在关闭后触发）。 */
  private clearLivenessTimer(): void {
    if (this.livenessTimer) {
      clearTimeout(this.livenessTimer)
      this.livenessTimer = null
    }
  }

  // -----------------------------------------------------------------------
  // 写入通道（HTTP POST）— 与 HybridTransport 相同模式
  // -----------------------------------------------------------------------

  /**
   * 将单条 StdoutMessage 通过 HTTP POST 发送到服务端。
   *
   * 流程：
   * 1. 获取最新认证头；若为空则静默丢弃（无 token 时无法认证）。
   * 2. 以指数退避（POST_BASE_DELAY_MS → POST_MAX_DELAY_MS）重试最多 POST_MAX_RETRIES 次：
   *    - 2xx：成功返回。
   *    - 4xx（非 429）：永久错误，静默丢弃，不重试。
   *    - 429 / 5xx：可重试，记录诊断后等待退避再重试。
   *    - 网络异常（axios 抛出）：同上可重试路径。
   * 3. 超过最大重试次数后记录诊断日志并返回（最终丢弃）。
   */
  async write(message: StdoutMessage): Promise<void> {
    const authHeaders = this.getAuthHeaders()
    if (Object.keys(authHeaders).length === 0) {
      logForDebugging('SSETransport: No session token available for POST')
      logForDiagnosticsNoPII('warn', 'cli_sse_post_no_token')
      return
    }

    const headers: Record<string, string> = {
      ...authHeaders,
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
      'User-Agent': getClaudeCodeUserAgent(),
    }

    logForDebugging(
      `SSETransport: POST body keys=${Object.keys(message as Record<string, unknown>).join(',')}`,
    )

    for (let attempt = 1; attempt <= POST_MAX_RETRIES; attempt++) {
      try {
        const response = await axios.post(this.postUrl, message, {
          headers,
          validateStatus: alwaysValidStatus,
        })

        if (response.status === 200 || response.status === 201) {
          logForDebugging(`SSETransport: POST success type=${message.type}`)
          return
        }

        logForDebugging(
          `SSETransport: POST ${response.status} body=${jsonStringify(response.data).slice(0, 200)}`,
        )
        // 4xx（非 429）是永久性客户端错误，丢弃不重试
        if (
          response.status >= 400 &&
          response.status < 500 &&
          response.status !== 429
        ) {
          logForDebugging(
            `SSETransport: POST returned ${response.status} (client error), not retrying`,
          )
          logForDiagnosticsNoPII('warn', 'cli_sse_post_client_error', {
            status: response.status,
          })
          return
        }

        // 429 或 5xx：服务端瞬时错误，记录后退避重试
        logForDebugging(
          `SSETransport: POST returned ${response.status}, attempt ${attempt}/${POST_MAX_RETRIES}`,
        )
        logForDiagnosticsNoPII('warn', 'cli_sse_post_retryable_error', {
          status: response.status,
          attempt,
        })
      } catch (error) {
        const axiosError = error as AxiosError
        logForDebugging(
          `SSETransport: POST error: ${axiosError.message}, attempt ${attempt}/${POST_MAX_RETRIES}`,
        )
        logForDiagnosticsNoPII('warn', 'cli_sse_post_network_error', {
          attempt,
        })
      }

      if (attempt === POST_MAX_RETRIES) {
        logForDebugging(
          `SSETransport: POST failed after ${POST_MAX_RETRIES} attempts, continuing`,
        )
        logForDiagnosticsNoPII('warn', 'cli_sse_post_retries_exhausted')
        return
      }

      // 指数退避延迟后重试
      const delayMs = Math.min(
        POST_BASE_DELAY_MS * Math.pow(2, attempt - 1),
        POST_MAX_DELAY_MS,
      )
      await sleep(delayMs)
    }
  }

  // -----------------------------------------------------------------------
  // Transport 接口实现
  // -----------------------------------------------------------------------

  /** 返回当前是否处于已连接状态。 */
  isConnectedStatus(): boolean {
    return this.state === 'connected'
  }

  /** 返回当前是否处于已关闭状态（永久错误或重连预算耗尽）。 */
  isClosedStatus(): boolean {
    return this.state === 'closed'
  }

  /** 注册 NDJSON 数据接收回调，供 RemoteIO/StructuredIO 使用。 */
  setOnData(callback: (data: string) => void): void {
    this.onData = callback
  }

  /** 注册连接关闭回调（可选携带 HTTP 状态码）。 */
  setOnClose(callback: (closeCode?: number) => void): void {
    this.onCloseCallback = callback
  }

  /** 注册原始 StreamClientEvent 回调，供 CCRClient 处理 received-ack 等元数据。 */
  setOnEvent(callback: (event: StreamClientEvent) => void): void {
    this.onEventCallback = callback
  }

  /**
   * 优雅关闭：清理重连定时器和活性计时器，转为 closing 状态，中止进行中的 fetch。
   * close() 是同步调用，不等待流读取完成（abortController.abort() 会触发异常路径自然退出）。
   */
  close(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.clearLivenessTimer()

    this.state = 'closing'
    this.abortController?.abort()
    this.abortController = null
  }
}

// ---------------------------------------------------------------------------
// URL 转换
// ---------------------------------------------------------------------------

/**
 * 将 SSE 流 URL 转换为 HTTP POST 端点 URL。
 * SSE 流端点和 POST 端点共享相同 base URL，差异仅在于 /stream 后缀：
 *
 *   输入：https://api.example.com/v2/session_ingress/session/<id>/events/stream
 *   输出：https://api.example.com/v2/session_ingress/session/<id>/events
 *
 * 即：去掉路径末尾的 /stream 后缀。
 */
function convertSSEUrlToPostUrl(sseUrl: URL): string {
  let pathname = sseUrl.pathname
  // 去掉 /stream 后缀，得到 POST 事件端点路径
  if (pathname.endsWith('/stream')) {
    pathname = pathname.slice(0, -'/stream'.length)
  }
  return `${sseUrl.protocol}//${sseUrl.host}${pathname}`
}
