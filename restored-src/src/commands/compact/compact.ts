/**
 * /compact 命令的核心实现模块。
 *
 * 在 Claude Code 的上下文窗口管理流程中，此文件实现了 /compact 命令，
 * 负责将当前对话历史压缩为简洁摘要，释放上下文窗口空间。
 *
 * 压缩策略（优先级从高到低）：
 * 1. Session Memory 压缩（trySessionMemoryCompaction）：最轻量，无自定义指令时优先尝试
 * 2. Reactive-only 模式（reactiveCompact）：通过 REACTIVE_COMPACT 特性标志启用，
 *    使用 reactiveCompactOnPromptTooLong 执行压缩，并发运行 PreCompact 钩子
 * 3. 传统压缩：先通过 microcompactMessages 缩减 token 数量，再调用 compactConversation 生成摘要
 *
 * 压缩后统一执行：清除 userContext 缓存、runPostCompactCleanup、抑制压缩警告提示。
 */
import { feature } from 'bun:bundle'
import chalk from 'chalk'
import { markPostCompaction } from 'src/bootstrap/state.js'
import { getSystemPrompt } from '../../constants/prompts.js'
import { getSystemContext, getUserContext } from '../../context.js'
import { getShortcutDisplay } from '../../keybindings/shortcutFormat.js'
import { notifyCompaction } from '../../services/api/promptCacheBreakDetection.js'
import {
  type CompactionResult,
  compactConversation,
  ERROR_MESSAGE_INCOMPLETE_RESPONSE,
  ERROR_MESSAGE_NOT_ENOUGH_MESSAGES,
  ERROR_MESSAGE_USER_ABORT,
  mergeHookInstructions,
} from '../../services/compact/compact.js'
import { suppressCompactWarning } from '../../services/compact/compactWarningState.js'
import { microcompactMessages } from '../../services/compact/microCompact.js'
import { runPostCompactCleanup } from '../../services/compact/postCompactCleanup.js'
import { trySessionMemoryCompaction } from '../../services/compact/sessionMemoryCompact.js'
import { setLastSummarizedMessageId } from '../../services/SessionMemory/sessionMemoryUtils.js'
import type { ToolUseContext } from '../../Tool.js'
import type { LocalCommandCall } from '../../types/command.js'
import type { Message } from '../../types/message.js'
import { hasExactErrorMessage } from '../../utils/errors.js'
import { executePreCompactHooks } from '../../utils/hooks.js'
import { logError } from '../../utils/log.js'
import { getMessagesAfterCompactBoundary } from '../../utils/messages.js'
import { getUpgradeMessage } from '../../utils/model/contextWindowUpgradeCheck.js'
import {
  buildEffectiveSystemPrompt,
  type SystemPrompt,
} from '../../utils/systemPrompt.js'

/* eslint-disable @typescript-eslint/no-require-imports */
const reactiveCompact = feature('REACTIVE_COMPACT')
  ? (require('../../services/compact/reactiveCompact.js') as typeof import('../../services/compact/reactiveCompact.js'))
  : null
/* eslint-enable @typescript-eslint/no-require-imports */

/**
 * /compact 命令的主入口函数。
 *
 * 按优先级依次尝试三种压缩策略：
 * 1. Session Memory 压缩（无自定义指令时优先）：成本最低，直接复用已有摘要
 * 2. Reactive-only 模式（REACTIVE_COMPACT 特性标志启用时）：通过 reactiveCompact 路由
 * 3. 传统压缩：microcompact 预处理 → compactConversation 生成完整摘要
 *
 * 压缩成功后统一执行清理：清除 userContext 缓存、runPostCompactCleanup、
 * 抑制"上下文剩余量"警告，并返回 type:'compact' 结果供上层 REPL 处理。
 *
 * @param args 用户提供的自定义压缩指令（可为空）
 * @param context 工具调用上下文，含消息列表、abortController、AppState 等
 */
export const call: LocalCommandCall = async (args, context) => {
  const { abortController } = context
  let { messages } = context

  // REPL 为 UI 滚动保留了被裁剪的历史消息，此处只取压缩边界之后的消息，
  // 避免压缩模型对已被用户主动移除的内容进行摘要
  messages = getMessagesAfterCompactBoundary(messages)

  if (messages.length === 0) {
    throw new Error('No messages to compact')
  }

  // 提取用户自定义压缩指令（若有）
  const customInstructions = args.trim()

  try {
    // 策略一：Session Memory 压缩——仅在无自定义指令时尝试
    // （Session Memory 压缩不支持自定义指令）
    if (!customInstructions) {
      const sessionMemoryResult = await trySessionMemoryCompaction(
        messages,
        context.agentId,
      )
      if (sessionMemoryResult) {
        // 清除 getUserContext 缓存，确保下次调用获取最新上下文
        getUserContext.cache.clear?.()
        runPostCompactCleanup()
        // 重置提示缓存读取基线，防止压缩后的缓存命中率下降被误报为缓存中断。
        // compactConversation 内部会做此操作；SM-compact 不会，需手动通知。
        if (feature('PROMPT_CACHE_BREAK_DETECTION')) {
          notifyCompaction(
            context.options.querySource ?? 'compact',
            context.agentId,
          )
        }
        // 标记已完成压缩，供状态机判断
        markPostCompaction()
        // 立即抑制"上下文剩余量不足"的警告提示
        suppressCompactWarning()

        return {
          type: 'compact',
          compactionResult: sessionMemoryResult,
          displayText: buildDisplayText(context),
        }
      }
    }

    // 策略二：Reactive-only 模式——在 Session Memory 之后检查（两者独立正交）。
    // REACTIVE_COMPACT 特性标志启用时，将 /compact 路由到 reactive 路径。
    if (reactiveCompact?.isReactiveOnlyMode()) {
      return await compactViaReactive(
        messages,
        context,
        customInstructions,
        reactiveCompact,
      )
    }

    // 策略三：传统压缩——先用 microcompact 减少 token 数量，再生成完整摘要
    const microcompactResult = await microcompactMessages(messages, context)
    const messagesForCompact = microcompactResult.messages

    const result = await compactConversation(
      messagesForCompact,
      context,
      await getCacheSharingParams(context, messagesForCompact),
      false,
      customInstructions,
      false,
    )

    // 传统压缩会替换全部消息，旧消息 UUID 不再存在，需重置 lastSummarizedMessageId
    setLastSummarizedMessageId(undefined)

    // 压缩成功后抑制"上下文剩余量不足"的警告
    suppressCompactWarning()

    // 清除缓存并执行压缩后清理
    getUserContext.cache.clear?.()
    runPostCompactCleanup()

    return {
      type: 'compact',
      compactionResult: result,
      displayText: buildDisplayText(context, result.userDisplayMessage),
    }
  } catch (error) {
    if (abortController.signal.aborted) {
      // 用户主动取消压缩
      throw new Error('Compaction canceled.')
    } else if (hasExactErrorMessage(error, ERROR_MESSAGE_NOT_ENOUGH_MESSAGES)) {
      // 消息数量不足，无法压缩
      throw new Error(ERROR_MESSAGE_NOT_ENOUGH_MESSAGES)
    } else if (hasExactErrorMessage(error, ERROR_MESSAGE_INCOMPLETE_RESPONSE)) {
      // 压缩模型返回了不完整的响应
      throw new Error(ERROR_MESSAGE_INCOMPLETE_RESPONSE)
    } else {
      logError(error)
      throw new Error(`Error during compaction: ${error}`)
    }
  }
}

/**
 * 通过 Reactive 路径执行压缩（仅在 REACTIVE_COMPACT 模式下调用）。
 *
 * 与传统压缩的核心区别：
 * - 并发执行 PreCompact 钩子 和 getCacheSharingParams（两者互相独立）
 * - 将钩子返回的 newCustomInstructions 与用户自定义指令合并后传入压缩函数
 * - 压缩完成后将钩子的 userDisplayMessage 与压缩结果的 userDisplayMessage 合并展示
 * - 通过 onCompactProgress / setSDKStatus 回调向 UI 报告压缩进度
 *
 * @param messages 待压缩的消息列表（已过滤至压缩边界之后）
 * @param context 工具调用上下文
 * @param customInstructions 用户自定义压缩指令（可为空字符串）
 * @param reactive 已加载的 reactiveCompact 模块引用（非 null）
 */
async function compactViaReactive(
  messages: Message[],
  context: ToolUseContext,
  customInstructions: string,
  reactive: NonNullable<typeof reactiveCompact>,
): Promise<{
  type: 'compact'
  compactionResult: CompactionResult
  displayText: string
}> {
  // 通知 UI：PreCompact 钩子开始执行
  context.onCompactProgress?.({
    type: 'hooks_start',
    hookType: 'pre_compact',
  })
  // 更新 SDK 状态为"压缩中"，使外部调用者可感知当前处于压缩阶段
  context.setSDKStatus?.('compacting')

  try {
    // PreCompact 钩子（启动子进程）与 getCacheSharingParams（遍历所有工具构建系统提示）
    // 互相独立，并发执行以节省等待时间
    const [hookResult, cacheSafeParams] = await Promise.all([
      executePreCompactHooks(
        { trigger: 'manual', customInstructions: customInstructions || null },
        context.abortController.signal,
      ),
      getCacheSharingParams(context, messages),
    ])
    // 将用户指令与钩子返回的补充指令合并，两者均可为空
    const mergedInstructions = mergeHookInstructions(
      customInstructions,
      hookResult.newCustomInstructions,
    )

    // 重置流式输出状态，准备接收压缩模型的响应
    context.setStreamMode?.('requesting')
    context.setResponseLength?.(() => 0)
    // 通知 UI：压缩正式开始
    context.onCompactProgress?.({ type: 'compact_start' })

    // 调用 reactive 压缩核心函数（该函数内部会运行 PostCompact 钩子）
    const outcome = await reactive.reactiveCompactOnPromptTooLong(
      messages,
      cacheSafeParams,
      { customInstructions: mergedInstructions, trigger: 'manual' },
    )

    if (!outcome.ok) {
      // 将 reactive 压缩的失败原因映射到标准错误消息，
      // 由外层 call() 的 catch 统一翻译为用户可见的错误文本
      switch (outcome.reason) {
        case 'too_few_groups':
          throw new Error(ERROR_MESSAGE_NOT_ENOUGH_MESSAGES)
        case 'aborted':
          // abortController.signal.aborted 为 true 时，外层会转换为"Compaction canceled."
          throw new Error(ERROR_MESSAGE_USER_ABORT)
        case 'exhausted':
        case 'error':
        case 'media_unstrippable':
          throw new Error(ERROR_MESSAGE_INCOMPLETE_RESPONSE)
      }
    }

    // 与 tryReactiveCompact 中的成功后清理保持一致，
    // 但跳过 resetMicrocompactState——processSlashCommand 对所有 type:'compact' 结果统一处理
    setLastSummarizedMessageId(undefined)
    runPostCompactCleanup()
    suppressCompactWarning()
    getUserContext.cache.clear?.()

    // 合并 PreCompact 钩子和压缩结果各自的 userDisplayMessage，
    // 过滤掉空值后用换行拼接，若均为空则为 undefined
    const combinedMessage =
      [hookResult.userDisplayMessage, outcome.result.userDisplayMessage]
        .filter(Boolean)
        .join('\n') || undefined

    return {
      type: 'compact',
      compactionResult: {
        ...outcome.result,
        userDisplayMessage: combinedMessage,
      },
      displayText: buildDisplayText(context, combinedMessage),
    }
  } finally {
    // 无论成功或失败，都重置流式输出状态并通知 UI 压缩结束
    context.setStreamMode?.('requesting')
    context.setResponseLength?.(() => 0)
    context.onCompactProgress?.({ type: 'compact_end' })
    context.setSDKStatus?.(null)
  }
}

/**
 * 构建压缩完成后向用户展示的文本。
 *
 * 组合三类可选内容（均以灰色显示）：
 * 1. 展开快捷键提示（非 verbose 模式下显示）
 * 2. 钩子/压缩函数返回的 userDisplayMessage（如有）
 * 3. 上下文窗口升级建议（如模型支持更大窗口）
 *
 * @param context 工具调用上下文，含 options.verbose 标志
 * @param userDisplayMessage 压缩结果携带的可选显示消息
 * @returns 格式化后的灰色提示字符串
 */
function buildDisplayText(
  context: ToolUseContext,
  userDisplayMessage?: string,
): string {
  // 获取上下文窗口升级建议（如当前模型不是最大窗口版本则有内容）
  const upgradeMessage = getUpgradeMessage('tip')
  // 获取"展开完整摘要"的快捷键显示文本
  const expandShortcut = getShortcutDisplay(
    'app:toggleTranscript',
    'Global',
    'ctrl+o',
  )
  // 非 verbose 模式：提示用户可通过快捷键查看完整摘要
  const dimmed = [
    ...(context.options.verbose
      ? []
      : [`(${expandShortcut} to see full summary)`]),
    ...(userDisplayMessage ? [userDisplayMessage] : []),
    ...(upgradeMessage ? [upgradeMessage] : []),
  ]
  return chalk.dim('Compacted ' + dimmed.join('\n'))
}

/**
 * 构建传递给 compactConversation / reactiveCompactOnPromptTooLong 的缓存共享参数。
 *
 * 该函数将系统提示、用户上下文、系统上下文打包到一个对象中，
 * 供压缩函数在构建"压缩后首次请求"时复用相同的提示缓存条目，
 * 避免因系统提示变化导致缓存失效。
 *
 * 并发获取 userContext 和 systemContext 以减少 I/O 等待时间。
 *
 * @param context 工具调用上下文，含工具列表、模型配置、MCP 客户端等
 * @param forkContextMessages 压缩后将作为新对话起点的消息列表
 * @returns 包含 systemPrompt / userContext / systemContext / toolUseContext / forkContextMessages 的参数对象
 */
async function getCacheSharingParams(
  context: ToolUseContext,
  forkContextMessages: Message[],
): Promise<{
  systemPrompt: SystemPrompt
  userContext: { [k: string]: string }
  systemContext: { [k: string]: string }
  toolUseContext: ToolUseContext
  forkContextMessages: Message[]
}> {
  const appState = context.getAppState()
  // 获取默认系统提示（基于当前工具集、模型、工作目录、MCP 客户端）
  const defaultSysPrompt = await getSystemPrompt(
    context.options.tools,
    context.options.mainLoopModel,
    Array.from(
      appState.toolPermissionContext.additionalWorkingDirectories.keys(),
    ),
    context.options.mcpClients,
  )
  // 合并自定义系统提示与默认系统提示，构建最终有效系统提示
  const systemPrompt = buildEffectiveSystemPrompt({
    mainThreadAgentDefinition: undefined,
    toolUseContext: context,
    customSystemPrompt: context.options.customSystemPrompt,
    defaultSystemPrompt: defaultSysPrompt,
    appendSystemPrompt: context.options.appendSystemPrompt,
  })
  // 并发获取用户上下文（~/.claude/context）和系统上下文（平台信息等）
  const [userContext, systemContext] = await Promise.all([
    getUserContext(),
    getSystemContext(),
  ])
  return {
    systemPrompt,
    userContext,
    systemContext,
    toolUseContext: context,
    forkContextMessages,
  }
}
