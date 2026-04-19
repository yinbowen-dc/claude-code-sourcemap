/**
 * Agents 子命令处理器 — 打印已配置的 agent 列表。
 *
 * 在整个 Claude Code 系统中的位置：
 * 本文件在用户执行 `claude agents` 时被动态导入（懒加载），
 * 负责从磁盘加载 agent 定义、解析覆盖关系，并按来源分组打印到终端。
 * 它是 CLI 层与底层 AgentTool 加载/显示逻辑之间的薄适配层。
 */

import {
  AGENT_SOURCE_GROUPS,
  compareAgentsByName,
  getOverrideSourceLabel,
  type ResolvedAgent,
  resolveAgentModelDisplay,
  resolveAgentOverrides,
} from '../../tools/AgentTool/agentDisplay.js'
import {
  getActiveAgentsFromList,
  getAgentDefinitionsWithOverrides,
} from '../../tools/AgentTool/loadAgentsDir.js'
import { getCwd } from '../../utils/cwd.js'

/**
 * 将单个已解析的 agent 格式化为可读的单行字符串。
 *
 * 流程：依次取 agentType、model（若存在）、memory 信息，
 * 用中点符号 ` · ` 连接，返回形如 `type · model · memory` 的字符串。
 */
function formatAgent(agent: ResolvedAgent): string {
  // 解析该 agent 应显示的模型名称（可能来自覆盖或默认值）
  const model = resolveAgentModelDisplay(agent)
  const parts = [agent.agentType]
  // 仅在有 model 信息时才追加，避免出现多余的分隔符
  if (model) {
    parts.push(model)
  }
  // memory 字段存在时追加，带单位后缀 "memory"
  if (agent.memory) {
    parts.push(`${agent.memory} memory`)
  }
  return parts.join(' · ')
}

/**
 * `claude agents` 子命令的主处理函数。
 *
 * 流程：
 * 1. 获取当前工作目录，从磁盘加载所有 agent 定义（含覆盖关系）。
 * 2. 筛选出处于激活状态的 agent。
 * 3. 解析覆盖关系，确定每个 agent 是否被更高优先级的同名 agent 遮蔽。
 * 4. 按 AGENT_SOURCE_GROUPS 定义的来源顺序分组输出：
 *    - 被遮蔽的 agent 在名称前注明 "(shadowed by <来源>)"。
 *    - 未被遮蔽的 agent 直接打印格式化后的信息。
 * 5. 若无任何 agent，输出 "No agents found."；否则先打印激活数量摘要。
 */
export async function agentsHandler(): Promise<void> {
  // 获取当前工作目录，用于定位项目级 agent 配置
  const cwd = getCwd()
  // 加载全部 agent 定义（包含各来源的覆盖配置）
  const { allAgents } = await getAgentDefinitionsWithOverrides(cwd)
  // 过滤出激活状态的 agent（排除被禁用的条目）
  const activeAgents = getActiveAgentsFromList(allAgents)
  // 解析覆盖关系：确定哪些 agent 被其他 agent 遮蔽
  const resolvedAgents = resolveAgentOverrides(allAgents, activeAgents)

  const lines: string[] = []
  // 记录真正处于激活状态（未被遮蔽）的 agent 数量
  let totalActive = 0

  // 按预定义的来源分组顺序遍历（如 built-in、project、user 等）
  for (const { label, source } of AGENT_SOURCE_GROUPS) {
    // 筛选当前来源下的 agent，并按名称排序保证输出稳定
    const groupAgents = resolvedAgents
      .filter(a => a.source === source)
      .sort(compareAgentsByName)

    // 该来源下没有 agent 则跳过，不输出空分组标题
    if (groupAgents.length === 0) continue

    // 打印分组标题，格式为 "<来源标签>:"
    lines.push(`${label}:`)
    for (const agent of groupAgents) {
      if (agent.overriddenBy) {
        // 被其他来源遮蔽的 agent：注明遮蔽来源，仍列出以便用户感知
        const winnerSource = getOverrideSourceLabel(agent.overriddenBy)
        lines.push(`  (shadowed by ${winnerSource}) ${formatAgent(agent)}`)
      } else {
        // 正常激活的 agent：直接打印格式化信息
        lines.push(`  ${formatAgent(agent)}`)
        totalActive++
      }
    }
    // 每个分组后追加空行，提升可读性
    lines.push('')
  }

  if (lines.length === 0) {
    // biome-ignore lint/suspicious/noConsole:: intentional console output
    // 无任何 agent 配置时给出友好提示
    console.log('No agents found.')
  } else {
    // biome-ignore lint/suspicious/noConsole:: intentional console output
    // 先输出激活 agent 总数摘要
    console.log(`${totalActive} active agents\n`)
    // biome-ignore lint/suspicious/noConsole:: intentional console output
    // 输出分组详情，trimEnd 去除末尾多余空行
    console.log(lines.join('\n').trimEnd())
  }
}
