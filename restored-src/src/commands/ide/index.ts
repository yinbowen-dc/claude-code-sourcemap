/**
 * ide 命令入口模块
 *
 * 在 Claude Code 命令体系中，本文件是 `/ide` 命令的注册描述符。
 * `/ide` 命令用于管理 Claude Code 与 IDE（如 VS Code、JetBrains 等）之间的集成连接，
 * 并展示当前集成状态（是否已连接、连接的编辑器名称等）。
 * 可选参数 `open` 支持直接从命令行打开 IDE。
 * 系统启动后由 commands 注册表加载，触发时懒加载 `ide.js` 渲染 JSX 状态界面。
 */
import type { Command } from '../../commands.js'

/**
 * ide 命令描述符对象
 *
 * - type: 'local-jsx' 表示通过 JSX 组件渲染 IDE 集成状态界面
 * - argumentHint: 向用户提示可选参数 `open`，用于打开 IDE
 * - load: 懒加载 ide.js 实现，按需导入，减少启动开销
 */
const ide = {
  type: 'local-jsx',
  name: 'ide',
  description: 'Manage IDE integrations and show status',
  // 提示用户可传入 `open` 参数以直接打开当前 IDE
  argumentHint: '[open]',
  // 懒加载 IDE 集成管理的 JSX 界面实现
  load: () => import('./ide.js'),
} satisfies Command

export default ide
