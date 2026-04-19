/**
 * skills 命令注册入口（commands/skills/index.ts）
 *
 * 本文件将 /skills 命令注册到 Claude Code 全局命令系统。
 * 该命令用于列出当前环境中所有可用的"技能"（Skills）——即用户或组织预定义的
 * 可复用 AI 行为模板（如 /commit、/review-pr 等自定义工作流）。
 *
 * 在系统流程中的位置：
 *   用户输入 /skills → 命令注册表匹配 → load() 懒加载 skills.js
 *   → 扫描并展示所有已安装技能的名称、描述和触发方式。
 */

import type { Command } from '../../commands.js'

/**
 * skills 命令描述对象。
 * - type: 'local-jsx' 表示实现层渲染 React 组件，以结构化列表展示技能信息。
 * - 无参数提示（argumentHint 未设置），该命令仅支持无参数调用。
 */
const skills = {
  type: 'local-jsx',
  name: 'skills',
  description: 'List available skills',
  load: () => import('./skills.js'),  // 懒加载技能列表渲染组件
} satisfies Command

export default skills
