/**
 * logout 命令入口模块
 *
 * 在 Claude Code 命令体系中，本文件是 `/logout` 命令的注册描述符。
 * `/logout` 用于退出当前已登录的 Anthropic 账号，清除本地存储的认证凭据。
 *
 * 通过环境变量 `DISABLE_LOGOUT_COMMAND` 可在运行时动态禁用此命令，
 * 适用于需要锁定账号状态的受控环境（如企业部署场景）。
 */
import type { Command } from '../../commands.js'
import { isEnvTruthy } from '../../utils/envUtils.js'

/**
 * logout 命令描述符对象
 *
 * - type: 'local-jsx' — 通过 JSX 组件渲染登出确认界面
 * - isEnabled — 检测 DISABLE_LOGOUT_COMMAND 环境变量，支持在受控环境中禁用退出功能
 * - load — 懒加载 logout.js 实现，按需导入以减少启动开销
 */
export default {
  type: 'local-jsx',
  name: 'logout',
  description: 'Sign out from your Anthropic account',
  // 通过环境变量 DISABLE_LOGOUT_COMMAND 可在运行时禁用此命令（如企业锁定账号场景）
  isEnabled: () => !isEnvTruthy(process.env.DISABLE_LOGOUT_COMMAND),
  // 按需懒加载登出流程的 JSX 界面实现
  load: () => import('./logout.js'),
} satisfies Command
