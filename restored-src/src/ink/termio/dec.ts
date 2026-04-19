/**
 * 文件：termio/dec.ts
 *
 * 【在 Claude Code 系统流程中的位置】
 * 本文件是 termio 子模块的 DEC 私有模式序列层。
 * DEC（Digital Equipment Corporation）私有模式扩展了 ANSI 标准，
 * 通过 CSI ? N h（设置）和 CSI ? N l（重置）格式控制终端特性。
 * terminal.ts 和 App.tsx 使用此处的预生成常量来控制光标、备用屏、
 * 鼠标追踪、同步输出等核心终端行为。
 *
 * 【主要功能】
 * - `DEC`：DEC 私有模式编号枚举（光标、备用屏、鼠标、焦点事件、同步输出等）
 * - `decset(mode)`：生成 CSI ? N h 序列（启用指定模式）
 * - `decreset(mode)`：生成 CSI ? N l 序列（禁用指定模式）
 * - 预生成常量：BSU/ESU（同步输出）、EBP/DBP（括号粘贴）、EFE/DFE（焦点事件）、
 *   SHOW/HIDE_CURSOR、ENTER/EXIT_ALT_SCREEN、ENABLE/DISABLE_MOUSE_TRACKING
 */

import { csi } from './csi.js'

/**
 * DEC 私有模式编号枚举。
 *
 * 每个值对应一个终端特性的模式编号，用于 CSI ? N h/l 序列：
 * - CURSOR_VISIBLE (25)：光标可见性
 * - ALT_SCREEN (47)：备用屏幕（无清屏）
 * - ALT_SCREEN_CLEAR (1049)：备用屏幕（进入时清屏并保存光标）
 * - MOUSE_NORMAL (1000)：基础鼠标追踪（按下/释放）
 * - MOUSE_BUTTON (1002)：添加拖拽事件（按钮移动）
 * - MOUSE_ANY (1003)：添加全动态追踪（无需按键）
 * - MOUSE_SGR (1006)：使用 SGR 格式上报鼠标坐标（替代 X10 字节编码）
 * - FOCUS_EVENTS (1004)：焦点事件上报（DECSET 1004）
 * - BRACKETED_PASTE (2004)：括号粘贴模式
 * - SYNCHRONIZED_UPDATE (2026)：同步输出更新（防闪烁）
 */
export const DEC = {
  CURSOR_VISIBLE: 25,       // 光标可见性（25=显示，默认开启）
  ALT_SCREEN: 47,           // 备用屏幕（不清屏）
  ALT_SCREEN_CLEAR: 1049,   // 备用屏幕（进入时清屏并保存光标位置）
  MOUSE_NORMAL: 1000,       // 基础鼠标事件（按下/释放/滚轮）
  MOUSE_BUTTON: 1002,       // 添加鼠标拖拽事件
  MOUSE_ANY: 1003,          // 添加鼠标悬停事件（无需按键）
  MOUSE_SGR: 1006,          // SGR 格式鼠标上报（支持超出 255 列的坐标）
  FOCUS_EVENTS: 1004,       // 焦点事件上报
  BRACKETED_PASTE: 2004,    // 括号粘贴模式
  SYNCHRONIZED_UPDATE: 2026, // 同步输出更新（DEC 2026）
} as const

/**
 * 生成 DEC 私有模式设置序列（CSI ? N h）。
 * 启用指定 DEC 模式编号对应的终端特性。
 *
 * @param mode DEC 私有模式编号（见 DEC 枚举）
 * @returns CSI ? N h 序列字符串
 */
export function decset(mode: number): string {
  return csi(`?${mode}h`)
}

/**
 * 生成 DEC 私有模式重置序列（CSI ? N l）。
 * 禁用指定 DEC 模式编号对应的终端特性。
 *
 * @param mode DEC 私有模式编号（见 DEC 枚举）
 * @returns CSI ? N l 序列字符串
 */
export function decreset(mode: number): string {
  return csi(`?${mode}l`)
}

// 预生成的常用模式序列常量
// 这些常量在模块加载时计算一次，避免每次调用函数的开销

/** BSU（Begin Synchronized Update）：开始同步输出更新（DEC 2026 设置） */
export const BSU = decset(DEC.SYNCHRONIZED_UPDATE)
/** ESU（End Synchronized Update）：结束同步输出更新（DEC 2026 重置） */
export const ESU = decreset(DEC.SYNCHRONIZED_UPDATE)
/** EBP（Enable Bracketed Paste）：启用括号粘贴模式 */
export const EBP = decset(DEC.BRACKETED_PASTE)
/** DBP（Disable Bracketed Paste）：禁用括号粘贴模式 */
export const DBP = decreset(DEC.BRACKETED_PASTE)
/** EFE（Enable Focus Events）：启用焦点事件上报 */
export const EFE = decset(DEC.FOCUS_EVENTS)
/** DFE（Disable Focus Events）：禁用焦点事件上报 */
export const DFE = decreset(DEC.FOCUS_EVENTS)
/** 显示光标序列（DECSET 25） */
export const SHOW_CURSOR = decset(DEC.CURSOR_VISIBLE)
/** 隐藏光标序列（DECRESET 25）——渲染期间用于消除光标闪烁 */
export const HIDE_CURSOR = decreset(DEC.CURSOR_VISIBLE)
/** 进入备用屏幕序列（DECSET 1049，同时清屏并保存光标位置） */
export const ENTER_ALT_SCREEN = decset(DEC.ALT_SCREEN_CLEAR)
/** 退出备用屏幕序列（DECRESET 1049，恢复主屏幕和光标位置） */
export const EXIT_ALT_SCREEN = decreset(DEC.ALT_SCREEN_CLEAR)
// 鼠标追踪序列说明：
// - 1000：上报按键按下/释放/滚轮
// - 1002：添加拖拽事件（需按住按键移动）
// - 1003：添加全动态事件（悬停，无需按键）
// - 1006：使用 SGR 格式（CSI < btn;col;row M/m）替代传统 X10 字节编码
// 组合使用：支持滚轮 + 点击/拖拽选择 + 悬停追踪
/** 启用完整鼠标追踪（组合 1000+1002+1003+1006 模式） */
export const ENABLE_MOUSE_TRACKING =
  decset(DEC.MOUSE_NORMAL) +
  decset(DEC.MOUSE_BUTTON) +
  decset(DEC.MOUSE_ANY) +
  decset(DEC.MOUSE_SGR)
/** 禁用完整鼠标追踪（按 SGR→ANY→BUTTON→NORMAL 顺序逆向重置） */
export const DISABLE_MOUSE_TRACKING =
  decreset(DEC.MOUSE_SGR) +
  decreset(DEC.MOUSE_ANY) +
  decreset(DEC.MOUSE_BUTTON) +
  decreset(DEC.MOUSE_NORMAL)
