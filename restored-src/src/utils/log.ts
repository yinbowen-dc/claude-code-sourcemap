/**
 * log.ts — 日志与错误记录模块
 *
 * 【在 Claude Code 系统流程中的位置】
 * 本文件位于工具层（utils），是 Claude Code 错误记录和日志管理的核心枢纽。
 * 几乎所有其他模块都会导入本文件的 logError 函数，用于捕获和记录非致命错误。
 * 同时本文件也负责管理会话日志列表（loadErrorLogs/loadLogList）和
 * 捕获 API 请求快照（captureAPIRequest，用于错误报告）。
 *
 * 【架构设计：Sink 模式】
 * 为了避免循环依赖（log.ts 依赖 bootstrap/state.ts，而 state.ts 依赖 log.ts），
 * 本模块采用"Sink"（接收端）模式：
 *   - 应用启动时，通过 attachErrorLogSink() 注入实际的写入后端（文件写入、调试输出）；
 *   - 在 Sink 注入前，所有日志事件缓存到 errorQueue；
 *   - Sink 注入时立即 drain 队列，确保不丢失任何早期错误；
 *   - 即使无 Sink，内存错误日志（inMemoryErrorLog）始终工作（无外部依赖）。
 *
 * 【主要功能】
 * 1. attachErrorLogSink   — 注入日志写入后端（幂等，队列 drain）；
 * 2. logError             — 记录错误到内存、队列和 Sink（支持 HARD_FAIL 模式）；
 * 3. logMCPError/Debug    — MCP 服务器专用日志接口；
 * 4. captureAPIRequest    — 捕获最近一次 API 请求快照（供错误报告使用）；
 * 5. loadErrorLogs        — 从磁盘加载错误日志列表；
 * 6. getLogDisplayTitle   — 获取日志/会话的显示标题（含多级回退逻辑）。
 */

import { feature } from 'bun:bundle'
import type { BetaMessageStreamParams } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import { readdir, readFile, stat } from 'fs/promises'
import memoize from 'lodash-es/memoize.js'
import { join } from 'path'
import type { QuerySource } from 'src/constants/querySource.js'
import {
  setLastAPIRequest,
  setLastAPIRequestMessages,
} from '../bootstrap/state.js'
import { TICK_TAG } from '../constants/xml.js'
import {
  type LogOption,
  type SerializedMessage,
  sortLogs,
} from '../types/logs.js'
import { CACHE_PATHS } from './cachePaths.js'
import { stripDisplayTags, stripDisplayTagsAllowEmpty } from './displayTags.js'
import { isEnvTruthy } from './envUtils.js'
import { toError } from './errors.js'
import { isEssentialTrafficOnly } from './privacyLevel.js'
import { jsonParse } from './slowOperations.js'

/**
 * 获取日志/会话的显示标题，包含多级回退逻辑。
 *
 * 标题优先级（高→低）：
 *   agentName > customTitle > summary > firstPrompt（过滤后）> defaultTitle
 *   > 'Autonomous session'（自主模式）> sessionId 前 8 位
 *
 * 特殊处理：
 *   - 跳过以 <tick/goal> 标签开头的 firstPrompt（自主模式自动生成的提示）；
 *   - 调用 stripDisplayTagsAllowEmpty 检测纯命令提示（如 /clear），使其
 *     降级到下一层回退，而非显示原始 XML 标签；
 *   - 最终对选出的标题再次调用 stripDisplayTags，去除所有展示不友好的标签。
 */
export function getLogDisplayTitle(
  log: LogOption,
  defaultTitle?: string,
): string {
  // 检测 firstPrompt 是否为自主模式的自动提示（以 <tick> 标签开头）
  const isAutonomousPrompt = log.firstPrompt?.startsWith(`<${TICK_TAG}>`)

  // 用 AllowEmpty 版本剥离展示标签——若结果为空，说明这是纯命令提示（如 /clear），
  // 应降级到下一层回退，而非展示原始 XML
  const strippedFirstPrompt = log.firstPrompt
    ? stripDisplayTagsAllowEmpty(log.firstPrompt)
    : ''
  const useFirstPrompt = strippedFirstPrompt && !isAutonomousPrompt

  const title =
    log.agentName ||
    log.customTitle ||
    log.summary ||
    (useFirstPrompt ? strippedFirstPrompt : undefined) ||
    defaultTitle ||
    // 自主模式无其他上下文时显示语义化标签
    (isAutonomousPrompt ? 'Autonomous session' : undefined) ||
    // 轻量日志无元数据时退而显示截断的会话 ID
    (log.sessionId ? log.sessionId.slice(0, 8) : '') ||
    ''

  // 去除最终标题中的展示不友好标签（如 <ide_opened_file>）并去除首尾空白
  return stripDisplayTags(title).trim()
}

/**
 * 将 Date 对象转为日志文件名格式（ISO 8601 字符串，将 ':' 和 '.' 替换为 '-'）。
 * 例如：2024-01-15T10:30:45.123Z → 2024-01-15T10-30-45-123Z
 */
export function dateToFilename(date: Date): string {
  return date.toISOString().replace(/[:.]/g, '-')
}

// ── 内存错误日志（无外部依赖，始终可用）──────────────────────────────────
// 从 bootstrap/state.ts 移至此处以打破导入循环。

/** 内存错误日志的最大条目数（防止内存无限增长）。 */
const MAX_IN_MEMORY_ERRORS = 100
let inMemoryErrorLog: Array<{ error: string; timestamp: string }> = []

/**
 * 将错误信息追加到内存日志（环形缓冲区语义：超限则移除最旧条目）。
 */
function addToInMemoryErrorLog(errorInfo: {
  error: string
  timestamp: string
}): void {
  if (inMemoryErrorLog.length >= MAX_IN_MEMORY_ERRORS) {
    inMemoryErrorLog.shift()  // 移除最旧的错误条目，保持长度不超过上限
  }
  inMemoryErrorLog.push(errorInfo)
}

// ── Sink 模式的类型定义 ──────────────────────────────────────────────────

/**
 * 错误日志后端（Sink）接口。
 * 由应用启动流程注入，处理实际的磁盘写入和调试输出。
 */
export type ErrorLogSink = {
  logError: (error: Error) => void
  logMCPError: (serverName: string, error: unknown) => void
  logMCPDebug: (serverName: string, message: string) => void
  getErrorsPath: () => string
  getMCPLogsPath: (serverName: string) => string
}

/** 在 Sink 注入前缓存的事件类型（判别联合）。 */
type QueuedErrorEvent =
  | { type: 'error'; error: Error }
  | { type: 'mcpError'; serverName: string; error: unknown }
  | { type: 'mcpDebug'; serverName: string; message: string }

// Sink 注入前的事件缓冲队列
const errorQueue: QueuedErrorEvent[] = []

// 日志写入后端（应用启动时通过 attachErrorLogSink 注入）
let errorLogSink: ErrorLogSink | null = null

/**
 * 注入错误日志写入后端（Sink）。
 * 注入时立即 drain 缓冲队列，确保早期错误不丢失。
 *
 * 幂等设计：若 Sink 已注入，后续调用为无操作。
 * 这允许从 preAction 钩子（子命令）和 setup()（默认命令）两个入口调用，
 * 无需额外协调。
 */
export function attachErrorLogSink(newSink: ErrorLogSink): void {
  if (errorLogSink !== null) {
    return  // 已有 Sink，直接返回
  }
  errorLogSink = newSink

  // 立即 drain 队列（不应延迟——早期错误需要尽快持久化）
  if (errorQueue.length > 0) {
    const queuedEvents = [...errorQueue]
    errorQueue.length = 0  // 清空队列，防止被二次处理

    for (const event of queuedEvents) {
      switch (event.type) {
        case 'error':
          errorLogSink.logError(event.error)
          break
        case 'mcpError':
          errorLogSink.logMCPError(event.serverName, event.error)
          break
        case 'mcpDebug':
          errorLogSink.logMCPDebug(event.serverName, event.message)
          break
      }
    }
  }
}

// ── 核心错误记录 ──────────────────────────────────────────────────────────

/**
 * 记录错误到多个目标，用于调试和监控（不抛出异常，"安全"版本）。
 *
 * 记录目标：
 *   1. 内存错误日志（始终写入，无依赖；可通过 getInMemoryErrors() 访问）；
 *   2. 若 Sink 已注入：写入持久化错误日志文件（仅限内部 'ant' 用户）；
 *   3. 若 Sink 未注入：加入缓冲队列，待 Sink 注入后 drain。
 *
 * 禁用条件（提前返回）：
 *   - 云提供商环境（Bedrock/Vertex/Foundry）；
 *   - DISABLE_ERROR_REPORTING 环境变量；
 *   - 隐私级别为 essential-only 模式。
 *
 * HARD_FAIL 模式（--hard-fail 参数或 HARD_FAIL bundle 特性）：
 *   调用 logError 时立即使进程以非零退出码崩溃，用于测试中发现隐藏的错误。
 *
 * @param error - 任意类型的错误（通过 toError() 转换为 Error 对象）
 */

// 记忆化检测：--hard-fail 参数在进程生命周期内不变，只需检测一次
const isHardFailMode = memoize((): boolean => {
  return process.argv.includes('--hard-fail')
})

export function logError(error: unknown): void {
  const err = toError(error)  // 将任意类型统一转为 Error 对象

  // HARD_FAIL 模式：将 logError 变为致命错误，立即崩溃以暴露问题
  if (feature('HARD_FAIL') && isHardFailMode()) {
    // biome-ignore lint/suspicious/noConsole:: intentional crash output
    console.error('[HARD FAIL] logError called with:', err.stack || err.message)
    // eslint-disable-next-line custom-rules/no-process-exit
    process.exit(1)
  }

  try {
    // 检查是否应禁用错误上报
    if (
      // 云提供商环境始终禁用（Bedrock/Vertex/Foundry）
      isEnvTruthy(process.env.CLAUDE_CODE_USE_BEDROCK) ||
      isEnvTruthy(process.env.CLAUDE_CODE_USE_VERTEX) ||
      isEnvTruthy(process.env.CLAUDE_CODE_USE_FOUNDRY) ||
      process.env.DISABLE_ERROR_REPORTING ||
      isEssentialTrafficOnly()
    ) {
      return
    }

    const errorStr = err.stack || err.message

    const errorInfo = {
      error: errorStr,
      timestamp: new Date().toISOString(),
    }

    // 无条件写入内存日志（无外部依赖，不受 Sink 状态影响）
    addToInMemoryErrorLog(errorInfo)

    // Sink 未注入时：缓存到队列
    if (errorLogSink === null) {
      errorQueue.push({ type: 'error', error: err })
      return
    }

    // Sink 已注入：直接写入
    errorLogSink.logError(err)
  } catch {
    // 错误记录本身不应再抛出异常，静默失败
  }
}

/**
 * 获取当前会话的内存错误日志副本（浅拷贝）。
 * 用于在错误报告或 /share 时附加近期错误信息。
 */
export function getInMemoryErrors(): { error: string; timestamp: string }[] {
  return [...inMemoryErrorLog]
}

/**
 * 从磁盘加载错误日志列表，按日期排序。
 * @returns 按日期排序的错误日志数组
 */
export function loadErrorLogs(): Promise<LogOption[]> {
  return loadLogList(CACHE_PATHS.errors())
}

/**
 * 按索引获取错误日志条目（0-based）。
 * @param index - 在排序后日志列表中的索引
 * @returns 日志数据，不存在时返回 null
 */
export async function getErrorLogByIndex(
  index: number,
): Promise<LogOption | null> {
  const logs = await loadErrorLogs()
  return logs[index] || null
}

/**
 * 内部函数：加载指定目录下的所有日志文件并排序。
 * 并发读取所有文件，提取元数据（首条提示、时间戳、消息数等），
 * 最终通过 sortLogs 排序并重新分配 value 索引。
 *
 * @param path - 包含日志文件的目录路径
 * @returns 排序后的日志数组
 * @private
 */
async function loadLogList(path: string): Promise<LogOption[]> {
  let files: Awaited<ReturnType<typeof readdir>>
  try {
    files = await readdir(path, { withFileTypes: true })
  } catch {
    logError(new Error(`No logs found at ${path}`))
    return []
  }

  const logData = await Promise.all(
    files.map(async (file, i) => {
      const fullPath = join(path, file.name)
      const content = await readFile(fullPath, { encoding: 'utf8' })
      const messages = jsonParse(content) as SerializedMessage[]
      const firstMessage = messages[0]
      const lastMessage = messages[messages.length - 1]

      // 提取第一条用户提示文本（用于显示标题）
      const firstPrompt =
        firstMessage?.type === 'user' &&
        typeof firstMessage?.message?.content === 'string'
          ? firstMessage?.message?.content
          : 'No prompt'

      // 通过文件 stat 获取修改时间（随机文件名不含时间信息）
      const fileStats = await stat(fullPath)

      // 通过文件路径判断是否为 sidechain 会话
      const isSidechain = fullPath.includes('sidechain')

      // 使用文件修改时间作为显示日期
      const date = dateToFilename(fileStats.mtime)

      return {
        date,
        fullPath,
        messages,
        value: i,  // 临时值，排序后会被覆盖
        created: parseISOString(firstMessage?.timestamp || date),
        modified: lastMessage?.timestamp
          ? parseISOString(lastMessage.timestamp)
          : parseISOString(date),
        // 截断首条提示至 50 字符，超出部分加省略号
        firstPrompt:
          firstPrompt.split('\n')[0]?.slice(0, 50) +
            (firstPrompt.length > 50 ? '…' : '') || 'No prompt',
        messageCount: messages.length,
        isSidechain,
      }
    }),
  )

  // 过滤 null 值，排序后重新分配连续索引（value 字段）
  return sortLogs(logData.filter(_ => _ !== null)).map((_, i) => ({
    ..._,
    value: i,
  }))
}

/**
 * 将 ISO 日期字符串解析为 Date 对象。
 * 使用 split(/\D+/) 分割所有非数字字符，兼容多种日期格式（包括文件名格式）。
 */
function parseISOString(s: string): Date {
  const b = s.split(/\D+/)  // 按所有非数字字符分割，得到 [年, 月, 日, 时, 分, 秒, 毫秒]
  return new Date(
    Date.UTC(
      parseInt(b[0]!, 10),
      parseInt(b[1]!, 10) - 1,  // 月份从 0 开始
      parseInt(b[2]!, 10),
      parseInt(b[3]!, 10),
      parseInt(b[4]!, 10),
      parseInt(b[5]!, 10),
      parseInt(b[6]!, 10),
    ),
  )
}

// ── MCP 日志接口 ──────────────────────────────────────────────────────────

/**
 * 记录 MCP 服务器错误（写入专用 MCP 日志文件）。
 * 若 Sink 未注入，缓存到队列。
 */
export function logMCPError(serverName: string, error: unknown): void {
  try {
    if (errorLogSink === null) {
      errorQueue.push({ type: 'mcpError', serverName, error })
      return
    }
    errorLogSink.logMCPError(serverName, error)
  } catch {
    // 静默失败
  }
}

/**
 * 记录 MCP 服务器调试信息（写入专用 MCP 日志文件）。
 * 若 Sink 未注入，缓存到队列。
 */
export function logMCPDebug(serverName: string, message: string): void {
  try {
    if (errorLogSink === null) {
      errorQueue.push({ type: 'mcpDebug', serverName, message })
      return
    }
    errorLogSink.logMCPDebug(serverName, message)
  } catch {
    // 静默失败
  }
}

// ── API 请求快照 ──────────────────────────────────────────────────────────

/**
 * 捕获最近一次 API 请求的参数快照，供错误报告使用。
 *
 * 仅捕获来自主线程 REPL（querySource 以 'repl_main_thread' 开头）的请求，
 * 忽略子代理和工具调用触发的 API 请求。
 *
 * 存储策略：
 *   - 所有用户：仅保存不含 messages 的参数（paramsWithoutMessages），
 *     避免在内存中持久化整个对话历史（messages 已写入会话记录文件）；
 *   - 内部 ant 用户：额外保存 messages 引用，供 /share 生成
 *     serialized_conversation.json 时捕获 API 实际收到的消息载荷。
 */
export function captureAPIRequest(
  params: BetaMessageStreamParams,
  querySource?: QuerySource,
): void {
  // 仅捕获主线程 REPL 请求（startsWith，兼容带输出样式后缀的变体）
  if (!querySource || !querySource.startsWith('repl_main_thread')) {
    return
  }

  // 分离 messages 字段，避免在全局状态中持久化整个对话历史
  const { messages, ...paramsWithoutMessages } = params
  setLastAPIRequest(paramsWithoutMessages)

  // 仅 ant 用户额外保存 messages（已有 dumpPrompts.ts 保留 5 次完整请求，不是新增保留类别）
  setLastAPIRequestMessages(process.env.USER_TYPE === 'ant' ? messages : null)
}

// ── 测试辅助 ──────────────────────────────────────────────────────────────

/**
 * 重置错误日志状态，仅供测试使用。
 * 清除 Sink 引用、事件队列和内存日志，确保测试间隔离。
 * @internal
 */
export function _resetErrorLogForTesting(): void {
  errorLogSink = null
  errorQueue.length = 0
  inMemoryErrorLog = []
}
