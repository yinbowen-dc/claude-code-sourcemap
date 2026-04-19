// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
/**
 * 后台记忆整合（AutoDream）核心模块
 *
 * 在 Claude Code 系统流程中的位置：
 *   每次对话轮次结束后（stopHooks）→ executeAutoDream() 被调用
 *   → 按顺序通过多道门控检查：功能开关 → 时间门 → 扫描节流 → 会话数量门 → 互斥锁
 *   → 所有检查通过后，启动 forkedAgent 作为子代理执行 /dream 整合流程
 *   → 整合完成后更新锁文件时间戳，并将"已改进记忆"系统消息追加到主会话上下文
 *
 * 主要功能：
 *  - initAutoDream  — 初始化 runner 闭包（每次测试的 beforeEach 可重置闭包状态）
 *  - executeAutoDream — 每轮对话后调用的入口，委托给 runner 闭包执行
 *  - makeDreamProgressWatcher — 监听子代理消息，收集修改的文件路径并更新任务状态
 *
 * 门控顺序（从最廉价到最昂贵）：
 *  1. isGateOpen()：KAIROS 模式 / 远程模式 / 自动记忆 / 功能开关
 *  2. 时间门：距上次整合 >= minHours（默认 24 小时）
 *  3. 扫描节流：上次扫描距今 >= SESSION_SCAN_INTERVAL_MS（10 分钟），避免时间门持续触发扫描
 *  4. 会话数量门：距上次整合后修改的会话数 >= minSessions（默认 5 个）
 *  5. 互斥锁：确保同一时刻只有一个进程执行整合
 *
 * 设计特点：
 *  - 闭包隔离：runner 状态（lastSessionScanAt）封装在 initAutoDream() 闭包内，支持测试隔离
 *  - 强制模式（isForced）：绕过开关/时间/会话门但保留锁检查（不堆叠并发 dream）
 *  - 失败回滚：fork 失败时调用 rollbackConsolidationLock 回退时间戳，让时间门重新开放
 *  - 扫描节流作为软退避：时间门已通过但会话数不足时，节流防止每轮都做昂贵的文件扫描
 */

import type { REPLHookContext } from '../../utils/hooks/postSamplingHooks.js'
import {
  createCacheSafeParams,
  runForkedAgent,
} from '../../utils/forkedAgent.js'
import {
  createUserMessage,
  createMemorySavedMessage,
} from '../../utils/messages.js'
import type { Message } from '../../types/message.js'
import { logForDebugging } from '../../utils/debug.js'
import type { ToolUseContext } from '../../Tool.js'
import { logEvent } from '../analytics/index.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../analytics/growthbook.js'
import { isAutoMemoryEnabled, getAutoMemPath } from '../../memdir/paths.js'
import { isAutoDreamEnabled } from './config.js'
import { getProjectDir } from '../../utils/sessionStorage.js'
import {
  getOriginalCwd,
  getKairosActive,
  getIsRemoteMode,
  getSessionId,
} from '../../bootstrap/state.js'
import { createAutoMemCanUseTool } from '../extractMemories/extractMemories.js'
import { buildConsolidationPrompt } from './consolidationPrompt.js'
import {
  readLastConsolidatedAt,
  listSessionsTouchedSince,
  tryAcquireConsolidationLock,
  rollbackConsolidationLock,
} from './consolidationLock.js'
import {
  registerDreamTask,
  addDreamTurn,
  completeDreamTask,
  failDreamTask,
  isDreamTask,
} from '../../tasks/DreamTask/DreamTask.js'
import { FILE_EDIT_TOOL_NAME } from '../../tools/FileEditTool/constants.js'
import { FILE_WRITE_TOOL_NAME } from '../../tools/FileWriteTool/prompt.js'

// 扫描节流间隔：时间门已通过但会话数不足时，限制文件扫描频率
// 防止时间门每轮都触发，锁文件时间戳未推进时会持续满足时间条件
const SESSION_SCAN_INTERVAL_MS = 10 * 60 * 1000 // 10 分钟

type AutoDreamConfig = {
  minHours: number    // 两次整合之间的最小间隔小时数
  minSessions: number // 触发整合所需的最少会话变更数
}

// 默认调度参数（未配置 GrowthBook flag 时的回退值）
const DEFAULTS: AutoDreamConfig = {
  minHours: 24,
  minSessions: 5,
}

/**
 * 从 GrowthBook feature flag（tengu_onyx_plover）读取调度参数。
 *
 * 注意：功能启用门控由 config.ts 中的 isAutoDreamEnabled() 负责；
 * 本函数只返回调度阈值（minHours、minSessions）。
 * 对每个字段做防御性类型检查，防止 GrowthBook 缓存返回过期的错误类型值。
 */
function getConfig(): AutoDreamConfig {
  const raw =
    getFeatureValue_CACHED_MAY_BE_STALE<Partial<AutoDreamConfig> | null>(
      'tengu_onyx_plover',
      null,
    )
  return {
    // 逐字段验证：必须是正的有限数字，否则回退到默认值
    minHours:
      typeof raw?.minHours === 'number' &&
      Number.isFinite(raw.minHours) &&
      raw.minHours > 0
        ? raw.minHours
        : DEFAULTS.minHours,
    minSessions:
      typeof raw?.minSessions === 'number' &&
      Number.isFinite(raw.minSessions) &&
      raw.minSessions > 0
        ? raw.minSessions
        : DEFAULTS.minSessions,
  }
}

/**
 * 功能总开关：依次检查运行环境是否允许执行 AutoDream。
 *
 * 以下任一条件满足则关闭门：
 *  - KAIROS 模式（使用磁盘技能 dream，不走本模块）
 *  - 远程模式（无本地文件系统访问）
 *  - 自动记忆功能未启用
 *  - isAutoDreamEnabled() 返回 false（用户设置或 GrowthBook flag 关闭）
 */
function isGateOpen(): boolean {
  if (getKairosActive()) return false // KAIROS 模式使用磁盘技能 dream
  if (getIsRemoteMode()) return false  // 远程模式无本地文件系统
  if (!isAutoMemoryEnabled()) return false // 自动记忆未启用
  return isAutoDreamEnabled()
}

// 构建专用测试覆盖点：绕过开关/时间/会话门，但不绕过锁（防止并发堆叠）
// 和记忆目录前置条件。仍然扫描会话以填充提示词中的会话提示。
function isForced(): boolean {
  return false
}

type AppendSystemMessageFn = NonNullable<ToolUseContext['appendSystemMessage']>

// 模块级 runner：由 initAutoDream() 赋值，未初始化前为 null
// executeAutoDream() 通过可选链安全调用，未初始化时直接 no-op
let runner:
  | ((
      context: REPLHookContext,
      appendSystemMessage?: AppendSystemMessageFn,
    ) => Promise<void>)
  | null = null

/**
 * 初始化 AutoDream runner 闭包。
 *
 * 应在启动时调用一次（从 backgroundHousekeeping 与 initExtractMemories 并列调用）。
 * 也可在测试的 beforeEach 中调用以获得干净的闭包状态（重置 lastSessionScanAt）。
 *
 * 闭包内状态：lastSessionScanAt — 上次会话文件扫描时间戳，用于节流控制。
 */
export function initAutoDream(): void {
  let lastSessionScanAt = 0 // 上次会话文件扫描时间戳（闭包内私有）

  runner = async function runAutoDream(context, appendSystemMessage) {
    const cfg = getConfig()
    const force = isForced()
    // 功能总开关检查（强制模式绕过）
    if (!force && !isGateOpen()) return

    // --- 时间门 ---
    let lastAt: number
    try {
      lastAt = await readLastConsolidatedAt() // 读取锁文件的 mtime 作为上次整合时间
    } catch (e: unknown) {
      logForDebugging(
        `[autoDream] readLastConsolidatedAt failed: ${(e as Error).message}`,
      )
      return
    }
    const hoursSince = (Date.now() - lastAt) / 3_600_000
    // 距上次整合不足 minHours 小时时跳过
    if (!force && hoursSince < cfg.minHours) return

    // --- 扫描节流 ---
    // 时间门已通过，但上次扫描时间距今小于节流间隔（10分钟）
    // 防止锁文件时间戳未推进导致时间门每轮都满足，频繁触发文件扫描
    const sinceScanMs = Date.now() - lastSessionScanAt
    if (!force && sinceScanMs < SESSION_SCAN_INTERVAL_MS) {
      logForDebugging(
        `[autoDream] scan throttle — time-gate passed but last scan was ${Math.round(sinceScanMs / 1000)}s ago`,
      )
      return
    }
    lastSessionScanAt = Date.now() // 更新扫描时间戳

    // --- 会话数量门 ---
    let sessionIds: string[]
    try {
      sessionIds = await listSessionsTouchedSince(lastAt) // 获取上次整合后修改过的会话列表
    } catch (e: unknown) {
      logForDebugging(
        `[autoDream] listSessionsTouchedSince failed: ${(e as Error).message}`,
      )
      return
    }
    // 排除当前会话（当前会话的 mtime 始终是最近的，不应计入"新"会话）
    const currentSession = getSessionId()
    sessionIds = sessionIds.filter(id => id !== currentSession)
    if (!force && sessionIds.length < cfg.minSessions) {
      logForDebugging(
        `[autoDream] skip — ${sessionIds.length} sessions since last consolidation, need ${cfg.minSessions}`,
      )
      return
    }

    // --- 互斥锁 ---
    // 强制模式跳过获取锁：使用已有 mtime 作为 priorMtime
    // 这样 kill 时的回滚是幂等操作（回滚到已有位置）。锁文件保持不变，
    // 下次非强制触发时看到的是相同的状态。
    let priorMtime: number | null
    if (force) {
      priorMtime = lastAt // 强制模式：不修改锁文件，priorMtime = 当前时间戳
    } else {
      try {
        priorMtime = await tryAcquireConsolidationLock() // 尝试获取互斥锁（写入当前 PID）
      } catch (e: unknown) {
        logForDebugging(
          `[autoDream] lock acquire failed: ${(e as Error).message}`,
        )
        return
      }
      if (priorMtime === null) return // 锁被其他进程持有，跳过本轮
    }

    logForDebugging(
      `[autoDream] firing — ${hoursSince.toFixed(1)}h since last, ${sessionIds.length} sessions to review`,
    )
    // 上报整合触发事件（用于分析使用频率和会话规模）
    logEvent('tengu_auto_dream_fired', {
      hours_since: Math.round(hoursSince),
      sessions_since: sessionIds.length,
    })

    // 准备任务状态（支持从后台任务对话框中止）
    const setAppState =
      context.toolUseContext.setAppStateForTasks ??
      context.toolUseContext.setAppState
    const abortController = new AbortController()
    const taskId = registerDreamTask(setAppState, {
      sessionsReviewing: sessionIds.length,
      priorMtime,
      abortController,
    })

    try {
      const memoryRoot = getAutoMemPath()     // 记忆文件根目录
      const transcriptDir = getProjectDir(getOriginalCwd()) // 会话记录目录
      // 工具约束说明放在 extra 参数中而非共享提示体
      // 这样手动 /dream 在主循环中运行时不会看到这条限制提示（手动 dream 有正常权限）
      const extra = `

**Tool constraints for this run:** Bash is restricted to read-only commands (\`ls\`, \`find\`, \`grep\`, \`cat\`, \`stat\`, \`wc\`, \`head\`, \`tail\`, and similar). Anything that writes, redirects to a file, or modifies state will be denied. Plan your exploration with this in mind — no need to probe.

Sessions since last consolidation (${sessionIds.length}):
${sessionIds.map(id => `- ${id}`).join('\n')}`
      const prompt = buildConsolidationPrompt(memoryRoot, transcriptDir, extra)

      // 启动 forkedAgent 子代理执行整合（querySource='auto_dream'，skipTranscript=true）
      const result = await runForkedAgent({
        promptMessages: [createUserMessage({ content: prompt })],
        cacheSafeParams: createCacheSafeParams(context),
        canUseTool: createAutoMemCanUseTool(memoryRoot), // 限制工具只能读取/修改记忆目录
        querySource: 'auto_dream',
        forkLabel: 'auto_dream',
        skipTranscript: true, // 整合流程不写入主会话记录
        overrides: { abortController },
        onMessage: makeDreamProgressWatcher(taskId, setAppState), // 监听子代理消息更新任务进度
      })

      completeDreamTask(taskId, setAppState) // 标记任务完成
      // 若有文件被修改，在主会话中追加"已改进记忆"系统消息（与 extractMemories 相同的展示形式）
      const dreamState = context.toolUseContext.getAppState().tasks?.[taskId]
      if (
        appendSystemMessage &&
        isDreamTask(dreamState) &&
        dreamState.filesTouched.length > 0
      ) {
        appendSystemMessage({
          ...createMemorySavedMessage(dreamState.filesTouched),
          verb: 'Improved', // 区别于 extractMemories 的 'Saved'
        })
      }
      logForDebugging(
        `[autoDream] completed — cache: read=${result.totalUsage.cache_read_input_tokens} created=${result.totalUsage.cache_creation_input_tokens}`,
      )
      // 上报整合完成事件（含 cache 命中率和输出 token 数）
      logEvent('tengu_auto_dream_completed', {
        cache_read: result.totalUsage.cache_read_input_tokens,
        cache_created: result.totalUsage.cache_creation_input_tokens,
        output: result.totalUsage.output_tokens,
        sessions_reviewed: sessionIds.length,
      })
    } catch (e: unknown) {
      // 用户通过后台任务对话框中止时，DreamTask.kill 已处理：
      // 已中止 abortController、回滚锁、并将任务状态设为 killed。
      // 不应再次覆盖状态或重复回滚。
      if (abortController.signal.aborted) {
        logForDebugging('[autoDream] aborted by user')
        return
      }
      logForDebugging(`[autoDream] fork failed: ${(e as Error).message}`)
      logEvent('tengu_auto_dream_failed', {})
      failDreamTask(taskId, setAppState)
      // 回滚：将锁文件 mtime 恢复到整合前，让时间门在下次检查时重新开放
      // 扫描节流（10分钟）充当失败后的退避机制
      await rollbackConsolidationLock(priorMtime)
    }
  }
}

/**
 * 监听子代理（forkedAgent）消息，更新后台任务进度。
 *
 * 对每条 assistant 消息：
 *  - 提取所有 text 块（代理的推理/摘要，用户在后台任务面板看到的内容）
 *  - 将 tool_use 块折叠为工具调用计数
 *  - 收集 FileEdit/FileWrite 工具调用中的 file_path（用于阶段切换和完成消息）
 */
function makeDreamProgressWatcher(
  taskId: string,
  setAppState: import('../../Task.js').SetAppState,
): (msg: Message) => void {
  return msg => {
    if (msg.type !== 'assistant') return // 只处理 assistant 消息
    let text = ''
    let toolUseCount = 0
    const touchedPaths: string[] = []
    for (const block of msg.message.content) {
      if (block.type === 'text') {
        text += block.text // 收集文本内容（推理/摘要）
      } else if (block.type === 'tool_use') {
        toolUseCount++
        // 收集文件编辑/写入工具的目标路径
        if (
          block.name === FILE_EDIT_TOOL_NAME ||
          block.name === FILE_WRITE_TOOL_NAME
        ) {
          const input = block.input as { file_path?: unknown }
          if (typeof input.file_path === 'string') {
            touchedPaths.push(input.file_path)
          }
        }
      }
    }
    // 更新任务进度：追加本轮文本、工具调用数和触碰路径
    addDreamTurn(
      taskId,
      { text: text.trim(), toolUseCount },
      touchedPaths,
      setAppState,
    )
  }
}

/**
 * 从 stopHooks 调用的入口函数。
 *
 * 在 initAutoDream() 被调用前始终是 no-op（runner 为 null）。
 * 每轮调用的开销：一次 GrowthBook 缓存读 + 一次文件 stat（时间门）。
 */
export async function executeAutoDream(
  context: REPLHookContext,
  appendSystemMessage?: AppendSystemMessageFn,
): Promise<void> {
  await runner?.(context, appendSystemMessage) // 未初始化时安全跳过
}
