/**
 * 【分析事件公共 API 入口模块】analytics/index.ts
 *
 * 在 Claude Code 系统流程中的位置：
 * - 这是分析（analytics）子系统的公共接口层，是所有业务代码调用分析功能的唯一入口
 * - 为避免循环依赖，本模块不依赖任何其他模块（零依赖设计）
 * - 在 app 启动时由 sink.ts 的 initializeAnalyticsSink() 通过 attachAnalyticsSink() 注入真正的分析后端
 * - 在 sink 挂载之前产生的所有事件会被暂存到 eventQueue，等 sink 就绪后批量排放
 *
 * 核心功能：
 * - AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS: 类型安全标记，防止代码/路径误入日志
 * - AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED: 类型安全标记，标识经 _PROTO_* 路由的 PII 字段
 * - stripProtoFields(): 在分发给非 1P（Datadog 等通用存储）前剥离 _PROTO_* 键
 * - attachAnalyticsSink(): 挂载分析后端，幂等操作，同时排放积压队列
 * - logEvent() / logEventAsync(): 同步/异步事件上报，sink 未就绪时自动入队
 * - _resetForTesting(): 测试专用重置函数
 *
 * Analytics service - public API for event logging
 *
 * This module serves as the main entry point for analytics events in Claude CLI.
 *
 * DESIGN: This module has NO dependencies to avoid import cycles.
 * Events are queued until attachAnalyticsSink() is called during app initialization.
 * The sink handles routing to Datadog and 1P event logging.
 */

/**
 * 分析元数据安全性标记类型
 *
 * 该类型是一个 never 类型标记，强制调用者在将字符串值传入日志时
 * 显式断言该字符串不包含代码片段、文件路径或其他敏感信息。
 *
 * 用法：`myString as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS`
 *
 * Marker type for verifying analytics metadata doesn't contain sensitive data
 *
 * This type forces explicit verification that string values being logged
 * don't contain code snippets, file paths, or other sensitive information.
 *
 * Usage: `myString as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS`
 */
export type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS = never

/**
 * PII 标记字段的类型标记
 *
 * 该 never 类型用于标识通过 _PROTO_* 键路由到特权 BigQuery 列的 PII 数据。
 * 目标 BQ 列有特殊访问控制，因此允许存放未脱敏的值（不同于通用存储后端）。
 *
 * sink.ts 在分发给 Datadog 前会剥离 _PROTO_* 键；
 * 只有 1P exporter (firstPartyEventLoggingExporter) 能看到这些键，
 * 并将其提升为顶层 proto 字段。
 *
 * Marker type for values routed to PII-tagged proto columns via `_PROTO_*`
 * payload keys. The destination BQ column has privileged access controls,
 * so unredacted values are acceptable — unlike general-access backends.
 *
 * sink.ts strips `_PROTO_*` keys before Datadog fanout; only the 1P
 * exporter (firstPartyEventLoggingExporter) sees them and hoists them to the
 * top-level proto field. A single stripProtoFields call guards all non-1P
 * sinks — no per-sink filtering to forget.
 *
 * Usage: `rawName as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED`
 */
export type AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED = never

/**
 * 从元数据中剥离所有 _PROTO_* 键，用于发往通用存储（如 Datadog）前净化 payload
 *
 * 调用场景：
 * - sink.ts：在分发给 Datadog 前调用，确保 Datadog 永远看不到 PII 标记值
 * - firstPartyEventLoggingExporter：在已将已知 _PROTO_* 键提升到 proto 字段后，
 *   对 additional_metadata 进行防御性剥离，防止未知的 _PROTO_foo 悄悄进入 BQ JSON blob
 *
 * 优化：若 payload 中不含 _PROTO_* 键，直接返回原引用（避免不必要的对象拷贝）
 *
 * Strip `_PROTO_*` keys from a payload destined for general-access storage.
 * Used by:
 *   - sink.ts: before Datadog fanout (never sees PII-tagged values)
 *   - firstPartyEventLoggingExporter: defensive strip of additional_metadata
 *     after hoisting known _PROTO_* keys to proto fields — prevents a future
 *     unrecognized _PROTO_foo from silently landing in the BQ JSON blob.
 *
 * Returns the input unchanged (same reference) when no _PROTO_ keys present.
 */
export function stripProtoFields<V>(
  metadata: Record<string, V>,
): Record<string, V> {
  let result: Record<string, V> | undefined
  for (const key in metadata) {
    // 发现 _PROTO_* 键时才创建浅拷贝，避免无谓的对象分配
    if (key.startsWith('_PROTO_')) {
      if (result === undefined) {
        result = { ...metadata }
      }
      delete result[key]
    }
  }
  // 若 result 从未被赋值（无 _PROTO_* 键），返回原始引用
  return result ?? metadata
}

// 事件元数据的内部类型定义（与 metadata.ts 中的 EventMetadata 不同，这是未经富化的原始 metadata）
type LogEventMetadata = { [key: string]: boolean | number | undefined }

// 积压事件类型，包含事件名、元数据和是否为异步调用的标记
type QueuedEvent = {
  eventName: string
  metadata: LogEventMetadata
  async: boolean
}

/**
 * 分析后端 sink 接口定义
 *
 * 实现此接口的模块（即 sink.ts）负责将事件路由到 Datadog 和 1P 事件日志
 */
export type AnalyticsSink = {
  logEvent: (eventName: string, metadata: LogEventMetadata) => void
  logEventAsync: (
    eventName: string,
    metadata: LogEventMetadata,
  ) => Promise<void>
}

// sink 挂载前的事件积压队列（在 app 初始化之前记录的所有事件都暂存于此）
const eventQueue: QueuedEvent[] = []

// 当前挂载的分析 sink，在 app 启动时由 initializeAnalyticsSink() 注入
let sink: AnalyticsSink | null = null

/**
 * 挂载分析后端 sink，接收所有待上报的事件
 *
 * 工作流程：
 * 1. 幂等检测：若已有 sink，直接返回（允许从 preAction hook 和 setup() 重复调用）
 * 2. 将 newSink 赋值给模块级 sink 变量
 * 3. 若队列中存在积压事件，通过 queueMicrotask 异步排放（避免阻塞启动路径）
 * 4. ant 用户额外记录 analytics_sink_attached 事件，携带积压队列长度用于调试
 *
 * Attach the analytics sink that will receive all events.
 * Queued events are drained asynchronously via queueMicrotask to avoid
 * adding latency to the startup path.
 *
 * Idempotent: if a sink is already attached, this is a no-op. This allows
 * calling from both the preAction hook (for subcommands) and setup() (for
 * the default command) without coordination.
 */
export function attachAnalyticsSink(newSink: AnalyticsSink): void {
  // 幂等：已有 sink 时直接返回，防止多次调用覆盖 sink
  if (sink !== null) {
    return
  }
  sink = newSink

  // 若积压队列中有事件，异步排放以避免阻塞启动路径
  if (eventQueue.length > 0) {
    const queuedEvents = [...eventQueue]
    eventQueue.length = 0 // 立即清空队列，防止并发写入

    // ant 用户额外记录 analytics_sink_attached，携带队列大小用于调试分析初始化时序
    if (process.env.USER_TYPE === 'ant') {
      sink.logEvent('analytics_sink_attached', {
        queued_event_count: queuedEvents.length,
      })
    }

    // 通过 queueMicrotask 在当前同步代码完成后再排放积压事件
    queueMicrotask(() => {
      for (const event of queuedEvents) {
        if (event.async) {
          void sink!.logEventAsync(event.eventName, event.metadata)
        } else {
          sink!.logEvent(event.eventName, event.metadata)
        }
      }
    })
  }
}

/**
 * 同步上报分析事件
 *
 * 事件可能被采样（基于 GrowthBook 动态配置 'tengu_event_sampling_config'）。
 * 若被采样，sample_rate 会被追加到事件元数据中。
 *
 * 若 sink 尚未挂载，事件会被加入积压队列，等 sink 挂载时批量排放。
 *
 * Log an event to analytics backends (synchronous)
 *
 * Events may be sampled based on the 'tengu_event_sampling_config' dynamic config.
 * When sampled, the sample_rate is added to the event metadata.
 *
 * If no sink is attached, events are queued and drained when the sink attaches.
 */
export function logEvent(
  eventName: string,
  // intentionally no strings unless AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  // to avoid accidentally logging code/filepaths
  metadata: LogEventMetadata,
): void {
  if (sink === null) {
    // sink 未就绪时入队，标记为同步事件
    eventQueue.push({ eventName, metadata, async: false })
    return
  }
  sink.logEvent(eventName, metadata)
}

/**
 * 异步上报分析事件
 *
 * 与 logEvent 的区别：返回 Promise，调用方可等待上报完成（如关键路径上的事件）。
 * 若 sink 尚未挂载，事件会被加入积压队列，等 sink 挂载时批量排放。
 *
 * Log an event to analytics backends (asynchronous)
 *
 * Events may be sampled based on the 'tengu_event_sampling_config' dynamic config.
 * When sampled, the sample_rate is added to the event metadata.
 *
 * If no sink is attached, events are queued and drained when the sink attaches.
 */
export async function logEventAsync(
  eventName: string,
  // intentionally no strings, to avoid accidentally logging code/filepaths
  metadata: LogEventMetadata,
): Promise<void> {
  if (sink === null) {
    // sink 未就绪时入队，标记为异步事件
    eventQueue.push({ eventName, metadata, async: true })
    return
  }
  await sink.logEventAsync(eventName, metadata)
}

/**
 * 重置分析状态（仅供测试使用）
 *
 * 清空 sink 引用和积压队列，使模块回到初始状态。
 * 避免测试用例之间互相污染分析状态。
 *
 * Reset analytics state for testing purposes only.
 * @internal
 */
export function _resetForTesting(): void {
  sink = null
  eventQueue.length = 0
}
