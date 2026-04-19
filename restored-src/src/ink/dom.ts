/**
 * Ink 虚拟 DOM 模块 —— 终端渲染的 DOM 树数据结构与操作
 *
 * 【在 Claude Code 系统中的位置】
 * 这是 Ink 自定义渲染层的核心基础模块，位于整个系统的中间层：
 *   React 组件层（JSX）
 *     ↓ React Reconciler（reconciler.ts）
 *     ↓ 本模块（dom.ts）—— 维护虚拟 DOM 树
 *     ↓ Yoga 布局引擎（layout/engine.ts）
 *     ↓ 渲染输出（render-node-to-output.ts）
 *     ↓ 终端屏幕缓冲区（output.ts）
 *
 * 【主要功能】
 * 1. 定义 DOM 节点类型：DOMElement（元素节点）和 TextNode（文本节点）
 * 2. 节点的创建、插入、删除操作（供 React Reconciler 调用）
 * 3. 属性/样式的更新操作（带脏检查，避免不必要的重排）
 * 4. 脏标记（dirty）传播：从修改的节点向上标记到根节点
 * 5. 文本节点的尺寸测量（供 Yoga 布局引擎使用）
 * 6. 滚动状态管理（scrollTop、pendingScrollDelta 等）
 * 7. 调试辅助：findOwnerChainAtRow() 定位某行对应的 React 组件链
 *
 * 【节点类型说明】
 * - ink-root：根节点，唯一持有 FocusManager
 * - ink-box：布局容器，对应 <Box> 组件，有 Yoga 节点
 * - ink-text：文本容器，有 Yoga 节点，含自定义测量函数
 * - ink-virtual-text：内联文本，无 Yoga 节点
 * - ink-link：超链接装饰，无 Yoga 节点
 * - ink-progress：进度条，无 Yoga 节点
 * - ink-raw-ansi：预渲染的 ANSI 字符串，有 Yoga 节点，使用固定尺寸测量
 */
import type { FocusManager } from './focus.js'
import { createLayoutNode } from './layout/engine.js'
import type { LayoutNode } from './layout/node.js'
import { LayoutDisplay, LayoutMeasureMode } from './layout/node.js'
import measureText from './measure-text.js'
import { addPendingClear, nodeCache } from './node-cache.js'
import squashTextNodes from './squash-text-nodes.js'
import type { Styles, TextStyles } from './styles.js'
import { expandTabs } from './tabstops.js'
import wrapText from './wrap-text.js'

/** 所有 DOM 节点的公共基础类型，包含父节点引用、Yoga 布局节点和样式 */
type InkNode = {
  parentNode: DOMElement | undefined   // 父节点引用，根节点为 undefined
  yogaNode?: LayoutNode                 // Yoga 布局节点（部分节点类型没有）
  style: Styles                         // CSS-like 样式对象
}

/** 文本节点的节点名称字面量类型 */
export type TextName = '#text'

/** 所有元素节点类型的联合类型 */
export type ElementNames =
  | 'ink-root'          // 根节点
  | 'ink-box'           // 布局容器（对应 <Box>）
  | 'ink-text'          // 文本容器（对应 <Text>）
  | 'ink-virtual-text'  // 内联文本（无 Yoga 节点）
  | 'ink-link'          // 超链接装饰（无 Yoga 节点）
  | 'ink-progress'      // 进度条（无 Yoga 节点）
  | 'ink-raw-ansi'      // 预渲染 ANSI 字符串（固定尺寸）

/** 所有节点名称的联合类型（元素 + 文本） */
export type NodeNames = ElementNames | TextName

/**
 * DOM 元素节点类型（非文本节点）。
 *
 * 包含布局、渲染、事件、滚动等多个子系统的状态字段。
 * 由 React Reconciler 通过 createInstance() 创建和管理。
 */
// eslint-disable-next-line @typescript-eslint/naming-convention
export type DOMElement = {
  nodeName: ElementNames                                 // 节点类型名称
  attributes: Record<string, DOMNodeAttribute>          // 元素属性（非事件处理器）
  childNodes: DOMNode[]                                  // 子节点数组

  textStyles?: TextStyles                                // 文本样式（ink-text 节点使用）

  // 渲染生命周期回调（由 ink.tsx 的根组件注入）
  onComputeLayout?: () => void      // Yoga 布局计算完成后的回调
  onRender?: () => void             // 触发节流渲染调度的回调
  onImmediateRender?: () => void    // 触发立即渲染（跳过节流）的回调

  // React 19 测试模式下，跳过 effect 双重调用产生的空帧
  hasRenderedContent?: boolean

  // 当 true 时，表示该节点在下一帧需要重新渲染（脏标记）
  dirty: boolean
  // 由 reconciler 的 hideInstance/unhideInstance 设置；样式更新时保持不变
  isHidden?: boolean
  // 事件处理器，由 reconciler 存储。与 attributes 分开存储，
  // 避免处理器引用变化触发脏标记，从而破坏 blit 优化
  _eventHandlers?: Record<string, unknown>

  // overflow: 'scroll' 盒子的滚动状态
  scrollTop?: number                  // 当前滚动偏移（行数）
  pendingScrollDelta?: number         // 待应用的滚动增量（逐帧消耗，实现平滑滚动）
  scrollClampMin?: number             // 虚拟滚动的最小 scrollTop 限制
  scrollClampMax?: number             // 虚拟滚动的最大 scrollTop 限制
  scrollHeight?: number               // 渲染时计算的内容总高度
  scrollViewportHeight?: number       // 渲染时计算的视口高度
  scrollViewportTop?: number          // 视口顶部的绝对行位置
  stickyScroll?: boolean              // 是否自动固定到底部（内容增长时跟随）
  // 滚动到指定元素：渲染时读取 el.yogaNode 的 computedTop 并设置 scrollTop，一次性触发
  scrollAnchor?: { el: DOMElement; offset: number }

  // 仅 ink-root 节点持有 FocusManager，任意节点可通过 parentNode 链向上访问
  focusManager?: FocusManager

  // 调试用：React 组件调用栈，仅在 CLAUDE_CODE_DEBUG_REPAINTS 环境变量设置时填充
  debugOwnerChain?: string[]
} & InkNode

/** DOM 文本节点类型 */
export type TextNode = {
  nodeName: TextName     // 固定为 '#text'
  nodeValue: string      // 文本内容
} & InkNode

/**
 * DOM 节点的联合类型，根据节点名称类型参数推断具体类型。
 * '#text' → TextNode，其他 → DOMElement
 */
// eslint-disable-next-line @typescript-eslint/naming-convention
export type DOMNode<T = { nodeName: NodeNames }> = T extends {
  nodeName: infer U
}
  ? U extends '#text'
    ? TextNode
    : DOMElement
  : never

/** DOM 节点属性值的类型（布尔、字符串或数字） */
// eslint-disable-next-line @typescript-eslint/naming-convention
export type DOMNodeAttribute = boolean | string | number

/**
 * 创建一个新的 DOM 元素节点。
 *
 * 【流程说明】
 * 1. 根据节点类型决定是否创建 Yoga 布局节点
 *    （ink-virtual-text/ink-link/ink-progress 无需 Yoga 节点）
 * 2. 初始化节点的各字段为默认值
 * 3. 为 ink-text 和 ink-raw-ansi 注册自定义测量函数
 *
 * 由 React Reconciler 的 createInstance() 调用。
 */
export const createNode = (nodeName: ElementNames): DOMElement => {
  // 判断此节点类型是否需要 Yoga 布局节点
  const needsYogaNode =
    nodeName !== 'ink-virtual-text' &&
    nodeName !== 'ink-link' &&
    nodeName !== 'ink-progress'
  const node: DOMElement = {
    nodeName,
    style: {},
    attributes: {},
    childNodes: [],
    parentNode: undefined,
    yogaNode: needsYogaNode ? createLayoutNode() : undefined,  // 按需创建 Yoga 节点
    dirty: false,
  }

  // ink-text 使用基于文本内容的动态测量函数
  if (nodeName === 'ink-text') {
    node.yogaNode?.setMeasureFunc(measureTextNode.bind(null, node))
  } else if (nodeName === 'ink-raw-ansi') {
    // ink-raw-ansi 使用固定尺寸测量（由 rawWidth/rawHeight 属性指定）
    node.yogaNode?.setMeasureFunc(measureRawAnsiNode.bind(null, node))
  }

  return node
}

/**
 * 将子节点追加到父节点末尾。
 *
 * 【流程说明】
 * 1. 若子节点已有父节点，先从旧父节点中移除
 * 2. 更新子节点的 parentNode 引用
 * 3. 将子节点追加到父节点的 childNodes 数组
 * 4. 若子节点有 Yoga 节点，同步插入 Yoga 树
 * 5. 标记父节点为脏状态，触发重渲染
 *
 * 由 React Reconciler 的 appendChildToContainer/appendChild 调用。
 */
export const appendChildNode = (
  node: DOMElement,
  childNode: DOMElement,
): void => {
  if (childNode.parentNode) {
    // 子节点已有父节点，先从旧父节点中移除（节点移动场景）
    removeChildNode(childNode.parentNode, childNode)
  }

  childNode.parentNode = node        // 更新父节点引用
  node.childNodes.push(childNode)    // 追加到子节点列表末尾

  if (childNode.yogaNode) {
    // 同步将 Yoga 节点插入 Yoga 树（追加到末尾）
    node.yogaNode?.insertChild(
      childNode.yogaNode,
      node.yogaNode.getChildCount(),
    )
  }

  markDirty(node)  // 标记节点为脏，触发重渲染
}

/**
 * 在指定参考节点之前插入新子节点。
 *
 * 【流程说明】
 * 1. 若新节点已有父节点，先从旧父节点移除
 * 2. 在 DOM 数组中找到参考节点的索引
 * 3. 在参考节点之前，计算正确的 Yoga 插入索引
 *    （注意：部分节点没有 Yoga 节点，DOM 索引 ≠ Yoga 索引）
 * 4. 同步更新 DOM 数组和 Yoga 树
 * 5. 若未找到参考节点，回退到追加末尾
 *
 * 由 React Reconciler 的 insertBefore 调用。
 */
export const insertBeforeNode = (
  node: DOMElement,
  newChildNode: DOMNode,
  beforeChildNode: DOMNode,
): void => {
  if (newChildNode.parentNode) {
    // 若新节点已有父节点，先移除（节点移动场景）
    removeChildNode(newChildNode.parentNode, newChildNode)
  }

  newChildNode.parentNode = node

  const index = node.childNodes.indexOf(beforeChildNode)

  if (index >= 0) {
    // Calculate yoga index BEFORE modifying childNodes.
    // We can't use DOM index directly because some children (like ink-progress,
    // ink-link, ink-virtual-text) don't have yogaNodes, so DOM indices don't
    // match yoga indices.
    // 在修改 childNodes 之前计算 Yoga 插入索引，
    // 因为部分子节点（ink-progress/ink-link/ink-virtual-text）没有 Yoga 节点，
    // DOM 索引与 Yoga 索引不对应，需要手动统计
    let yogaIndex = 0
    if (newChildNode.yogaNode && node.yogaNode) {
      for (let i = 0; i < index; i++) {
        if (node.childNodes[i]?.yogaNode) {
          yogaIndex++  // 只统计有 Yoga 节点的子节点
        }
      }
    }

    // 在 DOM 数组的 index 位置插入新节点
    node.childNodes.splice(index, 0, newChildNode)

    if (newChildNode.yogaNode && node.yogaNode) {
      // 同步将 Yoga 节点插入 Yoga 树的对应位置
      node.yogaNode.insertChild(newChildNode.yogaNode, yogaIndex)
    }

    markDirty(node)
    return
  }

  // 未找到参考节点，回退到追加末尾
  node.childNodes.push(newChildNode)

  if (newChildNode.yogaNode) {
    node.yogaNode?.insertChild(
      newChildNode.yogaNode,
      node.yogaNode.getChildCount(),
    )
  }

  markDirty(node)
}

/**
 * 从父节点中移除指定子节点。
 *
 * 【流程说明】
 * 1. 从 Yoga 树中移除子节点的 Yoga 布局节点
 * 2. 收集被移除子树中所有节点的缓存矩形，用于后续清除优化
 * 3. 清除子节点的 parentNode 引用
 * 4. 从父节点的 childNodes 数组中移除
 * 5. 标记父节点为脏
 *
 * 由 React Reconciler 的 removeChild/removeChildFromContainer 调用。
 */
export const removeChildNode = (
  node: DOMElement,
  removeNode: DOMNode,
): void => {
  if (removeNode.yogaNode) {
    // 从 Yoga 树中移除布局节点，防止悬空引用
    removeNode.parentNode?.yogaNode?.removeChild(removeNode.yogaNode)
  }

  // 收集被移除子树中所有节点的缓存矩形信息，用于 blit 优化中的清除操作
  collectRemovedRects(node, removeNode)

  removeNode.parentNode = undefined  // 清除父节点引用

  const index = node.childNodes.indexOf(removeNode)
  if (index >= 0) {
    node.childNodes.splice(index, 1)  // 从子节点数组中移除
  }

  markDirty(node)  // 标记父节点为脏
}

/**
 * 递归收集被移除子树中所有节点的缓存矩形信息，用于 blit 优化中的清除操作。
 *
 * 若被移除的节点或其祖先使用了 position: absolute，则该节点的像素
 * 可能覆盖了非兄弟节点的区域，此时需要禁用 blit 优化，进行全局重绘。
 * 普通流中的节点移除只影响直接兄弟，hasRemovedChild 已能处理。
 */
function collectRemovedRects(
  parent: DOMElement,
  removed: DOMNode,
  underAbsolute = false,  // 是否处于绝对定位节点的子树中
): void {
  if (removed.nodeName === '#text') return  // 文本节点无布局矩形，跳过
  const elem = removed as DOMElement
  // 判断当前节点是否为绝对定位（自身或祖先为绝对定位）
  const isAbsolute = underAbsolute || elem.style.position === 'absolute'
  const cached = nodeCache.get(elem)
  if (cached) {
    // 将缓存的矩形加入待清除队列
    addPendingClear(parent, cached, isAbsolute)
    nodeCache.delete(elem)  // 清除节点缓存
  }
  // 递归处理所有子节点
  for (const child of elem.childNodes) {
    collectRemovedRects(parent, child, isAbsolute)
  }
}

/**
 * 设置 DOM 节点的属性值。
 *
 * 带有优化：跳过 'children' 属性（由 React 通过 appendChild/removeChild 管理），
 * 以及值未发生变化的属性，避免不必要的脏标记。
 *
 * 由 React Reconciler 的 commitUpdate 调用。
 */
export const setAttribute = (
  node: DOMElement,
  key: string,
  value: DOMNodeAttribute,
): void => {
  // Skip 'children' - React handles children via appendChild/removeChild,
  // not attributes. React always passes a new children reference, so
  // tracking it as an attribute would mark everything dirty every render.
  // 跳过 'children'：React 通过 appendChild/removeChild 管理子节点，
  // 而非 attributes。React 每次渲染都会创建新的 children 引用，
  // 若将其作为属性跟踪会导致每次渲染都触发脏标记
  if (key === 'children') {
    return
  }
  // 值未变化时跳过，避免不必要的脏标记
  if (node.attributes[key] === value) {
    return
  }
  node.attributes[key] = value
  markDirty(node)
}

/**
 * 设置 DOM 节点的样式对象。
 *
 * 带浅比较（shallowEqual）：React 每次渲染都会创建新的 style 对象，
 * 即使内容相同。浅比较避免了在值未改变时触发 Yoga 重排和节点重绘。
 *
 * 由 React Reconciler 的 commitUpdate 调用。
 */
export const setStyle = (node: DOMNode, style: Styles): void => {
  // Compare style properties to avoid marking dirty unnecessarily.
  // React creates new style objects on every render even when unchanged.
  // 通过值比较而非引用比较，避免 React 每次渲染创建新对象时触发不必要的重绘
  if (stylesEqual(node.style, style)) {
    return
  }
  node.style = style
  markDirty(node)
}

/**
 * 设置 DOM 元素节点的文本样式（TextStyles）。
 *
 * 与 setStyle 类似，使用浅比较避免在 Text 组件每次渲染时
 * 不必要地触发 Yoga 文本重测量和节点重绘。
 *
 * 由 reconciler.ts 中的 Text 组件渲染路径调用。
 */
export const setTextStyles = (
  node: DOMElement,
  textStyles: TextStyles,
): void => {
  // Same dirty-check guard as setStyle: React (and buildTextStyles in Text.tsx)
  // allocate a new textStyles object on every render even when values are
  // unchanged, so compare by value to avoid markDirty -> yoga re-measurement
  // on every Text re-render.
  if (shallowEqual(node.textStyles, textStyles)) {
    return
  }
  node.textStyles = textStyles
  markDirty(node)
}

/**
 * 比较两个 Styles 对象是否相等（通过浅比较实现）。
 */
function stylesEqual(a: Styles, b: Styles): boolean {
  return shallowEqual(a, b)
}

/**
 * 通用浅比较函数：比较两个对象的所有属性是否相等（使用 === 比较值）。
 *
 * 用于在 setStyle/setTextStyles 中避免 React 每次渲染创建新对象时
 * 触发不必要的脏标记和重渲染。
 *
 * @returns 两对象所有属性的值均相同则返回 true
 */
function shallowEqual<T extends object>(
  a: T | undefined,
  b: T | undefined,
): boolean {
  // Fast path: same object reference (or both undefined)
  // 快速路径：引用相同（或同为 undefined）直接返回 true
  if (a === b) return true
  if (a === undefined || b === undefined) return false

  // Get all keys from both objects
  // 获取两个对象的所有键
  const aKeys = Object.keys(a) as (keyof T)[]
  const bKeys = Object.keys(b) as (keyof T)[]

  // Different number of properties
  // 属性数量不同，一定不相等
  if (aKeys.length !== bKeys.length) return false

  // Compare each property
  // 逐属性比较（严格相等）
  for (const key of aKeys) {
    if (a[key] !== b[key]) return false
  }

  return true
}

/**
 * 创建一个新的文本节点。
 *
 * 文本节点没有 Yoga 布局节点，因为文本内容的尺寸由其父 ink-text 节点的
 * measureTextNode 函数统一测量（squashTextNodes 会把所有文本节点内容合并）。
 *
 * 由 React Reconciler 的 createTextInstance 调用。
 */
export const createTextNode = (text: string): TextNode => {
  const node: TextNode = {
    nodeName: '#text',
    nodeValue: text,
    yogaNode: undefined,   // 文本节点无 Yoga 布局节点
    parentNode: undefined,
    style: {},
  }

  setTextNodeValue(node, text)  // 设置初始文本值

  return node
}

/**
 * ink-text 节点的 Yoga 自定义测量函数。
 *
 * 【流程说明】
 * 1. 获取节点的文本内容（squashTextNodes 合并所有子文本节点）
 * 2. 展开 tab 字符（用于测量最坏情况下的宽度）
 * 3. 调用 measureText 计算文字尺寸
 * 4. 若文字宽度超过容器，进行自动换行后重新测量
 * 5. 处理 Yoga 在 sub-pixel 空间查询时的特殊情况
 *
 * Yoga 在布局计算时会多次调用此函数（不同约束宽度），需要保证幂等性。
 */
const measureTextNode = function (
  node: DOMNode,
  width: number,
  widthMode: LayoutMeasureMode,
): { width: number; height: number } {
  // 获取文本内容：文本节点直接取 nodeValue，元素节点合并所有子文本节点
  const rawText =
    node.nodeName === '#text' ? node.nodeValue : squashTextNodes(node)

  // 展开 tab 字符进行测量（最坏情况：每个 tab 占 8 个空格）
  // 实际 tab 展开在 output.ts 中根据屏幕位置进行
  const text = expandTabs(rawText)

  const dimensions = measureText(text, width)

  // Text fits into container, no need to wrap
  // 文字宽度在容器范围内，无需换行，直接返回
  if (dimensions.width <= width) {
    return dimensions
  }

  // This is happening when <Box> is shrinking child nodes and layout asks
  // if we can fit this text node in a <1px space, so we just say "no"
  // <Box> 缩小子节点时，Yoga 可能以 <1px 的宽度查询，直接回答"不适合"
  if (dimensions.width >= 1 && width > 0 && width < 1) {
    return dimensions
  }

  // 对已含换行符的文本（如预换行内容），在 Undefined 宽度模式下避免按约束宽度重新换行，
  // 防止在 min/max 尺寸检查时虚增高度。
  // 但在 Exactly/AtMost 模式下必须按约束宽度测量，否则实际渲染时换行比布局预期多，
  // 导致内容被截断。
  if (text.includes('\n') && widthMode === LayoutMeasureMode.Undefined) {
    const effectiveWidth = Math.max(width, dimensions.width)
    return measureText(text, effectiveWidth)
  }

  // 获取文本换行策略（默认 'wrap'）
  const textWrap = node.style?.textWrap ?? 'wrap'
  // 按约束宽度换行后重新测量
  const wrappedText = wrapText(text, width, textWrap)

  return measureText(wrappedText, width)
}

/**
 * ink-raw-ansi 节点的 Yoga 自定义测量函数。
 *
 * 预渲染的 ANSI 字符串尺寸固定（由生产者在创建时确定），
 * 直接读取 rawWidth/rawHeight 属性，无需字符串宽度计算、换行或 tab 展开。
 * 这使得如 ColorDiff 这样的组件可以提供精确预计算的多行 ANSI 内容。
 */
// ink-raw-ansi nodes hold pre-rendered ANSI strings with known dimensions.
// No stringWidth, no wrapping, no tab expansion — the producer (e.g. ColorDiff)
// already wrapped to the target width and each line is exactly one terminal row.
const measureRawAnsiNode = function (node: DOMElement): {
  width: number
  height: number
} {
  return {
    width: node.attributes['rawWidth'] as number,    // 预设宽度（终端列数）
    height: node.attributes['rawHeight'] as number,  // 预设高度（终端行数）
  }
}

/**
 * 将指定节点及其所有祖先节点标记为脏（需要重渲染）。
 *
 * 【流程说明】
 * 1. 从当前节点向上遍历到根节点
 * 2. 对每个非文本节点设置 dirty = true
 * 3. 对首个遇到的 ink-text 或 ink-raw-ansi 节点，还需调用 yoga.markDirty()
 *    触发 Yoga 重新测量文字尺寸（仅叶子测量节点需要）
 *
 * 脏标记向上传播确保了祖先节点（Box 容器）知道子树有变化需要重绘，
 * 同时渲染器可以只重绘实际变化的子树，而不是整棵树。
 */
export const markDirty = (node?: DOMNode): void => {
  let current: DOMNode | undefined = node
  let markedYoga = false  // 确保每次调用只标记一次 Yoga 脏

  while (current) {
    if (current.nodeName !== '#text') {
      ;(current as DOMElement).dirty = true
      // 只对有测量函数的叶子节点标记 Yoga 脏（触发重新测量）
      if (
        !markedYoga &&
        (current.nodeName === 'ink-text' ||
          current.nodeName === 'ink-raw-ansi') &&
        current.yogaNode
      ) {
        current.yogaNode.markDirty()
        markedYoga = true
      }
    }
    current = current.parentNode  // 向上遍历到父节点
  }
}

/**
 * 从指定节点向上找到根节点，并调用其 onRender 回调触发渲染调度。
 *
 * 用于 DOM 层面的命令式变更（如 scrollTop 直接修改），
 * 这些变更绕过了 React reconciler，需要直接触发 Ink 的渲染帧。
 * 应与 markDirty() 配合使用：markDirty 告知渲染器哪个子树需要重新评估，
 * scheduleRenderFrom 触发实际的渲染调度。
 */
export const scheduleRenderFrom = (node?: DOMNode): void => {
  let cur: DOMNode | undefined = node
  // 向上遍历到根节点（parentNode 为 undefined 的节点）
  while (cur?.parentNode) cur = cur.parentNode
  // 调用根节点的 onRender 回调（即 ink.tsx 中的 scheduleRender）
  if (cur && cur.nodeName !== '#text') (cur as DOMElement).onRender?.()
}

/**
 * 更新文本节点的文本内容。
 *
 * 带有值比较优化：若新值与当前值相同则跳过，避免不必要的脏标记和 Yoga 重测量。
 * 同时确保非字符串值（如数字）被强制转换为字符串。
 *
 * 由 React Reconciler 的 commitTextUpdate 和 createTextNode 调用。
 */
export const setTextNodeValue = (node: TextNode, text: string): void => {
  if (typeof text !== 'string') {
    text = String(text)  // 强制转换为字符串类型
  }

  // 值未变化时跳过，避免不必要的脏标记
  if (node.nodeValue === text) {
    return
  }

  node.nodeValue = text
  markDirty(node)  // 标记节点为脏，触发重测量和重渲染
}

/**
 * 类型守卫：判断节点是否为 DOMElement（非文本节点）。
 */
function isDOMElement(node: DOMElement | TextNode): node is DOMElement {
  return node.nodeName !== '#text'
}

/**
 * 递归清除节点及其所有后代的 Yoga 节点引用。
 *
 * 在销毁 Yoga 节点树之前必须调用此函数。
 * Yoga 的 freeRecursive() 会释放节点及其所有子节点的内存，
 * 因此必须提前清除 JS 侧的所有引用，防止悬空指针访问已释放内存。
 *
 * 由 Ink 应用卸载（unmount）时调用。
 */
export const clearYogaNodeReferences = (node: DOMElement | TextNode): void => {
  if ('childNodes' in node) {
    // 递归清除所有子节点的 Yoga 引用
    for (const child of node.childNodes) {
      clearYogaNodeReferences(child)
    }
  }
  node.yogaNode = undefined  // 清除当前节点的 Yoga 引用
}

/**
 * 查找负责屏幕第 y 行内容的 React 组件调用栈。
 *
 * 【流程说明】
 * 深度优先遍历 DOM 树，累积 Yoga 的布局偏移量，找到包含第 y 行的最深节点，
 * 返回该节点的 debugOwnerChain（React 组件名称数组）。
 * 当 log-update 触发全屏重置时，ink.tsx 调用此函数定位导致闪烁的组件来源。
 *
 * 仅在设置了 CLAUDE_CODE_DEBUG_REPAINTS 环境变量时有用，
 * 否则 debugOwnerChain 均为 undefined，本函数返回空数组。
 *
 * @param root 从哪个根节点开始搜索
 * @param y    目标行号（0-indexed，相对于屏幕顶部）
 * @returns    最深匹配节点的 debugOwnerChain，未找到时返回 []
 */
export function findOwnerChainAtRow(root: DOMElement, y: number): string[] {
  let best: string[] = []
  walk(root, 0)
  return best

  /**
   * 递归遍历节点树，更新 best 为包含目标行的最深节点的 debugOwnerChain。
   *
   * @param node    当前遍历的节点
   * @param offsetY 当前节点相对于屏幕顶部的 Y 偏移（父节点累积）
   */
  function walk(node: DOMElement, offsetY: number): void {
    const yoga = node.yogaNode
    // 跳过无 Yoga 节点或被隐藏（display: none）的节点
    if (!yoga || yoga.getDisplay() === LayoutDisplay.None) return

    // 计算当前节点在屏幕上的实际顶部行和高度
    const top = offsetY + yoga.getComputedTop()
    const height = yoga.getComputedHeight()
    // 目标行不在此节点范围内，剪枝
    if (y < top || y >= top + height) return

    // 目标行在此节点范围内，更新最佳匹配（深度优先，取最深节点）
    if (node.debugOwnerChain) best = node.debugOwnerChain

    // 继续深入子节点
    for (const child of node.childNodes) {
      if (isDOMElement(child)) walk(child, top)
    }
  }
}
