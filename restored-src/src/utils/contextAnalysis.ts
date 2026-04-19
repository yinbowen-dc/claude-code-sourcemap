/**
 * 上下文窗口分析模块。
 *
 * 在 Claude Code 系统中，该模块分析当前对话的上下文窗口使用情况：
 * - 统计各类消息（用户/助手/工具结果）的 token 占用
 * - 检测上下文窗口压力，生成压缩建议
 * - 为 UI 展示提供上下文摘要数据
 */
import type { BetaContentBlock } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import type {
  ContentBlock,
  ContentBlockParam,
} from '@anthropic-ai/sdk/resources/index.mjs'
import { roughTokenCountEstimation as countTokens } from '../services/tokenEstimation.js'
import type {
  AssistantMessage,
  Message,
  UserMessage,
} from '../types/message.js'
import { normalizeMessagesForAPI } from './messages.js'
import { jsonStringify } from './slowOperations.js'

type TokenStats = {
  toolRequests: Map<string, number>
  toolResults: Map<string, number>
  humanMessages: number
  assistantMessages: number
  localCommandOutputs: number
  other: number
  attachments: Map<string, number>
  duplicateFileReads: Map<string, { count: number; tokens: number }>
  total: number
}

/**
 * 分析对话消息列表，统计各类消息的 token 占用情况。
 *
 * 处理流程：
 * 1. 统计 attachment 类消息（图片/文件等）的类型分布
 * 2. 将消息规范化为 API 格式（normalizeMessagesForAPI）
 * 3. 按块类型（text/tool_use/tool_result/其他）归类统计 token
 * 4. 追踪重复 Read 工具调用（同一文件被多次读取），计算浪费的 token
 *
 * @returns TokenStats 包含各类 token 计数的统计对象
 */
export function analyzeContext(messages: Message[]): TokenStats {
  const stats: TokenStats = {
    toolRequests: new Map(),
    toolResults: new Map(),
    humanMessages: 0,
    assistantMessages: 0,
    localCommandOutputs: 0,
    other: 0,
    attachments: new Map(),
    duplicateFileReads: new Map(),
    total: 0,
  }

  // tool_use_id → 工具名称的映射，供 tool_result 块关联工具名用
  const toolIdsToToolNames = new Map<string, string>()
  // tool_use_id → 文件路径的映射，追踪 Read 工具的文件路径
  const readToolIdToFilePath = new Map<string, string>()
  // 文件路径 → { 读取次数, 累计 token } 的映射，用于检测重复读取
  const fileReadStats = new Map<
    string,
    { count: number; totalTokens: number }
  >()

  // 先统计 attachment 类型分布（按类型计数，不计 token）
  messages.forEach(msg => {
    if (msg.type === 'attachment') {
      const type = msg.attachment.type || 'unknown'
      stats.attachments.set(type, (stats.attachments.get(type) || 0) + 1)
    }
  })

  // 规范化为 API 格式后逐块统计
  const normalizedMessages = normalizeMessagesForAPI(messages)
  normalizedMessages.forEach(msg => {
    const { content } = msg.message

    // 字符串内容（旧路径，保留兼容）
    if (typeof content === 'string') {
      const tokens = countTokens(content)
      stats.total += tokens
      // local-command-stdout 标记的字符串归入本地命令输出
      if (msg.type === 'user' && content.includes('local-command-stdout')) {
        stats.localCommandOutputs += tokens
      } else {
        stats[msg.type === 'user' ? 'humanMessages' : 'assistantMessages'] +=
          tokens
      }
    } else {
      // 数组格式：逐块处理
      content.forEach(block =>
        processBlock(
          block,
          msg,
          stats,
          toolIdsToToolNames,
          readToolIdToFilePath,
          fileReadStats,
        ),
      )
    }
  })

  // 计算重复文件读取浪费的 token（读取次数 > 1 才计入重复）
  fileReadStats.forEach((data, path) => {
    if (data.count > 1) {
      const averageTokensPerRead = Math.floor(data.totalTokens / data.count)
      // 重复浪费 = 平均每次读取 token × (读取次数 - 1)
      const duplicateTokens = averageTokensPerRead * (data.count - 1)

      stats.duplicateFileReads.set(path, {
        count: data.count,
        tokens: duplicateTokens,
      })
    }
  })

  return stats
}

/**
 * 处理单个内容块，将其 token 计入对应的统计分类。
 *
 * 分类规则：
 * - text 块 → humanMessages 或 assistantMessages（local-command-stdout 归入 localCommandOutputs）
 * - tool_use 块 → toolRequests（同时建立 id→name 映射；Read 工具还记录文件路径）
 * - tool_result 块 → toolResults（Read 工具结果还追踪文件读取次数和 token）
 * - 其他块（image/thinking/mcp_tool_use 等）→ other
 */
function processBlock(
  block: ContentBlockParam | ContentBlock | BetaContentBlock,
  message: UserMessage | AssistantMessage,
  stats: TokenStats,
  toolIds: Map<string, string>,
  readToolPaths: Map<string, string>,
  fileReads: Map<string, { count: number; totalTokens: number }>,
): void {
  // 将整个块序列化为 JSON 后估算 token 数
  const tokens = countTokens(jsonStringify(block))
  stats.total += tokens

  switch (block.type) {
    case 'text':
      // local-command-stdout 标记的文本归入本地命令输出，其余按消息方向归类
      if (
        message.type === 'user' &&
        'text' in block &&
        block.text.includes('local-command-stdout')
      ) {
        stats.localCommandOutputs += tokens
      } else {
        stats[
          message.type === 'user' ? 'humanMessages' : 'assistantMessages'
        ] += tokens
      }
      break

    case 'tool_use': {
      if ('name' in block && 'id' in block) {
        const toolName = block.name || 'unknown'
        // 按工具名累加请求 token
        increment(stats.toolRequests, toolName, tokens)
        // 建立 id→name 映射，供对应的 tool_result 块关联工具名
        toolIds.set(block.id, toolName)

        // 追踪 Read 工具的文件路径（用于后续重复读取检测）
        if (
          toolName === 'Read' &&
          'input' in block &&
          block.input &&
          typeof block.input === 'object' &&
          'file_path' in block.input
        ) {
          const path = String(
            (block.input as Record<string, unknown>).file_path,
          )
          readToolPaths.set(block.id, path)
        }
      }
      break
    }

    case 'tool_result': {
      if ('tool_use_id' in block) {
        // 通过 id 反查工具名，未找到时标记为 unknown
        const toolName = toolIds.get(block.tool_use_id) || 'unknown'
        increment(stats.toolResults, toolName, tokens)

        // 追踪 Read 工具结果的 token（用于计算重复读取浪费）
        if (toolName === 'Read') {
          const path = readToolPaths.get(block.tool_use_id)
          if (path) {
            const current = fileReads.get(path) || { count: 0, totalTokens: 0 }
            fileReads.set(path, {
              count: current.count + 1,
              totalTokens: current.totalTokens + tokens,
            })
          }
        }
      }
      break
    }

    // 图片、服务端工具、thinking、MCP 工具等其他块类型均归入 other
    case 'image':
    case 'server_tool_use':
    case 'web_search_tool_result':
    case 'search_result':
    case 'document':
    case 'thinking':
    case 'redacted_thinking':
    case 'code_execution_tool_result':
    case 'mcp_tool_use':
    case 'mcp_tool_result':
    case 'container_upload':
    case 'web_fetch_tool_result':
    case 'bash_code_execution_tool_result':
    case 'text_editor_code_execution_tool_result':
    case 'tool_search_tool_result':
    case 'compaction':
      // Don't care about these for now..
      stats['other'] += tokens
      break
  }
}

/** Map 计数辅助函数：将 key 对应的值增加 value（key 不存在时初始化为 0）。 */
function increment(map: Map<string, number>, key: string, value: number): void {
  map.set(key, (map.get(key) || 0) + value)
}

/**
 * 将 TokenStats 转换为 Statsig 事件指标格式（扁平 Record<string, number>）。
 *
 * 输出字段包括：
 * - total_tokens / human_message_tokens / assistant_message_tokens 等总量
 * - attachment_{type}_count 各类附件数量
 * - tool_request_{tool}_tokens / tool_result_{tool}_tokens 各工具调用/结果 token
 * - duplicate_read_tokens / duplicate_read_file_count 重复读取统计
 * - *_percent 各类占比（仅在 total > 0 时计算）
 */
export function tokenStatsToStatsigMetrics(
  stats: TokenStats,
): Record<string, number> {
  const metrics: Record<string, number> = {
    total_tokens: stats.total,
    human_message_tokens: stats.humanMessages,
    assistant_message_tokens: stats.assistantMessages,
    local_command_output_tokens: stats.localCommandOutputs,
    other_tokens: stats.other,
  }

  // 各类附件类型的数量
  stats.attachments.forEach((count, type) => {
    metrics[`attachment_${type}_count`] = count
  })

  // 各工具请求和结果的 token 统计
  stats.toolRequests.forEach((tokens, tool) => {
    metrics[`tool_request_${tool}_tokens`] = tokens
  })

  stats.toolResults.forEach((tokens, tool) => {
    metrics[`tool_result_${tool}_tokens`] = tokens
  })

  // 所有重复文件读取浪费的总 token 数
  const duplicateTotal = [...stats.duplicateFileReads.values()].reduce(
    (sum, d) => sum + d.tokens,
    0,
  )

  metrics.duplicate_read_tokens = duplicateTotal
  metrics.duplicate_read_file_count = stats.duplicateFileReads.size

  // 百分比指标（total > 0 时才有意义）
  if (stats.total > 0) {
    metrics.human_message_percent = Math.round(
      (stats.humanMessages / stats.total) * 100,
    )
    metrics.assistant_message_percent = Math.round(
      (stats.assistantMessages / stats.total) * 100,
    )
    metrics.local_command_output_percent = Math.round(
      (stats.localCommandOutputs / stats.total) * 100,
    )
    metrics.duplicate_read_percent = Math.round(
      (duplicateTotal / stats.total) * 100,
    )

    // 工具请求/结果总 token 之和及占比
    const toolRequestTotal = [...stats.toolRequests.values()].reduce(
      (sum, v) => sum + v,
      0,
    )
    const toolResultTotal = [...stats.toolResults.values()].reduce(
      (sum, v) => sum + v,
      0,
    )

    metrics.tool_request_percent = Math.round(
      (toolRequestTotal / stats.total) * 100,
    )
    metrics.tool_result_percent = Math.round(
      (toolResultTotal / stats.total) * 100,
    )

    // 各工具请求的独立占比
    stats.toolRequests.forEach((tokens, tool) => {
      metrics[`tool_request_${tool}_percent`] = Math.round(
        (tokens / stats.total) * 100,
      )
    })

    // 各工具结果的独立占比
    stats.toolResults.forEach((tokens, tool) => {
      metrics[`tool_result_${tool}_percent`] = Math.round(
        (tokens / stats.total) * 100,
      )
    })
  }

  return metrics
}
