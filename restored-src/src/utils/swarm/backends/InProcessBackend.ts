/**
 * In-Process Teammate 执行后端
 *
 * 在 Claude Code 系统流程中的位置：
 * 该模块实现了 TeammateExecutor 接口，是 Swarm 多智能体系统的三种后端之一。
 * 与 TmuxBackend/ITermBackend（基于终端窗格）不同，
 * InProcessBackend 在同一 Node.js 进程中运行 teammate，
 * 通过 AsyncLocalStorage 实现上下文隔离。
 *
 * 核心特性：
 * - 共享资源：与领导者共享 API 客户端、MCP 连接，避免重复初始化开销
 * - 相同通信机制：使用文件邮箱（file-based mailbox）与窗格模式 teammate 保持一致
 * - 优雅关闭：通过邮箱发送关闭请求；强制终止通过 AbortController.abort()
 * - 无外部依赖：始终可用（isAvailable 返回 true），不需要 tmux/iTerm2
 *
 * 重要：使用前必须调用 setContext() 设置 ToolUseContext，
 * 才能访问 AppState（用于任务追踪和关闭控制）。
 *
 * 使用方式：通过 registry.ts 的 getTeammateExecutor() 获取实例，
 * 再通过 TeammateExecutor 接口调用。
 */

import type { ToolUseContext } from '../../../Tool.js'
import {
  findTeammateTaskByAgentId,
  requestTeammateShutdown,
} from '../../../tasks/InProcessTeammateTask/InProcessTeammateTask.js'
import { parseAgentId } from '../../../utils/agentId.js'
import { logForDebugging } from '../../../utils/debug.js'
import { jsonStringify } from '../../../utils/slowOperations.js'
import {
  createShutdownRequestMessage,
  writeToMailbox,
} from '../../../utils/teammateMailbox.js'
import { startInProcessTeammate } from '../inProcessRunner.js'
import {
  killInProcessTeammate,
  spawnInProcessTeammate,
} from '../spawnInProcess.js'
import type {
  TeammateExecutor,
  TeammateMessage,
  TeammateSpawnConfig,
  TeammateSpawnResult,
} from './types.js'

/**
 * In-Process Teammate 执行后端类。
 * 实现 TeammateExecutor 接口，在同一 Node.js 进程中运行 teammate。
 *
 * 与窗格模式后端（tmux/iTerm2）的主要区别：
 * - teammate 不是单独的进程，而是同进程的异步任务
 * - 需要 setContext() 提供 AppState 访问能力
 * - 终止通过 AbortController 而非 kill-pane 命令
 * - 文件邮箱通信机制与窗格模式相同，保持接口一致性
 */
export class InProcessBackend implements TeammateExecutor {
  /** 后端类型标识符，固定为 'in-process' */
  readonly type = 'in-process' as const

  /**
   * 工具使用上下文（ToolUseContext）。
   * 提供 AppState 访问（getAppState/setAppState），用于任务管理。
   * 必须在 spawn() 前通过 setContext() 设置。
   */
  private context: ToolUseContext | null = null

  /**
   * 设置工具使用上下文。
   * TeammateTool 在调用 spawn() 之前调用此方法，提供 AppState 访问入口。
   *
   * @param context ToolUseContext，包含 getAppState/setAppState 等方法
   */
  setContext(context: ToolUseContext): void {
    this.context = context
  }

  /**
   * 检查后端是否可用。
   * In-process 模式无外部依赖，始终返回 true。
   */
  async isAvailable(): Promise<boolean> {
    return true
  }

  /**
   * 生成一个 in-process teammate。
   *
   * 流程：
   * 1. 验证 context 已设置（必要前提）。
   * 2. 调用 spawnInProcessTeammate() 完成以下工作：
   *    - 创建 TeammateContext（AsyncLocalStorage 上下文）
   *    - 创建独立的 AbortController（不继承父级的）
   *    - 在 AppState.tasks 中注册任务
   * 3. 若 spawn 成功，调用 startInProcessTeammate() 在后台启动 agent 执行循环：
   *    - 传入 identity、taskId、prompt、toolUseContext（清空 messages 避免父会话污染）
   *    - fire-and-forget 模式，不等待完成
   * 4. 返回包含 agentId、taskId、abortController 的结果。
   *
   * @param config teammate 的完整生成配置
   * @returns 生成结果，包含 agentId 和控制句柄
   */
  async spawn(config: TeammateSpawnConfig): Promise<TeammateSpawnResult> {
    // 前置检查：context 未设置时无法访问 AppState
    if (!this.context) {
      logForDebugging(
        `[InProcessBackend] spawn() called without context for ${config.name}`,
      )
      return {
        success: false,
        agentId: `${config.name}@${config.teamName}`,
        error:
          'InProcessBackend not initialized. Call setContext() before spawn().',
      }
    }

    logForDebugging(`[InProcessBackend] spawn() called for ${config.name}`)

    // 创建 TeammateContext 并注册任务，获取 AbortController 等控制对象
    const result = await spawnInProcessTeammate(
      {
        name: config.name,
        teamName: config.teamName,
        prompt: config.prompt,
        color: config.color,
        planModeRequired: config.planModeRequired ?? false,
      },
      this.context,
    )

    // spawn 成功时启动 agent 执行循环（fire-and-forget）
    if (
      result.success &&
      result.taskId &&
      result.teammateContext &&
      result.abortController
    ) {
      // 后台启动 agent 循环，不 await，由 AbortController 控制生命周期
      startInProcessTeammate({
        identity: {
          agentId: result.agentId,
          agentName: config.name,
          teamName: config.teamName,
          color: config.color,
          planModeRequired: config.planModeRequired ?? false,
          parentSessionId: result.teammateContext.parentSessionId,
        },
        taskId: result.taskId,
        prompt: config.prompt,
        teammateContext: result.teammateContext,
        // 清空 messages：teammate 通过 createSubagentContext 覆盖消息，
        // 传入父会话的对话历史会将其固定在 teammate 整个生命周期内
        toolUseContext: { ...this.context, messages: [] },
        abortController: result.abortController,
        model: config.model,
        systemPrompt: config.systemPrompt,
        systemPromptMode: config.systemPromptMode,
        allowedTools: config.permissions,
        allowPermissionPrompts: config.allowPermissionPrompts,
      })

      logForDebugging(
        `[InProcessBackend] Started agent execution for ${result.agentId}`,
      )
    }

    // 返回生成结果（含控制句柄，供领导者管理生命周期）
    return {
      success: result.success,
      agentId: result.agentId,
      taskId: result.taskId,
      abortController: result.abortController,
      error: result.error,
    }
  }

  /**
   * 向 in-process teammate 发送消息。
   *
   * 与窗格模式 teammate 使用相同的文件邮箱机制，保持接口一致性。
   *
   * 流程：
   * 1. 解析 agentId 为 agentName 和 teamName（格式：agentName@teamName）。
   * 2. 调用 writeToMailbox 将消息写入文件邮箱。
   *
   * @param agentId 目标 teammate 的 agent ID（格式：agentName@teamName）
   * @param message 要发送的消息内容
   */
  async sendMessage(agentId: string, message: TeammateMessage): Promise<void> {
    logForDebugging(
      `[InProcessBackend] sendMessage() to ${agentId}: ${message.text.substring(0, 50)}...`,
    )

    // 解析 agentId 格式：agentName@teamName（如 "researcher@my-team"）
    const parsed = parseAgentId(agentId)
    if (!parsed) {
      logForDebugging(`[InProcessBackend] Invalid agentId format: ${agentId}`)
      throw new Error(
        `Invalid agentId format: ${agentId}. Expected format: agentName@teamName`,
      )
    }

    const { agentName, teamName } = parsed

    // 写入文件邮箱（teammate 的消息轮询循环会读取此邮箱）
    await writeToMailbox(
      agentName,
      {
        text: message.text,
        from: message.from,
        color: message.color,
        // 未提供 timestamp 时使用当前时间
        timestamp: message.timestamp ?? new Date().toISOString(),
      },
      teamName,
    )

    logForDebugging(`[InProcessBackend] sendMessage() completed for ${agentId}`)
  }

  /**
   * 优雅关闭 in-process teammate（发送关闭请求）。
   *
   * 与窗格模式不同，in-process teammate 通过以下流程关闭：
   * 1. 向 teammate 的邮箱发送 JSON 格式的关闭请求消息。
   * 2. 设置 AppState 中任务的 shutdownRequested 标志。
   * 3. teammate 处理该请求：同意则退出，拒绝（仍有工作）则继续运行。
   *
   * 幂等性：若已有关闭请求待处理，直接返回 true 不重复发送。
   *
   * @param agentId 目标 teammate 的 agent ID
   * @param reason 关闭原因（可选，用于日志和 teammate 的决策参考）
   * @returns true 表示关闭请求已成功发送（或已存在），false 表示失败
   */
  async terminate(agentId: string, reason?: string): Promise<boolean> {
    logForDebugging(
      `[InProcessBackend] terminate() called for ${agentId}: ${reason}`,
    )

    // 前置检查：无 context 时无法查找任务
    if (!this.context) {
      logForDebugging(
        `[InProcessBackend] terminate() failed: no context set for ${agentId}`,
      )
      return false
    }

    // 从 AppState 中查找对应的任务
    const state = this.context.getAppState()
    const task = findTeammateTaskByAgentId(agentId, state.tasks)

    if (!task) {
      logForDebugging(
        `[InProcessBackend] terminate() failed: task not found for ${agentId}`,
      )
      return false
    }

    // 幂等性检查：已有关闭请求时不重复发送
    if (task.shutdownRequested) {
      logForDebugging(
        `[InProcessBackend] terminate(): shutdown already requested for ${agentId}`,
      )
      return true
    }

    // 生成确定性的请求 ID（含时间戳以保证唯一性）
    const requestId = `shutdown-${agentId}-${Date.now()}`

    // 创建标准格式的关闭请求消息（JSON 序列化）
    const shutdownRequest = createShutdownRequestMessage({
      requestId,
      from: 'team-lead', // terminate 总是由领导者发起
      reason,
    })

    // 将关闭请求写入 teammate 的文件邮箱
    const teammateAgentName = task.identity.agentName
    await writeToMailbox(
      teammateAgentName,
      {
        from: 'team-lead',
        text: jsonStringify(shutdownRequest),
        timestamp: new Date().toISOString(),
      },
      task.identity.teamName,
    )

    // 在 AppState 中标记该任务已请求关闭（用于 UI 状态显示）
    requestTeammateShutdown(task.id, this.context.setAppState)

    logForDebugging(
      `[InProcessBackend] terminate() sent shutdown request to ${agentId}`,
    )

    return true
  }

  /**
   * 强制终止 in-process teammate（立即终止，不等待优雅关闭）。
   *
   * 通过 AbortController.abort() 取消所有异步操作，
   * 并将 AppState 中的任务状态更新为 'killed'。
   *
   * @param agentId 要终止的 teammate 的 agent ID
   * @returns true 表示终止成功，false 表示失败（任务不存在或无 context）
   */
  async kill(agentId: string): Promise<boolean> {
    logForDebugging(`[InProcessBackend] kill() called for ${agentId}`)

    // 前置检查：无 context 时无法查找任务
    if (!this.context) {
      logForDebugging(
        `[InProcessBackend] kill() failed: no context set for ${agentId}`,
      )
      return false
    }

    // 从 AppState 中查找对应的任务
    const state = this.context.getAppState()
    const task = findTeammateTaskByAgentId(agentId, state.tasks)

    if (!task) {
      logForDebugging(
        `[InProcessBackend] kill() failed: task not found for ${agentId}`,
      )
      return false
    }

    // 调用 killInProcessTeammate：abort AbortController 并更新任务状态
    const killed = killInProcessTeammate(task.id, this.context.setAppState)

    logForDebugging(
      `[InProcessBackend] kill() ${killed ? 'succeeded' : 'failed'} for ${agentId}`,
    )

    return killed
  }

  /**
   * 检查 in-process teammate 是否仍在运行。
   *
   * 判断标准：
   * 1. AppState 中存在对应任务
   * 2. 任务状态为 'running'
   * 3. AbortController 信号未被中止（aborted = false）
   *
   * 三个条件同时满足才返回 true。
   *
   * @param agentId 要检查的 teammate 的 agent ID
   * @returns true 表示仍在运行，false 表示已停止或不存在
   */
  async isActive(agentId: string): Promise<boolean> {
    logForDebugging(`[InProcessBackend] isActive() called for ${agentId}`)

    // 前置检查：无 context 时无法查找任务
    if (!this.context) {
      logForDebugging(
        `[InProcessBackend] isActive() failed: no context set for ${agentId}`,
      )
      return false
    }

    // 从 AppState 中查找对应的任务
    const state = this.context.getAppState()
    const task = findTeammateTaskByAgentId(agentId, state.tasks)

    if (!task) {
      logForDebugging(
        `[InProcessBackend] isActive(): task not found for ${agentId}`,
      )
      return false
    }

    // 检查运行状态和 AbortController 信号
    const isRunning = task.status === 'running'
    // AbortController 不存在时视为已中止（保守估计）
    const isAborted = task.abortController?.signal.aborted ?? true

    // 两者均满足才视为活跃
    const active = isRunning && !isAborted

    logForDebugging(
      `[InProcessBackend] isActive() for ${agentId}: ${active} (running=${isRunning}, aborted=${isAborted})`,
    )

    return active
  }
}

/**
 * 创建 InProcessBackend 实例的工厂函数。
 * registry.ts 通过此函数获取后端实例，符合统一的工厂函数模式。
 *
 * @returns 新的 InProcessBackend 实例（未设置 context，需调用 setContext()）
 */
export function createInProcessBackend(): InProcessBackend {
  return new InProcessBackend()
}
