/**
 * 通用外部存储工厂模块
 *
 * 在 Claude Code 的状态管理体系中，本文件处于最底层的基础设施层：
 * - 上层：AppState.tsx 调用 createStore 创建 AppStateStore 实例，
 *         并通过 React Context 将其分发给整个组件树
 * - 本层：提供轻量级的发布-订阅存储原语，与 React 解耦，任何非 React 代码均可使用
 * - 协作层：AppState.tsx 中的 useAppState(selector) 通过 useSyncExternalStore
 *           接入 store.subscribe，实现细粒度响应式更新
 *
 * 设计原则：
 * - 极简接口：仅暴露 getState / setState / subscribe 三个方法
 * - Object.is 比较：相同引用的状态更新直接跳过，避免无效通知
 * - 函数式更新：setState 接收 updater 函数，保证更新基于最新状态
 */

/** 订阅者回调类型：状态发生变化时被调用，不携带任何参数 */
type Listener = () => void

/** 状态变化副作用回调类型：在通知 React 订阅者之前执行，携带新旧状态 */
type OnChange<T> = (args: { newState: T; oldState: T }) => void

/**
 * 通用存储接口。
 *
 * - getState：直接读取当前状态快照（同步，无 hook）
 * - setState：通过 updater 函数原子更新状态
 * - subscribe：注册监听器，返回取消订阅函数（方便 useEffect cleanup）
 */
export type Store<T> = {
  getState: () => T
  setState: (updater: (prev: T) => T) => void
  subscribe: (listener: Listener) => () => void
}

/**
 * 创建一个通用外部存储实例。
 *
 * 流程：
 * 1. 以 initialState 初始化内部状态变量
 * 2. 维护一个 Set<Listener> 存放所有订阅者
 * 3. setState 时：执行 updater → Object.is 检测变化 →
 *    若有变化则更新状态、触发 onChange 副作用、通知所有订阅者
 * 4. subscribe 时：将监听器加入 Set，返回删除该监听器的闭包
 *
 * @param initialState 状态初始值
 * @param onChange     可选的副作用回调（如 onChangeAppState），在通知订阅者前调用
 * @returns            Store<T> 实例
 */
export function createStore<T>(
  initialState: T,
  onChange?: OnChange<T>,
): Store<T> {
  let state = initialState               // 当前状态，闭包私有
  const listeners = new Set<Listener>() // 订阅者集合，Set 自动去重

  return {
    /** 直接返回当前状态引用（O(1)，无复制） */
    getState: () => state,

    setState: (updater: (prev: T) => T) => {
      const prev = state
      const next = updater(prev)
      if (Object.is(next, prev)) return  // 状态未变化，跳过所有后续操作
      state = next
      onChange?.({ newState: next, oldState: prev }) // 先触发副作用（如持久化）
      for (const listener of listeners) listener()   // 再通知所有 React 订阅者
    },

    subscribe: (listener: Listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener) // 返回取消订阅函数，供 useEffect cleanup 使用
    },
  }
}
