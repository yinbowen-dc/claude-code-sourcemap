/**
 * install-slack-app 命令入口模块
 *
 * 在 Claude Code 命令体系中，本文件是 `/install-slack-app` 命令的注册描述符。
 * 该命令用于引导用户安装 Claude Slack 应用（`A08SF47R6P4-claude`），
 * 触发后将在浏览器中打开 Slack Marketplace 安装页面。
 *
 * 可用性限制：
 * - `availability: ['claude-ai']` — 仅在 claude.ai 网页端可见，控制台和本地 CLI 均不展示。
 * - `supportsNonInteractive: false` — 该命令需要用户交互（浏览器跳转），
 *   不支持在无界面的批处理或脚本场景中调用。
 */
import type { Command } from '../../commands.js'

/**
 * install-slack-app 命令描述符对象
 *
 * - type: 'local' — 本地执行命令，不渲染 JSX UI，直接调用 call() 函数并返回文本结果
 * - availability: ['claude-ai'] — 限定仅 claude.ai 平台可用
 * - supportsNonInteractive: false — 明确禁止在非交互模式下执行（需要浏览器跳转）
 * - load — 懒加载 install-slack-app.js 实现，按需导入以减少启动开销
 */
const installSlackApp = {
  type: 'local',
  name: 'install-slack-app',
  description: 'Install the Claude Slack app',
  // 仅在 claude.ai 网页端显示，其他平台不可见
  availability: ['claude-ai'],
  // 需要用户交互（打开浏览器），明确禁止非交互模式调用
  supportsNonInteractive: false,
  // 按需懒加载 Slack 应用安装逻辑
  load: () => import('./install-slack-app.js'),
} satisfies Command

export default installSlackApp
