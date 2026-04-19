/**
 * upgrade（/upgrade）命令注册入口
 *
 * 本文件在 Claude Code 命令系统中负责注册"套餐升级"命令。
 * 当用户触发 /upgrade 时，会引导其升级到 Claude Max 订阅，
 * 以解锁更高的 API 调用频率上限和更多 Claude Opus 模型用量。
 *
 * 可用性条件（同时满足才启用）：
 *   1. 环境变量 DISABLE_UPGRADE_COMMAND 未设置为真值（运营方可通过此开关禁用）；
 *   2. 当前用户的订阅类型不是 'enterprise'（企业版已有高配额，无需引导升级）。
 *
 * 平台限制：仅在 claude.ai 平台（availability: ['claude-ai']）下可用，
 * API 密钥直连模式下不展示此命令。
 * 命令类型为 local-jsx，由 React 组件渲染升级引导 UI。
 */
import type { Command } from '../../commands.js'
import { getSubscriptionType } from '../../utils/auth.js'
import { isEnvTruthy } from '../../utils/envUtils.js'

const upgrade = {
  // local-jsx 类型：命令结果通过 React 组件渲染，支持交互式升级引导界面
  type: 'local-jsx',
  // 用户可见的命令名称
  name: 'upgrade',
  description: 'Upgrade to Max for higher rate limits and more Opus',
  // 仅 claude.ai 登录用户可见；API key 模式下不显示此命令
  availability: ['claude-ai'],
  /**
   * 命令启用条件：
   *   - DISABLE_UPGRADE_COMMAND 环境变量未被设为 true（允许平台方关闭升级入口）
   *   - 当前用户非企业订阅（企业用户无需走此升级流程）
   */
  isEnabled: () =>
    !isEnvTruthy(process.env.DISABLE_UPGRADE_COMMAND) &&
    getSubscriptionType() !== 'enterprise',
  // 懒加载实现模块，仅在命令被触发时才引入，避免增加冷启动时间
  load: () => import('./upgrade.js'),
} satisfies Command

export default upgrade
