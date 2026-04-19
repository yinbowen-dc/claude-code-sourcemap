/**
 * 诊断日志模块（diagLogs.ts）
 *
 * 【在 Claude Code 系统流程中的位置】
 * 位于底层基础设施层，被 bootstrap、MCP 连接器、环境管理器等模块调用。
 * 在容器化部署场景下，日志通过 CLAUDE_CODE_DIAGNOSTICS_FILE 环境变量指定的
 * 文件路径传递给 session-ingress 监控服务，用于生产环境的运行状况追踪。
 *
 * 【主要功能】
 * 1. logForDiagnosticsNoPII()  —— 将结构化日志条目以 JSON Lines 格式同步写入诊断文件
 * 2. withDiagnosticsTiming()   —— 包装异步函数，自动记录开始/完成/失败事件及耗时
 *
 * 【重要约束】
 * 所有写入该日志的数据必须不含 PII（个人身份信息），包括文件路径、项目名、
 * 仓库名、用户提示词等，以保证合规性。
 */
import { dirname } from 'path'
import { getFsImplementation } from './fsOperations.js'
import { jsonStringify } from './slowOperations.js'

/** 诊断日志级别：debug / info / warn / error */
type DiagnosticLogLevel = 'debug' | 'info' | 'warn' | 'error'

/** 单条诊断日志条目的结构 */
type DiagnosticLogEntry = {
  /** ISO 8601 时间戳，精确到毫秒 */
  timestamp: string
  /** 日志级别，仅作展示用途，不做过滤 */
  level: DiagnosticLogLevel
  /** 事件名称，如 "started"、"mcp_connected" 等 */
  event: string
  /** 附加的键值对数据，所有值均不得含 PII */
  data: Record<string, unknown>
}

/**
 * 将不含 PII 的诊断信息写入日志文件。
 *
 * 【流程说明】
 * 1. 读取 CLAUDE_CODE_DIAGNOSTICS_FILE 环境变量获取日志路径；若未设置则直接返回。
 * 2. 构造包含时间戳、级别、事件名、附加数据的 DiagnosticLogEntry。
 * 3. 序列化为 JSON Line 后同步追加到日志文件。
 * 4. 若追加失败（通常是目录不存在），先创建目录再重试；仍失败则静默忽略。
 *
 * 【重要约束】此函数 **必须** 在同步上下文中调用，且写入数据不得含任何 PII。
 *
 * @param level    日志级别（仅用于展示，不做过滤）
 * @param event    具体事件名称，如 "started"、"mcp_connected"
 * @param data     可选的附加数据键值对
 */
// sync IO: called from sync context（同步 IO：在同步上下文中调用）
export function logForDiagnosticsNoPII(
  level: DiagnosticLogLevel,
  event: string,
  data?: Record<string, unknown>,
): void {
  // 获取诊断日志文件路径；若环境变量未设置则不写日志
  const logFile = getDiagnosticLogFile()
  if (!logFile) {
    return
  }

  // 构造结构化日志条目，data 缺省时使用空对象
  const entry: DiagnosticLogEntry = {
    timestamp: new Date().toISOString(), // 使用 ISO 8601 格式以便跨语言解析
    level,
    event,
    data: data ?? {},
  }

  // 获取文件系统实现（可能是真实 fs 或测试 mock）
  const fs = getFsImplementation()
  // 序列化为单行 JSON，加换行符使文件成为合法的 JSON Lines 格式
  const line = jsonStringify(entry) + '\n'
  try {
    // 优先尝试直接追加（目录已存在的快路径）
    fs.appendFileSync(logFile, line)
  } catch {
    // 追加失败时，尝试创建父级目录后重试
    try {
      fs.mkdirSync(dirname(logFile)) // 创建日志文件所在目录
      fs.appendFileSync(logFile, line) // 目录创建后重新追加
    } catch {
      // 如果仍然失败则静默忽略，避免诊断日志失败影响主流程
    }
  }
}

/**
 * 从环境变量中读取诊断日志文件路径。
 *
 * 返回 CLAUDE_CODE_DIAGNOSTICS_FILE 的值；若未设置则返回 undefined，
 * 表示当前环境不需要写诊断日志（如本地开发环境）。
 */
function getDiagnosticLogFile(): string | undefined {
  return process.env.CLAUDE_CODE_DIAGNOSTICS_FILE
}

/**
 * 用诊断计时日志包装一个异步函数。
 *
 * 【流程说明】
 * 1. 记录开始时间并写入 `{event}_started` 日志（info 级别）。
 * 2. 执行传入的异步函数 fn()。
 * 3. 成功时：调用可选的 getData() 提取结果元数据，写入 `{event}_completed`
 *    日志（含 duration_ms 耗时及额外数据）。
 * 4. 失败时：写入 `{event}_failed` 日志（error 级别，含 duration_ms），
 *    然后重新抛出原始错误以保留调用栈。
 *
 * @param event   事件名前缀，如 "git_status"，会生成 "git_status_started" 等日志
 * @param fn      要执行并计时的异步函数
 * @param getData 可选函数，从 fn() 的返回值中提取需要记录到 completed 日志的额外数据
 * @returns       fn() 的返回值（透传，不修改）
 */
export async function withDiagnosticsTiming<T>(
  event: string,
  fn: () => Promise<T>,
  getData?: (result: T) => Record<string, unknown>,
): Promise<T> {
  // 记录开始时间（毫秒级时间戳，用于后续计算 duration_ms）
  const startTime = Date.now()
  // 写入 {event}_started 日志，标记操作开始
  logForDiagnosticsNoPII('info', `${event}_started`)

  try {
    // 执行被包装的异步函数
    const result = await fn()
    // 如果提供了 getData，则从结果中提取额外的监控数据
    const additionalData = getData ? getData(result) : {}
    // 成功完成：写入 {event}_completed 日志，包含耗时和额外数据
    logForDiagnosticsNoPII('info', `${event}_completed`, {
      duration_ms: Date.now() - startTime, // 计算总耗时
      ...additionalData,                    // 展开附加数据（如结果行数、状态码等）
    })
    return result
  } catch (error) {
    // 执行失败：写入 {event}_failed 日志，记录失败耗时
    logForDiagnosticsNoPII('error', `${event}_failed`, {
      duration_ms: Date.now() - startTime, // 记录失败前已耗费的时间
    })
    // 重新抛出错误，确保调用方能正常处理异常（不吞错）
    throw error
  }
}
