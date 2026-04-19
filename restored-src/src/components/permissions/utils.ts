/**
 * utils.ts
 *
 * 【层级一：文件职责说明】
 * 本文件是 Claude Code 权限系统的 analytics 工具函数模块。
 *
 * 在 Claude Code 的系统流程中，当用户对权限请求对话框做出响应（同意或拒绝）时，
 * 系统需要上报标准化的 unary analytics 事件，以追踪工具调用的权限决策行为。
 *
 * 本文件导出唯一函数 `logUnaryPermissionEvent`，它对底层 `logUnaryEvent` 进行封装，
 * 统一注入权限相关的固定元数据（language_name、platform、hasFeedback），
 * 避免各权限对话框组件重复编写相同的 metadata 构造代码。
 *
 * 调用方：
 *   - useShellPermissionFeedback.ts（Bash/PowerShell 权限反馈 Hook）
 *   - SkillPermissionRequest.tsx（Skill 工具权限对话框）
 *   - 其他权限对话框组件
 */

import { getHostPlatformForAnalytics } from '../../utils/env.js'
import { type CompletionType, logUnaryEvent } from '../../utils/unaryLogging.js'
import type { ToolUseConfirm } from './PermissionRequest.js'

/**
 * 【层级二：logUnaryPermissionEvent 函数说明】
 * 上报权限决策的 unary analytics 事件。
 *
 * 本函数将权限对话框的用户决策（接受/拒绝）封装为标准 unary 事件上报，
 * 自动填充权限相关的固定元数据字段，供后端 analytics 管道消费。
 *
 * 流程：
 *   1. 从 toolUseConfirm.assistantMessage.message.id 提取 message_id
 *   2. 调用 getHostPlatformForAnalytics() 获取当前平台信息
 *   3. 组装 metadata 并调用 logUnaryEvent 上报（使用 void 忽略 Promise）
 *
 * @param completion_type - unary 事件的完成类型（如 'tool_use_single'）
 * @param toolUseConfirm  - 工具使用确认上下文，用于提取 message_id
 * @param event           - 用户决策类型：'accept'（同意）或 'reject'（拒绝）
 * @param hasFeedback     - 用户是否附带了文字反馈，默认 false
 */
export function logUnaryPermissionEvent(
  completion_type: CompletionType,
  {
    assistantMessage: {
      // 从嵌套结构中解构出 message_id，用于关联具体的 assistant 消息
      message: { id: message_id },
    },
  }: ToolUseConfirm,
  event: 'accept' | 'reject',
  hasFeedback?: boolean,
): void {
  // 使用 void 忽略返回的 Promise，此处不需要等待上报完成
  void logUnaryEvent({
    completion_type,
    event,
    metadata: {
      // 权限事件无关联编程语言，固定填写 'none'
      language_name: 'none',
      // 关联触发权限请求的 assistant 消息 ID
      message_id,
      // 获取当前宿主平台（macOS / Linux / Windows）用于分平台分析
      platform: getHostPlatformForAnalytics(),
      // 标记用户是否在接受/拒绝时附带了文字反馈，默认 false
      hasFeedback: hasFeedback ?? false,
    },
  })
}
