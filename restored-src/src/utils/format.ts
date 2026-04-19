/**
 * 纯展示格式化模块（叶子安全，不依赖 Ink）。
 *
 * 在 Claude Code 系统中，该模块是终端渲染层的基础工具库，
 * 向上层 UI 组件（如消息列表、状态栏、diff 面板）提供与框架无关的纯文本格式化函数：
 * - formatFileSize()：将字节数格式化为人类可读的字符串（KB、MB、GB）
 * - formatSecondsShort()：将毫秒时长格式化为带 1 位小数的秒数（如 "1.2s"），用于 TTFT/hook 等短时计时
 * - formatDuration()：将任意毫秒时长格式化为可读的时间描述（如 "2h 3m 5s"）
 * - formatNumber() / formatTokens()：将数字格式化为紧凑型（1.3k、4.5m）用于 token 计数展示
 * - formatRelativeTime() / formatRelativeTimeAgo()：将时间戳格式化为相对时间字符串（如"3m ago"）
 * - formatLogMetadata()：格式化对话日志元数据行（时间、分支、大小、PR 等）
 * - formatResetTime() / formatResetText()：格式化 API 配额重置时间
 * - 宽度感知的截断函数位于 ./truncate.ts，本模块仅负责格式化、不负责截断
 * - 所有函数均为纯函数，无副作用，可安全用于测试环境
 */
// 纯展示格式化函数——叶子安全（不引入 Ink）。宽度感知截断位于 ./truncate.ts。

import { getRelativeTimeFormat, getTimeZone } from './intl.js'

/**
 * 将字节数格式化为人类可读的文件大小字符串。
 *
 * 转换规则：
 * - < 1 KB：显示原始字节数（如 "512 bytes"）
 * - 1 KB ～ 1 MB：显示 KB，保留 1 位小数（如 "1.5KB"，去掉尾随 .0）
 * - 1 MB ～ 1 GB：显示 MB，保留 1 位小数（如 "2.3MB"）
 * - ≥ 1 GB：显示 GB，保留 1 位小数（如 "1.2GB"）
 *
 * @example formatFileSize(1536) → "1.5KB"
 */
export function formatFileSize(sizeInBytes: number): string {
  // 转换为 KB 以判断量级
  const kb = sizeInBytes / 1024
  if (kb < 1) {
    // 不足 1 KB，直接显示字节数
    return `${sizeInBytes} bytes`
  }
  if (kb < 1024) {
    // 在 KB 量级内，保留 1 位小数并去掉尾随 .0
    return `${kb.toFixed(1).replace(/\.0$/, '')}KB`
  }
  // 转换为 MB
  const mb = kb / 1024
  if (mb < 1024) {
    // 在 MB 量级内，保留 1 位小数并去掉尾随 .0
    return `${mb.toFixed(1).replace(/\.0$/, '')}MB`
  }
  // 转换为 GB
  const gb = mb / 1024
  return `${gb.toFixed(1).replace(/\.0$/, '')}GB`
}

/**
 * 将毫秒数格式化为带 1 位小数的秒数字符串（如 1234ms → "1.2s"）。
 *
 * 与 formatDuration 不同，本函数始终保留小数位，适用于对精度有要求的短时间计时场景，
 * 例如 TTFT（首 token 时间）、hook 执行耗时等。
 */
export function formatSecondsShort(ms: number): string {
  // 除以 1000 转秒，保留 1 位小数
  return `${(ms / 1000).toFixed(1)}s`
}

/**
 * 将毫秒数格式化为人类可读的时长字符串（如 "2h 3m 5s"、"1d 4h"）。
 *
 * 支持选项：
 * - hideTrailingZeros：隐藏末尾全为 0 的单位（如 "2h" 而非 "2h 0m 0s"）
 * - mostSignificantOnly：仅显示最高有效单位（如 "2h" 而非 "2h 3m"）
 *
 * 处理进位：将 59.5s 进位为 60s → 1m，依此类推直至天级别。
 */
export function formatDuration(
  ms: number,
  options?: { hideTrailingZeros?: boolean; mostSignificantOnly?: boolean },
): string {
  if (ms < 60000) {
    // 不足 1 分钟时走快速路径
    if (ms === 0) {
      // 特殊情况：精确为 0
      return '0s'
    }
    // 不足 1 秒时保留 1 位小数（如 "0.5s"）
    if (ms < 1) {
      const s = (ms / 1000).toFixed(1)
      return `${s}s`
    }
    // 向下取整到整秒
    const s = Math.floor(ms / 1000).toString()
    return `${s}s`
  }

  // 分解为天/时/分/秒
  let days = Math.floor(ms / 86400000)
  let hours = Math.floor((ms % 86400000) / 3600000)
  let minutes = Math.floor((ms % 3600000) / 60000)
  let seconds = Math.round((ms % 60000) / 1000)

  // 处理进位：例如 59.5s 四舍五入为 60s 时需要向分钟进位
  if (seconds === 60) {
    seconds = 0
    minutes++
  }
  if (minutes === 60) {
    minutes = 0
    hours++
  }
  if (hours === 24) {
    hours = 0
    days++
  }

  const hide = options?.hideTrailingZeros

  // 仅显示最高有效单位模式
  if (options?.mostSignificantOnly) {
    if (days > 0) return `${days}d`
    if (hours > 0) return `${hours}h`
    if (minutes > 0) return `${minutes}m`
    return `${seconds}s`
  }

  // 天级别显示
  if (days > 0) {
    if (hide && hours === 0 && minutes === 0) return `${days}d`           // 仅天
    if (hide && minutes === 0) return `${days}d ${hours}h`               // 天+时
    return `${days}d ${hours}h ${minutes}m`                              // 天+时+分
  }
  // 时级别显示
  if (hours > 0) {
    if (hide && minutes === 0 && seconds === 0) return `${hours}h`       // 仅时
    if (hide && seconds === 0) return `${hours}h ${minutes}m`            // 时+分
    return `${hours}h ${minutes}m ${seconds}s`                           // 时+分+秒
  }
  // 分级别显示
  if (minutes > 0) {
    if (hide && seconds === 0) return `${minutes}m`                      // 仅分
    return `${minutes}m ${seconds}s`                                     // 分+秒
  }
  // 秒级别显示
  return `${seconds}s`
}

// `new Intl.NumberFormat` 构造成本较高，通过模块级变量缓存两种格式化器以供复用
let numberFormatterForConsistentDecimals: Intl.NumberFormat | null = null
let numberFormatterForInconsistentDecimals: Intl.NumberFormat | null = null

/**
 * 惰性获取数字格式化器（懒初始化 + 缓存）。
 *
 * 两种格式化器的区别：
 * - useConsistentDecimals=true（用于 ≥1000 的数字）：始终保留 1 位小数（如 "1.0k"）
 * - useConsistentDecimals=false（用于 <1000 的数字）：最多 1 位小数，0 时省略（如 "900"）
 */
const getNumberFormatter = (
  useConsistentDecimals: boolean,
): Intl.NumberFormat => {
  if (useConsistentDecimals) {
    // 紧凑型，固定 1 位小数（用于千级以上数字，保持对齐）
    if (!numberFormatterForConsistentDecimals) {
      numberFormatterForConsistentDecimals = new Intl.NumberFormat('en-US', {
        notation: 'compact',
        maximumFractionDigits: 1,
        minimumFractionDigits: 1,
      })
    }
    return numberFormatterForConsistentDecimals
  } else {
    // 紧凑型，最多 1 位小数（用于千级以下数字）
    if (!numberFormatterForInconsistentDecimals) {
      numberFormatterForInconsistentDecimals = new Intl.NumberFormat('en-US', {
        notation: 'compact',
        maximumFractionDigits: 1,
        minimumFractionDigits: 0,
      })
    }
    return numberFormatterForInconsistentDecimals
  }
}

/**
 * 将数字格式化为紧凑型小写字符串。
 *
 * 转换示例：
 * - 1321 → "1.3k"（≥1000 时紧凑+固定1位小数）
 * - 900  → "900"（<1000 时直接显示）
 * - 1000000 → "1.0m"
 */
export function formatNumber(number: number): string {
  // 仅在紧凑表示（≥1000）时使用固定小数位，确保对齐
  const shouldUseConsistentDecimals = number >= 1000

  return getNumberFormatter(shouldUseConsistentDecimals)
    .format(number)   // 例："1321" → "1.3K"，"900" → "900"
    .toLowerCase()    // 统一转小写："1.3K" → "1.3k"，"1.0K" → "1.0k"
}

/**
 * 将 token 数格式化为紧凑字符串，同时移除多余的 ".0"（如 "1.0k" → "1k"）。
 * 用于 Claude Code 界面上的 token 计数展示。
 */
export function formatTokens(count: number): string {
  return formatNumber(count).replace('.0', '')
}

/** 相对时间字符串的展示风格枚举 */
type RelativeTimeStyle = 'long' | 'short' | 'narrow'

/** formatRelativeTime 的选项类型 */
type RelativeTimeOptions = {
  style?: RelativeTimeStyle
  numeric?: 'always' | 'auto'
}

/**
 * 将日期对象格式化为相对时间字符串（如 "3m ago"、"in 2h"）。
 *
 * 处理流程：
 * 1. 计算与参考时间（now）的差值（秒）；
 * 2. 从大到小遍历时间单位（年→月→周→日→时→分→秒），取第一个满足条件的单位；
 * 3. narrow 风格使用自定义短单位（"3m ago"、"in 2h"）；
 * 4. 其他风格委托给 Intl.RelativeTimeFormat（"3 minutes ago"）；
 * 5. 差值不足 1 秒时返回 "0s ago" / "in 0s"。
 *
 * @param date - 要格式化的目标日期
 * @param options - 风格、数字模式及参考时间（默认为当前时间）
 */
export function formatRelativeTime(
  date: Date,
  options: RelativeTimeOptions & { now?: Date } = {},
): string {
  const { style = 'narrow', numeric = 'always', now = new Date() } = options
  const diffInMs = date.getTime() - now.getTime()
  // 使用 Math.trunc 向零截断，正负值均适用
  const diffInSeconds = Math.trunc(diffInMs / 1000)

  // 从大到小定义时间单位（含自定义短单位用于 narrow 风格）
  const intervals = [
    { unit: 'year',   seconds: 31536000, shortUnit: 'y'  },
    { unit: 'month',  seconds: 2592000,  shortUnit: 'mo' },
    { unit: 'week',   seconds: 604800,   shortUnit: 'w'  },
    { unit: 'day',    seconds: 86400,    shortUnit: 'd'  },
    { unit: 'hour',   seconds: 3600,     shortUnit: 'h'  },
    { unit: 'minute', seconds: 60,       shortUnit: 'm'  },
    { unit: 'second', seconds: 1,        shortUnit: 's'  },
  ] as const

  // 依次检查每个时间单位，取第一个绝对值满足的单位
  for (const { unit, seconds: intervalSeconds, shortUnit } of intervals) {
    if (Math.abs(diffInSeconds) >= intervalSeconds) {
      const value = Math.trunc(diffInSeconds / intervalSeconds)
      // narrow 风格使用自定义短格式（"3m ago"、"in 2h"）
      if (style === 'narrow') {
        return diffInSeconds < 0
          ? `${Math.abs(value)}${shortUnit} ago`  // 过去
          : `in ${value}${shortUnit}`             // 将来
      }
      // 其他风格委托给 Intl.RelativeTimeFormat
      return getRelativeTimeFormat('long', numeric).format(value, unit)
    }
  }

  // 差值不足 1 秒时的兜底处理
  if (style === 'narrow') {
    return diffInSeconds <= 0 ? '0s ago' : 'in 0s'
  }
  return getRelativeTimeFormat(style, numeric).format(0, 'second')
}

/**
 * 将过去日期格式化为 "X 时间前" 格式的字符串（强制 numeric: always）。
 *
 * 与 formatRelativeTime 的区别：
 * - 对未来日期，直接调用 formatRelativeTime 返回 "in X" 格式；
 * - 对过去日期，强制使用 numeric: 'always' 确保输出 "X units ago" 而非 "yesterday"。
 */
export function formatRelativeTimeAgo(
  date: Date,
  options: RelativeTimeOptions & { now?: Date } = {},
): string {
  const { now = new Date(), ...restOptions } = options
  if (date > now) {
    // 未来日期：不需要 "ago" 前缀，直接返回相对时间
    return formatRelativeTime(date, { ...restOptions, now })
  }

  // 过去日期：强制 numeric: 'always' 以确保始终输出 "X units ago"
  return formatRelativeTime(date, { ...restOptions, numeric: 'always', now })
}

/**
 * 格式化对话日志的元数据行，用于 UI 中的历史记录列表。
 *
 * 输出格式（各字段以 · 分隔）：
 * "3m ago · main · 4.2KB · #my-tag · @agent · owner/repo#42"
 *
 * 字段说明：
 * - 修改时间（相对时间）
 * - git 分支名（若有）
 * - 文件大小（若有 fileSize）或消息数（若无 fileSize）
 * - 标签（若有 tag）
 * - 代理设置（若有 agentSetting）
 * - PR 编号（若有 prNumber，可选带仓库名）
 */
export function formatLogMetadata(log: {
  modified: Date
  messageCount: number
  fileSize?: number
  gitBranch?: string
  tag?: string
  agentSetting?: string
  prNumber?: number
  prRepository?: string
}): string {
  // 优先使用文件大小，否则显示消息数
  const sizeOrCount =
    log.fileSize !== undefined
      ? formatFileSize(log.fileSize)
      : `${log.messageCount} messages`
  // 基础字段：时间 + 分支（可选）+ 大小/消息数
  const parts = [
    formatRelativeTimeAgo(log.modified, { style: 'short' }),
    ...(log.gitBranch ? [log.gitBranch] : []),
    sizeOrCount,
  ]
  // 追加可选字段
  if (log.tag) {
    parts.push(`#${log.tag}`)                                    // 标签前缀 #
  }
  if (log.agentSetting) {
    parts.push(`@${log.agentSetting}`)                           // 代理设置前缀 @
  }
  if (log.prNumber) {
    parts.push(
      log.prRepository
        ? `${log.prRepository}#${log.prNumber}`                  // 带仓库名的 PR 引用
        : `#${log.prNumber}`,                                    // 仅 PR 编号
    )
  }
  // 以中点分隔符连接所有部分
  return parts.join(' · ')
}

/**
 * 将 API 配额重置时间戳格式化为本地时间字符串。
 *
 * 自适应显示策略：
 * - 重置时间在 24 小时以内：仅显示时间（如 "2:30pm"）
 * - 重置时间超过 24 小时：显示日期+时间（如 "Apr 20, 2:30pm"）
 * - 跨年时额外附加年份
 * - showTimezone=true 时追加时区（如 " (PST)"）
 * - showTime=false 时仅显示日期（隐藏时间部分）
 *
 * @param timestampInSeconds - Unix 时间戳（秒）
 * @param showTimezone - 是否附加时区字符串
 * @param showTime - 是否显示时间部分
 * @returns 格式化后的字符串，或 undefined（时间戳为空时）
 */
export function formatResetTime(
  timestampInSeconds: number | undefined,
  showTimezone: boolean = false,
  showTime: boolean = true,
): string | undefined {
  if (!timestampInSeconds) return undefined

  // 将秒级时间戳转换为 Date 对象
  const date = new Date(timestampInSeconds * 1000)
  const now = new Date()
  const minutes = date.getMinutes()

  // 计算距重置的小时数
  const hoursUntilReset = (date.getTime() - now.getTime()) / (1000 * 60 * 60)

  // 超过 24 小时：显示日期+时间
  if (hoursUntilReset > 24) {
    const dateOptions: Intl.DateTimeFormatOptions = {
      month: 'short',
      day: 'numeric',
      hour: showTime ? 'numeric' : undefined,
      // 整点时不显示分钟（避免 "2:00pm" 显示）
      minute: !showTime || minutes === 0 ? undefined : '2-digit',
      hour12: showTime ? true : undefined,
    }

    // 跨年时附加年份
    if (date.getFullYear() !== now.getFullYear()) {
      dateOptions.year = 'numeric'
    }

    const dateString = date.toLocaleString('en-US', dateOptions)

    // 去掉 AM/PM 前的空格并转小写（如 " PM" → "pm"）
    return (
      dateString.replace(/ ([AP]M)/i, (_match, ampm) => ampm.toLowerCase()) +
      (showTimezone ? ` (${getTimeZone()})` : '')
    )
  }

  // 不足 24 小时：仅显示时间
  const timeString = date.toLocaleTimeString('en-US', {
    hour: 'numeric',
    // 整点时不显示分钟
    minute: minutes === 0 ? undefined : '2-digit',
    hour12: true,
  })

  // 去掉 AM/PM 前的空格并转小写，然后选择性附加时区
  return (
    timeString.replace(/ ([AP]M)/i, (_match, ampm) => ampm.toLowerCase()) +
    (showTimezone ? ` (${getTimeZone()})` : '')
  )
}

/**
 * 将 ISO 格式的重置时间字符串格式化为人类可读字符串。
 * 是 formatResetTime 的便捷包装，接受 ISO 字符串而非 Unix 时间戳。
 *
 * @param resetsAt - ISO 8601 格式的时间字符串（如 "2024-04-20T14:30:00Z"）
 */
export function formatResetText(
  resetsAt: string,
  showTimezone: boolean = false,
  showTime: boolean = true,
): string {
  const dt = new Date(resetsAt)
  // 转换为秒级时间戳后委托给 formatResetTime
  return `${formatResetTime(Math.floor(dt.getTime() / 1000), showTimezone, showTime)}`
}

// 向后兼容：截断辅助函数已移至 ./truncate.ts（需要 ink/stringWidth）
export {
  truncate,
  truncatePathMiddle,
  truncateStartToWidth,
  truncateToWidth,
  truncateToWidthNoEllipsis,
  wrapText,
} from './truncate.js'
