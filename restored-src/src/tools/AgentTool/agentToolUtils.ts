/**
 * Agent 工具工具函数模块
 *
 * 在 Claude Code 工具层中，该模块为 AgentTool 提供核心的工具集管理、
 * 结果序列化和异步生命周期驱动等工具函数。
 *
 * 核心职责：
 * 1. filterToolsForAgent   — 根据 Agent 类型和权限模式过滤可用工具集
 * 2. resolveAgentTools     — 将 AgentDefinition 的工具配置解析为实际可用工具列表
 * 3. agentToolResultSchema — 定义 AgentToolResult 的 Zod 序列化 schema
 * 4. finalizeAgentTool     — 整合 Agent 执行结果并触发分析事件
 * 5. runAsyncAgentLifecycle— 驱动后台 Agent 从启动到终止通知的完整生命周期
 * 6. classifyHandoffIfNeeded — 通过 TRANSCRIPT_CLASSIFIER 特性门控检测交接安全性
 *
 * CLI 层和交互 UI 层均通过本模块使用共同的工具过滤与生命周期逻辑，
 * 确保同步和异步 Agent 的行为保持一致。
 */

import { feature } from 'bun:bundle'
import { z } from 'zod/v4'
import { clearInvokedSkillsForAgent } from '../../bootstrap/state.js'
import {
  ALL_AGENT_DISALLOWED_TOOLS,
  ASYNC_AGENT_ALLOWED_TOOLS,
  CUSTOM_AGENT_DISALLOWED_TOOLS,
  IN_PROCESS_TEAMMATE_ALLOWED_TOOLS,
} from '../../constants/tools.js'
import { startAgentSummarization } from '../../services/AgentSummary/agentSummary.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js'
import { clearDumpState } from '../../services/api/dumpPrompts.js'
import type { AppState } from '../../state/AppState.js'
import type {
  Tool,
  ToolPermissionContext,
  Tools,
  ToolUseContext,
} from '../../Tool.js'
import { toolMatchesName } from '../../Tool.js'
import {
  completeAgentTask as completeAsyncAgent,
  createActivityDescriptionResolver,
  createProgressTracker,
  enqueueAgentNotification,
  failAgentTask as failAsyncAgent,
  getProgressUpdate,
  getTokenCountFromTracker,
  isLocalAgentTask,
  killAsyncAgent,
  type ProgressTracker,
  updateAgentProgress as updateAsyncAgentProgress,
  updateProgressFromMessage,
} from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import { asAgentId } from '../../types/ids.js'
import type { Message as MessageType } from '../../types/message.js'
import { isAgentSwarmsEnabled } from '../../utils/agentSwarmsEnabled.js'
import { logForDebugging } from '../../utils/debug.js'
import { isInProtectedNamespace } from '../../utils/envUtils.js'
import { AbortError, errorMessage } from '../../utils/errors.js'
import type { CacheSafeParams } from '../../utils/forkedAgent.js'
import { lazySchema } from '../../utils/lazySchema.js'
import {
  extractTextContent,
  getLastAssistantMessage,
} from '../../utils/messages.js'
import type { PermissionMode } from '../../utils/permissions/PermissionMode.js'
import { permissionRuleValueFromString } from '../../utils/permissions/permissionRuleParser.js'
import {
  buildTranscriptForClassifier,
  classifyYoloAction,
} from '../../utils/permissions/yoloClassifier.js'
import { emitTaskProgress as emitTaskProgressEvent } from '../../utils/task/sdkProgress.js'
import { isInProcessTeammate } from '../../utils/teammateContext.js'
import { getTokenCountFromUsage } from '../../utils/tokens.js'
import { EXIT_PLAN_MODE_V2_TOOL_NAME } from '../ExitPlanModeTool/constants.js'
import { AGENT_TOOL_NAME, LEGACY_AGENT_TOOL_NAME } from './constants.js'
import type { AgentDefinition } from './loadAgentsDir.js'

// 已解析的 Agent 工具集结果类型
export type ResolvedAgentTools = {
  hasWildcard: boolean        // 是否使用通配符（即允许所有工具）
  validTools: string[]        // 有效的工具规格字符串列表
  invalidTools: string[]      // 无效（不存在）的工具规格字符串列表
  resolvedTools: Tools        // 解析后的实际 Tool 对象列表
  allowedAgentTypes?: string[] // Agent 工具限制的可启动子 Agent 类型列表
}

/**
 * 根据 Agent 类型和运行模式，过滤工具集中不允许子 Agent 使用的工具。
 *
 * 过滤规则（按优先级从高到低）：
 * 1. MCP 工具（mcp__ 前缀）始终允许
 * 2. 在 plan 模式下的 ExitPlanMode 工具始终允许
 * 3. 剔除 ALL_AGENT_DISALLOWED_TOOLS（所有 Agent 禁用工具）
 * 4. 非内置 Agent 额外剔除 CUSTOM_AGENT_DISALLOWED_TOOLS
 * 5. 异步 Agent 仅保留 ASYNC_AGENT_ALLOWED_TOOLS 中的工具
 *    （特殊情况：启用 agent swarms 的进程内 teammate 可额外使用 AgentTool 和 IN_PROCESS_TEAMMATE_ALLOWED_TOOLS）
 *
 * @param tools 待过滤的工具集
 * @param isBuiltIn 是否为内置 Agent
 * @param isAsync 是否为异步 Agent
 * @param permissionMode Agent 的权限模式
 * @returns 过滤后的工具集
 */
export function filterToolsForAgent({
  tools,
  isBuiltIn,
  isAsync = false,
  permissionMode,
}: {
  tools: Tools
  isBuiltIn: boolean
  isAsync?: boolean
  permissionMode?: PermissionMode
}): Tools {
  return tools.filter(tool => {
    // MCP 工具对所有 Agent 始终开放
    // Allow MCP tools for all agents
    if (tool.name.startsWith('mcp__')) {
      return true
    }
    // plan 模式下允许 ExitPlanMode 工具，绕过禁用列表（例如进程内 teammate）
    // Allow ExitPlanMode for agents in plan mode (e.g., in-process teammates)
    // This bypasses both the ALL_AGENT_DISALLOWED_TOOLS and async tool filters
    if (
      toolMatchesName(tool, EXIT_PLAN_MODE_V2_TOOL_NAME) &&
      permissionMode === 'plan'
    ) {
      return true
    }
    // 所有 Agent 通用禁用工具：直接剔除
    if (ALL_AGENT_DISALLOWED_TOOLS.has(tool.name)) {
      return false
    }
    // 自定义 Agent 额外禁用工具：仅对非内置 Agent 生效
    if (!isBuiltIn && CUSTOM_AGENT_DISALLOWED_TOOLS.has(tool.name)) {
      return false
    }
    if (isAsync && !ASYNC_AGENT_ALLOWED_TOOLS.has(tool.name)) {
      if (isAgentSwarmsEnabled() && isInProcessTeammate()) {
        // 启用 agent swarms 的进程内 teammate 可以生成同步子 Agent（非后台）
        // Allow AgentTool for in-process teammates to spawn sync subagents.
        // Validation in AgentTool.call() prevents background agents and teammate spawning.
        if (toolMatchesName(tool, AGENT_TOOL_NAME)) {
          return true
        }
        // 进程内 teammate 还可以使用任务协调相关工具
        // Allow task tools for in-process teammates to coordinate via shared task list
        if (IN_PROCESS_TEAMMATE_ALLOWED_TOOLS.has(tool.name)) {
          return true
        }
      }
      return false
    }
    return true
  })
}

/**
 * 将 AgentDefinition 的工具配置解析并校验为实际可用工具列表。
 *
 * 处理流程：
 * 1. 若为主线程，跳过 filterToolsForAgent（主线程工具池已由 useMergedTools 正确组装）
 * 2. 将 disallowedTools 解析为工具名 Set，从可用工具中排除
 * 3. 若工具配置为通配符（undefined 或 ['*']），返回所有允许工具
 * 4. 否则逐条解析工具规格：有效工具加入 resolvedTools，无效工具加入 invalidTools
 * 5. 特殊处理 Agent 工具规格中的 allowedAgentTypes 元数据（格式："Agent(type1,type2)"）
 *
 * @param agentDefinition Agent 定义（含工具配置和权限信息）
 * @param availableTools 当前上下文中实际可用的工具集合
 * @param isAsync 是否为异步 Agent
 * @param isMainThread 是否为主线程（跳过子 Agent 工具过滤）
 * @returns 工具解析结果，包含有效/无效工具列表及实际 Tool 对象数组
 */
export function resolveAgentTools(
  agentDefinition: Pick<
    AgentDefinition,
    'tools' | 'disallowedTools' | 'source' | 'permissionMode'
  >,
  availableTools: Tools,
  isAsync = false,
  isMainThread = false,
): ResolvedAgentTools {
  const {
    tools: agentTools,
    disallowedTools,
    source,
    permissionMode,
  } = agentDefinition
  // 主线程跳过子 Agent 过滤（useMergedTools 已正确组装主线程工具池）；
  // 子 Agent 则按规则过滤可用工具集。
  // When isMainThread is true, skip filterToolsForAgent entirely — the main
  // thread's tool pool is already properly assembled by useMergedTools(), so
  // the sub-agent disallow lists shouldn't apply.
  const filteredAvailableTools = isMainThread
    ? availableTools
    : filterToolsForAgent({
        tools: availableTools,
        isBuiltIn: source === 'built-in',
        isAsync,
        permissionMode,
      })

  // 构建禁用工具名 Set，用于快速查找
  // Create a set of disallowed tool names for quick lookup
  const disallowedToolSet = new Set(
    disallowedTools?.map(toolSpec => {
      const { toolName } = permissionRuleValueFromString(toolSpec)
      return toolName
    }) ?? [],
  )

  // 从过滤后的可用工具中排除禁用工具
  // Filter available tools based on disallowed list
  const allowedAvailableTools = filteredAvailableTools.filter(
    tool => !disallowedToolSet.has(tool.name),
  )

  // 判断是否使用通配符（undefined 或 ['*']），通配符则允许所有工具
  // If tools is undefined or ['*'], allow all tools (after filtering disallowed)
  const hasWildcard =
    agentTools === undefined ||
    (agentTools.length === 1 && agentTools[0] === '*')
  if (hasWildcard) {
    return {
      hasWildcard: true,
      validTools: [],
      invalidTools: [],
      resolvedTools: allowedAvailableTools, // 通配符时返回所有允许工具
    }
  }

  // 构建允许工具的名称 → Tool 对象映射，便于后续 O(1) 查询
  const availableToolMap = new Map<string, Tool>()
  for (const tool of allowedAvailableTools) {
    availableToolMap.set(tool.name, tool)
  }

  const validTools: string[] = []     // 有效工具规格列表
  const invalidTools: string[] = []   // 无效工具规格列表（工具不存在）
  const resolved: Tool[] = []         // 解析后的 Tool 对象列表
  const resolvedToolsSet = new Set<Tool>() // 去重集合，防止同一工具重复加入
  let allowedAgentTypes: string[] | undefined // 可选：限制可启动的子 Agent 类型

  for (const toolSpec of agentTools) {
    // 解析工具规格字符串，提取工具名和可选的权限规则内容
    // Parse the tool spec to extract the base tool name and any permission pattern
    const { toolName, ruleContent } = permissionRuleValueFromString(toolSpec)

    // 特殊处理 Agent 工具：从规格中提取 allowedAgentTypes 元数据
    // Special case: Agent tool carries allowedAgentTypes metadata in its spec
    if (toolName === AGENT_TOOL_NAME) {
      if (ruleContent) {
        // 解析逗号分隔的 Agent 类型列表："worker, researcher" → ["worker", "researcher"]
        // Parse comma-separated agent types: "worker, researcher" → ["worker", "researcher"]
        allowedAgentTypes = ruleContent.split(',').map(s => s.trim())
      }
      // 子 Agent 中 Agent 工具被 filterToolsForAgent 剔除——
      // 仅标记规格有效以追踪 allowedAgentTypes，跳过工具解析
      // For sub-agents, Agent is excluded by filterToolsForAgent — mark the spec
      // valid for allowedAgentTypes tracking but skip tool resolution.
      if (!isMainThread) {
        validTools.push(toolSpec)
        continue
      }
      // 主线程中过滤已跳过，Agent 工具在 availableToolMap 中存在——正常解析
      // For main thread, filtering was skipped so Agent is in availableToolMap —
      // fall through to normal resolution below.
    }

    // 在可用工具映射中查找该工具
    const tool = availableToolMap.get(toolName)
    if (tool) {
      validTools.push(toolSpec)
      // 使用 Set 去重，防止同一工具因多条规格被重复添加
      if (!resolvedToolsSet.has(tool)) {
        resolved.push(tool)
        resolvedToolsSet.add(tool)
      }
    } else {
      // 工具不存在于允许列表中，标记为无效
      invalidTools.push(toolSpec)
    }
  }

  return {
    hasWildcard: false,
    validTools,
    invalidTools,
    resolvedTools: resolved,
    allowedAgentTypes, // 仅在 Agent 工具规格中指定了类型限制时存在
  }
}

/**
 * Agent 工具执行结果的 Zod 序列化 schema。
 *
 * 该 schema 用于：
 * 1. 持久化 Agent 执行结果（写入磁盘）
 * 2. 反序列化（恢复 Agent 时读取历史结果）
 *
 * 注意：agentType 字段为可选——旧版持久化会话可能不包含该字段，
 * resume 时直接回放结果而不重新校验。
 */
export const agentToolResultSchema = lazySchema(() =>
  z.object({
    agentId: z.string(),
    // Optional: older persisted sessions won't have this (resume replays
    // results verbatim without re-validation). Used to gate the sync
    // result trailer — one-shot built-ins skip the SendMessage hint.
    agentType: z.string().optional(),
    content: z.array(z.object({ type: z.literal('text'), text: z.string() })),
    totalToolUseCount: z.number(),
    totalDurationMs: z.number(),
    totalTokens: z.number(),
    usage: z.object({
      input_tokens: z.number(),
      output_tokens: z.number(),
      cache_creation_input_tokens: z.number().nullable(),
      cache_read_input_tokens: z.number().nullable(),
      server_tool_use: z
        .object({
          web_search_requests: z.number(),
          web_fetch_requests: z.number(),
        })
        .nullable(),
      service_tier: z.enum(['standard', 'priority', 'batch']).nullable(),
      cache_creation: z
        .object({
          ephemeral_1h_input_tokens: z.number(),
          ephemeral_5m_input_tokens: z.number(),
        })
        .nullable(),
    }),
  }),
)

// Agent 工具执行结果的 TypeScript 类型（从 schema 推导）
export type AgentToolResult = z.input<ReturnType<typeof agentToolResultSchema>>

/**
 * 统计消息列表中 assistant 消息的工具调用次数。
 *
 * 遍历所有消息，累计 assistant 消息内容中 tool_use 类型 block 的数量。
 *
 * @param messages 消息列表
 * @returns 工具调用总次数
 */
export function countToolUses(messages: MessageType[]): number {
  let count = 0
  for (const m of messages) {
    if (m.type === 'assistant') {
      for (const block of m.message.content) {
        if (block.type === 'tool_use') {
          count++ // 每个 tool_use block 计一次
        }
      }
    }
  }
  return count
}

/**
 * 整合 Agent 执行结果，触发分析事件并返回序列化的结果对象。
 *
 * 处理流程：
 * 1. 从最后一条 assistant 消息提取文本内容
 *    - 若最后一条消息无文本（纯 tool_use），向前扫描找到最近有文本的消息
 * 2. 计算 token 数量和工具调用次数
 * 3. 触发 tengu_agent_tool_completed 分析事件
 * 4. 发送缓存驱逐提示事件（告知推理层子 Agent 缓存链可回收）
 * 5. 返回 AgentToolResult 对象
 *
 * @param agentMessages Agent 执行期间积累的所有消息
 * @param agentId Agent 实例 ID
 * @param metadata Agent 执行元数据（类型、模型、时间等）
 * @returns 序列化的 Agent 执行结果
 */
export function finalizeAgentTool(
  agentMessages: MessageType[],
  agentId: string,
  metadata: {
    prompt: string
    resolvedAgentModel: string
    isBuiltInAgent: boolean
    startTime: number
    agentType: string
    isAsync: boolean
  },
): AgentToolResult {
  const {
    prompt,
    resolvedAgentModel,
    isBuiltInAgent,
    startTime,
    agentType,
    isAsync,
  } = metadata

  // 获取最后一条 assistant 消息
  const lastAssistantMessage = getLastAssistantMessage(agentMessages)
  if (lastAssistantMessage === undefined) {
    throw new Error('No assistant messages found')
  }
  // 提取最后一条 assistant 消息的文本内容。
  // 若最后一条消息为纯 tool_use block（循环在中途退出），
  // 向前扫描找到最近包含文本内容的消息。
  // Extract text content from the agent's response. If the final assistant
  // message is a pure tool_use block (loop exited mid-turn), fall back to
  // the most recent assistant message that has text content.
  let content = lastAssistantMessage.message.content.filter(
    _ => _.type === 'text',
  )
  if (content.length === 0) {
    // 最后一条消息无文本，向前扫描
    for (let i = agentMessages.length - 1; i >= 0; i--) {
      const m = agentMessages[i]!
      if (m.type !== 'assistant') continue
      const textBlocks = m.message.content.filter(_ => _.type === 'text')
      if (textBlocks.length > 0) {
        content = textBlocks
        break
      }
    }
  }

  // 从最后一条 assistant 消息的 usage 中计算总 token 数
  const totalTokens = getTokenCountFromUsage(lastAssistantMessage.message.usage)
  // 统计 Agent 执行期间的总工具调用次数
  const totalToolUseCount = countToolUses(agentMessages)

  // 触发 Agent 完成分析事件，上报执行指标
  logEvent('tengu_agent_tool_completed', {
    agent_type:
      agentType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    model:
      resolvedAgentModel as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    prompt_char_count: prompt.length,
    response_char_count: content.length,
    assistant_message_count: agentMessages.length,
    total_tool_uses: totalToolUseCount,
    duration_ms: Date.now() - startTime,
    total_tokens: totalTokens,
    is_built_in_agent: isBuiltInAgent,
    is_async: isAsync,
  })

  // 向推理层发送缓存驱逐提示：子 Agent 已完成，其缓存链可被回收
  // Signal to inference that this subagent's cache chain can be evicted.
  const lastRequestId = lastAssistantMessage.requestId
  if (lastRequestId) {
    logEvent('tengu_cache_eviction_hint', {
      scope:
        'subagent_end' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      last_request_id:
        lastRequestId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
  }

  return {
    agentId,
    agentType,
    content,
    totalDurationMs: Date.now() - startTime,
    totalTokens,
    totalToolUseCount,
    usage: lastAssistantMessage.message.usage,
  }
}

/**
 * 获取 assistant 消息中最后一个 tool_use block 的工具名称。
 *
 * 用于进度追踪，在消息流中实时获取 Agent 当前正在调用的工具。
 *
 * @param message 待检测的消息
 * @returns 最后一个 tool_use block 的工具名，若消息不含 tool_use 则返回 undefined
 */
export function getLastToolUseName(message: MessageType): string | undefined {
  if (message.type !== 'assistant') return undefined
  // 使用 findLast 从后向前查找最后一个 tool_use block
  const block = message.message.content.findLast(b => b.type === 'tool_use')
  return block?.type === 'tool_use' ? block.name : undefined
}

/**
 * 触发 SDK 层的任务进度事件。
 *
 * 将 ProgressTracker 中的最新进度状态（最近活动描述、token 数等）
 * 封装后通过 emitTaskProgressEvent 上报给 SDK 消费方。
 *
 * @param tracker 进度追踪器
 * @param taskId 任务 ID
 * @param toolUseId 触发该任务的工具调用 ID
 * @param description 任务描述
 * @param startTime 任务启动时间戳
 * @param lastToolName 当前最后调用的工具名
 */
export function emitTaskProgress(
  tracker: ProgressTracker,
  taskId: string,
  toolUseId: string | undefined,
  description: string,
  startTime: number,
  lastToolName: string,
): void {
  const progress = getProgressUpdate(tracker)
  emitTaskProgressEvent({
    taskId,
    toolUseId,
    // 优先使用进度追踪器中的最近活动描述，否则用任务描述作为兜底
    description: progress.lastActivity?.activityDescription ?? description,
    startTime,
    totalTokens: progress.tokenCount,
    toolUses: progress.toolUseCount,
    lastToolName,
  })
}

/**
 * 若 TRANSCRIPT_CLASSIFIER 特性门控启用，对子 Agent 的交接进行安全分类。
 *
 * 仅在 auto 权限模式下生效。通过调用 classifyYoloAction 分析子 Agent 的
 * 完整对话记录，检测是否存在违反安全策略的操作。
 *
 * 返回值含义：
 * - null    — 无需警告（特性未启用、非 auto 模式、或分类通过）
 * - string  — 安全警告文本（需追加到最终消息开头）
 *
 * @param agentMessages 子 Agent 的所有消息
 * @param tools 子 Agent 可用工具集
 * @param toolPermissionContext 当前权限上下文
 * @param abortSignal 中止信号
 * @param subagentType 子 Agent 类型名称
 * @param totalToolUseCount 总工具调用次数
 * @returns 安全警告字符串，或 null（无警告）
 */
export async function classifyHandoffIfNeeded({
  agentMessages,
  tools,
  toolPermissionContext,
  abortSignal,
  subagentType,
  totalToolUseCount,
}: {
  agentMessages: MessageType[]
  tools: Tools
  toolPermissionContext: AppState['toolPermissionContext']
  abortSignal: AbortSignal
  subagentType: string
  totalToolUseCount: number
}): Promise<string | null> {
  if (feature('TRANSCRIPT_CLASSIFIER')) {
    // 仅在 auto 权限模式下执行分类（其他模式下跳过）
    if (toolPermissionContext.mode !== 'auto') return null

    // 构建分类器输入记录（提取 Agent 对话历史）
    const agentTranscript = buildTranscriptForClassifier(agentMessages, tools)
    if (!agentTranscript) return null

    // 调用分类器：检测子 Agent 是否执行了违反安全策略的操作
    const classifierResult = await classifyYoloAction(
      agentMessages,
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: "Sub-agent has finished and is handing back control to the main agent. Review the sub-agent's work based on the block rules and let the main agent know if any file is dangerous (the main agent will see the reason).",
          },
        ],
      },
      tools,
      toolPermissionContext as ToolPermissionContext,
      abortSignal,
    )

    // 确定交接决策：unavailable（不可用）/ blocked（拦截）/ allowed（允许）
    const handoffDecision = classifierResult.unavailable
      ? 'unavailable'
      : classifierResult.shouldBlock
        ? 'blocked'
        : 'allowed'
    // 记录分类决策分析事件
    logEvent('tengu_auto_mode_decision', {
      decision:
        handoffDecision as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      toolName:
        // Use legacy name for analytics continuity across the Task→Agent rename
        // 使用旧名称保持分析指标在 Task→Agent 重命名前后的一致性
        LEGACY_AGENT_TOOL_NAME as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      inProtectedNamespace: isInProtectedNamespace(),
      classifierModel:
        classifierResult.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      agentType:
        subagentType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      toolUseCount: totalToolUseCount,
      isHandoff: true,
      // For handoff, the relevant agent completion is the subagent's final
      // assistant message — the last thing the classifier transcript shows
      // before the handoff review prompt.
      agentMsgId: getLastAssistantMessage(agentMessages)?.message
        .id as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      classifierStage:
        classifierResult.stage as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      classifierStage1RequestId:
        classifierResult.stage1RequestId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      classifierStage1MsgId:
        classifierResult.stage1MsgId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      classifierStage2RequestId:
        classifierResult.stage2RequestId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      classifierStage2MsgId:
        classifierResult.stage2MsgId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })

    if (classifierResult.shouldBlock) {
      // 分类器不可用时：允许子 Agent 输出继续传递，但追加警告提示父 Agent 自行核查
      // When classifier is unavailable, still propagate the sub-agent's
      // results but with a warning so the parent agent can verify the work.
      if (classifierResult.unavailable) {
        logForDebugging(
          'Handoff classifier unavailable, allowing sub-agent output with warning',
          { level: 'warn' },
        )
        return `Note: The safety classifier was unavailable when reviewing this sub-agent's work. Please carefully verify the sub-agent's actions and output before acting on them.`
      }

      // 分类器明确拦截：返回安全警告文本
      logForDebugging(
        `Handoff classifier flagged sub-agent output: ${classifierResult.reason}`,
        { level: 'warn' },
      )
      return `SECURITY WARNING: This sub-agent performed actions that may violate security policy. Reason: ${classifierResult.reason}. Review the sub-agent's actions carefully before acting on its output.`
    }
  }

  return null // 无警告
}

/**
 * 从 Agent 已积累的消息中提取部分结果字符串。
 *
 * 用于异步 Agent 被终止时（AbortError），保留其已完成工作的摘要。
 * 从最后一条消息向前扫描，返回第一条包含文本内容的 assistant 消息的文本。
 *
 * @param messages 已积累的消息列表
 * @returns 最近一条包含文本的 assistant 消息的文本内容，若无则返回 undefined
 */
export function extractPartialResult(
  messages: MessageType[],
): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (m.type !== 'assistant') continue
    const text = extractTextContent(m.message.content, '\n')
    if (text) {
      return text
    }
  }
  return undefined
}

// setAppState 函数类型：接受一个状态变换函数，更新 AppState
type SetAppState = (f: (prev: AppState) => AppState) => void

/**
 * 驱动后台 Agent 从启动到终止通知的完整生命周期。
 *
 * 该函数由 AgentTool 的异步启动路径和 resumeAgentBackground 共同使用，
 * 统一处理消息流消费、进度追踪、汇总、完成/失败/终止通知等逻辑。
 *
 * 生命周期流程：
 * 1. 初始化进度追踪器和活动描述解析器
 * 2. 若启用汇总，在获得缓存安全参数后启动 Agent 汇总服务
 * 3. 迭代消费消息流：
 *    a. 将消息追加到本地状态（若 UI 仍持有该任务）
 *    b. 更新进度追踪器并触发 SDK 进度事件
 * 4. 消息流结束后，调用 finalizeAgentTool 整合结果
 * 5. 先标记任务为"已完成"（解除 TaskOutput(block=true) 的阻塞）
 * 6. 再异步执行安全分类和 worktree 结果查询（非阻塞性附加操作）
 * 7. 最终触发完成通知
 *
 * 错误处理：
 * - AbortError（用户主动终止）：标记为 killed，触发终止通知
 * - 其他错误：标记为 failed，触发失败通知
 *
 * @param taskId 任务/Agent ID
 * @param abortController 用于中止 Agent 的控制器
 * @param makeStream 创建消息流的工厂函数（接受可选的缓存安全参数回调）
 * @param metadata Agent 执行元数据
 * @param description 任务描述（UI 展示用）
 * @param toolUseContext 工具调用上下文
 * @param rootSetAppState 根级别的状态更新函数（可触达根 store）
 * @param agentIdForCleanup 清理时使用的 Agent ID
 * @param enableSummarization 是否启用 Agent 汇总
 * @param getWorktreeResult 获取 worktree 执行结果的异步函数
 */
export async function runAsyncAgentLifecycle({
  taskId,
  abortController,
  makeStream,
  metadata,
  description,
  toolUseContext,
  rootSetAppState,
  agentIdForCleanup,
  enableSummarization,
  getWorktreeResult,
}: {
  taskId: string
  abortController: AbortController
  makeStream: (
    onCacheSafeParams: ((p: CacheSafeParams) => void) | undefined,
  ) => AsyncGenerator<MessageType, void>
  metadata: Parameters<typeof finalizeAgentTool>[2]
  description: string
  toolUseContext: ToolUseContext
  rootSetAppState: SetAppState
  agentIdForCleanup: string
  enableSummarization: boolean
  getWorktreeResult: () => Promise<{
    worktreePath?: string
    worktreeBranch?: string
  }>
}): Promise<void> {
  let stopSummarization: (() => void) | undefined // 停止汇总服务的回调
  const agentMessages: MessageType[] = [] // 累积所有 Agent 消息
  try {
    // 初始化进度追踪器
    const tracker = createProgressTracker()
    // 创建活动描述解析器（将工具名映射为人类可读的活动描述）
    const resolveActivity = createActivityDescriptionResolver(
      toolUseContext.options.tools,
    )
    // 若启用汇总，在获得缓存安全参数时启动 Agent 汇总服务
    const onCacheSafeParams = enableSummarization
      ? (params: CacheSafeParams) => {
          const { stop } = startAgentSummarization(
            taskId,
            asAgentId(taskId),
            params,
            rootSetAppState,
          )
          stopSummarization = stop // 保存停止函数以备后续调用
        }
      : undefined
    // 迭代消费消息流
    for await (const message of makeStream(onCacheSafeParams)) {
      agentMessages.push(message)
      // 若 UI 仍持有该任务（retain=true），立即将消息追加到本地状态。
      // Bootstrap 从磁盘并行读取并通过 UUID 合并前缀——
      // 先写磁盘再 yield 确保实时数据始终是磁盘数据的后缀，合并顺序正确。
      // Append immediately when UI holds the task (retain). Bootstrap reads
      // disk in parallel and UUID-merges the prefix — disk-write-before-yield
      // means live is always a suffix of disk, so merge is order-correct.
      rootSetAppState(prev => {
        const t = prev.tasks[taskId]
        if (!isLocalAgentTask(t) || !t.retain) return prev
        const base = t.messages ?? []
        return {
          ...prev,
          tasks: {
            ...prev.tasks,
            [taskId]: { ...t, messages: [...base, message] },
          },
        }
      })
      // 更新进度追踪器状态
      updateProgressFromMessage(
        tracker,
        message,
        resolveActivity,
        toolUseContext.options.tools,
      )
      // 将进度更新同步到任务状态
      updateAsyncAgentProgress(
        taskId,
        getProgressUpdate(tracker),
        rootSetAppState,
      )
      // 若消息包含工具调用，触发 SDK 进度事件
      const lastToolName = getLastToolUseName(message)
      if (lastToolName) {
        emitTaskProgress(
          tracker,
          taskId,
          toolUseContext.toolUseId,
          description,
          metadata.startTime,
          lastToolName,
        )
      }
    }

    // 消息流结束，停止汇总服务
    stopSummarization?.()

    // 整合 Agent 执行结果（提取文本、统计 token 和工具调用、触发分析事件）
    const agentResult = finalizeAgentTool(agentMessages, taskId, metadata)

    // 优先标记任务为"已完成"，解除 TaskOutput(block=true) 的阻塞。
    // classifyHandoffIfNeeded（API 调用）和 getWorktreeResult（git 命令）
    // 是通知的附加信息，可能耗时，不应阻塞状态转换。
    // Mark task completed FIRST so TaskOutput(block=true) unblocks
    // immediately. classifyHandoffIfNeeded (API call) and getWorktreeResult
    // (git exec) are notification embellishments that can hang — they must
    // not gate the status transition (gh-20236).
    completeAsyncAgent(agentResult, rootSetAppState)

    let finalMessage = extractTextContent(agentResult.content, '\n')

    // 若 TRANSCRIPT_CLASSIFIER 特性启用，对交接进行安全分类
    if (feature('TRANSCRIPT_CLASSIFIER')) {
      const handoffWarning = await classifyHandoffIfNeeded({
        agentMessages,
        tools: toolUseContext.options.tools,
        toolPermissionContext:
          toolUseContext.getAppState().toolPermissionContext,
        abortSignal: abortController.signal,
        subagentType: metadata.agentType,
        totalToolUseCount: agentResult.totalToolUseCount,
      })
      if (handoffWarning) {
        // 将安全警告追加到最终消息开头
        finalMessage = `${handoffWarning}\n\n${finalMessage}`
      }
    }

    // 获取 worktree 执行结果（若 Agent 在 worktree 中运行）
    const worktreeResult = await getWorktreeResult()

    // 触发完成通知（包含最终消息、token 用量和 worktree 信息）
    enqueueAgentNotification({
      taskId,
      description,
      status: 'completed',
      setAppState: rootSetAppState,
      finalMessage,
      usage: {
        totalTokens: getTokenCountFromTracker(tracker),
        toolUses: agentResult.totalToolUseCount,
        durationMs: agentResult.totalDurationMs,
      },
      toolUseId: toolUseContext.toolUseId,
      ...worktreeResult,
    })
  } catch (error) {
    // 无论何种错误，先停止汇总服务
    stopSummarization?.()
    if (error instanceof AbortError) {
      // 用户主动终止（AbortError）：
      // killAsyncAgent 在 TaskStop 已将状态设为 killed 时为空操作——
      // 但只有此 catch 块持有 agentMessages，通知必须无条件发出。
      // 先转换状态（确保 TaskOutput 在 git 挂起时也能解除阻塞），再清理。
      // killAsyncAgent is a no-op if TaskStop already set status='killed' —
      // but only this catch handler has agentMessages, so the notification
      // must fire unconditionally. Transition status BEFORE worktree cleanup
      // so TaskOutput unblocks even if git hangs (gh-20236).
      killAsyncAgent(taskId, rootSetAppState)
      // 记录终止分析事件
      logEvent('tengu_agent_tool_terminated', {
        agent_type:
          metadata.agentType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        model:
          metadata.resolvedAgentModel as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        duration_ms: Date.now() - metadata.startTime,
        is_async: true,
        is_built_in_agent: metadata.isBuiltInAgent,
        reason:
          'user_kill_async' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
      // 获取 worktree 结果并触发终止通知（包含部分结果）
      const worktreeResult = await getWorktreeResult()
      const partialResult = extractPartialResult(agentMessages)
      enqueueAgentNotification({
        taskId,
        description,
        status: 'killed',
        setAppState: rootSetAppState,
        toolUseId: toolUseContext.toolUseId,
        finalMessage: partialResult, // 保留已完成工作的部分结果
        ...worktreeResult,
      })
      return
    }
    // 其他错误（非用户终止）：标记任务失败并触发失败通知
    const msg = errorMessage(error)
    failAsyncAgent(taskId, msg, rootSetAppState)
    const worktreeResult = await getWorktreeResult()
    enqueueAgentNotification({
      taskId,
      description,
      status: 'failed',
      error: msg,
      setAppState: rootSetAppState,
      toolUseId: toolUseContext.toolUseId,
      ...worktreeResult,
    })
  } finally {
    // 无论成功/失败/终止，清理 Agent 级别的状态
    clearInvokedSkillsForAgent(agentIdForCleanup) // 清除已调用技能记录
    clearDumpState(agentIdForCleanup)              // 清除 dump 状态
  }
}
