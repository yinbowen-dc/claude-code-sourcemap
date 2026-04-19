/**
 * generateAgent.ts — AI 驱动的 Agent 自动生成模块
 *
 * 【在 Claude Code 系统流程中的位置】
 * 本文件位于 src/components/agents/ 目录下，是新建 Agent 向导中"AI 生成"路径的核心。
 * 由 GenerateStep（向导步骤组件）调用，通过向 Claude API 发送用户描述，
 * 自动生成 Agent 的 identifier、whenToUse 和 systemPrompt。
 *
 * 【主要功能】
 * 1. 定义两段系统提示：AGENT_CREATION_SYSTEM_PROMPT（Agent 架构设计提示）
 *    和 AGENT_MEMORY_INSTRUCTIONS（记忆功能扩展提示，按需附加）
 * 2. generateAgent 函数：
 *    - 构建用户消息（包含防重名提示）
 *    - 注入用户上下文（CLAUDE.md 等项目信息）
 *    - 调用 queryModelWithoutStreaming 发起非流式 API 请求
 *    - 解析响应中的 JSON 对象，提取 identifier/whenToUse/systemPrompt
 *    - 上报分析事件（tengu_agent_definition_generated）
 */
import type { ContentBlock } from '@anthropic-ai/sdk/resources/index.mjs'
import { getUserContext } from 'src/context.js'
import { queryModelWithoutStreaming } from 'src/services/api/claude.js'
import { getEmptyToolPermissionContext } from 'src/Tool.js'
import { AGENT_TOOL_NAME } from 'src/tools/AgentTool/constants.js'
import { prependUserContext } from 'src/utils/api.js'
import {
  createUserMessage,
  normalizeMessagesForAPI,
} from 'src/utils/messages.js'
import type { ModelName } from 'src/utils/model/model.js'
import { isAutoMemoryEnabled } from '../../memdir/paths.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js'
import { jsonParse } from '../../utils/slowOperations.js'
import { asSystemPrompt } from '../../utils/systemPromptType.js'

// 生成的 Agent 数据结构：标识符、触发描述、系统提示
type GeneratedAgent = {
  identifier: string
  whenToUse: string
  systemPrompt: string
}

/**
 * AGENT_CREATION_SYSTEM_PROMPT — Agent 创建的主系统提示
 *
 * 定义 AI 在生成 Agent 配置时的行为规范：
 * 1. 提取核心意图（Extract Core Intent）
 * 2. 设计专家人格（Design Expert Persona）
 * 3. 构建完整指令（Architect Comprehensive Instructions）
 * 4. 优化性能（Optimize for Performance）
 * 5. 创建标识符（Create Identifier）：小写字母+数字+连字符，2-4 个词
 * 6. 编写使用示例（Example agent descriptions）：包含带 Commentary 的对话示例
 *
 * 输出要求：严格的 JSON 对象格式，包含 identifier、whenToUse、systemPrompt 三个字段
 */
const AGENT_CREATION_SYSTEM_PROMPT = `You are an elite AI agent architect specializing in crafting high-performance agent configurations. Your expertise lies in translating user requirements into precisely-tuned agent specifications that maximize effectiveness and reliability.

**Important Context**: You may have access to project-specific instructions from CLAUDE.md files and other context that may include coding standards, project structure, and custom requirements. Consider this context when creating agents to ensure they align with the project's established patterns and practices.

When a user describes what they want an agent to do, you will:

1. **Extract Core Intent**: Identify the fundamental purpose, key responsibilities, and success criteria for the agent. Look for both explicit requirements and implicit needs. Consider any project-specific context from CLAUDE.md files. For agents that are meant to review code, you should assume that the user is asking to review recently written code and not the whole codebase, unless the user has explicitly instructed you otherwise.

2. **Design Expert Persona**: Create a compelling expert identity that embodies deep domain knowledge relevant to the task. The persona should inspire confidence and guide the agent's decision-making approach.

3. **Architect Comprehensive Instructions**: Develop a system prompt that:
   - Establishes clear behavioral boundaries and operational parameters
   - Provides specific methodologies and best practices for task execution
   - Anticipates edge cases and provides guidance for handling them
   - Incorporates any specific requirements or preferences mentioned by the user
   - Defines output format expectations when relevant
   - Aligns with project-specific coding standards and patterns from CLAUDE.md

4. **Optimize for Performance**: Include:
   - Decision-making frameworks appropriate to the domain
   - Quality control mechanisms and self-verification steps
   - Efficient workflow patterns
   - Clear escalation or fallback strategies

5. **Create Identifier**: Design a concise, descriptive identifier that:
   - Uses lowercase letters, numbers, and hyphens only
   - Is typically 2-4 words joined by hyphens
   - Clearly indicates the agent's primary function
   - Is memorable and easy to type
   - Avoids generic terms like "helper" or "assistant"

6 **Example agent descriptions**:
  - in the 'whenToUse' field of the JSON object, you should include examples of when this agent should be used.
  - examples should be of the form:
    - <example>
      Context: The user is creating a test-runner agent that should be called after a logical chunk of code is written.
      user: "Please write a function that checks if a number is prime"
      assistant: "Here is the relevant function: "
      <function call omitted for brevity only for this example>
      <commentary>
      Since a significant piece of code was written, use the ${AGENT_TOOL_NAME} tool to launch the test-runner agent to run the tests.
      </commentary>
      assistant: "Now let me use the test-runner agent to run the tests"
    </example>
    - <example>
      Context: User is creating an agent to respond to the word "hello" with a friendly jok.
      user: "Hello"
      assistant: "I'm going to use the ${AGENT_TOOL_NAME} tool to launch the greeting-responder agent to respond with a friendly joke"
      <commentary>
      Since the user is greeting, use the greeting-responder agent to respond with a friendly joke.
      </commentary>
    </example>
  - If the user mentioned or implied that the agent should be used proactively, you should include examples of this.
- NOTE: Ensure that in the examples, you are making the assistant use the Agent tool and not simply respond directly to the task.

Your output must be a valid JSON object with exactly these fields:
{
  "identifier": "A unique, descriptive identifier using lowercase letters, numbers, and hyphens (e.g., 'test-runner', 'api-docs-writer', 'code-formatter')",
  "whenToUse": "A precise, actionable description starting with 'Use this agent when...' that clearly defines the triggering conditions and use cases. Ensure you include examples as described above.",
  "systemPrompt": "The complete system prompt that will govern the agent's behavior, written in second person ('You are...', 'You will...') and structured for maximum clarity and effectiveness"
}

Key principles for your system prompts:
- Be specific rather than generic - avoid vague instructions
- Include concrete examples when they would clarify behavior
- Balance comprehensiveness with clarity - every instruction should add value
- Ensure the agent has enough context to handle variations of the core task
- Make the agent proactive in seeking clarification when needed
- Build in quality assurance and self-correction mechanisms

Remember: The agents you create should be autonomous experts capable of handling their designated tasks with minimal additional guidance. Your system prompts are their complete operational manual.
`

/**
 * AGENT_MEMORY_INSTRUCTIONS — Agent 记忆功能扩展提示
 *
 * 当 isAutoMemoryEnabled() 为 true 时，追加到主系统提示之后。
 * 指导 AI 在用户描述中检测到记忆需求时，在 systemPrompt 中加入
 * 特定于领域的记忆更新指令（如"Update your agent memory as you discover..."）。
 */
// Agent memory instructions to include in the system prompt when memory is mentioned or relevant
const AGENT_MEMORY_INSTRUCTIONS = `

7. **Agent Memory Instructions**: If the user mentions "memory", "remember", "learn", "persist", or similar concepts, OR if the agent would benefit from building up knowledge across conversations (e.g., code reviewers learning patterns, architects learning codebase structure, etc.), include domain-specific memory update instructions in the systemPrompt.

   Add a section like this to the systemPrompt, tailored to the agent's specific domain:

   "**Update your agent memory** as you discover [domain-specific items]. This builds up institutional knowledge across conversations. Write concise notes about what you found and where.

   Examples of what to record:
   - [domain-specific item 1]
   - [domain-specific item 2]
   - [domain-specific item 3]"

   Examples of domain-specific memory instructions:
   - For a code-reviewer: "Update your agent memory as you discover code patterns, style conventions, common issues, and architectural decisions in this codebase."
   - For a test-runner: "Update your agent memory as you discover test patterns, common failure modes, flaky tests, and testing best practices."
   - For an architect: "Update your agent memory as you discover codepaths, library locations, key architectural decisions, and component relationships."
   - For a documentation writer: "Update your agent memory as you discover documentation patterns, API structures, and terminology conventions."

   The memory instructions should be specific to what the agent would naturally learn while performing its core tasks.
`

/**
 * generateAgent — 通过 AI 自动生成 Agent 配置
 *
 * 流程：
 * 1. 构建防重名提示：若已有同名 Agent，在消息中注明不可用的标识符列表
 * 2. 创建用户消息对象，要求 AI 返回纯 JSON
 * 3. 获取用户上下文（CLAUDE.md 等项目配置），注入消息列表
 * 4. 根据 isAutoMemoryEnabled 决定是否在系统提示中附加记忆指令
 * 5. 调用 queryModelWithoutStreaming 发起 API 请求（禁用思考模式、无工具）
 * 6. 从响应中提取所有 text 块，合并为字符串
 * 7. 用 jsonParse 解析 JSON；失败时用正则提取第一个 JSON 对象重试
 * 8. 校验必要字段；上报分析事件；返回 GeneratedAgent 对象
 *
 * @param userPrompt - 用户对 Agent 功能的描述
 * @param model - 用于生成的 Claude 模型名
 * @param existingIdentifiers - 已存在的 Agent 标识符列表（防止重名）
 * @param abortSignal - 用于取消请求的 AbortSignal
 */
export async function generateAgent(
  userPrompt: string,
  model: ModelName,
  existingIdentifiers: string[],
  abortSignal: AbortSignal,
): Promise<GeneratedAgent> {
  // 若已有同名 Agent，在提示中列出禁用的标识符，防止 AI 生成重复名称
  const existingList =
    existingIdentifiers.length > 0
      ? `\n\nIMPORTANT: The following identifiers already exist and must NOT be used: ${existingIdentifiers.join(', ')}`
      : ''

  // 构建请求消息：包含用户描述和防重名约束，要求只返回 JSON
  const prompt = `Create an agent configuration based on this request: "${userPrompt}".${existingList}
  Return ONLY the JSON object, no other text.`

  const userMessage = createUserMessage({ content: prompt })

  // 获取用户上下文（包括 CLAUDE.md 内容、项目信息等）
  // Fetch user and system contexts
  const userContext = await getUserContext()

  // 将用户上下文注入消息列表（添加到第一条消息之前）
  // Prepend user context to messages and append system context to system prompt
  const messagesWithContext = prependUserContext([userMessage], userContext)

  // 根据是否启用自动记忆功能，决定使用哪个版本的系统提示
  // Include memory instructions when the feature is enabled
  const systemPrompt = isAutoMemoryEnabled()
    ? AGENT_CREATION_SYSTEM_PROMPT + AGENT_MEMORY_INSTRUCTIONS
    : AGENT_CREATION_SYSTEM_PROMPT

  // 调用 Claude API（非流式）：禁用思考模式，不使用任何工具
  const response = await queryModelWithoutStreaming({
    messages: normalizeMessagesForAPI(messagesWithContext),
    systemPrompt: asSystemPrompt([systemPrompt]),
    thinkingConfig: { type: 'disabled' as const },
    tools: [],
    signal: abortSignal,
    options: {
      getToolPermissionContext: async () => getEmptyToolPermissionContext(),
      model,
      toolChoice: undefined,
      agents: [],
      isNonInteractiveSession: false,
      hasAppendSystemPrompt: false,
      querySource: 'agent_creation',  // 标记请求来源为 agent_creation
      mcpTools: [],
    },
  })

  // 提取响应中所有 text 类型的内容块，拼接为完整响应文本
  const textBlocks = response.message.content.filter(
    (block): block is ContentBlock & { type: 'text' } => block.type === 'text',
  )
  const responseText = textBlocks.map(block => block.text).join('\n')

  // 解析响应文本为 JSON 对象
  let parsed: GeneratedAgent
  try {
    // 首先尝试直接解析（去除首尾空白）
    parsed = jsonParse(responseText.trim())
  } catch {
    // 直接解析失败时，用正则提取第一个 {...} 块重试
    const jsonMatch = responseText.match(/\{[\s\S]*\}/)
    if (!jsonMatch) {
      throw new Error('No JSON object found in response')
    }
    parsed = jsonParse(jsonMatch[0])
  }

  // 校验必要字段是否都存在
  if (!parsed.identifier || !parsed.whenToUse || !parsed.systemPrompt) {
    throw new Error('Invalid agent configuration generated')
  }

  // 上报分析事件，记录生成的 Agent 标识符（类型断言确保不含代码/路径信息）
  logEvent('tengu_agent_definition_generated', {
    agent_identifier:
      parsed.identifier as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  })

  // 返回结构化的 Agent 配置
  return {
    identifier: parsed.identifier,
    whenToUse: parsed.whenToUse,
    systemPrompt: parsed.systemPrompt,
  }
}
