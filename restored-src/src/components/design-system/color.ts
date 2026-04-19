/**
 * 【设计系统 - 颜色工具函数】
 *
 * 在 Claude Code 系统流程中的位置：
 * 设计系统的基础颜色层。其他所有需要给文本着色的组件（Divider、ListItem、
 * ProgressBar 等）都通过此函数将主题色键名（如 "success"、"error"）解析为
 * 实际颜色值，再交给 ink 渲染器的 colorize 函数输出带 ANSI 转义码的彩色文本。
 *
 * 主要功能：
 * 1. 区分"原始颜色值"（rgb(...)、#hex、ansi256(...)、ansi:...）和"主题键名"
 * 2. 主题键名走 getTheme(theme)[key] 查表，原始值直接透传
 * 3. 返回柯里化函数，先绑定颜色参数，再接收待着色文本
 */

import { type ColorType, colorize } from '../../ink/colorize.js'
import type { Color } from '../../ink/styles.js'
import { getTheme, type Theme, type ThemeName } from '../../utils/theme.js'

/**
 * 柯里化的主题感知颜色函数。
 *
 * 整体流程：
 * 1. 接收颜色标识符 `c`（主题键 或 原始颜色值 或 undefined）、主题名 `theme`、着色类型 `type`
 * 2. 返回一个 `(text: string) => string` 闭包
 * 3. 闭包执行时：若 c 为空则原样返回；若 c 为原始颜色格式则直接调用 colorize；
 *    否则通过 getTheme 将主题键转换为实际颜色值再调用 colorize
 *
 * @param c     颜色标识符：可以是 Theme 的键名、原始颜色字符串或 undefined
 * @param theme 当前主题名称，用于调用 getTheme 查表
 * @param type  着色类型，默认 'foreground'（前景色），也可为 'background'
 * @returns     接收文本并返回带颜色 ANSI 转义码字符串的函数
 */
export function color(
  c: keyof Theme | Color | undefined,
  theme: ThemeName,
  type: ColorType = 'foreground',
): (text: string) => string {
  return text => {
    // 若颜色参数为空，直接返回原文本，不做任何处理
    if (!c) {
      return text
    }
    // 检测是否为原始颜色值格式，原始值无需主题查表，直接传给 colorize
    if (
      c.startsWith('rgb(') ||      // CSS rgb 格式
      c.startsWith('#') ||          // 十六进制颜色
      c.startsWith('ansi256(') ||   // ansi256 索引格式
      c.startsWith('ansi:')         // 命名 ANSI 颜色
    ) {
      return colorize(text, c, type)
    }
    // 主题键名：通过 getTheme 查表获取真实颜色值后再着色
    return colorize(text, getTheme(theme)[c as keyof Theme], type)
  }
}
