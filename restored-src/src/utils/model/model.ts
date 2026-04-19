// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
/**
 * 核心模型解析与选择模块（Core Model Resolution & Selection）
 *
 * 【在 Claude Code 系统流中的位置】
 * 本文件是整个模型系统的中枢，几乎所有需要"当前应该使用哪个模型"的地方
 * 都会通过本文件提供的函数获取答案。
 *
 * 调用链路（简化）：
 *   CLI / REPL / SDK 调用
 *     → getMainLoopModel()                   — 获取主循环使用的模型名
 *     → getUserSpecifiedModelSetting()        — 读取用户配置（/model 命令、--model 标志、环境变量、settings）
 *     → parseUserSpecifiedModel()             — 将别名/codename 解析为完整 API 字符串
 *     → getDefaultMainLoopModelSetting()      — 根据订阅类型返回默认值
 *
 * 【优先级顺序】（高 → 低）
 * 1. 会话内 /model 命令（getMainLoopModelOverride）
 * 2. 启动时 --model 标志
 * 3. ANTHROPIC_MODEL 环境变量
 * 4. settings.model（用户保存的配置）
 * 5. 内置默认值（Max/Team Premium → Opus；其余 → Sonnet）
 *
 * 【主要导出】
 * - getMainLoopModel           : 获取当前主循环模型（最常用）
 * - getUserSpecifiedModelSetting : 获取用户显式指定的模型设置（可为别名）
 * - parseUserSpecifiedModel    : 将别名/ID 解析为完整模型 API 字符串
 * - getRuntimeMainLoopModel    : 考虑 permissionMode 的运行时模型（opusplan 逻辑）
 * - getDefaultMainLoopModelSetting : 根据用户层级返回默认别名/ID
 * - getCanonicalName           : 全提供商字符串 → 短规范名（如 'claude-opus-4-6'）
 * - firstPartyNameToCanonical  : 纯字符串匹配，剥离日期/提供商前缀
 * - getPublicModelDisplayName  : 模型 ID → 人类可读显示名（如 'Opus 4.6'）
 * - getMarketingNameForModel   : 模型 ID → 营销名（含 1M 标记）
 * - renderModelName            : 含 Ant codename 脱敏的显示字符串
 * - normalizeModelStringForAPI : 去除 [1m]/[2m] 后缀，供 API 调用使用
 * - isLegacyModelRemapEnabled  : 是否开启旧版 Opus 4.0/4.1 → 当前 Opus 的自动重映射
 * - resolveSkillModelOverride  : Skill frontmatter model 声明 + [1m] 后缀传递
 */

import { getMainLoopModelOverride } from '../../bootstrap/state.js'
import {
  getSubscriptionType,
  isClaudeAISubscriber,
  isMaxSubscriber,
  isProSubscriber,
  isTeamPremiumSubscriber,
} from '../auth.js'
import {
  has1mContext,
  is1mContextDisabled,
  modelSupports1M,
} from '../context.js'
import { isEnvTruthy } from '../envUtils.js'
import { getModelStrings, resolveOverriddenModel } from './modelStrings.js'
import { formatModelPricing, getOpus46CostTier } from '../modelCost.js'
import { getSettings_DEPRECATED } from '../settings/settings.js'
import type { PermissionMode } from '../permissions/PermissionMode.js'
import { getAPIProvider } from './providers.js'
import { LIGHTNING_BOLT } from '../../constants/figures.js'
import { isModelAllowed } from './modelAllowlist.js'
import { type ModelAlias, isModelAlias } from './aliases.js'
import { capitalize } from '../stringUtils.js'

/** 模型短名类型（如 'claude-opus-4-6'） */
export type ModelShortName = string
/** 完整模型 API 字符串类型 */
export type ModelName = string
/** 模型设置类型：完整名、别名或 null（使用默认值） */
export type ModelSetting = ModelName | ModelAlias | null

/**
 * 获取小型快速模型。
 * 优先读取 ANTHROPIC_SMALL_FAST_MODEL 环境变量，否则退化为默认 Haiku 模型。
 * 用于轻量辅助任务（如简短补全、工具描述生成等）。
 */
export function getSmallFastModel(): ModelName {
  return process.env.ANTHROPIC_SMALL_FAST_MODEL || getDefaultHaikuModel()
}

/**
 * 判断给定模型是否为非自定义的 Opus 系列模型。
 * 通过与已知 Opus 模型字符串列表做精确比对来确定。
 * 用于区分官方 Opus 和用户自定义模型（如 Azure Foundry 部署 ID）。
 */
export function isNonCustomOpusModel(model: ModelName): boolean {
  return (
    model === getModelStrings().opus40 ||
    model === getModelStrings().opus41 ||
    model === getModelStrings().opus45 ||
    model === getModelStrings().opus46
  )
}

/**
 * 获取用户显式指定的模型设置。
 *
 * 【优先级顺序】（高 → 低）
 * 1. 会话内 /model 命令设置的覆盖值（getMainLoopModelOverride）
 * 2. 启动时 --model 标志 / ANTHROPIC_MODEL 环境变量 / settings.model
 *
 * 若用户指定的模型不在 availableModels 白名单中，视为未配置（返回 undefined）。
 * 返回值可以是别名（如 'opus'）而非完整 ID。
 *
 * @returns 用户指定的模型别名或完整 ID，未配置时返回 undefined
 */
export function getUserSpecifiedModelSetting(): ModelSetting | undefined {
  let specifiedModel: ModelSetting | undefined

  const modelOverride = getMainLoopModelOverride()
  if (modelOverride !== undefined) {
    // /model 命令设置的覆盖值优先级最高
    specifiedModel = modelOverride
  } else {
    const settings = getSettings_DEPRECATED() || {}
    // 环境变量优于 settings 文件
    specifiedModel = process.env.ANTHROPIC_MODEL || settings.model || undefined
  }

  // 若模型不在 availableModels 白名单中，忽略用户指定值（退化为默认）
  if (specifiedModel && !isModelAllowed(specifiedModel)) {
    return undefined
  }

  return specifiedModel
}

/**
 * 获取主循环（main loop）使用的完整模型名。
 *
 * 依次尝试用户指定的设置，最终退化为内置默认值。
 * 这是主循环中最常用的模型获取函数。
 *
 * @returns 当前会话应使用的完整模型 API 字符串
 */
export function getMainLoopModel(): ModelName {
  const model = getUserSpecifiedModelSetting()
  if (model !== undefined && model !== null) {
    // 将别名/ID 解析为完整 API 字符串（如 'opus' → 'claude-opus-4-6'）
    return parseUserSpecifiedModel(model)
  }
  return getDefaultMainLoopModel()
}

/**
 * 获取最强能力模型（等同于默认 Opus 模型）。
 * 用于 'best' 别名解析。
 */
export function getBestModel(): ModelName {
  return getDefaultOpusModel()
}

// @[MODEL LAUNCH]: Update the default Opus model (3P providers may lag so keep defaults unchanged).
/**
 * 获取默认 Opus 模型字符串。
 *
 * 优先读取 ANTHROPIC_DEFAULT_OPUS_MODEL 环境变量（3P 提供商自定义时使用）。
 * 3P 提供商（Bedrock、Vertex、Foundry）单独分支保留，是因为：
 *   1. 3P 可用性通常滞后于第一方 API 发布
 *   2. 下次模型发布时两个分支会再次分叉
 */
export function getDefaultOpusModel(): ModelName {
  if (process.env.ANTHROPIC_DEFAULT_OPUS_MODEL) {
    return process.env.ANTHROPIC_DEFAULT_OPUS_MODEL
  }
  // 3P 提供商分支：即使当前值与 firstParty 相同，也保留独立分支以便未来分叉
  if (getAPIProvider() !== 'firstParty') {
    return getModelStrings().opus46
  }
  return getModelStrings().opus46
}

// @[MODEL LAUNCH]: Update the default Sonnet model (3P providers may lag so keep defaults unchanged).
/**
 * 获取默认 Sonnet 模型字符串。
 *
 * 3P 默认 Sonnet 4.5（因为 3P 可能尚未上线 4.6）；
 * 第一方默认 Sonnet 4.6。
 */
export function getDefaultSonnetModel(): ModelName {
  if (process.env.ANTHROPIC_DEFAULT_SONNET_MODEL) {
    return process.env.ANTHROPIC_DEFAULT_SONNET_MODEL
  }
  // 3P 默认回退到 Sonnet 4.5，因为 4.6 可能尚未在 3P 平台上线
  if (getAPIProvider() !== 'firstParty') {
    return getModelStrings().sonnet45
  }
  return getModelStrings().sonnet46
}

// @[MODEL LAUNCH]: Update the default Haiku model (3P providers may lag so keep defaults unchanged).
/**
 * 获取默认 Haiku 模型字符串。
 *
 * Haiku 4.5 在所有平台（第一方、Foundry、Bedrock、Vertex）均已上线，
 * 因此不需要 3P 分支区分。
 */
export function getDefaultHaikuModel(): ModelName {
  if (process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL) {
    return process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL
  }

  // Haiku 4.5 已在所有平台部署，无需区分提供商
  return getModelStrings().haiku45
}

/**
 * 根据运行时上下文（权限模式、Token 使用量）获取实际使用的主循环模型。
 *
 * 【opusplan 语义】
 * 当用户设置 'opusplan' 时：
 *   - 处于 plan 模式 且 Token 未超 200K → 使用 Opus（最强推理）
 *   - 其他情况（execute/default 模式，或超 200K）→ 使用 mainLoopModel（通常为 Sonnet）
 *
 * 【haiku + plan 语义】
 * 用户设置 'haiku' 但处于 plan 模式时，自动升级为 Sonnet（haiku 不适合规划任务）。
 *
 * @param params.permissionMode   当前权限/执行模式
 * @param params.mainLoopModel    当前已解析的主循环模型字符串
 * @param params.exceeds200kTokens 当前会话是否超过 200K Token
 */
export function getRuntimeMainLoopModel(params: {
  permissionMode: PermissionMode
  mainLoopModel: string
  exceeds200kTokens?: boolean
}): ModelName {
  const { permissionMode, mainLoopModel, exceeds200kTokens = false } = params

  // opusplan：plan 模式且未超 200K 时切换为 Opus（[1m] 后缀不需要，因为只在 plan 短窗口使用）
  if (
    getUserSpecifiedModelSetting() === 'opusplan' &&
    permissionMode === 'plan' &&
    !exceeds200kTokens
  ) {
    return getDefaultOpusModel()
  }

  // haiku + plan 模式：自动提升到 Sonnet，haiku 不适合规划任务
  if (getUserSpecifiedModelSetting() === 'haiku' && permissionMode === 'plan') {
    return getDefaultSonnetModel()
  }

  return mainLoopModel
}

/**
 * 获取默认主循环模型的别名或完整 ID 设置（未经 parseUserSpecifiedModel 解析）。
 *
 * 【各用户层级默认值】
 * - Ant 内部用户      : 读取 GrowthBook 动态配置；无配置时 → Opus[1m]
 * - Max / Team Premium: Opus（+ 视是否开启 1M merge 加 [1m] 后缀）
 * - 其余所有用户       : Sonnet（PAYG 3P 可能为较旧版本）
 */
export function getDefaultMainLoopModelSetting(): ModelName | ModelAlias {
  // Ant 内部用户：优先读取动态配置（GrowthBook flag），否则默认 Opus[1m]
  if (process.env.USER_TYPE === 'ant') {
    return (
      getAntModelOverrideConfig()?.defaultModel ??
      getDefaultOpusModel() + '[1m]'
    )
  }

  // Max 订阅用户：默认 Opus（视 1M merge 开关决定是否加 [1m]）
  if (isMaxSubscriber()) {
    return getDefaultOpusModel() + (isOpus1mMergeEnabled() ? '[1m]' : '')
  }

  // Team Premium：与 Max 相同，默认 Opus
  if (isTeamPremiumSubscriber()) {
    return getDefaultOpusModel() + (isOpus1mMergeEnabled() ? '[1m]' : '')
  }

  // PAYG（1P & 3P）、Enterprise、Team Standard、Pro 均默认 Sonnet
  return getDefaultSonnetModel()
}

/**
 * 同步获取默认主循环模型完整 API 字符串（绕过用户指定配置）。
 * 内部调用 parseUserSpecifiedModel 将别名/设置解析为完整模型 ID。
 */
export function getDefaultMainLoopModel(): ModelName {
  return parseUserSpecifiedModel(getDefaultMainLoopModelSetting())
}

// @[MODEL LAUNCH]: Add a canonical name mapping for the new model below.
/**
 * 将第一方格式的模型名映射为短规范名（纯字符串操作，不读取任何配置）。
 *
 * 【适用范围】
 * 输入必须是第一方格式 ID（如 'claude-3-7-sonnet-20250219'、
 * 'us.anthropic.claude-opus-4-6-v1:0'）。
 * 因为不访问 settings，可在模块顶层（如 MODEL_COSTS）安全调用。
 *
 * 【匹配顺序】
 * 必须从更具体的版本号开始检查（如先检查 opus-4-5 再检查 opus-4），
 * 否则 opus-4-5 会被 opus-4 规则误匹配。
 *
 * @param name 第一方格式模型 ID（大小写不敏感）
 * @returns 短规范名（如 'claude-opus-4-6'）
 */
export function firstPartyNameToCanonical(name: ModelName): ModelShortName {
  name = name.toLowerCase()
  // Claude 4+ 系列：先检查更具体的子版本号，避免被通用规则截断
  if (name.includes('claude-opus-4-6')) {
    return 'claude-opus-4-6'
  }
  if (name.includes('claude-opus-4-5')) {
    return 'claude-opus-4-5'
  }
  if (name.includes('claude-opus-4-1')) {
    return 'claude-opus-4-1'
  }
  if (name.includes('claude-opus-4')) {
    return 'claude-opus-4'
  }
  if (name.includes('claude-sonnet-4-6')) {
    return 'claude-sonnet-4-6'
  }
  if (name.includes('claude-sonnet-4-5')) {
    return 'claude-sonnet-4-5'
  }
  if (name.includes('claude-sonnet-4')) {
    return 'claude-sonnet-4'
  }
  if (name.includes('claude-haiku-4-5')) {
    return 'claude-haiku-4-5'
  }
  // Claude 3.x 系列：命名方案为 claude-3-{family}，需单独处理
  if (name.includes('claude-3-7-sonnet')) {
    return 'claude-3-7-sonnet'
  }
  if (name.includes('claude-3-5-sonnet')) {
    return 'claude-3-5-sonnet'
  }
  if (name.includes('claude-3-5-haiku')) {
    return 'claude-3-5-haiku'
  }
  if (name.includes('claude-3-opus')) {
    return 'claude-3-opus'
  }
  if (name.includes('claude-3-sonnet')) {
    return 'claude-3-sonnet'
  }
  if (name.includes('claude-3-haiku')) {
    return 'claude-3-haiku'
  }
  // 通用正则回退：提取 claude-xxx 前缀
  const match = name.match(/(claude-(\d+-\d+-)?\w+)/)
  if (match && match[1]) {
    return match[1]
  }
  // 无法匹配时原样返回
  return name
}

/**
 * 将任意提供商格式的完整模型字符串映射为跨提供商统一的短规范名。
 *
 * 例如：
 *   'claude-3-5-haiku-20241022'             → 'claude-3-5-haiku'
 *   'us.anthropic.claude-3-5-haiku-20241022-v1:0' → 'claude-3-5-haiku'
 *
 * 先通过 resolveOverriddenModel 处理 modelOverrides（如 Bedrock ARN → 规范 ID），
 * 再用 firstPartyNameToCanonical 剥离版本号/提供商前缀。
 *
 * @param fullModelName 任意格式的完整模型名
 * @returns 跨提供商统一短规范名
 */
export function getCanonicalName(fullModelName: ModelName): ModelShortName {
  // 先反解 modelOverrides（如 Bedrock ARN → 第一方规范 ID），再映射短名
  return firstPartyNameToCanonical(resolveOverriddenModel(fullModelName))
}

// @[MODEL LAUNCH]: Update the default model description strings shown to users.
/**
 * 返回 Claude.ai 订阅用户看到的默认模型描述文字（用于 /model 命令显示）。
 * Max/Team Premium 显示 Opus；其余订阅用户显示 Sonnet。
 *
 * @param fastMode 是否为快速模式（显示价格后缀时加闪电符号）
 */
export function getClaudeAiUserDefaultModelDescription(
  fastMode = false,
): string {
  if (isMaxSubscriber() || isTeamPremiumSubscriber()) {
    if (isOpus1mMergeEnabled()) {
      return `Opus 4.6 with 1M context · Most capable for complex work${fastMode ? getOpus46PricingSuffix(true) : ''}`
    }
    return `Opus 4.6 · Most capable for complex work${fastMode ? getOpus46PricingSuffix(true) : ''}`
  }
  return 'Sonnet 4.6 · Best for everyday tasks'
}

/**
 * 将默认模型设置渲染为可读字符串，用于 /model 命令 UI 展示。
 * 'opusplan' 单独处理，显示其双模式说明；其余设置先解析再渲染。
 */
export function renderDefaultModelSetting(
  setting: ModelName | ModelAlias,
): string {
  if (setting === 'opusplan') {
    return 'Opus 4.6 in plan mode, else Sonnet 4.6'
  }
  return renderModelName(parseUserSpecifiedModel(setting))
}

/**
 * 生成 Opus 4.6 定价后缀字符串（仅对第一方提供商显示）。
 * fastMode 时在价格前添加闪电符号（⚡）。
 *
 * @param fastMode 是否快速模式（影响成本层级）
 */
export function getOpus46PricingSuffix(fastMode: boolean): string {
  if (getAPIProvider() !== 'firstParty') return ''
  const pricing = formatModelPricing(getOpus46CostTier(fastMode))
  const fastModeIndicator = fastMode ? ` (${LIGHTNING_BOLT})` : ''
  return ` ·${fastModeIndicator} ${pricing}`
}

/**
 * 判断 Opus 1M context 合并显示是否启用。
 *
 * 【禁用条件（任一满足即禁用）】
 * 1. 全局 1M context 被禁用（is1mContextDisabled）
 * 2. Pro 订阅用户（Pro 不含 1M 权益）
 * 3. 非第一方提供商（1M 合并仅对 Anthropic API 开放）
 * 4. Claude.ai 订阅但 subscriptionType 未知（防止 VS Code 子进程误开放 1M 导致 API 限速错误）
 */
export function isOpus1mMergeEnabled(): boolean {
  if (
    is1mContextDisabled() ||
    isProSubscriber() ||
    getAPIProvider() !== 'firstParty'
  ) {
    return false
  }
  // 安全性保护：订阅类型未知时关闭合并，防止 stale OAuth token 误触发
  if (isClaudeAISubscriber() && getSubscriptionType() === null) {
    return false
  }
  return true
}

/**
 * 将模型设置（别名或完整名）渲染为 UI 展示字符串。
 * 'opusplan' → 'Opus Plan'；别名首字母大写；完整名通过 renderModelName 渲染。
 */
export function renderModelSetting(setting: ModelName | ModelAlias): string {
  if (setting === 'opusplan') {
    return 'Opus Plan'
  }
  if (isModelAlias(setting)) {
    return capitalize(setting)
  }
  return renderModelName(setting)
}

// @[MODEL LAUNCH]: Add display name cases for the new model (base + [1m] variant if applicable).
/**
 * 返回已知公开模型的人类可读显示名（如 'Opus 4.6'、'Sonnet 4.6 (1M context)'）。
 * 对于未识别的模型（如 Ant codename、3P 自定义 ID）返回 null。
 *
 * @param model 完整模型 API 字符串
 * @returns 人类可读显示名，或 null（未识别模型）
 */
export function getPublicModelDisplayName(model: ModelName): string | null {
  switch (model) {
    case getModelStrings().opus46:
      return 'Opus 4.6'
    case getModelStrings().opus46 + '[1m]':
      return 'Opus 4.6 (1M context)'
    case getModelStrings().opus45:
      return 'Opus 4.5'
    case getModelStrings().opus41:
      return 'Opus 4.1'
    case getModelStrings().opus40:
      return 'Opus 4'
    case getModelStrings().sonnet46 + '[1m]':
      return 'Sonnet 4.6 (1M context)'
    case getModelStrings().sonnet46:
      return 'Sonnet 4.6'
    case getModelStrings().sonnet45 + '[1m]':
      return 'Sonnet 4.5 (1M context)'
    case getModelStrings().sonnet45:
      return 'Sonnet 4.5'
    case getModelStrings().sonnet40:
      return 'Sonnet 4'
    case getModelStrings().sonnet40 + '[1m]':
      return 'Sonnet 4 (1M context)'
    case getModelStrings().sonnet37:
      return 'Sonnet 3.7'
    case getModelStrings().sonnet35:
      return 'Sonnet 3.5'
    case getModelStrings().haiku45:
      return 'Haiku 4.5'
    case getModelStrings().haiku35:
      return 'Haiku 3.5'
    default:
      return null
  }
}

/**
 * 对 Ant 内部 codename 进行脱敏处理，只保留前三个字符，其余用 '*' 替换。
 * 例如 'capybara-v2-fast' → 'cap*****-v2-fast'（仅遮蔽第一个段）。
 *
 * @param baseName 不含 [1m] 后缀的 codename 字符串
 */
function maskModelCodename(baseName: string): string {
  // 仅对 '-' 前的第一段（codename）脱敏，保留后面的版本修饰符
  const [codename = '', ...rest] = baseName.split('-')
  const masked =
    codename.slice(0, 3) + '*'.repeat(Math.max(0, codename.length - 3))
  return [masked, ...rest].join('-')
}

/**
 * 将完整模型名渲染为 UI 显示字符串。
 *
 * 【三种情况】
 * 1. 公开已知模型 → 返回人类可读公开名（如 'Opus 4.6'）
 * 2. Ant 用户 + 匹配 codename → 脱敏后加 [1m] 后缀（如 'cap*****-v2[1m]'）
 * 3. 其他模型 → 原样返回
 *
 * @param model 完整模型 API 字符串（可含 [1m] 后缀）
 */
export function renderModelName(model: ModelName): string {
  const publicName = getPublicModelDisplayName(model)
  if (publicName) {
    return publicName
  }
  if (process.env.USER_TYPE === 'ant') {
    const resolved = parseUserSpecifiedModel(model)
    const antModel = resolveAntModel(model)
    if (antModel) {
      // 去除 [1m] 后缀后对 codename 脱敏，再根据解析结果决定是否补回 [1m]
      const baseName = antModel.model.replace(/\[1m\]$/i, '')
      const masked = maskModelCodename(baseName)
      const suffix = has1mContext(resolved) ? '[1m]' : ''
      return masked + suffix
    }
    if (resolved !== model) {
      // 别名解析后结果不同时，显示 "alias (resolved)" 格式
      return `${model} (${resolved})`
    }
    return resolved
  }
  return model
}

/**
 * 返回适合公开场景（如 git commit trailer）的作者名。
 * 已知公开模型返回 "Claude {ModelName}"；未知/内部模型返回 "Claude ({model})"。
 *
 * @param model 完整模型名
 */
export function getPublicModelName(model: ModelName): string {
  const publicName = getPublicModelDisplayName(model)
  if (publicName) {
    return `Claude ${publicName}`
  }
  return `Claude (${model})`
}

/**
 * 将用户输入的模型别名或完整 ID 解析为实际 API 调用字符串。
 *
 * 【解析流程】
 * 1. 剥离 [1m] 后缀并记录标志（has1mTag）
 * 2. 若为已知别名（opus/sonnet/haiku/best/opusplan），映射到对应默认模型
 * 3. 若为旧版 Opus（4.0/4.1）且处于第一方 API，重映射到当前 Opus
 * 4. 若为 Ant 用户 + codename，通过 resolveAntModel 获取完整 API 字符串
 * 5. 其余情况：保留原始大小写（Azure Foundry 部署 ID 大小写敏感）
 *
 * 【[1m] 后缀语义】
 * 允许在任意别名后加 [1m]（如 haiku[1m]、sonnet[1m]）以开启 1M 上下文，
 * 无需每个变体都在 MODEL_ALIASES 中注册。
 *
 * @param modelInput 用户输入的模型别名或名称
 * @returns 完整模型 API 字符串（可能含 [1m] 后缀）
 */
export function parseUserSpecifiedModel(
  modelInput: ModelName | ModelAlias,
): ModelName {
  const modelInputTrimmed = modelInput.trim()
  const normalizedModel = modelInputTrimmed.toLowerCase()

  // 检查是否有 [1m] 后缀，并从基础模型字符串中剥离
  const has1mTag = has1mContext(normalizedModel)
  const modelString = has1mTag
    ? normalizedModel.replace(/\[1m]$/i, '').trim()
    : normalizedModel

  if (isModelAlias(modelString)) {
    switch (modelString) {
      case 'opusplan':
        // opusplan 默认解析为 Sonnet（plan 模式下 getRuntimeMainLoopModel 会切换到 Opus）
        return getDefaultSonnetModel() + (has1mTag ? '[1m]' : '')
      case 'sonnet':
        return getDefaultSonnetModel() + (has1mTag ? '[1m]' : '')
      case 'haiku':
        return getDefaultHaikuModel() + (has1mTag ? '[1m]' : '')
      case 'opus':
        return getDefaultOpusModel() + (has1mTag ? '[1m]' : '')
      case 'best':
        // 'best' 直接映射到最强模型，不支持 [1m] 后缀
        return getBestModel()
      default:
    }
  }

  // 旧版 Opus 4.0/4.1 重映射：第一方 API 已下线这些版本
  // 3P 提供商可能尚未上线 4.6，因此 3P 不做重映射
  if (
    getAPIProvider() === 'firstParty' &&
    isLegacyOpusFirstParty(modelString) &&
    isLegacyModelRemapEnabled()
  ) {
    return getDefaultOpusModel() + (has1mTag ? '[1m]' : '')
  }

  if (process.env.USER_TYPE === 'ant') {
    const has1mAntTag = has1mContext(normalizedModel)
    const baseAntModel = normalizedModel.replace(/\[1m]$/i, '').trim()

    // 尝试通过 GrowthBook flag 解析 Ant 内部 codename
    const antModel = resolveAntModel(baseAntModel)
    if (antModel) {
      const suffix = has1mAntTag ? '[1m]' : ''
      return antModel.model + suffix
    }

    // codename 解析失败时回退到原始字符串（API 调用会失败，但可用于调试反馈）
  }

  // 自定义模型名（如 Azure Foundry 部署 ID）保留原始大小写
  if (has1mTag) {
    return modelInputTrimmed.replace(/\[1m\]$/i, '').trim() + '[1m]'
  }
  return modelInputTrimmed
}

/**
 * 解析 Skill frontmatter 中声明的模型，并在目标家族支持时传递 [1m] 后缀。
 *
 * 【问题背景】
 * Skill 作者写 `model: opus` 表示"使用 Opus 级别推理"而非"降级到 200K 上下文"。
 * 若用户当前处于 opus[1m]（1M 窗口），触发 Skill 时裸 alias 会丢失 1M 后缀，
 * 导致 autocompact 在 23% 使用率时触发，误报"上下文已满"。
 *
 * 【处理规则】
 * - Skill 已含 [1m]：直接返回，不做修改
 * - 当前模型无 [1m]：直接返回 skillModel
 * - 目标家族支持 1M（sonnet/opus）：追加 [1m]
 * - 目标不支持 1M（haiku）：不追加（后续 autocompact 是正确行为）
 *
 * @param skillModel   Skill frontmatter 声明的模型字符串
 * @param currentModel 当前主循环使用的模型字符串
 */
export function resolveSkillModelOverride(
  skillModel: string,
  currentModel: string,
): string {
  // Skill 已有 [1m] 或当前模型没有 [1m] → 无需传递
  if (has1mContext(skillModel) || !has1mContext(currentModel)) {
    return skillModel
  }
  // 先将 alias 解析为完整 ID 再判断 1M 支持（bareAlias 无法被 modelSupports1M 识别）
  if (modelSupports1M(parseUserSpecifiedModel(skillModel))) {
    return skillModel + '[1m]'
  }
  return skillModel
}

/** 已在第一方 API 下线的旧版 Opus 模型 ID 列表 */
const LEGACY_OPUS_FIRSTPARTY = [
  'claude-opus-4-20250514',
  'claude-opus-4-1-20250805',
  'claude-opus-4-0',
  'claude-opus-4-1',
]

/**
 * 判断给定模型 ID 是否为旧版 Opus（已在第一方 API 下线）。
 */
function isLegacyOpusFirstParty(model: string): boolean {
  return LEGACY_OPUS_FIRSTPARTY.includes(model)
}

/**
 * 判断旧版 Opus 自动重映射是否启用。
 * 可通过 CLAUDE_CODE_DISABLE_LEGACY_MODEL_REMAP=1 关闭，用于测试/调试旧版本行为。
 */
export function isLegacyModelRemapEnabled(): boolean {
  return !isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_LEGACY_MODEL_REMAP)
}

/**
 * 生成模型设置的完整展示字符串，用于 /model 命令 UI。
 * null → 显示 "Default (...)"；别名 → 显示 "alias (resolved)"（若解析后不同）。
 */
export function modelDisplayString(model: ModelSetting): string {
  if (model === null) {
    if (process.env.USER_TYPE === 'ant') {
      return `Default for Ants (${renderDefaultModelSetting(getDefaultMainLoopModelSetting())})`
    } else if (isClaudeAISubscriber()) {
      return `Default (${getClaudeAiUserDefaultModelDescription()})`
    }
    return `Default (${getDefaultMainLoopModel()})`
  }
  const resolvedModel = parseUserSpecifiedModel(model)
  // 若别名解析后结果与输入不同，同时显示别名和解析结果
  return model === resolvedModel ? resolvedModel : `${model} (${resolvedModel})`
}

// @[MODEL LAUNCH]: Add a marketing name mapping for the new model below.
/**
 * 返回模型的营销名称（含 1M 标记），用于 /model 命令的描述文字。
 * Foundry 部署 ID 是用户自定义的，无法映射，返回 undefined。
 *
 * @param modelId 完整模型 ID（可含 [1m] 标记）
 */
export function getMarketingNameForModel(modelId: string): string | undefined {
  if (getAPIProvider() === 'foundry') {
    // Foundry 部署 ID 由用户自定义，与实际模型无关，无法安全映射
    return undefined
  }

  const has1m = modelId.toLowerCase().includes('[1m]')
  const canonical = getCanonicalName(modelId)

  if (canonical.includes('claude-opus-4-6')) {
    return has1m ? 'Opus 4.6 (with 1M context)' : 'Opus 4.6'
  }
  if (canonical.includes('claude-opus-4-5')) {
    return 'Opus 4.5'
  }
  if (canonical.includes('claude-opus-4-1')) {
    return 'Opus 4.1'
  }
  if (canonical.includes('claude-opus-4')) {
    return 'Opus 4'
  }
  if (canonical.includes('claude-sonnet-4-6')) {
    return has1m ? 'Sonnet 4.6 (with 1M context)' : 'Sonnet 4.6'
  }
  if (canonical.includes('claude-sonnet-4-5')) {
    return has1m ? 'Sonnet 4.5 (with 1M context)' : 'Sonnet 4.5'
  }
  if (canonical.includes('claude-sonnet-4')) {
    return has1m ? 'Sonnet 4 (with 1M context)' : 'Sonnet 4'
  }
  if (canonical.includes('claude-3-7-sonnet')) {
    return 'Claude 3.7 Sonnet'
  }
  if (canonical.includes('claude-3-5-sonnet')) {
    return 'Claude 3.5 Sonnet'
  }
  if (canonical.includes('claude-haiku-4-5')) {
    return 'Haiku 4.5'
  }
  if (canonical.includes('claude-3-5-haiku')) {
    return 'Claude 3.5 Haiku'
  }

  return undefined
}

/**
 * 将模型字符串规范化为 API 调用格式，去除 [1m]/[2m] 等上下文窗口标记。
 * Anthropic API 不接受 [1m] 后缀，调用前必须先剥离。
 *
 * @param model 可能含 [1m]/[2m] 后缀的模型字符串
 * @returns 纯净的 API 模型 ID
 */
export function normalizeModelStringForAPI(model: string): string {
  return model.replace(/\[(1|2)m\]/gi, '')
}
