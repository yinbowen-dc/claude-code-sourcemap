/**
 * Shell 工具通用工具函数模块。
 *
 * 在 Claude Code 系统流中，本模块处于以下位置：
 *   tools.ts（工具注册）→ shellToolUtils.ts（运行时门控）
 *                         ↓
 *   BashTool / PowerShellTool（可见性判断）
 *   processBashCommand（! 命令路由）
 *   promptShellExecution（技能前置路由）
 *
 * 职责：
 * - 导出所有 shell 工具名称的常量数组（SHELL_TOOL_NAMES），
 *   供需要匹配"任意 shell 工具"的逻辑使用
 * - 提供 isPowerShellToolEnabled() 运行时门控函数，
 *   统一控制 PowerShellTool 在不同平台和用户类型下的可见性
 *
 * 设计决策：
 * - PowerShellTool 仅在 Windows 上启用（权限引擎使用 Win32 特定的路径规范化）
 * - Ant 内部用户默认启用（可通过 env=0 关闭）
 * - 外部用户默认关闭（可通过 env=1 选择启用）
 */
import { BASH_TOOL_NAME } from '../../tools/BashTool/toolName.js'
import { POWERSHELL_TOOL_NAME } from '../../tools/PowerShellTool/toolName.js'
import { isEnvDefinedFalsy, isEnvTruthy } from '../envUtils.js'
import { getPlatform } from '../platform.js'

/**
 * 所有 shell 工具名称的数组。
 * 用于需要"匹配任意 shell 工具"的地方（如工具列表过滤、工具调用路由等）。
 */
export const SHELL_TOOL_NAMES: string[] = [BASH_TOOL_NAME, POWERSHELL_TOOL_NAME]

/**
 * 运行时门控：判断 PowerShellTool 是否在当前环境中启用。
 *
 * 此门控被以下三个路径共用，确保可见性判断的一致性：
 * 1. tools.ts：控制工具列表中 PowerShellTool 的可见性
 * 2. processBashCommand：控制 `!` 命令的路由目标
 * 3. promptShellExecution：控制技能前置路由
 *
 * 启用条件（必须同时满足）：
 * 1. 当前平台为 Windows（权限引擎使用 Win32 特定路径规范化，其他平台无效）
 * 2. 用户类型为 ant：默认启用（除非 CLAUDE_CODE_USE_POWERSHELL_TOOL=0/false/no）
 *    用户类型为外部：默认关闭（除非 CLAUDE_CODE_USE_POWERSHELL_TOOL=1/true/yes）
 *
 * @returns true 表示 PowerShellTool 应启用，false 表示不启用
 */
export function isPowerShellToolEnabled(): boolean {
  // 非 Windows 平台，PowerShellTool 不可用（权限引擎依赖 Win32 路径规范化）
  if (getPlatform() !== 'windows') return false
  // Ant 内部用户：默认启用，仅当环境变量明确设为假值时关闭
  // 外部用户：默认关闭，仅当环境变量明确设为真值时启用
  return process.env.USER_TYPE === 'ant'
    ? !isEnvDefinedFalsy(process.env.CLAUDE_CODE_USE_POWERSHELL_TOOL)
    : isEnvTruthy(process.env.CLAUDE_CODE_USE_POWERSHELL_TOOL)
}
