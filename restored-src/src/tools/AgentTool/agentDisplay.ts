/**
 * Agent 显示工具模块
 *
 * 在 Claude Code 系统流程中，该模块位于 AgentTool 层，负责为 CLI 命令
 * `claude agents` 和交互式 `/agents` 命令提供共用的 Agent 展示工具函数。
 *
 * 核心职责：
 * 1. 定义 Agent 来源分组（用户/项目/本地/托管/插件/内置等）
 * 2. 通过比对活跃 Agent 列表，为每个 Agent 标注是否被更高优先级来源覆盖
 * 3. 提供模型、来源标签及名称比较等辅助函数
 *
 * CLI 层和交互 UI 层均应使用本模块，以保证展示顺序和逻辑的一致性。
 */

import { getDefaultSubagentModel } from '../../utils/model/agent.js'
import {
  getSourceDisplayName,
  type SettingSource,
} from '../../utils/settings/constants.js'
import type { AgentDefinition } from './loadAgentsDir.js'

// Agent 来源类型：包含所有设置来源、内置以及插件
type AgentSource = SettingSource | 'built-in' | 'plugin'

// Agent 来源分组的类型定义：包含展示标签和来源标识
export type AgentSourceGroup = {
  label: string
  source: AgentSource
}

/**
 * Agent 来源分组的有序列表，用于 CLI 和交互 UI 的展示。
 *
 * 两端均应使用此列表以确保展示顺序完全一致。
 * 排列顺序从用户级别到内置，优先级从低到高排列（仅供展示）。
 */
export const AGENT_SOURCE_GROUPS: AgentSourceGroup[] = [
  { label: 'User agents', source: 'userSettings' },       // 用户级别 Agent
  { label: 'Project agents', source: 'projectSettings' }, // 项目级别 Agent
  { label: 'Local agents', source: 'localSettings' },     // 本地（不入版本控制）Agent
  { label: 'Managed agents', source: 'policySettings' },  // 策略管理 Agent
  { label: 'Plugin agents', source: 'plugin' },           // 插件提供的 Agent
  { label: 'CLI arg agents', source: 'flagSettings' },    // 命令行参数传入的 Agent
  { label: 'Built-in agents', source: 'built-in' },       // 内置 Agent
]

// 已解析的 Agent 类型：在 AgentDefinition 基础上附加覆盖来源信息
export type ResolvedAgent = AgentDefinition & {
  overriddenBy?: AgentSource // 若被覆盖，记录覆盖它的来源
}

/**
 * 将所有 Agent 与活跃（胜出）Agent 列表对比，标注覆盖信息。
 *
 * 流程：
 * 1. 将 activeAgents 构建为以 agentType 为键的 Map，方便 O(1) 查询
 * 2. 遍历 allAgents，对每个 Agent 检查是否有另一个更高优先级来源的同类型 Agent
 * 3. 若存在，则在结果中记录 overriddenBy 字段
 * 4. 同时通过 (agentType, source) 组合键去重，处理 git worktree 场景下
 *    同一文件被从主仓库和 worktree 各加载一次的情况
 *
 * @param allAgents 所有来源的 Agent 定义列表
 * @param activeAgents 当前生效的 Agent 列表（高优先级覆盖低优先级后的结果）
 * @returns 附带覆盖信息的 ResolvedAgent 列表
 */
export function resolveAgentOverrides(
  allAgents: AgentDefinition[],
  activeAgents: AgentDefinition[],
): ResolvedAgent[] {
  // 构建活跃 Agent 的 Map：agentType → AgentDefinition
  const activeMap = new Map<string, AgentDefinition>()
  for (const agent of activeAgents) {
    activeMap.set(agent.agentType, agent)
  }

  // 用于去重的 Set，键为 "agentType:source"
  const seen = new Set<string>()
  const resolved: ResolvedAgent[] = []

  // 遍历所有 Agent，标注覆盖信息并去重（处理 git worktree 重复加载）
  for (const agent of allAgents) {
    // 组合键，用于去重
    const key = `${agent.agentType}:${agent.source}`
    if (seen.has(key)) continue // 已处理过该 (agentType, source) 组合，跳过
    seen.add(key)

    // 查找当前活跃的同类型 Agent
    const active = activeMap.get(agent.agentType)
    // 若活跃 Agent 的来源与当前 Agent 不同，说明当前 Agent 被覆盖了
    const overriddenBy =
      active && active.source !== agent.source ? active.source : undefined
    resolved.push({ ...agent, overriddenBy })
  }

  return resolved
}

/**
 * 解析 Agent 的展示用模型字符串。
 *
 * 若 Agent 未指定模型，则使用全局默认子 Agent 模型；
 * 'inherit' 表示继承父 Agent 的模型，直接原样返回。
 *
 * @param agent Agent 定义对象
 * @returns 展示用的模型字符串，无法解析时返回 undefined
 */
export function resolveAgentModelDisplay(
  agent: AgentDefinition,
): string | undefined {
  // 优先使用 Agent 自身指定的模型，否则使用系统默认子 Agent 模型
  const model = agent.model || getDefaultSubagentModel()
  if (!model) return undefined
  // 'inherit' 原样返回，其他模型别名也直接返回
  return model === 'inherit' ? 'inherit' : model
}

/**
 * 获取覆盖某 Agent 的来源的人类可读标签。
 *
 * 将来源标识（如 'userSettings'）转换为小写展示名（如 'user'），
 * 用于 UI 中展示"被 xxx 来源覆盖"的提示文字。
 *
 * @param source 覆盖该 Agent 的来源标识
 * @returns 小写的来源展示名，例如 "user"、"project"、"managed"
 */
export function getOverrideSourceLabel(source: AgentSource): string {
  // 调用 settings 工具函数获取展示名，转为小写
  return getSourceDisplayName(source).toLowerCase()
}

/**
 * 按 agentType 名称对两个 Agent 进行字母序比较（不区分大小写）。
 *
 * 主要用于 UI 展示时对 Agent 列表排序，保证一致的展示顺序。
 *
 * @param a 第一个 Agent 定义
 * @param b 第二个 Agent 定义
 * @returns 负数/0/正数，符合 Array.sort 约定
 */
export function compareAgentsByName(
  a: AgentDefinition,
  b: AgentDefinition,
): number {
  // 使用 localeCompare 并设置 sensitivity: 'base' 以忽略大小写
  return a.agentType.localeCompare(b.agentType, undefined, {
    sensitivity: 'base',
  })
}
