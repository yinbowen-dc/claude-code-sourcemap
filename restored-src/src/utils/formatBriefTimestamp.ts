/**
 * 简短时间戳格式化模块。
 *
 * 【在 Claude Code 系统中的位置】
 * 该模块是 UI 消息列表层的时间戳辅助工具，专门为聊天消息的时间标签行
 * 提供类似即时通讯应用（微信/Slack）的自适应时间显示格式，
 * 被 MessageTimestamp 组件等 UI 元素调用。
 *
 * 【自适应显示策略】
 * - 当天消息：仅显示时间（如 "1:30 PM" 或 "13:30"，依 locale 而定）
 * - 过去 6 天内：显示星期与时间（如 "Sunday, 4:15 PM"）
 * - 更早之前：显示完整日期与时间（如 "Sunday, Feb 20, 4:30 PM"）
 *
 * 【Locale 处理说明】
 * - 遵循 POSIX locale 环境变量（LC_ALL > LC_TIME > LANG）控制 12/24 小时制及语言
 * - 由于 Bun/V8 的 toLocaleString(undefined) 在 macOS 上忽略上述变量，
 *   本模块将其自行转换为 BCP 47 标签传入
 * - now 参数可从外部注入，便于单元测试时固定当前时间
 */

/**
 * 将 ISO 时间戳字符串格式化为简短的相对日期时间字符串。
 *
 * 【流程】
 * 1. 将 isoString 解析为 Date 对象，若无效则返回空字符串；
 * 2. 获取系统 locale（从环境变量转换为 BCP 47 标签）；
 * 3. 计算目标时间与 now 所在"当天起始"之差，得到"天数差"；
 * 4. 根据天数差选择对应的格式选项调用 toLocaleTimeString/toLocaleString。
 *
 * @param isoString - ISO 8601 格式的时间字符串（如 "2024-01-15T14:30:00Z"）
 * @param now - 参考时间，默认为当前时间；测试时可注入固定时间
 * @returns 格式化后的时间字符串，无效输入返回空字符串
 */
export function formatBriefTimestamp(
  isoString: string,
  now: Date = new Date(),
): string {
  const d = new Date(isoString) // 解析 ISO 字符串
  if (Number.isNaN(d.getTime())) {
    return '' // 无效日期字符串，返回空字符串避免显示乱码
  }

  const locale = getLocale() // 获取系统 locale 的 BCP 47 标签

  // 计算目标日期与参考日期在"当天起始"（00:00:00）级别的差值
  const dayDiff = startOfDay(now) - startOfDay(d)
  // 将毫秒差转换为天数，四舍五入处理夏令时引起的非整数天
  const daysAgo = Math.round(dayDiff / 86_400_000)

  if (daysAgo === 0) {
    // 当天：仅显示 "时:分"（12h 或 24h 取决于 locale）
    return d.toLocaleTimeString(locale, {
      hour: 'numeric',
      minute: '2-digit',
    })
  }

  if (daysAgo > 0 && daysAgo < 7) {
    // 过去 1-6 天：显示 "星期几, 时:分"（如 "Sunday, 4:15 PM"）
    return d.toLocaleString(locale, {
      weekday: 'long',
      hour: 'numeric',
      minute: '2-digit',
    })
  }

  // 7 天及更早：显示 "星期几, 月 日, 时:分"（如 "Sunday, Feb 20, 4:30 PM"）
  return d.toLocaleString(locale, {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

/**
 * 从 POSIX 环境变量派生 BCP 47 locale 标签。
 *
 * 【优先级】LC_ALL > LC_TIME > LANG，无有效值时回退到 undefined（使用系统默认）。
 *
 * 【格式转换】
 * POSIX 格式（如 "en_GB.UTF-8"）→ BCP 47（如 "en-GB"）：
 * 1. 去掉字符集后缀（如 ".UTF-8"）；
 * 2. 去掉修饰符（如 "@euro"）；
 * 3. 将下划线替换为连字符；
 * 4. 通过尝试构造 Intl.DateTimeFormat 验证标签有效性（无效标签会抛异常）。
 *
 * @returns BCP 47 locale 字符串，或 undefined（使用系统默认 locale）
 */
function getLocale(): string | undefined {
  // 按优先级读取 locale 环境变量
  const raw =
    process.env.LC_ALL || process.env.LC_TIME || process.env.LANG || ''

  // 特殊值 "C" 和 "POSIX" 表示最小化 locale，与 undefined 等效
  if (!raw || raw === 'C' || raw === 'POSIX') {
    return undefined
  }

  // 先去掉字符集（如 .UTF-8），再去掉修饰符（如 @euro），然后将 _ 替换为 -
  const base = raw.split('.')[0]!.split('@')[0]!
  if (!base) {
    return undefined
  }
  const tag = base.replaceAll('_', '-') // en_GB → en-GB

  // 通过实际构造 Intl 对象来验证标签——无效标签会抛出 RangeError
  try {
    new Intl.DateTimeFormat(tag) // 验证 BCP 47 标签有效性
    return tag
  } catch {
    return undefined // 无效标签，回退到系统默认
  }
}

/**
 * 返回给定 Date 对象所在当天 00:00:00.000 的毫秒时间戳。
 *
 * 用于消除时分秒的影响，仅比较日期（天级别）的差异。
 * 使用 Date 构造器而非字符串操作，以正确处理本地时区。
 *
 * @param d - 目标日期
 * @returns 当天起始时间的毫秒时间戳
 */
function startOfDay(d: Date): number {
  // 使用本地年/月/日构造今天 00:00:00 的时间戳，自动处理时区
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}
