/**
 * 上下文窗口建议生成模块。
 *
 * 在 Claude Code 系统中，该模块根据上下文分析结果生成用户可见的优化建议，
 * 提示用户在上下文窗口占用过高时通过 compact 或重新开始会话来释放空间。
 */
import { BASH_TOOL_NAME } from '../tools/BashTool/toolName.js'
import { FILE_READ_TOOL_NAME } from '../tools/FileReadTool/prompt.js'
import { GREP_TOOL_NAME } from '../tools/GrepTool/prompt.js'
import { WEB_FETCH_TOOL_NAME } from '../tools/WebFetchTool/prompt.js'
import type { ContextData } from './analyzeContext.js'
import { getDisplayPath } from './file.js'
import { formatTokens } from './format.js'

// --

export type SuggestionSeverity = 'info' | 'warning'

export type ContextSuggestion = {
  severity: SuggestionSeverity
  title: string
  detail: string
  /** Estimated tokens that could be saved */
  savingsTokens?: number
}

// 触发建议的各项阈值常量
const LARGE_TOOL_RESULT_PERCENT = 15 // 工具结果占上下文 > 15% 时触发大结果警告
const LARGE_TOOL_RESULT_TOKENS = 10_000 // 工具结果 token 数下限（低于此值不触发，避免噪音）
const READ_BLOAT_PERCENT = 5  // Read 工具结果占上下文 > 5% 时触发文件膨胀提示
const NEAR_CAPACITY_PERCENT = 80 // 上下文使用率 ≥ 80% 时触发容量警告
const MEMORY_HIGH_PERCENT = 5  // 内存文件占上下文 > 5% 时触发内存膨胀提示
const MEMORY_HIGH_TOKENS = 5_000 // 内存文件 token 数下限

/**
 * 根据上下文数据生成用户可见的优化建议列表。
 *
 * 依次检查以下维度：
 * 1. 容量接近上限（≥80%）
 * 2. 单类工具结果占比过高（≥15% 且 ≥10k token）
 * 3. Read 工具结果膨胀（≥5% 且 ≥10k token，但未被大结果覆盖）
 * 4. CLAUDE.md 等内存文件占比过高（≥5% 且 ≥5k token）
 * 5. autocompact 已禁用（上下文 50-80% 时提示开启）
 *
 * 排序规则：warning 优先，同级按可节省 token 数降序排列。
 */
export function generateContextSuggestions(
  data: ContextData,
): ContextSuggestion[] {
  const suggestions: ContextSuggestion[] = []

  checkNearCapacity(data, suggestions)
  checkLargeToolResults(data, suggestions)
  checkReadResultBloat(data, suggestions)
  checkMemoryBloat(data, suggestions)
  checkAutoCompactDisabled(data, suggestions)

  // 排序：warning 优先，同级按可节省 token 数降序
  suggestions.sort((a, b) => {
    if (a.severity !== b.severity) {
      return a.severity === 'warning' ? -1 : 1
    }
    return (b.savingsTokens ?? 0) - (a.savingsTokens ?? 0)
  })

  return suggestions
}

// --

/** 检查上下文是否接近满载（≥80%），生成容量警告建议。 */
function checkNearCapacity(
  data: ContextData,
  suggestions: ContextSuggestion[],
): void {
  if (data.percentage >= NEAR_CAPACITY_PERCENT) {
    suggestions.push({
      severity: 'warning',
      title: `Context is ${data.percentage}% full`,
      // autocompact 开启时提示即将触发；关闭时提示手动 compact 或在 /config 中开启
      detail: data.isAutoCompactEnabled
        ? 'Autocompact will trigger soon, which discards older messages. Use /compact now to control what gets kept.'
        : 'Autocompact is disabled. Use /compact to free space, or enable autocompact in /config.',
    })
  }
}

/**
 * 检查各类工具结果是否占用上下文过多（≥15% 且 ≥10k token），生成相应建议。
 * 对 Bash/Read/Grep/WebFetch 等工具提供针对性建议；其他工具占比 ≥20% 时提示通用建议。
 */
function checkLargeToolResults(
  data: ContextData,
  suggestions: ContextSuggestion[],
): void {
  if (!data.messageBreakdown) return

  for (const tool of data.messageBreakdown.toolCallsByType) {
    const totalToolTokens = tool.callTokens + tool.resultTokens
    const percent = (totalToolTokens / data.rawMaxTokens) * 100

    // 低于阈值时跳过，避免噪音
    if (
      percent < LARGE_TOOL_RESULT_PERCENT ||
      totalToolTokens < LARGE_TOOL_RESULT_TOKENS
    ) {
      continue
    }

    const suggestion = getLargeToolSuggestion(
      tool.name,
      totalToolTokens,
      percent,
    )
    if (suggestion) {
      suggestions.push(suggestion)
    }
  }
}

/**
 * 根据工具名称返回针对性的大结果建议，提供具体的减小输出建议。
 * 对未知工具且占比 ≥20% 时返回通用建议；不符合条件时返回 null。
 */
function getLargeToolSuggestion(
  toolName: string,
  tokens: number,
  percent: number,
): ContextSuggestion | null {
  const tokenStr = formatTokens(tokens)

  switch (toolName) {
    case BASH_TOOL_NAME:
      return {
        severity: 'warning',
        title: `Bash results using ${tokenStr} tokens (${percent.toFixed(0)}%)`,
        // 建议管道过滤输出，避免 cat 大文件
        detail:
          'Pipe output through head, tail, or grep to reduce result size. Avoid cat on large files \u2014 use Read with offset/limit instead.',
        savingsTokens: Math.floor(tokens * 0.5),
      }
    case FILE_READ_TOOL_NAME:
      return {
        severity: 'info',
        title: `Read results using ${tokenStr} tokens (${percent.toFixed(0)}%)`,
        // 建议使用 offset/limit 仅读取所需部分
        detail:
          'Use offset and limit parameters to read only the sections you need. Avoid re-reading entire files when you only need a few lines.',
        savingsTokens: Math.floor(tokens * 0.3),
      }
    case GREP_TOOL_NAME:
      return {
        severity: 'info',
        title: `Grep results using ${tokenStr} tokens (${percent.toFixed(0)}%)`,
        // 建议缩窄 Grep 模式或改用 Glob 做文件发现
        detail:
          'Add more specific patterns or use the glob or type parameter to narrow file types. Consider Glob for file discovery instead of Grep.',
        savingsTokens: Math.floor(tokens * 0.3),
      }
    case WEB_FETCH_TOOL_NAME:
      return {
        severity: 'info',
        title: `WebFetch results using ${tokenStr} tokens (${percent.toFixed(0)}%)`,
        // 网页内容通常很大，建议只提取所需信息
        detail:
          'Web page content can be very large. Consider extracting only the specific information needed.',
        savingsTokens: Math.floor(tokens * 0.4),
      }
    default:
      // 未知工具：仅在占比 ≥20% 时生成通用建议
      if (percent >= 20) {
        return {
          severity: 'info',
          title: `${toolName} using ${tokenStr} tokens (${percent.toFixed(0)}%)`,
          detail: `This tool is consuming a significant portion of context.`,
          savingsTokens: Math.floor(tokens * 0.2),
        }
      }
      return null
  }
}

/**
 * 检查 Read 工具结果是否造成文件读取膨胀。
 * 仅在未被 checkLargeToolResults 覆盖（<15% 大结果阈值）时触发，避免重复建议。
 */
function checkReadResultBloat(
  data: ContextData,
  suggestions: ContextSuggestion[],
): void {
  if (!data.messageBreakdown) return

  const callsByType = data.messageBreakdown.toolCallsByType
  const readTool = callsByType.find(t => t.name === FILE_READ_TOOL_NAME)
  if (!readTool) return

  const totalReadTokens = readTool.callTokens + readTool.resultTokens
  const totalReadPercent = (totalReadTokens / data.rawMaxTokens) * 100
  const readPercent = (readTool.resultTokens / data.rawMaxTokens) * 100

  // 已被大结果检查覆盖时跳过（避免重复）
  if (
    totalReadPercent >= LARGE_TOOL_RESULT_PERCENT &&
    totalReadTokens >= LARGE_TOOL_RESULT_TOKENS
  ) {
    return
  }

  // 结果占比 ≥5% 且 token 数 ≥10k 时提示文件读取膨胀
  if (
    readPercent >= READ_BLOAT_PERCENT &&
    readTool.resultTokens >= LARGE_TOOL_RESULT_TOKENS
  ) {
    suggestions.push({
      severity: 'info',
      title: `File reads using ${formatTokens(readTool.resultTokens)} tokens (${readPercent.toFixed(0)}%)`,
      detail:
        'If you are re-reading files, consider referencing earlier reads. Use offset/limit for large files.',
      savingsTokens: Math.floor(readTool.resultTokens * 0.3),
    })
  }
}

/**
 * 检查 CLAUDE.md 等内存文件是否占用上下文过多。
 * 占比 ≥5% 且 ≥5k token 时，列出最大的三个文件并建议通过 /memory 修剪。
 */
function checkMemoryBloat(
  data: ContextData,
  suggestions: ContextSuggestion[],
): void {
  const totalMemoryTokens = data.memoryFiles.reduce(
    (sum, f) => sum + f.tokens,
    0,
  )
  const memoryPercent = (totalMemoryTokens / data.rawMaxTokens) * 100

  if (
    memoryPercent >= MEMORY_HIGH_PERCENT &&
    totalMemoryTokens >= MEMORY_HIGH_TOKENS
  ) {
    // 取 token 数最多的前 3 个文件，供用户定向修剪
    const largestFiles = [...data.memoryFiles]
      .sort((a, b) => b.tokens - a.tokens)
      .slice(0, 3)
      .map(f => {
        const name = getDisplayPath(f.path)
        return `${name} (${formatTokens(f.tokens)})`
      })
      .join(', ')

    suggestions.push({
      severity: 'info',
      title: `Memory files using ${formatTokens(totalMemoryTokens)} tokens (${memoryPercent.toFixed(0)}%)`,
      detail: `Largest: ${largestFiles}. Use /memory to review and prune stale entries.`,
      savingsTokens: Math.floor(totalMemoryTokens * 0.3),
    })
  }
}

/**
 * 检查 autocompact 是否已禁用且上下文处于中等压力（50%-80%）。
 * 此时提示用户开启 autocompact 或手动执行 /compact，避免后续撞上上限丢失对话。
 */
function checkAutoCompactDisabled(
  data: ContextData,
  suggestions: ContextSuggestion[],
): void {
  if (
    !data.isAutoCompactEnabled &&
    data.percentage >= 50 &&
    data.percentage < NEAR_CAPACITY_PERCENT // 80% 以上已由 checkNearCapacity 覆盖
  ) {
    suggestions.push({
      severity: 'info',
      title: 'Autocompact is disabled',
      detail:
        'Without autocompact, you will hit context limits and lose the conversation. Enable it in /config or use /compact manually.',
    })
  }
}
