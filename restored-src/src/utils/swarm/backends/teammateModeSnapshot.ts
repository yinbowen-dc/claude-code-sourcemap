/**
 * Teammate 模式快照模块
 *
 * 在 Claude Code 系统流程中的位置：
 * 该模块在会话启动阶段（main.tsx 早期初始化）捕获 teammate 运行模式，
 * 并在整个会话生命周期内保持该值不变，即使用户在运行时修改配置也不受影响。
 * 这与 hooksConfigSnapshot.ts 采用相同的「启动时快照」设计模式。
 *
 * Teammate 模式说明：
 * - 'auto'：自动检测，根据终端环境选择最合适的模式（tmux 或 in-process）
 * - 'tmux'：强制使用 tmux/iTerm2 窗格后端，每个 teammate 独占一个终端窗格
 * - 'in-process'：强制在同一 Node.js 进程中运行 teammate，使用 AsyncLocalStorage 隔离
 *
 * 优先级：CLI 参数（--teammate-mode）> 全局配置（config.teammateMode）> 默认值 'auto'
 *
 * 主要导出：
 * - captureTeammateModeSnapshot：在会话启动时快照当前模式
 * - getTeammateModeFromSnapshot：获取快照值（整个会话使用同一值）
 * - setCliTeammateModeOverride：在快照前设置 CLI 参数覆盖值
 * - clearCliTeammateModeOverride：允许用户通过 UI 修改设置后生效
 * - getCliTeammateModeOverride：获取当前 CLI 覆盖值
 */

import { getGlobalConfig } from '../../../utils/config.js'
import { logForDebugging } from '../../../utils/debug.js'
import { logError } from '../../../utils/log.js'

/** Teammate 运行模式类型 */
export type TeammateMode = 'auto' | 'tmux' | 'in-process'

// ─── 模块级状态 ───────────────────────────────────────────────────────────────

/** 会话启动时捕获的模式快照，null 表示尚未初始化 */
let initialTeammateMode: TeammateMode | null = null

/** CLI 参数覆盖值（--teammate-mode），null 表示未通过 CLI 指定 */
let cliTeammateModeOverride: TeammateMode | null = null

// ─── CLI 覆盖管理 ─────────────────────────────────────────────────────────────

/**
 * 设置来自 CLI 参数的模式覆盖值。
 * 必须在 captureTeammateModeSnapshot() 调用之前设置，
 * 才能确保 CLI 参数具有最高优先级。
 *
 * 调用时机：main.tsx 解析 CLI 参数（--teammate-mode）后立即调用。
 *
 * @param mode CLI 指定的 teammate 模式
 */
export function setCliTeammateModeOverride(mode: TeammateMode): void {
  cliTeammateModeOverride = mode
}

/**
 * 获取当前 CLI 参数覆盖值。
 *
 * @returns CLI 指定的模式，若未通过 CLI 指定则返回 null
 */
export function getCliTeammateModeOverride(): TeammateMode | null {
  return cliTeammateModeOverride
}

/**
 * 清除 CLI 覆盖值，并将快照更新为用户在 UI 中选择的新模式。
 *
 * 使用场景：用户通过 UI（如设置面板）修改了 teammate 模式后，
 * 希望新设置立即在当前会话中生效（不再被 CLI 参数覆盖）。
 *
 * 注意：直接接受 newMode 参数而非重新读取配置，
 * 是为了避免异步读取配置时的竞争条件。
 *
 * @param newMode 用户在 UI 中选择的新模式（直接传入以避免竞争条件）
 */
export function clearCliTeammateModeOverride(newMode: TeammateMode): void {
  // 清除 CLI 覆盖，使用户的 UI 选择生效
  cliTeammateModeOverride = null
  // 同步更新快照，当前会话立即使用新模式
  initialTeammateMode = newMode
  logForDebugging(
    `[TeammateModeSnapshot] CLI override cleared, new mode: ${newMode}`,
  )
}

// ─── 快照管理 ─────────────────────────────────────────────────────────────────

/**
 * 在会话启动时捕获 teammate 运行模式快照。
 *
 * 调用时机：main.tsx 的早期初始化阶段，解析完 CLI 参数后调用。
 *
 * 优先级逻辑：
 * 1. 若存在 CLI 覆盖值（--teammate-mode），使用该值。
 * 2. 否则读取全局配置中的 config.teammateMode，若未配置则默认为 'auto'。
 */
export function captureTeammateModeSnapshot(): void {
  if (cliTeammateModeOverride) {
    // CLI 参数具有最高优先级
    initialTeammateMode = cliTeammateModeOverride
    logForDebugging(
      `[TeammateModeSnapshot] Captured from CLI override: ${initialTeammateMode}`,
    )
  } else {
    // 从全局配置读取，未配置时默认为 'auto'
    const config = getGlobalConfig()
    initialTeammateMode = config.teammateMode ?? 'auto'
    logForDebugging(
      `[TeammateModeSnapshot] Captured from config: ${initialTeammateMode}`,
    )
  }
}

/**
 * 获取本次会话的 teammate 运行模式。
 * 返回启动时捕获的快照值，忽略运行时的配置变更（除非通过 clearCliTeammateModeOverride 显式更新）。
 *
 * 若快照尚未初始化（null），说明存在初始化 Bug：
 * captureTeammateModeSnapshot 应在会话 setup() 阶段调用。
 * 此时会记录错误并触发补救性捕获，确保函数始终返回有效值。
 *
 * @returns 当前会话使用的 teammate 运行模式
 */
export function getTeammateModeFromSnapshot(): TeammateMode {
  if (initialTeammateMode === null) {
    // 初始化 Bug：捕获应在 setup() 中发生，此处记录错误并补救
    logError(
      new Error(
        'getTeammateModeFromSnapshot called before capture - this indicates an initialization bug',
      ),
    )
    // 触发补救性捕获，尽量返回正确值
    captureTeammateModeSnapshot()
  }
  // 保险回退：理论上不应触发（补救捕获后 initialTeammateMode 不会为 null）
  return initialTeammateMode ?? 'auto'
}
