/**
 * 一元事件（Unary Event）日志上报模块。
 *
 * 在 Claude Code 系统流程中的位置：
 * 此模块是编辑器补全分析层的底层工具，被内联补全功能
 * （str_replace、write_file、tool_use 等）调用，
 * 用于上报用户对补全结果的操作（接受/拒绝/响应）。
 *
 * 主要功能：
 * - logUnaryEvent：异步包装 logEvent('tengu_unary_event', ...)
 * - 支持多种补全类型（str_replace_single/multi、write_file、tool_use）
 * - 支持多种事件类型（accept、reject、response）
 * - 等待 language_name Promise（语言检测可能是异步的）
 */

import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js'

// 补全操作类型：单行替换、多行替换、整文件写入、工具调用
export type CompletionType =
  | 'str_replace_single'   // 单处字符串替换补全
  | 'str_replace_multi'    // 多处字符串替换补全
  | 'write_file_single'    // 整文件写入补全
  | 'tool_use_single'      // 工具调用补全

// 一元事件的完整参数结构
type LogEvent = {
  completion_type: CompletionType  // 补全类型
  event: 'accept' | 'reject' | 'response'  // 用户操作类型
  metadata: {
    language_name: string | Promise<string>  // 编程语言名（可能是异步检测的）
    message_id: string        // 关联的消息 ID
    platform: string          // 平台标识（如 ide-vscode 等）
    hasFeedback?: boolean     // 是否附带用户反馈
  }
}

/**
 * 上报一元事件到 Statsig 分析系统。
 *
 * 流程：
 * 1. 等待 language_name（若为 Promise 则先 await）
 * 2. 构造 tengu_unary_event 事件负载
 * 3. 可选附加 hasFeedback 字段（仅当 event.metadata.hasFeedback 有定义时）
 * 4. 调用 logEvent 上报
 *
 * @param event 包含补全类型、操作类型和元数据的事件对象
 */
export async function logUnaryEvent(event: LogEvent): Promise<void> {
  logEvent('tengu_unary_event', {
    // 用户操作类型（accept/reject/response）
    event:
      event.event as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    // 补全操作类型
    completion_type:
      event.completion_type as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    // await 语言名（可能是异步 Promise）
    language_name: (await event.metadata
      .language_name) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    // 关联消息 ID
    message_id: event.metadata
      .message_id as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    // 平台标识
    platform: event.metadata
      .platform as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    // 仅当 hasFeedback 有值时才附加该字段（避免上报 undefined）
    ...(event.metadata.hasFeedback !== undefined && {
      hasFeedback: event.metadata.hasFeedback,
    }),
  })
}
