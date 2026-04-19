/**
 * swarm/teamHelpers.ts — Swarm 团队文件管理核心模块
 *
 * 在 Claude Code 系统流程中的位置：
 *   Swarm 基础设施层的核心数据访问层（Data Access Layer）。该模块是整个 Swarm 系统
 *   中读写团队配置文件（config.json）的唯一入口，被以下模块广泛依赖：
 *     - 孵化层（spawnInProcess、spawnUtils）用于注册/移除成员；
 *     - 重连层（reconnection）用于读取 leadAgentId；
 *     - 初始化层（teammateInit）用于读取团队权限路径；
 *     - 工具层（TeammateTool、TeamDeleteTool 等）用于 CRUD 操作；
 *     - 会话清理钩子（cleanupSessionTeams）用于进程退出时清理资源。
 *
 * 主要功能：
 *   - 团队目录/文件路径计算（getTeamDir、getTeamFilePath）；
 *   - 团队配置文件的同步/异步读写；
 *   - 成员的增删改（按 paneId 或 agentId）；
 *   - 隐藏面板 ID 列表的管理；
 *   - 成员权限模式和活跃状态的更新；
 *   - Git worktree 的销毁；
 *   - 会话级团队清理注册与执行。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { mkdir, readFile, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { z } from 'zod/v4'
import { getSessionCreatedTeams } from '../../bootstrap/state.js'
import { logForDebugging } from '../debug.js'
import { getTeamsDir } from '../envUtils.js'
import { errorMessage, getErrnoCode } from '../errors.js'
import { execFileNoThrowWithCwd } from '../execFileNoThrow.js'
import { gitExe } from '../git.js'
import { lazySchema } from '../lazySchema.js'
import type { PermissionMode } from '../permissions/PermissionMode.js'
import { jsonParse, jsonStringify } from '../slowOperations.js'
import { getTasksDir, notifyTasksUpdated } from '../tasks.js'
import { getAgentName, getTeamName, isTeammate } from '../teammate.js'
import { type BackendType, isPaneBackend } from './backends/types.js'
import { TEAM_LEAD_NAME } from './constants.js'

// ─── 输入模式定义（Zod Schema） ───────────────────────────────────────────────

/**
 * 团队工具的输入参数 Schema（懒加载，避免启动时的 Zod 开销）。
 * 支持 spawnTeam（创建团队）和 cleanup（清理目录）两种操作。
 */
export const inputSchema = lazySchema(() =>
  z.strictObject({
    operation: z
      .enum(['spawnTeam', 'cleanup'])
      .describe(
        'Operation: spawnTeam to create a team, cleanup to remove team and task directories.',
      ),
    agent_type: z
      .string()
      .optional()
      .describe(
        'Type/role of the team lead (e.g., "researcher", "test-runner"). ' +
          'Used for team file and inter-agent coordination.',
      ),
    team_name: z
      .string()
      .optional()
      .describe('Name for the new team to create (required for spawnTeam).'),
    description: z
      .string()
      .optional()
      .describe('Team description/purpose (only used with spawnTeam).'),
  }),
)

// ─── 输出类型定义 ──────────────────────────────────────────────────────────────

/** spawnTeam 操作的返回结构 */
export type SpawnTeamOutput = {
  team_name: string
  team_file_path: string
  lead_agent_id: string
}

/** cleanup 操作的返回结构 */
export type CleanupOutput = {
  success: boolean
  message: string
  team_name?: string
}

/** 团队级别的路径权限条目（允许所有成员操作特定路径） */
export type TeamAllowedPath = {
  path: string      // 绝对目录路径
  toolName: string  // 适用的工具名称（例如 "Edit"、"Write"）
  addedBy: string   // 添加该规则的 Agent 名称
  addedAt: number   // 添加时间戳
}

/**
 * 团队配置文件（config.json）的数据结构。
 * 持久化存储在 ~/.claude/teams/{team-name}/config.json。
 */
export type TeamFile = {
  name: string
  description?: string
  createdAt: number
  leadAgentId: string
  leadSessionId?: string     // Leader 的实际会话 UUID（用于服务发现）
  hiddenPaneIds?: string[]   // 当前从 UI 中隐藏的 Pane ID 列表
  teamAllowedPaths?: TeamAllowedPath[] // 所有成员可无需询问即可编辑的路径
  members: Array<{
    agentId: string
    name: string
    agentType?: string
    model?: string
    prompt?: string
    color?: string
    planModeRequired?: boolean
    joinedAt: number
    tmuxPaneId: string
    cwd: string
    worktreePath?: string
    sessionId?: string
    subscriptions: string[]
    backendType?: BackendType
    isActive?: boolean   // false 表示空闲，undefined/true 表示活跃
    mode?: PermissionMode // 该成员的当前权限模式
  }>
}

export type Input = z.infer<ReturnType<typeof inputSchema>>
// 为向后兼容，将 SpawnTeamOutput 导出为 Output
export type Output = SpawnTeamOutput

// ─── 名称规范化工具 ────────────────────────────────────────────────────────────

/**
 * 将名称规范化，使其适用于 tmux 窗口名、worktree 路径和文件路径。
 * 将所有非字母数字字符替换为连字符并转换为小写。
 *
 * @param name - 原始名称
 * @returns 规范化后的名称
 */
export function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase()
}

/**
 * 将 Agent 名称规范化，使其适用于确定性 Agent ID。
 * 将 @ 符号替换为连字符，避免 "agentName@teamName" 格式产生歧义。
 *
 * @param name - 原始 Agent 名称
 * @returns 规范化后的 Agent 名称
 */
export function sanitizeAgentName(name: string): string {
  return name.replace(/@/g, '-')
}

// ─── 路径计算 ──────────────────────────────────────────────────────────────────

/**
 * 获取指定团队的目录路径（~/.claude/teams/{sanitized-name}/）。
 *
 * @param teamName - 团队名称
 * @returns 团队目录的绝对路径
 */
export function getTeamDir(teamName: string): string {
  return join(getTeamsDir(), sanitizeName(teamName))
}

/**
 * 获取指定团队配置文件的路径（~/.claude/teams/{sanitized-name}/config.json）。
 *
 * @param teamName - 团队名称
 * @returns 团队配置文件的绝对路径
 */
export function getTeamFilePath(teamName: string): string {
  return join(getTeamDir(teamName), 'config.json')
}

// ─── 团队文件读写 ──────────────────────────────────────────────────────────────

/**
 * 同步读取团队配置文件（适用于 React 渲染路径等同步上下文）。
 *
 * 流程：读取文件内容 → JSON 解析 → 返回 TeamFile 对象；
 *       文件不存在（ENOENT）时静默返回 null；其他错误记录日志后返回 null。
 *
 * @internal 由团队发现 UI 导出使用
 * @param teamName - 团队名称
 * @returns TeamFile 对象，文件不存在或读取失败时返回 null
 */
// sync IO: called from sync context
export function readTeamFile(teamName: string): TeamFile | null {
  try {
    const content = readFileSync(getTeamFilePath(teamName), 'utf-8')
    return jsonParse(content) as TeamFile
  } catch (e) {
    // 文件不存在是正常情况（如团队尚未创建），静默返回 null
    if (getErrnoCode(e) === 'ENOENT') return null
    logForDebugging(
      `[TeammateTool] Failed to read team file for ${teamName}: ${errorMessage(e)}`,
    )
    return null
  }
}

/**
 * 异步读取团队配置文件（适用于工具处理器等异步上下文）。
 *
 * @param teamName - 团队名称
 * @returns Promise<TeamFile | null>，文件不存在或读取失败时 resolve null
 */
export async function readTeamFileAsync(
  teamName: string,
): Promise<TeamFile | null> {
  try {
    const content = await readFile(getTeamFilePath(teamName), 'utf-8')
    return jsonParse(content) as TeamFile
  } catch (e) {
    if (getErrnoCode(e) === 'ENOENT') return null
    logForDebugging(
      `[TeammateTool] Failed to read team file for ${teamName}: ${errorMessage(e)}`,
    )
    return null
  }
}

/**
 * 同步写入团队配置文件（适用于同步上下文）。
 * 确保目录存在后将 TeamFile 对象序列化为格式化 JSON 写入磁盘。
 *
 * @param teamName - 团队名称
 * @param teamFile - 要写入的 TeamFile 对象
 */
// sync IO: called from sync context
function writeTeamFile(teamName: string, teamFile: TeamFile): void {
  const teamDir = getTeamDir(teamName)
  // 递归创建目录（如不存在）
  mkdirSync(teamDir, { recursive: true })
  writeFileSync(getTeamFilePath(teamName), jsonStringify(teamFile, null, 2))
}

/**
 * 异步写入团队配置文件（适用于工具处理器）。
 *
 * @param teamName - 团队名称
 * @param teamFile - 要写入的 TeamFile 对象
 */
export async function writeTeamFileAsync(
  teamName: string,
  teamFile: TeamFile,
): Promise<void> {
  const teamDir = getTeamDir(teamName)
  await mkdir(teamDir, { recursive: true })
  await writeFile(getTeamFilePath(teamName), jsonStringify(teamFile, null, 2))
}

// ─── 成员管理 ──────────────────────────────────────────────────────────────────

/**
 * 根据 agentId 或 name 从团队配置文件中移除成员。
 * 由 Leader 在处理关机批准时调用。
 *
 * 流程：读取团队文件 → 过滤掉匹配的成员 → 写回磁盘。
 *
 * @param teamName   - 团队名称
 * @param identifier - 标识符（agentId 或 name 二选一）
 * @returns 若成功移除则返回 true，成员不存在或团队不存在则返回 false
 */
export function removeTeammateFromTeamFile(
  teamName: string,
  identifier: { agentId?: string; name?: string },
): boolean {
  // 必须提供至少一种标识符
  const identifierStr = identifier.agentId || identifier.name
  if (!identifierStr) {
    logForDebugging(
      '[TeammateTool] removeTeammateFromTeamFile called with no identifier',
    )
    return false
  }

  const teamFile = readTeamFile(teamName)
  if (!teamFile) {
    logForDebugging(
      `[TeammateTool] Cannot remove teammate ${identifierStr}: failed to read team file for "${teamName}"`,
    )
    return false
  }

  const originalLength = teamFile.members.length
  // 过滤掉所有与标识符匹配的成员
  teamFile.members = teamFile.members.filter(m => {
    if (identifier.agentId && m.agentId === identifier.agentId) return false
    if (identifier.name && m.name === identifier.name) return false
    return true
  })

  // 若长度未变，说明未找到该成员
  if (teamFile.members.length === originalLength) {
    logForDebugging(
      `[TeammateTool] Teammate ${identifierStr} not found in team file for "${teamName}"`,
    )
    return false
  }

  writeTeamFile(teamName, teamFile)
  logForDebugging(
    `[TeammateTool] Removed teammate from team file: ${identifierStr}`,
  )
  return true
}

// ─── 隐藏面板管理 ──────────────────────────────────────────────────────────────

/**
 * 将 Pane ID 添加到团队配置文件的隐藏列表中。
 * 用于在 UI 中隐藏指定的 Teammate 面板。
 *
 * @param teamName - 团队名称
 * @param paneId   - 要隐藏的 Pane ID
 * @returns 若成功添加则返回 true，团队不存在则返回 false
 */
export function addHiddenPaneId(teamName: string, paneId: string): boolean {
  const teamFile = readTeamFile(teamName)
  if (!teamFile) {
    return false
  }

  const hiddenPaneIds = teamFile.hiddenPaneIds ?? []
  // 避免重复添加
  if (!hiddenPaneIds.includes(paneId)) {
    hiddenPaneIds.push(paneId)
    teamFile.hiddenPaneIds = hiddenPaneIds
    writeTeamFile(teamName, teamFile)
    logForDebugging(
      `[TeammateTool] Added ${paneId} to hidden panes for team ${teamName}`,
    )
  }
  return true
}

/**
 * 从团队配置文件的隐藏列表中移除 Pane ID（使面板重新可见）。
 *
 * @param teamName - 团队名称
 * @param paneId   - 要显示（从隐藏列表移除）的 Pane ID
 * @returns 若成功移除则返回 true，团队不存在则返回 false
 */
export function removeHiddenPaneId(teamName: string, paneId: string): boolean {
  const teamFile = readTeamFile(teamName)
  if (!teamFile) {
    return false
  }

  const hiddenPaneIds = teamFile.hiddenPaneIds ?? []
  const index = hiddenPaneIds.indexOf(paneId)
  if (index !== -1) {
    hiddenPaneIds.splice(index, 1)
    teamFile.hiddenPaneIds = hiddenPaneIds
    writeTeamFile(teamName, teamFile)
    logForDebugging(
      `[TeammateTool] Removed ${paneId} from hidden panes for team ${teamName}`,
    )
  }
  return true
}

/**
 * 根据 tmux Pane ID 从团队配置文件中移除成员。
 * 同时从 hiddenPaneIds 列表中移除（若存在）。
 * 适用于 pane-backed 类型的 Teammate（tmux/iTerm2）。
 *
 * @param teamName   - 团队名称
 * @param tmuxPaneId - 要移除成员的 Pane ID
 * @returns 若成功移除则返回 true，成员或团队不存在则返回 false
 */
export function removeMemberFromTeam(
  teamName: string,
  tmuxPaneId: string,
): boolean {
  const teamFile = readTeamFile(teamName)
  if (!teamFile) {
    return false
  }

  const memberIndex = teamFile.members.findIndex(
    m => m.tmuxPaneId === tmuxPaneId,
  )
  if (memberIndex === -1) {
    return false
  }

  // 从成员数组中删除该成员
  teamFile.members.splice(memberIndex, 1)

  // 同步从隐藏面板列表中移除
  if (teamFile.hiddenPaneIds) {
    const hiddenIndex = teamFile.hiddenPaneIds.indexOf(tmuxPaneId)
    if (hiddenIndex !== -1) {
      teamFile.hiddenPaneIds.splice(hiddenIndex, 1)
    }
  }

  writeTeamFile(teamName, teamFile)
  logForDebugging(
    `[TeammateTool] Removed member with pane ${tmuxPaneId} from team ${teamName}`,
  )
  return true
}

/**
 * 根据 Agent ID 从团队配置文件中移除成员。
 * 适用于进程内 Teammate（所有进程内 Teammate 共享同一个 tmuxPaneId，无法按 pane 区分）。
 *
 * @param teamName - 团队名称
 * @param agentId  - 要移除成员的 Agent ID（例如 "researcher@my-team"）
 * @returns 若成功移除则返回 true，成员或团队不存在则返回 false
 */
export function removeMemberByAgentId(
  teamName: string,
  agentId: string,
): boolean {
  const teamFile = readTeamFile(teamName)
  if (!teamFile) {
    return false
  }

  const memberIndex = teamFile.members.findIndex(m => m.agentId === agentId)
  if (memberIndex === -1) {
    return false
  }

  // 从成员数组中删除该成员
  teamFile.members.splice(memberIndex, 1)

  writeTeamFile(teamName, teamFile)
  logForDebugging(
    `[TeammateTool] Removed member ${agentId} from team ${teamName}`,
  )
  return true
}

// ─── 成员状态更新 ──────────────────────────────────────────────────────────────

/**
 * 设置指定团队成员的权限模式。
 * 由 Leader 通过 TeamsDialog 更改 Teammate 模式时调用。
 *
 * 流程：读取团队文件 → 查找成员 → 若模式发生变化则更新并写回磁盘。
 *
 * @param teamName   - 团队名称
 * @param memberName - 要更新的成员名称
 * @param mode       - 新的权限模式
 * @returns 更新成功返回 true，失败（团队或成员不存在）返回 false
 */
export function setMemberMode(
  teamName: string,
  memberName: string,
  mode: PermissionMode,
): boolean {
  const teamFile = readTeamFile(teamName)
  if (!teamFile) {
    return false
  }

  const member = teamFile.members.find(m => m.name === memberName)
  if (!member) {
    logForDebugging(
      `[TeammateTool] Cannot set member mode: member ${memberName} not found in team ${teamName}`,
    )
    return false
  }

  // 只有在值确实发生变化时才写磁盘（避免无效 I/O）
  if (member.mode === mode) {
    return true
  }

  // 不可变地更新 members 数组
  const updatedMembers = teamFile.members.map(m =>
    m.name === memberName ? { ...m, mode } : m,
  )
  writeTeamFile(teamName, { ...teamFile, members: updatedMembers })
  logForDebugging(
    `[TeammateTool] Set member ${memberName} in team ${teamName} to mode: ${mode}`,
  )
  return true
}

/**
 * 将当前 Teammate 的权限模式同步到 config.json，使 Leader 可以感知到变化。
 * 若当前进程不是 Teammate，则为空操作（no-op）。
 *
 * @param mode             - 要同步的权限模式
 * @param teamNameOverride - 可选的团队名覆盖（默认从环境变量读取）
 */
export function syncTeammateMode(
  mode: PermissionMode,
  teamNameOverride?: string,
): void {
  // 非 Teammate 进程直接返回
  if (!isTeammate()) return
  const teamName = teamNameOverride ?? getTeamName()
  const agentName = getAgentName()
  if (teamName && agentName) {
    setMemberMode(teamName, agentName, mode)
  }
}

/**
 * 在单个原子操作中批量更新多个成员的权限模式。
 * 避免逐个更新时产生的竞态条件问题。
 *
 * 流程：读取团队文件 → 构建更新映射 → 不可变地更新数组 → 若有变化则写回磁盘。
 *
 * @param teamName    - 团队名称
 * @param modeUpdates - 包含 {memberName, mode} 的更新列表
 * @returns 操作成功返回 true，团队不存在返回 false
 */
export function setMultipleMemberModes(
  teamName: string,
  modeUpdates: Array<{ memberName: string; mode: PermissionMode }>,
): boolean {
  const teamFile = readTeamFile(teamName)
  if (!teamFile) {
    return false
  }

  // 构建名称到模式的映射，提高查找效率
  const updateMap = new Map(modeUpdates.map(u => [u.memberName, u.mode]))

  // 不可变地更新成员数组，只修改有变化的成员
  let anyChanged = false
  const updatedMembers = teamFile.members.map(member => {
    const newMode = updateMap.get(member.name)
    if (newMode !== undefined && member.mode !== newMode) {
      anyChanged = true
      return { ...member, mode: newMode }
    }
    return member
  })

  // 只有在确实有变化时才写磁盘
  if (anyChanged) {
    writeTeamFile(teamName, { ...teamFile, members: updatedMembers })
    logForDebugging(
      `[TeammateTool] Set ${modeUpdates.length} member modes in team ${teamName}`,
    )
  }
  return true
}

/**
 * 设置团队成员的活跃状态。
 * 当 Teammate 变为空闲（isActive=false）或开始新一轮任务（isActive=true）时调用。
 *
 * 流程：异步读取团队文件 → 查找成员 → 若状态有变化则更新并写回磁盘。
 *
 * @param teamName   - 团队名称
 * @param memberName - 要更新的成员名称
 * @param isActive   - true 表示活跃，false 表示空闲
 */
export async function setMemberActive(
  teamName: string,
  memberName: string,
  isActive: boolean,
): Promise<void> {
  const teamFile = await readTeamFileAsync(teamName)
  if (!teamFile) {
    logForDebugging(
      `[TeammateTool] Cannot set member active: team ${teamName} not found`,
    )
    return
  }

  const member = teamFile.members.find(m => m.name === memberName)
  if (!member) {
    logForDebugging(
      `[TeammateTool] Cannot set member active: member ${memberName} not found in team ${teamName}`,
    )
    return
  }

  // 只有在值确实发生变化时才写磁盘
  if (member.isActive === isActive) {
    return
  }

  member.isActive = isActive
  await writeTeamFileAsync(teamName, teamFile)
  logForDebugging(
    `[TeammateTool] Set member ${memberName} in team ${teamName} to ${isActive ? 'active' : 'idle'}`,
  )
}

// ─── Git Worktree 管理 ─────────────────────────────────────────────────────────

/**
 * 销毁指定路径的 Git worktree。
 *
 * 流程：
 *   1. 读取 worktree 内的 .git 文件，解析主仓库路径；
 *   2. 尝试使用 `git worktree remove --force` 命令清理（这是首选方式）；
 *   3. 若 git 命令失败（但不是"已移除"错误），回退到 `rm -rf` 手动删除；
 *   4. 所有错误均记录日志但不抛出（best-effort）。
 *
 * @param worktreePath - 要销毁的 worktree 绝对路径
 */
async function destroyWorktree(worktreePath: string): Promise<void> {
  // 读取 .git 文件以定位主仓库（用于执行 git worktree remove）
  const gitFilePath = join(worktreePath, '.git')
  let mainRepoPath: string | null = null

  try {
    const gitFileContent = (await readFile(gitFilePath, 'utf-8')).trim()
    // .git 文件内容格式：gitdir: /path/to/repo/.git/worktrees/worktree-name
    const match = gitFileContent.match(/^gitdir:\s*(.+)$/)
    if (match && match[1]) {
      // 从 .git/worktrees/name 向上两级找到 .git，再向上一级找到主仓库根目录
      const worktreeGitDir = match[1]
      const mainGitDir = join(worktreeGitDir, '..', '..')
      mainRepoPath = join(mainGitDir, '..')
    }
  } catch {
    // 忽略读取 .git 文件的错误（路径不存在、不是文件等均属正常情况）
  }

  // 优先使用 git worktree remove 命令清理
  if (mainRepoPath) {
    const result = await execFileNoThrowWithCwd(
      gitExe(),
      ['worktree', 'remove', '--force', worktreePath],
      { cwd: mainRepoPath },
    )

    if (result.code === 0) {
      logForDebugging(
        `[TeammateTool] Removed worktree via git: ${worktreePath}`,
      )
      return
    }

    // 若错误为"not a working tree"，说明已经被移除，直接返回
    if (result.stderr?.includes('not a working tree')) {
      logForDebugging(
        `[TeammateTool] Worktree already removed: ${worktreePath}`,
      )
      return
    }

    logForDebugging(
      `[TeammateTool] git worktree remove failed, falling back to rm: ${result.stderr}`,
    )
  }

  // 回退方案：直接递归删除目录
  try {
    await rm(worktreePath, { recursive: true, force: true })
    logForDebugging(
      `[TeammateTool] Removed worktree directory manually: ${worktreePath}`,
    )
  } catch (error) {
    logForDebugging(
      `[TeammateTool] Failed to remove worktree ${worktreePath}: ${errorMessage(error)}`,
    )
  }
}

// ─── 会话级团队清理 ────────────────────────────────────────────────────────────

/**
 * 将团队标记为本会话创建，以便在进程退出时自动清理。
 * 应在初始 writeTeamFile 后立即调用。
 *
 * 注意：TeamDeleteTool 应调用 unregisterTeamForSessionCleanup 以避免重复清理。
 * 内部 Set 存储在 bootstrap/state.ts 中，由 resetStateForTests() 在测试间清空。
 *
 * @param teamName - 需要注册的团队名称
 */
export function registerTeamForSessionCleanup(teamName: string): void {
  getSessionCreatedTeams().add(teamName)
}

/**
 * 从会话清理追踪列表中移除团队（例如在显式 TeamDelete 后调用）。
 * 避免在进程退出时重复清理已显式删除的团队。
 *
 * @param teamName - 需要取消注册的团队名称
 */
export function unregisterTeamForSessionCleanup(teamName: string): void {
  getSessionCreatedTeams().delete(teamName)
}

/**
 * 清理本会话创建的所有未显式删除的团队。
 * 由 init.ts 注册为 gracefulShutdown 钩子，在进程退出时执行。
 *
 * 流程：
 *   1. 获取会话创建团队集合，若为空则直接返回；
 *   2. 先终止所有孤立的 pane-backed Teammate 进程（防止僵尸进程）；
 *   3. 再删除团队目录和任务目录；
 *   4. 清空会话创建团队集合。
 */
export async function cleanupSessionTeams(): Promise<void> {
  const sessionCreatedTeams = getSessionCreatedTeams()
  if (sessionCreatedTeams.size === 0) return
  const teams = Array.from(sessionCreatedTeams)
  logForDebugging(
    `cleanupSessionTeams: removing ${teams.length} orphan team dir(s): ${teams.join(', ')}`,
  )
  // 先终止 Pane — 在 SIGINT 时 Teammate 进程仍在运行；
  // 仅删除目录会导致它们以孤立状态留在 tmux/iTerm2 面板中。
  // （TeamDeleteTool 路径不需要此步骤 — 彼时 Teammate 已优雅退出，
  //   useInboxPoller 已关闭其面板。）
  await Promise.allSettled(teams.map(name => killOrphanedTeammatePanes(name)))
  await Promise.allSettled(teams.map(name => cleanupTeamDirectories(name)))
  sessionCreatedTeams.clear()
}

/**
 * 尽力终止团队中所有 pane-backed Teammate 的面板。
 * 在 Leader 非正常退出（SIGINT/SIGTERM）时由 cleanupSessionTeams 调用。
 *
 * 使用动态 import 避免将 backend 注册/检测模块加入静态依赖图
 * （该函数仅在关闭时运行，import 开销无关紧要）。
 *
 * @param teamName - 团队名称
 */
async function killOrphanedTeammatePanes(teamName: string): Promise<void> {
  const teamFile = readTeamFile(teamName)
  if (!teamFile) return

  // 筛选出需要终止的 pane-backed 成员（排除 Leader，且必须有 backendType 和 paneId）
  const paneMembers = teamFile.members.filter(
    m =>
      m.name !== TEAM_LEAD_NAME &&
      m.tmuxPaneId &&
      m.backendType &&
      isPaneBackend(m.backendType),
  )
  if (paneMembers.length === 0) return

  // 动态导入 backend 注册表和检测模块
  const [{ ensureBackendsRegistered, getBackendByType }, { isInsideTmux }] =
    await Promise.all([
      import('./backends/registry.js'),
      import('./backends/detection.js'),
    ])
  await ensureBackendsRegistered()
  // 若不在 tmux 内部，使用外部会话模式终止面板
  const useExternalSession = !(await isInsideTmux())

  await Promise.allSettled(
    paneMembers.map(async m => {
      // 上方 filter 已保证这些字段存在；此处是为了类型系统收窄
      if (!m.tmuxPaneId || !m.backendType || !isPaneBackend(m.backendType)) {
        return
      }
      const ok = await getBackendByType(m.backendType).killPane(
        m.tmuxPaneId,
        useExternalSession,
      )
      logForDebugging(
        `cleanupSessionTeams: killPane ${m.name} (${m.backendType} ${m.tmuxPaneId}) → ${ok}`,
      )
    }),
  )
}

/**
 * 清理指定团队的所有磁盘资源，包括：
 *   - Git worktree 目录（逐一调用 destroyWorktree）；
 *   - 团队目录（~/.claude/teams/{team-name}/）；
 *   - 任务目录（~/.claude/tasks/{sanitized-team-name}/）。
 *
 * 在 Swarm 会话终止时调用（由 cleanupSessionTeams 或 TeamDeleteTool 触发）。
 *
 * @param teamName - 要清理的团队名称
 */
export async function cleanupTeamDirectories(teamName: string): Promise<void> {
  const sanitizedName = sanitizeName(teamName)

  // 在删除团队目录前先读取 worktree 路径列表
  const teamFile = readTeamFile(teamName)
  const worktreePaths: string[] = []
  if (teamFile) {
    for (const member of teamFile.members) {
      if (member.worktreePath) {
        worktreePaths.push(member.worktreePath)
      }
    }
  }

  // 先清理所有 worktree（顺序执行以避免 git 锁冲突）
  for (const worktreePath of worktreePaths) {
    await destroyWorktree(worktreePath)
  }

  // 清理团队目录（~/.claude/teams/{team-name}/）
  const teamDir = getTeamDir(teamName)
  try {
    await rm(teamDir, { recursive: true, force: true })
    logForDebugging(`[TeammateTool] Cleaned up team directory: ${teamDir}`)
  } catch (error) {
    logForDebugging(
      `[TeammateTool] Failed to clean up team directory ${teamDir}: ${errorMessage(error)}`,
    )
  }

  // 清理任务目录（~/.claude/tasks/{taskListId}/）
  // Leader 和所有 Teammate 都将任务存储在以规范化团队名命名的目录下
  const tasksDir = getTasksDir(sanitizedName)
  try {
    await rm(tasksDir, { recursive: true, force: true })
    logForDebugging(`[TeammateTool] Cleaned up tasks directory: ${tasksDir}`)
    // 通知任务系统目录已更新，触发 UI 刷新
    notifyTasksUpdated()
  } catch (error) {
    logForDebugging(
      `[TeammateTool] Failed to clean up tasks directory ${tasksDir}: ${errorMessage(error)}`,
    )
  }
}
