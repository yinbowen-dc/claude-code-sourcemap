/**
 * /context 命令的非交互式（headless/SDK）实现与上下文数据采集核心逻辑。
 *
 * 本文件在 Claude Code 系统中承担两个职责：
 *  1. 导出 `collectContextData`：被 /context 斜杠命令与 SDK 的
 *     `get_context_usage` 控制请求共同复用，负责在发送给模型之前
 *     模拟 query.ts 中的消息预处理流程（compact 边界截断、
 *     projectView 折叠、microcompact 压缩），从而确保统计出的
 *     token 数量与模型实际看到的一致。
 *  2. 导出 `call`：在非交互式会话下响应 /context 命令，将采集到的
 *     上下文数据格式化为 Markdown 表格文本后返回给调用方。
 */
import { feature } from 'bun:bundle'
import { microcompactMessages } from '../../services/compact/microCompact.js'
import type { AppState } from '../../state/AppStateStore.js'
import type { Tools, ToolUseContext } from '../../Tool.js'
import type { AgentDefinitionsResult } from '../../tools/AgentTool/loadAgentsDir.js'
import type { Message } from '../../types/message.js'
import {
  analyzeContextUsage,
  type ContextData,
} from '../../utils/analyzeContext.js'
import { formatTokens } from '../../utils/format.js'
import { getMessagesAfterCompactBoundary } from '../../utils/messages.js'
import { getSourceDisplayName } from '../../utils/settings/constants.js'
import { plural } from '../../utils/stringUtils.js'

/**
 * Shared data-collection path for `/context` (slash command) and the SDK
 * `get_context_usage` control request. Mirrors query.ts's pre-API transforms
 * (compact boundary, projectView, microcompact) so the token count reflects
 * what the model actually sees.
 */
type CollectContextDataInput = {
  messages: Message[]
  getAppState: () => AppState
  options: {
    mainLoopModel: string
    tools: Tools
    agentDefinitions: AgentDefinitionsResult
    customSystemPrompt?: string
    appendSystemPrompt?: string
  }
}

/**
 * 采集当前会话的上下文使用数据，供 /context 命令和 SDK 控制请求使用。
 *
 * 流程：
 *  1. 截取 compact 边界之后的消息，去掉历史已压缩的部分；
 *  2. 若启用了 CONTEXT_COLLAPSE 特性，执行 projectView 对消息做结构折叠；
 *  3. 对可见消息做 microcompact 微压缩，进一步逼近模型实际接收内容；
 *  4. 调用 analyzeContextUsage 统计各分类的 token 用量并返回结构化数据。
 */
export async function collectContextData(
  context: CollectContextDataInput,
): Promise<ContextData> {
  const {
    messages,
    getAppState,
    options: {
      mainLoopModel,
      tools,
      agentDefinitions,
      customSystemPrompt,
      appendSystemPrompt,
    },
  } = context

  // 截取 compact 边界之后的消息，仅分析模型真正能看到的部分
  let apiView = getMessagesAfterCompactBoundary(messages)
  if (feature('CONTEXT_COLLAPSE')) {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { projectView } =
      require('../../services/contextCollapse/operations.js') as typeof import('../../services/contextCollapse/operations.js')
    /* eslint-enable @typescript-eslint/no-require-imports */
    // 对消息做 projectView 折叠，与实际请求前的处理保持一致
    apiView = projectView(apiView)
  }

  // 对消息做 microcompact 压缩，得到与发送给模型最接近的消息列表
  const { messages: compactedMessages } = await microcompactMessages(apiView)
  const appState = getAppState()

  // 分析各类别（系统提示、工具、历史消息等）的 token 占用并返回
  return analyzeContextUsage(
    compactedMessages,
    mainLoopModel,
    async () => appState.toolPermissionContext,
    tools,
    agentDefinitions,
    undefined, // terminalWidth
    // analyzeContextUsage only reads options.{customSystemPrompt,appendSystemPrompt}
    // but its signature declares the full Pick<ToolUseContext, 'options'>.
    { options: { customSystemPrompt, appendSystemPrompt } } as Pick<
      ToolUseContext,
      'options'
    >,
    undefined, // mainThreadAgentDefinition
    apiView, // original messages for API usage extraction
  )
}

/**
 * 非交互式会话下 /context 命令的入口函数。
 *
 * 调用 collectContextData 采集数据后，将结果格式化为 Markdown 表格字符串
 * 并以 text 类型返回，适合在管道输出或 SDK 回调中直接使用。
 */
export async function call(
  _args: string,
  context: ToolUseContext,
): Promise<{ type: 'text'; value: string }> {
  const data = await collectContextData(context)
  return {
    type: 'text' as const,
    value: formatContextAsMarkdownTable(data),
  }
}

/**
 * 将结构化的上下文数据渲染为 Markdown 格式的表格字符串。
 *
 * 输出结构：
 *  - 头部汇总：模型名称、总 token 数/上限/百分比
 *  - context-collapse 状态（开启时显示已折叠 span 数量及健康指标）
 *  - 各类别 token 用量表格（系统提示、工具、消息等）
 *  - MCP 工具列表、内置系统工具（ANT 内部可见）
 *  - Custom Agents、Memory Files、Skills 的 token 明细
 *  - 消息级别细分（ANT 内部可见），含工具调用与附件的 Top N 排行
 */
function formatContextAsMarkdownTable(data: ContextData): string {
  const {
    categories,
    totalTokens,
    rawMaxTokens,
    percentage,
    model,
    memoryFiles,
    mcpTools,
    agents,
    skills,
    messageBreakdown,
    systemTools,
    systemPromptSections,
  } = data

  let output = `## Context Usage\n\n`
  output += `**Model:** ${model}  \n`
  output += `**Tokens:** ${formatTokens(totalTokens)} / ${formatTokens(rawMaxTokens)} (${percentage}%)\n`

  // Context-collapse status. Always show when the runtime gate is on —
  // the user needs to know which strategy is managing their context
  // even before anything has fired.
  if (feature('CONTEXT_COLLAPSE')) {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { getStats, isContextCollapseEnabled } =
      require('../../services/contextCollapse/index.js') as typeof import('../../services/contextCollapse/index.js')
    /* eslint-enable @typescript-eslint/no-require-imports */
    if (isContextCollapseEnabled()) {
      const s = getStats()
      const { health: h } = s

      // 拼接已折叠 span 数量和待处理（staged）span 数量的描述文本
      const parts = []
      if (s.collapsedSpans > 0) {
        parts.push(
          `${s.collapsedSpans} ${plural(s.collapsedSpans, 'span')} summarized (${s.collapsedMessages} messages)`,
        )
      }
      if (s.stagedSpans > 0) parts.push(`${s.stagedSpans} staged`)
      const summary =
        parts.length > 0
          ? parts.join(', ')
          : h.totalSpawns > 0
            ? `${h.totalSpawns} ${plural(h.totalSpawns, 'spawn')}, nothing staged yet`
            : 'waiting for first trigger'
      output += `**Context strategy:** collapse (${summary})\n`

      // 若折叠过程出现错误，显示失败次数及最近一条错误信息（截断到 80 字符）
      if (h.totalErrors > 0) {
        output += `**Collapse errors:** ${h.totalErrors}/${h.totalSpawns} spawns failed`
        if (h.lastError) {
          output += ` (last: ${h.lastError.slice(0, 80)})`
        }
        output += '\n'
      } else if (h.emptySpawnWarningEmitted) {
        // 连续出现空折叠运行，提示用户注意
        output += `**Collapse idle:** ${h.totalEmptySpawns} consecutive empty runs\n`
      }
    }
  }
  output += '\n'

  // 过滤掉 token 为 0 的类别以及"Free space"和"Autocompact buffer"（单独处理）
  // Main categories table
  const visibleCategories = categories.filter(
    cat =>
      cat.tokens > 0 &&
      cat.name !== 'Free space' &&
      cat.name !== 'Autocompact buffer',
  )

  if (visibleCategories.length > 0) {
    output += `### Estimated usage by category\n\n`
    output += `| Category | Tokens | Percentage |\n`
    output += `|----------|--------|------------|\n`

    // 逐行输出各类别的 token 数及其占总上限的百分比
    for (const cat of visibleCategories) {
      const percentDisplay = ((cat.tokens / rawMaxTokens) * 100).toFixed(1)
      output += `| ${cat.name} | ${formatTokens(cat.tokens)} | ${percentDisplay}% |\n`
    }

    // 将 "Free space" 追加在类别表底部
    const freeSpaceCategory = categories.find(c => c.name === 'Free space')
    if (freeSpaceCategory && freeSpaceCategory.tokens > 0) {
      const percentDisplay = (
        (freeSpaceCategory.tokens / rawMaxTokens) *
        100
      ).toFixed(1)
      output += `| Free space | ${formatTokens(freeSpaceCategory.tokens)} | ${percentDisplay}% |\n`
    }

    // 将 "Autocompact buffer" 追加在类别表底部
    const autocompactCategory = categories.find(
      c => c.name === 'Autocompact buffer',
    )
    if (autocompactCategory && autocompactCategory.tokens > 0) {
      const percentDisplay = (
        (autocompactCategory.tokens / rawMaxTokens) *
        100
      ).toFixed(1)
      output += `| Autocompact buffer | ${formatTokens(autocompactCategory.tokens)} | ${percentDisplay}% |\n`
    }

    output += `\n`
  }

  // 输出 MCP 工具列表（工具名称、所属服务器、token 占用）
  // MCP tools
  if (mcpTools.length > 0) {
    output += `### MCP Tools\n\n`
    output += `| Tool | Server | Tokens |\n`
    output += `|------|--------|--------|\n`
    for (const tool of mcpTools) {
      output += `| ${tool.name} | ${tool.serverName} | ${formatTokens(tool.tokens)} |\n`
    }
    output += `\n`
  }

  // 内置系统工具仅对 Anthropic 内部用户（ant）可见
  // System tools (ant-only)
  if (
    systemTools &&
    systemTools.length > 0 &&
    process.env.USER_TYPE === 'ant'
  ) {
    output += `### [ANT-ONLY] System Tools\n\n`
    output += `| Tool | Tokens |\n`
    output += `|------|--------|\n`
    for (const tool of systemTools) {
      output += `| ${tool.name} | ${formatTokens(tool.tokens)} |\n`
    }
    output += `\n`
  }

  // 系统提示各 section 的 token 细分，仅对内部用户可见
  // System prompt sections (ant-only)
  if (
    systemPromptSections &&
    systemPromptSections.length > 0 &&
    process.env.USER_TYPE === 'ant'
  ) {
    output += `### [ANT-ONLY] System Prompt Sections\n\n`
    output += `| Section | Tokens |\n`
    output += `|---------|--------|\n`
    for (const section of systemPromptSections) {
      output += `| ${section.name} | ${formatTokens(section.tokens)} |\n`
    }
    output += `\n`
  }

  // 自定义 Agent 的 token 用量，来源列区分项目/用户/本地/标志/策略/插件/内置
  // Custom agents
  if (agents.length > 0) {
    output += `### Custom Agents\n\n`
    output += `| Agent Type | Source | Tokens |\n`
    output += `|------------|--------|--------|\n`
    for (const agent of agents) {
      let sourceDisplay: string
      // 将枚举值转换为用户友好的来源名称
      switch (agent.source) {
        case 'projectSettings':
          sourceDisplay = 'Project'
          break
        case 'userSettings':
          sourceDisplay = 'User'
          break
        case 'localSettings':
          sourceDisplay = 'Local'
          break
        case 'flagSettings':
          sourceDisplay = 'Flag'
          break
        case 'policySettings':
          sourceDisplay = 'Policy'
          break
        case 'plugin':
          sourceDisplay = 'Plugin'
          break
        case 'built-in':
          sourceDisplay = 'Built-in'
          break
        default:
          sourceDisplay = String(agent.source)
      }
      output += `| ${agent.agentType} | ${sourceDisplay} | ${formatTokens(agent.tokens)} |\n`
    }
    output += `\n`
  }

  // 输出内存文件（CLAUDE.md 等）的类型、路径和 token 占用
  // Memory files
  if (memoryFiles.length > 0) {
    output += `### Memory Files\n\n`
    output += `| Type | Path | Tokens |\n`
    output += `|------|------|--------|\n`
    for (const file of memoryFiles) {
      output += `| ${file.type} | ${file.path} | ${formatTokens(file.tokens)} |\n`
    }
    output += `\n`
  }

  // 输出已加载 Skill 的名称、来源及 token 占用
  // Skills
  if (skills && skills.tokens > 0 && skills.skillFrontmatter.length > 0) {
    output += `### Skills\n\n`
    output += `| Skill | Source | Tokens |\n`
    output += `|-------|--------|--------|\n`
    for (const skill of skills.skillFrontmatter) {
      output += `| ${skill.name} | ${getSourceDisplayName(skill.source)} | ${formatTokens(skill.tokens)} |\n`
    }
    output += `\n`
  }

  // 消息级别细分：仅对 Anthropic 内部用户展示，包括工具调用、工具结果、附件等分类
  // Message breakdown (ant-only)
  if (messageBreakdown && process.env.USER_TYPE === 'ant') {
    output += `### [ANT-ONLY] Message Breakdown\n\n`
    output += `| Category | Tokens |\n`
    output += `|----------|--------|\n`
    output += `| Tool calls | ${formatTokens(messageBreakdown.toolCallTokens)} |\n`
    output += `| Tool results | ${formatTokens(messageBreakdown.toolResultTokens)} |\n`
    output += `| Attachments | ${formatTokens(messageBreakdown.attachmentTokens)} |\n`
    output += `| Assistant messages (non-tool) | ${formatTokens(messageBreakdown.assistantMessageTokens)} |\n`
    output += `| User messages (non-tool-result) | ${formatTokens(messageBreakdown.userMessageTokens)} |\n`
    output += `\n`

    // 按工具类型汇总调用与结果的 token 消耗，帮助用户识别最"重"的工具
    if (messageBreakdown.toolCallsByType.length > 0) {
      output += `#### Top Tools\n\n`
      output += `| Tool | Call Tokens | Result Tokens |\n`
      output += `|------|-------------|---------------|\n`
      for (const tool of messageBreakdown.toolCallsByType) {
        output += `| ${tool.name} | ${formatTokens(tool.callTokens)} | ${formatTokens(tool.resultTokens)} |\n`
      }
      output += `\n`
    }

    // 按附件类型汇总 token 消耗，帮助用户了解哪类附件最占空间
    if (messageBreakdown.attachmentsByType.length > 0) {
      output += `#### Top Attachments\n\n`
      output += `| Attachment | Tokens |\n`
      output += `|------------|--------|\n`
      for (const attachment of messageBreakdown.attachmentsByType) {
        output += `| ${attachment.name} | ${formatTokens(attachment.tokens)} |\n`
      }
      output += `\n`
    }
  }

  return output
}
