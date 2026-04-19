/**
 * 【EnterPlanModeTool 提示词模块】
 *
 * 在 Claude Code 系统流程中的位置：
 *   本文件为 EnterPlanModeTool 提供发送给 Claude 模型的工具使用指南（system prompt 片段）。
 *   根据用户类型（USER_TYPE=ant 内部用户 vs 外部用户）以及是否启用了"面试阶段"
 *   （isPlanModeInterviewPhaseEnabled），导出不同版本的提示词内容。
 *
 * 主要功能：
 *   - WHAT_HAPPENS_SECTION：描述计划模式中 AI 应执行的六个步骤（探索→设计→提呈方案）
 *   - getEnterPlanModeToolPromptExternal()：外部用户版，倾向于在大多数非平凡任务中主动使用计划模式
 *   - getEnterPlanModeToolPromptAnt()：内部用户版，更保守，仅在存在真正歧义时使用计划模式
 *   - getEnterPlanModeToolPrompt()：入口函数，按 USER_TYPE 分发两个版本
 */

import { isPlanModeInterviewPhaseEnabled } from '../../utils/planModeV2.js'
import { ASK_USER_QUESTION_TOOL_NAME } from '../AskUserQuestionTool/prompt.js'

/**
 * 计划模式中的行为说明章节（六步流程）。
 * 仅在未启用面试阶段（interview phase）时追加到提示词中；
 * 面试阶段启用时，详细工作流由 plan_mode 附件（messages.ts）在运行时注入。
 */
const WHAT_HAPPENS_SECTION = `## What Happens in Plan Mode

In plan mode, you'll:
1. Thoroughly explore the codebase using Glob, Grep, and Read tools
2. Understand existing patterns and architecture
3. Design an implementation approach
4. Present your plan to the user for approval
5. Use ${ASK_USER_QUESTION_TOOL_NAME} if you need to clarify approaches
6. Exit plan mode with ExitPlanMode when ready to implement

`

/**
 * 外部用户版提示词：鼓励在大多数非平凡任务中主动进入计划模式。
 *
 * 涵盖七种应使用计划模式的场景（新功能/多方案/代码修改/架构决策/多文件改动/需求不清/用户偏好），
 * 并列举不应使用的简单情况（单行修改/小调整/明确指令等），附有正反案例。
 *
 * 若面试阶段已启用，则省略 WHAT_HAPPENS_SECTION（避免重复）。
 */
function getEnterPlanModeToolPromptExternal(): string {
  // 面试阶段启用时，省略"计划模式中的步骤"说明章节，避免与附件内容重复
  const whatHappens = isPlanModeInterviewPhaseEnabled()
    ? ''
    : WHAT_HAPPENS_SECTION

  return `Use this tool proactively when you're about to start a non-trivial implementation task. Getting user sign-off on your approach before writing code prevents wasted effort and ensures alignment. This tool transitions you into plan mode where you can explore the codebase and design an implementation approach for user approval.

## When to Use This Tool

**Prefer using EnterPlanMode** for implementation tasks unless they're simple. Use it when ANY of these conditions apply:

1. **New Feature Implementation**: Adding meaningful new functionality
   - Example: "Add a logout button" - where should it go? What should happen on click?
   - Example: "Add form validation" - what rules? What error messages?

2. **Multiple Valid Approaches**: The task can be solved in several different ways
   - Example: "Add caching to the API" - could use Redis, in-memory, file-based, etc.
   - Example: "Improve performance" - many optimization strategies possible

3. **Code Modifications**: Changes that affect existing behavior or structure
   - Example: "Update the login flow" - what exactly should change?
   - Example: "Refactor this component" - what's the target architecture?

4. **Architectural Decisions**: The task requires choosing between patterns or technologies
   - Example: "Add real-time updates" - WebSockets vs SSE vs polling
   - Example: "Implement state management" - Redux vs Context vs custom solution

5. **Multi-File Changes**: The task will likely touch more than 2-3 files
   - Example: "Refactor the authentication system"
   - Example: "Add a new API endpoint with tests"

6. **Unclear Requirements**: You need to explore before understanding the full scope
   - Example: "Make the app faster" - need to profile and identify bottlenecks
   - Example: "Fix the bug in checkout" - need to investigate root cause

7. **User Preferences Matter**: The implementation could reasonably go multiple ways
   - If you would use ${ASK_USER_QUESTION_TOOL_NAME} to clarify the approach, use EnterPlanMode instead
   - Plan mode lets you explore first, then present options with context

## When NOT to Use This Tool

Only skip EnterPlanMode for simple tasks:
- Single-line or few-line fixes (typos, obvious bugs, small tweaks)
- Adding a single function with clear requirements
- Tasks where the user has given very specific, detailed instructions
- Pure research/exploration tasks (use the Agent tool with explore agent instead)

${whatHappens}## Examples

### GOOD - Use EnterPlanMode:
User: "Add user authentication to the app"
- Requires architectural decisions (session vs JWT, where to store tokens, middleware structure)

User: "Optimize the database queries"
- Multiple approaches possible, need to profile first, significant impact

User: "Implement dark mode"
- Architectural decision on theme system, affects many components

User: "Add a delete button to the user profile"
- Seems simple but involves: where to place it, confirmation dialog, API call, error handling, state updates

User: "Update the error handling in the API"
- Affects multiple files, user should approve the approach

### BAD - Don't use EnterPlanMode:
User: "Fix the typo in the README"
- Straightforward, no planning needed

User: "Add a console.log to debug this function"
- Simple, obvious implementation

User: "What files handle routing?"
- Research task, not implementation planning

## Important Notes

- This tool REQUIRES user approval - they must consent to entering plan mode
- If unsure whether to use it, err on the side of planning - it's better to get alignment upfront than to redo work
- Users appreciate being consulted before significant changes are made to their codebase
`
}

/**
 * 内部用户（ant）版提示词：更保守，仅在存在真正架构歧义或需求不明确时使用计划模式。
 *
 * 强调"当能合理推断方向时应直接开始工作"，避免不必要的计划开销。
 * 当面试阶段启用时同样省略 WHAT_HAPPENS_SECTION。
 */
function getEnterPlanModeToolPromptAnt(): string {
  // 面试阶段启用时，省略步骤说明章节
  const whatHappens = isPlanModeInterviewPhaseEnabled()
    ? ''
    : WHAT_HAPPENS_SECTION

  return `Use this tool when a task has genuine ambiguity about the right approach and getting user input before coding would prevent significant rework. This tool transitions you into plan mode where you can explore the codebase and design an implementation approach for user approval.

## When to Use This Tool

Plan mode is valuable when the implementation approach is genuinely unclear. Use it when:

1. **Significant Architectural Ambiguity**: Multiple reasonable approaches exist and the choice meaningfully affects the codebase
   - Example: "Add caching to the API" - Redis vs in-memory vs file-based
   - Example: "Add real-time updates" - WebSockets vs SSE vs polling

2. **Unclear Requirements**: You need to explore and clarify before you can make progress
   - Example: "Make the app faster" - need to profile and identify bottlenecks
   - Example: "Refactor this module" - need to understand what the target architecture should be

3. **High-Impact Restructuring**: The task will significantly restructure existing code and getting buy-in first reduces risk
   - Example: "Redesign the authentication system"
   - Example: "Migrate from one state management approach to another"

## When NOT to Use This Tool

Skip plan mode when you can reasonably infer the right approach:
- The task is straightforward even if it touches multiple files
- The user's request is specific enough that the implementation path is clear
- You're adding a feature with an obvious implementation pattern (e.g., adding a button, a new endpoint following existing conventions)
- Bug fixes where the fix is clear once you understand the bug
- Research/exploration tasks (use the Agent tool instead)
- The user says something like "can we work on X" or "let's do X" — just get started

When in doubt, prefer starting work and using ${ASK_USER_QUESTION_TOOL_NAME} for specific questions over entering a full planning phase.

${whatHappens}## Examples

### GOOD - Use EnterPlanMode:
User: "Add user authentication to the app"
- Genuinely ambiguous: session vs JWT, where to store tokens, middleware structure

User: "Redesign the data pipeline"
- Major restructuring where the wrong approach wastes significant effort

### BAD - Don't use EnterPlanMode:
User: "Add a delete button to the user profile"
- Implementation path is clear; just do it

User: "Can we work on the search feature?"
- User wants to get started, not plan

User: "Update the error handling in the API"
- Start working; ask specific questions if needed

User: "Fix the typo in the README"
- Straightforward, no planning needed

## Important Notes

- This tool REQUIRES user approval - they must consent to entering plan mode
`
}

/**
 * 工具提示词入口函数：根据 USER_TYPE 环境变量分发不同版本的提示词。
 *
 * - USER_TYPE === 'ant'：返回 Anthropic 内部用户版（更保守的计划模式指南）
 * - 其他（外部用户）：返回完整的主动规划指南
 */
export function getEnterPlanModeToolPrompt(): string {
  return process.env.USER_TYPE === 'ant'
    ? getEnterPlanModeToolPromptAnt()
    : getEnterPlanModeToolPromptExternal()
}
