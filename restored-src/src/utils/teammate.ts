/**
 * teammate.ts — 多智能体协作身份识别与状态管理
 *
 * 在 Claude Code 的 Agent Swarm（智能体群）架构中，本文件是所有身份识别
 * 和协作控制逻辑的入口，负责：
 *   1. 重导出进程内子智能体（in-process teammate）的工具函数（来自 teammateContext.ts）
 *   2. 管理 dynamicTeamContext 模块级状态（tmux 独立进程子智能体）
 *   3. 提供统一的身份解析函数（agentId、agentName、teamName 等）
 *   4. 提供团队协作控制函数（isTeammate、isTeamLead、isPlanModeRequired 等）
 *   5. 管理进程内子智能体的生命周期等待逻辑
 *
 * 身份解析优先级（从高到低）：
 *   1. AsyncLocalStorage（进程内子智能体，来自 teammateContext.ts）
 *   2. dynamicTeamContext（tmux 子智能体通过 CLI 参数设置）
 *   3. 环境变量（CLAUDE_CODE_AGENT_ID 等，供向后兼容）
 */

// 重导出进程内子智能体工具函数，调用方可统一从本模块导入
export {
  createTeammateContext,
  getTeammateContext,
  isInProcessTeammate,
  runWithTeammateContext,
  type TeammateContext,
} from './teammateContext.js'

import type { AppState } from '../state/AppState.js'
import { isEnvTruthy } from './envUtils.js'
import { getTeammateContext } from './teammateContext.js'

/**
 * 获取当前子智能体的父会话 ID（即领队的 session ID）。
 *
 * 父会话 ID 用于 transcript 关联和调试追踪。
 * 优先级：AsyncLocalStorage（进程内）> dynamicTeamContext（tmux）
 */
export function getParentSessionId(): string | undefined {
  const inProcessCtx = getTeammateContext()
  if (inProcessCtx) return inProcessCtx.parentSessionId
  return dynamicTeamContext?.parentSessionId
}

/**
 * 运行时动态团队上下文（用于 tmux 独立进程子智能体）。
 *
 * 当子智能体通过 CLI 参数（--agent-id、--team-name 等）加入团队时，
 * 这些参数被解析后存储在此变量中。
 * 与环境变量不同，dynamicTeamContext 支持运行时动态加入团队。
 */
let dynamicTeamContext: {
  agentId: string
  agentName: string
  teamName: string
  color?: string
  planModeRequired: boolean
  parentSessionId?: string
} | null = null

/**
 * 设置动态团队上下文（在运行时加入团队时调用）。
 *
 * 由团队加入逻辑调用，传入从 CLI 参数解析的团队信息。
 * 设置后，getAgentId()、getTeamName() 等函数将返回此上下文中的值。
 *
 * @param context - 团队上下文对象，或 null（表示离开团队）
 */
export function setDynamicTeamContext(
  context: {
    agentId: string
    agentName: string
    teamName: string
    color?: string
    planModeRequired: boolean
    parentSessionId?: string
  } | null,
): void {
  dynamicTeamContext = context
}

/**
 * 清除动态团队上下文（离开团队时调用）。
 * 等同于 setDynamicTeamContext(null)。
 */
export function clearDynamicTeamContext(): void {
  dynamicTeamContext = null
}

/**
 * 获取当前动态团队上下文（用于检查或调试）。
 */
export function getDynamicTeamContext(): typeof dynamicTeamContext {
  return dynamicTeamContext
}

/**
 * 获取当前会话的 Agent ID。
 *
 * 若当前会话不是子智能体（独立会话），则返回 undefined。
 * 优先级：AsyncLocalStorage（进程内）> dynamicTeamContext（tmux）
 */
export function getAgentId(): string | undefined {
  const inProcessCtx = getTeammateContext()
  if (inProcessCtx) return inProcessCtx.agentId
  return dynamicTeamContext?.agentId
}

/**
 * 获取当前子智能体的显示名称。
 *
 * 优先级：AsyncLocalStorage（进程内）> dynamicTeamContext（tmux）
 */
export function getAgentName(): string | undefined {
  const inProcessCtx = getTeammateContext()
  if (inProcessCtx) return inProcessCtx.agentName
  return dynamicTeamContext?.agentName
}

/**
 * 获取当前会话所属的团队名称。
 *
 * 三级优先级，额外支持从 AppState 传入领队的 teamContext：
 *   1. AsyncLocalStorage（进程内子智能体）
 *   2. dynamicTeamContext（tmux 子智能体）
 *   3. teamContext 参数（支持没有 dynamicTeamContext 的领队）
 *
 * @param teamContext - 可选的来自 AppState 的团队上下文（供领队使用）
 */
export function getTeamName(teamContext?: {
  teamName: string
}): string | undefined {
  const inProcessCtx = getTeammateContext()
  if (inProcessCtx) return inProcessCtx.teamName
  if (dynamicTeamContext?.teamName) return dynamicTeamContext.teamName
  return teamContext?.teamName
}

/**
 * 判断当前会话是否作为子智能体运行（而非独立会话）。
 *
 * 进程内子智能体：只要 AsyncLocalStorage 中有上下文即可
 * tmux 子智能体：同时需要 agentId 和 teamName（两者缺一不可）
 */
export function isTeammate(): boolean {
  // 进程内子智能体：AsyncLocalStorage 中有上下文即为子智能体
  const inProcessCtx = getTeammateContext()
  if (inProcessCtx) return true
  // tmux 子智能体：需要同时具备 agentId 和 teamName
  return !!(dynamicTeamContext?.agentId && dynamicTeamContext?.teamName)
}

/**
 * 获取当前子智能体的显示颜色（UI 中用于区分不同成员）。
 *
 * 优先级：AsyncLocalStorage（进程内）> dynamicTeamContext（tmux）
 * 未设置颜色或非子智能体时返回 undefined。
 */
export function getTeammateColor(): string | undefined {
  const inProcessCtx = getTeammateContext()
  if (inProcessCtx) return inProcessCtx.color
  return dynamicTeamContext?.color
}

/**
 * 判断当前子智能体会话是否需要在实施前进入 Plan 模式。
 *
 * 启用后，子智能体必须先进入 Plan 模式并获得批准，才能开始写代码。
 * 优先级：AsyncLocalStorage > dynamicTeamContext > 环境变量 CLAUDE_CODE_PLAN_MODE_REQUIRED
 */
export function isPlanModeRequired(): boolean {
  const inProcessCtx = getTeammateContext()
  if (inProcessCtx) return inProcessCtx.planModeRequired
  // dynamicTeamContext 存在时使用其 planModeRequired 字段（可能为 false）
  if (dynamicTeamContext !== null) {
    return dynamicTeamContext.planModeRequired
  }
  // 最后回退到环境变量
  return isEnvTruthy(process.env.CLAUDE_CODE_PLAN_MODE_REQUIRED)
}

/**
 * 判断当前会话是否为团队领队。
 *
 * 判断条件（同时满足）：
 *   1. teamContext 中存在 leadAgentId
 *   2. 满足以下之一：
 *      a. 当前 agentId 与 leadAgentId 匹配
 *      b. 当前没有 agentId（向后兼容：创建团队时尚未引入 Agent ID 机制的会话）
 *
 * @param teamContext - 来自 AppState 的团队上下文（含 leadAgentId）
 * @returns true 表示当前会话是领队
 */
export function isTeamLead(
  teamContext:
    | {
        leadAgentId: string
      }
    | undefined,
): boolean {
  if (!teamContext?.leadAgentId) {
    return false
  }

  // 使用 getAgentId() 以支持 AsyncLocalStorage（进程内子智能体）
  const myAgentId = getAgentId()
  const leadAgentId = teamContext.leadAgentId

  // 当前 agentId 与领队 agentId 匹配 → 是领队
  if (myAgentId === leadAgentId) {
    return true
  }

  // 向后兼容：若无 agentId 且存在 teamContext，说明这是创建团队时的原始会话（领队）
  if (!myAgentId) {
    return true
  }

  return false
}

/**
 * 检查是否存在活跃的进程内子智能体正在运行。
 *
 * 用于 headless/print 模式判断是否需要等待子智能体完成后再退出。
 * 遍历 AppState.tasks，寻找 type='in_process_teammate' 且 status='running' 的任务。
 *
 * @param appState - 当前应用状态
 * @returns true 表示有进程内子智能体正在运行
 */
export function hasActiveInProcessTeammates(appState: AppState): boolean {
  // 遍历所有任务，检查是否有运行中的进程内子智能体任务
  for (const task of Object.values(appState.tasks)) {
    if (task.type === 'in_process_teammate' && task.status === 'running') {
      return true
    }
  }
  return false
}

/**
 * 检查是否有进程内子智能体正在积极工作（非空闲）。
 *
 * 与 hasActiveInProcessTeammates 的区别：此函数排除了已进入空闲状态的子智能体。
 * 用于决定是否应该等待后再发送关机提示（shutdown prompt）。
 *
 * @param appState - 当前应用状态
 * @returns true 表示有子智能体正在处理任务（未空闲）
 */
export function hasWorkingInProcessTeammates(appState: AppState): boolean {
  for (const task of Object.values(appState.tasks)) {
    // 同时满足：进程内子智能体 + 运行中 + 非空闲
    if (
      task.type === 'in_process_teammate' &&
      task.status === 'running' &&
      !task.isIdle
    ) {
      return true
    }
  }
  return false
}

/**
 * 返回一个 Promise，在所有正在工作的进程内子智能体都变为空闲时 resolve。
 *
 * 实现原理：
 *   1. 扫描 AppState，收集所有 working（运行中且非空闲）的子智能体任务 ID
 *   2. 若无工作中的子智能体，立即 resolve
 *   3. 否则，对每个工作中的任务注册 onIdle 回调
 *   4. 当所有回调都被触发（remaining=0）时 resolve
 *   5. 通过 setAppState 原子性地注册回调，防止在扫描和注册之间发生的竞态条件
 *
 * @param setAppState - AppState 更新函数（用于原子性注册回调）
 * @param appState    - 当前应用状态快照
 * @returns Promise，在所有工作中的子智能体变为空闲时 resolve
 */
export function waitForTeammatesToBecomeIdle(
  setAppState: (f: (prev: AppState) => AppState) => void,
  appState: AppState,
): Promise<void> {
  // 收集所有正在工作（非空闲）的进程内子智能体任务 ID
  const workingTaskIds: string[] = []

  for (const [taskId, task] of Object.entries(appState.tasks)) {
    if (
      task.type === 'in_process_teammate' &&
      task.status === 'running' &&
      !task.isIdle
    ) {
      workingTaskIds.push(taskId)
    }
  }

  // 无工作中的子智能体，立即返回已 resolved 的 Promise
  if (workingTaskIds.length === 0) {
    return Promise.resolve()
  }

  // 创建等待所有子智能体空闲的 Promise
  return new Promise<void>(resolve => {
    let remaining = workingTaskIds.length // 剩余待等待数量

    // 每个子智能体空闲时调用此回调，remaining 减 1
    const onIdle = (): void => {
      remaining--
      if (remaining === 0) {
        // biome-ignore lint/nursery/noFloatingPromises: resolve 是回调，非 Promise
        resolve()
      }
    }

    // 通过 setAppState 原子性地注册空闲回调
    // 此处检查 isIdle 状态以处理从初始快照到此处注册之间的竞态条件
    setAppState(prev => {
      const newTasks = { ...prev.tasks }
      for (const taskId of workingTaskIds) {
        const task = newTasks[taskId]
        if (task && task.type === 'in_process_teammate') {
          // 若任务在注册前已变为空闲，立即触发回调（处理竞态）
          if (task.isIdle) {
            onIdle()
          } else {
            // 否则将回调追加到 onIdleCallbacks 列表中
            newTasks[taskId] = {
              ...task,
              onIdleCallbacks: [...(task.onIdleCallbacks ?? []), onIdle],
            }
          }
        }
      }
      return { ...prev, tasks: newTasks }
    })
  })
}
