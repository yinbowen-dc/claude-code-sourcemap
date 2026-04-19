/**
 * ConfigTool/constants.ts
 *
 * 【在系统中的位置】
 * 本文件是 ConfigTool 模块的常量定义入口，被 ConfigTool.ts、prompt.ts 等模块引用。
 * 在 Claude Code 工具体系中，ConfigTool 负责读写用户配置（主题、模型等），
 * 此文件通过导出工具名称字符串，作为工具注册和路由的唯一标识。
 *
 * 【主要功能】
 * 导出 ConfigTool 在整个系统中使用的工具名称常量，避免硬编码字符串散落各处，
 * 便于全局重命名和维护。
 */

// ConfigTool 的工具名称，用于工具注册、权限校验、日志记录等场景
export const CONFIG_TOOL_NAME = 'Config'
