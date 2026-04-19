/**
 * API 调用重试逻辑模块（withRetry）
 *
 * 在 Claude Code 系统流程中的位置：
 *   每次向 Anthropic API 发起请求 → withRetry() 包装实际操作
 *   → 自动处理 401/403 令牌刷新、429/529 限速重试、Bedrock/Vertex 认证错误等
 *   → 各种快速失败/降级/持久重试策略
 *
 * 主要功能：
 *  - withRetry()                    — 核心异步生成器：带完整重试逻辑的 API 调用包装器
 *  - getRetryDelay()                — 计算指数退避延迟（含抖动），支持 Retry-After 响应头
 *  - parseMaxTokensContextOverflowError() — 解析 max_tokens 上下文溢出错误，提取 token 数量
 *  - is529Error()                   — 判断是否为服务过载（529）错误
 *  - shouldRetry()                  — 判断特定错误是否应重试
 *  - getDefaultMaxRetries()         — 读取最大重试次数（支持环境变量覆盖）
 *
 * 重试策略层次：
 *  1. Fast Mode 429/529 处理：
 *     - 超额用量被禁用（overage disabled）→ 永久禁用 Fast Mode
 *     - Retry-After < 20s → 保持 Fast Mode 等待重试（保留 prompt cache）
 *     - Retry-After >= 20s 或未知 → 进入 cooldown（切换到标准速度）
 *  2. Fast Mode 参数被 API 拒绝（400）→ 永久禁用 Fast Mode 重试
 *  3. 非前台请求的 529 → 立即放弃（不产生重试放大效应）
 *  4. 连续 529 超过 MAX_529_RETRIES → 触发 fallback 模型切换
 *  5. 持久重试模式（CLAUDE_CODE_UNATTENDED_RETRY）→ 无上限重试，分块 keep-alive yield
 *  6. 上下文溢出（max_tokens 400）→ 自动减少 max_tokens 重试
 *  7. 其他可重试错误 → 指数退避
 *
 * 错误类：
 *  - CannotRetryError    — 重试耗尽或不可重试时抛出，携带原始错误和重试上下文
 *  - FallbackTriggeredError — 触发 fallback 模型切换时抛出，携带原始/目标模型名
 */

import { feature } from 'bun:bundle'
import type Anthropic from '@anthropic-ai/sdk'
import {
  APIConnectionError,
  APIError,
  APIUserAbortError,
} from '@anthropic-ai/sdk'
import type { QuerySource } from 'src/constants/querySource.js'
import type { SystemAPIErrorMessage } from 'src/types/message.js'
import { isAwsCredentialsProviderError } from 'src/utils/aws.js'
import { logForDebugging } from 'src/utils/debug.js'
import { logError } from 'src/utils/log.js'
import { createSystemAPIErrorMessage } from 'src/utils/messages.js'
import { getAPIProviderForStatsig } from 'src/utils/model/providers.js'
import {
  clearApiKeyHelperCache,
  clearAwsCredentialsCache,
  clearGcpCredentialsCache,
  getClaudeAIOAuthTokens,
  handleOAuth401Error,
  isClaudeAISubscriber,
  isEnterpriseSubscriber,
} from '../../utils/auth.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { errorMessage } from '../../utils/errors.js'
import {
  type CooldownReason,
  handleFastModeOverageRejection,
  handleFastModeRejectedByAPI,
  isFastModeCooldown,
  isFastModeEnabled,
  triggerFastModeCooldown,
} from '../../utils/fastMode.js'
import { isNonCustomOpusModel } from '../../utils/model/model.js'
import { disableKeepAlive } from '../../utils/proxy.js'
import { sleep } from '../../utils/sleep.js'
import type { ThinkingConfig } from '../../utils/thinking.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../analytics/growthbook.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../analytics/index.js'
import {
  checkMockRateLimitError,
  isMockRateLimitError,
} from '../rateLimitMocking.js'
import { REPEATED_529_ERROR_MESSAGE } from './errors.js'
import { extractConnectionErrorDetails } from './errorUtils.js'

/** 创建用户中止错误（便于在重试循环中统一处理信号中止） */
const abortError = () => new APIUserAbortError()

// 默认最大重试次数（可通过 CLAUDE_CODE_MAX_RETRIES 环境变量覆盖）
const DEFAULT_MAX_RETRIES = 10
// 上下文溢出自动调整时的最小输出 token 下限
const FLOOR_OUTPUT_TOKENS = 3000
// 触发 fallback 模型切换前允许的最大连续 529 次数
const MAX_529_RETRIES = 3
// 基础重试延迟，实际延迟 = min(BASE_DELAY_MS * 2^(attempt-1), maxDelayMs) + 抖动
export const BASE_DELAY_MS = 500

// 前台 querySource 集合：用户正在等待结果的请求来源，需要在 529 时重试。
// 其他来源（摘要、标题、建议等）在 529 时立即放弃：
// 每次重试会产生 3-10x 的网关放大效应，而用户并不会看到这些请求失败。
// 新增来源默认不重试——只有用户正在等待时才加入此集合。
const FOREGROUND_529_RETRY_SOURCES = new Set<QuerySource>([
  'repl_main_thread',
  'repl_main_thread:outputStyle:custom',
  'repl_main_thread:outputStyle:Explanatory',
  'repl_main_thread:outputStyle:Learning',
  'sdk',
  'agent:custom',
  'agent:default',
  'agent:builtin',
  'compact',
  'hook_agent',
  'hook_prompt',
  'verification_agent',
  'side_question',
  // 安全分类器——必须完成以确保 auto-mode 的正确性。
  // yoloClassifier.ts 使用 'auto_mode'（非 'yolo_classifier'，后者仅为类型）。
  // bash_classifier 仅用于 ant 构建；通过 feature gate 控制，避免出现在外部构建的字符串中。
  'auto_mode',
  ...(feature('BASH_CLASSIFIER') ? (['bash_classifier'] as const) : []),
])

/** 判断指定 querySource 的 529 错误是否应重试（undefined 时保守地默认重试） */
function shouldRetry529(querySource: QuerySource | undefined): boolean {
  return (
    querySource === undefined || FOREGROUND_529_RETRY_SOURCES.has(querySource)
  )
}

// 持久重试模式（CLAUDE_CODE_UNATTENDED_RETRY）：用于无人值守会话（仅限 ant 内部使用）。
// 以更高的退避延迟无限重试 429/529，并定期通过 yield 发出 keep-alive，
// 防止宿主环境因无活动而标记会话为空闲。
const PERSISTENT_MAX_BACKOFF_MS = 5 * 60 * 1000   // 持久重试最大退避：5 分钟
const PERSISTENT_RESET_CAP_MS = 6 * 60 * 60 * 1000 // 持久重试总等待上限：6 小时
const HEARTBEAT_INTERVAL_MS = 30_000               // keep-alive yield 间隔：30 秒

/** 判断是否启用持久重试模式（需要 UNATTENDED_RETRY feature gate + 环境变量） */
function isPersistentRetryEnabled(): boolean {
  return feature('UNATTENDED_RETRY')
    ? isEnvTruthy(process.env.CLAUDE_CODE_UNATTENDED_RETRY)
    : false
}

/** 判断是否为瞬时容量错误（529 或 429） */
function isTransientCapacityError(error: unknown): boolean {
  return (
    is529Error(error) || (error instanceof APIError && error.status === 429)
  )
}

/** 判断是否为过期连接错误（ECONNRESET 或 EPIPE）——需要重建客户端连接 */
function isStaleConnectionError(error: unknown): boolean {
  if (!(error instanceof APIConnectionError)) {
    return false
  }
  const details = extractConnectionErrorDetails(error)
  return details?.code === 'ECONNRESET' || details?.code === 'EPIPE'
}

/** 传递给 operation 回调的重试上下文：影响下一次请求参数的可变状态 */
export interface RetryContext {
  maxTokensOverride?: number   // 上下文溢出时的 max_tokens 覆盖值
  model: string                // 当前使用的模型名（可能因 fallback 而变化）
  thinkingConfig: ThinkingConfig
  fastMode?: boolean           // 当前是否使用 Fast Mode（可能在重试中被禁用）
}

/** withRetry 的配置选项 */
interface RetryOptions {
  maxRetries?: number
  model: string
  fallbackModel?: string     // 连续 529 超限时切换的备用模型
  thinkingConfig: ThinkingConfig
  fastMode?: boolean
  signal?: AbortSignal
  querySource?: QuerySource
  /**
   * 预设的连续 529 错误计数。
   * 用于流式 529 后的非流式 fallback：流式的 529 应计入 MAX_529_RETRIES，
   * 确保无论哪种请求模式触发过载，fallback 前的 529 总数保持一致。
   */
  initialConsecutive529Errors?: number
}

/**
 * 重试耗尽或遇到不可重试错误时抛出。
 * 携带原始错误和重试上下文，方便上层处理。
 */
export class CannotRetryError extends Error {
  constructor(
    public readonly originalError: unknown,
    public readonly retryContext: RetryContext,
  ) {
    const message = errorMessage(originalError)
    super(message)
    this.name = 'RetryError'

    // 保留原始堆栈信息（如果有）
    if (originalError instanceof Error && originalError.stack) {
      this.stack = originalError.stack
    }
  }
}

/**
 * 触发 fallback 模型切换时抛出。
 * 上层捕获此错误后以 fallbackModel 重新发起请求。
 */
export class FallbackTriggeredError extends Error {
  constructor(
    public readonly originalModel: string,
    public readonly fallbackModel: string,
  ) {
    super(`Model fallback triggered: ${originalModel} -> ${fallbackModel}`)
    this.name = 'FallbackTriggeredError'
  }
}

/**
 * 带完整重试逻辑的 API 调用包装器（异步生成器）。
 *
 * 作为异步生成器的原因：在等待重试延迟期间，通过 yield 输出
 * SystemAPIErrorMessage，让调用方（QueryEngine）有机会向用户展示重试状态
 * 或向宿主发送 keep-alive 信号。
 *
 * 重试触发条件（按优先级）：
 *  1. Fast Mode + 429/529：根据 Retry-After 决定是等待重试还是进入 cooldown
 *  2. Fast Mode + 400（参数被拒）：永久禁用 Fast Mode
 *  3. 非前台 529：立即放弃（不产生重试放大）
 *  4. 连续 529 >= MAX_529_RETRIES：触发 FallbackTriggeredError
 *  5. 持久重试模式下的 429/529：无限重试直到恢复
 *  6. max_tokens 上下文溢出：自动减少 max_tokens 重试
 *  7. shouldRetry() 返回 true 的其他错误：指数退避重试
 *
 * @param getClient  — 获取（或刷新）Anthropic 客户端实例的工厂函数
 * @param operation  — 实际 API 操作，接收客户端、尝试次数、重试上下文
 * @param options    — 重试配置（maxRetries、model、signal 等）
 * @yields SystemAPIErrorMessage — 在等待重试延迟期间产生的中间消息
 * @returns 操作成功时的返回值
 * @throws CannotRetryError — 重试耗尽或不可重试时
 * @throws FallbackTriggeredError — 需要切换 fallback 模型时
 */
export async function* withRetry<T>(
  getClient: () => Promise<Anthropic>,
  operation: (
    client: Anthropic,
    attempt: number,
    context: RetryContext,
  ) => Promise<T>,
  options: RetryOptions,
): AsyncGenerator<SystemAPIErrorMessage, T> {
  const maxRetries = getMaxRetries(options)
  const retryContext: RetryContext = {
    model: options.model,
    thinkingConfig: options.thinkingConfig,
    ...(isFastModeEnabled() && { fastMode: options.fastMode }),
  }
  let client: Anthropic | null = null
  let consecutive529Errors = options.initialConsecutive529Errors ?? 0
  let lastError: unknown
  let persistentAttempt = 0 // 持久模式专用计数器（for 循环的 attempt 被钳制在 maxRetries）
  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    if (options.signal?.aborted) {
      throw new APIUserAbortError()
    }

    // 在本次尝试前捕获 Fast Mode 状态（fallback 可能在循环中改变状态）
    const wasFastModeActive = isFastModeEnabled()
      ? retryContext.fastMode && !isFastModeCooldown()
      : false

    try {
      // Ant 员工专用：检查 /mock-limits 命令设置的模拟限速错误
      if (process.env.USER_TYPE === 'ant') {
        const mockError = checkMockRateLimitError(
          retryContext.model,
          wasFastModeActive,
        )
        if (mockError) {
          throw mockError
        }
      }

      // 以下情况需要重新获取客户端实例（刷新认证）：
      //  - 首次调用（client 为 null）
      //  - 401：第一方 API 认证失败（令牌过期）
      //  - 403 "OAuth token has been revoked"：另一进程已刷新令牌
      //  - Bedrock 认证错误（403 或 CredentialsProviderError）
      //  - Vertex 认证错误（凭证刷新失败或 401）
      //  - ECONNRESET/EPIPE：过期的 keep-alive 连接，需要禁用连接池并重连
      const isStaleConnection = isStaleConnectionError(lastError)
      if (
        isStaleConnection &&
        getFeatureValue_CACHED_MAY_BE_STALE(
          'tengu_disable_keepalive_on_econnreset',
          false,
        )
      ) {
        logForDebugging(
          'Stale connection (ECONNRESET/EPIPE) — disabling keep-alive for retry',
        )
        disableKeepAlive() // 禁用 HTTP keep-alive，强制重建连接
      }

      if (
        client === null ||
        (lastError instanceof APIError && lastError.status === 401) ||
        isOAuthTokenRevokedError(lastError) ||
        isBedrockAuthError(lastError) ||
        isVertexAuthError(lastError) ||
        isStaleConnection
      ) {
        // 401 令牌过期或 403 令牌吊销时，强制刷新 OAuth 令牌
        if (
          (lastError instanceof APIError && lastError.status === 401) ||
          isOAuthTokenRevokedError(lastError)
        ) {
          const failedAccessToken = getClaudeAIOAuthTokens()?.accessToken
          if (failedAccessToken) {
            await handleOAuth401Error(failedAccessToken)
          }
        }
        client = await getClient() // 重新获取（可能已刷新令牌的）客户端
      }

      return await operation(client, attempt, retryContext)
    } catch (error) {
      lastError = error
      logForDebugging(
        `API error (attempt ${attempt}/${maxRetries + 1}): ${error instanceof APIError ? `${error.status} ${error.message}` : errorMessage(error)}`,
        { level: 'error' },
      )

      // Fast Mode 处理：429/529 时根据 Retry-After 决定策略
      // 持久重试模式下跳过此逻辑，持久模式有自己的 keep-alive 路径
      if (
        wasFastModeActive &&
        !isPersistentRetryEnabled() &&
        error instanceof APIError &&
        (error.status === 429 || is529Error(error))
      ) {
        // 若 429 是因为超额用量（overage）不可用，永久禁用 Fast Mode
        const overageReason = error.headers?.get(
          'anthropic-ratelimit-unified-overage-disabled-reason',
        )
        if (overageReason !== null && overageReason !== undefined) {
          handleFastModeOverageRejection(overageReason)
          retryContext.fastMode = false
          continue
        }

        const retryAfterMs = getRetryAfterMs(error)
        if (retryAfterMs !== null && retryAfterMs < SHORT_RETRY_THRESHOLD_MS) {
          // Retry-After < 20s：等待后保持 Fast Mode 重试（保留 prompt cache，使用相同模型名）
          await sleep(retryAfterMs, options.signal, { abortError })
          continue
        }
        // Retry-After >= 20s 或未知：进入 cooldown（切换到标准速度模型），
        // 设置最小 cooldown 时间避免快速来回切换
        const cooldownMs = Math.max(
          retryAfterMs ?? DEFAULT_FAST_MODE_FALLBACK_HOLD_MS,
          MIN_COOLDOWN_MS,
        )
        const cooldownReason: CooldownReason = is529Error(error)
          ? 'overloaded'
          : 'rate_limit'
        triggerFastModeCooldown(Date.now() + cooldownMs, cooldownReason)
        if (isFastModeEnabled()) {
          retryContext.fastMode = false
        }
        continue
      }

      // Fast Mode 参数被 API 拒绝（400 "Fast mode is not enabled"）：
      // 永久禁用 Fast Mode 并以标准速度重试
      if (wasFastModeActive && isFastModeNotEnabledError(error)) {
        handleFastModeRejectedByAPI()
        retryContext.fastMode = false
        continue
      }

      // 非前台来源的 529：立即放弃，不产生重试放大
      // 容量级联时每次重试会造成 3-10x 的网关压力，而这些请求失败用户不会感知
      if (is529Error(error) && !shouldRetry529(options.querySource)) {
        logEvent('tengu_api_529_background_dropped', {
          query_source:
            options.querySource as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        })
        throw new CannotRetryError(error, retryContext)
      }

      // 追踪连续 529 次数，超限时触发 fallback 模型切换
      if (
        is529Error(error) &&
        // FALLBACK_FOR_ALL_PRIMARY_MODELS 未设置时，仅对非自定义 Opus 模型触发 fallback
        (process.env.FALLBACK_FOR_ALL_PRIMARY_MODELS ||
          (!isClaudeAISubscriber() && isNonCustomOpusModel(options.model)))
      ) {
        consecutive529Errors++
        if (consecutive529Errors >= MAX_529_RETRIES) {
          if (options.fallbackModel) {
            // 有 fallback 模型：上报事件并抛出 FallbackTriggeredError
            logEvent('tengu_api_opus_fallback_triggered', {
              original_model:
                options.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              fallback_model:
                options.fallbackModel as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              provider: getAPIProviderForStatsig(),
            })
            throw new FallbackTriggeredError(
              options.model,
              options.fallbackModel,
            )
          }

          // 外部用户、非沙盒、非持久重试模式：向用户展示过载错误
          if (
            process.env.USER_TYPE === 'external' &&
            !process.env.IS_SANDBOX &&
            !isPersistentRetryEnabled()
          ) {
            logEvent('tengu_api_custom_529_overloaded_error', {})
            throw new CannotRetryError(
              new Error(REPEATED_529_ERROR_MESSAGE),
              retryContext,
            )
          }
        }
      }

      // 判断是否还有剩余重试次数（持久模式下无限重试）
      const persistent =
        isPersistentRetryEnabled() && isTransientCapacityError(error)
      if (attempt > maxRetries && !persistent) {
        throw new CannotRetryError(error, retryContext)
      }

      // 处理云平台认证错误（AWS/GCP），清除凭证缓存并标记为可重试
      const handledCloudAuthError =
        handleAwsCredentialError(error) || handleGcpCredentialError(error)
      if (
        !handledCloudAuthError &&
        (!(error instanceof APIError) || !shouldRetry(error))
      ) {
        throw new CannotRetryError(error, retryContext)
      }

      // 处理 max_tokens 上下文溢出错误（400 "input length and `max_tokens` exceed context limit"）：
      // 注意：启用 extended-context-window beta 后，API 改为返回 model_context_window_exceeded stop_reason。
      // 此处保留为向后兼容。
      if (error instanceof APIError) {
        const overflowData = parseMaxTokensContextOverflowError(error)
        if (overflowData) {
          const { inputTokens, contextLimit } = overflowData

          const safetyBuffer = 1000
          const availableContext = Math.max(
            0,
            contextLimit - inputTokens - safetyBuffer,
          )
          if (availableContext < FLOOR_OUTPUT_TOKENS) {
            logError(
              new Error(
                `availableContext ${availableContext} is less than FLOOR_OUTPUT_TOKENS ${FLOOR_OUTPUT_TOKENS}`,
              ),
            )
            throw error // 可用上下文过小，无法安全调整，直接抛出
          }
          // 确保调整后的 max_tokens 足够容纳 thinking budget + 至少 1 个输出 token
          const minRequired =
            (retryContext.thinkingConfig.type === 'enabled'
              ? retryContext.thinkingConfig.budgetTokens
              : 0) + 1
          const adjustedMaxTokens = Math.max(
            FLOOR_OUTPUT_TOKENS,
            availableContext,
            minRequired,
          )
          retryContext.maxTokensOverride = adjustedMaxTokens

          logEvent('tengu_max_tokens_context_overflow_adjustment', {
            inputTokens,
            contextLimit,
            adjustedMaxTokens,
            attempt,
          })

          continue // 以调整后的 maxTokensOverride 重试
        }
      }

      // 计算本次重试的等待延迟
      const retryAfter = getRetryAfter(error)
      let delayMs: number
      if (persistent && error instanceof APIError && error.status === 429) {
        persistentAttempt++
        // 窗口型限速（如 5h Max/Pro）响应头包含重置时间戳：等到重置而非每 5 分钟轮询一次
        const resetDelay = getRateLimitResetDelayMs(error)
        delayMs =
          resetDelay ??
          Math.min(
            getRetryDelay(
              persistentAttempt,
              retryAfter,
              PERSISTENT_MAX_BACKOFF_MS,
            ),
            PERSISTENT_RESET_CAP_MS,
          )
      } else if (persistent) {
        persistentAttempt++
        // Retry-After 响应头指令绕过 getRetryDelay 内部的 maxDelayMs 上限（遵守服务端指令是正确行为）
        // 但在此处用 PERSISTENT_RESET_CAP_MS 兜底，防止异常的响应头导致无限等待
        delayMs = Math.min(
          getRetryDelay(
            persistentAttempt,
            retryAfter,
            PERSISTENT_MAX_BACKOFF_MS,
          ),
          PERSISTENT_RESET_CAP_MS,
        )
      } else {
        delayMs = getRetryDelay(attempt, retryAfter)
      }

      // 持久模式下使用 persistentAttempt 上报，确保遥测显示真实次数
      const reportedAttempt = persistent ? persistentAttempt : attempt
      logEvent('tengu_api_retry', {
        attempt: reportedAttempt,
        delayMs: delayMs,
        error: (error as APIError)
          .message as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        status: (error as APIError).status,
        provider: getAPIProviderForStatsig(),
      })

      if (persistent) {
        if (delayMs > 60_000) {
          // 等待超过 1 分钟时上报遥测（用于监控长时间等待的持久重试情况）
          logEvent('tengu_api_persistent_retry_wait', {
            status: (error as APIError).status,
            delayMs,
            attempt: reportedAttempt,
            provider: getAPIProviderForStatsig(),
          })
        }
        // 将长时间睡眠分块处理，每 HEARTBEAT_INTERVAL_MS (30s) yield 一次，
        // 让宿主环境看到持续的 stdout 活动，不会将会话标记为空闲。
        // 每次 yield 在 QueryEngine 层面对应 {type:'system', subtype:'api_retry'} 输出。
        let remaining = delayMs
        while (remaining > 0) {
          if (options.signal?.aborted) throw new APIUserAbortError()
          if (error instanceof APIError) {
            yield createSystemAPIErrorMessage(
              error,
              remaining,
              reportedAttempt,
              maxRetries,
            )
          }
          const chunk = Math.min(remaining, HEARTBEAT_INTERVAL_MS)
          await sleep(chunk, options.signal, { abortError })
          remaining -= chunk
        }
        // 钳制 attempt，防止 for 循环因 attempt > maxRetries+1 而退出。
        // 退避使用独立的 persistentAttempt 计数器，可增长到 5 分钟上限。
        if (attempt >= maxRetries) attempt = maxRetries
      } else {
        if (error instanceof APIError) {
          yield createSystemAPIErrorMessage(error, delayMs, attempt, maxRetries)
        }
        await sleep(delayMs, options.signal, { abortError })
      }
    }
  }

  throw new CannotRetryError(lastError, retryContext)
}

/** 从错误对象中提取 Retry-After 响应头的值（字符串或 null） */
function getRetryAfter(error: unknown): string | null {
  return (
    ((error as { headers?: { 'retry-after'?: string } }).headers?.[
      'retry-after'
    ] ||
      // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
      ((error as APIError).headers as Headers)?.get?.('retry-after')) ??
    null
  )
}

/**
 * 计算重试等待延迟（毫秒）。
 *
 * 优先使用 Retry-After 响应头（秒转毫秒）；
 * 无响应头时使用指数退避：min(BASE_DELAY_MS * 2^(attempt-1), maxDelayMs) + 随机抖动（0~25%）。
 *
 * @param attempt        — 当前尝试次数（从 1 开始）
 * @param retryAfterHeader — Retry-After 响应头值（秒数字符串）
 * @param maxDelayMs     — 指数退避的最大延迟上限（默认 32000ms）
 */
export function getRetryDelay(
  attempt: number,
  retryAfterHeader?: string | null,
  maxDelayMs = 32000,
): number {
  if (retryAfterHeader) {
    const seconds = parseInt(retryAfterHeader, 10)
    if (!isNaN(seconds)) {
      return seconds * 1000 // 响应头指定秒数，转换为毫秒
    }
  }

  const baseDelay = Math.min(
    BASE_DELAY_MS * Math.pow(2, attempt - 1),
    maxDelayMs,
  )
  const jitter = Math.random() * 0.25 * baseDelay // 添加最多 25% 的随机抖动，避免惊群效应
  return baseDelay + jitter
}

/**
 * 解析 max_tokens 上下文溢出错误，提取输入 token 数、max_tokens 和上下文上限。
 *
 * 错误消息示例："input length and `max_tokens` exceed context limit: 188059 + 20000 > 200000"
 *
 * @returns 解析结果（inputTokens, maxTokens, contextLimit），或 undefined（非此类错误）
 */
export function parseMaxTokensContextOverflowError(error: APIError):
  | {
      inputTokens: number
      maxTokens: number
      contextLimit: number
    }
  | undefined {
  if (error.status !== 400 || !error.message) {
    return undefined
  }

  if (
    !error.message.includes(
      'input length and `max_tokens` exceed context limit',
    )
  ) {
    return undefined
  }

  // 匹配格式：188059 + 20000 > 200000
  const regex =
    /input length and `max_tokens` exceed context limit: (\d+) \+ (\d+) > (\d+)/
  const match = error.message.match(regex)

  if (!match || match.length !== 4) {
    return undefined
  }

  if (!match[1] || !match[2] || !match[3]) {
    logError(
      new Error(
        'Unable to parse max_tokens from max_tokens exceed context limit error message',
      ),
    )
    return undefined
  }
  const inputTokens = parseInt(match[1], 10)
  const maxTokens = parseInt(match[2], 10)
  const contextLimit = parseInt(match[3], 10)

  if (isNaN(inputTokens) || isNaN(maxTokens) || isNaN(contextLimit)) {
    return undefined
  }

  return { inputTokens, maxTokens, contextLimit }
}

// TODO: 等 API 添加专用的 x-fast-mode-rejected 响应头后，改用响应头判断，
// 不再字符串匹配错误消息（消息内容变更会导致此逻辑失效）
/** 判断错误是否为 Fast Mode 参数被 API 拒绝（400 "Fast mode is not enabled"） */
function isFastModeNotEnabledError(error: unknown): boolean {
  if (!(error instanceof APIError)) {
    return false
  }
  return (
    error.status === 400 &&
    (error.message?.includes('Fast mode is not enabled') ?? false)
  )
}

/**
 * 判断错误是否为 529 过载错误。
 *
 * 注意：SDK 在流式请求中有时无法正确传递 529 状态码，
 * 需要额外检查错误消息中是否包含 "overloaded_error" 类型标识。
 */
export function is529Error(error: unknown): boolean {
  if (!(error instanceof APIError)) {
    return false
  }

  return (
    error.status === 529 ||
    // SDK 流式请求中可能未正确传递 529 状态码，通过消息内容兜底判断
    (error.message?.includes('"type":"overloaded_error"') ?? false)
  )
}

/** 判断错误是否为 OAuth 令牌被吊销（403 "OAuth token has been revoked"） */
function isOAuthTokenRevokedError(error: unknown): boolean {
  return (
    error instanceof APIError &&
    error.status === 403 &&
    (error.message?.includes('OAuth token has been revoked') ?? false)
  )
}

/**
 * 判断错误是否为 Bedrock 认证错误。
 *
 * AWS 库在 .aws 配置包含已过期 Expiration 时，在发起 API 调用前就会拒绝（CredentialsProviderError）；
 * 否则，使用过期令牌发起的 API 调用会返回通用的 403 错误。
 */
function isBedrockAuthError(error: unknown): boolean {
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_BEDROCK)) {
    if (
      isAwsCredentialsProviderError(error) ||
      (error instanceof APIError && error.status === 403)
    ) {
      return true
    }
  }
  return false
}

/**
 * 若为 Bedrock 认证错误，清除 AWS 凭证缓存。
 * @returns true 表示已处理
 */
function handleAwsCredentialError(error: unknown): boolean {
  if (isBedrockAuthError(error)) {
    clearAwsCredentialsCache()
    return true
  }
  return false
}

// google-auth-library 抛出普通 Error（不像 AWS 有类型化的 CredentialsProviderError）。
// 通过常见 SDK 凭证失败消息进行匹配。
/** 判断错误是否为 Google Auth Library 凭证错误 */
function isGoogleAuthLibraryCredentialError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const msg = error.message
  return (
    msg.includes('Could not load the default credentials') ||
    msg.includes('Could not refresh access token') ||
    msg.includes('invalid_grant')
  )
}

/**
 * 判断错误是否为 Vertex 认证错误。
 *
 * SDK 层面：google-auth-library 在 prepareOptions() 中失败（HTTP 调用前）→ GoogleAuthLibraryCredentialError
 * 服务端：Vertex 对过期/无效令牌返回 401
 */
function isVertexAuthError(error: unknown): boolean {
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_VERTEX)) {
    if (isGoogleAuthLibraryCredentialError(error)) {
      return true
    }
    if (error instanceof APIError && error.status === 401) {
      return true
    }
  }
  return false
}

/**
 * 若为 Vertex 认证错误，清除 GCP 凭证缓存。
 * @returns true 表示已处理
 */
function handleGcpCredentialError(error: unknown): boolean {
  if (isVertexAuthError(error)) {
    clearGcpCredentialsCache()
    return true
  }
  return false
}

/**
 * 判断指定 API 错误是否应重试。
 *
 * 重试条件（按优先级）：
 *  1. 模拟限速错误（/mock-limits）→ 不重试
 *  2. 持久模式 + 429/529 → 始终重试
 *  3. CCR 模式 + 401/403 → 重试（基础设施 JWT 认证，401/403 是瞬时故障非凭证错误）
 *  4. 消息含 "overloaded_error" → 重试
 *  5. max_tokens 上下文溢出 → 重试
 *  6. x-should-retry:true（非订阅用户或企业用户）→ 重试
 *  7. x-should-retry:false（非 ant 用户 5xx 时）→ 不重试
 *  8. 连接错误 → 重试
 *  9. 408（请求超时）→ 重试
 * 10. 409（锁超时）→ 重试
 * 11. 429（非订阅用户或企业用户）→ 重试
 * 12. 401（清除 API Key 缓存后重试）→ 重试
 * 13. 403 token 吊销 → 重试
 * 14. 5xx → 重试
 */
function shouldRetry(error: APIError): boolean {
  // 模拟限速错误（/mock-limits 命令用于测试）不重试
  if (isMockRateLimitError(error)) {
    return false
  }

  // 持久重试模式：429/529 始终可重试，绕过订阅门控和 x-should-retry 响应头
  if (isPersistentRetryEnabled() && isTransientCapacityError(error)) {
    return true
  }

  // CCR 模式：认证通过基础设施提供的 JWT，401/403 是瞬时故障（认证服务抖动、网络问题），
  // 绕过 x-should-retry:false——服务端假设我们会重试相同的坏 key，但实际上 key 是好的
  if (
    isEnvTruthy(process.env.CLAUDE_CODE_REMOTE) &&
    (error.status === 401 || error.status === 403)
  ) {
    return true
  }

  // 流式请求中 SDK 可能未正确传递 529 状态码，通过消息内容兜底判断
  if (error.message?.includes('"type":"overloaded_error"')) {
    return true
  }

  // 可处理的上下文溢出错误（可通过减少 max_tokens 重试）
  if (parseMaxTokensContextOverflowError(error)) {
    return true
  }

  // 非标准响应头 x-should-retry：服务端明确指定是否重试
  const shouldRetryHeader = error.headers?.get('x-should-retry')

  // 服务端明确说应重试时：Max/Pro 用户可能需要等几小时，不重试；Enterprise 用户按量计费，可重试
  if (
    shouldRetryHeader === 'true' &&
    (!isClaudeAISubscriber() || isEnterpriseSubscriber())
  ) {
    return true
  }

  // 服务端明确说不重试时：ant 用户对 5xx 错误仍可重试，其他状态码遵守响应头
  if (shouldRetryHeader === 'false') {
    const is5xxError = error.status !== undefined && error.status >= 500
    if (!(process.env.USER_TYPE === 'ant' && is5xxError)) {
      return false
    }
  }

  if (error instanceof APIConnectionError) {
    return true // 连接错误始终重试
  }

  if (!error.status) return false

  if (error.status === 408) return true // 请求超时，重试
  if (error.status === 409) return true // 锁超时，重试

  // 限速（429）：非订阅用户或企业用户可重试（订阅用户需等到窗口重置）
  if (error.status === 429) {
    return !isClaudeAISubscriber() || isEnterpriseSubscriber()
  }

  // 401：清除 API Key 缓存后重试（OAuth 令牌刷新逻辑在主循环中处理）
  if (error.status === 401) {
    clearApiKeyHelperCache()
    return true
  }

  // 403 令牌吊销（令牌刷新逻辑同 401）
  if (isOAuthTokenRevokedError(error)) {
    return true
  }

  // 5xx 服务端内部错误，重试
  if (error.status && error.status >= 500) return true

  return false
}

/**
 * 获取默认最大重试次数。
 * 支持通过 CLAUDE_CODE_MAX_RETRIES 环境变量覆盖默认值（DEFAULT_MAX_RETRIES = 10）。
 */
export function getDefaultMaxRetries(): number {
  if (process.env.CLAUDE_CODE_MAX_RETRIES) {
    return parseInt(process.env.CLAUDE_CODE_MAX_RETRIES, 10)
  }
  return DEFAULT_MAX_RETRIES
}

/** 从 options 读取 maxRetries，默认使用 getDefaultMaxRetries() */
function getMaxRetries(options: RetryOptions): number {
  return options.maxRetries ?? getDefaultMaxRetries()
}

// Fast Mode 降级相关常量
const DEFAULT_FAST_MODE_FALLBACK_HOLD_MS = 30 * 60 * 1000 // 未知 Retry-After 时的默认 cooldown 时长：30 分钟
const SHORT_RETRY_THRESHOLD_MS = 20 * 1000                // Retry-After 低于此值时等待重试（保留 Fast Mode）：20 秒
const MIN_COOLDOWN_MS = 10 * 60 * 1000                    // cooldown 最小时长（防止快速来回切换）：10 分钟

/** 从错误对象的 Retry-After 响应头提取等待毫秒数（不存在或无效时返回 null） */
function getRetryAfterMs(error: APIError): number | null {
  const retryAfter = getRetryAfter(error)
  if (retryAfter) {
    const seconds = parseInt(retryAfter, 10)
    if (!isNaN(seconds)) {
      return seconds * 1000
    }
  }
  return null
}

/**
 * 从 429 响应头中提取限速重置时间点，并计算距当前时刻的等待毫秒数。
 *
 * anthropic-ratelimit-unified-reset 响应头包含 Unix 时间戳（秒），
 * 等到该时刻重置比按固定间隔轮询更高效。
 *
 * @returns 等待毫秒数（不存在、无效或已过期时返回 null）
 */
function getRateLimitResetDelayMs(error: APIError): number | null {
  const resetHeader = error.headers?.get?.('anthropic-ratelimit-unified-reset')
  if (!resetHeader) return null
  const resetUnixSec = Number(resetHeader)
  if (!Number.isFinite(resetUnixSec)) return null
  const delayMs = resetUnixSec * 1000 - Date.now()
  if (delayMs <= 0) return null // 重置时间已过，无需等待
  return Math.min(delayMs, PERSISTENT_RESET_CAP_MS) // 上限 6 小时，防止异常头导致无限等待
}
