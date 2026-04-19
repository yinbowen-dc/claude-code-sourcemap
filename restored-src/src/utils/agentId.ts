/**
 * 确定性 Agent ID 系统模块。
 *
 * 在 Claude Code 系统中，该模块为 swarm/teammate 系统提供 Agent ID 的
 * 格式化与解析工具函数。
 *
 * ## ID 格式
 *
 * **Agent ID**：`agentName@teamName`
 * - 示例：`team-lead@my-project`、`researcher@my-project`
 * - @ 符号作为 Agent 名称与团队名称之间的分隔符
 *
 * **Request ID**：`{requestType}-{timestamp}@{agentId}`
 * - 示例：`shutdown-1702500000000@researcher@my-project`
 * - 用于关闭请求、计划审批等场景
 *
 * ## 为什么使用确定性 ID？
 *
 * 1. **可复现性**：相同名称、相同团队的 Agent 总能得到相同 ID，
 *    支持崩溃/重启后重连。
 * 2. **人可读性**：ID 有意义且便于调试（如 `tester@my-project`）。
 * 3. **可预测性**：Team Lead 无需查表即可计算 Teammate 的 ID，
 *    简化消息路由与任务分配。
 *
 * ## 约束
 *
 * - Agent 名称不得包含 `@`（用作分隔符）
 * - 使用 `sanitizeAgentName()`（来自 TeammateTool.ts）去除名称中的 @
 *
 * Deterministic Agent ID System
 */

/**
 * 将 Agent 名称与团队名称格式化为 `agentName@teamName` 格式的 Agent ID。
 *
 * Formats an agent ID in the format `agentName@teamName`.
 */
export function formatAgentId(agentName: string, teamName: string): string {
  return `${agentName}@${teamName}`
}

/**
 * 将 Agent ID 解析为其组成部分。
 * 若 ID 不包含 @ 分隔符则返回 null。
 *
 * Parses an agent ID into its components.
 */
export function parseAgentId(
  agentId: string,
): { agentName: string; teamName: string } | null {
  const atIndex = agentId.indexOf('@')
  // 无 @ 分隔符，不合法的 Agent ID
  if (atIndex === -1) {
    return null
  }
  return {
    agentName: agentId.slice(0, atIndex),
    teamName: agentId.slice(atIndex + 1),
  }
}

/**
 * 生成格式为 `{requestType}-{timestamp}@{agentId}` 的 Request ID。
 * 时间戳使用 Date.now() 保证唯一性。
 *
 * Formats a request ID in the format `{requestType}-{timestamp}@{agentId}`.
 */
export function generateRequestId(
  requestType: string,
  agentId: string,
): string {
  const timestamp = Date.now()
  return `${requestType}-${timestamp}@${agentId}`
}

/**
 * 将 Request ID 解析为其组成部分（requestType、timestamp、agentId）。
 * 若格式不匹配则返回 null。
 *
 * Parses a request ID into its components.
 */
export function parseRequestId(
  requestId: string,
): { requestType: string; timestamp: number; agentId: string } | null {
  const atIndex = requestId.indexOf('@')
  // 无 @ 分隔符，不合法的 Request ID
  if (atIndex === -1) {
    return null
  }

  const prefix = requestId.slice(0, atIndex)
  const agentId = requestId.slice(atIndex + 1)

  // 提取最后一个 '-' 之前的请求类型和之后的时间戳字符串
  const lastDashIndex = prefix.lastIndexOf('-')
  if (lastDashIndex === -1) {
    return null
  }

  const requestType = prefix.slice(0, lastDashIndex)
  const timestampStr = prefix.slice(lastDashIndex + 1)
  const timestamp = parseInt(timestampStr, 10)

  // 时间戳必须为有效整数
  if (isNaN(timestamp)) {
    return null
  }

  return { requestType, timestamp, agentId }
}
