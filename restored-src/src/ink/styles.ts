/**
 * 文件：styles.ts
 *
 * 【在 Claude Code 系统流程中的位置】
 * 本文件是 Ink 渲染层的"样式系统核心"。
 * Claude Code 的 React 组件（Box、Text 等）通过 `style` prop 传入样式对象（`Styles`），
 * 在 DOM 节点挂载或更新时，渲染器调用本文件导出的 `styles()` 函数，
 * 将高层 CSS-like 样式属性映射到底层 Yoga（Facebook 的 Flex 布局引擎）节点 API 调用。
 *
 * 【主要功能】
 * 1. 定义 `Styles` 类型：Ink 组件可用的全部样式属性（对齐、间距、边框、溢出等）
 * 2. 定义 `TextStyles`、颜色类型等文本样式辅助类型
 * 3. 将 `Styles` 对象中的各类属性分组（位置/溢出/边距/内边距/Flex/尺寸/显示/边框/间距），
 *    逐组调用对应的 `applyXxxStyles` 函数，将属性值写入 Yoga `LayoutNode`
 */

import {
  LayoutAlign,
  LayoutDisplay,
  LayoutEdge,
  LayoutFlexDirection,
  LayoutGutter,
  LayoutJustify,
  type LayoutNode,
  LayoutOverflow,
  LayoutPositionType,
  LayoutWrap,
} from './layout/node.js'
import type { BorderStyle, BorderTextOptions } from './render-border.js'

// ─── 颜色类型定义 ──────────────────────────────────────────────────────────────

/** RGB 颜色字面量类型，例如 `rgb(255,0,0)` */
export type RGBColor = `rgb(${number},${number},${number})`
/** 十六进制颜色字面量类型，例如 `#ff0000` */
export type HexColor = `#${string}`
/** ANSI 256 色索引类型，例如 `ansi256(196)` */
export type Ansi256Color = `ansi256(${number})`
/** 16 色 ANSI 命名颜色类型 */
export type AnsiColor =
  | 'ansi:black'
  | 'ansi:red'
  | 'ansi:green'
  | 'ansi:yellow'
  | 'ansi:blue'
  | 'ansi:magenta'
  | 'ansi:cyan'
  | 'ansi:white'
  | 'ansi:blackBright'
  | 'ansi:redBright'
  | 'ansi:greenBright'
  | 'ansi:yellowBright'
  | 'ansi:blueBright'
  | 'ansi:magentaBright'
  | 'ansi:cyanBright'
  | 'ansi:whiteBright'

/** 原始颜色值类型（非主题键）——是以上四种颜色表示的联合类型 */
export type Color = RGBColor | HexColor | Ansi256Color | AnsiColor

/**
 * 文本样式属性结构。
 * 用于描述文本的外观样式，不依赖 ANSI 字符串变换，
 * 颜色为原始值（主题解析在组件层完成）。
 */
export type TextStyles = {
  readonly color?: Color
  readonly backgroundColor?: Color
  readonly dim?: boolean
  readonly bold?: boolean
  readonly italic?: boolean
  readonly underline?: boolean
  readonly strikethrough?: boolean
  readonly inverse?: boolean
}

// ─── Styles 类型：Ink 组件的完整样式属性集 ─────────────────────────────────────

export type Styles = {
  readonly textWrap?:
    | 'wrap'
    | 'wrap-trim'
    | 'end'
    | 'middle'
    | 'truncate-end'
    | 'truncate'
    | 'truncate-middle'
    | 'truncate-start'

  readonly position?: 'absolute' | 'relative'
  readonly top?: number | `${number}%`
  readonly bottom?: number | `${number}%`
  readonly left?: number | `${number}%`
  readonly right?: number | `${number}%`

  /**
   * 元素列之间的间距大小。
   */
  readonly columnGap?: number

  /**
   * 元素行之间的间距大小。
   */
  readonly rowGap?: number

  /**
   * 元素列和行之间的间距大小。`columnGap` 和 `rowGap` 的简写形式。
   */
  readonly gap?: number

  /**
   * 四边外边距。等同于同时设置 `marginTop`、`marginBottom`、`marginLeft` 和 `marginRight`。
   */
  readonly margin?: number

  /**
   * 水平外边距。等同于同时设置 `marginLeft` 和 `marginRight`。
   */
  readonly marginX?: number

  /**
   * 垂直外边距。等同于同时设置 `marginTop` 和 `marginBottom`。
   */
  readonly marginY?: number

  /**
   * 顶部外边距。
   */
  readonly marginTop?: number

  /**
   * 底部外边距。
   */
  readonly marginBottom?: number

  /**
   * 左侧外边距。
   */
  readonly marginLeft?: number

  /**
   * 右侧外边距。
   */
  readonly marginRight?: number

  /**
   * 四边内边距。等同于同时设置 `paddingTop`、`paddingBottom`、`paddingLeft` 和 `paddingRight`。
   */
  readonly padding?: number

  /**
   * 水平内边距。等同于同时设置 `paddingLeft` 和 `paddingRight`。
   */
  readonly paddingX?: number

  /**
   * 垂直内边距。等同于同时设置 `paddingTop` 和 `paddingBottom`。
   */
  readonly paddingY?: number

  /**
   * 顶部内边距。
   */
  readonly paddingTop?: number

  /**
   * 底部内边距。
   */
  readonly paddingBottom?: number

  /**
   * 左侧内边距。
   */
  readonly paddingLeft?: number

  /**
   * 右侧内边距。
   */
  readonly paddingRight?: number

  /**
   * 定义 flex 子项在必要时的放大能力。
   * 参见 [flex-grow](https://css-tricks.com/almanac/properties/f/flex-grow/)。
   */
  readonly flexGrow?: number

  /**
   * 定义 flex 子项的收缩因子，决定空间不足时子项的收缩比例。
   * 参见 [flex-shrink](https://css-tricks.com/almanac/properties/f/flex-shrink/)。
   */
  readonly flexShrink?: number

  /**
   * 定义主轴方向，即 flex 子项的排列方向。
   * 参见 [flex-direction](https://css-tricks.com/almanac/properties/f/flex-direction/)。
   */
  readonly flexDirection?: 'row' | 'column' | 'row-reverse' | 'column-reverse'

  /**
   * 定义 flex 子项的初始尺寸（在分配剩余空间之前）。
   * 参见 [flex-basis](https://css-tricks.com/almanac/properties/f/flex-basis/)。
   */
  readonly flexBasis?: number | string

  /**
   * 定义 flex 子项是否强制在同一行，或允许换行到多行。
   * 参见 [flex-wrap](https://css-tricks.com/almanac/properties/f/flex-wrap/)。
   */
  readonly flexWrap?: 'nowrap' | 'wrap' | 'wrap-reverse'

  /**
   * 定义 flex 子项在交叉轴上的默认对齐方式。
   * 参见 [align-items](https://css-tricks.com/almanac/properties/a/align-items/)。
   */
  readonly alignItems?: 'flex-start' | 'center' | 'flex-end' | 'stretch'

  /**
   * 允许单个 flex 子项覆盖 `align-items` 的对齐方式。
   * 参见 [align-self](https://css-tricks.com/almanac/properties/a/align-self/)。
   */
  readonly alignSelf?: 'flex-start' | 'center' | 'flex-end' | 'auto'

  /**
   * 定义主轴方向上的对齐方式。
   * 参见 [justify-content](https://css-tricks.com/almanac/properties/j/justify-content/)。
   */
  readonly justifyContent?:
    | 'flex-start'
    | 'flex-end'
    | 'space-between'
    | 'space-around'
    | 'space-evenly'
    | 'center'

  /**
   * 元素宽度（单位：空格列数）。
   * 也可设置为百分比，基于父元素宽度计算。
   */
  readonly width?: number | string

  /**
   * 元素高度（单位：行数）。
   * 也可设置为百分比，基于父元素高度计算。
   */
  readonly height?: number | string

  /**
   * 最小宽度。
   */
  readonly minWidth?: number | string

  /**
   * 最小高度。
   */
  readonly minHeight?: number | string

  /**
   * 最大宽度。
   */
  readonly maxWidth?: number | string

  /**
   * 最大高度。
   */
  readonly maxHeight?: number | string

  /**
   * 将此属性设置为 `none` 可隐藏元素（等同于 CSS 的 `display: none`）。
   */
  readonly display?: 'flex' | 'none'

  /**
   * 指定边框样式。若为 `undefined`（默认），则不显示边框。
   */
  readonly borderStyle?: BorderStyle

  /**
   * 是否显示顶部边框。
   *
   * @default true
   */
  readonly borderTop?: boolean

  /**
   * 是否显示底部边框。
   *
   * @default true
   */
  readonly borderBottom?: boolean

  /**
   * 是否显示左侧边框。
   *
   * @default true
   */
  readonly borderLeft?: boolean

  /**
   * 是否显示右侧边框。
   *
   * @default true
   */
  readonly borderRight?: boolean

  /**
   * 边框颜色（四边统一设置）。
   * 是 `borderTopColor`、`borderRightColor`、`borderBottomColor`、`borderLeftColor` 的简写。
   */
  readonly borderColor?: Color

  /**
   * 顶部边框颜色（接受 rgb、hex、ansi 等原始颜色值）。
   */
  readonly borderTopColor?: Color

  /**
   * 底部边框颜色（接受 rgb、hex、ansi 等原始颜色值）。
   */
  readonly borderBottomColor?: Color

  /**
   * 左侧边框颜色（接受 rgb、hex、ansi 等原始颜色值）。
   */
  readonly borderLeftColor?: Color

  /**
   * 右侧边框颜色（接受 rgb、hex、ansi 等原始颜色值）。
   */
  readonly borderRightColor?: Color

  /**
   * 是否对边框颜色应用 dim（变暗）效果（四边统一）。
   *
   * @default false
   */
  readonly borderDimColor?: boolean

  /**
   * 顶部边框是否 dim。
   *
   * @default false
   */
  readonly borderTopDimColor?: boolean

  /**
   * 底部边框是否 dim。
   *
   * @default false
   */
  readonly borderBottomDimColor?: boolean

  /**
   * 左侧边框是否 dim。
   *
   * @default false
   */
  readonly borderLeftDimColor?: boolean

  /**
   * 右侧边框是否 dim。
   *
   * @default false
   */
  readonly borderRightDimColor?: boolean

  /**
   * 在边框内嵌入文字（仅适用于顶部或底部边框）。
   */
  readonly borderText?: BorderTextOptions

  /**
   * 盒子背景色。
   * 用背景色填充内部区域（含内边距），子文本节点默认继承此背景。
   */
  readonly backgroundColor?: Color

  /**
   * 在渲染子内容前，用空格填充盒子内部（含内边距），
   * 使其后方内容不可见，但不发出任何 SGR 序列（使用终端默认背景）。
   * 适用于绝对定位叠加层，避免 Box 内边距/间隙透出背后内容。
   */
  readonly opaque?: boolean

  /**
   * 元素溢出行为（两个方向）。
   * 'scroll'：约束容器尺寸（子元素不扩展容器），并在渲染时启用基于 scrollTop 的虚拟滚动。
   *
   * @default 'visible'
   */
  readonly overflow?: 'visible' | 'hidden' | 'scroll'

  /**
   * 水平方向溢出行为。
   *
   * @default 'visible'
   */
  readonly overflowX?: 'visible' | 'hidden' | 'scroll'

  /**
   * 垂直方向溢出行为。
   *
   * @default 'visible'
   */
  readonly overflowY?: 'visible' | 'hidden' | 'scroll'

  /**
   * 在全屏模式下将此盒子内的单元格排除在文本选择范围之外。
   * 用于隔离行号、diff 符号等边栏区域，使拖拽选择只复制实际代码内容。
   * 仅影响备用屏幕（alt-screen）的文本选择，其他情况无效。
   *
   * `'from-left-edge'`：将排除区从第 0 列扩展到盒子右边缘，
   * 覆盖所有上游缩进（工具消息前缀、树形线条），
   * 防止多行拖拽时中间行的前导空白被选中。
   */
  readonly noSelect?: boolean | 'from-left-edge'
}

// ─── applyXxxStyles 系列函数：将 Styles 属性写入 Yoga LayoutNode ──────────────

/**
 * 将 position 相关属性（position/top/bottom/left/right）写入布局节点。
 * `position: 'absolute'` → LayoutPositionType.Absolute，其余为 Relative。
 */
const applyPositionStyles = (node: LayoutNode, style: Styles): void => {
  if ('position' in style) {
    node.setPositionType(
      style.position === 'absolute'
        ? LayoutPositionType.Absolute
        : LayoutPositionType.Relative,
    )
  }
  // 分别处理四个方向的定位值
  if ('top' in style) applyPositionEdge(node, 'top', style.top)
  if ('bottom' in style) applyPositionEdge(node, 'bottom', style.bottom)
  if ('left' in style) applyPositionEdge(node, 'left', style.left)
  if ('right' in style) applyPositionEdge(node, 'right', style.right)
}

/**
 * 将单个定位边的值（数值或百分比字符串）写入布局节点。
 * - 字符串（如 "50%"）→ 调用 setPositionPercent
 * - 数值 → 调用 setPosition
 * - undefined → 设置为 NaN（清除该边的约束）
 */
function applyPositionEdge(
  node: LayoutNode,
  edge: 'top' | 'bottom' | 'left' | 'right',
  v: number | `${number}%` | undefined,
): void {
  if (typeof v === 'string') {
    // 百分比字符串：解析整数部分传给 setPositionPercent
    node.setPositionPercent(edge, Number.parseInt(v, 10))
  } else if (typeof v === 'number') {
    node.setPosition(edge, v)
  } else {
    // 未设置：传 NaN 表示"自动"
    node.setPosition(edge, Number.NaN)
  }
}

/**
 * 将 overflow 相关属性写入布局节点。
 *
 * Yoga 的 Overflow 控制子元素是否能撑大容器：
 * - 'hidden' 和 'scroll' 都阻止子元素扩展容器
 * - 'scroll' 额外告知渲染器需要应用 scrollTop 平移
 * - overflowX/Y 是渲染时关注的细节，布局层取两者的最大约束（优先 scroll > hidden > visible）
 */
const applyOverflowStyles = (node: LayoutNode, style: Styles): void => {
  // 垂直方向：优先使用 overflowY，回退到 overflow
  const y = style.overflowY ?? style.overflow
  // 水平方向：优先使用 overflowX，回退到 overflow
  const x = style.overflowX ?? style.overflow
  if (y === 'scroll' || x === 'scroll') {
    node.setOverflow(LayoutOverflow.Scroll)
  } else if (y === 'hidden' || x === 'hidden') {
    node.setOverflow(LayoutOverflow.Hidden)
  } else if (
    'overflow' in style ||
    'overflowX' in style ||
    'overflowY' in style
  ) {
    // 显式设置为 visible（不能用 undefined 判断，因为属性可能被显式置为 'visible'）
    node.setOverflow(LayoutOverflow.Visible)
  }
}

/**
 * 将外边距属性写入布局节点。
 * 支持简写（margin / marginX / marginY）和四方向单独设置。
 * 注意优先级：后声明的单方向属性会覆盖简写属性在该方向的效果。
 */
const applyMarginStyles = (node: LayoutNode, style: Styles): void => {
  if ('margin' in style) {
    // margin：四边统一设置
    node.setMargin(LayoutEdge.All, style.margin ?? 0)
  }

  if ('marginX' in style) {
    // marginX：水平方向（左 + 右）
    node.setMargin(LayoutEdge.Horizontal, style.marginX ?? 0)
  }

  if ('marginY' in style) {
    // marginY：垂直方向（上 + 下）
    node.setMargin(LayoutEdge.Vertical, style.marginY ?? 0)
  }

  if ('marginLeft' in style) {
    node.setMargin(LayoutEdge.Start, style.marginLeft || 0)
  }

  if ('marginRight' in style) {
    node.setMargin(LayoutEdge.End, style.marginRight || 0)
  }

  if ('marginTop' in style) {
    node.setMargin(LayoutEdge.Top, style.marginTop || 0)
  }

  if ('marginBottom' in style) {
    node.setMargin(LayoutEdge.Bottom, style.marginBottom || 0)
  }
}

/**
 * 将内边距属性写入布局节点。
 * 结构与 applyMarginStyles 对称，支持简写和四方向单独设置。
 */
const applyPaddingStyles = (node: LayoutNode, style: Styles): void => {
  if ('padding' in style) {
    // padding：四边统一设置
    node.setPadding(LayoutEdge.All, style.padding ?? 0)
  }

  if ('paddingX' in style) {
    // paddingX：水平方向（左 + 右）
    node.setPadding(LayoutEdge.Horizontal, style.paddingX ?? 0)
  }

  if ('paddingY' in style) {
    // paddingY：垂直方向（上 + 下）
    node.setPadding(LayoutEdge.Vertical, style.paddingY ?? 0)
  }

  if ('paddingLeft' in style) {
    node.setPadding(LayoutEdge.Left, style.paddingLeft || 0)
  }

  if ('paddingRight' in style) {
    node.setPadding(LayoutEdge.Right, style.paddingRight || 0)
  }

  if ('paddingTop' in style) {
    node.setPadding(LayoutEdge.Top, style.paddingTop || 0)
  }

  if ('paddingBottom' in style) {
    node.setPadding(LayoutEdge.Bottom, style.paddingBottom || 0)
  }
}

/**
 * 将 Flex 布局属性写入布局节点。
 * 覆盖：flexGrow / flexShrink / flexWrap / flexDirection / flexBasis /
 *       alignItems / alignSelf / justifyContent
 */
const applyFlexStyles = (node: LayoutNode, style: Styles): void => {
  if ('flexGrow' in style) {
    node.setFlexGrow(style.flexGrow ?? 0)
  }

  if ('flexShrink' in style) {
    // flexShrink 默认值为 1（当未提供数值时）
    node.setFlexShrink(
      typeof style.flexShrink === 'number' ? style.flexShrink : 1,
    )
  }

  if ('flexWrap' in style) {
    if (style.flexWrap === 'nowrap') {
      node.setFlexWrap(LayoutWrap.NoWrap)
    }

    if (style.flexWrap === 'wrap') {
      node.setFlexWrap(LayoutWrap.Wrap)
    }

    if (style.flexWrap === 'wrap-reverse') {
      node.setFlexWrap(LayoutWrap.WrapReverse)
    }
  }

  if ('flexDirection' in style) {
    if (style.flexDirection === 'row') {
      node.setFlexDirection(LayoutFlexDirection.Row)
    }

    if (style.flexDirection === 'row-reverse') {
      node.setFlexDirection(LayoutFlexDirection.RowReverse)
    }

    if (style.flexDirection === 'column') {
      node.setFlexDirection(LayoutFlexDirection.Column)
    }

    if (style.flexDirection === 'column-reverse') {
      node.setFlexDirection(LayoutFlexDirection.ColumnReverse)
    }
  }

  if ('flexBasis' in style) {
    if (typeof style.flexBasis === 'number') {
      node.setFlexBasis(style.flexBasis)
    } else if (typeof style.flexBasis === 'string') {
      // 百分比字符串：解析整数部分
      node.setFlexBasisPercent(Number.parseInt(style.flexBasis, 10))
    } else {
      // 未设置：传 NaN 表示"自动"
      node.setFlexBasis(Number.NaN)
    }
  }

  if ('alignItems' in style) {
    if (style.alignItems === 'stretch' || !style.alignItems) {
      node.setAlignItems(LayoutAlign.Stretch)
    }

    if (style.alignItems === 'flex-start') {
      node.setAlignItems(LayoutAlign.FlexStart)
    }

    if (style.alignItems === 'center') {
      node.setAlignItems(LayoutAlign.Center)
    }

    if (style.alignItems === 'flex-end') {
      node.setAlignItems(LayoutAlign.FlexEnd)
    }
  }

  if ('alignSelf' in style) {
    if (style.alignSelf === 'auto' || !style.alignSelf) {
      node.setAlignSelf(LayoutAlign.Auto)
    }

    if (style.alignSelf === 'flex-start') {
      node.setAlignSelf(LayoutAlign.FlexStart)
    }

    if (style.alignSelf === 'center') {
      node.setAlignSelf(LayoutAlign.Center)
    }

    if (style.alignSelf === 'flex-end') {
      node.setAlignSelf(LayoutAlign.FlexEnd)
    }
  }

  if ('justifyContent' in style) {
    if (style.justifyContent === 'flex-start' || !style.justifyContent) {
      node.setJustifyContent(LayoutJustify.FlexStart)
    }

    if (style.justifyContent === 'center') {
      node.setJustifyContent(LayoutJustify.Center)
    }

    if (style.justifyContent === 'flex-end') {
      node.setJustifyContent(LayoutJustify.FlexEnd)
    }

    if (style.justifyContent === 'space-between') {
      node.setJustifyContent(LayoutJustify.SpaceBetween)
    }

    if (style.justifyContent === 'space-around') {
      node.setJustifyContent(LayoutJustify.SpaceAround)
    }

    if (style.justifyContent === 'space-evenly') {
      node.setJustifyContent(LayoutJustify.SpaceEvenly)
    }
  }
}

/**
 * 将尺寸属性写入布局节点。
 * 覆盖：width / height / minWidth / minHeight / maxWidth / maxHeight
 * 每个属性均支持数值（绝对列数/行数）和百分比字符串两种形式。
 */
const applyDimensionStyles = (node: LayoutNode, style: Styles): void => {
  if ('width' in style) {
    if (typeof style.width === 'number') {
      node.setWidth(style.width)
    } else if (typeof style.width === 'string') {
      node.setWidthPercent(Number.parseInt(style.width, 10))
    } else {
      // 未设置：自动宽度
      node.setWidthAuto()
    }
  }

  if ('height' in style) {
    if (typeof style.height === 'number') {
      node.setHeight(style.height)
    } else if (typeof style.height === 'string') {
      node.setHeightPercent(Number.parseInt(style.height, 10))
    } else {
      // 未设置：自动高度
      node.setHeightAuto()
    }
  }

  if ('minWidth' in style) {
    if (typeof style.minWidth === 'string') {
      node.setMinWidthPercent(Number.parseInt(style.minWidth, 10))
    } else {
      node.setMinWidth(style.minWidth ?? 0)
    }
  }

  if ('minHeight' in style) {
    if (typeof style.minHeight === 'string') {
      node.setMinHeightPercent(Number.parseInt(style.minHeight, 10))
    } else {
      node.setMinHeight(style.minHeight ?? 0)
    }
  }

  if ('maxWidth' in style) {
    if (typeof style.maxWidth === 'string') {
      node.setMaxWidthPercent(Number.parseInt(style.maxWidth, 10))
    } else {
      node.setMaxWidth(style.maxWidth ?? 0)
    }
  }

  if ('maxHeight' in style) {
    if (typeof style.maxHeight === 'string') {
      node.setMaxHeightPercent(Number.parseInt(style.maxHeight, 10))
    } else {
      node.setMaxHeight(style.maxHeight ?? 0)
    }
  }
}

/**
 * 将 display 属性写入布局节点。
 * Ink 仅支持 'flex' 和 'none'（隐藏元素）两种值。
 */
const applyDisplayStyles = (node: LayoutNode, style: Styles): void => {
  if ('display' in style) {
    node.setDisplay(
      style.display === 'flex' ? LayoutDisplay.Flex : LayoutDisplay.None,
    )
  }
}

/**
 * 将边框属性写入布局节点（边框占用 1 列/行的空间）。
 *
 * 【特殊处理】
 * `style` 可能是差异对象（diff），只包含发生变化的属性。
 * `resolvedStyle` 是节点上已完整设置的当前样式，用于读取未变化的边框侧属性。
 *
 * 当 `borderStyle` 出现在 diff 中时，需要结合 `resolvedStyle` 中的
 * borderTop/Bottom/Left/Right 来确定哪些边需要绘制边框（宽度 0 或 1）。
 * 当仅单个边框侧属性变化时，跳过 undefined 值（表示属性未设置，而非禁用边框）。
 */
const applyBorderStyles = (
  node: LayoutNode,
  style: Styles,
  resolvedStyle?: Styles,
): void => {
  // resolvedStyle 是 DOM 节点上的完整当前样式；style 可能只是差异对象。
  // 对于边框侧属性，我们需要已解析的值，因为 diff 中的 borderStyle 可能不含
  // 未改变的边框侧值（例如 borderTop 仍为 false 但不在 diff 中）。
  const resolved = resolvedStyle ?? style

  if ('borderStyle' in style) {
    // borderStyle 发生变化：重新计算全部四边的边框宽度
    const borderWidth = style.borderStyle ? 1 : 0

    node.setBorder(
      LayoutEdge.Top,
      resolved.borderTop !== false ? borderWidth : 0, // 默认显示顶部边框
    )
    node.setBorder(
      LayoutEdge.Bottom,
      resolved.borderBottom !== false ? borderWidth : 0, // 默认显示底部边框
    )
    node.setBorder(
      LayoutEdge.Left,
      resolved.borderLeft !== false ? borderWidth : 0, // 默认显示左侧边框
    )
    node.setBorder(
      LayoutEdge.Right,
      resolved.borderRight !== false ? borderWidth : 0, // 默认显示右侧边框
    )
  } else {
    // 仅单个边框侧属性变化时（borderStyle 未变）
    // 跳过 undefined：undefined 表示属性被移除或从未设置，不等于禁用边框
    if ('borderTop' in style && style.borderTop !== undefined) {
      node.setBorder(LayoutEdge.Top, style.borderTop === false ? 0 : 1)
    }
    if ('borderBottom' in style && style.borderBottom !== undefined) {
      node.setBorder(LayoutEdge.Bottom, style.borderBottom === false ? 0 : 1)
    }
    if ('borderLeft' in style && style.borderLeft !== undefined) {
      node.setBorder(LayoutEdge.Left, style.borderLeft === false ? 0 : 1)
    }
    if ('borderRight' in style && style.borderRight !== undefined) {
      node.setBorder(LayoutEdge.Right, style.borderRight === false ? 0 : 1)
    }
  }
}

/**
 * 将间距属性（gap / columnGap / rowGap）写入布局节点。
 * gap 是 columnGap 和 rowGap 的简写。
 */
const applyGapStyles = (node: LayoutNode, style: Styles): void => {
  if ('gap' in style) {
    // gap：行列间距统一设置
    node.setGap(LayoutGutter.All, style.gap ?? 0)
  }

  if ('columnGap' in style) {
    // columnGap：列间距（水平方向）
    node.setGap(LayoutGutter.Column, style.columnGap ?? 0)
  }

  if ('rowGap' in style) {
    // rowGap：行间距（垂直方向）
    node.setGap(LayoutGutter.Row, style.rowGap ?? 0)
  }
}

/**
 * 主入口函数：将 `Styles` 对象中的所有布局属性应用到 Yoga `LayoutNode`。
 *
 * 【流程】
 * 按照位置 → 溢出 → 外边距 → 内边距 → Flex → 尺寸 → 显示 → 边框 → 间距的顺序，
 * 依次调用各 `applyXxxStyles` 函数，确保属性解析顺序的一致性。
 *
 * @param node          目标 Yoga 布局节点
 * @param style         待应用的样式（可以是完整样式或差异对象）
 * @param resolvedStyle 节点上已完整设置的当前样式（用于边框侧属性的差异计算）
 */
const styles = (
  node: LayoutNode,
  style: Styles = {},
  resolvedStyle?: Styles,
): void => {
  applyPositionStyles(node, style)   // 1. 定位属性
  applyOverflowStyles(node, style)   // 2. 溢出属性
  applyMarginStyles(node, style)     // 3. 外边距
  applyPaddingStyles(node, style)    // 4. 内边距
  applyFlexStyles(node, style)       // 5. Flex 布局
  applyDimensionStyles(node, style)  // 6. 尺寸约束
  applyDisplayStyles(node, style)    // 7. 显示/隐藏
  applyBorderStyles(node, style, resolvedStyle) // 8. 边框（需要已解析样式）
  applyGapStyles(node, style)        // 9. 间距
}

export default styles
