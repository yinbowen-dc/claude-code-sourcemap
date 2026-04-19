/**
 * terminal-setup 命令注册入口（commands/terminalSetup/index.ts）
 *
 * 本文件将 /terminal-setup 命令注册到 Claude Code 全局命令系统。
 * 该命令帮助用户在终端中配置换行快捷键绑定，解决 Claude Code 输入体验问题：
 * 在不支持原生 CSI u / Kitty 键盘协议的终端中，Shift+Enter 或 Option+Enter
 * 需要手动配置才能正确插入换行符（而非提交消息）。
 *
 * 在系统流程中的位置：
 *   用户输入 /terminal-setup → 命令注册表匹配 → load() 懒加载 terminalSetup.js
 *   → 根据终端类型生成对应的配置指令 → 引导用户完成快捷键绑定安装。
 *
 * 可见性逻辑：
 *   - 已原生支持 CSI u 协议的终端（Ghostty、Kitty、iTerm2、WezTerm）自动隐藏此命令，
 *     因为这些终端开箱即用，无需额外配置；
 *   - 其他终端（如 Apple Terminal、普通 xterm 等）显示此命令供用户配置。
 *
 * 描述文本根据检测到的终端类型动态调整，区分 Apple Terminal（Option+Enter）
 * 和其他终端（Shift+Enter）的不同绑定方案。
 */

import type { Command } from '../../commands.js'
import { env } from '../../utils/env.js'

// Terminals that natively support CSI u / Kitty keyboard protocol
// 原生支持扩展键盘协议的终端，这些终端可直接区分 Shift+Enter 与普通 Enter，无需额外配置
const NATIVE_CSIU_TERMINALS: Record<string, string> = {
  ghostty: 'Ghostty',      // Ghostty 终端，内置 Kitty 协议支持
  kitty: 'Kitty',          // Kitty 终端，Kitty 键盘协议的原创实现
  'iTerm.app': 'iTerm2',   // macOS 上的 iTerm2，支持 CSI u 扩展
  WezTerm: 'WezTerm',      // WezTerm 跨平台终端，原生支持 Kitty 协议
}

/**
 * terminal-setup 命令描述对象。
 *
 * description：根据当前检测到的终端类型（env.terminal）动态选择描述文字：
 *   - Apple Terminal：需安装 Option+Enter → 换行 的绑定，因其不支持 Shift+Enter 映射；
 *   - 其他终端：安装通用的 Shift+Enter → 换行 绑定。
 *
 * isHidden：若当前终端已原生支持 CSI u 协议（在 NATIVE_CSIU_TERMINALS 列表中），
 *   则隐藏此命令，避免向不需要配置的用户展示无关命令。
 */
const terminalSetup = {
  type: 'local-jsx',
  name: 'terminal-setup',
  description:
    env.terminal === 'Apple_Terminal'
      ? 'Enable Option+Enter key binding for newlines and visual bell'   // Apple Terminal 专属描述
      : 'Install Shift+Enter key binding for newlines',                  // 通用终端描述
  // 当前终端已原生支持扩展协议时隐藏，null 表示未检测到终端（仍显示以防万一）
  isHidden: env.terminal !== null && env.terminal in NATIVE_CSIU_TERMINALS,
  load: () => import('./terminalSetup.js'),
} satisfies Command

export default terminalSetup
