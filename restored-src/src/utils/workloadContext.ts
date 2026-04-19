/**
 * 基于 AsyncLocalStorage 的工作负载上下文标记模块。
 *
 * 在 Claude Code 系统流程中的位置：
 * 此模块为每个对话轮次（turn）提供隔离的工作负载标签（workload tag），
 * 通过 AsyncLocalStorage 实现跨异步操作的上下文传播。
 * 被 cron 任务调度、分析上报等需要区分工作负载来源的模块调用。
 *
 * 主要功能：
 * - getWorkload：获取当前异步上下文中的工作负载标签
 * - runWithWorkload：在新的 ALS 边界内执行函数，隔离工作负载上下文
 *
 * 为何使用独立模块而非 bootstrap/state.ts：
 * bootstrap 被 src/entrypoints/browser-sdk.ts 传递导入，
 * 浏览器打包不能引入 Node.js 的 async_hooks 模块。
 * 此模块仅在 CLI/SDK 代码路径中导入，不会进入浏览器构建。
 *
 * 为何使用 AsyncLocalStorage 而非全局可变变量：
 * 后台 agent（executeForkedSlashCommand、AgentTool）在首个 await 处
 * 让出执行权，父轮次的同步后续（含 finally 块）先于后台闭包恢复执行。
 * 在闭包顶部调用 setWorkload('cron') 会被确定性地覆盖。
 * ALS 在调用时捕获上下文，在整个异步链中持久存在且与父轮次隔离。
 */

import { AsyncLocalStorage } from 'async_hooks'

/**
 * 服务端 sanitizer（claude_code.py 中的 _sanitize_entrypoint）
 * 仅接受小写 [a-z0-9_-]{0,32} 格式。大写字符会在第 0 个字符处停止解析。
 */
export type Workload = 'cron'
// cron 工作负载标识常量
export const WORKLOAD_CRON: Workload = 'cron'

// ALS 存储：每个异步上下文持有独立的 workload 值
const workloadStorage = new AsyncLocalStorage<{
  workload: string | undefined
}>()

/**
 * 获取当前异步上下文中的工作负载标签。
 *
 * 流程：
 * 1. 从 AsyncLocalStorage 获取当前 store
 * 2. 若 store 存在，返回其中的 workload 值（可能为 undefined）
 * 3. 若不在任何 ALS 上下文中，返回 undefined
 *
 * @returns 当前工作负载标签，或 undefined（无上下文时）
 */
export function getWorkload(): string | undefined {
  // 通过可选链安全读取当前 store 的 workload 值
  return workloadStorage.getStore()?.workload
}

/**
 * 在指定工作负载的 ALS 上下文中执行函数。
 * 无论 workload 是否为 undefined，始终建立新的 ALS 边界。
 *
 * 为何必须始终调用 .run() 而非短路返回 fn()：
 * 若调用者已处于泄漏的 cron 上下文中（REPL: queryGuard.end() →
 * _notify() → React 订阅者 → 调度的重渲染捕获 ALS → useQueueProcessor
 * effect → executeQueuedInput → 此处），直接 return fn() 是透传而非边界。
 * 泄漏的上下文会粘性传播：每轮结束通知将环境上下文传播到下一轮的调度链。
 * 始终调用 .run() 保证 fn() 内的 getWorkload() 精确返回调用者传入的值
 * （包括 undefined）。
 *
 * @param workload 要绑定的工作负载标签（或 undefined 表示无标签）
 * @param fn 要在新上下文边界内执行的函数
 * @returns fn 的返回值
 */
export function runWithWorkload<T>(
  workload: string | undefined,
  fn: () => T,
): T {
  // 始终通过 .run() 建立新的 ALS 边界，即使 workload 为 undefined
  return workloadStorage.run({ workload }, fn)
}
