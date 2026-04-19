/**
 * 第三方模型能力覆盖模块（3P Model Capability Overrides）
 *
 * 【在 Claude Code 系统流中的位置】
 * 本文件处于模型能力检测链的末端，专门为第三方（3P）集成商提供
 * 通过环境变量声明其自定义模型所支持的能力集的机制。
 *
 * 调用路径：
 *   QueryEngine / 工具决策层
 *     → get3PModelCapabilityOverride(model, capability)
 *     → ANTHROPIC_DEFAULT_{OPUS/SONNET/HAIKU}_MODEL_SUPPORTED_CAPABILITIES 环境变量
 *
 * 【适用场景】
 * 当 3P 用户通过 ANTHROPIC_DEFAULT_OPUS_MODEL 等环境变量固定了自定义模型 ID 时，
 * 系统默认不知道该模型是否支持 effort/thinking 等能力。
 * 3P 集成商可通过对应的 SUPPORTED_CAPABILITIES 环境变量声明能力列表，
 * 让 Claude Code 正确启用或禁用相关功能路径。
 *
 * 【主要导出】
 * - ModelCapabilityOverride     : 可覆盖的能力类型联合类型
 * - get3PModelCapabilityOverride : 检查指定模型是否支持特定能力（memoize 缓存）
 */

import memoize from 'lodash-es/memoize.js'
import { getAPIProvider } from './providers.js'

/**
 * 可通过环境变量覆盖的模型能力类型。
 *
 * - effort              : 支持努力程度（effort level）参数
 * - max_effort          : 支持最大努力程度
 * - thinking            : 支持扩展思考（extended thinking）
 * - adaptive_thinking   : 支持自适应思考
 * - interleaved_thinking: 支持交错思考（与工具调用穿插）
 */
export type ModelCapabilityOverride =
  | 'effort'
  | 'max_effort'
  | 'thinking'
  | 'adaptive_thinking'
  | 'interleaved_thinking'

/**
 * 三个模型层级的环境变量配置对，每层对应一个模型 ID 变量和一个能力列表变量。
 * opus / sonnet / haiku 层级分别有独立的模型固定和能力声明环境变量。
 */
const TIERS = [
  {
    modelEnvVar: 'ANTHROPIC_DEFAULT_OPUS_MODEL',
    capabilitiesEnvVar: 'ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES',
  },
  {
    modelEnvVar: 'ANTHROPIC_DEFAULT_SONNET_MODEL',
    capabilitiesEnvVar: 'ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES',
  },
  {
    modelEnvVar: 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
    capabilitiesEnvVar: 'ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES',
  },
] as const

/**
 * 检查 3P 自定义模型是否通过环境变量声明了对某个能力的支持。
 *
 * 【工作原理】
 * 1. 若当前提供商为 firstParty，直接返回 undefined（官方 API 不需要覆盖）
 * 2. 遍历 TIERS，查找 modelEnvVar 与输入 model 匹配的层级
 * 3. 读取对应的 capabilitiesEnvVar，解析逗号分隔的能力列表
 * 4. 返回 true/false 表示是否包含指定能力；未匹配任何层级返回 undefined
 *
 * 【memoize 缓存】
 * 以 "${model}:${capability}" 为缓存键，避免重复解析环境变量字符串。
 * 进程级缓存，进程重启后自动失效。
 *
 * @param model      要检测的模型 ID 字符串（大小写不敏感匹配）
 * @param capability 要检测的能力类型
 * @returns true/false 表示是否支持该能力；undefined 表示无覆盖配置
 */
export const get3PModelCapabilityOverride = memoize(
  (model: string, capability: ModelCapabilityOverride): boolean | undefined => {
    // 官方 API（firstParty）不需要 3P 覆盖，直接跳过
    if (getAPIProvider() === 'firstParty') {
      return undefined
    }
    const m = model.toLowerCase()
    for (const tier of TIERS) {
      // 读取固定模型 ID 环境变量和对应的能力列表环境变量
      const pinned = process.env[tier.modelEnvVar]
      const capabilities = process.env[tier.capabilitiesEnvVar]
      // 未设置固定模型或能力列表，跳过此层级
      if (!pinned || capabilities === undefined) continue
      // 大小写不敏感匹配模型 ID
      if (m !== pinned.toLowerCase()) continue
      // 解析逗号分隔的能力列表，检查是否包含目标能力
      return capabilities
        .toLowerCase()
        .split(',')
        .map(s => s.trim())
        .includes(capability)
    }
    // 无任何层级匹配，返回 undefined 表示无覆盖配置
    return undefined
  },
  // 自定义 memoize 缓存键：避免大小写差异导致缓存穿透
  (model, capability) => `${model.toLowerCase()}:${capability}`,
)
