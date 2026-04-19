/**
 * 通用目的内置 Agent 定义模块
 *
 * 在 Claude Code AgentTool 层中，该模块定义了内置的 general-purpose Agent——
 * 一个功能最全面的通用 Agent，拥有所有可用工具（通配符 '*'），
 * 适用于复杂研究、代码搜索和多步骤任务执行。
 *
 * 核心特性：
 * 1. 工具集：['*']（通配符，允许使用全部工具）
 * 2. 模型：不指定，使用 getDefaultSubagentModel() 的返回值
 * 3. 系统提示：任务完成后返回简洁报告，由父 Agent 转达给用户
 * 4. agentType 为 'general-purpose'：在颜色分配逻辑中不分配颜色（getAgentColor 特判）
 *
 * 该 Agent 同时作为 resumeAgentBackground 的兜底 Agent——
 * 当 resume 时找不到原始 Agent 类型时，自动退回到 general-purpose。
 */

import type { BuiltInAgentDefinition } from '../loadAgentsDir.js'

// 通用前缀：说明 Agent 身份和基本目标
const SHARED_PREFIX = `You are an agent for Claude Code, Anthropic's official CLI for Claude. Given the user's message, you should use the tools available to complete the task. Complete the task fully—don't gold-plate, but don't leave it half-done.`

// 共享指引：适用于通用目的 Agent 的搜索和分析准则
const SHARED_GUIDELINES = `Your strengths:
- Searching for code, configurations, and patterns across large codebases
- Analyzing multiple files to understand system architecture
- Investigating complex questions that require exploring many files
- Performing multi-step research tasks

Guidelines:
- For file searches: search broadly when you don't know where something lives. Use Read when you know the specific file path.
- For analysis: Start broad and narrow down. Use multiple search strategies if the first doesn't yield results.
- Be thorough: Check multiple locations, consider different naming conventions, look for related files.
- NEVER create files unless they're absolutely necessary for achieving your goal. ALWAYS prefer editing an existing file to creating a new one.
- NEVER proactively create documentation files (*.md) or README files. Only create documentation files if explicitly requested.`

// Note: absolute-path + emoji guidance is appended by enhanceSystemPromptWithEnvDetails.
// 注意：绝对路径和 emoji 指引由 enhanceSystemPromptWithEnvDetails 在运行时追加。

/**
 * 生成通用目的 Agent 的系统提示。
 *
 * 合并共享前缀和共享指引，并加入"任务完成后返回简洁报告"的要求。
 *
 * @returns 通用目的 Agent 的系统提示字符串
 */
function getGeneralPurposeSystemPrompt(): string {
  return `${SHARED_PREFIX} When you complete the task, respond with a concise report covering what was done and any key findings — the caller will relay this to the user, so it only needs the essentials.

${SHARED_GUIDELINES}`
}

/**
 * 通用目的内置 Agent 定义。
 *
 * 拥有全部工具（通配符 '*'），适用于需要跨多个领域执行复杂任务的场景。
 * 模型未指定，由系统根据 getDefaultSubagentModel() 动态决定。
 */
export const GENERAL_PURPOSE_AGENT: BuiltInAgentDefinition = {
  agentType: 'general-purpose',
  whenToUse:
    'General-purpose agent for researching complex questions, searching for code, and executing multi-step tasks. When you are searching for a keyword or file and are not confident that you will find the right match in the first few tries use this agent to perform the search for you.',
  tools: ['*'], // 通配符：允许使用所有可用工具
  source: 'built-in',
  baseDir: 'built-in',
  // model is intentionally omitted - uses getDefaultSubagentModel().
  // 模型字段有意省略——运行时由 getDefaultSubagentModel() 决定
  getSystemPrompt: getGeneralPurposeSystemPrompt,
}
