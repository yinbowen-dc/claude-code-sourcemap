/**
 * 指标上报退出状态（Metrics Opt-Out）缓存模块
 *
 * 在 Claude Code 系统流程中的位置：
 *   BigQuery 事件导出前 → 调用 checkMetricsEnabled() 确认组织是否允许上报
 *   → 允许则正常导出；禁止则跳过
 *
 * 主要功能：
 *  - checkMetricsEnabled          — 主入口，检查当前组织的指标上报状态（两级缓存）
 *  - _clearMetricsEnabledCacheForTesting — 测试专用，清除内存缓存
 *
 * 缓存设计（两级）：
 *  - 磁盘缓存（24 小时 TTL）：跨进程持久化，大幅减少 API 调用（N 个 `claude -p` 进程 → 约 1 次/天）
 *  - 内存缓存（1 小时 TTL）：同进程内去重，使用 memoizeWithTTLAsync 实现
 *
 * 特殊处理：
 *  - 仅基础流量模式（isEssentialTrafficOnly）：直接返回 enabled:false，不发起网络请求
 *  - Service Key OAuth 会话（缺少 user:profile scope）：直接返回 enabled:false，不持久化
 *    （避免污染后续 full-OAuth 会话的磁盘缓存）
 */

import axios from 'axios'
import { hasProfileScope, isClaudeAISubscriber } from '../../utils/auth.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import { logForDebugging } from '../../utils/debug.js'
import { errorMessage } from '../../utils/errors.js'
import { getAuthHeaders, withOAuth401Retry } from '../../utils/http.js'
import { logError } from '../../utils/log.js'
import { memoizeWithTTLAsync } from '../../utils/memoize.js'
import { isEssentialTrafficOnly } from '../../utils/privacyLevel.js'
import { getClaudeCodeUserAgent } from '../../utils/userAgent.js'

/** API 响应结构：包含 metrics_logging_enabled 字段 */
type MetricsEnabledResponse = {
  metrics_logging_enabled: boolean
}

/** 标准化的指标状态结构：enabled 表示是否允许，hasError 表示本次查询是否出错 */
type MetricsStatus = {
  enabled: boolean
  hasError: boolean
}

// 内存缓存 TTL：1 小时，用于同进程内的请求去重
const CACHE_TTL_MS = 60 * 60 * 1000

// 磁盘缓存 TTL：24 小时，组织设置变动频率低，新鲜的磁盘缓存可完全跳过网络请求
// 这是将多个 `claude -p` 调用压缩为约每天 1 次 API 调用的关键机制
const DISK_CACHE_TTL_MS = 24 * 60 * 60 * 1000

/**
 * 调用 API 获取当前组织的指标上报状态（内部函数，不含缓存逻辑）。
 *
 * 流程：
 *  1. 获取认证请求头（Bearer Token 或 API Key）
 *  2. 调用 /api/claude_code/organizations/metrics_enabled 接口（5 秒超时）
 *  3. 返回原始 MetricsEnabledResponse 结构
 *
 * 此函数被 memoizeWithTTLAsync 包装，添加 1 小时内存缓存。
 */
async function _fetchMetricsEnabled(): Promise<MetricsEnabledResponse> {
  // 获取认证请求头，失败则抛出错误
  const authResult = getAuthHeaders()
  if (authResult.error) {
    throw new Error(`Auth error: ${authResult.error}`)
  }

  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': getClaudeCodeUserAgent(), // 携带 Claude Code 版本标识
    ...authResult.headers,
  }

  // 固定使用生产端点（不受 ANTHROPIC_BASE_URL 影响，组织设置是管理 API）
  const endpoint = `https://api.anthropic.com/api/claude_code/organizations/metrics_enabled`
  const response = await axios.get<MetricsEnabledResponse>(endpoint, {
    headers,
    timeout: 5000, // 5 秒超时，避免阻塞导出流程
  })
  return response.data
}

/**
 * 调用 API 检查指标状态，并将结果规范化为 MetricsStatus 格式（内部函数）。
 *
 * 额外处理：
 *  - 仅基础流量模式下直接返回 enabled:false（不发起网络请求，削减服务端负载）
 *  - 通过 withOAuth401Retry 自动处理令牌过期和 403 吊销
 *  - 捕获所有错误，返回 hasError:true，避免因指标状态查询失败影响主流程
 */
async function _checkMetricsEnabledAPI(): Promise<MetricsStatus> {
  // Incident kill switch: skip the network call when nonessential traffic is disabled.
  // Returning enabled:false sheds load at the consumer (bigqueryExporter skips
  // export). Matches the non-subscriber early-return shape below.
  if (isEssentialTrafficOnly()) {
    // 紧急降级：禁止非必要流量时跳过 API 调用，直接返回禁用
    return { enabled: false, hasError: false }
  }

  try {
    // 带 401 自动重试（also403Revoked:true 表示同时处理令牌吊销的 403）
    const data = await withOAuth401Retry(_fetchMetricsEnabled, {
      also403Revoked: true,
    })

    logForDebugging(
      `Metrics opt-out API response: enabled=${data.metrics_logging_enabled}`,
    )

    return {
      enabled: data.metrics_logging_enabled,
      hasError: false,
    }
  } catch (error) {
    // 任何网络错误或认证失败都静默处理，返回 hasError:true
    logForDebugging(
      `Failed to check metrics opt-out status: ${errorMessage(error)}`,
    )
    logError(error)
    return { enabled: false, hasError: true } // 出错时保守地返回禁用
  }
}

// 使用 memoizeWithTTLAsync 包装内部检查函数，添加 1 小时内存缓存
// 同一进程内的并发调用会复用同一个 Promise，不重复发起 API 请求
const memoizedCheckMetrics = memoizeWithTTLAsync(
  _checkMetricsEnabledAPI,
  CACHE_TTL_MS,
)

/**
 * 获取指标状态并在必要时将结果持久化到磁盘缓存（内部函数）。
 *
 * 策略：
 *  - 调用内存缓存版的 _checkMetricsEnabledAPI
 *  - API 出错时不更新磁盘缓存（瞬时失败不覆盖已知的好值）
 *  - 若数据未变且磁盘缓存仍新鲜，跳过写入（避免并发写入配置文件的 IO 竞争）
 */
async function refreshMetricsStatus(): Promise<MetricsStatus> {
  const result = await memoizedCheckMetrics()
  if (result.hasError) {
    // API 出错时直接返回，不更新磁盘缓存
    return result
  }

  const cached = getGlobalConfig().metricsStatusCache
  const unchanged = cached !== undefined && cached.enabled === result.enabled
  // Skip write when unchanged AND timestamp still fresh — avoids config churn
  // when concurrent callers race past a stale disk entry and all try to write.
  // 数据未变且磁盘缓存未过期：跳过写入，避免多个并发进程同时写配置文件
  if (unchanged && Date.now() - cached.timestamp < DISK_CACHE_TTL_MS) {
    return result
  }

  // 持久化到全局配置（磁盘），记录时间戳用于 TTL 判断
  saveGlobalConfig(current => ({
    ...current,
    metricsStatusCache: {
      enabled: result.enabled,
      timestamp: Date.now(),
    },
  }))
  return result
}

/**
 * 检查当前组织是否启用了指标上报（主入口函数）。
 *
 * 两级缓存策略：
 *  - 磁盘缓存（24h TTL）：跨进程持久化，新鲜时完全不发起网络请求
 *  - 内存缓存（1h TTL）：同进程内去重后台刷新请求
 *
 * 调用方（bigqueryExporter）可以接受轻度过时的数据——24 小时内的一次遗漏或多余导出是可接受的。
 *
 * 特殊情况：
 *  - Service Key OAuth 会话（缺少 user:profile scope）→ 直接返回 enabled:false，不读写磁盘
 *    （防止 service-key 会话将 false 缓存到磁盘，影响后续 full-OAuth 会话）
 *  - 非订阅用户（API Key 模式）→ 不做特殊处理，走正常磁盘缓存路径
 */
export async function checkMetricsEnabled(): Promise<MetricsStatus> {
  // Service key OAuth sessions lack user:profile scope → would 403.
  // API key users (non-subscribers) fall through and use x-api-key auth.
  // This check runs before the disk read so we never persist auth-state-derived
  // answers — only real API responses go to disk. Otherwise a service-key
  // session would poison the cache for a later full-OAuth session.
  if (isClaudeAISubscriber() && !hasProfileScope()) {
    // Service Key 会话缺少 profile scope，直接返回禁用（不污染磁盘缓存）
    return { enabled: false, hasError: false }
  }

  const cached = getGlobalConfig().metricsStatusCache
  if (cached) {
    if (Date.now() - cached.timestamp > DISK_CACHE_TTL_MS) {
      // saveGlobalConfig's fallback path (config.ts:731) can throw if both
      // locked and fallback writes fail — catch here so fire-and-forget
      // doesn't become an unhandled rejection.
      // 磁盘缓存已过期：触发后台刷新（stale-while-revalidate 模式）
      // 捕获潜在的写入错误，避免未处理的 Promise rejection
      void refreshMetricsStatus().catch(logError)
    }
    // 无论是否过期，立即返回磁盘缓存值（非阻塞）
    return {
      enabled: cached.enabled,
      hasError: false,
    }
  }

  // First-ever run on this machine: block on the network to populate disk.
  // 首次运行（无磁盘缓存）：阻塞等待网络请求，将结果写入磁盘
  return refreshMetricsStatus()
}

// Export for testing purposes only
// 仅供测试使用：清除内存缓存，使下次调用重新发起 API 请求
export const _clearMetricsEnabledCacheForTesting = (): void => {
  memoizedCheckMetrics.cache.clear()
}
