/**
 * Agent 群组（Swarms / Teams）功能总开关模块。
 *
 * 在 Claude Code 系统中，该模块是所有涉及 Agent Teams 特性的单一权威开关。
 * 任何引用队友（teammate）相关逻辑的地方（提示词、工具 isEnabled、UI 等）
 * 都应通过 isAgentSwarmsEnabled() 判断是否激活该功能。
 *
 * 启用条件：
 * - 内部用户（USER_TYPE=ant）：始终启用
 * - 外部用户：需同时满足
 *   1. 通过环境变量 CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS 或 --agent-teams 标志选择加入
 *   2. GrowthBook killswitch（tengu_amber_flint）未关闭
 */
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js'
import { isEnvTruthy } from './envUtils.js'

/**
 * 检查 CLI 是否传入了 --agent-teams 标志。
 * 直接读取 process.argv 以避免与 bootstrap/state 的循环导入。
 * 注：该标志在帮助文档中仅对内部用户显示，但外部用户若手动传入同样有效。
 *
 * Check if --agent-teams flag is provided via CLI.
 */
function isAgentTeamsFlagSet(): boolean {
  return process.argv.includes('--agent-teams')
}

/**
 * 判断 Agent 群组/队友功能是否当前已启用。
 *
 * 这是检查队友特性的唯一入口，所有相关代码路径都应调用此函数。
 *
 * Centralized runtime check for agent teams/teammate features.
 */
export function isAgentSwarmsEnabled(): boolean {
  // 内部用户：始终开启
  if (process.env.USER_TYPE === 'ant') {
    return true
  }

  // 外部用户：需通过环境变量或 --agent-teams 标志显式选择加入
  if (
    !isEnvTruthy(process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS) &&
    !isAgentTeamsFlagSet()
  ) {
    return false
  }

  // Killswitch：外部用户始终受此控制，功能被远程关闭时返回 false
  if (!getFeatureValue_CACHED_MAY_BE_STALE('tengu_amber_flint', true)) {
    return false
  }

  return true
}
