/**
 * prompt.ts — GrepTool 的工具名称与描述生成
 *
 * 【在 Claude Code 系统中的位置】
 * 本文件为 GrepTool 提供工具名称常量和提示词描述生成函数。
 * GrepTool.ts 在注册工具时使用 GREP_TOOL_NAME，
 * 并在 description() 和 prompt() 方法中调用 getDescription() 获取完整的使用说明。
 *
 * 【主要功能】
 * - 导出 GREP_TOOL_NAME（工具名称 "Grep"）
 * - getDescription()：动态生成工具提示词，引用 BASH_TOOL_NAME 和 AGENT_TOOL_NAME
 *   避免硬编码，确保与相关工具名称同步
 *   内容包含：强制使用约束、正则支持、过滤方式、输出模式、开放式搜索建议、
 *   模式语法差异（ripgrep vs grep）、跨行匹配说明
 */

import { AGENT_TOOL_NAME } from '../AgentTool/constants.js'
import { BASH_TOOL_NAME } from '../BashTool/toolName.js'

/** 工具名称常量，供全局引用 */
export const GREP_TOOL_NAME = 'Grep'

/**
 * 生成 GrepTool 的完整提示词描述。
 *
 * 动态引用 GREP_TOOL_NAME、BASH_TOOL_NAME、AGENT_TOOL_NAME，
 * 确保提示词与实际工具名称始终保持一致。
 *
 * 提示词约束模型遵循以下规则：
 * 1. 始终使用 Grep 工具进行搜索，禁止通过 Bash 工具调用 grep 或 rg
 * 2. 支持完整正则语法（如 "log.*Error"、"function\s+\w+"）
 * 3. 使用 glob 参数过滤文件名，使用 type 参数按文件类型过滤
 * 4. 三种输出模式说明（content/files_with_matches/count）
 * 5. 开放式多轮搜索建议使用 Agent 工具
 * 6. ripgrep 模式语法与 grep 不同（大括号需转义）
 * 7. 默认单行匹配，跨行匹配需显式开启 multiline: true
 *
 * @returns 完整的工具使用说明字符串
 */
export function getDescription(): string {
  return `A powerful search tool built on ripgrep

  Usage:
  - ALWAYS use ${GREP_TOOL_NAME} for search tasks. NEVER invoke \`grep\` or \`rg\` as a ${BASH_TOOL_NAME} command. The ${GREP_TOOL_NAME} tool has been optimized for correct permissions and access.
  - Supports full regex syntax (e.g., "log.*Error", "function\\s+\\w+")
  - Filter files with glob parameter (e.g., "*.js", "**/*.tsx") or type parameter (e.g., "js", "py", "rust")
  - Output modes: "content" shows matching lines, "files_with_matches" shows only file paths (default), "count" shows match counts
  - Use ${AGENT_TOOL_NAME} tool for open-ended searches requiring multiple rounds
  - Pattern syntax: Uses ripgrep (not grep) - literal braces need escaping (use \`interface\\{\\}\` to find \`interface{}\` in Go code)
  - Multiline matching: By default patterns match within single lines only. For cross-line patterns like \`struct \\{[\\s\\S]*?field\`, use \`multiline: true\`
`
}
