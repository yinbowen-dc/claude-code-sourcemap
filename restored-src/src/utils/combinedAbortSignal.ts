/**
 * 组合 AbortSignal 工具模块。
 *
 * 在 Claude Code 系统中，该模块提供将多个 AbortSignal 与可选超时合并为单一信号的能力：
 * - createCombinedAbortSignal()：合并主信号、可选第二信号及可选超时（timeoutMs），
 *   任一条件触发即中止，返回信号及清理函数以释放监听器和定时器
 *
 * 注：使用 setTimeout + clearTimeout 替代 AbortSignal.timeout()，
 * 避免 Bun 下原生计时器延迟 GC 导致的内存泄漏（约 2.4KB/次）。
 */
import { createAbortController } from './abortController.js'

/**
 * 创建一个组合 AbortSignal，当主信号中止、可选的第二个信号中止或超时到期时均会触发中止。
 * 返回组合信号及清理函数，清理函数可移除事件监听器并释放内部定时器。
 *
 * 建议使用 `timeoutMs` 参数而非传入 `AbortSignal.timeout(ms)`——
 * 在 Bun 环境下，`AbortSignal.timeout` 的原生定时器采用懒惰回收，
 * 在超时期间会持续占用约 2.4KB 原生内存。
 * 本实现使用 `setTimeout` + `clearTimeout`，确保定时器在 cleanup 后立即释放。
 */
export function createCombinedAbortSignal(
  signal: AbortSignal | undefined,
  opts?: { signalB?: AbortSignal; timeoutMs?: number },
): { signal: AbortSignal; cleanup: () => void } {
  const { signalB, timeoutMs } = opts ?? {}
  const combined = createAbortController()

  // 若任一输入信号已中止，立即中止组合信号并返回空清理函数
  if (signal?.aborted || signalB?.aborted) {
    combined.abort()
    return { signal: combined.signal, cleanup: () => {} }
  }

  let timer: ReturnType<typeof setTimeout> | undefined
  // 统一的中止处理器：清除定时器后触发组合信号中止
  const abortCombined = () => {
    if (timer !== undefined) clearTimeout(timer)
    combined.abort()
  }

  if (timeoutMs !== undefined) {
    // 设置超时定时器，并调用 unref() 避免阻止进程退出（Node.js/Bun 环境）
    timer = setTimeout(abortCombined, timeoutMs)
    timer.unref?.()
  }
  // 监听两个输入信号的 abort 事件，任一触发即中止组合信号
  signal?.addEventListener('abort', abortCombined)
  signalB?.addEventListener('abort', abortCombined)

  // 清理函数：移除监听器并清除定时器，防止内存泄漏
  const cleanup = () => {
    if (timer !== undefined) clearTimeout(timer)
    signal?.removeEventListener('abort', abortCombined)
    signalB?.removeEventListener('abort', abortCombined)
  }

  return { signal: combined.signal, cleanup }
}
