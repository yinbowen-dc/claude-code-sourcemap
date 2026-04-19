/**
 * 按键解析与动作裁决模块
 *
 * 【在 Claude Code 键位绑定系统中的位置与作用】
 * 本文件是键位绑定系统的"最终裁决层"，将运行时按键事件映射到具体动作：
 *
 *   parser（解析配置字符串 → ParsedKeystroke）
 *   match（运行时将 Ink Key 事件与 ParsedKeystroke 对比）
 *     → resolver（本文件，"按键 + 上下文 + 绑定列表" → 动作裁决）
 *       → useKeybinding（React Hook，调用 resolver 并执行对应处理函数）
 *
 * 核心导出：
 *  - resolveKey：纯函数，单次按键 → 动作查找（无状态，用于简单场景）
 *  - resolveKeyWithChordState：支持多键和弦序列的有状态裁决
 *  - getBindingDisplayText：根据 action + context 反查显示文本（如 "ctrl+t"）
 *  - keystrokesEqual：比较两个 ParsedKeystroke 是否等价（alt/meta 视为同一修饰键）
 *
 * 和弦状态机状态：
 *  - none：无匹配
 *  - match：完整匹配，返回 action 字符串
 *  - unbound：显式 null 解绑（用户主动禁用某快捷键）
 *  - chord_started：已匹配和弦前缀，等待后续按键
 *  - chord_cancelled：和弦被 Escape 或无效按键中断
 */

/**
 * 按键解析与动作裁决模块
 *
 * 【在 Claude Code 键位绑定系统中的位置与作用】
 * 本文件是键位绑定系统的"最终裁决层"，将运行时按键事件映射到具体动作：
 *
 *   parser（解析配置字符串 → ParsedKeystroke）
 *   match（运行时将 Ink Key 事件与 ParsedKeystroke 对比）
 *     → resolver（本文件，"按键 + 上下文 + 绑定列表" → 动作裁决）
 *       → useKeybinding（React Hook，调用 resolver 并执行对应处理函数）
 *
 * 核心导出：
 *  - resolveKey：纯函数，单次按键 → 动作查找（无状态，用于简单场景）
 *  - resolveKeyWithChordState：支持多键和弦序列的有状态裁决
 *  - getBindingDisplayText：根据 action + context 反查显示文本（如 "ctrl+t"）
 *  - keystrokesEqual：比较两个 ParsedKeystroke 是否等价（alt/meta 视为同一修饰键）
 *
 * 和弦状态机状态：
 *  - none：无匹配
 *  - match：完整匹配，返回 action 字符串
 *  - unbound：显式 null 解绑（用户主动禁用某快捷键）
 *  - chord_started：已匹配和弦前缀，等待后续按键
 *  - chord_cancelled：和弦被 Escape 或无效按键中断
 */

import type { Key } from '../ink.js'
import { getKeyName, matchesBinding } from './match.js'
import { chordToString } from './parser.js'
import type {
  KeybindingContextName,
  ParsedBinding,
  ParsedKeystroke,
} from './types.js'

export type ResolveResult =
  | { type: 'match'; action: string }   // 找到匹配的动作
  | { type: 'none' }                    // 无匹配
  | { type: 'unbound' }                 // 显式 null 解绑

export type ChordResolveResult =
  | { type: 'match'; action: string }                          // 完整和弦匹配
  | { type: 'none' }                                           // 无匹配
  | { type: 'unbound' }                                        // 显式 null 解绑
  | { type: 'chord_started'; pending: ParsedKeystroke[] }      // 和弦前缀匹配，等待后续按键
  | { type: 'chord_cancelled' }                                // 和弦被中断

/**
 * 单次按键解析为动作（无状态版本，不处理和弦序列）。
 *
 * 遍历所有绑定，在活跃上下文中查找匹配的单键绑定（chord.length === 1），
 * 后者优先——最后一条匹配的绑定胜出，以实现用户覆盖默认值。
 *
 * @param input - Ink 上报的字符输入
 * @param key - Ink 的 Key 对象（含修饰键标志）
 * @param activeContexts - 当前活跃的上下文列表（如 ['Chat', 'Global']）
 * @param bindings - 完整的解析后绑定列表
 * @returns 裁决结果：match（找到动作）/ unbound（显式解绑）/ none（无匹配）
 */
export function resolveKey(
  input: string,
  key: Key,
  activeContexts: KeybindingContextName[],
  bindings: ParsedBinding[],
): ResolveResult {
  // Find matching bindings (last one wins for user overrides)
  let match: ParsedBinding | undefined
  const ctxSet = new Set(activeContexts)

  for (const binding of bindings) {
    // Phase 1: Only single-keystroke bindings
    if (binding.chord.length !== 1) continue
    if (!ctxSet.has(binding.context)) continue

    if (matchesBinding(input, key, binding)) {
      match = binding
    }
  }

  if (!match) {
    return { type: 'none' }
  }

  if (match.action === null) {
    return { type: 'unbound' }
  }

  return { type: 'match', action: match.action }
}

/**
 * 根据 action + context 反查快捷键显示文本（如 "ctrl+t" for "app:toggleTodos"）。
 *
 * 从绑定列表末尾向前查找，确保用户覆盖的绑定优先于默认绑定。
 * 若同一 action 在同一 context 中有多条绑定，返回最后一条（即用户自定义版本）。
 *
 * @param action - 动作标识符（如 'app:toggleTodos'）
 * @param context - 上下文名称（如 'Global'）
 * @param bindings - 完整的解析后绑定列表
 * @returns 快捷键的显示字符串，未找到则返回 undefined
 */
export function getBindingDisplayText(
  action: string,
  context: KeybindingContextName,
  bindings: ParsedBinding[],
): string | undefined {
  // Find the last binding for this action in this context
  const binding = bindings.findLast(
    b => b.action === action && b.context === context,
  )
  return binding ? chordToString(binding.chord) : undefined
}

/**
 * 从 Ink 的 input/key 构造 ParsedKeystroke。
 *
 * 处理 Ink 的 escape 触发 meta=true 的历史遗留问题：
 * escape 键本身不应携带 meta 修饰符，否则和弦状态机会匹配失败。
 */
function buildKeystroke(input: string, key: Key): ParsedKeystroke | null {
  const keyName = getKeyName(input, key)
  if (!keyName) return null

  // QUIRK: Ink sets key.meta=true when escape is pressed (see input-event.ts).
  // This is legacy terminal behavior - we should NOT record this as a modifier
  // for the escape key itself, otherwise chord matching will fail.
  const effectiveMeta = key.escape ? false : key.meta

  return {
    key: keyName,
    ctrl: key.ctrl,
    alt: effectiveMeta,
    shift: key.shift,
    meta: effectiveMeta,
    super: key.super,
  }
}

/**
 * 比较两个 ParsedKeystroke 是否逻辑等价。
 *
 * 将 alt 和 meta 折叠为同一修饰键——终端无法区分二者（参见 match.ts modifiersMatch），
 * 因此 "alt+k" 与 "meta+k" 视为相同按键。
 * super（cmd/win）是独立修饰键，仅通过 kitty 键盘协议到达，不参与折叠。
 */
export function keystrokesEqual(
  a: ParsedKeystroke,
  b: ParsedKeystroke,
): boolean {
  return (
    a.key === b.key &&
    a.ctrl === b.ctrl &&
    a.shift === b.shift &&
    (a.alt || a.meta) === (b.alt || b.meta) &&
    a.super === b.super
  )
}

/**
 * 判断一组按键序列是否为某条绑定和弦的前缀。
 *
 * 用于和弦状态机：当用户按下 "ctrl+k" 时，
 * 检查是否存在以 "ctrl+k" 开头的更长绑定（如 "ctrl+k ctrl+s"），
 * 若有则进入 chord_started 等待状态，而不立即触发单键动作。
 */
function chordPrefixMatches(
  prefix: ParsedKeystroke[],
  binding: ParsedBinding,
): boolean {
  if (prefix.length >= binding.chord.length) return false
  for (let i = 0; i < prefix.length; i++) {
    const prefixKey = prefix[i]
    const bindingKey = binding.chord[i]
    if (!prefixKey || !bindingKey) return false
    if (!keystrokesEqual(prefixKey, bindingKey)) return false
  }
  return true
}

/**
 * 判断一组按键序列是否与某条绑定和弦完全匹配（长度相等且每键逐一相等）。
 */
function chordExactlyMatches(
  chord: ParsedKeystroke[],
  binding: ParsedBinding,
): boolean {
  if (chord.length !== binding.chord.length) return false
  for (let i = 0; i < chord.length; i++) {
    const chordKey = chord[i]
    const bindingKey = binding.chord[i]
    if (!chordKey || !bindingKey) return false
    if (!keystrokesEqual(chordKey, bindingKey)) return false
  }
  return true
}

/**
 * Resolve a key with chord state support.
 *
 * This function handles multi-keystroke chord bindings like "ctrl+k ctrl+s".
 *
 * @param input - The character input from Ink
 * @param key - The Key object from Ink with modifier flags
 * @param activeContexts - Array of currently active contexts
 * @param bindings - All parsed bindings
 * @param pending - Current chord state (null if not in a chord)
 * @returns Resolution result with chord state
 */
export function resolveKeyWithChordState(
  input: string,
  key: Key,
  activeContexts: KeybindingContextName[],
  bindings: ParsedBinding[],
  pending: ParsedKeystroke[] | null,
): ChordResolveResult {
  // Cancel chord on escape
  if (key.escape && pending !== null) {
    return { type: 'chord_cancelled' }
  }

  // Build current keystroke
  const currentKeystroke = buildKeystroke(input, key)
  if (!currentKeystroke) {
    if (pending !== null) {
      return { type: 'chord_cancelled' }
    }
    return { type: 'none' }
  }

  // Build the full chord sequence to test
  const testChord = pending
    ? [...pending, currentKeystroke]
    : [currentKeystroke]

  // Filter bindings by active contexts (Set lookup: O(n) instead of O(n·m))
  const ctxSet = new Set(activeContexts)
  const contextBindings = bindings.filter(b => ctxSet.has(b.context))

  // Check if this could be a prefix for longer chords. Group by chord
  // string so a later null-override shadows the default it unbinds —
  // otherwise null-unbinding `ctrl+x ctrl+k` still makes `ctrl+x` enter
  // chord-wait and the single-key binding on the prefix never fires.
  const chordWinners = new Map<string, string | null>()
  for (const binding of contextBindings) {
    if (
      binding.chord.length > testChord.length &&
      chordPrefixMatches(testChord, binding)
    ) {
      chordWinners.set(chordToString(binding.chord), binding.action)
    }
  }
  let hasLongerChords = false
  for (const action of chordWinners.values()) {
    if (action !== null) {
      hasLongerChords = true
      break
    }
  }

  // If this keystroke could start a longer chord, prefer that
  // (even if there's an exact single-key match)
  if (hasLongerChords) {
    return { type: 'chord_started', pending: testChord }
  }

  // Check for exact matches (last one wins)
  let exactMatch: ParsedBinding | undefined
  for (const binding of contextBindings) {
    if (chordExactlyMatches(testChord, binding)) {
      exactMatch = binding
    }
  }

  if (exactMatch) {
    if (exactMatch.action === null) {
      return { type: 'unbound' }
    }
    return { type: 'match', action: exactMatch.action }
  }

  // No match and no potential longer chords
  if (pending !== null) {
    return { type: 'chord_cancelled' }
  }

  return { type: 'none' }
}
