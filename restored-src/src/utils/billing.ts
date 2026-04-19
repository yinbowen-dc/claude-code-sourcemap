/**
 * 计费访问权限判断模块。
 *
 * 在 Claude Code 系统中，该模块负责判断当前用户是否具备计费管理访问权限：
 * - hasConsoleBillingAccess()：判断 API key 用户是否有 console 计费访问权限
 *   （基于 OAuth 账户的 organizationRole / workspaceRole）
 * - hasClaudeAiBillingAccess()：判断 claude.ai 订阅用户是否有计费访问权限
 *   （Max/Pro 个人用户始终有权；Team/Enterprise 需有 admin/billing/owner 角色）
 * - setMockBillingAccessOverride()：测试用途，覆盖 hasClaudeAiBillingAccess 返回值
 */
import {
  getAnthropicApiKey,
  getAuthTokenSource,
  getSubscriptionType,
  isClaudeAISubscriber,
} from './auth.js'
import { getGlobalConfig } from './config.js'
import { isEnvTruthy } from './envUtils.js'

/**
 * 判断当前 API key 用户是否具有 console 计费访问权限。
 * 订阅用户、未认证用户、未设置角色（未重新授权的老用户）均无访问权限；
 * org 或 workspace 层级的 admin / billing 角色有权访问。
 */
export function hasConsoleBillingAccess(): boolean {
  // Check if cost reporting is disabled via environment variable
  if (isEnvTruthy(process.env.DISABLE_COST_WARNINGS)) {
    return false
  }

  const isSubscriber = isClaudeAISubscriber()

  // This might be wrong if user is signed into Max but also using an API key, but
  // we already show a warning on launch in that case
  if (isSubscriber) return false

  // Check if user has any form of authentication
  const authSource = getAuthTokenSource()
  const hasApiKey = getAnthropicApiKey() !== null

  // If user has no authentication at all (logged out), don't show costs
  if (!authSource.hasToken && !hasApiKey) {
    return false
  }

  const config = getGlobalConfig()
  const orgRole = config.oauthAccount?.organizationRole
  const workspaceRole = config.oauthAccount?.workspaceRole

  if (!orgRole || !workspaceRole) {
    return false // hide cost for grandfathered users who have not re-authed since we've added roles
  }

  // Users have billing access if they are admins or billing roles at either workspace or organization level
  return (
    ['admin', 'billing'].includes(orgRole) ||
    ['workspace_admin', 'workspace_billing'].includes(workspaceRole)
  )
}

// Mock billing access for /mock-limits testing (set by mockRateLimits.ts)
let mockBillingAccessOverride: boolean | null = null

/** 覆盖 hasClaudeAiBillingAccess 的返回值（仅用于 /mock-limits 测试，传 null 恢复正常逻辑）。 */
export function setMockBillingAccessOverride(value: boolean | null): void {
  mockBillingAccessOverride = value
}

/**
 * 判断 claude.ai 订阅用户是否具有计费访问权限。
 * Max / Pro 个人订阅用户始终有权；Team / Enterprise 用户需具备
 * admin / billing / owner / primary_owner 角色之一。
 */
export function hasClaudeAiBillingAccess(): boolean {
  // Check for mock billing access first (for /mock-limits testing)
  if (mockBillingAccessOverride !== null) {
    return mockBillingAccessOverride
  }

  if (!isClaudeAISubscriber()) {
    return false
  }

  const subscriptionType = getSubscriptionType()

  // Consumer plans (Max/Pro) - individual users always have billing access
  if (subscriptionType === 'max' || subscriptionType === 'pro') {
    return true
  }

  // Team/Enterprise - check for admin or billing roles
  const config = getGlobalConfig()
  const orgRole = config.oauthAccount?.organizationRole

  return (
    !!orgRole &&
    ['admin', 'billing', 'owner', 'primary_owner'].includes(orgRole)
  )
}
