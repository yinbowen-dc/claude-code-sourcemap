/**
 * bridgePermissionCallbacks.ts — Bridge 权限回调类型定义与类型守卫
 *
 * 在 Claude Code 系统流程中的位置：
 *   工具执行权限检查层（tools/permission）
 *     └─> Bridge 权限流程（bridgePermissions / replBridge）
 *           └─> bridgePermissionCallbacks.ts（本文件）——定义权限请求/响应的核心接口
 *
 * 背景：当 Bridge（Remote Control）模式激活时，工具调用的权限审核会被转发到
 * claude.ai 网页端，由用户在浏览器中点击"允许"或"拒绝"。
 * 本文件定义了这个权限流程所需的核心类型：
 *   - BridgePermissionResponse：服务端（claude.ai）返回的权限审核结果；
 *   - BridgePermissionCallbacks：权限请求/响应的操作接口，由 replBridge 实现并注入；
 *   - isBridgePermissionResponse()：从 control_response payload 中安全提取权限响应的类型守卫。
 *
 * 设计说明：
 *   本文件仅含类型定义和一个纯类型守卫函数，无运行时副作用。
 *   将此接口独立为单独文件，是为了让权限检查层（tools/）能够依赖此类型
 *   而不引入整个 Bridge 核心模块的依赖（避免循环依赖）。
 */
import type { PermissionUpdate } from '../utils/permissions/PermissionUpdateSchema.js'

/**
 * 服务端（claude.ai 网页端）对工具调用权限审核请求的响应结构。
 *
 * 字段说明：
 *   - behavior：审核结果，'allow' 表示允许执行，'deny' 表示拒绝；
 *   - updatedInput：用户可能在网页端修改了工具的输入参数，此处返回修改后的值；
 *   - updatedPermissions：用户选择记住此次决策时，附带的权限规则更新；
 *   - message：可选的附加消息（如拒绝原因）。
 */
type BridgePermissionResponse = {
  behavior: 'allow' | 'deny'
  updatedInput?: Record<string, unknown>
  updatedPermissions?: PermissionUpdate[]
  message?: string
}

/**
 * Bridge 权限请求/响应的操作接口。
 *
 * 由 replBridge（v1）或 envLessBridgeCore（v2）在初始化时创建并注入到
 * 工具执行层的权限检查流程中。每个方法对应权限流程中的一个操作：
 *
 *   - sendRequest：向服务端发送权限审核请求（工具调用前触发）；
 *   - sendResponse：将用户在 claude.ai 上的审核决策回传给本地等待者；
 *   - cancelRequest：取消一个未决的 control_request（如对话中断时清理 UI）；
 *   - onResponse：注册一个一次性响应处理器，返回取消订阅函数。
 */
type BridgePermissionCallbacks = {
  /** 向 claude.ai 发送工具调用权限审核请求，等待用户审批 */
  sendRequest(
    requestId: string,
    toolName: string,
    input: Record<string, unknown>,
    toolUseId: string,
    description: string,
    permissionSuggestions?: PermissionUpdate[],
    blockedPath?: string,
  ): void
  /** 将审核响应传递给本地等待该 requestId 响应的 Promise 解析器 */
  sendResponse(requestId: string, response: BridgePermissionResponse): void
  /** Cancel a pending control_request so the web app can dismiss its prompt. */
  /** 取消未决的 control_request，通知 claude.ai 网页端关闭权限审批弹窗 */
  cancelRequest(requestId: string): void
  /** 注册 requestId 对应的响应处理器，返回取消订阅函数（用于超时或提前取消） */
  onResponse(
    requestId: string,
    handler: (response: BridgePermissionResponse) => void,
  ): () => void // returns unsubscribe
}

/**
 * 从 control_response payload 中安全提取 BridgePermissionResponse 的类型守卫。
 *
 * 通过校验 behavior 判别字段（'allow' | 'deny'）来验证 payload 格式，
 * 避免使用不安全的 `as` 类型断言。
 * 当 Bridge 收到服务端的 control_response 时，先用此函数验证 payload 格式，
 * 再将其分发给等待权限结果的回调。
 *
 * Type predicate for validating a parsed control_response payload
 * as a BridgePermissionResponse. Checks the required `behavior`
 * discriminant rather than using an unsafe `as` cast.
 */
function isBridgePermissionResponse(
  value: unknown,
): value is BridgePermissionResponse {
  if (!value || typeof value !== 'object') return false
  return (
    'behavior' in value &&
    (value.behavior === 'allow' || value.behavior === 'deny') // 仅 allow/deny 为有效值
  )
}

export { isBridgePermissionResponse }
export type { BridgePermissionCallbacks, BridgePermissionResponse }
