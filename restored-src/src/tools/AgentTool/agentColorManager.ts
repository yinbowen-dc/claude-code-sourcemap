/**
 * 子 Agent 颜色管理模块
 *
 * 在 Claude Code 工具层中，该模块负责管理子 Agent 在 UI 界面中的颜色分配。
 * 每种 Agent 类型可被分配一种主题颜色（共 8 种），用于在终端 / 交互式面板中
 * 区分不同 Agent 的输出，提升可读性。
 *
 * 颜色信息存储于全局 agentColorMap（由 bootstrap/state 提供），在运行期间
 * 通过 setAgentColor / getAgentColor 读写。
 */
import { getAgentColorMap } from '../../bootstrap/state.js'
import type { Theme } from '../../utils/theme.js'

export type AgentColorName =
  | 'red'
  | 'blue'
  | 'green'
  | 'yellow'
  | 'purple'
  | 'orange'
  | 'pink'
  | 'cyan'

export const AGENT_COLORS: readonly AgentColorName[] = [
  'red',
  'blue',
  'green',
  'yellow',
  'purple',
  'orange',
  'pink',
  'cyan',
] as const

/** 将 AgentColorName 映射到 Theme 中对应的专属主题键（仅供子 Agent 使用）。 */
export const AGENT_COLOR_TO_THEME_COLOR = {
  red: 'red_FOR_SUBAGENTS_ONLY',
  blue: 'blue_FOR_SUBAGENTS_ONLY',
  green: 'green_FOR_SUBAGENTS_ONLY',
  yellow: 'yellow_FOR_SUBAGENTS_ONLY',
  purple: 'purple_FOR_SUBAGENTS_ONLY',
  orange: 'orange_FOR_SUBAGENTS_ONLY',
  pink: 'pink_FOR_SUBAGENTS_ONLY',
  cyan: 'cyan_FOR_SUBAGENTS_ONLY',
} as const satisfies Record<AgentColorName, keyof Theme>

/**
 * 获取指定 Agent 类型当前被分配的主题颜色。
 *
 * general-purpose Agent 不使用颜色（返回 undefined）。
 * 其他 Agent 从全局 agentColorMap 中查找已分配的颜色，
 * 若找到则转换为 Theme 中对应的颜色键并返回。
 */
export function getAgentColor(agentType: string): keyof Theme | undefined {
  if (agentType === 'general-purpose') {
    // 通用 Agent 无需颜色区分
    return undefined
  }

  const agentColorMap = getAgentColorMap()

  // 检查该 Agent 类型是否已有颜色分配
  const existingColor = agentColorMap.get(agentType)
  if (existingColor && AGENT_COLORS.includes(existingColor)) {
    return AGENT_COLOR_TO_THEME_COLOR[existingColor]
  }

  return undefined
}

/**
 * 为指定 Agent 类型设置颜色。
 *
 * - 传入 undefined 时，从 agentColorMap 中删除该 Agent 的颜色记录
 * - 传入有效颜色名时，将其写入全局 agentColorMap
 * - 无效颜色名（不在 AGENT_COLORS 列表中）会被忽略
 */
export function setAgentColor(
  agentType: string,
  color: AgentColorName | undefined,
): void {
  const agentColorMap = getAgentColorMap()

  if (!color) {
    agentColorMap.delete(agentType)
    return
  }

  if (AGENT_COLORS.includes(color)) {
    agentColorMap.set(agentType, color)
  }
}
