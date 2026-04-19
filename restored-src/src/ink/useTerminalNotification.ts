/**
 * 文件：useTerminalNotification.ts
 *
 * 【在 Claude Code 系统流程中的位置】
 * 本文件是 Ink 层的终端通知 React Hook，位于 UI 组件与底层终端 I/O 之间的接口层。
 * App.tsx 通过 TerminalWriteProvider 注入原始写入函数，各组件通过 useTerminalNotification
 * 获取结构化的通知 API，发送系统通知和进度报告给终端（iTerm2/Kitty/Ghostty 等）。
 *
 * 【主要功能】
 * - `TerminalWriteContext`：React Context，持有 WriteRaw 函数（直接写入终端 stdout）
 * - `TerminalWriteProvider`：Context Provider，由 App.tsx 在顶层注入
 * - `TerminalNotification` 类型：5 种通知操作的接口定义
 * - `useTerminalNotification()`：React Hook，返回 TerminalNotification 对象，包含：
 *   - `notifyITerm2`：OSC 9;N 格式，单次序列，标题/消息合并（iTerm2）
 *   - `notifyKitty`：三步 OSC 99 序列（title → body → 触发），支持通知 ID
 *   - `notifyGhostty`：OSC 777 四参数格式（Ghostty 专用）
 *   - `notifyBell`：发送原始 BEL 字节（tmux 铃声回退）
 *   - `progress`：OSC 9;4 进度报告（ConEmu/Ghostty/iTerm2），支持 set/clear/error/indeterminate
 */

import { createContext, useCallback, useContext, useMemo } from 'react'
import { isProgressReportingAvailable, type Progress } from './terminal.js'
import { BEL } from './termio/ansi.js'
import { ITERM2, OSC, osc, PROGRESS, wrapForMultiplexer } from './termio/osc.js'

/** 原始终端写入函数类型：将字符串直接写入终端 stdout */
type WriteRaw = (data: string) => void

/**
 * TerminalWriteContext：持有 WriteRaw 函数的 React Context。
 *
 * 初始值为 null，Consumer 端需检查非 null 状态；
 * 若在 Provider 外使用则抛出错误（见 useTerminalNotification）。
 */
export const TerminalWriteContext = createContext<WriteRaw | null>(null)

/**
 * TerminalWriteProvider：向子组件树注入 WriteRaw 函数的 Context Provider。
 *
 * App.tsx 在应用顶层使用，value 为绑定到实际 stdout 的写入函数。
 */
export const TerminalWriteProvider = TerminalWriteContext.Provider

/**
 * 终端通知操作接口。
 *
 * 每个成员对应一种终端的通知协议：
 * - notifyITerm2：iTerm2 原生通知（OSC 9;N）
 * - notifyKitty：Kitty 终端通知协议（OSC 99，三步序列）
 * - notifyGhostty：Ghostty 终端通知（OSC 777）
 * - notifyBell：通用响铃（BEL 0x07，兼容所有终端）
 * - progress：进度报告（OSC 9;4，ConEmu/Ghostty/iTerm2）
 */
export type TerminalNotification = {
  notifyITerm2: (opts: { message: string; title?: string }) => void
  notifyKitty: (opts: { message: string; title: string; id: number }) => void
  notifyGhostty: (opts: { message: string; title: string }) => void
  notifyBell: () => void
  /**
   * 通过 OSC 9;4 序列向终端报告进度。
   * 支持终端：ConEmu、Ghostty 1.2.0+、iTerm2 3.6.6+
   * 传 state=null 时清除进度显示。
   */
  progress: (state: Progress['state'] | null, percentage?: number) => void
}

/**
 * useTerminalNotification Hook：获取当前会话的终端通知 API。
 *
 * 【流程】
 * 1. 从 TerminalWriteContext 取出 writeRaw 函数；若未在 Provider 内则抛错
 * 2. 使用 useCallback 为每种通知方法创建稳定的回调引用（依赖 writeRaw）：
 *    - notifyITerm2：将 title+message 合并为 iTerm2 格式，经 wrapForMultiplexer 后写入
 *    - notifyKitty：发送三条 OSC 99 序列（d=0 标题 → d=0 正文 → d=1 触发聚焦）
 *    - notifyGhostty：发送 OSC 777 四参数格式（type=notify, title, message）
 *    - notifyBell：直接写入原始 BEL（不经多路复用，确保 tmux 铃声回退生效）
 *    - progress：检查可用性后，按 state 分发对应的 OSC 9;4 进度序列
 * 3. 使用 useMemo 将所有回调组合为稳定的 TerminalNotification 对象返回
 *
 * @returns TerminalNotification 对象（稳定引用）
 * @throws Error 若未在 TerminalWriteProvider 内使用
 */
export function useTerminalNotification(): TerminalNotification {
  const writeRaw = useContext(TerminalWriteContext)
  if (!writeRaw) {
    throw new Error(
      'useTerminalNotification must be used within TerminalWriteProvider',
    )
  }

  /**
   * iTerm2 通知（OSC 9;N）。
   *
   * 若提供 title，将其与 message 合并为 "title:\n\nmessage" 格式（iTerm2 约定）。
   * 序列经 wrapForMultiplexer 包裹，在 tmux/screen 环境中正确透传。
   */
  const notifyITerm2 = useCallback(
    ({ message, title }: { message: string; title?: string }) => {
      const displayString = title ? `${title}:\n${message}` : message
      writeRaw(wrapForMultiplexer(osc(OSC.ITERM2, `\n\n${displayString}`)))
    },
    [writeRaw],
  )

  /**
   * Kitty 通知（OSC 99，三步协议）。
   *
   * 步骤 1：发送 d=0（开始）+ p=title + 标题内容
   * 步骤 2：发送 d=0（继续）+ p=body + 正文内容
   * 步骤 3：发送 d=1（结束）+ a=focus（触发，点击通知时聚焦窗口）
   * id 参数用于关联多步序列（相同 id 的序列属于同一通知）。
   */
  const notifyKitty = useCallback(
    ({
      message,
      title,
      id,
    }: {
      message: string
      title: string
      id: number
    }) => {
      writeRaw(wrapForMultiplexer(osc(OSC.KITTY, `i=${id}:d=0:p=title`, title)))
      writeRaw(wrapForMultiplexer(osc(OSC.KITTY, `i=${id}:p=body`, message)))
      writeRaw(wrapForMultiplexer(osc(OSC.KITTY, `i=${id}:d=1:a=focus`, '')))
    },
    [writeRaw],
  )

  /**
   * Ghostty 通知（OSC 777）。
   *
   * Ghostty 使用四参数格式：type="notify"、title、message。
   * wrapForMultiplexer 确保在 tmux 中正确透传。
   */
  const notifyGhostty = useCallback(
    ({ message, title }: { message: string; title: string }) => {
      writeRaw(wrapForMultiplexer(osc(OSC.GHOSTTY, 'notify', title, message)))
    },
    [writeRaw],
  )

  /**
   * 原始 BEL 响铃通知（最广兼容性）。
   *
   * 直接写入 BEL 字节（0x07），不经过多路复用包裹。
   * 在 tmux 内，裸 BEL 会触发 tmux 的 bell-action（如窗口标记），
   * 而包裹为 DCS passthrough 会使其变为不透明载荷，失去铃声效果。
   */
  const notifyBell = useCallback(() => {
    // 裸 BEL —— 在 tmux 内触发 bell-action（窗口标记）；
    // 若包裹则变为 DCS 载荷，无法触发铃声回退
    writeRaw(BEL)
  }, [writeRaw])

  /**
   * 进度报告（OSC 9;4 系列，ConEmu/Ghostty/iTerm2 协议）。
   *
   * 【状态映射】
   * - null / completed：发送 PROGRESS.CLEAR（清除进度显示）
   * - error：发送 PROGRESS.ERROR + 百分比
   * - indeterminate：发送 PROGRESS.INDETERMINATE（不确定进度条）
   * - running：发送 PROGRESS.SET + 百分比（0–100，四舍五入并 clamp）
   *
   * 在不支持进度报告的终端中（isProgressReportingAvailable() 返回 false）直接跳过。
   */
  const progress = useCallback(
    (state: Progress['state'] | null, percentage?: number) => {
      // 不支持进度报告的终端直接返回
      if (!isProgressReportingAvailable()) {
        return
      }
      if (!state) {
        // state=null 或 falsy：清除进度显示
        writeRaw(
          wrapForMultiplexer(
            osc(OSC.ITERM2, ITERM2.PROGRESS, PROGRESS.CLEAR, ''),
          ),
        )
        return
      }
      // 将百分比 clamp 到 [0, 100] 并四舍五入
      const pct = Math.max(0, Math.min(100, Math.round(percentage ?? 0)))
      switch (state) {
        case 'completed':
          // 完成：清除进度条
          writeRaw(
            wrapForMultiplexer(
              osc(OSC.ITERM2, ITERM2.PROGRESS, PROGRESS.CLEAR, ''),
            ),
          )
          break
        case 'error':
          // 错误：显示红色错误进度条（带百分比）
          writeRaw(
            wrapForMultiplexer(
              osc(OSC.ITERM2, ITERM2.PROGRESS, PROGRESS.ERROR, pct),
            ),
          )
          break
        case 'indeterminate':
          // 不确定：显示动画进度条（无百分比）
          writeRaw(
            wrapForMultiplexer(
              osc(OSC.ITERM2, ITERM2.PROGRESS, PROGRESS.INDETERMINATE, ''),
            ),
          )
          break
        case 'running':
          // 运行中：显示百分比进度条
          writeRaw(
            wrapForMultiplexer(
              osc(OSC.ITERM2, ITERM2.PROGRESS, PROGRESS.SET, pct),
            ),
          )
          break
        case null:
          // 由上方 if (!state) 已处理，此处不会到达
          break
      }
    },
    [writeRaw],
  )

  // 使用 useMemo 将所有稳定回调组合为单一对象，避免不必要的重新渲染
  return useMemo(
    () => ({ notifyITerm2, notifyKitty, notifyGhostty, notifyBell, progress }),
    [notifyITerm2, notifyKitty, notifyGhostty, notifyBell, progress],
  )
}
