/**
 * useTeammateShutdownNotification.ts
 *
 * 【在系统流程中的位置】
 * 本文件属于 Claude Code 的「通知 / 状态提示」子系统（notifs/）。
 * 在多 Agent（Swarm/Teammate）协作场景下，负责监听 in-process 子 Agent
 * 的生命周期变化，并将「Agent 启动」与「Agent 关闭」事件聚合为用户可读的通知。
 *
 * 核心机制：
 * - 使用两个 Set（seenRunningRef / seenCompletedRef）跟踪已通知过的任务，
 *   确保每个任务的 running/completed 事件只触发一次通知；
 * - 使用 fold() 函数将多条同类通知折叠合并（如 "3 agents spawned"），
 *   避免短时间内大量 Agent 启动时通知栏被刷屏。
 *
 * 通知展示逻辑：
 *   首次：addNotification({ key: 'teammate-spawn', text: '1 agent spawned', ... })
 *   后续：fold() 被调用，text 累加计数 → "2 agents spawned" → "3 agents spawned"...
 */

import { useEffect, useRef } from 'react'
import { getIsRemoteMode } from '../../bootstrap/state.js'
import {
  type Notification,
  useNotifications,
} from '../../context/notifications.js'
import { useAppState } from '../../state/AppState.js'
import { isInProcessTeammateTask } from '../../tasks/InProcessTeammateTask/types.js'

// ─── 工具函数：通知折叠 ───────────────────────────────────────────────────────

/**
 * 从通知文本中解析计数数字。
 * 用于 fold() 函数获取当前已聚合的数量（如 "3 agents spawned" → 3）。
 *
 * @param notif 当前通知对象
 * @returns 解析到的数字，若无法解析则返回 1
 */
function parseCount(notif: Notification): number {
  if (!('text' in notif)) {
    return 1  // 无 text 字段时视为 1 个
  }
  // 匹配以数字开头的文本（如 "3 agents spawned"）
  const match = notif.text.match(/^(\d+)/)
  return match?.[1] ? parseInt(match[1], 10) : 1
}

/**
 * 「Agent 启动」通知的折叠函数。
 * 当新的 spawn 事件到来时，将计数 +1 后重新生成通知对象。
 *
 * @param acc      当前已存在的聚合通知
 * @param _incoming 新到来的通知（此处不使用其内容，只用于触发折叠）
 * @returns 更新了计数的新通知对象
 */
function foldSpawn(acc: Notification, _incoming: Notification): Notification {
  return makeSpawnNotif(parseCount(acc) + 1)
}

/**
 * 创建「Agent 启动」通知对象。
 * count = 1 时显示 "1 agent spawned"，多个时显示 "N agents spawned"。
 *
 * @param count 已启动的 Agent 数量
 */
function makeSpawnNotif(count: number): Notification {
  return {
    key: 'teammate-spawn',
    text: count === 1 ? '1 agent spawned' : `${count} agents spawned`,
    priority: 'low',
    timeoutMs: 5000,   // 5 秒后自动消失
    fold: foldSpawn,   // 注册折叠函数，后续同 key 通知会调用此函数合并
  }
}

/**
 * 「Agent 关闭」通知的折叠函数。
 * 与 foldSpawn 对称：新的 shutdown 事件到来时计数 +1。
 */
function foldShutdown(
  acc: Notification,
  _incoming: Notification,
): Notification {
  return makeShutdownNotif(parseCount(acc) + 1)
}

/**
 * 创建「Agent 关闭」通知对象。
 * count = 1 时显示 "1 agent shut down"，多个时显示 "N agents shut down"。
 *
 * @param count 已关闭的 Agent 数量
 */
function makeShutdownNotif(count: number): Notification {
  return {
    key: 'teammate-shutdown',
    text: count === 1 ? '1 agent shut down' : `${count} agents shut down`,
    priority: 'low',
    timeoutMs: 5000,    // 5 秒后自动消失
    fold: foldShutdown, // 注册折叠函数
  }
}

// ─── 主 Hook ─────────────────────────────────────────────────────────────────

/**
 * 监听 in-process Teammate（子 Agent）的生命周期，批量推送启动/关闭通知。
 *
 * 处理流程：
 * 1. 每当 tasks 状态更新时重新遍历所有任务；
 * 2. 对于 in_process_teammate 类型的任务：
 *    - running 状态且尚未通知过 → 推送 spawn 通知并记录到 seenRunningRef；
 *    - completed 状态且尚未通知过 → 推送 shutdown 通知并记录到 seenCompletedRef；
 * 3. fold() 机制确保同类通知自动聚合，不会刷屏。
 */
export function useTeammateLifecycleNotification(): void {
  // 订阅全局任务列表（tasks 更新时触发重新执行 effect）
  const tasks = useAppState(s => s.tasks)
  const { addNotification } = useNotifications()
  // 已通知过 running 状态的任务 ID 集合（防止重复推送 spawn 通知）
  const seenRunningRef = useRef<Set<string>>(new Set())
  // 已通知过 completed 状态的任务 ID 集合（防止重复推送 shutdown 通知）
  const seenCompletedRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    // Remote 模式下不弹通知
    if (getIsRemoteMode()) return
    // 遍历所有任务，处理 in-process teammate 类型
    for (const [id, task] of Object.entries(tasks)) {
      // 过滤非 in-process teammate 任务
      if (!isInProcessTeammateTask(task)) {
        continue
      }

      // Agent 首次进入 running 状态时推送 spawn 通知
      if (task.status === 'running' && !seenRunningRef.current.has(id)) {
        seenRunningRef.current.add(id)            // 标记已通知
        addNotification(makeSpawnNotif(1))         // 推送（可能被 fold 合并）
      }

      // Agent 首次进入 completed 状态时推送 shutdown 通知
      if (task.status === 'completed' && !seenCompletedRef.current.has(id)) {
        seenCompletedRef.current.add(id)           // 标记已通知
        addNotification(makeShutdownNotif(1))      // 推送（可能被 fold 合并）
      }
    }
  }, [tasks, addNotification])
}
