/**
 * 文件：terminal-focus-state.ts
 *
 * 【在 Claude Code 系统流程中的位置】
 * 本文件位于 Ink 渲染层的终端焦点状态管理模块中。
 * 当终端通过 DECSET 1004（焦点事件模式）报告焦点变化时，
 * App.tsx 会调用此处的 `setTerminalFocused` 更新全局焦点状态，
 * 而 React 组件树则通过 `useSyncExternalStore` 订阅此状态来响应焦点切换。
 *
 * 【主要功能】
 * - 维护一个模块级别的焦点信号（`focusState`），无需经过 React 状态即可访问
 * - 'unknown'：默认值，适用于不支持焦点报告的终端（消费者将其等同于 'focused'）
 * - 同步通知所有订阅者（`useSyncExternalStore` 的 subscribe 回调）
 * - 导出：`setTerminalFocused`、`getTerminalFocused`、`getTerminalFocusState`、
 *         `subscribeTerminalFocus`、`resetTerminalFocusState`
 */

// 终端焦点状态信号 — 非 React 方式访问 DECSET 1004 焦点事件。
// 'unknown' 是不支持焦点上报的终端的默认值；
// 消费者将 'unknown' 等同于 'focused' 处理（不节流）。
// 当焦点变化时，订阅者会被同步通知，用于 TerminalFocusProvider 避免轮询。
export type TerminalFocusState = 'focused' | 'blurred' | 'unknown'

// 当前焦点状态，模块级别单例，初始为 'unknown'
let focusState: TerminalFocusState = 'unknown'
// 等待焦点恢复的 resolve 集合（当前未对外暴露，内部备用）
const resolvers: Set<() => void> = new Set()
// useSyncExternalStore 注册的订阅回调集合
const subscribers: Set<() => void> = new Set()

/**
 * 更新终端焦点状态并通知所有订阅者。
 *
 * 【流程】
 * 1. 根据传入布尔值将 focusState 更新为 'focused' 或 'blurred'
 * 2. 同步触发所有 subscribers 回调（供 useSyncExternalStore 驱动 React 重渲染）
 * 3. 若失焦（v=false），还需 resolve 所有等待焦点恢复的 Promise 并清空集合
 *
 * @param v true = 获得焦点，false = 失去焦点
 */
export function setTerminalFocused(v: boolean): void {
  focusState = v ? 'focused' : 'blurred'
  // 通知 useSyncExternalStore 订阅者触发 React 重渲染
  for (const cb of subscribers) {
    cb()
  }
  if (!v) {
    // 失焦时 resolve 所有等待焦点的挂起 Promise
    for (const resolve of resolvers) {
      resolve()
    }
    resolvers.clear()
  }
}

/**
 * 返回终端当前是否处于"获得焦点"状态。
 * 'unknown'（不支持焦点上报）也视为已聚焦，返回 true。
 */
export function getTerminalFocused(): boolean {
  return focusState !== 'blurred'
}

/**
 * 返回终端的三态焦点状态：'focused' | 'blurred' | 'unknown'。
 * 与 `getTerminalFocused` 不同，此函数保留 'unknown' 状态供精细判断使用。
 */
export function getTerminalFocusState(): TerminalFocusState {
  return focusState
}

/**
 * 注册一个 useSyncExternalStore 订阅回调。
 *
 * 每当 focusState 变化时，所有已注册的回调都会被同步调用，
 * React 内部会在回调触发后重新读取快照（getTerminalFocused/getTerminalFocusState）。
 *
 * @param cb 状态变化时调用的回调函数
 * @returns 取消订阅函数（从 subscribers 集合中移除 cb）
 */
// 供 useSyncExternalStore 使用
export function subscribeTerminalFocus(cb: () => void): () => void {
  subscribers.add(cb)
  return () => {
    subscribers.delete(cb)
  }
}

/**
 * 将焦点状态重置为 'unknown' 并通知所有订阅者。
 * 通常在测试清理或终端重新初始化时调用。
 */
export function resetTerminalFocusState(): void {
  focusState = 'unknown'
  for (const cb of subscribers) {
    cb()
  }
}
