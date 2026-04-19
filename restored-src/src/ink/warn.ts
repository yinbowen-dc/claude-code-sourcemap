/**
 * 文件：warn.ts
 *
 * 【在 Claude Code 系统流程中的位置】
 * 本文件是 Ink 层的参数校验工具模块，提供一个轻量级的非整数值警告函数。
 * 布局相关代码（如 Yoga 节点尺寸、边距、字体大小等）在设置数值参数时调用此函数，
 * 以便在调试模式下捕获传入了浮点数等非整数值的情况。
 *
 * 【主要功能】
 * - `ifNotInteger(value, name)`：若 value 非 undefined 且非整数，
 *   通过 logForDebugging 以 'warn' 级别记录警告信息。
 */

import { logForDebugging } from '../utils/debug.js'

/**
 * 若传入值非整数，则记录调试警告。
 *
 * 【流程】
 * 1. value 为 undefined → 直接返回（可选参数未传时无需检查）
 * 2. Number.isInteger(value) 为 true → 值合法，直接返回
 * 3. 否则 → 调用 logForDebugging 以 'warn' 级别记录 "${name} should be an integer, got ${value}"
 *
 * 注意：此函数不会抛出异常，仅在调试模式下输出警告，不影响生产环境运行。
 *
 * @param value 待检测的数值（可选）
 * @param name 参数名称（用于生成警告信息）
 */
export function ifNotInteger(value: number | undefined, name: string): void {
  if (value === undefined) return  // 可选参数未提供，跳过检查
  if (Number.isInteger(value)) return  // 值为整数，合法，跳过
  // 非整数：以 warn 级别记录调试信息
  logForDebugging(`${name} should be an integer, got ${value}`, {
    level: 'warn',
  })
}
