/**
 * @file useCommandQueue.ts
 *
 * 【在 Claude Code 系统流程中的位置】
 * 该 Hook 位于命令调度层，是 React 组件与外部命令队列（messageQueueManager）之间的桥梁。
 * 通过 React 18 的 useSyncExternalStore 订阅外部命令队列的变更，
 * 确保组件在队列发生变化时精准重渲染，避免不必要的 re-render。
 *
 * 数据流向：
 *   外部命令队列（messageQueueManager）→ subscribeToCommandQueue → useCommandQueue → React 组件
 *
 * 主要职责：
 *  - 将外部可变的命令队列以不可变只读数组的形式暴露给 React 组件
 *  - 仅在队列引用发生变化时触发组件重渲染（frozen array + 引用更新策略）
 */

import { useSyncExternalStore } from 'react'
import type { QueuedCommand } from '../types/textInputTypes.js'
import {
  getCommandQueueSnapshot,
  subscribeToCommandQueue,
} from '../utils/messageQueueManager.js'

/**
 * React hook to subscribe to the unified command queue.
 * Returns a frozen array that only changes reference on mutation.
 * Components re-render only when the queue changes.
 *
 * 订阅统一命令队列的 React Hook。
 * 返回一个冻结的只读数组，仅在队列内容发生变更时更新引用，
 * 确保组件只在必要时重渲染，提升性能。
 *
 * 实现原理：
 *  - subscribeToCommandQueue：向外部队列注册监听器，队列变化时触发 re-render
 *  - getCommandQueueSnapshot：返回当前队列的快照（frozen 数组）
 *  - useSyncExternalStore：React 18 提供的并发安全外部存储订阅 API
 *
 * @returns 当前命令队列的只读快照
 */
export function useCommandQueue(): readonly QueuedCommand[] {
  // 使用 useSyncExternalStore 订阅外部命令队列：
  // 第一个参数：订阅函数，队列变化时通知 React 重渲染
  // 第二个参数：快照获取函数，返回当前队列的冻结副本
  return useSyncExternalStore(subscribeToCommandQueue, getCommandQueueSnapshot)
}
