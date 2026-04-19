/**
 * "离开后摘要"生成模块
 *
 * 在 Claude Code 系统流程中的位置：
 *   用户离开后返回时 → UI 触发 generateAwaySummary()
 *   → 取最近 30 条消息 + 会话记忆内容，发起单次非流式 API 调用
 *   → 返回 1-3 句摘要，展示在"你不在时"卡片中
 *
 * 主要功能：
 *  - generateAwaySummary — 为"你不在时"卡片生成简短会话摘要
 *
 * 设计特点：
 *  - 消息窗口截断：只取最近 RECENT_MESSAGE_WINDOW（30 条）消息，避免长会话时提示词超限
 *  - 摘要格式约束：1-3 句话，先说高层任务（在做什么），再说具体下一步
 *  - 会话记忆增强：附加 getSessionMemoryContent() 作为更宽泛的背景信息
 *  - 静默失败：中止信号或任何错误均返回 null，不影响主流程
 *  - 使用 getSmallFastModel()：优先速度，不需要 thinking，不写缓存（skipCacheWrite=true）
 */

import { APIUserAbortError } from '@anthropic-ai/sdk'
import { getEmptyToolPermissionContext } from '../Tool.js'
import type { Message } from '../types/message.js'
import { logForDebugging } from '../utils/debug.js'
import {
  createUserMessage,
  getAssistantMessageText,
} from '../utils/messages.js'
import { getSmallFastModel } from '../utils/model/model.js'
import { asSystemPrompt } from '../utils/systemPromptType.js'
import { queryModelWithoutStreaming } from './api/claude.js'
import { getSessionMemoryContent } from './SessionMemory/sessionMemoryUtils.js'

// 仅取最近 N 条消息，避免长会话时提示词超限（"prompt too long" 错误）
// 30 条 ≈ ~15 轮对话，足以概括"我们在做什么"
const RECENT_MESSAGE_WINDOW = 30

/**
 * 构建发给模型的摘要生成提示词。
 *
 * @param memory - 会话记忆内容（null 表示无记忆）
 * @returns 完整提示词字符串（包含可选的记忆块 + 固定指令）
 */
function buildAwaySummaryPrompt(memory: string | null): string {
  // 若有会话记忆，前置为背景信息块；无记忆则省略
  const memoryBlock = memory
    ? `Session memory (broader context):\n${memory}\n\n`
    : ''
  return `${memoryBlock}The user stepped away and is coming back. Write exactly 1-3 short sentences. Start by stating the high-level task — what they are building or debugging, not implementation details. Next: the concrete next step. Skip status reports and commit recaps.`
}

/**
 * 为"你不在时"卡片生成简短会话摘要。
 *
 * 流程：
 *  1. 空消息列表 → 直接返回 null（无内容可摘要）
 *  2. 获取会话记忆内容（getSessionMemoryContent）作为背景增强
 *  3. 截取最近 RECENT_MESSAGE_WINDOW 条消息
 *  4. 追加摘要指令作为最后一条用户消息
 *  5. 发起非流式 API 调用（small fast model，禁用 thinking，skipCacheWrite=true）
 *  6. API 错误或异常 → 记录日志并返回 null
 *
 * @param messages - 当前会话的完整消息列表
 * @param signal - AbortSignal，用于响应用户中止
 * @returns 1-3 句摘要字符串；空列表、中止或错误时返回 null
 */
export async function generateAwaySummary(
  messages: readonly Message[],
  signal: AbortSignal,
): Promise<string | null> {
  // 空消息列表：无内容可摘要
  if (messages.length === 0) {
    return null
  }

  try {
    const memory = await getSessionMemoryContent() // 获取会话记忆（提供更宽泛的背景）
    const recent = messages.slice(-RECENT_MESSAGE_WINDOW) // 截取最近 30 条消息
    recent.push(createUserMessage({ content: buildAwaySummaryPrompt(memory) }))
    const response = await queryModelWithoutStreaming({
      messages: recent,
      systemPrompt: asSystemPrompt([]), // 空系统提示（摘要任务不需要 Claude Code 身份）
      thinkingConfig: { type: 'disabled' }, // 禁用 thinking：优先速度
      tools: [],
      signal,
      options: {
        getToolPermissionContext: async () => getEmptyToolPermissionContext(),
        model: getSmallFastModel(), // 使用最小快速模型
        toolChoice: undefined,
        isNonInteractiveSession: false,
        hasAppendSystemPrompt: false,
        agents: [],
        querySource: 'away_summary',
        mcpTools: [],
        skipCacheWrite: true, // 不写缓存：摘要是一次性的，不值得占用缓存空间
      },
    })

    if (response.isApiErrorMessage) {
      logForDebugging(
        `[awaySummary] API error: ${getAssistantMessageText(response)}`,
      )
      return null
    }
    return getAssistantMessageText(response)
  } catch (err) {
    // 用户主动中止（AbortSignal）→ 静默返回 null
    if (err instanceof APIUserAbortError || signal.aborted) {
      return null
    }
    // 其他错误（网络、解析等）→ 记录日志后静默返回 null，不影响主流程
    logForDebugging(`[awaySummary] generation failed: ${err}`)
    return null
  }
}
