/**
 * 【文件定位】UI 渲染层 — ANSI 感知文本分段高亮
 *
 * 在 Claude Code 系统流程中的位置：
 *   输入框（Prompt）渲染器需要高亮特定词语（如 "ultrathink"、token budget 表达式）
 *     → thinking.ts / tokenBudget.ts 提供高亮区间 TextHighlight[]
 *     → 本模块将文本按这些区间切分为 TextSegment[]
 *     → Ink 组件使用 TextSegment.highlight 决定每段的颜色/效果
 *
 * 主要职责：
 *   1. TextHighlight / TextSegment 类型定义
 *   2. segmentTextByHighlights() — 接受文本和高亮区间，解决重叠冲突，输出段落列表
 *   3. HighlightSegmenter 类     — 维护双坐标（可见位置 vs 字符串位置），ANSI 安全地切分文本
 *   4. reduceCodes()             — 过滤掉"开闭相同"的 ANSI 代码（即无实际效果的代码）
 *
 * 关键挑战：
 *   终端彩色文本含 ANSI 转义序列，这些序列占用字节但不占屏幕宽度。
 *   高亮区间以可见字符位置标注，但字符串截取必须感知 ANSI 序列，
 *   否则会截断序列导致颜色溢出到后续文本。
 */

import {
  type AnsiCode,
  ansiCodesToString,
  reduceAnsiCodes,
  type Token,
  tokenize,
  undoAnsiCodes,
} from '@alcalzone/ansi-tokenize'
import type { Theme } from './theme.js'

/**
 * 描述一个高亮区间的元数据。
 * start/end 为可见字符位置（不含 ANSI 转义序列）。
 * priority 用于解决重叠：数值越大优先级越高。
 */
export type TextHighlight = {
  start: number          // 高亮开始位置（可见字符索引）
  end: number            // 高亮结束位置（可见字符索引，不含）
  color: keyof Theme | undefined  // 主题颜色键，undefined 表示使用默认色
  dimColor?: boolean     // 是否暗化（dim）
  inverse?: boolean      // 是否反转前景/背景色
  shimmerColor?: keyof Theme  // 闪烁动画的交替颜色
  priority: number       // 重叠时的优先级（数值越大越优先）
}

/**
 * 经过高亮分段后的文本片段。
 * text 包含原始 ANSI 序列（段首已开启正确颜色，段尾已关闭）。
 * start 是该段在原文中的可见起始位置。
 */
export type TextSegment = {
  text: string            // 片段文本（含必要的 ANSI 序列包裹）
  start: number           // 可见字符起始位置
  highlight?: TextHighlight  // 若非 undefined，该片段应被高亮渲染
}

/**
 * 将文本按高亮区间切分为 TextSegment 列表。
 *
 * 执行流程：
 *   1. 若无高亮区间，整个文本作为单个无高亮段返回
 *   2. 对区间按 start 升序排列；start 相同时按 priority 降序（高优先级先处理）
 *   3. 解决重叠：逐个检查区间是否与已确认区间有重叠，重叠则跳过
 *   4. 将无重叠区间交给 HighlightSegmenter 进行 ANSI 感知切分
 *
 * @param text        原始文本（可含 ANSI 转义序列）
 * @param highlights  高亮区间数组（可能有重叠）
 * @returns           按顺序排列的 TextSegment 列表
 */
export function segmentTextByHighlights(
  text: string,
  highlights: TextHighlight[],
): TextSegment[] {
  // 无高亮区间时直接返回整段文本
  if (highlights.length === 0) {
    return [{ text, start: 0 }]
  }

  // 排序：先按 start 升序，start 相同时按 priority 降序（高优先级者先占位）
  const sortedHighlights = [...highlights].sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start
    return b.priority - a.priority
  })

  // 解决重叠冲突：已占用区间记录在 usedRanges 中
  const resolvedHighlights: TextHighlight[] = []
  const usedRanges: Array<{ start: number; end: number }> = []

  for (const highlight of sortedHighlights) {
    // 零宽度区间（start === end）无意义，跳过
    if (highlight.start === highlight.end) continue

    // 检查当前区间是否与任何已占用区间有交叉
    const overlaps = usedRanges.some(
      range =>
        (highlight.start >= range.start && highlight.start < range.end) ||
        (highlight.end > range.start && highlight.end <= range.end) ||
        (highlight.start <= range.start && highlight.end >= range.end),
    )

    if (!overlaps) {
      // 无重叠，确认此区间并记录
      resolvedHighlights.push(highlight)
      usedRanges.push({ start: highlight.start, end: highlight.end })
    }
  }

  // 使用 ANSI 感知切分器进行实际的文本切分
  return new HighlightSegmenter(text).segment(resolvedHighlights)
}

/**
 * ANSI 感知文本切分器。
 *
 * 维护两套位置坐标：
 *   - visiblePos：当前已处理的可见字符数（ANSI 序列不计入）
 *   - stringPos：当前在原始字符串中的字节偏移（含 ANSI 序列）
 *
 * 这样切分时可以用可见位置定位，用字符串位置提取子串，
 * 保证不在 ANSI 序列中间截断。
 */
class HighlightSegmenter {
  private readonly tokens: Token[]
  // 双坐标体系：可见字符位置（供高亮区间定位）与字符串字节位置（供 substring 提取）
  private visiblePos = 0
  private stringPos = 0
  private tokenIdx = 0
  private charIdx = 0 // 当前文本 token 内的偏移（用于部分消费一个 token）
  private codes: AnsiCode[] = [] // 当前活跃的 ANSI 颜色/样式代码

  constructor(private readonly text: string) {
    // 使用 @alcalzone/ansi-tokenize 将文本分解为文本块和 ANSI 代码块
    this.tokens = tokenize(text)
  }

  /**
   * 按解决后的高亮区间列表切分文本，生成 TextSegment[]。
   *
   * 对每个高亮区间：
   *   1. 提取区间之前的普通文本段
   *   2. 提取区间内的高亮文本段，附加 highlight 元数据
   * 最后提取末尾剩余文本。
   */
  segment(highlights: TextHighlight[]): TextSegment[] {
    const segments: TextSegment[] = []

    for (const highlight of highlights) {
      // 提取高亮区间之前的普通文本
      const before = this.segmentTo(highlight.start)
      if (before) segments.push(before)

      // 提取高亮区间内的文本，标记高亮元数据
      const highlighted = this.segmentTo(highlight.end)
      if (highlighted) {
        highlighted.highlight = highlight
        segments.push(highlighted)
      }
    }

    // 提取所有高亮区间之后的剩余文本
    const after = this.segmentTo(Infinity)
    if (after) segments.push(after)

    return segments
  }

  /**
   * 从当前位置推进到目标可见位置，返回这段文本作为 TextSegment。
   *
   * 实现细节：
   *   1. 消费当前位置之前的所有 ANSI 代码（颜色开启等）
   *   2. 逐 token 推进：ANSI 代码累积到 codes 数组；文本 token 按需部分消费
   *   3. 在段首插入"恢复颜色"的 ANSI 前缀，段尾插入"关闭颜色"的 ANSI 后缀
   *      确保每个 TextSegment 都是颜色自包含的（不依赖上下文）
   */
  private segmentTo(targetVisiblePos: number): TextSegment | null {
    if (
      this.tokenIdx >= this.tokens.length ||
      targetVisiblePos <= this.visiblePos
    ) {
      return null
    }

    const visibleStart = this.visiblePos

    // 消费段首的 ANSI 代码（在第一个可见字符之前的样式代码）
    while (this.tokenIdx < this.tokens.length) {
      const token = this.tokens[this.tokenIdx]!
      if (token.type !== 'ansi') break
      this.codes.push(token)
      this.stringPos += token.code.length
      this.tokenIdx++
    }

    // 记录段起始状态
    const stringStart = this.stringPos
    const codesStart = [...this.codes]

    // 推进 token 直到到达目标可见位置
    while (
      this.visiblePos < targetVisiblePos &&
      this.tokenIdx < this.tokens.length
    ) {
      const token = this.tokens[this.tokenIdx]!

      if (token.type === 'ansi') {
        // ANSI 代码：不计入可见位置，累积到 codes
        this.codes.push(token)
        this.stringPos += token.code.length
        this.tokenIdx++
      } else {
        // 文本 token：按需部分消费
        const charsNeeded = targetVisiblePos - this.visiblePos
        const charsAvailable = token.value.length - this.charIdx
        const charsToTake = Math.min(charsNeeded, charsAvailable)

        this.stringPos += charsToTake
        this.visiblePos += charsToTake
        this.charIdx += charsToTake

        // 若当前 token 已完全消费，移到下一个 token
        if (this.charIdx >= token.value.length) {
          this.tokenIdx++
          this.charIdx = 0
        }
      }
    }

    // 若段为空（仅有尾部 ANSI 代码而无可见字符），返回 null
    if (this.stringPos === stringStart) {
      return null
    }

    // 计算段首需要恢复的颜色前缀，以及段尾关闭颜色的后缀
    const prefixCodes = reduceCodes(codesStart)
    const suffixCodes = reduceCodes(this.codes)
    this.codes = suffixCodes // 更新全局 codes 状态供下一段使用

    // ansiCodesToString 将代码数组转为 ANSI 字符串
    // undoAnsiCodes 生成对应的"关闭"代码
    const prefix = ansiCodesToString(prefixCodes)
    const suffix = ansiCodesToString(undoAnsiCodes(suffixCodes))

    return {
      text: prefix + this.text.substring(stringStart, this.stringPos) + suffix,
      start: visibleStart,
    }
  }
}

/**
 * 从 ANSI 代码列表中过滤掉无效代码。
 * 若某代码的开启序列与关闭序列相同（code === endCode），
 * 说明该代码实际无样式效果，移除以减少冗余序列。
 */
function reduceCodes(codes: AnsiCode[]): AnsiCode[] {
  return reduceAnsiCodes(codes).filter(c => c.code !== c.endCode)
}
