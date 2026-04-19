/**
 * 宽度感知字符串截断与换行模块
 *
 * 在 Claude Code 系统流程中的位置：
 * 本模块是终端 UI 渲染层的底层字符串处理工具，被各类 Ink/React 组件调用，
 * 用于将文件路径、命令输出等长字符串截断至终端列宽，同时正确处理
 * CJK 双宽字符和 emoji（占两个终端列）以及组合字符（grapheme cluster）。
 *
 * 主要功能：
 * - truncatePathMiddle()：路径中间截断，保留目录上下文和文件名
 * - truncateToWidth()：从尾部截断并追加省略号（…）
 * - truncateStartToWidth()：从头部截断并前置省略号（…）
 * - truncateToWidthNoEllipsis()：无省略号截断（供调用方自行拼接分隔符）
 * - truncate()：通用截断，可选单行模式（在首个换行符处截断）
 * - wrapText()：按宽度换行，将长文本拆分为多行
 *
 * 所有函数均通过 Intl.Segmenter 在 grapheme 边界处分割，
 * 通过 stringWidth() 精确测量终端显示宽度。
 */

// 宽度感知截断/换行——依赖 ink/stringWidth，非叶模块安全。

import { stringWidth } from '../ink/stringWidth.js'
import { getGraphemeSegmenter } from './intl.js'

/**
 * 路径中间截断：保留目录前缀和文件名，中间用 "…" 连接。
 *
 * 例如："src/components/deeply/nested/folder/MyComponent.tsx"
 * 在 maxLength=30 时变为："src/components/…/MyComponent.tsx"
 *
 * 流程：
 * 1. 若路径宽度 ≤ maxLength，直接返回
 * 2. maxLength ≤ 0 → 返回单个 "…"
 * 3. maxLength < 5 → 回退到 truncateToWidth()（空间不足以做有意义的中间截断）
 * 4. 定位最后一个 "/" 分离目录和文件名
 * 5. 若文件名本身超长 → 回退到 truncateStartToWidth()
 * 6. 计算目录可用宽度，截断目录后拼接省略号和文件名
 *
 * @param path 要截断的文件路径
 * @param maxLength 结果的最大终端列宽（必须 > 0）
 * @returns 截断后的路径，若原路径已在限制内则原样返回
 */
export function truncatePathMiddle(path: string, maxLength: number): string {
  // 已在限制内，无需截断
  if (stringWidth(path) <= maxLength) {
    return path
  }

  // maxLength 极小或非正值时的边界处理
  if (maxLength <= 0) {
    return '…'
  }

  // 空间不足以做有意义的中间截断，回退到尾部截断
  if (maxLength < 5) {
    return truncateToWidth(path, maxLength)
  }

  // 定位最后一个斜杠，分离目录和文件名
  const lastSlash = path.lastIndexOf('/')
  // 文件名包含前导斜杠（用于显示）
  const filename = lastSlash >= 0 ? path.slice(lastSlash) : path
  const directory = lastSlash >= 0 ? path.slice(0, lastSlash) : ''
  const filenameWidth = stringWidth(filename)

  // 文件名本身超长，回退到头部截断（保留结尾）
  if (filenameWidth >= maxLength - 1) {
    return truncateStartToWidth(path, maxLength)
  }

  // 计算目录前缀可用宽度：总宽度 - 1（省略号）- 文件名宽度
  const availableForDir = maxLength - 1 - filenameWidth

  if (availableForDir <= 0) {
    // 无空间容纳目录，直接截断文件名显示
    return truncateStartToWidth(filename, maxLength)
  }

  // 截断目录前缀，拼接省略号和文件名
  const truncatedDir = truncateToWidthNoEllipsis(directory, availableForDir)
  return truncatedDir + '…' + filename
}

/**
 * 尾部截断：保留字符串开头，超出宽度部分替换为 "…"。
 * 在 grapheme 边界处分割，正确处理 emoji 和 CJK 双宽字符。
 *
 * 流程：
 * 1. 若宽度 ≤ maxWidth，直接返回
 * 2. maxWidth ≤ 1 → 返回单个 "…"
 * 3. 逐 grapheme 累加宽度，超出 maxWidth-1 时停止（保留省略号位置）
 * 4. 返回已累加部分 + "…"
 *
 * @param text 要截断的字符串
 * @param maxWidth 最大终端列宽
 * @returns 截断后的字符串（含 "…"）
 */
export function truncateToWidth(text: string, maxWidth: number): string {
  if (stringWidth(text) <= maxWidth) return text
  if (maxWidth <= 1) return '…'
  let width = 0
  let result = ''
  for (const { segment } of getGraphemeSegmenter().segment(text)) {
    const segWidth = stringWidth(segment)
    // 预留一列给省略号（maxWidth - 1）
    if (width + segWidth > maxWidth - 1) break
    result += segment
    width += segWidth
  }
  return result + '…'
}

/**
 * 头部截断：保留字符串尾部，超出宽度部分替换为前置 "…"。
 * 宽度感知，在 grapheme 边界处分割。
 *
 * 流程：
 * 1. 若宽度 ≤ maxWidth，直接返回
 * 2. maxWidth ≤ 1 → 返回单个 "…"
 * 3. 将字符串按 grapheme 分割为数组
 * 4. 从尾部向前累加宽度，超出 maxWidth-1 时停止
 * 5. 返回 "…" + 保留的尾部段
 *
 * @param text 要截断的字符串
 * @param maxWidth 最大终端列宽
 * @returns 截断后的字符串（含前置 "…"）
 */
export function truncateStartToWidth(text: string, maxWidth: number): string {
  if (stringWidth(text) <= maxWidth) return text
  if (maxWidth <= 1) return '…'
  const segments = [...getGraphemeSegmenter().segment(text)]
  let width = 0
  let startIdx = segments.length
  // 从尾部向前扫描，找到保留部分的起始索引
  for (let i = segments.length - 1; i >= 0; i--) {
    const segWidth = stringWidth(segments[i]!.segment)
    if (width + segWidth > maxWidth - 1) break // 预留一列给省略号
    width += segWidth
    startIdx = i
  }
  return (
    '…' +
    segments
      .slice(startIdx)
      .map(s => s.segment)
      .join('')
  )
}

/**
 * 无省略号的尾部截断：截断至 maxWidth，不追加省略号。
 * 供调用方自行拼接分隔符（如 truncatePathMiddle 中的 "…"）使用。
 *
 * 流程：
 * 1. 若宽度 ≤ maxWidth，直接返回
 * 2. maxWidth ≤ 0 → 返回空字符串
 * 3. 逐 grapheme 累加宽度，超出 maxWidth 时停止
 * 4. 返回已累加部分（无省略号）
 *
 * @param text 要截断的字符串
 * @param maxWidth 最大终端列宽
 * @returns 截断后的字符串（无省略号）
 */
export function truncateToWidthNoEllipsis(
  text: string,
  maxWidth: number,
): string {
  if (stringWidth(text) <= maxWidth) return text
  if (maxWidth <= 0) return ''
  let width = 0
  let result = ''
  for (const { segment } of getGraphemeSegmenter().segment(text)) {
    const segWidth = stringWidth(segment)
    if (width + segWidth > maxWidth) break // 超出时停止，不预留省略号位置
    result += segment
    width += segWidth
  }
  return result
}

/**
 * 通用截断函数：支持单行模式（在首个换行符处截断）。
 *
 * 流程：
 * 1. 若 singleLine=true，查找第一个换行符，在该处截断并追加 "…"
 *    - 若截断后的单行宽度加省略号超出 maxWidth，进一步调用 truncateToWidth()
 * 2. 若宽度 ≤ maxWidth，直接返回
 * 3. 否则调用 truncateToWidth() 进行宽度截断
 *
 * @param str 要截断的字符串
 * @param maxWidth 最大终端列宽（终端列数）
 * @param singleLine 是否在首个换行符处截断，默认 false
 * @returns 截断后的字符串
 */
export function truncate(
  str: string,
  maxWidth: number,
  singleLine: boolean = false,
): string {
  let result = str

  // 单行模式：在首个换行符处截断
  if (singleLine) {
    const firstNewline = str.indexOf('\n')
    if (firstNewline !== -1) {
      result = str.substring(0, firstNewline)
      // 截断后的单行加省略号是否超出 maxWidth
      if (stringWidth(result) + 1 > maxWidth) {
        return truncateToWidth(result, maxWidth)
      }
      return `${result}…`
    }
  }

  // 宽度截断
  if (stringWidth(result) <= maxWidth) {
    return result
  }
  return truncateToWidth(result, maxWidth)
}

/**
 * 按终端列宽换行：将长文本拆分为宽度不超过 width 的多行数组。
 * 在 grapheme 边界处拆分，正确处理 CJK 和 emoji。
 *
 * 流程：
 * 1. 逐 grapheme 累加宽度
 * 2. 当前 grapheme 加入后仍在宽度内 → 追加到当前行
 * 3. 超出宽度 → 将当前行推入结果，以当前 grapheme 开启新行
 * 4. 最后一行若非空推入结果
 *
 * @param text 要换行的字符串
 * @param width 每行最大终端列宽
 * @returns 换行后的行数组
 */
export function wrapText(text: string, width: number): string[] {
  const lines: string[] = []
  let currentLine = ''
  let currentWidth = 0

  for (const { segment } of getGraphemeSegmenter().segment(text)) {
    const segWidth = stringWidth(segment)
    if (currentWidth + segWidth <= width) {
      // 仍在宽度内，追加到当前行
      currentLine += segment
      currentWidth += segWidth
    } else {
      // 超出宽度，结束当前行，开启新行
      if (currentLine) lines.push(currentLine)
      currentLine = segment
      currentWidth = segWidth
    }
  }

  // 将最后一行推入结果
  if (currentLine) lines.push(currentLine)
  return lines
}
