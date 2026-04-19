/**
 * useAutoModeUnavailableNotification.ts
 *
 * 【在 Claude Code 系统中的位置】
 * 本文件属于 hooks/notifs 层，是权限模式（PermissionMode）切换通知系统的一部分。
 * 当用户通过 shift+tab 切换权限模式的轮盘（carousel）并跳过了原本应该存在的
 * "auto 模式"槽位时，触发一次性警告通知，告知用户 auto 模式当前不可用的原因。
 *
 * 【主要功能】
 * - 监听权限模式（mode）的切换；
 * - 检测"轮盘绕过 auto 模式"这一特定状态转换；
 * - 弹出一次性 warning 级通知，说明 auto 模式不可用的原因；
 * - 仅在本地模式（非 remote mode）且启用了 TRANSCRIPT_CLASSIFIER feature 时生效。
 */

import { feature } from 'bun:bundle'
import { useEffect, useRef } from 'react'
import { useNotifications } from 'src/context/notifications.js'
import { getIsRemoteMode } from '../../bootstrap/state.js'
import { useAppState } from '../../state/AppState.js'
import type { PermissionMode } from '../../utils/permissions/PermissionMode.js'
import {
  getAutoModeUnavailableNotification,
  getAutoModeUnavailableReason,
} from '../../utils/permissions/permissionSetup.js'
import { hasAutoModeOptIn } from '../../utils/settings/settings.js'

/**
 * 当用户通过 shift+tab 模式轮盘绕过 auto 模式时，弹出一次性通知。
 *
 * 触发条件（同时满足以下所有条件）：
 * 1. 启用了 TRANSCRIPT_CLASSIFIER feature flag；
 * 2. 不是远程模式（remote mode）；
 * 3. 本次会话内尚未弹出过该通知（shownRef 守卫）；
 * 4. 当前模式为 'default'、上一模式既不是 'default' 也不是 'auto'；
 * 5. auto 模式当前不可用（isAutoModeAvailable === false）；
 * 6. 用户在设置中启用了 auto 模式（hasAutoModeOptIn）。
 *
 * 说明：启动时默认模式被静默降级的情况由
 * verifyAutoModeGateAccess → checkAndDisableAutoModeIfNeeded 处理，不在此 hook 覆盖范围内。
 */
export function useAutoModeUnavailableNotification(): void {
  // 从通知上下文获取添加通知的方法
  const { addNotification } = useNotifications()
  // 订阅当前权限模式
  const mode = useAppState(s => s.toolPermissionContext.mode)
  // 订阅 auto 模式是否可用的标志
  const isAutoModeAvailable = useAppState(
    s => s.toolPermissionContext.isAutoModeAvailable,
  )
  // 防止重复弹出的守卫 ref（会话内只弹一次）
  const shownRef = useRef(false)
  // 记录上一次渲染时的模式值，用于检测模式转换
  const prevModeRef = useRef<PermissionMode>(mode)

  useEffect(() => {
    // 读取并更新上一次的模式值
    const prevMode = prevModeRef.current
    prevModeRef.current = mode

    // 仅在启用 TRANSCRIPT_CLASSIFIER feature 时生效
    if (!feature('TRANSCRIPT_CLASSIFIER')) return
    // 远程模式下不显示本地权限通知
    if (getIsRemoteMode()) return
    // 本次会话已弹出过，不重复弹出
    if (shownRef.current) return

    // 检测"轮盘绕过 auto 模式"的状态转换：
    // - 当前模式为 'default'（轮盘转了一圈回到起点）
    // - 上一模式不是 'default'（确实发生了切换）
    // - 上一模式不是 'auto'（不是从 auto 切走，说明 auto 被跳过了）
    // - auto 模式当前不可用
    // - 用户有 auto 模式的 opt-in 配置
    const wrappedPastAutoSlot =
      mode === 'default' &&
      prevMode !== 'default' &&
      prevMode !== 'auto' &&
      !isAutoModeAvailable &&
      hasAutoModeOptIn()

    if (!wrappedPastAutoSlot) return

    // 获取 auto 模式不可用的具体原因（设置限制、熔断器、组织白名单等）
    const reason = getAutoModeUnavailableReason()
    if (!reason) return

    // 标记已弹出，防止重复
    shownRef.current = true
    // 添加 warning 级中优先级通知
    addNotification({
      key: 'auto-mode-unavailable',
      text: getAutoModeUnavailableNotification(reason), // 根据原因生成通知文本
      color: 'warning',
      priority: 'medium',
    })
  }, [mode, isAutoModeAvailable, addNotification])
}
