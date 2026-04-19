/**
 * TaskGetTool/constants.ts — 任务查询工具的名称常量
 *
 * 在 Claude Code 系统流程中的位置：
 *   工具层（tools/TaskGetTool）→ 常量定义层
 *
 * 主要功能：
 *   - 导出 TaskGet 工具的注册名称常量
 *   - 供工具注册、权限系统和跨文件引用使用
 */

// TaskGet 工具的注册名称，供模型调用时识别
export const TASK_GET_TOOL_NAME = 'TaskGet'
