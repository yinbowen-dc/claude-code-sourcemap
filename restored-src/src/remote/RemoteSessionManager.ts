/**
 * @file RemoteSessionManager.ts
 * @description 远程会话管理器 —— Claude Code 远程协作运行（CCR）架构的核心调度层。
 *
 * 在整个 Claude Code 系统流程中的位置：
 *   REPL / SDK 入口
 *     └─► RemoteSessionManager（本文件）
 *           ├─► SessionsWebSocket   （WebSocket 长连接，接收 CCR 推送的消息）
 *           └─► sendEventToRemoteSession（HTTP POST，向 CCR 发送用户消息）
 *
 * 主要职责：
 *  1. 通过 SessionsWebSocket 订阅来自远程 CCR 容器的消息流（SDKMessage / 控制消息）
 *  2. 通过 HTTP POST 将本地用户输入转发给 CCR
 *  3. 代理 CCR 发起的权限请求（can_use_tool），并将用户的 allow/deny 决策回写给 CCR
 *  4. 维护待处理权限请求的映射表，支持服务端主动取消请求
 */

import type { SDKMessage } from '../entrypoints/agentSdkTypes.js'
import type {
  SDKControlCancelRequest,
  SDKControlPermissionRequest,
  SDKControlRequest,
  SDKControlResponse,
} from '../entrypoints/sdk/controlTypes.js'
import { logForDebugging } from '../utils/debug.js'
import { logError } from '../utils/log.js'
import {
  type RemoteMessageContent,
  sendEventToRemoteSession,
} from '../utils/teleport/api.js'
import {
  SessionsWebSocket,
  type SessionsWebSocketCallbacks,
} from './SessionsWebSocket.js'

/**
 * 类型守卫：判断消息是否为普通 SDKMessage（而非控制类消息）。
 *
 * CCR 通过同一 WebSocket 通道既发送业务消息（assistant/result/system 等），
 * 也发送控制消息（control_request/control_response/control_cancel_request）。
 * 此守卫用于在 handleMessage 中将两类消息区分开来，
 * 确保只有业务消息才会被转发给上层 onMessage 回调。
 */
function isSDKMessage(
  message:
    | SDKMessage
    | SDKControlRequest
    | SDKControlResponse
    | SDKControlCancelRequest,
): message is SDKMessage {
  return (
    message.type !== 'control_request' &&
    message.type !== 'control_response' &&
    message.type !== 'control_cancel_request'
  )
}

/**
 * 远程权限响应结构：用于将本地用户的授权决策传回 CCR。
 *
 * - allow：用户批准工具调用，同时可携带修改后的输入参数（updatedInput）
 * - deny：用户拒绝工具调用，须附带拒绝原因（message）供 CCR 向模型报告
 *
 * 此类型是 PermissionResult 的简化版，仅保留 CCR 通信所需的最小字段集。
 */
export type RemotePermissionResponse =
  | {
      behavior: 'allow'
      updatedInput: Record<string, unknown>
    }
  | {
      behavior: 'deny'
      message: string
    }

/**
 * 远程会话配置：创建 RemoteSessionManager 所需的连接参数。
 *
 * - sessionId：CCR 分配的会话标识，用于 WebSocket 订阅 URL 和 HTTP 路径
 * - getAccessToken：动态获取 OAuth 令牌的函数（令牌可能随时刷新）
 * - orgUuid：组织 UUID，用于 WebSocket 订阅请求
 * - hasInitialPrompt：会话创建时携带了初始提示词，CCR 正在处理中
 * - viewerOnly：纯观察者模式（如 `claude assistant`），不发送中断、不更新标题
 */
export type RemoteSessionConfig = {
  sessionId: string
  getAccessToken: () => string
  orgUuid: string
  /** True if session was created with an initial prompt that's being processed */
  hasInitialPrompt?: boolean
  /**
   * When true, this client is a pure viewer. Ctrl+C/Escape do NOT send
   * interrupt to the remote agent; 60s reconnect timeout is disabled;
   * session title is never updated. Used by `claude assistant`.
   */
  viewerOnly?: boolean
}

/**
 * 远程会话事件回调集合：上层（REPL/SDK）通过此接口订阅会话事件。
 *
 * - onMessage：收到业务消息时触发（SDKMessage）
 * - onPermissionRequest：CCR 请求用户授权时触发，须调用 respondToPermissionRequest 回复
 * - onPermissionCancelled：CCR 主动取消挂起的权限请求时触发（可选）
 * - onConnected / onDisconnected / onReconnecting / onError：连接生命周期事件（均可选）
 */
export type RemoteSessionCallbacks = {
  /** Called when an SDKMessage is received from the session */
  onMessage: (message: SDKMessage) => void
  /** Called when a permission request is received from CCR */
  onPermissionRequest: (
    request: SDKControlPermissionRequest,
    requestId: string,
  ) => void
  /** Called when the server cancels a pending permission request */
  onPermissionCancelled?: (
    requestId: string,
    toolUseId: string | undefined,
  ) => void
  /** Called when connection is established */
  onConnected?: () => void
  /** Called when connection is lost and cannot be restored */
  onDisconnected?: () => void
  /** Called on transient WS drop while reconnect backoff is in progress */
  onReconnecting?: () => void
  /** Called on error */
  onError?: (error: Error) => void
}

/**
 * 远程 CCR 会话管理器。
 *
 * 协调三条数据通路：
 *  1. WebSocket（SessionsWebSocket）—— 接收 CCR 推送的消息流
 *  2. HTTP POST（sendEventToRemoteSession）—— 向 CCR 发送用户输入
 *  3. 权限请求/响应流程 —— 通过 WebSocket 双向传递 control_request / control_response
 *
 * 内部维护一个 pendingPermissionRequests 映射表，以便：
 *  - 在用户做出授权决策时，能找到对应的请求并发送响应
 *  - 在服务端取消请求时，能通知上层并清理映射表
 */
export class RemoteSessionManager {
  // WebSocket 客户端实例，connect() 后赋值，disconnect() 后置空
  private websocket: SessionsWebSocket | null = null
  // 待处理的权限请求映射表：requestId → SDKControlPermissionRequest
  private pendingPermissionRequests: Map<string, SDKControlPermissionRequest> =
    new Map()

  constructor(
    private readonly config: RemoteSessionConfig,
    private readonly callbacks: RemoteSessionCallbacks,
  ) {}

  /**
   * 建立与远程会话的 WebSocket 连接。
   *
   * 流程：
   *  1. 构建 SessionsWebSocketCallbacks，将 WS 事件桥接到 RemoteSessionCallbacks
   *  2. 实例化 SessionsWebSocket 并调用 connect()（异步，不等待完成）
   *
   * 注意：connect() 返回后连接尚未就绪，需等待 onConnected 回调。
   */
  connect(): void {
    logForDebugging(
      `[RemoteSessionManager] Connecting to session ${this.config.sessionId}`,
    )

    // 将 WebSocket 底层事件适配为 RemoteSessionCallbacks 中的高层事件
    const wsCallbacks: SessionsWebSocketCallbacks = {
      onMessage: message => this.handleMessage(message),
      onConnected: () => {
        logForDebugging('[RemoteSessionManager] Connected')
        this.callbacks.onConnected?.()
      },
      onClose: () => {
        logForDebugging('[RemoteSessionManager] Disconnected')
        this.callbacks.onDisconnected?.()
      },
      onReconnecting: () => {
        logForDebugging('[RemoteSessionManager] Reconnecting')
        this.callbacks.onReconnecting?.()
      },
      onError: error => {
        logError(error)
        this.callbacks.onError?.(error)
      },
    }

    this.websocket = new SessionsWebSocket(
      this.config.sessionId,
      this.config.orgUuid,
      this.config.getAccessToken,
      wsCallbacks,
    )

    void this.websocket.connect() // 异步连接，不阻塞当前调用栈
  }

  /**
   * 处理来自 WebSocket 的原始消息，按类型分流到不同处理逻辑。
   *
   * 消息类型分支：
   *  - control_request       → handleControlRequest（权限请求）
   *  - control_cancel_request → 清理映射表并通知上层取消
   *  - control_response      → 仅记录日志，无需进一步处理（ACK 消息）
   *  - 其余（SDKMessage）    → 转发给 callbacks.onMessage
   */
  private handleMessage(
    message:
      | SDKMessage
      | SDKControlRequest
      | SDKControlResponse
      | SDKControlCancelRequest,
  ): void {
    // 处理控制请求（CCR 发起的权限弹窗）
    if (message.type === 'control_request') {
      this.handleControlRequest(message)
      return
    }

    // 处理取消请求：服务端主动撤回之前发出的权限请求
    if (message.type === 'control_cancel_request') {
      const { request_id } = message
      const pendingRequest = this.pendingPermissionRequests.get(request_id)
      logForDebugging(
        `[RemoteSessionManager] Permission request cancelled: ${request_id}`,
      )
      this.pendingPermissionRequests.delete(request_id) // 从映射表中移除
      this.callbacks.onPermissionCancelled?.(
        request_id,
        pendingRequest?.tool_use_id, // 传递 tool_use_id 供 UI 关闭对应弹窗
      )
      return
    }

    // 控制响应（ACK）：仅记录日志，不需要额外处理
    if (message.type === 'control_response') {
      logForDebugging('[RemoteSessionManager] Received control response')
      return
    }

    // 业务消息：通过类型守卫确认后转发给上层
    if (isSDKMessage(message)) {
      this.callbacks.onMessage(message)
    }
  }

  /**
   * 处理 CCR 发来的控制请求（control_request）。
   *
   * 当前支持的子类型：
   *  - can_use_tool：工具调用权限请求，注册到待处理映射表并通知上层
   *
   * 对于未知子类型，立即回复 error 响应，避免服务端无限等待。
   */
  private handleControlRequest(request: SDKControlRequest): void {
    const { request_id, request: inner } = request

    if (inner.subtype === 'can_use_tool') {
      logForDebugging(
        `[RemoteSessionManager] Permission request for tool: ${inner.tool_name}`,
      )
      this.pendingPermissionRequests.set(request_id, inner) // 记录待处理请求
      this.callbacks.onPermissionRequest(inner, request_id) // 通知上层弹出权限对话框
    } else {
      // Send an error response for unrecognized subtypes so the server
      // doesn't hang waiting for a reply that never comes.
      logForDebugging(
        `[RemoteSessionManager] Unsupported control request subtype: ${inner.subtype}`,
      )
      // 构造错误响应，告知服务端此子类型不被支持
      const response: SDKControlResponse = {
        type: 'control_response',
        response: {
          subtype: 'error',
          request_id,
          error: `Unsupported control request subtype: ${inner.subtype}`,
        },
      }
      this.websocket?.sendControlResponse(response)
    }
  }

  /**
   * 通过 HTTP POST 向远程会话发送用户消息。
   *
   * 此方法绕过 WebSocket，直接调用 sendEventToRemoteSession API，
   * 因为用户输入需要以可靠的请求-响应方式送达，而非通过流式 WebSocket。
   *
   * @param content 消息内容（文本或工具结果等）
   * @param opts    可选参数，如自定义消息 UUID
   * @returns       发送成功返回 true，失败返回 false 并记录错误
   */
  async sendMessage(
    content: RemoteMessageContent,
    opts?: { uuid?: string },
  ): Promise<boolean> {
    logForDebugging(
      `[RemoteSessionManager] Sending message to session ${this.config.sessionId}`,
    )

    const success = await sendEventToRemoteSession(
      this.config.sessionId,
      content,
      opts,
    )

    if (!success) {
      logError(
        new Error(
          `[RemoteSessionManager] Failed to send message to session ${this.config.sessionId}`,
        ),
      )
    }

    return success
  }

  /**
   * 将用户对权限请求的授权决策回传给 CCR。
   *
   * 流程：
   *  1. 从 pendingPermissionRequests 中查找对应请求（若不存在则记录错误并返回）
   *  2. 从映射表中删除该请求（防止重复响应）
   *  3. 构造 SDKControlResponse（subtype: 'success'），并通过 WebSocket 发送
   *
   * @param requestId 权限请求的唯一 ID（来自 onPermissionRequest 回调）
   * @param result    用户的授权决策（allow 含 updatedInput，deny 含 message）
   */
  respondToPermissionRequest(
    requestId: string,
    result: RemotePermissionResponse,
  ): void {
    const pendingRequest = this.pendingPermissionRequests.get(requestId)
    if (!pendingRequest) {
      // 映射表中不存在此 ID，可能已被取消或重复响应
      logError(
        new Error(
          `[RemoteSessionManager] No pending permission request with ID: ${requestId}`,
        ),
      )
      return
    }

    this.pendingPermissionRequests.delete(requestId) // 移除已处理的请求

    // 构造成功响应，根据 allow/deny 附带不同字段
    const response: SDKControlResponse = {
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: requestId,
        response: {
          behavior: result.behavior,
          ...(result.behavior === 'allow'
            ? { updatedInput: result.updatedInput } // allow 时附带（可能修改过的）输入
            : { message: result.message }),          // deny 时附带拒绝原因
        },
      },
    }

    logForDebugging(
      `[RemoteSessionManager] Sending permission response: ${result.behavior}`,
    )

    this.websocket?.sendControlResponse(response)
  }

  /**
   * 检查当前 WebSocket 是否处于已连接状态。
   *
   * @returns WebSocket 已连接返回 true，否则返回 false
   */
  isConnected(): boolean {
    return this.websocket?.isConnected() ?? false
  }

  /**
   * 向 CCR 发送中断信号，取消当前正在运行的工具调用或推理过程。
   *
   * 通过 WebSocket 发送 subtype 为 'interrupt' 的控制请求。
   * viewerOnly 模式下，上层会阻止调用此方法。
   */
  cancelSession(): void {
    logForDebugging('[RemoteSessionManager] Sending interrupt signal')
    this.websocket?.sendControlRequest({ subtype: 'interrupt' })
  }

  /**
   * 获取当前会话的唯一标识符。
   *
   * @returns 会话 ID 字符串
   */
  getSessionId(): string {
    return this.config.sessionId
  }

  /**
   * 断开与远程会话的 WebSocket 连接并清理所有状态。
   *
   * 执行步骤：
   *  1. 关闭 WebSocket 连接
   *  2. 将 websocket 引用置空，防止后续误操作
   *  3. 清空 pendingPermissionRequests 映射表，丢弃所有挂起的权限请求
   */
  disconnect(): void {
    logForDebugging('[RemoteSessionManager] Disconnecting')
    this.websocket?.close()
    this.websocket = null
    this.pendingPermissionRequests.clear() // 清理所有未处理的权限请求
  }

  /**
   * 强制重新连接 WebSocket。
   *
   * 适用场景：CCR 容器重启后，订阅通道可能已失效（stale subscription），
   * 调用此方法可触发 SessionsWebSocket 的重连逻辑，恢复消息接收。
   */
  reconnect(): void {
    logForDebugging('[RemoteSessionManager] Reconnecting WebSocket')
    this.websocket?.reconnect()
  }
}

/**
 * 工厂函数：从 OAuth 令牌等参数构建 RemoteSessionConfig 配置对象。
 *
 * 将各个分散的参数封装为统一的配置结构，方便传入 RemoteSessionManager 构造函数。
 *
 * @param sessionId        CCR 分配的会话 ID
 * @param getAccessToken   动态获取访问令牌的函数
 * @param orgUuid          所属组织的 UUID
 * @param hasInitialPrompt 是否携带初始提示词（默认 false）
 * @param viewerOnly       是否为纯观察者模式（默认 false）
 * @returns                完整的 RemoteSessionConfig 对象
 */
export function createRemoteSessionConfig(
  sessionId: string,
  getAccessToken: () => string,
  orgUuid: string,
  hasInitialPrompt = false,
  viewerOnly = false,
): RemoteSessionConfig {
  return {
    sessionId,
    getAccessToken,
    orgUuid,
    hasInitialPrompt,
    viewerOnly,
  }
}
