/**
 * useAwaySummary.ts
 *
 * 【在系统流程中的位置】
 * 本文件属于 Claude Code 的「离开摘要」功能，在终端失去焦点超过 5 分钟后，
 * 自动生成并插入一条"你离开期间发生了什么"的摘要消息。
 *
 * 核心设计：
 * - Feature 双重门控：编译期 feature('AWAY_SUMMARY') + GrowthBook 实验 tengu_sedge_lantern；
 * - 通过 subscribeTerminalFocus 监听终端焦点状态变化；
 * - 终端 blur 后启动 BLUR_DELAY_MS（5分钟）计时器；
 * - 如果计时器触发时正在进行 AI 对话（isLoading=true），延迟到对话结束后再生成；
 * - 终端重新获得焦点时，清除计时器并中止正在进行的摘要生成；
 * - 使用 pendingRef 标记"计时器已触发但因对话未结束而等待"的状态；
 * - generateRef 存储当前的 generate 函数引用，供 isLoading 变化时的 effect 调用。
 */

import { feature } from 'bun:bundle'
import { useEffect, useRef } from 'react'
import {
  getTerminalFocusState,
  subscribeTerminalFocus,
} from '../ink/terminal-focus-state.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js'
import { generateAwaySummary } from '../services/awaySummary.js'
import type { Message } from '../types/message.js'
import { createAwaySummaryMessage } from '../utils/messages.js'

/** 终端失焦后触发摘要生成的延迟时间：5 分钟 */
const BLUR_DELAY_MS = 5 * 60_000

/** setMessages 函数类型（函数式更新形式） */
type SetMessages = (updater: (prev: Message[]) => Message[]) => void

/**
 * 检测自最后一条用户消息以来是否已存在 away_summary。
 * 从消息列表末尾向前遍历：遇到非 meta 用户消息则返回 false（无摘要），
 * 遇到 away_summary 系统消息则返回 true（已有摘要）。
 *
 * @param messages 当前消息列表
 */
function hasSummarySinceLastUserTurn(messages: readonly Message[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (m.type === 'user' && !m.isMeta && !m.isCompactSummary) return false
    if (m.type === 'system' && m.subtype === 'away_summary') return true
  }
  return false
}

/**
 * 离开摘要 hook。
 *
 * 当终端失焦超过 5 分钟且满足条件时，生成并追加 away_summary 消息。
 * 触发条件：(a) 失焦满 5 分钟，(b) 无正在进行的对话轮次，
 * (c) 最后一条用户消息后尚无 away_summary。
 *
 * Appends a "while you were away" summary message after the terminal has been
 * blurred for 5 minutes. Fires only when (a) 5min since blur, (b) no turn in
 * progress, and (c) no existing away_summary since the last user message.
 *
 * Focus state 'unknown' (terminal doesn't support DECSET 1004) is a no-op.
 */
export function useAwaySummary(
  messages: readonly Message[],
  setMessages: SetMessages,
  isLoading: boolean,
): void {
  // 使用 ref 跟踪计时器、abort controller、最新消息/加载状态，避免 effect 过期引用
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const messagesRef = useRef(messages)
  const isLoadingRef = useRef(isLoading)
  // pendingRef=true 表示计时器已触发，但因 isLoading=true 而推迟执行
  const pendingRef = useRef(false)
  // generateRef 存储当前生效的 generate 函数，供 isLoading 变化时的 effect 调用
  const generateRef = useRef<(() => Promise<void>) | null>(null)

  // 每次渲染同步最新引用（不触发 re-render）
  messagesRef.current = messages
  isLoadingRef.current = isLoading

  // 3P default: false
  // 通过 GrowthBook 实验门控（3P 用户默认关闭）
  const gbEnabled = getFeatureValue_CACHED_MAY_BE_STALE(
    'tengu_sedge_lantern',
    false,
  )

  // 主 effect：订阅终端焦点变化，管理计时器和摘要生成
  useEffect(() => {
    // 编译期 feature flag 检查（bun:bundle feature，不满足则直接跳过）
    if (!feature('AWAY_SUMMARY')) return
    // GrowthBook 实验门控
    if (!gbEnabled) return

    /** 清除正在运行的计时器 */
    function clearTimer(): void {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }

    /** 中止正在进行的摘要生成请求 */
    function abortInFlight(): void {
      abortRef.current?.abort()
      abortRef.current = null
    }

    /**
     * 实际生成摘要的核心函数。
     * 1. 重置 pendingRef；
     * 2. 检查是否已有摘要（防重复）；
     * 3. 中止旧的请求，创建新的 AbortController；
     * 4. 调用 generateAwaySummary 获取摘要文本；
     * 5. 若未被中止且成功获取，追加到消息列表。
     */
    async function generate(): Promise<void> {
      pendingRef.current = false
      // 若已有摘要，跳过（防重复插入）
      if (hasSummarySinceLastUserTurn(messagesRef.current)) return
      abortInFlight()
      const controller = new AbortController()
      abortRef.current = controller
      const text = await generateAwaySummary(
        messagesRef.current,
        controller.signal,
      )
      // 若已被中止或生成失败，不插入消息
      if (controller.signal.aborted || text === null) return
      setMessages(prev => [...prev, createAwaySummaryMessage(text)])
    }

    /**
     * 计时器到期回调：5 分钟失焦后触发。
     * - 若正在加载，设置 pendingRef=true，待 isLoading 变为 false 时再生成；
     * - 否则立即生成摘要。
     */
    function onBlurTimerFire(): void {
      timerRef.current = null
      if (isLoadingRef.current) {
        // 对话进行中，先标记 pending，等 isLoading 变 false 时再生成
        pendingRef.current = true
        return
      }
      void generate()
    }

    /**
     * 终端焦点变化回调。
     * - blurred：清除旧计时器，启动新的 5 分钟计时器；
     * - focused：清除计时器，中止进行中的生成，重置 pendingRef；
     * - 'unknown'（不支持 DECSET 1004）：无操作。
     */
    function onFocusChange(): void {
      const state = getTerminalFocusState()
      if (state === 'blurred') {
        clearTimer()
        timerRef.current = setTimeout(onBlurTimerFire, BLUR_DELAY_MS)
      } else if (state === 'focused') {
        clearTimer()
        abortInFlight()
        pendingRef.current = false
      }
      // 'unknown' → no-op
    }

    // 订阅终端焦点变化
    const unsubscribe = subscribeTerminalFocus(onFocusChange)
    // Handle the case where we're already blurred when the effect mounts
    onFocusChange()
    // 将 generate 函数引用存到 generateRef，供第二个 effect 使用
    generateRef.current = generate

    // 清理：取消订阅、清除计时器、中止请求、清空引用
    return () => {
      unsubscribe()
      clearTimer()
      abortInFlight()
      generateRef.current = null
    }
  }, [gbEnabled, setMessages])

  // Timer fired mid-turn → fire when turn ends (if still blurred)
  // 第二个 effect：当 isLoading 从 true 变 false 时，检查是否有 pending 的摘要生成
  useEffect(() => {
    if (isLoading) return                                    // 还在加载中，不触发
    if (!pendingRef.current) return                         // 没有等待中的摘要生成
    if (getTerminalFocusState() !== 'blurred') return       // 已重新聚焦，不需要摘要
    void generateRef.current?.()                           // 触发延迟的摘要生成
  }, [isLoading])
}
