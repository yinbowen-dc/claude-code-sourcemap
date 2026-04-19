/**
 * 同步执行包装模块（已废弃）。
 *
 * 【在 Claude Code 系统流程中的位置】
 * 本模块对 Node.js 内置的 child_process.execSync 进行了薄层封装，
 * 添加了慢操作日志记录（slowLogging），作为系统中所有需要同步执行
 * 外部命令的统一入口（替代直接调用 execSync）。
 *
 * 位于基础设施层底部，仅依赖 slowOperations.ts 和 Node.js 内置模块。
 * 上层工具如需同步执行，应通过本模块而非直接调用 execSync，
 * 以便统一追踪阻塞操作的性能影响。
 *
 * 【废弃原因与迁移建议】
 * 同步 exec 会阻塞整个 Node.js 事件循环，造成：
 * - Ink UI 渲染卡顿
 * - 性能监控中出现慢操作告警
 * 应使用异步替代方案（如 execa / execFileNoThrow）重构相关调用。
 *
 * @deprecated 尽可能使用异步替代方案，同步执行会阻塞事件循环。
 */
import {
  type ExecSyncOptions,
  type ExecSyncOptionsWithBufferEncoding,
  type ExecSyncOptionsWithStringEncoding,
  execSync as nodeExecSync,
} from 'child_process'
import { slowLogging } from './slowOperations.js'

/**
 * 带慢操作日志的 execSync 包装函数（已废弃）。
 *
 * 【功能】
 * 在调用原生 execSync 的前后，通过 slowLogging 模板字面量标记
 * 慢操作区间（using 语句在作用域结束时自动释放），帮助性能监控
 * 工具识别并告警阻塞时间过长的同步命令。
 *
 * 【重载说明】
 * 完整镜像 Node.js execSync 的类型重载，保证类型安全：
 * 1. 无选项：返回 Buffer
 * 2. StringEncoding 选项：返回 string
 * 3. BufferEncoding 选项：返回 Buffer
 * 4. 通用选项：返回 Buffer | string
 *
 * @example
 * import { execSync_DEPRECATED } from './execSyncWrapper.js'
 * const result = execSync_DEPRECATED('git status', { encoding: 'utf8' })
 *
 * @param command - 要在 shell 中执行的命令字符串
 * @param options - Node.js execSync 的标准选项
 * @returns 命令输出（Buffer 或 string，取决于 encoding 选项）
 *
 * @deprecated 请使用异步替代方案，同步调用会阻塞事件循环。
 */
export function execSync_DEPRECATED(command: string): Buffer
export function execSync_DEPRECATED(
  command: string,
  options: ExecSyncOptionsWithStringEncoding,
): string
export function execSync_DEPRECATED(
  command: string,
  options: ExecSyncOptionsWithBufferEncoding,
): Buffer
export function execSync_DEPRECATED(
  command: string,
  options?: ExecSyncOptions,
): Buffer | string
export function execSync_DEPRECATED(
  command: string,
  options?: ExecSyncOptions,
): Buffer | string {
  // 通过 using 语句标记慢操作区间，命令截断至 100 字符避免日志过长
  // slowLogging 在作用域结束（return 后）时自动记录结束时间
  using _ = slowLogging`execSync: ${command.slice(0, 100)}`
  // 直接委托给 Node.js 原生 execSync，不做额外处理
  return nodeExecSync(command, options)
}
