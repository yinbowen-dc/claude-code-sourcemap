/**
 * 【Hook 设置元数据与聚合模块】
 *
 * 本文件在 Claude Code 系统流中的位置：
 *   Hook 配置 UI（HooksConfigMenu）/ Hook 执行引擎 → hooksSettings（当前文件）→ sessionHooks / settings
 *
 * 主要职责：
 * 1. getHookEventMetadata：（memoized）返回每个 Hook 事件的摘要、描述和匹配器元数据
 * 2. getAllHooks：从所有可编辑来源 + 会话 Hook 中聚合完整的 Hook 配置列表（自动去重）
 * 3. groupHooksByEventAndMatcher：将 Hook 按事件和匹配器分组（供 UI 使用）
 * 4. getSortedMatchersForEvent / getHooksForMatcher / getMatcherMetadata：辅助查询函数
 * 5. sortMatchersByPriority：按 SOURCES 优先级排序匹配器（plugin/builtin 优先级最低=999）
 * 6. 一系列 hookSource*DisplayString 函数：返回 Hook 来源的展示字符串
 * 7. isHookEqual：比较两个 Hook 是否相同（比较 command/prompt 内容，不比较 timeout；函数 Hook 始终不等）
 *
 * 设计要点：
 * - getHookEventMetadata 使用 sorted join 作为 memoize key，避免调用方每次传新数组时缓存穿透
 * - getAllHooks 通过 resolve 路径对设置文件去重，避免同一 settings.json 被多个 source 重复读取
 * - isHookEqual 中 `if` 字段参与身份判定（同命令不同条件视为不同 Hook）
 * - DEFAULT_HOOK_SHELL 参与 command hook 的相等判定（undefined 等同于 'bash'）
 */

import { resolve } from 'path'
import type { HookEvent } from 'src/entrypoints/agentSdkTypes.js'
import { getSessionId } from '../../bootstrap/state.js'
import type { AppState } from '../../state/AppState.js'
import type { EditableSettingSource } from '../settings/constants.js'
import { SOURCES } from '../settings/constants.js'
import {
  getSettingsFilePathForSource,
  getSettingsForSource,
} from '../settings/settings.js'
import type { HookCommand, HookMatcher } from '../settings/types.js'
import { DEFAULT_HOOK_SHELL } from '../shell/shellProvider.js'
import { getSessionHooks } from './sessionHooks.js'

/** Hook 来源类型：包括各设置层级、插件 Hook、会话 Hook 和内置 Hook */
export type HookSource =
  | EditableSettingSource
  | 'policySettings'
  | 'pluginHook'
  | 'sessionHook'
  | 'builtinHook'

/** 单个 Hook 配置的完整描述，包含事件、配置、匹配器和来源信息 */
export interface IndividualHookConfig {
  event: HookEvent
  config: HookCommand
  matcher?: string
  source: HookSource
  pluginName?: string
}

/**
 * 检查两个 Hook 是否相等（仅比较内容，不比较 timeout）。
 *
 * 比较规则：
 * - command hook：比较 command 字符串、shell（undefined 等同于 DEFAULT_HOOK_SHELL）和 if 条件
 * - prompt hook：比较 prompt 字符串和 if 条件
 * - agent hook：比较 prompt 字符串和 if 条件
 * - http hook：比较 url 和 if 条件
 * - function hook：始终返回 false（无稳定标识符，无法比较）
 *
 * 注意：`if` 字段参与身份判定——相同命令但不同条件视为不同 Hook。
 */
export function isHookEqual(
  a: HookCommand | { type: 'function'; timeout?: number },
  b: HookCommand | { type: 'function'; timeout?: number },
): boolean {
  // 类型不同直接返回 false
  if (a.type !== b.type) return false

  // 提取 `if` 条件比较辅助函数（undefined 与空字符串等价）
  const sameIf = (x: { if?: string }, y: { if?: string }) =>
    (x.if ?? '') === (y.if ?? '')
  switch (a.type) {
    case 'command':
      // shell 参与身份判定：同命令不同 shell 视为不同 Hook
      // DEFAULT_HOOK_SHELL 为默认值，undefined 等同于 DEFAULT_HOOK_SHELL
      return (
        b.type === 'command' &&
        a.command === b.command &&
        (a.shell ?? DEFAULT_HOOK_SHELL) === (b.shell ?? DEFAULT_HOOK_SHELL) &&
        sameIf(a, b)
      )
    case 'prompt':
      return b.type === 'prompt' && a.prompt === b.prompt && sameIf(a, b)
    case 'agent':
      return b.type === 'agent' && a.prompt === b.prompt && sameIf(a, b)
    case 'http':
      return b.type === 'http' && a.url === b.url && sameIf(a, b)
    case 'function':
      // 函数 Hook 没有稳定的标识符，无法进行内容比较，始终返回 false
      return false
  }
}

/**
 * 获取 Hook 的展示文本。
 * 优先返回 statusMessage（若存在），否则根据类型返回命令/prompt/url/类型名。
 *
 * @param hook Hook 配置对象
 * @returns 适合 UI 展示的文本字符串
 */
export function getHookDisplayText(
  hook: HookCommand | { type: 'callback' | 'function'; statusMessage?: string },
): string {
  // 优先使用自定义状态消息
  if ('statusMessage' in hook && hook.statusMessage) {
    return hook.statusMessage
  }

  switch (hook.type) {
    case 'command':
      return hook.command   // 展示 shell 命令字符串
    case 'prompt':
      return hook.prompt    // 展示 prompt 文本
    case 'agent':
      return hook.prompt    // agent hook 也展示 prompt 文本
    case 'http':
      return hook.url       // 展示目标 URL
    case 'callback':
      return 'callback'
    case 'function':
      return 'function'
  }
}

/**
 * 从所有可用来源聚合完整的 Hook 配置列表。
 *
 * 数据来源（按优先级）：
 * 1. 可编辑设置文件：userSettings、projectSettings、localSettings
 *    （通过 resolve 路径去重，避免同一文件被多个 source 重复读取）
 * 2. 会话 Hook（仅当前会话有效，内存中）
 *
 * 注意：若 policySettings.allowManagedHooksOnly = true，则跳过所有可编辑来源，
 * 仅返回会话 Hook（托管 Hook 在外部管理，不通过此函数暴露）。
 *
 * @param appState 当前应用状态
 * @returns 所有 Hook 的平铺列表
 */
export function getAllHooks(appState: AppState): IndividualHookConfig[] {
  const hooks: IndividualHookConfig[] = []

  // 检查是否限制为只允许托管 Hook
  const policySettings = getSettingsForSource('policySettings')
  const restrictedToManagedOnly = policySettings?.allowManagedHooksOnly === true

  // 若未限制为托管专用，则读取所有可编辑来源
  if (!restrictedToManagedOnly) {
    const sources = [
      'userSettings',
      'projectSettings',
      'localSettings',
    ] as EditableSettingSource[]

    // 追踪已处理的设置文件路径，避免重复处理
    // 场景：从主目录运行时，userSettings 和 projectSettings 都指向 ~/.claude/settings.json
    const seenFiles = new Set<string>()

    for (const source of sources) {
      // 通过 resolve 获取实际文件路径（处理相对路径和符号链接）
      const filePath = getSettingsFilePathForSource(source)
      if (filePath) {
        const resolvedPath = resolve(filePath)
        if (seenFiles.has(resolvedPath)) {
          continue  // 文件已处理，跳过
        }
        seenFiles.add(resolvedPath)
      }

      const sourceSettings = getSettingsForSource(source)
      if (!sourceSettings?.hooks) {
        continue
      }

      // 遍历该来源的所有 Hook 配置并平铺
      for (const [event, matchers] of Object.entries(sourceSettings.hooks)) {
        for (const matcher of matchers as HookMatcher[]) {
          for (const hookCommand of matcher.hooks) {
            hooks.push({
              event: event as HookEvent,
              config: hookCommand,
              matcher: matcher.matcher,
              source,
            })
          }
        }
      }
    }
  }

  // 读取当前会话的会话 Hook
  const sessionId = getSessionId()
  const sessionHooks = getSessionHooks(appState, sessionId)
  for (const [event, matchers] of sessionHooks.entries()) {
    for (const matcher of matchers) {
      for (const hookCommand of matcher.hooks) {
        hooks.push({
          event,
          config: hookCommand,
          matcher: matcher.matcher,
          source: 'sessionHook',
        })
      }
    }
  }

  return hooks
}

/**
 * 获取指定事件的所有 Hook 配置（过滤版 getAllHooks）。
 *
 * @param appState 当前应用状态
 * @param event    要过滤的 Hook 事件
 * @returns 该事件的所有 Hook 配置
 */
export function getHooksForEvent(
  appState: AppState,
  event: HookEvent,
): IndividualHookConfig[] {
  return getAllHooks(appState).filter(hook => hook.event === event)
}

/**
 * 获取 Hook 来源的完整描述字符串（含文件路径）。
 * 用于 Hook 配置 UI 中显示详细来源信息。
 */
export function hookSourceDescriptionDisplayString(source: HookSource): string {
  switch (source) {
    case 'userSettings':
      return 'User settings (~/.claude/settings.json)'
    case 'projectSettings':
      return 'Project settings (.claude/settings.json)'
    case 'localSettings':
      return 'Local settings (.claude/settings.local.json)'
    case 'pluginHook':
      // TODO: 获取实际插件 Hook 文件路径（当前使用通配符模式）
      return 'Plugin hooks (~/.claude/plugins/*/hooks/hooks.json)'
    case 'sessionHook':
      return 'Session hooks (in-memory, temporary)'
    case 'builtinHook':
      return 'Built-in hooks (registered internally by Claude Code)'
    default:
      return source as string
  }
}

/**
 * 获取 Hook 来源的标题展示字符串（用于分组标题）。
 */
export function hookSourceHeaderDisplayString(source: HookSource): string {
  switch (source) {
    case 'userSettings':
      return 'User Settings'
    case 'projectSettings':
      return 'Project Settings'
    case 'localSettings':
      return 'Local Settings'
    case 'pluginHook':
      return 'Plugin Hooks'
    case 'sessionHook':
      return 'Session Hooks'
    case 'builtinHook':
      return 'Built-in Hooks'
    default:
      return source as string
  }
}

/**
 * 获取 Hook 来源的内联简短展示字符串（用于列表行内标签）。
 */
export function hookSourceInlineDisplayString(source: HookSource): string {
  switch (source) {
    case 'userSettings':
      return 'User'
    case 'projectSettings':
      return 'Project'
    case 'localSettings':
      return 'Local'
    case 'pluginHook':
      return 'Plugin'
    case 'sessionHook':
      return 'Session'
    case 'builtinHook':
      return 'Built-in'
    default:
      return source as string
  }
}

/**
 * 按优先级排序匹配器列表。
 *
 * 排序规则：
 * 1. 按该匹配器下最高优先级的来源排序（SOURCES 数组中索引越小优先级越高）
 * 2. pluginHook 和 builtinHook 优先级最低（固定为 999）
 * 3. 优先级相同时按匹配器名称字典序排序
 *
 * @param matchers             待排序的匹配器字符串列表
 * @param hooksByEventAndMatcher 按事件和匹配器分组的 Hook 数据
 * @param selectedEvent        目标 Hook 事件
 * @returns 排序后的匹配器列表
 */
export function sortMatchersByPriority(
  matchers: string[],
  hooksByEventAndMatcher: Record<
    string,
    Record<string, IndividualHookConfig[]>
  >,
  selectedEvent: HookEvent,
): string[] {
  // 构建来源优先级映射（SOURCES 数组中索引越小优先级数字越小，即优先级越高）
  const sourcePriority = SOURCES.reduce(
    (acc, source, index) => {
      acc[source] = index
      return acc
    },
    {} as Record<EditableSettingSource, number>,
  )

  return [...matchers].sort((a, b) => {
    const aHooks = hooksByEventAndMatcher[selectedEvent]?.[a] || []
    const bHooks = hooksByEventAndMatcher[selectedEvent]?.[b] || []

    // 提取每个匹配器下的唯一来源集合
    const aSources = Array.from(new Set(aHooks.map(h => h.source)))
    const bSources = Array.from(new Set(bHooks.map(h => h.source)))

    // 获取来源的优先级数字（pluginHook/builtinHook 固定 999，优先级最低）
    const getSourcePriority = (source: HookSource) =>
      source === 'pluginHook' || source === 'builtinHook'
        ? 999
        : sourcePriority[source as EditableSettingSource]

    // 取该匹配器下所有来源中优先级最高的（数字最小的）
    const aHighestPriority = Math.min(...aSources.map(getSourcePriority))
    const bHighestPriority = Math.min(...bSources.map(getSourcePriority))

    if (aHighestPriority !== bHighestPriority) {
      return aHighestPriority - bHighestPriority  // 优先级数字小的排前面
    }

    // 优先级相同时按匹配器名称字典序排序
    return a.localeCompare(b)
  })
}

// =====================
// Hook 事件元数据配置
// =====================

/** 匹配器元数据：描述事件的匹配字段和可选值 */
export type MatcherMetadata = {
  fieldToMatch: string   // 用于匹配的 JSON 字段名（如 'tool_name'）
  values: string[]       // 该字段的可选值列表（供 UI 下拉选择）
}

/** 单个 Hook 事件的元数据（摘要、描述、可选匹配器元数据） */
export type HookEventMetadata = {
  summary: string                     // 事件的简短摘要
  description: string                 // 详细描述（包含输入格式和退出码语义）
  matcherMetadata?: MatcherMetadata   // 可选：匹配器字段和可选值
}

/**
 * 获取所有 Hook 事件的元数据配置（memoized）。
 * 使用排序后的 toolNames 数组拼接字符串作为缓存键，
 * 防止调用方每次传入新数组时导致缓存穿透。
 *
 * @param toolNames 可用工具名称列表（用于 PreToolUse/PostToolUse 等事件的匹配器候选值）
 * @returns 以 HookEvent 为键的元数据记录
 */
export const getHookEventMetadata = memoize(
  function (toolNames: string[]): Record<HookEvent, HookEventMetadata> {
    return {
      PreToolUse: {
        summary: 'Before tool execution',
        description:
          'Input to command is JSON of tool call arguments.\nExit code 0 - stdout/stderr not shown\nExit code 2 - show stderr to model and block tool call\nOther exit codes - show stderr to user only but continue with tool call',
        matcherMetadata: {
          fieldToMatch: 'tool_name',
          values: toolNames,
        },
      },
      PostToolUse: {
        summary: 'After tool execution',
        description:
          'Input to command is JSON with fields "inputs" (tool call arguments) and "response" (tool call response).\nExit code 0 - stdout shown in transcript mode (ctrl+o)\nExit code 2 - show stderr to model immediately\nOther exit codes - show stderr to user only',
        matcherMetadata: {
          fieldToMatch: 'tool_name',
          values: toolNames,
        },
      },
      PostToolUseFailure: {
        summary: 'After tool execution fails',
        description:
          'Input to command is JSON with tool_name, tool_input, tool_use_id, error, error_type, is_interrupt, and is_timeout.\nExit code 0 - stdout shown in transcript mode (ctrl+o)\nExit code 2 - show stderr to model immediately\nOther exit codes - show stderr to user only',
        matcherMetadata: {
          fieldToMatch: 'tool_name',
          values: toolNames,
        },
      },
      PermissionDenied: {
        summary: 'After auto mode classifier denies a tool call',
        description:
          'Input to command is JSON with tool_name, tool_input, tool_use_id, and reason.\nReturn {"hookSpecificOutput":{"hookEventName":"PermissionDenied","retry":true}} to tell the model it may retry.\nExit code 0 - stdout shown in transcript mode (ctrl+o)\nOther exit codes - show stderr to user only',
        matcherMetadata: {
          fieldToMatch: 'tool_name',
          values: toolNames,
        },
      },
      Notification: {
        summary: 'When notifications are sent',
        description:
          'Input to command is JSON with notification message and type.\nExit code 0 - stdout/stderr not shown\nOther exit codes - show stderr to user only',
        matcherMetadata: {
          fieldToMatch: 'notification_type',
          values: [
            'permission_prompt',
            'idle_prompt',
            'auth_success',
            'elicitation_dialog',
            'elicitation_complete',
            'elicitation_response',
          ],
        },
      },
      UserPromptSubmit: {
        summary: 'When the user submits a prompt',
        description:
          'Input to command is JSON with original user prompt text.\nExit code 0 - stdout shown to Claude\nExit code 2 - block processing, erase original prompt, and show stderr to user only\nOther exit codes - show stderr to user only',
      },
      SessionStart: {
        summary: 'When a new session is started',
        description:
          'Input to command is JSON with session start source.\nExit code 0 - stdout shown to Claude\nBlocking errors are ignored\nOther exit codes - show stderr to user only',
        matcherMetadata: {
          fieldToMatch: 'source',
          values: ['startup', 'resume', 'clear', 'compact'],
        },
      },
      Stop: {
        summary: 'Right before Claude concludes its response',
        description:
          'Exit code 0 - stdout/stderr not shown\nExit code 2 - show stderr to model and continue conversation\nOther exit codes - show stderr to user only',
      },
      StopFailure: {
        summary: 'When the turn ends due to an API error',
        description:
          'Fires instead of Stop when an API error (rate limit, auth failure, etc.) ended the turn. Fire-and-forget — hook output and exit codes are ignored.',
        matcherMetadata: {
          fieldToMatch: 'error',
          values: [
            'rate_limit',
            'authentication_failed',
            'billing_error',
            'invalid_request',
            'server_error',
            'max_output_tokens',
            'unknown',
          ],
        },
      },
      SubagentStart: {
        summary: 'When a subagent (Agent tool call) is started',
        description:
          'Input to command is JSON with agent_id and agent_type.\nExit code 0 - stdout shown to subagent\nBlocking errors are ignored\nOther exit codes - show stderr to user only',
        matcherMetadata: {
          fieldToMatch: 'agent_type',
          values: [], // 将由可用代理类型动态填充
        },
      },
      SubagentStop: {
        summary:
          'Right before a subagent (Agent tool call) concludes its response',
        description:
          'Input to command is JSON with agent_id, agent_type, and agent_transcript_path.\nExit code 0 - stdout/stderr not shown\nExit code 2 - show stderr to subagent and continue having it run\nOther exit codes - show stderr to user only',
        matcherMetadata: {
          fieldToMatch: 'agent_type',
          values: [], // 将由可用代理类型动态填充
        },
      },
      PreCompact: {
        summary: 'Before conversation compaction',
        description:
          'Input to command is JSON with compaction details.\nExit code 0 - stdout appended as custom compact instructions\nExit code 2 - block compaction\nOther exit codes - show stderr to user only but continue with compaction',
        matcherMetadata: {
          fieldToMatch: 'trigger',
          values: ['manual', 'auto'],
        },
      },
      PostCompact: {
        summary: 'After conversation compaction',
        description:
          'Input to command is JSON with compaction details and the summary.\nExit code 0 - stdout shown to user\nOther exit codes - show stderr to user only',
        matcherMetadata: {
          fieldToMatch: 'trigger',
          values: ['manual', 'auto'],
        },
      },
      SessionEnd: {
        summary: 'When a session is ending',
        description:
          'Input to command is JSON with session end reason.\nExit code 0 - command completes successfully\nOther exit codes - show stderr to user only',
        matcherMetadata: {
          fieldToMatch: 'reason',
          values: ['clear', 'logout', 'prompt_input_exit', 'other'],
        },
      },
      PermissionRequest: {
        summary: 'When a permission dialog is displayed',
        description:
          'Input to command is JSON with tool_name, tool_input, and tool_use_id.\nOutput JSON with hookSpecificOutput containing decision to allow or deny.\nExit code 0 - use hook decision if provided\nOther exit codes - show stderr to user only',
        matcherMetadata: {
          fieldToMatch: 'tool_name',
          values: toolNames,
        },
      },
      Setup: {
        summary: 'Repo setup hooks for init and maintenance',
        description:
          'Input to command is JSON with trigger (init or maintenance).\nExit code 0 - stdout shown to Claude\nBlocking errors are ignored\nOther exit codes - show stderr to user only',
        matcherMetadata: {
          fieldToMatch: 'trigger',
          values: ['init', 'maintenance'],
        },
      },
      TeammateIdle: {
        summary: 'When a teammate is about to go idle',
        description:
          'Input to command is JSON with teammate_name and team_name.\nExit code 0 - stdout/stderr not shown\nExit code 2 - show stderr to teammate and prevent idle (teammate continues working)\nOther exit codes - show stderr to user only',
      },
      TaskCreated: {
        summary: 'When a task is being created',
        description:
          'Input to command is JSON with task_id, task_subject, task_description, teammate_name, and team_name.\nExit code 0 - stdout/stderr not shown\nExit code 2 - show stderr to model and prevent task creation\nOther exit codes - show stderr to user only',
      },
      TaskCompleted: {
        summary: 'When a task is being marked as completed',
        description:
          'Input to command is JSON with task_id, task_subject, task_description, teammate_name, and team_name.\nExit code 0 - stdout/stderr not shown\nExit code 2 - show stderr to model and prevent task completion\nOther exit codes - show stderr to user only',
      },
      Elicitation: {
        summary: 'When an MCP server requests user input (elicitation)',
        description:
          'Input to command is JSON with mcp_server_name, message, and requested_schema.\nOutput JSON with hookSpecificOutput containing action (accept/decline/cancel) and optional content.\nExit code 0 - use hook response if provided\nExit code 2 - deny the elicitation\nOther exit codes - show stderr to user only',
        matcherMetadata: {
          fieldToMatch: 'mcp_server_name',
          values: [],
        },
      },
      ElicitationResult: {
        summary: 'After a user responds to an MCP elicitation',
        description:
          'Input to command is JSON with mcp_server_name, action, content, mode, and elicitation_id.\nOutput JSON with hookSpecificOutput containing optional action and content to override the response.\nExit code 0 - use hook response if provided\nExit code 2 - block the response (action becomes decline)\nOther exit codes - show stderr to user only',
        matcherMetadata: {
          fieldToMatch: 'mcp_server_name',
          values: [],
        },
      },
      ConfigChange: {
        summary: 'When configuration files change during a session',
        description:
          'Input to command is JSON with source (user_settings, project_settings, local_settings, policy_settings, skills) and file_path.\nExit code 0 - allow the change\nExit code 2 - block the change from being applied to the session\nOther exit codes - show stderr to user only',
        matcherMetadata: {
          fieldToMatch: 'source',
          values: [
            'user_settings',
            'project_settings',
            'local_settings',
            'policy_settings',
            'skills',
          ],
        },
      },
      InstructionsLoaded: {
        summary: 'When an instruction file (CLAUDE.md or rule) is loaded',
        description:
          'Input to command is JSON with file_path, memory_type (User, Project, Local, Managed), load_reason (session_start, nested_traversal, path_glob_match, include, compact), globs (optional — the paths: frontmatter patterns that matched), trigger_file_path (optional — the file Claude touched that caused the load), and parent_file_path (optional — the file that @-included this one).\nExit code 0 - command completes successfully\nOther exit codes - show stderr to user only\nThis hook is observability-only and does not support blocking.',
        matcherMetadata: {
          fieldToMatch: 'load_reason',
          values: [
            'session_start',
            'nested_traversal',
            'path_glob_match',
            'include',
            'compact',
          ],
        },
      },
      WorktreeCreate: {
        summary: 'Create an isolated worktree for VCS-agnostic isolation',
        description:
          'Input to command is JSON with name (suggested worktree slug).\nStdout should contain the absolute path to the created worktree directory.\nExit code 0 - worktree created successfully\nOther exit codes - worktree creation failed',
      },
      WorktreeRemove: {
        summary: 'Remove a previously created worktree',
        description:
          'Input to command is JSON with worktree_path (absolute path to worktree).\nExit code 0 - worktree removed successfully\nOther exit codes - show stderr to user only',
      },
      CwdChanged: {
        summary: 'After the working directory changes',
        description:
          'Input to command is JSON with old_cwd and new_cwd.\nCLAUDE_ENV_FILE is set — write bash exports there to apply env to subsequent BashTool commands.\nHook output can include hookSpecificOutput.watchPaths (array of absolute paths) to register with the FileChanged watcher.\nExit code 0 - command completes successfully\nOther exit codes - show stderr to user only',
      },
      FileChanged: {
        summary: 'When a watched file changes',
        description:
          'Input to command is JSON with file_path and event (change, add, unlink).\nCLAUDE_ENV_FILE is set — write bash exports there to apply env to subsequent BashTool commands.\nThe matcher field specifies filenames to watch in the current directory (e.g. ".envrc|.env").\nHook output can include hookSpecificOutput.watchPaths (array of absolute paths) to dynamically update the watch list.\nExit code 0 - command completes successfully\nOther exit codes - show stderr to user only',
      },
    }
  },
  // memoize 缓存键：将 toolNames 排序后 join，避免每次传入新数组实例时缓存穿透
  toolNames => toolNames.slice().sort().join(','),
)

/**
 * 将 Hook 按事件和匹配器分组（供 UI 渲染使用）。
 * 同时合并来自设置文件的 Hook 和注册的 Plugin/Builtin Hook。
 * 对于没有 matcherMetadata 的事件（如 Stop），使用空字符串作为匹配器键。
 *
 * @param appState  当前应用状态
 * @param toolNames 可用工具名称列表（用于生成 matcherMetadata）
 * @returns 以 HookEvent → 匹配器字符串 → Hook 列表 的嵌套记录
 */
export function groupHooksByEventAndMatcher(
  appState: AppState,
  toolNames: string[],
): Record<HookEvent, Record<string, IndividualHookConfig[]>> {
  // 初始化所有 Hook 事件的空分组结构
  const grouped: Record<HookEvent, Record<string, IndividualHookConfig[]>> = {
    PreToolUse: {},
    PostToolUse: {},
    PostToolUseFailure: {},
    PermissionDenied: {},
    Notification: {},
    UserPromptSubmit: {},
    SessionStart: {},
    SessionEnd: {},
    Stop: {},
    StopFailure: {},
    SubagentStart: {},
    SubagentStop: {},
    PreCompact: {},
    PostCompact: {},
    PermissionRequest: {},
    Setup: {},
    TeammateIdle: {},
    TaskCreated: {},
    TaskCompleted: {},
    Elicitation: {},
    ElicitationResult: {},
    ConfigChange: {},
    WorktreeCreate: {},
    WorktreeRemove: {},
    InstructionsLoaded: {},
    CwdChanged: {},
    FileChanged: {},
  }

  const metadata = getHookEventMetadata(toolNames)

  // 将设置文件中的 Hook 填充到分组结构
  getAllHooks(appState).forEach(hook => {
    const eventGroup = grouped[hook.event]
    if (eventGroup) {
      // 对无 matcherMetadata 的事件（如 Stop），使用空字符串作为 key
      const matcherKey =
        metadata[hook.event].matcherMetadata !== undefined
          ? hook.matcher || ''
          : ''
      if (!eventGroup[matcherKey]) {
        eventGroup[matcherKey] = []
      }
      eventGroup[matcherKey].push(hook)
    }
  })

  // 合并注册的 Plugin Hook 和 Builtin Hook
  const registeredHooks = getRegisteredHooks()
  if (registeredHooks) {
    for (const [event, matchers] of Object.entries(registeredHooks)) {
      const hookEvent = event as HookEvent
      const eventGroup = grouped[hookEvent]
      if (!eventGroup) continue

      for (const matcher of matchers) {
        const matcherKey = matcher.matcher || ''

        // PluginHookMatcher 有 pluginRoot 字段；HookCallbackMatcher（内部回调）没有
        if ('pluginRoot' in matcher) {
          // Plugin Hook：显示插件名称和来源
          eventGroup[matcherKey] ??= []
          for (const hook of matcher.hooks) {
            eventGroup[matcherKey].push({
              event: hookEvent,
              config: hook,
              matcher: matcher.matcher,
              source: 'pluginHook',
              pluginName: matcher.pluginId,
            })
          }
        } else if (process.env.USER_TYPE === 'ant') {
          // Builtin Hook：仅对 Anthropic 内部用户显示（使用占位符文本）
          eventGroup[matcherKey] ??= []
          for (const _hook of matcher.hooks) {
            eventGroup[matcherKey].push({
              event: hookEvent,
              config: {
                type: 'command',
                command: '[ANT-ONLY] Built-in Hook',
              },
              matcher: matcher.matcher,
              source: 'builtinHook',
            })
          }
        }
      }
    }
  }

  return grouped
}

/**
 * 获取指定事件下所有匹配器的排序列表。
 * 排序规则参见 sortMatchersByPriority。
 */
export function getSortedMatchersForEvent(
  hooksByEventAndMatcher: Record<
    HookEvent,
    Record<string, IndividualHookConfig[]>
  >,
  event: HookEvent,
): string[] {
  const matchers = Object.keys(hooksByEventAndMatcher[event] || {})
  return sortMatchersByPriority(matchers, hooksByEventAndMatcher, event)
}

/**
 * 获取指定事件和匹配器下的所有 Hook 配置。
 * 对于无 matcher 的事件，传入 null 等同于传入空字符串。
 */
export function getHooksForMatcher(
  hooksByEventAndMatcher: Record<
    HookEvent,
    Record<string, IndividualHookConfig[]>
  >,
  event: HookEvent,
  matcher: string | null,
): IndividualHookConfig[] {
  // 无 matcher 的事件使用空字符串作为记录键
  const matcherKey = matcher ?? ''
  return hooksByEventAndMatcher[event]?.[matcherKey] ?? []
}

/**
 * 获取指定事件的匹配器元数据（字段名和可选值列表）。
 */
export function getMatcherMetadata(
  event: HookEvent,
  toolNames: string[],
): MatcherMetadata | undefined {
  return getHookEventMetadata(toolNames)[event].matcherMetadata
}
