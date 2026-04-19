/**
 * 认证子命令处理器 — 实现 `claude auth login/status/logout` 命令。
 *
 * 在整个 Claude Code 系统中的位置：
 * 本文件是 CLI 层的认证入口，位于用户命令与底层 OAuth 服务之间。
 * 它处理三条主要流程：
 *   1. login  — 通过浏览器 OAuth 流程或环境变量中的 refresh token 快速登录
 *   2. status — 检查并展示当前认证状态，已登录退出码 0，未登录退出码 1
 *   3. logout — 清除本地认证凭据并退出
 *
 * 本文件依赖底层 OAuth 客户端（client.js）、全局配置（config.js）、
 * 认证工具函数（auth.js）等，是 CLI 与认证基础设施之间的薄适配层。
 */
/* eslint-disable custom-rules/no-process-exit -- CLI subcommand handler intentionally exits */

import {
  clearAuthRelatedCaches,
  performLogout,
} from '../../commands/logout/logout.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js'
import { getSSLErrorHint } from '../../services/api/errorUtils.js'
import { fetchAndStoreClaudeCodeFirstTokenDate } from '../../services/api/firstTokenDate.js'
import {
  createAndStoreApiKey,
  fetchAndStoreUserRoles,
  refreshOAuthToken,
  shouldUseClaudeAIAuth,
  storeOAuthAccountInfo,
} from '../../services/oauth/client.js'
import { getOauthProfileFromOauthToken } from '../../services/oauth/getOauthProfile.js'
import { OAuthService } from '../../services/oauth/index.js'
import type { OAuthTokens } from '../../services/oauth/types.js'
import {
  clearOAuthTokenCache,
  getAnthropicApiKeyWithSource,
  getAuthTokenSource,
  getOauthAccountInfo,
  getSubscriptionType,
  isUsing3PServices,
  saveOAuthTokensIfNeeded,
  validateForceLoginOrg,
} from '../../utils/auth.js'
import { saveGlobalConfig } from '../../utils/config.js'
import { logForDebugging } from '../../utils/debug.js'
import { isRunningOnHomespace } from '../../utils/envUtils.js'
import { errorMessage } from '../../utils/errors.js'
import { logError } from '../../utils/log.js'
import { getAPIProvider } from '../../utils/model/providers.js'
import { getInitialSettings } from '../../utils/settings/settings.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import {
  buildAccountProperties,
  buildAPIProviderProperties,
} from '../../utils/status.js'

/**
 * OAuth 令牌获取后的共享后处理逻辑。
 *
 * 流程：
 * 1. 先执行 performLogout 清除旧凭据（保留 onboarding 状态）。
 * 2. 获取用户 profile（优先复用 tokens 中已预取的数据，否则重新请求）。
 * 3. 将账号信息（uuid、email、org 等）存储到本地。
 * 4. 保存 OAuth tokens 并清除 token 缓存。
 * 5. 异步获取用户角色和首次 token 日期（失败仅记录日志，不中断流程）。
 * 6. 根据 token scopes 决定走 claude.ai 路径（fetchAndStoreClaudeCodeFirstTokenDate）
 *    还是 Console 路径（createAndStoreApiKey，失败则抛出异常）。
 * 7. 清除认证相关缓存。
 */
export async function installOAuthTokens(tokens: OAuthTokens): Promise<void> {
  // 清除旧状态，为新凭据腾出空间；保留 onboarding 完成标记
  await performLogout({ clearOnboarding: false })

  // 优先复用 tokens 中已预取的 profile，否则用 access token 重新获取
  const profile =
    tokens.profile ?? (await getOauthProfileFromOauthToken(tokens.accessToken))
  if (profile) {
    // 将完整的账号和组织信息持久化到本地存储
    storeOAuthAccountInfo({
      accountUuid: profile.account.uuid,
      emailAddress: profile.account.email,
      organizationUuid: profile.organization.uuid,
      displayName: profile.account.display_name || undefined,
      hasExtraUsageEnabled:
        profile.organization.has_extra_usage_enabled ?? undefined,
      billingType: profile.organization.billing_type ?? undefined,
      subscriptionCreatedAt:
        profile.organization.subscription_created_at ?? undefined,
      accountCreatedAt: profile.account.created_at,
    })
  } else if (tokens.tokenAccount) {
    // profile 端点失败时的降级方案：使用 token 交换时返回的账号数据
    storeOAuthAccountInfo({
      accountUuid: tokens.tokenAccount.uuid,
      emailAddress: tokens.tokenAccount.emailAddress,
      organizationUuid: tokens.tokenAccount.organizationUuid,
    })
  }

  // 持久化 OAuth tokens（如有必要），并清除内存中的 token 缓存
  const storageResult = saveOAuthTokensIfNeeded(tokens)
  clearOAuthTokenCache()

  // 若存储过程有告警，上报到分析系统以便追踪
  if (storageResult.warning) {
    logEvent('tengu_oauth_storage_warning', {
      warning:
        storageResult.warning as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
  }

  // 异步获取用户角色和首次 token 日期；受限 scope token 可能失败，不影响主流程
  await fetchAndStoreUserRoles(tokens.accessToken).catch(err =>
    logForDebugging(String(err), { level: 'error' }),
  )

  if (shouldUseClaudeAIAuth(tokens.scopes)) {
    // claude.ai 路径：获取并存储首次 token 日期（非关键，失败仅记录）
    await fetchAndStoreClaudeCodeFirstTokenDate().catch(err =>
      logForDebugging(String(err), { level: 'error' }),
    )
  } else {
    // Console 路径：API key 创建是关键步骤，失败直接抛出异常
    const apiKey = await createAndStoreApiKey(tokens.accessToken)
    if (!apiKey) {
      throw new Error(
        'Unable to create API key. The server accepted the request but did not return a key.',
      )
    }
  }

  // 清除所有与认证相关的内存缓存，确保后续请求使用新凭据
  await clearAuthRelatedCaches()
}

/**
 * `claude auth login` 命令处理函数。
 *
 * 流程：
 * 1. 校验 --console 与 --claudeai 不能同时使用。
 * 2. 读取 settings 中的 forceLoginMethod 企业约束，确定登录目标（claude.ai 或 Console）。
 * 3. 快速路径：若环境变量 CLAUDE_CODE_OAUTH_REFRESH_TOKEN 存在，
 *    直接用其换取 tokens，跳过浏览器 OAuth 流程。
 * 4. 标准路径：启动 OAuthService 发起浏览器 OAuth 流程，等待回调。
 * 5. 两条路径均在成功后调用 installOAuthTokens 完成后续设置，
 *    验证组织约束（forceLoginOrgUUID），标记 onboarding 完成，然后退出 0。
 * 6. 任何错误均写入 stderr 并退出 1。
 */
export async function authLogin({
  email,
  sso,
  console: useConsole,
  claudeai,
}: {
  email?: string
  sso?: boolean
  console?: boolean
  claudeai?: boolean
}): Promise<void> {
  // --console 和 --claudeai 互斥，同时使用时报错退出
  if (useConsole && claudeai) {
    process.stderr.write(
      'Error: --console and --claudeai cannot be used together.\n',
    )
    process.exit(1)
  }

  const settings = getInitialSettings()
  // forceLoginMethod 是企业级硬约束，优先级最高；
  // 无约束时 --console 选 Console，--claudeai 或无 flag 选 claude.ai
  const loginWithClaudeAi = settings.forceLoginMethod
    ? settings.forceLoginMethod === 'claudeai'
    : !useConsole
  const orgUUID = settings.forceLoginOrgUUID

  // 快速路径：环境变量中提供了 refresh token，直接交换，跳过浏览器弹窗
  const envRefreshToken = process.env.CLAUDE_CODE_OAUTH_REFRESH_TOKEN
  if (envRefreshToken) {
    const envScopes = process.env.CLAUDE_CODE_OAUTH_SCOPES
    if (!envScopes) {
      // SCOPES 是必填项，缺失时给出详细说明后退出
      process.stderr.write(
        'CLAUDE_CODE_OAUTH_SCOPES is required when using CLAUDE_CODE_OAUTH_REFRESH_TOKEN.\n' +
          'Set it to the space-separated scopes the refresh token was issued with\n' +
          '(e.g. "user:inference" or "user:profile user:inference user:sessions:claude_code user:mcp_servers").\n',
      )
      process.exit(1)
    }

    // 将空白符分隔的 scopes 字符串解析为数组
    const scopes = envScopes.split(/\s+/).filter(Boolean)

    try {
      logEvent('tengu_login_from_refresh_token', {})

      // 用 refresh token 换取新的 access token + refresh token
      const tokens = await refreshOAuthToken(envRefreshToken, { scopes })
      await installOAuthTokens(tokens)

      // 验证当前账号是否满足 forceLoginOrgUUID 约束
      const orgResult = await validateForceLoginOrg()
      if (!orgResult.valid) {
        process.stderr.write(orgResult.message + '\n')
        process.exit(1)
      }

      // env var 路径跳过了 Onboarding 组件，手动标记 onboarding 完成
      saveGlobalConfig(current => {
        if (current.hasCompletedOnboarding) return current
        return { ...current, hasCompletedOnboarding: true }
      })

      logEvent('tengu_oauth_success', {
        loginWithClaudeAi: shouldUseClaudeAIAuth(tokens.scopes),
      })
      process.stdout.write('Login successful.\n')
      process.exit(0)
    } catch (err) {
      // 记录错误详情并向用户展示，附加 SSL 提示（如适用）
      logError(err)
      const sslHint = getSSLErrorHint(err)
      process.stderr.write(
        `Login failed: ${errorMessage(err)}\n${sslHint ? sslHint + '\n' : ''}`,
      )
      process.exit(1)
    }
  }

  // 标准路径：SSO 登录方式仅当传入 --sso 时生效
  const resolvedLoginMethod = sso ? 'sso' : undefined

  const oauthService = new OAuthService()

  try {
    logEvent('tengu_oauth_flow_start', { loginWithClaudeAi })

    // 启动 OAuth 流程，回调中打开浏览器并打印备用 URL
    const result = await oauthService.startOAuthFlow(
      async url => {
        process.stdout.write('Opening browser to sign in…\n')
        process.stdout.write(`If the browser didn't open, visit: ${url}\n`)
      },
      {
        loginWithClaudeAi,
        loginHint: email,     // 预填邮箱（可选）
        loginMethod: resolvedLoginMethod,
        orgUUID,              // 组织约束（可选）
      },
    )

    // OAuth 成功后完成 token 安装和账号设置
    await installOAuthTokens(result)

    // 再次验证组织约束
    const orgResult = await validateForceLoginOrg()
    if (!orgResult.valid) {
      process.stderr.write(orgResult.message + '\n')
      process.exit(1)
    }

    logEvent('tengu_oauth_success', { loginWithClaudeAi })

    process.stdout.write('Login successful.\n')
    process.exit(0)
  } catch (err) {
    logError(err)
    const sslHint = getSSLErrorHint(err)
    process.stderr.write(
      `Login failed: ${errorMessage(err)}\n${sslHint ? sslHint + '\n' : ''}`,
    )
    process.exit(1)
  } finally {
    // 无论成功或失败，都清理 OAuthService 占用的资源（如本地监听端口）
    oauthService.cleanup()
  }
}

/**
 * `claude auth status` 命令处理函数。
 *
 * 流程：
 * 1. 收集当前认证状态：token 来源、API key 来源、OAuth 账号信息、订阅类型等。
 * 2. 判断是否已登录（有 token、API key 或第三方服务均视为已登录）。
 * 3. 根据 opts 选择输出格式：
 *    - opts.text：逐行打印人类可读属性，跳过值为 null/none 的项。
 *    - 默认（JSON）：输出结构化 JSON，包含 loggedIn、authMethod、email 等字段。
 * 4. 已登录退出码 0，未登录退出码 1（供脚本判断）。
 */
export async function authStatus(opts: {
  json?: boolean
  text?: boolean
}): Promise<void> {
  // 收集各维度的认证来源信息
  const { source: authTokenSource, hasToken } = getAuthTokenSource()
  const { source: apiKeySource } = getAnthropicApiKeyWithSource()
  // Homespace 环境中不计入 ANTHROPIC_API_KEY（避免误判）
  const hasApiKeyEnvVar =
    !!process.env.ANTHROPIC_API_KEY && !isRunningOnHomespace()
  const oauthAccount = getOauthAccountInfo()
  const subscriptionType = getSubscriptionType()
  const using3P = isUsing3PServices()
  // 满足任一条件即视为已登录
  const loggedIn =
    hasToken || apiKeySource !== 'none' || hasApiKeyEnvVar || using3P

  // 从多种来源中推断当前使用的认证方式
  let authMethod: string = 'none'
  if (using3P) {
    authMethod = 'third_party'
  } else if (authTokenSource === 'claude.ai') {
    authMethod = 'claude.ai'
  } else if (authTokenSource === 'apiKeyHelper') {
    authMethod = 'api_key_helper'
  } else if (authTokenSource !== 'none') {
    authMethod = 'oauth_token'
  } else if (apiKeySource === 'ANTHROPIC_API_KEY' || hasApiKeyEnvVar) {
    authMethod = 'api_key'
  } else if (apiKeySource === '/login managed key') {
    authMethod = 'claude.ai'
  }

  if (opts.text) {
    // 文本输出模式：遍历账号和 API 提供商属性，逐行打印非空值
    const properties = [
      ...buildAccountProperties(),
      ...buildAPIProviderProperties(),
    ]
    let hasAuthProperty = false
    for (const prop of properties) {
      // 将属性值统一转为字符串或数组字符串，null/none 跳过
      const value =
        typeof prop.value === 'string'
          ? prop.value
          : Array.isArray(prop.value)
            ? prop.value.join(', ')
            : null
      if (value === null || value === 'none') {
        continue
      }
      hasAuthProperty = true
      // 有标签则输出 "标签: 值"，否则直接输出值
      if (prop.label) {
        process.stdout.write(`${prop.label}: ${value}\n`)
      } else {
        process.stdout.write(`${value}\n`)
      }
    }
    // 仅凭环境变量 API key 登录时，补充打印 API key 来源行
    if (!hasAuthProperty && hasApiKeyEnvVar) {
      process.stdout.write('API key: ANTHROPIC_API_KEY\n')
    }
    // 未登录时给出引导提示
    if (!loggedIn) {
      process.stdout.write(
        'Not logged in. Run claude auth login to authenticate.\n',
      )
    }
  } else {
    // JSON 输出模式（默认）：构造结构化对象后序列化输出
    const apiProvider = getAPIProvider()
    const resolvedApiKeySource =
      apiKeySource !== 'none'
        ? apiKeySource
        : hasApiKeyEnvVar
          ? 'ANTHROPIC_API_KEY'
          : null
    const output: Record<string, string | boolean | null> = {
      loggedIn,
      authMethod,
      apiProvider,
    }
    // 仅在有 API key 来源时才包含该字段
    if (resolvedApiKeySource) {
      output.apiKeySource = resolvedApiKeySource
    }
    // claude.ai 认证方式下附加账号详情
    if (authMethod === 'claude.ai') {
      output.email = oauthAccount?.emailAddress ?? null
      output.orgId = oauthAccount?.organizationUuid ?? null
      output.orgName = oauthAccount?.organizationName ?? null
      output.subscriptionType = subscriptionType ?? null
    }

    // 格式化输出 JSON（2 空格缩进，便于阅读）
    process.stdout.write(jsonStringify(output, null, 2) + '\n')
  }
  // 已登录退出 0（供 shell 脚本的条件判断使用），未登录退出 1
  process.exit(loggedIn ? 0 : 1)
}

/**
 * `claude auth logout` 命令处理函数。
 *
 * 流程：
 * 1. 调用 performLogout 清除本地认证凭据（保留 onboarding 状态）。
 * 2. 成功则打印成功消息并退出 0；失败则写入 stderr 并退出 1。
 */
export async function authLogout(): Promise<void> {
  try {
    // 执行登出，保留 onboarding 完成标记避免重复引导
    await performLogout({ clearOnboarding: false })
  } catch {
    // 登出失败（如文件系统错误）时报错退出
    process.stderr.write('Failed to log out.\n')
    process.exit(1)
  }
  process.stdout.write('Successfully logged out from your Anthropic account.\n')
  process.exit(0)
}
