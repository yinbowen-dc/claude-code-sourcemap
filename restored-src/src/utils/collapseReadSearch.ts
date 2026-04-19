/**
 * 读取/搜索操作折叠模块。
 *
 * 在 Claude Code 系统中，该模块将连续的 Read/Search/Bash 工具调用折叠为单条摘要展示，
 * 避免大量工具调用消息刷屏，同时在详细模式（Ctrl+O）下仍可展开查看：
 * - getToolSearchOrReadInfo()：判断工具调用是否为可折叠的搜索/读取操作
 * - collapseReadSearchGroups()：将连续的搜索/读取消息折叠为 CollapsedReadSearchGroup
 * - getSearchReadSummaryText()：生成"已读取 N 个文件、搜索 M 次"等摘要文本
 * - summarizeRecentActivities()：汇总最近活动列表末尾的搜索/读取操作
 * - 支持内存文件、团队内存、MCP 工具、bash 命令、git 操作等分类折叠
 */
import { feature } from 'bun:bundle'
import type { UUID } from 'crypto'
import { findToolByName, type Tools } from '../Tool.js'
import { extractBashCommentLabel } from '../tools/BashTool/commentLabel.js'
import { BASH_TOOL_NAME } from '../tools/BashTool/toolName.js'
import { FILE_EDIT_TOOL_NAME } from '../tools/FileEditTool/constants.js'
import { FILE_WRITE_TOOL_NAME } from '../tools/FileWriteTool/prompt.js'
import { REPL_TOOL_NAME } from '../tools/REPLTool/constants.js'
import { getReplPrimitiveTools } from '../tools/REPLTool/primitiveTools.js'
import {
  type BranchAction,
  type CommitKind,
  detectGitOperation,
  type PrAction,
} from '../tools/shared/gitOperationTracking.js'
import { TOOL_SEARCH_TOOL_NAME } from '../tools/ToolSearchTool/prompt.js'
import type {
  CollapsedReadSearchGroup,
  CollapsibleMessage,
  RenderableMessage,
  StopHookInfo,
  SystemStopHookSummaryMessage,
} from '../types/message.js'
import { getDisplayPath } from './file.js'
import { isFullscreenEnvEnabled } from './fullscreen.js'
import {
  isAutoManagedMemoryFile,
  isAutoManagedMemoryPattern,
  isMemoryDirectory,
  isShellCommandTargetingMemory,
} from './memoryFileDetection.js'

/* eslint-disable @typescript-eslint/no-require-imports */
const teamMemOps = feature('TEAMMEM')
  ? (require('./teamMemoryOps.js') as typeof import('./teamMemoryOps.js'))
  : null
const SNIP_TOOL_NAME = feature('HISTORY_SNIP')
  ? (
      require('../tools/SnipTool/prompt.js') as typeof import('../tools/SnipTool/prompt.js')
    ).SNIP_TOOL_NAME
  : null
/* eslint-enable @typescript-eslint/no-require-imports */

/**
 * 工具调用是否为搜索/读取操作的判断结果类型。
 * isCollapsible 为 true 时可被折叠进摘要组。
 */
export type SearchOrReadResult = {
  isCollapsible: boolean
  isSearch: boolean
  isRead: boolean
  isList: boolean
  isREPL: boolean
  /** 为 true 时表示此操作是写入或编辑内存文件 */
  isMemoryWrite: boolean
  /**
   * 为 true 时表示这是元操作，应被静默吸收进折叠组，不增加计数（如 Snip、ToolSearch）。
   * 在详细模式（verbose）下仍可通过 groupMessages 迭代查看。
   */
  isAbsorbedSilently: boolean
  /** MCP 工具时对应的服务器名称 */
  mcpServerName?: string
  /** 非搜索/读取的 bash 命令（仅在全屏模式下启用） */
  isBash?: boolean
}

/**
 * 从工具调用输入中提取主要文件/目录路径。
 * 同时兼容 file_path（Read/Write/Edit 工具）和 path（Grep/Glob 工具）两种字段名。
 */
function getFilePathFromToolInput(toolInput: unknown): string | undefined {
  const input = toolInput as
    | { file_path?: string; path?: string; pattern?: string; glob?: string }
    | undefined
  return input?.file_path ?? input?.path
}

/**
 * 判断搜索工具调用是否针对内存文件，通过检查 path、pattern 和 glob 字段。
 * 覆盖 Grep/Glob 工具直接按路径搜索、按 glob 模式匹配内存文件，
 * 以及 bash grep/rg 等 shell 命令通过 command 字段指向内存路径的场景。
 */
function isMemorySearch(toolInput: unknown): boolean {
  const input = toolInput as
    | { path?: string; pattern?: string; glob?: string; command?: string }
    | undefined
  if (!input) {
    return false
  }
  // 检查搜索路径是否指向内存文件或目录（Grep/Glob 工具）
  if (input.path) {
    if (isAutoManagedMemoryFile(input.path) || isMemoryDirectory(input.path)) {
      return true
    }
  }
  // 检查 glob 模式是否匹配内存文件访问
  if (input.glob && isAutoManagedMemoryPattern(input.glob)) {
    return true
  }
  // 对 shell 命令（bash grep/rg、PowerShell Select-String 等），
  // 检查命令是否指向内存路径
  if (input.command && isShellCommandTargetingMemory(input.command)) {
    return true
  }
  return false
}

/**
 * 判断 Write 或 Edit 工具调用是否针对内存文件（应被折叠处理）。
 * 仅匹配 FILE_WRITE_TOOL_NAME 和 FILE_EDIT_TOOL_NAME，且目标路径为自动管理的内存文件。
 */
function isMemoryWriteOrEdit(toolName: string, toolInput: unknown): boolean {
  if (toolName !== FILE_WRITE_TOOL_NAME && toolName !== FILE_EDIT_TOOL_NAME) {
    return false
  }
  const filePath = getFilePathFromToolInput(toolInput)
  return filePath !== undefined && isAutoManagedMemoryFile(filePath)
}

// 约 5 行 × 60 列。宽松的静态上限 — 渲染层会让 Ink 自动换行。
const MAX_HINT_CHARS = 300

/**
 * 将 bash 命令格式化为 ⎿ 提示行。
 * 去除空行、合并行内连续空白，然后截断至最大长度。
 * 保留换行符，使渲染层可以在 ⎿ 下对续行缩进展示。
 */
function commandAsHint(command: string): string {
  const cleaned =
    '$ ' +
    command
      .split('\n')
      .map(l => l.replace(/\s+/g, ' ').trim())
      .filter(l => l !== '')
      .join('\n')
  return cleaned.length > MAX_HINT_CHARS
    ? cleaned.slice(0, MAX_HINT_CHARS - 1) + '…'
    : cleaned
}

/**
 * 使用工具自身的 isSearchOrReadCommand 方法判断该工具是否为搜索/读取操作。
 * 同时将针对内存文件的 Write/Edit 操作视为可折叠对象。
 * 返回详细的分类信息（是否为搜索、读取、列表、REPL、内存写入等）。
 */
export function getToolSearchOrReadInfo(
  toolName: string,
  toolInput: unknown,
  tools: Tools,
): SearchOrReadResult {
  // REPL 被静默吸收 — 其内部工具调用通过 newMessages 以虚拟消息（isVirtual: true）
  // 的形式发出，并作为普通的 Read/Grep/Bash 消息流经此函数。
  // REPL 外层包装本身不计入任何计数，也不中断折叠组，
  // 因此连续的 REPL 调用会合并为同一组。
  if (toolName === REPL_TOOL_NAME) {
    return {
      isCollapsible: true,
      isSearch: false,
      isRead: false,
      isList: false,
      isREPL: true,
      isMemoryWrite: false,
      isAbsorbedSilently: true,
    }
  }

  // 内存文件写入/编辑视为可折叠操作
  if (isMemoryWriteOrEdit(toolName, toolInput)) {
    return {
      isCollapsible: true,
      isSearch: false,
      isRead: false,
      isList: false,
      isREPL: false,
      isMemoryWrite: true,
      isAbsorbedSilently: false,
    }
  }

  // 静默吸收的元操作：Snip（上下文清理）和 ToolSearch（懒加载工具 schema）。
  // 二者不应中断折叠组或计入计数，但在 verbose 模式下仍可见。
  if (
    (feature('HISTORY_SNIP') && toolName === SNIP_TOOL_NAME) ||
    (isFullscreenEnvEnabled() && toolName === TOOL_SEARCH_TOOL_NAME)
  ) {
    return {
      isCollapsible: true,
      isSearch: false,
      isRead: false,
      isList: false,
      isREPL: false,
      isMemoryWrite: false,
      isAbsorbedSilently: true,
    }
  }

  // 回退到 REPL 原语工具列表：REPL 模式下 Bash/Read/Grep 等工具会从执行工具列表中移除，
  // 但 REPL 会以虚拟消息形式重新发出。若没有此回退，这些工具会返回 isCollapsible: false，
  // 摘要行将不会计入它们。
  const tool =
    findToolByName(tools, toolName) ??
    findToolByName(getReplPrimitiveTools(), toolName)
  if (!tool?.isSearchOrReadCommand) {
    return {
      isCollapsible: false,
      isSearch: false,
      isRead: false,
      isList: false,
      isREPL: false,
      isMemoryWrite: false,
      isAbsorbedSilently: false,
    }
  }
  // 工具的 isSearchOrReadCommand 方法内部通过 safeParse 处理自身输入校验，
  // 因此直接传入原始 input 是安全的。类型断言是必要的，因为 Tool[] 泛型默认
  // 期望 { [x: string]: any }，而此处运行时接收的是 unknown 类型。
  const result = tool.isSearchOrReadCommand(
    toolInput as { [x: string]: unknown },
  )
  const isList = result.isList ?? false
  const isCollapsible = result.isSearch || result.isRead || isList
  // 全屏模式下，非搜索/读取的 bash 命令也可折叠，
  // 显示为"运行了 N 条 bash 命令"而非中断当前折叠组。
  return {
    isCollapsible:
      isCollapsible ||
      (isFullscreenEnvEnabled() ? toolName === BASH_TOOL_NAME : false),
    isSearch: result.isSearch,
    isRead: result.isRead,
    isList,
    isREPL: false,
    isMemoryWrite: false,
    isAbsorbedSilently: false,
    ...(tool.isMcp && { mcpServerName: tool.mcpInfo?.serverName }),
    isBash: isFullscreenEnvEnabled()
      ? !isCollapsible && toolName === BASH_TOOL_NAME
      : undefined,
  }
}

/**
 * 检查 tool_use 内容块是否为搜索/读取操作。
 * 若为可折叠的搜索/读取操作则返回详细信息对象，否则返回 null。
 */
export function getSearchOrReadFromContent(
  content: { type: string; name?: string; input?: unknown } | undefined,
  tools: Tools,
): {
  isSearch: boolean
  isRead: boolean
  isList: boolean
  isREPL: boolean
  isMemoryWrite: boolean
  isAbsorbedSilently: boolean
  mcpServerName?: string
  isBash?: boolean
} | null {
  if (content?.type === 'tool_use' && content.name) {
    const info = getToolSearchOrReadInfo(content.name, content.input, tools)
    if (info.isCollapsible || info.isREPL) {
      return {
        isSearch: info.isSearch,
        isRead: info.isRead,
        isList: info.isList,
        isREPL: info.isREPL,
        isMemoryWrite: info.isMemoryWrite,
        isAbsorbedSilently: info.isAbsorbedSilently,
        mcpServerName: info.mcpServerName,
        isBash: info.isBash,
      }
    }
  }
  return null
}

/**
 * 判断工具是否为搜索/读取操作（向后兼容的简化版本）。
 * 内部直接调用 getToolSearchOrReadInfo 并返回 isCollapsible 字段。
 */
function isToolSearchOrRead(
  toolName: string,
  toolInput: unknown,
  tools: Tools,
): boolean {
  return getToolSearchOrReadInfo(toolName, toolInput, tools).isCollapsible
}

/**
 * 从消息中提取工具名称、输入及搜索/读取信息（若为可折叠工具调用）。
 * 同时处理普通 assistant 消息和 grouped_tool_use 分组消息两种形式。
 * 若消息不是可折叠工具调用则返回 null。
 */
function getCollapsibleToolInfo(
  msg: RenderableMessage,
  tools: Tools,
): {
  name: string
  input: unknown
  isSearch: boolean
  isRead: boolean
  isList: boolean
  isREPL: boolean
  isMemoryWrite: boolean
  isAbsorbedSilently: boolean
  mcpServerName?: string
  isBash?: boolean
} | null {
  if (msg.type === 'assistant') {
    const content = msg.message.content[0]
    const info = getSearchOrReadFromContent(content, tools)
    if (info && content?.type === 'tool_use') {
      return { name: content.name, input: content.input, ...info }
    }
  }
  if (msg.type === 'grouped_tool_use') {
    // 对分组工具调用，取第一条消息的输入进行判断
    const firstContent = msg.messages[0]?.message.content[0]
    const info = getSearchOrReadFromContent(
      firstContent
        ? { type: 'tool_use', name: msg.toolName, input: firstContent.input }
        : undefined,
      tools,
    )
    if (info && firstContent?.type === 'tool_use') {
      return { name: msg.toolName, input: firstContent.input, ...info }
    }
  }
  return null
}

/**
 * 判断消息是否为应中断折叠组的助手文本内容。
 * 仅非空的 text 类型内容块才视为"断组文本"。
 */
function isTextBreaker(msg: RenderableMessage): boolean {
  if (msg.type === 'assistant') {
    const content = msg.message.content[0]
    if (content?.type === 'text' && content.text.trim().length > 0) {
      return true
    }
  }
  return false
}

/**
 * 判断消息是否为应中断折叠组的不可折叠工具调用。
 * Edit、Write 等非搜索/读取工具均属此类，会触发 flushGroup。
 */
function isNonCollapsibleToolUse(
  msg: RenderableMessage,
  tools: Tools,
): boolean {
  if (msg.type === 'assistant') {
    const content = msg.message.content[0]
    if (
      content?.type === 'tool_use' &&
      !isToolSearchOrRead(content.name, content.input, tools)
    ) {
      return true
    }
  }
  if (msg.type === 'grouped_tool_use') {
    const firstContent = msg.messages[0]?.message.content[0]
    if (
      firstContent?.type === 'tool_use' &&
      !isToolSearchOrRead(msg.toolName, firstContent.input, tools)
    ) {
      return true
    }
  }
  return false
}

/**
 * 判断消息是否为 PreToolUse 钩子摘要（类型谓词）。
 * PreToolUse 钩子摘要会被吸收进当前折叠组，不会中断组也不会被推迟输出。
 */
function isPreToolHookSummary(
  msg: RenderableMessage,
): msg is SystemStopHookSummaryMessage {
  return (
    msg.type === 'system' &&
    msg.subtype === 'stop_hook_summary' &&
    msg.hookLabel === 'PreToolUse'
  )
}

/**
 * 判断消息是否可跳过（不应中断折叠组，直接透传）。
 * 包括 thinking 块、redacted_thinking、attachment 附件和 system 系统消息。
 */
function shouldSkipMessage(msg: RenderableMessage): boolean {
  if (msg.type === 'assistant') {
    const content = msg.message.content[0]
    // 跳过 thinking 块和其他非文本非工具内容
    if (content?.type === 'thinking' || content?.type === 'redacted_thinking') {
      return true
    }
  }
  // 跳过 attachment 消息
  if (msg.type === 'attachment') {
    return true
  }
  // 跳过 system 消息
  if (msg.type === 'system') {
    return true
  }
  return false
}

/**
 * 类型谓词：判断消息是否为可折叠的工具调用（CollapsibleMessage）。
 * 同时处理普通 assistant 消息和 grouped_tool_use 分组消息。
 */
function isCollapsibleToolUse(
  msg: RenderableMessage,
  tools: Tools,
): msg is CollapsibleMessage {
  if (msg.type === 'assistant') {
    const content = msg.message.content[0]
    return (
      content?.type === 'tool_use' &&
      isToolSearchOrRead(content.name, content.input, tools)
    )
  }
  if (msg.type === 'grouped_tool_use') {
    const firstContent = msg.messages[0]?.message.content[0]
    return (
      firstContent?.type === 'tool_use' &&
      isToolSearchOrRead(msg.toolName, firstContent.input, tools)
    )
  }
  return false
}

/**
 * 类型谓词：判断消息是否为可折叠工具的结果消息。
 * 仅当消息中所有工具结果均属于已追踪的可折叠工具时才返回 true。
 */
function isCollapsibleToolResult(
  msg: RenderableMessage,
  collapsibleToolUseIds: Set<string>,
): msg is CollapsibleMessage {
  if (msg.type === 'user') {
    const toolResults = msg.message.content.filter(
      (c): c is { type: 'tool_result'; tool_use_id: string } =>
        c.type === 'tool_result',
    )
    // 仅当存在工具结果且全部属于可折叠工具时才返回 true
    return (
      toolResults.length > 0 &&
      toolResults.every(r => collapsibleToolUseIds.has(r.tool_use_id))
    )
  }
  return false
}

/**
 * 从单条消息中提取所有工具调用 ID（兼容 grouped_tool_use 分组消息）。
 */
function getToolUseIdsFromMessage(msg: RenderableMessage): string[] {
  if (msg.type === 'assistant') {
    const content = msg.message.content[0]
    if (content?.type === 'tool_use') {
      return [content.id]
    }
  }
  if (msg.type === 'grouped_tool_use') {
    return msg.messages
      .map(m => {
        const content = m.message.content[0]
        return content.type === 'tool_use' ? content.id : ''
      })
      .filter(Boolean)
  }
  return []
}

/**
 * 从折叠的读取/搜索组中提取所有工具调用 ID。
 */
export function getToolUseIdsFromCollapsedGroup(
  message: CollapsedReadSearchGroup,
): string[] {
  const ids: string[] = []
  for (const msg of message.messages) {
    ids.push(...getToolUseIdsFromMessage(msg))
  }
  return ids
}

/**
 * 检查折叠组内是否有任意工具调用仍在进行中。
 * 用于判断折叠组徽章是否应显示为"加载中"状态。
 */
export function hasAnyToolInProgress(
  message: CollapsedReadSearchGroup,
  inProgressToolUseIDs: Set<string>,
): boolean {
  return getToolUseIdsFromCollapsedGroup(message).some(id =>
    inProgressToolUseIDs.has(id),
  )
}

/**
 * 获取折叠组的底层显示消息（用于展示时间戳/模型信息）。
 * 处理折叠组中嵌套 GroupedToolUseMessage 的情况，
 * 返回值永远是 NormalizedAssistantMessage 或 NormalizedUserMessage，
 * 不会是 GroupedToolUseMessage。
 */
export function getDisplayMessageFromCollapsed(
  message: CollapsedReadSearchGroup,
): Exclude<CollapsibleMessage, { type: 'grouped_tool_use' }> {
  const firstMsg = message.displayMessage
  if (firstMsg.type === 'grouped_tool_use') {
    return firstMsg.displayMessage
  }
  return firstMsg
}

/**
 * 统计一条消息中的工具调用数量（兼容 grouped_tool_use 分组消息）。
 * 分组消息按其内部成员数计算，普通消息计为 1。
 */
function countToolUses(msg: RenderableMessage): number {
  if (msg.type === 'grouped_tool_use') {
    return msg.messages.length
  }
  return 1
}

/**
 * 从读取工具的输入中提取文件路径列表。
 * 同一分组消息中同一文件被多次读取时可能出现重复路径。
 */
function getFilePathsFromReadMessage(msg: RenderableMessage): string[] {
  const paths: string[] = []

  if (msg.type === 'assistant') {
    const content = msg.message.content[0]
    if (content?.type === 'tool_use') {
      const input = content.input as { file_path?: string } | undefined
      if (input?.file_path) {
        paths.push(input.file_path)
      }
    }
  } else if (msg.type === 'grouped_tool_use') {
    for (const m of msg.messages) {
      const content = m.message.content[0]
      if (content?.type === 'tool_use') {
        const input = content.input as { file_path?: string } | undefined
        if (input?.file_path) {
          paths.push(input.file_path)
        }
      }
    }
  }

  return paths
}

/**
 * 扫描 bash 工具结果中的提交 SHA 和 PR URL，并写入折叠组累加器。
 * 仅对 bashCommands 中已记录的工具调用结果（非搜索/读取的 bash）进行扫描。
 * git push 会将 ref 更新写入 stderr，因此同时扫描 stdout 和 stderr。
 */
function scanBashResultForGitOps(
  msg: CollapsibleMessage,
  group: GroupAccumulator,
): void {
  if (msg.type !== 'user') return
  const out = msg.toolUseResult as
    | { stdout?: string; stderr?: string }
    | undefined
  if (!out?.stdout && !out?.stderr) return
  // git push 将 ref 更新写入 stderr — 同时扫描两个流
  const combined = (out.stdout ?? '') + '\n' + (out.stderr ?? '')
  for (const c of msg.message.content) {
    if (c.type !== 'tool_result') continue
    const command = group.bashCommands?.get(c.tool_use_id)
    if (!command) continue
    const { commit, push, branch, pr } = detectGitOperation(command, combined)
    if (commit) group.commits?.push(commit)
    if (push) group.pushes?.push(push)
    if (branch) group.branches?.push(branch)
    if (pr) group.prs?.push(pr)
    if (commit || push || branch || pr) {
      group.gitOpBashCount = (group.gitOpBashCount ?? 0) + 1
    }
  }
}

type GroupAccumulator = {
  messages: CollapsibleMessage[]
  searchCount: number
  readFilePaths: Set<string>
  // 不含文件路径的读取操作计数（如 Bash cat 命令）
  readOperationCount: number
  // 目录列表操作计数（ls、tree、du 等）
  listCount: number
  toolUseIds: Set<string>
  // 内存文件操作计数（与常规计数分开追踪）
  memorySearchCount: number
  memoryReadFilePaths: Set<string>
  memoryWriteCount: number
  // 团队内存文件操作计数（与个人内存分开追踪）
  teamMemorySearchCount?: number
  teamMemoryReadFilePaths?: Set<string>
  teamMemoryWriteCount?: number
  // 用于折叠摘要下方展示的非内存搜索模式参数
  nonMemSearchArgs: string[]
  /** 最近添加的非内存操作，已预格式化以供显示 */
  latestDisplayHint: string | undefined
  // MCP 工具调用（单独追踪，使摘要显示"查询了 slack"而非"读取了 N 个文件"）
  mcpCallCount?: number
  mcpServerNames?: Set<string>
  // 非搜索/读取的 bash 命令（单独追踪，显示"运行了 N 条 bash 命令"）
  bashCount?: number
  // bash tool_use_id → 命令字符串，用于在工具结果中扫描
  // 提交 SHA / PR URL（显示为"已提交 abc123、已创建 PR #42"）
  bashCommands?: Map<string, string>
  commits?: { sha: string; kind: CommitKind }[]
  pushes?: { branch: string }[]
  branches?: { ref: string; action: BranchAction }[]
  prs?: { number: number; url?: string; action: PrAction }[]
  gitOpBashCount?: number
  // 从 hook 摘要消息中吸收的 PreToolUse 钩子计时数据
  hookTotalMs: number
  hookCount: number
  hookInfos: StopHookInfo[]
  // 被吸收进本折叠组的 relevant_memories 附件（自动注入的内存，非显式 Read 调用）。
  // 路径会同步写入 readFilePaths + memoryReadFilePaths，确保"已召回 N 条记忆"文本准确。
  relevantMemories?: { path: string; content: string; mtimeMs: number }[]
}

/**
 * 创建一个空的折叠组累加器，根据当前运行模式（全屏/TEAMMEM）初始化可选字段。
 */
function createEmptyGroup(): GroupAccumulator {
  const group: GroupAccumulator = {
    messages: [],
    searchCount: 0,
    readFilePaths: new Set(),
    readOperationCount: 0,
    listCount: 0,
    toolUseIds: new Set(),
    memorySearchCount: 0,
    memoryReadFilePaths: new Set(),
    memoryWriteCount: 0,
    nonMemSearchArgs: [],
    latestDisplayHint: undefined,
    hookTotalMs: 0,
    hookCount: 0,
    hookInfos: [],
  }
  if (feature('TEAMMEM')) {
    group.teamMemorySearchCount = 0
    group.teamMemoryReadFilePaths = new Set()
    group.teamMemoryWriteCount = 0
  }
  group.mcpCallCount = 0
  group.mcpServerNames = new Set()
  if (isFullscreenEnvEnabled()) {
    group.bashCount = 0
    group.bashCommands = new Map()
    group.commits = []
    group.pushes = []
    group.branches = []
    group.prs = []
    group.gitOpBashCount = 0
  }
  return group
}

function createCollapsedGroup(
  group: GroupAccumulator,
): CollapsedReadSearchGroup {
  const firstMsg = group.messages[0]!
  // 存在按路径读取时，仅使用唯一文件计数（Set.size），避免双重计算：
  // 例如 Read(README.md) 后紧跟 Bash(wc -l README.md)，应显示为 1 个文件，而非 2。
  // 仅在没有文件路径读取（纯 bash）时才回退到操作计数。
  const totalReadCount =
    group.readFilePaths.size > 0
      ? group.readFilePaths.size
      : group.readOperationCount
  // memoryReadFilePaths ⊆ readFilePaths（均来自 Read 工具调用），
  // 故从 totalReadCount 中减去此计数是安全的。
  // 吸收的 relevant_memories 附件不在 readFilePaths 中，
  // 在减法之后单独加入 memoryReadCount，确保 readCount 正确。
  const toolMemoryReadCount = group.memoryReadFilePaths.size
  const memoryReadCount =
    toolMemoryReadCount + (group.relevantMemories?.length ?? 0)
  // 非内存读取文件路径：过滤掉内存和团队内存路径
  const teamMemReadPaths = feature('TEAMMEM')
    ? group.teamMemoryReadFilePaths
    : undefined
  const nonMemReadFilePaths = [...group.readFilePaths].filter(
    p =>
      !group.memoryReadFilePaths.has(p) && !(teamMemReadPaths?.has(p) ?? false),
  )
  const teamMemSearchCount = feature('TEAMMEM')
    ? (group.teamMemorySearchCount ?? 0)
    : 0
  const teamMemReadCount = feature('TEAMMEM')
    ? (group.teamMemoryReadFilePaths?.size ?? 0)
    : 0
  const teamMemWriteCount = feature('TEAMMEM')
    ? (group.teamMemoryWriteCount ?? 0)
    : 0
  const result: CollapsedReadSearchGroup = {
    type: 'collapsed_read_search',
    // 减去内存和团队内存计数，使常规计数仅反映非内存操作
    searchCount: Math.max(
      0,
      group.searchCount - group.memorySearchCount - teamMemSearchCount,
    ),
    readCount: Math.max(
      0,
      totalReadCount - toolMemoryReadCount - teamMemReadCount,
    ),
    listCount: group.listCount,
    // REPL 操作有意不折叠（见上方 isCollapsible: false），
    // 因此折叠组中 replCount 始终为 0。该字段保留是为了
    // AgentTool/UI.tsx 中子代理进度展示使用，其有独立的代码路径。
    replCount: 0,
    memorySearchCount: group.memorySearchCount,
    memoryReadCount,
    memoryWriteCount: group.memoryWriteCount,
    readFilePaths: nonMemReadFilePaths,
    searchArgs: group.nonMemSearchArgs,
    latestDisplayHint: group.latestDisplayHint,
    messages: group.messages,
    displayMessage: firstMsg,
    uuid: `collapsed-${firstMsg.uuid}` as UUID,
    timestamp: firstMsg.timestamp,
  }
  if (feature('TEAMMEM')) {
    result.teamMemorySearchCount = teamMemSearchCount
    result.teamMemoryReadCount = teamMemReadCount
    result.teamMemoryWriteCount = teamMemWriteCount
  }
  if ((group.mcpCallCount ?? 0) > 0) {
    result.mcpCallCount = group.mcpCallCount
    result.mcpServerNames = [...(group.mcpServerNames ?? [])]
  }
  if (isFullscreenEnvEnabled()) {
    if ((group.bashCount ?? 0) > 0) {
      result.bashCount = group.bashCount
      result.gitOpBashCount = group.gitOpBashCount
    }
    if ((group.commits?.length ?? 0) > 0) result.commits = group.commits
    if ((group.pushes?.length ?? 0) > 0) result.pushes = group.pushes
    if ((group.branches?.length ?? 0) > 0) result.branches = group.branches
    if ((group.prs?.length ?? 0) > 0) result.prs = group.prs
  }
  if (group.hookCount > 0) {
    result.hookTotalMs = group.hookTotalMs
    result.hookCount = group.hookCount
    result.hookInfos = group.hookInfos
  }
  if (group.relevantMemories && group.relevantMemories.length > 0) {
    result.relevantMemories = group.relevantMemories
  }
  return result
}

/**
 * 将连续的读取/搜索操作折叠为摘要组。
 *
 * 折叠规则：
 * - 将连续的搜索/读取工具调用（Grep、Glob、Read 及 bash 搜索/读取命令）归入同一组
 * - 对应的工具结果也包含在组内
 * - 遇到助手文本消息时中断当前组
 */
export function collapseReadSearchGroups(
  messages: RenderableMessage[],
  tools: Tools,
): RenderableMessage[] {
  const result: RenderableMessage[] = []
  let currentGroup = createEmptyGroup()
  let deferredSkippable: RenderableMessage[] = []

  function flushGroup(): void {
    if (currentGroup.messages.length === 0) {
      return
    }
    result.push(createCollapsedGroup(currentGroup))
    for (const deferred of deferredSkippable) {
      result.push(deferred)
    }
    deferredSkippable = []
    currentGroup = createEmptyGroup()
  }

  for (const msg of messages) {
    if (isCollapsibleToolUse(msg, tools)) {
      // 这是可折叠的工具调用 — 类型谓词将其收窄为 CollapsibleMessage
      const toolInfo = getCollapsibleToolInfo(msg, tools)!

      if (toolInfo.isMemoryWrite) {
        // 内存文件写入/编辑 — 检查是否为团队内存
        const count = countToolUses(msg)
        if (
          feature('TEAMMEM') &&
          teamMemOps?.isTeamMemoryWriteOrEdit(toolInfo.name, toolInfo.input)
        ) {
          currentGroup.teamMemoryWriteCount =
            (currentGroup.teamMemoryWriteCount ?? 0) + count
        } else {
          currentGroup.memoryWriteCount += count
        }
      } else if (toolInfo.isAbsorbedSilently) {
        // Snip/ToolSearch 被静默吸收 — 不计数，不生成摘要文本。
        // 默认视图下隐藏，但在详细模式（Ctrl+O）下仍可通过
        // CollapsedReadSearchContent 的 groupMessages 迭代查看。
      } else if (toolInfo.mcpServerName) {
        // MCP 搜索/读取 — 单独计数，使摘要显示
        // "查询了 slack N 次"而非"读取了 N 个文件"。
        const count = countToolUses(msg)
        currentGroup.mcpCallCount = (currentGroup.mcpCallCount ?? 0) + count
        currentGroup.mcpServerNames?.add(toolInfo.mcpServerName)
        const input = toolInfo.input as { query?: string } | undefined
        if (input?.query) {
          currentGroup.latestDisplayHint = `"${input.query}"`
        }
      } else if (isFullscreenEnvEnabled() && toolInfo.isBash) {
        // 非搜索/读取的 bash 命令 — 单独计数，使摘要显示
        // "运行了 N 条 bash 命令"而非中断折叠组。
        const count = countToolUses(msg)
        currentGroup.bashCount = (currentGroup.bashCount ?? 0) + count
        const input = toolInfo.input as { command?: string } | undefined
        if (input?.command) {
          // 优先使用去掉 `# comment` 后的注释内容（这是 Claude 为人类写的注释，
          // 与工具调用渲染中"注释作为标签"的逻辑触发条件相同）。
          currentGroup.latestDisplayHint =
            extractBashCommentLabel(input.command) ??
            commandAsHint(input.command)
          // 记录 tool_use_id → 命令字符串，以便在后续结果中扫描提交 SHA / PR URL。
          for (const id of getToolUseIdsFromMessage(msg)) {
            currentGroup.bashCommands?.set(id, input.command)
          }
        }
      } else if (toolInfo.isList) {
        // 目录列表 bash 命令（ls、tree、du）— 单独计数，
        // 使摘要显示"列出了 N 个目录"而非"读取了 N 个文件"。
        currentGroup.listCount += countToolUses(msg)
        const input = toolInfo.input as { command?: string } | undefined
        if (input?.command) {
          currentGroup.latestDisplayHint = commandAsHint(input.command)
        }
      } else if (toolInfo.isSearch) {
        // 使用工具的 isSearch 标志对 bash 搜索命令正确分类
        const count = countToolUses(msg)
        currentGroup.searchCount += count
        // 检查搜索目标是否为内存文件（通过路径或 glob 模式判断）
        if (
          feature('TEAMMEM') &&
          teamMemOps?.isTeamMemorySearch(toolInfo.input)
        ) {
          currentGroup.teamMemorySearchCount =
            (currentGroup.teamMemorySearchCount ?? 0) + count
        } else if (isMemorySearch(toolInfo.input)) {
          currentGroup.memorySearchCount += count
        } else {
          // 常规（非内存）搜索 — 收集模式参数以供展示
          const input = toolInfo.input as { pattern?: string } | undefined
          if (input?.pattern) {
            currentGroup.nonMemSearchArgs.push(input.pattern)
            currentGroup.latestDisplayHint = `"${input.pattern}"`
          }
        }
      } else {
        // 对于读取操作，追踪唯一文件路径而非操作次数
        const filePaths = getFilePathsFromReadMessage(msg)
        for (const filePath of filePaths) {
          currentGroup.readFilePaths.add(filePath)
          if (feature('TEAMMEM') && teamMemOps?.isTeamMemFile(filePath)) {
            currentGroup.teamMemoryReadFilePaths?.add(filePath)
          } else if (isAutoManagedMemoryFile(filePath)) {
            currentGroup.memoryReadFilePaths.add(filePath)
          } else {
            // 非内存文件读取 — 更新显示提示
            currentGroup.latestDisplayHint = getDisplayPath(filePath)
          }
        }
        // 若未找到文件路径（如 ls、cat 等 bash 读取命令），则统计操作次数
        if (filePaths.length === 0) {
          currentGroup.readOperationCount += countToolUses(msg)
          // 使用 bash 命令作为显示提示（截断以提高可读性）
          const input = toolInfo.input as { command?: string } | undefined
          if (input?.command) {
            currentGroup.latestDisplayHint = commandAsHint(input.command)
          }
        }
      }

      // 追踪工具调用 ID 以便匹配对应结果
      for (const id of getToolUseIdsFromMessage(msg)) {
        currentGroup.toolUseIds.add(id)
      }

      currentGroup.messages.push(msg)
    } else if (isCollapsibleToolResult(msg, currentGroup.toolUseIds)) {
      currentGroup.messages.push(msg)
      // 扫描 bash 结果中的提交 SHA / PR URL，以便在摘要中展示
      if (isFullscreenEnvEnabled() && currentGroup.bashCommands?.size) {
        scanBashResultForGitOps(msg, currentGroup)
      }
    } else if (currentGroup.messages.length > 0 && isPreToolHookSummary(msg)) {
      // 将 PreToolUse hook 摘要吸收进折叠组，而非推迟输出
      currentGroup.hookCount += msg.hookCount
      currentGroup.hookTotalMs +=
        msg.totalDurationMs ??
        msg.hookInfos.reduce((sum, h) => sum + (h.durationMs ?? 0), 0)
      currentGroup.hookInfos.push(...msg.hookInfos)
    } else if (
      currentGroup.messages.length > 0 &&
      msg.type === 'attachment' &&
      msg.attachment.type === 'relevant_memories'
    ) {
      // 吸收自动注入的内存附件，使"已回忆 N 条记忆"与"运行了 N 条 bash 命令"
      // 在行内一起渲染，而非单独显示为 ⏺ 块。
      // 不要将路径加入 readFilePaths/memoryReadFilePaths ——
      // 那样会污染 readOperationCount 的回退逻辑（仅有 bash 的读取没有路径；
      // 加入内存路径会使 readFilePaths.size > 0，从而抑制回退）。
      // createCollapsedGroup 在减去 readCount 之后再将 .length 加到 memoryReadCount。
      currentGroup.relevantMemories ??= []
      currentGroup.relevantMemories.push(...msg.attachment.memories)
    } else if (shouldSkipMessage(msg)) {
      // 不因可跳过消息（thinking、附件、system）而刷新折叠组
      // 若折叠组正在进行中，将这些消息推迟到折叠徽章之后输出，
      // 以保证折叠徽章的视觉位置对齐第一条工具调用，
      // 而非被中间插入的可跳过消息向下推移。
      // 例外：nested_memory 附件即使在折叠组进行中也直接透传，
      // 使"⎿ 已加载 N 行"紧密聚合，不被徽章的 marginTop 分隔。
      if (
        currentGroup.messages.length > 0 &&
        !(msg.type === 'attachment' && msg.attachment.type === 'nested_memory')
      ) {
        deferredSkippable.push(msg)
      } else {
        result.push(msg)
      }
    } else if (isTextBreaker(msg)) {
      // 助手文本消息打断当前折叠组
      flushGroup()
      result.push(msg)
    } else if (isNonCollapsibleToolUse(msg, tools)) {
      // 不可折叠的工具调用打断当前折叠组
      flushGroup()
      result.push(msg)
    } else {
      // 含不可折叠工具结果的用户消息打断当前折叠组
      flushGroup()
      result.push(msg)
    }
  }

  flushGroup()
  return result
}

/**
 * 生成搜索/读取/REPL 操作计数的摘要文本。
 * @param searchCount 搜索操作数量
 * @param readCount 读取操作数量
 * @param isActive 折叠组是否仍在进行中（true 用现在时，false 用过去时）
 * @param replCount REPL 执行次数（可选）
 * @param memoryCounts 内存文件操作计数（可选）
 * @returns 摘要文本，如"正在搜索 3 个模式，读取 2 个文件，REPL 执行 5 次……"
 */
export function getSearchReadSummaryText(
  searchCount: number,
  readCount: number,
  isActive: boolean,
  replCount: number = 0,
  memoryCounts?: {
    memorySearchCount: number
    memoryReadCount: number
    memoryWriteCount: number
    teamMemorySearchCount?: number
    teamMemoryReadCount?: number
    teamMemoryWriteCount?: number
  },
  listCount: number = 0,
): string {
  const parts: string[] = []

  // 内存操作优先放在摘要最前面
  if (memoryCounts) {
    const { memorySearchCount, memoryReadCount, memoryWriteCount } =
      memoryCounts
    if (memoryReadCount > 0) {
      const verb = isActive
        ? parts.length === 0
          ? 'Recalling'
          : 'recalling'
        : parts.length === 0
          ? 'Recalled'
          : 'recalled'
      parts.push(
        `${verb} ${memoryReadCount} ${memoryReadCount === 1 ? 'memory' : 'memories'}`,
      )
    }
    if (memorySearchCount > 0) {
      const verb = isActive
        ? parts.length === 0
          ? 'Searching'
          : 'searching'
        : parts.length === 0
          ? 'Searched'
          : 'searched'
      parts.push(`${verb} memories`)
    }
    if (memoryWriteCount > 0) {
      const verb = isActive
        ? parts.length === 0
          ? 'Writing'
          : 'writing'
        : parts.length === 0
          ? 'Wrote'
          : 'wrote'
      parts.push(
        `${verb} ${memoryWriteCount} ${memoryWriteCount === 1 ? 'memory' : 'memories'}`,
      )
    }
    // 团队内存操作
    if (feature('TEAMMEM') && teamMemOps) {
      teamMemOps.appendTeamMemorySummaryParts(memoryCounts, isActive, parts)
    }
  }

  if (searchCount > 0) {
    const searchVerb = isActive
      ? parts.length === 0
        ? 'Searching for'
        : 'searching for'
      : parts.length === 0
        ? 'Searched for'
        : 'searched for'
    parts.push(
      `${searchVerb} ${searchCount} ${searchCount === 1 ? 'pattern' : 'patterns'}`,
    )
  }

  if (readCount > 0) {
    const readVerb = isActive
      ? parts.length === 0
        ? 'Reading'
        : 'reading'
      : parts.length === 0
        ? 'Read'
        : 'read'
    parts.push(`${readVerb} ${readCount} ${readCount === 1 ? 'file' : 'files'}`)
  }

  if (listCount > 0) {
    const listVerb = isActive
      ? parts.length === 0
        ? 'Listing'
        : 'listing'
      : parts.length === 0
        ? 'Listed'
        : 'listed'
    parts.push(
      `${listVerb} ${listCount} ${listCount === 1 ? 'directory' : 'directories'}`,
    )
  }

  if (replCount > 0) {
    const replVerb = isActive ? "REPL'ing" : "REPL'd"
    parts.push(`${replVerb} ${replCount} ${replCount === 1 ? 'time' : 'times'}`)
  }

  const text = parts.join(', ')
  return isActive ? `${text}…` : text
}

/**
 * 将最近工具活动列表汇总为简洁描述。
 * 将尾部连续的搜索/读取操作合并统计（使用记录时预计算的 isSearch/isRead 分类）。
 * 对不可折叠的工具调用，回退为最后一条活动的描述文本。
 */
export function summarizeRecentActivities(
  activities: readonly {
    activityDescription?: string
    isSearch?: boolean
    isRead?: boolean
  }[],
): string | undefined {
  if (activities.length === 0) {
    return undefined
  }
  // 从列表末尾向前统计连续的搜索/读取活动数量
  let searchCount = 0
  let readCount = 0
  for (let i = activities.length - 1; i >= 0; i--) {
    const activity = activities[i]!
    if (activity.isSearch) {
      searchCount++
    } else if (activity.isRead) {
      readCount++
    } else {
      break
    }
  }
  const collapsibleCount = searchCount + readCount
  if (collapsibleCount >= 2) {
    return getSearchReadSummaryText(searchCount, readCount, true)
  }
  // 回退：向后查找最近一条有描述文本的活动
  // （SendMessage 等部分工具未实现 getActivityDescription，需向后搜索）
  for (let i = activities.length - 1; i >= 0; i--) {
    if (activities[i]?.activityDescription) {
      return activities[i]!.activityDescription
    }
  }
  return undefined
}
