/**
 * 默认 Shell 解析模块。
 *
 * 在 Claude Code 系统中，该模块为输入框 `!` 命令和 Hook 执行
 * 提供默认 Shell 类型决策。解析优先级按 docs/design/ps-shell-selection.md §4.2 定义：
 *   settings.defaultShell → 'bash'
 *
 * 注意：在所有平台（含 Windows）上，默认均为 'bash'，
 * 不会自动切换到 PowerShell，以避免破坏已有的 Windows bash hooks。
 *
 * 主要导出：
 * - `resolveDefaultShell()`：返回用户设置的默认 Shell 或 'bash'
 */
import { getInitialSettings } from '../settings/settings.js'

/**
 * 解析输入框 `!` 命令所使用的默认 Shell。
 *
 * 读取初始化设置中的 `defaultShell` 字段；
 * 若未配置，则统一回退到 `'bash'`。
 *
 * @returns `'bash'` 或 `'powershell'`
 */
export function resolveDefaultShell(): 'bash' | 'powershell' {
  // 读取用户设置中的 defaultShell，未设置时回退到 'bash'
  return getInitialSettings().defaultShell ?? 'bash'
}
