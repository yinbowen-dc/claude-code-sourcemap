/**
 * OAuth Profile 获取模块
 *
 * 在 Claude Code 系统流程中的位置：
 * 本文件是 OAuth 子系统的 profile 数据获取层，提供两条独立的 API 调用路径
 * 以适应不同的认证上下文：
 *   - API Key 路径：适用于已有 API Key 的交互式会话
 *   - OAuth Token 路径：适用于通过 OAuth 授权码流程获取的 Bearer Token
 *
 * 在 OAuth 流程中的位置：
 *   exchangeCodeForTokens → fetchProfileInfo（client.ts）→ getOauthProfileFromOauthToken（本文件）
 *   checkSubscription → getOauthProfileFromApiKey（本文件）
 *
 * 主要功能：
 * - getOauthProfileFromApiKey：用 x-api-key 请求 /api/claude_cli_profile，
 *   附带 anthropic-beta: OAUTH_BETA_HEADER 和 account_uuid 查询参数
 * - getOauthProfileFromOauthToken：用 Bearer Token 请求 /api/oauth/profile，
 *   10s 超时，错误时记录日志返回 undefined
 *
 * 错误处理策略：
 * - 两个函数均以 try-catch 捕获所有错误，调用 logError 记录后返回 undefined
 * - 上层调用方（fetchProfileInfo、populateOAuthAccountInfoIfNeeded 等）需处理 undefined 情况
 */

import axios from 'axios'
import { getOauthConfig, OAUTH_BETA_HEADER } from 'src/constants/oauth.js'
import type { OAuthProfileResponse } from 'src/services/oauth/types.js'
import { getAnthropicApiKey } from 'src/utils/auth.js'
import { getGlobalConfig } from 'src/utils/config.js'
import { logError } from 'src/utils/log.js'

/**
 * 使用 API Key 获取 OAuth Profile 信息
 *
 * 适用于已有 Anthropic API Key 的交互式会话（如 claude_cli_profile 端点）。
 * 流程：
 * 1. 从全局配置读取 accountUuid，从安全存储读取 API Key
 * 2. 两者均存在时，向 /api/claude_cli_profile 发起 GET 请求
 * 3. 请求头包含 x-api-key 和 anthropic-beta: OAUTH_BETA_HEADER（启用 OAuth Beta 功能）
 * 4. 查询参数包含 account_uuid（服务端用于关联账户）
 * 5. 10s 超时；任何错误均记录并返回 undefined
 *
 * @returns OAuthProfileResponse 或 undefined（认证失败、参数缺失、网络错误时）
 */
export async function getOauthProfileFromApiKey(): Promise<
  OAuthProfileResponse | undefined
> {
  // Assumes interactive session
  // 从全局配置读取账户 UUID（用于 API 请求参数）
  const config = getGlobalConfig()
  const accountUuid = config.oauthAccount?.accountUuid
  // 从安全存储中读取当前 API Key
  const apiKey = getAnthropicApiKey()

  // Need both account UUID and API key to check
  // 两者缺一不可：accountUuid 用于查询参数，apiKey 用于认证
  if (!accountUuid || !apiKey) {
    return
  }
  // 构建完整的 API 端点 URL
  const endpoint = `${getOauthConfig().BASE_API_URL}/api/claude_cli_profile`
  try {
    const response = await axios.get<OAuthProfileResponse>(endpoint, {
      headers: {
        // 使用 x-api-key 认证方式（区别于 Bearer Token 认证）
        'x-api-key': apiKey,
        // 启用 OAuth Beta 特性的请求头（服务端特性开关）
        'anthropic-beta': OAUTH_BETA_HEADER,
      },
      params: {
        // 通过 account_uuid 参数让服务端关联到正确的用户账户
        account_uuid: accountUuid,
      },
      timeout: 10000,
    })
    return response.data
  } catch (error) {
    // 记录错误后返回 undefined，不向上层抛出（防止阻断启动流程）
    logError(error as Error)
  }
}

/**
 * 使用 OAuth Bearer Token 获取 OAuth Profile 信息
 *
 * 适用于 OAuth 授权码流程完成后的令牌持有场景（如令牌交换后、令牌刷新后）。
 * 流程：
 * 1. 向 /api/oauth/profile 发起 GET 请求
 * 2. 请求头包含 Authorization: Bearer {accessToken} 和 Content-Type: application/json
 * 3. 10s 超时；任何错误均调用 logError 记录后返回 undefined
 *
 * @param accessToken 有效的 OAuth 访问令牌（Bearer Token）
 * @returns OAuthProfileResponse 或 undefined（令牌无效、网络错误时）
 */
export async function getOauthProfileFromOauthToken(
  accessToken: string,
): Promise<OAuthProfileResponse | undefined> {
  // 构建 OAuth Profile API 端点 URL
  const endpoint = `${getOauthConfig().BASE_API_URL}/api/oauth/profile`
  try {
    const response = await axios.get<OAuthProfileResponse>(endpoint, {
      headers: {
        // Bearer Token 认证方式（OAuth 2.0 标准）
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      timeout: 10000,
    })
    return response.data
  } catch (error) {
    // 记录错误后返回 undefined，调用方需处理 undefined 情况
    logError(error as Error)
  }
}
