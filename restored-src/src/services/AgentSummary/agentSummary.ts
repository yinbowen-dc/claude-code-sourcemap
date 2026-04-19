/**
 * 【协调器模式子代理后台摘要模块】services/AgentSummary/agentSummary.ts
 *
 * 在 Claude Code 系统流程中的位置：
 * - 属于多代理协调（coordinator/worker）架构的辅助子系统
 * - 由 AgentTool.tsx 在启动子代理时调用 startAgentSummarization()
 * - 依赖 forkedAgent.ts 的 runForkedAgent() 在不打断主流程的情况下并行发起摘要请求
 * - 摘要结果通过 updateAgentSummary() 写入 AgentProgress，供 UI 展示子代理当前进度
 *
 * 核心功能：
 * - 每隔 30 秒（SUMMARY_INTERVAL_MS）触发一次摘要生成
 * - "Fork"（复刻）子代理对话，让模型用 3-5 个词描述最新操作
 * - 复用父代理的 prompt cache，避免重复计算（通过 CacheSafeParams 共享缓存键）
 * - 工具保留在请求中（维持缓存键一致），但通过 canUseTool 回调拒绝任何工具调用
 *
 * Periodic background summarization for coordinator mode sub-agents.
 *
 * Forks the sub-agent's conversation every ~30s using runForkedAgent()
 * to generate a 1-2 sentence progress summary. The summary is stored
 * on AgentProgress for UI display.
 *
 * Cache sharing: uses the same CacheSafeParams as the parent agent
 * to share the prompt cache. Tools are kept in the request for cache
 * key matching but denied via canUseTool callback.
 */

import type { TaskContext } from '../../Task.js'
import { updateAgentSummary } from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import { filterIncompleteToolCalls } from '../../tools/AgentTool/runAgent.js'
import type { AgentId } from '../../types/ids.js'
import { logForDebugging } from '../../utils/debug.js'
import {
  type CacheSafeParams,
  runForkedAgent,
} from '../../utils/forkedAgent.js'
import { logError } from '../../utils/log.js'
import { createUserMessage } from '../../utils/messages.js'
import { getAgentTranscript } from '../../utils/sessionStorage.js'

// 摘要触发间隔：30 秒
const SUMMARY_INTERVAL_MS = 30_000

/**
 * 构建发给模型的摘要提示词
 *
 * 提示词要求模型：
 * - 使用现在时（-ing）描述最近操作
 * - 必须提及具体文件或函数名，不能使用分支名称
 * - 长度控制在 3-5 个词以内
 * - 若存在上一次摘要，则明确要求本次描述"新"操作
 *
 * @param previousSummary - 上一次生成的摘要文本（用于引导模型避免重复）
 */
function buildSummaryPrompt(previousSummary: string | null): string {
  // 若已有上一次摘要，插入提示行，要求模型描述不同的新操作
  const prevLine = previousSummary
    ? `\nPrevious: "${previousSummary}" — say something NEW.\n`
    : ''

  return `Describe your most recent action in 3-5 words using present tense (-ing). Name the file or function, not the branch. Do not use tools.
${prevLine}
Good: "Reading runAgent.ts"
Good: "Fixing null check in validate.ts"
Good: "Running auth module tests"
Good: "Adding retry logic to fetchUser"

Bad (past tense): "Analyzed the branch diff"
Bad (too vague): "Investigating the issue"
Bad (too long): "Reviewing full branch diff and AgentTool.tsx integration"
Bad (branch name): "Analyzed adam/background-summary branch diff"`
}

/**
 * 启动子代理的后台摘要定时器
 *
 * 工作流程：
 * 1. 从 CacheSafeParams 中剥离 forkContextMessages（每次 tick 重新从 transcript 读取，避免闭包持久引用过期消息）
 * 2. 调用 scheduleNext() 启动第一次定时器
 * 3. 每次定时器触发后：
 *    a. 读取当前代理的 transcript（消息不足 3 条则跳过）
 *    b. 过滤掉不完整的工具调用（防止损坏的消息影响摘要）
 *    c. fork 代理对话，发起摘要请求，拒绝所有工具调用
 *    d. 提取模型输出的文本摘要，写入 AgentProgress
 *    e. 在 finally 块中调度下一次 tick（不在启动时调度，避免并发重叠）
 * 4. 返回 { stop } 句柄供调用者在代理结束时清理定时器和中止中的请求
 *
 * @param taskId - 任务 ID（用于日志和 updateAgentSummary）
 * @param agentId - 代理 ID（用于读取 transcript）
 * @param cacheSafeParams - 父代理的缓存安全参数（系统提示、工具、模型等，用于共享 prompt cache）
 * @param setAppState - React 状态更新函数（用于通知 UI）
 */
export function startAgentSummarization(
  taskId: string,
  agentId: AgentId,
  cacheSafeParams: CacheSafeParams,
  setAppState: TaskContext['setAppState'],
): { stop: () => void } {
  // 从闭包中剥离 forkContextMessages — runSummary 每次 tick 从 getAgentTranscript() 重新构建
  // 若保留原始引用，timer 存活期间原 fork 消息会被持久锁定（即使已过期）
  const { forkContextMessages: _drop, ...baseParams } = cacheSafeParams
  let summaryAbortController: AbortController | null = null // 当前摘要请求的中止控制器
  let timeoutId: ReturnType<typeof setTimeout> | null = null // 当前定时器句柄
  let stopped = false // 是否已停止（外部调用 stop() 后置为 true）
  let previousSummary: string | null = null // 上一次摘要文本（用于提示词去重）

  /**
   * 单次摘要执行函数
   * 每次定时器触发时调用，完成后在 finally 块中调度下一次
   */
  async function runSummary(): Promise<void> {
    if (stopped) return

    logForDebugging(`[AgentSummary] Timer fired for agent ${agentId}`)

    try {
      // 从 sessionStorage 读取代理当前的完整对话记录
      const transcript = await getAgentTranscript(agentId)
      if (!transcript || transcript.messages.length < 3) {
        // 消息不足（代理刚启动）时跳过本次摘要，finally 块会调度下一次
        logForDebugging(
          `[AgentSummary] Skipping summary for ${taskId}: not enough messages (${transcript?.messages.length ?? 0})`,
        )
        return
      }

      // 过滤掉不完整的工具调用（孤立的 tool_use 没有对应的 tool_result）
      const cleanMessages = filterIncompleteToolCalls(transcript.messages)

      // 组装本次 fork 请求的参数（注入当前最新消息）
      const forkParams: CacheSafeParams = {
        ...baseParams,
        forkContextMessages: cleanMessages,
      }

      logForDebugging(
        `[AgentSummary] Forking for summary, ${cleanMessages.length} messages in context`,
      )

      // 为本次摘要请求创建中止控制器，供 stop() 提前终止
      summaryAbortController = new AbortController()

      // 通过 canUseTool 回调拒绝所有工具，而非传入 tools:[]
      // 原因：工具列表是 prompt cache 键的一部分，清空工具会导致缓存失效
      const canUseTool = async () => ({
        behavior: 'deny' as const,
        message: 'No tools needed for summary',
        decisionReason: { type: 'other' as const, reason: 'summary only' },
      })

      // 注意：不设置 maxOutputTokens
      // fork 请求复用主线程的 prompt cache，必须发送完全相同的缓存键参数
      // （system、tools、model、messages 前缀、thinking config 均相同）
      // 若设置 maxOutputTokens 会改变 budget_tokens，导致 thinking config 不匹配，进而使缓存失效
      //
      // ContentReplacementState 由 createSubagentContext 从 forkParams.toolUseContext（
      // 子代理在 onCacheSafeParams 时刻的 LIVE 状态快照）自动克隆，无需额外覆盖
      const result = await runForkedAgent({
        promptMessages: [
          createUserMessage({ content: buildSummaryPrompt(previousSummary) }),
        ],
        cacheSafeParams: forkParams,
        canUseTool,
        querySource: 'agent_summary',   // 标识此查询为摘要请求（用于分析）
        forkLabel: 'agent_summary',
        overrides: { abortController: summaryAbortController },
        skipTranscript: true,           // 不将摘要对话写入代理主 transcript
      })

      if (stopped) return

      // 从 fork 结果中提取第一条非错误 assistant 消息的文本内容
      for (const msg of result.messages) {
        if (msg.type !== 'assistant') continue
        // 跳过 API 错误消息
        if (msg.isApiErrorMessage) {
          logForDebugging(
            `[AgentSummary] Skipping API error message for ${taskId}`,
          )
          continue
        }
        const textBlock = msg.message.content.find(b => b.type === 'text')
        if (textBlock?.type === 'text' && textBlock.text.trim()) {
          const summaryText = textBlock.text.trim()
          logForDebugging(
            `[AgentSummary] Summary result for ${taskId}: ${summaryText}`,
          )
          // 保存本次摘要，供下次 buildSummaryPrompt() 使用
          previousSummary = summaryText
          // 将摘要写入 AgentProgress，触发 UI 更新
          updateAgentSummary(taskId, summaryText, setAppState)
          break
        }
      }
    } catch (e) {
      if (!stopped && e instanceof Error) {
        logError(e)
      }
    } finally {
      summaryAbortController = null
      // 在请求完成（而非启动时）重置定时器，防止并发重叠摘要请求
      if (!stopped) {
        scheduleNext()
      }
    }
  }

  /**
   * 调度下一次摘要触发
   * 使用 setTimeout 而非 setInterval，保证上一次完成后才开始倒计时
   */
  function scheduleNext(): void {
    if (stopped) return
    timeoutId = setTimeout(runSummary, SUMMARY_INTERVAL_MS)
  }

  /**
   * 停止摘要定时器并中止正在进行的摘要请求
   * 由外部（AgentTool.tsx）在代理任务结束时调用
   */
  function stop(): void {
    logForDebugging(`[AgentSummary] Stopping summarization for ${taskId}`)
    stopped = true
    // 清除待触发的定时器
    if (timeoutId) {
      clearTimeout(timeoutId)
      timeoutId = null
    }
    // 中止正在进行的 fork 请求
    if (summaryAbortController) {
      summaryAbortController.abort()
      summaryAbortController = null
    }
  }

  // 启动第一次定时器（等待 30s 后触发首次摘要）
  scheduleNext()

  return { stop }
}
