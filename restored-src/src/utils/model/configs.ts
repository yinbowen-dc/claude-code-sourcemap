/**
 * Claude 模型静态配置注册表（Model Static Configuration Registry）
 *
 * 【在 Claude Code 系统流中的位置】
 * 本文件是模型系统的"配置数据库"，为各提供商维护每个 Claude 模型的精确 API 字符串。
 * 被以下模块广泛依赖：
 *   - model.ts         : getDefaultSonnetModel / getDefaultOpusModel / getDefaultHaikuModel
 *   - modelStrings.ts  : 构建 ModelStrings 对象，供模型别名解析使用
 *   - modelOptions.ts  : 构建模型选择器选项列表
 *   - deprecation.ts   : 构建废弃模型信息
 *   - validateModel.ts : get3PFallbackSuggestion 兜底建议
 *
 * 【配置结构】
 * 每个 `CLAUDE_*_CONFIG` 常量都是一个 `ModelConfig`（Record<APIProvider, ModelName>）对象，
 * 包含四个提供商的精确模型 ID：
 *   - firstParty : Anthropic 官方 API 字符串（如 'claude-opus-4-6'）
 *   - bedrock    : AWS Bedrock 字符串（如 'us.anthropic.claude-opus-4-6-v1'，含跨区域前缀）
 *   - vertex     : Google Cloud Vertex AI 字符串（如 'claude-opus-4-6'）
 *   - foundry    : Azure AI Foundry 字符串（如 'claude-opus-4-6'）
 *
 * 【主要导出】
 * - ALL_MODEL_CONFIGS   : 所有模型配置的聚合注册表，键为短 ModelKey（如 'opus46'、'sonnet45'）
 * - ModelKey            : ALL_MODEL_CONFIGS 的键联合类型
 * - CanonicalModelId    : 所有第一方 API 模型 ID 的联合类型
 * - CANONICAL_MODEL_IDS : 运行时规范 ID 数组（供完整性测试使用）
 * - CANONICAL_ID_TO_KEY : 规范 ID → 内部短键的映射（用于应用 modelOverrides 设置）
 *
 * 【新增模型说明】
 * 新增模型时需要：
 *   1. 添加 CLAUDE_*_CONFIG 常量（@[MODEL LAUNCH] 标记处）
 *   2. 将新常量注册到 ALL_MODEL_CONFIGS（@[MODEL LAUNCH] 标记处）
 */

import type { ModelName } from './model.js'
import type { APIProvider } from './providers.js'

// ModelConfig 类型：每个提供商对应一个模型 ID 字符串
export type ModelConfig = Record<APIProvider, ModelName>

// @[MODEL LAUNCH]: Add a new CLAUDE_*_CONFIG constant here. Double check the correct model strings
// here since the pattern may change.

/** Claude 3.7 Sonnet 各提供商模型 ID 配置 */
export const CLAUDE_3_7_SONNET_CONFIG = {
  firstParty: 'claude-3-7-sonnet-20250219',
  bedrock: 'us.anthropic.claude-3-7-sonnet-20250219-v1:0',
  vertex: 'claude-3-7-sonnet@20250219',
  foundry: 'claude-3-7-sonnet',
} as const satisfies ModelConfig

/** Claude 3.5 Sonnet v2 各提供商模型 ID 配置 */
export const CLAUDE_3_5_V2_SONNET_CONFIG = {
  firstParty: 'claude-3-5-sonnet-20241022',
  // Bedrock 使用非前缀基础模型格式（不含跨区域前缀）
  bedrock: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
  vertex: 'claude-3-5-sonnet-v2@20241022',
  foundry: 'claude-3-5-sonnet',
} as const satisfies ModelConfig

/** Claude 3.5 Haiku 各提供商模型 ID 配置 */
export const CLAUDE_3_5_HAIKU_CONFIG = {
  firstParty: 'claude-3-5-haiku-20241022',
  bedrock: 'us.anthropic.claude-3-5-haiku-20241022-v1:0',
  vertex: 'claude-3-5-haiku@20241022',
  foundry: 'claude-3-5-haiku',
} as const satisfies ModelConfig

/** Claude Haiku 4.5 各提供商模型 ID 配置 */
export const CLAUDE_HAIKU_4_5_CONFIG = {
  firstParty: 'claude-haiku-4-5-20251001',
  bedrock: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
  vertex: 'claude-haiku-4-5@20251001',
  foundry: 'claude-haiku-4-5',
} as const satisfies ModelConfig

/** Claude Sonnet 4 各提供商模型 ID 配置 */
export const CLAUDE_SONNET_4_CONFIG = {
  firstParty: 'claude-sonnet-4-20250514',
  bedrock: 'us.anthropic.claude-sonnet-4-20250514-v1:0',
  vertex: 'claude-sonnet-4@20250514',
  foundry: 'claude-sonnet-4',
} as const satisfies ModelConfig

/** Claude Sonnet 4.5 各提供商模型 ID 配置 */
export const CLAUDE_SONNET_4_5_CONFIG = {
  firstParty: 'claude-sonnet-4-5-20250929',
  bedrock: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
  vertex: 'claude-sonnet-4-5@20250929',
  foundry: 'claude-sonnet-4-5',
} as const satisfies ModelConfig

/** Claude Opus 4 各提供商模型 ID 配置 */
export const CLAUDE_OPUS_4_CONFIG = {
  firstParty: 'claude-opus-4-20250514',
  bedrock: 'us.anthropic.claude-opus-4-20250514-v1:0',
  vertex: 'claude-opus-4@20250514',
  foundry: 'claude-opus-4',
} as const satisfies ModelConfig

/** Claude Opus 4.1 各提供商模型 ID 配置 */
export const CLAUDE_OPUS_4_1_CONFIG = {
  firstParty: 'claude-opus-4-1-20250805',
  bedrock: 'us.anthropic.claude-opus-4-1-20250805-v1:0',
  vertex: 'claude-opus-4-1@20250805',
  foundry: 'claude-opus-4-1',
} as const satisfies ModelConfig

/** Claude Opus 4.5 各提供商模型 ID 配置 */
export const CLAUDE_OPUS_4_5_CONFIG = {
  firstParty: 'claude-opus-4-5-20251101',
  bedrock: 'us.anthropic.claude-opus-4-5-20251101-v1:0',
  vertex: 'claude-opus-4-5@20251101',
  foundry: 'claude-opus-4-5',
} as const satisfies ModelConfig

/** Claude Opus 4.6 各提供商模型 ID 配置（最新旗舰 Opus 模型） */
export const CLAUDE_OPUS_4_6_CONFIG = {
  firstParty: 'claude-opus-4-6',
  // Bedrock 使用不含日期的简短版本字符串
  bedrock: 'us.anthropic.claude-opus-4-6-v1',
  vertex: 'claude-opus-4-6',
  foundry: 'claude-opus-4-6',
} as const satisfies ModelConfig

/** Claude Sonnet 4.6 各提供商模型 ID 配置（最新 Sonnet 模型） */
export const CLAUDE_SONNET_4_6_CONFIG = {
  firstParty: 'claude-sonnet-4-6',
  bedrock: 'us.anthropic.claude-sonnet-4-6',
  vertex: 'claude-sonnet-4-6',
  foundry: 'claude-sonnet-4-6',
} as const satisfies ModelConfig

// @[MODEL LAUNCH]: Register the new config here.
/**
 * 所有已知 Claude 模型配置的聚合注册表。
 * 键为内部短名（ModelKey），值为对应的跨提供商配置对象。
 * 新增模型时需要在此处注册。
 */
export const ALL_MODEL_CONFIGS = {
  haiku35: CLAUDE_3_5_HAIKU_CONFIG,
  haiku45: CLAUDE_HAIKU_4_5_CONFIG,
  sonnet35: CLAUDE_3_5_V2_SONNET_CONFIG,
  sonnet37: CLAUDE_3_7_SONNET_CONFIG,
  sonnet40: CLAUDE_SONNET_4_CONFIG,
  sonnet45: CLAUDE_SONNET_4_5_CONFIG,
  sonnet46: CLAUDE_SONNET_4_6_CONFIG,
  opus40: CLAUDE_OPUS_4_CONFIG,
  opus41: CLAUDE_OPUS_4_1_CONFIG,
  opus45: CLAUDE_OPUS_4_5_CONFIG,
  opus46: CLAUDE_OPUS_4_6_CONFIG,
} as const satisfies Record<string, ModelConfig>

// 从注册表键派生内部短键联合类型
export type ModelKey = keyof typeof ALL_MODEL_CONFIGS

/** 所有规范第一方模型 ID 的联合类型（如 'claude-opus-4-6' | 'claude-sonnet-4-5-20250929' | …） */
export type CanonicalModelId =
  (typeof ALL_MODEL_CONFIGS)[ModelKey]['firstParty']

/** 运行时规范模型 ID 数组 — 供完整性测试使用（确保所有模型都有配置覆盖） */
export const CANONICAL_MODEL_IDS = Object.values(ALL_MODEL_CONFIGS).map(
  c => c.firstParty,
) as [CanonicalModelId, ...CanonicalModelId[]]

/** 规范 ID → 内部短键映射表。用于将 settings.modelOverrides 中的规范 ID 转换为内部 ModelKey。 */
export const CANONICAL_ID_TO_KEY: Record<CanonicalModelId, ModelKey> =
  Object.fromEntries(
    (Object.entries(ALL_MODEL_CONFIGS) as [ModelKey, ModelConfig][]).map(
      ([key, cfg]) => [cfg.firstParty, key],
    ),
  ) as Record<CanonicalModelId, ModelKey>
