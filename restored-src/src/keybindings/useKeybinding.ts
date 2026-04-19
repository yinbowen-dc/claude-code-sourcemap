/**
 * 键位绑定 React Hook 模块
 *
 * 【在 Claude Code 键位绑定系统中的位置与作用】
 * 本文件是键位绑定系统的"React 集成层"，提供两个 Hook，
 * 将 Ink 的底层按键输入事件桥接到应用的业务逻辑：
 *
 *   loadUserBindings（加载绑定列表）
 *   resolver（按键 → 动作裁决）
 *     → useKeybinding / useKeybindings（本文件，React Hook 层）
 *       ← 各 UI 组件通过这两个 Hook 注册快捷键处理函数
 *
 * 核心导出：
 *  - useKeybinding(action, handler, options)：
 *    为单个动作注册处理函数，支持和弦序列（如 "ctrl+k ctrl+s"）
 *  - useKeybindings(handlers, options)：
 *    为多个动作批量注册处理函数（减少 useInput 调用次数，提升性能）
 *
 * 设计要点：
 *  - 处理函数返回 false 表示"事件未消费"，允许事件向下传播给后续 Handler
 *  - 和弦状态通过 KeybindingContext.setPendingChord() 跨 Hook 共享
 *  - 使用 stopImmediatePropagation() 阻止同一按键被多个 Handler 重复处理
 */

/**
 * 键位绑定 React Hook 模块
 *
 * 【在 Claude Code 键位绑定系统中的位置与作用】
 * 本文件是键位绑定系统的"React 集成层"，提供两个 Hook，
 * 将 Ink 的底层按键输入事件桥接到应用的业务逻辑：
 *
 *   loadUserBindings（加载绑定列表）
 *   resolver（按键 → 动作裁决）
 *     → useKeybinding / useKeybindings（本文件，React Hook 层）
 *       ← 各 UI 组件通过这两个 Hook 注册快捷键处理函数
 *
 * 核心导出：
 *  - useKeybinding(action, handler, options)：
 *    为单个动作注册处理函数，支持和弦序列（如 "ctrl+k ctrl+s"）
 *  - useKeybindings(handlers, options)：
 *    为多个动作批量注册处理函数（减少 useInput 调用次数，提升性能）
 *
 * 设计要点：
 *  - 处理函数返回 false 表示"事件未消费"，允许事件向下传播给后续 Handler
 *  - 和弦状态通过 KeybindingContext.setPendingChord() 跨 Hook 共享
 *  - 使用 stopImmediatePropagation() 阻止同一按键被多个 Handler 重复处理
 */

import { useCallback, useEffect } from 'react'
import type { InputEvent } from '../ink/events/input-event.js'
import { type Key, useInput } from '../ink.js'
import { useOptionalKeybindingContext } from './KeybindingContext.js'
import type { KeybindingContextName } from './types.js'

type Options = {
  /** Which context this binding belongs to (default: 'Global') */
  context?: KeybindingContextName
  /** Only handle when active (like useInput's isActive) */
  isActive?: boolean
}

/**
 * Ink-native hook for handling a keybinding.
 *
 * The handler stays in the component (React way).
 * The binding (keystroke → action) comes from config.
 *
 * Supports chord sequences (e.g., "ctrl+k ctrl+s"). When a chord is started,
 * the hook will manage the pending state automatically.
 *
 * Uses stopImmediatePropagation() to prevent other handlers from firing
 * once this binding is handled.
 *
 * @example
 * ```tsx
 * useKeybinding('app:toggleTodos', () => {
 *   setShowTodos(prev => !prev)
 * }, { context: 'Global' })
 * ```
 */
export function useKeybinding(
  action: string,
  handler: () => void | false | Promise<void>,
  options: Options = {},
): void {
  const { context = 'Global', isActive = true } = options
  const keybindingContext = useOptionalKeybindingContext()

  // Register handler with the context for ChordInterceptor to invoke
  useEffect(() => {
    if (!keybindingContext || !isActive) return
    return keybindingContext.registerHandler({ action, context, handler })
  }, [action, context, handler, keybindingContext, isActive])

  const handleInput = useCallback(
    (input: string, key: Key, event: InputEvent) => {
      // If no keybinding context available, skip resolution
      if (!keybindingContext) return

      // Build context list: registered active contexts + this context + Global
      // More specific contexts (registered ones) take precedence over Global
      const contextsToCheck: KeybindingContextName[] = [
        ...keybindingContext.activeContexts,
        context,
        'Global',
      ]
      // Deduplicate while preserving order (first occurrence wins for priority)
      const uniqueContexts = [...new Set(contextsToCheck)]

      const result = keybindingContext.resolve(input, key, uniqueContexts)

      switch (result.type) {
        case 'match':
          // Chord completed (if any) - clear pending state
          keybindingContext.setPendingChord(null)
          if (result.action === action) {
            if (handler() !== false) {
              event.stopImmediatePropagation()
            }
          }
          break
        case 'chord_started':
          // User started a chord sequence - update pending state
          keybindingContext.setPendingChord(result.pending)
          event.stopImmediatePropagation()
          break
        case 'chord_cancelled':
          // Chord was cancelled (escape or invalid key)
          keybindingContext.setPendingChord(null)
          break
        case 'unbound':
          // Explicitly unbound - clear any pending chord
          keybindingContext.setPendingChord(null)
          event.stopImmediatePropagation()
          break
        case 'none':
          // No match - let other handlers try
          break
      }
    },
    [action, context, handler, keybindingContext],
  )

  useInput(handleInput, { isActive })
}

/**
 * Handle multiple keybindings in one hook (reduces useInput calls).
 *
 * Supports chord sequences. When a chord is started, the hook will
 * manage the pending state automatically.
 *
 * @example
 * ```tsx
 * useKeybindings({
 *   'chat:submit': () => handleSubmit(),
 *   'chat:cancel': () => handleCancel(),
 * }, { context: 'Chat' })
 * ```
 */
export function useKeybindings(
  // Handler returning `false` means "not consumed" — the event propagates
  // to later useInput/useKeybindings handlers. Useful for fall-through:
  // e.g. ScrollKeybindingHandler's scroll:line* returns false when the
  // ScrollBox content fits (scroll is a no-op), letting a child component's
  // handler take the wheel event for list navigation instead. Promise<void>
  // is allowed for fire-and-forget async handlers (the `!== false` check
  // only skips propagation for a sync `false`, not a pending Promise).
  handlers: Record<string, () => void | false | Promise<void>>,
  options: Options = {},
): void {
  const { context = 'Global', isActive = true } = options
  const keybindingContext = useOptionalKeybindingContext()

  // Register all handlers with the context for ChordInterceptor to invoke
  useEffect(() => {
    if (!keybindingContext || !isActive) return

    const unregisterFns: Array<() => void> = []
    for (const [action, handler] of Object.entries(handlers)) {
      unregisterFns.push(
        keybindingContext.registerHandler({ action, context, handler }),
      )
    }

    return () => {
      for (const unregister of unregisterFns) {
        unregister()
      }
    }
  }, [context, handlers, keybindingContext, isActive])

  const handleInput = useCallback(
    (input: string, key: Key, event: InputEvent) => {
      // If no keybinding context available, skip resolution
      if (!keybindingContext) return

      // Build context list: registered active contexts + this context + Global
      // More specific contexts (registered ones) take precedence over Global
      const contextsToCheck: KeybindingContextName[] = [
        ...keybindingContext.activeContexts,
        context,
        'Global',
      ]
      // Deduplicate while preserving order (first occurrence wins for priority)
      const uniqueContexts = [...new Set(contextsToCheck)]

      const result = keybindingContext.resolve(input, key, uniqueContexts)

      switch (result.type) {
        case 'match':
          // Chord completed (if any) - clear pending state
          keybindingContext.setPendingChord(null)
          if (result.action in handlers) {
            const handler = handlers[result.action]
            if (handler && handler() !== false) {
              event.stopImmediatePropagation()
            }
          }
          break
        case 'chord_started':
          // User started a chord sequence - update pending state
          keybindingContext.setPendingChord(result.pending)
          event.stopImmediatePropagation()
          break
        case 'chord_cancelled':
          // Chord was cancelled (escape or invalid key)
          keybindingContext.setPendingChord(null)
          break
        case 'unbound':
          // Explicitly unbound - clear any pending chord
          keybindingContext.setPendingChord(null)
          event.stopImmediatePropagation()
          break
        case 'none':
          // No match - let other handlers try
          break
      }
    },
    [context, handlers, keybindingContext],
  )

  useInput(handleInput, { isActive })
}
