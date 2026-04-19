/**
 * bridgeConfig.ts — Bridge 认证与 API 基础 URL 的统一配置层
 *
 * 在 Claude Code 系统流程中的位置：
 *   CLI / Daemon / 各 Bridge 相关模块
 *     └─> bridgeConfig.ts（本文件）——统一提供 Bridge 所需的 Token 和 Base URL
 *           ├─ getBridgeTokenOverride()  / getBridgeAccessToken()
 *           └─ getBridgeBaseUrlOverride() / getBridgeBaseUrl()
 *
 * 背景：在重构之前，CLAUDE_BRIDGE_* 环境变量覆盖逻辑分散在十余个文件中
 * （inboundAttachments、BriefTool/upload、bridgeMain、initReplBridge、
 *  remoteBridgeCore、daemon workers、/rename、/remote-control 等），
 * 本文件将其集中管理，避免重复代码，确保一致性。
 *
 * 设计分两层：
 *   - *Override() 系列：仅返回 ant 内部开发人员使用的环境变量值（或 undefined）；
 *   - 非 Override 版本：先查 Override，再回落到真实的 OAuth Token / 生产 URL。
 * 使用其他认证来源的调用方（如 Daemon 使用 IPC 认证）可以直接使用
 * Override 版本的 getter，跳过 OAuth 流程。
 *
 * Shared bridge auth/URL resolution. Consolidates the ant-only
 * CLAUDE_BRIDGE_* dev overrides that were previously copy-pasted across
 * a dozen files — inboundAttachments, BriefTool/upload, bridgeMain,
 * initReplBridge, remoteBridgeCore, daemon workers, /rename,
 * /remote-control.
 *
 * Two layers: *Override() returns the ant-only env var (or undefined);
 * the non-Override versions fall through to the real OAuth store/config.
 * Callers that compose with a different auth source (e.g. daemon workers
 * using IPC auth) use the Override getters directly.
 */

import { getOauthConfig } from '../constants/oauth.js'
import { getClaudeAIOAuthTokens } from '../utils/auth.js'

/**
 * 获取 ant 内部开发人员专用的 Bridge OAuth Token 覆盖值。
 *
 * 仅在 USER_TYPE=ant 且设置了 CLAUDE_BRIDGE_OAUTH_TOKEN 环境变量时有效，
 * 用于在开发/测试环境中绕过正常的 OAuth 登录流程，直接使用指定 Token。
 * 普通用户或未设置该变量时返回 undefined。
 *
 * Ant-only dev override: CLAUDE_BRIDGE_OAUTH_TOKEN, else undefined.
 */
export function getBridgeTokenOverride(): string | undefined {
  return (
    // USER_TYPE=ant 且 CLAUDE_BRIDGE_OAUTH_TOKEN 有值时，返回该 Token
    (process.env.USER_TYPE === 'ant' &&
      process.env.CLAUDE_BRIDGE_OAUTH_TOKEN) ||
    undefined
  )
}

/**
 * 获取 ant 内部开发人员专用的 Bridge API Base URL 覆盖值。
 *
 * 仅在 USER_TYPE=ant 且设置了 CLAUDE_BRIDGE_BASE_URL 环境变量时有效，
 * 用于将 Bridge API 请求指向开发/预发布环境的后端。
 * 普通用户或未设置该变量时返回 undefined。
 *
 * Ant-only dev override: CLAUDE_BRIDGE_BASE_URL, else undefined.
 */
export function getBridgeBaseUrlOverride(): string | undefined {
  return (
    // USER_TYPE=ant 且 CLAUDE_BRIDGE_BASE_URL 有值时，返回该 URL
    (process.env.USER_TYPE === 'ant' && process.env.CLAUDE_BRIDGE_BASE_URL) ||
    undefined
  )
}

/**
 * 获取用于 Bridge API 调用的 Access Token。
 *
 * 优先级：
 *   1. ant 开发覆盖值（CLAUDE_BRIDGE_OAUTH_TOKEN，仅 USER_TYPE=ant 生效）
 *   2. 本地 OAuth Keychain 中存储的 Claude.ai Access Token
 *
 * 返回 undefined 表示用户尚未登录，调用方应提示用户登录。
 *
 * Access token for bridge API calls: dev override first, then the OAuth
 * keychain. Undefined means "not logged in".
 */
export function getBridgeAccessToken(): string | undefined {
  // ?? 运算符：Override 为 undefined 时，回落到 OAuth Keychain 中的 Token
  return getBridgeTokenOverride() ?? getClaudeAIOAuthTokens()?.accessToken
}

/**
 * 获取用于 Bridge API 调用的基础 URL。
 *
 * 优先级：
 *   1. ant 开发覆盖值（CLAUDE_BRIDGE_BASE_URL，仅 USER_TYPE=ant 生效）
 *   2. 生产环境 OAuth 配置中的 BASE_API_URL（通常为 https://api.anthropic.com）
 *
 * 此函数始终返回有效的 URL 字符串（不会返回 undefined）。
 *
 * Base URL for bridge API calls: dev override first, then the production
 * OAuth config. Always returns a URL.
 */
export function getBridgeBaseUrl(): string {
  // ?? 运算符：Override 为 undefined 时，回落到生产 OAuth 配置的 Base URL
  return getBridgeBaseUrlOverride() ?? getOauthConfig().BASE_API_URL
}
