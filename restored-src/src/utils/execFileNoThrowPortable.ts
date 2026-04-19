/**
 * 可移植同步命令执行模块（已废弃）。
 *
 * 【在 Claude Code 系统流程中的位置】
 * 本模块提供基于 execaSync 的同步命令执行能力，历史上用于需要阻塞等待
 * 结果的场景（如启动检查、构建脚本）。目前已标记为 @deprecated，
 * 通过 execFileNoThrow.ts 重新导出以保持向后兼容。
 *
 * 【与 execFileNoThrow.ts 的区别】
 * - execFileNoThrow.ts：异步执行，不阻塞事件循环，推荐使用
 * - 本模块：同步执行（execaSync），阻塞 Node.js 事件循环，不推荐
 *
 * 【废弃原因】
 * 同步 exec 调用会阻塞整个 Node.js 事件循环，导致：
 * - UI 响应延迟（Ink 渲染暂停）
 * - 触发 slowLogging 慢操作警告
 * - 在高并发场景下显著降低吞吐量
 *
 * 请改用 execa（直接调用，配合 { shell: true, reject: false }）。
 */
import { type Options as ExecaOptions, execaSync } from 'execa'
import { getCwd } from '../utils/cwd.js'
import { slowLogging } from './slowOperations.js'

/** 毫秒与秒的换算常量 */
const MS_IN_SECOND = 1000
/** 秒与分钟的换算常量 */
const SECONDS_IN_MINUTE = 60

/**
 * 同步执行选项类型定义。
 */
type ExecSyncOptions = {
  abortSignal?: AbortSignal           // 可选的取消信号，在执行前检查是否已中止
  timeout?: number                    // 超时毫秒数，默认 10 分钟
  input?: string                      // 作为 stdin 传入的字符串内容
  stdio?: ExecaOptions['stdio']       // stdio 配置，默认 ['ignore', 'pipe', 'pipe']
}

/**
 * 同步执行 shell 命令并返回 stdout 字符串的可移植函数（已废弃）。
 *
 * 【函数重载说明】
 * 支持三种调用签名以兼容旧代码：
 * 1. execSyncWithDefaults_DEPRECATED(command) — 仅命令，使用默认选项
 * 2. execSyncWithDefaults_DEPRECATED(command, options) — 新签名，传入选项对象
 * 3. execSyncWithDefaults_DEPRECATED(command, abortSignal, timeout) — 旧签名，分离传参
 *
 * 【流程】
 * 1. 解析入参，统一转换为 ExecSyncOptions 结构
 * 2. 检查 abortSignal 是否已中止（若已中止则抛出异常）
 * 3. 通过 slowLogging 记录慢操作开始（供性能监控使用）
 * 4. 调用 execaSync 同步执行命令，返回 stdout.trim()
 * 5. 若无输出或执行失败，返回 null
 *
 * @param command              - 要执行的 shell 命令字符串
 * @param optionsOrAbortSignal - 选项对象（新签名）或 AbortSignal（旧签名）
 * @param timeout              - 超时毫秒数（仅旧签名使用）
 * @returns stdout 的 trim 结果，无输出或失败时返回 null
 *
 * @deprecated 改用 execa（配合 { shell: true, reject: false }）以避免阻塞事件循环
 */
export function execSyncWithDefaults_DEPRECATED(command: string): string | null
/**
 * @deprecated 改用 execa（配合 { shell: true, reject: false }）以避免阻塞事件循环。
 */
export function execSyncWithDefaults_DEPRECATED(
  command: string,
  options: ExecSyncOptions,
): string | null
/**
 * @deprecated 改用 execa（配合 { shell: true, reject: false }）以避免阻塞事件循环。
 */
export function execSyncWithDefaults_DEPRECATED(
  command: string,
  abortSignal: AbortSignal,
  timeout?: number,
): string | null
/**
 * @deprecated 改用 execa（配合 { shell: true, reject: false }）以避免阻塞事件循环。
 * 同步调用会阻塞事件循环，引发性能问题。
 */
export function execSyncWithDefaults_DEPRECATED(
  command: string,
  optionsOrAbortSignal?: ExecSyncOptions | AbortSignal,
  timeout = 10 * SECONDS_IN_MINUTE * MS_IN_SECOND,
): string | null {
  let options: ExecSyncOptions

  // 统一解析入参为 ExecSyncOptions 对象
  if (optionsOrAbortSignal === undefined) {
    // 无第二个参数——使用默认选项
    options = {}
  } else if (optionsOrAbortSignal instanceof AbortSignal) {
    // 旧签名——第二个参数为 AbortSignal
    options = {
      abortSignal: optionsOrAbortSignal,
      timeout,
    }
  } else {
    // 新签名——第二个参数为选项对象
    options = optionsOrAbortSignal
  }

  // 解构选项，设置默认值
  const {
    abortSignal,
    timeout: finalTimeout = 10 * SECONDS_IN_MINUTE * MS_IN_SECOND,
    input,
    stdio = ['ignore', 'pipe', 'pipe'], // 默认忽略 stdin，捕获 stdout/stderr
  } = options

  // 若已收到取消信号，立即抛出（在阻塞调用前检查）
  abortSignal?.throwIfAborted()
  // 记录慢操作开始，命令截断至 200 字符以避免日志过长
  using _ = slowLogging`exec: ${command.slice(0, 200)}`
  try {
    // 调用 execaSync 同步执行命令（阻塞事件循环）
    const result = execaSync(command, {
      env: process.env,        // 继承父进程环境变量
      maxBuffer: 1_000_000,    // 最大输出缓冲区 1MB
      timeout: finalTimeout,
      cwd: getCwd(),           // 使用当前工作目录
      stdio,
      shell: true,             // 通过 shell 执行，支持管道、重定向等特性
      reject: false,           // 非零退出码不抛出异常
      input,                   // 可选的 stdin 内容
    })
    // 无输出时返回 null（避免返回空字符串引发上层误判）
    if (!result.stdout) {
      return null
    }
    // trim 后若为空字符串也返回 null
    return result.stdout.trim() || null
  } catch {
    // 任何未预期的异常（如 shell 不存在）都吞掉，返回 null
    return null
  }
}
