/**
 * 核心用户数据管理模块。
 *
 * 在 Claude Code 系统流程中的位置：
 * 此模块是用户身份与分析数据的核心层，在应用启动时通过 initUser()
 * 异步预热，之后为 GrowthBook、Statsig 等所有分析提供商提供统一的
 * 用户数据基础（CoreUserData）。
 *
 * 主要功能：
 * - initUser：异步初始化，预取 email 避免 getCoreUserData 阻塞
 * - resetUserCache：认证变更时（登录/登出/切换账户）清除所有缓存
 * - getCoreUserData：（memoize 缓存）构造 CoreUserData，含设备/会话/OAuth/GitHub Actions 元数据
 * - getUserForGrowthBook：含分析元数据的 CoreUserData（订阅类型等）
 * - getGitEmail：（memoize 缓存）异步从 git config 获取用户邮箱
 */

import { execa } from 'execa'
import memoize from 'lodash-es/memoize.js'
import { getSessionId } from '../bootstrap/state.js'
import {
  getOauthAccountInfo,
  getRateLimitTier,
  getSubscriptionType,
} from './auth.js'
import { getGlobalConfig, getOrCreateUserID } from './config.js'
import { getCwd } from './cwd.js'
import { type env, getHostPlatformForAnalytics } from './env.js'
import { isEnvTruthy } from './envUtils.js'

// 异步预取的 email 缓存：null 表示尚未获取，undefined 表示无 email
let cachedEmail: string | undefined | null = null
// 防止并发多次发起获取 email 的 Promise
let emailFetchPromise: Promise<string | undefined> | null = null

/**
 * GitHub Actions CI 环境的元数据类型定义。
 */
export type GitHubActionsMetadata = {
  actor?: string           // 触发工作流的用户
  actorId?: string         // 触发者 ID
  repository?: string      // 仓库名（owner/repo）
  repositoryId?: string    // 仓库 ID
  repositoryOwner?: string // 仓库所有者
  repositoryOwnerId?: string // 仓库所有者 ID
}

/**
 * 所有分析提供商共用的核心用户数据结构。
 * 同时也是 GrowthBook 使用的格式。
 */
export type CoreUserData = {
  deviceId: string           // 设备唯一 ID（持久化存储）
  sessionId: string          // 当前会话 ID
  email?: string             // 用户邮箱（OAuth 或 git config）
  appVersion: string         // Claude Code 版本号
  platform: typeof env.platform  // 宿主平台（mac/linux/win 等）
  organizationUuid?: string  // OAuth 组织 UUID
  accountUuid?: string       // OAuth 账户 UUID
  userType?: string          // 用户类型（ant/external 等）
  subscriptionType?: string  // 订阅类型（仅分析元数据请求时填充）
  rateLimitTier?: string     // 限速等级（仅分析元数据请求时填充）
  firstTokenTime?: number    // 首次使用 token 的时间戳（毫秒）
  githubActionsMetadata?: GitHubActionsMetadata // CI 元数据（仅 GH Actions 环境）
}

/**
 * 异步初始化用户数据，应在应用启动早期调用。
 * 预取 email 以保证后续 getCoreUserData() 可同步返回。
 *
 * 流程：
 * 1. 若尚未获取过 email 且无进行中的 Promise，发起异步获取
 * 2. await email 获取结果，存入 cachedEmail
 * 3. 清除 emailFetchPromise（防止重复触发）
 * 4. 清除 getCoreUserData 的 memoize 缓存（使下次调用能用上新 email）
 */
export async function initUser(): Promise<void> {
  if (cachedEmail === null && !emailFetchPromise) {
    emailFetchPromise = getEmailAsync()
    cachedEmail = await emailFetchPromise
    emailFetchPromise = null
    // 清除 memoize 缓存，确保下次调用能获取到最新 email
    getCoreUserData.cache.clear?.()
  }
}

/**
 * 重置所有用户数据缓存。
 * 在认证状态变更（登录/登出/切换账户）时调用，
 * 使下次 getCoreUserData() 获取最新凭据和 email。
 */
export function resetUserCache(): void {
  cachedEmail = null           // 清除 email 缓存
  emailFetchPromise = null     // 清除进行中的获取 Promise
  getCoreUserData.cache.clear?.() // 清除用户数据 memoize 缓存
  getGitEmail.cache.clear?.()     // 清除 git email memoize 缓存
}

/**
 * 获取核心用户数据（memoize 缓存）。
 * 此为所有分析提供商的基础数据，不同提供商会在此基础上做转换。
 *
 * 流程：
 * 1. 获取或创建设备 ID（持久化存储）
 * 2. 读取全局配置
 * 3. 若 includeAnalyticsMetadata=true，额外获取订阅类型、限速等级、首次 token 时间
 * 4. 仅在使用 OAuth 认证时包含组织/账户 UUID
 * 5. 若在 GitHub Actions 环境，附加 CI 元数据
 *
 * @param includeAnalyticsMetadata 是否包含额外的分析元数据（GrowthBook 使用）
 * @returns CoreUserData 对象
 */
export const getCoreUserData = memoize(
  (includeAnalyticsMetadata?: boolean): CoreUserData => {
    const deviceId = getOrCreateUserID()
    const config = getGlobalConfig()

    let subscriptionType: string | undefined
    let rateLimitTier: string | undefined
    let firstTokenTime: number | undefined
    if (includeAnalyticsMetadata) {
      // 仅在请求分析元数据时获取订阅信息（避免不必要的开销）
      subscriptionType = getSubscriptionType() ?? undefined
      rateLimitTier = getRateLimitTier() ?? undefined
      if (subscriptionType && config.claudeCodeFirstTokenDate) {
        // 将首次 token 日期字符串解析为时间戳（毫秒）
        const configFirstTokenTime = new Date(
          config.claudeCodeFirstTokenDate,
        ).getTime()
        if (!isNaN(configFirstTokenTime)) {
          firstTokenTime = configFirstTokenTime
        }
      }
    }

    // 仅在使用 OAuth 认证时包含 OAuth 账户数据（API key 模式下 oauthAccount 为 null）
    const oauthAccount = getOauthAccountInfo()
    const organizationUuid = oauthAccount?.organizationUuid
    const accountUuid = oauthAccount?.accountUuid

    return {
      deviceId,
      sessionId: getSessionId(),
      email: getEmail(),
      appVersion: MACRO.VERSION, // 构建时注入的版本号
      platform: getHostPlatformForAnalytics(),
      organizationUuid,
      accountUuid,
      userType: process.env.USER_TYPE,
      subscriptionType,
      rateLimitTier,
      firstTokenTime,
      // 仅在 GitHub Actions 环境中附加 CI 元数据
      ...(isEnvTruthy(process.env.GITHUB_ACTIONS) && {
        githubActionsMetadata: {
          actor: process.env.GITHUB_ACTOR,
          actorId: process.env.GITHUB_ACTOR_ID,
          repository: process.env.GITHUB_REPOSITORY,
          repositoryId: process.env.GITHUB_REPOSITORY_ID,
          repositoryOwner: process.env.GITHUB_REPOSITORY_OWNER,
          repositoryOwnerId: process.env.GITHUB_REPOSITORY_OWNER_ID,
        },
      }),
    }
  },
)

/**
 * 获取供 GrowthBook 使用的用户数据（含完整分析元数据）。
 *
 * @returns 包含订阅类型等额外字段的 CoreUserData
 */
export function getUserForGrowthBook(): CoreUserData {
  // 传入 true 以包含 GrowthBook 所需的订阅和限速信息
  return getCoreUserData(true)
}

/**
 * 同步获取用户 email（内部使用）。
 *
 * 获取优先级：
 * 1. 异步预取的缓存值（initUser 已运行）
 * 2. OAuth 账户邮箱（正在使用 OAuth 认证时）
 * 3. ant 用户：COO_CREATOR 环境变量 + @anthropic.com 后缀
 * 4. 若 initUser 未运行，返回 undefined（不阻塞）
 */
function getEmail(): string | undefined {
  // 优先返回异步预取的缓存 email
  if (cachedEmail !== null) {
    return cachedEmail
  }

  // 仅在 OAuth 认证时包含 OAuth 邮箱
  const oauthAccount = getOauthAccountInfo()
  if (oauthAccount?.emailAddress) {
    return oauthAccount.emailAddress
  }

  // 以下为 ant 用户专属回退（不使用 execSync 避免阻塞）
  if (process.env.USER_TYPE !== 'ant') {
    return undefined
  }

  // ant 用户：尝试从 COO_CREATOR 环境变量构造 Anthropic 邮箱
  if (process.env.COO_CREATOR) {
    return `${process.env.COO_CREATOR}@anthropic.com`
  }

  // initUser() 未调用时返回 undefined，不阻塞主线程
  return undefined
}

/**
 * 异步获取用户 email（仅用于初始化阶段）。
 *
 * 获取优先级：
 * 1. OAuth 账户邮箱
 * 2. ant 用户：COO_CREATOR 环境变量
 * 3. ant 用户：git config user.email（需要衍生子进程）
 * 4. 外部用户：直接返回 undefined
 */
async function getEmailAsync(): Promise<string | undefined> {
  // 优先使用 OAuth 邮箱（无需网络请求）
  const oauthAccount = getOauthAccountInfo()
  if (oauthAccount?.emailAddress) {
    return oauthAccount.emailAddress
  }

  // 外部用户：无其他回退来源
  if (process.env.USER_TYPE !== 'ant') {
    return undefined
  }

  // ant 用户：尝试 COO_CREATOR 环境变量
  if (process.env.COO_CREATOR) {
    return `${process.env.COO_CREATOR}@anthropic.com`
  }

  // 最后回退：从 git config 异步获取邮箱（可能衍生子进程）
  return getGitEmail()
}

/**
 * 异步从 `git config user.email` 获取用户邮箱（memoize 缓存）。
 * memoize 确保整个进程生命周期内只衍生一次子进程。
 *
 * @returns git 配置中的邮箱地址，未配置时返回 undefined
 */
export const getGitEmail = memoize(async (): Promise<string | undefined> => {
  // 执行 git config 命令获取 user.email，失败时不抛出（reject: false）
  const result = await execa('git config --get user.email', {
    shell: true,
    reject: false,  // 命令失败时返回结果而非抛出异常
    cwd: getCwd(),  // 在当前工作目录执行，确保使用正确的 git 配置
  })
  // exitCode === 0 且有输出时返回去空白的邮箱，否则返回 undefined
  return result.exitCode === 0 && result.stdout
    ? result.stdout.trim()
    : undefined
})
