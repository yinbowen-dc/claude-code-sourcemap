/**
 * bridgeEnabled.ts — Bridge（Remote Control）功能开关与资格校验
 *
 * 在 Claude Code 系统流程中的位置：
 *   CLI 初始化 / 命令定义 / 用户界面可见性判断
 *     └─> bridgeEnabled.ts（本文件）——集中管理所有与 Remote Control 相关的
 *           功能开关（feature flags）、资格检查（entitlement checks）和版本校验
 *           ├─ isBridgeEnabled()           — 快速非阻塞检查（UI 渲染）
 *           ├─ isBridgeEnabledBlocking()   — 阻塞式精确检查（入口门控）
 *           ├─ getBridgeDisabledReason()   — 返回用户可读的禁用原因
 *           ├─ checkBridgeMinVersion()     — 版本下限检查
 *           ├─ isEnvLessBridgeEnabled()    — v2 无环境变量 REPL Bridge 开关
 *           ├─ isCseShimEnabled()          — cse_* → session_* ID 转换 shim 开关
 *           ├─ getCcrAutoConnectDefault()  — CCR 自动连接默认值
 *           └─ isCcrMirrorEnabled()        — CCR 镜像模式开关
 *
 * 设计说明：
 *   - 所有与构建时 feature flag（feature('BRIDGE_MODE')）相关的检查均使用
 *     "正向三元"模式（feature(...) ? ... : false），确保在外部构建中
 *     完全消除 GrowthBook 字符串字面量，避免泄露内部功能名称。
 *   - 认证相关函数通过命名空间导入 authModule 而非直接导入，
 *     以打破 bridgeEnabled → auth → config → bridgeEnabled 的循环依赖。
 */
import { feature } from 'bun:bundle'
import {
  checkGate_CACHED_OR_BLOCKING,
  getDynamicConfig_CACHED_MAY_BE_STALE,
  getFeatureValue_CACHED_MAY_BE_STALE,
} from '../services/analytics/growthbook.js'
// Namespace import breaks the bridgeEnabled → auth → config → bridgeEnabled
// cycle — authModule.foo is a live binding, so by the time the helpers below
// call it, auth.js is fully loaded. Previously used require() for the same
// deferral, but require() hits a CJS cache that diverges from the ESM
// namespace after mock.module() (daemon/auth.test.ts), breaking spyOn.
//
// 命名空间导入打破循环依赖：bridgeEnabled → auth → config → bridgeEnabled
// authModule.foo 是活绑定，调用时 auth.js 已完全加载。
// 之前用 require() 做相同的延迟加载，但 require() 会命中 CJS 缓存，
// 在 mock.module()（daemon/auth.test.ts）后与 ESM 命名空间产生分歧，导致 spyOn 失效。
import * as authModule from '../utils/auth.js'
import { isEnvTruthy } from '../utils/envUtils.js'
import { lt } from '../utils/semver.js'

/**
 * 快速非阻塞地检查当前用户是否有权使用 Remote Control（Bridge 模式）。
 *
 * 用于 UI 渲染阶段的可见性判断（如是否显示 /remote-control 菜单项），
 * 使用缓存的 GrowthBook 值，可能略有过时，但不会阻塞渲染。
 *
 * 需要满足的条件：
 *   1. 构建时 BRIDGE_MODE feature flag 已启用（外部构建直接返回 false）；
 *   2. 当前用户是 claude.ai 订阅者（排除 Bedrock/Vertex/API Key 用户）；
 *   3. GrowthBook 功能开关 tengu_ccr_bridge 已开启（可能为缓存值）。
 *
 * Runtime check for bridge mode entitlement.
 *
 * Remote Control requires a claude.ai subscription (the bridge auths to CCR
 * with the claude.ai OAuth token). isClaudeAISubscriber() excludes
 * Bedrock/Vertex/Foundry, apiKeyHelper/gateway deployments, env-var API keys,
 * and Console API logins — none of which have the OAuth token CCR needs.
 * See github.com/deshaw/anthropic-issues/issues/24.
 *
 * The `feature('BRIDGE_MODE')` guard ensures the GrowthBook string literal
 * is only referenced when bridge mode is enabled at build time.
 */
export function isBridgeEnabled(): boolean {
  // Positive ternary pattern — see docs/feature-gating.md.
  // Negative pattern (if (!feature(...)) return) does not eliminate
  // inline string literals from external builds.
  // 正向三元模式：确保外部构建中不残留 GrowthBook 字符串字面量
  return feature('BRIDGE_MODE')
    ? isClaudeAISubscriber() &&
        getFeatureValue_CACHED_MAY_BE_STALE('tengu_ccr_bridge', false)
    : false
}

/**
 * 阻塞式精确检查当前用户是否有权使用 Remote Control。
 *
 * 快速路径：若磁盘缓存为 true，立即返回（无需网络请求）。
 * 慢速路径：若缓存为 false 或缺失，等待 GrowthBook 初始化并从服务端
 *   获取最新值（最长约 5 秒），再写入磁盘缓存。
 *
 * 使用场景：功能入口门控（如执行 /remote-control 命令前），
 * 避免因缓存过时的 false 值而错误阻止有权限的用户。
 * 若需向用户展示具体的禁用原因，应使用 getBridgeDisabledReason()。
 * 仅用于 UI 渲染可见性判断时，应使用 isBridgeEnabled()。
 *
 * Blocking entitlement check for Remote Control.
 *
 * Returns cached `true` immediately (fast path). If the disk cache says
 * `false` or is missing, awaits GrowthBook init and fetches the fresh
 * server value (slow path, max ~5s), then writes it to disk.
 *
 * Use at entitlement gates where a stale `false` would unfairly block access.
 * For user-facing error paths, prefer `getBridgeDisabledReason()` which gives
 * a specific diagnostic. For render-body UI visibility checks, use
 * `isBridgeEnabled()` instead.
 */
export async function isBridgeEnabledBlocking(): Promise<boolean> {
  return feature('BRIDGE_MODE')
    ? isClaudeAISubscriber() &&
        (await checkGate_CACHED_OR_BLOCKING('tengu_ccr_bridge')) // 阻塞等待最新 GrowthBook 值
    : false
}

/**
 * 返回 Remote Control 不可用的用户可读诊断原因，若可用则返回 null。
 *
 * 按顺序检查以下条件，返回第一个不满足条件对应的错误消息：
 *   1. 构建时 BRIDGE_MODE feature 是否启用；
 *   2. 是否为 claude.ai 订阅用户；
 *   3. OAuth Token 是否包含 profile 作用域（setup-token 和 CLAUDE_CODE_OAUTH_TOKEN 不含）；
 *   4. OAuth 账户信息中是否包含 organizationUuid（GrowthBook 按此字段定向）；
 *   5. GrowthBook 功能开关 tengu_ccr_bridge 是否开启。
 *
 * 背景（CC-1165 / gh-33105）：
 *   GrowthBook 基于 organizationUUID 定向，而 organizationUUID 来自登录时
 *   /api/oauth/profile 接口（需要 user:profile scope）。
 *   缺少此 scope 的 Token（setup-token、环境变量 Token、旧版登录）会导致
 *   organizationUUID 为空，GrowthBook 回落到 false，用户看到无提示的"未启用"消息。
 *   本函数为每种情况提供具体的操作指引。
 *
 * Diagnostic message for why Remote Control is unavailable, or null if
 * it's enabled. Call this instead of a bare `isBridgeEnabledBlocking()`
 * check when you need to show the user an actionable error.
 */
export async function getBridgeDisabledReason(): Promise<string | null> {
  if (feature('BRIDGE_MODE')) {
    if (!isClaudeAISubscriber()) {
      // 非 claude.ai 订阅用户（如 API Key、Bedrock 等）
      return 'Remote Control requires a claude.ai subscription. Run `claude auth login` to sign in with your claude.ai account.'
    }
    if (!hasProfileScope()) {
      // Token 缺少 profile scope（长期 Token 因安全原因仅限推理，不含 Remote Control 权限）
      return 'Remote Control requires a full-scope login token. Long-lived tokens (from `claude setup-token` or CLAUDE_CODE_OAUTH_TOKEN) are limited to inference-only for security reasons. Run `claude auth login` to use Remote Control.'
    }
    if (!getOauthAccountInfo()?.organizationUuid) {
      // organizationUuid 为空，无法确定组织资格（通常是 Token 过旧或登录不完整）
      return 'Unable to determine your organization for Remote Control eligibility. Run `claude auth login` to refresh your account information.'
    }
    if (!(await checkGate_CACHED_OR_BLOCKING('tengu_ccr_bridge'))) {
      // GrowthBook 门控未通过，该账户尚未开放 Remote Control
      return 'Remote Control is not yet enabled for your account.'
    }
    return null // 所有条件满足，Remote Control 可用
  }
  // 外部构建或 BRIDGE_MODE 未启用
  return 'Remote Control is not available in this build.'
}

// try/catch: main.tsx:5698 calls isBridgeEnabled() while defining the Commander
// program, before enableConfigs() runs. isClaudeAISubscriber() → getGlobalConfig()
// throws "Config accessed before allowed" there. Pre-config, no OAuth token can
// exist anyway — false is correct. Same swallow getFeatureValue_CACHED_MAY_BE_STALE
// already does at growthbook.ts:775-780.
//
// 使用 try/catch 的原因：Commander 程序定义阶段（main.tsx:5698）会调用
// isBridgeEnabled()，此时 enableConfigs() 尚未运行，
// isClaudeAISubscriber() → getGlobalConfig() 会抛出"Config accessed before allowed"。
// 在 config 加载前不可能有 OAuth Token，返回 false 是正确行为。

/**
 * 安全包装 authModule.isClaudeAISubscriber()，防止配置未初始化时抛出异常。
 *
 * 在 Commander 程序定义阶段（enableConfigs 运行前）调用时，
 * getGlobalConfig() 会抛错，此处捕获后返回 false（符合预期：此时无 OAuth Token）。
 */
function isClaudeAISubscriber(): boolean {
  try {
    return authModule.isClaudeAISubscriber()
  } catch {
    return false // config 未初始化时，视为非订阅用户
  }
}

/**
 * 安全包装 authModule.hasProfileScope()，防止配置未初始化时抛出异常。
 */
function hasProfileScope(): boolean {
  try {
    return authModule.hasProfileScope()
  } catch {
    return false // config 未初始化时，视为无 profile scope
  }
}

/**
 * 安全包装 authModule.getOauthAccountInfo()，防止配置未初始化时抛出异常。
 */
function getOauthAccountInfo(): ReturnType<
  typeof authModule.getOauthAccountInfo
> {
  try {
    return authModule.getOauthAccountInfo()
  } catch {
    return undefined // config 未初始化时，视为无账户信息
  }
}

/**
 * 检查 v2（无环境变量）REPL Bridge 路径是否已启用。
 *
 * 通过 GrowthBook 功能开关 tengu_bridge_repl_v2 控制，
 * 决定 initReplBridge 使用哪种实现——而非 Bridge 本身是否可用（见 isBridgeEnabled）。
 * Daemon/print 路径不受此开关影响，始终使用基于环境变量的实现。
 *
 * Runtime check for the env-less (v2) REPL bridge path.
 * Returns true when the GrowthBook flag `tengu_bridge_repl_v2` is enabled.
 *
 * This gates which implementation initReplBridge uses — NOT whether bridge
 * is available at all (see isBridgeEnabled above). Daemon/print paths stay
 * on the env-based implementation regardless of this gate.
 */
export function isEnvLessBridgeEnabled(): boolean {
  return feature('BRIDGE_MODE')
    ? getFeatureValue_CACHED_MAY_BE_STALE('tengu_bridge_repl_v2', false)
    : false
}

/**
 * 检查 cse_* → session_* 客户端 ID 转换 shim 是否已启用。
 *
 * 背景：compat/convert.go:27 校验 TagSession 且 claude.ai 前端按 session_* 路由，
 * 而 v2 worker 端点下发的是 cse_* 格式的 ID。此 shim 在客户端做兼容转换。
 * 当服务端按 environment_kind 打标签且前端直接接受 cse_* 后，
 * 可将此开关改为 false，使 toCompatSessionId 变为空操作。
 * 默认值为 true（shim 保持激活，直到明确禁用）。
 *
 * Kill-switch for the `cse_*` → `session_*` client-side retag shim.
 */
export function isCseShimEnabled(): boolean {
  return feature('BRIDGE_MODE')
    ? getFeatureValue_CACHED_MAY_BE_STALE(
        'tengu_bridge_repl_v2_cse_shim_enabled',
        true, // 默认启用 shim
      )
    : true // 外部构建也默认启用（不影响外部用户）
}

/**
 * 检查当前 CLI 版本是否满足 v1（基于环境变量）Remote Control 路径的最低版本要求。
 *
 * 使用缓存的（非阻塞）GrowthBook 动态配置 tengu_bridge_min_version。
 * 若 GrowthBook 尚未加载，默认版本 '0.0.0' 意味着检查通过（安全回落）。
 * v2（无环境变量）路径使用 envLessBridgeConfig.ts 中的 checkEnvLessBridgeMinVersion()，
 * 两者版本下限独立。
 *
 * 返回值：版本不满足时返回用户可读的错误消息，满足时返回 null。
 *
 * Returns an error message if the current CLI version is below the
 * minimum required for the v1 (env-based) Remote Control path, or null if the
 * version is fine.
 */
export function checkBridgeMinVersion(): string | null {
  // Positive pattern — see docs/feature-gating.md.
  // Negative pattern (if (!feature(...)) return) does not eliminate
  // inline string literals from external builds.
  // 正向判断模式：外部构建中不残留 GrowthBook 字符串字面量
  if (feature('BRIDGE_MODE')) {
    const config = getDynamicConfig_CACHED_MAY_BE_STALE<{
      minVersion: string
    }>('tengu_bridge_min_version', { minVersion: '0.0.0' }) // 默认 0.0.0 表示无版本限制
    if (config.minVersion && lt(MACRO.VERSION, config.minVersion)) {
      // 当前版本低于最低要求版本，提示用户更新
      return `Your version of Claude Code (${MACRO.VERSION}) is too old for Remote Control.\nVersion ${config.minVersion} or higher is required. Run \`claude update\` to update.`
    }
  }
  return null // 版本满足要求
}

/**
 * 获取 remoteControlAtStartup 配置项的默认值（用于 CCR 自动连接功能）。
 *
 * 当 CCR_AUTO_CONNECT 构建 flag 存在（仅 ant 内部）且 GrowthBook 功能开关
 * tengu_cobalt_harbor 开启时，所有会话默认自动连接到 CCR。
 * 用户仍可通过在 config 中显式设置 remoteControlAtStartup=false 来关闭此行为
 * （显式配置始终优先于此默认值）。
 *
 * 定义在此处而非 config.ts 是为了避免
 * config.ts → growthbook.ts → user.ts → config.ts 的循环依赖。
 *
 * Default for remoteControlAtStartup when the user hasn't explicitly set it.
 * When the CCR_AUTO_CONNECT build flag is present (ant-only) and the
 * tengu_cobalt_harbor GrowthBook gate is on, all sessions connect to CCR by
 * default — the user can still opt out by setting remoteControlAtStartup=false
 * in config (explicit settings always win over this default).
 */
export function getCcrAutoConnectDefault(): boolean {
  return feature('CCR_AUTO_CONNECT')
    ? getFeatureValue_CACHED_MAY_BE_STALE('tengu_cobalt_harbor', false)
    : false // 非 ant 内部构建，默认不自动连接
}

/**
 * 检查 CCR 镜像模式是否已启用。
 *
 * 镜像模式：每个本地会话同时生成一个仅出站的 Remote Control 会话，
 * 接收转发的事件。与 getCcrAutoConnectDefault 的双向 Remote Control 不同，
 * 镜像模式是单向只读的。
 *
 * 激活条件（满足任一即可）：
 *   - 环境变量 CLAUDE_CODE_CCR_MIRROR 为真值（本地开发者手动开启）；
 *   - GrowthBook 功能开关 tengu_ccr_mirror 已开启（灰度发布控制）。
 *
 * Opt-in CCR mirror mode — every local session spawns an outbound-only
 * Remote Control session that receives forwarded events. Separate from
 * getCcrAutoConnectDefault (bidirectional Remote Control). Env var wins for
 * local opt-in; GrowthBook controls rollout.
 */
export function isCcrMirrorEnabled(): boolean {
  return feature('CCR_MIRROR')
    ? isEnvTruthy(process.env.CLAUDE_CODE_CCR_MIRROR) || // 环境变量优先
        getFeatureValue_CACHED_MAY_BE_STALE('tengu_ccr_mirror', false) // 回落到 GrowthBook
    : false // CCR_MIRROR 构建 flag 未启用
}
