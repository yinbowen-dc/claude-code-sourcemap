/**
 * 文件：termio/esc.ts
 *
 * 【在 Claude Code 系统流程中的位置】
 * 本文件是 termio 子模块的简单 ESC 序列解析器。
 * 与 CSI（ESC [）和 OSC（ESC ]）不同，简单 ESC 序列仅由 ESC 后跟
 * 一到两个字符组成（无参数），用于执行终端重置、光标保存/恢复、
 * 索引移动、字符集切换等操作。
 * parser.ts 在识别到 'esc' 类型的 token 后调用此函数进行语义解析。
 *
 * 【主要功能】
 * `parseEsc(chars)`：将 ESC 后的字符串解析为语义 Action 或 null。
 *
 * 【支持的序列】
 * - ESC c：RIS（终端完全重置）
 * - ESC 7：DECSC（保存光标位置）
 * - ESC 8：DECRC（恢复光标位置）
 * - ESC D：IND（光标下移一行）
 * - ESC M：RI（光标上移一行，Reverse Index）
 * - ESC E：NEL（Next Line，移至下一行首）
 * - ESC H：HTS（水平制表停靠点设置，当前忽略）
 * - ESC ( X / ESC ) X：字符集切换（静默忽略）
 * - 其他：返回 unknown 类型 Action
 */

import type { Action } from './types.js'

/**
 * 解析简单 ESC 序列（ESC 后跟一或两个字符）。
 *
 * 【流程】
 * 1. 检查 chars 是否为空（ESC 后无字符则返回 null）
 * 2. 取第一个字符按已知命令逐一匹配：
 *    - 'c'：RIS（终端完全重置）→ { type: 'reset' }
 *    - '7'：DECSC（保存光标位置）→ cursor save action
 *    - '8'：DECRC（恢复光标位置）→ cursor restore action
 *    - 'D'：IND（Index，光标下移）→ cursor move down 1
 *    - 'M'：RI（Reverse Index，光标上移）→ cursor move up 1
 *    - 'E'：NEL（Next Line）→ cursor nextLine 1
 *    - 'H'：HTS（水平制表停靠点）→ 返回 null（当前不处理）
 *    - '(' 或 ')'：字符集切换序列 → 返回 null（静默忽略）
 * 3. 未识别的序列返回 { type: 'unknown', sequence }
 *
 * @param chars ESC 之后的字符串（不含 ESC 本身）
 * @returns 对应的语义 Action，或 null（表示已识别但无需处理）
 */
export function parseEsc(chars: string): Action | null {
  // ESC 之后没有任何字符，序列不完整，返回 null
  if (chars.length === 0) return null

  const first = chars[0]!

  // ESC c：RIS（Reset to Initial State，终端完全重置）
  if (first === 'c') {
    return { type: 'reset' }
  }

  // ESC 7：DECSC（DEC Save Cursor，保存光标位置和属性）
  if (first === '7') {
    return { type: 'cursor', action: { type: 'save' } }
  }

  // ESC 8：DECRC（DEC Restore Cursor，恢复光标位置和属性）
  if (first === '8') {
    return { type: 'cursor', action: { type: 'restore' } }
  }

  // ESC D：IND（Index，光标下移一行，到底则滚动）
  if (first === 'D') {
    return {
      type: 'cursor',
      action: { type: 'move', direction: 'down', count: 1 },
    }
  }

  // ESC M：RI（Reverse Index，光标上移一行，到顶则反向滚动）
  if (first === 'M') {
    return {
      type: 'cursor',
      action: { type: 'move', direction: 'up', count: 1 },
    }
  }

  // ESC E：NEL（Next Line，移至下一行的行首）
  if (first === 'E') {
    return { type: 'cursor', action: { type: 'nextLine', count: 1 } }
  }

  // ESC H：HTS（Horizontal Tab Set，在当前列设置制表停靠点）
  // 当前不需要处理制表停靠点，返回 null 静默忽略
  if (first === 'H') {
    return null // 制表停靠点，当前不需要处理
  }

  // ESC ( X 或 ESC ) X：字符集选择序列（如 ESC ( B 切换到 ASCII）
  // 这些序列是传统 VT100 特性，当前不需要处理，静默忽略
  if ('()'.includes(first) && chars.length >= 2) {
    return null
  }

  // 未识别的 ESC 序列：返回 unknown 类型以供上层记录/调试
  return { type: 'unknown', sequence: `\x1b${chars}` }
}
