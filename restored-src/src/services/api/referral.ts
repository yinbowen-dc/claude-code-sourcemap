/**
 * 推荐资格与 Guest Pass（访客通行证）缓存模块
 *
 * 在 Claude Code 系统流程中的位置：
 *   用户订阅 Max 计划后 → 系统检查是否具备推荐 Guest Pass 的资格
 *   → 命令行展示 /passes 命令（仅满足条件时可见）
 *
 * 主要功能：
 *  - fetchReferralEligibility         — 拉取当前组织的推荐资格信息
 *  - fetchReferralRedemptions         — 拉取推荐兑换记录
 *  - checkCachedPassesEligibility     — 同步读取 Pass 资格缓存状态
 *  - formatCreditAmount               — 将货币 minor_units 格式化为可读字符串
 *  - getCachedReferrerReward          — 读取缓存中的推荐奖励信息
 *  - getCachedRemainingPasses         — 读取缓存中的剩余 Pass 数量
 *  - fetchAndStorePassesEligibility   — 拉取并缓存 Pass 资格（含请求去重）
 *  - getCachedOrFetchPassesEligibility — 主入口：缓存优先，过期则后台刷新
 *  - prefetchPassesEligibility        — 启动时预取（非阻塞）
 *
 * 缓存设计：
 *  - 缓存 TTL：24 小时（CACHE_EXPIRATION_MS），资格变更仅在订阅/实验变更时发生
 *  - 按组织 UUID（orgId）分隔缓存条目
 *  - fetchInProgress：模块级 Promise，防止并发调用重复发起 API 请求
 *  - stale-while-revalidate：缓存过期时先返回旧值，后台异步刷新
 */

import axios from 'axios'
import { getOauthConfig } from '../../constants/oauth.js'
import {
  getOauthAccountInfo,
  getSubscriptionType,
  isClaudeAISubscriber,
} from '../../utils/auth.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import { logForDebugging } from '../../utils/debug.js'
import { logError } from '../../utils/log.js'
import { isEssentialTrafficOnly } from '../../utils/privacyLevel.js'
import { getOAuthHeaders, prepareApiRequest } from '../../utils/teleport/api.js'
import type {
  ReferralCampaign,
  ReferralEligibilityResponse,
  ReferralRedemptionsResponse,
  ReferrerRewardInfo,
} from '../oauth/types.js'

// 缓存有效期：24 小时（资格变更仅在订阅/实验变更时发生）
const CACHE_EXPIRATION_MS = 24 * 60 * 60 * 1000

// 模块级 in-flight Promise，防止并发请求重复调用 API
let fetchInProgress: Promise<ReferralEligibilityResponse | null> | null = null

/**
 * 拉取当前组织的推荐资格信息。
 *
 * 流程：
 *  1. 准备 OAuth 认证信息（accessToken + orgUUID）
 *  2. 调用 GET /api/oauth/organizations/{orgUUID}/referral/eligibility
 *  3. 返回 ReferralEligibilityResponse 原始数据
 *
 * @param campaign - 推荐活动标识，默认为 'claude_code_guest_pass'
 */
export async function fetchReferralEligibility(
  campaign: ReferralCampaign = 'claude_code_guest_pass',
): Promise<ReferralEligibilityResponse> {
  // 准备 OAuth 认证头和组织 UUID
  const { accessToken, orgUUID } = await prepareApiRequest()

  const headers = {
    ...getOAuthHeaders(accessToken),
    'x-organization-uuid': orgUUID, // 标识当前组织
  }

  const url = `${getOauthConfig().BASE_API_URL}/api/oauth/organizations/${orgUUID}/referral/eligibility`

  const response = await axios.get(url, {
    headers,
    params: { campaign }, // 通过 query param 传递活动标识
    timeout: 5000, // 5 秒超时，用于后台拉取
  })

  return response.data
}

/**
 * 拉取当前组织的推荐兑换记录。
 *
 * 流程：
 *  1. 准备 OAuth 认证信息
 *  2. 调用 GET /api/oauth/organizations/{orgUUID}/referral/redemptions
 *
 * @param campaign - 推荐活动标识，默认为 'claude_code_guest_pass'
 */
export async function fetchReferralRedemptions(
  campaign: string = 'claude_code_guest_pass',
): Promise<ReferralRedemptionsResponse> {
  const { accessToken, orgUUID } = await prepareApiRequest()

  const headers = {
    ...getOAuthHeaders(accessToken),
    'x-organization-uuid': orgUUID,
  }

  const url = `${getOauthConfig().BASE_API_URL}/api/oauth/organizations/${orgUUID}/referral/redemptions`

  const response = await axios.get<ReferralRedemptionsResponse>(url, {
    headers,
    params: { campaign },
    timeout: 10000, // 10 秒超时
  })

  return response.data
}

/**
 * 前置条件检查：用户是否具备访问 Guest Pass 功能的资格。
 *
 * 必须同时满足：
 *  - 有有效的组织 UUID
 *  - 是 Claude.ai 订阅用户
 *  - 订阅类型为 max（高级套餐）
 */
function shouldCheckForPasses(): boolean {
  return !!(
    getOauthAccountInfo()?.organizationUuid &&
    isClaudeAISubscriber() &&
    getSubscriptionType() === 'max' // 只有 max 套餐用户才有 Guest Pass 功能
  )
}

/**
 * 从全局配置读取 Guest Pass 资格缓存状态。
 *
 * 返回：
 *  - eligible：当前缓存的资格状态
 *  - needsRefresh：缓存是否过期或不存在（需要刷新）
 *  - hasCache：是否存在缓存条目
 */
export function checkCachedPassesEligibility(): {
  eligible: boolean
  needsRefresh: boolean
  hasCache: boolean
} {
  // 前置条件不满足时直接返回不可用状态
  if (!shouldCheckForPasses()) {
    return {
      eligible: false,
      needsRefresh: false,
      hasCache: false,
    }
  }

  const orgId = getOauthAccountInfo()?.organizationUuid
  if (!orgId) {
    return {
      eligible: false,
      needsRefresh: false,
      hasCache: false,
    }
  }

  const config = getGlobalConfig()
  const cachedEntry = config.passesEligibilityCache?.[orgId]

  if (!cachedEntry) {
    // 无缓存条目，需要发起请求
    return {
      eligible: false,
      needsRefresh: true,
      hasCache: false,
    }
  }

  const { eligible, timestamp } = cachedEntry
  const now = Date.now()
  // 判断缓存是否已超过 24 小时
  const needsRefresh = now - timestamp > CACHE_EXPIRATION_MS

  return {
    eligible,
    needsRefresh,
    hasCache: true,
  }
}

/** 各货币的符号映射表 */
const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: '$',
  EUR: '€',
  GBP: '£',
  BRL: 'R$',
  CAD: 'CA$',
  AUD: 'A$',
  NZD: 'NZ$',
  SGD: 'S$',
}

/**
 * 将推荐奖励金额格式化为可读字符串（如 "$5" 或 "€5.50"）。
 *
 * @param reward - 推荐奖励信息（含 amount_minor_units 和 currency）
 * @returns 格式化后的金额字符串
 */
export function formatCreditAmount(reward: ReferrerRewardInfo): string {
  // 未知货币时使用 "CURRENCY " 前缀
  const symbol = CURRENCY_SYMBOLS[reward.currency] ?? `${reward.currency} `
  const amount = reward.amount_minor_units / 100 // 最小货币单位（如美分）转主单位（如美元）
  // 整数金额不显示小数（如 $5），非整数保留两位（如 $5.50）
  const formatted = amount % 1 === 0 ? amount.toString() : amount.toFixed(2)
  return `${symbol}${formatted}`
}

/**
 * 从资格缓存中读取推荐人奖励信息。
 *
 * 适用于 v1 活动（带推荐人奖励），v2 活动不包含此字段。
 *
 * @returns 缓存中的奖励信息，无缓存或字段缺失时返回 null
 */
export function getCachedReferrerReward(): ReferrerRewardInfo | null {
  const orgId = getOauthAccountInfo()?.organizationUuid
  if (!orgId) return null
  const config = getGlobalConfig()
  const cachedEntry = config.passesEligibilityCache?.[orgId]
  return cachedEntry?.referrer_reward ?? null // referrer_reward 字段可能不存在
}

/**
 * 从资格缓存中读取剩余 Pass 数量。
 *
 * @returns 剩余 Pass 数量，无缓存或字段缺失时返回 null
 */
export function getCachedRemainingPasses(): number | null {
  const orgId = getOauthAccountInfo()?.organizationUuid
  if (!orgId) return null
  const config = getGlobalConfig()
  const cachedEntry = config.passesEligibilityCache?.[orgId]
  return cachedEntry?.remaining_passes ?? null
}

/**
 * 拉取 Guest Pass 资格并存入全局配置缓存。
 *
 * 并发去重策略：
 *  - 若已有 in-flight 请求（fetchInProgress 非 null），直接复用同一个 Promise
 *  - fetch 完成后（无论成功/失败）清空 fetchInProgress，允许下次重新发起
 *
 * @returns 拉取到的资格响应，失败时返回 null
 */
export async function fetchAndStorePassesEligibility(): Promise<ReferralEligibilityResponse | null> {
  // 已有进行中的请求时，直接返回同一个 Promise（防止重复请求）
  if (fetchInProgress) {
    logForDebugging('Passes: Reusing in-flight eligibility fetch')
    return fetchInProgress
  }

  const orgId = getOauthAccountInfo()?.organizationUuid

  if (!orgId) {
    return null // 未登录或无组织信息，直接返回
  }

  // 将 Promise 赋给模块级变量，供并发调用者复用
  fetchInProgress = (async () => {
    try {
      const response = await fetchReferralEligibility()

      // 构造缓存条目（在响应数据基础上追加时间戳）
      const cacheEntry = {
        ...response,
        timestamp: Date.now(),
      }

      // 持久化到全局配置（仅更新当前组织的缓存条目）
      saveGlobalConfig(current => ({
        ...current,
        passesEligibilityCache: {
          ...current.passesEligibilityCache,
          [orgId]: cacheEntry,
        },
      }))

      logForDebugging(
        `Passes eligibility cached for org ${orgId}: ${response.eligible}`,
      )

      return response
    } catch (error) {
      logForDebugging('Failed to fetch and cache passes eligibility')
      logError(error as Error)
      return null
    } finally {
      // 无论成功/失败，清空 in-flight 标志，允许下次重新发起
      fetchInProgress = null
    }
  })()

  return fetchInProgress
}

/**
 * 获取 Guest Pass 资格数据（主入口，缓存优先）。
 *
 * 完全非阻塞策略：
 *  - 无缓存 → 触发后台拉取，本次返回 null（本会话内 /passes 命令不可用）
 *  - 缓存过期 → 返回旧值，同时后台刷新（stale-while-revalidate）
 *  - 缓存新鲜 → 直接返回缓存值
 *
 * 冷启动（首次无缓存）：本会话内 /passes 不可用，下次启动时可用。
 *
 * @returns 资格响应或 null（前置条件不满足/无缓存时）
 */
export async function getCachedOrFetchPassesEligibility(): Promise<ReferralEligibilityResponse | null> {
  // 前置条件不满足（非 max 订阅、无组织信息等）
  if (!shouldCheckForPasses()) {
    return null
  }

  const orgId = getOauthAccountInfo()?.organizationUuid
  if (!orgId) {
    return null
  }

  const config = getGlobalConfig()
  const cachedEntry = config.passesEligibilityCache?.[orgId]
  const now = Date.now()

  // 无缓存：触发后台拉取，本次返回 null（非阻塞）
  // 本会话内 /passes 命令不可用，下次启动时将有缓存
  if (!cachedEntry) {
    logForDebugging(
      'Passes: No cache, fetching eligibility in background (command unavailable this session)',
    )
    void fetchAndStorePassesEligibility() // fire-and-forget
    return null
  }

  // 缓存过期：返回旧值，同时后台刷新（stale-while-revalidate 模式）
  if (now - cachedEntry.timestamp > CACHE_EXPIRATION_MS) {
    logForDebugging(
      'Passes: Cache stale, returning cached data and refreshing in background',
    )
    void fetchAndStorePassesEligibility() // 后台异步刷新
    const { timestamp, ...response } = cachedEntry
    return response as ReferralEligibilityResponse
  }

  // 缓存新鲜：直接返回
  logForDebugging('Passes: Using fresh cached eligibility data')
  const { timestamp, ...response } = cachedEntry
  return response as ReferralEligibilityResponse
}

/**
 * 在应用启动时预取 Guest Pass 资格（非阻塞）。
 *
 * 目的：为下一次打开 /passes 命令预热缓存，避免首次使用时等待。
 * 若处于仅基础流量模式（essential-traffic-only）则跳过。
 */
export async function prefetchPassesEligibility(): Promise<void> {
  // 仅基础流量模式下不发起非必要 API 请求
  if (isEssentialTrafficOnly()) {
    return
  }

  // 非阻塞地触发资格检查（缓存新鲜时立即返回，不发请求）
  void getCachedOrFetchPassesEligibility()
}
