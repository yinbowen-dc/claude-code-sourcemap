/**
 * useDeferredHookMessages.ts
 *
 * 【在 Claude Code 系统中的位置】
 * 位于 UI 层的 hooks 目录下，属于 REPL 启动优化模块。
 * 在 Claude Code 的 REPL 组件初始化阶段使用，
 * 负责处理 SessionStart 生命周期钩子（Hook）产生的消息，
 * 使 UI 可以立即渲染而无需等待钩子执行完成（约 500ms 的阻塞被消除）。
 *
 * 【主要功能】
 * - 接收一个 Promise<HookResultMessage[]>，代表异步执行中的 SessionStart Hook 结果
 * - 在 Promise 解析后，将 Hook 消息注入到消息列表头部（prepend）
 * - 返回一个回调函数供 onSubmit 调用，确保在第一次 API 请求前 Hook 消息已注入
 * - 使用 ref 追踪解析状态，防止重复注入
 */

import { useCallback, useEffect, useRef } from 'react'
import type { HookResultMessage, Message } from '../types/message.js'

/**
 * Manages deferred SessionStart hook messages so the REPL can render
 * immediately instead of blocking on hook execution (~500ms).
 *
 * Hook messages are injected asynchronously when the promise resolves.
 * Returns a callback that onSubmit should call before the first API
 * request to ensure the model always sees hook context.
 *
 * 【功能说明】
 * 将 SessionStart Hook 消息的注入推迟到 Promise 解析后异步执行，
 * 避免 REPL 首次渲染被阻塞。
 *
 * 整体流程：
 * 1. useEffect 在挂载后监听 pendingHookMessages Promise
 * 2. Promise 解析后，将 Hook 消息前置插入 messages 列表
 * 3. 返回的回调（ensureHookMessages）供 onSubmit 在发起 API 请求前调用，
 *    若 Promise 尚未解析则主动等待，确保模型始终能看到完整的 Hook 上下文
 *
 * @param pendingHookMessages - 异步执行中的 SessionStart Hook 消息 Promise（可选）
 * @param setMessages - React 状态更新函数，用于将消息注入消息列表
 * @returns 一个异步回调，在发起 API 请求前调用以确保 Hook 消息已注入
 */
export function useDeferredHookMessages(
  pendingHookMessages: Promise<HookResultMessage[]> | undefined,
  setMessages: (action: React.SetStateAction<Message[]>) => void,
): () => Promise<void> {
  // 持有待解析的 Promise 引用；若无 pendingHookMessages 则初始化为 null
  const pendingRef = useRef(pendingHookMessages ?? null)
  // 标记 Hook 消息是否已解析完成；若无 pending Promise 则初始为 true（无需等待）
  const resolvedRef = useRef(!pendingHookMessages)

  useEffect(() => {
    // 获取当前待解析的 Promise
    const promise = pendingRef.current
    // 若无待处理的 Promise，直接返回
    if (!promise) return
    // 用于在组件卸载时取消回调执行，防止在卸载后调用 setState
    let cancelled = false
    promise.then(msgs => {
      // 若组件已卸载，则跳过状态更新
      if (cancelled) return
      // 标记 Hook 消息已解析完成
      resolvedRef.current = true
      // 清空 pendingRef，表示无待处理 Promise
      pendingRef.current = null
      // 若有实际消息内容，则将其前置插入到现有消息列表
      if (msgs.length > 0) {
        setMessages(prev => [...msgs, ...prev])
      }
    })
    // 清理函数：组件卸载时设置 cancelled 标志，防止异步回调访问已卸载组件的状态
    return () => {
      cancelled = true
    }
  }, [setMessages])

  // 返回 onSubmit 调用的确保函数：在发起 API 请求前同步等待 Hook 消息解析
  return useCallback(async () => {
    // 若已解析或无待处理 Promise，直接返回
    if (resolvedRef.current || !pendingRef.current) return
    // 主动等待 Promise 解析（阻塞 onSubmit 直到 Hook 消息可用）
    const msgs = await pendingRef.current
    // 双重检查：等待期间可能 useEffect 已完成解析，避免重复注入
    if (resolvedRef.current) return
    // 标记为已解析
    resolvedRef.current = true
    pendingRef.current = null
    // 将 Hook 消息前置插入消息列表
    if (msgs.length > 0) {
      setMessages(prev => [...msgs, ...prev])
    }
  }, [setMessages])
}
