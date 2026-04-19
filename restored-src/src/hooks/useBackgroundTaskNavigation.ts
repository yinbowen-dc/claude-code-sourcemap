/**
 * useBackgroundTaskNavigation.ts
 *
 * 【在系统流程中的位置】
 * 本文件属于 Claude Code 「多 Agent / 后台任务」子系统，
 * 实现了通过键盘快捷键在后台任务和 Teammate（子 Agent）之间导航的 hook。
 *
 * 键盘操作：
 * - Shift+Up / Shift+Down：
 *     - 若有 Teammate（swarm 子 Agent）：在 leader(-1)、teammate(0..n-1)、
 *       "hide" 行(n) 之间循环切换；首次触发展开 spinner tree；
 *     - 若只有非 Teammate 后台任务：打开后台任务对话框；
 * - f（在选择模式下）：查看选中 Teammate 的 transcript；
 * - Enter（在选择模式下）：
 *     - index=-1（leader）→ 退出 teammate 视图；
 *     - index=n（hide 行）→ 收起 spinner tree；
 *     - 其他 → 进入选中 Teammate 的 transcript 视图；
 * - k（在选择模式下，index >= 0）：杀死选中 Teammate；
 * - Escape（在查看模式下）：
 *     - Teammate 正在运行中 → 中止当前工作（不杀死 Teammate）；
 *     - Teammate 已完成/失败/被杀死 → 退出 transcript 视图；
 * - Escape（在选择模式下）：退出选择，回到 'none' 状态。
 *
 * 主要导出：
 * - useBackgroundTaskNavigation({ onOpenBackgroundTasks }): { handleKeyDown }
 */

import { useEffect, useRef } from 'react'
import { KeyboardEvent } from '../ink/events/keyboard-event.js'
// eslint-disable-next-line custom-rules/prefer-use-keybindings -- backward-compat bridge until REPL wires handleKeyDown to <Box onKeyDown>
import { useInput } from '../ink.js'
import {
  type AppState,
  useAppState,
  useSetAppState,
} from '../state/AppState.js'
import {
  enterTeammateView,
  exitTeammateView,
} from '../state/teammateViewHelpers.js'
import {
  getRunningTeammatesSorted,
  InProcessTeammateTask,
} from '../tasks/InProcessTeammateTask/InProcessTeammateTask.js'
import {
  type InProcessTeammateTaskState,
  isInProcessTeammateTask,
} from '../tasks/InProcessTeammateTask/types.js'
import { isBackgroundTask } from '../tasks/types.js'

/**
 * 按 delta(+1/-1) 步进 Teammate 选择索引，并在边界循环。
 *
 * 索引含义：
 * - -1：leader（主 Agent）
 * - 0..n-1：各 Teammate
 * - n："hide" 行（收起 spinner tree）
 *
 * 若 spinner tree 未展开，首次步进先展开并停在 leader(-1)。
 * 若没有正在运行的 Teammate（currentCount=0），直接返回不变。
 *
 * @param delta      步进方向：+1 向下，-1 向上
 * @param setAppState AppState 的函数式更新器
 */
// Step teammate selection by delta, wrapping across leader(-1)..teammates(0..n-1)..hide(n).
// First step from a collapsed tree expands it and parks on leader.
function stepTeammateSelection(
  delta: 1 | -1,
  setAppState: (updater: (prev: AppState) => AppState) => void,
): void {
  setAppState(prev => {
    const currentCount = getRunningTeammatesSorted(prev.tasks).length
    // 没有正在运行的 Teammate，不做任何改变
    if (currentCount === 0) return prev

    // 若当前未展开 teammate 视图，先展开并停在 leader(-1)
    if (prev.expandedView !== 'teammates') {
      return {
        ...prev,
        expandedView: 'teammates' as const,
        viewSelectionMode: 'selecting-agent',
        selectedIPAgentIndex: -1,
      }
    }

    // maxIdx = n，即 "hide" 行的索引
    const maxIdx = currentCount // hide row
    const cur = prev.selectedIPAgentIndex
    // 循环步进：到达上界时跳回 -1，到达下界时跳到 maxIdx
    const next =
      delta === 1
        ? cur >= maxIdx
          ? -1          // 向下超出最大值，回到 leader
          : cur + 1
        : cur <= -1
          ? maxIdx      // 向上超出最小值，跳到 "hide" 行
          : cur - 1
    return {
      ...prev,
      selectedIPAgentIndex: next,
      viewSelectionMode: 'selecting-agent',
    }
  })
}

/**
 * 处理后台任务键盘导航的 hook。
 *
 * 当存在 Teammate（swarm 子 Agent）时，通过 Shift+Up/Down 在 leader 和
 * Teammate 之间导航；当只有非 Teammate 后台任务时，触发后台任务对话框。
 * 同时处理 Enter（确认选择）、f（查看 transcript）和 k（杀死 Teammate）。
 *
 * @param options.onOpenBackgroundTasks 打开后台任务对话框的回调（无 Teammate 时使用）
 * @returns { handleKeyDown } 键盘事件处理函数（同时通过 useInput bridge 注册）
 */
/**
 * Custom hook that handles Shift+Up/Down keyboard navigation for background tasks.
 * When teammates (swarm) are present, navigates between leader and teammates.
 * When only non-teammate background tasks exist, opens the background tasks dialog.
 * Also handles Enter to confirm selection, 'f' to view transcript, and 'k' to kill.
 */
export function useBackgroundTaskNavigation(options?: {
  onOpenBackgroundTasks?: () => void
}): { handleKeyDown: (e: KeyboardEvent) => void } {
  const tasks = useAppState(s => s.tasks)
  const viewSelectionMode = useAppState(s => s.viewSelectionMode)
  const viewingAgentTaskId = useAppState(s => s.viewingAgentTaskId)
  const selectedIPAgentIndex = useAppState(s => s.selectedIPAgentIndex)
  const setAppState = useSetAppState()

  // 按字母顺序排序的正在运行中的 Teammate 列表（与 TeammateSpinnerTree 显示顺序一致）
  // Filter to running teammates and sort alphabetically to match TeammateSpinnerTree display
  const teammateTasks = getRunningTeammatesSorted(tasks)
  const teammateCount = teammateTasks.length

  // 检查是否有非 Teammate 后台任务（local_agent、local_bash 等）
  // Check for non-teammate background tasks (local_agent, local_bash, etc.)
  const hasNonTeammateBackgroundTasks = Object.values(tasks).some(
    t => isBackgroundTask(t) && t.type !== 'in_process_teammate',
  )

  // 追踪上一次渲染时的 Teammate 数量，用于检测 Teammate 被移除的时机
  // Track previous teammate count to detect when teammates are removed
  const prevTeammateCountRef = useRef<number>(teammateCount)

  // ── Teammate 数量变化时钳制选择索引 ────────────────────────────────────────
  // 当 Teammate 被移除时，若索引越界则向下钳制；若所有 Teammate 消失则重置。
  // Clamp selection index if teammates are removed or reset when count becomes 0
  useEffect(() => {
    const prevCount = prevTeammateCountRef.current
    prevTeammateCountRef.current = teammateCount

    setAppState(prev => {
      const currentTeammates = getRunningTeammatesSorted(prev.tasks)
      const currentCount = currentTeammates.length

      // 当 Teammate 全部消失（从 >0 → 0），重置选择状态
      // 但若用户正在查看 Teammate 的 transcript（viewing-agent），
      // 保留 selectedIPAgentIndex，允许用户按 Escape 退出
      // When teammates are removed (count goes from >0 to 0), reset selection
      // Only reset if we previously had teammates (not on initial mount with 0)
      // Don't clobber viewSelectionMode if actively viewing a teammate transcript —
      // the user may be reviewing a completed teammate and needs escape to exit
      if (
        currentCount === 0 &&
        prevCount > 0 &&
        prev.selectedIPAgentIndex !== -1
      ) {
        if (prev.viewSelectionMode === 'viewing-agent') {
          // 正在查看 transcript，仅重置 index 不重置模式
          return {
            ...prev,
            selectedIPAgentIndex: -1,
          }
        }
        // 选择模式下全部重置
        return {
          ...prev,
          selectedIPAgentIndex: -1,
          viewSelectionMode: 'none',
        }
      }

      // 若索引超出当前有效范围，向下钳制
      // maxIndex: spinner tree 展开时含 "hide" 行（currentCount），否则仅到最后一个 teammate
      // Clamp if index is out of bounds
      // Max valid index is currentCount (the "hide" row) when spinner tree is shown
      const maxIndex =
        prev.expandedView === 'teammates' ? currentCount : currentCount - 1
      if (currentCount > 0 && prev.selectedIPAgentIndex > maxIndex) {
        return {
          ...prev,
          selectedIPAgentIndex: maxIndex,
        }
      }

      return prev
    })
  }, [teammateCount, setAppState])

  /**
   * 获取当前选中 Teammate 的任务信息。
   * - 若无 Teammate 或 index 越界，返回 null。
   */
  // Get the selected teammate's task info
  const getSelectedTeammate = (): {
    taskId: string
    task: InProcessTeammateTaskState
  } | null => {
    if (teammateCount === 0) return null
    const selectedIndex = selectedIPAgentIndex
    const task = teammateTasks[selectedIndex]
    if (!task) return null

    return { taskId: task.id, task }
  }

  /**
   * 键盘事件处理函数（handleKeyDown）。
   *
   * 处理以下键：
   * - Escape（viewing-agent 模式）：中止当前工作 或 退出 transcript 视图
   * - Escape（selecting-agent 模式）：退出选择
   * - Shift+Up / Shift+Down：步进 Teammate 选择
   * - f（selecting-agent 模式）：进入 transcript 视图
   * - Enter（selecting-agent 模式）：确认选择（leader/hide/teammate）
   * - k（selecting-agent 模式，index >= 0）：杀死选中 Teammate
   */
  const handleKeyDown = (e: KeyboardEvent): void => {
    // ── Escape（查看模式）────────────────────────────────────────────────────
    // Escape in viewing mode:
    // - If teammate is running: abort current work only (stops current turn, teammate stays alive)
    // - If teammate is not running (completed/killed/failed): exit the view back to leader
    if (e.key === 'escape' && viewSelectionMode === 'viewing-agent') {
      e.preventDefault()
      const taskId = viewingAgentTaskId
      if (taskId) {
        const task = tasks[taskId]
        if (isInProcessTeammateTask(task) && task.status === 'running') {
          // Teammate 正在运行：仅中止当前工作，不杀死 Teammate
          // Abort currentWorkAbortController (stops current turn) NOT abortController (kills teammate)
          task.currentWorkAbortController?.abort()
          return
        }
      }
      // Teammate 不在运行中或任务不存在，退出 transcript 视图
      // Teammate is not running or task doesn't exist — exit the view
      exitTeammateView(setAppState)
      return
    }

    // ── Escape（选择模式）────────────────────────────────────────────────────
    // Escape in selection mode: exit selection without aborting leader
    if (e.key === 'escape' && viewSelectionMode === 'selecting-agent') {
      e.preventDefault()
      setAppState(prev => ({
        ...prev,
        viewSelectionMode: 'none',
        selectedIPAgentIndex: -1,
      }))
      return
    }

    // ── Shift+Up / Shift+Down：Teammate 导航 ────────────────────────────────
    // Index -1 表示 leader，0+ 为各 Teammate
    // spinner tree 展开时 index=teammateCount 为 "hide" 行
    // Shift+Up/Down for teammate transcript switching (with wrapping)
    // Index -1 represents the leader, 0+ are teammates
    // When showSpinnerTree is true, index === teammateCount is the "hide" row
    if (e.shift && (e.key === 'up' || e.key === 'down')) {
      e.preventDefault()
      if (teammateCount > 0) {
        // 有 Teammate：步进选择索引
        stepTeammateSelection(e.key === 'down' ? 1 : -1, setAppState)
      } else if (hasNonTeammateBackgroundTasks) {
        // 无 Teammate 但有其他后台任务：打开后台任务对话框
        options?.onOpenBackgroundTasks?.()
      }
      return
    }

    // ── f：查看选中 Teammate 的 transcript ──────────────────────────────────
    // 'f' to view selected teammate's transcript (only in selecting mode)
    if (
      e.key === 'f' &&
      viewSelectionMode === 'selecting-agent' &&
      teammateCount > 0
    ) {
      e.preventDefault()
      const selected = getSelectedTeammate()
      if (selected) {
        enterTeammateView(selected.taskId, setAppState)
      }
      return
    }

    // ── Enter：确认当前选择 ──────────────────────────────────────────────────
    // Enter to confirm selection (only when in selecting mode)
    if (e.key === 'return' && viewSelectionMode === 'selecting-agent') {
      e.preventDefault()
      if (selectedIPAgentIndex === -1) {
        // 选中 leader，退出 teammate 视图
        exitTeammateView(setAppState)
      } else if (selectedIPAgentIndex >= teammateCount) {
        // 选中 "hide" 行，收起 spinner tree
        // "Hide" row selected - collapse the spinner tree
        setAppState(prev => ({
          ...prev,
          expandedView: 'none' as const,
          viewSelectionMode: 'none',
          selectedIPAgentIndex: -1,
        }))
      } else {
        // 选中某个 Teammate，进入其 transcript 视图
        const selected = getSelectedTeammate()
        if (selected) {
          enterTeammateView(selected.taskId, setAppState)
        }
      }
      return
    }

    // ── k：杀死选中 Teammate ─────────────────────────────────────────────────
    // k to kill selected teammate (only in selecting mode)
    if (
      e.key === 'k' &&
      viewSelectionMode === 'selecting-agent' &&
      selectedIPAgentIndex >= 0  // 不允许杀死 leader（index=-1）
    ) {
      e.preventDefault()
      const selected = getSelectedTeammate()
      if (selected && selected.task.status === 'running') {
        // 仅当 Teammate 处于运行状态时才执行 kill
        void InProcessTeammateTask.kill(selected.taskId, setAppState)
      }
      return
    }
  }

  // ── 兼容性 bridge：通过 useInput 订阅键盘事件 ─────────────────────────────
  // REPL.tsx 尚未将 handleKeyDown 接入 <Box onKeyDown>，
  // 临时通过 useInput 适配 InputEvent → KeyboardEvent，待迁移后移除。
  // Backward-compat bridge: REPL.tsx doesn't yet wire handleKeyDown to
  // <Box onKeyDown>. Subscribe via useInput and adapt InputEvent →
  // KeyboardEvent until the consumer is migrated (separate PR).
  // TODO(onKeyDown-migration): remove once REPL passes handleKeyDown.
  useInput((_input, _key, event) => {
    handleKeyDown(new KeyboardEvent(event.keypress))
  })

  return { handleKeyDown }
}
