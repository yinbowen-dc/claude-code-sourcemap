/**
 * Agent 核心执行模块
 *
 * 在 Claude Code AgentTool 层中，该模块是子 Agent 执行的核心驱动器——
 * 负责将 AgentDefinition 转化为实际运行的 Agent 实例，协调模型调用、工具解析、
 * MCP 服务器初始化、技能预加载、权限上下文构建以及 transcript 持久化等全生命周期。
 *
 * 核心职责：
 * 1. `initializeAgentMcpServers()` — 为 Agent 初始化专属 MCP 服务器（叠加到父 Agent 连接）
 * 2. `isRecordableMessage()` — 类型守卫：判断消息是否需要记录到 sidechain transcript
 * 3. `runAgent()` — 异步生成器：完整 Agent 执行生命周期（模型解析 → 工具构建 → 查询循环 → 清理）
 * 4. `filterIncompleteToolCalls()` — 过滤携带孤立 tool_use 的助手消息（避免 API 报错）
 * 5. `getAgentSystemPrompt()` — 构建并增强 Agent 系统提示（含环境细节注入）
 * 6. `resolveSkillName()` — 三策略技能名称解析（精确匹配 → 插件前缀 → 后缀匹配）
 *
 * 关键设计说明：
 * - useExactTools 路径（fork 子 Agent）：直接使用父 Agent 工具池，跳过 resolveAgentTools，
 *   保证 API 请求前缀字节相同，最大化提示缓存命中率
 * - MONITOR_TOOL 特性使用动态 require() 避免循环依赖（避免模块加载时死锁）
 * - TRANSCRIPT_CLASSIFIER 特性：当权限模式为 'auto' 时阻止 Agent 覆盖权限模式
 * - 异步 Agent 使用独立的 AbortController（与父 Agent 解耦），同步 Agent 共享父 Agent 控制器
 * - finally 块保证资源清理（MCP、hooks、perfetto、transcript、todos、shell 任务）
 */

import { feature } from 'bun:bundle'
import type { UUID } from 'crypto'
import { randomUUID } from 'crypto'
import uniqBy from 'lodash-es/uniqBy.js'
import { logForDebugging } from 'src/utils/debug.js'
import { getProjectRoot, getSessionId } from '../../bootstrap/state.js'
import { getCommand, getSkillToolCommands, hasCommand } from '../../commands.js'
import {
  DEFAULT_AGENT_PROMPT,
  enhanceSystemPromptWithEnvDetails,
} from '../../constants/prompts.js'
import type { QuerySource } from '../../constants/querySource.js'
import { getSystemContext, getUserContext } from '../../context.js'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import { query } from '../../query.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import { getDumpPromptsPath } from '../../services/api/dumpPrompts.js'
import { cleanupAgentTracking } from '../../services/api/promptCacheBreakDetection.js'
import {
  connectToServer,
  fetchToolsForClient,
} from '../../services/mcp/client.js'
import { getMcpConfigByName } from '../../services/mcp/config.js'
import type {
  MCPServerConnection,
  ScopedMcpServerConfig,
} from '../../services/mcp/types.js'
import type { Tool, Tools, ToolUseContext } from '../../Tool.js'
import { killShellTasksForAgent } from '../../tasks/LocalShellTask/killShellTasks.js'
import type { Command } from '../../types/command.js'
import type { AgentId } from '../../types/ids.js'
import type {
  AssistantMessage,
  Message,
  ProgressMessage,
  RequestStartEvent,
  StreamEvent,
  SystemCompactBoundaryMessage,
  TombstoneMessage,
  ToolUseSummaryMessage,
  UserMessage,
} from '../../types/message.js'
import { createAttachmentMessage } from '../../utils/attachments.js'
import { AbortError } from '../../utils/errors.js'
import { getDisplayPath } from '../../utils/file.js'
import {
  cloneFileStateCache,
  createFileStateCacheWithSizeLimit,
  READ_FILE_STATE_CACHE_SIZE,
} from '../../utils/fileStateCache.js'
import {
  type CacheSafeParams,
  createSubagentContext,
} from '../../utils/forkedAgent.js'
import { registerFrontmatterHooks } from '../../utils/hooks/registerFrontmatterHooks.js'
import { clearSessionHooks } from '../../utils/hooks/sessionHooks.js'
import { executeSubagentStartHooks } from '../../utils/hooks.js'
import { createUserMessage } from '../../utils/messages.js'
import { getAgentModel } from '../../utils/model/agent.js'
import type { ModelAlias } from '../../utils/model/aliases.js'
import {
  clearAgentTranscriptSubdir,
  recordSidechainTranscript,
  setAgentTranscriptSubdir,
  writeAgentMetadata,
} from '../../utils/sessionStorage.js'
import {
  isRestrictedToPluginOnly,
  isSourceAdminTrusted,
} from '../../utils/settings/pluginOnlyPolicy.js'
import {
  asSystemPrompt,
  type SystemPrompt,
} from '../../utils/systemPromptType.js'
import {
  isPerfettoTracingEnabled,
  registerAgent as registerPerfettoAgent,
  unregisterAgent as unregisterPerfettoAgent,
} from '../../utils/telemetry/perfettoTracing.js'
import type { ContentReplacementState } from '../../utils/toolResultStorage.js'
import { createAgentId } from '../../utils/uuid.js'
import { resolveAgentTools } from './agentToolUtils.js'
import { type AgentDefinition, isBuiltInAgent } from './loadAgentsDir.js'

/**
 * 初始化 Agent 专属 MCP 服务器。
 *
 * Agent 可在 frontmatter 中定义额外的 MCP 服务器，这些服务器叠加到父 Agent 的连接之上。
 * 仅在 Agent 生命周期内有效，结束时通过返回的 cleanup 函数清理。
 *
 * 策略说明：
 * - 字符串 spec：通过名称引用已有 MCP 配置（使用 memoized connectToServer，可能共享连接）
 * - 内联对象 spec：创建新连接（scope: 'dynamic'），生命周期归属当前 Agent，结束时需清理
 * - plugin-only 策略：仅允许管理员信任来源（built-in/plugin/policySettings）使用 frontmatter MCP；
 *   用户定义 Agent 的 frontmatter MCP 在 plugin-only 模式下会被跳过
 *
 * @param agentDefinition 包含可选 mcpServers 配置的 Agent 定义
 * @param parentClients 父上下文继承的 MCP 客户端列表
 * @returns 合并后的客户端列表、Agent 专属 MCP 工具列表及清理函数
 */
async function initializeAgentMcpServers(
  agentDefinition: AgentDefinition,
  parentClients: MCPServerConnection[],
): Promise<{
  clients: MCPServerConnection[]
  tools: Tools
  cleanup: () => Promise<void>
}> {
  // 若 Agent 未定义专属 MCP 服务器，直接复用父 Agent 客户端，无需清理
  if (!agentDefinition.mcpServers?.length) {
    return {
      clients: parentClients,
      tools: [],
      cleanup: async () => {},
    }
  }

  // plugin-only 模式下，跳过用户定义 Agent 的 frontmatter MCP（非管理员信任来源）。
  // 插件/内置/policySettings Agent 属于管理员信任来源，其 frontmatter MCP 仍正常加载。
  // 这与"插件提供的内容始终加载"的设计原则一致，不能一刀切阻断所有 Agent。
  const agentIsAdminTrusted = isSourceAdminTrusted(agentDefinition.source)
  if (isRestrictedToPluginOnly('mcp') && !agentIsAdminTrusted) {
    logForDebugging(
      `[Agent: ${agentDefinition.agentType}] Skipping MCP servers: strictPluginOnlyCustomization locks MCP to plugin-only (agent source: ${agentDefinition.source})`,
    )
    return {
      clients: parentClients,
      tools: [],
      cleanup: async () => {},
    }
  }

  const agentClients: MCPServerConnection[] = []
  // 仅追踪内联新建的连接（inline spec），不追踪引用已有配置的连接（string spec）。
  // 清理时只清理新建连接，共享连接由父 Agent 或 memoize 层管理。
  const newlyCreatedClients: MCPServerConnection[] = []
  const agentTools: Tool[] = []

  for (const spec of agentDefinition.mcpServers) {
    let config: ScopedMcpServerConfig | null = null
    let name: string
    let isNewlyCreated = false

    if (typeof spec === 'string') {
      // 字符串引用：按名称查找已有 MCP 配置（使用 memoized connectToServer，可能共享连接）
      name = spec
      config = getMcpConfigByName(spec)
      if (!config) {
        logForDebugging(
          `[Agent: ${agentDefinition.agentType}] MCP server not found: ${spec}`,
          { level: 'warn' },
        )
        continue
      }
    } else {
      // 内联定义：格式为 { [serverName]: serverConfig }，Agent 专属，需要在结束时清理
      const entries = Object.entries(spec)
      if (entries.length !== 1) {
        logForDebugging(
          `[Agent: ${agentDefinition.agentType}] Invalid MCP server spec: expected exactly one key`,
          { level: 'warn' },
        )
        continue
      }
      const [serverName, serverConfig] = entries[0]!
      name = serverName
      // 内联定义注入 scope: 'dynamic'，标识为动态创建的连接
      config = {
        ...serverConfig,
        scope: 'dynamic' as const,
      } as ScopedMcpServerConfig
      isNewlyCreated = true  // 标记为新建，cleanup 时需要销毁
    }

    // 连接到 MCP 服务器
    const client = await connectToServer(name, config)
    agentClients.push(client)
    if (isNewlyCreated) {
      newlyCreatedClients.push(client)  // 记录新建连接，供 cleanup 使用
    }

    // 若连接成功，获取该服务器提供的工具列表
    if (client.type === 'connected') {
      const tools = await fetchToolsForClient(client)
      agentTools.push(...tools)
      logForDebugging(
        `[Agent: ${agentDefinition.agentType}] Connected to MCP server '${name}' with ${tools.length} tools`,
      )
    } else {
      logForDebugging(
        `[Agent: ${agentDefinition.agentType}] Failed to connect to MCP server '${name}': ${client.type}`,
        { level: 'warn' },
      )
    }
  }

  // 构建清理函数：只关闭内联新建的连接，共享/引用连接不在此处清理
  const cleanup = async () => {
    for (const client of newlyCreatedClients) {
      if (client.type === 'connected') {
        try {
          await client.cleanup()
        } catch (error) {
          logForDebugging(
            `[Agent: ${agentDefinition.agentType}] Error cleaning up MCP server '${client.name}': ${error}`,
            { level: 'warn' },
          )
        }
      }
    }
  }

  // 返回合并后的客户端列表（父 + Agent 专属）、工具列表及清理函数
  return {
    clients: [...parentClients, ...agentClients],
    tools: agentTools,
    cleanup,
  }
}

// query() 返回的消息联合类型（包含流事件、请求事件、普通消息等）
type QueryMessage =
  | StreamEvent
  | RequestStartEvent
  | Message
  | ToolUseSummaryMessage
  | TombstoneMessage

/**
 * 类型守卫：判断 query() 返回的消息是否需要记录到 sidechain transcript。
 *
 * 需要记录的消息类型：
 * - 'assistant'：助手输出消息（含工具调用、thinking、文本）
 * - 'user'：用户输入消息（含工具结果、附件）
 * - 'progress'：进度更新消息
 * - 'system' 且 subtype === 'compact_boundary'：系统压缩边界消息
 */
function isRecordableMessage(
  msg: QueryMessage,
): msg is
  | AssistantMessage
  | UserMessage
  | ProgressMessage
  | SystemCompactBoundaryMessage {
  return (
    msg.type === 'assistant' ||
    msg.type === 'user' ||
    msg.type === 'progress' ||
    (msg.type === 'system' &&
      'subtype' in msg &&
      msg.subtype === 'compact_boundary')
  )
}

/**
 * Agent 核心执行异步生成器。
 *
 * 完整执行流程：
 * 1. 解析模型（getAgentModel）并创建 agentId
 * 2. 设置 transcript 子目录（transcriptSubdir）及 Perfetto 追踪注册
 * 3. 合并 forkContextMessages + promptMessages，构建 initialMessages
 * 4. 克隆或创建 readFileState（fork 路径克隆父状态，普通路径新建）
 * 5. 并发获取用户上下文和系统上下文
 * 6. omitClaudeMd 优化：只读 Agent（Explore/Plan）跳过 CLAUDE.md 节省 token
 * 7. omitGitStatus 优化：Explore/Plan 跳过 gitStatus（节省约 1-3 Gtok/week）
 * 8. 构建 agentGetAppState 闭包（权限模式覆盖、避免提示、等待自动检查、工具权限作用域、effort 覆盖）
 * 9. 解析工具池（useExactTools → 直接使用 / resolveAgentTools 过滤）
 * 10. 构建系统提示（override 优先 / getAgentSystemPrompt）
 * 11. 确定 AbortController（override → 异步新建 → 同步共享父）
 * 12. 执行 SubagentStart hooks，收集附加上下文并注入 initialMessages
 * 13. 注册 frontmatter hooks（plugin-only 策略门控）
 * 14. 预加载 frontmatter 中声明的 skills（resolveSkillName 三策略解析）
 * 15. 初始化 Agent 专属 MCP 服务器（叠加到父连接）
 * 16. 合并所有工具（resolvedTools + agentMcpTools，按 name 去重）
 * 17. 构建 agentOptions（isNonInteractiveSession / thinkingConfig / querySource 等）
 * 18. 创建 agentToolUseContext（createSubagentContext）
 * 19. 暴露 CacheSafeParams（供后台汇总使用）
 * 20. 记录初始消息 + 写入元数据（fire-and-forget）
 * 21. 查询循环：转发 TTFT 指标、yield 附件消息、记录并 yield 可记录消息
 * 22. finally 清理：mcpCleanup → clearSessionHooks → cleanupAgentTracking →
 *     readFileState.clear → initialMessages.length=0 → unregisterPerfettoAgent →
 *     clearAgentTranscriptSubdir → 清理 todos → killShellTasksForAgent →
 *     killMonitorMcpTasksForAgent（动态 require 避免循环依赖）
 */
export async function* runAgent({
  agentDefinition,
  promptMessages,
  toolUseContext,
  canUseTool,
  isAsync,
  canShowPermissionPrompts,
  forkContextMessages,
  querySource,
  override,
  model,
  maxTurns,
  preserveToolUseResults,
  availableTools,
  allowedTools,
  onCacheSafeParams,
  contentReplacementState,
  useExactTools,
  worktreePath,
  description,
  transcriptSubdir,
  onQueryProgress,
}: {
  agentDefinition: AgentDefinition
  promptMessages: Message[]
  toolUseContext: ToolUseContext
  canUseTool: CanUseToolFn
  isAsync: boolean
  /** Whether this agent can show permission prompts. Defaults to !isAsync.
   * Set to true for in-process teammates that run async but share the terminal. */
  canShowPermissionPrompts?: boolean
  forkContextMessages?: Message[]
  querySource: QuerySource
  override?: {
    userContext?: { [k: string]: string }
    systemContext?: { [k: string]: string }
    systemPrompt?: SystemPrompt
    abortController?: AbortController
    agentId?: AgentId
  }
  model?: ModelAlias
  maxTurns?: number
  /** Preserve toolUseResult on messages for subagents with viewable transcripts */
  preserveToolUseResults?: boolean
  /** Precomputed tool pool for the worker agent. Computed by the caller
   * (AgentTool.tsx) to avoid a circular dependency between runAgent and tools.ts.
   * Always contains the full tool pool assembled with the worker's own permission
   * mode, independent of the parent's tool restrictions. */
  availableTools: Tools
  /** Tool permission rules to add to the agent's session allow rules.
   * When provided, replaces ALL allow rules so the agent only has what's
   * explicitly listed (parent approvals don't leak through). */
  allowedTools?: string[]
  /** Optional callback invoked with CacheSafeParams after constructing the agent's
   * system prompt, context, and tools. Used by background summarization to fork
   * the agent's conversation for periodic progress summaries. */
  onCacheSafeParams?: (params: CacheSafeParams) => void
  /** Replacement state reconstructed from a resumed sidechain transcript so
   * the same tool results are re-replaced (prompt cache stability). When
   * omitted, createSubagentContext clones the parent's state. */
  contentReplacementState?: ContentReplacementState
  /** When true, use availableTools directly without filtering through
   * resolveAgentTools(). Also inherits the parent's thinkingConfig and
   * isNonInteractiveSession instead of overriding them. Used by the fork
   * subagent path to produce byte-identical API request prefixes for
   * prompt cache hits. */
  useExactTools?: boolean
  /** Worktree path if the agent was spawned with isolation: "worktree".
   * Persisted to metadata so resume can restore the correct cwd. */
  worktreePath?: string
  /** Original task description from AgentTool input. Persisted to metadata
   * so a resumed agent's notification can show the original description. */
  description?: string
  /** Optional subdirectory under subagents/ to group this agent's transcript
   * with related ones (e.g. workflows/<runId> for workflow subagents). */
  transcriptSubdir?: string
  /** Optional callback fired on every message yielded by query() — including
   * stream_event deltas that runAgent otherwise drops. Use to detect liveness
   * during long single-block streams (e.g. thinking) where no assistant
   * message is yielded for >60s. */
  onQueryProgress?: () => void
}): AsyncGenerator<Message, void> {
  // 追踪子 Agent 使用情况（用于功能发现统计）

  const appState = toolUseContext.getAppState()
  const permissionMode = appState.toolPermissionContext.mode
  // 始终使用根 AppState 存储的写入通道。
  // 当父 Agent 本身也是异步 Agent 时，toolUseContext.setAppState 是无操作；
  // 会话级写入（hooks、bash 任务）必须通过 setAppStateForTasks 或 setAppState 直达根存储。
  const rootSetAppState =
    toolUseContext.setAppStateForTasks ?? toolUseContext.setAppState

  // 解析 Agent 使用的模型（优先级：override.model → agentDefinition.model → mainLoopModel）
  const resolvedAgentModel = getAgentModel(
    agentDefinition.model,
    toolUseContext.options.mainLoopModel,
    model,
    permissionMode,
  )

  // 使用 override 中的 agentId（如恢复场景），或创建新的唯一 agentId
  const agentId = override?.agentId ? override.agentId : createAgentId()

  // 若指定了 transcript 子目录，设置该 Agent 的分组路径（如 workflow 子 Agent）
  if (transcriptSubdir) {
    setAgentTranscriptSubdir(agentId, transcriptSubdir)
  }

  // 在 Perfetto 追踪中注册该 Agent（用于 Agent 层级可视化）
  if (isPerfettoTracingEnabled()) {
    const parentId = toolUseContext.agentId ?? getSessionId()
    registerPerfettoAgent(agentId, agentDefinition.agentType, parentId)
  }

  // ant 内部环境：输出 API 调用日志路径（调试用）
  if (process.env.USER_TYPE === 'ant') {
    logForDebugging(
      `[Subagent ${agentDefinition.agentType}] API calls: ${getDisplayPath(getDumpPromptsPath(agentId))}`,
    )
  }

  // 处理 fork 上下文消息共享：
  // 过滤掉孤立的 tool_use（无对应 tool_result），避免 API 报错
  const contextMessages: Message[] = forkContextMessages
    ? filterIncompleteToolCalls(forkContextMessages)
    : []
  // 合并 fork 上下文消息和新的提示消息，构成完整的初始消息列表
  const initialMessages: Message[] = [...contextMessages, ...promptMessages]

  // fork 路径克隆父 Agent 文件状态缓存（保持一致性），普通路径创建新缓存
  const agentReadFileState =
    forkContextMessages !== undefined
      ? cloneFileStateCache(toolUseContext.readFileState)
      : createFileStateCacheWithSizeLimit(READ_FILE_STATE_CACHE_SIZE)

  // 并发获取用户上下文和系统上下文，提升启动速度
  const [baseUserContext, baseSystemContext] = await Promise.all([
    override?.userContext ?? getUserContext(),
    override?.systemContext ?? getSystemContext(),
  ])

  // omitClaudeMd 优化：只读 Agent（Explore、Plan）不需要 CLAUDE.md 中的提交/PR/lint 规则——
  // 主 Agent 拥有完整上下文并负责解读其输出结果。
  // 跳过 claudeMd 可节省约 5-15 Gtok/week（约 3400 万次 Explore 调用）。
  // 显式传入的 override.userContext 保持原样不受影响。
  // 此优化默认开启（tengu_slim_subagent_claudemd=true），可通过 GrowthBook 回滚。
  const shouldOmitClaudeMd =
    agentDefinition.omitClaudeMd &&
    !override?.userContext &&
    getFeatureValue_CACHED_MAY_BE_STALE('tengu_slim_subagent_claudemd', true)
  const { claudeMd: _omittedClaudeMd, ...userContextNoClaudeMd } =
    baseUserContext
  const resolvedUserContext = shouldOmitClaudeMd
    ? userContextNoClaudeMd   // 去除 claudeMd 字段的精简上下文
    : baseUserContext          // 保留完整上下文

  // omitGitStatus 优化：Explore/Plan 是只读搜索 Agent，
  // 会话开始时记录的 gitStatus（最多 40KB，且已标注为"过时"）对它们毫无价值。
  // 若需要 git 信息，它们会自行运行 `git status` 获取新鲜数据。
  // 节省约 1-3 Gtok/week（全量）。
  const { gitStatus: _omittedGitStatus, ...systemContextNoGit } =
    baseSystemContext
  const resolvedSystemContext =
    agentDefinition.agentType === 'Explore' ||
    agentDefinition.agentType === 'Plan'
      ? systemContextNoGit     // Explore/Plan：去除 gitStatus 的精简系统上下文
      : baseSystemContext      // 其他 Agent：使用完整系统上下文

  // Agent 权限模式（来自 agentDefinition.permissionMode）
  const agentPermissionMode = agentDefinition.permissionMode
  // agentGetAppState 闭包：每次调用时动态计算该 Agent 的 AppState 视图，
  // 支持权限模式覆盖、权限提示避免、工具权限作用域、effort 覆盖等
  const agentGetAppState = () => {
    const state = toolUseContext.getAppState()
    let toolPermissionContext = state.toolPermissionContext

    // 覆盖权限模式（除非父 Agent 是 bypassPermissions、acceptEdits 或 auto+TRANSCRIPT_CLASSIFIER）。
    // 这些优先级更高的模式不允许被子 Agent 降级。
    if (
      agentPermissionMode &&
      state.toolPermissionContext.mode !== 'bypassPermissions' &&
      state.toolPermissionContext.mode !== 'acceptEdits' &&
      !(
        feature('TRANSCRIPT_CLASSIFIER') &&
        state.toolPermissionContext.mode === 'auto'
      )
    ) {
      toolPermissionContext = {
        ...toolPermissionContext,
        mode: agentPermissionMode,
      }
    }

    // 为无法显示 UI 的 Agent 设置自动拒绝权限提示标志。
    // 判断逻辑：
    // - 显式传入 canShowPermissionPrompts 时直接使用其取反
    // - bubble 模式：始终允许显示（提示会冒泡到父 Agent 终端）
    // - 默认：异步 Agent 不显示提示，同步 Agent 显示
    const shouldAvoidPrompts =
      canShowPermissionPrompts !== undefined
        ? !canShowPermissionPrompts
        : agentPermissionMode === 'bubble'
          ? false
          : isAsync
    if (shouldAvoidPrompts) {
      toolPermissionContext = {
        ...toolPermissionContext,
        shouldAvoidPermissionPrompts: true,
      }
    }

    // 后台 Agent 可显示提示时，先等待自动检查（分类器、permission hooks）再弹窗。
    // 仅在真正无法自动解决权限时才打扰用户。适用于 bubble 模式和显式 canShowPermissionPrompts。
    if (isAsync && !shouldAvoidPrompts) {
      toolPermissionContext = {
        ...toolPermissionContext,
        awaitAutomatedChecksBeforeDialog: true,
      }
    }

    // 工具权限作用域：若提供了 allowedTools，用它替换会话级别的允许规则。
    // 重要：保留 cliArg 规则（来自 SDK --allowedTools），这些是 SDK 消费者的显式权限，
    // 应对所有子 Agent 生效。仅清除父 Agent 的会话级规则，防止意外泄露。
    if (allowedTools !== undefined) {
      toolPermissionContext = {
        ...toolPermissionContext,
        alwaysAllowRules: {
          // 保留 SDK 级别的 --allowedTools 权限
          cliArg: state.toolPermissionContext.alwaysAllowRules.cliArg,
          // 使用传入的 allowedTools 作为当前 Agent 的会话级权限
          session: [...allowedTools],
        },
      }
    }

    // effort 覆盖：若 Agent 定义了 effort 级别，使用其值；否则沿用父 Agent 的 effort
    const effortValue =
      agentDefinition.effort !== undefined
        ? agentDefinition.effort
        : state.effortValue

    // 若权限上下文和 effort 都未改变，直接返回原 state（避免不必要的重新渲染）
    if (
      toolPermissionContext === state.toolPermissionContext &&
      effortValue === state.effortValue
    ) {
      return state
    }
    return {
      ...state,
      toolPermissionContext,
      effortValue,
    }
  }

  // 解析工具池：
  // - useExactTools（fork 路径）：直接使用 availableTools，保证 API 请求前缀字节相同
  // - 普通路径：通过 resolveAgentTools 过滤（根据 Agent 的 tools/disallowedTools 定义）
  const resolvedTools = useExactTools
    ? availableTools
    : resolveAgentTools(agentDefinition, availableTools, isAsync).resolvedTools

  // 获取额外工作目录列表（用于系统提示中的工具能力描述）
  const additionalWorkingDirectories = Array.from(
    appState.toolPermissionContext.additionalWorkingDirectories.keys(),
  )

  // 构建 Agent 系统提示：
  // - override.systemPrompt 优先（fork 恢复时传入已渲染字节，保证缓存精确一致）
  // - 否则通过 getAgentSystemPrompt 动态构建（注入环境细节）
  const agentSystemPrompt = override?.systemPrompt
    ? override.systemPrompt
    : asSystemPrompt(
        await getAgentSystemPrompt(
          agentDefinition,
          toolUseContext,
          resolvedAgentModel,
          additionalWorkingDirectories,
          resolvedTools,
        ),
      )

  // 确定 AbortController：
  // - override.abortController：外部传入（如任务注册中心的控制器）
  // - 异步 Agent：创建独立的新控制器（与父 Agent 解耦，独立运行）
  // - 同步 Agent：共享父 Agent 的控制器（父取消时子也取消）
  const agentAbortController = override?.abortController
    ? override.abortController
    : isAsync
      ? new AbortController()
      : toolUseContext.abortController

  // 执行 SubagentStart hooks，收集附加上下文字符串
  const additionalContexts: string[] = []
  for await (const hookResult of executeSubagentStartHooks(
    agentId,
    agentDefinition.agentType,
    agentAbortController.signal,
  )) {
    if (
      hookResult.additionalContexts &&
      hookResult.additionalContexts.length > 0
    ) {
      additionalContexts.push(...hookResult.additionalContexts)
    }
  }

  // 将 SubagentStart hook 提供的附加上下文注入为用户消息（与 SessionStart/UserPromptSubmit 保持一致）
  if (additionalContexts.length > 0) {
    const contextMessage = createAttachmentMessage({
      type: 'hook_additional_context',
      content: additionalContexts,
      hookName: 'SubagentStart',
      toolUseID: randomUUID(),
      hookEvent: 'SubagentStart',
    })
    initialMessages.push(contextMessage)
  }

  // 注册 Agent frontmatter 中声明的 hooks（限 Agent 生命周期内有效）。
  // isAgent=true：将 Stop hooks 转换为 SubagentStop（子 Agent 触发 SubagentStop 而非 Stop）。
  // plugin-only 策略门控：仅管理员信任来源的 Agent 可注册 frontmatter hooks；
  // 用户定义 Agent 的 hooks 在 plugin-only 模式下会被阻断（在此处门控，而非在执行时统一阻断）。
  const hooksAllowedForThisAgent =
    !isRestrictedToPluginOnly('hooks') ||
    isSourceAdminTrusted(agentDefinition.source)
  if (agentDefinition.hooks && hooksAllowedForThisAgent) {
    registerFrontmatterHooks(
      rootSetAppState,
      agentId,
      agentDefinition.hooks,
      `agent '${agentDefinition.agentType}'`,
      true, // isAgent - 将 Stop 转换为 SubagentStop
    )
  }

  // 预加载 Agent frontmatter 中声明的 skills
  const skillsToPreload = agentDefinition.skills ?? []
  if (skillsToPreload.length > 0) {
    const allSkills = await getSkillToolCommands(getProjectRoot())

    // 过滤有效 skills，记录找不到的 skills 的警告
    const validSkills: Array<{
      skillName: string
      skill: (typeof allSkills)[0] & { type: 'prompt' }
    }> = []

    for (const skillName of skillsToPreload) {
      // 三策略解析技能名称：
      // 1. 精确匹配（hasCommand 检查 name/userFacingName/aliases）
      // 2. 加上 Agent 的插件前缀（如 "my-skill" → "plugin:my-skill"）
      // 3. 后缀匹配（查找 name 以 ":skillName" 结尾的命令）
      const resolvedName = resolveSkillName(
        skillName,
        allSkills,
        agentDefinition,
      )
      if (!resolvedName) {
        logForDebugging(
          `[Agent: ${agentDefinition.agentType}] Warning: Skill '${skillName}' specified in frontmatter was not found`,
          { level: 'warn' },
        )
        continue
      }

      const skill = getCommand(resolvedName, allSkills)
      if (skill.type !== 'prompt') {
        // 仅支持 prompt 类型的 skill（不支持 action 类型）
        logForDebugging(
          `[Agent: ${agentDefinition.agentType}] Warning: Skill '${skillName}' is not a prompt-based skill`,
          { level: 'warn' },
        )
        continue
      }
      validSkills.push({ skillName, skill })
    }

    // 并发加载所有有效 skill 的内容，提升启动速度
    const { formatSkillLoadingMetadata } = await import(
      '../../utils/processUserInput/processSlashCommand.js'
    )
    const loaded = await Promise.all(
      validSkills.map(async ({ skillName, skill }) => ({
        skillName,
        skill,
        content: await skill.getPromptForCommand('', toolUseContext),
      })),
    )
    for (const { skillName, skill, content } of loaded) {
      logForDebugging(
        `[Agent: ${agentDefinition.agentType}] Preloaded skill '${skillName}'`,
      )

      // 添加技能加载元数据（UI 显示正在加载哪个技能）
      const metadata = formatSkillLoadingMetadata(
        skillName,
        skill.progressMessage,
      )

      // 将技能内容作为用户消息注入 initialMessages
      initialMessages.push(
        createUserMessage({
          content: [{ type: 'text', text: metadata }, ...content],
          isMeta: true,
        }),
      )
    }
  }

  // 初始化 Agent 专属 MCP 服务器（叠加到父 Agent 的 MCP 连接）
  const {
    clients: mergedMcpClients,
    tools: agentMcpTools,
    cleanup: mcpCleanup,
  } = await initializeAgentMcpServers(
    agentDefinition,
    toolUseContext.options.mcpClients,
  )

  // 合并 Agent MCP 工具与已解析工具，按 name 去重。
  // resolvedTools 内部已去重，无 Agent 专属 MCP 工具时跳过 uniqBy 开销。
  const allTools =
    agentMcpTools.length > 0
      ? uniqBy([...resolvedTools, ...agentMcpTools], 'name')
      : resolvedTools

  // 构建 Agent 专属 options（覆盖部分父 Agent 选项）
  const agentOptions: ToolUseContext['options'] = {
    // isNonInteractiveSession：
    // - useExactTools（fork）：继承父 Agent 设置（保持 API 前缀一致）
    // - 异步 Agent：强制为 true（后台无交互界面）
    // - 同步 Agent：继承父 Agent 设置
    isNonInteractiveSession: useExactTools
      ? toolUseContext.options.isNonInteractiveSession
      : isAsync
        ? true
        : (toolUseContext.options.isNonInteractiveSession ?? false),
    appendSystemPrompt: toolUseContext.options.appendSystemPrompt,
    tools: allTools,
    commands: [],
    debug: toolUseContext.options.debug,
    verbose: toolUseContext.options.verbose,
    mainLoopModel: resolvedAgentModel,
    // thinkingConfig：
    // - fork 子 Agent（useExactTools）：继承父 Agent 配置（保证 API 前缀字节一致，缓存命中）
    // - 普通子 Agent：禁用 thinking（控制输出 token 成本）
    thinkingConfig: useExactTools
      ? toolUseContext.options.thinkingConfig
      : { type: 'disabled' as const },
    mcpClients: mergedMcpClients,
    mcpResources: toolUseContext.options.mcpResources,
    agentDefinitions: toolUseContext.options.agentDefinitions,
    // fork 子 Agent 需要在 options.querySource 中记录 querySource，
    // 供 AgentTool.tsx 的递归 fork 守卫检查（检查 options.querySource === 'agent:builtin:fork'）。
    // 这在 autocompact 后依然有效（autocompact 只重写消息，不修改 context.options）。
    ...(useExactTools && { querySource }),
  }

  // 创建子 Agent 上下文（通过 createSubagentContext 共享辅助函数）：
  // - 同步 Agent：共享父 Agent 的 setAppState（会话级状态写入同步到父）
  // - 异步 Agent：完全隔离（但使用显式独立的 abortController）
  const agentToolUseContext = createSubagentContext(toolUseContext, {
    options: agentOptions,
    agentId,
    agentType: agentDefinition.agentType,
    messages: initialMessages,
    readFileState: agentReadFileState,
    abortController: agentAbortController,
    getAppState: agentGetAppState,
    // 同步 Agent 共享父 Agent 的 setAppState
    shareSetAppState: !isAsync,
    // 同步/异步 Agent 都贡献响应长度指标
    shareSetResponseLength: true,
    criticalSystemReminder_EXPERIMENTAL:
      agentDefinition.criticalSystemReminder_EXPERIMENTAL,
    contentReplacementState,
  })

  // 为具有可查看 transcript 的子 Agent（in-process teammates）保留工具结果
  if (preserveToolUseResults) {
    agentToolUseContext.preserveToolUseResults = true
  }

  // 暴露 CacheSafeParams（供后台进度汇总 fork Agent 使用，共享提示缓存前缀）
  if (onCacheSafeParams) {
    onCacheSafeParams({
      systemPrompt: agentSystemPrompt,
      userContext: resolvedUserContext,
      systemContext: resolvedSystemContext,
      toolUseContext: agentToolUseContext,
      forkContextMessages: initialMessages,
    })
  }

  // 记录初始消息到 sidechain transcript，同时写入 agentType 元数据（供恢复路由使用）。
  // 两者均为 fire-and-forget——持久化失败不应阻塞 Agent 执行。
  void recordSidechainTranscript(initialMessages, agentId).catch(_err =>
    logForDebugging(`Failed to record sidechain transcript: ${_err}`),
  )
  void writeAgentMetadata(agentId, {
    agentType: agentDefinition.agentType,
    ...(worktreePath && { worktreePath }),  // 可选：worktree 路径（用于恢复时还原工作目录）
    ...(description && { description }),    // 可选：任务描述（用于恢复时显示通知）
  }).catch(_err => logForDebugging(`Failed to write agent metadata: ${_err}`))

  // 追踪最后记录消息的 UUID（用于增量追加 sidechain transcript 时维护父链）
  let lastRecordedUuid: UUID | null = initialMessages.at(-1)?.uuid ?? null

  try {
    // 主查询循环：迭代 query() 生成器，处理每条返回消息
    for await (const message of query({
      messages: initialMessages,
      systemPrompt: agentSystemPrompt,
      userContext: resolvedUserContext,
      systemContext: resolvedSystemContext,
      canUseTool,
      toolUseContext: agentToolUseContext,
      querySource,
      maxTurns: maxTurns ?? agentDefinition.maxTurns,
    })) {
      onQueryProgress?.()  // 通知调用方有新消息（用于活性检测）

      // 转发子 Agent API 请求开始事件到父 Agent 的指标展示，
      // 使 TTFT/OTPS 在子 Agent 执行期间实时更新（而非等待子 Agent 完成）
      if (
        message.type === 'stream_event' &&
        message.event.type === 'message_start' &&
        message.ttftMs != null
      ) {
        toolUseContext.pushApiMetricsEntry?.(message.ttftMs)
        continue  // 不向上游 yield 流式事件
      }

      // yield 附件消息（如 structured_output），但不记录到 transcript
      if (message.type === 'attachment') {
        // 处理达到最大轮次的信号（来自 query.ts）
        if (message.attachment.type === 'max_turns_reached') {
          logForDebugging(
            `[Agent
: $
{
  agentDefinition.agentType
}
] Reached max turns limit ($
{
  message.attachment.maxTurns
}
)`,
          )
          break  // 达到最大轮次，退出查询循环
        }
        yield message  // 向调用方传递附件消息
        continue
      }

      if (isRecordableMessage(message)) {
        // 增量记录新消息到 sidechain transcript（O(1) per message，避免全量重写）
        await recordSidechainTranscript(
          [message],
          agentId,
          lastRecordedUuid,
        ).catch(err =>
          logForDebugging(`Failed to record sidechain transcript: ${err}`),
        )
        if (message.type !== 'progress') {
          // 进度消息不更新 lastRecordedUuid（不作为 transcript 中的消息节点）
          lastRecordedUuid = message.uuid
        }
        yield message  // 向调用方传递可记录消息
      }
    }

    // 查询循环结束后检查是否因中止信号退出
    if (agentAbortController.signal.aborted) {
      throw new AbortError()
    }

    // 执行 Agent 完成回调（仅内置 Agent 有 callback）
    if (isBuiltInAgent(agentDefinition) && agentDefinition.callback) {
      agentDefinition.callback()
    }
  } finally {
    // ===== 资源清理（无论正常完成、中止还是报错都会执行）=====

    // 清理 Agent 专属 MCP 服务器连接（仅关闭内联新建的连接）
    await mcpCleanup()
    // 清理 Agent 注册的 session hooks（防止游离 hooks 影响后续会话）
    if (agentDefinition.hooks) {
      clearSessionHooks(rootSetAppState, agentId)
    }
    // 清理提示缓存中断检测追踪状态（feature gate 保护）
    if (feature('PROMPT_CACHE_BREAK_DETECTION')) {
      cleanupAgentTracking(agentId)
    }
    // 释放克隆的文件状态缓存内存
    agentToolUseContext.readFileState.clear()
    // 释放克隆的 fork 上下文消息内存（鲸鱼会话可能有数百个子 Agent，需及时释放）
    initialMessages.length = 0
    // 从 Perfetto 追踪注册表中移除该 Agent
    unregisterPerfettoAgent(agentId)
    // 清除 transcript 子目录映射
    clearAgentTranscriptSubdir(agentId)
    // 清理该 Agent 的 todos 条目。
    // 不清理会导致每个调用过 TodoWrite 的子 Agent 在 AppState.todos 中留下永久键，
    // 鲸鱼会话产生数百个子 Agent 时这些空键会累积成可观的内存泄漏。
    rootSetAppState(prev => {
      if (!(agentId in prev.todos)) return prev
      const { [agentId]: _removed, ...todos } = prev.todos
      return { ...prev, todos }
    })
    // 终止该 Agent 产生的后台 shell 任务。
    // 不清理会导致 run_in_background 的 shell 循环在主会话退出后以 PPID=1 僵尸进程存活。
    killShellTasksForAgent(agentId, toolUseContext.getAppState, rootSetAppState)
    /* eslint-disable @typescript-eslint/no-require-imports */
    if (feature('MONITOR_TOOL')) {
      // 使用动态 require() 避免循环依赖（MonitorMcpTask → AgentTool → runAgent 的循环链）
      // 模块加载时无法静态导入，必须在运行时动态引入
      const mcpMod =
        require('../../tasks/MonitorMcpTask/MonitorMcpTask.js') as typeof import('../../tasks/MonitorMcpTask/MonitorMcpTask.js')
      mcpMod.killMonitorMcpTasksForAgent(
        agentId,
        toolUseContext.getAppState,
        rootSetAppState,
      )
    }
    /* eslint-enable @typescript-eslint/no-require-imports */
  }
}

/**
 * 过滤携带孤立 tool_use 块的助手消息。
 *
 * 向 API 发送含有无对应 tool_result 的 tool_use 块会触发报错。
 * 该函数通过以下两步过滤避免此类问题：
 * 1. 遍历所有用户消息，收集所有 tool_result 对应的 tool_use_id 集合
 * 2. 过滤掉含有未匹配 tool_use_id 的助手消息（孤立 tool_use）
 *
 * 非助手消息和不含 tool_use 的助手消息保持不变。
 */
export function filterIncompleteToolCalls(messages: Message[]): Message[] {
  // 第一步：收集所有有对应结果的 tool_use_id
  const toolUseIdsWithResults = new Set<string>()

  for (const message of messages) {
    if (message?.type === 'user') {
      const userMessage = message as UserMessage
      const content = userMessage.message.content
      if (Array.isArray(content)) {
        for (const block of content) {
          // 只收集有 tool_use_id 的 tool_result 块
          if (block.type === 'tool_result' && block.tool_use_id) {
            toolUseIdsWithResults.add(block.tool_use_id)
          }
        }
      }
    }
  }

  // 第二步：过滤掉含孤立 tool_use 的助手消息
  return messages.filter(message => {
    if (message?.type === 'assistant') {
      const assistantMessage = message as AssistantMessage
      const content = assistantMessage.message.content
      if (Array.isArray(content)) {
        // 检查是否有任何 tool_use 块找不到对应的 tool_result
        const hasIncompleteToolCall = content.some(
          block =>
            block.type === 'tool_use' &&
            block.id &&
            !toolUseIdsWithResults.has(block.id),
        )
        // 有孤立 tool_use 则过滤掉该消息
        return !hasIncompleteToolCall
      }
    }
    // 非助手消息及不含 tool_use 的助手消息均保留
    return true
  })
}

/**
 * 构建并增强 Agent 系统提示。
 *
 * 执行流程：
 * 1. 调用 agentDefinition.getSystemPrompt({ toolUseContext }) 获取 Agent 自定义系统提示
 * 2. 通过 enhanceSystemPromptWithEnvDetails 注入环境细节（模型信息、工作目录、工具能力等）
 * 3. 若 getSystemPrompt 抛出异常，降级到 DEFAULT_AGENT_PROMPT 并重新增强
 *
 * @param agentDefinition Agent 定义（含 getSystemPrompt 方法）
 * @param toolUseContext 工具使用上下文（供 getSystemPrompt 使用）
 * @param resolvedAgentModel 已解析的 Agent 模型标识符
 * @param additionalWorkingDirectories 额外工作目录列表
 * @param resolvedTools 已解析的工具池（用于构建工具能力说明）
 * @returns 增强后的系统提示字符串数组
 */
async function getAgentSystemPrompt(
  agentDefinition: AgentDefinition,
  toolUseContext: Pick<ToolUseContext, 'options'>,
  resolvedAgentModel: string,
  additionalWorkingDirectories: string[],
  resolvedTools: readonly Tool[],
): Promise<string[]> {
  // 构建已启用工具名称集合（用于环境细节注入）
  const enabledToolNames = new Set(resolvedTools.map(t => t.name))
  try {
    // 调用 Agent 定义的系统提示生成函数
    const agentPrompt = agentDefinition.getSystemPrompt({ toolUseContext })
    const prompts = [agentPrompt]

    // 注入环境细节（模型信息、目录结构、工具列表等）
    return await enhanceSystemPromptWithEnvDetails(
      prompts,
      resolvedAgentModel,
      additionalWorkingDirectories,
      enabledToolNames,
    )
  } catch (_error) {
    // getSystemPrompt 失败时降级到默认 Agent 提示（避免 Agent 无系统提示运行）
    return enhanceSystemPromptWithEnvDetails(
      [DEFAULT_AGENT_PROMPT],
      resolvedAgentModel,
      additionalWorkingDirectories,
      enabledToolNames,
    )
  }
}

/**
 * 将 Agent frontmatter 中声明的技能名称解析为已注册的命令名称。
 *
 * 插件技能以命名空间格式注册（如 "my-plugin:my-skill"），但 Agent 引用时使用裸名称（如 "my-skill"）。
 * 三策略解析优先级（从高到低）：
 * 1. 精确匹配：通过 hasCommand 检查 name/userFacingName/aliases
 * 2. 插件前缀补全：提取 Agent 类型中的插件名（agentType.split(':')[0]），构造完全限定名
 * 3. 后缀匹配：查找 name 以 ":skillName" 结尾的任意命令
 *
 * @param skillName frontmatter 中声明的技能名称（可能是裸名或完全限定名）
 * @param allSkills 所有可用技能命令列表
 * @param agentDefinition Agent 定义（用于提取插件前缀）
 * @returns 解析后的完全限定命令名称，未找到返回 null
 */
function resolveSkillName(
  skillName: string,
  allSkills: Command[],
  agentDefinition: AgentDefinition,
): string | null {
  // 策略一：精确匹配（检查 name/userFacingName/aliases）
  if (hasCommand(skillName, allSkills)) {
    return skillName
  }

  // 策略二：加上 Agent 的插件前缀构造完全限定名
  // 插件 Agent 的 agentType 格式为 "pluginName:agentName"，取冒号前的部分作为插件前缀
  const pluginPrefix = agentDefinition.agentType.split(':')[0]
  if (pluginPrefix) {
    const qualifiedName = `${pluginPrefix}:${skillName}`
    if (hasCommand(qualifiedName, allSkills)) {
      return qualifiedName
    }
  }

  // 策略三：后缀匹配——查找任意 name 以 ":skillName" 结尾的命令
  const suffix = `:${skillName}`
  const match = allSkills.find(cmd => cmd.name.endsWith(suffix))
  if (match) {
    return match.name
  }

  // 三种策略均未匹配，返回 null
  return null
}
