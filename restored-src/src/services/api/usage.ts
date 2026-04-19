/**
 * 用量利用率查询模块
 *
 * 在 Claude Code 系统流程中的位置：
 *   Claude Code 运行时 → 定期调用 fetchUtilization() 获取订阅用量信息
 *   → claudeAiLimits.ts 根据返回结果更新配额状态并向 UI 发出告警
 *
 * 主要功能：
 *  - fetchUtilization — 查询当前用户的订阅用量信息（含多维度限速状态）
 *
 * 类型定义：
 *  - RateLimit    — 单项限速状态：利用率百分比 + 重置时间
 *  - ExtraUsage   — 额外用量状态：是否启用、月度上限、已用额度、利用率
 *  - Utilization  — 完整用量结构：5 小时/7 天/Opus/Sonnet 等维度限速 + 额外用量
 *
 * 短路条件（不发起 API 请求直接返回）：
 *  - 非 Claude.ai 订阅用户或缺少 profile scope → 返回空对象 {}
 *  - OAuth 令牌已过期 → 返回 null（避免产生无意义的 401 请求）
 */

import axios from 'axios'
import { getOauthConfig } from '../../constants/oauth.js'
import {
  getClaudeAIOAuthTokens,
  hasProfileScope,
  isClaudeAISubscriber,
} from '../../utils/auth.js'
import { getAuthHeaders } from '../../utils/http.js'
import { getClaudeCodeUserAgent } from '../../utils/userAgent.js'
import { isOAuthTokenExpired } from '../oauth/client.js'

/** 单项限速状态：利用率百分比（0~100）和下次重置时间 */
export type RateLimit = {
  utilization: number | null // 利用率百分比（0~100），null 表示未知
  resets_at: string | null // 限速重置时间（ISO 8601 格式），null 表示未知
}

/** 额外用量（付费超额）状态 */
export type ExtraUsage = {
  is_enabled: boolean        // 是否已启用额外用量功能
  monthly_limit: number | null  // 月度用量上限（积分），null 表示无限制
  used_credits: number | null   // 本月已消耗积分，null 表示未知
  utilization: number | null    // 额外用量利用率百分比，null 表示未知
}

/** 完整用量利用率结构，涵盖多个时间维度和模型维度 */
export type Utilization = {
  five_hour?: RateLimit | null          // 5 小时滚动窗口限速
  seven_day?: RateLimit | null          // 7 天滚动窗口总限速
  seven_day_oauth_apps?: RateLimit | null // 7 天 OAuth 应用专项限速
  seven_day_opus?: RateLimit | null     // 7 天 Opus 模型专项限速
  seven_day_sonnet?: RateLimit | null   // 7 天 Sonnet 模型专项限速
  extra_usage?: ExtraUsage | null       // 付费超额用量状态
}

/**
 * 查询当前用户的订阅用量利用率信息。
 *
 * 流程：
 *  1. 前置检查：非订阅用户或缺少 profile scope → 直接返回空对象（不发起请求）
 *  2. OAuth 令牌过期检查：令牌已过期 → 返回 null（避免无意义的 401 错误）
 *  3. 获取认证请求头，失败则抛出错误
 *  4. 调用 GET /api/oauth/usage，5 秒超时
 *  5. 返回 Utilization 数据（由调用方处理各维度限速状态）
 *
 * @returns 用量利用率数据；非订阅用户返回 {}；令牌过期返回 null
 */
export async function fetchUtilization(): Promise<Utilization | null> {
  // 前置检查：非订阅用户或缺少 profile scope 时直接返回空对象
  if (!isClaudeAISubscriber() || !hasProfileScope()) {
    return {}
  }

  // OAuth 令牌过期检查：令牌过期时跳过 API 调用，避免产生 401 错误
  const tokens = getClaudeAIOAuthTokens()
  if (tokens && isOAuthTokenExpired(tokens.expiresAt)) {
    return null
  }

  // 获取认证请求头（Bearer Token），失败时抛出错误
  const authResult = getAuthHeaders()
  if (authResult.error) {
    throw new Error(`Auth error: ${authResult.error}`)
  }

  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': getClaudeCodeUserAgent(), // 携带 Claude Code 版本标识
    ...authResult.headers,
  }

  const url = `${getOauthConfig().BASE_API_URL}/api/oauth/usage`

  // 发起用量查询请求，5 秒超时防止阻塞 UI 刷新
  const response = await axios.get<Utilization>(url, {
    headers,
    timeout: 5000, // 5 秒超时
  })

  return response.data
}
