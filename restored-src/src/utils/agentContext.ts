/**
 * Agent 上下文模块（基于 AsyncLocalStorage 的分析归因）。
 *
 * 在 Claude Code 系统中，该模块通过 Node.js AsyncLocalStorage 在整个异步
 * 调用链中传播 Agent 身份信息，无需在函数参数中显式传递。
 *
 * 支持两种 Agent 类型：
 * 1. Subagent（Agent 工具）：进程内运行，用于快速、委托式子任务。
 *    上下文类型：SubagentContext（agentType: 'subagent'）
 * 2. 进程内 Teammate：属于 swarm 的团队成员，具备团队协调能力。
 *    上下文类型：TeammateAgentContext（agentType: 'teammate'）
 *
 * 对于在独立进程（tmux/iTerm2）中运行的 swarm 队友，使用环境变量：
 *   CLAUDE_CODE_AGENT_ID, CLAUDE_CODE_PARENT_SESSION_ID
 *
 * 为什么使用 AsyncLocalStorage 而非 AppState：
 * 当 Agent 被后台化（ctrl+b）时，多个 Agent 可在同一进程中并发运行。
 * AppState 是单一共享状态，会被覆盖，导致 Agent A 的事件错误地使用
 * Agent B 的上下文。AsyncLocalStorage 隔离每个异步执行链，使并发 Agent
 * 互不干扰。
 *
 * Agent context for analytics attribution using AsyncLocalStorage.
 */

import { AsyncLocalStorage } from 'async_hooks'
import type { AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from '../services/analytics/index.js'
import { isAgentSwarmsEnabled } from './agentSwarmsEnabled.js'

/**
 * Subagent（Agent 工具代理）的上下文类型。
 * Subagent 在进程内运行，用于快速的委托式子任务。
 *
 * Context for subagents (Agent tool agents).
 */
export type SubagentContext = {
  /** Subagent 的 UUID（由 createAgentId() 生成） */
  agentId: string
  /** 团队负责人的会话 ID（来自 CLAUDE_CODE_PARENT_SESSION_ID 环境变量），主 REPL subagent 为 undefined */
  parentSessionId?: string
  /** Agent 类型标识，subagent 固定为 'subagent' */
  agentType: 'subagent'
  /** Subagent 的类型名称（如 "Explore"、"Bash"、"code-reviewer"） */
  subagentName?: string
  /** 是否为内置 Agent（vs 用户自定义 Agent） */
  isBuiltIn?: boolean
  /** 调用方 Agent 中产生本 spawn/resume 的 request_id。
   *  嵌套 subagent 时指直接调用者，非根 —— session_id 已囊括整棵树。每次 resume 时更新。 */
  invokingRequestId?: string
  /** 本次调用是初始 spawn 还是通过 SendMessage 触发的后续 resume。
   *  当 invokingRequestId 不存在时为 undefined。 */
  invocationKind?: 'spawn' | 'resume'
  /** 可变标志：本次调用的边是否已上报到遥测系统？
   *  每次 spawn/resume 时重置为 false；由 consumeInvokingRequestId()
   *  在首个终端 API 事件时置为 true。 */
  invocationEmitted?: boolean
}

/**
 * 进程内 Teammate（群组成员）的上下文类型。
 * Teammate 属于 swarm，具备团队协调能力。
 *
 * Context for in-process teammates.
 */
export type TeammateAgentContext = {
  /** 完整 Agent ID，格式如 "researcher@my-team" */
  agentId: string
  /** 显示名称，格式如 "researcher" */
  agentName: string
  /** 本 Teammate 所属的团队名称 */
  teamName: string
  /** UI 分配给本 Teammate 的颜色 */
  agentColor?: string
  /** Teammate 在实施前是否必须进入计划模式 */
  planModeRequired: boolean
  /** 团队负责人的会话 ID，用于对接日志 */
  parentSessionId: string
  /** 本 Agent 是否为团队负责人 */
  isTeamLead: boolean
  /** Agent 类型标识，teammate 固定为 'teammate' */
  agentType: 'teammate'
  /** 调用方 Agent 中产生本 spawn/resume 的 request_id。
   *  在工具调用外启动的 teammate（如会话启动时）为 undefined。每次 resume 时更新。 */
  invokingRequestId?: string
  /** 参见 SubagentContext.invocationKind。 */
  invocationKind?: 'spawn' | 'resume'
  /** 可变标志：参见 SubagentContext.invocationEmitted。 */
  invocationEmitted?: boolean
}

/**
 * Agent 上下文的判别联合类型。
 * 使用 agentType 区分 subagent 和 teammate 上下文。
 *
 * Discriminated union for agent context.
 */
export type AgentContext = SubagentContext | TeammateAgentContext

// AsyncLocalStorage 存储当前 Agent 上下文，隔离并发 Agent 的状态
const agentContextStorage = new AsyncLocalStorage<AgentContext>()

/**
 * 获取当前 Agent 上下文（如有）。
 * 若不在 Agent 上下文（subagent 或 teammate）中运行则返回 undefined。
 * 可使用类型守卫 isSubagentContext() 或 isTeammateAgentContext() 进一步收窄类型。
 *
 * Get the current agent context, if any.
 */
export function getAgentContext(): AgentContext | undefined {
  return agentContextStorage.getStore()
}

/**
 * 在给定 Agent 上下文中运行异步函数。
 * 函数内所有异步操作均可访问此上下文。
 *
 * Run an async function with the given agent context.
 */
export function runWithAgentContext<T>(context: AgentContext, fn: () => T): T {
  return agentContextStorage.run(context, fn)
}

/**
 * 类型守卫：判断上下文是否为 SubagentContext。
 *
 * Type guard to check if context is a SubagentContext.
 */
export function isSubagentContext(
  context: AgentContext | undefined,
): context is SubagentContext {
  return context?.agentType === 'subagent'
}

/**
 * 类型守卫：判断上下文是否为 TeammateAgentContext。
 * 仅在 Agent Swarms 功能启用时才可能返回 true。
 *
 * Type guard to check if context is a TeammateAgentContext.
 */
export function isTeammateAgentContext(
  context: AgentContext | undefined,
): context is TeammateAgentContext {
  if (isAgentSwarmsEnabled()) {
    return context?.agentType === 'teammate'
  }
  return false
}

/**
 * 获取适合分析日志记录的 subagent 名称。
 * 内置 Agent 返回其类型名；用户自定义 Agent 返回字面量 "user-defined"；
 * 若不在 subagent 上下文中则返回 undefined。
 *
 * 对分析元数据安全：内置 Agent 名称是代码常量，自定义 Agent 始终映射为 "user-defined"。
 *
 * Get the subagent name suitable for analytics logging.
 */
export function getSubagentLogName():
  | AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
  | undefined {
  const context = getAgentContext()
  if (!isSubagentContext(context) || !context.subagentName) {
    return undefined
  }
  // 内置 Agent 使用其类型名，用户自定义 Agent 统一替换为 "user-defined"
  return (
    context.isBuiltIn ? context.subagentName : 'user-defined'
  ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
}

/**
 * 获取当前 Agent 上下文中的调用请求 ID（每次调用仅可消费一次）。
 * 在 spawn/resume 后第一次调用时返回 ID，之后返回 undefined，直到下一个边界。
 * 在主线程或 spawn 路径无 request_id 时同样返回 undefined。
 *
 * 稀疏边语义：invokingRequestId 在每次调用中只出现在恰好一个
 * tengu_api_success/error 事件中，非 NULL 值标志着 spawn/resume 边界。
 *
 * Get the invoking request_id for the current agent context — once per invocation.
 */
export function consumeInvokingRequestId():
  | {
      invokingRequestId: string
      invocationKind: 'spawn' | 'resume' | undefined
    }
  | undefined {
  const context = getAgentContext()
  // 若无 invokingRequestId 或已上报，则跳过
  if (!context?.invokingRequestId || context.invocationEmitted) {
    return undefined
  }
  // 标记为已上报，防止重复消费
  context.invocationEmitted = true
  return {
    invokingRequestId: context.invokingRequestId,
    invocationKind: context.invocationKind,
  }
}
