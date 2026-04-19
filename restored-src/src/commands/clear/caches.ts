/**
 * 会话缓存清除工具模块。
 *
 * 在 Claude Code 的会话生命周期管理流程中，此文件提供了 clearSessionCaches 函数，
 * 负责在 /clear 命令执行或会话恢复（--resume/--continue）时清除所有与当前会话
 * 绑定的缓存状态，使下一轮对话从干净的初始状态开始。
 *
 * 与 clearConversation 相比，此模块仅清除缓存（上下文、技能、文件建议、Git 状态等），
 * 不影响消息历史、会话 ID 或任何生命周期钩子的触发。
 *
 * 此模块在 main.tsx 启动时被导入，因此 import 列表须尽量精简以控制启动开销。
 */
import { feature } from 'bun:bundle'
import {
  clearInvokedSkills,
  setLastEmittedDate,
} from '../../bootstrap/state.js'
import { clearCommandsCache } from '../../commands.js'
import { getSessionStartDate } from '../../constants/common.js'
import {
  getGitStatus,
  getSystemContext,
  getUserContext,
  setSystemPromptInjection,
} from '../../context.js'
import { clearFileSuggestionCaches } from '../../hooks/fileSuggestions.js'
import { clearAllPendingCallbacks } from '../../hooks/useSwarmPermissionPoller.js'
import { clearAllDumpState } from '../../services/api/dumpPrompts.js'
import { resetPromptCacheBreakDetection } from '../../services/api/promptCacheBreakDetection.js'
import { clearAllSessions } from '../../services/api/sessionIngress.js'
import { runPostCompactCleanup } from '../../services/compact/postCompactCleanup.js'
import { resetAllLSPDiagnosticState } from '../../services/lsp/LSPDiagnosticRegistry.js'
import { clearTrackedMagicDocs } from '../../services/MagicDocs/magicDocs.js'
import { clearDynamicSkills } from '../../skills/loadSkillsDir.js'
import { resetSentSkillNames } from '../../utils/attachments.js'
import { clearCommandPrefixCaches } from '../../utils/bash/commands.js'
import { resetGetMemoryFilesCache } from '../../utils/claudemd.js'
import { clearRepositoryCaches } from '../../utils/detectRepository.js'
import { clearResolveGitDirCache } from '../../utils/git/gitFilesystem.js'
import { clearStoredImagePaths } from '../../utils/imageStore.js'
import { clearSessionEnvVars } from '../../utils/sessionEnvVars.js'

/**
 * 清除所有与当前会话相关的缓存状态。
 *
 * 此函数在 /clear 命令和 --resume/--continue 恢复流程中调用，确保文件发现、
 * 技能加载、Git 状态等缓存能够在新会话开始时被重新计算。
 *
 * 与 clearConversation 的区别：本函数是其子集，仅清除缓存，
 * 不清除消息、不更改会话 ID、不触发 SessionEnd/SessionStart 钩子。
 *
 * @param preservedAgentIds 需要跨 /clear 保留状态的 Agent ID 集合（如后台任务）。
 *   当此集合非空时，以 agentId 为键的状态（已调用技能）会被选择性清除；
 *   以 requestId 为键的状态（待处理权限回调、dump 状态、缓存中断追踪）则原样保留，
 *   因为无法安全地将其限定到主会话范围内。
 */
export function clearSessionCaches(
  preservedAgentIds: ReadonlySet<string> = new Set(),
): void {
  const hasPreserved = preservedAgentIds.size > 0
  // 清除上下文缓存：用户上下文、系统上下文、Git 状态、会话开始时间
  getUserContext.cache.clear?.()
  getSystemContext.cache.clear?.()
  getGitStatus.cache.clear?.()
  getSessionStartDate.cache.clear?.()
  // 清除文件建议缓存（@符号提及功能所用）
  clearFileSuggestionCaches()

  // 清除命令/技能缓存，使下次调用时重新发现
  clearCommandsCache()

  // 仅在无保留任务时清除 prompt cache 中断检测状态，避免影响后台任务
  if (!hasPreserved) resetPromptCacheBreakDetection()

  // 清除系统 prompt 注入标记（用于 prompt cache 失效触发）
  setSystemPromptInjection(null)

  // 清除最后发送日期，下一轮对话时重新检测
  setLastEmittedDate(null)

  // 运行 post-compact 清理：清除系统 prompt 段、microcompact 追踪、
  // 分类器审批、推测性检查，以及主线程 compact 的 memory 文件缓存（load_reason='compact'）
  runPostCompactCleanup()
  // 重置已发送技能名称列表，使 /clear 后模型能重新收到完整技能列表
  // runPostCompactCleanup 有意不重置此状态（post-compact 重注入约 4K tokens），
  // 但 /clear 会完全清空消息，所以模型需要再次获得完整列表
  resetSentSkillNames()
  // 以 'session_start' 覆盖 memory 缓存重置原因：
  // clearSessionCaches 由 /clear 和 --resume/--continue 触发，不属于 compact 事件。
  // 若不覆盖，下次 getMemoryFiles() 调用时 InstructionsLoaded 钩子会以 'compact' 上报
  resetGetMemoryFilesCache('session_start')

  // 清除存储的图片路径缓存
  clearStoredImagePaths()

  // 清除所有会话 ingress 缓存（lastUuidMap、sequentialAppendBySession）
  clearAllSessions()
  // 清除 swarm 权限等待回调（无保留任务时才清除）
  if (!hasPreserved) clearAllPendingCallbacks()

  // 清除 Tungsten 会话使用追踪（仅 Anthropic 内部员工）
  if (process.env.USER_TYPE === 'ant') {
    void import('../../tools/TungstenTool/TungstenTool.js').then(
      ({ clearSessionsWithTungstenUsage, resetInitializationState }) => {
        clearSessionsWithTungstenUsage()
        resetInitializationState()
      },
    )
  }
  // 清除 attribution 缓存（文件内容缓存、待处理 bash 状态）
  // 动态导入以保留 COMMIT_ATTRIBUTION 特性标志的死代码消除
  if (feature('COMMIT_ATTRIBUTION')) {
    void import('../../utils/attributionHooks.js').then(
      ({ clearAttributionCaches }) => clearAttributionCaches(),
    )
  }
  // 清除代码仓库检测缓存（如 monorepo 根目录检测结果）
  clearRepositoryCaches()
  // 清除 bash 命令前缀缓存（Haiku 提取的命令前缀集合）
  clearCommandPrefixCaches()
  // 清除 dump prompts 状态（无保留任务时才清除）
  if (!hasPreserved) clearAllDumpState()
  // 清除已调用技能缓存（每条记录含完整技能文件内容）
  clearInvokedSkills(preservedAgentIds)
  // 清除 git 目录解析缓存
  clearResolveGitDirCache()
  // 清除动态技能（从技能目录加载的技能）
  clearDynamicSkills()
  // 清除 LSP 诊断追踪状态
  resetAllLSPDiagnosticState()
  // 清除被追踪的 Magic Docs
  clearTrackedMagicDocs()
  // 清除会话环境变量（仅当前会话注入的临时 env）
  clearSessionEnvVars()
  // 清除 WebFetch URL 缓存（最多 50MB 的已缓存页面内容）
  void import('../../tools/WebFetchTool/utils.js').then(
    ({ clearWebFetchCache }) => clearWebFetchCache(),
  )
  // 清除 ToolSearch 描述缓存（约 50 个 MCP 工具时达 ~500KB）
  void import('../../tools/ToolSearchTool/ToolSearchTool.js').then(
    ({ clearToolSearchDescriptionCache }) => clearToolSearchDescriptionCache(),
  )
  // 清除 agent 定义缓存（通过 EnterWorktreeTool 累积的每个 cwd 的 agent 定义）
  void import('../../tools/AgentTool/loadAgentsDir.js').then(
    ({ clearAgentDefinitionsCache }) => clearAgentDefinitionsCache(),
  )
  // 清除 SkillTool prompt 缓存（按项目根目录累积）
  void import('../../tools/SkillTool/prompt.js').then(({ clearPromptCache }) =>
    clearPromptCache(),
  )
}
