/**
 * Swarm 重连模块（reconnection.ts）
 *
 * 【在 Claude Code 系统流程中的位置】
 * 本模块处于 Swarm 多智能体系统的初始化阶段，位于 main.tsx 启动流程之中。
 * 它负责在渲染前同步计算团队上下文（teamContext），确保首次渲染时 AppState
 * 中已包含完整的团队信息，从而避免 useEffect 延迟初始化带来的闪烁或竞态问题。
 *
 * 【主要职责】
 * 1. 新会话（fresh spawn）：从 CLI 参数（由 main.tsx 通过 dynamicTeamContext 设置）
 *    读取团队信息，同步构建初始 teamContext。
 * 2. 恢复会话（resumed session）：从历史记录（transcript）中保存的
 *    teamName / agentName 恢复团队上下文，重建心跳和 Swarm 功能所需的状态。
 */

import type { AppState } from '../../state/AppState.js'
import { logForDebugging } from '../debug.js'
import { logError } from '../log.js'
import { getDynamicTeamContext } from '../teammate.js'
import { getTeamFilePath, readTeamFile } from './teamHelpers.js'

/**
 * 在首次渲染前同步计算 AppState 的初始 teamContext。
 *
 * 【调用时机】
 * 由 main.tsx 在构建 initialState 时同步调用，避免使用 useEffect 进行异步初始化。
 *
 * 【执行流程】
 * 1. 调用 getDynamicTeamContext() 获取由 CLI 参数注入的团队上下文；
 * 2. 若上下文缺失（非 teammate 模式），直接返回 undefined；
 * 3. 读取团队配置文件（config.json）以获取 leadAgentId；
 * 4. 根据是否存在 agentId 判断当前实例是否为 Leader；
 * 5. 构造并返回完整的 teamContext 对象。
 *
 * @returns 若为 teammate 则返回 teamContext 对象，否则返回 undefined
 */
export function computeInitialTeamContext():
  | AppState['teamContext']
  | undefined {
  // dynamicTeamContext 由 main.tsx 从 CLI 参数中注入
  const context = getDynamicTeamContext()

  // 若无团队上下文（不是 teammate），则直接返回 undefined
  if (!context?.teamName || !context?.agentName) {
    logForDebugging(
      '[Reconnection] computeInitialTeamContext: No teammate context set (not a teammate)',
    )
    return undefined
  }

  // 从上下文中解构团队名称、智能体 ID 和名称
  const { teamName, agentId, agentName } = context

  // 读取团队文件以获取 Leader 的 agentId
  const teamFile = readTeamFile(teamName)
  if (!teamFile) {
    // 若团队文件不存在，记录错误并返回 undefined
    logError(
      new Error(
        `[computeInitialTeamContext] Could not read team file for ${teamName}`,
      ),
    )
    return undefined
  }

  // 获取团队配置文件的完整路径（用于后续写入更新）
  const teamFilePath = getTeamFilePath(teamName)

  // 若没有 agentId，则当前实例为 Leader
  const isLeader = !agentId

  logForDebugging(
    `[Reconnection] Computed initial team context for ${isLeader ? 'leader' : `teammate ${agentName}`} in team ${teamName}`,
  )

  // 返回完整的 teamContext 对象，teammates 初始化为空对象待后续填充
  return {
    teamName,
    teamFilePath,
    leadAgentId: teamFile.leadAgentId,
    selfAgentId: agentId,
    selfAgentName: agentName,
    isLeader,
    teammates: {},
  }
}

/**
 * 从已恢复的历史会话中初始化 teammate 的团队上下文。
 *
 * 【调用时机】
 * 当 Claude Code 恢复一个在 transcript 中已记录了 teamName / agentName 的历史会话时调用，
 * 确保心跳（heartbeat）和其他 Swarm 功能在会话恢复后能正确运行。
 *
 * 【执行流程】
 * 1. 读取团队配置文件，获取 leadAgentId；
 * 2. 在成员列表中查找当前 agentName 对应的成员，取得其 agentId；
 * 3. 通过 setAppState 更新 AppState 中的 teamContext；
 * 4. 打印调试日志确认初始化完成。
 *
 * @param setAppState - AppState 的 updater 函数，用于更新全局状态
 * @param teamName    - 从 transcript 中读取的团队名称
 * @param agentName   - 从 transcript 中读取的智能体名称
 */
export function initializeTeammateContextFromSession(
  setAppState: (updater: (prev: AppState) => AppState) => void,
  teamName: string,
  agentName: string,
): void {
  // 读取团队文件以获取 Leader 的 agentId
  const teamFile = readTeamFile(teamName)
  if (!teamFile) {
    // 若团队文件不存在，记录错误并提前返回
    logError(
      new Error(
        `[initializeTeammateContextFromSession] Could not read team file for ${teamName} (agent: ${agentName})`,
      ),
    )
    return
  }

  // 在成员列表中查找与 agentName 匹配的成员记录，以获取其 agentId
  const member = teamFile.members.find(m => m.name === agentName)
  if (!member) {
    // 若成员不在团队文件中（例如已被移除），记录调试信息但不阻断流程
    logForDebugging(
      `[Reconnection] Member ${agentName} not found in team ${teamName} - may have been removed`,
    )
  }
  const agentId = member?.agentId

  // 获取团队配置文件路径
  const teamFilePath = getTeamFilePath(teamName)

  // 通过 setAppState 将 teamContext 注入全局状态
  setAppState(prev => ({
    ...prev,
    teamContext: {
      teamName,
      teamFilePath,
      leadAgentId: teamFile.leadAgentId,
      selfAgentId: agentId,
      selfAgentName: agentName,
      // 恢复的会话始终为非 Leader（Leader 由 computeInitialTeamContext 处理）
      isLeader: false,
      teammates: {},
    },
  }))

  logForDebugging(
    `[Reconnection] Initialized agent context from session for ${agentName} in team ${teamName}`,
  )
}
