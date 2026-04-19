/**
 * CCR（Claude Code Remote）会话轮询模块——/ultraplan 专用
 *
 * 在 Claude Code 系统流程中的位置：
 * 本模块是 /ultraplan 特性的核心异步轮询引擎，位于本地 CLI 层与远端 CCR 会话之间。
 * 当用户在本地触发 /ultraplan 后，系统通过 teleportToRemote 创建一个远端 CCR 会话
 * 并进入"计划模式"（plan mode）。本模块持续轮询该会话的事件流，直到：
 *   - 用户在浏览器中批准了 ExitPlanMode 工具调用（approved）
 *   - 用户在浏览器中点击"传送回终端"（teleport，带哨兵标记的拒绝）
 *   - 会话因错误终止（terminated）
 *   - 超过超时时间（timeout）
 *
 * 主要功能：
 * - ExitPlanModeScanner：纯有状态分类器，消费 SDKMessage[] 批次，输出当前判定结果
 * - pollForApprovedExitPlanMode()：带超时和阶段回调的异步轮询主函数
 * - 通过 ULTRAPLAN_TELEPORT_SENTINEL 区分"传送"与普通拒绝
 * - 通过 ## Approved Plan: 标记从批准的 tool_result 中提取计划文本
 */

// CCR 会话轮询用于 /ultraplan，等待已批准的 ExitPlanMode tool_result 后提取计划文本。
// 使用 pollRemoteSessionEvents（与 RemoteAgentTask 共享）进行分页 + 类型化 SDKMessage[]。
// 计划模式通过 teleportToRemote 的 CreateSession events 数组中的
// set_permission_mode control_request 设置。

import type {
  ToolResultBlockParam,
  ToolUseBlock,
} from '@anthropic-ai/sdk/resources'
import type { SDKMessage } from '../../entrypoints/agentSdkTypes.js'
import { EXIT_PLAN_MODE_V2_TOOL_NAME } from '../../tools/ExitPlanModeTool/constants.js'
import { logForDebugging } from '../debug.js'
import { sleep } from '../sleep.js'
import { isTransientNetworkError } from '../teleport/api.js'
import {
  type PollRemoteSessionResponse,
  pollRemoteSessionEvents,
} from '../teleport.js'

// 每次轮询之间的间隔（毫秒）
const POLL_INTERVAL_MS = 3000
// pollRemoteSessionEvents 不自带重试。30 分钟超时约产生 600 次调用；
// 任何非零的 5xx 错误率都可能因单次抖动而终止整个轮询。
const MAX_CONSECUTIVE_FAILURES = 5

/**
 * 轮询失败原因类型。
 * - 'terminated'          : 远端会话因错误而终止
 * - 'timeout_pending'     : 超时时已看到 pending 计划但用户未批准
 * - 'timeout_no_plan'     : 超时时 ExitPlanMode 从未被触发
 * - 'extract_marker_missing': 批准了但 tool_result 中缺少 ## Approved Plan: 标记
 * - 'network_or_unknown'  : 网络错误或未知异常
 * - 'stopped'             : 调用方主动停止轮询
 */
export type PollFailReason =
  | 'terminated'
  | 'timeout_pending'
  | 'timeout_no_plan'
  | 'extract_marker_missing'
  | 'network_or_unknown'
  | 'stopped'

/**
 * 带结构化失败原因的轮询错误类。
 * 除错误消息外还携带 reason（失败原因类型）和 rejectCount（用户拒绝次数）。
 */
export class UltraplanPollError extends Error {
  constructor(
    message: string,
    readonly reason: PollFailReason,
    readonly rejectCount: number,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'UltraplanPollError'
  }
}

/**
 * 浏览器 PlanModal 在用户点击"传送回终端"时向 feedback 中注入的哨兵字符串。
 * 计划文本紧跟在该哨兵的下一行。
 * 扫描器通过是否存在此哨兵来区分"传送"与普通拒绝。
 */
export const ULTRAPLAN_TELEPORT_SENTINEL = '__ULTRAPLAN_TELEPORT_LOCAL__'

/**
 * ExitPlanModeScanner.ingest() 的单次批次扫描结果类型：
 * - 'approved' : ExitPlanMode 已批准，plan 为提取的计划文本
 * - 'teleport' : 用户点击传送，plan 为哨兵后的计划文本
 * - 'rejected' : ExitPlanMode 被拒绝，id 为对应的工具调用 ID
 * - 'pending'  : ExitPlanMode 已发出但尚未有结果（等待浏览器批准）
 * - 'terminated': 会话以非 success 状态结束
 * - 'unchanged': 无新状态变化
 */
export type ScanResult =
  | { kind: 'approved'; plan: string }
  | { kind: 'teleport'; plan: string }
  | { kind: 'rejected'; id: string }
  | { kind: 'pending' }
  | { kind: 'terminated'; subtype: string }
  | { kind: 'unchanged' }

/**
 * Ultraplan 阶段状态，用于 UI 胶囊/详情视图显示。
 * 状态转换：
 *   running → （回合结束，无 ExitPlanMode）→ needs_input
 *   needs_input → （用户在浏览器回复）→ running
 *   running → （ExitPlanMode 已发出，无结果）→ plan_ready
 *   plan_ready → （被拒绝）→ running
 *   plan_ready → （被批准）→ 轮询解决，胶囊移除
 */
export type UltraplanPhase = 'running' | 'needs_input' | 'plan_ready'

/**
 * CCR 事件流的纯有状态分类器。
 * 消费 pollRemoteSessionEvents 传入的 SDKMessage[] 批次，返回当前 ExitPlanMode 判定结果。
 * 无 I/O、无定时器——可用合成或录制的事件进行单元测试和离线回放。
 *
 * 优先级（approved > terminated > rejected > pending > unchanged）：
 * pollRemoteSessionEvents 每次调用最多分页 50 页，因此一次 ingest 可跨越数秒的会话活动。
 * 一个批次可能同时包含"批准的 tool_result"和随后的 {type:'result'}（用户批准后远端崩溃）。
 * 批准的计划已真实存在于 threadstore——不能丢弃。
 */
export class ExitPlanModeScanner {
  // 所有已发现的 ExitPlanMode 工具调用 ID（有序列表，最新的在末尾）
  private exitPlanCalls: string[] = []
  // 工具调用 ID → 对应 tool_result 的映射
  private results = new Map<string, ToolResultBlockParam>()
  // 已被拒绝的工具调用 ID 集合
  private rejectedIds = new Set<string>()
  // 会话终止信息（非 success 的 result 事件）
  private terminated: { subtype: string } | null = null
  // 上一批次是否发生了拒绝（触发下次扫描时重新检查最新目标）
  private rescanAfterRejection = false
  // 是否曾经见到过 pending 状态（用于超时错误信息的差异化）
  everSeenPending = false

  /**
   * 已记录的拒绝次数（用于 UltraplanPollError 上报）。
   */
  get rejectCount(): number {
    return this.rejectedIds.size
  }

  /**
   * 是否存在"已发出但尚未有 tool_result"的 ExitPlanMode 调用。
   * true 表示远端浏览器正在显示批准对话框。
   */
  get hasPendingPlan(): boolean {
    // 找到最新的非已拒绝调用 ID
    const id = this.exitPlanCalls.findLast(c => !this.rejectedIds.has(c))
    // 存在且尚无对应结果 → pending
    return id !== undefined && !this.results.has(id)
  }

  /**
   * 消费新的 SDKMessage[] 批次并更新内部状态，返回当前扫描结果。
   *
   * 流程：
   * 1. 遍历新事件：
   *    - 'assistant' 消息中的 tool_use 块：记录 ExitPlanMode 调用 ID
   *    - 'user' 消息中的 tool_result 块：记录到 results 映射
   *    - 'result'（非 success）：标记会话终止
   * 2. 决定是否需要扫描（有新事件或上次发生了拒绝）
   * 3. 从最新调用向前扫描，找到第一个非已拒绝的调用：
   *    - 无结果 → pending
   *    - is_error + 含哨兵 → teleport
   *    - is_error 无哨兵 → rejected
   *    - 非 error → approved
   * 4. approved/teleport 立即返回（最高优先级）
   * 5. 处理 rejected（加入 rejectedIds，标记下次重新扫描）
   * 6. 按优先级返回：terminated > rejected > pending > unchanged
   *
   * @param newEvents 新的 SDKMessage 批次
   * @returns 当前扫描结果
   */
  ingest(newEvents: SDKMessage[]): ScanResult {
    // 第一步：更新内部状态
    for (const m of newEvents) {
      if (m.type === 'assistant') {
        for (const block of m.message.content) {
          if (block.type !== 'tool_use') continue
          const tu = block as ToolUseBlock
          // 记录 ExitPlanMode 工具调用 ID
          if (tu.name === EXIT_PLAN_MODE_V2_TOOL_NAME) {
            this.exitPlanCalls.push(tu.id)
          }
        }
      } else if (m.type === 'user') {
        const content = m.message.content
        if (!Array.isArray(content)) continue
        for (const block of content) {
          // 记录 tool_result，建立 tool_use_id → result 的映射
          if (block.type === 'tool_result') {
            this.results.set(block.tool_use_id, block)
          }
        }
      } else if (m.type === 'result' && m.subtype !== 'success') {
        // result(success) 在每次 CCR 回合结束后触发。
        // 若远端提了澄清问题（回合结束时无 ExitPlanMode），
        // 必须继续轮询——用户可在浏览器中回复后在后续回合触发 ExitPlanMode。
        // 仅错误子类型（error_during_execution、error_max_turns 等）表示会话真正结束。
        this.terminated = { subtype: m.subtype }
      }
    }

    // 第二步：决定是否需要重新扫描
    // 无新事件且上次无拒绝时跳过扫描（目标未移动）
    const shouldScan = newEvents.length > 0 || this.rescanAfterRejection
    this.rescanAfterRejection = false

    let found:
      | { kind: 'approved'; plan: string }
      | { kind: 'teleport'; plan: string }
      | { kind: 'rejected'; id: string }
      | { kind: 'pending' }
      | null = null

    if (shouldScan) {
      // 从最新调用向前扫描，找到第一个有效目标
      for (let i = this.exitPlanCalls.length - 1; i >= 0; i--) {
        const id = this.exitPlanCalls[i]!
        if (this.rejectedIds.has(id)) continue // 跳过已拒绝的调用
        const tr = this.results.get(id)
        if (!tr) {
          // 有调用但无结果 → 等待浏览器批准
          found = { kind: 'pending' }
        } else if (tr.is_error === true) {
          // is_error：检查是否含传送哨兵
          const teleportPlan = extractTeleportPlan(tr.content)
          found =
            teleportPlan !== null
              ? { kind: 'teleport', plan: teleportPlan }
              : { kind: 'rejected', id }
        } else {
          // 正常批准：提取计划文本
          found = { kind: 'approved', plan: extractApprovedPlan(tr.content) }
        }
        break // 找到第一个有效目标后停止
      }
      // approved/teleport 优先级最高，立即返回
      if (found?.kind === 'approved' || found?.kind === 'teleport') return found
    }

    // 第三步：处理拒绝（须在 terminated 检查之前完成，
    // 以确保 rejectCount 在批次同时含拒绝和终止时仍被更新）
    if (found?.kind === 'rejected') {
      this.rejectedIds.add(found.id)
      this.rescanAfterRejection = true // 下次轮询时重新扫描
    }

    // 按优先级返回结果：terminated > rejected > pending > unchanged
    if (this.terminated) {
      return { kind: 'terminated', subtype: this.terminated.subtype }
    }
    if (found?.kind === 'rejected') {
      return found
    }
    if (found?.kind === 'pending') {
      this.everSeenPending = true // 标记曾见过 pending（用于超时错误信息）
      return found
    }
    return { kind: 'unchanged' }
  }
}

/**
 * pollForApprovedExitPlanMode() 的成功返回类型。
 */
export type PollResult = {
  plan: string
  rejectCount: number
  /**
   * 'local'  = 用户点击传送（在本地执行，归档远端会话）
   * 'remote' = 用户在 CCR 浏览器中批准执行（不归档）
   */
  executionTarget: 'local' | 'remote'
}

/**
 * 异步轮询 CCR 会话，等待 ExitPlanMode 被批准，返回计划文本和执行目标。
 *
 * 'approved' 路径：从 tool_result 的 "## Approved Plan:" 标记后提取计划文本
 * （ExitPlanModeV2Tool 默认分支——模型在 CCR 内将计划写入文件并调用
 * ExitPlanMode({allowedPrompts})，因此 input.plan 不在 threadstore 中）。
 * 'teleport' 路径：从拒绝 tool_result 的 ULTRAPLAN_TELEPORT_SENTINEL 后提取计划文本
 * （浏览器发送拒绝以使远端保持计划模式，计划文本嵌入 feedback 中）。
 * 普通拒绝（is_error === true，无哨兵）被追踪并跳过，允许用户在浏览器中迭代。
 *
 * 流程：
 * 1. 初始化截止时间、扫描器、游标和失败计数器
 * 2. 循环直到截止时间：
 *    a. 检查 shouldStop 回调
 *    b. 调用 pollRemoteSessionEvents() 获取新事件
 *    c. 连续瞬时错误超过阈值时抛出 UltraplanPollError
 *    d. 调用 scanner.ingest() 处理新事件
 *    e. 按结果类型分支：approved/teleport → 返回；terminated → 抛出
 *    f. 计算当前阶段（plan_ready/needs_input/running），有变化时回调 onPhaseChange
 *    g. 等待 POLL_INTERVAL_MS 后继续
 * 3. 超时时根据 everSeenPending 抛出不同原因的 UltraplanPollError
 *
 * @param sessionId    远端 CCR 会话 ID
 * @param timeoutMs    最大等待毫秒数
 * @param onPhaseChange 阶段变化回调（供 UI 更新状态显示）
 * @param shouldStop   外部停止信号（返回 true 时立即终止轮询）
 * @returns 包含计划文本、拒绝次数和执行目标的 PollResult
 */
export async function pollForApprovedExitPlanMode(
  sessionId: string,
  timeoutMs: number,
  onPhaseChange?: (phase: UltraplanPhase) => void,
  shouldStop?: () => boolean,
): Promise<PollResult> {
  const deadline = Date.now() + timeoutMs
  const scanner = new ExitPlanModeScanner()
  let cursor: string | null = null   // 事件分页游标
  let failures = 0                   // 连续失败次数
  let lastPhase: UltraplanPhase = 'running'

  while (Date.now() < deadline) {
    // 外部停止信号检查
    if (shouldStop?.()) {
      throw new UltraplanPollError(
        'poll stopped by caller',
        'stopped',
        scanner.rejectCount,
      )
    }

    let newEvents: SDKMessage[]
    let sessionStatus: PollRemoteSessionResponse['sessionStatus']
    try {
      // 获取新事件（含会话状态）。
      // 元数据获取（session_status）是 needs_input 信号——
      // threadstore 不持久化 result(success) 回合结束事件，
      // 因此 idle 状态是"远端在等待"的唯一权威标记。
      const resp = await pollRemoteSessionEvents(sessionId, cursor)
      newEvents = resp.newEvents
      cursor = resp.lastEventId
      sessionStatus = resp.sessionStatus
      failures = 0 // 成功后重置连续失败计数
    } catch (e) {
      const transient = isTransientNetworkError(e)
      // 非瞬时错误或连续失败次数超限时抛出
      if (!transient || ++failures >= MAX_CONSECUTIVE_FAILURES) {
        throw new UltraplanPollError(
          e instanceof Error ? e.message : String(e),
          'network_or_unknown',
          scanner.rejectCount,
          { cause: e },
        )
      }
      // 瞬时错误：等待后重试
      await sleep(POLL_INTERVAL_MS)
      continue
    }

    let result: ScanResult
    try {
      result = scanner.ingest(newEvents)
    } catch (e) {
      // ingest 抛出时通常是 extractApprovedPlan 找不到标记
      throw new UltraplanPollError(
        e instanceof Error ? e.message : String(e),
        'extract_marker_missing',
        scanner.rejectCount,
      )
    }

    // 处理扫描结果
    if (result.kind === 'approved') {
      // 用户在浏览器中批准，在远端执行
      return {
        plan: result.plan,
        rejectCount: scanner.rejectCount,
        executionTarget: 'remote',
      }
    }
    if (result.kind === 'teleport') {
      // 用户点击传送，在本地执行
      return {
        plan: result.plan,
        rejectCount: scanner.rejectCount,
        executionTarget: 'local',
      }
    }
    if (result.kind === 'terminated') {
      // 会话因错误终止
      throw new UltraplanPollError(
        `remote session ended (${result.subtype}) before plan approval`,
        'terminated',
        scanner.rejectCount,
      )
    }

    // 确定当前 UI 阶段：
    // plan_ready 优先（事件流中有 pending 计划）；
    // 静默 idle 表示远端在等待用户输入（needs_input）；
    // 否则为 running。
    // CCR 在工具调用间短暂变为 'idle'（参见 STABLE_IDLE_POLLS）。
    // 只有在无新事件时才信任 idle——有事件流入说明会话正在工作，不论状态快照如何。
    const quietIdle =
      (sessionStatus === 'idle' || sessionStatus === 'requires_action') &&
      newEvents.length === 0
    const phase: UltraplanPhase = scanner.hasPendingPlan
      ? 'plan_ready'
      : quietIdle
        ? 'needs_input'
        : 'running'

    // 阶段变化时记录日志并触发回调
    if (phase !== lastPhase) {
      logForDebugging(`[ultraplan] phase ${lastPhase} → ${phase}`)
      lastPhase = phase
      onPhaseChange?.(phase)
    }
    await sleep(POLL_INTERVAL_MS)
  }

  // 超时：根据是否曾见过 pending 状态给出不同的错误信息
  throw new UltraplanPollError(
    scanner.everSeenPending
      ? `no approval after ${timeoutMs / 1000}s`
      : `ExitPlanMode never reached after ${timeoutMs / 1000}s (the remote container failed to start, or session ID mismatch?)`,
    scanner.everSeenPending ? 'timeout_pending' : 'timeout_no_plan',
    scanner.rejectCount,
  )
}

/**
 * 将 tool_result 的 content 字段统一转换为字符串。
 * content 可能是字符串或 [{type:'text',text}] 数组（取决于 threadstore 编码）。
 *
 * @param content tool_result 的 content 字段
 * @returns 纯文本字符串
 */
function contentToText(content: ToolResultBlockParam['content']): string {
  return typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map(b => ('text' in b ? b.text : '')).join('')
      : ''
}

/**
 * 从 tool_result content 中提取传送计划文本（ULTRAPLAN_TELEPORT_SENTINEL 之后的内容）。
 * 哨兵不存在时返回 null——调用方将其视为普通用户拒绝（扫描器退化为 rejected）。
 *
 * @param content tool_result 的 content 字段
 * @returns 哨兵后的计划文本，或 null（无哨兵）
 */
function extractTeleportPlan(
  content: ToolResultBlockParam['content'],
): string | null {
  const text = contentToText(content)
  const marker = `${ULTRAPLAN_TELEPORT_SENTINEL}\n`
  const idx = text.indexOf(marker)
  if (idx === -1) return null // 无哨兵，普通拒绝
  return text.slice(idx + marker.length).trimEnd()
}

/**
 * 从批准的 tool_result content 中提取计划文本。
 * ExitPlanModeV2Tool 将计划写入 "## Approved Plan:\n<text>" 或
 * "## Approved Plan (edited by user):\n<text>" 格式。
 * 两种标记均尝试匹配，均未找到时抛出错误（含 content 预览用于调试）。
 *
 * @param content tool_result 的 content 字段
 * @returns 提取的计划文本
 * @throws Error 若未找到 ## Approved Plan: 标记
 */
function extractApprovedPlan(content: ToolResultBlockParam['content']): string {
  const text = contentToText(content)
  // 优先匹配"用户编辑"版本（标记更长，须放在前面）
  const markers = [
    '## Approved Plan (edited by user):\n',
    '## Approved Plan:\n',
  ]
  for (const marker of markers) {
    const idx = text.indexOf(marker)
    if (idx !== -1) {
      return text.slice(idx + marker.length).trimEnd()
    }
  }
  // 未找到标记：可能远端命中了空计划分支或 isAgent 分支
  throw new Error(
    `ExitPlanMode approved but tool_result has no "## Approved Plan:" marker — remote may have hit the empty-plan or isAgent branch. Content preview: ${text.slice(0, 200)}`,
  )
}
