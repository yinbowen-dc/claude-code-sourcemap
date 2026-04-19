/**
 * teamDiscovery.ts — 团队发现与状态查询模块
 *
 * 在 Claude Code 多智能体（Agent Swarm）架构中，本文件负责：
 *   1. 扫描磁盘上的团队配置文件（~/.claude/teams/<teamName>），读取所有成员信息
 *   2. 将成员的 `isActive` 字段映射为 'running' | 'idle' 状态
 *   3. 为 UI（底部状态栏 / Swarm 视图）提供团队成员状态列表
 *
 * 数据流向：
 *   teamHelpers.readTeamFile() → TeamFile 配置 → getTeammateStatuses() → TeammateStatus[]
 *                                                                        ↓
 *                                                         UI 渲染 / 状态展示
 */

import { isPaneBackend, type PaneBackendType } from './swarm/backends/types.js'
import { readTeamFile } from './swarm/teamHelpers.js'

/** 团队摘要信息（成员总数、运行中数量、空闲数量） */
export type TeamSummary = {
  name: string
  memberCount: number
  runningCount: number
  idleCount: number
}

/**
 * 单个团队成员的运行状态快照。
 *
 * 字段说明：
 *   - `status`       : 'running'（isActive=true）| 'idle'（isActive=false）| 'unknown'
 *   - `tmuxPaneId`   : 成员所在 tmux pane 的标识符，用于 UI 聚焦
 *   - `worktreePath` : 成员使用的 git worktree 路径（可选）
 *   - `isHidden`     : 该 pane 是否在 swarm 视图中被隐藏
 *   - `backendType`  : 底层 pane 后端类型（tmux / in-process 等）
 *   - `mode`         : 成员当前的权限模式（如 "plan" / "auto" 等）
 */
export type TeammateStatus = {
  name: string
  agentId: string
  agentType?: string
  model?: string
  prompt?: string
  status: 'running' | 'idle' | 'unknown'
  color?: string
  idleSince?: string // ISO 时间戳，来自空闲通知消息
  tmuxPaneId: string
  cwd: string
  worktreePath?: string
  isHidden?: boolean // 该 pane 是否在 swarm 视图中隐藏
  backendType?: PaneBackendType // 此成员使用的后端类型
  mode?: string // 成员当前的权限模式
}

/**
 * 获取指定团队所有成员的详细状态列表。
 *
 * 执行流程：
 *   1. 调用 readTeamFile(teamName) 读取磁盘上的团队配置 JSON
 *   2. 跳过 'team-lead'（领队不出现在成员状态列表中）
 *   3. 读取每个成员的 `isActive` 字段，映射为 'running' | 'idle'
 *   4. 合并隐藏 pane 集合（hiddenPaneIds），标记 isHidden
 *   5. 验证 backendType 是否为合法的 PaneBackendType，过滤非法值
 *
 * @param teamName - 团队名称（对应 ~/.claude/teams/<teamName> 目录）
 * @returns 团队成员状态数组；若团队文件不存在则返回空数组
 */
export function getTeammateStatuses(teamName: string): TeammateStatus[] {
  // 读取团队配置文件，若文件不存在返回空数组
  const teamFile = readTeamFile(teamName)
  if (!teamFile) {
    return []
  }

  // 构建隐藏 pane 集合，用于快速判断成员是否被隐藏
  const hiddenPaneIds = new Set(teamFile.hiddenPaneIds ?? [])
  const statuses: TeammateStatus[] = []

  for (const member of teamFile.members) {
    // 领队不需要出现在成员状态列表中，跳过
    if (member.name === 'team-lead') {
      continue
    }

    // 读取 isActive 字段，undefined 时默认视为活跃（true）
    const isActive = member.isActive !== false
    // 将布尔值映射为字符串状态
    const status: 'running' | 'idle' = isActive ? 'running' : 'idle'

    statuses.push({
      name: member.name,
      agentId: member.agentId,
      agentType: member.agentType,
      model: member.model,
      prompt: member.prompt,
      status,
      color: member.color,
      tmuxPaneId: member.tmuxPaneId,
      cwd: member.cwd,
      worktreePath: member.worktreePath,
      // 检查 pane 是否在隐藏集合中
      isHidden: hiddenPaneIds.has(member.tmuxPaneId),
      // 校验 backendType 合法性，非法值设为 undefined
      backendType:
        member.backendType && isPaneBackend(member.backendType)
          ? member.backendType
          : undefined,
      mode: member.mode,
    })
  }

  return statuses
}

// 注意：时间格式化请使用 '../utils/format.js' 中的 formatRelativeTimeAgo
