/**
 * 上下文窗口配置模块。
 *
 * 在 Claude Code 系统中，该模块根据模型能力和环境变量计算 API 请求所需的上下文窗口配置：
 * - 判断是否启用 1M token 上下文 beta header
 * - 根据模型规范选取适当的 max_tokens 上限
 * - 为 API 请求生成 betas 和 headers 配置
 */
// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
import { CONTEXT_1M_BETA_HEADER } from '../constants/betas.js'
import { getGlobalConfig } from './config.js'
import { isEnvTruthy } from './envUtils.js'
import { getCanonicalName } from './model/model.js'
import { getModelCapability } from './model/modelCapabilities.js'

// 所有模型默认的上下文窗口大小（200k token）
export const MODEL_CONTEXT_WINDOW_DEFAULT = 200_000

// compact 操作（对话压缩）允许的最大输出 token 数
export const COMPACT_MAX_OUTPUT_TOKENS = 20_000

// API 请求的默认最大输出 token 数
const MAX_OUTPUT_TOKENS_DEFAULT = 32_000
// 用户可配置的最大输出 token 上限
const MAX_OUTPUT_TOKENS_UPPER_LIMIT = 64_000

// 时槽预留优化的保守上限。BQ p99 实际输出约 4,911 token，
// 默认 32k/64k 导致时槽容量过度预留 8-16 倍。
// 开启此上限后不到 1% 的请求会触及限制，超限时在 query.ts 中以 64k 重试。
// 实际应用在 claude.ts:getMaxOutputTokensForModel，避免 growthbook→betas→context 循环依赖。
export const CAPPED_DEFAULT_MAX_TOKENS = 8_000
// 超出保守上限时的重试用上限
export const ESCALATED_MAX_TOKENS = 64_000

/**
 * 检查是否通过环境变量禁用了 1M 上下文。
 * 供 C4E 管理员在 HIPAA 合规场景下关闭 1M 上下文功能。
 */
export function is1mContextDisabled(): boolean {
  return isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT)
}

/**
 * 检查模型名称中是否包含 [1m] 后缀（客户端显式请求 1M 上下文）。
 * [1m] 是用户手动追加的 opt-in 标识，优先于所有其他检测逻辑。
 */
export function has1mContext(model: string): boolean {
  if (is1mContextDisabled()) {
    return false
  }
  return /\[1m\]/i.test(model)
}

// @[MODEL LAUNCH]: 新模型支持 1M 上下文时在此处更新匹配模式
export function modelSupports1M(model: string): boolean {
  if (is1mContextDisabled()) {
    return false
  }
  const canonical = getCanonicalName(model)
  // 目前仅 claude-sonnet-4 和 opus-4-6 支持 1M 上下文
  return canonical.includes('claude-sonnet-4') || canonical.includes('opus-4-6')
}

/**
 * 根据模型名称和已激活的 beta 头，计算该模型的实际可用上下文窗口大小（token 数）。
 *
 * 优先级从高到低：
 * 1. Ant 员工环境变量 CLAUDE_CODE_MAX_CONTEXT_TOKENS（手动覆盖，用于本地决策）
 * 2. 模型名称中的 [1m] 后缀（客户端显式 opt-in）
 * 3. modelCapabilities 中的 max_input_tokens（≥100k 时采用）
 * 4. betas 中包含 CONTEXT_1M_BETA_HEADER 且模型支持 1M（API 后端授权）
 * 5. Sonnet 1M 实验性功能（GrowthBook clientDataCache coral_reef_sonnet）
 * 6. Ant 员工内部模型配置 contextWindow
 * 7. 默认值 200k
 */
export function getContextWindowForModel(
  model: string,
  betas?: string[],
): number {
  // Ant 员工可通过环境变量覆盖上下文窗口大小（优先级最高）
  // 使其可以在 1M 能力的端点上限制自动压缩等本地决策的有效上下文
  if (
    process.env.USER_TYPE === 'ant' &&
    process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS
  ) {
    const override = parseInt(process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, 10)
    if (!isNaN(override) && override > 0) {
      return override
    }
  }

  // [1m] 后缀：客户端显式 opt-in，高于所有自动检测逻辑
  if (has1mContext(model)) {
    return 1_000_000
  }

  // modelCapabilities 中明确声明的 max_input_tokens（≥100k 视为有效）
  const cap = getModelCapability(model)
  if (cap?.max_input_tokens && cap.max_input_tokens >= 100_000) {
    // 若 cap 声明超过默认值但 1M 已禁用，则限制到默认值
    if (
      cap.max_input_tokens > MODEL_CONTEXT_WINDOW_DEFAULT &&
      is1mContextDisabled()
    ) {
      return MODEL_CONTEXT_WINDOW_DEFAULT
    }
    return cap.max_input_tokens
  }

  // API 后端通过 beta header 授权了 1M，且当前模型支持
  if (betas?.includes(CONTEXT_1M_BETA_HEADER) && modelSupports1M(model)) {
    return 1_000_000
  }
  // Sonnet 4.6 实验性 1M（通过 GrowthBook clientDataCache 控制）
  if (getSonnet1mExpTreatmentEnabled(model)) {
    return 1_000_000
  }
  // Ant 员工内部模型配置
  if (process.env.USER_TYPE === 'ant') {
    const antModel = resolveAntModel(model)
    if (antModel?.contextWindow) {
      return antModel.contextWindow
    }
  }
  return MODEL_CONTEXT_WINDOW_DEFAULT
}

/**
 * 检查 Sonnet 4.6 实验性 1M 上下文是否对当前模型启用。
 *
 * 条件：
 * - 1M 未被禁用
 * - 模型为 sonnet-4-6 且不带 [1m] 后缀（[1m] 路径已在 getContextWindowForModel 提前处理）
 * - GrowthBook clientDataCache 中 'coral_reef_sonnet' === 'true'（AB 实验分组）
 */
export function getSonnet1mExpTreatmentEnabled(model: string): boolean {
  if (is1mContextDisabled()) {
    return false
  }
  // 仅适用于无显式 [1m] 后缀的 sonnet 4.6
  if (has1mContext(model)) {
    return false
  }
  if (!getCanonicalName(model).includes('sonnet-4-6')) {
    return false
  }
  // 读取 GrowthBook AB 实验分组
  return getGlobalConfig().clientDataCache?.['coral_reef_sonnet'] === 'true'
}

/**
 * 根据 token 使用量数据计算上下文窗口已用和剩余百分比。
 *
 * @returns used/remaining 百分比（0-100），无使用量数据时返回 null
 */
export function calculateContextPercentages(
  currentUsage: {
    input_tokens: number
    cache_creation_input_tokens: number
    cache_read_input_tokens: number
  } | null,
  contextWindowSize: number,
): { used: number | null; remaining: number | null } {
  if (!currentUsage) {
    return { used: null, remaining: null }
  }

  // 三类输入 token 之和为实际已使用量
  const totalInputTokens =
    currentUsage.input_tokens +
    currentUsage.cache_creation_input_tokens +
    currentUsage.cache_read_input_tokens

  const usedPercentage = Math.round(
    (totalInputTokens / contextWindowSize) * 100,
  )
  // 夹紧到 [0, 100] 区间，避免超出 100% 或负值
  const clampedUsed = Math.min(100, Math.max(0, usedPercentage))

  return {
    used: clampedUsed,
    remaining: 100 - clampedUsed,
  }
}

/**
 * 返回指定模型的默认最大输出 token 数及用户可设置的上限。
 *
 * 优先级：
 * 1. Ant 员工内部模型配置（defaultMaxTokens / upperMaxTokensLimit）
 * 2. 按模型系列硬编码值
 * 3. modelCapabilities 中的 max_tokens（≥4096 时覆盖上限）
 */
export function getModelMaxOutputTokens(model: string): {
  default: number
  upperLimit: number
} {
  let defaultTokens: number
  let upperLimit: number

  // Ant 员工内部模型配置优先
  if (process.env.USER_TYPE === 'ant') {
    const antModel = resolveAntModel(model.toLowerCase())
    if (antModel) {
      defaultTokens = antModel.defaultMaxTokens ?? MAX_OUTPUT_TOKENS_DEFAULT
      upperLimit = antModel.upperMaxTokensLimit ?? MAX_OUTPUT_TOKENS_UPPER_LIMIT
      return { default: defaultTokens, upperLimit }
    }
  }

  const m = getCanonicalName(model)

  // 按模型系列分配默认值和上限
  if (m.includes('opus-4-6')) {
    defaultTokens = 64_000
    upperLimit = 128_000
  } else if (m.includes('sonnet-4-6')) {
    defaultTokens = 32_000
    upperLimit = 128_000
  } else if (
    m.includes('opus-4-5') ||
    m.includes('sonnet-4') ||
    m.includes('haiku-4')
  ) {
    defaultTokens = 32_000
    upperLimit = 64_000
  } else if (m.includes('opus-4-1') || m.includes('opus-4')) {
    defaultTokens = 32_000
    upperLimit = 32_000
  } else if (m.includes('claude-3-opus')) {
    defaultTokens = 4_096
    upperLimit = 4_096
  } else if (m.includes('claude-3-sonnet')) {
    defaultTokens = 8_192
    upperLimit = 8_192
  } else if (m.includes('claude-3-haiku')) {
    defaultTokens = 4_096
    upperLimit = 4_096
  } else if (m.includes('3-5-sonnet') || m.includes('3-5-haiku')) {
    defaultTokens = 8_192
    upperLimit = 8_192
  } else if (m.includes('3-7-sonnet')) {
    defaultTokens = 32_000
    upperLimit = 64_000
  } else {
    // 未知模型回退到全局默认值
    defaultTokens = MAX_OUTPUT_TOKENS_DEFAULT
    upperLimit = MAX_OUTPUT_TOKENS_UPPER_LIMIT
  }

  // modelCapabilities 中声明的 max_tokens 覆盖上限（以更精确的能力数据为准）
  const cap = getModelCapability(model)
  if (cap?.max_tokens && cap.max_tokens >= 4_096) {
    upperLimit = cap.max_tokens
    // 确保默认值不超过新上限
    defaultTokens = Math.min(defaultTokens, upperLimit)
  }

  return { default: defaultTokens, upperLimit }
}

/**
 * 返回指定模型的最大 thinking budget token 数。
 * thinking budget 必须严格小于 max_tokens（API 要求）。
 *
 * @deprecated 新模型使用自适应 thinking，不再需要显式 thinking token 预算
 */
export function getMaxThinkingTokensForModel(model: string): number {
  // upperLimit - 1 确保 thinking budget 严格小于 max_tokens
  return getModelMaxOutputTokens(model).upperLimit - 1
}
