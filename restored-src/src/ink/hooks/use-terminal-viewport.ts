/**
 * @file hooks/use-terminal-viewport.ts
 * 组件终端视口可见性检测 Hook
 *
 * 在 Claude Code 的 Ink 渲染体系中，本文件处于布局感知层：
 *   Yoga 布局计算（calculateLayout）+ DOM scrollTop（由 ScrollBox 维护）
 *   → 【本文件：useTerminalViewport 计算组件是否在终端可见视口内】
 *   → useAnimationFrame（isVisible=false 时暂停动画，节省 CPU）
 *
 * 核心功能：
 *  - 计算元素的绝对屏幕位置（含 ScrollBox 滚动偏移修正）
 *  - 仅更新 ref（不触发 setState），避免布局阶段的级联重渲染
 *  - 视口边界计算与 log-update.ts 的 scrollbackRows 逻辑对齐
 *    （内容溢出视口时额外 +1 行，防止动画在边界处误判为可见导致闪烁）
 */

import { useCallback, useContext, useLayoutEffect, useRef } from 'react'
import { TerminalSizeContext } from '../components/TerminalSizeContext.js'
import type { DOMElement } from '../dom.js'

/** 视口检测条目：包含元素当前是否可见的布尔值 */
type ViewportEntry = {
  /**
   * 元素是否当前处于终端视口内
   */
  isVisible: boolean
}

/**
 * 检测组件是否位于终端可见视口内的 React Hook。
 *
 * 流程：
 *  1. 返回 setElement ref callback，调用者将其绑定到目标 DOM 节点
 *  2. 每次渲染的 layout effect（无依赖数组）执行可见性计算：
 *     a. 读取元素 yogaNode 的计算高度
 *     b. 沿 DOM parentNode 链向上累加 computedTop（不用 yoga.getParent()）
 *     c. 每遇到有 scrollTop 的祖先节点，减去其滚动偏移
 *     d. 到达根节点，读取根节点高度作为 screenHeight
 *     e. 计算视口顶部 viewportY（含 cursorRestoreScroll 修正）
 *     f. 判断 [absoluteTop, absoluteTop+height) 与 [viewportY, viewportBottom) 是否有交集
 *  3. 可见性变化时更新 entryRef（不调用 setState，不触发额外渲染）
 *
 * 设计关键：
 *  - 使用 DOM parentNode 链（而非 yoga.getParent()）以正确减去 scrollTop
 *  - cursorRestoreScroll：内容溢出时 log-update 多消耗 1 行滚回，
 *    此处需同步，避免边界元素在此处被认为可见但在渲染层被截掉
 *
 * @returns [ref, entry] - ref 绑定到目标元素，entry.isVisible 表示当前可见性
 *
 * @example
 * const [ref, entry] = useTerminalViewport()
 * return <Box ref={ref}><Animation enabled={entry.isVisible}>...</Animation></Box>
 */
export function useTerminalViewport(): [
  ref: (element: DOMElement | null) => void,
  entry: ViewportEntry,
] {
  // 从上下文获取终端尺寸（行列数），终端 resize 时更新
  const terminalSize = useContext(TerminalSizeContext)
  // 保存绑定的 DOM 元素引用
  const elementRef = useRef<DOMElement | null>(null)
  // 可见性条目的 ref（不用 state，避免 layout effect 中的 setState 级联）
  const entryRef = useRef<ViewportEntry>({ isVisible: true })

  // 稳定的 ref callback，避免因函数引用变化导致 ref 重新触发
  const setElement = useCallback((el: DOMElement | null) => {
    elementRef.current = el
  }, [])

  // 每次渲染都重新计算（无依赖数组）：
  //  - Yoga 布局值可能在 React 感知不到的情况下变化
  //  - 只更新 ref，不调用 setState，避免 commit 阶段级联重渲染
  //  - 每次重新遍历 DOM 祖先链，避免持有因 yoga 树重建而失效的引用
  useLayoutEffect(() => {
    const element = elementRef.current
    // 元素未挂载或无 yogaNode（未参与布局）或终端尺寸未知时跳过
    if (!element?.yogaNode || !terminalSize) {
      return
    }

    // 读取元素自身的计算高度（行数）
    const height = element.yogaNode.getComputedHeight()
    // 终端行数（物理可见行）
    const rows = terminalSize.rows

    // 沿 DOM 父节点链向上累加位置，同时减去滚动容器的 scrollTop
    // 不使用 yoga.getParent() 是因为 ScrollBox 的 scrollTop 存储在 DOMElement 上，
    // 而 Yoga 计算位置时不考虑滚动偏移（滚动由 renderNodeToOutput 在渲染时应用）
    let absoluteTop = element.yogaNode.getComputedTop()
    let parent: DOMElement | undefined = element.parentNode
    let root = element.yogaNode
    while (parent) {
      if (parent.yogaNode) {
        // 累加父节点在布局中的顶部偏移
        absoluteTop += parent.yogaNode.getComputedTop()
        // 跟踪到最近的有 yogaNode 的祖先（最终会是根节点）
        root = parent.yogaNode
      }
      // 滚动容器有 scrollTop（只有 ScrollBox 会设置），减去滚动量修正绝对位置
      // 非滚动节点 scrollTop 为 undefined，falsy 快速跳过
      if (parent.scrollTop) absoluteTop -= parent.scrollTop
      parent = parent.parentNode
    }

    // 根节点的计算高度即为整个内容区的总高度
    const screenHeight = root.getComputedHeight()

    // 元素底部的绝对行号
    const bottom = absoluteTop + height
    // 当内容高度超过视口行数时，log-update 在光标恢复时多消耗 1 行滚回空间
    // （log-update.ts 中 scrollbackRows = viewportY + 1）
    // 此处需同步这个 +1，否则边界处的元素会被误认为可见，
    // 动画持续 tick → 内容变化 → log-update 全量重置 → 闪烁
    const cursorRestoreScroll = screenHeight > rows ? 1 : 0
    // 视口顶部在整个内容区中的行号（即内容超出视口的部分高度）
    const viewportY = Math.max(0, screenHeight - rows) + cursorRestoreScroll
    // 视口底部行号
    const viewportBottom = viewportY + rows
    // 判断元素区间与视口区间是否有交集
    const visible = bottom > viewportY && absoluteTop < viewportBottom

    // 仅在可见性真正变化时更新 entryRef（避免频繁创建新对象）
    if (visible !== entryRef.current.isVisible) {
      entryRef.current = { isVisible: visible }
    }
  })

  // 返回 ref callback 和可见性条目（读取当前 ref 值，渲染时不新建对象）
  return [setElement, entryRef.current]
}
