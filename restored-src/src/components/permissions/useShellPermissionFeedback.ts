/**
 * useShellPermissionFeedback.ts
 *
 * 【层级一：文件职责说明】
 * 本文件是 Claude Code 权限系统中 Shell 工具（Bash / PowerShell）权限对话框的
 * 共享反馈状态 Hook。
 *
 * 在 Claude Code 的系统流程中，当 Claude 请求执行 Shell 命令时，UI 会弹出
 * 权限确认对话框，用户可以选择：
 *   - 直接按 Y 同意 / N 拒绝
 *   - 按 Tab 进入"反馈输入模式"，在同意/拒绝时附带文字反馈
 *   - 按 ESC 直接拒绝（不附带反馈）
 *
 * 本 Hook 将上述交互状态集中管理，供 BashPermissionRequest、
 * PowerShellPermissionRequest 等组件复用，避免重复实现相同的状态逻辑。
 *
 * 主要职责：
 *   1. 管理 Yes / No 反馈输入模式的开关（yesInputMode / noInputMode）
 *   2. 记录用户是否曾经进入过反馈模式（yesFeedbackModeEntered / noFeedbackModeEntered）
 *   3. 管理反馈文本内容（acceptFeedback / rejectFeedback）
 *   4. 追踪当前焦点选项（focusedOption）
 *   5. 处理拒绝动作并上报 analytics 事件
 *   6. 处理焦点切换时自动折叠空的反馈输入框
 */

import { useState } from 'react'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js'
import { sanitizeToolNameForAnalytics } from '../../services/analytics/metadata.js'
import { useSetAppState } from '../../state/AppState.js'
import type { ToolUseConfirm } from './PermissionRequest.js'
import { logUnaryPermissionEvent } from './utils.js'

/**
 * 【层级二：Hook 整体说明】
 * useShellPermissionFeedback —— Shell 权限对话框反馈状态管理 Hook
 *
 * 调用方需提供：
 *   - toolUseConfirm：当前工具使用确认上下文（含工具信息、回调等）
 *   - onDone：对话框关闭后的通知回调
 *   - onReject：拒绝动作执行后的额外回调
 *   - explainerVisible：当前是否展示了操作说明面板（影响 ESC analytics 事件字段）
 *
 * 返回的状态与方法：
 *   - yesInputMode / noInputMode：反馈输入框当前是否展开
 *   - yesFeedbackModeEntered / noFeedbackModeEntered：是否曾进入过对应反馈模式
 *   - acceptFeedback / rejectFeedback：反馈文本
 *   - setAcceptFeedback / setRejectFeedback：文本 setter
 *   - focusedOption：当前高亮/焦点选项（'yes' | 'no' | ...）
 *   - handleInputModeToggle：Tab 键触发的反馈模式切换
 *   - handleReject：执行拒绝操作（含 analytics 上报）
 *   - handleFocus：焦点变更处理（含自动折叠空输入框）
 */
export function useShellPermissionFeedback({
  toolUseConfirm,
  onDone,
  onReject,
  explainerVisible,
}: {
  toolUseConfirm: ToolUseConfirm
  onDone: () => void
  onReject: () => void
  explainerVisible: boolean
}): {
  yesInputMode: boolean
  noInputMode: boolean
  yesFeedbackModeEntered: boolean
  noFeedbackModeEntered: boolean
  acceptFeedback: string
  rejectFeedback: string
  setAcceptFeedback: (v: string) => void
  setRejectFeedback: (v: string) => void
  focusedOption: string
  handleInputModeToggle: (option: string) => void
  handleReject: (feedback?: string) => void
  handleFocus: (value: string) => void
} {
  // 获取全局 AppState 的 setter，用于在 ESC 时递增 escapeCount
  const setAppState = useSetAppState()

  // 拒绝时的文字反馈内容
  const [rejectFeedback, setRejectFeedback] = useState('')
  // 同意时的文字反馈内容
  const [acceptFeedback, setAcceptFeedback] = useState('')
  // Yes 选项的反馈输入框是否展开
  const [yesInputMode, setYesInputMode] = useState(false)
  // No 选项的反馈输入框是否展开
  const [noInputMode, setNoInputMode] = useState(false)
  // 当前高亮/焦点的选项，默认为 'yes'
  const [focusedOption, setFocusedOption] = useState('yes')
  // 是否曾经进入过 Yes 反馈模式（即使折叠后也保持 true，用于 UI 区分显示）
  const [yesFeedbackModeEntered, setYesFeedbackModeEntered] = useState(false)
  // 是否曾经进入过 No 反馈模式
  const [noFeedbackModeEntered, setNoFeedbackModeEntered] = useState(false)

  /**
   * 【层级二：handleInputModeToggle】
   * 处理 Tab 键触发的反馈输入模式切换。
   *
   * 流程：
   *   1. 通知 toolUseConfirm 用户正在交互（防止超时自动关闭）
   *   2. 构造 analytics 属性（工具名称、是否 MCP 工具）
   *   3. 根据 option 参数（'yes' | 'no'）切换对应输入模式
   *      - 若当前已展开 → 折叠，上报 _collapsed 事件
   *      - 若当前已折叠 → 展开，标记 FeedbackModeEntered，上报 _entered 事件
   *
   * @param option - 要切换的选项名称（'yes' | 'no'）
   */
  function handleInputModeToggle(option: string) {
    // 通知对话框用户正在主动交互，重置超时计时器
    toolUseConfirm.onUserInteraction()

    // 构造 analytics 上报属性：工具名（已脱敏）和是否为 MCP 工具
    const analyticsProps = {
      toolName: sanitizeToolNameForAnalytics(
        toolUseConfirm.tool.name,
      ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      isMcp: toolUseConfirm.tool.isMcp ?? false,
    }

    if (option === 'yes') {
      if (yesInputMode) {
        // Yes 输入框当前已展开 → 折叠，并上报折叠事件
        setYesInputMode(false)
        logEvent('tengu_accept_feedback_mode_collapsed', analyticsProps)
      } else {
        // Yes 输入框当前已折叠 → 展开，标记曾进入反馈模式，并上报进入事件
        setYesInputMode(true)
        setYesFeedbackModeEntered(true)
        logEvent('tengu_accept_feedback_mode_entered', analyticsProps)
      }
    } else if (option === 'no') {
      if (noInputMode) {
        // No 输入框当前已展开 → 折叠，并上报折叠事件
        setNoInputMode(false)
        logEvent('tengu_reject_feedback_mode_collapsed', analyticsProps)
      } else {
        // No 输入框当前已折叠 → 展开，标记曾进入反馈模式，并上报进入事件
        setNoInputMode(true)
        setNoFeedbackModeEntered(true)
        logEvent('tengu_reject_feedback_mode_entered', analyticsProps)
      }
    }
  }

  /**
   * 【层级二：handleReject】
   * 执行拒绝操作并上报 analytics。
   *
   * 流程：
   *   1. 裁剪 feedback 文本，判断是否有有效反馈
   *   2. 若无反馈（用户直接按 ESC）：
   *      a. 上报 tengu_permission_request_escape 事件（含 explainer_visible）
   *      b. 递增全局 attribution.escapeCount（用于后续行为归因）
   *   3. 调用 logUnaryPermissionEvent 上报 reject 事件（含 hasFeedback 标志）
   *   4. 调用 toolUseConfirm.onReject()，将反馈文本（如有）传入
   *   5. 依次调用 onReject() 和 onDone() 关闭对话框
   *
   * @param feedback - 可选的拒绝原因文字
   */
  function handleReject(feedback?: string) {
    // 裁剪首尾空白，判断是否存在有效文字反馈
    const trimmedFeedback = feedback?.trim()
    const hasFeedback = !!trimmedFeedback

    // 无反馈时表示用户直接按 ESC 关闭对话框
    if (!hasFeedback) {
      // 上报 ESC 关闭事件，记录当前说明面板可见状态
      logEvent('tengu_permission_request_escape', {
        explainer_visible: explainerVisible,
      })
      // 递增全局 ESC 计数，用于行为归因追踪
      setAppState(prev => ({
        ...prev,
        attribution: {
          ...prev.attribution,
          escapeCount: prev.attribution.escapeCount + 1,
        },
      }))
    }

    // 上报标准 unary 权限拒绝事件，包含 hasFeedback 标志
    logUnaryPermissionEvent(
      'tool_use_single',
      toolUseConfirm,
      'reject',
      hasFeedback,
    )

    // 将拒绝原因（如有）传入 toolUseConfirm 的 onReject 回调
    if (trimmedFeedback) {
      toolUseConfirm.onReject(trimmedFeedback)
    } else {
      toolUseConfirm.onReject()
    }

    // 通知父组件拒绝动作已执行，并关闭对话框
    onReject()
    onDone()
  }

  /**
   * 【层级二：handleFocus】
   * 处理焦点选项变更。
   *
   * 流程：
   *   1. 若焦点发生变化，通知 toolUseConfirm 用户正在交互
   *      （仅在焦点真正切换时触发，防止初始挂载时误触）
   *   2. 若焦点离开 'yes' 且 Yes 输入框已展开且无内容 → 自动折叠
   *   3. 若焦点离开 'no' 且 No 输入框已展开且无内容 → 自动折叠
   *   4. 更新 focusedOption 状态
   *
   * @param value - 新的焦点选项名称
   */
  function handleFocus(value: string) {
    // 只有焦点发生真实切换时才通知交互（防止初始渲染时触发）
    if (value !== focusedOption) {
      toolUseConfirm.onUserInteraction()
    }
    // 焦点离开 yes 且未输入任何内容时，自动折叠 Yes 反馈输入框
    if (value !== 'yes' && yesInputMode && !acceptFeedback.trim()) {
      setYesInputMode(false)
    }
    // 焦点离开 no 且未输入任何内容时，自动折叠 No 反馈输入框
    if (value !== 'no' && noInputMode && !rejectFeedback.trim()) {
      setNoInputMode(false)
    }
    setFocusedOption(value)
  }

  // 返回所有状态与处理函数，供 BashPermissionRequest / PowerShellPermissionRequest 使用
  return {
    yesInputMode,
    noInputMode,
    yesFeedbackModeEntered,
    noFeedbackModeEntered,
    acceptFeedback,
    rejectFeedback,
    setAcceptFeedback,
    setRejectFeedback,
    focusedOption,
    handleInputModeToggle,
    handleReject,
    handleFocus,
  }
}
