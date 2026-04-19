/**
 * Swarm Teammate 初始化模块（teammateInit.ts）
 *
 * 【在 Claude Code 系统流程中的位置】
 * 本模块处于 Swarm 多智能体系统的 Teammate 启动阶段，在每个 Teammate
 * 实例的会话初始化过程中被调用（由 session 启动代码在 AppState 可用后调用）。
 * 它负责注册 Stop 钩子（Hook），在 Teammate 停止时向 Leader 发送空闲通知，
 * 并将团队共享的允许路径（teamAllowedPaths）注入到当前会话的权限上下文中。
 *
 * 【主要职责】
 * 1. 读取团队配置文件，获取 Leader 信息和团队共享权限路径；
 * 2. 将团队允许路径注入到 toolPermissionContext（session 级别规则）；
 * 3. 注册 Stop 钩子：Teammate 停止时标记为 idle 并向 Leader 发送空闲通知。
 */

import type { AppState } from '../../state/AppState.js'
import { logForDebugging } from '../debug.js'
import { addFunctionHook } from '../hooks/sessionHooks.js'
import { applyPermissionUpdate } from '../permissions/PermissionUpdate.js'
import { jsonStringify } from '../slowOperations.js'
import { getTeammateColor } from '../teammate.js'
import {
  createIdleNotification,
  getLastPeerDmSummary,
  writeToMailbox,
} from '../teammateMailbox.js'
import { readTeamFile, setMemberActive } from './teamHelpers.js'

/**
 * 为以 Teammate 身份运行的 Claude Code 实例初始化 Swarm 相关钩子。
 *
 * 【调用时机】
 * 在会话启动的早期、AppState 可用之后调用，确保 Stop 钩子在 Teammate
 * 完成任务并退出时能够可靠地触发通知。
 *
 * 【执行流程】
 * 1. 读取团队配置文件，若文件不存在则提前返回；
 * 2. 提取 leadAgentId 并查找 Leader 的名称；
 * 3. 遍历团队共享允许路径（teamAllowedPaths），为每条路径生成规则内容
 *    并通过 setAppState 注入到 toolPermissionContext（session 级别）；
 * 4. 若当前实例本身就是 Leader，跳过 Stop 钩子注册（避免循环通知）；
 * 5. 为非 Leader Teammate 注册 Stop 钩子：
 *    a. 将该 Teammate 在团队文件中标记为非活跃（fire-and-forget）；
 *    b. 构建空闲通知并写入 Leader 的邮箱，等待写入完成再退出；
 *    c. 返回 true 表示不阻塞 Stop 流程。
 *
 * @param setAppState - AppState 的 updater 函数，用于注入权限规则
 * @param sessionId   - 当前会话 ID，用于注册 Stop 钩子
 * @param teamInfo    - 当前 Teammate 的团队信息（teamName / agentId / agentName）
 */
export function initializeTeammateHooks(
  setAppState: (updater: (prev: AppState) => AppState) => void,
  sessionId: string,
  teamInfo: { teamName: string; agentId: string; agentName: string },
): void {
  const { teamName, agentId, agentName } = teamInfo

  // 读取团队配置文件以获取 Leader 信息和共享权限路径
  const teamFile = readTeamFile(teamName)
  if (!teamFile) {
    // 若团队文件不存在（例如团队已被解散），则跳过初始化
    logForDebugging(`[TeammateInit] Team file not found for team: ${teamName}`)
    return
  }

  const leadAgentId = teamFile.leadAgentId

  // 若团队文件中包含共享的允许路径，注入到当前会话的权限上下文
  if (teamFile.teamAllowedPaths && teamFile.teamAllowedPaths.length > 0) {
    logForDebugging(
      `[TeammateInit] Found ${teamFile.teamAllowedPaths.length} team-wide allowed path(s)`,
    )

    for (const allowedPath of teamFile.teamAllowedPaths) {
      // 绝对路径（以 / 开头）使用 //path/** 模式，相对路径使用 path/** 模式
      // 双斜杠前缀用于区分"团队授权"和普通路径，下游解析时会做相应处理
      const ruleContent = allowedPath.path.startsWith('/')
        ? `/${allowedPath.path}/**`
        : `${allowedPath.path}/**`

      logForDebugging(
        `[TeammateInit] Applying team permission: ${allowedPath.toolName} allowed in ${allowedPath.path} (rule: ${ruleContent})`,
      )

      // 将规则追加到 session 级别的权限上下文（不影响全局配置）
      setAppState(prev => ({
        ...prev,
        toolPermissionContext: applyPermissionUpdate(
          prev.toolPermissionContext,
          {
            type: 'addRules',
            rules: [
              {
                toolName: allowedPath.toolName,
                ruleContent,
              },
            ],
            behavior: 'allow',
            destination: 'session',
          },
        ),
      }))
    }
  }

  // 在成员列表中查找 Leader 的显示名称（用于写入邮箱时寻址）
  const leadMember = teamFile.members.find(m => m.agentId === leadAgentId)
  const leadAgentName = leadMember?.name || 'team-lead'

  // 若当前实例是 Leader，不需要注册空闲通知钩子（Leader 不向自己汇报）
  if (agentId === leadAgentId) {
    logForDebugging(
      '[TeammateInit] This agent is the team leader - skipping idle notification hook',
    )
    return
  }

  logForDebugging(
    `[TeammateInit] Registering Stop hook for teammate ${agentName} to notify leader ${leadAgentName}`,
  )

  // 注册 Stop 钩子：在 Teammate 停止时向 Leader 发送空闲通知
  addFunctionHook(
    setAppState,
    sessionId,
    'Stop',
    '', // 空字符串表示匹配所有 Stop 事件（无需特定触发条件）
    async (messages, _signal) => {
      // 将该 Teammate 标记为非活跃（fire-and-forget，不阻塞退出）
      void setMemberActive(teamName, agentName, false)

      // 必须 await，确保写入完成后再退出进程（否则进程关闭会丢弃写入）
      // 使用 agentName（显示名）而非 UUID 进行邮箱寻址
      const notification = createIdleNotification(agentName, {
        idleReason: 'available',
        // 从最近消息中提取上一次点对点消息的摘要，供 Leader 了解工作进度
        summary: getLastPeerDmSummary(messages),
      })
      await writeToMailbox(leadAgentName, {
        from: agentName,
        text: jsonStringify(notification),
        timestamp: new Date().toISOString(),
        color: getTeammateColor(),
      })
      logForDebugging(
        `[TeammateInit] Sent idle notification to leader ${leadAgentName}`,
      )
      return true // 返回 true 表示不阻塞 Stop 流程，允许进程正常退出
    },
    'Failed to send idle notification to team leader',
    {
      timeout: 10000, // 最多等待 10 秒，超时后仍正常退出
    },
  )
}
