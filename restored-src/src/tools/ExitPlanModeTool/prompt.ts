/**
 * 【ExitPlanModeTool 提示词模块】
 *
 * 在 Claude Code 系统流程中的位置：
 *   本文件为 ExitPlanModeV2Tool 提供静态工具使用说明常量（system prompt 片段）。
 *   被 ExitPlanModeV2Tool.ts 的 prompt() 钩子引用，随系统提示注入上下文。
 *
 * 主要功能：
 *   - 导出 EXIT_PLAN_MODE_V2_TOOL_PROMPT：说明何时调用、工具行为（从文件读取计划）、
 *     使用前提（计划已写入文件）及与 AskUserQuestion 的区别
 *   - 提供三个示例区分"应使用"和"不应使用"的场景
 */

// 外部存根（stub）：排除了仅限 Ant 内部的 allowedPrompts 章节
// 硬编码常量避免相对导入问题
const ASK_USER_QUESTION_TOOL_NAME = 'AskUserQuestion'

/**
 * ExitPlanModeV2Tool 的工具提示词常量。
 *
 * 核心要点：
 * - 仅在计划模式下、已将计划写入计划文件后才调用
 * - 不接收计划内容参数——工具从磁盘文件读取计划
 * - 用于通知用户"计划完成，请审批"，而非询问"计划是否可以？"
 * - 研究/探索类任务（非实现规划）不应使用此工具
 */
export const EXIT_PLAN_MODE_V2_TOOL_PROMPT = `Use this tool when you are in plan mode and have finished writing your plan to the plan file and are ready for user approval.

## How This Tool Works
- You should have already written your plan to the plan file specified in the plan mode system message
- This tool does NOT take the plan content as a parameter - it will read the plan from the file you wrote
- This tool simply signals that you're done planning and ready for the user to review and approve
- The user will see the contents of your plan file when they review it

## When to Use This Tool
IMPORTANT: Only use this tool when the task requires planning the implementation steps of a task that requires writing code. For research tasks where you're gathering information, searching files, reading files or in general trying to understand the codebase - do NOT use this tool.

## Before Using This Tool
Ensure your plan is complete and unambiguous:
- If you have unresolved questions about requirements or approach, use ${ASK_USER_QUESTION_TOOL_NAME} first (in earlier phases)
- Once your plan is finalized, use THIS tool to request approval

**Important:** Do NOT use ${ASK_USER_QUESTION_TOOL_NAME} to ask "Is this plan okay?" or "Should I proceed?" - that's exactly what THIS tool does. ExitPlanMode inherently requests user approval of your plan.

## Examples

1. Initial task: "Search for and understand the implementation of vim mode in the codebase" - Do not use the exit plan mode tool because you are not planning the implementation steps of a task.
2. Initial task: "Help me implement yank mode for vim" - Use the exit plan mode tool after you have finished planning the implementation steps of the task.
3. Initial task: "Add a new feature to handle user authentication" - If unsure about auth method (OAuth, JWT, etc.), use ${ASK_USER_QUESTION_TOOL_NAME} first, then use exit plan mode tool after clarifying the approach.
`
