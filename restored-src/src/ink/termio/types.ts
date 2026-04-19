/**
 * 文件：termio/types.ts
 *
 * 【在 Claude Code 系统流程中的位置】
 * 本文件是 termio 子模块的语义类型定义中枢，为整个解析流水线提供共享的类型基础。
 * parser.ts、sgr.ts、osc.ts、csi.ts 等所有模块均依赖此处定义的类型。
 * 设计灵感来自 Ghostty 的基于 Action 的终端解析架构。
 *
 * 【主要类型】
 * - 颜色：`NamedColor`（16 色命名）、`Color`（命名/索引/RGB/默认）
 * - 文本样式：`UnderlineStyle`、`TextStyle`（完整 SGR 属性集）
 * - 工具函数：`defaultStyle()`（重置样式）、`stylesEqual()`、`colorsEqual()`
 * - Cursor 动作：`CursorDirection`、`CursorAction`（移动/定位/保存/样式等）
 * - 擦除动作：`EraseAction`（显示区/行/字符）
 * - 滚动动作：`ScrollAction`（上下滚动/设置滚动区域）
 * - 模式动作：`ModeAction`（备用屏/括号粘贴/鼠标/焦点事件）
 * - 链接动作：`LinkAction`（OSC 8 超链接开始/结束）
 * - 标题动作：`TitleAction`（OSC 0/1/2 窗口标题/图标名）
 * - 标签状态动作：`TabStatusAction`（OSC 21337 自定义扩展）
 * - 输出单元：`Grapheme`（字素簇+宽度）、`TextSegment`
 * - 总动作类型：`Action`（所有可能的解析动作的联合类型）
 */

// =============================================================================
// Colors
// =============================================================================

/**
 * 16 色命名颜色类型。
 *
 * 对应 ANSI 标准 8 色（SGR 30–37/40–47）和亮色扩展（SGR 90–97/100–107）。
 * 前 8 个为标准色，后 8 个（bright 前缀）为高亮/亮色变体。
 */
export type NamedColor =
  | 'black'
  | 'red'
  | 'green'
  | 'yellow'
  | 'blue'
  | 'magenta'
  | 'cyan'
  | 'white'
  | 'brightBlack'
  | 'brightRed'
  | 'brightGreen'
  | 'brightYellow'
  | 'brightBlue'
  | 'brightMagenta'
  | 'brightCyan'
  | 'brightWhite'

/**
 * 颜色规格类型：支持命名色、256 索引色、24 位 RGB 色和终端默认色。
 *
 * - named：使用 16 色命名（最广泛兼容）
 * - indexed：使用 256 色调色板索引（0–255，SGR 38;5;N）
 * - rgb：使用 24 位 True Color（SGR 38;2;R;G;B）
 * - default：终端默认前景/背景色（SGR 39/49）
 */
export type Color =
  | { type: 'named'; name: NamedColor }
  | { type: 'indexed'; index: number } // 0-255
  | { type: 'rgb'; r: number; g: number; b: number }
  | { type: 'default' }

// =============================================================================
// Text Styles
// =============================================================================

/**
 * 下划线样式变体（Kitty 扩展 SGR 4:N）。
 *
 * - none：无下划线（SGR 24 关闭）
 * - single：单线（SGR 4 或 4:1）
 * - double：双线（SGR 21 或 4:2）
 * - curly：波浪/卷曲线（SGR 4:3，Kitty 扩展）
 * - dotted：点线（SGR 4:4，Kitty 扩展）
 * - dashed：虚线（SGR 4:5，Kitty 扩展）
 */
export type UnderlineStyle =
  | 'none'
  | 'single'
  | 'double'
  | 'curly'
  | 'dotted'
  | 'dashed'

/**
 * 文本样式属性集合：代表当前全部 SGR 渲染属性的状态快照。
 *
 * 每个 text Action 携带此结构的浅拷贝，记录该文本段渲染时的完整样式。
 * Parser 维护一个当前 TextStyle 实例，由 SGR 序列逐步更新。
 *
 * 字段对应关系：
 * - bold ↔ SGR 1/22（粗体）
 * - dim ↔ SGR 2/22（细体/暗色）
 * - italic ↔ SGR 3/23（斜体）
 * - underline ↔ SGR 4/21/24（下划线变体）
 * - blink ↔ SGR 5/6/25（闪烁）
 * - inverse ↔ SGR 7/27（反显）
 * - hidden ↔ SGR 8/28（隐藏/遮盖）
 * - strikethrough ↔ SGR 9/29（删除线）
 * - overline ↔ SGR 53/55（上划线）
 * - fg ↔ SGR 30–38/39/90–97（前景色）
 * - bg ↔ SGR 40–48/49/100–107（背景色）
 * - underlineColor ↔ SGR 58/59（下划线颜色，Kitty 扩展）
 */
export type TextStyle = {
  bold: boolean
  dim: boolean
  italic: boolean
  underline: UnderlineStyle
  blink: boolean
  inverse: boolean
  hidden: boolean
  strikethrough: boolean
  overline: boolean
  fg: Color
  bg: Color
  underlineColor: Color
}

/**
 * 创建默认（重置）文本样式。
 *
 * 对应 SGR 0（Reset to default）：所有布尔属性为 false，
 * 下划线为 'none'，所有颜色为 { type: 'default' }（终端默认色）。
 * Parser 初始化时调用，SGR 0 也调用此函数重置样式。
 *
 * @returns 全部属性为默认值的 TextStyle 对象
 */
export function defaultStyle(): TextStyle {
  return {
    bold: false,
    dim: false,
    italic: false,
    underline: 'none',
    blink: false,
    inverse: false,
    hidden: false,
    strikethrough: false,
    overline: false,
    fg: { type: 'default' },
    bg: { type: 'default' },
    underlineColor: { type: 'default' },
  }
}

/**
 * 比较两个 TextStyle 是否完全相等。
 *
 * 逐字段比较所有 11 个布尔/枚举属性，
 * 颜色字段委托给 colorsEqual() 进行深度比较。
 * 用于渲染优化（检测样式变化以决定是否重新生成 SGR 序列）。
 *
 * @param a 第一个 TextStyle
 * @param b 第二个 TextStyle
 * @returns 若完全相等则返回 true
 */
export function stylesEqual(a: TextStyle, b: TextStyle): boolean {
  return (
    a.bold === b.bold &&
    a.dim === b.dim &&
    a.italic === b.italic &&
    a.underline === b.underline &&
    a.blink === b.blink &&
    a.inverse === b.inverse &&
    a.hidden === b.hidden &&
    a.strikethrough === b.strikethrough &&
    a.overline === b.overline &&
    colorsEqual(a.fg, b.fg) &&
    colorsEqual(a.bg, b.bg) &&
    colorsEqual(a.underlineColor, b.underlineColor)
  )
}

/**
 * 比较两个 Color 是否相等（深度比较）。
 *
 * 先比较 type 字段（快速短路），再按类型比较值字段：
 * - named：比较 name 字符串
 * - indexed：比较 index 数值
 * - rgb：比较 r、g、b 三个分量
 * - default：type 相同即相等（无额外字段）
 *
 * @param a 第一个 Color
 * @param b 第二个 Color
 * @returns 若颜色完全相等则返回 true
 */
export function colorsEqual(a: Color, b: Color): boolean {
  if (a.type !== b.type) return false
  switch (a.type) {
    case 'named':
      return a.name === (b as typeof a).name
    case 'indexed':
      return a.index === (b as typeof a).index
    case 'rgb':
      return (
        a.r === (b as typeof a).r &&
        a.g === (b as typeof a).g &&
        a.b === (b as typeof a).b
      )
    case 'default':
      return true  // type 相同即相等
  }
}

// =============================================================================
// Cursor Actions
// =============================================================================

/** 光标移动方向枚举 */
export type CursorDirection = 'up' | 'down' | 'forward' | 'back'

/**
 * 光标动作联合类型。
 *
 * 覆盖所有 CSI 光标控制序列的语义：
 * - move：相对移动（CUU/CUD/CUF/CUB）
 * - position：绝对定位（CUP/HVP，行列从 1 开始）
 * - column：设置列（CHA）
 * - row：设置行（VPA）
 * - save/restore：保存/恢复位置（DECSC/DECRC 或 SCOSC/SCORC）
 * - show/hide：显示/隐藏光标（DECSET/DECRESET 25）
 * - style：光标形状（DECSCUSR，block/underline/bar + blinking）
 * - nextLine/prevLine：移至下/上一行首（CNL/CPL）
 */
export type CursorAction =
  | { type: 'move'; direction: CursorDirection; count: number }
  | { type: 'position'; row: number; col: number }
  | { type: 'column'; col: number }
  | { type: 'row'; row: number }
  | { type: 'save' }
  | { type: 'restore' }
  | { type: 'show' }
  | { type: 'hide' }
  | {
      type: 'style'
      style: 'block' | 'underline' | 'bar'
      blinking: boolean
    }
  | { type: 'nextLine'; count: number }
  | { type: 'prevLine'; count: number }

// =============================================================================
// Erase Actions
// =============================================================================

/**
 * 擦除动作联合类型。
 *
 * - display：擦除显示区域（ED，CSI J）
 *   region: toEnd=光标到末尾, toStart=开头到光标, all=整屏, scrollback=清除滚动缓冲
 * - line：擦除行区域（EL，CSI K）
 *   region: toEnd=光标到行末, toStart=行首到光标, all=整行
 * - chars：从光标位置擦除 N 个字符（ECH，CSI X）
 */
export type EraseAction =
  | { type: 'display'; region: 'toEnd' | 'toStart' | 'all' | 'scrollback' }
  | { type: 'line'; region: 'toEnd' | 'toStart' | 'all' }
  | { type: 'chars'; count: number }

// =============================================================================
// Scroll Actions
// =============================================================================

/**
 * 滚动动作联合类型。
 *
 * - up：向上滚动 N 行（SU，CSI S）
 * - down：向下滚动 N 行（SD，CSI T）
 * - setRegion：设置滚动区域上下边界（DECSTBM，CSI r）
 */
export type ScrollAction =
  | { type: 'up'; count: number }
  | { type: 'down'; count: number }
  | { type: 'setRegion'; top: number; bottom: number }

// =============================================================================
// Mode Actions
// =============================================================================

/**
 * 终端模式动作联合类型（DEC 私有模式的语义表示）。
 *
 * - alternateScreen：备用屏幕开关（DECSET/DECRESET 47/1049）
 * - bracketedPaste：括号粘贴模式（DECSET/DECRESET 2004）
 * - mouseTracking：鼠标追踪模式（DECSET/DECRESET 1000/1002/1003）
 *   mode: off=禁用, normal=按键事件, button=拖拽事件, any=全动态追踪
 * - focusEvents：焦点事件上报（DECSET/DECRESET 1004）
 */
export type ModeAction =
  | { type: 'alternateScreen'; enabled: boolean }
  | { type: 'bracketedPaste'; enabled: boolean }
  | { type: 'mouseTracking'; mode: 'off' | 'normal' | 'button' | 'any' }
  | { type: 'focusEvents'; enabled: boolean }

// =============================================================================
// Link Actions (OSC 8)
// =============================================================================

/**
 * OSC 8 超链接动作联合类型。
 *
 * - start：开始超链接区域（提供 url 和可选 params 字典）
 * - end：结束超链接区域（空 URL 的 OSC 8）
 */
export type LinkAction =
  | { type: 'start'; url: string; params?: Record<string, string> }
  | { type: 'end' }

// =============================================================================
// Title Actions (OSC 0/1/2)
// =============================================================================

/**
 * 窗口标题/图标名动作联合类型（OSC 0/1/2）。
 *
 * - windowTitle：设置窗口标题（OSC 2）
 * - iconName：设置图标名（OSC 1）
 * - both：同时设置窗口标题和图标名（OSC 0）
 */
export type TitleAction =
  | { type: 'windowTitle'; title: string }
  | { type: 'iconName'; name: string }
  | { type: 'both'; title: string }

// =============================================================================
// Tab Status Action (OSC 21337)
// =============================================================================

/**
 * 标签页状态动作（OSC 21337 自定义扩展）。
 *
 * 用于在 Claude Code 中向支持的终端（如 iTerm2）设置标签页的视觉指示器：
 * - indicator：标签页颜色指示（Color 类型）
 * - status：状态文本标签
 * - statusColor：状态文本颜色
 *
 * 三态语义（每个字段）：
 * - 字段缺失（undefined）→ 序列中未提及该字段，不作更改
 * - null → 明确清除（bare key 或 key= 空值）
 * - 有值 → 设置为此值
 */
export type TabStatusAction = {
  indicator?: Color | null
  status?: string | null
  statusColor?: Color | null
}

// =============================================================================
// Parsed Segments - The output of the parser
// =============================================================================

/**
 * 带样式的文本段类型。
 *
 * 表示一段具有相同样式的连续文本，是渲染层的基本输入单元。
 */
export type TextSegment = {
  type: 'text'
  text: string
  style: TextStyle
}

/**
 * 字素簇（Grapheme Cluster）：终端显示的最小视觉单元。
 *
 * - value：字素簇的字符串值（可能包含多个 Unicode 码位，如 emoji 修饰序列）
 * - width：终端显示宽度（1 = 半角，2 = 全角/emoji）
 */
export type Grapheme = {
  value: string
  width: 1 | 2 // 终端列宽
}

/**
 * 所有可能的解析动作联合类型（Parser 的最终输出）。
 *
 * 每种 Action 对应一类终端指令的语义：
 * - text：带样式的字素簇列表（可见文本）
 * - cursor：光标控制（移动/定位/显示/样式）
 * - erase：擦除操作（显示/行/字符）
 * - scroll：滚动操作（上下/设置区域）
 * - mode：终端模式切换（备用屏/鼠标/焦点等）
 * - link：OSC 8 超链接（开始/结束）
 * - title：窗口标题/图标名
 * - tabStatus：OSC 21337 标签页状态
 * - sgr：SGR 样式变更（Parser 内部消费，不传出）
 * - bell：响铃（BEL，0x07）
 * - reset：全终端重置（ESC c = RIS）
 * - unknown：未识别的转义序列（用于调试/日志）
 */
export type Action =
  | { type: 'text'; graphemes: Grapheme[]; style: TextStyle }
  | { type: 'cursor'; action: CursorAction }
  | { type: 'erase'; action: EraseAction }
  | { type: 'scroll'; action: ScrollAction }
  | { type: 'mode'; action: ModeAction }
  | { type: 'link'; action: LinkAction }
  | { type: 'title'; action: TitleAction }
  | { type: 'tabStatus'; action: TabStatusAction }
  | { type: 'sgr'; params: string } // Select Graphic Rendition（样式变更，Parser 内部使用）
  | { type: 'bell' }
  | { type: 'reset' } // 全终端重置（ESC c）
  | { type: 'unknown'; sequence: string } // 未识别的序列
