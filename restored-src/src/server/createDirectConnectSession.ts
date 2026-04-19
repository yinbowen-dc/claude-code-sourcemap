/* eslint-disable eslint-plugin-n/no-unsupported-features/node-builtins */

/**
 * @file createDirectConnectSession.ts
 * @description 直连会话创建工具 —— 负责向本地直连服务器（direct-connect server）发起 HTTP 请求，
 * 创建新的 Claude 会话并返回连接配置。
 *
 * 在整个 Claude Code 系统流程中的位置：
 *   REPL 入口 / CLI 命令解析
 *     └─► createDirectConnectSession（本文件）
 *           └─► DirectConnectSessionManager（使用返回的 DirectConnectConfig 建立 WebSocket）
 *
 * 适用场景：
 *   本地部署的 Claude 服务器（如通过 `claude server` 命令启动的服务）。
 *   与 CCR（云端远程运行）不同，直连模式通过本地或私有服务器运行 Claude。
 *
 * 流程：
 *   POST ${serverUrl}/sessions → 校验响应（Zod）→ 返回 { config, workDir }
 */

import { errorMessage } from '../utils/errors.js'
import { jsonStringify } from '../utils/slowOperations.js'
import type { DirectConnectConfig } from './directConnectManager.js'
import { connectResponseSchema } from './types.js'

/**
 * 直连会话创建失败时抛出的专用错误类型。
 *
 * 与通用 Error 区分，便于调用方通过 instanceof 精确捕获直连特定错误，
 * 并向用户展示友好的错误信息（如"无法连接到服务器"）。
 */
export class DirectConnectError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DirectConnectError' // 设置 name 便于日志区分错误类型
  }
}

/**
 * 向直连服务器发送 HTTP POST 请求，创建新会话并返回连接配置。
 *
 * 流程：
 *  1. 构造请求头（可选的 Bearer Token 认证）
 *  2. POST 到 `${serverUrl}/sessions`，携带工作目录和权限跳过标志
 *  3. 检查 HTTP 状态码，非 2xx 时抛出 DirectConnectError
 *  4. 使用 Zod schema 校验响应体，格式不符时抛出 DirectConnectError
 *  5. 返回 DirectConnectConfig（含 wsUrl 供 WebSocket 连接）和可选的 workDir
 *
 * @param serverUrl                   直连服务器的 HTTP 基址（如 http://localhost:3000）
 * @param authToken                   可选的认证令牌，放入 Authorization: Bearer 头
 * @param cwd                         新会话的工作目录
 * @param dangerouslySkipPermissions  是否跳过权限检查（危险操作，仅供测试/受信任环境）
 * @returns                           { config: DirectConnectConfig, workDir?: string }
 * @throws DirectConnectError         网络错误、HTTP 错误或响应格式错误时抛出
 */
export async function createDirectConnectSession({
  serverUrl,
  authToken,
  cwd,
  dangerouslySkipPermissions,
}: {
  serverUrl: string
  authToken?: string
  cwd: string
  dangerouslySkipPermissions?: boolean
}): Promise<{
  config: DirectConnectConfig
  workDir?: string
}> {
  // 构造请求头，若提供了 authToken 则附加 Bearer 认证
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  }
  if (authToken) {
    headers['authorization'] = `Bearer ${authToken}` // 服务器鉴权
  }

  let resp: Response
  try {
    // 发送 POST /sessions，携带工作目录和可选的权限跳过标志
    resp = await fetch(`${serverUrl}/sessions`, {
      method: 'POST',
      headers,
      body: jsonStringify({
        cwd, // 告知服务器新会话的工作目录
        ...(dangerouslySkipPermissions && {
          dangerously_skip_permissions: true, // 危险标志：跳过所有权限检查
        }),
      }),
    })
  } catch (err) {
    // 网络级别错误（DNS 解析失败、连接拒绝等）
    throw new DirectConnectError(
      `Failed to connect to server at ${serverUrl}: ${errorMessage(err)}`,
    )
  }

  if (!resp.ok) {
    // HTTP 错误（4xx/5xx）：服务器明确拒绝请求
    throw new DirectConnectError(
      `Failed to create session: ${resp.status} ${resp.statusText}`,
    )
  }

  // 使用 Zod 校验响应体格式，确保包含 session_id 和 ws_url 等必要字段
  const result = connectResponseSchema().safeParse(await resp.json())
  if (!result.success) {
    throw new DirectConnectError(
      `Invalid session response: ${result.error.message}`,
    )
  }

  const data = result.data
  return {
    config: {
      serverUrl,
      sessionId: data.session_id, // 服务器分配的会话 ID
      wsUrl: data.ws_url,         // WebSocket 连接 URL，供 DirectConnectSessionManager 使用
      authToken,                  // 透传认证令牌，供 WebSocket 握手使用
    },
    workDir: data.work_dir, // 服务器实际使用的工作目录（可能与请求的 cwd 不同）
  }
}
