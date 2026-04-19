/**
 * AgentTool 提示构建模块
 *
 * 在 Claude Code AgentTool 层中，该模块负责构建 Agent 工具的提示文本——
 * 包括工具描述、Agent 列表格式化、提示注入方式选择，以及完整的工具提示组装。
 *
 * 核心职责：
 * 1. `getToolsDescription()` — 根据工具白名单/黑名单规则生成工具描述字符串
 * 2. `formatAgentLine()` — 将单个 Agent 格式化为 agent_listing_delta 附件消息的一行
 * 3. `shouldInjectAgentListInMessages()` — 决定 Agent 列表是否通过附件消息而非内联方式注入
 * 4. `getPrompt()` — 异步组装完整的 Agent 工具提示（含条件区块、示例、用法说明）
 *
 * 设计说明：
 * - Agent 列表曾是工具描述中的动态内容，占 fleet cache_creation token 的约 10.2%。
 *   通过 shouldInjectAgentListInMessages() 将其移至附件消息，使工具描述保持静态，
 *   避免 MCP 连接/插件重载/权限变更导致的工具 schema 缓存失效。
 * - Fork 特性启用时，提示中增加"When to fork"区块和 fork 专属示例；
 *   Coordinator 模式使用精简提示（仅共享核心区块，不含完整用法说明）。
 * - 嵌入式搜索工具（Ant 原生构建）使用 find/grep via Bash，
 *   而非专用的 Glob/Grep 工具。
 */

import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import { getSubscriptionType } from '../../utils/auth.js'
import { hasEmbeddedSearchTools } from '../../utils/embeddedTools.js'
import { isEnvDefinedFalsy, isEnvTruthy } from '../../utils/envUtils.js'
import { isTeammate } from '../../utils/teammate.js'
import { isInProcessTeammate } from '../../utils/teammateContext.js'
import { FILE_READ_TOOL_NAME } from '../FileReadTool/prompt.js'
import { FILE_WRITE_TOOL_NAME } from '../FileWriteTool/prompt.js'
import { GLOB_TOOL_NAME } from '../GlobTool/prompt.js'
import { SEND_MESSAGE_TOOL_NAME } from '../SendMessageTool/constants.js'
import { AGENT_TOOL_NAME } from './constants.js'
import { isForkSubagentEnabled } from './forkSubagent.js'
import type { AgentDefinition } from './loadAgentsDir.js'

/**
 * 根据 Agent 的工具白名单和黑名单生成工具描述字符串。
 *
 * 逻辑规则：
 * - 白名单 + 黑名单同时存在：先过滤黑名单，输出有效工具列表（或 'None'）
 * - 仅白名单：直接输出允许的工具列表
 * - 仅黑名单：输出 "All tools except X, Y, Z"
 * - 无限制：输出 "All tools"
 *
 * @param agent Agent 定义
 * @returns 工具描述字符串
 */
function getToolsDescription(agent: AgentDefinition): string {
  const { tools, disallowedTools } = agent
  const hasAllowlist = tools && tools.length > 0
  const hasDenylist = disallowedTools && disallowedTools.length > 0

  if (hasAllowlist && hasDenylist) {
    // 白名单和黑名单同时存在：过滤黑名单，输出有效工具列表（与运行时行为一致）
    const denySet = new Set(disallowedTools)
    const effectiveTools = tools.filter(t => !denySet.has(t))
    if (effectiveTools.length === 0) {
      return 'None'  // 所有白名单工具均被黑名单排除
    }
    return effectiveTools.join(', ')
  } else if (hasAllowlist) {
    // 仅白名单：直接显示可用工具列表
    return tools.join(', ')
  } else if (hasDenylist) {
    // 仅黑名单：显示"除了 X, Y, Z 外的所有工具"
    return `All tools except ${disallowedTools.join(', ')}`
  }
  // 无任何限制：所有工具可用
  return 'All tools'
}

/**
 * 将单个 Agent 格式化为 agent_listing_delta 附件消息的一行。
 *
 * 输出格式：`- type: whenToUse (Tools: ...)`
 *
 * @param agent Agent 定义
 * @returns 格式化后的单行 Agent 描述字符串
 */
export function formatAgentLine(agent: AgentDefinition): string {
  const toolsDescription = getToolsDescription(agent)
  return `- ${agent.agentType}: ${agent.whenToUse} (Tools: ${toolsDescription})`
}

/**
 * 决定 Agent 列表是否通过附件消息注入，而非内联到工具描述中。
 *
 * 当返回 true 时，getPrompt() 返回静态描述，attachments.ts 发出 agent_listing_delta 附件。
 *
 * 背景：动态 Agent 列表占 fleet cache_creation token 的约 10.2%。
 * MCP 异步连接、/reload-plugins 或权限模式变更都会改变列表内容，
 * 从而导致工具描述变化 → 完整工具 schema 缓存失效。
 * 将列表移至附件消息可使工具描述保持静态，避免频繁缓存失效。
 *
 * 通过 CLAUDE_CODE_AGENT_LIST_IN_MESSAGES=true/false 环境变量覆盖（用于测试）。
 *
 * @returns 是否通过附件消息注入 Agent 列表
 */
export function shouldInjectAgentListInMessages(): boolean {
  // 环境变量强制启用
  if (isEnvTruthy(process.env.CLAUDE_CODE_AGENT_LIST_IN_MESSAGES)) return true
  // 环境变量强制禁用
  if (isEnvDefinedFalsy(process.env.CLAUDE_CODE_AGENT_LIST_IN_MESSAGES))
    return false
  // GrowthBook A/B 测试控制（默认关闭）
  return getFeatureValue_CACHED_MAY_BE_STALE('tengu_agent_list_attach', false)
}

/**
 * 异步构建完整的 Agent 工具提示字符串。
 *
 * 提示组成：
 * 1. `shared`：核心区块（工具简介 + Agent 列表 + subagent_type 说明）
 * 2. Coordinator 模式：仅返回 shared（coordinator 系统提示已包含完整用法说明）
 * 3. 非 Coordinator 模式：追加以下区块：
 *    - `whenNotToUseSection`（fork 模式下省略）
 *    - `concurrencyNote`（非 pro 订阅用户 + 非附件列表模式时显示）
 *    - 后台任务说明（非禁用后台任务 + 非 in-process teammate + 非 fork 模式时显示）
 *    - SendMessage 工具使用说明
 *    - worktree/remote 隔离说明
 *    - teammate 限制说明
 *    - `whenToForkSection`（fork 模式下显示）
 *    - `writingThePromptSection`
 *    - 示例（fork 模式使用 forkExamples，否则使用 currentExamples）
 *
 * @param agentDefinitions 当前会话中可用的 Agent 定义列表
 * @param isCoordinator 是否为 Coordinator 模式（使用精简提示）
 * @param allowedAgentTypes 允许生成的 Agent 类型白名单（Agent(x,y) 调用时限制子 Agent 类型）
 * @returns 完整的 Agent 工具提示字符串
 */
export async function getPrompt(
  agentDefinitions: AgentDefinition[],
  isCoordinator?: boolean,
  allowedAgentTypes?: string[],
): Promise<string> {
  // 当 Agent(x,y) 限制可生成的子 Agent 类型时，按白名单过滤
  const effectiveAgents = allowedAgentTypes
    ? agentDefinitions.filter(a => allowedAgentTypes.includes(a.agentType))
    : agentDefinitions

  // Fork 子 Agent 特性：启用时插入"When to fork"区块和 fork 专属示例
  const forkEnabled = isForkSubagentEnabled()

  // "When to fork"区块（仅 fork 模式下显示）
  const whenToForkSection = forkEnabled
    ? `

## When to fork

Fork yourself (omit \`subagent_type\`) when the intermediate tool output isn't worth keeping in your context. The criterion is qualitative \u2014 "will I need this output again" \u2014 not task size.
- **Research**: fork open-ended questions. If research can be broken into independent questions, launch parallel forks in one message. A fork beats a fresh subagent for this \u2014 it inherits context and shares your cache.
- **Implementation**: prefer to fork implementation work that requires more than a couple of edits. Do research before jumping to implementation.

Forks are cheap because they share your prompt cache. Don't set \`model\` on a fork \u2014 a different model can't reuse the parent's cache. Pass a short \`name\` (one or two words, lowercase) so the user can see the fork in the teams panel and steer it mid-run.

**Don't peek.** The tool result includes an \`output_file\` path — do not Read or tail it unless the user explicitly asks for a progress check. You get a completion notification; trust it. Reading the transcript mid-flight pulls the fork's tool noise into your context, which defeats the point of forking.

**Don't race.** After launching, you know nothing about what the fork found. Never fabricate or predict fork results in any format — not as prose, summary, or structured output. The notification arrives as a user-role message in a later turn; it is never something you write yourself. If the user asks a follow-up before the notification lands, tell them the fork is still running — give status, not a guess.

**Writing a fork prompt.** Since the fork inherits your context, the prompt is a *directive* — what to do, not what the situation is. Be specific about scope: what's in, what's out, what another agent is handling. Don't re-explain background.
`
    : ''

  // "Writing the prompt"区块（所有模式均显示）
  const writingThePromptSection = `

## Writing the prompt

${forkEnabled ? 'When spawning a fresh agent (with a `subagent_type`), it starts with zero context. ' : ''}Brief the agent like a smart colleague who just walked into the room — it hasn't seen this conversation, doesn't know what you've tried, doesn't understand why this task matters.
- Explain what you're trying to accomplish and why.
- Describe what you've already learned or ruled out.
- Give enough context about the surrounding problem that the agent can make judgment calls rather than just following a narrow instruction.
- If you need a short response, say so ("report in under 200 words").
- Lookups: hand over the exact command. Investigations: hand over the question — prescribed steps become dead weight when the premise is wrong.

${forkEnabled ? 'For fresh agents, terse' : 'Terse'} command-style prompts produce shallow, generic work.

**Never delegate understanding.** Don't write "based on your findings, fix the bug" or "based on the research, implement it." Those phrases push synthesis onto the agent instead of doing it yourself. Write prompts that prove you understood: include file paths, line numbers, what specifically to change.
`

  // Fork 模式专属示例（含 fork 语义说明和"不要预测结果"示例）
  const forkExamples = `Example usage:

<example>
user: "What's left on this branch before we can ship?"
assistant: <thinking>Forking this \u2014 it's a survey question. I want the punch list, not the git output in my context.</thinking>
${AGENT_TOOL_NAME}({
  name: "ship-audit",
  description: "Branch ship-readiness audit",
  prompt: "Audit what's left before this branch can ship. Check: uncommitted changes, commits ahead of main, whether tests exist, whether the GrowthBook gate is wired up, whether CI-relevant files changed. Report a punch list \u2014 done vs. missing. Under 200 words."
})
assistant: Ship-readiness audit running.
<commentary>
Turn ends here. The coordinator knows nothing about the findings yet. What follows is a SEPARATE turn \u2014 the notification arrives from outside, as a user-role message. It is not something the coordinator writes.
</commentary>
[later turn \u2014 notification arrives as user message]
assistant: Audit's back. Three blockers: no tests for the new prompt path, GrowthBook gate wired but not in build_flags.yaml, and one uncommitted file.
</example>

<example>
user: "so is the gate wired up or not"
<commentary>
User asks mid-wait. The audit fork was launched to answer exactly this, and it hasn't returned. The coordinator does not have this answer. Give status, not a fabricated result.
</commentary>
assistant: Still waiting on the audit \u2014 that's one of the things it's checking. Should land shortly.
</example>

<example>
user: "Can you get a second opinion on whether this migration is safe?"
assistant: <thinking>I'll ask the code-reviewer agent — it won't see my analysis, so it can give an independent read.</thinking>
<commentary>
A subagent_type is specified, so the agent starts fresh. It needs full context in the prompt. The briefing explains what to assess and why.
</commentary>
${AGENT_TOOL_NAME}({
  name: "migration-review",
  description: "Independent migration review",
  subagent_type: "code-reviewer",
  prompt: "Review migration 0042_user_schema.sql for safety. Context: we're adding a NOT NULL column to a 50M-row table. Existing rows get a backfill default. I want a second opinion on whether the backfill approach is safe under concurrent writes — I've checked locking behavior but want independent verification. Report: is this safe, and if not, what specifically breaks?"
})
</example>
`

  // 当前模式（非 fork）的标准示例
  const currentExamples = `Example usage:

<example_agent_descriptions>
"test-runner": use this agent after you are done writing code to run tests
"greeting-responder": use this agent to respond to user greetings with a friendly joke
</example_agent_descriptions>

<example>
user: "Please write a function that checks if a number is prime"
assistant: I'm going to use the ${FILE_WRITE_TOOL_NAME} tool to write the following code:
<code>
function isPrime(n) {
  if (n <= 1) return false
  for (let i = 2; i * i <= n; i++) {
    if (n % i === 0) return false
  }
  return true
}
</code>
<commentary>
Since a significant piece of code was written and the task was completed, now use the test-runner agent to run the tests
</commentary>
assistant: Uses the ${AGENT_TOOL_NAME} tool to launch the test-runner agent
</example>

<example>
user: "Hello"
<commentary>
Since the user is greeting, use the greeting-responder agent to respond with a friendly joke
</commentary>
assistant: "I'm going to use the ${AGENT_TOOL_NAME} tool to launch the greeting-responder agent"
</example>
`

  // 当特性开关启用时，Agent 列表通过 agent_listing_delta 附件消息注入（见 attachments.ts），
  // 而非内联到工具描述中。这使工具描述在 MCP/插件/权限变更时保持静态，
  // 避免 tools-block 提示缓存因 Agent 列表变化而频繁失效。
  const listViaAttachment = shouldInjectAgentListInMessages()

  // Agent 列表区块：附件模式使用 system-reminder 引用，内联模式直接列出所有 Agent
  const agentListSection = listViaAttachment
    ? `Available agent types are listed in <system-reminder> messages in the conversation.`
    : `Available agent types and the tools they have access to:
${effectiveAgents.map(agent => formatAgentLine(agent)).join('\n')}`

  // 共享核心区块：Coordinator 和非 Coordinator 模式均使用
  const shared = `Launch a new agent to handle complex, multi-step tasks autonomously.

The ${AGENT_TOOL_NAME} tool launches specialized agents (subprocesses) that autonomously handle complex tasks. Each agent type has specific capabilities and tools available to it.

${agentListSection}

${
  forkEnabled
    ? `When using the ${AGENT_TOOL_NAME} tool, specify a subagent_type to use a specialized agent, or omit it to fork yourself — a fork inherits your full conversation context.`
    : `When using the ${AGENT_TOOL_NAME} tool, specify a subagent_type parameter to select which agent type to use. If omitted, the general-purpose agent is used.`
}`

  // Coordinator 模式使用精简提示——coordinator 系统提示已包含用法说明、示例和"何时不用"引导
  if (isCoordinator) {
    return shared
  }

  // Ant 原生构建使用嵌入式 find/grep（通过 Bash 工具），而非专用 Glob/Grep 工具
  const embedded = hasEmbeddedSearchTools()
  const fileSearchHint = embedded
    ? '`find` via the Bash tool'
    : `the ${GLOB_TOOL_NAME} tool`
  // 内容搜索提示：非嵌入式构建使用 Glob（原意：查找包含内容的文件），嵌入式使用 grep
  const contentSearchHint = embedded
    ? '`grep` via the Bash tool'
    : `the ${GLOB_TOOL_NAME} tool`

  // "何时不用 Agent 工具"区块（fork 模式下省略，因为 fork 替代了大部分场景）
  const whenNotToUseSection = forkEnabled
    ? ''
    : `
When NOT to use the ${AGENT_TOOL_NAME} tool:
- If you want to read a specific file path, use the ${FILE_READ_TOOL_NAME} tool or ${fileSearchHint} instead of the ${AGENT_TOOL_NAME} tool, to find the match more quickly
- If you are searching for a specific class definition like "class Foo", use ${contentSearchHint} instead, to find the match more quickly
- If you are searching for code within a specific file or set of 2-3 files, use the ${FILE_READ_TOOL_NAME} tool instead of the ${AGENT_TOOL_NAME} tool, to find the match more quickly
- Other tasks that are not related to the agent descriptions above
`

  // 并发启动提示：仅在非附件列表模式且非 pro 订阅时显示
  // （附件模式下，并发提示在附件消息中按订阅类型条件显示）
  const concurrencyNote =
    !listViaAttachment && getSubscriptionType() !== 'pro'
      ? `
- Launch multiple agents concurrently whenever possible, to maximize performance; to do that, use a single message with multiple tool uses`
      : ''

  // 非 Coordinator 模式：返回包含所有区块的完整提示
  return `${shared}
${whenNotToUseSection}

Usage notes:
- Always include a short description (3-5 words) summarizing what the agent will do${concurrencyNote}
- When the agent is done, it will return a single message back to you. The result returned by the agent is not visible to the user. To show the user the result, you should send a text message back to the user with a concise summary of the result.${
    // eslint-disable-next-line custom-rules/no-process-env-top-level
    !isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS) &&
    !isInProcessTeammate() &&
    !forkEnabled
      ? `
- You can optionally run agents in the background using the run_in_background parameter. When an agent runs in the background, you will be automatically notified when it completes — do NOT sleep, poll, or proactively check on its progress. Continue with other work or respond to the user instead.
- **Foreground vs background**: Use foreground (default) when you need the agent's results before you can proceed — e.g., research agents whose findings inform your next steps. Use background when you have genuinely independent work to do in parallel.`
      : ''
  }
- To continue a previously spawned agent, use ${SEND_MESSAGE_TOOL_NAME} with the agent's ID or name as the \`to\` field. The agent resumes with its full context preserved. ${forkEnabled ? 'Each fresh Agent invocation with a subagent_type starts without context — provide a complete task description.' : 'Each Agent invocation starts fresh — provide a complete task description.'}
- The agent's outputs should generally be trusted
- Clearly tell the agent whether you expect it to write code or just to do research (search, file reads, web fetches, etc.)${forkEnabled ? '' : ", since it is not aware of the user's intent"}
- If the agent description mentions that it should be used proactively, then you should try your best to use it without the user having to ask for it first. Use your judgement.
- If the user specifies that they want you to run agents "in parallel", you MUST send a single message with multiple ${AGENT_TOOL_NAME} tool use content blocks. For example, if you need to launch both a build-validator agent and a test-runner agent in parallel, send a single message with both tool calls.
- You can optionally set \`isolation: "worktree"\` to run the agent in a temporary git worktree, giving it an isolated copy of the repository. The worktree is automatically cleaned up if the agent makes no changes; if changes are made, the worktree path and branch are returned in the result.${
    process.env.USER_TYPE === 'ant'
      ? `\n- You can set \`isolation: "remote"\` to run the agent in a remote CCR environment. This is always a background task; you'll be notified when it completes. Use for long-running tasks that need a fresh sandbox.`
      : ''
  }${
    isInProcessTeammate()
      ? `
- The run_in_background, name, team_name, and mode parameters are not available in this context. Only synchronous subagents are supported.`
      : isTeammate()
        ? `
- The name, team_name, and mode parameters are not available in this context — teammates cannot spawn other teammates. Omit them to spawn a subagent.`
        : ''
  }${whenToForkSection}${writingThePromptSection}

${forkEnabled ? forkExamples : currentExamples}`
}
