/**
 * 文件：termio/sgr.ts
 *
 * 【在 Claude Code 系统流程中的位置】
 * 本文件是 termio 子模块的 SGR（Select Graphic Rendition）参数解析层。
 * parser.ts 在遇到 CSI m 序列时调用此处的 `applySGR` 函数，
 * 将原始参数字符串转换为结构化的 TextStyle 对象更新。
 *
 * 【主要功能】
 * - `parseParams(str)`：将参数字符串解析为带子参数的 Param 数组
 *   支持分号（;）分隔的主参数和冒号（:）分隔的子参数
 * - `parseExtendedColor(params, idx)`：解析扩展颜色（38/48/58 + 2/5）
 *   支持冒号内联格式（38:2:R:G:B）和分号级联格式（38;2;R;G;B）
 * - `applySGR(paramStr, style)`：核心函数，将 SGR 参数字符串应用到 TextStyle
 *   支持全部标准 SGR 属性：粗体/细体/斜体/下划线变体/闪烁/反转/隐藏/删除线/上划线
 *   以及前景色/背景色/下划线颜色的 16 色命名/256 索引/RGB 格式
 */

import type { NamedColor, TextStyle, UnderlineStyle } from './types.js'
import { defaultStyle } from './types.js'

/**
 * 16 色命名颜色表（按 ANSI 顺序排列）。
 *
 * 索引 0–7 对应标准色（30–37/40–47），索引 8–15 对应亮色（90–97/100–107）。
 * 用于将 SGR 颜色码映射到 NamedColor 类型字符串。
 */
const NAMED_COLORS: NamedColor[] = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
  'brightWhite',
]

/**
 * 下划线样式枚举表（按 SGR 4:N 子参数索引排列）。
 *
 * - 0: none（无下划线）
 * - 1: single（单线，SGR 4 或 4:1）
 * - 2: double（双线，SGR 21 或 4:2）
 * - 3: curly（波浪线，Kitty 扩展 4:3）
 * - 4: dotted（点线，Kitty 扩展 4:4）
 * - 5: dashed（虚线，Kitty 扩展 4:5）
 */
const UNDERLINE_STYLES: UnderlineStyle[] = [
  'none',
  'single',
  'double',
  'curly',
  'dotted',
  'dashed',
]

/**
 * 内部参数表示类型。
 *
 * - value：主参数值（null 表示缺省）
 * - subparams：冒号分隔的子参数列表（用于颜色等复合参数）
 * - colon：是否使用了冒号格式（影响扩展颜色解析路径）
 */
type Param = { value: number | null; subparams: number[]; colon: boolean }

/**
 * 将 SGR 参数字符串解析为结构化 Param 数组。
 *
 * 【解析规则】
 * - 空字符串 → `[{ value: 0, subparams: [], colon: false }]`（SGR 0 = 重置）
 * - ';' 作为主参数分隔符，分隔多个独立 SGR 参数
 * - ':' 作为子参数分隔符，第一个冒号将主值与子参数序列分开
 *   例："38:2:255:0:128" → { value: 38, subparams: [2, 255, 0, 128], colon: true }
 * - 空字段（连续分隔符）的值为 null，在颜色解析时视为缺省
 *
 * 【状态机】
 * - inSub=false：正在积累主值 → 遇到 ';' 提交 current，遇到 ':' 切换到 inSub
 * - inSub=true：正在积累子参数 → 遇到 ';' 提交最后子参数并重置，遇到 ':' 提交当前子参数
 *
 * @param str SGR 参数字符串（不含 CSI 前缀和 m 终止符）
 * @returns 解析后的 Param 数组
 */
function parseParams(str: string): Param[] {
  if (str === '') return [{ value: 0, subparams: [], colon: false }]

  const result: Param[] = []
  let current: Param = { value: null, subparams: [], colon: false }
  let num = ''
  let inSub = false

  for (let i = 0; i <= str.length; i++) {
    const c = str[i]
    if (c === ';' || c === undefined) {
      // 主参数分隔符或字符串结束：提交当前参数
      const n = num === '' ? null : parseInt(num, 10)
      if (inSub) {
        if (n !== null) current.subparams.push(n)
      } else {
        current.value = n
      }
      result.push(current)
      current = { value: null, subparams: [], colon: false }
      num = ''
      inSub = false
    } else if (c === ':') {
      // 子参数分隔符：切换到子参数模式或积累下一个子参数
      const n = num === '' ? null : parseInt(num, 10)
      if (!inSub) {
        // 首个冒号：将当前积累值作为主值，进入子参数模式
        current.value = n
        current.colon = true
        inSub = true
      } else {
        // 后续冒号：提交当前子参数
        if (n !== null) current.subparams.push(n)
      }
      num = ''
    } else if (c >= '0' && c <= '9') {
      // 数字字符：继续积累
      num += c
    }
  }
  return result
}

/**
 * 解析扩展颜色参数（SGR 38/48/58 的颜色值部分）。
 *
 * 【支持两种格式】
 * 1. 冒号内联格式（colon=true）：颜色类型和值均为当前参数的子参数
 *    - "38:5:N" → { index: N }（256 色索引）
 *    - "38:2:R:G:B" 或 "38:2:_:R:G:B" → { r, g, b }（RGB，可选空格子参数）
 * 2. 分号级联格式（colon=false）：颜色类型和值分布在后续独立参数中
 *    - "38;5;N" → params[idx+1].value=5, params[idx+2].value=N
 *    - "38;2;R;G;B" → params[idx+1].value=2, params[idx+2..4].value=R/G/B
 *
 * @param params 完整参数数组
 * @param idx 当前 38/48/58 参数所在索引
 * @returns RGB 对象、索引对象或 null（格式无效）
 */
function parseExtendedColor(
  params: Param[],
  idx: number,
): { r: number; g: number; b: number } | { index: number } | null {
  const p = params[idx]
  if (!p) return null

  // 冒号内联格式：子参数[0] 为颜色类型（5=索引，2=RGB）
  if (p.colon && p.subparams.length >= 1) {
    if (p.subparams[0] === 5 && p.subparams.length >= 2) {
      // 38:5:N → 256 色索引
      return { index: p.subparams[1]! }
    }
    if (p.subparams[0] === 2 && p.subparams.length >= 4) {
      // 38:2:R:G:B（4 个子参数）或 38:2:_:R:G:B（5 个子参数，含颜色空间）
      const off = p.subparams.length >= 5 ? 1 : 0
      return {
        r: p.subparams[1 + off]!,
        g: p.subparams[2 + off]!,
        b: p.subparams[3 + off]!,
      }
    }
  }

  // 分号级联格式：颜色类型在下一个独立参数中
  const next = params[idx + 1]
  if (!next) return null
  if (
    next.value === 5 &&
    params[idx + 2]?.value !== null &&
    params[idx + 2]?.value !== undefined
  ) {
    // 38;5;N → 256 色索引
    return { index: params[idx + 2]!.value! }
  }
  if (next.value === 2) {
    // 38;2;R;G;B → RGB 颜色
    const r = params[idx + 2]?.value
    const g = params[idx + 3]?.value
    const b = params[idx + 4]?.value
    if (
      r !== null &&
      r !== undefined &&
      g !== null &&
      g !== undefined &&
      b !== null &&
      b !== undefined
    ) {
      return { r, g, b }
    }
  }
  return null
}

/**
 * 将 SGR 参数字符串应用到现有 TextStyle，返回新的 TextStyle。
 *
 * 【处理流程】
 * 1. 调用 parseParams 将参数字符串解析为 Param 数组
 * 2. 浅拷贝 style 为 s（保护原始状态）
 * 3. 遍历参数数组，按 code（主值）逐一处理：
 *    - 0：重置为 defaultStyle()（SGR 0）
 *    - 1/2/3/4/5-6/7/8/9：设置 bold/dim/italic/underline/blink/inverse/hidden/strikethrough
 *    - 21/22/23/24/25/27/28/29/53/55：关闭对应属性
 *    - 30–37：前景色（标准 16 色中的 0–7）
 *    - 39：前景色重置为默认
 *    - 40–47：背景色（标准 16 色中的 0–7）
 *    - 49：背景色重置为默认
 *    - 90–97：前景色（亮色，16 色中的 8–15）
 *    - 100–107：背景色（亮色，16 色中的 8–15）
 *    - 38/48/58：扩展颜色（调用 parseExtendedColor），步进 1 或 3 或 5
 *    - 59：下划线颜色重置为默认
 * 4. 未识别的参数直接跳过（i++）
 *
 * @param paramStr SGR 原始参数字符串（不含 ESC[/m）
 * @param style 当前文本样式
 * @returns 应用 SGR 后的新 TextStyle
 */
export function applySGR(paramStr: string, style: TextStyle): TextStyle {
  const params = parseParams(paramStr)
  let s = { ...style }  // 浅拷贝，保护原始 style
  let i = 0

  while (i < params.length) {
    const p = params[i]!
    const code = p.value ?? 0  // 缺省参数视为 0（即 SGR 0 重置）

    // SGR 0：重置所有属性为默认值
    if (code === 0) {
      s = defaultStyle()
      i++
      continue
    }
    // SGR 1：粗体（Bold）
    if (code === 1) {
      s.bold = true
      i++
      continue
    }
    // SGR 2：细体/暗色（Dim/Faint）
    if (code === 2) {
      s.dim = true
      i++
      continue
    }
    // SGR 3：斜体（Italic）
    if (code === 3) {
      s.italic = true
      i++
      continue
    }
    // SGR 4：下划线（Underline）；带子参数时选择样式变体
    if (code === 4) {
      s.underline = p.colon
        ? (UNDERLINE_STYLES[p.subparams[0]!] ?? 'single')
        : 'single'
      i++
      continue
    }
    // SGR 5/6：闪烁（Blink/Rapid Blink，均映射为 blink=true）
    if (code === 5 || code === 6) {
      s.blink = true
      i++
      continue
    }
    // SGR 7：反显（Inverse/Reverse Video）
    if (code === 7) {
      s.inverse = true
      i++
      continue
    }
    // SGR 8：隐藏（Invisible/Conceal）
    if (code === 8) {
      s.hidden = true
      i++
      continue
    }
    // SGR 9：删除线（Strikethrough）
    if (code === 9) {
      s.strikethrough = true
      i++
      continue
    }
    // SGR 21：双线下划线（Double Underline）
    if (code === 21) {
      s.underline = 'double'
      i++
      continue
    }
    // SGR 22：关闭粗体和细体
    if (code === 22) {
      s.bold = false
      s.dim = false
      i++
      continue
    }
    // SGR 23：关闭斜体
    if (code === 23) {
      s.italic = false
      i++
      continue
    }
    // SGR 24：关闭下划线
    if (code === 24) {
      s.underline = 'none'
      i++
      continue
    }
    // SGR 25：关闭闪烁
    if (code === 25) {
      s.blink = false
      i++
      continue
    }
    // SGR 27：关闭反显
    if (code === 27) {
      s.inverse = false
      i++
      continue
    }
    // SGR 28：关闭隐藏
    if (code === 28) {
      s.hidden = false
      i++
      continue
    }
    // SGR 29：关闭删除线
    if (code === 29) {
      s.strikethrough = false
      i++
      continue
    }
    // SGR 53：上划线（Overline）
    if (code === 53) {
      s.overline = true
      i++
      continue
    }
    // SGR 55：关闭上划线
    if (code === 55) {
      s.overline = false
      i++
      continue
    }

    // SGR 30–37：标准前景色（黑/红/绿/黄/蓝/品红/青/白）
    if (code >= 30 && code <= 37) {
      s.fg = { type: 'named', name: NAMED_COLORS[code - 30]! }
      i++
      continue
    }
    // SGR 39：前景色重置为终端默认色
    if (code === 39) {
      s.fg = { type: 'default' }
      i++
      continue
    }
    // SGR 40–47：标准背景色（黑/红/绿/黄/蓝/品红/青/白）
    if (code >= 40 && code <= 47) {
      s.bg = { type: 'named', name: NAMED_COLORS[code - 40]! }
      i++
      continue
    }
    // SGR 49：背景色重置为终端默认色
    if (code === 49) {
      s.bg = { type: 'default' }
      i++
      continue
    }
    // SGR 90–97：亮前景色（brightBlack 至 brightWhite）
    if (code >= 90 && code <= 97) {
      s.fg = { type: 'named', name: NAMED_COLORS[code - 90 + 8]! }
      i++
      continue
    }
    // SGR 100–107：亮背景色（brightBlack 至 brightWhite）
    if (code >= 100 && code <= 107) {
      s.bg = { type: 'named', name: NAMED_COLORS[code - 100 + 8]! }
      i++
      continue
    }

    // SGR 38：扩展前景色（256 索引或 RGB）
    if (code === 38) {
      const c = parseExtendedColor(params, i)
      if (c) {
        s.fg =
          'index' in c
            ? { type: 'indexed', index: c.index }
            : { type: 'rgb', ...c }
        // 冒号格式：步进 1（所有数据在同一 Param 的子参数中）
        // 分号格式：索引色步进 3（38;5;N），RGB 步进 5（38;2;R;G;B）
        i += p.colon ? 1 : 'index' in c ? 3 : 5
        continue
      }
    }
    // SGR 48：扩展背景色（256 索引或 RGB）
    if (code === 48) {
      const c = parseExtendedColor(params, i)
      if (c) {
        s.bg =
          'index' in c
            ? { type: 'indexed', index: c.index }
            : { type: 'rgb', ...c }
        i += p.colon ? 1 : 'index' in c ? 3 : 5
        continue
      }
    }
    // SGR 58：扩展下划线颜色（Kitty 扩展，256 索引或 RGB）
    if (code === 58) {
      const c = parseExtendedColor(params, i)
      if (c) {
        s.underlineColor =
          'index' in c
            ? { type: 'indexed', index: c.index }
            : { type: 'rgb', ...c }
        i += p.colon ? 1 : 'index' in c ? 3 : 5
        continue
      }
    }
    // SGR 59：下划线颜色重置为默认（Kitty 扩展）
    if (code === 59) {
      s.underlineColor = { type: 'default' }
      i++
      continue
    }

    // 未识别的 SGR 参数：跳过（避免死循环）
    i++
  }
  return s
}
