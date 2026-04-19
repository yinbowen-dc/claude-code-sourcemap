/**
 * theme 命令注册入口（commands/theme/index.ts）
 *
 * 本文件将 /theme 命令注册到 Claude Code 全局命令系统。
 * 该命令允许用户切换 Claude Code 终端界面的视觉主题（颜色方案），
 * 包括亮色、暗色及各种自定义配色主题，主题设置持久化到用户配置中。
 *
 * 在系统流程中的位置：
 *   用户输入 /theme → 命令注册表匹配 → load() 懒加载 theme.js
 *   → 渲染主题选择列表（带预览色块）→ 用户选择后更新配置并即时生效。
 */

import type { Command } from '../../commands.js'

/**
 * theme 命令描述对象。
 * - type: 'local-jsx' 表示实现层渲染 React 组件，展示主题选择器 UI（含颜色预览）。
 * - 无 immediate 标志，命令触发后通过正常的渲染流程展示主题选择界面。
 */
const theme = {
  type: 'local-jsx',
  name: 'theme',
  description: 'Change the theme',
  load: () => import('./theme.js'),  // 懒加载主题选择器组件
} satisfies Command

export default theme
