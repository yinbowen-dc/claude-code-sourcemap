/**
 * 旁路提问（Side Question / "/btw"）功能模块。
 *
 * 在 Claude Code 系统中，该模块实现 "/btw" 快捷功能：
 * 用户可在不打断主 Agent 工作流的情况下，通过 `/btw <问题>` 向
 * 一个轻量级 forked agent 提问，并获得即时回答。
 *
 * 核心设计：
 * - 复用父上下文的 Prompt Cache（共享 cacheSafeParams），降低 API 开销
 * - 不覆盖 thinking 配置，保证与主线程共用相同缓存 key
 * - 禁止所有工具调用（canUseTool: deny），最多 1 轮
 * - 不写入缓存（skipCacheWrite: true），因为旁路结果不会被后续请求复用
 *
 * 主要导出：
 * - `BTW_PATTERN`：匹配输入框开头 `/btw` 的正则表达式
 * - `findBtwTriggerPositions()`：提取 `/btw` 关键词位置，用于高亮
 * - `runSideQuestion()`：执行旁路提问，返回回答文本和 token 用量
 * - `SideQuestionResult`：返回类型
 */

import { formatAPIError } from '../services/api/errorUtils.js'
import type { NonNullableUsage } from '../services/api/logging.js'
import type { Message, SystemAPIErrorMessage } from '../types/message.js'
import { type CacheSafeParams, runForkedAgent } from './forkedAgent.js'
import { createUserMessage, extractTextContent } from './messages.js'

/** 匹配输入框开头 `/btw`（不区分大小写，要求单词边界）的正则表达式 */
const BTW_PATTERN = /^\/btw\b/gi

/**
 * 在文本中查找 `/btw` 关键词的位置，用于 UI 高亮显示。
 * 与 thinking.ts 中的 findThinkingTriggerPositions 设计类似。
 *
 * @param text 用户输入文本
 * @returns 每个匹配项的 { word, start, end } 位置数组
 */
export function findBtwTriggerPositions(text: string): Array<{
  word: string
  start: number
  end: number
}> {
  const positions: Array<{ word: string; start: number; end: number }> = []
  const matches = text.matchAll(BTW_PATTERN)

  for (const match of matches) {
    if (match.index !== undefined) {
      positions.push({
        word: match[0],
        start: match.index,
        end: match.index + match[0].length,
      })
    }
  }

  return positions
}

/** 旁路提问的返回类型：回答文本和 token 用量 */
export type SideQuestionResult = {
  response: string | null
  usage: NonNullableUsage
}

/**
 * 使用 forked agent 执行旁路提问。
 *
 * 流程：
 * 1. 将问题包装在 system-reminder 中，注明限制条件（无工具、单轮、仅凭已知上下文）
 * 2. 调用 runForkedAgent，禁用所有工具，最多 1 轮
 * 3. 从 agent 输出 messages 中提取回答文本
 *
 * @param question 用户的旁路问题
 * @param cacheSafeParams 父上下文的缓存安全参数（用于共享 Prompt Cache）
 * @returns 回答文本和 token 用量
 */
export async function runSideQuestion({
  question,
  cacheSafeParams,
}: {
  question: string
  cacheSafeParams: CacheSafeParams
}): Promise<SideQuestionResult> {
  // 用 system-reminder 包装问题，向模型说明其角色和限制条件
  const wrappedQuestion = `<system-reminder>This is a side question from the user. You must answer this question directly in a single response.

IMPORTANT CONTEXT:
- You are a separate, lightweight agent spawned to answer this one question
- The main agent is NOT interrupted - it continues working independently in the background
- You share the conversation context but are a completely separate instance
- Do NOT reference being interrupted or what you were "previously doing" - that framing is incorrect

CRITICAL CONSTRAINTS:
- You have NO tools available - you cannot read files, run commands, search, or take any actions
- This is a one-off response - there will be no follow-up turns
- You can ONLY provide information based on what you already know from the conversation context
- NEVER say things like "Let me try...", "I'll now...", "Let me check...", or promise to take any action
- If you don't know the answer, say so - do not offer to look it up or investigate

Simply answer the question with the information you have.</system-reminder>

${question}`

  const agentResult = await runForkedAgent({
    promptMessages: [createUserMessage({ content: wrappedQuestion })],
    // 不覆盖 thinkingConfig：thinking 是 API 缓存键的一部分，
    // 与主线程配置不一致会破坏 prompt cache。
    // 快问快答场景下 adaptive thinking 开销可忽略。
    cacheSafeParams,
    canUseTool: async () => ({
      behavior: 'deny' as const,
      message: 'Side questions cannot use tools',
      decisionReason: { type: 'other' as const, reason: 'side_question' },
    }),
    querySource: 'side_question',
    forkLabel: 'side_question',
    maxTurns: 1, // 单轮，不允许工具调用循环
    // 旁路结果不会被后续请求复用，跳过缓存写入
    skipCacheWrite: true,
  })

  return {
    response: extractSideQuestionResponse(agentResult.messages),
    usage: agentResult.totalUsage,
  }
}

/**
 * 从 forked agent 的输出 messages 中提取可显示的回答字符串。
 *
 * 注意：claude.ts 对每个 content block 生成一条 AssistantMessage，而非每次 API 响应一条。
 * 当 adaptive thinking 启用时（继承自主线程以保留缓存键），thinking 响应结构为：
 *   messages[0] = assistant { content: [thinking_block] }
 *   messages[1] = assistant { content: [text_block] }
 *
 * 因此必须 flatMap 所有 assistant messages 的 content block，而非只取第一条。
 *
 * 次要失败模式（均会导致"No response received"）：
 * - 模型尝试调用 tool_use → content = [thinking, tool_use]，无 text block
 * - API 错误耗尽重试 → 只有 system api_error + user 中断消息，无 assistant 消息
 *
 * @param messages forked agent 返回的消息数组
 * @returns 回答文本，无法提取时返回 null
 */
function extractSideQuestionResponse(messages: Message[]): string | null {
  // 展开所有 assistant message 的 content block（跨多条 per-block 消息）
  const assistantBlocks = messages.flatMap(m =>
    m.type === 'assistant' ? m.message.content : [],
  )

  if (assistantBlocks.length > 0) {
    // 拼接所有 text block（正常情况最多一个，但防御性处理）
    const text = extractTextContent(assistantBlocks, '\n\n').trim()
    if (text) return text

    // 无文本——检查模型是否尝试调用工具（尽管 system-reminder 明确禁止）
    const toolUse = assistantBlocks.find(b => b.type === 'tool_use')
    if (toolUse) {
      const toolName = 'name' in toolUse ? toolUse.name : 'a tool'
      return `(The model tried to call ${toolName} instead of answering directly. Try rephrasing or ask in the main conversation.)`
    }
  }

  // 无 assistant 内容——很可能是 API 错误耗尽重试。
  // 找到第一条 system api_error 消息，展示给用户
  const apiErr = messages.find(
    (m): m is SystemAPIErrorMessage =>
      m.type === 'system' && 'subtype' in m && m.subtype === 'api_error',
  )
  if (apiErr) {
    return `(API error: ${formatAPIError(apiErr.error)})`
  }

  return null
}
