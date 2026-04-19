/**
 * Ink 内部事件总线（EventEmitter）
 *
 * 【在 Claude Code / Ink 系统中的位置】
 * 本文件处于 Ink 事件系统层，是组件间异步事件通信的底层基础设施。
 * 由 StdinContext 持有并向下传递，useInput 等 hook 通过此总线
 * 订阅 keypress、resize 等终端输入事件，实现与 React 渲染树的解耦。
 *
 * 【主要功能】
 * 扩展 Node.js 内置的 EventEmitter，增加对自定义 Event 类的感知：
 * 1. 重写 emit 方法，在触发事件时检查 stopImmediatePropagation() 状态，
 *    确保 Ink 的 Event 传播控制语义能在 EventEmitter 场景下生效。
 * 2. 在构造时禁用 maxListeners 警告——React 组件树中多个组件监听
 *    同一事件（如多个 useInput hook）是合理的，不应触发警告。
 */
import { EventEmitter as NodeEventEmitter } from 'events'
import { Event } from './event.js'

/**
 * 扩展 Node.js EventEmitter，增加对 Ink Event 类的 stopImmediatePropagation 支持。
 *
 * 与标准 Node.js EventEmitter 的区别：
 * - 触发事件时，若传入的参数是 Event 实例，会在每个监听器执行后检查
 *   didStopImmediatePropagation()，若已停止则跳过后续监听器。
 * - 构造时调用 setMaxListeners(0) 移除监听器数量上限警告。
 * - 对 'error' 类型事件保持 Node.js 原生行为（直接委托给 super.emit）。
 */
export class EventEmitter extends NodeEventEmitter {
  constructor() {
    super()
    // 禁用默认的最大监听器数量警告。
    // 在 React 中，多个组件可以合理地监听同一事件（例如多个 useInput hook）。
    // 默认上限 10 会产生虚假的警告，因此移除该限制。
    this.setMaxListeners(0)
  }

  /**
   * 重写 emit，在触发事件时支持 stopImmediatePropagation 语义。
   *
   * 【流程说明】
   * 1. 'error' 事件直接委托给 Node.js 原生处理（抛出异常）。
   * 2. 获取该事件类型的所有原始监听器（rawListeners，包括 once 包装器）。
   * 3. 若第一个参数是 Event 实例，则在每个监听器执行后检查是否调用了
   *    stopImmediatePropagation()，若是则停止后续监听器的执行。
   * 4. 返回 true 表示有监听器处理了该事件，false 表示无监听器。
   *
   * @param type - 事件类型字符串或 Symbol
   * @param args - 传递给监听器的参数列表
   * @returns 是否有监听器处理了该事件
   */
  override emit(type: string | symbol, ...args: unknown[]): boolean {
    // 对 'error' 事件保持 Node.js 原生行为（未处理的 error 事件会抛出异常）
    if (type === 'error') {
      return super.emit(type, ...args)
    }

    // 获取该事件类型的所有已注册监听器
    const listeners = this.rawListeners(type)

    // 无监听器时返回 false（与原生 EventEmitter 保持一致）
    if (listeners.length === 0) {
      return false
    }

    // 判断第一个参数是否为 Ink 的 Event 实例，以便后续检查传播控制状态
    const ccEvent = args[0] instanceof Event ? args[0] : null

    for (const listener of listeners) {
      // 执行当前监听器（apply 确保 this 指向 EventEmitter 实例）
      listener.apply(this, args)

      // 若 Event 实例调用了 stopImmediatePropagation()，立即终止后续监听器
      if (ccEvent?.didStopImmediatePropagation()) {
        break
      }
    }

    return true
  }
}
