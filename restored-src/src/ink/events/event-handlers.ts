/**
 * 事件处理器 Props 定义与查找表（Event Handler Props & Lookup Table）
 *
 * 【在 Claude Code / Ink 系统中的位置】
 * 本文件处于 Ink 事件系统层，是 React 组件 Props 与底层事件分发系统之间的桥梁。
 * React Reconciler 在处理组件 Props 时，通过 EVENT_HANDLER_PROPS 集合识别事件处理器，
 * 将它们存储到 DOM 节点的 _eventHandlers 中，而非普通属性。
 * Dispatcher 在分发事件时，通过 HANDLER_FOR_EVENT 查找表以 O(1) 复杂度
 * 找到对应的处理器 prop 名称（如 'keydown' → 'onKeyDown' / 'onKeyDownCapture'）。
 *
 * 【主要功能】
 * 1. EventHandlerProps 类型：定义 Box 等宿主组件上所有可注册的事件处理器 prop。
 * 2. HANDLER_FOR_EVENT 查找表：将事件类型字符串映射到冒泡/捕获阶段的 prop 名称。
 * 3. EVENT_HANDLER_PROPS 集合：供 reconciler 快速判断某个 prop 是否为事件处理器。
 */
import type { ClickEvent } from './click-event.js'
import type { FocusEvent } from './focus-event.js'
import type { KeyboardEvent } from './keyboard-event.js'
import type { PasteEvent } from './paste-event.js'
import type { ResizeEvent } from './resize-event.js'

// 各事件类型对应的处理器函数签名
type KeyboardEventHandler = (event: KeyboardEvent) => void
type FocusEventHandler = (event: FocusEvent) => void
type PasteEventHandler = (event: PasteEvent) => void
type ResizeEventHandler = (event: ResizeEvent) => void
type ClickEventHandler = (event: ClickEvent) => void
type HoverEventHandler = () => void  // 鼠标悬停事件无需事件参数

/**
 * Box 及其他宿主组件上所有可注册的事件处理器 Props 类型定义。
 *
 * 遵循 React/DOM 命名约定：
 * - onEventName：冒泡阶段处理器（从目标节点向上传播）
 * - onEventNameCapture：捕获阶段处理器（从根节点向下传播）
 *
 * 注：onMouseEnter/onMouseLeave 没有捕获阶段变体（与浏览器 DOM 一致）。
 */
export type EventHandlerProps = {
  onKeyDown?: KeyboardEventHandler           // 键盘按下事件（冒泡阶段）
  onKeyDownCapture?: KeyboardEventHandler    // 键盘按下事件（捕获阶段）

  onFocus?: FocusEventHandler                // 获得焦点事件（冒泡阶段）
  onFocusCapture?: FocusEventHandler         // 获得焦点事件（捕获阶段）
  onBlur?: FocusEventHandler                 // 失去焦点事件（冒泡阶段）
  onBlurCapture?: FocusEventHandler          // 失去焦点事件（捕获阶段）

  onPaste?: PasteEventHandler                // 粘贴事件（冒泡阶段）
  onPasteCapture?: PasteEventHandler         // 粘贴事件（捕获阶段）

  onResize?: ResizeEventHandler              // 终端窗口尺寸变化事件（仅冒泡阶段）

  onClick?: ClickEventHandler                // 鼠标点击事件（仅冒泡阶段）
  onMouseEnter?: HoverEventHandler           // 鼠标进入元素区域事件
  onMouseLeave?: HoverEventHandler           // 鼠标离开元素区域事件
}

/**
 * 反向查找表：事件类型字符串 → 冒泡/捕获阶段的 prop 名称。
 *
 * 由 Dispatcher 的 getHandler() 函数使用，实现 O(1) 的处理器查找。
 * 键为 TerminalEvent 的 type 属性值（如 'keydown'、'click'）；
 * 值包含 bubble（冒泡阶段 prop 名）和 capture（捕获阶段 prop 名），
 * 无对应阶段时不含该字段（如 resize 仅有 bubble）。
 */
export const HANDLER_FOR_EVENT: Record<
  string,
  { bubble?: keyof EventHandlerProps; capture?: keyof EventHandlerProps }
> = {
  keydown: { bubble: 'onKeyDown', capture: 'onKeyDownCapture' },  // 键盘事件：支持捕获和冒泡
  focus: { bubble: 'onFocus', capture: 'onFocusCapture' },         // 焦点获得：支持捕获和冒泡
  blur: { bubble: 'onBlur', capture: 'onBlurCapture' },            // 焦点失去：支持捕获和冒泡
  paste: { bubble: 'onPaste', capture: 'onPasteCapture' },         // 粘贴事件：支持捕获和冒泡
  resize: { bubble: 'onResize' },                                   // 窗口缩放：仅冒泡阶段
  click: { bubble: 'onClick' },                                     // 鼠标点击：仅冒泡阶段
}

/**
 * 所有事件处理器 prop 名称的集合，供 React Reconciler 检测并特殊处理。
 *
 * 当 Reconciler 处理组件 Props 更新时，如果某个 prop 名在此集合中，
 * 则将该 prop 存储到节点的 _eventHandlers 对象中，而非普通属性（attributes）。
 * 这样 Dispatcher 可以直接从 _eventHandlers 中读取处理器，
 * 而不会影响布局引擎或渲染逻辑。
 */
export const EVENT_HANDLER_PROPS = new Set<string>([
  'onKeyDown',
  'onKeyDownCapture',
  'onFocus',
  'onFocusCapture',
  'onBlur',
  'onBlurCapture',
  'onPaste',
  'onPasteCapture',
  'onResize',
  'onClick',
  'onMouseEnter',
  'onMouseLeave',
])
