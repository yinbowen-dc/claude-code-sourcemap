/**
 * 按键字符串解析模块
 *
 * 【在 Claude Code 键位绑定系统中的位置与作用】
 * 本文件是键位绑定系统的"词法解析层"，将配置文件或默认绑定中的
 * 人类可读的快捷键字符串转换为结构化的内部表示：
 *
 *   keybindings.json / defaultBindings（字符串形式的键位配置）
 *     → parser（本文件，将字符串解析为 ParsedKeystroke / Chord / ParsedBinding）
 *       → match（使用解析结果与运行时按键事件做比对）
 *       → resolver（使用解析结果进行动作查找和展示）
 *
 * 核心导出：
 *  - parseKeystroke：将 "ctrl+shift+k" 解析为 ParsedKeystroke 对象
 *  - parseChord：将 "ctrl+k ctrl+s" 解析为 Chord（ParsedKeystroke 数组）
 *  - parseBindings：将 KeybindingBlock[] 展开为扁平的 ParsedBinding[]
 *  - keystrokeToString / chordToString：将内部结构转回可读字符串（用于展示）
 *  - keystrokeToDisplayString / chordToDisplayString：平台感知的展示字符串转换
 *
 * 支持修饰键别名：ctrl/control、alt/opt/option、shift、meta、cmd/command/super/win
 */

import type {
  Chord,
  KeybindingBlock,
  ParsedBinding,
  ParsedKeystroke,
} from './types.js'

/**
 * Parse a keystroke string like "ctrl+shift+k" into a ParsedKeystroke.
 * Supports various modifier aliases (ctrl/control, alt/opt/option/meta,
 * cmd/command/super/win).
 *
 * 将 "ctrl+shift+k" 形式的按键字符串解析为 ParsedKeystroke 结构体。
 * 支持多种修饰键别名：ctrl/control、alt/opt/option/meta、cmd/command/super/win。
 */
export function parseKeystroke(input: string): ParsedKeystroke {
  const parts = input.split('+')
  const keystroke: ParsedKeystroke = {
    key: '',
    ctrl: false,
    alt: false,
    shift: false,
    meta: false,
    super: false,
  }
  for (const part of parts) {
    const lower = part.toLowerCase()
    switch (lower) {
      case 'ctrl':
      case 'control':
        keystroke.ctrl = true
        break
      case 'alt':
      case 'opt':
      case 'option':
        keystroke.alt = true
        break
      case 'shift':
        keystroke.shift = true
        break
      case 'meta':
        keystroke.meta = true
        break
      case 'cmd':
      case 'command':
      case 'super':
      case 'win':
        keystroke.super = true
        break
      case 'esc':
        keystroke.key = 'escape'
        break
      case 'return':
        keystroke.key = 'enter'
        break
      case 'space':
        keystroke.key = ' '
        break
      case '↑':
        keystroke.key = 'up'
        break
      case '↓':
        keystroke.key = 'down'
        break
      case '←':
        keystroke.key = 'left'
        break
      case '→':
        keystroke.key = 'right'
        break
      default:
        keystroke.key = lower
        break
    }
  }

  return keystroke
}

/**
 * Parse a chord string like "ctrl+k ctrl+s" into an array of ParsedKeystrokes.
 */
export function parseChord(input: string): Chord {
  // A lone space character IS the space key binding, not a separator
  if (input === ' ') return [parseKeystroke('space')]
  return input.trim().split(/\s+/).map(parseKeystroke)
}

/**
 * Convert a ParsedKeystroke to its canonical string representation for display.
 */
export function keystrokeToString(ks: ParsedKeystroke): string {
  const parts: string[] = []
  if (ks.ctrl) parts.push('ctrl')
  if (ks.alt) parts.push('alt')
  if (ks.shift) parts.push('shift')
  if (ks.meta) parts.push('meta')
  if (ks.super) parts.push('cmd')
  // Use readable names for display
  const displayKey = keyToDisplayName(ks.key)
  parts.push(displayKey)
  return parts.join('+')
}

/**
 * Map internal key names to human-readable display names.
 */
function keyToDisplayName(key: string): string {
  switch (key) {
    case 'escape':
      return 'Esc'
    case ' ':
      return 'Space'
    case 'tab':
      return 'tab'
    case 'enter':
      return 'Enter'
    case 'backspace':
      return 'Backspace'
    case 'delete':
      return 'Delete'
    case 'up':
      return '↑'
    case 'down':
      return '↓'
    case 'left':
      return '←'
    case 'right':
      return '→'
    case 'pageup':
      return 'PageUp'
    case 'pagedown':
      return 'PageDown'
    case 'home':
      return 'Home'
    case 'end':
      return 'End'
    default:
      return key
  }
}

/**
 * Convert a Chord to its canonical string representation for display.
 */
export function chordToString(chord: Chord): string {
  return chord.map(keystrokeToString).join(' ')
}

/**
 * Display platform type - a subset of Platform that we care about for display.
 * WSL and unknown are treated as linux for display purposes.
 */
type DisplayPlatform = 'macos' | 'windows' | 'linux' | 'wsl' | 'unknown'

/**
 * Convert a ParsedKeystroke to a platform-appropriate display string.
 * Uses "opt" for alt on macOS, "alt" elsewhere.
 */
export function keystrokeToDisplayString(
  ks: ParsedKeystroke,
  platform: DisplayPlatform = 'linux',
): string {
  const parts: string[] = []
  if (ks.ctrl) parts.push('ctrl')
  // Alt/meta are equivalent in terminals, show platform-appropriate name
  if (ks.alt || ks.meta) {
    // Only macOS uses "opt", all other platforms use "alt"
    parts.push(platform === 'macos' ? 'opt' : 'alt')
  }
  if (ks.shift) parts.push('shift')
  if (ks.super) {
    parts.push(platform === 'macos' ? 'cmd' : 'super')
  }
  // Use readable names for display
  const displayKey = keyToDisplayName(ks.key)
  parts.push(displayKey)
  return parts.join('+')
}

/**
 * Convert a Chord to a platform-appropriate display string.
 */
export function chordToDisplayString(
  chord: Chord,
  platform: DisplayPlatform = 'linux',
): string {
  return chord.map(ks => keystrokeToDisplayString(ks, platform)).join(' ')
}

/**
 * Parse keybinding blocks (from JSON config) into a flat list of ParsedBindings.
 */
export function parseBindings(blocks: KeybindingBlock[]): ParsedBinding[] {
  const bindings: ParsedBinding[] = []
  for (const block of blocks) {
    for (const [key, action] of Object.entries(block.bindings)) {
      bindings.push({
        chord: parseChord(key),
        action,
        context: block.context,
      })
    }
  }
  return bindings
}
