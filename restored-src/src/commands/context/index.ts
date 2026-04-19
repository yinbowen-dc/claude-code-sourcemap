/**
 * /context 命令的注册入口，提供交互式与非交互式两个版本。
 *
 * 在 Claude Code 的命令体系中，同一个命令名称（"context"）可以根据
 * 当前会话类型加载不同的实现模块：
 *  - 交互式（REPL）：加载 context.js，渲染彩色方格可视化网格（JSX/Ink 组件）；
 *  - 非交互式（headless/SDK）：加载 context-noninteractive.js，
 *    输出纯文本格式的 Markdown 表格，适合管道和脚本使用。
 *
 * 两个 Command 对象通过 isEnabled / isHidden 的互斥逻辑确保在任意时刻
 * 只有一个版本对用户可见并处于激活状态。
 */
import { getIsNonInteractiveSession } from '../../bootstrap/state.js'
import type { Command } from '../../commands.js'

/** 交互式 REPL 下的 /context 命令：以彩色方格可视化当前上下文用量 */
export const context: Command = {
  name: 'context',
  description: 'Visualize current context usage as a colored grid',
  // 仅在交互式会话中启用，非交互式会话下隐藏
  isEnabled: () => !getIsNonInteractiveSession(),
  // local-jsx 类型：使用 Ink React 组件渲染终端 UI
  type: 'local-jsx',
  load: () => import('./context.js'),
}

/** 非交互式（headless/SDK）会话下的 /context 命令：输出 Markdown 文本表格 */
export const contextNonInteractive: Command = {
  type: 'local',
  name: 'context',
  // 明确标记支持非交互式调用，供 SDK 控制请求使用
  supportsNonInteractive: true,
  description: 'Show current context usage',
  // 在交互式会话中对用户隐藏（避免与上方 context 命令重复显示）
  get isHidden() {
    return !getIsNonInteractiveSession()
  },
  // 仅在非交互式会话中启用
  isEnabled() {
    return getIsNonInteractiveSession()
  },
  load: () => import('./context-noninteractive.js'),
}
