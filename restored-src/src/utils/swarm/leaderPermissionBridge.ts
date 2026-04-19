/**
 * 领导者权限桥接模块
 *
 * 在 Claude Code 系统流程中的位置：
 * 该模块是 Swarm 多智能体系统中 in-process teammate 权限请求流程的关键桥接层。
 * 当 in-process teammate 需要请求工具使用权限时，它不能直接访问领导者 REPL 的
 * React 状态（setToolUseConfirmQueue / setToolPermissionContext），
 * 因为这些是 React 组件内的状态更新函数，无法在非 React 代码中直接引用。
 *
 * 解决方案：模块级单例桥接（Singleton Bridge 模式）
 * - 领导者的 REPL React 组件在挂载时通过 register 函数注册 setter
 * - in-process runner（inProcessRunner.ts）在需要权限时通过 get 函数获取 setter
 * - 领导者卸载时通过 unregister 函数清除注册
 *
 * 两个桥接通道：
 * 1. ToolUseConfirmQueue：用于显示标准工具使用确认对话框（ToolUseConfirm）
 * 2. ToolPermissionContext：用于更新工具权限上下文（如切换到 ask 模式）
 *
 * 主要导出：
 * - registerLeaderToolUseConfirmQueue / getLeaderToolUseConfirmQueue / unregisterLeaderToolUseConfirmQueue
 * - registerLeaderSetToolPermissionContext / getLeaderSetToolPermissionContext / unregisterLeaderSetToolPermissionContext
 */

import type { ToolUseConfirm } from '../../components/permissions/PermissionRequest.js'
import type { ToolPermissionContext } from '../../Tool.js'

// ─── 类型定义 ─────────────────────────────────────────────────────────────────

/**
 * ToolUseConfirm 队列的 setter 函数类型。
 * 与 React useState 的 setter 相同，接受更新函数作为参数，
 * 更新函数接收当前队列并返回新队列。
 */
export type SetToolUseConfirmQueueFn = (
  updater: (prev: ToolUseConfirm[]) => ToolUseConfirm[],
) => void

/**
 * 工具权限上下文的 setter 函数类型。
 * options.preserveMode 为 true 时保留当前模式（ask/auto）不被覆盖。
 */
export type SetToolPermissionContextFn = (
  context: ToolPermissionContext,
  options?: { preserveMode?: boolean },
) => void

// ─── 模块级状态（单例）────────────────────────────────────────────────────────

/** 已注册的 ToolUseConfirmQueue setter，null 表示领导者 REPL 未注册 */
let registeredSetter: SetToolUseConfirmQueueFn | null = null

/** 已注册的 ToolPermissionContext setter，null 表示领导者 REPL 未注册 */
let registeredPermissionContextSetter: SetToolPermissionContextFn | null = null

// ─── ToolUseConfirmQueue 桥接 ─────────────────────────────────────────────────

/**
 * 注册领导者 REPL 的 ToolUseConfirmQueue setter。
 * 领导者 React 组件挂载后调用此函数，将 React 状态 setter 暴露给非 React 代码。
 *
 * @param setter 领导者 REPL 中的 setToolUseConfirmQueue 函数
 */
export function registerLeaderToolUseConfirmQueue(
  setter: SetToolUseConfirmQueueFn,
): void {
  registeredSetter = setter
}

/**
 * 获取已注册的 ToolUseConfirmQueue setter。
 * in-process runner 在需要弹出权限确认对话框时调用。
 *
 * @returns 已注册的 setter，若领导者未注册则返回 null
 */
export function getLeaderToolUseConfirmQueue(): SetToolUseConfirmQueueFn | null {
  return registeredSetter
}

/**
 * 注销 ToolUseConfirmQueue setter。
 * 领导者 React 组件卸载时调用，防止悬空引用。
 */
export function unregisterLeaderToolUseConfirmQueue(): void {
  registeredSetter = null
}

// ─── ToolPermissionContext 桥接 ───────────────────────────────────────────────

/**
 * 注册领导者 REPL 的 ToolPermissionContext setter。
 * 领导者 React 组件挂载后调用此函数，允许 in-process teammate
 * 在权限升级时更新领导者的工具权限上下文。
 *
 * @param setter 领导者 REPL 中的 setToolPermissionContext 函数
 */
export function registerLeaderSetToolPermissionContext(
  setter: SetToolPermissionContextFn,
): void {
  registeredPermissionContextSetter = setter
}

/**
 * 获取已注册的 ToolPermissionContext setter。
 * in-process runner 在需要更新权限上下文时调用。
 *
 * @returns 已注册的 setter，若领导者未注册则返回 null
 */
export function getLeaderSetToolPermissionContext(): SetToolPermissionContextFn | null {
  return registeredPermissionContextSetter
}

/**
 * 注销 ToolPermissionContext setter。
 * 领导者 React 组件卸载时调用，防止悬空引用。
 */
export function unregisterLeaderSetToolPermissionContext(): void {
  registeredPermissionContextSetter = null
}
