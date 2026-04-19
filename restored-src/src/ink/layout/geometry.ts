/**
 * @file layout/geometry.ts
 * 布局几何基础类型与工具函数库
 *
 * 在 Claude Code 的 Ink 布局/渲染体系中，本文件处于最基础的几何抽象层，
 * 被整个渲染流水线广泛依赖：
 *   frame.ts（Size/viewport）、nodeCache（Rectangle/屏幕坐标）
 *   hit-test.ts（Point/坐标判断）、renderNodeToOutput（矩形裁剪）
 *   use-terminal-viewport.ts（Size/可见性计算）等
 *
 * 提供的基础类型：
 *  - Point    : 二维坐标 (x, y)
 *  - Size     : 宽高 (width, height)
 *  - Rectangle: Point + Size 的复合类型（屏幕矩形区域）
 *  - Edges    : 四边内边距/边框/外边距
 *
 * 提供的工具函数：
 *  - edges / addEdges / resolveEdges : Edges 创建与合并
 *  - unionRect   : 两矩形的包围盒
 *  - clampRect   : 将矩形裁剪到指定尺寸范围内
 *  - withinBounds: 点是否在尺寸范围内
 *  - clamp       : 数值范围限制
 */

/** 二维整数坐标（列, 行），对应终端屏幕坐标系 */
export type Point = {
  x: number
  y: number
}

/** 宽度和高度（字符列数 × 行数） */
export type Size = {
  width: number
  height: number
}

/** 屏幕矩形区域：左上角坐标 + 尺寸 */
export type Rectangle = Point & Size

/** 四边内边距 / 边框 / 外边距值（对应 CSS box model 的四条边） */
export type Edges = {
  top: number
  right: number
  bottom: number
  left: number
}

/**
 * 创建 Edges 对象的重载工厂函数（支持 1/2/4 参数形式，仿 CSS shorthand）。
 *
 * @overload edges(all)                         - 四边均为 all
 * @overload edges(vertical, horizontal)        - 上下为 vertical，左右为 horizontal
 * @overload edges(top, right, bottom, left)    - 四边独立指定
 */
export function edges(all: number): Edges
export function edges(vertical: number, horizontal: number): Edges
export function edges(
  top: number,
  right: number,
  bottom: number,
  left: number,
): Edges
export function edges(a: number, b?: number, c?: number, d?: number): Edges {
  if (b === undefined) {
    // 1 个参数：四边均等
    return { top: a, right: a, bottom: a, left: a }
  }
  if (c === undefined) {
    // 2 个参数：上下 = a，左右 = b
    return { top: a, right: b, bottom: a, left: b }
  }
  // 4 个参数：top, right, bottom, left
  return { top: a, right: b, bottom: c, left: d! }
}

/**
 * 将两个 Edges 对象逐边相加（用于合并内边距和边框）。
 *
 * @param a - 第一个 Edges
 * @param b - 第二个 Edges
 * @returns 各边之和组成的新 Edges
 */
export function addEdges(a: Edges, b: Edges): Edges {
  return {
    top: a.top + b.top,
    right: a.right + b.right,
    bottom: a.bottom + b.bottom,
    left: a.left + b.left,
  }
}

/** 所有边均为 0 的常量（避免重复创建零值对象） */
export const ZERO_EDGES: Edges = { top: 0, right: 0, bottom: 0, left: 0 }

/**
 * 将部分 Edges（Partial<Edges>）转换为完整 Edges，未指定的边默认为 0。
 *
 * @param partial - 可选的部分边值
 * @returns 完整 Edges 对象
 */
export function resolveEdges(partial?: Partial<Edges>): Edges {
  return {
    top: partial?.top ?? 0,
    right: partial?.right ?? 0,
    bottom: partial?.bottom ?? 0,
    left: partial?.left ?? 0,
  }
}

/**
 * 计算两个矩形的最小包围盒（并集）。
 * 结果矩形恰好能同时包含 a 和 b。
 *
 * @param a - 第一个矩形
 * @param b - 第二个矩形
 * @returns 包含两者的最小矩形
 */
export function unionRect(a: Rectangle, b: Rectangle): Rectangle {
  const minX = Math.min(a.x, b.x)
  const minY = Math.min(a.y, b.y)
  const maxX = Math.max(a.x + a.width, b.x + b.width)
  const maxY = Math.max(a.y + a.height, b.y + b.height)
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

/**
 * 将矩形裁剪到 [0, size.width-1] × [0, size.height-1] 范围内。
 * 若裁剪后宽或高为负则归零（矩形完全在范围外）。
 *
 * 用于确保绘制操作不超出终端屏幕边界。
 *
 * @param rect - 待裁剪的矩形
 * @param size - 目标区域尺寸（通常为终端宽高）
 * @returns 裁剪后的矩形
 */
export function clampRect(rect: Rectangle, size: Size): Rectangle {
  const minX = Math.max(0, rect.x)
  const minY = Math.max(0, rect.y)
  const maxX = Math.min(size.width - 1, rect.x + rect.width - 1)
  const maxY = Math.min(size.height - 1, rect.y + rect.height - 1)
  return {
    x: minX,
    y: minY,
    width: Math.max(0, maxX - minX + 1),   // 裁剪后宽度，最小为 0
    height: Math.max(0, maxY - minY + 1),  // 裁剪后高度，最小为 0
  }
}

/**
 * 判断点是否在 [0, size.width) × [0, size.height) 范围内（不含边界）。
 *
 * @param size  - 边界尺寸
 * @param point - 待检测的点
 * @returns 点是否在尺寸范围内
 */
export function withinBounds(size: Size, point: Point): boolean {
  return (
    point.x >= 0 &&
    point.y >= 0 &&
    point.x < size.width &&
    point.y < size.height
  )
}

/**
 * 将数值限制在 [min, max] 范围内（min/max 均可省略）。
 *
 * @param value - 待限制的数值
 * @param min   - 最小值（省略则不限下界）
 * @param max   - 最大值（省略则不限上界）
 * @returns 限制后的数值
 */
export function clamp(value: number, min?: number, max?: number): number {
  if (min !== undefined && value < min) return min
  if (max !== undefined && value > max) return max
  return value
}
