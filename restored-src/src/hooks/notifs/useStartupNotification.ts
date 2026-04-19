/**
 * useStartupNotification.ts
 *
 * 【在 Claude Code 系统中的位置】
 * 本文件属于 hooks/notifs 层，是启动通知系统的基础抽象工具。
 * notifs/ 目录下的多个 hook 原本各自重复实现"远程模式门控 + 只触发一次"的逻辑，
 * 本文件将这些公共模式提取为可复用的 useStartupNotification hook。
 *
 * 【主要功能】
 * - 提供统一的"挂载时触发一次通知"模式；
 * - 内置远程模式（remote mode）门控：远程模式下不触发；
 * - 内置 once-per-session ref 守卫：防止同一会话内重复触发；
 * - 支持同步或异步的 compute 函数；
 * - 支持返回单条或多条通知；
 * - 异常统一路由到 logError 而不是抛出。
 */

import { useEffect, useRef } from 'react'
import { getIsRemoteMode } from '../../bootstrap/state.js'
import {
  type Notification,
  useNotifications,
} from '../../context/notifications.js'
import { logError } from '../../utils/log.js'

/** compute 函数的返回值类型：单条通知、多条通知数组，或 null（跳过） */
type Result = Notification | Notification[] | null

/**
 * 在组件挂载时触发一次（或多条）通知的通用 hook。
 *
 * 封装了以下 notifs/ 层 10+ 个 hook 中重复出现的公共逻辑：
 * - 远程模式门控（getIsRemoteMode()）；
 * - 会话内只触发一次的 ref 守卫（hasRunRef）；
 * - 同步/异步 compute 函数的统一调用方式；
 * - 错误统一路由到 logError。
 *
 * @param compute 计算通知内容的函数，在第一次 effect 执行时恰好调用一次。
 *                返回 null 则跳过，返回单条 Notification 则触发一条，
 *                返回数组则依次触发。支持同步和异步（返回 Promise）。
 */
export function useStartupNotification(
  compute: () => Result | Promise<Result>,
): void {
  // 从通知上下文获取添加通知的方法
  const { addNotification } = useNotifications()
  // 会话内只触发一次的守卫 ref
  const hasRunRef = useRef(false)
  // 存储最新的 compute 函数引用，避免 effect 依赖数组频繁变化
  const computeRef = useRef(compute)
  // 每次渲染都更新 ref，确保 compute 始终是最新版本
  computeRef.current = compute

  useEffect(() => {
    // 远程模式下跳过（通知由服务端管理），或已触发过则跳过
    if (getIsRemoteMode() || hasRunRef.current) return
    // 标记已运行，防止 StrictMode 双重 effect 或依赖变化导致重复触发
    hasRunRef.current = true

    void Promise.resolve()
      // 调用最新的 compute 函数（支持同步和异步）
      .then(() => computeRef.current())
      .then(result => {
        if (!result) return // null 表示跳过，不触发通知
        // 统一处理单条和数组两种返回形式
        for (const n of Array.isArray(result) ? result : [result]) {
          addNotification(n)
        }
      })
      // 异常统一路由到 logError，不中断渲染
      .catch(logError)
  }, [addNotification]) // addNotification 在上下文中稳定，实际只运行一次
}
