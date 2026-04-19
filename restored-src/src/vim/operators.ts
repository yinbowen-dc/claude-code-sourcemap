/**
 * Vim 操作符（Operator）函数模块
 *
 * 在 Claude Code 的 Vim 模式系统中，本文件处于文本变换执行层：
 * - 上层：transitions.ts 解析按键序列，确定操作符与动作后调用本模块
 * - 本层：提供纯函数，执行 delete/change/yank 及 x/r/~/J/p/>/o 等命令，完成实际文本变更
 * - 依赖层：motions.ts 提供目标光标位置计算；textObjects.ts 提供文本对象边界；Cursor.ts 封装文本导航原语
 *
 * 所有函数通过 OperatorContext 接口与外部状态交互，不直接持有可变状态。
 */

import { Cursor } from '../utils/Cursor.js'
import { firstGrapheme, lastGrapheme } from '../utils/intl.js'
import { countCharInString } from '../utils/stringUtils.js'
import {
  isInclusiveMotion,
  isLinewiseMotion,
  resolveMotion,
} from './motions.js'
import { findTextObject } from './textObjects.js'
import type {
  FindType,
  Operator,
  RecordedChange,
  TextObjScope,
} from './types.js'

/**
 * 操作符执行所需的上下文接口。
 *
 * 将操作符函数与具体状态实现解耦——调用方负责提供读写文本、
 * 光标、寄存器、查找记录和变更历史的能力；操作符函数只做纯计算与调用。
 */
export type OperatorContext = {
  cursor: Cursor          // 当前光标
  text: string            // 当前文本内容
  setText: (text: string) => void                                     // 更新文本
  setOffset: (offset: number) => void                                 // 更新光标偏移
  enterInsert: (offset: number) => void                               // 切换到插入模式并设置光标
  getRegister: () => string                                           // 读取寄存器内容
  setRegister: (content: string, linewise: boolean) => void          // 写入寄存器（及行级标志）
  getLastFind: () => { type: FindType; char: string } | null         // 读取上次 f/t 查找记录
  setLastFind: (type: FindType, char: string) => void                // 记录本次 f/t 查找
  recordChange: (change: RecordedChange) => void                     // 记录变更（用于点号重复）
}

/**
 * 以简单移动（motion）执行操作符。
 *
 * 流程：
 * 1. 调用 resolveMotion 计算目标光标
 * 2. 若目标等于当前位置（无效移动），直接返回
 * 3. 通过 getOperatorRange 确定操作范围（处理行级/包含式/cw 特例/图片占位符）
 * 4. 调用 applyOperator 执行删除/修改/复制
 * 5. 记录变更供点号重复使用
 *
 * @param op     操作符类型（delete/change/yank）
 * @param motion Vim 移动键（如 'w'/'$'/'j' 等）
 * @param count  重复次数
 * @param ctx    执行上下文
 */
export function executeOperatorMotion(
  op: Operator,
  motion: string,
  count: number,
  ctx: OperatorContext,
): void {
  const target = resolveMotion(motion, ctx.cursor, count) // 计算移动后的目标光标
  if (target.equals(ctx.cursor)) return // 未发生移动，无需操作

  const range = getOperatorRange(ctx.cursor, target, motion, op, count) // 确定操作范围
  applyOperator(op, range.from, range.to, ctx, range.linewise)           // 执行操作
  ctx.recordChange({ type: 'operator', op, motion, count })              // 记录变更
}

/**
 * 以字符查找（f/F/t/T）执行操作符。
 *
 * 流程：
 * 1. 调用 cursor.findCharacter 在当前行内搜索目标字符，获取目标偏移
 * 2. 若找不到目标字符，直接返回
 * 3. 构建目标 Cursor，通过 getOperatorRangeForFind 确定操作范围
 * 4. 执行操作并记录上次查找和变更
 *
 * @param op       操作符类型
 * @param findType 查找类型（f/F/t/T）
 * @param char     要查找的字符
 * @param count    重复次数
 * @param ctx      执行上下文
 */
export function executeOperatorFind(
  op: Operator,
  findType: FindType,
  char: string,
  count: number,
  ctx: OperatorContext,
): void {
  const targetOffset = ctx.cursor.findCharacter(char, findType, count) // 查找目标字符的偏移
  if (targetOffset === null) return // 未找到，取消操作

  const target = new Cursor(ctx.cursor.measuredText, targetOffset)    // 构建目标光标
  const range = getOperatorRangeForFind(ctx.cursor, target, findType) // 确定查找操作范围

  applyOperator(op, range.from, range.to, ctx)        // 执行操作
  ctx.setLastFind(findType, char)                     // 记录本次查找（供 ;/, 重复）
  ctx.recordChange({ type: 'operatorFind', op, find: findType, char, count }) // 记录变更
}

/**
 * 以文本对象（text object）执行操作符。
 *
 * 流程：
 * 1. 调用 findTextObject 根据对象类型和内/外范围确定边界
 * 2. 若无法识别文本对象，直接返回
 * 3. 执行操作并记录变更
 *
 * @param op      操作符类型
 * @param scope   范围（inner：不含边界字符；around：含边界字符/空白）
 * @param objType 对象类型键（'w'/'W'/'"'/'('/'['等）
 * @param count   重复次数（当前文本对象逻辑中未直接使用，但记录于变更中）
 * @param ctx     执行上下文
 */
export function executeOperatorTextObj(
  op: Operator,
  scope: TextObjScope,
  objType: string,
  count: number,
  ctx: OperatorContext,
): void {
  const range = findTextObject(
    ctx.text,
    ctx.cursor.offset,
    objType,
    scope === 'inner', // inner 模式不含边界字符
  )
  if (!range) return // 未找到文本对象，取消操作

  applyOperator(op, range.start, range.end, ctx)                                // 执行操作
  ctx.recordChange({ type: 'operatorTextObj', op, objType, scope, count })      // 记录变更
}

/**
 * 执行行操作（dd/cc/yy）。
 *
 * 流程：
 * 1. 统计当前逻辑行号（通过光标偏移前的换行数）
 * 2. 确定受影响的行数（受 count 及文件总行数限制）
 * 3. 计算行起始和结束偏移（含换行符）
 * 4. 将内容写入寄存器（行级标志）
 * 5. 根据操作符执行：yank 仅移动光标；delete 删除文本；change 删除并进入插入模式
 *
 * @param op    操作符类型
 * @param count 受影响行数
 * @param ctx   执行上下文
 */
export function executeLineOp(
  op: Operator,
  count: number,
  ctx: OperatorContext,
): void {
  const text = ctx.text
  const lines = text.split('\n')
  // 通过统计光标偏移前的换行数来确定逻辑行号
  // （cursor.getPosition() 返回的是折行后的视觉行，不适用于此场景）
  const currentLine = countCharInString(text.slice(0, ctx.cursor.offset), '\n')
  const linesToAffect = Math.min(count, lines.length - currentLine) // 不超出文件末尾
  const lineStart = ctx.cursor.startOfLogicalLine().offset            // 当前逻辑行起始偏移
  let lineEnd = lineStart
  for (let i = 0; i < linesToAffect; i++) {
    const nextNewline = text.indexOf('\n', lineEnd)
    lineEnd = nextNewline === -1 ? text.length : nextNewline + 1 // 包含换行符
  }

  let content = text.slice(lineStart, lineEnd)
  // 确保行级内容以换行符结尾，便于粘贴时识别为行级寄存器
  if (!content.endsWith('\n')) {
    content = content + '\n'
  }
  ctx.setRegister(content, true) // 写入行级寄存器

  if (op === 'yank') {
    ctx.setOffset(lineStart) // 复制操作：光标移到行首，不删除文本
  } else if (op === 'delete') {
    let deleteStart = lineStart
    const deleteEnd = lineEnd

    // 若删除到文件末尾且前面有换行符，将其一并删除，
    // 避免删除最后一行后留下多余换行符
    if (
      deleteEnd === text.length &&
      deleteStart > 0 &&
      text[deleteStart - 1] === '\n'
    ) {
      deleteStart -= 1 // 向前扩展以包含前一个换行符
    }

    const newText = text.slice(0, deleteStart) + text.slice(deleteEnd) // 执行删除
    ctx.setText(newText || '')
    const maxOff = Math.max(
      0,
      newText.length - (lastGrapheme(newText).length || 1), // 光标不超出文本末尾
    )
    ctx.setOffset(Math.min(deleteStart, maxOff))
  } else if (op === 'change') {
    // 单行时：清空文本进入插入模式
    if (lines.length === 1) {
      ctx.setText('')
      ctx.enterInsert(0)
    } else {
      // 多行时：删除受影响行，保留一个空行，进入插入模式
      const beforeLines = lines.slice(0, currentLine)
      const afterLines = lines.slice(currentLine + linesToAffect)
      const newText = [...beforeLines, '', ...afterLines].join('\n')
      ctx.setText(newText)
      ctx.enterInsert(lineStart)
    }
  }

  ctx.recordChange({ type: 'operator', op, motion: op[0]!, count }) // 记录变更（dd→'d', cc→'c', yy→'y'）
}

/**
 * 执行删除字符命令（x）。
 *
 * 以图形字素（grapheme）为单位向右删除 count 个字符，
 * 确保多字节字符（如 emoji）被整体删除而非截断。
 *
 * @param count 删除的字符数
 * @param ctx   执行上下文
 */
export function executeX(count: number, ctx: OperatorContext): void {
  const from = ctx.cursor.offset

  if (from >= ctx.text.length) return // 光标已在末尾，无字符可删

  // 以图形字素步进，避免截断多字节字符
  let endCursor = ctx.cursor
  for (let i = 0; i < count && !endCursor.isAtEnd(); i++) {
    endCursor = endCursor.right() // 每次移动一个图形字素
  }
  const to = endCursor.offset

  const deleted = ctx.text.slice(from, to)              // 提取被删除内容
  const newText = ctx.text.slice(0, from) + ctx.text.slice(to) // 拼接删除后的文本

  ctx.setRegister(deleted, false)                        // 写入字符级寄存器
  ctx.setText(newText)
  const maxOff = Math.max(
    0,
    newText.length - (lastGrapheme(newText).length || 1), // 确保光标不超出末尾
  )
  ctx.setOffset(Math.min(from, maxOff))
  ctx.recordChange({ type: 'x', count }) // 记录变更
}

/**
 * 执行替换字符命令（r）。
 *
 * 用给定字符替换光标处的 count 个图形字素。
 * 每次替换时保留替换字符的完整字节长度，正确处理多字节替换字符。
 *
 * @param char  替换用的字符
 * @param count 替换次数
 * @param ctx   执行上下文
 */
export function executeReplace(
  char: string,
  count: number,
  ctx: OperatorContext,
): void {
  let offset = ctx.cursor.offset
  let newText = ctx.text

  for (let i = 0; i < count && offset < newText.length; i++) {
    const graphemeLen = firstGrapheme(newText.slice(offset)).length || 1 // 当前图形字素长度
    newText =
      newText.slice(0, offset) + char + newText.slice(offset + graphemeLen) // 替换单个图形字素
    offset += char.length // 移动到下一个替换位置
  }

  ctx.setText(newText)
  ctx.setOffset(Math.max(0, offset - char.length)) // 光标停在最后一个被替换字符处
  ctx.recordChange({ type: 'replace', char, count }) // 记录变更
}

/**
 * 执行大小写切换命令（~）。
 *
 * 从光标处开始，切换 count 个图形字素的大小写。
 * 大写→小写，小写→大写；非字母字符保持不变（toUpperCase/toLowerCase 无效果）。
 *
 * @param count 切换的字符数
 * @param ctx   执行上下文
 */
export function executeToggleCase(count: number, ctx: OperatorContext): void {
  const startOffset = ctx.cursor.offset

  if (startOffset >= ctx.text.length) return // 光标已在末尾

  let newText = ctx.text
  let offset = startOffset
  let toggled = 0 // 已切换字符计数

  while (offset < newText.length && toggled < count) {
    const grapheme = firstGrapheme(newText.slice(offset))  // 取当前图形字素
    const graphemeLen = grapheme.length

    // 大写→小写，小写→大写
    const toggledGrapheme =
      grapheme === grapheme.toUpperCase()
        ? grapheme.toLowerCase()
        : grapheme.toUpperCase()

    newText =
      newText.slice(0, offset) +
      toggledGrapheme +
      newText.slice(offset + graphemeLen) // 替换图形字素
    offset += toggledGrapheme.length // 移到下一个字符
    toggled++
  }

  ctx.setText(newText)
  // 光标停在最后一个被切换字符的下一位（Vim 原生行为）
  ctx.setOffset(offset)
  ctx.recordChange({ type: 'toggleCase', count }) // 记录变更
}

/**
 * 执行合并行命令（J）。
 *
 * 将当前行与其后 count 行合并为一行：
 * - 若下一行有内容，在两行之间插入一个空格（除非当前行已以空格结尾）
 * - 下一行的前导空白会被去除（trimStart）
 * - 光标移到合并点（原当前行末尾）
 *
 * @param count 要合并的行数（与当前行合并的后续行数）
 * @param ctx   执行上下文
 */
export function executeJoin(count: number, ctx: OperatorContext): void {
  const text = ctx.text
  const lines = text.split('\n')
  const { line: currentLine } = ctx.cursor.getPosition() // 当前视觉行号

  if (currentLine >= lines.length - 1) return // 已是最后一行，无行可合并

  const linesToJoin = Math.min(count, lines.length - currentLine - 1) // 实际可合并行数
  let joinedLine = lines[currentLine]!
  const cursorPos = joinedLine.length // 合并后光标应停在此位置（原行末）

  for (let i = 1; i <= linesToJoin; i++) {
    const nextLine = (lines[currentLine + i] ?? '').trimStart() // 去除下一行前导空白
    if (nextLine.length > 0) {
      if (!joinedLine.endsWith(' ') && joinedLine.length > 0) {
        joinedLine += ' ' // 两行之间补一个空格
      }
      joinedLine += nextLine // 追加下一行内容
    }
  }

  const newLines = [
    ...lines.slice(0, currentLine),
    joinedLine,
    ...lines.slice(currentLine + linesToJoin + 1), // 跳过已合并的行
  ]

  const newText = newLines.join('\n')
  ctx.setText(newText)
  ctx.setOffset(getLineStartOffset(newLines, currentLine) + cursorPos) // 光标移到合并点
  ctx.recordChange({ type: 'join', count }) // 记录变更
}

/**
 * 执行粘贴命令（p/P）。
 *
 * 根据寄存器内容是否为行级（以 '\n' 结尾）采用两种粘贴策略：
 * - 行级粘贴：在当前行的上方（P）或下方（p）整行插入，光标移到插入行首
 * - 字符级粘贴：在光标位置（P）或光标后一位（p）插入，支持 count 次重复
 *
 * @param after  true 表示 p（光标后粘贴），false 表示 P（光标前粘贴）
 * @param count  重复粘贴次数
 * @param ctx    执行上下文
 */
export function executePaste(
  after: boolean,
  count: number,
  ctx: OperatorContext,
): void {
  const register = ctx.getRegister()
  if (!register) return // 寄存器为空，无内容可粘贴

  const isLinewise = register.endsWith('\n')          // 判断是否为行级寄存器
  const content = isLinewise ? register.slice(0, -1) : register // 去除末尾换行符

  if (isLinewise) {
    // 行级粘贴：整行插入到当前行上方或下方
    const text = ctx.text
    const lines = text.split('\n')
    const { line: currentLine } = ctx.cursor.getPosition()

    const insertLine = after ? currentLine + 1 : currentLine // 确定插入位置
    const contentLines = content.split('\n')
    const repeatedLines: string[] = []
    for (let i = 0; i < count; i++) {
      repeatedLines.push(...contentLines) // 重复 count 次
    }

    const newLines = [
      ...lines.slice(0, insertLine),
      ...repeatedLines,
      ...lines.slice(insertLine),
    ]

    const newText = newLines.join('\n')
    ctx.setText(newText)
    ctx.setOffset(getLineStartOffset(newLines, insertLine)) // 光标移到插入行首
  } else {
    // 字符级粘贴：在光标位置或其后插入
    const textToInsert = content.repeat(count) // 重复内容
    const insertPoint =
      after && ctx.cursor.offset < ctx.text.length
        ? ctx.cursor.measuredText.nextOffset(ctx.cursor.offset) // p：光标后一个图形字素
        : ctx.cursor.offset                                      // P：光标处

    const newText =
      ctx.text.slice(0, insertPoint) +
      textToInsert +
      ctx.text.slice(insertPoint)
    const lastGr = lastGrapheme(textToInsert)
    const newOffset = insertPoint + textToInsert.length - (lastGr.length || 1) // 光标停在粘贴内容末尾字符

    ctx.setText(newText)
    ctx.setOffset(Math.max(insertPoint, newOffset))
  }
}

/**
 * 执行缩进命令（>>/<<）。
 *
 * 对从当前行开始的 count 行进行增加（'>'）或减少（'<'）缩进：
 * - 增加：在行首添加两个空格
 * - 减少：按优先级尝试去除两个空格、一个制表符，或尽可能多的空白符
 * 操作后光标移到当前行的第一个非空白字符处。
 *
 * @param dir   缩进方向（'>' 增加 / '<' 减少）
 * @param count 受影响行数
 * @param ctx   执行上下文
 */
export function executeIndent(
  dir: '>' | '<',
  count: number,
  ctx: OperatorContext,
): void {
  const text = ctx.text
  const lines = text.split('\n')
  const { line: currentLine } = ctx.cursor.getPosition()
  const linesToAffect = Math.min(count, lines.length - currentLine) // 不超出文件末尾
  const indent = '  ' // 两个空格为一级缩进

  for (let i = 0; i < linesToAffect; i++) {
    const lineIdx = currentLine + i
    const line = lines[lineIdx] ?? ''

    if (dir === '>') {
      lines[lineIdx] = indent + line // 增加缩进：行首添加两个空格
    } else if (line.startsWith(indent)) {
      lines[lineIdx] = line.slice(indent.length) // 减少缩进：去除两个空格
    } else if (line.startsWith('\t')) {
      lines[lineIdx] = line.slice(1) // 去除一个制表符
    } else {
      // 尽可能去除前导空白（最多 indent.length 个字符）
      let removed = 0
      let idx = 0
      while (
        idx < line.length &&
        removed < indent.length &&
        /\s/.test(line[idx]!)
      ) {
        removed++
        idx++
      }
      lines[lineIdx] = line.slice(idx)
    }
  }

  const newText = lines.join('\n')
  const currentLineText = lines[currentLine] ?? ''
  const firstNonBlank = (currentLineText.match(/^\s*/)?.[0] ?? '').length // 第一个非空白字符的列偏移

  ctx.setText(newText)
  ctx.setOffset(getLineStartOffset(lines, currentLine) + firstNonBlank) // 光标移到首个非空白字符
  ctx.recordChange({ type: 'indent', dir, count }) // 记录变更
}

/**
 * 执行开新行命令（o/O）。
 *
 * 在当前行下方（o）或上方（O）插入一个空行，并进入插入模式：
 * - 通过在行列表中插入空字符串实现新行插入
 * - 光标定位到新行行首，进入插入模式
 *
 * @param direction 新行方向（'below' → o / 'above' → O）
 * @param ctx       执行上下文
 */
export function executeOpenLine(
  direction: 'above' | 'below',
  ctx: OperatorContext,
): void {
  const text = ctx.text
  const lines = text.split('\n')
  const { line: currentLine } = ctx.cursor.getPosition()

  const insertLine = direction === 'below' ? currentLine + 1 : currentLine // 确定插入位置
  const newLines = [
    ...lines.slice(0, insertLine),
    '',             // 插入空行
    ...lines.slice(insertLine),
  ]

  const newText = newLines.join('\n')
  ctx.setText(newText)
  ctx.enterInsert(getLineStartOffset(newLines, insertLine)) // 光标定位到新行首并进入插入模式
  ctx.recordChange({ type: 'openLine', direction }) // 记录变更
}

// ============================================================================
// 内部辅助函数
// ============================================================================

/**
 * 计算给定行号在完整文本中的起始偏移量。
 *
 * 实现方式：将目标行之前的所有行用 '\n' 重新连接，
 * 得到的字符串长度即为该行起始偏移（若非第一行还需加 1 以计入换行符本身）。
 *
 * @param lines     文本行数组
 * @param lineIndex 目标行索引（0-based）
 * @returns         该行在文本中的字节偏移
 */
function getLineStartOffset(lines: string[], lineIndex: number): number {
  return lines.slice(0, lineIndex).join('\n').length + (lineIndex > 0 ? 1 : 0)
}

/**
 * 计算操作符的字节操作范围（motion 版本）。
 *
 * 处理以下特殊情况：
 * 1. cw/cW：修改到单词末尾（而非下一单词开头），避免多余空白被纳入范围
 * 2. 行级移动（j/k/G/gg）：将范围扩展为完整行（含换行符）
 * 3. 包含式移动（e/E/$）：将范围终点向右扩展一个图形字素
 * 4. 图片占位符修复：确保范围不在 [Image #N] 内部截断
 *
 * @param cursor  起始光标
 * @param target  目标光标（motion 计算结果）
 * @param motion  Vim 移动键
 * @param op      操作符（用于 cw 特例判断）
 * @param count   重复次数（用于 cw 多词计算）
 * @returns       { from, to, linewise } 操作范围及行级标志
 */
function getOperatorRange(
  cursor: Cursor,
  target: Cursor,
  motion: string,
  op: Operator,
  count: number,
): { from: number; to: number; linewise: boolean } {
  let from = Math.min(cursor.offset, target.offset) // 范围起点（取小值）
  let to = Math.max(cursor.offset, target.offset)   // 范围终点（取大值）
  let linewise = false

  // 特例 1：cw/cW 修改到单词末尾，而非下一个单词的开头
  if (op === 'change' && (motion === 'w' || motion === 'W')) {
    // 先移动 count-1 个单词，再取最后一个单词的末尾
    let wordCursor = cursor
    for (let i = 0; i < count - 1; i++) {
      wordCursor =
        motion === 'w' ? wordCursor.nextVimWord() : wordCursor.nextWORD()
    }
    const wordEnd =
      motion === 'w' ? wordCursor.endOfVimWord() : wordCursor.endOfWORD()
    to = cursor.measuredText.nextOffset(wordEnd.offset) // 终点扩展到单词末尾的下一个图形字素
  } else if (isLinewiseMotion(motion)) {
    // 特例 2：行级移动 → 扩展到完整行
    linewise = true
    const text = cursor.text
    const nextNewline = text.indexOf('\n', to)
    if (nextNewline === -1) {
      // 已到文件末尾：包含前一个换行符（若有）
      to = text.length
      if (from > 0 && text[from - 1] === '\n') {
        from -= 1 // 向前扩展以包含换行符
      }
    } else {
      to = nextNewline + 1 // 包含终止换行符
    }
  } else if (isInclusiveMotion(motion) && cursor.offset <= target.offset) {
    // 特例 3：包含式移动 → 终点扩展一个图形字素（包含目标字符本身）
    to = cursor.measuredText.nextOffset(to)
  }

  // 特例 4：修复图片占位符截断问题
  // 确保 dw/cw/yw 等操作不会在 [Image #N] 内部分割占位符
  from = cursor.snapOutOfImageRef(from, 'start')
  to = cursor.snapOutOfImageRef(to, 'end')

  return { from, to, linewise }
}

/**
 * 计算查找操作（f/F/t/T）的字节操作范围。
 *
 * 说明：Cursor.findCharacter 已经为 t/T 调整了偏移（不含目标字符本身），
 * 因此此处统一按包含式处理：将终点扩展一个图形字素。
 *
 * @param cursor    起始光标
 * @param target    目标光标（findCharacter 返回的偏移构建）
 * @param _findType 查找类型（已由 Cursor 处理，此处不再使用）
 * @returns         { from, to } 操作范围
 */
function getOperatorRangeForFind(
  cursor: Cursor,
  target: Cursor,
  _findType: FindType,
): { from: number; to: number } {
  const from = Math.min(cursor.offset, target.offset)
  const maxOffset = Math.max(cursor.offset, target.offset)
  const to = cursor.measuredText.nextOffset(maxOffset) // 包含目标字符
  return { from, to }
}

/**
 * 对给定字节范围执行操作符（delete/change/yank）的核心函数。
 *
 * 流程：
 * 1. 提取范围内容，写入寄存器（行级内容确保以 '\n' 结尾）
 * 2. yank：仅移动光标到范围起点，不修改文本
 * 3. delete：删除范围文本，光标移到原起点（不超出新文本末尾）
 * 4. change：删除范围文本，进入插入模式（光标在原起点）
 *
 * @param op       操作符类型
 * @param from     范围起始字节偏移
 * @param to       范围终止字节偏移（不含）
 * @param ctx      执行上下文
 * @param linewise 是否为行级操作（影响寄存器标志）
 */
function applyOperator(
  op: Operator,
  from: number,
  to: number,
  ctx: OperatorContext,
  linewise: boolean = false,
): void {
  let content = ctx.text.slice(from, to) // 提取操作范围内容
  // 行级内容确保以换行符结尾（粘贴时识别为行级寄存器）
  if (linewise && !content.endsWith('\n')) {
    content = content + '\n'
  }
  ctx.setRegister(content, linewise) // 写入寄存器

  if (op === 'yank') {
    ctx.setOffset(from) // 复制：光标回到范围起点
  } else if (op === 'delete') {
    const newText = ctx.text.slice(0, from) + ctx.text.slice(to) // 删除范围文本
    ctx.setText(newText)
    const maxOff = Math.max(
      0,
      newText.length - (lastGrapheme(newText).length || 1), // 光标不超出新文本末尾
    )
    ctx.setOffset(Math.min(from, maxOff))
  } else if (op === 'change') {
    const newText = ctx.text.slice(0, from) + ctx.text.slice(to) // 删除范围文本
    ctx.setText(newText)
    ctx.enterInsert(from) // 在原范围起点进入插入模式
  }
}

/**
 * 以 G 移动执行操作符（dG/cG/yG）。
 *
 * - 无 count 时（count=1）：目标为文件最后一行
 * - 有 count 时（如 3G）：目标为第 N 行
 * 使用行级操作范围，操作整行内容。
 *
 * @param op    操作符类型
 * @param count 目标行号（1 表示无 count，跳到末行）
 * @param ctx   执行上下文
 */
export function executeOperatorG(
  op: Operator,
  count: number,
  ctx: OperatorContext,
): void {
  // count=1 表示未提供 count，跳到文件末尾；否则跳到第 N 行
  const target =
    count === 1 ? ctx.cursor.startOfLastLine() : ctx.cursor.goToLine(count)

  if (target.equals(ctx.cursor)) return // 目标即当前位置，无需操作

  const range = getOperatorRange(ctx.cursor, target, 'G', op, count) // G 为行级移动
  applyOperator(op, range.from, range.to, ctx, range.linewise)
  ctx.recordChange({ type: 'operator', op, motion: 'G', count }) // 记录变更
}

/**
 * 以 gg 移动执行操作符（dgg/cgg/ygg）。
 *
 * - 无 count 时（count=1）：目标为文件第一行
 * - 有 count 时（如 3gg）：目标为第 N 行
 * 使用行级操作范围，操作整行内容。
 *
 * @param op    操作符类型
 * @param count 目标行号（1 表示无 count，跳到首行）
 * @param ctx   执行上下文
 */
export function executeOperatorGg(
  op: Operator,
  count: number,
  ctx: OperatorContext,
): void {
  // count=1 表示未提供 count，跳到文件首行；否则跳到第 N 行
  const target =
    count === 1 ? ctx.cursor.startOfFirstLine() : ctx.cursor.goToLine(count)

  if (target.equals(ctx.cursor)) return // 目标即当前位置，无需操作

  const range = getOperatorRange(ctx.cursor, target, 'gg', op, count) // gg 为行级移动
  applyOperator(op, range.from, range.to, ctx, range.linewise)
  ctx.recordChange({ type: 'operator', op, motion: 'gg', count }) // 记录变更
}
