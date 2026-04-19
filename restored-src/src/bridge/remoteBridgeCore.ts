// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
/**
 * remoteBridgeCore.ts — 无环境层（env-less）Remote Control Bridge 核心
 *
 * 在 Claude Code 系统流程中的位置：
 *   REPL Bridge 层
 *     └─> initReplBridge.ts（门控判断后动态导入本文件）
 *           └─> remoteBridgeCore.ts（本文件）
 *                 ├─> codeSessionApi.ts（createCodeSession / fetchRemoteCredentials）
 *                 ├─> replBridgeTransport.ts（createV2ReplTransport）
 *                 ├─> jwtUtils.ts（createTokenRefreshScheduler）
 *                 └─> bridgeMessaging.ts（handleIngressMessage / BoundedUUIDSet / FlushGate）
 *
 * 设计说明（"env-less" vs "CCR v2"）：
 *   "env-less" = 无 Environments API 层。与 "CCR v2"（/worker/* 传输协议）是不同的概念：
 *   env-based 路径（replBridge.ts）也可以通过 CLAUDE_CODE_USE_CCR_V2 使用 CCR v2 传输。
 *   本文件解决的是"移除 poll/dispatch 层"，而非改变传输协议版本。
 *
 * 完整初始化流程（与 initBridgeCore ~2400 行的 env-based 路径相比大幅简化）：
 *   1. POST /v1/code/sessions（OAuth，无 env_id）              → session.id（cse_*）
 *   2. POST /v1/code/sessions/{id}/bridge（OAuth）             → {worker_jwt, expires_in, api_base_url, worker_epoch}
 *      每次 /bridge 调用都会在服务端 bump epoch——/bridge 本身即是注册，无需单独 /worker/register。
 *   3. createV2ReplTransport(worker_jwt, worker_epoch)         → SSETransport + CCRClient
 *   4. createTokenRefreshScheduler                             → 主动 /bridge 重调用（JWT + epoch 均刷新）
 *   5. SSE 401 → rebuildTransport（相同 seq-num，OAuth 刷新 + /bridge 重调用）
 *
 *   无 register/poll/ack/stop/heartbeat/deregister 环境生命周期。
 *
 * 历史背景：
 *   Environments API 历史上存在的原因是 CCR 的 /worker/* 端点需要带 session_id+role=worker
 *   的 JWT，只有 work-dispatch 层才能铸造。服务端 PR #292605（在 #293280 中重命名）增加了
 *   /bridge 端点作为 OAuth→worker_jwt 的直接兑换，使 env 层对 REPL 会话变为可选。
 *
 * 门控：
 *   由 initReplBridge.ts 中的 `tengu_bridge_repl_v2` GrowthBook flag 门控。
 *   仅限 REPL——daemon/print 保持 env-based。
 */

import { feature } from 'bun:bundle'
import axios from 'axios'
import {
  createV2ReplTransport,
  type ReplBridgeTransport,
} from './replBridgeTransport.js'
import { buildCCRv2SdkUrl } from './workSecret.js'
import { toCompatSessionId } from './sessionIdCompat.js'
import { FlushGate } from './flushGate.js'
import { createTokenRefreshScheduler } from './jwtUtils.js'
import { getTrustedDeviceToken } from './trustedDevice.js'
import {
  getEnvLessBridgeConfig,
  type EnvLessBridgeConfig,
} from './envLessBridgeConfig.js'
import {
  handleIngressMessage,
  handleServerControlRequest,
  makeResultMessage,
  isEligibleBridgeMessage,
  extractTitleText,
  BoundedUUIDSet,
} from './bridgeMessaging.js'
import { logBridgeSkip } from './debugUtils.js'
import { logForDebugging } from '../utils/debug.js'
import { logForDiagnosticsNoPII } from '../utils/diagLogs.js'
import { isInProtectedNamespace } from '../utils/envUtils.js'
import { errorMessage } from '../utils/errors.js'
import { sleep } from '../utils/sleep.js'
import { registerCleanup } from '../utils/cleanupRegistry.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../services/analytics/index.js'
import type { ReplBridgeHandle, BridgeState } from './replBridge.js'
import type { Message } from '../types/message.js'
import type { SDKMessage } from '../entrypoints/agentSdkTypes.js'
import type {
  SDKControlRequest,
  SDKControlResponse,
} from '../entrypoints/sdk/controlTypes.js'
import type { PermissionMode } from '../utils/permissions/PermissionMode.js'

/** Anthropic API 版本标识，用于所有 HTTP 请求头 */
const ANTHROPIC_VERSION = '2023-06-01'

/**
 * ConnectCause — 连接原因区分器（用于遥测区分初次连接与重建原因）。
 *
 * - 'initial'：首次连接（默认值，initEnvLessBridgeCore 闭包初始值）
 * - 'proactive_refresh'：JWT 主动刷新定时器触发
 * - 'auth_401_recovery'：SSE 401 错误后的恢复重建
 *
 * Exclude<ConnectCause, 'initial'> 用于 rebuildTransport 签名，
 * 在类型层面确保初次连接不会传入 rebuildTransport。
 */
type ConnectCause = 'initial' | 'proactive_refresh' | 'auth_401_recovery'

/**
 * oauthHeaders — 构建标准 OAuth 请求头对象。
 * 所有发往 Bridge API 的 HTTP 请求均使用此函数构建基础请求头。
 */
function oauthHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    'anthropic-version': ANTHROPIC_VERSION,
  }
}

/**
 * EnvLessBridgeParams — initEnvLessBridgeCore 的参数类型
 *
 * 包含：
 *   - 基础连接参数（baseUrl、orgUUID、title、getAccessToken）
 *   - OAuth 401 恢复回调（onAuth401）
 *   - 消息转换器注入（toSDKMessages——注入而非导入，避免拉入 commands.ts 重型依赖链）
 *   - 初始历史上限和初始消息列表
 *   - 所有事件回调（onInboundMessage、onUserMessage、onPermissionResponse 等）
 *   - outboundOnly 标志（CCR mirror mode，仅出站，跳过 SSE 入站流）
 *   - tags 会话分类标签
 */
export type EnvLessBridgeParams = {
  baseUrl: string
  orgUUID: string
  title: string
  getAccessToken: () => string | undefined
  onAuth401?: (staleAccessToken: string) => Promise<boolean>
  /**
   * 内部 Message[] → SDKMessage[] 转换函数。
   * 注入而非导入——mappers.ts 传递依赖整个命令注册表 + React 树，
   * 不含 mappers.ts 的 bundle 不应因此膨胀。
   */
  toSDKMessages: (messages: Message[]) => SDKMessage[]
  initialHistoryCap: number
  initialMessages?: Message[]
  onInboundMessage?: (msg: SDKMessage) => void | Promise<void>
  /**
   * 每条标题值得关注的用户消息触发，直到回调返回 true（派生完成）。
   * 镜像 replBridge.ts 的 onUserMessage——调用方派生标题并 PATCH /v1/sessions/{id}。
   * 调用方拥有 count-1-and-3 策略；传输层持续调用直到被告知停止。
   * sessionId 为原始 cse_*——updateBridgeSessionTitle 内部重新打标签。
   */
  onUserMessage?: (text: string, sessionId: string) => boolean
  onPermissionResponse?: (response: SDKControlResponse) => void
  onInterrupt?: () => void
  onSetModel?: (model: string | undefined) => void
  onSetMaxThinkingTokens?: (maxTokens: number | null) => void
  onSetPermissionMode?: (
    mode: PermissionMode,
  ) => { ok: true } | { ok: false; error: string }
  onStateChange?: (state: BridgeState, detail?: string) => void
  /**
   * 为 true 时，跳过打开 SSE 读流——仅激活 CCRClient 写路径。
   * 传递给 createV2ReplTransport 和 handleServerControlRequest。
   */
  outboundOnly?: boolean
  /** 会话分类标签（如 ['ccr-mirror']）。 */
  tags?: string[]
}

/**
 * initEnvLessBridgeCore — env-less Bridge 核心初始化函数。
 *
 * 完整初始化流程（10 个阶段）：
 *   1. 获取 OAuth token → 无 token 立即返回 null
 *   2. createCodeSession → POST /v1/code/sessions → session.id（cse_*）
 *   3. fetchRemoteCredentials → POST /bridge → {worker_jwt, expires_in, worker_epoch}
 *   4. createV2ReplTransport → 建立 SSETransport + CCRClient（v2 传输层）
 *   5. 初始化状态变量（UUID 去重集合、FlushGate、标志位）
 *   6. createTokenRefreshScheduler → 主动 JWT 预刷新调度器（expires_in - buffer）
 *   7. wireTransportCallbacks → 绑定 onConnect/onData/onClose
 *   8. transport.connect() + 连接超时检测
 *   9. teardown → SIGINT/SIGTERM 清理（archive + transport.close + 遥测）
 *   10. 返回 ReplBridgeHandle（writeMessages/writeSdkMessages/sendControlRequest 等方法）
 *
 * @returns ReplBridgeHandle（成功）或 null（任意预检失败）
 */
export async function initEnvLessBridgeCore(
  params: EnvLessBridgeParams,
): Promise<ReplBridgeHandle | null> {
  const {
    baseUrl,
    orgUUID,
    title,
    getAccessToken,
    onAuth401,
    toSDKMessages,
    initialHistoryCap,
    initialMessages,
    onInboundMessage,
    onUserMessage,
    onPermissionResponse,
    onInterrupt,
    onSetModel,
    onSetMaxThinkingTokens,
    onSetPermissionMode,
    onStateChange,
    outboundOnly,
    tags,
  } = params

  // 读取 env-less bridge 配置（超时、重试、心跳间隔等，来自 GrowthBook 或默认值）
  const cfg = await getEnvLessBridgeConfig()

  // ── 阶段 1：创建 code session（POST /v1/code/sessions，无 env_id）──────
  const accessToken = getAccessToken()
  if (!accessToken) {
    logForDebugging('[remote-bridge] No OAuth token')
    return null
  }

  // 带重试的 session 创建（指数退避 + 抖动，最多 cfg.init_retry_max_attempts 次）
  const createdSessionId = await withRetry(
    () =>
      createCodeSession(baseUrl, accessToken, title, cfg.http_timeout_ms, tags),
    'createCodeSession',
    cfg,
  )
  if (!createdSessionId) {
    onStateChange?.('failed', 'Session creation failed — see debug log')
    logBridgeSkip('v2_session_create_failed', undefined, true)
    return null
  }
  const sessionId: string = createdSessionId
  logForDebugging(`[remote-bridge] Created session ${sessionId}`)
  logForDiagnosticsNoPII('info', 'bridge_repl_v2_session_created')

  // ── 阶段 2：获取 bridge 凭据（POST /bridge → worker_jwt, expires_in, api_base_url）──
  // 每次 /bridge 调用都在服务端 bump epoch——/bridge 本身即是 worker 注册
  const credentials = await withRetry(
    () =>
      fetchRemoteCredentials(
        sessionId,
        baseUrl,
        accessToken,
        cfg.http_timeout_ms,
      ),
    'fetchRemoteCredentials',
    cfg,
  )
  if (!credentials) {
    onStateChange?.('failed', 'Remote credentials fetch failed — see debug log')
    logBridgeSkip('v2_remote_creds_failed', undefined, true)
    // 凭据获取失败时 archive session（避免 CCR 中遗留僵尸会话）
    void archiveSession(
      sessionId,
      baseUrl,
      accessToken,
      orgUUID,
      cfg.http_timeout_ms,
    )
    return null
  }
  logForDebugging(
    `[remote-bridge] Fetched bridge credentials (expires_in=${credentials.expires_in}s)`,
  )

  // ── 阶段 3：建立 v2 传输层（SSETransport + CCRClient）──────────────────
  const sessionUrl = buildCCRv2SdkUrl(credentials.api_base_url, sessionId)
  logForDebugging(`[remote-bridge] v2 session URL: ${sessionUrl}`)

  let transport: ReplBridgeTransport
  try {
    transport = await createV2ReplTransport({
      sessionUrl,
      ingressToken: credentials.worker_jwt,
      sessionId,
      epoch: credentials.worker_epoch, // 当前 epoch（来自 /bridge 响应）
      heartbeatIntervalMs: cfg.heartbeat_interval_ms,
      heartbeatJitterFraction: cfg.heartbeat_jitter_fraction,
      // 逐实例闭包——将 worker JWT 隔离在 process.env 之外，
      // 避免 mcp/client.ts 未门控地读取并发送到用户配置的 ws/http MCP 服务器。
      // 构造时固化是正确的：transport 在 rebuildTransport 时完整重建。
      getAuthToken: () => credentials.worker_jwt,
      outboundOnly,
    })
  } catch (err) {
    logForDebugging(
      `[remote-bridge] v2 transport setup failed: ${errorMessage(err)}`,
      { level: 'error' },
    )
    onStateChange?.('failed', `Transport setup failed: ${errorMessage(err)}`)
    logBridgeSkip('v2_transport_setup_failed', undefined, true)
    void archiveSession(
      sessionId,
      baseUrl,
      accessToken,
      orgUUID,
      cfg.http_timeout_ms,
    )
    return null
  }
  logForDebugging(
    `[remote-bridge] v2 transport created (epoch=${credentials.worker_epoch})`,
  )
  onStateChange?.('ready')

  // ── 阶段 4：初始化状态变量 ──────────────────────────────────────────────

  // Echo 去重：我们 POST 的消息会在读流中回声。
  // 用初始消息 UUID 播种，使服务端对已 flush 历史的 echo 被识别。
  // recentPostedUUIDs（2000 容量环形缓冲区）可在大量写入后淘汰；
  // initialMessageUUIDs（无界集合）作为后备防御——镜像 replBridge.ts 的双重防御。
  const recentPostedUUIDs = new BoundedUUIDSet(cfg.uuid_dedup_buffer_size)
  const initialMessageUUIDs = new Set<string>() // 无界初始 UUID 集合
  if (initialMessages) {
    for (const msg of initialMessages) {
      initialMessageUUIDs.add(msg.uuid) // 播种初始消息 UUID
      recentPostedUUIDs.add(msg.uuid)
    }
  }

  // 防御性去重（入站消息）：处理 seq-num 协商边缘情况和传输切换后的服务端历史重放
  const recentInboundUUIDs = new BoundedUUIDSet(cfg.uuid_dedup_buffer_size)

  // FlushGate：历史 flush POST 进行中时，排队 live 写入，
  // 确保服务端按 [history..., live...] 顺序接收。
  const flushGate = new FlushGate<Message>()

  let initialFlushDone = false // 初始历史 flush 是否已完成
  let tornDown = false // teardown 是否已触发
  let authRecoveryInFlight = false // 是否有 auth 恢复正在进行中
  // onUserMessage 的锁存标志——当回调返回 true（策略说"完成派生"）时翻转
  // sessionId 是常量（无重建路径——rebuildTransport 仅交换 JWT/epoch），不需要重置
  let userMessageCallbackDone = !onUserMessage

  // 遥测：onConnect 触发的原因。
  // 在 wireTransportCallbacks 之前由 rebuildTransport 设置；由 onConnect 异步读取。
  // 竞争安全：authRecoveryInFlight 序列化重建调用者；新的 initEnvLessBridgeCore 调用
  // 获取新的闭包，默认为 'initial'。
  let connectCause: ConnectCause = 'initial'

  // transport.connect() 后的 onConnect 截止时间。
  // 由 onConnect（已连接）和 onClose（收到关闭信号——非静默）清除。
  // 若两者都未在 cfg.connect_timeout_ms 内触发，onConnectTimeout 发出事件——
  // 这是 `started → (静默)` 间隙的唯一信号。
  let connectDeadline: ReturnType<typeof setTimeout> | undefined

  /**
   * onConnectTimeout — 连接超时事件发送器。
   * 仅发送遥测事件，不进行重连（超时本身不是终止条件）。
   */
  function onConnectTimeout(cause: ConnectCause): void {
    if (tornDown) return
    logEvent('tengu_bridge_repl_connect_timeout', {
      v2: true,
      elapsed_ms: cfg.connect_timeout_ms,
      cause:
        cause as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
  }

  // ── 阶段 5：JWT 刷新调度器 ──────────────────────────────────────────────
  // 在到期前 5 分钟调度回调（基于 response.expires_in）。
  // 触发时：重新获取 /bridge（OAuth）→ 用新凭据重建传输层。
  // 每次 /bridge 调用都在服务端 bump epoch，因此仅交换 JWT 而不重建 transport
  // 会让旧 CCRClient 以过期 epoch 发心跳 → 20 秒内 409。
  // JWT 是不透明的——不要解码。
  const refresh = createTokenRefreshScheduler({
    refreshBufferMs: cfg.token_refresh_buffer_ms,
    getAccessToken: async () => {
      // 无条件在调用 /bridge 之前刷新 OAuth——getAccessToken() 会以非 null 字符串
      // 返回过期 token（不检查 expiresAt），因此真值不代表有效。
      // 将过期 token 传给 onAuth401，以便 handleOAuth401Error 的 keychain 比较
      // 能检测到并行刷新。
      const stale = getAccessToken()
      if (onAuth401) await onAuth401(stale ?? '')
      return getAccessToken() ?? stale
    },
    onRefresh: (sid, oauthToken) => {
      void (async () => {
        // 笔记本唤醒：过期的主动定时器 + SSE 401 几乎同时触发。
        // 在 /bridge 请求之前同步声明标志，使另一条路径完全跳过——
        // 防止双重 epoch bump（每次 /bridge 都 bump；若两者都获取，
        // 第一次重建得到过期 epoch 并 409）。
        if (authRecoveryInFlight || tornDown) {
          logForDebugging(
            '[remote-bridge] Recovery already in flight, skipping proactive refresh',
          )
          return
        }
        authRecoveryInFlight = true // 声明标志（同步，在任何 await 之前）
        try {
          const fresh = await withRetry(
            () =>
              fetchRemoteCredentials(
                sid,
                baseUrl,
                oauthToken,
                cfg.http_timeout_ms,
              ),
            'fetchRemoteCredentials (proactive)',
            cfg,
          )
          if (!fresh || tornDown) return
          await rebuildTransport(fresh, 'proactive_refresh')
          logForDebugging(
            '[remote-bridge] Transport rebuilt (proactive refresh)',
          )
        } catch (err) {
          logForDebugging(
            `[remote-bridge] Proactive refresh rebuild failed: ${errorMessage(err)}`,
            { level: 'error' },
          )
          logForDiagnosticsNoPII(
            'error',
            'bridge_repl_v2_proactive_refresh_failed',
          )
          if (!tornDown) {
            onStateChange?.('failed', `Refresh failed: ${errorMessage(err)}`)
          }
        } finally {
          authRecoveryInFlight = false // 无论成功/失败，最终释放标志
        }
      })()
    },
    label: 'remote',
  })
  // 根据初始凭据的 expires_in 调度首次刷新
  refresh.scheduleFromExpiresIn(sessionId, credentials.expires_in)

  // ── 阶段 6：绑定传输层回调（提取为函数，transport 重建时可重新绑定）──────
  /**
   * wireTransportCallbacks — 绑定 onConnect/onData/onClose 到当前 transport。
   *
   * 提取为独立函数的原因：transport 重建（proactive refresh / 401 recovery）
   * 时需要重新绑定到新的 transport 实例。
   *
   * onConnect：清除连接超时、发遥测、触发历史 flush 或 drainFlushGate
   * onData：转发入站消息到 handleIngressMessage（去重 + 路由到回调）
   * onClose：处理终端失败（401 恢复、4090 epoch 不匹配、4091 初始化失败、SSE 枯竭）
   */
  function wireTransportCallbacks(): void {
    transport.setOnConnect(() => {
      clearTimeout(connectDeadline) // 连接成功，清除超时
      logForDebugging('[remote-bridge] v2 transport connected')
      logForDiagnosticsNoPII('info', 'bridge_repl_v2_transport_connected')
      logEvent('tengu_bridge_repl_ws_connected', {
        v2: true,
        cause:
          connectCause as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })

      if (!initialFlushDone && initialMessages && initialMessages.length > 0) {
        initialFlushDone = true
        // 捕获当前 transport——若 401/teardown 在 flush 进行中触发，
        // 过期的 .finally() 不应排空 gate 或发出 connected 信号。
        // （与 replBridge.ts:1119 相同的守卫模式。）
        const flushTransport = transport
        void flushHistory(initialMessages)
          .catch(e =>
            logForDebugging(`[remote-bridge] flushHistory failed: ${e}`),
          )
          .finally(() => {
            // authRecoveryInFlight 捕获 v1 vs v2 的不对称性：
            // v1 在 setOnClose 中同步 null transport（replBridge.ts:1175），
            // 所以 transport !== flushTransport 立即触发。
            // v2 不 null——transport 仅在 rebuildTransport:346（3 个 await 深）重新赋值。
            // authRecoveryInFlight 在 rebuildTransport 入口同步设置。
            if (
              transport !== flushTransport || // v1 兼容守卫
              tornDown || // teardown 已触发
              authRecoveryInFlight // 401 恢复正在进行
            ) {
              return
            }
            drainFlushGate() // 排空在 flush 期间积压的消息
            onStateChange?.('connected')
          })
      } else if (!flushGate.active) {
        // 无历史 flush 或 gate 未激活——直接通知 connected
        onStateChange?.('connected')
      }
    })

    transport.setOnData((data: string) => {
      // 处理入站消息：去重 + 路由（用户消息 / 权限应答 / 服务端控制请求）
      handleIngressMessage(
        data,
        recentPostedUUIDs,
        recentInboundUUIDs,
        onInboundMessage,
        // 远端客户端回答了权限提示——turn 继续。
        // 否则服务端会停在 requires_action 状态直到下一条用户消息或 turn 结束。
        onPermissionResponse
          ? res => {
              transport.reportState('running') // 权限应答后恢复 running 状态
              onPermissionResponse(res)
            }
          : undefined,
        req =>
          handleServerControlRequest(req, {
            transport,
            sessionId,
            onInterrupt,
            onSetModel,
            onSetMaxThinkingTokens,
            onSetPermissionMode,
            outboundOnly,
          }),
      )
    })

    transport.setOnClose((code?: number) => {
      clearTimeout(connectDeadline) // 关闭时清除超时
      if (tornDown) return
      logForDebugging(`[remote-bridge] v2 transport closed (code=${code})`)
      logEvent('tengu_bridge_repl_ws_closed', { code, v2: true })
      // onClose 仅对终端失败触发：
      //   401（JWT 无效）、4090（CCR epoch 不匹配）、4091（CCR 初始化失败）、
      //   或 SSE 10 分钟重连预算耗尽。
      // 瞬态断连在 SSETransport 内部透明处理。
      // 401 可恢复（获取新 JWT，重建 transport）；其他代码是死胡同。
      if (code === 401 && !authRecoveryInFlight) {
        void recoverFromAuthFailure() // 异步 401 恢复
        return
      }
      onStateChange?.('failed', `Transport closed (code ${code})`)
    })
  }

  // ── 阶段 7：Transport 重建（proactive refresh + 401 recovery 共用）────────
  // 每次 /bridge 调用都在服务端 bump epoch。两条刷新路径都必须
  // 用新 epoch 重建 transport——仅交换 JWT 会让旧 CCRClient 以过期 epoch 发心跳 → 409。
  // SSE 从旧 transport 的高水位 seq-num 继续，避免服务端重放。
  //
  // 调用方在调用此函数之前必须同步（在任何 await 之前）设置 authRecoveryInFlight = true，
  // 并在 finally 中清除。此函数不管理该标志——移到这里会太晚，无法防止双重 /bridge 获取
  // （每次获取都 bump epoch）。
  /**
   * rebuildTransport — 用新凭据重建 v2 传输层。
   *
   * 流程：
   *   1. flushGate.start()——重建期间排队所有写入（避免消息静默丢失）
   *   2. transport.close()——关闭旧 transport
   *   3. createV2ReplTransport——创建新 transport（继承旧 seq-num）
   *   4. wireTransportCallbacks()——重新绑定回调
   *   5. transport.connect() + 重置超时定时器
   *   6. refresh.scheduleFromExpiresIn——重新调度 JWT 刷新
   *   7. drainFlushGate()——排空积压消息到新 uploader
   *   8. flushGate.drop()（finally）——失败路径也释放 gate（已积压消息丢弃）
   */
  async function rebuildTransport(
    fresh: RemoteCredentials,
    cause: Exclude<ConnectCause, 'initial'>,
  ): Promise<void> {
    connectCause = cause
    // 重建期间排队写入——/bridge 返回后旧 transport 的 epoch 已过期，
    // 下一次写入/心跳会 409。若不加 gate，writeMessages 会将 UUID 加入
    // recentPostedUUIDs 然后 writeBatch 静默失败（uploader 在 409 后关闭）
    // → 永久静默消息丢失。
    flushGate.start()
    try {
      const seq = transport.getLastSequenceNum() // 继承旧 transport 的高水位 seq-num
      transport.close() // 关闭旧 transport
      transport = await createV2ReplTransport({
        sessionUrl: buildCCRv2SdkUrl(fresh.api_base_url, sessionId),
        ingressToken: fresh.worker_jwt,
        sessionId,
        epoch: fresh.worker_epoch, // 新 epoch
        heartbeatIntervalMs: cfg.heartbeat_interval_ms,
        heartbeatJitterFraction: cfg.heartbeat_jitter_fraction,
        initialSequenceNum: seq, // 从旧 transport 高水位恢复，避免服务端重放
        getAuthToken: () => fresh.worker_jwt,
        outboundOnly,
      })
      if (tornDown) {
        // teardown 在 createV2ReplTransport 异步窗口内触发。
        // 不绑定/连接/调度——否则会在 cancelAll() 之后重新武装定时器，
        // 并在 torn-down 的 bridge 中触发 onInboundMessage。
        transport.close()
        return
      }
      wireTransportCallbacks() // 重新绑定回调
      transport.connect()
      connectDeadline = setTimeout(
        onConnectTimeout,
        cfg.connect_timeout_ms,
        connectCause,
      )
      refresh.scheduleFromExpiresIn(sessionId, fresh.expires_in) // 重新调度 JWT 刷新
      // 排空积压消息到新 uploader。
      // 在 ccr.initialize() 解析之前运行（transport.connect() 是 fire-and-forget），
      // 但 uploader 在初始 PUT /worker 后串行化。
      // 若初始化失败（4091），事件丢弃——但只有 recentPostedUUIDs（per-instance）被填充，
      // 重新启用 bridge 会重新 flush。
      drainFlushGate()
    } finally {
      // 失败路径也释放 gate（drainFlushGate 在成功路径上已释放）。
      // 已排队消息被丢弃（transport 仍然失效）。
      flushGate.drop()
    }
  }

  // ── 阶段 8：401 恢复（OAuth 刷新 + 重建）──────────────────────────────
  /**
   * recoverFromAuthFailure — 处理 SSE 401 错误，尝试 OAuth 刷新 + transport 重建。
   *
   * 流程：
   *   1. 同步声明 authRecoveryInFlight（在任何 await 之前）
   *   2. 调用 onAuth401（清除 keychain 缓存 + 强制刷新 OAuth）
   *   3. withRetry(fetchRemoteCredentials) 获取新凭据
   *   4. 若 401 中断了初始 flush，重置 initialFlushDone 使新 onConnect 重新 flush
   *   5. rebuildTransport(fresh, 'auth_401_recovery')
   *   6. finally 释放 authRecoveryInFlight
   */
  async function recoverFromAuthFailure(): Promise<void> {
    // setOnClose 已守卫 `!authRecoveryInFlight`，但该检查与 onRefresh 之间必须原子——
    // 在任何 await 之前同步声明。笔记本唤醒时两条路径几乎同时触发。
    if (authRecoveryInFlight) return
    authRecoveryInFlight = true // 同步声明（在任何 await 之前）
    onStateChange?.('reconnecting', 'JWT expired — refreshing')
    logForDebugging('[remote-bridge] 401 on SSE — attempting JWT refresh')
    try {
      // 无条件尝试 OAuth 刷新——getAccessToken() 会以非 null 字符串返回过期 token，
      // !oauthToken 无法捕获过期。
      // 传入过期 token 以便 handleOAuth401Error 的 keychain 比较能检测另一个标签页是否已刷新。
      const stale = getAccessToken()
      if (onAuth401) await onAuth401(stale ?? '')
      const oauthToken = getAccessToken() ?? stale
      if (!oauthToken || tornDown) {
        if (!tornDown) {
          onStateChange?.('failed', 'JWT refresh failed: no OAuth token')
        }
        return
      }

      const fresh = await withRetry(
        () =>
          fetchRemoteCredentials(
            sessionId,
            baseUrl,
            oauthToken,
            cfg.http_timeout_ms,
          ),
        'fetchRemoteCredentials (recovery)',
        cfg,
      )
      if (!fresh || tornDown) {
        if (!tornDown) {
          onStateChange?.('failed', 'JWT refresh failed after 401')
        }
        return
      }
      // 若 401 中断了初始 flush，writeBatch 可能已在关闭的 uploader 上静默 no-op
      // （ccr.close() 在 SSE 包装器中的 setOnClose 回调之前运行）。
      // 重置以使新 onConnect 重新 flush。
      // （v1 在 replBridge.ts:1027 的 per-transport 闭包中限定 initialFlushDone，
      // 因此自然重置；v2 在外部作用域。）
      initialFlushDone = false
      await rebuildTransport(fresh, 'auth_401_recovery')
      logForDebugging('[remote-bridge] Transport rebuilt after 401')
    } catch (err) {
      logForDebugging(
        `[remote-bridge] 401 recovery failed: ${errorMessage(err)}`,
        { level: 'error' },
      )
      logForDiagnosticsNoPII('error', 'bridge_repl_v2_jwt_refresh_failed')
      if (!tornDown) {
        onStateChange?.('failed', `JWT refresh failed: ${errorMessage(err)}`)
      }
    } finally {
      authRecoveryInFlight = false // 无论成功/失败，最终释放标志
    }
  }

  // 绑定初始回调
  wireTransportCallbacks()

  // 在 connect 之前启动 flushGate，使握手期间的 writeMessages() 排队而非与历史 POST 竞争
  if (initialMessages && initialMessages.length > 0) {
    flushGate.start()
  }
  transport.connect()
  connectDeadline = setTimeout(
    onConnectTimeout,
    cfg.connect_timeout_ms,
    connectCause,
  )

  // ── 历史 flush + drain 辅助函数 ─────────────────────────────────────────

  /**
   * drainFlushGate — 释放 FlushGate，将积压消息写入当前 transport。
   *
   * 在历史 flush POST 完成后（flushHistory 的 .finally()）或
   * transport 重建后（rebuildTransport）调用。
   * 若积压消息中有用户消息，推送 running 状态到 CCR。
   */
  function drainFlushGate(): void {
    const msgs = flushGate.end() // 释放 gate，获取积压消息列表
    if (msgs.length === 0) return
    for (const msg of msgs) recentPostedUUIDs.add(msg.uuid) // 记录已发送 UUID
    const events = toSDKMessages(msgs).map(m => ({
      ...m,
      session_id: sessionId,
    }))
    if (msgs.some(m => m.type === 'user')) {
      transport.reportState('running') // 有用户消息，标记 running
    }
    logForDebugging(
      `[remote-bridge] Drained ${msgs.length} queued message(s) after flush`,
    )
    void transport.writeBatch(events)
  }

  /**
   * flushHistory — 将初始历史消息批量写入 transport（历史 flush）。
   *
   * 过滤逻辑：
   *   - isEligibleBridgeMessage 过滤不符合条件的消息类型
   *   - initialHistoryCap 限制最大条数（从末尾取，保留最新历史）
   *   - 无 previouslyFlushedUUIDs 过滤（v2 始终创建新会话，无跨会话 UUID 碰撞风险）
   *
   * Mid-turn 初始化处理：
   *   若最后一条 eligible 消息是 user 类型（查询执行中启用 Remote Control），
   *   推送 running 状态，避免 init PUT 的 idle 卡住直到下一条 user 消息。
   */
  async function flushHistory(msgs: Message[]): Promise<void> {
    // v2 始终创建新的服务端会话（无条件的 createCodeSession）
    // ——不重用会话，无 double-post 风险。
    // 与 v1 不同，我们不通过 previouslyFlushedUUIDs 过滤：
    //   该集合在 REPL enable/disable 周期间持久化（useRef），
    //   会在 re-enable 时错误地抑制历史消息。
    const eligible = msgs.filter(isEligibleBridgeMessage)
    const capped =
      initialHistoryCap > 0 && eligible.length > initialHistoryCap
        ? eligible.slice(-initialHistoryCap) // 从末尾取，保留最新历史
        : eligible
    if (capped.length < eligible.length) {
      logForDebugging(
        `[remote-bridge] Capped initial flush: ${eligible.length} -> ${capped.length} (cap=${initialHistoryCap})`,
      )
    }
    const events = toSDKMessages(capped).map(m => ({
      ...m,
      session_id: sessionId,
    }))
    if (events.length === 0) return
    // Mid-turn 初始化：若查询正在执行时启用 Remote Control，
    // 最后一条 eligible 消息是 user 提示或 tool_result（均为 'user' 类型）。
    // 不加此推送，init PUT 的 'idle' 会卡住直到下一条 user 类型消息转发——
    // 纯文本 turn 中这种情况永远不会发生（turn 结束后只有 assistant 块流传输）。
    // 检查 eligible（cap 前），而非 capped：cap 可能截断到 user 消息，
    // 即使实际末尾消息是 assistant。
    if (eligible.at(-1)?.type === 'user') {
      transport.reportState('running')
    }
    logForDebugging(`[remote-bridge] Flushing ${events.length} history events`)
    await transport.writeBatch(events)
  }

  // ── 阶段 9：Teardown 清理 ─────────────────────────────────────────────────
  // 在 SIGINT/SIGTERM/⁠/exit 时，gracefulShutdown 将 runCleanupFunctions()
  // 与 2s 超时竞争。预算分配：
  //   - archive: teardown_archive_timeout_ms（默认 1500，上限 2000）
  //   - result 写入：fire-and-forget，archive 延迟覆盖 drain
  //   - 401 重试：仅在首次 archive 401 时，共享同一预算
  /**
   * teardown — 清理所有资源并归档 bridge 会话。
   *
   * 执行顺序（顺序至关重要）：
   *   1. 设置 tornDown 标志，防止重入
   *   2. cancelAll（JWT 刷新调度器）+ clearTimeout（连接超时）+ flushGate.drop
   *   3. transport.reportState('idle') + write(makeResultMessage)——在 archive 之前写
   *      （archive 延迟为 uploader drain 提供时间窗口，close 后 drain 中断）
   *   4. archiveSession（带超时）
   *   5. 若 archive 401 → onAuth401 + 重试一次
   *   6. transport.close()
   *   7. 发送遥测事件（tengu_bridge_repl_teardown 或 tengu_ccr_mirror_teardown）
   */
  async function teardown(): Promise<void> {
    if (tornDown) return
    tornDown = true
    refresh.cancelAll() // 取消所有 JWT 刷新定时器
    clearTimeout(connectDeadline)
    flushGate.drop() // 丢弃积压消息（teardown 中不再发送）

    // 在 archive 之前写 result 消息——transport.write() 仅 await enqueue
    // （SerialBatchEventUploader 一旦入缓冲区即 resolve，drain 是异步的）。
    // archiving 在 close() 之前执行，给 uploader 的 drain 循环时间窗口（约 100-500ms）
    // 来 POST result，无需显式 sleep。
    // close() 设置 closed=true，在下次 while 检查时中断 drain，
    // 所以 close-before-archive 会丢弃 result。
    transport.reportState('idle')
    void transport.write(makeResultMessage(sessionId))

    let token = getAccessToken()
    let status = await archiveSession(
      sessionId,
      baseUrl,
      token,
      orgUUID,
      cfg.teardown_archive_timeout_ms,
    )

    // token 通常是新鲜的（刷新调度器在到期前 5 分钟运行），
    // 但笔记本唤醒超过刷新窗口时 getAccessToken() 返回过期字符串。
    // 仅在 401 时重试一次——onAuth401（= handleOAuth401Error）清除 keychain 缓存 + 强制刷新。
    // 不在成功路径上主动刷新：handleOAuth401Error 即使对有效 token 也强制刷新，
    // 在 99% 情况下浪费预算。
    if (status === 401 && onAuth401) {
      try {
        await onAuth401(token ?? '')
        token = getAccessToken()
        status = await archiveSession(
          sessionId,
          baseUrl,
          token,
          orgUUID,
          cfg.teardown_archive_timeout_ms,
        )
      } catch (err) {
        logForDebugging(
          `[remote-bridge] Teardown 401 retry threw: ${errorMessage(err)}`,
          { level: 'error' },
        )
      }
    }

    transport.close() // 关闭 transport（close 后 drain 在下次 while 检查时中断）

    // 将 archive 状态映射为 BQ 可 GROUP BY 的分类字符串
    const archiveStatus: ArchiveTelemetryStatus =
      status === 'no_token'
        ? 'skipped_no_token'
        : status === 'timeout' || status === 'error'
          ? 'network_error'
          : status >= 500
            ? 'server_5xx'
            : status >= 400
              ? 'server_4xx'
              : 'ok'

    logForDebugging(`[remote-bridge] Torn down (archive=${status})`)
    logForDiagnosticsNoPII('info', 'bridge_repl_v2_teardown')
    logEvent(
      feature('CCR_MIRROR') && outboundOnly
        ? 'tengu_ccr_mirror_teardown' // CCR mirror mode 专属事件
        : 'tengu_bridge_repl_teardown',
      {
        v2: true,
        archive_status:
          archiveStatus as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        archive_ok: typeof status === 'number' && status < 400,
        archive_http_status: typeof status === 'number' ? status : undefined,
        archive_timeout: status === 'timeout',
        archive_no_token: status === 'no_token',
      },
    )
  }
  const unregister = registerCleanup(teardown) // 注册到进程级清理注册表

  // 发送启动遥测事件
  if (feature('CCR_MIRROR') && outboundOnly) {
    logEvent('tengu_ccr_mirror_started', {
      v2: true,
      expires_in_s: credentials.expires_in,
    })
  } else {
    logEvent('tengu_bridge_repl_started', {
      has_initial_messages: !!(initialMessages && initialMessages.length > 0),
      v2: true,
      expires_in_s: credentials.expires_in,
      inProtectedNamespace: isInProtectedNamespace(),
    })
  }

  // ── 阶段 10：返回 ReplBridgeHandle ─────────────────────────────────────
  return {
    bridgeSessionId: sessionId, // cse_* 格式的 bridge 会话 ID
    environmentId: '', // v2 无 environment ID
    sessionIngressUrl: credentials.api_base_url,
    /**
     * writeMessages — 过滤并发送本地消息到 bridge（出站）。
     *
     * 过滤逻辑：
     *   - isEligibleBridgeMessage：排除不适合 bridge 的消息类型
     *   - initialMessageUUIDs：排除初始历史消息（echo 防重发，无界集合后备）
     *   - recentPostedUUIDs：排除最近已发送消息（2000 容量环形缓冲区）
     *
     * 副作用：
     *   - 触发 onUserMessage（标题派生，直到回调返回 true）
     *   - FlushGate 激活时排队，否则立即批量发送
     *   - 有 user 消息时推送 running 状态
     */
    writeMessages(messages) {
      const filtered = messages.filter(
        m =>
          isEligibleBridgeMessage(m) &&
          !initialMessageUUIDs.has(m.uuid) && // 排除初始消息（echo 防重发）
          !recentPostedUUIDs.has(m.uuid), // 排除最近已发送（环形缓冲区去重）
      )
      if (filtered.length === 0) return

      // 触发 onUserMessage 进行标题派生。在 flushGate 检查之前扫描——
      // 即使消息排队，提示也值得派生标题。
      // 持续调用直到回调返回 true；调用方拥有策略（count-1 和 count-3）。
      if (!userMessageCallbackDone) {
        for (const m of filtered) {
          const text = extractTitleText(m)
          if (text !== undefined && onUserMessage?.(text, sessionId)) {
            userMessageCallbackDone = true
            break
          }
        }
      }

      // FlushGate 激活时排队（历史 flush 进行中）
      if (flushGate.enqueue(...filtered)) {
        logForDebugging(
          `[remote-bridge] Queued ${filtered.length} message(s) during flush`,
        )
        return
      }

      // 记录已发送 UUID，批量发送
      for (const msg of filtered) recentPostedUUIDs.add(msg.uuid)
      const events = toSDKMessages(filtered).map(m => ({
        ...m,
        session_id: sessionId,
      }))
      // v2 不像 v1 在服务端从事件派生 worker_status
      // （session-ingress session_status_updater.go）。
      // 在此推送，使 CCR Web 会话列表显示 Running 而非卡在 Idle。
      // CCRClient.reportState 去重连续的相同状态推送。
      if (filtered.some(m => m.type === 'user')) {
        transport.reportState('running') // 有用户消息，标记 running
      }
      logForDebugging(`[remote-bridge] Sending ${filtered.length} message(s)`)
      void transport.writeBatch(events)
    },
    /**
     * writeSdkMessages — 发送 SDK 格式消息（直接过 UUID 去重后批量发送）。
     * 与 writeMessages 的区别：输入已是 SDKMessage[]，跳过 isEligibleBridgeMessage 过滤。
     */
    writeSdkMessages(messages: SDKMessage[]) {
      const filtered = messages.filter(
        m => !m.uuid || !recentPostedUUIDs.has(m.uuid), // 去重
      )
      if (filtered.length === 0) return
      for (const msg of filtered) {
        if (msg.uuid) recentPostedUUIDs.add(msg.uuid) // 记录已发送 UUID
      }
      const events = filtered.map(m => ({ ...m, session_id: sessionId }))
      void transport.writeBatch(events)
    },
    /**
     * sendControlRequest — 发送工具权限请求到远端客户端。
     *
     * can_use_tool subtype 时推送 requires_action 状态。
     * 401 恢复进行中时丢弃请求（避免在旧 transport 上发送）。
     */
    sendControlRequest(request: SDKControlRequest) {
      if (authRecoveryInFlight) {
        logForDebugging(
          `[remote-bridge] Dropping control_request during 401 recovery: ${request.request_id}`,
        )
        return
      }
      const event = { ...request, session_id: sessionId }
      if (request.request.subtype === 'can_use_tool') {
        transport.reportState('requires_action') // 等待用户批准
      }
      void transport.write(event)
      logForDebugging(
        `[remote-bridge] Sent control_request request_id=${request.request_id}`,
      )
    },
    /**
     * sendControlResponse — 发送工具权限应答（本地已决策，通知远端）。
     * 发送后推送 running 状态，表示 turn 继续。
     */
    sendControlResponse(response: SDKControlResponse) {
      if (authRecoveryInFlight) {
        logForDebugging(
          '[remote-bridge] Dropping control_response during 401 recovery',
        )
        return
      }
      const event = { ...response, session_id: sessionId }
      transport.reportState('running') // 权限应答后恢复 running
      void transport.write(event)
      logForDebugging('[remote-bridge] Sent control_response')
    },
    /**
     * sendControlCancelRequest — 发送权限请求取消通知（hook/分类器/渠道本地已解决）。
     *
     * interactiveHandler 在本地解决权限时仅调用 cancelRequest（不调用 sendResponse），
     * 不发送此事件会导致服务端卡在 requires_action。
     */
    sendControlCancelRequest(requestId: string) {
      if (authRecoveryInFlight) {
        logForDebugging(
          `[remote-bridge] Dropping control_cancel_request during 401 recovery: ${requestId}`,
        )
        return
      }
      const event = {
        type: 'control_cancel_request' as const,
        request_id: requestId,
        session_id: sessionId,
      }
      // hook/分类器/渠道/重检本地解决了权限——
      // interactiveHandler 仅调用 cancelRequest（无 sendResponse），
      // 不发送此事件服务端会卡在 requires_action。
      transport.reportState('running') // 恢复 running 状态
      void transport.write(event)
      logForDebugging(
        `[remote-bridge] Sent control_cancel_request request_id=${requestId}`,
      )
    },
    /**
     * sendResult — 发送 turn 结束结果事件。
     * 推送 idle 状态并写入 result 消息。
     */
    sendResult() {
      if (authRecoveryInFlight) {
        logForDebugging('[remote-bridge] Dropping result during 401 recovery')
        return
      }
      transport.reportState('idle') // turn 结束，进入 idle
      void transport.write(makeResultMessage(sessionId))
      logForDebugging(`[remote-bridge] Sent result`)
    },
    /** teardown — 取消注册清理回调并执行 teardown（归档 + 关闭 transport）。 */
    async teardown() {
      unregister() // 从进程级清理注册表移除
      await teardown()
    },
  }
}

// ─── Session API（v2 /code/sessions，无环境层）────────────────────────────────

/**
 * withRetry — 带指数退避 + 抖动的异步初始化调用重试函数。
 *
 * 重试策略：
 *   - 最多 cfg.init_retry_max_attempts 次
 *   - 退避时间：base * 2^(attempt-1)（指数）
 *   - 抖动：base * jitter_fraction * random(-1, 1)
 *   - 上限：cfg.init_retry_max_delay_ms
 *   - 返回 null 表示所有重试均失败
 */
async function withRetry<T>(
  fn: () => Promise<T | null>,
  label: string,
  cfg: EnvLessBridgeConfig,
): Promise<T | null> {
  const max = cfg.init_retry_max_attempts
  for (let attempt = 1; attempt <= max; attempt++) {
    const result = await fn()
    if (result !== null) return result
    if (attempt < max) {
      // 指数退避基础时间（带抖动避免惊群效应）
      const base = cfg.init_retry_base_delay_ms * 2 ** (attempt - 1)
      const jitter =
        base * cfg.init_retry_jitter_fraction * (2 * Math.random() - 1)
      const delay = Math.min(base + jitter, cfg.init_retry_max_delay_ms)
      logForDebugging(
        `[remote-bridge] ${label} failed (attempt ${attempt}/${max}), retrying in ${Math.round(delay)}ms`,
      )
      await sleep(delay)
    }
  }
  return null
}

// 移至 codeSessionApi.ts，使 SDK /bridge 子路径可以 bundle 它们，
// 而不拉入此文件的重型 CLI 树（analytics、transport）。
export {
  createCodeSession,
  type RemoteCredentials,
} from './codeSessionApi.js'
import {
  createCodeSession,
  fetchRemoteCredentials as fetchRemoteCredentialsRaw,
  type RemoteCredentials,
} from './codeSessionApi.js'
import { getBridgeBaseUrlOverride } from './bridgeConfig.js'

/**
 * fetchRemoteCredentials — CLI 侧 wrapper，应用 CLAUDE_BRIDGE_BASE_URL 开发覆盖
 * 并注入受信任设备令牌（两者均是 env/GrowthBook 读取，SDK 侧的 codeSessionApi.ts 导出
 * 必须保持无此依赖）。
 *
 * 流程：
 *   1. 调用 fetchRemoteCredentialsRaw（SDK 无状态版本）
 *   2. 若有 CLAUDE_BRIDGE_BASE_URL 覆盖，替换 api_base_url
 *   3. 返回凭据（或 null 表示失败）
 */
export async function fetchRemoteCredentials(
  sessionId: string,
  baseUrl: string,
  accessToken: string,
  timeoutMs: number,
): Promise<RemoteCredentials | null> {
  const creds = await fetchRemoteCredentialsRaw(
    sessionId,
    baseUrl,
    accessToken,
    timeoutMs,
    getTrustedDeviceToken(), // 注入受信任设备令牌（X-Trusted-Device-Token）
  )
  if (!creds) return null
  // 开发覆盖：若有 CLAUDE_BRIDGE_BASE_URL，替换 api_base_url 为本地 URL
  return getBridgeBaseUrlOverride()
    ? { ...creds, api_base_url: baseUrl }
    : creds
}

/**
 * ArchiveStatus — archiveSession 返回类型。
 *
 * number：HTTP 状态码（200/4xx/5xx）
 * 'timeout'：请求超时（ECONNABORTED）
 * 'error'：其他网络错误
 * 'no_token'：无 OAuth token，跳过
 */
type ArchiveStatus = number | 'timeout' | 'error' | 'no_token'

/**
 * ArchiveTelemetryStatus — BQ GROUP BY 的 archive 状态分类。
 *
 * _teardown 事件中的布尔字段（archive_ok/archive_timeout/archive_no_token）
 * 早于此分类字段存在，与之部分冗余。
 * archive_timeout 区分 ECONNABORTED 与其他网络错误——两者均映射到 'network_error'，
 * 因为在 1.5s 窗口内的主要原因是超时。
 */
type ArchiveTelemetryStatus =
  | 'ok'
  | 'skipped_no_token'
  | 'network_error'
  | 'server_4xx'
  | 'server_5xx'

/**
 * archiveSession — 归档指定 bridge 会话（通知服务端会话已结束）。
 *
 * 技术细节：
 *   - Archive 路径在 compat 层（/v1/sessions/*，非 /v1/code/sessions）
 *   - compat.parseSessionID 仅接受 TagSession（session_*），需将 cse_* 重新标记
 *   - 需要 anthropic-beta + x-organization-uuid 请求头，否则 compat 网关 404
 *
 * 与 bridgeMain.ts 不同（后者缓存 compatId 以保持内存状态一致），
 * 此处 compatId 仅用作服务端 URL 路径段，每次重新计算以匹配服务端当前接受的格式。
 *
 * @returns ArchiveStatus（HTTP 状态码或错误字符串）
 */
async function archiveSession(
  sessionId: string,
  baseUrl: string,
  accessToken: string | undefined,
  orgUUID: string,
  timeoutMs: number,
): Promise<ArchiveStatus> {
  if (!accessToken) return 'no_token' // 无 token，跳过（不发请求）
  // 将 cse_* 转换为 session_* 格式（compat 层需要）
  const compatId = toCompatSessionId(sessionId)
  try {
    const response = await axios.post(
      `${baseUrl}/v1/sessions/${compatId}/archive`,
      {},
      {
        headers: {
          ...oauthHeaders(accessToken),
          'anthropic-beta': 'ccr-byoc-2025-07-29', // BYOC beta 标头
          'x-organization-uuid': orgUUID, // 组织 UUID（compat 网关必需）
        },
        timeout: timeoutMs,
        validateStatus: () => true, // 不对任何状态码抛出异常（由调用方处理）
      },
    )
    logForDebugging(
      `[remote-bridge] Archive ${compatId} status=${response.status}`,
    )
    return response.status // 返回 HTTP 状态码
  } catch (err) {
    const msg = errorMessage(err)
    logForDebugging(`[remote-bridge] Archive failed: ${msg}`)
    // ECONNABORTED 映射为 'timeout'，其他网络错误映射为 'error'
    return axios.isAxiosError(err) && err.code === 'ECONNABORTED'
      ? 'timeout'
      : 'error'
  }
}
