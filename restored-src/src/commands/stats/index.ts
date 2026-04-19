/**
 * stats 命令注册入口（commands/stats/index.ts）
 *
 * 本文件将 /stats 命令注册到 Claude Code 全局命令系统。
 * 该命令为用户提供 Claude Code 的使用统计信息和活动概览，包括：
 * Token 消耗量、会话数量、工具调用次数、费用估算等维度的历史数据可视化。
 *
 * 在系统流程中的位置：
 *   用户输入 /stats → 命令注册表匹配 → load() 懒加载 stats.js
 *   → 从本地存储读取使用记录 → 渲染统计图表和数据摘要。
 */

import type { Command } from '../../commands.js'

/**
 * stats 命令描述对象。
 * - type: 'local-jsx' 表示实现层渲染 React 组件，用于展示结构化统计数据。
 * - 无 immediate 标志，命令触发后正常走对话流程展示统计面板。
 */
const stats = {
  type: 'local-jsx',
  name: 'stats',
  description: 'Show your Claude Code usage statistics and activity',
  load: () => import('./stats.js'),  // 懒加载统计数据渲染组件
} satisfies Command

export default stats
