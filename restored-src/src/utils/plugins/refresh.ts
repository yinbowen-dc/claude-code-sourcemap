/**
 * 插件活跃组件刷新模块 — Claude Code 插件系统的第三层（运行时状态层）
 *
 * Claude Code 插件系统三层模型中的第三层：
 *   Layer 1：意图层（settings.json 中的声明）
 *   Layer 2：物化层（~/.claude/plugins/ 目录）← reconciler.ts
 *   Layer 3：活跃组件层（AppState 中运行时加载的命令/代理/hooks）← 本文件
 *
 * 调用方：
 *   - /reload-plugins 命令（交互式，用户主动触发）
 *   - print.ts 的 refreshPluginState()（无界面模式，在首次查询前自动执行）
 *   - performBackgroundPluginInstallations()（后台，新市场安装后自动触发）
 *
 * 不被以下路径调用：
 *   - useManagePlugins 的 needsRefresh effect（交互模式下显示通知，用户手动运行 /reload-plugins）
 *
 * 核心行为：
 *   - 清空所有插件缓存（与旧的 needsRefresh 路径不同，旧路径只清除 loadAllPlugins 缓存）
 *   - 串行执行全量加载（先 loadAllPlugins，再 getPluginCommands/getAgentDefinitions）
 *   - 并发加载 MCP 和 LSP 服务器配置（写入 plugin.mcpServers/lspServers 缓存槽）
 *   - 更新 AppState（plugins, agentDefinitions, mcp.pluginReconnectKey）
 *   - 重新初始化 LSP 服务器管理器（无论是否有 LSP 插件）
 *   - 加载 hooks（独立异常处理，失败不丢失已加载的命令/代理数据）
 */

import { getOriginalCwd } from '../../bootstrap/state.js'
import type { Command } from '../../commands.js'
import { reinitializeLspServerManager } from '../../services/lsp/manager.js'
import type { AppState } from '../../state/AppState.js'
import type { AgentDefinitionsResult } from '../../tools/AgentTool/loadAgentsDir.js'
import { getAgentDefinitionsWithOverrides } from '../../tools/AgentTool/loadAgentsDir.js'
import type { PluginError } from '../../types/plugin.js'
import { logForDebugging } from '../debug.js'
import { errorMessage } from '../errors.js'
import { logError } from '../log.js'
import { clearAllCaches } from './cacheUtils.js'
import { getPluginCommands } from './loadPluginCommands.js'
import { loadPluginHooks } from './loadPluginHooks.js'
import { loadPluginLspServers } from './lspPluginIntegration.js'
import { loadPluginMcpServers } from './mcpPluginIntegration.js'
import { clearPluginCacheExclusions } from './orphanedPluginFilter.js'
import { loadAllPlugins } from './pluginLoader.js'

// AppState 的 setter 函数类型
type SetAppState = (updater: (prev: AppState) => AppState) => void

/**
 * refreshActivePlugins 的返回类型，包含各类插件组件的计数统计。
 */
export type RefreshActivePluginsResult = {
  enabled_count: number    // 已启用的插件数量
  disabled_count: number   // 已禁用的插件数量
  command_count: number    // 插件提供的命令数量
  agent_count: number      // 插件提供的代理数量
  hook_count: number       // 插件提供的 hook 数量
  mcp_count: number        // 插件提供的 MCP 服务器数量
  /** 插件提供的 LSP 服务器数量。无论是否有 LSP 插件，reinitializeLspServerManager() 均会调用 */
  lsp_count: number
  error_count: number      // 加载过程中出现的错误总数
  /** 刷新后的代理定义，供 print.ts 等在 AppState 之外维护本地引用的调用方使用 */
  agentDefinitions: AgentDefinitionsResult
  /** 刷新后的插件命令，与 agentDefinitions 同理 */
  pluginCommands: Command[]
}

/**
 * 刷新所有活跃的插件组件（命令、代理、hooks、MCP 重连触发器、AppState 插件数组）。
 *
 * 执行顺序（顺序很重要）：
 *   1. 清空所有插件缓存（clearAllCaches + clearPluginCacheExclusions）
 *   2. 串行执行 loadAllPlugins()（先于缓存依赖的消费者，防止竞争条件）
 *   3. 并发执行 getPluginCommands 和 getAgentDefinitions（依赖步骤 2 的缓存）
 *   4. 并发为每个已启用插件加载 MCP/LSP 服务器（填充缓存槽）
 *   5. 通过 setAppState 原子性更新 AppState（plugins, agentDefinitions, mcp.pluginReconnectKey）
 *   6. 重新初始化 LSP 管理器（读取新的插件 LSP 配置）
 *   7. 加载 hooks（独立 try/catch，失败不影响已加载的命令/代理）
 *
 * 副作用：
 *   - 消费 plugins.needsRefresh（设为 false）
 *   - 递增 mcp.pluginReconnectKey（触发 useManageMCPConnections 副作用重新运行）
 *
 * @param setAppState - AppState 的 setter 函数
 * @returns 刷新后的统计数据和代理/命令定义
 */
export async function refreshActivePlugins(
  setAppState: SetAppState,
): Promise<RefreshActivePluginsResult> {
  logForDebugging('refreshActivePlugins: clearing all plugin caches')
  // 清空所有插件相关缓存（memoize 缓存、加载状态等）
  clearAllCaches()
  // 清空孤儿排除缓存：/reload-plugins 是"磁盘已变更，重新读取"的信号
  clearPluginCacheExclusions()

  // 步骤 2：串行执行 loadAllPlugins（必须先于 getPluginCommands/getAgentDefinitions）
  // 原因：#23693 后 getPluginCommands/getAgentDefinitions 调用 loadAllPluginsCacheOnly
  // （独立的 memoize）。若并发执行，缓存可能在 loadAllPlugins 完成前被读取
  // 导致 plugin-cache-miss。loadAllPlugins 完成后会填充 cache-only memoize，
  // 后续的 getPluginCommands/getAgentDefinitions 的 await 几乎免费（无需重新加载）
  const pluginResult = await loadAllPlugins()
  // 步骤 3：并发加载命令和代理（依赖步骤 2 已填充的缓存）
  const [pluginCommands, agentDefinitions] = await Promise.all([
    getPluginCommands(),
    getAgentDefinitionsWithOverrides(getOriginalCwd()),
  ])

  const { enabled, disabled, errors } = pluginResult

  // 步骤 4：并发为每个已启用插件加载 MCP 和 LSP 服务器配置
  // 这些是 loadAllPlugins 不填充的懒加载缓存槽。
  // 提前加载的好处：
  //   a) 获得准确的统计数据
  //   b) 填充缓存槽，使后续的 MCP 连接管理器（由 pluginReconnectKey bump 触发）
  //      无需重新解析清单文件即可看到服务器
  const [mcpCounts, lspCounts] = await Promise.all([
    Promise.all(
      enabled.map(async p => {
        if (p.mcpServers) return Object.keys(p.mcpServers).length  // 已缓存，直接计数
        const servers = await loadPluginMcpServers(p, errors)
        if (servers) p.mcpServers = servers  // 写入缓存槽
        return servers ? Object.keys(servers).length : 0
      }),
    ),
    Promise.all(
      enabled.map(async p => {
        if (p.lspServers) return Object.keys(p.lspServers).length  // 已缓存，直接计数
        const servers = await loadPluginLspServers(p, errors)
        if (servers) p.lspServers = servers  // 写入缓存槽
        return servers ? Object.keys(servers).length : 0
      }),
    ),
  ])
  // 汇总 MCP 和 LSP 服务器总数
  const mcp_count = mcpCounts.reduce((sum, n) => sum + n, 0)
  const lsp_count = lspCounts.reduce((sum, n) => sum + n, 0)

  // 步骤 5：原子性更新 AppState
  setAppState(prev => ({
    ...prev,
    plugins: {
      ...prev.plugins,
      enabled,            // 更新已启用插件列表
      disabled,           // 更新已禁用插件列表
      commands: pluginCommands,
      errors: mergePluginErrors(prev.plugins.errors, errors),  // 合并错误，保留 lsp-manager 错误
      needsRefresh: false,  // 消费刷新标志
    },
    agentDefinitions,
    mcp: {
      ...prev.mcp,
      // 递增重连键，触发 MCP 连接管理器副作用重新运行
      pluginReconnectKey: prev.mcp.pluginReconnectKey + 1,
    },
  }))

  // 步骤 6：重新初始化 LSP 服务器管理器
  // 无论是否有 LSP 插件都要调用——移除最后一个 LSP 插件也需要清除旧配置。
  // 无条件调用还修复了 #15521（LSP 管理器之前读取了市场协调前的旧 memoize 缓存）。
  // headless 子命令路径下若 LSP 从未初始化，此调用为 no-op。
  reinitializeLspServerManager()

  // 步骤 7：加载 hooks（独立 try/catch）
  // clearAllCaches() 已清除旧插件的 hooks；此步骤执行完整替换（含新启用插件的 hooks）。
  // hooks 失败不影响已加载的命令/代理数据（hooks 写入 STATE.registeredHooks，非 AppState）
  let hook_load_failed = false
  try {
    await loadPluginHooks()
  } catch (e) {
    hook_load_failed = true
    logError(e)
    logForDebugging(
      `refreshActivePlugins: loadPluginHooks failed: ${errorMessage(e)}`,
    )
  }

  // 统计 hook 总数（遍历所有 hooksConfig 的 matchers.hooks 数组）
  const hook_count = enabled.reduce((sum, p) => {
    if (!p.hooksConfig) return sum
    return (
      sum +
      Object.values(p.hooksConfig).reduce(
        (s, matchers) =>
          s + (matchers?.reduce((h, m) => h + m.hooks.length, 0) ?? 0),
        0,
      )
    )
  }, 0)

  logForDebugging(
    `refreshActivePlugins: ${enabled.length} enabled, ${pluginCommands.length} commands, ${agentDefinitions.allAgents.length} agents, ${hook_count} hooks, ${mcp_count} MCP, ${lsp_count} LSP`,
  )

  return {
    enabled_count: enabled.length,
    disabled_count: disabled.length,
    command_count: pluginCommands.length,
    agent_count: agentDefinitions.allAgents.length,
    hook_count,
    mcp_count,
    lsp_count,
    // hook 加载失败时在错误计数中额外加 1
    error_count: errors.length + (hook_load_failed ? 1 : 0),
    agentDefinitions,
    pluginCommands,
  }
}

/**
 * 合并最新的插件加载错误与 AppState 中已有的错误。
 *
 * 合并规则：
 *   - 保留来自 'lsp-manager' 和 'plugin:*' 来源的已有错误（由其他系统记录）
 *   - 对保留的错误进行去重（排除与最新错误重叠的部分）
 *   - 最新错误全量保留
 *
 * 目的：防止 refreshActivePlugins 丢失由 LSP 管理器等外部系统记录的错误。
 *
 * @param existing - AppState 中当前的错误列表
 * @param fresh - 本次加载产生的新错误列表
 * @returns 合并后的错误列表
 */
function mergePluginErrors(
  existing: PluginError[],
  fresh: PluginError[],
): PluginError[] {
  // 保留来自 lsp-manager 和 plugin: 前缀来源的错误
  const preserved = existing.filter(
    e => e.source === 'lsp-manager' || e.source.startsWith('plugin:'),
  )
  // 构建最新错误的键集合，用于去重
  const freshKeys = new Set(fresh.map(errorKey))
  // 从保留列表中排除与最新错误重叠的部分（最新错误优先）
  const deduped = preserved.filter(e => !freshKeys.has(errorKey(e)))
  return [...deduped, ...fresh]
}

/**
 * 根据插件错误类型生成唯一键，用于去重比较。
 *
 * @param e - 插件错误对象
 * @returns 唯一标识此错误的字符串键
 */
function errorKey(e: PluginError): string {
  return e.type === 'generic-error'
    ? `generic-error:${e.source}:${e.error}`
    : `${e.type}:${e.source}`
}
