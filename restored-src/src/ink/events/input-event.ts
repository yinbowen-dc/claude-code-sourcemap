/**
 * 键盘输入事件类（Keyboard Input Event）
 *
 * 【在 Claude Code / Ink 系统中的位置】
 * 本文件处于 Ink 事件系统层，是终端键盘输入的核心数据处理模块。
 * 当 stdin 流收到键盘输入时，parse-keypress 将原始字节序列解析为 ParsedKey，
 * 再由本模块的 InputEvent 封装为结构化的键盘事件，最终通过 EventEmitter
 * 分发给 useInput hook 消费。
 *
 * 【Key 类型与 input 字符串的关系】
 * - key：描述按键的修饰符和特殊键标志（布尔值集合），如 key.ctrl、key.shift、key.escape
 * - input：按键对应的实际输入字符串（可打印字符）或空字符串（特殊键）
 *
 * 【parseKey 函数的复杂性】
 * 终端键盘协议极为复杂，同一按键在不同终端、不同模式下可能产生不同的字节序列：
 * - CSI u（Kitty 键盘协议）：\e[codepoint;modifieru
 * - xterm modifyOtherKeys：\e[27;modifier;keycode~
 * - 应用小键盘模式：\eO<letter>
 * - 传统 VT100：\e[A（方向键）等
 * parseKey 统一处理这些格式，确保 useInput 的消费者获得一致的接口。
 */
import { nonAlphanumericKeys, type ParsedKey } from '../parse-keypress.js'
import { Event } from './event.js'

/**
 * 描述按键状态的类型，由 parseKey 从 ParsedKey 中提取。
 * 每个字段为布尔值，表示该按键是否被触发或该修饰键是否被按下。
 */
export type Key = {
  upArrow: boolean     // 上方向键
  downArrow: boolean   // 下方向键
  leftArrow: boolean   // 左方向键
  rightArrow: boolean  // 右方向键
  pageDown: boolean    // Page Down 键
  pageUp: boolean      // Page Up 键
  wheelUp: boolean     // 鼠标滚轮向上
  wheelDown: boolean   // 鼠标滚轮向下
  home: boolean        // Home 键
  end: boolean         // End 键
  return: boolean      // 回车键（Enter）
  escape: boolean      // Escape 键
  ctrl: boolean        // Ctrl 修饰键
  shift: boolean       // Shift 修饰键
  fn: boolean          // Fn 修饰键
  tab: boolean         // Tab 键
  backspace: boolean   // Backspace 键
  delete: boolean      // Delete 键
  meta: boolean        // Meta 键（Alt/Option，包括 Escape + 按键组合）
  super: boolean       // Super 键（macOS Cmd / Windows 键，仅 Kitty 协议）
}

/**
 * 从 ParsedKey 中提取结构化的 Key 对象和输入字符串。
 *
 * 【复杂性来源】
 * 终端键盘输入存在多种编码格式，parse-keypress 层会统一解析为 ParsedKey，
 * 但仍有若干需要在本层修正的边缘情况：
 * 1. CSI u（Kitty 键盘协议）序列的 input 提取
 * 2. xterm modifyOtherKeys 序列的 input 提取
 * 3. 应用小键盘模式（\eO<letter>）的 input 提取
 * 4. SGR 鼠标片段（\e 被过早 flush 时产生的碎片）的过滤
 * 5. 大写字母触发 shift=true 的标记
 * 6. ctrl+space → ' ' 的转换
 *
 * @param keypress - parse-keypress 解析后的按键信息
 * @returns [Key 对象, input 字符串] 的元组
 */
function parseKey(keypress: ParsedKey): [Key, string] {
  // 从 ParsedKey 中提取各修饰键和特殊键状态
  const key: Key = {
    upArrow: keypress.name === 'up',
    downArrow: keypress.name === 'down',
    leftArrow: keypress.name === 'left',
    rightArrow: keypress.name === 'right',
    pageDown: keypress.name === 'pagedown',
    pageUp: keypress.name === 'pageup',
    wheelUp: keypress.name === 'wheelup',
    wheelDown: keypress.name === 'wheeldown',
    home: keypress.name === 'home',
    end: keypress.name === 'end',
    return: keypress.name === 'return',
    escape: keypress.name === 'escape',
    fn: keypress.fn,
    ctrl: keypress.ctrl,
    shift: keypress.shift,
    tab: keypress.name === 'tab',
    backspace: keypress.name === 'backspace',
    delete: keypress.name === 'delete',
    // `parseKeypress` 将 \u001B\u001B[A（meta + 上方向键）解析为 meta=false、option=true，
    // 因此这里需要同时检查 option，以避免在 Ink 中破坏兼容性。
    // TODO(vadimdemedes): 在下一个主版本中考虑移除此逻辑。
    meta: keypress.meta || keypress.name === 'escape' || keypress.option,
    // Super 键（macOS Cmd / Windows 键）——仅通过 Kitty 键盘协议 CSI u 序列传递。
    // 与 meta（Alt/Option）区分，使得 cmd+c 和 opt+c 可以独立绑定。
    super: keypress.super,
  }

  // ctrl 按下时使用 keypress.name（字母名称），否则使用原始序列（可打印字符）
  let input = keypress.ctrl ? keypress.name : keypress.sequence

  // 处理 input 为 undefined 的情况（某些特殊序列可能未设置 sequence）
  if (input === undefined) {
    input = ''
  }

  // 当 ctrl 按下时，space 键的 keypress.name 是字面字符串 "space"。
  // 转换为实际的空格字符，与 CSI u 协议中 'space' → ' ' 的处理保持一致。
  // 不做此转换时，ctrl+space 会将字面字符串 "space" 泄漏到文本输入中。
  if (keypress.ctrl && input === 'space') {
    input = ' '
  }

  // 过滤被 FN_KEY_RE 匹配但 keyName 映射表中没有对应名称的未知转义序列
  // （例如 ESC[25~（Windows 上的 F13/右 Alt）、ESC[26~（F14）等）。
  // 不过滤时，ESC 前缀会被下方逻辑剥离，剩余部分（如 "[25~"）会以字面文本泄漏到 input 中。
  if (keypress.code && !keypress.name) {
    input = ''
  }

  // 过滤无 ESC 前缀的 SGR 鼠标碎片。
  // 当 React 重型提交阻塞事件循环超过 App 的 50ms NORMAL_TIMEOUT 冲刷时间时，
  // 跨 stdin 块分割的 CSI 序列会让其缓冲的 ESC 以单独的 Escape 键形式 flush，
  // 后续部分则作为 name='' 的文本 token 到达——绕过了所有以 ESC 开头的正则，
  // 最终以字面 `[<64;74;16M` 泄漏到提示符中。
  if (!keypress.name && /^\[<\d+;\d+;\d+[Mm]/.test(input)) {
    input = ''
  }

  // 剥离剩余的 meta（ESC）前缀
  // TODO(vadimdemedes): 在下一个主版本中移除此逻辑。
  if (input.startsWith('\u001B')) {
    input = input.slice(1)
  }

  // 标记是否已作为特殊序列处理（CSI u、modifyOtherKeys、应用小键盘模式）。
  // 对这些序列已将 input 转换为键名，不应再经过 nonAlphanumericKeys 清除逻辑。
  let processedAsSpecialSequence = false

  // 处理 CSI u 序列（Kitty 键盘协议）：剥离 ESC 后剩余 "[codepoint;modifieru"（如 "[98;3u" 对应 Alt+b）。
  // 使用解析后的键名作为 input。要求 [ 后紧跟数字——真正的 CSI u 始终是 [<digits>…u，
  // 仅用 startsWith('[') 会误匹配第 85 行的 X10 鼠标（Cy=85+32='u'），将字面 "mouse" 泄漏到提示符。
  if (/^\[\d/.test(input) && input.endsWith('u')) {
    if (!keypress.name) {
      // 未映射的 Kitty 功能键（Caps Lock 57358、F13–F35、KP 导航键、裸修饰符等）
      // — keycodeToName() 返回 undefined。清空 input 防止原始 "[57358u" 泄漏到提示符。
      input = ''
    } else {
      // 'space' → ' '；'escape' → ''（key.escape 已承载此信息；
      // processedAsSpecialSequence 会绕过下方的 nonAlphanumericKeys 清除，
      // 因此需要在此处显式处理）；其他情况使用键名。
      input =
        keypress.name === 'space'
          ? ' '
          : keypress.name === 'escape'
            ? ''
            : keypress.name
    }
    processedAsSpecialSequence = true
  }

  // 处理 xterm modifyOtherKeys 序列：剥离 ESC 后剩余 "[27;modifier;keycode~"（如 "[27;3;98~" 对应 Alt+b）。
  // 与 CSI u 处理逻辑相同——不处理时，可打印字符键码（单字母名称）会跳过
  // nonAlphanumericKeys 清除，导致 "[27;..." 作为 input 泄漏。
  if (input.startsWith('[27;') && input.endsWith('~')) {
    if (!keypress.name) {
      // 未映射的 modifyOtherKeys 键码——清空 input，与 CSI u 处理保持一致。
      // 实际上目前不可触发（xterm modifyOtherKeys 只发送 ASCII 键码，全部已映射），
      // 但作为防御性处理以应对未来终端行为。
      input = ''
    } else {
      input =
        keypress.name === 'space'
          ? ' '
          : keypress.name === 'escape'
            ? ''
            : keypress.name
    }
    processedAsSpecialSequence = true
  }

  // 处理应用小键盘模式序列：剥离 ESC 后剩余 "O<letter>"（如 "Op" 对应数字键盘 0，"Oy" 对应 9）。
  // 使用解析后的键名（数字字符）作为 input。
  if (
    input.startsWith('O') &&
    input.length === 2 &&
    keypress.name &&
    keypress.name.length === 1
  ) {
    input = keypress.name
    processedAsSpecialSequence = true
  }

  // 对非字母数字键（方向键、功能键等）清空 input。
  // 对 CSI u 和应用小键盘模式序列跳过此逻辑，因为这些序列已转换为正确的输入字符。
  if (
    !processedAsSpecialSequence &&
    keypress.name &&
    nonAlphanumericKeys.includes(keypress.name)
  ) {
    input = ''
  }

  // 对大写字母（A-Z）标记 shift=true。
  // 必须确认确实是字母，而非仅仅因 toUpperCase 不改变（如数字）而看起来是大写的字符。
  if (
    input.length === 1 &&
    typeof input[0] === 'string' &&
    input[0] >= 'A' &&
    input[0] <= 'Z'
  ) {
    key.shift = true
  }

  return [key, input]
}

/**
 * 键盘输入事件类，封装 parse-keypress 解析后的按键信息。
 *
 * 由 useInput hook 通过 EventEmitter 消费，提供：
 * - keypress：原始 ParsedKey 对象（底层解析结果）
 * - key：结构化的按键状态（各修饰键和特殊键的布尔标志）
 * - input：实际输入的字符串（可打印字符）或空字符串（特殊键）
 */
export class InputEvent extends Event {
  /** 原始解析结果，来自 parse-keypress 模块 */
  readonly keypress: ParsedKey
  /** 按键状态对象，包含修饰键和特殊键标志 */
  readonly key: Key
  /** 实际输入的字符串（可打印字符为对应字符，特殊键为空字符串） */
  readonly input: string

  /**
   * 创建一个键盘输入事件。
   *
   * @param keypress - parse-keypress 解析后的按键信息
   */
  constructor(keypress: ParsedKey) {
    super()
    // 从 ParsedKey 中提取结构化的 Key 对象和输入字符串
    const [key, input] = parseKey(keypress)

    this.keypress = keypress
    this.key = key
    this.input = input
  }
}
