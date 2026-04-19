/**
 * plugin/usePagination.ts —— 通用滚动分页 React Hook
 *
 * 在整体流程中的位置：
 *   插件列表 / 市场列表等需要展示超过 maxVisible 条目的 JSX 组件
 *   → 调用 usePagination({ totalItems, maxVisible, selectedIndex })
 *   → 获得当前可见窗口的索引范围及各类工具方法
 *   → 组件按 startIndex/endIndex 截取数据渲染，用户上下导航时
 *     selectedIndex 变化自动驱动滚动偏移重新计算
 *
 * 设计要点：
 *   采用"连续滚动"而非"翻页"模型——可见窗口始终跟随选中项滑动，
 *   而不是整页跳转。保留 goToPage / nextPage / prevPage / handlePageNavigation
 *   等 API 仅为向后兼容，实际为空操作（no-op）。
 */
import { useCallback, useMemo, useRef } from 'react'

// 默认最多同时显示 5 条目
const DEFAULT_MAX_VISIBLE = 5

/** usePagination 的输入参数 */
type UsePaginationOptions = {
  totalItems: number       // 数据总条数
  maxVisible?: number      // 可见窗口大小，默认 5
  selectedIndex?: number   // 当前选中项的全局索引
}

/** usePagination 的返回值：包含分页状态和各类操作方法 */
type UsePaginationResult<T> = {
  // For backwards compatibility with page-based terminology
  currentPage: number      // 当前"页码"（兼容旧接口，按 maxVisible 分页计算）
  totalPages: number       // 总页数（兼容旧接口）
  startIndex: number       // 当前可见窗口的起始索引（全局）
  endIndex: number         // 当前可见窗口的结束索引（全局，不含）
  needsPagination: boolean // totalItems > maxVisible 时为 true，需要滚动
  pageSize: number         // 等于 maxVisible
  // Get visible slice of items
  getVisibleItems: (items: T[]) => T[]                          // 从全量数组中截取可见切片
  // Convert visible index to actual index
  toActualIndex: (visibleIndex: number) => number               // 可见索引 → 全局索引
  // Check if actual index is visible
  isOnCurrentPage: (actualIndex: number) => boolean             // 全局索引是否在当前可见窗口内
  // Navigation (kept for API compatibility)
  goToPage: (page: number) => void   // 空操作，保留旧接口
  nextPage: () => void               // 空操作，保留旧接口
  prevPage: () => void               // 空操作，保留旧接口
  // Handle selection - just updates the index, scrolling is automatic
  handleSelectionChange: (
    newIndex: number,
    setSelectedIndex: (index: number) => void,
  ) => void
  // Page navigation - returns false for continuous scrolling (not needed)
  handlePageNavigation: (
    direction: 'left' | 'right',
    setSelectedIndex: (index: number) => void,
  ) => boolean
  // Scroll position info for UI display
  scrollPosition: {
    current: number      // 当前选中项的 1-based 位置，供 UI 展示"x / total"
    total: number        // 总条数
    canScrollUp: boolean // 是否还有更多内容在可见窗口上方
    canScrollDown: boolean // 是否还有更多内容在可见窗口下方
  }
}

/**
 * usePagination —— 计算并维护列表的连续滚动状态
 *
 * 核心逻辑（scrollOffset 的计算，见 useMemo）：
 *   - 若 selectedIndex 超出可见窗口上边界 → 窗口上移至 selectedIndex
 *   - 若 selectedIndex 超出可见窗口下边界 → 窗口下移，使选中项位于末尾
 *   - 否则保持当前偏移，同时对超出末尾的 offset 做 clamp 防止越界
 *
 * 通过 scrollOffsetRef 跨 render 保存上一次偏移，实现平滑追踪
 * 而不是每次从 0 重新计算。
 */
export function usePagination<T>({
  totalItems,
  maxVisible = DEFAULT_MAX_VISIBLE,
  selectedIndex = 0,
}: UsePaginationOptions): UsePaginationResult<T> {
  // 当 totalItems 超出单屏容量时才需要分页/滚动
  const needsPagination = totalItems > maxVisible

  // Use a ref to track the previous scroll offset for smooth scrolling
  // 使用 ref 跨 render 追踪滚动偏移量，避免闭包陷阱
  const scrollOffsetRef = useRef(0)

  // Compute the scroll offset based on selectedIndex
  // This ensures the selected item is always visible
  // 根据 selectedIndex 动态计算滚动偏移，使选中项始终可见
  const scrollOffset = useMemo(() => {
    if (!needsPagination) return 0 // 无需分页时偏移恒为 0

    const prevOffset = scrollOffsetRef.current

    // If selected item is above the visible window, scroll up
    // 选中项在可见窗口上方：将窗口上移到选中项位置
    if (selectedIndex < prevOffset) {
      scrollOffsetRef.current = selectedIndex
      return selectedIndex
    }

    // If selected item is below the visible window, scroll down
    // 选中项在可见窗口下方：将窗口下移，使选中项出现在末行
    if (selectedIndex >= prevOffset + maxVisible) {
      const newOffset = selectedIndex - maxVisible + 1
      scrollOffsetRef.current = newOffset
      return newOffset
    }

    // Selected item is within visible window, keep current offset
    // But ensure offset is still valid
    // 选中项在可见范围内：保持当前偏移，但需 clamp 防止越界（如列表缩短后）
    const maxOffset = Math.max(0, totalItems - maxVisible)
    const clampedOffset = Math.min(prevOffset, maxOffset)
    scrollOffsetRef.current = clampedOffset
    return clampedOffset
  }, [selectedIndex, maxVisible, needsPagination, totalItems])

  // 可见窗口的起止全局索引
  const startIndex = scrollOffset
  const endIndex = Math.min(scrollOffset + maxVisible, totalItems) // 不超过总条数

  /**
   * getVisibleItems —— 从全量数组中截取当前可见切片
   * 不需要分页时直接返回原数组（引用稳定，避免不必要的重渲染）
   */
  const getVisibleItems = useCallback(
    (items: T[]): T[] => {
      if (!needsPagination) return items
      return items.slice(startIndex, endIndex) // 按滚动窗口截取
    },
    [needsPagination, startIndex, endIndex],
  )

  /**
   * toActualIndex —— 将可见列表内的相对索引转换为全局数组索引
   * 例：可见窗口从第 3 项开始，visibleIndex=1 → actualIndex=4
   */
  const toActualIndex = useCallback(
    (visibleIndex: number): number => {
      return startIndex + visibleIndex
    },
    [startIndex],
  )

  /**
   * isOnCurrentPage —— 判断某个全局索引是否处于当前可见窗口内
   * 用于高亮、焦点等需要判断可见性的场景
   */
  const isOnCurrentPage = useCallback(
    (actualIndex: number): boolean => {
      return actualIndex >= startIndex && actualIndex < endIndex
    },
    [startIndex, endIndex],
  )

  // These are mostly no-ops for continuous scrolling but kept for API compatibility
  // 以下三个方法为旧翻页 API 的兼容存根，连续滚动模式下均无实际操作
  const goToPage = useCallback((_page: number) => {
    // No-op - scrolling is controlled by selectedIndex
  }, [])

  const nextPage = useCallback(() => {
    // No-op - scrolling is controlled by selectedIndex
  }, [])

  const prevPage = useCallback(() => {
    // No-op - scrolling is controlled by selectedIndex
  }, [])

  // Simple selection handler - just updates the index
  // Scrolling happens automatically via the useMemo above
  /**
   * handleSelectionChange —— 更新选中索引并做边界 clamp
   * 滚动偏移会在下一次 useMemo 执行时自动跟随更新，无需手动处理
   */
  const handleSelectionChange = useCallback(
    (newIndex: number, setSelectedIndex: (index: number) => void) => {
      // 限制选中索引在 [0, totalItems-1] 范围内，防止越界
      const clampedIndex = Math.max(0, Math.min(newIndex, totalItems - 1))
      setSelectedIndex(clampedIndex)
    },
    [totalItems],
  )

  // Page navigation - disabled for continuous scrolling
  /**
   * handlePageNavigation —— 左右翻页占位方法
   * 连续滚动模式不支持页级跳转，始终返回 false 告知调用方操作未处理
   */
  const handlePageNavigation = useCallback(
    (
      _direction: 'left' | 'right',
      _setSelectedIndex: (index: number) => void,
    ): boolean => {
      return false // 连续滚动模式不支持页级导航
    },
    [],
  )

  // Calculate page-like values for backwards compatibility
  // 兼容旧 API 的页码计算：按 maxVisible 为步长虚拟分页
  const totalPages = Math.max(1, Math.ceil(totalItems / maxVisible))
  const currentPage = Math.floor(scrollOffset / maxVisible) // 当前处于第几"虚拟页"

  return {
    currentPage,
    totalPages,
    startIndex,
    endIndex,
    needsPagination,
    pageSize: maxVisible,
    getVisibleItems,
    toActualIndex,
    isOnCurrentPage,
    goToPage,
    nextPage,
    prevPage,
    handleSelectionChange,
    handlePageNavigation,
    scrollPosition: {
      current: selectedIndex + 1,                           // 1-based，供 "x / total" 格式显示
      total: totalItems,
      canScrollUp: scrollOffset > 0,                        // 窗口上方还有内容
      canScrollDown: scrollOffset + maxVisible < totalItems, // 窗口下方还有内容
    },
  }
}
