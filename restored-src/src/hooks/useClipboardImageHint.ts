/**
 * @file useClipboardImageHint.ts
 *
 * 【在 Claude Code 系统流程中的位置】
 * 该 Hook 属于 UI 交互层的辅助提示模块。当终端窗口重新获得焦点时，
 * 检测系统剪贴板中是否存在图片，若存在则通过通知系统向用户展示粘贴提示。
 * 整体流程：
 *   终端获得焦点 → 防抖延迟 → 冷却检测 → 异步检查剪贴板 → 推送通知
 *
 * 依赖：
 *  - notifications context（通知上下文）：负责展示提示气泡
 *  - imagePaste 工具函数：调用 osascript 检查剪贴板内容
 *  - shortcutFormat：格式化快捷键展示文字
 */

import { useEffect, useRef } from 'react'
import { useNotifications } from '../context/notifications.js'
import { getShortcutDisplay } from '../keybindings/shortcutFormat.js'
import { hasImageInClipboard } from '../utils/imagePaste.js'

// 通知的唯一标识键，用于去重或关闭特定通知
const NOTIFICATION_KEY = 'clipboard-image-hint'
// Small debounce to batch rapid focus changes
// 防抖时间（毫秒）：合并短时间内多次焦点切换事件，避免重复触发检测
const FOCUS_CHECK_DEBOUNCE_MS = 1000
// Don't show the hint more than once per this interval
// 冷却时间（毫秒）：两次提示之间的最短间隔，防止频繁打扰用户
const HINT_COOLDOWN_MS = 30000

/**
 * Hook that shows a notification when the terminal regains focus
 * and the clipboard contains an image.
 *
 * 当终端从失焦状态重新获得焦点时，检查系统剪贴板是否含有图片内容。
 * 若含有图片，则在满足冷却条件后向用户推送一条包含粘贴快捷键的提示通知。
 *
 * 主要流程：
 *  1. 监听 isFocused 变化，仅在"失焦 → 聚焦"跳变时触发逻辑
 *  2. 防抖：等待 FOCUS_CHECK_DEBOUNCE_MS 毫秒，合并快速焦点变化
 *  3. 冷却：若上次提示距今不足 HINT_COOLDOWN_MS，则跳过
 *  4. 异步调用 hasImageInClipboard（底层使用 osascript）
 *  5. 检测到图片时调用 addNotification 推送提示
 *
 * @param isFocused - 终端当前是否处于聚焦状态
 * @param enabled - 图片粘贴功能是否已启用（即 onImagePaste 回调是否已定义）
 */
export function useClipboardImageHint(
  isFocused: boolean,
  enabled: boolean,
): void {
  // 从通知上下文中取出 addNotification 方法，用于后续推送通知
  const { addNotification } = useNotifications()
  // 记录上一次渲染时的焦点状态，用于检测"失焦 → 聚焦"的跳变
  const lastFocusedRef = useRef(isFocused)
  // 记录上一次展示提示的时间戳（毫秒），用于冷却判断
  const lastHintTimeRef = useRef(0)
  // 保存防抖定时器的引用，以便在必要时清除
  const checkTimeoutRef = useRef<NodeJS.Timeout | null>(null)

  useEffect(() => {
    // Only trigger on focus regain (was unfocused, now focused)
    // 读取上一次的焦点状态，并立即更新为当前状态
    const wasFocused = lastFocusedRef.current
    lastFocusedRef.current = isFocused

    // 若功能未启用、当前未聚焦、或上次已是聚焦状态（非跳变），则直接返回
    if (!enabled || !isFocused || wasFocused) {
      return
    }

    // Clear any pending check
    // 若存在待执行的防抖定时器，先清除，避免重复触发
    if (checkTimeoutRef.current) {
      clearTimeout(checkTimeoutRef.current)
    }

    // Small debounce to batch rapid focus changes
    // 设置防抖定时器，延迟执行剪贴板检测逻辑
    checkTimeoutRef.current = setTimeout(
      async (checkTimeoutRef, lastHintTimeRef, addNotification) => {
        // 定时器执行时清空自身引用
        checkTimeoutRef.current = null

        // Check cooldown to avoid spamming the user
        // 计算距上次提示的时间间隔，若未超过冷却时间则跳过
        const now = Date.now()
        if (now - lastHintTimeRef.current < HINT_COOLDOWN_MS) {
          return
        }

        // Check if clipboard has an image (async osascript call)
        // 异步检查剪贴板（macOS 通过 osascript 实现），若含图片则推送通知
        if (await hasImageInClipboard()) {
          // 更新上次提示时间戳，用于下次冷却判断
          lastHintTimeRef.current = now
          // 推送即时通知，显示粘贴快捷键提示，8 秒后自动消失
          addNotification({
            key: NOTIFICATION_KEY,
            text: `Image in clipboard · ${getShortcutDisplay('chat:imagePaste', 'Chat', 'ctrl+v')} to paste`,
            priority: 'immediate',
            timeoutMs: 8000,
          })
        }
      },
      FOCUS_CHECK_DEBOUNCE_MS,
      checkTimeoutRef,
      lastHintTimeRef,
      addNotification,
    )

    // 返回清理函数：组件卸载或依赖变化时清除挂起的定时器
    return () => {
      if (checkTimeoutRef.current) {
        clearTimeout(checkTimeoutRef.current)
        checkTimeoutRef.current = null
      }
    }
  }, [isFocused, enabled, addNotification])
}
