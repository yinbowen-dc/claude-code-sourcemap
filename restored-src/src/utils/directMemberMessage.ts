/**
 * 直接成员消息解析与发送模块（directMemberMessage.ts）
 *
 * 【在系统流程中的位置】
 * 该模块位于多智能体（Multi-Agent）通信层，被 REPL 输入处理器调用。
 * 当用户在团队上下文中输入 `@agent-name message` 语法时，
 * 该模块负责解析收件人和消息内容，并将消息写入对应 Agent 的邮箱（mailbox）。
 *
 * 【主要功能】
 * - parseDirectMemberMessage()：解析 `@agent-name message` 语法，提取收件人和消息
 * - sendDirectMemberMessage()：将消息写入目标 Agent 邮箱，绕过 AI 模型直接传递
 *
 * 【数据流向】
 * 用户输入 → parseDirectMemberMessage() → sendDirectMemberMessage() → writeToMailbox()
 */
import type { AppState } from '../state/AppState.js'

/**
 * 解析 `@agent-name message` 格式的直接团队成员消息语法。
 *
 * 【流程说明】
 * 1. 使用正则匹配字符串开头的 `@<名称> <消息>` 模式
 * 2. 提取 recipientName（字母、数字、连字符组合）和 message（多行支持）
 * 3. 对消息内容做 trim 处理，确保非空
 * 4. 任何步骤失败返回 null，表示不是直接消息语法
 *
 * @param input  用户输入的原始字符串
 * @returns      成功时返回 { recipientName, message }，否则返回 null
 */
export function parseDirectMemberMessage(input: string): {
  recipientName: string
  message: string
} | null {
  // 正则：^ 开头，@ 后跟名称（字母/数字/连字符），空格，然后是消息内容（支持多行）
  const match = input.match(/^@([\w-]+)\s+(.+)$/s)
  if (!match) return null

  // 从正则捕获组中提取收件人名称和消息内容
  const [, recipientName, message] = match
  if (!recipientName || !message) return null

  // 去除消息首尾空白，确保消息有实际内容
  const trimmedMessage = message.trim()
  if (!trimmedMessage) return null

  return { recipientName, message: trimmedMessage }
}

/**
 * 直接消息发送结果的联合类型：
 * - success: true 时包含收件人名称
 * - success: false 时包含错误类型及可选的收件人名称
 */
export type DirectMessageResult =
  | { success: true; recipientName: string }
  | {
      success: false
      error: 'no_team_context' | 'unknown_recipient'
      recipientName?: string
    }

/**
 * 写入邮箱的函数签名类型：
 * 接收收件人名称、消息对象（含发件人/内容/时间戳）和团队名称。
 */
type WriteToMailboxFn = (
  recipientName: string,
  message: { from: string; text: string; timestamp: string },
  teamName: string,
) => Promise<void>

/**
 * 向团队成员发送直接消息，绕过 AI 模型直接写入目标 Agent 邮箱。
 *
 * 【流程说明】
 * 1. 检查是否存在团队上下文和邮箱写入函数，缺失则返回 no_team_context 错误
 * 2. 在 teamContext.teammates 中按名称查找目标成员
 * 3. 找不到目标成员时返回 unknown_recipient 错误（附带 recipientName 供错误提示）
 * 4. 调用 writeToMailbox 写入消息（包含 from='user'、内容和 ISO 时间戳）
 * 5. 成功返回 { success: true, recipientName }
 *
 * @param recipientName   目标 Agent 的名称
 * @param message         要发送的消息文本
 * @param teamContext     当前会话的团队上下文（含队友列表和团队名称）
 * @param writeToMailbox  将消息写入邮箱的函数（可选，未提供时视为无团队上下文）
 */
export async function sendDirectMemberMessage(
  recipientName: string,
  message: string,
  teamContext: AppState['teamContext'],
  writeToMailbox?: WriteToMailboxFn,
): Promise<DirectMessageResult> {
  // 无团队上下文或无邮箱写入能力，直接返回失败
  if (!teamContext || !writeToMailbox) {
    return { success: false, error: 'no_team_context' }
  }

  // 在队友列表中按名称查找目标成员（Object.values 遍历所有队友）
  const member = Object.values(teamContext.teammates ?? {}).find(
    t => t.name === recipientName,
  )

  // 未找到目标成员，返回 unknown_recipient 错误（附带名称以便错误提示）
  if (!member) {
    return { success: false, error: 'unknown_recipient', recipientName }
  }

  // 写入邮箱：消息来源标记为 'user'，附带当前 ISO 时间戳
  await writeToMailbox(
    recipientName,
    {
      from: 'user',
      text: message,
      timestamp: new Date().toISOString(),
    },
    teamContext.teamName,
  )

  // 发送成功，返回收件人名称
  return { success: true, recipientName }
}
