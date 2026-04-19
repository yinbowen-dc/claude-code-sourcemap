/**
 * hooks.ts
 *
 * 【在 Claude Code 权限系统中的位置】
 * 本文件提供权限请求流程的共享 React 钩子和辅助函数。所有权限请求组件
 * （BashPermissionRequest、FallbackPermissionRequest 等）均通过本文件
 * 统一上报权限弹窗的 Analytics 事件和 Unary 日志事件。
 *
 * 【主要功能】
 * - 定义 UnaryEvent 类型（completion_type + language_name）
 * - permissionResultToLog：将 PermissionResult 格式化为可读日志字符串
 * - decisionReasonToString：将 PermissionDecisionReason 格式化为日志字符串
 * - usePermissionRequestLogging：核心钩子，每次权限弹窗展示时触发以下操作：
 *   1. 递增 attribution.permissionPromptCount 归因计数
 *   2. 上报 tengu_tool_use_show_permission_request 通用事件
 *   3. 【ANT-ONLY】若 Bash 工具缺少"始终允许"建议规则，上报专项事件
 *   4. 【ANT-ONLY】上报 Bash 工具调用详情（含命令分片和决策原因）
 *   5. 上报 response unary 事件
 */

import { feature } from 'bun:bundle'
import { useEffect, useRef } from 'react'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js'
import { sanitizeToolNameForAnalytics } from 'src/services/analytics/metadata.js'
import { BashTool } from 'src/tools/BashTool/BashTool.js'
import { splitCommand_DEPRECATED } from 'src/utils/bash/commands.js'
import type {
  PermissionDecisionReason,
  PermissionResult,
} from 'src/utils/permissions/PermissionResult.js'
import {
  extractRules,
  hasRules,
} from 'src/utils/permissions/PermissionUpdate.js'
import { permissionRuleValueToString } from 'src/utils/permissions/permissionRuleParser.js'
import { SandboxManager } from 'src/utils/sandbox/sandbox-adapter.js'
import type { ToolUseConfirm } from '../../components/permissions/PermissionRequest.js'
import { useSetAppState } from '../../state/AppState.js'
import { env } from '../../utils/env.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { type CompletionType, logUnaryEvent } from '../../utils/unaryLogging.js'

// Unary 日志事件的元数据类型，由各权限请求组件传入
export type UnaryEvent = {
  completion_type: CompletionType      // 完成类型，如 tool_use_single
  language_name: string | Promise<string>  // 语言名称（权限场景一般为 'none'）
}

/**
 * permissionResultToLog — 将 PermissionResult 格式化为可读日志字符串
 *
 * 【处理逻辑】
 * - allow：直接返回 'allow'
 * - ask/passthrough：提取建议规则列表并转字符串，附加决策原因
 * - deny：附加拒绝消息和决策原因
 */
function permissionResultToLog(permissionResult: PermissionResult): string {
  switch (permissionResult.behavior) {
    case 'allow':
      return 'allow'
    case 'ask': {
      // 提取 ask 场景下 AI 生成的建议规则，格式化为逗号分隔字符串
      const rules = extractRules(permissionResult.suggestions)
      const suggestions =
        rules.length > 0
          ? rules.map(r => permissionRuleValueToString(r)).join(', ')
          : 'none'
      return `ask: ${permissionResult.message},
suggestions: ${suggestions}
reason: ${decisionReasonToString(permissionResult.decisionReason)}`
    }
    case 'deny':
      return `deny: ${permissionResult.message},
reason: ${decisionReasonToString(permissionResult.decisionReason)}`
    case 'passthrough': {
      // passthrough 场景与 ask 类似，也携带建议规则
      const rules = extractRules(permissionResult.suggestions)
      const suggestions =
        rules.length > 0
          ? rules.map(r => permissionRuleValueToString(r)).join(', ')
          : 'none'
      return `passthrough: ${permissionResult.message},
suggestions: ${suggestions}
reason: ${decisionReasonToString(permissionResult.decisionReason)}`
    }
  }
}

/**
 * decisionReasonToString — 将 PermissionDecisionReason 格式化为日志字符串
 *
 * 【处理逻辑】
 * 1. 若无决策原因，返回 'No decision reason'
 * 2. 若为分类器类型且对应 feature flag 已开启，返回分类器名和原因
 * 3. 其余类型（rule / mode / subcommandResults / permissionPromptTool /
 *    hook / workingDir / safetyCheck / other）各自格式化
 * 4. 未知类型回退到 JSON 序列化
 */
function decisionReasonToString(
  decisionReason: PermissionDecisionReason | undefined,
): string {
  // 无决策原因时返回占位字符串
  if (!decisionReason) {
    return 'No decision reason'
  }
  // 分类器决策原因（需要 BASH_CLASSIFIER 或 TRANSCRIPT_CLASSIFIER feature flag）
  if (
    (feature('BASH_CLASSIFIER') || feature('TRANSCRIPT_CLASSIFIER')) &&
    decisionReason.type === 'classifier'
  ) {
    return `Classifier: ${decisionReason.classifier}, Reason: ${decisionReason.reason}`
  }
  switch (decisionReason.type) {
    case 'rule':
      // 规则匹配决策：输出匹配的规则值
      return `Rule: ${permissionRuleValueToString(decisionReason.rule.ruleValue)}`
    case 'mode':
      // 运行模式决策（如 bypassPermissions 等）
      return `Mode: ${decisionReason.mode}`
    case 'subcommandResults':
      // 子命令结果聚合决策：展开所有子命令及其各自的权限结果
      return `Subcommand Results: ${Array.from(decisionReason.reasons.entries())
        .map(([key, value]) => `${key}: ${permissionResultToLog(value)}`)
        .join(', \n')}`
    case 'permissionPromptTool':
      // 外部权限提示工具决策：展示工具名及其返回结果
      return `Permission Tool: ${decisionReason.permissionPromptToolName}, Result: ${jsonStringify(decisionReason.toolResult)}`
    case 'hook':
      // Hook 决策：展示 hook 名称及可选原因
      return `Hook: ${decisionReason.hookName}${decisionReason.reason ? `, Reason: ${decisionReason.reason}` : ''}`
    case 'workingDir':
      // 工作目录决策
      return `Working Directory: ${decisionReason.reason}`
    case 'safetyCheck':
      // 安全检查决策
      return `Safety check: ${decisionReason.reason}`
    case 'other':
      return `Other: ${decisionReason.reason}`
    default:
      // 未知类型回退到 JSON 序列化
      return jsonStringify(decisionReason, null, 2)
  }
}

/**
 * usePermissionRequestLogging — 权限请求事件上报钩子
 *
 * 【调用方】所有权限请求组件，在弹窗首次展示时触发。
 *
 * 【执行流程】
 * 1. 通过 loggedToolUseID ref 去重，防止同一弹窗多次触发（规避父组件重渲染引发的无限循环）
 * 2. 递增全局 attribution.permissionPromptCount，用于归因分析
 * 3. 上报 tengu_tool_use_show_permission_request 通用权限弹窗展示事件
 * 4. 【仅限 ANT 内部构建】若当前工具为 Bash 且缺少"始终允许"建议规则：
 *    上报 tengu_internal_tool_use_permission_request_no_always_allow 专项事件
 *    （注意：该事件含代码/路径，不得在外部构建中上报）
 * 5. 【仅限 ANT 内部构建】若当前工具为 Bash 且正在弹窗请求权限：
 *    解析命令分片，上报 tengu_internal_bash_tool_use_permission_request 详情事件
 * 6. 上报 response unary 事件，记录权限弹窗出现节点
 */
export function usePermissionRequestLogging(
  toolUseConfirm: ToolUseConfirm,
  unaryEvent: UnaryEvent,
): void {
  const setAppState = useSetAppState()

  // 使用 ref 记录已上报的 toolUseID，防止同一弹窗因父组件重渲染触发多次 effect。
  // 若不去重，每次 re-fire 都会执行 setAppState spread + ANT 构建中的 splitCommand shell-quote
  // 正则，导致 CPU 100% 占用且内存以 ~500MB/min 的速度泄漏（JSRopeString/RegExp 分配）。
  // 组件以 toolUseID 作为 key，remount 时 ref 重置，因此只需在单个对话框实例内去重。
  const loggedToolUseID = useRef<string | null>(null)

  useEffect(() => {
    // 若当前 toolUseID 已上报，直接跳过，防止重复上报
    if (loggedToolUseID.current === toolUseConfirm.toolUseID) {
      return
    }
    loggedToolUseID.current = toolUseConfirm.toolUseID

    // ── 步骤 1：递增权限弹窗展示计数，用于后续归因分析 ──────────────────
    setAppState(prev => ({
      ...prev,
      attribution: {
        ...prev.attribution,
        permissionPromptCount: prev.attribution.permissionPromptCount + 1,
      },
    }))

    // ── 步骤 2：上报通用权限弹窗展示 Analytics 事件 ──────────────────────
    logEvent('tengu_tool_use_show_permission_request', {
      messageID: toolUseConfirm.assistantMessage.message
        .id as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      toolName: sanitizeToolNameForAnalytics(toolUseConfirm.tool.name),
      isMcp: toolUseConfirm.tool.isMcp ?? false,
      decisionReasonType: toolUseConfirm.permissionResult.decisionReason
        ?.type as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      sandboxEnabled: SandboxManager.isSandboxingEnabled(),
    })

    // ── 步骤 3：【ANT-ONLY】Bash 工具缺少"始终允许"建议规则时的专项上报 ──
    if (process.env.USER_TYPE === 'ant') {
      const permissionResult = toolUseConfirm.permissionResult
      if (
        toolUseConfirm.tool.name === BashTool.name &&
        permissionResult.behavior === 'ask' &&
        !hasRules(permissionResult.suggestions)  // 无任何规则建议时触发
      ) {
        // 注意：decisionReasonDetails 字段含代码/路径，外部构建中不得上报
        logEvent('tengu_internal_tool_use_permission_request_no_always_allow', {
          messageID: toolUseConfirm.assistantMessage.message
            .id as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          toolName: sanitizeToolNameForAnalytics(toolUseConfirm.tool.name),
          isMcp: toolUseConfirm.tool.isMcp ?? false,
          decisionReasonType: (permissionResult.decisionReason?.type ??
            'unknown') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          sandboxEnabled: SandboxManager.isSandboxingEnabled(),

          // This DOES contain code/filepaths and should not be logged in the public build!
          decisionReasonDetails: decisionReasonToString(
            permissionResult.decisionReason,
          ) as never,
        })
      }
    }

    // ── 步骤 4：【ANT-ONLY】上报 Bash 工具调用详情，用于分类和归因分析 ──
    if (process.env.USER_TYPE === 'ant') {
      const parsedInput = BashTool.inputSchema.safeParse(toolUseConfirm.input)
      if (
        toolUseConfirm.tool.name === BashTool.name &&
        toolUseConfirm.permissionResult.behavior === 'ask' &&
        parsedInput.success
      ) {
        // 注意：此事件的所有元数据字段均含代码/路径
        let split = [parsedInput.data.command]
        try {
          // 尝试将命令拆分为子命令列表（已废弃的旧版 API，但此处仍使用）
          split = splitCommand_DEPRECATED(parsedInput.data.command)
        } catch {
          // 解析失败时回退到完整命令字符串，不影响上报
        }
        logEvent('tengu_internal_bash_tool_use_permission_request', {
          parts: jsonStringify(
            split,
          ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          input: jsonStringify(
            toolUseConfirm.input,
          ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          decisionReasonType: toolUseConfirm.permissionResult.decisionReason
            ?.type as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          decisionReason: decisionReasonToString(
            toolUseConfirm.permissionResult.decisionReason,
          ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        })
      }
    }

    // ── 步骤 5：上报 response unary 事件，标记权限弹窗出现时间点 ─────────
    void logUnaryEvent({
      completion_type: unaryEvent.completion_type,
      event: 'response',
      metadata: {
        language_name: unaryEvent.language_name,
        message_id: toolUseConfirm.assistantMessage.message.id,
        platform: env.platform,
      },
    })
  }, [toolUseConfirm, unaryEvent, setAppState])
}
