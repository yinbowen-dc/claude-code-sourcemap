/**
 * limits.ts — 文件读取工具的输出限制配置
 *
 * 【在 Claude Code 系统中的位置】
 * 本文件为 FileReadTool 提供运行时输出限制配置，位于 FileReadTool 目录下。
 * FileReadTool.ts 在每次文件读取时通过 getDefaultFileReadingLimits() 获取当前有效的限制值。
 *
 * 【主要功能】
 * - 定义 FileReadingLimits 类型（maxTokens、maxSizeBytes 及可选标志位）
 * - 通过三级优先级确定 maxTokens：环境变量 > GrowthBook 远程配置 > 默认值 25000
 * - 使用 memoize 固定首次获取的值，防止特性标志在会话中刷新后改变上限
 * - 防御性校验各字段，无效值自动回退到硬编码默认值（杜绝 cap=0 的情况）
 *
 * 两个限制的说明：
 *   | 限制          | 默认值  | 检查依据               | 检查成本         | 超出时行为   |
 *   |---------------|---------|------------------------|------------------|--------------|
 *   | maxSizeBytes  | 256 KB  | 文件总大小（非输出大小） | 1 次 stat        | 读取前抛错   |
 *   | maxTokens     | 25000   | 实际输出 token 数        | API 往返         | 读取后抛错   |
 */

import memoize from 'lodash-es/memoize.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from 'src/services/analytics/growthbook.js'
import { MAX_OUTPUT_SIZE } from 'src/utils/file.js'

/** 默认的最大输出 Token 数（文本读取时的硬编码兜底值） */
export const DEFAULT_MAX_OUTPUT_TOKENS = 25000

/**
 * 读取环境变量 CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS 获取用户自定义的 Token 上限。
 * 当环境变量未设置或无效时返回 undefined，由调用方继续查找下一优先级。
 *
 * @returns 有效的正整数 Token 上限，或 undefined
 */
function getEnvMaxTokens(): number | undefined {
  const override = process.env.CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS
  if (override) {
    const parsed = parseInt(override, 10)
    // 仅接受合法的正整数
    if (!isNaN(parsed) && parsed > 0) {
      return parsed
    }
  }
  return undefined
}

/** 文件读取限制配置类型 */
export type FileReadingLimits = {
  maxTokens: number       // 最大输出 Token 数
  maxSizeBytes: number    // 文件大小上限（字节）
  includeMaxSizeInPrompt?: boolean  // 是否在提示词中展示文件大小限制
  targetedRangeNudge?: boolean      // 是否启用精准范围提示（鼓励模型只读取需要的部分）
}

/**
 * 获取 FileReadTool 的默认读取限制配置。
 *
 * 使用 memoize 确保 GrowthBook 特性标志在首次获取后被固定，
 * 避免标志在后台刷新时导致同一会话中上限发生变化。
 *
 * maxTokens 优先级：
 *   1. 环境变量（用户显式覆盖，最高优先级）
 *   2. GrowthBook 远程配置（实验基础设施）
 *   3. 硬编码默认值 DEFAULT_MAX_OUTPUT_TOKENS
 *
 * 防御性设计：每个字段单独验证；无效值回退到硬编码默认值，
 * 不存在导致 cap=0 的路径。
 *
 * @returns 当前会话有效的文件读取限制配置
 */
export const getDefaultFileReadingLimits = memoize((): FileReadingLimits => {
  // 从 GrowthBook 获取远程配置（可能为空对象 {} 或 null）
  const override =
    getFeatureValue_CACHED_MAY_BE_STALE<Partial<FileReadingLimits> | null>(
      'tengu_amber_wren',
      {},
    )

  // maxSizeBytes：验证远程配置值，无效时使用 MAX_OUTPUT_SIZE（256KB）
  const maxSizeBytes =
    typeof override?.maxSizeBytes === 'number' &&
    Number.isFinite(override.maxSizeBytes) &&
    override.maxSizeBytes > 0
      ? override.maxSizeBytes
      : MAX_OUTPUT_SIZE

  // maxTokens：环境变量 > GrowthBook 配置 > 默认值
  const envMaxTokens = getEnvMaxTokens()
  const maxTokens =
    envMaxTokens ??
    (typeof override?.maxTokens === 'number' &&
    Number.isFinite(override.maxTokens) &&
    override.maxTokens > 0
      ? override.maxTokens
      : DEFAULT_MAX_OUTPUT_TOKENS)

  // includeMaxSizeInPrompt：布尔类型，无效时为 undefined（不覆盖默认行为）
  const includeMaxSizeInPrompt =
    typeof override?.includeMaxSizeInPrompt === 'boolean'
      ? override.includeMaxSizeInPrompt
      : undefined

  // targetedRangeNudge：布尔类型，无效时为 undefined
  const targetedRangeNudge =
    typeof override?.targetedRangeNudge === 'boolean'
      ? override.targetedRangeNudge
      : undefined

  return {
    maxSizeBytes,
    maxTokens,
    includeMaxSizeInPrompt,
    targetedRangeNudge,
  }
})
