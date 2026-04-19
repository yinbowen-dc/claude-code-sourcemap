/**
 * replBridgeTransport.ts — REPL Bridge Transport 抽象层
 *
 * 在 Claude Code 系统流程中的位置：
 *   REPL Bridge 传输层（replBridge.ts / remoteBridgeCore.ts）
 *     └─> replBridgeTransport.ts（本文件）——统一 v1 HybridTransport 和 v2 SSETransport+CCRClient 的接口
 *
 * 主要功能：
 *   - ReplBridgeTransport：接口定义，封装 replBridge.ts 所需的全部传输操作
 *   - createV1ReplTransport：将 v1 HybridTransport（WS 读 + POST 写）适配为 ReplBridgeTransport
 *   - createV2ReplTransport：创建 v2 适配器（SSETransport 读流 + CCRClient 写路径），含 worker 注册
 *
 * v1 vs v2 传输路径：
 *   - v1：HybridTransport（WebSocket 读 + session-ingress POST 写）
 *   - v2：SSETransport（读流）+ CCRClient（写：POST /worker/events，心跳：PUT /worker）
 *     - 写路径经由 CCRClient.writeEvent → SerialBatchEventUploader，而非 SSETransport.write()
 *     - SSETransport.write() 目标格式与 CCR v2 不兼容
 *
 * v2 特殊关闭码：
 *   - 4090：epoch superseded（工作代次被取代，需重新注册 worker）
 *   - 4091：CCRClient 初始化失败（ccr.initialize() rejected）
 *   - 4092：SSE 重连次数耗尽（SSETransport 关闭预算耗尽）
 */
import type { StdoutMessage } from 'src/entrypoints/sdk/controlTypes.js'
import { CCRClient } from '../cli/transports/ccrClient.js'
import type { HybridTransport } from '../cli/transports/HybridTransport.js'
import { SSETransport } from '../cli/transports/SSETransport.js'
import { logForDebugging } from '../utils/debug.js'
import { errorMessage } from '../utils/errors.js'
import { updateSessionIngressAuthToken } from '../utils/sessionIngressAuth.js'
import type { SessionState } from '../utils/sessionState.js'
import { registerWorker } from './workSecret.js'

/**
 * REPL Bridge Transport 接口。
 *
 * 统一封装 v1（HybridTransport）和 v2（SSETransport + CCRClient）的公共操作面，
 * 使 replBridge.ts 的 transport 变量类型保持单一，无需关心底层实现差异。
 *
 * 主要方法分组：
 *   - 写操作：write（单消息）、writeBatch（批量消息）
 *   - 生命周期：connect（建立连接）、close（关闭）、flush（刷新写队列）
 *   - 状态查询：isConnectedStatus（写就绪）、getStateLabel（调试标签）
 *   - 回调注册：setOnData / setOnClose / setOnConnect
 *   - 序列号：getLastSequenceNum（SSE 事件序列号高水位，用于断线续传）
 *   - 丢弃计数：droppedBatchCount（SerialBatchEventUploader 静默丢弃计数）
 *   - CCR v2 专属（v1 为空操作）：reportState / reportMetadata / reportDelivery
 */
export type ReplBridgeTransport = {
  write(message: StdoutMessage): Promise<void>
  writeBatch(messages: StdoutMessage[]): Promise<void>
  close(): void
  isConnectedStatus(): boolean
  getStateLabel(): string
  setOnData(callback: (data: string) => void): void
  setOnClose(callback: (closeCode?: number) => void): void
  setOnConnect(callback: () => void): void
  connect(): void
  /**
   * 底层读流的 SSE 事件序列号高水位。
   *
   * replBridge 在切换 transport 前读取此值，传给新 transport，
   * 使新连接从断点续传（否则服务端会从 seq 0 重放整个会话历史）。
   *
   * v1 返回 0：Session-Ingress WS 不使用 SSE 序列号，
   * 重放语义由服务端的消息游标处理。
   */
  getLastSequenceNum(): number
  /**
   * SerialBatchEventUploader 通过 maxConsecutiveFailures 静默丢弃的批次计数（单调递增）。
   *
   * 在 writeBatch() 调用前后对比此值可检测静默丢弃
   * （writeBatch() 即使批次被丢弃也会正常 resolve）。
   * v2 返回 0：v2 写路径不设置 maxConsecutiveFailures，不会丢弃批次。
   */
  readonly droppedBatchCount: number
  /**
   * PUT /worker state（仅 v2 有效，v1 为空操作）。
   *
   * 'requires_action' 告知后端权限提示待处理——claude.ai 显示"等待输入"指示器。
   * REPL/daemon 调用方不需要此功能（用户在本地 REPL 中直接操作）；
   * 多会话 worker 调用方需要此功能。
   */
  reportState(state: SessionState): void
  /** PUT /worker external_metadata（仅 v2 有效，v1 为空操作） */
  reportMetadata(metadata: Record<string, unknown>): void
  /**
   * POST /worker/events/{id}/delivery（仅 v2 有效，v1 为空操作）。
   *
   * 填充 CCR 的 processing_at/processed_at 字段。
   * 'received' 由 CCRClient 在每个 SSE 帧时自动触发，此处不暴露。
   */
  reportDelivery(eventId: string, status: 'processing' | 'processed'): void
  /**
   * 关闭前刷新写队列（仅 v2 有效，v1 立即 resolve）。
   *
   * v1 的 HybridTransport POST 每次写入时已 await，无需额外 flush。
   * v2 的 SerialBatchEventUploader 内部有队列，flush() 等待所有待发送批次完成。
   */
  flush(): Promise<void>
}

/**
 * 创建 v1 ReplBridgeTransport 适配器（HybridTransport 无操作包装）。
 *
 * HybridTransport 已实现完整的 ReplBridgeTransport 接口面（继承自 WebSocketTransport），
 * 此函数仅作类型对齐的薄包装层，使 replBridge 的 `transport` 变量有统一类型。
 *
 * v1 特殊处理：
 *   - getLastSequenceNum 始终返回 0（v1 不使用 SSE 序列号，重放由服务端游标处理）
 *   - reportState / reportMetadata / reportDelivery 均为空操作
 *   - flush 直接 resolve（HybridTransport POST 每次写入时已 await）
 */
export function createV1ReplTransport(
  hybrid: HybridTransport,
): ReplBridgeTransport {
  return {
    write: msg => hybrid.write(msg),
    writeBatch: msgs => hybrid.writeBatch(msgs),
    close: () => hybrid.close(),
    isConnectedStatus: () => hybrid.isConnectedStatus(),
    getStateLabel: () => hybrid.getStateLabel(),
    setOnData: cb => hybrid.setOnData(cb),
    setOnClose: cb => hybrid.setOnClose(cb),
    setOnConnect: cb => hybrid.setOnConnect(cb),
    connect: () => void hybrid.connect(),
    // v1 Session-Ingress WS 不使用 SSE 序列号；重放语义不同。
    // 始终返回 0，使 replBridge 的序列号续传逻辑对 v1 为空操作。
    getLastSequenceNum: () => 0,
    get droppedBatchCount() {
      return hybrid.droppedBatchCount
    },
    reportState: () => {}, // v1 空操作
    reportMetadata: () => {}, // v1 空操作
    reportDelivery: () => {}, // v1 空操作
    flush: () => Promise.resolve(), // v1 POST 已 await，无需额外 flush
  }
}

/**
 * 创建 v2 ReplBridgeTransport 适配器（SSETransport + CCRClient）。
 *
 * 创建流程（含 worker 注册）：
 *   1. 认证头构建：
 *      - 若提供 getAuthToken：使用 per-instance 闭包（多会话安全）
 *      - 否则：写入 CLAUDE_CODE_SESSION_ACCESS_TOKEN 环境变量（单会话兼容路径）
 *   2. 获取 worker epoch：
 *      - 若提供 opts.epoch（来自 POST /bridge 响应）：直接使用（/bridge 调用即已注册 worker）
 *      - 否则：调用 registerWorker(sessionUrl, ingressToken) 获取 epoch
 *   3. 构建 SSE 读流 URL：{sessionUrl}/worker/events/stream
 *   4. 创建 SSETransport（含 initialSequenceNum 续传支持）
 *   5. 创建 CCRClient（含 onEpochMismatch 409 处理）
 *   6. 覆写 SSETransport.setOnEvent：同时 ACK 'received' + 'processed'
 *      （防止幽灵提示重发——daemon 重启时 reconnectSession 对未 processed 事件重新入队）
 *   7. 返回 ReplBridgeTransport 对象（connect() 调用时才建立实际连接）
 *
 * 关闭码语义：
 *   - 4090：epoch superseded（onEpochMismatch 触发）
 *   - 4091：CCRClient 初始化失败（ccr.initialize() rejected）
 *   - 4092：SSE 重连次数耗尽（sse.setOnClose 回调中 code=undefined → 映射为 4092）
 *
 * 注意：v2 认证使用 session JWT（而非 OAuth token）——
 *   JWT 携带 session_id claim 和 worker role，OAuth token 无此信息。
 *   JWT 在 poll 循环重派发工作时刷新，调用方需重新调用 createV2ReplTransport。
 */
export async function createV2ReplTransport(opts: {
  sessionUrl: string
  ingressToken: string
  sessionId: string
  /**
   * 上一个 transport 的 SSE 序列号高水位。
   * 传入 SSETransport，使新连接的第一次 connect() 携带
   * from_sequence_num / Last-Event-ID，从断点续传。
   * 若不传入，服务端会从 seq 0 重放整个会话历史。
   */
  initialSequenceNum?: number
  /**
   * 来自 POST /bridge 响应的 worker epoch。
   * 若提供：服务端已在 /bridge 调用时完成注册（参见服务端 PR #293280），直接使用。
   * 若未提供（v1 CCR v2 路径，通过 replBridge.ts poll 循环）：调用 registerWorker。
   */
  epoch?: number
  /** CCRClient 心跳间隔（毫秒）。未提供时默认 20s。 */
  heartbeatIntervalMs?: number
  /** 每次心跳的随机抖动比例（±fraction）。未提供时默认 0（无抖动）。 */
  heartbeatJitterFraction?: number
  /**
   * 为 true 时跳过 SSE 读流，仅激活 CCRClient 写路径。
   * 用于镜像模式（转发事件但不接收入站提示或控制请求）。
   */
  outboundOnly?: boolean
  /**
   * per-instance 认证头来源。若提供，CCRClient + SSETransport 从此闭包读取 token，
   * 而非进程级环境变量 CLAUDE_CODE_SESSION_ACCESS_TOKEN。
   * 多会话调用方必须提供此参数——环境变量路径在会话间相互覆盖。
   * 单会话调用方不提供时降级到环境变量。
   */
  getAuthToken?: () => string | undefined
}): Promise<ReplBridgeTransport> {
  const {
    sessionUrl,
    ingressToken,
    sessionId,
    initialSequenceNum,
    getAuthToken,
  } = opts

  // 认证头构建策略：
  //   - getAuthToken 已提供：per-instance 闭包（多会话安全，避免环境变量跨会话覆盖）
  //   - 未提供：写入进程级环境变量（单会话兼容路径）
  let getAuthHeaders: (() => Record<string, string>) | undefined
  if (getAuthToken) {
    // per-instance 认证头：从闭包读取 token，构建 Authorization 头
    getAuthHeaders = (): Record<string, string> => {
      const token = getAuthToken()
      if (!token) return {}
      return { Authorization: `Bearer ${token}` }
    }
  } else {
    // 单会话兼容路径：写入进程级 CLAUDE_CODE_SESSION_ACCESS_TOKEN 环境变量
    // CCRClient.request() 和 SSETransport.connect() 均通过 getSessionIngressAuthHeaders() 读取
    updateSessionIngressAuthToken(ingressToken)
  }

  // 获取 worker epoch：
  //   - opts.epoch 已提供（来自 /bridge 响应）：直接使用，无需再次注册
  //   - 未提供：调用 registerWorker，获取服务端分配的 epoch
  const epoch = opts.epoch ?? (await registerWorker(sessionUrl, ingressToken))
  logForDebugging(
    `[bridge:repl] CCR v2: worker sessionId=${sessionId} epoch=${epoch}${opts.epoch !== undefined ? ' (from /bridge)' : ' (via registerWorker)'}`,
  )

  // 派生 SSE 读流 URL：{sessionUrl}/worker/events/stream
  // 与 transportUtils.ts 的逻辑相同，但从 http(s) 基础 URL 出发（而非 ws:// sdk-url）
  const sseUrl = new URL(sessionUrl)
  sseUrl.pathname = sseUrl.pathname.replace(/\/$/, '') + '/worker/events/stream'

  // 创建 SSETransport（读流）
  // initialSequenceNum：断线续传的起始序列号（新连接从此处继续，避免重放历史）
  const sse = new SSETransport(
    sseUrl,
    {},
    sessionId,
    undefined,
    initialSequenceNum,
    getAuthHeaders,
  )
  let onCloseCb: ((closeCode?: number) => void) | undefined // onClose 回调暂存（setOnClose 时注册）

  // 创建 CCRClient（写路径 + 心跳）
  const ccr = new CCRClient(sse, new URL(sessionUrl), {
    getAuthHeaders,
    heartbeatIntervalMs: opts.heartbeatIntervalMs,
    heartbeatJitterFraction: opts.heartbeatJitterFraction,
    // CCRClient 默认的 onEpochMismatch 调用 process.exit(1)——在 spawn-mode 子进程中正确，
    // 但在 REPL 进程内这会直接终止整个 REPL。此处改为关闭 transport 并通知 replBridge，
    // 使 poll 循环恢复（服务端重派发工作时携带新 epoch）。
    onEpochMismatch: () => {
      logForDebugging(
        '[bridge:repl] CCR v2: epoch superseded (409) — closing for poll-loop recovery',
      )
      // 在 try 块中关闭资源，确保 throw 始终执行。
      // 若 ccr.close() 或 sse.close() 抛出异常，仍需 unwind 调用方（request()），
      // 否则 handleEpochMismatch 的 `never` 返回类型在运行时被违反，控制流穿透。
      try {
        ccr.close()
        sse.close()
        onCloseCb?.(4090) // 通知 replBridge：epoch superseded（4090）
      } catch (closeErr: unknown) {
        logForDebugging(
          `[bridge:repl] CCR v2: error during epoch-mismatch cleanup: ${errorMessage(closeErr)}`,
          { level: 'error' },
        )
      }
      // 不能 return——request() 中的 409 分支代码会在之后继续执行，
      // 调用方会看到日志警告和 false 返回值。抛出异常以 unwind；
      // uploaders 将其捕获为发送失败。
      throw new Error('epoch superseded')
    },
  })

  // 覆写 SSETransport 的 setOnEvent 回调，同时 ACK 'received' 和 'processed'。
  //
  // 背景：CCRClient 构造函数已将 sse.setOnEvent 连接到 reportDelivery('received')。
  // remoteIO.ts 额外通过 setCommandLifecycleListener 发送 'processing'/'processed'，
  // 但 replBridge/daemonBridge 的调用方没有此机制——daemon 的代理子进程是独立进程
  // （ProcessTransport），其 notifyCommandLifecycle 调用在自己模块中 listener=null 时触发。
  // 结果：事件永久停留在 'received' 状态，reconnectSession 在每次 daemon 重启时
  // 将所有未 processed 事件重新入队（观察到：第 21→24→25 次幽灵提示，
  // 以 "user sent a new message while you were working" 系统提示的形式出现）。
  //
  // 修复方案：接收时立即同时 ACK 'processed'。SSE 接收到写入 transcript 的窗口较窄
  // （队列 → SDK → 子进程 stdin → 模型），崩溃时最多丢失一次提示，
  // 优于每次重启时 N 次提示洪泛。
  // setOnEvent 是替换而非追加（SSETransport.ts:658）——覆写后旧的 'received' ACK 仍保留。
  sse.setOnEvent(event => {
    ccr.reportDelivery(event.event_id, 'received') // ACK 接收
    ccr.reportDelivery(event.event_id, 'processed') // 立即 ACK 处理完成（防幽灵提示重发）
  })

  // connect() 和 ccr.initialize() 都延迟到 connect() 调用时执行。
  // replBridge 的调用顺序是：newTransport → setOnConnect → setOnData → setOnClose → connect()
  // 两个调用都需要这些回调先注册好：
  //   sse.connect() 打开流（事件立即通过 onData/onClose 流动）
  //   ccr.initialize().then() 触发 onConnectCb
  //
  // onConnect 在 ccr.initialize() resolve 后触发。
  // 写路径通过 CCRClient HTTP POST（SerialBatchEventUploader），而非 SSE，
  // 因此写路径在 workerEpoch 设置后立即就绪，无需等待 SSE 连接建立。
  // SSE 流并行打开（约 30ms 延迟），通过 setOnData 开始传递入站事件；
  // 出站写入不需要等待 SSE 就绪。
  let onConnectCb: (() => void) | undefined
  let ccrInitialized = false // CCRClient 是否初始化完成（控制 isConnectedStatus 返回值）
  let closed = false // 是否已关闭（防止 writeBatch 在 teardown 后发送部分批次）

  return {
    write(msg) {
      // 通过 CCRClient 写事件（→ SerialBatchEventUploader → POST /worker/events）
      return ccr.writeEvent(msg)
    },
    async writeBatch(msgs) {
      // SerialBatchEventUploader 内部已批量处理（maxBatchSize=100）；
      // 顺序入队保证消息顺序，uploader 自动合并。
      // 在写入之间检查 closed，避免 transport teardown（epoch mismatch、SSE 枯竭）后
      // 发送部分批次。
      for (const m of msgs) {
        if (closed) break // transport 已关闭，停止发送
        await ccr.writeEvent(m)
      }
    },
    close() {
      closed = true // 标记为已关闭，防止后续 writeBatch 操作
      ccr.close() // 停止心跳，关闭写路径
      sse.close() // 关闭 SSE 读流
    },
    isConnectedStatus() {
      // 检查写就绪状态（而非读就绪）——replBridge 在调用 writeBatch 前检查此值。
      // SSE 的打开状态与写就绪正交（可以写但还没有读流）。
      return ccrInitialized
    },
    getStateLabel() {
      // SSETransport 不暴露状态字符串；从可观测状态合成。
      // replBridge 仅将此用于调试日志。
      if (sse.isClosedStatus()) return 'closed'
      if (sse.isConnectedStatus()) return ccrInitialized ? 'connected' : 'init'
      return 'connecting'
    },
    setOnData(cb) {
      // 透传到 SSETransport 的 setOnData（入站事件处理）
      sse.setOnData(cb)
    },
    setOnClose(cb) {
      onCloseCb = cb // 保存回调供 onEpochMismatch 使用
      // SSE 重连预算耗尽触发 onClose(undefined)——映射到 4092，
      // 使 ws_closed 遥测可区分于 HTTP 状态关闭（SSETransport:280 传入 response.status）。
      // 在通知 replBridge 前停止 CCRClient 的心跳定时器。
      // （sse.close() 不会调用此回调，epoch-mismatch 路径不会重复触发。）
      sse.setOnClose(code => {
        ccr.close() // 停止心跳
        cb(code ?? 4092) // SSE 重连耗尽映射为 4092
      })
    },
    setOnConnect(cb) {
      onConnectCb = cb // 保存回调，ccr.initialize() resolve 后调用
    },
    getLastSequenceNum() {
      // 从 SSETransport 获取最新 SSE 事件序列号（用于断线续传）
      return sse.getLastSequenceNum()
    },
    // v2 写路径（CCRClient）不设置 maxConsecutiveFailures，不会静默丢弃批次
    droppedBatchCount: 0,
    reportState(state) {
      ccr.reportState(state) // PUT /worker state（告知后端会话状态）
    },
    reportMetadata(metadata) {
      ccr.reportMetadata(metadata) // PUT /worker external_metadata
    },
    reportDelivery(eventId, status) {
      ccr.reportDelivery(eventId, status) // POST /worker/events/{id}/delivery
    },
    flush() {
      return ccr.flush() // 等待所有待发送批次完成
    },
    connect() {
      // outboundOnly 模式：跳过 SSE 读流（镜像模式，只需写路径和心跳）
      if (!opts.outboundOnly) {
        // Fire-and-forget：SSETransport.connect() 等待 readStream()（读循环），
        // 仅在流关闭/错误时 resolve。
        // spawn-mode 的 remoteIO.ts 采用同样的 void 丢弃方式。
        void sse.connect()
      }
      // 初始化 CCRClient：设置 workerEpoch，启动心跳，就绪后触发 onConnectCb
      void ccr.initialize(epoch).then(
        () => {
          ccrInitialized = true // 标记写路径就绪
          logForDebugging(
            `[bridge:repl] v2 transport ready for writes (epoch=${epoch}, sse=${sse.isConnectedStatus() ? 'open' : 'opening'})`,
          )
          onConnectCb?.() // 通知 replBridge：transport 连接就绪
        },
        (err: unknown) => {
          // ccr.initialize() 失败（如 HTTP 错误、网络超时）
          logForDebugging(
            `[bridge:repl] CCR v2 initialize failed: ${errorMessage(err)}`,
            { level: 'error' },
          )
          // 关闭 transport 资源并通过 onClose 通知 replBridge，
          // 使 poll 循环在下次工作派发时重试。
          // 若不触发此回调，replBridge 永远不知道 transport 初始化失败，
          // transport 变量将永久停留在 null。
          ccr.close()
          sse.close()
          onCloseCb?.(4091) // 4091 = 初始化失败（与 4090 epoch superseded 可区分）
        },
      )
    },
  }
}
