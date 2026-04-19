/**
 * Vim 移动（Motion）函数模块
 *
 * 在 Claude Code 的 Vim 模式系统中，本文件处于核心计算层：
 * - 上层：transitions.ts 负责解析按键序列，调用此模块将按键映射为光标位移
 * - 本层：提供纯函数，根据当前 Cursor 位置和按键计算目标位置（不产生任何副作用）
 * - 下层：Cursor 类（utils/Cursor.ts）封装实际的文本导航原语
 *
 * 所有函数均为纯函数，仅做计算，不修改任何状态。
 */

import type { Cursor } from '../utils/Cursor.js'

/**
 * 将一个移动键解析为目标光标位置。
 *
 * 流程：
 * 1. 以当前 cursor 为起点，循环执行 count 次单步移动
 * 2. 若某次移动后位置未变（已到边界），提前终止循环
 * 3. 返回最终目标 Cursor（不修改原始状态）
 *
 * @param key    Vim 移动键，如 'h'/'l'/'w'/'b' 等
 * @param cursor 当前光标位置
 * @param count  重复执行次数（如 3w 表示向后移动 3 个单词）
 */
export function resolveMotion(
  key: string,
  cursor: Cursor,
  count: number,
): Cursor {
  let result = cursor
  for (let i = 0; i < count; i++) {
    const next = applySingleMotion(key, result) // 执行一次单步移动
    if (next.equals(result)) break // 位置未变化（到达边界），提前终止
    result = next
  }
  return result
}

/**
 * 执行单次移动步骤，将 Vim 按键映射到对应的 Cursor 导航方法。
 *
 * 本函数是所有移动键的分发中心：
 * - h/l/j/k：基础四向移动
 * - gj/gk：视觉行（折行）移动
 * - w/b/e/W/B/E：单词级移动（小写为 vim-word，大写为 WORD）
 * - 0/^/$：行首/首非空白/行尾
 * - G：跳转到最后一行
 *
 * @param key    Vim 移动键字符串
 * @param cursor 当前光标
 * @returns      移动后的新 Cursor；若未匹配则原样返回
 */
function applySingleMotion(key: string, cursor: Cursor): Cursor {
  switch (key) {
    case 'h':
      return cursor.left()                      // 向左移动一个字符
    case 'l':
      return cursor.right()                     // 向右移动一个字符
    case 'j':
      return cursor.downLogicalLine()           // 向下移动一个逻辑行
    case 'k':
      return cursor.upLogicalLine()             // 向上移动一个逻辑行
    case 'gj':
      return cursor.down()                      // 向下移动一个视觉行（折行时与 j 不同）
    case 'gk':
      return cursor.up()                        // 向上移动一个视觉行
    case 'w':
      return cursor.nextVimWord()               // 跳到下一个 vim-word 开头
    case 'b':
      return cursor.prevVimWord()               // 跳到上一个 vim-word 开头
    case 'e':
      return cursor.endOfVimWord()              // 跳到当前/下一个 vim-word 末尾
    case 'W':
      return cursor.nextWORD()                  // 跳到下一个 WORD 开头（以空白符分隔）
    case 'B':
      return cursor.prevWORD()                  // 跳到上一个 WORD 开头
    case 'E':
      return cursor.endOfWORD()                 // 跳到当前/下一个 WORD 末尾
    case '0':
      return cursor.startOfLogicalLine()        // 跳到逻辑行绝对开头（列 0）
    case '^':
      return cursor.firstNonBlankInLogicalLine() // 跳到逻辑行第一个非空白字符
    case '$':
      return cursor.endOfLogicalLine()          // 跳到逻辑行末尾
    case 'G':
      return cursor.startOfLastLine()           // 跳到文本最后一行开头
    default:
      return cursor                             // 未识别的键，光标不移动
  }
}

/**
 * 判断某个移动是否为"包含式"（inclusive）移动。
 *
 * 包含式移动在与操作符（d/c/y）组合时，会将目标字符本身也纳入操作范围。
 * 例如：'de' 会删除到当前单词末尾字符（含末尾字符）。
 * e、E、$ 均为包含式移动；h、l、w 等为排他式（exclusive）。
 *
 * @param key Vim 移动键
 * @returns   true 表示目标字符被包含在操作范围内
 */
export function isInclusiveMotion(key: string): boolean {
  return 'eE$'.includes(key) // e、E、$ 为包含式移动
}

/**
 * 判断某个移动是否为"行级"（linewise）移动。
 *
 * 行级移动在与操作符组合时，操作范围会扩展为完整的行（从行首到行尾含换行符）。
 * 例如：'dj' 会删除当前行和下一行。
 * 注意：gj/gk 是字符级排他移动（参见 `:help gj`），不是行级移动。
 *
 * @param key Vim 移动键
 * @returns   true 表示操作范围应扩展为完整行
 */
export function isLinewiseMotion(key: string): boolean {
  return 'jkG'.includes(key) || key === 'gg' // j、k、G、gg 为行级移动
}
