/**
 * 文件：widest-line.ts
 *
 * 【在 Claude Code 系统流程中的位置】
 * 本文件是 Ink 层的文本宽度工具模块，用于计算多行字符串中最宽行的显示宽度。
 * Yoga 布局引擎需要精确的内容宽度来计算节点尺寸，
 * wrap-text.ts、measure.ts 等渲染辅助模块通过此函数获取多行文本的最大列宽。
 *
 * 【主要功能】
 * - `widestLine(string)`：遍历 '\n' 分割的每一行，
 *   使用 lineWidth（来自 line-width-cache.ts，缓存了字素簇宽度计算结果）
 *   计算各行显示宽度，返回最大值。
 */

import { lineWidth } from './line-width-cache.js'

/**
 * 计算多行字符串中最宽行的终端显示宽度（列数）。
 *
 * 【流程】
 * 1. 初始化 maxWidth=0 和 start=0（当前行起始索引）
 * 2. 循环查找下一个 '\n' 的位置：
 *    - 未找到（end=-1）→ 取从 start 到字符串末尾的最后一行
 *    - 找到 → 取 [start, end) 子字符串为当前行
 * 3. 调用 lineWidth(line) 获取该行的终端显示宽度（考虑全角字符/emoji 占两列）
 * 4. 更新 maxWidth = Math.max(maxWidth, 当前行宽度)
 * 5. 若 end=-1（已处理最后一行）→ break；否则 start = end+1 继续下一行
 *
 * 使用手动索引遍历而非 split('\n') 以避免创建额外数组，
 * 并通过 lineWidth 的缓存机制减少重复计算开销。
 *
 * @param string 待测量的多行字符串（行间以 '\n' 分隔）
 * @returns 所有行中的最大终端显示宽度（列数）
 */
export function widestLine(string: string): number {
  let maxWidth = 0
  let start = 0

  while (start <= string.length) {
    // 查找当前行的结束位置
    const end = string.indexOf('\n', start)
    // end=-1 时取到字符串末尾；否则取到换行符前
    const line =
      end === -1 ? string.substring(start) : string.substring(start, end)

    // 更新最大宽度（lineWidth 支持全角/emoji 的双列宽计算，并有缓存）
    maxWidth = Math.max(maxWidth, lineWidth(line))

    // 已处理最后一行（无更多换行符）→ 退出循环
    if (end === -1) break
    // 移动到下一行的起始位置
    start = end + 1
  }

  return maxWidth
}
