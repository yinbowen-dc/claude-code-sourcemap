/**
 * 【FileEditTool 提示词模块】
 *
 * 在 Claude Code 系统流程中的位置：
 *   本文件为 FileEditTool 提供注入给 Claude 模型的工具使用说明（system prompt 片段）。
 *   FileEditTool.ts 的 prompt() 钩子调用 getEditToolDescription() 获取此内容，
 *   并最终随其他工具描述一起注入模型上下文。
 *
 * 主要功能：
 *   - getPreReadInstruction()：生成"使用前必须先读取文件"的强制前置说明
 *   - getEditToolDescription()：公开接口，委托至 getDefaultEditDescription()
 *   - getDefaultEditDescription()：根据 isCompactLinePrefixEnabled() 动态调整
 *     行号前缀格式说明；对 Ant 内部用户额外追加唯一性最小化提示
 */

import { isCompactLinePrefixEnabled } from '../../utils/file.js'
import { FILE_READ_TOOL_NAME } from '../FileReadTool/prompt.js'

/**
 * 生成"编辑前必须先读取文件"的强制前置说明。
 *
 * 返回以换行符开头的字符串，直接嵌入工具描述的 Usage 章节。
 * 引用 FILE_READ_TOOL_NAME 常量（而非硬编码字符串），确保工具名变更时自动同步。
 */
function getPreReadInstruction(): string {
  return `\n- You must use your \`${FILE_READ_TOOL_NAME}\` tool at least once in the conversation before editing. This tool will error if you attempt an edit without reading the file. `
}

/**
 * 对外暴露的工具描述入口。
 * 当前直接委托给 getDefaultEditDescription()，
 * 保留此层便于未来在不同环境下切换不同描述变体。
 */
export function getEditToolDescription(): string {
  return getDefaultEditDescription()
}

/**
 * 生成默认的 FileEditTool 工具描述文本。
 *
 * 动态逻辑：
 * 1. 根据 isCompactLinePrefixEnabled() 决定行号前缀格式说明：
 *    - true  → "line number + tab"（紧凑格式）
 *    - false → "spaces + line number + arrow"（标准格式）
 * 2. 若当前用户类型为 'ant'（内部用户），追加 minimalUniquenessHint，
 *    提示优先使用最短的唯一 old_string（2-4 行），避免携带冗余上下文行。
 *
 * 固定规则（不随环境变化）：
 * - 优先编辑现有文件，非必要不创建新文件
 * - 不使用 emoji（除非用户明确要求）
 * - old_string 在文件中不唯一时编辑会失败（需扩展上下文或使用 replace_all）
 * - replace_all 用于全局重命名场景
 */
function getDefaultEditDescription(): string {
  // 根据紧凑行号前缀开关确定格式描述字符串
  const prefixFormat = isCompactLinePrefixEnabled()
    ? 'line number + tab'
    : 'spaces + line number + arrow'
  // 仅对 Ant 内部用户追加唯一性最小化提示（外部用户不展示）
  const minimalUniquenessHint =
    process.env.USER_TYPE === 'ant'
      ? `\n- Use the smallest old_string that's clearly unique — usually 2-4 adjacent lines is sufficient. Avoid including 10+ lines of context when less uniquely identifies the target.`
      : ''
  return `Performs exact string replacements in files.

Usage:${getPreReadInstruction()}
- When editing text from Read tool output, ensure you preserve the exact indentation (tabs/spaces) as it appears AFTER the line number prefix. The line number prefix format is: ${prefixFormat}. Everything after that is the actual file content to match. Never include any part of the line number prefix in the old_string or new_string.
- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.
- Only use emojis if the user explicitly requests it. Avoid adding emojis to files unless asked.
- The edit will FAIL if \`old_string\` is not unique in the file. Either provide a larger string with more surrounding context to make it unique or use \`replace_all\` to change every instance of \`old_string\`.${minimalUniquenessHint}
- Use \`replace_all\` for replacing and renaming strings across the file. This parameter is useful if you want to rename a variable for instance.`
}
