/**
 * Ant 内部模型覆盖配置模块 — 从 GrowthBook 特性标志动态加载仅供 Anthropic 内部员工使用的模型
 *
 * 【在系统流中的位置】
 * 本文件是 ant 用户（USER_TYPE==='ant'）模型体系的专属扩展层，
 * 在标准公开模型之上叠加内部预发布模型。
 *
 * 调用链路：
 *   GrowthBook 特性标志 'tengu_ant_model_override'
 *     → getAntModelOverrideConfig()
 *     → getAntModels()      ← model.ts / modelOptions.ts（构建 ant 模型选项列表）
 *     → resolveAntModel()   ← model.ts parseUserSpecifiedModel（将别名展开为真实模型 ID）
 *
 * 【安全说明】
 * - 所有函数均在入口处检查 USER_TYPE !== 'ant'，确保代码分支在 Bun
 *   死码消除后不会泄漏到外部发布产物。
 * - 模型代号字符串必须同时加入 scripts/excluded-strings.txt 以防意外泄漏。
 *
 * 【主要类型和导出】
 * - AntModel                  : 单个内部模型的完整配置
 * - AntModelOverrideConfig    : GrowthBook 返回的顶层配置对象
 * - getAntModelOverrideConfig : 获取完整覆盖配置（仅 ant 用户）
 * - getAntModels              : 获取内部模型列表（仅 ant 用户）
 * - resolveAntModel           : 将别名或模型 ID 解析为 AntModel 对象
 */

import { getFeatureValue_CACHED_MAY_BE_STALE } from 'src/services/analytics/growthbook.js'
import type { EffortLevel } from '../effort.js'

/**
 * 单个 ant 内部模型的配置结构。
 *
 * 字段说明：
 *   alias               — 在 /model 命令和配置中使用的别名（如模型代号）
 *   model               — 向 API 发送请求时实际使用的模型 ID 字符串
 *   label               — UI 显示用的友好名称
 *   description         — 可选的功能描述，显示在模型选择器中
 *   defaultEffortValue  — 可选的默认努力程度数值（0–1）
 *   defaultEffortLevel  — 可选的默认努力级别（low / medium / high 等）
 *   contextWindow       — 可选的上下文窗口大小（Token 数）
 *   defaultMaxTokens    — 可选的默认最大输出 Token 数
 *   upperMaxTokensLimit — 可选的最大输出 Token 上限（不可超越）
 *   alwaysOnThinking    — 该模型默认启用自适应思考，且拒绝 `thinking: { type: 'disabled' }`
 */
export type AntModel = {
  alias: string
  model: string
  label: string
  description?: string
  defaultEffortValue?: number
  defaultEffortLevel?: EffortLevel
  contextWindow?: number
  defaultMaxTokens?: number
  upperMaxTokensLimit?: number
  /** Model defaults to adaptive thinking and rejects `thinking: { type: 'disabled' }`. */
  alwaysOnThinking?: boolean
}

/**
 * 模型切换提示信息的配置，用于在 ant 模型选择器中展示新模型切换建议。
 */
export type AntModelSwitchCalloutConfig = {
  modelAlias?: string  // 目标模型别名（可选）
  description: string  // 切换提示的正文描述
  version: string      // 新模型版本号，用于更新检测
}

/**
 * tengu_ant_model_override GrowthBook 特性标志的完整配置结构。
 *
 * defaultModel            — ant 用户的默认模型别名（覆盖 getDefaultMainLoopModelSetting 的逻辑）
 * defaultModelEffortLevel — 默认努力级别（覆盖全局默认值）
 * defaultSystemPromptSuffix — 追加到系统提示末尾的 ant 专属内容
 * antModels               — 内部模型列表，用于构建选择器和解析别名
 * switchCallout           — 展示在模型选择器顶部的切换建议横幅
 */
export type AntModelOverrideConfig = {
  defaultModel?: string
  defaultModelEffortLevel?: EffortLevel
  defaultSystemPromptSuffix?: string
  antModels?: AntModel[]
  switchCallout?: AntModelSwitchCalloutConfig
}

// @[MODEL LAUNCH]: Update tengu_ant_model_override with new ant-only models
// @[MODEL LAUNCH]: Add the codename to scripts/excluded-strings.txt to prevent it from leaking to external builds.
/**
 * 从 GrowthBook 特性标志缓存中读取 ant 模型覆盖配置。
 *
 * 流程：
 *   1. 检查 USER_TYPE 是否为 'ant'，否则直接返回 null（Bun 死码消除会移除此分支）
 *   2. 调用 getFeatureValue_CACHED_MAY_BE_STALE 读取上次缓存的 GrowthBook 特性值
 *      （命名强调可能是旧值，调用方需对过期情况有所预期）
 *
 * @returns ant 用户返回配置对象或 null（标志未配置时）；非 ant 用户始终返回 null
 */
export function getAntModelOverrideConfig(): AntModelOverrideConfig | null {
  // 非 ant 用户立即返回，Bun 死码消除将把整个 if 分支剔除
  if (process.env.USER_TYPE !== 'ant') {
    return null
  }
  // 读取 GrowthBook 缓存；'tengu_ant_model_override' 是内部特性标志名称
  return getFeatureValue_CACHED_MAY_BE_STALE<AntModelOverrideConfig | null>(
    'tengu_ant_model_override',
    null,
  )
}

/**
 * 获取 ant 内部可用模型列表。
 *
 * 非 ant 用户返回空数组，避免内部模型信息泄露。
 * 配置未设置 antModels 时也返回空数组（使用空值合并运算符）。
 *
 * @returns AntModel 数组，非 ant 用户始终为空
 */
export function getAntModels(): AntModel[] {
  // 非 ant 用户立即返回空数组
  if (process.env.USER_TYPE !== 'ant') {
    return []
  }
  // 空值合并：config 为 null 或 antModels 未定义时均返回 []
  return getAntModelOverrideConfig()?.antModels ?? []
}

/**
 * 将别名字符串或部分模型 ID 解析为对应的 AntModel 对象。
 *
 * 匹配策略（按优先级）：
 *   1. m.alias === model        精确别名匹配（区分大小写）
 *   2. lower.includes(m.model)  模型 ID 子串匹配（转小写后）
 *
 * 用途：parseUserSpecifiedModel 中对 ant 用户进行别名展开时调用，
 * 将用户输入的代号映射到真实的 API 模型 ID。
 *
 * @param model 用户输入的模型字符串（别名或部分 ID），undefined 时直接返回 undefined
 * @returns 匹配到的 AntModel，未匹配或非 ant 用户则返回 undefined
 */
export function resolveAntModel(
  model: string | undefined,
): AntModel | undefined {
  // 非 ant 用户无内部模型可解析
  if (process.env.USER_TYPE !== 'ant') {
    return undefined
  }
  // model 为 undefined 时无需查找
  if (model === undefined) {
    return undefined
  }
  const lower = model.toLowerCase()
  // 双重匹配：精确别名优先，其次子串匹配（兜底处理带版本后缀的输入）
  return getAntModels().find(
    m => m.alias === model || lower.includes(m.model.toLowerCase()),
  )
}
