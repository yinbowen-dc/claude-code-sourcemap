/**
 * @file hooks/use-stdin.ts
 * 终端标准输入流上下文访问 Hook
 *
 * 在 Claude Code 的 Ink 输入流水线中，本文件处于最基础的输入接入层：
 *   Node.js process.stdin（或自定义 stdin）
 *   → StdinContext（由 App 根组件通过 Provider 注入）
 *   → 【本文件：useStdin 封装 useContext(StdinContext)】
 *   → useInput / useSearchHighlight 等上层 hook
 *
 * StdinContext 的内容包括：
 *  - stdin：原始 Readable 流
 *  - setRawMode：切换终端 raw/cooked 模式
 *  - internal_exitOnCtrlC：是否在 Ctrl+C 时自动退出
 *  - internal_eventEmitter：输入事件 EventEmitter（分发 'input' 事件）
 *
 * 本文件是 Ink 公开 API 的一部分，组件可通过 useStdin() 直接访问 stdin 流。
 */

import { useContext } from 'react'
import StdinContext from '../components/StdinContext.js'

/**
 * 访问 Ink stdin 流上下文的 React Hook。
 *
 * 直接委托给 useContext(StdinContext)，返回 StdinContext 的完整值。
 * 常用于需要直接监听 stdin 流事件或切换 raw mode 的场景。
 *
 * @returns StdinContext 值（含 stdin 流、setRawMode、内部事件总线等）
 */
const useStdin = () => useContext(StdinContext)
export default useStdin
