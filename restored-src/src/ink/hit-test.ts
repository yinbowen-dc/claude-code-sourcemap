/**
 * @file hit-test.ts
 * @description 终端鼠标事件的命中测试与事件分发模块。
 *
 * 在 Claude Code 的 Ink 渲染流水线中，本文件属于「交互事件」层：
 *   终端鼠标输入（col, row） → hitTest（命中测试） → dispatchClick / dispatchHover（事件冒泡）
 *                                       ↑
 *                              nodeCache（renderNodeToOutput 填充的屏幕坐标矩形缓存）
 *
 * 主要职责：
 *  1. hitTest    : 在 DOM 树中找到屏幕坐标 (col, row) 处最顶层的 DOM 元素。
 *  2. dispatchClick  : 从命中节点向上冒泡 ClickEvent，触发 onClick 回调，
 *                      同时处理「点击聚焦」（click-to-focus）逻辑。
 *  3. dispatchHover  : 跟踪鼠标悬停状态，仅在进入/离开节点时触发
 *                      onMouseEnter / onMouseLeave（不冒泡，语义同 DOM mouseenter）。
 *
 * 所有坐标均为屏幕坐标（已应用 scrollTop 偏移），与 nodeCache 中存储的矩形一致。
 */

import type { DOMElement } from './dom.js'
import { ClickEvent } from './events/click-event.js'
import type { EventHandlerProps } from './events/event-handlers.js'
import { nodeCache } from './node-cache.js'

/**
 * 在以 node 为根的 DOM 子树中，找到屏幕坐标 (col, row) 处最深（最顶层绘制）的元素。
 *
 * 算法：
 *  1. 从 nodeCache 读取 node 的屏幕矩形；若缓存中不存在则跳过整棵子树。
 *  2. 判断 (col, row) 是否在矩形内；不在则返回 null（剪枝）。
 *  3. 逆序遍历子节点（后绘制的兄弟节点覆盖前绘制的），递归命中测试。
 *  4. 若子节点无命中，则返回当前节点（即最深的容器节点）。
 *
 * 返回命中节点即使该节点没有 onClick —— dispatchClick 会沿 parentNode 向上找处理器。
 *
 * @param node 待测试的 DOM 元素（通常是根节点）
 * @param col  屏幕列坐标（0-based）
 * @param row  屏幕行坐标（0-based）
 * @returns 命中的最深 DOM 元素，或 null（坐标在节点区域外 / 节点不在缓存中）
 */
export function hitTest(
  node: DOMElement,
  col: number,
  row: number,
): DOMElement | null {
  // 从 nodeCache 读取该节点本帧渲染的屏幕矩形（含 scrollTop 偏移）
  const rect = nodeCache.get(node)
  // 节点未被渲染（本帧不可见或无 yogaNode），跳过整棵子树
  if (!rect) return null
  // 坐标在矩形外，直接剪枝
  if (
    col < rect.x ||
    col >= rect.x + rect.width ||
    row < rect.y ||
    row >= rect.y + rect.height
  ) {
    return null
  }
  // 逆序遍历子节点：后绘制的（索引大的）兄弟节点视觉上覆盖前面的，应优先命中
  for (let i = node.childNodes.length - 1; i >= 0; i--) {
    const child = node.childNodes[i]!
    // 文本节点没有几何信息，跳过
    if (child.nodeName === '#text') continue
    const hit = hitTest(child, col, row)
    // 子树中有命中，直接返回（深度优先，取最深节点）
    if (hit) return hit
  }
  // 子节点均无命中，当前节点即为命中目标
  return node
}

/**
 * 在 root 处命中测试 (col, row)，并从最深命中节点沿 parentNode 链向上冒泡 ClickEvent。
 *
 * 流程：
 *  1. 命中测试找到目标节点；无命中则直接返回 false。
 *  2. 点击聚焦（click-to-focus）：从目标节点向上找最近有 tabIndex 的祖先，
 *     通知 FocusManager 切换焦点。
 *  3. 创建 ClickEvent 并沿 parentNode 链冒泡，对每个有 onClick 的节点：
 *     a. 计算点击位置相对于该节点的本地坐标（localCol / localRow）。
 *     b. 调用 onClick 回调。
 *     c. 若回调调用了 stopImmediatePropagation()，立即停止冒泡并返回 true。
 *
 * @param root        DOM 根节点（ink-root，拥有 FocusManager）
 * @param col         屏幕列坐标
 * @param row         屏幕行坐标
 * @param cellIsBlank 点击的单元格是否为空白（用于 ClickEvent 的元信息）
 * @returns true 表示至少一个 onClick 处理器被触发
 */
export function dispatchClick(
  root: DOMElement,
  col: number,
  row: number,
  cellIsBlank = false,
): boolean {
  // 命中测试：找到坐标处最深的 DOM 元素
  let target: DOMElement | undefined = hitTest(root, col, row) ?? undefined
  // 坐标处无任何节点，忽略此次点击
  if (!target) return false

  // 点击聚焦：从命中节点向上遍历，找到最近有 tabIndex 的祖先并聚焦
  // root 始终是 ink-root，它持有 FocusManager 实例
  if (root.focusManager) {
    let focusTarget: DOMElement | undefined = target
    while (focusTarget) {
      if (typeof focusTarget.attributes['tabIndex'] === 'number') {
        // 通知 FocusManager 将焦点移动到此节点
        root.focusManager.handleClickFocus(focusTarget)
        break
      }
      focusTarget = focusTarget.parentNode
    }
  }
  // 创建携带屏幕坐标和空白信息的点击事件对象
  const event = new ClickEvent(col, row, cellIsBlank)
  let handled = false
  // 沿 parentNode 链向上冒泡
  while (target) {
    // 读取当前节点的 onClick 处理器
    const handler = target._eventHandlers?.onClick as
      | ((event: ClickEvent) => void)
      | undefined
    if (handler) {
      handled = true
      // 从缓存读取该节点的屏幕矩形，用于计算本地坐标
      const rect = nodeCache.get(target)
      if (rect) {
        // 将屏幕坐标转换为节点内部的相对坐标
        event.localCol = col - rect.x
        event.localRow = row - rect.y
      }
      // 调用点击处理器
      handler(event)
      // 若处理器阻止了传播，立即终止冒泡
      if (event.didStopImmediatePropagation()) return true
    }
    // 继续向父节点冒泡
    target = target.parentNode
  }
  return handled
}

/**
 * 在鼠标移动时触发 onMouseEnter / onMouseLeave，语义对应 DOM 的 mouseenter/mouseleave：
 *  - 不冒泡：在子节点间移动不会重复触发父节点的事件。
 *  - 进入新节点集合时触发 onMouseEnter，离开旧节点集合时触发 onMouseLeave。
 *
 * 算法：
 *  1. 命中测试得到当前帧的命中节点，向上收集所有有悬停处理器的祖先节点，构成 next 集合。
 *  2. 对 hovered 中不在 next 里的节点，触发 onMouseLeave（已离开）。
 *  3. 对 next 中不在 hovered 里的节点，触发 onMouseEnter（新进入）。
 *  4. 原地更新 hovered，供调用方（App 实例）在下次鼠标移动时复用。
 *
 * @param root    DOM 根节点
 * @param col     当前鼠标列坐标
 * @param row     当前鼠标行坐标
 * @param hovered 跨帧持久化的悬停节点集合（由调用方持有，此函数原地修改）
 */
export function dispatchHover(
  root: DOMElement,
  col: number,
  row: number,
  hovered: Set<DOMElement>,
): void {
  // 收集本次鼠标位置命中路径上所有有悬停处理器的节点
  const next = new Set<DOMElement>()
  let node: DOMElement | undefined = hitTest(root, col, row) ?? undefined
  while (node) {
    const h = node._eventHandlers as EventHandlerProps | undefined
    // 只收集有 onMouseEnter 或 onMouseLeave 的节点
    if (h?.onMouseEnter || h?.onMouseLeave) next.add(node)
    node = node.parentNode
  }
  // 处理已离开的节点：在 hovered 中但不在 next 中的节点触发 onMouseLeave
  for (const old of hovered) {
    if (!next.has(old)) {
      hovered.delete(old)
      // 跳过在两次鼠标事件之间已被 React 卸载的节点（parentNode 为 null）
      if (old.parentNode) {
        ;(old._eventHandlers as EventHandlerProps | undefined)?.onMouseLeave?.()
      }
    }
  }
  // 处理新进入的节点：在 next 中但不在 hovered 中的节点触发 onMouseEnter
  for (const n of next) {
    if (!hovered.has(n)) {
      hovered.add(n)
      ;(n._eventHandlers as EventHandlerProps | undefined)?.onMouseEnter?.()
    }
  }
}
