/**
 * Slack 频道建议模块
 *
 * 在 Claude Code 系统流程中的位置：
 * 该模块属于提示输入（PromptInput）UI 层的自动补全子系统。
 * 当用户在提示框中输入以 "#" 开头的词元时，UI 层会调用本模块
 * 通过已连接的 Slack MCP 服务器查询匹配的频道名称，
 * 并以下拉建议形式展示，同时在文本中高亮显示已确认存在的频道。
 *
 * 核心设计决策：
 * 1. 使用普通 Map（而非 LRUCache）作为查询缓存，以便遍历所有条目做前缀复用。
 * 2. 智能查询策略（mcpQueryFor）：去掉尾部不完整词段，避免 Slack 分词失败。
 *    例如：用户输入 "claude-code-team-en" → MCP 查询 "claude-code-team"，
 *    本地再过滤 "en" 前缀，兼顾精确性与召回率。
 * 3. 缓存前缀复用（findReusableCacheEntry）：输入 "c"→"cl"→"cla" 时
 *    复用 "c" 对应的缓存，避免每次击键都发 MCP 请求。
 * 4. 飞行中请求去重：相同查询并发时共享同一个 Promise。
 * 5. knownChannels 集合：记录所有曾返回的频道名，供文本高亮使用。
 *
 * 主要导出：
 * - getSlackChannelSuggestions：主入口，获取建议列表
 * - findSlackChannelPositions：在文本中定位已知频道的位置（用于高亮）
 * - hasSlackMcpServer：检测是否有 Slack MCP 服务器连接
 * - subscribeKnownChannels：订阅 knownChannels 变更事件
 * - clearSlackChannelCache：清空所有缓存
 */

import { z } from 'zod'
import type { SuggestionItem } from '../../components/PromptInput/PromptInputFooterSuggestions.js'
import type { MCPServerConnection } from '../../services/mcp/types.js'
import { logForDebugging } from '../debug.js'
import { lazySchema } from '../lazySchema.js'
import { createSignal } from '../signal.js'
import { jsonParse } from '../slowOperations.js'

// Slack MCP 工具名称
const SLACK_SEARCH_TOOL = 'slack_search_channels'

// ─── 模块级状态 ───────────────────────────────────────────────────────────────

// 查询缓存：Map 而非 LRUCache，因为需要遍历所有条目做前缀复用匹配
// 键为 mcpQuery（去掉尾部不完整词段后的查询串），值为频道名列表
const cache = new Map<string, string[]>()

// 所有曾经返回过的频道名集合，用于文本高亮（蓝色渲染）
// 只有确认存在的频道才会被高亮
const knownChannels = new Set<string>()

// knownChannels 的版本号，每次新增频道时递增
let knownChannelsVersion = 0

// 当 knownChannels 发生变化时触发的信号（供 UI 订阅重渲染）
const knownChannelsChanged = createSignal()
/** 订阅 knownChannels 变更事件，返回取消订阅函数 */
export const subscribeKnownChannels = knownChannelsChanged.subscribe

// 飞行中（inflight）的请求去重：记录当前正在进行的 MCP 查询及其 Promise
let inflightQuery: string | null = null
let inflightPromise: Promise<string[]> | null = null

// ─── 内部工具函数 ─────────────────────────────────────────────────────────────

/**
 * 在 MCP 连接列表中查找 Slack 客户端。
 * 匹配条件：连接类型为 'connected' 且名称中包含 'slack'。
 */
function findSlackClient(
  clients: MCPServerConnection[],
): MCPServerConnection | undefined {
  return clients.find(c => c.type === 'connected' && c.name.includes('slack'))
}

/**
 * 通过 Slack MCP 服务器查询频道列表。
 *
 * 流程：
 * 1. 找到已连接的 Slack MCP 客户端，若无则返回空数组。
 * 2. 调用 slack_search_channels 工具，参数含 query、limit=20、
 *    channel_types（公开+私有频道），超时 5 秒。
 * 3. 提取响应中所有 type=text 的内容，合并为字符串。
 * 4. 解包可能的 JSON 信封（unwrapResults），再解析 Markdown 格式的频道列表。
 * 5. 出错时记录日志并返回空数组。
 */
async function fetchChannels(
  clients: MCPServerConnection[],
  query: string,
): Promise<string[]> {
  const slackClient = findSlackClient(clients)
  // 无 Slack 客户端则无法查询
  if (!slackClient || slackClient.type !== 'connected') {
    return []
  }

  try {
    // 调用 MCP 工具，设置 5 秒超时避免阻塞 UI
    const result = await slackClient.client.callTool(
      {
        name: SLACK_SEARCH_TOOL,
        arguments: {
          query,
          limit: 20, // 最多返回 20 个频道（防止超出缓存上限后被截断）
          channel_types: 'public_channel,private_channel',
        },
      },
      undefined,
      { timeout: 5000 },
    )

    const content = result.content
    if (!Array.isArray(content)) return []

    // 提取所有 text 类型的内容块，合并为一个字符串
    const rawText = content
      .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
      .map(c => c.text)
      .join('\n')

    // 先解包 JSON 信封，再解析 Markdown 格式的频道名列表
    return parseChannels(unwrapResults(rawText))
  } catch (error) {
    logForDebugging(`Failed to fetch Slack channels: ${error}`)
    return []
  }
}

// Slack MCP 服务器将 Markdown 内容包裹在 JSON 信封中：
// {"results":"# Search Results...\nName: #chan\n..."}
// 用 lazySchema 延迟创建 Zod schema，避免模块加载时的性能开销
const resultsEnvelopeSchema = lazySchema(() =>
  z.object({ results: z.string() }),
)

/**
 * 解包 Slack MCP 返回的 JSON 信封。
 *
 * 若文本以 "{" 开头，尝试解析为 {results: string} 格式并提取内层内容。
 * 解析失败时直接返回原始文本，保持降级兼容。
 */
function unwrapResults(text: string): string {
  const trimmed = text.trim()
  // 不是 JSON 格式，直接返回原文
  if (!trimmed.startsWith('{')) return text
  try {
    const parsed = resultsEnvelopeSchema().safeParse(jsonParse(trimmed))
    if (parsed.success) return parsed.data.results
  } catch {
    // jsonParse 抛出异常时降级处理
  }
  return text
}

/**
 * 从 slack_search_channels 的 Markdown 文本输出中解析频道名列表。
 *
 * Slack MCP 服务器返回的格式为：
 *   Name: #channel-name
 * 本函数用正则逐行匹配，提取合法频道名（小写字母、数字、连字符、下划线），
 * 同时去重，保证返回列表中无重复条目。
 */
function parseChannels(text: string): string[] {
  const channels: string[] = []
  const seen = new Set<string>()

  for (const line of text.split('\n')) {
    // 匹配 "Name: #channel-name" 格式，"#" 可选
    const m = line.match(/^Name:\s*#?([a-z0-9][a-z0-9_-]{0,79})\s*$/)
    if (m && !seen.has(m[1]!)) {
      seen.add(m[1]!)
      channels.push(m[1]!)
    }
  }

  return channels
}

// ─── 导出工具函数 ─────────────────────────────────────────────────────────────

/**
 * 检查 MCP 连接列表中是否存在 Slack 服务器。
 * UI 层用此函数决定是否显示 Slack 频道补全功能。
 */
export function hasSlackMcpServer(clients: MCPServerConnection[]): boolean {
  return findSlackClient(clients) !== undefined
}

/** 返回当前 knownChannels 的版本号，供外部做变更检测。 */
export function getKnownChannelsVersion(): number {
  return knownChannelsVersion
}

/**
 * 在给定文本中找出所有「已知频道」的位置范围，供 UI 高亮渲染。
 *
 * 匹配规则：以空白或行首为边界的 "#频道名" 模式。
 * 只有在 knownChannels 集合中存在的频道才会返回位置（避免误高亮）。
 *
 * @param text 用户输入的完整文本
 * @returns 所有匹配位置的 {start, end} 数组（含 "#" 符号）
 */
export function findSlackChannelPositions(
  text: string,
): Array<{ start: number; end: number }> {
  const positions: Array<{ start: number; end: number }> = []
  // 匹配 "#频道名"，要求前面是空白或行首，后面是空白或行尾
  const re = /(^|\s)#([a-z0-9][a-z0-9_-]{0,79})(?=\s|$)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    // 仅高亮已确认存在于 knownChannels 中的频道
    if (!knownChannels.has(m[2]!)) continue
    // start 指向 "#" 符号（跳过前置空白 m[1]）
    const start = m.index + m[1]!.length
    positions.push({ start, end: start + 1 + m[2]!.length })
  }
  return positions
}

/**
 * 生成发往 Slack MCP 的查询字符串。
 *
 * 问题背景：Slack 搜索对词语进行分词（以连字符/下划线为边界），
 * 要求每个词必须是完整的词语。若用户输入的尾部词段不完整（如 "-en"），
 * Slack 会返回 0 个结果。
 *
 * 解决方案：去掉 searchToken 中最后一个分隔符（"-" 或 "_"）之后的部分，
 * 仅发送完整词语部分给 MCP，然后在本地再过滤不完整的前缀。
 *
 * 示例：
 *   "claude-code-team-en" → MCP 查询 "claude-code-team"
 *   "claude-code" → MCP 查询 "claude-code"（已完整）
 *   "claude" → MCP 查询 "claude"（无分隔符，原样传递）
 */
function mcpQueryFor(searchToken: string): string {
  const lastSep = Math.max(
    searchToken.lastIndexOf('-'),
    searchToken.lastIndexOf('_'),
  )
  // 有分隔符时截断最后一个词段，无分隔符时原样返回
  return lastSep > 0 ? searchToken.slice(0, lastSep) : searchToken
}

/**
 * 在缓存中查找可复用的条目（前缀匹配策略）。
 *
 * 触发场景：用户从 "c" 逐字输入到 "claude"，
 * mcpQuery 依次为 "c"、"cl"、"cla"…，
 * 若缓存中已有 "c" 的结果，且其中确实有以 searchToken 开头的频道，
 * 则直接复用该结果，避免重复请求 MCP。
 *
 * 策略：在所有可复用条目中选择键最长的（最精确的），
 * 以尽量减少本地过滤的工作量。
 *
 * @param mcpQuery 当前的 MCP 查询串
 * @param searchToken 用户输入的原始搜索词（用于验证复用结果是否有效）
 * @returns 可复用的频道列表，或 undefined（无法复用）
 */
function findReusableCacheEntry(
  mcpQuery: string,
  searchToken: string,
): string[] | undefined {
  let best: string[] | undefined
  let bestLen = 0
  for (const [key, channels] of cache) {
    if (
      // 缓存键是当前 mcpQuery 的前缀
      mcpQuery.startsWith(key) &&
      // 选择最长（最精确）的前缀缓存条目
      key.length > bestLen &&
      // 验证该缓存中确实存在以 searchToken 开头的频道
      channels.some(c => c.startsWith(searchToken))
    ) {
      best = channels
      bestLen = key.length
    }
  }
  return best
}

// ─── 主入口 ───────────────────────────────────────────────────────────────────

/**
 * 获取 Slack 频道补全建议列表。
 *
 * 流程：
 * 1. searchToken 为空时直接返回空数组。
 * 2. 计算 mcpQuery（去掉尾部不完整词段）。
 * 3. 依次查找：缓存命中 → 前缀复用缓存 → 飞行中请求去重 → 发起新 MCP 请求。
 * 4. 新请求完成后写入缓存，更新 knownChannels（并通知订阅者）。
 * 5. 缓存超过 50 条时淘汰最旧的条目（FIFO）。
 * 6. 本地过滤以 lower（小写 searchToken）开头的频道，
 *    排序后取前 10 条，组装为 SuggestionItem 返回。
 *
 * @param clients MCP 服务器连接列表
 * @param searchToken 用户输入的搜索词（不含 "#" 前缀）
 * @returns 建议项列表（displayText 含 "#" 前缀）
 */
export async function getSlackChannelSuggestions(
  clients: MCPServerConnection[],
  searchToken: string,
): Promise<SuggestionItem[]> {
  // 空输入直接返回
  if (!searchToken) return []

  // 生成 MCP 查询串（去掉尾部不完整词段）
  const mcpQuery = mcpQueryFor(searchToken)
  const lower = searchToken.toLowerCase()

  // 第一步：查找缓存（精确命中或前缀复用）
  let channels = cache.get(mcpQuery) ?? findReusableCacheEntry(mcpQuery, lower)
  if (!channels) {
    if (inflightQuery === mcpQuery && inflightPromise) {
      // 第二步：相同查询正在飞行中，等待其 Promise 完成（请求去重）
      channels = await inflightPromise
    } else {
      // 第三步：发起新的 MCP 请求
      inflightQuery = mcpQuery
      inflightPromise = fetchChannels(clients, mcpQuery)
      channels = await inflightPromise
      // 写入缓存
      cache.set(mcpQuery, channels)
      // 更新 knownChannels，若有新频道则触发信号通知 UI 重渲染
      const before = knownChannels.size
      for (const c of channels) knownChannels.add(c)
      if (knownChannels.size !== before) {
        knownChannelsVersion++
        knownChannelsChanged.emit()
      }
      // 缓存超 50 条时淘汰最旧的条目（Map 迭代顺序为插入顺序）
      if (cache.size > 50) {
        cache.delete(cache.keys().next().value!)
      }
      // 清除飞行中标记
      if (inflightQuery === mcpQuery) {
        inflightQuery = null
        inflightPromise = null
      }
    }
  }

  // 本地过滤：以 lower 开头的频道，排序，取前 10 条
  return channels
    .filter(c => c.startsWith(lower))
    .sort()
    .slice(0, 10)
    .map(c => ({
      id: `slack-channel-${c}`,
      // displayText 加 "#" 前缀，符合 Slack 频道的视觉约定
      displayText: `#${c}`,
    }))
}

/**
 * 清空所有 Slack 频道相关缓存和状态。
 * 用于测试或需要强制刷新的场景。
 */
export function clearSlackChannelCache(): void {
  cache.clear()
  knownChannels.clear()
  knownChannelsVersion = 0
  inflightQuery = null
  inflightPromise = null
}
