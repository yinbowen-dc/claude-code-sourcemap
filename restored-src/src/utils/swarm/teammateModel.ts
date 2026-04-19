/**
 * Teammate 默认模型配置（teammateModel.ts）
 *
 * 【在 Claude Code 系统流程中的位置】
 * 本模块处于 Swarm 多智能体系统的模型选择层，在 spawn teammate 时被调用，
 * 用于确定未在配置中显式指定模型的 teammate 应当使用的默认模型。
 * 它对 API 提供商（Anthropic 第一方 / AWS Bedrock / Google Vertex / Foundry）
 * 保持感知，确保不同部署环境下均能获得正确的模型 ID。
 *
 * 【主要职责】
 * 提供一个硬编码的 teammate 默认模型回退值，当用户未在 /config 中设置
 * teammateDefaultModel 时使用此值。目前默认为 Claude Opus 4.6。
 *
 * 【注意事项】
 * 每次模型发布时需要更新此文件中的 @[MODEL LAUNCH] 注释处的模型配置引用。
 */

import { CLAUDE_OPUS_4_6_CONFIG } from '../model/configs.js'
import { getAPIProvider } from '../model/providers.js'

// @[MODEL LAUNCH]: 新模型发布时请更新下方的回退模型。
// 当用户在 /config 中从未设置 teammateDefaultModel 时，新 teammate
// 将使用 Opus 4.6。必须感知 API 提供商以确保 Bedrock / Vertex / Foundry
// 客户获得正确的模型 ID 格式。
/**
 * 获取 teammate 的硬编码默认模型回退值。
 *
 * 【执行流程】
 * 1. 调用 getAPIProvider() 获取当前部署环境的 API 提供商类型；
 * 2. 从 CLAUDE_OPUS_4_6_CONFIG 映射中查找对应提供商的模型 ID；
 * 3. 返回该模型 ID 字符串供 spawn 逻辑使用。
 *
 * @returns 适合当前 API 提供商的 Claude Opus 4.6 模型 ID 字符串
 */
export function getHardcodedTeammateModelFallback(): string {
  // 根据当前 API 提供商（anthropic / bedrock / vertex / foundry）返回对应的模型 ID
  return CLAUDE_OPUS_4_6_CONFIG[getAPIProvider()]
}
