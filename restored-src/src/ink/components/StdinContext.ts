/**
 * StdinContext —— Ink 标准输入流 React Context
 *
 * 【在 Claude Code 系统中的位置】
 * 位于 Ink 自定义渲染层的组件上下文层，是用户输入处理的核心入口。
 * 由根渲染组件（ink.tsx）创建并提供，封装了 stdin 流及其相关能力。
 * 子组件（如键盘输入 hook useInput）通过消费此 Context 来监听和处理
 * 用户的键盘输入，而无需直接访问 process.stdin。
 *
 * 【主要功能】
 * 1. 提供 stdin 流引用，供组件监听原始输入数据
 * 2. 提供 setRawMode()：安全地切换终端原始模式（绕过行编辑器，逐字符读取）
 * 3. 提供 isRawModeSupported：标识当前环境是否支持原始模式
 * 4. 提供 internal_eventEmitter：Ink 内部事件总线，用于分发 keypress 等事件
 * 5. 提供 internal_querier：终端能力查询器，用于 DECRQM/OSC 11 等协议查询
 * 6. 提供 internal_exitOnCtrlC：控制 Ctrl+C 是否触发退出
 *
 * 【setRawMode 的特殊性】
 * Ink 通过 StdinContext 提供自己的 setRawMode 而非直接暴露 process.stdin.setRawMode，
 * 原因是 Ink 需要在 setRawMode(true) 时拦截 Ctrl+C（若 exitOnCtrlC 为 true），
 * 直接调用 process.stdin.setRawMode 会绕过此机制。
 */
import { createContext } from 'react'
import { EventEmitter } from '../events/emitter.js'
import type { TerminalQuerier } from '../terminal-querier.js'

/** StdinContext 向消费者暴露的 Props 类型 */
export type Props = {
  /**
   * 传入 render() 的 stdin 流（options.stdin），默认为 process.stdin。
   * 组件可通过监听此流来处理用户输入。
   */
  readonly stdin: NodeJS.ReadStream

  /**
   * Ink 封装的 setRawMode 方法。
   * 应使用此方法而非直接调用 process.stdin.setRawMode，
   * 以确保 Ink 能正确处理 Ctrl+C 拦截逻辑。
   * 若传入的 stdin 流不支持 setRawMode，此函数为空操作。
   */
  readonly setRawMode: (value: boolean) => void

  /**
   * 标识当前 stdin 流是否支持 setRawMode。
   * 组件可据此在不支持原始模式的环境中优雅降级。
   */
  readonly isRawModeSupported: boolean

  /** 是否在 Ctrl+C 时自动退出应用（内部配置项） */
  readonly internal_exitOnCtrlC: boolean

  /** Ink 内部事件总线，用于在组件间分发 keypress、resize 等事件（内部使用） */
  readonly internal_eventEmitter: EventEmitter

  /**
   * 终端能力查询器，用于发送 DECRQM、OSC 11 等协议请求并等待终端响应。
   * 仅在未到达的默认 Context 值中为 null，实际使用时始终有效。
   */
  readonly internal_querier: TerminalQuerier | null
}

/**
 * `StdinContext` 是一个 React Context，向组件树暴露输入流及相关控制接口。
 *
 * 默认值使用 process.stdin 和空操作函数，确保在未被 Provider 包裹时不会崩溃。
 * 实际值由 ink.tsx 中的根渲染组件通过 StdinContext.Provider 注入。
 */
const StdinContext = createContext<Props>({
  stdin: process.stdin,  // 默认使用进程标准输入流

  internal_eventEmitter: new EventEmitter(),  // 默认创建一个空的事件总线
  setRawMode() {},           // 默认空操作
  isRawModeSupported: false, // 默认不支持原始模式

  internal_exitOnCtrlC: true,  // 默认 Ctrl+C 退出
  internal_querier: null,       // 默认无查询器
})

// 设置 displayName 以便在 React DevTools 和错误信息中识别此 Context
// eslint-disable-next-line custom-rules/no-top-level-side-effects
StdinContext.displayName = 'InternalStdinContext'

export default StdinContext
