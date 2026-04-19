/**
 * TaskCreateTool/constants.ts — 任务创建工具的名称常量
 *
 * 在 Claude Code 系统流程中的位置：
 *   工具层（tools/TaskCreateTool）→ 常量定义层
 *
 * 主要功能：
 *   - 导出 TaskCreate 工具的注册名称常量
 *   - 供工具注册、权限系统和跨文件引用使用
 */

// TaskCreate 工具的注册名称，供模型调用时识别
export const TASK_CREATE_TOOL_NAME = 'TaskCreate'
