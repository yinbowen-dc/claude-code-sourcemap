/**
 * mcpInstructionsDelta.ts — MCP 服务器指令增量通告模块
 *
 * 【系统流程定位】
 * 本模块处于 Claude Code 的 MCP（Model Context Protocol）服务器生命周期管理层。
 * 当 MCP 服务器连接到会话时，服务器可能通过 InitializeResult.instructions 携带
 * 针对 Claude 的使用说明；此外，Claude Code 自身也可以为服务器注入客户端侧的
 * 上下文说明块（ClientSideInstruction）。
 *
 * 【核心问题】
 * MCP 服务器可能在会话中途连接（"迟到连接"），若每轮都将所有已连接服务器的
 * 指令拼入系统提示，会在每次 MCP 状态变化时使提示缓存失效（cache-bust），
 * 造成不必要的 API 成本。
 *
 * 【设计方案：attachment 持久化增量】
 * 本模块通过将指令变化（新增/移除的服务器名称及其指令块）
 * 以 attachment 消息类型（type: 'mcp_instructions_delta'）持久化到对话历史中，
 * 替代每轮重建的 DANGEROUS_uncachedSystemPromptSection。
 * 这样历史中的指令不会随服务器重新连接而变化，避免 cache-bust。
 *
 * 【主要职责】
 * 1. isMcpInstructionsDeltaEnabled：通过 env 变量 / ant bypass / GrowthBook 开关
 *    控制本功能的启用状态；
 * 2. getMcpInstructionsDelta：扫描已有对话历史中的 attachment 消息，
 *    构建"已通告"集合，与当前已连接服务器的指令集合做差集运算，
 *    返回需要新增通告或移除通告的增量；若无变化则返回 null。
 *
 * 【典型调用链】
 * 每轮对话前 → getMcpInstructionsDelta(clients, messages, clientSideInstructions)
 *   → 有增量 → 将 McpInstructionsDelta 作为 attachment 消息追加到对话历史
 *   → 无增量（null） → 跳过，不修改历史
 */

import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js'
import { logEvent } from '../services/analytics/index.js'
import type {
  ConnectedMCPServer,
  MCPServerConnection,
} from '../services/mcp/types.js'
import type { Message } from '../types/message.js'
import { isEnvDefinedFalsy, isEnvTruthy } from './envUtils.js'

/**
 * MCP 服务器指令增量结构。
 *
 * 描述一次指令通告变化：
 * - addedNames：新增通告的服务器名称列表（用于无状态扫描时重建 announced 集合）；
 * - addedBlocks：与 addedNames 一一对应的指令块文本（"## {name}\n{instructions}" 格式）；
 * - removedNames：已移除（断开连接）的服务器名称列表，用于从 announced 集合中删除。
 */
export type McpInstructionsDelta = {
  /** 新增通告的服务器名称列表，用于无状态重建扫描 */
  addedNames: string[]
  /** addedNames 对应的渲染后指令块（"## {name}\n{instructions}" 格式） */
  addedBlocks: string[]
  /** 被移除（断开连接）的服务器名称列表 */
  removedNames: string[]
}

/**
 * 客户端侧指令块结构。
 *
 * 允许 Claude Code 客户端（如 claude-in-chrome 扩展）在服务器连接时
 * 附加额外的上下文说明块，补充服务器自身 InitializeResult.instructions 中
 * 不包含的信息（服务器通常不感知客户端所处的环境上下文）。
 *
 * 若服务器同时有服务端指令和客户端侧指令，两者会被拼接后作为一个整体通告。
 */
export type ClientSideInstruction = {
  /** 目标服务器名称（必须与已连接服务器的 name 一致） */
  serverName: string
  /** 要附加的指令块文本内容 */
  block: string
}

/**
 * 判断 MCP 服务器指令增量通告功能是否已启用。
 *
 * 优先级（从高到低）：
 * 1. 环境变量 CLAUDE_CODE_MCP_INSTR_DELTA=true → 强制启用（本地测试用）；
 * 2. 环境变量 CLAUDE_CODE_MCP_INSTR_DELTA=false（定义且为假值）→ 强制禁用；
 * 3. USER_TYPE === 'ant'（Anthropic 内部用户）→ 自动启用，绕过 GrowthBook；
 * 4. GrowthBook 功能开关 tengu_basalt_3kr → 按发布进度渐进启用。
 *
 * 启用时：通过持久化 attachment 消息通告 MCP 服务器指令变化（避免 cache-bust）。
 * 禁用时：prompts.ts 使用 DANGEROUS_uncachedSystemPromptSection（每轮重建，可能 cache-bust）。
 *
 * @returns 功能是否启用
 */
export function isMcpInstructionsDeltaEnabled(): boolean {
  // env 变量优先，供本地开发和集成测试快速切换
  if (isEnvTruthy(process.env.CLAUDE_CODE_MCP_INSTR_DELTA)) return true
  if (isEnvDefinedFalsy(process.env.CLAUDE_CODE_MCP_INSTR_DELTA)) return false
  // Anthropic 内部用户无需等待功能开关，直接启用
  return (
    process.env.USER_TYPE === 'ant' ||
    // 其他用户通过 GrowthBook 实验性渐进开放
    getFeatureValue_CACHED_MAY_BE_STALE('tengu_basalt_3kr', false)
  )
}

/**
 * 计算当前连接的 MCP 服务器指令集合与已通告集合之间的增量。
 *
 * 【核心算法】
 * 1. 扫描对话历史（messages），累积所有 attachment/mcp_instructions_delta 消息：
 *    - 对每个 addedNames 中的名称：加入 announced 集合；
 *    - 对每个 removedNames 中的名称：从 announced 集合中删除；
 *    - 这样 announced 反映了"当前对话历史中已经通告过的服务器名称"；
 * 2. 构建 blocks Map（服务器名 → 指令块文本）：
 *    - 服务端指令：connected 服务器的 c.instructions（若存在）；
 *    - 客户端侧指令：clientSideInstructions 中 serverName 在 connectedNames 内的项，
 *      追加到同名服务器已有块的末尾（两个换行符分隔），或作为独立块；
 * 3. 差集运算：
 *    - added = blocks 中 name 不在 announced 中的条目（新增通告）；
 *    - removed = announced 中 name 不在 connectedNames 中的条目（服务器已断开连接）；
 * 4. 若 added 和 removed 均为空，返回 null（无变化，调用方跳过追加 attachment）；
 * 5. 否则记录诊断事件后，对 added 按名称排序，返回 McpInstructionsDelta。
 *
 * 注意：指令在连接生命周期内不可变（InitializeResult 只在握手时发一次），
 * 因此增量扫描只需关注服务器名称，不需要关注指令内容变化。
 *
 * @param mcpClients             当前所有 MCP 服务器连接（含未连接的）
 * @param messages               当前对话历史消息列表
 * @param clientSideInstructions 客户端侧指令块列表
 * @returns 增量对象，或 null（无变化）
 */
export function getMcpInstructionsDelta(
  mcpClients: MCPServerConnection[],
  messages: Message[],
  clientSideInstructions: ClientSideInstruction[],
): McpInstructionsDelta | null {
  // 重建"已通告"集合：通过回放历史中所有 mcp_instructions_delta attachment 实现
  const announced = new Set<string>()
  // 以下计数器用于诊断日志，帮助排查扫描失败问题
  let attachmentCount = 0  // 所有 attachment 消息总数
  let midCount = 0         // mcp_instructions_delta 类型 attachment 消息数
  for (const msg of messages) {
    if (msg.type !== 'attachment') continue
    attachmentCount++
    if (msg.attachment.type !== 'mcp_instructions_delta') continue
    midCount++
    // 回放增量：新增的名称加入集合，移除的名称从集合中删除
    for (const n of msg.attachment.addedNames) announced.add(n)
    for (const n of msg.attachment.removedNames) announced.delete(n)
  }

  // 过滤出真正处于已连接状态的服务器（排除正在连接/断开中的）
  const connected = mcpClients.filter(
    (c): c is ConnectedMCPServer => c.type === 'connected',
  )
  // 构建连接名称集合，用于快速查找（O(1)）
  const connectedNames = new Set(connected.map(c => c.name))

  // 构建"有指令的服务器"映射：服务器名 → 渲染后的指令块文本
  // 服务器可以同时拥有服务端指令（c.instructions）和客户端侧指令（ci.block），
  // 两者会以 \n\n 分隔拼接为一个块。
  const blocks = new Map<string, string>()
  for (const c of connected) {
    // 只有含 instructions 的服务器才需要通告（无指令的服务器不占用上下文）
    if (c.instructions) blocks.set(c.name, `## ${c.name}\n${c.instructions}`)
  }
  for (const ci of clientSideInstructions) {
    // 跳过未连接服务器的客户端侧指令（连接状态可能已改变）
    if (!connectedNames.has(ci.serverName)) continue
    const existing = blocks.get(ci.serverName)
    blocks.set(
      ci.serverName,
      existing
        ? // 服务器既有服务端指令又有客户端侧指令：拼接两个块
          `${existing}\n\n${ci.block}`
        : // 服务器只有客户端侧指令：以 ## 标题开头构建独立块
          `## ${ci.serverName}\n${ci.block}`,
    )
  }

  // 新增通告：blocks 中存在但尚未在 announced 中出现的服务器
  const added: Array<{ name: string; block: string }> = []
  for (const [name, block] of blocks) {
    if (!announced.has(name)) added.push({ name, block })
  }

  // 移除通告：announced 中已通告但当前已不在连接集合中的服务器（连接已断开）
  // 注意：不处理"已连接但指令变为空"的场景，因为 InitializeResult 在连接期间不可变；
  // 客户端侧指令门控在会话内也实际上是稳定的（/model 命令可能切换模型，
  // 但历史消息被视为不可追溯修改的历史记录，与 deferred_tools_delta 的处理策略一致）。
  const removed: string[] = []
  for (const n of announced) {
    if (!connectedNames.has(n)) removed.push(n)
  }

  // 无变化：added 和 removed 均为空，调用方不需要追加任何 attachment 消息
  if (added.length === 0 && removed.length === 0) return null

  // 记录诊断事件，与 tengu_deferred_tools_pool_change 使用相同的字段集合
  // （相同的扫描失败 bug 复现路径，相同的 attachment 持久化路径）
  logEvent('tengu_mcp_instructions_pool_change', {
    addedCount: added.length,
    removedCount: removed.length,
    priorAnnouncedCount: announced.size,
    clientSideCount: clientSideInstructions.length,
    messagesLength: messages.length,
    attachmentCount,
    midCount,
  })

  // 按名称字母序排序 added，确保相同服务器集合产生确定性的 addedBlocks 顺序
  added.sort((a, b) => a.name.localeCompare(b.name))
  return {
    addedNames: added.map(a => a.name),
    addedBlocks: added.map(a => a.block),
    removedNames: removed.sort(), // removed 也按字母序排序
  }
}
