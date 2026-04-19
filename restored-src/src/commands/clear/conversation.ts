/**
 * 会话清除核心工具模块。
 *
 * 在 Claude Code 的会话生命周期管理流程中，此文件提供 clearConversation 函数，
 * 负责在 /clear 命令触发时执行完整的会话重置序列：
 *
 * 1. 执行 SessionEnd 钩子（最大 1.5s 超时）
 * 2. 向推理层发出缓存逐出提示
 * 3. 计算需保留的后台任务（isBackgrounded !== false 的任务）
 * 4. 清空消息列表
 * 5. 重置 proactive context-blocked 标志
 * 6. 更新 conversationId（触发 logo 重渲染）
 * 7. 清除所有会话缓存（保留后台任务的状态）
 * 8. 重置工作目录、文件状态、技能名称等
 * 9. 更新 AppState（终止并移除前台任务、重置 attribution/MCP/fileHistory）
 * 10. 清除计划 slug、会话元数据
 * 11. 重新生成会话 ID 并更新文件指针
 * 12. 为保留运行中的 local_agent 任务重建 TaskOutput 软链接
 * 13. 持久化模式和 worktree 状态
 * 14. 执行 SessionStart 钩子（'clear' 触发原因）
 *
 * 此模块包含较多重依赖，应在可能时通过懒加载引入。
 */
import { feature } from 'bun:bundle'
import { randomUUID, type UUID } from 'crypto'
import {
  getLastMainRequestId,
  getOriginalCwd,
  getSessionId,
  regenerateSessionId,
} from '../../bootstrap/state.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js'
import type { AppState } from '../../state/AppState.js'
import { isInProcessTeammateTask } from '../../tasks/InProcessTeammateTask/types.js'
import {
  isLocalAgentTask,
  type LocalAgentTaskState,
} from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import { isLocalShellTask } from '../../tasks/LocalShellTask/guards.js'
import { asAgentId } from '../../types/ids.js'
import type { Message } from '../../types/message.js'
import { createEmptyAttributionState } from '../../utils/commitAttribution.js'
import type { FileStateCache } from '../../utils/fileStateCache.js'
import {
  executeSessionEndHooks,
  getSessionEndHookTimeoutMs,
} from '../../utils/hooks.js'
import { logError } from '../../utils/log.js'
import { clearAllPlanSlugs } from '../../utils/plans.js'
import { setCwd } from '../../utils/Shell.js'
import { processSessionStartHooks } from '../../utils/sessionStart.js'
import {
  clearSessionMetadata,
  getAgentTranscriptPath,
  resetSessionFilePointer,
  saveWorktreeState,
} from '../../utils/sessionStorage.js'
import {
  evictTaskOutput,
  initTaskOutputAsSymlink,
} from '../../utils/task/diskOutput.js'
import { getCurrentWorktreeSession } from '../../utils/worktree.js'
import { clearSessionCaches } from './caches.js'

/**
 * 执行完整的会话清除序列。
 *
 * 按照严格的顺序协调所有清除步骤，确保 SessionEnd 钩子在清除前完成，
 * SessionStart 钩子在所有清除完成后才执行。
 * 后台任务（isBackgrounded !== false）在整个过程中保持运行状态。
 *
 * @param setMessages 用于更新消息列表的 setter，清除时传入 () => []
 * @param readFileState 文件状态缓存，清除后调用 .clear()
 * @param discoveredSkillNames 已发现的技能名称集合（可选，清除后重置）
 * @param loadedNestedMemoryPaths 已加载的嵌套 memory 路径集合（可选，清除后重置）
 * @param getAppState 读取当前 AppState 的 getter（可选）
 * @param setAppState 更新 AppState 的 setter（可选）
 * @param setConversationId 更新 conversationId 的 setter（可选，用于触发 logo 重渲染）
 */
export async function clearConversation({
  setMessages,
  readFileState,
  discoveredSkillNames,
  loadedNestedMemoryPaths,
  getAppState,
  setAppState,
  setConversationId,
}: {
  setMessages: (updater: (prev: Message[]) => Message[]) => void
  readFileState: FileStateCache
  discoveredSkillNames?: Set<string>
  loadedNestedMemoryPaths?: Set<string>
  getAppState?: () => AppState
  setAppState?: (f: (prev: AppState) => AppState) => void
  setConversationId?: (id: UUID) => void
}): Promise<void> {
  // 执行 SessionEnd 钩子，在清除前通知外部插件（受 CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS 约束，默认 1.5s）
  const sessionEndTimeoutMs = getSessionEndHookTimeoutMs()
  await executeSessionEndHooks('clear', {
    getAppState,
    setAppState,
    signal: AbortSignal.timeout(sessionEndTimeoutMs),
    timeoutMs: sessionEndTimeoutMs,
  })

  // 向推理层发出缓存逐出提示，通知服务端可以清除此会话的 prompt cache
  const lastRequestId = getLastMainRequestId()
  if (lastRequestId) {
    logEvent('tengu_cache_eviction_hint', {
      scope:
        'conversation_clear' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      last_request_id:
        lastRequestId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
  }

  // 提前计算需要保留的任务，确保其 per-agent 状态能在缓存清除后继续存活。
  // 任务默认保留，除非 isBackgrounded === false（前台任务）。
  // 主会话任务（Ctrl+B 启动）写入独立的 per-task 转录文件，在会话 ID 重新生成时安全保留。
  // 参见 LocalMainSessionTask.ts startBackgroundSession。
  const preservedAgentIds = new Set<string>()
  const preservedLocalAgents: LocalAgentTaskState[] = []
  const shouldKillTask = (task: AppState['tasks'][string]): boolean =>
    'isBackgrounded' in task && task.isBackgrounded === false
  if (getAppState) {
    for (const task of Object.values(getAppState().tasks)) {
      if (shouldKillTask(task)) continue
      if (isLocalAgentTask(task)) {
        preservedAgentIds.add(task.agentId)
        preservedLocalAgents.push(task)
      } else if (isInProcessTeammateTask(task)) {
        preservedAgentIds.add(task.identity.agentId)
      }
    }
  }

  // 清空消息列表，使 UI 立即显示空会话状态
  setMessages(() => [])

  // 清除 proactive context-blocked 标志，使 /clear 后 proactive tick 恢复运行
  if (feature('PROACTIVE') || feature('KAIROS')) {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { setContextBlocked } = require('../../proactive/index.js')
    /* eslint-enable @typescript-eslint/no-require-imports */
    setContextBlocked(false)
  }

  // 更新 conversationId 触发 logo 重渲染，给用户明确的"新会话"视觉反馈
  if (setConversationId) {
    setConversationId(randomUUID())
  }

  // 清除所有会话相关缓存，保留后台任务的 per-agent 状态（技能、权限回调、dump 状态、缓存中断追踪）
  clearSessionCaches(preservedAgentIds)

  // 恢复工作目录至原始 cwd，清除文件状态缓存和技能/memory 路径集合
  setCwd(getOriginalCwd())
  readFileState.clear()
  discoveredSkillNames?.clear()
  loadedNestedMemoryPaths?.clear()

  // 更新 AppState：清除前台任务、重置 attribution/fileHistory/MCP 状态
  if (setAppState) {
    setAppState(prev => {
      // 使用与上方相同的判断谓词对任务进行分区：前台任务终止并移除，其他任务保留
      const nextTasks: AppState['tasks'] = {}
      for (const [taskId, task] of Object.entries(prev.tasks)) {
        if (!shouldKillTask(task)) {
          nextTasks[taskId] = task
          continue
        }
        // 前台任务：终止后从状态中移除
        try {
          if (task.status === 'running') {
            if (isLocalShellTask(task)) {
              task.shellCommand?.kill()
              task.shellCommand?.cleanup()
              if (task.cleanupTimeoutId) {
                clearTimeout(task.cleanupTimeoutId)
              }
            }
            if ('abortController' in task) {
              task.abortController?.abort()
            }
            if ('unregisterCleanup' in task) {
              task.unregisterCleanup?.()
            }
          }
        } catch (error) {
          logError(error)
        }
        void evictTaskOutput(taskId)
      }

      return {
        ...prev,
        tasks: nextTasks,
        attribution: createEmptyAttributionState(),
        // 清除独立 agent 上下文（/rename、/color 设置的名称/颜色）
        // 避免新会话继续显示旧会话的身份标记
        standaloneAgentContext: undefined,
        fileHistory: {
          snapshots: [],
          trackedFiles: new Set(),
          snapshotSequence: 0,
        },
        // 重置 MCP 状态以触发重新初始化
        // 保留 pluginReconnectKey，使 /clear 不触发无效的重连操作
        // （pluginReconnectKey 仅由 /reload-plugins 递增）
        mcp: {
          clients: [],
          tools: [],
          commands: [],
          resources: {},
          pluginReconnectKey: prev.mcp.pluginReconnectKey,
        },
      }
    })
  }

  // 清除计划 slug 缓存，使 /clear 后使用新的计划文件
  clearAllPlanSlugs()

  // 清除会话元数据缓存（标题、标签、agent 名称/颜色）
  // 确保新会话不会继承旧会话的身份信息
  clearSessionMetadata()

  // 生成新的会话 ID 以提供干净状态
  // 将旧会话设为父会话，维护分析链路追踪
  regenerateSessionId({ setCurrentAsParent: true })
  // 更新环境变量，使子进程也使用新的会话 ID（仅限 Anthropic 内部员工）
  if (process.env.USER_TYPE === 'ant' && process.env.CLAUDE_CODE_SESSION_ID) {
    process.env.CLAUDE_CODE_SESSION_ID = getSessionId()
  }
  await resetSessionFilePointer()

  // 保留的 local_agent 任务的 TaskOutput 软链接在创建时指向旧会话 ID，
  // 但 /clear 后新的转录写入会落在新会话目录下（appendEntry 重新读取 getSessionId()）。
  // 重建软链接，使 TaskOutput 读取实时文件而非 /clear 前的快照。
  // 只重建仍在运行的任务：已完成的任务不会再写入，重建会导致悬空软链接。
  // 主会话任务使用相同的 per-agent 路径（通过 recordSidechainTranscript → getAgentTranscriptPath 写入），
  // 无需特殊处理。
  for (const task of preservedLocalAgents) {
    if (task.status !== 'running') continue
    void initTaskOutputAsSymlink(
      task.id,
      getAgentTranscriptPath(asAgentId(task.agentId)),
    )
  }

  // 清除后重新持久化模式和 worktree 状态，使未来的 --resume 能正确识别清除后的会话状态。
  // clearSessionMetadata 已将两者从缓存中清除，但进程本身仍处于同一模式和（如适用）worktree 目录。
  if (feature('COORDINATOR_MODE')) {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { saveMode } = require('../../utils/sessionStorage.js')
    const {
      isCoordinatorMode,
    } = require('../../coordinator/coordinatorMode.js')
    /* eslint-enable @typescript-eslint/no-require-imports */
    saveMode(isCoordinatorMode() ? 'coordinator' : 'normal')
  }
  const worktreeSession = getCurrentWorktreeSession()
  if (worktreeSession) {
    saveWorktreeState(worktreeSession)
  }

  // 执行 SessionStart 钩子，通知外部插件新会话已开始（'clear' 触发原因）
  const hookMessages = await processSessionStartHooks('clear')

  // 若钩子返回了消息（如欢迎信息），注入到消息列表作为初始内容
  if (hookMessages.length > 0) {
    setMessages(() => hookMessages)
  }
}
