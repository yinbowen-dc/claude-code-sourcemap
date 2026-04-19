/**
 * PermissionContext.ts
 *
 * 【在系统流程中的位置】
 * 本文件属于 Claude Code 「工具权限」子系统（toolPermission/）的核心层，
 * 定义了权限决策流程中所有 Handler 共享的「权限上下文对象（PermissionContext）」。
 *
 * PermissionContext 是一个不可变的 context 对象，封装了单次工具调用的全部上下文信息，
 * 以及在权限流程中需要的所有操作方法（日志记录、队列操作、分类器、hooks 等）。
 * 它将与 React 的耦合降到最低——queueOps 是可选的依赖注入接口，
 * 在 REPL 中由 React state setter 实现。
 *
 * 主要导出：
 * - createResolveOnce：竞争安全的 Promise 解决守卫（防止多个竞争者重复 resolve）
 * - createPermissionContext：创建 PermissionContext 实例
 * - createPermissionQueueOps：将 React setToolUseConfirmQueue 包装为 PermissionQueueOps
 */

import { feature } from 'bun:bundle'
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages.mjs'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js'
import { sanitizeToolNameForAnalytics } from 'src/services/analytics/metadata.js'
import type { ToolUseConfirm } from '../../components/permissions/PermissionRequest.js'
import type {
  ToolPermissionContext,
  Tool as ToolType,
  ToolUseContext,
} from '../../Tool.js'
import { awaitClassifierAutoApproval } from '../../tools/BashTool/bashPermissions.js'
import { BASH_TOOL_NAME } from '../../tools/BashTool/toolName.js'
import type { AssistantMessage } from '../../types/message.js'
import type {
  PendingClassifierCheck,
  PermissionAllowDecision,
  PermissionDecisionReason,
  PermissionDenyDecision,
} from '../../types/permissions.js'
import { setClassifierApproval } from '../../utils/classifierApprovals.js'
import { logForDebugging } from '../../utils/debug.js'
import { executePermissionRequestHooks } from '../../utils/hooks.js'
import {
  REJECT_MESSAGE,
  REJECT_MESSAGE_WITH_REASON_PREFIX,
  SUBAGENT_REJECT_MESSAGE,
  SUBAGENT_REJECT_MESSAGE_WITH_REASON_PREFIX,
  withMemoryCorrectionHint,
} from '../../utils/messages.js'
import type { PermissionDecision } from '../../utils/permissions/PermissionResult.js'
import {
  applyPermissionUpdates,
  persistPermissionUpdates,
  supportsPersistence,
} from '../../utils/permissions/PermissionUpdate.js'
import type { PermissionUpdate } from '../../utils/permissions/PermissionUpdateSchema.js'
import {
  logPermissionDecision,
  type PermissionDecisionArgs,
} from './permissionLogging.js'

/** 权限批准来源的联合类型 */
type PermissionApprovalSource =
  | { type: 'hook'; permanent?: boolean }  // PermissionRequest hook 批准
  | { type: 'user'; permanent: boolean }   // 用户手动批准（临时或永久）
  | { type: 'classifier' }                 // 分类器自动批准

/** 权限拒绝来源的联合类型 */
type PermissionRejectionSource =
  | { type: 'hook' }                               // hook 拒绝
  | { type: 'user_abort' }                         // 用户中止（abort signal）
  | { type: 'user_reject'; hasFeedback: boolean }  // 用户手动拒绝

// 通用权限队列操作接口，与 React 解耦，便于测试和非 React 环境使用
type PermissionQueueOps = {
  push(item: ToolUseConfirm): void                              // 向队列压入新项
  remove(toolUseID: string): void                               // 从队列移除指定项
  update(toolUseID: string, patch: Partial<ToolUseConfirm>): void  // 更新队列中的项
}

/**
 * ResolveOnce 类型：竞争安全的 Promise 解决守卫。
 * 在多个异步竞争者（用户交互、hooks、分类器、bridge、channel）同时竞争解决同一
 * Promise 的场景下，确保只有第一个调用 resolve 的竞争者能真正解决 Promise。
 */
type ResolveOnce<T> = {
  resolve(value: T): void     // 解决 Promise（内部去重：只有第一次生效）
  isResolved(): boolean       // 检查是否已被解决（只读，不修改状态）
  /**
   * 原子 check-and-mark（抢占操作）。
   * 返回 true 表示本竞争者赢得了 race（尚未有人 resolve），
   * 返回 false 表示已有其他竞争者赢得，本次调用应放弃。
   * 应在 async 函数的 await 之前调用，关闭 isResolved() 和 resolve() 之间的竞争窗口。
   */
  claim(): boolean
}

/**
 * 创建 ResolveOnce 守卫实例。
 *
 * 内部维护两个 flag：
 * - claimed：是否已有竞争者赢得（通过 claim() 或 resolve() 设置）
 * - delivered：是否已真正调用底层 resolve（防止重复交付）
 *
 * @param resolve 底层 Promise 的 resolve 函数
 */
function createResolveOnce<T>(resolve: (value: T) => void): ResolveOnce<T> {
  let claimed = false   // 已有竞争者赢得（claim 或 resolve 后设置）
  let delivered = false // 已真正交付给底层 resolve
  return {
    resolve(value: T) {
      if (delivered) return  // 防止重复交付
      delivered = true
      claimed = true         // 同时标记 claimed
      resolve(value)
    },
    isResolved() {
      return claimed         // 只读检查，不修改状态
    },
    claim() {
      if (claimed) return false  // 已有竞争者赢得
      claimed = true             // 原子标记（单线程 JS 中安全）
      return true
    },
  }
}

/**
 * 创建权限上下文对象（PermissionContext）。
 *
 * PermissionContext 是一个冻结的对象（Object.freeze），封装了单次工具调用的
 * 完整上下文，以及在权限决策流程中需要的所有操作方法：
 *
 * - logDecision / logCancelled：记录权限决策到分析日志
 * - persistPermissions：持久化权限更新到配置文件
 * - resolveIfAborted：若已中止则立即解决 Promise（防止挂起）
 * - cancelAndAbort：构建拒绝决策并触发 abort signal
 * - tryClassifier：bash 分类器自动批准（BASH_CLASSIFIER feature 下可用）
 * - runHooks：执行 PermissionRequest hooks
 * - buildAllow / buildDeny：构建允许/拒绝决策对象
 * - handleUserAllow / handleHookAllow：处理用户/hook 批准并持久化权限
 * - pushToQueue / removeFromQueue / updateQueueItem：操作权限确认队列
 */
function createPermissionContext(
  tool: ToolType,
  input: Record<string, unknown>,
  toolUseContext: ToolUseContext,
  assistantMessage: AssistantMessage,
  toolUseID: string,
  setToolPermissionContext: (context: ToolPermissionContext) => void,
  queueOps?: PermissionQueueOps,
) {
  // 从 assistantMessage 提取消息 ID（用于分析日志）
  const messageId = assistantMessage.message.id
  const ctx = {
    tool,
    input,
    toolUseContext,
    assistantMessage,
    messageId,
    toolUseID,
    /**
     * 记录权限决策到分析日志（approve/reject 均通过此方法）。
     * opts.input 用于覆盖记录的输入（如用户修改了输入后使用修改版本）。
     * opts.permissionPromptStartTimeMs 用于计算用户等待时长。
     */
    logDecision(
      args: PermissionDecisionArgs,
      opts?: {
        input?: Record<string, unknown>
        permissionPromptStartTimeMs?: number
      },
    ) {
      logPermissionDecision(
        {
          tool,
          input: opts?.input ?? input,
          toolUseContext,
          messageId,
          toolUseID,
        },
        args,
        opts?.permissionPromptStartTimeMs,
      )
    },
    /** 记录工具调用被取消事件（触发 abort 时） */
    logCancelled() {
      logEvent('tengu_tool_use_cancelled', {
        messageID:
          messageId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        toolName: sanitizeToolNameForAnalytics(tool.name),
      })
    },
    /**
     * 持久化权限更新到设置文件，并更新应用状态中的权限上下文。
     * 返回是否有任何更新具有持久化存储（区别于仅内存更新）。
     */
    async persistPermissions(updates: PermissionUpdate[]) {
      if (updates.length === 0) return false
      persistPermissionUpdates(updates)
      const appState = toolUseContext.getAppState()
      setToolPermissionContext(
        applyPermissionUpdates(appState.toolPermissionContext, updates),
      )
      return updates.some(update => supportsPersistence(update.destination))
    },
    /**
     * 若 abort signal 已触发，立即以取消决策解决 Promise，防止挂起。
     * 返回 true 表示已处理（调用方应提前返回）。
     */
    resolveIfAborted(resolve: (decision: PermissionDecision) => void) {
      if (!toolUseContext.abortController.signal.aborted) return false
      this.logCancelled()
      resolve(this.cancelAndAbort(undefined, true))
      return true
    },
    /**
     * 构建拒绝决策并（在适当条件下）触发 abort signal。
     *
     * 拒绝消息根据场景选择：
     * - 子 Agent（agentId 存在）：使用 SUBAGENT_REJECT_MESSAGE 系列
     * - 主 Agent：使用 REJECT_MESSAGE 系列，并附加内存修正提示
     *
     * abort 触发条件：明确中止（isAbort=true）或无反馈且非子 Agent 时。
     */
    cancelAndAbort(
      feedback?: string,
      isAbort?: boolean,
      contentBlocks?: ContentBlockParam[],
    ): PermissionDecision {
      const sub = !!toolUseContext.agentId  // 是否为子 Agent
      const baseMessage = feedback
        ? `${sub ? SUBAGENT_REJECT_MESSAGE_WITH_REASON_PREFIX : REJECT_MESSAGE_WITH_REASON_PREFIX}${feedback}`
        : sub
          ? SUBAGENT_REJECT_MESSAGE
          : REJECT_MESSAGE
      // 主 Agent 的拒绝消息附加内存修正提示（引导 Claude 不重复尝试）
      const message = sub ? baseMessage : withMemoryCorrectionHint(baseMessage)
      if (isAbort || (!feedback && !contentBlocks?.length && !sub)) {
        logForDebugging(
          `Aborting: tool=${tool.name} isAbort=${isAbort} hasFeedback=${!!feedback} isSubagent=${sub}`,
        )
        toolUseContext.abortController.abort()
      }
      return { behavior: 'ask', message, contentBlocks }
    },
    // ── 分类器自动批准（仅在 BASH_CLASSIFIER feature 开启时注入）──────────
    ...(feature('BASH_CLASSIFIER')
      ? {
          /**
           * 尝试通过 bash 分类器自动批准。
           * 仅对 bash 工具有效，非 bash 工具或无 pendingClassifierCheck 时返回 null。
           * 分类器批准时，记录日志并构建允许决策。
           */
          async tryClassifier(
            pendingClassifierCheck: PendingClassifierCheck | undefined,
            updatedInput: Record<string, unknown> | undefined,
          ): Promise<PermissionDecision | null> {
            if (tool.name !== BASH_TOOL_NAME || !pendingClassifierCheck) {
              return null  // 仅对 bash 工具有效
            }
            const classifierDecision = await awaitClassifierAutoApproval(
              pendingClassifierCheck,
              toolUseContext.abortController.signal,
              toolUseContext.options.isNonInteractiveSession,
            )
            if (!classifierDecision) {
              return null  // 分类器未批准
            }
            // TRANSCRIPT_CLASSIFIER：记录匹配的提示词规则标签
            if (
              feature('TRANSCRIPT_CLASSIFIER') &&
              classifierDecision.type === 'classifier'
            ) {
              const matchedRule = classifierDecision.reason.match(
                /^Allowed by prompt rule: "(.+)"$/,
              )?.[1]
              if (matchedRule) {
                setClassifierApproval(toolUseID, matchedRule)
              }
            }
            logPermissionDecision(
              { tool, input, toolUseContext, messageId, toolUseID },
              { decision: 'accept', source: { type: 'classifier' } },
              undefined,
            )
            return {
              behavior: 'allow' as const,
              updatedInput: updatedInput ?? input,
              userModified: false,
              decisionReason: classifierDecision,
            }
          },
        }
      : {}),
    /**
     * 执行 PermissionRequest hooks，返回第一个有效决策。
     * 使用 async generator（for await）流式处理 hook 结果，
     * 允许 allow/deny 决策立即返回而无需等待所有 hook 完成。
     */
    async runHooks(
      permissionMode: string | undefined,
      suggestions: PermissionUpdate[] | undefined,
      updatedInput?: Record<string, unknown>,
      permissionPromptStartTimeMs?: number,
    ): Promise<PermissionDecision | null> {
      for await (const hookResult of executePermissionRequestHooks(
        tool.name,
        toolUseID,
        input,
        toolUseContext,
        permissionMode,
        suggestions,
        toolUseContext.abortController.signal,
      )) {
        if (hookResult.permissionRequestResult) {
          const decision = hookResult.permissionRequestResult
          if (decision.behavior === 'allow') {
            // hook 批准：使用 hook 返回的输入（优先级：hook > updatedInput > 原始 input）
            const finalInput = decision.updatedInput ?? updatedInput ?? input
            return await this.handleHookAllow(
              finalInput,
              decision.updatedPermissions ?? [],
              permissionPromptStartTimeMs,
            )
          } else if (decision.behavior === 'deny') {
            // hook 拒绝：记录日志，若 interrupt=true 则触发 abort
            this.logDecision(
              { decision: 'reject', source: { type: 'hook' } },
              { permissionPromptStartTimeMs },
            )
            if (decision.interrupt) {
              logForDebugging(
                `Hook interrupt: tool=${tool.name} hookMessage=${decision.message}`,
              )
              toolUseContext.abortController.abort()
            }
            return this.buildDeny(
              decision.message || 'Permission denied by hook',
              {
                type: 'hook',
                hookName: 'PermissionRequest',
                reason: decision.message,
              },
            )
          }
        }
      }
      return null  // 所有 hook 均无决策
    },
    /**
     * 构建允许决策对象。
     * opts 支持：userModified（用户是否修改了输入）、decisionReason（决策原因）、
     * acceptFeedback（用户反馈文本）、contentBlocks（富文本内容块）。
     */
    buildAllow(
      updatedInput: Record<string, unknown>,
      opts?: {
        userModified?: boolean
        decisionReason?: PermissionDecisionReason
        acceptFeedback?: string
        contentBlocks?: ContentBlockParam[]
      },
    ): PermissionAllowDecision {
      return {
        behavior: 'allow' as const,
        updatedInput,
        userModified: opts?.userModified ?? false,
        ...(opts?.decisionReason && { decisionReason: opts.decisionReason }),
        ...(opts?.acceptFeedback && { acceptFeedback: opts.acceptFeedback }),
        ...(opts?.contentBlocks &&
          opts.contentBlocks.length > 0 && {
            contentBlocks: opts.contentBlocks,
          }),
      }
    },
    /** 构建拒绝决策对象（带决策原因） */
    buildDeny(
      message: string,
      decisionReason: PermissionDecisionReason,
    ): PermissionDenyDecision {
      return { behavior: 'deny' as const, message, decisionReason }
    },
    /**
     * 处理用户手动批准：持久化权限更新，记录决策日志，构建允许决策。
     * 检测用户是否修改了输入（通过 tool.inputsEquivalent 比较）。
     */
    async handleUserAllow(
      updatedInput: Record<string, unknown>,
      permissionUpdates: PermissionUpdate[],
      feedback?: string,
      permissionPromptStartTimeMs?: number,
      contentBlocks?: ContentBlockParam[],
      decisionReason?: PermissionDecisionReason,
    ): Promise<PermissionAllowDecision> {
      const acceptedPermanentUpdates =
        await this.persistPermissions(permissionUpdates)
      this.logDecision(
        {
          decision: 'accept',
          source: { type: 'user', permanent: acceptedPermanentUpdates },
        },
        { input: updatedInput, permissionPromptStartTimeMs },
      )
      // 通过 inputsEquivalent 判断用户是否修改了输入
      const userModified = tool.inputsEquivalent
        ? !tool.inputsEquivalent(input, updatedInput)
        : false
      const trimmedFeedback = feedback?.trim()
      return this.buildAllow(updatedInput, {
        userModified,
        decisionReason,
        acceptFeedback: trimmedFeedback || undefined,
        contentBlocks,
      })
    },
    /**
     * 处理 hook 批准：持久化权限更新，记录决策日志，构建允许决策。
     * 决策原因固定为 { type: 'hook', hookName: 'PermissionRequest' }。
     */
    async handleHookAllow(
      finalInput: Record<string, unknown>,
      permissionUpdates: PermissionUpdate[],
      permissionPromptStartTimeMs?: number,
    ): Promise<PermissionAllowDecision> {
      const acceptedPermanentUpdates =
        await this.persistPermissions(permissionUpdates)
      this.logDecision(
        {
          decision: 'accept',
          source: { type: 'hook', permanent: acceptedPermanentUpdates },
        },
        { input: finalInput, permissionPromptStartTimeMs },
      )
      return this.buildAllow(finalInput, {
        decisionReason: { type: 'hook', hookName: 'PermissionRequest' },
      })
    },
    /** 将权限确认项压入队列（触发 UI 渲染对话框） */
    pushToQueue(item: ToolUseConfirm) {
      queueOps?.push(item)
    },
    /** 从权限队列移除当前工具调用的确认项 */
    removeFromQueue() {
      queueOps?.remove(toolUseID)
    },
    /** 更新权限队列中当前确认项的部分字段（如 classifierCheckInProgress） */
    updateQueueItem(patch: Partial<ToolUseConfirm>) {
      queueOps?.update(toolUseID, patch)
    },
  }
  return Object.freeze(ctx)  // 冻结对象，防止意外修改
}

/** PermissionContext 类型（由 createPermissionContext 的返回值推断） */
type PermissionContext = ReturnType<typeof createPermissionContext>

/**
 * 将 React 的 setToolUseConfirmQueue 包装为通用的 PermissionQueueOps 接口。
 * 这是 React 和通用权限上下文之间的桥接层。
 *
 * @param setToolUseConfirmQueue React 的状态 setter（来自 useState 或 useReducer）
 */
function createPermissionQueueOps(
  setToolUseConfirmQueue: React.Dispatch<
    React.SetStateAction<ToolUseConfirm[]>
  >,
): PermissionQueueOps {
  return {
    /** 向队列末尾添加新的确认项 */
    push(item: ToolUseConfirm) {
      setToolUseConfirmQueue(queue => [...queue, item])
    },
    /** 按 toolUseID 从队列中过滤移除指定项 */
    remove(toolUseID: string) {
      setToolUseConfirmQueue(queue =>
        queue.filter(item => item.toolUseID !== toolUseID),
      )
    },
    /** 按 toolUseID 查找并更新队列中的指定项（浅合并 patch） */
    update(toolUseID: string, patch: Partial<ToolUseConfirm>) {
      setToolUseConfirmQueue(queue =>
        queue.map(item =>
          item.toolUseID === toolUseID ? { ...item, ...patch } : item,
        ),
      )
    },
  }
}

export { createPermissionContext, createPermissionQueueOps, createResolveOnce }
export type {
  PermissionContext,
  PermissionApprovalSource,
  PermissionQueueOps,
  PermissionRejectionSource,
  ResolveOnce,
}
