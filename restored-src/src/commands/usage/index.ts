/**
 * usage（/usage）命令注册入口
 *
 * 本文件在 Claude Code 命令系统中负责注册"用量查看"命令。
 * 用户执行 /usage 后，可查看当前订阅套餐的 API 调用配额使用情况，
 * 包括已用量、剩余量及重置时间等信息，帮助用户了解自己的用量状态。
 *
 * 平台限制：仅在 claude.ai 平台（availability: ['claude-ai']）下可用；
 * 使用 API 密钥直连模式的用户没有套餐用量概念，不显示此命令。
 *
 * 命令类型为 local-jsx，由 React 组件渲染用量统计 UI；
 * 无需 isEnabled 检查，对所有 claude.ai 登录用户默认开启。
 */
import type { Command } from '../../commands.js'

export default {
  // local-jsx 类型：命令结果通过 React 组件渲染，展示可视化用量面板
  type: 'local-jsx',
  // 用户可见的命令名称
  name: 'usage',
  description: 'Show plan usage limits',
  // 仅对 claude.ai 账号用户开放，API key 用户无套餐用量概念
  availability: ['claude-ai'],
  // 懒加载：仅在 /usage 被调用时才引入实现模块，减少启动时的模块加载量
  load: () => import('./usage.js'),
} satisfies Command
