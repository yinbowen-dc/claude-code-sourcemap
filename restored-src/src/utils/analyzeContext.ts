/**
 * 上下文窗口用量分析模块。
 *
 * 在 Claude Code 系统中，该模块负责统计并可视化当前对话消耗的上下文 token 分布，
 * 为用户提供"/context"命令所展示的上下文占用概览。
 *
 * 主要职责：
 * 1. 并发调用多个计数函数（系统提示词、内存文件、内置工具、MCP 工具、
 *    自定义 Agent、斜杠命令、消息历史），汇总各类别的 token 数量
 * 2. 根据模型上下文窗口大小生成可视化网格（GridSquare[][]），
 *    支持窄屏（< 80 列）和宽屏两种布局
 * 3. 区分"延迟加载"工具（如 Tool Search 启用后的 MCP 工具）与常驻工具，
 *    分别计入实际用量或展示为"deferred"
 * 4. 对 autocompact/manual compact 缓冲区保留 token 进行可视化
 * 5. 导出 ContextData 数据结构供 UI 层渲染
 *
 * 关键常量：
 * - TOOL_TOKEN_COUNT_OVERHEAD：API 每次计数调用附加的工具序言开销（约 500 token）
 * - RESERVED_CATEGORY_NAME / MANUAL_COMPACT_BUFFER_NAME：缓冲区类别名称
 */
import { feature } from 'bun:bundle'
import type { Anthropic } from '@anthropic-ai/sdk'
import {
  getSystemPrompt,
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
} from 'src/constants/prompts.js'
import { microcompactMessages } from 'src/services/compact/microCompact.js'
import { getSdkBetas } from '../bootstrap/state.js'
import { getCommandName } from '../commands.js'
import { getSystemContext } from '../context.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js'
import {
  AUTOCOMPACT_BUFFER_TOKENS,
  getEffectiveContextWindowSize,
  isAutoCompactEnabled,
  MANUAL_COMPACT_BUFFER_TOKENS,
} from '../services/compact/autoCompact.js'
import {
  countMessagesTokensWithAPI,
  countTokensViaHaikuFallback,
  roughTokenCountEstimation,
} from '../services/tokenEstimation.js'
import { estimateSkillFrontmatterTokens } from '../skills/loadSkillsDir.js'
import {
  findToolByName,
  type Tool,
  type ToolPermissionContext,
  type Tools,
  type ToolUseContext,
  toolMatchesName,
} from '../Tool.js'
import type {
  AgentDefinition,
  AgentDefinitionsResult,
} from '../tools/AgentTool/loadAgentsDir.js'
import { SKILL_TOOL_NAME } from '../tools/SkillTool/constants.js'
import {
  getLimitedSkillToolCommands,
  getSkillToolInfo as getSlashCommandInfo,
} from '../tools/SkillTool/prompt.js'
import type {
  AssistantMessage,
  AttachmentMessage,
  Message,
  NormalizedAssistantMessage,
  NormalizedUserMessage,
  UserMessage,
} from '../types/message.js'
import { toolToAPISchema } from './api.js'
import { filterInjectedMemoryFiles, getMemoryFiles } from './claudemd.js'
import { getContextWindowForModel } from './context.js'
import { getCwd } from './cwd.js'
import { logForDebugging } from './debug.js'
import { isEnvTruthy } from './envUtils.js'
import { errorMessage, toError } from './errors.js'
import { logError } from './log.js'
import { normalizeMessagesForAPI } from './messages.js'
import { getRuntimeMainLoopModel } from './model/model.js'
import type { SettingSource } from './settings/constants.js'
import { jsonStringify } from './slowOperations.js'
import { buildEffectiveSystemPrompt } from './systemPrompt.js'
import type { Theme } from './theme.js'
import { getCurrentUsage } from './tokens.js'

const RESERVED_CATEGORY_NAME = 'Autocompact buffer'
const MANUAL_COMPACT_BUFFER_NAME = 'Compact buffer'

/**
 * API 计数调用时工具序言附加的固定 token 开销（约 500 token）。
 * 单独对每个工具调用计数时，每次调用都会包含一次序言开销，
 * 导致 N 个工具的累加结果比实际多出 (N-1) × overhead。
 * 减去此开销后可得到准确的工具内容大小。
 *
 * Fixed token overhead added by the API when tools are present.
 */
export const TOOL_TOKEN_COUNT_OVERHEAD = 500

/**
 * 带回退机制的 token 计数函数。
 * 首先调用 API 精确计数，失败时降级到 Haiku 模型估算；两者均失败时返回 null。
 */
async function countTokensWithFallback(
  messages: Anthropic.Beta.Messages.BetaMessageParam[],
  tools: Anthropic.Beta.Messages.BetaToolUnion[],
): Promise<number | null> {
  try {
    const result = await countMessagesTokensWithAPI(messages, tools)
    if (result !== null) {
      return result
    }
    logForDebugging(
      `countTokensWithFallback: API returned null, trying haiku fallback (${tools.length} tools)`,
    )
  } catch (err) {
    logForDebugging(`countTokensWithFallback: API failed: ${errorMessage(err)}`)
    logError(err)
  }

  try {
    const fallbackResult = await countTokensViaHaikuFallback(messages, tools)
    if (fallbackResult === null) {
      logForDebugging(
        `countTokensWithFallback: haiku fallback also returned null (${tools.length} tools)`,
      )
    }
    return fallbackResult
  } catch (err) {
    logForDebugging(
      `countTokensWithFallback: haiku fallback failed: ${errorMessage(err)}`,
    )
    logError(err)
    return null
  }
}

interface ContextCategory {
  name: string
  tokens: number
  color: keyof Theme
  /** When true, these tokens are deferred and don't count toward context usage */
  isDeferred?: boolean
}

interface GridSquare {
  color: keyof Theme
  isFilled: boolean
  categoryName: string
  tokens: number
  percentage: number
  squareFullness: number // 0-1 representing how full this individual square is
}

interface MemoryFile {
  path: string
  type: string
  tokens: number
}

interface McpTool {
  name: string
  serverName: string
  tokens: number
  isLoaded?: boolean
}

export interface DeferredBuiltinTool {
  name: string
  tokens: number
  isLoaded: boolean
}

export interface SystemToolDetail {
  name: string
  tokens: number
}

export interface SystemPromptSectionDetail {
  name: string
  tokens: number
}

interface Agent {
  agentType: string
  source: SettingSource | 'built-in' | 'plugin'
  tokens: number
}

interface SlashCommandInfo {
  readonly totalCommands: number
  readonly includedCommands: number
  readonly tokens: number
}

/** Individual skill detail for context display */
interface SkillFrontmatter {
  name: string
  source: SettingSource | 'plugin'
  tokens: number
}

/**
 * Information about skills included in the context window.
 */
interface SkillInfo {
  /** Total number of available skills */
  readonly totalSkills: number
  /** Number of skills included within token budget */
  readonly includedSkills: number
  /** Total tokens consumed by skills */
  readonly tokens: number
  /** Individual skill details */
  readonly skillFrontmatter: SkillFrontmatter[]
}

export interface ContextData {
  readonly categories: ContextCategory[]
  readonly totalTokens: number
  readonly maxTokens: number
  readonly rawMaxTokens: number
  readonly percentage: number
  readonly gridRows: GridSquare[][]
  readonly model: string
  readonly memoryFiles: MemoryFile[]
  readonly mcpTools: McpTool[]
  /** Ant-only: per-tool breakdown of deferred built-in tools */
  readonly deferredBuiltinTools?: DeferredBuiltinTool[]
  /** Ant-only: per-tool breakdown of always-loaded built-in tools */
  readonly systemTools?: SystemToolDetail[]
  /** Ant-only: per-section breakdown of system prompt */
  readonly systemPromptSections?: SystemPromptSectionDetail[]
  readonly agents: Agent[]
  readonly slashCommands?: SlashCommandInfo
  /** Skill statistics */
  readonly skills?: SkillInfo
  readonly autoCompactThreshold?: number
  readonly isAutoCompactEnabled: boolean
  messageBreakdown?: {
    toolCallTokens: number
    toolResultTokens: number
    attachmentTokens: number
    assistantMessageTokens: number
    userMessageTokens: number
    toolCallsByType: Array<{
      name: string
      callTokens: number
      resultTokens: number
    }>
    attachmentsByType: Array<{ name: string; tokens: number }>
  }
  /** Actual token usage from last API response (if available) */
  readonly apiUsage: {
    input_tokens: number
    output_tokens: number
    cache_creation_input_tokens: number
    cache_read_input_tokens: number
  } | null
}

export async function countToolDefinitionTokens(
  tools: Tools,
  getToolPermissionContext: () => Promise<ToolPermissionContext>,
  agentInfo: AgentDefinitionsResult | null,
  model?: string,
): Promise<number> {
  const toolSchemas = await Promise.all(
    tools.map(tool =>
      toolToAPISchema(tool, {
        getToolPermissionContext,
        tools,
        agents: agentInfo?.activeAgents ?? [],
        model,
      }),
    ),
  )
  const result = await countTokensWithFallback([], toolSchemas)
  if (result === null || result === 0) {
    const toolNames = tools.map(t => t.name).join(', ')
    logForDebugging(
      `countToolDefinitionTokens returned ${result} for ${tools.length} tools: ${toolNames.slice(0, 100)}${toolNames.length > 100 ? '...' : ''}`,
    )
  }
  return result ?? 0
}

/** 从系统提示词章节内容中提取人可读的章节名称（取首个 Markdown 标题或首行截断） */
function extractSectionName(content: string): string {
  // Try to find first markdown heading
  const headingMatch = content.match(/^#+\s+(.+)$/m)
  if (headingMatch) {
    return headingMatch[1]!.trim()
  }
  // Fall back to a truncated preview of the first non-empty line
  const firstLine = content.split('\n').find(l => l.trim().length > 0) ?? ''
  return firstLine.length > 40 ? firstLine.slice(0, 40) + '…' : firstLine
}

/**
 * 统计系统提示词各章节的 token 数量。
 * 将 effectiveSystemPrompt 各段落及系统上下文（gitStatus 等）分别计数，
 * 返回汇总 token 数及逐章节明细。
 */
async function countSystemTokens(
  effectiveSystemPrompt: readonly string[],
): Promise<{
  systemPromptTokens: number
  systemPromptSections: SystemPromptSectionDetail[]
}> {
  // Get system context (gitStatus, etc.) which is always included
  const systemContext = await getSystemContext()

  // Build named entries: system prompt parts + system context values
  // Skip empty strings and the global-cache boundary marker
  const namedEntries: Array<{ name: string; content: string }> = [
    ...effectiveSystemPrompt
      .filter(
        content =>
          content.length > 0 && content !== SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
      )
      .map(content => ({ name: extractSectionName(content), content })),
    ...Object.entries(systemContext)
      .filter(([, content]) => content.length > 0)
      .map(([name, content]) => ({ name, content })),
  ]

  if (namedEntries.length < 1) {
    return { systemPromptTokens: 0, systemPromptSections: [] }
  }

  const systemTokenCounts = await Promise.all(
    namedEntries.map(({ content }) =>
      countTokensWithFallback([{ role: 'user', content }], []),
    ),
  )

  const systemPromptSections: SystemPromptSectionDetail[] = namedEntries.map(
    (entry, i) => ({
      name: entry.name,
      tokens: systemTokenCounts[i] || 0,
    }),
  )

  const systemPromptTokens = systemTokenCounts.reduce(
    (sum: number, tokens) => sum + (tokens || 0),
    0,
  )

  return { systemPromptTokens, systemPromptSections }
}

/**
 * 统计内存文件（CLAUDE.md 等）的 token 数量。
 * CLAUDE_CODE_SIMPLE 模式下不加载内存文件，直接返回零。
 */
async function countMemoryFileTokens(): Promise<{
  memoryFileDetails: MemoryFile[]
  claudeMdTokens: number
}> {
  // Simple mode disables CLAUDE.md loading, so don't report tokens for them
  if (isEnvTruthy(process.env.CLAUDE_CODE_SIMPLE)) {
    return { memoryFileDetails: [], claudeMdTokens: 0 }
  }

  const memoryFilesData = filterInjectedMemoryFiles(await getMemoryFiles())
  const memoryFileDetails: MemoryFile[] = []
  let claudeMdTokens = 0

  if (memoryFilesData.length < 1) {
    return {
      memoryFileDetails: [],
      claudeMdTokens: 0,
    }
  }

  const claudeMdTokenCounts = await Promise.all(
    memoryFilesData.map(async file => {
      const tokens = await countTokensWithFallback(
        [{ role: 'user', content: file.content }],
        [],
      )

      return { file, tokens: tokens || 0 }
    }),
  )

  for (const { file, tokens } of claudeMdTokenCounts) {
    claudeMdTokens += tokens
    memoryFileDetails.push({
      path: file.path,
      type: file.type,
      tokens,
    })
  }

  return { claudeMdTokens, memoryFileDetails }
}

/**
 * 统计内置工具的 token 数量，区分常驻工具与延迟加载工具（Tool Search 启用时）。
 * 内部用户（ant）额外返回逐工具明细（systemToolDetails），
 * 延迟工具仅在被消息历史中调用过时才计入实际用量。
 */
async function countBuiltInToolTokens(
  tools: Tools,
  getToolPermissionContext: () => Promise<ToolPermissionContext>,
  agentInfo: AgentDefinitionsResult | null,
  model?: string,
  messages?: Message[],
): Promise<{
  builtInToolTokens: number
  deferredBuiltinDetails: DeferredBuiltinTool[]
  deferredBuiltinTokens: number
  systemToolDetails: SystemToolDetail[]
}> {
  const builtInTools = tools.filter(tool => !tool.isMcp)
  if (builtInTools.length < 1) {
    return {
      builtInToolTokens: 0,
      deferredBuiltinDetails: [],
      deferredBuiltinTokens: 0,
      systemToolDetails: [],
    }
  }

  // Check if tool search is enabled
  const { isToolSearchEnabled } = await import('./toolSearch.js')
  const { isDeferredTool } = await import('../tools/ToolSearchTool/prompt.js')
  const isDeferred = await isToolSearchEnabled(
    model ?? '',
    tools,
    getToolPermissionContext,
    agentInfo?.activeAgents ?? [],
    'analyzeBuiltIn',
  )

  // Separate always-loaded and deferred builtin tools using dynamic isDeferredTool check
  const alwaysLoadedTools = builtInTools.filter(t => !isDeferredTool(t))
  const deferredBuiltinTools = builtInTools.filter(t => isDeferredTool(t))

  // Count always-loaded tools
  const alwaysLoadedTokens =
    alwaysLoadedTools.length > 0
      ? await countToolDefinitionTokens(
          alwaysLoadedTools,
          getToolPermissionContext,
          agentInfo,
          model,
        )
      : 0

  // Build per-tool breakdown for always-loaded tools (ant-only, proportional
  // split of the bulk count based on rough schema size estimation). Excludes
  // SkillTool since its tokens are shown in the separate Skills category.
  let systemToolDetails: SystemToolDetail[] = []
  if (process.env.USER_TYPE === 'ant') {
    const toolsForBreakdown = alwaysLoadedTools.filter(
      t => !toolMatchesName(t, SKILL_TOOL_NAME),
    )
    if (toolsForBreakdown.length > 0) {
      const estimates = toolsForBreakdown.map(t =>
        roughTokenCountEstimation(jsonStringify(t.inputSchema ?? {})),
      )
      const estimateTotal = estimates.reduce((s, e) => s + e, 0) || 1
      const distributable = Math.max(
        0,
        alwaysLoadedTokens - TOOL_TOKEN_COUNT_OVERHEAD,
      )
      systemToolDetails = toolsForBreakdown
        .map((t, i) => ({
          name: t.name,
          tokens: Math.round((estimates[i]! / estimateTotal) * distributable),
        }))
        .sort((a, b) => b.tokens - a.tokens)
    }
  }

  // Count deferred builtin tools individually for details
  const deferredBuiltinDetails: DeferredBuiltinTool[] = []
  let loadedDeferredTokens = 0
  let totalDeferredTokens = 0

  if (deferredBuiltinTools.length > 0 && isDeferred) {
    // Find which deferred tools have been used in messages
    const loadedToolNames = new Set<string>()
    if (messages) {
      const deferredToolNameSet = new Set(deferredBuiltinTools.map(t => t.name))
      for (const msg of messages) {
        if (msg.type === 'assistant') {
          for (const block of msg.message.content) {
            if (
              'type' in block &&
              block.type === 'tool_use' &&
              'name' in block &&
              typeof block.name === 'string' &&
              deferredToolNameSet.has(block.name)
            ) {
              loadedToolNames.add(block.name)
            }
          }
        }
      }
    }

    // Count each deferred tool
    const tokensByTool = await Promise.all(
      deferredBuiltinTools.map(t =>
        countToolDefinitionTokens(
          [t],
          getToolPermissionContext,
          agentInfo,
          model,
        ),
      ),
    )

    for (const [i, tool] of deferredBuiltinTools.entries()) {
      const tokens = Math.max(
        0,
        (tokensByTool[i] || 0) - TOOL_TOKEN_COUNT_OVERHEAD,
      )
      const isLoaded = loadedToolNames.has(tool.name)
      deferredBuiltinDetails.push({
        name: tool.name,
        tokens,
        isLoaded,
      })
      totalDeferredTokens += tokens
      if (isLoaded) {
        loadedDeferredTokens += tokens
      }
    }
  } else if (deferredBuiltinTools.length > 0) {
    // Tool search not enabled - count deferred tools as regular
    const deferredTokens = await countToolDefinitionTokens(
      deferredBuiltinTools,
      getToolPermissionContext,
      agentInfo,
      model,
    )
    return {
      builtInToolTokens: alwaysLoadedTokens + deferredTokens,
      deferredBuiltinDetails: [],
      deferredBuiltinTokens: 0,
      systemToolDetails,
    }
  }

  return {
    // When deferred, only count always-loaded tools + any loaded deferred tools
    builtInToolTokens: alwaysLoadedTokens + loadedDeferredTokens,
    deferredBuiltinDetails,
    deferredBuiltinTokens: totalDeferredTokens - loadedDeferredTokens,
    systemToolDetails,
  }
}

/** 在工具列表中查找 SkillTool（用于斜杠命令 token 计数） */
function findSkillTool(tools: Tools): Tool | undefined {
  return findToolByName(tools, SKILL_TOOL_NAME)
}

/**
 * 统计斜杠命令（SkillTool）消耗的 token 数量及命令总数/已包含数。
 */
async function countSlashCommandTokens(
  tools: Tools,
  getToolPermissionContext: () => Promise<ToolPermissionContext>,
  agentInfo: AgentDefinitionsResult | null,
): Promise<{
  slashCommandTokens: number
  commandInfo: { totalCommands: number; includedCommands: number }
}> {
  const info = await getSlashCommandInfo(getCwd())

  const slashCommandTool = findSkillTool(tools)
  if (!slashCommandTool) {
    return {
      slashCommandTokens: 0,
      commandInfo: { totalCommands: 0, includedCommands: 0 },
    }
  }

  const slashCommandTokens = await countToolDefinitionTokens(
    [slashCommandTool],
    getToolPermissionContext,
    agentInfo,
  )

  return {
    slashCommandTokens,
    commandInfo: {
      totalCommands: info.totalCommands,
      includedCommands: info.includedCommands,
    },
  }
}

/**
 * 统计 Skills（技能）的 token 用量及逐技能 frontmatter 估算明细。
 * 注意：Skills 使用与斜杠命令相同的 SkillTool，token 数不应重复累加。
 */
async function countSkillTokens(
  tools: Tools,
  getToolPermissionContext: () => Promise<ToolPermissionContext>,
  agentInfo: AgentDefinitionsResult | null,
): Promise<{
  skillTokens: number
  skillInfo: {
    totalSkills: number
    includedSkills: number
    skillFrontmatter: SkillFrontmatter[]
  }
}> {
  try {
    const skills = await getLimitedSkillToolCommands(getCwd())

    const slashCommandTool = findSkillTool(tools)
    if (!slashCommandTool) {
      return {
        skillTokens: 0,
        skillInfo: { totalSkills: 0, includedSkills: 0, skillFrontmatter: [] },
      }
    }

    // NOTE: This counts the entire SlashCommandTool (which includes both commands AND skills).
    // This is the same tool counted by countSlashCommandTokens(), but we track it separately
    // here for display purposes. These tokens should NOT be added to context categories
    // to avoid double-counting.
    const skillTokens = await countToolDefinitionTokens(
      [slashCommandTool],
      getToolPermissionContext,
      agentInfo,
    )

    // Calculate per-skill token estimates based on frontmatter only
    // (name, description, whenToUse) since full content is only loaded on invocation
    const skillFrontmatter: SkillFrontmatter[] = skills.map(skill => ({
      name: getCommandName(skill),
      source: (skill.type === 'prompt' ? skill.source : 'plugin') as
        | SettingSource
        | 'plugin',
      tokens: estimateSkillFrontmatterTokens(skill),
    }))

    return {
      skillTokens,
      skillInfo: {
        totalSkills: skills.length,
        includedSkills: skills.length,
        skillFrontmatter,
      },
    }
  } catch (error) {
    logError(toError(error))

    // Return zero values rather than failing the entire context analysis
    return {
      skillTokens: 0,
      skillInfo: { totalSkills: 0, includedSkills: 0, skillFrontmatter: [] },
    }
  }
}

/**
 * 统计 MCP 工具的 token 用量。
 * 使用批量 API 调用获取总 token 数，再按本地估算比例分摊到各工具。
 * Tool Search 启用时，区分已加载（被消息历史调用过）和延迟加载的 MCP 工具。
 */
export async function countMcpToolTokens(
  tools: Tools,
  getToolPermissionContext: () => Promise<ToolPermissionContext>,
  agentInfo: AgentDefinitionsResult | null,
  model: string,
  messages?: Message[],
): Promise<{
  mcpToolTokens: number
  mcpToolDetails: McpTool[]
  deferredToolTokens: number
  loadedMcpToolNames: Set<string>
}> {
  const mcpTools = tools.filter(tool => tool.isMcp)
  const mcpToolDetails: McpTool[] = []
  // Single bulk API call for all MCP tools (instead of N individual calls)
  const totalTokensRaw = await countToolDefinitionTokens(
    mcpTools,
    getToolPermissionContext,
    agentInfo,
    model,
  )
  // Subtract the single overhead since we made one bulk call
  const totalTokens = Math.max(
    0,
    (totalTokensRaw || 0) - TOOL_TOKEN_COUNT_OVERHEAD,
  )

  // Estimate per-tool proportions for display using local estimation.
  // Include name + description + input schema to match what toolToAPISchema
  // sends — otherwise tools with similar schemas but different descriptions
  // get identical counts (MCP tools share the same base Zod inputSchema).
  const estimates = await Promise.all(
    mcpTools.map(async t =>
      roughTokenCountEstimation(
        jsonStringify({
          name: t.name,
          description: await t.prompt({
            getToolPermissionContext,
            tools,
            agents: agentInfo?.activeAgents ?? [],
          }),
          input_schema: t.inputJSONSchema ?? {},
        }),
      ),
    ),
  )
  const estimateTotal = estimates.reduce((s, e) => s + e, 0) || 1
  const mcpToolTokensByTool = estimates.map(e =>
    Math.round((e / estimateTotal) * totalTokens),
  )

  // Check if tool search is enabled - if so, MCP tools are deferred
  // isToolSearchEnabled handles threshold calculation internally for TstAuto mode
  const { isToolSearchEnabled } = await import('./toolSearch.js')
  const { isDeferredTool } = await import('../tools/ToolSearchTool/prompt.js')

  const isDeferred = await isToolSearchEnabled(
    model,
    tools,
    getToolPermissionContext,
    agentInfo?.activeAgents ?? [],
    'analyzeMcp',
  )

  // Find MCP tools that have been used in messages (loaded via ToolSearchTool)
  const loadedMcpToolNames = new Set<string>()
  if (isDeferred && messages) {
    const mcpToolNameSet = new Set(mcpTools.map(t => t.name))
    for (const msg of messages) {
      if (msg.type === 'assistant') {
        for (const block of msg.message.content) {
          if (
            'type' in block &&
            block.type === 'tool_use' &&
            'name' in block &&
            typeof block.name === 'string' &&
            mcpToolNameSet.has(block.name)
          ) {
            loadedMcpToolNames.add(block.name)
          }
        }
      }
    }
  }

  // Build tool details with isLoaded flag
  for (const [i, tool] of mcpTools.entries()) {
    mcpToolDetails.push({
      name: tool.name,
      serverName: tool.name.split('__')[1] || 'unknown',
      tokens: mcpToolTokensByTool[i]!,
      isLoaded: loadedMcpToolNames.has(tool.name) || !isDeferredTool(tool),
    })
  }

  // Calculate loaded vs deferred tokens
  let loadedTokens = 0
  let deferredTokens = 0
  for (const detail of mcpToolDetails) {
    if (detail.isLoaded) {
      loadedTokens += detail.tokens
    } else if (isDeferred) {
      deferredTokens += detail.tokens
    }
  }

  return {
    // When deferred but some tools are loaded, count loaded tokens
    mcpToolTokens: isDeferred ? loadedTokens : totalTokens,
    mcpToolDetails,
    // Track deferred tokens separately for display
    deferredToolTokens: deferredTokens,
    loadedMcpToolNames,
  }
}

/**
 * 统计用户自定义 Agent 的 token 数量（排除内置 Agent）。
 */
async function countCustomAgentTokens(agentDefinitions: {
  activeAgents: AgentDefinition[]
}): Promise<{
  agentTokens: number
  agentDetails: Agent[]
}> {
  const customAgents = agentDefinitions.activeAgents.filter(
    a => a.source !== 'built-in',
  )
  const agentDetails: Agent[] = []
  let agentTokens = 0

  const tokenCounts = await Promise.all(
    customAgents.map(agent =>
      countTokensWithFallback(
        [
          {
            role: 'user',
            content: [agent.agentType, agent.whenToUse].join(' '),
          },
        ],
        [],
      ),
    ),
  )

  for (const [i, agent] of customAgents.entries()) {
    const tokens = tokenCounts[i] || 0
    agentTokens += tokens || 0
    agentDetails.push({
      agentType: agent.agentType,
      source: agent.source,
      tokens: tokens || 0,
    })
  }
  return { agentTokens, agentDetails }
}

type MessageBreakdown = {
  totalTokens: number
  toolCallTokens: number
  toolResultTokens: number
  attachmentTokens: number
  assistantMessageTokens: number
  userMessageTokens: number
  toolCallsByType: Map<string, number>
  toolResultsByType: Map<string, number>
  attachmentsByType: Map<string, number>
}

/**
 * 处理单条 Assistant 消息，将各内容块的 token 估算值分类累加到 breakdown。
 * tool_use 块计入工具调用 token，其余文本块计入助手消息 token。
 * 工具调用按工具名称分组，方便后续按工具统计。
 */
/**
 * 处理单条 Assistant 消息，将各内容块的 token 估算值分类累加到 breakdown。
 * tool_use 块计入工具调用 token，其余文本块计入助手消息 token。
 * 工具调用按工具名称分组，方便后续按工具统计。
 */
function processAssistantMessage(
  msg: AssistantMessage | NormalizedAssistantMessage,
  breakdown: MessageBreakdown,
): void {
  // Process each content block individually
  for (const block of msg.message.content) {
    const blockStr = jsonStringify(block)
    const blockTokens = roughTokenCountEstimation(blockStr)

    if ('type' in block && block.type === 'tool_use') {
      breakdown.toolCallTokens += blockTokens
      const toolName = ('name' in block ? block.name : undefined) || 'unknown'
      breakdown.toolCallsByType.set(
        toolName,
        (breakdown.toolCallsByType.get(toolName) || 0) + blockTokens,
      )
    } else {
      // Text blocks or other non-tool content
      breakdown.assistantMessageTokens += blockTokens
    }
  }
}

/**
 * 处理单条 User 消息，将各内容块的 token 估算值分类累加到 breakdown。
 * tool_result 块通过 toolUseIdToName 映射到工具名称后计入工具结果 token；
 * 其余文本块计入用户消息 token。字符串内容直接统计，不再按块拆分。
 */
/**
 * 处理单条 User 消息，将各内容块的 token 估算值分类累加到 breakdown。
 * tool_result 块通过 toolUseIdToName 映射到工具名称后计入工具结果 token；
 * 其余文本块计入用户消息 token。字符串内容直接统计，不再按块拆分。
 */
function processUserMessage(
  msg: UserMessage | NormalizedUserMessage,
  breakdown: MessageBreakdown,
  toolUseIdToName: Map<string, string>,
): void {
  // Handle both string and array content
  if (typeof msg.message.content === 'string') {
    // Simple string content
    const tokens = roughTokenCountEstimation(msg.message.content)
    breakdown.userMessageTokens += tokens
    return
  }

  // Process each content block individually
  for (const block of msg.message.content) {
    const blockStr = jsonStringify(block)
    const blockTokens = roughTokenCountEstimation(blockStr)

    if ('type' in block && block.type === 'tool_result') {
      breakdown.toolResultTokens += blockTokens
      const toolUseId = 'tool_use_id' in block ? block.tool_use_id : undefined
      const toolName =
        (toolUseId ? toolUseIdToName.get(toolUseId) : undefined) || 'unknown'
      breakdown.toolResultsByType.set(
        toolName,
        (breakdown.toolResultsByType.get(toolName) || 0) + blockTokens,
      )
    } else {
      // Text blocks or other non-tool content
      breakdown.userMessageTokens += blockTokens
    }
  }
}

/**
 * 处理单条 Attachment 消息，将附件的 token 估算值按附件类型分类累加到 breakdown。
 * 用于在消息 breakdown 中展示图片、文件、诊断等各类附件的 token 占用。
 */
/**
 * 处理单条 Attachment 消息，将附件的 token 估算值按附件类型分类累加到 breakdown。
 * 用于在消息 breakdown 中展示图片、文件、诊断等各类附件的 token 占用。
 */
function processAttachment(
  msg: AttachmentMessage,
  breakdown: MessageBreakdown,
): void {
  const contentStr = jsonStringify(msg.attachment)
  const tokens = roughTokenCountEstimation(contentStr)
  breakdown.attachmentTokens += tokens
  const attachType = msg.attachment.type || 'unknown'
  breakdown.attachmentsByType.set(
    attachType,
    (breakdown.attachmentsByType.get(attachType) || 0) + tokens,
  )
}

/**
 * 对消息历史按内容块类型进行 token 估算分解。
 * 先通过 microcompactMessages 压缩消息，再逐块分类统计：
 * 工具调用、工具结果、附件、助手文本、用户文本。
 * 总 token 数通过 API 精确计数（带回退）获得。
 */
async function approximateMessageTokens(
  messages: Message[],
): Promise<MessageBreakdown> {
  const microcompactResult = await microcompactMessages(messages)

  // Initialize tracking
  const breakdown: MessageBreakdown = {
    totalTokens: 0,
    toolCallTokens: 0,
    toolResultTokens: 0,
    attachmentTokens: 0,
    assistantMessageTokens: 0,
    userMessageTokens: 0,
    toolCallsByType: new Map<string, number>(),
    toolResultsByType: new Map<string, number>(),
    attachmentsByType: new Map<string, number>(),
  }

  // Build a map of tool_use_id to tool_name for easier lookup
  const toolUseIdToName = new Map<string, string>()
  for (const msg of microcompactResult.messages) {
    if (msg.type === 'assistant') {
      for (const block of msg.message.content) {
        if ('type' in block && block.type === 'tool_use') {
          const toolUseId = 'id' in block ? block.id : undefined
          const toolName =
            ('name' in block ? block.name : undefined) || 'unknown'
          if (toolUseId) {
            toolUseIdToName.set(toolUseId, toolName)
          }
        }
      }
    }
  }

  // Process each message for detailed breakdown
  for (const msg of microcompactResult.messages) {
    if (msg.type === 'assistant') {
      processAssistantMessage(msg, breakdown)
    } else if (msg.type === 'user') {
      processUserMessage(msg, breakdown, toolUseIdToName)
    } else if (msg.type === 'attachment') {
      processAttachment(msg, breakdown)
    }
  }

  // Calculate total tokens using the API for accuracy
  const approximateMessageTokens = await countTokensWithFallback(
    normalizeMessagesForAPI(microcompactResult.messages).map(_ => {
      if (_.type === 'assistant') {
        return {
          // Important: strip out fields like id, etc. -- the counting API errors if they're present
          role: 'assistant',
          content: _.message.content,
        }
      }
      return _.message
    }),
    [],
  )

  breakdown.totalTokens = approximateMessageTokens ?? 0
  return breakdown
}

/**
 * 核心分析函数：并发统计所有上下文类别的 token 用量，生成 ContextData。
 *
 * 主要流程：
 * 1. 并发执行系统提示词、内存文件、内置工具、MCP 工具、
 *    自定义 Agent、斜杠命令、消息历史的 token 计数
 * 2. 单独执行 Skill token 计数（错误隔离）
 * 3. 构建上下文类别列表（cats），包含 autocompact/manual compact 缓冲区
 * 4. 计算网格可视化数据（GridSquare[][]），支持窄屏/宽屏/百万 token 模型
 * 5. 优先使用 API 实际 usage 数据作为 totalTokens，降级到本地估算
 *
 * @param originalMessages - 压缩前的原始消息（用于提取 API usage）
 */
export async function analyzeContextUsage(
  messages: Message[],
  model: string,
  getToolPermissionContext: () => Promise<ToolPermissionContext>,
  tools: Tools,
  agentDefinitions: AgentDefinitionsResult,
  terminalWidth?: number,
  toolUseContext?: Pick<ToolUseContext, 'options'>,
  mainThreadAgentDefinition?: AgentDefinition,
  /** Original messages before microcompact, used to extract API usage */
  originalMessages?: Message[],
): Promise<ContextData> {
  const runtimeModel = getRuntimeMainLoopModel({
    permissionMode: (await getToolPermissionContext()).mode,
    mainLoopModel: model,
  })
  // Get context window size
  const contextWindow = getContextWindowForModel(runtimeModel, getSdkBetas())

  // Build the effective system prompt using the shared utility
  const defaultSystemPrompt = await getSystemPrompt(tools, runtimeModel)
  const effectiveSystemPrompt = buildEffectiveSystemPrompt({
    mainThreadAgentDefinition,
    toolUseContext: toolUseContext ?? {
      options: {} as ToolUseContext['options'],
    },
    customSystemPrompt: toolUseContext?.options.customSystemPrompt,
    defaultSystemPrompt,
    appendSystemPrompt: toolUseContext?.options.appendSystemPrompt,
  })

  // Critical operations that should not fail due to skills
  const [
    { systemPromptTokens, systemPromptSections },
    { claudeMdTokens, memoryFileDetails },
    {
      builtInToolTokens,
      deferredBuiltinDetails,
      deferredBuiltinTokens,
      systemToolDetails,
    },
    { mcpToolTokens, mcpToolDetails, deferredToolTokens },
    { agentTokens, agentDetails },
    { slashCommandTokens, commandInfo },
    messageBreakdown,
  ] = await Promise.all([
    countSystemTokens(effectiveSystemPrompt),
    countMemoryFileTokens(),
    countBuiltInToolTokens(
      tools,
      getToolPermissionContext,
      agentDefinitions,
      runtimeModel,
      messages,
    ),
    countMcpToolTokens(
      tools,
      getToolPermissionContext,
      agentDefinitions,
      runtimeModel,
      messages,
    ),
    countCustomAgentTokens(agentDefinitions),
    countSlashCommandTokens(tools, getToolPermissionContext, agentDefinitions),
    approximateMessageTokens(messages),
  ])

  // Count skills separately with error isolation
  const skillResult = await countSkillTokens(
    tools,
    getToolPermissionContext,
    agentDefinitions,
  )
  const skillInfo = skillResult.skillInfo
  // Use sum of individual skill token estimates (matches what's shown in details)
  // rather than skillResult.skillTokens which includes tool schema overhead
  const skillFrontmatterTokens = skillInfo.skillFrontmatter.reduce(
    (sum, skill) => sum + skill.tokens,
    0,
  )

  const messageTokens = messageBreakdown.totalTokens

  // Check if autocompact is enabled and calculate threshold
  const isAutoCompact = isAutoCompactEnabled()
  const autoCompactThreshold = isAutoCompact
    ? getEffectiveContextWindowSize(model) - AUTOCOMPACT_BUFFER_TOKENS
    : undefined

  // Create categories
  const cats: ContextCategory[] = []

  // System prompt is always shown first (fixed overhead)
  if (systemPromptTokens > 0) {
    cats.push({
      name: 'System prompt',
      tokens: systemPromptTokens,
      color: 'promptBorder',
    })
  }

  // Built-in tools right after system prompt (skills shown separately below)
  // Ant users get a per-tool breakdown via systemToolDetails
  const systemToolsTokens = builtInToolTokens - skillFrontmatterTokens
  if (systemToolsTokens > 0) {
    cats.push({
      name:
        process.env.USER_TYPE === 'ant'
          ? '[ANT-ONLY] System tools'
          : 'System tools',
      tokens: systemToolsTokens,
      color: 'inactive',
    })
  }

  // MCP tools after system tools
  if (mcpToolTokens > 0) {
    cats.push({
      name: 'MCP tools',
      tokens: mcpToolTokens,
      color: 'cyan_FOR_SUBAGENTS_ONLY',
    })
  }

  // Show deferred MCP tools (when tool search is enabled)
  // These don't count toward context usage but we show them for visibility
  if (deferredToolTokens > 0) {
    cats.push({
      name: 'MCP tools (deferred)',
      tokens: deferredToolTokens,
      color: 'inactive',
      isDeferred: true,
    })
  }

  // Show deferred builtin tools (when tool search is enabled)
  if (deferredBuiltinTokens > 0) {
    cats.push({
      name: 'System tools (deferred)',
      tokens: deferredBuiltinTokens,
      color: 'inactive',
      isDeferred: true,
    })
  }

  // Custom agents after MCP tools
  if (agentTokens > 0) {
    cats.push({
      name: 'Custom agents',
      tokens: agentTokens,
      color: 'permission',
    })
  }

  // Memory files after custom agents
  if (claudeMdTokens > 0) {
    cats.push({
      name: 'Memory files',
      tokens: claudeMdTokens,
      color: 'claude',
    })
  }

  // Skills after memory files
  if (skillFrontmatterTokens > 0) {
    cats.push({
      name: 'Skills',
      tokens: skillFrontmatterTokens,
      color: 'warning',
    })
  }

  if (messageTokens !== null && messageTokens > 0) {
    cats.push({
      name: 'Messages',
      tokens: messageTokens,
      color: 'purple_FOR_SUBAGENTS_ONLY',
    })
  }

  // Calculate actual content usage (before adding reserved buffers)
  // Exclude deferred categories from the usage calculation
  const actualUsage = cats.reduce(
    (sum, cat) => sum + (cat.isDeferred ? 0 : cat.tokens),
    0,
  )

  // Reserved space after messages (not counted in actualUsage shown to user).
  // Under reactive-only mode (cobalt_raccoon), proactive autocompact never
  // fires and the reserved buffer is a lie — skip it entirely and let Free
  // space fill the grid. feature() guard keeps the flag string out of
  // external builds. Same for context-collapse (marble_origami) — collapse
  // owns the threshold ladder and autocompact is suppressed in
  // shouldAutoCompact, so the 33k buffer shown here would be a lie too.
  let reservedTokens = 0
  let skipReservedBuffer = false
  if (feature('REACTIVE_COMPACT')) {
    if (getFeatureValue_CACHED_MAY_BE_STALE('tengu_cobalt_raccoon', false)) {
      skipReservedBuffer = true
    }
  }
  if (feature('CONTEXT_COLLAPSE')) {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { isContextCollapseEnabled } =
      require('../services/contextCollapse/index.js') as typeof import('../services/contextCollapse/index.js')
    /* eslint-enable @typescript-eslint/no-require-imports */
    if (isContextCollapseEnabled()) {
      skipReservedBuffer = true
    }
  }
  if (skipReservedBuffer) {
    // No buffer category pushed — reactive compaction is transparent and
    // doesn't need a visible reservation in the grid.
  } else if (isAutoCompact && autoCompactThreshold !== undefined) {
    // Autocompact buffer (from effective context)
    reservedTokens = contextWindow - autoCompactThreshold
    cats.push({
      name: RESERVED_CATEGORY_NAME,
      tokens: reservedTokens,
      color: 'inactive',
    })
  } else if (!isAutoCompact) {
    // Compact buffer reserve (3k from actual context limit)
    reservedTokens = MANUAL_COMPACT_BUFFER_TOKENS
    cats.push({
      name: MANUAL_COMPACT_BUFFER_NAME,
      tokens: reservedTokens,
      color: 'inactive',
    })
  }

  // Calculate free space (subtract both actual usage and reserved buffer)
  const freeTokens = Math.max(0, contextWindow - actualUsage - reservedTokens)

  cats.push({
    name: 'Free space',
    tokens: freeTokens,
    color: 'promptBorder',
  })

  // Total for display (everything except free space)
  const totalIncludingReserved = actualUsage

  // Extract API usage from original messages (if provided) to match status line
  // This uses the same source of truth as the status line for consistency
  const apiUsage = getCurrentUsage(originalMessages ?? messages)

  // When API usage is available, use it for total to match status line calculation
  // Status line uses: input_tokens + cache_creation_input_tokens + cache_read_input_tokens
  const totalFromAPI = apiUsage
    ? apiUsage.input_tokens +
      apiUsage.cache_creation_input_tokens +
      apiUsage.cache_read_input_tokens
    : null

  // Use API total if available, otherwise fall back to estimated total
  const finalTotalTokens = totalFromAPI ?? totalIncludingReserved

  // Pre-calculate grid based on model context window and terminal width
  // For narrow screens (< 80 cols), use 5x5 for 200k models, 5x10 for 1M+ models
  // For normal screens, use 10x10 for 200k models, 20x10 for 1M+ models
  const isNarrowScreen = terminalWidth && terminalWidth < 80
  const GRID_WIDTH =
    contextWindow >= 1000000
      ? isNarrowScreen
        ? 5
        : 20
      : isNarrowScreen
        ? 5
        : 10
  const GRID_HEIGHT = contextWindow >= 1000000 ? 10 : isNarrowScreen ? 5 : 10
  const TOTAL_SQUARES = GRID_WIDTH * GRID_HEIGHT

  // Filter out deferred categories - they don't take up actual context space
  // (e.g., MCP tools when tool search is enabled)
  const nonDeferredCats = cats.filter(cat => !cat.isDeferred)

  // Calculate squares per category (use rawEffectiveMax for visualization to show full context)
  const categorySquares = nonDeferredCats.map(cat => ({
    ...cat,
    squares:
      cat.name === 'Free space'
        ? Math.round((cat.tokens / contextWindow) * TOTAL_SQUARES)
        : Math.max(1, Math.round((cat.tokens / contextWindow) * TOTAL_SQUARES)),
    percentageOfTotal: Math.round((cat.tokens / contextWindow) * 100),
  }))

  // Helper function to create grid squares for a category
  function createCategorySquares(
    category: (typeof categorySquares)[0],
  ): GridSquare[] {
    const squares: GridSquare[] = []
    const exactSquares = (category.tokens / contextWindow) * TOTAL_SQUARES
    const wholeSquares = Math.floor(exactSquares)
    const fractionalPart = exactSquares - wholeSquares

    for (let i = 0; i < category.squares; i++) {
      // Determine fullness: full squares get 1.0, partial square gets fractional amount
      let squareFullness = 1.0
      if (i === wholeSquares && fractionalPart > 0) {
        // This is the partial square
        squareFullness = fractionalPart
      }

      squares.push({
        color: category.color,
        isFilled: true,
        categoryName: category.name,
        tokens: category.tokens,
        percentage: category.percentageOfTotal,
        squareFullness,
      })
    }

    return squares
  }

  // Build the grid as an array of squares with full metadata
  const gridSquares: GridSquare[] = []

  // Separate reserved category for end placement (either autocompact or manual compact buffer)
  const reservedCategory = categorySquares.find(
    cat =>
      cat.name === RESERVED_CATEGORY_NAME ||
      cat.name === MANUAL_COMPACT_BUFFER_NAME,
  )
  const nonReservedCategories = categorySquares.filter(
    cat =>
      cat.name !== RESERVED_CATEGORY_NAME &&
      cat.name !== MANUAL_COMPACT_BUFFER_NAME &&
      cat.name !== 'Free space',
  )

  // Add all non-reserved, non-free-space squares first
  for (const cat of nonReservedCategories) {
    const squares = createCategorySquares(cat)
    for (const square of squares) {
      if (gridSquares.length < TOTAL_SQUARES) {
        gridSquares.push(square)
      }
    }
  }

  // Calculate how many squares are needed for reserved
  const reservedSquareCount = reservedCategory ? reservedCategory.squares : 0

  // Fill with free space, leaving room for reserved at the end
  const freeSpaceCat = cats.find(c => c.name === 'Free space')
  const freeSpaceTarget = TOTAL_SQUARES - reservedSquareCount

  while (gridSquares.length < freeSpaceTarget) {
    gridSquares.push({
      color: 'promptBorder',
      isFilled: true,
      categoryName: 'Free space',
      tokens: freeSpaceCat?.tokens || 0,
      percentage: freeSpaceCat
        ? Math.round((freeSpaceCat.tokens / contextWindow) * 100)
        : 0,
      squareFullness: 1.0, // Free space is always "full"
    })
  }

  // Add reserved squares at the end
  if (reservedCategory) {
    const squares = createCategorySquares(reservedCategory)
    for (const square of squares) {
      if (gridSquares.length < TOTAL_SQUARES) {
        gridSquares.push(square)
      }
    }
  }

  // Convert to rows for rendering
  const gridRows: GridSquare[][] = []
  for (let i = 0; i < GRID_HEIGHT; i++) {
    gridRows.push(gridSquares.slice(i * GRID_WIDTH, (i + 1) * GRID_WIDTH))
  }

  // Format message breakdown (used by context suggestions for all users)
  // Combine tool calls and results, then get top 5
  const toolsMap = new Map<
    string,
    { callTokens: number; resultTokens: number }
  >()

  // Add call tokens
  for (const [name, tokens] of messageBreakdown.toolCallsByType.entries()) {
    const existing = toolsMap.get(name) || { callTokens: 0, resultTokens: 0 }
    toolsMap.set(name, { ...existing, callTokens: tokens })
  }

  // Add result tokens
  for (const [name, tokens] of messageBreakdown.toolResultsByType.entries()) {
    const existing = toolsMap.get(name) || { callTokens: 0, resultTokens: 0 }
    toolsMap.set(name, { ...existing, resultTokens: tokens })
  }

  // Convert to array and sort by total tokens (calls + results)
  const toolsByTypeArray = Array.from(toolsMap.entries())
    .map(([name, { callTokens, resultTokens }]) => ({
      name,
      callTokens,
      resultTokens,
    }))
    .sort(
      (a, b) => b.callTokens + b.resultTokens - (a.callTokens + a.resultTokens),
    )

  const attachmentsByTypeArray = Array.from(
    messageBreakdown.attachmentsByType.entries(),
  )
    .map(([name, tokens]) => ({ name, tokens }))
    .sort((a, b) => b.tokens - a.tokens)

  const formattedMessageBreakdown = {
    toolCallTokens: messageBreakdown.toolCallTokens,
    toolResultTokens: messageBreakdown.toolResultTokens,
    attachmentTokens: messageBreakdown.attachmentTokens,
    assistantMessageTokens: messageBreakdown.assistantMessageTokens,
    userMessageTokens: messageBreakdown.userMessageTokens,
    toolCallsByType: toolsByTypeArray,
    attachmentsByType: attachmentsByTypeArray,
  }

  return {
    categories: cats,
    totalTokens: finalTotalTokens,
    maxTokens: contextWindow,
    rawMaxTokens: contextWindow,
    percentage: Math.round((finalTotalTokens / contextWindow) * 100),
    gridRows,
    model: runtimeModel,
    memoryFiles: memoryFileDetails,
    mcpTools: mcpToolDetails,
    deferredBuiltinTools:
      process.env.USER_TYPE === 'ant' ? deferredBuiltinDetails : undefined,
    systemTools:
      process.env.USER_TYPE === 'ant' ? systemToolDetails : undefined,
    systemPromptSections:
      process.env.USER_TYPE === 'ant' ? systemPromptSections : undefined,
    agents: agentDetails,
    slashCommands:
      slashCommandTokens > 0
        ? {
            totalCommands: commandInfo.totalCommands,
            includedCommands: commandInfo.includedCommands,
            tokens: slashCommandTokens,
          }
        : undefined,
    skills:
      skillFrontmatterTokens > 0
        ? {
            totalSkills: skillInfo.totalSkills,
            includedSkills: skillInfo.includedSkills,
            tokens: skillFrontmatterTokens,
            skillFrontmatter: skillInfo.skillFrontmatter,
          }
        : undefined,
    autoCompactThreshold,
    isAutoCompactEnabled: isAutoCompact,
    messageBreakdown: formattedMessageBreakdown,
    apiUsage,
  }
}
