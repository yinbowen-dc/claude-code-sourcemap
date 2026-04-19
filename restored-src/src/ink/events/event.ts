/**
 * 基础事件类（Base Event Class）
 *
 * 【在 Claude Code / Ink 系统中的位置】
 * 本文件处于 Ink 事件系统层的最底层，是所有事件类的共同基类。
 * 继承关系：Event → TerminalEvent → KeyboardEvent / FocusEvent 等
 *             Event → ClickEvent / InputEvent / TerminalFocusEvent（直接继承）
 *
 * 【主要功能】
 * 提供 stopImmediatePropagation() 语义的最小实现：
 * - 标记事件是否已被调用 stopImmediatePropagation()
 * - EventEmitter.emit 和 Dispatcher.processDispatchQueue 读取此标记
 *   以决定是否继续传递事件给后续监听器
 *
 * 【与 TerminalEvent 的分工】
 * - Event：最轻量的基类，仅提供 stopImmediatePropagation 控制
 * - TerminalEvent：在 Event 基础上添加完整的 DOM Event API
 *   （target、currentTarget、eventPhase、stopPropagation、preventDefault 等）
 */

/** Ink 事件系统的基础事件类，提供立即停止传播的最小接口。 */
export class Event {
  /** 内部标志：记录是否已调用 stopImmediatePropagation() */
  private _didStopImmediatePropagation = false

  /**
   * 查询是否已调用 stopImmediatePropagation()。
   *
   * 由 EventEmitter.emit 和 Dispatcher.processDispatchQueue 在每个
   * 监听器执行后调用，若返回 true 则停止后续监听器的执行。
   *
   * @returns 若已调用 stopImmediatePropagation() 则返回 true
   */
  didStopImmediatePropagation(): boolean {
    return this._didStopImmediatePropagation
  }

  /**
   * 立即停止事件传播——阻止同节点上的后续监听器以及所有祖先节点的监听器执行。
   *
   * 与 stopPropagation() 的区别（定义在 TerminalEvent 中）：
   * - stopPropagation()：允许同一节点上的其他监听器继续执行，仅阻止跨节点传播
   * - stopImmediatePropagation()：立即停止，同节点的后续监听器也不会执行
   */
  stopImmediatePropagation(): void {
    this._didStopImmediatePropagation = true
  }
}
