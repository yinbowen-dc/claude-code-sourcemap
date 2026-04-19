/**
 * /branch 命令的核心实现模块（会话分支/Fork 逻辑）。
 *
 * 在 Claude Code 的会话管理流程中，此文件负责将当前对话的完整记录"分叉"为一个
 * 独立的新会话副本（fork），使用户可以在不丢失原始对话的前提下探索不同方向。
 *
 * 核心流程：
 * 1. 读取当前会话的 JSONL 转录文件
 * 2. 为分叉会话生成新的 UUID，并将所有消息复制到新文件中（保留原始元数据）
 * 3. 将 content-replacement 记录一并复制，避免 token 预算计算错误
 * 4. 为分叉会话自动生成或使用用户指定的标题（带 "(Branch)" 后缀，冲突时追加编号）
 * 5. 通过 context.resume 将当前 REPL 无缝切换到分叉会话
 */
import { randomUUID, type UUID } from 'crypto'
import { mkdir, readFile, writeFile } from 'fs/promises'
import { getOriginalCwd, getSessionId } from '../../bootstrap/state.js'
import type { LocalJSXCommandContext } from '../../commands.js'
import { logEvent } from '../../services/analytics/index.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import type {
  ContentReplacementEntry,
  Entry,
  LogOption,
  SerializedMessage,
  TranscriptMessage,
} from '../../types/logs.js'
import { parseJSONL } from '../../utils/json.js'
import {
  getProjectDir,
  getTranscriptPath,
  getTranscriptPathForSession,
  isTranscriptMessage,
  saveCustomTitle,
  searchSessionsByCustomTitle,
} from '../../utils/sessionStorage.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { escapeRegExp } from '../../utils/stringUtils.js'

/**
 * 扩展的 TranscriptEntry 类型，在转录消息基础上增加 forkedFrom 来源溯源字段，
 * 便于后续通过 "来自哪个原始会话的哪条消息" 追踪分叉历史。
 */
type TranscriptEntry = TranscriptMessage & {
  forkedFrom?: {
    sessionId: string
    messageUuid: UUID
  }
}

/**
 * Derive a single-line title base from the first user message.
 * Collapses whitespace — multiline first messages (pasted stacks, code)
 * otherwise flow into the saved title and break the resume hint.
 *
 * 从会话的第一条用户消息中提取单行标题基底，用于在未指定标题时自动命名分叉。
 * 多行消息（如粘贴的代码/堆栈）会被折叠为单行，防止破坏 /resume 提示显示。
 *
 * @param firstUserMessage 序列化消息列表中第一条 type='user' 的消息
 * @returns 截断至 100 字符的单行字符串，若无法提取则返回 'Branched conversation'
 */
export function deriveFirstPrompt(
  firstUserMessage: Extract<SerializedMessage, { type: 'user' }> | undefined,
): string {
  const content = firstUserMessage?.message?.content
  if (!content) return 'Branched conversation'
  // 支持 string 类型内容与 ContentBlock 数组两种格式
  const raw =
    typeof content === 'string'
      ? content
      : content.find(
          (block): block is { type: 'text'; text: string } =>
            block.type === 'text',
        )?.text
  if (!raw) return 'Branched conversation'
  // 将连续空白符压缩为单个空格，并截断至 100 字符
  return (
    raw.replace(/\s+/g, ' ').trim().slice(0, 100) || 'Branched conversation'
  )
}

/**
 * Creates a fork of the current conversation by copying from the transcript file.
 * Preserves all original metadata (timestamps, gitBranch, etc.) while updating
 * sessionId and adding forkedFrom traceability.
 *
 * 创建当前会话的分叉：读取现有 JSONL 转录文件，为分叉会话分配新的 UUID，
 * 重写 sessionId 与 parentUuid 链，并附加 content-replacement 记录以保障
 * token 预算计算的正确性。最终将分叉内容写入独立的转录文件。
 *
 * @param customTitle 用户自定义的分叉标题（可选）
 * @returns 包含新会话 ID、文件路径及消息列表的结构化结果
 */
async function createFork(customTitle?: string): Promise<{
  sessionId: UUID
  title: string | undefined
  forkPath: string
  serializedMessages: SerializedMessage[]
  contentReplacementRecords: ContentReplacementEntry['replacements']
}> {
  // 为分叉会话生成全局唯一 ID
  const forkSessionId = randomUUID() as UUID
  const originalSessionId = getSessionId()
  const projectDir = getProjectDir(getOriginalCwd())
  // 根据分叉 ID 计算存储路径
  const forkSessionPath = getTranscriptPathForSession(forkSessionId)
  const currentTranscriptPath = getTranscriptPath()

  // Ensure project directory exists
  // 确保项目目录存在，权限设为 700（仅当前用户可读写执行）
  await mkdir(projectDir, { recursive: true, mode: 0o700 })

  // Read current transcript file
  let transcriptContent: Buffer
  try {
    transcriptContent = await readFile(currentTranscriptPath)
  } catch {
    throw new Error('No conversation to branch')
  }

  // 空文件也视为无内容，无法分叉
  if (transcriptContent.length === 0) {
    throw new Error('No conversation to branch')
  }

  // Parse all transcript entries (messages + metadata entries like content-replacement)
  // 将 JSONL 文件解析为 Entry 数组，包含消息和元数据两种类型
  const entries = parseJSONL<Entry>(transcriptContent)

  // Filter to only main conversation messages (exclude sidechains and non-message entries)
  // 只保留主对话线中的消息，排除旁路（sidechain）和非消息类型条目
  const mainConversationEntries = entries.filter(
    (entry): entry is TranscriptMessage =>
      isTranscriptMessage(entry) && !entry.isSidechain,
  )

  // Content-replacement entries for the original session. These record which
  // tool_result blocks were replaced with previews by the per-message budget.
  // Without them in the fork JSONL, `claude -r {forkId}` reconstructs state
  // with an empty replacements Map → previously-replaced results are classified
  // as FROZEN and sent as full content (prompt cache miss + permanent overage).
  // sessionId must be rewritten since loadTranscriptFile keys lookup by the
  // session's messages' sessionId.
  // 提取原始会话的 content-replacement 记录，以避免在分叉会话中重复发送完整 tool_result 内容
  const contentReplacementRecords = entries
    .filter(
      (entry): entry is ContentReplacementEntry =>
        entry.type === 'content-replacement' &&
        entry.sessionId === originalSessionId,
    )
    .flatMap(entry => entry.replacements)

  if (mainConversationEntries.length === 0) {
    throw new Error('No messages to branch')
  }

  // Build forked entries with new sessionId and preserved metadata
  // 逐条重建分叉消息：更新 sessionId、重写 parentUuid 链，并记录来源追踪信息
  let parentUuid: UUID | null = null
  const lines: string[] = []
  const serializedMessages: SerializedMessage[] = []

  for (const entry of mainConversationEntries) {
    // Create forked transcript entry preserving all original metadata
    const forkedEntry: TranscriptEntry = {
      ...entry,
      // 替换为分叉会话的新 ID
      sessionId: forkSessionId,
      // 重建父子消息链（progress 类型消息不计入链路）
      parentUuid,
      isSidechain: false,
      forkedFrom: {
        sessionId: originalSessionId,
        messageUuid: entry.uuid,
      },
    }

    // Build serialized message for LogOption
    const serialized: SerializedMessage = {
      ...entry,
      sessionId: forkSessionId,
    }

    serializedMessages.push(serialized)
    lines.push(jsonStringify(forkedEntry))
    // progress 类型的条目不更新 parentUuid，确保链路正确性
    if (entry.type !== 'progress') {
      parentUuid = entry.uuid
    }
  }

  // Append content-replacement entry (if any) with the fork's sessionId.
  // Written as a SINGLE entry (same shape as insertContentReplacement) so
  // loadTranscriptFile's content-replacement branch picks it up.
  // 将所有 content-replacement 合并为单条记录写入分叉文件
  if (contentReplacementRecords.length > 0) {
    const forkedReplacementEntry: ContentReplacementEntry = {
      type: 'content-replacement',
      sessionId: forkSessionId,
      replacements: contentReplacementRecords,
    }
    lines.push(jsonStringify(forkedReplacementEntry))
  }

  // Write the fork session file
  // 将所有行写入分叉转录文件，文件权限 600（仅当前用户可读写）
  await writeFile(forkSessionPath, lines.join('\n') + '\n', {
    encoding: 'utf8',
    mode: 0o600,
  })

  return {
    sessionId: forkSessionId,
    title: customTitle,
    forkPath: forkSessionPath,
    serializedMessages,
    contentReplacementRecords,
  }
}

/**
 * Generates a unique fork name by checking for collisions with existing session names.
 * If "baseName (Branch)" already exists, tries "baseName (Branch 2)", "baseName (Branch 3)", etc.
 *
 * 为分叉会话生成不与现有会话标题冲突的唯一名称。
 * 首选 "baseName (Branch)"，若冲突则追加最小可用数字编号。
 *
 * @param baseName 原始会话标题或用户自定义标题
 * @returns 唯一的分叉会话名称字符串
 */
async function getUniqueForkName(baseName: string): Promise<string> {
  const candidateName = `${baseName} (Branch)`

  // Check if this exact name already exists
  // 精确匹配查询，避免误匹配前缀相同的其他会话
  const existingWithExactName = await searchSessionsByCustomTitle(
    candidateName,
    { exact: true },
  )

  if (existingWithExactName.length === 0) {
    // 无冲突，直接使用首选名称
    return candidateName
  }

  // Name collision - find a unique numbered suffix
  // Search for all sessions that start with the base pattern
  // 存在冲突，模糊查询所有同前缀的分叉会话以提取已用编号
  const existingForks = await searchSessionsByCustomTitle(`${baseName} (Branch`)

  // Extract existing fork numbers to find the next available
  // 将无编号的 "(Branch)" 视为编号 1，已用编号存入 Set
  const usedNumbers = new Set<number>([1]) // Consider " (Branch)" as number 1
  const forkNumberPattern = new RegExp(
    `^${escapeRegExp(baseName)} \\(Branch(?: (\\d+))?\\)$`,
  )

  for (const session of existingForks) {
    const match = session.customTitle?.match(forkNumberPattern)
    if (match) {
      if (match[1]) {
        // 提取并记录已使用的数字编号
        usedNumbers.add(parseInt(match[1], 10))
      } else {
        usedNumbers.add(1) // " (Branch)" without number is treated as 1
      }
    }
  }

  // Find the next available number
  // 从 2 开始线性扫描，找到第一个未被占用的编号
  let nextNumber = 2
  while (usedNumbers.has(nextNumber)) {
    nextNumber++
  }

  return `${baseName} (Branch ${nextNumber})`
}

/**
 * /branch 命令的主入口函数（供 LocalJSX 命令框架调用）。
 *
 * 完整的分叉流程：
 * 1. 调用 createFork 创建会话副本文件
 * 2. 生成唯一分叉标题（基于首条用户消息或自定义标题 + "(Branch)" 后缀）
 * 3. 持久化标题并上报分叉事件至分析系统
 * 4. 通过 context.resume 将 REPL 无缝切换至分叉会话
 * 5. 向用户展示切换成功消息及如何恢复原始会话的提示
 *
 * @param onDone 命令完成时的回调，用于向 UI 注入系统消息
 * @param context 命令执行上下文，含 resume 等会话切换能力
 * @param args 用户传入的自定义分叉标题（可选）
 */
export async function call(
  onDone: LocalJSXCommandOnDone,
  context: LocalJSXCommandContext,
  args: string,
): Promise<React.ReactNode> {
  // 解析用户传入的自定义标题，空字符串视为未指定
  const customTitle = args?.trim() || undefined

  const originalSessionId = getSessionId()

  try {
    const {
      sessionId,
      title,
      forkPath,
      serializedMessages,
      contentReplacementRecords,
    } = await createFork(customTitle)

    // Build LogOption for resume
    const now = new Date()
    // 从分叉消息中提取第一条用户消息作为标题来源
    const firstPrompt = deriveFirstPrompt(
      serializedMessages.find(m => m.type === 'user'),
    )

    // Save custom title - use provided title or firstPrompt as default
    // This ensures /status and /resume show the same session name
    // Always add " (Branch)" suffix to make it clear this is a branched session
    // Handle collisions by adding a number suffix (e.g., " (Branch 2)", " (Branch 3)")
    // 确保标题唯一性，并持久化到会话存储
    const baseName = title ?? firstPrompt
    const effectiveTitle = await getUniqueForkName(baseName)
    await saveCustomTitle(sessionId, effectiveTitle, forkPath)

    // 上报分叉事件，记录消息数量和是否使用了自定义标题
    logEvent('tengu_conversation_forked', {
      message_count: serializedMessages.length,
      has_custom_title: !!title,
    })

    // 构建 LogOption 对象，供 resume 函数加载分叉会话
    const forkLog: LogOption = {
      date: now.toISOString().split('T')[0]!,
      messages: serializedMessages,
      fullPath: forkPath,
      value: now.getTime(),
      created: now,
      modified: now,
      firstPrompt,
      messageCount: serializedMessages.length,
      isSidechain: false,
      sessionId,
      customTitle: effectiveTitle,
      contentReplacements: contentReplacementRecords,
    }

    // Resume into the fork
    // 构建提示消息：标题信息 + 如何回到原始会话的命令
    const titleInfo = title ? ` "${title}"` : ''
    const resumeHint = `\nTo resume the original: claude -r ${originalSessionId}`
    const successMessage = `Branched conversation${titleInfo}. You are now in the branch.${resumeHint}`

    if (context.resume) {
      // 通过 resume 无缝切换到分叉会话（'fork' 类型触发相应的 UI 动画）
      await context.resume(sessionId, forkLog, 'fork')
      onDone(successMessage, { display: 'system' })
    } else {
      // resume 不可用时的降级处理：提示用户手动 resume
      onDone(
        `Branched conversation${titleInfo}. Resume with: /resume ${sessionId}`,
      )
    }

    return null
  } catch (error) {
    // 统一错误处理：提取错误消息并通过 onDone 展示给用户
    const message =
      error instanceof Error ? error.message : 'Unknown error occurred'
    onDone(`Failed to branch conversation: ${message}`)
    return null
  }
}
