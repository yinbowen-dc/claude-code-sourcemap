/**
 * 推测执行模块（Speculation）
 *
 * 在 Claude Code 系统流程中的位置：
 * 本文件是 PromptSuggestion 子系统的推测执行层，仅对 ANT 内部用户启用。
 * 在展示建议的同时，预先执行用户可能接受的操作（speculate），从而节省用户等待时间。
 * 它位于以下层次结构中：
 *   - 调用方：promptSuggestion.ts（executePromptSuggestion 在生成建议后触发 startSpeculation）
 *   - 本模块：编排整个推测执行生命周期（start → canUseTool 拦截 → accept/abort）
 *   - 下层：forkedAgent（实际执行推测工具调用）、overlay 文件系统（隔离写操作）
 *
 * 主要功能：
 * - isSpeculationEnabled：仅 ANT 用户（USER_TYPE=ant）且 speculationEnabled 配置为 true
 * - startSpeculation：创建 overlay 目录 → 设置 AppState active → runForkedAgent（含 canUseTool 拦截器）
 *   - canUseTool 拦截器：写工具需权限检查 → 写路径重定向到 overlay（copy-on-write）→ 读路径重定向到 overlay（若已写）→
 *     Bash 检查只读约束 → 其他工具拒绝（设置 boundary 并 abort）
 * - acceptSpeculation：abort → copyOverlayToMain → safeRemoveOverlay → 计算 timeSaved → 记录事件 → 追加 transcript
 * - abortSpeculation：记录 'aborted' 事件 → safeRemoveOverlay → 重置 AppState 为 IDLE
 * - handleSpeculationAccept：完整的接受流程（清空建议 → 注入消息 → 提升流水线建议 → 触发下次推测）
 * - generatePipelinedSuggestion：推测完成后预生成下一个建议（减少用户等待下一条建议的时间）
 * - prepareMessagesForInjection：过滤 thinking/redacted_thinking/未解析 tool_use/INTERRUPT_MESSAGE
 *
 * 设计说明：
 * - Overlay 文件系统隔离：推测执行的写操作不影响主工作区（getClaudeTempDir()/speculation/{pid}/{id}/）
 * - Copy-on-write：首次写文件前将原文件复制到 overlay，保证原文件不被修改
 * - WRITE_TOOLS = {'Edit', 'Write', 'NotebookEdit'}：需要 copy-on-write 隔离的工具
 * - SAFE_READ_ONLY_TOOLS = {'Read', 'Glob', 'Grep', 'ToolSearch', 'LSP', 'TaskGet', 'TaskList'}：安全的只读工具
 * - MAX_SPECULATION_TURNS = 20, MAX_SPECULATION_MESSAGES = 100：防止推测无限循环
 * - boundary 类型：complete（正常完成）/ edit（遇到需要权限的文件编辑）/ bash（遇到非只读 Bash 命令）/ denied_tool（不支持的工具）
 * - timeSavedMs：从 startTime 到 min(acceptedAt, boundary.completedAt) 的时间差，反映实际节省的等待时间
 * - pipelinedSuggestion：推测完成后预生成的下一个建议，在用户接受当前推测时立即展示，减少下次等待
 */

import { randomUUID } from 'crypto'
import { rm } from 'fs'
import { appendFile, copyFile, mkdir } from 'fs/promises'
import { dirname, isAbsolute, join, relative } from 'path'
import { getCwdState } from '../../bootstrap/state.js'
import type { CompletionBoundary } from '../../state/AppStateStore.js'
import {
  type AppState,
  IDLE_SPECULATION_STATE,
  type SpeculationResult,
  type SpeculationState,
} from '../../state/AppStateStore.js'
import { commandHasAnyCd } from '../../tools/BashTool/bashPermissions.js'
import { checkReadOnlyConstraints } from '../../tools/BashTool/readOnlyValidation.js'
import type { SpeculationAcceptMessage } from '../../types/logs.js'
import type { Message } from '../../types/message.js'
import { createChildAbortController } from '../../utils/abortController.js'
import { count } from '../../utils/array.js'
import { getGlobalConfig } from '../../utils/config.js'
import { logForDebugging } from '../../utils/debug.js'
import { errorMessage } from '../../utils/errors.js'
import {
  type FileStateCache,
  mergeFileStateCaches,
  READ_FILE_STATE_CACHE_SIZE,
} from '../../utils/fileStateCache.js'
import {
  type CacheSafeParams,
  createCacheSafeParams,
  runForkedAgent,
} from '../../utils/forkedAgent.js'
import { formatDuration, formatNumber } from '../../utils/format.js'
import type { REPLHookContext } from '../../utils/hooks/postSamplingHooks.js'
import { logError } from '../../utils/log.js'
import type { SetAppState } from '../../utils/messageQueueManager.js'
import {
  createSystemMessage,
  createUserMessage,
  INTERRUPT_MESSAGE,
  INTERRUPT_MESSAGE_FOR_TOOL_USE,
} from '../../utils/messages.js'
import { getClaudeTempDir } from '../../utils/permissions/filesystem.js'
import { extractReadFilesFromMessages } from '../../utils/queryHelpers.js'
import { getTranscriptPath } from '../../utils/sessionStorage.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../analytics/index.js'
import {
  generateSuggestion,
  getPromptVariant,
  getSuggestionSuppressReason,
  logSuggestionSuppressed,
  shouldFilterSuggestion,
} from './promptSuggestion.js'

// 推测执行的最大轮次（防止无限循环）
const MAX_SPECULATION_TURNS = 20
// 推测执行的最大消息数（超过则强制中止）
const MAX_SPECULATION_MESSAGES = 100

// 需要 copy-on-write 隔离的写工具集合
const WRITE_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit'])
// 安全的只读工具集合（无需 overlay 重定向，直接允许）
const SAFE_READ_ONLY_TOOLS = new Set([
  'Read',
  'Glob',
  'Grep',
  'ToolSearch',
  'LSP',
  'TaskGet',
  'TaskList',
])

/**
 * 异步删除 overlay 目录（递归强制删除，最多重试 3 次）
 *
 * 使用异步 rm（不等待完成），避免阻塞主流程。
 * force=true 确保目录不存在时不报错（幂等）。
 *
 * @param overlayPath overlay 目录路径
 */
function safeRemoveOverlay(overlayPath: string): void {
  rm(
    overlayPath,
    { recursive: true, force: true, maxRetries: 3, retryDelay: 100 },
    () => {},
  )
}

/**
 * 获取推测执行的 overlay 目录路径
 *
 * 路径格式：{tempDir}/speculation/{pid}/{id}
 * 使用 process.pid 避免多个 Claude Code 进程的 overlay 相互冲突。
 *
 * @param id 推测执行的唯一 ID（UUID 前 8 位）
 */
function getOverlayPath(id: string): string {
  return join(getClaudeTempDir(), 'speculation', String(process.pid), id)
}

/**
 * 创建推测执行拒绝响应（行为: deny）
 *
 * 用于 canUseTool 回调中拒绝不允许的工具调用，
 * 告知 forkedAgent 此工具调用被拒绝并提供原因。
 *
 * @param message 用户可见的拒绝消息
 * @param reason 内部原因标识（用于 boundary detail）
 */
function denySpeculation(
  message: string,
  reason: string,
): {
  behavior: 'deny'
  message: string
  decisionReason: { type: 'other'; reason: string }
} {
  return {
    behavior: 'deny',
    message,
    decisionReason: { type: 'other', reason },
  }
}

/**
 * 将 overlay 目录中已写入的文件复制回主工作区
 *
 * 遍历 writtenPaths 集合（相对路径），将 overlay 中的文件复制到 cwd 对应位置。
 * 复制前创建父目录（recursive: true），确保目标路径存在。
 * 若某个文件复制失败（记录日志），allCopied 标志置为 false。
 *
 * @param overlayPath overlay 根目录路径
 * @param writtenPaths 已写入文件的相对路径集合
 * @param cwd 当前工作目录（主工作区根目录）
 * @returns 是否所有文件都成功复制
 */
async function copyOverlayToMain(
  overlayPath: string,
  writtenPaths: Set<string>,
  cwd: string,
): Promise<boolean> {
  let allCopied = true
  for (const rel of writtenPaths) {
    const src = join(overlayPath, rel)
    const dest = join(cwd, rel)
    try {
      // 确保目标目录存在（新文件可能在新目录中）
      await mkdir(dirname(dest), { recursive: true })
      await copyFile(src, dest)
    } catch {
      allCopied = false
      logForDebugging(`[Speculation] Failed to copy ${rel} to main`)
    }
  }
  return allCopied
}

// 活跃推测状态类型（从 SpeculationState 中提取 status='active' 的子类型）
export type ActiveSpeculationState = Extract<
  SpeculationState,
  { status: 'active' }
>

/**
 * 记录推测执行结果到分析系统
 *
 * 记录 tengu_speculation 事件，包含：
 * - speculation_id：唯一标识（用于跨事件关联）
 * - outcome：accepted/aborted/error
 * - duration_ms：从开始到记录时刻的耗时
 * - suggestion_length：建议文本长度
 * - tools_executed：成功执行的工具调用数量
 * - completed：是否达到 boundary（true=有 boundary，false=仍在运行中）
 * - boundary_type/tool/detail：boundary 详情（用于分析推测在何处停止）
 *
 * @param id 推测执行唯一 ID
 * @param outcome 执行结果
 * @param startTime 开始时间戳（毫秒）
 * @param suggestionLength 触发此次推测的建议文本长度
 * @param messages 推测执行的消息列表（用于统计工具调用数）
 * @param boundary 完成 boundary（可为 null 表示仍在运行中）
 * @param extras 额外字段（错误信息、is_pipelined 等）
 */
function logSpeculation(
  id: string,
  outcome: 'accepted' | 'aborted' | 'error',
  startTime: number,
  suggestionLength: number,
  messages: Message[],
  boundary: CompletionBoundary | null,
  extras?: Record<string, string | number | boolean | undefined>,
): void {
  logEvent('tengu_speculation', {
    speculation_id:
      id as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    outcome:
      outcome as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    duration_ms: Date.now() - startTime,
    suggestion_length: suggestionLength,
    // 统计成功执行的工具调用数（排除错误结果）
    tools_executed: countToolsInMessages(messages),
    completed: boundary !== null,
    boundary_type: boundary?.type as
      | AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
      | undefined,
    boundary_tool: getBoundaryTool(boundary) as
      | AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
      | undefined,
    boundary_detail: getBoundaryDetail(boundary) as
      | AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
      | undefined,
    ...extras,
  })
}

/**
 * 统计消息列表中成功执行的工具调用数量
 *
 * 从用户消息（数组内容）中提取 tool_result 块，
 * 仅统计非错误结果（is_error=false）。
 */
function countToolsInMessages(messages: Message[]): number {
  const blocks = messages
    .filter(isUserMessageWithArrayContent)
    .flatMap(m => m.message.content)
    .filter(
      (b): b is { type: string; is_error?: boolean } =>
        typeof b === 'object' && b !== null && 'type' in b,
    )
  return count(blocks, b => b.type === 'tool_result' && !b.is_error)
}

/**
 * 从 boundary 中提取工具名称（用于分析事件）
 *
 * 不同 boundary 类型的工具名称提取逻辑：
 * - bash：固定返回 'Bash'
 * - edit/denied_tool：返回 boundary.toolName
 * - complete：无工具（返回 undefined）
 */
function getBoundaryTool(
  boundary: CompletionBoundary | null,
): string | undefined {
  if (!boundary) return undefined
  switch (boundary.type) {
    case 'bash':
      return 'Bash'
    case 'edit':
    case 'denied_tool':
      return boundary.toolName
    case 'complete':
      return undefined
  }
}

/**
 * 从 boundary 中提取详情信息（用于分析事件，最多 200 字符）
 *
 * 不同 boundary 类型的详情：
 * - bash：命令字符串（前 200 字符）
 * - edit：文件路径
 * - denied_tool：detail 字段（工具调用的关键参数）
 * - complete：无详情
 */
function getBoundaryDetail(
  boundary: CompletionBoundary | null,
): string | undefined {
  if (!boundary) return undefined
  switch (boundary.type) {
    case 'bash':
      return boundary.command.slice(0, 200)
    case 'edit':
      return boundary.filePath
    case 'denied_tool':
      return boundary.detail
    case 'complete':
      return undefined
  }
}

/**
 * 类型守卫：判断消息是否为内容为数组的用户消息
 *
 * 用于从消息列表中筛选包含工具结果的用户消息（tool_result 块在用户消息的数组内容中）。
 */
function isUserMessageWithArrayContent(
  m: Message,
): m is Message & { message: { content: unknown[] } } {
  return m.type === 'user' && 'message' in m && Array.isArray(m.message.content)
}

/**
 * 准备要注入到主对话的推测消息列表
 *
 * 从推测执行消息中过滤掉不适合注入主对话的内容：
 * 1. thinking/redacted_thinking 块（内部推理，不应暴露给后续对话）
 * 2. 未解析的 tool_use 块（没有对应成功结果的工具调用，避免 API 报 400）
 * 3. 对应未解析 tool_use 的 tool_result 块
 * 4. INTERRUPT_MESSAGE/INTERRUPT_MESSAGE_FOR_TOOL_USE 文本（推测中断信号，非真实用户输入）
 * 5. 过滤后内容为空或仅含空白文本的消息（API 拒绝纯空白内容）
 *
 * 关键：通过双向扫描确定哪些 tool_use ID 有成功结果：
 * - 先收集所有成功 tool_result（非错误、非 INTERRUPT）对应的 tool_use_id
 * - 再过滤没有成功结果的 tool_use 和 tool_result 块
 *
 * @param messages 推测执行的原始消息列表
 * @returns 清洗后可以安全注入主对话的消息列表
 */
export function prepareMessagesForInjection(messages: Message[]): Message[] {
  // 收集有成功结果的 tool_use ID（未解析的 tool_use 和被中断的 tool_result 将被过滤）
  type ToolResult = {
    type: 'tool_result'
    tool_use_id: string
    is_error?: boolean
    content?: unknown
  }
  const isToolResult = (b: unknown): b is ToolResult =>
    typeof b === 'object' &&
    b !== null &&
    (b as ToolResult).type === 'tool_result' &&
    typeof (b as ToolResult).tool_use_id === 'string'
  // 成功结果：非错误且内容不含中断消息
  const isSuccessful = (b: ToolResult) =>
    !b.is_error &&
    !(
      typeof b.content === 'string' &&
      b.content.includes(INTERRUPT_MESSAGE_FOR_TOOL_USE)
    )

  // 收集所有有成功结果的 tool_use_id
  const toolIdsWithSuccessfulResults = new Set(
    messages
      .filter(isUserMessageWithArrayContent)
      .flatMap(m => m.message.content)
      .filter(isToolResult)
      .filter(isSuccessful)
      .map(b => b.tool_use_id),
  )

  // 过滤函数：判断某个内容块是否应保留
  const keep = (b: {
    type: string
    id?: string
    tool_use_id?: string
    text?: string
  }) =>
    // 过滤内部推理块（不应暴露）
    b.type !== 'thinking' &&
    b.type !== 'redacted_thinking' &&
    // 过滤未解析的 tool_use（没有对应成功结果）
    !(b.type === 'tool_use' && !toolIdsWithSuccessfulResults.has(b.id!)) &&
    // 过滤未解析 tool_use 对应的 tool_result
    !(
      b.type === 'tool_result' &&
      !toolIdsWithSuccessfulResults.has(b.tool_use_id!)
    ) &&
    // 推测中止时产生的中断用户消息，过滤掉避免模型误认为是真实用户输入
    !(
      b.type === 'text' &&
      (b.text === INTERRUPT_MESSAGE ||
        b.text === INTERRUPT_MESSAGE_FOR_TOOL_USE)
    )

  return messages
    .map(msg => {
      if (!('message' in msg) || !Array.isArray(msg.message.content)) return msg
      const content = msg.message.content.filter(keep)
      // 内容未变化：直接返回原消息（节省内存）
      if (content.length === msg.message.content.length) return msg
      // 过滤后内容为空：丢弃整条消息
      if (content.length === 0) return null
      // API 拒绝纯空白文本内容（"text content blocks must contain non-whitespace text"）
      const hasNonWhitespaceContent = content.some(
        (b: { type: string; text?: string }) =>
          b.type !== 'text' || (b.text !== undefined && b.text.trim() !== ''),
      )
      if (!hasNonWhitespaceContent) return null
      // 返回过滤后的消息副本
      return { ...msg, message: { ...msg.message, content } } as typeof msg
    })
    .filter((m): m is Message => m !== null)
}

/**
 * 创建推测执行反馈消息（仅 ANT 用户）
 *
 * 在推测被接受后，向对话中注入一条系统提示消息，显示：
 * - 推测了多少个工具调用（或多少轮对话）
 * - 输出了多少 token（complete 时）
 * - 节省了多少时间（本次 + 本 session 累计）
 *
 * 仅在以下条件满足时创建：
 * - USER_TYPE === 'ant'（仅 ANT 内部用户）
 * - messages.length > 0（有实际执行的消息）
 * - timeSavedMs > 0（有节省时间）
 *
 * @param messages 推测执行的消息列表
 * @param boundary 完成 boundary（用于提取 token 数）
 * @param timeSavedMs 本次推测节省的时间（毫秒）
 * @param sessionTotalMs 本 session 累计节省的时间（毫秒）
 * @returns 系统消息，或 null（不满足条件时）
 */
function createSpeculationFeedbackMessage(
  messages: Message[],
  boundary: CompletionBoundary | null,
  timeSavedMs: number,
  sessionTotalMs: number,
): Message | null {
  // 仅 ANT 内部用户展示反馈消息
  if (process.env.USER_TYPE !== 'ant') return null

  // 无推测消息或无节省时间时不展示
  if (messages.length === 0 || timeSavedMs === 0) return null

  const toolUses = countToolsInMessages(messages)
  // complete boundary 时提取 output token 数（其他 boundary 无此信息）
  const tokens = boundary?.type === 'complete' ? boundary.outputTokens : null

  const parts = []
  if (toolUses > 0) {
    // 有工具调用时展示工具数
    parts.push(`Speculated ${toolUses} tool ${toolUses === 1 ? 'use' : 'uses'}`)
  } else {
    // 无工具调用时展示轮次数
    const turns = messages.length
    parts.push(`Speculated ${turns} ${turns === 1 ? 'turn' : 'turns'}`)
  }

  if (tokens !== null) {
    parts.push(`${formatNumber(tokens)} tokens`)
  }

  const savedText = `+${formatDuration(timeSavedMs)} saved`
  // 若 session 累计时间与本次不同，附加显示 session 累计（否则不重复展示）
  const sessionSuffix =
    sessionTotalMs !== timeSavedMs
      ? ` (${formatDuration(sessionTotalMs)} this session)`
      : ''

  return createSystemMessage(
    `[ANT-ONLY] ${parts.join(' · ')} · ${savedText}${sessionSuffix}`,
    'warning',
  )
}

/**
 * 更新 AppState 中活跃推测状态的部分字段
 *
 * 使用 setAppState 不可变更新模式，仅在 speculation.status === 'active' 时更新。
 * 通过 hasChanges 检查避免无实际变化的重渲染（优化 React 渲染性能）。
 *
 * @param setAppState AppState 更新函数
 * @param updater 接受当前活跃状态，返回需要更新的部分字段
 */
function updateActiveSpeculationState(
  setAppState: SetAppState,
  updater: (state: ActiveSpeculationState) => Partial<ActiveSpeculationState>,
): void {
  setAppState(prev => {
    // 仅在活跃状态时更新（避免状态不一致）
    if (prev.speculation.status !== 'active') return prev
    const current = prev.speculation as ActiveSpeculationState
    const updates = updater(current)
    // 检查是否有实际变化（避免不必要的重渲染）
    const hasChanges = Object.entries(updates).some(
      ([key, value]) => current[key as keyof ActiveSpeculationState] !== value,
    )
    if (!hasChanges) return prev
    return {
      ...prev,
      speculation: { ...current, ...updates },
    }
  })
}

/**
 * 将 AppState 中的推测状态重置为 IDLE
 *
 * 幂等操作：若当前已是 idle 状态，直接返回不触发更新。
 */
function resetSpeculationState(setAppState: SetAppState): void {
  setAppState(prev => {
    if (prev.speculation.status === 'idle') return prev
    return { ...prev, speculation: IDLE_SPECULATION_STATE }
  })
}

/**
 * 检查推测执行功能是否启用
 *
 * 启用条件（两者同时满足）：
 * 1. USER_TYPE === 'ant'（仅 ANT 内部用户，功能尚在内部测试）
 * 2. globalConfig.speculationEnabled !== false（配置允许，默认为 true）
 *
 * @returns 推测执行是否启用
 */
export function isSpeculationEnabled(): boolean {
  const enabled =
    process.env.USER_TYPE === 'ant' &&
    (getGlobalConfig().speculationEnabled ?? true)
  logForDebugging(`[Speculation] enabled=${enabled}`)
  return enabled
}

/**
 * 生成流水线（pipelined）建议：在推测执行完成后预生成下一个建议
 *
 * 在推测完成（startSpeculation 的 forkedAgent 结束后）调用，
 * 预生成用户接受当前推测后可能输入的下一个建议，减少下次等待时间。
 *
 * 完整流程：
 * 1. 抑制检查（与普通建议相同）
 * 2. 构建增强上下文（context + 建议文本用户消息 + 推测消息）
 * 3. 创建子 AbortController（受 parentAbortController 控制）
 * 4. 调用 generateSuggestion 生成下一个建议
 * 5. shouldFilterSuggestion 过滤
 * 6. 通过 updateActiveSpeculationState 将建议保存到 pipelinedSuggestion 字段
 *
 * 设计：流水线建议保存在 AppState.speculation.pipelinedSuggestion，
 * 在用户接受推测时（handleSpeculationAccept）提升为主建议展示。
 *
 * @param context 原始 REPL Hook 上下文
 * @param suggestionText 当前推测对应的建议文本
 * @param speculatedMessages 推测执行的消息列表（用于增强上下文）
 * @param setAppState AppState 更新函数
 * @param parentAbortController 父中止控制器（推测被中止时子控制器也中止）
 */
async function generatePipelinedSuggestion(
  context: REPLHookContext,
  suggestionText: string,
  speculatedMessages: Message[],
  setAppState: SetAppState,
  parentAbortController: AbortController,
): Promise<void> {
  try {
    // 检查运行时抑制条件（与普通建议路径相同）
    const appState = context.toolUseContext.getAppState()
    const suppressReason = getSuggestionSuppressReason(appState)
    if (suppressReason) {
      logSuggestionSuppressed(`pipeline_${suppressReason}`)
      return
    }

    // 构建增强上下文：原始消息 + 建议文本（作为用户消息）+ 推测结果消息
    const augmentedContext: REPLHookContext = {
      ...context,
      messages: [
        ...context.messages,
        createUserMessage({ content: suggestionText }),
        ...speculatedMessages,
      ],
    }

    // 创建子控制器（父控制器中止时子控制器自动中止）
    const pipelineAbortController = createChildAbortController(
      parentAbortController,
    )
    if (pipelineAbortController.signal.aborted) return

    // 生成流水线建议（基于增强上下文）
    const promptId = getPromptVariant()
    const { suggestion, generationRequestId } = await generateSuggestion(
      pipelineAbortController,
      promptId,
      createCacheSafeParams(augmentedContext),
    )

    if (pipelineAbortController.signal.aborted) return
    // 过滤不合适的建议
    if (shouldFilterSuggestion(suggestion, promptId)) return

    logForDebugging(
      `[Speculation] Pipelined suggestion: "${suggestion!.slice(0, 50)}..."`,
    )
    // 将流水线建议保存到活跃推测状态（等待用户接受时提升）
    updateActiveSpeculationState(setAppState, () => ({
      pipelinedSuggestion: {
        text: suggestion!,
        promptId,
        generationRequestId,
      },
    }))
  } catch (error) {
    // AbortError 为正常取消，静默处理
    if (error instanceof Error && error.name === 'AbortError') return
    logForDebugging(
      `[Speculation] Pipelined suggestion failed: ${errorMessage(error)}`,
    )
  }
}

/**
 * 启动推测执行
 *
 * 在用户看到建议后，预先以该建议为输入运行 forkedAgent，执行可能的工具调用。
 * 若用户接受建议，推测结果直接注入对话，节省等待时间。
 *
 * 完整流程：
 * 1. isSpeculationEnabled 检查
 * 2. abortSpeculation 取消正在进行的推测
 * 3. 生成唯一 ID，创建子 AbortController
 * 4. 创建 overlay 目录（隔离写操作）
 * 5. 设置 AppState 为 active 状态（UI 显示推测进行中）
 * 6. runForkedAgent 执行推测（含 canUseTool 拦截器）：
 *    - WRITE_TOOLS 且无权限 → 设置 edit boundary + abort + deny
 *    - WRITE_TOOLS 且有权限 → copy-on-write 到 overlay + 重定向路径
 *    - SAFE_READ_ONLY_TOOLS → 若文件已写则重定向到 overlay，否则直接允许
 *    - Bash 只读约束检查 → 不通过则设置 bash boundary + abort + deny
 *    - 其他工具 → 设置 denied_tool boundary + abort + deny
 * 7. forkedAgent 正常完成 → 设置 complete boundary，触发 generatePipelinedSuggestion
 * 8. AbortError → 清理 overlay，重置 AppState
 * 9. 其他错误 → 记录 error 事件，清理，重置
 *
 * @param suggestionText 触发推测的建议文本（作为用户输入注入 forkedAgent）
 * @param context REPL Hook 上下文
 * @param setAppState AppState 更新函数
 * @param isPipelined 是否为流水线推测（前一次推测被接受后触发的推测）
 * @param cacheSafeParams 缓存安全参数（可选，缺省时从 context 创建）
 */
export async function startSpeculation(
  suggestionText: string,
  context: REPLHookContext,
  setAppState: (f: (prev: AppState) => AppState) => void,
  isPipelined = false,
  cacheSafeParams?: CacheSafeParams,
): Promise<void> {
  if (!isSpeculationEnabled()) return

  // 取消正在进行的推测（每次只维护一个活跃推测）
  abortSpeculation(setAppState)

  // 生成短 UUID（前 8 位）作为此次推测的唯一标识
  const id = randomUUID().slice(0, 8)

  // 创建子控制器（受主控制器约束，主流程取消时推测也取消）
  const abortController = createChildAbortController(
    context.toolUseContext.abortController,
  )

  // 主控制器已取消时不启动推测
  if (abortController.signal.aborted) return

  const startTime = Date.now()
  // messagesRef：通过引用传递的消息列表（由 onMessage 回调实时追加）
  const messagesRef = { current: [] as Message[] }
  // writtenPathsRef：记录已写入 overlay 的相对路径（accept 时复制回主工作区）
  const writtenPathsRef = { current: new Set<string>() }
  const overlayPath = getOverlayPath(id)
  const cwd = getCwdState()

  try {
    // 创建 overlay 目录（用于隔离写操作）
    await mkdir(overlayPath, { recursive: true })
  } catch {
    logForDebugging('[Speculation] Failed to create overlay directory')
    return
  }

  // contextRef：通过引用传递 context，供 generatePipelinedSuggestion 访问最新 context
  const contextRef = { current: context }

  // 设置 AppState 为 active 状态（UI 显示推测进行中）
  setAppState(prev => ({
    ...prev,
    speculation: {
      status: 'active',
      id,
      abort: () => abortController.abort(),
      startTime,
      messagesRef,
      writtenPathsRef,
      boundary: null,
      suggestionLength: suggestionText.length,
      toolUseCount: 0,
      isPipelined,
      contextRef,
    },
  }))

  logForDebugging(`[Speculation] Starting speculation ${id}`)

  try {
    const result = await runForkedAgent({
      promptMessages: [createUserMessage({ content: suggestionText })],
      cacheSafeParams: cacheSafeParams ?? createCacheSafeParams(context),
      // 推测执行不写入对话记录（避免污染主对话历史）
      skipTranscript: true,
      canUseTool: async (tool, input) => {
        const isWriteTool = WRITE_TOOLS.has(tool.name)
        const isSafeReadOnlyTool = SAFE_READ_ONLY_TOOLS.has(tool.name)

        // 写工具：先检查权限模式（需要 acceptEdits/bypassPermissions/plan+bypass 之一）
        if (isWriteTool) {
          const appState = context.toolUseContext.getAppState()
          const { mode, isBypassPermissionsModeAvailable } =
            appState.toolPermissionContext

          // 判断当前权限模式是否允许自动接受编辑
          const canAutoAcceptEdits =
            mode === 'acceptEdits' ||
            mode === 'bypassPermissions' ||
            (mode === 'plan' && isBypassPermissionsModeAvailable)

          if (!canAutoAcceptEdits) {
            // 无权限：设置 edit boundary（UI 展示"需要确认"）+ abort + deny
            logForDebugging(`[Speculation] Stopping at file edit: ${tool.name}`)
            const editPath = (
              'file_path' in input ? input.file_path : undefined
            ) as string | undefined
            updateActiveSpeculationState(setAppState, () => ({
              boundary: {
                type: 'edit',
                toolName: tool.name,
                filePath: editPath ?? '',
                completedAt: Date.now(),
              },
            }))
            abortController.abort()
            return denySpeculation(
              'Speculation paused: file edit requires permission',
              'speculation_edit_boundary',
            )
          }
        }

        // 写工具或安全只读工具：处理路径重定向
        if (isWriteTool || isSafeReadOnlyTool) {
          // 提取文件路径参数（不同工具的路径参数名不同）
          const pathKey =
            'notebook_path' in input
              ? 'notebook_path'
              : 'path' in input
                ? 'path'
                : 'file_path'
          const filePath = input[pathKey] as string | undefined
          if (filePath) {
            // 计算相对路径（用于 overlay 映射）
            const rel = relative(cwd, filePath)
            // 路径在 cwd 之外（绝对路径或 ../ 开头）
            if (isAbsolute(rel) || rel.startsWith('..')) {
              if (isWriteTool) {
                // 写 cwd 之外的文件：拒绝（无法安全隔离）
                logForDebugging(
                  `[Speculation] Denied ${tool.name}: path outside cwd: ${filePath}`,
                )
                return denySpeculation(
                  'Write outside cwd not allowed during speculation',
                  'speculation_write_outside_root',
                )
              }
              // 读 cwd 之外的文件：允许（直接读取，不重定向）
              return {
                behavior: 'allow' as const,
                updatedInput: input,
                decisionReason: {
                  type: 'other' as const,
                  reason: 'speculation_read_outside_root',
                },
              }
            }

            if (isWriteTool) {
              // Copy-on-write：首次写文件前将原文件复制到 overlay（保护原文件）
              if (!writtenPathsRef.current.has(rel)) {
                const overlayFile = join(overlayPath, rel)
                await mkdir(dirname(overlayFile), { recursive: true })
                try {
                  // 复制原文件到 overlay（若原文件不存在则跳过，新建文件场景）
                  await copyFile(join(cwd, rel), overlayFile)
                } catch {
                  // 原文件可能不存在（新文件创建场景），忽略错误
                }
                writtenPathsRef.current.add(rel)
              }
              // 将写入路径重定向到 overlay（隔离主工作区）
              input = { ...input, [pathKey]: join(overlayPath, rel) }
            } else {
              // 读文件：若文件已写入 overlay，重定向到 overlay（读取最新版本）
              if (writtenPathsRef.current.has(rel)) {
                input = { ...input, [pathKey]: join(overlayPath, rel) }
              }
              // 未写入的文件：直接从主工作区读取（不重定向）
            }

            logForDebugging(
              `[Speculation] ${isWriteTool ? 'Write' : 'Read'} ${filePath} -> ${input[pathKey]}`,
            )

            return {
              behavior: 'allow' as const,
              updatedInput: input,
              decisionReason: {
                type: 'other' as const,
                reason: 'speculation_file_access',
              },
            }
          }
          // 无显式路径的只读工具（如 Glob/Grep 默认使用 CWD）：直接允许（安全）
          if (isSafeReadOnlyTool) {
            return {
              behavior: 'allow' as const,
              updatedInput: input,
              decisionReason: {
                type: 'other' as const,
                reason: 'speculation_read_default_cwd',
              },
            }
          }
          // 无路径的写工具：走默认拒绝逻辑（fall through）
        }

        // Bash 工具：检查只读约束
        if (tool.name === 'Bash') {
          const command =
            'command' in input && typeof input.command === 'string'
              ? input.command
              : ''
          if (
            !command ||
            checkReadOnlyConstraints({ command }, commandHasAnyCd(command))
              .behavior !== 'allow'
          ) {
            // 非只读 Bash 命令：设置 bash boundary + abort + deny
            logForDebugging(
              `[Speculation] Stopping at bash: ${command.slice(0, 50) || 'missing command'}`,
            )
            updateActiveSpeculationState(setAppState, () => ({
              boundary: { type: 'bash', command, completedAt: Date.now() },
            }))
            abortController.abort()
            return denySpeculation(
              'Speculation paused: bash boundary',
              'speculation_bash_boundary',
            )
          }
          // 只读 Bash 命令（如 ls/cat/grep）：允许执行
          return {
            behavior: 'allow' as const,
            updatedInput: input,
            decisionReason: {
              type: 'other' as const,
              reason: 'speculation_readonly_bash',
            },
          }
        }

        // 其他工具：默认拒绝（设置 denied_tool boundary + abort）
        logForDebugging(`[Speculation] Stopping at denied tool: ${tool.name}`)
        // 提取工具调用的关键参数作为 detail（最多 200 字符）
        const detail = String(
          ('url' in input && input.url) ||
            ('file_path' in input && input.file_path) ||
            ('path' in input && input.path) ||
            ('command' in input && input.command) ||
            '',
        ).slice(0, 200)
        updateActiveSpeculationState(setAppState, () => ({
          boundary: {
            type: 'denied_tool',
            toolName: tool.name,
            detail,
            completedAt: Date.now(),
          },
        }))
        abortController.abort()
        return denySpeculation(
          `Tool ${tool.name} not allowed during speculation`,
          'speculation_unknown_tool',
        )
      },
      querySource: 'speculation',
      forkLabel: 'speculation',
      maxTurns: MAX_SPECULATION_TURNS,
      overrides: { abortController, requireCanUseTool: true },
      // onMessage 回调：实时追加消息到 messagesRef，超限时中止
      onMessage: msg => {
        if (msg.type === 'assistant' || msg.type === 'user') {
          messagesRef.current.push(msg)
          // 消息数超限：强制中止防止无限循环
          if (messagesRef.current.length >= MAX_SPECULATION_MESSAGES) {
            abortController.abort()
          }
          // 用户消息中有工具结果时：更新 toolUseCount 计数（UI 显示工具执行数）
          if (isUserMessageWithArrayContent(msg)) {
            const newTools = count(
              msg.message.content as { type: string; is_error?: boolean }[],
              b => b.type === 'tool_result' && !b.is_error,
            )
            if (newTools > 0) {
              updateActiveSpeculationState(setAppState, prev => ({
                toolUseCount: prev.toolUseCount + newTools,
              }))
            }
          }
        }
      },
    })

    // forkedAgent 因 abort 中止后直接返回（不设置 complete boundary）
    if (abortController.signal.aborted) return

    // 正常完成：设置 complete boundary（含 output token 数）
    updateActiveSpeculationState(setAppState, () => ({
      boundary: {
        type: 'complete' as const,
        completedAt: Date.now(),
        outputTokens: result.totalUsage.output_tokens,
      },
    }))

    logForDebugging(
      `[Speculation] Complete: ${countToolsInMessages(messagesRef.current)} tools`,
    )

    // 推测完成后流水线生成下一个建议（异步，不阻塞当前流程）
    void generatePipelinedSuggestion(
      contextRef.current,
      suggestionText,
      messagesRef.current,
      setAppState,
      abortController,
    )
  } catch (error) {
    abortController.abort()

    if (error instanceof Error && error.name === 'AbortError') {
      // AbortError 为正常取消（用户输入、主流程中止等）
      safeRemoveOverlay(overlayPath)
      resetSpeculationState(setAppState)
      return
    }

    // 非预期错误：清理资源，记录错误事件
    safeRemoveOverlay(overlayPath)

    // 使用原始 Error 对象（而非 toError 包装），保留原始堆栈信息
    logError(error instanceof Error ? error : new Error('Speculation failed'))

    logSpeculation(
      id,
      'error',
      startTime,
      suggestionText.length,
      messagesRef.current,
      null,
      {
        error_type: error instanceof Error ? error.name : 'Unknown',
        error_message: errorMessage(error).slice(
          0,
          200,
        ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        error_phase:
          'start' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        is_pipelined: isPipelined,
      },
    )

    resetSpeculationState(setAppState)
  }
}

/**
 * 接受推测执行结果
 *
 * 用户接受建议时调用，将推测执行的结果应用到主工作区。
 *
 * 完整流程：
 * 1. 检查 state.status === 'active'（非活跃时返回 null）
 * 2. abort()：中止正在进行的推测（幂等，已完成的推测忽略此操作）
 * 3. cleanMessageCount > 0 时 copyOverlayToMain（有实际消息才需要复制文件）
 * 4. safeRemoveOverlay 清理 overlay 目录
 * 5. 计算 timeSavedMs：min(acceptedAt, boundary.completedAt) - startTime
 *    - 推测已完成：boundary.completedAt 就是完成时间
 *    - 推测仍在进行：acceptedAt 就是"已执行部分"的截止时间
 * 6. 通过 setAppState 重置推测状态 + 累加 speculationSessionTimeSavedMs
 * 7. 记录 'accepted' 事件到分析系统
 * 8. timeSavedMs > 0 时追加 speculation-accept 记录到 transcript
 *
 * @param state 当前推测状态
 * @param setAppState AppState 更新函数
 * @param cleanMessageCount 清洗后消息数量（0 时不复制文件）
 * @returns SpeculationResult（含 messages/boundary/timeSavedMs），或 null（非活跃时）
 */
export async function acceptSpeculation(
  state: SpeculationState,
  setAppState: (f: (prev: AppState) => AppState) => void,
  cleanMessageCount: number,
): Promise<SpeculationResult | null> {
  // 非活跃状态：无法接受
  if (state.status !== 'active') return null

  const {
    id,
    messagesRef,
    writtenPathsRef,
    abort,
    startTime,
    suggestionLength,
    isPipelined,
  } = state
  const messages = messagesRef.current
  const overlayPath = getOverlayPath(id)
  const acceptedAt = Date.now()

  // 中止推测（若仍在进行中则中止，已完成的忽略）
  abort()

  // 有实际消息时将 overlay 写入主工作区（无消息时不需要复制文件）
  if (cleanMessageCount > 0) {
    await copyOverlayToMain(overlayPath, writtenPathsRef.current, getCwdState())
  }
  // 清理 overlay 目录
  safeRemoveOverlay(overlayPath)

  // 使用快照 boundary 作为默认值（state 中保存的引用，可能是最后已知值）
  let boundary: CompletionBoundary | null = state.boundary
  let timeSavedMs =
    Math.min(acceptedAt, boundary?.completedAt ?? Infinity) - startTime

  setAppState(prev => {
    // 若 React 状态中有更新的 boundary（推测在 setAppState 异步处理期间完成）则使用最新值
    if (prev.speculation.status === 'active' && prev.speculation.boundary) {
      boundary = prev.speculation.boundary
      const endTime = Math.min(acceptedAt, boundary.completedAt ?? Infinity)
      timeSavedMs = endTime - startTime
    }
    return {
      ...prev,
      // 重置推测状态为 IDLE
      speculation: IDLE_SPECULATION_STATE,
      // 累加本 session 节省的时间
      speculationSessionTimeSavedMs:
        prev.speculationSessionTimeSavedMs + timeSavedMs,
    }
  })

  logForDebugging(
    boundary === null
      ? `[Speculation] Accept ${id}: still running, using ${messages.length} messages`
      : `[Speculation] Accept ${id}: already complete`,
  )

  // 记录 accepted 事件（含消息数、节省时间、是否为流水线推测）
  logSpeculation(
    id,
    'accepted',
    startTime,
    suggestionLength,
    messages,
    boundary,
    {
      message_count: messages.length,
      time_saved_ms: timeSavedMs,
      is_pipelined: isPipelined,
    },
  )

  // 有节省时间时追加 speculation-accept 记录到 transcript（用于统计分析）
  if (timeSavedMs > 0) {
    const entry: SpeculationAcceptMessage = {
      type: 'speculation-accept',
      timestamp: new Date().toISOString(),
      timeSavedMs,
    }
    void appendFile(getTranscriptPath(), jsonStringify(entry) + '\n', {
      // 设置文件权限（仅所有者可读写）
      mode: 0o600,
    }).catch(() => {
      logForDebugging(
        '[Speculation] Failed to write speculation-accept to transcript',
      )
    })
  }

  return { messages, boundary, timeSavedMs }
}

/**
 * 中止当前推测执行
 *
 * 完整流程：
 * 1. 检查 speculation.status === 'active'（非活跃直接返回原状态）
 * 2. 记录 'aborted' 事件（含 abort_reason='user_typed'）
 * 3. abort()：中止 forkedAgent
 * 4. safeRemoveOverlay：清理 overlay 目录
 * 5. 返回重置后的状态（speculation: IDLE_SPECULATION_STATE）
 *
 * 注意：直接在 setAppState 回调中执行（读取最新状态并立即更新），避免竞态条件。
 */
export function abortSpeculation(setAppState: SetAppState): void {
  setAppState(prev => {
    if (prev.speculation.status !== 'active') return prev

    const {
      id,
      abort,
      startTime,
      boundary,
      suggestionLength,
      messagesRef,
      isPipelined,
    } = prev.speculation

    logForDebugging(`[Speculation] Aborting ${id}`)

    // 记录中止事件（用于分析推测被用户手动中断的比例）
    logSpeculation(
      id,
      'aborted',
      startTime,
      suggestionLength,
      messagesRef.current,
      boundary,
      { abort_reason: 'user_typed', is_pipelined: isPipelined },
    )

    // 中止 forkedAgent
    abort()
    // 清理 overlay 目录
    safeRemoveOverlay(getOverlayPath(id))

    return { ...prev, speculation: IDLE_SPECULATION_STATE }
  })
}

/**
 * 处理推测执行的完整接受流程
 *
 * 当用户接受包含推测的建议时调用（区别于普通建议接受）。
 * 此函数协调 UI 更新、消息注入、文件状态同步和流水线建议提升。
 *
 * 完整流程：
 * 1. 清空 promptSuggestion（logOutcomeAtSubmission 已记录 accept，此处仅清空 UI）
 * 2. 捕获推测消息引用（prepareMessagesForInjection 清洗）
 * 3. 注入用户消息（立即更新 UI，提供即时视觉反馈）
 * 4. acceptSpeculation（复制 overlay 文件、清理、计算耗时）
 * 5. 非 complete 推测：去掉尾部助手消息（API 不支持以助手消息结尾的请求）
 * 6. 创建 ANT-only 反馈消息（如果有节省时间）
 * 7. 注入推测消息（setMessages）
 * 8. 同步文件状态缓存（extractReadFilesFromMessages + mergeFileStateCaches）
 * 9. 注入反馈消息
 * 10. complete 推测且有流水线建议 → 提升为主建议展示 + 触发下次推测
 * 11. 返回 { queryRequired: !isComplete }（complete 时不需要额外查询）
 *
 * 错误处理：fail open（记录错误后降级为 queryRequired: true，允许用户正常继续）
 *
 * @param speculationState 当前活跃的推测状态
 * @param speculationSessionTimeSavedMs 本 session 已累计节省的时间
 * @param setAppState AppState 更新函数
 * @param input 用户接受的建议文本（作为用户消息注入）
 * @param deps 依赖注入（setMessages、readFileState、cwd）
 * @returns { queryRequired: boolean }（是否需要向 API 发送后续查询）
 */
export async function handleSpeculationAccept(
  speculationState: ActiveSpeculationState,
  speculationSessionTimeSavedMs: number,
  setAppState: SetAppState,
  input: string,
  deps: {
    setMessages: (f: (prev: Message[]) => Message[]) => void
    readFileState: { current: FileStateCache }
    cwd: string
  },
): Promise<{ queryRequired: boolean }> {
  try {
    const { setMessages, readFileState, cwd } = deps

    // 清空 promptSuggestion 状态（logOutcomeAtSubmission 已记录接受事件，这里只清空 UI）
    // 注意：调用方使用 skipReset 避免在此之前中止推测
    setAppState(prev => {
      // 幂等检查：已清空则不重复更新
      if (
        prev.promptSuggestion.text === null &&
        prev.promptSuggestion.promptId === null
      ) {
        return prev
      }
      return {
        ...prev,
        promptSuggestion: {
          text: null,
          promptId: null,
          shownAt: 0,
          acceptedAt: 0,
          generationRequestId: null,
        },
      }
    })

    // 捕获推测消息（必须在任何 state 更新之前捕获，确保引用稳定）
    const speculationMessages = speculationState.messagesRef.current
    let cleanMessages = prepareMessagesForInjection(speculationMessages)

    // 立即注入用户消息（提供即时视觉反馈，用户无需等待异步操作完成）
    const userMessage = createUserMessage({ content: input })
    setMessages(prev => [...prev, userMessage])

    // 应用推测结果（复制 overlay 文件到主工作区）
    const result = await acceptSpeculation(
      speculationState,
      setAppState,
      cleanMessages.length,
    )

    const isComplete = result?.boundary?.type === 'complete'

    // 推测未完成时：去掉尾部助手消息
    // 部分模型不支持以助手消息结尾的请求（API 400 错误），
    // 后续查询会重新生成这部分内容
    if (!isComplete) {
      const lastNonAssistant = cleanMessages.findLastIndex(
        m => m.type !== 'assistant',
      )
      cleanMessages = cleanMessages.slice(0, lastNonAssistant + 1)
    }

    // 计算 session 累计节省时间（用于反馈消息）
    const timeSavedMs = result?.timeSavedMs ?? 0
    const newSessionTotal = speculationSessionTimeSavedMs + timeSavedMs
    // 创建 ANT-only 反馈消息（显示工具数、token 数、节省时间）
    const feedbackMessage = createSpeculationFeedbackMessage(
      cleanMessages,
      result?.boundary ?? null,
      timeSavedMs,
      newSessionTotal,
    )

    // 注入推测执行消息（用户可以看到推测执行了哪些操作）
    setMessages(prev => [...prev, ...cleanMessages])

    // 从推测消息中提取已读文件状态，与主文件状态缓存合并（避免重复读取）
    const extracted = extractReadFilesFromMessages(
      cleanMessages,
      cwd,
      READ_FILE_STATE_CACHE_SIZE,
    )
    readFileState.current = mergeFileStateCaches(
      readFileState.current,
      extracted,
    )

    // 注入 ANT-only 反馈消息（非 ANT 用户返回 null，直接跳过）
    if (feedbackMessage) {
      setMessages(prev => [...prev, feedbackMessage])
    }

    logForDebugging(
      `[Speculation] ${result?.boundary?.type ?? 'incomplete'}, injected ${cleanMessages.length} messages`,
    )

    // 推测完成且有流水线建议：提升为主建议展示
    if (isComplete && speculationState.pipelinedSuggestion) {
      const { text, promptId, generationRequestId } =
        speculationState.pipelinedSuggestion
      logForDebugging(
        `[Speculation] Promoting pipelined suggestion: "${text.slice(0, 50)}..."`,
      )
      // 将流水线建议提升为主建议（展示在 UI 中）
      setAppState(prev => ({
        ...prev,
        promptSuggestion: {
          text,
          promptId,
          shownAt: Date.now(),
          acceptedAt: 0,
          generationRequestId,
        },
      }))

      // 基于增强上下文（原始消息 + 用户输入 + 推测消息）触发下次推测
      const augmentedContext: REPLHookContext = {
        ...speculationState.contextRef.current,
        messages: [
          ...speculationState.contextRef.current.messages,
          createUserMessage({ content: input }),
          ...cleanMessages,
        ],
      }
      void startSpeculation(text, augmentedContext, setAppState, true)
    }

    // complete 时不需要额外查询（推测已包含完整响应）
    // 非 complete 时需要后续查询（补充推测未完成的部分）
    return { queryRequired: !isComplete }
  } catch (error) {
    // Fail open：记录错误后降级为 queryRequired: true（允许用户正常继续）
    /* eslint-disable no-restricted-syntax -- custom fallback message, not toError(e) */
    logError(
      error instanceof Error
        ? error
        : new Error('handleSpeculationAccept failed'),
    )
    /* eslint-enable no-restricted-syntax */
    logSpeculation(
      speculationState.id,
      'error',
      speculationState.startTime,
      speculationState.suggestionLength,
      speculationState.messagesRef.current,
      speculationState.boundary,
      {
        error_type: error instanceof Error ? error.name : 'Unknown',
        error_message: errorMessage(error).slice(
          0,
          200,
        ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        error_phase:
          'accept' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        is_pipelined: speculationState.isPipelined,
      },
    )
    // 清理 overlay 目录，重置状态
    safeRemoveOverlay(getOverlayPath(speculationState.id))
    resetSpeculationState(setAppState)
    // 降级：需要后续查询（用户消息会被正常处理）
    return { queryRequired: true }
  }
}
