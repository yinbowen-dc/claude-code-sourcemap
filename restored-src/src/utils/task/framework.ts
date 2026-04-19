/**
 * 任务生命周期管理框架（framework.ts）
 *
 * 【在 Claude Code 系统流程中的位置】
 * 本模块是 Claude Code 任务系统的核心调度层，处于 AppState 状态管理与
 * 各具体任务类型（Bash、Agent、Workflow 等）之间的中间层。
 * 它提供统一的任务注册、状态更新、轮询、通知入队和任务驱逐机制，
 * 是所有异步后台任务在 UI 层可见的基础设施。
 *
 * 【主要职责】
 * 1. 维护 AppState 中 tasks 字典的读写操作（updateTaskState、registerTask）；
 * 2. 为完成/终止的任务生成 XML 格式的通知消息（enqueueTaskNotification）；
 * 3. 异步轮询运行中任务的输出增量并更新偏移（generateTaskAttachments、pollTasks）；
 * 4. 安全驱逐已终止且已通知的任务（evictTerminalTask、applyTaskOffsetsAndEvictions）；
 * 5. 向 SDK 事件队列发送 task_started 事件（registerTask 内部）。
 */

import {
  OUTPUT_FILE_TAG,
  STATUS_TAG,
  SUMMARY_TAG,
  TASK_ID_TAG,
  TASK_NOTIFICATION_TAG,
  TASK_TYPE_TAG,
  TOOL_USE_ID_TAG,
} from '../../constants/xml.js'
import type { AppState } from '../../state/AppState.js'
import {
  isTerminalTaskStatus,
  type TaskStatus,
  type TaskType,
} from '../../Task.js'
import type { TaskState } from '../../tasks/types.js'
import { enqueuePendingNotification } from '../messageQueueManager.js'
import { enqueueSdkEvent } from '../sdkEventQueue.js'
import { getTaskOutputDelta, getTaskOutputPath } from './diskOutput.js'

/** 所有任务的标准轮询间隔（毫秒） */
export const POLL_INTERVAL_MS = 1000

/** 已终止（killed）任务在驱逐前在 UI 中保留的展示时长（毫秒） */
export const STOPPED_DISPLAY_MS = 3_000

/** Coordinator 面板中终止的 local_agent 任务的宽限期（毫秒），防止过早驱逐 */
export const PANEL_GRACE_MS = 30_000

/**
 * 任务状态更新的附件类型（用于推送通知）。
 */
export type TaskAttachment = {
  type: 'task_status'
  taskId: string
  toolUseId?: string
  taskType: TaskType
  status: TaskStatus
  description: string
  deltaSummary: string | null // 自上次附件以来的新输出内容
}

type SetAppState = (updater: (prev: AppState) => AppState) => void

/**
 * 更新 AppState 中指定任务的状态（泛型，类型安全）。
 *
 * 【执行流程】
 * 1. 在 AppState 更新函数中查找指定 taskId 的任务；
 * 2. 若任务不存在则返回原状态（无变化）；
 * 3. 调用 updater 计算新状态；
 * 4. 若 updater 返回相同引用（即 no-op），也返回原状态，
 *    避免触发 tasks 订阅者的不必要重新渲染。
 *
 * @param taskId      - 要更新的任务 ID
 * @param setAppState - AppState 的 setter 函数
 * @param updater     - 状态变换函数（接收旧状态返回新状态）
 */
export function updateTaskState<T extends TaskState>(
  taskId: string,
  setAppState: SetAppState,
  updater: (task: T) => T,
): void {
  setAppState(prev => {
    const task = prev.tasks?.[taskId] as T | undefined
    if (!task) {
      // 任务不存在，不做任何修改
      return prev
    }
    const updated = updater(task)
    if (updated === task) {
      // updater 返回相同引用（提前返回的 no-op），跳过 spread 避免不必要重渲染
      return prev
    }
    return {
      ...prev,
      tasks: {
        ...prev.tasks,
        [taskId]: updated,
      },
    }
  })
}

/**
 * 向 AppState 注册新任务，并向 SDK 事件队列发送 task_started 事件。
 *
 * 【执行流程】
 * 1. 在 AppState 更新函数中检查是否已存在同 ID 的任务（判断是否为替换操作）；
 * 2. 若存在旧任务且其带有 'retain' 字段（LocalAgentTaskState），
 *    保留 retain、startTime、messages、diskLoaded、pendingMessages 等 UI 状态，
 *    防止恢复后端（resumeAgentBackground）替换任务时重置用户已积累的状态；
 * 3. 将合并后的任务写入 AppState；
 * 4. 若是替换操作（不是首次注册），跳过 SDK 事件发送以防止重复触发。
 *
 * @param task        - 要注册的任务状态对象
 * @param setAppState - AppState 的 setter 函数
 */
export function registerTask(task: TaskState, setAppState: SetAppState): void {
  let isReplacement = false
  setAppState(prev => {
    const existing = prev.tasks[task.id]
    isReplacement = existing !== undefined
    // 若旧任务有 retain 字段，合并保留 UI 状态（排序、消息、加载状态）
    const merged =
      existing && 'retain' in existing
        ? {
            ...task,
            retain: existing.retain,
            startTime: existing.startTime,
            messages: existing.messages,
            diskLoaded: existing.diskLoaded,
            pendingMessages: existing.pendingMessages,
          }
        : task
    return { ...prev, tasks: { ...prev.tasks, [task.id]: merged } }
  })

  // 替换操作（恢复场景）不发送 task_started，避免重复触发
  if (isReplacement) return

  enqueueSdkEvent({
    type: 'system',
    subtype: 'task_started',
    task_id: task.id,
    tool_use_id: task.toolUseId,
    description: task.description,
    task_type: task.type,
    workflow_name:
      'workflowName' in task
        ? (task.workflowName as string | undefined)
        : undefined,
    prompt: 'prompt' in task ? (task.prompt as string) : undefined,
  })
}

/**
 * 主动驱逐 AppState 中已完成且已通知的终止任务，释放内存。
 *
 * 不同于 generateTaskAttachments 中的懒惰 GC，此函数用于任务完成后
 * 立即触发清理（如在 STOPPED_DISPLAY_MS 计时器回调中调用）。
 * generateTaskAttachments 中的懒惰 GC 作为安全网保留。
 *
 * 【执行流程】
 * 1. 查找指定任务，若不存在则返回；
 * 2. 若任务状态非终止态，返回（防止误驱逐运行中任务）；
 * 3. 若 notified 为 false，返回（任务通知尚未发送）；
 * 4. 若任务带有 'retain' 字段且 evictAfter 宽限期尚未到，返回；
 * 5. 从 tasks 字典中删除该任务。
 *
 * @param taskId      - 要驱逐的任务 ID
 * @param setAppState - AppState 的 setter 函数
 */
export function evictTerminalTask(
  taskId: string,
  setAppState: SetAppState,
): void {
  setAppState(prev => {
    const task = prev.tasks?.[taskId]
    if (!task) return prev
    // 只能驱逐处于终止状态的任务
    if (!isTerminalTaskStatus(task.status)) return prev
    // 只有已发送通知的任务才能驱逐
    if (!task.notified) return prev
    // Panel 宽限期：'retain' 字段仅存在于 LocalAgentTaskState；
    // evictAfter 是可选字段，用 'evictAfter' in task 会漏掉未设置的情况
    if ('retain' in task && (task.evictAfter ?? Infinity) > Date.now()) {
      return prev
    }
    // 从 tasks 字典中移除，释放内存
    const { [taskId]: _, ...remainingTasks } = prev.tasks
    return { ...prev, tasks: remainingTasks }
  })
}

/**
 * 获取 AppState 中所有处于运行中状态的任务列表。
 *
 * @param state - 当前 AppState 快照
 * @returns 所有 status 为 'running' 的任务状态数组
 */
export function getRunningTasks(state: AppState): TaskState[] {
  const tasks = state.tasks ?? {}
  return Object.values(tasks).filter(task => task.status === 'running')
}

/**
 * 为有新输出或状态变化的任务生成附件列表（推送通知的核心逻辑）。
 *
 * 【执行流程】
 * 1. 遍历 AppState 中的所有任务；
 * 2. 对已标记为 notified 的任务：
 *    - 终止态（completed/failed/killed）：收集到 evictedTaskIds，等待驱逐；
 *    - pending：保留在映射中不处理；
 *    - running：继续向下处理增量输出；
 * 3. 对运行中任务，异步读取输出文件增量，更新 updatedTaskOffsets；
 * 4. 注意：已完成的任务不在此处发送通知，各任务类型在自己的完成回调中
 *    负责发送通知，避免与 per-type 回调竞争导致双重通知。
 *
 * @param state - 当前 AppState 快照
 * @returns attachments、updatedTaskOffsets、evictedTaskIds 三个结果集合
 */
export async function generateTaskAttachments(state: AppState): Promise<{
  attachments: TaskAttachment[]
  // 仅返回偏移补丁，而非完整任务快照。任务在 getTaskOutputDelta 的异步磁盘读取期间
  // 可能转换为 completed 状态，用旧快照覆盖会导致僵尸任务（转换被抹去）。
  updatedTaskOffsets: Record<string, number>
  evictedTaskIds: string[]
}> {
  const attachments: TaskAttachment[] = []
  const updatedTaskOffsets: Record<string, number> = {}
  const evictedTaskIds: string[] = []
  const tasks = state.tasks ?? {}

  for (const taskState of Object.values(tasks)) {
    if (taskState.notified) {
      switch (taskState.status) {
        case 'completed':
        case 'failed':
        case 'killed':
          // 已通知的终止任务：收集到待驱逐列表，本次循环不继续处理
          evictedTaskIds.push(taskState.id)
          continue
        case 'pending':
          // 已通知但 pending 的任务：保留在映射中，等待启动
          continue
        case 'running':
          // 已通知但仍在运行：继续获取新输出
          break
      }
    }

    if (taskState.status === 'running') {
      // 读取自上次偏移以来的新输出
      const delta = await getTaskOutputDelta(
        taskState.id,
        taskState.outputOffset,
      )
      if (delta.content) {
        updatedTaskOffsets[taskState.id] = delta.newOffset
      }
    }

    // 已完成的任务通知不在此处发送——各任务类型通过 enqueuePendingNotification()
    // 在自己的完成回调中处理，避免此处的生成逻辑与 per-type 回调竞争产生双重通知
  }

  return { attachments, updatedTaskOffsets, evictedTaskIds }
}

/**
 * 将 generateTaskAttachments 返回的偏移补丁和驱逐列表应用到 AppState。
 *
 * 【设计原因】
 * 必须在最新的 prev.tasks 上（而非 await 前的旧快照上）合并偏移补丁，
 * 防止 generateTaskAttachments 的异步 I/O 期间发生的状态转换被覆盖。
 *
 * 【执行流程】
 * 1. 若两个列表均为空，提前返回（避免触发不必要的状态更新）；
 * 2. 在 setAppState 中，对每个偏移更新重新验证任务仍处于 running 状态；
 * 3. 对每个待驱逐任务重新验证 TOCTOU 条件（恢复操作可能已替换该任务）；
 * 4. 只有实际发生变化时才返回新对象（避免无变化触发重渲染）。
 *
 * @param setAppState         - AppState 的 setter 函数
 * @param updatedTaskOffsets  - taskId → 新偏移 的映射
 * @param evictedTaskIds      - 待驱逐的任务 ID 数组
 */
export function applyTaskOffsetsAndEvictions(
  setAppState: SetAppState,
  updatedTaskOffsets: Record<string, number>,
  evictedTaskIds: string[],
): void {
  const offsetIds = Object.keys(updatedTaskOffsets)
  if (offsetIds.length === 0 && evictedTaskIds.length === 0) {
    // 没有需要应用的变更，提前返回
    return
  }
  setAppState(prev => {
    let changed = false
    const newTasks = { ...prev.tasks }
    for (const id of offsetIds) {
      const fresh = newTasks[id]
      // 重新检查最新状态：若任务已完成，偏移更新无意义
      if (fresh?.status === 'running') {
        newTasks[id] = { ...fresh, outputOffset: updatedTaskOffsets[id]! }
        changed = true
      }
    }
    for (const id of evictedTaskIds) {
      const fresh = newTasks[id]
      // TOCTOU 检查：generateTaskAttachments await 期间恢复操作可能已替换任务
      if (!fresh || !isTerminalTaskStatus(fresh.status) || !fresh.notified) {
        continue
      }
      // Panel 宽限期检查（仅 LocalAgentTaskState 有 retain 字段）
      if ('retain' in fresh && (fresh.evictAfter ?? Infinity) > Date.now()) {
        continue
      }
      delete newTasks[id]
      changed = true
    }
    // 仅在实际有变化时返回新对象，避免无变化触发订阅者重渲染
    return changed ? { ...prev, tasks: newTasks } : prev
  })
}

/**
 * 主任务轮询函数：获取附件列表、应用偏移更新和驱逐，并发送通知。
 *
 * 【执行流程】
 * 1. 获取当前 AppState 快照；
 * 2. 调用 generateTaskAttachments() 异步生成附件列表；
 * 3. 调用 applyTaskOffsetsAndEvictions() 将偏移和驱逐应用到最新状态；
 * 4. 对每个附件调用 enqueueTaskNotification() 入队通知。
 *
 * @param getAppState - 获取当前 AppState 的函数
 * @param setAppState - AppState 的 setter 函数
 */
export async function pollTasks(
  getAppState: () => AppState,
  setAppState: SetAppState,
): Promise<void> {
  const state = getAppState()
  const { attachments, updatedTaskOffsets, evictedTaskIds } =
    await generateTaskAttachments(state)

  applyTaskOffsetsAndEvictions(setAppState, updatedTaskOffsets, evictedTaskIds)

  // 将已完成任务的通知发送到消息队列
  for (const attachment of attachments) {
    enqueueTaskNotification(attachment)
  }
}

/**
 * 将任务状态更新通知入队到消息队列（XML 格式）。
 *
 * 【XML 结构】
 * 生成包含 task_id、tool_use_id（可选）、task_type、output_file、
 * status 和 summary 的 XML 通知字符串，供上层消息处理器解析。
 *
 * 【执行流程】
 * 1. 调用 getStatusText() 获取人类可读的状态文本；
 * 2. 获取任务输出文件路径；
 * 3. 拼接 XML 通知字符串；
 * 4. 以 'task-notification' 模式入队到待发送消息队列。
 *
 * @param attachment - 要通知的任务附件数据
 */
function enqueueTaskNotification(attachment: TaskAttachment): void {
  const statusText = getStatusText(attachment.status)

  const outputPath = getTaskOutputPath(attachment.taskId)
  // tool_use_id 可选字段：仅在存在时添加对应 XML 标签
  const toolUseIdLine = attachment.toolUseId
    ? `\n<${TOOL_USE_ID_TAG}>${attachment.toolUseId}</${TOOL_USE_ID_TAG}>`
    : ''
  const message = `<${TASK_NOTIFICATION_TAG}>
<${TASK_ID_TAG}>${attachment.taskId}</${TASK_ID_TAG}>${toolUseIdLine}
<${TASK_TYPE_TAG}>${attachment.taskType}</${TASK_TYPE_TAG}>
<${OUTPUT_FILE_TAG}>${outputPath}</${OUTPUT_FILE_TAG}>
<${STATUS_TAG}>${attachment.status}</${STATUS_TAG}>
<${SUMMARY_TAG}>Task "${attachment.description}" ${statusText}</${SUMMARY_TAG}>
</${TASK_NOTIFICATION_TAG}>`

  enqueuePendingNotification({ value: message, mode: 'task-notification' })
}

/**
 * 将任务状态码转换为人类可读的描述文本。
 *
 * @param status - 任务状态枚举值
 * @returns 对应的英文描述字符串
 */
function getStatusText(status: TaskStatus): string {
  switch (status) {
    case 'completed':
      return 'completed successfully'
    case 'failed':
      return 'failed'
    case 'killed':
      return 'was stopped'
    case 'running':
      return 'is running'
    case 'pending':
      return 'is pending'
  }
}
