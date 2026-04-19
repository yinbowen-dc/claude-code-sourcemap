/**
 * interactiveHandler.ts
 *
 * 【在系统流程中的位置】
 * 本文件属于 Claude Code 「工具权限」子系统（toolPermission/handlers/），
 * 负责处理「主 Agent（Leader）交互式」权限决策流程——即当自动化检查无法解决权限时，
 * 需要向用户展示确认对话框的场景。
 *
 * 本文件是权限系统中最复杂的 Handler，它同时管理多个「竞争者」（Racer）：
 *   Race 1：用户在本地 UI 对话框中点击允许/拒绝
 *   Race 2：PermissionRequest hooks 在后台异步执行并返回决策
 *   Race 3：Bash 分类器（BASH_CLASSIFIER）在后台推理并自动批准
 *   Race 4：Bridge 权限响应（CCR / claude.ai 远程批准）
 *   Race 5：Channel 权限中继（Telegram、iMessage 等 MCP 渠道批准）
 *
 * 使用 createResolveOnce / claim() 防止多个竞争者同时 resolve，
 * 确保 Promise 只被解决一次。
 */

import { feature } from 'bun:bundle'
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages.mjs'
import { randomUUID } from 'crypto'
import { logForDebugging } from 'src/utils/debug.js'
import { getAllowedChannels } from '../../../bootstrap/state.js'
import type { BridgePermissionCallbacks } from '../../../bridge/bridgePermissionCallbacks.js'
import { getTerminalFocused } from '../../../ink/terminal-focus-state.js'
import {
  CHANNEL_PERMISSION_REQUEST_METHOD,
  type ChannelPermissionRequestParams,
  findChannelEntry,
} from '../../../services/mcp/channelNotification.js'
import type { ChannelPermissionCallbacks } from '../../../services/mcp/channelPermissions.js'
import {
  filterPermissionRelayClients,
  shortRequestId,
  truncateForPreview,
} from '../../../services/mcp/channelPermissions.js'
import { executeAsyncClassifierCheck } from '../../../tools/BashTool/bashPermissions.js'
import { BASH_TOOL_NAME } from '../../../tools/BashTool/toolName.js'
import {
  clearClassifierChecking,
  setClassifierApproval,
  setClassifierChecking,
  setYoloClassifierApproval,
} from '../../../utils/classifierApprovals.js'
import { errorMessage } from '../../../utils/errors.js'
import type { PermissionDecision } from '../../../utils/permissions/PermissionResult.js'
import type { PermissionUpdate } from '../../../utils/permissions/PermissionUpdateSchema.js'
import { hasPermissionsToUseTool } from '../../../utils/permissions/permissions.js'
import type { PermissionContext } from '../PermissionContext.js'
import { createResolveOnce } from '../PermissionContext.js'

/** 交互式权限处理所需的入参 */
type InteractivePermissionParams = {
  ctx: PermissionContext                              // 工具权限上下文
  description: string                                // 工具调用的人类可读描述
  result: PermissionDecision & { behavior: 'ask' }   // 初始权限决策（需要询问用户）
  awaitAutomatedChecksBeforeDialog: boolean | undefined  // true = coordinator 已预执行 hooks
  bridgeCallbacks?: BridgePermissionCallbacks         // CCR/claude.ai 远程权限回调
  channelCallbacks?: ChannelPermissionCallbacks       // Telegram/iMessage 渠道权限回调
}

/**
 * 处理主 Agent 的交互式权限流程。
 *
 * 核心逻辑：
 * 1. 将 ToolUseConfirm 项目压入权限队列，触发 UI 渲染对话框；
 * 2. 注册多个竞争者的回调（onAbort / onAllow / onReject / recheckPermission / onUserInteraction）；
 * 3. 若 awaitAutomatedChecksBeforeDialog 为 false，异步启动 hooks 和 classifier；
 * 4. 若 bridgeCallbacks 存在，向 CCR 发送权限请求；
 * 5. 若启用了 KAIROS/channel，向 MCP 渠道发送权限通知；
 * 6. 任意竞争者通过 claim() 赢得 race 后，调用 resolveOnce 解决外层 Promise。
 *
 * 本函数**不返回 Promise**——它通过传入的 resolve 回调异步解决外层 Promise。
 */
function handleInteractivePermission(
  params: InteractivePermissionParams,
  resolve: (decision: PermissionDecision) => void,
): void {
  const {
    ctx,
    description,
    result,
    awaitAutomatedChecksBeforeDialog,
    bridgeCallbacks,
    channelCallbacks,
  } = params

  // 创建 resolveOnce 守卫，确保 Promise 只被解决一次（防止多个竞争者同时 resolve）
  const { resolve: resolveOnce, isResolved, claim } = createResolveOnce(resolve)
  // 标记用户是否已开始交互（交互后禁止 classifier 自动批准）
  let userInteracted = false
  // 分类器自动批准后的「✓ 展示」计时器
  let checkmarkTransitionTimer: ReturnType<typeof setTimeout> | undefined
  // 提升作用域，以便 onDismissCheckmark (Esc 关闭 ✓) 时也能移除 abort 监听
  let checkmarkAbortHandler: (() => void) | undefined
  // Bridge 请求唯一 ID（CCR/claude.ai 远程批准用）
  const bridgeRequestId = bridgeCallbacks ? randomUUID() : undefined
  // Channel 权限中继的取消订阅函数（提升作用域供其他竞争者赢得时清理）
  let channelUnsubscribe: (() => void) | undefined

  // 记录权限对话框开始时间（用于计算用户等待时长指标）
  const permissionPromptStartTimeMs = Date.now()
  // 优先使用 hook 修改后的输入，其次用原始输入
  const displayInput = result.updatedInput ?? ctx.input

  /** 清除 UI 上的「分类器检查中」指示器 */
  function clearClassifierIndicator(): void {
    if (feature('BASH_CLASSIFIER')) {
      ctx.updateQueueItem({ classifierCheckInProgress: false })
    }
  }

  // ── 将权限确认项压入队列，触发 UI 渲染对话框 ──────────────────────────────
  ctx.pushToQueue({
    assistantMessage: ctx.assistantMessage,
    tool: ctx.tool,
    description,
    input: displayInput,
    toolUseContext: ctx.toolUseContext,
    toolUseID: ctx.toolUseID,
    permissionResult: result,
    permissionPromptStartTimeMs,
    // 仅在 BASH_CLASSIFIER 启用且尚未等待自动化检查时，显示「检查中」指示器
    ...(feature('BASH_CLASSIFIER')
      ? {
          classifierCheckInProgress:
            !!result.pendingClassifierCheck &&
            !awaitAutomatedChecksBeforeDialog,
        }
      : {}),
    onUserInteraction() {
      // 用户开始与权限对话框交互时（方向键、Tab、输入反馈等）触发
      // 隐藏分类器指示器（用户主动介入后，自动批准不再有意义）
      //
      // 宽限期（200ms）：忽略对话框刚显示时的误触键，避免过早取消分类器
      const GRACE_PERIOD_MS = 200
      if (Date.now() - permissionPromptStartTimeMs < GRACE_PERIOD_MS) {
        return
      }
      userInteracted = true
      clearClassifierChecking(ctx.toolUseID)
      clearClassifierIndicator()
    },
    onDismissCheckmark() {
      // 用户在分类器「✓」展示窗口内按 Esc 时，立即关闭对话框
      if (checkmarkTransitionTimer) {
        clearTimeout(checkmarkTransitionTimer)
        checkmarkTransitionTimer = undefined
        if (checkmarkAbortHandler) {
          ctx.toolUseContext.abortController.signal.removeEventListener(
            'abort',
            checkmarkAbortHandler,
          )
          checkmarkAbortHandler = undefined
        }
        ctx.removeFromQueue()
      }
    },
    onAbort() {
      // 用户中止（abort signal 触发）
      if (!claim()) return
      // 通知 bridge 拒绝并取消请求
      if (bridgeCallbacks && bridgeRequestId) {
        bridgeCallbacks.sendResponse(bridgeRequestId, {
          behavior: 'deny',
          message: 'User aborted',
        })
        bridgeCallbacks.cancelRequest(bridgeRequestId)
      }
      channelUnsubscribe?.()
      ctx.logCancelled()
      ctx.logDecision(
        { decision: 'reject', source: { type: 'user_abort' } },
        { permissionPromptStartTimeMs },
      )
      resolveOnce(ctx.cancelAndAbort(undefined, true))
    },
    async onAllow(
      updatedInput,
      permissionUpdates: PermissionUpdate[],
      feedback?: string,
      contentBlocks?: ContentBlockParam[],
    ) {
      if (!claim()) return // await 前原子 check-and-mark，防止竞争窗口重复 resolve

      // 通知 bridge 允许并传递修改后的权限
      if (bridgeCallbacks && bridgeRequestId) {
        bridgeCallbacks.sendResponse(bridgeRequestId, {
          behavior: 'allow',
          updatedInput,
          updatedPermissions: permissionUpdates,
        })
        bridgeCallbacks.cancelRequest(bridgeRequestId)
      }
      channelUnsubscribe?.()

      resolveOnce(
        await ctx.handleUserAllow(
          updatedInput,
          permissionUpdates,
          feedback,
          permissionPromptStartTimeMs,
          contentBlocks,
          result.decisionReason,
        ),
      )
    },
    onReject(feedback?: string, contentBlocks?: ContentBlockParam[]) {
      if (!claim()) return

      // 通知 bridge 拒绝
      if (bridgeCallbacks && bridgeRequestId) {
        bridgeCallbacks.sendResponse(bridgeRequestId, {
          behavior: 'deny',
          message: feedback ?? 'User denied permission',
        })
        bridgeCallbacks.cancelRequest(bridgeRequestId)
      }
      channelUnsubscribe?.()

      ctx.logDecision(
        {
          decision: 'reject',
          source: { type: 'user_reject', hasFeedback: !!feedback },
        },
        { permissionPromptStartTimeMs },
      )
      resolveOnce(ctx.cancelAndAbort(feedback, undefined, contentBlocks))
    },
    async recheckPermission() {
      // CCR 触发模式切换后，重新检查权限，若已满足则直接允许（无需用户操作）
      if (isResolved()) return
      const freshResult = await hasPermissionsToUseTool(
        ctx.tool,
        ctx.input,
        ctx.toolUseContext,
        ctx.assistantMessage,
        ctx.toolUseID,
      )
      if (freshResult.behavior === 'allow') {
        // 使用 claim()（原子检查），而非 isResolved()——
        // hasPermissionsToUseTool 异步等待期间，CCR 可能已经响应。
        // cancelRequest 告知 CCR 关闭其提示框，避免 web UI 显示过时对话框。
        if (!claim()) return
        if (bridgeCallbacks && bridgeRequestId) {
          bridgeCallbacks.cancelRequest(bridgeRequestId)
        }
        channelUnsubscribe?.()
        ctx.removeFromQueue()
        ctx.logDecision({ decision: 'accept', source: 'config' })
        resolveOnce(ctx.buildAllow(freshResult.updatedInput ?? ctx.input))
      }
    },
  })

  // ── Race 4：Bridge 权限响应（CCR / claude.ai 远程批准）────────────────────
  // bridge 连接时，向 CCR 发送权限请求，订阅响应，与本地对话框竞争。
  // 任意一侧（CLI 或 CCR）首先响应者通过 claim() 赢得竞争。
  //
  // 所有工具均被转发——CCR 的通用 allow/deny 弹窗可处理任意工具。
  // 对于有专属渲染器的工具（如 plan edit），CCR 可返回 updatedInput。
  if (bridgeCallbacks && bridgeRequestId) {
    bridgeCallbacks.sendRequest(
      bridgeRequestId,
      ctx.tool.name,
      displayInput,
      ctx.toolUseID,
      description,
      result.suggestions,
      result.blockedPath,
    )

    const signal = ctx.toolUseContext.abortController.signal
    const unsubscribe = bridgeCallbacks.onResponse(
      bridgeRequestId,
      response => {
        if (!claim()) return // 本地用户/hook/分类器已响应，忽略
        signal.removeEventListener('abort', unsubscribe)
        clearClassifierChecking(ctx.toolUseID)
        clearClassifierIndicator()
        ctx.removeFromQueue()
        channelUnsubscribe?.()

        if (response.behavior === 'allow') {
          // Bridge 批准：持久化权限更新（若有），记录决策，构建允许结果
          if (response.updatedPermissions?.length) {
            void ctx.persistPermissions(response.updatedPermissions)
          }
          ctx.logDecision(
            {
              decision: 'accept',
              source: {
                type: 'user',
                permanent: !!response.updatedPermissions?.length,
              },
            },
            { permissionPromptStartTimeMs },
          )
          resolveOnce(ctx.buildAllow(response.updatedInput ?? displayInput))
        } else {
          // Bridge 拒绝
          ctx.logDecision(
            {
              decision: 'reject',
              source: {
                type: 'user_reject',
                hasFeedback: !!response.message,
              },
            },
            { permissionPromptStartTimeMs },
          )
          resolveOnce(ctx.cancelAndAbort(response.message))
        }
      },
    )

    // abort 信号触发时，清理 bridge 订阅
    signal.addEventListener('abort', unsubscribe, { once: true })
  }

  // ── Race 5：Channel 权限中继（Telegram、iMessage 等 MCP 渠道）──────────────
  // 向所有已启用的渠道客户端发送权限通知，在本地/bridge/hooks/classifier 基础上再竞争一次。
  // 入站的 "yes abc123" 在 useManageMCPConnections.ts 的通知处理器中被拦截，
  // 在入队前直接消费，不会作为对话轮次传给 Claude。
  //
  // 发送是 fire-and-forget：若渠道发送失败，订阅永不触发，其他竞争者赢得竞争。
  // 本地对话框始终作为兜底。
  if (
    (feature('KAIROS') || feature('KAIROS_CHANNELS')) &&
    channelCallbacks &&
    !ctx.tool.requiresUserInteraction?.()  // 需要用户交互的工具不走渠道
  ) {
    const channelRequestId = shortRequestId(ctx.toolUseID)
    const allowedChannels = getAllowedChannels()
    // 筛选出已配置权限中继的 MCP 渠道客户端
    const channelClients = filterPermissionRelayClients(
      ctx.toolUseContext.getAppState().mcp.clients,
      name => findChannelEntry(name, allowedChannels) !== undefined,
    )

    if (channelClients.length > 0) {
      // 构建结构化的权限请求参数（服务端负责按各平台格式渲染消息）
      const params: ChannelPermissionRequestParams = {
        request_id: channelRequestId,
        tool_name: ctx.tool.name,
        description,
        input_preview: truncateForPreview(displayInput),
      }

      // 向所有渠道客户端发送权限请求通知（fire-and-forget）
      for (const client of channelClients) {
        if (client.type !== 'connected') continue // 类型收窄确保安全
        void client.client
          .notification({
            method: CHANNEL_PERMISSION_REQUEST_METHOD,
            params,
          })
          .catch(e => {
            logForDebugging(
              `Channel permission_request failed for ${client.name}: ${errorMessage(e)}`,
              { level: 'error' },
            )
          })
      }

      const channelSignal = ctx.toolUseContext.abortController.signal
      // 包装：确保每个调用点既删除 Map 条目，又移除 abort 监听
      // （之前只有 Map.delete，abort 监听一直存活到会话结束）
      const mapUnsub = channelCallbacks.onResponse(
        channelRequestId,
        response => {
          if (!claim()) return // 另一竞争者已赢得
          channelUnsubscribe?.() // 同时：Map 删除 + 移除监听
          clearClassifierChecking(ctx.toolUseID)
          clearClassifierIndicator()
          ctx.removeFromQueue()
          // 通知 bridge 也结束（它是另一个远程竞争者）
          if (bridgeCallbacks && bridgeRequestId) {
            bridgeCallbacks.cancelRequest(bridgeRequestId)
          }

          if (response.behavior === 'allow') {
            ctx.logDecision(
              {
                decision: 'accept',
                source: { type: 'user', permanent: false },
              },
              { permissionPromptStartTimeMs },
            )
            resolveOnce(ctx.buildAllow(displayInput))
          } else {
            ctx.logDecision(
              {
                decision: 'reject',
                source: { type: 'user_reject', hasFeedback: false },
              },
              { permissionPromptStartTimeMs },
            )
            resolveOnce(
              ctx.cancelAndAbort(`Denied via channel ${response.fromServer}`),
            )
          }
        },
      )
      channelUnsubscribe = () => {
        mapUnsub()
        channelSignal.removeEventListener('abort', channelUnsubscribe!)
      }

      channelSignal.addEventListener('abort', channelUnsubscribe, {
        once: true,
      })
    }
  }

  // ── Race 2：PermissionRequest hooks 异步执行 ───────────────────────────────
  // 若 coordinator 分支已预先顺序执行过 hooks，则跳过（awaitAutomatedChecksBeforeDialog = true）
  if (!awaitAutomatedChecksBeforeDialog) {
    // hooks 在后台异步执行，若 hook 在用户响应前返回决策，直接应用
    void (async () => {
      if (isResolved()) return
      const currentAppState = ctx.toolUseContext.getAppState()
      const hookDecision = await ctx.runHooks(
        currentAppState.toolPermissionContext.mode,
        result.suggestions,
        result.updatedInput,
        permissionPromptStartTimeMs,
      )
      if (!hookDecision || !claim()) return
      // hook 赢得竞争：通知 bridge 取消，清理渠道，从队列移除
      if (bridgeCallbacks && bridgeRequestId) {
        bridgeCallbacks.cancelRequest(bridgeRequestId)
      }
      channelUnsubscribe?.()
      ctx.removeFromQueue()
      resolveOnce(hookDecision)
    })()
  }

  // ── Race 3：Bash 分类器异步检查 ───────────────────────────────────────────
  // 仅在 BASH_CLASSIFIER 启用、有 pendingClassifierCheck 且是 bash 工具时执行
  if (
    feature('BASH_CLASSIFIER') &&
    result.pendingClassifierCheck &&
    ctx.tool.name === BASH_TOOL_NAME &&
    !awaitAutomatedChecksBeforeDialog  // coordinator 已预执行时跳过
  ) {
    // 设置「分类器检查中」指示器（不在 toolExecution.ts 设置，
    // 以避免通过前缀规则立即允许的命令闪烁显示指示器）
    setClassifierChecking(ctx.toolUseID)
    void executeAsyncClassifierCheck(
      result.pendingClassifierCheck,
      ctx.toolUseContext.abortController.signal,
      ctx.toolUseContext.options.isNonInteractiveSession,
      {
        // 检查是否还需要继续（已 resolved 或用户已交互则停止）
        shouldContinue: () => !isResolved() && !userInteracted,
        onComplete: () => {
          // 检查完成（无论批准或拒绝）时清除指示器
          clearClassifierChecking(ctx.toolUseID)
          clearClassifierIndicator()
        },
        onAllow: decisionReason => {
          if (!claim()) return
          // 分类器赢得竞争：通知 bridge 取消，清理渠道
          if (bridgeCallbacks && bridgeRequestId) {
            bridgeCallbacks.cancelRequest(bridgeRequestId)
          }
          channelUnsubscribe?.()
          clearClassifierChecking(ctx.toolUseID)

          // 从决策原因中提取匹配的提示词规则（用于展示）
          const matchedRule =
            decisionReason.type === 'classifier'
              ? (decisionReason.reason.match(
                  /^Allowed by prompt rule: "(.+)"$/,
                )?.[1] ?? decisionReason.reason)
              : undefined

          // 显示「自动批准」过渡状态（✓ + 暗色选项）
          if (feature('TRANSCRIPT_CLASSIFIER')) {
            ctx.updateQueueItem({
              classifierCheckInProgress: false,
              classifierAutoApproved: true,
              classifierMatchedRule: matchedRule,
            })
          }

          // 设置分类器批准记录（供 TRANSCRIPT_CLASSIFIER 展示规则标签）
          if (
            feature('TRANSCRIPT_CLASSIFIER') &&
            decisionReason.type === 'classifier'
          ) {
            if (decisionReason.classifier === 'auto-mode') {
              setYoloClassifierApproval(ctx.toolUseID, decisionReason.reason)
            } else if (matchedRule) {
              setClassifierApproval(ctx.toolUseID, matchedRule)
            }
          }

          ctx.logDecision(
            { decision: 'accept', source: { type: 'classifier' } },
            { permissionPromptStartTimeMs },
          )
          resolveOnce(ctx.buildAllow(ctx.input, { decisionReason }))

          // 保持 ✓ 对话框可见一段时间后再关闭
          // 终端聚焦时显示 3s（用户能看到），失焦时显示 1s
          // 用户可通过 Esc 提前关闭（onDismissCheckmark）
          const signal = ctx.toolUseContext.abortController.signal
          checkmarkAbortHandler = () => {
            if (checkmarkTransitionTimer) {
              clearTimeout(checkmarkTransitionTimer)
              checkmarkTransitionTimer = undefined
              // 兄弟 Bash 错误可能触发此处（StreamingToolExecutor 通过 siblingAbortController 级联）
              // 必须关闭 ✓ 对话框，否则会阻塞下一个队列项
              ctx.removeFromQueue()
            }
          }
          const checkmarkMs = getTerminalFocused() ? 3000 : 1000
          checkmarkTransitionTimer = setTimeout(() => {
            checkmarkTransitionTimer = undefined
            if (checkmarkAbortHandler) {
              signal.removeEventListener('abort', checkmarkAbortHandler)
              checkmarkAbortHandler = undefined
            }
            ctx.removeFromQueue()
          }, checkmarkMs)
          signal.addEventListener('abort', checkmarkAbortHandler, {
            once: true,
          })
        },
      },
    ).catch(error => {
      // 记录分类器 API 错误（网络失败、限流、模型问题等），不作为中断事件传播
      logForDebugging(`Async classifier check failed: ${errorMessage(error)}`, {
        level: 'error',
      })
    })
  }
}

// --

export { handleInteractivePermission }
export type { InteractivePermissionParams }
