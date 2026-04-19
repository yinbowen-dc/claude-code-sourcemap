/**
 * 【文件定位】LocalShellTask/guards.ts — Shell 任务状态类型定义与类型守卫
 *
 * 在 Claude Code 系统流程中的位置：
 *   BashTool / MonitorTool → spawnShellTask（LocalShellTask.tsx）→ 注册到任务框架
 *   → 本文件提供 LocalShellTaskState 类型及 isLocalShellTask 守卫
 *
 * 主要职责：
 *   定义 BashTaskKind、LocalShellTaskState 类型以及 isLocalShellTask 类型守卫。
 *   从 LocalShellTask.tsx 中提取为独立文件，目的是让非 React 消费方
 *   （如 stopTask.ts、killShellTasks.ts、print.ts）能够直接引用这些类型，
 *   而不会将 React/Ink 模块引入其模块图，避免打包体积膨胀和不必要的副作用。
 */

// 纯类型 + 类型守卫，专为 LocalShellTask 状态服务。
// 从 LocalShellTask.tsx 中提取，使非 React 消费方（stopTask.ts 通过 print.ts）
// 不会将 React/Ink 拉入其模块图。

import type { TaskStateBase } from '../../Task.js'
import type { AgentId } from '../../types/ids.js'
import type { ShellCommand } from '../../utils/ShellCommand.js'

/**
 * Shell 任务的显示变体：
 *   'bash'    — 普通 bash 命令任务（展示命令文本，底部胶囊显示 "shell"）
 *   'monitor' — 监控任务（展示描述文本，对话框标题为 "Monitor details"，胶囊显示 "monitor"）
 */
export type BashTaskKind = 'bash' | 'monitor'

/**
 * LocalShellTask 的完整状态结构，继承 TaskStateBase（id、status、startTime 等通用字段）。
 *
 * 字段说明：
 *   - type：固定为 'local_bash'（保持向后兼容，持久化会话状态中已使用此值）
 *   - command：执行的 shell 命令字符串
 *   - result：命令退出结果（退出码 + 是否被中断），命令运行中时为 undefined
 *   - completionStatusSentInAttachment：是否已在附件中发送完成状态（防止重复通知）
 *   - shellCommand：运行中的 ShellCommand 实例（终止后置为 null）
 *   - lastReportedTotalLines：上次上报时的总输出行数，用于计算增量（来自 TaskOutput）
 *   - isBackgrounded：false = 前台运行中；true = 已后台化
 *   - agentId：派生本任务的 agent ID，主线程任务为 undefined
 *     用于 agent 退出时清理其孤儿 bash 任务（见 killShellTasksForAgent）
 *   - kind：UI 展示变体（'bash' 或 'monitor'）
 */
export type LocalShellTaskState = TaskStateBase & {
  type: 'local_bash' // 保持为 'local_bash' 以兼容已持久化的会话状态
  command: string
  result?: {
    code: number         // 进程退出码
    interrupted: boolean // 是否被 SIGINT/SIGKILL 中断
  }
  completionStatusSentInAttachment: boolean  // 完成状态是否已作为附件发送，防止重复
  shellCommand: ShellCommand | null          // 运行中的 ShellCommand 实例（终止后为 null）
  unregisterCleanup?: () => void             // 进程退出清理注销函数（运行时专用）
  cleanupTimeoutId?: NodeJS.Timeout          // 清理延迟定时器 ID（用于 clearTimeout）
  // 追踪上次上报的总行数，用于计算通知增量（来自 TaskOutput）
  lastReportedTotalLines: number
  // 任务是否已后台化（false = 前台运行中，true = 已后台化）
  isBackgrounded: boolean
  // 派生本任务的 agent ID；undefined 表示主线程任务。
  // 用于 agent 退出时终止其孤儿 bash 任务（见 killShellTasksForAgent）。
  agentId?: AgentId
  // UI 显示变体：'monitor' → 展示描述而非命令，对话框标题为 'Monitor details'，
  // 底部状态栏胶囊显示独立样式。
  kind?: BashTaskKind
}

/**
 * 类型守卫：判断未知对象是否为 LocalShellTaskState。
 * 检查 type 字段是否为 'local_bash'，用于在任务列表中安全地识别 shell 任务。
 *
 * @param task - 待检查的未知对象
 * @returns 若对象为 LocalShellTaskState 则返回 true
 */
export function isLocalShellTask(task: unknown): task is LocalShellTaskState {
  return (
    typeof task === 'object' &&
    task !== null &&
    'type' in task &&
    task.type === 'local_bash'  // 仅当 type === 'local_bash' 时返回 true
  )
}
