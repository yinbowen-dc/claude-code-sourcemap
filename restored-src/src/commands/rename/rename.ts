/**
 * rename 命令核心实现（commands/rename/rename.ts）
 *
 * 本文件实现 /rename 命令的完整业务逻辑，负责将当前会话重命名并多路持久化：
 *   1. 写入本地文件系统（transcript 路径下的自定义标题文件）；
 *   2. 异步同步到 claude.ai/code 的 Bridge 远端会话（best-effort，不阻塞主流程）；
 *   3. 更新内存中的 agentName，使提示栏实时刷新显示。
 *
 * 在 Claude Code 整体流程中，本文件处于"命令执行层"：
 *   用户输入 /rename [name] → index.ts 注册项 → 本文件 call() → 存储层 + 远端同步。
 */

import type { UUID } from 'crypto'
import { getSessionId } from '../../bootstrap/state.js'
import {
  getBridgeBaseUrlOverride,
  getBridgeTokenOverride,
} from '../../bridge/bridgeConfig.js'
import type { ToolUseContext } from '../../Tool.js'
import type {
  LocalJSXCommandContext,
  LocalJSXCommandOnDone,
} from '../../types/command.js'
import { getMessagesAfterCompactBoundary } from '../../utils/messages.js'
import {
  getTranscriptPath,
  saveAgentName,
  saveCustomTitle,
} from '../../utils/sessionStorage.js'
import { isTeammate } from '../../utils/teammate.js'
import { generateSessionName } from './generateSessionName.js'

/**
 * /rename 命令的主执行函数。
 *
 * 执行流程：
 *   1. 检查是否为 swarm 子节点（teammate），子节点禁止自主重命名；
 *   2. 若用户未提供 args，则从对话上下文自动生成会话名称；
 *   3. 将新名称保存为自定义标题（本地持久化）；
 *   4. 若存在 Bridge 会话 ID，异步将标题同步到远端（fire-and-forget）；
 *   5. 将新名称保存为 agentName，并更新 React 应用状态以刷新 UI。
 *
 * @param onDone   命令完成后的回调，用于向会话注入系统提示消息
 * @param context  工具调用上下文，包含消息历史、应用状态及终止信号
 * @param args     用户传入的参数（即期望的新名称），可为空
 */
export async function call(
  onDone: LocalJSXCommandOnDone,
  context: ToolUseContext & LocalJSXCommandContext,
  args: string,
): Promise<null> {
  // 禁止 swarm 子节点自行重命名——其名称由主节点（team leader）统一管控
  if (isTeammate()) {
    onDone(
      'Cannot rename: This session is a swarm teammate. Teammate names are set by the team leader.',
      { display: 'system' },
    )
    return null
  }

  let newName: string
  if (!args || args.trim() === '') {
    // 未提供名称时，基于 compact 边界之后的消息内容自动生成会话名
    const generated = await generateSessionName(
      getMessagesAfterCompactBoundary(context.messages),
      context.abortController.signal,
    )
    if (!generated) {
      // 对话内容为空，无法推断名称，提示用户手动传参
      onDone(
        'Could not generate a name: no conversation context yet. Usage: /rename <name>',
        { display: 'system' },
      )
      return null
    }
    newName = generated
  } else {
    // 用户显式传参，直接使用（去除首尾空白）
    newName = args.trim()
  }

  const sessionId = getSessionId() as UUID
  const fullPath = getTranscriptPath()

  // Always save the custom title (session name)
  // 将自定义标题写入本地 transcript 存储，作为会话的持久化名称
  await saveCustomTitle(sessionId, newName, fullPath)

  // Sync title to bridge session on claude.ai/code (best-effort, non-blocking).
  // v2 env-less bridge stores cse_* in replBridgeSessionId —
  // updateBridgeSessionTitle retags internally for the compat endpoint.
  // 如果当前会话已与 Bridge 远端绑定，则异步同步标题（失败静默丢弃，不影响主流程）
  const appState = context.getAppState()
  const bridgeSessionId = appState.replBridgeSessionId
  if (bridgeSessionId) {
    const tokenOverride = getBridgeTokenOverride()
    // 动态导入 Bridge 模块，避免非 Bridge 场景下的冗余加载
    void import('../../bridge/createSession.js').then(
      ({ updateBridgeSessionTitle }) =>
        updateBridgeSessionTitle(bridgeSessionId, newName, {
          baseUrl: getBridgeBaseUrlOverride(),
          getAccessToken: tokenOverride ? () => tokenOverride : undefined,
        }).catch(() => {}),  // 远端同步失败不上报，属于 best-effort 操作
    )
  }

  // Also persist as the session's agent name for prompt-bar display
  // 同步保存 agentName，供提示栏（prompt bar）展示当前会话名称
  await saveAgentName(sessionId, newName, fullPath)
  // 更新 React 应用状态，使 standaloneAgentContext.name 立即反映到 UI
  context.setAppState(prev => ({
    ...prev,
    standaloneAgentContext: {
      ...prev.standaloneAgentContext,
      name: newName,
    },
  }))

  onDone(`Session renamed to: ${newName}`, { display: 'system' })
  return null
}
