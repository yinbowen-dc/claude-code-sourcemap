/**
 * 分类器审批状态 React Hook 模块。
 *
 * 在 Claude Code 系统中，该模块提供 useIsClassifierChecking() React Hook，
 * 从 classifierApprovals.ts 中订阅分类器检查信号，供 UI 组件实时感知工具调用的检查状态。
 * 从 classifierApprovals.ts 拆分的原因：避免 permissions.ts / toolExecution.ts 等纯状态
 * 模块在导入时将 React 拉入 print.ts 的依赖图。
 */

import { useSyncExternalStore } from 'react'
import {
  isClassifierChecking,
  subscribeClassifierChecking,
} from './classifierApprovals.js'

/**
 * React Hook：实时感知指定工具调用是否正在被分类器检查。
 *
 * 工作原理：
 * 1. 通过 useSyncExternalStore 订阅 classifierApprovals.ts 导出的
 *    subscribeClassifierChecking 信号；每当 setClassifierChecking /
 *    clearClassifierChecking / clearClassifierApprovals 被调用时，
 *    信号触发，React 同步重新读取快照。
 * 2. 快照函数 () => isClassifierChecking(toolUseID) 在每次渲染时读取
 *    CLASSIFIER_CHECKING Set 的当前状态，保证 UI 与状态严格同步（不撕裂）。
 *
 * @param toolUseID 要查询的工具调用唯一 ID
 * @returns 若该工具调用当前正在分类器检查中则返回 true，否则返回 false
 */
export function useIsClassifierChecking(toolUseID: string): boolean {
  // useSyncExternalStore：第一个参数为订阅函数，第二个为同步读取当前值的快照函数
  return useSyncExternalStore(subscribeClassifierChecking, () =>
    isClassifierChecking(toolUseID),
  )
}
