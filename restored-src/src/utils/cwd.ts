/**
 * 当前工作目录管理模块。
 *
 * 在 Claude Code 系统中，该模块通过 AsyncLocalStorage 实现异步上下文隔离的工作目录覆盖：
 * - getCwd()：获取当前异步上下文的工作目录（优先取覆盖值，其次取 bootstrap state 中的 cwd）
 * - withCwdOverride()：在指定目录上下文中运行函数，子调用链继承该目录
 */
import { AsyncLocalStorage } from 'async_hooks'
import { getCwdState, getOriginalCwd } from '../bootstrap/state.js'

const cwdOverrideStorage = new AsyncLocalStorage<string>()

/**
 * Run a function with an overridden working directory for the current async context.
 * All calls to pwd()/getCwd() within the function (and its async descendants) will
 * return the overridden cwd instead of the global one. This enables concurrent
 * agents to each see their own working directory without affecting each other.
 */
export function runWithCwdOverride<T>(cwd: string, fn: () => T): T {
  return cwdOverrideStorage.run(cwd, fn)
}

/**
 * Get the current working directory
 */
export function pwd(): string {
  return cwdOverrideStorage.getStore() ?? getCwdState()
}

/**
 * Get the current working directory or the original working directory if the current one is not available
 */
export function getCwd(): string {
  try {
    return pwd()
  } catch {
    return getOriginalCwd()
  }
}
