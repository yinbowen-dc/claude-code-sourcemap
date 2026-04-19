/**
 * inboundMessages.ts — 处理 Bridge 入站用户消息的内容解析与规范化
 *
 * 在 Claude Code 系统流程中的位置：
 *   Bridge 消息处理层（bridgeMain.ts / replBridge.ts → sessionRunner.ts）
 *     └─> inboundMessages.ts（本文件）——从 SDKMessage 提取内容字段并规范化图片块
 *
 * 主要功能：
 *   - extractInboundMessageFields：从 SDKMessage 提取 content 和 uuid，过滤非 user 消息
 *   - normalizeImageBlocks：规范化图片内容块（修复 iOS/Web 客户端的 camelCase mediaType 问题）
 *
 * 图片块规范化背景（mobile-apps#5825）：
 *   iOS/web 客户端可能发送 camelCase `mediaType` 而非 snake_case `media_type`，
 *   或完全省略该字段。若不修复，错误的图片块会"毒化"会话，
 *   导致每次后续 API 调用都失败（"media_type: Field required"）。
 */
import type {
  Base64ImageSource,
  ContentBlockParam,
  ImageBlockParam,
} from '@anthropic-ai/sdk/resources/messages.mjs'
import type { UUID } from 'crypto'
import type { SDKMessage } from '../entrypoints/agentSdkTypes.js'
import { detectImageFormatFromBase64 } from '../utils/imageResizer.js'

/**
 * 从 Bridge 入站用户消息中提取 content 和 uuid 字段。
 *
 * 过滤规则（返回 undefined 表示应跳过此消息）：
 *   - msg.type 不是 'user' → 跳过
 *   - msg.message.content 不存在或为空数组 → 跳过
 *
 * 对 ContentBlockParam[] 类型的内容调用 normalizeImageBlocks 规范化图片块。
 * uuid 字段为可选（部分 bridge 客户端可能不发送）。
 *
 * Process an inbound user message from the bridge, extracting content
 * and UUID for enqueueing.
 */
export function extractInboundMessageFields(
  msg: SDKMessage,
):
  | { content: string | Array<ContentBlockParam>; uuid: UUID | undefined }
  | undefined {
  if (msg.type !== 'user') return undefined // 仅处理 user 类型消息
  const content = msg.message?.content
  if (!content) return undefined // 无内容，跳过
  if (Array.isArray(content) && content.length === 0) return undefined // 空数组，跳过

  const uuid =
    'uuid' in msg && typeof msg.uuid === 'string'
      ? (msg.uuid as UUID)
      : undefined // uuid 为可选字段

  return {
    content: Array.isArray(content) ? normalizeImageBlocks(content) : content, // 规范化图片块
    uuid,
  }
}

/**
 * 规范化图片内容块，修复 bridge 客户端的 camelCase mediaType 问题。
 *
 * 问题根因（mobile-apps#5825）：
 *   iOS/web 客户端可能发送 `mediaType`（camelCase）而非 `media_type`（snake_case），
 *   或完全省略该字段。不带 media_type 的图片块会毒化整个会话，
 *   导致每次 API 调用都失败（"media_type: Field required"）。
 *
 * 快速路径：若没有格式错误的图片块，直接返回原数组引用（零内存分配）。
 * 修复路径：
 *   1. 从 source.mediaType（camelCase）读取 mediaType
 *   2. 若 mediaType 也缺失，则通过 detectImageFormatFromBase64 自动检测
 *   3. 重建规范的 ImageBlockParam（snake_case media_type）
 *
 * Normalize image content blocks from bridge clients.
 */
export function normalizeImageBlocks(
  blocks: Array<ContentBlockParam>,
): Array<ContentBlockParam> {
  if (!blocks.some(isMalformedBase64Image)) return blocks // 无格式问题，直接返回（快速路径）

  return blocks.map(block => {
    if (!isMalformedBase64Image(block)) return block // 正常块不处理
    const src = block.source as unknown as Record<string, unknown>
    const mediaType =
      typeof src.mediaType === 'string' && src.mediaType
        ? src.mediaType // 优先使用 camelCase mediaType
        : detectImageFormatFromBase64(block.source.data) // 回退到自动检测
    return {
      ...block,
      source: {
        type: 'base64' as const,
        media_type: mediaType as Base64ImageSource['media_type'], // 规范化为 snake_case
        data: block.source.data,
      },
    }
  })
}

/** 判断一个内容块是否为格式错误的 base64 图片块（缺少 media_type 字段） */
function isMalformedBase64Image(
  block: ContentBlockParam,
): block is ImageBlockParam & { source: Base64ImageSource } {
  if (block.type !== 'image' || block.source?.type !== 'base64') return false
  return !(block.source as unknown as Record<string, unknown>).media_type
}
