/**
 * 【EnterPlanModeTool 常量模块】
 *
 * 在 Claude Code 系统流程中的位置：
 *   EnterPlanModeTool（进入计划模式工具）允许 AI 模型在执行复杂任务之前，
 *   先切换到只读探索与设计阶段（plan mode），经用户确认后再动手写代码。
 *   本文件集中存放该工具的注册名称常量，供工具注册表、权限系统及
 *   ExitPlanModeTool 等相关模块统一引用，避免硬编码字符串。
 *
 * 主要功能：
 *   - 导出工具名称常量，作为工具系统中的唯一标识符。
 */

// EnterPlanModeTool 在工具注册表中的名称，用于工具调度、权限判断及状态切换
export const ENTER_PLAN_MODE_TOOL_NAME = 'EnterPlanMode'
