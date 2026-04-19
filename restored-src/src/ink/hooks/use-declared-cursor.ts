/**
 * @file hooks/use-declared-cursor.ts
 * @description 声明式终端光标定位 Hook，用于将光标停放到文本输入框的插入点。
 *
 * 在 Claude Code 的 Ink 渲染流水线中，本文件属于「光标管理」层：
 *   组件（文本输入框） → useDeclaredCursor（本文件） → CursorDeclarationContext
 *                                                              ↓
 *                                                    onRender 读取声明 → 写入终端光标位置
 *
 * 主要职责：
 *  - 让组件以声明式方式指定光标位置（相对于绑定节点的行列偏移）。
 *  - 处理多实例竞争（同一帧内多个输入框，只有 active 的那个应声明光标）。
 *  - 处理卸载清理（组件卸载时不残留过时的光标声明）。
 *  - 保证时序正确：声明在 onRender 之前完成（利用 useLayoutEffect + queueMicrotask 的顺序）。
 *
 * 应用场景：
 *  - CJK 输入法（IME）需要光标在物理位置显示预编辑文本。
 *  - 屏幕阅读器/放大镜等无障碍工具跟踪原生光标位置。
 */

import { useCallback, useContext, useLayoutEffect, useRef } from 'react'
import CursorDeclarationContext from '../components/CursorDeclarationContext.js'
import type { DOMElement } from '../dom.js'

/**
 * 声明终端光标应在本帧结束后停放的位置。
 *
 * 流程：
 *  1. 通过回调 ref（setNode）记录绑定的 DOM 元素到 nodeRef。
 *  2. 每次 commit 后（无 dep array 的 useLayoutEffect）：
 *     - 若 active 且节点存在：向 CursorDeclarationContext 设置声明（相对坐标 + 节点引用）。
 *     - 若 inactive：仅当当前声明属于本节点时才清除（防止覆盖其他实例的声明）。
 *  3. 组件卸载时（空 dep array 的 useLayoutEffect 的 cleanup）：有条件地清除声明。
 *
 * 多实例安全设计（节点身份检查）：
 *  - 场景 A：memo 化的 active 实例（如搜索框）未参与本次 commit，
 *    inactive 实例重渲染时不能误清除它的声明。
 *  - 场景 B：菜单项焦点按反向顺序移动时，newly-inactive 项的 effect
 *    晚于 newly-active 项执行，若不做检查会覆盖正确的声明。
 *
 * @param line   光标相对于绑定节点的行偏移（0-based）
 * @param column 光标相对于绑定节点的列偏移（0-based）
 * @param active 是否激活此光标声明（通常对应输入框的聚焦状态）
 * @returns 回调 ref，需绑定到包含输入框的 Box 元素
 */
export function useDeclaredCursor({
  line,
  column,
  active,
}: {
  line: number
  column: number
  active: boolean
}): (element: DOMElement | null) => void {
  // 从上下文获取设置光标声明的函数（由顶层 App 组件提供）
  const setCursorDeclaration = useContext(CursorDeclarationContext)
  // 持久化绑定节点的引用，避免每次渲染重新创建
  const nodeRef = useRef<DOMElement | null>(null)

  // 稳定的回调 ref，仅在挂载时创建一次，避免子组件不必要的重渲染
  const setNode = useCallback((node: DOMElement | null) => {
    nodeRef.current = node
  }, [])

  // 每次 commit 都重新声明（无 dep array），原因见文件头注释：
  //   - active 实例需要在其他实例的 unmount-cleanup 或兄弟切换后重新夺回声明权。
  // 节点身份检查解决两个竞态场景（见上方 JSDoc）。
  useLayoutEffect(() => {
    const node = nodeRef.current
    if (active && node) {
      // 激活状态：设置光标声明（相对坐标 + 节点引用，供 renderNodeToOutput 转换为绝对坐标）
      setCursorDeclaration({ relativeX: column, relativeY: line, node })
    } else {
      // 非激活状态：仅当声明属于本节点时才清除（传入 node 作为身份校验）
      setCursorDeclaration(null, node)
    }
  })

  // 卸载清理：仅在组件卸载时触发一次，不随 line/column 变化重复触发
  // 若在每次行/列变化时都清除，会在两次 commit 之间产生短暂的 null 状态
  useLayoutEffect(() => {
    return () => {
      // 条件性清除：如果此时其他实例已接管声明权，则不做任何操作
      setCursorDeclaration(null, nodeRef.current)
    }
  }, [setCursorDeclaration])

  return setNode
}
