/**
 * 【Hook 辅助工具模块】
 *
 * 本文件在 Claude Code 系统流中的位置：
 *   Prompt Hook / Agent Hook 执行器 → hookHelpers（当前文件）→ sessionHooks / SyntheticOutputTool
 *
 * 主要职责：
 * 1. 定义并导出 hookResponseSchema（Zod v4）：供 prompt hook 和 agent hook 共享的响应结构验证模式
 * 2. 提供 addArgumentsToPrompt：将 Hook 输入 JSON 注入 prompt 字符串（支持 $ARGUMENTS 占位符）
 * 3. 提供 createStructuredOutputTool：基于 SyntheticOutputTool 创建结构化输出工具实例
 * 4. 提供 registerStructuredOutputEnforcement：注册一个 Stop 函数 Hook，
 *    在每次 LLM 停止时校验是否调用了 SyntheticOutputTool，否则要求重试
 *
 * 设计要点：
 * - hookResponseSchema 使用 lazySchema 包装，避免循环依赖导致的初始化问题
 * - registerStructuredOutputEnforcement 超时设置为 5000ms，避免无限阻塞
 */

import { z } from 'zod/v4'
import type { Tool } from '../../Tool.js'
import {
  SYNTHETIC_OUTPUT_TOOL_NAME,
  SyntheticOutputTool,
} from '../../tools/SyntheticOutputTool/SyntheticOutputTool.js'
import { substituteArguments } from '../argumentSubstitution.js'
import { lazySchema } from '../lazySchema.js'
import type { SetAppState } from '../messageQueueManager.js'
import { hasSuccessfulToolCall } from '../messages.js'
import { addFunctionHook } from './sessionHooks.js'

/**
 * Hook 响应结构的 Zod 验证模式（prompt hook 和 agent hook 共用）。
 * 使用 lazySchema 延迟初始化，避免模块加载时的循环引用问题。
 *
 * 结构：
 * - ok: boolean      — 条件是否满足
 * - reason?: string  — 若未满足，说明原因（可选）
 */
export const hookResponseSchema = lazySchema(() =>
  z.object({
    ok: z.boolean().describe('Whether the condition was met'),
    reason: z
      .string()
      .describe('Reason, if the condition was not met')
      .optional(),
  }),
)

/**
 * 将 Hook 输入 JSON 注入 prompt 字符串。
 * 支持以下占位符格式：
 * - $ARGUMENTS       — 替换为完整 JSON 字符串
 * - $ARGUMENTS[0]    — 替换为 JSON 数组的第 0 个元素
 * - $0、$1...        — $ARGUMENTS[N] 的简写形式
 * 若 prompt 中不存在占位符，则将 JSON 追加到字符串末尾。
 *
 * @param prompt    原始 prompt 字符串
 * @param jsonInput Hook 的输入 JSON 字符串
 * @returns         注入参数后的 prompt 字符串
 */
export function addArgumentsToPrompt(
  prompt: string,
  jsonInput: string,
): string {
  // 委托给 substituteArguments 处理所有占位符替换逻辑
  return substituteArguments(prompt, jsonInput)
}

/**
 * 创建用于 Hook 响应的结构化输出工具实例。
 * 基于 SyntheticOutputTool 扩展，绑定 hookResponseSchema 作为输入验证模式。
 * 供 agent hook 和后台验证流程复用，确保 LLM 输出符合预期结构。
 *
 * @returns 配置好 hookResponseSchema 的 Tool 实例
 */
export function createStructuredOutputTool(): Tool {
  return {
    // 继承 SyntheticOutputTool 的基础配置（名称、描述等）
    ...SyntheticOutputTool,
    // 绑定 Hook 响应的 Zod 验证模式
    inputSchema: hookResponseSchema(),
    // 对应的 JSON Schema（供 LLM API 使用）
    inputJSONSchema: {
      type: 'object',
      properties: {
        ok: {
          type: 'boolean',
          description: 'Whether the condition was met',
        },
        reason: {
          type: 'string',
          description: 'Reason, if the condition was not met',
        },
      },
      required: ['ok'],
      additionalProperties: false,
    },
    // 工具提示：明确要求 LLM 在响应结束时恰好调用一次此工具
    async prompt(): Promise<string> {
      return `Use this tool to return your verification result. You MUST call this tool exactly once at the end of your response.`
    },
  }
}

/**
 * 注册结构化输出强制执行 Hook。
 * 在 Stop 事件上添加一个函数 Hook，检查消息历史中是否存在对 SyntheticOutputTool 的成功调用。
 * 若未找到，则向模型发出错误消息，要求其立即调用该工具（最长等待 5000ms）。
 *
 * 使用场景：ask.tsx、execAgentHook.ts 和后台验证流程，
 * 确保 agent/prompt hook 的 LLM 输出始终包含结构化响应。
 *
 * @param setAppState 更新应用状态的函数
 * @param sessionId   当前会话 ID，用于将 Hook 注册到正确的会话作用域
 */
export function registerStructuredOutputEnforcement(
  setAppState: SetAppState,
  sessionId: string,
): void {
  addFunctionHook(
    setAppState,
    sessionId,
    'Stop',           // 在 LLM 每次停止时触发
    '',               // 空 matcher — 适用于所有停止事件
    // 校验函数：检查消息历史中是否有 SyntheticOutputTool 的成功调用
    messages => hasSuccessfulToolCall(messages, SYNTHETIC_OUTPUT_TOOL_NAME),
    // 校验失败时发给模型的错误消息
    `You MUST call the ${SYNTHETIC_OUTPUT_TOOL_NAME} tool to complete this request. Call this tool now.`,
    { timeout: 5000 }, // 最长等待 5 秒，避免无限阻塞
  )
}
