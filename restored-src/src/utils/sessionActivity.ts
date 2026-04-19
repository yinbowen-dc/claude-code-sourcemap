/**
 * 会话活动追踪模块（引用计数心跳保活）
 *
 * 在 Claude Code 系统中的位置：
 * 远程会话传输层 → 容器保活 / 空闲检测 → sessionActivity
 *
 * 主要功能：
 * 通过引用计数（refcount）跟踪当前是否有"活跃工作"（API 调用或工具执行），
 * 在活跃期间每 30 秒触发一次心跳回调（keep-alive），以防止远程容器因空闲而被回收。
 *
 * 架构设计：
 * - 传输层通过 registerSessionActivityCallback() 注册 keep-alive 发送函数
 * - API 流式传输和工具执行等"活跃工作"通过 startSessionActivity() / stopSessionActivity() 括起来
 * - refcount 从 0 → 1 时启动心跳定时器；从 1 → 0 时停止心跳，启动 30s 空闲日志定时器
 * - 实际发送 keep-alive 需要 CLAUDE_CODE_REMOTE_SEND_KEEPALIVES 环境变量为 truthy，
 *   诊断日志则始终输出，用于排查空闲间隙问题
 */

import { registerCleanup } from './cleanupRegistry.js'
import { logForDiagnosticsNoPII } from './diagLogs.js'
import { isEnvTruthy } from './envUtils.js'

// 心跳间隔：30 秒
const SESSION_ACTIVITY_INTERVAL_MS = 30_000

/** 活动原因类型：API 调用或工具执行 */
export type SessionActivityReason = 'api_call' | 'tool_exec'

// 注册的 keep-alive 回调函数（由传输层注册）
let activityCallback: (() => void) | null = null

// 全局引用计数：记录当前有多少"活跃工作"在进行
let refcount = 0

// 按原因分类的活跃计数 Map，用于关机时诊断
const activeReasons = new Map<SessionActivityReason, number>()

// 最早一次活动开始的时间戳，用于关机时诊断活动持续时长
let oldestActivityStartedAt: number | null = null

// 心跳定时器：refcount > 0 时周期性触发 keep-alive
let heartbeatTimer: ReturnType<typeof setInterval> | null = null

// 空闲定时器：refcount 变 0 后 30s 记录"已空闲"日志
let idleTimer: ReturnType<typeof setTimeout> | null = null

// 是否已向 cleanupRegistry 注册了关机钩子
let cleanupRegistered = false

/**
 * 启动心跳定时器
 *
 * 流程：
 * 1. 先清除已有的空闲定时器（二者互斥）
 * 2. 创建 setInterval：每 30 秒输出诊断日志，并在开关变量为 truthy 时调用 activityCallback
 */
function startHeartbeatTimer(): void {
  clearIdleTimer()
  heartbeatTimer = setInterval(() => {
    // 始终输出诊断日志，帮助排查远程会话空闲问题
    logForDiagnosticsNoPII('debug', 'session_keepalive_heartbeat', {
      refcount,
    })
    // 实际发送 keep-alive 受环境变量保护，避免在非远程场景中误发
    if (isEnvTruthy(process.env.CLAUDE_CODE_REMOTE_SEND_KEEPALIVES)) {
      activityCallback?.()
    }
  }, SESSION_ACTIVITY_INTERVAL_MS)
}

/**
 * 启动空闲定时器
 *
 * 在 refcount 降为 0 后，等待 30s 记录"会话已空闲"日志。
 * 若无 activityCallback 注册则不启动（非远程场景无意义）。
 */
function startIdleTimer(): void {
  clearIdleTimer()
  if (activityCallback === null) {
    return
  }
  idleTimer = setTimeout(() => {
    logForDiagnosticsNoPII('info', 'session_idle_30s')
    idleTimer = null
  }, SESSION_ACTIVITY_INTERVAL_MS)
}

/**
 * 清除空闲定时器
 */
function clearIdleTimer(): void {
  if (idleTimer !== null) {
    clearTimeout(idleTimer)
    idleTimer = null
  }
}

/**
 * 注册 keep-alive 回调函数（由传输层调用）
 *
 * 如果注册时已有 refcount > 0（例如在流式传输过程中重新连接），
 * 需要立即启动心跳定时器。
 *
 * @param cb - keep-alive 发送函数
 */
export function registerSessionActivityCallback(cb: () => void): void {
  activityCallback = cb
  // 重连场景：若当前有工作正在进行且定时器尚未启动，立即恢复心跳
  if (refcount > 0 && heartbeatTimer === null) {
    startHeartbeatTimer()
  }
}

/**
 * 注销 keep-alive 回调函数，并停止所有定时器
 */
export function unregisterSessionActivityCallback(): void {
  activityCallback = null
  // 停止心跳定时器
  if (heartbeatTimer !== null) {
    clearInterval(heartbeatTimer)
    heartbeatTimer = null
  }
  clearIdleTimer()
}

/**
 * 立即发送一次活动信号（非周期性）
 *
 * 仅在 CLAUDE_CODE_REMOTE_SEND_KEEPALIVES 为 truthy 时实际发送。
 */
export function sendSessionActivitySignal(): void {
  if (isEnvTruthy(process.env.CLAUDE_CODE_REMOTE_SEND_KEEPALIVES)) {
    activityCallback?.()
  }
}

/**
 * 检查是否已注册活动追踪回调（即当前处于远程会话模式）
 */
export function isSessionActivityTrackingActive(): boolean {
  return activityCallback !== null
}

/**
 * 增加活动引用计数（标记"有工作开始"）
 *
 * 函数流程：
 * 1. refcount 自增，按 reason 更新 activeReasons 计数
 * 2. 若从 0 → 1（第一个活跃工作），记录开始时间戳并启动心跳定时器
 * 3. 首次调用时向 cleanupRegistry 注册关机钩子，用于输出关机时的活动状态诊断
 *
 * @param reason - 活动原因：'api_call'（API 流式传输）或 'tool_exec'（工具执行）
 */
export function startSessionActivity(reason: SessionActivityReason): void {
  refcount++
  // 更新按原因分类的计数
  activeReasons.set(reason, (activeReasons.get(reason) ?? 0) + 1)
  if (refcount === 1) {
    // 记录最早活动开始时间（用于关机时计算活动持续时长）
    oldestActivityStartedAt = Date.now()
    // refcount 0→1 且有回调时，启动心跳定时器
    if (activityCallback !== null && heartbeatTimer === null) {
      startHeartbeatTimer()
    }
  }
  // 仅注册一次关机钩子，避免重复输出日志
  if (!cleanupRegistered) {
    cleanupRegistered = true
    registerCleanup(async () => {
      logForDiagnosticsNoPII('info', 'session_activity_at_shutdown', {
        refcount,
        active: Object.fromEntries(activeReasons),
        // 仅在有工作进行时 oldest_activity_ms 有意义；否则为 null
        oldest_activity_ms:
          refcount > 0 && oldestActivityStartedAt !== null
            ? Date.now() - oldestActivityStartedAt
            : null,
      })
    })
  }
}

/**
 * 减少活动引用计数（标记"有工作结束"）
 *
 * 函数流程：
 * 1. refcount 自减（下限为 0，防止变负）
 * 2. 更新 activeReasons：计数降为 0 时从 Map 中删除该 reason
 * 3. 若 refcount 降为 0，停止心跳定时器并启动 30s 空闲定时器
 *
 * @param reason - 活动原因：与对应的 startSessionActivity 调用匹配
 */
export function stopSessionActivity(reason: SessionActivityReason): void {
  // 防止 refcount 变为负数
  if (refcount > 0) {
    refcount--
  }
  // 更新或删除该 reason 的计数
  const n = (activeReasons.get(reason) ?? 0) - 1
  if (n > 0) activeReasons.set(reason, n)
  else activeReasons.delete(reason)
  // refcount 降为 0：停止心跳，启动空闲检测
  if (refcount === 0 && heartbeatTimer !== null) {
    clearInterval(heartbeatTimer)
    heartbeatTimer = null
    startIdleTimer()
  }
}
