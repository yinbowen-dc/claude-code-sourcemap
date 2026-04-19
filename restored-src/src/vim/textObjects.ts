/**
 * Vim 文本对象（Text Object）边界查找模块
 *
 * 在 Claude Code 的 Vim 模式系统中，本文件处于文本分析层：
 * - 上层：operators.ts 在执行 iw/aw/i"/a( 等命令时调用本模块确定操作范围
 * - 本层：提供纯函数，根据光标位置和对象类型查找文本对象的起止字节偏移
 * - 依赖层：utils/Cursor.ts 提供字符分类函数；utils/intl.ts 提供图形字素分段器
 *
 * 支持的文本对象类型：
 * - w/W：vim-word / WORD（以图形字素为单位，避免多字节字符截断）
 * - " ' `：引号对象（行内作用域）
 * - ( ) b / [ ] / { } B / < >：括号对象（深度计数，支持嵌套）
 */

import {
  isVimPunctuation,
  isVimWhitespace,
  isVimWordChar,
} from '../utils/Cursor.js'
import { getGraphemeSegmenter } from '../utils/intl.js'

/** 文本对象的字节范围（start 含，end 不含）；null 表示未找到 */
export type TextObjectRange = { start: number; end: number } | null

/**
 * 括号/引号对照表。
 *
 * 键为 Vim 文本对象触发字符，值为 [开符, 闭符] 对。
 * 同一括号类型的左右字符均映射到相同的 [开, 闭] 对，
 * 便于用户无论光标在开符还是闭符上都能触发对象选择。
 */
const PAIRS: Record<string, [string, string]> = {
  '(': ['(', ')'],
  ')': ['(', ')'],
  b: ['(', ')'],   // b 是 ( 的别名
  '[': ['[', ']'],
  ']': ['[', ']'],
  '{': ['{', '}'],
  '}': ['{', '}'],
  B: ['{', '}'],   // B 是 { 的别名
  '<': ['<', '>'],
  '>': ['<', '>'],
  '"': ['"', '"'],
  "'": ["'", "'"],
  '`': ['`', '`'],
}

/**
 * 查找光标处的文本对象并返回其字节范围。
 *
 * 分发策略：
 * - 'w'：调用 findWordObject，使用 isVimWordChar 判断字符类型
 * - 'W'：调用 findWordObject，使用「非空白」作为字符类型判断
 * - 其余键：查 PAIRS 表，引号（开==闭）用 findQuoteObject，括号用 findBracketObject
 * - 未识别的键：返回 null
 *
 * @param text       完整文本内容
 * @param offset     光标字节偏移
 * @param objectType 文本对象类型键（'w'/'W'/'"'/'('/'[' 等）
 * @param isInner    true → inner（不含边界）；false → around（含边界/空白）
 * @returns          文本对象的字节范围，或 null（未找到）
 */
export function findTextObject(
  text: string,
  offset: number,
  objectType: string,
  isInner: boolean,
): TextObjectRange {
  if (objectType === 'w')
    return findWordObject(text, offset, isInner, isVimWordChar) // vim-word 对象
  if (objectType === 'W')
    return findWordObject(text, offset, isInner, ch => !isVimWhitespace(ch)) // WORD 对象（以空白分隔）

  const pair = PAIRS[objectType]
  if (pair) {
    const [open, close] = pair
    return open === close
      ? findQuoteObject(text, offset, open, isInner)           // 引号对象（开闭符相同）
      : findBracketObject(text, offset, open, close, isInner)  // 括号对象（开闭符不同）
  }

  return null // 未识别的文本对象类型
}

/**
 * 查找单词/WORD 文本对象的字节范围。
 *
 * 使用图形字素分段器（getGraphemeSegmenter）将文本预分割为字素数组，
 * 避免多字节字符（emoji、CJK 等）被截断。
 *
 * 算法：
 * 1. 预分段全文，确定光标所在字素索引
 * 2. 根据光标字素的字符类型（word / 空白 / 标点）扩展范围
 * 3. around 模式：优先向右合并尾部空白，若无则向左合并前导空白
 * 4. inner 模式：仅返回同类字符的连续范围（空白序列直接返回）
 *
 * @param text        完整文本
 * @param offset      光标字节偏移
 * @param isInner     inner/around 模式
 * @param isWordChar  字符类型判断函数（vim-word 或 WORD）
 * @returns           文本对象的字节范围
 */
function findWordObject(
  text: string,
  offset: number,
  isInner: boolean,
  isWordChar: (ch: string) => boolean,
): TextObjectRange {
  // 预分段：将全文切成图形字素列表，每个元素含原始字节索引
  const graphemes: Array<{ segment: string; index: number }> = []
  for (const { segment, index } of getGraphemeSegmenter().segment(text)) {
    graphemes.push({ segment, index })
  }

  // 找出光标所在的字素索引（offset 落在哪个字素的字节范围内）
  let graphemeIdx = graphemes.length - 1
  for (let i = 0; i < graphemes.length; i++) {
    const g = graphemes[i]!
    const nextStart =
      i + 1 < graphemes.length ? graphemes[i + 1]!.index : text.length
    if (offset >= g.index && offset < nextStart) {
      graphemeIdx = i
      break
    }
  }

  // 辅助函数：按字素索引获取对应的字符串、字节偏移及字符分类
  const graphemeAt = (idx: number): string => graphemes[idx]?.segment ?? ''
  const offsetAt = (idx: number): number =>
    idx < graphemes.length ? graphemes[idx]!.index : text.length
  const isWs = (idx: number): boolean => isVimWhitespace(graphemeAt(idx))
  const isWord = (idx: number): boolean => isWordChar(graphemeAt(idx))
  const isPunct = (idx: number): boolean => isVimPunctuation(graphemeAt(idx))

  let startIdx = graphemeIdx
  let endIdx = graphemeIdx

  if (isWord(graphemeIdx)) {
    // 光标在 word 字符上：向两侧扩展到 word 边界
    while (startIdx > 0 && isWord(startIdx - 1)) startIdx--
    while (endIdx < graphemes.length && isWord(endIdx)) endIdx++
  } else if (isWs(graphemeIdx)) {
    // 光标在空白上：扩展到连续空白范围，直接返回（inner/around 相同）
    while (startIdx > 0 && isWs(startIdx - 1)) startIdx--
    while (endIdx < graphemes.length && isWs(endIdx)) endIdx++
    return { start: offsetAt(startIdx), end: offsetAt(endIdx) }
  } else if (isPunct(graphemeIdx)) {
    // 光标在标点上：向两侧扩展到标点边界
    while (startIdx > 0 && isPunct(startIdx - 1)) startIdx--
    while (endIdx < graphemes.length && isPunct(endIdx)) endIdx++
  }

  if (!isInner) {
    // around 模式：优先向右合并尾部空白，否则向左合并前导空白
    if (endIdx < graphemes.length && isWs(endIdx)) {
      while (endIdx < graphemes.length && isWs(endIdx)) endIdx++ // 合并右侧空白
    } else if (startIdx > 0 && isWs(startIdx - 1)) {
      while (startIdx > 0 && isWs(startIdx - 1)) startIdx-- // 合并左侧空白
    }
  }

  return { start: offsetAt(startIdx), end: offsetAt(endIdx) }
}

/**
 * 查找引号文本对象的字节范围（行内作用域）。
 *
 * 算法：
 * 1. 将操作限定在当前行（换行符不跨越）
 * 2. 收集行内所有目标引号的位置
 * 3. 按 0-1、2-3、4-5… 成对配对
 * 4. 找到包含光标位置的引号对，返回其范围
 * inner：[qs+1, qe)（不含引号本身）
 * around：[qs, qe+1)（含两侧引号）
 *
 * @param text    完整文本
 * @param offset  光标字节偏移
 * @param quote   引号字符（'"' / "'" / '`'）
 * @param isInner inner/around 模式
 * @returns       引号对象的字节范围，或 null（未找到匹配引号对）
 */
function findQuoteObject(
  text: string,
  offset: number,
  quote: string,
  isInner: boolean,
): TextObjectRange {
  const lineStart = text.lastIndexOf('\n', offset - 1) + 1 // 当前行起始字节偏移
  const lineEnd = text.indexOf('\n', offset)
  const effectiveEnd = lineEnd === -1 ? text.length : lineEnd // 当前行结束偏移（不含换行符）
  const line = text.slice(lineStart, effectiveEnd)
  const posInLine = offset - lineStart // 光标在当前行内的偏移

  // 收集当前行内所有目标引号的位置
  const positions: number[] = []
  for (let i = 0; i < line.length; i++) {
    if (line[i] === quote) positions.push(i)
  }

  // 按顺序成对配对：(0,1), (2,3), (4,5)…，找到包含光标的对
  for (let i = 0; i < positions.length - 1; i += 2) {
    const qs = positions[i]!      // 开引号在行内的偏移
    const qe = positions[i + 1]!  // 闭引号在行内的偏移
    if (qs <= posInLine && posInLine <= qe) {
      return isInner
        ? { start: lineStart + qs + 1, end: lineStart + qe }     // inner：不含引号
        : { start: lineStart + qs, end: lineStart + qe + 1 }     // around：含引号
    }
  }

  return null // 光标不在任何引号对内
}

/**
 * 查找括号文本对象的字节范围（支持嵌套深度计数）。
 *
 * 算法：
 * 1. 从光标位置向左扫描，使用深度计数找到最近的匹配开括号
 *    - 遇到闭括号（非当前位置）：depth++（跳过一层嵌套）
 *    - 遇到开括号：depth==0 时即为目标；否则 depth--
 * 2. 从开括号位置向右扫描，找到匹配的闭括号
 *    - 遇到开括号：depth++（进入嵌套）
 *    - 遇到闭括号：depth==0 时即为目标；否则 depth--
 * inner：[start+1, end)（不含括号本身）
 * around：[start, end+1)（含括号本身）
 *
 * @param text    完整文本
 * @param offset  光标字节偏移
 * @param open    开括号字符
 * @param close   闭括号字符
 * @param isInner inner/around 模式
 * @returns       括号对象的字节范围，或 null（未找到匹配括号）
 */
function findBracketObject(
  text: string,
  offset: number,
  open: string,
  close: string,
  isInner: boolean,
): TextObjectRange {
  let depth = 0
  let start = -1

  // 向左扫描，找到最近的匹配开括号
  for (let i = offset; i >= 0; i--) {
    if (text[i] === close && i !== offset) depth++ // 遇到闭括号（非当前位置）：跳过一层嵌套
    else if (text[i] === open) {
      if (depth === 0) {
        start = i // 找到目标开括号
        break
      }
      depth-- // 跳出一层嵌套
    }
  }
  if (start === -1) return null // 未找到开括号

  depth = 0
  let end = -1
  // 从开括号下一位向右扫描，找到匹配的闭括号
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === open) depth++          // 进入嵌套
    else if (text[i] === close) {
      if (depth === 0) {
        end = i // 找到目标闭括号
        break
      }
      depth-- // 跳出一层嵌套
    }
  }
  if (end === -1) return null // 未找到闭括号

  return isInner ? { start: start + 1, end } : { start, end: end + 1 }
}
