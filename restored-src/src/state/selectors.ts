/**
 * AppState 派生状态选择器模块
 *
 * 在 Claude Code 的状态管理体系中，本文件处于纯计算层：
 * - 上层：输入路由逻辑（REPL、PromptInput 等）调用本模块的选择器，
 *         决定用户输入应发往哪个 Agent（leader / viewed / named_agent）
 * - 本层：提供纯函数选择器，从 AppState 中推导计算状态，无任何副作用
 * - 依赖层：AppStateStore.ts 提供 AppState 类型定义；
 *           InProcessTeammateTask/types.ts 提供 teammate 任务类型
 *
 * 设计原则：
 * - 选择器始终为纯函数，仅做数据提取，不修改状态
 * - 使用 Pick<AppState, ...> 最小化依赖字段，便于测试
 * - 返回类型使用判别联合（discriminated union），确保调用方的 switch 穷举
 */

import type { InProcessTeammateTaskState } from '../tasks/InProcessTeammateTask/types.js'
import { isInProcessTeammateTask } from '../tasks/InProcessTeammateTask/types.js'
import type { LocalAgentTaskState } from '../tasks/LocalAgentTask/LocalAgentTask.js'
import type { AppState } from './AppStateStore.js'

/**
 * 获取当前正在查看的 teammate 任务状态。
 *
 * 三种情况返回 undefined：
 * 1. viewingAgentTaskId 未设置（未在查看任何 teammate）
 * 2. tasks 中不存在该 ID 对应的任务
 * 3. 对应任务不是 in-process teammate 类型（如 local_agent）
 *
 * @param appState 包含 viewingAgentTaskId 和 tasks 字段的 AppState 子集
 * @returns        当前查看的 InProcessTeammateTaskState，或 undefined
 */
export function getViewedTeammateTask(
  appState: Pick<AppState, 'viewingAgentTaskId' | 'tasks'>,
): InProcessTeammateTaskState | undefined {
  const { viewingAgentTaskId, tasks } = appState

  // 未在查看任何 teammate，直接返回
  if (!viewingAgentTaskId) {
    return undefined
  }

  // 在任务表中查找该 ID
  const task = tasks[viewingAgentTaskId]
  if (!task) {
    return undefined
  }

  // 类型守卫：确认为 in-process teammate 任务（排除 local_agent 等其他类型）
  if (!isInProcessTeammateTask(task)) {
    return undefined
  }

  return task
}

/**
 * getActiveAgentForInput 选择器的返回类型。
 *
 * 判别联合类型，三个分支分别对应不同的输入路由目标：
 * - leader：主 Agent（未查看任何 teammate 时的默认路由）
 * - viewed：正在查看的 in-process teammate（输入转发给该 Agent）
 * - named_agent：按名称标识的本地 Agent 任务
 */
export type ActiveAgentForInput =
  | { type: 'leader' }
  | { type: 'viewed'; task: InProcessTeammateTaskState }
  | { type: 'named_agent'; task: LocalAgentTaskState }

/**
 * 决定用户输入应路由到哪个 Agent。
 *
 * 优先级：
 * 1. 若正在查看 in-process teammate → 返回 { type: 'viewed', task }
 * 2. 若正在查看 local_agent → 返回 { type: 'named_agent', task }
 * 3. 其余情况 → 返回 { type: 'leader' }（输入交给主 Agent 处理）
 *
 * @param appState 完整的 AppState
 * @returns        ActiveAgentForInput 判别联合，指示输入路由目标
 */
export function getActiveAgentForInput(
  appState: AppState,
): ActiveAgentForInput {
  // 优先检查 in-process teammate（远程协作任务）
  const viewedTask = getViewedTeammateTask(appState)
  if (viewedTask) {
    return { type: 'viewed', task: viewedTask }
  }

  // 再检查本地 Agent（named agent，local_agent 类型任务）
  const { viewingAgentTaskId, tasks } = appState
  if (viewingAgentTaskId) {
    const task = tasks[viewingAgentTaskId]
    if (task?.type === 'local_agent') {
      return { type: 'named_agent', task }
    }
  }

  // 默认：用户输入发往主 Agent（leader）
  return { type: 'leader' }
}
