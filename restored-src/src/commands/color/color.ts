/**
 * /color 命令的核心实现模块。
 *
 * 在 Claude Code 的 Agent 身份管理流程中，此文件实现了会话颜色设置逻辑。
 * 用户可通过 /color <颜色名> 为当前会话的提示栏设置颜色标识，
 * 便于在多 Agent（Swarm）场景下区分不同 Agent。
 *
 * 核心约束：
 * - Swarm 队员（teammate）不允许自行设置颜色，颜色由队长分配
 * - 仅 AGENT_COLORS 中的颜色名有效，reset/default/gray/grey 等别名用于还原为默认
 * - 颜色设置同时持久化到转录文件（跨会话恢复）和 AppState（即时生效）
 */
import type { UUID } from 'crypto'
import { getSessionId } from '../../bootstrap/state.js'
import type { ToolUseContext } from '../../Tool.js'
import {
  AGENT_COLORS,
  type AgentColorName,
} from '../../tools/AgentTool/agentColorManager.js'
import type {
  LocalJSXCommandContext,
  LocalJSXCommandOnDone,
} from '../../types/command.js'
import {
  getTranscriptPath,
  saveAgentColor,
} from '../../utils/sessionStorage.js'
import { isTeammate } from '../../utils/teammate.js'

// 所有用于重置颜色为默认灰色的用户可输入别名
const RESET_ALIASES = ['default', 'reset', 'none', 'gray', 'grey'] as const

/**
 * /color 命令的执行函数。
 *
 * 处理三种情况：
 * 1. Swarm 队员调用：拒绝并给出说明
 * 2. 参数为重置别名（default/reset/gray/grey 等）：还原为默认颜色（写入 'default' 哨值）
 * 3. 有效颜色名：持久化到转录文件并更新 AppState 即时生效
 *
 * @param onDone 向 UI 注入系统消息的回调
 * @param context 命令执行上下文，含 AppState 读写能力
 * @param args 用户传入的颜色名称参数
 */
export async function call(
  onDone: LocalJSXCommandOnDone,
  context: ToolUseContext & LocalJSXCommandContext,
  args: string,
): Promise<null> {
  // Swarm 队员不能自行设置颜色，颜色由队长统一分配
  if (isTeammate()) {
    onDone(
      'Cannot set color: This session is a swarm teammate. Teammate colors are assigned by the team leader.',
      { display: 'system' },
    )
    return null
  }

  if (!args || args.trim() === '') {
    const colorList = AGENT_COLORS.join(', ')
    onDone(`Please provide a color. Available colors: ${colorList}, default`, {
      display: 'system',
    })
    return null
  }

  const colorArg = args.trim().toLowerCase()

  // 处理重置为默认颜色（灰色）的情况
  if (RESET_ALIASES.includes(colorArg as (typeof RESET_ALIASES)[number])) {
    const sessionId = getSessionId() as UUID
    const fullPath = getTranscriptPath()

    // 使用 "default" 哨值（而非空字符串），使 sessionStorage.ts 中的真值检查
    // 能在会话重启后正确持久化重置状态
    await saveAgentColor(sessionId, 'default', fullPath)

    context.setAppState(prev => ({
      ...prev,
      standaloneAgentContext: {
        ...prev.standaloneAgentContext,
        name: prev.standaloneAgentContext?.name ?? '',
        color: undefined,
      },
    }))

    onDone('Session color reset to default', { display: 'system' })
    return null
  }

  if (!AGENT_COLORS.includes(colorArg as AgentColorName)) {
    const colorList = AGENT_COLORS.join(', ')
    onDone(
      `Invalid color "${colorArg}". Available colors: ${colorList}, default`,
      { display: 'system' },
    )
    return null
  }

  const sessionId = getSessionId() as UUID
  const fullPath = getTranscriptPath()

  // 将颜色持久化到转录文件，确保 --resume 时能恢复颜色设置
  await saveAgentColor(sessionId, colorArg, fullPath)

  // 更新 AppState，使颜色变更立即反映在 UI 提示栏上
  context.setAppState(prev => ({
    ...prev,
    standaloneAgentContext: {
      ...prev.standaloneAgentContext,
      name: prev.standaloneAgentContext?.name ?? '',
      color: colorArg as AgentColorName,
    },
  }))

  onDone(`Session color set to: ${colorArg}`, { display: 'system' })
  return null
}
