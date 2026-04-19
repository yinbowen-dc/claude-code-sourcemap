/**
 * prompt.ts — FileWriteTool 的工具名称与提示词描述
 *
 * 【在 Claude Code 系统中的位置】
 * 本文件为 FileWriteTool 提供工具名称常量和提示词生成函数。
 * FileWriteTool.ts 在注册工具时使用 FILE_WRITE_TOOL_NAME，
 * 并在 prompt() 方法中调用 getWriteToolDescription() 生成完整的使用说明。
 *
 * 【主要功能】
 * - 导出 FILE_WRITE_TOOL_NAME（工具名称 "Write"）
 * - 导出 DESCRIPTION（简短描述字符串）
 * - getPreReadInstruction()：生成"写入前必须先读取"的提示词片段（引用 FileReadTool 名称）
 * - getWriteToolDescription()：组合完整的写入工具提示词，
 *   包含覆盖说明、先读后写约束、优先使用 Edit 工具、禁止创建 markdown/README、
 *   以及禁止未经请求使用 emoji 等约束
 */

import { FILE_READ_TOOL_NAME } from '../FileReadTool/prompt.js'

/** 工具名称常量，供全局引用 */
export const FILE_WRITE_TOOL_NAME = 'Write'

/** 工具简短描述 */
export const DESCRIPTION = 'Write a file to the local filesystem.'

/**
 * 生成"写入前必须先读取"的提示词片段。
 * 动态引用 FILE_READ_TOOL_NAME 避免硬编码，确保与 FileReadTool 名称同步。
 *
 * @returns 换行开头的约束说明字符串
 */
function getPreReadInstruction(): string {
  return `\n- If this is an existing file, you MUST use the ${FILE_READ_TOOL_NAME} tool first to read the file's contents. This tool will fail if you did not read the file first.`
}

/**
 * 生成 FileWriteTool 的完整提示词描述。
 *
 * 提示词约束模型遵循以下规则：
 * 1. 本工具会完整覆盖目标路径的已有内容
 * 2. 写入已有文件前必须先读取（防止意外覆盖）
 * 3. 优先使用 Edit 工具进行局部修改（仅发送 diff，效率更高）
 * 4. 除非明确被要求，否则不得创建 .md 文档或 README 文件
 * 5. 除非用户明确要求，否则不得在文件中使用 emoji
 *
 * @returns 完整的工具使用说明字符串
 */
export function getWriteToolDescription(): string {
  return `Writes a file to the local filesystem.

Usage:
- This tool will overwrite the existing file if there is one at the provided path.${getPreReadInstruction()}
- Prefer the Edit tool for modifying existing files \u2014 it only sends the diff. Only use this tool to create new files or for complete rewrites.
- NEVER create documentation files (*.md) or README files unless explicitly requested by the User.
- Only use emojis if the user explicitly requests it. Avoid writing emojis to files unless asked.`
}
