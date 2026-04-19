/**
 * rename/generateSessionName.ts —— 会话名称 AI 生成器
 *
 * 在整体流程中的位置：
 *   initReplBridge.ts 每第 3 条 bridge 消息后自动触发
 *   → 调用 generateSessionName(messages, signal)
 *   → 使用 Claude Haiku 模型分析对话内容
 *   → 返回 kebab-case 格式的简短会话名称
 *   → 上层将名称写入会话元数据，用于历史列表展示
 *
 * 设计特点：
 *   - 使用轻量级 Haiku 模型（而非主循环模型），降低延迟和成本
 *   - 要求 JSON Schema 结构化输出（{ name: string }），避免解析歧义
 *   - 失败时静默降级返回 null，不影响主对话流程
 *   - 错误使用 logForDebugging 而非 logError，防止频繁调用污染错误日志
 */
import { queryHaiku } from '../../services/api/claude.js'
import type { Message } from '../../types/message.js'
import { logForDebugging } from '../../utils/debug.js'
import { errorMessage } from '../../utils/errors.js'
import { safeParseJSON } from '../../utils/json.js'
import { extractTextContent } from '../../utils/messages.js'
import { extractConversationText } from '../../utils/sessionTitle.js'
import { asSystemPrompt } from '../../utils/systemPromptType.js'

/**
 * generateSessionName —— 基于对话内容自动生成简短的 kebab-case 会话名称
 *
 * 流程：
 *   1. extractConversationText 将消息数组压缩为纯文本摘要
 *      （对话内容为空时提前返回 null，无需调用 AI）
 *   2. 以含示例的 system prompt 指导 Haiku 生成 2-4 词的 kebab-case 名称
 *   3. 要求 JSON Schema 结构化输出，强制模型返回 { name: "..." } 格式
 *   4. 用 safeParseJSON 解析响应，验证 name 字段存在且为字符串
 *   5. 解析失败或 API 报错时静默返回 null
 *
 * @param messages 当前会话的消息数组（Human + Assistant 交替）
 * @param signal   AbortSignal，会话结束或用户取消时中止请求
 * @returns        kebab-case 格式的会话名称字符串，或 null（无内容/失败时）
 */
export async function generateSessionName(
  messages: Message[],
  signal: AbortSignal,
): Promise<string | null> {
  // 将消息历史提炼为纯文本，内容为空（如只有系统消息）时跳过 AI 调用
  const conversationText = extractConversationText(messages)
  if (!conversationText) {
    return null
  }

  try {
    const result = await queryHaiku({
      systemPrompt: asSystemPrompt([
        // 系统提示：明确要求 2-4 词 kebab-case，并提供示例锚定输出风格
        'Generate a short kebab-case name (2-4 words) that captures the main topic of this conversation. Use lowercase words separated by hyphens. Examples: "fix-login-bug", "add-auth-feature", "refactor-api-client", "debug-test-failures". Return JSON with a "name" field.',
      ]),
      userPrompt: conversationText,  // 将对话文本作为用户输入供模型分析
      outputFormat: {
        type: 'json_schema',         // 强制结构化输出，避免模型返回自由文本
        schema: {
          type: 'object',
          properties: {
            name: { type: 'string' }, // 唯一字段：生成的 kebab-case 名称
          },
          required: ['name'],
          additionalProperties: false, // 禁止额外字段，保持输出纯净
        },
      },
      signal,                        // 传递 AbortSignal 支持提前取消
      options: {
        querySource: 'rename_generate_name', // 标识请求来源，用于分析和计费追踪
        agents: [],
        isNonInteractiveSession: false,
        hasAppendSystemPrompt: false,
        mcpTools: [],
      },
    })

    // 从模型响应中提取文本内容（content 可能为数组）
    const content = extractTextContent(result.message.content)

    // 安全解析 JSON，解析失败时返回 null 而非抛出异常
    const response = safeParseJSON(content)
    if (
      response &&
      typeof response === 'object' &&
      'name' in response &&
      typeof (response as { name: unknown }).name === 'string'
    ) {
      // 类型收窄后安全提取 name 字段
      return (response as { name: string }).name
    }
    return null // JSON 结构不符合预期，降级返回 null
  } catch (error) {
    // Haiku timeout/rate-limit/network are expected operational failures —
    // logForDebugging, not logError. Called automatically on every 3rd bridge
    // message (initReplBridge.ts), so errors here would flood the error file.
    // Haiku 超时/限速/网络失败属于正常运营故障，使用 logForDebugging 而非 logError，
    // 避免每第 3 条消息都触发的自动调用将错误日志文件刷爆
    logForDebugging(`generateSessionName failed: ${errorMessage(error)}`, {
      level: 'error',
    })
    return null // 任何异常都静默降级，不影响主对话流程
  }
}
