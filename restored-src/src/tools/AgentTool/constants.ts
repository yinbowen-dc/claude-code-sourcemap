/**
 * AgentTool 常量定义模块
 *
 * 在 Claude Code AgentTool 层中，该模块集中定义了 Agent 工具所使用的核心常量——
 * 包括工具名称、向后兼容别名、验证 Agent 类型标识，以及一次性执行 Agent 的类型集合。
 *
 * 核心职责：
 * 1. `AGENT_TOOL_NAME` — 当前 Agent 工具的正式名称（用于工具注册、提示构建）
 * 2. `LEGACY_AGENT_TOOL_NAME` — 旧版 wire 名称（向后兼容权限规则、hooks 和已恢复会话）
 * 3. `VERIFICATION_AGENT_TYPE` — 验证 Agent 的类型标识符
 * 4. `ONE_SHOT_BUILTIN_AGENT_TYPES` — 一次性执行 Agent 类型集合（执行完毕后不再接收后续消息）
 *
 * 设计说明：
 * - ONE_SHOT_BUILTIN_AGENT_TYPES 目前包含 Explore 和 Plan，
 *   它们执行完毕后返回报告，父 Agent 不会再通过 SendMessage 继续与其通信。
 *   省略 agentId/SendMessage/usage 尾部可为每次 Explore 调用节省约 135 个 token，
 *   乘以每周约 3400 万次 Explore 调用，整体 token 节省效果显著。
 */

// Agent 工具的正式名称，用于工具注册、提示构建和工具调用识别
export const AGENT_TOOL_NAME = 'Agent'

// 旧版 wire 名称，保留用于向后兼容：
// 权限规则（permission rules）、hooks 配置以及已恢复的会话（resumed sessions）可能仍使用该名称
// Legacy wire name for backward compat (permission rules, hooks, resumed sessions)
export const LEGACY_AGENT_TOOL_NAME = 'Task'

// 验证 Agent 的类型标识符，用于在 Agent 列表中识别和特判验证 Agent
export const VERIFICATION_AGENT_TYPE = 'verification'

// 一次性执行内置 Agent 类型集合：这些 Agent 执行后直接返回报告，
// 父 Agent 不会再通过 SendMessage 继续与其通信。
// 省略 agentId/SendMessage/usage 尾部以节省 token
// （约 135 字符 × 每周 3400 万次 Explore 调用 = 可观的 token 节省）
// Built-in agents that run once and return a report — the parent never
// SendMessages back to continue them. Skip the agentId/SendMessage/usage
// trailer for these to save tokens (~135 chars × 34M Explore runs/week).
export const ONE_SHOT_BUILTIN_AGENT_TYPES: ReadonlySet<string> = new Set([
  'Explore',  // 探索 Agent：快速代码搜索，一次性返回结果
  'Plan',     // 规划 Agent：软件架构规划，一次性返回分步方案
])
