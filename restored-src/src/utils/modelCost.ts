/**
 * 【文件定位】模型费用计算模块 — Claude Code 系统流程中的成本核算层
 *
 * 在 Claude Code 的整体架构中，本文件处于"API 调用后处理"环节：
 *   用户请求 → 主循环 → Anthropic API 调用 → [本模块] → 费用统计 → UI 展示
 *
 * 主要职责：
 *   1. 维护各 Claude 模型的最新官方定价常量（按百万 token 计价，USD）
 *   2. 将 Anthropic SDK 返回的 Usage 对象转换为实际美元花费
 *   3. 提供"未知模型"兜底处理，并通过 Analytics 埋点追踪
 *   4. 格式化价格字符串，用于在 UI 层向用户展示模型定价信息
 *
 * 定价数据来源：https://platform.claude.com/docs/en/about-claude/pricing
 */

import type { BetaUsage as Usage } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import type { AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from 'src/services/analytics/index.js'
import { logEvent } from 'src/services/analytics/index.js'
import { setHasUnknownModelCost } from '../bootstrap/state.js'
import { isFastModeEnabled } from './fastMode.js'
import {
  CLAUDE_3_5_HAIKU_CONFIG,
  CLAUDE_3_5_V2_SONNET_CONFIG,
  CLAUDE_3_7_SONNET_CONFIG,
  CLAUDE_HAIKU_4_5_CONFIG,
  CLAUDE_OPUS_4_1_CONFIG,
  CLAUDE_OPUS_4_5_CONFIG,
  CLAUDE_OPUS_4_6_CONFIG,
  CLAUDE_OPUS_4_CONFIG,
  CLAUDE_SONNET_4_5_CONFIG,
  CLAUDE_SONNET_4_6_CONFIG,
  CLAUDE_SONNET_4_CONFIG,
} from './model/configs.js'
import {
  firstPartyNameToCanonical,
  getCanonicalName,
  getDefaultMainLoopModelSetting,
  type ModelShortName,
} from './model/model.js'

// @see https://platform.claude.com/docs/en/about-claude/pricing
// 每种 token 类型对应的每百万 token 单价（USD）
export type ModelCosts = {
  inputTokens: number           // 输入 token 单价（$/Mtok）
  outputTokens: number          // 输出 token 单价（$/Mtok）
  promptCacheWriteTokens: number // 提示缓存写入单价（$/Mtok）
  promptCacheReadTokens: number  // 提示缓存读取单价（$/Mtok）
  webSearchRequests: number      // 网络搜索单价（$/次）
}

// Sonnet 系列标准定价档：输入 $3 / 输出 $15（每百万 token）
export const COST_TIER_3_15 = {
  inputTokens: 3,
  outputTokens: 15,
  promptCacheWriteTokens: 3.75,
  promptCacheReadTokens: 0.3,
  webSearchRequests: 0.01,
} as const satisfies ModelCosts

// Opus 4/4.1 高性能定价档：输入 $15 / 输出 $75（每百万 token）
export const COST_TIER_15_75 = {
  inputTokens: 15,
  outputTokens: 75,
  promptCacheWriteTokens: 18.75,
  promptCacheReadTokens: 1.5,
  webSearchRequests: 0.01,
} as const satisfies ModelCosts

// Opus 4.5 中间定价档：输入 $5 / 输出 $25（每百万 token）
export const COST_TIER_5_25 = {
  inputTokens: 5,
  outputTokens: 25,
  promptCacheWriteTokens: 6.25,
  promptCacheReadTokens: 0.5,
  webSearchRequests: 0.01,
} as const satisfies ModelCosts

// Opus 4.6 快速模式（Fast Mode）专用高价档：输入 $30 / 输出 $150（每百万 token）
export const COST_TIER_30_150 = {
  inputTokens: 30,
  outputTokens: 150,
  promptCacheWriteTokens: 37.5,
  promptCacheReadTokens: 3,
  webSearchRequests: 0.01,
} as const satisfies ModelCosts

// Haiku 3.5 轻量级定价档：输入 $0.80 / 输出 $4（每百万 token）
export const COST_HAIKU_35 = {
  inputTokens: 0.8,
  outputTokens: 4,
  promptCacheWriteTokens: 1,
  promptCacheReadTokens: 0.08,
  webSearchRequests: 0.01,
} as const satisfies ModelCosts

// Haiku 4.5 定价档：输入 $1 / 输出 $5（每百万 token）
export const COST_HAIKU_45 = {
  inputTokens: 1,
  outputTokens: 5,
  promptCacheWriteTokens: 1.25,
  promptCacheReadTokens: 0.1,
  webSearchRequests: 0.01,
} as const satisfies ModelCosts

// 当模型无法匹配到已知定价时使用的默认兜底定价（与 Opus 4.5 相同）
const DEFAULT_UNKNOWN_MODEL_COST = COST_TIER_5_25

/**
 * 根据 Fast Mode 状态获取 Opus 4.6 的定价档位。
 *
 * 流程：
 *   - 若全局 Fast Mode 已启用 且 本次请求也使用了 fast 速度 → 返回高价档 $30/$150
 *   - 否则返回普通档 $5/$25
 *
 * @param fastMode - 本次请求是否启用了 fast 速度
 * @returns 对应的定价对象
 */
export function getOpus46CostTier(fastMode: boolean): ModelCosts {
  // 同时检查全局功能开关和当前请求的速度标志
  if (isFastModeEnabled() && fastMode) {
    return COST_TIER_30_150
  }
  return COST_TIER_5_25
}

// @[MODEL LAUNCH]: 新模型上线时在此处追加定价记录
// 费用数据来源：https://platform.claude.com/docs/en/about-claude/pricing
// 网络搜索费用：$10/1000 次请求 = $0.01/次
// 使用规范化的短名称（ModelShortName）作为 key，保证跨 API 格式兼容
export const MODEL_COSTS: Record<ModelShortName, ModelCosts> = {
  [firstPartyNameToCanonical(CLAUDE_3_5_HAIKU_CONFIG.firstParty)]:
    COST_HAIKU_35,
  [firstPartyNameToCanonical(CLAUDE_HAIKU_4_5_CONFIG.firstParty)]:
    COST_HAIKU_45,
  [firstPartyNameToCanonical(CLAUDE_3_5_V2_SONNET_CONFIG.firstParty)]:
    COST_TIER_3_15,
  [firstPartyNameToCanonical(CLAUDE_3_7_SONNET_CONFIG.firstParty)]:
    COST_TIER_3_15,
  [firstPartyNameToCanonical(CLAUDE_SONNET_4_CONFIG.firstParty)]:
    COST_TIER_3_15,
  [firstPartyNameToCanonical(CLAUDE_SONNET_4_5_CONFIG.firstParty)]:
    COST_TIER_3_15,
  [firstPartyNameToCanonical(CLAUDE_SONNET_4_6_CONFIG.firstParty)]:
    COST_TIER_3_15,
  [firstPartyNameToCanonical(CLAUDE_OPUS_4_CONFIG.firstParty)]: COST_TIER_15_75,
  [firstPartyNameToCanonical(CLAUDE_OPUS_4_1_CONFIG.firstParty)]:
    COST_TIER_15_75,
  [firstPartyNameToCanonical(CLAUDE_OPUS_4_5_CONFIG.firstParty)]:
    COST_TIER_5_25,
  [firstPartyNameToCanonical(CLAUDE_OPUS_4_6_CONFIG.firstParty)]:
    COST_TIER_5_25,
}

/**
 * 将 token 用量转换为 USD 花费（核心计算函数）。
 *
 * 计算公式（各项独立计费后求和）：
 *   花费 = (输入token / 1,000,000) × 输入单价
 *         + (输出token / 1,000,000) × 输出单价
 *         + (缓存读取token / 1,000,000) × 缓存读取单价
 *         + (缓存创建token / 1,000,000) × 缓存写入单价
 *         + 网络搜索次数 × 每次单价
 *
 * @param modelCosts - 对应模型的定价对象
 * @param usage - Anthropic SDK 返回的 token 用量数据
 * @returns 本次调用的美元花费
 */
function tokensToUSDCost(modelCosts: ModelCosts, usage: Usage): number {
  return (
    // 标准输入 token 费用
    (usage.input_tokens / 1_000_000) * modelCosts.inputTokens +
    // 标准输出 token 费用
    (usage.output_tokens / 1_000_000) * modelCosts.outputTokens +
    // 提示缓存读取费用（命中缓存时触发，费用更低）
    ((usage.cache_read_input_tokens ?? 0) / 1_000_000) *
      modelCosts.promptCacheReadTokens +
    // 提示缓存写入费用（首次创建缓存时触发，略高于输入价）
    ((usage.cache_creation_input_tokens ?? 0) / 1_000_000) *
      modelCosts.promptCacheWriteTokens +
    // 网络搜索工具调用费用（按请求次数计费）
    (usage.server_tool_use?.web_search_requests ?? 0) *
      modelCosts.webSearchRequests
  )
}

/**
 * 根据模型名称和用量数据获取对应定价对象。
 *
 * 处理流程：
 *   1. 将模型完整名称转换为规范短名称（兼容 Bedrock/Vertex 前缀格式）
 *   2. 特判 Opus 4.6：根据 usage.speed 字段决定是否使用快速档定价
 *   3. 在 MODEL_COSTS 字典中查找定价
 *   4. 未找到时触发埋点上报，并降级使用默认主循环模型定价或兜底值
 *
 * @param model - 模型完整名称（如 "claude-opus-4-6-20251101"）
 * @param usage - 用量数据，用于判断速度模式
 * @returns 对应的定价对象
 */
export function getModelCosts(model: string, usage: Usage): ModelCosts {
  // 将各种格式的模型名统一转为内部规范短名（如 "claude-opus-4-6"）
  const shortName = getCanonicalName(model)

  // Opus 4.6 存在双价档，需根据本次请求的速度模式动态选择
  if (
    shortName === firstPartyNameToCanonical(CLAUDE_OPUS_4_6_CONFIG.firstParty)
  ) {
    // usage.speed === 'fast' 表示本次使用了扩展思考的快速模式
    const isFastMode = usage.speed === 'fast'
    return getOpus46CostTier(isFastMode)
  }

  // 从静态定价表中查找
  const costs = MODEL_COSTS[shortName]
  if (!costs) {
    // 未知模型：上报 Analytics 并返回降级定价
    trackUnknownModelCost(model, shortName)
    return (
      // 优先使用当前主循环模型的定价作为近似值
      MODEL_COSTS[getCanonicalName(getDefaultMainLoopModelSetting())] ??
      // 终极兜底值
      DEFAULT_UNKNOWN_MODEL_COST
    )
  }
  return costs
}

/**
 * 追踪未知模型费用事件（用于监控新模型上线后是否遗漏定价配置）。
 *
 * 操作：
 *   1. 通过 logEvent 向 Analytics 上报模型名称
 *   2. 在全局状态中标记"存在未知模型费用"，供 UI 层展示提示
 */
function trackUnknownModelCost(model: string, shortName: ModelShortName): void {
  // 上报未知模型信息，用于后台监控和告警
  logEvent('tengu_unknown_model_cost', {
    model: model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    shortName:
      shortName as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  })
  // 在全局 bootstrap 状态中置位，供 UI 展示"含未知模型费用"警告
  setHasUnknownModelCost()
}

/**
 * 计算一次 API 调用的总 USD 花费（对外主要入口）。
 *
 * 流程：getModelCosts → tokensToUSDCost
 * 若模型定价未知，自动降级到默认模型定价。
 *
 * @param resolvedModel - 已解析的模型名称
 * @param usage - Anthropic SDK 返回的 token 用量对象
 * @returns 美元花费（浮点数）
 */
export function calculateUSDCost(resolvedModel: string, usage: Usage): number {
  const modelCosts = getModelCosts(resolvedModel, usage)
  return tokensToUSDCost(modelCosts, usage)
}

/**
 * 从原始 token 计数计算费用（无需完整 BetaUsage 对象的轻量版本）。
 *
 * 适用场景：分类器等侧路请求独立追踪 token 计数时使用，
 * 这些场景中没有完整的 Anthropic SDK 响应对象，只有聚合后的 token 数字。
 *
 * @param model - 模型名称
 * @param tokens - 各类型 token 的原始计数
 * @returns 美元花费
 */
export function calculateCostFromTokens(
  model: string,
  tokens: {
    inputTokens: number
    outputTokens: number
    cacheReadInputTokens: number
    cacheCreationInputTokens: number
  },
): number {
  // 将结构化 token 计数包装成 SDK Usage 格式，复用主计算逻辑
  const usage: Usage = {
    input_tokens: tokens.inputTokens,
    output_tokens: tokens.outputTokens,
    cache_read_input_tokens: tokens.cacheReadInputTokens,
    cache_creation_input_tokens: tokens.cacheCreationInputTokens,
  } as Usage
  return calculateUSDCost(model, usage)
}

/**
 * 将价格数字格式化为带 $ 符号的字符串（内部辅助函数）。
 *
 * 规则：整数不显示小数位，非整数保留两位小数
 * 示例：3 → "$3"，0.8 → "$0.80"，22.5 → "$22.50"
 */
function formatPrice(price: number): string {
  // 整数价格直接显示，避免不必要的 .00 后缀
  if (Number.isInteger(price)) {
    return `$${price}`
  }
  // 非整数保留两位小数（如 $0.80 而非 $0.8）
  return `$${price.toFixed(2)}`
}

/**
 * 将定价对象格式化为面向用户的定价字符串。
 *
 * 输出格式："$输入价/$输出价 per Mtok"
 * 示例："$3/$15 per Mtok"（Sonnet 系列）、"$15/$75 per Mtok"（Opus 4/4.1）
 *
 * @param costs - 模型定价对象
 * @returns 格式化定价字符串
 */
export function formatModelPricing(costs: ModelCosts): string {
  return `${formatPrice(costs.inputTokens)}/${formatPrice(costs.outputTokens)} per Mtok`
}

/**
 * 获取指定模型的格式化定价字符串（对外查询接口）。
 *
 * 接受短名称或完整模型名称两种形式。
 * 如果模型不在已知定价表中，返回 undefined（而非抛出异常）。
 *
 * @param model - 模型名称（短名或完整名均可）
 * @returns 格式化定价字符串，或 undefined（模型未知时）
 */
export function getModelPricingString(model: string): string | undefined {
  // 统一转为规范短名，再查定价表
  const shortName = getCanonicalName(model)
  const costs = MODEL_COSTS[shortName]
  if (!costs) return undefined
  return formatModelPricing(costs)
}
