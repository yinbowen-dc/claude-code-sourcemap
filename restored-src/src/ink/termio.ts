/**
 * 文件：termio.ts
 *
 * 【在 Claude Code 系统流程中的位置】
 * 本文件是 termio 子模块的公共 API 入口（barrel file）。
 * termio 是 Claude Code 自定义的终端 I/O 解析器，
 * 负责将原始终端字节流解析为结构化的语义动作（Action）。
 *
 * 【主要功能】
 * 统一重导出 termio 子模块的核心类和类型：
 * - `Parser`：流式 ANSI 解析器，将终端输入/输出转换为语义 Action[]
 * - 所有语义类型：`Action`、`Color`、`TextStyle`、`Grapheme`、`TextSegment` 等
 * - 工具函数：`defaultStyle`、`stylesEqual`、`colorsEqual`
 *
 * 外部模块只需 `import { Parser } from './termio.js'` 即可访问完整功能，
 * 无需了解 termio/ 子目录的内部结构。
 *
 * 【使用示例】
 * ```typescript
 * import { Parser } from './termio.js'
 *
 * const parser = new Parser()
 * const actions = parser.feed('\x1b[31mred\x1b[0m')
 * // => [{ type: 'text', graphemes: [...], style: { fg: { type: 'named', name: 'red' }, ... } }]
 * ```
 */

/**
 * ANSI 解析器模块
 *
 * 一个受 ghostty、tmux 和 iTerm2 启发的语义化 ANSI 转义序列解析器。
 *
 * 主要特性：
 * - 语义输出：产生结构化动作，而非字符串 token
 * - 流式处理：通过 Parser 类可增量解析输入
 * - 样式追踪：跨解析调用维护文本样式状态
 * - 全面支持：SGR、CSI、OSC、ESC 序列均支持
 */

// 解析器
export { Parser } from './termio/parser.js'
// 类型定义
export type {
  Action,
  Color,
  CursorAction,
  CursorDirection,
  EraseAction,
  Grapheme,
  LinkAction,
  ModeAction,
  NamedColor,
  ScrollAction,
  TextSegment,
  TextStyle,
  TitleAction,
  UnderlineStyle,
} from './termio/types.js'
export { colorsEqual, defaultStyle, stylesEqual } from './termio/types.js'
