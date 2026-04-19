/**
 * hooks 命令入口模块
 *
 * 在 Claude Code 命令体系中，本文件是 `/hooks` 命令的注册描述符。
 * Hooks（钩子）机制允许用户为工具事件（如文件编辑后、Bash 执行前等）
 * 配置自动运行的 shell 命令，实现格式化、lint 等自动化操作。
 * `/hooks` 命令提供一个交互式 JSX UI 界面，让用户查看和管理当前的钩子配置。
 * `immediate: true` 表示命令触发时立即渲染 UI，无需等待任何异步操作。
 */
import type { Command } from '../../commands.js'

/**
 * hooks 命令描述符对象
 *
 * - type: 'local-jsx' 表示通过 JSX 组件渲染交互式 UI 界面
 * - immediate: true 让命令触发后立即呈现 UI，不进入"正在加载"过渡状态
 * - load: 懒加载 hooks.js 渲染实现，按需导入以减少初始启动开销
 */
const hooks = {
  type: 'local-jsx',
  name: 'hooks',
  description: 'View hook configurations for tool events',
  // 立即展示 UI，不显示过渡加载状态
  immediate: true,
  // 懒加载钩子配置的 JSX 界面实现
  load: () => import('./hooks.js'),
} satisfies Command

export default hooks
