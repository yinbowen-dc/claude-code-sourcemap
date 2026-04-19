/**
 * 模型思考努力程度配置模块（effort.ts）
 *
 * 【在系统流程中的位置】
 * 该模块属于模型配置层，被 REPL 命令处理器（/effort）、状态栏、API 请求构建层调用。
 * 负责将用户选择的努力程度（EffortValue）解析、转换和传递给 Anthropic API 的 thinking budget 参数。
 *
 * 【主要功能】
 * - EFFORT_LEVELS：枚举合法的努力程度字符串常量（low/medium/high/max）
 * - modelSupportsEffort()：判断模型是否支持 effort 参数
 * - modelSupportsMaxEffort()：判断模型是否支持 max 努力程度（限 Opus-4.6）
 * - parseEffortValue()：将任意输入解析为 EffortValue（字符串级别或数字）
 * - toPersistableEffort()：过滤出可持久化到 settings.json 的努力程度
 * - resolvePickerEffortPersistence()：ModelPicker 选模型时决定是否保存 effort 设置
 * - getEffortEnvOverride()：读取 CLAUDE_CODE_EFFORT_LEVEL 环境变量覆盖值
 * - resolveAppliedEffort()：按优先级链（env → appState → 模型默认值）解析实际发送给 API 的努力程度
 * - getDisplayedEffortLevel()：获取展示给用户的努力级别（用于状态栏和 /effort 输出）
 * - getEffortSuffix()：构建 Logo/Spinner 中显示的 " with {level} effort" 后缀文本
 * - convertEffortValueToLevel()：将 EffortValue 转为 EffortLevel（含数字→级别映射）
 * - getEffortLevelDescription() / getEffortValueDescription()：获取用户可读的努力程度描述
 * - getOpusDefaultEffortConfig()：获取 GrowthBook 远程配置的 Opus 默认努力程度设置
 * - getDefaultEffortForModel()：获取指定模型的默认努力程度（含订阅级别逻辑）
 */
// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
import { isUltrathinkEnabled } from './thinking.js'
import { getInitialSettings } from './settings/settings.js'
import { isProSubscriber, isMaxSubscriber, isTeamSubscriber } from './auth.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from 'src/services/analytics/growthbook.js'
import { getAPIProvider } from './model/providers.js'
import { get3PModelCapabilityOverride } from './model/modelSupportOverrides.js'
import { isEnvTruthy } from './envUtils.js'
import type { EffortLevel } from 'src/entrypoints/sdk/runtimeTypes.js'

export type { EffortLevel }

// 合法的努力程度字符串常量，按从低到高排列
export const EFFORT_LEVELS = [
  'low',
  'medium',
  'high',
  'max',
] as const satisfies readonly EffortLevel[]

// EffortValue 可以是字符串级别（EffortLevel）或 Anthropic 内部员工（ant）使用的数字值
export type EffortValue = EffortLevel | number

/**
 * 判断模型是否支持 effort 参数。
 *
 * 【流程说明】
 * 1. 若环境变量 CLAUDE_CODE_ALWAYS_ENABLE_EFFORT 为真，直接返回 true（开发/测试用）
 * 2. 查询第三方模型能力覆盖表（get3PModelCapabilityOverride）
 * 3. 检测 Claude 4 模型白名单（opus-4-6、sonnet-4-6）
 * 4. 排除已知不支持的旧模型（haiku、其他 sonnet/opus 变体）
 * 5. 对未知模型字符串：一方（firstParty）API 默认 true，第三方默认 false
 *    （第三方 model string 格式不同，如 anthropics/claude-code#30795）
 *
 * @param model  模型标识符字符串
 * @returns      模型支持 effort 参数时返回 true
 */
// @[MODEL LAUNCH]: Add the new model to the allowlist if it supports the effort parameter.
export function modelSupportsEffort(model: string): boolean {
  const m = model.toLowerCase()
  // 环境变量强制开启 effort 支持（开发调试用）
  if (isEnvTruthy(process.env.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT)) {
    return true
  }
  // 查询第三方模型能力覆盖表（返回 undefined 表示未覆盖，继续走默认逻辑）
  const supported3P = get3PModelCapabilityOverride(model, 'effort')
  if (supported3P !== undefined) {
    return supported3P
  }
  // Claude 4 中支持 effort 的模型白名单（opus-4-6 和 sonnet-4-6）
  if (m.includes('opus-4-6') || m.includes('sonnet-4-6')) {
    return true
  }
  // 排除已知不支持的旧模型（haiku 和其他旧版 sonnet/opus）
  if (m.includes('haiku') || m.includes('sonnet') || m.includes('opus')) {
    return false
  }

  // IMPORTANT: Do not change the default effort support without notifying
  // the model launch DRI and research. This is a sensitive setting that can
  // greatly affect model quality and bashing.

  // 对一方（firstParty）API 的未知模型默认为 true；第三方 API 默认为 false
  // （第三方 model string 格式不同，无法用上述规则判断）
  return getAPIProvider() === 'firstParty'
}

/**
 * 判断模型是否支持 'max' 努力程度。
 *
 * 【流程说明】
 * 1. 查询第三方模型能力覆盖表
 * 2. 检测是否为 opus-4-6（公开文档中唯一支持 max 的模型）
 * 3. ANT 内部员工：允许通过 resolveAntModel() 检测内部模型
 *
 * @param model  模型标识符字符串
 * @returns      模型支持 max 努力程度时返回 true
 */
// @[MODEL LAUNCH]: Add the new model to the allowlist if it supports 'max' effort.
// Per API docs, 'max' is Opus 4.6 only for public models — other models return an error.
export function modelSupportsMaxEffort(model: string): boolean {
  // 查询第三方模型能力覆盖表
  const supported3P = get3PModelCapabilityOverride(model, 'max_effort')
  if (supported3P !== undefined) {
    return supported3P
  }
  // 公开模型中只有 opus-4-6 支持 max
  if (model.toLowerCase().includes('opus-4-6')) {
    return true
  }
  // ANT 内部员工可以在 resolveAntModel 支持的内部模型上使用 max
  if (process.env.USER_TYPE === 'ant' && resolveAntModel(model)) {
    return true
  }
  return false
}

/**
 * 类型守卫：判断字符串是否为合法的 EffortLevel。
 *
 * @param value  待检测的字符串
 * @returns      值在 EFFORT_LEVELS 中时返回 true，并收窄类型为 EffortLevel
 */
export function isEffortLevel(value: string): value is EffortLevel {
  return (EFFORT_LEVELS as readonly string[]).includes(value)
}

/**
 * 将任意输入解析为 EffortValue（字符串级别或数字）。
 *
 * 【流程说明】
 * 1. undefined / null / '' 返回 undefined（未指定）
 * 2. 合法的数字直接返回（通过 isValidNumericEffort 校验）
 * 3. 字符串转小写后检测是否为合法 EffortLevel
 * 4. 字符串转为整数后检测是否为合法数字 effort（parseInt 失败返回 NaN）
 * 5. 以上均不匹配返回 undefined
 *
 * @param value  待解析的输入（可来自 CLI 参数、环境变量、GrowthBook 等）
 * @returns      解析成功返回 EffortValue，失败返回 undefined
 */
export function parseEffortValue(value: unknown): EffortValue | undefined {
  // 空值直接返回 undefined
  if (value === undefined || value === null || value === '') {
    return undefined
  }
  // 直接传入的合法数字
  if (typeof value === 'number' && isValidNumericEffort(value)) {
    return value
  }
  // 字符串转小写后检测是否为合法 EffortLevel
  const str = String(value).toLowerCase()
  if (isEffortLevel(str)) {
    return str
  }
  // 字符串能解析为整数时，校验后返回数字
  const numericValue = parseInt(str, 10)
  if (!isNaN(numericValue) && isValidNumericEffort(numericValue)) {
    return numericValue
  }
  // 解析失败
  return undefined
}

/**
 * 过滤出可以持久化到 settings.json 的努力程度值。
 *
 * 【流程说明】
 * - low / medium / high 可以持久化（外部用户可写入 settings.json）
 * - 'max' 仅 ant 内部员工可持久化；外部用户的 max 是会话级别（不写入文件）
 * - 数字值（ant-only）永远不持久化（Zod schema 仅接受字符串 level）
 *
 * 调用方在保存到 settings.json 之前应先调用此函数，防止 Zod schema 拒绝写入。
 *
 * @param value  待持久化的 EffortValue
 * @returns      可安全写入 settings.json 的 EffortLevel，或 undefined（不写入）
 *
 * Numeric values are model-default only and not persisted.
 * 'max' is session-scoped for external users (ants can persist it).
 * Write sites call this before saving to settings so the Zod schema
 * (which only accepts string levels) never rejects a write.
 */
export function toPersistableEffort(
  value: EffortValue | undefined,
): EffortLevel | undefined {
  // low / medium / high 三个级别对外部用户均可持久化
  if (value === 'low' || value === 'medium' || value === 'high') {
    return value
  }
  // max 仅 ant 内部员工可持久化（外部用户 max 是会话级别）
  if (value === 'max' && process.env.USER_TYPE === 'ant') {
    return value
  }
  // 数字值和外部用户的 max 都不持久化
  return undefined
}

/**
 * 读取初始设置中的努力程度，经 toPersistableEffort 过滤后返回。
 *
 * 【流程说明】
 * 调用 toPersistableEffort 是为了防止手动编辑的 settings.json 中的 'max'
 * 在非 ant 用户的新会话中被错误读取为持久化设置。
 *
 * @returns  可持久化的 EffortLevel，或 undefined
 */
export function getInitialEffortSetting(): EffortLevel | undefined {
  // toPersistableEffort 会过滤掉非 ant 用户的 'max'，避免手动编辑的 settings.json 泄漏
  return toPersistableEffort(getInitialSettings().effortLevel)
}

/**
 * 决定在 ModelPicker 中选择模型时是否将当前努力程度持久化到 settings.json。
 *
 * 【流程说明】
 * - 若用户之前明确设置过 effort（priorPersisted 不为 undefined）或在 picker 中切换过，
 *   保留当前选中的努力程度（即使与模型默认值相同）
 * - 若当前选中的努力程度与模型默认值不同，也保存（用户有意偏离默认值）
 * - 否则返回 undefined，让 effort 跟随未来模型默认值的变化自动更新
 *
 * 注意：priorPersisted 必须来自磁盘上的 userSettings（不能使用 AppState.effortValue，
 * 因为 AppState 包含会话级别的来源，如 CLI --effort，这些不应写入 settings.json）。
 *
 * @param picked          picker 中选中的努力级别
 * @param modelDefault    所选模型的默认努力级别
 * @param priorPersisted  磁盘 userSettings 中已保存的努力级别
 * @param toggledInPicker 用户是否在 picker 中主动切换过 effort
 * @returns               应写入 settings.json 的 EffortLevel，或 undefined（不写入）
 *
 * Decide what effort level (if any) to persist when the user selects a model
 * in ModelPicker. Keeps an explicit prior /effort choice sticky even when it
 * matches the picked model's default, while letting purely-default and
 * session-ephemeral effort (CLI --effort, EffortCallout default) fall through
 * to undefined so it follows future model-default changes.
 *
 * priorPersisted must come from userSettings on disk
 * (getSettingsForSource('userSettings')?.effortLevel), NOT merged settings
 * (project/policy layers would leak into the user's global settings.json)
 * and NOT AppState.effortValue (includes session-scoped sources that
 * deliberately do not write to settings.json).
 */
export function resolvePickerEffortPersistence(
  picked: EffortLevel | undefined,
  modelDefault: EffortLevel,
  priorPersisted: EffortLevel | undefined,
  toggledInPicker: boolean,
): EffortLevel | undefined {
  // 用户之前有明确设置或在 picker 中切换过，则保留当前选中值
  const hadExplicit = priorPersisted !== undefined || toggledInPicker
  // 若用户有明确意图，或选中值偏离模型默认值，则持久化；否则返回 undefined
  return hadExplicit || picked !== modelDefault ? picked : undefined
}

/**
 * 读取 CLAUDE_CODE_EFFORT_LEVEL 环境变量的覆盖值。
 *
 * 【流程说明】
 * - 'unset' 或 'auto' 返回 null（明确指示不发送 effort 参数）
 * - 其他值通过 parseEffortValue() 解析（解析失败返回 undefined）
 *
 * @returns  解析后的 EffortValue；null 表示明确禁用；undefined 表示未设置
 */
export function getEffortEnvOverride(): EffortValue | null | undefined {
  const envOverride = process.env.CLAUDE_CODE_EFFORT_LEVEL
  // 'unset' 或 'auto' 明确指示不发送 effort 参数
  return envOverride?.toLowerCase() === 'unset' ||
    envOverride?.toLowerCase() === 'auto'
    ? null
    : parseEffortValue(envOverride)
}

/**
 * 按优先级链解析实际发送给 API 的努力程度值。
 *
 * 【优先级链（从高到低）】
 * 1. CLAUDE_CODE_EFFORT_LEVEL 环境变量覆盖
 * 2. AppState.effortValue（会话级别设置，包含 /effort 命令、CLI --effort 等）
 * 3. 模型默认值（getDefaultEffortForModel）
 *
 * 【特殊处理】
 * - env 为 null（'unset'/'auto'）时返回 undefined，表示不发送 effort 参数
 * - 非 Opus-4.6 模型请求 'max' 时，API 会报错，自动降级为 'high'
 *
 * @param model               当前使用的模型标识符
 * @param appStateEffortValue AppState 中保存的会话级别努力程度
 * @returns                   应发送给 API 的 EffortValue，或 undefined（不发送）
 *
 * Resolve the effort value that will actually be sent to the API for a given
 * model, following the full precedence chain:
 *   env CLAUDE_CODE_EFFORT_LEVEL → appState.effortValue → model default
 *
 * Returns undefined when no effort parameter should be sent (env set to
 * 'unset', or no default exists for the model).
 */
export function resolveAppliedEffort(
  model: string,
  appStateEffortValue: EffortValue | undefined,
): EffortValue | undefined {
  // 读取环境变量覆盖值
  const envOverride = getEffortEnvOverride()
  // null 表示明确禁用 effort 参数（'unset'/'auto'）
  if (envOverride === null) {
    return undefined
  }
  // 按优先级链：env → appState → 模型默认值
  const resolved =
    envOverride ?? appStateEffortValue ?? getDefaultEffortForModel(model)
  // 非 Opus-4.6 模型请求 max 时 API 会报错，自动降级为 high
  if (resolved === 'max' && !modelSupportsMaxEffort(model)) {
    return 'high'
  }
  return resolved
}

/**
 * 获取展示给用户的努力级别（用于状态栏和 /effort 输出）。
 *
 * 【流程说明】
 * 包装 resolveAppliedEffort()，API 未设置 effort 时使用 'high' 作为后备值
 * （对应 API 的隐式默认行为）。调用 convertEffortValueToLevel 将数值转为级别字符串。
 *
 * @param model           当前模型标识符
 * @param appStateEffort  AppState 中的会话级别努力程度
 * @returns               展示给用户的 EffortLevel（永不返回 undefined）
 *
 * Resolve the effort level to show the user. Wraps resolveAppliedEffort
 * with the 'high' fallback (what the API uses when no effort param is sent).
 * Single source of truth for the status bar and /effort output (CC-1088).
 */
export function getDisplayedEffortLevel(
  model: string,
  appStateEffort: EffortValue | undefined,
): EffortLevel {
  // resolveAppliedEffort 返回 undefined 时（未设置），API 默认为 high
  const resolved = resolveAppliedEffort(model, appStateEffort) ?? 'high'
  return convertEffortValueToLevel(resolved)
}

/**
 * 构建 Logo/Spinner 中显示的努力程度后缀文本。
 *
 * 【流程说明】
 * - effortValue 未设置时返回空字符串（用户没有明确指定 effort，不显示后缀）
 * - 调用 resolveAppliedEffort() 获取实际发送给 API 的值（含 max→high 降级）
 * - 返回格式：" with {level} effort"（注意前导空格）
 *
 * @param model        当前模型标识符
 * @param effortValue  AppState 中的努力程度值
 * @returns            后缀字符串（空字符串或 " with {level} effort"）
 *
 * Build the ` with {level} effort` suffix shown in Logo/Spinner.
 * Returns empty string if the user hasn't explicitly set an effort value.
 * Delegates to resolveAppliedEffort() so the displayed level matches what
 * the API actually receives (including max→high clamp for non-Opus models).
 */
export function getEffortSuffix(
  model: string,
  effortValue: EffortValue | undefined,
): string {
  // 用户没有设置 effort，不显示后缀
  if (effortValue === undefined) return ''
  // 获取实际发送给 API 的值（含 max→high 降级）
  const resolved = resolveAppliedEffort(model, effortValue)
  if (resolved === undefined) return ''
  return ` with ${convertEffortValueToLevel(resolved)} effort`
}

/**
 * 校验数字是否为合法的 numeric effort 值（必须为整数）。
 *
 * @param value  待校验的数字
 * @returns      整数返回 true
 */
export function isValidNumericEffort(value: number): boolean {
  return Number.isInteger(value)
}

/**
 * 将 EffortValue 转换为用户可见的 EffortLevel 字符串。
 *
 * 【流程说明】
 * - 字符串类型：已知 level 直接返回，未知字符串降级为 'high'（防御 GrowthBook 远程配置类型不安全）
 * - 数字类型（ant-only）：按区间映射到级别（≤50→low, ≤85→medium, ≤100→high, >100→max）
 * - 外部用户传入数字时一律返回 'high'（不应发生，防御性处理）
 *
 * @param value  待转换的 EffortValue
 * @returns      对应的 EffortLevel 字符串
 */
export function convertEffortValueToLevel(value: EffortValue): EffortLevel {
  if (typeof value === 'string') {
    // 运行时防御：value 可能来自 GrowthBook 远程配置，TypeScript 类型无法保证
    // 未知字符串降级为 'high'，避免传入无效值
    return isEffortLevel(value) ? value : 'high'
  }
  // 数字类型仅用于 ANT 内部员工，按区间映射到级别
  if (process.env.USER_TYPE === 'ant' && typeof value === 'number') {
    if (value <= 50) return 'low'
    if (value <= 85) return 'medium'
    if (value <= 100) return 'high'
    return 'max'
  }
  // 外部用户传入数字时一律返回 'high'（不应发生）
  return 'high'
}

/**
 * 获取努力程度级别的用户可读描述文本。
 *
 * @param level  努力程度级别
 * @returns      对应的用户可读描述字符串
 *
 * Get user-facing description for effort levels
 *
 * @param level The effort level to describe
 * @returns Human-readable description
 */
export function getEffortLevelDescription(level: EffortLevel): string {
  switch (level) {
    case 'low':
      return 'Quick, straightforward implementation with minimal overhead'
    case 'medium':
      return 'Balanced approach with standard implementation and testing'
    case 'high':
      return 'Comprehensive implementation with extensive testing and documentation'
    case 'max':
      return 'Maximum capability with deepest reasoning (Opus 4.6 only)'
  }
}

/**
 * 获取努力程度值（字符串级别或数字）的用户可读描述文本。
 *
 * 【流程说明】
 * - ant 内部员工传入数字时，显示数字值（ANT-ONLY 标记）
 * - 字符串类型委托 getEffortLevelDescription() 处理
 * - 其他情况返回 medium 级别的描述（后备值）
 *
 * @param value  努力程度值
 * @returns      对应的用户可读描述字符串
 *
 * Get user-facing description for effort values (both string and numeric)
 *
 * @param value The effort value to describe
 * @returns Human-readable description
 */
export function getEffortValueDescription(value: EffortValue): string {
  // ant 内部员工使用数字值时，显示数字（仅内部可见）
  if (process.env.USER_TYPE === 'ant' && typeof value === 'number') {
    return `[ANT-ONLY] Numeric effort value of ${value}`
  }

  // 字符串级别委托 getEffortLevelDescription 处理
  if (typeof value === 'string') {
    return getEffortLevelDescription(value)
  }
  // 后备值（外部用户传入数字时不应发生）
  return 'Balanced approach with standard implementation and testing'
}

// Opus 默认努力程度配置（通过 GrowthBook 远程控制）
export type OpusDefaultEffortConfig = {
  enabled: boolean
  dialogTitle: string
  dialogDescription: string
}

// GrowthBook 远程配置不可用时的本地默认值
const OPUS_DEFAULT_EFFORT_CONFIG_DEFAULT: OpusDefaultEffortConfig = {
  enabled: true,
  dialogTitle: 'We recommend medium effort for Opus',
  dialogDescription:
    'Effort determines how long Claude thinks for when completing your task. We recommend medium effort for most tasks to balance speed and intelligence and maximize rate limits. Use ultrathink to trigger high effort when needed.',
}

/**
 * 获取 GrowthBook 远程配置的 Opus 默认努力程度设置。
 *
 * 【流程说明】
 * 1. 调用 getFeatureValue_CACHED_MAY_BE_STALE 读取 'tengu_grey_step2' 功能标志
 * 2. 将远程配置与本地默认值合并（远程配置字段覆盖本地默认）
 * 3. 返回合并后的配置对象
 *
 * 注意：GrowthBook 的缓存值可能稍有延迟（CACHED_MAY_BE_STALE），
 * 仅用于 UI 展示，不影响实际发送给 API 的参数。
 *
 * @returns  合并后的 Opus 默认努力程度配置对象
 */
export function getOpusDefaultEffortConfig(): OpusDefaultEffortConfig {
  // 读取 GrowthBook 远程配置（可能稍有延迟）
  const config = getFeatureValue_CACHED_MAY_BE_STALE(
    'tengu_grey_step2',
    OPUS_DEFAULT_EFFORT_CONFIG_DEFAULT,
  )
  // 将远程配置与本地默认值合并（远程字段优先）
  return {
    ...OPUS_DEFAULT_EFFORT_CONFIG_DEFAULT,
    ...config,
  }
}

/**
 * 获取指定模型的默认努力程度值。
 *
 * 【流程说明（外部用户路径）】
 * 1. Opus-4.6 + Pro 订阅：默认 medium
 * 2. Opus-4.6 + GrowthBook tengu_grey_step2 启用 + Max/Team 订阅：默认 medium
 * 3. ultrathink 功能开启且模型支持 effort：默认 medium（ultrathink 触发时升级为 high）
 * 4. 其他情况：返回 undefined（不发送 effort 参数，API 默认 high）
 *
 * 【流程说明（ant 内部员工路径）】
 * 1. 检测 GrowthBook 覆盖配置中的默认模型和 defaultModelEffortLevel
 * 2. 检测 resolveAntModel() 返回的内部模型配置中的 defaultEffortLevel/defaultEffortValue
 * 3. 以上均无覆盖时返回 undefined（ant 默认 undefined/high）
 *
 * @param model  模型标识符字符串
 * @returns      该模型的默认 EffortValue，或 undefined（使用 API 默认值）
 */
// @[MODEL LAUNCH]: Update the default effort levels for new models
export function getDefaultEffortForModel(
  model: string,
): EffortValue | undefined {
  if (process.env.USER_TYPE === 'ant') {
    // ant 内部员工：检测 GrowthBook 覆盖配置
    const config = getAntModelOverrideConfig()
    const isDefaultModel =
      config?.defaultModel !== undefined &&
      model.toLowerCase() === config.defaultModel.toLowerCase()
    // 若当前模型匹配 GrowthBook 配置的默认模型，使用配置的默认努力级别
    if (isDefaultModel && config?.defaultModelEffortLevel) {
      return config.defaultModelEffortLevel
    }
    // 检测内部模型配置表
    const antModel = resolveAntModel(model)
    if (antModel) {
      // 优先使用字符串级别，次优先使用数字值
      if (antModel.defaultEffortLevel) {
        return antModel.defaultEffortLevel
      }
      if (antModel.defaultEffortValue !== undefined) {
        return antModel.defaultEffortValue
      }
    }
    // ant 默认返回 undefined（使用 API 默认 high）
    return undefined
  }

  // IMPORTANT: Do not change the default effort level without notifying
  // the model launch DRI and research. Default effort is a sensitive setting
  // that can greatly affect model quality and bashing.

  // Opus-4.6 + Pro 订阅：默认 medium
  if (model.toLowerCase().includes('opus-4-6')) {
    if (isProSubscriber()) {
      return 'medium'
    }
    // Opus-4.6 + GrowthBook 配置启用 + Max/Team 订阅：也默认 medium
    if (
      getOpusDefaultEffortConfig().enabled &&
      (isMaxSubscriber() || isTeamSubscriber())
    ) {
      return 'medium'
    }
  }

  // ultrathink 功能开启且模型支持 effort：默认 medium（ultrathink 按需升级为 high）
  if (isUltrathinkEnabled() && modelSupportsEffort(model)) {
    return 'medium'
  }

  // 其他情况不设置 effort，API 默认使用 high
  return undefined
}
