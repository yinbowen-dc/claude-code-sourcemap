/**
 * @file hooks/use-animation-frame.ts
 * @description 可见性感知的动画帧 Hook，用于驱动终端内的同步动画。
 *
 * 在 Claude Code 的 Ink 渲染流水线中，本文件属于「动画时钟订阅」层：
 *   ClockContext（共享时钟） → useAnimationFrame（本文件） → 组件状态更新 → Ink 重渲染
 *                                        ↑
 *                            useTerminalViewport（可见性检测）
 *
 * 主要职责：
 *  - 以固定间隔（intervalMs）从共享 ClockContext 读取时间戳并触发状态更新。
 *  - 当组件不在终端视口内（isVisible = false）或 intervalMs = null 时，
 *    自动取消时钟订阅，停止不必要的渲染，节省 CPU。
 *  - 所有使用此 Hook 的组件共享同一时钟，动画保持帧级同步。
 *  - 返回的 ref 需绑定到动画元素，用于可见性检测。
 */

import { useContext, useEffect, useState } from 'react'
import { ClockContext } from '../components/ClockContext.js'
import type { DOMElement } from '../dom.js'
import { useTerminalViewport } from './use-terminal-viewport.js'

/**
 * 可见性感知的动画帧 Hook。
 *
 * 流程：
 *  1. 从 ClockContext 获取共享时钟实例。
 *  2. 通过 useTerminalViewport 获取元素可见性（ref + isVisible）。
 *  3. 仅在元素可见且 intervalMs 非 null 时向时钟订阅（keepAlive = true），
 *     不可见时自动退订，时间冻结在最后一次值。
 *  4. 每次时钟 tick，若距上次更新已超过 intervalMs，则 setTime 触发重渲染。
 *
 * @param intervalMs 动画更新间隔（毫秒），传 null 则暂停动画；默认 16ms（≈60fps）
 * @returns [ref, time]
 *   - ref  : 回调 ref，需绑定到被动画化的 DOM 元素（用于可见性检测）
 *   - time : 当前动画时间戳（毫秒），从共享时钟读取
 *
 * @example
 * function Spinner() {
 *   const [ref, time] = useAnimationFrame(120)
 *   const frame = Math.floor(time / 120) % FRAMES.length
 *   return <Box ref={ref}>{FRAMES[frame]}</Box>
 * }
 *
 * 终端失焦时时钟自动降速，消费者无需自行处理焦点状态。
 */
export function useAnimationFrame(
  intervalMs: number | null = 16,
): [ref: (element: DOMElement | null) => void, time: number] {
  // 从上下文获取共享时钟实例（可能为 null，如在测试环境中）
  const clock = useContext(ClockContext)
  // viewportRef 绑定到元素，isVisible 反映元素当前是否在终端视口内
  const [viewportRef, { isVisible }] = useTerminalViewport()
  // 初始时间从时钟读取（或 0），避免第一帧闪烁
  const [time, setTime] = useState(() => clock?.now() ?? 0)

  // 仅当元素可见且 intervalMs 不为 null 时激活动画
  const active = isVisible && intervalMs !== null

  useEffect(() => {
    // 时钟不可用或动画未激活时，跳过订阅
    if (!clock || !active) return

    // 记录上次更新的时间戳，用于节流（避免每个 tick 都更新状态）
    let lastUpdate = clock.now()

    const onChange = (): void => {
      const now = clock.now()
      // 仅当距上次更新超过 intervalMs 时才触发 React 状态更新
      if (now - lastUpdate >= intervalMs!) {
        lastUpdate = now
        setTime(now)
      }
    }

    // keepAlive: true —— 可见动画驱动时钟持续运转（不会因无订阅者而停止）
    return clock.subscribe(onChange, true)
  }, [clock, intervalMs, active]) // active 或间隔变化时重新订阅

  // 返回 [视口 ref（绑定到元素）, 当前动画时间戳]
  return [viewportRef, time]
}
