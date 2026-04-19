/**
 * API 调用日志模块
 *
 * 在 Claude Code 系统流程中的位置：
 *   每次向 Anthropic API 发起请求时 → 记录查询参数（logAPIQuery）
 *   → API 响应成功 → 记录成功指标和耗时（logAPISuccessAndDuration）
 *   → API 响应失败 → 记录错误详情（logAPIError）
 *
 * 主要功能：
 *  - logAPIQuery              — 在请求发起前记录模型、参数、querySource 等基本信息
 *  - logAPIError              — 请求失败时记录错误类型、HTTP 状态码、AI 网关信息等
 *  - logAPISuccessAndDuration — 请求成功时记录 token 用量、耗时、成本及追踪 span
 *  - detectGateway            — 从响应头或 baseUrl 主机名识别 AI 网关类型
 *
 * 特点：
 *  - 使用 GATEWAY_FINGERPRINTS（响应头前缀匹配）和 GATEWAY_HOST_SUFFIXES（主机名后缀匹配）
 *    识别 litellm/helicone/portkey/cloudflare/kong/braintrust/databricks 等 7 种网关
 *  - 集成 OTel 事件（logOTelEvent）用于分布式追踪
 *  - 通过 endLLMRequestSpan 管理 beta 追踪 span 的生命周期
 *  - 记录传送（teleport）会话的首次消息成功/错误事件，用于可靠性追踪
 *  - 在启用 CACHED_MICROCOMPACT 功能时额外记录 cache_deleted_input_tokens
 */

import { feature } from 'bun:bundle'
import { APIError } from '@anthropic-ai/sdk'
import type {
  BetaStopReason,
  BetaUsage as Usage,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import {
  addToTotalDurationState,
  consumePostCompaction,
  getIsNonInteractiveSession,
  getLastApiCompletionTimestamp,
  getTeleportedSessionInfo,
  markFirstTeleportMessageLogged,
  setLastApiCompletionTimestamp,
} from 'src/bootstrap/state.js'
import type { QueryChainTracking } from 'src/Tool.js'
import { isConnectorTextBlock } from 'src/types/connectorText.js'
import type { AssistantMessage } from 'src/types/message.js'
import { logForDebugging } from 'src/utils/debug.js'
import type { EffortLevel } from 'src/utils/effort.js'
import { logError } from 'src/utils/log.js'
import { getAPIProviderForStatsig } from 'src/utils/model/providers.js'
import type { PermissionMode } from 'src/utils/permissions/PermissionMode.js'
import { jsonStringify } from 'src/utils/slowOperations.js'
import { logOTelEvent } from 'src/utils/telemetry/events.js'
import {
  endLLMRequestSpan,
  isBetaTracingEnabled,
  type Span,
} from 'src/utils/telemetry/sessionTracing.js'
import type { NonNullableUsage } from '../../entrypoints/sdk/sdkUtilityTypes.js'
import { consumeInvokingRequestId } from '../../utils/agentContext.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../analytics/index.js'
import { sanitizeToolNameForAnalytics } from '../analytics/metadata.js'
import { EMPTY_USAGE } from './emptyUsage.js'
import { classifyAPIError } from './errors.js'
import { extractConnectionErrorDetails } from './errorUtils.js'

// 重新导出类型，供外部模块使用
export type { NonNullableUsage }
export { EMPTY_USAGE }

// 全局提示词缓存策略类型：基于工具 / 基于系统提示 / 无缓存
export type GlobalCacheStrategy = 'tool_based' | 'system_prompt' | 'none'

/**
 * 从错误对象中提取可读的错误消息字符串。
 * 优先取 APIError 响应体中的 error.message，其次为 Error.message，最后 toString。
 */
function getErrorMessage(error: unknown): string {
  if (error instanceof APIError) {
    // 尝试从 API 错误响应体中获取结构化消息
    const body = error.error as { error?: { message?: string } } | undefined
    if (body?.error?.message) return body.error.message
  }
  return error instanceof Error ? error.message : String(error)
}

// 已知 AI 网关类型枚举
type KnownGateway =
  | 'litellm'
  | 'helicone'
  | 'portkey'
  | 'cloudflare-ai-gateway'
  | 'kong'
  | 'braintrust'
  | 'databricks'

// 各网关的响应头前缀特征指纹（用于通过响应头识别代理网关）
const GATEWAY_FINGERPRINTS: Partial<
  Record<KnownGateway, { prefixes: string[] }>
> = {
  // https://docs.litellm.ai/docs/proxy/response_headers
  litellm: {
    prefixes: ['x-litellm-'],
  },
  // https://docs.helicone.ai/helicone-headers/header-directory
  helicone: {
    prefixes: ['helicone-'],
  },
  // https://portkey.ai/docs/api-reference/response-schema
  portkey: {
    prefixes: ['x-portkey-'],
  },
  // https://developers.cloudflare.com/ai-gateway/evaluations/add-human-feedback-api/
  'cloudflare-ai-gateway': {
    prefixes: ['cf-aig-'],
  },
  // https://developer.konghq.com/ai-gateway/ — X-Kong-Upstream-Latency, X-Kong-Proxy-Latency
  kong: {
    prefixes: ['x-kong-'],
  },
  // https://www.braintrust.dev/docs/guides/proxy — x-bt-used-endpoint, x-bt-cached
  braintrust: {
    prefixes: ['x-bt-'],
  },
}

// 使用提供商自有域名（非自托管）的网关，可通过 ANTHROPIC_BASE_URL 主机名后缀识别
const GATEWAY_HOST_SUFFIXES: Partial<Record<KnownGateway, string[]>> = {
  // https://docs.databricks.com/aws/en/ai-gateway/
  databricks: [
    '.cloud.databricks.com',
    '.azuredatabricks.net',
    '.gcp.databricks.com',
  ],
}

/**
 * 从响应头或 ANTHROPIC_BASE_URL 中检测 AI 网关类型。
 *
 * 检测顺序：
 *  1. 遍历响应头，匹配 GATEWAY_FINGERPRINTS 中各网关的前缀特征
 *  2. 若未命中，解析 baseUrl 主机名，匹配 GATEWAY_HOST_SUFFIXES 中的后缀
 *
 * @param headers - 响应头对象（来自成功响应或错误响应）
 * @param baseUrl - 可选的 API 基础 URL（env ANTHROPIC_BASE_URL）
 * @returns 检测到的网关类型，未检测到则返回 undefined
 */
function detectGateway({
  headers,
  baseUrl,
}: {
  headers?: globalThis.Headers
  baseUrl?: string
}): KnownGateway | undefined {
  if (headers) {
    // Headers API 返回的键名已为小写，无需转换
    const headerNames: string[] = []
    headers.forEach((_, key) => headerNames.push(key))
    // 遍历所有已知网关指纹，检查响应头前缀是否匹配
    for (const [gw, { prefixes }] of Object.entries(GATEWAY_FINGERPRINTS)) {
      if (prefixes.some(p => headerNames.some(h => h.startsWith(p)))) {
        return gw as KnownGateway
      }
    }
  }

  if (baseUrl) {
    try {
      // 解析 baseUrl，提取小写主机名用于后缀匹配
      const host = new URL(baseUrl).hostname.toLowerCase()
      for (const [gw, suffixes] of Object.entries(GATEWAY_HOST_SUFFIXES)) {
        if (suffixes.some(s => host.endsWith(s))) {
          return gw as KnownGateway
        }
      }
    } catch {
      // URL 格式异常时忽略，不影响主流程
    }
  }

  return undefined
}

/**
 * 收集 Anthropic 相关环境变量（ANTHROPIC_BASE_URL / ANTHROPIC_MODEL / ANTHROPIC_SMALL_FAST_MODEL），
 * 用于在分析事件中记录自定义 API 环境配置。
 */
function getAnthropicEnvMetadata() {
  return {
    // 若设置了自定义 API base URL，则记录（可能是网关或代理地址）
    ...(process.env.ANTHROPIC_BASE_URL
      ? {
          baseUrl: process.env
            .ANTHROPIC_BASE_URL as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        }
      : {}),
    // 若通过环境变量指定了模型，则记录
    ...(process.env.ANTHROPIC_MODEL
      ? {
          envModel: process.env
            .ANTHROPIC_MODEL as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        }
      : {}),
    // 若通过环境变量指定了小/快速模型，则记录
    ...(process.env.ANTHROPIC_SMALL_FAST_MODEL
      ? {
          envSmallFastModel: process.env
            .ANTHROPIC_SMALL_FAST_MODEL as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        }
      : {}),
  }
}

/**
 * 计算构建产物的"年龄"（单位：分钟）。
 * 用于分析事件中标识用户使用的是最新版还是旧版 Claude Code。
 */
function getBuildAgeMinutes(): number | undefined {
  if (!MACRO.BUILD_TIME) return undefined
  const buildTime = new Date(MACRO.BUILD_TIME).getTime()
  if (isNaN(buildTime)) return undefined
  return Math.floor((Date.now() - buildTime) / 60000)
}

/**
 * 在向 API 发起查询前记录请求参数（Phase 1：请求发起）。
 *
 * 记录内容：
 *  - 模型名称、消息条数、温度参数
 *  - beta 特性列表（以逗号连接的字符串）
 *  - 权限模式、请求来源、查询链追踪信息
 *  - 思考类型、努力等级、快速模式标志
 *  - 上一次请求 ID（用于跨请求关联）
 *
 * @param model           - 使用的模型名称
 * @param messagesLength  - 消息历史长度
 * @param temperature     - 温度参数
 * @param betas           - 启用的 beta 特性列表
 * @param permissionMode  - 权限模式
 * @param querySource     - 请求来源标识
 * @param queryTracking   - 查询链追踪信息（chainId + depth）
 * @param thinkingType    - 思考模式类型
 * @param effortValue     - 努力等级
 * @param fastMode        - 是否为快速模式
 * @param previousRequestId - 上一次请求 ID
 */
export function logAPIQuery({
  model,
  messagesLength,
  temperature,
  betas,
  permissionMode,
  querySource,
  queryTracking,
  thinkingType,
  effortValue,
  fastMode,
  previousRequestId,
}: {
  model: string
  messagesLength: number
  temperature: number
  betas?: string[]
  permissionMode?: PermissionMode
  querySource: string
  queryTracking?: QueryChainTracking
  thinkingType?: 'adaptive' | 'enabled' | 'disabled'
  effortValue?: EffortLevel | null
  fastMode?: boolean
  previousRequestId?: string | null
}): void {
  logEvent('tengu_api_query', {
    model: model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    messagesLength,
    temperature: temperature,
    provider: getAPIProviderForStatsig(), // 记录 API 提供商（用于 Statsig 分析）
    buildAgeMins: getBuildAgeMinutes(),   // 记录构建年龄（分钟）
    // 仅在有 betas 时记录，避免发送空字段
    ...(betas?.length
      ? {
          betas: betas.join(
            ',',
          ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        }
      : {}),
    permissionMode:
      permissionMode as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    querySource:
      querySource as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    // 仅在有查询链追踪信息时展开记录
    ...(queryTracking
      ? {
          queryChainId:
            queryTracking.chainId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          queryDepth: queryTracking.depth,
        }
      : {}),
    thinkingType:
      thinkingType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    effortValue:
      effortValue as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    fastMode,
    // 仅在有上一次请求 ID 时记录
    ...(previousRequestId
      ? {
          previousRequestId:
            previousRequestId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        }
      : {}),
    ...getAnthropicEnvMetadata(), // 附加 Anthropic 环境变量信息
  })
}

/**
 * 记录 API 请求失败事件（Phase 2：请求出错）。
 *
 * 处理流程：
 *  1. 检测 AI 网关（来自错误响应头或 ANTHROPIC_BASE_URL）
 *  2. 提取错误消息、HTTP 状态码、错误分类
 *  3. 若为连接错误，向调试日志输出详细信息（含 SSL 标记）
 *  4. 消费父调用请求 ID（用于子 agent 关联）
 *  5. 向 Statsig 发送 tengu_api_error 事件
 *  6. 向 OTel 发送 api_error 事件
 *  7. 关闭 beta 追踪 span（标记为失败）
 *  8. 若为传送会话首条消息，记录 tengu_teleport_first_message_error
 *
 * @param error                    - 捕获的错误对象
 * @param model                    - 使用的模型名称
 * @param messageCount             - 消息条数
 * @param messageTokens            - 消息 token 数
 * @param durationMs               - 本次尝试耗时（ms）
 * @param durationMsIncludingRetries - 含重试总耗时（ms）
 * @param attempt                  - 当前尝试次数
 * @param requestId                - 服务端返回的请求 ID
 * @param clientRequestId          - 客户端生成的请求 ID（x-client-request-id，超时后仍可用）
 * @param didFallBackToNonStreaming - 是否回退到非流式模式
 * @param promptCategory           - 提示词分类
 * @param headers                  - 响应头（用于网关检测）
 * @param queryTracking            - 查询链追踪信息
 * @param querySource              - 请求来源
 * @param llmSpan                  - startLLMRequestSpan 返回的追踪 span
 * @param fastMode                 - 是否为快速模式
 * @param previousRequestId        - 上一次请求 ID
 */
export function logAPIError({
  error,
  model,
  messageCount,
  messageTokens,
  durationMs,
  durationMsIncludingRetries,
  attempt,
  requestId,
  clientRequestId,
  didFallBackToNonStreaming,
  promptCategory,
  headers,
  queryTracking,
  querySource,
  llmSpan,
  fastMode,
  previousRequestId,
}: {
  error: unknown
  model: string
  messageCount: number
  messageTokens?: number
  durationMs: number
  durationMsIncludingRetries: number
  attempt: number
  requestId?: string | null
  /** Client-generated ID sent as x-client-request-id header (survives timeouts) */
  clientRequestId?: string
  didFallBackToNonStreaming?: boolean
  promptCategory?: string
  headers?: globalThis.Headers
  queryTracking?: QueryChainTracking
  querySource?: string
  /** The span from startLLMRequestSpan - pass this to correctly match responses to requests */
  llmSpan?: Span
  fastMode?: boolean
  previousRequestId?: string | null
}): void {
  // 优先从错误对象自带的响应头检测网关，其次使用传入的 headers
  const gateway = detectGateway({
    headers:
      error instanceof APIError && error.headers ? error.headers : headers,
    baseUrl: process.env.ANTHROPIC_BASE_URL,
  })

  const errStr = getErrorMessage(error)                           // 提取可读错误消息
  const status = error instanceof APIError ? String(error.status) : undefined // HTTP 状态码
  const errorType = classifyAPIError(error)                       // 错误分类（网络/认证/限流等）

  // Log detailed connection error info to debug logs (visible via --debug)
  const connectionDetails = extractConnectionErrorDetails(error)
  if (connectionDetails) {
    // 若为 SSL 错误，附加 SSL 标记
    const sslLabel = connectionDetails.isSSLError ? ' (SSL error)' : ''
    logForDebugging(
      `Connection error details: code=${connectionDetails.code}${sslLabel}, message=${connectionDetails.message}`,
      { level: 'error' },
    )
  }

  // 消费父调用请求 ID（子 agent 关联，每次请求只消费一次）
  const invocation = consumeInvokingRequestId()

  if (clientRequestId) {
    // 向调试日志输出客户端请求 ID，便于 API 团队在服务端日志中定位
    logForDebugging(
      `API error x-client-request-id=${clientRequestId} (give this to the API team for server-log lookup)`,
      { level: 'error' },
    )
  }

  logError(error as Error) // 记录到本地错误日志
  // 向 Statsig 发送 API 错误分析事件
  logEvent('tengu_api_error', {
    model: model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    error: errStr as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    status:
      status as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    errorType:
      errorType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    messageCount,
    messageTokens,
    durationMs,
    durationMsIncludingRetries,
    attempt,
    provider: getAPIProviderForStatsig(),
    requestId:
      (requestId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS) ||
      undefined,
    // 仅在有父调用信息时展开记录
    ...(invocation
      ? {
          invokingRequestId:
            invocation.invokingRequestId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          invocationKind:
            invocation.invocationKind as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        }
      : {}),
    clientRequestId:
      (clientRequestId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS) ||
      undefined,
    didFallBackToNonStreaming,
    // 仅在有提示词分类时记录
    ...(promptCategory
      ? {
          promptCategory:
            promptCategory as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        }
      : {}),
    // 仅在检测到网关时记录
    ...(gateway
      ? {
          gateway:
            gateway as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        }
      : {}),
    // 仅在有查询链追踪信息时展开记录
    ...(queryTracking
      ? {
          queryChainId:
            queryTracking.chainId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          queryDepth: queryTracking.depth,
        }
      : {}),
    ...(querySource
      ? {
          querySource:
            querySource as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        }
      : {}),
    fastMode,
    ...(previousRequestId
      ? {
          previousRequestId:
            previousRequestId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        }
      : {}),
    ...getAnthropicEnvMetadata(),
  })

  // Log API error event for OTLP
  // 向 OTel 发送 api_error 事件，供分布式追踪使用
  void logOTelEvent('api_error', {
    model: model,
    error: errStr,
    status_code: String(status),
    duration_ms: String(durationMs),
    attempt: String(attempt),
    speed: fastMode ? 'fast' : 'normal',
  })

  // Pass the span to correctly match responses to requests when beta tracing is enabled
  // 关闭 beta 追踪 span，标记请求失败及错误详情
  endLLMRequestSpan(llmSpan, {
    success: false,
    statusCode: status ? parseInt(status) : undefined,
    error: errStr,
    attempt,
  })

  // Log first error for teleported sessions (reliability tracking)
  // 传送会话可靠性追踪：仅记录首条消息的错误
  const teleportInfo = getTeleportedSessionInfo()
  if (teleportInfo?.isTeleported && !teleportInfo.hasLoggedFirstMessage) {
    logEvent('tengu_teleport_first_message_error', {
      session_id:
        teleportInfo.sessionId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      error_type:
        errorType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    markFirstTeleportMessageLogged() // 标记首条消息已记录，避免重复
  }
}

/**
 * 记录 API 请求成功事件（内部函数）。
 *
 * 记录内容：
 *  - Token 用量（输入/输出/缓存读取/缓存创建）
 *  - 请求耗时（本次 + 含重试总耗时）、首 token 耗时
 *  - 停止原因、成本（USD）
 *  - 请求来源、网关、查询链、权限模式
 *  - 全局缓存策略、响应内容长度统计
 *  - cache_deleted_input_tokens（仅在 CACHED_MICROCOMPACT 开启时）
 */
function logAPISuccess({
  model,
  preNormalizedModel,
  messageCount,
  messageTokens,
  usage,
  durationMs,
  durationMsIncludingRetries,
  attempt,
  ttftMs,
  requestId,
  stopReason,
  costUSD,
  didFallBackToNonStreaming,
  querySource,
  gateway,
  queryTracking,
  permissionMode,
  globalCacheStrategy,
  textContentLength,
  thinkingContentLength,
  toolUseContentLengths,
  connectorTextBlockCount,
  fastMode,
  previousRequestId,
  betas,
}: {
  model: string
  preNormalizedModel: string
  messageCount: number
  messageTokens: number
  usage: Usage
  durationMs: number
  durationMsIncludingRetries: number
  attempt: number
  ttftMs: number | null
  requestId: string | null
  stopReason: BetaStopReason | null
  costUSD: number
  didFallBackToNonStreaming: boolean
  querySource: string
  gateway?: KnownGateway
  queryTracking?: QueryChainTracking
  permissionMode?: PermissionMode
  globalCacheStrategy?: GlobalCacheStrategy
  textContentLength?: number
  thinkingContentLength?: number
  toolUseContentLengths?: Record<string, number>
  connectorTextBlockCount?: number
  fastMode?: boolean
  previousRequestId?: string | null
  betas?: string[]
}): void {
  const isNonInteractiveSession = getIsNonInteractiveSession() // 是否为非交互式会话（-p 模式）
  const isPostCompaction = consumePostCompaction()              // 是否为压缩后的首次请求
  const hasPrintFlag =
    process.argv.includes('-p') || process.argv.includes('--print') // 是否有 --print 标志

  const now = Date.now()
  const lastCompletion = getLastApiCompletionTimestamp()
  // 计算距上次 API 完成的时间间隔（用于分析请求频率）
  const timeSinceLastApiCallMs =
    lastCompletion !== null ? now - lastCompletion : undefined

  // 消费父调用请求 ID（子 agent 关联）
  const invocation = consumeInvokingRequestId()

  // 向 Statsig 发送成功分析事件
  logEvent('tengu_api_success', {
    model: model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    // 仅在模型名称被规范化时记录原始名称（如 claude-3-5-sonnet-latest → 具体版本号）
    ...(preNormalizedModel !== model
      ? {
          preNormalizedModel:
            preNormalizedModel as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        }
      : {}),
    ...(betas?.length
      ? {
          betas: betas.join(
            ',',
          ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        }
      : {}),
    messageCount,
    messageTokens,
    inputTokens: usage.input_tokens,           // 输入 token 数
    outputTokens: usage.output_tokens,          // 输出 token 数
    cachedInputTokens: usage.cache_read_input_tokens ?? 0,      // 缓存读取 token 数
    uncachedInputTokens: usage.cache_creation_input_tokens ?? 0, // 缓存创建 token 数
    durationMs: durationMs,
    durationMsIncludingRetries: durationMsIncludingRetries,
    attempt: attempt,
    ttftMs: ttftMs ?? undefined,
    buildAgeMins: getBuildAgeMinutes(),
    provider: getAPIProviderForStatsig(),
    requestId:
      (requestId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS) ??
      undefined,
    ...(invocation
      ? {
          invokingRequestId:
            invocation.invokingRequestId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          invocationKind:
            invocation.invocationKind as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        }
      : {}),
    stop_reason:
      (stopReason as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS) ??
      undefined,
    costUSD,
    didFallBackToNonStreaming,
    isNonInteractiveSession,
    print: hasPrintFlag,
    isTTY: process.stdout.isTTY ?? false, // 是否在终端中运行
    querySource:
      querySource as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    ...(gateway
      ? {
          gateway:
            gateway as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        }
      : {}),
    ...(queryTracking
      ? {
          queryChainId:
            queryTracking.chainId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          queryDepth: queryTracking.depth,
        }
      : {}),
    permissionMode:
      permissionMode as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    ...(globalCacheStrategy
      ? {
          globalCacheStrategy:
            globalCacheStrategy as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        }
      : {}),
    ...(textContentLength !== undefined
      ? ({
          textContentLength,
        } as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS)
      : {}),
    ...(thinkingContentLength !== undefined
      ? ({
          thinkingContentLength,
        } as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS)
      : {}),
    ...(toolUseContentLengths !== undefined
      ? ({
          toolUseContentLengths: jsonStringify(
            toolUseContentLengths,
          ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        } as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS)
      : {}),
    ...(connectorTextBlockCount !== undefined
      ? ({
          connectorTextBlockCount,
        } as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS)
      : {}),
    fastMode,
    // Log cache_deleted_input_tokens for cache editing analysis. Casts needed
    // because the field is intentionally not on NonNullableUsage (excluded from
    // external builds). Set by updateUsage() when cache editing is active.
    // 仅在 CACHED_MICROCOMPACT 功能开启且有缓存删除 token 时记录
    ...(feature('CACHED_MICROCOMPACT') &&
    ((usage as unknown as { cache_deleted_input_tokens?: number })
      .cache_deleted_input_tokens ?? 0) > 0
      ? {
          cacheDeletedInputTokens: (
            usage as unknown as { cache_deleted_input_tokens: number }
          ).cache_deleted_input_tokens,
        }
      : {}),
    ...(previousRequestId
      ? {
          previousRequestId:
            previousRequestId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        }
      : {}),
    // 标记本次请求是否在压缩（compaction）之后
    ...(isPostCompaction ? { isPostCompaction } : {}),
    ...getAnthropicEnvMetadata(),
    timeSinceLastApiCallMs, // 距上次 API 完成的间隔时间
  })

  // 更新最后一次 API 完成时间戳
  setLastApiCompletionTimestamp(now)
}

/**
 * 记录 API 请求成功及耗时信息（对外暴露的公开函数）。
 *
 * 处理流程：
 *  1. 检测 AI 网关（响应头 + baseUrl）
 *  2. 遍历新消息，统计文本/thinking/工具调用内容长度
 *  3. 计算本次请求耗时和含重试总耗时，并累加到全局耗时状态
 *  4. 调用内部 logAPISuccess 发送 Statsig 分析事件
 *  5. 向 OTel 发送 api_request 事件
 *  6. 若 beta 追踪已开启，提取模型输出/thinking 输出/工具调用标志
 *  7. 关闭 beta 追踪 span（标记为成功，包含 token 用量和输出内容）
 *  8. 若为传送会话首条消息，记录 tengu_teleport_first_message_success
 *
 * @param model              - 使用的模型名称（已规范化）
 * @param preNormalizedModel - 规范化前的原始模型名称
 * @param start              - 本次尝试开始时间戳（Date.now()）
 * @param startIncludingRetries - 含重试的总开始时间戳
 * @param ttftMs             - 首 token 耗时（ms），未收到则为 null
 * @param usage              - Token 用量统计
 * @param attempt            - 当前尝试次数
 * @param messageCount       - 消息条数
 * @param messageTokens      - 消息 token 数
 * @param requestId          - 服务端请求 ID
 * @param stopReason         - 停止原因
 * @param didFallBackToNonStreaming - 是否回退到非流式模式
 * @param querySource        - 请求来源
 * @param headers            - 响应头（用于网关检测）
 * @param costUSD            - 请求成本（USD）
 * @param queryTracking      - 查询链追踪信息
 * @param permissionMode     - 权限模式
 * @param newMessages        - 响应中的新助手消息（用于提取模型输出和 thinking 输出）
 * @param llmSpan            - startLLMRequestSpan 返回的追踪 span
 * @param globalCacheStrategy - 全局缓存策略
 * @param requestSetupMs     - 请求前置设置耗时（ms）
 * @param attemptStartTimes  - 各次尝试的开始时间戳数组（用于 Perfetto 重试子 span）
 * @param fastMode           - 是否为快速模式
 * @param previousRequestId  - 上一次请求 ID
 * @param betas              - 启用的 beta 特性列表
 */
export function logAPISuccessAndDuration({
  model,
  preNormalizedModel,
  start,
  startIncludingRetries,
  ttftMs,
  usage,
  attempt,
  messageCount,
  messageTokens,
  requestId,
  stopReason,
  didFallBackToNonStreaming,
  querySource,
  headers,
  costUSD,
  queryTracking,
  permissionMode,
  newMessages,
  llmSpan,
  globalCacheStrategy,
  requestSetupMs,
  attemptStartTimes,
  fastMode,
  previousRequestId,
  betas,
}: {
  model: string
  preNormalizedModel: string
  start: number
  startIncludingRetries: number
  ttftMs: number | null
  usage: NonNullableUsage
  attempt: number
  messageCount: number
  messageTokens: number
  requestId: string | null
  stopReason: BetaStopReason | null
  didFallBackToNonStreaming: boolean
  querySource: string
  headers?: globalThis.Headers
  costUSD: number
  queryTracking?: QueryChainTracking
  permissionMode?: PermissionMode
  /** Assistant messages from the response - used to extract model_output and thinking_output
   *  when beta tracing is enabled */
  newMessages?: AssistantMessage[]
  /** The span from startLLMRequestSpan - pass this to correctly match responses to requests */
  llmSpan?: Span
  /** Strategy used for global prompt caching: 'tool_based', 'system_prompt', or 'none' */
  globalCacheStrategy?: GlobalCacheStrategy
  /** Time spent in pre-request setup before the successful attempt */
  requestSetupMs?: number
  /** Timestamps (Date.now()) of each attempt start — used for retry sub-spans in Perfetto */
  attemptStartTimes?: number[]
  fastMode?: boolean
  /** Request ID from the previous API call in this session */
  previousRequestId?: string | null
  betas?: string[]
}): void {
  // 检测 AI 网关（优先通过响应头，其次通过 baseUrl 主机名）
  const gateway = detectGateway({
    headers,
    baseUrl: process.env.ANTHROPIC_BASE_URL,
  })

  // 初始化响应内容长度统计变量
  let textContentLength: number | undefined
  let thinkingContentLength: number | undefined
  let toolUseContentLengths: Record<string, number> | undefined
  let connectorTextBlockCount: number | undefined

  if (newMessages) {
    // 遍历所有新消息的内容块，统计各类内容长度
    let textLen = 0
    let thinkingLen = 0
    let hasToolUse = false
    const toolLengths: Record<string, number> = {}
    let connectorCount = 0

    for (const msg of newMessages) {
      for (const block of msg.message.content) {
        if (block.type === 'text') {
          // 累加文本内容长度
          textLen += block.text.length
        } else if (feature('CONNECTOR_TEXT') && isConnectorTextBlock(block)) {
          // 统计 connector 文本块数量（仅在 CONNECTOR_TEXT 功能开启时）
          connectorCount++
        } else if (block.type === 'thinking') {
          // 累加 thinking 内容长度
          thinkingLen += block.thinking.length
        } else if (
          block.type === 'tool_use' ||
          block.type === 'server_tool_use' ||
          block.type === 'mcp_tool_use'
        ) {
          // 统计工具调用输入的字节长度（按工具名聚合）
          const inputLen = jsonStringify(block.input).length
          const sanitizedName = sanitizeToolNameForAnalytics(block.name) // 工具名脱敏（防泄露）
          toolLengths[sanitizedName] =
            (toolLengths[sanitizedName] ?? 0) + inputLen
          hasToolUse = true
        }
      }
    }

    textContentLength = textLen
    thinkingContentLength = thinkingLen > 0 ? thinkingLen : undefined // 无 thinking 则不记录
    toolUseContentLengths = hasToolUse ? toolLengths : undefined       // 无工具调用则不记录
    connectorTextBlockCount = connectorCount > 0 ? connectorCount : undefined
  }

  // 计算请求耗时（本次成功尝试的耗时）
  const durationMs = Date.now() - start
  // 计算含重试总耗时（从首次尝试开始到成功）
  const durationMsIncludingRetries = Date.now() - startIncludingRetries
  // 将耗时累加到全局状态（用于会话总耗时统计）
  addToTotalDurationState(durationMsIncludingRetries, durationMs)

  // 调用内部成功记录函数，发送 Statsig 分析事件
  logAPISuccess({
    model,
    preNormalizedModel,
    messageCount,
    messageTokens,
    usage,
    durationMs,
    durationMsIncludingRetries,
    attempt,
    ttftMs,
    requestId,
    stopReason,
    costUSD,
    didFallBackToNonStreaming,
    querySource,
    gateway,
    queryTracking,
    permissionMode,
    globalCacheStrategy,
    textContentLength,
    thinkingContentLength,
    toolUseContentLengths,
    connectorTextBlockCount,
    fastMode,
    previousRequestId,
    betas,
  })
  // Log API request event for OTLP
  // 向 OTel 发送 api_request 事件，携带 token 用量和成本
  void logOTelEvent('api_request', {
    model,
    input_tokens: String(usage.input_tokens),
    output_tokens: String(usage.output_tokens),
    cache_read_tokens: String(usage.cache_read_input_tokens),
    cache_creation_tokens: String(usage.cache_creation_input_tokens),
    cost_usd: String(costUSD),
    duration_ms: String(durationMs),
    speed: fastMode ? 'fast' : 'normal',
  })

  // Extract model output, thinking output, and tool call flag when beta tracing is enabled
  // beta 追踪开启时，从新消息中提取模型输出和 thinking 输出
  let modelOutput: string | undefined
  let thinkingOutput: string | undefined
  let hasToolCall: boolean | undefined

  if (isBetaTracingEnabled() && newMessages) {
    // Model output - visible to all users
    // 提取所有文本内容块，合并为模型输出
    modelOutput =
      newMessages
        .flatMap(m =>
          m.message.content
            .filter(c => c.type === 'text')
            .map(c => (c as { type: 'text'; text: string }).text),
        )
        .join('\n') || undefined

    // Thinking output - Ant-only (build-time gated)
    // thinking 输出仅对 Anthropic 内部人员开放（通过 USER_TYPE=ant 环境变量控制）
    if (process.env.USER_TYPE === 'ant') {
      thinkingOutput =
        newMessages
          .flatMap(m =>
            m.message.content
              .filter(c => c.type === 'thinking')
              .map(c => (c as { type: 'thinking'; thinking: string }).thinking),
          )
          .join('\n') || undefined
    }

    // Check if any tool_use blocks were in the output
    // 检测响应中是否包含工具调用块
    hasToolCall = newMessages.some(m =>
      m.message.content.some(c => c.type === 'tool_use'),
    )
  }

  // Pass the span to correctly match responses to requests when beta tracing is enabled
  // 关闭 beta 追踪 span，标记请求成功，附加 token 用量、模型输出、重试信息
  endLLMRequestSpan(llmSpan, {
    success: true,
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens: usage.cache_read_input_tokens,
    cacheCreationTokens: usage.cache_creation_input_tokens,
    attempt,
    modelOutput,
    thinkingOutput,
    hasToolCall,
    ttftMs: ttftMs ?? undefined,
    requestSetupMs,
    attemptStartTimes,
  })

  // Log first successful message for teleported sessions (reliability tracking)
  // 传送会话可靠性追踪：仅记录首条消息的成功
  const teleportInfo = getTeleportedSessionInfo()
  if (teleportInfo?.isTeleported && !teleportInfo.hasLoggedFirstMessage) {
    logEvent('tengu_teleport_first_message_success', {
      session_id:
        teleportInfo.sessionId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    markFirstTeleportMessageLogged() // 标记首条消息已记录，避免重复
  }
}
