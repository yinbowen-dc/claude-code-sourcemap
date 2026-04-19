/**
 * 文件：termio/csi.ts
 *
 * 【在 Claude Code 系统流程中的位置】
 * 本文件是 termio 子模块的 CSI 序列生成与解析常量层。
 * CSI（Control Sequence Introducer，ESC [）是最常用的 ANSI 转义序列前缀，
 * 负责光标移动、行列擦除、滚动区域、SGR 样式、DEC 模式等核心终端操作。
 * terminal.ts、dec.ts、App.tsx 等上层模块通过此处的生成函数构造输出序列，
 * tokenize.ts 和 parser.ts 通过字节范围常量识别 CSI 序列边界。
 *
 * 【主要功能】
 * - `CSI_PREFIX`：CSI 序列前缀字符串（ESC [）
 * - `CSI_RANGE`：参数/中间/终止字节的范围常量
 * - `isCSIParam/Intermediate/Final`：字节类型判断函数
 * - `csi(...args)`：通用 CSI 序列生成器
 * - `CSI`：终止字节枚举（CUU/CUD/SGR/ED/EL 等）
 * - 光标移动生成器：`cursorUp/Down/Forward/Back/To/Position/Move`、save/restore
 * - 擦除生成器：`eraseLines`、`eraseToEndOfLine`、`eraseLine` 等
 * - 滚动控制：`scrollUp/Down`、`setScrollRegion`
 * - 输入标记常量：`PASTE_START/END`、`FOCUS_IN/OUT`、
 *   `ENABLE/DISABLE_KITTY_KEYBOARD`、`ENABLE/DISABLE_MODIFY_OTHER_KEYS`
 */

import { ESC, ESC_TYPE, SEP } from './ansi.js'

/** CSI 序列前缀：ESC [ */
export const CSI_PREFIX = ESC + String.fromCharCode(ESC_TYPE.CSI)

/**
 * CSI 各字节段的范围常量。
 *
 * 根据 ECMA-48，CSI 序列结构为：ESC [ <参数字节>* <中间字节>* <终止字节>
 * - 参数字节：0x30–0x3f（包含数字 '0'–'9'、分隔符 ';'、':' 和私有标记 '?', '>', '<', '='）
 * - 中间字节：0x20–0x2f（空格到 '/'）
 * - 终止字节：0x40–0x7e（'@'–'~'，决定序列的具体命令）
 */
export const CSI_RANGE = {
  PARAM_START: 0x30,        // 参数字节起始（'0'）
  PARAM_END: 0x3f,          // 参数字节结束（'?'）
  INTERMEDIATE_START: 0x20, // 中间字节起始（空格）
  INTERMEDIATE_END: 0x2f,   // 中间字节结束（'/'）
  FINAL_START: 0x40,        // 终止字节起始（'@'）
  FINAL_END: 0x7e,          // 终止字节结束（'~'）
} as const

/**
 * 判断字节是否为 CSI 参数字节（0x30–0x3f）。
 * 用于 tokenizer 在 CSI 状态下持续消费参数字节。
 *
 * @param byte 待检测的字节值
 * @returns 若为 CSI 参数字节则返回 true
 */
export function isCSIParam(byte: number): boolean {
  return byte >= CSI_RANGE.PARAM_START && byte <= CSI_RANGE.PARAM_END
}

/**
 * 判断字节是否为 CSI 中间字节（0x20–0x2f）。
 * 中间字节位于参数字节与终止字节之间，用于修饰命令语义（如 DECSCUSR 的空格）。
 *
 * @param byte 待检测的字节值
 * @returns 若为 CSI 中间字节则返回 true
 */
export function isCSIIntermediate(byte: number): boolean {
  return (
    byte >= CSI_RANGE.INTERMEDIATE_START && byte <= CSI_RANGE.INTERMEDIATE_END
  )
}

/**
 * 判断字节是否为 CSI 终止字节（0x40–0x7e，即 '@'–'~'）。
 * 终止字节出现即标志 CSI 序列完整，tokenizer 据此切换回 ground 状态。
 *
 * @param byte 待检测的字节值
 * @returns 若为 CSI 终止字节则返回 true
 */
export function isCSIFinal(byte: number): boolean {
  return byte >= CSI_RANGE.FINAL_START && byte <= CSI_RANGE.FINAL_END
}

/**
 * 通用 CSI 序列生成器：ESC [ p1;p2;...;pN final
 *
 * 【调用约定】
 * - 无参数：仅返回 CSI 前缀（ESC [）
 * - 单参数：视为完整序列体（ESC [ arg），适合传入已格式化的字符串如 '?1049h'
 * - 多参数：最后一个为终止字节，其余为参数，以 ';' 连接
 *   例：csi(1, 'A') → ESC [ 1 A（光标上移 1 行）
 *
 * @param args 序列参数（字符串或数字），最后一项为终止字节（多参数时）
 * @returns 完整的 CSI 转义序列字符串
 */
export function csi(...args: (string | number)[]): string {
  if (args.length === 0) return CSI_PREFIX
  if (args.length === 1) return `${CSI_PREFIX}${args[0]}`
  const params = args.slice(0, -1)
  const final = args[args.length - 1]
  return `${CSI_PREFIX}${params.join(SEP)}${final}`
}

/**
 * CSI 终止字节枚举——决定 CSI 序列的命令含义。
 *
 * 每个值对应 ECMA-48 中定义的一个功能命令：
 * - CUU/CUD/CUF/CUB：光标上/下/前/后移动
 * - ED/EL/ECH：显示/行/字符擦除
 * - IL/DL/ICH/DCH：插入/删除行/字符
 * - SU/SD：上/下滚动
 * - SM/RM：设置/重置模式
 * - SGR：选择图形渲染（样式）
 * - DSR：设备状态报告
 * - DECSCUSR：设置光标样式
 * - DECSTBM：设置滚动区域
 */
export const CSI = {
  // 光标移动命令
  CUU: 0x41, // A - Cursor Up（光标上移）
  CUD: 0x42, // B - Cursor Down（光标下移）
  CUF: 0x43, // C - Cursor Forward（光标前移）
  CUB: 0x44, // D - Cursor Back（光标后移）
  CNL: 0x45, // E - Cursor Next Line（光标移至下一行首）
  CPL: 0x46, // F - Cursor Previous Line（光标移至上一行首）
  CHA: 0x47, // G - Cursor Horizontal Absolute（光标水平绝对定位）
  CUP: 0x48, // H - Cursor Position（光标绝对定位 row;col）
  CHT: 0x49, // I - Cursor Horizontal Tab（光标水平制表）
  VPA: 0x64, // d - Vertical Position Absolute（垂直绝对定位）
  HVP: 0x66, // f - Horizontal Vertical Position（同 CUP）

  // 擦除命令
  ED: 0x4a,  // J - Erase in Display（擦除显示内容）
  EL: 0x4b,  // K - Erase in Line（擦除行内容）
  ECH: 0x58, // X - Erase Character（擦除字符）

  // 插入/删除命令
  IL: 0x4c,  // L - Insert Lines（插入行）
  DL: 0x4d,  // M - Delete Lines（删除行）
  ICH: 0x40, // @ - Insert Characters（插入字符）
  DCH: 0x50, // P - Delete Characters（删除字符）

  // 滚动命令
  SU: 0x53,  // S - Scroll Up（上滚）
  SD: 0x54,  // T - Scroll Down（下滚）

  // 模式控制命令
  SM: 0x68,  // h - Set Mode（设置模式）
  RM: 0x6c,  // l - Reset Mode（重置模式）

  // SGR 命令
  SGR: 0x6d, // m - Select Graphic Rendition（选择图形渲染）

  // 其他命令
  DSR: 0x6e,     // n - Device Status Report（设备状态报告）
  DECSCUSR: 0x71, // q - Set Cursor Style（设置光标样式，需空格中间字节）
  DECSTBM: 0x72,  // r - Set Top and Bottom Margins（设置上下边距/滚动区域）
  SCOSC: 0x73,    // s - Save Cursor Position（保存光标位置）
  SCORC: 0x75,    // u - Restore Cursor Position（恢复光标位置）
  CBT: 0x5a,      // Z - Cursor Backward Tabulation（光标反向制表）
} as const

/**
 * ED 命令（擦除显示）的区域参数枚举。
 * 对应 CSI n J 中 n 的含义：0=到末尾、1=到开头、2=全部、3=回滚缓冲区
 */
export const ERASE_DISPLAY = ['toEnd', 'toStart', 'all', 'scrollback'] as const

/**
 * EL 命令（擦除行）的区域参数枚举。
 * 对应 CSI n K 中 n 的含义：0=到行尾、1=到行首、2=整行
 */
export const ERASE_LINE_REGION = ['toEnd', 'toStart', 'all'] as const

/**
 * 光标样式类型（DECSCUSR 命令）。
 * 用于设置终端光标的视觉形态。
 */
export type CursorStyle = 'block' | 'underline' | 'bar'

/** DECSCUSR 参数到光标样式的映射表（索引对应 CSI n SP q 中的 n） */
export const CURSOR_STYLES: Array<{ style: CursorStyle; blinking: boolean }> = [
  { style: 'block', blinking: true },     // 0 - 默认（闪烁方块）
  { style: 'block', blinking: true },     // 1 - 闪烁方块
  { style: 'block', blinking: false },    // 2 - 稳定方块
  { style: 'underline', blinking: true }, // 3 - 闪烁下划线
  { style: 'underline', blinking: false },// 4 - 稳定下划线
  { style: 'bar', blinking: true },       // 5 - 闪烁竖线
  { style: 'bar', blinking: false },      // 6 - 稳定竖线
]

// 光标移动生成函数

/**
 * 生成光标上移序列（CSI n A）。
 * n=0 时返回空字符串（无操作优化）。
 *
 * @param n 上移行数，默认 1
 */
export function cursorUp(n = 1): string {
  return n === 0 ? '' : csi(n, 'A')
}

/**
 * 生成光标下移序列（CSI n B）。
 * n=0 时返回空字符串（无操作优化）。
 *
 * @param n 下移行数，默认 1
 */
export function cursorDown(n = 1): string {
  return n === 0 ? '' : csi(n, 'B')
}

/**
 * 生成光标前移（右移）序列（CSI n C）。
 * n=0 时返回空字符串（无操作优化）。
 *
 * @param n 前移列数，默认 1
 */
export function cursorForward(n = 1): string {
  return n === 0 ? '' : csi(n, 'C')
}

/**
 * 生成光标后移（左移）序列（CSI n D）。
 * n=0 时返回空字符串（无操作优化）。
 *
 * @param n 后移列数，默认 1
 */
export function cursorBack(n = 1): string {
  return n === 0 ? '' : csi(n, 'D')
}

/**
 * 生成光标水平绝对定位序列（CSI n G）。
 * 将光标移到当前行的第 n 列（1-indexed）。
 *
 * @param col 目标列号（1-indexed）
 */
export function cursorTo(col: number): string {
  return csi(col, 'G')
}

/** 将光标移到当前行行首（列 1）的常量序列（CSI G） */
export const CURSOR_LEFT = csi('G')

/**
 * 生成光标绝对定位序列（CSI row;col H）。
 * 行列均为 1-indexed。
 *
 * @param row 目标行号（1-indexed）
 * @param col 目标列号（1-indexed）
 */
export function cursorPosition(row: number, col: number): string {
  return csi(row, col, 'H')
}

/** 将光标移到屏幕左上角（1,1）的常量序列（CSI H） */
export const CURSOR_HOME = csi('H')

/**
 * 生成相对于当前位置的光标移动序列。
 * x 为正向右移，x 为负向左移；y 为正向下移，y 为负向上移。
 * 先处理水平方向，再处理垂直方向（与 ansi-escapes 行为一致）。
 *
 * @param x 水平偏移量（正=右，负=左）
 * @param y 垂直偏移量（正=下，负=上）
 */
export function cursorMove(x: number, y: number): string {
  let result = ''
  // 先处理水平方向（与 ansi-escapes 行为一致）
  if (x < 0) {
    result += cursorBack(-x)
  } else if (x > 0) {
    result += cursorForward(x)
  }
  // 再处理垂直方向
  if (y < 0) {
    result += cursorUp(-y)
  } else if (y > 0) {
    result += cursorDown(y)
  }
  return result
}

// 光标位置保存/恢复

/** 保存光标位置（CSI s，SCOSC） */
export const CURSOR_SAVE = csi('s')

/** 恢复光标位置（CSI u，SCORC） */
export const CURSOR_RESTORE = csi('u')

// 擦除序列生成函数

/** 生成从光标到行尾的擦除序列（CSI K） */
export function eraseToEndOfLine(): string {
  return csi('K')
}

/** 生成从光标到行首的擦除序列（CSI 1 K） */
export function eraseToStartOfLine(): string {
  return csi(1, 'K')
}

/** 生成擦除整行的序列（CSI 2 K） */
export function eraseLine(): string {
  return csi(2, 'K')
}

/** 擦除整行的常量序列（CSI 2 K） */
export const ERASE_LINE = csi(2, 'K')

/** 生成从光标到屏幕末尾的擦除序列（CSI J） */
export function eraseToEndOfScreen(): string {
  return csi('J')
}

/** 生成从光标到屏幕开头的擦除序列（CSI 1 J） */
export function eraseToStartOfScreen(): string {
  return csi(1, 'J')
}

/** 生成擦除整屏的序列（CSI 2 J） */
export function eraseScreen(): string {
  return csi(2, 'J')
}

/** 擦除整屏的常量序列（CSI 2 J） */
export const ERASE_SCREEN = csi(2, 'J')

/** 擦除回滚缓冲区的常量序列（CSI 3 J） */
export const ERASE_SCROLLBACK = csi(3, 'J')

/**
 * 生成从光标行开始向上擦除 n 行的序列。
 *
 * 【实现方式】
 * 对每一行：先擦除整行，再向上移动一行（最后一次不上移），
 * 最后将光标移到行首（列 1）。
 * 这与 Ink 的差量渲染逻辑配合，用于清除上一帧的内容。
 *
 * @param n 要擦除的行数
 * @returns 擦除序列字符串（n≤0 时返回空字符串）
 */
export function eraseLines(n: number): string {
  if (n <= 0) return ''
  let result = ''
  for (let i = 0; i < n; i++) {
    result += ERASE_LINE
    // 最后一行不需要再向上移动
    if (i < n - 1) {
      result += cursorUp(1)
    }
  }
  // 将光标移到当前行行首
  result += CURSOR_LEFT
  return result
}

// 滚动序列生成函数

/**
 * 生成屏幕内容上滚 n 行的序列（CSI n S）。
 * n=0 时返回空字符串（无操作优化）。
 *
 * @param n 上滚行数，默认 1
 */
export function scrollUp(n = 1): string {
  return n === 0 ? '' : csi(n, 'S')
}

/**
 * 生成屏幕内容下滚 n 行的序列（CSI n T）。
 * n=0 时返回空字符串（无操作优化）。
 *
 * @param n 下滚行数，默认 1
 */
export function scrollDown(n = 1): string {
  return n === 0 ? '' : csi(n, 'T')
}

/**
 * 生成设置滚动区域的序列（DECSTBM，CSI top;bottom r）。
 * top 和 bottom 均为 1-indexed 且包含端点。
 * 设置后光标会移到 home 位置。
 *
 * @param top    滚动区域顶部行号（1-indexed）
 * @param bottom 滚动区域底部行号（1-indexed）
 */
export function setScrollRegion(top: number, bottom: number): string {
  return csi(top, bottom, 'r')
}

/** 重置滚动区域为全屏的常量序列（DECSTBM，CSI r）。同时将光标移到 home。 */
export const RESET_SCROLL_REGION = csi('r')

// 括号粘贴模式标记（终端输入，非输出）
// 在括号粘贴模式（DEC 模式 2004）启用时，
// 终端发送这些序列来界定粘贴内容的边界

/** 终端在粘贴内容前发送的标记（CSI 200 ~） */
export const PASTE_START = csi('200~')

/** 终端在粘贴内容后发送的标记（CSI 201 ~） */
export const PASTE_END = csi('201~')

// 焦点事件标记（终端输入，非输出）
// 在焦点事件模式（DEC 模式 1004）启用时，
// 终端在焦点变化时发送这些序列

/** 终端获得焦点时发送的标记（CSI I） */
export const FOCUS_IN = csi('I')

/** 终端失去焦点时发送的标记（CSI O） */
export const FOCUS_OUT = csi('O')

// Kitty 键盘协议（CSI u）
// 启用后提供带修饰键信息的增强按键上报
// 参见：https://sw.kovidgoyal.net/kitty/keyboard-protocol/

/**
 * 启用 Kitty 键盘协议的序列（携带基础修饰键上报标志）。
 * CSI > 1 u —— 以 flags=1（消歧义转义码）压栈进入协议模式。
 * 启用后 Shift+Enter 发送 CSI 13;2 u 而非普通 CR。
 */
export const ENABLE_KITTY_KEYBOARD = csi('>1u')

/**
 * 禁用 Kitty 键盘协议的序列。
 * CSI < u —— 弹出键盘模式栈，恢复到前一模式。
 */
export const DISABLE_KITTY_KEYBOARD = csi('<u')

/**
 * 启用 xterm modifyOtherKeys level 2 的序列。
 * tmux 接受此序列（而非 kitty 栈）来启用扩展键 ——
 * 当 extended-keys-format 为 csi-u 时，tmux 将以 kitty 格式发出按键事件。
 */
export const ENABLE_MODIFY_OTHER_KEYS = csi('>4;2m')

/**
 * 禁用 xterm modifyOtherKeys 的序列（重置为默认值）。
 */
export const DISABLE_MODIFY_OTHER_KEYS = csi('>4m')
