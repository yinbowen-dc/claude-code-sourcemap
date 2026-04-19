/**
 * 键盘事件类（Keyboard Event）
 *
 * 【在 Claude Code / Ink 系统中的位置】
 * 本文件处于 Ink 事件系统层，是 DOM 树捕获/冒泡分发系统中的键盘事件载体。
 * 与 InputEvent（通过 EventEmitter 总线分发）不同，KeyboardEvent 通过
 * Dispatcher 在 DOM 树中进行捕获/冒泡分发，触发组件上注册的 onKeyDown 处理器。
 *
 * 【与 InputEvent 的区别】
 * - InputEvent：直接通过 EventEmitter 总线分发，由 useInput hook 消费，
 *   关注"用户输入了什么"（key.ctrl, key.shift, input 字符串等）
 * - KeyboardEvent：通过 DOM 捕获/冒泡系统分发，由 onKeyDown prop 处理，
 *   遵循浏览器 KeyboardEvent 语义（key 字符串、ctrl/shift/meta/fn 修饰键）
 *
 * 【key 字段的语义】
 * 遵循浏览器 KeyboardEvent.key 规范：
 * - 可打印字符：字面字符本身（'a'、'3'、' '、'/'）
 * - 特殊键：多字符名称（'down'、'return'、'escape'、'f1'）
 * - 判断可打印字符的惯用写法：e.key.length === 1
 */
import type { ParsedKey } from '../parse-keypress.js'
import { TerminalEvent } from './terminal-event.js'

/**
 * 键盘按键事件，通过 DOM 树捕获/冒泡系统分发。
 *
 * 遵循浏览器 KeyboardEvent 语义：key 对可打印字符为字面字符
 * （'a'、'3'、' '、'/'），对特殊键为多字符名称（'down'、'return'、'escape'、'f1'）。
 * 判断可打印字符的惯用方式是 `e.key.length === 1`。
 */
export class KeyboardEvent extends TerminalEvent {
  /** 按键的字符串表示（可打印字符为字面字符，特殊键为多字符名称） */
  readonly key: string
  /** Ctrl 修饰键是否被按下 */
  readonly ctrl: boolean
  /** Shift 修饰键是否被按下 */
  readonly shift: boolean
  /** Meta 修饰键是否被按下（Alt/Option，包括 meta 和 option） */
  readonly meta: boolean
  /** Super 键是否被按下（macOS Cmd / Windows 键，仅 Kitty 协议支持） */
  readonly superKey: boolean
  /** Fn 修饰键是否被按下 */
  readonly fn: boolean

  /**
   * 创建一个键盘按键事件。
   *
   * @param parsedKey - parse-keypress 解析后的按键信息
   */
  constructor(parsedKey: ParsedKey) {
    // keydown：键盘按下事件，向上冒泡，可被 preventDefault() 取消
    super('keydown', { bubbles: true, cancelable: true })

    // 从解析后的按键信息中提取 key 字符串
    this.key = keyFromParsed(parsedKey)
    this.ctrl = parsedKey.ctrl
    this.shift = parsedKey.shift
    // meta 包含两种情况：meta 键本身，以及 option 键（macOS Alt/Option）
    this.meta = parsedKey.meta || parsedKey.option
    this.superKey = parsedKey.super
    this.fn = parsedKey.fn
  }
}

/**
 * 从 ParsedKey 中提取符合浏览器 KeyboardEvent.key 规范的按键字符串。
 *
 * 【提取规则】
 * 1. Ctrl 组合键：序列是控制字节（如 \x03 对应 Ctrl+C），使用键名（字母）。
 *    浏览器报告 e.key === 'c'，e.ctrlKey === true。
 * 2. 单个可打印字符（space 到 ~，及 ASCII 以上的字符）：使用字面字符。
 *    浏览器报告 e.key === '3'，而非 'Digit3'。
 * 3. 特殊键（方向键、功能键、回车、Tab、Escape 等）：序列是转义序列
 *    （\x1b[B）或控制字节（\r、\t），使用解析后的键名。
 *    浏览器报告 e.key === 'ArrowDown'。
 *
 * @param parsed - parse-keypress 解析后的按键信息
 * @returns 符合浏览器 KeyboardEvent.key 规范的按键字符串
 */
function keyFromParsed(parsed: ParsedKey): string {
  const seq = parsed.sequence ?? ''
  const name = parsed.name ?? ''

  // Ctrl 组合键：序列是控制字节（\x03 对应 Ctrl+C），使用键名（字母）
  // 浏览器报告 e.key === 'c'，e.ctrlKey === true
  if (parsed.ctrl) return name

  // 单个可打印字符（space U+0020 到 ~ U+007E，以及 ASCII 以上的字符）：
  // 使用字面字符。浏览器报告 e.key === '3'，而非 'Digit3'
  if (seq.length === 1) {
    const code = seq.charCodeAt(0)
    if (code >= 0x20 && code !== 0x7f) return seq  // 排除 DEL（U+007F）
  }

  // 特殊键（方向键、功能键、回车、Tab、Escape 等）：
  // 序列是转义序列（\x1b[B）或控制字节（\r、\t），使用解析后的键名
  // 浏览器报告 e.key === 'ArrowDown'
  return name || seq
}
