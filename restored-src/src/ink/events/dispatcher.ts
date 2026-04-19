/**
 * Dispatcher —— Ink 事件分发器
 *
 * 【在 Claude Code 系统中的位置】
 * 属于 Ink 事件系统层的核心调度组件，连接终端输入处理和 React 调度系统。
 * 当终端产生键盘、鼠标、焦点等输入事件时，由 ink.tsx 或输入处理器创建对应的
 * TerminalEvent 实例，并通过本模块的 Dispatcher 进行 DOM 树的捕获/冒泡分发，
 * 同时将事件调度优先级通知给 React 的并发模式调度器。
 *
 * 【主要功能】
 * 1. 收集事件监听器（collectListeners）：
 *    沿 target → root 路径收集捕获和冒泡阶段的处理器，
 *    按 [根捕获, ..., 目标捕获, 目标冒泡, ..., 根冒泡] 顺序排列
 * 2. 执行分发队列（processDispatchQueue）：
 *    依次调用处理器，支持 stopPropagation/stopImmediatePropagation
 * 3. 事件优先级映射（getEventPriority）：
 *    将终端事件类型映射到 React 的调度优先级（离散/连续/默认）
 * 4. Dispatcher 类：
 *    持有分发状态，提供 dispatch/dispatchDiscrete/dispatchContinuous 方法，
 *    供 React Reconciler 主机配置读取当前事件信息
 *
 * 【与 React 调度的集成】
 * Dispatcher.currentEvent 和 currentUpdatePriority 被 reconciler 的
 * resolveUpdatePriority/resolveEventType 读取，模仿 react-dom 通过
 * window.event 和 ReactDOMSharedInternals 传递事件上下文的机制。
 */
import {
  ContinuousEventPriority,
  DefaultEventPriority,
  DiscreteEventPriority,
  NoEventPriority,
} from 'react-reconciler/constants.js'
import { logError } from '../../utils/log.js'
import { HANDLER_FOR_EVENT } from './event-handlers.js'
import type { EventTarget, TerminalEvent } from './terminal-event.js'

// --

/** 描述一个待执行的事件监听器及其所在节点和传播阶段 */
type DispatchListener = {
  node: EventTarget                              // 监听器所在的 DOM 节点
  handler: (event: TerminalEvent) => void        // 事件处理函数
  phase: 'capturing' | 'at_target' | 'bubbling' // 当前传播阶段
}

/**
 * 从节点的 _eventHandlers 中查找指定事件类型和传播阶段的处理器。
 *
 * 通过 HANDLER_FOR_EVENT 查找表将事件类型字符串映射到处理器 prop 名称
 * （如 'keydown' → 'onKeyDown' / 'onKeyDownCapture'），实现 O(1) 查找。
 *
 * @param node       目标节点
 * @param eventType  事件类型字符串（如 'keydown'、'click'）
 * @param capture    true 表示查找捕获阶段处理器，false 表示冒泡阶段
 */
function getHandler(
  node: EventTarget,
  eventType: string,
  capture: boolean,
): ((event: TerminalEvent) => void) | undefined {
  const handlers = node._eventHandlers
  if (!handlers) return undefined

  // 通过 HANDLER_FOR_EVENT 查找表获取 prop 名称映射
  const mapping = HANDLER_FOR_EVENT[eventType]
  if (!mapping) return undefined

  // 根据阶段选择对应的 prop 名称（capture/bubble）
  const propName = capture ? mapping.capture : mapping.bubble
  if (!propName) return undefined

  return handlers[propName] as ((event: TerminalEvent) => void) | undefined
}

/**
 * 收集指定事件在整个 DOM 路径上的所有监听器，按分发顺序排列。
 *
 * 【实现模式】
 * 采用 react-dom 的两阶段累积模式：
 * - 从 target 向上遍历到根节点
 * - 捕获处理器用 unshift 添加（根节点第一，target 最后）
 * - 冒泡处理器用 push 添加（target 第一，根节点最后）
 *
 * 最终结果顺序：
 * [根捕获, ..., 父捕获, 目标捕获, 目标冒泡, 父冒泡, ..., 根冒泡]
 *
 * @param target  事件目标节点（最深的命中节点）
 * @param event   待分发的事件对象（用于判断是否冒泡）
 */
function collectListeners(
  target: EventTarget,
  event: TerminalEvent,
): DispatchListener[] {
  const listeners: DispatchListener[] = []

  let node: EventTarget | undefined = target
  while (node) {
    const isTarget = node === target  // 判断是否为事件目标节点

    // 查找捕获阶段处理器
    const captureHandler = getHandler(node, event.type, true)
    // 查找冒泡阶段处理器
    const bubbleHandler = getHandler(node, event.type, false)

    if (captureHandler) {
      // 捕获处理器插入数组头部（根节点先于子节点执行）
      listeners.unshift({
        node,
        handler: captureHandler,
        phase: isTarget ? 'at_target' : 'capturing',
      })
    }

    if (bubbleHandler && (event.bubbles || isTarget)) {
      // 冒泡处理器追加到数组尾部（子节点先于根节点执行）
      // 不冒泡的事件只在目标节点上触发冒泡处理器
      listeners.push({
        node,
        handler: bubbleHandler,
        phase: isTarget ? 'at_target' : 'bubbling',
      })
    }

    node = node.parentNode  // 向上遍历到父节点
  }

  return listeners
}

/**
 * 按顺序执行已收集的监听器列表，并支持传播控制。
 *
 * 【流程说明】
 * 1. 遍历监听器数组
 * 2. 检查 _isImmediatePropagationStopped()：若停止，终止整个循环
 * 3. 检查 _isPropagationStopped()：若停止且已切换到新节点，终止循环
 *    （同一节点上的多个处理器仍会执行，只有跨节点传播被阻止）
 * 4. 调用 event._prepareForTarget() 为每个节点执行自定义准备工作
 * 5. 调用处理器，用 try/catch 捕获错误并记录（不中断其他处理器）
 *
 * @param listeners  由 collectListeners 收集的监听器数组
 * @param event      正在分发的事件对象
 */
function processDispatchQueue(
  listeners: DispatchListener[],
  event: TerminalEvent,
): void {
  let previousNode: EventTarget | undefined

  for (const { node, handler, phase } of listeners) {
    // stopImmediatePropagation：立即停止，跳过同节点的后续处理器
    if (event._isImmediatePropagationStopped()) {
      break
    }

    // stopPropagation：跨节点时停止，但同节点的处理器继续执行
    if (event._isPropagationStopped() && node !== previousNode) {
      break
    }

    // 更新事件的当前阶段和当前目标节点
    event._setEventPhase(phase)
    event._setCurrentTarget(node)
    // 调用子类钩子（如 ClickEvent 更新 localCol/localRow）
    event._prepareForTarget(node)

    try {
      handler(event)  // 执行事件处理器
    } catch (error) {
      logError(error)  // 捕获错误并记录，不中断其他处理器的执行
    }

    previousNode = node  // 记录当前节点，用于 stopPropagation 的跨节点检测
  }
}

// --

/**
 * 将终端事件类型映射到 React 调度优先级。
 *
 * 镜像 react-dom 的 getEventPriority() 实现：
 * - 离散优先级（DiscreteEventPriority）：键盘、点击、焦点、粘贴
 *   → 用户交互，需要同步响应，优先级最高
 * - 连续优先级（ContinuousEventPriority）：窗口缩放、滚动、鼠标移动
 *   → 高频事件，可以合并处理
 * - 默认优先级（DefaultEventPriority）：其他事件
 */
function getEventPriority(eventType: string): number {
  switch (eventType) {
    case 'keydown':
    case 'keyup':
    case 'click':
    case 'focus':
    case 'blur':
    case 'paste':
      // 离散事件：用户主动触发的交互，需要同步响应
      return DiscreteEventPriority as number
    case 'resize':
    case 'scroll':
    case 'mousemove':
      // 连续事件：高频触发，可以合并
      return ContinuousEventPriority as number
    default:
      return DefaultEventPriority as number
  }
}

// --

/**
 * React 离散更新函数的类型签名。
 * 用于将事件分发包装在 React 的离散更新上下文中，确保优先级正确传递。
 */
type DiscreteUpdates = <A, B>(
  fn: (a: A, b: B) => boolean,
  a: A,
  b: B,
  c: undefined,
  d: undefined,
) => boolean

/**
 * 事件分发器类，持有分发状态并提供捕获/冒泡分发循环。
 *
 * 【与 React Reconciler 的集成】
 * reconciler 的主机配置通过读取 currentEvent 和 currentUpdatePriority
 * 来实现 resolveUpdatePriority/resolveEventType/resolveEventTimeStamp，
 * 镜像 react-dom 通过 ReactDOMSharedInternals 和 window.event 读取事件信息的机制。
 *
 * discreteUpdates 在构造后注入（由 InkReconciler 注入），以打破循环导入。
 */
export class Dispatcher {
  /** 当前正在分发的事件，分发完成后恢复为 null（支持嵌套分发） */
  currentEvent: TerminalEvent | null = null
  /** 当前更新优先级，由 dispatchContinuous 临时覆盖 */
  currentUpdatePriority: number = DefaultEventPriority as number
  /** React 离散更新包装函数，由 InkReconciler 注入以打破导入循环 */
  discreteUpdates: DiscreteUpdates | null = null

  /**
   * 从当前正在分发的事件推断 React 更新优先级。
   *
   * 由 reconciler 主机配置的 resolveUpdatePriority 调用，
   * 当没有明确设置优先级时，根据当前事件类型推断。
   */
  resolveEventPriority(): number {
    // 若已明确设置了优先级，直接返回
    if (this.currentUpdatePriority !== (NoEventPriority as number)) {
      return this.currentUpdatePriority
    }
    // 否则根据当前事件类型推断优先级
    if (this.currentEvent) {
      return getEventPriority(this.currentEvent.type)
    }
    return DefaultEventPriority as number
  }

  /**
   * 将事件分发到目标节点，执行完整的捕获和冒泡过程。
   *
   * 【流程说明】
   * 1. 保存当前事件（支持嵌套分发），设置新的当前事件
   * 2. 设置事件目标（target）
   * 3. 收集所有监听器（collectListeners）
   * 4. 按顺序执行监听器（processDispatchQueue）
   * 5. 清理事件阶段和当前目标
   * 6. 恢复之前的事件状态（嵌套分发安全）
   * 7. 返回 !defaultPrevented（表示是否应执行默认行为）
   *
   * @param target  事件目标节点
   * @param event   待分发的事件对象
   * @returns       若 preventDefault() 未被调用则返回 true
   */
  dispatch(target: EventTarget, event: TerminalEvent): boolean {
    const previousEvent = this.currentEvent  // 保存当前事件（支持嵌套）
    this.currentEvent = event
    try {
      event._setTarget(target)  // 设置事件的 target 属性

      // 收集捕获和冒泡阶段的所有监听器
      const listeners = collectListeners(target, event)
      // 按顺序执行监听器
      processDispatchQueue(listeners, event)

      // 清理事件状态（分发结束）
      event._setEventPhase('none')
      event._setCurrentTarget(null)

      return !event.defaultPrevented  // 返回是否应执行默认行为
    } finally {
      this.currentEvent = previousEvent  // 恢复之前的事件（嵌套分发安全）
    }
  }

  /**
   * 以离散（同步）优先级分发事件。
   *
   * 用于用户主动触发的交互事件：键盘输入、点击、焦点变化、粘贴。
   * 若 discreteUpdates 已注入（正常运行时），将分发包装在 React 的
   * 离散更新上下文中，确保状态更新以同步优先级处理。
   */
  dispatchDiscrete(target: EventTarget, event: TerminalEvent): boolean {
    if (!this.discreteUpdates) {
      // discreteUpdates 尚未注入（启动阶段），直接分发
      return this.dispatch(target, event)
    }
    // 包装在 React 离散更新上下文中分发
    return this.discreteUpdates(
      (t, e) => this.dispatch(t, e),
      target,
      event,
      undefined,
      undefined,
    )
  }

  /**
   * 以连续优先级分发事件。
   *
   * 用于高频事件：窗口缩放、滚动、鼠标移动。
   * 临时将 currentUpdatePriority 设为 ContinuousEventPriority，
   * reconciler 读取此值以合并高频更新，减少不必要的渲染。
   */
  dispatchContinuous(target: EventTarget, event: TerminalEvent): boolean {
    const previousPriority = this.currentUpdatePriority
    try {
      // 临时设置连续优先级
      this.currentUpdatePriority = ContinuousEventPriority as number
      return this.dispatch(target, event)
    } finally {
      this.currentUpdatePriority = previousPriority  // 恢复之前的优先级
    }
  }
}
