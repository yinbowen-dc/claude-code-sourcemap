/**
 * 【API 错误类型与错误消息处理模块】api/errors.ts
 *
 * 在 Claude Code 系统流程中的位置：
 * - 属于 API 服务层的错误处理中心，被 api/claude.ts 的主循环广泛引用
 * - 提供从原始 SDK 错误到用户友好消息的转换层
 * - getAssistantMessageFromError() 是核心函数，将所有类型的错误转换为可显示的助手消息
 * - classifyAPIError() 决定错误后的行为（重试、退出、上报等）
 *
 * 核心功能：
 * - 错误消息常量：各类 API 错误的标准用户消息字符串
 * - isPromptTooLongMessage/parsePromptTooLongTokenCounts/getPromptTooLongTokenGap：Prompt 过长错误处理
 * - isMediaSizeError/isMediaSizeErrorMessage：媒体大小错误检测（图片/PDF）
 * - getAssistantMessageFromError(): 将各种错误（超时、图片、API、认证）转换为 AssistantMessage
 * - classifyAPIError(): 将 API 错误分类为 'prompt_too_long'/'overloaded'/'auth'/'rate_limit'/'other' 等
 * - getErrorMessageIfRefusal(): 检测 Claude 的自我审查拒绝，返回空字符串表示拒绝（用于触发重试）
 */

import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
} from '@anthropic-ai/sdk'
import type {
  BetaMessage,
  BetaStopReason,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import { AFK_MODE_BETA_HEADER } from 'src/constants/betas.js'
import type { SDKAssistantMessageError } from 'src/entrypoints/agentSdkTypes.js'
import type {
  AssistantMessage,
  Message,
  UserMessage,
} from 'src/types/message.js'
import {
  getAnthropicApiKeyWithSource,
  getClaudeAIOAuthTokens,
  getOauthAccountInfo,
  isClaudeAISubscriber,
} from 'src/utils/auth.js'
import {
  createAssistantAPIErrorMessage,
  NO_RESPONSE_REQUESTED,
} from 'src/utils/messages.js'
import {
  getDefaultMainLoopModelSetting,
  isNonCustomOpusModel,
} from 'src/utils/model/model.js'
import { getModelStrings } from 'src/utils/model/modelStrings.js'
import { getAPIProvider } from 'src/utils/model/providers.js'
import { getIsNonInteractiveSession } from '../../bootstrap/state.js'
import {
  API_PDF_MAX_PAGES,
  PDF_TARGET_RAW_SIZE,
} from '../../constants/apiLimits.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { formatFileSize } from '../../utils/format.js'
import { ImageResizeError } from '../../utils/imageResizer.js'
import { ImageSizeError } from '../../utils/imageValidation.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../analytics/index.js'
import {
  type ClaudeAILimits,
  getRateLimitErrorMessage,
  type OverageDisabledReason,
} from '../claudeAiLimits.js'
import { shouldProcessRateLimits } from '../rateLimitMocking.js' // Used for /mock-limits command
import { extractConnectionErrorDetails, formatAPIError } from './errorUtils.js'

/** API 错误消息的固定前缀，用于 startsWithApiErrorPrefix() 识别 API 错误类型的消息 */
export const API_ERROR_MESSAGE_PREFIX = 'API Error'

/**
 * 检查文本是否以 API 错误前缀开头
 *
 * 兼容两种格式：
 * - "API Error ..."（标准 API 错误）
 * - "Please run /login · API Error ..."（未登录时的 API 错误）
 */
export function startsWithApiErrorPrefix(text: string): boolean {
  return (
    text.startsWith(API_ERROR_MESSAGE_PREFIX) ||
    text.startsWith(`Please run /login · ${API_ERROR_MESSAGE_PREFIX}`)
  )
}

/** Prompt 过长错误的用户提示消息前缀 */
export const PROMPT_TOO_LONG_ERROR_MESSAGE = 'Prompt is too long'

/**
 * 检查 AssistantMessage 是否为 "Prompt is too long" 错误消息
 *
 * 通过检查 isApiErrorMessage 标志和内容块中是否包含 PROMPT_TOO_LONG_ERROR_MESSAGE 前缀来判断
 */
export function isPromptTooLongMessage(msg: AssistantMessage): boolean {
  if (!msg.isApiErrorMessage) {
    return false
  }
  const content = msg.message.content
  if (!Array.isArray(content)) {
    return false
  }
  return content.some(
    block =>
      block.type === 'text' &&
      block.text.startsWith(PROMPT_TOO_LONG_ERROR_MESSAGE),
  )
}

/**
 * 从原始 API 错误消息中解析实际 token 数和上限 token 数
 *
 * 原始错误格式举例："prompt is too long: 137500 tokens > 135000 maximum"
 * 为容错设计，支持 SDK 前缀包装、JSON 嵌套，以及 Vertex 的大小写变体。
 *
 * 供 reactive compact（反应式压缩）用于计算单次可以跳过多少对话组，
 * 避免每次只剥一组的低效行为。
 *
 * Parse actual/limit token counts from a raw prompt-too-long API error
 * message like "prompt is too long: 137500 tokens > 135000 maximum".
 * The raw string may be wrapped in SDK prefixes or JSON envelopes, or
 * have different casing (Vertex), so this is intentionally lenient.
 */
export function parsePromptTooLongTokenCounts(rawMessage: string): {
  actualTokens: number | undefined
  limitTokens: number | undefined
} {
  const match = rawMessage.match(
    /prompt is too long[^0-9]*(\d+)\s*tokens?\s*>\s*(\d+)/i,
  )
  return {
    actualTokens: match ? parseInt(match[1]!, 10) : undefined,
    limitTokens: match ? parseInt(match[2]!, 10) : undefined,
  }
}

/**
 * 返回 prompt-too-long 错误中超出上限的 token 数量（gap）
 *
 * 用于 reactive compact：通过 gap 值计算需要一次性压缩多少对话组，
 * 而非每次只剥一组（提升效率）。
 *
 * Returns how many tokens over the limit a prompt-too-long error reports,
 * or undefined if the message isn't PTL or its errorDetails are unparseable.
 * Reactive compact uses this gap to jump past multiple groups in one retry
 * instead of peeling one-at-a-time.
 */
export function getPromptTooLongTokenGap(
  msg: AssistantMessage,
): number | undefined {
  if (!isPromptTooLongMessage(msg) || !msg.errorDetails) {
    return undefined
  }
  const { actualTokens, limitTokens } = parsePromptTooLongTokenCounts(
    msg.errorDetails,
  )
  if (actualTokens === undefined || limitTokens === undefined) {
    return undefined
  }
  const gap = actualTokens - limitTokens
  return gap > 0 ? gap : undefined
}

/**
 * 检查原始 API 错误文本是否为 stripImagesFromMessages() 可修复的媒体大小拒绝错误
 *
 * Reactive compact 的 summarize retry 使用此函数决定是剥离媒体并重试（媒体错误）
 * 还是直接放弃（其他错误）。
 *
 * 匹配模式必须与 getAssistantMessageFromError 中设置 errorDetails 的分支保持同步：
 * - ~L523 PDF 大小错误
 * - ~L560 图片大小错误
 * - ~L573 多图片数量错误
 * API 措辞变化时优雅降级（errorDetails 保持 undefined，调用方短路），不会产生漏检。
 *
 * Is this raw API error text a media-size rejection that stripImagesFromMessages
 * can fix? Reactive compact's summarize retry uses this to decide whether to
 * strip and retry (media error) or bail (anything else).
 */
export function isMediaSizeError(raw: string): boolean {
  return (
    (raw.includes('image exceeds') && raw.includes('maximum')) ||
    (raw.includes('image dimensions exceed') && raw.includes('many-image')) ||
    /maximum of \d+ PDF pages/.test(raw)
  )
}

/**
 * 消息级别的媒体大小错误检测
 *
 * 与 isPromptTooLongMessage 的结构并行，检查 errorDetails（由 getAssistantMessageFromError 填充的原始错误字符串）
 * 而非检查 content 文本（各媒体错误变体的内容字符串各不相同）
 *
 * Message-level predicate: is this assistant message a media-size rejection?
 * Parallel to isPromptTooLongMessage. Checks errorDetails (the raw API error
 * string populated by the getAssistantMessageFromError branches at ~L523/560/573)
 * rather than content text, since media errors have per-variant content strings.
 */
export function isMediaSizeErrorMessage(msg: AssistantMessage): boolean {
  return (
    msg.isApiErrorMessage === true &&
    msg.errorDetails !== undefined &&
    isMediaSizeError(msg.errorDetails)
  )
}

/** 余额不足错误消息 */
export const CREDIT_BALANCE_TOO_LOW_ERROR_MESSAGE = 'Credit balance is too low'
/** OAuth 用户未登录时的错误消息 */
export const INVALID_API_KEY_ERROR_MESSAGE = 'Not logged in · Please run /login'
/** 外部 API Key 无效时的错误消息 */
export const INVALID_API_KEY_ERROR_MESSAGE_EXTERNAL =
  'Invalid API key · Fix external API key'
/** 环境变量中的 API Key 所属组织已禁用（有 OAuth）时的错误消息 */
export const ORG_DISABLED_ERROR_MESSAGE_ENV_KEY_WITH_OAUTH =
  'Your ANTHROPIC_API_KEY belongs to a disabled organization · Unset the environment variable to use your subscription instead'
/** 环境变量中的 API Key 所属组织已禁用（无 OAuth）时的错误消息 */
export const ORG_DISABLED_ERROR_MESSAGE_ENV_KEY =
  'Your ANTHROPIC_API_KEY belongs to a disabled organization · Update or unset the environment variable'
/** OAuth token 被撤销时的错误消息 */
export const TOKEN_REVOKED_ERROR_MESSAGE =
  'OAuth token revoked · Please run /login'
/** CCR 模式下认证错误消息（建议重试而非重新登录） */
export const CCR_AUTH_ERROR_MESSAGE =
  'Authentication error · This may be a temporary network issue, please try again'
/** 重复 529 过载错误消息 */
export const REPEATED_529_ERROR_MESSAGE = 'Repeated 529 Overloaded errors'
/** Opus 过载时的自定义降级提示（引导用户切换到 Sonnet） */
export const CUSTOM_OFF_SWITCH_MESSAGE =
  'Opus is experiencing high load, please use /model to switch to Sonnet'
/** API 超时错误消息 */
export const API_TIMEOUT_ERROR_MESSAGE = 'Request timed out'

/**
 * 返回 PDF 过大错误消息（根据交互/非交互模式返回不同内容）
 *
 * 交互模式：提示用户按 Esc 返回并建议 pdftotext
 * 非交互模式（SDK/headless）：提示使用 CLI 工具处理
 */
export function getPdfTooLargeErrorMessage(): string {
  const limits = `max ${API_PDF_MAX_PAGES} pages, ${formatFileSize(PDF_TARGET_RAW_SIZE)}`
  return getIsNonInteractiveSession()
    ? `PDF too large (${limits}). Try reading the file a different way (e.g., extract text with pdftotext).`
    : `PDF too large (${limits}). Double press esc to go back and try again, or use pdftotext to convert to text first.`
}

/** 返回 PDF 密码保护错误消息（根据交互/非交互模式） */
export function getPdfPasswordProtectedErrorMessage(): string {
  return getIsNonInteractiveSession()
    ? 'PDF is password protected. Try using a CLI tool to extract or convert the PDF.'
    : 'PDF is password protected. Please double press esc to edit your message and try again.'
}

/** 返回 PDF 无效错误消息（根据交互/非交互模式） */
export function getPdfInvalidErrorMessage(): string {
  return getIsNonInteractiveSession()
    ? 'The PDF file was not valid. Try converting it to text first (e.g., pdftotext).'
    : 'The PDF file was not valid. Double press esc to go back and try again with a different file.'
}

/** 返回图片过大错误消息（根据交互/非交互模式） */
export function getImageTooLargeErrorMessage(): string {
  return getIsNonInteractiveSession()
    ? 'Image was too large. Try resizing the image or using a different approach.'
    : 'Image was too large. Double press esc to go back and try again with a smaller image.'
}

/** 返回请求过大错误消息（根据交互/非交互模式） */
export function getRequestTooLargeErrorMessage(): string {
  const limits = `max ${formatFileSize(PDF_TARGET_RAW_SIZE)}`
  return getIsNonInteractiveSession()
    ? `Request too large (${limits}). Try with a smaller file.`
    : `Request too large (${limits}). Double press esc to go back and try with a smaller file.`
}

/** OAuth 账号无权访问 Claude Code 时的错误消息 */
export const OAUTH_ORG_NOT_ALLOWED_ERROR_MESSAGE =
  'Your account does not have access to Claude Code. Please run /login.'

/**
 * 返回 OAuth token 被撤销时的错误消息（根据交互/非交互模式）
 *
 * 非交互模式（SDK/CI）：给出更详细的指引（联系管理员）
 * 交互模式：提示运行 /login
 */
export function getTokenRevokedErrorMessage(): string {
  return getIsNonInteractiveSession()
    ? 'Your account does not have access to Claude. Please login again or contact your administrator.'
    : TOKEN_REVOKED_ERROR_MESSAGE
}

/** 返回 OAuth 组织无权访问 Claude 时的错误消息（根据交互/非交互模式） */
export function getOauthOrgNotAllowedErrorMessage(): string {
  return getIsNonInteractiveSession()
    ? 'Your organization does not have access to Claude. Please login again or contact your administrator.'
    : OAUTH_ORG_NOT_ALLOWED_ERROR_MESSAGE
}

/**
 * 检查是否处于 CCR（Claude Code Remote）远程模式
 *
 * 在 CCR 模式下，认证由基础设施通过 JWT 处理，而非 /login 命令。
 * 因此，瞬时认证错误应提示重试，而非提示重新登录。
 *
 * Check if we're in CCR (Claude Code Remote) mode.
 * In CCR mode, auth is handled via JWTs provided by the infrastructure,
 * not via /login. Transient auth errors should suggest retrying, not logging in.
 */
function isCCRMode(): boolean {
  return isEnvTruthy(process.env.CLAUDE_CODE_REMOTE)
}

/**
 * 调试辅助函数：记录 tool_use/tool_result 不匹配错误的详细序列信息
 *
 * 当 API 返回 tool_use/tool_result 配对错误时，此函数收集原始消息序列
 * 和规范化后的消息序列，通过 logEvent 发送到分析系统，帮助诊断消息规范化逻辑中的 bug。
 *
 * @param toolUseId - 导致错误的 tool_use ID
 * @param messages - 原始消息数组（用于定位 toolUseId 在原始序列中的位置）
 * @param messagesForAPI - 规范化后发给 API 的消息数组（用于定位规范化后的位置）
 */
// Temp helper to log tool_use/tool_result mismatch errors
function logToolUseToolResultMismatch(
  toolUseId: string,
  messages: Message[],
  messagesForAPI: (UserMessage | AssistantMessage)[],
): void {
  try {
    // 在规范化后的消息中查找 toolUseId 的位置
    let normalizedIndex = -1
    for (let i = 0; i < messagesForAPI.length; i++) {
      const msg = messagesForAPI[i]
      if (!msg) continue
      const content = msg.message.content
      if (Array.isArray(content)) {
        for (const block of content) {
          if (
            block.type === 'tool_use' &&
            'id' in block &&
            block.id === toolUseId
          ) {
            normalizedIndex = i
            break
          }
        }
      }
      if (normalizedIndex !== -1) break
    }

    // 在原始消息中查找 toolUseId 的位置
    let originalIndex = -1
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i]
      if (!msg) continue
      if (msg.type === 'assistant' && 'message' in msg) {
        const content = msg.message.content
        if (Array.isArray(content)) {
          for (const block of content) {
            if (
              block.type === 'tool_use' &&
              'id' in block &&
              block.id === toolUseId
            ) {
              originalIndex = i
              break
            }
          }
        }
      }
      if (originalIndex !== -1) break
    }

    // 构建规范化后的消息序列（从 toolUseId 所在位置之后）
    const normalizedSeq: string[] = []
    for (let i = normalizedIndex + 1; i < messagesForAPI.length; i++) {
      const msg = messagesForAPI[i]
      if (!msg) continue
      const content = msg.message.content
      if (Array.isArray(content)) {
        for (const block of content) {
          const role = msg.message.role
          if (block.type === 'tool_use' && 'id' in block) {
            normalizedSeq.push(`${role}:tool_use:${block.id}`)
          } else if (block.type === 'tool_result' && 'tool_use_id' in block) {
            normalizedSeq.push(`${role}:tool_result:${block.tool_use_id}`)
          } else if (block.type === 'text') {
            normalizedSeq.push(`${role}:text`)
          } else if (block.type === 'thinking') {
            normalizedSeq.push(`${role}:thinking`)
          } else if (block.type === 'image') {
            normalizedSeq.push(`${role}:image`)
          } else {
            normalizedSeq.push(`${role}:${block.type}`)
          }
        }
      } else if (typeof content === 'string') {
        normalizedSeq.push(`${msg.message.role}:string_content`)
      }
    }

    // 构建规范化前的原始消息序列（从 toolUseId 所在位置之后）
    const preNormalizedSeq: string[] = []
    for (let i = originalIndex + 1; i < messages.length; i++) {
      const msg = messages[i]
      if (!msg) continue

      switch (msg.type) {
        case 'user':
        case 'assistant': {
          if ('message' in msg) {
            const content = msg.message.content
            if (Array.isArray(content)) {
              for (const block of content) {
                const role = msg.message.role
                if (block.type === 'tool_use' && 'id' in block) {
                  preNormalizedSeq.push(`${role}:tool_use:${block.id}`)
                } else if (
                  block.type === 'tool_result' &&
                  'tool_use_id' in block
                ) {
                  preNormalizedSeq.push(
                    `${role}:tool_result:${block.tool_use_id}`,
                  )
                } else if (block.type === 'text') {
                  preNormalizedSeq.push(`${role}:text`)
                } else if (block.type === 'thinking') {
                  preNormalizedSeq.push(`${role}:thinking`)
                } else if (block.type === 'image') {
                  preNormalizedSeq.push(`${role}:image`)
                } else {
                  preNormalizedSeq.push(`${role}:${block.type}`)
                }
              }
            } else if (typeof content === 'string') {
              preNormalizedSeq.push(`${msg.message.role}:string_content`)
            }
          }
          break
        }
        case 'attachment':
          if ('attachment' in msg) {
            preNormalizedSeq.push(`attachment:${msg.attachment.type}`)
          }
          break
        case 'system':
          if ('subtype' in msg) {
            preNormalizedSeq.push(`system:${msg.subtype}`)
          }
          break
        case 'progress':
          if (
            'progress' in msg &&
            msg.progress &&
            typeof msg.progress === 'object' &&
            'type' in msg.progress
          ) {
            preNormalizedSeq.push(`progress:${msg.progress.type ?? 'unknown'}`)
          } else {
            preNormalizedSeq.push('progress:unknown')
          }
          break
      }
    }

    // 上报到分析系统（GrowthBook / Statsig）
    logEvent('tengu_tool_use_tool_result_mismatch_error', {
      toolUseId:
        toolUseId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      normalizedSequence: normalizedSeq.join(
        ', ',
      ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      preNormalizedSequence: preNormalizedSeq.join(
        ', ',
      ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      normalizedMessageCount: messagesForAPI.length,
      originalMessageCount: messages.length,
      normalizedToolUseIndex: normalizedIndex,
      originalToolUseIndex: originalIndex,
    })
  } catch (_) {
    // 忽略调试日志中的错误
  }
}

/**
 * 类型守卫：检查值是否为 Anthropic API 返回的有效 BetaMessage
 *
 * 验证必须字段：content（数组）、model（字符串）、usage（对象）
 *
 * Type guard to check if a value is a valid Message response from the API
 */
export function isValidAPIMessage(value: unknown): value is BetaMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    'content' in value &&
    'model' in value &&
    'usage' in value &&
    Array.isArray((value as BetaMessage).content) &&
    typeof (value as BetaMessage).model === 'string' &&
    typeof (value as BetaMessage).usage === 'object'
  )
}

/** AWS Bedrock 底层错误格式（低层次路由错误） */
type AmazonError = {
  Output?: {
    __type?: string
  }
  Version?: string
}

/**
 * 从未知响应中提取已知的错误类型字符串
 *
 * 目前支持 Amazon Bedrock 路由错误格式（Output.__type）
 *
 * Given a response that doesn't look quite right, see if it contains any known error types we can extract.
 */
export function extractUnknownErrorFormat(value: unknown): string | undefined {
  // 首先检查值是否为有效对象
  if (!value || typeof value !== 'object') {
    return undefined
  }

  // Amazon Bedrock 路由错误：从 Output.__type 提取错误类型
  if ((value as AmazonError).Output?.__type) {
    return (value as AmazonError).Output!.__type
  }

  return undefined
}

/**
 * 将各种类型的错误转换为可显示的 AssistantMessage
 *
 * 处理顺序：
 * 1. SDK 超时错误（APIConnectionTimeoutError 或 "timeout" 消息的 APIConnectionError）
 * 2. 图片大小/缩放错误（ImageSizeError/ImageResizeError，发生在 API 调用之前的验证阶段）
 * 3. 限速关断错误（CUSTOM_OFF_SWITCH_MESSAGE，Opus 过载）
 * 4. 429 限速错误（优先解析 ClaudeAILimits 响应头，长上下文额外用量，通用 429）
 * 5. Prompt 过长错误（message 含 "prompt is too long"）
 * 6. PDF 错误（超页数/密码保护/无效）
 * 7. 图片 API 错误（超大小/多图超尺寸）
 * 8. AFK 模式 beta 头不可用
 * 9. 请求体过大（413）
 * 10. tool_use/tool_result 配对错误
 * 11. 重复 tool_use ID
 * 12. Pro 计划不支持 Opus
 * 13. 余额不足
 * 14. 组织被禁用
 * 15. API Key 无效（含 CCR 模式）
 * 16. OAuth token 被撤销
 * 17. OAuth 组织无权限
 * 18. 通用 401/403 认证错误（含 CCR 模式）
 * 19. Bedrock 模型访问错误
 * 20. 404 模型不存在
 * 21. APIConnectionError（SSL/网络）
 * 22. 通用 Error
 * 23. 兜底（非 Error 类型）
 *
 * @param error - 原始错误对象
 * @param model - 当前使用的模型（用于错误消息格式化）
 * @param options.messages - 原始消息列表（用于 tool_use/tool_result 不匹配诊断）
 * @param options.messagesForAPI - 规范化后的 API 消息列表（同上）
 */
export function getAssistantMessageFromError(
  error: unknown,
  model: string,
  options?: {
    messages?: Message[]
    messagesForAPI?: (UserMessage | AssistantMessage)[]
  },
): AssistantMessage {
  // 处理 SDK 超时错误（APIConnectionTimeoutError 或含 "timeout" 的连接错误）
  if (
    error instanceof APIConnectionTimeoutError ||
    (error instanceof APIConnectionError &&
      error.message.toLowerCase().includes('timeout'))
  ) {
    return createAssistantAPIErrorMessage({
      content: API_TIMEOUT_ERROR_MESSAGE,
      error: 'unknown',
    })
  }

  // 处理图片大小/缩放错误（发生在 API 调用之前的验证阶段）
  // 使用 getImageTooLargeErrorMessage() 为 CLI 用户展示 "esc esc" 提示，
  // SDK 用户（非交互模式）则展示通用消息
  if (error instanceof ImageSizeError || error instanceof ImageResizeError) {
    return createAssistantAPIErrorMessage({
      content: getImageTooLargeErrorMessage(),
    })
  }

  // 处理限速关断（CUSTOM_OFF_SWITCH_MESSAGE）：因自定义关断消息导致的 Error 错误
  if (
    error instanceof Error &&
    error.message.includes(CUSTOM_OFF_SWITCH_MESSAGE)
  ) {
    return createAssistantAPIErrorMessage({
      content: CUSTOM_OFF_SWITCH_MESSAGE,
      error: 'rate_limit',
    })
  }

  // 处理 429 限速错误，优先尝试从 rate limit 头部构造 ClaudeAILimits 响应
  if (
    error instanceof APIError &&
    error.status === 429 &&
    shouldProcessRateLimits(model)
  ) {
    const unifiedClaim = error.headers?.get?.('anthropic-ratelimit-unified-representative-claim')
    const overageStatus = error.headers?.get?.('anthropic-ratelimit-unified-overage-status')
    if (unifiedClaim || overageStatus) {
      // 从响应头解析 ClaudeAILimits 对象（含重置时间、欠额状态等）
      const limits: ClaudeAILimits = {
        status: 'rejected',
        unifiedRateLimitFallbackAvailable: false,
        isUsingOverage: false,
      }
      const resetsAt = error.headers?.get?.('anthropic-ratelimit-unified-reset')
      if (resetsAt) limits.resetsAt = Number(resetsAt)
      if (unifiedClaim) limits.rateLimitType = unifiedClaim
      if (overageStatus) limits.overageStatus = overageStatus as OverageDisabledReason
      const overageResetsAt = error.headers?.get?.('anthropic-ratelimit-unified-overage-reset')
      if (overageResetsAt) limits.overageResetsAt = Number(overageResetsAt)
      const overageDisabledReason = error.headers?.get?.('anthropic-ratelimit-unified-overage-disabled-reason')
      if (overageDisabledReason) limits.overageDisabledReason = overageDisabledReason as OverageDisabledReason
      // 使用 getRateLimitErrorMessage() 生成用户友好的限速说明
      const rateLimitMsg = getRateLimitErrorMessage(limits, model)
      if (rateLimitMsg) {
        return createAssistantAPIErrorMessage({
          content: rateLimitMsg,
          error: 'rate_limit',
        })
      }
      return createAssistantAPIErrorMessage({
        content: REPEATED_529_ERROR_MESSAGE,
        error: 'rate_limit',
      })
    }
    // 长上下文额外用量提示
    if (error.message.includes('Extra usage is required for long context')) {
      const hint = getIsNonInteractiveSession()
        ? 'enable extra usage at claude.ai/settings/usage, or use --model to switch to standard context'
        : 'run /extra-usage to enable, or /model to switch to standard context'
      return createAssistantAPIErrorMessage({
        content: `${API_ERROR_MESSAGE_PREFIX}: Extra usage is required for 1M context · ${hint}`,
        error: 'rate_limit',
      })
    }
    // 通用 429 消息格式化
    const stripped = error.message.replace(/^429\s+/, '')
    const msgMatch = stripped.match(/"message"\s*:\s*"([^"]*)"/)
    const msgText = msgMatch?.[1] ?? stripped
    return createAssistantAPIErrorMessage({
      content: `${API_ERROR_MESSAGE_PREFIX}: Request rejected (429) · ${msgText || 'this may be a temporary capacity issue — check status.anthropic.com'}`,
      error: 'rate_limit',
    })
  }

  // 处理 Prompt 过长错误（message 含 "prompt is too long"）
  if (
    error instanceof Error &&
    error.message.toLowerCase().includes('prompt is too long')
  ) {
    return createAssistantAPIErrorMessage({
      content: PROMPT_TOO_LONG_ERROR_MESSAGE,
      error: 'invalid_request',
      errorDetails: error.message,
    })
  }

  // 处理 PDF 超页数错误（message 匹配 "maximum of N PDF pages"）
  if (error instanceof Error && /maximum of \d+ PDF pages/.test(error.message)) {
    return createAssistantAPIErrorMessage({
      content: getPdfTooLargeErrorMessage(),
      error: 'invalid_request',
      errorDetails: error.message,
    })
  }

  // 处理 PDF 密码保护错误
  if (
    error instanceof Error &&
    error.message.includes('The PDF specified is password protected')
  ) {
    return createAssistantAPIErrorMessage({
      content: getPdfPasswordProtectedErrorMessage(),
      error: 'invalid_request',
    })
  }

  // 处理 PDF 无效错误
  if (
    error instanceof Error &&
    error.message.includes('The PDF specified was not valid')
  ) {
    return createAssistantAPIErrorMessage({
      content: getPdfInvalidErrorMessage(),
      error: 'invalid_request',
    })
  }

  // 处理图片超出最大大小的 API 错误（400 + "image exceeds" + "maximum"）
  if (
    error instanceof APIError &&
    error.status === 400 &&
    error.message.includes('image exceeds') &&
    error.message.includes('maximum')
  ) {
    return createAssistantAPIErrorMessage({
      content: getImageTooLargeErrorMessage(),
      errorDetails: error.message,
    })
  }

  // 处理多图片场景下图片尺寸超限错误（400 + "image dimensions exceed" + "many-image"）
  if (
    error instanceof APIError &&
    error.status === 400 &&
    error.message.includes('image dimensions exceed') &&
    error.message.includes('many-image')
  ) {
    return createAssistantAPIErrorMessage({
      content: getIsNonInteractiveSession()
        ? 'An image in the conversation exceeds the dimension limit for many-image requests (2000px). Start a new session with fewer images.'
        : 'An image in the conversation exceeds the dimension limit for many-image requests (2000px). Run /compact to remove old images from context, or start a new session.',
      error: 'invalid_request',
      errorDetails: error.message,
    })
  }

  // 处理 AFK 模式 beta 头不可用错误（400 + AFK_MODE_BETA_HEADER）
  if (
    AFK_MODE_BETA_HEADER &&
    error instanceof APIError &&
    error.status === 400 &&
    error.message.includes(AFK_MODE_BETA_HEADER) &&
    error.message.includes('anthropic-beta')
  ) {
    return createAssistantAPIErrorMessage({
      content: 'Auto mode is unavailable for your plan',
      error: 'invalid_request',
    })
  }

  // 处理请求体过大（413）
  if (error instanceof APIError && error.status === 413) {
    return createAssistantAPIErrorMessage({
      content: getRequestTooLargeErrorMessage(),
      error: 'invalid_request',
    })
  }

  // 处理 tool_use/tool_result 配对错误（400 + "`tool_use` ids were found without `tool_result`"）
  if (
    error instanceof APIError &&
    error.status === 400 &&
    error.message.includes(
      '`tool_use` ids were found without `tool_result` blocks immediately after',
    )
  ) {
    // 提取 tool_use ID 并上报详细序列信息用于诊断
    if (options?.messages && options?.messagesForAPI) {
      const toolUseMatch = error.message.match(/toolu_[a-zA-Z0-9]+/)
      const toolUseId = toolUseMatch ? toolUseMatch[0] : null
      if (toolUseId) {
        logToolUseToolResultMismatch(
          toolUseId,
          options.messages,
          options.messagesForAPI,
        )
      }
    }
    const recoverHint = getIsNonInteractiveSession()
      ? ''
      : ' Run /rewind to recover the conversation.'
    return createAssistantAPIErrorMessage({
      content: `API Error: 400 due to tool use concurrency issues.${recoverHint}`,
      error: 'invalid_request',
    })
  }

  // 处理意外 tool_use_id 在 tool_result 中错误（记录到分析系统，但不提前返回）
  if (
    error instanceof APIError &&
    error.status === 400 &&
    error.message.includes('unexpected `tool_use_id` found in `tool_result`')
  ) {
    logEvent('tengu_unexpected_tool_result', {})
  }

  // 处理重复 tool_use ID 错误（400 + "`tool_use` ids must be unique"）
  if (
    error instanceof APIError &&
    error.status === 400 &&
    error.message.includes('`tool_use` ids must be unique')
  ) {
    logEvent('tengu_duplicate_tool_use_id', {})
    const recoverHint = getIsNonInteractiveSession()
      ? ''
      : ' Run /rewind to recover the conversation.'
    return createAssistantAPIErrorMessage({
      content: `API Error: 400 duplicate tool_use ID in conversation history.${recoverHint}`,
      error: 'invalid_request',
      errorDetails: error.message,
    })
  }

  // 处理 Claude.ai 用户使用 Opus 但 Pro 计划不支持时的 400 "invalid model name" 错误
  if (
    isClaudeAISubscriber() &&
    error instanceof APIError &&
    error.status === 400 &&
    error.message.toLowerCase().includes('invalid model name') &&
    (isNonCustomOpusModel(model) || model === 'opus')
  ) {
    return createAssistantAPIErrorMessage({
      content:
        'Claude Opus is not available with the Claude Pro plan. If you have updated your subscription plan recently, run /logout and /login for the plan to take effect.',
      error: 'invalid_request',
    })
  }

  // 处理余额不足错误（message 含 "Your credit balance is too low"）
  if (
    error instanceof Error &&
    error.message.includes('Your credit balance is too low')
  ) {
    return createAssistantAPIErrorMessage({
      content: CREDIT_BALANCE_TOO_LOW_ERROR_MESSAGE,
      error: 'billing_error',
    })
  }

  // 处理组织被禁用错误（400 + "organization has been disabled"）
  if (
    error instanceof APIError &&
    error.status === 400 &&
    error.message.toLowerCase().includes('organization has been disabled')
  ) {
    const { source } = getAnthropicApiKeyWithSource()
    if (
      source === 'ANTHROPIC_API_KEY' &&
      process.env.ANTHROPIC_API_KEY &&
      !isClaudeAISubscriber()
    ) {
      // 有 ANTHROPIC_API_KEY 环境变量时，根据是否有 OAuth 提供不同提示
      const hasOAuth = getClaudeAIOAuthTokens()?.accessToken != null
      return createAssistantAPIErrorMessage({
        error: 'invalid_request',
        content: hasOAuth
          ? ORG_DISABLED_ERROR_MESSAGE_ENV_KEY_WITH_OAUTH
          : ORG_DISABLED_ERROR_MESSAGE_ENV_KEY,
      })
    }
  }

  // 处理 API Key 无效错误（message 含 "x-api-key"）
  if (
    error instanceof Error &&
    error.message.toLowerCase().includes('x-api-key')
  ) {
    if (isCCRMode()) {
      // CCR 模式：建议重试，而非重新登录
      return createAssistantAPIErrorMessage({
        error: 'authentication_failed',
        content: CCR_AUTH_ERROR_MESSAGE,
      })
    }
    const { source } = getAnthropicApiKeyWithSource()
    return createAssistantAPIErrorMessage({
      error: 'authentication_failed',
      // ANTHROPIC_API_KEY 环境变量或 apiKeyHelper：说明是外部 API Key 无效
      // 否则：说明 OAuth 用户未登录
      content:
        source === 'ANTHROPIC_API_KEY' || source === 'apiKeyHelper'
          ? INVALID_API_KEY_ERROR_MESSAGE_EXTERNAL
          : INVALID_API_KEY_ERROR_MESSAGE,
    })
  }

  // 处理 OAuth token 被撤销错误（403 + "OAuth token has been revoked"）
  if (
    error instanceof APIError &&
    error.status === 403 &&
    error.message.includes('OAuth token has been revoked')
  ) {
    return createAssistantAPIErrorMessage({
      error: 'authentication_failed',
      content: getTokenRevokedErrorMessage(),
    })
  }

  // 处理 OAuth 组织无权访问错误（401/403 + "OAuth authentication is currently not allowed"）
  if (
    error instanceof APIError &&
    (error.status === 401 || error.status === 403) &&
    error.message.includes(
      'OAuth authentication is currently not allowed for this organization',
    )
  ) {
    return createAssistantAPIErrorMessage({
      error: 'authentication_failed',
      content: getOauthOrgNotAllowedErrorMessage(),
    })
  }

  // 处理通用 401/403 认证错误
  if (
    error instanceof APIError &&
    (error.status === 401 || error.status === 403)
  ) {
    if (isCCRMode()) {
      // CCR 模式：建议重试而非重新登录
      return createAssistantAPIErrorMessage({
        error: 'authentication_failed',
        content: CCR_AUTH_ERROR_MESSAGE,
      })
    }
    return createAssistantAPIErrorMessage({
      error: 'authentication_failed',
      content: getIsNonInteractiveSession()
        ? `Failed to authenticate. ${API_ERROR_MESSAGE_PREFIX}: ${error.message}`
        : `Please run /login · ${API_ERROR_MESSAGE_PREFIX}: ${error.message}`,
    })
  }

  // 处理 Bedrock 模型访问错误（USE_BEDROCK + "model id"）
  if (
    process.env.CLAUDE_CODE_USE_BEDROCK &&
    error instanceof Error &&
    error.message.toLowerCase().includes('model id')
  ) {
    const modelFlag = getIsNonInteractiveSession() ? '--model' : '/model'
    const alternativeModel = getAlternativeModel(model)
    return createAssistantAPIErrorMessage({
      content: alternativeModel
        ? `${API_ERROR_MESSAGE_PREFIX} (${model}): ${error.message}. Try ${modelFlag} to switch to ${alternativeModel}.`
        : `${API_ERROR_MESSAGE_PREFIX} (${model}): ${error.message}. Run ${modelFlag} to pick a different model.`,
      error: 'invalid_request',
    })
  }

  // 处理 404 模型不存在或无访问权限错误
  if (error instanceof APIError && error.status === 404) {
    const modelFlag = getIsNonInteractiveSession() ? '--model' : '/model'
    const alternativeModel = getAlternativeModel(model)
    return createAssistantAPIErrorMessage({
      content: alternativeModel
        ? `The model ${model} is not available on your ${getAPIProvider()} deployment. Try ${modelFlag} to switch to ${alternativeModel}, or ask your admin to enable this model.`
        : `There's an issue with the selected model (${model}). It may not exist or you may not have access to it. Run ${modelFlag} to pick a different model.`,
      error: 'invalid_request',
    })
  }

  // 处理 APIConnectionError（非超时，如 SSL 错误、网络故障）
  if (error instanceof APIConnectionError) {
    return createAssistantAPIErrorMessage({
      content: `${API_ERROR_MESSAGE_PREFIX}: ${formatAPIError(error)}`,
      error: 'unknown',
    })
  }

  // 处理通用 Error 实例
  if (error instanceof Error) {
    return createAssistantAPIErrorMessage({
      content: `${API_ERROR_MESSAGE_PREFIX}: ${error.message}`,
      error: 'unknown',
    })
  }

  // 处理非 Error 类型的未知错误（最终兜底）
  return createAssistantAPIErrorMessage({
    content: API_ERROR_MESSAGE_PREFIX,
    error: 'unknown',
  })
}

/**
 * 获取当前提供商的替代模型名（当当前模型不可用时推荐）
 *
 * 仅对非 firstParty 提供商（Bedrock/Vertex）生效；
 * firstParty 场景不需要替代模型（直接不返回）。
 * 通过模型名中的版本号关键词匹配替代方案。
 *
 * @param model - 当前模型名
 * @returns 替代模型名，若无则为 undefined
 */
function getAlternativeModel(model: string): string | undefined {
  if (getAPIProvider() === 'firstParty') return undefined
  const lower = model.toLowerCase()
  const modelStrings = getModelStrings()
  if (lower.includes('opus-4-6') || lower.includes('opus_4_6'))
    return modelStrings.opus41
  if (lower.includes('sonnet-4-6') || lower.includes('sonnet_4_6'))
    return modelStrings.sonnet45
  if (lower.includes('sonnet-4-5') || lower.includes('sonnet_4_5'))
    return modelStrings.sonnet40
  return undefined
}

/**
 * 将 API 错误分类为 analytics/logging 使用的粗粒度错误类型
 *
 * 分类逻辑（从精确到通用）：
 * - "aborted"：请求被中止
 * - "api_timeout"：SDK 超时
 * - "repeated_529"：反复 529 过载
 * - "capacity_off_switch"：自定义关断消息（Opus 过载）
 * - "rate_limit"：429 限速
 * - "server_overload"：529 过载
 * - "prompt_too_long"：Prompt 过长
 * - "pdf_too_large"：PDF 超页数
 * - "pdf_password_protected"：PDF 密码保护
 * - "image_too_large"：图片超限
 * - "tool_use_mismatch"：tool_use/tool_result 配对错误
 * - "unexpected_tool_result"：意外 tool_use_id
 * - "duplicate_tool_use_id"：重复 tool_use ID
 * - "invalid_model"：无效模型名
 * - "credit_balance_low"：余额不足
 * - "invalid_api_key"：API Key 无效
 * - "token_revoked"：OAuth token 被撤销
 * - "oauth_org_not_allowed"：OAuth 组织无权限
 * - "auth_error"：其他认证错误
 * - "bedrock_model_access"：Bedrock 模型访问错误
 * - "server_error"：5xx 服务端错误
 * - "client_error"：4xx 客户端错误
 * - "ssl_cert_error"：SSL 证书错误
 * - "connection_error"：连接错误
 * - "unknown"：未知错误
 */
export function classifyAPIError(error: unknown): string {
  // 请求被中止
  if (error instanceof Error && error.message === 'Request was aborted.')
    return 'aborted'

  // SDK 超时
  if (
    error instanceof APIConnectionTimeoutError ||
    (error instanceof APIConnectionError &&
      error.message.toLowerCase().includes('timeout'))
  )
    return 'api_timeout'

  // 反复 529 过载（REPEATED_529_ERROR_MESSAGE）
  if (error instanceof Error && error.message.includes(REPEATED_529_ERROR_MESSAGE))
    return 'repeated_529'

  // 自定义关断（Opus 过载：CUSTOM_OFF_SWITCH_MESSAGE）
  if (error instanceof Error && error.message.includes(CUSTOM_OFF_SWITCH_MESSAGE))
    return 'capacity_off_switch'

  // 429 限速
  if (error instanceof APIError && error.status === 429) return 'rate_limit'

  // 529 过载（status 529 或 message 包含 '"type":"overloaded_error"'）
  if (
    error instanceof APIError &&
    (error.status === 529 ||
      error.message?.includes('"type":"overloaded_error"'))
  )
    return 'server_overload'

  // Prompt 过长（message 含 "prompt is too long"）
  if (
    error instanceof Error &&
    error.message.toLowerCase().includes(PROMPT_TOO_LONG_ERROR_MESSAGE.toLowerCase())
  )
    return 'prompt_too_long'

  // PDF 超页数
  if (error instanceof Error && /maximum of \d+ PDF pages/.test(error.message))
    return 'pdf_too_large'

  // PDF 密码保护
  if (
    error instanceof Error &&
    error.message.includes('The PDF specified is password protected')
  )
    return 'pdf_password_protected'

  // 图片超限（"image exceeds maximum" 或 "image dimensions exceed many-image"）
  if (
    error instanceof APIError &&
    error.status === 400 &&
    error.message.includes('image exceeds') &&
    error.message.includes('maximum')
  )
    return 'image_too_large'

  if (
    error instanceof APIError &&
    error.status === 400 &&
    error.message.includes('image dimensions exceed') &&
    error.message.includes('many-image')
  )
    return 'image_too_large'

  // tool_use/tool_result 配对错误
  if (
    error instanceof APIError &&
    error.status === 400 &&
    error.message.includes(
      '`tool_use` ids were found without `tool_result` blocks immediately after',
    )
  )
    return 'tool_use_mismatch'

  // 意外 tool_use_id
  if (
    error instanceof APIError &&
    error.status === 400 &&
    error.message.includes('unexpected `tool_use_id` found in `tool_result`')
  )
    return 'unexpected_tool_result'

  // 重复 tool_use ID
  if (
    error instanceof APIError &&
    error.status === 400 &&
    error.message.includes('`tool_use` ids must be unique')
  )
    return 'duplicate_tool_use_id'

  // 无效模型名
  if (
    error instanceof APIError &&
    error.status === 400 &&
    error.message.toLowerCase().includes('invalid model name')
  )
    return 'invalid_model'

  // 余额不足
  if (
    error instanceof Error &&
    error.message
      .toLowerCase()
      .includes(CREDIT_BALANCE_TOO_LOW_ERROR_MESSAGE.toLowerCase())
  )
    return 'credit_balance_low'

  // API Key 无效
  if (
    error instanceof Error &&
    error.message.toLowerCase().includes('x-api-key')
  )
    return 'invalid_api_key'

  // OAuth token 被撤销
  if (
    error instanceof APIError &&
    error.status === 403 &&
    error.message.includes('OAuth token has been revoked')
  )
    return 'token_revoked'

  // OAuth 组织无权限
  if (
    error instanceof APIError &&
    (error.status === 401 || error.status === 403) &&
    error.message.includes(
      'OAuth authentication is currently not allowed for this organization',
    )
  )
    return 'oauth_org_not_allowed'

  // 其他 401/403 认证错误
  if (
    error instanceof APIError &&
    (error.status === 401 || error.status === 403)
  )
    return 'auth_error'

  // Bedrock 模型访问错误
  if (
    process.env.CLAUDE_CODE_USE_BEDROCK &&
    error instanceof Error &&
    error.message.toLowerCase().includes('model id')
  )
    return 'bedrock_model_access'

  // 其他 APIError 按 HTTP 状态码分类
  if (error instanceof APIError) {
    const status = error.status
    if (status !== undefined && status >= 500) return 'server_error'
    if (status !== undefined && status >= 400) return 'client_error'
  }

  // 连接错误（APIConnectionError）
  if (error instanceof APIConnectionError) {
    // SSL 证书错误
    if (extractConnectionErrorDetails(error)?.isSSLError) return 'ssl_cert_error'
    return 'connection_error'
  }

  return 'unknown'
}

/**
 * 检测 API 响应是否为 Claude 的自我审查拒绝（refusal）
 *
 * 当 stop_reason 为 "refusal" 时，记录分析事件并返回一条用户友好的
 * AssistantMessage 错误消息（提示违反了使用政策）。
 * 返回 undefined 表示非拒绝，调用方继续正常流程。
 *
 * 拒绝消息因模式而异：
 * - 交互模式（CLI）：提示"按 Esc 编辑"
 * - 非交互模式（SDK）：提示"Claude Code is unable to respond"
 * - 非 claude-sonnet-4-20250514 模型还附加切换模型建议
 *
 * @param stopReason - BetaMessage 或 BetaStopReason 的停止原因字段
 * @param model - 当前使用的模型名
 * @returns 拒绝时返回 AssistantMessage，否则返回 undefined
 */
export function getErrorMessageIfRefusal(
  stopReason: BetaStopReason | null | undefined,
  model: string,
): AssistantMessage | undefined {
  // 非 refusal 停止原因直接返回 undefined（正常流程）
  if (stopReason !== 'refusal') return undefined

  // 记录拒绝事件到分析系统
  logEvent('tengu_refusal_api_response', {})

  // 根据交互/非交互模式构造不同的拒绝提示消息
  const baseContent = getIsNonInteractiveSession()
    ? `${API_ERROR_MESSAGE_PREFIX}: Claude Code is unable to respond to this request, which appears to violate our Usage Policy (https://www.anthropic.com/legal/aup). Try rephrasing the request or attempting a different approach.`
    : `${API_ERROR_MESSAGE_PREFIX}: Claude Code is unable to respond to this request, which appears to violate our Usage Policy (https://www.anthropic.com/legal/aup). Please double press esc to edit your last message or start a new session for Claude Code to assist with a different task.`

  // 非 claude-sonnet-4-20250514 模型时，附加切换模型的建议
  const switchHint =
    model !== 'claude-sonnet-4-20250514'
      ? ' If you are seeing this refusal repeatedly, try running /model claude-sonnet-4-20250514 to switch models.'
      : ''

  return createAssistantAPIErrorMessage({
    content: baseContent + switchHint,
    error: 'invalid_request',
  })
}

/**
 * 将 APIError 分类为 AssistantMessage 错误类型字段使用的简化枚举
 *
 * 仅用于 createAssistantAPIErrorMessage 的 error 参数，
 * 与 classifyAPIError() 的返回值不同（后者用于分析/日志上报）。
 *
 * @param error - API 错误对象
 * @returns 'rate_limit' | 'authentication_failed' | 'server_error' | 'unknown'
 */
export function classifyAPIErrorForMessage(error: APIError): SDKAssistantMessageError {
  if (error.status === 529 || error.message?.includes('"type":"overloaded_error"'))
    return 'rate_limit'
  if (error.status === 429) return 'rate_limit'
  if (error.status === 401 || error.status === 403) return 'authentication_failed'
  if (error.status !== undefined && error.status >= 408) return 'server_error'
  return 'unknown'
}

/**
 * 返回当前 API 提供商的显示名称（用于错误消息格式化）
 *
 * 供 getAssistantMessageFromError() 中的 404 模型不存在错误消息使用，
 * 告知用户具体是哪个 deployment 不支持该模型。
 *
 * @returns 提供商名称，如 "firstParty"/"bedrock"/"vertex"
 */
export function getCurrentProviderName(): string {
  return getAPIProvider()
}
