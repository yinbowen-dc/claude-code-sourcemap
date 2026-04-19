/**
 * 配置常量模块。
 *
 * 在 Claude Code 系统中，该模块定义配置相关的常量，与其他模块分离以避免循环依赖。
 * 本文件不得添加任何 import，必须保持零依赖。
 * - NOTIFICATION_CHANNELS：通知渠道枚举值
 */
// These constants are in a separate file to avoid circular dependency issues.
// Do NOT add imports to this file - it must remain dependency-free.

// 通知渠道枚举：auto 自动检测，iterm2/iterm2_with_bell/terminal_bell/kitty/ghostty 指定终端，notifications_disabled 关闭通知
export const NOTIFICATION_CHANNELS = [
  'auto',
  'iterm2',
  'iterm2_with_bell',
  'terminal_bell',
  'kitty',
  'ghostty',
  'notifications_disabled',
] as const

// 有效编辑器模式（排除已废弃的 'emacs'，其在读取配置时自动迁移到 'normal'）
export const EDITOR_MODES = ['normal', 'vim'] as const

// 有效的 teammate 生成模式：
// 'tmux' = 传统基于 tmux 的 teammate（每个 teammate 一个 tmux 窗格）
// 'in-process' = 进程内 teammate（在同一进程中运行，无 tmux 依赖）
// 'auto' = 根据上下文自动选择（默认值）
export const TEAMMATE_MODES = ['auto', 'tmux', 'in-process'] as const
