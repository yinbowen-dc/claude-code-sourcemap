/**
 * 消息附件构建模块（系统提示与用户消息注入）。
 *
 * 在 Claude Code 系统中，该模块是 API 请求构建的核心，负责将各类上下文信息
 * 组装为 Claude API 消息中的附件内容，包括：
 * - 内存文件（CLAUDE.md 及条件规则）读取与注入
 * - IDE 诊断信息、文件状态缓存（diff 预览）
 * - Plan 模式、Auto 模式的状态注入
 * - 图片粘贴内容（含自动裁剪/压缩）
 * - MCP 工具资源、技能工具命令列表
 * - Agent 定义列表（swarm 场景）
 * - Task 附件（任务框架输出）
 * - todo 列表与任务状态注入
 */
// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
import {
  logEvent,
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
} from 'src/services/analytics/index.js'
import {
  toolMatchesName,
  type Tools,
  type ToolUseContext,
  type ToolPermissionContext,
} from '../Tool.js'
import {
  FileReadTool,
  MaxFileReadTokenExceededError,
  type Output as FileReadToolOutput,
  readImageWithTokenBudget,
} from '../tools/FileReadTool/FileReadTool.js'
import { FileTooLargeError, readFileInRange } from './readFileInRange.js'
import { expandPath } from './path.js'
import { countCharInString } from './stringUtils.js'
import { count, uniq } from './array.js'
import { getFsImplementation } from './fsOperations.js'
import { readdir, stat } from 'fs/promises'
import type { IDESelection } from '../hooks/useIdeSelection.js'
import { TODO_WRITE_TOOL_NAME } from '../tools/TodoWriteTool/constants.js'
import { TASK_CREATE_TOOL_NAME } from '../tools/TaskCreateTool/constants.js'
import { TASK_UPDATE_TOOL_NAME } from '../tools/TaskUpdateTool/constants.js'
import { BASH_TOOL_NAME } from '../tools/BashTool/toolName.js'
import { SKILL_TOOL_NAME } from '../tools/SkillTool/constants.js'
import type { TodoList } from './todo/types.js'
import {
  type Task,
  listTasks,
  getTaskListId,
  isTodoV2Enabled,
} from './tasks.js'
import { getPlanFilePath, getPlan } from './plans.js'
import { getConnectedIdeName } from './ide.js'
import {
  filterInjectedMemoryFiles,
  getManagedAndUserConditionalRules,
  getMemoryFiles,
  getMemoryFilesForNestedDirectory,
  getConditionalRulesForCwdLevelDirectory,
  type MemoryFileInfo,
} from './claudemd.js'
import { dirname, parse, relative, resolve } from 'path'
import { getCwd } from 'src/utils/cwd.js'
import { getViewedTeammateTask } from '../state/selectors.js'
import { logError } from './log.js'
import { logAntError } from './debug.js'
import { isENOENT, toError } from './errors.js'
import type { DiagnosticFile } from '../services/diagnosticTracking.js'
import { diagnosticTracker } from '../services/diagnosticTracking.js'
import type {
  AttachmentMessage,
  Message,
  MessageOrigin,
} from 'src/types/message.js'
import {
  type QueuedCommand,
  getImagePasteIds,
  isValidImagePaste,
} from 'src/types/textInputTypes.js'
import { randomUUID, type UUID } from 'crypto'
import { getSettings_DEPRECATED } from './settings/settings.js'
import { getSnippetForTwoFileDiff } from 'src/tools/FileEditTool/utils.js'
import type {
  ContentBlockParam,
  ImageBlockParam,
  Base64ImageSource,
} from '@anthropic-ai/sdk/resources/messages.mjs'
import { maybeResizeAndDownsampleImageBlock } from './imageResizer.js'
import type { PastedContent } from './config.js'
import { getGlobalConfig } from './config.js'
import {
  getDefaultSonnetModel,
  getDefaultHaikuModel,
  getDefaultOpusModel,
} from './model/model.js'
import type { ReadResourceResult } from '@modelcontextprotocol/sdk/types.js'
import { getSkillToolCommands, getMcpSkillCommands } from '../commands.js'
import type { Command } from '../types/command.js'
import uniqBy from 'lodash-es/uniqBy.js'
import { getProjectRoot } from '../bootstrap/state.js'
import { formatCommandsWithinBudget } from '../tools/SkillTool/prompt.js'
import { getContextWindowForModel } from './context.js'
import type { DiscoverySignal } from '../services/skillSearch/signals.js'
// Conditional require for DCE. All skill-search string literals that would
// otherwise leak into external builds live inside these modules. The only
// surfaces in THIS file are: the maybe() call (gated via spread below) and
// the skill_listing suppression check (uses the same skillSearchModules null
// check). The type-only DiscoverySignal import above is erased at compile time.
/* eslint-disable @typescript-eslint/no-require-imports */
const skillSearchModules = feature('EXPERIMENTAL_SKILL_SEARCH')
  ? {
      featureCheck:
        require('../services/skillSearch/featureCheck.js') as typeof import('../services/skillSearch/featureCheck.js'),
      prefetch:
        require('../services/skillSearch/prefetch.js') as typeof import('../services/skillSearch/prefetch.js'),
    }
  : null
const autoModeStateModule = feature('TRANSCRIPT_CLASSIFIER')
  ? (require('./permissions/autoModeState.js') as typeof import('./permissions/autoModeState.js'))
  : null
/* eslint-enable @typescript-eslint/no-require-imports */
import {
  MAX_LINES_TO_READ,
  FILE_READ_TOOL_NAME,
} from 'src/tools/FileReadTool/prompt.js'
import { getDefaultFileReadingLimits } from 'src/tools/FileReadTool/limits.js'
import { cacheKeys, type FileStateCache } from './fileStateCache.js'
import {
  createAbortController,
  createChildAbortController,
} from './abortController.js'
import { isAbortError } from './errors.js'
import {
  getFileModificationTimeAsync,
  isFileWithinReadSizeLimit,
} from './file.js'
import type { AgentDefinition } from '../tools/AgentTool/loadAgentsDir.js'
import { filterAgentsByMcpRequirements } from '../tools/AgentTool/loadAgentsDir.js'
import { AGENT_TOOL_NAME } from '../tools/AgentTool/constants.js'
import {
  formatAgentLine,
  shouldInjectAgentListInMessages,
} from '../tools/AgentTool/prompt.js'
import { filterDeniedAgents } from './permissions/permissions.js'
import { getSubscriptionType } from './auth.js'
import { mcpInfoFromString } from '../services/mcp/mcpStringUtils.js'
import {
  matchingRuleForInput,
  pathInAllowedWorkingPath,
} from './permissions/filesystem.js'
import {
  generateTaskAttachments,
  applyTaskOffsetsAndEvictions,
} from './task/framework.js'
import { getTaskOutputPath } from './task/diskOutput.js'
import { drainPendingMessages } from '../tasks/LocalAgentTask/LocalAgentTask.js'
import type { TaskType, TaskStatus } from '../Task.js'
import {
  getOriginalCwd,
  getSessionId,
  getSdkBetas,
  getTotalCostUSD,
  getTotalOutputTokens,
  getCurrentTurnTokenBudget,
  getTurnOutputTokens,
  hasExitedPlanModeInSession,
  setHasExitedPlanMode,
  needsPlanModeExitAttachment,
  setNeedsPlanModeExitAttachment,
  needsAutoModeExitAttachment,
  setNeedsAutoModeExitAttachment,
  getLastEmittedDate,
  setLastEmittedDate,
  getKairosActive,
} from '../bootstrap/state.js'
import type { QuerySource } from '../constants/querySource.js'
import {
  getDeferredToolsDelta,
  isDeferredToolsDeltaEnabled,
  isToolSearchEnabledOptimistic,
  isToolSearchToolAvailable,
  modelSupportsToolReference,
  type DeferredToolsDeltaScanContext,
} from './toolSearch.js'
import {
  getMcpInstructionsDelta,
  isMcpInstructionsDeltaEnabled,
  type ClientSideInstruction,
} from './mcpInstructionsDelta.js'
import { CLAUDE_IN_CHROME_MCP_SERVER_NAME } from './claudeInChrome/common.js'
import { CHROME_TOOL_SEARCH_INSTRUCTIONS } from './claudeInChrome/prompt.js'
import type { MCPServerConnection } from '../services/mcp/types.js'
import type {
  HookEvent,
  SyncHookJSONOutput,
} from 'src/entrypoints/agentSdkTypes.js'
import {
  checkForAsyncHookResponses,
  removeDeliveredAsyncHooks,
} from './hooks/AsyncHookRegistry.js'
import {
  checkForLSPDiagnostics,
  clearAllLSPDiagnostics,
} from '../services/lsp/LSPDiagnosticRegistry.js'
import { logForDebugging } from './debug.js'
import {
  extractTextContent,
  getUserMessageText,
  isThinkingMessage,
} from './messages.js'
import { isHumanTurn } from './messagePredicates.js'
import { isEnvTruthy, getClaudeConfigHomeDir } from './envUtils.js'
import { feature } from 'bun:bundle'
/* eslint-disable @typescript-eslint/no-require-imports */
const BRIEF_TOOL_NAME: string | null =
  feature('KAIROS') || feature('KAIROS_BRIEF')
    ? (
        require('../tools/BriefTool/prompt.js') as typeof import('../tools/BriefTool/prompt.js')
      ).BRIEF_TOOL_NAME
    : null
const sessionTranscriptModule = feature('KAIROS')
  ? (require('../services/sessionTranscript/sessionTranscript.js') as typeof import('../services/sessionTranscript/sessionTranscript.js'))
  : null
/* eslint-enable @typescript-eslint/no-require-imports */
import { hasUltrathinkKeyword, isUltrathinkEnabled } from './thinking.js'
import {
  tokenCountFromLastAPIResponse,
  tokenCountWithEstimation,
} from './tokens.js'
import {
  getEffectiveContextWindowSize,
  isAutoCompactEnabled,
} from '../services/compact/autoCompact.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js'
import {
  hasInstructionsLoadedHook,
  executeInstructionsLoadedHooks,
  type HookBlockingError,
  type InstructionsMemoryType,
} from './hooks.js'
import { jsonStringify } from './slowOperations.js'
import { isPDFExtension } from './pdfUtils.js'
import { getLocalISODate } from '../constants/common.js'
import { getPDFPageCount } from './pdf.js'
import { PDF_AT_MENTION_INLINE_THRESHOLD } from '../constants/apiLimits.js'
import { isAgentSwarmsEnabled } from './agentSwarmsEnabled.js'
import { findRelevantMemories } from '../memdir/findRelevantMemories.js'
import { memoryAge, memoryFreshnessText } from '../memdir/memoryAge.js'
import { getAutoMemPath, isAutoMemoryEnabled } from '../memdir/paths.js'
import { getAgentMemoryDir } from '../tools/AgentTool/agentMemory.js'
import {
  readUnreadMessages,
  markMessagesAsReadByPredicate,
  isShutdownApproved,
  isStructuredProtocolMessage,
  isIdleNotification,
} from './teammateMailbox.js'
import {
  getAgentName,
  getAgentId,
  getTeamName,
  isTeamLead,
} from './teammate.js'
import { isInProcessTeammate } from './teammateContext.js'
import { removeTeammateFromTeamFile } from './swarm/teamHelpers.js'
import { unassignTeammateTasks } from './tasks.js'
import { getCompanionIntroAttachment } from '../buddy/prompt.js'

export const TODO_REMINDER_CONFIG = {
  TURNS_SINCE_WRITE: 10,
  TURNS_BETWEEN_REMINDERS: 10,
} as const

export const PLAN_MODE_ATTACHMENT_CONFIG = {
  TURNS_BETWEEN_ATTACHMENTS: 5,
  FULL_REMINDER_EVERY_N_ATTACHMENTS: 5,
} as const

export const AUTO_MODE_ATTACHMENT_CONFIG = {
  TURNS_BETWEEN_ATTACHMENTS: 5,
  FULL_REMINDER_EVERY_N_ATTACHMENTS: 5,
} as const

const MAX_MEMORY_LINES = 200
// Line cap alone doesn't bound size (200 × 500-char lines = 100KB).  The
// surfacer injects up to 5 files per turn via <system-reminder>, bypassing
// the per-message tool-result budget, so a tight per-file byte cap keeps
// aggregate injection bounded (5 × 4KB = 20KB/turn).  Enforced via
// readFileInRange's truncateOnByteLimit option.  Truncation means the
// most-relevant memory still surfaces: the frontmatter + opening context
// is usually what matters.
const MAX_MEMORY_BYTES = 4096

export const RELEVANT_MEMORIES_CONFIG = {
  // Per-turn cap (5 × 4KB = 20KB) bounds a single injection, but over a
  // long session the selector keeps surfacing distinct files — ~26K tokens/
  // session observed in prod.  Cap the cumulative bytes: once hit, stop
  // prefetching entirely.  Budget is ~3 full injections; after that the
  // most-relevant memories are already in context.  Scanning messages
  // (rather than tracking in toolUseContext) means compact naturally
  // resets the counter — old attachments are gone from context, so
  // re-surfacing is valid.
  MAX_SESSION_BYTES: 60 * 1024,
} as const

export const VERIFY_PLAN_REMINDER_CONFIG = {
  TURNS_BETWEEN_REMINDERS: 10,
} as const

export type FileAttachment = {
  type: 'file'
  filename: string
  content: FileReadToolOutput
  /**
   * Whether the file was truncated due to size limits
   */
  truncated?: boolean
  /** Path relative to CWD at creation time, for stable display */
  displayPath: string
}

export type CompactFileReferenceAttachment = {
  type: 'compact_file_reference'
  filename: string
  /** Path relative to CWD at creation time, for stable display */
  displayPath: string
}

export type PDFReferenceAttachment = {
  type: 'pdf_reference'
  filename: string
  pageCount: number
  fileSize: number
  /** Path relative to CWD at creation time, for stable display */
  displayPath: string
}

export type AlreadyReadFileAttachment = {
  type: 'already_read_file'
  filename: string
  content: FileReadToolOutput
  /**
   * Whether the file was truncated due to size limits
   */
  truncated?: boolean
  /** Path relative to CWD at creation time, for stable display */
  displayPath: string
}

export type AgentMentionAttachment = {
  type: 'agent_mention'
  agentType: string
}

export type AsyncHookResponseAttachment = {
  type: 'async_hook_response'
  processId: string
  hookName: string
  hookEvent: HookEvent | 'StatusLine' | 'FileSuggestion'
  toolName?: string
  response: SyncHookJSONOutput
  stdout: string
  stderr: string
  exitCode?: number
}

export type HookAttachment =
  | HookCancelledAttachment
  | {
      type: 'hook_blocking_error'
      blockingError: HookBlockingError
      hookName: string
      toolUseID: string
      hookEvent: HookEvent
    }
  | HookNonBlockingErrorAttachment
  | HookErrorDuringExecutionAttachment
  | {
      type: 'hook_stopped_continuation'
      message: string
      hookName: string
      toolUseID: string
      hookEvent: HookEvent
    }
  | HookSuccessAttachment
  | {
      type: 'hook_additional_context'
      content: string[]
      hookName: string
      toolUseID: string
      hookEvent: HookEvent
    }
  | HookSystemMessageAttachment
  | HookPermissionDecisionAttachment

export type HookPermissionDecisionAttachment = {
  type: 'hook_permission_decision'
  decision: 'allow' | 'deny'
  toolUseID: string
  hookEvent: HookEvent
}

export type HookSystemMessageAttachment = {
  type: 'hook_system_message'
  content: string
  hookName: string
  toolUseID: string
  hookEvent: HookEvent
}

export type HookCancelledAttachment = {
  type: 'hook_cancelled'
  hookName: string
  toolUseID: string
  hookEvent: HookEvent
  command?: string
  durationMs?: number
}

export type HookErrorDuringExecutionAttachment = {
  type: 'hook_error_during_execution'
  content: string
  hookName: string
  toolUseID: string
  hookEvent: HookEvent
  command?: string
  durationMs?: number
}

export type HookSuccessAttachment = {
  type: 'hook_success'
  content: string
  hookName: string
  toolUseID: string
  hookEvent: HookEvent
  stdout?: string
  stderr?: string
  exitCode?: number
  command?: string
  durationMs?: number
}

export type HookNonBlockingErrorAttachment = {
  type: 'hook_non_blocking_error'
  hookName: string
  stderr: string
  stdout: string
  exitCode: number
  toolUseID: string
  hookEvent: HookEvent
  command?: string
  durationMs?: number
}

export type Attachment =
  /**
   * User at-mentioned the file
   */
  | FileAttachment
  | CompactFileReferenceAttachment
  | PDFReferenceAttachment
  | AlreadyReadFileAttachment
  /**
   * An at-mentioned file was edited
   */
  | {
      type: 'edited_text_file'
      filename: string
      snippet: string
    }
  | {
      type: 'edited_image_file'
      filename: string
      content: FileReadToolOutput
    }
  | {
      type: 'directory'
      path: string
      content: string
      /** Path relative to CWD at creation time, for stable display */
      displayPath: string
    }
  | {
      type: 'selected_lines_in_ide'
      ideName: string
      lineStart: number
      lineEnd: number
      filename: string
      content: string
      /** Path relative to CWD at creation time, for stable display */
      displayPath: string
    }
  | {
      type: 'opened_file_in_ide'
      filename: string
    }
  | {
      type: 'todo_reminder'
      content: TodoList
      itemCount: number
    }
  | {
      type: 'task_reminder'
      content: Task[]
      itemCount: number
    }
  | {
      type: 'nested_memory'
      path: string
      content: MemoryFileInfo
      /** Path relative to CWD at creation time, for stable display */
      displayPath: string
    }
  | {
      type: 'relevant_memories'
      memories: {
        path: string
        content: string
        mtimeMs: number
        /**
         * Pre-computed header string (age + path prefix).  Computed once
         * at attachment-creation time so the rendered bytes are stable
         * across turns — recomputing memoryAge(mtimeMs) at render time
         * calls Date.now(), so "saved 3 days ago" becomes "saved 4 days
         * ago" across turns → different bytes → prompt cache bust.
         * Optional for backward compat with resumed sessions; render
         * path falls back to recomputing if missing.
         */
        header?: string
        /**
         * lineCount when the file was truncated by readMemoriesForSurfacing,
         * else undefined. Threaded to the readFileState write so
         * getChangedFiles skips truncated memories (partial content would
         * yield a misleading diff).
         */
        limit?: number
      }[]
    }
  | {
      type: 'dynamic_skill'
      skillDir: string
      skillNames: string[]
      /** Path relative to CWD at creation time, for stable display */
      displayPath: string
    }
  | {
      type: 'skill_listing'
      content: string
      skillCount: number
      isInitial: boolean
    }
  | {
      type: 'skill_discovery'
      skills: { name: string; description: string; shortId?: string }[]
      signal: DiscoverySignal
      source: 'native' | 'aki' | 'both'
    }
  | {
      type: 'queued_command'
      prompt: string | Array<ContentBlockParam>
      source_uuid?: UUID
      imagePasteIds?: number[]
      /** Original queue mode — 'prompt' for user messages, 'task-notification' for system events */
      commandMode?: string
      /** Provenance carried from QueuedCommand so mid-turn drains preserve it */
      origin?: MessageOrigin
      /** Carried from QueuedCommand.isMeta — distinguishes human-typed from system-injected */
      isMeta?: boolean
    }
  | {
      type: 'output_style'
      style: string
    }
  | {
      type: 'diagnostics'
      files: DiagnosticFile[]
      isNew: boolean
    }
  | {
      type: 'plan_mode'
      reminderType: 'full' | 'sparse'
      isSubAgent?: boolean
      planFilePath: string
      planExists: boolean
    }
  | {
      type: 'plan_mode_reentry'
      planFilePath: string
    }
  | {
      type: 'plan_mode_exit'
      planFilePath: string
      planExists: boolean
    }
  | {
      type: 'auto_mode'
      reminderType: 'full' | 'sparse'
    }
  | {
      type: 'auto_mode_exit'
    }
  | {
      type: 'critical_system_reminder'
      content: string
    }
  | {
      type: 'plan_file_reference'
      planFilePath: string
      planContent: string
    }
  | {
      type: 'mcp_resource'
      server: string
      uri: string
      name: string
      description?: string
      content: ReadResourceResult
    }
  | {
      type: 'command_permissions'
      allowedTools: string[]
      model?: string
    }
  | AgentMentionAttachment
  | {
      type: 'task_status'
      taskId: string
      taskType: TaskType
      status: TaskStatus
      description: string
      deltaSummary: string | null
      outputFilePath?: string
    }
  | AsyncHookResponseAttachment
  | {
      type: 'token_usage'
      used: number
      total: number
      remaining: number
    }
  | {
      type: 'budget_usd'
      used: number
      total: number
      remaining: number
    }
  | {
      type: 'output_token_usage'
      turn: number
      session: number
      budget: number | null
    }
  | {
      type: 'structured_output'
      data: unknown
    }
  | TeammateMailboxAttachment
  | TeamContextAttachment
  | HookAttachment
  | {
      type: 'invoked_skills'
      skills: Array<{
        name: string
        path: string
        content: string
      }>
    }
  | {
      type: 'verify_plan_reminder'
    }
  | {
      type: 'max_turns_reached'
      maxTurns: number
      turnCount: number
    }
  | {
      type: 'current_session_memory'
      content: string
      path: string
      tokenCount: number
    }
  | {
      type: 'teammate_shutdown_batch'
      count: number
    }
  | {
      type: 'compaction_reminder'
    }
  | {
      type: 'context_efficiency'
    }
  | {
      type: 'date_change'
      newDate: string
    }
  | {
      type: 'ultrathink_effort'
      level: 'high'
    }
  | {
      type: 'deferred_tools_delta'
      addedNames: string[]
      addedLines: string[]
      removedNames: string[]
    }
  | {
      type: 'agent_listing_delta'
      addedTypes: string[]
      addedLines: string[]
      removedTypes: string[]
      /** True when this is the first announcement in the conversation */
      isInitial: boolean
      /** Whether to include the "launch multiple agents concurrently" note (non-pro subscriptions) */
      showConcurrencyNote: boolean
    }
  | {
      type: 'mcp_instructions_delta'
      addedNames: string[]
      addedBlocks: string[]
      removedNames: string[]
    }
  | {
      type: 'companion_intro'
      name: string
      species: string
    }
  | {
      type: 'bagel_console'
      errorCount: number
      warningCount: number
      sample: string
    }

export type TeammateMailboxAttachment = {
  type: 'teammate_mailbox'
  messages: Array<{
    from: string
    text: string
    timestamp: string
    color?: string
    summary?: string
  }>
}

export type TeamContextAttachment = {
  type: 'team_context'
  agentId: string
  agentName: string
  teamName: string
  teamConfigPath: string
  taskListPath: string
}

/**
 * 主附件收集函数，汇总所有上下文附件并返回给模型。
 *
 * 执行流程：
 * 1. 若设置了 CLAUDE_CODE_DISABLE_ATTACHMENTS 或 CLAUDE_CODE_SIMPLE，仅返回排队命令附件
 * 2. 并发处理用户输入附件（@提及文件、MCP 资源、代理提及、技能发现）
 * 3. 等待用户输入附件完成后（确保 nestedMemoryAttachmentTriggers 已填充），再并发处理线程附件
 * 4. 主线程额外处理记忆、技能列表、LSP 诊断、规划模式等附件
 * 5. 汇总并过滤掉 undefined/null 值后返回
 *
 * 注意：附件生成有 1 秒超时，防止阻塞用户提交。
 * TODO: Generate attachments when we create messages
 */
export async function getAttachments(
  input: string | null,
  toolUseContext: ToolUseContext,
  ideSelection: IDESelection | null,
  queuedCommands: QueuedCommand[],
  messages?: Message[],
  querySource?: QuerySource,
  options?: { skipSkillDiscovery?: boolean },
): Promise<Attachment[]> {
  if (
    isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_ATTACHMENTS) ||
    isEnvTruthy(process.env.CLAUDE_CODE_SIMPLE)
  ) {
    // query.ts:removeFromQueue dequeues these unconditionally after
    // getAttachmentMessages runs — returning [] here silently drops them.
    // Coworker runs with --bare and depends on task-notification for
    // mid-tool-call notifications from Local*Task/Remote*Task.
    return getQueuedCommandAttachments(queuedCommands)
  }

  // This will slow down submissions
  // TODO: Compute attachments as the user types, not here (though we use this
  // function for slash command prompts too)
  const abortController = createAbortController()
  const timeoutId = setTimeout(ac => ac.abort(), 1000, abortController)
  const context = { ...toolUseContext, abortController }

  const isMainThread = !toolUseContext.agentId

  // Attachments which are added in response to on user input
  const userInputAttachments = input
    ? [
        maybe('at_mentioned_files', () =>
          processAtMentionedFiles(input, context),
        ),
        maybe('mcp_resources', () =>
          processMcpResourceAttachments(input, context),
        ),
        maybe('agent_mentions', () =>
          Promise.resolve(
            processAgentMentions(
              input,
              toolUseContext.options.agentDefinitions.activeAgents,
            ),
          ),
        ),
        // Skill discovery on turn 0 (user input as signal). Inter-turn
        // discovery runs via startSkillDiscoveryPrefetch in query.ts,
        // gated on write-pivot detection — see skillSearch/prefetch.ts.
        // feature() here lets DCE drop the 'skill_discovery' string (and the
        // function it calls) from external builds.
        //
        // skipSkillDiscovery gates out the SKILL.md-expansion path
        // (getMessagesForPromptSlashCommand). When a skill is invoked, its
        // SKILL.md content is passed as `input` here to extract @-mentions —
        // but that content is NOT user intent and must not trigger discovery.
        // Without this gate, a 110KB SKILL.md fires ~3.3s of chunked AKI
        // queries on every skill invocation (session 13a9afae).
        ...(feature('EXPERIMENTAL_SKILL_SEARCH') &&
        skillSearchModules &&
        !options?.skipSkillDiscovery
          ? [
              maybe('skill_discovery', () =>
                skillSearchModules.prefetch.getTurnZeroSkillDiscovery(
                  input,
                  messages ?? [],
                  context,
                ),
              ),
            ]
          : []),
      ]
    : []

  // Process user input attachments first (includes @mentioned files)
  // This ensures files are added to nestedMemoryAttachmentTriggers before nested_memory processes them
  const userAttachmentResults = await Promise.all(userInputAttachments)

  // Thread-safe attachments available in sub-agents
  // NOTE: These must be created AFTER userInputAttachments completes to ensure
  // nestedMemoryAttachmentTriggers is populated before getNestedMemoryAttachments runs
  const allThreadAttachments = [
    // queuedCommands is already agent-scoped by the drain gate in query.ts —
    // main thread gets agentId===undefined, subagents get their own agentId.
    // Must run for all threads or subagent notifications drain into the void
    // (removed from queue by removeFromQueue but never attached).
    maybe('queued_commands', () => getQueuedCommandAttachments(queuedCommands)),
    maybe('date_change', () =>
      Promise.resolve(getDateChangeAttachments(messages)),
    ),
    maybe('ultrathink_effort', () =>
      Promise.resolve(getUltrathinkEffortAttachment(input)),
    ),
    maybe('deferred_tools_delta', () =>
      Promise.resolve(
        getDeferredToolsDeltaAttachment(
          toolUseContext.options.tools,
          toolUseContext.options.mainLoopModel,
          messages,
          {
            callSite: isMainThread
              ? 'attachments_main'
              : 'attachments_subagent',
            querySource,
          },
        ),
      ),
    ),
    maybe('agent_listing_delta', () =>
      Promise.resolve(getAgentListingDeltaAttachment(toolUseContext, messages)),
    ),
    maybe('mcp_instructions_delta', () =>
      Promise.resolve(
        getMcpInstructionsDeltaAttachment(
          toolUseContext.options.mcpClients,
          toolUseContext.options.tools,
          toolUseContext.options.mainLoopModel,
          messages,
        ),
      ),
    ),
    ...(feature('BUDDY')
      ? [
          maybe('companion_intro', () =>
            Promise.resolve(getCompanionIntroAttachment(messages)),
          ),
        ]
      : []),
    maybe('changed_files', () => getChangedFiles(context)),
    maybe('nested_memory', () => getNestedMemoryAttachments(context)),
    // relevant_memories moved to async prefetch (startRelevantMemoryPrefetch)
    maybe('dynamic_skill', () => getDynamicSkillAttachments(context)),
    maybe('skill_listing', () => getSkillListingAttachments(context)),
    // Inter-turn skill discovery now runs via startSkillDiscoveryPrefetch
    // (query.ts, concurrent with the main turn). The blocking call that
    // previously lived here was the assistant_turn signal — 97% of those
    // Haiku calls found nothing in prod. Prefetch + await-at-collection
    // replaces it; see src/services/skillSearch/prefetch.ts.
    maybe('plan_mode', () => getPlanModeAttachments(messages, toolUseContext)),
    maybe('plan_mode_exit', () => getPlanModeExitAttachment(toolUseContext)),
    ...(feature('TRANSCRIPT_CLASSIFIER')
      ? [
          maybe('auto_mode', () =>
            getAutoModeAttachments(messages, toolUseContext),
          ),
          maybe('auto_mode_exit', () =>
            getAutoModeExitAttachment(toolUseContext),
          ),
        ]
      : []),
    maybe('todo_reminders', () =>
      isTodoV2Enabled()
        ? getTaskReminderAttachments(messages, toolUseContext)
        : getTodoReminderAttachments(messages, toolUseContext),
    ),
    ...(isAgentSwarmsEnabled()
      ? [
          // Skip teammate mailbox for the session_memory forked agent.
          // It shares AppState.teamContext with the leader, so isTeamLead resolves
          // true and it reads+marks-as-read the leader's DMs as ephemeral attachments,
          // silently stealing messages that should be delivered as permanent turns.
          ...(querySource === 'session_memory'
            ? []
            : [
                maybe('teammate_mailbox', async () =>
                  getTeammateMailboxAttachments(toolUseContext),
                ),
              ]),
          maybe('team_context', async () =>
            getTeamContextAttachment(messages ?? []),
          ),
        ]
      : []),
    maybe('agent_pending_messages', async () =>
      getAgentPendingMessageAttachments(toolUseContext),
    ),
    maybe('critical_system_reminder', () =>
      Promise.resolve(getCriticalSystemReminderAttachment(toolUseContext)),
    ),
    ...(feature('COMPACTION_REMINDERS')
      ? [
          maybe('compaction_reminder', () =>
            Promise.resolve(
              getCompactionReminderAttachment(
                messages ?? [],
                toolUseContext.options.mainLoopModel,
              ),
            ),
          ),
        ]
      : []),
    ...(feature('HISTORY_SNIP')
      ? [
          maybe('context_efficiency', () =>
            Promise.resolve(getContextEfficiencyAttachment(messages ?? [])),
          ),
        ]
      : []),
  ]

  // Attachments which are semantically only for the main conversation or don't have concurrency-safe implementations
  const mainThreadAttachments = isMainThread
    ? [
        maybe('ide_selection', async () =>
          getSelectedLinesFromIDE(ideSelection, toolUseContext),
        ),
        maybe('ide_opened_file', async () =>
          getOpenedFileFromIDE(ideSelection, toolUseContext),
        ),
        maybe('output_style', async () =>
          Promise.resolve(getOutputStyleAttachment()),
        ),
        maybe('diagnostics', async () =>
          getDiagnosticAttachments(toolUseContext),
        ),
        maybe('lsp_diagnostics', async () =>
          getLSPDiagnosticAttachments(toolUseContext),
        ),
        maybe('unified_tasks', async () =>
          getUnifiedTaskAttachments(toolUseContext),
        ),
        maybe('async_hook_responses', async () =>
          getAsyncHookResponseAttachments(),
        ),
        maybe('token_usage', async () =>
          Promise.resolve(
            getTokenUsageAttachment(
              messages ?? [],
              toolUseContext.options.mainLoopModel,
            ),
          ),
        ),
        maybe('budget_usd', async () =>
          Promise.resolve(
            getMaxBudgetUsdAttachment(toolUseContext.options.maxBudgetUsd),
          ),
        ),
        maybe('output_token_usage', async () =>
          Promise.resolve(getOutputTokenUsageAttachment()),
        ),
        maybe('verify_plan_reminder', async () =>
          getVerifyPlanReminderAttachment(messages, toolUseContext),
        ),
      ]
    : []

  // Process thread and main thread attachments in parallel (no dependencies between them)
  const [threadAttachmentResults, mainThreadAttachmentResults] =
    await Promise.all([
      Promise.all(allThreadAttachments),
      Promise.all(mainThreadAttachments),
    ])

  clearTimeout(timeoutId)
  // Defensive: a getter leaking [undefined] crashes .map(a => a.type) below.
  return [
    ...userAttachmentResults.flat(),
    ...threadAttachmentResults.flat(),
    ...mainThreadAttachmentResults.flat(),
  ].filter(a => a !== undefined && a !== null)
}

/**
 * 附件生成器的错误隔离与计时包装器。
 *
 * 调用附件生成函数 f()，捕获所有异常（避免单个附件失败影响全局），
 * 并以 5% 的概率上报耗时和附件大小事件（控制日志量）。
 * 出错时返回空数组，确保附件流程继续运行。
 */
async function maybe<A>(label: string, f: () => Promise<A[]>): Promise<A[]> {
  const startTime = Date.now()
  try {
    const result = await f()
    const duration = Date.now() - startTime
    // Log only 5% of events to reduce volume
    if (Math.random() < 0.05) {
      // jsonStringify(undefined) returns undefined, so .length would throw
      const attachmentSizeBytes = result
        .filter(a => a !== undefined && a !== null)
        .reduce((total, attachment) => {
          return total + jsonStringify(attachment).length
        }, 0)
      logEvent('tengu_attachment_compute_duration', {
        label,
        duration_ms: duration,
        attachment_size_bytes: attachmentSizeBytes,
        attachment_count: result.length,
      } as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS)
    }
    return result
  } catch (e) {
    const duration = Date.now() - startTime
    // Log only 5% of events to reduce volume
    if (Math.random() < 0.05) {
      logEvent('tengu_attachment_compute_duration', {
        label,
        duration_ms: duration,
        error: true,
      } as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS)
    }
    logError(e)
    // For Ant users, log the full error to help with debugging
    logAntError(`Attachment error in ${label}`, e)

    return []
  }
}

const INLINE_NOTIFICATION_MODES = new Set(['prompt', 'task-notification'])

/**
 * 将排队命令转换为 queued_command 类型的附件列表。
 *
 * 仅处理 mode 为 'prompt' 或 'task-notification' 的命令。
 * task-notification 命令在代理主动循环中不能通过 useQueueProcessor 消费，
 * 必须通过此函数注入附件才能防止 Sleep 无限唤醒。
 * 若命令携带粘贴图片，将文本和图片合并为 ContentBlockParam 数组。
 */
export async function getQueuedCommandAttachments(
  queuedCommands: QueuedCommand[],
): Promise<Attachment[]> {
  if (!queuedCommands) {
    return []
  }
  // Include both 'prompt' and 'task-notification' commands as attachments.
  // During proactive agentic loops, task-notification commands would otherwise
  // stay in the queue permanently (useQueueProcessor can't run while a query
  // is active), causing hasPendingNotifications() to return true and Sleep to
  // wake immediately with 0ms duration in an infinite loop.
  const filtered = queuedCommands.filter(_ =>
    INLINE_NOTIFICATION_MODES.has(_.mode),
  )
  return Promise.all(
    filtered.map(async _ => {
      const imageBlocks = await buildImageContentBlocks(_.pastedContents)
      let prompt: string | Array<ContentBlockParam> = _.value
      if (imageBlocks.length > 0) {
        // Build content block array with text + images so the model sees them
        const textValue =
          typeof _.value === 'string'
            ? _.value
            : extractTextContent(_.value, '\n')
        prompt = [{ type: 'text' as const, text: textValue }, ...imageBlocks]
      }
      return {
        type: 'queued_command' as const,
        prompt,
        source_uuid: _.uuid,
        imagePasteIds: getImagePasteIds(_.pastedContents),
        commandMode: _.mode,
        origin: _.origin,
        isMeta: _.isMeta,
      }
    }),
  )
}

/**
 * 获取子代理待处理消息并转换为 queued_command 附件。
 *
 * 从 AppState 中排空当前代理 ID 的待处理消息队列，
 * 每条消息包装为 origin.kind='coordinator'、isMeta=true 的附件，
 * 供协调者向子代理传递带外通知。主线程（无 agentId）直接返回空数组。
 */
export function getAgentPendingMessageAttachments(
  toolUseContext: ToolUseContext,
): Attachment[] {
  const agentId = toolUseContext.agentId
  if (!agentId) return []
  const drained = drainPendingMessages(
    agentId,
    toolUseContext.getAppState,
    toolUseContext.setAppStateForTasks ?? toolUseContext.setAppState,
  )
  return drained.map(msg => ({
    type: 'queued_command' as const,
    prompt: msg,
    origin: { kind: 'coordinator' as const },
    isMeta: true,
  }))
}

/**
 * 将粘贴内容记录中的有效图片转换为 ImageBlockParam 数组。
 *
 * 过滤出合法的图片粘贴（isValidImagePaste），并行读取各图片数据，
 * 处理失败时记录错误并跳过，最终返回可嵌入消息的图片内容块列表。
 */
async function buildImageContentBlocks(
  pastedContents: Record<number, PastedContent> | undefined,
): Promise<ImageBlockParam[]> {
  if (!pastedContents) {
    return []
  }
  const imageContents = Object.values(pastedContents).filter(isValidImagePaste)
  if (imageContents.length === 0) {
    return []
  }
  const results = await Promise.all(
    imageContents.map(async img => {
      const imageBlock: ImageBlockParam = {
        type: 'image',
        source: {
          type: 'base64',
          media_type: (img.mediaType ||
            'image/png') as Base64ImageSource['media_type'],
          data: img.content,
        },
      }
      const resized = await maybeResizeAndDownsampleImageBlock(imageBlock)
      return resized.block
    }),
  )
  return results
}

/**
 * 统计距上次 plan_mode 附件以来经过的人类轮次数，并判断是否已发送过 plan_mode 附件。
 *
 * 从消息列表末尾向前遍历，计数非 meta、非工具结果的用户消息轮次，
 * 直到遇到 plan_mode 或 plan_mode_reentry 附件时停止。
 * 返回 turnCount（用于节流判断）和 foundPlanModeAttachment（是否已初始化过）。
 */
function getPlanModeAttachmentTurnCount(messages: Message[]): {
  turnCount: number
  foundPlanModeAttachment: boolean
} {
  let turnsSinceLastAttachment = 0
  let foundPlanModeAttachment = false

  // Iterate backwards to find most recent plan_mode attachment.
  // Count HUMAN turns (non-meta, non-tool-result user messages), not assistant
  // messages — the tool loop in query.ts calls getAttachmentMessages on every
  // tool round, so counting assistant messages would fire the reminder every
  // 5 tool calls instead of every 5 human turns.
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]

    if (
      message?.type === 'user' &&
      !message.isMeta &&
      !hasToolResultContent(message.message.content)
    ) {
      turnsSinceLastAttachment++
    } else if (
      message?.type === 'attachment' &&
      (message.attachment.type === 'plan_mode' ||
        message.attachment.type === 'plan_mode_reentry')
    ) {
      foundPlanModeAttachment = true
      break
    }
  }

  return { turnCount: turnsSinceLastAttachment, foundPlanModeAttachment }
}

/**
 * 统计自上次 plan_mode_exit 以来的 plan_mode 附件数量。
 * 用于确定当前是第几次提醒，决定使用完整（full）还是简略（sparse）提醒格式。
 * 重新进入规划模式时，计数从 plan_mode_exit 后重置，保证 full/sparse 周期正确。
 */
function countPlanModeAttachmentsSinceLastExit(messages: Message[]): number {
  let count = 0
  // Iterate backwards - if we hit a plan_mode_exit, stop counting
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message?.type === 'attachment') {
      if (message.attachment.type === 'plan_mode_exit') {
        break // Stop counting at the last exit
      }
      if (message.attachment.type === 'plan_mode') {
        count++
      }
    }
  }
  return count
}

/**
 * 生成规划模式（plan mode）提醒附件列表。
 *
 * 流程：
 * 1. 若当前不在 plan 模式，直接返回空数组
 * 2. 根据轮次计数节流，避免每轮都提醒（首次必附）
 * 3. 若本会话中曾退出规划模式且计划文件仍存在，附加 plan_mode_reentry 附件
 * 4. 根据 attachmentCount 决定是完整提醒（full）还是简略提醒（sparse）
 * 5. 将 plan_mode 主附件加入列表并返回
 */
async function getPlanModeAttachments(
  messages: Message[] | undefined,
  toolUseContext: ToolUseContext,
): Promise<Attachment[]> {
  const appState = toolUseContext.getAppState()
  const permissionContext = appState.toolPermissionContext
  if (permissionContext.mode !== 'plan') {
    return []
  }

  // Check if we should attach based on turn count (except for first turn)
  if (messages && messages.length > 0) {
    const { turnCount, foundPlanModeAttachment } =
      getPlanModeAttachmentTurnCount(messages)
    // Only throttle if we've already sent a plan_mode attachment before
    // On first turn in plan mode, always attach
    if (
      foundPlanModeAttachment &&
      turnCount < PLAN_MODE_ATTACHMENT_CONFIG.TURNS_BETWEEN_ATTACHMENTS
    ) {
      return []
    }
  }

  const planFilePath = getPlanFilePath(toolUseContext.agentId)
  const existingPlan = getPlan(toolUseContext.agentId)

  const attachments: Attachment[] = []

  // Check for re-entry: flag is set AND plan file exists
  if (hasExitedPlanModeInSession() && existingPlan !== null) {
    attachments.push({ type: 'plan_mode_reentry', planFilePath })
    setHasExitedPlanMode(false) // Clear flag - one-time guidance
  }

  // Determine if this should be a full or sparse reminder
  // Full reminder on 1st, 6th, 11th... (every Nth attachment)
  const attachmentCount =
    countPlanModeAttachmentsSinceLastExit(messages ?? []) + 1
  const reminderType: 'full' | 'sparse' =
    attachmentCount %
      PLAN_MODE_ATTACHMENT_CONFIG.FULL_REMINDER_EVERY_N_ATTACHMENTS ===
    1
      ? 'full'
      : 'sparse'

  // Always add the main plan_mode attachment
  attachments.push({
    type: 'plan_mode',
    reminderType,
    isSubAgent: !!toolUseContext.agentId,
    planFilePath,
    planExists: existingPlan !== null,
  })

  return attachments
}

/**
 * 生成退出规划模式的一次性通知附件。
 *
 * 当 needsPlanModeExitAttachment() 标志为 true 且当前不在 plan 模式时，
 * 清除标志并返回 plan_mode_exit 附件，告知模型已退出规划模式。
 * 若标志未设置或当前仍在 plan 模式，返回空数组。
 */
async function getPlanModeExitAttachment(
  toolUseContext: ToolUseContext,
): Promise<Attachment[]> {
  // Only trigger if the flag is set (we just exited plan mode)
  if (!needsPlanModeExitAttachment()) {
    return []
  }

  const appState = toolUseContext.getAppState()
  if (appState.toolPermissionContext.mode === 'plan') {
    setNeedsPlanModeExitAttachment(false)
    return []
  }

  // Clear the flag - this is a one-time notification
  setNeedsPlanModeExitAttachment(false)

  const planFilePath = getPlanFilePath(toolUseContext.agentId)
  const planExists = getPlan(toolUseContext.agentId) !== null

  // Note: skill discovery does NOT fire on plan exit. By the time the plan is
  // written, it's too late — the model should have had relevant skills WHILE
  // planning. The user_message signal already fires on the request that
  // triggers planning ("plan how to deploy this"), which is the right moment.
  return [{ type: 'plan_mode_exit', planFilePath, planExists }]
}

/**
 * 统计距上次 auto_mode 附件以来经过的人类轮次数，并判断是否已发送过 auto_mode 附件。
 *
 * 从消息列表末尾向前遍历，计数非 meta、非工具结果的用户消息，
 * 遇到 auto_mode 附件时停止并标记 foundAutoModeAttachment=true，
 * 遇到 auto_mode_exit 时中断（退出重置节流计数器）。
 * 用于判断当前是否需要再次附加自动模式提醒。
 */
function getAutoModeAttachmentTurnCount(messages: Message[]): {
  turnCount: number
  foundAutoModeAttachment: boolean
} {
  let turnsSinceLastAttachment = 0
  let foundAutoModeAttachment = false

  // Iterate backwards to find most recent auto_mode attachment.
  // Count HUMAN turns (non-meta, non-tool-result user messages), not assistant
  // messages — the tool loop in query.ts calls getAttachmentMessages on every
  // tool round, so a single human turn with 100 tool calls would fire ~20
  // reminders if we counted assistant messages. Auto mode's target use case is
  // long agentic sessions, where this accumulated 60-105× per session.
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]

    if (
      message?.type === 'user' &&
      !message.isMeta &&
      !hasToolResultContent(message.message.content)
    ) {
      turnsSinceLastAttachment++
    } else if (
      message?.type === 'attachment' &&
      message.attachment.type === 'auto_mode'
    ) {
      foundAutoModeAttachment = true
      break
    } else if (
      message?.type === 'attachment' &&
      message.attachment.type === 'auto_mode_exit'
    ) {
      // Exit resets the throttle — treat as if no prior attachment exists
      break
    }
  }

  return { turnCount: turnsSinceLastAttachment, foundAutoModeAttachment }
}

/**
 * 统计自上次 auto_mode_exit 以来的 auto_mode 附件数量。
 * 用于确定当前是第几次提醒，决定使用完整（full）还是简略（sparse）提醒格式。
 * 重新进入自动模式时，计数从 auto_mode_exit 后重置，保证 full/sparse 周期正确。
 */
function countAutoModeAttachmentsSinceLastExit(messages: Message[]): number {
  let count = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message?.type === 'attachment') {
      if (message.attachment.type === 'auto_mode_exit') {
        break
      }
      if (message.attachment.type === 'auto_mode') {
        count++
      }
    }
  }
  return count
}

/**
 * 生成自动模式（auto mode）提醒附件列表。
 *
 * 在 mode==='auto' 或 plan-with-auto-active 时触发。
 * 根据轮次计数节流（首次必附），并依据 attachmentCount 决定 full/sparse 格式。
 * 返回包含 reminderType 的 auto_mode 附件数组。
 */
async function getAutoModeAttachments(
  messages: Message[] | undefined,
  toolUseContext: ToolUseContext,
): Promise<Attachment[]> {
  const appState = toolUseContext.getAppState()
  const permissionContext = appState.toolPermissionContext
  const inAuto = permissionContext.mode === 'auto'
  const inPlanWithAuto =
    permissionContext.mode === 'plan' &&
    (autoModeStateModule?.isAutoModeActive() ?? false)
  if (!inAuto && !inPlanWithAuto) {
    return []
  }

  // Check if we should attach based on turn count (except for first turn)
  if (messages && messages.length > 0) {
    const { turnCount, foundAutoModeAttachment } =
      getAutoModeAttachmentTurnCount(messages)
    // Only throttle if we've already sent an auto_mode attachment before
    // On first turn in auto mode, always attach
    if (
      foundAutoModeAttachment &&
      turnCount < AUTO_MODE_ATTACHMENT_CONFIG.TURNS_BETWEEN_ATTACHMENTS
    ) {
      return []
    }
  }

  // Determine if this should be a full or sparse reminder
  const attachmentCount =
    countAutoModeAttachmentsSinceLastExit(messages ?? []) + 1
  const reminderType: 'full' | 'sparse' =
    attachmentCount %
      AUTO_MODE_ATTACHMENT_CONFIG.FULL_REMINDER_EVERY_N_ATTACHMENTS ===
    1
      ? 'full'
      : 'sparse'

  return [{ type: 'auto_mode', reminderType }]
}

/**
 * 生成退出自动模式的一次性通知附件。
 *
 * 当 needsAutoModeExitAttachment() 为 true 且当前确实不在自动模式时，
 * 清除标志并返回 auto_mode_exit 附件，告知模型已退出自动模式。
 * 若自动模式仍处于活跃状态（包括 plan-with-auto），则清除标志并返回空数组。
 */
async function getAutoModeExitAttachment(
  toolUseContext: ToolUseContext,
): Promise<Attachment[]> {
  if (!needsAutoModeExitAttachment()) {
    return []
  }

  const appState = toolUseContext.getAppState()
  // Suppress when auto is still active — covers both mode==='auto' and
  // plan-with-auto-active (where mode==='plan' but classifier runs).
  if (
    appState.toolPermissionContext.mode === 'auto' ||
    (autoModeStateModule?.isAutoModeActive() ?? false)
  ) {
    setNeedsAutoModeExitAttachment(false)
    return []
  }

  setNeedsAutoModeExitAttachment(false)
  return [{ type: 'auto_mode_exit' }]
}

/**
 * 检测本地日期是否跨越午夜，并在变更时发出 date_change 附件通知模型。
 *
 * 首次调用时仅记录日期，不生成附件。
 * 日期发生变化时更新缓存日期并返回附件；未变化时返回空数组。
 * 注意：有意保留 messages[0] 中的旧日期，避免清除缓存前缀导致大量 cache_creation tokens。
 * 若 KAIROS 功能启用且处于活跃状态，还会触发跨日 transcript 片段落盘。
 *
 * Detects when the local date has changed since the last turn (user coding
 * past midnight) and emits an attachment to notify the model.
 *
 * Exported for testing — regression guard for the cache-clear removal.
 */
export function getDateChangeAttachments(
  messages: Message[] | undefined,
): Attachment[] {
  const currentDate = getLocalISODate()
  const lastDate = getLastEmittedDate()

  if (lastDate === null) {
    // First turn — just record, no attachment needed
    setLastEmittedDate(currentDate)
    return []
  }

  if (currentDate === lastDate) {
    return []
  }

  setLastEmittedDate(currentDate)

  // Assistant mode: flush yesterday's transcript to the per-day file so
  // the /dream skill (1–5am local) finds it even if no compaction fires
  // today. Fire-and-forget; writeSessionTranscriptSegment buckets by
  // message timestamp so a multi-day gap flushes each day correctly.
  if (feature('KAIROS')) {
    if (getKairosActive() && messages !== undefined) {
      sessionTranscriptModule?.flushOnDateChange(messages, currentDate)
    }
  }

  return [{ type: 'date_change', newDate: currentDate }]
}

/**
 * 若用户输入中包含 ultrathink 关键词且该功能已启用，返回高强度思考附件。
 * 用于提示模型在当前回合使用更深度的推理。
 */
function getUltrathinkEffortAttachment(input: string | null): Attachment[] {
  if (!isUltrathinkEnabled() || !input || !hasUltrathinkKeyword(input)) {
    return []
  }
  logEvent('tengu_ultrathink', {})
  return [{ type: 'ultrathink_effort', level: 'high' }]
}

/**
 * 生成延迟工具增量（deferred_tools_delta）附件。
 *
 * 当 ToolSearch 功能启用、模型支持工具引用且工具列表中存在 ToolSearch 工具时，
 * 计算当前工具集与消息历史中已宣告工具集之间的差异（增量），
 * 仅在有变化时返回附件。同时导出供 compact.ts 使用，保持两处逻辑一致。
 */
// Exported for compact.ts — the gate must be identical at both call sites.
export function getDeferredToolsDeltaAttachment(
  tools: Tools,
  model: string,
  messages: Message[] | undefined,
  scanContext?: DeferredToolsDeltaScanContext,
): Attachment[] {
  if (!isDeferredToolsDeltaEnabled()) return []
  // These three checks mirror the sync parts of isToolSearchEnabled —
  // the attachment text says "available via ToolSearch", so ToolSearch
  // has to actually be in the request. The async auto-threshold check
  // is not replicated (would double-fire tengu_tool_search_mode_decision);
  // in tst-auto below-threshold the attachment can fire while ToolSearch
  // is filtered out, but that's a narrow case and the tools announced
  // are directly callable anyway.
  if (!isToolSearchEnabledOptimistic()) return []
  if (!modelSupportsToolReference(model)) return []
  if (!isToolSearchToolAvailable(tools)) return []
  const delta = getDeferredToolsDelta(tools, messages ?? [], scanContext)
  if (!delta) return []
  return [{ type: 'deferred_tools_delta', ...delta }]
}

/**
 * 生成代理列表增量（agent_listing_delta）附件。
 *
 * 将当前过滤后的代理池（经 MCP 要求、拒绝规则、allowedAgentTypes 筛选）
 * 与消息历史中已宣告的代理集合进行差异比较，仅在有新增或移除时返回附件。
 * 导出供 compact.ts 在压缩后重新宣告完整代理列表使用。
 *
 * 背景：代理列表原本嵌入 AgentTool 的 description 中，导致 ~10.2% 的 cache_creation，
 * 改为此附件形式后 tool schema 保持静态，大幅减少缓存失效。
 *
 * Diff the current filtered agent pool against what's already been announced
 * in this conversation (reconstructed from prior agent_listing_delta
 * attachments). Returns [] if nothing changed or the gate is off.
 *
 * Exported for compact.ts — re-announces the full set after compaction eats
 * prior deltas.
 */
export function getAgentListingDeltaAttachment(
  toolUseContext: ToolUseContext,
  messages: Message[] | undefined,
): Attachment[] {
  if (!shouldInjectAgentListInMessages()) return []

  // Skip if AgentTool isn't in the pool — the listing would be unactionable.
  if (
    !toolUseContext.options.tools.some(t => toolMatchesName(t, AGENT_TOOL_NAME))
  ) {
    return []
  }

  const { activeAgents, allowedAgentTypes } =
    toolUseContext.options.agentDefinitions

  // Mirror AgentTool.prompt()'s filtering: MCP requirements → deny rules →
  // allowedAgentTypes restriction. Keep this in sync with AgentTool.tsx.
  const mcpServers = new Set<string>()
  for (const tool of toolUseContext.options.tools) {
    const info = mcpInfoFromString(tool.name)
    if (info) mcpServers.add(info.serverName)
  }
  const permissionContext = toolUseContext.getAppState().toolPermissionContext
  let filtered = filterDeniedAgents(
    filterAgentsByMcpRequirements(activeAgents, [...mcpServers]),
    permissionContext,
    AGENT_TOOL_NAME,
  )
  if (allowedAgentTypes) {
    filtered = filtered.filter(a => allowedAgentTypes.includes(a.agentType))
  }

  // Reconstruct announced set from prior deltas in the transcript.
  const announced = new Set<string>()
  for (const msg of messages ?? []) {
    if (msg.type !== 'attachment') continue
    if (msg.attachment.type !== 'agent_listing_delta') continue
    for (const t of msg.attachment.addedTypes) announced.add(t)
    for (const t of msg.attachment.removedTypes) announced.delete(t)
  }

  const currentTypes = new Set(filtered.map(a => a.agentType))
  const added = filtered.filter(a => !announced.has(a.agentType))
  const removed: string[] = []
  for (const t of announced) {
    if (!currentTypes.has(t)) removed.push(t)
  }

  if (added.length === 0 && removed.length === 0) return []

  // Sort for deterministic output — agent load order is nondeterministic
  // (plugin load races, MCP async connect).
  added.sort((a, b) => a.agentType.localeCompare(b.agentType))
  removed.sort()

  return [
    {
      type: 'agent_listing_delta',
      addedTypes: added.map(a => a.agentType),
      addedLines: added.map(formatAgentLine),
      removedTypes: removed,
      isInitial: announced.size === 0,
      showConcurrencyNote: getSubscriptionType() !== 'pro',
    },
  ]
}

/**
 * 生成 MCP 服务器指令增量（mcp_instructions_delta）附件。
 *
 * 比较当前 MCP 服务器指令集合（含 ToolSearch chrome 提示）与消息历史中已宣告的内容，
 * 仅在有变更时返回附件，避免重复注入相同指令。
 * 导出供 compact.ts 和 reactiveCompact.ts 使用，作为统一的开关判断入口。
 */
// Exported for compact.ts / reactiveCompact.ts — single source of truth for the gate.
export function getMcpInstructionsDeltaAttachment(
  mcpClients: MCPServerConnection[],
  tools: Tools,
  model: string,
  messages: Message[] | undefined,
): Attachment[] {
  if (!isMcpInstructionsDeltaEnabled()) return []

  // The chrome ToolSearch hint is client-authored and ToolSearch-conditional;
  // actual server `instructions` are unconditional. Decide the chrome part
  // here, pass it into the pure diff as a synthesized entry.
  const clientSide: ClientSideInstruction[] = []
  if (
    isToolSearchEnabledOptimistic() &&
    modelSupportsToolReference(model) &&
    isToolSearchToolAvailable(tools)
  ) {
    clientSide.push({
      serverName: CLAUDE_IN_CHROME_MCP_SERVER_NAME,
      block: CHROME_TOOL_SEARCH_INSTRUCTIONS,
    })
  }

  const delta = getMcpInstructionsDelta(mcpClients, messages ?? [], clientSide)
  if (!delta) return []
  return [{ type: 'mcp_instructions_delta', ...delta }]
}

/**
 * 若 toolUseContext 中携带了 criticalSystemReminder_EXPERIMENTAL，
 * 将其包装为 critical_system_reminder 附件返回，否则返回空数组。
 */
function getCriticalSystemReminderAttachment(
  toolUseContext: ToolUseContext,
): Attachment[] {
  const reminder = toolUseContext.criticalSystemReminder_EXPERIMENTAL
  if (!reminder) {
    return []
  }
  return [{ type: 'critical_system_reminder', content: reminder }]
}

/**
 * 若设置中配置了非默认的输出样式（outputStyle），返回 output_style 附件。
 * 用于告知模型当前会话期望的响应格式（如 concise、verbose 等）。
 */
function getOutputStyleAttachment(): Attachment[] {
  const settings = getSettings_DEPRECATED()
  const outputStyle = settings?.outputStyle || 'default'

  // Only show for non-default styles
  if (outputStyle === 'default') {
    return []
  }

  return [
    {
      type: 'output_style',
      style: outputStyle,
    },
  ]
}

/**
 * 获取 IDE 中用户选中行的内容并生成 selected_lines_in_ide 附件。
 *
 * 仅当 IDE 已连接、存在有效选区（含行号、文本和文件路径）
 * 且文件未被权限策略拒绝时，才生成附件。
 * 附件包含 IDE 名称、起止行号、文件名及选中文本内容。
 */
async function getSelectedLinesFromIDE(
  ideSelection: IDESelection | null,
  toolUseContext: ToolUseContext,
): Promise<Attachment[]> {
  const ideName = getConnectedIdeName(toolUseContext.options.mcpClients)
  if (
    !ideName ||
    ideSelection?.lineStart === undefined ||
    !ideSelection.text ||
    !ideSelection.filePath
  ) {
    return []
  }

  const appState = toolUseContext.getAppState()
  if (isFileReadDenied(ideSelection.filePath, appState.toolPermissionContext)) {
    return []
  }

  return [
    {
      type: 'selected_lines_in_ide',
      ideName,
      lineStart: ideSelection.lineStart,
      lineEnd: ideSelection.lineStart + ideSelection.lineCount - 1,
      filename: ideSelection.filePath,
      content: ideSelection.text,
      displayPath: relative(getCwd(), ideSelection.filePath),
    },
  ]
}

/**
 * 计算嵌套内存文件加载所需处理的目录列表。
 *
 * 返回两个列表（均从父级到子级排序）：
 * - nestedDirs：从 CWD 到 targetPath 目录之间的各层目录（处理 CLAUDE.md 及所有规则）
 * - cwdLevelDirs：从根目录到 CWD 的各层目录（仅处理条件规则）
 *
 * Computes the directories to process for nested memory file loading.
 * Returns two lists:
 * - nestedDirs: Directories between CWD and targetPath (processed for CLAUDE.md + all rules)
 * - cwdLevelDirs: Directories from root to CWD (processed for conditional rules only)
 *
 * @param targetPath The target file path
 * @param originalCwd The original current working directory
 * @returns Object with nestedDirs and cwdLevelDirs arrays, both ordered from parent to child
 */
export function getDirectoriesToProcess(
  targetPath: string,
  originalCwd: string,
): { nestedDirs: string[]; cwdLevelDirs: string[] } {
  // Build list of directories from original CWD to targetPath's directory
  const targetDir = dirname(resolve(targetPath))
  const nestedDirs: string[] = []
  let currentDir = targetDir

  // Walk up from target directory to original CWD
  while (currentDir !== originalCwd && currentDir !== parse(currentDir).root) {
    if (currentDir.startsWith(originalCwd)) {
      nestedDirs.push(currentDir)
    }
    currentDir = dirname(currentDir)
  }

  // Reverse to get order from CWD down to target
  nestedDirs.reverse()

  // Build list of directories from root to CWD (for conditional rules only)
  const cwdLevelDirs: string[] = []
  currentDir = originalCwd

  while (currentDir !== parse(currentDir).root) {
    cwdLevelDirs.push(currentDir)
    currentDir = dirname(currentDir)
  }

  // Reverse to get order from root to CWD
  cwdLevelDirs.reverse()

  return { nestedDirs, cwdLevelDirs }
}

/**
 * Converts memory files to attachments, filtering out already-loaded files.
 *
 * @param memoryFiles The memory files to convert
 * @param toolUseContext The tool use context (for tracking loaded files)
 * @returns Array of nested memory attachments
 */
/**
 * 判断内存文件类型是否属于"指令"类型（User/Project/Local/Managed）。
 * 用于区分 CLAUDE.md 系列指令文件与其他类型的内存文件。
 */
function isInstructionsMemoryType(
  type: MemoryFileInfo['type'],
): type is InstructionsMemoryType {
  return (
    type === 'User' ||
    type === 'Project' ||
    type === 'Local' ||
    type === 'Managed'
  )
}

/**
 * 将内存文件列表转换为 nested_memory 附件列表，过滤已加载文件。
 *
 * 使用两级去重策略：
 * - loadedNestedMemoryPaths（非 LRU Set）：会话级永久去重
 * - readFileState（100 条 LRU）：在繁忙会话中可能驱逐条目
 * 两者都通过检查后才跳过，确保 LRU 驱逐时不会重复注入。
 * 新文件同时加入 readFileState，并可选触发 InstructionsLoaded 钩子。
 *
 * Exported for testing — regression guard for LRU-eviction re-injection.
 */
export function memoryFilesToAttachments(
  memoryFiles: MemoryFileInfo[],
  toolUseContext: ToolUseContext,
  triggerFilePath?: string,
): Attachment[] {
  const attachments: Attachment[] = []
  const shouldFireHook = hasInstructionsLoadedHook()

  for (const memoryFile of memoryFiles) {
    // Dedup: loadedNestedMemoryPaths is a non-evicting Set; readFileState
    // is a 100-entry LRU that drops entries in busy sessions, so relying
    // on it alone re-injects the same CLAUDE.md on every eviction cycle.
    if (toolUseContext.loadedNestedMemoryPaths?.has(memoryFile.path)) {
      continue
    }
    if (!toolUseContext.readFileState.has(memoryFile.path)) {
      attachments.push({
        type: 'nested_memory',
        path: memoryFile.path,
        content: memoryFile,
        displayPath: relative(getCwd(), memoryFile.path),
      })
      toolUseContext.loadedNestedMemoryPaths?.add(memoryFile.path)

      // Mark as loaded in readFileState — this provides cross-function and
      // cross-turn dedup via the .has() check above.
      //
      // When the injected content doesn't match disk (stripped HTML comments,
      // stripped frontmatter, truncated MEMORY.md), cache the RAW disk bytes
      // with `isPartialView: true`. Edit/Write see the flag and require a real
      // Read first; getChangedFiles sees real content + undefined offset/limit
      // so mid-session change detection still works.
      toolUseContext.readFileState.set(memoryFile.path, {
        content: memoryFile.contentDiffersFromDisk
          ? (memoryFile.rawContent ?? memoryFile.content)
          : memoryFile.content,
        timestamp: Date.now(),
        offset: undefined,
        limit: undefined,
        isPartialView: memoryFile.contentDiffersFromDisk,
      })


      // Fire InstructionsLoaded hook for audit/observability (fire-and-forget)
      if (shouldFireHook && isInstructionsMemoryType(memoryFile.type)) {
        const loadReason = memoryFile.globs
          ? 'path_glob_match'
          : memoryFile.parent
            ? 'include'
            : 'nested_traversal'
        void executeInstructionsLoadedHooks(
          memoryFile.path,
          memoryFile.type,
          loadReason,
          {
            globs: memoryFile.globs,
            triggerFilePath,
            parentFilePath: memoryFile.parent,
          },
        )
      }
    }
  }

  return attachments
}

/**
 * 为指定文件路径加载嵌套内存文件并生成附件列表。
 *
 * 处理顺序（必须保持）：
 * 1. Managed/User 条件规则（匹配 targetPath）
 * 2. 嵌套目录（CWD → target）：CLAUDE.md + 无条件规则 + 条件规则
 * 3. CWD 级别目录（root → CWD）：仅条件规则
 *
 * 若 targetPath 不在允许的工作路径内，直接返回空数组。
 * 通过 processedPaths Set 防止重复处理同一文件。
 *
 * Loads nested memory files for a given file path and returns them as attachments.
 * This function performs directory traversal to find CLAUDE.md files and conditional rules
 * that apply to the target file path.
 *
 * @param filePath The file path to get nested memory files for
 * @param toolUseContext The tool use context
 * @param appState The app state containing tool permission context
 * @returns Array of nested memory attachments
 */
async function getNestedMemoryAttachmentsForFile(
  filePath: string,
  toolUseContext: ToolUseContext,
  appState: { toolPermissionContext: ToolPermissionContext },
): Promise<Attachment[]> {
  const attachments: Attachment[] = []

  try {
    // Early return if path is not in allowed working path
    if (!pathInAllowedWorkingPath(filePath, appState.toolPermissionContext)) {
      return attachments
    }

    const processedPaths = new Set<string>()
    const originalCwd = getOriginalCwd()

    // Phase 1: Process Managed and User conditional rules
    const managedUserRules = await getManagedAndUserConditionalRules(
      filePath,
      processedPaths,
    )
    attachments.push(
      ...memoryFilesToAttachments(managedUserRules, toolUseContext, filePath),
    )

    // Phase 2: Get directories to process
    const { nestedDirs, cwdLevelDirs } = getDirectoriesToProcess(
      filePath,
      originalCwd,
    )

    const skipProjectLevel = getFeatureValue_CACHED_MAY_BE_STALE(
      'tengu_paper_halyard',
      false,
    )

    // Phase 3: Process nested directories (CWD → target)
    // Each directory gets: CLAUDE.md + unconditional rules + conditional rules
    for (const dir of nestedDirs) {
      const memoryFiles = (
        await getMemoryFilesForNestedDirectory(dir, filePath, processedPaths)
      ).filter(
        f => !skipProjectLevel || (f.type !== 'Project' && f.type !== 'Local'),
      )
      attachments.push(
        ...memoryFilesToAttachments(memoryFiles, toolUseContext, filePath),
      )
    }

    // Phase 4: Process CWD-level directories (root → CWD)
    // Only conditional rules (unconditional rules are already loaded eagerly)
    for (const dir of cwdLevelDirs) {
      const conditionalRules = (
        await getConditionalRulesForCwdLevelDirectory(
          dir,
          filePath,
          processedPaths,
        )
      ).filter(
        f => !skipProjectLevel || (f.type !== 'Project' && f.type !== 'Local'),
      )
      attachments.push(
        ...memoryFilesToAttachments(conditionalRules, toolUseContext, filePath),
      )
    }
  } catch (error) {
    logError(error)
  }

  return attachments
}

/**
 * 获取 IDE 中当前打开文件的附件（无选中文本时触发）。
 *
 * 仅当 IDE 有打开文件路径且未选中任何文本，且文件未被权限策略拒绝时才处理。
 * 先加载该文件对应的嵌套内存附件（CLAUDE.md 等），再返回 opened_file_in_ide 附件。
 */
async function getOpenedFileFromIDE(
  ideSelection: IDESelection | null,
  toolUseContext: ToolUseContext,
): Promise<Attachment[]> {
  if (!ideSelection?.filePath || ideSelection.text) {
    return []
  }

  const appState = toolUseContext.getAppState()
  if (isFileReadDenied(ideSelection.filePath, appState.toolPermissionContext)) {
    return []
  }

  // Get nested memory files
  const nestedMemoryAttachments = await getNestedMemoryAttachmentsForFile(
    ideSelection.filePath,
    toolUseContext,
    appState,
  )

  // Return nested memory attachments followed by the opened file attachment
  return [
    ...nestedMemoryAttachments,
    {
      type: 'opened_file_in_ide',
      filename: ideSelection.filePath,
    },
  ]
}

/**
 * 处理用户输入中的 @提及文件，生成对应的文件内容附件。
 *
 * 从输入中提取所有 @文件引用，并行处理每个引用：
 * - 权限检查（isFileReadDenied）
 * - 目录：读取条目列表（最多 1000 条），生成 directory 附件
 * - 普通文件：调用 generateFileAttachment（支持行号范围）
 * 任何错误均记录日志并跳过，最终过滤 null 值。
 */
async function processAtMentionedFiles(
  input: string,
  toolUseContext: ToolUseContext,
): Promise<Attachment[]> {
  const files = extractAtMentionedFiles(input)
  if (files.length === 0) return []

  const appState = toolUseContext.getAppState()
  const results = await Promise.all(
    files.map(async file => {
      try {
        const { filename, lineStart, lineEnd } = parseAtMentionedFileLines(file)
        const absoluteFilename = expandPath(filename)

        if (
          isFileReadDenied(absoluteFilename, appState.toolPermissionContext)
        ) {
          return null
        }

        // Check if it's a directory
        try {
          const stats = await stat(absoluteFilename)
          if (stats.isDirectory()) {
            try {
              const entries = await readdir(absoluteFilename, {
                withFileTypes: true,
              })
              const MAX_DIR_ENTRIES = 1000
              const truncated = entries.length > MAX_DIR_ENTRIES
              const names = entries.slice(0, MAX_DIR_ENTRIES).map(e => e.name)
              if (truncated) {
                names.push(
                  `\u2026 and ${entries.length - MAX_DIR_ENTRIES} more entries`,
                )
              }
              const stdout = names.join('\n')
              logEvent('tengu_at_mention_extracting_directory_success', {})

              return {
                type: 'directory' as const,
                path: absoluteFilename,
                content: stdout,
                displayPath: relative(getCwd(), absoluteFilename),
              }
            } catch {
              return null
            }
          }
        } catch {
          // If stat fails, continue with file logic
        }

        return await generateFileAttachment(
          absoluteFilename,
          toolUseContext,
          'tengu_at_mention_extracting_filename_success',
          'tengu_at_mention_extracting_filename_error',
          'at-mention',
          {
            offset: lineStart,
            limit: lineEnd && lineStart ? lineEnd - lineStart + 1 : undefined,
          },
        )
      } catch {
        logEvent('tengu_at_mention_extracting_filename_error', {})
      }
    }),
  )
  return results.filter(Boolean) as Attachment[]
}

/**
 * 处理用户输入中的 @代理提及，生成 agent_mention 附件列表。
 *
 * 提取输入中的代理引用（如 @agent-xxx），查找匹配的代理定义，
 * 未找到时记录事件并跳过，成功时返回包含 agentType 的附件。
 */
function processAgentMentions(
  input: string,
  agents: AgentDefinition[],
): Attachment[] {
  const agentMentions = extractAgentMentions(input)
  if (agentMentions.length === 0) return []

  const results = agentMentions.map(mention => {
    const agentType = mention.replace('agent-', '')
    const agentDef = agents.find(def => def.agentType === agentType)

    if (!agentDef) {
      logEvent('tengu_at_mention_agent_not_found', {})
      return null
    }

    logEvent('tengu_at_mention_agent_success', {})

    return {
      type: 'agent_mention' as const,
      agentType: agentDef.agentType,
    }
  })

  return results.filter(
    (result): result is NonNullable<typeof result> => result !== null,
  )
}

/**
 * 处理用户输入中的 @MCP 资源提及，生成 mcp_resource 附件列表。
 *
 * 提取输入中的 MCP 资源引用（格式为 server:uri），并行调用对应 MCP 客户端读取资源内容，
 * 客户端不存在、未连接或读取失败时均记录事件并跳过，成功时返回资源内容附件。
 */
async function processMcpResourceAttachments(
  input: string,
  toolUseContext: ToolUseContext,
): Promise<Attachment[]> {
  const resourceMentions = extractMcpResourceMentions(input)
  if (resourceMentions.length === 0) return []

  const mcpClients = toolUseContext.options.mcpClients || []

  const results = await Promise.all(
    resourceMentions.map(async mention => {
      try {
        const [serverName, ...uriParts] = mention.split(':')
        const uri = uriParts.join(':') // Rejoin in case URI contains colons

        if (!serverName || !uri) {
          logEvent('tengu_at_mention_mcp_resource_error', {})
          return null
        }

        // Find the MCP client
        const client = mcpClients.find(c => c.name === serverName)
        if (!client || client.type !== 'connected') {
          logEvent('tengu_at_mention_mcp_resource_error', {})
          return null
        }

        // Find the resource in available resources to get its metadata
        const serverResources =
          toolUseContext.options.mcpResources?.[serverName] || []
        const resourceInfo = serverResources.find(r => r.uri === uri)
        if (!resourceInfo) {
          logEvent('tengu_at_mention_mcp_resource_error', {})
          return null
        }

        try {
          const result = await client.client.readResource({
            uri,
          })

          logEvent('tengu_at_mention_mcp_resource_success', {})

          return {
            type: 'mcp_resource' as const,
            server: serverName,
            uri,
            name: resourceInfo.name || uri,
            description: resourceInfo.description,
            content: result,
          }
        } catch (error) {
          logEvent('tengu_at_mention_mcp_resource_error', {})
          logError(error)
          return null
        }
      } catch {
        logEvent('tengu_at_mention_mcp_resource_error', {})
        return null
      }
    }),
  )

  return results.filter(
    (result): result is NonNullable<typeof result> => result !== null,
  ) as Attachment[]
}

/**
 * 检测已读取文件的磁盘变更并生成相应的文件变更附件。
 *
 * 遍历 readFileState 缓存中的所有文件路径，检查修改时间：
 * - 文本文件：生成差异片段（edited_text_file）
 * - 图片文件：重新读取并压缩（edited_image_file）
 * - 其他类型（notebook/pdf）：跳过
 * 权限拒绝或文件已删除（ENOENT）时从缓存移除条目；
 * 其他瞬时错误（原子保存竞态、权限抖动）不驱逐，避免误判文件缺失。
 */
export async function getChangedFiles(
  toolUseContext: ToolUseContext,
): Promise<Attachment[]> {
  const filePaths = cacheKeys(toolUseContext.readFileState)
  if (filePaths.length === 0) return []

  const appState = toolUseContext.getAppState()
  const results = await Promise.all(
    filePaths.map(async filePath => {
      const fileState = toolUseContext.readFileState.get(filePath)
      if (!fileState) return null

      // TODO: Implement offset/limit support for changed files
      if (fileState.offset !== undefined || fileState.limit !== undefined) {
        return null
      }

      const normalizedPath = expandPath(filePath)

      // Check if file has a deny rule configured
      if (isFileReadDenied(normalizedPath, appState.toolPermissionContext)) {
        return null
      }

      try {
        const mtime = await getFileModificationTimeAsync(normalizedPath)
        if (mtime <= fileState.timestamp) {
          return null
        }

        const fileInput = { file_path: normalizedPath }

        // Validate file path is valid
        const isValid = await FileReadTool.validateInput(
          fileInput,
          toolUseContext,
        )
        if (!isValid.result) {
          return null
        }

        const result = await FileReadTool.call(fileInput, toolUseContext)
        // Extract only the changed section
        if (result.data.type === 'text') {
          const snippet = getSnippetForTwoFileDiff(
            fileState.content,
            result.data.file.content,
          )

          // File was touched but not modified
          if (snippet === '') {
            return null
          }

          return {
            type: 'edited_text_file' as const,
            filename: normalizedPath,
            snippet,
          }
        }

        // For non-text files (images), apply the same token limit logic as FileReadTool
        if (result.data.type === 'image') {
          try {
            const data = await readImageWithTokenBudget(normalizedPath)
            return {
              type: 'edited_image_file' as const,
              filename: normalizedPath,
              content: data,
            }
          } catch (compressionError) {
            logError(compressionError)
            logEvent('tengu_watched_file_compression_failed', {
              file: normalizedPath,
            } as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS)
            return null
          }
        }

        // notebook / pdf / parts — no diff representation; explicitly
        // null so the map callback has no implicit-undefined path.
        return null
      } catch (err) {
        // Evict ONLY on ENOENT (file truly deleted). Transient stat
        // failures — atomic-save races (editor writes tmp→rename and
        // stat hits the gap), EACCES churn, network-FS hiccups — must
        // NOT evict, or the next Edit fails code-6 even though the
        // file still exists and the model just read it. VS Code
        // auto-save/format-on-save hits this race especially often.
        // See regression analysis on PR #18525.
        if (isENOENT(err)) {
          toolUseContext.readFileState.delete(filePath)
        }
        return null
      }
    }),
  )
  return results.filter(result => result != null) as Attachment[]
}

/**
 * 处理 nestedMemoryAttachmentTriggers 中的路径，为每个触发路径加载嵌套内存附件。
 *
 * 优先检查触发集合是否为空（避免不必要的 getAppState 调用）。
 * 依次处理每个触发路径，调用 getNestedMemoryAttachmentsForFile 收集附件，
 * 完成后清空触发集合，防止重复加载。
 *
 * Processes paths that need nested memory attachments and checks for nested CLAUDE.md files
 * Uses nestedMemoryAttachmentTriggers field from ToolUseContext
 */
async function getNestedMemoryAttachments(
  toolUseContext: ToolUseContext,
): Promise<Attachment[]> {
  // Check triggers first — getAppState() waits for a React render cycle,
  // and the common case is an empty trigger set.
  if (
    !toolUseContext.nestedMemoryAttachmentTriggers ||
    toolUseContext.nestedMemoryAttachmentTriggers.size === 0
  ) {
    return []
  }

  const appState = toolUseContext.getAppState()
  const attachments: Attachment[] = []

  for (const filePath of toolUseContext.nestedMemoryAttachmentTriggers) {
    const nestedAttachments = await getNestedMemoryAttachmentsForFile(
      filePath,
      toolUseContext,
      appState,
    )
    attachments.push(...nestedAttachments)
  }

  toolUseContext.nestedMemoryAttachmentTriggers.clear()

  return attachments
}

/**
 * 根据用户输入检索与当前上下文相关的内存文件并生成 relevant_memories 附件。
 *
 * 若有 @代理提及，仅在该代理的内存目录中搜索（隔离原则）。
 * 否则扫描全局内存目录，结合近期工具使用记录和已展示路径集合过滤结果，
 * 返回相关性最高的内存文件附件列表。
 */
/**
 * 查找并返回与当前用户输入最相关的内存文件附件。
 *
 * 若用户输入中提及了代理（@agent-xxx），仅搜索该代理的专属内存目录；
 * 否则搜索通用自动内存目录（auto-memory dir）。支持多目录并行搜索，
 * 最终合并结果、过滤已浮现过的文件及已读文件，限制最多返回 5 条记录。
 */
async function getRelevantMemoryAttachments(
  input: string,
  agents: AgentDefinition[],
  readFileState: FileStateCache,
  recentTools: readonly string[],
  signal: AbortSignal,
  alreadySurfaced: ReadonlySet<string>,
): Promise<Attachment[]> {
  // If an agent is @-mentioned, search only its memory dir (isolation).
  // Otherwise search the auto-memory dir.
  const memoryDirs = extractAgentMentions(input).flatMap(mention => {
    const agentType = mention.replace('agent-', '')
    const agentDef = agents.find(def => def.agentType === agentType)
    return agentDef?.memory
      ? [getAgentMemoryDir(agentType, agentDef.memory)]
      : []
  })
  const dirs = memoryDirs.length > 0 ? memoryDirs : [getAutoMemPath()]

  const allResults = await Promise.all(
    dirs.map(dir =>
      findRelevantMemories(
        input,
        dir,
        signal,
        recentTools,
        alreadySurfaced,
      ).catch(() => []),
    ),
  )
  // alreadySurfaced is filtered inside the selector so Sonnet spends its
  // 5-slot budget on fresh candidates; readFileState catches files the
  // model read via FileReadTool. The redundant alreadySurfaced check here
  // is a belt-and-suspenders guard (multi-dir results may re-introduce a
  // path the selector filtered in a different dir).
  const selected = allResults
    .flat()
    .filter(m => !readFileState.has(m.path) && !alreadySurfaced.has(m.path))
    .slice(0, 5)

  const memories = await readMemoriesForSurfacing(selected, signal)

  if (memories.length === 0) {
    return []
  }
  return [{ type: 'relevant_memories' as const, memories }]
}

/**
 * 扫描消息历史中已展示的内存文件路径及累计字节数。
 *
 * 遍历消息列表中的 relevant_memories 附件，收集所有已展示路径（用于选择器去重）
 * 和累计字节数（用于会话级限额节流）。
 * 通过扫描消息而非跟踪上下文状态，使压缩（compact）自然重置去重状态。
 *
 * Scan messages for past relevant_memories attachments.  Returns both the
 * set of surfaced paths (for selector de-dup) and cumulative byte count
 * (for session-total throttle).
 */
export function collectSurfacedMemories(messages: ReadonlyArray<Message>): {
  paths: Set<string>
  totalBytes: number
} {
  const paths = new Set<string>()
  let totalBytes = 0
  for (const m of messages) {
    if (m.type === 'attachment' && m.attachment.type === 'relevant_memories') {
      for (const mem of m.attachment.memories) {
        paths.add(mem.path)
        totalBytes += mem.content.length
      }
    }
  }
  return { paths, totalBytes }
}

/**
 * 并行读取一批相关内存文件用于注入 `<system-reminder>` 附件。
 *
 * 对每个文件应用 MAX_MEMORY_LINES 和 MAX_MEMORY_BYTES 双重限制。
 * 截断时附加说明提示（保留文件头部上下文，而非整体丢弃），
 * 读取失败则返回 null 并过滤，确保部分失败不影响其余文件。
 *
 * Reads a set of relevance-ranked memory files for injection as
 * <system-reminder> attachments.
 *
 * Exported for direct testing without mocking the ranker + GB gates.
 */
export async function readMemoriesForSurfacing(
  selected: ReadonlyArray<{ path: string; mtimeMs: number }>,
  signal?: AbortSignal,
): Promise<
  Array<{
    path: string
    content: string
    mtimeMs: number
    header: string
    limit?: number
  }>
> {
  const results = await Promise.all(
    selected.map(async ({ path: filePath, mtimeMs }) => {
      try {
        const result = await readFileInRange(
          filePath,
          0,
          MAX_MEMORY_LINES,
          MAX_MEMORY_BYTES,
          signal,
          { truncateOnByteLimit: true },
        )
        const truncated =
          result.totalLines > MAX_MEMORY_LINES || result.truncatedByBytes
        const content = truncated
          ? result.content +
            `\n\n> This memory file was truncated (${result.truncatedByBytes ? `${MAX_MEMORY_BYTES} byte limit` : `first ${MAX_MEMORY_LINES} lines`}). Use the ${FILE_READ_TOOL_NAME} tool to view the complete file at: ${filePath}`
          : result.content
        return {
          path: filePath,
          content,
          mtimeMs,
          header: memoryHeader(filePath, mtimeMs),
          limit: truncated ? result.lineCount : undefined,
        }
      } catch {
        return null
      }
    }),
  )
  return results.filter(r => r !== null)
}

/**
 * 生成相关内存块的标题字符串（包含新鲜度信息）。
 *
 * 若文件有新鲜度文本（如"刚更新"），格式为 "{freshness}\n\nMemory: {path}:"；
 * 否则格式为 "Memory (saved {age}): {path}:"。
 * 导出供 messages.ts 在会话恢复时补充缺失的 header 字段。
 *
 * Header string for a relevant-memory block.  Exported so messages.ts
 * can fall back for resumed sessions where the stored header is missing.
 */
export function memoryHeader(path: string, mtimeMs: number): string {
  const staleness = memoryFreshnessText(mtimeMs)
  return staleness
    ? `${staleness}\n\nMemory: ${path}:`
    : `Memory (saved ${memoryAge(mtimeMs)}): ${path}:`
}

/**
 * 内存相关性预取句柄类型。
 * promise 在每个用户轮次启动一次，在主模型流式输出和工具执行期间并发运行。
 * settledAt 由 promise.finally() 设置（完成前为 null）；
 * consumedOnIteration 由 query.ts 的收集点设置（消费前为 -1）。
 * 通过 `using` 绑定，[Symbol.dispose] 在所有退出路径（return/throw/.return()）触发，
 * 中止飞行中的请求并上报遥测，无需在循环内 ~13 个返回点逐一埋点。
 */
export type MemoryPrefetch = {
  promise: Promise<Attachment[]>
  /** Set by promise.finally(). null until the promise settles. */
  settledAt: number | null
  /** Set by the collect point in query.ts. -1 until consumed. */
  consumedOnIteration: number
  [Symbol.dispose](): void
}

/**
 * 启动相关内存检索的异步预取，返回可处置的 MemoryPrefetch 句柄。
 *
 * 从消息历史中提取最后一条真实用户提示（排除 isMeta 消息），
 * 检查会话字节总量是否超限，满足条件后异步发起 getRelevantMemoryAttachments。
 * 返回的句柄包含 promise、settledAt（完成时间戳）和 consumedOnIteration（消费轮次）；
 * 通过 `using` 绑定，确保查询循环退出时中止飞行中的请求并上报遥测。
 * 单词输入或配置未启用时返回 undefined。
 *
 * Starts the relevant memory search as an async prefetch.
 * Bound with `using` in query.ts.
 */
export function startRelevantMemoryPrefetch(
  messages: ReadonlyArray<Message>,
  toolUseContext: ToolUseContext,
): MemoryPrefetch | undefined {
  if (
    !isAutoMemoryEnabled() ||
    !getFeatureValue_CACHED_MAY_BE_STALE('tengu_moth_copse', false)
  ) {
    return undefined
  }

  const lastUserMessage = messages.findLast(m => m.type === 'user' && !m.isMeta)
  if (!lastUserMessage) {
    return undefined
  }

  const input = getUserMessageText(lastUserMessage)
  // Single-word prompts lack enough context for meaningful term extraction
  if (!input || !/\s/.test(input.trim())) {
    return undefined
  }

  const surfaced = collectSurfacedMemories(messages)
  if (surfaced.totalBytes >= RELEVANT_MEMORIES_CONFIG.MAX_SESSION_BYTES) {
    return undefined
  }

  // Chained to the turn-level abort so user Escape cancels the sideQuery
  // immediately, not just on [Symbol.dispose] when queryLoop exits.
  const controller = createChildAbortController(toolUseContext.abortController)
  const firedAt = Date.now()
  const promise = getRelevantMemoryAttachments(
    input,
    toolUseContext.options.agentDefinitions.activeAgents,
    toolUseContext.readFileState,
    collectRecentSuccessfulTools(messages, lastUserMessage),
    controller.signal,
    surfaced.paths,
  ).catch(e => {
    if (!isAbortError(e)) {
      logError(e)
    }
    return []
  })

  const handle: MemoryPrefetch = {
    promise,
    settledAt: null,
    consumedOnIteration: -1,
    [Symbol.dispose]() {
      controller.abort()
      logEvent('tengu_memdir_prefetch_collected', {
        hidden_by_first_iteration:
          handle.settledAt !== null && handle.consumedOnIteration === 0,
        consumed_on_iteration: handle.consumedOnIteration,
        latency_ms: (handle.settledAt ?? Date.now()) - firedAt,
      })
    },
  }
  void promise.finally(() => {
    handle.settledAt = Date.now()
  })
  return handle
}

type ToolResultBlock = {
  type: 'tool_result'
  tool_use_id: string
  is_error?: boolean
}

/**
 * 类型守卫：判断给定对象是否为 ToolResultBlock。
 * 用于在消息内容数组中识别工具调用结果块，区分普通文本与工具结果。
 */
function isToolResultBlock(b: unknown): b is ToolResultBlock {
  return (
    typeof b === 'object' &&
    b !== null &&
    (b as ToolResultBlock).type === 'tool_result' &&
    typeof (b as ToolResultBlock).tool_use_id === 'string'
  )
}

/**
 * 检查用户消息内容中是否包含 tool_result 块。
 *
 * 比通过 toolUseResult === undefined 检查更可靠，
 * 因为子代理工具结果消息在 preserveToolUseResults=false 时会显式将 toolUseResult 置为 undefined。
 *
 * Check whether a user message's content contains tool_result blocks.
 */
function hasToolResultContent(content: unknown): boolean {
  return Array.isArray(content) && content.some(isToolResultBlock)
}

/**
 * 收集上一个真实轮次边界以来成功执行过（且从未出错）的工具名称列表。
 *
 * 内存选择器用此结果抑制"已在正常工作的工具"的参考文档，避免噪声。
 * 从消息末尾向前扫描：tool_use 在助手内容中，tool_result 在用户内容中；
 * 反向扫描先收集结果再匹配名称，最终返回成功且未曾报错的工具名集合。
 *
 * Tools that succeeded (and never errored) since the previous real turn boundary.
 * Any error → tool excluded. No result yet → also excluded.
 */
export function collectRecentSuccessfulTools(
  messages: ReadonlyArray<Message>,
  lastUserMessage: Message,
): readonly string[] {
  const useIdToName = new Map<string, string>()
  const resultByUseId = new Map<string, boolean>()
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (!m) continue
    if (isHumanTurn(m) && m !== lastUserMessage) break
    if (m.type === 'assistant' && typeof m.message.content !== 'string') {
      for (const block of m.message.content) {
        if (block.type === 'tool_use') useIdToName.set(block.id, block.name)
      }
    } else if (
      m.type === 'user' &&
      'message' in m &&
      Array.isArray(m.message.content)
    ) {
      for (const block of m.message.content) {
        if (isToolResultBlock(block)) {
          resultByUseId.set(block.tool_use_id, block.is_error === true)
        }
      }
    }
  }
  const failed = new Set<string>()
  const succeeded = new Set<string>()
  for (const [id, name] of useIdToName) {
    const errored = resultByUseId.get(id)
    if (errored === undefined) continue
    if (errored) {
      failed.add(name)
    } else {
      succeeded.add(name)
    }
  }
  return [...succeeded].filter(t => !failed.has(t))
}


/**
 * 过滤预取内存附件中与上下文重复的条目，并将幸存者写入 readFileState。
 *
 * 过滤逻辑：排除已通过 FileRead/Write/Edit 工具读取或已在前轮展示的文件（均记录在 readFileState 中）。
 * 过滤后再写入 readFileState（顺序关键）：若在预取时写入，自引用过滤会将所有路径误判为"已在上下文中"。
 *
 * Filters prefetched memory attachments to exclude memories the model already
 * has in context, and marks survivors in readFileState for dedup on subsequent turns.
 */
export function filterDuplicateMemoryAttachments(
  attachments: Attachment[],
  readFileState: FileStateCache,
): Attachment[] {
  return attachments
    .map(attachment => {
      if (attachment.type !== 'relevant_memories') return attachment
      const filtered = attachment.memories.filter(
        m => !readFileState.has(m.path),
      )
      for (const m of filtered) {
        readFileState.set(m.path, {
          content: m.content,
          timestamp: m.mtimeMs,
          offset: undefined,
          limit: m.limit,
        })
      }
      return filtered.length > 0 ? { ...attachment, memories: filtered } : null
    })
    .filter((a): a is Attachment => a !== null)
}

/**
 * 处理文件操作期间发现的技能目录，生成 dynamic_skill 附件列表。
 *
 * 遍历 dynamicSkillDirTriggers 中的目录，并发检查各子目录是否包含 SKILL.md，
 * 有效技能目录生成附件后清空触发集合。
 * Uses dynamicSkillDirTriggers field from ToolUseContext
 */
async function getDynamicSkillAttachments(
  toolUseContext: ToolUseContext,
): Promise<Attachment[]> {
  const attachments: Attachment[] = []

  if (
    toolUseContext.dynamicSkillDirTriggers &&
    toolUseContext.dynamicSkillDirTriggers.size > 0
  ) {
    // Parallelize: readdir all skill dirs concurrently
    const perDirResults = await Promise.all(
      Array.from(toolUseContext.dynamicSkillDirTriggers).map(async skillDir => {
        try {
          const entries = await readdir(skillDir, { withFileTypes: true })
          const candidates = entries
            .filter(e => e.isDirectory() || e.isSymbolicLink())
            .map(e => e.name)
          // Parallelize: stat all SKILL.md candidates concurrently
          const checked = await Promise.all(
            candidates.map(async name => {
              try {
                await stat(resolve(skillDir, name, 'SKILL.md'))
                return name
              } catch {
                return null // SKILL.md doesn't exist, skip this entry
              }
            }),
          )
          return {
            skillDir,
            skillNames: checked.filter((n): n is string => n !== null),
          }
        } catch {
          // Ignore errors reading skill directories (e.g., directory doesn't exist)
          return { skillDir, skillNames: [] }
        }
      }),
    )

    for (const { skillDir, skillNames } of perDirResults) {
      if (skillNames.length > 0) {
        attachments.push({
          type: 'dynamic_skill',
          skillDir,
          skillNames,
          displayPath: relative(getCwd(), skillDir),
        })
      }
    }

    toolUseContext.dynamicSkillDirTriggers.clear()
  }

  return attachments
}

// Track which skills have been sent to avoid re-sending. Keyed by agentId
// (empty string = main thread) so subagents get their own turn-0 listing —
// without per-agent scoping, the main thread populating this Set would cause
// every subagent's filterToBundledAndMcp result to dedup to empty.
const sentSkillNames = new Map<string, Set<string>>()

// Called when the skill set genuinely changes (plugin reload, skill file
// change on disk) so new skills get announced. NOT called on compact —
// post-compact re-injection costs ~4K tokens/event for marginal benefit.
/**
 * 重置已发送技能名称的跟踪集合，并清除下一次列表压制标志。
 * 当技能集合发生真实变更（插件重载、技能文件修改）时调用，
 * 使后续轮次能重新宣告新增技能；compact 后不调用，避免高昂的重注入成本。
 */
export function resetSentSkillNames(): void {
  sentSkillNames.clear()
  suppressNext = false
}

/**
 * 压制下一次技能列表注入。
 *
 * 在 --resume 时由 conversationRecovery 调用，因为技能列表附件已存在于历史 transcript 中，
 * 无需再次注入。通过标记 sentSkillNames 为"已全部发送"来跳过本次宣告。
 *
 * Suppress the next skill-listing injection. Called by conversationRecovery
 * on --resume when a skill_listing attachment already exists in the transcript.
 */
export function suppressNextSkillListing(): void {
  suppressNext = true
}
let suppressNext = false

// When skill-search is enabled and the filtered (bundled + MCP) listing exceeds
// this count, fall back to bundled-only. Protects MCP-heavy users (100+ servers)
// from truncation while keeping the turn-0 guarantee for typical setups.
const FILTERED_LISTING_MAX = 30

/**
 * 将技能列表过滤为 bundled（Anthropic 内置）和 MCP（用户连接）两类。
 *
 * 当 skill-search 功能启用时使用，解决子代理的第 0 轮技能发现缺口。
 * 若 bundled+MCP 总数超过 FILTERED_LISTING_MAX，则进一步缩减为仅 bundled，
 * 保护 MCP 重度用户（100+ 服务器）免于截断。
 *
 * Filter skills to bundled (Anthropic-curated) + MCP (user-connected) only.
 * Falls back to bundled-only if bundled+mcp exceeds FILTERED_LISTING_MAX.
 */
export function filterToBundledAndMcp(commands: Command[]): Command[] {
  const filtered = commands.filter(
    cmd => cmd.loadedFrom === 'bundled' || cmd.loadedFrom === 'mcp',
  )
  if (filtered.length > FILTERED_LISTING_MAX) {
    return filtered.filter(cmd => cmd.loadedFrom === 'bundled')
  }
  return filtered
}

/**
 * 生成技能列表（skill_listing）附件，告知模型当前可调用的技能集合。
 *
 * 仅在 Skill 工具存在于工具列表时触发；--resume 后通过 suppressNext
 * 跳过重注入（已在历史 transcript 中）；
 * 启用 EXPERIMENTAL_SKILL_SEARCH 时仅宣告 bundled + MCP 技能，减少 token 占用。
 * 将新技能名称记入 sentSkillNames，后续轮次只追加增量。
 */
async function getSkillListingAttachments(
  toolUseContext: ToolUseContext,
): Promise<Attachment[]> {
  if (process.env.NODE_ENV === 'test') {
    return []
  }

  // Skip skill listing for agents that don't have the Skill tool — they can't use skills directly.
  if (
    !toolUseContext.options.tools.some(t => toolMatchesName(t, SKILL_TOOL_NAME))
  ) {
    return []
  }

  const cwd = getProjectRoot()
  const localCommands = await getSkillToolCommands(cwd)
  const mcpSkills = getMcpSkillCommands(
    toolUseContext.getAppState().mcp.commands,
  )
  let allCommands =
    mcpSkills.length > 0
      ? uniqBy([...localCommands, ...mcpSkills], 'name')
      : localCommands

  // When skill search is active, filter to bundled + MCP instead of full
  // suppression. Resolves the turn-0 gap: main thread gets turn-0 discovery
  // via getTurnZeroSkillDiscovery (blocking), but subagents use the async
  // subagent_spawn signal (collected post-tools, visible turn 1). Bundled +
  // MCP are small and intent-signaled; user/project/plugin skills go through
  // discovery. feature() first for DCE — the property-access string leaks
  // otherwise even with ?. on null.
  if (
    feature('EXPERIMENTAL_SKILL_SEARCH') &&
    skillSearchModules?.featureCheck.isSkillSearchEnabled()
  ) {
    allCommands = filterToBundledAndMcp(allCommands)
  }

  const agentKey = toolUseContext.agentId ?? ''
  let sent = sentSkillNames.get(agentKey)
  if (!sent) {
    sent = new Set()
    sentSkillNames.set(agentKey, sent)
  }

  // Resume path: prior process already injected a listing; it's in the
  // transcript. Mark everything current as sent so only post-resume deltas
  // (skills loaded later via /reload-plugins etc) get announced.
  if (suppressNext) {
    suppressNext = false
    for (const cmd of allCommands) {
      sent.add(cmd.name)
    }
    return []
  }

  // Find skills we haven't sent yet
  const newSkills = allCommands.filter(cmd => !sent.has(cmd.name))

  if (newSkills.length === 0) {
    return []
  }

  // If no skills have been sent yet, this is the initial batch
  const isInitial = sent.size === 0

  // Mark as sent
  for (const cmd of newSkills) {
    sent.add(cmd.name)
  }

  logForDebugging(
    `Sending ${newSkills.length} skills via attachment (${isInitial ? 'initial' : 'dynamic'}, ${sent.size} total sent)`,
  )

  // Format within budget using existing logic
  const contextWindowTokens = getContextWindowForModel(
    toolUseContext.options.mainLoopModel,
    getSdkBetas(),
  )
  const content = formatCommandsWithinBudget(newSkills, contextWindowTokens)

  return [
    {
      type: 'skill_listing',
      content,
      skillCount: newSkills.length,
      isInitial,
    },
  ]
}

// getSkillDiscoveryAttachment moved to skillSearch/prefetch.ts as
// getTurnZeroSkillDiscovery — keeps the 'skill_discovery' string literal inside
// a feature-gated module so it doesn't leak into external builds.

/**
 * 从用户输入文本中提取所有 @文件引用，支持普通路径和含空格的引号路径。
 * 支持行号范围语法（@file.txt#L10-20），过滤代理提及（以 "(agent)" 结尾的引号提及）。
 * 返回去重后的文件路径列表。
 */
export function extractAtMentionedFiles(content: string): string[] {
  // Extract filenames mentioned with @ symbol, including line range syntax: @file.txt#L10-20
  // Also supports quoted paths for files with spaces: @"my/file with spaces.txt"
  // Example: "foo bar @baz moo" would extract "baz"
  // Example: 'check @"my file.txt" please' would extract "my file.txt"

  // Two patterns: quoted paths and regular paths
  const quotedAtMentionRegex = /(^|\s)@"([^"]+)"/g
  const regularAtMentionRegex = /(^|\s)@([^\s]+)\b/g

  const quotedMatches: string[] = []
  const regularMatches: string[] = []

  // Extract quoted mentions first (skip agent mentions like @"code-reviewer (agent)")
  let match
  while ((match = quotedAtMentionRegex.exec(content)) !== null) {
    if (match[2] && !match[2].endsWith(' (agent)')) {
      quotedMatches.push(match[2]) // The content inside quotes
    }
  }

  // Extract regular mentions
  const regularMatchArray = content.match(regularAtMentionRegex) || []
  regularMatchArray.forEach(match => {
    const filename = match.slice(match.indexOf('@') + 1)
    // Don't include if it starts with a quote (already handled as quoted)
    if (!filename.startsWith('"')) {
      regularMatches.push(filename)
    }
  })

  // Combine and deduplicate
  return uniq([...quotedMatches, ...regularMatches])
}

/**
 * 从用户输入文本中提取所有 @MCP 资源引用，格式为 @server:uri。
 * 仅匹配包含冒号的复合引用（区别于普通文件路径），去重后返回资源 URI 列表。
 */
export function extractMcpResourceMentions(content: string): string[] {
  // Extract MCP resources mentioned with @ symbol in format @server:uri
  // Example: "@server1:resource/path" would extract "server1:resource/path"
  const atMentionRegex = /(^|\s)@([^\s]+:[^\s]+)\b/g
  const matches = content.match(atMentionRegex) || []

  // Remove the prefix (everything before @) from each match
  return uniq(matches.map(match => match.slice(match.indexOf('@') + 1)))
}

/**
 * 从用户输入文本中提取所有代理（agent）提及，支持两种格式：
 * - 传统格式：@agent-<type>（如 @agent-code-elegance-refiner）
 * - 自动补全格式：@"<type> (agent)"（如 @"code-reviewer (agent)"）
 * 返回代理类型名称列表（去除前缀和括号后缀）。
 */
/**
 * 从用户输入文本中提取代理提及，支持两种格式：
 * 1. 旧版/手动输入：@agent-<type>（如 @agent-code-elegance-refiner）
 * 2. 自动补全选择：@"<type> (agent)"（如 @"code-reviewer (agent)"）
 * 支持含冒号、点号、at 符号的插件作用域代理名称（如 @agent-asana:project-status-updater）。
 * 返回去重后的代理类型名称列表。
 */
export function extractAgentMentions(content: string): string[] {
  // Extract agent mentions in two formats:
  // 1. @agent-<agent-type> (legacy/manual typing)
  //    Example: "@agent-code-elegance-refiner" → "agent-code-elegance-refiner"
  // 2. @"<agent-type> (agent)" (from autocomplete selection)
  //    Example: '@"code-reviewer (agent)"' → "code-reviewer"
  // Supports colons, dots, and at-signs for plugin-scoped agents like "@agent-asana:project-status-updater"
  const results: string[] = []

  // Match quoted format: @"<type> (agent)"
  const quotedAgentRegex = /(^|\s)@"([\w:.@-]+) \(agent\)"/g
  let match
  while ((match = quotedAgentRegex.exec(content)) !== null) {
    if (match[2]) {
      results.push(match[2])
    }
  }

  // Match unquoted format: @agent-<type>
  const unquotedAgentRegex = /(^|\s)@(agent-[\w:.@-]+)/g
  const unquotedMatches = content.match(unquotedAgentRegex) || []
  for (const m of unquotedMatches) {
    results.push(m.slice(m.indexOf('@') + 1))
  }

  return uniq(results)
}

interface AtMentionedFileLines {
  filename: string
  lineStart?: number
  lineEnd?: number
}

/**
 * 解析 @提及字符串中的文件名和行号范围。
 * 支持格式：file.txt、file.txt#L10、file.txt#L10-20、file.txt#heading。
 * 非行号片段（如 #heading）会被忽略，只提取 L 前缀的数字行号范围。
 */
export function parseAtMentionedFileLines(
  mention: string,
): AtMentionedFileLines {
  // Parse mentions like "file.txt#L10-20", "file.txt#heading", or just "file.txt"
  // Supports line ranges (#L10, #L10-20) and strips non-line-range fragments (#heading)
  const match = mention.match(/^([^#]+)(?:#L(\d+)(?:-(\d+))?)?(?:#[^#]*)?$/)

  if (!match) {
    return { filename: mention }
  }

  const [, filename, lineStartStr, lineEndStr] = match
  const lineStart = lineStartStr ? parseInt(lineStartStr, 10) : undefined
  const lineEnd = lineEndStr ? parseInt(lineEndStr, 10) : lineStart

  return { filename: filename ?? mention, lineStart, lineEnd }
}

/**
 * 收集 IDE 诊断（LSP 错误/警告）和终端诊断附件。
 * 仅当工具列表包含 Bash 工具时才注入（无执行能力时诊断无意义）。
 * 合并 LSP 诊断附件与通用诊断附件，返回所有诊断 Attachment 列表。
 */
async function getDiagnosticAttachments(
  toolUseContext: ToolUseContext,
): Promise<Attachment[]> {
  // Diagnostics are only useful if the agent has the Bash tool to act on them
  if (
    !toolUseContext.options.tools.some(t => toolMatchesName(t, BASH_TOOL_NAME))
  ) {
    return []
  }

  // Get new diagnostics from the tracker (IDE diagnostics via MCP)
  const newDiagnostics = await diagnosticTracker.getNewDiagnostics()
  if (newDiagnostics.length === 0) {
    return []
  }

  return [
    {
      type: 'diagnostics',
      files: newDiagnostics,
      isNew: true,
    },
  ]
}

/**
 * 从被动 LSP 服务器获取诊断附件。
 * 仅当工具列表包含 Bash 工具时才处理（无执行能力时 LSP 诊断无意义）。
 * 获取后清空注册表中已交付的诊断，防止内存泄漏，遵循 AsyncHookRegistry 模式。
 *
 * Get LSP diagnostic attachments from passive LSP servers.
 * Follows the AsyncHookRegistry pattern for consistent async attachment delivery.
 */
async function getLSPDiagnosticAttachments(
  toolUseContext: ToolUseContext,
): Promise<Attachment[]> {
  // LSP diagnostics are only useful if the agent has the Bash tool to act on them
  if (
    !toolUseContext.options.tools.some(t => toolMatchesName(t, BASH_TOOL_NAME))
  ) {
    return []
  }

  logForDebugging('LSP Diagnostics: getLSPDiagnosticAttachments called')

  try {
    const diagnosticSets = checkForLSPDiagnostics()

    if (diagnosticSets.length === 0) {
      return []
    }

    logForDebugging(
      `LSP Diagnostics: Found ${diagnosticSets.length} pending diagnostic set(s)`,
    )

    // Convert each diagnostic set to an attachment
    const attachments: Attachment[] = diagnosticSets.map(({ files }) => ({
      type: 'diagnostics' as const,
      files,
      isNew: true,
    }))

    // Clear delivered diagnostics from registry to prevent memory leak
    // Follows same pattern as removeDeliveredAsyncHooks
    if (diagnosticSets.length > 0) {
      clearAllLSPDiagnostics()
      logForDebugging(
        `LSP Diagnostics: Cleared ${diagnosticSets.length} delivered diagnostic(s) from registry`,
      )
    }

    logForDebugging(
      `LSP Diagnostics: Returning ${attachments.length} diagnostic attachment(s)`,
    )

    return attachments
  } catch (error) {
    const err = toError(error)
    logError(
      new Error(`Failed to get LSP diagnostic attachments: ${err.message}`),
    )
    // Return empty array to allow other attachments to proceed
    return []
  }
}

/**
 * 异步生成器：将所有附件批量转换为消息，逐步 yield 给调用方（query.ts 工具循环）。
 *
 * 工作流程：先通过 getAttachments() 并发收集所有附件，然后对每个 Attachment
 * 调用 createAttachmentMessage() 生成带 cache-control 的用户消息块，
 * 最终 yield 消息列表供主循环注入到对话历史。
 *
 * 每次工具调用后均会调用本函数，以在对话历史中追加最新上下文。
 */
export async function* getAttachmentMessages(
  input: string | null,
  toolUseContext: ToolUseContext,
  ideSelection: IDESelection | null,
  queuedCommands: QueuedCommand[],
  messages?: Message[],
  querySource?: QuerySource,
  options?: { skipSkillDiscovery?: boolean },
): AsyncGenerator<AttachmentMessage, void> {
  // TODO: Compute this upstream
  const attachments = await getAttachments(
    input,
    toolUseContext,
    ideSelection,
    queuedCommands,
    messages,
    querySource,
    options,
  )

  if (attachments.length === 0) {
    return
  }

  logEvent('tengu_attachments', {
    attachment_types: attachments.map(
      _ => _.type,
    ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  })

  for (const attachment of attachments) {
    yield createAttachmentMessage(attachment)
  }
}

/**
 * Generates a file attachment by reading a file with proper validation and truncation.
 * This is the core file reading logic shared between @-mentioned files and post-compact restoration.
 *
 * @param filename The absolute path to the file to read
 * @param toolUseContext The tool use context for calling FileReadTool
 * @param options Optional configuration for file reading
 * @returns A new_file attachment or null if the file couldn't be read
 */
/**
 * 检查 PDF 文件是否应返回轻量引用而非内联。
 * 当页数超过 PDF_AT_MENTION_INLINE_THRESHOLD 时返回 PDFReferenceAttachment，
 * 否则返回 null（表示应正常内联读取）。
 * 页数通过 pdfinfo 获取，失败时按文件大小（100KB/页）估算。
 *
 * Check if a PDF file should be represented as a lightweight reference
 * instead of being inlined. Returns a PDFReferenceAttachment for large PDFs
 * (more than PDF_AT_MENTION_INLINE_THRESHOLD pages), or null otherwise.
 */
export async function tryGetPDFReference(
  filename: string,
): Promise<PDFReferenceAttachment | null> {
  const ext = parse(filename).ext.toLowerCase()
  if (!isPDFExtension(ext)) {
    return null
  }
  try {
    const [stats, pageCount] = await Promise.all([
      getFsImplementation().stat(filename),
      getPDFPageCount(filename),
    ])
    // Use page count if available, otherwise fall back to size heuristic (~100KB per page)
    const effectivePageCount = pageCount ?? Math.ceil(stats.size / (100 * 1024))
    if (effectivePageCount > PDF_AT_MENTION_INLINE_THRESHOLD) {
      logEvent('tengu_pdf_reference_attachment', {
        pageCount: effectivePageCount,
        fileSize: stats.size,
        hadPdfinfo: pageCount !== null,
      } as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS)
      return {
        type: 'pdf_reference',
        filename,
        pageCount: effectivePageCount,
        fileSize: stats.size,
        displayPath: relative(getCwd(), filename),
      }
    }
  } catch {
    // If we can't stat the file, return null to proceed with normal reading
  }
  return null
}

/**
 * 读取文件并生成文件附件，是 @提及文件 和 compact 后恢复文件 的共享核心逻辑。
 *
 * 执行流程：
 * 1. 检查文件是否被 deny 规则拒绝
 * 2. at-mention 模式下检查文件大小限制（超限的非 PDF 直接返回 null）
 * 3. 大 PDF 返回 PDFReferenceAttachment 轻量引用而非内联
 * 4. 检查文件是否已在上下文中且未修改（返回 already_read_file）
 * 5. 通过 FileReadTool 读取文件，超长时调用内部 readTruncatedFile 截断
 */
export async function generateFileAttachment(
  filename: string,
  toolUseContext: ToolUseContext,
  successEventName: string,
  errorEventName: string,
  mode: 'compact' | 'at-mention',
  options?: {
    offset?: number
    limit?: number
  },
): Promise<
  | FileAttachment
  | CompactFileReferenceAttachment
  | PDFReferenceAttachment
  | AlreadyReadFileAttachment
  | null
> {
  const { offset, limit } = options ?? {}

  // Check if file has a deny rule configured
  const appState = toolUseContext.getAppState()
  if (isFileReadDenied(filename, appState.toolPermissionContext)) {
    return null
  }

  // Check file size before attempting to read (skip for PDFs — they have their own size/page handling below)
  if (
    mode === 'at-mention' &&
    !isFileWithinReadSizeLimit(
      filename,
      getDefaultFileReadingLimits().maxSizeBytes,
    )
  ) {
    const ext = parse(filename).ext.toLowerCase()
    if (!isPDFExtension(ext)) {
      try {
        const stats = await getFsImplementation().stat(filename)
        logEvent('tengu_attachment_file_too_large', {
          size_bytes: stats.size,
          mode,
        } as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS)
        return null
      } catch {
        // If we can't stat the file, proceed with normal reading (will fail later if file doesn't exist)
      }
    }
  }

  // For large PDFs on @ mention, return a lightweight reference instead of inlining
  if (mode === 'at-mention') {
    const pdfRef = await tryGetPDFReference(filename)
    if (pdfRef) {
      return pdfRef
    }
  }

  // Check if file is already in context with latest version
  const existingFileState = toolUseContext.readFileState.get(filename)
  if (existingFileState && mode === 'at-mention') {
    try {
      // Check if the file has been modified since we last read it
      const mtimeMs = await getFileModificationTimeAsync(filename)

      // Handle timestamp format inconsistency:
      // - FileReadTool stores Date.now() (current time when read)
      // - FileEdit/WriteTools store mtimeMs (file modification time)
      //
      // If timestamp > mtimeMs, it was stored by FileReadTool using Date.now()
      // In this case, we should not use the optimization since we can't reliably
      // compare modification times. Only use optimization when timestamp <= mtimeMs,
      // indicating it was stored by FileEdit/WriteTool with actual mtimeMs.

      if (
        existingFileState.timestamp <= mtimeMs &&
        mtimeMs === existingFileState.timestamp
      ) {
        // File hasn't been modified, return already_read_file attachment
        // This tells the system the file is already in context and doesn't need to be sent to API
        logEvent(successEventName, {})
        return {
          type: 'already_read_file',
          filename,
          displayPath: relative(getCwd(), filename),
          content: {
            type: 'text',
            file: {
              filePath: filename,
              content: existingFileState.content,
              numLines: countCharInString(existingFileState.content, '\n') + 1,
              startLine: offset ?? 1,
              totalLines:
                countCharInString(existingFileState.content, '\n') + 1,
            },
          },
        }
      }
    } catch {
      // If we can't stat the file, proceed with normal reading
    }
  }

  try {
    const fileInput = {
      file_path: filename,
      offset,
      limit,
    }

    async function readTruncatedFile(): Promise<
      | FileAttachment
      | CompactFileReferenceAttachment
      | AlreadyReadFileAttachment
      | null
    > {
      if (mode === 'compact') {
        return {
          type: 'compact_file_reference',
          filename,
          displayPath: relative(getCwd(), filename),
        }
      }

      // Check deny rules before reading truncated file
      const appState = toolUseContext.getAppState()
      if (isFileReadDenied(filename, appState.toolPermissionContext)) {
        return null
      }

      try {
        // Read only the first MAX_LINES_TO_READ lines for files that are too large
        const truncatedInput = {
          file_path: filename,
          offset: offset ?? 1,
          limit: MAX_LINES_TO_READ,
        }
        const result = await FileReadTool.call(truncatedInput, toolUseContext)
        logEvent(successEventName, {})

        return {
          type: 'file' as const,
          filename,
          content: result.data,
          truncated: true,
          displayPath: relative(getCwd(), filename),
        }
      } catch {
        logEvent(errorEventName, {})
        return null
      }
    }

    // Validate file path is valid
    const isValid = await FileReadTool.validateInput(fileInput, toolUseContext)
    if (!isValid.result) {
      return null
    }

    try {
      const result = await FileReadTool.call(fileInput, toolUseContext)
      logEvent(successEventName, {})
      return {
        type: 'file',
        filename,
        content: result.data,
        displayPath: relative(getCwd(), filename),
      }
    } catch (error) {
      if (
        error instanceof MaxFileReadTokenExceededError ||
        error instanceof FileTooLargeError
      ) {
        return await readTruncatedFile()
      }
      throw error
    }
  } catch {
    logEvent(errorEventName, {})
    return null
  }
}

/**
 * 将单个 Attachment 对象包装为带时间戳的 AttachmentMessage。
 * 所有附件在注入对话历史前均通过本函数转换，时间戳用于追踪附件注入时机。
 */
export function createAttachmentMessage(
  attachment: Attachment,
): AttachmentMessage {
  return {
    attachment,
    type: 'attachment',
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
  }
}

/**
 * 统计消息历史中距最后一次 TodoWrite 操作和距最后一次提醒的助手轮次数。
 * 从消息列表末尾向前遍历，跳过 thinking 消息，
 * 分别记录 lastTodoWriteIndex 和 lastReminderIndex，
 * 并累计各自之前的助手轮数，用于判断是否应触发 todo 提醒。
 */
function getTodoReminderTurnCounts(messages: Message[]): {
  turnsSinceLastTodoWrite: number
  turnsSinceLastReminder: number
} {
  let lastTodoWriteIndex = -1
  let lastReminderIndex = -1
  let assistantTurnsSinceWrite = 0
  let assistantTurnsSinceReminder = 0

  // Iterate backwards to find most recent events
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]

    if (message?.type === 'assistant') {
      if (isThinkingMessage(message)) {
        // Skip thinking messages
        continue
      }

      // Check for TodoWrite usage BEFORE incrementing counter
      // (we don't want to count the TodoWrite message itself as "1 turn since write")
      if (
        lastTodoWriteIndex === -1 &&
        'message' in message &&
        Array.isArray(message.message?.content) &&
        message.message.content.some(
          block => block.type === 'tool_use' && block.name === 'TodoWrite',
        )
      ) {
        lastTodoWriteIndex = i
      }

      // Count assistant turns before finding events
      if (lastTodoWriteIndex === -1) assistantTurnsSinceWrite++
      if (lastReminderIndex === -1) assistantTurnsSinceReminder++
    } else if (
      lastReminderIndex === -1 &&
      message?.type === 'attachment' &&
      message.attachment.type === 'todo_reminder'
    ) {
      lastReminderIndex = i
    }

    if (lastTodoWriteIndex !== -1 && lastReminderIndex !== -1) {
      break
    }
  }

  return {
    turnsSinceLastTodoWrite: assistantTurnsSinceWrite,
    turnsSinceLastReminder: assistantTurnsSinceReminder,
  }
}

/**
 * 根据 todo 提醒策略决定是否生成 todo_reminder 附件。
 * 当 TodoWrite 工具不可用、Brief 工具存在（精简工作流）、消息为空、
 * 或距上次写 Todo/提醒的轮次未达阈值时，返回空数组；
 * 否则返回包含当前会话 todo 列表的 todo_reminder 附件。
 */
async function getTodoReminderAttachments(
  messages: Message[] | undefined,
  toolUseContext: ToolUseContext,
): Promise<Attachment[]> {
  // Skip if TodoWrite tool is not available
  if (
    !toolUseContext.options.tools.some(t =>
      toolMatchesName(t, TODO_WRITE_TOOL_NAME),
    )
  ) {
    return []
  }

  // When SendUserMessage is in the toolkit, it's the primary communication
  // channel and the model is always told to use it (#20467). TodoWrite
  // becomes a side channel — nudging the model about it conflicts with the
  // brief workflow. The tool itself stays available; this only gates the
  // "you haven't used it in a while" nag.
  if (
    BRIEF_TOOL_NAME &&
    toolUseContext.options.tools.some(t => toolMatchesName(t, BRIEF_TOOL_NAME))
  ) {
    return []
  }

  // Skip if no messages provided
  if (!messages || messages.length === 0) {
    return []
  }

  const { turnsSinceLastTodoWrite, turnsSinceLastReminder } =
    getTodoReminderTurnCounts(messages)

  // Check if we should show a reminder
  if (
    turnsSinceLastTodoWrite >= TODO_REMINDER_CONFIG.TURNS_SINCE_WRITE &&
    turnsSinceLastReminder >= TODO_REMINDER_CONFIG.TURNS_BETWEEN_REMINDERS
  ) {
    const todoKey = toolUseContext.agentId ?? getSessionId()
    const appState = toolUseContext.getAppState()
    const todos = appState.todos[todoKey] ?? []
    return [
      {
        type: 'todo_reminder',
        content: todos,
        itemCount: todos.length,
      },
    ]
  }

  return []
}

/**
 * 统计消息历史中距最后一次任务管理操作（TaskCreate/TaskUpdate）和距最后一次提醒的助手轮次数。
 * 与 getTodoReminderTurnCounts 逻辑相同，但检测的工具为 TaskCreate/TaskUpdate，
 * 用于驱动 V2 任务提醒的节奏控制。
 */
function getTaskReminderTurnCounts(messages: Message[]): {
  turnsSinceLastTaskManagement: number
  turnsSinceLastReminder: number
} {
  let lastTaskManagementIndex = -1
  let lastReminderIndex = -1
  let assistantTurnsSinceTaskManagement = 0
  let assistantTurnsSinceReminder = 0

  // Iterate backwards to find most recent events
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]

    if (message?.type === 'assistant') {
      if (isThinkingMessage(message)) {
        // Skip thinking messages
        continue
      }

      // Check for TaskCreate or TaskUpdate usage BEFORE incrementing counter
      if (
        lastTaskManagementIndex === -1 &&
        'message' in message &&
        Array.isArray(message.message?.content) &&
        message.message.content.some(
          block =>
            block.type === 'tool_use' &&
            (block.name === TASK_CREATE_TOOL_NAME ||
              block.name === TASK_UPDATE_TOOL_NAME),
        )
      ) {
        lastTaskManagementIndex = i
      }

      // Count assistant turns before finding events
      if (lastTaskManagementIndex === -1) assistantTurnsSinceTaskManagement++
      if (lastReminderIndex === -1) assistantTurnsSinceReminder++
    } else if (
      lastReminderIndex === -1 &&
      message?.type === 'attachment' &&
      message.attachment.type === 'task_reminder'
    ) {
      lastReminderIndex = i
    }

    if (lastTaskManagementIndex !== -1 && lastReminderIndex !== -1) {
      break
    }
  }

  return {
    turnsSinceLastTaskManagement: assistantTurnsSinceTaskManagement,
    turnsSinceLastReminder: assistantTurnsSinceReminder,
  }
}

/**
 * 根据 TodoV2 任务提醒策略决定是否生成 task_reminder 附件。
 * TodoV2 未启用、ant 用户、Brief 工具存在、TaskUpdate 工具不可用、
 * 消息为空或轮次未达阈值时均返回空数组；
 * 否则查询当前任务列表并返回 task_reminder 附件。
 */
async function getTaskReminderAttachments(
  messages: Message[] | undefined,
  toolUseContext: ToolUseContext,
): Promise<Attachment[]> {
  if (!isTodoV2Enabled()) {
    return []
  }

  // Skip for ant users
  if (process.env.USER_TYPE === 'ant') {
    return []
  }

  // When SendUserMessage is in the toolkit, it's the primary communication
  // channel and the model is always told to use it (#20467). TaskUpdate
  // becomes a side channel — nudging the model about it conflicts with the
  // brief workflow. The tool itself stays available; this only gates the nag.
  if (
    BRIEF_TOOL_NAME &&
    toolUseContext.options.tools.some(t => toolMatchesName(t, BRIEF_TOOL_NAME))
  ) {
    return []
  }

  // Skip if TaskUpdate tool is not available
  if (
    !toolUseContext.options.tools.some(t =>
      toolMatchesName(t, TASK_UPDATE_TOOL_NAME),
    )
  ) {
    return []
  }

  // Skip if no messages provided
  if (!messages || messages.length === 0) {
    return []
  }

  const { turnsSinceLastTaskManagement, turnsSinceLastReminder } =
    getTaskReminderTurnCounts(messages)

  // Check if we should show a reminder
  if (
    turnsSinceLastTaskManagement >= TODO_REMINDER_CONFIG.TURNS_SINCE_WRITE &&
    turnsSinceLastReminder >= TODO_REMINDER_CONFIG.TURNS_BETWEEN_REMINDERS
  ) {
    const tasks = await listTasks(getTaskListId())
    return [
      {
        type: 'task_reminder',
        content: tasks,
        itemCount: tasks.length,
      },
    ]
  }

  return []
}

/**
 * 使用统一 Task 框架获取所有后台任务的附件（替代旧版 Shell/RemoteSession/AsyncAgent 三个函数）。
 * 调用 generateTaskAttachments() 生成任务增量摘要，更新偏移量并驱逐已完成任务，
 * 最终将 TaskAttachment 转换为 task_status 类型 Attachment 返回。
 *
 * Get attachments for all unified tasks using the Task framework.
 * Replaces the old getBackgroundShellAttachments, getBackgroundRemoteSessionAttachments,
 * and getAsyncAgentAttachments functions.
 */
async function getUnifiedTaskAttachments(
  toolUseContext: ToolUseContext,
): Promise<Attachment[]> {
  const appState = toolUseContext.getAppState()
  const { attachments, updatedTaskOffsets, evictedTaskIds } =
    await generateTaskAttachments(appState)

  applyTaskOffsetsAndEvictions(
    toolUseContext.setAppState,
    updatedTaskOffsets,
    evictedTaskIds,
  )

  // Convert TaskAttachment to Attachment format
  return attachments.map(taskAttachment => ({
    type: 'task_status' as const,
    taskId: taskAttachment.taskId,
    taskType: taskAttachment.taskType,
    status: taskAttachment.status,
    description: taskAttachment.description,
    deltaSummary: taskAttachment.deltaSummary,
    outputFilePath: getTaskOutputPath(taskAttachment.taskId),
  }))
}

/**
 * 收集所有异步 Hook 回调响应并转换为 Attachment 列表。
 * Hook 脚本在后台异步执行完毕后，将响应写入临时队列；
 * 本函数在每轮对话开始前读取并清空队列，将响应注入到上下文中供模型感知。
 */
async function getAsyncHookResponseAttachments(): Promise<Attachment[]> {
  const responses = await checkForAsyncHookResponses()

  if (responses.length === 0) {
    return []
  }

  logForDebugging(
    `Hooks: getAsyncHookResponseAttachments found ${responses.length} responses`,
  )

  const attachments = responses.map(
    ({
      processId,
      response,
      hookName,
      hookEvent,
      toolName,
      pluginId,
      stdout,
      stderr,
      exitCode,
    }) => {
      logForDebugging(
        `Hooks: Creating attachment for ${processId} (${hookName}): ${jsonStringify(response)}`,
      )
      return {
        type: 'async_hook_response' as const,
        processId,
        hookName,
        hookEvent,
        toolName,
        response,
        stdout,
        stderr,
        exitCode,
      }
    },
  )

  // Remove delivered hooks from registry to prevent re-processing
  if (responses.length > 0) {
    const processIds = responses.map(r => r.processId)
    removeDeliveredAsyncHooks(processIds)
    logForDebugging(
      `Hooks: Removed ${processIds.length} delivered hooks from registry`,
    )
  }

  logForDebugging(
    `Hooks: getAsyncHookResponseAttachments found ${attachments.length} attachments`,
  )

  return attachments
}

/**
 * 获取代理群（swarm）通信中队友邮箱的消息附件。
 * 队友是并行运行的独立 Claude Code 会话（非父子子代理关系）。
 *
 * 消息来源：
 * 1. 文件邮箱（轮询间隙收到的消息）
 * 2. AppState.inbox（useInboxPoller 在对话轮次中间排队的消息）
 *
 * 重复消息通过 from+timestamp+text 前缀去重，
 * 空闲通知每个代理只保留最新一条，消息交付后标记已读。
 *
 * Get teammate mailbox attachments for agent swarm communication
 * Teammates are independent Claude Code sessions running in parallel (swarms),
 * not parent-child subagent relationships.
 *
 * This function checks two sources for messages:
 * 1. File-based mailbox (for messages that arrived between polls)
 * 2. AppState.inbox (for messages queued mid-turn by useInboxPoller)
 *
 * Messages from AppState.inbox are delivered mid-turn as attachments,
 * allowing teammates to receive messages without waiting for the turn to end.
 */
async function getTeammateMailboxAttachments(
  toolUseContext: ToolUseContext,
): Promise<Attachment[]> {
  if (!isAgentSwarmsEnabled()) {
    return []
  }
  if (process.env.USER_TYPE !== 'ant') {
    return []
  }

  // Get AppState early to check for team lead status
  const appState = toolUseContext.getAppState()

  // Use agent name from helper (checks AsyncLocalStorage, then dynamicTeamContext)
  const envAgentName = getAgentName()

  // Get team name (checks AsyncLocalStorage, dynamicTeamContext, then AppState)
  const teamName = getTeamName(appState.teamContext)

  // Check if we're the team lead (uses shared logic from swarm utils)
  const teamLeadStatus = isTeamLead(appState.teamContext)

  // Check if viewing a teammate's transcript (for in-process teammates)
  const viewedTeammate = getViewedTeammateTask(appState)

  // Resolve agent name based on who we're VIEWING:
  // - If viewing a teammate, use THEIR name (to read from their mailbox)
  // - Otherwise use env var if set, or leader's name if we're the team lead
  let agentName = viewedTeammate?.identity.agentName ?? envAgentName
  if (!agentName && teamLeadStatus && appState.teamContext) {
    const leadAgentId = appState.teamContext.leadAgentId
    // Look up the lead's name from agents map (not the UUID)
    agentName = appState.teamContext.teammates[leadAgentId]?.name || 'team-lead'
  }

  logForDebugging(
    `[SwarmMailbox] getTeammateMailboxAttachments called: envAgentName=${envAgentName}, isTeamLead=${teamLeadStatus}, resolved agentName=${agentName}, teamName=${teamName}`,
  )

  // Only check inbox if running as an agent in a swarm or team lead
  if (!agentName) {
    logForDebugging(
      `[SwarmMailbox] Not checking inbox - not in a swarm or team lead`,
    )
    return []
  }

  logForDebugging(
    `[SwarmMailbox] Checking inbox for agent="${agentName}" team="${teamName || 'default'}"`,
  )

  // Check mailbox for unread messages (routes to in-process or file-based)
  // Filter out structured protocol messages (permission requests/responses, shutdown
  // messages, etc.) — these must be left unread for useInboxPoller to route to their
  // proper handlers (workerPermissions queue, sandbox queue, etc.). Without filtering,
  // attachment generation races with InboxPoller: whichever reads first marks all
  // messages as read, and if attachments wins, protocol messages get bundled as raw
  // LLM context text instead of being routed to their UI handlers.
  const allUnreadMessages = await readUnreadMessages(agentName, teamName)
  const unreadMessages = allUnreadMessages.filter(
    m => !isStructuredProtocolMessage(m.text),
  )
  logForDebugging(
    `[MailboxBridge] Found ${allUnreadMessages.length} unread message(s) for "${agentName}" (${allUnreadMessages.length - unreadMessages.length} structured protocol messages filtered out)`,
  )

  // Also check AppState.inbox for pending messages (queued mid-turn by useInboxPoller)
  // IMPORTANT: appState.inbox contains messages FROM teammates TO the leader.
  // Only show these when viewing the leader's transcript (not a teammate's).
  // When viewing a teammate, their messages come from the file-based mailbox above.
  // In-process teammates share AppState with the leader — appState.inbox contains
  // the LEADER's queued messages, not the teammate's. Skip it to prevent leakage
  // (including self-echo from broadcasts). Teammates receive messages exclusively
  // through their file-based mailbox + waitForNextPromptOrShutdown.
  // Note: viewedTeammate was already computed above for agentName resolution
  const pendingInboxMessages =
    viewedTeammate || isInProcessTeammate()
      ? [] // Viewing teammate or running as in-process teammate - don't show leader's inbox
      : appState.inbox.messages.filter(m => m.status === 'pending')
  logForDebugging(
    `[SwarmMailbox] Found ${pendingInboxMessages.length} pending message(s) in AppState.inbox`,
  )

  // Combine both sources of messages WITH DEDUPLICATION
  // The same message could exist in both file mailbox and AppState.inbox due to race conditions:
  // 1. getTeammateMailboxAttachments reads file -> finds message M
  // 2. InboxPoller reads same file -> queues M in AppState.inbox
  // 3. getTeammateMailboxAttachments reads AppState -> finds M again
  // We deduplicate using from+timestamp+text prefix as the key
  const seen = new Set<string>()
  let allMessages: Array<{
    from: string
    text: string
    timestamp: string
    color?: string
    summary?: string
  }> = []

  for (const m of [...unreadMessages, ...pendingInboxMessages]) {
    const key = `${m.from}|${m.timestamp}|${m.text.slice(0, 100)}`
    if (!seen.has(key)) {
      seen.add(key)
      allMessages.push({
        from: m.from,
        text: m.text,
        timestamp: m.timestamp,
        color: m.color,
        summary: m.summary,
      })
    }
  }

  // Collapse multiple idle notifications per agent — keep only the latest.
  // Single pass to parse, then filter without re-parsing.
  const idleAgentByIndex = new Map<number, string>()
  const latestIdleByAgent = new Map<string, number>()
  for (let i = 0; i < allMessages.length; i++) {
    const idle = isIdleNotification(allMessages[i]!.text)
    if (idle) {
      idleAgentByIndex.set(i, idle.from)
      latestIdleByAgent.set(idle.from, i)
    }
  }
  if (idleAgentByIndex.size > latestIdleByAgent.size) {
    const beforeCount = allMessages.length
    allMessages = allMessages.filter((_m, i) => {
      const agent = idleAgentByIndex.get(i)
      if (agent === undefined) return true
      return latestIdleByAgent.get(agent) === i
    })
    logForDebugging(
      `[SwarmMailbox] Collapsed ${beforeCount - allMessages.length} duplicate idle notification(s)`,
    )
  }

  if (allMessages.length === 0) {
    logForDebugging(`[SwarmMailbox] No messages to deliver, returning empty`)
    return []
  }

  logForDebugging(
    `[SwarmMailbox] Returning ${allMessages.length} message(s) as attachment for "${agentName}" (${unreadMessages.length} from file, ${pendingInboxMessages.length} from AppState, after dedup)`,
  )

  // Build the attachment BEFORE marking messages as processed
  // This prevents message loss if any operation below fails
  const attachment: Attachment[] = [
    {
      type: 'teammate_mailbox',
      messages: allMessages,
    },
  ]

  // Mark only non-structured mailbox messages as read after attachment is built.
  // Structured protocol messages stay unread for useInboxPoller to handle.
  if (unreadMessages.length > 0) {
    await markMessagesAsReadByPredicate(
      agentName,
      m => !isStructuredProtocolMessage(m.text),
      teamName,
    )
    logForDebugging(
      `[MailboxBridge] marked ${unreadMessages.length} non-structured message(s) as read for agent="${agentName}" team="${teamName || 'default'}"`,
    )
  }

  // Process shutdown_approved messages - remove teammates from team file
  // This mirrors what useInboxPoller does in interactive mode (lines 546-606)
  // In -p mode, useInboxPoller doesn't run, so we must handle this here
  if (teamLeadStatus && teamName) {
    for (const m of allMessages) {
      const shutdownApproval = isShutdownApproved(m.text)
      if (shutdownApproval) {
        const teammateToRemove = shutdownApproval.from
        logForDebugging(
          `[SwarmMailbox] Processing shutdown_approved from ${teammateToRemove}`,
        )

        // Find the teammate ID by name
        const teammateId = appState.teamContext?.teammates
          ? Object.entries(appState.teamContext.teammates).find(
              ([, t]) => t.name === teammateToRemove,
            )?.[0]
          : undefined

        if (teammateId) {
          // Remove from team file
          removeTeammateFromTeamFile(teamName, {
            agentId: teammateId,
            name: teammateToRemove,
          })
          logForDebugging(
            `[SwarmMailbox] Removed ${teammateToRemove} from team file`,
          )

          // Unassign tasks owned by this teammate
          await unassignTeammateTasks(
            teamName,
            teammateId,
            teammateToRemove,
            'shutdown',
          )

          // Remove from teamContext in AppState
          toolUseContext.setAppState(prev => {
            if (!prev.teamContext?.teammates) return prev
            if (!(teammateId in prev.teamContext.teammates)) return prev
            const { [teammateId]: _, ...remainingTeammates } =
              prev.teamContext.teammates
            return {
              ...prev,
              teamContext: {
                ...prev.teamContext,
                teammates: remainingTeammates,
              },
            }
          })
        }
      }
    }
  }

  // Mark AppState inbox messages as processed LAST, after attachment is built
  // This ensures messages aren't lost if earlier operations fail
  if (pendingInboxMessages.length > 0) {
    const pendingIds = new Set(pendingInboxMessages.map(m => m.id))
    toolUseContext.setAppState(prev => ({
      ...prev,
      inbox: {
        messages: prev.inbox.messages.map(m =>
          pendingIds.has(m.id) ? { ...m, status: 'processed' as const } : m,
        ),
      },
    }))
  }

  return attachment
}

/**
 * 为代理群（swarm）中的队友注入团队上下文附件。
 * 仅在对话第一轮（尚无助手消息）且当前会话属于某团队时注入，
 * 包含代理 ID、代理名称、团队名称及团队配置/任务列表路径，
 * 为队友提供初始协调上下文。
 *
 * Get team context attachment for teammates in a swarm.
 * Only injected on the first turn to provide team coordination instructions.
 */
function getTeamContextAttachment(messages: Message[]): Attachment[] {
  const teamName = getTeamName()
  const agentId = getAgentId()
  const agentName = getAgentName()

  // Only inject for teammates (not team lead or non-team sessions)
  if (!teamName || !agentId) {
    return []
  }

  // Only inject on first turn - check if there are no assistant messages yet
  const hasAssistantMessage = messages.some(m => m.type === 'assistant')
  if (hasAssistantMessage) {
    return []
  }

  const configDir = getClaudeConfigHomeDir()
  const teamConfigPath = `${configDir}/teams/${teamName}/config.json`
  const taskListPath = `${configDir}/tasks/${teamName}/`

  return [
    {
      type: 'team_context',
      agentId,
      agentName: agentName || agentId,
      teamName,
      teamConfigPath,
      taskListPath,
    },
  ]
}

/**
 * 生成输入 token 使用量附件，告知模型当前上下文窗口的已用和剩余 token 数。
 * 计算所有消息的 token 总量与模型上下文窗口大小，
 * 当使用量超过阈值时返回 context_window_usage 附件，否则返回空数组。
 */
function getTokenUsageAttachment(
  messages: Message[],
  model: string,
): Attachment[] {
  if (!isEnvTruthy(process.env.CLAUDE_CODE_ENABLE_TOKEN_USAGE_ATTACHMENT)) {
    return []
  }

  const contextWindow = getEffectiveContextWindowSize(model)
  const usedTokens = tokenCountFromLastAPIResponse(messages)

  return [
    {
      type: 'token_usage',
      used: usedTokens,
      total: contextWindow,
      remaining: contextWindow - usedTokens,
    },
  ]
}

/**
 * 生成输出 token 预算使用量附件（仅在 TOKEN_BUDGET 功能启用时生效）。
 * 若当前轮次存在有效的 token 预算，返回包含本轮/累计输出 token 数及预算上限的 output_token_usage 附件；
 * 预算为 null 或 ≤0 时返回空数组。
 */
function getOutputTokenUsageAttachment(): Attachment[] {
  if (feature('TOKEN_BUDGET')) {
    const budget = getCurrentTurnTokenBudget()
    if (budget === null || budget <= 0) {
      return []
    }
    return [
      {
        type: 'output_token_usage',
        turn: getTurnOutputTokens(),
        session: getTotalOutputTokens(),
        budget,
      },
    ]
  }
  return []
}

/**
 * 生成 USD 预算使用量附件。
 * 若传入了 maxBudgetUsd，则计算累计 API 花费和剩余预算，
 * 返回 budget_usd 附件供模型感知花费限制；未设置预算时返回空数组。
 */
function getMaxBudgetUsdAttachment(maxBudgetUsd?: number): Attachment[] {
  if (maxBudgetUsd === undefined) {
    return []
  }

  const usedCost = getTotalCostUSD()
  const remainingBudget = maxBudgetUsd - usedCost

  return [
    {
      type: 'budget_usd',
      used: usedCost,
      total: maxBudgetUsd,
      remaining: remainingBudget,
    },
  ]
}

/**
 * 统计自规划模式退出（plan_mode_exit 附件）后的人工输入轮次数。
 * 若未找到 plan_mode_exit 则返回 0。
 * 注意：tool_result 消息的 type 为 'user' 但不含 isMeta，
 * 需通过 isHumanTurn 过滤，避免将工具结果误计为人工轮次。
 *
 * Count human turns since plan mode exit (plan_mode_exit attachment).
 * Returns 0 if no plan_mode_exit attachment found.
 *
 * tool_result messages are type:'user' without isMeta, so filter by
 * toolUseResult to avoid counting them — otherwise the 10-turn reminder
 * interval fires every ~10 tool calls instead of ~10 human turns.
 */
export function getVerifyPlanReminderTurnCount(messages: Message[]): number {
  let turnCount = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message && isHumanTurn(message)) {
      turnCount++
    }
    // Stop counting at plan_mode_exit attachment (marks when implementation started)
    if (
      message?.type === 'attachment' &&
      message.attachment.type === 'plan_mode_exit'
    ) {
      return turnCount
    }
  }
  // No plan_mode_exit found
  return 0
}

/**
 * 若模型尚未调用 VerifyPlanExecution 工具，则注入 verify_plan_reminder 附件。
 * 仅在 ant 用户且 CLAUDE_CODE_VERIFY_PLAN=1 时生效；
 * pendingPlanVerification 不存在或已开始/完成验证时跳过；
 * 每隔 VERIFY_PLAN_REMINDER_CONFIG.TURNS_BETWEEN_REMINDERS 人工轮次提醒一次。
 *
 * Get verify plan reminder attachment if the model hasn't called VerifyPlanExecution yet.
 */
async function getVerifyPlanReminderAttachment(
  messages: Message[] | undefined,
  toolUseContext: ToolUseContext,
): Promise<Attachment[]> {
  if (
    process.env.USER_TYPE !== 'ant' ||
    !isEnvTruthy(process.env.CLAUDE_CODE_VERIFY_PLAN)
  ) {
    return []
  }

  const appState = toolUseContext.getAppState()
  const pending = appState.pendingPlanVerification

  // Only remind if plan exists and verification not started or completed
  if (
    !pending ||
    pending.verificationStarted ||
    pending.verificationCompleted
  ) {
    return []
  }

  // Only remind every N turns
  if (messages && messages.length > 0) {
    const turnCount = getVerifyPlanReminderTurnCount(messages)
    if (
      turnCount === 0 ||
      turnCount % VERIFY_PLAN_REMINDER_CONFIG.TURNS_BETWEEN_REMINDERS !== 0
    ) {
      return []
    }
  }

  return [{ type: 'verify_plan_reminder' }]
}

/**
 * 生成上下文压缩提醒附件（compaction_reminder）。
 * 仅在 tengu_marble_fox feature 开启、auto compact 已启用、
 * 且模型上下文窗口 ≥ 1M token 且已使用超过有效窗口 25% 时触发。
 * 提醒模型即将发生自动压缩，帮助模型在压缩前完成关键推理。
 */
export function getCompactionReminderAttachment(
  messages: Message[],
  model: string,
): Attachment[] {
  if (!getFeatureValue_CACHED_MAY_BE_STALE('tengu_marble_fox', false)) {
    return []
  }

  if (!isAutoCompactEnabled()) {
    return []
  }

  const contextWindow = getContextWindowForModel(model, getSdkBetas())
  if (contextWindow < 1_000_000) {
    return []
  }

  const effectiveWindow = getEffectiveContextWindowSize(model)
  const usedTokens = tokenCountWithEstimation(messages)
  if (usedTokens < effectiveWindow * 0.25) {
    return []
  }

  return [{ type: 'compaction_reminder' }]
}

/**
 * 上下文效率提示附件（context_efficiency）。
 * 每隔 N 个 token 增长（没有 snip 操作时）注入一次，引导模型使用 SnipTool 压缩历史。
 * 节奏由 shouldNudgeForSnips 控制：在前一次提示、snip 标记、snip 边界或 compact 边界时重置计数器。
 * 通过 lazy require 引入 snipCompact 模块，避免循环依赖。
 *
 * Context-efficiency nudge. Injected after every N tokens of growth without
 * a snip. Pacing is handled entirely by shouldNudgeForSnips — the 10k
 * interval resets on prior nudges, snip markers, snip boundaries, and
 * compact boundaries.
 */
export function getContextEfficiencyAttachment(
  messages: Message[],
): Attachment[] {
  if (!feature('HISTORY_SNIP')) {
    return []
  }
  // Gate must match SnipTool.isEnabled() — don't nudge toward a tool that
  // isn't in the tool list. Lazy require keeps this file snip-string-free.
  const { isSnipRuntimeEnabled, shouldNudgeForSnips } =
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('../services/compact/snipCompact.js') as typeof import('../services/compact/snipCompact.js')
  if (!isSnipRuntimeEnabled()) {
    return []
  }

  if (!shouldNudgeForSnips(messages)) {
    return []
  }

  return [{ type: 'context_efficiency' }]
}


/**
 * 检查文件路径是否被工具权限上下文中的 deny 规则拒绝读取。
 * 通过 matchingRuleForInput 查找 'read'+'deny' 类型的规则，
 * 用于在生成文件附件前拦截被禁止的文件。
 */
function isFileReadDenied(
  filePath: string,
  toolPermissionContext: ToolPermissionContext,
): boolean {
  const denyRule = matchingRuleForInput(
    filePath,
    toolPermissionContext,
    'read',
    'deny',
  )
  return denyRule !== null
}
