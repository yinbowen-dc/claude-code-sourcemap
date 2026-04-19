/**
 * @file layout/node.ts
 * Yoga 布局引擎适配器接口定义
 *
 * 在 Claude Code 的 Ink 布局体系中，本文件处于布局引擎抽象层的核心位置：
 *   React DOM reconciler（hostConfig）→ createLayoutNode（engine.ts）
 *   → 【本文件：LayoutNode 接口 + 枚举常量，屏蔽具体 Yoga API 细节】
 *   → yoga.ts（Yoga WASM 绑定，实现 LayoutNode 接口）
 *   → renderNodeToOutput（读取计算结果）/ get-max-width.ts 等
 *
 * 设计目的：
 *  - 将整个 Ink 代码库与 Yoga 特定 API 解耦：上层只依赖本文件的类型
 *  - 所有枚举常量以 const object + 类型别名的方式定义，兼顾运行时值访问
 *    和类型安全（避免引入 TypeScript enum 的各种边界问题）
 *  - 接口分区清晰：树操作 / 布局计算 / 样式设置 / 生命周期
 */

// -- 布局引擎适配器接口

/**
 * 边方向枚举：对应 CSS box model 的各个边和组合方向。
 * 用于 getComputedPadding / getComputedBorder / setMargin 等 API 的 edge 参数。
 */
export const LayoutEdge = {
  All: 'all',          // 所有边
  Horizontal: 'horizontal', // 左右两边
  Vertical: 'vertical',    // 上下两边
  Left: 'left',
  Right: 'right',
  Top: 'top',
  Bottom: 'bottom',
  Start: 'start',      // 行内起始方向（LTR 为左，RTL 为右）
  End: 'end',          // 行内结束方向
} as const
export type LayoutEdge = (typeof LayoutEdge)[keyof typeof LayoutEdge]

/**
 * 间距类型枚举：用于 setGap 的 gutter 参数。
 * 对应 CSS gap 属性的各轴方向。
 */
export const LayoutGutter = {
  All: 'all',      // 行列间距均设置
  Column: 'column', // 列间距（flex row 方向的子元素间距）
  Row: 'row',      // 行间距（flex column 方向的子元素间距）
} as const
export type LayoutGutter = (typeof LayoutGutter)[keyof typeof LayoutGutter]

/**
 * 显示模式枚举：对应 CSS display 属性（Yoga 仅支持 flex 和 none）。
 */
export const LayoutDisplay = {
  Flex: 'flex',  // 正常参与 flex 布局
  None: 'none',  // 从布局流中移除（不占空间）
} as const
export type LayoutDisplay = (typeof LayoutDisplay)[keyof typeof LayoutDisplay]

/**
 * Flex 排列方向枚举：对应 CSS flex-direction 属性。
 */
export const LayoutFlexDirection = {
  Row: 'row',                 // 水平方向（从左到右）
  RowReverse: 'row-reverse',  // 水平方向（从右到左）
  Column: 'column',           // 垂直方向（从上到下）
  ColumnReverse: 'column-reverse', // 垂直方向（从下到上）
} as const
export type LayoutFlexDirection =
  (typeof LayoutFlexDirection)[keyof typeof LayoutFlexDirection]

/**
 * 对齐方式枚举：对应 CSS align-items / align-self 属性。
 */
export const LayoutAlign = {
  Auto: 'auto',            // 继承父元素的对齐方式（仅 align-self 有效）
  Stretch: 'stretch',      // 拉伸填满交叉轴
  FlexStart: 'flex-start', // 交叉轴起始端对齐
  Center: 'center',        // 交叉轴居中对齐
  FlexEnd: 'flex-end',     // 交叉轴末端对齐
} as const
export type LayoutAlign = (typeof LayoutAlign)[keyof typeof LayoutAlign]

/**
 * 主轴内容分布枚举：对应 CSS justify-content 属性。
 */
export const LayoutJustify = {
  FlexStart: 'flex-start',     // 主轴起始端对齐
  Center: 'center',            // 主轴居中
  FlexEnd: 'flex-end',         // 主轴末端对齐
  SpaceBetween: 'space-between', // 两端对齐，子元素间均匀分布
  SpaceAround: 'space-around',  // 子元素两侧均匀分布
  SpaceEvenly: 'space-evenly',  // 所有间距（含两端）均匀分布
} as const
export type LayoutJustify = (typeof LayoutJustify)[keyof typeof LayoutJustify]

/**
 * Flex 换行枚举：对应 CSS flex-wrap 属性。
 */
export const LayoutWrap = {
  NoWrap: 'nowrap',          // 不换行（默认）
  Wrap: 'wrap',              // 超出时换行
  WrapReverse: 'wrap-reverse', // 超出时反向换行
} as const
export type LayoutWrap = (typeof LayoutWrap)[keyof typeof LayoutWrap]

/**
 * 定位方式枚举：对应 CSS position 属性（Yoga 仅支持 relative 和 absolute）。
 */
export const LayoutPositionType = {
  Relative: 'relative',  // 相对定位（参与正常文档流）
  Absolute: 'absolute',  // 绝对定位（脱离文档流，相对于最近 relative 祖先）
} as const
export type LayoutPositionType =
  (typeof LayoutPositionType)[keyof typeof LayoutPositionType]

/**
 * 溢出处理枚举：对应 CSS overflow 属性。
 */
export const LayoutOverflow = {
  Visible: 'visible', // 溢出内容可见（默认）
  Hidden: 'hidden',   // 溢出内容裁剪
  Scroll: 'scroll',   // 溢出内容可滚动
} as const
export type LayoutOverflow =
  (typeof LayoutOverflow)[keyof typeof LayoutOverflow]

/**
 * 布局测量函数类型：Yoga 调用此函数计算叶节点（文本节点）的尺寸。
 *
 * @param width     - 可用宽度（单位：字符列数）
 * @param widthMode - 约束模式（Undefined=无约束, Exactly=精确, AtMost=最大不超过）
 * @returns { width, height }：计算出的节点尺寸
 */
export type LayoutMeasureFunc = (
  width: number,
  widthMode: LayoutMeasureMode,
) => { width: number; height: number }

/**
 * 宽度约束模式枚举：Yoga 在两阶段测量中传入 measureFunc 的约束类型。
 *  - Undefined：无约束（Yoga 将用计算结果决定父容器宽度）
 *  - Exactly  ：精确宽度（须返回该宽度）
 *  - AtMost   ：最大不超过（可返回更小的值）
 */
export const LayoutMeasureMode = {
  Undefined: 'undefined', // 无宽度约束
  Exactly: 'exactly',     // 精确宽度约束
  AtMost: 'at-most',      // 最大宽度约束
} as const
export type LayoutMeasureMode =
  (typeof LayoutMeasureMode)[keyof typeof LayoutMeasureMode]

/**
 * 布局节点接口：对 Yoga 节点 API 的统一抽象。
 *
 * 每个 Ink 虚拟 DOM 节点（Box、Text 等）对应一个 LayoutNode，
 * 由 createLayoutNode（engine.ts）创建，Yoga WASM（yoga.ts）实现。
 *
 * 接口分为四个区域：
 *  1. 树操作    ：管理父子关系（对应 React reconciler 的 appendChild/removeChild）
 *  2. 布局计算  ：触发和读取 Yoga 计算结果
 *  3. 样式设置  ：映射 CSS-like 样式属性到 Yoga 节点
 *  4. 生命周期  ：释放 WASM 内存（Yoga 节点需手动释放）
 */
export type LayoutNode = {
  // ─── 树操作 ───────────────────────────────────────────────────────────────
  /** 在指定位置插入子节点（对应 appendChild/insertBefore） */
  insertChild(child: LayoutNode, index: number): void
  /** 移除子节点 */
  removeChild(child: LayoutNode): void
  /** 获取子节点数量 */
  getChildCount(): number
  /** 获取父节点（根节点返回 null） */
  getParent(): LayoutNode | null

  // ─── 布局计算 ──────────────────────────────────────────────────────────────
  /** 触发从此节点开始的布局计算（通常在根节点调用，传入终端宽高） */
  calculateLayout(width?: number, height?: number): void
  /** 设置叶节点的测量函数（文本节点用于计算折行后的尺寸） */
  setMeasureFunc(fn: LayoutMeasureFunc): void
  /** 移除测量函数（节点变为非叶节点时调用） */
  unsetMeasureFunc(): void
  /** 标记节点布局已失效，下次 calculateLayout 时重新测量 */
  markDirty(): void

  // ─── 布局结果读取（仅在 calculateLayout 后有效） ────────────────────────────
  /** 节点相对父节点的计算后左偏移（列数） */
  getComputedLeft(): number
  /** 节点相对父节点的计算后上偏移（行数） */
  getComputedTop(): number
  /** 节点计算后的总宽度（含内边距和边框，单位：列数） */
  getComputedWidth(): number
  /** 节点计算后的总高度（含内边距和边框，单位：行数） */
  getComputedHeight(): number
  /** 指定边的计算后边框宽度 */
  getComputedBorder(edge: LayoutEdge): number
  /** 指定边的计算后内边距 */
  getComputedPadding(edge: LayoutEdge): number

  // ─── 样式设置 ──────────────────────────────────────────────────────────────
  /** 设置固定宽度（字符列数） */
  setWidth(value: number): void
  /** 设置百分比宽度 */
  setWidthPercent(value: number): void
  /** 设置宽度为 auto（由内容/flex 决定） */
  setWidthAuto(): void
  /** 设置固定高度（行数） */
  setHeight(value: number): void
  /** 设置百分比高度 */
  setHeightPercent(value: number): void
  /** 设置高度为 auto */
  setHeightAuto(): void
  /** 设置最小宽度 */
  setMinWidth(value: number): void
  /** 设置百分比最小宽度 */
  setMinWidthPercent(value: number): void
  /** 设置最小高度 */
  setMinHeight(value: number): void
  /** 设置百分比最小高度 */
  setMinHeightPercent(value: number): void
  /** 设置最大宽度 */
  setMaxWidth(value: number): void
  /** 设置百分比最大宽度 */
  setMaxWidthPercent(value: number): void
  /** 设置最大高度 */
  setMaxHeight(value: number): void
  /** 设置百分比最大高度 */
  setMaxHeightPercent(value: number): void
  /** 设置 flex 主轴方向 */
  setFlexDirection(dir: LayoutFlexDirection): void
  /** 设置 flex 扩展系数（grow） */
  setFlexGrow(value: number): void
  /** 设置 flex 收缩系数（shrink） */
  setFlexShrink(value: number): void
  /** 设置 flex 基准尺寸（basis，固定值） */
  setFlexBasis(value: number): void
  /** 设置 flex 基准尺寸（百分比） */
  setFlexBasisPercent(value: number): void
  /** 设置 flex 换行方式 */
  setFlexWrap(wrap: LayoutWrap): void
  /** 设置交叉轴对齐（align-items，作用于所有子节点） */
  setAlignItems(align: LayoutAlign): void
  /** 设置自身交叉轴对齐（align-self，覆盖父节点的 align-items） */
  setAlignSelf(align: LayoutAlign): void
  /** 设置主轴内容分布（justify-content） */
  setJustifyContent(justify: LayoutJustify): void
  /** 设置显示模式（flex 或 none） */
  setDisplay(display: LayoutDisplay): void
  /** 获取当前显示模式 */
  getDisplay(): LayoutDisplay
  /** 设置定位方式（relative 或 absolute） */
  setPositionType(type: LayoutPositionType): void
  /** 设置指定边的偏移量（用于 absolute 定位） */
  setPosition(edge: LayoutEdge, value: number): void
  /** 设置指定边的百分比偏移量 */
  setPositionPercent(edge: LayoutEdge, value: number): void
  /** 设置溢出处理方式 */
  setOverflow(overflow: LayoutOverflow): void
  /** 设置指定边的外边距 */
  setMargin(edge: LayoutEdge, value: number): void
  /** 设置指定边的内边距 */
  setPadding(edge: LayoutEdge, value: number): void
  /** 设置指定边的边框宽度（终端中通常为字符宽度） */
  setBorder(edge: LayoutEdge, value: number): void
  /** 设置行/列方向的间距（gap） */
  setGap(gutter: LayoutGutter, value: number): void

  // ─── 生命周期 ──────────────────────────────────────────────────────────────
  /** 释放当前节点的 WASM 内存（不递归释放子节点） */
  free(): void
  /** 递归释放当前节点及其所有子节点的 WASM 内存 */
  freeRecursive(): void
}
