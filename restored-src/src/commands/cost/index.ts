/**
 * cost 命令的注册入口。
 * Implementation is lazy-loaded from cost.ts to reduce startup time.
 *
 * 在 Claude Code 的命令体系中，/cost 命令用于展示当前会话的 Token 消耗
 * 及累计费用信息。本文件仅声明命令元数据，具体执行逻辑在 cost.ts 中。
 *
 * 可见性策略：
 *  - 对 claude.ai 订阅用户隐藏（因其按订阅套餐计费，无直接费用概念）；
 *  - Anthropic 内部用户（USER_TYPE=ant）始终可见，便于调试和核查费用；
 *  - 支持非交互式会话（可在 headless/SDK 模式下调用）。
 */
import type { Command } from '../../commands.js'
import { isClaudeAISubscriber } from '../../utils/auth.js'

const cost = {
  type: 'local',
  name: 'cost',
  description: 'Show the total cost and duration of the current session',
  get isHidden() {
    // Keep visible for Ants even if they're subscribers (they see cost breakdowns)
    // Anthropic 内部用户（ant）始终显示，即使他们是订阅用户
    if (process.env.USER_TYPE === 'ant') {
      return false
    }
    // claude.ai 订阅用户不涉及按量计费，隐藏该命令避免混淆
    return isClaudeAISubscriber()
  },
  // 支持在非交互式（headless/SDK）会话中调用
  supportsNonInteractive: true,
  load: () => import('./cost.js'),
} satisfies Command

export default cost
