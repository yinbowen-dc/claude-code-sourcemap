/**
 * SendMessageTool/SendMessageTool.ts — 多智能体消息路由工具
 *
 * 在 Claude Code 系统流程中的位置：
 *   工具层（Tools Layer）→ SendMessageTool → 消息路由层
 *     ├── bridge 路由：通过 Anthropic Remote Control 桥接跨机器会话
 *     ├── UDS 路由：通过本机 Unix Domain Socket 路由到同机器其他 Claude 会话
 *     ├── in-process 子代理路由：直接向同进程内运行的子代理投递或唤醒
 *     └── 信箱（mailbox）路由：通过文件系统信箱投递给 teammate（按名称或广播）
 *
 * 主要功能：
 *   - 将消息路由到指定 teammate 名称、广播所有 teammate、或跨会话地址
 *   - 处理结构化协议消息：shutdown_request/response、plan_approval_response
 *   - 权限检查：bridge 目标需要用户确认（防止跨机器提示词注入）
 *   - 输入校验：地址格式、summary 必填规则、结构化消息的路由限制
 *
 * 消息路由优先级（call 方法中依次判断）：
 *   1. bridge:xxx → 通过 Anthropic RC 服务器发送到远程会话
 *   2. uds:path  → 通过本机 socket 发送
 *   3. in-process 子代理（按名称或 agentId）→ 直接投递或自动唤醒
 *   4. * / name  → 通过文件系统信箱（mailbox）路由
 */

import { feature } from 'bun:bundle'
import { z } from 'zod/v4'
import { isReplBridgeActive } from '../../bootstrap/state.js'
import { getReplBridgeHandle } from '../../bridge/replBridgeHandle.js'
import type { Tool, ToolUseContext } from '../../Tool.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { findTeammateTaskByAgentId } from '../../tasks/InProcessTeammateTask/InProcessTeammateTask.js'
import {
  isLocalAgentTask,
  queuePendingMessage,
} from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import { isMainSessionTask } from '../../tasks/LocalMainSessionTask.js'
import { toAgentId } from '../../types/ids.js'
import { generateRequestId } from '../../utils/agentId.js'
import { isAgentSwarmsEnabled } from '../../utils/agentSwarmsEnabled.js'
import { logForDebugging } from '../../utils/debug.js'
import { errorMessage } from '../../utils/errors.js'
import { truncate } from '../../utils/format.js'
import { gracefulShutdown } from '../../utils/gracefulShutdown.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { parseAddress } from '../../utils/peerAddress.js'
import { semanticBoolean } from '../../utils/semanticBoolean.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import type { BackendType } from '../../utils/swarm/backends/types.js'
import { TEAM_LEAD_NAME } from '../../utils/swarm/constants.js'
import { readTeamFileAsync } from '../../utils/swarm/teamHelpers.js'
import {
  getAgentId,
  getAgentName,
  getTeammateColor,
  getTeamName,
  isTeamLead,
  isTeammate,
} from '../../utils/teammate.js'
import {
  createShutdownApprovedMessage,
  createShutdownRejectedMessage,
  createShutdownRequestMessage,
  writeToMailbox,
} from '../../utils/teammateMailbox.js'
import { resumeAgentBackground } from '../AgentTool/resumeAgent.js'
import { SEND_MESSAGE_TOOL_NAME } from './constants.js'
import { DESCRIPTION, getPrompt } from './prompt.js'
import { renderToolResultMessage, renderToolUseMessage } from './UI.js'

/**
 * StructuredMessage — 结构化协议消息的 Zod 辨别联合类型
 *
 * 支持三种消息类型（通过 discriminatedUnion 区分）：
 *   - shutdown_request：team lead 请求 teammate 优雅关闭
 *   - shutdown_response：teammate 同意或拒绝关闭请求（需提供 reason 当拒绝）
 *   - plan_approval_response：team lead 批准或拒绝 teammate 提交的执行计划
 *
 * semanticBoolean 允许 approve 字段接受字符串 "true"/"false"，以兼容模型输出
 */
const StructuredMessage = lazySchema(() =>
  z.discriminatedUnion('type', [
    z.object({
      type: z.literal('shutdown_request'),
      reason: z.string().optional(),
    }),
    z.object({
      type: z.literal('shutdown_response'),
      request_id: z.string(),
      approve: semanticBoolean(),       // 同意/拒绝关闭（支持字符串 "true"/"false"）
      reason: z.string().optional(),    // 拒绝时需提供原因
    }),
    z.object({
      type: z.literal('plan_approval_response'),
      request_id: z.string(),
      approve: semanticBoolean(),       // 同意/拒绝计划
      feedback: z.string().optional(),  // 拒绝时可附上反馈
    }),
  ]),
)

/**
 * inputSchema — 工具输入参数定义
 *
 * 字段说明：
 *   - to：收件人标识（teammate 名称 / "*" 广播 / "uds:..." / "bridge:..."）
 *   - summary：5-10 词的 UI 预览摘要（字符串消息时必填）
 *   - message：消息内容（纯文本字符串 或 结构化协议对象）
 *
 * feature('UDS_INBOX') 控制 to 字段的文档说明是否包含跨会话地址格式
 */
const inputSchema = lazySchema(() =>
  z.object({
    to: z
      .string()
      .describe(
        feature('UDS_INBOX')
          ? 'Recipient: teammate name, "*" for broadcast, "uds:<socket-path>" for a local peer, or "bridge:<session-id>" for a Remote Control peer (use ListPeers to discover)'
          : 'Recipient: teammate name, or "*" for broadcast to all teammates',
      ),
    summary: z
      .string()
      .optional()
      .describe(
        'A 5-10 word summary shown as a preview in the UI (required when message is a string)',
      ),
    message: z.union([
      z.string().describe('Plain text message content'),
      StructuredMessage(),
    ]),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

// 工具输入类型（供内部函数使用）
export type Input = z.infer<InputSchema>

// 消息路由信息（sender/target 名称与颜色，用于 UI 渲染）
export type MessageRouting = {
  sender: string
  senderColor?: string
  target: string
  targetColor?: string
  summary?: string
  content?: string
}

// 单条消息发送结果
export type MessageOutput = {
  success: boolean
  message: string
  routing?: MessageRouting
}

// 广播发送结果（包含实际收件人列表）
export type BroadcastOutput = {
  success: boolean
  message: string
  recipients: string[]
  routing?: MessageRouting
}

// 请求类消息（shutdown_request）的发送结果
export type RequestOutput = {
  success: boolean
  message: string
  request_id: string
  target: string
}

// 响应类消息（shutdown_response / plan_approval_response）的发送结果
export type ResponseOutput = {
  success: boolean
  message: string
  request_id?: string
}

// 工具所有可能的输出类型联合
export type SendMessageToolOutput =
  | MessageOutput
  | BroadcastOutput
  | RequestOutput
  | ResponseOutput

/**
 * findTeammateColor — 在应用状态中按名称查找 teammate 的颜色
 *
 * @param appState 当前应用状态（含 teamContext）
 * @param name teammate 名称
 * @returns 颜色字符串，若未找到则返回 undefined
 */
function findTeammateColor(
  appState: {
    teamContext?: { teammates: { [id: string]: { color?: string } } }
  },
  name: string,
): string | undefined {
  const teammates = appState.teamContext?.teammates
  if (!teammates) return undefined
  // 遍历所有 teammate 对象，按名称匹配
  for (const teammate of Object.values(teammates)) {
    if ('name' in teammate && (teammate as { name: string }).name === name) {
      return teammate.color
    }
  }
  return undefined
}

/**
 * handleMessage — 向指定 teammate 的信箱发送普通文本消息
 *
 * 整体流程：
 *   1. 获取发件人名称（优先使用 getAgentName，其次根据角色选择默认名）
 *   2. 调用 writeToMailbox 将消息写入收件人的文件系统信箱
 *   3. 查找收件人的 UI 颜色，构建路由信息并返回
 *
 * @param recipientName 收件人 teammate 名称
 * @param content 消息正文
 * @param summary UI 摘要预览
 * @param context 工具调用上下文
 */
async function handleMessage(
  recipientName: string,
  content: string,
  summary: string | undefined,
  context: ToolUseContext,
): Promise<{ data: MessageOutput }> {
  const appState = context.getAppState()
  const teamName = getTeamName(appState.teamContext)
  // 优先使用当前 agent 注册名称，无法获取时根据角色选择默认名
  const senderName =
    getAgentName() || (isTeammate() ? 'teammate' : TEAM_LEAD_NAME)
  const senderColor = getTeammateColor()

  // 将消息写入收件人的文件系统信箱（持久化到磁盘）
  await writeToMailbox(
    recipientName,
    {
      from: senderName,
      text: content,
      summary,
      timestamp: new Date().toISOString(),
      color: senderColor,
    },
    teamName,
  )

  // 查找收件人颜色，用于 UI 渲染
  const recipientColor = findTeammateColor(appState, recipientName)

  return {
    data: {
      success: true,
      message: `Message sent to ${recipientName}'s inbox`,
      routing: {
        sender: senderName,
        senderColor,
        target: `@${recipientName}`,
        targetColor: recipientColor,
        summary,
        content,
      },
    },
  }
}

/**
 * handleBroadcast — 将消息广播给团队中所有其他成员
 *
 * 整体流程：
 *   1. 读取团队文件，获取所有成员列表
 *   2. 过滤掉发件人自身，得到真实收件人列表
 *   3. 逐一向每个收件人写入信箱消息
 *   4. 返回包含实际收件人列表的广播结果
 *
 * 注意：广播是线性操作（O(团队大小)），对大团队开销较高
 *
 * @param content 消息正文
 * @param summary UI 摘要预览
 * @param context 工具调用上下文
 */
async function handleBroadcast(
  content: string,
  summary: string | undefined,
  context: ToolUseContext,
): Promise<{ data: BroadcastOutput }> {
  const appState = context.getAppState()
  const teamName = getTeamName(appState.teamContext)

  // 广播必须在团队上下文中执行
  if (!teamName) {
    throw new Error(
      'Not in a team context. Create a team with Teammate spawnTeam first, or set CLAUDE_CODE_TEAM_NAME.',
    )
  }

  // 读取团队文件以获取成员列表
  const teamFile = await readTeamFileAsync(teamName)
  if (!teamFile) {
    throw new Error(`Team "${teamName}" does not exist`)
  }

  // 获取发件人名称，广播时必须有明确的发件人标识
  const senderName =
    getAgentName() || (isTeammate() ? 'teammate' : TEAM_LEAD_NAME)
  if (!senderName) {
    throw new Error(
      'Cannot broadcast: sender name is required. Set CLAUDE_CODE_AGENT_NAME.',
    )
  }

  const senderColor = getTeammateColor()

  // 构建收件人列表：排除发件人自身（不区分大小写）
  const recipients: string[] = []
  for (const member of teamFile.members) {
    if (member.name.toLowerCase() === senderName.toLowerCase()) {
      continue
    }
    recipients.push(member.name)
  }

  // 若团队中只有发件人一人，直接返回成功（无需发送）
  if (recipients.length === 0) {
    return {
      data: {
        success: true,
        message: 'No teammates to broadcast to (you are the only team member)',
        recipients: [],
      },
    }
  }

  // 依次向每个收件人写入信箱
  for (const recipientName of recipients) {
    await writeToMailbox(
      recipientName,
      {
        from: senderName,
        text: content,
        summary,
        timestamp: new Date().toISOString(),
        color: senderColor,
      },
      teamName,
    )
  }

  return {
    data: {
      success: true,
      message: `Message broadcast to ${recipients.length} teammate(s): ${recipients.join(', ')}`,
      recipients,
      routing: {
        sender: senderName,
        senderColor,
        target: '@team',
        summary,
        content,
      },
    },
  }
}

/**
 * handleShutdownRequest — 向指定 teammate 发送优雅关闭请求
 *
 * 整体流程：
 *   1. 生成唯一的 requestId（用于后续响应匹配）
 *   2. 创建结构化 shutdown_request 消息
 *   3. 将消息写入目标 teammate 的信箱
 *   4. 返回 requestId 供发件人追踪响应
 *
 * @param targetName 目标 teammate 名称
 * @param reason 关闭原因（可选）
 * @param context 工具调用上下文
 */
async function handleShutdownRequest(
  targetName: string,
  reason: string | undefined,
  context: ToolUseContext,
): Promise<{ data: RequestOutput }> {
  const appState = context.getAppState()
  const teamName = getTeamName(appState.teamContext)
  const senderName = getAgentName() || TEAM_LEAD_NAME
  // 生成唯一请求 ID，格式如 "shutdown_<target>_<timestamp>"
  const requestId = generateRequestId('shutdown', targetName)

  // 构建结构化关闭请求消息对象
  const shutdownMessage = createShutdownRequestMessage({
    requestId,
    from: senderName,
    reason,
  })

  // 将关闭请求写入目标 teammate 的信箱（JSON 序列化）
  await writeToMailbox(
    targetName,
    {
      from: senderName,
      text: jsonStringify(shutdownMessage),
      timestamp: new Date().toISOString(),
      color: getTeammateColor(),
    },
    teamName,
  )

  return {
    data: {
      success: true,
      message: `Shutdown request sent to ${targetName}. Request ID: ${requestId}`,
      request_id: requestId,
      target: targetName,
    },
  }
}

/**
 * handleShutdownApproval — 处理 teammate 同意关闭的响应
 *
 * 整体流程：
 *   1. 从团队文件中查找当前 agent 的 paneId 和 backendType
 *   2. 创建 shutdown_approved 消息并写入 team-lead 的信箱
 *   3. 根据 backendType 执行实际关闭：
 *      - in-process：通过 abortController 取消 agent 任务
 *      - 其他（tmux 等）：先尝试 in-process 回退路径，最后调用 gracefulShutdown
 *
 * @param requestId 原始关闭请求的 ID
 * @param context 工具调用上下文
 */
async function handleShutdownApproval(
  requestId: string,
  context: ToolUseContext,
): Promise<{ data: ResponseOutput }> {
  const teamName = getTeamName()
  const agentId = getAgentId()
  const agentName = getAgentName() || 'teammate'

  logForDebugging(
    `[SendMessageTool] handleShutdownApproval: teamName=${teamName}, agentId=${agentId}, agentName=${agentName}`,
  )

  // 从团队文件中读取当前 agent 的 pane/backend 信息
  let ownPaneId: string | undefined
  let ownBackendType: BackendType | undefined
  if (teamName) {
    const teamFile = await readTeamFileAsync(teamName)
    if (teamFile && agentId) {
      // 按 agentId 找到自身在团队文件中的记录
      const selfMember = teamFile.members.find(m => m.agentId === agentId)
      if (selfMember) {
        ownPaneId = selfMember.tmuxPaneId
        ownBackendType = selfMember.backendType
      }
    }
  }

  // 构建 shutdown_approved 消息（含 paneId 供 team-lead 清理 UI）
  const approvedMessage = createShutdownApprovedMessage({
    requestId,
    from: agentName,
    paneId: ownPaneId,
    backendType: ownBackendType,
  })

  // 将批准消息写入 team-lead 的信箱
  await writeToMailbox(
    TEAM_LEAD_NAME,
    {
      from: agentName,
      text: jsonStringify(approvedMessage),
      timestamp: new Date().toISOString(),
      color: getTeammateColor(),
    },
    teamName,
  )

  if (ownBackendType === 'in-process') {
    // in-process 模式：通过 abortController 终止当前 agent 任务
    logForDebugging(
      `[SendMessageTool] In-process teammate ${agentName} approving shutdown - signaling abort`,
    )

    if (agentId) {
      const appState = context.getAppState()
      const task = findTeammateTaskByAgentId(agentId, appState.tasks)
      if (task?.abortController) {
        // 触发 abort 信号，任务会在下一个检查点停止
        task.abortController.abort()
        logForDebugging(
          `[SendMessageTool] Aborted controller for in-process teammate ${agentName}`,
        )
      } else {
        logForDebugging(
          `[SendMessageTool] Warning: Could not find task/abortController for ${agentName}`,
        )
      }
    }
  } else {
    // 非 in-process 模式：先尝试通过 AppState 找到 in-process 任务（回退路径）
    if (agentId) {
      const appState = context.getAppState()
      const task = findTeammateTaskByAgentId(agentId, appState.tasks)
      if (task?.abortController) {
        logForDebugging(
          `[SendMessageTool] Fallback: Found in-process task for ${agentName} via AppState, aborting`,
        )
        task.abortController.abort()

        return {
          data: {
            success: true,
            message: `Shutdown approved (fallback path). Agent ${agentName} is now exiting.`,
            request_id: requestId,
          },
        }
      }
    }

    // 最终回退：使用 setImmediate 异步调用 gracefulShutdown（确保响应先发出）
    setImmediate(async () => {
      await gracefulShutdown(0, 'other')
    })
  }

  return {
    data: {
      success: true,
      message: `Shutdown approved. Sent confirmation to team-lead. Agent ${agentName} is now exiting.`,
      request_id: requestId,
    },
  }
}

/**
 * handleShutdownRejection — 处理 teammate 拒绝关闭的响应
 *
 * 整体流程：
 *   1. 创建 shutdown_rejected 消息（含拒绝原因）
 *   2. 将消息写入 team-lead 的信箱
 *   3. 返回成功结果，告知调用方继续工作
 *
 * @param requestId 原始关闭请求的 ID
 * @param reason 拒绝原因（必填）
 */
async function handleShutdownRejection(
  requestId: string,
  reason: string,
): Promise<{ data: ResponseOutput }> {
  const teamName = getTeamName()
  const agentName = getAgentName() || 'teammate'

  // 构建拒绝消息（含原因文本）
  const rejectedMessage = createShutdownRejectedMessage({
    requestId,
    from: agentName,
    reason,
  })

  // 将拒绝消息写入 team-lead 的信箱
  await writeToMailbox(
    TEAM_LEAD_NAME,
    {
      from: agentName,
      text: jsonStringify(rejectedMessage),
      timestamp: new Date().toISOString(),
      color: getTeammateColor(),
    },
    teamName,
  )

  return {
    data: {
      success: true,
      message: `Shutdown rejected. Reason: "${reason}". Continuing to work.`,
      request_id: requestId,
    },
  }
}

/**
 * handlePlanApproval — team lead 批准 teammate 提交的执行计划
 *
 * 整体流程：
 *   1. 验证当前 agent 为 team lead（只有 team lead 可以批准计划）
 *   2. 继承当前权限模式（plan 模式下降级为 default，避免循环）
 *   3. 构建 plan_approval_response 消息（approved: true）
 *   4. 将批准消息写入 recipient 的信箱
 *
 * @param recipientName 计划提交者（teammate）的名称
 * @param requestId 原始计划审批请求的 ID
 * @param context 工具调用上下文
 */
async function handlePlanApproval(
  recipientName: string,
  requestId: string,
  context: ToolUseContext,
): Promise<{ data: ResponseOutput }> {
  const appState = context.getAppState()
  const teamName = appState.teamContext?.teamName

  // 权限检查：只有 team lead 可以批准计划
  if (!isTeamLead(appState.teamContext)) {
    throw new Error(
      'Only the team lead can approve plans. Teammates cannot approve their own or other plans.',
    )
  }

  // 获取当前权限模式：plan 模式下降级为 default（避免 teammate 在 plan 模式下无法执行）
  const leaderMode = appState.toolPermissionContext.mode
  const modeToInherit = leaderMode === 'plan' ? 'default' : leaderMode

  // 构建计划批准响应对象（含权限模式，供 teammate 继承）
  const approvalResponse = {
    type: 'plan_approval_response',
    requestId,
    approved: true,
    timestamp: new Date().toISOString(),
    permissionMode: modeToInherit,
  }

  // 将批准消息写入 recipient 的信箱
  await writeToMailbox(
    recipientName,
    {
      from: TEAM_LEAD_NAME,
      text: jsonStringify(approvalResponse),
      timestamp: new Date().toISOString(),
    },
    teamName,
  )

  return {
    data: {
      success: true,
      message: `Plan approved for ${recipientName}. They will receive the approval and can proceed with implementation.`,
      request_id: requestId,
    },
  }
}

/**
 * handlePlanRejection — team lead 拒绝 teammate 提交的执行计划
 *
 * 整体流程：
 *   1. 验证当前 agent 为 team lead
 *   2. 构建 plan_approval_response 消息（approved: false，含反馈）
 *   3. 将拒绝消息写入 recipient 的信箱（teammate 收到后会修改计划并重新提交）
 *
 * @param recipientName 计划提交者（teammate）的名称
 * @param requestId 原始计划审批请求的 ID
 * @param feedback 拒绝原因和修改建议
 * @param context 工具调用上下文
 */
async function handlePlanRejection(
  recipientName: string,
  requestId: string,
  feedback: string,
  context: ToolUseContext,
): Promise<{ data: ResponseOutput }> {
  const appState = context.getAppState()
  const teamName = appState.teamContext?.teamName

  // 权限检查：只有 team lead 可以拒绝计划
  if (!isTeamLead(appState.teamContext)) {
    throw new Error(
      'Only the team lead can reject plans. Teammates cannot reject their own or other plans.',
    )
  }

  // 构建计划拒绝响应对象（含反馈文本，供 teammate 参考修改）
  const rejectionResponse = {
    type: 'plan_approval_response',
    requestId,
    approved: false,
    feedback,
    timestamp: new Date().toISOString(),
  }

  // 将拒绝消息写入 recipient 的信箱
  await writeToMailbox(
    recipientName,
    {
      from: TEAM_LEAD_NAME,
      text: jsonStringify(rejectionResponse),
      timestamp: new Date().toISOString(),
    },
    teamName,
  )

  return {
    data: {
      success: true,
      message: `Plan rejected for ${recipientName} with feedback: "${feedback}"`,
      request_id: requestId,
    },
  }
}

/**
 * SendMessageTool — 多智能体消息路由工具的主体定义
 *
 * 核心方法说明：
 *   - isEnabled：需要 isAgentSwarmsEnabled()（多智能体功能开关）
 *   - isReadOnly：仅字符串消息被视为只读（结构化协议消息会触发副作用）
 *   - backfillObservableInput：将 to/message 结构标准化为可观测字段（供 UI 解析）
 *   - checkPermissions：bridge 目标需要用户确认（防止跨机器提示词注入）
 *   - validateInput：多维度校验（空地址、结构化消息路由限制、summary 必填规则）
 *   - call：消息路由主逻辑，优先级：bridge → uds → in-process → mailbox
 */
export const SendMessageTool: Tool<InputSchema, SendMessageToolOutput> =
  buildTool({
    name: SEND_MESSAGE_TOOL_NAME,
    searchHint: 'send messages to agent teammates (swarm protocol)',
    maxResultSizeChars: 100_000,

    userFacingName() {
      return 'SendMessage'
    },

    get inputSchema(): InputSchema {
      return inputSchema()
    },
    shouldDefer: true,

    /**
     * 工具启用条件：需通过多智能体功能开关（isAgentSwarmsEnabled）
     */
    isEnabled() {
      return isAgentSwarmsEnabled()
    },

    /**
     * 只读标记：纯文本消息不会修改状态，结构化协议消息（如关闭请求）会产生副作用
     */
    isReadOnly(input) {
      return typeof input.message === 'string'
    },

    /**
     * backfillObservableInput — 将输入规范化为可观测字段
     *
     * 目的：将原始 to/message 字段拆解为更细粒度的 type/recipient/content 等字段，
     *       供 UI 和分析系统解析（不影响工具实际执行逻辑）
     */
    backfillObservableInput(input) {
      if ('type' in input) return
      if (typeof input.to !== 'string') return

      if (input.to === '*') {
        // 广播消息：type 标记为 broadcast
        input.type = 'broadcast'
        if (typeof input.message === 'string') input.content = input.message
      } else if (typeof input.message === 'string') {
        // 普通文本消息
        input.type = 'message'
        input.recipient = input.to
        input.content = input.message
      } else if (typeof input.message === 'object' && input.message !== null) {
        // 结构化协议消息：提取 type/request_id/approve/reason/feedback 等字段
        const msg = input.message as {
          type?: string
          request_id?: string
          approve?: boolean
          reason?: string
          feedback?: string
        }
        input.type = msg.type
        input.recipient = input.to
        if (msg.request_id !== undefined) input.request_id = msg.request_id
        if (msg.approve !== undefined) input.approve = msg.approve
        const content = msg.reason ?? msg.feedback
        if (content !== undefined) input.content = content
      }
    },

    /**
     * toAutoClassifierInput — 生成自动分类器的输入描述
     * 字符串消息：直接显示 "to <name>: <message>"
     * 结构化消息：显示消息类型和相关参数
     */
    toAutoClassifierInput(input) {
      if (typeof input.message === 'string') {
        return `to ${input.to}: ${input.message}`
      }
      switch (input.message.type) {
        case 'shutdown_request':
          return `shutdown_request to ${input.to}`
        case 'shutdown_response':
          return `shutdown_response ${input.message.approve ? 'approve' : 'reject'} ${input.message.request_id}`
        case 'plan_approval_response':
          return `plan_approval ${input.message.approve ? 'approve' : 'reject'} to ${input.to}`
      }
    },

    /**
     * checkPermissions — 权限检查
     *
     * bridge 目标必须通过用户确认（safetyCheck 类型，绕过 bypass 和自动模式），
     * 因为消息会通过 Anthropic 服务器发送到另一台机器，存在跨机器提示词注入风险。
     * 其他目标（teammate 名称、"*"、uds:）直接允许。
     */
    async checkPermissions(input, _context) {
      if (feature('UDS_INBOX') && parseAddress(input.to).scheme === 'bridge') {
        return {
          behavior: 'ask' as const,
          message: `Send a message to Remote Control session ${input.to}? It arrives as a user prompt on the receiving Claude (possibly another machine) via Anthropic's servers.`,
          // safetyCheck (not mode) — permissions.ts guards this before both
          // bypassPermissions (step 1g) and auto-mode's allowlist/classifier.
          // Cross-machine prompt injection must stay bypass-immune.
          decisionReason: {
            type: 'safetyCheck',
            reason:
              'Cross-machine bridge message requires explicit user consent',
            classifierApprovable: false,
          },
        }
      }
      return { behavior: 'allow' as const, updatedInput: input }
    },

    /**
     * validateInput — 多维度输入校验
     *
     * 校验逻辑（按优先级）：
     *   1. to 不能为空
     *   2. uds/bridge 地址的 target 部分不能为空
     *   3. to 不能包含 "@"（只支持裸名称）
     *   4. bridge 目标：不允许结构化消息；需要 RC 连接处于活跃状态
     *   5. uds 目标（字符串消息）：直接通过（无需 summary）
     *   6. 字符串消息：summary 必填
     *   7. 结构化消息：不允许广播；不允许跨会话
     *   8. shutdown_response 必须发送给 team-lead；拒绝时必须提供 reason
     */
    async validateInput(input, _context) {
      // to 字段不能为空
      if (input.to.trim().length === 0) {
        return {
          result: false,
          message: 'to must not be empty',
          errorCode: 9,
        }
      }
      const addr = parseAddress(input.to)
      // uds/bridge 地址的 target 部分不能为空
      if (
        (addr.scheme === 'bridge' || addr.scheme === 'uds') &&
        addr.target.trim().length === 0
      ) {
        return {
          result: false,
          message: 'address target must not be empty',
          errorCode: 9,
        }
      }
      // 不支持 "@name" 格式（每个会话只有一个团队，无需限定团队）
      if (input.to.includes('@')) {
        return {
          result: false,
          message:
            'to must be a bare teammate name or "*" — there is only one team per session',
          errorCode: 9,
        }
      }
      if (feature('UDS_INBOX') && parseAddress(input.to).scheme === 'bridge') {
        // Structured-message rejection first — it's the permanent constraint.
        // Showing "not connected" first would make the user reconnect only to
        // hit this error on retry.
        // 结构化消息无法跨会话发送（先检查此约束，再检查连接状态）
        if (typeof input.message !== 'string') {
          return {
            result: false,
            message:
              'structured messages cannot be sent cross-session — only plain text',
            errorCode: 9,
          }
        }
        // postInterClaudeMessage derives from= via getReplBridgeHandle() —
        // check handle directly for the init-timing window. Also check
        // isReplBridgeActive() to reject outbound-only (CCR mirror) mode
        // where the bridge is write-only and peer messaging is unsupported.
        // 检查 RC 连接是否处于活跃状态（handle 存在 + 非只写镜像模式）
        if (!getReplBridgeHandle() || !isReplBridgeActive()) {
          return {
            result: false,
            message:
              'Remote Control is not connected — cannot send to a bridge: target. Reconnect with /remote-control first.',
            errorCode: 9,
          }
        }
        return { result: true }
      }
      if (
        feature('UDS_INBOX') &&
        parseAddress(input.to).scheme === 'uds' &&
        typeof input.message === 'string'
      ) {
        // UDS cross-session send: summary isn't rendered (UI.tsx returns null
        // for string messages), so don't require it. Structured messages fall
        // through to the rejection below.
        // UDS 跨会话发送：summary 不会渲染，无需必填
        return { result: true }
      }
      // 普通字符串消息：summary 必填（用于 UI 预览）
      if (typeof input.message === 'string') {
        if (!input.summary || input.summary.trim().length === 0) {
          return {
            result: false,
            message: 'summary is required when message is a string',
            errorCode: 9,
          }
        }
        return { result: true }
      }

      // 结构化消息不允许广播
      if (input.to === '*') {
        return {
          result: false,
          message: 'structured messages cannot be broadcast (to: "*")',
          errorCode: 9,
        }
      }
      // UDS_INBOX 启用时，结构化消息不允许跨会话发送
      if (feature('UDS_INBOX') && parseAddress(input.to).scheme !== 'other') {
        return {
          result: false,
          message:
            'structured messages cannot be sent cross-session — only plain text',
          errorCode: 9,
        }
      }

      // shutdown_response 必须发送给 team-lead
      if (
        input.message.type === 'shutdown_response' &&
        input.to !== TEAM_LEAD_NAME
      ) {
        return {
          result: false,
          message: `shutdown_response must be sent to "${TEAM_LEAD_NAME}"`,
          errorCode: 9,
        }
      }

      // 拒绝关闭请求时必须提供拒绝原因
      if (
        input.message.type === 'shutdown_response' &&
        !input.message.approve &&
        (!input.message.reason || input.message.reason.trim().length === 0)
      ) {
        return {
          result: false,
          message: 'reason is required when rejecting a shutdown request',
          errorCode: 9,
        }
      }

      return { result: true }
    },

    async description() {
      return DESCRIPTION
    },

    async prompt() {
      return getPrompt()
    },

    /**
     * mapToolResultToToolResultBlockParam — 将工具输出序列化为 Anthropic API 格式
     * 输出为 JSON 字符串，供模型在下一轮对话中读取
     */
    mapToolResultToToolResultBlockParam(data, toolUseID) {
      return {
        tool_use_id: toolUseID,
        type: 'tool_result' as const,
        content: [
          {
            type: 'text' as const,
            text: jsonStringify(data),
          },
        ],
      }
    },

    /**
     * call — 消息路由主逻辑
     *
     * 路由优先级（从高到低）：
     *   1. bridge:xxx（UDS_INBOX 启用）→ 通过 RC 服务器跨机器发送
     *   2. uds:path（UDS_INBOX 启用）→ 通过本机 socket 发送
     *   3. 按名称/agentId 查找 in-process 子代理 → 投递消息或自动唤醒已停止的代理
     *   4. to="*" → handleBroadcast（广播给所有 teammate）
     *   5. to=name → handleMessage（写入 teammate 信箱）
     *   6. 结构化消息 → 按 type 分发到对应 handler
     */
    async call(input, context, canUseTool, assistantMessage) {
      if (feature('UDS_INBOX') && typeof input.message === 'string') {
        const addr = parseAddress(input.to)
        if (addr.scheme === 'bridge') {
          // Re-check handle — checkPermissions blocks on user approval (can be
          // minutes). validateInput's check is stale if the bridge dropped
          // during the prompt wait; without this, from="unknown" ships.
          // Also re-check isReplBridgeActive for outbound-only mode.
          // 重新检查 RC 连接（用户确认可能耗时较长，期间连接可能已断开）
          if (!getReplBridgeHandle() || !isReplBridgeActive()) {
            return {
              data: {
                success: false,
                message: `Remote Control disconnected before send — cannot deliver to ${input.to}`,
              },
            }
          }
          /* eslint-disable @typescript-eslint/no-require-imports */
          const { postInterClaudeMessage } =
            require('../../bridge/peerSessions.js') as typeof import('../../bridge/peerSessions.js')
          /* eslint-enable @typescript-eslint/no-require-imports */
          // 通过 RC 服务器发送消息到远程会话
          const result = await postInterClaudeMessage(
            addr.target,
            input.message,
          )
          const preview = input.summary || truncate(input.message, 50)
          return {
            data: {
              success: result.ok,
              message: result.ok
                ? `"${preview}" → ${input.to}`
                : `Failed to send to ${input.to}: ${result.error ?? 'unknown'}`,
            },
          }
        }
        if (addr.scheme === 'uds') {
          /* eslint-disable @typescript-eslint/no-require-imports */
          const { sendToUdsSocket } =
            require('../../utils/udsClient.js') as typeof import('../../utils/udsClient.js')
          /* eslint-enable @typescript-eslint/no-require-imports */
          try {
            // 通过 Unix Domain Socket 发送到同机器其他 Claude 会话
            await sendToUdsSocket(addr.target, input.message)
            const preview = input.summary || truncate(input.message, 50)
            return {
              data: {
                success: true,
                message: `"${preview}" → ${input.to}`,
              },
            }
          } catch (e) {
            return {
              data: {
                success: false,
                message: `Failed to send to ${input.to}: ${errorMessage(e)}`,
              },
            }
          }
        }
      }

      // Route to in-process subagent by name or raw agentId before falling
      // through to ambient-team resolution. Stopped agents are auto-resumed.
      // 尝试通过名称或 agentId 路由到 in-process 子代理
      if (typeof input.message === 'string' && input.to !== '*') {
        const appState = context.getAppState()
        // 先按注册名称查找，再尝试将 to 解析为 agentId 格式
        const registered = appState.agentNameRegistry.get(input.to)
        const agentId = registered ?? toAgentId(input.to)
        if (agentId) {
          const task = appState.tasks[agentId]
          if (isLocalAgentTask(task) && !isMainSessionTask(task)) {
            if (task.status === 'running') {
              // 代理正在运行：将消息加入待处理队列（下次 tool round 时消费）
              queuePendingMessage(
                agentId,
                input.message,
                context.setAppStateForTasks ?? context.setAppState,
              )
              return {
                data: {
                  success: true,
                  message: `Message queued for delivery to ${input.to} at its next tool round.`,
                },
              }
            }
            // task exists but stopped — auto-resume
            // 代理已停止：自动唤醒并传递消息
            try {
              const result = await resumeAgentBackground({
                agentId,
                prompt: input.message,
                toolUseContext: context,
                canUseTool,
                invokingRequestId: assistantMessage?.requestId,
              })
              return {
                data: {
                  success: true,
                  message: `Agent "${input.to}" was stopped (${task.status}); resumed it in the background with your message. You'll be notified when it finishes. Output: ${result.outputFile}`,
                },
              }
            } catch (e) {
              return {
                data: {
                  success: false,
                  message: `Agent "${input.to}" is stopped (${task.status}) and could not be resumed: ${errorMessage(e)}`,
                },
              }
            }
          } else {
            // task evicted from state — try resume from disk transcript.
            // agentId is either a registered name or a format-matching raw ID
            // (toAgentId validates the createAgentId format, so teammate names
            // never reach this block).
            // 任务已从状态中移除：尝试从磁盘记录（transcript）中恢复
            try {
              const result = await resumeAgentBackground({
                agentId,
                prompt: input.message,
                toolUseContext: context,
                canUseTool,
                invokingRequestId: assistantMessage?.requestId,
              })
              return {
                data: {
                  success: true,
                  message: `Agent "${input.to}" had no active task; resumed from transcript in the background with your message. You'll be notified when it finishes. Output: ${result.outputFile}`,
                },
              }
            } catch (e) {
              return {
                data: {
                  success: false,
                  message: `Agent "${input.to}" is registered but has no transcript to resume. It may have been cleaned up. (${errorMessage(e)})`,
                },
              }
            }
          }
        }
      }

      // 普通字符串消息：广播或单播到 teammate 信箱
      if (typeof input.message === 'string') {
        if (input.to === '*') {
          return handleBroadcast(input.message, input.summary, context)
        }
        return handleMessage(input.to, input.message, input.summary, context)
      }

      // 结构化消息不允许广播（validateInput 已拦截，此处为防御性断言）
      if (input.to === '*') {
        throw new Error('structured messages cannot be broadcast')
      }

      // 按结构化消息类型分发到对应 handler
      switch (input.message.type) {
        case 'shutdown_request':
          return handleShutdownRequest(input.to, input.message.reason, context)
        case 'shutdown_response':
          if (input.message.approve) {
            // approve=true：同意关闭，触发进程退出
            return handleShutdownApproval(input.message.request_id, context)
          }
          // approve=false：拒绝关闭，继续工作
          return handleShutdownRejection(
            input.message.request_id,
            input.message.reason!,
          )
        case 'plan_approval_response':
          if (input.message.approve) {
            // approve=true：批准计划，teammate 可以开始执行
            return handlePlanApproval(
              input.to,
              input.message.request_id,
              context,
            )
          }
          // approve=false：拒绝计划，附上反馈让 teammate 修改
          return handlePlanRejection(
            input.to,
            input.message.request_id,
            input.message.feedback ?? 'Plan needs revision',
            context,
          )
      }
    },

    // UI 渲染函数：分别处理工具调用时和结果返回时的界面展示
    renderToolUseMessage,
    renderToolResultMessage,
  } satisfies ToolDef<InputSchema, SendMessageToolOutput>)
