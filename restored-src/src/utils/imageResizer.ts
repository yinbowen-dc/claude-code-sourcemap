/**
 * imageResizer.ts — 图像压缩与缩放工具模块
 *
 * 【在 Claude Code 系统流程中的位置】
 * 本文件位于工具层（utils），是图像处理管道的核心。当用户向 Claude 发送图片（粘贴或文件读取）时，
 * 消息在被发往 Anthropic API 之前，必须满足 API 的尺寸与大小限制。本模块负责：
 *   1. 将超出像素尺寸上限的图像缩小到 IMAGE_MAX_WIDTH × IMAGE_MAX_HEIGHT 以内；
 *   2. 将超出字节大小上限的图像进行有损/无损压缩；
 *   3. 在 sharp 原生模块不可用时提供回退逻辑，并上报分析事件；
 *   4. 提供 base64 编码的图像格式检测（通过魔数字节）。
 *
 * 调用链：FileReadTool → imageResizer（缓冲区级别）
 *         消息发送前 → maybeResizeAndDownsampleImageBlock（块级别）
 *         AgentTool  → compressImageBlock（按 token 上限压缩）
 */

import type {
  Base64ImageSource,
  ImageBlockParam,
} from '@anthropic-ai/sdk/resources/messages.mjs'
import {
  API_IMAGE_MAX_BASE64_SIZE,
  IMAGE_MAX_HEIGHT,
  IMAGE_MAX_WIDTH,
  IMAGE_TARGET_RAW_SIZE,
} from '../constants/apiLimits.js'
import { logEvent } from '../services/analytics/index.js'
import {
  getImageProcessor,
  type SharpFunction,
  type SharpInstance,
} from '../tools/FileReadTool/imageProcessor.js'
import { logForDebugging } from './debug.js'
import { errorMessage } from './errors.js'
import { formatFileSize } from './format.js'
import { logError } from './log.js'

// 图像媒体类型别名，仅支持 API 允许的四种格式
type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'

// 错误类型常量——用于分析上报（数字类型，符合 logEvent 的限制）
const ERROR_TYPE_MODULE_LOAD = 1   // sharp/native 模块加载失败
const ERROR_TYPE_PROCESSING = 2    // 图像格式解析或数据损坏
const ERROR_TYPE_UNKNOWN = 3       // 未知错误
const ERROR_TYPE_PIXEL_LIMIT = 4   // 像素数超限
const ERROR_TYPE_MEMORY = 5        // 内存不足
const ERROR_TYPE_TIMEOUT = 6       // 处理超时
const ERROR_TYPE_VIPS = 7          // libvips 内部错误
const ERROR_TYPE_PERMISSION = 8    // 文件权限错误

/**
 * 图像缩放失败且图像超过 API 限制时抛出的自定义错误。
 * 与普通 Error 区分，便于上层调用方精确捕获并展示友好提示。
 */
export class ImageResizeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ImageResizeError'
  }
}

/**
 * 将图像处理错误分类为数字代码，用于分析聚合。
 *
 * 优先使用 Node.js 标准 error.code 字段（更可靠），
 * 对于 sharp 等不暴露 code 的库则回退到消息字符串匹配。
 *
 * @param error - 捕获到的未知错误对象
 * @returns 对应的错误类型常量（1-8）
 */
function classifyImageError(error: unknown): number {
  // 优先检查 Node.js 标准错误码（比字符串匹配更可靠）
  if (error instanceof Error) {
    const errorWithCode = error as Error & { code?: string }
    if (
      errorWithCode.code === 'MODULE_NOT_FOUND' ||
      errorWithCode.code === 'ERR_MODULE_NOT_FOUND' ||
      errorWithCode.code === 'ERR_DLOPEN_FAILED'
    ) {
      // native 模块（如 sharp 的 .node 文件）加载失败
      return ERROR_TYPE_MODULE_LOAD
    }
    if (errorWithCode.code === 'EACCES' || errorWithCode.code === 'EPERM') {
      // 无访问权限
      return ERROR_TYPE_PERMISSION
    }
    if (errorWithCode.code === 'ENOMEM') {
      // 系统内存不足
      return ERROR_TYPE_MEMORY
    }
  }

  // 对没有 code 字段的错误，回退到消息字符串匹配
  // 注意：sharp 不暴露错误码，只能靠消息内容判断
  const message = errorMessage(error)

  // 原生包装器报告的模块加载错误
  if (message.includes('Native image processor module not available')) {
    return ERROR_TYPE_MODULE_LOAD
  }

  // Sharp/vips 处理错误（格式检测、数据损坏等）
  if (
    message.includes('unsupported image format') ||
    message.includes('Input buffer') ||
    message.includes('Input file is missing') ||
    message.includes('Input file has corrupt header') ||
    message.includes('corrupt header') ||
    message.includes('corrupt image') ||
    message.includes('premature end') ||
    message.includes('zlib: data error') ||
    message.includes('zero width') ||
    message.includes('zero height')
  ) {
    return ERROR_TYPE_PROCESSING
  }

  // sharp/vips 报告的像素数/尺寸超限错误
  if (
    message.includes('pixel limit') ||
    message.includes('too many pixels') ||
    message.includes('exceeds pixel') ||
    message.includes('image dimensions')
  ) {
    return ERROR_TYPE_PIXEL_LIMIT
  }

  // 内存分配失败
  if (
    message.includes('out of memory') ||
    message.includes('Cannot allocate') ||
    message.includes('memory allocation')
  ) {
    return ERROR_TYPE_MEMORY
  }

  // 超时错误
  if (message.includes('timeout') || message.includes('timed out')) {
    return ERROR_TYPE_TIMEOUT
  }

  // libvips 特有错误（VipsJpeg、VipsPng、VipsWebp 等）
  if (message.includes('Vips')) {
    return ERROR_TYPE_VIPS
  }

  return ERROR_TYPE_UNKNOWN
}

/**
 * 计算字符串的简单数字哈希，用于分析分组（不能直接上报原始错误消息，故哈希化）。
 * 采用 djb2 算法，返回 32 位无符号整数。
 *
 * @param str - 待哈希的字符串
 * @returns 0 ~ 2^32-1 范围内的整数
 */
function hashString(str: string): number {
  let hash = 5381
  for (let i = 0; i < str.length; i++) {
    // djb2: hash = hash * 33 + charCode（位运算保持 32 位）
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0
  }
  // >>> 0 确保返回无符号整数
  return hash >>> 0
}

/** 图像尺寸信息，记录原始尺寸与展示尺寸，供坐标映射使用 */
export type ImageDimensions = {
  originalWidth?: number
  originalHeight?: number
  displayWidth?: number
  displayHeight?: number
}

/** 缩放结果，包含处理后的缓冲区、媒体类型及可选的尺寸信息 */
export interface ResizeResult {
  buffer: Buffer
  mediaType: string
  dimensions?: ImageDimensions
}

/** 图像压缩操作的上下文，汇集所有需要的参数，避免反复传参 */
interface ImageCompressionContext {
  imageBuffer: Buffer
  metadata: { width?: number; height?: number; format?: string }
  format: string
  maxBytes: number
  originalSize: number
}

/** 压缩结果，包含 base64 字符串、媒体类型及原始字节大小 */
interface CompressedImageResult {
  base64: string
  mediaType: Base64ImageSource['media_type']
  originalSize: number
}

/**
 * 对图像缓冲区进行"按需缩放与降采样"处理。
 *
 * 从 FileReadTool 的 readImage 函数中提取，处理流程如下：
 *   1. 空缓冲区立即抛出错误（API 不接受空图像）；
 *   2. 加载 sharp 原生模块读取元数据；
 *   3. 若原图已满足尺寸与大小要求，直接返回；
 *   4. 若仅大小超标（尺寸合规），先尝试 PNG/JPEG 压缩；
 *   5. 若尺寸超标，先裁剪到最大尺寸，再尝试压缩；
 *   6. sharp 异常时：检测魔数格式，判断能否直接透传，否则抛出 ImageResizeError。
 *
 * @param imageBuffer  - 原始图像二进制数据
 * @param originalSize - 原始文件字节数（用于分析上报）
 * @param ext          - 文件扩展名（如 'png'、'jpeg'），作为格式回退
 * @returns 包含处理后缓冲区、媒体类型及尺寸信息的 ResizeResult
 * @throws ImageResizeError 当图像超限且压缩失败时
 */
export async function maybeResizeAndDownsampleImageBuffer(
  imageBuffer: Buffer,
  originalSize: number,
  ext: string,
): Promise<ResizeResult> {
  if (imageBuffer.length === 0) {
    // 空缓冲区会让 sharp 抛出 "Unable to determine image format"，
    // 回退路径的大小检查（0 ≤ 5MB）会放行并产生空 base64，API 会拒绝。
    // 提前检测并给出友好错误。
    throw new ImageResizeError('Image file is empty (0 bytes)')
  }
  try {
    const sharp = await getImageProcessor()
    const image = sharp(imageBuffer)
    const metadata = await image.metadata() // 读取宽度、高度、格式等元数据

    const mediaType = metadata.format ?? ext
    // 将 "jpg" 标准化为 "jpeg" 以符合 MIME 类型规范
    const normalizedMediaType = mediaType === 'jpg' ? 'jpeg' : mediaType

    // 若元数据中无法获得尺寸信息
    if (!metadata.width || !metadata.height) {
      if (originalSize > IMAGE_TARGET_RAW_SIZE) {
        // 创建全新 sharp 实例进行压缩（不复用旧实例，见下方重要说明）
        const compressedBuffer = await sharp(imageBuffer)
          .jpeg({ quality: 80 })
          .toBuffer()
        return { buffer: compressedBuffer, mediaType: 'jpeg' }
      }
      // 无法获取尺寸且大小合规，直接返回原始缓冲区
      return { buffer: imageBuffer, mediaType: normalizedMediaType }
    }

    // 到此处，宽高已确定
    const originalWidth = metadata.width
    const originalHeight = metadata.height

    // 在保持宽高比的前提下计算目标尺寸
    let width = originalWidth
    let height = originalHeight

    // 若原始文件大小和尺寸均在限制内，直接返回（无需任何处理）
    if (
      originalSize <= IMAGE_TARGET_RAW_SIZE &&
      width <= IMAGE_MAX_WIDTH &&
      height <= IMAGE_MAX_HEIGHT
    ) {
      return {
        buffer: imageBuffer,
        mediaType: normalizedMediaType,
        dimensions: {
          originalWidth,
          originalHeight,
          displayWidth: width,
          displayHeight: height,
        },
      }
    }

    // 判断是否需要缩小尺寸
    const needsDimensionResize =
      width > IMAGE_MAX_WIDTH || height > IMAGE_MAX_HEIGHT
    const isPng = normalizedMediaType === 'png'

    // 若尺寸合规但文件偏大，先尝试压缩（保留全分辨率）
    if (!needsDimensionResize && originalSize > IMAGE_TARGET_RAW_SIZE) {
      // 对 PNG 先尝试无损压缩，保留透明通道
      if (isPng) {
        // 每次压缩都创建新的 sharp 实例（防止 native 模块复用 bug）
        const pngCompressed = await sharp(imageBuffer)
          .png({ compressionLevel: 9, palette: true })
          .toBuffer()
        if (pngCompressed.length <= IMAGE_TARGET_RAW_SIZE) {
          return {
            buffer: pngCompressed,
            mediaType: 'png',
            dimensions: {
              originalWidth,
              originalHeight,
              displayWidth: width,
              displayHeight: height,
            },
          }
        }
      }
      // 依次尝试不同 JPEG 质量（有损但体积小得多）
      for (const quality of [80, 60, 40, 20]) {
        // 每次都创建新实例，防止格式转换未生效的 bug
        const compressedBuffer = await sharp(imageBuffer)
          .jpeg({ quality })
          .toBuffer()
        if (compressedBuffer.length <= IMAGE_TARGET_RAW_SIZE) {
          return {
            buffer: compressedBuffer,
            mediaType: 'jpeg',
            dimensions: {
              originalWidth,
              originalHeight,
              displayWidth: width,
              displayHeight: height,
            },
          }
        }
      }
      // 纯压缩不够，继续执行下方的尺寸缩小逻辑
    }

    // 按宽高比约束尺寸（先按宽度限制，再按高度限制）
    if (width > IMAGE_MAX_WIDTH) {
      height = Math.round((height * IMAGE_MAX_WIDTH) / width)
      width = IMAGE_MAX_WIDTH
    }

    if (height > IMAGE_MAX_HEIGHT) {
      width = Math.round((width * IMAGE_MAX_HEIGHT) / height)
      height = IMAGE_MAX_HEIGHT
    }

    // 重要：每次操作都必须创建全新的 sharp(imageBuffer) 实例。
    // native image-processor-napi 模块在 toBuffer() 后复用同一实例时
    // 不会正确应用格式转换，导致所有压缩尝试均返回相同的大小。
    logForDebugging(`Resizing to ${width}x${height}`)
    const resizedImageBuffer = await sharp(imageBuffer)
      .resize(width, height, {
        fit: 'inside',         // 保持宽高比，不超出指定框
        withoutEnlargement: true, // 不放大小图
      })
      .toBuffer()

    // 缩小后若仍然偏大，再次尝试压缩
    if (resizedImageBuffer.length > IMAGE_TARGET_RAW_SIZE) {
      // PNG 先尝试调色板压缩，保留透明度
      if (isPng) {
        const pngCompressed = await sharp(imageBuffer)
          .resize(width, height, {
            fit: 'inside',
            withoutEnlargement: true,
          })
          .png({ compressionLevel: 9, palette: true })
          .toBuffer()
        if (pngCompressed.length <= IMAGE_TARGET_RAW_SIZE) {
          return {
            buffer: pngCompressed,
            mediaType: 'png',
            dimensions: {
              originalWidth,
              originalHeight,
              displayWidth: width,
              displayHeight: height,
            },
          }
        }
      }

      // 依次尝试降低 JPEG 质量
      for (const quality of [80, 60, 40, 20]) {
        const compressedBuffer = await sharp(imageBuffer)
          .resize(width, height, {
            fit: 'inside',
            withoutEnlargement: true,
          })
          .jpeg({ quality })
          .toBuffer()
        if (compressedBuffer.length <= IMAGE_TARGET_RAW_SIZE) {
          return {
            buffer: compressedBuffer,
            mediaType: 'jpeg',
            dimensions: {
              originalWidth,
              originalHeight,
              displayWidth: width,
              displayHeight: height,
            },
          }
        }
      }
      // 上述策略全部失败，缩小到最多 1000px 宽并以最低质量压缩
      const smallerWidth = Math.min(width, 1000)
      const smallerHeight = Math.round(
        (height * smallerWidth) / Math.max(width, 1),
      )
      logForDebugging('Still too large, compressing with JPEG')
      const compressedBuffer = await sharp(imageBuffer)
        .resize(smallerWidth, smallerHeight, {
          fit: 'inside',
          withoutEnlargement: true,
        })
        .jpeg({ quality: 20 }) // 最激进压缩
        .toBuffer()
      logForDebugging(`JPEG compressed buffer size: ${compressedBuffer.length}`)
      return {
        buffer: compressedBuffer,
        mediaType: 'jpeg',
        dimensions: {
          originalWidth,
          originalHeight,
          displayWidth: smallerWidth,
          displayHeight: smallerHeight,
        },
      }
    }

    // 缩小后大小合规，直接返回
    return {
      buffer: resizedImageBuffer,
      mediaType: normalizedMediaType,
      dimensions: {
        originalWidth,
        originalHeight,
        displayWidth: width,
        displayHeight: height,
      },
    }
  } catch (error) {
    // sharp 处理失败：记录错误并上报分析事件
    logError(error as Error)
    const errorType = classifyImageError(error)
    const errorMsg = errorMessage(error)
    logEvent('tengu_image_resize_failed', {
      original_size_bytes: originalSize,
      error_type: errorType,
      error_message_hash: hashString(errorMsg), // 哈希化，保护用户隐私
    })

    // 从魔数字节检测实际格式（不信任扩展名）
    const detected = detectImageFormatFromBuffer(imageBuffer)
    const normalizedExt = detected.slice(6) // 去掉 'image/' 前缀

    // 计算 base64 编码后的大小（API 限制的是 base64 字符串长度）
    const base64Size = Math.ceil((originalSize * 4) / 3)

    // 若为 PNG 且尺寸超标，则不能透传——检测 PNG 头中记录的宽高（16-24 字节）
    const overDim =
      imageBuffer.length >= 24 &&
      imageBuffer[0] === 0x89 &&
      imageBuffer[1] === 0x50 &&
      imageBuffer[2] === 0x4e &&
      imageBuffer[3] === 0x47 &&
      (imageBuffer.readUInt32BE(16) > IMAGE_MAX_WIDTH ||
        imageBuffer.readUInt32BE(20) > IMAGE_MAX_HEIGHT)

    // 若原图 base64 编码后大小在 API 限制内（且尺寸未超标），允许直接透传
    if (base64Size <= API_IMAGE_MAX_BASE64_SIZE && !overDim) {
      logEvent('tengu_image_resize_fallback', {
        original_size_bytes: originalSize,
        base64_size_bytes: base64Size,
        error_type: errorType,
      })
      return { buffer: imageBuffer, mediaType: normalizedExt }
    }

    // 图像超限且压缩失败，抛出用户可读的错误
    throw new ImageResizeError(
      overDim
        ? `Unable to resize image — dimensions exceed the ${IMAGE_MAX_WIDTH}x${IMAGE_MAX_HEIGHT}px limit and image processing failed. ` +
            `Please resize the image to reduce its pixel dimensions.`
        : `Unable to resize image (${formatFileSize(originalSize)} raw, ${formatFileSize(base64Size)} base64). ` +
            `The image exceeds the 5MB API limit and compression failed. ` +
            `Please resize the image manually or use a smaller image.`,
    )
  }
}

/** 带尺寸信息的图像块，供坐标映射（如截图标注）使用 */
export interface ImageBlockWithDimensions {
  block: ImageBlockParam
  dimensions?: ImageDimensions
}

/**
 * 对 API 消息中的图像块进行按需缩放与降采样。
 *
 * 与 maybeResizeAndDownsampleImageBuffer 的区别在于：
 * 本函数接受并返回 Anthropic SDK 的 ImageBlockParam 结构，
 * 供消息构建层直接调用，无需关心底层 Buffer 操作。
 *
 * 流程：仅处理 base64 类型 → 解码 → 调用底层缓冲区处理 → 重新编码为 base64 块。
 *
 * @param imageBlock - 原始图像块
 * @returns 缩放后的图像块及尺寸信息
 */
export async function maybeResizeAndDownsampleImageBlock(
  imageBlock: ImageBlockParam,
): Promise<ImageBlockWithDimensions> {
  // 仅处理 base64 类型，URL 类型直接透传
  if (imageBlock.source.type !== 'base64') {
    return { block: imageBlock }
  }

  // 将 base64 字符串解码为二进制缓冲区
  const imageBuffer = Buffer.from(imageBlock.source.data, 'base64')
  const originalSize = imageBuffer.length

  // 从 MIME 类型中提取扩展名（如 'image/png' → 'png'）
  const mediaType = imageBlock.source.media_type
  const ext = mediaType?.split('/')[1] || 'png'

  // 调用底层缓冲区缩放函数
  const resized = await maybeResizeAndDownsampleImageBuffer(
    imageBuffer,
    originalSize,
    ext,
  )

  // 将处理结果重新封装为 ImageBlockParam 格式
  return {
    block: {
      type: 'image',
      source: {
        type: 'base64',
        media_type:
          `image/${resized.mediaType}` as Base64ImageSource['media_type'],
        data: resized.buffer.toString('base64'),
      },
    },
    dimensions: resized.dimensions,
  }
}

/**
 * 将图像缓冲区压缩到指定字节大小以内。
 *
 * 采用多策略渐进回退方式，因为对大截图、高分辨率照片或复杂渐变图像，
 * 简单压缩往往不够。每种策略比上一种更激进：
 *   1. 保留原始格式（PNG/JPEG/WebP）并渐进缩小尺寸；
 *   2. 对 PNG 尝试调色板优化（减少颜色数）；
 *   3. 转换为 JPEG（中等质量）；
 *   4. 最终手段：超低质量 JPEG。
 *
 * @param imageBuffer      - 原始图像缓冲区
 * @param maxBytes         - 目标字节上限，默认为 IMAGE_TARGET_RAW_SIZE
 * @param originalMediaType - 原始媒体类型（如 'image/png'），可选
 * @returns 压缩结果（base64 字符串、媒体类型、原始大小）
 * @throws ImageResizeError 当所有策略均失败且原图超限时
 */
export async function compressImageBuffer(
  imageBuffer: Buffer,
  maxBytes: number = IMAGE_TARGET_RAW_SIZE,
  originalMediaType?: string,
): Promise<CompressedImageResult> {
  // 从 originalMediaType 中提取格式名（如 "image/png" → "png"）
  const fallbackFormat = originalMediaType?.split('/')[1] || 'jpeg'
  const normalizedFallback = fallbackFormat === 'jpg' ? 'jpeg' : fallbackFormat

  try {
    const sharp = await getImageProcessor()
    const metadata = await sharp(imageBuffer).metadata()
    const format = metadata.format || normalizedFallback
    const originalSize = imageBuffer.length

    // 构建压缩上下文，集中管理所有参数
    const context: ImageCompressionContext = {
      imageBuffer,
      metadata,
      format,
      maxBytes,
      originalSize,
    }

    // 若图像已在大小限制内，直接返回（不做任何处理）
    if (originalSize <= maxBytes) {
      return createCompressedImageResult(imageBuffer, format, originalSize)
    }

    // 策略一：保留格式并渐进缩小尺寸（100%/75%/50%/25%）
    const resizedResult = await tryProgressiveResizing(context, sharp)
    if (resizedResult) {
      return resizedResult
    }

    // 策略二：对 PNG 尝试调色板压缩
    if (format === 'png') {
      const palettizedResult = await tryPalettePNG(context, sharp)
      if (palettizedResult) {
        return palettizedResult
      }
    }

    // 策略三：以 50% 质量转换为 JPEG
    const jpegResult = await tryJPEGConversion(context, 50, sharp)
    if (jpegResult) {
      return jpegResult
    }

    // 策略四（最终手段）：超低质量 JPEG，压缩到 400×400
    return await createUltraCompressedJPEG(context, sharp)
  } catch (error) {
    // 记录错误并上报分析事件
    logError(error as Error)
    const errorType = classifyImageError(error)
    const errorMsg = errorMessage(error)
    logEvent('tengu_image_compress_failed', {
      original_size_bytes: imageBuffer.length,
      max_bytes: maxBytes,
      error_type: errorType,
      error_message_hash: hashString(errorMsg),
    })

    // 若原图本就在限制内，则直接透传（从魔数检测格式）
    if (imageBuffer.length <= maxBytes) {
      const detected = detectImageFormatFromBuffer(imageBuffer)
      return {
        base64: imageBuffer.toString('base64'),
        mediaType: detected,
        originalSize: imageBuffer.length,
      }
    }

    // 图像超限且压缩失败，抛出错误
    throw new ImageResizeError(
      `Unable to compress image (${formatFileSize(imageBuffer.length)}) to fit within ${formatFileSize(maxBytes)}. ` +
        `Please use a smaller image.`,
    )
  }
}

/**
 * 将图像缓冲区压缩到 token 限制以内。
 *
 * token → 字节的换算公式：maxBytes = (maxTokens / 0.125) × 0.75
 * 原理：1 token ≈ 4 个 base64 字符（0.125 token/字符），base64 膨胀率为 4/3。
 *
 * @param imageBuffer      - 原始图像缓冲区
 * @param maxTokens        - token 上限
 * @param originalMediaType - 原始媒体类型（可选）
 */
export async function compressImageBufferWithTokenLimit(
  imageBuffer: Buffer,
  maxTokens: number,
  originalMediaType?: string,
): Promise<CompressedImageResult> {
  // 将 token 上限转换为字节上限
  // base64 编码后约占原始大小的 4/3，因此反向推导
  const maxBase64Chars = Math.floor(maxTokens / 0.125)
  const maxBytes = Math.floor(maxBase64Chars * 0.75)

  return compressImageBuffer(imageBuffer, maxBytes, originalMediaType)
}

/**
 * 将 ImageBlockParam 图像块压缩到指定字节大小以内。
 * 是 compressImageBuffer 的块级封装，供消息层直接使用。
 *
 * @param imageBlock - 原始图像块
 * @param maxBytes   - 字节上限，默认为 IMAGE_TARGET_RAW_SIZE
 * @returns 压缩后的图像块
 */
export async function compressImageBlock(
  imageBlock: ImageBlockParam,
  maxBytes: number = IMAGE_TARGET_RAW_SIZE,
): Promise<ImageBlockParam> {
  // 非 base64 类型（如 URL）直接返回
  if (imageBlock.source.type !== 'base64') {
    return imageBlock
  }

  // 解码 base64 以获取字节大小
  const imageBuffer = Buffer.from(imageBlock.source.data, 'base64')

  // 已在大小限制内，直接返回
  if (imageBuffer.length <= maxBytes) {
    return imageBlock
  }

  // 执行压缩
  const compressed = await compressImageBuffer(imageBuffer, maxBytes)

  // 重新封装为 ImageBlockParam
  return {
    type: 'image',
    source: {
      type: 'base64',
      media_type: compressed.mediaType,
      data: compressed.base64,
    },
  }
}

// ─────────────────────────── 压缩管道辅助函数 ───────────────────────────

/**
 * 将缓冲区封装为 CompressedImageResult。
 * 统一处理 'jpg' → 'jpeg' 的 MIME 类型标准化。
 */
function createCompressedImageResult(
  buffer: Buffer,
  mediaType: string,
  originalSize: number,
): CompressedImageResult {
  const normalizedMediaType = mediaType === 'jpg' ? 'jpeg' : mediaType
  return {
    base64: buffer.toString('base64'),
    mediaType:
      `image/${normalizedMediaType}` as Base64ImageSource['media_type'],
    originalSize,
  }
}

/**
 * 策略一：保留原始格式并按比例渐进缩小（100% → 75% → 50% → 25%）。
 * 每个缩放比例都应用与原始格式对应的优化参数。
 * 返回 null 表示所有比例均未能满足大小要求。
 */
async function tryProgressiveResizing(
  context: ImageCompressionContext,
  sharp: SharpFunction,
): Promise<CompressedImageResult | null> {
  const scalingFactors = [1.0, 0.75, 0.5, 0.25] // 渐进缩小比例

  for (const scalingFactor of scalingFactors) {
    // 按比例计算目标尺寸（回退到 2000px 以防元数据缺失）
    const newWidth = Math.round(
      (context.metadata.width || 2000) * scalingFactor,
    )
    const newHeight = Math.round(
      (context.metadata.height || 2000) * scalingFactor,
    )

    let resizedImage = sharp(context.imageBuffer).resize(newWidth, newHeight, {
      fit: 'inside',
      withoutEnlargement: true,
    })

    // 对不同格式应用各自的优化参数
    resizedImage = applyFormatOptimizations(resizedImage, context.format)

    const resizedBuffer = await resizedImage.toBuffer()

    if (resizedBuffer.length <= context.maxBytes) {
      return createCompressedImageResult(
        resizedBuffer,
        context.format,
        context.originalSize,
      )
    }
  }

  return null // 所有比例均未能满足要求
}

/**
 * 根据格式为 sharp 实例应用专项优化参数。
 * PNG：最大压缩级别 + 调色板；JPEG/WebP：80% 质量。
 */
function applyFormatOptimizations(
  image: SharpInstance,
  format: string,
): SharpInstance {
  switch (format) {
    case 'png':
      return image.png({
        compressionLevel: 9, // 最大 zlib 压缩级别
        palette: true,        // 调色板模式减少颜色数
      })
    case 'jpeg':
    case 'jpg':
      return image.jpeg({ quality: 80 }) // 80% 质量兼顾体积与画质
    case 'webp':
      return image.webp({ quality: 80 })
    default:
      return image // 未知格式不做额外处理
  }
}

/**
 * 策略二（仅 PNG）：将图像缩小到 800×800 并使用 64 色调色板压缩。
 * 对截图等颜色较少的图像效果显著。
 * 返回 null 表示压缩结果仍超限。
 */
async function tryPalettePNG(
  context: ImageCompressionContext,
  sharp: SharpFunction,
): Promise<CompressedImageResult | null> {
  const palettePng = await sharp(context.imageBuffer)
    .resize(800, 800, {
      fit: 'inside',
      withoutEnlargement: true,
    })
    .png({
      compressionLevel: 9,
      palette: true,
      colors: 64, // 将颜色数量减少到 64，显著提升压缩率
    })
    .toBuffer()

  if (palettePng.length <= context.maxBytes) {
    return createCompressedImageResult(palettePng, 'png', context.originalSize)
  }

  return null
}

/**
 * 策略三：将图像缩小到 600×600 并转换为指定质量的 JPEG。
 * 放弃透明度换取更小的文件体积。
 * 返回 null 表示压缩结果仍超限。
 */
async function tryJPEGConversion(
  context: ImageCompressionContext,
  quality: number,
  sharp: SharpFunction,
): Promise<CompressedImageResult | null> {
  const jpegBuffer = await sharp(context.imageBuffer)
    .resize(600, 600, {
      fit: 'inside',
      withoutEnlargement: true,
    })
    .jpeg({ quality })
    .toBuffer()

  if (jpegBuffer.length <= context.maxBytes) {
    return createCompressedImageResult(jpegBuffer, 'jpeg', context.originalSize)
  }

  return null
}

/**
 * 策略四（最终手段）：将图像缩小到 400×400 并以 20% 质量输出 JPEG。
 * 不检查结果大小，直接返回——这是最后的退路。
 */
async function createUltraCompressedJPEG(
  context: ImageCompressionContext,
  sharp: SharpFunction,
): Promise<CompressedImageResult> {
  const ultraCompressedBuffer = await sharp(context.imageBuffer)
    .resize(400, 400, {
      fit: 'inside',
      withoutEnlargement: true,
    })
    .jpeg({ quality: 20 }) // 极低质量，仅保留图像基本内容
    .toBuffer()

  return createCompressedImageResult(
    ultraCompressedBuffer,
    'jpeg',
    context.originalSize,
  )
}

/**
 * 通过检测缓冲区开头的魔数字节来识别图像格式。
 * 比依赖文件扩展名更可靠，因为用户可能重命名文件。
 *
 * 支持格式：PNG（\x89PNG）、JPEG（FFD8FF）、GIF（GIF8）、WebP（RIFF...WEBP）。
 *
 * @param buffer - 包含图像数据的缓冲区
 * @returns MIME 类型字符串，未识别时默认返回 'image/png'
 */
export function detectImageFormatFromBuffer(buffer: Buffer): ImageMediaType {
  if (buffer.length < 4) return 'image/png' // 数据太短，返回默认值

  // 检查 PNG 签名：\x89 P N G（4 字节）
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return 'image/png'
  }

  // 检查 JPEG 签名：FF D8 FF（3 字节）
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg'
  }

  // 检查 GIF 签名：G I F（GIF87a 或 GIF89a）
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
    return 'image/gif'
  }

  // 检查 WebP 签名：RIFF....WEBP（12 字节）
  if (
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46
  ) {
    if (
      buffer.length >= 12 &&
      buffer[8] === 0x57 &&
      buffer[9] === 0x45 &&
      buffer[10] === 0x42 &&
      buffer[11] === 0x50
    ) {
      return 'image/webp'
    }
  }

  // 未识别格式，默认返回 PNG
  return 'image/png'
}

/**
 * 通过检测 base64 数据的魔数字节来识别图像格式。
 * 是 detectImageFormatFromBuffer 的 base64 字符串版本。
 *
 * @param base64Data - base64 编码的图像数据
 * @returns MIME 类型字符串，出错时默认返回 'image/png'
 */
export function detectImageFormatFromBase64(
  base64Data: string,
): ImageMediaType {
  try {
    // 解码 base64，仅需检查开头几字节
    const buffer = Buffer.from(base64Data, 'base64')
    return detectImageFormatFromBuffer(buffer)
  } catch {
    // 解码失败时返回默认值
    return 'image/png'
  }
}

/**
 * 创建图像元数据描述文本，包含尺寸信息和源路径。
 * 供 AI 模型理解图像被缩放的程度，以便正确映射坐标（如截图标注）。
 *
 * 仅在存在有效尺寸且图像被缩放（或有源路径）时才返回非 null 值。
 *
 * @param dims       - 图像尺寸信息（原始和展示尺寸）
 * @param sourcePath - 图像来源路径（可选）
 * @returns 元数据描述字符串，或 null（无有用信息时）
 */
export function createImageMetadataText(
  dims: ImageDimensions,
  sourcePath?: string,
): string | null {
  const { originalWidth, originalHeight, displayWidth, displayHeight } = dims
  // 尺寸无效或为零时，跳过（防止除零错误）
  if (
    !originalWidth ||
    !originalHeight ||
    !displayWidth ||
    !displayHeight ||
    displayWidth <= 0 ||
    displayHeight <= 0
  ) {
    // 有源路径但无尺寸时，仍返回源信息
    if (sourcePath) {
      return `[Image source: ${sourcePath}]`
    }
    return null
  }
  // 判断图像是否被缩放（任一维度变化即认为被缩放）
  const wasResized =
    originalWidth !== displayWidth || originalHeight !== displayHeight

  // 既未缩放又无源路径，无需元数据
  if (!wasResized && !sourcePath) {
    return null
  }

  // 构建元数据各部分
  const parts: string[] = []

  if (sourcePath) {
    parts.push(`source: ${sourcePath}`)
  }

  if (wasResized) {
    // 计算缩放比例，供 AI 将坐标映射回原始图像
    const scaleFactor = originalWidth / displayWidth
    parts.push(
      `original ${originalWidth}x${originalHeight}, displayed at ${displayWidth}x${displayHeight}. Multiply coordinates by ${scaleFactor.toFixed(2)} to map to original image.`,
    )
  }

  return `[Image: ${parts.join(', ')}]`
}
