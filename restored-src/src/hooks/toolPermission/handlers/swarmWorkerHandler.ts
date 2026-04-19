/**
 * swarmWorkerHandler.ts
 *
 * 【在系统流程中的位置】
 * 本文件属于 Claude Code 「工具权限」子系统（toolPermission/handlers/），
 * 负责处理「Swarm Worker（群组工作者）」角色下的权限决策流程。
 *
 * 在多 Agent（Swarm）架构中，Worker 是在后台运行的子 Agent，没有直接操作 UI 的能力。
 * 当 Worker 需要工具调用权限时，必须将权限请求通过「邮箱（mailbox）」转发给
 * Leader（主进程），等待 Leader 展示对话框并由用户（或自动化规则）决定后，
 * 再将结果异步回传给 Worker。
 *
 * 三种 Handler 对比：
 * - coordinatorHandler：顺序执行自动化检查 → 降级到本地对话框
 * - interactiveHandler：本地对话框 + 并发自动化检查 + bridge/channel 远程竞争
 * - swarmWorkerHandler（本文件）：先尝试 classifier，失败则转发给 leader 等待回应
 */

import { feature } from 'bun:bundle'
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages.mjs'
import type { PendingClassifierCheck } from '../../../types/permissions.js'
import { isAgentSwarmsEnabled } from '../../../utils/agentSwarmsEnabled.js'
import { toError } from '../../../utils/errors.js'
import { logError } from '../../../utils/log.js'
import type { PermissionDecision } from '../../../utils/permissions/PermissionResult.js'
import type { PermissionUpdate } from '../../../utils/permissions/PermissionUpdateSchema.js'
import {
  createPermissionRequest,
  isSwarmWorker,
  sendPermissionRequestViaMailbox,
} from '../../../utils/swarm/permissionSync.js'
import { registerPermissionCallback } from '../../useSwarmPermissionPoller.js'
import type { PermissionContext } from '../PermissionContext.js'
import { createResolveOnce } from '../PermissionContext.js'

/** Swarm Worker 权限处理所需的入参 */
type SwarmWorkerPermissionParams = {
  ctx: PermissionContext                             // 工具权限上下文
  description: string                               // 工具调用的人类可读描述
  pendingClassifierCheck?: PendingClassifierCheck | undefined  // bash 分类器检查（可选）
  updatedInput: Record<string, unknown> | undefined  // 被修改后的工具输入
  suggestions: PermissionUpdate[] | undefined       // 权限更新建议列表
}

/**
 * 处理 Swarm Worker 的权限流程。
 *
 * 当前进程作为 Swarm Worker 运行时的权限处理逻辑：
 * 1. 先检查是否启用了 Agent Swarms 功能，且当前确实是 Swarm Worker；
 * 2. 对 bash 命令尝试分类器自动批准（Worker 等待结果，不并发）；
 * 3. 分类器未批准则将权限请求打包，通过邮箱发送给 Leader；
 * 4. 注册回调（onAllow / onReject），等待 Leader 响应；
 * 5. 设置「等待 Leader 批准中」的视觉指示状态；
 * 6. 若 abort 信号触发，取消等待并返回 cancel 决策。
 *
 * @returns PermissionDecision - 分类器自动批准时立即返回；
 *          等待 Leader 响应的 Promise 结果；
 *          null - 非 Swarm Worker 或 swarm 未启用时，降级到本地交互处理。
 */
async function handleSwarmWorkerPermission(
  params: SwarmWorkerPermissionParams,
): Promise<PermissionDecision | null> {
  // 非 Swarm Worker 环境直接返回 null，让调用方降级到交互式处理
  if (!isAgentSwarmsEnabled() || !isSwarmWorker()) {
    return null
  }

  const { ctx, description, updatedInput, suggestions } = params

  // 步骤 1：对 bash 命令先尝试分类器自动批准
  // Worker 会等待分类器结果（不像主 Agent 那样与用户交互并发）
  const classifierResult = feature('BASH_CLASSIFIER')
    ? await ctx.tryClassifier?.(params.pendingClassifierCheck, updatedInput)
    : null
  if (classifierResult) {
    // 分类器已自动批准，无需发送给 Leader
    return classifierResult
  }

  // 步骤 2：将权限请求转发给 Leader 处理
  try {
    // clearPendingRequest 用于清除「等待 Leader 批准中」的视觉状态
    const clearPendingRequest = (): void =>
      ctx.toolUseContext.setAppState(prev => ({
        ...prev,
        pendingWorkerRequest: null,
      }))

    const decision = await new Promise<PermissionDecision>(resolve => {
      const { resolve: resolveOnce, claim } = createResolveOnce(resolve)

      // 构建权限请求对象（包含工具名、ID、输入、描述等）
      const request = createPermissionRequest({
        toolName: ctx.tool.name,
        toolUseId: ctx.toolUseID,
        input: ctx.input,
        description,
        permissionSuggestions: suggestions,
      })

      // 注意：必须先注册回调，再发送请求，防止 Leader 在回调注册前就响应导致竞争
      registerPermissionCallback({
        requestId: request.id,
        toolUseId: ctx.toolUseID,
        async onAllow(
          allowedInput: Record<string, unknown> | undefined,
          permissionUpdates: PermissionUpdate[],
          feedback?: string,
          contentBlocks?: ContentBlockParam[],
        ) {
          if (!claim()) return // 原子 check-and-mark，防止重复 resolve（await 前执行）
          clearPendingRequest()

          // 优先使用 Leader 修改后的输入；若未修改则保留原始输入
          const finalInput =
            allowedInput && Object.keys(allowedInput).length > 0
              ? allowedInput
              : ctx.input

          resolveOnce(
            await ctx.handleUserAllow(
              finalInput,
              permissionUpdates,
              feedback,
              undefined,
              contentBlocks,
            ),
          )
        },
        onReject(feedback?: string, contentBlocks?: ContentBlockParam[]) {
          if (!claim()) return
          clearPendingRequest()

          // 记录拒绝决策到分析日志
          ctx.logDecision({
            decision: 'reject',
            source: { type: 'user_reject', hasFeedback: !!feedback },
          })

          resolveOnce(ctx.cancelAndAbort(feedback, undefined, contentBlocks))
        },
      })

      // 回调注册完成后，将请求发送到 Leader 的邮箱
      void sendPermissionRequestViaMailbox(request)

      // 设置「等待 Leader 批准中」的视觉指示（显示在 Worker 的状态栏）
      ctx.toolUseContext.setAppState(prev => ({
        ...prev,
        pendingWorkerRequest: {
          toolName: ctx.tool.name,
          toolUseId: ctx.toolUseID,
          description,
        },
      }))

      // 若 abort 信号触发（如用户取消），停止等待并返回取消决策，避免 Promise 永久挂起
      ctx.toolUseContext.abortController.signal.addEventListener(
        'abort',
        () => {
          if (!claim()) return
          clearPendingRequest()
          ctx.logCancelled()
          resolveOnce(ctx.cancelAndAbort(undefined, true))
        },
        { once: true },
      )
    })

    return decision
  } catch (error) {
    // 邮箱发送失败时，记录错误并返回 null，降级到本地 UI 处理
    logError(toError(error))
    // 继续降级到本地交互处理
    return null
  }
}

export { handleSwarmWorkerPermission }
export type { SwarmWorkerPermissionParams }
