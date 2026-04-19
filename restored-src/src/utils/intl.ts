/**
 * 国际化（Intl）对象缓存模块
 *
 * 【在 Claude Code 系统流程中的位置】
 * 本模块是一个底层性能优化工具，被代码库中所有需要进行 Unicode 文本处理、
 * 相对时间格式化或时区检测的组件调用。Intl 构造函数（Segmenter、
 * RelativeTimeFormat、DateTimeFormat）的初始化开销约为每次 0.05-0.1ms，
 * 在高频调用场景（如每次渲染、每次按键）下积累的开销不可忽略。
 * 本模块通过懒加载（Lazy Initialization）和单例缓存消除这些重复开销。
 *
 * 【主要功能】
 * 1. getGraphemeSegmenter / firstGrapheme / lastGrapheme：
 *    Unicode 字形簇（Grapheme Cluster）分割，正确处理 emoji 和多字节字符；
 * 2. getWordSegmenter：Unicode 单词分割；
 * 3. getRelativeTimeFormat：相对时间格式化（如"3 分钟前"）；
 * 4. getTimeZone：获取当前进程的时区；
 * 5. getSystemLocaleLanguage：获取系统语言子标签（如 'en'、'ja'）。
 */

// Unicode 文本分割器（懒加载单例，首次调用时初始化）
let graphemeSegmenter: Intl.Segmenter | null = null
let wordSegmenter: Intl.Segmenter | null = null

/**
 * 获取字形簇分割器的单例实例（懒加载）。
 * 字形簇是用户感知的最小字符单位，一个 emoji 或组合字符可能由多个 Unicode
 * 码点组成，但在视觉上表现为一个"字符"。使用字形簇粒度的分割器能正确处理
 * 这类复杂情况（如 👨‍👩‍👧‍👦 家庭 emoji 由多个码点组成但算作一个字形簇）。
 */
export function getGraphemeSegmenter(): Intl.Segmenter {
  if (!graphemeSegmenter) {
    // undefined 表示使用默认 locale（跟随系统）
    graphemeSegmenter = new Intl.Segmenter(undefined, {
      granularity: 'grapheme', // 字形簇粒度（最细粒度）
    })
  }
  return graphemeSegmenter
}

/**
 * 提取字符串的第一个字形簇。
 * 对于普通 ASCII 字符，等同于 str[0]；
 * 对于组合 emoji 或复杂 Unicode 字符，能正确提取完整的视觉字符。
 * 空字符串返回 ''。
 */
export function firstGrapheme(text: string): string {
  if (!text) return ''
  const segments = getGraphemeSegmenter().segment(text)
  // 使用迭代器取第一个片段，避免遍历整个字符串
  const first = segments[Symbol.iterator]().next().value
  return first?.segment ?? ''
}

/**
 * 提取字符串的最后一个字形簇。
 * 遍历所有片段取最后一个，正确处理末尾的组合字符和 emoji。
 * 空字符串返回 ''。
 */
export function lastGrapheme(text: string): string {
  if (!text) return ''
  let last = ''
  // 必须遍历完所有片段才能确定最后一个
  for (const { segment } of getGraphemeSegmenter().segment(text)) {
    last = segment
  }
  return last
}

/**
 * 获取单词分割器的单例实例（懒加载）。
 * 用于将文本按词边界拆分，遵循 Unicode 单词边界规则，
 * 能正确处理中日韩等无空格分隔的语言（结合系统 locale）。
 */
export function getWordSegmenter(): Intl.Segmenter {
  if (!wordSegmenter) {
    wordSegmenter = new Intl.Segmenter(undefined, { granularity: 'word' })
  }
  return wordSegmenter
}

// RelativeTimeFormat 实例缓存（以 "style:numeric" 为键）
// 例如 'long:always' → 对应实例，'short:auto' → 对应实例
const rtfCache = new Map<string, Intl.RelativeTimeFormat>()

/**
 * 获取指定样式和数字格式的相对时间格式化器（带缓存）。
 * 相同的 style+numeric 组合只创建一次实例，后续调用直接返回缓存。
 *
 * @param style - 格式样式：'long'（"3 minutes ago"）、'short'（"3 min. ago"）、
 *                'narrow'（"3 min. ago"，最简短）
 * @param numeric - 数字显示方式：'always'（始终显示数字）、
 *                  'auto'（"yesterday" 而非 "1 day ago"）
 */
export function getRelativeTimeFormat(
  style: 'long' | 'short' | 'narrow',
  numeric: 'always' | 'auto',
): Intl.RelativeTimeFormat {
  // 以组合键区分不同配置的格式化器
  const key = `${style}:${numeric}`
  let rtf = rtfCache.get(key)
  if (!rtf) {
    // 固定使用英语（'en'），与 Claude Code 的 UI 语言保持一致
    rtf = new Intl.RelativeTimeFormat('en', { style, numeric })
    rtfCache.set(key, rtf)
  }
  return rtf
}

// 时区在进程生命周期内不会改变，缓存一次即可
let cachedTimeZone: string | null = null

/**
 * 获取当前进程运行时的时区标识符（如 'Asia/Shanghai'、'America/New_York'）。
 * 通过 DateTimeFormat().resolvedOptions() 获取，结果缓存避免重复创建实例。
 */
export function getTimeZone(): string {
  if (!cachedTimeZone) {
    // DateTimeFormat 会根据系统环境自动确定时区
    cachedTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
  }
  return cachedTimeZone
}

// 系统 locale 语言子标签在进程生命周期内不变，缓存一次即可。
// null = 尚未计算；undefined = 已计算但不可用（ICU 数据不完整的环境下
// 只失败一次，而非每次调用都重试）。
let cachedSystemLocaleLanguage: string | undefined | null = null

/**
 * 获取系统 locale 的语言子标签（如 'en'、'ja'、'zh'）。
 * 从 DateTimeFormat().resolvedOptions().locale 中提取语言子标签。
 * 若环境的 ICU 数据不完整（精简 ICU 环境），返回 undefined 并缓存该结果，
 * 避免后续调用反复尝试（以失败告终）。
 */
export function getSystemLocaleLanguage(): string | undefined {
  if (cachedSystemLocaleLanguage === null) {
    try {
      // 获取完整 locale（如 'en-US'），再提取语言子标签
      const locale = Intl.DateTimeFormat().resolvedOptions().locale
      // Intl.Locale 能正确解析复杂 locale 字符串并提取语言部分
      cachedSystemLocaleLanguage = new Intl.Locale(locale).language
    } catch {
      // ICU 数据不完整或其他错误，标记为不可用（undefined）
      // 后续调用看到 undefined !== null 时直接返回，不再尝试
      cachedSystemLocaleLanguage = undefined
    }
  }
  return cachedSystemLocaleLanguage
}
