/**
 * 文件：stringWidth.ts
 *
 * 【在 Claude Code 系统流程中的位置】
 * 本文件位于 Ink 渲染层的底层基础工具链中。
 * Claude Code 使用自定义 Ink（基于 React 的终端渲染框架）来绘制 TUI 界面，
 * 在布局计算、文本换行、截断等所有需要知道字符占用终端列数的地方，
 * 都会调用本文件导出的 `stringWidth` 函数。
 *
 * 【主要功能】
 * 计算字符串在终端中的"显示宽度"（即占用的列数）。
 * 不同于简单的 `str.length`，终端中：
 *   - 中日韩等东亚宽字符占 2 列
 *   - Emoji 占 2 列（部分特殊情形为 1 列）
 *   - ANSI 转义码（颜色、样式）占 0 列
 *   - 组合字符（变音符号、连接符等）占 0 列
 *
 * 运行时优先使用 Bun 内置的 `Bun.stringWidth`（性能更高），
 * 若不在 Bun 环境则回退到纯 JavaScript 实现 `stringWidthJavaScript`。
 */

import emojiRegex from 'emoji-regex'
import { eastAsianWidth } from 'get-east-asian-width'
import stripAnsi from 'strip-ansi'
import { getGraphemeSegmenter } from '../utils/intl.js'

// 预编译 emoji 正则，避免在每次调用时重新构造（性能优化）
const EMOJI_REGEX = emojiRegex()

/**
 * `stringWidthJavaScript`：在 Bun.stringWidth 不可用时的纯 JS 回退实现。
 *
 * 【整体流程】
 * 1. 空字符串 / 非字符串 → 直接返回 0
 * 2. 纯 ASCII 快速路径：无宽字符、无 ANSI 码，直接计数可见字符
 * 3. 含 ANSI 转义码 → 先用 stripAnsi 剥离
 * 4. 不含 emoji/变体选择符 → 逐码点累加东亚宽度（无需分词）
 * 5. 含复杂 Unicode → 通过 Intl.Segmenter 分出字形簇，逐簇计算宽度
 *
 * 与 npm 的 `string-width` 包相比，本实现对 ambiguous-width 字符（如 ⚠ U+26A0）
 * 使用 `ambiguousAsWide: false`，以 Unicode 标准推荐的"西文上下文视为窄"处理，
 * 避免误报为 2 列。
 */
function stringWidthJavaScript(str: string): number {
  // 非字符串或空字符串直接返回 0
  if (typeof str !== 'string' || str.length === 0) {
    return 0
  }

  // 快速路径：检查是否为纯 ASCII（无 ANSI 转义、无宽字符）
  let isPureAscii = true
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i)
    // 码点 >= 127 为非 ASCII；0x1b 为 ESC（ANSI 转义开头）
    if (code >= 127 || code === 0x1b) {
      isPureAscii = false
      break
    }
  }
  if (isPureAscii) {
    // 纯 ASCII：只计算可打印字符（跳过控制字符，码点 <= 0x1f）
    let width = 0
    for (let i = 0; i < str.length; i++) {
      const code = str.charCodeAt(i)
      if (code > 0x1f) {
        width++
      }
    }
    return width
  }

  // 含 ANSI 转义码时，先剥离所有 ANSI 序列再计算宽度
  if (str.includes('\x1b')) {
    str = stripAnsi(str)
    if (str.length === 0) {
      return 0 // 纯 ANSI 序列，无可见字符
    }
  }

  // 简单 Unicode 快速路径：不含 emoji、变体选择符、ZWJ 连接符时，
  // 直接逐码点累加东亚宽度，无需启动 Intl.Segmenter
  if (!needsSegmentation(str)) {
    let width = 0
    for (const char of str) {
      const codePoint = char.codePointAt(0)!
      if (!isZeroWidth(codePoint)) {
        // ambiguousAsWide: false → 模糊宽度字符按窄处理
        width += eastAsianWidth(codePoint, { ambiguousAsWide: false })
      }
    }
    return width
  }

  let width = 0

  // 使用 Intl.Segmenter 将字符串分割为字形簇（grapheme clusters）
  for (const { segment: grapheme } of getGraphemeSegmenter().segment(str)) {
    // 优先判断 emoji（大多数 emoji 序列宽度为 2）
    EMOJI_REGEX.lastIndex = 0 // 重置有状态正则的位置
    if (EMOJI_REGEX.test(grapheme)) {
      width += getEmojiWidth(grapheme)
      continue
    }

    // 非 emoji 字形簇：
    // 对于如 Devanagari 连体字（ka+virama+ZWJ+ssa）等复合字形，
    // 只取第一个非零宽码点的宽度（整个簇渲染为一个字形）
    for (const char of grapheme) {
      const codePoint = char.codePointAt(0)!
      if (!isZeroWidth(codePoint)) {
        width += eastAsianWidth(codePoint, { ambiguousAsWide: false })
        break // 只取第一个有宽度的码点
      }
    }
  }

  return width
}

/**
 * 判断字符串是否含有需要字形簇分词的特殊 Unicode 字符。
 * 若不含 emoji 范围、变体选择符或 ZWJ，则可走快速路径直接逐码点计算。
 */
function needsSegmentation(str: string): boolean {
  for (const char of str) {
    const cp = char.codePointAt(0)!
    // 各类 emoji 码点范围
    if (cp >= 0x1f300 && cp <= 0x1faff) return true
    if (cp >= 0x2600 && cp <= 0x27bf) return true
    // 地区指示符（国旗 emoji）
    if (cp >= 0x1f1e6 && cp <= 0x1f1ff) return true
    // 变体选择符（VS1–VS16，用于指定 emoji 呈现方式）
    if (cp >= 0xfe00 && cp <= 0xfe0f) return true
    // ZWJ（Zero Width Joiner），用于组合 emoji 序列
    if (cp === 0x200d) return true
  }
  return false
}

/**
 * 计算单个 emoji 字形簇的显示宽度。
 * 处理两类特殊情形：
 * 1. 地区指示符对（国旗）：单个 = 1，配对 = 2
 * 2. 不完整 keycap（数字/符号 + VS16，缺少 U+20E3）：宽度为 1
 * 其余 emoji 一律返回 2。
 */
function getEmojiWidth(grapheme: string): number {
  // 地区指示符 A–Z（U+1F1E6 – U+1F1FF）
  const first = grapheme.codePointAt(0)!
  if (first >= 0x1f1e6 && first <= 0x1f1ff) {
    // 统计码点数：单个指示符宽度 1，配对（国旗）宽度 2
    let count = 0
    for (const _ of grapheme) count++
    return count === 1 ? 1 : 2
  }

  // 不完整 keycap：ASCII 数字/# 或 * + VS16（U+FE0F），没有 U+20E3 组合字符
  if (grapheme.length === 2) {
    const second = grapheme.codePointAt(1)
    if (
      second === 0xfe0f &&
      ((first >= 0x30 && first <= 0x39) || first === 0x23 || first === 0x2a)
    ) {
      return 1 // 仅有基字符 + 变体选择符，未形成完整 keycap
    }
  }

  // 其余 emoji 均为 2 列
  return 2
}

/**
 * 判断一个 Unicode 码点是否为"零宽"字符（即在终端中不占列宽）。
 * 覆盖范围：
 * - 控制字符（C0/C1 区域）
 * - 零宽空格、零宽连接符、BOM、Word Joiner 等
 * - 变体选择符（VS1–VS256）
 * - 组合变音符号（Combining Diacritical Marks）
 * - 印度系文字组合符号（梵文–马拉雅拉姆文）
 * - 泰文/老挝文组合标记
 * - 阿拉伯文格式字符
 * - 代理对（Surrogates）和标签字符
 */
function isZeroWidth(codePoint: number): boolean {
  // 快速路径：常见可打印 ASCII 范围（U+0020 – U+007E），宽度肯定非零
  if (codePoint >= 0x20 && codePoint < 0x7f) return false
  // 常见非 ASCII 可打印范围，仅软连字符（U+00AD）例外
  if (codePoint >= 0xa0 && codePoint < 0x0300) return codePoint === 0x00ad

  // C0/C1 控制字符（U+0000–U+001F 及 U+007F–U+009F）
  if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) return true

  // 零宽字符及不可见格式符
  if (
    (codePoint >= 0x200b && codePoint <= 0x200d) || // 零宽空格 / 非连接符 / 连接符
    codePoint === 0xfeff || // BOM（字节顺序标记）
    (codePoint >= 0x2060 && codePoint <= 0x2064) // Word Joiner 等
  ) {
    return true
  }

  // 变体选择符 VS1–VS16（U+FE00–U+FE0F）及 VS17–VS256（U+E0100–U+E01EF）
  if (
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
    (codePoint >= 0xe0100 && codePoint <= 0xe01ef)
  ) {
    return true
  }

  // 组合变音符号（Combining Diacritical Marks 等五个区块）
  if (
    (codePoint >= 0x0300 && codePoint <= 0x036f) ||
    (codePoint >= 0x1ab0 && codePoint <= 0x1aff) ||
    (codePoint >= 0x1dc0 && codePoint <= 0x1dff) ||
    (codePoint >= 0x20d0 && codePoint <= 0x20ff) ||
    (codePoint >= 0xfe20 && codePoint <= 0xfe2f)
  ) {
    return true
  }

  // 印度系文字组合符号（梵文 U+0900 – 马拉雅拉姆文 U+0D4F）
  if (codePoint >= 0x0900 && codePoint <= 0x0d4f) {
    // 利用每个文字区块固定 128 字节对齐的规律，提取区块内偏移量
    const offset = codePoint & 0x7f
    if (offset <= 0x03) return true // 区块起始处的符号标记
    if (offset >= 0x3a && offset <= 0x4f) return true // 元音符号、Virama（消音符）
    if (offset >= 0x51 && offset <= 0x57) return true // 声调符号
    if (offset >= 0x62 && offset <= 0x63) return true // 独立元音符号
  }

  // 泰文 / 老挝文组合标记
  // 注：U+0E32/U+0E33（SARA AA/AM）和 U+0EB2/U+0EB3 是有间距的元音（宽度 1），不是组合符号
  if (
    codePoint === 0x0e31 || // 泰文 MAI HAN-AKAT
    (codePoint >= 0x0e34 && codePoint <= 0x0e3a) || // 泰文元音符号（跳过 U+0E32/0E33）
    (codePoint >= 0x0e47 && codePoint <= 0x0e4e) || // 泰文元音符号及标记
    codePoint === 0x0eb1 || // 老挝文 MAI KAN
    (codePoint >= 0x0eb4 && codePoint <= 0x0ebc) || // 老挝文元音符号（跳过 U+0EB2/0EB3）
    (codePoint >= 0x0ec8 && codePoint <= 0x0ecd) // 老挝文声调标记
  ) {
    return true
  }

  // 阿拉伯文格式字符（不可见的方向/数字格式控制符）
  if (
    (codePoint >= 0x0600 && codePoint <= 0x0605) ||
    codePoint === 0x06dd ||
    codePoint === 0x070f ||
    codePoint === 0x08e2
  ) {
    return true
  }

  // 代理对（UTF-16 编码中的高/低代理，不是独立字符）
  if (codePoint >= 0xd800 && codePoint <= 0xdfff) return true
  // Unicode 标签字符（U+E0000–U+E007F，用于语言标签，终端不显示）
  if (codePoint >= 0xe0000 && codePoint <= 0xe007f) return true

  return false
}

// --- 运行时选择 Bun 原生实现或 JS 回退 ---
//
// 注意（关于 Devanagari 等复杂文字）：
// 如 क्ष（ka + virama + ZWJ + ssa）这类连体字形，
// 终端实际分配 2 个单元格（wcwidth 对基字符求和），
// Bun.stringWidth=2 与终端行为一致，可保证光标定位正确；
// 而 JS 回退的字形簇宽度为 1，会导致 Ink 布局与终端不同步。
//
// `bunStringWidth` 在模块级别解析一次，而非每次调用时检查 typeof，
// 因为 typeof 保护会导致属性访问去优化，而这是一条热路径（每帧约 10 万次调用）。
const bunStringWidth =
  typeof Bun !== 'undefined' && typeof Bun.stringWidth === 'function'
    ? Bun.stringWidth
    : null

// Bun.stringWidth 的选项：将模糊宽度字符视为窄字符（与 JS 实现行为一致）
const BUN_STRING_WIDTH_OPTS = { ambiguousIsNarrow: true } as const

/**
 * 计算字符串在终端中的显示宽度（占用列数）。
 *
 * 优先使用 Bun 内置实现（性能更佳），否则回退到 `stringWidthJavaScript`。
 * 所有上层模块（布局、换行、截断等）均应通过此导出函数获取字符串宽度。
 */
export const stringWidth: (str: string) => number = bunStringWidth
  ? str => bunStringWidth(str, BUN_STRING_WIDTH_OPTS)
  : stringWidthJavaScript
