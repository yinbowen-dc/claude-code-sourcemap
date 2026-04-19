/**
 * workSecret.ts — 工作项密钥解码与会话 URL 构建工具
 *
 * 在 Claude Code 系统流程中的位置：
 *   Bridge 工作项处理流程（sessionRunner.ts / replBridge.ts）
 *     └─> workSecret.ts（本文件）——解码工作密钥 + 构建 SDK URL + 注册 CCR v2 worker
 *
 * 主要功能：
 *   - decodeWorkSecret：解码 base64url 工作密钥并校验版本和必填字段
 *   - buildSdkUrl：构建 v1（WebSocket）会话 URL（含 localhost/生产环境路径差异处理）
 *   - sameSessionId：忽略前缀比较两个会话 ID（处理 cse_* vs session_* 兼容问题）
 *   - buildCCRv2SdkUrl：构建 CCR v2（HTTP）会话 URL
 *   - registerWorker：注册 bridge 为 CCR v2 会话的 worker，获取 worker_epoch
 *
 * 会话 ID 兼容性（sameSessionId）：
 *   CCR v2 兼容层对 v1 API 客户端返回 session_* 格式，
 *   而基础设施层（sandbox-gateway 工作队列、工作轮询响应）使用 cse_* 格式。
 *   两者底层 UUID 相同，sameSessionId 通过比较最后一个下划线后的部分来忽略前缀差异。
 */
import axios from 'axios'
import { jsonParse, jsonStringify } from '../utils/slowOperations.js'
import type { WorkSecret } from './types.js'

/**
 * 解码 base64url 编码的工作密钥并校验格式。
 *
 * 解码流程：
 *   1. base64url 解码 → UTF-8 字符串 → JSON 解析
 *   2. 校验 version 字段为 1（当前唯一支持的版本）
 *   3. 校验 session_ingress_token 为非空字符串
 *   4. 校验 api_base_url 为字符串
 *
 * 任何校验失败均抛出 Error，调用方应捕获并处理（记录日志 + 停止处理该工作项）。
 *
 * Decode a base64url-encoded work secret and validate its version.
 */
export function decodeWorkSecret(secret: string): WorkSecret {
  const json = Buffer.from(secret, 'base64url').toString('utf-8') // base64url 解码
  const parsed: unknown = jsonParse(json) // JSON 解析
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !('version' in parsed) ||
    parsed.version !== 1 // 仅支持 version=1
  ) {
    throw new Error(
      `Unsupported work secret version: ${parsed && typeof parsed === 'object' && 'version' in parsed ? parsed.version : 'unknown'}`,
    )
  }
  const obj = parsed as Record<string, unknown>
  if (
    typeof obj.session_ingress_token !== 'string' ||
    obj.session_ingress_token.length === 0 // session_ingress_token 不能为空
  ) {
    throw new Error(
      'Invalid work secret: missing or empty session_ingress_token',
    )
  }
  if (typeof obj.api_base_url !== 'string') {
    throw new Error('Invalid work secret: missing api_base_url') // api_base_url 必须为字符串
  }
  return parsed as WorkSecret
}

/**
 * 从 API 基础 URL 和会话 ID 构建 v1 WebSocket SDK URL。
 *
 * 路径差异（localhost vs 生产）：
 *   - localhost/127.0.0.1：使用 ws:// 和 /v2/ 路径（直连 session-ingress，无 Envoy 重写）
 *   - 生产环境：使用 wss:// 和 /v1/ 路径（Envoy 将 /v1/ 重写为 /v2/）
 *
 * 构建格式：{protocol}://{host}/{version}/session_ingress/ws/{sessionId}
 *
 * Build a WebSocket SDK URL from the API base URL and session ID.
 * Strips the HTTP(S) protocol and constructs a ws(s):// ingress URL.
 */
export function buildSdkUrl(apiBaseUrl: string, sessionId: string): string {
  const isLocalhost =
    apiBaseUrl.includes('localhost') || apiBaseUrl.includes('127.0.0.1')
  const protocol = isLocalhost ? 'ws' : 'wss' // localhost 用 ws，生产用 wss
  const version = isLocalhost ? 'v2' : 'v1' // localhost 直连 v2，生产通过 Envoy 重写 v1→v2
  const host = apiBaseUrl.replace(/^https?:\/\//, '').replace(/\/+$/, '') // 剥离协议和末尾斜杠
  return `${protocol}://${host}/${version}/session_ingress/ws/${sessionId}`
}

/**
 * 比较两个会话 ID 是否指向同一会话（忽略前缀差异）。
 *
 * 背景：
 *   CCR v2 兼容层对 v1 API 客户端返回 session_* 格式（compat/convert.go:41），
 *   而基础设施层（sandbox-gateway 工作队列、工作轮询响应）使用 cse_* 格式（compat/CLAUDE.md:13）。
 *   两者底层 UUID 相同，仅前缀不同。
 *   若不使用此函数，replBridge 在 ccr_v2_compat_enabled 开启时会因前缀不匹配
 *   将自己的会话误判为"外部会话"而拒绝处理。
 *
 * 比较策略：
 *   取最后一个下划线之后的部分作为"body"——同时处理 {tag}_{body} 和 {tag}_staging_{body} 格式。
 *   对无下划线的 ID（裸 UUID）：lastIndexOf 返回 -1，slice(0) 返回整个字符串，
 *   已通过 a === b 的直接比较处理。
 *   要求 body 长度 >= 4，避免格式错误的 ID 产生意外匹配（如单字符标签残留）。
 *
 * Compare two session IDs regardless of their tagged-ID prefix.
 */
export function sameSessionId(a: string, b: string): boolean {
  if (a === b) return true // 完全相同，快速路径
  // body = 最后一个下划线之后的部分（同时处理 {tag}_{body} 和 {tag}_staging_{body}）
  const aBody = a.slice(a.lastIndexOf('_') + 1)
  const bBody = b.slice(b.lastIndexOf('_') + 1)
  // 要求 body 长度 >= 4，防止格式错误的短后缀产生意外匹配
  return aBody.length >= 4 && aBody === bBody
}

/**
 * 从 API 基础 URL 和会话 ID 构建 CCR v2 HTTP 会话 URL。
 *
 * 与 buildSdkUrl 不同：
 *   - 返回 HTTP(S) URL，而非 ws:// URL
 *   - 指向 /v1/code/sessions/{id}（CCR v2 code-session API 的基础路径）
 *   - 子进程 Claude Code 从此基础路径派生 SSE 流路径和 worker 端点
 *
 * Build a CCR v2 session URL from the API base URL and session ID.
 */
export function buildCCRv2SdkUrl(
  apiBaseUrl: string,
  sessionId: string,
): string {
  const base = apiBaseUrl.replace(/\/+$/, '') // 移除末尾斜杠，避免双斜杠
  return `${base}/v1/code/sessions/${sessionId}`
}

/**
 * 将本 bridge 注册为 CCR v2 会话的 worker，返回 worker_epoch。
 *
 * worker_epoch 必须传递给子进程 Claude Code，
 * 供其 CCRClient 在每次心跳/状态/事件请求中携带，以标识 worker 代次。
 *
 * 对标 environment-manager 在容器路径中的操作
 * （api-go/environment-manager/cmd/cmd_task_run.go RegisterWorker）。
 *
 * 注意：protojson 将 int64 序列化为字符串以避免 JS 精度丢失；
 * Go 端在某些编码设置下也可能返回数字，因此同时处理字符串和数字两种格式。
 *
 * Register this bridge as the worker for a CCR v2 session.
 * Returns the worker_epoch to pass to the child CC process.
 */
export async function registerWorker(
  sessionUrl: string,
  accessToken: string,
): Promise<number> {
  const response = await axios.post(
    `${sessionUrl}/worker/register`,
    {},
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
      },
      timeout: 10_000, // 10 秒超时
    },
  )
  // protojson 将 int64 序列化为字符串以避免 JS number 精度丢失；
  // Go 端在某些编码设置下也可能直接返回 number
  const raw = response.data?.worker_epoch
  const epoch = typeof raw === 'string' ? Number(raw) : raw // 统一转换为 number
  if (
    typeof epoch !== 'number' ||
    !Number.isFinite(epoch) ||
    !Number.isSafeInteger(epoch) // 必须是安全整数（int64 范围内）
  ) {
    throw new Error(
      `registerWorker: invalid worker_epoch in response: ${jsonStringify(response.data)}`,
    )
  }
  return epoch
}
