/**
 * 【文件定位】通用工具层 — 终端文本渲染工具
 *
 * 在 Claude Code 系统流程中的位置：
 *   工具执行结果（bash、文件读写等）→ 本模块对长输出进行折行与截断处理
 *   → 渲染后的文本交给 Ink 组件（OutputLine 等）展示给用户
 *
 * 主要职责：
 *   1. wrapText()                — ANSI 感知折行，将超宽行切分为 wrapWidth 宽度的块
 *   2. renderTruncatedContent()  — 截断超过 MAX_LINES_TO_SHOW 行的输出，追加"… +N lines"提示
 *   3. isOutputLineTruncated()   — 快速判断内容是否会被截断（O(N) 换行符计数）
 */

import chalk from 'chalk'
import { ctrlOToExpand } from '../components/CtrlOToExpand.js'
import { stringWidth } from '../ink/stringWidth.js'
import sliceAnsi from './sliceAnsi.js'

// 终端显示最多展示的行数（超出后截断并显示"… +N lines"）
const MAX_LINES_TO_SHOW = 3
// 预留给 MessageResponse 前缀（"  ⎿ " = 5 字符）以及父容器缩减（columns - 5）的溢出缓冲
const PADDING_TO_PREVENT_OVERFLOW = 10

/**
 * 对字符串进行 ANSI 感知的自动折行，不会切断转义序列。
 *
 * 流程：
 *   1. 按 '\n' 分割原始文本为多行
 *   2. 对每一行：若可见宽度 ≤ wrapWidth 则直接保留；否则用 sliceAnsi 按 wrapWidth 切块
 *   3. 收集所有折行后的行，计算 remainingLines（超出 MAX_LINES_TO_SHOW 的部分）
 *   4. 特殊：若 remainingLines === 1，则多显示一行（避免出现"… +1 line"这种尴尬提示）
 *
 * @param text      要折行的文本
 * @param wrapWidth 折行宽度（以可见字符数计算，不含 ANSI 转义）
 * @returns { aboveTheFold: 折叠线以上的文本, remainingLines: 未显示的行数 }
 */
function wrapText(
  text: string,
  wrapWidth: number,
): { aboveTheFold: string; remainingLines: number } {
  const lines = text.split('\n')
  const wrappedLines: string[] = []

  for (const line of lines) {
    const visibleWidth = stringWidth(line) // 获取不含 ANSI 的可见字符宽度
    if (visibleWidth <= wrapWidth) {
      // 行宽不超限，直接去掉行尾空白后保留
      wrappedLines.push(line.trimEnd())
    } else {
      // 超宽行：用 ANSI 感知切片将其分割为 wrapWidth 宽度的块
      let position = 0
      while (position < visibleWidth) {
        const chunk = sliceAnsi(line, position, position + wrapWidth)
        wrappedLines.push(chunk.trimEnd())
        position += wrapWidth
      }
    }
  }

  const remainingLines = wrappedLines.length - MAX_LINES_TO_SHOW

  // 如果折叠后仅剩 1 行，直接显示它而非输出"... +1 line (ctrl+o to expand)"
  if (remainingLines === 1) {
    return {
      aboveTheFold: wrappedLines
        .slice(0, MAX_LINES_TO_SHOW + 1)
        .join('\n')
        .trimEnd(),
      remainingLines: 0, // 全部行都已展示，没有剩余
    }
  }

  // 标准模式：显示 MAX_LINES_TO_SHOW 行，剩余行数不少于 0
  return {
    aboveTheFold: wrappedLines.slice(0, MAX_LINES_TO_SHOW).join('\n').trimEnd(),
    remainingLines: Math.max(0, remainingLines),
  }
}

/**
 * 将内容渲染为终端可显示的截断格式。
 *
 * 流程：
 *   1. trimEnd 去掉尾部空白；空内容直接返回 ''
 *   2. 计算 wrapWidth（终端宽度 - PADDING_TO_PREVENT_OVERFLOW，至少 10）
 *   3. 预截断优化：超大输出（如 64MB 二进制转储）只取前 maxChars 字符，
 *      避免 O(n) 折行导致展示 38 万行的极端情况
 *   4. 调用 wrapText 折行，得到 aboveTheFold 和 remainingLines
 *   5. 若有预截断，修正 estimatedRemaining（用总长度估算真实剩余行数）
 *   6. 返回 aboveTheFold + 可选的 chalk.dim("… +N lines ctrl+o") 提示
 *
 * @param content            原始内容字符串
 * @param terminalWidth      终端列数
 * @param suppressExpandHint 为 true 时省略 ctrl+o 展开提示（默认 false）
 */
export function renderTruncatedContent(
  content: string,
  terminalWidth: number,
  suppressExpandHint = false,
): string {
  const trimmedContent = content.trimEnd()
  if (!trimmedContent) {
    return ''
  }

  // 计算有效折行宽度，至少保留 10 字符避免除零
  const wrapWidth = Math.max(terminalWidth - PADDING_TO_PREVENT_OVERFLOW, 10)

  // 预截断：只处理可见行所需的字符量，避免对超大输出进行全量折行
  const maxChars = MAX_LINES_TO_SHOW * wrapWidth * 4
  const preTruncated = trimmedContent.length > maxChars
  const contentForWrapping = preTruncated
    ? trimmedContent.slice(0, maxChars)
    : trimmedContent

  const { aboveTheFold, remainingLines } = wrapText(
    contentForWrapping,
    wrapWidth,
  )

  // 若发生了预截断，用总长度估算真实剩余行数（取两者中的较大值）
  const estimatedRemaining = preTruncated
    ? Math.max(
        remainingLines,
        Math.ceil(trimmedContent.length / wrapWidth) - MAX_LINES_TO_SHOW,
      )
    : remainingLines

  return [
    aboveTheFold,
    estimatedRemaining > 0
      ? chalk.dim(
          `… +${estimatedRemaining} lines${suppressExpandHint ? '' : ` ${ctrlOToExpand()}`}`,
        )
      : '',
  ]
    .filter(Boolean)
    .join('\n')
}

/**
 * 快速判断 OutputLine 是否会对给定内容进行截断。
 *
 * 只统计原始换行符数量，不考虑终端宽度折行，因此对于"单行超宽"的情况
 * 可能返回 false（可接受的假阴性，因为多行输出才是常见场景）。
 *
 * 实现：计数遍历字符串，找到第 MAX_LINES_TO_SHOW+1 个换行符；
 * 尾部换行符视为终止符（与 renderTruncatedContent 的 trimEnd 行为一致）。
 */
export function isOutputLineTruncated(content: string): boolean {
  let pos = 0
  // 需要找到超过 MAX_LINES_TO_SHOW 个换行符（+1 是因为 wrapText 在 remainingLines==1 时多显示一行）
  for (let i = 0; i <= MAX_LINES_TO_SHOW; i++) {
    pos = content.indexOf('\n', pos)
    if (pos === -1) return false
    pos++
  }
  // 若最后一个换行符之后还有内容，则确实会截断（排除纯尾部换行符的情况）
  return pos < content.length
}
