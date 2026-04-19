/**
 * Beta 功能头部管理模块。
 *
 * 在 Claude Code 系统中，该模块负责为 API 请求动态组装 beta 功能头部列表：
 * - 根据模型、提供商（firstParty / Bedrock / Vertex / Foundry）与用户类型（ant / external）
 *   自动选取适用的 beta 头部（上下文管理、交错思考、工具搜索、结构化输出、提示缓存等）
 * - 通过 GrowthBook / Statsig 特性标志按实验进行灰度控制
 * - 过滤 SDK 传入的自定义 betas（仅允许白名单中的头部）
 * - 对 Bedrock 提供商分离需放入 extra_body_params 的 beta 头部
 * - 提供 clearBetasCaches() 以便在单元测试中重置 memoize 缓存
 */
import { feature } from 'bun:bundle'
import memoize from 'lodash-es/memoize.js'
import {
  checkStatsigFeatureGate_CACHED_MAY_BE_STALE,
  getFeatureValue_CACHED_MAY_BE_STALE,
} from 'src/services/analytics/growthbook.js'
import { getIsNonInteractiveSession, getSdkBetas } from '../bootstrap/state.js'
import {
  BEDROCK_EXTRA_PARAMS_HEADERS,
  CLAUDE_CODE_20250219_BETA_HEADER,
  CLI_INTERNAL_BETA_HEADER,
  CONTEXT_1M_BETA_HEADER,
  CONTEXT_MANAGEMENT_BETA_HEADER,
  INTERLEAVED_THINKING_BETA_HEADER,
  PROMPT_CACHING_SCOPE_BETA_HEADER,
  REDACT_THINKING_BETA_HEADER,
  STRUCTURED_OUTPUTS_BETA_HEADER,
  SUMMARIZE_CONNECTOR_TEXT_BETA_HEADER,
  TOKEN_EFFICIENT_TOOLS_BETA_HEADER,
  TOOL_SEARCH_BETA_HEADER_1P,
  TOOL_SEARCH_BETA_HEADER_3P,
  WEB_SEARCH_BETA_HEADER,
} from '../constants/betas.js'
import { OAUTH_BETA_HEADER } from '../constants/oauth.js'
import { isClaudeAISubscriber } from './auth.js'
import { has1mContext } from './context.js'
import { isEnvDefinedFalsy, isEnvTruthy } from './envUtils.js'
import { getCanonicalName } from './model/model.js'
import { get3PModelCapabilityOverride } from './model/modelSupportOverrides.js'
import { getAPIProvider } from './model/providers.js'
import { getInitialSettings } from './settings/settings.js'

/**
 * SDK-provided betas that are allowed for API key users.
 * Only betas in this list can be passed via SDK options.
 */
const ALLOWED_SDK_BETAS = [CONTEXT_1M_BETA_HEADER]

/**
 * 将 SDK 传入的 betas 数组按白名单分为允许与禁止两组。
 */
function partitionBetasByAllowlist(betas: string[]): {
  allowed: string[]
  disallowed: string[]
} {
  const allowed: string[] = []
  const disallowed: string[] = []
  for (const beta of betas) {
    if (ALLOWED_SDK_BETAS.includes(beta)) {
      allowed.push(beta)
    } else {
      disallowed.push(beta)
    }
  }
  return { allowed, disallowed }
}

/**
 * 过滤 SDK 传入的自定义 betas，仅保留白名单中允许的项。
 * claude.ai 订阅用户不支持自定义 betas（仅 API key 用户可用），直接返回 undefined。
 * 对禁止的 beta 头部打印警告。
 */
export function filterAllowedSdkBetas(
  sdkBetas: string[] | undefined,
): string[] | undefined {
  if (!sdkBetas || sdkBetas.length === 0) {
    return undefined
  }

  if (isClaudeAISubscriber()) {
    // biome-ignore lint/suspicious/noConsole: intentional warning
    console.warn(
      'Warning: Custom betas are only available for API key users. Ignoring provided betas.',
    )
    return undefined
  }

  const { allowed, disallowed } = partitionBetasByAllowlist(sdkBetas)
  for (const beta of disallowed) {
    // biome-ignore lint/suspicious/noConsole: intentional warning
    console.warn(
      `Warning: Beta header '${beta}' is not allowed. Only the following betas are supported: ${ALLOWED_SDK_BETAS.join(', ')}`,
    )
  }
  return allowed.length > 0 ? allowed : undefined
}

// Generally, foundry supports all 1P features;
// however out of an abundance of caution, we do not enable any which are behind an experiment

/**
 * 判断指定模型是否支持交错思考（Interleaved Sequential Processing）。
 * Foundry 提供商默认全部支持；firstParty 仅 claude-4+ 系列支持；
 * 其他提供商（Bedrock / Vertex）仅限 opus-4 和 sonnet-4 系列。
 */
export function modelSupportsISP(model: string): boolean {
  const supported3P = get3PModelCapabilityOverride(
    model,
    'interleaved_thinking',
  )
  if (supported3P !== undefined) {
    return supported3P
  }
  const canonical = getCanonicalName(model)
  const provider = getAPIProvider()
  // Foundry supports interleaved thinking for all models
  if (provider === 'foundry') {
    return true
  }
  if (provider === 'firstParty') {
    return !canonical.includes('claude-3-')
  }
  return (
    canonical.includes('claude-opus-4') || canonical.includes('claude-sonnet-4')
  )
}

/** 检测 Vertex 提供商上指定模型是否支持 Web 搜索（仅 Claude 4.0+ 支持）。 */
function vertexModelSupportsWebSearch(model: string): boolean {
  const canonical = getCanonicalName(model)
  // Web search only supported on Claude 4.0+ models on Vertex
  return (
    canonical.includes('claude-opus-4') ||
    canonical.includes('claude-sonnet-4') ||
    canonical.includes('claude-haiku-4')
  )
}

/** 判断模型是否支持上下文管理 beta（Claude 4+ 系列；Foundry 全量支持）。 */
// Context management is supported on Claude 4+ models
export function modelSupportsContextManagement(model: string): boolean {
  const canonical = getCanonicalName(model)
  const provider = getAPIProvider()
  if (provider === 'foundry') {
    return true
  }
  if (provider === 'firstParty') {
    return !canonical.includes('claude-3-')
  }
  return (
    canonical.includes('claude-opus-4') ||
    canonical.includes('claude-sonnet-4') ||
    canonical.includes('claude-haiku-4')
  )
}

/** 判断模型是否支持结构化输出（仅 firstParty / Foundry 提供商的特定 claude-4 系列）。 */
// @[MODEL LAUNCH]: Add the new model ID to this list if it supports structured outputs.
export function modelSupportsStructuredOutputs(model: string): boolean {
  const canonical = getCanonicalName(model)
  const provider = getAPIProvider()
  // Structured outputs only supported on firstParty and Foundry (not Bedrock/Vertex yet)
  if (provider !== 'firstParty' && provider !== 'foundry') {
    return false
  }
  return (
    canonical.includes('claude-sonnet-4-6') ||
    canonical.includes('claude-sonnet-4-5') ||
    canonical.includes('claude-opus-4-1') ||
    canonical.includes('claude-opus-4-5') ||
    canonical.includes('claude-opus-4-6') ||
    canonical.includes('claude-haiku-4-5')
  )
}

/**
 * 判断模型是否支持 Auto 模式（PI probes / 安全分类器）。
 * 外部用户仅限 firstParty 提供商；ant 用户通过黑名单排除 claude-3 及早期 claude-4 系列；
 * GrowthBook allowModels 字段可强制开启指定模型。
 */
// @[MODEL LAUNCH]: Add the new model if it supports auto mode (specifically PI probes) — ask in #proj-claude-code-safety-research.
export function modelSupportsAutoMode(model: string): boolean {
  if (feature('TRANSCRIPT_CLASSIFIER')) {
    const m = getCanonicalName(model)
    // External: firstParty-only at launch (PI probes not wired for
    // Bedrock/Vertex/Foundry yet). Checked before allowModels so the GB
    // override can't enable auto mode on unsupported providers.
    if (process.env.USER_TYPE !== 'ant' && getAPIProvider() !== 'firstParty') {
      return false
    }
    // GrowthBook override: tengu_auto_mode_config.allowModels force-enables
    // auto mode for listed models, bypassing the denylist/allowlist below.
    // Exact model IDs (e.g. "claude-strudel-v6-p") match only that model;
    // canonical names (e.g. "claude-strudel") match the whole family.
    const config = getFeatureValue_CACHED_MAY_BE_STALE<{
      allowModels?: string[]
    }>('tengu_auto_mode_config', {})
    const rawLower = model.toLowerCase()
    if (
      config?.allowModels?.some(
        am => am.toLowerCase() === rawLower || am.toLowerCase() === m,
      )
    ) {
      return true
    }
    if (process.env.USER_TYPE === 'ant') {
      // Denylist: block known-unsupported claude models, allow everything else (ant-internal models etc.)
      if (m.includes('claude-3-')) return false
      // claude-*-4 not followed by -[6-9]: blocks bare -4, -4-YYYYMMDD, -4@, -4-0 thru -4-5
      if (/claude-(opus|sonnet|haiku)-4(?!-[6-9])/.test(m)) return false
      return true
    }
    // External allowlist (firstParty already checked above).
    return /^claude-(opus|sonnet)-4-6/.test(m)
  }
  return false
}

/**
 * 返回当前 API 提供商对应的工具搜索 beta 头部。
 * Vertex / Bedrock 使用 3P 版本头部，其他提供商使用 1P 版本头部。
 */
export function getToolSearchBetaHeader(): string {
  const provider = getAPIProvider()
  if (provider === 'vertex' || provider === 'bedrock') {
    return TOOL_SEARCH_BETA_HEADER_3P
  }
  return TOOL_SEARCH_BETA_HEADER_1P
}

/**
 * 判断是否应包含仅限 firstParty 的实验性 betas。
 * 条件：提供商为 firstParty 或 foundry，且未通过环境变量禁用实验性 betas。
 */
export function shouldIncludeFirstPartyOnlyBetas(): boolean {
  return (
    (getAPIProvider() === 'firstParty' || getAPIProvider() === 'foundry') &&
    !isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS)
  )
}

/**
 * 判断是否应使用全局缓存范围（prompt caching scope）。
 * 仅限 firstParty 提供商（Foundry 未纳入灰度实验数据，故不包含）。
 */
export function shouldUseGlobalCacheScope(): boolean {
  return (
    getAPIProvider() === 'firstParty' &&
    !isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS)
  )
}

/**
 * 根据模型、提供商与用户类型，组装完整的 beta 头部数组（含所有特性标志与实验控制）。
 * 结果通过 lodash memoize 按模型字符串缓存；调用 clearBetasCaches() 可重置。
 */
export const getAllModelBetas = memoize((model: string): string[] => {
  const betaHeaders = []
  const isHaiku = getCanonicalName(model).includes('haiku')
  const provider = getAPIProvider()
  const includeFirstPartyOnlyBetas = shouldIncludeFirstPartyOnlyBetas()

  if (!isHaiku) {
    betaHeaders.push(CLAUDE_CODE_20250219_BETA_HEADER)
    if (
      process.env.USER_TYPE === 'ant' &&
      process.env.CLAUDE_CODE_ENTRYPOINT === 'cli'
    ) {
      if (CLI_INTERNAL_BETA_HEADER) {
        betaHeaders.push(CLI_INTERNAL_BETA_HEADER)
      }
    }
  }
  if (isClaudeAISubscriber()) {
    betaHeaders.push(OAUTH_BETA_HEADER)
  }
  if (has1mContext(model)) {
    betaHeaders.push(CONTEXT_1M_BETA_HEADER)
  }
  if (
    !isEnvTruthy(process.env.DISABLE_INTERLEAVED_THINKING) &&
    modelSupportsISP(model)
  ) {
    betaHeaders.push(INTERLEAVED_THINKING_BETA_HEADER)
  }

  // Skip the API-side Haiku thinking summarizer — the summary is only used
  // for ctrl+o display, which interactive users rarely open. The API returns
  // redacted_thinking blocks instead; AssistantRedactedThinkingMessage already
  // renders those as a stub. SDK / print-mode keep summaries because callers
  // may iterate over thinking content. Users can opt back in via settings.json
  // showThinkingSummaries.
  if (
    includeFirstPartyOnlyBetas &&
    modelSupportsISP(model) &&
    !getIsNonInteractiveSession() &&
    getInitialSettings().showThinkingSummaries !== true
  ) {
    betaHeaders.push(REDACT_THINKING_BETA_HEADER)
  }

  // POC: server-side connector-text summarization (anti-distillation). The
  // API buffers assistant text between tool calls, summarizes it, and returns
  // the summary with a signature so the original can be restored on subsequent
  // turns — same mechanism as thinking blocks. Ant-only while we measure
  // TTFT/TTLT/capacity; betas already flow to tengu_api_success for splitting.
  // Backend independently requires Capability.ANTHROPIC_INTERNAL_RESEARCH.
  //
  // USE_CONNECTOR_TEXT_SUMMARIZATION is tri-state: =1 forces on (opt-in even
  // if GB is off), =0 forces off (opt-out of a GB rollout you were bucketed
  // into), unset defers to GB.
  if (
    SUMMARIZE_CONNECTOR_TEXT_BETA_HEADER &&
    process.env.USER_TYPE === 'ant' &&
    includeFirstPartyOnlyBetas &&
    !isEnvDefinedFalsy(process.env.USE_CONNECTOR_TEXT_SUMMARIZATION) &&
    (isEnvTruthy(process.env.USE_CONNECTOR_TEXT_SUMMARIZATION) ||
      getFeatureValue_CACHED_MAY_BE_STALE('tengu_slate_prism', false))
  ) {
    betaHeaders.push(SUMMARIZE_CONNECTOR_TEXT_BETA_HEADER)
  }

  // Add context management beta for tool clearing (ant opt-in) or thinking preservation
  const antOptedIntoToolClearing =
    isEnvTruthy(process.env.USE_API_CONTEXT_MANAGEMENT) &&
    process.env.USER_TYPE === 'ant'

  const thinkingPreservationEnabled = modelSupportsContextManagement(model)

  if (
    shouldIncludeFirstPartyOnlyBetas() &&
    (antOptedIntoToolClearing || thinkingPreservationEnabled)
  ) {
    betaHeaders.push(CONTEXT_MANAGEMENT_BETA_HEADER)
  }
  // Add strict tool use beta if experiment is enabled.
  // Gate on includeFirstPartyOnlyBetas: CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS
  // already strips schema.strict from tool bodies at api.ts's choke point, but
  // this header was escaping that kill switch. Proxy gateways that look like
  // firstParty but forward to Vertex reject this header with 400.
  // github.com/deshaw/anthropic-issues/issues/5
  const strictToolsEnabled =
    checkStatsigFeatureGate_CACHED_MAY_BE_STALE('tengu_tool_pear')
  // 3P default: false. API rejects strict + token-efficient-tools together
  // (tool_use.py:139), so these are mutually exclusive — strict wins.
  const tokenEfficientToolsEnabled =
    !strictToolsEnabled &&
    getFeatureValue_CACHED_MAY_BE_STALE('tengu_amber_json_tools', false)
  if (
    includeFirstPartyOnlyBetas &&
    modelSupportsStructuredOutputs(model) &&
    strictToolsEnabled
  ) {
    betaHeaders.push(STRUCTURED_OUTPUTS_BETA_HEADER)
  }
  // JSON tool_use format (FC v3) — ~4.5% output token reduction vs ANTML.
  // Sends the v2 header (2026-03-28) added in anthropics/anthropic#337072 to
  // isolate the CC A/B cohort from ~9.2M/week existing v1 senders. Ant-only
  // while the restored JsonToolUseOutputParser soaks.
  if (
    process.env.USER_TYPE === 'ant' &&
    includeFirstPartyOnlyBetas &&
    tokenEfficientToolsEnabled
  ) {
    betaHeaders.push(TOKEN_EFFICIENT_TOOLS_BETA_HEADER)
  }

  // Add web search beta for Vertex Claude 4.0+ models only
  if (provider === 'vertex' && vertexModelSupportsWebSearch(model)) {
    betaHeaders.push(WEB_SEARCH_BETA_HEADER)
  }
  // Foundry only ships models that already support Web Search
  if (provider === 'foundry') {
    betaHeaders.push(WEB_SEARCH_BETA_HEADER)
  }

  // Always send the beta header for 1P. The header is a no-op without a scope field.
  if (includeFirstPartyOnlyBetas) {
    betaHeaders.push(PROMPT_CACHING_SCOPE_BETA_HEADER)
  }

  // If ANTHROPIC_BETAS is set, split it by commas and add to betaHeaders.
  // This is an explicit user opt-in, so honor it regardless of model.
  if (process.env.ANTHROPIC_BETAS) {
    betaHeaders.push(
      ...process.env.ANTHROPIC_BETAS.split(',')
        .map(_ => _.trim())
        .filter(Boolean),
    )
  }
  return betaHeaders
})

/**
 * 返回指定模型的 beta 头部列表（不含 Bedrock extra_body_params 专用头部）。
 * Bedrock 提供商会过滤掉需放入 extra_body_params 的 beta 头部。
 */
export const getModelBetas = memoize((model: string): string[] => {
  const modelBetas = getAllModelBetas(model)
  if (getAPIProvider() === 'bedrock') {
    return modelBetas.filter(b => !BEDROCK_EXTRA_PARAMS_HEADERS.has(b))
  }
  return modelBetas
})

/**
 * 返回 Bedrock 提供商下需放入 extra_body_params 的 beta 头部列表。
 */
export const getBedrockExtraBodyParamsBetas = memoize(
  (model: string): string[] => {
    const modelBetas = getAllModelBetas(model)
    return modelBetas.filter(b => BEDROCK_EXTRA_PARAMS_HEADERS.has(b))
  },
)

/**
 * 合并模型自动检测的 betas 与 SDK 传入的自定义 betas（去重）。
 * SDK betas 已由 filterAllowedSdkBetas 预过滤。
 * options.isAgenticQuery 为 true 时，确保 Haiku 等模型也包含 agentic 必需的 beta 头部。
 */
export function getMergedBetas(
  model: string,
  options?: { isAgenticQuery?: boolean },
): string[] {
  const baseBetas = [...getModelBetas(model)]

  // Agentic queries always need claude-code and cli-internal beta headers.
  // For non-Haiku models these are already in baseBetas; for Haiku they're
  // excluded by getAllModelBetas() since non-agentic Haiku calls don't need them.
  if (options?.isAgenticQuery) {
    if (!baseBetas.includes(CLAUDE_CODE_20250219_BETA_HEADER)) {
      baseBetas.push(CLAUDE_CODE_20250219_BETA_HEADER)
    }
    if (
      process.env.USER_TYPE === 'ant' &&
      process.env.CLAUDE_CODE_ENTRYPOINT === 'cli' &&
      CLI_INTERNAL_BETA_HEADER &&
      !baseBetas.includes(CLI_INTERNAL_BETA_HEADER)
    ) {
      baseBetas.push(CLI_INTERNAL_BETA_HEADER)
    }
  }

  const sdkBetas = getSdkBetas()

  if (!sdkBetas || sdkBetas.length === 0) {
    return baseBetas
  }

  // Merge SDK betas without duplicates (already filtered by filterAllowedSdkBetas)
  return [...baseBetas, ...sdkBetas.filter(b => !baseBetas.includes(b))]
}

/** 清除所有 beta 相关的 memoize 缓存（用于测试重置）。 */
export function clearBetasCaches(): void {
  getAllModelBetas.cache?.clear?.()
  getModelBetas.cache?.clear?.()
  getBedrockExtraBodyParamsBetas.cache?.clear?.()
}
