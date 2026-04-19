/**
 * 【分析 Sink 熔断开关模块】analytics/sinkKillswitch.ts
 *
 * 在 Claude Code 系统流程中的位置：
 * - 属于分析（analytics）子系统的远程控制层
 * - 被 analytics/sink.ts 在每次分发事件时调用，用于按 sink 粒度关闭数据上报
 * - 依赖 GrowthBook 动态配置（analytics/growthbook.ts）读取远端开关状态
 *
 * 核心功能：
 * - isSinkKilled(sink): 通过 GrowthBook 检查特定分析通道（datadog 或 firstParty）是否被远程关闭
 * - 支持在不发版的情况下快速切断指定数据上报通道（紧急情况下的远程开关）
 *
 * 注意：不得在 is1PEventLoggingEnabled() 内部调用此函数，否则会与 GrowthBook 初始化产生递归调用。
 */

import { getDynamicConfig_CACHED_MAY_BE_STALE } from './growthbook.js'

// 混淆后的 GrowthBook 配置键名，对应 per-sink 熔断开关的配置项
// Mangled name: per-sink analytics killswitch
const SINK_KILLSWITCH_CONFIG_NAME = 'tengu_frond_boric'

/** 分析通道名称：datadog（Datadog 日志）或 firstParty（Anthropic 1P 事件日志） */
export type SinkName = 'datadog' | 'firstParty'

/**
 * 检查指定的分析通道（sink）是否已被远程熔断开关关闭
 *
 * 工作流程：
 * 1. 从 GrowthBook 缓存中读取熔断配置（JSON 对象，键为 sink 名称，值为 boolean）
 * 2. 若配置中对应 sink 的值为 true，则返回 true（该通道已被关闭）
 * 3. 若配置缺失或格式错误，默认返回 false（fail-open：保持通道开启）
 *
 * GrowthBook JSON config that disables individual analytics sinks.
 * Shape: { datadog?: boolean, firstParty?: boolean }
 * A value of true for a key stops all dispatch to that sink.
 * Default {} (nothing killed). Fail-open: missing/malformed config = sink stays on.
 *
 * NOTE: Must NOT be called from inside is1PEventLoggingEnabled() -
 * growthbook.ts:isGrowthBookEnabled() calls that, so a lookup here would recurse.
 * Call at per-event dispatch sites instead.
 */
export function isSinkKilled(sink: SinkName): boolean {
  // 从 GrowthBook 本地缓存读取熔断配置，默认值为空对象（不关闭任何通道）
  const config = getDynamicConfig_CACHED_MAY_BE_STALE<
    Partial<Record<SinkName, boolean>>
  >(SINK_KILLSWITCH_CONFIG_NAME, {})
  // 注意：getDynamicConfig_CACHED_MAY_BE_STALE 仅对 undefined 使用默认值，
  // 若缓存中存储了 JSON null，则 config 为 null 而非 {}，需用 ?. 安全访问
  // getFeatureValue_CACHED_MAY_BE_STALE guards on `!== undefined`, so a
  // cached JSON null leaks through instead of falling back to {}.
  return config?.[sink] === true
}
