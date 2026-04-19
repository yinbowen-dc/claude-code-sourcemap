/**
 * reload-plugins 命令入口 —— Claude Code 命令注册层
 *
 * 在整体流程中的位置：
 *   用户输入 `/reload-plugins` → commands 注册表路由到本模块
 *   → 懒加载 reload-plugins.js（local 类型，返回文本）
 *   → 执行插件刷新逻辑并输出刷新摘要
 *
 * 主要功能：
 *   将待生效的插件变更（新安装/卸载/启用/禁用）应用到当前运行中的会话，
 *   无需重启 Claude Code 进程。类型为 'local'（非 JSX），执行后直接
 *   返回文本摘要（已加载的插件数、技能数、Agent 数等）。
 *
 * SDK 调用说明：
 *   通过 SDK 调用时，宿主端应使用 query.reloadPlugins()（控制请求）
 *   而非将 /reload-plugins 作为文本 prompt 发送，前者返回结构化数据
 *   （commands、agents、plugins、mcpServers），供 UI 侧增量更新使用。
 *
 * supportsNonInteractive: false —— 此命令需要 setAppState 上下文，
 *   因此不支持 --print 等无状态非交互模式。
 */
import type { Command } from '../../commands.js'

const reloadPlugins = {
  type: 'local',                                       // 返回纯文本，非 JSX
  name: 'reload-plugins',
  description: 'Activate pending plugin changes in the current session',
  // SDK callers use query.reloadPlugins() (control request) instead of
  // sending this as a text prompt — that returns structured data
  // (commands, agents, plugins, mcpServers) for UI updates.
  supportsNonInteractive: false,                       // 需要 app state 上下文，不支持 headless
  load: () => import('./reload-plugins.js'),           // 懒加载插件刷新执行逻辑
} satisfies Command

export default reloadPlugins
