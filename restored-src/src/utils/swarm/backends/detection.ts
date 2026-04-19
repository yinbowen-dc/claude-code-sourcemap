/**
 * 终端环境检测模块（tmux / iTerm2）
 *
 * 在 Claude Code 系统流程中的位置：
 * 该模块是 Swarm 多智能体系统后端选择流程的入口。
 * registry.ts 在选择「用哪种方式生成 teammate 窗格」时，
 * 首先调用本模块的函数判断当前终端环境，从而决定使用
 * TmuxBackend、ITermBackend 还是 InProcessBackend。
 *
 * 关键设计决策：
 * 1. ORIGINAL_USER_TMUX 和 ORIGINAL_TMUX_PANE 在模块加载时捕获：
 *    Shell.ts 后续会覆盖 process.env.TMUX（设置 Claude 自己的 socket），
 *    因此必须在覆盖前保存原始值。
 * 2. isInsideTmux 系列函数仅检查 TMUX 环境变量，不运行 `tmux display-message`：
 *    后者即使系统上有任意 tmux 服务器在运行也会成功，会产生误判。
 * 3. isInITerm2 组合多个指示符（TERM_PROGRAM、ITERM_SESSION_ID、env.terminal），
 *    提高检测可靠性。
 * 4. 检测结果均缓存，因为进程生命周期内终端环境不会变化。
 *
 * 主要导出：
 * - isInsideTmuxSync / isInsideTmux：检测是否在 tmux 内（同步/异步）
 * - getLeaderPaneId：获取领导者原始窗格 ID
 * - isTmuxAvailable：检测系统中 tmux 是否安装
 * - isInITerm2：检测是否在 iTerm2 内
 * - isIt2CliAvailable：检测 it2 CLI 是否可用并能连接 iTerm2 Python API
 * - resetDetectionCache：重置缓存（测试用）
 */

import { env } from '../../../utils/env.js'
import { execFileNoThrow } from '../../../utils/execFileNoThrow.js'
import { TMUX_COMMAND } from '../constants.js'

/**
 * 在模块加载时捕获用户原始的 TMUX 环境变量。
 * Shell.ts 后续会修改 process.env.TMUX，所以必须在此刻保存原始值。
 * 有值说明用户是从 tmux 会话中启动 Claude 的。
 */
// eslint-disable-next-line custom-rules/no-process-env-top-level
const ORIGINAL_USER_TMUX = process.env.TMUX

/**
 * 在模块加载时捕获 tmux 窗格 ID（如 %0、%1）。
 * TMUX_PANE 由 tmux 自动设置，标识当前进程所在的窗格。
 * 即使用户后来切换到其他窗格，领导者的原始窗格 ID 也不会丢失。
 */
// eslint-disable-next-line custom-rules/no-process-env-top-level
const ORIGINAL_TMUX_PANE = process.env.TMUX_PANE

// ─── 缓存变量 ─────────────────────────────────────────────────────────────────

/** isInsideTmux 的缓存结果，null 表示未计算 */
let isInsideTmuxCached: boolean | null = null

/** isInITerm2 的缓存结果，null 表示未计算 */
let isInITerm2Cached: boolean | null = null

// ─── tmux 检测 ────────────────────────────────────────────────────────────────

/**
 * 同步版本：检测当前进程是否运行在 tmux 会话中。
 *
 * 实现原理：直接检查模块加载时保存的 ORIGINAL_USER_TMUX 值。
 * 不使用 process.env.TMUX，因为 Shell.ts 可能已经覆盖了它。
 *
 * 重要说明：仅依赖 TMUX 环境变量，不运行 `tmux display-message`，
 * 因为该命令在系统中任何 tmux 服务器运行时都会成功，无法区分
 * "我自己在 tmux 里" 与 "系统上有 tmux 但我不在其中"。
 */
export function isInsideTmuxSync(): boolean {
  return !!ORIGINAL_USER_TMUX
}

/**
 * 异步版本：检测当前进程是否运行在 tmux 会话中（带缓存）。
 *
 * 与同步版本逻辑相同，仅检查 ORIGINAL_USER_TMUX 环境变量。
 * 缓存结果，因为进程生命周期内该值不会变化。
 *
 * 重要说明：不运行 `tmux display-message` 作为回退，原因同上。
 */
export async function isInsideTmux(): Promise<boolean> {
  // 缓存命中时直接返回
  if (isInsideTmuxCached !== null) {
    return isInsideTmuxCached
  }

  // 仅检查模块加载时保存的原始 TMUX 环境变量
  // TMUX 未设置则明确表示不在 tmux 中
  isInsideTmuxCached = !!ORIGINAL_USER_TMUX
  return isInsideTmuxCached
}

/**
 * 获取领导者进程的 tmux 窗格 ID（模块加载时捕获）。
 * 若不在 tmux 中（TMUX_PANE 未设置）则返回 null。
 * 即使用户切换窗格，此值也始终指向领导者的原始窗格。
 */
export function getLeaderPaneId(): string | null {
  return ORIGINAL_TMUX_PANE || null
}

/**
 * 检测系统中 tmux 是否已安装并在 PATH 中可用。
 * 通过运行 `tmux -V` 来验证：返回版本号则安装正常。
 * 不依赖任何环境变量，纯粹检测 tmux 二进制文件的可用性。
 */
export async function isTmuxAvailable(): Promise<boolean> {
  // 运行 tmux -V 并检查退出码，0 表示正常
  const result = await execFileNoThrow(TMUX_COMMAND, ['-V'])
  return result.code === 0
}

// ─── iTerm2 检测 ──────────────────────────────────────────────────────────────

/**
 * 检测当前进程是否运行在 iTerm2 终端中（带缓存）。
 *
 * 采用多重检测策略，提高可靠性：
 * 1. TERM_PROGRAM 环境变量等于 "iTerm.app"
 * 2. ITERM_SESSION_ID 环境变量存在（iTerm2 自动设置）
 * 3. utils/env.ts 中的 env.terminal 属性等于 "iTerm.app"
 *
 * 三个条件满足任一即视为在 iTerm2 中运行。
 * 结果缓存，因为终端类型在进程生命周期内不变。
 *
 * 注意：iTerm2 后端使用 AppleScript（osascript），是 macOS 内置工具，
 * 无需安装额外依赖。
 */
export function isInITerm2(): boolean {
  // 命中缓存时直接返回
  if (isInITerm2Cached !== null) {
    return isInITerm2Cached
  }

  // 检测多个 iTerm2 指示符
  const termProgram = process.env.TERM_PROGRAM
  // ITERM_SESSION_ID 是 iTerm2 自动注入的会话标识符
  const hasItermSessionId = !!process.env.ITERM_SESSION_ID
  // env.terminal 来自 utils/env.ts 的跨平台终端检测
  const terminalIsITerm = env.terminal === 'iTerm.app'

  // 任一条件满足即认为在 iTerm2 中
  isInITerm2Cached =
    termProgram === 'iTerm.app' || hasItermSessionId || terminalIsITerm

  return isInITerm2Cached
}

/**
 * it2 CLI 工具的命令名称。
 * it2 是 iTerm2 Python API 的命令行封装，用于操作 iTerm2 窗格。
 */
export const IT2_COMMAND = 'it2'

/**
 * 检测 it2 CLI 是否已安装且能连接到 iTerm2 Python API。
 *
 * 重要：使用 'session list' 而非 '--version' 来验证，
 * 原因：'--version' 即使 iTerm2 的 Python API 未启用也会成功，
 * 而 'session list' 要求 Python API 正常运行，
 * 若 API 未启用，后续的 'session split' 也会失败。
 * 因此 'session list' 是更可靠的前置检查。
 */
export async function isIt2CliAvailable(): Promise<boolean> {
  // 使用 'session list' 验证 Python API 连通性
  const result = await execFileNoThrow(IT2_COMMAND, ['session', 'list'])
  return result.code === 0
}

// ─── 测试工具 ─────────────────────────────────────────────────────────────────

/**
 * 重置所有检测结果的缓存。
 * 仅供测试使用，允许在测试用例间模拟不同的终端环境。
 */
export function resetDetectionCache(): void {
  isInsideTmuxCached = null
  isInITerm2Cached = null
}
