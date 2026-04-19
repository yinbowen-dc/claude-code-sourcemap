/**
 * MCP 工具函数模块
 *
 * 在 Claude Code 系统流程中的位置：
 * 本文件是 MCP（Model Context Protocol）子系统的核心工具层，
 * 为 MCP 服务器连接管理、工具/命令/资源的过滤与排除、
 * 配置哈希计算及过期客户端检测提供底层支撑。
 * 被 reload-plugins 流程、/mcp 命令、工具分发逻辑等多处上层代码调用。
 *
 * 主要功能：
 * - 按服务器名称过滤/排除 tools、commands、resources
 * - 计算 MCP 服务器配置的稳定 SHA-256 哈希（用于变更检测）
 * - 识别并移除过期（stale）的插件客户端
 * - 解析 agent 前置元数据中的 MCP 服务器定义
 * - 提取安全可记录的 MCP 服务器 Base URL（去除含 token 的查询参数）
 */

import { createHash } from 'crypto'
import { join } from 'path'
import { getIsNonInteractiveSession } from '../../bootstrap/state.js'
import type { Command } from '../../commands.js'
import type { AgentMcpServerInfo } from '../../components/mcp/types.js'
import type { Tool } from '../../Tool.js'
import type { AgentDefinition } from '../../tools/AgentTool/loadAgentsDir.js'
import { getCwd } from '../../utils/cwd.js'
import { getGlobalClaudeFile } from '../../utils/env.js'
import { isSettingSourceEnabled } from '../../utils/settings/constants.js'
import {
  getSettings_DEPRECATED,
  hasSkipDangerousModePermissionPrompt,
} from '../../utils/settings/settings.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { getEnterpriseMcpFilePath, getMcpConfigByName } from './config.js'
import { mcpInfoFromString } from './mcpStringUtils.js'
import { normalizeNameForMCP } from './normalization.js'
import {
  type ConfigScope,
  ConfigScopeSchema,
  type MCPServerConnection,
  type McpHTTPServerConfig,
  type McpServerConfig,
  type McpSSEServerConfig,
  type McpStdioServerConfig,
  type McpWebSocketServerConfig,
  type ScopedMcpServerConfig,
  type ServerResource,
} from './types.js'

/**
 * 按 MCP 服务器名称过滤工具列表
 *
 * 工具命名规范：`mcp__<normalizedServerName>__<toolName>`
 * 通过检查前缀来判断工具是否属于指定服务器。
 *
 * @param tools 待过滤的工具数组
 * @param serverName MCP 服务器名称（未归一化）
 * @returns 属于该服务器的工具子集
 */
export function filterToolsByServer(tools: Tool[], serverName: string): Tool[] {
  // 生成归一化后的工具名前缀
  const prefix = `mcp__${normalizeNameForMCP(serverName)}__`
  return tools.filter(tool => tool.name?.startsWith(prefix))
}

/**
 * 判断命令是否属于指定 MCP 服务器
 *
 * MCP 命令有两种命名形式：
 * - MCP prompts：`mcp__<server>__<prompt>`（wire-format 约束）
 * - MCP skills：`<server>:<skill>`（匹配插件/嵌套目录 skill 命名）
 * 两者都存于 mcp.commands 中，因此清理和过滤逻辑必须同时匹配两种形式。
 */
export function commandBelongsToServer(
  command: Command,
  serverName: string,
): boolean {
  const normalized = normalizeNameForMCP(serverName)
  const name = command.name
  if (!name) return false
  // 匹配 MCP prompt 格式（mcp__server__prompt）或 skill 格式（server:skill）
  return (
    name.startsWith(`mcp__${normalized}__`) || name.startsWith(`${normalized}:`)
  )
}

/**
 * 按 MCP 服务器名称过滤命令列表
 *
 * @param commands 待过滤的命令数组
 * @param serverName MCP 服务器名称
 * @returns 属于该服务器的命令子集
 */
export function filterCommandsByServer(
  commands: Command[],
  serverName: string,
): Command[] {
  return commands.filter(c => commandBelongsToServer(c, serverName))
}

/**
 * 仅过滤 MCP prompts（排除 MCP skills）
 *
 * 用于 /mcp 菜单的能力展示：skills 在 /skills 中单独展示，
 * 不应被计入 prompts 数量徽章，否则会虚高。
 *
 * 区分依据：MCP skills 设置了 `loadedFrom === 'mcp'`，
 * MCP prompts 使用 `isMcp: true` 而不设置 loadedFrom。
 */
export function filterMcpPromptsByServer(
  commands: Command[],
  serverName: string,
): Command[] {
  return commands.filter(
    c =>
      commandBelongsToServer(c, serverName) &&
      // 排除 MCP skills（type === 'prompt' 且 loadedFrom === 'mcp'）
      !(c.type === 'prompt' && c.loadedFrom === 'mcp'),
  )
}

/**
 * 按 MCP 服务器名称过滤资源列表
 *
 * 每个资源的 server 属性直接记录其归属服务器名称。
 *
 * @param resources 待过滤的资源数组
 * @param serverName MCP 服务器名称
 * @returns 属于该服务器的资源子集
 */
export function filterResourcesByServer(
  resources: ServerResource[],
  serverName: string,
): ServerResource[] {
  return resources.filter(resource => resource.server === serverName)
}

/**
 * 从工具列表中移除属于指定 MCP 服务器的工具
 *
 * 与 filterToolsByServer 相反——返回不属于该服务器的工具。
 *
 * @param tools 工具数组
 * @param serverName 要排除的 MCP 服务器名称
 * @returns 不属于该服务器的工具数组
 */
export function excludeToolsByServer(
  tools: Tool[],
  serverName: string,
): Tool[] {
  const prefix = `mcp__${normalizeNameForMCP(serverName)}__`
  return tools.filter(tool => !tool.name?.startsWith(prefix))
}

/**
 * 从命令列表中移除属于指定 MCP 服务器的命令
 *
 * @param commands 命令数组
 * @param serverName 要排除的 MCP 服务器名称
 * @returns 不属于该服务器的命令数组
 */
export function excludeCommandsByServer(
  commands: Command[],
  serverName: string,
): Command[] {
  return commands.filter(c => !commandBelongsToServer(c, serverName))
}

/**
 * 从资源映射中移除属于指定 MCP 服务器的资源
 *
 * 资源以服务器名称为键存储在 Record 中，直接删除对应键即可。
 *
 * @param resources 以服务器名称为键的资源映射
 * @param serverName 要排除的 MCP 服务器名称
 * @returns 不含该服务器资源的新映射
 */
export function excludeResourcesByServer(
  resources: Record<string, ServerResource[]>,
  serverName: string,
): Record<string, ServerResource[]> {
  const result = { ...resources } // 浅拷贝避免修改原对象
  delete result[serverName]
  return result
}

/**
 * 计算 MCP 服务器配置的稳定哈希值（用于 /reload-plugins 变更检测）
 *
 * 设计决策：
 * - 排除 `scope` 字段：scope 表示配置来源（.mcp.json vs settings.json），
 *   不属于连接内容，更改来源不应触发重连
 * - 键排序：`{a:1,b:2}` 和 `{b:2,a:1}` 应产生相同哈希
 * - 返回前 16 个十六进制字符（64 位），足以区分不同配置
 */
export function hashMcpConfig(config: ScopedMcpServerConfig): string {
  // 解构排除 scope 字段，rest 包含所有连接相关配置
  const { scope: _scope, ...rest } = config
  // 通过自定义 replacer 函数对每层对象键进行排序，确保序列化稳定
  const stable = jsonStringify(rest, (_k, v: unknown) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const obj = v as Record<string, unknown>
      const sorted: Record<string, unknown> = {}
      // 按键名排序后重新构建对象
      for (const k of Object.keys(obj).sort()) sorted[k] = obj[k]
      return sorted
    }
    return v
  })
  // 计算 SHA-256 并取前 16 个十六进制字符
  return createHash('sha256').update(stable).digest('hex').slice(0, 16)
}

/**
 * 识别并移除过期的 MCP 插件客户端
 *
 * 过期（stale）判断规则：
 * 1. scope 为 'dynamic' 且名称不再出现在配置中 → 插件已被禁用
 * 2. 配置哈希发生变化 → 配置内容被修改（适用于任何 scope）
 *
 * scope='dynamic' 限制：防止 /reload-plugins 在部分重载期间误断开
 * 临时不在内存配置中的用户配置服务器。
 * 配置哈希变化则适用于所有 scope——实际内容改变就应重连。
 *
 * @param mcp 当前 MCP 状态（clients/tools/commands/resources）
 * @param configs 最新的配置记录（服务器名 → 带 scope 的配置）
 * @returns 移除过期客户端后的新状态，以及 stale 数组供调用者断开连接
 */
export function excludeStalePluginClients(
  mcp: {
    clients: MCPServerConnection[]
    tools: Tool[]
    commands: Command[]
    resources: Record<string, ServerResource[]>
  },
  configs: Record<string, ScopedMcpServerConfig>,
): {
  clients: MCPServerConnection[]
  tools: Tool[]
  commands: Command[]
  resources: Record<string, ServerResource[]>
  stale: MCPServerConnection[]
} {
  // 识别过期客户端
  const stale = mcp.clients.filter(c => {
    const fresh = configs[c.name]
    // 规则1：dynamic scope 且配置中已不存在该服务器 → 过期
    if (!fresh) return c.config.scope === 'dynamic'
    // 规则2：配置哈希变化 → 过期（任何 scope）
    return hashMcpConfig(c.config) !== hashMcpConfig(fresh)
  })
  // 无过期客户端时直接返回原状态
  if (stale.length === 0) {
    return { ...mcp, stale: [] }
  }

  // 逐一从 tools/commands/resources 中移除过期客户端的注册内容
  let { tools, commands, resources } = mcp
  for (const s of stale) {
    tools = excludeToolsByServer(tools, s.name)
    commands = excludeCommandsByServer(commands, s.name)
    resources = excludeResourcesByServer(resources, s.name)
  }
  const staleNames = new Set(stale.map(c => c.name))

  return {
    // 从客户端列表中过滤掉过期客户端
    clients: mcp.clients.filter(c => !staleNames.has(c.name)),
    tools,
    commands,
    resources,
    stale,
  }
}

/**
 * 检查工具名称是否属于指定 MCP 服务器
 *
 * 通过解析工具名中的服务器名部分进行精确匹配。
 *
 * @param toolName 工具名称
 * @param serverName 目标服务器名称
 * @returns 工具是否属于该服务器
 */
export function isToolFromMcpServer(
  toolName: string,
  serverName: string,
): boolean {
  const info = mcpInfoFromString(toolName)
  return info?.serverName === serverName
}

/**
 * 检查工具是否来自任意 MCP 服务器
 *
 * 通过名称前缀或 isMcp 标志进行判断。
 *
 * @param tool 待检查的工具
 * @returns 工具是否来自 MCP 服务器
 */
export function isMcpTool(tool: Tool): boolean {
  return tool.name?.startsWith('mcp__') || tool.isMcp === true
}

/**
 * 检查命令是否来自任意 MCP 服务器
 *
 * 通过名称前缀或 isMcp 标志进行判断。
 *
 * @param command 待检查的命令
 * @returns 命令是否来自 MCP 服务器
 */
export function isMcpCommand(command: Command): boolean {
  return command.name?.startsWith('mcp__') || command.isMcp === true
}

/**
 * 描述指定 scope 对应的配置文件路径
 *
 * 用于在 UI 中展示配置存储位置，帮助用户理解配置来源。
 *
 * @param scope 配置 scope（'user'|'project'|'local'|'dynamic'|'enterprise'|'claudeai'）
 * @returns 人类可读的配置路径或描述
 */
export function describeMcpConfigFilePath(scope: ConfigScope): string {
  switch (scope) {
    case 'user':
      return getGlobalClaudeFile() // 全局用户配置文件
    case 'project':
      return join(getCwd(), '.mcp.json') // 项目根目录的 .mcp.json
    case 'local':
      return `${getGlobalClaudeFile()} [project: ${getCwd()}]` // 用户配置中的项目私有配置
    case 'dynamic':
      return 'Dynamically configured' // 通过命令行参数动态配置
    case 'enterprise':
      return getEnterpriseMcpFilePath() // 企业级统一配置文件
    case 'claudeai':
      return 'claude.ai' // 来自 claude.ai 的配置
    default:
      return scope
  }
}

/**
 * 获取 scope 的人类可读标签
 *
 * 用于配置管理 UI 中的 scope 说明文本。
 */
export function getScopeLabel(scope: ConfigScope): string {
  switch (scope) {
    case 'local':
      return 'Local config (private to you in this project)'
    case 'project':
      return 'Project config (shared via .mcp.json)'
    case 'user':
      return 'User config (available in all your projects)'
    case 'dynamic':
      return 'Dynamic config (from command line)'
    case 'enterprise':
      return 'Enterprise config (managed by your organization)'
    case 'claudeai':
      return 'claude.ai config'
    default:
      return scope
  }
}

/**
 * 将字符串转换为合法的 ConfigScope，无效值时抛出错误
 *
 * 默认值为 'local'（未提供 scope 参数时使用）。
 * 通过 Zod schema 的 options 数组进行合法值校验。
 */
export function ensureConfigScope(scope?: string): ConfigScope {
  if (!scope) return 'local'

  if (!ConfigScopeSchema().options.includes(scope as ConfigScope)) {
    throw new Error(
      `Invalid scope: ${scope}. Must be one of: ${ConfigScopeSchema().options.join(', ')}`,
    )
  }

  return scope as ConfigScope
}

/**
 * 将字符串转换为合法的传输类型，无效值时抛出错误
 *
 * 默认值为 'stdio'（最常见的 MCP 传输方式）。
 */
export function ensureTransport(type?: string): 'stdio' | 'sse' | 'http' {
  if (!type) return 'stdio'

  if (type !== 'stdio' && type !== 'sse' && type !== 'http') {
    throw new Error(
      `Invalid transport type: ${type}. Must be one of: stdio, sse, http`,
    )
  }

  return type as 'stdio' | 'sse' | 'http'
}

/**
 * 将 "Header-Name: value" 格式的字符串数组解析为头部对象
 *
 * 用于处理命令行 --header 参数传入的自定义 HTTP 头。
 * 格式错误（无冒号或键名为空）时抛出描述性错误。
 */
export function parseHeaders(headerArray: string[]): Record<string, string> {
  const headers: Record<string, string> = {}

  for (const header of headerArray) {
    // 查找首个冒号的位置（值中可能含有冒号）
    const colonIndex = header.indexOf(':')
    if (colonIndex === -1) {
      throw new Error(
        `Invalid header format: "${header}". Expected format: "Header-Name: value"`,
      )
    }

    const key = header.substring(0, colonIndex).trim()
    const value = header.substring(colonIndex + 1).trim()

    if (!key) {
      throw new Error(
        `Invalid header: "${header}". Header name cannot be empty.`,
      )
    }

    headers[key] = value
  }

  return headers
}

/**
 * 获取项目 MCP 服务器的审批状态
 *
 * 返回三种状态之一：'approved'（已批准）、'rejected'（已拒绝）、'pending'（待审批）
 *
 * 审批逻辑：
 * 1. 在 disabledMcpjsonServers 中 → rejected
 * 2. 在 enabledMcpjsonServers 中或 enableAllProjectMcpServers=true → approved
 * 3. 危险模式绕过（--dangerously-skip-permissions）且 projectSettings 启用 → approved
 * 4. 非交互式会话（SDK/-p 模式）且 projectSettings 启用 → approved
 * 5. 其他情况 → pending（等待用户审批弹窗）
 *
 * 安全说明：仅通过 hasSkipDangerousModePermissionPrompt() 读取跳过权限标志，
 * 不读取 projectSettings（防止恶意仓库通过 .claude/settings.json 绕过权限对话框）。
 */
export function getProjectMcpServerStatus(
  serverName: string,
): 'approved' | 'rejected' | 'pending' {
  const settings = getSettings_DEPRECATED()
  const normalizedName = normalizeNameForMCP(serverName)

  // TODO: This fails an e2e test if the ?. is not present. This is likely a bug in the e2e test.
  // Will fix this in a follow-up PR.
  if (
    settings?.disabledMcpjsonServers?.some(
      name => normalizeNameForMCP(name) === normalizedName,
    )
  ) {
    return 'rejected'
  }

  if (
    settings?.enabledMcpjsonServers?.some(
      name => normalizeNameForMCP(name) === normalizedName,
    ) ||
    settings?.enableAllProjectMcpServers
  ) {
    return 'approved'
  }

  // In bypass permissions mode (--dangerously-skip-permissions), there's no way
  // to show an approval popup. Auto-approve if projectSettings is enabled since
  // the user has explicitly chosen to bypass all permission checks.
  // SECURITY: We intentionally only check skipDangerousModePermissionPrompt via
  // hasSkipDangerousModePermissionPrompt(), which reads from userSettings/localSettings/
  // flagSettings/policySettings but NOT projectSettings (repo-level .claude/settings.json).
  // This is intentional: a repo should not be able to accept the bypass dialog on behalf of
  // users. We also do NOT check getSessionBypassPermissionsMode() here because
  // sessionBypassPermissionsMode can be set from project settings before the dialog is shown,
  // which would allow RCE attacks via malicious project settings.
  if (
    hasSkipDangerousModePermissionPrompt() &&
    isSettingSourceEnabled('projectSettings')
  ) {
    return 'approved'
  }

  // In non-interactive mode (SDK, claude -p, piped input), there's no way to
  // show an approval popup. Auto-approve if projectSettings is enabled since:
  // 1. The user/developer explicitly chose to run in this mode
  // 2. For SDK, projectSettings is off by default - they must explicitly enable it
  // 3. For -p mode, the help text warns to only use in trusted directories
  if (
    getIsNonInteractiveSession() &&
    isSettingSourceEnabled('projectSettings')
  ) {
    return 'approved'
  }

  return 'pending'
}

/**
 * 从工具名称中提取对应 MCP 服务器的 scope
 *
 * 工具名格式：`mcp__serverName__toolName`
 * 先解析服务器名，再在配置中查找对应的 scope。
 *
 * 特殊处理：claude.ai 服务器（以 "claude_ai_" 开头）未在 getMcpConfigByName 中，
 * 直接返回 'claudeai' scope。
 *
 * @param toolName MCP 工具名称
 * @returns ConfigScope 或 null（非 MCP 工具或服务器未找到时）
 */
export function getMcpServerScopeFromToolName(
  toolName: string,
): ConfigScope | null {
  // 先确认是 MCP 工具
  if (!isMcpTool({ name: toolName } as Tool)) {
    return null
  }

  // 从工具名中解析 MCP 元信息（服务器名、工具名）
  // Extract server name from tool name (format: mcp__serverName__toolName)
  const mcpInfo = mcpInfoFromString(toolName)
  if (!mcpInfo) {
    return null
  }

  // 在全局配置中查找服务器配置
  // Look up server config
  const serverConfig = getMcpConfigByName(mcpInfo.serverName)

  // Fallback: claude.ai servers have normalized names starting with "claude_ai_"
  // but aren't in getMcpConfigByName (they're fetched async separately)
  if (!serverConfig && mcpInfo.serverName.startsWith('claude_ai_')) {
    return 'claudeai'
  }

  return serverConfig?.scope ?? null
}

// ─── MCP 服务器配置类型守卫 ──────────────────────────────────────────────────

// 判断配置是否为 stdio 类型（type 为 'stdio' 或未指定）
function isStdioConfig(
  config: McpServerConfig,
): config is McpStdioServerConfig {
  return config.type === 'stdio' || config.type === undefined
}

// 判断配置是否为 SSE（Server-Sent Events）类型
function isSSEConfig(config: McpServerConfig): config is McpSSEServerConfig {
  return config.type === 'sse'
}

// 判断配置是否为 HTTP 类型
function isHTTPConfig(config: McpServerConfig): config is McpHTTPServerConfig {
  return config.type === 'http'
}

// 判断配置是否为 WebSocket 类型
function isWebSocketConfig(
  config: McpServerConfig,
): config is McpWebSocketServerConfig {
  return config.type === 'ws'
}

/**
 * 从 agent 前置元数据中提取 MCP 服务器定义并按服务器名分组
 *
 * 用于 /mcp 命令展示 agent 专属 MCP 服务器。
 *
 * 处理流程：
 * 1. 遍历所有 agent，跳过无 mcpServers 字段的 agent
 * 2. 跳过字符串引用（全局配置已有的服务器）
 * 3. 解析内联服务器定义 `{ [name]: config }`
 * 4. 按服务器名合并，同一服务器被多个 agent 引用时累积 sourceAgents
 * 5. 使用类型守卫正确分发各传输类型，跳过不支持的内部传输类型
 *
 * @param agents agent 定义数组
 * @returns 按服务器名分组的 AgentMcpServerInfo 数组（字典序排列）
 */
export function extractAgentMcpServers(
  agents: AgentDefinition[],
): AgentMcpServerInfo[] {
  // 中间数据结构：服务器名 → { config, sourceAgents }
  // Map: server name -> { config, sourceAgents }
  const serverMap = new Map<
    string,
    {
      config: McpServerConfig & { name: string }
      sourceAgents: string[]
    }
  >()

  for (const agent of agents) {
    if (!agent.mcpServers?.length) continue

    for (const spec of agent.mcpServers) {
      // Skip string references - these refer to servers already in global config
      if (typeof spec === 'string') continue

      // Inline definition as { [name]: config }
      const entries = Object.entries(spec)
      if (entries.length !== 1) continue // 内联定义必须恰好有一个键值对

      const [serverName, serverConfig] = entries[0]!
      const existing = serverMap.get(serverName)

      if (existing) {
        // 服务器已存在：添加当前 agent 为新的来源（去重）
        // Add this agent as another source
        if (!existing.sourceAgents.includes(agent.agentType)) {
          existing.sourceAgents.push(agent.agentType)
        }
      } else {
        // 新服务器：创建条目
        // New server
        serverMap.set(serverName, {
          config: { ...serverConfig, name: serverName } as McpServerConfig & {
            name: string
          },
          sourceAgents: [agent.agentType],
        })
      }
    }
  }

  // 将 Map 转换为 AgentMcpServerInfo 数组，仅包含受支持的传输类型
  // Convert map to array of AgentMcpServerInfo
  // Only include transport types supported by AgentMcpServerInfo
  const result: AgentMcpServerInfo[] = []
  for (const [name, { config, sourceAgents }] of serverMap) {
    // Use type guards to properly narrow the discriminated union type
    // Only include transport types that are supported by AgentMcpServerInfo
    if (isStdioConfig(config)) {
      result.push({
        name,
        sourceAgents,
        transport: 'stdio',
        command: config.command,
        needsAuth: false,
      })
    } else if (isSSEConfig(config)) {
      result.push({
        name,
        sourceAgents,
        transport: 'sse',
        url: config.url,
        needsAuth: true, // SSE 通常需要认证
      })
    } else if (isHTTPConfig(config)) {
      result.push({
        name,
        sourceAgents,
        transport: 'http',
        url: config.url,
        needsAuth: true, // HTTP 通常需要认证
      })
    } else if (isWebSocketConfig(config)) {
      result.push({
        name,
        sourceAgents,
        transport: 'ws',
        url: config.url,
        needsAuth: false,
      })
    }
    // Skip unsupported transport types (sdk, claudeai-proxy, sse-ide, ws-ide)
    // These are internal types not meant for agent MCP server display
  }

  // 按服务器名字典序排列，确保展示顺序稳定
  return result.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * 提取可安全记录日志的 MCP 服务器 Base URL
 *
 * 分析目的：查询参数可能包含 access token，不能记录到日志或分析系统。
 * 本函数去除查询参数、去除末尾斜杠，仅保留 scheme+host+path。
 * stdio/sdk 服务器无 URL，返回 undefined。
 * URL 解析失败时也返回 undefined（容错处理）。
 *
 * @param config MCP 服务器配置
 * @returns 安全可记录的 Base URL，或 undefined
 */
export function getLoggingSafeMcpBaseUrl(
  config: McpServerConfig,
): string | undefined {
  // stdio 和 sdk 类型无 URL 字段
  if (!('url' in config) || typeof config.url !== 'string') {
    return undefined
  }

  try {
    const url = new URL(config.url)
    url.search = '' // 清除查询参数（可能含 token）
    return url.toString().replace(/\/$/, '') // 去除末尾斜杠
  } catch {
    // URL 格式无效时静默返回 undefined
    return undefined
  }
}
