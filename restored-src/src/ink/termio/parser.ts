/**
 * 文件：termio/parser.ts
 *
 * 【在 Claude Code 系统流程中的位置】
 * 本文件是 termio 子模块的语义解析层，是整个终端 I/O 体系中从字节流到结构化 Action 的最后一步。
 * tokenize.ts 负责识别转义序列边界（输出 Token），本文件则将这些 Token 解释为有意义的语义 Action。
 * App.tsx 和 terminal.ts 通过 Parser 类解析终端响应，得到光标位置、样式变更、链接等高级信息。
 *
 * 【主要功能】
 * - Grapheme 工具函数：`isEmoji`、`isEastAsianWide`、`graphemeWidth`、`segmentGraphemes`
 *   将文本字符串分割为带宽度信息的字素簇单元（区分全角/半角/emoji）
 * - `parseCSIParams(paramStr)`：将 CSI 参数字符串拆分为数字数组（支持 ; 和 : 分隔）
 * - `parseCSI(rawSequence)`：将完整 CSI 序列解析为语义 Action（光标移动/擦除/滚动/模式等）
 * - `identifySequence(seq)`：识别序列类型（csi/osc/esc/ss3/unknown）
 * - `Parser` 类：有状态的流式解析器，维护当前文本样式和链接状态
 *   - `feed(input)`：增量输入并返回 Action 数组
 *   - `reset()`：重置所有状态
 */

import { getGraphemeSegmenter } from '../../utils/intl.js'
import { C0 } from './ansi.js'
import { CSI, CURSOR_STYLES, ERASE_DISPLAY, ERASE_LINE_REGION } from './csi.js'
import { DEC } from './dec.js'
import { parseEsc } from './esc.js'
import { parseOSC } from './osc.js'
import { applySGR } from './sgr.js'
import { createTokenizer, type Token, type Tokenizer } from './tokenize.js'
import type { Action, Grapheme, TextStyle } from './types.js'
import { defaultStyle } from './types.js'

// =============================================================================
// Grapheme Utilities
// =============================================================================

/**
 * 判断码位是否属于 Emoji 范围。
 *
 * 【覆盖范围】
 * - 0x2600–0x26ff：杂项符号
 * - 0x2700–0x27bf：Dingbats
 * - 0x1f300–0x1f9ff：各类 Emoji（笑脸/动物/食物等）
 * - 0x1fa00–0x1faff：扩展 Emoji A
 * - 0x1f1e0–0x1f1ff：区域指示符（国旗字母）
 *
 * Emoji 通常占据终端两列宽度，影响光标计算。
 *
 * @param codePoint Unicode 码位值
 * @returns 若码位属于 Emoji 范围则返回 true
 */
function isEmoji(codePoint: number): boolean {
  return (
    (codePoint >= 0x2600 && codePoint <= 0x26ff) ||
    (codePoint >= 0x2700 && codePoint <= 0x27bf) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1f9ff) ||
    (codePoint >= 0x1fa00 && codePoint <= 0x1faff) ||
    (codePoint >= 0x1f1e0 && codePoint <= 0x1f1ff)
  )
}

/**
 * 判断码位是否属于东亚全角字符范围（East Asian Wide）。
 *
 * 【覆盖范围】
 * - 0x1100–0x115f：朝鲜语前导字母（Hangul Jamo）
 * - 0x2e80–0x9fff：CJK 扩展及主体汉字区
 * - 0xac00–0xd7a3：朝鲜语音节（Hangul Syllables）
 * - 0xf900–0xfaff：CJK 兼容表意文字
 * - 0xfe10–0xfe1f：竖排符号
 * - 0xfe30–0xfe6f：CJK 兼容形式与小写变体
 * - 0xff00–0xff60：全角 ASCII 与半角片假名
 * - 0xffe0–0xffe6：全角符号
 * - 0x20000–0x2fffd / 0x30000–0x3fffd：CJK 统一汉字扩展 B/C/D/E/F/G
 *
 * 全角字符占据终端两列，必须在宽度计算中特殊处理。
 *
 * @param codePoint Unicode 码位值
 * @returns 若码位属于东亚全角范围则返回 true
 */
function isEastAsianWide(codePoint: number): boolean {
  return (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    (codePoint >= 0x2e80 && codePoint <= 0x9fff) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe10 && codePoint <= 0xfe1f) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x20000 && codePoint <= 0x2fffd) ||
    (codePoint >= 0x30000 && codePoint <= 0x3fffd)
  )
}

/**
 * 判断字符串是否包含多个 Unicode 码位。
 *
 * 通过 for...of 迭代（按码位计数，不是 UTF-16 code unit），
 * 发现第二个码位时立即返回 true，无需遍历整个字符串。
 * 用于快速判断字素簇是否由多个码位组成（如 emoji 修饰序列）。
 *
 * @param str 待检测字符串
 * @returns 若包含多个码位则返回 true
 */
function hasMultipleCodepoints(str: string): boolean {
  let count = 0
  for (const _ of str) {
    count++
    if (count > 1) return true
  }
  return false
}

/**
 * 计算单个字素簇的终端显示宽度（1 或 2 列）。
 *
 * 【判断逻辑】
 * 1. 若字素簇由多个码位构成（如 emoji 修饰序列、ZWJ 序列）→ 宽度 2
 * 2. 取第一个码位，若为 Emoji 或东亚全角 → 宽度 2
 * 3. 其余情况 → 宽度 1
 *
 * @param grapheme 单个字素簇字符串
 * @returns 终端显示宽度（1 = 半角，2 = 全角）
 */
function graphemeWidth(grapheme: string): 1 | 2 {
  if (hasMultipleCodepoints(grapheme)) return 2
  const codePoint = grapheme.codePointAt(0)
  if (codePoint === undefined) return 1
  if (isEmoji(codePoint) || isEastAsianWide(codePoint)) return 2
  return 1
}

/**
 * 将字符串分割为带宽度信息的字素簇序列（Generator）。
 *
 * 使用 Intl.Segmenter（通过 `getGraphemeSegmenter()` 懒加载缓存）
 * 按字素簇边界分割文本，每个字素簇附带终端显示宽度（1 或 2）。
 * Parser 用此函数将文本 Token 转换为 Grapheme[] 以供渲染层使用。
 *
 * @param str 待分割的文本字符串
 * @yields 带 value（字素簇文本）和 width（列宽）的 Grapheme 对象
 */
function* segmentGraphemes(str: string): Generator<Grapheme> {
  for (const { segment } of getGraphemeSegmenter().segment(str)) {
    yield { value: segment, width: graphemeWidth(segment) }
  }
}

// =============================================================================
// Sequence Parsing
// =============================================================================

/**
 * 将 CSI 参数字符串解析为数字数组。
 *
 * 参数字符串由 `;` 或 `:` 分隔的十进制数字组成，空字段视为 0。
 * 例：`"1;2"` → `[1, 2]`，`";;3"` → `[0, 0, 3]`，`""` → `[]`
 *
 * @param paramStr CSI 序列中的参数部分（不含终止字节）
 * @returns 解析后的数字数组
 */
function parseCSIParams(paramStr: string): number[] {
  if (paramStr === '') return []
  return paramStr.split(/[;:]/).map(s => (s === '' ? 0 : parseInt(s, 10)))
}

/**
 * 将原始 CSI 序列（如 "\x1b[31m"）解析为语义 Action。
 *
 * 【解析流程】
 * 1. 提取 ESC [ 之后的内容（inner），取最后一字节为终止字节（finalByte）
 * 2. 识别私有模式前缀（?、>、=）并提取
 * 3. 识别中间字节（0x20–0x2f 范围）并提取
 * 4. 解析参数字符串，取 p0（第一参数，默认 1）和 p1（第二参数，默认 1）
 * 5. 按 finalByte 和 privateMode 逐一匹配：
 *    - SGR（m）→ { type: 'sgr', params }（由调用方通过 applySGR 转换为样式）
 *    - 光标移动（A/B/C/D/E/F/G/H/f/d）
 *    - 擦除（J/K/X）
 *    - 滚动（S/T/r）
 *    - 光标保存/恢复（s/u）
 *    - 光标样式（SP q）
 *    - DEC 私有模式（? h/l：光标可见性/备用屏/括号粘贴/鼠标追踪/焦点事件）
 * 6. 未识别 → { type: 'unknown', sequence }
 *
 * @param rawSequence 完整的 CSI 序列字符串（含 ESC [）
 * @returns 语义 Action 或 null（序列内容为空时）
 */
function parseCSI(rawSequence: string): Action | null {
  const inner = rawSequence.slice(2)
  if (inner.length === 0) return null

  const finalByte = inner.charCodeAt(inner.length - 1)
  const beforeFinal = inner.slice(0, -1)

  let privateMode = ''
  let paramStr = beforeFinal
  let intermediate = ''

  // 检查并提取私有模式前缀（?、>、=）
  if (beforeFinal.length > 0 && '?>='.includes(beforeFinal[0]!)) {
    privateMode = beforeFinal[0]!
    paramStr = beforeFinal.slice(1)
  }

  // 提取中间字节（0x20–0x2f，如空格用于 DECSCUSR）
  const intermediateMatch = paramStr.match(/([^0-9;:]+)$/)
  if (intermediateMatch) {
    intermediate = intermediateMatch[1]!
    paramStr = paramStr.slice(0, -intermediate.length)
  }

  const params = parseCSIParams(paramStr)
  const p0 = params[0] ?? 1  // 第一参数，缺省为 1
  const p1 = params[1] ?? 1  // 第二参数，缺省为 1

  // SGR (Select Graphic Rendition)：文本样式变更，返回原始参数供 applySGR 处理
  if (finalByte === CSI.SGR && privateMode === '') {
    return { type: 'sgr', params: paramStr }
  }

  // 光标移动序列
  if (finalByte === CSI.CUU) {
    return {
      type: 'cursor',
      action: { type: 'move', direction: 'up', count: p0 },
    }
  }
  if (finalByte === CSI.CUD) {
    return {
      type: 'cursor',
      action: { type: 'move', direction: 'down', count: p0 },
    }
  }
  if (finalByte === CSI.CUF) {
    return {
      type: 'cursor',
      action: { type: 'move', direction: 'forward', count: p0 },
    }
  }
  if (finalByte === CSI.CUB) {
    return {
      type: 'cursor',
      action: { type: 'move', direction: 'back', count: p0 },
    }
  }
  if (finalByte === CSI.CNL) {
    return { type: 'cursor', action: { type: 'nextLine', count: p0 } }
  }
  if (finalByte === CSI.CPL) {
    return { type: 'cursor', action: { type: 'prevLine', count: p0 } }
  }
  if (finalByte === CSI.CHA) {
    return { type: 'cursor', action: { type: 'column', col: p0 } }
  }
  if (finalByte === CSI.CUP || finalByte === CSI.HVP) {
    // CUP（H）和 HVP（f）均为绝对定位：row=p0, col=p1
    return { type: 'cursor', action: { type: 'position', row: p0, col: p1 } }
  }
  if (finalByte === CSI.VPA) {
    return { type: 'cursor', action: { type: 'row', row: p0 } }
  }

  // 擦除序列
  if (finalByte === CSI.ED) {
    // ED（J）：擦除显示区域，参数 0=toEnd、1=toStart、2=all、3=scrollback
    const region = ERASE_DISPLAY[params[0] ?? 0] ?? 'toEnd'
    return { type: 'erase', action: { type: 'display', region } }
  }
  if (finalByte === CSI.EL) {
    // EL（K）：擦除行区域，参数 0=toEnd、1=toStart、2=all
    const region = ERASE_LINE_REGION[params[0] ?? 0] ?? 'toEnd'
    return { type: 'erase', action: { type: 'line', region } }
  }
  if (finalByte === CSI.ECH) {
    // ECH（X）：从光标位置向右擦除 p0 个字符
    return { type: 'erase', action: { type: 'chars', count: p0 } }
  }

  // 滚动序列
  if (finalByte === CSI.SU) {
    return { type: 'scroll', action: { type: 'up', count: p0 } }
  }
  if (finalByte === CSI.SD) {
    return { type: 'scroll', action: { type: 'down', count: p0 } }
  }
  if (finalByte === CSI.DECSTBM) {
    // DECSTBM（r）：设置滚动区域上下边界（行号从 1 开始）
    return {
      type: 'scroll',
      action: { type: 'setRegion', top: p0, bottom: p1 },
    }
  }

  // 光标保存/恢复（SCO 扩展，与 DECSC/DECRC 语义相同）
  if (finalByte === CSI.SCOSC) {
    return { type: 'cursor', action: { type: 'save' } }
  }
  if (finalByte === CSI.SCORC) {
    return { type: 'cursor', action: { type: 'restore' } }
  }

  // 光标样式（DECSCUSR，中间字节为空格）：块/下划线/竖线，可选闪烁
  if (finalByte === CSI.DECSCUSR && intermediate === ' ') {
    const styleInfo = CURSOR_STYLES[p0] ?? CURSOR_STYLES[0]!
    return { type: 'cursor', action: { type: 'style', ...styleInfo } }
  }

  // DEC 私有模式（CSI ? N h/l）：各类终端功能的启用/禁用
  if (privateMode === '?' && (finalByte === CSI.SM || finalByte === CSI.RM)) {
    const enabled = finalByte === CSI.SM  // h=set=enable，l=reset=disable

    // DECSET/DECRESET 25：光标可见性
    if (p0 === DEC.CURSOR_VISIBLE) {
      return {
        type: 'cursor',
        action: enabled ? { type: 'show' } : { type: 'hide' },
      }
    }
    // DECSET/DECRESET 47/1049：备用屏幕模式
    if (p0 === DEC.ALT_SCREEN_CLEAR || p0 === DEC.ALT_SCREEN) {
      return { type: 'mode', action: { type: 'alternateScreen', enabled } }
    }
    // DECSET/DECRESET 2004：括号粘贴模式
    if (p0 === DEC.BRACKETED_PASTE) {
      return { type: 'mode', action: { type: 'bracketedPaste', enabled } }
    }
    // DECSET/DECRESET 1000：基础鼠标追踪
    if (p0 === DEC.MOUSE_NORMAL) {
      return {
        type: 'mode',
        action: { type: 'mouseTracking', mode: enabled ? 'normal' : 'off' },
      }
    }
    // DECSET/DECRESET 1002：按钮（拖拽）鼠标追踪
    if (p0 === DEC.MOUSE_BUTTON) {
      return {
        type: 'mode',
        action: { type: 'mouseTracking', mode: enabled ? 'button' : 'off' },
      }
    }
    // DECSET/DECRESET 1003：任意动作鼠标追踪（悬停）
    if (p0 === DEC.MOUSE_ANY) {
      return {
        type: 'mode',
        action: { type: 'mouseTracking', mode: enabled ? 'any' : 'off' },
      }
    }
    // DECSET/DECRESET 1004：焦点事件上报
    if (p0 === DEC.FOCUS_EVENTS) {
      return { type: 'mode', action: { type: 'focusEvents', enabled } }
    }
  }

  // 未能识别的 CSI 序列
  return { type: 'unknown', sequence: rawSequence }
}

/**
 * 根据序列原始字符串识别其类型。
 *
 * 【识别规则】
 * - 长度 < 2 或首字节非 ESC → 'unknown'
 * - 第二字节 0x5b（'['）→ 'csi'（Control Sequence Introducer）
 * - 第二字节 0x5d（']'）→ 'osc'（Operating System Command）
 * - 第二字节 0x4f（'O'）→ 'ss3'（Single Shift 3，应用模式光标键）
 * - 其他 → 'esc'（简单两字节 ESC 序列）
 *
 * @param seq 原始序列字符串（含 ESC 前缀）
 * @returns 序列类型字符串
 */
function identifySequence(
  seq: string,
): 'csi' | 'osc' | 'esc' | 'ss3' | 'unknown' {
  if (seq.length < 2) return 'unknown'
  if (seq.charCodeAt(0) !== C0.ESC) return 'unknown'

  const second = seq.charCodeAt(1)
  if (second === 0x5b) return 'csi' // [
  if (second === 0x5d) return 'osc' // ]
  if (second === 0x4f) return 'ss3' // O
  return 'esc'
}

// =============================================================================
// Main Parser
// =============================================================================

/**
 * 有状态的流式 ANSI 序列解析器。
 *
 * 【设计说明】
 * - 流式（Streaming）：可增量处理输入，内部 Tokenizer 跨调用保持状态
 * - 语义输出：将原始序列转换为结构化 Action，而不是字符串 Token
 * - 样式追踪：Parser 实例维护当前 TextStyle，SGR 序列会就地更新它
 * - 链接追踪：OSC 8 超链接状态（inLink/linkUrl）跨 feed() 调用保持
 *
 * 【使用示例】
 * ```typescript
 * const parser = new Parser()
 * const actions1 = parser.feed('partial\x1b[')
 * const actions2 = parser.feed('31mred')  // 内部状态保持跨调用
 * ```
 *
 * 【公开状态】
 * - `style`：当前文本样式（SGR 更新后的最新状态）
 * - `inLink`：当前是否处于 OSC 8 超链接内
 * - `linkUrl`：当前超链接 URL（仅在 inLink=true 时有效）
 */
export class Parser {
  // 内部 Tokenizer：负责识别序列边界，跨调用保持缓冲区状态
  private tokenizer: Tokenizer = createTokenizer()

  // 当前文本样式，由 SGR 序列逐步更新；每个文本 Action 携带此样式的快照
  style: TextStyle = defaultStyle()
  // 当前是否处于 OSC 8 超链接内（收到 OSC 8 start 后置 true）
  inLink = false
  // 当前超链接 URL，inLink=false 时为 undefined
  linkUrl: string | undefined

  /**
   * 重置解析器为初始状态。
   *
   * 清空 Tokenizer 缓冲区、恢复默认文本样式、清除链接状态。
   * 用于开始解析新的独立输出流时重新初始化。
   */
  reset(): void {
    this.tokenizer.reset()
    this.style = defaultStyle()
    this.inLink = false
    this.linkUrl = undefined
  }

  /**
   * 增量输入并返回解析出的 Action 数组。
   *
   * 【流程】
   * 1. 将 input 送入 Tokenizer，获取完整的 Token 列表
   *    （Tokenizer 内部缓冲区可能保留跨调用的不完整序列）
   * 2. 遍历每个 Token，调用 processToken 转换为 Action[]
   * 3. 合并所有 Action 并返回
   *
   * @param input 原始终端输出字符串（可以是不完整片段）
   * @returns 解析出的语义 Action 数组
   */
  feed(input: string): Action[] {
    const tokens = this.tokenizer.feed(input)
    const actions: Action[] = []

    for (const token of tokens) {
      const tokenActions = this.processToken(token)
      actions.push(...tokenActions)
    }

    return actions
  }

  /**
   * 将单个 Token 转换为 Action 数组。
   *
   * - 'text' Token → processText（分割字素簇，提取 BEL）
   * - 'sequence' Token → processSequence（识别并解析转义序列）
   */
  private processToken(token: Token): Action[] {
    switch (token.type) {
      case 'text':
        return this.processText(token.value)

      case 'sequence':
        return this.processSequence(token.value)
    }
  }

  /**
   * 处理文本 Token，将其转换为 text Action 和 bell Action。
   *
   * 【流程】
   * 1. 逐字符扫描，遇到 BEL（0x07）字符时：
   *    a. 将之前积累的文本分割为字素簇并生成 text Action
   *    b. 生成 bell Action
   *    c. 重置当前字符缓冲区
   * 2. 处理完所有字符后，将剩余文本生成最终 text Action
   * 3. 每个 text Action 携带当前样式的浅拷贝（防止后续 SGR 影响历史 Action）
   *
   * @param text 文本 Token 的字符串值
   * @returns Action 数组（text 和/或 bell）
   */
  private processText(text: string): Action[] {
    // 处理文本中嵌入的 BEL 字符
    const actions: Action[] = []
    let current = ''

    for (const char of text) {
      if (char.charCodeAt(0) === C0.BEL) {
        // 遇到 BEL 前的文本先分割输出
        if (current) {
          const graphemes = [...segmentGraphemes(current)]
          if (graphemes.length > 0) {
            actions.push({ type: 'text', graphemes, style: { ...this.style } })
          }
          current = ''
        }
        actions.push({ type: 'bell' })
      } else {
        current += char
      }
    }

    // 输出最后剩余的文本
    if (current) {
      const graphemes = [...segmentGraphemes(current)]
      if (graphemes.length > 0) {
        actions.push({ type: 'text', graphemes, style: { ...this.style } })
      }
    }

    return actions
  }

  /**
   * 处理序列 Token，按序列类型分发到对应的解析函数。
   *
   * 【分发逻辑】
   * - 'csi'：调用 parseCSI，若为 SGR 则就地更新 this.style，不产生 Action
   * - 'osc'：提取 BEL/ST 终止符后调用 parseOSC；
   *           若为 OSC 8 链接，更新 inLink/linkUrl 状态
   * - 'esc'：提取 ESC 后内容调用 parseEsc
   * - 'ss3'：应用模式光标键，输出 parsing 目的中视为 unknown
   * - 'unknown'：返回 unknown Action
   *
   * @param seq 原始序列字符串（含 ESC 前缀及终止字节）
   * @returns Action 数组
   */
  private processSequence(seq: string): Action[] {
    const seqType = identifySequence(seq)

    switch (seqType) {
      case 'csi': {
        const action = parseCSI(seq)
        if (!action) return []
        if (action.type === 'sgr') {
          // SGR 序列直接更新当前样式状态，不产生显式 Action
          this.style = applySGR(action.params, this.style)
          return []
        }
        return [action]
      }

      case 'osc': {
        // 提取 OSC 内容：去掉 ESC ] 前缀和 BEL/ESC \ 终止符
        let content = seq.slice(2)
        // 移除 BEL 终止符（0x07）
        if (content.endsWith('\x07')) {
          content = content.slice(0, -1)
        } else if (content.endsWith('\x1b\\')) {
          // 移除 ESC ST（ESC \）终止符
          content = content.slice(0, -2)
        }

        const action = parseOSC(content)
        if (action) {
          if (action.type === 'link') {
            // 更新链接追踪状态（OSC 8 开始/结束）
            if (action.action.type === 'start') {
              this.inLink = true
              this.linkUrl = action.action.url
            } else {
              this.inLink = false
              this.linkUrl = undefined
            }
          }
          return [action]
        }
        return []
      }

      case 'esc': {
        // ESC 序列：去掉 ESC 字节后调用 parseEsc
        const escContent = seq.slice(1)
        const action = parseEsc(escContent)
        return action ? [action] : []
      }

      case 'ss3':
        // SS3 序列（ESC O X）：在应用模式下表示光标键，输出解析中视为未知
        return [{ type: 'unknown', sequence: seq }]

      default:
        return [{ type: 'unknown', sequence: seq }]
    }
  }
}
