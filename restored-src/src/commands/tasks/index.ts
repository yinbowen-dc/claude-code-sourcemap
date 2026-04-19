/**
 * tasks 命令注册入口（commands/tasks/index.ts）
 *
 * 本文件将 /tasks（及别名 /bashes）命令注册到 Claude Code 全局命令系统。
 * 该命令用于列出和管理当前会话中所有正在运行的后台任务（Background Tasks），
 * 这些任务通常是通过 RemoteAgentTask 机制启动的长时间运行操作，
 * 例如 /ultrareview、/ultraplan 等在远端 CCR 环境执行的云端任务。
 *
 * 在系统流程中的位置：
 *   用户输入 /tasks → 命令注册表匹配 → load() 懒加载 tasks.js
 *   → 读取 RemoteAgentTask 注册表 → 渲染任务列表（状态、进度、操作按钮）
 *   → 用户可查看、取消或等待任务完成。
 */

import type { Command } from '../../commands.js'

/**
 * tasks 命令描述对象。
 * - aliases: ['bashes'] 提供 /bashes 作为兼容性别名（历史遗留命名，曾用于管理 Bash 后台进程）。
 * - type: 'local-jsx' 渲染任务列表管理 React 组件，支持交互式操作。
 */
const tasks = {
  type: 'local-jsx',
  name: 'tasks',
  aliases: ['bashes'],  // 历史兼容别名，保留以不破坏已有用户习惯
  description: 'List and manage background tasks',
  load: () => import('./tasks.js'),
} satisfies Command

export default tasks
