/**
 * 消息指纹（Fingerprint）计算模块。
 *
 * 在 Claude Code 系统中，该模块为会话消息计算唯一指纹哈希，
 * 用于后端校验与消息去重：
 * - 使用固定盐值（FINGERPRINT_SALT）与消息内容生成 SHA256 哈希
 * - 盐值须与后端校验逻辑完全一致，否则指纹验证失败
 * - 从首条用户消息提取文本内容作为指纹计算的输入
 * - 指纹结果用于防止重放攻击与重复提交检测
 */
/**
 * 消息指纹（Fingerprint）计算模块。
 *
 * 在 Claude Code 系统中，该模块为会话消息计算唯一指纹哈希，
 * 用于后端校验与消息去重：
 * - 使用固定盐值（FINGERPRINT_SALT）与消息内容生成 SHA256 哈希
 * - 盐值须与后端校验逻辑完全一致，否则指纹验证失败
 * - 从首条用户消息提取文本内容作为指纹计算的输入
 * - 指纹结果用于防止重放攻击与重复提交检测
 */
import { createHash } from 'crypto'
import type { AssistantMessage, UserMessage } from '../types/message.js'

/**
 * Hardcoded salt from backend validation.
 * Must match exactly for fingerprint validation to pass.
 */
export const FINGERPRINT_SALT = '59cf53e54c78'

/**
 * Extracts text content from the first user message.
 *
 * @param messages - Array of internal message types
 * @returns First text content, or empty string if not found
 */
export function extractFirstMessageText(
  messages: (UserMessage | AssistantMessage)[],
): string {
  const firstUserMessage = messages.find(msg => msg.type === 'user')
  if (!firstUserMessage) {
    return ''
  }

  const content = firstUserMessage.message.content

  if (typeof content === 'string') {
    return content
  }

  if (Array.isArray(content)) {
    const textBlock = content.find(block => block.type === 'text')
    if (textBlock && textBlock.type === 'text') {
      return textBlock.text
    }
  }

  return ''
}

/**
 * Computes 3-character fingerprint for Claude Code attribution.
 * Algorithm: SHA256(SALT + msg[4] + msg[7] + msg[20] + version)[:3]
 * IMPORTANT: Do not change this method without careful coordination with
 * 1P and 3P (Bedrock, Vertex, Azure) APIs.
 *
 * @param messageText - First user message text content
 * @param version - Version string (from MACRO.VERSION)
 * @returns 3-character hex fingerprint
 */
export function computeFingerprint(
  messageText: string,
  version: string,
): string {
  // Extract chars at indices [4, 7, 20], use "0" if index not found
  const indices = [4, 7, 20]
  const chars = indices.map(i => messageText[i] || '0').join('')

  const fingerprintInput = `${FINGERPRINT_SALT}${chars}${version}`

  // SHA256 hash, return first 3 hex chars
  const hash = createHash('sha256').update(fingerprintInput).digest('hex')
  return hash.slice(0, 3)
}

/**
 * Computes fingerprint from the first user message.
 *
 * @param messages - Array of normalized messages
 * @returns 3-character hex fingerprint
 */
export function computeFingerprintFromMessages(
  messages: (UserMessage | AssistantMessage)[],
): string {
  const firstMessageText = extractFirstMessageText(messages)
  return computeFingerprint(firstMessageText, MACRO.VERSION)
}
