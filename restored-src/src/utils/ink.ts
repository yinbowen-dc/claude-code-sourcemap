/**
 * ink.ts — Ink 颜色转换工具模块
 *
 * 【在 Claude Code 系统流程中的位置】
 * 本文件位于工具层（utils），是 UI 渲染层（Ink 终端 UI 框架）的颜色适配器。
 *
 * Claude Code 使用 Ink（基于 React 的终端 UI 库）渲染交互界面。
 * AgentTool 的子代理（sub-agents）会被分配颜色标识，以便用户在
 * 多代理并发输出时区分不同代理的消息。
 *
 * 本模块的职责：
 *   将代理颜色名称（AgentColorName，如 'blue'、'green'）转换为
 *   Ink TextProps 的 color 属性所支持的格式：
 *   - 优先映射为主题颜色键（如 'cyan_FOR_SUBAGENTS_ONLY'），
 *     使颜色随当前终端主题动态调整；
 *   - 对未知颜色名称回退为原始 ANSI 颜色字符串（如 'ansi:blue'）。
 *
 * 调用方：AgentTool 的子代理输出渲染组件。
 */

import type { TextProps } from '../ink.js'
import {
  AGENT_COLOR_TO_THEME_COLOR,
  type AgentColorName,
} from '../tools/AgentTool/agentColorManager.js'

// 默认代理主题颜色（用于 sub-agent 的通用颜色标识）
const DEFAULT_AGENT_THEME_COLOR = 'cyan_FOR_SUBAGENTS_ONLY'

/**
 * 将颜色字符串转换为 Ink TextProps['color'] 支持的格式。
 *
 * 转换逻辑：
 *   1. 若 color 为 undefined 或空值，返回默认主题颜色（青色）；
 *   2. 若 color 是已知的 AgentColorName（如 'blue'、'green'），
 *      查找主题颜色映射表并返回对应的主题键，确保与终端主题一致；
 *   3. 若 color 不在映射表中（未知颜色），以 'ansi:xxx' 格式作为
 *      原始 ANSI 颜色直接传递给 Ink，保持兼容性。
 *
 * @param color - 颜色字符串（通常为 AgentColorName，也可能是任意字符串）
 * @returns Ink TextProps 的 color 属性值
 */
export function toInkColor(color: string | undefined): TextProps['color'] {
  if (!color) {
    // 无颜色信息时使用默认的子代理颜色（青色）
    return DEFAULT_AGENT_THEME_COLOR
  }
  // 尝试将颜色名称映射为主题颜色键（跟随终端主题变化）
  const themeColor = AGENT_COLOR_TO_THEME_COLOR[color as AgentColorName]
  if (themeColor) {
    return themeColor
  }
  // 映射表中不存在时，回退为原始 ANSI 颜色（以 'ansi:' 前缀标识）
  return `ansi:${color}` as TextProps['color']
}
