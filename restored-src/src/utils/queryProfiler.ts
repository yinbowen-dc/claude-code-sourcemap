/**
 * 查询管道性能分析模块
 *
 * 本文件在 Claude Code 系统流程中的位置：
 * - 用于测量查询管道从用户输入到首个 token 到达（TTFT）各阶段的耗时
 * - 通过设置环境变量 CLAUDE_CODE_PROFILE_QUERY=1 来启用
 * - 使用 Node.js 内置 performance hooks API 进行标准计时
 * - 追踪每个查询会话的详细检查点，帮助定位性能瓶颈
 *
 * 追踪的检查点（按顺序）：
 * - query_user_input_received: 分析开始
 * - query_context_loading_start/end: 加载系统提示词和上下文
 * - query_query_start: 从 REPL 进入 query 调用
 * - query_fn_entry: 进入 query() 函数
 * - query_microcompact_start/end: 消息微压缩
 * - query_autocompact_start/end: 自动压缩检查
 * - query_setup_start/end: StreamingToolExecutor 和模型初始化
 * - query_api_loop_start: API 重试循环开始
 * - query_api_streaming_start: 流式 API 调用开始
 * - query_tool_schema_build_start/end: 构建工具 schema
 * - query_message_normalization_start/end: 消息规范化
 * - query_client_creation_start/end: 创建 Anthropic 客户端
 * - query_api_request_sent: HTTP 请求已发送（在重试体内 await 前）
 * - query_response_headers_received: .withResponse() 已 resolve（响应头到达）
 * - query_first_chunk_received: 收到首个流式数据块（TTFT）
 * - query_api_streaming_end: 流式传输完成
 * - query_tool_execution_start/end: 工具执行
 * - query_recursive_call: 递归 query 调用前
 * - query_end: 查询结束
 */

import { logForDebugging } from './debug.js'
import { isEnvTruthy } from './envUtils.js'
import { formatMs, formatTimelineLine, getPerformance } from './profilerBase.js'

// 模块级状态，在模块加载时初始化一次
// eslint-disable-next-line custom-rules/no-process-env-top-level
const ENABLED = isEnvTruthy(process.env.CLAUDE_CODE_PROFILE_QUERY)

// 单独跟踪内存快照（perf_hooks 不追踪内存）
const memorySnapshots = new Map<string, NodeJS.MemoryUsage>()

// 记录查询次数，用于报告
let queryCount = 0

// 单独追踪首个 token 到达时间，用于摘要统计
let firstTokenTime: number | null = null

/**
 * 启动新一轮查询会话的性能分析。
 * 清除上一轮的检查点和内存快照，并记录首个检查点。
 */
export function startQueryProfile(): void {
  if (!ENABLED) return

  const perf = getPerformance()

  // 清除上一轮的标记和内存快照
  perf.clearMarks()
  memorySnapshots.clear()
  firstTokenTime = null

  queryCount++

  // 记录起始检查点
  queryCheckpoint('query_user_input_received')
}

/**
 * 记录指定名称的检查点，同时保存当前内存使用快照。
 * 若为 query_first_chunk_received 检查点，额外记录 TTFT 时间。
 */
export function queryCheckpoint(name: string): void {
  if (!ENABLED) return

  const perf = getPerformance()
  perf.mark(name)
  // 记录当前内存使用快照，便于分析内存增长
  memorySnapshots.set(name, process.memoryUsage())

  // 特别处理首个 token 到达时间
  if (name === 'query_first_chunk_received' && firstTokenTime === null) {
    const marks = perf.getEntriesByType('mark')
    if (marks.length > 0) {
      const lastMark = marks[marks.length - 1]
      firstTokenTime = lastMark?.startTime ?? 0
    }
  }
}

/**
 * 结束当前查询会话的性能分析，记录结束检查点。
 */
export function endQueryProfile(): void {
  if (!ENABLED) return

  queryCheckpoint('query_profile_end')
}

/**
 * 根据检查点间的时间差识别慢操作（>100ms），返回对应的警告字符串。
 * 首个检查点不标记为慢操作（其时间从进程启动算起，非实际处理耗时）。
 */
function getSlowWarning(deltaMs: number, name: string): string {
  // 首个检查点从进程启动算起，不代表实际处理开销，跳过慢检测
  if (name === 'query_user_input_received') {
    return ''
  }

  if (deltaMs > 1000) {
    return ` ⚠️  VERY SLOW`
  }
  if (deltaMs > 100) {
    return ` ⚠️  SLOW`
  }

  // 针对已知性能瓶颈的特定警告
  if (name.includes('git_status') && deltaMs > 50) {
    return ' ⚠️  git status'
  }
  if (name.includes('tool_schema') && deltaMs > 50) {
    return ' ⚠️  tool schemas'
  }
  if (name.includes('client_creation') && deltaMs > 50) {
    return ' ⚠️  client creation'
  }

  return ''
}

/**
 * 生成当前/上一次查询的所有检查点格式化报告字符串。
 * 包含时间线明细、TTFT 摘要统计和各阶段耗时分解。
 */
function getQueryProfileReport(): string {
  if (!ENABLED) {
    return 'Query profiling not enabled (set CLAUDE_CODE_PROFILE_QUERY=1)'
  }

  const perf = getPerformance()
  const marks = perf.getEntriesByType('mark')
  if (marks.length === 0) {
    return 'No query profiling checkpoints recorded'
  }

  const lines: string[] = []
  lines.push('='.repeat(80))
  lines.push(`QUERY PROFILING REPORT - Query #${queryCount}`)
  lines.push('='.repeat(80))
  lines.push('')

  // Use first mark as baseline (query start time) to show relative times
  const baselineTime = marks[0]?.startTime ?? 0
  let prevTime = baselineTime
  let apiRequestSentTime = 0
  let firstChunkTime = 0

  for (const mark of marks) {
    const relativeTime = mark.startTime - baselineTime
    const deltaMs = mark.startTime - prevTime
    lines.push(
      formatTimelineLine(
        relativeTime,
        deltaMs,
        mark.name,
        memorySnapshots.get(mark.name),
        10,
        9,
        getSlowWarning(deltaMs, mark.name),
      ),
    )

    // Track key milestones for summary (use relative times)
    if (mark.name === 'query_api_request_sent') {
      apiRequestSentTime = relativeTime
    }
    if (mark.name === 'query_first_chunk_received') {
      firstChunkTime = relativeTime
    }

    prevTime = mark.startTime
  }

  // Calculate summary statistics (relative to baseline)
  const lastMark = marks[marks.length - 1]
  const totalTime = lastMark ? lastMark.startTime - baselineTime : 0

  lines.push('')
  lines.push('-'.repeat(80))

  if (firstChunkTime > 0) {
    const preRequestOverhead = apiRequestSentTime
    const networkLatency = firstChunkTime - apiRequestSentTime
    const preRequestPercent = (
      (preRequestOverhead / firstChunkTime) *
      100
    ).toFixed(1)
    const networkPercent = ((networkLatency / firstChunkTime) * 100).toFixed(1)

    lines.push(`Total TTFT: ${formatMs(firstChunkTime)}ms`)
    lines.push(
      `  - Pre-request overhead: ${formatMs(preRequestOverhead)}ms (${preRequestPercent}%)`,
    )
    lines.push(
      `  - Network latency: ${formatMs(networkLatency)}ms (${networkPercent}%)`,
    )
  } else {
    lines.push(`Total time: ${formatMs(totalTime)}ms`)
  }

  // Add phase summary
  lines.push(getPhaseSummary(marks, baselineTime))

  lines.push('='.repeat(80))

  return lines.join('\n')
}

/**
 * Get phase-based summary showing time spent in each major phase
 */
function getPhaseSummary(
  marks: Array<{ name: string; startTime: number }>,
  baselineTime: number,
): string {
  const phases: Array<{ name: string; start: string; end: string }> = [
    {
      name: 'Context loading',
      start: 'query_context_loading_start',
      end: 'query_context_loading_end',
    },
    {
      name: 'Microcompact',
      start: 'query_microcompact_start',
      end: 'query_microcompact_end',
    },
    {
      name: 'Autocompact',
      start: 'query_autocompact_start',
      end: 'query_autocompact_end',
    },
    { name: 'Query setup', start: 'query_setup_start', end: 'query_setup_end' },
    {
      name: 'Tool schemas',
      start: 'query_tool_schema_build_start',
      end: 'query_tool_schema_build_end',
    },
    {
      name: 'Message normalization',
      start: 'query_message_normalization_start',
      end: 'query_message_normalization_end',
    },
    {
      name: 'Client creation',
      start: 'query_client_creation_start',
      end: 'query_client_creation_end',
    },
    {
      name: 'Network TTFB',
      start: 'query_api_request_sent',
      end: 'query_first_chunk_received',
    },
    {
      name: 'Tool execution',
      start: 'query_tool_execution_start',
      end: 'query_tool_execution_end',
    },
  ]

  const markMap = new Map(marks.map(m => [m.name, m.startTime - baselineTime]))

  const lines: string[] = []
  lines.push('')
  lines.push('PHASE BREAKDOWN:')

  for (const phase of phases) {
    const startTime = markMap.get(phase.start)
    const endTime = markMap.get(phase.end)

    if (startTime !== undefined && endTime !== undefined) {
      const duration = endTime - startTime
      const bar = '█'.repeat(Math.min(Math.ceil(duration / 10), 50)) // 1 block per 10ms, max 50
      lines.push(
        `  ${phase.name.padEnd(22)} ${formatMs(duration).padStart(10)}ms ${bar}`,
      )
    }
  }

  // Calculate pre-API overhead (everything before api_request_sent)
  const apiRequestSent = markMap.get('query_api_request_sent')
  if (apiRequestSent !== undefined) {
    lines.push('')
    lines.push(
      `  ${'Total pre-API overhead'.padEnd(22)} ${formatMs(apiRequestSent).padStart(10)}ms`,
    )
  }

  return lines.join('\n')
}

/**
 * Log the query profile report to debug output
 */
export function logQueryProfileReport(): void {
  if (!ENABLED) return
  logForDebugging(getQueryProfileReport())
}
