/**
 * 【文件定位】InProcessTeammateTask/types.ts — 进程内队友任务的类型定义层
 *
 * 在 Claude Code 系统流程中的位置：
 *   Swarm 多智能体架构（utils/swarm/）→ 进程内队友（InProcess Teammate）
 *   → 任务状态持久化到 AppState → UI 展示（TeammateSpinnerTree / PromptInput）
 *
 * 主要职责：
 *   定义进程内队友任务的身份结构（TeammateIdentity）、完整任务状态（InProcessTeammateTaskState）、
 *   类型守卫函数（isInProcessTeammateTask）以及对话历史消息上限（TEAMMATE_MESSAGES_UI_CAP）
 *   和带容量限制的消息追加工具函数（appendCappedMessage）。
 *
 *   与 LocalAgentTask 的区别：InProcess Teammate 在同一 Node.js 进程中运行，
 *   使用 AsyncLocalStorage 进行隔离，而非派生子进程。
 */

import type { TaskStateBase } from '../../Task.js'
import type { AgentToolResult } from '../../tools/AgentTool/agentToolUtils.js'
import type { AgentDefinition } from '../../tools/AgentTool/loadAgentsDir.js'
import type { Message } from '../../types/message.js'
import type { PermissionMode } from '../../utils/permissions/PermissionMode.js'
import type { AgentProgress } from '../LocalAgentTask/LocalAgentTask.js'

/**
 * 队友身份信息，存储在任务状态中。
 *
 * 与运行时的 TeammateContext（AsyncLocalStorage）同构，但作为普通数据存入 AppState，
 * 不持有 AsyncLocalStorage 引用，仅用于状态持久化与 UI 展示。
 */
export type TeammateIdentity = {
  agentId: string            // 队友的全局唯一 ID，例如 "researcher@my-team"
  agentName: string          // 队友名称，例如 "researcher"
  teamName: string           // 所属团队名称
  color?: string             // UI 展示颜色（可选）
  planModeRequired: boolean  // 是否要求进入计划模式审批流
  parentSessionId: string    // 领导者（Leader）的会话 ID
}

/**
 * 进程内队友任务的完整状态结构。
 *
 * 继承 TaskStateBase（包含 id、status、startTime 等通用字段），
 * 并扩展了身份、执行参数、运行时控制器、消息历史、生命周期等字段。
 */
export type InProcessTeammateTaskState = TaskStateBase & {
  type: 'in_process_teammate'

  // Identity as sub-object (matches TeammateContext shape for consistency)
  // Stored as plain data in AppState, NOT a reference to AsyncLocalStorage
  // 身份信息作为子对象存储，与 TeammateContext 结构一致，但不持有 AsyncLocalStorage 引用
  identity: TeammateIdentity

  // Execution
  prompt: string              // 队友的初始提示词
  // Optional model override for this teammate
  model?: string              // 可选：此队友使用的模型（覆盖默认值）
  // Optional: Only set if teammate uses a specific agent definition
  // Many teammates run as general-purpose agents without a predefined definition
  selectedAgent?: AgentDefinition          // 可选：预定义的 Agent 定义（通用 Agent 不设此项）
  abortController?: AbortController       // 运行时：中止整个队友的控制器（不序列化到磁盘）
  currentWorkAbortController?: AbortController  // 运行时：中止当前轮次但不杀死队友
  unregisterCleanup?: () => void           // 运行时：进程退出时的清理注销函数

  // Plan mode approval tracking (planModeRequired is in identity)
  awaitingPlanApproval: boolean  // 是否正在等待计划模式审批

  // Permission mode for this teammate (cycled independently via Shift+Tab when viewing)
  permissionMode: PermissionMode  // 队友的权限模式（查看时可通过 Shift+Tab 独立切换）

  // State
  error?: string                 // 错误信息（失败时设置）
  result?: AgentToolResult       // 执行结果（复用 AgentToolResult，因为队友通过 runAgent() 运行）
  progress?: AgentProgress       // 进度信息（工具调用数、token 数、最近活动等）

  // Conversation history for zoomed view (NOT mailbox messages)
  // Mailbox messages are stored separately in teamContext.inProcessMailboxes
  // 放大查看模式的对话历史（非邮箱消息，邮箱消息存储在 teamContext.inProcessMailboxes）
  messages?: Message[]

  // Tool use IDs currently being executed (for animation in transcript view)
  inProgressToolUseIDs?: Set<string>  // 当前正在执行的工具调用 ID 集合（用于转录视图动画）

  // Queue of user messages to deliver when viewing teammate transcript
  pendingUserMessages: string[]  // 查看队友转录时待投递的用户消息队列

  // UI: random spinner verbs (stable across re-renders, shared between components)
  spinnerVerb?: string      // UI 加载动画动词（跨重渲染稳定，多组件共享）
  pastTenseVerb?: string    // UI 完成状态动词

  // Lifecycle
  isIdle: boolean             // 是否处于空闲状态（等待新工作）
  shutdownRequested: boolean  // 是否已请求关闭

  // Callbacks to notify when teammate becomes idle (runtime only)
  // Used by leader to efficiently wait without polling
  // 队友变为空闲时的回调函数数组（运行时，不序列化），Leader 用此避免轮询等待
  onIdleCallbacks?: Array<() => void>

  // Progress tracking (for computing deltas in notifications)
  lastReportedToolCount: number   // 上次通知时的工具调用总数（用于计算增量）
  lastReportedTokenCount: number  // 上次通知时的 token 总数（用于计算增量）
}

/**
 * 类型守卫：判断未知对象是否为 InProcessTeammateTaskState。
 * 检查 type 字段是否为 'in_process_teammate'。
 */
export function isInProcessTeammateTask(
  task: unknown,
): task is InProcessTeammateTaskState {
  return (
    typeof task === 'object' &&
    task !== null &&
    'type' in task &&
    task.type === 'in_process_teammate'  // 仅当 type 匹配时返回 true
  )
}

/**
 * AppState UI 镜像中保留的最大消息数上限。
 *
 * task.messages 仅为放大查看对话框服务，只需近期上下文。
 * 完整对话历史存储在 inProcessRunner 的本地 allMessages 数组以及磁盘上的
 * 代理转录文件中。
 *
 * 性能背景（BQ 分析，第 9 轮，2026-03-20）：
 *   - 500+ 轮会话每个代理约消耗 ~20MB RSS
 *   - Swarm 并发高峰每个代理约 ~125MB
 *   - 鲸鱼会话 9a990de8 在 2 分钟内启动 292 个代理，达到 36.8GB
 *   主要成本来自此数组持有每条消息的第二份完整副本
 */
export const TEAMMATE_MESSAGES_UI_CAP = 50

/**
 * 向消息数组追加一条消息，并将结果上限控制在 TEAMMATE_MESSAGES_UI_CAP 条，
 * 超出时丢弃最旧的消息。始终返回新数组（符合 AppState 不可变性要求）。
 *
 * 流程：
 *   1. 若 prev 为 undefined 或为空，直接返回包含新消息的单元素数组
 *   2. 若 prev.length >= 上限，截取最近 (上限 - 1) 条后追加新消息
 *   3. 否则展开 prev 并追加新消息
 *
 * @param prev - 现有消息数组（只读，可为 undefined）
 * @param item - 要追加的新消息
 * @returns 新的消息数组
 */
export function appendCappedMessage<T>(
  prev: readonly T[] | undefined,
  item: T,
): T[] {
  if (prev === undefined || prev.length === 0) {
    // 初始情况：直接返回单元素数组
    return [item]
  }
  if (prev.length >= TEAMMATE_MESSAGES_UI_CAP) {
    // 已达上限：截取最近 (上限 - 1) 条，再追加新消息
    const next = prev.slice(-(TEAMMATE_MESSAGES_UI_CAP - 1))
    next.push(item)
    return next
  }
  // 未达上限：展开原数组并追加新消息，保持不可变性
  return [...prev, item]
}
