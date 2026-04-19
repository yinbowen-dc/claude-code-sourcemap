/**
 * @file hooks/use-selection.ts
 * @description 终端文本选择操作 Hook，提供全屏模式下的鼠标/键盘文本选取能力。
 *
 * 在 Claude Code 的 Ink 渲染流水线中，本文件属于「文本选择」层：
 *   鼠标/键盘事件 → useSelection（本文件） → Ink 实例（selection.ts 状态机）
 *                                                    ↓
 *                                         renderToScreen（SGR 反色/背景色覆盖）→ 终端输出
 *
 * 主要职责：
 *  1. useSelection    : 返回一组操作选区的函数（复制、清除、键盘扩展、滚动捕获等）。
 *                       通过 useMemo 保证引用稳定，可安全放入 useEffect deps。
 *  2. useHasSelection : 响应式状态 Hook，当选区创建/清除时触发重渲染。
 *                       使用 useSyncExternalStore 确保外部状态与 React 渲染一致。
 *
 * 设计说明：
 *  - 仅在全屏（alt-screen）模式下可用；非全屏时返回 no-op 函数和 false。
 *  - 通过 instances 全局 Map 找到 Ink 实例，键为 process.stdout（每个进程唯一）。
 *  - 选区状态（SelectionState）存储在 Ink 实例中，不在 React 状态树里，
 *    以避免每次鼠标拖动都触发全量 React 重渲染。
 */

import { useContext, useMemo, useSyncExternalStore } from 'react'
import StdinContext from '../components/StdinContext.js'
import instances from '../instances.js'
import {
  type FocusMove,
  type SelectionState,
  shiftAnchor,
} from '../selection.js'

/**
 * 返回文本选择操作集合（全屏模式专属）。
 *
 * 流程：
 *  1. 通过 useContext(StdinContext) 锚定到 App 子树。
 *  2. 从 instances Map 查找 Ink 实例。
 *  3. useMemo 构建并缓存操作对象（ink 单例，引用稳定）。
 *     - 无 Ink 实例时返回全 no-op 对象。
 *
 * 返回的方法说明：
 *  - copySelection()          : 复制选中文本并清除高亮
 *  - copySelectionNoClear()   : 复制但不清除（用于「选中即复制」模式）
 *  - clearSelection()         : 清除选区
 *  - hasSelection()           : 是否存在非空选区（即时读取，非响应式）
 *  - getState()               : 读取原始可变 SelectionState（供拖拽滚动使用）
 *  - subscribe(cb)            : 订阅选区变更通知（供 useSyncExternalStore 使用）
 *  - shiftAnchor(dRow, ...)   : 将锚点行偏移 dRow，夹紧到 [minRow, maxRow]
 *  - shiftSelection(dRow, ...) : 同时移动锚点和焦点（键盘滚动：整个选区跟随内容移动）
 *  - moveFocus(move)          : 键盘选区扩展（Shift+方向键），移动焦点，锚点固定
 *  - captureScrolledRows(...) : 捕获即将滚出视口的行文本（须在 scrollBy 前调用）
 *  - setSelectionBgColor(color): 设置选区背景色（主题颜色管道，替代 SGR-7 反色）
 */
export function useSelection(): {
  copySelection: () => string
  /** 复制但不清除高亮（用于选中即复制模式） */
  copySelectionNoClear: () => string
  clearSelection: () => void
  hasSelection: () => boolean
  /** 读取原始可变选区状态（供拖拽滚动使用） */
  getState: () => SelectionState | null
  /** 订阅选区变更（开始/更新/结束/清除） */
  subscribe: (cb: () => void) => () => void
  /** 将锚点行偏移 dRow，夹紧到 [minRow, maxRow] */
  shiftAnchor: (dRow: number, minRow: number, maxRow: number) => void
  /** 同时移动锚点和焦点（键盘滚动：整个选区跟随内容移动）。
   *  夹紧的端点列会重置为全宽边缘，因其内容已被 captureScrolledRows 捕获。
   *  列重置边界从 ink 实例的 screen.width 读取。 */
  shiftSelection: (dRow: number, minRow: number, maxRow: number) => void
  /** 键盘选区扩展（Shift+方向键）：移动焦点，锚点固定。
   *  左右方向跨行折回；上下方向在视口边缘夹紧。 */
  moveFocus: (move: FocusMove) => void
  /** 捕获即将滚出视口的行文本（须在 scrollBy 前调用，此时屏幕缓冲区仍有待出行） */
  captureScrolledRows: (
    firstRow: number,
    lastRow: number,
    side: 'above' | 'below',
  ) => void
  /** 设置选区高亮背景色（主题颜色管道；纯色背景取代旧 SGR-7 反色，
   *  使语法高亮在选中状态下保持可读）。挂载时调用一次，主题变更时再次调用。 */
  setSelectionBgColor: (color: string) => void
} {
  // 锚定到 App 子树，满足 React Hook 规则（不在条件语句中调用 Hook）
  useContext(StdinContext) // anchor to App subtree for hook rules
  // 通过 process.stdout 查找 Ink 实例（全进程唯一）
  const ink = instances.get(process.stdout)
  // useMemo：ink 为单例，引用稳定 → 操作对象引用稳定 → 调用方可安全放入 deps
  return useMemo(() => {
    if (!ink) {
      // 非全屏模式或测试环境：返回全 no-op，防止调用方异常
      return {
        copySelection: () => '',
        copySelectionNoClear: () => '',
        clearSelection: () => {},
        hasSelection: () => false,
        getState: () => null,
        subscribe: () => () => {},
        shiftAnchor: () => {},
        shiftSelection: () => {},
        moveFocus: () => {},
        captureScrolledRows: () => {},
        setSelectionBgColor: () => {},
      }
    }
    return {
      // 复制选中文本并清除高亮
      copySelection: () => ink.copySelection(),
      // 复制但保留高亮（选中即复制模式）
      copySelectionNoClear: () => ink.copySelectionNoClear(),
      // 清除选区
      clearSelection: () => ink.clearTextSelection(),
      // 即时查询是否有非空选区
      hasSelection: () => ink.hasTextSelection(),
      // 读取原始可变选区状态（绕过 React 状态，供拖拽逻辑直接访问）
      getState: () => ink.selection,
      // 订阅选区变更事件
      subscribe: (cb: () => void) => ink.subscribeToSelectionChange(cb),
      // 锚点偏移（选区单端移动）
      shiftAnchor: (dRow: number, minRow: number, maxRow: number) =>
        shiftAnchor(ink.selection, dRow, minRow, maxRow),
      // 整体选区偏移（键盘滚动时跟随内容）
      shiftSelection: (dRow, minRow, maxRow) =>
        ink.shiftSelectionForScroll(dRow, minRow, maxRow),
      // 键盘选区焦点移动（Shift+方向键）
      moveFocus: (move: FocusMove) => ink.moveSelectionFocus(move),
      // 捕获即将离开视口的行（须在 scrollBy 前调用）
      captureScrolledRows: (firstRow, lastRow, side) =>
        ink.captureScrolledRows(firstRow, lastRow, side),
      // 设置选区背景色（主题颜色同步）
      setSelectionBgColor: (color: string) => ink.setSelectionBgColor(color),
    }
  }, [ink])
}

/** useSyncExternalStore 的空订阅函数（无 Ink 实例时使用） */
const NO_SUBSCRIBE = () => () => {}
/** useSyncExternalStore 的快照函数（无 Ink 实例时始终返回 false） */
const ALWAYS_FALSE = () => false

/**
 * 响应式「是否存在文本选区」状态 Hook。
 *
 * 使用 useSyncExternalStore 订阅 Ink 实例的选区变更事件：
 *  - 选区创建时触发重渲染（返回 true）。
 *  - 选区清除时触发重渲染（返回 false）。
 *  - 非全屏模式（无 Ink 实例）时始终返回 false。
 *
 * 相比手动 useState + useEffect 订阅，useSyncExternalStore 在并发模式下
 * 能保证快照与订阅回调的一致性，避免撕裂（tearing）。
 *
 * @returns 当前是否存在文本选区
 */
export function useHasSelection(): boolean {
  // 锚定到 App 子树
  useContext(StdinContext)
  // 查找 Ink 实例
  const ink = instances.get(process.stdout)
  // 使用 useSyncExternalStore 订阅外部选区状态
  return useSyncExternalStore(
    // 订阅函数：有 Ink 实例时订阅选区变更，否则使用空订阅
    ink ? ink.subscribeToSelectionChange : NO_SUBSCRIBE,
    // 快照函数：有 Ink 实例时读取当前是否有选区，否则始终返回 false
    ink ? ink.hasTextSelection : ALWAYS_FALSE,
  )
}
