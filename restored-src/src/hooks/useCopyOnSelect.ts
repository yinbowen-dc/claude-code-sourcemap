/**
 * useCopyOnSelect.ts
 *
 * 【在 Claude Code 系统中的位置】
 * 位于 UI 层的 hooks 目录下，属于终端文本选择交互模块。
 * 在 Claude Code 的全屏 REPL（交互式命令行界面）和 FleetView 中使用，
 * 为 alt-screen 模式下的文本选择提供"选中即复制"功能，
 * 并将选择区域的背景颜色与主题系统同步。
 *
 * 【主要功能】
 * - useCopyOnSelect：监听 ink selection 状态，在用户完成鼠标拖拽选择或多击选择后
 *   自动将选中文本写入系统剪贴板，模拟 iTerm2 的"Copy to pasteboard on selection"行为
 * - useSelectionBgColor：将当前主题的选择背景色注入 Ink 的 StylePool，
 *   使选择高亮颜色随主题切换实时更新
 */

import { useEffect, useRef } from 'react'
import { useTheme } from '../components/design-system/ThemeProvider.js'
import type { useSelection } from '../ink/hooks/use-selection.js'
import { getGlobalConfig } from '../utils/config.js'
import { getTheme } from '../utils/theme.js'

// 从 useSelection hook 的返回类型中提取 Selection 类型定义
type Selection = ReturnType<typeof useSelection>

/**
 * Auto-copy the selection to the clipboard when the user finishes dragging
 * (mouse-up with a non-empty selection) or multi-clicks to select a word/line.
 * Mirrors iTerm2's "Copy to pasteboard on selection" — the highlight is left
 * intact so the user can see what was copied. Only fires in alt-screen mode
 * (selection state is ink-instance-owned; outside alt-screen, the native
 * terminal handles selection and this hook is a no-op via the ink stub).
 *
 * selection.subscribe fires on every mutation (start/update/finish/clear/
 * multiclick). Both char drags and multi-clicks set isDragging=true while
 * pressed, so a selection appearing with isDragging=false is always a
 * drag-finish. copiedRef guards against double-firing on spurious notifies.
 *
 * onCopied is optional — when omitted, copy is silent (clipboard is written
 * but no toast/notification fires). FleetView uses this silent mode; the
 * fullscreen REPL passes showCopiedToast for user feedback.
 *
 * 【功能说明】
 * 订阅 ink selection 状态变更，在拖拽结束或多击选择完成后自动复制选中内容到剪贴板。
 * - copiedRef 防止同一次选择触发两次复制（finish → clear 状态转换时的误触发）
 * - onCopiedRef 通过 ref 引用回调，避免 effect 因闭包重新订阅而重置状态
 * - 仅在 copyOnSelect 全局配置为 true 时执行复制（默认开启）
 */
export function useCopyOnSelect(
  selection: Selection,
  isActive: boolean,
  onCopied?: (text: string) => void,
): void {
  // Tracks whether the *previous* notification had a visible selection with
  // isDragging=false (i.e., we already auto-copied it). Without this, the
  // finish→clear transition would look like a fresh selection-gone-idle
  // event and we'd toast twice for a single drag.
  // 标记当前选区是否已经完成过自动复制，防止同一次拖拽触发两次复制操作
  const copiedRef = useRef(false)
  // onCopied is a fresh closure each render; read through a ref so the
  // effect doesn't re-subscribe (which would reset copiedRef via unmount).
  // 通过 ref 持有 onCopied 回调，避免因 onCopied 闭包更新导致 effect 重新订阅（会重置 copiedRef）
  const onCopiedRef = useRef(onCopied)
  // 每次渲染时同步最新的 onCopied 引用到 ref
  onCopiedRef.current = onCopied

  useEffect(() => {
    // 若 hook 当前非激活状态（如组件不在焦点中），直接返回不订阅
    if (!isActive) return

    // 订阅 selection 状态变更，返回取消订阅函数
    const unsubscribe = selection.subscribe(() => {
      const sel = selection.getState()
      const has = selection.hasSelection()
      // Drag in progress — wait for finish. Reset copied flag so a new drag
      // that ends on the same range still triggers a fresh copy.
      // 拖拽进行中：重置 copiedRef 以便拖拽结束后触发新一轮复制，然后等待拖拽结束
      if (sel?.isDragging) {
        copiedRef.current = false
        return
      }
      // No selection (cleared, or click-without-drag) — reset.
      // 无选区（已清除或单击无拖拽）：重置 copiedRef 状态
      if (!has) {
        copiedRef.current = false
        return
      }
      // Selection settled (drag finished OR multi-click). Already copied
      // this one — the only way to get here again without going through
      // isDragging or !has is a spurious notify (shouldn't happen, but safe).
      // 选区已稳定（拖拽结束或多击选择），但已经复制过，防止重复复制（防御性检查）
      if (copiedRef.current) return

      // Default true: macOS users expect cmd+c to work. It can't — the
      // terminal's Edit > Copy intercepts it before the pty sees it, and
      // finds no native selection (mouse tracking disabled it). Auto-copy
      // on mouse-up makes cmd+c a no-op that leaves the clipboard intact
      // with the right content, so paste works as expected.
      // 读取全局配置中的 copyOnSelect 开关，默认为 true（macOS 用户期望 cmd+c 可用）
      const enabled = getGlobalConfig().copyOnSelect ?? true
      if (!enabled) return

      // 将当前选区内容复制到剪贴板，不清除选区高亮（用户仍可看到选中内容）
      const text = selection.copySelectionNoClear()
      // Whitespace-only (e.g., blank-line multi-click) — not worth a
      // clipboard write or toast. Still set copiedRef so we don't retry.
      // 纯空白内容（如空行多击）：不值得写入剪贴板或弹出通知，但标记为已处理
      if (!text || !text.trim()) {
        copiedRef.current = true
        return
      }
      // 标记本次选区已完成复制
      copiedRef.current = true
      // 若提供了 onCopied 回调（如显示复制成功 toast），则调用它
      onCopiedRef.current?.(text)
    })
    // 返回取消订阅函数作为 effect 清理逻辑
    return unsubscribe
  }, [isActive, selection])
}

/**
 * Pipe the theme's selectionBg color into the Ink StylePool so the
 * selection overlay renders a solid blue bg instead of SGR-7 inverse.
 * Ink is theme-agnostic (layering: colorize.ts "theme resolution happens
 * at component layer, not here") — this is the bridge. Fires on mount
 * (before any mouse input is possible) and again whenever /theme flips,
 * so the selection color tracks the theme live.
 *
 * 【功能说明】
 * 将当前主题的选区背景色注入 Ink 的 StylePool，
 * 使选区高亮使用主题定义的颜色（而非终端默认的 SGR-7 反色）。
 * 在组件挂载时立即执行（鼠标输入发生前），并在主题切换时重新执行，
 * 确保选区颜色与当前主题实时同步。
 */
export function useSelectionBgColor(selection: Selection): void {
  // 从主题上下文中获取当前主题名称
  const [themeName] = useTheme()
  useEffect(() => {
    // 根据主题名称获取主题对象，并将 selectionBg 颜色注入 selection 的样式池
    selection.setSelectionBgColor(getTheme(themeName).selectionBg)
  }, [selection, themeName])
}
