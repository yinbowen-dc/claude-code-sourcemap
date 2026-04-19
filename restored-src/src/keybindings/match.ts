/**
 * 按键匹配模块
 *
 * 【在 Claude Code 键位绑定系统中的位置与作用】
 * 本文件是键位绑定系统的"运行时匹配层"，负责将 Ink 框架上报的原始按键事件
 * 与解析好的 ParsedKeystroke / ParsedBinding 进行比对：
 *
 *   parser（解析配置字符串 → ParsedKeystroke）
 *     → match（本文件，运行时将 Ink Key 事件与 ParsedKeystroke 对比）
 *       → resolver（调用 matchesBinding，完成"按键 → 动作"的最终裁决）
 *
 * 核心导出：
 *  - getKeyName：从 Ink 的 Key 对象 + input 字符串中提取规范化的按键名称
 *  - matchesKeystroke：判断一次按键事件是否与某个 ParsedKeystroke 匹配
 *  - matchesBinding：判断一次按键事件是否与某条 ParsedBinding 的第一个键击匹配
 *
 * 注意事项：
 *  - Ink 对 meta/alt 的处理存在历史遗留问题（escape 会导致 key.meta=true），
 *    本模块对此做了专项规避处理。
 *  - Super（cmd/win）修饰键仅在支持 Kitty 键盘协议的终端中有效。
 */

import type { Key } from '../ink.js'
import type { ParsedBinding, ParsedKeystroke } from './types.js'

/**
 * 用于匹配的 Ink Key 修饰键子集。
 * 注意：`fn` 键被有意排除，因其在终端应用中几乎不会用到。
 * (Modifier keys from Ink's Key type that we care about for matching.
 *  `fn` from Key is intentionally excluded as it's rarely used.)
 */
type InkModifiers = Pick<Key, 'ctrl' | 'shift' | 'meta' | 'super'>

/**
 * 从 Ink 的 Key 对象中提取我们关心的修饰键子集。
 * 显式提取确保只处理匹配时需要的修饰键，忽略 fn 等无关字段。
 */
function getInkModifiers(key: Key): InkModifiers {
  return {
    ctrl: key.ctrl,
    shift: key.shift,
    meta: key.meta,
    super: key.super,
  }
}

/**
 * 从 Ink 的 Key 对象和 input 字符串中提取规范化的按键名称。
 *
 * 将 Ink 的布尔标志（key.escape、key.return 等）映射为与 ParsedKeystroke.key
 * 格式一致的字符串名称；单字符输入则转小写后直接返回。
 *
 * @param input - Ink 上报的原始输入字符串
 * @param key   - Ink 的 Key 对象，含各按键的布尔标志
 * @returns 规范化的按键名称（如 'escape'、'enter'、'up'、'a'），无法识别时返回 null
 */
export function getKeyName(input: string, key: Key): string | null {
  // 优先检查特殊键（顺序与 Ink Key 类型字段对应）
  if (key.escape) return 'escape'
  if (key.return) return 'enter'
  if (key.tab) return 'tab'
  if (key.backspace) return 'backspace'
  if (key.delete) return 'delete'
  if (key.upArrow) return 'up'
  if (key.downArrow) return 'down'
  if (key.leftArrow) return 'left'
  if (key.rightArrow) return 'right'
  if (key.pageUp) return 'pageup'
  if (key.pageDown) return 'pagedown'
  if (key.wheelUp) return 'wheelup'
  if (key.wheelDown) return 'wheeldown'
  if (key.home) return 'home'
  if (key.end) return 'end'
  // 单字符输入（普通字母、数字、符号）转小写后直接用作按键名
  if (input.length === 1) return input.toLowerCase()
  // 无法识别的按键（多字节序列或未知转义码）
  return null
}

/**
 * 检查 Ink Key 修饰键是否与 ParsedKeystroke 的修饰键完全匹配。
 *
 * 特殊处理规则：
 * - Alt 与 Meta：Ink 历史上将 Alt/Option 键映射为 key.meta，
 *   因此配置中的 `alt` 和 `meta` 修饰键都通过检查 key.meta 来匹配，两者等价。
 * - Super（Cmd/Win）：与 alt/meta 独立，仅在支持 kitty 键盘协议的终端中有效；
 *   不支持 kitty 协议的终端永远无法触发 super 相关绑定。
 *
 * @param inkMods  - 从 Ink Key 对象提取的修饰键状态
 * @param target   - 要对比的 ParsedKeystroke 目标修饰键
 * @returns 所有修饰键均匹配时返回 true
 */
function modifiersMatch(
  inkMods: InkModifiers,
  target: ParsedKeystroke,
): boolean {
  // 检查 ctrl 修饰键
  if (inkMods.ctrl !== target.ctrl) return false

  // 检查 shift 修饰键
  if (inkMods.shift !== target.shift) return false

  // alt 和 meta 在 Ink 中都映射到 key.meta（终端限制）
  // 因此只要配置中要求 alt 或 meta 之一，都通过 inkMods.meta 判断
  const targetNeedsMeta = target.alt || target.meta
  if (inkMods.meta !== targetNeedsMeta) return false

  // super (cmd/win) 是独立于 alt/meta 的修饰键
  if (inkMods.super !== target.super) return false

  return true
}

/**
 * 判断一次 Ink 按键事件是否与给定的 ParsedKeystroke 匹配。
 *
 * 处理流程：
 * 1. 从 input + key 中提取规范化按键名，与目标的 key 字段比较
 * 2. 提取 Ink 修饰键，调用 modifiersMatch 检查所有修饰键
 * 3. 针对 escape 键做特殊处理：Ink 在按下 escape 时会将 key.meta 设为 true
 *    （终端历史遗留行为），匹配 escape 键本身时需忽略该 meta 标志
 *
 * @param input  - Ink 上报的原始输入字符串
 * @param key    - Ink 的 Key 对象，含各按键的布尔标志
 * @param target - 要匹配的 ParsedKeystroke（由 parser 从配置字符串解析而来）
 * @returns 按键事件与目标完全匹配时返回 true
 */
export function matchesKeystroke(
  input: string,
  key: Key,
  target: ParsedKeystroke,
): boolean {
  // 首先检查按键名称是否匹配
  const keyName = getKeyName(input, key)
  if (keyName !== target.key) return false

  const inkMods = getInkModifiers(key)

  // QUIRK：Ink 在按下 escape 时会将 key.meta 设为 true（参见 input-event.ts）。
  // 这是终端 escape 序列处理方式导致的历史遗留行为。
  // 匹配 escape 键本身时必须忽略 meta 标志，否则不带修饰符的 "escape" 绑定将永远不会触发。
  if (key.escape) {
    return modifiersMatch({ ...inkMods, meta: false }, target)
  }

  return modifiersMatch(inkMods, target)
}

/**
 * 判断 Ink 按键事件是否与某条 ParsedBinding 的第一个键击匹配。
 * 仅处理单键绑定（chord.length === 1），和弦序列由 resolver 负责。
 *
 * @param input   - Ink 上报的原始输入字符串
 * @param key     - Ink 的 Key 对象
 * @param binding - 要对比的 ParsedBinding（含 chord 数组和 action）
 * @returns 按键与绑定第一个键击匹配时返回 true；和弦绑定直接返回 false
 */
export function matchesBinding(
  input: string,
  key: Key,
  binding: ParsedBinding,
): boolean {
  // 仅处理单键绑定；多键和弦由 resolver.resolveKeyWithChordState 负责
  if (binding.chord.length !== 1) return false
  const keystroke = binding.chord[0]
  if (!keystroke) return false
  return matchesKeystroke(input, key, keystroke)
}
