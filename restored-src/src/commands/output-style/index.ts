/**
 * output-style 命令入口 —— 已废弃命令的保留存根
 *
 * 在整体流程中的位置：
 *   该命令曾用于切换输出样式（如流式/非流式），现已被 /config 命令取代。
 *   保留此入口是为了向后兼容——若用户仍然键入 /output-style，
 *   系统会加载 output-style.js 并显示迁移提示，而不是直接报"命令不存在"。
 *
 * 主要职责：
 *   以 isHidden: true 将命令隐藏于帮助列表，同时保持功能可用以兼容旧工作流。
 */
import type { Command } from '../../commands.js'

const outputStyle = {
  type: 'local-jsx',  // 本地进程内渲染 React 组件
  name: 'output-style',
  description: 'Deprecated: use /config to change output style', // 标记为已废弃，引导用户使用 /config
  isHidden: true,     // 隐藏于 /help 列表，避免新用户误用已废弃命令
  load: () => import('./output-style.js'), // 懒加载，显示废弃警告或兼容逻辑
} satisfies Command

export default outputStyle
