/**
 * login 命令入口模块
 *
 * 在 Claude Code 命令体系中，本文件是 `/login` 命令的注册描述符。
 * `/login` 用于用户登录 Anthropic 账号，或在已登录 API Key 认证时切换账号。
 *
 * 与其他命令描述符不同，本文件导出的是一个工厂函数（而非静态对象）。
 * 原因：`description` 字段需要在调用时动态判断 `hasAnthropicApiKeyAuth()` 的结果：
 * - 若当前已通过 API Key 认证，则提示"切换账号"
 * - 若尚未登录，则提示"登录 Anthropic 账号"
 * 若提前静态绑定，描述内容将基于模块加载时的状态，无法反映运行时实际认证状态。
 *
 * 通过环境变量 `DISABLE_LOGIN_COMMAND` 可在运行时动态禁用此命令。
 */
import type { Command } from '../../commands.js'
import { hasAnthropicApiKeyAuth } from '../../utils/auth.js'
import { isEnvTruthy } from '../../utils/envUtils.js'

/**
 * login 命令描述符工厂函数
 *
 * 每次调用均返回一个新的命令描述符对象，`description` 在调用时动态计算：
 * - `hasAnthropicApiKeyAuth()` 为 true → "Switch Anthropic accounts"（切换账号）
 * - 否则 → "Sign in with your Anthropic account"（登录账号）
 *
 * - type: 'local-jsx' — 渲染 JSX UI（OAuth 登录流程或账号切换界面）
 * - isEnabled — 检测 DISABLE_LOGIN_COMMAND 环境变量，支持运行时禁用
 * - load — 懒加载 login.js 实现
 */
export default () =>
  ({
    type: 'local-jsx',
    name: 'login',
    // 运行时判断当前认证状态，动态决定显示"登录"还是"切换账号"
    description: hasAnthropicApiKeyAuth()
      ? 'Switch Anthropic accounts'
      : 'Sign in with your Anthropic account',
    // 通过环境变量 DISABLE_LOGIN_COMMAND 可在运行时关闭此命令
    isEnabled: () => !isEnvTruthy(process.env.DISABLE_LOGIN_COMMAND),
    // 按需懒加载登录流程的 JSX 界面实现
    load: () => import('./login.js'),
  }) satisfies Command
