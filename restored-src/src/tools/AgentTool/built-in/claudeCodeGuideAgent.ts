/**
 * Claude Code 指引 Agent 内置定义模块
 *
 * 在 Claude Code AgentTool 层中，该模块定义了内置的 claude-code-guide Agent。
 * 该 Agent 专门负责帮助用户了解和使用 Claude Code、Claude Agent SDK 和 Claude API，
 * 通过联网获取官方文档并提供准确、可操作的指引。
 *
 * 核心特性：
 * 1. 使用 haiku 模型（速度快、成本低，适合文档检索类任务）
 * 2. 工具集：WebFetch、WebSearch（联网）、FileRead、Glob/Grep（本地）
 *    - Ant 原生构建（内嵌搜索工具）：使用 Bash + FileRead + WebFetch + WebSearch
 *    - 标准构建：使用 Glob + Grep + FileRead + WebFetch + WebSearch
 * 3. 系统提示动态构建：注入当前会话的自定义技能、Agent、MCP 服务器和用户设置
 * 4. 权限模式为 dontAsk（文档查询类操作，无需权限确认）
 *
 * 文档来源：
 * - Claude Code 文档：https://code.claude.com/docs/en/claude_code_docs_map.md
 * - Claude Agent SDK / Claude API 文档：https://platform.claude.com/llms.txt
 */

import { BASH_TOOL_NAME } from 'src/tools/BashTool/toolName.js'
import { FILE_READ_TOOL_NAME } from 'src/tools/FileReadTool/prompt.js'
import { GLOB_TOOL_NAME } from 'src/tools/GlobTool/prompt.js'
import { GREP_TOOL_NAME } from 'src/tools/GrepTool/prompt.js'
import { SEND_MESSAGE_TOOL_NAME } from 'src/tools/SendMessageTool/constants.js'
import { WEB_FETCH_TOOL_NAME } from 'src/tools/WebFetchTool/prompt.js'
import { WEB_SEARCH_TOOL_NAME } from 'src/tools/WebSearchTool/prompt.js'
import { isUsing3PServices } from 'src/utils/auth.js'
import { hasEmbeddedSearchTools } from 'src/utils/embeddedTools.js'
import { getSettings_DEPRECATED } from 'src/utils/settings/settings.js'
import { jsonStringify } from '../../../utils/slowOperations.js'
import type {
  AgentDefinition,
  BuiltInAgentDefinition,
} from '../loadAgentsDir.js'

// Claude Code 文档地图 URL：包含所有 Claude Code CLI 文档的索引
const CLAUDE_CODE_DOCS_MAP_URL =
  'https://code.claude.com/docs/en/claude_code_docs_map.md'
// Claude Developer Platform 文档地图 URL：包含 Agent SDK 和 Claude API 文档索引
const CDP_DOCS_MAP_URL = 'https://platform.claude.com/llms.txt'

// claude-code-guide Agent 的类型标识符
export const CLAUDE_CODE_GUIDE_AGENT_TYPE = 'claude-code-guide'

/**
 * 生成 claude-code-guide Agent 的基础系统提示。
 *
 * 基础提示定义了 Agent 的三大专业领域、对应的文档来源和工作方式。
 * 根据是否使用内嵌搜索工具，本地文件搜索的提示文字会有所不同。
 *
 * @returns 基础系统提示字符串
 */
function getClaudeCodeGuideBasePrompt(): string {
  // Ant-native builds alias find/grep to embedded bfs/ugrep and remove the
  // dedicated Glob/Grep tools, so point at find/grep instead.
  // Ant 原生构建：Glob/Grep 工具被移除，使用 find/grep 替代；
  // 标准构建：使用专用的 Glob、Grep 工具
  const localSearchHint = hasEmbeddedSearchTools()
    ? `${FILE_READ_TOOL_NAME}, \`find\`, and \`grep\``
    : `${FILE_READ_TOOL_NAME}, ${GLOB_TOOL_NAME}, and ${GREP_TOOL_NAME}`

  return `You are the Claude guide agent. Your primary responsibility is helping users understand and use Claude Code, the Claude Agent SDK, and the Claude API (formerly the Anthropic API) effectively.

**Your expertise spans three domains:**

1. **Claude Code** (the CLI tool): Installation, configuration, hooks, skills, MCP servers, keyboard shortcuts, IDE integrations, settings, and workflows.

2. **Claude Agent SDK**: A framework for building custom AI agents based on Claude Code technology. Available for Node.js/TypeScript and Python.

3. **Claude API**: The Claude API (formerly known as the Anthropic API) for direct model interaction, tool use, and integrations.

**Documentation sources:**

- **Claude Code docs** (${CLAUDE_CODE_DOCS_MAP_URL}): Fetch this for questions about the Claude Code CLI tool, including:
  - Installation, setup, and getting started
  - Hooks (pre/post command execution)
  - Custom skills
  - MCP server configuration
  - IDE integrations (VS Code, JetBrains)
  - Settings files and configuration
  - Keyboard shortcuts and hotkeys
  - Subagents and plugins
  - Sandboxing and security

- **Claude Agent SDK docs** (${CDP_DOCS_MAP_URL}): Fetch this for questions about building agents with the SDK, including:
  - SDK overview and getting started (Python and TypeScript)
  - Agent configuration + custom tools
  - Session management and permissions
  - MCP integration in agents
  - Hosting and deployment
  - Cost tracking and context management
  Note: Agent SDK docs are part of the Claude API documentation at the same URL.

- **Claude API docs** (${CDP_DOCS_MAP_URL}): Fetch this for questions about the Claude API (formerly the Anthropic API), including:
  - Messages API and streaming
  - Tool use (function calling) and Anthropic-defined tools (computer use, code execution, web search, text editor, bash, programmatic tool calling, tool search tool, context editing, Files API, structured outputs)
  - Vision, PDF support, and citations
  - Extended thinking and structured outputs
  - MCP connector for remote MCP servers
  - Cloud provider integrations (Bedrock, Vertex AI, Foundry)

**Approach:**
1. Determine which domain the user's question falls into
2. Use ${WEB_FETCH_TOOL_NAME} to fetch the appropriate docs map
3. Identify the most relevant documentation URLs from the map
4. Fetch the specific documentation pages
5. Provide clear, actionable guidance based on official documentation
6. Use ${WEB_SEARCH_TOOL_NAME} if docs don't cover the topic
7. Reference local project files (CLAUDE.md, .claude/ directory) when relevant using ${localSearchHint}

**Guidelines:**
- Always prioritize official documentation over assumptions
- Keep responses concise and actionable
- Include specific examples or code snippets when helpful
- Reference exact documentation URLs in your responses
- Help users discover features by proactively suggesting related commands, shortcuts, or capabilities

Complete the user's request by providing accurate, documentation-based guidance.`
}

/**
 * 生成反馈渠道指引文字。
 *
 * 对于使用第三方服务（Bedrock/Vertex/Foundry）的用户，
 * /feedback 命令不可用，需引导至对应的外部反馈渠道；
 * 对于标准用户，直接引导使用 /feedback 命令。
 *
 * @returns 反馈指引字符串
 */
function getFeedbackGuideline(): string {
  // For 3P services (Bedrock/Vertex/Foundry), /feedback command is disabled
  // Direct users to the appropriate feedback channel instead
  // 第三方服务用户：引导到外部问题反馈页面
  if (isUsing3PServices()) {
    return `- When you cannot find an answer or the feature doesn't exist, direct the user to ${MACRO.ISSUES_EXPLAINER}`
  }
  // 标准用户：引导使用内置 /feedback 命令
  return "- When you cannot find an answer or the feature doesn't exist, direct the user to use /feedback to report a feature request or bug"
}

/**
 * claude-code-guide 内置 Agent 定义。
 *
 * 该 Agent 在用户询问 Claude Code、Agent SDK 或 Claude API 相关问题时被调用，
 * 通过联网查阅官方文档提供准确答案。
 *
 * 系统提示在运行时动态构建，注入以下当前会话上下文：
 * - 自定义技能（prompt 类型的命令）
 * - 已配置的自定义 Agent
 * - 已配置的 MCP 服务器
 * - 插件技能
 * - 用户的 settings.json 内容
 */
export const CLAUDE_CODE_GUIDE_AGENT: BuiltInAgentDefinition = {
  agentType: CLAUDE_CODE_GUIDE_AGENT_TYPE,
  whenToUse: `Use this agent when the user asks questions ("Can Claude...", "Does Claude...", "How do I...") about: (1) Claude Code (the CLI tool) - features, hooks, slash commands, MCP servers, settings, IDE integrations, keyboard shortcuts; (2) Claude Agent SDK - building custom agents; (3) Claude API (formerly Anthropic API) - API usage, tool use, Anthropic SDK usage. **IMPORTANT:** Before spawning a new agent, check if there is already a running or recently completed claude-code-guide agent that you can continue via ${SEND_MESSAGE_TOOL_NAME}.`,
  // Ant-native builds: Glob/Grep tools are removed; use Bash (with embedded
  // bfs/ugrep via find/grep aliases) for local file search instead.
  // Ant 原生构建：Glob/Grep 被移除，改用 Bash（内嵌 bfs/ugrep 别名）进行本地搜索
  tools: hasEmbeddedSearchTools()
    ? [
        BASH_TOOL_NAME,        // 内嵌构建：使用 Bash（包含 find/grep 别名）
        FILE_READ_TOOL_NAME,
        WEB_FETCH_TOOL_NAME,
        WEB_SEARCH_TOOL_NAME,
      ]
    : [
        GLOB_TOOL_NAME,        // 标准构建：使用专用文件搜索工具
        GREP_TOOL_NAME,        // 标准构建：使用专用内容搜索工具
        FILE_READ_TOOL_NAME,
        WEB_FETCH_TOOL_NAME,
        WEB_SEARCH_TOOL_NAME,
      ],
  source: 'built-in',
  baseDir: 'built-in',
  model: 'haiku',        // 使用 haiku 模型：速度快、适合文档检索
  permissionMode: 'dontAsk', // 文档查询操作无需权限确认
  getSystemPrompt({ toolUseContext }) {
    const commands = toolUseContext.options.commands

    // 收集当前会话的上下文信息片段
    const contextSections: string[] = []

    // 1. 自定义技能（prompt 类型的命令）
    const customCommands = commands.filter(cmd => cmd.type === 'prompt')
    if (customCommands.length > 0) {
      const commandList = customCommands
        .map(cmd => `- /${cmd.name}: ${cmd.description}`)
        .join('\n')
      contextSections.push(
        `**Available custom skills in this project:**\n${commandList}`,
      )
    }

    // 2. 来自 .claude/agents/ 目录的自定义 Agent（排除内置 Agent）
    const customAgents =
      toolUseContext.options.agentDefinitions.activeAgents.filter(
        (a: AgentDefinition) => a.source !== 'built-in',
      )
    if (customAgents.length > 0) {
      const agentList = customAgents
        .map((a: AgentDefinition) => `- ${a.agentType}: ${a.whenToUse}`)
        .join('\n')
      contextSections.push(
        `**Available custom agents configured:**\n${agentList}`,
      )
    }

    // 3. 已配置的 MCP 服务器列表
    const mcpClients = toolUseContext.options.mcpClients
    if (mcpClients && mcpClients.length > 0) {
      const mcpList = mcpClients
        .map((client: { name: string }) => `- ${client.name}`)
        .join('\n')
      contextSections.push(`**Configured MCP servers:**\n${mcpList}`)
    }

    // 4. 插件提供的技能命令
    const pluginCommands = commands.filter(
      cmd => cmd.type === 'prompt' && cmd.source === 'plugin',
    )
    if (pluginCommands.length > 0) {
      const pluginList = pluginCommands
        .map(cmd => `- /${cmd.name}: ${cmd.description}`)
        .join('\n')
      contextSections.push(`**Available plugin skills:**\n${pluginList}`)
    }

    // 5. 用户当前的 settings.json 配置内容
    const settings = getSettings_DEPRECATED()
    if (Object.keys(settings).length > 0) {
      // eslint-disable-next-line no-restricted-syntax -- human-facing UI, not tool_result
      const settingsJson = jsonStringify(settings, null, 2)
      contextSections.push(
        `**User's settings.json:**\n\`\`\`json\n${settingsJson}\n\`\`\``,
      )
    }

    // 将反馈指引追加到基础系统提示后
    const feedbackGuideline = getFeedbackGuideline()
    const basePromptWithFeedback = `${getClaudeCodeGuideBasePrompt()}
${feedbackGuideline}`

    // 若有上下文信息，追加到系统提示末尾
    if (contextSections.length > 0) {
      return `${basePromptWithFeedback}

---

# User's Current Configuration

The user has the following custom setup in their environment:

${contextSections.join('\n\n')}

When answering questions, consider these configured features and proactively suggest them when relevant.`
    }

    // 无上下文信息时，直接返回基础提示
    return basePromptWithFeedback
  },
}
