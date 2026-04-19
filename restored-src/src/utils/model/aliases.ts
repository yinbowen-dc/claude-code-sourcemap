/**
 * 模型别名定义（Model Aliases）
 *
 * 【在 Claude Code 系统流中的位置】
 * 本文件是模型别名系统的最底层基础模块，被 model.ts、modelAllowlist.ts、
 * agent.ts、validateModel.ts 等上层模块广泛依赖。
 * 它定义了两类别名：
 *   1. MODEL_ALIASES       — 全量别名集合（含 1M 上下文和 opusplan 变体）
 *   2. MODEL_FAMILY_ALIASES — 裸家族别名（仅 sonnet/opus/haiku，用于通配符匹配）
 *
 * 【主要功能】
 * 1. MODEL_ALIASES / ModelAlias   — 所有受支持的模型别名常量与类型
 * 2. isModelAlias                 — 判断字符串是否为已知别名
 * 3. MODEL_FAMILY_ALIASES         — 家族级通配别名常量
 * 4. isModelFamilyAlias           — 判断字符串是否为家族级别名（allowlist 逻辑使用）
 */

/**
 * 全量模型别名列表。
 *
 * 各别名含义：
 * - 'sonnet'      — 当前默认 Sonnet 模型
 * - 'opus'        — 当前默认 Opus 模型
 * - 'haiku'       — 当前默认 Haiku 模型
 * - 'best'        — 映射到最强模型（当前为 Opus）
 * - 'sonnet[1m]'  — 带 1M 上下文窗口的 Sonnet
 * - 'opus[1m]'    — 带 1M 上下文窗口的 Opus
 * - 'opusplan'    — plan 模式使用 Opus，其余使用 Sonnet
 */
export const MODEL_ALIASES = [
  'sonnet',
  'opus',
  'haiku',
  'best',
  'sonnet[1m]',
  'opus[1m]',
  'opusplan',
] as const

// 从常量数组派生联合类型，方便类型安全地使用别名
export type ModelAlias = (typeof MODEL_ALIASES)[number]

/**
 * 判断给定字符串是否为已知模型别名。
 * 通过 TypeScript 类型守卫，将 string 收窄为 ModelAlias。
 */
export function isModelAlias(modelInput: string): modelInput is ModelAlias {
  // 利用 as ModelAlias 强制转换后 includes 检查，实现类型守卫
  return MODEL_ALIASES.includes(modelInput as ModelAlias)
}

/**
 * 裸家族别名列表，在 availableModels allowlist 中用作通配符。
 *
 * 当 allowlist 中包含 "opus" 时，所有 opus 系列模型（opus 4.5、4.6 等）都被允许。
 * 当 allowlist 中包含具体版本 ID 时，仅允许该精确版本。
 * （与 MODEL_ALIASES 的区别：不含 best/[1m]/opusplan 等特殊语义别名）
 */
export const MODEL_FAMILY_ALIASES = ['sonnet', 'opus', 'haiku'] as const

/**
 * 判断给定字符串是否为家族级通配别名（sonnet/opus/haiku）。
 * 主要供 modelAllowlist.ts 区分通配符和精确版本条目使用。
 */
export function isModelFamilyAlias(model: string): boolean {
  // 强制转换为 readonly string[] 以使用 includes 方法
  return (MODEL_FAMILY_ALIASES as readonly string[]).includes(model)
}
