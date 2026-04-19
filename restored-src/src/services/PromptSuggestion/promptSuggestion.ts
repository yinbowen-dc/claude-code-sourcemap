/**
 * 提示词建议生成模块（Prompt Suggestion）
 *
 * 在 Claude Code 系统流程中的位置：
 * 本文件是 PromptSuggestion 子系统的核心业务逻辑层，负责预测用户下一步可能输入的内容并展示为建议。
 * 它位于以下层次结构中：
 *   - 调用方：REPL 主循环（postSamplingHooks 在每次助手响应后触发 executePromptSuggestion）
 *   - 本模块：启用判断 → 抑制判断 → 生成 → 过滤 → 写入 AppState + 触发推测执行
 *   - 下层：forkedAgent（fork 一个子 Agent 生成建议）、speculation.ts（推测执行）
 *
 * 主要功能：
 * - shouldEnablePromptSuggestion：五级优先级判断（env → GrowthBook → 非交互 → swarm teammate → 用户设置）
 * - getSuggestionSuppressReason：运行时抑制检查（disabled/pending_permission/elicitation_active/plan_mode/rate_limit）
 * - tryGenerateSuggestion：完整的生成流水线（aborted → early → error → cache_cold → suppress → generate → filter）
 * - generateSuggestion：通过 runForkedAgent fork 子 Agent，使用 canUseTool 回调拒绝工具（不修改 tools 参数以保护缓存命中率）
 * - shouldFilterSuggestion：15+ 过滤规则（meta_text/error_message/too_few_words/evaluative/claude_voice 等）
 * - executePromptSuggestion：REPL 主路径入口，生成成功后写入 AppState 并触发 startSpeculation
 * - logSuggestionOutcome / logSuggestionSuppressed：统一的建议结果分析事件上报
 *
 * 设计说明：
 * - canUseTool 回调拒绝工具而非传 tools:[]：传空数组会破坏缓存命中（cache key 包含 tools 参数），
 *   导致命中率从 92.7% 跌至 61%（PR #18143 实验数据）
 * - MAX_PARENT_UNCACHED_TOKENS = 10_000：父请求未缓存 token 过多时（cache_cold），跳过生成以节省成本
 * - ALLOWED_SINGLE_WORDS：允许特定高频单词建议（yes/ok/push/commit/no 等），其他单词一律过滤
 * - promptId 目前固定为 'user_intent'（stated_intent 为备用变体，当前未启用）
 */

import { getIsNonInteractiveSession } from '../../bootstrap/state.js'
import type { AppState } from '../../state/AppState.js'
import type { Message } from '../../types/message.js'
import { isAgentSwarmsEnabled } from '../../utils/agentSwarmsEnabled.js'
import { count } from '../../utils/array.js'
import { isEnvDefinedFalsy, isEnvTruthy } from '../../utils/envUtils.js'
import { toError } from '../../utils/errors.js'
import {
  type CacheSafeParams,
  createCacheSafeParams,
  runForkedAgent,
} from '../../utils/forkedAgent.js'
import type { REPLHookContext } from '../../utils/hooks/postSamplingHooks.js'
import { logError } from '../../utils/log.js'
import {
  createUserMessage,
  getLastAssistantMessage,
} from '../../utils/messages.js'
import { getInitialSettings } from '../../utils/settings/settings.js'
import { isTeammate } from '../../utils/teammate.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../analytics/growthbook.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../analytics/index.js'
import { currentLimits } from '../claudeAiLimits.js'
import { isSpeculationEnabled, startSpeculation } from './speculation.js'

// 当前正在进行的建议生成 AbortController（abort 用于取消正在进行的 fork 请求）
let currentAbortController: AbortController | null = null

// 提示词变体类型：user_intent（预测用户意图）vs stated_intent（预测用户明确陈述的意图）
export type PromptVariant = 'user_intent' | 'stated_intent'

/**
 * 获取当前使用的提示词变体
 *
 * 目前固定返回 'user_intent'（stated_intent 保留为备用变体，未来可通过 A/B 测试切换）。
 */
export function getPromptVariant(): PromptVariant {
  return 'user_intent'
}

/**
 * 判断是否启用提示词建议功能
 *
 * 按以下优先级依次检查（任一条件匹配即返回）：
 * 1. 环境变量 CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION：falsy → false，truthy → true（测试用覆盖）
 * 2. GrowthBook 特性标志 tengu_chomp_inflection：false → 禁用（默认关闭，对外受控推出）
 * 3. 非交互式会话（print 模式、piped 输入、SDK）：禁用（无需展示 UI 建议）
 * 4. Swarm teammate（仅 leader 应展示建议，避免多个子 Agent 重复生成）：禁用
 * 5. 用户设置 promptSuggestionEnabled（默认 true，可在 Config 面板关闭）
 *
 * 每次决策均记录 tengu_prompt_suggestion_init 分析事件（含 enabled + source）。
 */
export function shouldEnablePromptSuggestion(): boolean {
  // 环境变量覆盖一切（用于测试）
  const envOverride = process.env.CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION
  if (isEnvDefinedFalsy(envOverride)) {
    logEvent('tengu_prompt_suggestion_init', {
      enabled: false,
      source:
        'env' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    return false
  }
  if (isEnvTruthy(envOverride)) {
    logEvent('tengu_prompt_suggestion_init', {
      enabled: true,
      source:
        'env' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    return true
  }

  // GrowthBook 特性标志控制（与 Config.tsx 中的设置 toggle 可见性保持同步）
  if (!getFeatureValue_CACHED_MAY_BE_STALE('tengu_chomp_inflection', false)) {
    logEvent('tengu_prompt_suggestion_init', {
      enabled: false,
      source:
        'growthbook' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    return false
  }

  // 非交互式模式禁用（print 模式、piped 输入、SDK 场景不需要 UI 建议）
  if (getIsNonInteractiveSession()) {
    logEvent('tengu_prompt_suggestion_init', {
      enabled: false,
      source:
        'non_interactive' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    return false
  }

  // Swarm teammate 禁用（仅 leader Agent 展示建议，避免子 Agent 重复生成）
  if (isAgentSwarmsEnabled() && isTeammate()) {
    logEvent('tengu_prompt_suggestion_init', {
      enabled: false,
      source:
        'swarm_teammate' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    return false
  }

  // 用户设置（promptSuggestionEnabled 默认为 true，未设置时视为启用）
  const enabled = getInitialSettings()?.promptSuggestionEnabled !== false
  logEvent('tengu_prompt_suggestion_init', {
    enabled,
    source:
      'setting' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  })
  return enabled
}

/**
 * 中止当前正在进行的提示词建议生成
 *
 * 通过 AbortController 取消正在进行的 fork 请求，防止建议出现在新的用户输入之后。
 * 通常在用户开始输入时调用。
 */
export function abortPromptSuggestion(): void {
  if (currentAbortController) {
    currentAbortController.abort()
    currentAbortController = null
  }
}

/**
 * 获取建议抑制原因（运行时检查）
 *
 * 在每次建议生成前检查当前 AppState，返回抑制原因字符串或 null（允许生成）。
 * 主路径（tryGenerateSuggestion）和流水线路径（generatePipelinedSuggestion）均使用此函数。
 *
 * 抑制原因优先级：
 * 1. 'disabled'：promptSuggestionEnabled 为 false（用户在设置中关闭）
 * 2. 'pending_permission'：有待处理的工具权限请求或沙箱请求（UI 处于确认对话框）
 * 3. 'elicitation_active'：有正在进行的信息 elicitation 队列（UI 处于问答流程）
 * 4. 'plan_mode'：工具权限处于 plan 模式（只规划不执行）
 * 5. 'rate_limit'：外部用户（USER_TYPE=external）且当前限速状态非 allowed
 *
 * @param appState 当前应用状态快照
 * @returns 抑制原因字符串，或 null（允许生成）
 */
export function getSuggestionSuppressReason(appState: AppState): string | null {
  // 功能已被用户禁用
  if (!appState.promptSuggestionEnabled) return 'disabled'
  // 有待处理的工具权限请求（UI 正在等待用户确认）
  if (appState.pendingWorkerRequest || appState.pendingSandboxRequest)
    return 'pending_permission'
  // 有正在进行的 elicitation 队列（UI 处于问答流程）
  if (appState.elicitation.queue.length > 0) return 'elicitation_active'
  // plan 模式：不执行工具，不适合生成操作建议
  if (appState.toolPermissionContext.mode === 'plan') return 'plan_mode'
  // 外部用户且处于速率限制状态（内部用户无此限制）
  if (
    process.env.USER_TYPE === 'external' &&
    currentLimits.status !== 'allowed'
  )
    return 'rate_limit'
  return null
}

/**
 * 共享的建议守卫 + 生成逻辑（CLI TUI 和 SDK push 两条路径均使用）
 *
 * 完整流程：
 * 1. aborted 检查：abortController 已中止 → 返回 null
 * 2. 早期对话检查：助手轮次 < 2（对话刚开始，上下文不足）→ 返回 null
 * 3. API 错误检查：最后一条助手消息为 API 错误 → 返回 null
 * 4. 缓存冷检查：父请求未缓存 token > MAX_PARENT_UNCACHED_TOKENS → 返回 null（cache_cold）
 * 5. 运行时抑制检查：getSuggestionSuppressReason → 非 null → 返回 null
 * 6. 调用 generateSuggestion 生成建议文本
 * 7. 再次 aborted 检查（生成可能花费时间）
 * 8. 空建议检查
 * 9. shouldFilterSuggestion 过滤检查
 * 10. 返回 { suggestion, promptId, generationRequestId }
 *
 * @param abortController 中止控制器（用于取消进行中的请求）
 * @param messages 当前对话消息列表
 * @param getAppState AppState getter（每次重新获取最新状态）
 * @param cacheSafeParams 缓存安全参数（与父请求保持一致以提高缓存命中率）
 * @param source 调用来源（'cli' 或 'sdk'，用于分析事件）
 */
export async function tryGenerateSuggestion(
  abortController: AbortController,
  messages: Message[],
  getAppState: () => AppState,
  cacheSafeParams: CacheSafeParams,
  source?: 'cli' | 'sdk',
): Promise<{
  suggestion: string
  promptId: PromptVariant
  generationRequestId: string | null
} | null> {
  // 已中止（通常是用户开始输入，建议已无意义）
  if (abortController.signal.aborted) {
    logSuggestionSuppressed('aborted', undefined, undefined, source)
    return null
  }

  // 助手轮次不足（对话刚开始，上下文不足以预测用户意图）
  const assistantTurnCount = count(messages, m => m.type === 'assistant')
  if (assistantTurnCount < 2) {
    logSuggestionSuppressed('early_conversation', undefined, undefined, source)
    return null
  }

  // 最后一条助手消息为 API 错误（错误状态下不适合展示建议）
  const lastAssistantMessage = getLastAssistantMessage(messages)
  if (lastAssistantMessage?.isApiErrorMessage) {
    logSuggestionSuppressed('last_response_error', undefined, undefined, source)
    return null
  }
  // 缓存冷检查：父请求未缓存 token 过多时跳过（避免高成本、低价值的 fork）
  const cacheReason = getParentCacheSuppressReason(lastAssistantMessage)
  if (cacheReason) {
    logSuggestionSuppressed(cacheReason, undefined, undefined, source)
    return null
  }

  // 运行时抑制检查（disabled/pending_permission/elicitation_active/plan_mode/rate_limit）
  const appState = getAppState()
  const suppressReason = getSuggestionSuppressReason(appState)
  if (suppressReason) {
    logSuggestionSuppressed(suppressReason, undefined, undefined, source)
    return null
  }

  // 获取提示词变体并生成建议
  const promptId = getPromptVariant()
  const { suggestion, generationRequestId } = await generateSuggestion(
    abortController,
    promptId,
    cacheSafeParams,
  )
  // 生成完成后再次检查中止状态（生成可能花费数秒）
  if (abortController.signal.aborted) {
    logSuggestionSuppressed('aborted', undefined, undefined, source)
    return null
  }
  // 模型返回空建议（"stay silent" 场景）
  if (!suggestion) {
    logSuggestionSuppressed('empty', undefined, promptId, source)
    return null
  }
  // 过滤不合适的建议（评价性/Claude口吻/过长/多句等）
  if (shouldFilterSuggestion(suggestion, promptId, source)) return null

  return { suggestion, promptId, generationRequestId }
}

/**
 * REPL 主路径入口：执行提示词建议流程
 *
 * 完整流程：
 * 1. 过滤非主线程请求（querySource !== 'repl_main_thread' 的请求不生成建议）
 * 2. 创建新的 AbortController 并保存到 currentAbortController（旧的被替换）
 * 3. 调用 tryGenerateSuggestion 执行完整生成流水线
 * 4. 生成成功：将建议写入 AppState（promptSuggestion 字段）
 * 5. 推测执行已启用且有建议：异步触发 startSpeculation（不阻塞当前流程）
 * 6. AbortError：静默处理（用户已开始输入，正常情况）
 * 7. 其他错误：logError 记录
 * 8. finally：清空 currentAbortController（避免悬空引用）
 *
 * @param context REPL Hook 上下文（含消息、AppState 等）
 */
export async function executePromptSuggestion(
  context: REPLHookContext,
): Promise<void> {
  // 仅在主线程请求时运行（非 fork/speculation 路径）
  if (context.querySource !== 'repl_main_thread') return

  // 创建新的中止控制器（旧的会在 abortPromptSuggestion 中被取消）
  currentAbortController = new AbortController()
  const abortController = currentAbortController
  // 提取缓存安全参数（与父请求保持一致，保护缓存命中率）
  const cacheSafeParams = createCacheSafeParams(context)

  try {
    const result = await tryGenerateSuggestion(
      abortController,
      context.messages,
      context.toolUseContext.getAppState,
      cacheSafeParams,
      'cli',
    )
    if (!result) return

    // 将建议写入 AppState（UI 在下次渲染时展示）
    context.toolUseContext.setAppState(prev => ({
      ...prev,
      promptSuggestion: {
        text: result.suggestion,
        promptId: result.promptId,
        shownAt: 0,
        acceptedAt: 0,
        generationRequestId: result.generationRequestId,
      },
    }))

    // 推测执行已启用：异步启动，不等待结果（避免阻塞 UI 响应）
    if (isSpeculationEnabled() && result.suggestion) {
      void startSpeculation(
        result.suggestion,
        context,
        context.toolUseContext.setAppState,
        false,
        cacheSafeParams,
      )
    }
  } catch (error) {
    // AbortError 为正常取消（用户开始输入），静默处理
    if (
      error instanceof Error &&
      (error.name === 'AbortError' || error.name === 'APIUserAbortError')
    ) {
      logSuggestionSuppressed('aborted', undefined, undefined, 'cli')
      return
    }
    logError(toError(error))
  } finally {
    // 清空全局引用（避免旧 controller 影响下次调用）
    if (currentAbortController === abortController) {
      currentAbortController = null
    }
  }
}

// 父请求未缓存 token 上限：超过此值时跳过生成（cache_cold 抑制）
// fork 会重新处理父请求的输出（未缓存）+ 自身 prompt，未缓存 token 过多意味着 fork 代价过高
const MAX_PARENT_UNCACHED_TOKENS = 10_000

/**
 * 获取基于父缓存状态的抑制原因
 *
 * 计算父请求的有效未缓存 token 数（input + cache_write + output），
 * 若超过 MAX_PARENT_UNCACHED_TOKENS，返回 'cache_cold'（抑制生成以节省成本）。
 * 原理：fork 子 Agent 会重新处理父请求的输出（从未缓存），
 * 当父请求 token 量很大且全未缓存时，fork 代价过高，不值得生成建议。
 *
 * @param lastAssistantMessage 最后一条助手消息（含 usage 字段）
 * @returns 'cache_cold' 或 null
 */
export function getParentCacheSuppressReason(
  lastAssistantMessage: ReturnType<typeof getLastAssistantMessage>,
): string | null {
  if (!lastAssistantMessage) return null

  const usage = lastAssistantMessage.message.usage
  const inputTokens = usage.input_tokens ?? 0
  const cacheWriteTokens = usage.cache_creation_input_tokens ?? 0
  // fork 会重新处理父请求的输出（从不缓存）以及自身 prompt
  const outputTokens = usage.output_tokens ?? 0

  // 三者之和超过阈值时认为缓存冷（cache_cold），跳过生成
  return inputTokens + cacheWriteTokens + outputTokens >
    MAX_PARENT_UNCACHED_TOKENS
    ? 'cache_cold'
    : null
}

// 建议生成提示词：指导模型预测用户下一步输入（而非建议用户应该做什么）
const SUGGESTION_PROMPT = `[SUGGESTION MODE: Suggest what the user might naturally type next into Claude Code.]

FIRST: Look at the user's recent messages and original request.

Your job is to predict what THEY would type - not what you think they should do.

THE TEST: Would they think "I was just about to type that"?

EXAMPLES:
User asked "fix the bug and run tests", bug is fixed → "run the tests"
After code written → "try it out"
Claude offers options → suggest the one the user would likely pick, based on conversation
Claude asks to continue → "yes" or "go ahead"
Task complete, obvious follow-up → "commit this" or "push it"
After error or misunderstanding → silence (let them assess/correct)

Be specific: "run the tests" beats "continue".

NEVER SUGGEST:
- Evaluative ("looks good", "thanks")
- Questions ("what about...?")
- Claude-voice ("Let me...", "I'll...", "Here's...")
- New ideas they didn't ask about
- Multiple sentences

Stay silent if the next step isn't obvious from what the user said.

Format: 2-12 words, match the user's style. Or nothing.

Reply with ONLY the suggestion, no quotes or explanation.`

// 提示词变体映射（当前两个变体使用同一提示词，未来可差异化）
const SUGGESTION_PROMPTS: Record<PromptVariant, string> = {
  user_intent: SUGGESTION_PROMPT,
  stated_intent: SUGGESTION_PROMPT,
}

/**
 * 通过 fork 子 Agent 生成建议文本
 *
 * 完整流程：
 * 1. 获取对应变体的提示词
 * 2. 创建 canUseTool 回调（始终返回 deny）—— 用回调而非 tools:[] 是为了保护缓存命中率
 * 3. 通过 runForkedAgent 发送 fork 请求，仅覆盖安全参数（abortController/skipTranscript/skipCacheWrite）
 * 4. 从返回消息中提取第一个非空文本块（模型可能循环尝试工具后才输出文本）
 * 5. 同时提取 requestId（用于 RL 数据集关联）
 *
 * 关键设计：
 * - 不覆盖 tools/thinking/model/effortValue/maxOutputTokens：这些参数是缓存 key 的一部分，
 *   任何差异都会导致缓存未命中（PR #18143 实验：effort:low 导致 45x 缓存写入激增）
 * - skipTranscript=true：建议请求不写入对话记录（避免干扰对话历史）
 * - skipCacheWrite=true：控制 cache_control 标记，不在建议请求上创建新的缓存点
 *
 * @param abortController 中止控制器
 * @param promptId 提示词变体 ID
 * @param cacheSafeParams 与父请求完全相同的缓存安全参数
 */
export async function generateSuggestion(
  abortController: AbortController,
  promptId: PromptVariant,
  cacheSafeParams: CacheSafeParams,
): Promise<{ suggestion: string | null; generationRequestId: string | null }> {
  const prompt = SUGGESTION_PROMPTS[promptId]

  // 通过回调拒绝工具，而非传 tools:[]（传空数组会破坏缓存，命中率从 92.7% 跌至 61%）
  const canUseTool = async () => ({
    behavior: 'deny' as const,
    message: 'No tools needed for suggestion',
    decisionReason: { type: 'other' as const, reason: 'suggestion only' },
  })

  // 不覆盖任何会影响缓存 key 的 API 参数（仅覆盖客户端侧的安全参数）
  // 缓存 key 包含 system/tools/model/messages/thinking 等，empirically 还包括 effortValue/maxOutputTokens
  // PR #18143 尝试 effort:'low' 导致 45x 缓存写入激增（命中率从 92.7% 跌至 61%）
  const result = await runForkedAgent({
    promptMessages: [createUserMessage({ content: prompt })],
    cacheSafeParams, // 不覆盖 tools/thinking 设置，避免破坏缓存
    canUseTool,
    querySource: 'prompt_suggestion',
    forkLabel: 'prompt_suggestion',
    overrides: {
      abortController,
    },
    skipTranscript: true,
    skipCacheWrite: true,
  })

  // 检查所有消息（模型可能循环尝试工具 → 拒绝 → 在下条消息中输出文本）
  // 同时从第一条助手消息提取 requestId（用于 RL 数据集关联）
  const firstAssistantMsg = result.messages.find(m => m.type === 'assistant')
  const generationRequestId =
    firstAssistantMsg?.type === 'assistant'
      ? (firstAssistantMsg.requestId ?? null)
      : null

  // 遍历所有消息，返回第一个非空文本块
  for (const msg of result.messages) {
    if (msg.type !== 'assistant') continue
    const textBlock = msg.message.content.find(b => b.type === 'text')
    if (textBlock?.type === 'text') {
      const suggestion = textBlock.text.trim()
      if (suggestion) {
        return { suggestion, generationRequestId }
      }
    }
  }

  return { suggestion: null, generationRequestId }
}

/**
 * 过滤不合适的建议（15+ 过滤规则）
 *
 * 按顺序检查以下过滤规则，任一匹配则记录抑制事件并返回 true（应过滤）：
 * - done：建议文本为 "done"（完成状态，不是用户输入）
 * - meta_text：模型输出元信息（"nothing found"/"stay silent"/bare "silence"）
 * - meta_wrapped：模型将元推理包在括号中（(silence — ...)、[no suggestion]）
 * - error_message：API/网络错误信息误入建议
 * - prefixed_label：带标签前缀（如 "Suggestion: ..."）
 * - too_few_words：单词数 < 2，但允许斜杠命令和 ALLOWED_SINGLE_WORDS 集合中的词
 * - too_many_words：单词数 > 12（超出提示词限制）
 * - too_long：字符数 >= 100（过长建议）
 * - multiple_sentences：包含多个句子（". A" 模式）
 * - has_formatting：包含换行符或 Markdown 格式
 * - evaluative：评价性词汇（thanks/looks good/perfect 等）
 * - claude_voice：以 Claude 口吻开头（"Let me..."/"I'll..."/"Here's..." 等）
 *
 * ALLOWED_SINGLE_WORDS：允许通过 too_few_words 过滤的高频单词：
 * 肯定词（yes/yeah/ok 等）、动作词（push/commit/deploy/stop/continue 等）、否定词（no）
 *
 * @param suggestion 待过滤的建议文本
 * @param promptId 提示词变体 ID（用于分析事件）
 * @param source 调用来源（用于分析事件）
 * @returns true 表示应过滤（不展示），false 表示可以展示
 */
export function shouldFilterSuggestion(
  suggestion: string | null,
  promptId: PromptVariant,
  source?: 'cli' | 'sdk',
): boolean {
  // null 建议直接过滤
  if (!suggestion) {
    logSuggestionSuppressed('empty', undefined, promptId, source)
    return true
  }

  const lower = suggestion.toLowerCase()
  const wordCount = suggestion.trim().split(/\s+/).length

  // 过滤规则列表：[原因标识, 检查函数]
  const filters: Array<[string, () => boolean]> = [
    // 纯 "done" 文本（完成标志，非用户输入）
    ['done', () => lower === 'done'],
    [
      'meta_text',
      () =>
        lower === 'nothing found' ||
        lower === 'nothing found.' ||
        lower.startsWith('nothing to suggest') ||
        lower.startsWith('no suggestion') ||
        // 模型将 "stay silent" 指令直接输出
        /\bsilence is\b|\bstay(s|ing)? silent\b/.test(lower) ||
        // 模型输出被标点包裹的 "silence"（如 "silence." 或 "[silence]"）
        /^\W*silence\W*$/.test(lower),
    ],
    [
      'meta_wrapped',
      // 模型将元推理包在括号中：(silence — ...)、[no suggestion]
      () => /^\(.*\)$|^\[.*\]$/.test(suggestion),
    ],
    [
      'error_message',
      // API 或网络错误信息误入建议文本
      () =>
        lower.startsWith('api error:') ||
        lower.startsWith('prompt is too long') ||
        lower.startsWith('request timed out') ||
        lower.startsWith('invalid api key') ||
        lower.startsWith('image was too large'),
    ],
    // 带标签前缀的建议（如 "Suggestion: run tests"）
    ['prefixed_label', () => /^\w+:\s/.test(suggestion)],
    [
      'too_few_words',
      () => {
        // 单词数 >= 2 直接通过
        if (wordCount >= 2) return false
        // 斜杠命令是合法的用户输入（如 /help、/reset）
        if (suggestion.startsWith('/')) return false
        // 允许特定高频单词通过（常见的单字用户输入）
        const ALLOWED_SINGLE_WORDS = new Set([
          // 肯定词
          'yes',
          'yeah',
          'yep',
          'yea',
          'yup',
          'sure',
          'ok',
          'okay',
          // 动作词
          'push',
          'commit',
          'deploy',
          'stop',
          'continue',
          'check',
          'exit',
          'quit',
          // 否定词
          'no',
        ])
        return !ALLOWED_SINGLE_WORDS.has(lower)
      },
    ],
    // 超出提示词 12 词限制
    ['too_many_words', () => wordCount > 12],
    // 字符数 >= 100（过长）
    ['too_long', () => suggestion.length >= 100],
    // 多句建议（". A" 模式：句号后大写字母）
    ['multiple_sentences', () => /[.!?]\s+[A-Z]/.test(suggestion)],
    // 包含 Markdown 格式（换行符、星号、粗体）
    ['has_formatting', () => /[\n*]|\*\*/.test(suggestion)],
    [
      'evaluative',
      // 评价性词汇（用户不会用这些词作为输入）
      () =>
        /thanks|thank you|looks good|sounds good|that works|that worked|that's all|nice|great|perfect|makes sense|awesome|excellent/.test(
          lower,
        ),
    ],
    [
      'claude_voice',
      // 以 Claude 口吻开头（用户不会用这种方式表达）
      () =>
        /^(let me|i'll|i've|i'm|i can|i would|i think|i notice|here's|here is|here are|that's|this is|this will|you can|you should|you could|sure,|of course|certainly)/i.test(
          suggestion,
        ),
    ],
  ]

  // 依次检查每个过滤规则
  for (const [reason, check] of filters) {
    if (check()) {
      logSuggestionSuppressed(reason, suggestion, promptId, source)
      return true
    }
  }

  return false
}

/**
 * 记录建议结果（接受或忽略）
 *
 * 在 SDK push 路径中，当下一条用户消息到达时调用此函数来追踪建议的最终命运。
 * 计算相似度（用户输入长度与建议长度之比）、是否完全接受、决策耗时。
 *
 * ANT 用户额外记录原始建议文本和用户输入（用于 RL 数据集），
 * 外部用户仅记录匿名统计信息（相似度、耗时等）。
 *
 * @param suggestion 展示给用户的建议文本
 * @param userInput 用户实际输入的文本
 * @param emittedAt 建议展示时的时间戳（毫秒）
 * @param promptId 提示词变体 ID
 * @param generationRequestId 生成请求 ID（用于 RL 数据集关联）
 */
export function logSuggestionOutcome(
  suggestion: string,
  userInput: string,
  emittedAt: number,
  promptId: PromptVariant,
  generationRequestId: string | null,
): void {
  // 相似度：用户输入长度 / 建议长度（1.0 = 完全一致，<1.0 = 用户输入更短）
  const similarity =
    Math.round((userInput.length / (suggestion.length || 1)) * 100) / 100
  // 完全接受：用户输入与建议文本完全一致
  const wasAccepted = userInput === suggestion
  // 决策耗时（展示建议到用户提交的时间差）
  const timeMs = Math.max(0, Date.now() - emittedAt)

  logEvent('tengu_prompt_suggestion', {
    source: 'sdk' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    outcome: (wasAccepted
      ? 'accepted'
      : 'ignored') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    prompt_id:
      promptId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    ...(generationRequestId && {
      generationRequestId:
        generationRequestId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    }),
    // 接受时记录接受耗时
    ...(wasAccepted && {
      timeToAcceptMs: timeMs,
    }),
    // 忽略时记录忽略耗时
    ...(!wasAccepted && { timeToIgnoreMs: timeMs }),
    similarity,
    // ANT 用户额外记录原始文本（用于 RL 数据集），外部用户不记录（隐私保护）
    ...(process.env.USER_TYPE === 'ant' && {
      suggestion:
        suggestion as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      userInput:
        userInput as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    }),
  })
}

/**
 * 记录建议被抑制的事件
 *
 * 在建议生成被跳过或过滤时调用，记录 tengu_prompt_suggestion 事件（outcome='suppressed'）。
 * ANT 用户额外记录建议原文（用于分析哪些建议被过滤，优化过滤规则）。
 *
 * @param reason 抑制原因（aborted/early_conversation/cache_cold/disabled 等）
 * @param suggestion 可选的建议文本（仅在过滤阶段才有，ANT 用户时记录）
 * @param promptId 提示词变体 ID（缺省时使用 getPromptVariant() 获取）
 * @param source 调用来源（'cli' 或 'sdk'）
 */
export function logSuggestionSuppressed(
  reason: string,
  suggestion?: string,
  promptId?: PromptVariant,
  source?: 'cli' | 'sdk',
): void {
  // promptId 缺省时使用当前默认变体
  const resolvedPromptId = promptId ?? getPromptVariant()
  logEvent('tengu_prompt_suggestion', {
    // source 为可选参数（某些内部调用路径无来源）
    ...(source && {
      source:
        source as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    }),
    outcome:
      'suppressed' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    reason:
      reason as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    prompt_id:
      resolvedPromptId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    // ANT 用户且有建议文本时额外记录（用于过滤规则分析）
    ...(process.env.USER_TYPE === 'ant' &&
      suggestion && {
        suggestion:
          suggestion as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      }),
  })
}
