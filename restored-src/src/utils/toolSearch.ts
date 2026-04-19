/**
 * 工具搜索（Tool Search）核心工具模块
 *
 * 在 Claude Code 系统流程中的位置：
 * 本模块是工具动态加载机制的控制中枢，位于 API 请求构建层与 MCP 工具管理层之间。
 * 每次 API 请求前，系统会调用 isToolSearchEnabled() 决定是否将 MCP 工具及
 * shouldDefer 工具以"延迟加载"（defer_loading: true）方式发送，而非全量内联。
 *
 * 主要功能：
 * - 根据环境变量 ENABLE_TOOL_SEARCH 与 GrowthBook 特性标志确定工具搜索模式
 * - 支持三种模式：'tst'（始终延迟）、'tst-auto'（超过阈值才延迟）、'standard'（全量内联）
 * - 通过 token 数量（或字符数回退）判断是否超过自动启用阈值
 * - 从历史消息中提取已发现的 tool_reference 工具名，供后续 API 请求使用
 * - 维护"延迟工具池变更差异"（DeferredToolsDelta）用于渐进式广播
 */

import memoize from 'lodash-es/memoize.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../services/analytics/index.js'
import type { Tool } from '../Tool.js'
import {
  type ToolPermissionContext,
  type Tools,
  toolMatchesName,
} from '../Tool.js'
import type { AgentDefinition } from '../tools/AgentTool/loadAgentsDir.js'
import {
  formatDeferredToolLine,
  isDeferredTool,
  TOOL_SEARCH_TOOL_NAME,
} from '../tools/ToolSearchTool/prompt.js'
import type { Message } from '../types/message.js'
import {
  countToolDefinitionTokens,
  TOOL_TOKEN_COUNT_OVERHEAD,
} from './analyzeContext.js'
import { count } from './array.js'
import { getMergedBetas } from './betas.js'
import { getContextWindowForModel } from './context.js'
import { logForDebugging } from './debug.js'
import { isEnvDefinedFalsy, isEnvTruthy } from './envUtils.js'
import {
  getAPIProvider,
  isFirstPartyAnthropicBaseUrl,
} from './model/providers.js'
import { jsonStringify } from './slowOperations.js'
import { zodToJsonSchema } from './zodToJsonSchema.js'

/**
 * 自动启用工具搜索的默认上下文窗口占比（百分比）。
 * 当 MCP 工具描述的 token 数量超过上下文窗口的此百分比时，自动开启工具搜索。
 * 可通过 ENABLE_TOOL_SEARCH=auto:N 覆盖（N 为 0-100 的整数）。
 */
const DEFAULT_AUTO_TOOL_SEARCH_PERCENTAGE = 10 // 默认 10%

/**
 * 解析 ENABLE_TOOL_SEARCH 环境变量中的 auto:N 语法。
 *
 * 流程：
 * 1. 检查字符串是否以 "auto:" 开头
 * 2. 解析后缀数字，非法时打印调试日志并返回 null
 * 3. 将结果钳制到 [0, 100] 区间后返回
 *
 * @param value ENABLE_TOOL_SEARCH 环境变量的字符串值
 * @returns 合法范围内的百分比数字，或 null（非 auto:N 格式/无效数字）
 */
function parseAutoPercentage(value: string): number | null {
  // 仅处理以 "auto:" 开头的格式
  if (!value.startsWith('auto:')) return null

  // 截取冒号后的数字部分
  const percentStr = value.slice(5)
  const percent = parseInt(percentStr, 10)

  // 数字无效时输出调试日志
  if (isNaN(percent)) {
    logForDebugging(
      `Invalid ENABLE_TOOL_SEARCH value "${value}": expected auto:N where N is a number.`,
    )
    return null
  }

  // 钳制到合法范围 [0, 100]
  return Math.max(0, Math.min(100, percent))
}

/**
 * 检查 ENABLE_TOOL_SEARCH 是否设置为自动模式（"auto" 或 "auto:N"）。
 *
 * @param value 环境变量字符串，可为 undefined
 * @returns 是否为自动模式
 */
function isAutoToolSearchMode(value: string | undefined): boolean {
  if (!value) return false
  // "auto" 或 "auto:N" 均为自动模式
  return value === 'auto' || value.startsWith('auto:')
}

/**
 * 从环境变量或默认值中获取自动启用工具搜索的百分比阈值。
 *
 * 流程：
 * 1. 若未设置环境变量，返回默认值 10
 * 2. 若值为 "auto"，返回默认值 10
 * 3. 尝试解析 "auto:N" 格式，成功则返回解析值
 * 4. 其他情况均返回默认值
 *
 * @returns 百分比数字（0-100）
 */
function getAutoToolSearchPercentage(): number {
  const value = process.env.ENABLE_TOOL_SEARCH
  if (!value) return DEFAULT_AUTO_TOOL_SEARCH_PERCENTAGE

  // 纯 "auto" 时使用默认百分比
  if (value === 'auto') return DEFAULT_AUTO_TOOL_SEARCH_PERCENTAGE

  // 尝试解析 "auto:N" 格式
  const parsed = parseAutoPercentage(value)
  if (parsed !== null) return parsed

  // 兜底返回默认值
  return DEFAULT_AUTO_TOOL_SEARCH_PERCENTAGE
}

/**
 * 字符数与 token 数的近似换算比例（MCP 工具名+描述+输入 schema）。
 * 在 token 计数 API 不可用时作为字符数回退启发式估算。
 */
const CHARS_PER_TOKEN = 2.5

/**
 * 获取指定模型的自动启用工具搜索 token 阈值。
 *
 * 流程：合并模型 beta → 查询上下文窗口大小 → 乘以百分比 → 向下取整
 *
 * @param model 模型名称
 * @returns token 数阈值
 */
function getAutoToolSearchTokenThreshold(model: string): number {
  const betas = getMergedBetas(model)
  const contextWindow = getContextWindowForModel(model, betas)
  const percentage = getAutoToolSearchPercentage() / 100
  return Math.floor(contextWindow * percentage)
}

/**
 * 获取指定模型的自动启用工具搜索字符数阈值（token API 不可用时的回退）。
 *
 * @param model 模型名称
 * @returns 字符数阈值
 */
export function getAutoToolSearchCharThreshold(model: string): number {
  // 将 token 阈值换算为字符数
  return Math.floor(getAutoToolSearchTokenThreshold(model) * CHARS_PER_TOKEN)
}

/**
 * 通过 token 计数 API 获取所有延迟工具的总 token 数量。
 * 以延迟工具名称列表为 memoize 键，MCP 服务器连接/断开时缓存失效。
 * API 不可用时返回 null，调用方应回退到字符数启发式估算。
 *
 * 流程：
 * 1. 过滤出所有延迟工具
 * 2. 无延迟工具时直接返回 0
 * 3. 调用 countToolDefinitionTokens() 计算总 token 数
 * 4. API 返回 0 视为不可用，返回 null
 * 5. 减去固定开销后返回（最小为 0）
 */
const getDeferredToolTokenCount = memoize(
  async (
    tools: Tools,
    getToolPermissionContext: () => Promise<ToolPermissionContext>,
    agents: AgentDefinition[],
    model: string,
  ): Promise<number | null> => {
    // 仅统计被标记为延迟加载的工具
    const deferredTools = tools.filter(t => isDeferredTool(t))
    if (deferredTools.length === 0) return 0

    try {
      const total = await countToolDefinitionTokens(
        deferredTools,
        getToolPermissionContext,
        { activeAgents: agents, allAgents: agents },
        model,
      )
      // API 返回 0 表示不可用，退化为字符数估算
      if (total === 0) return null
      // 减去固定的工具定义开销，结果不小于 0
      return Math.max(0, total - TOOL_TOKEN_COUNT_OVERHEAD)
    } catch {
      // 任何异常均视为 API 不可用
      return null
    }
  },
  // memoize 键：以延迟工具名称逗号拼接字符串
  (tools: Tools) =>
    tools
      .filter(t => isDeferredTool(t))
      .map(t => t.name)
      .join(','),
)

/**
 * 工具搜索模式类型。决定可延迟工具（MCP + shouldDefer）的暴露方式：
 *   - 'tst'      : 始终延迟 — 所有延迟工具通过 ToolSearchTool 动态发现
 *   - 'tst-auto' : 自动延迟 — 延迟工具描述超过阈值时才开启
 *   - 'standard' : 关闭工具搜索 — 所有工具内联在请求中
 */
export type ToolSearchMode = 'tst' | 'tst-auto' | 'standard'

/**
 * 根据 ENABLE_TOOL_SEARCH 环境变量确定工具搜索模式。
 *
 * 映射关系：
 *   ENABLE_TOOL_SEARCH    模式
 *   auto / auto:1-99      tst-auto
 *   true / auto:0         tst
 *   false / auto:100      standard
 *   （未设置）             tst（默认始终延迟 MCP 和 shouldDefer 工具）
 *
 * 流程：
 * 1. 若设置了 CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS 终止开关，强制返回 'standard'
 * 2. 解析 auto:N 边界情况：auto:0 → 'tst'，auto:100 → 'standard'
 * 3. 检测 auto 或 auto:N 模式返回 'tst-auto'
 * 4. 明确为真值 → 'tst'，明确为假值 → 'standard'
 * 5. 未设置时默认 'tst'
 *
 * @returns 当前应使用的工具搜索模式
 */
export function getToolSearchMode(): ToolSearchMode {
  // 实验性 beta 特性总开关：proxy 网关不支持 beta 形状时使用此终止开关
  if (isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS)) {
    return 'standard'
  }

  const value = process.env.ENABLE_TOOL_SEARCH

  // 处理 auto:N 的边界情况
  const autoPercent = value ? parseAutoPercentage(value) : null
  if (autoPercent === 0) return 'tst'       // auto:0 = 始终启用
  if (autoPercent === 100) return 'standard' // auto:100 = 始终关闭
  if (isAutoToolSearchMode(value)) {
    return 'tst-auto' // auto 或 auto:1-99
  }

  // 显式真值 → tst
  if (isEnvTruthy(value)) return 'tst'
  // 显式假值 → standard
  if (isEnvDefinedFalsy(process.env.ENABLE_TOOL_SEARCH)) return 'standard'
  // 未设置时默认始终延迟
  return 'tst'
}

/**
 * 默认不支持 tool_reference 的模型名称模式列表。
 * 新模型默认假定支持 tool_reference，仅列出此处的模型为不支持。
 */
const DEFAULT_UNSUPPORTED_MODEL_PATTERNS = ['haiku']

/**
 * 获取不支持 tool_reference 的模型名称模式列表。
 * 优先从 GrowthBook 特性 'tengu_tool_search_unsupported_models' 读取，
 * 以便无需代码变更即可热更新，读取失败时回退到硬编码默认值。
 *
 * @returns 模型名称模式字符串数组
 */
function getUnsupportedToolReferencePatterns(): string[] {
  try {
    // 从 GrowthBook 获取实时配置
    const patterns = getFeatureValue_CACHED_MAY_BE_STALE<string[] | null>(
      'tengu_tool_search_unsupported_models',
      null,
    )
    // 非空数组时使用远程配置
    if (patterns && Array.isArray(patterns) && patterns.length > 0) {
      return patterns
    }
  } catch {
    // GrowthBook 未就绪，使用默认值
  }
  return DEFAULT_UNSUPPORTED_MODEL_PATTERNS
}

/**
 * 检查指定模型是否支持 tool_reference 内容块（工具搜索的必要条件）。
 *
 * 采用反向判断：新模型默认假定支持，除非明确列在不支持名单中。
 * 目前 Haiku 系列不支持 tool_reference，可通过 GrowthBook 更新。
 *
 * 流程：
 * 1. 将模型名转为小写
 * 2. 遍历不支持模式列表，任意模式匹配则返回 false
 * 3. 未匹配到任何模式则返回 true
 *
 * @param model 模型名称
 * @returns 是否支持 tool_reference
 */
export function modelSupportsToolReference(model: string): boolean {
  const normalizedModel = model.toLowerCase()
  const unsupportedPatterns = getUnsupportedToolReferencePatterns()

  // 逐一检查不支持模式
  for (const pattern of unsupportedPatterns) {
    if (normalizedModel.includes(pattern.toLowerCase())) {
      return false // 匹配到不支持模式
    }
  }

  // 未匹配任何不支持模式，默认支持
  return true
}

/**
 * 乐观检查：工具搜索是否"可能"开启。
 *
 * 不检查动态因素（模型支持、阈值），仅确认工具搜索是否在配置上允许。
 * 用于：
 * - 在工具列表中包含 ToolSearchTool（供后续按需使用）
 * - 保留消息中的 tool_reference 字段（后续可再过滤）
 * - ToolSearchTool 自报是否已启用
 *
 * 当且仅当模式为 'standard' 时返回 false。
 * 完整检查（含模型支持和阈值）请使用 isToolSearchEnabled()。
 *
 * 流程：
 * 1. 若模式为 'standard' → false（记录日志一次）
 * 2. 若使用第三方 API 代理且未显式配置 ENABLE_TOOL_SEARCH → false（代理通常不支持 tool_reference）
 * 3. 其他情况 → true
 */
let loggedOptimistic = false // 防止重复打印同一条调试日志

export function isToolSearchEnabledOptimistic(): boolean {
  const mode = getToolSearchMode()
  if (mode === 'standard') {
    // 仅记录一次，避免日志洪泛
    if (!loggedOptimistic) {
      loggedOptimistic = true
      logForDebugging(
        `[ToolSearch:optimistic] mode=${mode}, ENABLE_TOOL_SEARCH=${process.env.ENABLE_TOOL_SEARCH}, result=false`,
      )
    }
    return false
  }

  // tool_reference 是 beta 内容类型，第三方代理通常不支持。
  // 当使用非官方 Anthropic 端点且未显式配置时，默认禁用以避免 400 错误。
  // 若用户显式设置了 ENABLE_TOOL_SEARCH，则视为用户确认代理支持该特性。
  if (
    !process.env.ENABLE_TOOL_SEARCH &&
    getAPIProvider() === 'firstParty' &&
    !isFirstPartyAnthropicBaseUrl()
  ) {
    if (!loggedOptimistic) {
      loggedOptimistic = true
      logForDebugging(
        `[ToolSearch:optimistic] disabled: ANTHROPIC_BASE_URL=${process.env.ANTHROPIC_BASE_URL} is not a first-party Anthropic host. Set ENABLE_TOOL_SEARCH=true (or auto / auto:N) if your proxy forwards tool_reference blocks.`,
      )
    }
    return false
  }

  // 模式非 standard 且端点合法，乐观判断为已启用
  if (!loggedOptimistic) {
    loggedOptimistic = true
    logForDebugging(
      `[ToolSearch:optimistic] mode=${mode}, ENABLE_TOOL_SEARCH=${process.env.ENABLE_TOOL_SEARCH}, result=true`,
    )
  }
  return true
}

/**
 * 检查 ToolSearchTool 是否在工具列表中可用。
 * 若通过 disallowedTools 禁用了 ToolSearchTool，则工具搜索无法正常运行。
 *
 * @param tools 工具数组（含 name 属性）
 * @returns ToolSearchTool 是否存在于列表中
 */
export function isToolSearchToolAvailable(
  tools: readonly { name: string }[],
): boolean {
  return tools.some(tool => toolMatchesName(tool, TOOL_SEARCH_TOOL_NAME))
}

/**
 * 计算所有延迟工具描述的总字符数（名称 + 描述 + 输入 schema）。
 * 字符数与 token 数近似等比，用于 token API 不可用时的字符数回退阈值判断。
 *
 * 流程：
 * 1. 过滤出延迟工具，无则返回 0
 * 2. 并发获取每个工具的描述文本
 * 3. 将 inputJSONSchema/inputSchema 序列化为 JSON 字符串
 * 4. 对每个工具累加名称长度 + 描述长度 + schema 字符长度
 * 5. 返回总和
 *
 * @param tools 工具列表
 * @param getToolPermissionContext 工具权限上下文获取函数
 * @param agents 代理定义列表
 * @returns 总字符数
 */
async function calculateDeferredToolDescriptionChars(
  tools: Tools,
  getToolPermissionContext: () => Promise<ToolPermissionContext>,
  agents: AgentDefinition[],
): Promise<number> {
  const deferredTools = tools.filter(t => isDeferredTool(t))
  if (deferredTools.length === 0) return 0

  // 并发计算每个工具的描述字符数
  const sizes = await Promise.all(
    deferredTools.map(async tool => {
      // 获取工具描述文本
      const description = await tool.prompt({
        getToolPermissionContext,
        tools,
        agents,
      })
      // 序列化工具输入 schema 为 JSON 字符串（优先 inputJSONSchema，其次 inputSchema）
      const inputSchema = tool.inputJSONSchema
        ? jsonStringify(tool.inputJSONSchema)
        : tool.inputSchema
          ? jsonStringify(zodToJsonSchema(tool.inputSchema))
          : ''
      // 名称 + 描述 + schema 的字符总数
      return tool.name.length + description.length + inputSchema.length
    }),
  )

  // 汇总所有工具的字符数
  return sizes.reduce((total, size) => total + size, 0)
}

/**
 * 针对具体请求的工具搜索启用状态的最终判定（含所有动态因素）。
 *
 * 此函数是最权威的判定入口，涵盖：
 * - 模型兼容性（Haiku 不支持 tool_reference）
 * - ToolSearchTool 可用性（是否被 disallowedTools 排除）
 * - tst-auto 模式下的阈值检查
 *
 * 流程：
 * 1. 检查模型是否支持 tool_reference，不支持则返回 false
 * 2. 检查 ToolSearchTool 是否在工具列表中，不存在则返回 false
 * 3. 按模式分支：
 *    - 'tst' → 始终返回 true
 *    - 'tst-auto' → 检查阈值，超过则返回 true，否则 false
 *    - 'standard' → 始终返回 false
 * 4. 每次决策都向分析服务上报 tengu_tool_search_mode_decision 事件
 *
 * @param model 当前使用的模型名称
 * @param tools 当前可用工具列表（含 MCP 工具）
 * @param getToolPermissionContext 工具权限上下文获取函数
 * @param agents 代理定义列表
 * @param source 可选的调用来源标识（用于调试日志）
 * @returns 是否应在本次请求中启用工具搜索
 */
export async function isToolSearchEnabled(
  model: string,
  tools: Tools,
  getToolPermissionContext: () => Promise<ToolPermissionContext>,
  agents: AgentDefinition[],
  source?: string,
): Promise<boolean> {
  // 统计当前可用的 MCP 工具数量（用于上报分析事件）
  const mcpToolCount = count(tools, t => t.isMcp)

  /**
   * 上报工具搜索模式决策事件到分析服务。
   * 包含启用状态、模式、原因及相关度量指标。
   */
  function logModeDecision(
    enabled: boolean,
    mode: ToolSearchMode,
    reason: string,
    extraProps?: Record<string, number>,
  ): void {
    logEvent('tengu_tool_search_mode_decision', {
      enabled,
      mode: mode as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      reason:
        reason as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      // 记录实际被检查的模型名（子代理与主会话模型可能不同）
      checkedModel:
        model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      mcpToolCount,
      userType: (process.env.USER_TYPE ??
        'external') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      ...extraProps,
    })
  }

  // 检查模型是否支持 tool_reference（Haiku 等旧模型不支持）
  if (!modelSupportsToolReference(model)) {
    logForDebugging(
      `Tool search disabled for model '${model}': model does not support tool_reference blocks. ` +
        `This feature is only available on Claude Sonnet 4+, Opus 4+, and newer models.`,
    )
    logModeDecision(false, 'standard', 'model_unsupported')
    return false
  }

  // 检查 ToolSearchTool 是否可用（可能被 disallowedTools 排除）
  if (!isToolSearchToolAvailable(tools)) {
    logForDebugging(
      `Tool search disabled: ToolSearchTool is not available (may have been disallowed via disallowedTools).`,
    )
    logModeDecision(false, 'standard', 'mcp_search_unavailable')
    return false
  }

  const mode = getToolSearchMode()

  switch (mode) {
    case 'tst':
      // 始终启用模式：直接返回 true
      logModeDecision(true, mode, 'tst_enabled')
      return true

    case 'tst-auto': {
      // 自动模式：检查延迟工具描述是否超过阈值
      const { enabled, debugDescription, metrics } = await checkAutoThreshold(
        tools,
        getToolPermissionContext,
        agents,
        model,
      )

      if (enabled) {
        logForDebugging(
          `Auto tool search enabled: ${debugDescription}` +
            (source ? ` [source: ${source}]` : ''),
        )
        logModeDecision(true, mode, 'auto_above_threshold', metrics)
        return true
      }

      logForDebugging(
        `Auto tool search disabled: ${debugDescription}` +
          (source ? ` [source: ${source}]` : ''),
      )
      logModeDecision(false, mode, 'auto_below_threshold', metrics)
      return false
    }

    case 'standard':
      // 标准模式：始终关闭工具搜索
      logModeDecision(false, mode, 'standard_mode')
      return false
  }
}

/**
 * 检查对象是否为 tool_reference 内容块。
 * tool_reference 是 beta 特性，不在 SDK 类型中，因此需要运行时类型守卫。
 *
 * @param obj 任意对象
 * @returns 是否为 tool_reference 内容块
 */
export function isToolReferenceBlock(obj: unknown): boolean {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    'type' in obj &&
    (obj as { type: unknown }).type === 'tool_reference'
  )
}

/**
 * 带 tool_name 字段的 tool_reference 块类型守卫。
 *
 * @param obj 任意对象
 * @returns 是否为含 tool_name 的 tool_reference 块
 */
function isToolReferenceWithName(
  obj: unknown,
): obj is { type: 'tool_reference'; tool_name: string } {
  return (
    isToolReferenceBlock(obj) &&
    'tool_name' in (obj as object) &&
    typeof (obj as { tool_name: unknown }).tool_name === 'string'
  )
}

/**
 * 含数组 content 的 tool_result 内容块类型。
 * 用于从 ToolSearchTool 结果中提取 tool_reference 块。
 */
type ToolResultBlock = {
  type: 'tool_result'
  content: unknown[]
}

/**
 * 含数组 content 的 tool_result 块类型守卫。
 *
 * @param obj 任意对象
 * @returns 是否为含数组 content 的 tool_result 块
 */
function isToolResultBlockWithContent(obj: unknown): obj is ToolResultBlock {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    'type' in obj &&
    (obj as { type: unknown }).type === 'tool_result' &&
    'content' in obj &&
    Array.isArray((obj as { content: unknown }).content)
  )
}

/**
 * 从历史消息中提取所有已被 tool_reference 块引用的工具名称集合。
 *
 * 背景：
 * 动态工具加载开启时，MCP 工具不在 tools 数组中预声明，而是通过 ToolSearchTool
 * 返回的 tool_reference 块动态发现。此函数扫描历史消息，找出所有已被引用的工具名，
 * 以便在后续 API 请求中仅包含这些工具的完整定义。
 *
 * 压缩（compaction）会将含 tool_reference 的消息替换为摘要，
 * 并将已发现工具集快照写入 compactMetadata.preCompactDiscoveredTools，
 * 本函数同时负责读取该快照。
 *
 * 流程：
 * 1. 遍历所有消息
 * 2. 若为 compact_boundary 系统消息，读取 preCompactDiscoveredTools 并合并
 * 3. 仅处理 user 类型消息的 content 数组
 * 4. 在 tool_result 块的 content 中查找 tool_reference 块
 * 5. 提取 tool_name 字段加入结果集
 *
 * @param messages 可能含 tool_result+tool_reference 的消息数组
 * @returns 已发现工具名称的 Set
 */
export function extractDiscoveredToolNames(messages: Message[]): Set<string> {
  const discoveredTools = new Set<string>()
  let carriedFromBoundary = 0 // 来自压缩边界快照的工具数量（用于调试日志）

  for (const msg of messages) {
    // compact_boundary 系统消息携带压缩前已发现的工具集快照
    if (msg.type === 'system' && msg.subtype === 'compact_boundary') {
      const carried = msg.compactMetadata?.preCompactDiscoveredTools
      if (carried) {
        for (const name of carried) discoveredTools.add(name)
        carriedFromBoundary += carried.length
      }
      continue
    }

    // tool_result 仅出现在 user 消息中（tool_use 的响应）
    if (msg.type !== 'user') continue

    const content = msg.message?.content
    if (!Array.isArray(content)) continue

    for (const block of content) {
      // tool_reference 块仅出现在 ToolSearchTool 结果的 content 中
      if (isToolResultBlockWithContent(block)) {
        for (const item of block.content) {
          if (isToolReferenceWithName(item)) {
            discoveredTools.add(item.tool_name) // 记录已发现的工具名
          }
        }
      }
    }
  }

  // 有发现工具时输出调试日志
  if (discoveredTools.size > 0) {
    logForDebugging(
      `Dynamic tool loading: found ${discoveredTools.size} discovered tools in message history` +
        (carriedFromBoundary > 0
          ? ` (${carriedFromBoundary} carried from compact boundary)`
          : ''),
    )
  }

  return discoveredTools
}

/**
 * 延迟工具池变更差异类型。
 * 描述自上次广播以来新增/移除的延迟工具。
 */
export type DeferredToolsDelta = {
  addedNames: string[]
  /** 已新增工具的渲染行文本列表，由扫描时从工具名重建。 */
  addedLines: string[]
  removedNames: string[]
}

/**
 * getDeferredToolsDelta 调用来源标识，用于区分不同扫描场景。
 * 解决 inc-4747 中 prior=0 统计被多种预期情况污染的问题：
 *   - attachments_main    : 主线程 getAttachments，fire-2+ 出现 prior=0 为 BUG
 *   - attachments_subagent: 子代理 getAttachments，prior=0 是预期（全新会话）
 *   - compact_full        : compact.ts 传入空消息，prior=0 是预期
 *   - compact_partial     : compact.ts 传入保留消息，视内容而定
 *   - reactive_compact    : reactiveCompact.ts 传入保留消息，同上
 */
export type DeferredToolsDeltaScanContext = {
  callSite:
    | 'attachments_main'
    | 'attachments_subagent'
    | 'compact_full'
    | 'compact_partial'
    | 'reactive_compact'
  querySource?: string
}

/**
 * 判断延迟工具差异广播功能是否启用。
 * 启用时通过持久化差异附件广播延迟工具变更；
 * 禁用时 claude.ts 使用每次调用的 <available-deferred-tools> 头部预置。
 *
 * @returns 是否启用差异广播
 */
export function isDeferredToolsDeltaEnabled(): boolean {
  return (
    // Anthropic 内部用户始终启用
    process.env.USER_TYPE === 'ant' ||
    // GrowthBook 特性标志
    getFeatureValue_CACHED_MAY_BE_STALE('tengu_glacier_2xr', false)
  )
}

/**
 * 计算当前延迟工具池与已广播集合之间的差异（新增/移除）。
 * 通过扫描历史消息中的 deferred_tools_delta 附件重建已广播集合。
 * 若无变更则返回 null。
 *
 * 注意：已广播但当前不再延迟（却仍在工具池中）的工具不计入移除，
 * 因为它们已转为直接加载，不应告知模型"不再可用"。
 *
 * 流程：
 * 1. 扫描消息中所有 deferred_tools_delta 附件，重建 announced 集合
 * 2. 计算当前延迟工具池与 announced 的差集（新增）
 * 3. 计算 announced 中不再存在于工具池的项（移除）
 * 4. 无变更返回 null，否则返回新增/移除的名称和渲染行
 *
 * @param tools 当前工具列表
 * @param messages 历史消息列表（含 attachment 类型）
 * @param scanContext 调用来源上下文（用于分析事件分类）
 * @returns 工具变更差异，或 null（无变更）
 */
export function getDeferredToolsDelta(
  tools: Tools,
  messages: Message[],
  scanContext?: DeferredToolsDeltaScanContext,
): DeferredToolsDelta | null {
  const announced = new Set<string>() // 已广播过的工具名集合
  let attachmentCount = 0             // 总附件数（用于分析）
  let dtdCount = 0                    // deferred_tools_delta 附件数
  const attachmentTypesSeen = new Set<string>() // 出现过的附件类型

  // 扫描历史消息中的所有 deferred_tools_delta 附件
  for (const msg of messages) {
    if (msg.type !== 'attachment') continue
    attachmentCount++
    attachmentTypesSeen.add(msg.attachment.type)
    if (msg.attachment.type !== 'deferred_tools_delta') continue
    dtdCount++
    // 合并 added（累加到已知集合）
    for (const n of msg.attachment.addedNames) announced.add(n)
    // 应用 removed（从已知集合中删除）
    for (const n of msg.attachment.removedNames) announced.delete(n)
  }

  const deferred: Tool[] = tools.filter(isDeferredTool)
  const deferredNames = new Set(deferred.map(t => t.name)) // 当前延迟工具名集合
  const poolNames = new Set(tools.map(t => t.name))        // 全量工具名集合

  // 新增：当前延迟但尚未广播的工具
  const added = deferred.filter(t => !announced.has(t.name))

  // 移除：已广播但已从工具池完全消失的工具（不包括"已取消延迟但仍在池中"的情况）
  const removed: string[] = []
  for (const n of announced) {
    if (deferredNames.has(n)) continue    // 仍在延迟池，不移除
    if (!poolNames.has(n)) removed.push(n) // 已从工具池消失，标记移除
    // 已取消延迟但仍在池中：静默处理（不广播移除）
  }

  // 无变更时返回 null
  if (added.length === 0 && removed.length === 0) return null

  // 上报池变更分析事件，包含来源上下文以便在 BigQuery 中分类
  logEvent('tengu_deferred_tools_pool_change', {
    addedCount: added.length,
    removedCount: removed.length,
    priorAnnouncedCount: announced.size,
    messagesLength: messages.length,
    attachmentCount,
    dtdCount,
    callSite: (scanContext?.callSite ??
      'unknown') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    querySource: (scanContext?.querySource ??
      'unknown') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    attachmentTypesSeen: [...attachmentTypesSeen]
      .sort()
      .join(',') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  })

  return {
    addedNames: added.map(t => t.name).sort(),       // 按名称排序
    addedLines: added.map(formatDeferredToolLine).sort(), // 渲染行文本
    removedNames: removed.sort(),
  }
}

/**
 * 检查延迟工具是否超过自动启用 TST 的阈值。
 * 优先使用精确 token 计数；token API 不可用时回退到字符数启发式估算。
 *
 * 流程：
 * 1. 调用 getDeferredToolTokenCount() 获取精确 token 数
 * 2. 若返回非 null：与 token 阈值比较，生成调试描述
 * 3. 若返回 null（API 不可用）：计算字符数并与字符阈值比较
 *
 * @param tools 工具列表
 * @param getToolPermissionContext 工具权限上下文获取函数
 * @param agents 代理定义列表
 * @param model 模型名称
 * @returns 是否启用、调试描述字符串、度量指标对象
 */
async function checkAutoThreshold(
  tools: Tools,
  getToolPermissionContext: () => Promise<ToolPermissionContext>,
  agents: AgentDefinition[],
  model: string,
): Promise<{
  enabled: boolean
  debugDescription: string
  metrics: Record<string, number>
}> {
  // 优先使用精确 token 计数（结果有缓存，工具集变更时失效）
  const deferredToolTokens = await getDeferredToolTokenCount(
    tools,
    getToolPermissionContext,
    agents,
    model,
  )

  if (deferredToolTokens !== null) {
    // token API 可用，与 token 阈值比较
    const threshold = getAutoToolSearchTokenThreshold(model)
    return {
      enabled: deferredToolTokens >= threshold,
      debugDescription:
        `${deferredToolTokens} tokens (threshold: ${threshold}, ` +
        `${getAutoToolSearchPercentage()}% of context)`,
      metrics: { deferredToolTokens, threshold },
    }
  }

  // 回退：token API 不可用，使用字符数启发式估算
  const deferredToolDescriptionChars =
    await calculateDeferredToolDescriptionChars(
      tools,
      getToolPermissionContext,
      agents,
    )
  const charThreshold = getAutoToolSearchCharThreshold(model)
  return {
    enabled: deferredToolDescriptionChars >= charThreshold,
    debugDescription:
      `${deferredToolDescriptionChars} chars (threshold: ${charThreshold}, ` +
      `${getAutoToolSearchPercentage()}% of context) (char fallback)`,
    metrics: { deferredToolDescriptionChars, charThreshold },
  }
}
