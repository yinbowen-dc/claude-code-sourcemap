/**
 * coordinatorHandler.ts
 *
 * 【在系统流程中的位置】
 * 本文件属于 Claude Code 「工具权限」子系统（toolPermission/handlers/），
 * 负责处理「Coordinator Worker（协调者）」角色下的权限决策流程。
 *
 * 在多 Agent（Swarm）架构中，Coordinator 是主协调进程，需要代表子 Agent
 * 批准或拒绝工具调用权限。与普通交互式权限流程不同，Coordinator 会
 * 先等待自动化检查（hooks + classifier）顺序执行完毕，再决定是否
 * 显示交互式对话框，而非将自动化检查与用户交互并发竞争。
 *
 * 三种 Handler 对比：
 * - coordinatorHandler：顺序等待自动化检查 → 无法自动批准则降级到对话框
 * - interactiveHandler：并发竞争（用户交互 vs hooks vs classifier vs bridge vs channel）
 * - swarmWorkerHandler：转发给 leader 等待批准
 */

import { feature } from 'bun:bundle'
import type { PendingClassifierCheck } from '../../../types/permissions.js'
import { logError } from '../../../utils/log.js'
import type { PermissionDecision } from '../../../utils/permissions/PermissionResult.js'
import type { PermissionUpdate } from '../../../utils/permissions/PermissionUpdateSchema.js'
import type { PermissionContext } from '../PermissionContext.js'

/** Coordinator 权限处理所需的入参 */
type CoordinatorPermissionParams = {
  ctx: PermissionContext                           // 封装了工具、输入、权限队列等上下文
  pendingClassifierCheck?: PendingClassifierCheck | undefined  // 待执行的分类器检查（bash 专用）
  updatedInput: Record<string, unknown> | undefined  // 可能被 hook 修改后的工具输入
  suggestions: PermissionUpdate[] | undefined       // 权限更新建议列表
  permissionMode: string | undefined                // 当前权限模式（default/auto 等）
}

/**
 * 处理 Coordinator Worker 的权限流程。
 *
 * 与 interactiveHandler 的区别在于：本函数会**顺序**等待所有自动化检查完成，
 * 而不是与用户交互并发竞争。具体流程如下：
 *
 * 1. 先执行 PermissionRequest hooks（本地、快速）；
 * 2. hooks 未解决时，再尝试 BASH_CLASSIFIER（慢、需推理，仅 bash）；
 * 3. 任意自动化检查通过则直接返回决策；
 * 4. 均未通过（或发生异常）时返回 null，由调用方降级到交互对话框。
 *
 * @returns PermissionDecision 表示自动化检查已解决权限；
 *          null 表示需要降级到交互对话框由用户决定。
 */
async function handleCoordinatorPermission(
  params: CoordinatorPermissionParams,
): Promise<PermissionDecision | null> {
  const { ctx, updatedInput, suggestions, permissionMode } = params

  try {
    // 步骤 1：执行 PermissionRequest hooks（优先级最高，速度最快）
    const hookResult = await ctx.runHooks(
      permissionMode,
      suggestions,
      updatedInput,
    )
    // hook 已解决权限（允许或拒绝），直接返回
    if (hookResult) return hookResult

    // 步骤 2：尝试 bash 分类器自动批准（仅在 BASH_CLASSIFIER feature 开启时执行）
    const classifierResult = feature('BASH_CLASSIFIER')
      ? await ctx.tryClassifier?.(params.pendingClassifierCheck, updatedInput)
      : null
    if (classifierResult) {
      // 分类器自动批准，返回决策
      return classifierResult
    }
  } catch (error) {
    // 自动化检查发生意外异常时，不阻塞流程，降级到对话框让用户手动决定
    // 非 Error 类型的抛出值加上上下文前缀，保证日志可追踪
    // 注意：此处故意不用 toError()，以保留前缀信息
    if (error instanceof Error) {
      logError(error)
    } else {
      logError(new Error(`Automated permission check failed: ${String(error)}`))
    }
  }

  // 步骤 3：自动化检查均未解决（或检查失败），返回 null 降级到交互对话框
  // hooks 已执行，classifier 已消费，调用方无需重复执行
  return null
}

export { handleCoordinatorPermission }
export type { CoordinatorPermissionParams }
