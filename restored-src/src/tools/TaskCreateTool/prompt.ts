/**
 * TaskCreateTool/prompt.ts — 任务创建工具的提示词构建
 *
 * 在 Claude Code 系统流程中的位置：
 *   工具层（Tools Layer）→ TaskCreateTool 子模块 → 提示词层
 *
 * 主要功能：
 *   - 导出工具功能简介（DESCRIPTION）
 *   - 动态构建工具系统提示词（getPrompt），根据是否启用多智能体集群功能决定是否插入 teammate 相关内容
 *
 * 设计说明：
 *   - isAgentSwarmsEnabled()：运行时检查，决定是否添加 teammate 任务分配说明和建议
 *   - 不启用 swarms 时，提示词专注于单智能体任务管理
 *   - 启用 swarms 时，追加 teammate 任务分配建议和描述详细度要求
 */

import { isAgentSwarmsEnabled } from '../../utils/agentSwarmsEnabled.js'

// 工具功能的静态简介，供工具列表和自动分类器使用
export const DESCRIPTION = 'Create a new task in the task list'

/**
 * 动态构建 TaskCreate 工具的系统提示词
 *
 * 整体流程：
 *   1. 检查 isAgentSwarmsEnabled() 决定是否追加 teammate 相关文本
 *   2. 构建 teammateContext（追加到"复杂任务"使用场景描述末尾）
 *   3. 构建 teammateTips（追加到提示技巧章节）
 *   4. 将以上内容嵌入完整的 Markdown 提示词模板中并返回
 *
 * 提示词包含以下核心章节：
 *   - 使用场景（When to Use This Tool）：多步骤、复杂任务、规划模式、用户明确要求等
 *   - 不使用的场景（When NOT to Use This Tool）：单步骤、琐碎任务等
 *   - 任务字段说明（Task Fields）：subject、description、activeForm
 *   - 使用技巧（Tips）：含可选 teammate 分配建议
 *
 * @returns 完整的提示词字符串
 */
export function getPrompt(): string {
  // 启用多智能体集群时，在使用场景描述中追加"可分配给 teammate"的说明
  const teammateContext = isAgentSwarmsEnabled()
    ? ' and potentially assigned to teammates'
    : ''

  // 启用多智能体集群时，在 Tips 章节追加 teammate 任务描述详细度和分配方式说明
  const teammateTips = isAgentSwarmsEnabled()
    ? `- Include enough detail in the description for another agent to understand and complete the task
- New tasks are created with status 'pending' and no owner - use TaskUpdate with the \`owner\` parameter to assign them
`
    : ''

  return `Use this tool to create a structured task list for your current coding session. This helps you track progress, organize complex tasks, and demonstrate thoroughness to the user.
It also helps the user understand the progress of the task and overall progress of their requests.

## When to Use This Tool

Use this tool proactively in these scenarios:

- Complex multi-step tasks - When a task requires 3 or more distinct steps or actions
- Non-trivial and complex tasks - Tasks that require careful planning or multiple operations${teammateContext}
- Plan mode - When using plan mode, create a task list to track the work
- User explicitly requests todo list - When the user directly asks you to use the todo list
- User provides multiple tasks - When users provide a list of things to be done (numbered or comma-separated)
- After receiving new instructions - Immediately capture user requirements as tasks
- When you start working on a task - Mark it as in_progress BEFORE beginning work
- After completing a task - Mark it as completed and add any new follow-up tasks discovered during implementation

## When NOT to Use This Tool

Skip using this tool when:
- There is only a single, straightforward task
- The task is trivial and tracking it provides no organizational benefit
- The task can be completed in less than 3 trivial steps
- The task is purely conversational or informational

NOTE that you should not use this tool if there is only one trivial task to do. In this case you are better off just doing the task directly.

## Task Fields

- **subject**: A brief, actionable title in imperative form (e.g., "Fix authentication bug in login flow")
- **description**: What needs to be done
- **activeForm** (optional): Present continuous form shown in the spinner when the task is in_progress (e.g., "Fixing authentication bug"). If omitted, the spinner shows the subject instead.

All tasks are created with status \`pending\`.

## Tips

- Create tasks with clear, specific subjects that describe the outcome
- After creating tasks, use TaskUpdate to set up dependencies (blocks/blockedBy) if needed
${teammateTips}- Check TaskList first to avoid creating duplicate tasks
`
}
