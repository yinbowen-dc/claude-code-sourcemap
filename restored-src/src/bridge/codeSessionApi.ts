/**
 * codeSessionApi.ts — CCR v2 代码会话 HTTP API 轻量封装
 *
 * 在 Claude Code 系统流程中的位置：
 *   Bridge v2（无环境变量）启动流程
 *     └─> remoteBridgeCore.ts / SDK /bridge 子路径
 *           └─> codeSessionApi.ts（本文件）——封装 CCR v2 代码会话创建和凭据获取
 *
 * 背景：
 *   从 remoteBridgeCore.ts 中独立出此文件，使 SDK /bridge 子路径可以导出
 *   createCodeSession + fetchRemoteCredentials，而不捆绑 CLI 的重型依赖树
 *   （analytics、transport 等）。
 *   调用方显式传入 accessToken + baseUrl，本文件不做隐式认证或配置读取。
 *
 * 主要 API：
 *   - createCodeSession：创建 CCR v2 代码会话（POST /v1/code/sessions），
 *     返回 cse_* 格式的会话 ID；
 *   - fetchRemoteCredentials：获取 Worker JWT 凭据（POST /v1/code/sessions/{id}/bridge），
 *     用于建立 WebSocket 传输连接。
 *
 * Thin HTTP wrappers for the CCR v2 code-session API.
 *
 * Separate file from remoteBridgeCore.ts so the SDK /bridge subpath can
 * export createCodeSession + fetchRemoteCredentials without bundling the
 * heavy CLI tree (analytics, transport, etc.). Callers supply explicit
 * accessToken + baseUrl — no implicit auth or config reads.
 */

import axios from 'axios'
import { logForDebugging } from '../utils/debug.js'
import { errorMessage } from '../utils/errors.js'
import { jsonStringify } from '../utils/slowOperations.js'
import { extractErrorDetail } from './debugUtils.js'

/** Anthropic API 协议版本标识 */
const ANTHROPIC_VERSION = '2023-06-01'

/**
 * 构造包含 OAuth Bearer Token 的 HTTP 请求头。
 * 所有 CCR v2 API 请求均使用此格式。
 */
function oauthHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    'anthropic-version': ANTHROPIC_VERSION,
  }
}

/**
 * 在 CCR 后端创建一个新的代码会话。
 *
 * 调用 POST /v1/code/sessions，返回 cse_* 格式的会话 ID。
 * bridge: {} 是 oneof runner 的正向信号，缺少此字段或
 * environment_id 为空字符串会导致 400 错误。
 *
 * 任何网络错误或非 200/201 响应均返回 null（而非抛出异常），
 * 由调用方决定重试策略。
 *
 * @param baseUrl claude.ai API 基础 URL
 * @param accessToken OAuth 访问令牌
 * @param title 会话标题（显示在 claude.ai 界面）
 * @param timeoutMs 请求超时时间（毫秒）
 * @param tags 可选的标签数组（用于会话分类）
 * @returns cse_* 格式的会话 ID，失败时返回 null
 */
export async function createCodeSession(
  baseUrl: string,
  accessToken: string,
  title: string,
  timeoutMs: number,
  tags?: string[],
): Promise<string | null> {
  const url = `${baseUrl}/v1/code/sessions`
  let response
  try {
    response = await axios.post(
      url,
      // bridge: {} 是 oneof runner 的正向信号——缺少此字段或 environment_id: "" 会 400
      // BridgeRunner 目前是空消息，为未来的 bridge 特定选项预留扩展位
      { title, bridge: {}, ...(tags?.length ? { tags } : {}) },
      {
        headers: oauthHeaders(accessToken),
        timeout: timeoutMs,
        validateStatus: s => s < 500, // 4xx 由后续状态码检查处理，不作为 axios 错误
      },
    )
  } catch (err: unknown) {
    logForDebugging(
      `[code-session] Session create request failed: ${errorMessage(err)}`,
    )
    return null
  }

  if (response.status !== 200 && response.status !== 201) {
    const detail = extractErrorDetail(response.data)
    logForDebugging(
      `[code-session] Session create failed ${response.status}${detail ? `: ${detail}` : ''}`,
    )
    return null
  }

  // 验证响应体中包含 cse_* 格式的会话 ID
  const data: unknown = response.data
  if (
    !data ||
    typeof data !== 'object' ||
    !('session' in data) ||
    !data.session ||
    typeof data.session !== 'object' ||
    !('id' in data.session) ||
    typeof data.session.id !== 'string' ||
    !data.session.id.startsWith('cse_') // 必须是 cse_* 前缀
  ) {
    logForDebugging(
      `[code-session] No session.id (cse_*) in response: ${jsonStringify(data).slice(0, 200)}`,
    )
    return null
  }
  return data.session.id
}

/**
 * CCR Worker 凭据类型。
 *
 * JWT 是不透明令牌——请勿解码。
 * 每次调用 /bridge 都会在服务端递增 worker_epoch（即注册操作）。
 *
 * Credentials from POST /bridge. JWT is opaque — do not decode.
 * Each /bridge call bumps worker_epoch server-side (it IS the register).
 */
export type RemoteCredentials = {
  worker_jwt: string      // Worker JWT 令牌（用于 WebSocket 传输认证）
  api_base_url: string    // Worker API 基础 URL（可能与 claude.ai 主域不同）
  expires_in: number      // JWT 有效期（秒）
  worker_epoch: number    // Worker 轮次（每次重新注册后递增，用于防止僵尸 worker）
}

/**
 * 获取 Bridge Worker 凭据（Worker JWT）。
 *
 * 调用 POST /v1/code/sessions/{sessionId}/bridge，
 * 返回 Worker JWT 令牌和 API 基础 URL，用于建立 WebSocket 传输连接。
 * 每次调用都是一次注册操作（server-side worker_epoch 递增）。
 *
 * 可选传入 trustedDeviceToken 以在受信任设备上获得更高权限。
 *
 * 任何网络错误或响应格式错误均返回 null，由调用方处理。
 */
export async function fetchRemoteCredentials(
  sessionId: string,
  baseUrl: string,
  accessToken: string,
  timeoutMs: number,
  trustedDeviceToken?: string,
): Promise<RemoteCredentials | null> {
  const url = `${baseUrl}/v1/code/sessions/${sessionId}/bridge`
  const headers = oauthHeaders(accessToken)
  if (trustedDeviceToken) {
    headers['X-Trusted-Device-Token'] = trustedDeviceToken // 受信任设备令牌头
  }
  let response
  try {
    response = await axios.post(
      url,
      {},
      {
        headers,
        timeout: timeoutMs,
        validateStatus: s => s < 500, // 4xx 由后续状态码检查处理
      },
    )
  } catch (err: unknown) {
    logForDebugging(
      `[code-session] /bridge request failed: ${errorMessage(err)}`,
    )
    return null
  }

  if (response.status !== 200) {
    const detail = extractErrorDetail(response.data)
    logForDebugging(
      `[code-session] /bridge failed ${response.status}${detail ? `: ${detail}` : ''}`,
    )
    return null
  }

  // 严格验证响应体结构（所有必需字段均不可缺少）
  const data: unknown = response.data
  if (
    data === null ||
    typeof data !== 'object' ||
    !('worker_jwt' in data) ||
    typeof data.worker_jwt !== 'string' ||
    !('expires_in' in data) ||
    typeof data.expires_in !== 'number' ||
    !('api_base_url' in data) ||
    typeof data.api_base_url !== 'string' ||
    !('worker_epoch' in data)
  ) {
    logForDebugging(
      `[code-session] /bridge response malformed (need worker_jwt, expires_in, api_base_url, worker_epoch): ${jsonStringify(data).slice(0, 200)}`,
    )
    return null
  }
  // protojson 将 int64 序列化为字符串（避免 JS 精度损失）；
  // Go 编码器也可能返回数字，因此需要同时处理两种情况。
  const rawEpoch = data.worker_epoch
  const epoch = typeof rawEpoch === 'string' ? Number(rawEpoch) : rawEpoch
  if (
    typeof epoch !== 'number' ||
    !Number.isFinite(epoch) ||
    !Number.isSafeInteger(epoch) // 确保安全整数，防止精度损失
  ) {
    logForDebugging(
      `[code-session] /bridge worker_epoch invalid: ${jsonStringify(rawEpoch)}`,
    )
    return null
  }
  return {
    worker_jwt: data.worker_jwt,
    api_base_url: data.api_base_url,
    expires_in: data.expires_in,
    worker_epoch: epoch,
  }
}
