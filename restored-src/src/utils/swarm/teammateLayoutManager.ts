/**
 * Swarm Teammate 布局管理模块（teammateLayoutManager.ts）
 *
 * 【在 Claude Code 系统流程中的位置】
 * 本模块处于 Swarm 多智能体系统的 UI 层，负责管理 Teammate 的颜色分配以及
 * 终端 Pane（分屏）的创建与控制。它是所有外部进程型 Teammate（tmux / iTerm2）
 * 在视觉层面的统一入口，通过 detectAndGetBackend() 自动选择适合当前环境的后端。
 *
 * 【主要职责】
 * 1. 维护 Teammate 颜色调色板的轮询分配（round-robin）；
 * 2. 代理 Pane 创建、边框状态启用和命令发送等操作给检测到的后端；
 * 3. 检测当前是否运行在 tmux 会话中，供上层逻辑决策使用。
 */

import type { AgentColorName } from '../../tools/AgentTool/agentColorManager.js'
import { AGENT_COLORS } from '../../tools/AgentTool/agentColorManager.js'
import { detectAndGetBackend } from './backends/registry.js'
import type { PaneBackend } from './backends/types.js'

// 持久化本次会话内的 Teammate 颜色分配（AgentID → 颜色名称）
const teammateColorAssignments = new Map<string, AgentColorName>()
// 当前颜色分配游标，用于轮询颜色调色板
let colorIndex = 0

/**
 * 获取当前环境中检测到的 Pane 后端（tmux 或 iTerm2）。
 *
 * 【执行流程】
 * 调用 detectAndGetBackend()，该函数内部会自动缓存检测结果，
 * 因此此处无需二次缓存。
 *
 * @returns 检测到的 PaneBackend 实例
 */
async function getBackend(): Promise<PaneBackend> {
  // detectAndGetBackend 自身已缓存，多次调用不会重复检测
  return (await detectAndGetBackend()).backend
}

/**
 * 为指定 Teammate 从颜色调色板中分配一个唯一颜色。
 *
 * 【执行流程】
 * 1. 检查是否已为该 Teammate 分配过颜色，若有则直接返回；
 * 2. 按照轮询顺序从 AGENT_COLORS 调色板中取下一个颜色；
 * 3. 将分配结果存入映射表并递增游标。
 *
 * @param teammateId - Teammate 的唯一标识（agentId）
 * @returns 分配到的颜色名称
 */
export function assignTeammateColor(teammateId: string): AgentColorName {
  // 若已分配颜色，直接复用（保证同一 Teammate 颜色一致）
  const existing = teammateColorAssignments.get(teammateId)
  if (existing) {
    return existing
  }

  // 使用取模运算实现循环颜色分配（防止越界）
  const color = AGENT_COLORS[colorIndex % AGENT_COLORS.length]!
  teammateColorAssignments.set(teammateId, color)
  colorIndex++

  return color
}

/**
 * 获取指定 Teammate 已分配的颜色（若存在）。
 *
 * @param teammateId - Teammate 的唯一标识
 * @returns 已分配的颜色名称，若未分配则返回 undefined
 */
export function getTeammateColor(
  teammateId: string,
): AgentColorName | undefined {
  return teammateColorAssignments.get(teammateId)
}

/**
 * 清除所有 Teammate 的颜色分配记录。
 *
 * 【调用时机】
 * 在团队清理（cleanupTeam）时调用，重置颜色状态以便下一个团队从头分配。
 */
export function clearTeammateColors(): void {
  teammateColorAssignments.clear()
  colorIndex = 0
}

/**
 * 检测当前是否运行在 tmux 会话中。
 *
 * 【执行流程】
 * 通过动态导入 backends/detection.js 调用 isInsideTmux() 检查 $TMUX 环境变量。
 *
 * @returns 若运行在 tmux 中则返回 true
 */
export async function isInsideTmux(): Promise<boolean> {
  // 动态导入以避免在非 tmux 环境中不必要地加载 tmux 模块
  const { isInsideTmux: checkTmux } = await import('./backends/detection.js')
  return checkTmux()
}

/**
 * 在 Swarm 视图中为指定 Teammate 创建一个新的 Pane（分屏）。
 *
 * 【布局说明】
 * - 在 tmux 内部运行：分割当前窗口，Leader 左侧（30%），Teammate 右侧（70%）；
 * - 在 iTerm2 中运行（有 it2 CLI）：使用原生 iTerm2 分屏；
 * - 在 tmux / iTerm2 之外运行：回退到带有外部 claude-swarm session 的 tmux 后端。
 *
 * @param teammateName  - Teammate 的显示名称
 * @param teammateColor - 该 Teammate 分配到的颜色名称
 * @returns paneId（新建 Pane 的唯一标识）和 isFirstTeammate（是否为首个 Teammate）
 */
export async function createTeammatePaneInSwarmView(
  teammateName: string,
  teammateColor: AgentColorName,
): Promise<{ paneId: string; isFirstTeammate: boolean }> {
  const backend = await getBackend()
  // 将创建逻辑委托给检测到的后端实现
  return backend.createTeammatePaneInSwarmView(teammateName, teammateColor)
}

/**
 * 为指定窗口启用 Pane 边框状态（显示 Pane 标题）。
 *
 * 【执行流程】
 * 将操作委托给检测到的后端（tmux 通过 set-window-option 实现，iTerm2 通过原生 API 实现）。
 *
 * @param windowTarget  - 目标窗口标识符（可选，默认为当前窗口）
 * @param useSwarmSocket - 是否使用 Swarm 专属 tmux socket
 */
export async function enablePaneBorderStatus(
  windowTarget?: string,
  useSwarmSocket = false,
): Promise<void> {
  const backend = await getBackend()
  return backend.enablePaneBorderStatus(windowTarget, useSwarmSocket)
}

/**
 * 向指定 Pane 发送命令字符串（模拟键盘输入）。
 *
 * 【执行流程】
 * 将操作委托给检测到的后端（tmux 通过 send-keys 实现，iTerm2 通过 AppleScript 实现）。
 *
 * @param paneId         - 目标 Pane 的唯一标识
 * @param command        - 要发送的命令字符串
 * @param useSwarmSocket - 是否使用 Swarm 专属 tmux socket
 */
export async function sendCommandToPane(
  paneId: string,
  command: string,
  useSwarmSocket = false,
): Promise<void> {
  const backend = await getBackend()
  return backend.sendCommandToPane(paneId, command, useSwarmSocket)
}
