/**
 * mcp 命令入口模块
 *
 * 在 Claude Code 命令体系中，本文件是 `/mcp` 命令的注册描述符。
 * MCP（Model Context Protocol）是 Claude Code 与外部工具服务器交互的核心协议。
 * `/mcp` 命令提供一个交互式 JSX UI，用于：
 * - 查看当前配置的所有 MCP 服务器及其状态
 * - 启用（enable）或禁用（disable）指定的 MCP 服务器
 *
 * `immediate: true` 表示命令触发后立即渲染 UI，无需等待异步操作。
 * `argumentHint` 向用户提示可传入 `enable`/`disable` 子命令及服务器名称。
 */
import type { Command } from '../../commands.js'

/**
 * mcp 命令描述符对象
 *
 * - type: 'local-jsx' — 通过 JSX 组件渲染 MCP 服务器管理界面
 * - immediate: true — 触发后立即展示 UI，不进入"正在加载"过渡状态
 * - argumentHint — 提示用户可传入 `[enable|disable [server-name]]` 参数
 * - load — 懒加载 mcp.js 的 JSX 界面实现，按需导入以减少启动开销
 */
const mcp = {
  type: 'local-jsx',
  name: 'mcp',
  description: 'Manage MCP servers',
  // 命令触发后立即渲染，不显示加载过渡状态
  immediate: true,
  // 提示用户可选传入 enable/disable 子命令以及目标服务器名称
  argumentHint: '[enable|disable [server-name]]',
  // 按需懒加载 MCP 管理界面的 JSX 实现
  load: () => import('./mcp.js'),
} satisfies Command

export default mcp
