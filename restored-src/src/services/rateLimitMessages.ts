/**
 * 速率限制消息生成模块（集中式单一事实来源）
 *
 * 在 Claude Code 系统流程中的位置：
 * 本文件是速率限制 UI 反馈层的核心，集中管理所有与速率限制相关的用户提示消息。
 * 它位于以下层次结构中：
 *   - 调用方：UI 底栏（警告提示）、errors.ts（错误消息）、REPL 交互层（限制状态展示）
 *   - 本模块：根据 ClaudeAILimits 状态生成对应的消息文本和严重级别
 *   - 下层：auth.js（订阅类型/超额配置）、billing.js（账单访问权限）、format.js（时间格式化）
 *
 * 主要功能：
 * - RATE_LIMIT_ERROR_PREFIXES：所有速率限制消息的前缀字符串列表（供 UI 组件识别）
 * - isRateLimitErrorMessage：检查一段文本是否为速率限制消息（前缀匹配）
 * - getRateLimitMessage：核心路由函数，根据 limits 状态返回 error/warning/null
 * - getRateLimitErrorMessage：仅返回 severity='error' 的消息（供 errors.ts 使用）
 * - getRateLimitWarning：仅返回 severity='warning' 的消息（供 UI 底栏使用）
 * - getUsingOverageText：超额模式过渡通知文本（进入超额时的瞬态通知）
 *
 * 关键决策逻辑（getRateLimitMessage）：
 * 1. isUsingOverage=true → overageStatus='allowed_warning' 则返回 warning，否则返回 null
 * 2. status='rejected' → error（调用 getLimitReachedText）
 * 3. status='allowed_warning' → WARNING_THRESHOLD=0.7 检查 → team/enterprise+超额启用+无账单访问 → null
 *    → getEarlyWarningText → warning
 *
 * 设计说明：
 * - ANT 用户（USER_TYPE==='ant'）在触达限制时获得额外信息：#briarpatch-cc 反馈频道 + /reset-limits 提示
 * - 超额警告（overageStatus='allowed_warning'）优先于常规警告（status='allowed_warning'）处理
 * - getWarningUpsellText：仅在警告中显示升级提示（限制触达时有交互式选项菜单，无需 upsell）
 */

/**
 * Centralized rate limit message generation
 * Single source of truth for all rate limit-related messages
 */

import {
  getOauthAccountInfo,
  getSubscriptionType,
  isOverageProvisioningAllowed,
} from '../utils/auth.js'
import { hasClaudeAiBillingAccess } from '../utils/billing.js'
import { formatResetTime } from '../utils/format.js'
import type { ClaudeAILimits } from './claudeAiLimits.js'

// ANT 内部用户专属反馈频道（触达限制时显示）
const FEEDBACK_CHANNEL_ANT = '#briarpatch-cc'

/**
 * 所有速率限制错误消息的前缀字符串列表
 *
 * 导出此常量供 UI 组件使用，避免在多处进行脆弱的字符串匹配。
 * isRateLimitErrorMessage 使用此列表判断消息类型。
 *
 * All possible rate limit error message prefixes
 * Export this to avoid fragile string matching in UI components
 */
export const RATE_LIMIT_ERROR_PREFIXES = [
  "You've hit your",
  "You've used",
  "You're now using extra usage",
  "You're close to",
  "You're out of extra usage",
] as const

/**
 * 检查给定文本是否为速率限制消息
 *
 * 通过 RATE_LIMIT_ERROR_PREFIXES 列表进行前缀匹配，
 * 供 UI 组件和错误处理层识别速率限制相关消息。
 *
 * Check if a message is a rate limit error
 */
export function isRateLimitErrorMessage(text: string): boolean {
  // 遍历所有前缀，任意一个匹配即返回 true
  return RATE_LIMIT_ERROR_PREFIXES.some(prefix => text.startsWith(prefix))
}

// 速率限制消息的统一类型：包含消息文本和严重级别
export type RateLimitMessage = {
  message: string
  severity: 'error' | 'warning'
}

/**
 * 根据限制状态返回对应的速率限制消息（核心路由函数）
 *
 * 完整决策流程（按优先级顺序）：
 * 1. isUsingOverage（正在使用超额）：
 *    - overageStatus='allowed_warning'（接近超额消费限制）→ 返回 warning
 *    - 其他超额状态 → 返回 null（getUsingOverageText 单独渲染）
 * 2. status='rejected'（已触达限制）→ 返回 error（getLimitReachedText）
 * 3. status='allowed_warning'（接近限制）：
 *    - utilization < WARNING_THRESHOLD(0.7) → null（避免周重置后的过时数据导致误报）
 *    - team/enterprise + 超额已启用 + 无账单访问权 → null（将无缝进入超额，无需预警）
 *    - 否则 → getEarlyWarningText → warning
 *
 * Get the appropriate rate limit message based on limit state
 * Returns null if no message should be shown
 */
export function getRateLimitMessage(
  limits: ClaudeAILimits,
  model: string,
): RateLimitMessage | null {
  // Check overage scenarios first (when subscription is rejected but overage is available)
  // getUsingOverageText is rendered separately from warning.
  // 超额场景优先处理（订阅限制已耗尽但超额可用）
  if (limits.isUsingOverage) {
    // Show warning if approaching overage spending limit
    // 接近超额消费上限时显示警告
    if (limits.overageStatus === 'allowed_warning') {
      return {
        message: "You're close to your extra usage spending limit",
        severity: 'warning',
      }
    }
    // 其他超额状态不显示额外消息（getUsingOverageText 已单独渲染）
    return null
  }

  // ERROR STATES - when limits are rejected
  // 错误状态：限制已被拒绝（用户无法继续使用）
  if (limits.status === 'rejected') {
    return { message: getLimitReachedText(limits, model), severity: 'error' }
  }

  // WARNING STATES - when approaching limits with early warning
  // 警告状态：接近限制的提前预警
  if (limits.status === 'allowed_warning') {
    // Only show warnings when utilization is above threshold (70%)
    // This prevents false warnings after week reset when API may send
    // allowed_warning with stale data at low usage levels
    // 仅在使用率超过 70% 时显示警告（防止周重置后 API 发送的过时数据导致误报）
    const WARNING_THRESHOLD = 0.7
    if (
      limits.utilization !== undefined &&
      limits.utilization < WARNING_THRESHOLD
    ) {
      return null
    }

    // Don't warn non-billing Team/Enterprise users about approaching plan limits
    // if overages are enabled - they'll seamlessly roll into overage
    // team/enterprise + 超额已启用 + 无账单访问权：不预警，将无缝进入超额
    const subscriptionType = getSubscriptionType()
    const isTeamOrEnterprise =
      subscriptionType === 'team' || subscriptionType === 'enterprise'
    const hasExtraUsageEnabled =
      getOauthAccountInfo()?.hasExtraUsageEnabled === true

    if (
      isTeamOrEnterprise &&
      hasExtraUsageEnabled &&
      !hasClaudeAiBillingAccess()
    ) {
      return null
    }

    // 构建早期预警文本（含使用率、重置时间、升级提示）
    const text = getEarlyWarningText(limits)
    if (text) {
      return { message: text, severity: 'warning' }
    }
  }

  // No message needed
  return null
}

/**
 * 获取 API 错误消息（仅返回 error 级别，供 errors.ts 使用）
 *
 * 从 getRateLimitMessage 的结果中筛选出 severity='error' 的消息，
 * 若无错误消息则返回 null。
 *
 * Get error message for API errors (used in errors.ts)
 * Returns the message string or null if no error message should be shown
 */
export function getRateLimitErrorMessage(
  limits: ClaudeAILimits,
  model: string,
): string | null {
  const message = getRateLimitMessage(limits, model)

  // Only return error messages, not warnings
  // 仅返回 error 级别的消息（警告由 getRateLimitWarning 单独处理）
  if (message && message.severity === 'error') {
    return message.message
  }

  return null
}

/**
 * 获取 UI 底栏警告消息（仅返回 warning 级别，供底栏显示）
 *
 * 从 getRateLimitMessage 的结果中筛选出 severity='warning' 的消息。
 * 错误消息在 AssistantTextMessages 中显示，不显示在底栏。
 *
 * Get warning message for UI footer
 * Returns the warning message string or null if no warning should be shown
 */
export function getRateLimitWarning(
  limits: ClaudeAILimits,
  model: string,
): string | null {
  const message = getRateLimitMessage(limits, model)

  // Only return warnings for the footer - errors are shown in AssistantTextMessages
  // 仅返回警告消息（错误在 AssistantTextMessages 中显示，不显示在底栏）
  if (message && message.severity === 'warning') {
    return message.message
  }

  // Don't show errors in the footer
  return null
}

/**
 * 根据限制类型和重置时间生成"已触达限制"文本
 *
 * 处理各种限制触达场景：
 * - overageStatus='rejected'（订阅+超额均耗尽）：显示最早重置时间，
 *   若 overageDisabledReason='out_of_credits' 则显示"超额已用完"
 * - seven_day_sonnet：pro/enterprise 显示"weekly limit"，其他显示"Sonnet limit"
 * - seven_day_opus → "Opus limit"
 * - seven_day → "weekly limit"
 * - five_hour → "session limit"
 * - 其他 → "usage limit"
 *
 * 最终通过 formatLimitReachedText 格式化（ANT 用户附加 #briarpatch-cc 和 /reset-limits）
 */
function getLimitReachedText(limits: ClaudeAILimits, model: string): string {
  // 计算订阅重置时间和超额重置时间的格式化字符串
  const resetsAt = limits.resetsAt
  const resetTime = resetsAt ? formatResetTime(resetsAt, true) : undefined
  const overageResetTime = limits.overageResetsAt
    ? formatResetTime(limits.overageResetsAt, true)
    : undefined
  const resetMessage = resetTime ? ` · resets ${resetTime}` : ''

  // if BOTH subscription (checked before this method) and overage are exhausted
  // 订阅和超额均已耗尽：选择最早的重置时间告知用户何时可以继续
  if (limits.overageStatus === 'rejected') {
    // Show the earliest reset time to indicate when user can resume
    let overageResetMessage = ''
    if (resetsAt && limits.overageResetsAt) {
      // Both timestamps present - use the earlier one
      // 两个时间戳均存在：选择较早的那个（用户等待更短时间后即可恢复）
      if (resetsAt < limits.overageResetsAt) {
        overageResetMessage = ` · resets ${resetTime}`
      } else {
        overageResetMessage = ` · resets ${overageResetTime}`
      }
    } else if (resetTime) {
      overageResetMessage = ` · resets ${resetTime}`
    } else if (overageResetTime) {
      overageResetMessage = ` · resets ${overageResetTime}`
    }

    // 超额因余额不足被禁用：显示专属提示
    if (limits.overageDisabledReason === 'out_of_credits') {
      return `You're out of extra usage${overageResetMessage}`
    }

    return formatLimitReachedText('limit', overageResetMessage, model)
  }

  // seven_day_sonnet：pro/enterprise 的 Sonnet 限制与 weekly 相同，统一显示 "weekly limit"
  if (limits.rateLimitType === 'seven_day_sonnet') {
    const subscriptionType = getSubscriptionType()
    const isProOrEnterprise =
      subscriptionType === 'pro' || subscriptionType === 'enterprise'
    // For pro and enterprise, Sonnet limit is the same as weekly
    const limit = isProOrEnterprise ? 'weekly limit' : 'Sonnet limit'
    return formatLimitReachedText(limit, resetMessage, model)
  }

  // 其他限制类型：直接映射到对应的限制名称
  if (limits.rateLimitType === 'seven_day_opus') {
    return formatLimitReachedText('Opus limit', resetMessage, model)
  }

  if (limits.rateLimitType === 'seven_day') {
    return formatLimitReachedText('weekly limit', resetMessage, model)
  }

  if (limits.rateLimitType === 'five_hour') {
    return formatLimitReachedText('session limit', resetMessage, model)
  }

  // 未知限制类型的默认消息
  return formatLimitReachedText('usage limit', resetMessage, model)
}

/**
 * 生成早期预警文本（接近限制但尚未触达时的提示）
 *
 * 完整流程：
 * 1. 根据 rateLimitType 映射限制名称（seven_day/five_hour/opus/sonnet/overage）
 * 2. 计算使用率百分比（utilization * 100，向下取整）
 * 3. 格式化重置时间（formatResetTime）
 * 4. 通过 getWarningUpsellText 获取升级建议
 * 5. 按优先级组合：used+resetTime > used > resetTime > bare（均可选附加 upsell）
 */
function getEarlyWarningText(limits: ClaudeAILimits): string | null {
  // 将限制类型映射为用户友好的限制名称
  let limitName: string | null = null
  switch (limits.rateLimitType) {
    case 'seven_day':
      limitName = 'weekly limit'
      break
    case 'five_hour':
      limitName = 'session limit'
      break
    case 'seven_day_opus':
      limitName = 'Opus limit'
      break
    case 'seven_day_sonnet':
      limitName = 'Sonnet limit'
      break
    case 'overage':
      limitName = 'extra usage'
      break
    case undefined:
      return null
  }

  // utilization and resetsAt should be defined since early warning is calculated with them
  // 计算使用率百分比（向下取整，如 0.85 → 85）
  const used = limits.utilization
    ? Math.floor(limits.utilization * 100)
    : undefined
  // 格式化重置时间字符串（如 "in 2 hours"）
  const resetTime = limits.resetsAt
    ? formatResetTime(limits.resetsAt, true)
    : undefined

  // Get upsell command based on subscription type and limit type
  // 获取升级建议文本（根据订阅类型和限制类型决定是否显示升级提示）
  const upsell = getWarningUpsellText(limits.rateLimitType)

  // 按优先级组合消息文本：优先显示精确信息（使用率 + 重置时间）
  if (used && resetTime) {
    const base = `You've used ${used}% of your ${limitName} · resets ${resetTime}`
    return upsell ? `${base} · ${upsell}` : base
  }

  if (used) {
    const base = `You've used ${used}% of your ${limitName}`
    return upsell ? `${base} · ${upsell}` : base
  }

  // 超额类型的"接近"表达改为"extra usage limit"（更语义化）
  if (limits.rateLimitType === 'overage') {
    // For the "Approaching <x>" verbiage, "extra usage limit" makes more sense than "extra usage"
    limitName += ' limit'
  }

  if (resetTime) {
    const base = `Approaching ${limitName} · resets ${resetTime}`
    return upsell ? `${base} · ${upsell}` : base
  }

  // 最简版本：仅显示"接近限制"（无使用率和重置时间数据）
  const base = `Approaching ${limitName}`
  return upsell ? `${base} · ${upsell}` : base
}

/**
 * 根据订阅类型和限制类型决定警告消息中的升级建议文本
 *
 * 设计说明：
 * - 仅用于警告消息（限制触达时会有交互式选项菜单，无需 upsell）
 * - five_hour 限制：
 *   team/enterprise + 超额未启用 + 支持超额配置 → '/extra-usage to request more'
 *   team/enterprise + 其他情况 → null（超额已启用或不支持配置）
 *   pro/max → '/upgrade to keep using Claude Code'
 * - overage 限制：同 five_hour 的 team/enterprise 逻辑
 * - weekly 限制：不显示 upsell（规格要求）
 *
 * Get the upsell command text for warning messages based on subscription and limit type.
 * Returns null if no upsell should be shown.
 * Only used for warnings because actual rate limit hits will see an interactive menu of options.
 */
function getWarningUpsellText(
  rateLimitType: ClaudeAILimits['rateLimitType'],
): string | null {
  const subscriptionType = getSubscriptionType()
  const hasExtraUsageEnabled =
    getOauthAccountInfo()?.hasExtraUsageEnabled === true

  // 5-hour session limit warning
  // 5小时 session 限制警告
  if (rateLimitType === 'five_hour') {
    // Teams/Enterprise with overages disabled: prompt to request extra usage
    // Only show if overage provisioning is allowed for this org type (e.g., not AWS marketplace)
    // team/enterprise + 超额未启用 + 支持超额配置 → 提示请求超额
    if (subscriptionType === 'team' || subscriptionType === 'enterprise') {
      if (!hasExtraUsageEnabled && isOverageProvisioningAllowed()) {
        return '/extra-usage to request more'
      }
      // Teams/Enterprise with overages enabled or unsupported billing type don't need upsell
      // 超额已启用或不支持配置的 team/enterprise：不显示 upsell
      return null
    }

    // Pro/Max users: prompt to upgrade
    // pro/max 用户：提示升级以继续使用
    if (subscriptionType === 'pro' || subscriptionType === 'max') {
      return '/upgrade to keep using Claude Code'
    }
  }

  // Overage warning (approaching spending limit)
  // 超额消费警告：与 five_hour 的 team/enterprise 逻辑相同
  if (rateLimitType === 'overage') {
    if (subscriptionType === 'team' || subscriptionType === 'enterprise') {
      if (!hasExtraUsageEnabled && isOverageProvisioningAllowed()) {
        return '/extra-usage to request more'
      }
    }
  }

  // Weekly limit warnings don't show upsell per spec
  // weekly 限制警告不显示 upsell（产品规格要求）
  return null
}

/**
 * 生成进入超额模式时的过渡通知文本
 *
 * 在用户订阅限制耗尽并开始使用超额时显示此瞬态通知。
 * 文本格式：
 * - 有限制类型 + 重置时间 → "You're now using extra usage · Your {limit} resets {time}"
 * - 有限制类型但无重置时间 → "You're now using extra usage · Your {limit}"（无 resets）
 * - 无限制类型 → "Now using extra usage"（最简版本）
 *
 * Get notification text for overage mode transitions
 * Used for transient notifications when entering overage mode
 */
export function getUsingOverageText(limits: ClaudeAILimits): string {
  // 格式化订阅重置时间（若存在）
  const resetTime = limits.resetsAt
    ? formatResetTime(limits.resetsAt, true)
    : ''

  // 将限制类型映射为用户友好的限制名称
  let limitName = ''
  if (limits.rateLimitType === 'five_hour') {
    limitName = 'session limit'
  } else if (limits.rateLimitType === 'seven_day') {
    limitName = 'weekly limit'
  } else if (limits.rateLimitType === 'seven_day_opus') {
    limitName = 'Opus limit'
  } else if (limits.rateLimitType === 'seven_day_sonnet') {
    const subscriptionType = getSubscriptionType()
    const isProOrEnterprise =
      subscriptionType === 'pro' || subscriptionType === 'enterprise'
    // For pro and enterprise, Sonnet limit is the same as weekly
    // pro/enterprise 的 Sonnet 限制等同于 weekly 限制
    limitName = isProOrEnterprise ? 'weekly limit' : 'Sonnet limit'
  }

  // 无限制类型时显示最简版本
  if (!limitName) {
    return 'Now using extra usage'
  }

  // 有重置时间时附加"Your {limit} resets {time}"
  const resetMessage = resetTime
    ? ` · Your ${limitName} resets ${resetTime}`
    : ''
  return `You're now using extra usage${resetMessage}`
}

/**
 * 格式化"已触达限制"文本（含 ANT 用户专属增强信息）
 *
 * 标准用户：简单的"You've hit your {limit}{resetMessage}"
 * ANT 内部用户（USER_TYPE==='ant'）：额外附加：
 * - #briarpatch-cc 反馈频道（收集限制反馈）
 * - /reset-limits 命令提示（允许内部用户重置限制）
 *
 * @param limit 限制类型描述（如 "weekly limit"、"session limit"）
 * @param resetMessage 重置时间字符串（如 " · resets in 2 hours"，或空字符串）
 * @param _model 当前模型（保留参数，当前未使用）
 */
function formatLimitReachedText(
  limit: string,
  resetMessage: string,
  _model: string,
): string {
  // Enhanced messaging for Ant users
  // ANT 内部用户获得增强信息：反馈频道 + 重置命令提示
  if (process.env.USER_TYPE === 'ant') {
    return `You've hit your ${limit}${resetMessage}. If you have feedback about this limit, post in ${FEEDBACK_CHANNEL_ANT}. You can reset your limits with /reset-limits`
  }

  // 标准用户：简洁的限制触达提示
  return `You've hit your ${limit}${resetMessage}`
}
