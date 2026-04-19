/**
 * 文件：wrap-text.ts
 *
 * 【在 Claude Code 系统流程中的位置】
 * 本文件是 Ink 层的文本折行/截断工具模块，实现 Yoga 布局引擎所需的 textWrap 样式属性。
 * render.ts 和 measure.ts 在渲染节点文本内容时调用此模块，
 * 根据节点的 textWrap 样式属性将超宽文本折行或截断为符合列宽限制的字符串。
 *
 * 【主要功能】
 * - `sliceFit(text, start, end)`：安全地按列宽切片 ANSI 文本（处理边界全角字符溢出）
 * - `truncate(text, columns, position)`：将文本截断到指定列宽，插入省略号 '…'
 *   支持三种截断位置：'end'（末尾）、'middle'（中间）、'start'（开头）
 * - `wrapText(text, maxWidth, wrapType)`：根据 textWrap 类型分发处理：
 *   - 'wrap'：软折行（wrapAnsi，保留空格）
 *   - 'wrap-trim'：折行并裁剪行首尾空格
 *   - 'truncate' / 'truncate-end'：末尾截断
 *   - 'truncate-middle'：中间截断
 *   - 'truncate-start'：开头截断
 */

import sliceAnsi from '../utils/sliceAnsi.js'
import { stringWidth } from './stringWidth.js'
import type { Styles } from './styles.js'
import { wrapAnsi } from './wrapAnsi.js'

/** 省略号字符（U+2026，占 1 列） */
const ELLIPSIS = '…'

/**
 * 安全地按列位切片 ANSI 文本，处理全角字符边界溢出问题。
 *
 * 【问题背景】
 * sliceAnsi 按列位切片时，若边界恰好落在全角字符（CJK、emoji）的第二列，
 * 会将该字符包含进切片，导致实际宽度比预期多 1 列。
 * 本函数通过检测切片后的实际宽度，若超出预期则退一步重切一次（最多重试一次）。
 *
 * @param text 带 ANSI 转义序列的文本
 * @param start 起始列位（包含）
 * @param end 终止列位（不包含）
 * @returns 宽度不超过 end-start 的切片结果
 */
function sliceFit(text: string, start: number, end: number): string {
  const s = sliceAnsi(text, start, end)
  // 若实际宽度超出预期（全角字符边界溢出），退一列重切
  return stringWidth(s) > end - start ? sliceAnsi(text, start, end - 1) : s
}

/**
 * 将文本截断到指定列宽，在截断位置插入省略号（'…'）。
 *
 * 【处理逻辑】
 * - columns < 1 → 返回空字符串
 * - columns === 1 → 返回单个省略号
 * - 实际宽度 ≤ columns → 原样返回（无需截断）
 * - position === 'start' → 省略号在开头：`…` + 右侧 (columns-1) 列
 * - position === 'middle' → 省略号在中间：前半 + `…` + 后半（前半占 floor(columns/2) 列）
 * - position === 'end'（默认）→ 省略号在末尾：左侧 (columns-1) 列 + `…`
 *
 * 所有切片均通过 sliceFit 避免全角字符边界溢出。
 *
 * @param text 待截断的文本（可含 ANSI 转义序列）
 * @param columns 目标列宽
 * @param position 省略号插入位置
 * @returns 截断后的文本
 */
function truncate(
  text: string,
  columns: number,
  position: 'start' | 'middle' | 'end',
): string {
  if (columns < 1) return ''
  if (columns === 1) return ELLIPSIS

  const length = stringWidth(text)
  if (length <= columns) return text  // 已在列宽内，无需截断

  if (position === 'start') {
    // 省略号在开头：保留右侧 (columns-1) 列
    return ELLIPSIS + sliceFit(text, length - columns + 1, length)
  }
  if (position === 'middle') {
    // 省略号在中间：前半占 floor(columns/2) 列，后半占剩余列
    const half = Math.floor(columns / 2)
    return (
      sliceFit(text, 0, half) +
      ELLIPSIS +
      sliceFit(text, length - (columns - half) + 1, length)
    )
  }
  // 省略号在末尾（默认）：保留左侧 (columns-1) 列
  return sliceFit(text, 0, columns - 1) + ELLIPSIS
}

/**
 * 根据 textWrap 样式属性对文本进行折行或截断处理。
 *
 * 【wrapType 分发规则】
 * - 'wrap'：调用 wrapAnsi（trim=false, hard=true），按列硬折行，保留空格
 * - 'wrap-trim'：调用 wrapAnsi（trim=true, hard=true），折行并去除行首尾空格
 * - 'truncate' / 'truncate-end'：末尾截断（省略号在末尾）
 * - 'truncate-middle'：中间截断
 * - 'truncate-start'：开头截断
 * - 其他（包括 undefined）：原样返回（不处理）
 *
 * @param text 待处理的文本（可含 ANSI 转义序列）
 * @param maxWidth 目标最大列宽（来自 Yoga 布局计算结果）
 * @param wrapType 文本折行/截断类型（来自节点 styles.textWrap）
 * @returns 处理后的文本字符串
 */
export default function wrapText(
  text: string,
  maxWidth: number,
  wrapType: Styles['textWrap'],
): string {
  if (wrapType === 'wrap') {
    // 软折行：保留空格，硬折行（超过 maxWidth 强制换行）
    return wrapAnsi(text, maxWidth, {
      trim: false,
      hard: true,
    })
  }

  if (wrapType === 'wrap-trim') {
    // 折行并去除行首尾空格
    return wrapAnsi(text, maxWidth, {
      trim: true,
      hard: true,
    })
  }

  if (wrapType!.startsWith('truncate')) {
    // 截断模式：根据具体类型确定省略号位置
    let position: 'end' | 'middle' | 'start' = 'end'  // 默认末尾截断

    if (wrapType === 'truncate-middle') {
      position = 'middle'
    }

    if (wrapType === 'truncate-start') {
      position = 'start'
    }

    return truncate(text, maxWidth, position)
  }

  // 其他情况（如 textWrap 未设置）：原样返回
  return text
}
