/**
 * SDK 事件队列模块 (sdkEventQueue.ts)
 *
 * 在 Claude Code 系统流程中的位置：
 *   AI 执行层 → 子任务生命周期 → 【本模块：SDK 事件队列】→ 流式输出层（drainSdkEvents）
 *
 * 主要职责：
 *   1. 在无头/流式（headless/streaming）模式下，收集子任务的生命周期事件
 *   2. 支持四类事件：task_started / task_progress / task_notification / session_state_changed
 *   3. 限制队列长度（MAX_QUEUE_SIZE=1000），溢出时淘汰最旧事件
 *   4. 提供 drainSdkEvents() 批量取出所有待发送事件（附加 uuid + session_id）
 *   5. 提供 emitTaskTerminatedSdk() 便捷封装，供子任务终止路径调用
 *
 * 与其他模块的关系：
 *   - enqueueSdkEvent 被任务注册/进度/状态变更路径调用
 *   - drainSdkEvents 被流式输出层周期性消费，将事件附加到响应流
 *   - TUI 交互式模式下不使用此队列（事件永远不会被消费）
 */

import type { UUID } from 'crypto'
import { randomUUID } from 'crypto'
import { getIsNonInteractiveSession, getSessionId } from '../bootstrap/state.js'
import type { SdkWorkflowProgress } from '../types/tools.js'

// 子任务启动事件：当子代理任务开始执行时入队
type TaskStartedEvent = {
  type: 'system'
  subtype: 'task_started'
  task_id: string
  tool_use_id?: string
  description: string
  task_type?: string
  workflow_name?: string
  prompt?: string
}

// 子任务进度事件：周期性上报 token 使用量、工具调用数、运行时间等
type TaskProgressEvent = {
  type: 'system'
  subtype: 'task_progress'
  task_id: string
  tool_use_id?: string
  description: string
  usage: {
    total_tokens: number
    tool_uses: number
    duration_ms: number
  }
  last_tool_name?: string
  summary?: string
  // workflow_progress：增量批次，客户端按 `${type}:${index}` upsert 后
  // 按 phaseIndex 分组重建阶段树（与 PhaseProgress.tsx 中的 collectFromEvents + groupByPhase 逻辑一致）
  workflow_progress?: SdkWorkflowProgress[]
}

// 子任务终止通知事件：前台代理完成且未被后台化时发出。
// 由 drainSdkEvents() 直接注入输出流，不经过 print.ts 的 XML task_notification 解析器，
// 也不触发 LLM 循环。消费方（如 VS Code session.ts）用此事件从子代理面板中移除任务。
type TaskNotificationSdkEvent = {
  type: 'system'
  subtype: 'task_notification'
  task_id: string
  tool_use_id?: string
  status: 'completed' | 'failed' | 'stopped'
  output_file: string
  summary: string
  usage?: {
    total_tokens: number
    tool_uses: number
    duration_ms: number
  }
}

// 会话状态变更事件：反映主轮次生成器的空闲/运行/等待操作状态。
// 'idle' 信号在 heldBackResult 刷新且 bg-agent do-while 循环退出后发出，
// SDK 消费方（scmuxd、VS Code）可将其视为"本轮结束"的权威信号。
type SessionStateChangedEvent = {
  type: 'system'
  subtype: 'session_state_changed'
  state: 'idle' | 'running' | 'requires_action'
}

// SDK 事件联合类型，涵盖所有可入队的事件
export type SdkEvent =
  | TaskStartedEvent
  | TaskProgressEvent
  | TaskNotificationSdkEvent
  | SessionStateChangedEvent

// 队列容量上限：防止无人消费时内存无界增长
const MAX_QUEUE_SIZE = 1000
// 模块级队列，进程生命周期内持续存在
const queue: SdkEvent[] = []

/**
 * 将 SDK 事件入队。
 *
 * 流程：
 *   1. 仅在非交互式（无头/流式）会话中入队；TUI 模式下事件不会被消费，跳过入队
 *   2. 队列已满时淘汰最旧事件（shift），确保最新事件始终能入队
 *   3. 将事件追加到队尾
 *
 * @param event 要入队的 SDK 事件
 */
export function enqueueSdkEvent(event: SdkEvent): void {
  // TUI 交互模式下事件不会被消费，无需入队（防止无界内存增长）
  if (!getIsNonInteractiveSession()) {
    return
  }
  // 队列已满：淘汰最旧事件，为新事件腾出空间
  if (queue.length >= MAX_QUEUE_SIZE) {
    queue.shift()
  }
  queue.push(event)
}

/**
 * 批量取出队列中所有事件，并为每个事件附加唯一标识符。
 *
 * 流程：
 *   1. 队列为空时直接返回空数组（快速路径）
 *   2. splice(0) 原子性地清空队列并取出所有事件
 *   3. 为每个事件注入 uuid（全局唯一）和 session_id（当前会话标识）
 *
 * @returns 附加了 uuid 和 session_id 的事件数组
 */
export function drainSdkEvents(): Array<
  SdkEvent & { uuid: UUID; session_id: string }
> {
  if (queue.length === 0) {
    return []
  }
  // 原子清空队列，避免并发读写竞争
  const events = queue.splice(0)
  return events.map(e => ({
    ...e,
    uuid: randomUUID(),        // 全局唯一 ID，供消费方去重
    session_id: getSessionId(), // 绑定到当前会话
  }))
}

/**
 * 向 SDK 事件队列发送子任务终止通知（task_notification）。
 *
 * 使用场景：
 *   - registerTask() 总会发出 task_started 事件，本函数是其对应的"结束书签"
 *   - 仅在以下路径调用：不走 print.ts XML task_notification 解析器的终止路径
 *     （已预设 notified:true、kill 路径、abort 分支），避免与 print.ts 路径双重发送
 *   - SDK 消费方（Scuttle 后台任务指示点、VS Code 子代理面板）依赖此事件感知任务关闭
 *
 * @param taskId   任务 ID
 * @param status   终止状态（completed / failed / stopped）
 * @param opts     可选附加信息（toolUseId、summary、outputFile、usage）
 */
export function emitTaskTerminatedSdk(
  taskId: string,
  status: 'completed' | 'failed' | 'stopped',
  opts?: {
    toolUseId?: string
    summary?: string
    outputFile?: string
    usage?: { total_tokens: number; tool_uses: number; duration_ms: number }
  },
): void {
  enqueueSdkEvent({
    type: 'system',
    subtype: 'task_notification',
    task_id: taskId,
    tool_use_id: opts?.toolUseId,
    status,
    output_file: opts?.outputFile ?? '',
    summary: opts?.summary ?? '',
    usage: opts?.usage,
  })
}
