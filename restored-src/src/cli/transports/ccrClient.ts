/**
 * CCR v2 客户端 — 管理 Worker 生命周期协议与 CCR 后端的全部交互。
 *
 * 在整个 Claude Code 系统中的位置：
 * CCRClient 是 CCR v2（Claude Code Runner 第二代）模式下的核心通信客户端。
 * 它通过 SSETransport 接收来自服务端的 client_event（前端发来的控制帧），
 * 并通过 HTTP POST 将以下数据上传到 CCR 后端：
 *   - 客户端事件（StdoutMessage）  → POST /worker/events
 *   - 内部事件（transcript/compaction）→ POST /worker/internal-events
 *   - 投递确认（received/processing/processed）→ POST /worker/events/delivery
 *   - Worker 状态（idle/running/waiting 等）→ PUT /worker（通过 WorkerStateUploader）
 *   - 心跳                           → POST /worker/heartbeat（每 20s 一次）
 *
 * 关键设计点：
 *   - text_delta 合并：100ms 延迟缓冲 + accumulateStreamEvents() 将同一内容块的
 *     多条 text_delta 合并为"迄今全量快照"，使中途连接的客户端也能看到完整文本。
 *   - epoch 管理：WorkerEpoch 由环境变量 CLAUDE_CODE_WORKER_EPOCH 提供，
 *     409 Conflict 表示新 Worker 已取代当前实例，立即调用 onEpochMismatch() 退出。
 *   - 串行上传：所有写路径均委托给 SerialBatchEventUploader，保证同时只有 1 个
 *     POST 在飞行中，消除 Firestore 并发写冲突。
 */
import { randomUUID } from 'crypto'
import type {
  SDKPartialAssistantMessage,
  StdoutMessage,
} from 'src/entrypoints/sdk/controlTypes.js'
import { decodeJwtExpiry } from '../../bridge/jwtUtils.js'
import { logForDebugging } from '../../utils/debug.js'
import { logForDiagnosticsNoPII } from '../../utils/diagLogs.js'
import { errorMessage, getErrnoCode } from '../../utils/errors.js'
import { createAxiosInstance } from '../../utils/proxy.js'
import {
  registerSessionActivityCallback,
  unregisterSessionActivityCallback,
} from '../../utils/sessionActivity.js'
import {
  getSessionIngressAuthHeaders,
  getSessionIngressAuthToken,
} from '../../utils/sessionIngressAuth.js'
import type {
  RequiresActionDetails,
  SessionState,
} from '../../utils/sessionState.js'
import { sleep } from '../../utils/sleep.js'
import { getClaudeCodeUserAgent } from '../../utils/userAgent.js'
import {
  RetryableError,
  SerialBatchEventUploader,
} from './SerialBatchEventUploader.js'
import type { SSETransport, StreamClientEvent } from './SSETransport.js'
import { WorkerStateUploader } from './WorkerStateUploader.js'

/** 心跳发送间隔（毫秒）。服务端 TTL 为 60s，20s 发一次有足够余量。 */
const DEFAULT_HEARTBEAT_INTERVAL_MS = 20_000

/**
 * stream_event 消息在延迟缓冲区中最多积累此时长（毫秒）后才入队。
 * 与 HybridTransport 的批量窗口保持一致。
 * 同一内容块的 text_delta 事件在每次 flush 时合并为"迄今全量快照"——
 * 每条发出的事件都是自包含的，中途连接的客户端可以看到完整文本而非片段。
 */
const STREAM_EVENT_FLUSH_INTERVAL_MS = 100

/** 提升到模块级别的 axios validateStatus 回调，避免每次请求创建闭包。始终返回 true 以禁用 axios 自动抛出 4xx/5xx。 */
function alwaysValidStatus(): boolean {
  return true
}

/** CCRClient 初始化失败的原因类型 */
export type CCRInitFailReason =
  | 'no_auth_headers'
  | 'missing_epoch'
  | 'worker_register_failed'

/** initialize() 抛出的错误类，携带类型化的失败原因，用于诊断分类。 */
export class CCRInitError extends Error {
  constructor(readonly reason: CCRInitFailReason) {
    super(`CCRClient init failed: ${reason}`)
  }
}

/**
 * 连续 401/403 失败上限（token 看起来有效时）。
 * 若 JWT 已过期则立即退出（确定性，重试无意义）。
 * 此阈值用于不确定情况：token 的 exp 在未来，但服务端返回 401
 * （userauth 宕机、KMS 抖动、时钟偏差）。
 * 10 次 × 20s 心跳间隔 ≈ 200s 等待恢复窗口。
 */
const MAX_CONSECUTIVE_AUTH_FAILURES = 10

/** 客户端事件的负载结构 */
type EventPayload = {
  uuid: string
  type: string
  [key: string]: unknown
}

/** 封装单条客户端事件的上传结构 */
type ClientEvent = {
  payload: EventPayload
  ephemeral?: boolean
}

/**
 * 携带 text_delta 的 stream_event 的结构子集，用于 text_delta 合并。
 * 不是 SDKPartialAssistantMessage 的类型收窄——
 * 通过两层 union 收窄 RawMessageStreamEvent 的 delta 字段会破坏判别式。
 */
type CoalescedStreamEvent = {
  type: 'stream_event'
  uuid: string
  session_id: string
  parent_tool_use_id: string | null
  event: {
    type: 'content_block_delta'
    index: number
    delta: { type: 'text_delta'; text: string }
  }
}

/**
 * text_delta 合并累加器状态。以 API 消息 ID 为键，生命周期与 assistant 消息绑定——
 * 当完整的 SDKAssistantMessage 到达时（writeEvent 中）清除，
 * 即使 abort/error 路径跳过了 content_block_stop/message_stop 也能可靠清理。
 */
export type StreamAccumulatorState = {
  /** API 消息 ID（msg_...）→ blocks[blockIndex] → 文本 chunk 数组。 */
  byMessage: Map<string, string[][]>
  /**
   * {session_id}:{parent_tool_use_id} → 当前活跃消息 ID。
   * content_block_delta 事件不携带消息 ID（只有 message_start 有），
   * 因此需要为每个 scope 跟踪当前正在流式传输的消息。
   * 每个 scope 同一时刻最多只有一条消息在流式传输。
   */
  scopeToMessage: Map<string, string>
}

/** 创建空的 stream_event 文本累加器状态 */
export function createStreamAccumulator(): StreamAccumulatorState {
  return { byMessage: new Map(), scopeToMessage: new Map() }
}

/** 构造 scope key：{session_id}:{parent_tool_use_id}，用于 scopeToMessage 映射 */
function scopeKey(m: {
  session_id: string
  parent_tool_use_id: string | null
}): string {
  return `${m.session_id}:${m.parent_tool_use_id ?? ''}`
}

/**
 * 将 text_delta stream_event 累加为"迄今全量快照"。
 *
 * 每次 flush 对每个被触及的内容块只发出 1 条事件，包含从该块开始至今的完整文本，
 * 中途连接的客户端收到的是自包含快照而非片段。
 *
 * 非 text_delta 事件原样透传。
 * message_start 记录当前 scope 的活跃消息 ID；
 * content_block_delta 将 chunk 追加到对应块；
 * 快照事件复用该块在本次 flush 中首条 text_delta 的 UUID，
 * 保证重试时服务端幂等性稳定。
 *
 * 清理由 writeEvent 在完整 assistant 消息到达时触发（可靠），
 * 而非依赖 stop 事件（abort/error 路径会跳过这些事件）。
 */
export function accumulateStreamEvents(
  buffer: SDKPartialAssistantMessage[],
  state: StreamAccumulatorState,
): EventPayload[] {
  const out: EventPayload[] = []
  // chunks[] → 本次 flush 中已在 out 里的快照事件。
  // 以 chunks 数组引用为键（同一 {messageId, blockIndex} 唯一），
  // 使后续 delta 更新同一条快照，而非每个 delta 各发一条事件。
  const touched = new Map<string[], CoalescedStreamEvent>()
  for (const msg of buffer) {
    switch (msg.event.type) {
      case 'message_start': {
        const id = msg.event.message.id
        const prevId = state.scopeToMessage.get(scopeKey(msg))
        if (prevId) state.byMessage.delete(prevId)
        state.scopeToMessage.set(scopeKey(msg), id)
        state.byMessage.set(id, [])
        out.push(msg)
        break
      }
      case 'content_block_delta': {
        if (msg.event.delta.type !== 'text_delta') {
          out.push(msg)
          break
        }
        const messageId = state.scopeToMessage.get(scopeKey(msg))
        const blocks = messageId ? state.byMessage.get(messageId) : undefined
        if (!blocks) {
          // 在没有前置 message_start 的情况下收到 delta（重连到流中间，
          // 或 message_start 在之前已被丢弃的缓冲区中）。
          // 无法构造全量快照，原样透传。
          out.push(msg)
          break
        }
        const chunks = (blocks[msg.event.index] ??= [])
        chunks.push(msg.event.delta.text)
        const existing = touched.get(chunks)
        if (existing) {
          existing.event.delta.text = chunks.join('')
          break
        }
        const snapshot: CoalescedStreamEvent = {
          type: 'stream_event',
          uuid: msg.uuid,
          session_id: msg.session_id,
          parent_tool_use_id: msg.parent_tool_use_id,
          event: {
            type: 'content_block_delta',
            index: msg.event.index,
            delta: { type: 'text_delta', text: chunks.join('') },
          },
        }
        touched.set(chunks, snapshot)
        out.push(snapshot)
        break
      }
      default:
        out.push(msg)
    }
  }
  return out
}

/**
 * 清除已完成 assistant 消息的累加器条目。
 * 由 writeEvent 在 SDKAssistantMessage 到达时调用——
 * 这是可靠的流结束信号，即使 abort/interrupt/error 跳过了 SSE stop 事件也会触发。
 */
export function clearStreamAccumulatorForMessage(
  state: StreamAccumulatorState,
  assistant: {
    session_id: string
    parent_tool_use_id: string | null
    message: { id: string }
  },
): void {
  state.byMessage.delete(assistant.message.id)
  const scope = scopeKey(assistant)
  if (state.scopeToMessage.get(scope) === assistant.message.id) {
    state.scopeToMessage.delete(scope)
  }
}

/** HTTP 请求结果：ok=true 表示 2xx 成功；ok=false 时可附带服务端的重试延迟提示 */
type RequestResult = { ok: true } | { ok: false; retryAfterMs?: number }

/** 内部事件上传结构（transcript / compaction 记录） */
type WorkerEvent = {
  payload: EventPayload
  is_compaction?: boolean
  agent_id?: string
}

/** 从后端读取的内部事件结构（session resume 时使用） */
export type InternalEvent = {
  event_id: string
  event_type: string
  payload: Record<string, unknown>
  event_metadata?: Record<string, unknown> | null
  is_compaction: boolean
  created_at: string
  agent_id?: string
}

/** GET /worker/internal-events 的分页响应结构 */
type ListInternalEventsResponse = {
  data: InternalEvent[]
  next_cursor?: string
}

/** GET /worker 的响应结构，用于恢复 external_metadata */
type WorkerStateResponse = {
  worker?: {
    external_metadata?: Record<string, unknown>
  }
}

/**
 * CCR v2 Worker 生命周期管理客户端。
 *
 * 负责以下协议交互：
 *   - Epoch 管理：从 CLAUDE_CODE_WORKER_EPOCH 环境变量读取 worker_epoch
 *   - 运行时状态上报：PUT /sessions/{id}/worker
 *   - 心跳：POST /sessions/{id}/worker/heartbeat（用于容器存活检测）
 *
 * 所有写入操作均通过 this.request() 发送。
 */
export class CCRClient {
  /** 当前 worker epoch，由 initialize() 从环境变量或参数中设置 */
  private workerEpoch = 0
  /** 心跳定时器间隔（毫秒） */
  private readonly heartbeatIntervalMs: number
  /** 心跳抖动比例（防止多个实例同步心跳） */
  private readonly heartbeatJitterFraction: number
  /** 心跳定时器句柄 */
  private heartbeatTimer: NodeJS.Timeout | null = null
  /** 防止心跳重入的标志 */
  private heartbeatInFlight = false
  /** 客户端是否已关闭 */
  private closed = false
  /** 连续 401/403 失败计数 */
  private consecutiveAuthFailures = 0
  /** 当前 Worker 状态（idle/running 等），用于去重上报 */
  private currentState: SessionState | null = null
  /** CCR 后端会话基础 URL（https://host/v1/code/sessions/{id}） */
  private readonly sessionBaseUrl: string
  /** 从 URL 路径最后一段提取的会话 ID */
  private readonly sessionId: string
  /** 带 keep-alive 的 axios 实例，复用 HTTP 连接 */
  private readonly http = createAxiosInstance({ keepAlive: true })

  // stream_event 延迟缓冲区——积累 content delta，最多 STREAM_EVENT_FLUSH_INTERVAL_MS 后入队
  // （减少 POST 次数，并支持 text_delta 合并）。镜像 HybridTransport 的模式。
  private streamEventBuffer: SDKPartialAssistantMessage[] = []
  private streamEventTimer: ReturnType<typeof setTimeout> | null = null
  // 全量文本累加器。跨多次 flush 持久存在，使每条发出的 text_delta 事件都携带
  // 从该内容块开始的完整文本——中途重连的客户端看到自包含快照而非片段。
  // 以 API 消息 ID 为键；在 writeEvent 中收到完整 assistant 消息时清除。
  private streamTextAccumulator = createStreamAccumulator()

  /** Worker 状态上报器（合并相邻 PUT，1 个飞行中 + 1 个待发） */
  private readonly workerState: WorkerStateUploader
  /** 客户端事件上传器（StdoutMessage → POST /worker/events） */
  private readonly eventUploader: SerialBatchEventUploader<ClientEvent>
  /** 内部事件上传器（transcript → POST /worker/internal-events） */
  private readonly internalEventUploader: SerialBatchEventUploader<WorkerEvent>
  /** 投递状态上传器（received/processing/processed → POST /worker/events/delivery） */
  private readonly deliveryUploader: SerialBatchEventUploader<{
    eventId: string
    status: 'received' | 'processing' | 'processed'
  }>

  /**
   * 服务端返回 409（新 worker epoch 已取代当前实例）时的处理函数。
   * 默认：process.exit(1)——适用于由父 bridge 重新派生的子进程模式。
   * 进程内调用方（replBridge）必须覆盖此函数以优雅关闭，
   * 否则 exit 会杀死用户的 REPL。
   */
  private readonly onEpochMismatch: () => never

  /**
   * 认证头来源。默认读取进程级别的 session-ingress token
   * （CLAUDE_CODE_SESSION_ACCESS_TOKEN 环境变量）。
   * 管理多个并发会话且各会话 JWT 不同的调用方必须注入此函数——
   * 环境变量路径是进程全局的，多会话并发时会互相覆盖。
   */
  private readonly getAuthHeaders: () => Record<string, string>

  constructor(
    transport: SSETransport,
    sessionUrl: URL,
    opts?: {
      onEpochMismatch?: () => never
      heartbeatIntervalMs?: number
      heartbeatJitterFraction?: number
      /**
       * 实例级别的认证头来源。省略时读取进程级别的
       * CLAUDE_CODE_SESSION_ACCESS_TOKEN（单会话调用方——REPL、daemon）。
       * 并发多会话调用方必须传入此参数。
       */
      getAuthHeaders?: () => Record<string, string>
    },
  ) {
    this.onEpochMismatch =
      opts?.onEpochMismatch ??
      (() => {
        // eslint-disable-next-line custom-rules/no-process-exit
        process.exit(1)
      })
    this.heartbeatIntervalMs =
      opts?.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS
    this.heartbeatJitterFraction = opts?.heartbeatJitterFraction ?? 0
    this.getAuthHeaders = opts?.getAuthHeaders ?? getSessionIngressAuthHeaders
    // Session URL: https://host/v1/code/sessions/{id}（需要 http/https 协议）
    if (sessionUrl.protocol !== 'http:' && sessionUrl.protocol !== 'https:') {
      throw new Error(
        `CCRClient: Expected http(s) URL, got ${sessionUrl.protocol}`,
      )
    }
    const pathname = sessionUrl.pathname.replace(/\/$/, '')
    this.sessionBaseUrl = `${sessionUrl.protocol}//${sessionUrl.host}${pathname}`
    // 从 URL 路径的最后一段提取 session ID
    this.sessionId = pathname.split('/').pop() || ''

    this.workerState = new WorkerStateUploader({
      send: body =>
        this.request(
          'put',
          '/worker',
          { worker_epoch: this.workerEpoch, ...body },
          'PUT worker',
        ).then(r => r.ok),
      baseDelayMs: 500,
      maxDelayMs: 30_000,
      jitterMs: 500,
    })

    this.eventUploader = new SerialBatchEventUploader<ClientEvent>({
      maxBatchSize: 100,
      maxBatchBytes: 10 * 1024 * 1024,
      // flushStreamEventBuffer() 一次将整个 100ms 窗口的 stream_event 入队。
      // 若混合多种 delta 类型且无法折叠为单个快照，可能超过旧上限（50），
      // 导致 SerialBatchEventUploader 背压检查死锁。
      // 与 HybridTransport 保持一致——足够大，仅作为内存限制。
      maxQueueSize: 100_000,
      send: async batch => {
        const result = await this.request(
          'post',
          '/worker/events',
          { worker_epoch: this.workerEpoch, events: batch },
          'client events',
        )
        if (!result.ok) {
          throw new RetryableError(
            'client event POST failed',
            result.retryAfterMs,
          )
        }
      },
      baseDelayMs: 500,
      maxDelayMs: 30_000,
      jitterMs: 500,
    })

    this.internalEventUploader = new SerialBatchEventUploader<WorkerEvent>({
      maxBatchSize: 100,
      maxBatchBytes: 10 * 1024 * 1024,
      maxQueueSize: 200,
      send: async batch => {
        const result = await this.request(
          'post',
          '/worker/internal-events',
          { worker_epoch: this.workerEpoch, events: batch },
          'internal events',
        )
        if (!result.ok) {
          throw new RetryableError(
            'internal event POST failed',
            result.retryAfterMs,
          )
        }
      },
      baseDelayMs: 500,
      maxDelayMs: 30_000,
      jitterMs: 500,
    })

    this.deliveryUploader = new SerialBatchEventUploader<{
      eventId: string
      status: 'received' | 'processing' | 'processed'
    }>({
      maxBatchSize: 64,
      maxQueueSize: 64,
      send: async batch => {
        const result = await this.request(
          'post',
          '/worker/events/delivery',
          {
            worker_epoch: this.workerEpoch,
            updates: batch.map(d => ({
              event_id: d.eventId,
              status: d.status,
            })),
          },
          'delivery batch',
        )
        if (!result.ok) {
          throw new RetryableError('delivery POST failed', result.retryAfterMs)
        }
      },
      baseDelayMs: 500,
      maxDelayMs: 30_000,
      jitterMs: 500,
    })

    // 在构造函数中（而非 initialize()）注册 SSE 事件回调，
    // 确保回调在 new CCRClient() 返回时即已注册——
    // remoteIO 可在之后立即调用 transport.connect()，
    // 不会与首个 SSE 追帧（catch-up frame）竞争未注册的 onEventCallback。
    transport.setOnEvent((event: StreamClientEvent) => {
      this.reportDelivery(event.event_id, 'received')
    })
  }

  /**
   * 初始化 session worker：
   * 1. 从参数读取 worker_epoch，或回退到环境变量 CLAUDE_CODE_WORKER_EPOCH
   *    （由 env-manager / bridge spawner 设置）。
   * 2. 将状态上报为 'idle'，并清除上次 Worker 崩溃遗留的过期元数据。
   * 3. 启动心跳定时器。
   *
   * 进程内调用方（replBridge）直接传入 epoch——它们自己完成了 Worker 注册，
   * 没有父进程设置环境变量。
   */
  async initialize(epoch?: number): Promise<Record<string, unknown> | null> {
    const startMs = Date.now()
    if (Object.keys(this.getAuthHeaders()).length === 0) {
      throw new CCRInitError('no_auth_headers')
    }
    if (epoch === undefined) {
      const rawEpoch = process.env.CLAUDE_CODE_WORKER_EPOCH
      epoch = rawEpoch ? parseInt(rawEpoch, 10) : NaN
    }
    if (isNaN(epoch)) {
      throw new CCRInitError('missing_epoch')
    }
    this.workerEpoch = epoch

    // 与 init PUT 并发发起——两者互不依赖，可以重叠执行。
    const restoredPromise = this.getWorkerState()

    const result = await this.request(
      'put',
      '/worker',
      {
        worker_status: 'idle',
        worker_epoch: this.workerEpoch,
        // 清除上次 Worker 崩溃遗留的 pending_action/task_summary——
        // 会话内清除在进程重启后不保留。
        external_metadata: {
          pending_action: null,
          task_summary: null,
        },
      },
      'PUT worker (init)',
    )
    if (!result.ok) {
      // 409 → onEpochMismatch 可能抛出，但 request() 会捕获并返回 false。
      // 若不检查此处，会继续调用 startHeartbeat()，为已失效的 epoch 泄漏 20s 定时器。
      // 抛出异常触发 connect() 的 rejection 处理器，而非走成功路径。
      throw new CCRInitError('worker_register_failed')
    }
    this.currentState = 'idle'
    this.startHeartbeat()

    // sessionActivity 的引用计数门控定时器在 API 调用或工具执行期间触发；
    // 若无写入，容器租约可能在等待期间过期。
    // v1 在 WebSocketTransport 中按连接注册此回调。
    registerSessionActivityCallback(() => {
      void this.writeEvent({ type: 'keep_alive' })
    })

    logForDebugging(`CCRClient: initialized, epoch=${this.workerEpoch}`)
    logForDiagnosticsNoPII('info', 'cli_worker_lifecycle_initialized', {
      epoch: this.workerEpoch,
      duration_ms: Date.now() - startMs,
    })

    // 等待并发 GET 完成，并在此处（PUT 成功后）记录 state_restored 诊断——
    // 若在 getWorkerState() 内部记录，GET 先于 PUT 失败完成时会出现
    // "同一 session 既记录 init_failed 又记录 state_restored"的歧义。
    const { metadata, durationMs } = await restoredPromise
    if (!this.closed) {
      logForDiagnosticsNoPII('info', 'cli_worker_state_restored', {
        duration_ms: durationMs,
        had_state: metadata !== null,
      })
    }
    return metadata
  }

  // control_request 会被标记为已处理，重启后不会再次投递，
  // 因此需要读取上一个 Worker 写入的状态。
  private async getWorkerState(): Promise<{
    metadata: Record<string, unknown> | null
    durationMs: number
  }> {
    const startMs = Date.now()
    const authHeaders = this.getAuthHeaders()
    if (Object.keys(authHeaders).length === 0) {
      return { metadata: null, durationMs: 0 }
    }
    const data = await this.getWithRetry<WorkerStateResponse>(
      `${this.sessionBaseUrl}/worker`,
      authHeaders,
      'worker_state',
    )
    return {
      metadata: data?.worker?.external_metadata ?? null,
      durationMs: Date.now() - startMs,
    }
  }

  /**
   * 向 CCR 后端发送认证 HTTP 请求。
   *
   * 处理逻辑：
   *   - 附加认证头、Content-Type、anthropic-version 和 User-Agent。
   *   - 2xx 返回 { ok: true }，并重置连续认证失败计数。
   *   - 409 Conflict：调用 handleEpochMismatch()（触发进程退出）。
   *   - 401/403：
   *     - 若 JWT 已过期（exp < now）：立即退出（确定性，重试无意义）。
   *     - 否则计入连续失败计数；达到 MAX_CONSECUTIVE_AUTH_FAILURES 时退出。
   *   - 429：读取 Retry-After 头（整数秒），让上传器遵从服务端的退避提示。
   *   - 其他 4xx/5xx：返回 { ok: false }。
   *   - 网络异常：捕获后返回 { ok: false }。
   */
  private async request(
    method: 'post' | 'put',
    path: string,
    body: unknown,
    label: string,
    { timeout = 10_000 }: { timeout?: number } = {},
  ): Promise<RequestResult> {
    const authHeaders = this.getAuthHeaders()
    if (Object.keys(authHeaders).length === 0) return { ok: false }

    try {
      const response = await this.http[method](
        `${this.sessionBaseUrl}${path}`,
        body,
        {
          headers: {
            ...authHeaders,
            'Content-Type': 'application/json',
            'anthropic-version': '2023-06-01',
            'User-Agent': getClaudeCodeUserAgent(),
          },
          validateStatus: alwaysValidStatus,
          timeout,
        },
      )

      if (response.status >= 200 && response.status < 300) {
        this.consecutiveAuthFailures = 0
        return { ok: true }
      }
      if (response.status === 409) {
        this.handleEpochMismatch()
      }
      if (response.status === 401 || response.status === 403) {
        // token 已过期的 401 是确定性的——任何重试都不会成功。
        // 在进入阈值循环之前先检查 token 自身的 exp。
        const tok = getSessionIngressAuthToken()
        const exp = tok ? decodeJwtExpiry(tok) : null
        if (exp !== null && exp * 1000 < Date.now()) {
          logForDebugging(
            `CCRClient: session_token expired (exp=${new Date(exp * 1000).toISOString()}) — no refresh was delivered, exiting`,
            { level: 'error' },
          )
          logForDiagnosticsNoPII('error', 'cli_worker_token_expired_no_refresh')
          this.onEpochMismatch()
        }
        // token 看起来有效但服务端返回 401——可能是服务端短暂故障
        // （userauth 宕机、KMS 抖动）。计入连续失败计数。
        this.consecutiveAuthFailures++
        if (this.consecutiveAuthFailures >= MAX_CONSECUTIVE_AUTH_FAILURES) {
          logForDebugging(
            `CCRClient: ${this.consecutiveAuthFailures} consecutive auth failures with a valid-looking token — server-side auth unrecoverable, exiting`,
            { level: 'error' },
          )
          logForDiagnosticsNoPII('error', 'cli_worker_auth_failures_exhausted')
          this.onEpochMismatch()
        }
      }
      logForDebugging(`CCRClient: ${label} returned ${response.status}`, {
        level: 'warn',
      })
      logForDiagnosticsNoPII('warn', 'cli_worker_request_failed', {
        method,
        path,
        status: response.status,
      })
      if (response.status === 429) {
        // 读取 Retry-After 头（整数秒），让上传器遵从服务端退避提示
        const raw = response.headers?.['retry-after']
        const seconds = typeof raw === 'string' ? parseInt(raw, 10) : NaN
        if (!isNaN(seconds) && seconds >= 0) {
          return { ok: false, retryAfterMs: seconds * 1000 }
        }
      }
      return { ok: false }
    } catch (error) {
      logForDebugging(`CCRClient: ${label} failed: ${errorMessage(error)}`, {
        level: 'warn',
      })
      logForDiagnosticsNoPII('warn', 'cli_worker_request_error', {
        method,
        path,
        error_code: getErrnoCode(error),
      })
      return { ok: false }
    }
  }

  /** 通过 PUT /sessions/{id}/worker 向 CCR 上报 Worker 运行时状态。状态未变化且无详情时跳过上报以去重。 */
  reportState(state: SessionState, details?: RequiresActionDetails): void {
    if (state === this.currentState && !details) return
    this.currentState = state
    this.workerState.enqueue({
      worker_status: state,
      requires_action_details: details
        ? {
            tool_name: details.tool_name,
            action_description: details.action_description,
            request_id: details.request_id,
          }
        : null,
    })
  }

  /** 通过 PUT /worker 向 CCR 上报外部元数据（标题、摘要等）。 */
  reportMetadata(metadata: Record<string, unknown>): void {
    this.workerState.enqueue({ external_metadata: metadata })
  }

  /**
   * 处理 epoch 不匹配（409 Conflict）。
   * 新的 CC 实例已取代当前实例——立即退出。
   */
  private handleEpochMismatch(): never {
    logForDebugging('CCRClient: Epoch mismatch (409), shutting down', {
      level: 'error',
    })
    logForDiagnosticsNoPII('error', 'cli_worker_epoch_mismatch')
    this.onEpochMismatch()
  }

  /** 启动周期性心跳定时器（含抖动防止多实例同步）。 */
  private startHeartbeat(): void {
    this.stopHeartbeat()
    const schedule = (): void => {
      const jitter =
        this.heartbeatIntervalMs *
        this.heartbeatJitterFraction *
        (2 * Math.random() - 1)
      this.heartbeatTimer = setTimeout(tick, this.heartbeatIntervalMs + jitter)
    }
    const tick = (): void => {
      void this.sendHeartbeat()
      // stopHeartbeat 会将定时器置为 null；在 fire-and-forget 发送后、重新调度前检查，
      // 以便 close() 在 sendHeartbeat 期间被调用时能立即生效。
      if (this.heartbeatTimer === null) return
      schedule()
    }
    schedule()
  }

  /** 停止心跳定时器。 */
  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  /** 发送单次心跳（POST /sessions/{id}/worker/heartbeat）。使用 heartbeatInFlight 防止重入。 */
  private async sendHeartbeat(): Promise<void> {
    if (this.heartbeatInFlight) return
    this.heartbeatInFlight = true
    try {
      const result = await this.request(
        'post',
        '/worker/heartbeat',
        { session_id: this.sessionId, worker_epoch: this.workerEpoch },
        'Heartbeat',
        { timeout: 5_000 },
      )
      if (result.ok) {
        logForDebugging('CCRClient: Heartbeat sent')
      }
    } finally {
      this.heartbeatInFlight = false
    }
  }

  /**
   * 将 StdoutMessage 作为客户端事件通过 POST /sessions/{id}/worker/events 发送。
   * 这些事件通过 SSE 流对前端客户端可见。
   * 若消息缺少 UUID，则自动注入，确保重试时服务端幂等性。
   *
   * stream_event 消息在 100ms 延迟缓冲区中积累，并进行 text_delta 合并
   * （同一内容块的 text_delta 在每次 flush 时发出包含完整文本的快照）。
   * 非 stream_event 写入前先 flush 缓冲区以保证下游事件顺序。
   */
  async writeEvent(message: StdoutMessage): Promise<void> {
    if (message.type === 'stream_event') {
      this.streamEventBuffer.push(message)
      if (!this.streamEventTimer) {
        this.streamEventTimer = setTimeout(
          () => void this.flushStreamEventBuffer(),
          STREAM_EVENT_FLUSH_INTERVAL_MS,
        )
      }
      return
    }
    await this.flushStreamEventBuffer()
    if (message.type === 'assistant') {
      clearStreamAccumulatorForMessage(this.streamTextAccumulator, message)
    }
    await this.eventUploader.enqueue(this.toClientEvent(message))
  }

  /** 将 StdoutMessage 封装为 ClientEvent，若缺少 UUID 则自动注入随机 UUID。 */
  private toClientEvent(message: StdoutMessage): ClientEvent {
    const msg = message as unknown as Record<string, unknown>
    return {
      payload: {
        ...msg,
        uuid: typeof msg.uuid === 'string' ? msg.uuid : randomUUID(),
      } as EventPayload,
    }
  }

  /**
   * 排空 stream_event 延迟缓冲区：将 text_delta 累加为全量快照，
   * 清除定时器，并将结果事件入队。
   * 由定时器触发、writeEvent 处理非 stream_event 消息时，以及 flush() 中调用。
   * close() 会丢弃缓冲区——若需要投递保证，请在 close() 前先调用 flush()。
   */
  private async flushStreamEventBuffer(): Promise<void> {
    if (this.streamEventTimer) {
      clearTimeout(this.streamEventTimer)
      this.streamEventTimer = null
    }
    if (this.streamEventBuffer.length === 0) return
    const buffered = this.streamEventBuffer
    this.streamEventBuffer = []
    const payloads = accumulateStreamEvents(
      buffered,
      this.streamTextAccumulator,
    )
    await this.eventUploader.enqueue(
      payloads.map(payload => ({ payload, ephemeral: true })),
    )
  }

  /**
   * 通过 POST /sessions/{id}/worker/internal-events 写入内部 Worker 事件。
   * 这些事件对前端客户端不可见——它们存储 Worker 内部状态
   * （transcript 消息、compaction 标记），供 session resume 使用。
   */
  async writeInternalEvent(
    eventType: string,
    payload: Record<string, unknown>,
    {
      isCompaction = false,
      agentId,
    }: {
      isCompaction?: boolean
      agentId?: string
    } = {},
  ): Promise<void> {
    const event: WorkerEvent = {
      payload: {
        type: eventType,
        ...payload,
        uuid: typeof payload.uuid === 'string' ? payload.uuid : randomUUID(),
      } as EventPayload,
      ...(isCompaction && { is_compaction: true }),
      ...(agentId && { agent_id: agentId }),
    }
    await this.internalEventUploader.enqueue(event)
  }

  /**
   * 刷新待处理的内部事件。在每轮对话边界和关闭前调用，
   * 确保 transcript 条目已持久化。
   */
  flushInternalEvents(): Promise<void> {
    return this.internalEventUploader.flush()
  }

  /**
   * 刷新待处理的客户端事件（writeEvent 队列）。
   * 当调用方需要投递确认时，在 close() 之前调用——
   * close() 会直接丢弃队列。
   * 队列排空（或拒绝）后 resolve；
   * 不保证每条 POST 都成功（若需要，请单独检查服务端状态）。
   */
  async flush(): Promise<void> {
    await this.flushStreamEventBuffer()
    return this.eventUploader.flush()
  }

  /**
   * 从 GET /sessions/{id}/worker/internal-events 读取前台 agent 内部事件。
   * 返回最近一次 compaction 边界之后的 transcript 条目，失败时返回 null。
   * 用于 session resume。
   */
  async readInternalEvents(): Promise<InternalEvent[] | null> {
    return this.paginatedGet('/worker/internal-events', {}, 'internal_events')
  }

  /**
   * 从 GET /sessions/{id}/worker/internal-events?subagents=true 读取所有子 agent 内部事件。
   * 返回所有非前台 agent 各自从 compaction 点起的合并事件流。
   * 用于 session resume。
   */
  async readSubagentInternalEvents(): Promise<InternalEvent[] | null> {
    return this.paginatedGet(
      '/worker/internal-events',
      { subagents: 'true' },
      'subagent_events',
    )
  }

  /**
   * 带重试的分页 GET。从列表端点获取所有分页数据，
   * 每页失败时以指数退避加抖动重试。
   */
  private async paginatedGet(
    path: string,
    params: Record<string, string>,
    context: string,
  ): Promise<InternalEvent[] | null> {
    const authHeaders = this.getAuthHeaders()
    if (Object.keys(authHeaders).length === 0) return null

    const allEvents: InternalEvent[] = []
    let cursor: string | undefined

    do {
      const url = new URL(`${this.sessionBaseUrl}${path}`)
      for (const [k, v] of Object.entries(params)) {
        url.searchParams.set(k, v)
      }
      if (cursor) {
        url.searchParams.set('cursor', cursor)
      }

      const page = await this.getWithRetry<ListInternalEventsResponse>(
        url.toString(),
        authHeaders,
        context,
      )
      if (!page) return null

      allEvents.push(...(page.data ?? []))
      cursor = page.next_cursor
    } while (cursor)

    logForDebugging(
      `CCRClient: Read ${allEvents.length} internal events from ${path}${params.subagents ? ' (subagents)' : ''}`,
    )
    return allEvents
  }

  /**
   * 单次 GET 请求，带重试（最多 10 次，指数退避 + 抖动）。
   * 成功时返回解析后的响应体，重试耗尽时返回 null。
   */
  private async getWithRetry<T>(
    url: string,
    authHeaders: Record<string, string>,
    context: string,
  ): Promise<T | null> {
    for (let attempt = 1; attempt <= 10; attempt++) {
      let response
      try {
        response = await this.http.get<T>(url, {
          headers: {
            ...authHeaders,
            'anthropic-version': '2023-06-01',
            'User-Agent': getClaudeCodeUserAgent(),
          },
          validateStatus: alwaysValidStatus,
          timeout: 30_000,
        })
      } catch (error) {
        logForDebugging(
          `CCRClient: GET ${url} failed (attempt ${attempt}/10): ${errorMessage(error)}`,
          { level: 'warn' },
        )
        if (attempt < 10) {
          const delay =
            Math.min(500 * 2 ** (attempt - 1), 30_000) + Math.random() * 500
          await sleep(delay)
        }
        continue
      }

      if (response.status >= 200 && response.status < 300) {
        return response.data
      }
      if (response.status === 409) {
        this.handleEpochMismatch()
      }
      logForDebugging(
        `CCRClient: GET ${url} returned ${response.status} (attempt ${attempt}/10)`,
        { level: 'warn' },
      )

      if (attempt < 10) {
        const delay =
          Math.min(500 * 2 ** (attempt - 1), 30_000) + Math.random() * 500
        await sleep(delay)
      }
    }

    logForDebugging('CCRClient: GET retries exhausted', { level: 'error' })
    logForDiagnosticsNoPII('error', 'cli_worker_get_retries_exhausted', {
      context,
    })
    return null
  }

  /**
   * 上报客户端到 Worker 事件的投递状态。
   * POST /v1/code/sessions/{id}/worker/events/delivery（批量端点）
   */
  reportDelivery(
    eventId: string,
    status: 'received' | 'processing' | 'processed',
  ): void {
    void this.deliveryUploader.enqueue({ eventId, status })
  }

  /** 获取当前 worker epoch（供外部调用方使用）。 */
  getWorkerEpoch(): number {
    return this.workerEpoch
  }

  /** 内部事件队列深度——关机快照的背压信号，用于判断是否需要等待排空。 */
  get internalEventsPending(): number {
    return this.internalEventUploader.pendingCount
  }

  /** 优雅关闭：停止心跳和所有上传器，清空 stream_event 缓冲区和文本累加器。 */
  close(): void {
    this.closed = true
    this.stopHeartbeat()
    unregisterSessionActivityCallback()
    if (this.streamEventTimer) {
      clearTimeout(this.streamEventTimer)
      this.streamEventTimer = null
    }
    this.streamEventBuffer = []
    this.streamTextAccumulator.byMessage.clear()
    this.streamTextAccumulator.scopeToMessage.clear()
    this.workerState.close()
    this.eventUploader.close()
    this.internalEventUploader.close()
    this.deliveryUploader.close()
  }
}
