/**
 * 会话文件访问分析 Hook 模块
 *
 * 在 Claude Code 系统中的位置：
 * 工具执行后置钩子层 → 文件访问遥测 → sessionFileAccessHooks
 *
 * 主要功能：
 * 通过 PostToolUse Hook 监听 Read/Grep/Glob/Edit/Write 工具的调用，
 * 检测是否访问了会话记忆文件、会话日志文件、自动记忆目录（memdir）或团队记忆文件，
 * 并分别上报对应的分析事件（analytics event）。
 *
 * 追踪的文件类型：
 * - session_memory：会话记忆文件（通过 detectSessionFileType 判断）
 * - session_transcript：会话对话日志文件
 * - memdir（auto-mem）：用户本地自动记忆目录中的文件
 * - team memory：团队协作记忆文件（需要 TEAMMEM feature flag）
 *
 * 注意：TEAMMEM 和 MEMORY_SHAPE_TELEMETRY 功能通过 feature flag 动态加载，
 * 未开启时对应模块为 null，不会产生任何副作用。
 */

import { feature } from 'bun:bundle'
import { registerHookCallbacks } from '../bootstrap/state.js'
import type { HookInput, HookJSONOutput } from '../entrypoints/agentSdkTypes.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../services/analytics/index.js'
import { FILE_EDIT_TOOL_NAME } from '../tools/FileEditTool/constants.js'
import { inputSchema as editInputSchema } from '../tools/FileEditTool/types.js'
import { FileReadTool } from '../tools/FileReadTool/FileReadTool.js'
import { FILE_READ_TOOL_NAME } from '../tools/FileReadTool/prompt.js'
import { FileWriteTool } from '../tools/FileWriteTool/FileWriteTool.js'
import { FILE_WRITE_TOOL_NAME } from '../tools/FileWriteTool/prompt.js'
import { GlobTool } from '../tools/GlobTool/GlobTool.js'
import { GLOB_TOOL_NAME } from '../tools/GlobTool/prompt.js'
import { GrepTool } from '../tools/GrepTool/GrepTool.js'
import { GREP_TOOL_NAME } from '../tools/GrepTool/prompt.js'
import type { HookCallback } from '../types/hooks.js'
import {
  detectSessionFileType,
  detectSessionPatternType,
  isAutoMemFile,
  memoryScopeForPath,
} from './memoryFileDetection.js'

/* eslint-disable @typescript-eslint/no-require-imports */
// TEAMMEM 功能通过 feature flag 动态加载，关闭时为 null
const teamMemPaths = feature('TEAMMEM')
  ? (require('../memdir/teamMemPaths.js') as typeof import('../memdir/teamMemPaths.js'))
  : null
const teamMemWatcher = feature('TEAMMEM')
  ? (require('../services/teamMemorySync/watcher.js') as typeof import('../services/teamMemorySync/watcher.js'))
  : null
// 记忆形状遥测功能，通过 feature flag 动态加载
const memoryShapeTelemetry = feature('MEMORY_SHAPE_TELEMETRY')
  ? (require('../memdir/memoryShapeTelemetry.js') as typeof import('../memdir/memoryShapeTelemetry.js'))
  : null
/* eslint-enable @typescript-eslint/no-require-imports */

import { getSubagentLogName } from './agentContext.js'

/**
 * 从工具输入中提取文件路径（用于 memdir 检测）
 *
 * 函数流程：
 * 1. 根据工具名称分派到对应工具的 inputSchema
 * 2. 用 safeParse 解析工具输入
 * 3. 成功时返回 file_path 字段，失败时返回 null
 *
 * 覆盖工具：Read（file_path）、Edit（file_path）、Write（file_path）
 *
 * @param toolName  - 工具名称
 * @param toolInput - 工具调用的原始输入对象
 * @returns 文件路径字符串，或 null（不适用或解析失败）
 */
function getFilePathFromInput(
  toolName: string,
  toolInput: unknown,
): string | null {
  switch (toolName) {
    case FILE_READ_TOOL_NAME: {
      const parsed = FileReadTool.inputSchema.safeParse(toolInput)
      return parsed.success ? parsed.data.file_path : null
    }
    case FILE_EDIT_TOOL_NAME: {
      const parsed = editInputSchema().safeParse(toolInput)
      return parsed.success ? parsed.data.file_path : null
    }
    case FILE_WRITE_TOOL_NAME: {
      const parsed = FileWriteTool.inputSchema.safeParse(toolInput)
      return parsed.success ? parsed.data.file_path : null
    }
    default:
      return null
  }
}

/**
 * 从工具输入中检测会话文件类型
 *
 * 函数流程：
 * 1. 根据工具名称解析输入
 * 2. Read 工具：直接检测 file_path 的文件类型
 * 3. Grep 工具：先检测 path 参数，再检测 glob 模式
 * 4. Glob 工具：先检测 path 参数，再检测 pattern 模式
 *
 * @param toolName  - 工具名称
 * @param toolInput - 工具调用的原始输入对象
 * @returns 'session_memory' | 'session_transcript' | null
 */
function getSessionFileTypeFromInput(
  toolName: string,
  toolInput: unknown,
): 'session_memory' | 'session_transcript' | null {
  switch (toolName) {
    case FILE_READ_TOOL_NAME: {
      const parsed = FileReadTool.inputSchema.safeParse(toolInput)
      if (!parsed.success) return null
      return detectSessionFileType(parsed.data.file_path)
    }
    case GREP_TOOL_NAME: {
      const parsed = GrepTool.inputSchema.safeParse(toolInput)
      if (!parsed.success) return null
      // 优先检查具体路径
      if (parsed.data.path) {
        const pathType = detectSessionFileType(parsed.data.path)
        if (pathType) return pathType
      }
      // 再检查 glob 模式
      if (parsed.data.glob) {
        const globType = detectSessionPatternType(parsed.data.glob)
        if (globType) return globType
      }
      return null
    }
    case GLOB_TOOL_NAME: {
      const parsed = GlobTool.inputSchema.safeParse(toolInput)
      if (!parsed.success) return null
      // 优先检查目录路径
      if (parsed.data.path) {
        const pathType = detectSessionFileType(parsed.data.path)
        if (pathType) return pathType
      }
      // 再检查 glob 匹配模式
      const patternType = detectSessionPatternType(parsed.data.pattern)
      if (patternType) return patternType
      return null
    }
    default:
      return null
  }
}

/**
 * 判断一次工具调用是否构成记忆文件访问
 *
 * 检测条件（满足其一即为 true）：
 * 1. 工具输入指向会话记忆文件（session_memory 类型）
 * 2. 工具输入指向 memdir 自动记忆文件（isAutoMemFile）
 * 3. TEAMMEM 功能开启且工具输入指向团队记忆文件
 *
 * 与 PostToolUse 钩子使用相同的检测条件，供其他模块（如工具权限检查）调用。
 *
 * @param toolName  - 工具名称
 * @param toolInput - 工具调用的原始输入对象
 * @returns 是否为记忆文件访问
 */
export function isMemoryFileAccess(
  toolName: string,
  toolInput: unknown,
): boolean {
  // 条件一：会话记忆文件（.jsonl 记忆条目等）
  if (getSessionFileTypeFromInput(toolName, toolInput) === 'session_memory') {
    return true
  }

  // 条件二/三：memdir 或团队记忆文件路径（Read/Edit/Write 工具）
  const filePath = getFilePathFromInput(toolName, toolInput)
  if (
    filePath &&
    (isAutoMemFile(filePath) ||
      (feature('TEAMMEM') && teamMemPaths!.isTeamMemFile(filePath)))
  ) {
    return true
  }

  return false
}

/**
 * PostToolUse 后置钩子回调：记录会话文件访问分析事件
 *
 * 函数流程：
 * 1. 仅处理 PostToolUse 钩子事件，其他事件直接返回 {}
 * 2. 检测工具输入的会话文件类型，上报 session_memory / transcript 事件
 * 3. 检测 memdir 自动记忆文件访问，上报工具粒度事件（read/edit/write）
 * 4. 若 TEAMMEM 开启，检测团队记忆文件访问，额外通知 watcher
 * 5. 若 MEMORY_SHAPE_TELEMETRY 开启，对编辑/写入操作上报记忆形状遥测
 *
 * @param input      - Hook 输入（包含工具名和工具输入）
 * @param _toolUseID - 工具调用 ID（此处未使用）
 * @param _signal    - 中止信号（此处未使用，超时极短仅做日志）
 * @returns 空的 HookJSONOutput（此 Hook 仅做遥测，不修改工具输出）
 */
async function handleSessionFileAccess(
  input: HookInput,
  _toolUseID: string | null,
  _signal: AbortSignal | undefined,
): Promise<HookJSONOutput> {
  // 仅处理 PostToolUse 事件
  if (input.hook_event_name !== 'PostToolUse') return {}

  // 检测会话文件类型（session_memory 或 session_transcript）
  const fileType = getSessionFileTypeFromInput(
    input.tool_name,
    input.tool_input,
  )

  // 获取子 Agent 日志名称（用于多 Agent 场景区分来源）
  const subagentName = getSubagentLogName()
  const subagentProps = subagentName ? { subagent_name: subagentName } : {}

  // 上报会话记忆 / 日志访问事件
  if (fileType === 'session_memory') {
    logEvent('tengu_session_memory_accessed', { ...subagentProps })
  } else if (fileType === 'session_transcript') {
    logEvent('tengu_transcript_accessed', { ...subagentProps })
  }

  // 检测 memdir 自动记忆文件访问
  const filePath = getFilePathFromInput(input.tool_name, input.tool_input)
  if (filePath && isAutoMemFile(filePath)) {
    // 上报 memdir 通用访问事件（携带工具名）
    logEvent('tengu_memdir_accessed', {
      tool: input.tool_name as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      ...subagentProps,
    })

    // 按工具类型上报细粒度事件
    switch (input.tool_name) {
      case FILE_READ_TOOL_NAME:
        logEvent('tengu_memdir_file_read', { ...subagentProps })
        break
      case FILE_EDIT_TOOL_NAME:
        logEvent('tengu_memdir_file_edit', { ...subagentProps })
        break
      case FILE_WRITE_TOOL_NAME:
        logEvent('tengu_memdir_file_write', { ...subagentProps })
        break
    }
  }

  // 检测团队记忆文件访问（需 TEAMMEM feature flag）
  if (feature('TEAMMEM') && filePath && teamMemPaths!.isTeamMemFile(filePath)) {
    logEvent('tengu_team_mem_accessed', {
      tool: input.tool_name as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      ...subagentProps,
    })

    switch (input.tool_name) {
      case FILE_READ_TOOL_NAME:
        logEvent('tengu_team_mem_file_read', { ...subagentProps })
        break
      case FILE_EDIT_TOOL_NAME:
        logEvent('tengu_team_mem_file_edit', { ...subagentProps })
        // 通知团队记忆 watcher 有写入发生（用于跨成员同步）
        teamMemWatcher?.notifyTeamMemoryWrite()
        break
      case FILE_WRITE_TOOL_NAME:
        logEvent('tengu_team_mem_file_write', { ...subagentProps })
        teamMemWatcher?.notifyTeamMemoryWrite()
        break
    }
  }

  // 记忆形状遥测：对 Edit/Write 操作记录写入的内容形状（需 MEMORY_SHAPE_TELEMETRY flag）
  if (feature('MEMORY_SHAPE_TELEMETRY') && filePath) {
    const scope = memoryScopeForPath(filePath)
    if (
      scope !== null &&
      (input.tool_name === FILE_EDIT_TOOL_NAME ||
        input.tool_name === FILE_WRITE_TOOL_NAME)
    ) {
      memoryShapeTelemetry!.logMemoryWriteShape(
        input.tool_name,
        input.tool_input,
        filePath,
        scope,
      )
    }
  }

  // Hook 仅做遥测，不修改工具输出
  return {}
}

/**
 * 注册会话文件访问追踪 Hook（在 CLI 初始化时调用）
 *
 * 函数流程：
 * 1. 创建统一的 HookCallback 对象（超时 1ms，仅用于日志记录）
 * 2. 为 Read/Grep/Glob/Edit/Write 五个工具分别注册 PostToolUse 钩子
 *
 * 设计说明：
 * 使用同一个 hook 对象注册到所有工具，避免重复代码；
 * timeout: 1 确保即使回调卡住也不会阻塞工具响应。
 */
export function registerSessionFileAccessHooks(): void {
  const hook: HookCallback = {
    type: 'callback',
    callback: handleSessionFileAccess,
    timeout: 1, // 极短超时，仅做日志记录，不阻塞工具返回
    internal: true,
  }

  // 为所有相关工具注册 PostToolUse 钩子
  registerHookCallbacks({
    PostToolUse: [
      { matcher: FILE_READ_TOOL_NAME, hooks: [hook] },
      { matcher: GREP_TOOL_NAME, hooks: [hook] },
      { matcher: GLOB_TOOL_NAME, hooks: [hook] },
      { matcher: FILE_EDIT_TOOL_NAME, hooks: [hook] },
      { matcher: FILE_WRITE_TOOL_NAME, hooks: [hook] },
    ],
  })
}
