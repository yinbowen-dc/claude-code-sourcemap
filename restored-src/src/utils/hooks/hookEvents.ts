/**
 * 【Hook 事件广播模块】
 *
 * 本文件在 Claude Code 系统流中的位置：
 *   Hook 执行引擎 → hookEvents（当前文件）→ SDK 消息流 / 日志系统
 *
 * 主要职责：
 * 1. 定义 Hook 执行过程中的三种事件类型：started（已启动）、progress（进行中）、response（已完成）
 * 2. 维护一个全局事件处理器注册表，支持"先发布后订阅"模式（通过 pendingEvents 缓冲队列）
 * 3. 对 SessionStart / Setup 等低噪声生命周期事件始终进行广播；其他事件受 allHookEventsEnabled 开关控制
 * 4. 提供 startHookProgressInterval 定时轮询机制，向外部实时推送 Hook 的增量输出
 *
 * 设计要点：
 * - pendingEvents 最多缓存 100 条，超出后 FIFO 淘汰，防止内存泄漏
 * - ALWAYS_EMITTED_HOOK_EVENTS 列表中的事件绕过 allHookEventsEnabled 门控，向后兼容
 */

import { HOOK_EVENTS } from 'src/entrypoints/sdk/coreTypes.js'

import { logForDebugging } from '../debug.js'

/**
 * 始终广播的 Hook 事件列表，不受 includeHookEvents 选项控制。
 * 这些事件属于低噪声生命周期事件，已列入原始白名单并保持向后兼容。
 */
const ALWAYS_EMITTED_HOOK_EVENTS = ['SessionStart', 'Setup'] as const

// 待处理事件队列的最大长度，防止在没有处理器时无限积压
const MAX_PENDING_EVENTS = 100

/** Hook 启动事件：当 Hook 开始执行时发出 */
export type HookStartedEvent = {
  type: 'started'
  hookId: string
  hookName: string
  hookEvent: string
}

/** Hook 进度事件：Hook 执行过程中周期性推送的增量输出 */
export type HookProgressEvent = {
  type: 'progress'
  hookId: string
  hookName: string
  hookEvent: string
  stdout: string
  stderr: string
  output: string
}

/** Hook 响应事件：Hook 执行完成后发出，包含最终结果与退出码 */
export type HookResponseEvent = {
  type: 'response'
  hookId: string
  hookName: string
  hookEvent: string
  output: string
  stdout: string
  stderr: string
  exitCode?: number
  outcome: 'success' | 'error' | 'cancelled'
}

/** Hook 执行事件的联合类型 */
export type HookExecutionEvent =
  | HookStartedEvent
  | HookProgressEvent
  | HookResponseEvent
/** Hook 事件处理器类型 */
export type HookEventHandler = (event: HookExecutionEvent) => void

// 待处理事件队列：当尚未注册事件处理器时，将事件暂存此处
const pendingEvents: HookExecutionEvent[] = []
// 当前注册的事件处理器（全局单例）
let eventHandler: HookEventHandler | null = null
// 是否启用全量 Hook 事件广播（默认仅广播 ALWAYS_EMITTED_HOOK_EVENTS 中的事件）
let allHookEventsEnabled = false

/**
 * 注册 Hook 事件处理器。
 *
 * 工作流程：
 * 1. 将新处理器设置为全局处理器
 * 2. 若存在待处理事件（在处理器注册之前已发生的事件），立即将它们全部回放给新处理器
 * 3. 传入 null 可取消注册，后续事件重新进入待处理队列
 *
 * @param handler 事件处理器函数，或 null 表示取消注册
 */
export function registerHookEventHandler(
  handler: HookEventHandler | null,
): void {
  eventHandler = handler
  // 若新处理器有效且缓冲队列中存在积压事件，立即回放（splice 清空数组并返回所有元素）
  if (handler && pendingEvents.length > 0) {
    for (const event of pendingEvents.splice(0)) {
      handler(event)
    }
  }
}

/**
 * 内部事件分发函数。
 *
 * - 若处理器已注册，直接调用
 * - 若未注册，将事件推入待处理队列；队列超出上限时淘汰最旧事件（FIFO）
 */
function emit(event: HookExecutionEvent): void {
  if (eventHandler) {
    // 处理器已就绪，直接分发
    eventHandler(event)
  } else {
    // 暂存至待处理队列
    pendingEvents.push(event)
    // 队列溢出时移除最旧的事件，避免内存无限增长
    if (pendingEvents.length > MAX_PENDING_EVENTS) {
      pendingEvents.shift()
    }
  }
}

/**
 * 判断指定 hookEvent 是否应该广播。
 *
 * 规则：
 * 1. 若事件在 ALWAYS_EMITTED_HOOK_EVENTS 列表中，无条件广播
 * 2. 否则，需要 allHookEventsEnabled 为 true，且事件在 HOOK_EVENTS 枚举中
 */
function shouldEmit(hookEvent: string): boolean {
  // 始终广播的事件（SessionStart、Setup）直接放行
  if ((ALWAYS_EMITTED_HOOK_EVENTS as readonly string[]).includes(hookEvent)) {
    return true
  }
  // 其他事件受全量开关控制
  return (
    allHookEventsEnabled &&
    (HOOK_EVENTS as readonly string[]).includes(hookEvent)
  )
}

/**
 * 发出 Hook 启动事件（type: 'started'）。
 * 在 Hook 开始执行前调用，通知外部监听方 Hook 已进入执行状态。
 *
 * @param hookId   Hook 的唯一标识符
 * @param hookName Hook 的名称（用于展示）
 * @param hookEvent 触发该 Hook 的事件名称
 */
export function emitHookStarted(
  hookId: string,
  hookName: string,
  hookEvent: string,
): void {
  // 不满足广播条件时提前返回，避免无效分发
  if (!shouldEmit(hookEvent)) return

  emit({
    type: 'started',
    hookId,
    hookName,
    hookEvent,
  })
}

/**
 * 发出 Hook 进度事件（type: 'progress'）。
 * 在 Hook 运行期间周期性调用，实时推送增量标准输出/错误输出。
 *
 * @param data 包含 hookId、hookName、hookEvent、stdout、stderr、output 的进度数据
 */
export function emitHookProgress(data: {
  hookId: string
  hookName: string
  hookEvent: string
  stdout: string
  stderr: string
  output: string
}): void {
  // 不满足广播条件时提前返回
  if (!shouldEmit(data.hookEvent)) return

  emit({
    type: 'progress',
    ...data,
  })
}

/**
 * 启动 Hook 进度轮询定时器。
 * 按指定间隔（默认 1000ms）调用 getOutput 获取最新输出，仅在输出发生变化时才发出进度事件（去重）。
 * 定时器通过 interval.unref() 设置为非阻塞，不会阻止进程退出。
 *
 * @param params.hookId      Hook 唯一标识符
 * @param params.hookName    Hook 名称
 * @param params.hookEvent   触发 Hook 的事件名称
 * @param params.getOutput   异步函数，返回当前 stdout / stderr / output
 * @param params.intervalMs  轮询间隔（毫秒），默认 1000
 * @returns 停止定时器的清理函数
 */
export function startHookProgressInterval(params: {
  hookId: string
  hookName: string
  hookEvent: string
  getOutput: () => Promise<{ stdout: string; stderr: string; output: string }>
  intervalMs?: number
}): () => void {
  // 不满足广播条件时返回空清理函数，节省资源
  if (!shouldEmit(params.hookEvent)) return () => {}

  // 记录上次已广播的输出，用于去重（相同输出不重复发出）
  let lastEmittedOutput = ''
  const interval = setInterval(() => {
    void params.getOutput().then(({ stdout, stderr, output }) => {
      // 输出未变化时跳过，避免重复事件
      if (output === lastEmittedOutput) return
      lastEmittedOutput = output
      emitHookProgress({
        hookId: params.hookId,
        hookName: params.hookName,
        hookEvent: params.hookEvent,
        stdout,
        stderr,
        output,
      })
    })
  }, params.intervalMs ?? 1000)
  // 非阻塞定时器：不会阻止 Node.js 事件循环退出
  interval.unref()

  // 返回清理函数，调用后停止轮询
  return () => clearInterval(interval)
}

/**
 * 发出 Hook 响应事件（type: 'response'）。
 * 在 Hook 执行完成（成功、失败或取消）后调用，包含最终输出和退出码。
 * 同时将完整输出写入 debug 日志，供 verbose 模式调试使用。
 *
 * @param data 包含 hookId、hookName、hookEvent、output、stdout、stderr、exitCode、outcome 的响应数据
 */
export function emitHookResponse(data: {
  hookId: string
  hookName: string
  hookEvent: string
  output: string
  stdout: string
  stderr: string
  exitCode?: number
  outcome: 'success' | 'error' | 'cancelled'
}): void {
  // 无论是否广播，始终将 Hook 完整输出写入 debug 日志（供 verbose 模式使用）
  const outputToLog = data.stdout || data.stderr || data.output
  if (outputToLog) {
    logForDebugging(
      `Hook ${data.hookName} (${data.hookEvent}) ${data.outcome}:\n${outputToLog}`,
    )
  }

  // 不满足广播条件时提前返回
  if (!shouldEmit(data.hookEvent)) return

  emit({
    type: 'response',
    ...data,
  })
}

/**
 * 启用或禁用全量 Hook 事件广播。
 * 当 SDK 的 includeHookEvents 选项为 true，或在 CLAUDE_CODE_REMOTE 模式下运行时调用。
 * 启用后，ALWAYS_EMITTED_HOOK_EVENTS 以外的其他 Hook 事件也会被广播。
 *
 * @param enabled true 表示启用全量广播，false 表示仅广播默认事件
 */
export function setAllHookEventsEnabled(enabled: boolean): void {
  allHookEventsEnabled = enabled
}

/**
 * 清除所有 Hook 事件状态（主要用于测试隔离）。
 * 重置事件处理器、待处理队列和全量广播开关至初始状态。
 */
export function clearHookEventState(): void {
  eventHandler = null           // 清除事件处理器
  pendingEvents.length = 0      // 清空待处理队列
  allHookEventsEnabled = false  // 关闭全量广播
}
