/**
 * 文件：supports-hyperlinks.ts
 *
 * 【在 Claude Code 系统流程中的位置】
 * 本文件位于 Ink 渲染层的终端能力检测模块中。
 * Claude Code 在渲染文件路径、URL 等可点击内容时，
 * 需要判断当前终端是否支持 OSC 8 超链接转义序列，
 * 以决定是否将文本包裹在超链接序列中。
 *
 * 【主要功能】
 * 扩展 `supports-hyperlinks` npm 包的终端检测能力：
 * 该包主要基于 TERM_PROGRAM 环境变量检测，但对部分现代终端支持不完整。
 * 本文件额外支持：
 * - 检查 LC_TERMINAL（在 tmux 内 TERM_PROGRAM 会被覆写，但 LC_TERMINAL 保留）
 * - 检查 TERM 环境变量（如 kitty 的 xterm-kitty）
 * - 硬编码的扩展终端白名单（ADDITIONAL_HYPERLINK_TERMINALS）
 */

import supportsHyperlinksLib from 'supports-hyperlinks'

// 支持 OSC 8 超链接但未被 supports-hyperlinks 库检测到的额外终端列表。
// 同时对比 TERM_PROGRAM 和 LC_TERMINAL（后者在 tmux 内部依然保留原始值）。
export const ADDITIONAL_HYPERLINK_TERMINALS = [
  'ghostty',
  'Hyper',
  'kitty',
  'alacritty',
  'iTerm.app',
  'iTerm2',
]

/** 用于测试时注入环境变量的辅助类型 */
type EnvLike = Record<string, string | undefined>

/** supportsHyperlinks 的选项，允许在测试中覆盖环境和 stdout 支持状态 */
type SupportsHyperlinksOptions = {
  env?: EnvLike
  stdoutSupported?: boolean
}

/**
 * 判断当前 stdout 是否支持 OSC 8 超链接序列。
 *
 * 【检测流程】
 * 1. 优先信任 supports-hyperlinks 库的 stdout 检测结果
 * 2. 检查 TERM_PROGRAM 是否在扩展白名单中
 * 3. 检查 LC_TERMINAL（在 tmux 中 TERM_PROGRAM 被改写，但 LC_TERMINAL 保留原始终端名）
 * 4. 检查 TERM 是否包含 'kitty'（kitty 设置 TERM=xterm-kitty）
 *
 * @param options 可选覆盖参数，用于单元测试（注入 env 或 stdoutSupported）
 */
export function supportsHyperlinks(
  options?: SupportsHyperlinksOptions,
): boolean {
  // 优先使用传入的 stdoutSupported，否则使用库的 stdout 检测结果
  const stdoutSupported =
    options?.stdoutSupported ?? supportsHyperlinksLib.stdout
  if (stdoutSupported) {
    return true // 库已确认支持，直接返回
  }

  // 使用注入的 env 或进程实际环境变量
  const env = options?.env ?? process.env

  // 检查 TERM_PROGRAM：主终端程序标识符
  const termProgram = env['TERM_PROGRAM']
  if (termProgram && ADDITIONAL_HYPERLINK_TERMINALS.includes(termProgram)) {
    return true
  }

  // 检查 LC_TERMINAL：由部分终端（如 iTerm2）设置，在 tmux 内部也会保留，
  // 而 tmux 内部 TERM_PROGRAM 会被覆写为 'tmux'，因此需要额外检查此变量
  const lcTerminal = env['LC_TERMINAL']
  if (lcTerminal && ADDITIONAL_HYPERLINK_TERMINALS.includes(lcTerminal)) {
    return true
  }

  // 检查 TERM 变量：kitty 将 TERM 设置为 xterm-kitty
  const term = env['TERM']
  if (term?.includes('kitty')) {
    return true
  }

  // 以上所有条件均不满足，不支持超链接
  return false
}
