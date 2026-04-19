/**
 * Agent 恢复执行模块
 *
 * 在 Claude Code AgentTool 层中，该模块负责将之前保存的异步 Agent
 * 从磁盘 transcript 中恢复并继续后台执行。
 *
 * 核心职责：
 * 1. `ResumeAgentResult` — 恢复结果类型（agentId、description、outputFile）
 * 2. `resumeAgentBackground()` — 加载 transcript + 元数据，过滤无效消息，
 *    重建 contentReplacementState，解析 Agent 定义，
 *    重建 fork 父 Agent 系统提示（若为 fork 恢复），
 *    调用 registerAsyncAgent 注册后台任务，
 *    通过 runAsyncAgentLifecycle fire-and-forget 启动异步执行
 *
 * 关键设计说明：
 * - worktree 恢复：通过 fsp.stat 检查 worktree 是否仍存在；若已删除则降级到父 cwd
 * - worktree mtime 更新：防止 stale-worktree 清理任务删除刚恢复的 worktree
 * - Agent 定义解析优先级：FORK_AGENT → 活跃 Agent 列表中查找 → GENERAL_PURPOSE 兜底
 * - fork 系统提示重建：优先使用 renderedSystemPrompt（字节精确），
 *   降级时通过 buildEffectiveSystemPrompt 重新构建（可能因 GrowthBook 状态差异而不一致）
 * - transcript 消息过滤顺序：filterUnresolvedToolUses → filterOrphanedThinkingOnlyMessages
 *   → filterWhitespaceOnlyAssistantMessages
 */

import { promises as fsp } from 'fs'
import { getSdkAgentProgressSummariesEnabled } from '../../bootstrap/state.js'
import { getSystemPrompt } from '../../constants/prompts.js'
import { isCoordinatorMode } from '../../coordinator/coordinatorMode.js'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import type { ToolUseContext } from '../../Tool.js'
import { registerAsyncAgent } from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import { assembleToolPool } from '../../tools.js'
import { asAgentId } from '../../types/ids.js'
import { runWithAgentContext } from '../../utils/agentContext.js'
import { runWithCwdOverride } from '../../utils/cwd.js'
import { logForDebugging } from '../../utils/debug.js'
import {
  createUserMessage,
  filterOrphanedThinkingOnlyMessages,
  filterUnresolvedToolUses,
  filterWhitespaceOnlyAssistantMessages,
} from '../../utils/messages.js'
import { getAgentModel } from '../../utils/model/agent.js'
import { getQuerySourceForAgent } from '../../utils/promptCategory.js'
import {
  getAgentTranscript,
  readAgentMetadata,
} from '../../utils/sessionStorage.js'
import { buildEffectiveSystemPrompt } from '../../utils/systemPrompt.js'
import type { SystemPrompt } from '../../utils/systemPromptType.js'
import { getTaskOutputPath } from '../../utils/task/diskOutput.js'
import { getParentSessionId } from '../../utils/teammate.js'
import { reconstructForSubagentResume } from '../../utils/toolResultStorage.js'
import { runAsyncAgentLifecycle } from './agentToolUtils.js'
import { GENERAL_PURPOSE_AGENT } from './built-in/generalPurposeAgent.js'
import { FORK_AGENT, isForkSubagentEnabled } from './forkSubagent.js'
import type { AgentDefinition } from './loadAgentsDir.js'
import { isBuiltInAgent } from './loadAgentsDir.js'
import { runAgent } from './runAgent.js'

// Agent 恢复操作的返回结果类型
export type ResumeAgentResult = {
  agentId: string      // 恢复的 Agent ID
  description: string  // Agent 描述（用于 UI 显示）
  outputFile: string   // Agent 输出文件路径（供调用方读取结果）
}

/**
 * 将之前保存的异步 Agent 从 transcript 恢复并在后台继续执行。
 *
 * 执行流程：
 * 1. 并发加载 transcript 和元数据
 * 2. 过滤无效消息（空白消息、孤立 thinking 消息、未解析的 tool_use）
 * 3. 重建 contentReplacementState
 * 4. 检查并恢复 worktree 路径（不存在则降级到父 cwd）
 * 5. 解析 Agent 定义（FORK_AGENT / 活跃列表 / GENERAL_PURPOSE 兜底）
 * 6. 若为 fork 恢复，重建父 Agent 系统提示
 * 7. 组装 workerTools（fork 恢复复用父 Agent 工具池）
 * 8. 注册 LocalAgentTask 后台任务
 * 9. fire-and-forget 启动 runAsyncAgentLifecycle
 * 10. 立即返回 ResumeAgentResult（不等待 Agent 完成）
 *
 * @param agentId 要恢复的 Agent ID
 * @param prompt 新的用户提示（追加到恢复的消息历史后）
 * @param toolUseContext 当前工具使用上下文
 * @param canUseTool 工具使用权限检查函数
 * @param invokingRequestId 调用者的请求 ID（用于关联追踪）
 * @returns ResumeAgentResult（含 agentId、description、outputFile）
 */
export async function resumeAgentBackground({
  agentId,
  prompt,
  toolUseContext,
  canUseTool,
  invokingRequestId,
}: {
  agentId: string
  prompt: string
  toolUseContext: ToolUseContext
  canUseTool: CanUseToolFn
  invokingRequestId?: string
}): Promise<ResumeAgentResult> {
  const startTime = Date.now()
  const appState = toolUseContext.getAppState()
  // in-process teammate 的 setAppState 是无操作的；
  // setAppStateForTasks 直达根存储，使任务注册/进度/终止在 UI 中保持可见
  const rootSetAppState =
    toolUseContext.setAppStateForTasks ?? toolUseContext.setAppState
  const permissionMode = appState.toolPermissionContext.mode

  // 并发加载 transcript 和 Agent 元数据，提升恢复速度
  const [transcript, meta] = await Promise.all([
    getAgentTranscript(asAgentId(agentId)),
    readAgentMetadata(asAgentId(agentId)),
  ])
  if (!transcript) {
    throw new Error(`No transcript found for agent ID: ${agentId}`)
  }

  // 过滤无效消息（顺序很重要）：
  // 1. 过滤未解析的 tool_use（有工具调用但无对应结果）
  // 2. 过滤孤立的仅含 thinking 内容的助手消息
  // 3. 过滤空白内容的助手消息
  const resumedMessages = filterWhitespaceOnlyAssistantMessages(
    filterOrphanedThinkingOnlyMessages(
      filterUnresolvedToolUses(transcript.messages),
    ),
  )

  // 重建 contentReplacementState（合并父 Agent 的替换状态与 transcript 中的替换记录）
  const resumedReplacementState = reconstructForSubagentResume(
    toolUseContext.contentReplacementState,
    resumedMessages,
    transcript.contentReplacements,
  )

  // 尽力检查 worktree 路径是否仍存在：
  // 若原 worktree 已被外部删除，降级到父 cwd，避免后续 chdir 崩溃
  const resumedWorktreePath = meta?.worktreePath
    ? await fsp.stat(meta.worktreePath).then(
        s => (s.isDirectory() ? meta.worktreePath : undefined),
        () => {
          logForDebugging(
            `Resumed worktree ${meta.worktreePath} no longer exists; falling back to parent cwd`,
          )
          return undefined
        },
      )
    : undefined

  if (resumedWorktreePath) {
    // 更新 mtime，防止 stale-worktree 清理任务删除刚恢复的 worktree（#22355）
    const now = new Date()
    await fsp.utimes(resumedWorktreePath, now, now)
  }

  // 跳过 filterDeniedAgents 重新门控——原始生成时已通过权限检查
  // Agent 定义解析优先级：FORK_AGENT → 活跃列表查找 → GENERAL_PURPOSE 兜底
  let selectedAgent: AgentDefinition
  let isResumedFork = false
  if (meta?.agentType === FORK_AGENT.agentType) {
    // 恢复的是 fork 子 Agent
    selectedAgent = FORK_AGENT
    isResumedFork = true
  } else if (meta?.agentType) {
    // 从活跃 Agent 列表中查找对应定义
    const found = toolUseContext.options.agentDefinitions.activeAgents.find(
      a => a.agentType === meta.agentType,
    )
    selectedAgent = found ?? GENERAL_PURPOSE_AGENT  // 未找到时使用通用 Agent 兜底
  } else {
    // 无元数据记录：使用通用 Agent 兜底
    selectedAgent = GENERAL_PURPOSE_AGENT
  }

  // UI 显示描述：优先使用元数据中保存的描述，无则使用 '(resumed)'
  const uiDescription = meta?.description ?? '(resumed)'

  // 重建 fork 父 Agent 系统提示（仅 fork 恢复时需要）
  let forkParentSystemPrompt: SystemPrompt | undefined
  if (isResumedFork) {
    if (toolUseContext.renderedSystemPrompt) {
      // 优先使用已渲染的系统提示（字节精确，避免 GrowthBook 状态差异）
      forkParentSystemPrompt = toolUseContext.renderedSystemPrompt
    } else {
      // 降级：重新构建系统提示（可能与原始提示存在微小差异）
      const mainThreadAgentDefinition = appState.agent
        ? appState.agentDefinitions.activeAgents.find(
            a => a.agentType === appState.agent,
          )
        : undefined
      const additionalWorkingDirectories = Array.from(
        appState.toolPermissionContext.additionalWorkingDirectories.keys(),
      )
      // 构建基础系统提示
      const defaultSystemPrompt = await getSystemPrompt(
        toolUseContext.options.tools,
        toolUseContext.options.mainLoopModel,
        additionalWorkingDirectories,
        toolUseContext.options.mcpClients,
      )
      // 构建包含 Agent 定义的完整系统提示
      forkParentSystemPrompt = buildEffectiveSystemPrompt({
        mainThreadAgentDefinition,
        toolUseContext,
        customSystemPrompt: toolUseContext.options.customSystemPrompt,
        defaultSystemPrompt,
        appendSystemPrompt: toolUseContext.options.appendSystemPrompt,
      })
    }
    if (!forkParentSystemPrompt) {
      throw new Error(
        'Cannot resume fork agent: unable to reconstruct parent system prompt',
      )
    }
  }

  // 解析 Agent 模型（用于统计元数据；runAgent 内部会自行解析实际使用的模型）
  const resolvedAgentModel = getAgentModel(
    selectedAgent.model,
    toolUseContext.options.mainLoopModel,
    undefined,
    permissionMode,
  )

  // 组装工作工具池：
  // - fork 恢复：复用父 Agent 的完整工具池（保持缓存一致性）
  // - 普通恢复：根据权限上下文重新组装工具池
  const workerPermissionContext = {
    ...appState.toolPermissionContext,
    mode: selectedAgent.permissionMode ?? 'acceptEdits',
  }
  const workerTools = isResumedFork
    ? toolUseContext.options.tools  // fork 复用父 Agent 工具池
    : assembleToolPool(workerPermissionContext, appState.mcp.tools)

  // 构建 runAgent 参数
  const runAgentParams: Parameters<typeof runAgent>[0] = {
    agentDefinition: selectedAgent,
    promptMessages: [
      ...resumedMessages,                    // 恢复的历史消息
      createUserMessage({ content: prompt }), // 新的用户提示
    ],
    toolUseContext,
    canUseTool,
    isAsync: true,  // 始终以异步后台模式执行
    querySource: getQuerySourceForAgent(
      selectedAgent.agentType,
      isBuiltInAgent(selectedAgent),
    ),
    model: undefined,  // 由 runAgent 内部解析
    // fork 恢复：传入父 Agent 已渲染的系统提示（缓存一致前缀）
    // 普通恢复：undefined → runAgent 在 wrapWithCwd 下重新计算（getCwd() 能看到 resumedWorktreePath）
    override: isResumedFork
      ? { systemPrompt: forkParentSystemPrompt }
      : undefined,
    availableTools: workerTools,
    // transcript 中已包含原始 fork 时的父 Agent 上下文切片；
    // 重新传入会导致 tool_use ID 重复
    forkContextMessages: undefined,
    ...(isResumedFork && { useExactTools: true }),  // fork 恢复时使用精确工具列表
    // 重新持久化，避免 runAgent 的 writeAgentMetadata 覆盖 worktree 路径信息
    worktreePath: resumedWorktreePath,
    description: meta?.description,
    contentReplacementState: resumedReplacementState,
  }

  // 跳过名称注册写入——初始生成时已创建持久化条目
  const agentBackgroundTask = registerAsyncAgent({
    agentId,
    description: uiDescription,
    prompt,
    selectedAgent,
    setAppState: rootSetAppState,
    toolUseId: toolUseContext.toolUseId,
  })

  // 统计元数据（用于 runAsyncAgentLifecycle 的事件上报）
  const metadata = {
    prompt,
    resolvedAgentModel,
    isBuiltInAgent: isBuiltInAgent(selectedAgent),
    startTime,
    agentType: selectedAgent.agentType,
    isAsync: true,
  }

  // 异步 Agent 上下文（用于 Agent 追踪和关联）
  const asyncAgentContext = {
    agentId,
    parentSessionId: getParentSessionId(),
    agentType: 'subagent' as const,
    subagentName: selectedAgent.agentType,
    isBuiltIn: isBuiltInAgent(selectedAgent),
    invokingRequestId,
    invocationKind: 'resume' as const,  // 标记为恢复类型（区别于初次生成）
    invocationEmitted: false,
  }

  // cwd 包装函数：若有 worktree 路径则切换 cwd，否则直接执行
  const wrapWithCwd = <T>(fn: () => T): T =>
    resumedWorktreePath ? runWithCwdOverride(resumedWorktreePath, fn) : fn()

  // fire-and-forget：启动异步 Agent 生命周期（不等待完成，立即返回）
  void runWithAgentContext(asyncAgentContext, () =>
    wrapWithCwd(() =>
      runAsyncAgentLifecycle({
        taskId: agentBackgroundTask.agentId,
        abortController: agentBackgroundTask.abortController!,
        makeStream: onCacheSafeParams =>
          runAgent({
            ...runAgentParams,
            override: {
              ...runAgentParams.override,
              agentId: asAgentId(agentBackgroundTask.agentId),
              abortController: agentBackgroundTask.abortController!,
            },
            onCacheSafeParams,
          }),
        metadata,
        description: uiDescription,
        toolUseContext,
        rootSetAppState,
        agentIdForCleanup: agentId,
        // 汇总功能：Coordinator 模式 / fork 模式 / SDK 进度汇总开关 三者之一启用即开启
        enableSummarization:
          isCoordinatorMode() ||
          isForkSubagentEnabled() ||
          getSdkAgentProgressSummariesEnabled(),
        getWorktreeResult: async () =>
          resumedWorktreePath ? { worktreePath: resumedWorktreePath } : {},
      }),
    ),
  )

  // 立即返回恢复结果（不等待 Agent 执行完成）
  return {
    agentId,
    description: uiDescription,
    outputFile: getTaskOutputPath(agentId),  // Agent 输出文件路径
  }
}
