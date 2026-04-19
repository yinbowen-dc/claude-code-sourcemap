/**
 * useCancelRequest.ts
 *
 * 【在系统流程中的位置】
 * 本文件属于 Claude Code 「输入控制」子系统，实现了取消/中断操作的键绑定处理组件。
 * CancelRequestHandler 在 REPL 树中渲染，但不产生任何 UI（返回 null），
 * 仅注册三个键绑定处理器：
 *
 * 1. chat:cancel（Escape）：
 *    - 优先级 1：若有进行中的 LLM 请求（abortSignal 未中止），立即取消；
 *    - 优先级 2：若没有进行中请求但命令队列非空，弹出队列中的下一条命令；
 *    - 兜底：触发 onCancel 回调。
 *    - 上下文守卫：在 transcript 视图、历史搜索、消息选择器、
 *      本地 JSX 命令、帮助页面、覆盖层、Vim INSERT 模式、
 *      viewing-agent 模式下禁用（各有专属 Escape 处理器）；
 *    - 空输入的特殊模式（bash/background）下也禁用（让 PromptInput 处理退出）。
 *
 * 2. app:interrupt（Ctrl+C）：
 *    - 若在 viewing-agent 模式：杀死所有 Agent 并退出 teammate 视图；
 *    - 若有进行中请求或命令队列：执行 handleCancel；
 *    - 闲置时不激活（避免吞掉复制选区的 Ctrl+C 和双击退出）。
 *
 * 3. chat:killAgents（Ctrl+X Ctrl+K）：
 *    - 两次按键确认模式（KILL_AGENTS_CONFIRM_WINDOW_MS=3000ms）：
 *      第一次显示确认提示，第二次在窗口内才真正杀死所有后台 Agent；
 *    - 若无后台 Agent 则显示提示通知；
 *    - 此键绑定始终激活（作为 chord 前缀，禁用会泄漏 ctrl+k 到 readline）。
 *
 * 主要导出：
 * - CancelRequestHandler(props: CancelRequestHandlerProps): null
 */

/**
 * CancelRequestHandler component for handling cancel/escape keybinding.
 *
 * Must be rendered inside KeybindingSetup to have access to the keybinding context.
 * This component renders nothing - it just registers the cancel keybinding handler.
 */
import { useCallback, useRef } from 'react'
import { logEvent } from 'src/services/analytics/index.js'
import type { AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from 'src/services/analytics/metadata.js'
import {
  useAppState,
  useAppStateStore,
  useSetAppState,
} from 'src/state/AppState.js'
import { isVimModeEnabled } from '../components/PromptInput/utils.js'
import type { ToolUseConfirm } from '../components/permissions/PermissionRequest.js'
import type { SpinnerMode } from '../components/Spinner/types.js'
import { useNotifications } from '../context/notifications.js'
import { useIsOverlayActive } from '../context/overlayContext.js'
import { useCommandQueue } from '../hooks/useCommandQueue.js'
import { getShortcutDisplay } from '../keybindings/shortcutFormat.js'
import { useKeybinding } from '../keybindings/useKeybinding.js'
import type { Screen } from '../screens/REPL.js'
import { exitTeammateView } from '../state/teammateViewHelpers.js'
import {
  killAllRunningAgentTasks,
  markAgentsNotified,
} from '../tasks/LocalAgentTask/LocalAgentTask.js'
import type { PromptInputMode, VimMode } from '../types/textInputTypes.js'
import {
  clearCommandQueue,
  enqueuePendingNotification,
  hasCommandsInQueue,
} from '../utils/messageQueueManager.js'
import { emitTaskTerminatedSdk } from '../utils/sdkEventQueue.js'

/** 两次 killAgents 按键之间的最大时间窗口（毫秒），超出则重置为第一次按键 */
/** Time window in ms during which a second press kills all background agents. */
const KILL_AGENTS_CONFIRM_WINDOW_MS = 3000

/**
 * CancelRequestHandler 的 props 类型。
 * 封装了取消操作需要的全部上下文信息。
 */
type CancelRequestHandlerProps = {
  /** 清空工具确认队列的函数式更新器 */
  setToolUseConfirmQueue: (
    f: (toolUseConfirmQueue: ToolUseConfirm[]) => ToolUseConfirm[],
  ) => void
  /** 实际执行取消操作的回调（触发 abort） */
  onCancel: () => void
  /** 所有 Agent 被杀死后的回调 */
  onAgentsKilled: () => void
  /** 消息选择器是否可见（激活时禁用 Escape） */
  isMessageSelectorVisible: boolean
  /** 当前屏幕（transcript 屏幕有自己的 Escape 处理） */
  screen: Screen
  /** 当前 LLM 请求的 abort signal（undefined 表示无进行中请求） */
  abortSignal?: AbortSignal
  /** 弹出命令队列中下一条命令的回调 */
  popCommandFromQueue?: () => void
  /** 当前 Vim 模式（INSERT 模式下禁用 Escape） */
  vimMode?: VimMode
  /** 是否正在执行本地 JSX 命令（如 /model） */
  isLocalJSXCommand?: boolean
  /** 是否正在搜索历史（有自己的 Escape 处理） */
  isSearchingHistory?: boolean
  /** 帮助页面是否打开（有自己的 Escape 处理） */
  isHelpOpen?: boolean
  /** 当前输入模式（prompt/bash/background 等） */
  inputMode?: PromptInputMode
  /** 当前输入框内容（非 prompt 模式且为空时让 PromptInput 处理退出） */
  inputValue?: string
  /** 当前 spinner 模式（用于分析日志） */
  streamMode?: SpinnerMode
}

/**
 * 取消请求处理组件。
 * 渲染为 null，仅注册 chat:cancel 键绑定处理器。
 *
 * Component that handles cancel requests via keybinding.
 * Renders null but registers the 'chat:cancel' keybinding handler.
 */
export function CancelRequestHandler(props: CancelRequestHandlerProps): null {
  const {
    setToolUseConfirmQueue,
    onCancel,
    onAgentsKilled,
    isMessageSelectorVisible,
    screen,
    abortSignal,
    popCommandFromQueue,
    vimMode,
    isLocalJSXCommand,
    isSearchingHistory,
    isHelpOpen,
    inputMode,
    inputValue,
    streamMode,
  } = props
  // 使用 store 直接读取 tasks，避免 handleKillAgents 中产生过期闭包
  const store = useAppStateStore()
  const setAppState = useSetAppState()
  // 当前命令队列长度（用于判断是否需要弹出命令）
  const queuedCommandsLength = useCommandQueue().length
  const { addNotification, removeNotification } = useNotifications()
  // killAgents 上次按键时间戳 ref（实现两次确认模式）
  const lastKillAgentsPressRef = useRef<number>(0)
  // 当前视图选择模式（用于判断是否在 viewing-agent 模式）
  const viewSelectionMode = useAppState(s => s.viewSelectionMode)

  /**
   * 执行取消操作：
   * 1. 若有进行中的请求（abortSignal 未中止）→ 取消请求（最高优先级）；
   * 2. 若命令队列非空 → 弹出队列中的下一条命令；
   * 3. 兜底 → 触发 onCancel。
   */
  const handleCancel = useCallback(() => {
    const cancelProps = {
      source:
        'escape' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      streamMode:
        streamMode as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    }

    // 优先级 1：有进行中的请求，立即取消（允许用户随时中断 Claude）
    // Priority 1: If there's an active task running, cancel it first
    // This takes precedence over queue management so users can always interrupt Claude
    if (abortSignal !== undefined && !abortSignal.aborted) {
      logEvent('tengu_cancel', cancelProps)
      setToolUseConfirmQueue(() => [])  // 清空工具确认队列
      onCancel()
      return
    }

    // 优先级 2：Claude 空闲但有排队命令，弹出一条
    // Priority 2: Pop queue when Claude is idle (no running task to cancel)
    if (hasCommandsInQueue()) {
      if (popCommandFromQueue) {
        popCommandFromQueue()
        return
      }
    }

    // 兜底：无可取消任务或可弹出命令（理论上不应到达此处）
    // Fallback: nothing to cancel or pop (shouldn't reach here if isActive is correct)
    logEvent('tengu_cancel', cancelProps)
    setToolUseConfirmQueue(() => [])
    onCancel()
  }, [
    abortSignal,
    popCommandFromQueue,
    setToolUseConfirmQueue,
    onCancel,
    streamMode,
  ])

  // ── 上下文守卫：计算各键绑定的激活条件 ─────────────────────────────────────
  // Transcript、HistorySearch、Help 等场景有自己的 Escape 处理器
  // 覆盖层（ModelPicker、ThinkingToggle 等）通过 useRegisterOverlay 自行注册
  // 本地 JSX 命令（/model、/btw 等）自己处理输入
  // Determine if this handler should be active
  // Other contexts (Transcript, HistorySearch, Help) have their own escape handlers
  // Overlays (ModelPicker, ThinkingToggle, etc.) register themselves via useRegisterOverlay
  // Local JSX commands (like /model, /btw) handle their own input
  const isOverlayActive = useIsOverlayActive()
  // 是否有可以取消的进行中请求
  const canCancelRunningTask = abortSignal !== undefined && !abortSignal.aborted
  const hasQueuedCommands = queuedCommandsLength > 0
  // 非 prompt 模式且输入框为空时，让 PromptInput 处理退出（不抢 Escape）
  // When in bash/background mode with empty input, escape should exit the mode
  // rather than cancel the request. Let PromptInput handle mode exit.
  // This only applies to Escape, not Ctrl+C which should always cancel.
  const isInSpecialModeWithEmptyInput =
    inputMode !== undefined && inputMode !== 'prompt' && !inputValue
  // 在 viewing-agent 模式时，Escape 交由 useBackgroundTaskNavigation 处理
  // When viewing a teammate's transcript, let useBackgroundTaskNavigation handle Escape
  const isViewingTeammate = viewSelectionMode === 'viewing-agent'
  // 基础上下文守卫：所有场景都需要满足
  // Context guards: other screens/overlays handle their own cancel
  const isContextActive =
    screen !== 'transcript' &&
    !isSearchingHistory &&
    !isMessageSelectorVisible &&
    !isLocalJSXCommand &&
    !isHelpOpen &&
    !isOverlayActive &&
    !(isVimModeEnabled() && vimMode === 'INSERT')

  // Escape（chat:cancel）：满足基础上下文 + 有可操作任务 + 不在特殊模式 + 不在 viewing-agent
  // Escape (chat:cancel) defers to mode-exit when in special mode with empty
  // input, and to useBackgroundTaskNavigation when viewing a teammate
  const isEscapeActive =
    isContextActive &&
    (canCancelRunningTask || hasQueuedCommands) &&
    !isInSpecialModeWithEmptyInput &&
    !isViewingTeammate

  // Ctrl+C（app:interrupt）：在 viewing-agent 时额外激活（杀死 Agent 并退出）
  // 闲置时不激活（避免吞掉 copy-selection Ctrl+C 和双击退出检测）
  // Ctrl+C (app:interrupt): when viewing a teammate, stops everything and
  // returns to main thread. Otherwise just handleCancel. Must NOT claim
  // ctrl+c when main is idle at the prompt — that blocks the copy-selection
  // handler and double-press-to-exit from ever seeing the keypress.
  const isCtrlCActive =
    isContextActive &&
    (canCancelRunningTask || hasQueuedCommands || isViewingTeammate)

  // 注册 chat:cancel（Escape）键绑定
  useKeybinding('chat:cancel', handleCancel, {
    context: 'Chat',
    isActive: isEscapeActive,
  })

  /**
   * 公共 killAll 路径：停止所有 Agent，抑制各 Agent 的独立通知，
   * 发出 SDK 事件，并将聚合通知插入队列（供模型读取）。
   * 返回 true 表示实际发生了 kill 操作。
   */
  // Shared kill path: stop all agents, suppress per-agent notifications,
  // emit SDK events, enqueue a single aggregate model-facing notification.
  // Returns true if anything was killed.
  const killAllAgentsAndNotify = useCallback((): boolean => {
    const tasks = store.getState().tasks
    // 找出所有运行中的 local_agent 任务
    const running = Object.entries(tasks).filter(
      ([, t]) => t.type === 'local_agent' && t.status === 'running',
    )
    if (running.length === 0) return false
    // 触发所有任务的 kill
    killAllRunningAgentTasks(tasks, setAppState)
    const descriptions: string[] = []
    for (const [taskId, task] of running) {
      // 标记已通知，避免各 Agent 发出独立通知
      markAgentsNotified(taskId, setAppState)
      descriptions.push(task.description)
      // 向 SDK 事件队列发送任务终止事件
      emitTaskTerminatedSdk(taskId, 'stopped', {
        toolUseId: task.toolUseId,
        summary: task.description,
      })
    }
    // 构建聚合通知文本（单/多 Agent 有不同格式）
    const summary =
      descriptions.length === 1
        ? `Background agent "${descriptions[0]}" was stopped by the user.`
        : `${descriptions.length} background agents were stopped by the user: ${descriptions.map(d => `"${d}"`).join(', ')}.`
    // 将聚合通知插入模型通知队列
    enqueuePendingNotification({ value: summary, mode: 'task-notification' })
    onAgentsKilled()
    return true
  }, [store, setAppState, onAgentsKilled])

  /**
   * Ctrl+C（app:interrupt）处理函数：
   * - 在 viewing-agent 模式：杀死所有 Agent 并退出 teammate 视图；
   * - 否则：执行普通取消（handleCancel）。
   */
  // Ctrl+C (app:interrupt). Scoped to teammate-view: killing agents from the
  // main prompt stays a deliberate gesture (chat:killAgents), not a
  // side-effect of cancelling a turn.
  const handleInterrupt = useCallback(() => {
    if (isViewingTeammate) {
      killAllAgentsAndNotify()
      exitTeammateView(setAppState)
    }
    if (canCancelRunningTask || hasQueuedCommands) {
      handleCancel()
    }
  }, [
    isViewingTeammate,
    killAllAgentsAndNotify,
    setAppState,
    canCancelRunningTask,
    hasQueuedCommands,
    handleCancel,
  ])

  // 注册 app:interrupt（Ctrl+C）键绑定
  useKeybinding('app:interrupt', handleInterrupt, {
    context: 'Global',
    isActive: isCtrlCActive,
  })

  /**
   * Ctrl+X Ctrl+K（chat:killAgents）处理函数——两次确认模式：
   * - 若无运行中 Agent，显示提示通知；
   * - 第一次按键：记录时间戳，显示确认提示（倒计时 3 秒）；
   * - 第二次按键（3 秒内）：清空命令队列，杀死所有 Agent。
   *
   * 直接从 store 读取 tasks（而非 props/state），避免 useCallback 闭包过期问题。
   */
  // chat:killAgents uses a two-press pattern: first press shows a
  // confirmation hint, second press within the window actually kills all
  // agents. Reads tasks from the store directly to avoid stale closures.
  const handleKillAgents = useCallback(() => {
    const tasks = store.getState().tasks
    const hasRunningAgents = Object.values(tasks).some(
      t => t.type === 'local_agent' && t.status === 'running',
    )
    if (!hasRunningAgents) {
      // 无运行中 Agent，显示提示通知（2 秒后消失）
      addNotification({
        key: 'kill-agents-none',
        text: 'No background agents running',
        priority: 'immediate',
        timeoutMs: 2000,
      })
      return
    }
    const now = Date.now()
    const elapsed = now - lastKillAgentsPressRef.current
    if (elapsed <= KILL_AGENTS_CONFIRM_WINDOW_MS) {
      // 第二次按键（在确认窗口内）：真正执行 kill
      // Second press within window -- kill all background agents
      lastKillAgentsPressRef.current = 0  // 重置时间戳（防止第三次按键误触发）
      removeNotification('kill-agents-confirm')
      logEvent('tengu_cancel', {
        source:
          'kill_agents' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
      clearCommandQueue()         // 清空命令队列
      killAllAgentsAndNotify()    // 杀死所有 Agent 并发出聚合通知
      return
    }
    // 第一次按键：记录时间戳并显示确认提示
    // First press -- show confirmation hint in status bar
    lastKillAgentsPressRef.current = now
    const shortcut = getShortcutDisplay(
      'chat:killAgents',
      'Chat',
      'ctrl+x ctrl+k',
    )
    addNotification({
      key: 'kill-agents-confirm',
      text: `Press ${shortcut} again to stop background agents`,
      priority: 'immediate',
      timeoutMs: KILL_AGENTS_CONFIRM_WINDOW_MS,
    })
  }, [store, addNotification, removeNotification, killAllAgentsAndNotify])

  // chat:killAgents 必须始终激活（isActive 不传，默认 true）：
  // ctrl+x 作为 chord 前缀被系统消耗，禁用此 handler 会导致 ctrl+k
  // 泄漏到 readline 的 kill-line 命令。Handler 内部自行判断是否执行。
  // Must stay always-active: ctrl+x is consumed as a chord prefix regardless
  // of isActive (because ctrl+x ctrl+e is always live), so an inactive handler
  // here would leak ctrl+k to readline kill-line. Handler gates internally.
  useKeybinding('chat:killAgents', handleKillAgents, {
    context: 'Chat',
  })

  // 此组件不渲染任何 UI，仅注册键绑定处理器
  return null
}
