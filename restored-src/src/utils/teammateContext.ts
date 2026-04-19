/**
 * teammateContext.ts — 进程内子智能体（In-Process Teammate）上下文管理
 *
 * 在 Claude Code 多智能体架构中，子智能体（teammate）有三种标识机制：
 *   1. 环境变量（CLAUDE_CODE_AGENT_ID）     → 通过 tmux 独立进程启动的成员
 *   2. dynamicTeamContext（teammate.ts）  → 运行时动态加入的进程级成员
 *   3. TeammateContext（本文件）           → 进程内通过 AsyncLocalStorage 并发运行的成员
 *
 * 本文件使用 Node.js 的 AsyncLocalStorage 为进程内子智能体提供隔离的执行上下文，
 * 使多个子智能体可以并发运行而不发生全局状态冲突。
 *
 * 在 teammate.ts 中，身份解析的优先级：
 *   AsyncLocalStorage（本文件）> dynamicTeamContext > 环境变量
 */

import { AsyncLocalStorage } from 'async_hooks'

/**
 * 进程内子智能体的运行时上下文。
 * 通过 AsyncLocalStorage 在异步调用链中传递，互不干扰。
 */
export type TeammateContext = {
  /** 完整 Agent ID，例如 "researcher@my-team" */
  agentId: string
  /** 显示名称，例如 "researcher" */
  agentName: string
  /** 该成员所属的团队名称 */
  teamName: string
  /** UI 中分配给该成员的颜色 */
  color?: string
  /** 成员是否必须先进入 plan 模式才能实施操作 */
  planModeRequired: boolean
  /** 领队的 session ID（用于 transcript 关联） */
  parentSessionId: string
  /** 类型判别符 — 进程内成员始终为 true */
  isInProcess: true
  /** 生命周期管理的 AbortController（与父级控制器关联） */
  abortController: AbortController
}

// AsyncLocalStorage 实例：每个异步执行链拥有独立的 TeammateContext
const teammateContextStorage = new AsyncLocalStorage<TeammateContext>()

/**
 * 获取当前异步执行链中的进程内子智能体上下文。
 *
 * 若当前代码不在任何进程内子智能体的执行上下文中运行，
 * 则返回 undefined。
 */
export function getTeammateContext(): TeammateContext | undefined {
  return teammateContextStorage.getStore()
}

/**
 * 在指定的子智能体上下文中执行一个函数。
 *
 * 用于启动进程内子智能体时，为其整个异步执行链建立隔离的上下文。
 * AsyncLocalStorage.run() 保证 fn() 的所有后代异步操作都能访问到
 * 同一个 context，而不影响其他并发运行的子智能体。
 *
 * @param context - 要设置的子智能体上下文
 * @param fn      - 需要在该上下文中运行的函数
 * @returns fn 的返回值
 */
export function runWithTeammateContext<T>(
  context: TeammateContext,
  fn: () => T,
): T {
  return teammateContextStorage.run(context, fn)
}

/**
 * 快速判断当前执行是否处于进程内子智能体上下文中。
 *
 * 比 getTeammateContext() !== undefined 性能稍好，适用于只需布尔判断的场景。
 */
export function isInProcessTeammate(): boolean {
  return teammateContextStorage.getStore() !== undefined
}

/**
 * 根据启动配置创建一个 TeammateContext 对象。
 *
 * abortController 由调用方传入。对于进程内子智能体，通常使用独立的
 * AbortController（而非父级的），这样当领队的查询被中断时，子智能体
 * 仍可继续运行直至完成当前任务。
 *
 * @param config - 子智能体的初始化配置
 * @returns 包含 isInProcess: true 的完整 TeammateContext
 */
export function createTeammateContext(config: {
  agentId: string
  agentName: string
  teamName: string
  color?: string
  planModeRequired: boolean
  parentSessionId: string
  abortController: AbortController
}): TeammateContext {
  return {
    ...config,
    // 固定将进程内标志设为 true
    isInProcess: true,
  }
}
