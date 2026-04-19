/**
 * status 命令注册入口（commands/status/index.ts）
 *
 * 本文件将 /status 命令注册到 Claude Code 全局命令系统。
 * 该命令提供 Claude Code 的综合运行状态快照，涵盖：
 *   - 版本号和当前使用的模型名称；
 *   - 账户信息（登录状态、订阅计划）；
 *   - API 连接状态（Anthropic API 可达性）；
 *   - 各工具的启用/禁用状态（MCP 服务器、Bash 工具等）。
 *
 * 在系统流程中的位置：
 *   用户输入 /status → 命令注册表匹配 → 因 immediate: true 立即触发
 *   → load() 懒加载 status.js → 渲染实时状态面板。
 */

import type { Command } from '../../commands.js'

/**
 * status 命令描述对象。
 * - immediate: true 确保命令被输入后立即渲染状态，无需等待 AI 响应，
 *   提供最低延迟的诊断体验（类似 /help 的即时反馈）。
 * - type: 'local-jsx' 表示实现层渲染 React 组件展示多维度状态信息。
 */
const status = {
  type: 'local-jsx',
  name: 'status',
  description:
    'Show Claude Code status including version, model, account, API connectivity, and tool statuses',
  immediate: true,   // 立即展示，不等待 AI 处理，确保状态查询的即时响应
  load: () => import('./status.js'),
} satisfies Command

export default status
