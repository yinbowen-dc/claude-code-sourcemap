/**
 * swarm/spawnInProcess.ts — 进程内 Teammate 孵化模块
 *
 * 在 Claude Code 系统流程中的位置：
 *   Swarm 工具链的孵化层（Spawn Layer）。当 Leader 决定以"进程内"方式创建 Teammate 时，
 *   由本模块完成从配置到 AppState 注册的完整生命周期初始化。
 *
 * 与进程级 Teammate（tmux/iTerm2）不同，进程内 Teammate 运行在同一个 Node.js 进程中，
 * 通过 AsyncLocalStorage 实现上下文隔离，由 InProcessTeammateTask 组件（Task #14）
 * 驱动实际的 Agent 执行循环。
 *
 * 本模块负责：
 *   1. 创建 TeammateContext（用于 AsyncLocalStorage 身份隔离）；
 *   2. 创建独立的 AbortController（Teammate 不受 Leader 中断影响）；
 *   3. 向 AppState 注册 InProcessTeammateTaskState；
 *   4. 返回孵化结果供调用方（Backend）使用。
 */

import sample from 'lodash-es/sample.js'
import { getSessionId } from '../../bootstrap/state.js'
import { getSpinnerVerbs } from '../../constants/spinnerVerbs.js'
import { TURN_COMPLETION_VERBS } from '../../constants/turnCompletionVerbs.js'
import type { AppState } from '../../state/AppState.js'
import { createTaskStateBase, generateTaskId } from '../../Task.js'
import type {
  InProcessTeammateTaskState,
  TeammateIdentity,
} from '../../tasks/InProcessTeammateTask/types.js'
import { createAbortController } from '../abortController.js'
import { formatAgentId } from '../agentId.js'
import { registerCleanup } from '../cleanupRegistry.js'
import { logForDebugging } from '../debug.js'
import { emitTaskTerminatedSdk } from '../sdkEventQueue.js'
import { evictTaskOutput } from '../task/diskOutput.js'
import {
  evictTerminalTask,
  registerTask,
  STOPPED_DISPLAY_MS,
} from '../task/framework.js'
import { createTeammateContext } from '../teammateContext.js'
import {
  isPerfettoTracingEnabled,
  registerAgent as registerPerfettoAgent,
  unregisterAgent as unregisterPerfettoAgent,
} from '../telemetry/perfettoTracing.js'
import { removeMemberByAgentId } from './teamHelpers.js'

// AppState setter 函数的类型别名，用于统一入参类型
type SetAppStateFn = (updater: (prev: AppState) => AppState) => void

/**
 * 孵化进程内 Teammate 所需的最小上下文。
 * 是 ToolUseContext 的子集，仅包含 spawnInProcessTeammate 实际使用的字段。
 */
export type SpawnContext = {
  setAppState: SetAppStateFn
  toolUseId?: string // 关联的工具调用 ID，用于 SDK 事件跟踪
}

/**
 * 孵化进程内 Teammate 的配置参数。
 */
export type InProcessSpawnConfig = {
  /** Teammate 的显示名称，例如 "researcher" */
  name: string
  /** 该 Teammate 所属的团队名称 */
  teamName: string
  /** Teammate 的初始任务提示词 */
  prompt: string
  /** 可选的 UI 显示颜色 */
  color?: string
  /** 是否要求 Teammate 在实施前进入 Plan 模式 */
  planModeRequired: boolean
  /** 可选的模型覆盖（覆盖全局默认模型） */
  model?: string
}

/**
 * 孵化进程内 Teammate 的返回结果。
 */
export type InProcessSpawnOutput = {
  /** 孵化是否成功 */
  success: boolean
  /** 完整的 Agent ID（格式："name@team"） */
  agentId: string
  /** 在 AppState 中跟踪的 Task ID */
  taskId?: string
  /** 该 Teammate 的 AbortController（与 Leader 独立） */
  abortController?: AbortController
  /** 用于 AsyncLocalStorage 的 Teammate 上下文 */
  teammateContext?: ReturnType<typeof createTeammateContext>
  /** 孵化失败时的错误信息 */
  error?: string
}

/**
 * 孵化一个进程内 Teammate。
 *
 * 详细流程：
 *   1. 根据 name 和 teamName 生成确定性的 agentId 与 taskId；
 *   2. 创建独立的 AbortController（Teammate 不受 Leader 中断传播）；
 *   3. 获取父会话 ID 用于 transcript 关联；
 *   4. 构建 TeammateIdentity（纯数据，存入 AppState）；
 *   5. 创建 TeammateContext（含 AbortController，用于 AsyncLocalStorage 隔离）；
 *   6. 若启用了 Perfetto 追踪，注册 Agent 以支持层次可视化；
 *   7. 构建 InProcessTeammateTaskState 并注册到 AppState；
 *   8. 注册清理回调（进程退出时 abort 该 Teammate）；
 *   9. 返回包含身份信息的孵化结果。
 *
 * @param config  - 孵化配置
 * @param context - 包含 setAppState 的上下文
 * @returns 孵化结果，含 Teammate 身份及控制器引用
 */
export async function spawnInProcessTeammate(
  config: InProcessSpawnConfig,
  context: SpawnContext,
): Promise<InProcessSpawnOutput> {
  const { name, teamName, prompt, color, planModeRequired, model } = config
  const { setAppState } = context

  // 生成确定性的 Agent ID（格式："name@teamName"）和唯一的 Task ID
  const agentId = formatAgentId(name, teamName)
  const taskId = generateTaskId('in_process_teammate')

  logForDebugging(
    `[spawnInProcessTeammate] Spawning ${agentId} (taskId: ${taskId})`,
  )

  try {
    // 为该 Teammate 创建独立的 AbortController
    // Teammate 不应因 Leader 的查询中断而被 abort
    const abortController = createAbortController()

    // 获取父会话 ID，用于跨会话 transcript 关联
    const parentSessionId = getSessionId()

    // 创建 Teammate 身份对象（纯数据，持久化在 AppState 中）
    const identity: TeammateIdentity = {
      agentId,
      agentName: name,
      teamName,
      color,
      planModeRequired,
      parentSessionId,
    }

    // 创建 Teammate 上下文（含 AbortController），供 runWithTeammateContext() 使用
    // 在 Agent 执行循环中通过 AsyncLocalStorage 提供身份隔离
    const teammateContext = createTeammateContext({
      agentId,
      agentName: name,
      teamName,
      color,
      planModeRequired,
      parentSessionId,
      abortController,
    })

    // 若启用了 Perfetto 追踪，注册 Agent 以支持层次可视化
    if (isPerfettoTracingEnabled()) {
      registerPerfettoAgent(agentId, name, parentSessionId)
    }

    // 截取提示词前 50 字符作为任务描述，超出部分用省略号替代
    const description = `${name}: ${prompt.substring(0, 50)}${prompt.length > 50 ? '...' : ''}`

    // 构建完整的 InProcessTeammateTaskState，包含运行时所需的所有字段
    const taskState: InProcessTeammateTaskState = {
      ...createTaskStateBase(
        taskId,
        'in_process_teammate',
        description,
        context.toolUseId,
      ),
      type: 'in_process_teammate',
      status: 'running',          // 初始状态直接为运行中
      identity,
      prompt,
      model,
      abortController,
      awaitingPlanApproval: false, // 初始不处于等待计划审批状态
      spinnerVerb: sample(getSpinnerVerbs()),         // 随机选取加载动词用于 UI 展示
      pastTenseVerb: sample(TURN_COMPLETION_VERBS),   // 随机选取完成动词用于 UI 展示
      permissionMode: planModeRequired ? 'plan' : 'default', // 根据配置确定权限模式
      isIdle: false,
      shutdownRequested: false,
      lastReportedToolCount: 0,
      lastReportedTokenCount: 0,
      pendingUserMessages: [],
      messages: [], // 初始化为空数组，使 getDisplayedMessages 立即可用
    }

    // 注册清理回调，进程退出时优雅中止该 Teammate
    const unregisterCleanup = registerCleanup(async () => {
      logForDebugging(`[spawnInProcessTeammate] Cleanup called for ${agentId}`)
      abortController.abort()
      // 执行循环检测到 abort 后会自行更新任务状态
    })
    taskState.unregisterCleanup = unregisterCleanup

    // 将任务注册到 AppState，使 React UI 可以感知并渲染该 Teammate
    registerTask(taskState, setAppState)

    logForDebugging(
      `[spawnInProcessTeammate] Registered ${agentId} in AppState`,
    )

    return {
      success: true,
      agentId,
      taskId,
      abortController,
      teammateContext,
    }
  } catch (error) {
    // 捕获孵化过程中的任何错误，返回失败结果而非抛出异常
    const errorMessage =
      error instanceof Error ? error.message : 'Unknown error during spawn'
    logForDebugging(
      `[spawnInProcessTeammate] Failed to spawn ${agentId}: ${errorMessage}`,
    )
    return {
      success: false,
      agentId,
      error: errorMessage,
    }
  }
}

/**
 * 通过中止 AbortController 终止一个进程内 Teammate。
 *
 * 详细流程：
 *   1. 在 AppState 中查找指定 taskId 对应的 Teammate 任务；
 *   2. 若任务存在且状态为 running，中止其 AbortController 并调用清理回调；
 *   3. 触发所有等待"空闲"的回调（解除 engine.waitForIdle 的阻塞）；
 *   4. 从 teamContext.teammates 中移除该 Teammate；
 *   5. 将任务状态更新为 killed，清理敏感字段；
 *   6. 在 AppState 更新完成后，从磁盘团队文件中移除该成员；
 *   7. 驱逐磁盘输出缓存，发送 SDK 终止事件，延迟驱逐任务状态。
 *
 * 注意：该函数是 InProcessBackend.kill() 的实现层。
 *
 * @param taskId      - 需要终止的 Teammate 的 Task ID
 * @param setAppState - AppState setter
 * @returns 若成功终止则返回 true
 */
export function killInProcessTeammate(
  taskId: string,
  setAppState: SetAppStateFn,
): boolean {
  let killed = false
  let teamName: string | null = null
  let agentId: string | null = null
  let toolUseId: string | undefined
  let description: string | undefined

  setAppState((prev: AppState) => {
    const task = prev.tasks[taskId]
    // 任务不存在或类型不匹配，直接返回原状态
    if (!task || task.type !== 'in_process_teammate') {
      return prev
    }

    const teammateTask = task as InProcessTeammateTaskState

    // 只能终止运行中的任务
    if (teammateTask.status !== 'running') {
      return prev
    }

    // 捕获身份信息，供状态更新后在外部进行文件 I/O
    teamName = teammateTask.identity.teamName
    agentId = teammateTask.identity.agentId
    toolUseId = teammateTask.toolUseId
    description = teammateTask.description

    // 中止执行循环
    teammateTask.abortController?.abort()

    // 调用注册的清理回调
    teammateTask.unregisterCleanup?.()

    killed = true

    // 触发所有等待空闲的回调，解除阻塞（如 engine.waitForIdle）
    teammateTask.onIdleCallbacks?.forEach(cb => cb())

    // 从 teamContext.teammates 中移除该 Teammate
    let updatedTeamContext = prev.teamContext
    if (prev.teamContext && prev.teamContext.teammates && agentId) {
      const { [agentId]: _, ...remainingTeammates } = prev.teamContext.teammates
      updatedTeamContext = {
        ...prev.teamContext,
        teammates: remainingTeammates,
      }
    }

    return {
      ...prev,
      teamContext: updatedTeamContext,
      tasks: {
        ...prev.tasks,
        [taskId]: {
          ...teammateTask,
          status: 'killed' as const,
          notified: true,           // 预设为已通知，避免重复触发 XML 通知
          endTime: Date.now(),
          onIdleCallbacks: [],       // 清空回调，防止悬空引用
          messages: teammateTask.messages?.length
            ? [teammateTask.messages[teammateTask.messages.length - 1]!]
            : undefined,
          pendingUserMessages: [],
          inProgressToolUseIDs: undefined,
          abortController: undefined,      // 释放 AbortController 引用
          unregisterCleanup: undefined,
          currentWorkAbortController: undefined,
        },
      },
    }
  })

  // 在 AppState 更新完成后，从磁盘团队文件中移除成员（避免在 state updater 中做文件 I/O）
  if (teamName && agentId) {
    removeMemberByAgentId(teamName, agentId)
  }

  if (killed) {
    // 驱逐磁盘输出缓存
    void evictTaskOutput(taskId)
    // notified:true 已预设，不会触发 XML 通知；直接关闭 SDK task_started 事件的书签
    // 进程内执行器的完成/失败 emit 会检查 status==='running'，不会在 status:killed 后重复 emit
    emitTaskTerminatedSdk(taskId, 'stopped', {
      toolUseId,
      summary: description,
    })
    // 延迟驱逐任务状态，保证 UI 短暂显示"已停止"状态
    setTimeout(
      evictTerminalTask.bind(null, taskId, setAppState),
      STOPPED_DISPLAY_MS,
    )
  }

  // 释放 Perfetto Agent 注册项
  if (agentId) {
    unregisterPerfettoAgent(agentId)
  }

  return killed
}
