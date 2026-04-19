/**
 * 传输层工厂工具 — 根据环境变量和 URL 协议选择合适的传输实现。
 *
 * 在整个 Claude Code 系统中的位置：
 * 本文件是 RemoteIO 建立远程连接时的传输选择入口。它抽象了三种传输实现的
 * 选择逻辑，使调用方无需关心环境变量细节，只需传入 URL 即可获得对应的传输实例。
 *
 * 传输选择优先级（由高到低）：
 *   1. SSETransport  （SSE 读取 + HTTP POST 写入）：当 CLAUDE_CODE_USE_CCR_V2 为真时
 *   2. HybridTransport（WebSocket 读取 + HTTP POST 写入）：当 CLAUDE_CODE_POST_FOR_SESSION_INGRESS_V2 为真时
 *   3. WebSocketTransport（WebSocket 双向通信）：默认选项
 */
import { URL } from 'url'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { HybridTransport } from './HybridTransport.js'
import { SSETransport } from './SSETransport.js'
import type { Transport } from './Transport.js'
import { WebSocketTransport } from './WebSocketTransport.js'

/**
 * 根据 URL 和环境变量获取适合当前部署环境的传输实例。
 *
 * 流程：
 * 1. 若 CLAUDE_CODE_USE_CCR_V2 为真，使用 SSE + POST 模式（CCR v2 协议）：
 *    - 将 ws/wss 协议转换为 http/https。
 *    - 在路径末尾追加 `/worker/events/stream` 构造 SSE 流 URL。
 *    - 返回 SSETransport 实例。
 * 2. 若 URL 为 ws/wss 协议：
 *    - 若 CLAUDE_CODE_POST_FOR_SESSION_INGRESS_V2 为真，返回 HybridTransport（WS 读 + POST 写）。
 *    - 否则返回 WebSocketTransport（纯 WebSocket 双向通信）。
 * 3. 其他协议抛出错误（不支持 http/https 直接作为传输协议）。
 *
 * @param url            远程会话 URL（通常来自 --sdk-url 参数）
 * @param headers        初始请求头（认证、会话 ID 等）
 * @param sessionId      可选的会话 ID，用于断线重连时的消息重放
 * @param refreshHeaders 可选的请求头刷新回调，用于 token 过期后重新获取认证头
 */
export function getTransportForUrl(
  url: URL,
  headers: Record<string, string> = {},
  sessionId?: string,
  refreshHeaders?: () => Record<string, string>,
): Transport {
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_CCR_V2)) {
    // CCR v2 模式：SSE 读取 + HTTP POST 写入
    // --sdk-url 是会话 URL（.../sessions/{id}），
    // 通过追加 /worker/events/stream 派生出 SSE 流 URL
    const sseUrl = new URL(url.href)
    // WebSocket 协议转换为对应的 HTTP 协议，以便 SSE 使用标准 HTTPS 连接
    if (sseUrl.protocol === 'wss:') {
      sseUrl.protocol = 'https:'
    } else if (sseUrl.protocol === 'ws:') {
      sseUrl.protocol = 'http:'
    }
    // 移除末尾斜杠后追加 SSE 流端点路径
    sseUrl.pathname =
      sseUrl.pathname.replace(/\/$/, '') + '/worker/events/stream'
    return new SSETransport(sseUrl, headers, sessionId, refreshHeaders)
  }

  if (url.protocol === 'ws:' || url.protocol === 'wss:') {
    if (isEnvTruthy(process.env.CLAUDE_CODE_POST_FOR_SESSION_INGRESS_V2)) {
      // Hybrid 模式：WebSocket 读取 + HTTP POST 写入，防止 Firestore 并发写冲突
      return new HybridTransport(url, headers, sessionId, refreshHeaders)
    }
    // 默认模式：纯 WebSocket 双向通信
    return new WebSocketTransport(url, headers, sessionId, refreshHeaders)
  } else {
    // 不支持其他协议（如 http/https 不应直接作为传输层协议）
    throw new Error(`Unsupported protocol: ${url.protocol}`)
  }
}
