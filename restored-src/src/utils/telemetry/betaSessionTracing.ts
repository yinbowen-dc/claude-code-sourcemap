/**
 * telemetry/betaSessionTracing.ts — Beta 精细追踪模块
 *
 * 在 Claude Code 的可观测性体系中，本文件实现了一套专为调试设计的详细追踪功能，
 * 需要通过以下环境变量显式启用：
 *   - ENABLE_BETA_TRACING_DETAILED=1  （开启精细追踪）
 *   - BETA_TRACING_ENDPOINT=<url>      （指定追踪数据接收端点，如 Honeycomb）
 *
 * 启用条件（分用户类型）：
 *   - ant 内部用户：所有模式均可启用
 *   - 外部用户：仅 SDK/headless 模式，或组织在 tengu_trace_lantern GrowthBook 白名单中
 *
 * 可见性矩阵：
 *   | 内容类型        | 外部用户 | ant 用户 |
 *   |----------------|---------|---------|
 *   | 系统提示词      | ✅      | ✅      |
 *   | 模型输出        | ✅      | ✅      |
 *   | 思考过程输出    | ❌      | ✅      |
 *   | 工具调用        | ✅      | ✅      |
 *   | new_context     | ✅      | ✅      |
 *
 * 核心优化机制：
 *   1. seenHashes Set — 基于哈希的去重，避免重复发送相同的系统提示词和工具定义
 *   2. lastReportedMessageHash Map — 增量上下文，每次只发送自上次请求以来的新消息
 *   3. 内容截断 — 60KB 限制（Honeycomb 最大 64KB，留 4KB 余量）
 *
 * 导出函数：
 *   - isBetaTracingEnabled()            : 检查是否启用
 *   - truncateContent()                 : 内容截断（公开用于测试）
 *   - clearBetaTracingState()           : 清除会话内状态（compaction 后调用）
 *   - addBetaInteractionAttributes()    : 为 interaction span 添加 beta 属性
 *   - addBetaLLMRequestAttributes()     : 为 LLM 请求 span 添加系统提示词、工具、new_context
 *   - addBetaLLMResponseAttributes()    : 为 LLM 响应 span 添加模型输出和思考输出
 *   - addBetaToolInputAttributes()      : 为工具调用 span 添加 tool_input
 *   - addBetaToolResultAttributes()     : 为工具结果 span 添加 new_context
 */

import type { Span } from '@opentelemetry/api'
import { createHash } from 'crypto'
import { getIsNonInteractiveSession } from '../../bootstrap/state.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import { sanitizeToolNameForAnalytics } from '../../services/analytics/metadata.js'
import type { AssistantMessage, UserMessage } from '../../types/message.js'
import { isEnvTruthy } from '../envUtils.js'
import { jsonParse, jsonStringify } from '../slowOperations.js'
import { logOTelEvent } from './events.js'

/** API 消息的联合类型（用户消息或助手消息） */
type APIMessage = UserMessage | AssistantMessage

/**
 * 追踪本次会话中已记录过的哈希集合（系统提示词、工具定义等）。
 *
 * 优化目的：系统提示词和工具 Schema 体积大但在会话内很少变化。
 * 每次 LLM 请求都发送完整内容会造成带宽浪费。
 * 通过哈希去重，每个唯一内容只发送一次完整版本，后续请求只发送哈希。
 */
const seenHashes = new Set<string>()

/**
 * 每个 querySource（智能体）最后上报的消息哈希。
 *
 * 增量上下文原理：调试时需要看到每轮新增了什么信息，而非整个对话历史
 * （完整历史可能体积极大）。通过记录每个智能体最后上报的消息哈希，
 * 可以只发送增量（自上次请求以来的新消息）。
 * 按 querySource 独立追踪，因为不同智能体（主线程、子智能体、预热请求）
 * 有各自独立的对话上下文。
 */
const lastReportedMessageHash = new Map<string, string>()

/**
 * 清除 beta 追踪的会话内状态。
 *
 * 在 compaction（上下文压缩）后调用：压缩后旧消息已被替换，
 * 之前的哈希不再有效，需要重置以避免错误的去重判断。
 */
export function clearBetaTracingState(): void {
  seenHashes.clear()
  lastReportedMessageHash.clear()
}

/** 内容截断限制：60KB（Honeycomb 上限 64KB，留 4KB 安全余量） */
const MAX_CONTENT_SIZE = 60 * 1024

/**
 * 检查 beta 详细追踪是否已启用。
 *
 * 启用条件：
 *   1. ENABLE_BETA_TRACING_DETAILED=1 且 BETA_TRACING_ENDPOINT 已设置（基础条件）
 *   2. ant 用户：直接返回 true
 *   3. 外部用户：SDK/headless 模式 OR 组织在 tengu_trace_lantern GrowthBook 白名单中
 *
 * 注意：GrowthBook feature gate 从磁盘缓存读取，首次加入白名单后第一次运行
 * 可能返回 false，从第二次运行开始生效（与 enhanced_telemetry_beta 行为一致）。
 */
export function isBetaTracingEnabled(): boolean {
  // 基础条件：必须同时设置 flag 环境变量和端点
  const baseEnabled =
    isEnvTruthy(process.env.ENABLE_BETA_TRACING_DETAILED) &&
    Boolean(process.env.BETA_TRACING_ENDPOINT)

  if (!baseEnabled) {
    return false
  }

  // 对外部用户进行额外限制：SDK/headless 模式或白名单组织
  // GrowthBook gate 从磁盘缓存读取，因此首次加入白名单后需要重启才生效
  if (process.env.USER_TYPE !== 'ant') {
    return (
      getIsNonInteractiveSession() ||
      getFeatureValue_CACHED_MAY_BE_STALE('tengu_trace_lantern', false)
    )
  }

  // ant 用户无额外限制
  return true
}

/**
 * 将内容截断到指定大小限制内。
 *
 * 超出限制时在末尾追加截断标记，方便调试时识别截断位置。
 *
 * @param content - 原始内容字符串
 * @param maxSize - 最大允许字节数（默认 60KB）
 * @returns { content: 截断后内容, truncated: 是否被截断 }
 */
export function truncateContent(
  content: string,
  maxSize: number = MAX_CONTENT_SIZE,
): { content: string; truncated: boolean } {
  if (content.length <= maxSize) {
    return { content, truncated: false }
  }

  return {
    // 截取到限制位置，追加截断说明
    content:
      content.slice(0, maxSize) +
      '\n\n[TRUNCATED - Content exceeds 60KB limit]',
    truncated: true,
  }
}

/**
 * 生成 12 字符的 SHA-256 短哈希（用于去重键）。
 *
 * 12 字符（48 bit）在预计的使用规模下碰撞概率可忽略。
 */
function shortHash(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 12)
}

/**
 * 为系统提示词生成带前缀的哈希（以 "sp_" 开头）。
 * 前缀用于在 seenHashes 集合中区分不同类型的哈希。
 */
function hashSystemPrompt(systemPrompt: string): string {
  return `sp_${shortHash(systemPrompt)}`
}

/**
 * 根据消息内容生成带前缀的消息哈希（以 "msg_" 开头）。
 * 用于增量上下文追踪的锚点。
 */
function hashMessage(message: APIMessage): string {
  const content = jsonStringify(message.message.content)
  return `msg_${shortHash(content)}`
}

// 用于检测被 <system-reminder> 标签包裹内容的正则表达式
const SYSTEM_REMINDER_REGEX =
  /^<system-reminder>\n?([\s\S]*?)\n?<\/system-reminder>$/

/**
 * 检测文本是否完全由 <system-reminder> 标签包裹。
 *
 * 系统提醒（system reminder）是 Claude Code 内部注入的上下文信息，
 * 在追踪时应与用户真实输入分开显示，以便调试时区分来源。
 *
 * @param text - 要检测的文本
 * @returns 标签内的内容（若是 system reminder），否则返回 null
 */
function extractSystemReminderContent(text: string): string | null {
  const match = text.trim().match(SYSTEM_REMINDER_REGEX)
  return match && match[1] ? match[1].trim() : null
}

/**
 * 格式化消息后的分离结果：常规内容和系统提醒分开存储。
 */
interface FormattedMessages {
  contextParts: string[]    // 用户输入和工具结果
  systemReminders: string[] // 系统提醒内容
}

/**
 * 将用户消息列表格式化为追踪显示格式，同时分离系统提醒。
 *
 * 处理逻辑：
 *   - 字符串内容：检测是否为系统提醒，是则放入 systemReminders，否则加 [USER] 前缀
 *   - 数组内容（多块）：对每个 text 块和 tool_result 块分别处理
 *   - tool_result 内容也可能包含系统提醒（如恶意软件警告）
 *
 * @param messages - 仅包含用户消息（调用前应已过滤掉助手消息）
 */
function formatMessagesForContext(messages: UserMessage[]): FormattedMessages {
  const contextParts: string[] = []
  const systemReminders: string[] = []

  for (const message of messages) {
    const content = message.message.content
    if (typeof content === 'string') {
      // 字符串内容：检测系统提醒
      const reminderContent = extractSystemReminderContent(content)
      if (reminderContent) {
        systemReminders.push(reminderContent)
      } else {
        contextParts.push(`[USER]\n${content}`)
      }
    } else if (Array.isArray(content)) {
      // 数组内容：逐块处理
      for (const block of content) {
        if (block.type === 'text') {
          // 文本块：同样检测系统提醒
          const reminderContent = extractSystemReminderContent(block.text)
          if (reminderContent) {
            systemReminders.push(reminderContent)
          } else {
            contextParts.push(`[USER]\n${block.text}`)
          }
        } else if (block.type === 'tool_result') {
          // 工具结果块：序列化内容后检测系统提醒
          const resultContent =
            typeof block.content === 'string'
              ? block.content
              : jsonStringify(block.content)
          // 工具结果也可能包含系统提醒（如恶意软件警告注入）
          const reminderContent = extractSystemReminderContent(resultContent)
          if (reminderContent) {
            systemReminders.push(reminderContent)
          } else {
            contextParts.push(
              `[TOOL RESULT: ${block.tool_use_id}]\n${resultContent}`,
            )
          }
        }
      }
    }
  }

  return { contextParts, systemReminders }
}

/** LLM 请求的新上下文信息（用于 beta 追踪） */
export interface LLMRequestNewContext {
  /** 系统提示词（通常只在首次请求或变更时存在） */
  systemPrompt?: string
  /** 查询来源标识，用于区分不同智能体（如 'repl_main_thread', 'agent:builtin'） */
  querySource?: string
  /** 随请求发送的工具 Schema JSON 字符串 */
  tools?: string
}

/**
 * 为 interaction span 添加 beta 追踪属性。
 *
 * 将用户提示词附加为 new_context 属性（截断到 60KB）。
 * 若 beta 追踪未启用则立即返回。
 *
 * @param span       - OTel Span 对象
 * @param userPrompt - 用户原始输入文本
 */
export function addBetaInteractionAttributes(
  span: Span,
  userPrompt: string,
): void {
  if (!isBetaTracingEnabled()) {
    return
  }

  // 截断用户提示词并设置为 new_context 属性
  const { content: truncatedPrompt, truncated } = truncateContent(
    `[USER PROMPT]\n${userPrompt}`,
  )
  span.setAttributes({
    new_context: truncatedPrompt,
    // 若发生截断，附加截断标记和原始长度
    ...(truncated && {
      new_context_truncated: true,
      new_context_original_length: userPrompt.length,
    }),
  })
}

/**
 * 为 LLM 请求 span 添加 beta 追踪属性。
 *
 * 处理三类信息：
 *
 * 1. 系统提示词（systemPrompt）：
 *    - 始终记录哈希、前 500 字符预览和长度
 *    - 完整内容仅在 seenHashes 中未出现时发射一次（避免重复）
 *
 * 2. 工具定义（tools）：
 *    - 解析工具数组，为每个工具生成 {name, hash} 摘要
 *    - 每个工具的完整定义仅发射一次（基于哈希去重）
 *
 * 3. 增量上下文（new_context）：
 *    - 找到自上次上报消息以来的新消息（使用 lastReportedMessageHash 追踪）
 *    - 仅过滤用户消息（跳过助手消息）
 *    - 将系统提醒和常规内容分开存储为不同属性
 *
 * @param span          - OTel Span 对象
 * @param newContext    - LLM 请求的新上下文信息
 * @param messagesForAPI - 完整的 API 消息列表（用于增量计算）
 */
export function addBetaLLMRequestAttributes(
  span: Span,
  newContext?: LLMRequestNewContext,
  messagesForAPI?: APIMessage[],
): void {
  if (!isBetaTracingEnabled()) {
    return
  }

  // ── 1. 处理系统提示词 ─────────────────────────────────────────────────────
  if (newContext?.systemPrompt) {
    const promptHash = hashSystemPrompt(newContext.systemPrompt)
    const preview = newContext.systemPrompt.slice(0, 500) // 前 500 字符预览

    // 始终记录哈希、预览和长度（用于快速比较）
    span.setAttribute('system_prompt_hash', promptHash)
    span.setAttribute('system_prompt_preview', preview)
    span.setAttribute('system_prompt_length', newContext.systemPrompt.length)

    // 完整内容只在首次遇到该哈希时发射（基于 seenHashes 去重）
    if (!seenHashes.has(promptHash)) {
      seenHashes.add(promptHash)

      const { content: truncatedPrompt, truncated } = truncateContent(
        newContext.systemPrompt,
      )

      // 发射独立的 system_prompt 事件（不依赖于 span）
      void logOTelEvent('system_prompt', {
        system_prompt_hash: promptHash,
        system_prompt: truncatedPrompt,
        system_prompt_length: String(newContext.systemPrompt.length),
        ...(truncated && { system_prompt_truncated: 'true' }),
      })
    }
  }

  // ── 2. 处理工具定义 ─────────────────────────────────────────────────────
  if (newContext?.tools) {
    try {
      // 解析工具 JSON 数组
      const toolsArray = jsonParse(newContext.tools) as Record<
        string,
        unknown
      >[]

      // 为每个工具生成 {name, hash, json} 对象
      const toolsWithHashes = toolsArray.map(tool => {
        const toolJson = jsonStringify(tool)
        const toolHash = shortHash(toolJson)
        return {
          name: typeof tool.name === 'string' ? tool.name : 'unknown',
          hash: toolHash,
          json: toolJson,
        }
      })

      // 在 span 上记录工具摘要（name+hash 数组，不含完整定义）
      span.setAttribute(
        'tools',
        jsonStringify(
          toolsWithHashes.map(({ name, hash }) => ({ name, hash })),
        ),
      )
      span.setAttribute('tools_count', toolsWithHashes.length)

      // 完整工具定义：每个工具只发射一次（基于 "tool_<hash>" 去重）
      for (const { name, hash, json } of toolsWithHashes) {
        if (!seenHashes.has(`tool_${hash}`)) {
          seenHashes.add(`tool_${hash}`)

          const { content: truncatedTool, truncated } = truncateContent(json)

          void logOTelEvent('tool', {
            tool_name: sanitizeToolNameForAnalytics(name), // 脱敏工具名
            tool_hash: hash,
            tool: truncatedTool,
            ...(truncated && { tool_truncated: 'true' }),
          })
        }
      }
    } catch {
      // JSON 解析失败时标记错误（不抛出，避免影响主流程）
      span.setAttribute('tools_parse_error', true)
    }
  }

  // ── 3. 处理增量上下文（new_context）────────────────────────────────────
  if (messagesForAPI && messagesForAPI.length > 0 && newContext?.querySource) {
    const querySource = newContext.querySource
    // 获取该 querySource 上次上报的最后一条消息哈希
    const lastHash = lastReportedMessageHash.get(querySource)

    // 找到上次上报消息在数组中的位置，从其后开始发送增量
    let startIndex = 0
    if (lastHash) {
      for (let i = 0; i < messagesForAPI.length; i++) {
        const msg = messagesForAPI[i]
        if (msg && hashMessage(msg) === lastHash) {
          startIndex = i + 1 // 从上次上报消息的下一条开始
          break
        }
      }
      // 若未找到 lastHash 对应消息（如 compaction 后），startIndex 保持 0（发送全部）
    }

    // 截取增量消息，仅保留用户消息（过滤掉助手消息）
    const newMessages = messagesForAPI
      .slice(startIndex)
      .filter((m): m is UserMessage => m.type === 'user')

    if (newMessages.length > 0) {
      // 格式化新消息，分离系统提醒和常规内容
      const { contextParts, systemReminders } =
        formatMessagesForContext(newMessages)

      // 设置常规上下文（用户输入和工具结果）
      if (contextParts.length > 0) {
        const fullContext = contextParts.join('\n\n---\n\n')
        const { content: truncatedContext, truncated } =
          truncateContent(fullContext)

        span.setAttributes({
          new_context: truncatedContext,
          new_context_message_count: newMessages.length,
          ...(truncated && {
            new_context_truncated: true,
            new_context_original_length: fullContext.length,
          }),
        })
      }

      // 设置系统提醒（单独属性，与常规上下文区分）
      if (systemReminders.length > 0) {
        const fullReminders = systemReminders.join('\n\n---\n\n')
        const { content: truncatedReminders, truncated: remindersTruncated } =
          truncateContent(fullReminders)

        span.setAttributes({
          system_reminders: truncatedReminders,
          system_reminders_count: systemReminders.length,
          ...(remindersTruncated && {
            system_reminders_truncated: true,
            system_reminders_original_length: fullReminders.length,
          }),
        })
      }

      // 更新 lastReportedMessageHash 为消息数组中的最后一条（下次请求时作为基准）
      const lastMessage = messagesForAPI[messagesForAPI.length - 1]
      if (lastMessage) {
        lastReportedMessageHash.set(querySource, hashMessage(lastMessage))
      }
    }
  }
}

/**
 * 为 LLM 响应 span 的结束属性添加 beta 追踪信息。
 *
 * 处理两类输出：
 *   - model_output（模型文本输出）：对所有用户可见
 *   - thinking_output（思考过程）：仅对 ant 内部用户可见
 *
 * 两者都会截断到 60KB 限制，并在截断时记录截断标记和原始长度。
 *
 * @param endAttributes - LLM 请求结束时的属性字典（会被就地修改）
 * @param metadata      - 模型输出和思考输出
 */
export function addBetaLLMResponseAttributes(
  endAttributes: Record<string, string | number | boolean>,
  metadata?: {
    modelOutput?: string
    thinkingOutput?: string
  },
): void {
  if (!isBetaTracingEnabled() || !metadata) {
    return
  }

  // 处理模型文本输出（对所有启用了 beta 追踪的用户可见）
  if (metadata.modelOutput !== undefined) {
    const { content: modelOutput, truncated: outputTruncated } =
      truncateContent(metadata.modelOutput)
    endAttributes['response.model_output'] = modelOutput
    if (outputTruncated) {
      endAttributes['response.model_output_truncated'] = true
      endAttributes['response.model_output_original_length'] =
        metadata.modelOutput.length
    }
  }

  // 处理思考过程输出（仅 ant 内部用户可见，防止外部用户访问思维链）
  if (
    process.env.USER_TYPE === 'ant' &&
    metadata.thinkingOutput !== undefined
  ) {
    const { content: thinkingOutput, truncated: thinkingTruncated } =
      truncateContent(metadata.thinkingOutput)
    endAttributes['response.thinking_output'] = thinkingOutput
    if (thinkingTruncated) {
      endAttributes['response.thinking_output_truncated'] = true
      endAttributes['response.thinking_output_original_length'] =
        metadata.thinkingOutput.length
    }
  }
}

/**
 * 为工具调用 span 添加工具输入的 beta 追踪属性。
 *
 * 将工具名和序列化的工具输入组合为 "[TOOL INPUT: <toolName>]\n<input>" 格式，
 * 截断后存储为 tool_input 属性。
 *
 * @param span      - OTel Span 对象（工具调用 span）
 * @param toolName  - 工具名称
 * @param toolInput - 序列化的工具输入 JSON 字符串
 */
export function addBetaToolInputAttributes(
  span: Span,
  toolName: string,
  toolInput: string,
): void {
  if (!isBetaTracingEnabled()) {
    return
  }

  const { content: truncatedInput, truncated } = truncateContent(
    `[TOOL INPUT: ${toolName}]\n${toolInput}`,
  )
  span.setAttributes({
    tool_input: truncatedInput,
    ...(truncated && {
      tool_input_truncated: true,
      tool_input_original_length: toolInput.length,
    }),
  })
}

/**
 * 为工具调用结束时的属性字典添加工具结果的 beta 追踪信息。
 *
 * 将工具名和结果组合为 "[TOOL RESULT: <toolName>]\n<result>" 格式，
 * 截断后存储为 new_context 属性（与 interaction span 的 new_context 格式一致）。
 *
 * @param endAttributes - 工具调用结束时的属性字典（会被就地修改）
 * @param toolName      - 工具名称
 * @param toolResult    - 工具执行结果字符串
 */
export function addBetaToolResultAttributes(
  endAttributes: Record<string, string | number | boolean>,
  toolName: string | number | boolean,
  toolResult: string,
): void {
  if (!isBetaTracingEnabled()) {
    return
  }

  const { content: truncatedResult, truncated } = truncateContent(
    `[TOOL RESULT: ${toolName}]\n${toolResult}`,
  )
  endAttributes['new_context'] = truncatedResult
  if (truncated) {
    endAttributes['new_context_truncated'] = true
    endAttributes['new_context_original_length'] = toolResult.length
  }
}
