/**
 * 【Datadog 日志上报模块】analytics/datadog.ts
 *
 * 在 Claude Code 系统流程中的位置：
 * - 属于分析（analytics）子系统，是两条数据上报通道之一（另一条为 1P EventLogger）
 * - 由 analytics/sink.ts 的 logEventImpl() 调用（需经 GrowthBook 门控和 killswitch 检查）
 * - 仅在生产环境（NODE_ENV=production）且 API 提供商为 Anthropic 第一方时生效
 *
 * 核心功能：
 * - DATADOG_ALLOWED_EVENTS 白名单控制哪些事件可上报至 Datadog（防止敏感数据泄露）
 * - 批量 HTTP 日志上传：积累到 MAX_BATCH_SIZE 条或经过 15s 后统一发送
 * - trackDatadogEvent()：对事件进行预处理后入队（MCP 工具名归一、模型名短化、版本号截断、HTTP 状态码字段转换）
 * - getUserBucket()：通过 SHA256 哈希将用户 ID 映射到 0-29 号桶，用于低基数用户计数告警
 * - 使用 memoize 保证 initializeDatadog() 在进程生命周期内只初始化一次
 */

import axios from 'axios'
import { createHash } from 'crypto'
import memoize from 'lodash-es/memoize.js'
import { getOrCreateUserID } from '../../utils/config.js'
import { logError } from '../../utils/log.js'
import { getCanonicalName } from '../../utils/model/model.js'
import { getAPIProvider } from '../../utils/model/providers.js'
import { MODEL_COSTS } from '../../utils/modelCost.js'
import { isAnalyticsDisabled } from './config.js'
import { getEventMetadata } from './metadata.js'

// Datadog HTTP 日志摄取端点（US5 数据中心）
const DATADOG_LOGS_ENDPOINT =
  'https://http-intake.logs.us5.datadoghq.com/api/v2/logs'
// Datadog 客户端 Token（公开的摄取令牌，无 admin 权限）
const DATADOG_CLIENT_TOKEN = 'pubbbf48e6d78dae54bceaa4acf463299bf'
// 默认刷新间隔：15 秒（可通过 CLAUDE_CODE_DATADOG_FLUSH_INTERVAL_MS 覆盖）
const DEFAULT_FLUSH_INTERVAL_MS = 15000
// 批次最大条数：超出时立即刷新
const MAX_BATCH_SIZE = 100
// HTTP 请求超时（毫秒）
const NETWORK_TIMEOUT_MS = 5000

/**
 * Datadog 事件白名单
 * 只有此集合中的事件名才会被发送到 Datadog。
 * 目的：防止意外上报包含用户隐私或代码内容的事件。
 */
const DATADOG_ALLOWED_EVENTS = new Set([
  'chrome_bridge_connection_succeeded',
  'chrome_bridge_connection_failed',
  'chrome_bridge_disconnected',
  'chrome_bridge_tool_call_completed',
  'chrome_bridge_tool_call_error',
  'chrome_bridge_tool_call_started',
  'chrome_bridge_tool_call_timeout',
  'tengu_api_error',
  'tengu_api_success',
  'tengu_brief_mode_enabled',
  'tengu_brief_mode_toggled',
  'tengu_brief_send',
  'tengu_cancel',
  'tengu_compact_failed',
  'tengu_exit',
  'tengu_flicker',
  'tengu_init',
  'tengu_model_fallback_triggered',
  'tengu_oauth_error',
  'tengu_oauth_success',
  'tengu_oauth_token_refresh_failure',
  'tengu_oauth_token_refresh_success',
  'tengu_oauth_token_refresh_lock_acquiring',
  'tengu_oauth_token_refresh_lock_acquired',
  'tengu_oauth_token_refresh_starting',
  'tengu_oauth_token_refresh_completed',
  'tengu_oauth_token_refresh_lock_releasing',
  'tengu_oauth_token_refresh_lock_released',
  'tengu_query_error',
  'tengu_session_file_read',
  'tengu_started',
  'tengu_tool_use_error',
  'tengu_tool_use_granted_in_prompt_permanent',
  'tengu_tool_use_granted_in_prompt_temporary',
  'tengu_tool_use_rejected_in_prompt',
  'tengu_tool_use_success',
  'tengu_uncaught_exception',
  'tengu_unhandled_rejection',
  'tengu_voice_recording_started',
  'tengu_voice_toggled',
  'tengu_team_mem_sync_pull',
  'tengu_team_mem_sync_push',
  'tengu_team_mem_sync_started',
  'tengu_team_mem_entries_capped',
])

// ddtags 中包含的高基数字段列表（用于 Datadog 仪表盘过滤和告警）
const TAG_FIELDS = [
  'arch',
  'clientType',
  'errorType',
  'http_status_range',
  'http_status',
  'kairosActive',
  'model',
  'platform',
  'provider',
  'skillMode',
  'subscriptionType',
  'toolName',
  'userBucket',
  'userType',
  'version',
  'versionBase',
]

/** 将驼峰命名转为下划线命名（Datadog 字段惯例） */
function camelToSnakeCase(str: string): string {
  return str.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`)
}

/** Datadog 日志条目的数据结构 */
type DatadogLog = {
  ddsource: string        // 日志来源（固定为 'nodejs'）
  ddtags: string          // 逗号分隔的标签字符串（用于 Datadog 过滤）
  message: string         // 日志消息（固定为事件名）
  service: string         // 服务名（固定为 'claude-code'）
  hostname: string        // 主机名（固定为 'claude-code'）
  [key: string]: unknown  // 其他任意事件属性（以下划线命名写入）
}

// 待发送的日志批次（事件在此积累，定时或满额时发送）
let logBatch: DatadogLog[] = []
// 当前批次的刷新定时器句柄
let flushTimer: NodeJS.Timeout | null = null
// Datadog 初始化状态缓存（null=未初始化，true=已启用，false=已禁用）
let datadogInitialized: boolean | null = null

/**
 * 将当前批次的日志发送到 Datadog
 * - 原子性地交换 logBatch（确保发送失败不会丢失后续入队的事件）
 * - 通过 axios POST 发送 JSON 批次
 * - 发送失败时记录错误但不重试（Datadog 日志为尽力而为，不影响主流程）
 */
async function flushLogs(): Promise<void> {
  if (logBatch.length === 0) return

  // 原子交换：先拿走当前批次，再将 logBatch 重置为空数组
  const logsToSend = logBatch
  logBatch = []

  try {
    await axios.post(DATADOG_LOGS_ENDPOINT, logsToSend, {
      headers: {
        'Content-Type': 'application/json',
        'DD-API-KEY': DATADOG_CLIENT_TOKEN,
      },
      timeout: NETWORK_TIMEOUT_MS,
    })
  } catch (error) {
    logError(error)
  }
}

/**
 * 调度一次延迟刷新
 * - 使用 .unref() 防止定时器阻塞进程退出
 * - 若已有定时器挂起，则不重复创建
 */
function scheduleFlush(): void {
  if (flushTimer) return

  flushTimer = setTimeout(() => {
    flushTimer = null
    void flushLogs()
  }, getFlushIntervalMs()).unref()
}

/**
 * 初始化 Datadog（幂等，仅执行一次）
 * 通过 memoize 保证多次调用只初始化一次。
 * 若分析已禁用（测试环境/第三方云/隐私设置），则直接返回 false。
 */
export const initializeDatadog = memoize(async (): Promise<boolean> => {
  if (isAnalyticsDisabled()) {
    datadogInitialized = false
    return false
  }

  try {
    datadogInitialized = true
    return true
  } catch (error) {
    logError(error)
    datadogInitialized = false
    return false
  }
})

/**
 * 刷新剩余日志并关闭 Datadog
 *
 * 在 gracefulShutdown() 中、process.exit() 之前调用。
 * 因为 forceExit() 会阻止 beforeExit 事件触发，必须在此显式刷新。
 */
export async function shutdownDatadog(): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  await flushLogs()
}

/**
 * 追踪一次 Datadog 事件（仅在生产环境和第一方 API 提供商时生效）
 *
 * 工作流程：
 * 1. 非生产环境直接返回
 * 2. 第三方提供商（Bedrock/Vertex/Foundry）直接返回
 * 3. 检查 Datadog 是否已初始化（使用缓存状态避免 await 开销）
 * 4. 检查事件名是否在白名单中
 * 5. 获取事件元数据（模型、用户类型、环境上下文等）
 * 6. 数据归一化处理（MCP 工具名、模型名、版本号、HTTP 状态码）
 * 7. 构建 ddtags 字符串
 * 8. 入队并按需刷新
 *
 * NOTE: 应通过 src/services/analytics/index.ts > logEvent 调用，而非直接调用此函数
 *
 * @param eventName - 事件名（必须在 DATADOG_ALLOWED_EVENTS 白名单中）
 * @param properties - 事件属性（key-value 对，值为 boolean/number/undefined）
 */
// NOTE: use via src/services/analytics/index.ts > logEvent
export async function trackDatadogEvent(
  eventName: string,
  properties: { [key: string]: boolean | number | undefined },
): Promise<void> {
  // 非生产环境不上报（避免开发/测试数据污染）
  if (process.env.NODE_ENV !== 'production') {
    return
  }

  // 第三方云服务用户不上报（Bedrock/Vertex/Foundry）
  if (getAPIProvider() !== 'firstParty') {
    return
  }

  // 快速路径：优先使用缓存的初始化状态，避免不必要的 await
  let initialized = datadogInitialized
  if (initialized === null) {
    initialized = await initializeDatadog()
  }
  // 未初始化或事件不在白名单中，直接返回
  if (!initialized || !DATADOG_ALLOWED_EVENTS.has(eventName)) {
    return
  }

  try {
    // 获取事件元数据（模型名、会话 ID、用户类型、环境上下文等）
    const metadata = await getEventMetadata({
      model: properties.model,
      betas: properties.betas,
    })
    // 解构以避免 envContext 同时以嵌套和展开两种形式出现（重复字段）
    const { envContext, ...restMetadata } = metadata
    const allData: Record<string, unknown> = {
      ...restMetadata,
      ...envContext,
      ...properties,
      userBucket: getUserBucket(), // 添加用户桶号（用于低基数用户计数告警）
    }

    // MCP 工具名归一：mcp__ 前缀的工具名统一替换为 "mcp"（降低基数）
    if (
      typeof allData.toolName === 'string' &&
      allData.toolName.startsWith('mcp__')
    ) {
      allData.toolName = 'mcp'
    }

    // 外部用户的模型名归一：映射到短名称（降低基数），未知模型归类为 "other"
    if (process.env.USER_TYPE !== 'ant' && typeof allData.model === 'string') {
      const shortName = getCanonicalName(allData.model.replace(/\[1m]$/i, ''))
      allData.model = shortName in MODEL_COSTS ? shortName : 'other'
    }

    // 开发版本号截断：去除时间戳和 SHA 后缀（降低基数）
    // 例：2.0.53-dev.20251124.t173302.sha526cc6a → 2.0.53-dev.20251124
    if (typeof allData.version === 'string') {
      allData.version = allData.version.replace(
        /^(\d+\.\d+\.\d+-dev\.\d{8})\.t\d+\.sha[a-f0-9]+$/,
        '$1',
      )
    }

    // 将 status 字段转换为 http_status 和 http_status_range
    // 原因：Datadog 将 "status" 作为保留字段（日志状态级别），直接使用会冲突
    if (allData.status !== undefined && allData.status !== null) {
      const statusCode = String(allData.status)
      allData.http_status = statusCode

      // 计算 HTTP 状态码范围（1xx ~ 5xx）
      const firstDigit = statusCode.charAt(0)
      if (firstDigit >= '1' && firstDigit <= '5') {
        allData.http_status_range = `${firstDigit}xx`
      }

      // 删除原始 status 字段，避免与 Datadog 保留字段冲突
      delete allData.status
    }

    // 构建 ddtags 字符串（以 event:<name> 开头，后接各高基数字段）
    // 说明：事件名同时写入 ddtags 是因为 `message` 字段是 Datadog 保留字段，
    // 不可在仪表盘 widget 查询和聚合 API 中直接搜索，只有 tags 支持这些操作
    const allDataRecord = allData
    const tags = [
      `event:${eventName}`,
      ...TAG_FIELDS.filter(
        field =>
          allDataRecord[field] !== undefined && allDataRecord[field] !== null,
      ).map(field => `${camelToSnakeCase(field)}:${allDataRecord[field]}`),
    ]

    // 构建最终的 Datadog 日志条目
    const log: DatadogLog = {
      ddsource: 'nodejs',
      ddtags: tags.join(','),
      message: eventName,
      service: 'claude-code',
      hostname: 'claude-code',
      env: process.env.USER_TYPE,
    }

    // 将所有事件属性以下划线命名写入日志（非 undefined/null 的字段均写入）
    for (const [key, value] of Object.entries(allData)) {
      if (value !== undefined && value !== null) {
        log[camelToSnakeCase(key)] = value
      }
    }

    // 将日志入队
    logBatch.push(log)

    // 若批次已满则立即刷新，否则启动延迟刷新定时器
    if (logBatch.length >= MAX_BATCH_SIZE) {
      if (flushTimer) {
        clearTimeout(flushTimer)
        flushTimer = null
      }
      void flushLogs()
    } else {
      scheduleFlush()
    }
  } catch (error) {
    logError(error)
  }
}

// 用户桶分组数（0 到 29，共 30 个桶）
const NUM_USER_BUCKETS = 30

/**
 * 获取当前用户所属的桶号（0-29）
 *
 * 设计目的：
 * - 用于告警时估算受影响的独立用户数量，而非事件数量
 * - 少量用户可能产生大量重试事件，直接用事件数量会误导告警
 * - 通过 SHA256 哈希将用户 ID 映射到 30 个固定桶，计数唯一桶数即可近似估计用户数
 * - 既保护用户隐私，又保持告警指标的可用性
 *
 * 使用 memoize 缓存结果，避免重复计算哈希（进程内结果不变）
 */
const getUserBucket = memoize((): number => {
  const userId = getOrCreateUserID()
  // SHA256 哈希取前 8 位十六进制字符，转为整数后取模
  const hash = createHash('sha256').update(userId).digest('hex')
  return parseInt(hash.slice(0, 8), 16) % NUM_USER_BUCKETS
})

/**
 * 获取 Datadog 日志刷新间隔（毫秒）
 * 允许通过环境变量 CLAUDE_CODE_DATADOG_FLUSH_INTERVAL_MS 覆盖（主要用于测试加速）
 */
function getFlushIntervalMs(): number {
  // Allow tests to override to not block on the default flush interval.
  return (
    parseInt(process.env.CLAUDE_CODE_DATADOG_FLUSH_INTERVAL_MS || '', 10) ||
    DEFAULT_FLUSH_INTERVAL_MS
  )
}
