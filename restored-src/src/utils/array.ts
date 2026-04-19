/**
 * 数组通用工具函数模块。
 *
 * 提供 Claude Code 系统中常用的数组辅助函数：
 * - intersperse()：在数组元素之间插入分隔元素（用于 React 列表渲染）
 * - count()：统计满足谓词的元素数量
 * - uniq()：对可迭代对象去重
 */

/** 在数组每两个相邻元素之间插入由 separator 函数生成的分隔元素。 */
export function intersperse<A>(as: A[], separator: (index: number) => A): A[] {
  return as.flatMap((a, i) => (i ? [separator(i), a] : [a]))
}

/** 统计数组中满足谓词 pred 的元素数量。 */
export function count<T>(arr: readonly T[], pred: (x: T) => unknown): number {
  let n = 0
  for (const x of arr) n += +!!pred(x)
  return n
}

/** 对可迭代对象进行去重，保留首次出现的元素，返回数组。 */
export function uniq<T>(xs: Iterable<T>): T[] {
  return [...new Set(xs)]
}
