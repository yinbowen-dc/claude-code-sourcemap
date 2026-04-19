/**
 * Hybrid 传输层 — WebSocket 读取 + HTTP POST 写入，防止 Firestore 并发写冲突。
 *
 * 在整个 Claude Code 系统中的位置：
 * HybridTransport 是 WebSocketTransport 的子类，专为 Bridge 模式（BYOC）设计。
 * 该模式下大量工具调用会并发触发 `void transport.write()`（即 fire-and-forget 写入），
 * 若全部通过 WebSocket 写入，Firestore 的同文档并发写会导致冲突、重试风暴和 On-Call 报警。
 * HybridTransport 的设计思路：
 *   - 读取（接收服务端消息）：沿用 WebSocketTransport 的 WebSocket 订阅机制。
 *   - 写入（发送客户端消息）：改用串行化的 HTTP POST，通过 SerialBatchEventUploader
 *     保证同一时刻最多只有 1 个 POST 在飞行中，从根本上消除并发写冲突。
 *
 * 写入流程图（见类注释）：
 *   stream_event → 100ms 延迟缓冲 ─┐
 *   其他事件      ────────────────→ uploader.enqueue() → postOnce() → HTTP POST
 *
 * stream_event（如 text_delta）会先积累 100ms 再批量入队，减少 POST 次数。
 * 非 stream_event 在入队前先 flush 缓冲区以保证事件顺序。
 *
 * 环境变量激活条件：CLAUDE_CODE_POST_FOR_SESSION_INGRESS_V2=true
 * （由 getTransportForUrl 工厂函数负责选择）
 */
import axios, { type AxiosError } from 'axios'
import type { StdoutMessage } from 'src/entrypoints/sdk/controlTypes.js'
import { logForDebugging } from '../../utils/debug.js'
import { logForDiagnosticsNoPII } from '../../utils/diagLogs.js'
import { getSessionIngressAuthToken } from '../../utils/sessionIngressAuth.js'
import { SerialBatchEventUploader } from './SerialBatchEventUploader.js'
import {
  WebSocketTransport,
  type WebSocketTransportOptions,
} from './WebSocketTransport.js'

/** stream_event 延迟缓冲窗口（毫秒）：积累 content delta 以减少 POST 次数 */
const BATCH_FLUSH_INTERVAL_MS = 100
// 单次 POST 的超时时间。限制单个卡住的 POST 对串行队列的阻塞时长。
// 若无此限制，一个 hung 连接会阻塞所有后续写入。
const POST_TIMEOUT_MS = 15_000
// close() 时给排队写入的宽限期（毫秒）。覆盖正常 POST（~100ms）加一定余量；
// 这是尽力而为（best-effort），不保证在网络退化时的投递。
// 被 void 调用（没有 await），因此这是最后手段——replBridge 的拆解
// 现在在 archive 完成后才 close，archive 延迟是主要 drain 窗口。
// 注意：gracefulShutdown 的 cleanup 预算是 2s（而非外层 5s failsafe）；
// 3s 超过了它，但进程会为 hooks+analytics 额外存活约 2s。
const CLOSE_GRACE_MS = 3000

/**
 * Hybrid 传输实现：继承 WebSocketTransport 用于读取，重写 write() 走 HTTP POST 写入。
 *
 * 写入流程：
 *
 *   write(stream_event) ─┐
 *                        │ (100ms 延迟缓冲)
 *                        │
 *                        ▼
 *   write(other) ────► uploader.enqueue()  (SerialBatchEventUploader)
 *                        ▲    │
 *   writeBatch() ────────┘    │ 串行、批量、无限重试，
 *                             │ maxQueueSize 时产生背压
 *                             ▼
 *                        postOnce()  (单次 HTTP POST，失败时抛出以触发重试)
 *
 * stream_event 消息在 streamEventBuffer 中积累最多 100ms 后再入队
 * （减少高频 content delta 的 POST 次数）。
 * 非 stream_event 写入前先 flush 缓冲的 stream_event 以保证事件顺序。
 *
 * 串行化 + 重试 + 背压均委托给 SerialBatchEventUploader（与 CCR 使用同一原语）。
 * 同一时刻最多 1 个 POST 在飞行中；POST 飞行期间到来的事件累积到下一批。
 * 失败时上传器重新入队并以指数退避 + 抖动重试。
 * 队列达到 maxQueueSize 时 enqueue() 阻塞——对等待的调用方产生背压。
 *
 * 为何要串行化？Bridge 模式通过 `void transport.write()` 触发写入（fire-and-forget）。
 * 若不串行化，并发 POST → 并发 Firestore 写入同一文档 → 冲突 → 重试风暴 → On-Call 报警。
 */
export class HybridTransport extends WebSocketTransport {
  /** HTTP POST 目标 URL（由 WebSocket URL 转换而来） */
  private postUrl: string
  /** 串行批量上传器，管理排队、重试和背压 */
  private uploader: SerialBatchEventUploader<StdoutMessage>

  // stream_event 延迟缓冲区——积累 content delta，最多 BATCH_FLUSH_INTERVAL_MS 后入队（减少 POST 次数）
  private streamEventBuffer: StdoutMessage[] = []
  private streamEventTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    url: URL,
    headers: Record<string, string> = {},
    sessionId?: string,
    refreshHeaders?: () => Record<string, string>,
    options?: WebSocketTransportOptions & {
      maxConsecutiveFailures?: number
      onBatchDropped?: (batchSize: number, failures: number) => void
    },
  ) {
    super(url, headers, sessionId, refreshHeaders, options)
    const { maxConsecutiveFailures, onBatchDropped } = options ?? {}
    // 将 WebSocket URL 转换为 HTTP POST URL
    this.postUrl = convertWsUrlToPostUrl(url)
    this.uploader = new SerialBatchEventUploader<StdoutMessage>({
      // 上限宽松——session-ingress 接受任意批量大小。
      // 在 POST 飞行期间事件自然积累；此值只是单批次上限。
      maxBatchSize: 500,
      // Bridge 调用方使用 `void transport.write()`——背压对其无效（不 await）。
      // 批次 > maxQueueSize 会导致死锁（见 SerialBatchEventUploader 背压检查），
      // 因此将此值设得足够高，使其仅作为内存限制。
      // 后续待调用方 await 后再引入真正的背压。
      maxQueueSize: 100_000,
      baseDelayMs: 500,
      maxDelayMs: 8000,
      jitterMs: 1000,
      // 可选的连续失败上限：防止持续失败的服务端将 drain 循环
      // 占用到进程生命周期结束。undefined = 无限重试。
      // replBridge 会设置此值；1P 的 transportUtils 路径不设置。
      maxConsecutiveFailures,
      onBatchDropped: (batchSize, failures) => {
        logForDiagnosticsNoPII(
          'error',
          'cli_hybrid_batch_dropped_max_failures',
          {
            batchSize,
            failures,
          },
        )
        onBatchDropped?.(batchSize, failures)
      },
      send: batch => this.postOnce(batch),
    })
    logForDebugging(`HybridTransport: POST URL = ${this.postUrl}`)
    logForDiagnosticsNoPII('info', 'cli_hybrid_transport_initialized')
  }

  /**
   * 将消息入队并等待队列排空后返回。
   *
   * 返回 flush() Promise 是为了维持以下契约：
   * `await write()` 在事件 POST 完成后才 resolve
   * （测试和 replBridge 的初始 flush 依赖此行为）。
   * fire-and-forget 调用方（`void transport.write()`）不受影响——
   * 他们不 await，所以推迟 resolve 不增加延迟。
   *
   * stream_event 例外：立即返回，不等待 flush（调用方不 await stream_event）。
   */
  override async write(message: StdoutMessage): Promise<void> {
    if (message.type === 'stream_event') {
      // 延迟模式：将 stream_event 暂存，100ms 后批量入队。
      // Promise 立即 resolve——调用方不等待 stream_event 发送完成。
      this.streamEventBuffer.push(message)
      if (!this.streamEventTimer) {
        this.streamEventTimer = setTimeout(
          () => this.flushStreamEvents(),
          BATCH_FLUSH_INTERVAL_MS,
        )
      }
      return
    }
    // 立即模式：先 flush 缓冲的 stream_event（保证顺序），再将此事件入队。
    await this.uploader.enqueue([...this.takeStreamEvents(), message])
    return this.uploader.flush()
  }

  /**
   * 批量写入多条消息，先 flush stream_event 缓冲以保证顺序。
   */
  async writeBatch(messages: StdoutMessage[]): Promise<void> {
    await this.uploader.enqueue([...this.takeStreamEvents(), ...messages])
    return this.uploader.flush()
  }

  /** 已丢弃批次计数（快照 writeBatch() 前后可检测静默丢弃）。 */
  get droppedBatchCount(): number {
    return this.uploader.droppedBatchCount
  }

  /**
   * 阻塞直到所有 pending 事件均已 POST 完成。
   * 供 bridge 初始历史 flush 使用，确保 onStateChange('connected') 在持久化后才触发。
   */
  flush(): Promise<void> {
    // 先将 stream_event 缓冲区的内容入队，再等待 uploader 排空
    void this.uploader.enqueue(this.takeStreamEvents())
    return this.uploader.flush()
  }

  /**
   * 清空 stream_event 缓冲区并取消延迟定时器，返回已缓冲的事件列表。
   * 用于在非 stream_event 写入前保证事件顺序。
   */
  private takeStreamEvents(): StdoutMessage[] {
    if (this.streamEventTimer) {
      clearTimeout(this.streamEventTimer)
      this.streamEventTimer = null
    }
    const buffered = this.streamEventBuffer
    this.streamEventBuffer = []
    return buffered
  }

  /**
   * 延迟定时器触发回调：将积累的 stream_event 批量入队。
   */
  private flushStreamEvents(): void {
    this.streamEventTimer = null
    void this.uploader.enqueue(this.takeStreamEvents())
  }

  /**
   * 优雅关闭：清理定时器和缓冲区，为排队写入提供宽限期，然后关闭上传器和 WebSocket。
   *
   * close() 保持同步（立即返回），但通过 Promise.race 异步等待 uploader.flush()
   * 或 CLOSE_GRACE_MS 超时，之后才调用 uploader.close()。
   * 这样可以给正在排队的写入最后一次机会发出去，而不阻塞调用方。
   */
  override close(): void {
    if (this.streamEventTimer) {
      clearTimeout(this.streamEventTimer)
      this.streamEventTimer = null
    }
    this.streamEventBuffer = []
    // 为残留队列提供宽限期（fallback）。replBridge 的拆解流程
    // 现在在 write 和 close 之间 await archive，所以 archive 延迟
    // 是主要 drain 窗口，此处是最后手段。
    // close() 保持同步，通过 Promise.race 异步等待。
    const uploader = this.uploader
    let graceTimer: ReturnType<typeof setTimeout> | undefined
    void Promise.race([
      uploader.flush(),
      new Promise<void>(r => {
        // eslint-disable-next-line no-restricted-syntax -- need timer ref for clearTimeout
        graceTimer = setTimeout(r, CLOSE_GRACE_MS)
      }),
    ]).finally(() => {
      clearTimeout(graceTimer)
      uploader.close()
    })
    super.close()
  }

  /**
   * 单次 POST 尝试，失败时抛出异常以触发 SerialBatchEventUploader 重试。
   *
   * 返回（不抛出）的情况：
   *   - 2xx 成功
   *   - 无 session token（静默丢弃）
   *   - 4xx（非 429）永久错误（静默丢弃）
   *
   * 抛出异常（触发上传器重试）的情况：
   *   - 网络错误（axios 异常）
   *   - 429 Too Many Requests（速率限制，需要重试）
   *   - 5xx 服务端错误（需要重试）
   */
  private async postOnce(events: StdoutMessage[]): Promise<void> {
    const sessionToken = getSessionIngressAuthToken()
    if (!sessionToken) {
      // 无 token 时静默丢弃，不重试（token 是必要条件）
      logForDebugging('HybridTransport: No session token available for POST')
      logForDiagnosticsNoPII('warn', 'cli_hybrid_post_no_token')
      return
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${sessionToken}`,
      'Content-Type': 'application/json',
    }

    let response
    try {
      response = await axios.post(
        this.postUrl,
        { events },
        {
          headers,
          validateStatus: () => true,  // 关闭 axios 的默认 4xx/5xx 抛出，统一在下方处理
          timeout: POST_TIMEOUT_MS,
        },
      )
    } catch (error) {
      // 网络层错误（连接超时、DNS 失败等）：抛出以触发重试
      const axiosError = error as AxiosError
      logForDebugging(`HybridTransport: POST error: ${axiosError.message}`)
      logForDiagnosticsNoPII('warn', 'cli_hybrid_post_network_error')
      throw error
    }

    if (response.status >= 200 && response.status < 300) {
      // 2xx 成功
      logForDebugging(`HybridTransport: POST success count=${events.length}`)
      return
    }

    // 4xx（除 429 外）是永久错误——丢弃，不重试
    if (
      response.status >= 400 &&
      response.status < 500 &&
      response.status !== 429
    ) {
      logForDebugging(
        `HybridTransport: POST returned ${response.status} (permanent), dropping`,
      )
      logForDiagnosticsNoPII('warn', 'cli_hybrid_post_client_error', {
        status: response.status,
      })
      return
    }

    // 429 / 5xx 是可重试错误——抛出以触发上传器退避重试
    logForDebugging(
      `HybridTransport: POST returned ${response.status} (retryable)`,
    )
    logForDiagnosticsNoPII('warn', 'cli_hybrid_post_retryable_error', {
      status: response.status,
    })
    throw new Error(`POST failed with ${response.status}`)
  }
}

/**
 * 将 WebSocket URL 转换为 HTTP POST 端点 URL。
 *
 * 转换规则：
 *   输入：wss://api.example.com/v2/session_ingress/ws/<session_id>
 *   输出：https://api.example.com/v2/session_ingress/session/<session_id>/events
 *
 * 即：wss→https（ws→http），路径中的 /ws/ 替换为 /session/，末尾追加 /events。
 */
function convertWsUrlToPostUrl(wsUrl: URL): string {
  // WebSocket 协议转换为对应的 HTTP 协议
  const protocol = wsUrl.protocol === 'wss:' ? 'https:' : 'http:'

  // 将路径中的 /ws/ 替换为 /session/，并在末尾追加 /events
  let pathname = wsUrl.pathname
  pathname = pathname.replace('/ws/', '/session/')
  if (!pathname.endsWith('/events')) {
    pathname = pathname.endsWith('/')
      ? pathname + 'events'
      : pathname + '/events'
  }

  return `${protocol}//${wsUrl.host}${pathname}${wsUrl.search}`
}
