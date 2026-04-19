/**
 * TaskListTool/constants.ts
 *
 * 【文件定位】
 * 属于任务管理子系统（TodoV2）的常量定义层。
 * 在整个 Claude Code 工具体系中，TaskListTool 负责列出当前任务列表，
 * 本文件统一导出该工具的名称常量，供工具注册、路由及权限校验时引用。
 */

// 工具名称常量：标识 TaskList 工具的唯一名称
// 与 buildTool({ name }) 及 ToolSearch 的 select 查询保持一致
export const TASK_LIST_TOOL_NAME = 'TaskList'
