/**
 * prompt.ts — GlobTool 的工具名称与描述常量
 *
 * 【在 Claude Code 系统中的位置】
 * 本文件为 GlobTool 提供工具名称和提示词描述。
 * GlobTool.ts 在注册工具时使用 GLOB_TOOL_NAME，并将 DESCRIPTION 作为工具描述和提示词。
 *
 * 【主要功能】
 * - 导出 GLOB_TOOL_NAME（工具名称 "Glob"）
 * - 导出 DESCRIPTION：多行提示词字符串，向模型说明工具能力和使用场景
 *   - 支持任意代码库规模的快速文件名模式匹配
 *   - 支持 glob 模式（如 "**\/*.js"、"src/**\/*.ts"）
 *   - 结果按修改时间降序排列
 *   - 适用于按名称查找文件的场景；开放式多轮搜索建议使用 Agent 工具
 */

/** 工具名称常量，供全局引用 */
export const GLOB_TOOL_NAME = 'Glob'

/**
 * 工具描述字符串，同时用于 Claude API tool definition 的 description 字段
 * 和工具的 prompt() 方法返回值。
 *
 * 描述要点：
 * - 速度快，适用于任何规模的代码库
 * - 支持标准 glob 语法（**、*、? 等）
 * - 结果按 mtime 排序，最近修改的文件优先
 * - 建议用途：按文件名或路径模式查找文件
 * - 提示：开放式、多轮搜索应使用 Agent 工具
 */
export const DESCRIPTION = `- Fast file pattern matching tool that works with any codebase size
- Supports glob patterns like "**/*.js" or "src/**/*.ts"
- Returns matching file paths sorted by modification time
- Use this tool when you need to find files by name patterns
- When you are doing an open ended search that may require multiple rounds of globbing and grepping, use the Agent tool instead`
