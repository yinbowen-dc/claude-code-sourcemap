/**
 * @file hooks/use-app.ts
 * @description 暴露 Ink 应用全局控制接口的 React Hook。
 *
 * 在 Claude Code 的 Ink 渲染流水线中，本文件属于「应用生命周期」层：
 *   AppContext（由顶层 App 组件提供） → useApp（本文件） → 组件调用 exit() 卸载应用
 *
 * 主要职责：
 *  - 通过 React Context 将 AppContext 中的接口（如 exit 方法）暴露给任意子组件，
 *    使子组件无需感知 Ink 的内部结构即可主动退出整个 CLI 应用。
 *
 * 典型用法：
 *   const { exit } = useApp()
 *   // 用户按下 q 时退出
 *   useInput((input) => { if (input === 'q') exit() })
 */

import { useContext } from 'react'
import AppContext from '../components/AppContext.js'

/**
 * 返回 AppContext 上下文值，提供手动退出（卸载）应用的能力。
 *
 * 直接代理 useContext(AppContext)，保持与标准 React Context 一致的使用方式。
 * AppContext 由 Ink 的顶层 App 组件注入，包含：
 *  - exit(error?: Error): 卸载整个 Ink 应用，可选传入错误对象以非零状态退出。
 */
const useApp = () => useContext(AppContext)
export default useApp
