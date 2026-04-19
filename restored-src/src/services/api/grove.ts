/**
 * Grove 隐私设置与用户通知模块
 *
 * 在 Claude Code 系统流程中的位置：
 *   Claude Code 启动 → 检查用户是否需要查看/同意新隐私条款（Grove 通知）
 *   → 交互式模式下展示 Grove 对话框；非交互式模式下打印提示或强制退出
 *
 * 主要功能：
 *  - getGroveSettings         — 获取用户账号的 Grove 启用状态和查看时间（带 Memoize 缓存）
 *  - markGroveNoticeViewed    — 标记用户已查看 Grove 通知
 *  - updateGroveSettings      — 更新用户的 Grove 偏好设置（启用/禁用）
 *  - isQualifiedForGrove      — 非阻塞检查用户是否满足展示 Grove 的条件（缓存优先）
 *  - getGroveNoticeConfig     — 获取 Grove 的 Statsig 配置（宽限期/提醒频率等）
 *  - calculateShouldShowGrove — 根据账号设置和服务器配置决定是否展示 Grove 对话框
 *  - checkGroveForNonInteractive — 非交互式会话中处理 Grove 提示（-p 模式）
 *
 * 特点：
 *  - 所有 API 调用使用 withOAuth401Retry 自动处理令牌刷新
 *  - getGroveSettings 和 getGroveNoticeConfig 均使用 lodash memoize 缓存，
 *    调用 updateGroveSettings/markGroveNoticeViewed 后自动清除缓存
 *  - isQualifiedForGrove 完全非阻塞：有缓存则立即返回，无缓存则后台异步拉取
 */

import axios from 'axios'
import memoize from 'lodash-es/memoize.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js'
import { getOauthAccountInfo, isConsumerSubscriber } from 'src/utils/auth.js'
import { logForDebugging } from 'src/utils/debug.js'
import { gracefulShutdown } from 'src/utils/gracefulShutdown.js'
import { isEssentialTrafficOnly } from 'src/utils/privacyLevel.js'
import { writeToStderr } from 'src/utils/process.js'
import { getOauthConfig } from '../../constants/oauth.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import {
  getAuthHeaders,
  getUserAgent,
  withOAuth401Retry,
} from '../../utils/http.js'
import { logError } from '../../utils/log.js'
import { getClaudeCodeUserAgent } from '../../utils/userAgent.js'

// Grove 配置缓存有效期：24 小时（条款通常不频繁变更）
const GROVE_CACHE_EXPIRATION_MS = 24 * 60 * 60 * 1000

/** 用户账号的 Grove 设置：是否启用及最近查看时间 */
export type AccountSettings = {
  grove_enabled: boolean | null       // null 表示用户尚未做出选择
  grove_notice_viewed_at: string | null // 最近查看通知的时间（ISO 8601）
}

/** 服务端下发的 Grove 功能配置 */
export type GroveConfig = {
  grove_enabled: boolean               // 是否对该用户开启 Grove
  domain_excluded: boolean             // 用户所在域是否被排除在外
  notice_is_grace_period: boolean      // 是否处于宽限期（宽限期内仅展示提示，不强制）
  notice_reminder_frequency: number | null // 提醒间隔天数，null 表示不提醒
}

/**
 * API 调用结果的判别联合类型：
 *  - success: true  → API 调用成功（data 可能包含 null 字段）
 *  - success: false → API 调用失败（重试后仍失败）
 */
export type ApiResult<T> = { success: true; data: T } | { success: false }

/**
 * 获取当前用户账号的 Grove 设置（账号层面的启用状态和查看时间）。
 *
 * 流程：
 *  1. 若处于仅基础流量模式则直接返回失败（不发起网络请求）
 *  2. 调用 /api/oauth/account/settings 获取设置
 *  3. 失败时清除 memoize 缓存，避免瞬时错误锁死隐私设置对话框
 *
 * 使用 lodash memoize 缓存，在 updateGroveSettings/markGroveNoticeViewed 中手动清除。
 */
export const getGroveSettings = memoize(
  async (): Promise<ApiResult<AccountSettings>> => {
    // Grove 是通知功能，API 故障时跳过是正确行为
    if (isEssentialTrafficOnly()) {
      return { success: false }
    }
    try {
      const response = await withOAuth401Retry(() => {
        const authHeaders = getAuthHeaders()
        if (authHeaders.error) {
          throw new Error(`Failed to get auth headers: ${authHeaders.error}`)
        }
        return axios.get<AccountSettings>(
          `${getOauthConfig().BASE_API_URL}/api/oauth/account/settings`,
          {
            headers: {
              ...authHeaders.headers,
              'User-Agent': getClaudeCodeUserAgent(),
            },
          },
        )
      })
      return { success: true, data: response.data }
    } catch (err) {
      logError(err)
      // 失败时清除缓存：避免瞬时网络问题锁死整个会话
      // （对话框需要 success:true 才能渲染切换按钮，切换又是清除缓存的唯一路径）
      getGroveSettings.cache.clear?.()
      return { success: false }
    }
  },
)

/**
 * 标记当前用户已查看 Grove 通知。
 *
 * 流程：
 *  1. 调用 POST /api/oauth/account/grove_notice_viewed 更新服务端状态
 *  2. 清除 memoize 缓存，确保后续读取到最新的 grove_notice_viewed_at 字段
 *     （否则同一会话内重新挂载组件时会读到旧的 null 值，导致对话框重复弹出）
 */
export async function markGroveNoticeViewed(): Promise<void> {
  try {
    await withOAuth401Retry(() => {
      const authHeaders = getAuthHeaders()
      if (authHeaders.error) {
        throw new Error(`Failed to get auth headers: ${authHeaders.error}`)
      }
      return axios.post(
        `${getOauthConfig().BASE_API_URL}/api/oauth/account/grove_notice_viewed`,
        {},
        {
          headers: {
            ...authHeaders.headers,
            'User-Agent': getClaudeCodeUserAgent(),
          },
        },
      )
    })
    // 清除缓存，下次读取 getGroveSettings 时获取最新的 viewed_at 时间戳
    getGroveSettings.cache.clear?.()
  } catch (err) {
    logError(err)
  }
}

/**
 * 更新当前用户账号的 Grove 设置（启用或禁用）。
 *
 * 流程：
 *  1. 调用 PATCH /api/oauth/account/settings 提交新设置
 *  2. 清除 memoize 缓存，确保隐私设置页面在切换后读到最新值
 *
 * @param groveEnabled - 是否启用 Grove（true = 参与数据改善计划）
 */
export async function updateGroveSettings(
  groveEnabled: boolean,
): Promise<void> {
  try {
    await withOAuth401Retry(() => {
      const authHeaders = getAuthHeaders()
      if (authHeaders.error) {
        throw new Error(`Failed to get auth headers: ${authHeaders.error}`)
      }
      return axios.patch(
        `${getOauthConfig().BASE_API_URL}/api/oauth/account/settings`,
        {
          grove_enabled: groveEnabled, // 更新字段
        },
        {
          headers: {
            ...authHeaders.headers,
            'User-Agent': getClaudeCodeUserAgent(),
          },
        },
      )
    })
    // 使 memoize 缓存失效，post-toggle 确认读取时获取最新值
    getGroveSettings.cache.clear?.()
  } catch (err) {
    logError(err)
  }
}

/**
 * 非阻塞地检查用户是否满足展示 Grove 对话框的条件（缓存优先策略）。
 *
 * 策略：
 *  - 无缓存 → 后台异步拉取，本次返回 false（对话框本会话不展示）
 *  - 缓存过期 → 返回缓存值，同时后台异步刷新
 *  - 缓存新鲜 → 直接返回缓存值
 *
 * 前提条件：
 *  - 必须是消费者订阅用户（非企业用户）
 *  - 必须有有效的账号 UUID
 */
export async function isQualifiedForGrove(): Promise<boolean> {
  // 非消费者订阅用户不展示 Grove
  if (!isConsumerSubscriber()) {
    return false
  }

  const accountId = getOauthAccountInfo()?.accountUuid
  if (!accountId) {
    return false // 未登录或无账号信息
  }

  const globalConfig = getGlobalConfig()
  const cachedEntry = globalConfig.groveConfigCache?.[accountId]
  const now = Date.now()

  // 无缓存：触发后台拉取，本次直接返回 false（非阻塞）
  if (!cachedEntry) {
    logForDebugging(
      'Grove: No cache, fetching config in background (dialog skipped this session)',
    )
    void fetchAndStoreGroveConfig(accountId) // 后台异步，不等待
    return false
  }

  // 缓存过期：返回旧值并后台刷新（stale-while-revalidate 模式）
  if (now - cachedEntry.timestamp > GROVE_CACHE_EXPIRATION_MS) {
    logForDebugging(
      'Grove: Cache stale, returning cached data and refreshing in background',
    )
    void fetchAndStoreGroveConfig(accountId) // 后台异步刷新
    return cachedEntry.grove_enabled
  }

  // 缓存新鲜：直接返回
  logForDebugging('Grove: Using fresh cached config')
  return cachedEntry.grove_enabled
}

/**
 * 从 API 拉取 Grove 配置并存入全局配置缓存。
 * 仅在数据变更或缓存过期时才写盘，避免不必要的磁盘写入。
 *
 * @param accountId - 当前账号的 UUID，用作缓存的键
 */
async function fetchAndStoreGroveConfig(accountId: string): Promise<void> {
  try {
    const result = await getGroveNoticeConfig()
    if (!result.success) {
      return // API 失败时不更新缓存
    }
    const groveEnabled = result.data.grove_enabled
    const cachedEntry = getGlobalConfig().groveConfigCache?.[accountId]
    // 数据未变且缓存仍新鲜时跳过写盘（避免频繁磁盘 IO）
    if (
      cachedEntry?.grove_enabled === groveEnabled &&
      Date.now() - cachedEntry.timestamp <= GROVE_CACHE_EXPIRATION_MS
    ) {
      return
    }
    // 更新缓存（仅修改当前账号条目，其他账号的缓存不受影响）
    saveGlobalConfig(current => ({
      ...current,
      groveConfigCache: {
        ...current.groveConfigCache,
        [accountId]: {
          grove_enabled: groveEnabled,
          timestamp: Date.now(),
        },
      },
    }))
  } catch (err) {
    logForDebugging(`Grove: Failed to fetch and store config: ${err}`)
  }
}

/**
 * 获取 Grove 的 Statsig 功能配置（宽限期、提醒频率等）。
 *
 * 流程：
 *  1. 仅基础流量模式下直接返回失败
 *  2. 调用 GET /api/claude_code_grove（3 秒超时，慢则跳过 Grove 对话框）
 *  3. 将 API 响应映射到 GroveConfig 类型（对可选字段提供默认值）
 *
 * 使用 lodash memoize 缓存，缓存在失败时不清除（失败是瞬时的，缓存防止重复请求）。
 */
export const getGroveNoticeConfig = memoize(
  async (): Promise<ApiResult<GroveConfig>> => {
    // Grove 是通知功能，服务故障时跳过是正确行为
    if (isEssentialTrafficOnly()) {
      return { success: false }
    }
    try {
      const response = await withOAuth401Retry(() => {
        const authHeaders = getAuthHeaders()
        if (authHeaders.error) {
          throw new Error(`Failed to get auth headers: ${authHeaders.error}`)
        }
        return axios.get<GroveConfig>(
          `${getOauthConfig().BASE_API_URL}/api/claude_code_grove`,
          {
            headers: {
              ...authHeaders.headers,
              'User-Agent': getUserAgent(),
            },
            timeout: 3000, // 超时即跳过 Grove 对话框，避免阻塞启动
          },
        )
      })

      // 解构 API 响应，对可选字段提供安全默认值
      const {
        grove_enabled,
        domain_excluded,
        notice_is_grace_period,
        notice_reminder_frequency,
      } = response.data

      return {
        success: true,
        data: {
          grove_enabled,
          domain_excluded: domain_excluded ?? false,         // 未指定则不排除域
          notice_is_grace_period: notice_is_grace_period ?? true, // 未指定则默认宽限期
          notice_reminder_frequency,
        },
      }
    } catch (err) {
      logForDebugging(`Failed to fetch Grove notice config: ${err}`)
      return { success: false }
    }
  },
)

/**
 * 根据账号设置和服务器配置，计算是否应展示 Grove 对话框。
 *
 * 决策逻辑（优先级从高到低）：
 *  1. 任一 API 调用失败 → false（不展示，容错优先）
 *  2. 用户已做出选择（grove_enabled 非 null） → false（不再打扰）
 *  3. showIfAlreadyViewed 为 true → true（调试/重置用）
 *  4. 非宽限期 → true（强制用户选择）
 *  5. 宽限期内：根据 notice_reminder_frequency 和上次查看时间决定是否提醒
 *
 * @param settingsResult    - 账号设置 API 结果
 * @param configResult      - Grove 配置 API 结果
 * @param showIfAlreadyViewed - true 时忽略"已查看"状态（用于调试）
 */
export function calculateShouldShowGrove(
  settingsResult: ApiResult<AccountSettings>,
  configResult: ApiResult<GroveConfig>,
  showIfAlreadyViewed: boolean,
): boolean {
  // API 失败（重试后仍失败）时不展示对话框
  if (!settingsResult.success || !configResult.success) {
    return false
  }

  const settings = settingsResult.data
  const config = configResult.data

  // 用户已明确选择（启用或禁用），不再展示
  const hasChosen = settings.grove_enabled !== null
  if (hasChosen) {
    return false
  }
  // 调试模式：强制展示即使已查看
  if (showIfAlreadyViewed) {
    return true
  }
  // 非宽限期：用户必须立即做出选择
  if (!config.notice_is_grace_period) {
    return true
  }
  // 宽限期内：根据提醒频率决定是否重复提醒
  const reminderFrequency = config.notice_reminder_frequency
  if (reminderFrequency !== null && settings.grove_notice_viewed_at) {
    // 计算距上次查看的天数
    const daysSinceViewed = Math.floor(
      (Date.now() - new Date(settings.grove_notice_viewed_at).getTime()) /
        (1000 * 60 * 60 * 24),
    )
    // 超过提醒间隔则再次展示
    return daysSinceViewed >= reminderFrequency
  } else {
    // 从未查看过，展示通知
    const viewedAt = settings.grove_notice_viewed_at
    return viewedAt === null || viewedAt === undefined
  }
}

/**
 * 非交互式会话（-p 模式）中处理 Grove 通知。
 *
 * 流程：
 *  1. 并行获取账号设置和 Grove 配置
 *  2. 计算是否需要展示通知
 *  3. 宽限期内 → 向 stderr 打印提示信息后继续执行
 *  4. 宽限期结束 → 向 stderr 打印警告并调用 gracefulShutdown(1) 强制退出
 */
export async function checkGroveForNonInteractive(): Promise<void> {
  // 并行获取两个 API 数据，减少等待时间
  const [settingsResult, configResult] = await Promise.all([
    getGroveSettings(),
    getGroveNoticeConfig(),
  ])

  // 判断是否需要展示通知（API 失败时返回 false）
  const shouldShowGrove = calculateShouldShowGrove(
    settingsResult,
    configResult,
    false,
  )

  if (shouldShowGrove) {
    // shouldShowGrove 为 true 时两个 API 调用均已成功
    const config = configResult.success ? configResult.data : null
    logEvent('tengu_grove_print_viewed', {
      dismissable:
        config?.notice_is_grace_period as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    if (config === null || config.notice_is_grace_period) {
      // 宽限期仍在：打印信息性提示后继续正常执行
      writeToStderr(
        '\nAn update to our Consumer Terms and Privacy Policy will take effect on October 8, 2025. Run `claude` to review the updated terms.\n\n',
      )
      await markGroveNoticeViewed() // 标记已查看，避免每次调用都打印
    } else {
      // 宽限期已结束：打印强制提示并退出（用户必须在交互模式下接受条款）
      writeToStderr(
        '\n[ACTION REQUIRED] An update to our Consumer Terms and Privacy Policy has taken effect on October 8, 2025. You must run `claude` to review the updated terms.\n\n',
      )
      await gracefulShutdown(1) // 以非零退出码退出，表示错误
    }
  }
}
