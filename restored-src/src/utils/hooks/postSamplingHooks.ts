/**
 * 【采样后 Hook 模块】
 *
 * 本文件在 Claude Code 系统流中的位置：
 *   模型采样完成 → executePostSamplingHooks（当前文件）→ skillImprovement / 其他后处理逻辑
 *
 * 主要职责：
 * 1. 定义 REPLHookContext 类型：封装会话消息历史、系统提示、用户/系统上下文等信息
 * 2. 定义 PostSamplingHook 类型：描述采样后 Hook 的函数签名（接收上下文，返回 Promise<void> 或 void）
 * 3. 维护一个内部 Hook 注册表（postSamplingHooks 数组），支持多个 Hook 顺序执行
 * 4. 提供 registerPostSamplingHook / clearPostSamplingHooks / executePostSamplingHooks 三个管理函数
 *
 * 设计要点：
 * - 此模块是纯程序化 API，不暴露于 settings.json（不是用户可配置的 Hook）
 * - executePostSamplingHooks 对每个 Hook 单独捕获错误，确保某个 Hook 抛出异常不影响后续 Hook 执行
 * - clearPostSamplingHooks 通过 .length = 0 清空数组，避免重新分配内存（测试间隔离用途）
 */

import type { QuerySource } from '../../constants/querySource.js'
import type { ToolUseContext } from '../../Tool.js'
import type { Message } from '../../types/message.js'
import { toError } from '../errors.js'
import { logError } from '../log.js'
import type { SystemPrompt } from '../systemPromptType.js'

// 采样后 Hook 尚未暴露于 settings.json 配置，仅供程序内部调用

/**
 * REPL Hook 的通用上下文类型（供采样后 Hook 和停止 Hook 共用）。
 * 封装了执行 Hook 所需的完整会话状态。
 */
export type REPLHookContext = {
  messages: Message[]         // 完整消息历史，包含 assistant 响应
  systemPrompt: SystemPrompt
  userContext: { [k: string]: string }
  systemContext: { [k: string]: string }
  toolUseContext: ToolUseContext
  querySource?: QuerySource
}

/**
 * 采样后 Hook 的函数类型。
 * 接收 REPLHookContext，异步或同步执行后处理逻辑（如技能改进检测）。
 */
export type PostSamplingHook = (
  context: REPLHookContext,
) => Promise<void> | void

// 模块级 Hook 注册表：存储所有已注册的采样后 Hook
const postSamplingHooks: PostSamplingHook[] = []

/**
 * 注册一个采样后 Hook。
 * 该 Hook 将在每次模型采样完成后被调用。
 * 这是一个内部 API，不通过 settings.json 暴露给用户。
 *
 * @param hook 要注册的 PostSamplingHook 函数
 */
export function registerPostSamplingHook(hook: PostSamplingHook): void {
  // 将 Hook 追加到注册表末尾，按注册顺序依次执行
  postSamplingHooks.push(hook)
}

/**
 * 清除所有已注册的采样后 Hook（主要用于测试隔离）。
 * 通过将数组长度置零来清空，不重新分配内存。
 */
export function clearPostSamplingHooks(): void {
  // 原地清空：避免重新分配内存，同时保持对原数组的引用有效
  postSamplingHooks.length = 0
}

/**
 * 顺序执行所有已注册的采样后 Hook。
 * 每个 Hook 单独捕获错误：某个 Hook 失败不会阻断后续 Hook 的执行。
 *
 * @param messages       完整消息历史（含 assistant 响应）
 * @param systemPrompt   当前会话的系统提示
 * @param userContext    用户级上下文键值对
 * @param systemContext  系统级上下文键值对
 * @param toolUseContext 工具使用上下文（含 setAppState 等）
 * @param querySource    请求来源标识（如 'repl_main_thread'），可选
 */
export async function executePostSamplingHooks(
  messages: Message[],
  systemPrompt: SystemPrompt,
  userContext: { [k: string]: string },
  systemContext: { [k: string]: string },
  toolUseContext: ToolUseContext,
  querySource?: QuerySource,
): Promise<void> {
  // 构建统一的上下文对象，传递给所有 Hook
  const context: REPLHookContext = {
    messages,
    systemPrompt,
    userContext,
    systemContext,
    toolUseContext,
    querySource,
  }

  // 顺序执行每个 Hook，单独捕获错误防止级联失败
  for (const hook of postSamplingHooks) {
    try {
      await hook(context)
    } catch (error) {
      // Hook 错误仅记录日志，不向上抛出（避免影响主流程）
      logError(toError(error))
    }
  }
}
