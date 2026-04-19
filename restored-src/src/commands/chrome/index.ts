/**
 * /chrome 命令的入口注册模块。
 *
 * 在 Claude Code 的平台特性管理流程中，此文件将 Chrome 浏览器扩展集成设置命令
 * 注册到命令中心。该命令仅在 claude-ai 平台（即 claude.ai 网页端）下可用，
 * 且仅限交互式会话（非管道/非交互模式）。
 *
 * /chrome 命令提供用于配置"Claude in Chrome (Beta)"浏览器扩展的设置界面，
 * 例如授权、绑定账号或调整扩展行为选项。
 */
import { getIsNonInteractiveSession } from '../../bootstrap/state.js'
import type { Command } from '../../commands.js'

// /chrome 命令描述符：仅对 claude-ai 平台的交互式用户可用
const command: Command = {
  name: 'chrome',
  description: 'Claude in Chrome (Beta) settings',
  // 仅在 claude-ai 平台下注册此命令，其他平台（如 CLI）不显示
  availability: ['claude-ai'],
  // 非交互式会话（如脚本/管道模式）中禁用，避免无界面场景下触发 UI 操作
  isEnabled: () => !getIsNonInteractiveSession(),
  type: 'local-jsx',
  // 懒加载 Chrome 设置 UI 组件
  load: () => import('./chrome.js'),
}

export default command
