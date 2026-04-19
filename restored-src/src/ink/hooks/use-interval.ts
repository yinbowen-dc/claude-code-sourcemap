/**
 * @file hooks/use-interval.ts
 * @description 基于共享时钟的定时器 Hook，提供时间戳读取和周期性回调两种形式。
 *
 * 在 Claude Code 的 Ink 渲染流水线中，本文件属于「时钟订阅」层：
 *   ClockContext（共享时钟，单一 setInterval 驱动） → useAnimationTimer / useInterval（本文件）
 *                                                              ↓
 *                                                      组件状态更新 / 周期性副作用
 *
 * 主要职责：
 *  - useAnimationTimer：以非 keepAlive 方式订阅共享时钟，返回周期性更新的时间戳，
 *    适合驱动纯时间相关的计算（如 shimmer 位置、帧索引）。
 *  - useInterval        ：以非 keepAlive 方式订阅共享时钟，周期性调用回调函数，
 *    是 usehooks-ts/useInterval（基于 setInterval）的替代，所有定时器共用一个唤醒源。
 *
 * 与 useAnimationFrame 的区别：
 *  - useAnimationFrame 使用 keepAlive=true（可见动画驱动时钟持续运转）。
 *  - 本文件的两个 Hook 使用 keepAlive=false（仅在时钟已由其他订阅者驱动时才更新）。
 */

import { useContext, useEffect, useRef, useState } from 'react'
import { ClockContext } from '../components/ClockContext.js'

/**
 * 以固定间隔返回共享时钟的时间戳，触发组件重渲染。
 *
 * 以 keepAlive=false 订阅：不会主动保持时钟运转，
 * 但只要有其他 keepAlive 订阅者（如 Spinner），就会跟随更新。
 * 适用于驱动纯时间相关的视觉效果（shimmer 偏移、动画帧序号等）。
 *
 * @param intervalMs 最小更新间隔（毫秒）
 * @returns 当前时间戳（毫秒），每隔 intervalMs 更新一次
 */
export function useAnimationTimer(intervalMs: number): number {
  // 从上下文获取共享时钟实例
  const clock = useContext(ClockContext)
  // 初始时间从时钟读取（时钟不可用时为 0）
  const [time, setTime] = useState(() => clock?.now() ?? 0)

  useEffect(() => {
    // 时钟不可用（如测试环境未提供 ClockContext）时跳过
    if (!clock) return

    // 记录上次触发更新的时间，用于节流
    let lastUpdate = clock.now()

    const onChange = (): void => {
      const now = clock.now()
      // 距上次更新超过 intervalMs 才触发 setTime，避免过于频繁的状态更新
      if (now - lastUpdate >= intervalMs) {
        lastUpdate = now
        setTime(now)
      }
    }

    // keepAlive=false：此订阅者不主动驱动时钟，不影响时钟的启停决策
    return clock.subscribe(onChange, false)
  }, [clock, intervalMs])

  return time
}

/**
 * 以固定间隔调用回调函数的 Hook，基于共享时钟实现（替代独立的 setInterval）。
 *
 * 与 usehooks-ts 的 useInterval 相比：
 *  - 所有 useInterval 实例共用一个底层 setInterval（通过 ClockContext），
 *    减少系统定时器数量，避免定时器漂移。
 *  - 传入 null 即可暂停，无需额外的 isActive 状态。
 *
 * @param callback   周期性执行的回调函数（通过 ref 跟踪最新版本，无需在 deps 中声明）
 * @param intervalMs 调用间隔（毫秒），传 null 则暂停
 */
export function useInterval(
  callback: () => void,
  intervalMs: number | null,
): void {
  // 用 ref 持有最新的 callback，避免将其放入 effect deps 导致频繁重订阅
  const callbackRef = useRef(callback)
  // 每次渲染同步更新 ref，保证 onChange 始终调用最新的 callback
  callbackRef.current = callback

  // 从上下文获取共享时钟实例
  const clock = useContext(ClockContext)

  useEffect(() => {
    // 时钟不可用或 intervalMs 为 null（暂停）时，不订阅
    if (!clock || intervalMs === null) return

    // 记录上次回调触发时间，用于节流
    let lastUpdate = clock.now()

    const onChange = (): void => {
      const now = clock.now()
      // 距上次触发超过 intervalMs 时调用回调
      if (now - lastUpdate >= intervalMs) {
        lastUpdate = now
        // 通过 ref 调用最新的 callback，避免闭包过时
        callbackRef.current()
      }
    }

    // keepAlive=false：此 Hook 不驱动时钟，仅搭便车
    return clock.subscribe(onChange, false)
  }, [clock, intervalMs])
}
