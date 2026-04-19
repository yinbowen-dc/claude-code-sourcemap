/**
 * 优雅关闭清理函数注册表模块。
 *
 * 在 Claude Code 系统中，该模块维护一个全局清理函数集合，
 * 在进程优雅关闭（gracefulShutdown.ts）时依次执行所有已注册的清理操作：
 * - registerCleanup()：注册一个异步清理函数，返回反注册函数
 * - runCleanupFunctions()：并行执行所有已注册的清理函数
 *
 * 从 gracefulShutdown.ts 拆分的原因：避免循环依赖。
 */

// 全局清理函数集合，进程优雅关闭时会依次执行所有已注册的清理操作
const cleanupFunctions = new Set<() => Promise<void>>()

/**
 * 注册一个优雅关闭时需要执行的异步清理函数。
 * @param cleanupFn - 需要在清理阶段执行的函数（可为同步或异步）
 * @returns 反注册函数，调用后将从注册表中移除该清理处理器
 */
export function registerCleanup(cleanupFn: () => Promise<void>): () => void {
  cleanupFunctions.add(cleanupFn)
  return () => cleanupFunctions.delete(cleanupFn) // 返回反注册函数，供调用方在不再需要时注销
}

/**
 * 并行执行所有已注册的清理函数。
 * 由 gracefulShutdown.ts 在进程退出前调用，确保资源得到释放。
 */
export async function runCleanupFunctions(): Promise<void> {
  // 并行执行所有清理函数，避免串行等待造成关闭超时
  await Promise.all(Array.from(cleanupFunctions).map(fn => fn()))
}
