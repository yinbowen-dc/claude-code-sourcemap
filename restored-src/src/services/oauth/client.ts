/**
 * OAuth 客户端核心模块
 *
 * 在 Claude Code 系统流程中的位置：
 * 本文件是 OAuth 2.0 PKCE 授权码流程的核心业务逻辑层，承担从构建授权 URL
 * 到令牌交换、刷新、用户信息获取的全链路责任。它位于以下中间层：
 *   - 上层：OAuthService（index.ts）编排整体流程，调用本模块各函数
 *   - 下层：axios HTTP 客户端、getOauthProfile.ts（具体 API 调用）
 *   - 配置层：constants/oauth.js（URL 常量、CLIENT_ID 等）
 *   - 存储层：utils/auth.js（令牌持久化）、utils/config.js（全局配置读写）
 *
 * 主要功能：
 * - shouldUseClaudeAIAuth：判断是否使用 Claude AI 授权（scope 中含 CLAUDE_AI_INFERENCE_SCOPE）
 * - parseScopes：将空格分隔的 scope 字符串拆分为数组
 * - buildAuthUrl：构建带 PKCE 参数的 OAuth 授权 URL
 * - exchangeCodeForTokens：用授权码换取访问令牌（15s 超时）
 * - refreshOAuthToken：刷新令牌，含跳过 profile 请求的优化（节省约 700 万次/天请求）
 * - fetchAndStoreUserRoles：获取并存储用户组织角色信息
 * - createAndStoreApiKey：创建并存储 API 密钥
 * - isOAuthTokenExpired：令牌过期检测（含 5 分钟缓冲）
 * - fetchProfileInfo：获取订阅类型和速率限制等级
 * - getOrganizationUUID：获取组织 UUID（配置缓存优先）
 * - populateOAuthAccountInfoIfNeeded：按需填充账户信息（支持环境变量回退）
 * - storeOAuthAccountInfo：去重写入 OAuth 账户信息到全局配置
 */

// OAuth client for handling authentication flows with Claude services
import axios from 'axios'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js'
import {
  ALL_OAUTH_SCOPES,
  CLAUDE_AI_INFERENCE_SCOPE,
  CLAUDE_AI_OAUTH_SCOPES,
  getOauthConfig,
} from '../../constants/oauth.js'
import {
  checkAndRefreshOAuthTokenIfNeeded,
  getClaudeAIOAuthTokens,
  hasProfileScope,
  isClaudeAISubscriber,
  saveApiKey,
} from '../../utils/auth.js'
import type { AccountInfo } from '../../utils/config.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import { logForDebugging } from '../../utils/debug.js'
import { getOauthProfileFromOauthToken } from './getOauthProfile.js'
import type {
  BillingType,
  OAuthProfileResponse,
  OAuthTokenExchangeResponse,
  OAuthTokens,
  RateLimitTier,
  SubscriptionType,
  UserRolesResponse,
} from './types.js'

/**
 * 判断是否应使用 Claude AI 授权模式
 *
 * 通过检查授权范围数组中是否包含 CLAUDE_AI_INFERENCE_SCOPE 来决定
 * 使用 Claude AI 授权端点还是开发者控制台授权端点。
 * @private 仅供 OAuth / 授权相关代码调用！
 *
 * @param scopes 当前授权范围列表
 * @returns true 表示应使用 Claude AI 授权路径
 */
export function shouldUseClaudeAIAuth(scopes: string[] | undefined): boolean {
  // 检查 scopes 数组是否包含 Claude AI 推理专用 scope
  return Boolean(scopes?.includes(CLAUDE_AI_INFERENCE_SCOPE))
}

/**
 * 解析空格分隔的 scope 字符串
 *
 * OAuth 标准以空格分隔多个 scope，此函数将其拆分为数组并过滤空字符串。
 *
 * @param scopeString 空格分隔的 scope 字符串（如 "openid profile email"）
 * @returns scope 字符串数组；输入为 undefined 时返回空数组
 */
export function parseScopes(scopeString?: string): string[] {
  // split(' ') 按空格拆分，filter(Boolean) 过滤空字符串
  return scopeString?.split(' ').filter(Boolean) ?? []
}

/**
 * 构建 OAuth 授权 URL
 *
 * 根据参数组合生成完整的 OAuth 2.0 授权端点 URL，包含：
 * - PKCE 参数（code_challenge、code_challenge_method）
 * - 重定向地址（自动模式：localhost:port/callback；手动模式：固定 MANUAL_REDIRECT_URL）
 * - 授权范围（推理专用 token 仅含 inference scope；其他含全量 scopes）
 * - 可选参数（orgUUID 预选组织、login_hint 预填邮箱、login_method 指定登录方式）
 * - code=true：告知登录页面展示 Claude Max 升级弹窗
 *
 * @param params 构建 URL 所需的各项参数
 * @returns 完整的授权 URL 字符串
 */
export function buildAuthUrl({
  codeChallenge,
  state,
  port,
  isManual,
  loginWithClaudeAi,
  inferenceOnly,
  orgUUID,
  loginHint,
  loginMethod,
}: {
  codeChallenge: string
  state: string
  port: number
  isManual: boolean
  loginWithClaudeAi?: boolean
  inferenceOnly?: boolean
  orgUUID?: string
  loginHint?: string
  loginMethod?: string
}): string {
  // 根据是否使用 Claude AI 认证选择对应的授权基础 URL
  const authUrlBase = loginWithClaudeAi
    ? getOauthConfig().CLAUDE_AI_AUTHORIZE_URL
    : getOauthConfig().CONSOLE_AUTHORIZE_URL

  const authUrl = new URL(authUrlBase)
  authUrl.searchParams.append('code', 'true') // this tells the login page to show Claude Max upsell
  authUrl.searchParams.append('client_id', getOauthConfig().CLIENT_ID)
  authUrl.searchParams.append('response_type', 'code')
  // 手动模式使用固定重定向 URL，自动模式使用本地 localhost callback 地址
  authUrl.searchParams.append(
    'redirect_uri',
    isManual
      ? getOauthConfig().MANUAL_REDIRECT_URL
      : `http://localhost:${port}/callback`,
  )
  // inferenceOnly 模式：仅申请推理 scope（生成长期有效令牌）；否则申请全量 scopes
  const scopesToUse = inferenceOnly
    ? [CLAUDE_AI_INFERENCE_SCOPE] // Long-lived inference-only tokens
    : ALL_OAUTH_SCOPES
  authUrl.searchParams.append('scope', scopesToUse.join(' '))
  authUrl.searchParams.append('code_challenge', codeChallenge)
  authUrl.searchParams.append('code_challenge_method', 'S256')
  authUrl.searchParams.append('state', state)

  // Add orgUUID as URL param if provided
  // 若指定了组织 UUID，则将其作为查询参数附加（用于多组织账户预选）
  if (orgUUID) {
    authUrl.searchParams.append('orgUUID', orgUUID)
  }

  // Pre-populate email on the login form (standard OIDC parameter)
  // 标准 OIDC login_hint 参数，预填用户邮箱，改善多账户登录体验
  if (loginHint) {
    authUrl.searchParams.append('login_hint', loginHint)
  }

  // Request a specific login method (e.g. 'sso', 'magic_link', 'google')
  // 指定登录方式（如 SSO、魔法链接、Google），跳过登录方式选择步骤
  if (loginMethod) {
    authUrl.searchParams.append('login_method', loginMethod)
  }

  return authUrl.toString()
}

/**
 * 用授权码换取访问令牌
 *
 * 完整流程：
 * 1. 构建令牌请求体（含 grant_type、code、redirect_uri、client_id、code_verifier、state）
 * 2. 可选地传入 expiresIn 控制令牌有效期
 * 3. POST 到 TOKEN_URL，超时 15s
 * 4. 验证响应状态：401 返回认证失败，其他非 200 返回状态码错误
 * 5. 记录 tengu_oauth_token_exchange_success 分析事件
 *
 * @param authorizationCode 从回调 URL 获取的授权码
 * @param state CSRF 校验用 state 参数
 * @param codeVerifier 原始 code_verifier（PKCE 核心）
 * @param port 本地回调服务器端口
 * @param useManualRedirect 是否使用手动重定向模式（默认 false）
 * @param expiresIn 可选的令牌有效期秒数
 * @returns 令牌交换响应（含 access_token、refresh_token、expires_in、scope）
 */
export async function exchangeCodeForTokens(
  authorizationCode: string,
  state: string,
  codeVerifier: string,
  port: number,
  useManualRedirect: boolean = false,
  expiresIn?: number,
): Promise<OAuthTokenExchangeResponse> {
  // 构建令牌请求体：标准 OAuth 2.0 授权码换令牌参数
  const requestBody: Record<string, string | number> = {
    grant_type: 'authorization_code',
    code: authorizationCode,
    // 手动模式使用固定 URL，自动模式使用本地 localhost callback 地址
    redirect_uri: useManualRedirect
      ? getOauthConfig().MANUAL_REDIRECT_URL
      : `http://localhost:${port}/callback`,
    client_id: getOauthConfig().CLIENT_ID,
    code_verifier: codeVerifier,
    state,
  }

  // 若调用方指定了 expiresIn，追加到请求体（控制令牌有效期）
  if (expiresIn !== undefined) {
    requestBody.expires_in = expiresIn
  }

  // 发送 POST 请求，超时 15s（防止网络挂起阻塞 OAuth 流程）
  const response = await axios.post(getOauthConfig().TOKEN_URL, requestBody, {
    headers: { 'Content-Type': 'application/json' },
    timeout: 15000,
  })

  if (response.status !== 200) {
    throw new Error(
      response.status === 401
        ? 'Authentication failed: Invalid authorization code'
        : `Token exchange failed (${response.status}): ${response.statusText}`,
    )
  }
  // 记录令牌交换成功事件
  logEvent('tengu_oauth_token_exchange_success', {})
  return response.data
}

/**
 * 刷新 OAuth 访问令牌
 *
 * 完整流程：
 * 1. 构建 refresh_token 请求体，scope 默认使用 CLAUDE_AI_OAUTH_SCOPES（允许扩展）
 * 2. POST 到 TOKEN_URL 获取新令牌
 * 3. 关键优化：若全局配置中已有 billingType/accountCreatedAt/subscriptionCreatedAt
 *    且安全存储中已有 subscriptionType/rateLimitTier，则跳过 /api/oauth/profile 调用
 *    （节省约 700 万次/天的 fleet-wide 请求）
 * 4. 若需要获取 profile，则调用 fetchProfileInfo 并将变更部分更新到全局配置
 * 5. 返回完整的 OAuthTokens（subscriptionType/rateLimitTier 优先使用 profile 值，其次沿用现有值）
 *
 * 安全说明：pass-through existing values 用于 CLAUDE_CODE_OAUTH_REFRESH_TOKEN 重登录路径，
 * 防止 performLogout() 清空安全存储后 subscriptionType 永久丢失。
 *
 * @param refreshToken 当前有效的刷新令牌
 * @param options 可选请求 scopes 列表
 * @returns 更新后的 OAuthTokens 对象
 */
export async function refreshOAuthToken(
  refreshToken: string,
  { scopes: requestedScopes }: { scopes?: string[] } = {},
): Promise<OAuthTokens> {
  // 构建 refresh_token 请求体；scope 使用调用方指定值或默认全量 Claude AI scopes
  const requestBody = {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: getOauthConfig().CLIENT_ID,
    // Request specific scopes, defaulting to the full Claude AI set. The
    // backend's refresh-token grant allows scope expansion beyond what the
    // initial authorize granted (see ALLOWED_SCOPE_EXPANSIONS), so this is
    // safe even for tokens issued before scopes were added to the app's
    // registered oauth_scope.
    scope: (requestedScopes?.length
      ? requestedScopes
      : CLAUDE_AI_OAUTH_SCOPES
    ).join(' '),
  }

  try {
    // 发送令牌刷新请求，超时 15s
    const response = await axios.post(getOauthConfig().TOKEN_URL, requestBody, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 15000,
    })

    if (response.status !== 200) {
      throw new Error(`Token refresh failed: ${response.statusText}`)
    }

    const data = response.data as OAuthTokenExchangeResponse
    const {
      access_token: accessToken,
      // 若服务器未返回新的 refresh_token，则沿用现有值（RFC 6749 允许）
      refresh_token: newRefreshToken = refreshToken,
      expires_in: expiresIn,
    } = data

    // 将相对有效期（秒）转为绝对过期时间戳（毫秒）
    const expiresAt = Date.now() + expiresIn * 1000
    const scopes = parseScopes(data.scope)

    logEvent('tengu_oauth_token_refresh_success', {})

    // Skip the extra /api/oauth/profile round-trip when we already have both
    // the global-config profile fields AND the secure-storage subscription data.
    // Routine refreshes satisfy both, so we cut ~7M req/day fleet-wide.
    //
    // Checking secure storage (not just config) matters for the
    // CLAUDE_CODE_OAUTH_REFRESH_TOKEN re-login path: installOAuthTokens runs
    // performLogout() AFTER we return, wiping secure storage. If we returned
    // null for subscriptionType here, saveOAuthTokensIfNeeded would persist
    // null ?? (wiped) ?? null = null, and every future refresh would see the
    // config guard fields satisfied and skip again, permanently losing the
    // subscription type for paying users. By passing through existing values,
    // the re-login path writes cached ?? wiped ?? null = cached; and if secure
    // storage was already empty we fall through to the fetch.
    const config = getGlobalConfig()
    // 读取安全存储中的现有令牌（用于 pass-through 优化）
    const existing = getClaudeAIOAuthTokens()
    // 关键优化检查：全局配置 + 安全存储同时满足条件时，跳过 profile API 调用
    const haveProfileAlready =
      config.oauthAccount?.billingType !== undefined &&
      config.oauthAccount?.accountCreatedAt !== undefined &&
      config.oauthAccount?.subscriptionCreatedAt !== undefined &&
      existing?.subscriptionType != null &&
      existing?.rateLimitTier != null

    // 若已有完整 profile 数据则跳过 API 调用，否则发起 profile 请求
    const profileInfo = haveProfileAlready
      ? null
      : await fetchProfileInfo(accessToken)

    // Update the stored properties if they have changed
    // 若获取到新 profile 且账户信息存在，则有选择地更新变更字段
    if (profileInfo && config.oauthAccount) {
      const updates: Partial<AccountInfo> = {}
      if (profileInfo.displayName !== undefined) {
        updates.displayName = profileInfo.displayName
      }
      if (typeof profileInfo.hasExtraUsageEnabled === 'boolean') {
        updates.hasExtraUsageEnabled = profileInfo.hasExtraUsageEnabled
      }
      if (profileInfo.billingType !== null) {
        updates.billingType = profileInfo.billingType
      }
      if (profileInfo.accountCreatedAt !== undefined) {
        updates.accountCreatedAt = profileInfo.accountCreatedAt
      }
      if (profileInfo.subscriptionCreatedAt !== undefined) {
        updates.subscriptionCreatedAt = profileInfo.subscriptionCreatedAt
      }
      // 仅在有变更时才写入全局配置，避免无谓的磁盘 IO
      if (Object.keys(updates).length > 0) {
        saveGlobalConfig(current => ({
          ...current,
          oauthAccount: current.oauthAccount
            ? { ...current.oauthAccount, ...updates }
            : current.oauthAccount,
        }))
      }
    }

    return {
      accessToken,
      refreshToken: newRefreshToken,
      expiresAt,
      scopes,
      // 优先使用新 profile 值，其次沿用安全存储现有值，最后 null
      subscriptionType:
        profileInfo?.subscriptionType ?? existing?.subscriptionType ?? null,
      rateLimitTier:
        profileInfo?.rateLimitTier ?? existing?.rateLimitTier ?? null,
      profile: profileInfo?.rawProfile,
      // 若令牌响应含账户信息，则构建 tokenAccount 对象
      tokenAccount: data.account
        ? {
            uuid: data.account.uuid,
            emailAddress: data.account.email_address,
            organizationUuid: data.organization?.uuid,
          }
        : undefined,
    }
  } catch (error) {
    // 提取 Axios 响应体用于诊断（非 Axios 错误则 responseBody 为 undefined）
    const responseBody =
      axios.isAxiosError(error) && error.response?.data
        ? JSON.stringify(error.response.data)
        : undefined
    logEvent('tengu_oauth_token_refresh_failure', {
      error: (error as Error)
        .message as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      ...(responseBody && {
        responseBody:
          responseBody as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      }),
    })
    throw error
  }
}

/**
 * 获取并存储用户组织角色信息
 *
 * 向 ROLES_URL 发送 GET 请求（Bearer 认证），获取用户的组织角色、
 * 工作空间角色和组织名称，然后写入全局配置。
 * 记录 tengu_oauth_roles_stored 事件，含组织角色信息。
 *
 * @param accessToken 有效的 OAuth 访问令牌
 */
export async function fetchAndStoreUserRoles(
  accessToken: string,
): Promise<void> {
  // 以 Bearer Token 认证方式请求用户角色接口
  const response = await axios.get(getOauthConfig().ROLES_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })

  if (response.status !== 200) {
    throw new Error(`Failed to fetch user roles: ${response.statusText}`)
  }
  const data = response.data as UserRolesResponse
  const config = getGlobalConfig()

  // 确保全局配置中已有 OAuth 账户信息（应在调用前已登录）
  if (!config.oauthAccount) {
    throw new Error('OAuth account information not found in config')
  }

  // 将组织角色、工作空间角色、组织名称合并到现有账户配置中
  saveGlobalConfig(current => ({
    ...current,
    oauthAccount: current.oauthAccount
      ? {
          ...current.oauthAccount,
          organizationRole: data.organization_role,
          workspaceRole: data.workspace_role,
          organizationName: data.organization_name,
        }
      : current.oauthAccount,
  }))

  logEvent('tengu_oauth_roles_stored', {
    org_role:
      data.organization_role as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  })
}

/**
 * 创建并存储 API 密钥
 *
 * 向 API_KEY_URL 发送 POST 请求（Bearer 认证），服务器将为当前用户生成
 * 一个新的 API 密钥。成功后调用 saveApiKey 持久化密钥，记录成功/失败分析事件。
 *
 * @param accessToken 有效的 OAuth 访问令牌
 * @returns 创建的 API 密钥字符串，若无 raw_key 字段则返回 null
 */
export async function createAndStoreApiKey(
  accessToken: string,
): Promise<string | null> {
  try {
    // POST 请求创建 API 密钥，请求体为 null（无需额外参数）
    const response = await axios.post(getOauthConfig().API_KEY_URL, null, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })

    // 从响应中提取 raw_key（API 密钥原始值）
    const apiKey = response.data?.raw_key
    if (apiKey) {
      // 将 API 密钥持久化到安全存储
      await saveApiKey(apiKey)
      logEvent('tengu_oauth_api_key', {
        status:
          'success' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        statusCode: response.status,
      })
      return apiKey
    }
    return null
  } catch (error) {
    logEvent('tengu_oauth_api_key', {
      status:
        'failure' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      error: (error instanceof Error
        ? error.message
        : String(
            error,
          )) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    throw error
  }
}

/**
 * 检查 OAuth 访问令牌是否已过期（含 5 分钟缓冲）
 *
 * 使用 5 分钟缓冲时间提前判断令牌过期，避免在令牌即将到期时发出的
 * API 请求因令牌刚好到期而失败。
 * expiresAt 为 null 时（如 API Key 认证），视为永不过期返回 false。
 *
 * @param expiresAt 令牌过期时间戳（毫秒），null 表示无过期时间
 * @returns true 表示令牌已过期或即将在 5 分钟内过期
 */
export function isOAuthTokenExpired(expiresAt: number | null): boolean {
  // null 表示无过期时间（如 API Key），视为有效
  if (expiresAt === null) {
    return false
  }

  // 5 分钟缓冲：提前判断过期，为令牌刷新留出时间
  const bufferTime = 5 * 60 * 1000
  const now = Date.now()
  // 若当前时间 + 缓冲 >= 过期时间，则认为需要刷新
  const expiresWithBuffer = now + bufferTime
  return expiresWithBuffer >= expiresAt
}

/**
 * 从访问令牌获取并解析用户 profile 信息
 *
 * 完整流程：
 * 1. 调用 getOauthProfileFromOauthToken 获取原始 profile 响应
 * 2. 将 organization_type 映射为 SubscriptionType 枚举值
 *    （claude_max→'max', claude_pro→'pro', claude_enterprise→'enterprise', claude_team→'team'）
 * 3. 提取 rate_limit_tier、has_extra_usage_enabled、billing_type、display_name 等字段
 * 4. 记录 tengu_oauth_profile_fetch_success 事件
 * 5. 返回包含 rawProfile 的完整对象（供调用方缓存或记录）
 *
 * @param accessToken 有效的 OAuth 访问令牌
 * @returns 结构化的 profile 信息对象
 */
export async function fetchProfileInfo(accessToken: string): Promise<{
  subscriptionType: SubscriptionType | null
  displayName?: string
  rateLimitTier: RateLimitTier | null
  hasExtraUsageEnabled: boolean | null
  billingType: BillingType | null
  accountCreatedAt?: string
  subscriptionCreatedAt?: string
  rawProfile?: OAuthProfileResponse
}> {
  // 调用底层 profile 获取函数（Bearer Token 认证）
  const profile = await getOauthProfileFromOauthToken(accessToken)
  const orgType = profile?.organization?.organization_type

  // Reuse the logic from fetchSubscriptionType
  // 将组织类型字符串映射为内部 SubscriptionType 枚举值
  let subscriptionType: SubscriptionType | null = null
  switch (orgType) {
    case 'claude_max':
      subscriptionType = 'max'
      break
    case 'claude_pro':
      subscriptionType = 'pro'
      break
    case 'claude_enterprise':
      subscriptionType = 'enterprise'
      break
    case 'claude_team':
      subscriptionType = 'team'
      break
    default:
      // Return null for unknown organization types
      subscriptionType = null
      break
  }

  // 构建基础结果对象，提取关键 profile 字段
  const result: {
    subscriptionType: SubscriptionType | null
    displayName?: string
    rateLimitTier: RateLimitTier | null
    hasExtraUsageEnabled: boolean | null
    billingType: BillingType | null
    accountCreatedAt?: string
    subscriptionCreatedAt?: string
  } = {
    subscriptionType,
    // 速率限制等级（影响 API 调用频率上限）
    rateLimitTier: profile?.organization?.rate_limit_tier ?? null,
    // 是否开启了额外使用量（Extra Usage）功能
    hasExtraUsageEnabled:
      profile?.organization?.has_extra_usage_enabled ?? null,
    // 计费类型（如 'credits'、'subscription' 等）
    billingType: profile?.organization?.billing_type ?? null,
  }

  // 可选字段：仅在存在时才赋值（避免覆盖已有值为 undefined）
  if (profile?.account?.display_name) {
    result.displayName = profile.account.display_name
  }

  if (profile?.account?.created_at) {
    result.accountCreatedAt = profile.account.created_at
  }

  if (profile?.organization?.subscription_created_at) {
    result.subscriptionCreatedAt = profile.organization.subscription_created_at
  }

  logEvent('tengu_oauth_profile_fetch_success', {})

  // 返回结构化结果，同时附带原始 profile 响应供上层缓存
  return { ...result, rawProfile: profile }
}

/**
 * Gets the organization UUID from the OAuth access token
 * @returns The organization UUID or null if not authenticated
 *
 * 获取当前用户的组织 UUID
 *
 * 采用两级查找策略：
 * 1. 优先从全局配置缓存中读取（避免 API 调用）
 * 2. 缓存未命中时，调用 getOauthProfileFromOauthToken 从 profile API 获取
 *    （要求用户已登录且令牌含 user:profile scope）
 *
 * @returns 组织 UUID 字符串，未登录或无组织时返回 null
 */
export async function getOrganizationUUID(): Promise<string | null> {
  // Check global config first to avoid unnecessary API call
  // 第一级：从全局配置缓存中读取（同步，无网络开销）
  const globalConfig = getGlobalConfig()
  const orgUUID = globalConfig.oauthAccount?.organizationUuid
  if (orgUUID) {
    return orgUUID
  }

  // Fall back to fetching from profile (requires user:profile scope)
  // 第二级：从 profile API 获取（需要有效令牌且含 profile scope）
  const accessToken = getClaudeAIOAuthTokens()?.accessToken
  if (accessToken === undefined || !hasProfileScope()) {
    return null
  }
  const profile = await getOauthProfileFromOauthToken(accessToken)
  const profileOrgUUID = profile?.organization?.uuid
  if (!profileOrgUUID) {
    return null
  }
  return profileOrgUUID
}

/**
 * Populate the OAuth account info if it has not already been cached in config.
 * @returns Whether or not the oauth account info was populated.
 *
 * 按需填充 OAuth 账户信息
 *
 * 完整流程：
 * 1. 优先检查环境变量（CLAUDE_CODE_ACCOUNT_UUID/USER_EMAIL/ORGANIZATION_UUID）
 *    - 专为 SDK 调用方（如 Cowork）设计，无网络调用，避免早期遥测事件缺失账户信息
 *    - 若三个环境变量均存在且配置中无账户信息，则直接存储
 * 2. 等待可能正在进行的令牌刷新完成（refreshOAuthToken 已内含 profile 获取）
 * 3. 若配置中已有完整 profile 数据（billingType/accountCreatedAt/subscriptionCreatedAt），
 *    或用户非 Claude AI 订阅者，或无 profile scope，则直接返回 false
 * 4. 否则获取访问令牌并调用 getOauthProfileFromOauthToken 获取完整 profile
 * 5. profile 获取成功后调用 storeOAuthAccountInfo 写入配置
 *
 * @returns true 表示账户信息被成功填充，false 表示已存在或不需要填充
 */
export async function populateOAuthAccountInfoIfNeeded(): Promise<boolean> {
  // Check env vars first (synchronous, no network call needed).
  // SDK callers like Cowork can provide account info directly, which also
  // eliminates the race condition where early telemetry events lack account info.
  // NB: If/when adding additional SDK-relevant functionality requiring _other_ OAuth account properties,
  // please reach out to #proj-cowork so the team can add additional env var fallbacks.
  // 读取三个可选的 SDK 环境变量
  const envAccountUuid = process.env.CLAUDE_CODE_ACCOUNT_UUID
  const envUserEmail = process.env.CLAUDE_CODE_USER_EMAIL
  const envOrganizationUuid = process.env.CLAUDE_CODE_ORGANIZATION_UUID
  const hasEnvVars = Boolean(
    envAccountUuid && envUserEmail && envOrganizationUuid,
  )
  // 若三个环境变量均存在且配置中无账户信息，则直接写入（无网络调用）
  if (envAccountUuid && envUserEmail && envOrganizationUuid) {
    if (!getGlobalConfig().oauthAccount) {
      storeOAuthAccountInfo({
        accountUuid: envAccountUuid,
        emailAddress: envUserEmail,
        organizationUuid: envOrganizationUuid,
      })
    }
  }

  // Wait for any in-flight token refresh to complete first, since
  // refreshOAuthToken already fetches and stores profile info
  // 等待可能进行中的令牌刷新（避免与 refreshOAuthToken 的 profile 获取竞争）
  await checkAndRefreshOAuthTokenIfNeeded()

  const config = getGlobalConfig()
  // 检查是否已有完整 profile（三个关键字段均存在），或不满足前提条件
  if (
    (config.oauthAccount &&
      config.oauthAccount.billingType !== undefined &&
      config.oauthAccount.accountCreatedAt !== undefined &&
      config.oauthAccount.subscriptionCreatedAt !== undefined) ||
    !isClaudeAISubscriber() ||
    !hasProfileScope()
  ) {
    return false
  }

  // 获取当前访问令牌并请求完整 profile 数据
  const tokens = getClaudeAIOAuthTokens()
  if (tokens?.accessToken) {
    const profile = await getOauthProfileFromOauthToken(tokens.accessToken)
    if (profile) {
      // 若有环境变量提供了账户信息，记录 profile 覆盖行为
      if (hasEnvVars) {
        logForDebugging(
          'OAuth profile fetch succeeded, overriding env var account info',
          { level: 'info' },
        )
      }
      // 将完整 profile 信息写入全局配置
      storeOAuthAccountInfo({
        accountUuid: profile.account.uuid,
        emailAddress: profile.account.email,
        organizationUuid: profile.organization.uuid,
        displayName: profile.account.display_name || undefined,
        hasExtraUsageEnabled:
          profile.organization.has_extra_usage_enabled ?? false,
        billingType: profile.organization.billing_type ?? undefined,
        accountCreatedAt: profile.account.created_at,
        subscriptionCreatedAt:
          profile.organization.subscription_created_at ?? undefined,
      })
      return true
    }
  }
  return false
}

/**
 * 将 OAuth 账户信息存储到全局配置
 *
 * 执行字段级别的去重检查：若所有关键字段（accountUuid、emailAddress、
 * organizationUuid、displayName、hasExtraUsageEnabled、billingType、
 * accountCreatedAt、subscriptionCreatedAt）均未发生变化，则直接返回
 * 现有配置，避免不必要的磁盘写入。
 *
 * @param params 账户信息字段集合
 */
export function storeOAuthAccountInfo({
  accountUuid,
  emailAddress,
  organizationUuid,
  displayName,
  hasExtraUsageEnabled,
  billingType,
  accountCreatedAt,
  subscriptionCreatedAt,
}: {
  accountUuid: string
  emailAddress: string
  organizationUuid: string | undefined
  displayName?: string
  hasExtraUsageEnabled?: boolean
  billingType?: BillingType
  accountCreatedAt?: string
  subscriptionCreatedAt?: string
}): void {
  // 构建 AccountInfo 对象，基础字段必填，可选字段按需赋值
  const accountInfo: AccountInfo = {
    accountUuid,
    emailAddress,
    organizationUuid,
    hasExtraUsageEnabled,
    billingType,
    accountCreatedAt,
    subscriptionCreatedAt,
  }
  // 仅在 displayName 有值时才设置（避免覆盖已有值为 undefined）
  if (displayName) {
    accountInfo.displayName = displayName
  }
  saveGlobalConfig(current => {
    // For oauthAccount we need to compare content since it's an object
    // 对象内容级别的去重：所有字段均未变化时返回原配置（不触发写入）
    if (
      current.oauthAccount?.accountUuid === accountInfo.accountUuid &&
      current.oauthAccount?.emailAddress === accountInfo.emailAddress &&
      current.oauthAccount?.organizationUuid === accountInfo.organizationUuid &&
      current.oauthAccount?.displayName === accountInfo.displayName &&
      current.oauthAccount?.hasExtraUsageEnabled ===
        accountInfo.hasExtraUsageEnabled &&
      current.oauthAccount?.billingType === accountInfo.billingType &&
      current.oauthAccount?.accountCreatedAt === accountInfo.accountCreatedAt &&
      current.oauthAccount?.subscriptionCreatedAt ===
        accountInfo.subscriptionCreatedAt
    ) {
      return current
    }
    // 有变更时才更新 oauthAccount 字段
    return { ...current, oauthAccount: accountInfo }
  })
}
