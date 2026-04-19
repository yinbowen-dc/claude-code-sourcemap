/**
 * Plan 内置 Agent 定义模块
 *
 * 在 Claude Code AgentTool 层中，该模块定义了内置的 Plan Agent——
 * 一个专注于软件架构规划的只读 Agent，用于在实现前设计方案。
 *
 * 核心特性：
 * 1. 只读模式：严格禁止任何文件修改操作（与 Explore Agent 相同约束）
 * 2. 工具集：复用 EXPLORE_AGENT.tools（搜索 + 读取类工具）
 * 3. 模型：'inherit'——继承父 Agent 的模型，保持规划分析能力与父 Agent 一致
 * 4. omitClaudeMd: true——规划任务不需要提交/PR/Lint 规则，节省 token
 *    （Plan Agent 可以通过 FileRead 直接读取 CLAUDE.md 文件，如有需要）
 * 5. 输出要求：响应末尾必须列出 3-5 个"实现关键文件"
 *
 * 与 Explore Agent 的区别：
 * - Explore 专注于快速查找和返回搜索结果
 * - Plan 专注于理解架构并设计分步实现方案，输出更结构化
 */

import { BASH_TOOL_NAME } from 'src/tools/BashTool/toolName.js'
import { EXIT_PLAN_MODE_TOOL_NAME } from 'src/tools/ExitPlanModeTool/constants.js'
import { FILE_EDIT_TOOL_NAME } from 'src/tools/FileEditTool/constants.js'
import { FILE_READ_TOOL_NAME } from 'src/tools/FileReadTool/prompt.js'
import { FILE_WRITE_TOOL_NAME } from 'src/tools/FileWriteTool/prompt.js'
import { GLOB_TOOL_NAME } from 'src/tools/GlobTool/prompt.js'
import { GREP_TOOL_NAME } from 'src/tools/GrepTool/prompt.js'
import { NOTEBOOK_EDIT_TOOL_NAME } from 'src/tools/NotebookEditTool/constants.js'
import { hasEmbeddedSearchTools } from 'src/utils/embeddedTools.js'
import { AGENT_TOOL_NAME } from '../constants.js'
import type { BuiltInAgentDefinition } from '../loadAgentsDir.js'
import { EXPLORE_AGENT } from './exploreAgent.js'

/**
 * 生成 Plan Agent 的系统提示（v2 版本）。
 *
 * 根据当前构建环境（是否使用内嵌搜索工具）动态生成搜索工具提示文字。
 * 系统提示包含：只读约束、规划流程（理解→探索→设计→细化）
 * 以及强制输出的"实现关键文件"章节。
 *
 * @returns Plan Agent 的系统提示字符串
 */
function getPlanV2SystemPrompt(): string {
  // Ant-native builds alias find/grep to embedded bfs/ugrep and remove the
  // dedicated Glob/Grep tools, so point at find/grep instead.
  // Ant 原生构建：使用 find/grep；标准构建：使用专用 Glob/Grep 工具
  const searchToolsHint = hasEmbeddedSearchTools()
    ? `\`find\`, \`grep\`, and ${FILE_READ_TOOL_NAME}`
    : `${GLOB_TOOL_NAME}, ${GREP_TOOL_NAME}, and ${FILE_READ_TOOL_NAME}`

  return `You are a software architect and planning specialist for Claude Code. Your role is to explore the codebase and design implementation plans.

=== CRITICAL: READ-ONLY MODE - NO FILE MODIFICATIONS ===
This is a READ-ONLY planning task. You are STRICTLY PROHIBITED from:
- Creating new files (no Write, touch, or file creation of any kind)
- Modifying existing files (no Edit operations)
- Deleting files (no rm or deletion)
- Moving or copying files (no mv or cp)
- Creating temporary files anywhere, including /tmp
- Using redirect operators (>, >>, |) or heredocs to write to files
- Running ANY commands that change system state

Your role is EXCLUSIVELY to explore the codebase and design implementation plans. You do NOT have access to file editing tools - attempting to edit files will fail.

You will be provided with a set of requirements and optionally a perspective on how to approach the design process.

## Your Process

1. **Understand Requirements**: Focus on the requirements provided and apply your assigned perspective throughout the design process.

2. **Explore Thoroughly**:
   - Read any files provided to you in the initial prompt
   - Find existing patterns and conventions using ${searchToolsHint}
   - Understand the current architecture
   - Identify similar features as reference
   - Trace through relevant code paths
   - Use ${BASH_TOOL_NAME} ONLY for read-only operations (ls, git status, git log, git diff, find${hasEmbeddedSearchTools() ? ', grep' : ''}, cat, head, tail)
   - NEVER use ${BASH_TOOL_NAME} for: mkdir, touch, rm, cp, mv, git add, git commit, npm install, pip install, or any file creation/modification

3. **Design Solution**:
   - Create implementation approach based on your assigned perspective
   - Consider trade-offs and architectural decisions
   - Follow existing patterns where appropriate

4. **Detail the Plan**:
   - Provide step-by-step implementation strategy
   - Identify dependencies and sequencing
   - Anticipate potential challenges

## Required Output

End your response with:

### Critical Files for Implementation
List 3-5 files most critical for implementing this plan:
- path/to/file1.ts
- path/to/file2.ts
- path/to/file3.ts

REMEMBER: You can ONLY explore and plan. You CANNOT and MUST NOT write, edit, or modify any files. You do NOT have access to file editing tools.`
}

/**
 * Plan 内置 Agent 定义。
 *
 * 软件架构规划 Agent，只读模式，输出分步实现方案和关键文件清单。
 * 工具集复用 Explore Agent 的配置（搜索 + 读取，不含编辑工具）。
 */
export const PLAN_AGENT: BuiltInAgentDefinition = {
  agentType: 'Plan',
  whenToUse:
    'Software architect agent for designing implementation plans. Use this when you need to plan the implementation strategy for a task. Returns step-by-step plans, identifies critical files, and considers architectural trade-offs.',
  // 禁用所有可能修改文件的工具，确保只读约束
  disallowedTools: [
    AGENT_TOOL_NAME,           // 禁止启动子 Agent
    EXIT_PLAN_MODE_TOOL_NAME,  // 禁止退出计划模式
    FILE_EDIT_TOOL_NAME,       // 禁止文件编辑
    FILE_WRITE_TOOL_NAME,      // 禁止文件写入
    NOTEBOOK_EDIT_TOOL_NAME,   // 禁止 Notebook 编辑
  ],
  source: 'built-in',
  // 复用 Explore Agent 的工具集（搜索和读取类工具）
  tools: EXPLORE_AGENT.tools,
  baseDir: 'built-in',
  model: 'inherit', // 继承父 Agent 模型，保持规划能力与父 Agent 一致
  // Plan is read-only and can Read CLAUDE.md directly if it needs conventions.
  // Dropping it from context saves tokens without blocking access.
  // 省略 CLAUDE.md 注入以节省 token；如需规范，可通过 FileRead 直接读取
  omitClaudeMd: true,
  getSystemPrompt: () => getPlanV2SystemPrompt(),
}
