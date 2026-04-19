/**
 * 【ExitPlanModeV2Tool 主模块】
 *
 * 在 Claude Code 系统流程中的位置：
 *   ExitPlanModeV2Tool 是计划模式（plan mode）的退出工具，也是计划模式生命周期的终点。
 *   AI 在计划模式下完成代码库探索和方案设计、将计划写入 plan 文件后，调用此工具
 *   向用户（或 team-lead）展示计划并请求批准，批准后会话恢复为之前的执行权限模式。
 *
 * 主要功能：
 *   - isEnabled()：在 --channels（KAIROS 频道）激活时禁用，与 EnterPlanMode 联动防止陷阱
 *   - validateInput()：拒绝在非 plan 模式下调用，避免显示无意义的审批对话框
 *   - checkPermissions()：teammate 自动放行，非 teammate 要求用户确认
 *   - call()：
 *       - teammate + isPlanModeRequired()：写入邮箱（mailbox）等待 team-lead 审批
 *       - 非 teammate：计算 auto 模式熔断回退 → 设置退出标志 → 恢复 prePlanMode 权限
 *   - mapToolResultToToolResultBlockParam()：
 *       - 等待 team-lead 审批：返回等待指引
 *       - agent 子上下文：返回简短确认
 *       - 普通用户：将已批准的计划内容嵌入回复，可选 TeamCreateTool 并行提示
 */

import { feature } from 'bun:bundle'
import { writeFile } from 'fs/promises'
import { z } from 'zod/v4'
import {
  getAllowedChannels,
  hasExitedPlanModeInSession,
  setHasExitedPlanMode,
  setNeedsAutoModeExitAttachment,
  setNeedsPlanModeExitAttachment,
} from '../../bootstrap/state.js'
import { logEvent } from '../../services/analytics/index.js'
import type { AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from '../../services/analytics/metadata.js'
import {
  buildTool,
  type Tool,
  type ToolDef,
  toolMatchesName,
} from '../../Tool.js'
import { formatAgentId, generateRequestId } from '../../utils/agentId.js'
import { isAgentSwarmsEnabled } from '../../utils/agentSwarmsEnabled.js'
import { logForDebugging } from '../../utils/debug.js'
import {
  findInProcessTeammateTaskId,
  setAwaitingPlanApproval,
} from '../../utils/inProcessTeammateHelpers.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { logError } from '../../utils/log.js'
import {
  getPlan,
  getPlanFilePath,
  persistFileSnapshotIfRemote,
} from '../../utils/plans.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import {
  getAgentName,
  getTeamName,
  isPlanModeRequired,
  isTeammate,
} from '../../utils/teammate.js'
import { writeToMailbox } from '../../utils/teammateMailbox.js'
import { AGENT_TOOL_NAME } from '../AgentTool/constants.js'
import { TEAM_CREATE_TOOL_NAME } from '../TeamCreateTool/constants.js'
import { EXIT_PLAN_MODE_V2_TOOL_NAME } from './constants.js'
import { EXIT_PLAN_MODE_V2_TOOL_PROMPT } from './prompt.js'
import {
  renderToolResultMessage,
  renderToolUseMessage,
  renderToolUseRejectedMessage,
} from './UI.js'

// TRANSCRIPT_CLASSIFIER 特性开启时同步加载 autoModeState 和 permissionSetup 模块，
// 用于 auto 模式状态管理和熔断器检测。关闭时置为 null 避免未使用的加载开销。
/* eslint-disable @typescript-eslint/no-require-imports */
const autoModeStateModule = feature('TRANSCRIPT_CLASSIFIER')
  ? (require('../../utils/permissions/autoModeState.js') as typeof import('../../utils/permissions/autoModeState.js'))
  : null
const permissionSetupModule = feature('TRANSCRIPT_CLASSIFIER')
  ? (require('../../utils/permissions/permissionSetup.js') as typeof import('../../utils/permissions/permissionSetup.js'))
  : null
/* eslint-enable @typescript-eslint/no-require-imports */

/**
 * 语义权限请求 Schema：计划退出时，AI 可声明实现阶段所需的 Bash 操作类别。
 * 使用语义描述（如 "run tests"）而非具体命令，便于用户理解和批准。
 */
const allowedPromptSchema = lazySchema(() =>
  z.object({
    tool: z.enum(['Bash']).describe('The tool this prompt applies to'),
    prompt: z
      .string()
      .describe(
        'Semantic description of the action, e.g. "run tests", "install dependencies"',
      ),
  }),
)

export type AllowedPrompt = z.infer<ReturnType<typeof allowedPromptSchema>>

// 输入 Schema：可选的 allowedPrompts 权限声明列表；使用 passthrough 允许注入额外字段
const inputSchema = lazySchema(() =>
  z
    .strictObject({
      // 计划实现阶段所需的语义权限声明（操作类别，非具体命令）
      allowedPrompts: z
        .array(allowedPromptSchema())
        .optional()
        .describe(
          'Prompt-based permissions needed to implement the plan. These describe categories of actions rather than specific commands.',
        ),
    })
    .passthrough(),
)
type InputSchema = ReturnType<typeof inputSchema>

/**
 * SDK 面向的输入 Schema：包含由 normalizeToolInput 注入的 plan 和 planFilePath 字段。
 * 内部 inputSchema 不含这两个字段（plan 从磁盘读取），
 * 但 SDK/hooks 看到的是带有这两个字段的规范化版本。
 */
export const _sdkInputSchema = lazySchema(() =>
  inputSchema().extend({
    plan: z
      .string()
      .optional()
      .describe('The plan content (injected by normalizeToolInput from disk)'),
    planFilePath: z
      .string()
      .optional()
      .describe('The plan file path (injected by normalizeToolInput)'),
  }),
)

// 输出 Schema：包含计划内容、是否为 agent 上下文、文件路径及审批状态等字段
export const outputSchema = lazySchema(() =>
  z.object({
    plan: z
      .string()
      .nullable()
      .describe('The plan that was presented to the user'),
    isAgent: z.boolean(),
    filePath: z
      .string()
      .optional()
      .describe('The file path where the plan was saved'),
    hasTaskTool: z
      .boolean()
      .optional()
      .describe('Whether the Agent tool is available in the current context'),
    planWasEdited: z
      .boolean()
      .optional()
      .describe(
        'True when the user edited the plan (CCR web UI or Ctrl+G); determines whether the plan is echoed back in tool_result',
      ),
    awaitingLeaderApproval: z
      .boolean()
      .optional()
      .describe(
        'When true, the teammate has sent a plan approval request to the team leader',
      ),
    requestId: z
      .string()
      .optional()
      .describe('Unique identifier for the plan approval request'),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.infer<OutputSchema>

export const ExitPlanModeV2Tool: Tool<InputSchema, Output> = buildTool({
  name: EXIT_PLAN_MODE_V2_TOOL_NAME,
  searchHint: 'present plan for approval and start coding (plan mode only)',
  maxResultSizeChars: 100_000,
  async description() {
    return 'Prompts the user to exit plan mode and start coding'
  },
  async prompt() {
    return EXIT_PLAN_MODE_V2_TOOL_PROMPT
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  userFacingName() {
    return ''  // 工具名称在 UI 中不显示
  },
  shouldDefer: true,  // 退出计划模式需要用户批准
  isEnabled() {
    // 当 --channels 活跃时（Telegram/Discord 等），用户不在 TUI 前，
    // 计划审批对话框会挂起。与 EnterPlanMode 同步关闭，避免形成陷阱。
    if (
      (feature('KAIROS') || feature('KAIROS_CHANNELS')) &&
      getAllowedChannels().length > 0
    ) {
      return false
    }
    return true
  },
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return false  // 会写入磁盘（计划文件）
  },
  requiresUserInteraction() {
    // 所有 teammate（协作 agent）不需要本地用户交互：
    // - isPlanModeRequired() 为 true：通过邮箱向 team-lead 请求审批
    // - 否则：自愿计划模式，直接本地退出
    if (isTeammate()) {
      return false
    }
    // 非 teammate：需要用户点击确认才能退出计划模式
    return true
  },
  /**
   * 输入校验：拒绝在非计划模式下调用
   *
   * - teammate：直接通过（其 AppState.mode 可能显示 leader 的模式，isPlanModeRequired() 是真正的权威源）
   * - 非 teammate：若当前不在 plan 模式，返回错误并记录分析事件（防止计划批准后继续调用）
   */
  async validateInput(_input, { getAppState, options }) {
    // teammate 的 AppState 可能反映 leader 的模式，直接通过校验
    if (isTeammate()) {
      return { result: true }
    }
    // 延迟工具列表无论如何都会宣布此工具（支持压缩/清除后的计划批准）；
    // 在 checkPermissions 前拒绝，避免显示审批对话框
    const mode = getAppState().toolPermissionContext.mode
    if (mode !== 'plan') {
      logEvent('tengu_exit_plan_mode_called_outside_plan', {
        model:
          options.mainLoopModel as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        mode: mode as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        hasExitedPlanModeInSession: hasExitedPlanModeInSession(),
      })
      return {
        result: false,
        message:
          'You are not in plan mode. This tool is only for exiting plan mode after writing a plan. If your plan was already approved, continue with implementation.',
        errorCode: 1,
      }
    }
    return { result: true }
  },
  /**
   * 权限检查：
   * - teammate：自动放行（call() 内部处理邮箱审批或本地退出）
   * - 非 teammate：弹出 "Exit plan mode?" 确认对话框
   */
  async checkPermissions(input, context) {
    // 所有 teammate 绕过权限 UI，避免发送 permission_request 消息
    if (isTeammate()) {
      return {
        behavior: 'allow' as const,
        updatedInput: input,
      }
    }

    // 非 teammate：要求用户确认退出计划模式
    return {
      behavior: 'ask' as const,
      message: 'Exit plan mode?',
      updatedInput: input,
    }
  },
  renderToolUseMessage,
  renderToolResultMessage,
  renderToolUseRejectedMessage,
  /**
   * 执行计划模式退出
   *
   * 分支一（teammate + isPlanModeRequired()）：
   *   1. 读取 plan 文件内容
   *   2. 构建 plan_approval_request，写入 team-lead 邮箱
   *   3. 更新 in-process teammate 任务状态为"等待审批"
   *   4. 返回 awaitingLeaderApproval=true
   *
   * 分支二（非 teammate 或非 plan_mode_required teammate）：
   *   1. 读取 CCR web UI 可能注入的编辑版计划（input.plan）
   *   2. 若收到编辑版计划，同步写回磁盘并快照
   *   3. 计算 auto 模式熔断回退（TRANSCRIPT_CLASSIFIER 特性开启时）
   *   4. 若熔断触发，发出用户通知
   *   5. setAppState：标记退出计划模式 → 恢复 prePlanMode 权限模式 → 处理危险规则还原/剥离
   *   6. 检查 Agent 工具可用性（用于 TeamCreate 提示）
   *   7. 返回计划内容和相关元数据
   */
  async call(input, context) {
    const isAgent = !!context.agentId

    const filePath = getPlanFilePath(context.agentId)
    // CCR web UI 可能通过 permissionResult.updatedInput 发送编辑后的计划。
    // queryHelpers.ts 完全替换 finalInput，当 CCR 发送 {}（无编辑）时 input.plan 为 undefined → 回退到磁盘。
    // 内部 inputSchema 未定义 `plan` 字段（通常由 normalizeToolInput 注入），因此需要类型收窄。
    const inputPlan =
      'plan' in input && typeof input.plan === 'string' ? input.plan : undefined
    const plan = inputPlan ?? getPlan(context.agentId)

    // 若收到编辑版计划，同步写回磁盘，确保 VerifyPlanExecution / Read 看到最新内容。
    // 这里需要重新快照：api.ts 的另一处 persistFileSnapshotIfRemote 在 normalizeToolInput 中运行，
    // 在权限阶段之前捕获的是旧计划。
    if (inputPlan !== undefined && filePath) {
      await writeFile(filePath, inputPlan, 'utf-8').catch(e => logError(e))
      void persistFileSnapshotIfRemote()
    }

    // ── 分支一：teammate + 需要 team-lead 审批 ──────────────────────────
    if (isTeammate() && isPlanModeRequired()) {
      // plan_mode_required 的 teammate 必须有计划文件
      if (!plan) {
        throw new Error(
          `No plan file found at ${filePath}. Please write your plan to this file before calling ExitPlanMode.`,
        )
      }
      const agentName = getAgentName() || 'unknown'
      const teamName = getTeamName()
      // 生成唯一审批请求 ID，便于 team-lead 和 teammate 双方追踪对应关系
      const requestId = generateRequestId(
        'plan_approval',
        formatAgentId(agentName, teamName || 'default'),
      )

      const approvalRequest = {
        type: 'plan_approval_request',
        from: agentName,
        timestamp: new Date().toISOString(),
        planFilePath: filePath,
        planContent: plan,
        requestId,
      }

      // 将审批请求写入 team-lead 的邮箱，等待其处理
      await writeToMailbox(
        'team-lead',
        {
          from: agentName,
          text: jsonStringify(approvalRequest),
          timestamp: new Date().toISOString(),
        },
        teamName,
      )

      // 更新任务状态为"等待审批"（in-process teammate 可见的状态显示）
      const appState = context.getAppState()
      const agentTaskId = findInProcessTeammateTaskId(agentName, appState)
      if (agentTaskId) {
        setAwaitingPlanApproval(agentTaskId, context.setAppState, true)
      }

      return {
        data: {
          plan,
          isAgent: true,
          filePath,
          awaitingLeaderApproval: true,
          requestId,
        },
      }
    }

    // 注意：后台计划验证 hook 在 REPL.tsx 的 registerPlanVerificationHook() 中注册，
    // 发生在上下文清除之后。在这里注册会被上下文清除操作清掉。

    // ── 分支二：确保模式在退出计划模式时被正确切换 ─────────────────────
    // 处理权限流未能设置模式的边界情况（如 PermissionRequest hook 自动批准但未提供 updatedPermissions）
    const appState = context.getAppState()

    // 熔断器防御：计算 setAppState 前的熔断回退，以便通知用户。
    // 若 prePlanMode 是 auto 类模式但 gate 当前已关闭（熔断或设置禁用），
    // 恢复到 'default' 而非 'auto'。否则 ExitPlanMode 会通过直接调用 setAutoModeActive(true)
    // 绕过熔断器。
    let gateFallbackNotification: string | null = null
    if (feature('TRANSCRIPT_CLASSIFIER')) {
      const prePlanRaw = appState.toolPermissionContext.prePlanMode ?? 'default'
      if (
        prePlanRaw === 'auto' &&
        !(permissionSetupModule?.isAutoModeGateEnabled() ?? false)
      ) {
        // auto 模式熔断触发，准备回退通知内容
        const reason =
          permissionSetupModule?.getAutoModeUnavailableReason() ??
          'circuit-breaker'
        gateFallbackNotification =
          permissionSetupModule?.getAutoModeUnavailableNotification(reason) ??
          'auto mode unavailable'
        logForDebugging(
          `[auto-mode gate @ ExitPlanModeV2Tool] prePlanMode=${prePlanRaw} ` +
            `but gate is off (reason=${reason}) — falling back to default on plan exit`,
          { level: 'warn' },
        )
      }
    }
    // 若触发熔断回退，立即向用户发出警告通知
    if (gateFallbackNotification) {
      context.addNotification?.({
        key: 'auto-mode-gate-plan-exit-fallback',
        text: `plan exit → default · ${gateFallbackNotification}`,
        priority: 'immediate',
        color: 'warning',
        timeoutMs: 10000,
      })
    }

    context.setAppState(prev => {
      // 若当前不在 plan 模式则无需变更（幂等保护）
      if (prev.toolPermissionContext.mode !== 'plan') return prev

      // 标记本会话已退出过计划模式（用于 validateInput 的熔断判断）
      setHasExitedPlanMode(true)
      // 标记需要在下次 AI 响应附加计划退出上下文附件
      setNeedsPlanModeExitAttachment(true)

      // 计算恢复模式：默认回退到 prePlanMode，若 auto 被熔断则回退到 'default'
      let restoreMode = prev.toolPermissionContext.prePlanMode ?? 'default'
      if (feature('TRANSCRIPT_CLASSIFIER')) {
        if (
          restoreMode === 'auto' &&
          !(permissionSetupModule?.isAutoModeGateEnabled() ?? false)
        ) {
          restoreMode = 'default'  // 熔断回退
        }
        const finalRestoringAuto = restoreMode === 'auto'
        // 捕获还原前的状态——isAutoModeActive() 是权威信号
        // （prePlanMode/strippedDangerousRules 在 transitionPlanAutoMode 去激活后可能过时）
        const autoWasUsedDuringPlan =
          autoModeStateModule?.isAutoModeActive() ?? false
        autoModeStateModule?.setAutoModeActive(finalRestoringAuto)
        // 若计划阶段使用了 auto 模式但现在不恢复 auto，需要附加 auto 模式退出附件
        if (autoWasUsedDuringPlan && !finalRestoringAuto) {
          setNeedsAutoModeExitAttachment(true)
        }
      }

      // 危险权限处理：
      // - 恢复到非 auto 模式 且 之前剥离了危险规则 → 恢复权限
      // - 恢复到 auto 模式 → 保持剥离状态（auto 模式始终不持有危险规则）
      const restoringToAuto = restoreMode === 'auto'
      let baseContext = prev.toolPermissionContext
      if (restoringToAuto) {
        // auto 模式：确保危险权限被剥离
        baseContext =
          permissionSetupModule?.stripDangerousPermissionsForAutoMode(
            baseContext,
          ) ?? baseContext
      } else if (prev.toolPermissionContext.strippedDangerousRules) {
        // 非 auto 模式：将计划模式期间剥离的危险规则恢复回来
        baseContext =
          permissionSetupModule?.restoreDangerousPermissions(baseContext) ??
          baseContext
      }
      return {
        ...prev,
        toolPermissionContext: {
          ...baseContext,
          mode: restoreMode,           // 恢复为计划前的执行模式
          prePlanMode: undefined,      // 清除计划前模式记录
        },
      }
    })

    // 检查 Agent 工具是否可用（用于决定是否提示使用 TeamCreateTool 并行执行）
    const hasTaskTool =
      isAgentSwarmsEnabled() &&
      context.options.tools.some(t => toolMatchesName(t, AGENT_TOOL_NAME))

    return {
      data: {
        plan,
        isAgent,
        filePath,
        hasTaskTool: hasTaskTool || undefined,
        planWasEdited: inputPlan !== undefined || undefined,
      },
    }
  },
  /**
   * 将结构化输出转换为 API tool_result 格式
   *
   * 三种场景：
   * 1. awaitingLeaderApproval=true：teammate 等待 team-lead 审批，返回等待指引
   * 2. isAgent=true：agent 子上下文，返回简短确认 "ok"
   * 3. 普通用户：将已批准的计划嵌入回复，若 hasTaskTool 则附加 TeamCreate 提示
   */
  mapToolResultToToolResultBlockParam(
    {
      isAgent,
      plan,
      filePath,
      hasTaskTool,
      planWasEdited,
      awaitingLeaderApproval,
      requestId,
    },
    toolUseID,
  ) {
    // 场景一：teammate 等待 team-lead 审批
    if (awaitingLeaderApproval) {
      return {
        type: 'tool_result',
        content: `Your plan has been submitted to the team lead for approval.

Plan file: ${filePath}

**What happens next:**
1. Wait for the team lead to review your plan
2. You will receive a message in your inbox with approval/rejection
3. If approved, you can proceed with implementation
4. If rejected, refine your plan based on the feedback

**Important:** Do NOT proceed until you receive approval. Check your inbox for response.

Request ID: ${requestId}`,
        tool_use_id: toolUseID,
      }
    }

    // 场景二：agent 子上下文——简短确认，agent 不需要计划内容
    if (isAgent) {
      return {
        type: 'tool_result',
        content:
          'User has approved the plan. There is nothing else needed from you now. Please respond with "ok"',
        tool_use_id: toolUseID,
      }
    }

    // 场景三：无计划内容（计划文件为空或不存在）
    if (!plan || plan.trim() === '') {
      return {
        type: 'tool_result',
        content: 'User has approved exiting plan mode. You can now proceed.',
        tool_use_id: toolUseID,
      }
    }

    // 场景四：普通用户 + 有计划内容
    // 若 Agent 工具可用（agent swarms 启用），提示考虑使用 TeamCreateTool 并行化任务
    const teamHint = hasTaskTool
      ? `\n\nIf this plan can be broken down into multiple independent tasks, consider using the ${TEAM_CREATE_TOOL_NAME} tool to create a team and parallelize the work.`
      : ''

    // 始终包含计划内容——Ultraplan CCR 流程的 extractApprovedPlan() 从 tool_result 中解析计划文本
    // 若用户编辑了计划，标注 "(edited by user)" 以便模型感知变更
    const planLabel = planWasEdited
      ? 'Approved Plan (edited by user)'
      : 'Approved Plan'

    return {
      type: 'tool_result',
      content: `User has approved your plan. You can now start coding. Start with updating your todo list if applicable

Your plan has been saved to: ${filePath}
You can refer back to it if needed during implementation.${teamHint}

## ${planLabel}:
${plan}`,
      tool_use_id: toolUseID,
    }
  },
} satisfies ToolDef<InputSchema, Output>)
