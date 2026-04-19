/**
 * 【ExitPlanModeTool 常量模块】
 *
 * 在 Claude Code 系统流程中的位置：
 *   ExitPlanModeTool（退出计划模式工具）是计划模式生命周期的终点——
 *   AI 在 plan mode 中完成探索与方案设计后，调用此工具向用户展示计划并请求批准，
 *   批准后会话恢复为正常（或 auto）执行模式。
 *   本文件集中定义该工具的名称常量，供工具注册、权限校验、
 *   EnterPlanModeTool 及相关 UI 模块统一引用。
 *
 * 主要功能：
 *   - 导出 ExitPlanMode 工具在注册表中的名称常量（两个别名指向同一个字符串）。
 */

// V1 工具名称常量（保留向后兼容）
export const EXIT_PLAN_MODE_TOOL_NAME = 'ExitPlanMode'

// V2 工具名称常量，当前实际使用的版本
export const EXIT_PLAN_MODE_V2_TOOL_NAME = 'ExitPlanMode'
