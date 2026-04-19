/**
 * @file directConnectManager.ts
 * @description 直连会话管理器 —— 本地直连服务器（`claude --server`）模式下的 WebSocket 会话客户端。
 *
 * 在整个 Claude Code 系统流程中的位置：
 *   REPL / headless runner（`--server-url` 模式）
 *     └─► DirectConnectSessionManager（本文件）
 *           └─► ws_url WebSocket（由 createDirectConnectSession 返回的直连端点）
 *
 * 与 RemoteSessionManager（CCR 云端模式）的区别：
 *  - 本管理器连接到本地直连服务器（localhost 或局域网），无需 OAuth 令牌，可选 Bearer 认证
 *  - 消息格式为换行符分隔的 JSON 流（newline-delimited JSON），需要逐行解析
 *  - 不支持自动重连（连接关闭即通知上层）
 *  - 工具结果由服务端推回客户端（需通过 convertToolResults 选项渲染）
 *
 * 主要职责：
 *  1. 建立到直连服务器 WebSocket 端点的连接
 *  2. 解析换行符分隔的 JSON 消息流，过滤噪音消息类型
 *  3. 将权限请求（can_use_tool）通知上层，并支持发送 allow/deny 响应
 *  4. 支持向会话发送用户消息和中断信号
 */

/* eslint-disable eslint-plugin-n/no-unsupported-features/node-builtins */

import type { SDKMessage } from '../entrypoints/agentSdkTypes.js'
import type {
  SDKControlPermissionRequest,
  StdoutMessage,
} from '../entrypoints/sdk/controlTypes.js'
import type { RemotePermissionResponse } from '../remote/RemoteSessionManager.js'
import { logForDebugging } from '../utils/debug.js'
import { jsonParse, jsonStringify } from '../utils/slowOperations.js'
import type { RemoteMessageContent } from '../utils/teleport/api.js'

/**
 * 直连服务器的连接参数配置。
 *
 * - serverUrl：HTTP 服务器基础 URL（用于 REST API 请求，如 POST /sessions）
 * - sessionId：此次会话的唯一标识
 * - wsUrl：WebSocket 端点 URL（由 POST /sessions 返回）
 * - authToken：可选的 Bearer 认证令牌（服务器开启认证时须提供）
 */
export type DirectConnectConfig = {
  serverUrl: string
  sessionId: string
  wsUrl: string
  authToken?: string
}

/**
 * 直连会话事件回调集合，上层通过此接口订阅会话事件。
 *
 * - onMessage：收到业务 SDKMessage 时触发（已过滤噪音类型）
 * - onPermissionRequest：收到工具权限请求时触发，须调用 respondToPermissionRequest 回复
 * - onConnected / onDisconnected / onError：连接生命周期事件（均可选）
 */
export type DirectConnectCallbacks = {
  onMessage: (message: SDKMessage) => void
  onPermissionRequest: (
    request: SDKControlPermissionRequest,
    requestId: string,
  ) => void
  onConnected?: () => void
  onDisconnected?: () => void
  onError?: (error: Error) => void
}

/**
 * 类型守卫：判断反序列化后的对象是否为合法的 StdoutMessage。
 *
 * 仅检查是否为含字符串 type 字段的非空对象，不限制具体类型值，
 * 保持向前兼容性（新消息类型由下游过滤逻辑处理）。
 */
function isStdoutMessage(value: unknown): value is StdoutMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    typeof value.type === 'string'
  )
}

/**
 * 直连模式 WebSocket 会话管理器。
 *
 * 与云端 CCR 模式（RemoteSessionManager）相比，直连模式的主要特点：
 *  - 使用 Bun 原生 WebSocket（支持自定义 headers），无需 Node.js ws 包
 *  - 消息格式为换行符分隔的 JSON，每条消息占一行（类 NDJSON 格式）
 *  - 不维护待处理权限请求的映射表（由上层 REPL 负责管理状态）
 *  - 无自动重连逻辑（连接断开直接通知上层）
 */
export class DirectConnectSessionManager {
  private ws: WebSocket | null = null // 当前 WebSocket 实例
  private config: DirectConnectConfig
  private callbacks: DirectConnectCallbacks

  constructor(config: DirectConnectConfig, callbacks: DirectConnectCallbacks) {
    this.config = config
    this.callbacks = callbacks
  }

  /**
   * 建立到直连服务器的 WebSocket 连接并注册事件处理器。
   *
   * 流程：
   *  1. 构造认证头（若配置了 authToken）
   *  2. 创建 WebSocket 实例（使用 Bun 扩展的 headers 选项）
   *  3. 注册 open/message/close/error 事件处理器
   *
   * 消息处理策略（message 事件）：
   *  - 按换行符拆分为多行，逐行 JSON 解析
   *  - control_request（can_use_tool）→ 通知上层弹出权限对话框
   *  - 其他 control_request 子类型 → 立即回复 error 响应（避免服务端挂起）
   *  - 过滤噪音类型（keep_alive、control_response 等）→ 直接跳过
   *  - 其余业务消息 → 通过 onMessage 转发给上层
   */
  connect(): void {
    const headers: Record<string, string> = {}
    if (this.config.authToken) {
      headers['authorization'] = `Bearer ${this.config.authToken}` // Bearer 认证
    }
    // Bun's WebSocket supports headers option but the DOM typings don't
    this.ws = new WebSocket(this.config.wsUrl, {
      headers,
    } as unknown as string[]) // 绕过 DOM 类型不支持 headers 选项的限制

    this.ws.addEventListener('open', () => {
      this.callbacks.onConnected?.()
    })

    this.ws.addEventListener('message', event => {
      // 直连服务器以换行符分隔的 JSON 流推送消息，需要逐行解析
      const data = typeof event.data === 'string' ? event.data : ''
      const lines = data.split('\n').filter((l: string) => l.trim()) // 过滤空行

      for (const line of lines) {
        let raw: unknown
        try {
          raw = jsonParse(line)
        } catch {
          continue // JSON 解析失败时跳过此行，不中断循环
        }

        if (!isStdoutMessage(raw)) {
          continue // 非 StdoutMessage 格式，跳过
        }
        const parsed = raw

        // 处理控制请求（工具调用权限请求）
        if (parsed.type === 'control_request') {
          if (parsed.request.subtype === 'can_use_tool') {
            // 将权限请求转发给上层，等待用户做出授权决策
            this.callbacks.onPermissionRequest(
              parsed.request,
              parsed.request_id,
            )
          } else {
            // Send an error response for unrecognized subtypes so the
            // server doesn't hang waiting for a reply that never comes.
            logForDebugging(
              `[DirectConnect] Unsupported control request subtype: ${parsed.request.subtype}`,
            )
            // 对未知子类型立即回复错误，防止服务端无限等待
            this.sendErrorResponse(
              parsed.request_id,
              `Unsupported control request subtype: ${parsed.request.subtype}`,
            )
          }
          continue // control_request 已处理，不进入下方的业务消息分支
        }

        // 过滤不需要渲染的噪音消息类型，只将业务消息转发给上层
        if (
          parsed.type !== 'control_response' &&        // ACK 消息，无需渲染
          parsed.type !== 'keep_alive' &&              // 心跳消息，无需渲染
          parsed.type !== 'control_cancel_request' &&  // 取消请求，直连模式暂不处理
          parsed.type !== 'streamlined_text' &&        // 流式文本摘要，REPL 不使用
          parsed.type !== 'streamlined_tool_use_summary' && // 工具摘要，REPL 不使用
          !(parsed.type === 'system' && parsed.subtype === 'post_turn_summary') // 轮次后摘要
        ) {
          this.callbacks.onMessage(parsed) // 转发业务消息（assistant/result/stream_event 等）
        }
      }
    })

    this.ws.addEventListener('close', () => {
      this.callbacks.onDisconnected?.() // 直连模式不自动重连，直接通知上层断开
    })

    this.ws.addEventListener('error', () => {
      this.callbacks.onError?.(new Error('WebSocket connection error'))
    })
  }

  /**
   * 通过 WebSocket 向直连会话发送用户消息。
   *
   * 消息格式须符合 `--input-format stream-json` 期望的 SDKUserMessage 结构：
   *  { type: 'user', message: { role: 'user', content: ... }, parent_tool_use_id: null, session_id: '' }
   *
   * @param content 消息内容（文本或工具结果等）
   * @returns       发送成功返回 true，连接未就绪返回 false
   */
  sendMessage(content: RemoteMessageContent): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return false // 连接未就绪，无法发送
    }

    // Must match SDKUserMessage format expected by `--input-format stream-json`
    const message = jsonStringify({
      type: 'user',
      message: {
        role: 'user',
        content: content,
      },
      parent_tool_use_id: null, // 顶层用户消息无父工具调用
      session_id: '',           // 直连模式下会话 ID 由服务端管理，此处留空
    })
    this.ws.send(message)
    return true
  }

  /**
   * 将用户的权限授权决策（allow/deny）发送给直连服务器。
   *
   * 消息格式须符合 StructuredIO 期望的 SDKControlResponse 结构：
   *  - allow：携带 updatedInput（可能被用户修改过的工具输入）
   *  - deny：携带 message（拒绝原因，服务端会报告给模型）
   *
   * @param requestId 对应权限请求的唯一 ID
   * @param result    用户的授权决策
   */
  respondToPermissionRequest(
    requestId: string,
    result: RemotePermissionResponse,
  ): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return // 连接未就绪，静默放弃（不抛出，避免崩溃 UI）
    }

    // Must match SDKControlResponse format expected by StructuredIO
    const response = jsonStringify({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: requestId,
        response: {
          behavior: result.behavior,
          // allow 时附带（可能被修改的）输入；deny 时附带拒绝原因
          ...(result.behavior === 'allow'
            ? { updatedInput: result.updatedInput }
            : { message: result.message }),
        },
      },
    })
    this.ws.send(response)
  }

  /**
   * 向直连会话发送中断信号，取消当前正在运行的工具调用或推理过程。
   *
   * 消息格式须符合 StructuredIO 期望的 SDKControlRequest 结构，
   * subtype 固定为 'interrupt'。
   */
  sendInterrupt(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return
    }

    // Must match SDKControlRequest format expected by StructuredIO
    const request = jsonStringify({
      type: 'control_request',
      request_id: crypto.randomUUID(), // 每次中断生成唯一 ID
      request: {
        subtype: 'interrupt',
      },
    })
    this.ws.send(request)
  }

  /**
   * 向直连服务器发送控制错误响应（error subtype）。
   *
   * 私有方法，用于对不支持的 control_request 子类型立即回复错误，
   * 防止服务端因等不到响应而挂起。
   *
   * @param requestId 对应控制请求的 ID
   * @param error     错误描述字符串
   */
  private sendErrorResponse(requestId: string, error: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return
    }
    const response = jsonStringify({
      type: 'control_response',
      response: {
        subtype: 'error',
        request_id: requestId,
        error,
      },
    })
    this.ws.send(response)
  }

  /**
   * 断开 WebSocket 连接并清理资源。
   *
   * 关闭连接后将 ws 引用置空，防止后续误操作。
   * close 事件会触发 onDisconnected 回调通知上层。
   */
  disconnect(): void {
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
  }

  /**
   * 检查当前 WebSocket 是否处于已连接状态。
   *
   * @returns WebSocket readyState 为 OPEN 时返回 true
   */
  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN
  }
}
