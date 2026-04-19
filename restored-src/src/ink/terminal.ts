/**
 * 文件：terminal.ts
 *
 * 【在 Claude Code 系统流程中的位置】
 * 本文件是 Ink 渲染层的终端能力检测与输出写入核心模块。
 * Claude Code 启动时需要同步检测当前终端支持的功能集合，
 * 并在每帧渲染时通过 `writeDiffToTerminal` 将差量 Diff 写入 stdout。
 *
 * 【主要功能】
 * - `isProgressReportingAvailable()`：检测终端是否支持 OSC 9;4 进度上报
 *   （ConEmu 全版本、Ghostty 1.2.0+、iTerm2 3.6.6+）
 * - `isSynchronizedOutputSupported()`：检测终端是否支持 DEC 模式 2026（同步输出）
 *   以消除重绘时的视觉闪烁
 * - `isXtermJs()`：组合环境变量 + 异步 XTVERSION 探针检测 xterm.js 系终端
 * - `supportsExtendedKeys()`：基于白名单判断终端是否支持扩展按键协议
 * - `hasCursorUpViewportYankBug()`：检测 Windows conhost 光标上移滚动 bug
 * - `writeDiffToTerminal(terminal, diff, skipSyncMarkers)`：将 Diff[] 写入 stdout
 * - `SYNC_OUTPUT_SUPPORTED`：模块加载时计算一次的同步输出支持常量
 */

import { coerce } from 'semver'
import type { Writable } from 'stream'
import { env } from '../utils/env.js'
import { gte } from '../utils/semver.js'
import { getClearTerminalSequence } from './clearTerminal.js'
import type { Diff } from './frame.js'
import { cursorMove, cursorTo, eraseLines } from './termio/csi.js'
import { BSU, ESU, HIDE_CURSOR, SHOW_CURSOR } from './termio/dec.js'
import { link } from './termio/osc.js'

/** 终端进度上报状态类型 */
export type Progress = {
  state: 'running' | 'completed' | 'error' | 'indeterminate'
  percentage?: number
}

/**
 * 检测终端是否支持 OSC 9;4 进度上报序列。
 *
 * 【支持的终端】
 * - ConEmu（Windows）：全版本支持
 * - Ghostty 1.2.0+：见 https://ghostty.org/docs/install/release-notes/1-2-0
 * - iTerm2 3.6.6+：见 https://iterm2.com/downloads.html
 *
 * 【注意】Windows Terminal 将 OSC 9;4 解释为通知而非进度条，因此明确排除。
 *
 * @returns 若当前终端支持进度上报则返回 true
 */
export function isProgressReportingAvailable(): boolean {
  // 非 TTY 环境（管道输出）不支持进度上报
  if (!process.stdout.isTTY) {
    return false
  }

  // Windows Terminal 将 OSC 9;4 解释为通知而非进度条，需显式排除
  if (process.env.WT_SESSION) {
    return false
  }

  // ConEmu 全版本支持 OSC 9;4 进度上报
  if (
    process.env.ConEmuANSI ||
    process.env.ConEmuPID ||
    process.env.ConEmuTask
  ) {
    return true
  }

  // 解析 TERM_PROGRAM_VERSION 为语义化版本号，失败则返回不支持
  const version = coerce(process.env.TERM_PROGRAM_VERSION)
  if (!version) {
    return false
  }

  // Ghostty 1.2.0+ 支持 OSC 9;4 进度上报
  // https://ghostty.org/docs/install/release-notes/1-2-0
  if (process.env.TERM_PROGRAM === 'ghostty') {
    return gte(version.version, '1.2.0')
  }

  // iTerm2 3.6.6+ 支持 OSC 9;4 进度上报
  // https://iterm2.com/downloads.html
  if (process.env.TERM_PROGRAM === 'iTerm.app') {
    return gte(version.version, '3.6.6')
  }

  return false
}

/**
 * 检测终端是否支持 DEC 模式 2026（同步输出）。
 *
 * 【原理】
 * 支持同步输出时，BSU/ESU 序列可以将整帧写入包裹为原子操作，
 * 防止终端在渲染中途刷新导致的可见闪烁。
 *
 * 【tmux 特殊处理】
 * tmux 会解析并转发每个字节，但自身不实现 DEC 2026。
 * BSU/ESU 会穿透到外层终端，但 tmux 的分块处理已破坏原子性。
 * 在 tmux 内跳过同步标记可节省每帧 16 字节及解析开销。
 *
 * @returns 若当前终端支持同步输出则返回 true
 */
export function isSynchronizedOutputSupported(): boolean {
  // tmux 不实现 DEC 2026，跳过以节省开销
  if (process.env.TMUX) return false

  const termProgram = process.env.TERM_PROGRAM
  const term = process.env.TERM

  // 已知支持 DEC 2026 的现代终端（通过 TERM_PROGRAM 识别）
  if (
    termProgram === 'iTerm.app' ||
    termProgram === 'WezTerm' ||
    termProgram === 'WarpTerminal' ||
    termProgram === 'ghostty' ||
    termProgram === 'contour' ||
    termProgram === 'vscode' ||
    termProgram === 'alacritty'
  ) {
    return true
  }

  // kitty 通过 TERM=xterm-kitty 或 KITTY_WINDOW_ID 识别
  if (term?.includes('kitty') || process.env.KITTY_WINDOW_ID) return true

  // Ghostty 有时通过 TERM=xterm-ghostty 而非 TERM_PROGRAM 设置
  if (term === 'xterm-ghostty') return true

  // foot 终端：TERM=foot 或 TERM=foot-extra
  if (term?.startsWith('foot')) return true

  // Alacritty 有时通过 TERM 包含 'alacritty' 标识
  if (term?.includes('alacritty')) return true

  // Zed 使用 alacritty_terminal crate，支持 DEC 2026
  if (process.env.ZED_TERM) return true

  // Windows Terminal 支持同步输出
  if (process.env.WT_SESSION) return true

  // 基于 VTE 的终端（GNOME Terminal、Tilix 等）自 VTE 0.68 起支持
  const vteVersion = process.env.VTE_VERSION
  if (vteVersion) {
    const version = parseInt(vteVersion, 10)
    // VTE 版本号 6800 对应 0.68.0
    if (version >= 6800) return true
  }

  return false
}

// -- XTVERSION 异步检测到的终端名称（启动时异步填充）--
//
// TERM_PROGRAM 默认不通过 SSH 转发，因此当 claude 在 VS Code 集成终端内远程运行时，
// 基于环境变量的检测会失效。
// XTVERSION（CSI > 0 q → DCS > | name ST）通过 pty 传递 ——
// 查询到达*客户端*终端，响应通过 stdin 回传。
// App.tsx 在原始模式启用时发送查询；setXtversionName() 从响应处理器调用。
// 读取者应将 undefined 视为"尚未知晓"并回退到环境变量检测。

/** 记录 XTVERSION 响应名称。模块级变量，初始为 undefined */
let xtversionName: string | undefined

/**
 * 记录 XTVERSION 响应名称。
 * 从 App.tsx 中响应到达 stdin 时调用一次。
 * 若已设置则为空操作（防止重复探针）。
 *
 * @param name XTVERSION 响应中的终端名称字符串
 */
export function setXtversionName(name: string): void {
  // 仅在首次设置，防止重复探针覆盖已有结果
  if (xtversionName === undefined) xtversionName = name
}

/**
 * 检测当前是否运行在基于 xterm.js 的终端中（VS Code、Cursor、Windsurf 集成终端）。
 *
 * 【检测策略】
 * - 优先检查 TERM_PROGRAM 环境变量（快速、同步，但 SSH 下不转发）
 * - 再检查 XTVERSION 探针结果（异步，能穿越 SSH — 查询/响应通过 pty 传递）
 *
 * 早期调用可能错过探针响应；若 SSH 检测至关重要，应在事件处理器等延迟场景调用。
 *
 * @returns 若为 xterm.js 系终端则返回 true
 */
export function isXtermJs(): boolean {
  // 同步路径：TERM_PROGRAM=vscode 直接判定
  if (process.env.TERM_PROGRAM === 'vscode') return true
  // 异步路径：XTVERSION 探针结果（可能尚未填充）
  return xtversionName?.startsWith('xterm.js') ?? false
}

// 已知正确实现 Kitty 键盘协议（CSI >1u）和/或 xterm modifyOtherKeys（CSI >4;2m）的终端白名单。
// 之前曾无条件启用（假设终端静默忽略未知 CSI），但部分终端（SSH 连接和 VS Code 等 xterm.js 终端）
// 会响应启用序列并发出解析器无法处理的码点。
// tmux 入白名单是因为它接受 modifyOtherKeys 而不将 kitty 序列转发给外层终端。
const EXTENDED_KEYS_TERMINALS = [
  'iTerm.app',
  'kitty',
  'WezTerm',
  'ghostty',
  'tmux',
  'windows-terminal',
]

/**
 * 检测当前终端是否正确处理扩展按键上报
 * （Kitty 键盘协议 + xterm modifyOtherKeys）。
 *
 * 使用白名单方式而非通用检测，以避免不兼容终端的意外行为。
 *
 * @returns 若终端支持扩展按键则返回 true
 */
export function supportsExtendedKeys(): boolean {
  return EXTENDED_KEYS_TERMINALS.includes(env.terminal ?? '')
}

/**
 * 检测终端是否存在光标上移导致视口滚动的 bug。
 *
 * 在 Windows 上，conhost 的 SetConsoleCursorPosition 会跟随光标进入回滚缓冲区
 * （microsoft/terminal#14774），在流式输出过程中将用户拉到缓冲区顶部。
 * WT_SESSION 捕获在 Windows Terminal 内的 WSL 场景，
 * 这些场景下平台为 linux 但输出仍通过 conhost 路由。
 *
 * @returns 若存在该 bug 则返回 true
 */
export function hasCursorUpViewportYankBug(): boolean {
  return process.platform === 'win32' || !!process.env.WT_SESSION
}

// 模块加载时计算一次 —— 终端能力不会在会话中途改变。
// 导出供调用方在特定模式下传入同步跳过提示。
export const SYNC_OUTPUT_SUPPORTED = isSynchronizedOutputSupported()

/** 终端对象，包含 stdout 和 stderr 可写流 */
export type Terminal = {
  stdout: Writable
  stderr: Writable
}

/**
 * 将渲染差量（Diff[]）写入终端 stdout。
 *
 * 【流程】
 * 1. 若 diff 为空则立即返回（无输出）
 * 2. 将所有写入缓冲为单个字符串，避免多次 write 调用
 * 3. 若启用同步标记（useSync=true），在缓冲区首尾添加 BSU/ESU
 * 4. 遍历 diff 的每个 patch，根据类型生成对应的终端序列追加到缓冲区：
 *    - 'stdout'：直接追加内容
 *    - 'clear'：追加擦除行序列
 *    - 'clearTerminal'：追加清屏序列
 *    - 'cursorHide/Show'：追加隐藏/显示光标序列
 *    - 'cursorMove/To'：追加光标移动序列
 *    - 'carriageReturn'：追加 \r
 *    - 'hyperlink'：追加 OSC 8 超链接序列
 *    - 'styleStr'：追加样式字符串
 * 5. 一次性 write 整个缓冲区
 *
 * @param terminal        终端对象（含 stdout）
 * @param diff            帧差量数组
 * @param skipSyncMarkers 为 true 时跳过 BSU/ESU 同步标记（用于 tmux 等不支持的场景）
 */
export function writeDiffToTerminal(
  terminal: Terminal,
  diff: Diff,
  skipSyncMarkers = false,
): void {
  // diff 为空时不产生任何输出
  if (diff.length === 0) {
    return
  }

  // BSU/ESU 包裹默认开启（opt-out 方式保持主屏行为不变）。
  // 调用方在终端不支持 DEC 2026（如 tmux）且成本较高（高频备用屏）时传入 skipSyncMarkers=true。
  const useSync = !skipSyncMarkers

  // 将所有写入合并为单个字符串，避免多次 write 调用的系统开销
  let buffer = useSync ? BSU : ''

  for (const patch of diff) {
    switch (patch.type) {
      case 'stdout':
        // 直接输出内容
        buffer += patch.content
        break
      case 'clear':
        // 擦除指定行数（patch.count > 0 时才执行）
        if (patch.count > 0) {
          buffer += eraseLines(patch.count)
        }
        break
      case 'clearTerminal':
        // 清屏序列（因平台/终端不同而有所差异）
        buffer += getClearTerminalSequence()
        break
      case 'cursorHide':
        // 隐藏光标（渲染期间避免闪烁）
        buffer += HIDE_CURSOR
        break
      case 'cursorShow':
        // 显示光标（渲染完成后恢复）
        buffer += SHOW_CURSOR
        break
      case 'cursorMove':
        // 相对移动光标（x=水平，y=垂直）
        buffer += cursorMove(patch.x, patch.y)
        break
      case 'cursorTo':
        // 移动光标到指定列（1-indexed）
        buffer += cursorTo(patch.col)
        break
      case 'carriageReturn':
        // 回车符，将光标移动到行首
        buffer += '\r'
        break
      case 'hyperlink':
        // OSC 8 超链接序列
        buffer += link(patch.uri)
        break
      case 'styleStr':
        // 预生成的样式字符串（SGR 等）
        buffer += patch.str
        break
    }
  }

  // 添加同步更新结束标记，然后一次性刷新缓冲区
  if (useSync) buffer += ESU
  terminal.stdout.write(buffer)
}
