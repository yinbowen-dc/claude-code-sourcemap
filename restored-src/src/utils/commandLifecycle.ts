/**
 * 命令生命周期事件模块。
 *
 * 在 Claude Code 系统中，该模块维护一个全局单例监听器，
 * 用于跟踪命令（以 UUID 标识）的 started/completed 状态变化：
 * - setCommandLifecycleListener()：注册生命周期监听回调（传 null 可注销）
 * - notifyCommandLifecycle()：触发生命周期事件通知已注册的监听器
 */
// 命令生命周期状态类型：started 表示命令已开始，completed 表示命令已完成
type CommandLifecycleState = 'started' | 'completed'

// 生命周期监听器函数类型：接收命令 UUID 和状态变更通知
type CommandLifecycleListener = (
  uuid: string,
  state: CommandLifecycleState,
) => void

// 全局单例监听器，同一时刻只允许注册一个监听回调
let listener: CommandLifecycleListener | null = null

/**
 * 注册命令生命周期监听器，用于感知命令 started/completed 状态变化。
 * 传入 null 可注销当前监听器。同一时刻只保留一个监听回调。
 * @param cb - 监听回调函数，传 null 则注销
 */
export function setCommandLifecycleListener(
  cb: CommandLifecycleListener | null,
): void {
  listener = cb
}

/**
 * 触发命令生命周期事件，通知已注册的监听器命令状态变更。
 * 若无监听器则静默忽略（可选链调用）。
 * @param uuid - 命令的唯一标识符
 * @param state - 当前生命周期状态（started 或 completed）
 */
export function notifyCommandLifecycle(
  uuid: string,
  state: CommandLifecycleState,
): void {
  listener?.(uuid, state)
}
