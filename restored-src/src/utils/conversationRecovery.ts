/**
 * 对话恢复模块。
 *
 * 在 Claude Code 系统中，该模块提供跨会话对话恢复能力，
 * 允许在新会话中继续上一个会话的对话：
 * - 查找并加载最近的会话日志
 * - 重建对话历史消息列表
 * - 支持跨项目目录的会话恢复（crossProjectResume）
 */
import { feature } from 'bun:bundle'
import { relative } from 'path'
import { getCwd } from 'src/utils/cwd.js'
import { addInvokedSkill } from '../bootstrap/state.js'
import { asSessionId } from '../types/ids.js'
import type {
  AttributionSnapshotMessage,
  ContextCollapseCommitEntry,
  ContextCollapseSnapshotEntry,
  LogOption,
  PersistedWorktreeSession,
  SerializedMessage,
} from '../types/logs.js'
import type {
  Message,
  NormalizedMessage,
  NormalizedUserMessage,
} from '../types/message.js'
import { PERMISSION_MODES } from '../types/permissions.js'
import { suppressNextSkillListing } from './attachments.js'
import {
  copyFileHistoryForResume,
  type FileHistorySnapshot,
} from './fileHistory.js'
import { logError } from './log.js'
import {
  createAssistantMessage,
  createUserMessage,
  filterOrphanedThinkingOnlyMessages,
  filterUnresolvedToolUses,
  filterWhitespaceOnlyAssistantMessages,
  isToolUseResultMessage,
  NO_RESPONSE_REQUESTED,
  normalizeMessages,
} from './messages.js'
import { copyPlanForResume } from './plans.js'
import { processSessionStartHooks } from './sessionStart.js'
import {
  buildConversationChain,
  checkResumeConsistency,
  getLastSessionLog,
  getSessionIdFromLog,
  isLiteLog,
  loadFullLog,
  loadMessageLogs,
  loadTranscriptFile,
  removeExtraFields,
} from './sessionStorage.js'
import type { ContentReplacementRecord } from './toolResultStorage.js'

// Dead code elimination: ant-only tool names are conditionally required so
// their strings don't leak into external builds. Static imports always bundle.
/* eslint-disable @typescript-eslint/no-require-imports */
// BriefTool 和 SendUserFileTool 仅在 KAIROS feature gate 开启时存在；
// 使用 require 而非 import 是为了防止字符串泄漏到外部构建产物
const BRIEF_TOOL_NAME: string | null =
  feature('KAIROS') || feature('KAIROS_BRIEF')
    ? (
        require('../tools/BriefTool/prompt.js') as typeof import('../tools/BriefTool/prompt.js')
      ).BRIEF_TOOL_NAME
    : null
const LEGACY_BRIEF_TOOL_NAME: string | null =
  feature('KAIROS') || feature('KAIROS_BRIEF')
    ? (
        require('../tools/BriefTool/prompt.js') as typeof import('../tools/BriefTool/prompt.js')
      ).LEGACY_BRIEF_TOOL_NAME
    : null
const SEND_USER_FILE_TOOL_NAME: string | null = feature('KAIROS')
  ? (
      require('../tools/SendUserFileTool/prompt.js') as typeof import('../tools/SendUserFileTool/prompt.js')
    ).SEND_USER_FILE_TOOL_NAME
  : null
/* eslint-enable @typescript-eslint/no-require-imports */

/**
 * 将消息中的遗留 attachment 类型迁移到当前类型系统，确保向下兼容。
 *
 * 处理两类遗留类型：
 * - `new_file` → `file`（补充 displayPath 为相对路径）
 * - `new_directory` → `directory`（补充 displayPath 为相对路径）
 * 对于其他缺少 displayPath 的旧会话 attachment，回填 displayPath 字段。
 */
function migrateLegacyAttachmentTypes(message: Message): Message {
  if (message.type !== 'attachment') {
    return message
  }

  const attachment = message.attachment as {
    type: string
    [key: string]: unknown
  } // 使用宽泛类型以兼容当前类型系统中不存在的旧类型

  // 迁移遗留 attachment 类型
  if (attachment.type === 'new_file') {
    // new_file → file，并根据当前工作目录计算相对路径作为 displayPath
    return {
      ...message,
      attachment: {
        ...attachment,
        type: 'file',
        displayPath: relative(getCwd(), attachment.filename as string),
      },
    } as SerializedMessage // 已知结构正确，安全强制转换
  }

  if (attachment.type === 'new_directory') {
    // new_directory → directory，同样补充 displayPath
    return {
      ...message,
      attachment: {
        ...attachment,
        type: 'directory',
        displayPath: relative(getCwd(), attachment.path as string),
      },
    } as SerializedMessage // 已知结构正确，安全强制转换
  }

  // 回填旧会话 attachment 缺少的 displayPath 字段
  if (!('displayPath' in attachment)) {
    // 按优先级尝试 filename、path、skillDir 字段
    const path =
      'filename' in attachment
        ? (attachment.filename as string)
        : 'path' in attachment
          ? (attachment.path as string)
          : 'skillDir' in attachment
            ? (attachment.skillDir as string)
            : undefined
    if (path) {
      return {
        ...message,
        attachment: {
          ...attachment,
          displayPath: relative(getCwd(), path),
        },
      } as Message
    }
  }

  return message
}

export type TeleportRemoteResponse = {
  log: Message[]
  branch?: string
}

export type TurnInterruptionState =
  | { kind: 'none' }
  | { kind: 'interrupted_prompt'; message: NormalizedUserMessage }

export type DeserializeResult = {
  messages: Message[]
  turnInterruptionState: TurnInterruptionState
}

/**
 * 将日志文件中的序列化消息反序列化为 REPL 期望的格式。
 * 过滤未匹配的 tool_use、孤立的 thinking 消息，并在最后一条消息为用户消息时
 * 追加一条合成的 assistant 哨兵消息。
 * @internal 仅用于测试导出 - 实际应使用 loadConversationForResume
 */
export function deserializeMessages(serializedMessages: Message[]): Message[] {
  return deserializeMessagesWithInterruptDetection(serializedMessages).messages
}

/**
 * 与 deserializeMessages 相同，但额外检测会话是否在执行中途被中断。
 * SDK 恢复路径在网关触发重启后，会利用此信息自动继续被中断的轮次。
 * @internal 仅用于测试导出
 */
export function deserializeMessagesWithInterruptDetection(
  serializedMessages: Message[],
): DeserializeResult {
  try {
    // 在处理前先迁移遗留 attachment 类型
    const migratedMessages = serializedMessages.map(
      migrateLegacyAttachmentTypes,
    )

    // 清除反序列化用户消息中无效的 permissionMode 值。
    // 该字段来自磁盘上未经校验的 JSON，可能包含其他构建版本中才有效的模式。
    const validModes = new Set<string>(PERMISSION_MODES)
    for (const msg of migratedMessages) {
      if (
        msg.type === 'user' &&
        msg.permissionMode !== undefined &&
        !validModes.has(msg.permissionMode)
      ) {
        msg.permissionMode = undefined
      }
    }

    // 过滤未匹配的 tool_use 及其后续的合成消息
    const filteredToolUses = filterUnresolvedToolUses(
      migratedMessages,
    ) as NormalizedMessage[]

    // 过滤孤立的仅含 thinking 的 assistant 消息，防止恢复时 API 报错。
    // 当流式输出按内容块生成独立消息，且交错的用户消息阻止了按 message.id 合并时会出现此情况。
    const filteredThinking = filterOrphanedThinkingOnlyMessages(
      filteredToolUses,
    ) as NormalizedMessage[]

    // 过滤仅含空白文本内容的 assistant 消息。
    // 当模型在 thinking 前输出 "\n\n" 而用户在流式传输途中取消时会产生此情况。
    const filteredMessages = filterWhitespaceOnlyAssistantMessages(
      filteredThinking,
    ) as NormalizedMessage[]

    const internalState = detectTurnInterruption(filteredMessages)

    // 将中途中断转换为 interrupted_prompt，追加合成的续接消息。
    // 这样消费方只需处理 interrupted_prompt 一种中断类型。
    let turnInterruptionState: TurnInterruptionState
    if (internalState.kind === 'interrupted_turn') {
      const [continuationMessage] = normalizeMessages([
        createUserMessage({
          content: 'Continue from where you left off.',
          isMeta: true,
        }),
      ])
      filteredMessages.push(continuationMessage!)
      turnInterruptionState = {
        kind: 'interrupted_prompt',
        message: continuationMessage!,
      }
    } else {
      turnInterruptionState = internalState
    }

    // 在最后一条用户消息之后插入合成 assistant 哨兵消息，
    // 使对话在未执行任何恢复操作时也符合 API 格式要求。
    // 跳过末尾的 system/progress 消息后插入，以便 removeInterruptedMessage
    // 的 splice(idx, 2) 能删除正确的配对。
    const lastRelevantIdx = filteredMessages.findLastIndex(
      m => m.type !== 'system' && m.type !== 'progress',
    )
    if (
      lastRelevantIdx !== -1 &&
      filteredMessages[lastRelevantIdx]!.type === 'user'
    ) {
      filteredMessages.splice(
        lastRelevantIdx + 1,
        0,
        createAssistantMessage({
          content: NO_RESPONSE_REQUESTED,
        }) as NormalizedMessage,
      )
    }

    return { messages: filteredMessages, turnInterruptionState }
  } catch (error) {
    logError(error as Error)
    throw error
  }
}

/**
 * 内部三值检测结果，在将 interrupted_turn 转换为带合成续接消息的
 * interrupted_prompt 之前使用。
 */
type InternalInterruptionState =
  | TurnInterruptionState
  | { kind: 'interrupted_turn' }

/**
 * 根据过滤后的最后一条消息判断对话是否在执行中途被中断。
 * 在过滤掉未匹配 tool_use 后，assistant 作为最后一条消息意味着轮次已正常完成，
 * 因为流式路径中 stop_reason 在持久化时总为 null。
 *
 * 查找最后一条与轮次相关的消息时，会跳过 system 和 progress 消息
 * ——它们是记账产物，不应遮盖真正的中断。attachment 则保留为轮次的一部分。
 */
function detectTurnInterruption(
  messages: NormalizedMessage[],
): InternalInterruptionState {
  if (messages.length === 0) {
    return { kind: 'none' }
  }

  // 找到最后一条与轮次相关的消息，跳过 system/progress 及合成 API 错误 assistant。
  // 错误 assistant 在 API 发送前已被过滤（normalizeMessagesForAPI），
  // 此处跳过可让自动恢复在重试耗尽后触发，而不是将错误误读为已完成轮次。
  const lastMessageIdx = messages.findLastIndex(
    m =>
      m.type !== 'system' &&
      m.type !== 'progress' &&
      !(m.type === 'assistant' && m.isApiErrorMessage),
  )
  const lastMessage =
    lastMessageIdx !== -1 ? messages[lastMessageIdx] : undefined

  if (!lastMessage) {
    return { kind: 'none' }
  }

  if (lastMessage.type === 'assistant') {
    // 流式路径下 stop_reason 在 content_block_stop 时持久化，
    // message_delta 尚未投递 stop_reason。
    // filterUnresolvedToolUses 已删除未匹配 tool_use 的 assistant，
    // 剩余的 assistant 作为最后一条消息表明轮次大概率已正常完成。
    return { kind: 'none' }
  }

  if (lastMessage.type === 'user') {
    if (lastMessage.isMeta || lastMessage.isCompactSummary) {
      return { kind: 'none' }
    }
    if (isToolUseResultMessage(lastMessage)) {
      // Brief 模式（#20467）删除了末尾的 assistant 文本块，
      // 合法的 brief 模式轮次会以 SendUserMessage 的 tool_result 结束。
      // 若不检查此情况，每个 brief 模式会话都会被误判为中途中断，
      // 并在用户下一个提示前注入幽灵 "Continue from where you left off."。
      // 向前查找对应的 tool_use 原始调用。
      if (isTerminalToolResult(lastMessage, messages, lastMessageIdx)) {
        return { kind: 'none' }
      }
      return { kind: 'interrupted_turn' }
    }
    // 纯文本用户提示——Claude Code 尚未开始响应
    return { kind: 'interrupted_prompt', message: lastMessage }
  }

  if (lastMessage.type === 'attachment') {
    // attachment 属于用户轮次——用户提供了上下文但 assistant 未响应
    return { kind: 'interrupted_turn' }
  }

  return { kind: 'none' }
}

/**
 * 判断此 tool_result 是否属于合法终止轮次的工具输出。
 * SendUserMessage 是典型案例：在 brief 模式下，调用它是轮次的最后动作——
 * 之后不再有 assistant 文本（#20467 删除了它）。以此结尾的 transcript 意味着
 * 轮次已完成，而非被中途杀死。
 *
 * 向前查找此 result 对应的 assistant tool_use，并检查其名称。
 * 匹配的 tool_use 通常紧接在前一条相关消息（filterUnresolvedToolUses 已删除未配对的），
 * 但为防止 system/progress 噪音交错，仍逐条向前遍历。
 */
function isTerminalToolResult(
  result: NormalizedUserMessage,
  messages: NormalizedMessage[],
  resultIdx: number,
): boolean {
  const content = result.message.content
  if (!Array.isArray(content)) return false
  const block = content[0]
  if (block?.type !== 'tool_result') return false
  // 取出 tool_result 对应的 tool_use_id，用于反查发起调用的 assistant 块
  const toolUseId = block.tool_use_id

  for (let i = resultIdx - 1; i >= 0; i--) {
    const msg = messages[i]!
    if (msg.type !== 'assistant') continue
    for (const b of msg.message.content) {
      if (b.type === 'tool_use' && b.id === toolUseId) {
        // 仅当工具名称为合法终止工具时，才将此 tool_result 视为轮次正常结束
        return (
          b.name === BRIEF_TOOL_NAME ||
          b.name === LEGACY_BRIEF_TOOL_NAME ||
          b.name === SEND_USER_FILE_TOOL_NAME
        )
      }
    }
  }
  return false
}

/**
 * 从消息中的 invoked_skills attachment 恢复技能状态。
 * 这确保技能在压缩（compaction）后恢复时得以保留。
 * 若不执行此操作，恢复后再次压缩时技能会丢失，
 * 因为 STATE.invokedSkills 在新进程中为空。
 * @internal 仅用于测试导出 - 实际应使用 loadConversationForResume
 */
export function restoreSkillStateFromMessages(messages: Message[]): void {
  for (const message of messages) {
    if (message.type !== 'attachment') {
      continue
    }
    if (message.attachment.type === 'invoked_skills') {
      for (const skill of message.attachment.skills) {
        if (skill.name && skill.path && skill.content) {
          // 恢复仅针对主会话，因此 agentId 为 null
          addInvokedSkill(skill.name, skill.path, skill.content, null)
        }
      }
    }
    // 前一进程已向模型注入技能可用提示——它出现在模型即将看到的 transcript 中。
    // sentSkillNames 是进程局部状态，若不抑制，每次恢复都会重复播报相同的 ~600 token。
    // 一次性触发锁存；在第一个 attachment 检查时消费。
    if (message.attachment.type === 'skill_listing') {
      suppressNextSkillListing()
    }
  }
}

/**
 * 通过路径链式遍历一个 transcript jsonl 文件。与 loadFullLog 内部执行相同的序列：
 * loadTranscriptFile → 找到最新的非侧链叶节点 → buildConversationChain → removeExtraFields。
 * 不同之处在于起点是任意路径，而非由 sessionId 派生的路径。
 *
 * leafUuids 由 loadTranscriptFile 填充，表示"没有其他消息将其 parentUuid 指向该节点"的 uuid——
 * 即对话链的末端节点。可能有多个（侧链、孤立节点）；最新的非侧链节点是主对话的终点。
 */
export async function loadMessagesFromJsonlPath(path: string): Promise<{
  messages: SerializedMessage[]
  sessionId: UUID | undefined
}> {
  const { messages: byUuid, leafUuids } = await loadTranscriptFile(path)
  let tip: (typeof byUuid extends Map<UUID, infer T> ? T : never) | null = null
  let tipTs = 0
  // 找到时间戳最新的非侧链叶节点作为对话链的起始遍历点
  for (const m of byUuid.values()) {
    if (m.isSidechain || !leafUuids.has(m.uuid)) continue
    const ts = new Date(m.timestamp).getTime()
    if (ts > tipTs) {
      tipTs = ts
      tip = m
    }
  }
  if (!tip) return { messages: [], sessionId: undefined }
  const chain = buildConversationChain(byUuid, tip)
  return {
    messages: removeExtraFields(chain),
    // 使用叶节点的 sessionId——分叉会话从源 transcript 复制 chain[0]，
    // 因此根节点保留源会话的 ID。与 loadFullLog 的 mostRecentLeaf.sessionId 保持一致。
    sessionId: tip.sessionId as UUID | undefined,
  }
}

/**
 * 从多种来源加载对话以供恢复，是加载和反序列化对话的统一入口函数。
 *
 * @param source - 加载来源：
 *   - undefined：加载最近一次会话
 *   - string：按 sessionId 加载指定会话
 *   - LogOption：已加载的对话对象
 * @param sourceJsonlFile - 备选方式：transcript jsonl 文件的路径。
 *   当 --resume 接收到 .jsonl 路径时使用（cli/print.ts 按后缀路由），
 *   通常用于跨目录恢复，此时 transcript 位于当前项目目录之外。
 * @returns 包含反序列化消息和原始日志的对象，未找到时返回 null
 */
export async function loadConversationForResume(
  source: string | LogOption | undefined,
  sourceJsonlFile: string | undefined,
): Promise<{
  messages: Message[]
  turnInterruptionState: TurnInterruptionState
  fileHistorySnapshots?: FileHistorySnapshot[]
  attributionSnapshots?: AttributionSnapshotMessage[]
  contentReplacements?: ContentReplacementRecord[]
  contextCollapseCommits?: ContextCollapseCommitEntry[]
  contextCollapseSnapshot?: ContextCollapseSnapshotEntry
  sessionId: UUID | undefined
  // 恢复时还原 agent 上下文所需的会话元数据
  agentName?: string
  agentColor?: string
  agentSetting?: string
  customTitle?: string
  tag?: string
  mode?: 'coordinator' | 'normal'
  worktreeSession?: PersistedWorktreeSession | null
  prNumber?: number
  prUrl?: string
  prRepository?: string
  // 会话文件的完整路径（跨目录恢复时使用）
  fullPath?: string
} | null> {
  try {
    let log: LogOption | null = null
    let messages: Message[] | null = null
    let sessionId: UUID | undefined

    if (source === undefined) {
      // --continue：加载最近一次会话，跳过正在写入自身 transcript 的 --bg/daemon 会话
      const logsPromise = loadMessageLogs()
      let skip = new Set<string>()
      if (feature('BG_SESSIONS')) {
        try {
          const { listAllLiveSessions } = await import('./udsClient.js')
          const live = await listAllLiveSessions()
          // 收集所有非交互式（后台）活跃会话的 sessionId，恢复时跳过
          skip = new Set(
            live.flatMap(s =>
              s.kind && s.kind !== 'interactive' && s.sessionId
                ? [s.sessionId]
                : [],
            ),
          )
        } catch {
          // UDS 不可用——将所有会话视为可继续
        }
      }
      const logs = await logsPromise
      log =
        logs.find(l => {
          const id = getSessionIdFromLog(l)
          return !id || !skip.has(id)
        }) ?? null
    } else if (sourceJsonlFile) {
      // --resume 传入 .jsonl 路径（cli/print.ts 按后缀路由）。
      // 与下方 sid 分支相同的链式遍历——只是起始路径不同。
      const loaded = await loadMessagesFromJsonlPath(sourceJsonlFile)
      messages = loaded.messages
      sessionId = loaded.sessionId
    } else if (typeof source === 'string') {
      // 按 sessionId 加载指定会话
      log = await getLastSessionLog(source as UUID)
      sessionId = source as UUID
    } else {
      // 已有 LogOption，直接使用
      log = source
    }

    if (!log && !messages) {
      return null
    }

    if (log) {
      // lite 日志不含完整消息，需加载完整日志
      if (isLiteLog(log)) {
        log = await loadFullLog(log)
      }

      // 先确定 sessionId，以便传给复制函数
      if (!sessionId) {
        sessionId = getSessionIdFromLog(log) as UUID
      }
      // 将原始 sessionId 传给 copyPlanForResume，确保 plan slug 关联到正在恢复的会话，
      // 而非恢复前的临时 sessionId
      if (sessionId) {
        await copyPlanForResume(log, asSessionId(sessionId))
      }

      // 为恢复复制文件历史快照（fire-and-forget，不阻塞主流程）
      void copyFileHistoryForResume(log)

      messages = log.messages
      checkResumeConsistency(messages)
    }

    // 在反序列化前先从 invoked_skills attachment 恢复技能状态，
    // 确保技能在多轮压缩后恢复时仍能保留。
    restoreSkillStateFromMessages(messages!)

    // 反序列化消息：处理未匹配 tool_use 并确保格式正确
    const deserialized = deserializeMessagesWithInterruptDetection(messages!)
    messages = deserialized.messages

    // 处理会话开始钩子（resume 类型）
    const hookMessages = await processSessionStartHooks('resume', { sessionId })

    // 将钩子消息追加到对话末尾
    messages.push(...hookMessages)

    return {
      messages,
      turnInterruptionState: deserialized.turnInterruptionState,
      fileHistorySnapshots: log?.fileHistorySnapshots,
      attributionSnapshots: log?.attributionSnapshots,
      contentReplacements: log?.contentReplacements,
      contextCollapseCommits: log?.contextCollapseCommits,
      contextCollapseSnapshot: log?.contextCollapseSnapshot,
      sessionId,
      // 恢复时包含会话元数据，用于还原 agent 上下文
      agentName: log?.agentName,
      agentColor: log?.agentColor,
      agentSetting: log?.agentSetting,
      customTitle: log?.customTitle,
      tag: log?.tag,
      mode: log?.mode,
      worktreeSession: log?.worktreeSession,
      prNumber: log?.prNumber,
      prUrl: log?.prUrl,
      prRepository: log?.prRepository,
      // 跨目录恢复时包含完整路径
      fullPath: log?.fullPath,
    }
  } catch (error) {
    logError(error as Error)
    throw error
  }
}
