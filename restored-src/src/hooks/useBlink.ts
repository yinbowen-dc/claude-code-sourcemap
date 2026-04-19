/**
 * useBlink.ts
 *
 * 【在系统流程中的位置】
 * 本文件属于 Claude Code 的「UI 动画」辅助 hook，提供同步闪烁动画能力。
 *
 * 核心设计：
 * - 所有使用 useBlink 的组件共享同一个动画时钟（通过 useAnimationFrame），
 *   因此所有实例的闪烁相位保持同步，视觉上一致；
 * - 当终端失去焦点时（useTerminalFocus 返回 false），动画自动暂停，
 *   避免在用户不可见时消耗资源；
 * - 通过将 time 除以 intervalMs 再取模 2，实现固定频率的开/关交替效果；
 * - 未启用（enabled=false）或失焦时，始终返回 isVisible=true（保持显示状态）。
 */

import { type DOMElement, useAnimationFrame, useTerminalFocus } from '../ink.js'

/** 默认闪烁间隔（毫秒）：600ms 完成一个开/关周期 */
const BLINK_INTERVAL_MS = 600

/**
 * 同步闪烁动画 hook。
 *
 * 所有实例共享同一动画时钟，因此始终保持同步。
 * 当终端失去焦点时自动暂停动画（节省资源）。
 *
 * Hook for synchronized blinking animations that pause when offscreen.
 *
 * Returns a ref to attach to the animated element and the current blink state.
 * All instances blink together because they derive state from the same
 * animation clock. The clock only runs when at least one subscriber is visible.
 * Pauses when the terminal is blurred.
 *
 * @param enabled - Whether blinking is active
 * @returns [ref, isVisible] - Ref to attach to element, true when visible in blink cycle
 *
 * @example
 * function BlinkingDot({ shouldAnimate }) {
 *   const [ref, isVisible] = useBlink(shouldAnimate)
 *   return <Box ref={ref}>{isVisible ? '●' : ' '}</Box>
 * }
 */
export function useBlink(
  enabled: boolean,
  intervalMs: number = BLINK_INTERVAL_MS,
): [ref: (element: DOMElement | null) => void, isVisible: boolean] {
  // 检测终端焦点状态：失焦时暂停动画（useTerminalFocus 返回 false）
  const focused = useTerminalFocus()
  // 仅在 enabled 且 focused 时订阅动画帧；否则传 null 暂停时钟
  const [ref, time] = useAnimationFrame(enabled && focused ? intervalMs : null)

  // 未启用或失焦时保持 isVisible=true（静止显示，不隐藏内容）
  if (!enabled || !focused) return [ref, true]

  // 从全局时间推导闪烁状态：同一时刻所有订阅者看到相同的 time，因此同步
  // Math.floor(time / intervalMs) % 2 === 0 → 偶数周期可见（true），奇数周期不可见（false）
  const isVisible = Math.floor(time / intervalMs) % 2 === 0
  return [ref, isVisible]
}
