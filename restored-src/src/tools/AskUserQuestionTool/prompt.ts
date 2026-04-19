/**
 * AskUserQuestionTool/prompt.ts
 *
 * 【在 Claude Code 系统中的位置】
 * 本文件属于 AskUserQuestionTool 工具模块，负责定义该工具的名称常量、
 * 描述文字以及向模型注入的系统提示词（prompt）。
 *
 * 在整体流程中：
 *   1. Claude 模型在执行任务期间，若需向用户提问（如澄清需求、获取偏好选择），
 *      会调用 AskUserQuestion 工具。
 *   2. 本文件导出的常量被工具定义文件和系统提示构建逻辑直接引用。
 *   3. PREVIEW_FEATURE_PROMPT 用于在支持 preview 字段时提示模型如何呈现
 *      可视化内容对比选项（markdown 或 HTML 格式）。
 *
 * 【主要功能】
 * - 导出工具名称、芯片宽度等 UI 常量
 * - 导出工具的自然语言描述（用于模型了解何时使用此工具）
 * - 导出注入给模型的使用说明提示词
 * - 导出 preview 预览功能的说明文本（区分 markdown 和 html 两种格式）
 */

import { EXIT_PLAN_MODE_TOOL_NAME } from '../ExitPlanModeTool/constants.js'

// 工具名称常量，用于在系统中唯一标识 AskUserQuestion 工具
export const ASK_USER_QUESTION_TOOL_NAME = 'AskUserQuestion'

// 工具在 UI 芯片（chip）中显示的宽度（列数）
export const ASK_USER_QUESTION_TOOL_CHIP_WIDTH = 12

// 工具的自然语言描述，供模型在工具选择时参考
export const DESCRIPTION =
  'Asks the user multiple choice questions to gather information, clarify ambiguity, understand preferences, make decisions or offer them choices.'

/**
 * PREVIEW_FEATURE_PROMPT
 *
 * 向模型说明如何使用 options 中可选的 `preview` 字段，
 * 以便用户在需要视觉比较的场景（如 UI 布局、代码片段差异）下
 * 能通过并排布局更直观地做出选择。
 *
 * 包含两种格式：
 *   - markdown：将 preview 内容渲染为等宽字体块
 *   - html：将 preview 内容渲染为独立 HTML 片段（不含 <html>/<body> 包装）
 *
 * 注意：preview 仅支持单选题（非 multiSelect 模式）。
 */
export const PREVIEW_FEATURE_PROMPT = {
  markdown: `
Preview feature:
Use the optional \`preview\` field on options when presenting concrete artifacts that users need to visually compare:
- ASCII mockups of UI layouts or components
- Code snippets showing different implementations
- Diagram variations
- Configuration examples

Preview content is rendered as markdown in a monospace box. Multi-line text with newlines is supported. When any option has a preview, the UI switches to a side-by-side layout with a vertical option list on the left and preview on the right. Do not use previews for simple preference questions where labels and descriptions suffice. Note: previews are only supported for single-select questions (not multiSelect).
`,
  html: `
Preview feature:
Use the optional \`preview\` field on options when presenting concrete artifacts that users need to visually compare:
- HTML mockups of UI layouts or components
- Formatted code snippets showing different implementations
- Visual comparisons or diagrams

Preview content must be a self-contained HTML fragment (no <html>/<body> wrapper, no <script> or <style> tags — use inline style attributes instead). Do not use previews for simple preference questions where labels and descriptions suffice. Note: previews are only supported for single-select questions (not multiSelect).
`,
} as const

/**
 * ASK_USER_QUESTION_TOOL_PROMPT
 *
 * 注入给模型的系统提示词，详细说明此工具的使用场景和注意事项：
 *   1. 收集用户偏好或需求
 *   2. 澄清模糊指令
 *   3. 在执行过程中获取实现决策
 *   4. 向用户提供方向选择
 *
 * 特殊说明：
 *   - 用户始终可以选择 "Other" 以输入自定义文本
 *   - 支持多选模式（multiSelect: true）
 *   - 推荐选项应排在第一位并标注 "(Recommended)"
 *   - 在计划模式（plan mode）中，此工具用于澄清需求，
 *     而非询问"计划是否可以继续"——后者应使用 ExitPlanModeTool
 */
export const ASK_USER_QUESTION_TOOL_PROMPT = `Use this tool when you need to ask the user questions during execution. This allows you to:
1. Gather user preferences or requirements
2. Clarify ambiguous instructions
3. Get decisions on implementation choices as you work
4. Offer choices to the user about what direction to take.

Usage notes:
- Users will always be able to select "Other" to provide custom text input
- Use multiSelect: true to allow multiple answers to be selected for a question
- If you recommend a specific option, make that the first option in the list and add "(Recommended)" at the end of the label

Plan mode note: In plan mode, use this tool to clarify requirements or choose between approaches BEFORE finalizing your plan. Do NOT use this tool to ask "Is my plan ready?" or "Should I proceed?" - use ${EXIT_PLAN_MODE_TOOL_NAME} for plan approval. IMPORTANT: Do not reference "the plan" in your questions (e.g., "Do you have feedback about the plan?", "Does the plan look good?") because the user cannot see the plan in the UI until you call ${EXIT_PLAN_MODE_TOOL_NAME}. If you need plan approval, use ${EXIT_PLAN_MODE_TOOL_NAME} instead.
`
