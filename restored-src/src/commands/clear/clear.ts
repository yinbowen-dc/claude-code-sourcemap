/**
 * /clear 命令的最小化执行适配器模块。
 *
 * 在 Claude Code 的命令分层架构中，此文件作为 /clear 命令的"轻量执行层"，
 * 将实际的繁重清理逻辑委托给 conversation.ts 中的 clearConversation 函数，
 * 自身只负责类型适配和空返回值的构造，确保懒加载时加载开销最小化。
 *
 * 数据流：LocalCommandCall → clearConversation(context) → { type: 'text', value: '' }
 */
import type { LocalCommandCall } from '../../types/command.js'
import { clearConversation } from './conversation.js'

/**
 * /clear 命令的 call 函数实现。
 *
 * 作为命令框架与 clearConversation 之间的薄适配层：
 * - 忽略用户输入的参数（/clear 无需参数）
 * - 等待 clearConversation 完成全部清理操作
 * - 返回空文本，不向 UI 输出任何可见内容（由 clearConversation 内部处理提示）
 *
 * @param _ 用户输入参数（忽略）
 * @param context 命令执行上下文，包含消息状态、AppState 等清理所需的全部依赖
 */
export const call: LocalCommandCall = async (_, context) => {
  // 委托给 clearConversation 执行完整的会话重置逻辑
  await clearConversation(context)
  // 返回空文本：/clear 的视觉反馈由 clearConversation 内部注入，此处不重复输出
  return { type: 'text', value: '' }
}
