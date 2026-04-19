/**
 * 系统初始化消息构建器（System Init Message Builder）
 *
 * 【在 Claude Code 系统流中的位置】
 * 本文件处于 SDK 流输出的最上游，负责构建每次会话流中第一条发出的
 * `system/init` 类型的 SDKMessage。远程客户端（移动端、Web UI 等）
 * 依赖此消息来渲染工具选择器、命令面板、模型选项等 UI 组件。
 *
 * 【调用来源】
 * 有两条路径都必须产生形状完全一致的 init 消息：
 *   1. QueryEngine（spawn-bridge / print-mode / SDK 模式）
 *      — 每次 query turn 开始时作为第一条流消息 yield 出去
 *   2. useReplBridge（REPL 远程控制桥）
 *      — 桥接连接时通过 writeSdkMessages() 发出，因为 REPL 直接
 *        调用 query() 而不经过 QueryEngine 的 SDKMessage 层
 *
 * 【主要功能】
 * 1. sdkCompatToolName    — 工具名称兼容性转换（Agent → Task，向后兼容旧 SDK 消费者）
 * 2. buildSystemInitMessage — 构建完整的 system/init SDKMessage
 */

import { feature } from 'bun:bundle'
import { randomUUID } from 'crypto'
import { getSdkBetas, getSessionId } from 'src/bootstrap/state.js'
import { DEFAULT_OUTPUT_STYLE_NAME } from 'src/constants/outputStyles.js'
import type {
  ApiKeySource,
  PermissionMode,
  SDKMessage,
} from 'src/entrypoints/agentSdkTypes.js'
import {
  AGENT_TOOL_NAME,
  LEGACY_AGENT_TOOL_NAME,
} from 'src/tools/AgentTool/constants.js'
import { getAnthropicApiKeyWithSource } from '../auth.js'
import { getCwd } from '../cwd.js'
import { getFastModeState } from '../fastMode.js'
import { getSettings_DEPRECATED } from '../settings/settings.js'

// TODO(next-minor): 当 SDK 消费者迁移到 'Agent' 工具名称后移除此兼容转换。
// 线上名称在 #19647 从 Task → Agent 做了重命名，但在 patch 版本中
// 发出新名称会破坏现有 SDK 消费者。保持发出 'Task' 直到下一个 minor 版本。
/**
 * 将 SDK 工具名称转换为兼容旧版消费者的格式。
 * 当工具名称为新版 AGENT_TOOL_NAME 时，返回旧版 LEGACY_AGENT_TOOL_NAME（'Task'）。
 *
 * 【背景】移动端等 SDK 消费者尚未升级以识别新工具名 'Agent'，
 * 在 minor 版本迁移窗口内保持向后兼容。
 */
export function sdkCompatToolName(name: string): string {
  // 将新 Agent 工具名映射回旧 Task 工具名，其他工具名保持不变
  return name === AGENT_TOOL_NAME ? LEGACY_AGENT_TOOL_NAME : name
}

// 命令对象的最小接口，支持 name 和可选的 userInvocable 标记
type CommandLike = { name: string; userInvocable?: boolean }

// buildSystemInitMessage 所需的全部输入参数类型定义
export type SystemInitInputs = {
  tools: ReadonlyArray<{ name: string }>           // 当前会话可用工具列表
  mcpClients: ReadonlyArray<{ name: string; type: string }> // MCP 客户端列表
  model: string                                    // 当前使用的模型名称
  permissionMode: PermissionMode                   // 权限模式（default/plan/bypass等）
  commands: ReadonlyArray<CommandLike>             // 可用斜杠命令列表
  agents: ReadonlyArray<{ agentType: string }>     // 可用 Agent 类型列表
  skills: ReadonlyArray<CommandLike>               // 可用技能（Skills）列表
  plugins: ReadonlyArray<{ name: string; path: string; source: string }> // 插件列表
  fastMode: boolean | undefined                    // 快速模式开关状态
}

/**
 * 构建 `system/init` SDKMessage — SDK 流中携带会话元数据的第一条消息。
 * 远程客户端利用此消息渲染工具选择器、命令面板等 UI 并进行权限门控。
 *
 * 【调用路径】
 *   - QueryEngine（spawn-bridge / print-mode / SDK）：每次 query turn 首条消息
 *   - useReplBridge（REPL Remote Control）：桥接连接时通过 writeSdkMessages() 发出
 * 两条路径产出的消息形状必须完全一致。
 *
 * 【字段组成】
 * - cwd / session_id：工作目录和会话标识
 * - tools：工具名列表（经兼容性转换）
 * - mcp_servers：MCP 服务器名称和状态
 * - model / permissionMode：当前模型和权限模式
 * - slash_commands / skills：用户可调用的命令和技能
 * - apiKeySource / betas：认证来源和 SDK Beta 标记
 * - claude_code_version / output_style：版本号和输出风格
 * - agents / plugins：可用 Agent 类型和插件列表
 * - fast_mode_state：快速模式状态（附在最后以便调试）
 * - messaging_socket_path（仅 ant 内部 UDS）：Unix 域套接字路径
 */
export function buildSystemInitMessage(inputs: SystemInitInputs): SDKMessage {
  // 读取用户设置，获取输出风格（如未配置则使用默认值）
  const settings = getSettings_DEPRECATED()
  const outputStyle = settings?.outputStyle ?? DEFAULT_OUTPUT_STYLE_NAME

  const initMessage: SDKMessage = {
    type: 'system',
    subtype: 'init',
    // 当前工作目录，远程客户端用于显示上下文
    cwd: getCwd(),
    session_id: getSessionId(),
    // 工具名列表，经 sdkCompatToolName 向后兼容旧版消费者
    tools: inputs.tools.map(tool => sdkCompatToolName(tool.name)),
    // MCP 服务器列表：name 为服务器名称，status 即 type（运行状态）
    mcp_servers: inputs.mcpClients.map(client => ({
      name: client.name,
      status: client.type,
    })),
    model: inputs.model,
    permissionMode: inputs.permissionMode,
    // 仅暴露 userInvocable !== false 的命令（过滤内部命令）
    slash_commands: inputs.commands
      .filter(c => c.userInvocable !== false)
      .map(c => c.name),
    // API Key 来源（环境变量 / OAuth / 配置文件等）
    apiKeySource: getAnthropicApiKeyWithSource().source as ApiKeySource,
    // SDK Beta 功能标记列表
    betas: getSdkBetas(),
    // 当前 Claude Code 版本号（由构建宏注入）
    claude_code_version: MACRO.VERSION,
    output_style: outputStyle,
    // Agent 类型列表（subagent 调度使用）
    agents: inputs.agents.map(agent => agent.agentType),
    // 仅暴露用户可调用的技能（过滤内部技能）
    skills: inputs.skills
      .filter(s => s.userInvocable !== false)
      .map(skill => skill.name),
    // 插件元数据（名称、路径、来源）
    plugins: inputs.plugins.map(plugin => ({
      name: plugin.name,
      path: plugin.path,
      source: plugin.source,
    })),
    // 每条 init 消息分配唯一 UUID，供 SDK 消费者去重
    uuid: randomUUID(),
  }

  // UDS 消息套接字路径：仅对 ant 内部用户启用（隐藏于公开 SDK 类型）
  if (feature('UDS_INBOX')) {
    /* eslint-disable @typescript-eslint/no-require-imports */
    // 动态 require 避免在非 ant 构建中引入 UDS 模块
    ;(initMessage as Record<string, unknown>).messaging_socket_path =
      require('../udsMessaging.js').getUdsMessagingSocketPath()
    /* eslint-enable @typescript-eslint/no-require-imports */
  }

  // 快速模式状态附加在最后，依赖 model 和 fastMode 输入
  initMessage.fast_mode_state = getFastModeState(inputs.model, inputs.fastMode)
  return initMessage
}
