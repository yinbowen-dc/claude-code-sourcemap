/**
 * @file hooks/use-terminal-title.ts
 * 终端窗口/标签页标题设置 Hook
 *
 * 在 Claude Code 的 Ink 终端集成体系中，本文件处于终端扩展功能层：
 *   应用状态/上下文（如当前工作目录、任务名称）
 *   → 【本文件：useTerminalTitle 声明式地控制终端窗口和标签页标题】
 *   → OSC 0 序列写入 stdout / process.title（Windows）
 *   → 终端标题栏/标签页显示对应文字
 *
 * 核心功能：
 *  - 跨平台：Unix 使用 OSC 0（设置标题+图标名），Windows 使用 process.title
 *  - 自动剥离 ANSI 转义序列，确保标题文字干净
 *  - 支持 null 参数优雅退出（no-op），避免强制设置标题
 */

import { useContext, useEffect } from 'react'
import stripAnsi from 'strip-ansi'
import { OSC, osc } from '../termio/osc.js'
import { TerminalWriteContext } from '../useTerminalNotification.js'

/**
 * 声明式设置终端窗口/标签页标题的 React Hook。
 *
 * 流程：
 *  1. 通过 TerminalWriteContext 获取原始写入函数（直接写 stdout，绕过 Ink diff）
 *  2. title 或 writeRaw 变化时执行 effect：
 *     - title=null 或 writeRaw 不可用：no-op，不修改标题
 *     - 否则：先用 stripAnsi 清理 ANSI 序列
 *     - Windows（win32）：赋值 process.title（conhost 不支持 OSC）
 *     - 其他平台：通过 OSC.SET_TITLE_AND_ICON 写入 OSC 0 序列
 *
 * @param title - 目标标题字符串，传 null 则 hook 变为 no-op
 */
export function useTerminalTitle(title: string | null): void {
  // 获取终端原始写入函数（直接写 stdout，不经过帧缓冲）
  const writeRaw = useContext(TerminalWriteContext)

  useEffect(() => {
    // null 表示不设置标题；writeRaw 不可用时跳过
    if (title === null || !writeRaw) return

    // 剥离标题中可能包含的 ANSI 转义序列，确保标题文字纯净
    const clean = stripAnsi(title)

    if (process.platform === 'win32') {
      // Windows 控制台（conhost）不支持 OSC，直接修改 process.title
      process.title = clean
    } else {
      // 其他平台使用 OSC 0（同时设置窗口标题和图标名）
      writeRaw(osc(OSC.SET_TITLE_AND_ICON, clean))
    }
  }, [title, writeRaw])
}
