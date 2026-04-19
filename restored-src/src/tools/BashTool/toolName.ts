/**
 * BashTool/toolName.ts
 *
 * 【在 Claude Code 系统中的位置】
 * 本文件仅导出 BashTool 的名称常量 BASH_TOOL_NAME。
 * 之所以独立为单独文件，是为了打破 BashTool.ts 与 prompt.ts 之间的循环依赖：
 *   - prompt.ts 需要引用工具名称
 *   - BashTool.ts 需要引用 prompt.ts 中的提示词
 *   - 若工具名称定义在 BashTool.ts 中，则形成循环引用
 * 将名称常量提取到此独立文件，使两者都可安全引用，彻底消除循环依赖。
 *
 * 【主要功能】
 * - 导出 BASH_TOOL_NAME 常量，值为 'Bash'，用于在系统中唯一标识 BashTool。
 */

// 此处定义工具名称以打断 prompt.ts 的循环依赖
// Here to break circular dependency from prompt.ts
export const BASH_TOOL_NAME = 'Bash'
