/**
 * help 命令入口模块
 *
 * 在 Claude Code 命令体系中，本文件是 `/help` 命令的注册描述符。
 * `/help` 是用户了解所有可用斜杠命令的入口，采用 JSX 渲染方式展示
 * 格式化的帮助页面（包含命令名称、描述等信息）。
 * 系统启动后，commands 注册表自动加载此描述符，
 * 当用户输入 `/help` 时懒加载 `help.js` 渲染帮助 UI。
 */
import type { Command } from '../../commands.js'

/**
 * help 命令描述符对象
 *
 * - type: 'local-jsx' 表示该命令通过 React/Ink JSX 组件渲染输出，适合展示结构化 UI
 * - load: 懒加载帮助页面的 JSX 渲染实现，避免启动时预加载全部 UI 组件
 * - 未设置 isEnabled/isHidden，表示对所有用户无条件启用且公开可见
 */
const help = {
  type: 'local-jsx',
  name: 'help',
  description: 'Show help and available commands',
  // 按需懒加载 JSX 渲染实现，减少冷启动时间
  load: () => import('./help.js'),
} satisfies Command

export default help
