/**
 * SkillTool/SkillTool.ts — Skill 工具主体定义
 *
 * 在 Claude Code 系统流程中的位置：
 *   工具层（Tools Layer）→ SkillTool 子模块 → 工具执行层
 *
 * 主要功能：
 *   1. getAllCommands：获取本地命令与 MCP skill 的合并列表（去重）
 *   2. executeForkedSkill：在独立子代理（forked sub-agent）中执行 skill，
 *      具备独立 token 预算和进度回调
 *   3. SkillTool 定义：
 *      - validateInput：检查技能名合法性、存在性、可执行性
 *      - checkPermissions：规则匹配（deny/allow）、远程标准技能自动授权、
 *        安全属性自动授权、否则弹窗询问
 *      - call：远程标准技能 → forked → inline 三段路由；内联技能扩展后
 *        通过 contextModifier 传递 allowedTools/model/effort 给父对话
 *      - mapToolResultToToolResultBlockParam：按执行模式返回对应的文本摘要
 *   4. SAFE_SKILL_PROPERTIES：属性白名单，仅含白名单属性的技能自动获授权
 *   5. skillHasOnlySafeProperties / isOfficialMarketplaceSkill：权限辅助函数
 *   6. executeRemoteSkill：加载远程 SKILL.md（AKI/GCS），注入 base dir 头部，
 *      注册至 invokedSkills，以 user message 形式注入对话
 *
 * 设计说明：
 *   - feature('EXPERIMENTAL_SKILL_SEARCH')：编译期 dead-code 开关，
 *     所有远程技能逻辑均在此 guard 下，避免 remoteSkillLoader → akiBackend
 *     的模块级副作用在非实验 build 中被初始化
 *   - remoteSkillModules：通过 require() 动态加载（打破循环依赖），
 *     仅在 feature guard 为 true 时非 null
 *   - toAutoClassifierInput：返回 skill 名（供 backseat 记录技能触发，
 *     但不分类子工具调用）
 */

import { feature } from 'bun:bundle'
import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import uniqBy from 'lodash-es/uniqBy.js'
import { dirname } from 'path'
import { getProjectRoot } from 'src/bootstrap/state.js'
import {
  builtInCommandNames,
  findCommand,
  getCommands,
  type PromptCommand,
} from 'src/commands.js'
import type {
  Tool,
  ToolCallProgress,
  ToolResult,
  ToolUseContext,
  ValidationResult,
} from 'src/Tool.js'
import { buildTool, type ToolDef } from 'src/Tool.js'
import type { Command } from 'src/types/command.js'
import type {
  AssistantMessage,
  AttachmentMessage,
  Message,
  SystemMessage,
  UserMessage,
} from 'src/types/message.js'
import { logForDebugging } from 'src/utils/debug.js'
import type { PermissionDecision } from 'src/utils/permissions/PermissionResult.js'
import { getRuleByContentsForTool } from 'src/utils/permissions/permissions.js'
import {
  isOfficialMarketplaceName,
  parsePluginIdentifier,
} from 'src/utils/plugins/pluginIdentifier.js'
import { buildPluginCommandTelemetryFields } from 'src/utils/telemetry/pluginTelemetry.js'
import { z } from 'zod/v4'
import {
  addInvokedSkill,
  clearInvokedSkillsForAgent,
  getSessionId,
} from '../../bootstrap/state.js'
import { COMMAND_MESSAGE_TAG } from '../../constants/xml.js'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
  logEvent,
} from '../../services/analytics/index.js'
import { getAgentContext } from '../../utils/agentContext.js'
import { errorMessage } from '../../utils/errors.js'
import {
  extractResultText,
  prepareForkedCommandContext,
} from '../../utils/forkedAgent.js'
import { parseFrontmatter } from '../../utils/frontmatterParser.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { createUserMessage, normalizeMessages } from '../../utils/messages.js'
import type { ModelAlias } from '../../utils/model/aliases.js'
import { resolveSkillModelOverride } from '../../utils/model/model.js'
import { recordSkillUsage } from '../../utils/suggestions/skillUsageTracking.js'
import { createAgentId } from '../../utils/uuid.js'
import { runAgent } from '../AgentTool/runAgent.js'
import {
  getToolUseIDFromParentMessage,
  tagMessagesWithToolUseID,
} from '../utils.js'
import { SKILL_TOOL_NAME } from './constants.js'
import { getPrompt } from './prompt.js'
import {
  renderToolResultMessage,
  renderToolUseErrorMessage,
  renderToolUseMessage,
  renderToolUseProgressMessage,
  renderToolUseRejectedMessage,
} from './UI.js'

/**
 * getAllCommands — 获取包含 MCP skill 的完整命令列表
 *
 * 说明：
 *   - getCommands() 仅返回本地/bundled 技能，不含 MCP 技能
 *   - 此函数合并 AppState 中的 MCP skill（loadedFrom === 'mcp'），去重后返回
 *   - MCP prompt（非 skill）被过滤排除，防止模型意外通过猜测名称调用它们
 *
 * @param context 工具调用上下文（含 AppState）
 * @returns 合并去重后的完整命令列表
 */
async function getAllCommands(context: ToolUseContext): Promise<Command[]> {
  // Only include MCP skills (loadedFrom === 'mcp'), not plain MCP prompts.
  // Before this filter, the model could invoke MCP prompts via SkillTool
  // if it guessed the mcp__server__prompt name — they weren't discoverable
  // but were technically reachable.
  // 仅保留 MCP skill（loadedFrom === 'mcp'），排除普通 MCP prompt
  const mcpSkills = context
    .getAppState()
    .mcp.commands.filter(
      cmd => cmd.type === 'prompt' && cmd.loadedFrom === 'mcp',
    )
  // 无 MCP 技能时直接返回本地命令列表（避免不必要的合并操作）
  if (mcpSkills.length === 0) return getCommands(getProjectRoot())
  const localCommands = await getCommands(getProjectRoot())
  // 合并本地命令和 MCP skill，以 name 字段去重（MCP 同名时本地优先）
  return uniqBy([...localCommands, ...mcpSkills], 'name')
}

// Re-export Progress from centralized types to break import cycles
// 从中央类型模块重新导出 Progress，避免循环依赖
export type { SkillToolProgress as Progress } from '../../types/tools.js'

import type { SkillToolProgress as Progress } from '../../types/tools.js'

// Conditional require for remote skill modules — static imports here would
// pull in akiBackend.ts (via remoteSkillLoader → akiBackend), which has
// module-level memoize()/lazySchema() consts that survive tree-shaking as
// side-effecting initializers. All usages are inside
// feature('EXPERIMENTAL_SKILL_SEARCH') guards, so remoteSkillModules is
// non-null at every call site.
// 条件性 require：静态导入会将 akiBackend（含模块级副作用）拉入 bundle；
// 所有调用点都在 feature guard 内，故 remoteSkillModules 非 null 是有保证的
/* eslint-disable @typescript-eslint/no-require-imports */
const remoteSkillModules = feature('EXPERIMENTAL_SKILL_SEARCH')
  ? {
      ...(require('../../services/skillSearch/remoteSkillState.js') as typeof import('../../services/skillSearch/remoteSkillState.js')),
      ...(require('../../services/skillSearch/remoteSkillLoader.js') as typeof import('../../services/skillSearch/remoteSkillLoader.js')),
      ...(require('../../services/skillSearch/telemetry.js') as typeof import('../../services/skillSearch/telemetry.js')),
      ...(require('../../services/skillSearch/featureCheck.js') as typeof import('../../services/skillSearch/featureCheck.js')),
    }
  : null
/* eslint-enable @typescript-eslint/no-require-imports */

/**
 * executeForkedSkill — 在独立子代理中执行技能
 *
 * 整体流程：
 *   1. 记录开始时间，生成唯一 agentId
 *   2. 计算 sanitizedName（内置/bundled/官方技能使用真名，其余用 'custom'）
 *   3. 根据 feature flag 和 plugin 信息组装 analytics 字段
 *   4. 调用 prepareForkedCommandContext 构建子代理定义和初始消息
 *   5. 将技能的 effort 合并进 agentDefinition
 *   6. 调用 runAgent 执行子代理，逐条收集消息并回调进度（tool_use/tool_result 消息触发）
 *   7. extractResultText 从子代理消息中提取最终文本，释放消息内存
 *   8. finally 块清理 invokedSkills 状态
 *
 * @param command 已解析的 prompt 命令对象
 * @param commandName 技能名称（已去除前导斜杠）
 * @param args 可选参数字符串
 * @param context 工具调用上下文
 * @param canUseTool 工具调用授权函数
 * @param parentMessage 父消息（用于提取 toolUseID）
 * @param onProgress 进度回调（可选）
 * @returns 包含 agentId、result 文本的工具执行结果
 */
async function executeForkedSkill(
  command: Command & { type: 'prompt' },
  commandName: string,
  args: string | undefined,
  context: ToolUseContext,
  canUseTool: CanUseToolFn,
  parentMessage: AssistantMessage,
  onProgress?: ToolCallProgress<Progress>,
): Promise<ToolResult<Output>> {
  const startTime = Date.now()
  const agentId = createAgentId()
  // 内置/bundled/官方 marketplace 技能使用真名上报；第三方技能脱敏为 'custom'
  const isBuiltIn = builtInCommandNames().has(commandName)
  const isOfficialSkill = isOfficialMarketplaceSkill(command)
  const isBundled = command.source === 'bundled'
  const forkedSanitizedName =
    isBuiltIn || isBundled || isOfficialSkill ? commandName : 'custom'

  // 仅在 EXPERIMENTAL_SKILL_SEARCH 开启且 skill search 可用时，附加 was_discovered 字段
  const wasDiscoveredField =
    feature('EXPERIMENTAL_SKILL_SEARCH') &&
    remoteSkillModules!.isSkillSearchEnabled()
      ? {
          was_discovered:
            context.discoveredSkillNames?.has(commandName) ?? false,
        }
      : {}
  // 解析 plugin marketplace 信息（用于 analytics 上报）
  const pluginMarketplace = command.pluginInfo
    ? parsePluginIdentifier(command.pluginInfo.repository).marketplace
    : undefined
  const queryDepth = context.queryTracking?.depth ?? 0
  const parentAgentId = getAgentContext()?.agentId
  // 上报技能调用事件（execution_context = 'fork'）
  logEvent('tengu_skill_tool_invocation', {
    command_name:
      forkedSanitizedName as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    // _PROTO_skill_name routes to the privileged skill_name BQ column
    // (unredacted, all users); command_name stays in additional_metadata as
    // the redacted variant for general-access dashboards.
    // _PROTO_skill_name 路由到特权 BQ 列（所有用户不脱敏）；command_name 保留脱敏变体
    _PROTO_skill_name:
      commandName as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
    execution_context:
      'fork' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    // 嵌套调用（queryDepth > 0）标记为 'nested-skill'，顶层标记为 'claude-proactive'
    invocation_trigger: (queryDepth > 0
      ? 'nested-skill'
      : 'claude-proactive') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    query_depth: queryDepth,
    ...(parentAgentId && {
      parent_agent_id:
        parentAgentId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    }),
    ...wasDiscoveredField,
    // 仅内部用户（USER_TYPE=ant）上报详细技能信息，防止第三方技能名泄漏
    ...(process.env.USER_TYPE === 'ant' && {
      skill_name:
        commandName as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      skill_source:
        command.source as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      ...(command.loadedFrom && {
        skill_loaded_from:
          command.loadedFrom as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      }),
      ...(command.kind && {
        skill_kind:
          command.kind as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      }),
    }),
    ...(command.pluginInfo && {
      // _PROTO_* routes to PII-tagged plugin_name/marketplace_name BQ columns
      // (unredacted, all users); plugin_name/plugin_repository stay in
      // additional_metadata as redacted variants.
      // _PROTO_* 路由到 PII 标记的 BQ 列（所有用户不脱敏）
      _PROTO_plugin_name: command.pluginInfo.pluginManifest
        .name as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
      ...(pluginMarketplace && {
        _PROTO_marketplace_name:
          pluginMarketplace as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
      }),
      // 官方 marketplace 技能使用真名；第三方脱敏为 'third-party'
      plugin_name: (isOfficialSkill
        ? command.pluginInfo.pluginManifest.name
        : 'third-party') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      plugin_repository: (isOfficialSkill
        ? command.pluginInfo.repository
        : 'third-party') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      ...buildPluginCommandTelemetryFields(command.pluginInfo),
    }),
  })

  // 构建子代理上下文（含修改后的 getAppState 和初始消息）
  const { modifiedGetAppState, baseAgent, promptMessages, skillContent } =
    await prepareForkedCommandContext(command, args || '', context)

  // Merge skill's effort into the agent definition so runAgent applies it
  // 将技能的 effort 合并进 agentDefinition，使 runAgent 采用技能指定的 effort 级别
  const agentDefinition =
    command.effort !== undefined
      ? { ...baseAgent, effort: command.effort }
      : baseAgent

  // Collect messages from the forked agent
  // 收集子代理输出的所有消息（完成后释放内存）
  const agentMessages: Message[] = []

  logForDebugging(
    `SkillTool executing forked skill ${commandName} with agent ${agentDefinition.agentType}`,
  )

  try {
    // Run the sub-agent
    // 启动子代理并异步迭代所有输出消息
    for await (const message of runAgent({
      agentDefinition,
      promptMessages,
      toolUseContext: {
        ...context,
        getAppState: modifiedGetAppState,
      },
      canUseTool,
      isAsync: false,
      querySource: 'agent:custom',
      // 技能可覆盖模型（如 model: opus），类型断言为 ModelAlias
      model: command.model as ModelAlias | undefined,
      availableTools: context.options.tools,
      override: { agentId },
    })) {
      agentMessages.push(message)

      // Report progress for tool uses (like AgentTool does)
      // 仅当消息含 tool_use 或 tool_result 时触发进度回调（与 AgentTool 行为一致）
      if (
        (message.type === 'assistant' || message.type === 'user') &&
        onProgress
      ) {
        const normalizedNew = normalizeMessages([message])
        for (const m of normalizedNew) {
          const hasToolContent = m.message.content.some(
            c => c.type === 'tool_use' || c.type === 'tool_result',
          )
          if (hasToolContent) {
            onProgress({
              toolUseID: `skill_${parentMessage.message.id}`,
              data: {
                message: m,
                type: 'skill_progress',
                prompt: skillContent,
                agentId,
              },
            })
          }
        }
      }
    }

    // 从子代理消息中提取最终结果文本（优先取最后一条 assistant 消息）
    const resultText = extractResultText(
      agentMessages,
      'Skill execution completed',
    )
    // Release message memory after extracting result
    // 提取结果后立即释放消息数组内存，避免大型对话占用内存
    agentMessages.length = 0

    const durationMs = Date.now() - startTime
    logForDebugging(
      `SkillTool forked skill ${commandName} completed in ${durationMs}ms`,
    )

    return {
      data: {
        success: true,
        commandName,
        status: 'forked',
        agentId,
        result: resultText,
      },
    }
  } finally {
    // Release skill content from invokedSkills state
    // 无论成功还是失败，都清理 invokedSkills 中该子代理的技能状态
    clearInvokedSkillsForAgent(agentId)
  }
}

// 输入 Schema：技能名称（必填）+ 可选参数字符串
export const inputSchema = lazySchema(() =>
  z.object({
    skill: z
      .string()
      .describe('The skill name. E.g., "commit", "review-pr", or "pdf"'),
    args: z.string().optional().describe('Optional arguments for the skill'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

// 输出 Schema：inline（展开至主对话）和 forked（独立子代理）两种模式的联合类型
export const outputSchema = lazySchema(() => {
  // Output schema for inline skills (default)
  // 内联技能输出：含 allowedTools（可选）、model（可选）
  const inlineOutputSchema = z.object({
    success: z.boolean().describe('Whether the skill is valid'),
    commandName: z.string().describe('The name of the skill'),
    allowedTools: z
      .array(z.string())
      .optional()
      .describe('Tools allowed by this skill'),
    model: z.string().optional().describe('Model override if specified'),
    status: z.literal('inline').optional().describe('Execution status'),
  })

  // Output schema for forked skills
  // Forked 技能输出：含 agentId 和最终 result 文本
  const forkedOutputSchema = z.object({
    success: z.boolean().describe('Whether the skill completed successfully'),
    commandName: z.string().describe('The name of the skill'),
    status: z.literal('forked').describe('Execution status'),
    agentId: z
      .string()
      .describe('The ID of the sub-agent that executed the skill'),
    result: z.string().describe('The result from the forked skill execution'),
  })

  return z.union([inlineOutputSchema, forkedOutputSchema])
})
type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.input<OutputSchema>

/**
 * SkillTool — Skill 工具的主体定义
 *
 * 整体流程（validateInput → checkPermissions → call）：
 *
 * validateInput：
 *   1. 校验技能名格式（非空）
 *   2. 去除前导斜杠（兼容 "/commit" 写法）并记录 analytics
 *   3. 远程标准技能（_canonical_<slug>）：验证是否已在会话发现列表中
 *   4. 普通技能：查询命令列表，确认存在且为 prompt 类型且未禁用 model invocation
 *
 * checkPermissions：
 *   1. 检查 deny 规则（精确匹配或前缀通配 "name:*"）
 *   2. 远程标准技能自动授权（在 deny 检查之后）
 *   3. 检查 allow 规则
 *   4. 仅含安全属性的技能自动授权（skillHasOnlySafeProperties）
 *   5. 默认弹窗询问，携带精确和前缀两种建议规则
 *
 * call：
 *   1. 远程标准技能（_canonical_<slug>）→ executeRemoteSkill
 *   2. context === 'fork' 的技能 → executeForkedSkill
 *   3. 其余（inline）→ processPromptSlashCommand 展开后
 *      通过 contextModifier 传递 allowedTools/model/effort
 */
export const SkillTool: Tool<InputSchema, Output, Progress> = buildTool({
  // 工具注册名，供模型调用时识别
  name: SKILL_TOOL_NAME,
  // 自动分类器使用的搜索提示
  searchHint: 'invoke a slash-command skill',
  // 单次工具调用结果的最大字符数
  maxResultSizeChars: 100_000,
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },

  // 工具描述：动态包含当前 skill 名称
  description: async ({ skill }) => `Execute skill: ${skill}`,

  // 系统提示词：以 cwd 为 memoize key 构建
  prompt: async () => getPrompt(getProjectRoot()),

  // Only one skill/command should run at a time, since the tool expands the
  // command into a full prompt that Claude must process before continuing.
  // Skill-coach needs the skill name to avoid false-positive "you could have
  // used skill X" suggestions when X was actually invoked. Backseat classifies
  // downstream tool calls from the expanded prompt, not this wrapper, so the
  // name alone is sufficient — it just records that the skill fired.
  // 自动分类器输入：返回技能名（skill-coach 用于排除已调用技能的错误建议）
  toAutoClassifierInput: ({ skill }) => skill ?? '',

  /**
   * validateInput — 验证技能调用输入的合法性
   *
   * 整体流程：
   *   1. 去除首尾空格，空字符串直接返回 false（errorCode=1）
   *   2. 若有前导斜杠，记录 analytics 并去除（兼容处理）
   *   3. 远程标准技能（_canonical_ 前缀）：检查会话发现状态（errorCode=6）
   *   4. 查询命令列表，命令不存在返回 errorCode=2
   *   5. disableModelInvocation 为 true 返回 errorCode=4
   *   6. 非 prompt 类型命令返回 errorCode=5
   */
  async validateInput({ skill }, context): Promise<ValidationResult> {
    // Skills are just skill names, no arguments
    const trimmed = skill.trim()
    // 技能名为空时，直接拒绝（errorCode=1）
    if (!trimmed) {
      return {
        result: false,
        message: `Invalid skill format: ${skill}`,
        errorCode: 1,
      }
    }

    // Remove leading slash if present (for compatibility)
    // 兼容 "/commit" 写法：记录事件后去除前导斜杠
    const hasLeadingSlash = trimmed.startsWith('/')
    if (hasLeadingSlash) {
      logEvent('tengu_skill_tool_slash_prefix', {})
    }
    const normalizedCommandName = hasLeadingSlash
      ? trimmed.substring(1)
      : trimmed

    // Remote canonical skill handling (ant-only experimental). Intercept
    // `_canonical_<slug>` names before local command lookup since remote
    // skills are not in the local command registry.
    // 远程标准技能（ant 专属实验）：在本地命令查询前拦截 _canonical_<slug> 格式
    if (
      feature('EXPERIMENTAL_SKILL_SEARCH') &&
      process.env.USER_TYPE === 'ant'
    ) {
      const slug = remoteSkillModules!.stripCanonicalPrefix(
        normalizedCommandName,
      )
      if (slug !== null) {
        const meta = remoteSkillModules!.getDiscoveredRemoteSkill(slug)
        // 远程技能未在会话中发现时，拒绝调用（需先调用 DiscoverSkills）
        if (!meta) {
          return {
            result: false,
            message: `Remote skill ${slug} was not discovered in this session. Use DiscoverSkills to find remote skills first.`,
            errorCode: 6,
          }
        }
        // Discovered remote skill — valid. Loading happens in call().
        // 已发现的远程技能视为有效，实际加载在 call() 中进行
        return { result: true }
      }
    }

    // Get available commands (including MCP skills)
    // 获取包含 MCP 技能的完整命令列表
    const commands = await getAllCommands(context)

    // Check if command exists
    // 命令不存在时返回错误（errorCode=2）
    const foundCommand = findCommand(normalizedCommandName, commands)
    if (!foundCommand) {
      return {
        result: false,
        message: `Unknown skill: ${normalizedCommandName}`,
        errorCode: 2,
      }
    }

    // Check if command has model invocation disabled
    // 已禁用模型调用的技能不能通过 SkillTool 触发（errorCode=4）
    if (foundCommand.disableModelInvocation) {
      return {
        result: false,
        message: `Skill ${normalizedCommandName} cannot be used with ${SKILL_TOOL_NAME} tool due to disable-model-invocation`,
        errorCode: 4,
      }
    }

    // Check if command is a prompt-based command
    // 仅 prompt 类型的命令可以通过 SkillTool 触发（errorCode=5）
    if (foundCommand.type !== 'prompt') {
      return {
        result: false,
        message: `Skill ${normalizedCommandName} is not a prompt-based skill`,
        errorCode: 5,
      }
    }

    return { result: true }
  },

  /**
   * checkPermissions — 技能调用的权限检查
   *
   * 整体流程：
   *   1. 规范化技能名（去除前导斜杠）
   *   2. 获取当前权限上下文中的 deny 规则，逐一匹配（精确匹配 + 前缀通配）
   *   3. 远程标准技能（_canonical_）自动授权（在 deny 之后，allow 之前）
   *   4. 检查 allow 规则，匹配时直接授权
   *   5. 仅含安全属性的技能（skillHasOnlySafeProperties）自动授权
   *   6. 默认行为：弹窗询问，携带精确和前缀两种建议规则供用户一键添加
   */
  async checkPermissions(
    { skill, args },
    context,
  ): Promise<PermissionDecision> {
    // Skills are just skill names, no arguments
    const trimmed = skill.trim()

    // Remove leading slash if present (for compatibility)
    // 规范化技能名（去除前导斜杠）
    const commandName = trimmed.startsWith('/') ? trimmed.substring(1) : trimmed

    const appState = context.getAppState()
    const permissionContext = appState.toolPermissionContext

    // Look up the command object to pass as metadata
    // 查询命令对象，用于后续的 skillHasOnlySafeProperties 检查和弹窗元数据
    const commands = await getAllCommands(context)
    const commandObj = findCommand(commandName, commands)

    // Helper function to check if a rule matches the skill
    // Normalizes both inputs by stripping leading slashes for consistent matching
    // 规则匹配辅助函数：支持精确匹配和前缀通配（"name:*"）
    const ruleMatches = (ruleContent: string): boolean => {
      // Normalize rule content by stripping leading slash
      // 规范化规则内容（去除前导斜杠后比较）
      const normalizedRule = ruleContent.startsWith('/')
        ? ruleContent.substring(1)
        : ruleContent

      // Check exact match (using normalized commandName)
      // 精确匹配
      if (normalizedRule === commandName) {
        return true
      }
      // Check prefix match (e.g., "review:*" matches "review-pr 123")
      // 前缀通配匹配（如 "review:*" 匹配 "review-pr"）
      if (normalizedRule.endsWith(':*')) {
        const prefix = normalizedRule.slice(0, -2) // Remove ':*'
        return commandName.startsWith(prefix)
      }
      return false
    }

    // Check for deny rules
    // 检查 deny 规则（优先级最高，匹配即拒绝）
    const denyRules = getRuleByContentsForTool(
      permissionContext,
      SkillTool as Tool,
      'deny',
    )
    for (const [ruleContent, rule] of denyRules.entries()) {
      if (ruleMatches(ruleContent)) {
        return {
          behavior: 'deny',
          message: `Skill execution blocked by permission rules`,
          decisionReason: {
            type: 'rule',
            rule,
          },
        }
      }
    }

    // Remote canonical skills are ant-only experimental — auto-grant.
    // Placed AFTER the deny loop so a user-configured Skill(_canonical_:*)
    // deny rule is honored (same pattern as safe-properties auto-allow below).
    // The skill content itself is canonical/curated, not user-authored.
    // 远程标准技能自动授权（在 deny 检查之后，以确保用户 deny 规则仍然有效）
    if (
      feature('EXPERIMENTAL_SKILL_SEARCH') &&
      process.env.USER_TYPE === 'ant'
    ) {
      const slug = remoteSkillModules!.stripCanonicalPrefix(commandName)
      if (slug !== null) {
        return {
          behavior: 'allow',
          updatedInput: { skill, args },
          decisionReason: undefined,
        }
      }
    }

    // Check for allow rules
    // 检查 allow 规则，匹配时授权（携带 rule 信息用于 UI 展示）
    const allowRules = getRuleByContentsForTool(
      permissionContext,
      SkillTool as Tool,
      'allow',
    )
    for (const [ruleContent, rule] of allowRules.entries()) {
      if (ruleMatches(ruleContent)) {
        return {
          behavior: 'allow',
          updatedInput: { skill, args },
          decisionReason: {
            type: 'rule',
            rule,
          },
        }
      }
    }

    // Auto-allow skills that only use safe properties.
    // This is an allowlist: if a skill has any property NOT in this set with a
    // meaningful value, it requires permission. This ensures new properties added
    // in the future default to requiring permission.
    // 仅含安全属性的技能自动授权（白名单机制：未来新属性默认需要权限）
    if (
      commandObj?.type === 'prompt' &&
      skillHasOnlySafeProperties(commandObj)
    ) {
      return {
        behavior: 'allow',
        updatedInput: { skill, args },
        decisionReason: undefined,
      }
    }

    // Prepare suggestions for exact skill and prefix
    // Use normalized commandName (without leading slash) for consistent rules
    // 构建两种建议规则：精确匹配和前缀通配（供用户一键添加到本地设置）
    const suggestions = [
      // Exact skill suggestion
      // 精确匹配规则建议
      {
        type: 'addRules' as const,
        rules: [
          {
            toolName: SKILL_TOOL_NAME,
            ruleContent: commandName,
          },
        ],
        behavior: 'allow' as const,
        destination: 'localSettings' as const,
      },
      // Prefix suggestion to allow any args
      // 前缀通配规则建议（允许该技能的任意参数变体）
      {
        type: 'addRules' as const,
        rules: [
          {
            toolName: SKILL_TOOL_NAME,
            ruleContent: `${commandName}:*`,
          },
        ],
        behavior: 'allow' as const,
        destination: 'localSettings' as const,
      },
    ]

    // Default behavior: ask user for permission
    // 默认行为：弹窗询问，携带命令元数据和规则建议
    return {
      behavior: 'ask',
      message: `Execute skill: ${commandName}`,
      decisionReason: undefined,
      suggestions,
      updatedInput: { skill, args },
      metadata: commandObj ? { command: commandObj } : undefined,
    }
  },

  /**
   * call — 技能执行主逻辑
   *
   * 整体流程：
   *   1. 规范化技能名（去除前导斜杠）
   *   2. 远程标准技能（_canonical_）→ executeRemoteSkill（直接注入 SKILL.md）
   *   3. context === 'fork' 的技能 → executeForkedSkill（独立子代理执行）
   *   4. 其余（inline）：
   *      a. processPromptSlashCommand 展开技能（含 !command/$ARGUMENTS 替换）
   *      b. 过滤 command-message 标签（SkillTool 自行处理展示）
   *      c. 通过 contextModifier 将 allowedTools/model/effort 传递给父对话上下文
   *      d. 返回 newMessages 供主循环注入
   */
  async call(
    { skill, args },
    context,
    canUseTool,
    parentMessage,
    onProgress?,
  ): Promise<ToolResult<Output>> {
    // At this point, validateInput has already confirmed:
    // - Skill format is valid
    // - Skill exists
    // - Skill can be loaded
    // - Skill doesn't have disableModelInvocation
    // - Skill is a prompt-based skill
    // validateInput 已完成所有前置校验，此处可直接执行

    // Skills are just names, with optional arguments
    const trimmed = skill.trim()

    // Remove leading slash if present (for compatibility)
    // 去除前导斜杠（兼容 "/commit" 写法）
    const commandName = trimmed.startsWith('/') ? trimmed.substring(1) : trimmed

    // Remote canonical skill execution (ant-only experimental). Intercepts
    // `_canonical_<slug>` before local command lookup — loads SKILL.md from
    // AKI/GCS (with local cache), injects content directly as a user message.
    // Remote skills are declarative markdown so no slash-command expansion
    // (no !command substitution, no $ARGUMENTS interpolation) is needed.
    // 远程标准技能：绕过本地命令查询，直接从 AKI/GCS 加载 SKILL.md 并注入
    if (
      feature('EXPERIMENTAL_SKILL_SEARCH') &&
      process.env.USER_TYPE === 'ant'
    ) {
      const slug = remoteSkillModules!.stripCanonicalPrefix(commandName)
      if (slug !== null) {
        return executeRemoteSkill(slug, commandName, parentMessage, context)
      }
    }

    // 获取包含 MCP 技能的完整命令列表
    const commands = await getAllCommands(context)
    const command = findCommand(commandName, commands)

    // Track skill usage for ranking
    // 记录技能使用频次（用于技能排名和建议）
    recordSkillUsage(commandName)

    // Check if skill should run as a forked sub-agent
    // Forked 技能（context === 'fork'）在独立子代理中执行
    if (command?.type === 'prompt' && command.context === 'fork') {
      return executeForkedSkill(
        command,
        commandName,
        args,
        context,
        canUseTool,
        parentMessage,
        onProgress,
      )
    }

    // Process the skill with optional args
    // 展开内联技能（含 !command 替换、$ARGUMENTS 注入、frontmatter 解析等）
    const { processPromptSlashCommand } = await import(
      'src/utils/processUserInput/processSlashCommand.js'
    )
    const processedCommand = await processPromptSlashCommand(
      commandName,
      args || '', // Pass args if provided
      commands,
      context,
    )

    if (!processedCommand.shouldQuery) {
      throw new Error('Command processing failed')
    }

    // Extract metadata from the command
    // 提取技能的 allowedTools、model、effort 配置
    const allowedTools = processedCommand.allowedTools || []
    const model = processedCommand.model
    const effort = command?.type === 'prompt' ? command.effort : undefined

    // 计算 sanitizedName（内置/bundled/官方 marketplace 技能用真名，第三方脱敏）
    const isBuiltIn = builtInCommandNames().has(commandName)
    const isBundled = command?.type === 'prompt' && command.source === 'bundled'
    const isOfficialSkill =
      command?.type === 'prompt' && isOfficialMarketplaceSkill(command)
    const sanitizedCommandName =
      isBuiltIn || isBundled || isOfficialSkill ? commandName : 'custom'

    // 同样根据 feature flag 决定是否附加 was_discovered 字段
    const wasDiscoveredField =
      feature('EXPERIMENTAL_SKILL_SEARCH') &&
      remoteSkillModules!.isSkillSearchEnabled()
        ? {
            was_discovered:
              context.discoveredSkillNames?.has(commandName) ?? false,
          }
        : {}
    const pluginMarketplace =
      command?.type === 'prompt' && command.pluginInfo
        ? parsePluginIdentifier(command.pluginInfo.repository).marketplace
        : undefined
    const queryDepth = context.queryTracking?.depth ?? 0
    const parentAgentId = getAgentContext()?.agentId
    // 上报内联技能调用事件（execution_context = 'inline'）
    logEvent('tengu_skill_tool_invocation', {
      command_name:
        sanitizedCommandName as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      // _PROTO_skill_name routes to the privileged skill_name BQ column
      // (unredacted, all users); command_name stays in additional_metadata as
      // the redacted variant for general-access dashboards.
      _PROTO_skill_name:
        commandName as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
      execution_context:
        'inline' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      invocation_trigger: (queryDepth > 0
        ? 'nested-skill'
        : 'claude-proactive') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      query_depth: queryDepth,
      ...(parentAgentId && {
        parent_agent_id:
          parentAgentId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      }),
      ...wasDiscoveredField,
      ...(process.env.USER_TYPE === 'ant' && {
        skill_name:
          commandName as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        ...(command?.type === 'prompt' && {
          skill_source:
            command.source as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        }),
        ...(command?.loadedFrom && {
          skill_loaded_from:
            command.loadedFrom as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        }),
        ...(command?.kind && {
          skill_kind:
            command.kind as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        }),
      }),
      ...(command?.type === 'prompt' &&
        command.pluginInfo && {
          _PROTO_plugin_name: command.pluginInfo.pluginManifest
            .name as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
          ...(pluginMarketplace && {
            _PROTO_marketplace_name:
              pluginMarketplace as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
          }),
          plugin_name: (isOfficialSkill
            ? command.pluginInfo.pluginManifest.name
            : 'third-party') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          plugin_repository: (isOfficialSkill
            ? command.pluginInfo.repository
            : 'third-party') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          ...buildPluginCommandTelemetryFields(command.pluginInfo),
        }),
    })

    // Get the tool use ID from the parent message for linking newMessages
    // 从父消息中提取 toolUseID，用于将新消息关联到本次工具调用
    const toolUseID = getToolUseIDFromParentMessage(
      parentMessage,
      SKILL_TOOL_NAME,
    )

    // Tag user messages with sourceToolUseID so they stay transient until this tool resolves
    // 为新消息打上 sourceToolUseID 标签，使其在工具调用结束前保持临时状态
    const newMessages = tagMessagesWithToolUseID(
      processedCommand.messages.filter(
        (m): m is UserMessage | AttachmentMessage | SystemMessage => {
          if (m.type === 'progress') {
            return false
          }
          // Filter out command-message since SkillTool handles display
          // 过滤 command-message 标签（SkillTool 通过 renderToolUseMessage 自行处理展示）
          if (m.type === 'user' && 'message' in m) {
            const content = m.message.content
            if (
              typeof content === 'string' &&
              content.includes(`<${COMMAND_MESSAGE_TAG}>`)
            ) {
              return false
            }
          }
          return true
        },
      ),
      toolUseID,
    )

    logForDebugging(
      `SkillTool returning ${newMessages.length} newMessages for skill ${commandName}`,
    )

    // Note: addInvokedSkill and registerSkillHooks are called inside
    // processPromptSlashCommand (via getMessagesForPromptSlashCommand), so
    // calling them again here would double-register hooks and rebuild
    // skillContent redundantly.
    // 注意：addInvokedSkill 和 registerSkillHooks 已在 processPromptSlashCommand 内部调用，
    // 此处不需要重复调用（否则会导致双重注册）

    // Return success with newMessages and contextModifier
    // 返回成功结果，含 newMessages 和上下文修改器（传递 allowedTools/model/effort）
    return {
      data: {
        success: true,
        commandName,
        allowedTools: allowedTools.length > 0 ? allowedTools : undefined,
        model,
      },
      newMessages,
      contextModifier(ctx) {
        let modifiedContext = ctx

        // Update allowed tools if specified
        // 若技能指定了 allowedTools，将其追加到父对话的 alwaysAllowRules
        if (allowedTools.length > 0) {
          // Capture the current getAppState to chain modifications properly
          // 捕获当前 getAppState 以正确链式处理多次上下文修改
          const previousGetAppState = modifiedContext.getAppState
          modifiedContext = {
            ...modifiedContext,
            getAppState() {
              // Use the previous getAppState, not the closure's context.getAppState,
              // to properly chain context modifications
              // 使用上一层的 getAppState（而非闭包中的 context.getAppState），确保链式修改正确
              const appState = previousGetAppState()
              return {
                ...appState,
                toolPermissionContext: {
                  ...appState.toolPermissionContext,
                  alwaysAllowRules: {
                    ...appState.toolPermissionContext.alwaysAllowRules,
                    command: [
                      ...new Set([
                        ...(appState.toolPermissionContext.alwaysAllowRules
                          .command || []),
                        ...allowedTools,
                      ]),
                    ],
                  },
                },
              }
            },
          }
        }

        // Carry [1m] suffix over — otherwise a skill with `model: opus` on an
        // opus[1m] session drops the effective window to 200K and trips autocompact.
        // 若技能指定了模型，解析并传递给父对话（同时保留 [1m] 后缀，防止上下文窗口意外缩减）
        if (model) {
          modifiedContext = {
            ...modifiedContext,
            options: {
              ...modifiedContext.options,
              mainLoopModel: resolveSkillModelOverride(
                model,
                ctx.options.mainLoopModel,
              ),
            },
          }
        }

        // Override effort level if skill specifies one
        // 若技能指定了 effort，覆盖父对话的 effortValue
        if (effort !== undefined) {
          const previousGetAppState = modifiedContext.getAppState
          modifiedContext = {
            ...modifiedContext,
            getAppState() {
              const appState = previousGetAppState()
              return {
                ...appState,
                effortValue: effort,
              }
            },
          }
        }

        return modifiedContext
      },
    }
  },

  /**
   * mapToolResultToToolResultBlockParam — 将工具输出映射为 API 格式的 tool_result 块
   *
   * 整体流程：
   *   - forked 模式（status === 'forked'）：返回完整的 result 文本
   *   - inline 模式（默认）：仅返回 "Launching skill: <name>" 简短提示
   *     （实际技能内容已通过 newMessages 注入对话）
   */
  mapToolResultToToolResultBlockParam(
    result: Output,
    toolUseID: string,
  ): ToolResultBlockParam {
    // Handle forked skill result
    // forked 技能：返回子代理执行结果摘要
    if ('status' in result && result.status === 'forked') {
      return {
        type: 'tool_result' as const,
        tool_use_id: toolUseID,
        content: `Skill "${result.commandName}" completed (forked execution).\n\nResult:\n${result.result}`,
      }
    }

    // Inline skill result (default)
    // 内联技能：返回简短启动提示（实际内容已通过 newMessages 注入）
    return {
      type: 'tool_result' as const,
      tool_use_id: toolUseID,
      content: `Launching skill: ${result.commandName}`,
    }
  },

  // UI 渲染函数：从 UI.tsx 模块中导入
  renderToolResultMessage,
  renderToolUseMessage,
  renderToolUseProgressMessage,
  renderToolUseRejectedMessage,
  renderToolUseErrorMessage,
} satisfies ToolDef<InputSchema, Output, Progress>)

// Allowlist of PromptCommand property keys that are safe and don't require permission.
// If a skill has any property NOT in this set with a meaningful value, it requires
// permission. This ensures new properties added to PromptCommand in the future
// default to requiring permission until explicitly reviewed and added here.
/**
 * SAFE_SKILL_PROPERTIES — 技能安全属性白名单
 *
 * 仅含白名单属性的技能（无副作用属性）自动获得执行授权，无需用户确认。
 * 这是一个正向白名单（allowlist）：未来新增的属性默认不在白名单中，
 * 需要开发者审查后显式添加，确保新属性默认要求权限确认。
 */
const SAFE_SKILL_PROPERTIES = new Set([
  // PromptCommand properties
  'type',
  'progressMessage',
  'contentLength',
  'argNames',
  'model',
  'effort',
  'source',
  'pluginInfo',
  'disableNonInteractive',
  'skillRoot',
  'context',
  'agent',
  'getPromptForCommand',
  'frontmatterKeys',
  // CommandBase properties
  'name',
  'description',
  'hasUserSpecifiedDescription',
  'isEnabled',
  'isHidden',
  'aliases',
  'isMcp',
  'argumentHint',
  'whenToUse',
  'paths',
  'version',
  'disableModelInvocation',
  'userInvocable',
  'loadedFrom',
  'immediate',
  'userFacingName',
])

/**
 * skillHasOnlySafeProperties — 检查技能是否仅含安全属性
 *
 * 整体流程：
 *   1. 遍历命令对象的所有属性键
 *   2. 若属性在 SAFE_SKILL_PROPERTIES 白名单中，跳过
 *   3. 若属性值为 undefined/null、空数组、空对象，视为无意义值，跳过
 *   4. 发现任何非白名单的有意义属性，立即返回 false
 *   5. 所有属性均安全时返回 true
 *
 * @param command 待检查的命令对象
 * @returns true 表示技能仅含安全属性，可自动授权
 */
function skillHasOnlySafeProperties(command: Command): boolean {
  for (const key of Object.keys(command)) {
    // 白名单属性直接跳过
    if (SAFE_SKILL_PROPERTIES.has(key)) {
      continue
    }
    // Property not in safe allowlist - check if it has a meaningful value
    // 非白名单属性：检查是否有有意义的值（null/undefined/空集合视为无意义）
    const value = (command as Record<string, unknown>)[key]
    if (value === undefined || value === null) {
      continue
    }
    // 空数组视为无意义值
    if (Array.isArray(value) && value.length === 0) {
      continue
    }
    // 空对象视为无意义值
    if (
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.keys(value).length === 0
    ) {
      continue
    }
    // 发现非白名单的有意义属性，需要权限确认
    return false
  }
  return true
}

/**
 * isOfficialMarketplaceSkill — 检查技能是否来自官方 marketplace
 *
 * 判断条件：
 *   1. source === 'plugin'（插件来源）
 *   2. 具有 pluginInfo.repository（包含仓库信息）
 *   3. repository 对应的 marketplace 名称在官方 marketplace 列表中
 *
 * @param command 待检查的 prompt 命令对象
 * @returns true 表示来自官方 marketplace
 */
function isOfficialMarketplaceSkill(command: PromptCommand): boolean {
  // 非 plugin 来源或无仓库信息时，直接返回 false
  if (command.source !== 'plugin' || !command.pluginInfo?.repository) {
    return false
  }
  // 解析 marketplace 名称后判断是否为官方 marketplace
  return isOfficialMarketplaceName(
    parsePluginIdentifier(command.pluginInfo.repository).marketplace,
  )
}

/**
 * Extract URL scheme for telemetry. Defaults to 'gs' for unrecognized schemes
 * since the AKI backend is the only production path and the loader throws on
 * unknown schemes before we reach telemetry anyway.
 *
 * 提取 URL scheme 用于遥测上报。
 * 未识别的 scheme 默认为 'gs'（AKI 后端是生产路径，loader 会在遥测前抛错）
 *
 * @param url 远程技能 URL
 * @returns 'gs' | 'http' | 'https' | 's3'
 */
function extractUrlScheme(url: string): 'gs' | 'http' | 'https' | 's3' {
  if (url.startsWith('gs://')) return 'gs'
  if (url.startsWith('https://')) return 'https'
  if (url.startsWith('http://')) return 'http'
  if (url.startsWith('s3://')) return 's3'
  // 未识别的 scheme 默认为 'gs'
  return 'gs'
}

/**
 * executeRemoteSkill — 加载并注入远程标准技能内容
 *
 * 整体流程：
 *   1. 从会话发现状态中获取技能元数据（URL）
 *   2. 调用 loadRemoteSkill 从 AKI/GCS 加载（含本地缓存）
 *   3. 上报遥测事件（含 cacheHit、latencyMs、urlScheme 等）
 *   4. 去除 YAML frontmatter（与 loadSkillsDir.ts 一致）
 *   5. 注入 Base directory 头部，替换 ${CLAUDE_SKILL_DIR}/${CLAUDE_SESSION_ID} 变量
 *   6. 通过 addInvokedSkill 注册至会话状态（供 compaction 恢复）
 *   7. 将 finalContent 包装为 isMeta user message，通过 newMessages 注入对话
 *
 * 与本地技能的关键区别：
 *   - 跳过 processPromptSlashCommand（无 !command/$ARGUMENTS 展开）
 *   - SKILL.md 内容直接注入，无需命令注册表
 *   - status 返回 'inline'（复用内联技能的展示逻辑）
 *
 * 仅在 feature('EXPERIMENTAL_SKILL_SEARCH') guard 内调用，remoteSkillModules 非 null
 *
 * @param slug 技能 slug（去除 _canonical_ 前缀后的标识符）
 * @param commandName 完整命令名（含 _canonical_ 前缀，用于日志和 invokedSkills）
 * @param parentMessage 父消息（用于提取 toolUseID）
 * @param context 工具调用上下文
 * @returns 注入了 SKILL.md 内容的工具执行结果
 */
async function executeRemoteSkill(
  slug: string,
  commandName: string,
  parentMessage: AssistantMessage,
  context: ToolUseContext,
): Promise<ToolResult<Output>> {
  const { getDiscoveredRemoteSkill, loadRemoteSkill, logRemoteSkillLoaded } =
    remoteSkillModules!

  // validateInput already confirmed this slug is in session state, but we
  // re-fetch here to get the URL. If it's somehow gone (e.g., state cleared
  // mid-session), fail with a clear error rather than crashing.
  // validateInput 已确认 slug 存在，但重新获取以得到 URL；
  // 若会话状态已清除（极端情况），则给出清晰错误而非崩溃
  const meta = getDiscoveredRemoteSkill(slug)
  if (!meta) {
    throw new Error(
      `Remote skill ${slug} was not discovered in this session. Use DiscoverSkills to find remote skills first.`,
    )
  }

  // 提取 URL scheme 用于遥测
  const urlScheme = extractUrlScheme(meta.url)
  let loadResult
  try {
    // 从 AKI/GCS 加载技能内容（含本地缓存）
    loadResult = await loadRemoteSkill(slug, meta.url)
  } catch (e) {
    const msg = errorMessage(e)
    // 加载失败时记录遥测后重新抛出
    logRemoteSkillLoaded({
      slug,
      cacheHit: false,
      latencyMs: 0,
      urlScheme,
      error: msg,
    })
    throw new Error(`Failed to load remote skill ${slug}: ${msg}`)
  }

  // 解构加载结果
  const {
    cacheHit,
    latencyMs,
    skillPath,
    content,
    fileCount,
    totalBytes,
    fetchMethod,
  } = loadResult

  // 上报加载成功的遥测事件
  logRemoteSkillLoaded({
    slug,
    cacheHit,
    latencyMs,
    urlScheme,
    fileCount,
    totalBytes,
    fetchMethod,
  })

  // Remote skills are always model-discovered (never in static skill_listing),
  // so was_discovered is always true. is_remote lets BQ queries separate
  // remote from local invocations without joining on skill name prefixes.
  // 远程技能始终为 was_discovered=true；is_remote=true 用于 BQ 查询区分本地与远程调用
  const queryDepth = context.queryTracking?.depth ?? 0
  const parentAgentId = getAgentContext()?.agentId
  logEvent('tengu_skill_tool_invocation', {
    command_name:
      'remote_skill' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    // _PROTO_skill_name routes to the privileged skill_name BQ column
    // (unredacted, all users); command_name stays in additional_metadata as
    // the redacted variant.
    _PROTO_skill_name:
      commandName as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
    execution_context:
      'remote' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    invocation_trigger: (queryDepth > 0
      ? 'nested-skill'
      : 'claude-proactive') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    query_depth: queryDepth,
    ...(parentAgentId && {
      parent_agent_id:
        parentAgentId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    }),
    was_discovered: true,
    is_remote: true,
    // 缓存命中状态和加载延迟（用于性能监控）
    remote_cache_hit: cacheHit,
    remote_load_latency_ms: latencyMs,
    ...(process.env.USER_TYPE === 'ant' && {
      skill_name:
        commandName as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      remote_slug:
        slug as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    }),
  })

  // 记录技能使用频次（用于排名和建议）
  recordSkillUsage(commandName)

  logForDebugging(
    `SkillTool loaded remote skill ${slug} (cacheHit=${cacheHit}, ${latencyMs}ms, ${content.length} chars)`,
  )

  // Strip YAML frontmatter (---\nname: x\n---) before prepending the header
  // (matches loadSkillsDir.ts:333). parseFrontmatter returns the original
  // content unchanged if no frontmatter is present.
  // 去除 YAML frontmatter（与 loadSkillsDir.ts 保持一致）
  const { content: bodyContent } = parseFrontmatter(content, skillPath)

  // Inject base directory header + ${CLAUDE_SKILL_DIR}/${CLAUDE_SESSION_ID}
  // substitution (matches loadSkillsDir.ts) so the model can resolve relative
  // refs like ./schemas/foo.json against the cache dir.
  // 注入 base directory 头部（使模型能解析技能中的相对路径引用）
  const skillDir = dirname(skillPath)
  // Windows 路径转换为正斜杠（统一格式）
  const normalizedDir =
    process.platform === 'win32' ? skillDir.replace(/\\/g, '/') : skillDir
  let finalContent = `Base directory for this skill: ${normalizedDir}\n\n${bodyContent}`
  // 替换 ${CLAUDE_SKILL_DIR} 变量为实际缓存目录路径
  finalContent = finalContent.replace(/\$\{CLAUDE_SKILL_DIR\}/g, normalizedDir)
  // 替换 ${CLAUDE_SESSION_ID} 变量为当前会话 ID
  finalContent = finalContent.replace(
    /\$\{CLAUDE_SESSION_ID\}/g,
    getSessionId(),
  )

  // Register with compaction-preservation state. Use the cached file path so
  // post-compact restoration knows where the content came from. Must use
  // finalContent (not raw content) so the base directory header and
  // ${CLAUDE_SKILL_DIR} substitutions survive compaction — matches how local
  // skills store their already-transformed content via processSlashCommand.
  // 注册至 invokedSkills（使用 finalContent 确保 compaction 后恢复时包含替换后的内容）
  addInvokedSkill(
    commandName,
    skillPath,
    finalContent,
    getAgentContext()?.agentId ?? null,
  )

  // Direct injection — wrap SKILL.md content in a meta user message. Matches
  // the shape of what processPromptSlashCommand produces for simple skills.
  // 直接注入：将 SKILL.md 内容包装为 isMeta user message（与本地技能的注入格式一致）
  const toolUseID = getToolUseIDFromParentMessage(
    parentMessage,
    SKILL_TOOL_NAME,
  )
  return {
    data: { success: true, commandName, status: 'inline' },
    newMessages: tagMessagesWithToolUseID(
      [createUserMessage({ content: finalContent, isMeta: true })],
      toolUseID,
    ),
  }
}
