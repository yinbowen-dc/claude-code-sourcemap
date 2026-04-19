/**
 * config 命令的注册入口。
 *
 * 在 Claude Code 的命令体系中，config 命令（别名 settings）用于打开图形化的
 * 配置面板，让用户在交互式 REPL 中直接修改各项全局与项目级设置。
 * 类型为 'local-jsx'，意味着实现层使用 React/Ink 组件进行终端 UI 渲染，
 * 实现代码通过懒加载方式引入，避免影响启动性能。
 */
import type { Command } from '../../commands.js'

const config = {
  // 'settings' 是 'config' 的别名，用户输入 /settings 同样可触发此命令
  aliases: ['settings'],
  // local-jsx 类型表示该命令使用 Ink（React）渲染终端 UI
  type: 'local-jsx',
  name: 'config',
  description: 'Open config panel',
  // 懒加载 JSX 实现，config.js 包含完整的配置面板组件
  load: () => import('./config.js'),
} satisfies Command

export default config
