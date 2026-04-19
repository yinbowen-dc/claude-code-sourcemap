/**
 * 终端窗口焦点事件类（Terminal Window Focus Event）
 *
 * 【在 Claude Code / Ink 系统中的位置】
 * 本文件处于 Ink 事件系统层，处理终端窗口本身（而非组件）的焦点变化事件。
 * 与 FocusEvent（组件间焦点转移）不同，TerminalFocusEvent 表示整个终端窗口
 * 的焦点状态变化——即用户切换到其他应用程序窗口或返回终端时触发。
 *
 * 【DECSET 1004 协议】
 * 通过向终端发送 ESC[?1004h 启用焦点报告模式后，终端会在：
 * - 获得焦点时发送 CSI I（\x1b[I）→ 触发 'terminalfocus' 事件
 * - 失去焦点时发送 CSI O（\x1b[O）→ 触发 'terminalblur' 事件
 * 组件可通过 StdinContext 的事件总线监听这些事件，实现窗口焦点感知功能。
 *
 * 【与 FocusEvent 的区别】
 * - FocusEvent：组件焦点变化（Tab 键切换、点击等），通过 DOM 捕获/冒泡分发
 * - TerminalFocusEvent：终端窗口焦点变化（用户切换应用程序），通过 EventEmitter 总线分发
 */
import { Event } from './event.js'

/** 终端窗口焦点事件的类型字符串 */
export type TerminalFocusEventType = 'terminalfocus' | 'terminalblur'

/**
 * 终端窗口获得或失去焦点时触发的事件。
 *
 * 使用 DECSET 1004 焦点报告协议——终端会发送：
 * - CSI I（\x1b[I）：终端窗口获得焦点 → 类型为 'terminalfocus'
 * - CSI O（\x1b[O）：终端窗口失去焦点 → 类型为 'terminalblur'
 *
 * 直接继承 Event（而非 TerminalEvent），因为不需要 DOM 捕获/冒泡语义，
 * 仅通过 EventEmitter 总线进行简单的事件广播。
 */
export class TerminalFocusEvent extends Event {
  /** 事件类型：'terminalfocus' 表示获得焦点，'terminalblur' 表示失去焦点 */
  readonly type: TerminalFocusEventType

  /**
   * 创建一个终端窗口焦点事件。
   *
   * @param type - 'terminalfocus'（获得焦点）或 'terminalblur'（失去焦点）
   */
  constructor(type: TerminalFocusEventType) {
    super()
    this.type = type
  }
}
