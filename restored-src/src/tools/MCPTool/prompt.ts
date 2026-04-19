/**
 * prompt.ts — MCPTool 的占位符描述常量
 *
 * 【在 Claude Code 系统中的位置】
 * 本文件为 MCPTool 骨架提供占位符描述常量。
 * MCPTool.ts 使用 DESCRIPTION 和 PROMPT 作为 description() 和 prompt() 的返回值。
 * 在运行时，mcpClient.ts 会用各 MCP 工具的实际描述覆盖这些占位符值，
 * 因此这里的空字符串不会暴露给模型。
 *
 * 【主要功能】
 * - 导出 PROMPT：空字符串占位符（在 mcpClient.ts 中覆盖为真实工具 prompt）
 * - 导出 DESCRIPTION：空字符串占位符（在 mcpClient.ts 中覆盖为真实工具描述）
 */

/** 工具 prompt 占位符（在 mcpClient.ts 中覆盖为真实 MCP 工具的 prompt） */
// Actual prompt and description are overridden in mcpClient.ts
export const PROMPT = ''

/** 工具描述占位符（在 mcpClient.ts 中覆盖为真实 MCP 工具的 description） */
export const DESCRIPTION = ''
