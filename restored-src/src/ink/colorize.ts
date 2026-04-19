/**
 * 终端颜色渲染模块（Terminal Color Rendering）
 *
 * 【在 Claude Code / Ink 系统中的位置】
 * 本文件处于 Ink 渲染管线的"样式应用"阶段：
 *   组件 TextStyles/Color 属性 → [本模块：颜色/样式 → ANSI 转义序列] → 字符串输出 → 终端显示
 *
 * 【主要功能】
 * 1. 在模块加载时检测并修正 chalk 的颜色级别（level），解决以下两个平台兼容性问题：
 *    - xterm.js 环境（VS Code / Cursor / code-server）：chalk 误将其识别为 256 色（level 2），
 *      导致 RGB 真彩色被降级为最近的 6×6×6 色板颜色，颜色失真。
 *    - tmux 环境：tmux 默认不向外部终端透传真彩色 SGR 序列，导致背景色消失，
 *      需将 chalk 降级到 256 色（level 2）以确保正确透传。
 * 2. 提供 colorize() 函数：将颜色值（ANSI 命名色、#HEX、ansi256()、rgb()）应用到字符串。
 * 3. 提供 applyTextStyles() 函数：将结构化的 TextStyles 对象转换为带 ANSI 样式的字符串。
 * 4. 提供 applyColor() 函数：对单一前景色进行快捷应用。
 */
import chalk from 'chalk'
import type { Color, TextStyles } from './styles.js'

/**
 * 为 xterm.js 环境提升 chalk 颜色级别至真彩色（level 3）。
 *
 * 【背景】
 * xterm.js（VS Code、Cursor、code-server、Coder）自 2017 年起支持真彩色，
 * 但 code-server/Coder 容器通常未设置 COLORTERM=truecolor。
 * chalk 的 supports-color 模块不能识别 TERM_PROGRAM=vscode（仅识别 iTerm.app/Apple_Terminal），
 * 因此会依据 -256color 正则匹配，将颜色级别定为 2（256 色）。
 * 在 level 2 下，chalk.rgb() 会将 RGB 颜色降级为最近的 6×6×6 色板颜色，
 * 导致颜色失真（例如 rgb(215,119,87) → idx 174 rgb(215,135,135)，橙色变成洗白的粉色）。
 *
 * 【触发条件】
 * 仅在 level === 2 时提升（不是 < 3），以尊重 NO_COLOR / FORCE_COLOR=0 的明确"禁色"请求
 * （这些会将 level 设为 0，不应被强制提升）。
 * 桌面版 VS Code 自行设置 COLORTERM=truecolor，因此已是 level 3，此函数为空操作。
 *
 * 【顺序要求】
 * 必须在 tmux 降级之前运行——若 tmux 运行在 VS Code 终端内部，
 * tmux 的透传限制优先生效，需要在提升后再由 tmux 降级函数重新降级。
 *
 * @returns true 表示已提升级别，false 表示无需提升
 */
function boostChalkLevelForXtermJs(): boolean {
  // 仅在 VS Code 终端且颜色级别为 256 色时提升为真彩色
  if (process.env.TERM_PROGRAM === 'vscode' && chalk.level === 2) {
    chalk.level = 3  // 将 chalk 升级到真彩色支持
    return true
  }
  return false
}

/**
 * 为 tmux 环境将 chalk 颜色级别降级至 256 色（level 2）。
 *
 * 【背景】
 * tmux 能正确解析真彩色 SGR（\e[48;2;r;g;bm）并存入内部 cell 缓冲区，
 * 但在向外部终端重新输出时，只有配置了 terminal-overrides Tc/RGB 能力的 tmux
 * 才会透传真彩色。默认配置下，tmux 不发送背景色序列，外部终端的背景色为默认（通常为黑色），
 * 在深色主题下造成视觉错误。
 * 降级为 256 色后，chalk 使用 \e[48;5;Nm 序列，tmux 能正确透传，视觉效果几乎无差异。
 *
 * 【豁免条件】
 * 若设置了 CLAUDE_CODE_TMUX_TRUECOLOR 环境变量，说明用户已在 tmux 配置中启用了 Tc，
 * 真彩色可以正常透传，跳过降级。
 *
 * @returns true 表示已降级，false 表示无需降级
 */
function clampChalkLevelForTmux(): boolean {
  // bg.ts 在 attach 前设置了 terminal-overrides :Tc，真彩色可以透传，跳过降级
  if (process.env.CLAUDE_CODE_TMUX_TRUECOLOR) return false
  // 在 tmux 环境中且颜色级别高于 256 色时降级
  if (process.env.TMUX && chalk.level > 2) {
    chalk.level = 2  // 降级到 256 色，确保 tmux 正确透传
    return true
  }
  return false
}

// 模块加载时执行一次颜色级别检测与调整，终端/tmux 环境在会话期间不会改变。
// 顺序重要：先提升（xterm.js）再降级（tmux），使两者能正确叠加处理。
// 导出供调试使用——若未使用会被 tree-shaking 移除。
export const CHALK_BOOSTED_FOR_XTERMJS = boostChalkLevelForXtermJs()
export const CHALK_CLAMPED_FOR_TMUX = clampChalkLevelForTmux()

// 颜色类型：前景色（文字颜色）或背景色
export type ColorType = 'foreground' | 'background'

// 匹配 rgb(r, g, b) 格式颜色值的正则（如 "rgb(215, 119, 87)"）
const RGB_REGEX = /^rgb\(\s?(\d+),\s?(\d+),\s?(\d+)\s?\)$/
// 匹配 ansi256(n) 格式颜色值的正则（如 "ansi256(174)"）
const ANSI_REGEX = /^ansi256\(\s?(\d+)\s?\)$/

/**
 * 将颜色值应用到字符串，返回带 ANSI 转义序列的着色字符串。
 *
 * 【支持的颜色格式】
 * - "ansi:colorName"：ANSI 16 色命名（如 "ansi:red"、"ansi:blueBright"）
 * - "#RRGGBB"：十六进制 RGB 真彩色（如 "#FF5733"）
 * - "ansi256(n)"：256 色板颜色（n 为 0-255 的整数）
 * - "rgb(r, g, b)"：RGB 真彩色（如 "rgb(215, 119, 87)"）
 *
 * @param str - 待着色的文本字符串
 * @param color - 颜色值字符串，undefined 时直接返回原字符串
 * @param type - 'foreground' 为前景色（文字颜色），'background' 为背景色
 * @returns 带 ANSI 颜色转义序列的字符串
 */
export const colorize = (
  str: string,
  color: string | undefined,
  type: ColorType,
): string => {
  // 无颜色时直接返回原字符串，避免不必要的处理
  if (!color) {
    return str
  }

  // 处理 ANSI 命名颜色格式（"ansi:colorName"）
  if (color.startsWith('ansi:')) {
    const value = color.substring('ansi:'.length)  // 去掉 "ansi:" 前缀，获取颜色名称
    switch (value) {
      case 'black':
        return type === 'foreground' ? chalk.black(str) : chalk.bgBlack(str)
      case 'red':
        return type === 'foreground' ? chalk.red(str) : chalk.bgRed(str)
      case 'green':
        return type === 'foreground' ? chalk.green(str) : chalk.bgGreen(str)
      case 'yellow':
        return type === 'foreground' ? chalk.yellow(str) : chalk.bgYellow(str)
      case 'blue':
        return type === 'foreground' ? chalk.blue(str) : chalk.bgBlue(str)
      case 'magenta':
        return type === 'foreground' ? chalk.magenta(str) : chalk.bgMagenta(str)
      case 'cyan':
        return type === 'foreground' ? chalk.cyan(str) : chalk.bgCyan(str)
      case 'white':
        return type === 'foreground' ? chalk.white(str) : chalk.bgWhite(str)
      case 'blackBright':
        return type === 'foreground'
          ? chalk.blackBright(str)
          : chalk.bgBlackBright(str)
      case 'redBright':
        return type === 'foreground'
          ? chalk.redBright(str)
          : chalk.bgRedBright(str)
      case 'greenBright':
        return type === 'foreground'
          ? chalk.greenBright(str)
          : chalk.bgGreenBright(str)
      case 'yellowBright':
        return type === 'foreground'
          ? chalk.yellowBright(str)
          : chalk.bgYellowBright(str)
      case 'blueBright':
        return type === 'foreground'
          ? chalk.blueBright(str)
          : chalk.bgBlueBright(str)
      case 'magentaBright':
        return type === 'foreground'
          ? chalk.magentaBright(str)
          : chalk.bgMagentaBright(str)
      case 'cyanBright':
        return type === 'foreground'
          ? chalk.cyanBright(str)
          : chalk.bgCyanBright(str)
      case 'whiteBright':
        return type === 'foreground'
          ? chalk.whiteBright(str)
          : chalk.bgWhiteBright(str)
    }
  }

  // 处理十六进制 RGB 颜色格式（"#RRGGBB" 或 "#RGB"）
  if (color.startsWith('#')) {
    return type === 'foreground'
      ? chalk.hex(color)(str)    // 前景色：chalk.hex('#FF5733')(str)
      : chalk.bgHex(color)(str)  // 背景色：chalk.bgHex('#FF5733')(str)
  }

  // 处理 256 色板颜色格式（"ansi256(n)"）
  if (color.startsWith('ansi256')) {
    const matches = ANSI_REGEX.exec(color)  // 提取括号内的数字

    if (!matches) {
      return str  // 格式不匹配则返回原字符串
    }

    const value = Number(matches[1])  // 转换为数字（0-255）

    return type === 'foreground'
      ? chalk.ansi256(value)(str)    // 前景色：256 色
      : chalk.bgAnsi256(value)(str)  // 背景色：256 色
  }

  // 处理 RGB 真彩色格式（"rgb(r, g, b)"）
  if (color.startsWith('rgb')) {
    const matches = RGB_REGEX.exec(color)  // 提取 r、g、b 三个数值

    if (!matches) {
      return str  // 格式不匹配则返回原字符串
    }

    const firstValue = Number(matches[1])   // R 分量（0-255）
    const secondValue = Number(matches[2])  // G 分量（0-255）
    const thirdValue = Number(matches[3])   // B 分量（0-255）

    return type === 'foreground'
      ? chalk.rgb(firstValue, secondValue, thirdValue)(str)    // 前景色：真彩色
      : chalk.bgRgb(firstValue, secondValue, thirdValue)(str)  // 背景色：真彩色
  }

  // 未识别的颜色格式，返回原字符串
  return str
}

/**
 * 将结构化的 TextStyles 对象应用到文本字符串，生成带 ANSI 样式序列的字符串。
 *
 * 【与 colorize 的关系】
 * 本函数是 colorize 的上层封装，处理完整的文本样式（粗体、斜体、下划线等），
 * 而 colorize 仅处理颜色。主题解析（theme token → 实际颜色值）发生在组件层，
 * 到达本函数时 styles.color 已经是原始颜色值。
 *
 * 【chalk 嵌套顺序说明】
 * chalk 通过包裹方式叠加样式，后调用的成为外层包装。
 * 期望的嵌套顺序（从最外层到最内层）：背景色 > 前景色 > 文字修饰符
 * 因此应用顺序：先文字修饰符，再前景色，最后背景色。
 *
 * @param text - 待应用样式的文本字符串
 * @param styles - 包含颜色、粗体、斜体等样式的结构化对象
 * @returns 带 ANSI 样式转义序列的字符串
 */
export function applyTextStyles(text: string, styles: TextStyles): string {
  let result = text

  // 按"最内层到最外层"的顺序依次应用样式（chalk 后调用的包在最外层）

  // 应用文字修饰符（最内层）
  if (styles.inverse) {
    result = chalk.inverse(result)  // 反色：交换前景色和背景色
  }

  if (styles.strikethrough) {
    result = chalk.strikethrough(result)  // 删除线
  }

  if (styles.underline) {
    result = chalk.underline(result)  // 下划线
  }

  if (styles.italic) {
    result = chalk.italic(result)  // 斜体
  }

  if (styles.bold) {
    result = chalk.bold(result)  // 粗体
  }

  if (styles.dim) {
    result = chalk.dim(result)  // 暗淡（降低亮度）
  }

  // 应用前景色（中间层）
  if (styles.color) {
    // 主题解析已在组件层完成，styles.color 此处为原始颜色值
    result = colorize(result, styles.color, 'foreground')
  }

  // 应用背景色（最外层）
  if (styles.backgroundColor) {
    // 同上，styles.backgroundColor 为原始颜色值
    result = colorize(result, styles.backgroundColor, 'background')
  }

  return result
}

/**
 * 将单一前景色应用到文本字符串的快捷函数。
 *
 * 主题解析应在组件层完成，此处接收的 color 为原始颜色值。
 * 无颜色时直接返回原字符串，避免不必要的调用。
 *
 * @param text - 待着色的文本字符串
 * @param color - 前景色颜色值（Color 类型），undefined 时直接返回原字符串
 * @returns 带前景色 ANSI 序列的字符串，或原字符串
 */
export function applyColor(text: string, color: Color | undefined): string {
  if (!color) {
    return text
  }
  // 委托给 colorize，指定为前景色类型
  return colorize(text, color, 'foreground')
}
