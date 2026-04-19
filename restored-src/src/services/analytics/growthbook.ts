/**
 * 【GrowthBook 功能开关与动态配置模块】analytics/growthbook.ts
 *
 * 在 Claude Code 系统流程中的位置：
 * - 属于分析（analytics）子系统，是所有功能开关（feature gate）和动态配置（dynamic config）的统一入口
 * - 由 sink.ts、firstPartyEventLogger.ts、main.tsx 等多个模块依赖，为全局功能路由提供决策依据
 * - 依赖 firstPartyEventLogger.ts 的 is1PEventLoggingEnabled() 决定是否启用 GrowthBook
 * - 在 main.tsx 启动时通过 initializeGrowthBook() 完成初始化，建立 GrowthBook SDK 客户端
 *
 * 核心功能：
 * - GrowthBook 客户端管理：创建（memoized）、初始化（带 5s 超时）、销毁、重置
 * - 特征值读取：getFeatureValue_CACHED_MAY_BE_STALE()（同步，磁盘缓存回退）、getFeatureValue_DEPRECATED()（异步阻塞）
 * - 动态配置读取：getDynamicConfig_CACHED_MAY_BE_STALE()、getDynamicConfig_BLOCKS_ON_INIT()
 * - 安全门控：checkSecurityRestrictionGate()（等待重新初始化完成）、checkGate_CACHED_OR_BLOCKING()
 * - 实验曝光日志：logExposureForFeature() — 每个功能每会话最多记录一次，去重写入 1P
 * - 本地覆盖：环境变量（CLAUDE_INTERNAL_FC_OVERRIDES）+ 磁盘配置（/config Gates 面板，ant only）
 * - 周期性刷新：外部用户每 6 小时、Ant 员工每 20 分钟轻量刷新（不重建客户端）
 * - Auth 变更响应：refreshGrowthBookAfterAuthChange() — 销毁并重建客户端，订阅者接收通知
 * - 远端 Eval 负载处理：processRemoteEvalPayload() 修复 SDK Bug（value vs defaultValue）、缓存结果
 * - 磁盘缓存同步：syncRemoteEvalToDisk() 在每次成功 payload 后整体替换 cachedGrowthBookFeatures
 * - 刷新订阅：onGrowthBookRefresh() — 支持后注册时的追赶触发（解决快网络 #20951 race）
 */

import { GrowthBook } from '@growthbook/growthbook'
import { isEqual, memoize } from 'lodash-es'
import {
  getIsNonInteractiveSession,
  getSessionTrustAccepted,
} from '../../bootstrap/state.js'
import { getGrowthBookClientKey } from '../../constants/keys.js'
import {
  checkHasTrustDialogAccepted,
  getGlobalConfig,
  saveGlobalConfig,
} from '../../utils/config.js'
import { logForDebugging } from '../../utils/debug.js'
import { toError } from '../../utils/errors.js'
import { getAuthHeaders } from '../../utils/http.js'
import { logError } from '../../utils/log.js'
import { createSignal } from '../../utils/signal.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import {
  type GitHubActionsMetadata,
  getUserForGrowthBook,
} from '../../utils/user.js'
import {
  is1PEventLoggingEnabled,
  logGrowthBookExperimentTo1P,
} from './firstPartyEventLogger.js'

/**
 * 发送给 GrowthBook 的用户属性（用于 feature targeting）
 *
 * 使用 UUID 后缀（而非 Uuid）以符合 GrowthBook 的命名惯例。
 * cacheKeyAttributes 配置为 ['id', 'organizationUUID']，
 * 切换到不同组织时会触发客户端重新拉取功能标志。
 */
export type GrowthBookUserAttributes = {
  id: string
  sessionId: string
  deviceID: string
  platform: 'win32' | 'darwin' | 'linux'
  apiBaseUrlHost?: string
  organizationUUID?: string
  accountUUID?: string
  userType?: string
  subscriptionType?: string
  rateLimitTier?: string
  firstTokenTime?: number
  email?: string
  appVersion?: string
  github?: GitHubActionsMetadata
}

/**
 * API 返回的畸形功能定义格式
 *
 * API 当前使用 "value" 而非 SDK 期望的 "defaultValue"，
 * processRemoteEvalPayload() 中有专门的 workaround 进行转换，
 * 等 API 修复后可移除该类型和相关转换逻辑。
 */
type MalformedFeatureDefinition = {
  value?: unknown
  defaultValue?: unknown
  [key: string]: unknown
}

// 模块级 GrowthBook 客户端单例（null = 未初始化或已禁用）
let client: GrowthBook | null = null

// 命名的退出处理器引用，使 resetGrowthBook() 能精确移除，防止 handler 累积
let currentBeforeExitHandler: (() => void) | null = null
let currentExitHandler: (() => void) | null = null

// 记录客户端创建时是否具有 auth，用于检测 auth 变更后是否需要重建客户端
let clientCreatedWithAuth = false

// 存储每个功能对应的实验数据，用于在功能被访问时补记曝光日志
type StoredExperimentData = {
  experimentId: string
  variationId: number
  inExperiment?: boolean
  hashAttribute?: string
  hashValue?: string
}
// key: feature 名称 → value: 实验数据
const experimentDataByFeature = new Map<string, StoredExperimentData>()

// remoteEval 功能值缓存：SDK 存在 Bug 不能正确使用远端预评估结果，手动缓存绕过
const remoteEvalFeatureValues = new Map<string, unknown>()

// 在初始化完成前被访问的功能集合，初始化后补记曝光日志
const pendingExposures = new Set<string>()

// 已记录曝光的功能集合（会话内去重），防止热路径（如 isAutoMemoryEnabled 在渲染循环中）重复上报
const loggedExposures = new Set<string>()

// 重新初始化中的 Promise（auth 变更触发），安全门控函数等待它完成以获取最新值
let reinitializingPromise: Promise<unknown> | null = null

// 刷新订阅信号（Signal 模式），GrowthBook 功能值刷新时通知所有监听器
// 注意：resetGrowthBook() 不清空此集合，订阅者注册一次后跨 auth 变更存活
type GrowthBookRefreshListener = () => void | Promise<void>
const refreshed = createSignal()

/**
 * 安全调用监听器：同步异常和异步 rejection 均路由到 logError
 *
 * Promise.resolve() 将同步返回值和 Promise 标准化，
 * 使得同步 throw（外层 try/catch）和异步 rejection（.catch）都能被捕获。
 * 若没有 .catch，异步监听器的 rejection 会成为未处理的 Promise rejection。
 */
function callSafe(listener: GrowthBookRefreshListener): void {
  try {
    // Promise.resolve() normalizes sync returns and Promises so both
    // sync throws (caught by outer try) and async rejections (caught
    // by .catch) hit logError. Without the .catch, an async listener
    // that rejects becomes an unhandled rejection — the try/catch
    // only sees the Promise, not its eventual rejection.
    void Promise.resolve(listener()).catch(e => {
      logError(e)
    })
  } catch (e) {
    logError(e)
  }
}

/**
 * 注册 GrowthBook 功能值刷新回调，返回取消订阅函数
 *
 * 追赶触发（catch-up）机制：
 * 若 onGrowthBookRefresh() 被调用时 remoteEvalFeatureValues 已有数据（init 已完成），
 * 监听器在下一个 microtask 中触发一次。
 * 这解决了快网络 + 慢 MCP 配置下 GB 初始化（~100ms）早于 REPL 挂载（~600ms）的竞态。
 * （见 #20951 外部构建 trace：30.540 vs 31.046）
 *
 * 变更检测由订阅者负责：回调在每次刷新时触发，
 * 订阅者应将当前配置与上次快照用 isEqual 比较后再决定是否响应。
 */
export function onGrowthBookRefresh(
  listener: GrowthBookRefreshListener,
): () => void {
  let subscribed = true
  const unsubscribe = refreshed.subscribe(() => callSafe(listener))
  // 若已有数据，在下一个 microtask 触发一次（追赶触发）
  if (remoteEvalFeatureValues.size > 0) {
    queueMicrotask(() => {
      // 重新检查：监听器可能在注册和 microtask 执行之间已被移除，
      // 或 resetGrowthBook() 已清空 Map
      if (subscribed && remoteEvalFeatureValues.size > 0) {
        callSafe(listener)
      }
    })
  }
  return () => {
    subscribed = false
    unsubscribe()
  }
}

/**
 * 解析环境变量中的 GrowthBook 功能覆盖（CLAUDE_INTERNAL_FC_OVERRIDES）
 *
 * 仅对 USER_TYPE=ant 生效，用于测评框架（eval harness）固定特定功能标志配置。
 * 示例：CLAUDE_INTERNAL_FC_OVERRIDES='{"my_feature": true, "my_config": {"key": "val"}}'
 *
 * 解析结果缓存（envOverridesParsed 标志），避免重复 JSON.parse。
 * 优先级：环境变量覆盖 > 磁盘配置覆盖 > 远端 eval 值 > 磁盘缓存
 */
let envOverrides: Record<string, unknown> | null = null
let envOverridesParsed = false

function getEnvOverrides(): Record<string, unknown> | null {
  if (!envOverridesParsed) {
    envOverridesParsed = true
    // 只对 Ant 员工生效，防止外部用户误用
    if (process.env.USER_TYPE === 'ant') {
      const raw = process.env.CLAUDE_INTERNAL_FC_OVERRIDES
      if (raw) {
        try {
          envOverrides = JSON.parse(raw) as Record<string, unknown>
          logForDebugging(
            `GrowthBook: Using env var overrides for ${Object.keys(envOverrides!).length} features: ${Object.keys(envOverrides!).join(', ')}`,
          )
        } catch {
          logError(
            new Error(
              `GrowthBook: Failed to parse CLAUDE_INTERNAL_FC_OVERRIDES: ${raw}`,
            ),
          )
        }
      }
    }
  }
  return envOverrides
}

/**
 * 检查某个功能是否有环境变量覆盖（CLAUDE_INTERNAL_FC_OVERRIDES）
 *
 * 返回 true 时，_CACHED_MAY_BE_STALE 直接返回覆盖值，无需等待 init。
 * 调用方可通过此函数跳过对 init 的等待（适用于覆盖了关键标志的测评场景）。
 */
export function hasGrowthBookEnvOverride(feature: string): boolean {
  const overrides = getEnvOverrides()
  return overrides !== null && feature in overrides
}

/**
 * 读取本地磁盘配置中的功能覆盖（/config Gates 面板，仅 ant 可用）
 *
 * 优先级低于环境变量覆盖（env wins），确保测评框架的确定性。
 * 不做 memoize：用户可在运行时修改，且 getGlobalConfig() 已做内存缓存。
 * getGlobalConfig() 在 configReadingAllowed 设置前会抛出异常，
 * catch 后退化为无覆盖（与磁盘缓存回退行为一致）。
 */
function getConfigOverrides(): Record<string, unknown> | undefined {
  if (process.env.USER_TYPE !== 'ant') return undefined
  try {
    return getGlobalConfig().growthBookOverrides
  } catch {
    // getGlobalConfig() throws before configReadingAllowed is set (early
    // main.tsx startup path). Same degrade as the disk-cache fallback below.
    return undefined
  }
}

/**
 * 枚举所有已知的 GrowthBook 功能及其当前解析值
 *
 * 优先从内存 payload 读取，回退到磁盘缓存（与各 getter 优先级相同）。
 * 用于 /config Gates 面板展示所有功能开关状态。
 */
export function getAllGrowthBookFeatures(): Record<string, unknown> {
  if (remoteEvalFeatureValues.size > 0) {
    return Object.fromEntries(remoteEvalFeatureValues)
  }
  return getGlobalConfig().cachedGrowthBookFeatures ?? {}
}

export function getGrowthBookConfigOverrides(): Record<string, unknown> {
  return getConfigOverrides() ?? {}
}

/**
 * 设置或清除单个磁盘配置覆盖
 *
 * 传入 undefined 为清除操作。
 * 设置后触发 refreshed.emit() 通知订阅者，使长期对象（如 useMainLoopModel）
 * 立即重建，而非等到下次周期性刷新。
 * 若值未变化（isEqual 检查），跳过 saveGlobalConfig 但仍触发 emit
 * （订阅者自行做变更检测，无谓触发是可接受的）。
 */
export function setGrowthBookConfigOverride(
  feature: string,
  value: unknown,
): void {
  if (process.env.USER_TYPE !== 'ant') return
  try {
    saveGlobalConfig(c => {
      const current = c.growthBookOverrides ?? {}
      if (value === undefined) {
        // 清除覆盖：若键不存在则幂等返回
        if (!(feature in current)) return c
        const { [feature]: _, ...rest } = current
        // 若 rest 为空则删除整个 growthBookOverrides 键
        if (Object.keys(rest).length === 0) {
          const { growthBookOverrides: __, ...configWithout } = c
          return configWithout
        }
        return { ...c, growthBookOverrides: rest }
      }
      // 值未变化则跳过写磁盘
      if (isEqual(current[feature], value)) return c
      return { ...c, growthBookOverrides: { ...current, [feature]: value } }
    })
    // 订阅者做自己的变更检测（见 onGrowthBookRefresh 文档），空操作触发是可接受的
    refreshed.emit()
  } catch (e) {
    logError(e)
  }
}

export function clearGrowthBookConfigOverrides(): void {
  if (process.env.USER_TYPE !== 'ant') return
  try {
    saveGlobalConfig(c => {
      if (
        !c.growthBookOverrides ||
        Object.keys(c.growthBookOverrides).length === 0
      ) {
        return c
      }
      const { growthBookOverrides: _, ...rest } = c
      return rest
    })
    refreshed.emit()
  } catch (e) {
    logError(e)
  }
}

/**
 * 记录某个功能的实验曝光日志（会话内去重）
 *
 * 去重机制：loggedExposures Set 确保每个功能在会话中最多触发一次 1P 曝光事件。
 * 这防止了在热渲染路径（如 isAutoMemoryEnabled 在每次 render 中调用）中重复上报。
 * 若功能没有关联的实验数据（experimentDataByFeature 中不存在），静默跳过。
 */
function logExposureForFeature(feature: string): void {
  // 已记录过则跳过（会话内去重）
  if (loggedExposures.has(feature)) {
    return
  }

  const expData = experimentDataByFeature.get(feature)
  if (expData) {
    // 标记为已记录，防止下次调用重复上报
    loggedExposures.add(feature)
    // 将曝光事件上报到 1P 事件日志（GrowthBook 实验专用通道）
    logGrowthBookExperimentTo1P({
      experimentId: expData.experimentId,
      variationId: expData.variationId,
      userAttributes: getUserAttributes(),
      experimentMetadata: {
        feature_id: feature,
      },
    })
  }
}

/**
 * 处理 GrowthBook 服务器返回的远端 Eval Payload 并更新本地缓存
 *
 * 调用时机：
 * - client.init() 完成后（初次加载）
 * - client.refreshFeatures() 完成后（周期性刷新）
 *
 * 关键设计：
 * 若不在 refresh 后重新运行，remoteEvalFeatureValues 会冻结在 init 时的快照，
 * 导致长时间运行的 session 中 getDynamicConfig_BLOCKS_ON_INIT 返回陈旧值，
 * 这会破坏 tengu_max_version_config 等 kill switch 对长会话的生效。
 *
 * API Workaround：
 * 服务端返回 { "value": ... }，但 SDK 期望 { "defaultValue": ... }，
 * 此处手动转换 transformedFeatures 绕过 SDK Bug（TODO: API 修复后移除）。
 *
 * 安全检查：
 * 空 payload（`{features: {}}`，可能是服务端 Bug 或截断响应）会被拒绝（返回 false），
 * 防止清空整个 remoteEvalFeatureValues 导致全功能黑屏。
 *
 * @returns true 表示 payload 有效并已处理，false 表示空或无效 payload（跳过磁盘写入和订阅通知）
 */
async function processRemoteEvalPayload(
  gbClient: GrowthBook,
): Promise<boolean> {
  // WORKAROUND: Transform remote eval response format
  // The API returns { "value": ... } but SDK expects { "defaultValue": ... }
  // TODO: Remove this once the API is fixed to return correct format
  const payload = gbClient.getPayload()
  // 空对象为 truthy — 若不检查 length，`{features: {}}` 会导致清空所有缓存
  if (!payload?.features || Object.keys(payload.features).length === 0) {
    return false
  }

  // 清空后重建，确保服务端删除的 feature 不会留下幽灵条目
  experimentDataByFeature.clear()

  const transformedFeatures: Record<string, MalformedFeatureDefinition> = {}
  for (const [key, feature] of Object.entries(payload.features)) {
    const f = feature as MalformedFeatureDefinition
    // 将旧格式 "value" 转换为 SDK 期望的 "defaultValue"
    if ('value' in f && !('defaultValue' in f)) {
      transformedFeatures[key] = {
        ...f,
        defaultValue: f.value,
      }
    } else {
      transformedFeatures[key] = f
    }

    // 若是实验类型，存储实验数据供后续曝光日志使用
    if (f.source === 'experiment' && f.experimentResult) {
      const expResult = f.experimentResult as {
        variationId?: number
      }
      const exp = f.experiment as { key?: string } | undefined
      if (exp?.key && expResult.variationId !== undefined) {
        experimentDataByFeature.set(key, {
          experimentId: exp.key,
          variationId: expResult.variationId,
        })
      }
    }
  }
  // 将转换后的 features 重新设置到 SDK（setPayload 内部异步，此处 await）
  await gbClient.setPayload({
    ...payload,
    features: transformedFeatures,
  })

  // WORKAROUND: 直接缓存服务端预评估的值，绕过 SDK 的本地重评估 Bug
  remoteEvalFeatureValues.clear()
  for (const [key, feature] of Object.entries(transformedFeatures)) {
    // remoteEval=true 下，服务端已预评估。无论结果在 "value" 还是 "defaultValue" 键，
    // 都是此用户的权威答案。同时检查两者确保在 API 迁移期间也正确。
    const v = 'value' in feature ? feature.value : feature.defaultValue
    if (v !== undefined) {
      remoteEvalFeatureValues.set(key, v)
    }
  }
  return true
}

/**
 * 将完整的 remoteEvalFeatureValues 写入磁盘（cachedGrowthBookFeatures）
 *
 * 设计约束：
 * - 只在成功 processRemoteEvalPayload 后调用，失败路径永不触达此函数，
 *   从根本上杜绝 init 超时时用空 {} 污染磁盘缓存的可能性
 * - 整体替换（非增量合并）：服务端删除的 feature 在下次成功 payload 时从磁盘消失
 * - Ant 构建 ⊇ 外部构建，切换构建版本时安全（写入的始终是当前进程 SDK key 的完整答案）
 * - isEqual 检查：若内容未变则跳过写磁盘，避免不必要的 I/O
 */
function syncRemoteEvalToDisk(): void {
  const fresh = Object.fromEntries(remoteEvalFeatureValues)
  const config = getGlobalConfig()
  // 值未变则跳过磁盘写入
  if (isEqual(config.cachedGrowthBookFeatures, fresh)) {
    return
  }
  saveGlobalConfig(current => ({
    ...current,
    cachedGrowthBookFeatures: fresh,
  }))
}

/**
 * 检查 GrowthBook 是否应启用
 *
 * GrowthBook 依赖 1P 事件日志；若 1P 日志被禁用（第三方云/测试环境/遥测关闭），
 * 则 GrowthBook 也应禁用，避免无意义的初始化和网络请求。
 */
function isGrowthBookEnabled(): boolean {
  // GrowthBook depends on 1P event logging.
  return is1PEventLoggingEnabled()
}

/**
 * 获取 ANTHROPIC_BASE_URL 的主机名（用于 GrowthBook 用户属性）
 *
 * 企业代理部署（Epic/Marble 等）通常使用 apiKeyHelper auth，
 * 导致 organizationUUID/accountUUID/email 均缺失，
 * 此属性作为代理部署的稳定定向属性。
 * - 未设置或指向默认 api.anthropic.com 时返回 undefined（直接 API 用户无此属性）
 * - 只取 hostname，不含 path/query/credentials
 */
export function getApiBaseUrlHost(): string | undefined {
  const baseUrl = process.env.ANTHROPIC_BASE_URL
  if (!baseUrl) return undefined
  try {
    const host = new URL(baseUrl).host
    // 默认端点不需要此属性（只用于区分代理部署）
    if (host === 'api.anthropic.com') return undefined
    return host
  } catch {
    return undefined
  }
}

/**
 * 构建发送给 GrowthBook 的用户属性对象
 *
 * 属性来源：getUserForGrowthBook()（设备 ID、会话 ID、平台等）
 * Ant 特殊处理：即使设置了 ANTHROPIC_API_KEY 也尝试从 OAuth 配置获取 email，
 * 确保 email 定向在任何 auth 方式下均可工作。
 * 使用 spread + undefined guard 的模式：缺失的可选属性不传递给 GrowthBook，
 * 避免空字符串影响 targeting 规则。
 */
function getUserAttributes(): GrowthBookUserAttributes {
  const user = getUserForGrowthBook()

  // For ants, always try to include email from OAuth config even if ANTHROPIC_API_KEY is set.
  // This ensures GrowthBook targeting by email works regardless of auth method.
  let email = user.email
  if (!email && process.env.USER_TYPE === 'ant') {
    email = getGlobalConfig().oauthAccount?.emailAddress
  }

  const apiBaseUrlHost = getApiBaseUrlHost()

  const attributes = {
    id: user.deviceId,
    sessionId: user.sessionId,
    deviceID: user.deviceId,
    platform: user.platform,
    ...(apiBaseUrlHost && { apiBaseUrlHost }),
    ...(user.organizationUuid && { organizationUUID: user.organizationUuid }),
    ...(user.accountUuid && { accountUUID: user.accountUuid }),
    ...(user.userType && { userType: user.userType }),
    ...(user.subscriptionType && { subscriptionType: user.subscriptionType }),
    ...(user.rateLimitTier && { rateLimitTier: user.rateLimitTier }),
    ...(user.firstTokenTime && { firstTokenTime: user.firstTokenTime }),
    ...(email && { email }),
    ...(user.appVersion && { appVersion: user.appVersion }),
    ...(user.githubActionsMetadata && {
      githubActionsMetadata: user.githubActionsMetadata,
    }),
  }
  return attributes
}

/**
 * 获取或创建 GrowthBook 客户端实例（memoize 保证进程内单例）
 *
 * 流程：
 * 1. 检查 isGrowthBookEnabled()，若禁用返回 null
 * 2. 检查 trust 状态，若无 trust 则跳过 HTTP 初始化，依赖磁盘缓存
 * 3. 创建 GrowthBook 实例（remoteEval: true，添加 auth headers）
 * 4. 5s 超时启动 init()，成功后 processRemoteEvalPayload + syncRemoteEvalToDisk + 通知订阅者
 * 5. 注册 beforeExit/exit 处理器清理客户端（命名引用供 resetGrowthBook 移除）
 *
 * 客户端替换保护：
 * init 回调中通过 `client !== thisClient` 检查防止旧客户端的回调操作新客户端。
 * 这在 resetGrowthBook() 期间重新初始化时至关重要。
 */
const getGrowthBookClient = memoize(
  (): { client: GrowthBook; initialized: Promise<void> } | null => {
    if (!isGrowthBookEnabled()) {
      return null
    }

    const attributes = getUserAttributes()
    const clientKey = getGrowthBookClientKey()
    if (process.env.USER_TYPE === 'ant') {
      logForDebugging(
        `GrowthBook: Creating client with clientKey=${clientKey}, attributes: ${jsonStringify(attributes)}`,
      )
    }
    // Ant 员工可通过 CLAUDE_CODE_GB_BASE_URL 覆盖 GrowthBook API 地址（用于内部测试）
    const baseUrl =
      process.env.USER_TYPE === 'ant'
        ? process.env.CLAUDE_CODE_GB_BASE_URL || 'https://api.anthropic.com/'
        : 'https://api.anthropic.com/'

    // Skip auth if trust hasn't been established yet
    // This prevents executing apiKeyHelper commands before the trust dialog
    // Non-interactive sessions implicitly have workspace trust
    // getSessionTrustAccepted() covers the case where the TrustDialog auto-resolved
    // without persisting trust for the specific CWD (e.g., home directory) —
    // showSetupScreens() sets this after the trust dialog flow completes.
    const hasTrust =
      checkHasTrustDialogAccepted() ||
      getSessionTrustAccepted() ||
      getIsNonInteractiveSession()
    const authHeaders = hasTrust
      ? getAuthHeaders()
      : { headers: {}, error: 'trust not established' }
    const hasAuth = !authHeaders.error
    clientCreatedWithAuth = hasAuth

    // Capture in local variable so the init callback operates on THIS client,
    // not a later client if reinitialization happens before init completes
    const thisClient = new GrowthBook({
      apiHost: baseUrl,
      clientKey,
      attributes,
      remoteEval: true,
      // Re-fetch when user ID or org changes (org change = login to different org)
      cacheKeyAttributes: ['id', 'organizationUUID'],
      // Add auth headers if available
      ...(authHeaders.error
        ? {}
        : { apiHostRequestHeaders: authHeaders.headers }),
      // Debug logging for Ants
      ...(process.env.USER_TYPE === 'ant'
        ? {
            log: (msg: string, ctx: Record<string, unknown>) => {
              logForDebugging(`GrowthBook: ${msg} ${jsonStringify(ctx)}`)
            },
          }
        : {}),
    })
    client = thisClient

    if (!hasAuth) {
      // 无 auth 时跳过 HTTP init，依赖磁盘缓存值
      // initializeGrowthBook() 在 auth 可用时会 reset 并重建
      return { client: thisClient, initialized: Promise.resolve() }
    }

    const initialized = thisClient
      .init({ timeout: 5000 }) // 5s 超时，防止网络慢阻塞启动
      .then(async result => {
        // 客户端替换保护：若此客户端已被新客户端替换，跳过回调处理
        if (client !== thisClient) {
          if (process.env.USER_TYPE === 'ant') {
            logForDebugging(
              'GrowthBook: Skipping init callback for replaced client',
            )
          }
          return
        }

        if (process.env.USER_TYPE === 'ant') {
          logForDebugging(
            `GrowthBook initialized successfully, source: ${result.source}, success: ${result.success}`,
          )
        }

        // 处理 remote eval payload，填充 remoteEvalFeatureValues 缓存
        const hadFeatures = await processRemoteEvalPayload(thisClient)
        // processRemoteEvalPayload 内部有 setPayload await，重新检查客户端替换状态
        if (client !== thisClient) return

        if (hadFeatures) {
          // 补记 init 前已被访问的功能的曝光日志
          for (const feature of pendingExposures) {
            logExposureForFeature(feature)
          }
          pendingExposures.clear()
          // 将新 payload 同步到磁盘缓存（整体替换）
          syncRemoteEvalToDisk()
          // 通知订阅者：remoteEvalFeatureValues 已填充，磁盘已同步，值已是最新
          refreshed.emit()
        }

        // Ant 员工调试：记录加载的功能列表
        if (process.env.USER_TYPE === 'ant') {
          const features = thisClient.getFeatures()
          if (features) {
            const featureKeys = Object.keys(features)
            logForDebugging(
              `GrowthBook loaded ${featureKeys.length} features: ${featureKeys.slice(0, 10).join(', ')}${featureKeys.length > 10 ? '...' : ''}`,
            )
          }
        }
      })
      .catch(error => {
        // Ant 员工记录初始化错误（外部用户静默失败，回退磁盘缓存）
        if (process.env.USER_TYPE === 'ant') {
          logError(toError(error))
        }
      })

    // 注册退出处理器（命名引用供 resetGrowthBook 精确移除，防止多次 reset 后累积 handlers）
    currentBeforeExitHandler = () => client?.destroy()
    currentExitHandler = () => client?.destroy()
    process.on('beforeExit', currentBeforeExitHandler)
    process.on('exit', currentExitHandler)

    return { client: thisClient, initialized }
  },
)

/**
 * 初始化 GrowthBook 客户端（阻塞直到就绪）
 *
 * memoize 确保进程内只初始化一次。
 * Auth 变更检测：若客户端创建时无 auth 但现在 auth 已可用，
 * 调用 resetGrowthBook() 销毁旧客户端并重建（因为 apiHostRequestHeaders 创建后不可修改）。
 * 初始化成功后调用 setupPeriodicGrowthBookRefresh() 建立周期性刷新。
 */
export const initializeGrowthBook = memoize(
  async (): Promise<GrowthBook | null> => {
    let clientWrapper = getGrowthBookClient()
    if (!clientWrapper) {
      return null
    }

    // Check if auth has become available since the client was created
    // If so, we need to recreate the client with fresh auth headers
    // Only check if trust is established to avoid triggering apiKeyHelper before trust dialog
    if (!clientCreatedWithAuth) {
      const hasTrust =
        checkHasTrustDialogAccepted() ||
        getSessionTrustAccepted() ||
        getIsNonInteractiveSession()
      if (hasTrust) {
        const currentAuth = getAuthHeaders()
        if (!currentAuth.error) {
          if (process.env.USER_TYPE === 'ant') {
            logForDebugging(
              'GrowthBook: Auth became available after client creation, reinitializing',
            )
          }
          // Use resetGrowthBook to properly destroy old client and stop periodic refresh
          // This prevents double-init where old client's init promise continues running
          resetGrowthBook()
          clientWrapper = getGrowthBookClient()
          if (!clientWrapper) {
            return null
          }
        }
      }
    }

    // 等待 init() 完成（或超时）
    await clientWrapper.initialized

    // 在初始化成功后（或每次重新初始化后）建立周期性刷新
    setupPeriodicGrowthBookRefresh()

    return clientWrapper.client
  },
)

/**
 * 功能值读取内部实现（异步，带 init 等待）
 *
 * 优先级（从高到低）：
 * 1. 环境变量覆盖（CLAUDE_INTERNAL_FC_OVERRIDES）
 * 2. 磁盘配置覆盖（/config Gates 面板）
 * 3. GrowthBook 禁用时返回 defaultValue
 * 4. remoteEvalFeatureValues 内存缓存（SDK workaround）
 * 5. SDK 直接评估（fallback，通常不触达）
 * 6. initializeGrowthBook() 失败时返回 defaultValue
 *
 * logExposure 参数控制是否记录曝光日志（某些内部路径不需要记录）。
 */
async function getFeatureValueInternal<T>(
  feature: string,
  defaultValue: T,
  logExposure: boolean,
): Promise<T> {
  // 检查环境变量覆盖（最高优先级，用于测评框架）
  const overrides = getEnvOverrides()
  if (overrides && feature in overrides) {
    return overrides[feature] as T
  }
  // 检查磁盘配置覆盖（/config Gates 面板）
  const configOverrides = getConfigOverrides()
  if (configOverrides && feature in configOverrides) {
    return configOverrides[feature] as T
  }

  if (!isGrowthBookEnabled()) {
    return defaultValue
  }

  const growthBookClient = await initializeGrowthBook()
  if (!growthBookClient) {
    return defaultValue
  }

  // 优先使用内存缓存（SDK remoteEval bug workaround）
  let result: T
  if (remoteEvalFeatureValues.has(feature)) {
    result = remoteEvalFeatureValues.get(feature) as T
  } else {
    result = growthBookClient.getFeatureValue(feature, defaultValue) as T
  }

  // 按需记录实验曝光日志
  if (logExposure) {
    logExposureForFeature(feature)
  }

  if (process.env.USER_TYPE === 'ant') {
    logForDebugging(
      `GrowthBook: getFeatureValue("${feature}") = ${jsonStringify(result)}`,
    )
  }
  return result
}

/**
 * @deprecated 使用 getFeatureValue_CACHED_MAY_BE_STALE 替代（非阻塞）
 *
 * 此函数会阻塞直到 GrowthBook 初始化完成，可能拖慢启动速度。
 * 适用于不在启动关键路径上、且需要确保最新值的场景。
 */
export async function getFeatureValue_DEPRECATED<T>(
  feature: string,
  defaultValue: T,
): Promise<T> {
  return getFeatureValueInternal(feature, defaultValue, true)
}

/**
 * 从磁盘缓存同步读取功能值（非阻塞，首选方法）
 *
 * 优先级（从高到低）：
 * 1. 环境变量覆盖
 * 2. 磁盘配置覆盖
 * 3. remoteEvalFeatureValues 内存缓存（init 后填充）
 * 4. 磁盘缓存（~/.claude.json 中的 cachedGrowthBookFeatures）
 * 5. defaultValue（磁盘缓存不存在或读取失败时）
 *
 * "CACHED_MAY_BE_STALE" 表示值可能来自上次进程运行，但这对于大多数功能标志是可接受的。
 * 内存缓存（remoteEvalFeatureValues）在 init 后优先，避免重复 JSON 解析，
 * 且是 onGrowthBookRefresh 订阅者依赖的立即读取路径。
 */
export function getFeatureValue_CACHED_MAY_BE_STALE<T>(
  feature: string,
  defaultValue: T,
): T {
  // 检查环境变量覆盖（最高优先级）
  const overrides = getEnvOverrides()
  if (overrides && feature in overrides) {
    return overrides[feature] as T
  }
  const configOverrides = getConfigOverrides()
  if (configOverrides && feature in configOverrides) {
    return configOverrides[feature] as T
  }

  if (!isGrowthBookEnabled()) {
    return defaultValue
  }

  // 记录曝光日志（若实验数据已有则立即记录，否则加入 pendingExposures 等 init 后补记）
  if (experimentDataByFeature.has(feature)) {
    logExposureForFeature(feature)
  } else {
    pendingExposures.add(feature)
  }

  // 内存缓存优先（init 后可用，跳过 JSON 解析，订阅者通知后立即可读新值）
  if (remoteEvalFeatureValues.has(feature)) {
    return remoteEvalFeatureValues.get(feature) as T
  }

  // 磁盘缓存回退（跨进程重启存活）
  try {
    const cached = getGlobalConfig().cachedGrowthBookFeatures?.[feature]
    return cached !== undefined ? (cached as T) : defaultValue
  } catch {
    return defaultValue
  }
}

/**
 * @deprecated 磁盘缓存现已在每次成功 payload（init + 周期刷新）后自动同步
 *
 * 原来的每功能 TTL 只是将内存状态写入磁盘（没有真正的服务器刷新），
 * 现已冗余。直接使用 getFeatureValue_CACHED_MAY_BE_STALE。
 */
export function getFeatureValue_CACHED_WITH_REFRESH<T>(
  feature: string,
  defaultValue: T,
  _refreshIntervalMs: number,
): T {
  return getFeatureValue_CACHED_MAY_BE_STALE(feature, defaultValue)
}

/**
 * 检查 Statsig feature gate 值（兼容层，GrowthBook 迁移专用）
 *
 * 迁移路径：先查 GrowthBook 磁盘缓存，回退到 Statsig 的 cachedStatsigGates。
 * 仅用于从 Statsig 迁移现有 gate，新代码请使用 getFeatureValue_CACHED_MAY_BE_STALE。
 *
 * 同样支持环境变量和磁盘配置覆盖（优先级最高）。
 *
 * @deprecated 新代码使用 getFeatureValue_CACHED_MAY_BE_STALE()
 */
export function checkStatsigFeatureGate_CACHED_MAY_BE_STALE(
  gate: string,
): boolean {
  // 检查环境变量覆盖
  const overrides = getEnvOverrides()
  if (overrides && gate in overrides) {
    return Boolean(overrides[gate])
  }
  const configOverrides = getConfigOverrides()
  if (configOverrides && gate in configOverrides) {
    return Boolean(configOverrides[gate])
  }

  if (!isGrowthBookEnabled()) {
    return false
  }

  // 记录曝光日志（同 CACHED_MAY_BE_STALE 模式）
  if (experimentDataByFeature.has(gate)) {
    logExposureForFeature(gate)
  } else {
    pendingExposures.add(gate)
  }

  // 先查 GrowthBook 缓存
  const config = getGlobalConfig()
  const gbCached = config.cachedGrowthBookFeatures?.[gate]
  if (gbCached !== undefined) {
    return Boolean(gbCached)
  }
  // GrowthBook 无缓存时回退到 Statsig 缓存（迁移过渡期）
  return config.cachedStatsigGates?.[gate] ?? false
}

/**
 * 检查安全限制类 gate（等待重新初始化完成）
 *
 * 用于安全关键的 gate：auth 变更后需要最新值，因此若正在重新初始化则等待完成。
 * 行为：
 * - 若 reinitializingPromise 存在（auth 变更中），等待其完成
 * - 优先检查 Statsig 缓存（安全措施：若 Statsig 认为 gate 启用，尊重此值）
 * - 然后检查 GrowthBook 缓存
 * - 两者均无时返回 false（不阻塞等 init）
 */
export async function checkSecurityRestrictionGate(
  gate: string,
): Promise<boolean> {
  // 检查环境变量覆盖（最高优先级）
  const overrides = getEnvOverrides()
  if (overrides && gate in overrides) {
    return Boolean(overrides[gate])
  }
  const configOverrides = getConfigOverrides()
  if (configOverrides && gate in configOverrides) {
    return Boolean(configOverrides[gate])
  }

  if (!isGrowthBookEnabled()) {
    return false
  }

  // 若正在重新初始化（如 auth 变更后），等待完成以获取最新值
  if (reinitializingPromise) {
    await reinitializingPromise
  }

  // 安全措施：Statsig 缓存优先（可能持有上次登录会话的正确值）
  const config = getGlobalConfig()
  const statsigCached = config.cachedStatsigGates?.[gate]
  if (statsigCached !== undefined) {
    return Boolean(statsigCached)
  }

  // 再查 GrowthBook 缓存
  const gbCached = config.cachedGrowthBookFeatures?.[gate]
  if (gbCached !== undefined) {
    return Boolean(gbCached)
  }

  // 无缓存 — 返回 false（不阻塞 init 等待未缓存的 gate）
  return false
}

/**
 * 带回退阻塞语义的布尔 gate 检查
 *
 * 快速路径：若磁盘缓存已为 true，立即返回（stale true 可接受）。
 * 慢速路径：若磁盘为 false/缺失（可能陈旧），await GrowthBook init 获取最新服务器值（最多 ~5s）。
 *
 * 设计意图：用于用户直接触发的功能（如 /remote-control），基于订阅/组织的 gate，
 * 陈旧的 false 会不公平地阻止访问，但陈旧的 true 可接受（服务端是真正的守门人）。
 */
export async function checkGate_CACHED_OR_BLOCKING(
  gate: string,
): Promise<boolean> {
  // 检查环境变量覆盖
  const overrides = getEnvOverrides()
  if (overrides && gate in overrides) {
    return Boolean(overrides[gate])
  }
  const configOverrides = getConfigOverrides()
  if (configOverrides && gate in configOverrides) {
    return Boolean(configOverrides[gate])
  }

  if (!isGrowthBookEnabled()) {
    return false
  }

  // 快速路径：磁盘缓存已为 true，信任此值
  const cached = getGlobalConfig().cachedGrowthBookFeatures?.[gate]
  if (cached === true) {
    // 记录曝光日志
    if (experimentDataByFeature.has(gate)) {
      logExposureForFeature(gate)
    } else {
      pendingExposures.add(gate)
    }
    return true
  }

  // 慢速路径：磁盘为 false/缺失，可能陈旧，阻塞获取最新值
  return getFeatureValueInternal(gate, false, true)
}

/**
 * auth 变更后刷新 GrowthBook（销毁并重建客户端）
 *
 * 必须销毁重建：GrowthBook 的 apiHostRequestHeaders 创建后不可修改。
 * 流程：
 * 1. resetGrowthBook() — 停止周期刷新、移除 handlers、销毁客户端、清空所有缓存
 * 2. refreshed.emit() — 立即通知订阅者重读（此时回退磁盘缓存）
 * 3. initializeGrowthBook() — 以最新 auth headers 和用户属性重新初始化
 * 4. reinitializingPromise 追踪重新初始化，安全 gate 检查等待它完成
 *
 * 注意：.catch 在 .finally 前，防止 initializeGrowthBook 同步辅助函数抛出时
 * .finally 以 rejection 重新 settle 导致 reinitializingPromise 永远 pending。
 */
export function refreshGrowthBookAfterAuthChange(): void {
  if (!isGrowthBookEnabled()) {
    return
  }

  try {
    // 完全重置客户端，获取新的 auth headers（apiHostRequestHeaders 不可原地修改）
    resetGrowthBook()

    // resetGrowthBook 清空了 remoteEvalFeatureValues。
    // 若下面的重新 init 超时或因无 auth（登出）短路，init 回调中的 notify 永不触发。
    // 此处立即通知确保订阅者至少同步到 reset 后的空状态（回退磁盘缓存）。
    // 若重新 init 成功，订阅者会再次收到新值的通知。
    refreshed.emit()

    // 以最新 auth headers 重新初始化，追踪 Promise 供安全 gate 等待
    reinitializingPromise = initializeGrowthBook()
      .catch(error => {
        logError(toError(error))
        return null
      })
      .finally(() => {
        reinitializingPromise = null
      })
  } catch (error) {
    if (process.env.NODE_ENV === 'development') {
      throw error
    }
    logError(toError(error))
  }
}

/**
 * 重置 GrowthBook 客户端状态（主要用于测试）
 *
 * 完整重置清单：
 * - 停止周期刷新定时器
 * - 移除 beforeExit/exit process handlers（防止累积）
 * - 销毁 GrowthBook 客户端
 * - 清空所有缓存：experimentDataByFeature、pendingExposures、loggedExposures、remoteEvalFeatureValues
 * - 清空 memoize 缓存：getGrowthBookClient、initializeGrowthBook
 * - 重置 reinitializingPromise、clientCreatedWithAuth
 * - 重置环境变量覆盖解析状态
 */
export function resetGrowthBook(): void {
  stopPeriodicGrowthBookRefresh()
  // 移除已命名的 process handlers，防止多次 reset 后 handlers 累积
  if (currentBeforeExitHandler) {
    process.off('beforeExit', currentBeforeExitHandler)
    currentBeforeExitHandler = null
  }
  if (currentExitHandler) {
    process.off('exit', currentExitHandler)
    currentExitHandler = null
  }
  client?.destroy()
  client = null
  clientCreatedWithAuth = false
  reinitializingPromise = null
  experimentDataByFeature.clear()
  pendingExposures.clear()
  loggedExposures.clear()
  remoteEvalFeatureValues.clear()
  // 清空 memoize 缓存，允许下次调用重新创建客户端
  getGrowthBookClient.cache?.clear?.()
  initializeGrowthBook.cache?.clear?.()
  envOverrides = null
  envOverridesParsed = false
}

// 周期性刷新间隔（外部用户 6 小时，Ant 员工 20 分钟，与 Statsig 原有间隔保持一致）
const GROWTHBOOK_REFRESH_INTERVAL_MS =
  process.env.USER_TYPE !== 'ant'
    ? 6 * 60 * 60 * 1000 // 6 小时（外部用户）
    : 20 * 60 * 1000     // 20 分钟（Ant 员工，更快感知配置变更）
let refreshInterval: ReturnType<typeof setInterval> | null = null
let beforeExitListener: (() => void) | null = null

/**
 * 轻量刷新：重新从服务器拉取功能值，不重建客户端
 *
 * 与 refreshGrowthBookAfterAuthChange()（销毁重建）的区别：
 * 保留客户端状态，只拉取最新功能 payload，适用于 auth 未变化的周期刷新。
 *
 * 流程：
 * 1. await growthBookClient.refreshFeatures()（可能 ~5s 网络请求）
 * 2. 客户端替换检查（刷新期间可能发生 auth 变更导致客户端被替换）
 * 3. processRemoteEvalPayload() 更新内存缓存
 * 4. 若 payload 有效：syncRemoteEvalToDisk() + refreshed.emit()
 *
 * 空 payload（可能是服务端问题）时跳过磁盘写入和订阅者通知，
 * 避免不必要的缓存清空和 UI re-render（clearCommandMemoizationCaches + 4× 模型重渲染）。
 */
export async function refreshGrowthBookFeatures(): Promise<void> {
  if (!isGrowthBookEnabled()) {
    return
  }

  try {
    const growthBookClient = await initializeGrowthBook()
    if (!growthBookClient) {
      return
    }

    // 拉取最新功能配置（网络请求）
    await growthBookClient.refreshFeatures()

    // 客户端替换检查：刷新期间可能发生 auth 变更导致客户端被替换
    if (growthBookClient !== client) {
      if (process.env.USER_TYPE === 'ant') {
        logForDebugging(
          'GrowthBook: Skipping refresh processing for replaced client',
        )
      }
      return
    }

    // 用最新 payload 更新 remoteEvalFeatureValues（BLOCKS_ON_INIT 调用者可见新值）
    const hadFeatures = await processRemoteEvalPayload(growthBookClient)
    // processRemoteEvalPayload 内部有 setPayload await，再次检查客户端替换
    if (growthBookClient !== client) return

    if (process.env.USER_TYPE === 'ant') {
      logForDebugging('GrowthBook: Light refresh completed')
    }

    // 仅在 payload 有效时写磁盘和通知订阅者，避免空 payload 导致的无谓 I/O 和 re-render
    if (hadFeatures) {
      syncRemoteEvalToDisk()
      refreshed.emit()
    }
  } catch (error) {
    if (process.env.NODE_ENV === 'development') {
      throw error
    }
    logError(toError(error))
  }
}

/**
 * 建立 GrowthBook 功能值的周期性刷新定时器
 *
 * 调用时机：initializeGrowthBook() 成功后（包括重新初始化后），确保每次 reinit 后都重新建立。
 * setInterval 使用 .unref() 防止定时器阻塞进程退出（进程可以在没有用户活动时正常退出）。
 * 注册 beforeExit 监听器（once）在进程退出前清理定时器。
 */
export function setupPeriodicGrowthBookRefresh(): void {
  if (!isGrowthBookEnabled()) {
    return
  }

  // 清除已有定时器，防止重复（每次 reinit 后都会调用此函数）
  if (refreshInterval) {
    clearInterval(refreshInterval)
  }

  refreshInterval = setInterval(() => {
    void refreshGrowthBookFeatures()
  }, GROWTHBOOK_REFRESH_INTERVAL_MS)

  // Allow process to exit naturally - this timer shouldn't keep the process alive
  refreshInterval.unref?.()

  // 仅注册一次 beforeExit 监听器（多次调用 setupPeriodicGrowthBookRefresh 时不重复注册）
  if (!beforeExitListener) {
    beforeExitListener = () => {
      stopPeriodicGrowthBookRefresh()
    }
    process.once('beforeExit', beforeExitListener)
  }
}

/**
 * 停止周期性刷新（用于测试或清理）
 *
 * 清理定时器句柄和 beforeExit 监听器，
 * 供 resetGrowthBook() 和 beforeExit 回调调用。
 */
export function stopPeriodicGrowthBookRefresh(): void {
  if (refreshInterval) {
    clearInterval(refreshInterval)
    refreshInterval = null
  }
  if (beforeExitListener) {
    process.removeListener('beforeExit', beforeExitListener)
    beforeExitListener = null
  }
}

// ============================================================================
// 动态配置函数（Dynamic Config）
// GrowthBook 中动态配置就是对象类型的 feature，此处提供语义包装保持 Statsig API 兼容性
// ============================================================================

/**
 * 阻塞读取动态配置值（等待 GrowthBook 初始化完成）
 *
 * 优先选用 getFeatureValue_CACHED_MAY_BE_STALE（非阻塞），此函数仅在需要确保最新值时使用。
 * 内部委托给 getFeatureValue_DEPRECATED。
 */
export async function getDynamicConfig_BLOCKS_ON_INIT<T>(
  configName: string,
  defaultValue: T,
): Promise<T> {
  return getFeatureValue_DEPRECATED(configName, defaultValue)
}

/**
 * 从磁盘缓存同步读取动态配置值（首选方法）
 *
 * GrowthBook 中动态配置只是对象类型的 feature。
 * 值可能来自上次进程运行的磁盘缓存（"CACHED_MAY_BE_STALE"）。
 * 适用于启动关键路径和同步上下文。
 * 内部委托给 getFeatureValue_CACHED_MAY_BE_STALE。
 */
export function getDynamicConfig_CACHED_MAY_BE_STALE<T>(
  configName: string,
  defaultValue: T,
): T {
  return getFeatureValue_CACHED_MAY_BE_STALE(configName, defaultValue)
}
