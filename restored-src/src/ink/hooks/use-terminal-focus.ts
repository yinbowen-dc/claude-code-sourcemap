/**
 * @file hooks/use-terminal-focus.ts
 * 终端窗口焦点状态 Hook
 *
 * 在 Claude Code 的 Ink 输入体系中，本文件处于终端状态感知层：
 *   终端发送的 DECSET 1004 焦点报告序列（\x1b[I 获焦 / \x1b[O 失焦）
 *   → App（解析序列，更新 TerminalFocusContext）
 *   → 【本文件：useTerminalFocus 从上下文读取焦点状态】
 *   → 动画组件（焦点丢失时降频刷新）/ 输入组件（焦点状态显示）
 *
 * 核心功能：
 *  - 暴露终端窗口的物理焦点状态（区别于 React 组件的逻辑焦点）
 *  - 焦点序列（\x1b[I / \x1b[O）由 Ink 自动过滤，不传给 useInput
 *  - 初始状态（终端不支持焦点报告时）视为已聚焦（返回 true），保证默认可用
 */

import { useContext } from 'react'
import TerminalFocusContext from '../components/TerminalFocusContext.js'

/**
 * 获取终端窗口焦点状态的 React Hook。
 *
 * 通过 DECSET 1004（Focus Reporting Mode）实现：
 *  - 终端支持时：真实反映窗口焦点状态
 *  - 终端不支持时：始终返回 true（不影响功能，仅失去降频优化）
 *
 * 焦点序列由 Ink 在 stdin 解析层统一过滤，组件无需手动处理。
 *
 * @returns 终端是否聚焦（或焦点状态未知时为 true）
 */
export function useTerminalFocus(): boolean {
  // 从上下文读取 isTerminalFocused 状态
  const { isTerminalFocused } = useContext(TerminalFocusContext)
  return isTerminalFocused
}
