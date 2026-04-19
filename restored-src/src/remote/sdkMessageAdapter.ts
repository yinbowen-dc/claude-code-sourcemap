/**
 * @file sdkMessageAdapter.ts
 * @description SDK 消息适配器 —— 将 CCR 后端推送的 SDKMessage 转换为本地 REPL 渲染所需的 Message 类型。
 *
 * 在整个 Claude Code 系统流程中的位置：
 *   CCR WebSocket 消息流
 *     └─► RemoteSessionManager.onMessage / DirectConnectSessionManager
 *           └─► sdkMessageAdapter（本文件）
 *                 └─► REPL / useMessages / 渲染层（转换后的 Message 对象）
 *
 * 核心职责：
 *  CCR 后端使用 SDK 格式的消息结构（SDKMessage），而本地 REPL 期望内部 Message 类型。
 *  本文件作为"协议适配层"，将 SDKMessage 的各子类型逐一转换为 REPL 可直接渲染的格式。
 *
 * 支持的 SDKMessage 类型：
 *  - assistant       → AssistantMessage（模型输出）
 *  - user            → UserMessage（工具结果或历史用户输入，按选项控制）
 *  - stream_event    → StreamEvent（流式增量输出）
 *  - result          → SystemMessage（会话结束/错误）
 *  - system(init)    → SystemMessage（会话初始化信息）
 *  - system(status)  → SystemMessage（状态变更，如 compacting）
 *  - system(compact_boundary) → SystemMessage（压缩边界标记）
 *  - tool_progress   → SystemMessage（工具执行进度）
 *  - 其余类型        → ignored（静默忽略，不影响 REPL 状态）
 */

import type {
  SDKAssistantMessage,
  SDKCompactBoundaryMessage,
  SDKMessage,
  SDKPartialAssistantMessage,
  SDKResultMessage,
  SDKStatusMessage,
  SDKSystemMessage,
  SDKToolProgressMessage,
} from '../entrypoints/agentSdkTypes.js'
import type {
  AssistantMessage,
  Message,
  StreamEvent,
  SystemMessage,
} from '../types/message.js'
import { logForDebugging } from '../utils/debug.js'
import { fromSDKCompactMetadata } from '../utils/messages/mappers.js'
import { createUserMessage } from '../utils/messages.js'

/**
 * 将 SDKAssistantMessage 转换为本地 AssistantMessage。
 *
 * SDKAssistantMessage 来自 CCR 后端，包含模型生成的内容块（文本、工具调用等）。
 * 转换时保留原始 message 和 uuid，并补充本地所需的 requestId 和 timestamp 字段。
 *
 * @param msg CCR 推送的助手消息
 * @returns 本地 AssistantMessage 格式
 */
function convertAssistantMessage(msg: SDKAssistantMessage): AssistantMessage {
  return {
    type: 'assistant',
    message: msg.message,       // 原样保留模型输出内容
    uuid: msg.uuid,
    requestId: undefined,       // 远程模式下本地无 requestId
    timestamp: new Date().toISOString(), // 使用接收时间作为时间戳
    error: msg.error,
  }
}

/**
 * 将 SDKPartialAssistantMessage（流式增量事件）转换为 StreamEvent。
 *
 * 流式模式下，模型输出以增量事件形式推送，每个 stream_event 对应一个增量片段。
 * 本地 REPL 通过 StreamEvent 逐步更新助手消息的展示内容。
 *
 * @param msg CCR 推送的流式增量消息
 * @returns 本地 StreamEvent 格式
 */
function convertStreamEvent(msg: SDKPartialAssistantMessage): StreamEvent {
  return {
    type: 'stream_event',
    event: msg.event, // 直接透传原始 event 对象
  }
}

/**
 * 将 SDKResultMessage（会话结束消息）转换为 SystemMessage。
 *
 * result 消息标志着一次 agent 运行的结束：
 *  - success：会话成功完成（通常不展示，由 isLoading=false 表达即可）
 *  - error：运行出错，需向用户展示错误原因
 *
 * 注意：调用方（convertSDKMessage）对 success 类型会直接返回 ignored，
 * 此函数主要处理错误情况。
 *
 * @param msg CCR 推送的结果消息
 * @returns 本地 SystemMessage 格式（level 为 warning 或 info）
 */
function convertResultMessage(msg: SDKResultMessage): SystemMessage {
  const isError = msg.subtype !== 'success' // 非 success 均视为错误
  const content = isError
    ? msg.errors?.join(', ') || 'Unknown error' // 多个错误拼接为字符串
    : 'Session completed successfully'

  return {
    type: 'system',
    subtype: 'informational',
    content,
    level: isError ? 'warning' : 'info', // 错误使用 warning 级别突出显示
    uuid: msg.uuid,
    timestamp: new Date().toISOString(),
  }
}

/**
 * 将 SDKSystemMessage（init 子类型）转换为 SystemMessage。
 *
 * init 消息在会话建立时发出，包含模型名称等初始化信息。
 * 转换为 SystemMessage 后，REPL 可在对话列表中展示初始化提示。
 *
 * @param msg CCR 推送的 init 系统消息
 * @returns 包含模型名称的本地 SystemMessage
 */
function convertInitMessage(msg: SDKSystemMessage): SystemMessage {
  return {
    type: 'system',
    subtype: 'informational',
    content: `Remote session initialized (model: ${msg.model})`, // 展示远程使用的模型名
    level: 'info',
    uuid: msg.uuid,
    timestamp: new Date().toISOString(),
  }
}

/**
 * 将 SDKStatusMessage（status 子类型）转换为 SystemMessage，或在无有效状态时返回 null。
 *
 * status 消息用于通知会话状态变化，如正在压缩（compacting）。
 * 若 status 字段为空，则忽略此消息，不展示任何提示。
 *
 * @param msg CCR 推送的状态消息
 * @returns 本地 SystemMessage，或 null（当 status 为空时）
 */
function convertStatusMessage(msg: SDKStatusMessage): SystemMessage | null {
  if (!msg.status) {
    return null // status 为空时忽略此消息
  }

  return {
    type: 'system',
    subtype: 'informational',
    content:
      msg.status === 'compacting'
        ? 'Compacting conversation…' // compacting 状态使用专用提示文本
        : `Status: ${msg.status}`,   // 其他状态直接展示状态值
    level: 'info',
    uuid: msg.uuid,
    timestamp: new Date().toISOString(),
  }
}

/**
 * 将 SDKToolProgressMessage 转换为 SystemMessage。
 *
 * 工具执行进度消息由 CCR 周期性推送，包含工具名和已耗时秒数。
 * 注意：本地 ProgressMessage 类型需要工具特定数据，CCR 远程模式下无法获取，
 * 因此降级使用 SystemMessage 展示纯文本进度信息。
 *
 * @param msg CCR 推送的工具进度消息
 * @returns 包含工具名和运行时长的本地 SystemMessage
 */
function convertToolProgressMessage(
  msg: SDKToolProgressMessage,
): SystemMessage {
  return {
    type: 'system',
    subtype: 'informational',
    content: `Tool ${msg.tool_name} running for ${msg.elapsed_time_seconds}s…`, // 格式化进度提示
    level: 'info',
    uuid: msg.uuid,
    timestamp: new Date().toISOString(),
    toolUseID: msg.tool_use_id, // 保留 tool_use_id，供 UI 关联对应的工具调用块
  }
}

/**
 * 将 SDKCompactBoundaryMessage 转换为 SystemMessage。
 *
 * compact_boundary 消息标记对话压缩的边界位置，用于在历史记录中显示压缩分隔线。
 * compactMetadata 包含压缩前后的摘要信息，通过 fromSDKCompactMetadata 转换为本地格式。
 *
 * @param msg CCR 推送的压缩边界消息
 * @returns 包含压缩元数据的本地 SystemMessage
 */
function convertCompactBoundaryMessage(
  msg: SDKCompactBoundaryMessage,
): SystemMessage {
  return {
    type: 'system',
    subtype: 'compact_boundary',
    content: 'Conversation compacted',
    level: 'info',
    uuid: msg.uuid,
    timestamp: new Date().toISOString(),
    compactMetadata: fromSDKCompactMetadata(msg.compact_metadata), // 转换压缩元数据
  }
}

/**
 * SDKMessage 转换结果的联合类型：
 *  - message：成功转换为可渲染的 Message 对象
 *  - stream_event：流式增量事件（不产生新 Message，而是更新现有助手消息）
 *  - ignored：此消息无需在 REPL 中展示（过滤掉）
 */
export type ConvertedMessage =
  | { type: 'message'; message: Message }
  | { type: 'stream_event'; event: StreamEvent }
  | { type: 'ignored' }

/**
 * 控制 convertSDKMessage 行为的选项对象。
 *
 * 不同场景下对 user 类型消息的处理方式不同：
 *  - CCR 实时模式：用户消息已由本地 REPL 添加，无需转换
 *  - DirectConnect 模式：工具结果由远端服务器推送，需要转换后渲染
 *  - 历史记录加载：用户文本消息需要展示，需要转换
 */
type ConvertOptions = {
  /** 将包含 tool_result 内容块的 user 消息转换为 UserMessage。
   * 用于 direct connect 模式，工具结果来自远端服务器且需本地渲染。
   * CCR 模式下 user 消息通过不同机制处理，此选项为 false。*/
  convertToolResults?: boolean
  /**
   * 将 user 文本消息转换为 UserMessage 用于展示。
   * 加载历史事件时，用户输入未由 REPL 本地添加，需要通过此选项转换。
   * 实时 WebSocket 模式下，用户消息由 REPL 在本地已添加，此选项应为 false。
   */
  convertUserTextMessages?: boolean
}

/**
 * 将 SDKMessage 转换为 REPL 内部消息格式的主入口函数。
 *
 * 使用 switch-case 对 msg.type 进行分派，每个分支调用对应的内部转换函数。
 *
 * 关键行为：
 *  - assistant / stream_event / tool_progress：始终转换
 *  - result：仅错误类型转换，success 返回 ignored（避免多轮会话中的噪音）
 *  - system：仅 init / status / compact_boundary 子类型转换，其他忽略
 *  - user：根据 opts 决定是否转换工具结果和历史文本消息
 *  - 未知类型：记录日志并返回 ignored（向前兼容，不崩溃）
 *
 * @param msg  来自 CCR WebSocket 的 SDKMessage
 * @param opts 控制 user 类型消息转换行为的选项
 * @returns    ConvertedMessage 联合类型
 */
export function convertSDKMessage(
  msg: SDKMessage,
  opts?: ConvertOptions,
): ConvertedMessage {
  switch (msg.type) {
    case 'assistant':
      return { type: 'message', message: convertAssistantMessage(msg) }

    case 'user': {
      const content = msg.message?.content
      // 通过内容形状（是否含 tool_result 块）而非 parent_tool_use_id 来检测工具结果。
      // agent 侧 normalizeMessage() 会将 parent_tool_use_id 硬编码为 null，
      // 无法用于区分工具结果和普通用户输入。
      const isToolResult =
        Array.isArray(content) && content.some(b => b.type === 'tool_result')
      if (opts?.convertToolResults && isToolResult) {
        // direct connect 模式：将工具结果转换为 UserMessage，以便本地折叠渲染
        return {
          type: 'message',
          message: createUserMessage({
            content,
            toolUseResult: msg.tool_use_result,
            uuid: msg.uuid,
            timestamp: msg.timestamp,
          }),
        }
      }
      // 历史记录加载模式：转换用户文本消息（工具结果已在上面处理，此处跳过）
      if (opts?.convertUserTextMessages && !isToolResult) {
        if (typeof content === 'string' || Array.isArray(content)) {
          return {
            type: 'message',
            message: createUserMessage({
              content,
              toolUseResult: msg.tool_use_result,
              uuid: msg.uuid,
              timestamp: msg.timestamp,
            }),
          }
        }
      }
      // CCR 实时模式：用户消息已由 REPL 本地添加，此处忽略
      return { type: 'ignored' }
    }

    case 'stream_event':
      return { type: 'stream_event', event: convertStreamEvent(msg) }

    case 'result':
      // 成功结果不展示（isLoading=false 已足以表达完成状态）；仅错误结果需展示
      if (msg.subtype !== 'success') {
        return { type: 'message', message: convertResultMessage(msg) }
      }
      return { type: 'ignored' }

    case 'system':
      if (msg.subtype === 'init') {
        return { type: 'message', message: convertInitMessage(msg) }
      }
      if (msg.subtype === 'status') {
        const statusMsg = convertStatusMessage(msg)
        return statusMsg
          ? { type: 'message', message: statusMsg }
          : { type: 'ignored' } // status 为空时忽略
      }
      if (msg.subtype === 'compact_boundary') {
        return {
          type: 'message',
          message: convertCompactBoundaryMessage(msg),
        }
      }
      // hook_response 等其他 system 子类型暂不展示
      logForDebugging(
        `[sdkMessageAdapter] Ignoring system message subtype: ${msg.subtype}`,
      )
      return { type: 'ignored' }

    case 'tool_progress':
      return { type: 'message', message: convertToolProgressMessage(msg) }

    case 'auth_status':
      // 鉴权状态由专门的认证流程处理，不在 REPL 中展示
      logForDebugging('[sdkMessageAdapter] Ignoring auth_status message')
      return { type: 'ignored' }

    case 'tool_use_summary':
      // 工具使用摘要仅供 SDK 层使用，不在 REPL 中展示
      logForDebugging('[sdkMessageAdapter] Ignoring tool_use_summary message')
      return { type: 'ignored' }

    case 'rate_limit_event':
      // 限流事件仅供 SDK 层使用，不在 REPL 中展示
      logForDebugging('[sdkMessageAdapter] Ignoring rate_limit_event message')
      return { type: 'ignored' }

    default: {
      // 优雅地忽略未知消息类型。后端可能在客户端升级前推送新类型，
      // 记录日志有助于调试，但不崩溃或丢失会话。
      logForDebugging(
        `[sdkMessageAdapter] Unknown message type: ${(msg as { type: string }).type}`,
      )
      return { type: 'ignored' }
    }
  }
}

/**
 * 判断某条 SDKMessage 是否表示会话已结束。
 *
 * 会话结束消息固定为 result 类型（无论 success 还是 error），
 * 调用方（如 REPL 的 isLoading 状态机）可据此判断是否停止等待。
 *
 * @param msg 待检测的 SDKMessage
 * @returns   true 表示会话已结束
 */
export function isSessionEndMessage(msg: SDKMessage): boolean {
  return msg.type === 'result'
}

/**
 * 判断 SDKResultMessage 是否表示成功完成。
 *
 * @param msg result 类型的 SDKMessage
 * @returns   subtype 为 'success' 时返回 true
 */
export function isSuccessResult(msg: SDKResultMessage): boolean {
  return msg.subtype === 'success'
}

/**
 * 从成功的 SDKResultMessage 中提取最终结果文本。
 *
 * 用于 SDK 调用方（非 REPL）获取 agent 的最终输出字符串。
 * 若消息为错误类型，则返回 null。
 *
 * @param msg result 类型的 SDKMessage
 * @returns   成功时返回结果文本，错误时返回 null
 */
export function getResultText(msg: SDKResultMessage): string | null {
  if (msg.subtype === 'success') {
    return msg.result
  }
  return null
}
