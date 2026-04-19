/**
 * 【分析事件路由 Sink 实现模块】analytics/sink.ts
 *
 * 在 Claude Code 系统流程中的位置：
 * - 属于分析（analytics）子系统的实际路由层，是 index.ts 公共 API 与 Datadog/1P 后端之间的桥梁
 * - 在 app 启动时（setupBackend()）由 main.tsx 调用 initializeAnalyticsSink() 挂载到 index.ts
 * - 所有由 index.ts 的 logEvent()/logEventAsync() 上报的事件最终流经此模块
 * - 依赖 growthbook.ts 的 checkStatsigFeatureGate_CACHED_MAY_BE_STALE() 判断 Datadog 通道是否启用
 *
 * 核心功能：
 * - shouldTrackDatadog(): 检查熔断开关 + GrowthBook feature gate，决定是否将事件发往 Datadog
 * - logEventImpl(): 核心路由逻辑；先检查采样，再分别发往 Datadog（剥离 _PROTO_* 后）和 1P（完整 payload）
 * - logEventAsyncImpl(): 同步路由的异步包装（因两个后端均为 fire-and-forget，本质上只调用同步实现）
 * - initializeAnalyticsGates(): 启动时更新 GrowthBook gate 缓存值（早期事件使用上次会话的缓存值，避免丢失）
 * - initializeAnalyticsSink(): 将本模块的路由实现挂载到 index.ts 的 sink 插槽
 *
 * Analytics sink implementation
 *
 * This module contains the actual analytics routing logic and should be
 * initialized during app startup. It routes events to Datadog and 1P event
 * logging.
 *
 * Usage: Call initializeAnalyticsSink() during app startup to attach the sink.
 */

import { trackDatadogEvent } from './datadog.js'
import { logEventTo1P, shouldSampleEvent } from './firstPartyEventLogger.js'
import { checkStatsigFeatureGate_CACHED_MAY_BE_STALE } from './growthbook.js'
import { attachAnalyticsSink, stripProtoFields } from './index.js'
import { isSinkKilled } from './sinkKillswitch.js'

// 本地事件元数据类型，与 logEvent 的参数类型对齐
type LogEventMetadata = { [key: string]: boolean | number | undefined }

// GrowthBook feature gate 名称（混淆后），控制 Datadog 事件上报是否启用
const DATADOG_GATE_NAME = 'tengu_log_datadog_events'

// 模块级 gate 状态缓存：undefined = 未初始化，boolean = 已从 GrowthBook 获取到值
let isDatadogGateEnabled: boolean | undefined = undefined

/**
 * 检查 Datadog 通道是否应上报事件
 *
 * 判断顺序：
 * 1. 若熔断开关（sinkKillswitch）已将 datadog 通道关闭，立即返回 false
 * 2. 若模块级缓存已初始化（isDatadogGateEnabled !== undefined），直接使用缓存值
 * 3. 回退到磁盘缓存的上次会话值（适用于 initializeAnalyticsGates() 尚未被调用的早期阶段）
 *
 * Check if Datadog tracking is enabled.
 * Falls back to cached value from previous session if not yet initialized.
 */
function shouldTrackDatadog(): boolean {
  // 首先检查熔断开关，紧急情况下可远程关闭 datadog 通道
  if (isSinkKilled('datadog')) {
    return false
  }
  // 已初始化则使用内存缓存值（最快路径）
  if (isDatadogGateEnabled !== undefined) {
    return isDatadogGateEnabled
  }

  // 回退到上次会话的磁盘缓存值，避免初始化阶段因 gate 未就绪而丢失事件
  try {
    return checkStatsigFeatureGate_CACHED_MAY_BE_STALE(DATADOG_GATE_NAME)
  } catch {
    return false
  }
}

/**
 * 事件路由核心实现（同步）
 *
 * 工作流程：
 * 1. 通过 shouldSampleEvent() 检查事件是否被采样：
 *    - 返回 0：事件被丢弃，不上报任何后端
 *    - 返回正数 sample_rate：将采样率追加到 metadata
 *    - 返回 null：不受采样控制，原样上报
 * 2. 若 Datadog 通道启用：剥离 _PROTO_* 键后调用 trackDatadogEvent()
 *    （Datadog 是通用存储后端，不应接收 PII 标记字段）
 * 3. 无论 Datadog 是否启用，总是向 1P 发送完整 payload（含 _PROTO_* 键，
 *    由 firstPartyEventLoggingExporter 负责将其路由到特权 BQ 列）
 *
 * Log an event (synchronous implementation)
 */
function logEventImpl(eventName: string, metadata: LogEventMetadata): void {
  // 检查此事件是否应该被采样（由 GrowthBook 动态配置控制）
  const sampleResult = shouldSampleEvent(eventName)

  // sample_rate 为 0 表示本次调用中此事件被丢弃，不上报任何后端
  if (sampleResult === 0) {
    return
  }

  // 若 sampleResult 不为 null（即启用了采样），将采样率追加到 metadata 便于后端统计
  const metadataWithSampleRate =
    sampleResult !== null
      ? { ...metadata, sample_rate: sampleResult }
      : metadata

  if (shouldTrackDatadog()) {
    // Datadog 是通用存储后端 — 在发送前剥离 _PROTO_* 键
    // （这些键包含仅供 1P 特权列使用的未脱敏 PII 值）
    void trackDatadogEvent(eventName, stripProtoFields(metadataWithSampleRate))
  }

  // 1P 接收完整 payload（含 _PROTO_* 键）
  // exporter 内部会将这些键解构并路由到 proto 字段
  logEventTo1P(eventName, metadataWithSampleRate)
}

/**
 * 事件路由异步包装（保持 sink 接口契约）
 *
 * Segment 移除后，剩余的两个 sink（Datadog + 1P）均为 fire-and-forget，
 * 因此本函数只是对同步实现的包装，保持 AnalyticsSink 接口的完整性。
 *
 * Log an event (asynchronous implementation)
 *
 * With Segment removed the two remaining sinks are fire-and-forget, so this
 * just wraps the sync impl — kept to preserve the sink interface contract.
 */
function logEventAsyncImpl(
  eventName: string,
  metadata: LogEventMetadata,
): Promise<void> {
  logEventImpl(eventName, metadata)
  return Promise.resolve()
}

/**
 * 在 app 启动时初始化 GrowthBook gate 缓存值
 *
 * 从服务器更新 gate 值并存入模块级变量 isDatadogGateEnabled。
 * 早期事件（initializeAnalyticsGates() 调用前）使用上次会话的磁盘缓存值，
 * 保证不丢失初始化阶段产生的事件。
 *
 * 调用时机：main.tsx 的 setupBackend() 中调用。
 *
 * Initialize analytics gates during startup.
 *
 * Updates gate values from server. Early events use cached values from previous
 * session to avoid data loss during initialization.
 *
 * Called from main.tsx during setupBackend().
 */
export function initializeAnalyticsGates(): void {
  isDatadogGateEnabled =
    checkStatsigFeatureGate_CACHED_MAY_BE_STALE(DATADOG_GATE_NAME)
}

/**
 * 初始化并挂载分析 sink
 *
 * 将本模块的路由实现（logEventImpl + logEventAsyncImpl）包装成 AnalyticsSink，
 * 通过 attachAnalyticsSink() 注入到 index.ts 的 sink 插槽。
 * 此后所有通过 index.ts 上报的事件都会流经本模块进行路由。
 *
 * 幂等：可安全多次调用（后续调用为空操作）。
 *
 * Initialize the analytics sink.
 *
 * Call this during app startup to attach the analytics backend.
 * Any events logged before this is called will be queued and drained.
 *
 * Idempotent: safe to call multiple times (subsequent calls are no-ops).
 */
export function initializeAnalyticsSink(): void {
  attachAnalyticsSink({
    logEvent: logEventImpl,
    logEventAsync: logEventAsyncImpl,
  })
}
