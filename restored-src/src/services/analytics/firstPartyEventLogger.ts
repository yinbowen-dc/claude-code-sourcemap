/**
 * 【第一方事件日志模块】analytics/firstPartyEventLogger.ts
 *
 * 在 Claude Code 系统流程中的位置：
 * - 属于分析（analytics）子系统，是两条数据上报通道之一（另一条为 Datadog）
 * - 由 analytics/sink.ts 的 logEventImpl() 在 sink 层调用 logEventTo1P()
 * - 依赖 analytics/firstPartyEventLoggingExporter.ts 实现实际的 HTTP 批量上传
 * - 在 app 启动时由 sink.ts 的 initializeAnalyticsSink() 触发 initialize1PEventLogging()
 * - 在 GrowthBook 刷新时由 growthbook.ts 触发 reinitialize1PEventLoggingIfConfigChanged()
 *
 * 核心功能：
 * - initialize1PEventLogging(): 创建独立的 LoggerProvider（不注册为全局 OTel，防止与客户 OTLP 混用）
 * - logEventTo1P(): 同步触发点（fire-and-forget），内部调用异步 logEventTo1PAsync() 完成元数据富化
 * - logGrowthBookExperimentTo1P(): 单独上报 GrowthBook 实验分配事件
 * - reinitialize1PEventLoggingIfConfigChanged(): 配置变更时安全地重建 pipeline（先置空 logger → forceFlush → 替换 → 后台关闭旧 provider）
 * - getEventSamplingConfig() / shouldSampleEvent(): 基于 GrowthBook 动态配置的每事件采样控制
 * - shutdown1PEventLogging(): 进程退出前强制刷新剩余事件
 */

import type { AnyValueMap, Logger, logs } from '@opentelemetry/api-logs'
import { resourceFromAttributes } from '@opentelemetry/resources'
import {
  BatchLogRecordProcessor,
  LoggerProvider,
} from '@opentelemetry/sdk-logs'
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions'
import { randomUUID } from 'crypto'
import { isEqual } from 'lodash-es'
import { getOrCreateUserID } from '../../utils/config.js'
import { logForDebugging } from '../../utils/debug.js'
import { logError } from '../../utils/log.js'
import { getPlatform, getWslVersion } from '../../utils/platform.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { profileCheckpoint } from '../../utils/startupProfiler.js'
import { getCoreUserData } from '../../utils/user.js'
import { isAnalyticsDisabled } from './config.js'
import { FirstPartyEventLoggingExporter } from './firstPartyEventLoggingExporter.js'
import type { GrowthBookUserAttributes } from './growthbook.js'
import { getDynamicConfig_CACHED_MAY_BE_STALE } from './growthbook.js'
import { getEventMetadata } from './metadata.js'
import { isSinkKilled } from './sinkKillswitch.js'

/**
 * 每事件采样配置类型
 *
 * 每个事件名映射到一个含 sample_rate（0~1）的对象。
 * 未在此配置中出现的事件以 100% 采样率上报（不降采样）。
 *
 * Configuration for sampling individual event types.
 * Each event name maps to an object containing sample_rate (0-1).
 * Events not in the config are logged at 100% rate.
 */
export type EventSamplingConfig = {
  [eventName: string]: {
    sample_rate: number
  }
}

// GrowthBook 动态配置键名，对应每事件采样率配置
const EVENT_SAMPLING_CONFIG_NAME = 'tengu_event_sampling_config'

/**
 * 从 GrowthBook 获取事件采样配置
 *
 * 使用缓存值（若可用），在后台异步刷新；
 * 若配置不存在则返回空对象（所有事件以 100% 率上报）。
 *
 * Get the event sampling configuration from GrowthBook.
 * Uses cached value if available, updates cache in background.
 */
export function getEventSamplingConfig(): EventSamplingConfig {
  return getDynamicConfig_CACHED_MAY_BE_STALE<EventSamplingConfig>(
    EVENT_SAMPLING_CONFIG_NAME,
    {},
  )
}

/**
 * 判断某事件是否应被采样上报
 *
 * 工作流程：
 * 1. 从 GrowthBook 获取采样配置
 * 2. 若该事件无配置，返回 null（上报全量）
 * 3. 验证 sample_rate 合法（0~1 之间的数字）
 * 4. sample_rate >= 1 → null（全量，无需注入 sample_rate 元数据）
 * 5. sample_rate <= 0 → 0（全部丢弃）
 * 6. 否则随机决策：< sample_rate 时返回 sample_rate（采样），否则返回 0（丢弃）
 *
 * Determine if an event should be sampled based on its sample rate.
 * Returns the sample rate if sampled, null if not sampled.
 *
 * @param eventName - Name of the event to check
 * @returns The sample_rate if event should be logged, null if it should be dropped
 */
export function shouldSampleEvent(eventName: string): number | null {
  const config = getEventSamplingConfig()
  const eventConfig = config[eventName]

  // 事件无配置：以 100% 率上报（不降采样，不注入 sample_rate 元数据）
  if (!eventConfig) {
    return null
  }

  const sampleRate = eventConfig.sample_rate

  // 验证 sample_rate 合法：必须是 0~1 范围内的数字，否则忽略配置
  if (typeof sampleRate !== 'number' || sampleRate < 0 || sampleRate > 1) {
    return null
  }

  // sample_rate >= 1：全量上报，无需注入 sample_rate 元数据
  if (sampleRate >= 1) {
    return null
  }

  // sample_rate <= 0：丢弃全部此类事件
  if (sampleRate <= 0) {
    return 0
  }

  // 随机决策：Math.random() < sampleRate 时采样（返回 sample_rate），否则丢弃（返回 0）
  return Math.random() < sampleRate ? sampleRate : 0
}

// GrowthBook 动态配置键名，对应 BatchLogRecordProcessor 配置
const BATCH_CONFIG_NAME = 'tengu_1p_event_batch_config'

/** 批处理器配置类型（所有字段均为可选，缺失时使用代码内置默认值） */
type BatchConfig = {
  scheduledDelayMillis?: number   // 批次发送间隔（毫秒）
  maxExportBatchSize?: number     // 每批最大条数
  maxQueueSize?: number           // 内存队列最大深度
  skipAuth?: boolean              // 是否跳过 OAuth 认证（测试用）
  maxAttempts?: number            // 最大重试次数
  path?: string                   // 自定义上报路径
  baseUrl?: string                // 自定义上报 base URL
}

/**
 * 从 GrowthBook 获取批处理器配置
 * 使用缓存值（若可用），配置缺失时返回空对象（使用代码内置默认值）
 */
function getBatchConfig(): BatchConfig {
  return getDynamicConfig_CACHED_MAY_BE_STALE<BatchConfig>(
    BATCH_CONFIG_NAME,
    {},
  )
}

// 模块级状态：仅供内部使用，不暴露为全局 OTel 状态
let firstPartyEventLogger: ReturnType<typeof logs.getLogger> | null = null
// 当前活跃的 LoggerProvider（管理 BatchLogRecordProcessor 的生命周期）
let firstPartyEventLoggerProvider: LoggerProvider | null = null
// 上次创建 provider 时使用的批处理配置（用于 reinitialize 时比较是否发生变更）
// Last batch config used to construct the provider — used by
// reinitialize1PEventLoggingIfConfigChanged to decide whether a rebuild is
// needed when GrowthBook refreshes.
let lastBatchConfig: BatchConfig | null = null

/**
 * 刷新并关闭 1P 事件日志 provider
 *
 * 必须在 gracefulShutdown() 中、process.exit() 之前调用。
 * 因为 forceExit() 会阻止 beforeExit 事件触发，必须在此显式刷新，确保所有未发送事件被导出。
 *
 * Flush and shutdown the 1P event logger.
 * This should be called as the final step before process exit to ensure
 * all events (including late ones from API responses) are exported.
 */
export async function shutdown1PEventLogging(): Promise<void> {
  if (!firstPartyEventLoggerProvider) {
    return
  }
  try {
    await firstPartyEventLoggerProvider.shutdown()
    if (process.env.USER_TYPE === 'ant') {
      logForDebugging('1P event logging: final shutdown complete')
    }
  } catch {
    // 忽略 shutdown 过程中的错误
  }
}

/**
 * 检查 1P 事件日志功能是否已启用
 *
 * 遵循与其他分析 sink 相同的禁用条件：
 * - 测试环境（NODE_ENV=test）
 * - 第三方云服务（Bedrock/Vertex/Foundry）
 * - 全局遥测禁用设置
 *
 * 注意：与 BigQuery 指标不同，事件日志不检查组织级别的 metrics opt-out API。
 * 遵循与 Statsig 事件日志相同的模式。
 *
 * Check if 1P event logging is enabled.
 * Respects the same opt-outs as other analytics sinks:
 * - Test environment
 * - Third-party cloud providers (Bedrock/Vertex)
 * - Global telemetry opt-outs
 * - Non-essential traffic disabled
 *
 * Note: Unlike BigQuery metrics, event logging does NOT check organization-level
 * metrics opt-out via API. It follows the same pattern as Statsig event logging.
 */
export function is1PEventLoggingEnabled(): boolean {
  // 遵循标准分析禁用条件（与 isAnalyticsDisabled() 一致）
  return !isAnalyticsDisabled()
}

/**
 * 异步富化并上报 1P 事件（内部实现）
 *
 * 工作流程：
 * 1. 从 getEventMetadata() 获取核心元数据（模型名、会话 ID、用户类型、环境上下文等）
 * 2. 构建 OTel AnyValueMap attributes（嵌套对象直接传入，无需 JSON 序列化）
 * 3. 附加 user_id（若可用）
 * 4. ant 用户额外输出调试日志
 * 5. 通过 firstPartyEventLogger.emit() 发送 OTel 日志记录
 * 6. 非 development 环境下吞掉异常（事件日志不应影响主流程）
 *
 * Log a 1st-party event for internal analytics (async version).
 * Events are batched and exported to /api/event_logging/batch
 *
 * This enriches the event with core metadata (model, session, env context, etc.)
 * at log time, similar to logEventToStatsig.
 *
 * @param eventName - Name of the event (e.g., 'tengu_api_query')
 * @param metadata - Additional metadata for the event (intentionally no strings, to avoid accidentally logging code/filepaths)
 */
async function logEventTo1PAsync(
  firstPartyEventLogger: Logger,
  eventName: string,
  metadata: Record<string, number | boolean | undefined> = {},
): Promise<void> {
  try {
    // 在上报时刻富化核心元数据（类似 Statsig 模式，确保元数据时效性）
    const coreMetadata = await getEventMetadata({
      model: metadata.model,
      betas: metadata.betas,
    })

    // 构建 OTel AnyValueMap attributes
    // 说明：嵌套对象直接传入，无需 JSON 序列化；使用 as unknown 绕过 TS 缺少 index signature 的限制
    const attributes = {
      event_name: eventName,
      event_id: randomUUID(),             // 每条事件分配唯一 UUID（用于去重和追踪）
      // Pass objects directly - no JSON serialization needed
      core_metadata: coreMetadata,        // 核心元数据（模型、会话、用户类型等）
      user_metadata: getCoreUserData(true), // 用户基础数据（account_uuid、org_uuid 等）
      event_metadata: metadata,           // 业务事件属性
    } as unknown as AnyValueMap

    // 附加 user_id（device ID，若可用）
    const userId = getOrCreateUserID()
    if (userId) {
      attributes.user_id = userId
    }

    // ant 用户额外输出调试日志
    if (process.env.USER_TYPE === 'ant') {
      logForDebugging(
        `[ANT-ONLY] 1P event: ${eventName} ${jsonStringify(metadata, null, 0)}`,
      )
    }

    // 发送 OTel 日志记录（由 BatchLogRecordProcessor 批量缓存并定时导出）
    firstPartyEventLogger.emit({
      body: eventName,
      attributes,
    })
  } catch (e) {
    if (process.env.NODE_ENV === 'development') {
      throw e  // 开发环境：抛出异常方便调试
    }
    if (process.env.USER_TYPE === 'ant') {
      logError(e as Error)  // ant 用户：记录错误日志
    }
    // swallow：生产环境下吞掉异常，事件日志不应影响主流程
  }
}

/**
 * 同步上报 1P 事件（公开接口）
 *
 * 采用 fire-and-forget 模式：触发异步富化+上报，不阻塞调用方。
 * 若 1P 日志未启用、logger 未初始化或 sink 已被 killswitch 关闭，则静默返回。
 *
 * NOTE: 应通过 src/services/analytics/sink.ts > logEventImpl() 调用，而非直接调用此函数
 *
 * Log a 1st-party event for internal analytics.
 * Events are batched and exported to /api/event_logging/batch
 *
 * @param eventName - Name of the event (e.g., 'tengu_api_query')
 * @param metadata - Additional metadata for the event (intentionally no strings, to avoid accidentally logging code/filepaths)
 */
export function logEventTo1P(
  eventName: string,
  metadata: Record<string, number | boolean | undefined> = {},
): void {
  if (!is1PEventLoggingEnabled()) {
    return
  }

  // logger 未初始化或 1P sink 已被 killswitch 远程关闭
  if (!firstPartyEventLogger || isSinkKilled('firstParty')) {
    return
  }

  // fire-and-forget：异步富化元数据并上报，不阻塞调用方
  void logEventTo1PAsync(firstPartyEventLogger, eventName, metadata)
}

/**
 * GrowthBook 实验分配事件的数据结构
 * 用于记录 A/B 实验曝光，以便在 Anthropic 内部系统中分析实验效果。
 */
export type GrowthBookExperimentData = {
  experimentId: string                          // 实验 ID
  variationId: number                           // 变体 ID（0 = control，1+ = variant）
  userAttributes?: GrowthBookUserAttributes     // 用户属性（可选，用于更细粒度分析）
  experimentMetadata?: Record<string, unknown>  // 实验额外元数据（可选）
}

/**
 * 获取 GrowthBook 环境名称
 *
 * api.anthropic.com 仅提供 "production" 环境的 GrowthBook 配置
 * （staging 和 development 环境不导出到生产 API）
 *
 * api.anthropic.com only serves the "production" GrowthBook environment
 * (see starling/starling/cli/cli.py DEFAULT_ENVIRONMENTS). Staging and
 * development environments are not exported to the prod API.
 */
function getEnvironmentForGrowthBook(): string {
  return 'production'
}

/**
 * 上报 GrowthBook 实验分配事件到 1P 日志
 *
 * 工作流程：
 * 1. 检查 1P 日志是否启用、logger 是否初始化、killswitch 是否触发
 * 2. 获取用户 ID 和账号信息（account_uuid、org_uuid）
 * 3. 构建 GrowthbookExperimentEvent 格式的 attributes
 * 4. ant 用户额外输出调试日志
 * 5. 通过 logger.emit() 发送记录（与普通事件共享 BatchLogRecordProcessor）
 *
 * Log a GrowthBook experiment assignment event to 1P.
 * Events are batched and exported to /api/event_logging/batch
 *
 * @param data - GrowthBook experiment assignment data
 */
export function logGrowthBookExperimentTo1P(
  data: GrowthBookExperimentData,
): void {
  if (!is1PEventLoggingEnabled()) {
    return
  }

  // logger 未初始化或 1P sink 已被 killswitch 远程关闭
  if (!firstPartyEventLogger || isSinkKilled('firstParty')) {
    return
  }

  const userId = getOrCreateUserID()
  const { accountUuid, organizationUuid } = getCoreUserData(true)

  // 构建 GrowthbookExperimentEvent 格式的 OTel attributes
  const attributes = {
    event_type: 'GrowthbookExperimentEvent',   // 标识事件类型（用于 exporter 路由到正确的 proto）
    event_id: randomUUID(),                     // 每条事件唯一 UUID
    experiment_id: data.experimentId,           // GrowthBook 实验 ID
    variation_id: data.variationId,             // 分配到的变体 ID
    ...(userId && { device_id: userId }),        // 设备 ID（用户匿名标识）
    ...(accountUuid && { account_uuid: accountUuid }),
    ...(organizationUuid && { organization_uuid: organizationUuid }),
    ...(data.userAttributes && {
      session_id: data.userAttributes.sessionId,
      user_attributes: jsonStringify(data.userAttributes),  // 序列化为 JSON 字符串
    }),
    ...(data.experimentMetadata && {
      experiment_metadata: jsonStringify(data.experimentMetadata),
    }),
    environment: getEnvironmentForGrowthBook(),  // 固定为 'production'
  }

  if (process.env.USER_TYPE === 'ant') {
    logForDebugging(
      `[ANT-ONLY] 1P GrowthBook experiment: ${data.experimentId} variation=${data.variationId}`,
    )
  }

  firstPartyEventLogger.emit({
    body: 'growthbook_experiment',  // 日志主体（用于 exporter 区分事件类型）
    attributes,
  })
}

// 默认批处理参数（在 GrowthBook 未提供配置时使用）
const DEFAULT_LOGS_EXPORT_INTERVAL_MS = 10000   // 批次发送间隔：10 秒
const DEFAULT_MAX_EXPORT_BATCH_SIZE = 200        // 每批最大条数：200 条
const DEFAULT_MAX_QUEUE_SIZE = 8192              // 内存队列最大深度：8192 条

/**
 * 初始化 1P 事件日志基础设施
 *
 * 工作流程：
 * 1. 记录性能检查点（用于启动性能分析）
 * 2. 检查是否应启用 1P 事件日志
 * 3. 从 GrowthBook 获取批处理配置（用缓存值，后台刷新）
 * 4. 计算各批处理参数（GrowthBook 配置 > 环境变量 > 代码内置默认值）
 * 5. 构建最小化的 OTel Resource（service.name、service.version，WSL 时附加 wsl.version）
 * 6. 创建 FirstPartyEventLoggingExporter 实例（HTTP 批量上传 + 磁盘重试队列）
 * 7. 创建 LoggerProvider 并注入 BatchLogRecordProcessor
 * 8. 从 LOCAL provider 获取 Logger（关键：不使用全局 OTel API，防止与客户 OTLP 混用）
 *
 * IMPORTANT: This creates a separate LoggerProvider for internal event logging,
 * independent of customer OTLP telemetry.
 *
 * This uses its own minimal resource configuration with just the attributes
 * we need for internal analytics (service name, version, platform info).
 */
export function initialize1PEventLogging(): void {
  profileCheckpoint('1p_event_logging_start')  // 记录启动性能检查点
  const enabled = is1PEventLoggingEnabled()

  if (!enabled) {
    if (process.env.USER_TYPE === 'ant') {
      logForDebugging('1P event logging not enabled')
    }
    return
  }

  // 从 GrowthBook 获取批处理器配置，并记录性能检查点
  const batchConfig = getBatchConfig()
  lastBatchConfig = batchConfig  // 保存配置快照，用于后续 reinitialize 时比较变更
  profileCheckpoint('1p_event_after_growthbook_config')

  // 计算批次发送间隔（GrowthBook > 环境变量 > 默认 10s）
  const scheduledDelayMillis =
    batchConfig.scheduledDelayMillis ||
    parseInt(
      process.env.OTEL_LOGS_EXPORT_INTERVAL ||
        DEFAULT_LOGS_EXPORT_INTERVAL_MS.toString(),
    )

  // 计算每批最大条数（GrowthBook > 默认 200 条）
  const maxExportBatchSize =
    batchConfig.maxExportBatchSize || DEFAULT_MAX_EXPORT_BATCH_SIZE

  // 计算内存队列最大深度（GrowthBook > 默认 8192 条）
  const maxQueueSize = batchConfig.maxQueueSize || DEFAULT_MAX_QUEUE_SIZE

  // 构建最小化的 OTel Resource（只包含内部分析所需属性）
  const platform = getPlatform()
  const attributes: Record<string, string> = {
    [ATTR_SERVICE_NAME]: 'claude-code',       // 服务名：固定为 'claude-code'
    [ATTR_SERVICE_VERSION]: MACRO.VERSION,    // 服务版本：编译时注入的版本号
  }

  // WSL 环境额外附加 wsl.version 属性
  if (platform === 'wsl') {
    const wslVersion = getWslVersion()
    if (wslVersion) {
      attributes['wsl.version'] = wslVersion
    }
  }

  const resource = resourceFromAttributes(attributes)

  // 创建 FirstPartyEventLoggingExporter
  // 通过 isKilled 回调实现运行时 killswitch 检查（每次导出前检查）
  const eventLoggingExporter = new FirstPartyEventLoggingExporter({
    maxBatchSize: maxExportBatchSize,
    skipAuth: batchConfig.skipAuth,
    maxAttempts: batchConfig.maxAttempts,
    path: batchConfig.path,
    baseUrl: batchConfig.baseUrl,
    isKilled: () => isSinkKilled('firstParty'),  // 运行时 killswitch 检查
  })

  // 创建 LoggerProvider，注入 BatchLogRecordProcessor
  // 关键：不调用 logs.setGlobalLoggerProvider()，保持与客户 OTLP 完全隔离
  firstPartyEventLoggerProvider = new LoggerProvider({
    resource,
    processors: [
      new BatchLogRecordProcessor(eventLoggingExporter, {
        scheduledDelayMillis,
        maxExportBatchSize,
        maxQueueSize,
      }),
    ],
  })

  // 从 LOCAL provider 获取 Logger（绝对不使用全局 logs.getLogger()）
  // 原因：logs.getLogger() 返回全局 provider 的 logger，该 provider 用于客户 OTLP 遥测，
  // 必须与内部分析 logger 完全隔离，防止内部事件泄漏到客户 OTLP 端点
  // Initialize event logger from our internal provider (NOT from global API)
  // IMPORTANT: We must get the logger from our local provider, not logs.getLogger()
  // because logs.getLogger() returns a logger from the global provider, which is
  // separate and used for customer telemetry.
  firstPartyEventLogger = firstPartyEventLoggerProvider.getLogger(
    'com.anthropic.claude_code.events',
    MACRO.VERSION,
  )
}

/**
 * 若批处理配置已变更，重建 1P 事件日志 pipeline
 *
 * 设计目的：注册到 GrowthBook 刷新回调，让长期运行的 session 自动拾取批次大小、
 * 发送延迟、上报端点等配置变更，无需重启进程。
 *
 * 事件丢失安全保证：
 * 1. 先置空 logger：并发的 logEventTo1P() 调用会命中 !firstPartyEventLogger 守卫并退出，
 *    避免向正在排空的旧 provider 继续写入（可能丢失少量事件，但防止双写）
 * 2. forceFlush() 排空旧 BatchLogRecordProcessor 缓冲区至 exporter
 *    导出失败的事件会写入磁盘（路径由 BATCH_UUID + sessionId 确定，reinit 前后不变），
 *    新 exporter 的磁盘重试机制会自动拾取这些事件
 * 3. 替换为新 provider/logger；旧 provider 在后台 shutdown()（buffer 已排空，只剩资源释放）
 *
 * Rebuild the 1P event logging pipeline if the batch config changed.
 * Register this with onGrowthBookRefresh so long-running sessions pick up
 * changes to batch size, delay, endpoint, etc.
 *
 * Event-loss safety:
 * 1. Null the logger first — concurrent logEventTo1P() calls hit the
 *    !firstPartyEventLogger guard and bail during the swap window. This drops
 *    a handful of events but prevents emitting to a draining provider.
 * 2. forceFlush() drains the old BatchLogRecordProcessor buffer to the
 *    exporter. Export failures go to disk at getCurrentBatchFilePath() which
 *    is keyed by module-level BATCH_UUID + sessionId — unchanged across
 *    reinit — so the NEW exporter's disk-backed retry picks them up.
 * 3. Swap to new provider/logger; old provider shutdown runs in background
 *    (buffer already drained, just cleanup).
 */
export async function reinitialize1PEventLoggingIfConfigChanged(): Promise<void> {
  // 未启用或未初始化则直接返回（无需 reinitialize）
  if (!is1PEventLoggingEnabled() || !firstPartyEventLoggerProvider) {
    return
  }

  const newConfig = getBatchConfig()

  // 配置未变更则直接返回（使用 lodash isEqual 做深比较）
  if (isEqual(newConfig, lastBatchConfig)) {
    return
  }

  if (process.env.USER_TYPE === 'ant') {
    logForDebugging(
      `1P event logging: ${BATCH_CONFIG_NAME} changed, reinitializing`,
    )
  }

  // 保存旧 provider/logger 引用，先置空模块级 logger（关键：防止并发写入旧 provider）
  const oldProvider = firstPartyEventLoggerProvider
  const oldLogger = firstPartyEventLogger
  firstPartyEventLogger = null  // 先置空，阻止 logEventTo1P() 在 swap 窗口期写入旧 provider

  // forceFlush：排空旧 BatchLogRecordProcessor 缓冲区（导出失败写磁盘，新 exporter 会重试）
  try {
    await oldProvider.forceFlush()
  } catch {
    // 导出失败：事件已持久化到磁盘，新 exporter 启动后会自动重试
  }

  // 置空旧 provider，触发重新初始化
  firstPartyEventLoggerProvider = null
  try {
    initialize1PEventLogging()  // 用新配置创建新 provider/logger
  } catch (e) {
    // 初始化失败时恢复旧 provider/logger，避免 logger 和 provider 同时为 null
    // 原因：若两者都为 null，顶部的 !firstPartyEventLoggerProvider 守卫会阻止后续重试
    // Restore so the next GrowthBook refresh can retry. oldProvider was
    // only forceFlush()'d, not shut down — it's still functional. Without
    // this, both stay null and the !firstPartyEventLoggerProvider gate at
    // the top makes recovery impossible.
    firstPartyEventLoggerProvider = oldProvider
    firstPartyEventLogger = oldLogger
    logError(e)
    return
  }

  // 旧 provider 在后台 shutdown（buffer 已排空，此处只做资源释放）
  void oldProvider.shutdown().catch(() => {})
}
