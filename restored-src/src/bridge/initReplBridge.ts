/**
 * initReplBridge.ts — REPL Bridge 初始化包装器
 *
 * 在 Claude Code 系统流程中的位置：
 *   REPL（交互式终端）Bridge 层
 *     ├─> useReplBridge.tsx（自动启动，调用本文件）
 *     ├─> print.ts（SDK -p 模式，query.enableRemoteControl 调用本文件）
 *     └─> initReplBridge.ts（本文件）
 *           ├─> replBridge.ts (initBridgeCore — v1 env-based 路径)
 *           └─> remoteBridgeCore.ts (initEnvLessBridgeCore — v2 env-less 路径)
 *
 * 主要功能：
 *   - 读取引导层状态（sessionId、cwd、git 上下文、OAuth token）
 *   - 执行多阶段门控检查（bridge 开关、OAuth、组织策略、版本检查）
 *   - 跨进程 OAuth 死令牌退避（bridgeOauthDeadExpiresAt/failCount >= 3 早返回）
 *   - 派生会话标题（initialName > /rename > 最后用户消息 > slug 占位符）
 *   - 根据 tengu_bridge_repl_v2 功能开关分派到 env-less(v2) 或 env-based(v1) 核心
 *   - 维护 onUserMessage 回调（count=1 立即 deriveTitle + fire-and-forget Haiku；count=3 全对话重生成）
 *
 * 设计说明：
 *   从 replBridge.ts 中拆分出来，是因为 sessionStorage 导入（getCurrentSessionTitle）
 *   会传递引入 src/commands.ts → 整个斜杠命令 + React 组件树（约 1300 个模块）。
 *   将 initBridgeCore 保留在不接触 sessionStorage 的文件中，使 daemonBridge.ts
 *   可以导入核心而不膨胀 Agent SDK bundle。
 */

import { feature } from 'bun:bundle'
import { hostname } from 'os'
import { getOriginalCwd, getSessionId } from '../bootstrap/state.js'
import type { SDKMessage } from '../entrypoints/agentSdkTypes.js'
import type { SDKControlResponse } from '../entrypoints/sdk/controlTypes.js'
import { getFeatureValue_CACHED_WITH_REFRESH } from '../services/analytics/growthbook.js'
import { getOrganizationUUID } from '../services/oauth/client.js'
import {
  isPolicyAllowed,
  waitForPolicyLimitsToLoad,
} from '../services/policyLimits/index.js'
import type { Message } from '../types/message.js'
import {
  checkAndRefreshOAuthTokenIfNeeded,
  getClaudeAIOAuthTokens,
  handleOAuth401Error,
} from '../utils/auth.js'
import { getGlobalConfig, saveGlobalConfig } from '../utils/config.js'
import { logForDebugging } from '../utils/debug.js'
import { stripDisplayTagsAllowEmpty } from '../utils/displayTags.js'
import { errorMessage } from '../utils/errors.js'
import { getBranch, getRemoteUrl } from '../utils/git.js'
import { toSDKMessages } from '../utils/messages/mappers.js'
import {
  getContentText,
  getMessagesAfterCompactBoundary,
  isSyntheticMessage,
} from '../utils/messages.js'
import type { PermissionMode } from '../utils/permissions/PermissionMode.js'
import { getCurrentSessionTitle } from '../utils/sessionStorage.js'
import {
  extractConversationText,
  generateSessionTitle,
} from '../utils/sessionTitle.js'
import { generateShortWordSlug } from '../utils/words.js'
import {
  getBridgeAccessToken,
  getBridgeBaseUrl,
  getBridgeTokenOverride,
} from './bridgeConfig.js'
import {
  checkBridgeMinVersion,
  isBridgeEnabledBlocking,
  isCseShimEnabled,
  isEnvLessBridgeEnabled,
} from './bridgeEnabled.js'
import {
  archiveBridgeSession,
  createBridgeSession,
  updateBridgeSessionTitle,
} from './createSession.js'
import { logBridgeSkip } from './debugUtils.js'
import { checkEnvLessBridgeMinVersion } from './envLessBridgeConfig.js'
import { getPollIntervalConfig } from './pollConfig.js'
import type { BridgeState, ReplBridgeHandle } from './replBridge.js'
import { initBridgeCore } from './replBridge.js'
import { setCseShimGate } from './sessionIdCompat.js'
import type { BridgeWorkerType } from './types.js'

/**
 * InitBridgeOptions — REPL Bridge 初始化选项类型
 *
 * 包含所有回调（消息入站、权限应答、中断、模型切换、权限模式切换、状态变更）
 * 以及初始消息列表、会话名、历史消息 getter、已刷新 UUID 集合、特殊标志等。
 */
export type InitBridgeOptions = {
  /** 入站消息回调（claude.ai → 本地 Claude Code） */
  onInboundMessage?: (msg: SDKMessage) => void | Promise<void>
  /** 权限应答回调（远端客户端回答工具权限请求） */
  onPermissionResponse?: (response: SDKControlResponse) => void
  /** 中断信号回调（Ctrl+C 等） */
  onInterrupt?: () => void
  /** 切换模型回调 */
  onSetModel?: (model: string | undefined) => void
  /** 设置最大思考 token 数回调 */
  onSetMaxThinkingTokens?: (maxTokens: number | null) => void
  /** 设置权限模式回调，返回 ok/error */
  onSetPermissionMode?: (
    mode: PermissionMode,
  ) => { ok: true } | { ok: false; error: string }
  /** Bridge 状态变更回调（failed/ready/connected/reconnecting 等） */
  onStateChange?: (state: BridgeState, detail?: string) => void
  /** 初始历史消息列表（Bridge 启动时一次性 flush 到服务端） */
  initialMessages?: Message[]
  /**
   * 来自 `/remote-control <name>` 的显式会话名称。
   * 设置后覆盖从对话或 /rename 派生的标题。
   */
  initialName?: string
  /**
   * 调用时刻的完整对话消息数组 getter（供 count=3 时 generateSessionTitle 使用）。
   * 可选——print.ts 的 SDK enableRemoteControl 路径无 REPL 消息数组，
   * count=3 时回退到单消息文本。
   */
  getMessages?: () => Message[]
  /**
   * 上一个 bridge 会话已刷新的 UUID 集合。
   * 这些 UUID 的消息在初始 flush 时被排除，避免重复 UUID 导致 WebSocket 被关闭。
   * 原地修改——每次 flush 后将新刷新的 UUID 加入集合。
   */
  previouslyFlushedUUIDs?: Set<string>
  /** 参见 BridgeCoreParams.perpetual（assistant mode 会话连续性） */
  perpetual?: boolean
  /**
   * 为 true 时，bridge 仅转发出站事件（无 SSE 入站流）。
   * 用于 CCR mirror mode——本地会话在 claude.ai 可见，但不启用入站控制。
   */
  outboundOnly?: boolean
  /** 会话分类标签（如 ['ccr-mirror']） */
  tags?: string[]
}

/**
 * initReplBridge — REPL Bridge 主初始化函数
 *
 * 完整初始化流程：
 *   1. setCseShimGate — 配置 cse_ 会话 ID 兼容层开关
 *   2. isBridgeEnabledBlocking — 检查 Bridge 是否在运行时被门控
 *   3. getBridgeAccessToken — 检查 OAuth token（无 token → '/login' 提示）
 *   4. waitForPolicyLimitsToLoad + isPolicyAllowed — 组织策略检查
 *   5. 跨进程 OAuth 死令牌退避（bridgeOauthDeadExpiresAt/failCount>=3 早返回）
 *   6. checkAndRefreshOAuthTokenIfNeeded — 主动刷新过期 token
 *   7. 过期令牌检查（expiresAt <= Date.now() → 写退避计数器 + 返回 null）
 *   8. getBridgeBaseUrl — 获取 baseUrl
 *   9. 会话标题派生（initialName > /rename > 最后用户消息 > slug 占位符）
 *   10. isEnvLessBridgeEnabled && !perpetual → initEnvLessBridgeCore(v2)
 *       否则 → checkBridgeMinVersion + initBridgeCore(v1)
 *
 * @returns ReplBridgeHandle（成功）或 null（任意前置检查失败）
 */
export async function initReplBridge(
  options?: InitBridgeOptions,
): Promise<ReplBridgeHandle | null> {
  const {
    onInboundMessage,
    onPermissionResponse,
    onInterrupt,
    onSetModel,
    onSetMaxThinkingTokens,
    onSetPermissionMode,
    onStateChange,
    initialMessages,
    getMessages,
    previouslyFlushedUUIDs,
    initialName,
    perpetual,
    outboundOnly,
    tags,
  } = options ?? {}

  // 配置 cse_ 会话 ID compat shim 开关，使 toCompatSessionId 遵从 GrowthBook 门控。
  // daemon/SDK 路径跳过此步骤——shim 默认激活。
  setCseShimGate(isCseShimEnabled)

  // 步骤 1：运行时 Bridge 开关检查（GrowthBook tengu_bridge_enabled）
  if (!(await isBridgeEnabledBlocking())) {
    logBridgeSkip('not_enabled', '[bridge:repl] Skipping: bridge not enabled')
    return null
  }

  // 步骤 1b：最低版本检查延迟到 v1/v2 分支后执行，因为两个实现各有自己的版本下限。

  // 步骤 2：检查 OAuth——必须使用 claude.ai 账号登录。
  // 在策略检查之前运行，避免控制台认证用户看到误导性的策略错误。
  if (!getBridgeAccessToken()) {
    logBridgeSkip('no_oauth', '[bridge:repl] Skipping: no OAuth tokens')
    onStateChange?.('failed', '/login') // 提示用户执行 /login
    return null
  }

  // 步骤 3：检查组织策略——远程控制可能被禁用
  await waitForPolicyLimitsToLoad()
  if (!isPolicyAllowed('allow_remote_control')) {
    logBridgeSkip(
      'policy_denied',
      '[bridge:repl] Skipping: allow_remote_control policy not allowed',
    )
    onStateChange?.('failed', "disabled by your organization's policy")
    return null
  }

  // 当 CLAUDE_BRIDGE_OAUTH_TOKEN 已设置（ant 内部本地开发），Bridge 使用该令牌，
  // keychain 状态无关——跳过 2b/2c 以避免过期的 keychain token 阻断连接。
  if (!getBridgeTokenOverride()) {
    // 步骤 2a：跨进程退避检查。
    // 若前 N 个进程已见过同一死令牌（通过 expiresAt 匹配），静默跳过。
    // 计数阈值允许偶发刷新失败（认证服务器 5xx、锁文件竞争）：
    // 每个进程独立重试，直到连续 3 次失败证明 token 确实已死。
    // expiresAt 是内容寻址的：/login 后新 token 有新的 expiresAt → 自动解除退避。
    const cfg = getGlobalConfig()
    if (
      cfg.bridgeOauthDeadExpiresAt != null &&
      (cfg.bridgeOauthDeadFailCount ?? 0) >= 3 && // 连续失败次数 >= 3
      getClaudeAIOAuthTokens()?.expiresAt === cfg.bridgeOauthDeadExpiresAt // 同一死令牌
    ) {
      logForDebugging(
        `[bridge:repl] Skipping: cross-process backoff (dead token seen ${cfg.bridgeOauthDeadFailCount} times)`,
      )
      return null
    }

    // 步骤 2b：主动刷新（如 token 已过期）。
    // Bridge 在 useEffect mount 时触发，通常是会话的第一个 OAuth 请求。
    // 不主动刷新时 ~9% 的注册会携带 >8h 过期的 token → 401 → withOAuthRetry 恢复，
    // 但会在服务端产生可避免的 401 日志。
    await checkAndRefreshOAuthTokenIfNeeded()

    // 步骤 2c：刷新后仍过期则跳过。
    // env-var / FD token（auth.ts:894-917）的 expiresAt=null → 永不触发此检查。
    // keychain token 的刷新 token 已死（改密/离开 org/GC）时：expiresAt<now 且
    // 刷新刚刚失败——若继续，客户端会循环 401 forever。
    const tokens = getClaudeAIOAuthTokens()
    if (tokens && tokens.expiresAt !== null && tokens.expiresAt <= Date.now()) {
      logBridgeSkip(
        'oauth_expired_unrefreshable',
        '[bridge:repl] Skipping: OAuth token expired and refresh failed (re-login required)',
      )
      onStateChange?.('failed', '/login')
      // 持久化退避信息到下一个进程。
      // 当 expiresAt 相同（同一死 token）时递增 failCount；不同时重置为 1。
      // 一旦 count 达到 3，步骤 2a 的早返回触发，不再到达此处——每个死 token 最多写 3 次。
      const deadExpiresAt = tokens.expiresAt
      saveGlobalConfig(c => ({
        ...c,
        bridgeOauthDeadExpiresAt: deadExpiresAt,
        bridgeOauthDeadFailCount:
          c.bridgeOauthDeadExpiresAt === deadExpiresAt
            ? (c.bridgeOauthDeadFailCount ?? 0) + 1
            : 1, // 不同 token 重置计数器
      }))
      return null
    }
  }

  // 步骤 4：获取 baseUrl——v1（env-based）和 v2（env-less）路径均需要
  const baseUrl = getBridgeBaseUrl()

  // 步骤 5：派生会话标题。
  // 优先级：显式 initialName > /rename（sessionStorage）> 最后有意义的用户消息 > 生成的 slug。
  // 仅用于 claude.ai 会话列表展示；模型从不看到标题。
  // hasExplicitTitle（initialName 或 /rename）——永不自动覆盖
  // hasTitle（任意标题，包括自动派生）——阻断 count=1 重派生，但不阻断 count=3
  let title = `remote-control-${generateShortWordSlug()}` // slug 占位符（如 remote-control-graceful-unicorn）
  let hasTitle = false
  let hasExplicitTitle = false
  if (initialName) {
    // 使用 /remote-control <name> 传入的显式名称
    title = initialName
    hasTitle = true
    hasExplicitTitle = true
  } else {
    const sessionId = getSessionId()
    const customTitle = sessionId
      ? getCurrentSessionTitle(sessionId) // 从 sessionStorage 读取 /rename 标题
      : undefined
    if (customTitle) {
      // /rename 已设置的标题
      title = customTitle
      hasTitle = true
      hasExplicitTitle = true
    } else if (initialMessages && initialMessages.length > 0) {
      // 从初始消息列表中找最后一条有意义的用户消息。
      // 跳过 meta（nudges）、工具结果、compact 摘要、非人类来源、合成中断消息。
      for (let i = initialMessages.length - 1; i >= 0; i--) {
        const msg = initialMessages[i]!
        if (
          msg.type !== 'user' ||
          msg.isMeta ||
          msg.toolUseResult ||
          msg.isCompactSummary ||
          (msg.origin && msg.origin.kind !== 'human') ||
          isSyntheticMessage(msg) // 跳过合成中断消息（如 [Request interrupted by user]）
        )
          continue
        const rawContent = getContentText(msg.message.content)
        if (!rawContent) continue
        const derived = deriveTitle(rawContent) // 从内容派生标题
        if (!derived) continue
        title = derived
        hasTitle = true
        break
      }
    }
  }

  // onUserMessage 回调——v1 和 v2 共享。
  // 在每条标题值得关注的用户消息到来时触发，直到回调返回 true（派生完成）。
  // count=1：立即 deriveTitle（占位符），然后 fire-and-forget Haiku 升级。
  // count=3：用完整对话重新生成。
  // hasExplicitTitle（/remote-control <name> 或 /rename）时完全跳过。
  // v2 传入 cse_*；updateBridgeSessionTitle 内部重新打标签。
  let userMessageCount = 0 // 已处理的标题值用户消息计数
  let lastBridgeSessionId: string | undefined // 上次处理的 bridge 会话 ID（用于检测 v1 env-lost 重建）
  let genSeq = 0 // 防孤儿定时器的代次序列号
  /**
   * patch — 立即更新内存标题并 fire-and-forget PATCH 到服务端。
   * 由 count=1 占位符派生和 Haiku 生成结果调用。
   */
  const patch = (
    derived: string,
    bridgeSessionId: string,
    atCount: number,
  ): void => {
    hasTitle = true
    title = derived
    logForDebugging(
      `[bridge:repl] derived title from message ${atCount}: ${derived}`,
    )
    // fire-and-forget PATCH 到服务端会话标题接口
    void updateBridgeSessionTitle(bridgeSessionId, derived, {
      baseUrl,
      getAccessToken: getBridgeAccessToken,
    }).catch(() => {})
  }
  /**
   * generateAndPatch — fire-and-forget Haiku 生成并在完成后 patch 标题。
   * 包含三重后置守卫：
   *   1. gen === genSeq：防止乱序的旧 Haiku 覆盖更新的标题
   *   2. lastBridgeSessionId === bridgeSessionId：防止 v1 env-lost 重建后写入旧会话
   *   3. !getCurrentSessionTitle(...)：/rename 后不再覆盖
   */
  const generateAndPatch = (input: string, bridgeSessionId: string): void => {
    const gen = ++genSeq // 递增代次，用于乱序防护
    const atCount = userMessageCount
    void generateSessionTitle(input, AbortSignal.timeout(15_000)).then(
      generated => {
        if (
          generated &&
          gen === genSeq && // 防孤儿：确保仍是最新的生成请求
          lastBridgeSessionId === bridgeSessionId && // 防 env-lost 跨会话写入
          !getCurrentSessionTitle(getSessionId()) // /rename 后不覆盖
        ) {
          patch(generated, bridgeSessionId, atCount)
        }
      },
    )
  }
  /**
   * onUserMessage — 每条标题值用户消息触发，直到返回 true 表示派生完成。
   *
   * 策略：
   *   - hasExplicitTitle 或 /rename → 立即返回 true（不再派生）
   *   - v1 env-lost 检测（lastBridgeSessionId !== bridgeSessionId）→ 重置 count
   *   - count=1 且无标题 → deriveTitle 占位符 + fire-and-forget Haiku
   *   - count=3 → 用全对话重新生成（getMessages() 或单消息回退）
   *   - count >= 3 → 返回 true（后续消息不再触发）
   */
  const onUserMessage = (text: string, bridgeSessionId: string): boolean => {
    // hasExplicitTitle 或 sessionStorage 中有 /rename 标题——不派生
    if (hasExplicitTitle || getCurrentSessionTitle(getSessionId())) {
      return true
    }
    // v1 env-lost 重新创建会话（新 ID）——重置计数器，使新会话获得自己的 count-3 派生
    if (
      lastBridgeSessionId !== undefined &&
      lastBridgeSessionId !== bridgeSessionId
    ) {
      userMessageCount = 0
    }
    lastBridgeSessionId = bridgeSessionId
    userMessageCount++
    if (userMessageCount === 1 && !hasTitle) {
      // count=1 且无标题：派生占位符 + fire-and-forget Haiku 升级
      const placeholder = deriveTitle(text)
      if (placeholder) patch(placeholder, bridgeSessionId, userMessageCount)
      generateAndPatch(text, bridgeSessionId)
    } else if (userMessageCount === 3) {
      // count=3：用完整对话重新生成（getMessages() 可用时取完整上下文）
      const msgs = getMessages?.()
      const input = msgs
        ? extractConversationText(getMessagesAfterCompactBoundary(msgs))
        : text // 无 getMessages 时回退到单消息文本
      generateAndPatch(input, bridgeSessionId)
    }
    // count >= 3 时返回 true，告知调用方后续无需再触发
    return userMessageCount >= 3
  }

  // 从 GrowthBook 读取初始历史消息上限（默认 200 条，5 分钟刷新间隔）
  const initialHistoryCap = getFeatureValue_CACHED_WITH_REFRESH(
    'tengu_bridge_initial_history_cap',
    200,
    5 * 60 * 1000,
  )

  // 在 v1/v2 分支前获取 orgUUID——两条路径均需要。
  // v1 用于环境注册；v2 用于 archive（compat /v1/sessions/{id}/archive，非 /v1/code/sessions）。
  // 无 orgUUID 时 v2 archive 会 404，会话在 CCR 中保持存活状态无法清理。
  const orgUUID = await getOrganizationUUID()
  if (!orgUUID) {
    logBridgeSkip('no_org_uuid', '[bridge:repl] Skipping: no org UUID')
    onStateChange?.('failed', '/login')
    return null
  }

  // ── GrowthBook 门控：env-less bridge（tengu_bridge_repl_v2）──────────────
  // 启用时完全跳过 Environments API 层（无 register/poll/ack/heartbeat），
  // 直接通过 POST /bridge 获取 worker_jwt 连接。
  //
  // NAMING 说明：
  //   "env-less" 与 "CCR v2"（/worker/* 传输协议）是不同的概念。
  //   env-based 路径（replBridge.ts）也可以通过 CLAUDE_CODE_USE_CCR_V2 使用 CCR v2 传输。
  //   tengu_bridge_repl_v2 门控的是"无 poll 循环"，而非传输协议版本。
  //
  // perpetual（assistant mode 会话连续性，通过 bridge-pointer.json）依赖 env，
  // 尚未在此实现——perpetual=true 时回退到 env-based，避免 KAIROS 用户静默丢失跨重启连续性。
  if (isEnvLessBridgeEnabled() && !perpetual) {
    // 检查 env-less bridge 最低版本要求
    const versionError = await checkEnvLessBridgeMinVersion()
    if (versionError) {
      logBridgeSkip(
        'version_too_old',
        `[bridge:repl] Skipping: ${versionError}`,
        true,
      )
      onStateChange?.('failed', 'run `claude update` to upgrade')
      return null
    }
    logForDebugging(
      '[bridge:repl] Using env-less bridge path (tengu_bridge_repl_v2)',
    )
    // 动态导入 remoteBridgeCore（避免静态依赖链膨胀 daemon bundle）
    const { initEnvLessBridgeCore } = await import('./remoteBridgeCore.js')
    return initEnvLessBridgeCore({
      baseUrl,
      orgUUID,
      title,
      getAccessToken: getBridgeAccessToken,
      onAuth401: handleOAuth401Error,
      toSDKMessages,
      initialHistoryCap,
      initialMessages,
      // v2 始终创建新的服务端会话（新 cse_* id），无需 previouslyFlushedUUIDs：
      // - 无跨会话 UUID 碰撞风险
      // - useRef 保留的集合在 enable→disable→re-enable 时会错误地过滤历史消息
      // v1 通过 previouslyFlushedUUIDs.clear() 处理（replBridge.ts:768）；v2 直接不传
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
    })
  }

  // ── v1 路径：env-based（register/poll/ack/heartbeat）────────────────────

  // v1 最低版本检查（tengu_bridge_min_version）
  const versionError = checkBridgeMinVersion()
  if (versionError) {
    logBridgeSkip('version_too_old', `[bridge:repl] Skipping: ${versionError}`)
    onStateChange?.('failed', 'run `claude update` to upgrade')
    return null
  }

  // 收集 git 上下文——此处是引导层读取边界。
  // 以下所有内容均以参数形式显式传给 bridgeCore（不再隐式读取全局状态）。
  const branch = await getBranch()
  const gitRepoUrl = await getRemoteUrl()
  // session_ingress URL：ant 内部可通过环境变量覆盖（本地调试用）
  const sessionIngressUrl =
    process.env.USER_TYPE === 'ant' &&
    process.env.CLAUDE_BRIDGE_SESSION_INGRESS_URL
      ? process.env.CLAUDE_BRIDGE_SESSION_INGRESS_URL
      : baseUrl

  // assistant mode 会话使用专属 worker_type，方便 Web UI 在独立选择器中过滤。
  // KAIROS guard 确保 assistant 模块不进入外部构建。
  let workerType: BridgeWorkerType = 'claude_code'
  if (feature('KAIROS')) {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { isAssistantMode } =
      require('../assistant/index.js') as typeof import('../assistant/index.js')
    /* eslint-enable @typescript-eslint/no-require-imports */
    if (isAssistantMode()) {
      workerType = 'claude_code_assistant' // assistant mode 标记
    }
  }

  // 步骤 6：委派给 v1 核心（BridgeCoreHandle 是 ReplBridgeHandle 的结构超集）
  return initBridgeCore({
    dir: getOriginalCwd(), // 工作目录
    machineName: hostname(), // 机器名
    branch, // git 分支
    gitRepoUrl, // git 远端 URL
    title, // 会话标题
    baseUrl,
    sessionIngressUrl,
    workerType,
    getAccessToken: getBridgeAccessToken,
    createSession: opts =>
      createBridgeSession({
        ...opts,
        events: [],
        baseUrl,
        getAccessToken: getBridgeAccessToken,
      }),
    archiveSession: sessionId =>
      archiveBridgeSession(sessionId, {
        baseUrl,
        getAccessToken: getBridgeAccessToken,
        // gracefulShutdown.ts:407 将 runCleanupFunctions 与 2s 竞争。
        // teardown 还要 stopWork（并行）+ deregister（串行），
        // archive 不能占用全部预算。1.5s 匹配 v2 的 teardown_archive_timeout_ms 默认值。
        timeoutMs: 1500,
      }).catch((err: unknown) => {
        // archiveBridgeSession 无 try/catch——5xx/timeout/网络错误直接抛出。
        // 之前静默吞掉，使 archive 失败在 BQ 和 debug log 中不可见。
        logForDebugging(
          `[bridge:repl] archiveBridgeSession threw: ${errorMessage(err)}`,
          { level: 'error' },
        )
      }),
    // getCurrentTitle 在 env-lost 重连后被读取，以重新标记新会话。
    // /rename 写 sessionStorage；onUserMessage 直接修改 `title` 变量——两条路径均被此 getter 捕获。
    getCurrentTitle: () => getCurrentSessionTitle(getSessionId()) ?? title,
    onUserMessage,
    toSDKMessages,
    onAuth401: handleOAuth401Error,
    getPollIntervalConfig,
    initialHistoryCap,
    initialMessages,
    previouslyFlushedUUIDs,
    onInboundMessage,
    onPermissionResponse,
    onInterrupt,
    onSetModel,
    onSetMaxThinkingTokens,
    onSetPermissionMode,
    onStateChange,
    perpetual,
  })
}

/** 占位符标题最大长度（字符数） */
const TITLE_MAX_LEN = 50

/**
 * deriveTitle — 从原始消息文本快速派生占位符标题。
 *
 * 处理流程：
 *   1. stripDisplayTagsAllowEmpty：剥离 <ide_opened_file>、<session-start-hook> 等 display tag
 *      （IDE/hooks 注入的上下文块）——返回 '' 表示纯 tag 消息，直接跳过
 *   2. 取第一句（.*?[.!?]\s 捕获组而非 lookbehind，保证 YARR JIT 兼容性）
 *   3. 折叠空白（\s+ → ' '）——标题在 claude.ai 列表中为单行
 *   4. 截断到 50 字符（超出加 '…' 省略号）
 *   5. 返回 undefined 表示结果为空（如消息只含 <local-command-stdout>）
 *
 * 此结果为占位符，稍后由 generateSessionTitle（Haiku，约 1-15s）替换。
 */
function deriveTitle(raw: string): string | undefined {
  // 剥离 display tag，纯 tag 消息返回空字符串（而非原始内容）
  const clean = stripDisplayTagsAllowEmpty(raw)
  // 取第一句；捕获组替代 lookbehind（YARR JIT 不支持 lookbehind）
  const firstSentence = /^(.*?[.!?])\s/.exec(clean)?.[1] ?? clean
  // 折叠换行/Tab 为空格——claude.ai 列表中标题为单行展示
  const flat = firstSentence.replace(/\s+/g, ' ').trim()
  if (!flat) return undefined // 空结果（如纯 tag 消息）
  return flat.length > TITLE_MAX_LEN
    ? flat.slice(0, TITLE_MAX_LEN - 1) + '\u2026' // Unicode 省略号
    : flat
}
