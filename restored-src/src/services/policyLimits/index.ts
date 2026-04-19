/**
 * 策略限制服务（Policy Limits Service）
 *
 * 在 Claude Code 系统流程中的位置：
 * 本文件是 Claude Code 初始化流程中的安全策略层，负责从 Anthropic 后端
 * 拉取组织级别的功能限制策略（如是否允许产品反馈、是否允许远程会话等），
 * 并在整个 CLI 生命周期内通过后台轮询保持策略的时效性。
 *
 * 主要功能：
 * - 判断当前用户是否应用策略限制（isPolicyLimitsEligible）
 * - 初始加载策略并启动后台轮询（loadPolicyLimits / startBackgroundPolling）
 * - 提供同步查询接口（isPolicyAllowed）供其他模块调用
 * - 通过 SHA-256 checksum 作为 ETag 实现 HTTP 304 缓存，减少不必要的传输
 * - 对 HIPAA 类组织（essential-traffic-only 模式）特定策略采用 fail-closed 语义
 *
 * 设计原则：
 * - Fail open：除特殊敏感策略外，无法获取策略时默认允许所有操作
 * - 不依赖 getSettings()，避免设置加载循环依赖
 * - 加载完成 Promise + 30 秒超时，防止死锁阻塞 CLI 启动
 */

import axios from 'axios'
import { createHash } from 'crypto'
import { readFileSync as fsReadFileSync } from 'fs'
import { unlink, writeFile } from 'fs/promises'
import { join } from 'path'
import {
  CLAUDE_AI_INFERENCE_SCOPE,
  getOauthConfig,
  OAUTH_BETA_HEADER,
} from '../../constants/oauth.js'
import {
  checkAndRefreshOAuthTokenIfNeeded,
  getAnthropicApiKeyWithSource,
  getClaudeAIOAuthTokens,
} from '../../utils/auth.js'
import { registerCleanup } from '../../utils/cleanupRegistry.js'
import { logForDebugging } from '../../utils/debug.js'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import { classifyAxiosError } from '../../utils/errors.js'
import { safeParseJSON } from '../../utils/json.js'
import {
  getAPIProvider,
  isFirstPartyAnthropicBaseUrl,
} from '../../utils/model/providers.js'
import { isEssentialTrafficOnly } from '../../utils/privacyLevel.js'
import { sleep } from '../../utils/sleep.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { getClaudeCodeUserAgent } from '../../utils/userAgent.js'
import { getRetryDelay } from '../api/withRetry.js'
import {
  type PolicyLimitsFetchResult,
  type PolicyLimitsResponse,
  PolicyLimitsResponseSchema,
} from './types.js'

// 辅助函数：判断错误是否为 Node.js 系统错误（含 errno/code 属性）
function isNodeError(e: unknown): e is NodeJS.ErrnoException {
  return e instanceof Error
}

// ─── 常量定义 ─────────────────────────────────────────────────────────────────
const CACHE_FILENAME = 'policy-limits.json' // 本地缓存文件名
const FETCH_TIMEOUT_MS = 10000 // 单次 HTTP 请求超时：10 秒
const DEFAULT_MAX_RETRIES = 5 // 最多重试次数
const POLLING_INTERVAL_MS = 60 * 60 * 1000 // 后台轮询间隔：1 小时

// ─── 模块级状态 ───────────────────────────────────────────────────────────────
// 后台轮询定时器 ID（null 表示未启动）
let pollingIntervalId: ReturnType<typeof setInterval> | null = null
// 清理注册标志，防止重复注册
let cleanupRegistered = false

// 初始加载完成的 Promise（供外部 await）
let loadingCompletePromise: Promise<void> | null = null
// Promise 的 resolve 函数，加载完成后调用
let loadingCompleteResolve: (() => void) | null = null

// 加载超时保护：30 秒后强制 resolve，防止死锁
const LOADING_PROMISE_TIMEOUT_MS = 30000

// 会话级内存缓存：存储已解析的 restrictions 字典
let sessionCache: PolicyLimitsResponse['restrictions'] | null = null

/**
 * 仅供测试使用的同步重置函数
 *
 * clearPolicyLimitsCache() 包含文件 I/O，代价过大；
 * 本函数仅重置模块级单例变量，使同一 shard 中后续测试看到干净状态。
 */
export function _resetPolicyLimitsForTesting(): void {
  stopBackgroundPolling() // 停止后台轮询定时器
  sessionCache = null // 清空内存缓存
  loadingCompletePromise = null // 重置加载 Promise
  loadingCompleteResolve = null // 重置 resolve 函数
}

/**
 * 提前初始化策略加载完成 Promise
 *
 * 应在 init.ts 中尽早调用，使其他系统可以 await 策略加载，
 * 即便 loadPolicyLimits() 尚未被调用。
 *
 * 仅在用户符合资格时创建 Promise，并附带 30 秒超时防止死锁。
 */
export function initializePolicyLimitsLoadingPromise(): void {
  // 已有 Promise 则跳过（幂等）
  if (loadingCompletePromise) {
    return
  }

  if (isPolicyLimitsEligible()) {
    // 创建 Promise 并保存 resolve 函数供后续调用
    loadingCompletePromise = new Promise(resolve => {
      loadingCompleteResolve = resolve

      // 30 秒超时保护：即使 loadPolicyLimits 从未被调用也不会永久阻塞
      setTimeout(() => {
        if (loadingCompleteResolve) {
          logForDebugging(
            'Policy limits: Loading promise timed out, resolving anyway',
          )
          loadingCompleteResolve()
          loadingCompleteResolve = null
        }
      }, LOADING_PROMISE_TIMEOUT_MS)
    })
  }
}

/**
 * 获取策略限制缓存文件路径
 *
 * 返回 Claude 配置目录下的 policy-limits.json 文件路径。
 */
function getCachePath(): string {
  return join(getClaudeConfigHomeDir(), CACHE_FILENAME)
}

/**
 * 获取策略限制 API 端点 URL
 *
 * 从 OAuth 配置中读取 BASE_API_URL，拼接标准端点路径。
 */
function getPolicyLimitsEndpoint(): string {
  return `${getOauthConfig().BASE_API_URL}/api/claude_code/policy_limits`
}

/**
 * 递归深度排序对象的所有键
 *
 * 用于计算稳定 checksum：确保相同内容但键顺序不同的对象产生相同哈希值。
 * 数组元素顺序保持不变（顺序语义），对象键按字典序排列。
 */
function sortKeysDeep(obj: unknown): unknown {
  if (Array.isArray(obj)) {
    // 数组：递归处理每个元素，但保持原有顺序
    return obj.map(sortKeysDeep)
  }
  if (obj !== null && typeof obj === 'object') {
    const sorted: Record<string, unknown> = {}
    // 对象：按键名字典序排序后递归处理值
    for (const [key, value] of Object.entries(obj).sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      sorted[key] = sortKeysDeep(value)
    }
    return sorted
  }
  // 原始值直接返回
  return obj
}

/**
 * 计算 restrictions 内容的 SHA-256 checksum
 *
 * 用于 HTTP If-None-Match 头部（ETag 机制），服务端可返回 304 避免重复传输。
 * 格式：`sha256:<hex>`（前 64 个十六进制字符）
 */
function computeChecksum(
  restrictions: PolicyLimitsResponse['restrictions'],
): string {
  // 先深度排序确保相同内容产生相同序列化结果
  const sorted = sortKeysDeep(restrictions)
  const normalized = jsonStringify(sorted)
  // 计算 SHA-256 哈希并附加前缀标识算法
  const hash = createHash('sha256').update(normalized).digest('hex')
  return `sha256:${hash}`
}

/**
 * 判断当前用户是否需要拉取策略限制
 *
 * IMPORTANT: 本函数不得调用 getSettings() 或任何依赖 getSettings() 的函数，
 * 以避免设置加载过程中的循环依赖。
 *
 * 资格条件：
 * - 必须使用 Anthropic 一方 API（非第三方 provider）
 * - 必须使用 Anthropic 官方 Base URL（非自定义）
 * - API Key 用户（控制台用户）：直接有效
 * - OAuth 用户（Claude.ai）：需要 inference scope + Team/Enterprise 订阅
 */
export function isPolicyLimitsEligible(): boolean {
  // 第三方 provider 用户不应触达策略限制端点
  if (getAPIProvider() !== 'firstParty') {
    return false
  }

  // 自定义 Base URL 用户不应触达策略限制端点
  if (!isFirstPartyAnthropicBaseUrl()) {
    return false
  }

  // 控制台用户（API Key）：有效 API Key 即具备资格
  try {
    const { key: apiKey } = getAnthropicApiKeyWithSource({
      skipRetrievingKeyFromApiKeyHelper: true,
    })
    if (apiKey) {
      return true
    }
  } catch {
    // 无 API Key，继续检查 OAuth
  }

  // Claude.ai OAuth 用户：需要有有效的 access token
  const tokens = getClaudeAIOAuthTokens()
  if (!tokens?.accessToken) {
    return false
  }

  // 必须具备 Claude.ai inference scope
  if (!tokens.scopes?.includes(CLAUDE_AI_INFERENCE_SCOPE)) {
    return false
  }

  // 仅 Team 和 Enterprise OAuth 用户有资格：这些组织支持管理员配置策略限制
  if (
    tokens.subscriptionType !== 'enterprise' &&
    tokens.subscriptionType !== 'team'
  ) {
    return false
  }

  return true
}

/**
 * 等待初始策略限制加载完成
 *
 * 若用户无资格或加载已完成，立即返回。
 * 供需要在策略生效后才执行的逻辑使用（如 allow_product_feedback 检查）。
 */
export async function waitForPolicyLimitsToLoad(): Promise<void> {
  if (loadingCompletePromise) {
    await loadingCompletePromise
  }
}

/**
 * 构建策略限制 API 请求的认证头部
 *
 * 优先使用 API Key（控制台用户），回退到 OAuth Bearer Token（Claude.ai 用户）。
 * 不调用 getSettings()，避免循环依赖。
 *
 * @returns headers 对象，以及可选的 error 描述（无认证时填充）
 */
function getAuthHeaders(): {
  headers: Record<string, string>
  error?: string
} {
  // 优先尝试 API Key（适用于控制台用户）
  try {
    const { key: apiKey } = getAnthropicApiKeyWithSource({
      skipRetrievingKeyFromApiKeyHelper: true,
    })
    if (apiKey) {
      return {
        headers: {
          'x-api-key': apiKey,
        },
      }
    }
  } catch {
    // 无 API Key，继续检查 OAuth
  }

  // 回退到 OAuth Bearer Token（适用于 Claude.ai 用户）
  const oauthTokens = getClaudeAIOAuthTokens()
  if (oauthTokens?.accessToken) {
    return {
      headers: {
        Authorization: `Bearer ${oauthTokens.accessToken}`,
        'anthropic-beta': OAUTH_BETA_HEADER, // OAuth 专属 beta 头
      },
    }
  }

  // 两种认证方式均不可用
  return {
    headers: {},
    error: 'No authentication available',
  }
}

/**
 * 带指数退避重试的策略限制拉取
 *
 * 最多重试 DEFAULT_MAX_RETRIES 次，每次重试间隔由 getRetryDelay 提供。
 * 遇到 skipRetry=true（如认证错误）时立即停止，不继续重试。
 */
async function fetchWithRetry(
  cachedChecksum?: string,
): Promise<PolicyLimitsFetchResult> {
  let lastResult: PolicyLimitsFetchResult | null = null

  // attempt 从 1 开始，最多执行 DEFAULT_MAX_RETRIES+1 次（含首次尝试）
  for (let attempt = 1; attempt <= DEFAULT_MAX_RETRIES + 1; attempt++) {
    lastResult = await fetchPolicyLimits(cachedChecksum)

    // 成功则立即返回
    if (lastResult.success) {
      return lastResult
    }

    // skipRetry=true 表示重试无意义（如认证失败），直接返回
    if (lastResult.skipRetry) {
      return lastResult
    }

    // 已超过最大重试次数，返回最后一次结果
    if (attempt > DEFAULT_MAX_RETRIES) {
      return lastResult
    }

    // 等待指数退避延迟后重试
    const delayMs = getRetryDelay(attempt)
    logForDebugging(
      `Policy limits: Retry ${attempt}/${DEFAULT_MAX_RETRIES} after ${delayMs}ms`,
    )
    await sleep(delayMs)
  }

  return lastResult!
}

/**
 * 单次策略限制 HTTP 请求（无重试逻辑）
 *
 * 支持三种响应码：
 * - 200：解析并返回新的 restrictions
 * - 304：缓存仍有效，返回 restrictions=null 信号
 * - 404：无策略限制，返回空 restrictions {}
 *
 * 网络/认证错误通过 classifyAxiosError 分类后返回带 skipRetry 标志的结果。
 */
async function fetchPolicyLimits(
  cachedChecksum?: string,
): Promise<PolicyLimitsFetchResult> {
  try {
    // 先刷新 OAuth Token（如需要），避免用过期 token 发请求
    await checkAndRefreshOAuthTokenIfNeeded()

    const authHeaders = getAuthHeaders()
    if (authHeaders.error) {
      // 无认证信息，无需重试
      return {
        success: false,
        error: 'Authentication required for policy limits',
        skipRetry: true,
      }
    }

    const endpoint = getPolicyLimitsEndpoint()
    const headers: Record<string, string> = {
      ...authHeaders.headers,
      'User-Agent': getClaudeCodeUserAgent(), // 标识 Claude Code 客户端
    }

    // 如有缓存 checksum，设置 If-None-Match 头触发 304 响应
    if (cachedChecksum) {
      headers['If-None-Match'] = `"${cachedChecksum}"`
    }

    const response = await axios.get(endpoint, {
      headers,
      timeout: FETCH_TIMEOUT_MS,
      // 仅允许 200/304/404 通过，其他状态码抛出异常
      validateStatus: status =>
        status === 200 || status === 304 || status === 404,
    })

    // 304 Not Modified：服务端确认缓存仍有效
    if (response.status === 304) {
      logForDebugging('Policy limits: Using cached restrictions (304)')
      return {
        success: true,
        restrictions: null, // null 表示使用现有缓存
        etag: cachedChecksum,
      }
    }

    // 404 Not Found：该用户/组织无策略限制
    if (response.status === 404) {
      logForDebugging('Policy limits: No restrictions found (404)')
      return {
        success: true,
        restrictions: {}, // 空对象表示无任何限制
        etag: undefined,
      }
    }

    // 200：解析响应体，用 Zod schema 验证结构
    const parsed = PolicyLimitsResponseSchema().safeParse(response.data)
    if (!parsed.success) {
      logForDebugging(
        `Policy limits: Invalid response format - ${parsed.error.message}`,
      )
      return {
        success: false,
        error: 'Invalid policy limits format',
      }
    }

    logForDebugging('Policy limits: Fetched successfully')
    return {
      success: true,
      restrictions: parsed.data.restrictions,
    }
  } catch (error) {
    // 404 已由 validateStatus 处理，不会到达此处
    const { kind, message } = classifyAxiosError(error)
    switch (kind) {
      case 'auth':
        // 认证错误：无需重试
        return {
          success: false,
          error: 'Not authorized for policy limits',
          skipRetry: true,
        }
      case 'timeout':
        return { success: false, error: 'Policy limits request timeout' }
      case 'network':
        return { success: false, error: 'Cannot connect to server' }
      default:
        return { success: false, error: message }
    }
  }
}

/**
 * 从本地缓存文件加载 restrictions（同步读取）
 *
 * 使用同步 I/O 是因为此函数从同步上下文（getRestrictionsFromCache → isPolicyAllowed）调用。
 * 读取失败或解析失败时返回 null（fail open）。
 */
// sync IO: called from sync context (getRestrictionsFromCache -> isPolicyAllowed)
function loadCachedRestrictions(): PolicyLimitsResponse['restrictions'] | null {
  try {
    const content = fsReadFileSync(getCachePath(), 'utf-8')
    const data = safeParseJSON(content, false)
    // 用 Zod schema 验证缓存文件中的 JSON 结构
    const parsed = PolicyLimitsResponseSchema().safeParse(data)
    if (!parsed.success) {
      return null
    }

    return parsed.data.restrictions
  } catch {
    // 文件不存在或读取失败，返回 null
    return null
  }
}

/**
 * 将 restrictions 写入本地缓存文件（异步）
 *
 * 文件权限设置为 0o600（仅当前用户可读写），保护策略数据安全。
 * 写入失败只记录调试日志，不抛出异常（fail open）。
 */
async function saveCachedRestrictions(
  restrictions: PolicyLimitsResponse['restrictions'],
): Promise<void> {
  try {
    const path = getCachePath()
    const data: PolicyLimitsResponse = { restrictions }
    await writeFile(path, jsonStringify(data, null, 2), {
      encoding: 'utf-8',
      mode: 0o600, // 文件权限：仅当前用户可读写
    })
    logForDebugging(`Policy limits: Saved to ${path}`)
  } catch (error) {
    logForDebugging(
      `Policy limits: Failed to save - ${error instanceof Error ? error.message : 'unknown error'}`,
    )
  }
}

/**
 * 拉取并加载策略限制（含文件缓存）
 *
 * 完整流程：
 * 1. 检查用户资格
 * 2. 读取本地缓存并计算 checksum
 * 3. 带 ETag 请求 API（可能返回 304）
 * 4. 根据响应更新内存缓存和文件缓存
 * 5. 失败时降级使用缓存（fail open）
 *
 * 对 404 响应（无策略）：删除已有缓存文件（清理历史遗留数据）
 */
async function fetchAndLoadPolicyLimits(): Promise<
  PolicyLimitsResponse['restrictions'] | null
> {
  // 无资格用户直接返回 null
  if (!isPolicyLimitsEligible()) {
    return null
  }

  // 读取本地缓存，计算用于 ETag 的 checksum
  const cachedRestrictions = loadCachedRestrictions()

  const cachedChecksum = cachedRestrictions
    ? computeChecksum(cachedRestrictions)
    : undefined

  try {
    const result = await fetchWithRetry(cachedChecksum)

    if (!result.success) {
      // 拉取失败时使用旧缓存（fail open）
      if (cachedRestrictions) {
        logForDebugging('Policy limits: Using stale cache after fetch failure')
        sessionCache = cachedRestrictions
        return cachedRestrictions
      }
      return null
    }

    // 304 Not Modified：服务端确认缓存仍有效，直接使用本地缓存
    if (result.restrictions === null && cachedRestrictions) {
      logForDebugging('Policy limits: Cache still valid (304 Not Modified)')
      sessionCache = cachedRestrictions
      return cachedRestrictions
    }

    const newRestrictions = result.restrictions || {}
    const hasContent = Object.keys(newRestrictions).length > 0

    if (hasContent) {
      // 有新策略内容：更新内存缓存并写入文件
      sessionCache = newRestrictions
      await saveCachedRestrictions(newRestrictions)
      logForDebugging('Policy limits: Applied new restrictions successfully')
      return newRestrictions
    }

    // 空 restrictions（404 响应）：清空内存缓存，删除缓存文件
    sessionCache = newRestrictions
    try {
      await unlink(getCachePath())
      logForDebugging('Policy limits: Deleted cached file (404 response)')
    } catch (e) {
      // ENOENT（文件不存在）是正常情况，忽略；其他错误记录日志
      if (isNodeError(e) && e.code !== 'ENOENT') {
        logForDebugging(
          `Policy limits: Failed to delete cached file - ${e.message}`,
        )
      }
    }
    return newRestrictions
  } catch {
    // 异常时使用旧缓存（fail open）
    if (cachedRestrictions) {
      logForDebugging('Policy limits: Using stale cache after error')
      sessionCache = cachedRestrictions
      return cachedRestrictions
    }
    return null
  }
}

/**
 * 对 essential-traffic-only 模式（HIPAA 等合规组织）采用 fail-closed 的策略集合
 *
 * 这些策略在缓存不可用时默认拒绝，而非 fail open。
 * 若缓存未命中或网络超时，不会静默地为 HIPAA 组织重新启用这些功能。
 */
const ESSENTIAL_TRAFFIC_DENY_ON_MISS = new Set(['allow_product_feedback'])

/**
 * 同步检查指定策略是否被允许
 *
 * 语义：
 * - restrictions 不可用时：fail open（返回 true），例外见 ESSENTIAL_TRAFFIC_DENY_ON_MISS
 * - 策略名不在 restrictions 中：允许（unknown policy = allowed）
 * - 策略名在 restrictions 中：返回对应的 allowed 值
 *
 * HIPAA 例外：essential-traffic-only 模式下，ESSENTIAL_TRAFFIC_DENY_ON_MISS 中的策略
 * 在缓存不可用时返回 false（fail closed），防止数据出境违规。
 */
export function isPolicyAllowed(policy: string): boolean {
  const restrictions = getRestrictionsFromCache()
  if (!restrictions) {
    // 无缓存时：HIPAA 敏感策略 fail closed，其他策略 fail open
    if (
      isEssentialTrafficOnly() &&
      ESSENTIAL_TRAFFIC_DENY_ON_MISS.has(policy)
    ) {
      return false
    }
    return true // fail open
  }
  const restriction = restrictions[policy]
  if (!restriction) {
    return true // 未知策略默认允许
  }
  return restriction.allowed
}

/**
 * 从内存缓存或文件缓存中同步获取 restrictions
 *
 * 优先返回内存缓存（最快），回退到文件缓存（需磁盘 I/O）。
 * 文件缓存命中时同步更新内存缓存，加速后续查询。
 * 无资格用户直接返回 null。
 */
function getRestrictionsFromCache():
  | PolicyLimitsResponse['restrictions']
  | null {
  // 无资格用户不应有任何限制
  if (!isPolicyLimitsEligible()) {
    return null
  }

  // 内存缓存命中（最快路径）
  if (sessionCache) {
    return sessionCache
  }

  // 回退到文件缓存（同步磁盘读取）
  const cachedRestrictions = loadCachedRestrictions()
  if (cachedRestrictions) {
    sessionCache = cachedRestrictions // 提升到内存缓存
    return cachedRestrictions
  }

  return null
}

/**
 * CLI 初始化时加载策略限制
 *
 * 流程：
 * 1. 若有资格且尚无 Promise，创建加载完成 Promise
 * 2. 拉取并加载策略限制
 * 3. 启动后台轮询（1小时间隔）
 * 4. 无论成功失败，始终 resolve 加载 Promise（fail open）
 */
export async function loadPolicyLimits(): Promise<void> {
  // 有资格且尚无 Promise 时，创建新的加载完成 Promise
  if (isPolicyLimitsEligible() && !loadingCompletePromise) {
    loadingCompletePromise = new Promise(resolve => {
      loadingCompleteResolve = resolve
    })
  }

  try {
    await fetchAndLoadPolicyLimits()

    // 加载完成后启动后台轮询
    if (isPolicyLimitsEligible()) {
      startBackgroundPolling()
    }
  } finally {
    // 无论成功失败，始终通知等待者加载已完成（fail open）
    if (loadingCompleteResolve) {
      loadingCompleteResolve()
      loadingCompleteResolve = null
    }
  }
}

/**
 * 异步刷新策略限制（用于认证状态变更时）
 *
 * 在用户登录/登出后调用，清除旧缓存并重新拉取最新策略。
 * 无资格用户跳过拉取。
 */
export async function refreshPolicyLimits(): Promise<void> {
  // 清除所有旧缓存（包括文件缓存和内存缓存）
  await clearPolicyLimitsCache()

  if (!isPolicyLimitsEligible()) {
    return
  }

  await fetchAndLoadPolicyLimits()
  logForDebugging('Policy limits: Refreshed after auth change')
}

/**
 * 清除所有策略限制数据（内存缓存、文件缓存，并停止后台轮询）
 *
 * 在登出操作时调用，确保策略数据不残留。
 * 删除文件失败时忽略（包括文件不存在的 ENOENT 错误）。
 */
export async function clearPolicyLimitsCache(): Promise<void> {
  stopBackgroundPolling() // 停止后台轮询

  sessionCache = null // 清空内存缓存

  // 重置加载 Promise 状态
  loadingCompletePromise = null
  loadingCompleteResolve = null

  try {
    await unlink(getCachePath()) // 删除缓存文件
  } catch {
    // 忽略所有错误（包括 ENOENT）
  }
}

/**
 * 后台轮询回调函数
 *
 * 每次执行时重新拉取策略限制并更新缓存。
 * 检测到策略变化时记录调试日志（可用于排查策略更新问题）。
 * 轮询失败时不 fail closed——后台轮询的失败不应影响用户正在进行的操作。
 */
async function pollPolicyLimits(): Promise<void> {
  if (!isPolicyLimitsEligible()) {
    return
  }

  // 记录轮询前的缓存状态，用于变化检测
  const previousCache = sessionCache ? jsonStringify(sessionCache) : null

  try {
    await fetchAndLoadPolicyLimits()

    const newCache = sessionCache ? jsonStringify(sessionCache) : null
    if (newCache !== previousCache) {
      logForDebugging('Policy limits: Changed during background poll')
    }
  } catch {
    // 后台轮询失败不 fail closed，静默处理
  }
}

/**
 * 启动后台策略限制轮询
 *
 * 每 1 小时检查一次策略是否有更新，确保长时间运行的会话能感知策略变化。
 * 使用 unref() 确保轮询定时器不阻止进程退出。
 * 仅注册一次清理钩子（防止重复注册）。
 */
export function startBackgroundPolling(): void {
  // 已在轮询中，跳过
  if (pollingIntervalId !== null) {
    return
  }

  if (!isPolicyLimitsEligible()) {
    return
  }

  // 创建定期轮询定时器
  pollingIntervalId = setInterval(() => {
    void pollPolicyLimits()
  }, POLLING_INTERVAL_MS)
  // unref() 使定时器不阻止 Node.js 进程自然退出
  pollingIntervalId.unref()

  // 注册进程退出时的清理钩子（仅注册一次）
  if (!cleanupRegistered) {
    cleanupRegistered = true
    registerCleanup(async () => stopBackgroundPolling())
  }
}

/**
 * 停止后台策略限制轮询
 *
 * 清除定时器并将 pollingIntervalId 重置为 null。
 * 在测试重置、登出清理等场景中调用。
 */
export function stopBackgroundPolling(): void {
  if (pollingIntervalId !== null) {
    clearInterval(pollingIntervalId)
    pollingIntervalId = null
  }
}
