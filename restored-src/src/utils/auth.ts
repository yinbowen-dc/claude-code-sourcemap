/**
 * 主认证模块（Claude Code 认证核心）。
 *
 * 在 Claude Code 系统中，该模块统一管理以下认证逻辑：
 * - Anthropic 1P OAuth 认证（claude.ai 订阅者 / API 客户）
 * - API key 获取：环境变量 / apiKeyHelper 外部命令 / macOS Keychain / 全局配置
 * - AWS Bedrock 认证刷新（awsAuthRefresh / awsCredentialExport）
 * - GCP Vertex 认证刷新（gcpAuthRefresh）
 * - OAuth token 刷新（含跨进程分布式锁防重刷）
 * - otelHeadersHelper：为 OpenTelemetry 提供动态请求头
 * - 订阅类型判断：Max / Pro / Enterprise / Team / API
 * - 组织强制登录校验（forceLoginOrgUUID）
 */
import chalk from 'chalk'
import { exec } from 'child_process'
import { execa } from 'execa'
import { mkdir, stat } from 'fs/promises'
import memoize from 'lodash-es/memoize.js'
import { join } from 'path'
import { CLAUDE_AI_PROFILE_SCOPE } from 'src/constants/oauth.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js'
import { getModelStrings } from 'src/utils/model/modelStrings.js'
import { getAPIProvider } from 'src/utils/model/providers.js'
import {
  getIsNonInteractiveSession,
  preferThirdPartyAuthentication,
} from '../bootstrap/state.js'
import {
  getMockSubscriptionType,
  shouldUseMockSubscription,
} from '../services/mockRateLimits.js'
import {
  isOAuthTokenExpired,
  refreshOAuthToken,
  shouldUseClaudeAIAuth,
} from '../services/oauth/client.js'
import { getOauthProfileFromOauthToken } from '../services/oauth/getOauthProfile.js'
import type { OAuthTokens, SubscriptionType } from '../services/oauth/types.js'
import {
  getApiKeyFromFileDescriptor,
  getOAuthTokenFromFileDescriptor,
} from './authFileDescriptor.js'
import {
  maybeRemoveApiKeyFromMacOSKeychainThrows,
  normalizeApiKeyForConfig,
} from './authPortable.js'
import {
  checkStsCallerIdentity,
  clearAwsIniCache,
  isValidAwsStsOutput,
} from './aws.js'
import { AwsAuthStatusManager } from './awsAuthStatusManager.js'
import { clearBetasCaches } from './betas.js'
import {
  type AccountInfo,
  checkHasTrustDialogAccepted,
  getGlobalConfig,
  saveGlobalConfig,
} from './config.js'
import { logAntError, logForDebugging } from './debug.js'
import {
  getClaudeConfigHomeDir,
  isBareMode,
  isEnvTruthy,
  isRunningOnHomespace,
} from './envUtils.js'
import { errorMessage } from './errors.js'
import { execSyncWithDefaults_DEPRECATED } from './execFileNoThrow.js'
import * as lockfile from './lockfile.js'
import { logError } from './log.js'
import { memoizeWithTTLAsync } from './memoize.js'
import { getSecureStorage } from './secureStorage/index.js'
import {
  clearLegacyApiKeyPrefetch,
  getLegacyApiKeyPrefetchResult,
} from './secureStorage/keychainPrefetch.js'
import {
  clearKeychainCache,
  getMacOsKeychainStorageServiceName,
  getUsername,
} from './secureStorage/macOsKeychainHelpers.js'
import {
  getSettings_DEPRECATED,
  getSettingsForSource,
} from './settings/settings.js'
import { sleep } from './sleep.js'
import { jsonParse } from './slowOperations.js'
import { clearToolSchemaCache } from './toolSchemaCache.js'

/** API key helper 缓存的默认 TTL（毫秒），固定为 5 分钟 */
const DEFAULT_API_KEY_HELPER_TTL = 5 * 60 * 1000

/**
 * 判断当前是否为受管理的 OAuth 上下文（CCR 远程或 Claude Desktop 入口）。
 * 受管理上下文中禁止回退到用户终端的 API key 配置，防止错误组织的密钥被使用。
 */
function isManagedOAuthContext(): boolean {
  return (
    isEnvTruthy(process.env.CLAUDE_CODE_REMOTE) ||
    process.env.CLAUDE_CODE_ENTRYPOINT === 'claude-desktop'
  )
}

/** 判断是否启用 Anthropic 1P 认证（在 --bare、3P 服务、外部 API key 情况下禁用）。 */
// 以下代码与 getAuthTokenSource 紧密相关
export function isAnthropicAuthEnabled(): boolean {
  // --bare 模式：纯 API key 认证，永不使用 OAuth
  if (isBareMode()) return false

  // `claude ssh` 远程模式：ANTHROPIC_UNIX_SOCKET 将 API 调用隧道经由本地注入 auth 的代理。
  // 启动器在本地订阅者侧设置 CLAUDE_CODE_OAUTH_TOKEN 占位符（让远端发送 oauth-2025 beta 请求头
  // 以匹配代理注入的内容）。远程的 ~/.claude 配置（apiKeyHelper、ANTHROPIC_API_KEY）绝对
  // 不能覆盖这一行为——否则会导致请求头与代理不匹配，API 返回 "invalid x-api-key"。
  // 详见 src/ssh/sshAuthProxy.ts。
  if (process.env.ANTHROPIC_UNIX_SOCKET) {
    return !!process.env.CLAUDE_CODE_OAUTH_TOKEN
  }

  // 检测是否使用第三方 AI 服务（Bedrock / Vertex / Foundry）
  const is3P =
    isEnvTruthy(process.env.CLAUDE_CODE_USE_BEDROCK) ||
    isEnvTruthy(process.env.CLAUDE_CODE_USE_VERTEX) ||
    isEnvTruthy(process.env.CLAUDE_CODE_USE_FOUNDRY)

  // 检测用户是否配置了外部 API key 来源（允许外部提供的 key 工作，无需代理配置）
  const settings = getSettings_DEPRECATED() || {}
  const apiKeyHelper = settings.apiKeyHelper
  const hasExternalAuthToken =
    process.env.ANTHROPIC_AUTH_TOKEN ||
    apiKeyHelper ||
    process.env.CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR

  // 检测 API key 是否来自外部来源（不由 /login 管理）
  const { source: apiKeySource } = getAnthropicApiKeyWithSource({
    skipRetrievingKeyFromApiKeyHelper: true,
  })
  const hasExternalApiKey =
    apiKeySource === 'ANTHROPIC_API_KEY' || apiKeySource === 'apiKeyHelper'

  // 以下情况禁用 Anthropic auth：
  // 1. 使用第三方服务（Bedrock/Vertex/Foundry）
  // 2. 用户有外部 API key（无论代理配置如何）
  // 3. 用户有外部 auth token（无论代理配置如何）
  // 注意：在受管理 OAuth 上下文中，外部 key/token 不会禁用 1P auth（避免头部冲突）
  const shouldDisableAuth =
    is3P ||
    (hasExternalAuthToken && !isManagedOAuthContext()) ||
    (hasExternalApiKey && !isManagedOAuthContext())

  return !shouldDisableAuth
}

/** 返回当前认证 token 的来源（如 ANTHROPIC_AUTH_TOKEN / claude.ai / apiKeyHelper 等）。 */
// 以下代码与 isAnthropicAuthEnabled 紧密相关
export function getAuthTokenSource() {
  // --bare 模式：只允许 apiKeyHelper（来自 --settings）作为 bearer token 来源
  // OAuth 环境变量、FD token、Keychain 均被忽略
  if (isBareMode()) {
    if (getConfiguredApiKeyHelper()) {
      return { source: 'apiKeyHelper' as const, hasToken: true }
    }
    return { source: 'none' as const, hasToken: false }
  }

  // 受管理 OAuth 上下文（CCR 远程/Claude Desktop）不读取 ANTHROPIC_AUTH_TOKEN，
  // 避免用户侧配置与代理注入的 token 产生冲突
  if (process.env.ANTHROPIC_AUTH_TOKEN && !isManagedOAuthContext()) {
    return { source: 'ANTHROPIC_AUTH_TOKEN' as const, hasToken: true }
  }

  // CLAUDE_CODE_OAUTH_TOKEN 是进程间传递的 OAuth token（如 CCR 启动器注入）
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    return { source: 'CLAUDE_CODE_OAUTH_TOKEN' as const, hasToken: true }
  }

  // 从文件描述符读取 OAuth token（或 CCR 磁盘回退路径）。
  // getOAuthTokenFromFileDescriptor 对无法继承管道 FD 的 CCR 子进程有磁盘回退。
  // 通过 env var 是否存在来区分来源，避免向用户提示取消一个不存在的变量。
  const oauthTokenFromFd = getOAuthTokenFromFileDescriptor()
  if (oauthTokenFromFd) {
    if (process.env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR) {
      return {
        source: 'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR' as const,
        hasToken: true,
      }
    }
    return {
      source: 'CCR_OAUTH_TOKEN_FILE' as const,
      hasToken: true,
    }
  }

  // 仅检查 apiKeyHelper 是否已配置，但不执行命令——
  // 防止在工作区信任建立之前任意代码被执行（安全保障）
  const apiKeyHelper = getConfiguredApiKeyHelper()
  if (apiKeyHelper && !isManagedOAuthContext()) {
    return { source: 'apiKeyHelper' as const, hasToken: true }
  }

  // 最后检查 claude.ai OAuth token（订阅者登录态）
  const oauthTokens = getClaudeAIOAuthTokens()
  if (shouldUseClaudeAIAuth(oauthTokens?.scopes) && oauthTokens?.accessToken) {
    return { source: 'claude.ai' as const, hasToken: true }
  }

  return { source: 'none' as const, hasToken: false }
}

export type ApiKeySource =
  | 'ANTHROPIC_API_KEY'
  | 'apiKeyHelper'
  | '/login managed key'
  | 'none'

/**
 * 返回 Anthropic API key（不含来源信息）。
 */
export function getAnthropicApiKey(): null | string {
  const { key } = getAnthropicApiKeyWithSource()
  return key
}

export function hasAnthropicApiKeyAuth(): boolean {
  const { key, source } = getAnthropicApiKeyWithSource({
    skipRetrievingKeyFromApiKeyHelper: true,
  })
  return key !== null && source !== 'none'
}

/**
 * 返回 Anthropic API key 及其来源（环境变量 / apiKeyHelper / Keychain / 配置文件 / none）。
 * --bare 模式仅读取 ANTHROPIC_API_KEY 和 flagSettings 中的 apiKeyHelper。
 */
export function getAnthropicApiKeyWithSource(
  opts: { skipRetrievingKeyFromApiKeyHelper?: boolean } = {},
): {
  key: null | string
  source: ApiKeySource
} {
  // --bare 模式：密封式认证。只读取 ANTHROPIC_API_KEY 环境变量或 --settings 中的 apiKeyHelper。
  // 永远不访问 Keychain、配置文件或审批列表。3P（Bedrock/Vertex/Foundry）使用提供商凭据，不走此路径。
  if (isBareMode()) {
    if (process.env.ANTHROPIC_API_KEY) {
      return { key: process.env.ANTHROPIC_API_KEY, source: 'ANTHROPIC_API_KEY' }
    }
    if (getConfiguredApiKeyHelper()) {
      return {
        key: opts.skipRetrievingKeyFromApiKeyHelper
          ? null
          : getApiKeyFromApiKeyHelperCached(),
        source: 'apiKeyHelper',
      }
    }
    return { key: null, source: 'none' }
  }

  // homespace 环境下不使用 ANTHROPIC_API_KEY（改用 Console key）
  // 参见 https://anthropic.slack.com/archives/C08428WSLKV/p1747331773214779
  const apiKeyEnv = isRunningOnHomespace()
    ? undefined
    : process.env.ANTHROPIC_API_KEY

  // --print 模式（CI 等非交互场景）：优先使用 ANTHROPIC_API_KEY 环境变量
  if (preferThirdPartyAuthentication() && apiKeyEnv) {
    return {
      key: apiKeyEnv,
      source: 'ANTHROPIC_API_KEY',
    }
  }

  // CI / 测试环境：API key 或 OAuth token 必须通过环境变量或 FD 提供
  if (isEnvTruthy(process.env.CI) || process.env.NODE_ENV === 'test') {
    // 优先从文件描述符读取 API key（CI 注入方式）
    const apiKeyFromFd = getApiKeyFromFileDescriptor()
    if (apiKeyFromFd) {
      return {
        key: apiKeyFromFd,
        source: 'ANTHROPIC_API_KEY',
      }
    }

    // CI 环境必须提供 API key 或 OAuth token 之一，否则抛出错误
    if (
      !apiKeyEnv &&
      !process.env.CLAUDE_CODE_OAUTH_TOKEN &&
      !process.env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR
    ) {
      throw new Error(
        'ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN env var is required',
      )
    }

    if (apiKeyEnv) {
      return {
        key: apiKeyEnv,
        source: 'ANTHROPIC_API_KEY',
      }
    }

    // 有 OAuth token 但本函数只返回 API key，OAuth 路径返回 null
    return {
      key: null,
      source: 'none',
    }
  }
  // 在 apiKeyHelper 和 /login 管理的 key 之前，先检查 ANTHROPIC_API_KEY（需用户已批准）
  if (
    apiKeyEnv &&
    getGlobalConfig().customApiKeyResponses?.approved?.includes(
      normalizeApiKeyForConfig(apiKeyEnv),
    )
  ) {
    return {
      key: apiKeyEnv,
      source: 'ANTHROPIC_API_KEY',
    }
  }

  // 从文件描述符读取 API key（适用于通过 FD 注入 key 的场景，如子进程）
  const apiKeyFromFd = getApiKeyFromFileDescriptor()
  if (apiKeyFromFd) {
    return {
      key: apiKeyFromFd,
      source: 'ANTHROPIC_API_KEY',
    }
  }

  // 检查 apiKeyHelper——使用同步缓存，绝不阻塞主线程
  const apiKeyHelperCommand = getConfiguredApiKeyHelper()
  if (apiKeyHelperCommand) {
    if (opts.skipRetrievingKeyFromApiKeyHelper) {
      return {
        key: null,
        source: 'apiKeyHelper',
      }
    }
    // 缓存可能为冷（helper 尚未完成）。返回 null + source='apiKeyHelper'，
    // 而非回退到 keychain——apiKeyHelper 必须具有更高优先级。
    // 需要真实 key 的调用方必须先 await getApiKeyFromApiKeyHelper()（client.ts 中已处理）。
    return {
      key: getApiKeyFromApiKeyHelperCached(),
      source: 'apiKeyHelper',
    }
  }

  // 最后从 macOS Keychain 或全局配置文件读取（/login 管理的 key）
  const apiKeyFromConfigOrMacOSKeychain = getApiKeyFromConfigOrMacOSKeychain()
  if (apiKeyFromConfigOrMacOSKeychain) {
    return apiKeyFromConfigOrMacOSKeychain
  }

  return {
    key: null,
    source: 'none',
  }
}

/**
 * 从 settings 读取配置的 apiKeyHelper 命令。
 * --bare 模式仅读取 flagSettings 中的 apiKeyHelper，忽略项目级和用户级配置。
 */
export function getConfiguredApiKeyHelper(): string | undefined {
  if (isBareMode()) {
    return getSettingsForSource('flagSettings')?.apiKeyHelper
  }
  const mergedSettings = getSettings_DEPRECATED() || {}
  return mergedSettings.apiKeyHelper
}

/**
 * 判断 apiKeyHelper 是否来源于项目级或本地设置（用于信任检查）。
 */
function isApiKeyHelperFromProjectOrLocalSettings(): boolean {
  const apiKeyHelper = getConfiguredApiKeyHelper()
  if (!apiKeyHelper) {
    return false
  }

  const projectSettings = getSettingsForSource('projectSettings')
  const localSettings = getSettingsForSource('localSettings')
  return (
    projectSettings?.apiKeyHelper === apiKeyHelper ||
    localSettings?.apiKeyHelper === apiKeyHelper
  )
}

/** 从 settings 读取配置的 awsAuthRefresh 命令。 */
function getConfiguredAwsAuthRefresh(): string | undefined {
  const mergedSettings = getSettings_DEPRECATED() || {}
  return mergedSettings.awsAuthRefresh
}

/** 判断 awsAuthRefresh 是否来源于项目级或本地设置（用于信任检查）。 */
export function isAwsAuthRefreshFromProjectSettings(): boolean {
  const awsAuthRefresh = getConfiguredAwsAuthRefresh()
  if (!awsAuthRefresh) {
    return false
  }

  const projectSettings = getSettingsForSource('projectSettings')
  const localSettings = getSettingsForSource('localSettings')
  return (
    projectSettings?.awsAuthRefresh === awsAuthRefresh ||
    localSettings?.awsAuthRefresh === awsAuthRefresh
  )
}

/** 从 settings 读取配置的 awsCredentialExport 命令。 */
function getConfiguredAwsCredentialExport(): string | undefined {
  const mergedSettings = getSettings_DEPRECATED() || {}
  return mergedSettings.awsCredentialExport
}

/** 判断 awsCredentialExport 是否来源于项目级或本地设置（用于信任检查）。 */
export function isAwsCredentialExportFromProjectSettings(): boolean {
  const awsCredentialExport = getConfiguredAwsCredentialExport()
  if (!awsCredentialExport) {
    return false
  }

  const projectSettings = getSettingsForSource('projectSettings')
  const localSettings = getSettingsForSource('localSettings')
  return (
    projectSettings?.awsCredentialExport === awsCredentialExport ||
    localSettings?.awsCredentialExport === awsCredentialExport
  )
}

/**
 * 计算 apiKeyHelper 缓存的 TTL（毫秒）。
 * 优先读取 CLAUDE_CODE_API_KEY_HELPER_TTL_MS 环境变量，默认 5 分钟。
 */
export function calculateApiKeyHelperTTL(): number {
  const envTtl = process.env.CLAUDE_CODE_API_KEY_HELPER_TTL_MS

  if (envTtl) {
    const parsed = parseInt(envTtl, 10)
    // 合法值：非 NaN 且非负整数
    if (!Number.isNaN(parsed) && parsed >= 0) {
      return parsed
    }
    logForDebugging(
      `Found CLAUDE_CODE_API_KEY_HELPER_TTL_MS env var, but it was not a valid number. Got ${envTtl}`,
      { level: 'error' },
    )
  }

  return DEFAULT_API_KEY_HELPER_TTL
}

// 异步 apiKeyHelper 实现，带同步缓存供非阻塞读取。
// epoch 在 clearApiKeyHelperCache() 时递增——在途执行完成时先比较 epoch，
// 防止 settings 变更或 401 重试过程中新 epoch 的缓存/inflight 被旧 epoch 覆盖。
let _apiKeyHelperCache: { value: string; timestamp: number } | null = null
let _apiKeyHelperInflight: {
  promise: Promise<string | null>
  // 冷启动时设置（用户正在等待）；SWR 后台刷新时为 null
  startedAt: number | null
} | null = null
let _apiKeyHelperEpoch = 0

/**
 * 返回当前 apiKeyHelper 执行已等待的毫秒数（用于超时提示）。
 */
export function getApiKeyHelperElapsedMs(): number {
  const startedAt = _apiKeyHelperInflight?.startedAt
  return startedAt ? Date.now() - startedAt : 0
}

/**
 * 异步获取 apiKeyHelper 产生的 API key，带 SWR（stale-while-revalidate）缓存语义。
 * 缓存未过期：直接返回缓存值；缓存过期：后台刷新，本次仍返回旧值；
 * 缓存为空（冷启动）：等待首次执行完成。
 */
export async function getApiKeyFromApiKeyHelper(
  isNonInteractiveSession: boolean,
): Promise<string | null> {
  if (!getConfiguredApiKeyHelper()) return null
  const ttl = calculateApiKeyHelperTTL()
  if (_apiKeyHelperCache) {
    if (Date.now() - _apiKeyHelperCache.timestamp < ttl) {
      // 缓存未过期，直接返回缓存值
      return _apiKeyHelperCache.value
    }
    // 缓存过期——返回旧值，在后台刷新
    // 注意：`??=` 被 eslint no-nullish-assign-object-call 禁止（bun bug），改用 if 写法
    if (!_apiKeyHelperInflight) {
      _apiKeyHelperInflight = {
        promise: _runAndCache(
          isNonInteractiveSession,
          false,
          _apiKeyHelperEpoch,
        ),
        startedAt: null,
      }
    }
    return _apiKeyHelperCache.value
  }
  // 冷缓存——去重并发调用，所有调用共享同一 promise
  if (_apiKeyHelperInflight) return _apiKeyHelperInflight.promise
  _apiKeyHelperInflight = {
    promise: _runAndCache(isNonInteractiveSession, true, _apiKeyHelperEpoch),
    startedAt: Date.now(), // 记录启动时间，用于超时告警
  }
  return _apiKeyHelperInflight.promise
}

/**
 * 执行 apiKeyHelper 并更新缓存，处理 SWR 语义下的成功和失败情况。
 * isCold=true 表示冷缓存路径（用户等待中）；isCold=false 表示后台 SWR 刷新。
 */
async function _runAndCache(
  isNonInteractiveSession: boolean,
  isCold: boolean,
  epoch: number,
): Promise<string | null> {
  try {
    const value = await _executeApiKeyHelper(isNonInteractiveSession)
    // 如果 epoch 已变（缓存被清除），放弃写入——避免旧 in-flight 覆盖新状态
    if (epoch !== _apiKeyHelperEpoch) return value
    if (value !== null) {
      _apiKeyHelperCache = { value, timestamp: Date.now() }
    }
    return value
  } catch (e) {
    // epoch 已变，直接返回占位符（丢弃结果）
    if (epoch !== _apiKeyHelperEpoch) return ' '
    const detail = e instanceof Error ? e.message : String(e)
    // biome-ignore lint/suspicious/noConsole: user-configured script failed; must be visible without --debug
    console.error(chalk.red(`apiKeyHelper failed: ${detail}`))
    logForDebugging(`Error getting API key from apiKeyHelper: ${detail}`, {
      level: 'error',
    })
    // SWR 路径：瞬时故障不应用 ' ' 哨兵覆盖正常工作的 key——
    // 沿用旧值，并刷新 timestamp，避免每次调用都重试
    if (!isCold && _apiKeyHelperCache && _apiKeyHelperCache.value !== ' ') {
      _apiKeyHelperCache = { ..._apiKeyHelperCache, timestamp: Date.now() }
      return _apiKeyHelperCache.value
    }
    // 冷缓存或之前已出错——缓存 ' ' 哨兵，防止回退到 OAuth
    _apiKeyHelperCache = { value: ' ', timestamp: Date.now() }
    return ' '
  } finally {
    // 只有当前 epoch 匹配时才清除 inflight，防止新 epoch 的 inflight 被误清
    if (epoch === _apiKeyHelperEpoch) {
      _apiKeyHelperInflight = null
    }
  }
}

/**
 * 实际执行 apiKeyHelper 命令，返回 stdout（修剪后）或 null（未配置时）。
 * 若命令超时、退出非 0、或无输出，则抛出错误供 _runAndCache 处理。
 * 项目级设置来源的 helper 需工作区信任建立后才允许执行（安全保障）。
 */
async function _executeApiKeyHelper(
  isNonInteractiveSession: boolean,
): Promise<string | null> {
  const apiKeyHelper = getConfiguredApiKeyHelper()
  if (!apiKeyHelper) {
    return null
  }

  // 若 apiKeyHelper 来自项目设置，在执行前必须确认工作区信任已建立
  if (isApiKeyHelperFromProjectOrLocalSettings()) {
    const hasTrust = checkHasTrustDialogAccepted()
    if (!hasTrust && !isNonInteractiveSession) {
      const error = new Error(
        `Security: apiKeyHelper executed before workspace trust is confirmed. If you see this message, post in ${MACRO.FEEDBACK_CHANNEL}.`,
      )
      logAntError('apiKeyHelper invoked before trust check', error)
      logEvent('tengu_apiKeyHelper_missing_trust11', {})
      return null
    }
  }

  // 以 shell 模式执行 helper，超时 10 分钟（允许交互式 SSO 流程）
  // reject:false 使 execa 在非 0 退出时 resolve 而非 reject，方便统一处理错误
  const result = await execa(apiKeyHelper, {
    shell: true,
    timeout: 10 * 60 * 1000,
    reject: false,
  })
  if (result.failed) {
    // reject:false——execa 在 exit≠0 或超时时 resolve，错误详情在 result 中
    const why = result.timedOut ? 'timed out' : `exited ${result.exitCode}`
    const stderr = result.stderr?.trim()
    throw new Error(stderr ? `${why}: ${stderr}` : why)
  }
  const stdout = result.stdout?.trim()
  if (!stdout) {
    throw new Error('did not return a value')
  }
  return stdout
}

/**
 * 同步读取 apiKeyHelper 缓存值（不执行命令）。
 * 遵循 SWR 语义：缓存过期时返回旧值，仅在 async fetch 尚未完成时返回 null。
 */
export function getApiKeyFromApiKeyHelperCached(): string | null {
  return _apiKeyHelperCache?.value ?? null
}

export function clearApiKeyHelperCache(): void {
  _apiKeyHelperEpoch++
  _apiKeyHelperCache = null
  _apiKeyHelperInflight = null
}

export function prefetchApiKeyFromApiKeyHelperIfSafe(
  isNonInteractiveSession: boolean,
): void {
  // 跳过未批准的信任检查——内部的 _executeApiKeyHelper 也会拦截，
  // 但会触发误报分析事件，此处提前拦截更安全。
  if (
    isApiKeyHelperFromProjectOrLocalSettings() &&
    !checkHasTrustDialogAccepted()
  ) {
    return
  }
  void getApiKeyFromApiKeyHelper(isNonInteractiveSession)
}

/** AWS STS 凭据默认缓存 TTL 为 1 小时（手动管理失效，无需精确）。 */
const DEFAULT_AWS_STS_TTL = 60 * 60 * 1000

/**
 * 执行 awsAuthRefresh 命令进行交互式 AWS 认证（如 aws sso login），实时流式输出。
 * 仅在 STS caller identity 无法获取时才执行刷新（防止不必要的重新认证）。
 */
async function runAwsAuthRefresh(): Promise<boolean> {
  const awsAuthRefresh = getConfiguredAwsAuthRefresh()

  if (!awsAuthRefresh) {
    return false // 未配置，视为成功
  }

  // 安全检查：若 awsAuthRefresh 来自项目设置，需确认工作区信任
  if (isAwsAuthRefreshFromProjectSettings()) {
    const hasTrust = checkHasTrustDialogAccepted()
    if (!hasTrust && !getIsNonInteractiveSession()) {
      const error = new Error(
        `Security: awsAuthRefresh executed before workspace trust is confirmed. If you see this message, post in ${MACRO.FEEDBACK_CHANNEL}.`,
      )
      logAntError('awsAuthRefresh invoked before trust check', error)
      logEvent('tengu_awsAuthRefresh_missing_trust', {})
      return false
    }
  }

  try {
    // 先验证 STS caller identity——若已有效，跳过刷新以避免不必要的 SSO 登录提示
    logForDebugging('Fetching AWS caller identity for AWS auth refresh command')
    await checkStsCallerIdentity()
    logForDebugging(
      'Fetched AWS caller identity, skipping AWS auth refresh command',
    )
    return false
  } catch {
    // STS 调用失败（凭据过期或无效），才实际执行刷新命令
    return refreshAwsAuth(awsAuthRefresh)
  }
}

// AWS auth refresh 命令超时时间（3 分钟）。
// 足够长以支持浏览器 SSO 流程，足够短以防无限挂起。
const AWS_AUTH_REFRESH_TIMEOUT_MS = 3 * 60 * 1000

/**
 * 启动 AWS auth 刷新子进程，流式输出到 AwsAuthStatusManager（供 UI 展示）。
 * 同时通过 authStatusManager 跟踪认证状态，使 print.ts 能发出 auth_status SDK 消息。
 */
export function refreshAwsAuth(awsAuthRefresh: string): Promise<boolean> {
  logForDebugging('Running AWS auth refresh command')
  // 启动认证状态追踪（UI 可通过 auth_status 消息展示进度）
  const authStatusManager = AwsAuthStatusManager.getInstance()
  authStatusManager.startAuthentication()

  return new Promise(resolve => {
    const refreshProc = exec(awsAuthRefresh, {
      timeout: AWS_AUTH_REFRESH_TIMEOUT_MS,
    })
    refreshProc.stdout!.on('data', data => {
      const output = data.toString().trim()
      if (output) {
        // 将输出推送到状态管理器，供 UI 实时展示
        authStatusManager.addOutput(output)
        logForDebugging(output, { level: 'debug' })
      }
    })

    refreshProc.stderr!.on('data', data => {
      const error = data.toString().trim()
      if (error) {
        authStatusManager.setError(error)
        logForDebugging(error, { level: 'error' })
      }
    })

    refreshProc.on('close', (code, signal) => {
      if (code === 0) {
        logForDebugging('AWS auth refresh completed successfully')
        authStatusManager.endAuthentication(true)
        void resolve(true)
      } else {
        // SIGTERM 表示超时（exec 设置了 timeout）
        const timedOut = signal === 'SIGTERM'
        const message = timedOut
          ? chalk.red(
              'AWS auth refresh timed out after 3 minutes. Run your auth command manually in a separate terminal.',
            )
          : chalk.red(
              'Error running awsAuthRefresh (in settings or ~/.claude.json):',
            )
        // biome-ignore lint/suspicious/noConsole:: intentional console output
        console.error(message)
        authStatusManager.endAuthentication(false)
        void resolve(false)
      }
    })
  })
}

/**
 * 执行 awsCredentialExport 命令获取 AWS 临时凭据（JSON 格式），
 * 仅在 STS caller identity 无法获取时才运行，防止不必要的重新导出。
 */
async function getAwsCredsFromCredentialExport(): Promise<{
  accessKeyId: string
  secretAccessKey: string
  sessionToken: string
} | null> {
  const awsCredentialExport = getConfiguredAwsCredentialExport()

  if (!awsCredentialExport) {
    return null
  }

  // 安全检查：若 awsCredentialExport 来自项目设置，需确认工作区信任
  if (isAwsCredentialExportFromProjectSettings()) {
    const hasTrust = checkHasTrustDialogAccepted()
    if (!hasTrust && !getIsNonInteractiveSession()) {
      const error = new Error(
        `Security: awsCredentialExport executed before workspace trust is confirmed. If you see this message, post in ${MACRO.FEEDBACK_CHANNEL}.`,
      )
      logAntError('awsCredentialExport invoked before trust check', error)
      logEvent('tengu_awsCredentialExport_missing_trust', {})
      return null
    }
  }

  try {
    // 先验证 STS caller identity——若已有效，跳过 export 以避免不必要的凭据泄露风险
    logForDebugging(
      'Fetching AWS caller identity for credential export command',
    )
    await checkStsCallerIdentity()
    logForDebugging(
      'Fetched AWS caller identity, skipping AWS credential export command',
    )
    return null
  } catch {
    // STS 调用失败，才实际执行凭据导出命令
    try {
      logForDebugging('Running AWS credential export command')
      const result = await execa(awsCredentialExport, {
        shell: true,
        reject: false,
      })
      if (result.exitCode !== 0 || !result.stdout) {
        throw new Error('awsCredentialExport did not return a valid value')
      }

      // 解析 aws sts 命令输出的 JSON 格式凭据
      const awsOutput = jsonParse(result.stdout.trim())

      // 校验 STS 输出格式，确保包含必要字段
      if (!isValidAwsStsOutput(awsOutput)) {
        throw new Error(
          'awsCredentialExport did not return valid AWS STS output structure',
        )
      }

      logForDebugging('AWS credentials retrieved from awsCredentialExport')
      return {
        accessKeyId: awsOutput.Credentials.AccessKeyId,
        secretAccessKey: awsOutput.Credentials.SecretAccessKey,
        sessionToken: awsOutput.Credentials.SessionToken,
      }
    } catch (e) {
      const message = chalk.red(
        'Error getting AWS credentials from awsCredentialExport (in settings or ~/.claude.json):',
      )
      if (e instanceof Error) {
        // biome-ignore lint/suspicious/noConsole:: intentional console output
        console.error(message, e.message)
      } else {
        // biome-ignore lint/suspicious/noConsole:: intentional console output
        console.error(message, e)
      }
      return null
    }
  }
}

/**
 * 刷新 AWS 认证并获取凭据（含 INI 缓存清除）。
 * 整合 runAwsAuthRefresh、getAwsCredsFromCredentialExport 和 clearAwsIniCache，
 * 通过 TTL memoize 防止频繁刷新（默认缓存 1 小时）。
 */
export const refreshAndGetAwsCredentials = memoizeWithTTLAsync(
  async (): Promise<{
    accessKeyId: string
    secretAccessKey: string
    sessionToken: string
  } | null> => {
    // 先执行 auth refresh（若需要）
    const refreshed = await runAwsAuthRefresh()

    // 获取导出凭据（若配置了 awsCredentialExport）
    const credentials = await getAwsCredsFromCredentialExport()

    // 若进行了刷新或获取到新凭据，清除 INI 文件缓存确保后续读取到最新凭据
    if (refreshed || credentials) {
      await clearAwsIniCache()
    }

    return credentials
  },
  DEFAULT_AWS_STS_TTL,
)

export function clearAwsCredentialsCache(): void {
  refreshAndGetAwsCredentials.cache.clear()
}

/** 从 settings 读取配置的 gcpAuthRefresh 命令。 */
function getConfiguredGcpAuthRefresh(): string | undefined {
  const mergedSettings = getSettings_DEPRECATED() || {}
  return mergedSettings.gcpAuthRefresh
}

/** 判断 gcpAuthRefresh 是否来源于项目级或本地设置（用于信任检查）。 */
export function isGcpAuthRefreshFromProjectSettings(): boolean {
  const gcpAuthRefresh = getConfiguredGcpAuthRefresh()
  if (!gcpAuthRefresh) {
    return false
  }

  const projectSettings = getSettingsForSource('projectSettings')
  const localSettings = getSettingsForSource('localSettings')
  return (
    projectSettings?.gcpAuthRefresh === gcpAuthRefresh ||
    localSettings?.gcpAuthRefresh === gcpAuthRefresh
  )
}

/** GCP 凭据探针超时时间（短超时）。若无本地凭据来源（无 ADC 文件、无环境变量），
 *  google-auth-library 会回退到 GCE metadata server，在 GCP 外部会挂起约 12 秒。
 *  非 GCP 环境中缺少本地凭据时，google-auth-library 会回退到 GCE metadata server，
 *  若无此超时，会挂起约 12 秒。设置 5 秒超时可快速判断凭据是否可用。 */
const GCP_CREDENTIALS_CHECK_TIMEOUT_MS = 5_000

/**
 * 通过 GoogleAuth 检查当前 GCP 凭据是否有效（尝试获取 access token）。
 * 设置 5 秒超时以避免在非 GCP 环境中因 GCE metadata server 导致的长时间挂起。
 */
export async function checkGcpCredentialsValid(): Promise<boolean> {
  try {
    // 按需动态 import，避免无 GCP 配置时加载 google-auth-library
    const { GoogleAuth } = await import('google-auth-library')
    const auth = new GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    })
    // 并发竞争：凭据获取 vs 超时 Promise
    const probe = (async () => {
      const client = await auth.getClient()
      await client.getAccessToken()
    })()
    const timeout = sleep(GCP_CREDENTIALS_CHECK_TIMEOUT_MS).then(() => {
      throw new GcpCredentialsTimeoutError('GCP credentials check timed out')
    })
    await Promise.race([probe, timeout])
    return true
  } catch {
    // 超时或凭据无效，均视为不可用
    return false
  }
}

/** GCP 凭据默认 TTL —— 1 小时，与典型 ADC token 有效期保持一致 */
const DEFAULT_GCP_CREDENTIAL_TTL = 60 * 60 * 1000

/**
 * 执行 gcpAuthRefresh 命令进行交互式 GCP 认证（如 gcloud auth application-default login），实时流式输出。
 * 仅在 GCP 凭据无效时才执行刷新。
 */
async function runGcpAuthRefresh(): Promise<boolean> {
  const gcpAuthRefresh = getConfiguredGcpAuthRefresh()

  if (!gcpAuthRefresh) {
    return false // 未配置，视为成功
  }

  // 安全检查：若 gcpAuthRefresh 来自项目设置，需确认工作区信任
  // 危险特性需要信任才能执行，防止恶意工作区触发任意命令
  if (isGcpAuthRefreshFromProjectSettings()) {
    const hasTrust = checkHasTrustDialogAccepted()
    if (!hasTrust && !getIsNonInteractiveSession()) {
      const error = new Error(
        `Security: gcpAuthRefresh executed before workspace trust is confirmed. If you see this message, post in ${MACRO.FEEDBACK_CHANNEL}.`,
      )
      logAntError('gcpAuthRefresh invoked before trust check', error)
      logEvent('tengu_gcpAuthRefresh_missing_trust', {})
      return false
    }
  }

  try {
    logForDebugging('Checking GCP credentials validity for auth refresh')
    const isValid = await checkGcpCredentialsValid()
    if (isValid) {
      // 凭据有效，跳过刷新
      logForDebugging(
        'GCP credentials are valid, skipping auth refresh command',
      )
      return false
    }
  } catch {
    // 凭据检查失败，继续执行刷新
  }

  return refreshGcpAuth(gcpAuthRefresh)
}

// GCP auth refresh 命令超时时间（3 分钟）。
// 足够长以支持浏览器 OAuth 流程，足够短以防无限挂起。
const GCP_AUTH_REFRESH_TIMEOUT_MS = 3 * 60 * 1000

/**
 * 启动 GCP auth 刷新子进程，实时流式输出到 AwsAuthStatusManager（供 UI 展示）。
 * 注意：AwsAuthStatusManager 虽以 Aws 命名，但实际为云提供商无关的认证状态管理器，
 * print.ts 将其输出作为通用 auth_status SDK 消息发出。
 */
export function refreshGcpAuth(gcpAuthRefresh: string): Promise<boolean> {
  logForDebugging('Running GCP auth refresh command')
  // AwsAuthStatusManager 尽管名称含 Aws，实际上支持所有云提供商的认证状态追踪
  const authStatusManager = AwsAuthStatusManager.getInstance()
  authStatusManager.startAuthentication()

  return new Promise(resolve => {
    const refreshProc = exec(gcpAuthRefresh, {
      timeout: GCP_AUTH_REFRESH_TIMEOUT_MS,
    })
    refreshProc.stdout!.on('data', data => {
      const output = data.toString().trim()
      if (output) {
        // 将输出推送到状态管理器，供 UI 实时展示
        authStatusManager.addOutput(output)
        logForDebugging(output, { level: 'debug' })
      }
    })

    refreshProc.stderr!.on('data', data => {
      const error = data.toString().trim()
      if (error) {
        authStatusManager.setError(error)
        logForDebugging(error, { level: 'error' })
      }
    })

    refreshProc.on('close', (code, signal) => {
      if (code === 0) {
        logForDebugging('GCP auth refresh completed successfully')
        authStatusManager.endAuthentication(true)
        void resolve(true)
      } else {
        // SIGTERM 表示超时
        const timedOut = signal === 'SIGTERM'
        const message = timedOut
          ? chalk.red(
              'GCP auth refresh timed out after 3 minutes. Run your auth command manually in a separate terminal.',
            )
          : chalk.red(
              'Error running gcpAuthRefresh (in settings or ~/.claude.json):',
            )
        // biome-ignore lint/suspicious/noConsole:: intentional console output
        console.error(message)
        authStatusManager.endAuthentication(false)
        void resolve(false)
      }
    })
  })
}

/**
 * 按需刷新 GCP 凭据（TTL memoize，默认缓存 1 小时）。
 * 检查凭据是否有效，若无效则执行 gcpAuthRefresh 刷新命令。
 */
export const refreshGcpCredentialsIfNeeded = memoizeWithTTLAsync(
  async (): Promise<boolean> => {
    // Run auth refresh if needed（按需执行认证刷新）
    const refreshed = await runGcpAuthRefresh()
    return refreshed
  },
  DEFAULT_GCP_CREDENTIAL_TTL,
)

export function clearGcpCredentialsCache(): void {
  refreshGcpCredentialsIfNeeded.cache.clear()
}

/**
 * 若工作区信任已建立，提前预取 GCP 凭据（避免后续慢速认证阻塞）。
 * 未信任的工作区不预取，等待信任建立后再触发。
 */
export function prefetchGcpCredentialsIfSafe(): void {
  // Check if gcpAuthRefresh is configured（检查是否已配置 gcpAuthRefresh）
  const gcpAuthRefresh = getConfiguredGcpAuthRefresh()

  if (!gcpAuthRefresh) {
    return
  }

  // Check if gcpAuthRefresh is from project settings（检查 gcpAuthRefresh 是否来自项目设置）
  if (isGcpAuthRefreshFromProjectSettings()) {
    // Only prefetch if trust has already been established（仅在已建立信任时执行预取）
    const hasTrust = checkHasTrustDialogAccepted()
    if (!hasTrust && !getIsNonInteractiveSession()) {
      // Don't prefetch - wait for trust to be established first（不预取，等待信任建立）
      return
    }
  }

  // Safe to prefetch - either not from project settings or trust already established
  // 可安全预取：来源非项目设置，或信任已建立
  void refreshGcpCredentialsIfNeeded()
}

/**
 * 若工作区信任已建立，提前预取 AWS 凭据和 Bedrock 相关信息。
 * 安全保障：项目级设置来源的命令需工作区信任才能执行。
 */
export function prefetchAwsCredentialsAndBedRockInfoIfSafe(): void {
  // Check if either AWS command is configured（检查是否已配置 AWS 命令）
  const awsAuthRefresh = getConfiguredAwsAuthRefresh()
  const awsCredentialExport = getConfiguredAwsCredentialExport()

  if (!awsAuthRefresh && !awsCredentialExport) {
    return
  }

  // Check if either command is from project settings（检查命令是否来自项目设置）
  if (
    isAwsAuthRefreshFromProjectSettings() ||
    isAwsCredentialExportFromProjectSettings()
  ) {
    // Only prefetch if trust has already been established（仅在已建立信任时执行预取）
    const hasTrust = checkHasTrustDialogAccepted()
    if (!hasTrust && !getIsNonInteractiveSession()) {
      // Don't prefetch - wait for trust to be established first（不预取，等待信任建立）
      return
    }
  }

  // Safe to prefetch - either not from project settings or trust already established
  // 可安全预取：来源非项目设置，或信任已建立
  void refreshAndGetAwsCredentials()
  getModelStrings()
}

/** @private 请使用 {@link getAnthropicApiKey} 或 {@link getAnthropicApiKeyWithSource} */
export const getApiKeyFromConfigOrMacOSKeychain = memoize(
  (): { key: string; source: ApiKeySource } | null => {
    if (isBareMode()) return null
    // TODO: 迁移到 SecureStorage
    if (process.platform === 'darwin') {
      // keychainPrefetch.ts 在 main.tsx 顶层与模块导入并行发起此读取。
      // 若已完成，直接使用预取结果，避免此处同步 spawn `security` 子进程（~33ms）。
      const prefetch = getLegacyApiKeyPrefetchResult()
      if (prefetch) {
        if (prefetch.stdout) {
          return { key: prefetch.stdout, source: '/login managed key' }
        }
        // 预取完成但无 key——回退到配置文件，不再访问 Keychain
      } else {
        // 预取未完成，同步执行 security 命令读取 Keychain
        const storageServiceName = getMacOsKeychainStorageServiceName()
        try {
          const result = execSyncWithDefaults_DEPRECATED(
            `security find-generic-password -a $USER -w -s "${storageServiceName}"`,
          )
          if (result) {
            return { key: result, source: '/login managed key' }
          }
        } catch (e) {
          logError(e)
        }
      }
    }

    // 非 darwin 平台或 Keychain 未找到：从全局配置文件读取 primaryApiKey
    const config = getGlobalConfig()
    if (!config.primaryApiKey) {
      return null
    }

    return { key: config.primaryApiKey, source: '/login managed key' }
  },
)

function isValidApiKey(apiKey: string): boolean {
  // 只允许字母、数字、连字符和下划线
  return /^[a-zA-Z0-9-_]+$/.test(apiKey)
}

/**
 * 保存 API key 到 macOS Keychain（darwin）或全局配置文件（其他平台）。
 * 同时将 key 的标准化版本加入已批准列表，以便后续 getAnthropicApiKeyWithSource 识别。
 * 使用 security -i 交互式模式写入 Keychain，防止密钥出现在进程命令行参数中。
 */
export async function saveApiKey(apiKey: string): Promise<void> {
  if (!isValidApiKey(apiKey)) {
    throw new Error(
      'Invalid API key format. API key must contain only alphanumeric characters, dashes, and underscores.',
    )
  }

  // 移除旧 Keychain 条目（避免重复），然后重新写入
  await maybeRemoveApiKeyFromMacOSKeychain()
  let savedToKeychain = false
  if (process.platform === 'darwin') {
    try {
      // TODO: 迁移到 SecureStorage
      const storageServiceName = getMacOsKeychainStorageServiceName()
      const username = getUsername()

      // 转为十六进制避免转义问题（密钥中可能含特殊字符）
      const hexValue = Buffer.from(apiKey, 'utf-8').toString('hex')

      // 使用 security 交互式模式（-i）加 -X（十六进制）写入，
      // 确保凭据不出现在进程命令行参数中，进程监控只能看到 "security -i"
      const command = `add-generic-password -U -a "${username}" -s "${storageServiceName}" -X "${hexValue}"\n`

      await execa('security', ['-i'], {
        input: command,
        reject: false,
      })

      logEvent('tengu_api_key_saved_to_keychain', {})
      savedToKeychain = true
    } catch (e) {
      logError(e)
      logEvent('tengu_api_key_keychain_error', {
        error: errorMessage(
          e,
        ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
      logEvent('tengu_api_key_saved_to_config', {})
    }
  } else {
    logEvent('tengu_api_key_saved_to_config', {})
  }

  const normalizedKey = normalizeApiKeyForConfig(apiKey)

  // 保存全局配置，同时更新已批准 key 列表
  saveGlobalConfig(current => {
    const approved = current.customApiKeyResponses?.approved ?? []
    return {
      ...current,
      // Keychain 保存成功则不写入配置文件；失败时写入配置作为回退
      primaryApiKey: savedToKeychain ? current.primaryApiKey : apiKey,
      customApiKeyResponses: {
        ...current.customApiKeyResponses,
        approved: approved.includes(normalizedKey)
          ? approved
          : [...approved, normalizedKey],
        rejected: current.customApiKeyResponses?.rejected ?? [],
      },
    }
  })

  // 清除 memoize 缓存，确保下次读取从存储获取最新值
  getApiKeyFromConfigOrMacOSKeychain.cache.clear?.()
  clearLegacyApiKeyPrefetch()
}

export function isCustomApiKeyApproved(apiKey: string): boolean {
  const config = getGlobalConfig()
  const normalizedKey = normalizeApiKeyForConfig(apiKey)
  return (
    config.customApiKeyResponses?.approved?.includes(normalizedKey) ?? false
  )
}

/**
 * 删除 API key：先移除 macOS Keychain 条目（若有），再清除配置文件中的 primaryApiKey。
 * 兼容处理：即使已迁移到 Keychain，也清除配置文件（防止旧版本遗留配置中的 key）。
 */
export async function removeApiKey(): Promise<void> {
  await maybeRemoveApiKeyFromMacOSKeychain()

  // 也从配置文件删除，兼容 Keychain 支持之前保存 key 的旧版本客户端
  saveGlobalConfig(current => ({
    ...current,
    primaryApiKey: undefined,
  }))

  // 清除 memoize 缓存
  getApiKeyFromConfigOrMacOSKeychain.cache.clear?.()
  clearLegacyApiKeyPrefetch()
}

async function maybeRemoveApiKeyFromMacOSKeychain(): Promise<void> {
  try {
    await maybeRemoveApiKeyFromMacOSKeychainThrows()
  } catch (e) {
    logError(e)
  }
}

/**
 * 将 OAuth tokens 持久化到安全存储（Keychain / 配置文件）。
 * 非 claude.ai auth（第三方服务）和仅推理 token（来自 env var）跳过存储。
 * 保留已存储的 subscriptionType 和 rateLimitTier（避免瞬时网络失败覆盖有效值）。
 */
// 将 OAuth tokens 存入安全存储的函数
export function saveOAuthTokensIfNeeded(tokens: OAuthTokens): {
  success: boolean
  warning?: string
} {
  if (!shouldUseClaudeAIAuth(tokens.scopes)) {
    logEvent('tengu_oauth_tokens_not_claude_ai', {})
    return { success: true }
  }

  // 跳过仅推理 token（来自环境变量）——它们没有 refreshToken 或 expiresAt
  if (!tokens.refreshToken || !tokens.expiresAt) {
    logEvent('tengu_oauth_tokens_inference_only', {})
    return { success: true }
  }

  const secureStorage = getSecureStorage()
  const storageBackend =
    secureStorage.name as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS

  try {
    const storageData = secureStorage.read() || {}
    const existingOauth = storageData.claudeAiOauth

    storageData.claudeAiOauth = {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
      scopes: tokens.scopes,
      // refreshOAuthToken 中的 profile 获取在网络/5xx/限流时静默返回 null。
      // 不用 null 覆盖已存储的有效 subscriptionType——回退到已存储值。
      subscriptionType:
        tokens.subscriptionType ?? existingOauth?.subscriptionType ?? null,
      rateLimitTier:
        tokens.rateLimitTier ?? existingOauth?.rateLimitTier ?? null,
    }

    const updateStatus = secureStorage.update(storageData)

    if (updateStatus.success) {
      logEvent('tengu_oauth_tokens_saved', { storageBackend })
    } else {
      logEvent('tengu_oauth_tokens_save_failed', { storageBackend })
    }

    // 清除缓存确保后续读取反映最新 token
    getClaudeAIOAuthTokens.cache?.clear?.()
    clearBetasCaches()
    clearToolSchemaCache()
    return updateStatus
  } catch (error) {
    logError(error)
    logEvent('tengu_oauth_tokens_save_exception', {
      storageBackend,
      error: errorMessage(
        error,
      ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    return { success: false, warning: 'Failed to save OAuth tokens' }
  }
}

/**
 * 同步读取 Claude AI OAuth tokens（memoized）。
 * 优先级：--bare 禁用 → CLAUDE_CODE_OAUTH_TOKEN 环境变量 → 文件描述符 → 安全存储。
 * 环境变量和 FD token 均为仅推理 token（无 refreshToken 和 expiresAt）。
 */
export const getClaudeAIOAuthTokens = memoize((): OAuthTokens | null => {
  // --bare 模式：纯 API key，不使用 OAuth token
  if (isBareMode()) return null

  // 环境变量注入的 OAuth token（CCR 启动器 / 测试场景）
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    // 返回仅推理 token（不知道 refresh 和过期时间）
    return {
      accessToken: process.env.CLAUDE_CODE_OAUTH_TOKEN,
      refreshToken: null,
      expiresAt: null,
      scopes: ['user:inference'],
      subscriptionType: null,
      rateLimitTier: null,
    }
  }

  // 从文件描述符读取 OAuth token（CCR 子进程注入方式）
  const oauthTokenFromFd = getOAuthTokenFromFileDescriptor()
  if (oauthTokenFromFd) {
    // 同样为仅推理 token
    return {
      accessToken: oauthTokenFromFd,
      refreshToken: null,
      expiresAt: null,
      scopes: ['user:inference'],
      subscriptionType: null,
      rateLimitTier: null,
    }
  }

  try {
    // 从安全存储读取完整 OAuth token（含 refreshToken，支持自动刷新）
    const secureStorage = getSecureStorage()
    const storageData = secureStorage.read()
    const oauthData = storageData?.claudeAiOauth

    if (!oauthData?.accessToken) {
      return null
    }

    return oauthData
  } catch (error) {
    logError(error)
    return null
  }
})

/**
 * 清除 OAuth token 所有缓存（memoize + keychain cache）。
 * 在 401 错误时调用，确保下次读取来自持久化存储而非过期内存缓存。
 */
export function clearOAuthTokenCache(): void {
  getClaudeAIOAuthTokens.cache?.clear?.()
  clearKeychainCache()
}

let lastCredentialsMtimeMs = 0

// 跨进程缓存失效：另一个 CC 实例可能向磁盘写入新 token（刷新或 /login），
// 但本进程的 memoize 缓存永远不会失效。
// 若不做检测，终端 1 的 /login 修复终端 1；终端 2 的 /login 在服务端吊销
// 终端 1 的 token，但终端 1 的 memoize 永不重读——导致无限 /login 循环
//（CC-1096, GH#24317）。
async function invalidateOAuthCacheIfDiskChanged(): Promise<void> {
  try {
    const { mtimeMs } = await stat(
      join(getClaudeConfigHomeDir(), '.credentials.json'),
    )
    if (mtimeMs !== lastCredentialsMtimeMs) {
      // 文件已变更，清除 memoize 缓存触发重读
      lastCredentialsMtimeMs = mtimeMs
      clearOAuthTokenCache()
    }
  } catch {
    // ENOENT——macOS Keychain 路径（文件在迁移时被删除）。
    // 只清除 memoize，让 keychain cache 的 30s TTL 接管，
    // 而非在 memoize 上无限缓存。`security find-generic-password` 约 15ms，
    // 由 keychain cache 限制为每 30s 最多一次。
    getClaudeAIOAuthTokens.cache?.clear?.()
  }
}

// 并发 401 处理去重：启动时 N 个 claude.ai 代理连接器可能同时触发 401（#20930）。
// 若不去重，每次 clearOAuthTokenCache() 会清除 macOsKeychainStorage 中的 readInFlight，
// 触发新的同步 spawn——堆叠的同步 spawn 会阻塞渲染帧超过 800ms。
const pending401Handlers = new Map<string, Promise<boolean>>()

/**
 * 处理来自 API 的 OAuth token 已过期 401 错误。
 * 强制刷新 token；若另一个标签页已刷新（keychain 中有不同 token），则复用新 token。
 * 并发的相同 failedAccessToken 请求会被合并为单次 keychain 读取。
 */
export function handleOAuth401Error(
  failedAccessToken: string,
): Promise<boolean> {
  // 相同 token 的并发 401 请求复用同一 promise，避免重复 keychain 读取
  const pending = pending401Handlers.get(failedAccessToken)
  if (pending) return pending

  const promise = handleOAuth401ErrorImpl(failedAccessToken).finally(() => {
    pending401Handlers.delete(failedAccessToken)
  })
  pending401Handlers.set(failedAccessToken, promise)
  return promise
}

/**
 * 401 处理实现：清除缓存重读 keychain，若 token 已被其他实例刷新则直接复用；
 * 否则强制刷新（force=true 跳过本地过期检查）。
 */
async function handleOAuth401ErrorImpl(
  failedAccessToken: string,
): Promise<boolean> {
  // 清除缓存并异步重读 keychain（同步读取每次约 100ms，使用 async 版本）
  clearOAuthTokenCache()
  const currentTokens = await getClaudeAIOAuthTokensAsync()

  if (!currentTokens?.refreshToken) {
    return false
  }

  // keychain 中已有不同 token，说明另一个标签页已完成刷新——直接复用
  if (currentTokens.accessToken !== failedAccessToken) {
    logEvent('tengu_oauth_401_recovered_from_keychain', {})
    return true
  }

  // 与失败的 token 相同——需要强制刷新（绕过本地过期时间检查，因为服务端已明确拒绝）
  return checkAndRefreshOAuthTokenIfNeeded(0, true)
}

/**
 * 异步读取 OAuth tokens（避免阻塞 keychain）。
 * 对环境变量和 FD token 委托给同步 memoized 版本，只有存储读取才用 async 路径。
 */
export async function getClaudeAIOAuthTokensAsync(): Promise<OAuthTokens | null> {
  if (isBareMode()) return null

  // 环境变量和 FD token 都是同步的，不触碰 keychain——直接走同步路径
  if (
    process.env.CLAUDE_CODE_OAUTH_TOKEN ||
    getOAuthTokenFromFileDescriptor()
  ) {
    return getClaudeAIOAuthTokens()
  }

  try {
    // 从安全存储异步读取（避免阻塞主线程）
    const secureStorage = getSecureStorage()
    const storageData = await secureStorage.readAsync()
    const oauthData = storageData?.claudeAiOauth
    if (!oauthData?.accessToken) {
      return null
    }
    return oauthData
  } catch (error) {
    logError(error)
    return null
  }
}

// 进程内并发请求去重：同一进程中多路调用同时触发刷新时，只发起一次实际刷新
let pendingRefreshCheck: Promise<boolean> | null = null

/**
 * 当 token 即将过期时，通过分布式文件锁防止并发刷新，确保只有一个进程执行刷新。
 * 支持最多 5 次重试（遭遇锁竞争时），force=true 可跳过本地过期检查（服务端拒绝场景）。
 */
export function checkAndRefreshOAuthTokenIfNeeded(
  retryCount = 0,
  force = false,
): Promise<boolean> {
  // 对首次调用（非重试、非强制）进行进程内去重，避免并发场景下重复触发刷新
  if (retryCount === 0 && !force) {
    if (pendingRefreshCheck) {
      // 已有进行中的刷新请求——直接复用，无需再次发起
      return pendingRefreshCheck
    }

    const promise = checkAndRefreshOAuthTokenIfNeededImpl(retryCount, force)
    // 请求完成后清除缓存，允许下次调用重新发起
    pendingRefreshCheck = promise.finally(() => {
      pendingRefreshCheck = null
    })
    return pendingRefreshCheck
  }

  // 重试调用或 force 调用不走去重逻辑，直接执行实现
  return checkAndRefreshOAuthTokenIfNeededImpl(retryCount, force)
}

/**
 * checkAndRefreshOAuthTokenIfNeeded 的实际实现。
 * 执行双重检查（含分布式锁）以安全地刷新 OAuth token：
 * 1. 先用缓存值做快速检查（跳过网络开销）；
 * 2. 清缓存后再次异步读取，排除其他进程已刷新的情况；
 * 3. 仍过期则竞争文件锁，持锁后做第三次检查（消除竞态）；
 * 4. 调用刷新接口，持久化新 token，释放锁。
 */
async function checkAndRefreshOAuthTokenIfNeededImpl(
  retryCount: number,
  force: boolean,
): Promise<boolean> {
  // 最多重试 5 次（每次等待 1~2 秒），避免在锁争用高峰期无限阻塞
  const MAX_RETRIES = 5

  // 跨进程 token 缓存一致性检查：若磁盘文件已被其他进程更新，清除内存缓存
  await invalidateOAuthCacheIfDiskChanged()

  // 第一次检查：使用内存缓存值，快速判断是否需要刷新（避免不必要的 keychain 读取）
  // force=true 时跳过此检查——服务端已明确拒绝，不信任本地过期时间
  const tokens = getClaudeAIOAuthTokens()
  if (!force) {
    if (!tokens?.refreshToken || !isOAuthTokenExpired(tokens.expiresAt)) {
      // token 有效，无需刷新
      return false
    }
  }

  if (!tokens?.refreshToken) {
    // 没有 refresh token，无法刷新
    return false
  }

  if (!shouldUseClaudeAIAuth(tokens.scopes)) {
    // 非 claude.ai auth 模式，无需刷新
    return false
  }

  // 第二次检查：清除内存缓存后异步读取 keychain，排除其他进程已完成刷新的情况
  getClaudeAIOAuthTokens.cache?.clear?.()
  clearKeychainCache()
  const freshTokens = await getClaudeAIOAuthTokensAsync()
  if (
    !freshTokens?.refreshToken ||
    !isOAuthTokenExpired(freshTokens.expiresAt)
  ) {
    // 其他进程已刷新，直接使用新 token
    return false
  }

  // token 仍然过期——尝试竞争分布式文件锁，确保同时只有一个进程执行刷新
  const claudeDir = getClaudeConfigHomeDir()
  await mkdir(claudeDir, { recursive: true })

  let release
  try {
    logEvent('tengu_oauth_token_refresh_lock_acquiring', {})
    // 尝试获取目录级文件锁（通过 lockfile 库实现跨进程互斥）
    release = await lockfile.lock(claudeDir)
    logEvent('tengu_oauth_token_refresh_lock_acquired', {})
  } catch (err) {
    if ((err as { code?: string }).code === 'ELOCKED') {
      // 其他进程持有锁——等待后重试，直到超过最大重试次数
      if (retryCount < MAX_RETRIES) {
        logEvent('tengu_oauth_token_refresh_lock_retry', {
          retryCount: retryCount + 1,
        })
        // 随机化等待时间（1~2 秒），降低多进程同时重试时的碰撞概率
        await sleep(1000 + Math.random() * 1000)
        return checkAndRefreshOAuthTokenIfNeededImpl(retryCount + 1, force)
      }
      // 超过最大重试次数，放弃刷新（已有其他进程在处理）
      logEvent('tengu_oauth_token_refresh_lock_retry_limit_reached', {
        maxRetries: MAX_RETRIES,
      })
      return false
    }
    logError(err)
    logEvent('tengu_oauth_token_refresh_lock_error', {
      error: errorMessage(
        err,
      ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    return false
  }
  try {
    // 第三次检查（持锁后）：其他进程可能在我们等待锁时已完成刷新
    getClaudeAIOAuthTokens.cache?.clear?.()
    clearKeychainCache()
    const lockedTokens = await getClaudeAIOAuthTokensAsync()
    if (
      !lockedTokens?.refreshToken ||
      !isOAuthTokenExpired(lockedTokens.expiresAt)
    ) {
      // 竞态已被其他进程解决，无需重复刷新
      logEvent('tengu_oauth_token_refresh_race_resolved', {})
      return false
    }

    logEvent('tengu_oauth_token_refresh_starting', {})
    const refreshedTokens = await refreshOAuthToken(lockedTokens.refreshToken, {
      // 对 claude.ai 订阅者，省略 scopes 以使用默认 CLAUDE_AI_OAUTH_SCOPES，
      // 允许刷新时自动扩展 scope（如新增 user:file_upload）而无需重新登录
      scopes: shouldUseClaudeAIAuth(lockedTokens.scopes)
        ? undefined
        : lockedTokens.scopes,
    })
    saveOAuthTokensIfNeeded(refreshedTokens)

    // 刷新成功后清除缓存，确保后续读取使用新 token
    getClaudeAIOAuthTokens.cache?.clear?.()
    clearKeychainCache()
    return true
  } catch (error) {
    logError(error)

    // 刷新失败——清除缓存后再检查一次，处理并发场景下其他进程已成功刷新的情况
    getClaudeAIOAuthTokens.cache?.clear?.()
    clearKeychainCache()
    const currentTokens = await getClaudeAIOAuthTokensAsync()
    if (currentTokens && !isOAuthTokenExpired(currentTokens.expiresAt)) {
      // 另一进程在我们失败时成功刷新了 token
      logEvent('tengu_oauth_token_refresh_race_recovered', {})
      return true
    }

    return false
  } finally {
    logEvent('tengu_oauth_token_refresh_lock_releasing', {})
    await release()
    logEvent('tengu_oauth_token_refresh_lock_released', {})
  }
}

/** 判断当前用户是否为 claude.ai 订阅者（Max / Pro / Enterprise / Team）。 */
export function isClaudeAISubscriber(): boolean {
  if (!isAnthropicAuthEnabled()) {
    return false
  }

  return shouldUseClaudeAIAuth(getClaudeAIOAuthTokens()?.scopes)
}

/**
 * 检查当前 OAuth token 是否拥有 user:profile scope。
 * 真实 /login token 始终包含此 scope；env var 和 FD token（服务密钥）仅有 user:inference。
 * 用于过滤对 profile 端点的调用，避免服务密钥会话产生 403 请求风暴。
 */
export function hasProfileScope(): boolean {
  return (
    getClaudeAIOAuthTokens()?.scopes?.includes(CLAUDE_AI_PROFILE_SCOPE) ?? false
  )
}

export function is1PApiCustomer(): boolean {
  // 1P API 客户是指直接使用 Anthropic API key 的用户，排除以下四类：
  // 1. Claude.ai 订阅者（Max / Pro / Enterprise / Team）
  // 2. Vertex AI 用户（通过 GCP 接入）
  // 3. AWS Bedrock 用户
  // 4. Foundry 用户

  // 排除 Vertex、Bedrock 和 Foundry 云托管客户
  if (
    isEnvTruthy(process.env.CLAUDE_CODE_USE_BEDROCK) ||
    isEnvTruthy(process.env.CLAUDE_CODE_USE_VERTEX) ||
    isEnvTruthy(process.env.CLAUDE_CODE_USE_FOUNDRY)
  ) {
    return false
  }

  // 排除 claude.ai 订阅者（走 OAuth 认证而非 API key）
  if (isClaudeAISubscriber()) {
    return false
  }

  // 其余均为 1P API 客户（包括 OAuth API 客户和直接使用 API key 的用户）
  return true
}

/**
 * 获取 OAuth 账户信息（仅在 Anthropic auth 启用时可用）。
 * 使用外部 API key 或第三方服务时返回 undefined。
 */
export function getOauthAccountInfo(): AccountInfo | undefined {
  return isAnthropicAuthEnabled() ? getGlobalConfig().oauthAccount : undefined
}

/**
 * 检查当前组织是否允许超额/额外使用配额（overage provisioning）。
 * 与 claude.ai 的 useIsOverageProvisioningAllowed hook 逻辑保持一致。
 * 仅支持 Stripe 和移动端计费类型。
 */
export function isOverageProvisioningAllowed(): boolean {
  const accountInfo = getOauthAccountInfo()
  const billingType = accountInfo?.billingType

  // 必须是 claude.ai 订阅者且 billingType 已知，才可能允许超额
  if (!isClaudeAISubscriber() || !billingType) {
    return false
  }

  // 仅支持 Stripe 订阅和移动端内购（苹果 / 谷歌）购买额外用量；
  // 企业合同（contracted）和其他计费方式不允许按需超额
  if (
    billingType !== 'stripe_subscription' &&
    billingType !== 'stripe_subscription_contracted' &&
    billingType !== 'apple_subscription' &&
    billingType !== 'google_play_subscription'
  ) {
    return false
  }

  return true
}

// 返回用户是否拥有 Opus 访问权限（无论是订阅者还是按量付费用户）
export function hasOpusAccess(): boolean {
  const subscriptionType = getSubscriptionType()

  return (
    subscriptionType === 'max' ||
    subscriptionType === 'enterprise' ||
    subscriptionType === 'team' ||
    subscriptionType === 'pro' ||
    // subscriptionType === null 涵盖两种情况：
    // 1. API 直接用户（无订阅类型）
    // 2. 订阅者但尚未填充 subscriptionType 字段
    // 对于后者，存疑时应允许访问，避免误限合法用户
    subscriptionType === null
  )
}

/**
 * 获取当前用户的订阅类型（max / pro / enterprise / team / null）。
 * ANT 内部测试环境优先返回模拟订阅类型；非 Anthropic auth 模式或无 token 时返回 null。
 */
export function getSubscriptionType(): SubscriptionType | null {
  // ANT 内部测试：优先使用模拟订阅类型（用于 QA / 功能验证）
  if (shouldUseMockSubscription()) {
    return getMockSubscriptionType()
  }

  if (!isAnthropicAuthEnabled()) {
    // 非 Anthropic auth 模式（Bedrock / Vertex / 直接 API key），无订阅概念
    return null
  }
  const oauthTokens = getClaudeAIOAuthTokens()
  if (!oauthTokens) {
    // 未登录，无可用 token
    return null
  }

  // 从 token payload 中读取订阅类型（由 claude.ai OAuth 授权时写入）
  return oauthTokens.subscriptionType ?? null
}

export function isMaxSubscriber(): boolean {
  return getSubscriptionType() === 'max'
}

export function isTeamSubscriber(): boolean {
  return getSubscriptionType() === 'team'
}

export function isTeamPremiumSubscriber(): boolean {
  return (
    getSubscriptionType() === 'team' &&
    getRateLimitTier() === 'default_claude_max_5x'
  )
}

export function isEnterpriseSubscriber(): boolean {
  return getSubscriptionType() === 'enterprise'
}

export function isProSubscriber(): boolean {
  return getSubscriptionType() === 'pro'
}

export function getRateLimitTier(): string | null {
  if (!isAnthropicAuthEnabled()) {
    return null
  }
  const oauthTokens = getClaudeAIOAuthTokens()
  if (!oauthTokens) {
    return null
  }

  return oauthTokens.rateLimitTier ?? null
}

export function getSubscriptionName(): string {
  const subscriptionType = getSubscriptionType()

  switch (subscriptionType) {
    case 'enterprise':
      return 'Claude Enterprise'
    case 'team':
      return 'Claude Team'
    case 'max':
      return 'Claude Max'
    case 'pro':
      return 'Claude Pro'
    default:
      return 'Claude API'
  }
}

/** 检查是否使用第三方服务（Bedrock、Vertex 或 Foundry） */
export function isUsing3PServices(): boolean {
  return !!(
    isEnvTruthy(process.env.CLAUDE_CODE_USE_BEDROCK) ||
    isEnvTruthy(process.env.CLAUDE_CODE_USE_VERTEX) ||
    isEnvTruthy(process.env.CLAUDE_CODE_USE_FOUNDRY)
  )
}

/** 从 settings 读取配置的 otelHeadersHelper 命令。 */
function getConfiguredOtelHeadersHelper(): string | undefined {
  const mergedSettings = getSettings_DEPRECATED() || {}
  return mergedSettings.otelHeadersHelper
}

/** 判断 otelHeadersHelper 是否来源于项目级或本地设置（用于信任检查）。 */
export function isOtelHeadersHelperFromProjectOrLocalSettings(): boolean {
  const otelHeadersHelper = getConfiguredOtelHeadersHelper()
  if (!otelHeadersHelper) {
    return false
  }

  const projectSettings = getSettingsForSource('projectSettings')
  const localSettings = getSettingsForSource('localSettings')
  return (
    projectSettings?.otelHeadersHelper === otelHeadersHelper ||
    localSettings?.otelHeadersHelper === otelHeadersHelper
  )
}

// otelHeadersHelper 调用结果缓存，避免每次请求都执行外部命令
let cachedOtelHeaders: Record<string, string> | null = null
// 上次缓存写入时间戳（毫秒），用于防抖判断
let cachedOtelHeadersTimestamp = 0
// 默认防抖窗口：29 分钟（略低于 30 分钟 OAuth token 刷新周期）
const DEFAULT_OTEL_HEADERS_DEBOUNCE_MS = 29 * 60 * 1000 // 29 minutes

/**
 * 调用 otelHeadersHelper 外部命令获取 OpenTelemetry 请求头，并缓存结果（防抖）。
 * 项目/本地设置来源的 helper 需要通过信任对话框验证；全局设置的 helper 直接信任。
 * 缓存窗口默认 29 分钟，可通过 CLAUDE_CODE_OTEL_HEADERS_HELPER_DEBOUNCE_MS 覆盖。
 */
export function getOtelHeadersFromHelper(): Record<string, string> {
  const otelHeadersHelper = getConfiguredOtelHeadersHelper()

  if (!otelHeadersHelper) {
    // 未配置 helper，返回空对象
    return {}
  }

  // 防抖：若缓存仍在有效期内，直接返回缓存结果，避免频繁调用外部命令
  const debounceMs = parseInt(
    process.env.CLAUDE_CODE_OTEL_HEADERS_HELPER_DEBOUNCE_MS ||
      DEFAULT_OTEL_HEADERS_DEBOUNCE_MS.toString(),
  )
  if (
    cachedOtelHeaders &&
    Date.now() - cachedOtelHeadersTimestamp < debounceMs
  ) {
    return cachedOtelHeaders
  }

  if (isOtelHeadersHelperFromProjectOrLocalSettings()) {
    // 来自项目或本地设置的 helper 需要用户显式授权（通过信任对话框）
    const hasTrust = checkHasTrustDialogAccepted()
    if (!hasTrust) {
      // 未建立信任，拒绝执行 helper 命令，返回空头
      return {}
    }
  }

  try {
    const result = execSyncWithDefaults_DEPRECATED(otelHeadersHelper, {
      timeout: 30000, // 30 秒超时，为认证服务留出足够延迟空间
    })
      ?.toString()
      .trim()
    if (!result) {
      throw new Error('otelHeadersHelper did not return a valid value')
    }

    // 解析 JSON 输出并校验类型（必须是字符串键值对对象）
    const headers = jsonParse(result)
    if (
      typeof headers !== 'object' ||
      headers === null ||
      Array.isArray(headers)
    ) {
      throw new Error(
        'otelHeadersHelper must return a JSON object with string key-value pairs',
      )
    }

    // 验证所有值均为字符串类型，防止非法值污染请求头
    for (const [key, value] of Object.entries(headers)) {
      if (typeof value !== 'string') {
        throw new Error(
          `otelHeadersHelper returned non-string value for key "${key}": ${typeof value}`,
        )
      }
    }

    // 写入缓存并记录时间戳，供防抖逻辑使用
    cachedOtelHeaders = headers as Record<string, string>
    cachedOtelHeadersTimestamp = Date.now()

    return cachedOtelHeaders
  } catch (error) {
    logError(
      new Error(
        `Error getting OpenTelemetry headers from otelHeadersHelper (in settings): ${errorMessage(error)}`,
      ),
    )
    throw error
  }
}

function isConsumerPlan(plan: SubscriptionType): plan is 'max' | 'pro' {
  return plan === 'max' || plan === 'pro'
}

export function isConsumerSubscriber(): boolean {
  const subscriptionType = getSubscriptionType()
  return (
    isClaudeAISubscriber() &&
    subscriptionType !== null &&
    isConsumerPlan(subscriptionType)
  )
}

export type UserAccountInfo = {
  subscription?: string
  tokenSource?: string
  apiKeySource?: ApiKeySource
  organization?: string
  email?: string
}

/**
 * 收集当前用户的账户信息摘要（订阅类型、token 来源、API key 来源、组织、邮箱）。
 * 仅适用于 Anthropic 1P API；第三方服务（Bedrock / Vertex）返回 undefined。
 */
export function getAccountInformation() {
  const apiProvider = getAPIProvider()
  // 仅为 Anthropic 官方 API 提供账户信息，第三方接入无需展示
  if (apiProvider !== 'firstParty') {
    return undefined
  }
  const { source: authTokenSource } = getAuthTokenSource()
  const accountInfo: UserAccountInfo = {}
  if (
    authTokenSource === 'CLAUDE_CODE_OAUTH_TOKEN' ||
    authTokenSource === 'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR'
  ) {
    // 环境变量注入的 token，记录来源标识（服务密钥 / FD 注入场景）
    accountInfo.tokenSource = authTokenSource
  } else if (isClaudeAISubscriber()) {
    // claude.ai 订阅者，展示订阅名称（如 Claude Max）
    accountInfo.subscription = getSubscriptionName()
  } else {
    // 其他 token 来源（直接 API key 等），记录来源
    accountInfo.tokenSource = authTokenSource
  }
  const { key: apiKey, source: apiKeySource } = getAnthropicApiKeyWithSource()
  if (apiKey) {
    accountInfo.apiKeySource = apiKeySource
  }

  // 仅在通过 claude.ai OAuth 或 /login 托管 key 时才能获取组织信息；
  // 直接 API key 用户无法可靠确定其所属组织
  if (
    authTokenSource === 'claude.ai' ||
    apiKeySource === '/login managed key'
  ) {
    // 从 OAuth 账户信息中读取组织名称
    const orgName = getOauthAccountInfo()?.organizationName
    if (orgName) {
      accountInfo.organization = orgName
    }
  }
  const email = getOauthAccountInfo()?.emailAddress
  if (
    (authTokenSource === 'claude.ai' ||
      apiKeySource === '/login managed key') &&
    email
  ) {
    // 只在 claude.ai 认证场景下展示邮箱（直接 API key 用户无可信邮箱信息）
    accountInfo.email = email
  }
  return accountInfo
}

/**
 * org 验证结果——成功或带描述信息的错误。
 */
export type OrgValidationResult =
  | { valid: true }
  | { valid: false; message: string }

/**
 * 验证当前 OAuth token 所属组织是否符合 forceLoginOrgUUID 管理策略要求。
 * 若无法确定组织（网络错误、缺少 profile scope），则失败关闭（fail closed）。
 */
export async function validateForceLoginOrg(): Promise<OrgValidationResult> {
  // `claude ssh` 远程会话：真实认证由本地机器注入代理，占位符 token 无法通过
  // profile 端点验证。本地端在建立会话前已完成此检查，远程端直接放行
  if (process.env.ANTHROPIC_UNIX_SOCKET) {
    return { valid: true }
  }

  if (!isAnthropicAuthEnabled()) {
    // 非 Anthropic auth 模式（Bedrock / Vertex 等），策略不适用
    return { valid: true }
  }

  // 读取管理员通过策略设置的目标组织 UUID；未配置则无需验证
  const requiredOrgUuid =
    getSettingsForSource('policySettings')?.forceLoginOrgUUID
  if (!requiredOrgUuid) {
    return { valid: true }
  }

  // 先刷新 token（若已过期）再访问 profile 端点，确保请求使用有效 token；
  // 对于 env-var token（refreshToken 为 null），此操作为空操作
  await checkAndRefreshOAuthTokenIfNeeded()

  const tokens = getClaudeAIOAuthTokens()
  if (!tokens) {
    // 无可用 token，放行（已有其他检查确保登录）
    return { valid: true }
  }

  // 始终从 profile 端点获取权威组织 UUID，不信任 ~/.claude.json 中的缓存值，
  // 因为该文件用户可读写，无法作为安全凭据
  const { source } = getAuthTokenSource()
  const isEnvVarToken =
    source === 'CLAUDE_CODE_OAUTH_TOKEN' ||
    source === 'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR'

  // 调用 profile 端点获取当前 token 对应的组织信息
  const profile = await getOauthProfileFromOauthToken(tokens.accessToken)
  if (!profile) {
    // 获取失败——失败关闭（fail closed），拒绝访问以防策略绕过
    return {
      valid: false,
      message:
        `Unable to verify organization for the current authentication token.\n` +
        `This machine requires organization ${requiredOrgUuid} but the profile could not be fetched.\n` +
        `This may be a network error, or the token may lack the user:profile scope required for\n` +
        `verification (tokens from 'claude setup-token' do not include this scope).\n` +
        `Try again, or obtain a full-scope token via 'claude auth login'.`,
    }
  }

  const tokenOrgUuid = profile.organization.uuid
  if (tokenOrgUuid === requiredOrgUuid) {
    // 组织匹配，验证通过
    return { valid: true }
  }

  if (isEnvVarToken) {
    // 环境变量 token 的组织不匹配，提示用户移除或替换环境变量
    const envVarName =
      source === 'CLAUDE_CODE_OAUTH_TOKEN'
        ? 'CLAUDE_CODE_OAUTH_TOKEN'
        : 'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR'
    return {
      valid: false,
      message:
        `The ${envVarName} environment variable provides a token for a\n` +
        `different organization than required by this machine's managed settings.\n\n` +
        `Required organization: ${requiredOrgUuid}\n` +
        `Token organization:   ${tokenOrgUuid}\n\n` +
        `Remove the environment variable or obtain a token for the correct organization.`,
    }
  }

  // keychain / 配置文件中的 token 组织不匹配，提示重新登录正确组织
  return {
    valid: false,
    message:
      `Your authentication token belongs to organization ${tokenOrgUuid},\n` +
      `but this machine requires organization ${requiredOrgUuid}.\n\n` +
      `Please log in with the correct organization: claude auth login`,
  }
}

class GcpCredentialsTimeoutError extends Error {}
