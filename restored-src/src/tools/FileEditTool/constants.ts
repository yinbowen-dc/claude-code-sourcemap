/**
 * 【FileEditTool 常量模块】
 *
 * 在 Claude Code 系统流程中的位置：
 *   FileEditTool（文件编辑工具）是 Claude Code 中最核心的写操作工具之一，
 *   通过精确字符串替换对磁盘文件进行原子修改。
 *   本文件单独存放 FileEditTool 的常量，是为了避免模块间的循环依赖
 *   （多个顶层模块都需要引用这些常量，独立文件可切断依赖环）。
 *
 * 主要功能：
 *   - 导出工具注册名称及与权限、错误处理相关的固定字符串常量。
 */

// 独立文件以避免循环依赖
// FileEditTool 在工具注册表中的名称，对应 API 调用时的 tool_name
export const FILE_EDIT_TOOL_NAME = 'Edit'

// 会话级别权限模式匹配模式：允许访问项目级 .claude/ 目录下的所有文件
export const CLAUDE_FOLDER_PERMISSION_PATTERN = '/.claude/**'

// 会话级别权限模式匹配模式：允许访问全局 ~/.claude/ 目录下的所有文件
export const GLOBAL_CLAUDE_FOLDER_PERMISSION_PATTERN = '~/.claude/**'

// 当文件在上次读取后被外部修改时抛出的错误信息，用于防止覆盖意外变更
export const FILE_UNEXPECTEDLY_MODIFIED_ERROR =
  'File has been unexpectedly modified. Read it again before attempting to write it.'
