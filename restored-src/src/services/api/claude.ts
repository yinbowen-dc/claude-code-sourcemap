/**
 * 【核心 LLM 查询模块】services/api/claude.ts
 *
 * 在 Claude Code 系统流程中的位置：
 * - 系统最核心的 API 调用层，所有与 Anthropic API 的通信均经过此模块
 * - 被 query.ts（代理循环）、queryHaiku（轻量查询）、compact 等模块调用
 * - 通过 withStreamingVCR 支持 VCR（测试回放）能力
 * - 依赖 client.ts 获取 Anthropic SDK 客户端，依赖 withRetry.ts 处理重试逻辑
 *
 * 核心功能：
 * - queryModel(): 核心异步生成器，处理完整的 API 请求生命周期（流式+降级非流式）
 * - queryModelWithStreaming() / queryModelWithoutStreaming(): queryModel 的流式/非流式包装器
 * - executeNonStreamingRequest(): 非流式降级请求的辅助生成器（流式失败时回退）
 * - getExtraBodyParams(): 组装 CLAUDE_CODE_EXTRA_BODY 等额外 body 参数（含反蒸馏）
 * - getPromptCachingEnabled() / getCacheControl() / should1hCacheTTL(): 提示缓存策略
 * - configureEffortParams() / configureTaskBudgetParams(): effort 与 task_budget 参数注入
 * - getAPIMetadata(): 构造 user_id JSON（含 device_id / account_uuid / session_id）
 * - addCacheBreakpoints(): 为消息数组添加 cache_control 断点（含 cachedMC 的 cache_edits）
 * - buildSystemPromptBlocks(): 将系统提示转换为带缓存控制的 TextBlockParam 数组
 * - updateUsage() / accumulateUsage(): 流式事件中的 token 用量追踪与累加
 * - queryHaiku() / queryWithModel(): 用于简单查询场景的单轮便利函数
 *
 * 关键设计决策：
 * - sticky-on beta header 锁存：AFK、快速模式、缓存编辑等 beta header 一旦发送就持续发送，
 *   防止中途修改导致服务端缓存 key 变化（约 50-70K token 的缓存破坏代价）
 * - 1h 提示缓存 TTL 资格在 bootstrap 状态中锁存，防止 GrowthBook 磁盘缓存更新引起
 *   中途 TTL 切换（每次切换浪费约 20K token 重建缓存）
 * - 非流式降级：流式请求失败时自动降级到非流式，并通过 executeNonStreamingRequest 重试
 * - 流式看门狗（CLAUDE_ENABLE_STREAM_WATCHDOG）：90s 无数据包时主动终止悬空连接
 * - 工具搜索（tool search）：通过 deferredToolNames 集合和 defer_loading 动态加载工具
 * - 全局缓存范围（global cache scope）：MCP 工具（per-user/动态）时不能使用全局缓存标记
 * - off-switch：GrowthBook `tengu-off-switch` 激活时阻断 Opus 查询（订阅用户豁免）
 */

import type {
  BetaContentBlock,
  BetaContentBlockParam,
  BetaImageBlockParam,
  BetaJSONOutputFormat,
  BetaMessage,
  BetaMessageDeltaUsage,
  BetaMessageStreamParams,
  BetaOutputConfig,
  BetaRawMessageStreamEvent,
  BetaRequestDocumentBlock,
  BetaStopReason,
  BetaToolChoiceAuto,
  BetaToolChoiceTool,
  BetaToolResultBlockParam,
  BetaToolUnion,
  BetaUsage,
  BetaMessageParam as MessageParam,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import type { TextBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import type { Stream } from '@anthropic-ai/sdk/streaming.mjs'
import { randomUUID } from 'crypto'
import {
  getAPIProvider,
  isFirstPartyAnthropicBaseUrl,
} from 'src/utils/model/providers.js'
import {
  getAttributionHeader,
  getCLISyspromptPrefix,
} from '../../constants/system.js'
import {
  getEmptyToolPermissionContext,
  type QueryChainTracking,
  type Tool,
  type ToolPermissionContext,
  type Tools,
  toolMatchesName,
} from '../../Tool.js'
import type { AgentDefinition } from '../../tools/AgentTool/loadAgentsDir.js'
import {
  type ConnectorTextBlock,
  type ConnectorTextDelta,
  isConnectorTextBlock,
} from '../../types/connectorText.js'
import type {
  AssistantMessage,
  Message,
  StreamEvent,
  SystemAPIErrorMessage,
  UserMessage,
} from '../../types/message.js'
import {
  type CacheScope,
  logAPIPrefix,
  splitSysPromptPrefix,
  toolToAPISchema,
} from '../../utils/api.js'
import { getOauthAccountInfo } from '../../utils/auth.js'
import {
  getBedrockExtraBodyParamsBetas,
  getMergedBetas,
  getModelBetas,
} from '../../utils/betas.js'
import { getOrCreateUserID } from '../../utils/config.js'
import {
  CAPPED_DEFAULT_MAX_TOKENS,
  getModelMaxOutputTokens,
  getSonnet1mExpTreatmentEnabled,
} from '../../utils/context.js'
import { resolveAppliedEffort } from '../../utils/effort.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { errorMessage } from '../../utils/errors.js'
import { computeFingerprintFromMessages } from '../../utils/fingerprint.js'
import { captureAPIRequest, logError } from '../../utils/log.js'
import {
  createAssistantAPIErrorMessage,
  createUserMessage,
  ensureToolResultPairing,
  normalizeContentFromAPI,
  normalizeMessagesForAPI,
  stripAdvisorBlocks,
  stripCallerFieldFromAssistantMessage,
  stripToolReferenceBlocksFromUserMessage,
} from '../../utils/messages.js'
import {
  getDefaultOpusModel,
  getDefaultSonnetModel,
  getSmallFastModel,
  isNonCustomOpusModel,
} from '../../utils/model/model.js'
import {
  asSystemPrompt,
  type SystemPrompt,
} from '../../utils/systemPromptType.js'
import { tokenCountFromLastAPIResponse } from '../../utils/tokens.js'
import { getDynamicConfig_BLOCKS_ON_INIT } from '../analytics/growthbook.js'
import {
  currentLimits,
  extractQuotaStatusFromError,
  extractQuotaStatusFromHeaders,
} from '../claudeAiLimits.js'
import { getAPIContextManagement } from '../compact/apiMicrocompact.js'

/* eslint-disable @typescript-eslint/no-require-imports */
const autoModeStateModule = feature('TRANSCRIPT_CLASSIFIER')
  ? (require('../../utils/permissions/autoModeState.js') as typeof import('../../utils/permissions/autoModeState.js'))
  : null

import { feature } from 'bun:bundle'
import type { ClientOptions } from '@anthropic-ai/sdk'
import {
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
} from '@anthropic-ai/sdk/error'
import {
  getAfkModeHeaderLatched,
  getCacheEditingHeaderLatched,
  getFastModeHeaderLatched,
  getLastApiCompletionTimestamp,
  getPromptCache1hAllowlist,
  getPromptCache1hEligible,
  getSessionId,
  getThinkingClearLatched,
  setAfkModeHeaderLatched,
  setCacheEditingHeaderLatched,
  setFastModeHeaderLatched,
  setLastMainRequestId,
  setPromptCache1hAllowlist,
  setPromptCache1hEligible,
  setThinkingClearLatched,
} from 'src/bootstrap/state.js'
import {
  AFK_MODE_BETA_HEADER,
  CONTEXT_1M_BETA_HEADER,
  CONTEXT_MANAGEMENT_BETA_HEADER,
  EFFORT_BETA_HEADER,
  FAST_MODE_BETA_HEADER,
  PROMPT_CACHING_SCOPE_BETA_HEADER,
  REDACT_THINKING_BETA_HEADER,
  STRUCTURED_OUTPUTS_BETA_HEADER,
  TASK_BUDGETS_BETA_HEADER,
} from 'src/constants/betas.js'
import type { QuerySource } from 'src/constants/querySource.js'
import type { Notification } from 'src/context/notifications.js'
import { addToTotalSessionCost } from 'src/cost-tracker.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from 'src/services/analytics/growthbook.js'
import type { AgentId } from 'src/types/ids.js'
import {
  ADVISOR_TOOL_INSTRUCTIONS,
  getExperimentAdvisorModels,
  isAdvisorEnabled,
  isValidAdvisorModel,
  modelSupportsAdvisor,
} from 'src/utils/advisor.js'
import { getAgentContext } from 'src/utils/agentContext.js'
import { isClaudeAISubscriber } from 'src/utils/auth.js'
import {
  getToolSearchBetaHeader,
  modelSupportsStructuredOutputs,
  shouldIncludeFirstPartyOnlyBetas,
  shouldUseGlobalCacheScope,
} from 'src/utils/betas.js'
import { CLAUDE_IN_CHROME_MCP_SERVER_NAME } from 'src/utils/claudeInChrome/common.js'
import { CHROME_TOOL_SEARCH_INSTRUCTIONS } from 'src/utils/claudeInChrome/prompt.js'
import { getMaxThinkingTokensForModel } from 'src/utils/context.js'
import { logForDebugging } from 'src/utils/debug.js'
import { logForDiagnosticsNoPII } from 'src/utils/diagLogs.js'
import { type EffortValue, modelSupportsEffort } from 'src/utils/effort.js'
import {
  isFastModeAvailable,
  isFastModeCooldown,
  isFastModeEnabled,
  isFastModeSupportedByModel,
} from 'src/utils/fastMode.js'
import { returnValue } from 'src/utils/generators.js'
import { headlessProfilerCheckpoint } from 'src/utils/headlessProfiler.js'
import { isMcpInstructionsDeltaEnabled } from 'src/utils/mcpInstructionsDelta.js'
import { calculateUSDCost } from 'src/utils/modelCost.js'
import { endQueryProfile, queryCheckpoint } from 'src/utils/queryProfiler.js'
import {
  modelSupportsAdaptiveThinking,
  modelSupportsThinking,
  type ThinkingConfig,
} from 'src/utils/thinking.js'
import {
  extractDiscoveredToolNames,
  isDeferredToolsDeltaEnabled,
  isToolSearchEnabled,
} from 'src/utils/toolSearch.js'
import { API_MAX_MEDIA_PER_REQUEST } from '../../constants/apiLimits.js'
import { ADVISOR_BETA_HEADER } from '../../constants/betas.js'
import {
  formatDeferredToolLine,
  isDeferredTool,
  TOOL_SEARCH_TOOL_NAME,
} from '../../tools/ToolSearchTool/prompt.js'
import { count } from '../../utils/array.js'
import { insertBlockAfterToolResults } from '../../utils/contentArray.js'
import { validateBoundedIntEnvVar } from '../../utils/envValidation.js'
import { safeParseJSON } from '../../utils/json.js'
import { getInferenceProfileBackingModel } from '../../utils/model/bedrock.js'
import {
  normalizeModelStringForAPI,
  parseUserSpecifiedModel,
} from '../../utils/model/model.js'
import {
  startSessionActivity,
  stopSessionActivity,
} from '../../utils/sessionActivity.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import {
  isBetaTracingEnabled,
  type LLMRequestNewContext,
  startLLMRequestSpan,
} from '../../utils/telemetry/sessionTracing.js'
/* eslint-enable @typescript-eslint/no-require-imports */
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../analytics/index.js'
import {
  consumePendingCacheEdits,
  getPinnedCacheEdits,
  markToolsSentToAPIState,
  pinCacheEdits,
} from '../compact/microCompact.js'
import { getInitializationStatus } from '../lsp/manager.js'
import { isToolFromMcpServer } from '../mcp/utils.js'
import { withStreamingVCR, withVCR } from '../vcr.js'
import { CLIENT_REQUEST_ID_HEADER, getAnthropicClient } from './client.js'
import {
  API_ERROR_MESSAGE_PREFIX,
  CUSTOM_OFF_SWITCH_MESSAGE,
  getAssistantMessageFromError,
  getErrorMessageIfRefusal,
} from './errors.js'
import {
  EMPTY_USAGE,
  type GlobalCacheStrategy,
  logAPIError,
  logAPIQuery,
  logAPISuccessAndDuration,
  type NonNullableUsage,
} from './logging.js'
import {
  CACHE_TTL_1HOUR_MS,
  checkResponseForCacheBreak,
  recordPromptState,
} from './promptCacheBreakDetection.js'
import {
  CannotRetryError,
  FallbackTriggeredError,
  is529Error,
  type RetryContext,
  withRetry,
} from './withRetry.js'

// Define a type that represents valid JSON values
type JsonValue = string | number | boolean | null | JsonObject | JsonArray
type JsonObject = { [key: string]: JsonValue }
type JsonArray = JsonValue[]

/**
 * 组装 API 请求的额外 body 参数
 *
 * 数据来源优先级：
 * 1. 用户通过 CLAUDE_CODE_EXTRA_BODY 环境变量设置的自定义参数（需为 JSON 对象）
 * 2. 反蒸馏（anti_distillation）参数——仅对 1P CLI + ant 用户 + GrowthBook 开启时注入
 * 3. Bedrock 请求需要的 beta headers（放入 anthropic_beta 数组而非 HTTP header）
 *
 * @param betaHeaders - Bedrock 专用的额外 beta header 列表
 * @returns 合并后的额外 body 参数 JSON 对象
 */
export function getExtraBodyParams(betaHeaders?: string[]): JsonObject {
  // 先解析用户通过环境变量设置的自定义参数
  const extraBodyStr = process.env.CLAUDE_CODE_EXTRA_BODY
  let result: JsonObject = {}

  if (extraBodyStr) {
    try {
      // 解析 JSON，可以为 null、boolean、number、string、数组或对象
      const parsed = safeParseJSON(extraBodyStr)
      // 期望是键值对对象，以便展开到 API 参数中
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        // 浅拷贝 — safeParseJSON 使用 LRU 缓存，相同字符串返回同一对象引用
        // 若直接修改 result 会污染缓存，导致后续调用使用到脏数据
        result = { ...(parsed as JsonObject) }
      } else {
        logForDebugging(
          `CLAUDE_CODE_EXTRA_BODY env var must be a JSON object, but was given ${extraBodyStr}`,
          { level: 'error' },
        )
      }
    } catch (error) {
      logForDebugging(
        `Error parsing CLAUDE_CODE_EXTRA_BODY: ${errorMessage(error)}`,
        { level: 'error' },
      )
    }
  }

  // 反蒸馏：仅对 1P CLI + GrowthBook 功能开启时注入 fake_tools
  if (
    feature('ANTI_DISTILLATION_CC')
      ? process.env.CLAUDE_CODE_ENTRYPOINT === 'cli' &&
        shouldIncludeFirstPartyOnlyBetas() &&
        getFeatureValue_CACHED_MAY_BE_STALE(
          'tengu_anti_distill_fake_tool_injection',
          false,
        )
      : false
  ) {
    result.anti_distillation = ['fake_tools'] // 注入反蒸馏伪工具参数
  }

  // 处理 Bedrock 专用的 beta header（Bedrock 需放入 body 而非 HTTP header）
  if (betaHeaders && betaHeaders.length > 0) {
    if (result.anthropic_beta && Array.isArray(result.anthropic_beta)) {
      // 追加到已有数组，去重防止重复
      const existingHeaders = result.anthropic_beta as string[]
      const newHeaders = betaHeaders.filter(
        header => !existingHeaders.includes(header),
      )
      result.anthropic_beta = [...existingHeaders, ...newHeaders]
    } else {
      // 初始化 beta header 数组
      result.anthropic_beta = betaHeaders
    }
  }

  return result
}

/**
 * 判断指定模型是否应启用提示缓存（prompt caching）
 *
 * 优先级由高到低：
 * 1. DISABLE_PROMPT_CACHING 全局禁用
 * 2. DISABLE_PROMPT_CACHING_HAIKU 仅禁用 Haiku（小模型）
 * 3. DISABLE_PROMPT_CACHING_SONNET 仅禁用 Sonnet
 * 4. DISABLE_PROMPT_CACHING_OPUS 仅禁用 Opus
 * 5. 默认启用
 */
export function getPromptCachingEnabled(model: string): boolean {
  // 全局禁用优先级最高
  if (isEnvTruthy(process.env.DISABLE_PROMPT_CACHING)) return false

  // 按模型类型单独禁用
  if (isEnvTruthy(process.env.DISABLE_PROMPT_CACHING_HAIKU)) {
    const smallFastModel = getSmallFastModel()
    if (model === smallFastModel) return false
  }

  // 禁用默认 Sonnet 模型的缓存
  if (isEnvTruthy(process.env.DISABLE_PROMPT_CACHING_SONNET)) {
    const defaultSonnet = getDefaultSonnetModel()
    if (model === defaultSonnet) return false
  }

  // 禁用默认 Opus 模型的缓存
  if (isEnvTruthy(process.env.DISABLE_PROMPT_CACHING_OPUS)) {
    const defaultOpus = getDefaultOpusModel()
    if (model === defaultOpus) return false
  }

  return true
}

/**
 * 构造 cache_control 对象，控制服务端缓存行为
 *
 * 根据 querySource 决定是否使用 1h TTL（长效缓存），
 * 根据 scope 决定是否使用全局缓存范围（global cache scope）。
 * 全局范围需配合 PROMPT_CACHING_SCOPE_BETA_HEADER 使用。
 */
export function getCacheControl({
  scope,
  querySource,
}: {
  scope?: CacheScope
  querySource?: QuerySource
} = {}): {
  type: 'ephemeral'
  ttl?: '1h'
  scope?: CacheScope
} {
  return {
    type: 'ephemeral',
    ...(should1hCacheTTL(querySource) && { ttl: '1h' }),
    ...(scope === 'global' && { scope }),
  }
}

/**
 * 判断是否应对当前请求使用 1h TTL 提示缓存
 *
 * 触发条件（需全部满足）：
 * 1. 用户有资格（ant 员工 或 订阅用户且未超配额）——资格在 bootstrap 状态中锁存，
 *    防止 GrowthBook 磁盘缓存更新导致同一会话中途切换 TTL（会破坏服务端缓存 ~20K token）
 * 2. querySource 与 GrowthBook allowlist 匹配（支持 * 前缀通配）
 *
 * 特例：Bedrock 3P 用户通过 ENABLE_PROMPT_CACHING_1H_BEDROCK 直接启用，无需 GrowthBook
 */
function should1hCacheTTL(querySource?: QuerySource): boolean {
  // Bedrock 第三方用户自行管理账单，通过环境变量直接启用，无需 GrowthBook 配置
  if (
    getAPIProvider() === 'bedrock' &&
    isEnvTruthy(process.env.ENABLE_PROMPT_CACHING_1H_BEDROCK)
  ) {
    return true
  }

  // 将资格锁存到 bootstrap 状态，防止 GrowthBook 磁盘缓存中途更新导致 TTL 切换
  // （每次切换会破坏服务端提示缓存，浪费 ~20K token 重建）
  let userEligible = getPromptCache1hEligible()
  if (userEligible === null) {
    userEligible =
      process.env.USER_TYPE === 'ant' ||
      (isClaudeAISubscriber() && !currentLimits.isUsingOverage)
    setPromptCache1hEligible(userEligible)
  }
  if (!userEligible) return false

  // allowlist 也锁存到 bootstrap 状态，防止 GrowthBook 磁盘缓存中途更新导致混合 TTL
  let allowlist = getPromptCache1hAllowlist()
  if (allowlist === null) {
    const config = getFeatureValue_CACHED_MAY_BE_STALE<{
      allowlist?: string[]
    }>('tengu_prompt_cache_1h_config', {})
    allowlist = config.allowlist ?? []
    setPromptCache1hAllowlist(allowlist)
  }

  return (
    querySource !== undefined &&
    allowlist.some(pattern =>
      pattern.endsWith('*')
        ? querySource.startsWith(pattern.slice(0, -1)) // 前缀通配匹配
        : querySource === pattern, // 精确匹配
    )
  )
}

/**
 * 为支持 effort 参数的模型配置 effort 相关参数
 *
 * 三种情形：
 * 1. effortValue 未指定：仅发送 EFFORT_BETA_HEADER（使用 API 默认值）
 * 2. effortValue 为字符串（low/medium/high）：填入 outputConfig.effort + beta header
 * 3. effortValue 为数值（ant 专属）：注入 anthropic_internal.effort_override（内部参数）
 */
function configureEffortParams(
  effortValue: EffortValue | undefined,
  outputConfig: BetaOutputConfig,
  extraBodyParams: Record<string, unknown>,
  betas: string[],
  model: string,
): void {
  // 前置检查：模型不支持 effort 参数，或 outputConfig 中已存在 effort 字段（防止重复注入）
  if (!modelSupportsEffort(model) || 'effort' in outputConfig) {
    return
  }

  if (effortValue === undefined) {
    // 情形 1：未指定 effort 值，仅发送 beta header，让 API 使用默认 effort 级别
    betas.push(EFFORT_BETA_HEADER)
  } else if (typeof effortValue === 'string') {
    // 情形 2：字符串类型（low/medium/high），直接设置到 outputConfig.effort
    outputConfig.effort = effortValue
    betas.push(EFFORT_BETA_HEADER)
  } else if (process.env.USER_TYPE === 'ant') {
    // 情形 3：数值类型（ant 专属），注入 anthropic_internal.effort_override（内部调试参数）
    // 保留已有的 anthropic_internal 字段，避免覆盖其他内部参数
    const existingInternal =
      (extraBodyParams.anthropic_internal as Record<string, unknown>) || {}
    extraBodyParams.anthropic_internal = {
      ...existingInternal,
      effort_override: effortValue,
    }
  }
}

// output_config.task_budget — API-side token budget awareness for the model.
// Stainless SDK types don't yet include task_budget on BetaOutputConfig, so we
// define the wire shape locally and cast. The API validates on receipt; see
// api/api/schemas/messages/request/output_config.py:12-39 in the monorepo.
// Beta: task-budgets-2026-03-13 (EAP, claude-strudel-eap only as of Mar 2026).
type TaskBudgetParam = {
  type: 'tokens'
  total: number
  remaining?: number
}

/**
 * 为支持 task_budget 参数的模型注入 API 侧 token 预算感知参数
 *
 * task_budget 让模型在生成时感知剩余 token 预算，从而自主调整输出长度（避免截断）。
 * 该参数与 tokenBudget.ts 的 +500k 自动续写功能无关——此处的预算由调用方（query.ts）
 * 在代理循环中递减后传入，属于 API 侧的原生功能。
 *
 * 注入条件：
 * - taskBudget 参数已设置
 * - outputConfig 中尚未包含 task_budget（防止重复注入）
 * - 仅限第一方 API 路径（shouldIncludeFirstPartyOnlyBetas()），Bedrock/Vertex 不支持
 */
export function configureTaskBudgetParams(
  taskBudget: Options['taskBudget'],
  outputConfig: BetaOutputConfig & { task_budget?: TaskBudgetParam },
  betas: string[],
): void {
  // 前置检查：无预算配置、已有 task_budget、或非第一方 API 路径时跳过
  if (
    !taskBudget ||
    'task_budget' in outputConfig ||
    !shouldIncludeFirstPartyOnlyBetas()
  ) {
    return
  }
  // 注入 task_budget：total 为总预算，remaining 为剩余预算（可选，由 query.ts 递减传入）
  outputConfig.task_budget = {
    type: 'tokens',
    total: taskBudget.total,
    ...(taskBudget.remaining !== undefined && {
      remaining: taskBudget.remaining,
    }),
  }
  // 添加对应的 beta header（避免重复）
  if (!betas.includes(TASK_BUDGETS_BETA_HEADER)) {
    betas.push(TASK_BUDGETS_BETA_HEADER)
  }
}

/**
 * 构造 API 请求的 metadata 对象，用于服务端追踪和遥测
 *
 * user_id 字段序列化为 JSON 字符串，包含：
 * - device_id: 本地生成的匿名设备 ID（用于会话关联，不含 PII）
 * - account_uuid: OAuth 账号的 UUID（仅使用 OAuth 认证时非空）
 * - session_id: 当前会话 ID（用于日志聚合）
 * - 可通过 CLAUDE_CODE_EXTRA_METADATA 环境变量注入额外字段（JSON 对象格式）
 *
 * 文档：https://docs.google.com/document/d/1dURO9ycXXQCBS0V4Vhl4poDBRgkelFc5t2BNPoEgH5Q
 */
export function getAPIMetadata() {
  // https://docs.google.com/document/d/1dURO9ycXXQCBS0V4Vhl4poDBRgkelFc5t2BNPoEgH5Q/edit?tab=t.0#heading=h.5g7nec5b09w5
  let extra: JsonObject = {}
  const extraStr = process.env.CLAUDE_CODE_EXTRA_METADATA
  if (extraStr) {
    // 解析 CLAUDE_CODE_EXTRA_METADATA：必须是 JSON 对象（非数组）
    const parsed = safeParseJSON(extraStr, false)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      extra = parsed as JsonObject
    } else {
      // 格式不合法时记录 error 级别日志，但不阻塞请求
      logForDebugging(
        `CLAUDE_CODE_EXTRA_METADATA env var must be a JSON object, but was given ${extraStr}`,
        { level: 'error' },
      )
    }
  }

  return {
    // user_id 序列化为 JSON 字符串（额外字段在最前，以便 API 侧解析）
    user_id: jsonStringify({
      ...extra,
      device_id: getOrCreateUserID(),
      // Only include OAuth account UUID when actively using OAuth authentication
      // 仅在 OAuth 认证活跃时才包含，否则为空字符串（非 PII 友好）
      account_uuid: getOauthAccountInfo()?.accountUuid ?? '',
      session_id: getSessionId(),
    }),
  }
}

/**
 * 验证 API Key 是否有效
 *
 * 使用小型快速模型（Haiku）发送最小化请求（max_tokens=1）来验证 Key 合法性。
 * 非交互模式（print mode）下跳过验证直接返回 true，避免不必要的 API 调用。
 *
 * 错误处理：
 * - 捕获 authentication_error 类型的 API 错误，返回 false（Key 无效）
 * - 其他错误直接 re-throw（如网络问题、quota 耗尽等）
 */
export async function verifyApiKey(
  apiKey: string,
  isNonInteractiveSession: boolean,
): Promise<boolean> {
  // Skip API verification if running in print mode (isNonInteractiveSession)
  // 非交互模式（-p 参数）跳过验证，避免增加延迟
  if (isNonInteractiveSession) {
    return true
  }

  try {
    // WARNING: if you change this to use a non-Haiku model, this request will fail in 1P unless it uses getCLISyspromptPrefix.
    // 1P 路径要求使用小型模型，否则需要 getCLISyspromptPrefix 前缀
    const model = getSmallFastModel()
    const betas = getModelBetas(model)
    return await returnValue(
      withRetry(
        () =>
          getAnthropicClient({
            apiKey,
            maxRetries: 3,
            model,
            source: 'verify_api_key',
          }),
        async anthropic => {
          const messages: MessageParam[] = [{ role: 'user', content: 'test' }]
          // biome-ignore lint/plugin: API key verification is intentionally a minimal direct call
          // 最小化验证请求：只发送 "test" 消息，max_tokens=1，temperature=1
          await anthropic.beta.messages.create({
            model,
            max_tokens: 1,
            messages,
            temperature: 1,
            ...(betas.length > 0 && { betas }),
            metadata: getAPIMetadata(),
            ...getExtraBodyParams(),
          })
          return true
        },
        { maxRetries: 2, model, thinkingConfig: { type: 'disabled' } }, // Use fewer retries for API key verification
      ),
    )
  } catch (errorFromRetry) {
    let error = errorFromRetry
    if (errorFromRetry instanceof CannotRetryError) {
      error = errorFromRetry.originalError
    }
    logError(error)
    // Check for authentication error
    // 仅对 "invalid x-api-key" 错误返回 false，其他错误（网络、quota 等）继续 throw
    if (
      error instanceof Error &&
      error.message.includes(
        '{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
      )
    ) {
      return false
    }
    throw error
  }
}

/**
 * 将用户消息转换为 API 所需的 MessageParam 格式
 *
 * addCache=true 时为消息末尾的 block 附加 cache_control（提示缓存断点）：
 * - 字符串内容：包装为单元素数组，在唯一的 text block 上添加 cache_control
 * - 数组内容：在最后一个 block 上添加 cache_control（通常是最新的用户输入）
 *
 * addCache=false 时克隆数组内容，防止 addCacheBreakpoints 中的 splice 操作
 * 污染原始 message 对象（多次调用时会重复插入 cache_edits block）。
 */
export function userMessageToMessageParam(
  message: UserMessage,
  addCache = false,
  enablePromptCaching: boolean,
  querySource?: QuerySource,
): MessageParam {
  if (addCache) {
    if (typeof message.message.content === 'string') {
      // 字符串内容：包装为 text block 数组以支持附加 cache_control
      return {
        role: 'user',
        content: [
          {
            type: 'text',
            text: message.message.content,
            ...(enablePromptCaching && {
              cache_control: getCacheControl({ querySource }),
            }),
          },
        ],
      }
    } else {
      // 数组内容：只在最后一个 block 上添加 cache_control（其余 block 保持不变）
      return {
        role: 'user',
        content: message.message.content.map((_, i) => ({
          ..._,
          ...(i === message.message.content.length - 1
            ? enablePromptCaching
              ? { cache_control: getCacheControl({ querySource }) }
              : {}
            : {}),
        })),
      }
    }
  }
  // Clone array content to prevent in-place mutations (e.g., insertCacheEditsBlock's
  // splice) from contaminating the original message. Without cloning, multiple calls
  // to addCacheBreakpoints share the same array and each splices in duplicate cache_edits.
  // 克隆数组内容，防止 insertCacheEditsBlock splice 污染原始 message 对象
  return {
    role: 'user',
    content: Array.isArray(message.message.content)
      ? [...message.message.content]
      : message.message.content,
  }
}

/**
 * 将助手消息转换为 API 所需的 MessageParam 格式
 *
 * 与 userMessageToMessageParam 类似，但需要跳过以下 block 类型（不添加 cache_control）：
 * - thinking / redacted_thinking：思考 block 不缓存（API 限制）
 * - connector_text（feature('CONNECTOR_TEXT') 开启时）：连接器文本 block 不缓存
 *
 * 因此只在最后一个"非 thinking 非 connector_text"的 block 上附加 cache_control。
 */
export function assistantMessageToMessageParam(
  message: AssistantMessage,
  addCache = false,
  enablePromptCaching: boolean,
  querySource?: QuerySource,
): MessageParam {
  if (addCache) {
    if (typeof message.message.content === 'string') {
      // 字符串内容：与 userMessage 处理方式一致
      return {
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: message.message.content,
            ...(enablePromptCaching && {
              cache_control: getCacheControl({ querySource }),
            }),
          },
        ],
      }
    } else {
      // 数组内容：在最后一个 block 上添加 cache_control，
      // 但跳过 thinking、redacted_thinking 和 connector_text 类型（API 不支持这些 block 上的缓存）
      return {
        role: 'assistant',
        content: message.message.content.map((_, i) => ({
          ..._,
          ...(i === message.message.content.length - 1 &&
          _.type !== 'thinking' &&
          _.type !== 'redacted_thinking' &&
          (feature('CONNECTOR_TEXT') ? !isConnectorTextBlock(_) : true)
            ? enablePromptCaching
              ? { cache_control: getCacheControl({ querySource }) }
              : {}
            : {}),
        })),
      }
    }
  }
  return {
    role: 'assistant',
    content: message.message.content,
  }
}

/**
 * queryModel / queryModelWithStreaming / queryModelWithoutStreaming 的调用选项
 *
 * 汇集了一次 API 查询所需的所有上下文信息：
 * - 权限上下文（getToolPermissionContext）、目标模型、工具选择策略
 * - 快速模式（fastMode）、Advisor 模型（advisorModel）
 * - 提示缓存策略（enablePromptCaching / skipCacheWrite）
 * - 任务预算（taskBudget）：供模型自我调速，与 tokenBudget.ts 的自动续写无关
 * - 输出格式（outputFormat）：JSON schema 约束
 * - 查询追踪（queryTracking）：用于多轮查询链关联分析
 */
export type Options = {
  getToolPermissionContext: () => Promise<ToolPermissionContext>
  model: string
  toolChoice?: BetaToolChoiceTool | BetaToolChoiceAuto | undefined
  isNonInteractiveSession: boolean
  extraToolSchemas?: BetaToolUnion[]
  maxOutputTokensOverride?: number
  fallbackModel?: string
  onStreamingFallback?: () => void
  querySource: QuerySource
  agents: AgentDefinition[]
  allowedAgentTypes?: string[]
  hasAppendSystemPrompt: boolean
  fetchOverride?: ClientOptions['fetch']
  enablePromptCaching?: boolean
  skipCacheWrite?: boolean
  temperatureOverride?: number
  effortValue?: EffortValue
  mcpTools: Tools
  hasPendingMcpServers?: boolean
  queryTracking?: QueryChainTracking
  agentId?: AgentId // Only set for subagents
  outputFormat?: BetaJSONOutputFormat
  fastMode?: boolean
  advisorModel?: string
  addNotification?: (notif: Notification) => void
  // API-side task budget (output_config.task_budget). Distinct from the
  // tokenBudget.ts +500k auto-continue feature — this one is sent to the API
  // so the model can pace itself. `remaining` is computed by the caller
  // (query.ts decrements across the agentic loop).
  taskBudget?: { total: number; remaining?: number }
}

/**
 * 非流式 API 查询入口（单次完整响应）
 *
 * 内部委托给 queryModel 生成器（通过 withStreamingVCR 支持 VCR 回放），
 * 消费所有 yield 值直到生成器结束，提取最后一个 AssistantMessage 返回。
 *
 * 注意：必须消费完整个生成器（不能 break），否则 logAPISuccessAndDuration
 * 等在生成器末尾执行的逻辑不会被触发。
 */
export async function queryModelWithoutStreaming({
  messages,
  systemPrompt,
  thinkingConfig,
  tools,
  signal,
  options,
}: {
  messages: Message[]
  systemPrompt: SystemPrompt
  thinkingConfig: ThinkingConfig
  tools: Tools
  signal: AbortSignal
  options: Options
}): Promise<AssistantMessage> {
  // Store the assistant message but continue consuming the generator to ensure
  // logAPISuccessAndDuration gets called (which happens after all yields)
  // 持续消费生成器（不 break），确保生成器尾部的日志逻辑（logAPISuccessAndDuration）被执行
  let assistantMessage: AssistantMessage | undefined
  for await (const message of withStreamingVCR(messages, async function* () {
    yield* queryModel(
      messages,
      systemPrompt,
      thinkingConfig,
      tools,
      signal,
      options,
    )
  })) {
    if (message.type === 'assistant') {
      assistantMessage = message
    }
  }
  if (!assistantMessage) {
    // If the signal was aborted, throw APIUserAbortError instead of a generic error
    // This allows callers to handle abort scenarios gracefully
    // 用户中止时抛出 APIUserAbortError，而非通用错误，方便调用方区分处理
    if (signal.aborted) {
      throw new APIUserAbortError()
    }
    throw new Error('No assistant message found')
  }
  return assistantMessage
}

/**
 * 流式 API 查询入口（逐步 yield 事件流）
 *
 * 将参数透传给 queryModel 生成器，并通过 withStreamingVCR 包装以支持 VCR 回放。
 * 与 queryModelWithoutStreaming 的区别：此函数直接 yield 流式事件，
 * 调用方可以在消息生成过程中实时处理每个事件（流式渲染）。
 */
export async function* queryModelWithStreaming({
  messages,
  systemPrompt,
  thinkingConfig,
  tools,
  signal,
  options,
}: {
  messages: Message[]
  systemPrompt: SystemPrompt
  thinkingConfig: ThinkingConfig
  tools: Tools
  signal: AbortSignal
  options: Options
}): AsyncGenerator<
  StreamEvent | AssistantMessage | SystemAPIErrorMessage,
  void
> {
  return yield* withStreamingVCR(messages, async function* () {
    yield* queryModel(
      messages,
      systemPrompt,
      thinkingConfig,
      tools,
      signal,
      options,
    )
  })
}

/**
 * 判断某个 LSP 工具是否需要延迟加载（defer_loading: true）
 *
 * 当 LSP 初始化尚未完成时（状态为 pending 或 not-started），
 * 该工具应以 defer_loading: true 方式发送给 API，
 * 避免模型在工具尚未就绪时尝试调用它。
 */
function shouldDeferLspTool(tool: Tool): boolean {
  if (!('isLsp' in tool) || !tool.isLsp) {
    return false
  }
  const status = getInitializationStatus()
  // LSP 初始化状态为 pending 或 not-started 时，延迟加载该工具
  return status.status === 'pending' || status.status === 'not-started'
}

/**
 * 计算非流式降级请求的单次超时时长（毫秒）
 *
 * 优先读取 API_TIMEOUT_MS 环境变量（使流式路径与非流式路径共享同一上限）。
 *
 * 远程会话（CLAUDE_CODE_REMOTE=true）默认 120s：
 * 低于 CCR 容器的空闲终止时间（~5min），确保挂起的降级请求能及时抛出
 * APIConnectionTimeoutError，而不是等待 SIGKILL。
 *
 * 本地会话默认 300s：足以应对慢速后端，同时不超过 API 10 分钟的非流式上限。
 */
function getNonstreamingFallbackTimeoutMs(): number {
  const override = parseInt(process.env.API_TIMEOUT_MS || '', 10)
  if (override) return override
  return isEnvTruthy(process.env.CLAUDE_CODE_REMOTE) ? 120_000 : 300_000
}

/**
 * 非流式 API 请求的辅助生成器函数
 *
 * 封装了以下通用模式：
 * 1. 创建 withRetry 生成器（含重试 / fallback 模型逻辑）
 * 2. 迭代生成器，将 system 类型消息（错误通知）透传 yield 给调用方
 * 3. 等待生成器结束并返回最终的 BetaMessage
 *
 * 本函数被 queryModel 中的非流式降级逻辑和外部直接调用路径共享，
 * 避免在多处重复编写 withRetry + 超时 + 日志逻辑。
 *
 * Helper generator for non-streaming API requests.
 * Encapsulates the common pattern of creating a withRetry generator,
 * iterating to yield system messages, and returning the final BetaMessage.
 */
export async function* executeNonStreamingRequest(
  clientOptions: {
    model: string
    fetchOverride?: Options['fetchOverride']
    source: string
  },
  retryOptions: {
    model: string
    fallbackModel?: string
    thinkingConfig: ThinkingConfig
    fastMode?: boolean
    signal: AbortSignal
    initialConsecutive529Errors?: number
    querySource?: QuerySource
  },
  paramsFromContext: (context: RetryContext) => BetaMessageStreamParams,
  onAttempt: (attempt: number, start: number, maxOutputTokens: number) => void,
  captureRequest: (params: BetaMessageStreamParams) => void,
  /**
   * 触发此次非流式降级的流式请求 ID，用于 tengu_nonstreaming_fallback_error 事件的漏斗关联分析。
   * Request ID of the failed streaming attempt this fallback is recovering
   * from. Emitted in tengu_nonstreaming_fallback_error for funnel correlation.
   */
  originatingRequestId?: string | null,
): AsyncGenerator<SystemAPIErrorMessage, BetaMessage> {
  // 读取非流式降级的超时配置（远程会话 120s，本地 300s，可由 API_TIMEOUT_MS 覆盖）
  const fallbackTimeoutMs = getNonstreamingFallbackTimeoutMs()
  // 创建带重试逻辑的生成器，maxRetries=0 禁用 SDK 内置重试（由 withRetry 统一管理）
  const generator = withRetry(
    () =>
      getAnthropicClient({
        maxRetries: 0,
        model: clientOptions.model,
        fetchOverride: clientOptions.fetchOverride,
        source: clientOptions.source,
      }),
    async (anthropic, attempt, context) => {
      const start = Date.now()
      // 通过 paramsFromContext 动态生成请求参数（支持根据重试上下文调整模型/token 等）
      const retryParams = paramsFromContext(context)
      captureRequest(retryParams)
      onAttempt(attempt, start, retryParams.max_tokens)

      // 调整参数以符合非流式 API 要求（限制 max_tokens 不超过 MAX_NON_STREAMING_TOKENS）
      const adjustedParams = adjustParamsForNonStreaming(
        retryParams,
        MAX_NON_STREAMING_TOKENS,
      )

      try {
        // biome-ignore lint/plugin: non-streaming API call
        return await anthropic.beta.messages.create(
          {
            ...adjustedParams,
            model: normalizeModelStringForAPI(adjustedParams.model),
          },
          {
            signal: retryOptions.signal,
            timeout: fallbackTimeoutMs, // 设置超时，防止降级请求挂起超过容器终止时间
          },
        )
      } catch (err) {
        // 用户主动取消：立即重抛，不记录日志（不属于错误场景）
        if (err instanceof APIUserAbortError) throw err

        // 记录非流式降级错误事件（含超时），区分"挂起超容器终止（无事件）"与"触达超时（有事件）"
        logForDiagnosticsNoPII('error', 'cli_nonstreaming_fallback_error')
        logEvent('tengu_nonstreaming_fallback_error', {
          model:
            clientOptions.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          error:
            err instanceof Error
              ? (err.name as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS)
              : ('unknown' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS),
          attempt,
          timeout_ms: fallbackTimeoutMs,
          request_id: (originatingRequestId ??
            'unknown') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        })
        throw err
      }
    },
    {
      model: retryOptions.model,
      fallbackModel: retryOptions.fallbackModel,
      thinkingConfig: retryOptions.thinkingConfig,
      ...(isFastModeEnabled() && { fastMode: retryOptions.fastMode }),
      signal: retryOptions.signal,
      initialConsecutive529Errors: retryOptions.initialConsecutive529Errors,
      querySource: retryOptions.querySource,
    },
  )

  // 消费生成器：将 system 消息（如速率限制通知）yield 给调用方，直到生成器结束
  let e
  do {
    e = await generator.next()
    if (!e.done && e.value.type === 'system') {
      yield e.value
    }
  } while (!e.done)

  return e.value as BetaMessage
}

/**
 * 从会话消息列表中提取最近一次助手消息的请求 ID
 *
 * 用于在分析系统中关联连续的 API 请求，
 * 支持缓存命中率分析和增量 token 追踪。
 *
 * 从消息数组（而非全局状态）派生请求 ID 的好处：
 * - 主线程、子智能体、协作者各自维护独立的请求链，互不干扰
 * - 回滚/撤销操作后，移除的消息不再出现在数组中，ID 自动更新
 *
 * Extracts the request ID from the most recent assistant message in the
 * conversation. Used to link consecutive API requests in analytics so we can
 * join them for cache-hit-rate analysis and incremental token tracking.
 *
 * Deriving this from the message array (rather than global state) ensures each
 * query chain (main thread, subagent, teammate) tracks its own request chain
 * independently, and rollback/undo naturally updates the value.
 */
function getPreviousRequestIdFromMessages(
  messages: Message[],
): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!
    if (msg.type === 'assistant' && msg.requestId) {
      return msg.requestId
    }
  }
  return undefined
}

/** 判断 content block 是否为媒体类型（图片或文档）*/
function isMedia(
  block: BetaContentBlockParam,
): block is BetaImageBlockParam | BetaRequestDocumentBlock {
  return block.type === 'image' || block.type === 'document'
}

/** 判断 content block 是否为工具调用结果（tool_result）*/
function isToolResult(
  block: BetaContentBlockParam,
): block is BetaToolResultBlockParam {
  return block.type === 'tool_result'
}

/**
 * 限制消息列表中媒体项（图片 + 文档）的总数，超出上限时删除最旧的媒体项
 *
 * API 拒绝单次请求中超过 100 个媒体项，但会返回令人困惑的错误信息。
 * 通过此函数静默丢弃最旧的媒体项，将数量控制在限额内，
 * 避免在 Cowork/CCD 等场景中难以恢复的错误。
 *
 * 删除策略：优先删除最旧的媒体（从消息列表头部开始），
 * 保留最近的媒体（消息列表尾部）。
 * 嵌套在 tool_result 内的媒体也会被计入并在必要时删除。
 *
 * Ensures messages contain at most `limit` media items (images + documents).
 * Strips oldest media first to preserve the most recent.
 */
export function stripExcessMediaItems(
  messages: (UserMessage | AssistantMessage)[],
  limit: number,
): (UserMessage | AssistantMessage)[] {
  // 第一遍：统计所有消息中媒体项（含嵌套在 tool_result 中的）的总数
  let toRemove = 0
  for (const msg of messages) {
    if (!Array.isArray(msg.message.content)) continue
    for (const block of msg.message.content) {
      if (isMedia(block)) toRemove++
      if (isToolResult(block) && Array.isArray(block.content)) {
        for (const nested of block.content) {
          if (isMedia(nested)) toRemove++
        }
      }
    }
  }
  // 计算需要删除的媒体数量（当前总数 - 上限）
  toRemove -= limit
  if (toRemove <= 0) return messages // 数量未超限，直接返回

  // 第二遍：从最旧的消息开始，按顺序删除多余的媒体项
  return messages.map(msg => {
    if (toRemove <= 0) return msg // 已删足，跳过剩余消息
    const content = msg.message.content
    if (!Array.isArray(content)) return msg

    const before = toRemove
    const stripped = content
      .map(block => {
        // 优先处理 tool_result 内部嵌套的媒体（从旧到新）
        if (
          toRemove <= 0 ||
          !isToolResult(block) ||
          !Array.isArray(block.content)
        )
          return block
        const filtered = block.content.filter(n => {
          if (toRemove > 0 && isMedia(n)) {
            toRemove--
            return false // 删除该嵌套媒体项，同时减少待删除计数
          }
          return true
        })
        return filtered.length === block.content.length
          ? block // 内容未变动，直接复用原 block 对象（避免不必要的克隆）
          : { ...block, content: filtered }
      })
      .filter(block => {
        // 删除顶层媒体 block（tool_result 内的已在上一步处理）
        if (toRemove > 0 && isMedia(block)) {
          toRemove--
          return false
        }
        return true
      })

    return before === toRemove
      ? msg // 本条消息无变化，返回原始引用（避免对象重建）
      : {
          ...msg,
          message: { ...msg.message, content: stripped },
        }
  }) as (UserMessage | AssistantMessage)[]
}

/**
 * Claude API 核心查询生成器（流式）
 *
 * 在 Claude Code 系统流程中的位置：
 * - 被 queryModelWithStreaming / queryModelWithoutStreaming 调用（均通过 withStreamingVCR 包装）
 * - 整合了所有 API 请求的完整生命周期：参数构建 → 流式请求 → 事件处理 → 重试/降级 → 日志
 *
 * 核心流程：
 * 1. 特性开关检查（off-switch / GrowthBook）
 * 2. 工具模式判断（tool search / 延迟加载）
 * 3. 消息规范化（normalizeMessagesForAPI、stripExcessMediaItems 等）
 * 4. 提示缓存配置（system prompt blocks、cache breakpoints）
 * 5. Beta 头部锁存（AFK / fast mode / cache editing — 会话内稳定以避免缓存失效）
 * 6. 流式请求循环（withRetry → streaming event loop → watchdog 监控）
 * 7. 非流式降级（streaming 失败时回退 executeNonStreamingRequest）
 * 8. 使用量累积（updateUsage / accumulateUsage）
 * 9. 成功日志（logAPISuccessAndDuration）
 *
 * 关键设计决策：
 * - paramsFromContext 是一个闭包，捕获所有请求参数，可被重试逻辑多次调用
 * - Beta 头部使用"锁存"机制（once set, always set），避免中途切换导致缓存失效
 * - 流式 watchdog（CLAUDE_ENABLE_STREAM_WATCHDOG）用于检测并中止挂起的流
 * - 非流式降级仅限于特定错误（529 过载 / overloaded）时触发
 */
async function* queryModel(
  messages: Message[],
  systemPrompt: SystemPrompt,
  thinkingConfig: ThinkingConfig,
  tools: Tools,
  signal: AbortSignal,
  options: Options,
): AsyncGenerator<
  StreamEvent | AssistantMessage | SystemAPIErrorMessage,
  void
> {
  // 特性开关检查：tengu-off-switch 激活时阻断非订阅用户的 Opus 查询
  // 廉价条件优先：先判断是否为订阅用户和 Opus 模型，再阻塞等待 GrowthBook 初始化（约 10ms）
  if (
    !isClaudeAISubscriber() &&
    isNonCustomOpusModel(options.model) &&
    (
      await getDynamicConfig_BLOCKS_ON_INIT<{ activated: boolean }>(
        'tengu-off-switch',
        {
          activated: false,
        },
      )
    ).activated
  ) {
    logEvent('tengu_off_switch_query', {})
    yield getAssistantMessageFromError(
      new Error(CUSTOM_OFF_SWITCH_MESSAGE),
      options.model,
    )
    return
  }

  // Derive previous request ID from the last assistant message in this query chain.
  // This is scoped per message array (main thread, subagent, teammate each have their own),
  // so concurrent agents don't clobber each other's request chain tracking.
  // Also naturally handles rollback/undo since removed messages won't be in the array.
  const previousRequestId = getPreviousRequestIdFromMessages(messages)

  // Bedrock 推理配置文件解析：将 application-inference-profile 映射到实际的后端模型名称
  // 用于正确计算 token 费用和日志中显示的 resolvedModel 字段
  const resolvedModel =
    getAPIProvider() === 'bedrock' &&
    options.model.includes('application-inference-profile')
      ? ((await getInferenceProfileBackingModel(options.model)) ??
        options.model)
      : options.model

  queryCheckpoint('query_tool_schema_build_start')
  const isAgenticQuery =
    options.querySource.startsWith('repl_main_thread') ||
    options.querySource.startsWith('agent:') ||
    options.querySource === 'sdk' ||
    options.querySource === 'hook_agent' ||
    options.querySource === 'verification_agent'
  const betas = getMergedBetas(options.model, { isAgenticQuery })

  // advisor beta 头部：只要 advisor 功能已启用就始终发送，即使是非 agentic 查询（compact、
  // side_question、extract_memories 等）也需要发送，因为对话历史中可能已存在 advisor
  // server_tool_use 块，非 agentic 查询需要正确解析这些块。
  if (isAdvisorEnabled()) {
    betas.push(ADVISOR_BETA_HEADER)
  }

  let advisorModel: string | undefined
  if (isAgenticQuery && isAdvisorEnabled()) {
    let advisorOption = options.advisorModel

    // 实验性 advisor 模型配置：A/B 实验可以为特定 base model 指定不同的 advisor 模型，
    // 此配置仅在用户无法自行设置时生效（实验优先级高于用户配置）。
    const advisorExperiment = getExperimentAdvisorModels()
    if (advisorExperiment !== undefined) {
      if (
        normalizeModelStringForAPI(advisorExperiment.baseModel) ===
        normalizeModelStringForAPI(options.model)
      ) {
        // 当前 base model 与实验配置匹配：使用实验指定的 advisor model 覆盖用户配置
        advisorOption = advisorExperiment.advisorModel
      }
    }

    if (advisorOption) {
      const normalizedAdvisorModel = normalizeModelStringForAPI(
        parseUserSpecifiedModel(advisorOption),
      )
      // 双重校验：base model 需支持 advisor，且指定的 advisor model 也需在白名单内
      if (!modelSupportsAdvisor(options.model)) {
        logForDebugging(
          `[AdvisorTool] Skipping advisor - base model ${options.model} does not support advisor`,
        )
      } else if (!isValidAdvisorModel(normalizedAdvisorModel)) {
        logForDebugging(
          `[AdvisorTool] Skipping advisor - ${normalizedAdvisorModel} is not a valid advisor model`,
        )
      } else {
        advisorModel = normalizedAdvisorModel // 校验通过，确认使用该 advisor 模型
        logForDebugging(
          `[AdvisorTool] Server-side tool enabled with ${advisorModel} as the advisor model`,
        )
      }
    }
  }

  // 工具搜索（ToolSearch）启用检查：检查当前模式、模型支持情况和 TstAuto 阈值
  // 这是异步操作，因为 TstAuto 模式需要计算 MCP 工具描述的总字节数来判断是否超过阈值
  let useToolSearch = await isToolSearchEnabled(
    options.model,
    tools,
    options.getToolPermissionContext,
    options.agents,
    'query',
  )

  // 预计算延迟工具集合（isDeferredTool 每次调用会做 2 次 GrowthBook 查询，提前批量处理）
  const deferredToolNames = new Set<string>()
  if (useToolSearch) {
    for (const t of tools) {
      if (isDeferredTool(t)) deferredToolNames.add(t.name)
    }
  }

  // 兜底关闭 ToolSearch：若无可延迟加载的工具，且没有仍在连接中的 MCP 服务器，则关闭。
  // 若 MCP 服务器仍在连接中，保持 ToolSearch 开启，使模型在服务器就绪后能发现新工具。
  if (
    useToolSearch &&
    deferredToolNames.size === 0 &&
    !options.hasPendingMcpServers
  ) {
    logForDebugging(
      'Tool search disabled: no deferred tools available to search',
    )
    useToolSearch = false
  }

  // 过滤工具列表：不支持 ToolSearch 的模型无法处理 tool_reference 块，需移除 ToolSearchTool
  let filteredTools: Tools

  if (useToolSearch) {
    // 动态工具加载：只向模型声明已通过 tool_reference 块被发现的延迟工具，
    // 而非一次性预声明所有工具，从而突破工具数量上限并减少系统提示体积。
    const discoveredToolNames = extractDiscoveredToolNames(messages)

    filteredTools = tools.filter(tool => {
      if (!deferredToolNames.has(tool.name)) return true // 非延迟工具始终包含
      if (toolMatchesName(tool, TOOL_SEARCH_TOOL_NAME)) return true // ToolSearchTool 始终包含（用于发现更多工具）
      return discoveredToolNames.has(tool.name) // 延迟工具仅在已被发现后才包含
    })
  } else {
    // ToolSearch 未启用：过滤掉 ToolSearchTool（模型不支持其返回的 tool_reference 块）
    filteredTools = tools.filter(
      t => !toolMatchesName(t, TOOL_SEARCH_TOOL_NAME),
    )
  }

  // 工具搜索 beta 头部：启用 ToolSearch 时需要添加，以使 defer_loading 字段被 API 接受
  // 不同提供商头部名称不同：1P/Foundry 用 advanced-tool-use，Vertex/Bedrock 用 tool-search-tool
  // Bedrock 的该头部必须放在 extraBodyParams 中，而非 betas 数组
  const toolSearchHeader = useToolSearch ? getToolSearchBetaHeader() : null
  if (toolSearchHeader && getAPIProvider() !== 'bedrock') {
    if (!betas.includes(toolSearchHeader)) {
      betas.push(toolSearchHeader)
    }
  }

  // 缓存微压缩（cached microcompact）特性门控：
  // 在 async 上下文中一次性计算并由 paramsFromContext 闭包捕获，避免重复动态导入。
  // cache editing beta 头部也在此捕获，以避免在顶层导入仅 ant 内部使用的常量。
  let cachedMCEnabled = false
  let cacheEditingBetaHeader = ''
  if (feature('CACHED_MICROCOMPACT')) {
    const {
      isCachedMicrocompactEnabled,
      isModelSupportedForCacheEditing,
      getCachedMCConfig,
    } = await import('../compact/cachedMicrocompact.js')
    const betas = await import('src/constants/betas.js')
    cacheEditingBetaHeader = betas.CACHE_EDITING_BETA_HEADER
    const featureEnabled = isCachedMicrocompactEnabled()
    const modelSupported = isModelSupportedForCacheEditing(options.model)
    cachedMCEnabled = featureEnabled && modelSupported // 两个条件同时满足才启用
    const config = getCachedMCConfig()
    logForDebugging(
      `Cached MC gate: enabled=${featureEnabled} modelSupported=${modelSupported} model=${options.model} supportedModels=${jsonStringify(config.supportedModels)}`,
    )
  }

  const useGlobalCacheFeature = shouldUseGlobalCacheScope()
  const willDefer = (t: Tool) =>
    useToolSearch && (deferredToolNames.has(t.name) || shouldDeferLspTool(t))
  // MCP 工具是按用户动态变化的，属于动态工具段，无法被全局缓存。
  // 仅当有 MCP 工具实际渲染（非 defer_loading）时，才需要工具段缓存标记。
  const needsToolBasedCacheMarker =
    useGlobalCacheFeature &&
    filteredTools.some(t => t.isMcp === true && !willDefer(t))

  // 全局缓存范围：启用时确保 prompt_caching_scope beta 头部已加入 betas 数组
  if (
    useGlobalCacheFeature &&
    !betas.includes(PROMPT_CACHING_SCOPE_BETA_HEADER)
  ) {
    betas.push(PROMPT_CACHING_SCOPE_BETA_HEADER)
  }

  // 全局缓存策略枚举（用于日志和遥测）：有 MCP 工具时无法全局缓存（'none'），否则缓存系统提示
  const globalCacheStrategy: GlobalCacheStrategy = useGlobalCacheFeature
    ? needsToolBasedCacheMarker
      ? 'none'
      : 'system_prompt'
    : 'none'

  // 构建工具 schema：对过滤后的工具列表生成 API 所需的 JSON schema
  // 注意：传给 toolToAPISchema 的 tools 参数是完整工具列表（而非 filteredTools），
  // 这样 ToolSearchTool 的提示词中可以列出所有可用的 MCP 工具；
  // 过滤仅影响实际发送给 API 的工具，不影响 tool 描述内容中展示的工具集合。
  const toolSchemas = await Promise.all(
    filteredTools.map(tool =>
      toolToAPISchema(tool, {
        getToolPermissionContext: options.getToolPermissionContext,
        tools,
        agents: options.agents,
        allowedAgentTypes: options.allowedAgentTypes,
        model: options.model,
        deferLoading: willDefer(tool),
      }),
    ),
  )

  if (useToolSearch) {
    const includedDeferredTools = count(filteredTools, t =>
      deferredToolNames.has(t.name),
    )
    logForDebugging(
      `Dynamic tool loading: ${includedDeferredTools}/${deferredToolNames.size} deferred tools included`,
    )
  }

  queryCheckpoint('query_tool_schema_build_end')

  // 消息归一化前记录消息数量（遥测/调试用），用于对比归一化前后的差异
  logEvent('tengu_api_before_normalize', {
    preNormalizedMessageCount: messages.length,
  })

  queryCheckpoint('query_message_normalization_start')
  let messagesForAPI = normalizeMessagesForAPI(messages, filteredTools)
  queryCheckpoint('query_message_normalization_end')

  // 针对不支持工具搜索的模型做后处理：移除工具搜索专有字段，避免 API 返回 400 错误。
  //
  // 为何 normalizeMessagesForAPI 内部不处理？
  // - normalizeMessagesForAPI 使用 isToolSearchEnabledNoModelCheck()，
  //   因为它被约 20 处调用（分析、反馈、分享等），多数调用方没有模型上下文，
  //   将 model 加入其签名需要大规模重构；
  // - 此处的后处理使用感知模型的 isToolSearchEnabled() 检查；
  // - 处理会话中途切换模型的场景（如从 Sonnet 切换到 Haiku），
  //   历史消息中遗留的工具搜索字段会导致 400 错误。
  //
  // 注：对 assistant 消息，normalizeMessagesForAPI 已归一化 tool inputs，
  // 此处 stripCallerFieldFromAssistantMessage 只需移除 'caller' 字段。
  if (!useToolSearch) {
    messagesForAPI = messagesForAPI.map(msg => {
      switch (msg.type) {
        case 'user':
          // 从 tool_result 内容中移除 tool_reference 块
          return stripToolReferenceBlocksFromUserMessage(msg)
        case 'assistant':
          // 从 tool_use 块中移除 'caller' 字段
          return stripCallerFieldFromAssistantMessage(msg)
        default:
          return msg
      }
    })
  }

  // 修复 tool_use/tool_result 配对错乱：恢复远程/传送会话时可能出现孤儿块，
  // 为无 tool_result 的 tool_use 插入合成错误 tool_result，移除引用不存在 tool_use 的孤儿 tool_result。
  messagesForAPI = ensureToolResultPairing(messagesForAPI)

  // 移除 advisor 块：未发送 advisor beta 头部时，API 会拒绝含 advisor 块的消息
  if (!betas.includes(ADVISOR_BETA_HEADER)) {
    messagesForAPI = stripAdvisorBlocks(messagesForAPI)
  }

  // 超限媒体项裁剪：API 拒绝超过 100 个媒体项的请求，但返回的错误信息令人困惑。
  // 在 Cowork/CCD 场景中出错很难恢复，因此静默删除最旧的媒体项以保持在限制内。
  messagesForAPI = stripExcessMediaItems(
    messagesForAPI,
    API_MAX_MEDIA_PER_REQUEST,
  )

  // 归一化后记录消息数量（遥测，与归一化前对比）
  logEvent('tengu_api_after_normalize', {
    postNormalizedMessageCount: messagesForAPI.length,
  })

  // 从第一条用户消息计算指纹（用于归因）。
  // 必须在注入合成消息（如延迟工具名称列表）之前运行，
  // 以确保指纹反映真实的用户输入，而非合成内容。
  const fingerprint = computeFingerprintFromMessages(messagesForAPI)

  // 延迟工具列表注入：启用 delta attachment 时通过持久化的 deferred_tools_delta 通告延迟工具，
  // 而非此处的临时前置消息（前置消息在工具集变化时会破坏缓存）。
  if (useToolSearch && !isDeferredToolsDeltaEnabled()) {
    const deferredToolList = tools
      .filter(t => deferredToolNames.has(t.name))
      .map(formatDeferredToolLine)
      .sort()
      .join('\n')
    if (deferredToolList) {
      messagesForAPI = [
        createUserMessage({
          content: `<available-deferred-tools>\n${deferredToolList}\n</available-deferred-tools>`,
          isMeta: true,
        }),
        ...messagesForAPI,
      ]
    }
  }

  // Chrome 工具搜索指令注入：启用 delta attachment 时，这些指令通过 mcp_instructions_delta 携带
  // （attachments.ts），而非在此注入。此处的每次请求注入会在 Chrome 工具晚连接时破坏提示缓存。
  const hasChromeTools = filteredTools.some(t =>
    isToolFromMcpServer(t.name, CLAUDE_IN_CHROME_MCP_SERVER_NAME),
  )
  const injectChromeHere =
    useToolSearch && hasChromeTools && !isMcpInstructionsDeltaEnabled()

  // 组装最终系统提示：归因头部 + CLI 前缀 + 用户系统提示 + advisor 指令 + Chrome 工具指令
  // filter(Boolean) 过滤掉空字符串（将其转换为 false 后过滤）
  systemPrompt = asSystemPrompt(
    [
      getAttributionHeader(fingerprint),
      getCLISyspromptPrefix({
        isNonInteractive: options.isNonInteractiveSession,
        hasAppendSystemPrompt: options.hasAppendSystemPrompt,
      }),
      ...systemPrompt,
      ...(advisorModel ? [ADVISOR_TOOL_INSTRUCTIONS] : []),
      ...(injectChromeHere ? [CHROME_TOOL_SEARCH_INSTRUCTIONS] : []),
    ].filter(Boolean),
  )

  // 记录系统提示前缀（便于 API 日志快速识别系统提示内容）
  logAPIPrefix(systemPrompt)

  const enablePromptCaching =
    options.enablePromptCaching ?? getPromptCachingEnabled(options.model)
  const system = buildSystemPromptBlocks(systemPrompt, enablePromptCaching, {
    skipGlobalCacheForSystemPrompt: needsToolBasedCacheMarker,
    querySource: options.querySource,
  })
  const useBetas = betas.length > 0

  // 构建详细追踪所需的最小上下文（仅在 beta tracing 启用时使用）
  // 实际的 new_context 消息提取在 sessionTracing.ts 中完成，
  // 通过基于哈希的 querySource（代理）追踪机制从 messagesForAPI 中提取
  const extraToolSchemas = [...(options.extraToolSchemas ?? [])]
  if (advisorModel) {
    // Server tools must be in the tools array by API contract. Appended after
    // toolSchemas (which carries the cache_control marker) so toggling /advisor
    // only churns the small suffix, not the cached prefix.
    extraToolSchemas.push({
      type: 'advisor_20260301',
      name: 'advisor',
      model: advisorModel,
    } as unknown as BetaToolUnion)
  }
  const allTools = [...toolSchemas, ...extraToolSchemas]

  const isFastMode =
    isFastModeEnabled() &&
    isFastModeAvailable() &&
    !isFastModeCooldown() &&
    isFastModeSupportedByModel(options.model) &&
    !!options.fastMode

  // Sticky-on beta 头部锁存：一旦激活就在会话内持续发送，避免中途切换导致服务端缓存键变化
  // 翻转一次约损失 50-70K token 的缓存（约 $0.3-0.5），代价极高
  // 锁存通过 /clear 和 /compact 命令清除（clearBetaHeaderLatches()）

  let afkHeaderLatched = getAfkModeHeaderLatched() === true
  if (feature('TRANSCRIPT_CLASSIFIER')) {
    if (
      !afkHeaderLatched &&
      isAgenticQuery &&
      shouldIncludeFirstPartyOnlyBetas() &&
      (autoModeStateModule?.isAutoModeActive() ?? false)
    ) {
      afkHeaderLatched = true
      setAfkModeHeaderLatched(true)
    }
  }

  // fast mode 锁存：一旦 isFastMode=true 就持续发送，防止缓存键在模式切换时改变
  let fastModeHeaderLatched = getFastModeHeaderLatched() === true
  if (!fastModeHeaderLatched && isFastMode) {
    fastModeHeaderLatched = true
    setFastModeHeaderLatched(true)
  }

  // cache editing（cachedMicrocompact）锁存：仅首次商用主线程请求时激活
  let cacheEditingHeaderLatched = getCacheEditingHeaderLatched() === true
  if (feature('CACHED_MICROCOMPACT')) {
    if (
      !cacheEditingHeaderLatched &&
      cachedMCEnabled &&
      getAPIProvider() === 'firstParty' &&
      options.querySource === 'repl_main_thread'
    ) {
      cacheEditingHeaderLatched = true
      setCacheEditingHeaderLatched(true)
    }
  }

  // thinking-clear 锁存：仅在 agentic 查询中激活（避免分类器请求意外翻转主线程的缓存键）
  // 距上次 API 完成超过 1 小时（缓存 TTL）时，激活 thinking-clear 头部通知服务端清除缓存
  let thinkingClearLatched = getThinkingClearLatched() === true
  if (!thinkingClearLatched && isAgenticQuery) {
    const lastCompletion = getLastApiCompletionTimestamp()
    if (
      lastCompletion !== null &&
      Date.now() - lastCompletion > CACHE_TTL_1HOUR_MS
    ) {
      thinkingClearLatched = true
      setThinkingClearLatched(true)
    }
  }

  const effort = resolveAppliedEffort(options.model, options.effortValue)

  // prompt 缓存断点检测：将当前提示状态记录快照，用于识别哪些因素导致了缓存未命中
  if (feature('PROMPT_CACHE_BREAK_DETECTION')) {
    // 从哈希中排除 defer_loading 工具——API 会将它们从 prompt 中剥离，
    // 因此它们不影响实际缓存键。包含它们会在工具被发现或 MCP 服务器重连时产生误报的"工具 schema 已更改"断点。
    const toolsForCacheDetection = allTools.filter(
      t => !('defer_loading' in t && t.defer_loading),
    )
    // 捕获所有可能影响服务端缓存键的要素。
    // 传入锁存的头部值（而非实时状态），以确保断点检测反映实际发送内容，
    // 而非用户刚切换但尚未锁存的状态。
    recordPromptState({
      system,
      toolSchemas: toolsForCacheDetection,
      querySource: options.querySource,
      model: options.model,
      agentId: options.agentId,
      fastMode: fastModeHeaderLatched,
      globalCacheStrategy,
      betas,
      autoModeActive: afkHeaderLatched,
      isUsingOverage: currentLimits.isUsingOverage ?? false,
      cachedMCEnabled: cacheEditingHeaderLatched,
      effortValue: effort,
      extraBodyParams: getExtraBodyParams(),
    })
  }

  // beta tracing 上下文（用于详细链路追踪）：仅在 beta tracing 启用时构建，避免不必要的序列化开销
  const newContext: LLMRequestNewContext | undefined = isBetaTracingEnabled()
    ? {
        systemPrompt: systemPrompt.join('\n\n'),
        querySource: options.querySource,
        tools: jsonStringify(allTools),
      }
    : undefined

  // 捕获 LLM 请求 span，便于在并行请求时将响应正确匹配到对应请求
  const llmSpan = startLLMRequestSpan(
    options.model,
    newContext,
    messagesForAPI,
    isFastMode,
  )

  const startIncludingRetries = Date.now()
  let start = Date.now()
  let attemptNumber = 0
  const attemptStartTimes: number[] = []
  let stream: Stream<BetaRawMessageStreamEvent> | undefined = undefined
  let streamRequestId: string | null | undefined = undefined
  let clientRequestId: string | undefined = undefined
  // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins -- Response is available in Node 18+ and is used by the SDK
  let streamResponse: Response | undefined = undefined

  // 释放所有流资源，防止 native 内存泄漏。
  // Response 对象持有 V8 堆外的 native TLS/socket 缓冲区（在 Node.js/npm 路径上观察到，见 GH #32920），
  // 无论 generator 以何种方式退出，都必须显式取消并释放。
  function releaseStreamResources(): void {
    cleanupStream(stream)
    stream = undefined
    if (streamResponse) {
      streamResponse.body?.cancel().catch(() => {})
      streamResponse = undefined
    }
  }

  // 缓存编辑消耗：必须在 paramsFromContext 定义前消耗，
  // 因为 paramsFromContext 会被多次调用（日志记录、重试），
  // 在内部消耗会导致第一次调用"偷走"后续调用的编辑数据
  const consumedCacheEdits = cachedMCEnabled ? consumePendingCacheEdits() : null
  const consumedPinnedEdits = cachedMCEnabled ? getPinnedCacheEdits() : []

  // 记录最后一次请求实际发送的 beta 头部列表（含动态添加的），用于日志和遥测
  let lastRequestBetas: string[] | undefined

  // paramsFromContext 闭包：捕获所有请求参数，可被重试逻辑安全地多次调用
  // 每次调用返回全新的参数对象（含动态 beta、重试模型、token 预算等）
  const paramsFromContext = (retryContext: RetryContext) => {
    const betasParams = [...betas]

    // Sonnet 1M 实验：动态追加 1M 上下文 beta 头部（仅当实验处于 treatment 组时）
    if (
      !betasParams.includes(CONTEXT_1M_BETA_HEADER) &&
      getSonnet1mExpTreatmentEnabled(retryContext.model)
    ) {
      betasParams.push(CONTEXT_1M_BETA_HEADER)
    }

    // Bedrock 额外 beta 头部：将基于模型的 beta 和工具搜索头部合并到 extraBodyParams（Bedrock 限制）
    const bedrockBetas =
      getAPIProvider() === 'bedrock'
        ? [
            ...getBedrockExtraBodyParamsBetas(retryContext.model),
            ...(toolSearchHeader ? [toolSearchHeader] : []),
          ]
        : []
    const extraBodyParams = getExtraBodyParams(bedrockBetas)

    const outputConfig: BetaOutputConfig = {
      ...((extraBodyParams.output_config as BetaOutputConfig) ?? {}),
    }

    configureEffortParams(
      effort,
      outputConfig,
      extraBodyParams,
      betasParams,
      options.model,
    )

    configureTaskBudgetParams(
      options.taskBudget,
      outputConfig as BetaOutputConfig & { task_budget?: TaskBudgetParam },
      betasParams,
    )

    // 结构化输出格式：需要 structured-outputs beta 头部（SDK parse() 方法要求）
    if (options.outputFormat && !('format' in outputConfig)) {
      outputConfig.format = options.outputFormat as BetaJSONOutputFormat
      // 若模型支持且尚未包含，则追加 beta 头部
      if (
        modelSupportsStructuredOutputs(options.model) &&
        !betasParams.includes(STRUCTURED_OUTPUTS_BETA_HEADER)
      ) {
        betasParams.push(STRUCTURED_OUTPUTS_BETA_HEADER)
      }
    }

    // 最大输出 token 数：重试上下文覆盖 > 用户覆盖 > 模型默认值
    // 重试上下文中的覆盖用于在超出上下文窗口限制时自动修正
    const maxOutputTokens =
      retryContext?.maxTokensOverride ||
      options.maxOutputTokensOverride ||
      getMaxOutputTokensForModel(options.model)

    const hasThinking =
      thinkingConfig.type !== 'disabled' &&
      !isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_THINKING)
    let thinking: BetaMessageStreamParams['thinking'] | undefined = undefined

    // IMPORTANT: Do not change the adaptive-vs-budget thinking selection below
    // without notifying the model launch DRI and research. This is a sensitive
    // setting that can greatly affect model quality and bashing.
    if (hasThinking && modelSupportsThinking(options.model)) {
      if (
        !isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING) &&
        modelSupportsAdaptiveThinking(options.model)
      ) {
        // 支持自适应思考的模型：始终使用 adaptive 模式（无 budget 上限），质量最优
        thinking = {
          type: 'adaptive',
        } satisfies BetaMessageStreamParams['thinking']
      } else {
        // 不支持自适应思考的模型：使用模型默认 thinking budget，除非显式指定
        let thinkingBudget = getMaxThinkingTokensForModel(options.model)
        if (
          thinkingConfig.type === 'enabled' &&
          thinkingConfig.budgetTokens !== undefined
        ) {
          thinkingBudget = thinkingConfig.budgetTokens // 使用用户指定的 budget
        }
        thinkingBudget = Math.min(maxOutputTokens - 1, thinkingBudget) // 不得超过输出上限
        thinking = {
          budget_tokens: thinkingBudget,
          type: 'enabled',
        } satisfies BetaMessageStreamParams['thinking']
      }
    }

    // 获取 API 上下文管理策略（启用时）：处理长上下文、thinking 内容的上下文管理
    const contextManagement = getAPIContextManagement({
      hasThinking,
      isRedactThinkingActive: betasParams.includes(REDACT_THINKING_BETA_HEADER),
      clearAllThinking: thinkingClearLatched,
    })

    const enablePromptCaching =
      options.enablePromptCaching ?? getPromptCachingEnabled(retryContext.model)

    // fast mode 速度参数：header 已锁存（缓存安全），但 speed='fast' 保持动态，
    // 这样冷却期内即便 header 还在也不会实际触发 fast mode 请求，
    // 同时不改变缓存键（header 不变 = 缓存键不变）。
    let speed: BetaMessageStreamParams['speed']
    const isFastModeForRetry =
      isFastModeEnabled() &&
      isFastModeAvailable() &&
      !isFastModeCooldown() &&
      isFastModeSupportedByModel(options.model) &&
      !!retryContext.fastMode
    if (isFastModeForRetry) {
      speed = 'fast'
    }
    if (fastModeHeaderLatched && !betasParams.includes(FAST_MODE_BETA_HEADER)) {
      betasParams.push(FAST_MODE_BETA_HEADER)
    }

    // AFK mode beta 头部：锁存后在 auto mode 首次激活时持续发送。
    // 仍按每次调用检查 isAgenticQuery，防止分类器/compact 请求意外获得该头部。
    if (feature('TRANSCRIPT_CLASSIFIER')) {
      if (
        afkHeaderLatched &&
        shouldIncludeFirstPartyOnlyBetas() &&
        isAgenticQuery &&
        !betasParams.includes(AFK_MODE_BETA_HEADER)
      ) {
        betasParams.push(AFK_MODE_BETA_HEADER)
      }
    }

    // cache editing beta 头部：header 已锁存（会话内稳定），
    // useCachedMC（控制 cache_edits 请求体行为）保持动态，
    // 这样当特性被禁用时编辑操作停止，但 header 不翻转（不破坏缓存键）。
    const useCachedMC =
      cachedMCEnabled &&
      getAPIProvider() === 'firstParty' &&
      options.querySource === 'repl_main_thread'
    if (
      cacheEditingHeaderLatched &&
      getAPIProvider() === 'firstParty' &&
      options.querySource === 'repl_main_thread' &&
      !betasParams.includes(cacheEditingBetaHeader)
    ) {
      betasParams.push(cacheEditingBetaHeader)
      logForDebugging(
        'Cache editing beta header enabled for cached microcompact',
      )
    }

    // temperature：thinking 启用时 API 要求 temperature=1（已为默认值），
    // 因此仅在 thinking 禁用时才传入 temperature 参数（避免与服务端约束冲突）。
    const temperature = !hasThinking
      ? (options.temperatureOverride ?? 1)
      : undefined

    lastRequestBetas = betasParams

    return {
      model: normalizeModelStringForAPI(options.model),
      messages: addCacheBreakpoints(
        messagesForAPI,
        enablePromptCaching,
        options.querySource,
        useCachedMC,
        consumedCacheEdits,
        consumedPinnedEdits,
        options.skipCacheWrite,
      ),
      system,
      tools: allTools,
      tool_choice: options.toolChoice,
      ...(useBetas && { betas: betasParams }),
      metadata: getAPIMetadata(),
      max_tokens: maxOutputTokens,
      thinking,
      ...(temperature !== undefined && { temperature }),
      ...(contextManagement &&
        useBetas &&
        betasParams.includes(CONTEXT_MANAGEMENT_BETA_HEADER) && {
          context_management: contextManagement,
        }),
      ...extraBodyParams,
      ...(Object.keys(outputConfig).length > 0 && {
        output_config: outputConfig,
      }),
      ...(speed !== undefined && { speed }),
    }
  }

  // 同步计算日志标量，避免 fire-and-forget .then() 闭包持有 paramsFromContext 的完整闭包作用域
  // （messagesForAPI、system、allTools、betas —— 整个请求构建上下文），
  // 否则这些大对象会被 pinned 直到 promise resolve，导致内存占用不必要地延长。
  {
    const queryParams = paramsFromContext({
      model: options.model,
      thinkingConfig,
    })
    const logMessagesLength = queryParams.messages.length
    const logBetas = useBetas ? (queryParams.betas ?? []) : []
    const logThinkingType = queryParams.thinking?.type ?? 'disabled'
    const logEffortValue = queryParams.output_config?.effort
    void options.getToolPermissionContext().then(permissionContext => {
      logAPIQuery({
        model: options.model,
        messagesLength: logMessagesLength,
        temperature: options.temperatureOverride ?? 1,
        betas: logBetas,
        permissionMode: permissionContext.mode,
        querySource: options.querySource,
        queryTracking: options.queryTracking,
        thinkingType: logThinkingType,
        effortValue: logEffortValue,
        fastMode: isFastMode,
        previousRequestId,
      })
    })
  }

  const newMessages: AssistantMessage[] = []
  let ttftMs = 0
  let partialMessage: BetaMessage | undefined = undefined
  const contentBlocks: (BetaContentBlock | ConnectorTextBlock)[] = []
  let usage: NonNullableUsage = EMPTY_USAGE
  let costUSD = 0
  let stopReason: BetaStopReason | null = null
  let didFallBackToNonStreaming = false
  let fallbackMessage: AssistantMessage | undefined
  let maxOutputTokens = 0
  let responseHeaders: globalThis.Headers | undefined = undefined
  let research: unknown = undefined
  let isFastModeRequest = isFastMode // Keep separate state as it may change if falling back
  let isAdvisorInProgress = false

  try {
    queryCheckpoint('query_client_creation_start')
    // 流式请求循环：通过 withRetry 包装，支持 529 过载自动重试和模型降级
    const generator = withRetry(
      () =>
        getAnthropicClient({
          maxRetries: 0, // Disabled auto-retry in favor of manual implementation
          model: options.model,
          fetchOverride: options.fetchOverride,
          source: options.querySource,
        }),
      async (anthropic, attempt, context) => {
        attemptNumber = attempt
        isFastModeRequest = context.fastMode ?? false
        start = Date.now()
        attemptStartTimes.push(start)
        // 客户端已由 withRetry 的 getClient() 创建。每次重试调用一次；
        // 重试时客户端通常来自缓存（withRetry 仅在鉴权错误后重新调用 getClient()），
        // 因此 client_creation_start 到此处的时间差在第一次尝试时最有意义。
        queryCheckpoint('query_client_creation_end')

        const params = paramsFromContext(context)
        captureAPIRequest(params, options.querySource) // 捕获 API 请求用于 bug 报告

        maxOutputTokens = params.max_tokens

        // 在 fetch 实际发出前立即触发检查点。.withResponse() 等待响应头到达，
        // 因此此检查点必须在 await 之前，否则"网络 TTFB"阶段计时会偏差。
        queryCheckpoint('query_api_request_sent')
        if (!options.agentId) {
          headlessProfilerCheckpoint('api_request_sent')
        }

        // 生成并追踪客户端请求 ID：超时时服务端不返回 request_id，
        // 客户端 ID 可用于与服务端日志关联。仅 1P 使用（3P 提供商不记录它，见 inc-4029 类）。
        clientRequestId =
          getAPIProvider() === 'firstParty' && isFirstPartyAnthropicBaseUrl()
            ? randomUUID()
            : undefined

        // 使用原始流而非 BetaMessageStream，避免 O(n²) 的增量 JSON 解析
        // BetaMessageStream 在每个 input_json_delta 上调用 partialParse()，
        // 而我们自行处理工具输入累积，不需要这个开销
        // biome-ignore lint/plugin: main conversation loop handles attribution separately
        const result = await anthropic.beta.messages
          .create(
            { ...params, stream: true },
            {
              signal,
              ...(clientRequestId && {
                headers: { [CLIENT_REQUEST_ID_HEADER]: clientRequestId },
              }),
            },
          )
          .withResponse()
        queryCheckpoint('query_response_headers_received')
        streamRequestId = result.request_id
        streamResponse = result.response
        return result.data
      },
      {
        model: options.model,
        fallbackModel: options.fallbackModel,
        thinkingConfig,
        ...(isFastModeEnabled() ? { fastMode: isFastMode } : false),
        signal,
        querySource: options.querySource,
      },
    )

    let e
    do {
      e = await generator.next()

      // yield API error messages (the stream has a 'controller' property, error messages don't)
      // 流对象带有 'controller' 属性，错误消息没有；遇到错误消息时直接透传给调用方
      if (!('controller' in e.value)) {
        yield e.value
      }
    } while (!e.done)
    stream = e.value as Stream<BetaRawMessageStreamEvent> // 取得底层 SSE 流对象

    // reset state
    // 每次重试前重置本轮状态，避免上一次部分流数据污染本次结果
    newMessages.length = 0
    ttftMs = 0                  // 重置 TTFT（首 token 延迟）计时
    partialMessage = undefined  // 重置正在拼装的消息头部（message_start 设置）
    contentBlocks.length = 0    // 重置内容块累积缓冲区
    usage = EMPTY_USAGE         // 重置 token 用量计数
    stopReason = null           // 重置停止原因（message_delta 会更新）
    isAdvisorInProgress = false // 重置 advisor 工具调用中间状态

    // 流式 watchdog 设置：在连接无响应时主动终止挂起的流
    // SDK 超时仅覆盖初始 fetch()，无法检测流体静默断连；watchdog 弥补这个盲区
    // 默认超时 90s（CLAUDE_STREAM_IDLE_TIMEOUT_MS 可覆盖），到半程发出警告
    const streamWatchdogEnabled = isEnvTruthy(
      process.env.CLAUDE_ENABLE_STREAM_WATCHDOG,
    )
    const STREAM_IDLE_TIMEOUT_MS =
      parseInt(process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS || '', 10) || 90_000
    const STREAM_IDLE_WARNING_MS = STREAM_IDLE_TIMEOUT_MS / 2
    let streamIdleAborted = false
    // performance.now() snapshot when watchdog fires, for measuring abort propagation delay
    let streamWatchdogFiredAt: number | null = null
    let streamIdleWarningTimer: ReturnType<typeof setTimeout> | null = null
    let streamIdleTimer: ReturnType<typeof setTimeout> | null = null
    function clearStreamIdleTimers(): void {
      if (streamIdleWarningTimer !== null) {
        clearTimeout(streamIdleWarningTimer)
        streamIdleWarningTimer = null
      }
      if (streamIdleTimer !== null) {
        clearTimeout(streamIdleTimer)
        streamIdleTimer = null
      }
    }
    function resetStreamIdleTimer(): void {
      clearStreamIdleTimers()
      if (!streamWatchdogEnabled) {
        return
      }
      streamIdleWarningTimer = setTimeout(
        warnMs => {
          logForDebugging(
            `Streaming idle warning: no chunks received for ${warnMs / 1000}s`,
            { level: 'warn' },
          )
          logForDiagnosticsNoPII('warn', 'cli_streaming_idle_warning')
        },
        STREAM_IDLE_WARNING_MS,
        STREAM_IDLE_WARNING_MS,
      )
      streamIdleTimer = setTimeout(() => {
        streamIdleAborted = true
        streamWatchdogFiredAt = performance.now()
        logForDebugging(
          `Streaming idle timeout: no chunks received for ${STREAM_IDLE_TIMEOUT_MS / 1000}s, aborting stream`,
          { level: 'error' },
        )
        logForDiagnosticsNoPII('error', 'cli_streaming_idle_timeout')
        logEvent('tengu_streaming_idle_timeout', {
          model:
            options.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          request_id: (streamRequestId ??
            'unknown') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          timeout_ms: STREAM_IDLE_TIMEOUT_MS,
        })
        releaseStreamResources()
      }, STREAM_IDLE_TIMEOUT_MS)
    }
    resetStreamIdleTimer()

    startSessionActivity('api_call') // 标记 API 调用会话活跃状态，防止会话超时
    try {
      // 逐块消费 SSE 流，逐步拼装消息、内容块和用量统计
      let isFirstChunk = true
      let lastEventTime: number | null = null // 首 chunk 之后才设置，避免把 TTFB 误算为卡顿时间
      const STALL_THRESHOLD_MS = 30_000 // 30 seconds（事件间隔超过此值视为流卡顿）
      let totalStallTime = 0  // 本次请求所有卡顿时长累计（毫秒）
      let stallCount = 0      // 本次请求卡顿次数

      // 主流式事件循环：遍历 SSE 流，处理 message_start/content_block_*/message_delta/message_stop 事件
      for await (const part of stream) {
        resetStreamIdleTimer() // 每收到一个 chunk 就重置空闲超时计时器
        const now = Date.now()

        // 检测流卡顿（streaming stall）：仅在收到首个 chunk 后才开始计时，避免把 TTFB 误算为卡顿
        if (lastEventTime !== null) {
          const timeSinceLastEvent = now - lastEventTime
          if (timeSinceLastEvent > STALL_THRESHOLD_MS) {
            stallCount++
            totalStallTime += timeSinceLastEvent
            logForDebugging(
              `Streaming stall detected: ${(timeSinceLastEvent / 1000).toFixed(1)}s gap between events (stall #${stallCount})`,
              { level: 'warn' },
            )
            logEvent('tengu_streaming_stall', {
              stall_duration_ms: timeSinceLastEvent,
              stall_count: stallCount,
              total_stall_time_ms: totalStallTime,
              event_type:
                part.type as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              model:
                options.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              request_id: (streamRequestId ??
                'unknown') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
            })
          }
        }
        lastEventTime = now

        if (isFirstChunk) {
          logForDebugging('Stream started - received first chunk')
          queryCheckpoint('query_first_chunk_received') // 记录首 chunk 检查点，用于性能追踪
          if (!options.agentId) {
            headlessProfilerCheckpoint('first_chunk') // 无头模式下记录首 chunk 性能时间点
          }
          endQueryProfile() // 结束"发出请求到首 token"阶段的 profiling
          isFirstChunk = false
        }

        switch (part.type) {
          case 'message_start': {
            // message_start：SSE 流的第一个事件，携带消息元数据和初始用量
            partialMessage = part.message            // 保存消息头，后续 content_block_stop 时补全
            ttftMs = Date.now() - start              // 计算 TTFT（首 token 延迟）
            usage = updateUsage(usage, part.message?.usage) // 初始化本次请求的用量计数
            // Capture research from message_start if available (internal only).
            // Always overwrite with the latest value.
            // 内部用户（ant）专属：提取 research 字段（外部用户不可见）
            if (
              process.env.USER_TYPE === 'ant' &&
              'research' in (part.message as unknown as Record<string, unknown>)
            ) {
              research = (part.message as unknown as Record<string, unknown>)
                .research
            }
            break
          }
          case 'content_block_start':
            // content_block_start：一个新内容块开始，需按块类型初始化本地累积缓冲区
            switch (part.content_block.type) {
              case 'tool_use':
                // 工具调用块：input 初始化为空字符串，后续由 input_json_delta 逐段追加
                contentBlocks[part.index] = {
                  ...part.content_block,
                  input: '',
                }
                break
              case 'server_tool_use':
                // 服务端工具调用（如 web_search、advisor）：input 同样逐段追加
                contentBlocks[part.index] = {
                  ...part.content_block,
                  input: '' as unknown as { [key: string]: unknown },
                }
                if ((part.content_block.name as string) === 'advisor') {
                  // advisor 工具开始：标记中间状态，记录调试日志和分析事件
                  isAdvisorInProgress = true
                  logForDebugging(`[AdvisorTool] Advisor tool called`)
                  logEvent('tengu_advisor_tool_call', {
                    model:
                      options.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                    advisor_model: (advisorModel ??
                      'unknown') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                  })
                }
                break
              case 'text':
                // 文本块：SDK 有时在 content_block_start 里就带文本，但 delta 会重复；
                // 此处强制初始化为空字符串，以 delta 累积结果为准
                contentBlocks[part.index] = {
                  ...part.content_block,
                  // awkwardly, the sdk sometimes returns text as part of a
                  // content_block_start message, then returns the same text
                  // again in a content_block_delta message. we ignore it here
                  // since there doesn't seem to be a way to detect when a
                  // content_block_delta message duplicates the text.
                  text: '',
                }
                break
              case 'thinking':
                // 思考块（extended thinking）：thinking 和 signature 均强制置空，由 delta 填充
                contentBlocks[part.index] = {
                  ...part.content_block,
                  // also awkward
                  thinking: '',
                  // initialize signature to ensure field exists even if signature_delta never arrives
                  signature: '',
                }
                break
              default:
                // 其他块类型（含 advisor_tool_result）：浅拷贝防止 SDK 内部变更污染本地状态
                // even more awkwardly, the sdk mutates the contents of text blocks
                // as it works. we want the blocks to be immutable, so that we can
                // accumulate state ourselves.
                contentBlocks[part.index] = { ...part.content_block }
                if (
                  (part.content_block.type as string) === 'advisor_tool_result'
                ) {
                  // advisor 结果块到来：清除 advisor 中间状态标记
                  isAdvisorInProgress = false
                  logForDebugging(`[AdvisorTool] Advisor tool result received`)
                }
                break
            }
            break
          case 'content_block_delta': {
            // content_block_delta：将增量数据追加到对应内容块的累积缓冲区
            const contentBlock = contentBlocks[part.index]
            const delta = part.delta as typeof part.delta | ConnectorTextDelta
            if (!contentBlock) {
              // 找不到对应索引的内容块，说明 content_block_start 未正常到达，上报后抛错
              logEvent('tengu_streaming_error', {
                error_type:
                  'content_block_not_found_delta' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                part_type:
                  part.type as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                part_index: part.index,
              })
              throw new RangeError('Content block not found')
            }
            if (
              feature('CONNECTOR_TEXT') &&
              delta.type === 'connector_text_delta'
            ) {
              // connector_text_delta：连接器文本流，单独分支处理
              if (contentBlock.type !== 'connector_text') {
                logEvent('tengu_streaming_error', {
                  error_type:
                    'content_block_type_mismatch_connector_text' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                  expected_type:
                    'connector_text' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                  actual_type:
                    contentBlock.type as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                })
                throw new Error('Content block is not a connector_text block')
              }
              contentBlock.connector_text += delta.connector_text // 追加连接器文本片段
            } else {
              switch (delta.type) {
                case 'citations_delta':
                  // TODO: handle citations
                  break
                case 'input_json_delta':
                  // input_json_delta：JSON 字符串片段，逐段追加构成完整工具输入
                  if (
                    contentBlock.type !== 'tool_use' &&
                    contentBlock.type !== 'server_tool_use'
                  ) {
                    logEvent('tengu_streaming_error', {
                      error_type:
                        'content_block_type_mismatch_input_json' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                      expected_type:
                        'tool_use' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                      actual_type:
                        contentBlock.type as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                    })
                    throw new Error('Content block is not a input_json block')
                  }
                  if (typeof contentBlock.input !== 'string') {
                    // input 此时应为初始化的空字符串，若不是说明状态异常
                    logEvent('tengu_streaming_error', {
                      error_type:
                        'content_block_input_not_string' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                      input_type:
                        typeof contentBlock.input as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                    })
                    throw new Error('Content block input is not a string')
                  }
                  contentBlock.input += delta.partial_json // 追加 JSON 片段
                  break
                case 'text_delta':
                  // text_delta：文本片段，逐段追加
                  if (contentBlock.type !== 'text') {
                    logEvent('tengu_streaming_error', {
                      error_type:
                        'content_block_type_mismatch_text' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                      expected_type:
                        'text' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                      actual_type:
                        contentBlock.type as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                    })
                    throw new Error('Content block is not a text block')
                  }
                  contentBlock.text += delta.text // 追加文本片段
                  break
                case 'signature_delta':
                  // signature_delta：思考块（或 connector_text 块）的签名，直接赋值（不追加）
                  if (
                    feature('CONNECTOR_TEXT') &&
                    contentBlock.type === 'connector_text'
                  ) {
                    contentBlock.signature = delta.signature
                    break
                  }
                  if (contentBlock.type !== 'thinking') {
                    logEvent('tengu_streaming_error', {
                      error_type:
                        'content_block_type_mismatch_thinking_signature' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                      expected_type:
                        'thinking' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                      actual_type:
                        contentBlock.type as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                    })
                    throw new Error('Content block is not a thinking block')
                  }
                  contentBlock.signature = delta.signature // 设置思考块签名
                  break
                case 'thinking_delta':
                  // thinking_delta：扩展思考文本片段，逐段追加
                  if (contentBlock.type !== 'thinking') {
                    logEvent('tengu_streaming_error', {
                      error_type:
                        'content_block_type_mismatch_thinking_delta' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                      expected_type:
                        'thinking' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                      actual_type:
                        contentBlock.type as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                    })
                    throw new Error('Content block is not a thinking block')
                  }
                  contentBlock.thinking += delta.thinking // 追加思考文本
                  break
              }
            }
            // 内部用户专属：从 content_block_delta 提取 research 字段，始终取最新值
            // Capture research from content_block_delta if available (internal only).
            // Always overwrite with the latest value.
            if (process.env.USER_TYPE === 'ant' && 'research' in part) {
              research = (part as { research: unknown }).research
            }
            break
          }
          case 'content_block_stop': {
            // content_block_stop：将已累积的 contentBlock 封装为 AssistantMessage 并 yield
            const contentBlock = contentBlocks[part.index]
            if (!contentBlock) {
              // 找不到对应块：上报错误类型后抛出范围异常
              logEvent('tengu_streaming_error', {
                error_type:
                  'content_block_not_found_stop' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                part_type:
                  part.type as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                part_index: part.index,
              })
              throw new RangeError('Content block not found')
            }
            if (!partialMessage) {
              // partialMessage 应由 message_start 设置，若缺失说明流乱序
              logEvent('tengu_streaming_error', {
                error_type:
                  'partial_message_not_found' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                part_type:
                  part.type as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              })
              throw new Error('Message not found')
            }
            // 组装完整的 AssistantMessage：合并消息头（partialMessage）+ 归一化后的内容块
            const m: AssistantMessage = {
              message: {
                ...partialMessage,
                content: normalizeContentFromAPI(
                  [contentBlock] as BetaContentBlock[],
                  tools,
                  options.agentId,
                ),
              },
              requestId: streamRequestId ?? undefined,
              type: 'assistant',
              uuid: randomUUID(),               // 每条消息分配唯一 ID
              timestamp: new Date().toISOString(),
              ...(process.env.USER_TYPE === 'ant' &&
                research !== undefined && { research }), // 内部用户附加 research 字段
              ...(advisorModel && { advisorModel }), // 附加 advisor 模型信息（若存在）
            }
            newMessages.push(m) // 加入本轮新消息列表，供 message_delta 回写用量时查找
            yield m             // 立即 yield，让调用方开始处理该消息
            break
          }
          case 'message_delta': {
            // message_delta：更新最终用量统计、stop_reason，并回写到最后一条已 yield 的消息
            usage = updateUsage(usage, part.usage) // 合并 message_delta 携带的累计用量
            // Capture research from message_delta if available (internal only).
            // Always overwrite with the latest value. Also write back to
            // already-yielded messages since message_delta arrives after
            // content_block_stop.
            if (
              process.env.USER_TYPE === 'ant' &&
              'research' in (part as unknown as Record<string, unknown>)
            ) {
              // 内部用户：message_delta 携带 research 字段时，回写到本轮所有已 yield 的消息
              research = (part as unknown as Record<string, unknown>).research
              for (const msg of newMessages) {
                msg.research = research
              }
            }

            // 回写最终用量和 stop_reason 到最后一条已 yield 的消息。
            // 消息在 content_block_stop 时由 partialMessage 创建，
            // 而 partialMessage 在 message_start 时设置（此时 output_tokens=0，stop_reason=null）。
            // message_delta 在 content_block_stop 之后到达，携带真实的最终值。
            //
            // 重要：使用直接属性变更，而非对象替换。
            // transcript 写队列持有 message.message 的引用，并以 100ms 间隔惰性序列化。
            // 对象替换（{ ...lastMsg.message, usage }）会断开队列持有的引用；
            // 直接属性变更确保 transcript 捕获到最终值。
            stopReason = part.delta.stop_reason // 记录停止原因（end_turn / max_tokens 等）

            const lastMsg = newMessages.at(-1)
            if (lastMsg) {
              lastMsg.message.usage = usage // 直接属性变更，确保 transcript 写队列看到最终值
              lastMsg.message.stop_reason = stopReason
            }

            // 更新成本统计：基于最终用量计算本次请求费用并累计到会话总成本
            const costUSDForPart = calculateUSDCost(resolvedModel, usage)
            costUSD += addToTotalSessionCost(
              costUSDForPart,
              usage,
              options.model,
            )

            // 检查是否触发拒绝策略（如安全拒绝），若是则 yield 拒绝消息
            const refusalMessage = getErrorMessageIfRefusal(
              part.delta.stop_reason,
              options.model,
            )
            if (refusalMessage) {
              yield refusalMessage
            }

            if (stopReason === 'max_tokens') {
              // 输出超过 maxOutputTokens 上限：上报并 yield 提示消息
              logEvent('tengu_max_tokens_reached', {
                max_tokens: maxOutputTokens,
              })
              yield createAssistantAPIErrorMessage({
                content: `${API_ERROR_MESSAGE_PREFIX}: Claude's response exceeded the ${
                  maxOutputTokens
                } output token maximum. To configure this behavior, set the CLAUDE_CODE_MAX_OUTPUT_TOKENS environment variable.`,
                apiError: 'max_output_tokens',
                error: 'max_output_tokens',
              })
            }

            if (stopReason === 'model_context_window_exceeded') {
              // 上下文窗口超出模型限制：复用 max_output_tokens 恢复路径
              logEvent('tengu_context_window_exceeded', {
                max_tokens: maxOutputTokens,
                output_tokens: usage.output_tokens,
              })
              // Reuse the max_output_tokens recovery path — from the model's
              // perspective, both mean "response was cut off, continue from
              // where you left off."
              yield createAssistantAPIErrorMessage({
                content: `${API_ERROR_MESSAGE_PREFIX}: The model has reached its context window limit.`,
                apiError: 'max_output_tokens',
                error: 'max_output_tokens',
              })
            }
            break
          }
          case 'message_stop':
            // message_stop：流结束标志，无需处理（后续 finally 块负责清理）
            break
        }

        yield {
          type: 'stream_event',
          event: part,
          ...(part.type === 'message_start' ? { ttftMs } : undefined),
        }
      }
      // 流式循环结束：清除空闲超时 watchdog（防止挂起后的定时器泄漏）
      clearStreamIdleTimers()

      // watchdog 触发后的流退出处理：
      // 记录退出延迟（abort 传播延迟），然后抛出错误触发非流式降级
      // If the stream was aborted by our idle timeout watchdog, fall back to
      // non-streaming retry rather than treating it as a completed stream.
      if (streamIdleAborted) {
        // Instrumentation: proves the for-await exited after the watchdog fired
        // (vs. hung forever). exit_delay_ms measures abort propagation latency:
        // 0-10ms = abort worked; >>1000ms = something else woke the loop.
        const exitDelayMs =
          streamWatchdogFiredAt !== null
            ? Math.round(performance.now() - streamWatchdogFiredAt)
            : -1
        logForDiagnosticsNoPII(
          'info',
          'cli_stream_loop_exited_after_watchdog_clean',
        )
        logEvent('tengu_stream_loop_exited_after_watchdog', {
          request_id: (streamRequestId ??
            'unknown') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          exit_delay_ms: exitDelayMs,
          exit_path:
            'clean' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          model:
            options.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        })
        // 防止双重 emit：此 throw 落入下方 catch 块，
        // 其中的 exit_path='error' 探针会检查 streamWatchdogFiredAt 来区分路径
        streamWatchdogFiredAt = null
        throw new Error('Stream idle timeout - no chunks received')
      }

      // 代理/CDN 空流检测（两种失败模式）：
      // 1. 完全没有事件（!partialMessage）：代理返回了 200 但 body 不是 SSE
      // 2. 部分事件（partialMessage 已设置但无内容块完成 + 未收到带 stop_reason 的 message_delta）：
      //    代理只返回了 message_start，流在 content_block_stop 和 message_delta 之前提前结束
      // BetaMessageStream 在 _endRequest() 中有第一种检测，但原始 Stream 没有——
      // 没有此检测时 generator 会静默返回零条 assistant 消息，
      // causing "Execution error" in -p mode.
      // Note: We must check stopReason to avoid false positives. For example, with
      // structured output (--json-schema), the model calls a StructuredOutput tool
      // on turn 1, then on turn 2 responds with end_turn and no content blocks.
      // That's a legitimate empty response, not an incomplete stream.
      // 代理/CDN 空流检测：无 message_start 或有 message_start 但无内容块完成时触发非流式降级
      if (!partialMessage || (newMessages.length === 0 && !stopReason)) {
        logForDebugging(
          !partialMessage
            ? 'Stream completed without receiving message_start event - triggering non-streaming fallback'
            : 'Stream completed with message_start but no content blocks completed - triggering non-streaming fallback',
          { level: 'error' },
        )
        logEvent('tengu_stream_no_events', {
          model:
            options.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          request_id: (streamRequestId ??
            'unknown') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        })
        throw new Error('Stream ended without receiving any events')
      }

      // Log summary if any stalls occurred during streaming
      if (stallCount > 0) {
        logForDebugging(
          `Streaming completed with ${stallCount} stall(s), total stall time: ${(totalStallTime / 1000).toFixed(1)}s`,
          { level: 'warn' },
        )
        logEvent('tengu_streaming_stall_summary', {
          stall_count: stallCount,
          total_stall_time_ms: totalStallTime,
          model:
            options.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          request_id: (streamRequestId ??
            'unknown') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        })
      }

      // 检测实际的提示缓存命中情况（通过响应 token 数推断缓存是否真的被命中）
      if (feature('PROMPT_CACHE_BREAK_DETECTION')) {
        void checkResponseForCacheBreak(
          options.querySource,
          usage.cache_read_input_tokens,
          usage.cache_creation_input_tokens,
          messages,
          options.agentId,
          streamRequestId,
        )
      }

      // 从响应头提取配额状态和降级百分比（若可用）
      // streamResponse 在上方的 withRetry 回调中设置；TypeScript 控制流分析无法追踪回调中的赋值
      // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
      const resp = streamResponse as unknown as Response | undefined
      if (resp) {
        extractQuotaStatusFromHeaders(resp.headers)
        responseHeaders = resp.headers // 保存响应头供后续网关检测使用
      }
    } catch (streamingError) {
      // 错误路径：同样清除 watchdog 定时器，防止泄漏
      clearStreamIdleTimers()

      // watchdog 已触发但 for-await 以异常退出（而非 clean 退出）：
      // 记录退出延迟，区分真正挂起（for-await 永远不退出）vs 错误退出路径
      if (streamIdleAborted && streamWatchdogFiredAt !== null) {
        const exitDelayMs = Math.round(
          performance.now() - streamWatchdogFiredAt,
        )
        logForDiagnosticsNoPII(
          'info',
          'cli_stream_loop_exited_after_watchdog_error',
        )
        logEvent('tengu_stream_loop_exited_after_watchdog', {
          request_id: (streamRequestId ??
            'unknown') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          exit_delay_ms: exitDelayMs,
          exit_path:
            'error' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          error_name:
            streamingError instanceof Error
              ? (streamingError.name as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS)
              : ('unknown' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS),
          model:
            options.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        })
      }

      if (streamingError instanceof APIUserAbortError) {
        // 判断是否是用户真实中断（ESC 键触发 signal.aborted）还是 SDK 内部超时
        if (signal.aborted) {
          // 用户真实中断（ESC 键）：直接重新抛出，不触发降级
          logForDebugging(
            `Streaming aborted by user: ${errorMessage(streamingError)}`,
          )
          if (isAdvisorInProgress) {
            // advisor 工具正在执行时被中断：记录打断事件
            logEvent('tengu_advisor_tool_interrupted', {
              model:
                options.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              advisor_model: (advisorModel ??
                'unknown') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
            })
          }
          throw streamingError
        } else {
          // SDK 内部超时（APIUserAbortError 但 signal 未被中断）：
          // 包装为更具体的 APIConnectionTimeoutError 后抛出
          logForDebugging(
            `Streaming timeout (SDK abort): ${streamingError.message}`,
            { level: 'error' },
          )
          // Throw a more specific error for timeout
          throw new APIConnectionTimeoutError({ message: 'Request timed out' })
        }
      }

      // 流式中途工具执行已开始时禁用非流式降级：
      // 非流式重试会重新执行同一工具，导致双重执行（见 inc-4258）
      // 通过环境变量或 GrowthBook Feature Flag 检查是否禁用
      const disableFallback =
        isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK) ||
        getFeatureValue_CACHED_MAY_BE_STALE(
          'tengu_disable_streaming_to_non_streaming_fallback',
          false,
        )

      if (disableFallback) {
        // 降级被禁用：记录事件后直接重新抛出，由 withRetry 处理重试
        logForDebugging(
          `Error streaming (non-streaming fallback disabled): ${errorMessage(streamingError)}`,
          { level: 'error' },
        )
        logEvent('tengu_streaming_fallback_to_non_streaming', {
          model:
            options.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          error:
            streamingError instanceof Error
              ? (streamingError.name as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS)
              : (String(
                  streamingError,
                ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS),
          attemptNumber,
          maxOutputTokens,
          thinkingType:
            thinkingConfig.type as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          fallback_disabled: true,
          request_id: (streamRequestId ??
            'unknown') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          fallback_cause: (streamIdleAborted
            ? 'watchdog'
            : 'other') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        })
        throw streamingError
      }

      // 启动非流式降级：记录调试日志和分析事件
      logForDebugging(
        `Error streaming, falling back to non-streaming mode: ${errorMessage(streamingError)}`,
        { level: 'error' },
      )
      didFallBackToNonStreaming = true
      if (options.onStreamingFallback) {
        options.onStreamingFallback() // 通知调用方已切换到非流式模式
      }

      logEvent('tengu_streaming_fallback_to_non_streaming', {
        model:
          options.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        error:
          streamingError instanceof Error
            ? (streamingError.name as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS)
            : (String(
                streamingError,
              ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS),
        attemptNumber,
        maxOutputTokens,
        thinkingType:
          thinkingConfig.type as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        fallback_disabled: false,
        request_id: (streamRequestId ??
          'unknown') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        fallback_cause: (streamIdleAborted
          ? 'watchdog'
          : 'other') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })

      // 执行非流式降级（带重试）：若流式错误本身是 529，计入 529 预算以对齐模型降级触发逻辑
      logForDiagnosticsNoPII('info', 'cli_nonstreaming_fallback_started')
      logEvent('tengu_nonstreaming_fallback_started', {
        request_id: (streamRequestId ??
          'unknown') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        model:
          options.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        fallback_cause: (streamIdleAborted
          ? 'watchdog'
          : 'other') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
      // 执行非流式降级请求：与流式路径共用 paramsFromContext，但以整块响应返回
      const result = yield* executeNonStreamingRequest(
        { model: options.model, source: options.querySource },
        {
          model: options.model,
          fallbackModel: options.fallbackModel,
          thinkingConfig,
          ...(isFastModeEnabled() && { fastMode: isFastMode }),
          signal,
          initialConsecutive529Errors: is529Error(streamingError) ? 1 : 0, // 若流式错误本身是 529，计入连续次数
          querySource: options.querySource,
        },
        paramsFromContext,
        (attempt, _startTime, tokens) => {
          attemptNumber = attempt
          maxOutputTokens = tokens
        },
        params => captureAPIRequest(params, options.querySource),
        streamRequestId,
      )

      // 非流式响应组装：与 content_block_stop 路径相同，归一化内容块后 yield
      const m: AssistantMessage = {
        message: {
          ...result,
          content: normalizeContentFromAPI(
            result.content,
            tools,
            options.agentId,
          ),
        },
        requestId: streamRequestId ?? undefined,
        type: 'assistant',
        uuid: randomUUID(),
        timestamp: new Date().toISOString(),
        ...(process.env.USER_TYPE === 'ant' &&
          research !== undefined && {
            research, // 内部用户：附加 research 字段
          }),
        ...(advisorModel && {
          advisorModel,
        }),
      }
      newMessages.push(m)
      fallbackMessage = m  // 标记为降级消息，供后续统计区分
      yield m
    } finally {
      // finally：无论正常完成还是异常退出，都清除 watchdog 定时器
      clearStreamIdleTimers()
    }
  } catch (errorFromRetry) {
    // FallbackTriggeredError 必须透传给 query.ts 处理实际的模型切换。
    // 在此处吞掉会使降级变为空操作——用户只会看到错误消息，而不会触发真正的降级重试。
    if (errorFromRetry instanceof FallbackTriggeredError) {
      throw errorFromRetry
    }

    // 检查是否为流创建阶段的 404（某些网关不支持流式端点但支持非流式）。
    // v2.1.8 之前 BetaMessageStream 在迭代时抛出 404（被内层 catch 捕获并降级），
    // 现在使用原始流，404 在创建阶段抛出（被此处外层 catch 捕获）。
    const is404StreamCreationError =
      !didFallBackToNonStreaming &&
      errorFromRetry instanceof CannotRetryError &&
      errorFromRetry.originalError instanceof APIError &&
      errorFromRetry.originalError.status === 404

    if (is404StreamCreationError) {
      // 404 发生在 .withResponse() 阶段，streamRequestId 尚未赋值；
      // CannotRetryError 表示所有重试均已失败——从错误头部获取 request ID
      const failedRequestId =
        (errorFromRetry.originalError as APIError).requestID ?? 'unknown'
      logForDebugging(
        'Streaming endpoint returned 404, falling back to non-streaming mode',
        { level: 'warn' },
      )
      didFallBackToNonStreaming = true
      if (options.onStreamingFallback) {
        options.onStreamingFallback() // 通知调用方切换到非流式模式
      }

      logEvent('tengu_streaming_fallback_to_non_streaming', {
        model:
          options.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        error:
          '404_stream_creation' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        attemptNumber,
        maxOutputTokens,
        thinkingType:
          thinkingConfig.type as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        request_id:
          failedRequestId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        fallback_cause:
          '404_stream_creation' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })

      try {
        // Fall back to non-streaming mode
        // 执行 404 降级路径的非流式请求
        const result = yield* executeNonStreamingRequest(
          { model: options.model, source: options.querySource },
          {
            model: options.model,
            fallbackModel: options.fallbackModel,
            thinkingConfig,
            ...(isFastModeEnabled() && { fastMode: isFastMode }),
            signal,
          },
          paramsFromContext,
          (attempt, _startTime, tokens) => {
            attemptNumber = attempt
            maxOutputTokens = tokens
          },
          params => captureAPIRequest(params, options.querySource),
          failedRequestId,
        )

        // 组装非流式降级响应，与正常路径相同
        const m: AssistantMessage = {
          message: {
            ...result,
            content: normalizeContentFromAPI(
              result.content,
              tools,
              options.agentId,
            ),
          },
          requestId: streamRequestId ?? undefined,
          type: 'assistant',
          uuid: randomUUID(),
          timestamp: new Date().toISOString(),
          ...(process.env.USER_TYPE === 'ant' &&
            research !== undefined && { research }),
          ...(advisorModel && { advisorModel }),
        }
        newMessages.push(m)
        fallbackMessage = m
        yield m

        // 继续执行下方的成功日志路径
      } catch (fallbackError) {
        // 降级也失败了：模型降级信号继续透传给 query.ts
        if (fallbackError instanceof FallbackTriggeredError) {
          throw fallbackError
        }

        // 非流式降级同样失败：记录错误后 yield 用户友好错误消息
        logForDebugging(
          `Non-streaming fallback also failed: ${errorMessage(fallbackError)}`,
          { level: 'error' },
        )

        let error = fallbackError
        let errorModel = options.model
        if (fallbackError instanceof CannotRetryError) {
          // CannotRetryError 封装了真实原始错误和发生错误时的模型信息
          error = fallbackError.originalError
          errorModel = fallbackError.retryContext.model
        }

        // 从限流等错误头部提取配额状态（用于 UI 展示）
        if (error instanceof APIError) {
          extractQuotaStatusFromError(error)
        }

        // 三级 requestId 提取：流 ID > 错误头 > 错误体（按优先级）
        const requestId =
          streamRequestId ||
          (error instanceof APIError ? error.requestID : undefined) ||
          (error instanceof APIError
            ? (error.error as { request_id?: string })?.request_id
            : undefined)

        // 记录非流式降级失败的 API 错误（含耗时、token 数、尝试次数等）
        logAPIError({
          error,
          model: errorModel,
          messageCount: messagesForAPI.length,
          messageTokens: tokenCountFromLastAPIResponse(messagesForAPI),
          durationMs: Date.now() - start,
          durationMsIncludingRetries: Date.now() - startIncludingRetries,
          attempt: attemptNumber,
          requestId,
          clientRequestId,
          didFallBackToNonStreaming,
          queryTracking: options.queryTracking,
          querySource: options.querySource,
          llmSpan,
          fastMode: isFastModeRequest,
          previousRequestId,
        })

        // 用户主动中断（ESC）：不向对话注入错误消息，由 query.ts 处理中断提示
        if (error instanceof APIUserAbortError) {
          releaseStreamResources()
          return
        }

        // 将 API 错误转换为用户友好的 AssistantMessage 并 yield，然后终止生成器
        yield getAssistantMessageFromError(error, errorModel, {
          messages,
          messagesForAPI,
        })
        releaseStreamResources()
        return
      }
    } else {
      // Original error handling for non-404 errors
      // 非 404 的常规 API 错误（超时、限流、认证失败等）
      logForDebugging(`Error in API request: ${errorMessage(errorFromRetry)}`, {
        level: 'error',
      })

      let error = errorFromRetry
      let errorModel = options.model
      if (errorFromRetry instanceof CannotRetryError) {
        // CannotRetryError 封装了真实原始错误和发生错误时的模型信息
        error = errorFromRetry.originalError
        errorModel = errorFromRetry.retryContext.model
      }

      // Extract quota status from error headers if it's a rate limit error
      // 从限流错误头部提取配额状态信息（用于 UI 展示剩余配额）
      if (error instanceof APIError) {
        extractQuotaStatusFromError(error)
      }

      // Extract requestId from stream, error header, or error body
      // 三级 requestId 提取：流 ID > 错误头 > 错误体（按优先级）
      const requestId =
        streamRequestId ||
        (error instanceof APIError ? error.requestID : undefined) ||
        (error instanceof APIError
          ? (error.error as { request_id?: string })?.request_id
          : undefined)

      // 记录 API 错误到日志系统（含请求耗时、token 数量、尝试次数等）
      logAPIError({
        error,
        model: errorModel,
        messageCount: messagesForAPI.length,
        messageTokens: tokenCountFromLastAPIResponse(messagesForAPI),
        durationMs: Date.now() - start,
        durationMsIncludingRetries: Date.now() - startIncludingRetries,
        attempt: attemptNumber,
        requestId,
        clientRequestId,
        didFallBackToNonStreaming,
        queryTracking: options.queryTracking,
        querySource: options.querySource,
        llmSpan,
        fastMode: isFastModeRequest,
        previousRequestId,
      })

      // Don't yield an assistant error message for user aborts
      // The interruption message is handled in query.ts
      // 用户主动中断（ESC）：不向对话注入错误消息，由 query.ts 处理中断提示
      if (error instanceof APIUserAbortError) {
        releaseStreamResources()
        return
      }

      // 将 API 错误转换为用户友好的 AssistantMessage 并 yield
      yield getAssistantMessageFromError(error, errorModel, {
        messages,
        messagesForAPI,
      })
      releaseStreamResources()
      return
    }
  } finally {
    stopSessionActivity('api_call') // 无论成功或失败，都标记 API 调用会话活动结束
    // Must be in the finally block: if the generator is terminated early
    // via .return() (e.g. consumer breaks out of for-await-of, or query.ts
    // encounters an abort), code after the try/finally never executes.
    // Without this, the Response object's native TLS/socket buffers leak
    // until the generator itself is GC'd (see GH #32920).
    // generator 提前终止（消费方 break 或 abort）时 finally 确保资源被释放
    releaseStreamResources()

    // Non-streaming fallback cost: the streaming path tracks cost in the
    // message_delta handler before any yield. Fallback pushes to newMessages
    // then yields, so tracking must be here to survive .return() at the yield.
    // 非流式降级成本：流式路径在 message_delta 里追踪，降级路径在此处统一结算
    if (fallbackMessage) {
      const fallbackUsage = fallbackMessage.message.usage
      usage = updateUsage(EMPTY_USAGE, fallbackUsage)
      stopReason = fallbackMessage.message.stop_reason
      const fallbackCost = calculateUSDCost(resolvedModel, fallbackUsage)
      costUSD += addToTotalSessionCost(
        fallbackCost,
        fallbackUsage,
        options.model,
      )
    }
  }

  // Mark all registered tools as sent to API so they become eligible for deletion
  // 标记所有已注册工具为"已发送给 API"，使其进入可删除状态（cached microcompact 优化）
  if (feature('CACHED_MICROCOMPACT') && cachedMCEnabled) {
    markToolsSentToAPIState()
  }

  // Track the last requestId for the main conversation chain so shutdown
  // can send a cache eviction hint to inference. Exclude backgrounded
  // sessions (Ctrl+B) which share the repl_main_thread querySource but
  // run inside an agent context — they are independent conversation chains
  // whose cache should not be evicted when the foreground session clears.
  // 记录主会话链的最后 requestId，用于关闭时向推理服务发送缓存驱逐提示
  if (
    streamRequestId &&
    !getAgentContext() &&
    (options.querySource.startsWith('repl_main_thread') ||
      options.querySource === 'sdk')
  ) {
    setLastMainRequestId(streamRequestId)
  }

  // Precompute scalars so the fire-and-forget .then() closure doesn't pin the
  // full messagesForAPI array (the entire conversation up to the context window
  // limit) until getToolPermissionContext() resolves.
  // 预先提取标量值，避免 .then() 闭包长期持有整个 messagesForAPI 数组（上下文窗口大小）
  const logMessageCount = messagesForAPI.length
  const logMessageTokens = tokenCountFromLastAPIResponse(messagesForAPI)
  void options.getToolPermissionContext().then(permissionContext => {
    // 异步记录 API 成功指标（耗时、用量、成本、停止原因等）
    logAPISuccessAndDuration({
      model:
        newMessages[0]?.message.model ?? partialMessage?.model ?? options.model,
      preNormalizedModel: options.model,
      usage,
      start,
      startIncludingRetries,
      attempt: attemptNumber,
      messageCount: logMessageCount,
      messageTokens: logMessageTokens,
      requestId: streamRequestId ?? null,
      stopReason,
      ttftMs,
      didFallBackToNonStreaming,
      querySource: options.querySource,
      headers: responseHeaders,
      costUSD,
      queryTracking: options.queryTracking,
      permissionMode: permissionContext.mode,
      // 传入 newMessages 供 beta tracing 使用：提取逻辑在 logging.ts 中，仅在 beta tracing 启用时执行
      newMessages,
      llmSpan,
      globalCacheStrategy,
      requestSetupMs: start - startIncludingRetries,
      attemptStartTimes,
      fastMode: isFastModeRequest,
      previousRequestId,
      betas: lastRequestBetas,
    })
  })

  // Defensive: also release on normal completion (no-op if finally already ran).
  // 防御性释放：正常完成路径下若 finally 已执行则为空操作，防止资源遗漏
  releaseStreamResources()
}

/**
 * 清理流式请求资源，防止内存泄漏
 *
 * 通过 stream.controller.abort() 终止尚未关闭的流控制器。
 * 被 queryModel 的 finally 块调用，也可在测试中独立使用。
 *
 * Cleans up stream resources to prevent memory leaks.
 * @internal Exported for testing
 */
export function cleanupStream(
  stream: Stream<BetaRawMessageStreamEvent> | undefined,
): void {
  if (!stream) {
    return
  }
  try {
    // 若流控制器尚未终止，则主动中止（释放 native TLS/socket 缓冲区）
    if (!stream.controller.signal.aborted) {
      stream.controller.abort()
    }
  } catch {
    // 忽略异常：流可能已关闭，abort() 调用报错属正常情况
  }
}

/**
 * 用流式事件中的新用量数据更新当前用量统计
 *
 * 注意：Anthropic 流式 API 返回的是累计用量（非增量差值），
 * 每个事件包含截至该时刻的完整用量数据。
 *
 * 处理规则：
 * - input_tokens、cache_creation_input_tokens、cache_read_input_tokens：
 *   通常在 message_start 事件中设置，message_delta 可能发送显式 0 值，
 *   应忽略 0 值以防覆盖 message_start 中的真实数据（仅接受非空且非零的值）
 * - output_tokens：取最新值（message_delta 中累计更新）
 * - cache_deleted_input_tokens（CACHED_MICROCOMPACT 特性）：
 *   同 input tokens 的处理方式，防止 message_delta 的 0 覆盖真实值
 *
 * Updates usage statistics with new values from streaming API events.
 * Note: Anthropic's streaming API provides cumulative usage totals, not incremental deltas.
 * Each event contains the complete usage up to that point in the stream.
 *
 * Input-related tokens (input_tokens, cache_creation_input_tokens, cache_read_input_tokens)
 * are typically set in message_start and remain constant. message_delta events may send
 * explicit 0 values for these fields, which should not overwrite the values from message_start.
 * We only update these fields if they have a non-null, non-zero value.
 */
export function updateUsage(
  usage: Readonly<NonNullableUsage>,
  partUsage: BetaMessageDeltaUsage | undefined,
): NonNullableUsage {
  if (!partUsage) {
    return { ...usage }
  }
  return {
    input_tokens:
      partUsage.input_tokens !== null && partUsage.input_tokens > 0
        ? partUsage.input_tokens
        : usage.input_tokens,
    cache_creation_input_tokens:
      partUsage.cache_creation_input_tokens !== null &&
      partUsage.cache_creation_input_tokens > 0
        ? partUsage.cache_creation_input_tokens
        : usage.cache_creation_input_tokens,
    cache_read_input_tokens:
      partUsage.cache_read_input_tokens !== null &&
      partUsage.cache_read_input_tokens > 0
        ? partUsage.cache_read_input_tokens
        : usage.cache_read_input_tokens,
    output_tokens: partUsage.output_tokens ?? usage.output_tokens,
    server_tool_use: {
      web_search_requests:
        partUsage.server_tool_use?.web_search_requests ??
        usage.server_tool_use.web_search_requests,
      web_fetch_requests:
        partUsage.server_tool_use?.web_fetch_requests ??
        usage.server_tool_use.web_fetch_requests,
    },
    service_tier: usage.service_tier,
    cache_creation: {
      // SDK type BetaMessageDeltaUsage is missing cache_creation, but it's real!
      ephemeral_1h_input_tokens:
        (partUsage as BetaUsage).cache_creation?.ephemeral_1h_input_tokens ??
        usage.cache_creation.ephemeral_1h_input_tokens,
      ephemeral_5m_input_tokens:
        (partUsage as BetaUsage).cache_creation?.ephemeral_5m_input_tokens ??
        usage.cache_creation.ephemeral_5m_input_tokens,
    },
    // cache_deleted_input_tokens：cache editing 删除 KV 缓存内容时由 API 返回，SDK 类型中未定义。
    // 保持在 NonNullableUsage 类型之外，以便在外部构建中通过 dead code elimination 消除该字段。
    // 同其他 token 字段一样使用 >0 守卫，防止 message_delta 用 0 覆盖真实值。
    ...(feature('CACHED_MICROCOMPACT')
      ? {
          cache_deleted_input_tokens:
            (partUsage as unknown as { cache_deleted_input_tokens?: number })
              .cache_deleted_input_tokens != null &&
            (partUsage as unknown as { cache_deleted_input_tokens: number })
              .cache_deleted_input_tokens > 0
              ? (partUsage as unknown as { cache_deleted_input_tokens: number })
                  .cache_deleted_input_tokens
              : ((usage as unknown as { cache_deleted_input_tokens?: number })
                  .cache_deleted_input_tokens ?? 0),
        }
      : {}),
    inference_geo: usage.inference_geo,
    iterations: partUsage.iterations ?? usage.iterations,
    speed: (partUsage as BetaUsage).speed ?? usage.speed,
  }
}

/**
 * 将单条消息的用量累加到总用量对象中
 *
 * 用于跨多个助手轮次累计 token 用量，记录整个会话的 token 消耗。
 * service_tier、inference_geo、iterations、speed 取最新消息的值（而非累加）。
 *
 * Accumulates usage from one message into a total usage object.
 * Used to track cumulative usage across multiple assistant turns.
 */
export function accumulateUsage(
  totalUsage: Readonly<NonNullableUsage>,
  messageUsage: Readonly<NonNullableUsage>,
): NonNullableUsage {
  return {
    input_tokens: totalUsage.input_tokens + messageUsage.input_tokens,
    cache_creation_input_tokens:
      totalUsage.cache_creation_input_tokens +
      messageUsage.cache_creation_input_tokens,
    cache_read_input_tokens:
      totalUsage.cache_read_input_tokens + messageUsage.cache_read_input_tokens,
    output_tokens: totalUsage.output_tokens + messageUsage.output_tokens,
    server_tool_use: {
      web_search_requests:
        totalUsage.server_tool_use.web_search_requests +
        messageUsage.server_tool_use.web_search_requests,
      web_fetch_requests:
        totalUsage.server_tool_use.web_fetch_requests +
        messageUsage.server_tool_use.web_fetch_requests,
    },
    service_tier: messageUsage.service_tier, // 取最新轮次的 service tier（非累加）
    cache_creation: {
      ephemeral_1h_input_tokens:
        totalUsage.cache_creation.ephemeral_1h_input_tokens +
        messageUsage.cache_creation.ephemeral_1h_input_tokens,
      ephemeral_5m_input_tokens:
        totalUsage.cache_creation.ephemeral_5m_input_tokens +
        messageUsage.cache_creation.ephemeral_5m_input_tokens,
    },
    // 参见 updateUsage 中的注释 —— 该字段不在 NonNullableUsage 上，以防止字符串出现在外部构建中
    ...(feature('CACHED_MICROCOMPACT')
      ? {
          cache_deleted_input_tokens:
            ((totalUsage as unknown as { cache_deleted_input_tokens?: number })
              .cache_deleted_input_tokens ?? 0) +
            ((
              messageUsage as unknown as { cache_deleted_input_tokens?: number }
            ).cache_deleted_input_tokens ?? 0),
        }
      : {}),
    inference_geo: messageUsage.inference_geo, // 取最新轮次的推理地理区域（非累加）
    iterations: messageUsage.iterations, // 取最新轮次的迭代记录（非累加）
    speed: messageUsage.speed, // 取最新轮次的速度模式（非累加）
  }
}

/** 类型守卫：判断 block 是否为 tool_result 类型（含 tool_use_id 属性）*/
function isToolResultBlock(
  block: unknown,
): block is { type: 'tool_result'; tool_use_id: string } {
  return (
    block !== null &&
    typeof block === 'object' &&
    'type' in block &&
    (block as { type: string }).type === 'tool_result' &&
    'tool_use_id' in block
  )
}

/** cache_edits block 结构：包含一组删除操作，每项指定要删除的缓存引用（cache_reference）*/
type CachedMCEditsBlock = {
  type: 'cache_edits'
  edits: { type: 'delete'; cache_reference: string }[]
}

/** 已固定的 cache_edits block 及其在用户消息列表中的位置索引 */
type CachedMCPinnedEdits = {
  userMessageIndex: number
  block: CachedMCEditsBlock
}

/**
 * 为消息列表添加提示缓存断点（cache_control 标记）
 *
 * 核心逻辑：
 * - 每次请求只添加一个消息级 cache_control 标记（避免 KV 缓存碎片化）
 * - skipCacheWrite=true 时将标记移到倒数第二条消息（复用已有缓存，不写新缓存）
 * - useCachedMC=true 时还会在用户消息中插入 cache_edits block（用于 cachedMicrocompact 的 KV 缓存删除）：
 *   - 已固定的 cache_edits block（pinnedEdits）重新插回原位置
 *   - 新的 cache_edits block（newCacheEdits）插入最后一条用户消息，并记录到 pinnedEdits
 * - enablePromptCaching=true 时为缓存前缀内的 tool_result block 添加 cache_reference
 *
 * Exported for testing cache_reference placement constraints
 */
export function addCacheBreakpoints(
  messages: (UserMessage | AssistantMessage)[],
  enablePromptCaching: boolean,
  querySource?: QuerySource,
  useCachedMC = false,
  newCacheEdits?: CachedMCEditsBlock | null,
  pinnedEdits?: CachedMCPinnedEdits[],
  skipCacheWrite = false,
): MessageParam[] {
  logEvent('tengu_api_cache_breakpoints', {
    totalMessageCount: messages.length,
    cachingEnabled: enablePromptCaching,
    skipCacheWrite,
  })

  // Exactly one message-level cache_control marker per request. Mycro's
  // turn-to-turn eviction (page_manager/index.rs: Index::insert) frees
  // local-attention KV pages at any cached prefix position NOT in
  // cache_store_int_token_boundaries. With two markers the second-to-last
  // position is protected and its locals survive an extra turn even though
  // nothing will ever resume from there — with one marker they're freed
  // immediately. For fire-and-forget forks (skipCacheWrite) we shift the
  // marker to the second-to-last message: that's the last shared-prefix
  // point, so the write is a no-op merge on mycro (entry already exists)
  // and the fork doesn't leave its own tail in the KVCC. Dense pages are
  // refcounted and survive via the new hash either way.
  const markerIndex = skipCacheWrite ? messages.length - 2 : messages.length - 1 // skipCacheWrite 时移到倒数第二条消息（避免 KVCC 污染）
  const result = messages.map((msg, index) => {
    const addCache = index === markerIndex
    if (msg.type === 'user') {
      return userMessageToMessageParam(
        msg,
        addCache,
        enablePromptCaching,
        querySource,
      )
    }
    return assistantMessageToMessageParam(
      msg,
      addCache,
      enablePromptCaching,
      querySource,
    )
  })

  if (!useCachedMC) {
    return result
  }

  // 跟踪所有已删除的 cache_reference，防止跨 block 重复删除
  const seenDeleteRefs = new Set<string>()

  // 辅助函数：去重 cache_edits block（过滤掉已处理过的删除引用）
  const deduplicateEdits = (block: CachedMCEditsBlock): CachedMCEditsBlock => {
    const uniqueEdits = block.edits.filter(edit => {
      if (seenDeleteRefs.has(edit.cache_reference)) {
        return false
      }
      seenDeleteRefs.add(edit.cache_reference)
      return true
    })
    return { ...block, edits: uniqueEdits }
  }

  // 将所有已固定的 cache_edits 重新插回原始位置（确保历史轮次的删除记录持续发送）
  for (const pinned of pinnedEdits ?? []) {
    const msg = result[pinned.userMessageIndex]
    if (msg && msg.role === 'user') {
      if (!Array.isArray(msg.content)) {
        msg.content = [{ type: 'text', text: msg.content as string }]
      }
      const dedupedBlock = deduplicateEdits(pinned.block)
      if (dedupedBlock.edits.length > 0) {
        insertBlockAfterToolResults(msg.content, dedupedBlock)
      }
    }
  }

  // 将新的 cache_edits 插入最后一条用户消息，并记录到 pinnedEdits（下次请求时重新插回）
  if (newCacheEdits && result.length > 0) {
    const dedupedNewEdits = deduplicateEdits(newCacheEdits)
    if (dedupedNewEdits.edits.length > 0) {
      for (let i = result.length - 1; i >= 0; i--) {
        const msg = result[i]
        if (msg && msg.role === 'user') {
          if (!Array.isArray(msg.content)) {
            msg.content = [{ type: 'text', text: msg.content as string }]
          }
          insertBlockAfterToolResults(msg.content, dedupedNewEdits)
          // 固定到 pinnedEdits：下次请求时在同一位置重新插入（确保持久化的删除记录不丢失）
          pinCacheEdits(i, newCacheEdits)

          logForDebugging(
            `Added cache_edits block with ${dedupedNewEdits.edits.length} deletion(s) to message[${i}]: ${dedupedNewEdits.edits.map(e => e.cache_reference).join(', ')}`,
          )
          break
        }
      }
    }
  }

  // 为缓存前缀内的 tool_result block 添加 cache_reference。
  // 必须在 cache_edits 插入之后执行（插入操作会修改 content 数组）。
  if (enablePromptCaching) {
    // 找到含有 cache_control 标记的最后一条消息的索引
    let lastCCMsg = -1
    for (let i = 0; i < result.length; i++) {
      const msg = result[i]!
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block && typeof block === 'object' && 'cache_control' in block) {
            lastCCMsg = i
          }
        }
      }
    }

    // 为严格位于最后一个 cache_control 标记之前的 tool_result block 添加 cache_reference。
    // API 要求 cache_reference 出现在 cache_control "之前或同一位置"，使用严格的"之前"
    // 可以避免 cache_edits 拼接导致 block 索引偏移时产生边界问题。
    //
    // 创建新对象而非就地修改，以防止被不支持 cache_editing 的二次查询复用时被污染。
    if (lastCCMsg >= 0) {
      for (let i = 0; i < lastCCMsg; i++) {
        const msg = result[i]!
        if (msg.role !== 'user' || !Array.isArray(msg.content)) {
          continue
        }
        let cloned = false
        for (let j = 0; j < msg.content.length; j++) {
          const block = msg.content[j]
          if (block && isToolResultBlock(block)) {
            if (!cloned) {
              msg.content = [...msg.content]
              cloned = true
            }
            msg.content[j] = Object.assign({}, block, {
              cache_reference: block.tool_use_id,
            })
          }
        }
      }
    }
  }

  return result
}

/**
 * 将系统提示（SystemPrompt）转换为 API 所需的 TextBlockParam 数组
 *
 * 通过 splitSysPromptPrefix 将系统提示分割为多个 block，
 * 并为每个 block 按其缓存范围（cacheScope）添加对应的 cache_control 标记。
 *
 * 注意：此处不可再添加新的缓存 block，否则会触发 API 400 错误
 * （每个请求最多允许 4 个 cache_control，超出则报错）。
 */
export function buildSystemPromptBlocks(
  systemPrompt: SystemPrompt,
  enablePromptCaching: boolean,
  options?: {
    skipGlobalCacheForSystemPrompt?: boolean
    querySource?: QuerySource
  },
): TextBlockParam[] {
  // IMPORTANT: 不要再为系统提示添加更多缓存 block，否则会触发 API 400 错误（每次请求最多 4 个 cache_control）
  return splitSysPromptPrefix(systemPrompt, {
    skipGlobalCacheForSystemPrompt: options?.skipGlobalCacheForSystemPrompt,
  }).map(block => {
    return {
      type: 'text' as const,
      text: block.text,
      ...(enablePromptCaching &&
        block.cacheScope !== null && {
          cache_control: getCacheControl({
            scope: block.cacheScope,
            querySource: options?.querySource,
          }),
        }),
    }
  })
}

/** queryHaiku 使用的选项类型：省略 model（自动使用小模型）和 getToolPermissionContext */
type HaikuOptions = Omit<Options, 'model' | 'getToolPermissionContext'>

/**
 * 使用轻量小模型（SmallFastModel / Haiku）进行快速单轮查询
 *
 * 适用场景：不需要工具调用的轻量任务，如内容分类、摘要、提取等。
 * 内部使用 queryModelWithoutStreaming（非流式），禁用工具，
 * 并通过 withVCR 包装以支持测试回放。
 *
 * 注意：由于不使用流式，结果直接返回单条 AssistantMessage，无需消费事件流。
 */
export async function queryHaiku({
  systemPrompt = asSystemPrompt([]),
  userPrompt,
  outputFormat,
  signal,
  options,
}: {
  systemPrompt: SystemPrompt
  userPrompt: string
  outputFormat?: BetaJSONOutputFormat
  signal: AbortSignal
  options: HaikuOptions
}): Promise<AssistantMessage> {
  const result = await withVCR(
    [
      createUserMessage({
        content: systemPrompt.map(text => ({ type: 'text', text })),
      }),
      createUserMessage({
        content: userPrompt,
      }),
    ],
    async () => {
      const messages = [
        createUserMessage({
          content: userPrompt,
        }),
      ]

      const result = await queryModelWithoutStreaming({
        messages,
        systemPrompt,
        thinkingConfig: { type: 'disabled' },
        tools: [],
        signal,
        options: {
          ...options,
          model: getSmallFastModel(),
          enablePromptCaching: options.enablePromptCaching ?? false,
          outputFormat,
          async getToolPermissionContext() {
            return getEmptyToolPermissionContext()
          },
        },
      })
      return [result]
    },
  )
  // We don't use streaming for Haiku so this is safe
  return result[0]! as AssistantMessage
}

/** queryWithModel 使用的选项类型：省略 getToolPermissionContext（不需要工具权限上下文）*/
type QueryWithModelOptions = Omit<Options, 'getToolPermissionContext'>

/**
 * 通过 Claude Code 基础设施查询指定模型（单轮非流式）
 *
 * 与直接调用 API 的区别：本函数经过完整的查询流水线，
 * 包含正确的认证、beta 头部、请求元数据等。
 * 适用于需要指定模型（非默认小模型）的单轮查询场景。
 *
 * Query a specific model through the Claude Code infrastructure.
 * This goes through the full query pipeline including proper authentication,
 * betas, and headers - unlike direct API calls.
 */
export async function queryWithModel({
  systemPrompt = asSystemPrompt([]),
  userPrompt,
  outputFormat,
  signal,
  options,
}: {
  systemPrompt: SystemPrompt
  userPrompt: string
  outputFormat?: BetaJSONOutputFormat
  signal: AbortSignal
  options: QueryWithModelOptions
}): Promise<AssistantMessage> {
  const result = await withVCR(
    [
      createUserMessage({
        content: systemPrompt.map(text => ({ type: 'text', text })),
      }),
      createUserMessage({
        content: userPrompt,
      }),
    ],
    async () => {
      const messages = [
        createUserMessage({
          content: userPrompt,
        }),
      ]

      const result = await queryModelWithoutStreaming({
        messages,
        systemPrompt,
        thinkingConfig: { type: 'disabled' },
        tools: [],
        signal,
        options: {
          ...options,
          enablePromptCaching: options.enablePromptCaching ?? false,
          outputFormat,
          async getToolPermissionContext() {
            return getEmptyToolPermissionContext()
          },
        },
      })
      return [result]
    },
  )
  return result[0]! as AssistantMessage
}

// 非流式请求文档规定最长 10 分钟：
// https://platform.claude.com/docs/en/api/errors#long-requests
// SDK 推导的 21333 token 上限来自 10min × 128k tokens/hour，
// 但我们通过设置客户端超时绕过了该限制，因此可以设置更高的上限。
// Non-streaming requests have a 10min max per the docs:
// https://platform.claude.com/docs/en/api/errors#long-requests
// The SDK's 21333-token cap is derived from 10min × 128k tokens/hour, but we
// bypass it by setting a client-level timeout, so we can cap higher.
export const MAX_NON_STREAMING_TOKENS = 64_000

/**
 * 为非流式降级请求调整 max_tokens 和 thinking.budget_tokens
 *
 * 非流式模式下 max_tokens 被限制在 MAX_NON_STREAMING_TOKENS（64k）以内。
 * API 约束：max_tokens > thinking.budget_tokens，
 * 因此当 max_tokens 被压缩时，也需要同步压缩 thinking.budget_tokens。
 *
 * Adjusts thinking budget when max_tokens is capped for non-streaming fallback.
 * Ensures the API constraint: max_tokens > thinking.budget_tokens
 *
 * @param params - The parameters that will be sent to the API
 * @param maxTokensCap - The maximum allowed tokens (MAX_NON_STREAMING_TOKENS)
 * @returns Adjusted parameters with thinking budget capped if needed
 */
export function adjustParamsForNonStreaming<
  T extends {
    max_tokens: number
    thinking?: BetaMessageStreamParams['thinking']
  },
>(params: T, maxTokensCap: number): T {
  const cappedMaxTokens = Math.min(params.max_tokens, maxTokensCap)

  // Adjust thinking budget if it would exceed capped max_tokens
  // 若 thinking.budget_tokens 超出压缩后的 max_tokens，需同步调整（API 约束：max_tokens > budget_tokens）
  const adjustedParams = { ...params }
  if (
    adjustedParams.thinking?.type === 'enabled' &&
    adjustedParams.thinking.budget_tokens
  ) {
    adjustedParams.thinking = {
      ...adjustedParams.thinking,
      budget_tokens: Math.min(
        adjustedParams.thinking.budget_tokens,
        cappedMaxTokens - 1, // 至少比 max_tokens 小 1（API 强制约束）
      ),
    }
  }

  return {
    ...adjustedParams,
    max_tokens: cappedMaxTokens,
  }
}

/**
 * 检查是否启用了 max_tokens 槽位预留压缩（tengu_otk_slot_v1）
 *
 * 启用时将所有模型的默认 max_tokens 压缩至 CAPPED_DEFAULT_MAX_TOKENS（8k），
 * 避免 32k/64k 默认值过度预占 KV 缓存槽位（BQ p99 输出仅 4,911 tokens）。
 * 3P 提供商（Bedrock/Vertex）默认关闭（未验证兼容性）。
 */
function isMaxTokensCapEnabled(): boolean {
  // 3P default: false (not validated on Bedrock/Vertex)
  return getFeatureValue_CACHED_MAY_BE_STALE('tengu_otk_slot_v1', false)
}

/**
 * 获取指定模型的最大输出 token 数
 *
 * 处理流程：
 * 1. 从模型配置获取原生上限（getModelMaxOutputTokens）
 * 2. 若启用了 tengu_otk_slot_v1，将默认值压缩至 CAPPED_DEFAULT_MAX_TOKENS（8k），
 *    但保留原生上限低于 8k 的模型（如 claude-3-opus 的 4k）的原始值
 * 3. 允许 CLAUDE_CODE_MAX_OUTPUT_TOKENS 环境变量覆盖默认值（不超过原生上限）
 */
export function getMaxOutputTokensForModel(model: string): number {
  const maxOutputTokens = getModelMaxOutputTokens(model)

  // 槽位预留压缩：将所有模型的默认值降至 8k。BQ p99 输出 = 4,911 tokens；
  // 32k/64k 默认值过度预占槽位容量 8-16 倍。达到上限的请求会在 query.ts 以 64k 进行一次重试
  // （max_output_tokens_escalate）。Math.min 保护原生上限低于 8k 的模型（如 claude-3-opus 的 4k）。
  // 在环境变量覆盖之前应用，使 CLAUDE_CODE_MAX_OUTPUT_TOKENS 仍能生效。
  const defaultTokens = isMaxTokensCapEnabled()
    ? Math.min(maxOutputTokens.default, CAPPED_DEFAULT_MAX_TOKENS)
    : maxOutputTokens.default

  // 允许通过 CLAUDE_CODE_MAX_OUTPUT_TOKENS 环境变量覆盖默认值（不超过原生上限）
  const result = validateBoundedIntEnvVar(
    'CLAUDE_CODE_MAX_OUTPUT_TOKENS',
    process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS,
    defaultTokens,
    maxOutputTokens.upperLimit,
  )
  return result.effective
}
