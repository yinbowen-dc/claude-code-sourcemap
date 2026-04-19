/**
 * /cost 命令的核心实现：查询并返回当前会话的费用信息。
 *
 * 在 Claude Code 的命令体系中，cost.ts 负责实际执行费用查询逻辑，
 * 是 cost/index.ts 通过 load() 懒加载调用的目标模块。
 *
 * 逻辑分支：
 *  - 若用户为 claude.ai 订阅用户，则不显示具体费用，而是显示其使用的
 *    订阅配额或超额用量状态（Anthropic 内部用户例外，额外附加费用明细）；
 *  - 否则（API 付费用户）直接显示本次会话累计费用。
 */
import { formatTotalCost } from '../../cost-tracker.js'
import { currentLimits } from '../../services/claudeAiLimits.js'
import type { LocalCommandCall } from '../../types/command.js'
import { isClaudeAISubscriber } from '../../utils/auth.js'

/**
 * /cost 命令的执行函数。
 *
 * 流程：
 *  1. 检查当前用户是否为 claude.ai 订阅用户；
 *  2. 若是，根据是否处于超额（overage）状态返回相应的订阅说明文本；
 *     Anthropic 内部用户（USER_TYPE=ant）在订阅说明后额外附加实际费用；
 *  3. 若不是订阅用户，直接返回格式化后的会话总费用字符串。
 */
export const call: LocalCommandCall = async () => {
  if (isClaudeAISubscriber()) {
    let value: string

    // 判断是否正在使用超额用量（overage），给出相应提示
    if (currentLimits.isUsingOverage) {
      value =
        'You are currently using your overages to power your Claude Code usage. We will automatically switch you back to your subscription rate limits when they reset'
    } else {
      value =
        'You are currently using your subscription to power your Claude Code usage'
    }

    // ANT 内部用户即使是订阅用户也可以看到实际费用，用于调试和统计
    if (process.env.USER_TYPE === 'ant') {
      value += `\n\n[ANT-ONLY] Showing cost anyway:\n ${formatTotalCost()}`
    }
    return { type: 'text', value }
  }
  // 非订阅用户（按量付费 API 用户）直接返回会话累计费用
  return { type: 'text', value: formatTotalCost() }
}
