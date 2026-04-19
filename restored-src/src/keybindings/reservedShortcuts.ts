/**
 * 保留快捷键定义与规范化模块
 *
 * 【在 Claude Code 键位绑定系统中的位置与作用】
 * 本文件定义了系统中"不可重绑定"和"终端/OS 保留"的快捷键列表，
 * 并提供按键字符串的规范化工具函数，是键位验证流程的基础数据源：
 *
 *   reservedShortcuts（本文件，定义保留键列表 + 提供规范化函数）
 *     → validate（加载保留键列表，对用户绑定做冲突检查）
 *     → template（过滤保留键，生成干净的模板文件）
 *
 * 核心导出：
 *  - NON_REBINDABLE：Claude Code 内部硬编码、用户不可覆盖的快捷键（ctrl+c / ctrl+d / ctrl+m）
 *  - TERMINAL_RESERVED：终端/OS 级别拦截的快捷键（ctrl+z / ctrl+\）
 *  - MACOS_RESERVED：macOS 专属系统快捷键（cmd+c / cmd+v / cmd+space 等）
 *  - getReservedShortcuts：根据当前平台返回合并后的完整保留键列表
 *  - normalizeKeyForComparison：将快捷键字符串规范化（统一小写、修饰键排序），
 *    用于不区分别名的比较（如 "ctrl+k" vs "control+k" 视为相同）
 */

import { getPlatform } from '../utils/platform.js'

/**
 * Shortcuts that are typically intercepted by the OS, terminal, or shell
 * and will likely never reach the application.
 *
 * 通常被操作系统、终端或 Shell 拦截、永远无法到达应用程序的快捷键类型定义。
 */
export type ReservedShortcut = {
  key: string
  reason: string
  severity: 'error' | 'warning'
}

/**
 * Shortcuts that cannot be rebound - they are hardcoded in Claude Code.
 */
export const NON_REBINDABLE: ReservedShortcut[] = [
  {
    key: 'ctrl+c',
    reason: 'Cannot be rebound - used for interrupt/exit (hardcoded)',
    severity: 'error',
  },
  {
    key: 'ctrl+d',
    reason: 'Cannot be rebound - used for exit (hardcoded)',
    severity: 'error',
  },
  {
    key: 'ctrl+m',
    reason:
      'Cannot be rebound - identical to Enter in terminals (both send CR)',
    severity: 'error',
  },
]

/**
 * Terminal control shortcuts that are intercepted by the terminal/OS.
 * These will likely never reach the application.
 *
 * Note: ctrl+s (XOFF) and ctrl+q (XON) are NOT included here because:
 * - Most modern terminals disable flow control by default
 * - We use ctrl+s for the stash feature
 */
export const TERMINAL_RESERVED: ReservedShortcut[] = [
  {
    key: 'ctrl+z',
    reason: 'Unix process suspend (SIGTSTP)',
    severity: 'warning',
  },
  {
    key: 'ctrl+\\',
    reason: 'Terminal quit signal (SIGQUIT)',
    severity: 'error',
  },
]

/**
 * macOS-specific shortcuts that the OS intercepts.
 */
export const MACOS_RESERVED: ReservedShortcut[] = [
  { key: 'cmd+c', reason: 'macOS system copy', severity: 'error' },
  { key: 'cmd+v', reason: 'macOS system paste', severity: 'error' },
  { key: 'cmd+x', reason: 'macOS system cut', severity: 'error' },
  { key: 'cmd+q', reason: 'macOS quit application', severity: 'error' },
  { key: 'cmd+w', reason: 'macOS close window/tab', severity: 'error' },
  { key: 'cmd+tab', reason: 'macOS app switcher', severity: 'error' },
  { key: 'cmd+space', reason: 'macOS Spotlight', severity: 'error' },
]

/**
 * Get all reserved shortcuts for the current platform.
 * Includes non-rebindable shortcuts and terminal-reserved shortcuts.
 */
export function getReservedShortcuts(): ReservedShortcut[] {
  const platform = getPlatform()
  // Non-rebindable shortcuts first (highest priority)
  const reserved = [...NON_REBINDABLE, ...TERMINAL_RESERVED]

  if (platform === 'macos') {
    reserved.push(...MACOS_RESERVED)
  }

  return reserved
}

/**
 * Normalize a key string for comparison (lowercase, sorted modifiers).
 * Chords (space-separated steps like "ctrl+x ctrl+b") are normalized
 * per-step — splitting on '+' first would mangle "x ctrl" into a mainKey
 * overwritten by the next step, collapsing the chord into its last key.
 */
export function normalizeKeyForComparison(key: string): string {
  return key.trim().split(/\s+/).map(normalizeStep).join(' ')
}

function normalizeStep(step: string): string {
  const parts = step.split('+')
  const modifiers: string[] = []
  let mainKey = ''

  for (const part of parts) {
    const lower = part.trim().toLowerCase()
    if (
      [
        'ctrl',
        'control',
        'alt',
        'opt',
        'option',
        'meta',
        'cmd',
        'command',
        'shift',
      ].includes(lower)
    ) {
      // Normalize modifier names
      if (lower === 'control') modifiers.push('ctrl')
      else if (lower === 'option' || lower === 'opt') modifiers.push('alt')
      else if (lower === 'command' || lower === 'cmd') modifiers.push('cmd')
      else modifiers.push(lower)
    } else {
      mainKey = lower
    }
  }

  modifiers.sort()
  return [...modifiers, mainKey].join('+')
}
