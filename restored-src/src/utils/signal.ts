/**
 * 轻量级事件信号原语模块。
 *
 * 在 Claude Code 系统中，该模块被多处复用，例如 skillChangeDetector 用它
 * 发布技能文件变更通知，其他模块可订阅以响应变更事件。
 *
 * 核心设计思路：
 * - 与 Store（AppState/createStore）不同，Signal 不保存状态快照，
 *   仅传递"某事发生了"的通知，可携带泛型参数。
 * - 将 ~8 行重复的 listeners Set + subscribe/notify 样板代码
 *   折叠为一行 createSignal() 调用，消除了代码库中 ~15 处重复。
 *
 * 主要导出：
 * - `Signal<Args>` 类型：包含 subscribe / emit / clear 三个操作
 * - `createSignal<Args>()`：工厂函数，返回一个新的 Signal 实例
 */

/** Signal 类型：带泛型参数的事件信号，支持订阅、触发和清空 */
export type Signal<Args extends unknown[] = []> = {
  /** 订阅监听器，返回取消订阅函数 */
  subscribe: (listener: (...args: Args) => void) => () => void
  /** 触发所有已订阅的监听器，传入指定参数 */
  emit: (...args: Args) => void
  /** 移除所有监听器，用于 dispose/reset 路径 */
  clear: () => void
}

/**
 * 创建一个新的 Signal 实例。
 *
 * 内部维护一个 listeners Set，subscribe 向 Set 中添加回调并返回
 * 自动删除该回调的取消订阅函数；emit 遍历 Set 依次调用所有回调；
 * clear 清空整个 Set，释放所有引用。
 *
 * @template Args 事件参数类型元组，默认为空（无参数）
 */
export function createSignal<Args extends unknown[] = []>(): Signal<Args> {
  // 用 Set 存储所有监听器，避免重复注册同一引用
  const listeners = new Set<(...args: Args) => void>()
  return {
    subscribe(listener) {
      // 添加监听器到 Set
      listeners.add(listener)
      // 返回取消订阅函数，调用后从 Set 中移除该监听器
      return () => {
        listeners.delete(listener)
      }
    },
    emit(...args) {
      // 遍历所有监听器并依次调用
      for (const listener of listeners) listener(...args)
    },
    clear() {
      // 清空所有监听器，释放引用
      listeners.clear()
    },
  }
}
