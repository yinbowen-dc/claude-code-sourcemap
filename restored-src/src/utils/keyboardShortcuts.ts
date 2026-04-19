/**
 * keyboardShortcuts.ts — macOS Option 键特殊字符映射模块
 *
 * 【在 Claude Code 系统流程中的位置】
 * 本文件位于工具层（utils），是终端键盘输入处理管道中的一个适配层。
 * 在 macOS 上，当终端未启用"Option as Meta"（即 Option 键不映射为 Alt 键）时，
 * 按下 Option+字母会产生特殊 Unicode 字符（而非 ESC+字母序列）。
 * 本模块通过映射表将这些特殊字符与对应的快捷键名称关联，
 * 使 REPL 事件处理器能够识别 macOS 用户的 Option 键组合。
 *
 * 例如：
 *   - 用户按 Option+T → 终端输入 '†' → 本模块映射为 'alt+t' → 触发 thinking 开关
 *   - 用户按 Option+P → 终端输入 'π' → 本模块映射为 'alt+p' → 触发模型选择器
 *
 * 【主要功能】
 * 1. MACOS_OPTION_SPECIAL_CHARS — Option+键 产生的特殊字符到快捷键名的映射表；
 * 2. isMacosOptionChar — 类型守卫，检测字符是否为 macOS Option 键产生的特殊字符。
 */

/**
 * macOS Option+键 产生的特殊字符到快捷键名称的映射表。
 *
 * 当 macOS 终端未开启"Option as Meta"时，Option+字母键会输入特殊 Unicode 字符。
 * 本映射表将这些字符与 Claude Code 的快捷键命令对应起来，
 * 实现 macOS 下的 Option 键快捷键支持。
 *
 * as const satisfies Record<string, string>：
 *   - as const：使每个键值对保持字面量类型，支持精确的类型推导；
 *   - satisfies：在保留字面量类型的同时验证结构符合 Record<string, string>。
 */
export const MACOS_OPTION_SPECIAL_CHARS = {
  '†': 'alt+t', // Option+T → 切换 thinking（思考链）模式
  π: 'alt+p',   // Option+P → 打开模型选择器（model picker）
  ø: 'alt+o',   // Option+O → 切换 fast（快速）模式
} as const satisfies Record<string, string>

/**
 * 类型守卫：检测字符是否为 macOS Option 键产生的特殊字符。
 *
 * 使用 TypeScript 类型谓词（type predicate），返回 true 时
 * 将 char 的类型收窄为 keyof typeof MACOS_OPTION_SPECIAL_CHARS，
 * 允许调用方安全地通过映射表查找对应的快捷键名称。
 *
 * @param char - 待检测的字符
 * @returns 若 char 是已知的 macOS Option 特殊字符则返回 true
 */
export function isMacosOptionChar(
  char: string,
): char is keyof typeof MACOS_OPTION_SPECIAL_CHARS {
  // 利用 in 运算符检测字符是否为映射表的键
  return char in MACOS_OPTION_SPECIAL_CHARS
}
