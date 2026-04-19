/**
 * BashTool/utils.ts
 *
 * 【在 Claude Code 系统中的位置】
 * 本文件是 BashTool 工具模块的通用工具函数集合，被 BashTool 主逻辑及相关模块广泛调用。
 * 主要承担以下职责：
 *   1. 输出格式化与截断：将 shell 命令的 stdout/stderr 转换为模型可消费的格式。
 *   2. 图像输出处理：检测 data-URI 图像、解析并在必要时进行尺寸缩减。
 *   3. 工作目录管理：在执行命令后检查并重置 cwd，防止 Claude 漂移出项目目录。
 *   4. MCP 内容摘要：将结构化 ContentBlockParam 数组转换为可读摘要。
 *
 * 【主要功能】
 * - stripEmptyLines：去除字符串首尾空行
 * - isImageOutput：检测内容是否为 base64 图像 data-URI
 * - parseDataUri：将 data-URI 解析为 mediaType + base64 data
 * - buildImageToolResult：将图像 stdout 构建为 ToolResultBlockParam
 * - resizeShellImageOutput：从磁盘或内存重读图像并缩减尺寸
 * - formatOutput：对文本/图像输出进行截断处理
 * - stdErrAppendShellResetMessage：在 stderr 末尾追加工作目录重置通知
 * - resetCwdIfOutsideProject：检测并重置越界的 cwd
 * - createContentSummary：生成 MCP 结果的人类可读摘要
 */

import type {
  Base64ImageSource,
  ContentBlockParam,
  ToolResultBlockParam,
} from '@anthropic-ai/sdk/resources/index.mjs'
import { readFile, stat } from 'fs/promises'
import { getOriginalCwd } from 'src/bootstrap/state.js'
import { logEvent } from 'src/services/analytics/index.js'
import type { ToolPermissionContext } from 'src/Tool.js'
import { getCwd } from 'src/utils/cwd.js'
import { pathInAllowedWorkingPath } from 'src/utils/permissions/filesystem.js'
import { setCwd } from 'src/utils/Shell.js'
import { shouldMaintainProjectWorkingDir } from '../../utils/envUtils.js'
import { maybeResizeAndDownsampleImageBuffer } from '../../utils/imageResizer.js'
import { getMaxOutputLength } from '../../utils/shell/outputLimits.js'
import { countCharInString, plural } from '../../utils/stringUtils.js'

/**
 * stripEmptyLines
 *
 * 【函数作用】
 * 去除字符串首尾只含空白字符/换行的行。
 * 与 trim() 不同，此函数仅移除首尾的完全空行，保留内容行中的缩进空白。
 *
 * Strips leading and trailing lines that contain only whitespace/newlines.
 * Unlike trim(), this preserves whitespace within content lines and only removes
 * completely empty lines from the beginning and end.
 */
export function stripEmptyLines(content: string): string {
  const lines = content.split('\n')

  // 找到第一个非空行的下标
  // Find the first non-empty line
  let startIndex = 0
  while (startIndex < lines.length && lines[startIndex]?.trim() === '') {
    startIndex++
  }

  // 找到最后一个非空行的下标
  // Find the last non-empty line
  let endIndex = lines.length - 1
  while (endIndex >= 0 && lines[endIndex]?.trim() === '') {
    endIndex--
  }

  // 所有行均为空，返回空字符串
  // If all lines are empty, return empty string
  if (startIndex > endIndex) {
    return ''
  }

  // 截取有内容的部分重新拼接
  // Return the slice with non-empty lines
  return lines.slice(startIndex, endIndex + 1).join('\n')
}

/**
 * isImageOutput
 *
 * 【函数作用】
 * 检测内容字符串是否为 base64 编码的图像 data-URI。
 * 格式：`data:image/<subtype>;base64,...`
 *
 * Check if content is a base64 encoded image data URL
 */
export function isImageOutput(content: string): boolean {
  // 正则匹配 data:image/ 开头的 base64 data-URI
  return /^data:image\/[a-z0-9.+_-]+;base64,/i.test(content)
}

// data-URI 解析正则：捕获 mediaType 和 base64 数据两组
const DATA_URI_RE = /^data:([^;]+);base64,(.+)$/

/**
 * parseDataUri
 *
 * 【函数作用】
 * 将 data-URI 字符串解析为 { mediaType, data } 对象。
 * 输入在匹配前会先 trim()，若解析失败则返回 null。
 *
 * Parse a data-URI string into its media type and base64 payload.
 * Input is trimmed before matching.
 */
export function parseDataUri(
  s: string,
): { mediaType: string; data: string } | null {
  // 匹配 data:<mediaType>;base64,<data> 格式
  const match = s.trim().match(DATA_URI_RE)
  if (!match || !match[1] || !match[2]) return null
  return { mediaType: match[1], data: match[2] }
}

/**
 * buildImageToolResult
 *
 * 【函数作用】
 * 将包含图像 data-URI 的 stdout 构建为 ToolResultBlockParam（图像类型）。
 * 若解析失败，返回 null，让调用方回退到文本处理逻辑。
 *
 * Build an image tool_result block from shell stdout containing a data URI.
 * Returns null if parse fails so callers can fall through to text handling.
 */
export function buildImageToolResult(
  stdout: string,
  toolUseID: string,
): ToolResultBlockParam | null {
  // 解析 data-URI；失败则返回 null
  const parsed = parseDataUri(stdout)
  if (!parsed) return null
  // 构建 Anthropic SDK 所需的 tool_result 结构
  return {
    tool_use_id: toolUseID,
    type: 'tool_result',
    content: [
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: parsed.mediaType as Base64ImageSource['media_type'],
          data: parsed.data,
        },
      },
    ],
  }
}

// 文件读取上限 20 MB —— 超过此大小的图像 data-URI 远超 API 限制（5 MB base64），
// 强行读入内存会导致 OOM
// Cap file reads to 20 MB — any image data URI larger than this is
// well beyond what the API accepts (5 MB base64) and would OOM if read
// into memory.
const MAX_IMAGE_FILE_SIZE = 20 * 1024 * 1024

/**
 * resizeShellImageOutput
 *
 * 【函数作用】
 * 对 shell 工具输出的图像进行缩减处理：
 *   1. 若 stdout 被截断（溢出至磁盘文件），重新从文件读取完整内容，
 *      因为截断的 base64 解码后为损坏图像，会被 API 拒绝。
 *   2. 调用 maybeResizeAndDownsampleImageBuffer 缩减尺寸（处理高 DPI PNG 等情形）。
 *   3. 返回重新编码的 data-URI，解析失败则返回 null。
 *
 * Resize image output from a shell tool. stdout is capped at
 * getMaxOutputLength() when read back from the shell output file — if the
 * full output spilled to disk, re-read it from there, since truncated base64
 * would decode to a corrupt image that either throws here or gets rejected by
 * the API. Caps dimensions too: compressImageBuffer only checks byte size, so
 * a small-but-high-DPI PNG (e.g. matplotlib at dpi=300) sails through at full
 * resolution and poisons many-image requests (CC-304).
 *
 * Returns the re-encoded data URI on success, or null if the source didn't
 * parse as a data URI (caller decides whether to flip isImage).
 */
export async function resizeShellImageOutput(
  stdout: string,
  outputFilePath: string | undefined,
  outputFileSize: number | undefined,
): Promise<string | null> {
  let source = stdout
  // 若有磁盘文件路径，检查文件大小，超限则直接返回 null
  if (outputFilePath) {
    const size = outputFileSize ?? (await stat(outputFilePath)).size
    if (size > MAX_IMAGE_FILE_SIZE) return null
    // 从磁盘重读完整内容（避免 stdout 截断导致的损坏图像）
    source = await readFile(outputFilePath, 'utf8')
  }
  // 解析 data-URI，提取 base64 缓冲区
  const parsed = parseDataUri(source)
  if (!parsed) return null
  const buf = Buffer.from(parsed.data, 'base64')
  // 取 mediaType 中的扩展名部分（如 image/png → png）
  const ext = parsed.mediaType.split('/')[1] || 'png'
  // 缩减图像尺寸和采样率
  const resized = await maybeResizeAndDownsampleImageBuffer(
    buf,
    buf.length,
    ext,
  )
  // 返回重新编码后的 data-URI
  return `data:image/${resized.mediaType};base64,${resized.buffer.toString('base64')}`
}

/**
 * formatOutput
 *
 * 【函数作用】
 * 对命令输出内容进行格式化处理：
 *   - 图像内容：直接返回，标记 isImage=true。
 *   - 文本内容：若超过最大输出长度，进行截断并在末尾追加截断说明。
 * 返回总行数、（可能截断的）内容字符串及 isImage 标志。
 */
export function formatOutput(content: string): {
  totalLines: number
  truncatedContent: string
  isImage?: boolean
} {
  // 检测是否为图像 data-URI
  const isImage = isImageOutput(content)
  if (isImage) {
    // 图像内容不截断，直接返回
    return {
      totalLines: 1,
      truncatedContent: content,
      isImage,
    }
  }

  const maxOutputLength = getMaxOutputLength()
  // 内容未超限，直接返回完整文本
  if (content.length <= maxOutputLength) {
    return {
      totalLines: countCharInString(content, '\n') + 1,
      truncatedContent: content,
      isImage,
    }
  }

  // 超出限制：截取前 maxOutputLength 字符，计算剩余行数后追加提示信息
  const truncatedPart = content.slice(0, maxOutputLength)
  const remainingLines = countCharInString(content, '\n', maxOutputLength) + 1
  const truncated = `${truncatedPart}\n\n... [${remainingLines} lines truncated] ...`

  return {
    totalLines: countCharInString(content, '\n') + 1,
    truncatedContent: truncated,
    isImage,
  }
}

/**
 * stdErrAppendShellResetMessage
 *
 * 【函数作用】
 * 在 stderr 末尾追加工作目录重置通知文本，
 * 告知用户 shell cwd 已被重置回原始项目目录。
 */
export const stdErrAppendShellResetMessage = (stderr: string): string =>
  `${stderr.trim()}\nShell cwd was reset to ${getOriginalCwd()}`

/**
 * resetCwdIfOutsideProject
 *
 * 【函数作用】
 * 在 bash 命令执行后检查当前工作目录是否仍在允许范围内。
 * 若配置了"维护项目工作目录"或 cwd 已漂移出允许的路径集合，
 * 则将 cwd 重置回原始目录，并记录分析事件。
 *
 * 【优化说明】
 * 当 cwd 未发生变化时，跳过 pathInAllowedWorkingPath 的文件系统调用（快速路径），
 * 因为 originalCwd 始终在 allWorkingDirectories 集合中。
 *
 * @returns true 表示发生了非预期的 cwd 重置（即 cwd 越界），false 表示一切正常
 */
export function resetCwdIfOutsideProject(
  toolPermissionContext: ToolPermissionContext,
): boolean {
  const cwd = getCwd()
  const originalCwd = getOriginalCwd()
  const shouldMaintain = shouldMaintainProjectWorkingDir()
  if (
    shouldMaintain ||
    // 快速路径：cwd 未变化时跳过文件系统调用
    // Fast path: originalCwd is unconditionally in allWorkingDirectories
    // (filesystem.ts), so when cwd hasn't moved, pathInAllowedWorkingPath is
    // trivially true — skip its syscalls for the no-cd common case.
    (cwd !== originalCwd &&
      !pathInAllowedWorkingPath(cwd, toolPermissionContext))
  ) {
    // 重置 cwd 到原始目录（维护项目目录模式 或 越界情形）
    // Reset to original directory if maintaining project dir OR outside allowed working directory
    setCwd(originalCwd)
    if (!shouldMaintain) {
      // 仅在越界情形下上报事件（维护模式下属正常行为，不上报）
      logEvent('tengu_bash_tool_reset_to_original_dir', {})
      return true
    }
  }
  return false
}

/**
 * createContentSummary
 *
 * 【函数作用】
 * 将结构化的 ContentBlockParam 数组转换为人类可读的摘要字符串，
 * 用于在 UI 中展示 MCP 工具调用的结果（含图像和文本混合内容）。
 *
 * 【格式】
 * "MCP Result: [N image(s)], [M text block(s)]\n\n<文本预览...>"
 * 每个文本块最多展示前 200 个字符。
 *
 * Creates a human-readable summary of structured content blocks.
 * Used to display MCP results with images and text in the UI.
 */
export function createContentSummary(content: ContentBlockParam[]): string {
  const parts: string[] = []
  let textCount = 0
  let imageCount = 0

  for (const block of content) {
    if (block.type === 'image') {
      // 统计图像块数量
      imageCount++
    } else if (block.type === 'text' && 'text' in block) {
      textCount++
      // 每个文本块仅展示前 200 字符作为预览，超出则添加省略号
      // Include first 200 chars of text blocks for context
      const preview = block.text.slice(0, 200)
      parts.push(preview + (block.text.length > 200 ? '...' : ''))
    }
  }

  // 构建摘要标签：[N image(s)]、[M text block(s)]
  const summary: string[] = []
  if (imageCount > 0) {
    summary.push(`[${imageCount} ${plural(imageCount, 'image')}]`)
  }
  if (textCount > 0) {
    summary.push(`[${textCount} text ${plural(textCount, 'block')}]`)
  }

  // 拼接最终摘要文本，若有文本块预览则追加在标签后
  return `MCP Result: ${summary.join(', ')}${parts.length > 0 ? '\n\n' + parts.join('\n\n') : ''}`
}
