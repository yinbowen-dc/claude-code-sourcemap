/**
 * @file hooks/use-tab-status.ts
 * @description 声明式终端标签页状态指示器 Hook（OSC 21337 协议）。
 *
 * 在 Claude Code 的 Ink 渲染流水线中，本文件属于「终端元信息写入」层：
 *   组件（声明状态） → useTabStatus（本文件） → OSC 21337 转义序列 → 终端 tab 侧边栏
 *
 * 主要职责：
 *  - 根据传入的 kind（'idle' | 'busy' | 'waiting' | null），
 *    向支持 OSC 21337 的终端（如 iTerm2）发送彩色圆点 + 状态文字。
 *  - 不支持 OSC 21337 的终端会静默忽略该序列，可无条件调用。
 *  - kind 从非 null 变为 null 时，发送 CLEAR_TAB_STATUS 清除残留指示器。
 *  - 自动为 tmux/screen 等终端复用器包装转义序列（DCS passthrough）。
 *
 * 状态预设颜色（遵循 OSC 21337 使用指南推荐映射）：
 *  - idle    : 绿色圆点（0, 215, 95） + 灰色「Idle」文字
 *  - busy    : 橙色圆点（255, 149, 0）+ 橙色「Working…」文字
 *  - waiting : 蓝色圆点（95, 135, 255）+ 蓝色「Waiting」文字
 */

import { useContext, useEffect, useRef } from 'react'
import {
  CLEAR_TAB_STATUS,
  supportsTabStatus,
  tabStatus,
  wrapForMultiplexer,
} from '../termio/osc.js'
import type { Color } from '../termio/types.js'
import { TerminalWriteContext } from '../useTerminalNotification.js'

/** 标签页状态的枚举类型 */
export type TabStatusKind = 'idle' | 'busy' | 'waiting'

/** 构建 RGB 颜色对象的便捷工厂函数 */
const rgb = (r: number, g: number, b: number): Color => ({
  type: 'rgb',
  r,
  g,
  b,
})

// 遵循 OSC 21337 使用指南的推荐颜色映射
const TAB_STATUS_PRESETS: Record<
  TabStatusKind,
  { indicator: Color; status: string; statusColor: Color }
> = {
  idle: {
    indicator: rgb(0, 215, 95),    // 绿色圆点：空闲
    status: 'Idle',
    statusColor: rgb(136, 136, 136), // 灰色文字
  },
  busy: {
    indicator: rgb(255, 149, 0),   // 橙色圆点：正在处理
    status: 'Working…',
    statusColor: rgb(255, 149, 0),  // 橙色文字
  },
  waiting: {
    indicator: rgb(95, 135, 255),  // 蓝色圆点：等待用户输入
    status: 'Waiting',
    statusColor: rgb(95, 135, 255), // 蓝色文字
  },
}

/**
 * 声明式设置终端标签页状态指示器（OSC 21337）。
 *
 * 流程：
 *  1. 从 TerminalWriteContext 获取底层写入函数（由 Ink 核心注入）。
 *  2. 用 ref 追踪上次设置的 kind，以便在 kind 变为 null 时知道是否需要清除。
 *  3. 每次 kind 变化时：
 *     - kind 为 null：若上次非 null 且终端支持，发送 CLEAR_TAB_STATUS 清除圆点。
 *     - kind 非 null：若终端支持，发送对应预设的 tabStatus 序列。
 *  4. 所有序列均经过 wrapForMultiplexer 包装，支持 tmux/screen 透传。
 *
 * 注意：进程退出时的清理由 ink.tsx 的卸载路径统一处理，此 Hook 不重复注册 process.exit 监听。
 *
 * @param kind 标签页状态类型，传 null 则退出（如用户关闭了相关功能开关）
 */
export function useTabStatus(kind: TabStatusKind | null): void {
  // 从上下文获取底层终端写入函数
  const writeRaw = useContext(TerminalWriteContext)
  // 记录上次的 kind，用于判断 null 转换时是否需要清除
  const prevKindRef = useRef<TabStatusKind | null>(null)

  useEffect(() => {
    // kind 从非 null 变为 null（用户中途关闭 showStatusInTerminalTab）
    if (kind === null) {
      if (prevKindRef.current !== null && writeRaw && supportsTabStatus()) {
        // 发送清除指令，移除终端 tab 侧边栏中残留的状态圆点
        writeRaw(wrapForMultiplexer(CLEAR_TAB_STATUS))
      }
      prevKindRef.current = null
      return
    }

    // 更新上次 kind 记录
    prevKindRef.current = kind
    // 终端不支持 OSC 21337 或写入函数不可用时，静默跳过
    if (!writeRaw || !supportsTabStatus()) return
    // 发送对应预设的状态序列（含 tmux/screen 复用器包装）
    writeRaw(wrapForMultiplexer(tabStatus(TAB_STATUS_PRESETS[kind])))
  }, [kind, writeRaw])
}
