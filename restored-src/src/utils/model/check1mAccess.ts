/**
 * 1M 上下文窗口访问权限检测模块 — 订阅级别与超额使用状态的门控层
 *
 * 【在系统流中的位置】
 * 本文件处于模型选项构建的权限检测环节，决定 `/model` 选择器中是否显示
 * `opus[1m]` 和 `sonnet[1m]` 这两个 1M 上下文窗口模型选项。
 *
 * 调用路径：
 *   modelOptions.ts (getModelOptionsBase)
 *     → checkOpus1mAccess / checkSonnet1mAccess
 *     → isExtraUsageEnabled
 *     → getGlobalConfig().cachedExtraUsageDisabledReason
 *                                  ↑
 *               由后台速率限制刷新任务写入（claudeAiLimits.ts）
 *
 *   contextWindowUpgradeCheck.ts (getAvailableUpgrade)
 *     → checkOpus1mAccess / checkSonnet1mAccess
 *
 * 【访问规则】
 * Claude.ai 订阅用户：需要超额使用功能已启用（isExtraUsageEnabled）
 * API/PAYG 用户     ：始终有权访问（无订阅限制）
 * 全局禁用          ：is1mContextDisabled() 为 true 时任何用户均无权访问
 *
 * 【主要导出】
 * - checkOpus1mAccess   : 检查当前用户是否可访问 Opus 1M 上下文模型
 * - checkSonnet1mAccess : 检查当前用户是否可访问 Sonnet 1M 上下文模型
 */

import type { OverageDisabledReason } from 'src/services/claudeAiLimits.js'
import { isClaudeAISubscriber } from '../auth.js'
import { getGlobalConfig } from '../config.js'
import { is1mContextDisabled } from '../context.js'

/**
 * 根据缓存的超额使用禁用原因，判断当前账户的超额使用功能是否已启用。
 *
 * 语义三态：
 *   undefined — 尚未从 API 获取到状态，保守地视为"未启用"
 *   null      — API 未返回任何禁用原因，视为"已启用"
 *   string    — 具体的禁用原因，根据原因类型进一步判断：
 *               · out_of_credits: 积分耗尽但功能已购买，视为"已启用"
 *               · 其他原因（未购买 / 组织或成员级禁用 / 零额度等）: "未启用"
 *
 * @returns true 表示超额使用已启用，false 表示未启用
 */
function isExtraUsageEnabled(): boolean {
  const reason = getGlobalConfig().cachedExtraUsageDisabledReason
  // undefined = 尚无缓存，保守处理视为未启用
  if (reason === undefined) {
    return false
  }
  // null = API 明确表示无禁用原因，功能已启用
  if (reason === null) {
    return true
  }
  // 根据具体禁用原因分类判断
  switch (reason as OverageDisabledReason) {
    // 积分耗尽但功能已购买 — 仍视为"已启用"（等充值即可使用）
    case 'out_of_credits':
      return true
    // 以下所有情况均表示功能未购买或被管理员禁用，视为"未启用"
    case 'overage_not_provisioned':
    case 'org_level_disabled':
    case 'org_level_disabled_until':
    case 'seat_tier_level_disabled':
    case 'member_level_disabled':
    case 'seat_tier_zero_credit_limit':
    case 'group_zero_credit_limit':
    case 'member_zero_credit_limit':
    case 'org_service_level_disabled':
    case 'org_service_zero_credit_limit':
    case 'no_limits_configured':
    case 'unknown':
      return false
    // 安全兜底：未知原因保守处理
    default:
      return false
  }
}

// @[MODEL LAUNCH]: Add check if the new model supports 1M context
/**
 * 检查当前用户是否有权访问 Opus 1M 上下文窗口模型。
 *
 * 访问条件（按顺序）：
 *   1. 全局未禁用 1M 上下文（is1mContextDisabled 为 false）
 *   2. Claude.ai 订阅用户：超额使用功能已启用
 *      API/PAYG 用户：无条件允许
 *
 * @returns true 表示可访问 opus[1m] 选项
 */
export function checkOpus1mAccess(): boolean {
  // 全局禁用时任何用户均无权访问
  if (is1mContextDisabled()) {
    return false
  }

  if (isClaudeAISubscriber()) {
    // 订阅用户需要超额使用功能已启用才能访问 1M 上下文
    return isExtraUsageEnabled()
  }

  // API / PAYG 用户（非订阅）始终有权访问 1M 上下文
  return true
}

/**
 * 检查当前用户是否有权访问 Sonnet 1M 上下文窗口模型。
 *
 * 逻辑与 checkOpus1mAccess 完全一致，单独定义以便未来针对不同模型
 * 实现差异化的访问控制策略（如按模型系列单独控制开关）。
 *
 * @returns true 表示可访问 sonnet[1m] 选项
 */
export function checkSonnet1mAccess(): boolean {
  // 全局禁用时任何用户均无权访问
  if (is1mContextDisabled()) {
    return false
  }

  if (isClaudeAISubscriber()) {
    // 订阅用户需要超额使用功能已启用才能访问 1M 上下文
    return isExtraUsageEnabled()
  }

  // API / PAYG 用户（非订阅）始终有权访问 1M 上下文
  return true
}
