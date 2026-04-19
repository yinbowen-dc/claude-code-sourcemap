/**
 * imageValidation.ts — API 发送前图像大小校验模块
 *
 * 【在 Claude Code 系统流程中的位置】
 * 本文件是消息发往 Anthropic API 前的最后一道安全防线。
 * 即使上游的 imageResizer.ts 已尽力压缩图像，本模块仍会在
 * API 调用层对所有消息中的 base64 图像再次校验大小。
 *
 * 调用时机：消息构建完成 → validateImagesForAPI() → API 请求
 *
 * 设计原则：
 *   - 轻量：仅检查 base64 字符串的 .length，无需解码；
 *   - 聚合：一次性收集所有超限图像，抛出包含完整信息的 ImageSizeError；
 *   - 分析：对每个超限图像上报 logEvent，便于监控和问题排查。
 *
 * 注意：API 的 5MB 限制针对的是 base64 编码后的字符串长度，
 *       而非原始字节数（base64 会使大小增加约 33%）。
 */

import { API_IMAGE_MAX_BASE64_SIZE } from '../constants/apiLimits.js'
import { logEvent } from '../services/analytics/index.js'
import { formatFileSize } from './format.js'

/**
 * 超限图像的位置与大小信息。
 * index 从 1 开始计数，对应消息中所有 base64 图像块的顺序编号。
 */
export type OversizedImage = {
  index: number  // 图像在所有消息中的全局序号（从 1 开始）
  size: number   // base64 字符串长度（字节）
}

/**
 * 当一个或多个图像超过 API 大小限制时抛出的错误。
 *
 * 错误消息根据超限图像数量生成：
 *   - 单张：描述该张图像的大小及限制；
 *   - 多张：列出所有超限图像的序号和大小。
 *
 * 继承自 Error 便于调用方使用 instanceof 精确捕获。
 */
export class ImageSizeError extends Error {
  constructor(oversizedImages: OversizedImage[], maxSize: number) {
    let message: string
    const firstImage = oversizedImages[0]
    if (oversizedImages.length === 1 && firstImage) {
      // 单张超限：直接描述该图像的大小
      message =
        `Image base64 size (${formatFileSize(firstImage.size)}) exceeds API limit (${formatFileSize(maxSize)}). ` +
        `Please resize the image before sending.`
    } else {
      // 多张超限：列举所有图像的序号和大小
      message =
        `${oversizedImages.length} images exceed the API limit (${formatFileSize(maxSize)}): ` +
        oversizedImages
          .map(img => `Image ${img.index}: ${formatFileSize(img.size)}`)
          .join(', ') +
        `. Please resize these images before sending.`
    }
    super(message)
    this.name = 'ImageSizeError'
  }
}

/**
 * 类型守卫：检查一个未知块是否为 base64 图像块。
 *
 * 采用严格的结构验证（非空对象 + 嵌套字段类型检查），
 * 避免对不符合预期结构的消息块产生误判。
 *
 * @param block - 待检查的任意值
 * @returns 若为 base64 图像块则返回 true，否则 false
 */
function isBase64ImageBlock(
  block: unknown,
): block is { type: 'image'; source: { type: 'base64'; data: string } } {
  if (typeof block !== 'object' || block === null) return false
  const b = block as Record<string, unknown>
  if (b.type !== 'image') return false                          // 非图像块
  if (typeof b.source !== 'object' || b.source === null) return false
  const source = b.source as Record<string, unknown>
  // source.type 必须为 'base64'，且 data 必须为字符串
  return source.type === 'base64' && typeof source.data === 'string'
}

/**
 * 验证消息数组中所有图像的 base64 大小是否满足 API 限制。
 *
 * 这是 API 调用边界处的安全网，用于捕获上游处理遗漏的超限图像。
 *
 * 支持两种消息格式：
 *   - 封装格式：{ type: 'user', message: { role, content } }（内部 UserMessage 类型）
 *   - 原始格式：{ role, content }（MessageParam 类型）——当前仅处理封装格式
 *
 * 遍历逻辑：
 *   1. 仅检查 type === 'user' 的消息（助手消息不携带用户上传图像）；
 *   2. 仅检查数组 content（字符串 content 不含图像块）；
 *   3. 对每个 base64 图像块检查字符串长度。
 *
 * @param messages - 待验证的消息数组（可以是任意 unknown[]，函数内部做类型收窄）
 * @throws ImageSizeError 若存在任何超限图像
 */
export function validateImagesForAPI(messages: unknown[]): void {
  const oversizedImages: OversizedImage[] = [] // 收集所有超限图像
  let imageIndex = 0 // 全局图像序号（从 1 开始，每遇到图像块自增）

  for (const msg of messages) {
    if (typeof msg !== 'object' || msg === null) continue

    const m = msg as Record<string, unknown>

    // 处理封装消息格式：{ type: 'user', message: { role, content } }
    // 仅校验用户消息，因为只有用户消息可能携带上传的图像
    if (m.type !== 'user') continue

    const innerMessage = m.message as Record<string, unknown> | undefined
    if (!innerMessage) continue

    const content = innerMessage.content
    // 字符串 content 不含图像块；非数组类型跳过
    if (typeof content === 'string' || !Array.isArray(content)) continue

    for (const block of content) {
      if (isBase64ImageBlock(block)) {
        imageIndex++ // 每遇到一个图像块，全局序号加一
        // 直接检查 base64 字符串长度（API 限制的是编码后的字节数，非原始大小）
        const base64Size = block.source.data.length
        if (base64Size > API_IMAGE_MAX_BASE64_SIZE) {
          // 上报分析事件，记录超限大小，便于监控
          logEvent('tengu_image_api_validation_failed', {
            base64_size_bytes: base64Size,
            max_bytes: API_IMAGE_MAX_BASE64_SIZE,
          })
          oversizedImages.push({ index: imageIndex, size: base64Size })
        }
      }
    }
  }

  // 若存在超限图像，抛出包含完整信息的错误
  if (oversizedImages.length > 0) {
    throw new ImageSizeError(oversizedImages, API_IMAGE_MAX_BASE64_SIZE)
  }
}
