/**
 * 应用程序上下文（AppContext）
 *
 * 【在 Claude Code / Ink 系统中的位置】
 * 本文件处于 Ink React 组件树的"顶层上下文"层：
 *   Ink 渲染根（ink.tsx）→ AppContext.Provider → 所有子组件（通过 useApp() hook 消费）
 *
 * 【主要功能】
 * 提供一个 React Context，向整个组件树暴露 `exit` 方法，
 * 允许任意深度的子组件主动触发整个 Ink 应用的卸载（unmount）。
 * 等同于浏览器应用中的"关闭当前页面/标签页"操作。
 *
 * 【使用方式】
 * 组件通过 useApp() hook（位于 hooks/use-app.ts）消费此 context，
 * 调用 exit(error?) 可以优雅退出应用，可选地传入错误对象。
 */
import { createContext } from 'react'

// AppContext 提供的 Props 类型定义
export type Props = {
  /**
   * 退出（卸载）整个 Ink 应用的方法。
   * 可选传入一个 Error 对象，表示异常退出（错误会被向上抛出给调用者）。
   */
  readonly exit: (error?: Error) => void
}

/**
 * AppContext：React 上下文对象，向组件树暴露应用级退出方法。
 *
 * 默认值为空操作（no-op），确保在没有 Provider 的环境下调用不会报错。
 * 实际的 exit 实现由 Ink 渲染根（ink.tsx）在 Provider 中注入。
 */
// eslint-disable-next-line @typescript-eslint/naming-convention
const AppContext = createContext<Props>({
  exit() {},  // 默认实现为空操作，由 Provider 覆盖为真实的退出逻辑
})

// 设置 displayName 便于在 React DevTools 中识别此 Context
// eslint-disable-next-line custom-rules/no-top-level-side-effects
AppContext.displayName = 'InternalAppContext'

export default AppContext
