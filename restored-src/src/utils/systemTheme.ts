/**
 * systemTheme.ts — 终端明暗主题检测模块
 *
 * 在 Claude Code 系统流程中的位置：
 *   UI 基础层。负责检测当前终端实际的背景色（而非操作系统级明暗设置），
 *   以便在用户选择 "auto" 主题时正确解析为 "dark" 或 "light"。
 *
 * 主要职责：
 *   1. 通过 OSC 11 查询终端背景色（由 systemThemeWatcher.ts 负责发起），
 *      将结果缓存到模块级变量供同步调用；
 *   2. 在 OSC 响应到达前，优先从 $COLORFGBG 环境变量同步推断初始主题；
 *   3. 提供 resolveThemeSetting() 将 ThemeSetting（含 "auto"）解析为具体 ThemeName；
 *   4. 提供 themeFromOscColor() 将 OSC 颜色字符串解析为 SystemTheme；
 *
 * 检测依据：
 *   终端实际背景色（OSC 11 响应），而非 OS 外观设置——
 *   在浅色 OS 模式下使用深色终端时，仍应解析为 "dark"。
 */

import type { ThemeName, ThemeSetting } from './theme.js'

/** 终端主题枚举：深色 / 浅色 */
export type SystemTheme = 'dark' | 'light'

/** 模块级缓存：存储最近一次检测到的终端主题 */
let cachedSystemTheme: SystemTheme | undefined

/**
 * 获取当前终端主题（优先返回缓存值）。
 *
 * 执行流程：
 *   1. 若缓存中已有主题，直接返回；
 *   2. 否则尝试通过 detectFromColorFgBg() 从 $COLORFGBG 同步推断；
 *   3. 若无法推断，回退为默认值 "dark"；
 *   4. 将结果写入缓存并返回。
 *
 * OSC 11 异步查询完成后，watcher 会通过 setCachedSystemTheme() 更新缓存。
 *
 * @returns 当前终端主题（"dark" 或 "light"）
 */
export function getSystemThemeName(): SystemTheme {
  if (cachedSystemTheme === undefined) {
    // 同步推断失败时回退为深色（多数终端默认深色背景）
    cachedSystemTheme = detectFromColorFgBg() ?? 'dark'
  }
  return cachedSystemTheme
}

/**
 * 更新终端主题缓存。
 *
 * 由 systemThemeWatcher.ts 在收到 OSC 11 响应后调用，
 * 以保证非 React 调用方（如工具帮助文本渲染）与实时主题同步。
 *
 * @param theme - 最新检测到的终端主题
 */
export function setCachedSystemTheme(theme: SystemTheme): void {
  cachedSystemTheme = theme
}

/**
 * 将 ThemeSetting（可能为 "auto"）解析为具体的 ThemeName。
 *
 * 执行流程：
 *   - 若 setting 为 "auto"，调用 getSystemThemeName() 动态解析；
 *   - 否则直接返回 setting 本身（已是具体主题名）。
 *
 * @param setting - 用户配置的主题设置（"auto" / "dark" / "light" 等）
 * @returns 解析后的具体主题名称
 */
export function resolveThemeSetting(setting: ThemeSetting): ThemeName {
  if (setting === 'auto') {
    return getSystemThemeName()
  }
  return setting
}

/**
 * 将 OSC 颜色响应字符串解析为 SystemTheme。
 *
 * 支持以下格式（兼容 xterm、iTerm2、Terminal.app、Ghostty、kitty、Alacritty 等）：
 *   - `rgb:R/G/B`：每个分量为 1–4 位十六进制数（按 XParseColor 规范缩放到 [0, 16^n - 1]）；
 *   - `rgba:R/G/B/A`：包含 alpha 通道（忽略 alpha 部分）；
 *   - `#RRGGBB` / `#RRRRGGGGBBBB`：哈希格式（较少见）。
 *
 * 执行流程：
 *   1. 调用 parseOscRgb() 解析颜色字符串；
 *   2. 使用 ITU-R BT.709 相对亮度公式计算背景亮度；
 *   3. 亮度 > 0.5 判定为浅色，否则为深色。
 *
 * @param data - OSC 10/11 响应的颜色字符串
 * @returns 解析到的主题；格式无法识别时返回 undefined
 */
export function themeFromOscColor(data: string): SystemTheme | undefined {
  const rgb = parseOscRgb(data)
  if (!rgb) return undefined
  // ITU-R BT.709 相对亮度公式：加权红绿蓝三通道
  const luminance = 0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b
  return luminance > 0.5 ? 'light' : 'dark'
}

/** RGB 颜色分量（各分量已归一化到 [0, 1]） */
type Rgb = { r: number; g: number; b: number }

/**
 * 将 OSC 颜色字符串解析为归一化的 RGB 对象。
 *
 * 执行流程：
 *   1. 尝试匹配 rgb:/rgba: 格式（1–4 位十六进制分量）；
 *   2. 尝试匹配 # 格式（总位数必须能被 3 整除）；
 *   3. 任一格式匹配成功则调用 hexComponent() 归一化各分量；
 *   4. 两种格式均不匹配时返回 undefined。
 *
 * @param data - OSC 响应颜色字符串
 * @returns 归一化 RGB 对象；无法解析时返回 undefined
 */
function parseOscRgb(data: string): Rgb | undefined {
  // rgb:/rgba: 格式：每个分量为 1–4 位十六进制数（某些终端附加 alpha 通道，忽略之）
  const rgbMatch =
    /^rgba?:([0-9a-f]{1,4})\/([0-9a-f]{1,4})\/([0-9a-f]{1,4})/i.exec(data)
  if (rgbMatch) {
    return {
      r: hexComponent(rgbMatch[1]!),
      g: hexComponent(rgbMatch[2]!),
      b: hexComponent(rgbMatch[3]!),
    }
  }
  // #RRGGBB 或 #RRRRGGGGBBBB：总十六进制位数必须能被 3 整除，均分三通道
  const hashMatch = /^#([0-9a-f]+)$/i.exec(data)
  if (hashMatch && hashMatch[1]!.length % 3 === 0) {
    const hex = hashMatch[1]!
    const n = hex.length / 3
    return {
      r: hexComponent(hex.slice(0, n)),
      g: hexComponent(hex.slice(n, 2 * n)),
      b: hexComponent(hex.slice(2 * n)),
    }
  }
  return undefined
}

/**
 * 将 1–4 位十六进制分量归一化到 [0, 1] 区间。
 *
 * 规则：将整数值除以该位数的最大可能值（16^n - 1），
 * 使不同位数（如 8 位 "ff" 和 16 位 "ffff"）的满值均映射到 1.0。
 *
 * @param hex - 1–4 位十六进制字符串
 * @returns [0, 1] 范围内的浮点数
 */
function hexComponent(hex: string): number {
  const max = 16 ** hex.length - 1
  return parseInt(hex, 16) / max
}

/**
 * 从 $COLORFGBG 环境变量同步推断终端主题（OSC 11 完成前的临时猜测）。
 *
 * 格式为 "fg;bg" 或 "fg;other;bg"，其中 bg 为 ANSI 颜色索引（0–15）。
 * rxvt 约定：bg 0–6 或 8 为深色；bg 7 和 9–15 为浅色。
 * 仅部分终端（rxvt 系、Konsole、开启选项的 iTerm2）设置此变量，
 * 因此仅作为"尽力猜测"的提示，非强制。
 *
 * @returns 推断到的主题；环境变量未设置或格式无效时返回 undefined
 */
function detectFromColorFgBg(): SystemTheme | undefined {
  const colorfgbg = process.env['COLORFGBG']
  if (!colorfgbg) return undefined
  // 取最后一个分号分隔的部分作为背景色索引
  const parts = colorfgbg.split(';')
  const bg = parts[parts.length - 1]
  if (bg === undefined || bg === '') return undefined
  const bgNum = Number(bg)
  if (!Number.isInteger(bgNum) || bgNum < 0 || bgNum > 15) return undefined
  // 0–6 和 8 为深色 ANSI 颜色；7（白色）和 9–15（亮色系）为浅色
  return bgNum <= 6 || bgNum === 8 ? 'dark' : 'light'
}
