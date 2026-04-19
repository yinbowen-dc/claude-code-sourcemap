/**
 * unifiedSuggestions.ts
 *
 * 【在系统流程中的位置】
 * 本文件属于 Claude Code 「输入建议」子系统，是 @ 前缀触发的联合建议引擎。
 * 当用户在 PromptInput 中输入 @ 符号时，本文件负责将三类候选项聚合并统一排序：
 *   1. 文件建议（由 Rust/nucleo 模糊匹配引擎评分）
 *   2. MCP 资源建议（来自已连接的 MCP Server 资源列表）
 *   3. Agent 建议（来自 AgentTool 定义的 AgentDefinition 列表）
 *
 * 核心设计：
 * - 文件建议已由 fileSuggestions.ts 中的 nucleo 引擎预评分（0-1，越小越好）；
 * - 非文件建议（MCP 资源、Agent）使用 Fuse.js 进行模糊评分；
 * - 所有结果按统一的 score 字段升序排序，取前 15 条返回；
 * - 无 query 时（仅 @ 字符）按固定顺序返回全部，不进行评分。
 */

import Fuse from 'fuse.js'
import { basename } from 'path'
import type { SuggestionItem } from 'src/components/PromptInput/PromptInputFooterSuggestions.js'
import { generateFileSuggestions } from 'src/hooks/fileSuggestions.js'
import type { ServerResource } from 'src/services/mcp/types.js'
import { getAgentColor } from 'src/tools/AgentTool/agentColorManager.js'
import type { AgentDefinition } from 'src/tools/AgentTool/loadAgentsDir.js'
import { truncateToWidth } from 'src/utils/format.js'
import { logError } from 'src/utils/log.js'
import type { Theme } from 'src/utils/theme.js'

/** 文件建议数据源（来自 fileSuggestions.ts） */
type FileSuggestionSource = {
  type: 'file'
  displayText: string     // 显示文本（相对路径）
  description?: string    // 描述（可选，如文件类型）
  path: string            // 文件路径（用于生成唯一 ID）
  filename: string        // 文件名（basename，用于 Fuse.js 搜索权重）
  score?: number          // nucleo 评分（0-1，越小越好）
}

/** MCP 资源建议数据源（来自已连接的 MCP Server） */
type McpResourceSuggestionSource = {
  type: 'mcp_resource'
  displayText: string   // server:uri 格式的显示文本
  description: string   // 资源描述
  server: string        // MCP Server 名称
  uri: string           // 资源 URI
  name: string          // 资源名称
}

/** Agent 建议数据源（来自 AgentTool 的 AgentDefinition） */
type AgentSuggestionSource = {
  type: 'agent'
  displayText: string       // "agentType (agent)" 格式
  description: string       // whenToUse 字段（截断到 60 字符）
  agentType: string         // Agent 类型名
  color?: keyof Theme       // Agent 颜色标识（用于 UI 高亮）
}

/** 联合建议数据源类型 */
type SuggestionSource =
  | FileSuggestionSource
  | McpResourceSuggestionSource
  | AgentSuggestionSource

/** 最多返回的联合建议条数 */
const MAX_UNIFIED_SUGGESTIONS = 15
/** 建议描述文本的最大显示宽度（字符数） */
const DESCRIPTION_MAX_LENGTH = 60

/** 截断描述文本到指定宽度（防止过长描述占用过多空间） */
function truncateDescription(description: string): string {
  return truncateToWidth(description, DESCRIPTION_MAX_LENGTH)
}

/**
 * 将数据源对象转换为 UI 组件所需的 SuggestionItem 格式。
 * 按来源类型生成唯一的 id 字符串（避免跨类型 ID 冲突）。
 *
 * @param source 联合数据源（文件/MCP 资源/Agent）
 */
function createSuggestionFromSource(source: SuggestionSource): SuggestionItem {
  switch (source.type) {
    case 'file':
      return {
        id: `file-${source.path}`,
        displayText: source.displayText,
        description: source.description,
      }
    case 'mcp_resource':
      return {
        // 用 __ 分隔 server 和 uri，避免单独分隔符可能出现在路径中导致冲突
        id: `mcp-resource-${source.server}__${source.uri}`,
        displayText: source.displayText,
        description: source.description,
      }
    case 'agent':
      return {
        id: `agent-${source.agentType}`,
        displayText: source.displayText,
        description: source.description,
        color: source.color,
      }
  }
}

/**
 * 根据 query 从 AgentDefinition 列表生成 Agent 建议。
 *
 * 无 query 时（若 showOnEmpty=true）返回全部；
 * 有 query 时对 agentType 和 displayText 进行大小写不敏感的 includes 过滤。
 *
 * @param agents      Agent 定义列表
 * @param query       搜索词
 * @param showOnEmpty 无 query 时是否仍返回建议（@ 触发时）
 */
function generateAgentSuggestions(
  agents: AgentDefinition[],
  query: string,
  showOnEmpty = false,
): AgentSuggestionSource[] {
  // 无 query 且未设置 showOnEmpty 时不返回建议
  if (!query && !showOnEmpty) {
    return []
  }

  try {
    // 构建 Agent 数据源列表（将 AgentDefinition 映射为 AgentSuggestionSource）
    const agentSources: AgentSuggestionSource[] = agents.map(agent => ({
      type: 'agent' as const,
      displayText: `${agent.agentType} (agent)`,
      description: truncateDescription(agent.whenToUse),  // 截断 whenToUse 到 60 字符
      agentType: agent.agentType,
      color: getAgentColor(agent.agentType),
    }))

    // 无 query 时（showOnEmpty=true）直接返回全部
    if (!query) {
      return agentSources
    }

    // 有 query 时按 agentType 或 displayText 大小写不敏感过滤
    const queryLower = query.toLowerCase()
    return agentSources.filter(
      agent =>
        agent.agentType.toLowerCase().includes(queryLower) ||
        agent.displayText.toLowerCase().includes(queryLower),
    )
  } catch (error) {
    logError(error as Error)
    return []
  }
}

/**
 * 生成文件、MCP 资源、Agent 三类建议的联合排序结果。
 *
 * 流程：
 * 1. 并行获取文件建议（nucleo 评分）和 Agent 建议；
 * 2. 将 MCP 资源展平为数据源列表；
 * 3. 无 query 时：按 [文件, MCP 资源, Agent] 顺序取前 15 条，不评分；
 * 4. 有 query 时：
 *    a. 文件使用 nucleo 评分（已内置）；
 *    b. 非文件类型使用 Fuse.js 评分（threshold=0.6，多字段加权）；
 *    c. 所有结果按 score 升序排序（越小越好），取前 15 条返回。
 *
 * @param query       搜索词（空字符串表示仅 @ 触发）
 * @param mcpResources 按 Server 分组的 MCP 资源
 * @param agents      Agent 定义列表
 * @param showOnEmpty 无 query 时是否返回建议
 */
export async function generateUnifiedSuggestions(
  query: string,
  mcpResources: Record<string, ServerResource[]>,
  agents: AgentDefinition[],
  showOnEmpty = false,
): Promise<SuggestionItem[]> {
  // 无 query 且未启用 showOnEmpty 时，不返回任何建议
  if (!query && !showOnEmpty) {
    return []
  }

  // 并行获取文件建议和 Agent 建议（文件获取可能涉及 I/O，异步执行）
  const [fileSuggestions, agentSources] = await Promise.all([
    generateFileSuggestions(query, showOnEmpty),
    Promise.resolve(generateAgentSuggestions(agents, query, showOnEmpty)),
  ])

  // 将文件建议转换为 FileSuggestionSource（补充 path 和 filename 字段）
  const fileSources: FileSuggestionSource[] = fileSuggestions.map(
    suggestion => ({
      type: 'file' as const,
      displayText: suggestion.displayText,
      description: suggestion.description,
      path: suggestion.displayText, // 使用 displayText 作为路径
      filename: basename(suggestion.displayText),
      score: (suggestion.metadata as { score?: number } | undefined)?.score,
    }),
  )

  // 将 MCP 资源展平为 McpResourceSuggestionSource 列表
  const mcpSources: McpResourceSuggestionSource[] = Object.values(mcpResources)
    .flat()
    .map(resource => ({
      type: 'mcp_resource' as const,
      displayText: `${resource.server}:${resource.uri}`,
      description: truncateDescription(
        resource.description || resource.name || resource.uri,
      ),
      server: resource.server,
      uri: resource.uri,
      name: resource.name || resource.uri,
    }))

  // ── 无 query 场景：按固定顺序取前 15 条，不进行评分 ─────────────────────
  if (!query) {
    const allSources = [...fileSources, ...mcpSources, ...agentSources]
    return allSources
      .slice(0, MAX_UNIFIED_SUGGESTIONS)
      .map(createSuggestionFromSource)
  }

  // ── 有 query 场景：混合评分后统一排序 ────────────────────────────────────
  const nonFileSources: SuggestionSource[] = [...mcpSources, ...agentSources]

  // 评分结果：score 越小越好（与 nucleo 对齐）
  type ScoredSource = { source: SuggestionSource; score: number }
  const scoredResults: ScoredSource[] = []

  // 文件来源使用 nucleo 评分（已内置在 fileSuggestions 的 metadata 中）
  for (const fileSource of fileSources) {
    scoredResults.push({
      source: fileSource,
      score: fileSource.score ?? 0.5, // 缺失评分时默认取中间值
    })
  }

  // 非文件来源使用 Fuse.js 进行模糊评分
  if (nonFileSources.length > 0) {
    const fuse = new Fuse(nonFileSources, {
      includeScore: true,
      threshold: 0.6, // 允许较宽松的匹配，后续靠 score 排序过滤
      keys: [
        { name: 'displayText', weight: 2 },  // 显示文本权重较高
        { name: 'name', weight: 3 },          // 名称权重最高
        { name: 'server', weight: 1 },        // Server 名称权重最低
        { name: 'description', weight: 1 },   // 描述权重最低
        { name: 'agentType', weight: 3 },     // Agent 类型权重最高
      ],
    })

    const fuseResults = fuse.search(query, { limit: MAX_UNIFIED_SUGGESTIONS })
    for (const result of fuseResults) {
      scoredResults.push({
        source: result.item,
        score: result.score ?? 0.5,  // Fuse.js 也是 0-1，越小越好
      })
    }
  }

  // 按 score 升序排序（score 越小 = 匹配越好，排在越前面）
  scoredResults.sort((a, b) => a.score - b.score)

  // 取前 15 条，转换为 SuggestionItem 格式返回
  return scoredResults
    .slice(0, MAX_UNIFIED_SUGGESTIONS)
    .map(r => r.source)
    .map(createSuggestionFromSource)
}
