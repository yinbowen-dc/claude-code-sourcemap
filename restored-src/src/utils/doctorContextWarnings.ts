/**
 * Doctor 上下文警告模块（doctorContextWarnings.ts）
 *
 * 【在系统流程中的位置】
 * 该模块属于 `claude doctor` 诊断子系统，在用户运行诊断命令时被调用。
 * 负责检测会话上下文中各类 token 占用过大的问题，并生成带有修复建议的警告对象，
 * 供命令行 UI 以可视化方式呈现给用户。
 *
 * 【主要功能】
 * - checkClaudeMdFiles()：检测超大 CLAUDE.md 内存文件
 * - checkAgentDescriptions()：检测 Agent 描述 token 超限
 * - checkMcpTools()：检测 MCP 工具 token 超限（含按服务器分组统计）
 * - checkUnreachableRules()：检测永远不会生效的权限规则
 * - checkContextWarnings()：并行运行以上四项检测，返回汇总结果
 */
import { roughTokenCountEstimation } from '../services/tokenEstimation.js'
import type { Tool, ToolPermissionContext } from '../Tool.js'
import type { AgentDefinitionsResult } from '../tools/AgentTool/loadAgentsDir.js'
import { countMcpToolTokens } from './analyzeContext.js'
import {
  getLargeMemoryFiles,
  getMemoryFiles,
  MAX_MEMORY_CHARACTER_COUNT,
} from './claudemd.js'
import { getMainLoopModel } from './model/model.js'
import { permissionRuleValueToString } from './permissions/permissionRuleParser.js'
import { detectUnreachableRules } from './permissions/shadowedRuleDetection.js'
import { SandboxManager } from './sandbox/sandbox-adapter.js'
import {
  AGENT_DESCRIPTIONS_THRESHOLD,
  getAgentDescriptionsTotalTokens,
} from './statusNoticeHelpers.js'
import { plural } from './stringUtils.js'

// MCP 工具 token 告警阈值（超过此值时生成警告）
const MCP_TOOLS_THRESHOLD = 25_000 // 15k tokens

/** 单条上下文警告的结构类型 */
export type ContextWarning = {
  /** 警告分类，对应四类检测项 */
  type:
    | 'claudemd_files'
    | 'agent_descriptions'
    | 'mcp_tools'
    | 'unreachable_rules'
  /** 警告严重级别 */
  severity: 'warning' | 'error'
  /** 警告摘要文本 */
  message: string
  /** 详细说明条目列表 */
  details: string[]
  /** 当前检测到的数值（用于与 threshold 比较） */
  currentValue: number
  /** 触发警告的阈值 */
  threshold: number
}

/** checkContextWarnings() 的完整返回类型，包含四个可空警告字段 */
export type ContextWarnings = {
  claudeMdWarning: ContextWarning | null
  agentWarning: ContextWarning | null
  mcpWarning: ContextWarning | null
  unreachableRulesWarning: ContextWarning | null
}

/**
 * 检测超大 CLAUDE.md 内存文件，生成对应警告。
 *
 * 【流程说明】
 * 1. 调用 getMemoryFiles() 读取所有内存文件，再由 getLargeMemoryFiles() 过滤出超限文件
 * 2. 无超限文件时返回 null（不产生警告）
 * 3. 超限文件按内容长度倒序排列，生成路径+字符数的详情列表
 * 4. 根据文件数量生成单数/复数形式的警告消息
 */
async function checkClaudeMdFiles(): Promise<ContextWarning | null> {
  // 读取所有内存文件后过滤出超大文件（每个超过 40k 字符）
  const largeFiles = getLargeMemoryFiles(await getMemoryFiles())

  // 无超大文件时无需产生警告
  if (largeFiles.length === 0) {
    return null
  }

  // 按文件内容长度降序排列，生成详情条目（格式：路径: N chars）
  const details = largeFiles
    .sort((a, b) => b.content.length - a.content.length)
    .map(file => `${file.path}: ${file.content.length.toLocaleString()} chars`)

  // 根据超大文件数量选择单数或复数形式的警告消息
  const message =
    largeFiles.length === 1
      ? `Large CLAUDE.md file detected (${largeFiles[0]!.content.length.toLocaleString()} chars > ${MAX_MEMORY_CHARACTER_COUNT.toLocaleString()})`
      : `${largeFiles.length} large CLAUDE.md files detected (each > ${MAX_MEMORY_CHARACTER_COUNT.toLocaleString()} chars)`

  return {
    type: 'claudemd_files',
    severity: 'warning',
    message,
    details,
    currentValue: largeFiles.length, // Number of files exceeding threshold
    threshold: MAX_MEMORY_CHARACTER_COUNT,
  }
}

/**
 * 检测 Agent 描述 token 是否超限，生成对应警告。
 *
 * 【流程说明】
 * 1. agentInfo 为 null（无 Agent 信息）时直接返回 null
 * 2. 调用 getAgentDescriptionsTotalTokens() 计算所有 Agent 描述的总 token 数
 * 3. 未超出阈值时返回 null
 * 4. 超限时，对每个非内置 Agent 计算 token，按 token 数降序取前 5 名生成详情
 */
async function checkAgentDescriptions(
  agentInfo: AgentDefinitionsResult | null,
): Promise<ContextWarning | null> {
  // 没有 Agent 信息时跳过检测
  if (!agentInfo) {
    return null
  }

  // 计算所有 Agent 描述的总 token 数
  const totalTokens = getAgentDescriptionsTotalTokens(agentInfo)

  // 未超出阈值，无需警告
  if (totalTokens <= AGENT_DESCRIPTIONS_THRESHOLD) {
    return null
  }

  // 计算每个非内置 Agent 的 token 数，并按降序排列
  const agentTokens = agentInfo.activeAgents
    .filter(a => a.source !== 'built-in')
    .map(agent => {
      const description = `${agent.agentType}: ${agent.whenToUse}`
      return {
        name: agent.agentType,
        tokens: roughTokenCountEstimation(description),
      }
    })
    .sort((a, b) => b.tokens - a.tokens)

  // 取 token 数最多的前 5 个 Agent 作为详情展示
  const details = agentTokens
    .slice(0, 5)
    .map(agent => `${agent.name}: ~${agent.tokens.toLocaleString()} tokens`)

  // 超过 5 个时追加剩余数量提示
  if (agentTokens.length > 5) {
    details.push(`(${agentTokens.length - 5} more custom agents)`)
  }

  return {
    type: 'agent_descriptions',
    severity: 'warning',
    message: `Large agent descriptions (~${totalTokens.toLocaleString()} tokens > ${AGENT_DESCRIPTIONS_THRESHOLD.toLocaleString()})`,
    details,
    currentValue: totalTokens,
    threshold: AGENT_DESCRIPTIONS_THRESHOLD,
  }
}

/**
 * 检测 MCP 工具 token 总量是否超限，生成对应警告。
 *
 * 【流程说明】
 * 1. 筛选所有标记为 MCP 的工具（isMcp=true）
 * 2. 无 MCP 工具时返回 null（doctor 命令在 MCP 连接建立前运行，此时可能为空）
 * 3. 调用 countMcpToolTokens() 精确计算 token；失败时回退到字符数估算
 * 4. token 总量超限时，将工具按服务器名分组（解析 mcp__server__tool 命名格式）
 * 5. 按服务器 token 降序取前 5 名生成详情
 */
async function checkMcpTools(
  tools: Tool[],
  getToolPermissionContext: () => Promise<ToolPermissionContext>,
  agentInfo: AgentDefinitionsResult | null,
): Promise<ContextWarning | null> {
  // 筛选出所有 MCP 工具
  const mcpTools = tools.filter(tool => tool.isMcp)

  // doctor 命令可能在 MCP 连接建立前执行，此时 MCP 工具列表为空
  if (mcpTools.length === 0) {
    return null
  }

  try {
    // 使用 analyzeContext 中的 countMcpToolTokens 精确计算 token
    const model = getMainLoopModel()
    const { mcpToolTokens, mcpToolDetails } = await countMcpToolTokens(
      tools,
      getToolPermissionContext,
      agentInfo,
      model,
    )

    // token 总量未超限，无需警告
    if (mcpToolTokens <= MCP_TOOLS_THRESHOLD) {
      return null
    }

    // 将工具按服务器名分组，统计各服务器的工具数和 token 数
    const toolsByServer = new Map<string, { count: number; tokens: number }>()

    for (const tool of mcpToolDetails) {
      // 从工具名（mcp__servername__toolname）中提取服务器名
      const parts = tool.name.split('__')
      const serverName = parts[1] || 'unknown'

      const current = toolsByServer.get(serverName) || { count: 0, tokens: 0 }
      toolsByServer.set(serverName, {
        count: current.count + 1,
        tokens: current.tokens + tool.tokens,
      })
    }

    // 按 token 数降序排列服务器列表
    const sortedServers = Array.from(toolsByServer.entries()).sort(
      (a, b) => b[1].tokens - a[1].tokens,
    )

    // 取前 5 个服务器生成详情条目
    const details = sortedServers
      .slice(0, 5)
      .map(
        ([name, info]) =>
          `${name}: ${info.count} tools (~${info.tokens.toLocaleString()} tokens)`,
      )

    // 超过 5 个服务器时追加剩余数量提示
    if (sortedServers.length > 5) {
      details.push(`(${sortedServers.length - 5} more servers)`)
    }

    return {
      type: 'mcp_tools',
      severity: 'warning',
      message: `Large MCP tools context (~${mcpToolTokens.toLocaleString()} tokens > ${MCP_TOOLS_THRESHOLD.toLocaleString()})`,
      details,
      currentValue: mcpToolTokens,
      threshold: MCP_TOOLS_THRESHOLD,
    }
  } catch (_error) {
    // 精确计算失败时，回退到基于字符数的 token 估算
    const estimatedTokens = mcpTools.reduce((total, tool) => {
      const chars = (tool.name?.length || 0) + tool.description.length
      return total + roughTokenCountEstimation(chars.toString())
    }, 0)

    // 估算值也未超限，无需警告
    if (estimatedTokens <= MCP_TOOLS_THRESHOLD) {
      return null
    }

    return {
      type: 'mcp_tools',
      severity: 'warning',
      message: `Large MCP tools context (~${estimatedTokens.toLocaleString()} tokens estimated > ${MCP_TOOLS_THRESHOLD.toLocaleString()})`,
      details: [
        `${mcpTools.length} MCP tools detected (token count estimated)`,
      ],
      currentValue: estimatedTokens,
      threshold: MCP_TOOLS_THRESHOLD,
    }
  }
}

/**
 * 检测永远不会生效的权限规则（被更宽泛规则遮蔽的具体规则）。
 *
 * 【流程说明】
 * 1. 获取工具权限上下文，查询沙箱自动允许状态
 * 2. 调用 detectUnreachableRules() 找出所有被遮蔽（unreachable）的规则
 * 3. 无不可达规则时返回 null
 * 4. 将每条不可达规则的原因和修复建议以两行格式加入详情列表
 */
async function checkUnreachableRules(
  getToolPermissionContext: () => Promise<ToolPermissionContext>,
): Promise<ContextWarning | null> {
  // 获取工具权限上下文
  const context = await getToolPermissionContext()
  // 沙箱启用且开启了自动允许模式时，沙箱会自动允许部分 Bash 操作
  const sandboxAutoAllowEnabled =
    SandboxManager.isSandboxingEnabled() &&
    SandboxManager.isAutoAllowBashIfSandboxedEnabled()

  // 检测所有被遮蔽的权限规则
  const unreachable = detectUnreachableRules(context, {
    sandboxAutoAllowEnabled,
  })

  // 无不可达规则，无需警告
  if (unreachable.length === 0) {
    return null
  }

  // 为每条不可达规则生成两行详情：规则+原因、缩进修复建议
  const details = unreachable.flatMap(r => [
    `${permissionRuleValueToString(r.rule.ruleValue)}: ${r.reason}`,
    `  Fix: ${r.fix}`,
  ])

  return {
    type: 'unreachable_rules',
    severity: 'warning',
    message: `${unreachable.length} ${plural(unreachable.length, 'unreachable permission rule')} detected`,
    details,
    currentValue: unreachable.length,
    threshold: 0,
  }
}

/**
 * 并行运行所有上下文警告检测，返回汇总结果。
 *
 * 【流程说明】
 * 1. 使用 Promise.all 并行执行四个独立的检测函数，提升性能
 * 2. 将四个结果分别赋值到对应字段并返回
 *
 * @param tools                    当前可用的工具列表
 * @param agentInfo                当前 Agent 定义信息（可为 null）
 * @param getToolPermissionContext 获取工具权限上下文的异步工厂函数
 */
export async function checkContextWarnings(
  tools: Tool[],
  agentInfo: AgentDefinitionsResult | null,
  getToolPermissionContext: () => Promise<ToolPermissionContext>,
): Promise<ContextWarnings> {
  // 四项检测并行执行，通过解构赋值分别获取结果
  const [claudeMdWarning, agentWarning, mcpWarning, unreachableRulesWarning] =
    await Promise.all([
      checkClaudeMdFiles(),
      checkAgentDescriptions(agentInfo),
      checkMcpTools(tools, getToolPermissionContext, agentInfo),
      checkUnreachableRules(getToolPermissionContext),
    ])

  return {
    claudeMdWarning,
    agentWarning,
    mcpWarning,
    unreachableRulesWarning,
  }
}
