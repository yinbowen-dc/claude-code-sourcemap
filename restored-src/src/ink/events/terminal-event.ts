/**
 * 终端事件基类（Terminal Event Base Class）
 *
 * 【在 Claude Code / Ink 系统中的位置】
 * 本文件处于 Ink 事件系统层，是通过 DOM 捕获/冒泡系统分发的所有事件的基类。
 * 继承关系：Event → TerminalEvent → KeyboardEvent / FocusEvent / ClickEvent（部分）
 *
 * 【主要功能】
 * 镜像浏览器的 Event API，为终端 UI 组件提供与 Web 开发一致的事件处理体验：
 * - target / currentTarget：事件目标和当前处理节点
 * - eventPhase：事件传播阶段（none/capturing/at_target/bubbling）
 * - stopPropagation()：阻止跨节点传播（同节点其他处理器仍继续）
 * - stopImmediatePropagation()：立即停止所有传播
 * - preventDefault()：标记阻止默认行为
 * - timeStamp：事件创建时的高精度时间戳
 * - bubbles / cancelable：传播和取消能力标志
 *
 * 【内部 setter 方法】
 * _setTarget / _setCurrentTarget / _setEventPhase / _isPropagationStopped /
 * _isImmediatePropagationStopped / _prepareForTarget 供 Dispatcher 内部使用，
 * 不对组件消费者暴露（通过 _ 前缀标识内部 API）。
 */
import { Event } from './event.js'

/** 事件传播阶段枚举 */
type EventPhase = 'none' | 'capturing' | 'at_target' | 'bubbling'

/** TerminalEvent 构造函数选项 */
type TerminalEventInit = {
  bubbles?: boolean    // 是否向上冒泡，默认 true
  cancelable?: boolean // 是否可被 preventDefault() 取消，默认 true
}

/**
 * 所有终端事件的基类，提供完整的 DOM 风格事件传播 API。
 *
 * 继承自 Event（提供 stopImmediatePropagation），并添加：
 * - 完整的 DOM Event API（target、currentTarget、eventPhase 等）
 * - 传播控制（stopPropagation、stopImmediatePropagation）
 * - 默认行为控制（preventDefault）
 * - 高精度时间戳（performance.now()）
 *
 * 现有事件类型（ClickEvent、InputEvent、TerminalFocusEvent）共享此公共祖先，
 * 以便未来迁移到统一的事件系统。
 */
export class TerminalEvent extends Event {
  /** 事件类型字符串（如 'keydown'、'click'、'focus'） */
  readonly type: string
  /** 事件创建时的高精度时间戳（performance.now()） */
  readonly timeStamp: number
  /** 事件是否向上冒泡（false 表示仅在目标节点触发） */
  readonly bubbles: boolean
  /** 事件是否可被 preventDefault() 取消 */
  readonly cancelable: boolean

  /** 最初触发事件的目标节点 */
  private _target: EventTarget | null = null
  /** 当前正在处理该事件的节点（随传播阶段变化） */
  private _currentTarget: EventTarget | null = null
  /** 当前传播阶段 */
  private _eventPhase: EventPhase = 'none'
  /** 是否已调用 stopPropagation() */
  private _propagationStopped = false
  /** 是否已调用 preventDefault() */
  private _defaultPrevented = false

  /**
   * 创建一个终端事件实例。
   *
   * @param type - 事件类型字符串
   * @param init - 可选的初始化选项（bubbles 默认 true，cancelable 默认 true）
   */
  constructor(type: string, init?: TerminalEventInit) {
    super()
    this.type = type
    this.timeStamp = performance.now()  // 使用高精度时间戳
    this.bubbles = init?.bubbles ?? true       // 默认向上冒泡
    this.cancelable = init?.cancelable ?? true // 默认可取消
  }

  /** 最初触发事件的目标节点（只读，由 Dispatcher 在分发前通过 _setTarget 设置） */
  get target(): EventTarget | null {
    return this._target
  }

  /** 当前正在处理该事件的节点（在事件传播过程中随处理器变化） */
  get currentTarget(): EventTarget | null {
    return this._currentTarget
  }

  /** 当前传播阶段（none/capturing/at_target/bubbling） */
  get eventPhase(): EventPhase {
    return this._eventPhase
  }

  /** 是否已调用 preventDefault() 阻止了默认行为 */
  get defaultPrevented(): boolean {
    return this._defaultPrevented
  }

  /**
   * 阻止事件跨节点传播，但允许同一节点上的其他处理器继续执行。
   *
   * 与 stopImmediatePropagation() 的区别：
   * - stopPropagation()：仅阻止传播到下一个节点，同节点剩余处理器仍执行
   * - stopImmediatePropagation()：立即停止，包括同节点的后续处理器
   */
  stopPropagation(): void {
    this._propagationStopped = true
  }

  /**
   * 立即停止事件传播，包括同节点的后续处理器。
   *
   * 同时调用父类的 stopImmediatePropagation()（设置 _didStopImmediatePropagation 标志）
   * 并标记 _propagationStopped，确保两个传播控制标志都被设置。
   */
  override stopImmediatePropagation(): void {
    super.stopImmediatePropagation()  // 设置 Event 基类的 _didStopImmediatePropagation 标志
    this._propagationStopped = true   // 同时标记跨节点传播已停止
  }

  /**
   * 标记阻止事件的默认行为（如果事件可取消）。
   *
   * 仅当 cancelable=true 时有效；不可取消的事件调用此方法无任何效果。
   * Dispatcher.dispatch() 通过检查 defaultPrevented 决定是否执行默认行为。
   */
  preventDefault(): void {
    if (this.cancelable) {
      this._defaultPrevented = true
    }
  }

  // -- 供 Dispatcher 内部使用的 setter 方法（不对组件消费者暴露）

  /** @internal 设置事件的初始目标节点（在 collectListeners 之前调用） */
  _setTarget(target: EventTarget): void {
    this._target = target
  }

  /** @internal 在每个处理器被调用前更新 currentTarget */
  _setCurrentTarget(target: EventTarget | null): void {
    this._currentTarget = target
  }

  /** @internal 在每个处理器被调用前更新事件传播阶段 */
  _setEventPhase(phase: EventPhase): void {
    this._eventPhase = phase
  }

  /** @internal 供 Dispatcher 检查是否已调用 stopPropagation()（跨节点传播控制） */
  _isPropagationStopped(): boolean {
    return this._propagationStopped
  }

  /** @internal 供 Dispatcher 检查是否已调用 stopImmediatePropagation()（立即终止） */
  _isImmediatePropagationStopped(): boolean {
    return this.didStopImmediatePropagation()
  }

  /**
   * 子类钩子：在每个处理器被调用前执行节点级别的准备工作。
   * 默认为空操作；ClickEvent 等子类可重写此方法更新 localCol/localRow 等坐标。
   *
   * @param _target - 当前处理该事件的节点
   */
  _prepareForTarget(_target: EventTarget): void {}
}

/**
 * 事件目标节点的类型定义。
 *
 * 是 DOM 树中任意可接收事件的节点的最小接口：
 * - parentNode：用于 Dispatcher 沿树向上收集监听器（捕获/冒泡路径）
 * - _eventHandlers：存储该节点上注册的事件处理器（由 Reconciler 填充）
 */
export type EventTarget = {
  parentNode: EventTarget | undefined               // 父节点，根节点为 undefined
  _eventHandlers?: Record<string, unknown>          // 事件处理器映射（prop 名 → 处理器函数）
}
