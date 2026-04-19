/**
 * bridgeDebug.ts — Bridge 故障注入与调试句柄管理
 *
 * 在 Claude Code 系统流程中的位置：
 *   仅在 USER_TYPE=ant（内部开发人员）时激活，零性能影响于外部构建
 *   CLI REPL（/bridge-kick 斜线命令）
 *     └─> bridgeDebug.ts（本文件）——提供 Bridge 恢复路径的手动测试能力
 *           ├─ BridgeDebugHandle：暴露对 Bridge 内部状态的直接操作句柄
 *           ├─ BridgeFault 队列：记录待注入的一次性故障
 *           └─ wrapApiForFaultInjection：用故障代理包装真实 API 客户端
 *
 * 该文件专为 ant 内部人员手动测试 Bridge 恢复机制而设计：
 *   - 在 REPL 中执行 /bridge-kick <subcommand>（Remote Control 连接状态下）
 *   - 然后通过 tail debug.log 观察恢复机制的反应
 *
 * 目标覆盖的真实故障模式（BQ 2026-03-12，7 天统计窗口）：
 *   - poll 404 not_found_error   — 每周 147K 次，触发 onEnvironmentLost 门控
 *   - ws_closed 1002/1006        — 每周 22K 次，关闭后的僵尸轮询
 *   - register 临时失败           — 残余：doReconnect 期间的网络抖动
 */

import { logForDebugging } from '../utils/debug.js'
import { BridgeFatalError } from './bridgeApi.js'
import type { BridgeApiClient } from './types.js'

/**
 * Ant-only fault injection for manually testing bridge recovery paths.
 *
 * Real failure modes this targets (BQ 2026-03-12, 7-day window):
 *   poll 404 not_found_error   — 147K sessions/week, dead onEnvironmentLost gate
 *   ws_closed 1002/1006        —  22K sessions/week, zombie poll after close
 *   register transient failure —  residual: network blips during doReconnect
 *
 * Usage: /bridge-kick <subcommand> from the REPL while Remote Control is
 * connected, then tail debug.log to watch the recovery machinery react.
 *
 * Module-level state is intentional here: one bridge per REPL process, the
 * /bridge-kick slash command has no other way to reach into initBridgeCore's
 * closures, and teardown clears the slot.
 */

/**
 * 描述一次待注入故障的数据结构。
 *
 * 每次匹配的 API 调用发生前，从队列中消费一个 BridgeFault 并抛出对应错误：
 *   - fatal：抛出 BridgeFatalError，模拟 handleErrorStatus 触发的致命错误（4xx），
 *     Bridge 的 catch 分支会执行 teardown；
 *   - transient：抛出普通 Error，模拟 axios 5xx/网络错误，
 *     Bridge 的 catch 分支会执行 retry/backoff 退避重试。
 *
 * One-shot fault to inject on the next matching api call.
 */
type BridgeFault = {
  /** 要拦截的目标 API 方法名 */
  method:
    | 'pollForWork'
    | 'registerBridgeEnvironment'
    | 'reconnectSession'
    | 'heartbeatWork'
  /** Fatal errors go through handleErrorStatus → BridgeFatalError. Transient
   *  errors surface as plain axios rejections (5xx / network). Recovery code
   *  distinguishes the two: fatal → teardown, transient → retry/backoff.
   *
   *  fatal：致命错误，经 handleErrorStatus → BridgeFatalError，触发 teardown；
   *  transient：临时错误，模拟 axios 网络/5xx 拒绝，触发 retry/backoff。
   */
  kind: 'fatal' | 'transient'
  /** 注入故障时使用的模拟 HTTP 状态码 */
  status: number
  /** 可选的服务端错误类型，如 "environment_expired" */
  errorType?: string
  /** Remaining injections. Decremented on consume; removed at 0.
   *  剩余注入次数。每次消费后递减；减到 0 时从队列中移除。*/
  count: number
}

/**
 * Bridge 调试句柄，由 initBridgeCore 在内部创建并通过
 * registerBridgeDebugHandle 注册，供 /bridge-kick 斜线命令调用。
 *
 * 每个字段都对应一种可手动触发的调试操作。
 */
export type BridgeDebugHandle = {
  /** Invoke the transport's permanent-close handler directly. Tests the
   *  ws_closed → reconnectEnvironmentWithSession escalation (#22148).
   *  直接触发传输层的永久关闭处理器，用于测试 ws_closed → reconnectEnvironmentWithSession 的升级路径。*/
  fireClose: (code: number) => void
  /** Call reconnectEnvironmentWithSession() — same as SIGUSR2 but
   *  reachable from the slash command.
   *  调用 reconnectEnvironmentWithSession()，效果等同于 SIGUSR2 信号，但可从斜线命令触发。*/
  forceReconnect: () => void
  /** Queue a fault for the next N calls to the named api method.
   *  向故障队列中添加一个故障，将在接下来 N 次匹配的 API 调用中触发。*/
  injectFault: (fault: BridgeFault) => void
  /** Abort the at-capacity sleep so an injected poll fault lands
   *  immediately instead of up to 10min later.
   *  中止"满载等待"睡眠，使注入的轮询故障能立即触发，而不是等待长达 10 分钟。*/
  wakePollLoop: () => void
  /** env/session IDs for the debug.log grep.
   *  返回当前环境/会话 ID 的描述字符串，用于 debug.log 的 grep 过滤。*/
  describe: () => string
}

/** 模块级调试句柄，一个 REPL 进程对应一个 Bridge，teardown 时清空。 */
let debugHandle: BridgeDebugHandle | null = null
/** 待注入的故障队列，按注入顺序先进先出。 */
const faultQueue: BridgeFault[] = []

/**
 * 注册 Bridge 调试句柄。
 *
 * 由 initBridgeCore 在 Bridge 初始化后调用，
 * 将内部操作句柄暴露给 /bridge-kick 斜线命令。
 * 一个进程同时只有一个活跃的 Bridge，因此直接覆盖模块级变量。
 */
export function registerBridgeDebugHandle(h: BridgeDebugHandle): void {
  debugHandle = h
}

/**
 * 清除 Bridge 调试句柄并清空故障队列。
 *
 * 在 Bridge teardown（正常关闭或致命错误后）时调用，
 * 确保不会有过期的句柄或残留故障影响后续会话。
 */
export function clearBridgeDebugHandle(): void {
  debugHandle = null
  faultQueue.length = 0 // 就地清空数组，保留引用
}

/**
 * 获取当前注册的 Bridge 调试句柄。
 *
 * 若 Bridge 尚未初始化或已关闭，返回 null。
 * /bridge-kick 斜线命令通过此函数获取句柄后执行调试操作。
 */
export function getBridgeDebugHandle(): BridgeDebugHandle | null {
  return debugHandle
}

/**
 * 向故障队列中添加一个待注入的故障。
 *
 * 该故障将在接下来 fault.count 次匹配 fault.method 的 API 调用中被触发。
 * 同时向 debug.log 输出故障入队日志，便于追踪。
 */
export function injectBridgeFault(fault: BridgeFault): void {
  faultQueue.push(fault) // 将故障追加到队列末尾
  logForDebugging(
    `[bridge:debug] Queued fault: ${fault.method} ${fault.kind}/${fault.status}${fault.errorType ? `/${fault.errorType}` : ''} ×${fault.count}`,
  )
}

/**
 * 用故障注入代理包装真实的 BridgeApiClient。
 *
 * 每次调用被代理的 API 方法时，先从 faultQueue 中查找匹配的故障：
 *   - 若找到故障：消费一次（count 递减，count=0 时移出队列），抛出对应错误；
 *   - 若无故障：透传到真实 API 客户端。
 *
 * 目前仅代理以下四个方法（其他方法直接透传 `...api`）：
 *   pollForWork / registerBridgeEnvironment / reconnectSession / heartbeatWork
 *
 * 注意：仅在 USER_TYPE=ant 时调用，外部构建零开销。
 *
 * Only called when USER_TYPE === 'ant' — zero overhead in external builds.
 */
export function wrapApiForFaultInjection(
  api: BridgeApiClient,
): BridgeApiClient {
  /**
   * 从故障队列中消费第一个匹配指定方法名的故障。
   *
   * 找到后将 count 递减；减到 0 时从队列中移除。
   * 若无匹配故障，返回 null（透传到真实 API）。
   */
  function consume(method: BridgeFault['method']): BridgeFault | null {
    const idx = faultQueue.findIndex(f => f.method === method) // 按方法名查找
    if (idx === -1) return null // 无匹配故障
    const fault = faultQueue[idx]!
    fault.count-- // 消费一次，递减剩余次数
    if (fault.count <= 0) faultQueue.splice(idx, 1) // 次数耗尽，移出队列
    return fault
  }

  /**
   * 根据故障类型抛出对应的错误，永不返回（返回类型为 never）。
   *
   * fatal 故障 → BridgeFatalError（模拟 4xx，触发 teardown）
   * transient 故障 → Error（模拟 5xx/网络错误，触发 retry/backoff）
   *
   * 注意：transient 故障的 Error 对象上没有 .status 属性，
   * Bridge 的 catch 块正是通过这一点来区分致命与临时错误。
   */
  function throwFault(fault: BridgeFault, context: string): never {
    logForDebugging(
      `[bridge:debug] Injecting ${fault.kind} fault into ${context}: status=${fault.status} errorType=${fault.errorType ?? 'none'}`,
    )
    if (fault.kind === 'fatal') {
      // 致命错误：模拟 BridgeFatalError，触发 Bridge teardown 路径
      throw new BridgeFatalError(
        `[injected] ${context} ${fault.status}`,
        fault.status,
        fault.errorType,
      )
    }
    // Transient: mimic an axios rejection (5xx / network). No .status on
    // the error itself — that's how the catch blocks distinguish.
    // 临时错误：模拟 axios 网络/5xx 拒绝，不带 .status 属性，触发 retry/backoff 路径
    throw new Error(`[injected transient] ${context} ${fault.status}`)
  }

  // 展开真实 API 的所有方法，再用代理覆盖需要故障注入的四个方法
  return {
    ...api, // 其他方法（acknowledgeWork、stopWork 等）直接透传真实实现
    async pollForWork(envId, secret, signal, reclaimMs) {
      const f = consume('pollForWork') // 检查并消费 pollForWork 故障
      if (f) throwFault(f, 'Poll')    // 有故障则抛出，不调用真实 API
      return api.pollForWork(envId, secret, signal, reclaimMs)
    },
    async registerBridgeEnvironment(config) {
      const f = consume('registerBridgeEnvironment')
      if (f) throwFault(f, 'Registration')
      return api.registerBridgeEnvironment(config)
    },
    async reconnectSession(envId, sessionId) {
      const f = consume('reconnectSession')
      if (f) throwFault(f, 'ReconnectSession')
      return api.reconnectSession(envId, sessionId)
    },
    async heartbeatWork(envId, workId, token) {
      const f = consume('heartbeatWork')
      if (f) throwFault(f, 'Heartbeat')
      return api.heartbeatWork(envId, workId, token)
    },
  }
}
