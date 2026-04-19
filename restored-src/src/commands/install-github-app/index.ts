/**
 * install-github-app 命令入口模块
 *
 * 在 Claude Code 命令体系中，本文件是 `/install-github-app` 命令的注册描述符。
 * 该命令引导用户为指定 GitHub 仓库设置 Claude GitHub Actions 工作流，
 * 包括创建 workflow 文件（claude.yml / claude-code-review.yml）并配置
 * Anthropic API 密钥或 OAuth Token 为仓库 Secret。
 *
 * 仅在 `claude-ai` 和 `console` 两种可用性场景下显示，
 * 且通过 DISABLE_INSTALL_GITHUB_APP_COMMAND 环境变量支持强制禁用。
 */
import type { Command } from '../../commands.js'
import { isEnvTruthy } from '../../utils/envUtils.js'

/**
 * installGitHubApp 命令描述符对象
 *
 * - type: 'local-jsx' 表示通过 JSX 组件渲染交互式 UI 引导用户完成配置
 * - availability: 限定该命令只在 claude-ai 和 console 场景下可用
 * - isEnabled: 检查环境变量，允许通过配置强制禁用此命令
 * - load: 懒加载实际 UI 实现，按需导入减少启动时开销
 */
const installGitHubApp = {
  type: 'local-jsx',
  name: 'install-github-app',
  description: 'Set up Claude GitHub Actions for a repository',
  // 仅在 claude-ai 和 console 场景下可用，不适用于纯 CLI 模式
  availability: ['claude-ai', 'console'],
  // 允许通过环境变量禁用此命令（例如在企业受限环境中）
  isEnabled: () => !isEnvTruthy(process.env.DISABLE_INSTALL_GITHUB_APP_COMMAND),
  // 懒加载 GitHub App 安装配置的 JSX 交互界面
  load: () => import('./install-github-app.js'),
} satisfies Command

export default installGitHubApp
