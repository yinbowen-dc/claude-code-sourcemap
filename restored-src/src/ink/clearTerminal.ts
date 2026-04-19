/**
 * 跨平台终端清屏模块（Cross-Platform Terminal Clearing）
 *
 * 【在 Claude Code / Ink 系统中的位置】
 * 本文件处于 Ink 渲染引擎的"输出控制"层：
 *   用户触发清屏操作 → [本模块：生成清屏序列] → 写入终端 stdout → 终端清除屏幕（及滚动缓冲区）
 *
 * 【主要功能】
 * 根据终端类型自动选择正确的 ANSI 转义序列来清除终端屏幕和滚动缓冲区（scrollback）。
 * 不同平台和终端对 ESC[3J（清除滚动缓冲区）的支持程度不同：
 * - 现代终端（Windows Terminal、mintty、VS Code 终端）：支持 ESC[2J + ESC[3J + 光标归位
 * - 旧版 Windows 控制台（cmd.exe、conhost.exe）：仅支持 ESC[2J + HVP 光标归位
 * - macOS/Linux 终端：完整支持所有序列
 *
 * 【导出内容】
 * - getClearTerminalSequence()：函数，返回适合当前终端的清屏序列字符串
 * - clearTerminal：常量，模块加载时计算一次，供直接写入 stdout 使用
 */

import {
  CURSOR_HOME,       // 光标归位到左上角（CSI H）
  csi,               // 构建 CSI 转义序列的工具函数
  ERASE_SCREEN,      // 清除当前屏幕内容（CSI 2J）
  ERASE_SCROLLBACK,  // 清除滚动缓冲区（CSI 3J），旧版 Windows 不支持
} from './termio/csi.js'

// HVP（Horizontal Vertical Position）—— Windows 旧版控制台的光标归位序列
// 使用 CSI 0 f 而非 CSI H，因为旧版 conhost 对 CSI H 的支持不完整
const CURSOR_HOME_WINDOWS = csi(0, 'f')

/**
 * 检测当前环境是否为 Windows Terminal（现代 Windows 终端）。
 *
 * Windows Terminal 会设置 WT_SESSION 环境变量，可通过此标识区分。
 * 仅在 Windows 平台上检测，避免在 macOS/Linux 上误判。
 */
function isWindowsTerminal(): boolean {
  return process.platform === 'win32' && !!process.env.WT_SESSION
}

/**
 * 检测当前环境是否为 mintty 终端（GitBash、MSYS2、Cygwin 等使用的终端）。
 *
 * mintty 3.1.5+ 会将 TERM_PROGRAM 设置为 'mintty'；
 * GitBash/MSYS2/MINGW 环境会设置 MSYSTEM 变量（如 MSYSTEM=MINGW64）。
 * mintty 支持现代 ANSI 转义序列，包括 ESC[3J 清除滚动缓冲区。
 */
function isMintty(): boolean {
  // mintty 3.1.5+ 将 TERM_PROGRAM 设置为 'mintty'
  if (process.env.TERM_PROGRAM === 'mintty') {
    return true
  }
  // GitBash/MSYS2/MINGW 使用 mintty，通过 MSYSTEM 环境变量标识
  if (process.platform === 'win32' && process.env.MSYSTEM) {
    return true
  }
  return false
}

/**
 * 检测当前 Windows 终端是否为现代终端（支持完整 ANSI 序列）。
 *
 * 现代 Windows 终端包括：
 * 1. Windows Terminal（WT_SESSION 已设置）
 * 2. VS Code 集成终端（Windows 上使用 ConPTY 的 xterm.js）
 * 3. mintty（GitBash、MSYS2、Cygwin 等）
 *
 * 这些终端都支持 ESC[3J 清除滚动缓冲区。
 */
function isModernWindowsTerminal(): boolean {
  // Windows Terminal 设置了 WT_SESSION 环境变量
  if (isWindowsTerminal()) {
    return true
  }

  // Windows 上的 VS Code 集成终端（ConPTY 支持现代 ANSI 序列）
  if (
    process.platform === 'win32' &&
    process.env.TERM_PROGRAM === 'vscode' &&
    process.env.TERM_PROGRAM_VERSION  // 存在版本号说明是真正的 VS Code 终端
  ) {
    return true
  }

  // mintty（GitBash/MSYS2/Cygwin）支持现代转义序列
  if (isMintty()) {
    return true
  }

  return false
}

/**
 * 返回适合当前终端的清屏 ANSI 转义序列字符串。
 *
 * 【执行逻辑】
 * - macOS/Linux：ESC[2J（清屏）+ ESC[3J（清滚动缓冲区）+ ESC[H（光标归位）
 * - 现代 Windows 终端：同上
 * - 旧版 Windows 控制台：ESC[2J（清屏）+ CSI 0 f（HVP 光标归位，不清滚动缓冲区）
 *
 * @returns ANSI 转义序列字符串，可直接写入 stdout
 */
export function getClearTerminalSequence(): string {
  if (process.platform === 'win32') {
    if (isModernWindowsTerminal()) {
      // 现代 Windows 终端：完整清屏 + 清滚动缓冲区 + 光标归位
      return ERASE_SCREEN + ERASE_SCROLLBACK + CURSOR_HOME
    } else {
      // 旧版 Windows 控制台（cmd.exe、conhost.exe）：无法清除滚动缓冲区，使用 HVP 归位
      return ERASE_SCREEN + CURSOR_HOME_WINDOWS
    }
  }
  // macOS 和 Linux：始终支持完整序列
  return ERASE_SCREEN + ERASE_SCROLLBACK + CURSOR_HOME
}

/**
 * 清屏转义序列常量——在模块加载时计算一次，供直接写入 stdout 使用。
 *
 * 用法示例：process.stdout.write(clearTerminal)
 * 由于终端环境在会话期间不会改变，此值计算一次即可复用。
 */
export const clearTerminal = getClearTerminalSequence()
