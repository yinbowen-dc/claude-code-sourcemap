/**
 * inProcessTeammateHelpers.ts — 进程内队友（In-Process Teammate）辅助工具模块
 *
 * 【在 Claude Code 系统流程中的位置】
 * 本文件位于工具层（utils），为"进程内队友"集成提供辅助函数。
 * "进程内队友"是一种特殊的子代理（sub-agent），与主代理运行在同一 Node.js 进程中，
 * 通过 AppState 和任务邮箱（TeammateMailbox）进行通信。
 *
 * 主要职责：
 *   1. findInProcessTeammateTaskId   — 按代理名称在 AppState 中定位任务 ID；
 *   2. setAwaitingPlanApproval       — 更新队友的"等待计划审批"状态；
 *   3. handlePlanApprovalResponse    — 处理计划审批响应，重置等待状态；
 *   4. isPermissionRelatedResponse   — 检测消息是否为权限相关响应，
 *                                      用于队友消息处理器的分支判断。
 *
 * 调用链：InProcessTeammateTask → 本模块 → updateTaskState / TeammateMailbox
 */

import type { AppState } from '../state/AppState.js'
import {
  type InProcessTeammateTaskState,
  isInProcessTeammateTask,
} from '../tasks/InProcessTeammateTask/types.js'
import { updateTaskState } from './task/framework.js'
import {
  isPermissionResponse,
  isSandboxPermissionResponse,
  type PlanApprovalResponseMessage,
} from './teammateMailbox.js'

// AppState 更新函数类型：接受一个旧状态 → 新状态的映射函数
type SetAppState = (updater: (prev: AppState) => AppState) => void

/**
 * 根据代理名称在 AppState 的任务列表中查找对应的进程内队友任务 ID。
 *
 * 遍历所有任务，通过 isInProcessTeammateTask 类型守卫过滤出进程内队友任务，
 * 再比对 identity.agentName 字段。
 *
 * @param agentName - 代理名称（如 "researcher"、"planner"）
 * @param appState  - 当前 AppState
 * @returns 若找到则返回任务 ID（UUID 字符串），否则返回 undefined
 */
export function findInProcessTeammateTaskId(
  agentName: string,
  appState: AppState,
): string | undefined {
  for (const task of Object.values(appState.tasks)) {
    if (
      isInProcessTeammateTask(task) &&       // 类型守卫：仅处理进程内队友任务
      task.identity.agentName === agentName  // 匹配代理名称
    ) {
      return task.id
    }
  }
  return undefined // 未找到匹配的队友任务
}

/**
 * 更新指定进程内队友任务的"等待计划审批"（awaitingPlanApproval）状态。
 *
 * 通过 updateTaskState 对 AppState 进行不可变更新（返回新对象而非修改原对象）。
 * 当队友发出计划并等待主代理审批时设为 true；收到响应后设为 false。
 *
 * @param taskId      - 进程内队友任务的 ID
 * @param setAppState - AppState 的 setter 函数
 * @param awaiting    - 是否正在等待计划审批
 */
export function setAwaitingPlanApproval(
  taskId: string,
  setAppState: SetAppState,
  awaiting: boolean,
): void {
  // 使用框架提供的类型安全 updateTaskState，确保只更新对应任务
  updateTaskState<InProcessTeammateTaskState>(taskId, setAppState, task => ({
    ...task,                          // 保留任务的其余状态字段
    awaitingPlanApproval: awaiting,   // 更新审批等待状态
  }))
}

/**
 * 处理进程内队友收到的计划审批响应消息。
 *
 * 职责：
 *   - 将 awaitingPlanApproval 重置为 false（审批流程结束）；
 *   - 响应中的 permissionMode 字段由代理循环（Task #11）单独处理，
 *     不在本函数中处理，保持职责单一。
 *
 * @param taskId    - 进程内队友任务的 ID
 * @param _response - 计划审批响应消息（当前仅用于未来扩展，故用 _ 前缀标识）
 * @param setAppState - AppState 的 setter 函数
 */
export function handlePlanApprovalResponse(
  taskId: string,
  _response: PlanApprovalResponseMessage,
  setAppState: SetAppState,
): void {
  // 重置等待状态：审批响应已到达，不再等待
  setAwaitingPlanApproval(taskId, setAppState, false)
}

// ══════════════════════════ 权限委托辅助函数 ══════════════════════════

/**
 * 检测一条消息文本是否为权限相关响应。
 *
 * 进程内队友的消息处理器需要识别来自团队领导（team leader）的权限响应，
 * 以便将其路由到权限处理逻辑，而非普通消息处理逻辑。
 *
 * 支持两种权限响应类型：
 *   - 工具权限响应（isPermissionResponse）：允许/拒绝使用某个工具；
 *   - 沙箱权限响应（isSandboxPermissionResponse）：允许/拒绝访问某个网络主机。
 *
 * @param messageText - 原始消息文本
 * @returns true 表示该消息是权限相关响应
 */
export function isPermissionRelatedResponse(messageText: string): boolean {
  return (
    // 检查是否为工具权限响应
    !!isPermissionResponse(messageText) ||
    // 检查是否为沙箱（网络主机）权限响应
    !!isSandboxPermissionResponse(messageText)
  )
}
