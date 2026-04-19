/**
 * 焦点管理器（Focus Manager）
 *
 * 【在 Claude Code / Ink 系统中的位置】
 * 本文件处于 Ink DOM 层，是终端 UI 的焦点管理核心。
 * FocusManager 实例存储在根 DOMElement 节点上（类似浏览器的 document），
 * 任意节点均可通过向上遍历 parentNode 链调用 getRootNode() 或 getFocusManager() 访问它。
 *
 * 【主要功能】
 * 1. 跟踪当前获得焦点的元素（activeElement）和焦点历史栈（focusStack）
 * 2. focus(node)：将焦点移动到指定节点，触发 blur/focus 事件对
 * 3. blur()：移除当前焦点，触发 blur 事件
 * 4. handleNodeRemoved：节点从树中移除时自动处理焦点恢复（从栈中弹出最近的有效节点）
 * 5. handleAutoFocus / handleClickFocus：自动焦点和点击聚焦支持
 * 6. focusNext / focusPrevious：Tab 键导航，在所有可 Tab 的节点之间循环
 * 7. enable / disable：批量控制焦点系统的启用/禁用状态
 *
 * 【与浏览器 DOM 的对应关系】
 * - FocusManager ≈ document（持有 activeElement，管理焦点状态）
 * - getRootNode(node) ≈ node.getRootNode()（向上遍历到根节点）
 * - getFocusManager(node) ≈ node.ownerDocument（获取焦点管理器）
 */
import type { DOMElement } from './dom.js'
import { FocusEvent } from './events/focus-event.js'

// 焦点历史栈的最大容量，防止 Tab 键循环时栈无限增长
const MAX_FOCUS_STACK = 32

/**
 * 终端 UI 的 DOM 风格焦点管理器。
 *
 * 纯状态对象——跟踪 activeElement 和焦点历史栈，不持有树的引用。
 * 调用者在需要遍历树时（如 focusNext）传入根节点。
 *
 * 存储在根 DOMElement 上，任意节点可通过向上遍历 parentNode
 * 访问（类似浏览器的 `node.ownerDocument`）。
 */
export class FocusManager {
  /** 当前获得焦点的元素，无焦点时为 null */
  activeElement: DOMElement | null = null
  /** 用于分发 FocusEvent 的函数（由构造者注入，通常是 Dispatcher.dispatchDiscrete） */
  private dispatchFocusEvent: (target: DOMElement, event: FocusEvent) => boolean
  /** 焦点系统是否启用，禁用时 focus() 调用无效 */
  private enabled = true
  /** 焦点历史栈，用于节点移除后恢复焦点 */
  private focusStack: DOMElement[] = []

  /**
   * 创建一个焦点管理器。
   *
   * @param dispatchFocusEvent - 焦点事件分发函数，通常为 Dispatcher 的离散分发方法
   */
  constructor(
    dispatchFocusEvent: (target: DOMElement, event: FocusEvent) => boolean,
  ) {
    this.dispatchFocusEvent = dispatchFocusEvent
  }

  /**
   * 将焦点移动到指定节点。
   *
   * 【流程说明】
   * 1. 若目标节点已是当前焦点节点，或焦点系统已禁用，直接返回。
   * 2. 若有当前焦点节点，将其推入焦点历史栈（去重后推入，防止 Tab 循环无限增长），
   *    并向其分发 blur 事件（relatedTarget 为新焦点节点）。
   * 3. 更新 activeElement 为新节点。
   * 4. 向新节点分发 focus 事件（relatedTarget 为前一个焦点节点）。
   *
   * @param node - 将要获得焦点的节点
   */
  focus(node: DOMElement): void {
    if (node === this.activeElement) return  // 已是焦点节点，无需操作
    if (!this.enabled) return                // 焦点系统已禁用

    const previous = this.activeElement
    if (previous) {
      // 去重处理：防止 Tab 键循环时同一节点重复推入栈导致无限增长
      const idx = this.focusStack.indexOf(previous)
      if (idx !== -1) this.focusStack.splice(idx, 1)
      this.focusStack.push(previous)
      // 栈超过最大容量时移除最旧的记录
      if (this.focusStack.length > MAX_FOCUS_STACK) this.focusStack.shift()
      // 向前一个焦点节点分发 blur 事件，relatedTarget 指向新焦点节点
      this.dispatchFocusEvent(previous, new FocusEvent('blur', node))
    }
    this.activeElement = node  // 更新当前焦点节点
    // 向新焦点节点分发 focus 事件，relatedTarget 指向前一个焦点节点
    this.dispatchFocusEvent(node, new FocusEvent('focus', previous))
  }

  /**
   * 移除当前焦点，向当前焦点节点分发 blur 事件。
   *
   * blur() 不从焦点历史栈中恢复焦点（与 handleNodeRemoved 不同）。
   */
  blur(): void {
    if (!this.activeElement) return  // 当前无焦点节点

    const previous = this.activeElement
    this.activeElement = null  // 清除当前焦点
    // 向前一个焦点节点分发 blur 事件，relatedTarget 为 null（焦点完全移出）
    this.dispatchFocusEvent(previous, new FocusEvent('blur', null))
  }

  /**
   * 处理节点从 DOM 树中移除的情况。
   *
   * 当 React Reconciler 从树中移除一个节点时调用此方法，处理以下两种情况：
   * 1. 被移除节点本身是当前焦点节点
   * 2. 被移除节点的某个后代是当前焦点节点
   *
   * 若上述情况发生，会触发 blur 事件并从焦点历史栈中恢复焦点到
   * 最近一个仍在树中的节点。
   *
   * @param node - 被移除的节点
   * @param root - DOM 树的根节点（用于判断节点是否仍在树中）
   */
  handleNodeRemoved(node: DOMElement, root: DOMElement): void {
    // 从焦点历史栈中移除已不在树中的节点
    this.focusStack = this.focusStack.filter(
      n => n !== node && isInTree(n, root),
    )

    // 检查当前焦点节点是否受影响（本身被移除，或是被移除节点的后代）
    if (!this.activeElement) return
    if (this.activeElement !== node && isInTree(this.activeElement, root)) {
      return  // 当前焦点节点仍在树中，无需处理
    }

    // 当前焦点节点已从树中移除，清除焦点并触发 blur 事件
    const removed = this.activeElement
    this.activeElement = null
    this.dispatchFocusEvent(removed, new FocusEvent('blur', null))

    // 从焦点历史栈中恢复焦点到最近一个仍在树中的节点
    while (this.focusStack.length > 0) {
      const candidate = this.focusStack.pop()!
      if (isInTree(candidate, root)) {
        // 找到有效的候选节点，恢复焦点
        this.activeElement = candidate
        this.dispatchFocusEvent(candidate, new FocusEvent('focus', removed))
        return
      }
    }
    // 栈为空或所有候选节点均已不在树中，焦点完全清除
  }

  /**
   * 处理带 autoFocus 属性的节点挂载。
   * 节点挂载时若设置了 autoFocus，Reconciler 会调用此方法将焦点移至该节点。
   *
   * @param node - 带 autoFocus 属性的节点
   */
  handleAutoFocus(node: DOMElement): void {
    this.focus(node)
  }

  /**
   * 处理鼠标点击触发的焦点变化。
   * 仅当节点具有有效的 tabIndex 属性时，点击才会使其获得焦点。
   *
   * @param node - 被点击的节点
   */
  handleClickFocus(node: DOMElement): void {
    const tabIndex = node.attributes['tabIndex']
    if (typeof tabIndex !== 'number') return  // 无 tabIndex 的节点不可被点击聚焦
    this.focus(node)
  }

  /** 启用焦点系统（允许 focus() 调用生效） */
  enable(): void {
    this.enabled = true
  }

  /** 禁用焦点系统（后续 focus() 调用无效） */
  disable(): void {
    this.enabled = false
  }

  /**
   * 将焦点移动到下一个可 Tab 节点（Tab 键前进）。
   *
   * @param root - DOM 树根节点，用于收集所有可 Tab 节点
   */
  focusNext(root: DOMElement): void {
    this.moveFocus(1, root)
  }

  /**
   * 将焦点移动到上一个可 Tab 节点（Shift+Tab 键后退）。
   *
   * @param root - DOM 树根节点，用于收集所有可 Tab 节点
   */
  focusPrevious(root: DOMElement): void {
    this.moveFocus(-1, root)
  }

  /**
   * 在可 Tab 节点列表中按指定方向移动焦点。
   *
   * 【循环逻辑】
   * - 收集树中所有 tabIndex >= 0 的节点（按 DFS 顺序）
   * - 找到当前焦点节点的位置，计算下一个/上一个节点的索引（环形）
   * - 若无当前焦点：向前时选第一个节点，向后时选最后一个节点
   *
   * @param direction - 移动方向：1 为向前（Tab），-1 为向后（Shift+Tab）
   * @param root - DOM 树根节点
   */
  private moveFocus(direction: 1 | -1, root: DOMElement): void {
    if (!this.enabled) return  // 焦点系统已禁用

    // 收集所有可聚焦（tabIndex >= 0）节点
    const tabbable = collectTabbable(root)
    if (tabbable.length === 0) return  // 无可聚焦节点

    // 查找当前焦点节点在可 Tab 列表中的位置（未找到则为 -1）
    const currentIndex = this.activeElement
      ? tabbable.indexOf(this.activeElement)
      : -1

    // 计算目标节点的索引（环形，支持从末尾绕回开头，或从开头绕回末尾）
    const nextIndex =
      currentIndex === -1
        ? direction === 1
          ? 0                    // 无当前焦点时向前移动：选第一个
          : tabbable.length - 1  // 无当前焦点时向后移动：选最后一个
        : (currentIndex + direction + tabbable.length) % tabbable.length  // 环形计算

    const next = tabbable[nextIndex]
    if (next) {
      this.focus(next)
    }
  }
}

/**
 * 收集 DOM 树中所有可 Tab 的节点（tabIndex >= 0 的节点）。
 * 按深度优先遍历顺序返回，与 Tab 键导航的视觉顺序一致。
 *
 * @param root - 遍历起始的根节点
 * @returns 按 DFS 顺序排列的可 Tab 节点数组
 */
function collectTabbable(root: DOMElement): DOMElement[] {
  const result: DOMElement[] = []
  walkTree(root, result)
  return result
}

/**
 * 深度优先遍历 DOM 树，将 tabIndex >= 0 的节点收集到结果数组中。
 * 跳过文本节点（nodeName === '#text'），文本节点不可聚焦。
 *
 * @param node - 当前遍历的节点
 * @param result - 收集结果的数组（原地修改）
 */
function walkTree(node: DOMElement, result: DOMElement[]): void {
  const tabIndex = node.attributes['tabIndex']
  // 仅收集 tabIndex 为非负整数的节点（tabIndex < 0 表示不参与 Tab 导航）
  if (typeof tabIndex === 'number' && tabIndex >= 0) {
    result.push(node)
  }

  // 递归遍历子节点，跳过文本节点
  for (const child of node.childNodes) {
    if (child.nodeName !== '#text') {
      walkTree(child, result)
    }
  }
}

/**
 * 检查节点是否在以 root 为根的树中。
 * 通过向上遍历 parentNode 链检查，时间复杂度 O(depth)。
 *
 * @param node - 待检查的节点
 * @param root - 树的根节点
 * @returns 若 node 是 root 或 root 的后代则返回 true
 */
function isInTree(node: DOMElement, root: DOMElement): boolean {
  let current: DOMElement | undefined = node
  while (current) {
    if (current === root) return true
    current = current.parentNode  // 向上遍历 parentNode 链
  }
  return false
}

/**
 * 向上遍历 parentNode 链，返回持有 FocusManager 的根节点。
 *
 * 类似浏览器的 `node.getRootNode()`——根节点是持有 FocusManager 的节点。
 * 若遍历到树顶仍未找到 FocusManager，抛出错误（节点不在有效树中）。
 *
 * @param node - 起始节点
 * @returns 持有 FocusManager 的根节点
 * @throws 若节点不在含有 FocusManager 的树中
 */
export function getRootNode(node: DOMElement): DOMElement {
  let current: DOMElement | undefined = node
  while (current) {
    if (current.focusManager) return current  // 找到持有 FocusManager 的根节点
    current = current.parentNode
  }
  throw new Error('Node is not in a tree with a FocusManager')
}

/**
 * 向上遍历 parentNode 链，返回根节点上的 FocusManager。
 *
 * 类似浏览器的 `node.ownerDocument`——焦点归根节点所有。
 * 内部调用 getRootNode()，若节点不在有效树中会抛出错误。
 *
 * @param node - 起始节点
 * @returns 根节点上的 FocusManager 实例
 */
export function getFocusManager(node: DOMElement): FocusManager {
  return getRootNode(node).focusManager!
}
