/**
 * useInboxPoller.ts
 *
 * 【系统流程位置】
 * 本文件处于 Claude Code 多智能体（Swarm）协作架构的核心通信层。
 * 在整个系统中，多个 Agent（Teammate/TeamLead）通过文件系统"邮箱"进行异步消息传递。
 * useInboxPoller 负责定期轮询当前 Agent 的邮箱，将收到的消息分类处理后
 * 提交给 REPL 主循环，是 Swarm 模式下消息驱动任务调度的入口。
 *
 * 【主要功能】
 * 1. 每隔 1 秒轮询邮箱未读消息（teammates 或 team lead）
 * 2. 对消息按类型分类：权限请求/响应、沙箱权限、关机请求/批准、模式变更、计划审批、普通消息
 * 3. 空闲时立即将普通消息提交为新 turn；忙碌时入队 AppState.inbox 等待
 * 4. 会话变为空闲后，自动投递 inbox 中挂起的消息
 * 5. 处理团队成员关机、任务清理、桌面通知等副作用
 */

import { randomUUID } from 'crypto'
import { useCallback, useEffect, useRef } from 'react'
import { useInterval } from 'usehooks-ts'
import type { ToolUseConfirm } from '../components/permissions/PermissionRequest.js'
import { TEAMMATE_MESSAGE_TAG } from '../constants/xml.js'
import { useTerminalNotification } from '../ink/useTerminalNotification.js'
import { sendNotification } from '../services/notifier.js'
import {
  type AppState,
  useAppState,
  useAppStateStore,
  useSetAppState,
} from '../state/AppState.js'
import { findToolByName } from '../Tool.js'
import { isInProcessTeammateTask } from '../tasks/InProcessTeammateTask/types.js'
import { getAllBaseTools } from '../tools.js'
import type { PermissionUpdate } from '../types/permissions.js'
import { logForDebugging } from '../utils/debug.js'
import {
  findInProcessTeammateTaskId,
  handlePlanApprovalResponse,
} from '../utils/inProcessTeammateHelpers.js'
import { createAssistantMessage } from '../utils/messages.js'
import {
  permissionModeFromString,
  toExternalPermissionMode,
} from '../utils/permissions/PermissionMode.js'
import { applyPermissionUpdate } from '../utils/permissions/PermissionUpdate.js'
import { jsonStringify } from '../utils/slowOperations.js'
import { isInsideTmux } from '../utils/swarm/backends/detection.js'
import {
  ensureBackendsRegistered,
  getBackendByType,
} from '../utils/swarm/backends/registry.js'
import type { PaneBackendType } from '../utils/swarm/backends/types.js'
import { TEAM_LEAD_NAME } from '../utils/swarm/constants.js'
import { getLeaderToolUseConfirmQueue } from '../utils/swarm/leaderPermissionBridge.js'
import { sendPermissionResponseViaMailbox } from '../utils/swarm/permissionSync.js'
import {
  removeTeammateFromTeamFile,
  setMemberMode,
} from '../utils/swarm/teamHelpers.js'
import { unassignTeammateTasks } from '../utils/tasks.js'
import {
  getAgentName,
  isPlanModeRequired,
  isTeamLead,
  isTeammate,
} from '../utils/teammate.js'
import { isInProcessTeammate } from '../utils/teammateContext.js'
import {
  isModeSetRequest,
  isPermissionRequest,
  isPermissionResponse,
  isPlanApprovalRequest,
  isPlanApprovalResponse,
  isSandboxPermissionRequest,
  isSandboxPermissionResponse,
  isShutdownApproved,
  isShutdownRequest,
  isTeamPermissionUpdate,
  markMessagesAsRead,
  readUnreadMessages,
  type TeammateMessage,
  writeToMailbox,
} from '../utils/teammateMailbox.js'
import {
  hasPermissionCallback,
  hasSandboxPermissionCallback,
  processMailboxPermissionResponse,
  processSandboxPermissionResponse,
} from './useSwarmPermissionPoller.js'

/**
 * 获取当前 Agent 需要轮询邮箱时使用的名称。
 *
 * 返回规则：
 * - 进程内 Teammate（in-process）返回 undefined：它们有自己独立的
 *   waitForNextPromptOrShutdown() 轮询机制，不应使用 useInboxPoller
 * - 进程级 Teammate 返回其 CLAUDE_CODE_AGENT_NAME 环境变量值
 * - Team Lead 从 teamContext.teammates 映射中查找自身名称
 * - 普通独立会话返回 undefined（不轮询）
 */
function getAgentNameToPoll(appState: AppState): string | undefined {
  // 进程内 Teammate 不应使用 useInboxPoller —— 它们有自己的
  // 轮询机制（inProcessRunner.ts 中的 waitForNextPromptOrShutdown()）。
  // 使用 useInboxPoller 会因共享 React context 和 AppState 导致消息路由问题。
  //
  // 注意：在 Leader 的 REPL 重新渲染时，可能处于进程内 Teammate 的
  // AsyncLocalStorage 上下文中（因为共享了 setAppState），此时返回 undefined
  // 以优雅地跳过轮询，而不是抛出异常（并发执行期间这是正常现象）。
  if (isInProcessTeammate()) {
    return undefined
  }
  // 进程级 Teammate：使用自身的 Agent 名称
  if (isTeammate()) {
    return getAgentName()
  }
  // Team Lead 使用 agent 名称（不是 ID）轮询
  if (isTeamLead(appState.teamContext)) {
    const leadAgentId = appState.teamContext!.leadAgentId
    // 从 teammates 映射中查找 Lead 的名称
    const leadName = appState.teamContext!.teammates[leadAgentId]?.name
    return leadName || 'team-lead'
  }
  return undefined
}

// 邮箱轮询间隔：每 1000ms（1秒）轮询一次
const INBOX_POLL_INTERVAL_MS = 1000

// Hook 入参类型定义
type Props = {
  enabled: boolean                          // 是否启用轮询
  isLoading: boolean                        // 当前会话是否处于加载（忙碌）状态
  focusedInputDialog: string | undefined    // 当前是否有聚焦的输入对话框（忙碌标志）
  // 提交消息回调，成功返回 true，被拒绝（如查询已在运行）返回 false
  // 参数名使用 onSubmitMessage 是为了避免外部构建产物中出现 "teammate" 字符串
  onSubmitMessage: (formatted: string) => boolean
}

/**
 * useInboxPoller：轮询 Teammate 邮箱并将新消息作为 turn 提交。
 *
 * 流程：
 * 1. 每 1 秒读取邮箱未读消息（适用于 Teammate 或 Team Lead）
 * 2. 空闲状态：立即将消息作为新 turn 提交
 * 3. 忙碌状态：将消息加入 AppState.inbox 排队，待 turn 结束后投递
 * 4. 处理各类特殊消息：权限流程、关机流程、模式变更、计划审批等
 */
export function useInboxPoller({
  enabled,
  isLoading,
  focusedInputDialog,
  onSubmitMessage,
}: Props): void {
  // 将回调重命名以在函数内部保持语义清晰
  const onSubmitTeammateMessage = onSubmitMessage
  // 使用 store 而非直接订阅 appState，避免依赖变更导致无限循环
  const store = useAppStateStore()
  const setAppState = useSetAppState()
  // 仅订阅 inbox.messages.length，减少不必要的重渲染
  const inboxMessageCount = useAppState(s => s.inbox.messages.length)
  // 终端通知句柄（用于发送桌面通知）
  const terminal = useTerminalNotification()

  /**
   * poll：核心轮询函数。
   *
   * 流程：
   * 1. 检查启用状态和 Agent 名称
   * 2. 读取未读消息并按类型分类
   * 3. 分别处理：权限请求/响应、沙箱权限、关机、模式变更、计划审批
   * 4. 将普通消息格式化后提交或入队
   * 5. 最后标记消息为已读（确保消息不丢失）
   */
  const poll = useCallback(async () => {
    if (!enabled) return

    // 通过 store.getState() 获取最新状态，避免依赖 appState 对象（防止无限循环）
    const currentAppState = store.getState()
    const agentName = getAgentNameToPoll(currentAppState)
    if (!agentName) return

    // 从文件系统邮箱读取未读消息
    const unread = await readUnreadMessages(
      agentName,
      currentAppState.teamContext?.teamName,
    )

    if (unread.length === 0) return

    logForDebugging(`[InboxPoller] Found ${unread.length} unread message(s)`)

    // 处理计划审批响应：若当前处于 plan 模式且收到 team-lead 的批准，则退出 plan 模式
    // 安全性：只接受来自 team-lead 的批准响应，防止 teammate 伪造审批
    if (isTeammate() && isPlanModeRequired()) {
      for (const msg of unread) {
        const approvalResponse = isPlanApprovalResponse(msg.text)
        // 验证消息来自 team-lead，防止 teammate 伪造批准
        if (approvalResponse && msg.from === 'team-lead') {
          logForDebugging(
            `[InboxPoller] Received plan approval response from team-lead: approved=${approvalResponse.approved}`,
          )
          if (approvalResponse.approved) {
            // 使用 leader 提供的权限模式，否则使用默认值
            const targetMode = approvalResponse.permissionMode ?? 'default'

            // 退出 plan 模式，切换到目标权限模式
            setAppState(prev => ({
              ...prev,
              toolPermissionContext: applyPermissionUpdate(
                prev.toolPermissionContext,
                {
                  type: 'setMode',
                  mode: toExternalPermissionMode(targetMode),
                  destination: 'session',
                },
              ),
            }))
            logForDebugging(
              `[InboxPoller] Plan approved by team lead, exited plan mode to ${targetMode}`,
            )
          } else {
            logForDebugging(
              `[InboxPoller] Plan rejected by team lead: ${approvalResponse.feedback || 'No feedback provided'}`,
            )
          }
        } else if (approvalResponse) {
          // 忽略非 team-lead 来源的计划审批响应
          logForDebugging(
            `[InboxPoller] Ignoring plan approval response from non-team-lead: ${msg.from}`,
          )
        }
      }
    }

    // 标记消息已读的辅助函数。
    // 仅在消息成功投递或可靠入队后调用，防止崩溃时消息永久丢失。
    const markRead = () => {
      void markMessagesAsRead(agentName, currentAppState.teamContext?.teamName)
    }

    // 按消息类型分类到各自的数组
    const permissionRequests: TeammateMessage[] = []       // 权限请求（leader 侧处理）
    const permissionResponses: TeammateMessage[] = []      // 权限响应（worker 侧处理）
    const sandboxPermissionRequests: TeammateMessage[] = [] // 沙箱权限请求
    const sandboxPermissionResponses: TeammateMessage[] = [] // 沙箱权限响应
    const shutdownRequests: TeammateMessage[] = []         // 关机请求
    const shutdownApprovals: TeammateMessage[] = []        // 关机批准
    const teamPermissionUpdates: TeammateMessage[] = []    // 团队权限更新
    const modeSetRequests: TeammateMessage[] = []          // 模式变更请求
    const planApprovalRequests: TeammateMessage[] = []     // 计划审批请求
    const regularMessages: TeammateMessage[] = []          // 普通消息

    // 逐一检测每条消息的类型，分入对应数组
    for (const m of unread) {
      const permReq = isPermissionRequest(m.text)
      const permResp = isPermissionResponse(m.text)
      const sandboxReq = isSandboxPermissionRequest(m.text)
      const sandboxResp = isSandboxPermissionResponse(m.text)
      const shutdownReq = isShutdownRequest(m.text)
      const shutdownApproval = isShutdownApproved(m.text)
      const teamPermUpdate = isTeamPermissionUpdate(m.text)
      const modeSetReq = isModeSetRequest(m.text)
      const planApprovalReq = isPlanApprovalRequest(m.text)

      if (permReq) {
        permissionRequests.push(m)
      } else if (permResp) {
        permissionResponses.push(m)
      } else if (sandboxReq) {
        sandboxPermissionRequests.push(m)
      } else if (sandboxResp) {
        sandboxPermissionResponses.push(m)
      } else if (shutdownReq) {
        shutdownRequests.push(m)
      } else if (shutdownApproval) {
        shutdownApprovals.push(m)
      } else if (teamPermUpdate) {
        teamPermissionUpdates.push(m)
      } else if (modeSetReq) {
        modeSetRequests.push(m)
      } else if (planApprovalReq) {
        planApprovalRequests.push(m)
      } else {
        regularMessages.push(m)
      }
    }

    // ===== 处理权限请求（Leader 侧）=====
    // 将权限请求路由到 ToolUseConfirmQueue，使 tmux worker 获得与
    // in-process teammate 相同的工具专属 UI（BashPermissionRequest、FileEditToolDiff 等）
    if (
      permissionRequests.length > 0 &&
      isTeamLead(currentAppState.teamContext)
    ) {
      logForDebugging(
        `[InboxPoller] Found ${permissionRequests.length} permission request(s)`,
      )

      const setToolUseConfirmQueue = getLeaderToolUseConfirmQueue()
      const teamName = currentAppState.teamContext?.teamName

      for (const m of permissionRequests) {
        const parsed = isPermissionRequest(m.text)
        if (!parsed) continue

        if (setToolUseConfirmQueue) {
          // 通过标准 ToolUseConfirmQueue 路由，使 tmux worker 获得工具专属 UI
          const tool = findToolByName(getAllBaseTools(), parsed.tool_name)
          if (!tool) {
            logForDebugging(
              `[InboxPoller] Unknown tool ${parsed.tool_name}, skipping permission request`,
            )
            continue
          }

          // 构建 ToolUseConfirm 条目，包含 onAllow/onReject/onAbort 回调
          const entry: ToolUseConfirm = {
            assistantMessage: createAssistantMessage({ content: '' }),
            tool,
            description: parsed.description,
            input: parsed.input,
            toolUseContext: {} as ToolUseConfirm['toolUseContext'],
            toolUseID: parsed.tool_use_id,
            permissionResult: {
              behavior: 'ask',
              message: parsed.description,
            },
            permissionPromptStartTimeMs: Date.now(),
            // 在 UI 中显示来自哪个 worker 的请求
            workerBadge: {
              name: parsed.agent_id,
              color: 'cyan',
            },
            onUserInteraction() {
              // tmux worker 无需自动审批分类器，此处为空操作
            },
            onAbort() {
              // 用户中止：通过邮箱发送拒绝响应
              void sendPermissionResponseViaMailbox(
                parsed.agent_id,
                { decision: 'rejected', resolvedBy: 'leader' },
                parsed.request_id,
                teamName,
              )
            },
            onAllow(
              updatedInput: Record<string, unknown>,
              permissionUpdates: PermissionUpdate[],
            ) {
              // 用户批准：通过邮箱发送批准响应（含更新的输入和权限规则）
              void sendPermissionResponseViaMailbox(
                parsed.agent_id,
                {
                  decision: 'approved',
                  resolvedBy: 'leader',
                  updatedInput,
                  permissionUpdates,
                },
                parsed.request_id,
                teamName,
              )
            },
            onReject(feedback?: string) {
              // 用户拒绝：通过邮箱发送拒绝响应（含可选的反馈信息）
              void sendPermissionResponseViaMailbox(
                parsed.agent_id,
                {
                  decision: 'rejected',
                  resolvedBy: 'leader',
                  feedback,
                },
                parsed.request_id,
                teamName,
              )
            },
            async recheckPermission() {
              // tmux worker 的权限状态在 worker 侧，Leader 侧无需重新检查
            },
          }

          // 去重处理：若上次 markMessagesAsRead 失败，同一消息会被重复读取
          // 通过检查 toolUseID 跳过已入队的请求
          setToolUseConfirmQueue(queue => {
            if (queue.some(q => q.toolUseID === parsed.tool_use_id)) {
              return queue
            }
            return [...queue, entry]
          })
        } else {
          logForDebugging(
            `[InboxPoller] ToolUseConfirmQueue unavailable, dropping permission request from ${parsed.agent_id}`,
          )
        }
      }

      // 对第一个权限请求发送桌面通知（仅在空闲且无对话框时）
      const firstParsed = isPermissionRequest(permissionRequests[0]?.text ?? '')
      if (firstParsed && !isLoading && !focusedInputDialog) {
        void sendNotification(
          {
            message: `${firstParsed.agent_id} needs permission for ${firstParsed.tool_name}`,
            notificationType: 'worker_permission_prompt',
          },
          terminal,
        )
      }
    }

    // ===== 处理权限响应（Worker 侧）=====
    // 调用已注册的回调函数处理来自 leader 的权限决定
    if (permissionResponses.length > 0 && isTeammate()) {
      logForDebugging(
        `[InboxPoller] Found ${permissionResponses.length} permission response(s)`,
      )

      for (const m of permissionResponses) {
        const parsed = isPermissionResponse(m.text)
        if (!parsed) continue

        // 检查是否存在对应的权限回调
        if (hasPermissionCallback(parsed.request_id)) {
          logForDebugging(
            `[InboxPoller] Processing permission response for ${parsed.request_id}: ${parsed.subtype}`,
          )

          if (parsed.subtype === 'success') {
            // 批准：传递更新后的输入和权限规则
            processMailboxPermissionResponse({
              requestId: parsed.request_id,
              decision: 'approved',
              updatedInput: parsed.response?.updated_input,
              permissionUpdates: parsed.response?.permission_updates,
            })
          } else {
            // 拒绝：传递反馈信息
            processMailboxPermissionResponse({
              requestId: parsed.request_id,
              decision: 'rejected',
              feedback: parsed.error,
            })
          }
        }
      }
    }

    // ===== 处理沙箱权限请求（Leader 侧）=====
    // 将新的沙箱网络访问请求加入 workerSandboxPermissions 队列
    if (
      sandboxPermissionRequests.length > 0 &&
      isTeamLead(currentAppState.teamContext)
    ) {
      logForDebugging(
        `[InboxPoller] Found ${sandboxPermissionRequests.length} sandbox permission request(s)`,
      )

      const newSandboxRequests: Array<{
        requestId: string
        workerId: string
        workerName: string
        workerColor?: string
        host: string
        createdAt: number
      }> = []

      for (const m of sandboxPermissionRequests) {
        const parsed = isSandboxPermissionRequest(m.text)
        if (!parsed) continue

        // 校验必要字段，防止格式错误的消息导致崩溃
        if (!parsed.hostPattern?.host) {
          logForDebugging(
            `[InboxPoller] Invalid sandbox permission request: missing hostPattern.host`,
          )
          continue
        }

        newSandboxRequests.push({
          requestId: parsed.requestId,
          workerId: parsed.workerId,
          workerName: parsed.workerName,
          workerColor: parsed.workerColor,
          host: parsed.hostPattern.host,
          createdAt: parsed.createdAt,
        })
      }

      if (newSandboxRequests.length > 0) {
        // 将新请求追加到 AppState 中的沙箱权限请求队列
        setAppState(prev => ({
          ...prev,
          workerSandboxPermissions: {
            ...prev.workerSandboxPermissions,
            queue: [
              ...prev.workerSandboxPermissions.queue,
              ...newSandboxRequests,
            ],
          },
        }))

        // 对第一个新请求发送桌面通知
        const firstRequest = newSandboxRequests[0]
        if (firstRequest && !isLoading && !focusedInputDialog) {
          void sendNotification(
            {
              message: `${firstRequest.workerName} needs network access to ${firstRequest.host}`,
              notificationType: 'worker_permission_prompt',
            },
            terminal,
          )
        }
      }
    }

    // ===== 处理沙箱权限响应（Worker 侧）=====
    // 调用已注册的沙箱权限回调，并清除挂起的沙箱请求状态
    if (sandboxPermissionResponses.length > 0 && isTeammate()) {
      logForDebugging(
        `[InboxPoller] Found ${sandboxPermissionResponses.length} sandbox permission response(s)`,
      )

      for (const m of sandboxPermissionResponses) {
        const parsed = isSandboxPermissionResponse(m.text)
        if (!parsed) continue

        // 检查是否存在对应的沙箱权限回调
        if (hasSandboxPermissionCallback(parsed.requestId)) {
          logForDebugging(
            `[InboxPoller] Processing sandbox permission response for ${parsed.requestId}: allow=${parsed.allow}`,
          )

          // 处理沙箱权限响应（调用回调）
          processSandboxPermissionResponse({
            requestId: parsed.requestId,
            host: parsed.host,
            allow: parsed.allow,
          })

          // 清除挂起的沙箱请求指示器
          setAppState(prev => ({
            ...prev,
            pendingSandboxRequest: null,
          }))
        }
      }
    }

    // ===== 处理团队权限更新（Teammate 侧）=====
    // 应用 leader 推送的权限规则到本地 toolPermissionContext
    if (teamPermissionUpdates.length > 0 && isTeammate()) {
      logForDebugging(
        `[InboxPoller] Found ${teamPermissionUpdates.length} team permission update(s)`,
      )

      for (const m of teamPermissionUpdates) {
        const parsed = isTeamPermissionUpdate(m.text)
        if (!parsed) {
          logForDebugging(
            `[InboxPoller] Failed to parse team permission update: ${m.text.substring(0, 100)}`,
          )
          continue
        }

        // 校验必要嵌套字段，防止格式错误消息导致崩溃
        if (
          !parsed.permissionUpdate?.rules ||
          !parsed.permissionUpdate?.behavior
        ) {
          logForDebugging(
            `[InboxPoller] Invalid team permission update: missing permissionUpdate.rules or permissionUpdate.behavior`,
          )
          continue
        }

        // 将权限规则更新应用到 teammate 的上下文中
        logForDebugging(
          `[InboxPoller] Applying team permission update: ${parsed.toolName} allowed in ${parsed.directoryPath}`,
        )
        logForDebugging(
          `[InboxPoller] Permission update rules: ${jsonStringify(parsed.permissionUpdate.rules)}`,
        )

        // 使用 addRules 将新规则追加到 session 级别的权限上下文
        setAppState(prev => {
          const updated = applyPermissionUpdate(prev.toolPermissionContext, {
            type: 'addRules',
            rules: parsed.permissionUpdate.rules,
            behavior: parsed.permissionUpdate.behavior,
            destination: 'session',
          })
          logForDebugging(
            `[InboxPoller] Updated session allow rules: ${jsonStringify(updated.alwaysAllowRules.session)}`,
          )
          return {
            ...prev,
            toolPermissionContext: updated,
          }
        })
      }
    }

    // ===== 处理模式变更请求（Teammate 侧）=====
    // 仅接受来自 team-lead 的模式变更指令
    if (modeSetRequests.length > 0 && isTeammate()) {
      logForDebugging(
        `[InboxPoller] Found ${modeSetRequests.length} mode set request(s)`,
      )

      for (const m of modeSetRequests) {
        // 安全校验：只接受来自 team-lead 的模式变更
        if (m.from !== 'team-lead') {
          logForDebugging(
            `[InboxPoller] Ignoring mode set request from non-team-lead: ${m.from}`,
          )
          continue
        }

        const parsed = isModeSetRequest(m.text)
        if (!parsed) {
          logForDebugging(
            `[InboxPoller] Failed to parse mode set request: ${m.text.substring(0, 100)}`,
          )
          continue
        }

        // 解析目标权限模式
        const targetMode = permissionModeFromString(parsed.mode)
        logForDebugging(
          `[InboxPoller] Applying mode change from team-lead: ${targetMode}`,
        )

        // 更新本地权限上下文为新模式
        setAppState(prev => ({
          ...prev,
          toolPermissionContext: applyPermissionUpdate(
            prev.toolPermissionContext,
            {
              type: 'setMode',
              mode: toExternalPermissionMode(targetMode),
              destination: 'session',
            },
          ),
        }))

        // 更新 config.json，使 team lead 可以看到新模式
        const teamName = currentAppState.teamContext?.teamName
        const agentName = getAgentName()
        if (teamName && agentName) {
          setMemberMode(teamName, agentName, targetMode)
        }
      }
    }

    // ===== 处理计划审批请求（Leader 侧）=====
    // Leader 自动批准 teammate 发来的计划，并将批准响应写入 teammate 的邮箱
    if (
      planApprovalRequests.length > 0 &&
      isTeamLead(currentAppState.teamContext)
    ) {
      logForDebugging(
        `[InboxPoller] Found ${planApprovalRequests.length} plan approval request(s), auto-approving`,
      )

      const teamName = currentAppState.teamContext?.teamName
      // 确定要继承的权限模式（若 leader 在 plan 模式，则 teammate 继承 default）
      const leaderExternalMode = toExternalPermissionMode(
        currentAppState.toolPermissionContext.mode,
      )
      const modeToInherit =
        leaderExternalMode === 'plan' ? 'default' : leaderExternalMode

      for (const m of planApprovalRequests) {
        const parsed = isPlanApprovalRequest(m.text)
        if (!parsed) continue

        // 构建批准响应并写入 teammate 的邮箱
        const approvalResponse = {
          type: 'plan_approval_response',
          requestId: parsed.requestId,
          approved: true,
          timestamp: new Date().toISOString(),
          permissionMode: modeToInherit,
        }

        void writeToMailbox(
          m.from,
          {
            from: TEAM_LEAD_NAME,
            text: jsonStringify(approvalResponse),
            timestamp: new Date().toISOString(),
          },
          teamName,
        )

        // 如果是进程内 teammate，同步更新其任务状态
        const taskId = findInProcessTeammateTaskId(m.from, currentAppState)
        if (taskId) {
          handlePlanApprovalResponse(
            taskId,
            {
              type: 'plan_approval_response',
              requestId: parsed.requestId,
              approved: true,
              timestamp: new Date().toISOString(),
              permissionMode: modeToInherit,
            },
            setAppState,
          )
        }

        logForDebugging(
          `[InboxPoller] Auto-approved plan from ${m.from} (request ${parsed.requestId})`,
        )

        // 同时将计划请求作为普通消息传递，让模型了解 teammate 正在做什么
        regularMessages.push(m)
      }
    }

    // ===== 处理关机请求（Teammate 侧）=====
    // 保留 JSON 格式以便 UI 组件渲染，直接归入普通消息处理
    if (shutdownRequests.length > 0 && isTeammate()) {
      logForDebugging(
        `[InboxPoller] Found ${shutdownRequests.length} shutdown request(s)`,
      )

      // 将关机请求传递给普通消息流，UI 组件会渲染友好的提示
      for (const m of shutdownRequests) {
        regularMessages.push(m)
      }
    }

    // ===== 处理关机批准（Leader 侧）=====
    // 关闭 teammate 的 pane，从团队中移除该成员，清理任务
    if (
      shutdownApprovals.length > 0 &&
      isTeamLead(currentAppState.teamContext)
    ) {
      logForDebugging(
        `[InboxPoller] Found ${shutdownApprovals.length} shutdown approval(s)`,
      )

      for (const m of shutdownApprovals) {
        const parsed = isShutdownApproved(m.text)
        if (!parsed) continue

        // 若有 pane 信息（pane 型 teammate），则关闭对应 pane
        if (parsed.paneId && parsed.backendType) {
          void (async () => {
            try {
              // 确保 backend 类已导入（不使用子进程探测）
              await ensureBackendsRegistered()
              const insideTmux = await isInsideTmux()
              const backend = getBackendByType(
                parsed.backendType as PaneBackendType,
              )
              const success = await backend?.killPane(
                parsed.paneId!,
                !insideTmux,
              )
              logForDebugging(
                `[InboxPoller] Killed pane ${parsed.paneId} for ${parsed.from}: ${success}`,
              )
            } catch (error) {
              logForDebugging(
                `[InboxPoller] Failed to kill pane for ${parsed.from}: ${error}`,
              )
            }
          })()
        }

        // 从 teamContext.teammates 中移除该 teammate，确保计数准确
        const teammateToRemove = parsed.from
        if (teammateToRemove && currentAppState.teamContext?.teammates) {
          // 通过名称找到 teammate 的 ID
          const teammateId = Object.entries(
            currentAppState.teamContext.teammates,
          ).find(([, t]) => t.name === teammateToRemove)?.[0]

          if (teammateId) {
            // 从团队文件中移除（Leader 负责团队文件的变更）
            const teamName = currentAppState.teamContext?.teamName
            if (teamName) {
              removeTeammateFromTeamFile(teamName, {
                agentId: teammateId,
                name: teammateToRemove,
              })
            }

            // 取消分配该 teammate 的任务，并获取通知消息
            const { notificationMessage } = teamName
              ? await unassignTeammateTasks(
                  teamName,
                  teammateId,
                  teammateToRemove,
                  'shutdown',
                )
              : { notificationMessage: `${teammateToRemove} has shut down.` }

            setAppState(prev => {
              if (!prev.teamContext?.teammates) return prev
              if (!(teammateId in prev.teamContext.teammates)) return prev
              // 从 teammates 映射中删除已关机的成员
              const { [teammateId]: _, ...remainingTeammates } =
                prev.teamContext.teammates

              // 将该 teammate 的任务标记为已完成，使 hasRunningTeammates 变为 false
              // 若不这样做，out-of-process（tmux）的 teammate 任务会永远保持 'running' 状态
              // 因为只有 in-process teammates 有 runner 会设置 'completed'
              const updatedTasks = { ...prev.tasks }
              for (const [tid, task] of Object.entries(updatedTasks)) {
                if (
                  isInProcessTeammateTask(task) &&
                  task.identity.agentId === teammateId
                ) {
                  updatedTasks[tid] = {
                    ...task,
                    status: 'completed' as const,
                    endTime: Date.now(),
                  }
                }
              }

              return {
                ...prev,
                tasks: updatedTasks,
                teamContext: {
                  ...prev.teamContext,
                  teammates: remainingTeammates,
                },
                // 向 inbox 添加系统通知消息，告知 leader teammate 已终止
                inbox: {
                  messages: [
                    ...prev.inbox.messages,
                    {
                      id: randomUUID(),
                      from: 'system',
                      text: jsonStringify({
                        type: 'teammate_terminated',
                        message: notificationMessage,
                      }),
                      timestamp: new Date().toISOString(),
                      status: 'pending' as const,
                    },
                  ],
                },
              }
            })
            logForDebugging(
              `[InboxPoller] Removed ${teammateToRemove} (${teammateId}) from teamContext`,
            )
          }
        }

        // 将关机批准传递给普通消息流，UI 组件会渲染友好的提示
        regularMessages.push(m)
      }
    }

    // ===== 处理普通 teammate 消息（已有逻辑）=====
    if (regularMessages.length === 0) {
      // 没有普通消息，但可能已处理了非普通消息（权限、关机等），标记为已读
      markRead()
      return
    }

    // 将消息格式化为带 XML 包装的字符串（包含 color 和 summary 属性）
    // 用于提交给 Claude 模型理解消息来源
    const formatted = regularMessages
      .map(m => {
        const colorAttr = m.color ? ` color="${m.color}"` : ''
        const summaryAttr = m.summary ? ` summary="${m.summary}"` : ''
        const messageContent = m.text

        return `<${TEAMMATE_MESSAGE_TAG} teammate_id="${m.from}"${colorAttr}${summaryAttr}>\n${messageContent}\n</${TEAMMATE_MESSAGE_TAG}>`
      })
      .join('\n\n')

    // 辅助函数：将消息加入 AppState.inbox 队列，等待稍后投递
    const queueMessages = () => {
      setAppState(prev => ({
        ...prev,
        inbox: {
          messages: [
            ...prev.inbox.messages,
            ...regularMessages.map(m => ({
              id: randomUUID(),
              from: m.from,
              text: m.text,
              timestamp: m.timestamp,
              status: 'pending' as const,
              color: m.color,
              summary: m.summary,
            })),
          ],
        },
      }))
    }

    if (!isLoading && !focusedInputDialog) {
      // 空闲状态：立即作为新 turn 提交
      logForDebugging(`[InboxPoller] Session idle, submitting immediately`)
      const submitted = onSubmitTeammateMessage(formatted)
      if (!submitted) {
        // 提交被拒绝（查询已在运行），入队稍后投递
        logForDebugging(
          `[InboxPoller] Submission rejected, queuing for later delivery`,
        )
        queueMessages()
      }
    } else {
      // 忙碌状态：加入 inbox 队列，等待空闲时投递
      logForDebugging(`[InboxPoller] Session busy, queuing for later delivery`)
      queueMessages()
    }

    // 仅在消息成功投递或可靠入队后才标记为已读。
    // 这样可以防止会话繁忙时消息永久丢失——若在此处之前崩溃，
    // 消息将在下次轮询时重新读取，而不是被静默丢弃。
    markRead()
  }, [
    enabled,
    isLoading,
    focusedInputDialog,
    onSubmitTeammateMessage,
    setAppState,
    terminal,
    store,
  ])

  /**
   * 当会话变为空闲时，投递挂起的消息并清理已处理的消息。
   *
   * 触发条件：isLoading 变为 false 或 focusedInputDialog 变为 undefined
   */
  useEffect(() => {
    if (!enabled) return

    // 仍处于忙碌状态或有对话框，跳过
    if (isLoading || focusedInputDialog) {
      return
    }

    // 通过 store.getState() 获取最新状态，避免依赖 appState 对象
    const currentAppState = store.getState()
    const agentName = getAgentNameToPoll(currentAppState)
    if (!agentName) return

    // 分类 inbox 中的消息
    const pendingMessages = currentAppState.inbox.messages.filter(
      m => m.status === 'pending',
    )
    const processedMessages = currentAppState.inbox.messages.filter(
      m => m.status === 'processed',
    )

    // 清理已处理的消息（它们在 turn 进行中已作为附件投递）
    if (processedMessages.length > 0) {
      logForDebugging(
        `[InboxPoller] Cleaning up ${processedMessages.length} processed message(s) that were delivered mid-turn`,
      )
      const processedIds = new Set(processedMessages.map(m => m.id))
      setAppState(prev => ({
        ...prev,
        inbox: {
          messages: prev.inbox.messages.filter(m => !processedIds.has(m.id)),
        },
      }))
    }

    // 无挂起消息，不需要投递
    if (pendingMessages.length === 0) return

    logForDebugging(
      `[InboxPoller] Session idle, delivering ${pendingMessages.length} pending message(s)`,
    )

    // 格式化挂起消息为 XML 包装字符串
    const formatted = pendingMessages
      .map(m => {
        const colorAttr = m.color ? ` color="${m.color}"` : ''
        const summaryAttr = m.summary ? ` summary="${m.summary}"` : ''
        return `<${TEAMMATE_MESSAGE_TAG} teammate_id="${m.from}"${colorAttr}${summaryAttr}>\n${m.text}\n</${TEAMMATE_MESSAGE_TAG}>`
      })
      .join('\n\n')

    // 尝试提交——仅在成功时清除消息
    const submitted = onSubmitTeammateMessage(formatted)
    if (submitted) {
      // 通过 ID 集合清除已提交的特定消息
      const submittedIds = new Set(pendingMessages.map(m => m.id))
      setAppState(prev => ({
        ...prev,
        inbox: {
          messages: prev.inbox.messages.filter(m => !submittedIds.has(m.id)),
        },
      }))
    } else {
      logForDebugging(
        `[InboxPoller] Submission rejected, keeping messages queued`,
      )
    }
  }, [
    enabled,
    isLoading,
    focusedInputDialog,
    onSubmitTeammateMessage,
    setAppState,
    inboxMessageCount,
    store,
  ])

  // 仅在作为 teammate 或 team lead 运行时才启动轮询定时器
  const shouldPoll = enabled && !!getAgentNameToPoll(store.getState())
  useInterval(() => void poll(), shouldPoll ? INBOX_POLL_INTERVAL_MS : null)

  // 挂载时立即执行一次初始轮询（仅一次，通过 ref 防止重复）
  const hasDoneInitialPollRef = useRef(false)
  useEffect(() => {
    if (!enabled) return
    if (hasDoneInitialPollRef.current) return
    // 使用 store.getState() 避免依赖 appState 对象
    if (getAgentNameToPoll(store.getState())) {
      hasDoneInitialPollRef.current = true
      void poll()
    }
    // 注意：poll 使用 store.getState()（而非 appState），因此不会因 appState 变更而重新运行
    // ref 守卫是额外的安全措施，确保初始轮询只发生一次
  }, [enabled, poll, store])
}
