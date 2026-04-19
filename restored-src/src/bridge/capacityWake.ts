/**
 * capacityWake.ts — Bridge 轮询循环的容量满载唤醒原语
 *
 * 在 Claude Code 系统流程中的位置：
 *   Bridge 轮询循环（replBridge.ts / bridgeMain.ts）
 *     └─> capacityWake.ts（本文件）——提供共享的"满载睡眠 + 提前唤醒"机制
 *
 * 背景：
 *   replBridge.ts 和 bridgeMain.ts 的轮询循环在"满载"时需要休眠等待，
 *   但在以下两种情况下需要提前唤醒：
 *     (a) 外部循环的 AbortSignal 触发（进程关闭）；
 *     (b) 容量释放（会话结束 / 传输层断开）。
 *   本模块封装了可变的唤醒控制器和双信号合并逻辑，
 *   避免两个轮询循环各自重复实现字节级相同的代码。
 *
 * Shared capacity-wake primitive for bridge poll loops.
 *
 * Both replBridge.ts and bridgeMain.ts need to sleep while "at capacity"
 * but wake early when either (a) the outer loop signal aborts (shutdown),
 * or (b) capacity frees up (session done / transport lost). This module
 * encapsulates the mutable wake-controller + two-signal merger that both
 * poll loops previously duplicated byte-for-byte.
 */

/**
 * 满载等待期间的信号句柄。
 * - signal：合并后的 AbortSignal（外部关闭 OR 容量释放时触发）；
 * - cleanup：正常唤醒后调用，移除事件监听器防止内存泄漏。
 */
export type CapacitySignal = { signal: AbortSignal; cleanup: () => void }

/**
 * 容量唤醒控制器接口。
 * 由 createCapacityWake 创建，注入到轮询循环中。
 */
export type CapacityWake = {
  /**
   * Create a signal that aborts when either the outer loop signal or the
   * capacity-wake controller fires. Returns the merged signal and a cleanup
   * function that removes listeners when the sleep resolves normally
   * (without abort).
   *
   * 创建合并信号：当外部关闭信号或容量唤醒控制器触发时，合并信号即 abort。
   * 返回合并信号和清理函数（正常唤醒后调用，移除事件监听）。
   */
  signal(): CapacitySignal
  /**
   * Abort the current at-capacity sleep and arm a fresh controller so the
   * poll loop immediately re-checks for new work.
   *
   * 中止当前满载睡眠并重置控制器，使轮询循环立即重新检查是否有新任务。
   */
  wake(): void
}

/**
 * 创建容量唤醒控制器。
 *
 * 内部维护一个可替换的 AbortController（wakeController），
 * 每次 wake() 时中止旧控制器并创建新的——新一轮满载睡眠会绑定到新控制器，
 * 旧一轮的唤醒不会影响下一次睡眠。
 *
 * @param outerSignal 外部进程关闭信号，与容量唤醒信号进行 OR 合并
 */
export function createCapacityWake(outerSignal: AbortSignal): CapacityWake {
  let wakeController = new AbortController()

  /**
   * 触发容量唤醒：中止当前控制器（唤醒正在睡眠的循环），
   * 并立即创建新控制器（为下一次睡眠准备）。
   */
  function wake(): void {
    wakeController.abort()
    wakeController = new AbortController()
  }

  /**
   * 合并外部关闭信号和当前容量唤醒信号，返回合并后的 AbortSignal。
   *
   * 若任一信号已触发，则立即返回已 abort 的合并信号。
   * 否则监听两个信号，任意一个触发时中止合并控制器。
   * cleanup 函数在正常唤醒后移除监听器，防止内存泄漏。
   */
  function signal(): CapacitySignal {
    const merged = new AbortController()
    const abort = (): void => merged.abort()
    // 快速路径：若任一信号已触发，立即返回已 abort 的合并信号
    if (outerSignal.aborted || wakeController.signal.aborted) {
      merged.abort()
      return { signal: merged.signal, cleanup: () => {} }
    }
    // 注册两个信号的监听器，任意触发时 abort 合并信号
    outerSignal.addEventListener('abort', abort, { once: true })
    const capSig = wakeController.signal
    capSig.addEventListener('abort', abort, { once: true })
    return {
      signal: merged.signal,
      // cleanup：正常唤醒（非 abort）时移除监听器
      cleanup: () => {
        outerSignal.removeEventListener('abort', abort)
        capSig.removeEventListener('abort', abort)
      },
    }
  }

  return { signal, wake }
}
