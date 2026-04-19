/**
 * AbortController 工厂与父子关联工具模块。
 *
 * 在 Claude Code 系统中，AbortController 贯穿从用户取消操作到底层 API
 * 请求/shell 进程终止的整个链路。该模块提供：
 * 1. 带事件监听器上限配置的 AbortController 工厂（避免 MaxListenersExceededWarning）
 * 2. 内存安全的父子 AbortController 关联：父 abort → 子自动 abort，
 *    同时通过 WeakRef 确保废弃的子控制器可以被 GC，不产生内存泄漏
 */
import { setMaxListeners } from 'events'

/**
 * 默认最大监听器数量（标准操作场景）
 */
const DEFAULT_MAX_LISTENERS = 50

/**
 * 创建一个已配置好监听器上限的 AbortController。
 * 当多个监听器附加到 abort 信号时，可防止 MaxListenersExceededWarning。
 *
 * Creates an AbortController with proper event listener limits set.
 * @param maxListeners - 最大监听器数量（默认 50）
 * @returns 已配置监听器上限的 AbortController
 */
export function createAbortController(
  maxListeners: number = DEFAULT_MAX_LISTENERS,
): AbortController {
  const controller = new AbortController()
  setMaxListeners(maxListeners, controller.signal)
  return controller
}

/**
 * 将父控制器的 abort 传播到弱引用持有的子控制器。
 * 父子均以 WeakRef 持有，双向均不产生强引用阻止 GC。
 * 模块作用域函数可避免每次调用都分配闭包对象。
 */
function propagateAbort(
  this: WeakRef<AbortController>,
  weakChild: WeakRef<AbortController>,
): void {
  const parent = this.deref()
  // 将父信号的 reason 传递给子控制器
  weakChild.deref()?.abort(parent?.signal.reason)
}

/**
 * 从弱引用持有的父信号中移除 abort 处理函数。
 * 父和处理函数均以 WeakRef 持有；若任一已被 GC 或父已 abort（once: true），
 * 此函数为无操作。模块作用域函数可避免每次调用都分配闭包对象。
 */
function removeAbortHandler(
  this: WeakRef<AbortController>,
  weakHandler: WeakRef<(...args: unknown[]) => void>,
): void {
  const parent = this.deref()
  const handler = weakHandler.deref()
  if (parent && handler) {
    parent.signal.removeEventListener('abort', handler)
  }
}

/**
 * 创建一个子 AbortController，当父控制器 abort 时子控制器自动 abort。
 * 中止子控制器不会影响父控制器。
 *
 * 内存安全：通过 WeakRef 持有，父不会阻止废弃子控制器的 GC。
 * 若子控制器在未 abort 的情况下被丢弃，仍可正常被 GC。
 * 当子控制器被 abort 时，父监听器会被自动移除，防止死处理函数累积。
 *
 * Creates a child AbortController that aborts when its parent aborts.
 * @param parent - 父 AbortController
 * @param maxListeners - 最大监听器数量（默认 50）
 * @returns 子 AbortController
 */
export function createChildAbortController(
  parent: AbortController,
  maxListeners?: number,
): AbortController {
  const child = createAbortController(maxListeners)

  // 快速路径：父已 abort，无需注册监听器
  if (parent.signal.aborted) {
    child.abort(parent.signal.reason)
    return child
  }

  // WeakRef prevents the parent from keeping an abandoned child alive.
  // If all strong references to child are dropped without aborting it,
  // the child can still be GC'd — the parent only holds a dead WeakRef.
  const weakChild = new WeakRef(child)
  const weakParent = new WeakRef(parent)
  // 绑定 handler：父 abort 时将原因传播给子
  const handler = propagateAbort.bind(weakParent, weakChild)

  // {once: true}：父 abort 后自动移除监听器
  parent.signal.addEventListener('abort', handler, { once: true })

  // Auto-cleanup: remove parent listener when child is aborted (from any source).
  // Both parent and handler are weakly held — if either has been GC'd or the
  // parent already aborted ({once: true}), the cleanup is a harmless no-op.
  child.signal.addEventListener(
    'abort',
    removeAbortHandler.bind(weakParent, new WeakRef(handler)),
    { once: true },
  )

  return child
}
