/**
 * Claude AI 配额限制状态管理模块
 *
 * 在 Claude Code 系统流程中的位置：
 *   每次 API 调用后 → extractQuotaStatusFromHeaders() 解析响应头中的限制信息
 *   → 触发 emitStatusChange() 更新全局限制状态
 *   → UI 组件（useClaudeAiLimits hook）实时订阅并展示限额提示
 *
 * 主要功能：
 *  - extractQuotaStatusFromHeaders  — 从响应头解析配额状态（主要调用路径）
 *  - extractQuotaStatusFromError    — 从 429 错误对象解析配额状态
 *  - checkQuotaStatus              — 会话开始前发起最小测试请求，预检配额
 *  - emitStatusChange              — 更新全局 currentLimits 并通知所有监听器
 *  - getRawUtilization             — 获取原始每窗口使用率（供状态栏脚本使用）
 *  - getRateLimitDisplayName       — 返回限速类型的可读名称
 *
 * 设计特点：
 *  - currentLimits：模块级全局状态，初始为 allowed（允许）
 *  - statusListeners：Set 集合，存储所有 UI 监听回调（React hook 通过此机制订阅）
 *  - EARLY_WARNING_CONFIGS：客户端侧早期警告阈值（服务端未发送阈值头时的回退）
 *  - EARLY_WARNING_CLAIM_MAP：将 '5h'/'7d'/'overage' 映射到 RateLimitType
 *  - 从 anthropic-ratelimit-unified-* 响应头族解析所有配额信息
 *  - cacheExtraUsageDisabledReason：将超额禁用原因持久化到全局配置（跨会话保留）
 */

import { APIError } from '@anthropic-ai/sdk'
import type { MessageParam } from '@anthropic-ai/sdk/resources/index.mjs'
import isEqual from 'lodash-es/isEqual.js'
import { getIsNonInteractiveSession } from '../bootstrap/state.js'
import { isClaudeAISubscriber } from '../utils/auth.js'
import { getModelBetas } from '../utils/betas.js'
import { getGlobalConfig, saveGlobalConfig } from '../utils/config.js'
import { logError } from '../utils/log.js'
import { getSmallFastModel } from '../utils/model/model.js'
import { isEssentialTrafficOnly } from '../utils/privacyLevel.js'
import type { AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from './analytics/index.js'
import { logEvent } from './analytics/index.js'
import { getAPIMetadata } from './api/claude.js'
import { getAnthropicClient } from './api/client.js'
import {
  processRateLimitHeaders,
  shouldProcessRateLimits,
} from './rateLimitMocking.js'

// 从 rateLimitMessages 集中导出消息函数
export {
  getRateLimitErrorMessage,
  getRateLimitWarning,
  getUsingOverageText,
} from './rateLimitMessages.js'

/** 配额状态：allowed=允许，allowed_warning=警告，rejected=已拒绝 */
type QuotaStatus = 'allowed' | 'allowed_warning' | 'rejected'

/** 限速维度类型：5小时/7天/7天Opus专用/7天Sonnet专用/超额 */
type RateLimitType =
  | 'five_hour'
  | 'seven_day'
  | 'seven_day_opus'
  | 'seven_day_sonnet'
  | 'overage'

export type { RateLimitType }

/** 单个早期警告触发阈值：使用率和时间进度的组合条件 */
type EarlyWarningThreshold = {
  utilization: number // 0-1：当使用率 >= 此值时触发警告
  timePct: number     // 0-1：当时间窗口已过比例 <= 此值时触发（早期使用过快）
}

/** 某一限速类型的早期警告配置 */
type EarlyWarningConfig = {
  rateLimitType: RateLimitType
  claimAbbrev: '5h' | '7d'      // 对应响应头中的窗口缩写
  windowSeconds: number           // 窗口总秒数
  thresholds: EarlyWarningThreshold[]
}

// 早期警告配置（按优先级排序，从高到低依次检查）
// 当服务端未发送 surpassed-threshold 头时作为回退，客户端计算是否提前警告
// 逻辑：用户在时间窗口内的消耗速率超过窗口允许的最大速率时发出警告
const EARLY_WARNING_CONFIGS: EarlyWarningConfig[] = [
  {
    rateLimitType: 'five_hour',
    claimAbbrev: '5h',
    windowSeconds: 5 * 60 * 60, // 5 小时窗口
    thresholds: [{ utilization: 0.9, timePct: 0.72 }], // 72% 时间内用了 90% 配额
  },
  {
    rateLimitType: 'seven_day',
    claimAbbrev: '7d',
    windowSeconds: 7 * 24 * 60 * 60, // 7 天窗口
    thresholds: [
      { utilization: 0.75, timePct: 0.6 },  // 60% 时间内用了 75% 配额
      { utilization: 0.5, timePct: 0.35 },  // 35% 时间内用了 50% 配额
      { utilization: 0.25, timePct: 0.15 }, // 15% 时间内用了 25% 配额
    ],
  },
]

// 将响应头中的 claim 缩写映射到 RateLimitType（用于基于头的早期警告检测）
const EARLY_WARNING_CLAIM_MAP: Record<string, RateLimitType> = {
  '5h': 'five_hour',
  '7d': 'seven_day',
  overage: 'overage',
}

/** 各限速类型的可读显示名称（用于 UI 提示文本） */
const RATE_LIMIT_DISPLAY_NAMES: Record<RateLimitType, string> = {
  five_hour: 'session limit',
  seven_day: 'weekly limit',
  seven_day_opus: 'Opus limit',
  seven_day_sonnet: 'Sonnet limit',
  overage: 'extra usage limit',
}

/** 获取限速类型的可读名称，未知类型直接返回 type 字符串 */
export function getRateLimitDisplayName(type: RateLimitType): string {
  return RATE_LIMIT_DISPLAY_NAMES[type] || type
}

/**
 * 计算时间窗口已消耗的比例（0-1）。
 * 用于客户端时间相对早期警告的回退逻辑。
 *
 * @param resetsAt - 窗口重置的 Unix 时间戳（秒）
 * @param windowSeconds - 窗口总时长（秒）
 * @returns 已消耗时间占窗口总时长的比例（钳制在 [0, 1]）
 */
function computeTimeProgress(resetsAt: number, windowSeconds: number): number {
  const nowSeconds = Date.now() / 1000
  const windowStart = resetsAt - windowSeconds // 窗口开始时间
  const elapsed = nowSeconds - windowStart       // 已经过的秒数
  // 结果钳制在 [0, 1]，防止时钟偏差导致越界
  return Math.max(0, Math.min(1, elapsed / windowSeconds))
}

// 超额使用被禁用的原因枚举（来自 API 统一限速器的 disabled-reason 头）
export type OverageDisabledReason =
  | 'overage_not_provisioned'       // 该组织或席位等级未配置超额
  | 'org_level_disabled'            // 组织未启用超额
  | 'org_level_disabled_until'      // 组织超额被临时禁用
  | 'out_of_credits'                // 组织信用额度不足
  | 'seat_tier_level_disabled'      // 席位等级不支持超额
  | 'member_level_disabled'         // 特定账号被禁用超额
  | 'seat_tier_zero_credit_limit'   // 席位等级信用上限为零
  | 'group_zero_credit_limit'       // 解析出的组信用上限为零
  | 'member_zero_credit_limit'      // 账号信用上限为零
  | 'org_service_level_disabled'    // 组织服务层面禁用超额
  | 'org_service_zero_credit_limit' // 组织服务信用上限为零
  | 'no_limits_configured'          // 账号无超额配置
  | 'unknown'                       // 未知原因（不应出现）

/** Claude AI 配额限制完整状态类型 */
export type ClaudeAILimits = {
  status: QuotaStatus
  // unifiedRateLimitFallbackAvailable 用于在用户选择 Opus 模型时提示即将用尽配额
  // 注意：该字段不会更改实际使用的模型
  unifiedRateLimitFallbackAvailable: boolean
  resetsAt?: number                         // 限制重置时间（Unix 秒）
  rateLimitType?: RateLimitType             // 触发的限速类型
  utilization?: number                      // 当前使用率（0-1）
  overageStatus?: QuotaStatus               // 超额配额状态
  overageResetsAt?: number                  // 超额配额重置时间
  overageDisabledReason?: OverageDisabledReason // 超额禁用原因
  isUsingOverage?: boolean                  // 是否正在使用超额配额
  surpassedThreshold?: number               // 已超过的阈值（由服务端响应头提供）
}

// 当前全局配额限制状态（初始为允许状态）
// 导出供测试使用
export let currentLimits: ClaudeAILimits = {
  status: 'allowed',
  unifiedRateLimitFallbackAvailable: false,
  isUsingOverage: false,
}

/**
 * 每次 API 响应都更新的原始每窗口使用率。
 * 与 currentLimits.utilization 不同，它在每次响应时都更新，
 * 而 currentLimits.utilization 只在触发警告阈值时才赋值。
 * 通过 getRawUtilization() 暴露给状态栏脚本使用。
 */
type RawWindowUtilization = {
  utilization: number  // 0-1 使用率分数
  resets_at: number    // Unix 秒时间戳
}
type RawUtilization = {
  five_hour?: RawWindowUtilization
  seven_day?: RawWindowUtilization
}
// 原始使用率状态（模块级变量，每次响应后更新）
let rawUtilization: RawUtilization = {}

/** 获取原始每窗口使用率（供外部状态栏脚本订阅）*/
export function getRawUtilization(): RawUtilization {
  return rawUtilization
}

/**
 * 从响应头中提取原始使用率数据（5小时和7天两个窗口）。
 * 只有当两个相关头（utilization 和 reset）都存在时才记录。
 */
function extractRawUtilization(headers: globalThis.Headers): RawUtilization {
  const result: RawUtilization = {}
  for (const [key, abbrev] of [
    ['five_hour', '5h'],
    ['seven_day', '7d'],
  ] as const) {
    const util = headers.get(
      `anthropic-ratelimit-unified-${abbrev}-utilization`,
    )
    const reset = headers.get(`anthropic-ratelimit-unified-${abbrev}-reset`)
    // 两个头均存在时才记录（不完整的数据丢弃）
    if (util !== null && reset !== null) {
      result[key] = { utilization: Number(util), resets_at: Number(reset) }
    }
  }
  return result
}

/** 限制状态变更监听器类型（React hook 或其他订阅方注册的回调） */
type StatusChangeListener = (limits: ClaudeAILimits) => void
/** 所有活跃的状态变更监听器（React hook 通过 useEffect 注册/注销） */
export const statusListeners: Set<StatusChangeListener> = new Set()

/**
 * 更新全局配额限制状态并通知所有订阅者。
 *
 * 流程：
 *  1. 更新模块级 currentLimits 变量
 *  2. 遍历 statusListeners 集合，逐一调用监听回调
 *  3. 计算距重置的小时数，上报 tengu_claudeai_limits_status_changed 分析事件
 */
export function emitStatusChange(limits: ClaudeAILimits) {
  currentLimits = limits // 更新全局状态
  statusListeners.forEach(listener => listener(limits)) // 通知所有 UI 监听器
  // 计算距重置的小时数（取整，用于分析事件）
  const hoursTillReset = Math.round(
    (limits.resetsAt ? limits.resetsAt - Date.now() / 1000 : 0) / (60 * 60),
  )

  // 上报限额状态变更事件（用于监控和分析）
  logEvent('tengu_claudeai_limits_status_changed', {
    status:
      limits.status as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    unifiedRateLimitFallbackAvailable: limits.unifiedRateLimitFallbackAvailable,
    hoursTillReset,
  })
}

/**
 * 发起最小化测试查询（单 token 请求），用于在会话前预检配额。
 * 使用 asResponse() 获取原始响应对象以便读取响应头。
 */
async function makeTestQuery() {
  const model = getSmallFastModel() // 使用最小快速模型减少配额消耗
  const anthropic = await getAnthropicClient({
    maxRetries: 0, // 不重试，快速失败
    model,
    source: 'quota_check',
  })
  const messages: MessageParam[] = [{ role: 'user', content: 'quota' }]
  const betas = getModelBetas(model)
  // biome-ignore lint/plugin: 配额检查需要通过 asResponse() 访问原始响应头
  return anthropic.beta.messages
    .create({
      model,
      max_tokens: 1, // 最小 token 数，仅用于触发响应头返回
      messages,
      metadata: getAPIMetadata(),
      ...(betas.length > 0 ? { betas } : {}),
    })
    .asResponse()
}

/**
 * 在会话开始前检查配额状态（预检）。
 *
 * 跳过条件（任一满足则跳过）：
 *  - 仅基础流量模式（isEssentialTrafficOnly）
 *  - 非订阅用户（shouldProcessRateLimits 返回 false）
 *  - 非交互式模式（-p）：真实查询会紧跟发出，其响应头会更新限制状态
 *
 * 成功时从响应头提取配额状态；失败时（429 等）从错误对象提取。
 */
export async function checkQuotaStatus(): Promise<void> {
  // 仅基础流量模式下跳过非必要网络请求
  if (isEssentialTrafficOnly()) {
    return
  }

  // 非订阅用户或 mock 测试以外的情况不处理限速
  if (!shouldProcessRateLimits(isClaudeAISubscriber())) {
    return
  }

  // 非交互式模式（-p）：紧随其后的真实查询会通过 claude.ts 中的
  // extractQuotaStatusFromHeaders() 更新限制状态，无需预检
  if (getIsNonInteractiveSession()) {
    return
  }

  try {
    // 发起最小测试请求，仅用于触发响应头返回
    const raw = await makeTestQuery()

    // 从响应头更新配额状态
    extractQuotaStatusFromHeaders(raw.headers)
  } catch (error) {
    if (error instanceof APIError) {
      // API 错误（如 429）：从错误对象的响应头中提取限制状态
      extractQuotaStatusFromError(error)
    }
  }
}

/**
 * 基于服务端 surpassed-threshold 头的早期警告检测。
 *
 * 遍历 EARLY_WARNING_CLAIM_MAP 中的所有 claim 类型，
 * 如果找到对应的 surpassed-threshold 头，则返回警告状态。
 *
 * @returns ClaudeAILimits（警告状态），未检测到时返回 null
 */
function getHeaderBasedEarlyWarning(
  headers: globalThis.Headers,
  unifiedRateLimitFallbackAvailable: boolean,
): ClaudeAILimits | null {
  // 检查每个 claim 类型是否有 surpassed-threshold 头
  for (const [claimAbbrev, rateLimitType] of Object.entries(
    EARLY_WARNING_CLAIM_MAP,
  )) {
    const surpassedThreshold = headers.get(
      `anthropic-ratelimit-unified-${claimAbbrev}-surpassed-threshold`,
    )

    // 找到 surpassed-threshold 头：用户已超过某个警告阈值
    if (surpassedThreshold !== null) {
      const utilizationHeader = headers.get(
        `anthropic-ratelimit-unified-${claimAbbrev}-utilization`,
      )
      const resetHeader = headers.get(
        `anthropic-ratelimit-unified-${claimAbbrev}-reset`,
      )

      // 解析使用率和重置时间（头不存在则为 undefined）
      const utilization = utilizationHeader
        ? Number(utilizationHeader)
        : undefined
      const resetsAt = resetHeader ? Number(resetHeader) : undefined

      return {
        status: 'allowed_warning',
        resetsAt,
        rateLimitType: rateLimitType as RateLimitType,
        utilization,
        unifiedRateLimitFallbackAvailable,
        isUsingOverage: false,
        surpassedThreshold: Number(surpassedThreshold), // 已超过的具体阈值
      }
    }
  }

  return null // 未检测到任何 surpassed-threshold 头
}

/**
 * 客户端时间相对早期警告检测（服务端不发送 surpassed-threshold 头时的回退）。
 *
 * 逻辑：当用户在窗口较早期就消耗了较大比例的配额时发出警告
 * （即消耗速率超过窗口均匀分配的速率）。
 *
 * @param config - 某一限速类型的警告配置（阈值组合）
 * @returns ClaudeAILimits（警告状态），未超阈值时返回 null
 */
function getTimeRelativeEarlyWarning(
  headers: globalThis.Headers,
  config: EarlyWarningConfig,
  unifiedRateLimitFallbackAvailable: boolean,
): ClaudeAILimits | null {
  const { rateLimitType, claimAbbrev, windowSeconds, thresholds } = config

  const utilizationHeader = headers.get(
    `anthropic-ratelimit-unified-${claimAbbrev}-utilization`,
  )
  const resetHeader = headers.get(
    `anthropic-ratelimit-unified-${claimAbbrev}-reset`,
  )

  // 缺少必要头时无法计算，直接返回 null
  if (utilizationHeader === null || resetHeader === null) {
    return null
  }

  const utilization = Number(utilizationHeader)
  const resetsAt = Number(resetHeader)
  // 计算当前时间点在窗口中的进度（0=刚开始，1=即将重置）
  const timeProgress = computeTimeProgress(resetsAt, windowSeconds)

  // 检查是否有任一阈值被超过：高使用率发生在窗口早期
  const shouldWarn = thresholds.some(
    t => utilization >= t.utilization && timeProgress <= t.timePct,
  )

  if (!shouldWarn) {
    return null
  }

  return {
    status: 'allowed_warning',
    resetsAt,
    rateLimitType,
    utilization,
    unifiedRateLimitFallbackAvailable,
    isUsingOverage: false,
  }
}

/**
 * 组合早期警告检测：优先使用服务端头，回退到客户端时间相对计算。
 *
 * 流程：
 *  1. 首先尝试基于 surpassed-threshold 头的检测（服务端推荐方式）
 *  2. 如未检测到，遍历 EARLY_WARNING_CONFIGS 进行客户端时间相对计算
 *  3. 两种方式均未触发则返回 null（无需提前警告）
 */
function getEarlyWarningFromHeaders(
  headers: globalThis.Headers,
  unifiedRateLimitFallbackAvailable: boolean,
): ClaudeAILimits | null {
  // 优先使用服务端 surpassed-threshold 头（准确可靠）
  const headerBasedWarning = getHeaderBasedEarlyWarning(
    headers,
    unifiedRateLimitFallbackAvailable,
  )
  if (headerBasedWarning) {
    return headerBasedWarning
  }

  // 回退：使用客户端时间相对阈值（捕获"烧配额"行为）
  for (const config of EARLY_WARNING_CONFIGS) {
    const timeRelativeWarning = getTimeRelativeEarlyWarning(
      headers,
      config,
      unifiedRateLimitFallbackAvailable,
    )
    if (timeRelativeWarning) {
      return timeRelativeWarning
    }
  }

  return null
}

/**
 * 从响应头构建完整的 ClaudeAILimits 状态对象。
 *
 * 解析的响应头族（anthropic-ratelimit-unified-*）：
 *  - status: 当前配额状态（allowed/allowed_warning/rejected）
 *  - reset: 限制重置时间戳
 *  - fallback: 是否有备用限制可用
 *  - representative-claim: 当前触发的限速类型
 *  - overage-status: 超额配额状态
 *  - overage-reset: 超额配额重置时间
 *  - overage-disabled-reason: 超额被禁用的原因
 *
 * isUsingOverage 判断：主配额已拒绝，但超额配额仍允许时为 true。
 */
function computeNewLimitsFromHeaders(
  headers: globalThis.Headers,
): ClaudeAILimits {
  // 解析基本配额状态（默认 allowed）
  const status =
    (headers.get('anthropic-ratelimit-unified-status') as QuotaStatus) ||
    'allowed'
  const resetsAtHeader = headers.get('anthropic-ratelimit-unified-reset')
  const resetsAt = resetsAtHeader ? Number(resetsAtHeader) : undefined
  // 是否有备用限制（通常为 Opus 降级至 Sonnet 等）
  const unifiedRateLimitFallbackAvailable =
    headers.get('anthropic-ratelimit-unified-fallback') === 'available'

  // 解析限速类型和超额支持相关头
  const rateLimitType = headers.get(
    'anthropic-ratelimit-unified-representative-claim',
  ) as RateLimitType | null
  const overageStatus = headers.get(
    'anthropic-ratelimit-unified-overage-status',
  ) as QuotaStatus | null
  const overageResetsAtHeader = headers.get(
    'anthropic-ratelimit-unified-overage-reset',
  )
  const overageResetsAt = overageResetsAtHeader
    ? Number(overageResetsAtHeader)
    : undefined

  // 超额被禁用的原因（消费上限或余额不足等）
  const overageDisabledReason = headers.get(
    'anthropic-ratelimit-unified-overage-disabled-reason',
  ) as OverageDisabledReason | null

  // isUsingOverage 判断：标准配额已拒绝，但超额配额仍允许（正在使用超额）
  const isUsingOverage =
    status === 'rejected' &&
    (overageStatus === 'allowed' || overageStatus === 'allowed_warning')

  // 在 allowed/allowed_warning 状态下检查是否需要提前警告
  // 若检测到早期警告阈值，提前将状态升级为 allowed_warning
  let finalStatus: QuotaStatus = status
  if (status === 'allowed' || status === 'allowed_warning') {
    const earlyWarning = getEarlyWarningFromHeaders(
      headers,
      unifiedRateLimitFallbackAvailable,
    )
    if (earlyWarning) {
      // 返回早期警告状态（包含触发阈值的限速类型信息）
      return earlyWarning
    }
    // 未触发任何早期警告，保持 allowed 状态（不保留 allowed_warning）
    finalStatus = 'allowed'
  }

  // 构造最终 ClaudeAILimits 对象（使用条件展开避免写入 undefined 字段）
  return {
    status: finalStatus,
    resetsAt,
    unifiedRateLimitFallbackAvailable,
    ...(rateLimitType && { rateLimitType }),
    ...(overageStatus && { overageStatus }),
    ...(overageResetsAt && { overageResetsAt }),
    ...(overageDisabledReason && { overageDisabledReason }),
    isUsingOverage,
  }
}

/**
 * 将超额使用禁用原因持久化到全局配置（跨会话保留）。
 *
 * null 原因表示超额使用已启用（没有 disabled-reason 头）。
 * 只有值发生变化时才写入配置，避免不必要的磁盘 IO。
 */
function cacheExtraUsageDisabledReason(headers: globalThis.Headers): void {
  // 获取超额禁用原因（null 表示未被禁用，即超额可用）
  const reason =
    headers.get('anthropic-ratelimit-unified-overage-disabled-reason') ?? null
  const cached = getGlobalConfig().cachedExtraUsageDisabledReason
  // 只在值变化时写入，避免频繁磁盘 IO
  if (cached !== reason) {
    saveGlobalConfig(current => ({
      ...current,
      cachedExtraUsageDisabledReason: reason,
    }))
  }
}

/**
 * 从 API 响应头中提取并更新配额状态（主要调用路径）。
 *
 * 流程：
 *  1. 检查是否需要处理限速（非订阅用户跳过）
 *  2. 非订阅用户：清除现有限速状态（重置为 allowed）
 *  3. 应用 mock 限速头（来自 /mock-limits 命令）
 *  4. 提取原始使用率数据
 *  5. 计算新的限制状态
 *  6. 持久化超额禁用原因
 *  7. 若状态发生变化则触发 emitStatusChange
 */
export function extractQuotaStatusFromHeaders(
  headers: globalThis.Headers,
): void {
  const isSubscriber = isClaudeAISubscriber()

  if (!shouldProcessRateLimits(isSubscriber)) {
    // 不需要处理限速：清除原始使用率数据
    rawUtilization = {}
    // 若当前有非 allowed 状态或有重置时间，重置为初始 allowed 状态
    if (currentLimits.status !== 'allowed' || currentLimits.resetsAt) {
      const defaultLimits: ClaudeAILimits = {
        status: 'allowed',
        unifiedRateLimitFallbackAvailable: false,
        isUsingOverage: false,
      }
      emitStatusChange(defaultLimits)
    }
    return
  }

  // 应用来自 /mock-limits 命令的 mock 头（测试/演示用）
  const headersToUse = processRateLimitHeaders(headers)
  // 提取原始每窗口使用率数据（供状态栏脚本使用）
  rawUtilization = extractRawUtilization(headersToUse)
  // 计算新的配额限制状态
  const newLimits = computeNewLimitsFromHeaders(headersToUse)

  // 持久化超额禁用原因（跨会话保留，供下次启动时使用）
  cacheExtraUsageDisabledReason(headersToUse)

  // 只有状态真正发生变化时才触发更新（避免不必要的 React 重渲染）
  if (!isEqual(currentLimits, newLimits)) {
    emitStatusChange(newLimits)
  }
}

/**
 * 从 API 错误对象中提取并更新配额状态（错误路径）。
 *
 * 仅处理 429（Too Many Requests）错误。
 * 如果错误包含响应头（通常有），从头中解析更精确的限制信息；
 * 无论如何都将最终 status 设置为 'rejected'（被拒绝）。
 */
export function extractQuotaStatusFromError(error: APIError): void {
  // 非订阅用户或非 429 错误不处理
  if (
    !shouldProcessRateLimits(isClaudeAISubscriber()) ||
    error.status !== 429
  ) {
    return
  }

  try {
    let newLimits = { ...currentLimits }
    if (error.headers) {
      // 429 错误通常携带限速响应头，应用 mock 后解析
      const headersToUse = processRateLimitHeaders(error.headers)
      rawUtilization = extractRawUtilization(headersToUse)
      newLimits = computeNewLimitsFromHeaders(headersToUse)

      // 持久化超额禁用原因
      cacheExtraUsageDisabledReason(headersToUse)
    }
    // 无论响应头如何，429 错误必须将 status 设置为 rejected
    newLimits.status = 'rejected'

    // 只有状态变化时才触发更新
    if (!isEqual(currentLimits, newLimits)) {
      emitStatusChange(newLimits)
    }
  } catch (e) {
    logError(e as Error)
  }
}
