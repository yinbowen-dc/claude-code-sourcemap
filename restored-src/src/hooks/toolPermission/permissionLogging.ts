/**
 * permissionLogging.ts
 *
 * 【在系统流程中的位置】
 * 本文件属于 toolPermission/ 子目录，是所有权限决策的「集中式分析/遥测日志」模块。
 *
 * 每次工具权限被批准或拒绝时，无论来源是用户交互、Permission Hooks、
 * Bash Classifier，还是配置文件（allowlist/denylist），都会调用
 * logPermissionDecision()，将事件扇出到：
 * - Statsig 分析事件（tengu_tool_use_granted_* / tengu_tool_use_rejected_*）
 * - OTel 遥测事件（tool_decision）
 * - 代码编辑工具的 OTel 计数器（enriched with language metadata）
 * - toolUseContext.toolDecisions Map（供下游代码检查决策结果）
 *
 * 【主要功能】
 * - logPermissionDecision()：单一入口，接受决策上下文和决策参数，扇出到所有遥测后端；
 * - logApprovalEvent()：按批准来源（用户永久/临时、hook、classifier、config）发送不同事件；
 * - logRejectionEvent()：统一发送拒绝事件（区分来源类型）；
 * - buildCodeEditToolAttributes()：从代码编辑工具输入中提取文件路径和语言信息；
 * - sourceToString()：将结构化来源对象转换为字符串标签（用于事件字段）。
 */

// 所有权限批准/拒绝事件均通过 logPermissionDecision() 汇聚，
// 再扇出到 Statsig 分析、OTel 遥测和代码编辑指标。
import { feature } from 'bun:bundle'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js'
import { sanitizeToolNameForAnalytics } from 'src/services/analytics/metadata.js'
import { getCodeEditToolDecisionCounter } from '../../bootstrap/state.js'
import type { Tool as ToolType, ToolUseContext } from '../../Tool.js'
import { getLanguageName } from '../../utils/cliHighlight.js'
import { SandboxManager } from '../../utils/sandbox/sandbox-adapter.js'
import { logOTelEvent } from '../../utils/telemetry/events.js'
import type {
  PermissionApprovalSource,
  PermissionRejectionSource,
} from './PermissionContext.js'

/** 权限日志上下文：描述本次决策对应的工具调用信息 */
type PermissionLogContext = {
  tool: ToolType                // 工具定义
  input: unknown                // 工具输入参数
  toolUseContext: ToolUseContext // 工具使用上下文（包含 abortController、agentId 等）
  messageId: string             // 关联的 Assistant 消息 ID（用于 analytics）
  toolUseID: string             // 本次工具使用的唯一 ID
}

// 判别联合类型：'accept' 与批准来源配对，'reject' 与拒绝来源配对
type PermissionDecisionArgs =
  | { decision: 'accept'; source: PermissionApprovalSource | 'config' }
  | { decision: 'reject'; source: PermissionRejectionSource | 'config' }

/** 代码编辑相关工具名称列表 */
const CODE_EDITING_TOOLS = ['Edit', 'Write', 'NotebookEdit']

/**
 * 判断给定工具名是否为代码编辑工具。
 * 用于决定是否需要上报语言信息到 OTel 计数器。
 */
function isCodeEditingTool(toolName: string): boolean {
  return CODE_EDITING_TOOLS.includes(toolName)
}

/**
 * 为代码编辑工具构建 OTel 计数器属性。
 *
 * 尝试从工具输入中提取目标文件路径，并推断编程语言，
 * 生成更丰富的 OTel 属性（包含 language 字段）。
 *
 * @param tool     工具定义（需实现 getPath 和 inputSchema）
 * @param input    工具输入参数
 * @param decision 决策结果（'accept' | 'reject'）
 * @param source   决策来源标签字符串
 * @returns OTel 属性对象（含 decision、source、tool_name，可能含 language）
 */
async function buildCodeEditToolAttributes(
  tool: ToolType,
  input: unknown,
  decision: 'accept' | 'reject',
  source: string,
): Promise<Record<string, string>> {
  // 尝试从工具的 getPath 方法中提取文件路径（如 Edit、Write 工具）
  let language: string | undefined
  if (tool.getPath && input) {
    const parseResult = tool.inputSchema.safeParse(input)
    if (parseResult.success) {
      const filePath = tool.getPath(parseResult.data)
      if (filePath) {
        // 根据文件扩展名推断编程语言
        language = await getLanguageName(filePath)
      }
    }
  }

  return {
    decision,
    source,
    tool_name: tool.name,
    ...(language && { language }),  // 仅当成功推断语言时附加
  }
}

/**
 * 将结构化来源对象转换为字符串标签，供 analytics/OTel 事件字段使用。
 *
 * @param source 批准或拒绝来源对象
 * @returns 来源标签字符串（如 'classifier'、'hook'、'user_permanent'）
 */
function sourceToString(
  source: PermissionApprovalSource | PermissionRejectionSource,
): string {
  // classifier 来源需要 feature flag 开启才记录
  if (
    (feature('BASH_CLASSIFIER') || feature('TRANSCRIPT_CLASSIFIER')) &&
    source.type === 'classifier'
  ) {
    return 'classifier'
  }
  switch (source.type) {
    case 'hook':
      return 'hook'
    case 'user':
      // 区分永久授权（user_permanent）和临时授权（user_temporary）
      return source.permanent ? 'user_permanent' : 'user_temporary'
    case 'user_abort':
      return 'user_abort'
    case 'user_reject':
      return 'user_reject'
    default:
      return 'unknown'
  }
}

/**
 * 构建基础 analytics 元数据（所有事件共用的字段）。
 *
 * @param messageId    关联的 Assistant 消息 ID
 * @param toolName     工具名称
 * @param waitMs       用户等待时间（毫秒），仅在实际弹出对话框时提供
 * @returns 基础元数据对象
 */
function baseMetadata(
  messageId: string,
  toolName: string,
  waitMs: number | undefined,
): { [key: string]: boolean | number | undefined } {
  return {
    messageID:
      messageId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    toolName: sanitizeToolNameForAnalytics(toolName),
    sandboxEnabled: SandboxManager.isSandboxingEnabled(),
    // 仅当用户实际被弹出对话框时才包含等待时间（自动批准不包含）
    ...(waitMs !== undefined && { waiting_for_user_permission_ms: waitMs }),
  }
}

/**
 * 按批准来源发送不同名称的 analytics 事件，用于漏斗分析。
 *
 * - config：配置文件 allowlist 自动批准（无等待时间）
 * - classifier：Bash Classifier 自动批准
 * - user（永久）：用户在对话框中选择了永久授权
 * - user（临时）：用户在对话框中选择了临时授权
 * - hook：Permission Hook 自动批准
 *
 * @param tool      工具定义
 * @param messageId 关联消息 ID
 * @param source    批准来源
 * @param waitMs    用户等待时间（毫秒）
 */
function logApprovalEvent(
  tool: ToolType,
  messageId: string,
  source: PermissionApprovalSource | 'config',
  waitMs: number | undefined,
): void {
  if (source === 'config') {
    // 配置文件 allowlist 自动批准——不需要等待时间
    logEvent(
      'tengu_tool_use_granted_in_config',
      baseMetadata(messageId, tool.name, undefined),
    )
    return
  }
  if (
    (feature('BASH_CLASSIFIER') || feature('TRANSCRIPT_CLASSIFIER')) &&
    source.type === 'classifier'
  ) {
    // Bash Classifier 自动批准
    logEvent(
      'tengu_tool_use_granted_by_classifier',
      baseMetadata(messageId, tool.name, waitMs),
    )
    return
  }
  switch (source.type) {
    case 'user':
      // 区分永久授权与临时授权事件名
      logEvent(
        source.permanent
          ? 'tengu_tool_use_granted_in_prompt_permanent'
          : 'tengu_tool_use_granted_in_prompt_temporary',
        baseMetadata(messageId, tool.name, waitMs),
      )
      break
    case 'hook':
      // Permission Hook 批准（附加 permanent 字段）
      logEvent('tengu_tool_use_granted_by_permission_hook', {
        ...baseMetadata(messageId, tool.name, waitMs),
        permanent: source.permanent ?? false,
      })
      break
    default:
      break
  }
}

/**
 * 发送权限拒绝 analytics 事件。
 * 所有拒绝事件共用同一事件名，通过元数据字段区分来源类型。
 *
 * @param tool      工具定义
 * @param messageId 关联消息 ID
 * @param source    拒绝来源
 * @param waitMs    用户等待时间（毫秒）
 */
function logRejectionEvent(
  tool: ToolType,
  messageId: string,
  source: PermissionRejectionSource | 'config',
  waitMs: number | undefined,
): void {
  if (source === 'config') {
    // 配置文件 denylist 自动拒绝
    logEvent(
      'tengu_tool_use_denied_in_config',
      baseMetadata(messageId, tool.name, undefined),
    )
    return
  }
  // 用户拒绝或 hook 拒绝，统一使用同一事件名，通过字段区分
  logEvent('tengu_tool_use_rejected_in_prompt', {
    ...baseMetadata(messageId, tool.name, waitMs),
    // hook 拒绝附加 isHook 字段；用户拒绝附加 hasFeedback 字段
    ...(source.type === 'hook'
      ? { isHook: true }
      : {
          hasFeedback:
            source.type === 'user_reject' ? source.hasFeedback : false,
        }),
  })
}

/**
 * 所有权限决策日志的唯一入口。
 *
 * 每次权限批准/拒绝后由权限处理器调用，扇出到：
 * - analytics 事件（Statsig）
 * - OTel 遥测事件
 * - 代码编辑工具的 OTel 计数器（含语言信息）
 * - toolUseContext.toolDecisions Map（供下游代码检查）
 *
 * @param ctx                      权限日志上下文（工具、输入、toolUseContext 等）
 * @param args                     权限决策参数（决策结果和来源）
 * @param permissionPromptStartTimeMs  权限对话框弹出的开始时间（毫秒），用于计算等待时间
 */
function logPermissionDecision(
  ctx: PermissionLogContext,
  args: PermissionDecisionArgs,
  permissionPromptStartTimeMs?: number,
): void {
  const { tool, input, toolUseContext, messageId, toolUseID } = ctx
  const { decision, source } = args

  // 计算用户等待时间（仅在有开始时间时计算）
  const waiting_for_user_permission_ms =
    permissionPromptStartTimeMs !== undefined
      ? Date.now() - permissionPromptStartTimeMs
      : undefined

  // 发送 analytics 事件（批准或拒绝路径不同）
  if (args.decision === 'accept') {
    logApprovalEvent(
      tool,
      messageId,
      args.source,
      waiting_for_user_permission_ms,
    )
  } else {
    logRejectionEvent(
      tool,
      messageId,
      args.source,
      waiting_for_user_permission_ms,
    )
  }

  // 将来源转换为字符串（config 直接字符串，其他类型通过 sourceToString 转换）
  const sourceString = source === 'config' ? 'config' : sourceToString(source)

  // 为代码编辑工具上报 OTel 计数器（异步获取语言信息）
  if (isCodeEditingTool(tool.name)) {
    void buildCodeEditToolAttributes(tool, input, decision, sourceString).then(
      attributes => getCodeEditToolDecisionCounter()?.add(1, attributes),
    )
  }

  // 将决策持久化到 toolUseContext.toolDecisions Map，供下游代码检查
  if (!toolUseContext.toolDecisions) {
    toolUseContext.toolDecisions = new Map()
  }
  toolUseContext.toolDecisions.set(toolUseID, {
    source: sourceString,
    decision,
    timestamp: Date.now(),
  })

  // 发送 OTel 遥测事件
  void logOTelEvent('tool_decision', {
    decision,
    source: sourceString,
    tool_name: sanitizeToolNameForAnalytics(tool.name),
  })
}

export { isCodeEditingTool, buildCodeEditToolAttributes, logPermissionDecision }
export type { PermissionLogContext, PermissionDecisionArgs }
