/**
 * 智能会话搜索模块（Agentic Session Search）。
 *
 * 在 Claude Code 系统中，该模块实现了一种两阶段会话搜索策略：
 * 1. 关键词预过滤：在本地快速筛选包含查询词的会话，减少 API 调用量
 * 2. 语义搜索：将候选会话的元数据和对话摘要发送给小型快速模型，
 *    利用 LLM 的语义理解能力返回最相关的会话列表
 *
 * 这比纯关键词搜索更智能，可以处理同义词、相关概念等语义匹配场景。
 */
import type { LogOption, SerializedMessage } from '../types/logs.js'
import { count } from './array.js'
import { logForDebugging } from './debug.js'
import { getLogDisplayTitle, logError } from './log.js'
import { getSmallFastModel } from './model/model.js'
import { isLiteLog, loadFullLog } from './sessionStorage.js'
import { sideQuery } from './sideQuery.js'
import { jsonParse } from './slowOperations.js'

// 每个会话的最大文本摘录字符数
const MAX_TRANSCRIPT_CHARS = 2000 // Max chars of transcript per session
// 从会话头尾各扫描的最大消息数
const MAX_MESSAGES_TO_SCAN = 100 // Max messages to scan from start/end
// 发送给 API 的最大会话数
const MAX_SESSIONS_TO_SEARCH = 100 // Max sessions to send to the API

/** 发送给 LLM 的系统提示词：指导模型根据查询找出最相关会话 */
const SESSION_SEARCH_SYSTEM_PROMPT = `Your goal is to find relevant sessions based on a user's search query.

You will be given a list of sessions with their metadata and a search query. Identify which sessions are most relevant to the query.

Each session may include:
- Title (display name or custom title)
- Tag (user-assigned category, shown as [tag: name] - users tag sessions with /tag command to categorize them)
- Branch (git branch name, shown as [branch: name])
- Summary (AI-generated summary)
- First message (beginning of the conversation)
- Transcript (excerpt of conversation content)

IMPORTANT: Tags are user-assigned labels that indicate the session's topic or category. If the query matches a tag exactly or partially, those sessions should be highly prioritized.

For each session, consider (in order of priority):
1. Exact tag matches (highest priority - user explicitly categorized this session)
2. Partial tag matches or tag-related terms
3. Title matches (custom titles or first message content)
4. Branch name matches
5. Summary and transcript content matches
6. Semantic similarity and related concepts

CRITICAL: Be VERY inclusive in your matching. Include sessions that:
- Contain the query term anywhere in any field
- Are semantically related to the query (e.g., "testing" matches sessions about "tests", "unit tests", "QA", etc.)
- Discuss topics that could be related to the query
- Have transcripts that mention the concept even in passing

When in doubt, INCLUDE the session. It's better to return too many results than too few. The user can easily scan through results, but missing relevant sessions is frustrating.

Return sessions ordered by relevance (most relevant first). If truly no sessions have ANY connection to the query, return an empty array - but this should be rare.

Respond with ONLY the JSON object, no markdown formatting:
{"relevant_indices": [2, 5, 0]}`

/** 语义搜索结果结构：包含相关会话的索引数组 */
type AgenticSearchResult = {
  relevant_indices: number[]
}

/**
 * 从单条消息中提取可搜索的文本内容。
 * 支持字符串内容和内容块数组（ContentBlock[]）两种格式。
 */
function extractMessageText(message: SerializedMessage): string {
  if (message.type !== 'user' && message.type !== 'assistant') {
    return ''
  }

  const content = 'message' in message ? message.message?.content : undefined
  if (!content) return ''

  if (typeof content === 'string') {
    return content
  }

  if (Array.isArray(content)) {
    return content
      .map(block => {
        if (typeof block === 'string') return block
        if ('text' in block && typeof block.text === 'string') return block.text
        return ''
      })
      .filter(Boolean)
      .join(' ')
  }

  return ''
}

/**
 * 从会话消息列表中提取截断后的对话摘录。
 * 取会话头尾各一半的消息以获取上下文，超出字符限制时截断并加省略号。
 */
function extractTranscript(messages: SerializedMessage[]): string {
  if (messages.length === 0) return ''

  // Take messages from start and end to get context
  const messagesToScan =
    messages.length <= MAX_MESSAGES_TO_SCAN
      ? messages
      : [
          ...messages.slice(0, MAX_MESSAGES_TO_SCAN / 2),
          ...messages.slice(-MAX_MESSAGES_TO_SCAN / 2),
        ]

  // 提取每条消息的文本并合并为单一字符串
  const text = messagesToScan
    .map(extractMessageText)
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()

  return text.length > MAX_TRANSCRIPT_CHARS
    ? text.slice(0, MAX_TRANSCRIPT_CHARS) + '…'
    : text
}

/**
 * 检查单个会话记录是否包含查询词（在标题、标签、分支、摘要、首条消息或摘录中）。
 * 用于第一阶段的本地关键词预过滤。
 */
function logContainsQuery(log: LogOption, queryLower: string): boolean {
  // Check title
  const title = getLogDisplayTitle(log).toLowerCase()
  if (title.includes(queryLower)) return true

  // Check custom title
  if (log.customTitle?.toLowerCase().includes(queryLower)) return true

  // Check tag
  if (log.tag?.toLowerCase().includes(queryLower)) return true

  // Check branch
  if (log.gitBranch?.toLowerCase().includes(queryLower)) return true

  // Check summary
  if (log.summary?.toLowerCase().includes(queryLower)) return true

  // Check first prompt
  if (log.firstPrompt?.toLowerCase().includes(queryLower)) return true

  // Check transcript (more expensive, do last)
  if (log.messages && log.messages.length > 0) {
    const transcript = extractTranscript(log.messages).toLowerCase()
    if (transcript.includes(queryLower)) return true
  }

  return false
}

/**
 * 使用 Claude 的语义理解能力搜索相关会话。
 *
 * 完整流程：
 * 1. 本地关键词预过滤，筛选包含查询词的候选会话
 * 2. 对 lite 日志加载完整内容以获取对话摘录
 * 3. 将会话元数据构建成结构化文本发送给小模型
 * 4. 解析模型返回的 JSON，映射回原始 LogOption 列表
 *
 * Performs an agentic search using Claude to find relevant sessions.
 */
export async function agenticSessionSearch(
  query: string,
  logs: LogOption[],
  signal?: AbortSignal,
): Promise<LogOption[]> {
  if (!query.trim() || logs.length === 0) {
    return []
  }

  const queryLower = query.toLowerCase()

  // 第一阶段：本地关键词预过滤
  const matchingLogs = logs.filter(log => logContainsQuery(log, queryLower))

  // 若关键词匹配数不足 MAX_SESSIONS_TO_SEARCH，用最近的非匹配会话补充
  let logsToSearch: LogOption[]
  if (matchingLogs.length >= MAX_SESSIONS_TO_SEARCH) {
    logsToSearch = matchingLogs.slice(0, MAX_SESSIONS_TO_SEARCH)
  } else {
    const nonMatchingLogs = logs.filter(
      log => !logContainsQuery(log, queryLower),
    )
    const remainingSlots = MAX_SESSIONS_TO_SEARCH - matchingLogs.length
    logsToSearch = [
      ...matchingLogs,
      ...nonMatchingLogs.slice(0, remainingSlots),
    ]
  }

  // Debug: log what data we have
  logForDebugging(
    `Agentic search: ${logsToSearch.length}/${logs.length} logs, query="${query}", ` +
      `matching: ${matchingLogs.length}, with messages: ${count(logsToSearch, l => l.messages?.length > 0)}`,
  )

  // 对精简日志（lite log）加载完整内容以获取对话摘录
  const logsWithTranscriptsPromises = logsToSearch.map(async log => {
    if (isLiteLog(log)) {
      try {
        return await loadFullLog(log)
      } catch (error) {
        logError(error as Error)
        // If loading fails, use the lite log (no transcript)
        return log
      }
    }
    return log
  })
  const logsWithTranscripts = await Promise.all(logsWithTranscriptsPromises)

  logForDebugging(
    `Agentic search: loaded ${count(logsWithTranscripts, l => l.messages?.length > 0)}/${logsToSearch.length} logs with transcripts`,
  )

  // 将会话列表构建为结构化文本，发送给 LLM 进行语义排序
  const sessionList = logsWithTranscripts
    .map((log, index) => {
      const parts: string[] = [`${index}:`]

      // Title (display title, may be custom or from first prompt)
      const displayTitle = getLogDisplayTitle(log)
      parts.push(displayTitle)

      // Custom title if different from display title
      if (log.customTitle && log.customTitle !== displayTitle) {
        parts.push(`[custom title: ${log.customTitle}]`)
      }

      // Tag
      if (log.tag) {
        parts.push(`[tag: ${log.tag}]`)
      }

      // Git branch
      if (log.gitBranch) {
        parts.push(`[branch: ${log.gitBranch}]`)
      }

      // Summary
      if (log.summary) {
        parts.push(`- Summary: ${log.summary}`)
      }

      // First prompt content (truncated)
      if (log.firstPrompt && log.firstPrompt !== 'No prompt') {
        parts.push(`- First message: ${log.firstPrompt.slice(0, 300)}`)
      }

      // Transcript excerpt (if messages are available)
      if (log.messages && log.messages.length > 0) {
        const transcript = extractTranscript(log.messages)
        if (transcript) {
          parts.push(`- Transcript: ${transcript}`)
        }
      }

      return parts.join(' ')
    })
    .join('\n')

  const userMessage = `Sessions:
${sessionList}

Search query: "${query}"

Find the sessions that are most relevant to this query.`

  // Debug: log first part of the session list
  logForDebugging(
    `Agentic search prompt (first 500 chars): ${userMessage.slice(0, 500)}...`,
  )

  try {
    // 使用小型快速模型进行语义搜索
    const model = getSmallFastModel()
    logForDebugging(`Agentic search using model: ${model}`)

    const response = await sideQuery({
      model,
      system: SESSION_SEARCH_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
      signal,
      querySource: 'session_search',
    })

    // 从响应中提取文本内容块
    const textContent = response.content.find(block => block.type === 'text')
    if (!textContent || textContent.type !== 'text') {
      logForDebugging('No text content in agentic search response')
      return []
    }

    // Debug: log the response
    logForDebugging(`Agentic search response: ${textContent.text}`)

    // 从响应文本中提取 JSON 对象
    const jsonMatch = textContent.text.match(/\{[\s\S]*\}/)
    if (!jsonMatch) {
      logForDebugging('Could not find JSON in agentic search response')
      return []
    }

    const result: AgenticSearchResult = jsonParse(jsonMatch[0])
    const relevantIndices = result.relevant_indices || []

    // 将模型返回的索引映射回原始 LogOption 列表
    const relevantLogs = relevantIndices
      .filter(index => index >= 0 && index < logsWithTranscripts.length)
      .map(index => logsWithTranscripts[index]!)

    logForDebugging(
      `Agentic search found ${relevantLogs.length} relevant sessions`,
    )

    return relevantLogs
  } catch (error) {
    logError(error as Error)
    logForDebugging(`Agentic search error: ${error}`)
    return []
  }
}
