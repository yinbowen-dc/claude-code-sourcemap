/**
 * @file hooks/use-search-highlight.ts
 * @description 终端搜索高亮 Hook，将搜索关键词以屏幕空间反色方式高亮显示。
 *
 * 在 Claude Code 的 Ink 渲染流水线中，本文件属于「搜索高亮」层：
 *   用户输入搜索词 → useSearchHighlight（本文件） → Ink 实例（setSearchHighlight）
 *                                                          ↓
 *                                               renderToScreen（SGR 7 反色覆盖）→ 终端输出
 *
 * 主要职责：
 *  1. setQuery     : 设置全局搜索高亮词，下一帧所有匹配的可见文本将以反色（SGR 7）标注。
 *  2. scanElement  : 将指定 DOM 子树渲染到独立 Screen，扫描并返回匹配位置列表，
 *                    供滚动导航（上一个/下一个匹配）使用。
 *  3. setPositions : 设置当前高亮位置（黄色标注当前匹配项），配合滚动偏移更新。
 *
 * 设计理念：
 *  - 屏幕空间匹配：高亮的是终端实际渲染出的文本，而非消息原始内容。
 *    截断/省略后消失的文字不会高亮（符合用户预期：所见即所得）。
 *  - 通过 instances 全局 Map 找到当前 Ink 实例，与 useSelection 模式一致。
 *  - useMemo 使返回的函数引用稳定，调用方可安全放入 useEffect deps。
 */

import { useContext, useMemo } from 'react'
import StdinContext from '../components/StdinContext.js'
import type { DOMElement } from '../dom.js'
import instances from '../instances.js'
import type { MatchPosition } from '../render-to-screen.js'

/**
 * 返回控制搜索高亮的操作集合。
 *
 * 流程：
 *  1. 通过 useContext(StdinContext) 将此 Hook 锚定到 App 子树（满足 Hook 规则）。
 *  2. 从 instances 全局 Map 查找当前 Ink 实例（以 process.stdout 为键）。
 *  3. 用 useMemo 构建并缓存操作对象（ink 为单例，引用稳定）。
 *     - 若无 Ink 实例（非全屏模式或测试环境），返回空操作（no-op）。
 *
 * @returns 包含以下方法的对象：
 *  - setQuery(query)    : 设置搜索词；空字符串清除高亮
 *  - scanElement(el)    : 渲染 el 子树，返回匹配位置数组（元素相对坐标）
 *  - setPositions(state): 设置当前匹配位置及滚动偏移；null 清除
 */
export function useSearchHighlight(): {
  setQuery: (query: string) => void
  /** 将指定 DOM 子树（来自主树）渲染到独立 Screen 并扫描匹配位置。
   *  行坐标以元素顶部为 row 0，零重复上下文——元素本身就是带所有真实 Provider 构建的。 */
  scanElement: (el: DOMElement) => MatchPosition[]
  /** 基于位置的当前高亮：每帧在 positions[currentIdx] + rowOffset 处写黄色。
   *  扫描高亮（所有匹配反色）仍然运行——此黄色高亮叠加在上方。
   *  rowOffset 追踪滚动；positions 保持稳定（消息相对坐标）。null 清除。 */
  setPositions: (
    state: {
      positions: MatchPosition[]
      rowOffset: number
      currentIdx: number
    } | null,
  ) => void
} {
  // 锚定到 App 子树，确保此 Hook 在正确的 React 树中使用（满足 Hook 规则）
  useContext(StdinContext) // anchor to App subtree for hook rules
  // 通过 stdout 查找当前 Ink 实例（全局单例）
  const ink = instances.get(process.stdout)
  // 用 useMemo 缓存操作对象，ink 为单例故引用稳定，不会频繁触发依赖此对象的 effect
  return useMemo(() => {
    if (!ink) {
      // Ink 实例不存在时返回空操作，防止调用方抛出异常
      return {
        setQuery: () => {},
        scanElement: () => [],
        setPositions: () => {},
      }
    }
    return {
      // 代理到 Ink 实例的搜索高亮方法
      setQuery: (query: string) => ink.setSearchHighlight(query),
      // 代理到 Ink 实例的元素子树扫描方法
      scanElement: (el: DOMElement) => ink.scanElementSubtree(el),
      // 代理到 Ink 实例的位置高亮设置方法
      setPositions: state => ink.setSearchPositions(state),
    }
  }, [ink])
}
