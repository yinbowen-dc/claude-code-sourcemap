/**
 * Cron 表达式解析与下次执行时间计算模块。
 *
 * 在 Claude Code 系统中，该模块提供最小化的 cron 表达式解析和下次运行时间计算：
 * 支持标准 5 字段 cron 子集（分钟 小时 日 月 星期），
 * 用于 cronScheduler.ts 中调度任务的触发时间计算。
 */
// 5字段 cron 表达式最小化解析与下次执行时间计算。
//
// 支持标准 5 字段 cron 子集：
//   分钟 小时 日期 月份 星期
//
// 字段语法：通配符、单值 N、步进（*/N）、范围（N-M）、列表（N,M,...）。
// 不支持 L、W、? 及名称别名。所有时间以进程本地时区解释——
// "0 9 * * *" 表示 CLI 运行所在时区的上午 9 点。

export type CronFields = {
  minute: number[]
  hour: number[]
  dayOfMonth: number[]
  month: number[]
  dayOfWeek: number[]
}

type FieldRange = { min: number; max: number }

const FIELD_RANGES: FieldRange[] = [
  { min: 0, max: 59 }, // 分钟：0-59
  { min: 0, max: 23 }, // 小时：0-23
  { min: 1, max: 31 }, // 日期：1-31
  { min: 1, max: 12 }, // 月份：1-12
  { min: 0, max: 6 }, // 星期：0=周日；7 作为周日别名也被接受
]

/**
 * 将单个 cron 字段解析为匹配值的有序数组。
 * 支持：通配符、单值 N、步进 */N、范围 N-M（含可选步进），以及逗号分隔的列表。
 * 语法错误时返回 null。
 */
function expandField(field: string, range: FieldRange): number[] | null {
  const { min, max } = range
  const out = new Set<number>()

  for (const part of field.split(',')) {
    // 通配符或 */N 步进
    const stepMatch = part.match(/^\*(?:\/(\d+))?$/)
    if (stepMatch) {
      const step = stepMatch[1] ? parseInt(stepMatch[1], 10) : 1
      if (step < 1) return null
      for (let i = min; i <= max; i += step) out.add(i)
      continue
    }

    // N-M 范围或 N-M/S 步进范围
    const rangeMatch = part.match(/^(\d+)-(\d+)(?:\/(\d+))?$/)
    if (rangeMatch) {
      const lo = parseInt(rangeMatch[1]!, 10)
      const hi = parseInt(rangeMatch[2]!, 10)
      const step = rangeMatch[3] ? parseInt(rangeMatch[3], 10) : 1
      // 星期字段：在范围中接受 7 作为周日别名（例如 5-7 = 周五、周六、周日 → [5,6,0]）
      const isDow = min === 0 && max === 6
      const effMax = isDow ? 7 : max
      if (lo > hi || step < 1 || lo < min || hi > effMax) return null
      for (let i = lo; i <= hi; i += step) {
        out.add(isDow && i === 7 ? 0 : i)
      }
      continue
    }

    // 单值 N
    const singleMatch = part.match(/^\d+$/)
    if (singleMatch) {
      let n = parseInt(part, 10)
      // 星期字段：将 7（周日别名）归一化为 0
      if (min === 0 && max === 6 && n === 7) n = 0
      if (n < min || n > max) return null
      out.add(n)
      continue
    }

    return null
  }

  if (out.size === 0) return null
  return Array.from(out).sort((a, b) => a - b)
}

/**
 * 将 5 字段 cron 表达式解析为各字段展开后的数值数组。
 * 语法无效或不支持时返回 null。
 */
export function parseCronExpression(expr: string): CronFields | null {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) return null

  const expanded: number[][] = []
  for (let i = 0; i < 5; i++) {
    const result = expandField(parts[i]!, FIELD_RANGES[i]!)
    if (!result) return null
    expanded.push(result)
  }

  return {
    minute: expanded[0]!,
    hour: expanded[1]!,
    dayOfMonth: expanded[2]!,
    month: expanded[3]!,
    dayOfWeek: expanded[4]!,
  }
}

/**
 * 计算在 `from` 之后严格满足 cron 字段的下一个 Date（以进程本地时区解释）。
 * 逐分钟向前步进。上限 366 天；无匹配时返回 null（对于有效 cron 不可能发生，
 * 但满足类型约束）。
 *
 * 标准 cron 语义：当 dayOfMonth 和 dayOfWeek 均受约束
 * （均非全范围）时，满足任意一个即视为日期匹配（OR 语义）。
 *
 * 夏令时处理：
 * - spring-forward（拨快）跳过间隙：针对跳过时区的固定小时 cron
 *   （如 US 时区的 `30 2 * * *`），该小时从未在本地时间出现，小时集合检查失败，
 *   循环前进到下一天——与 vixie-cron 行为一致。
 * - 通配小时 cron（`30 * * * *`）在间隙后的第一个有效分钟触发。
 * - fall-back（拨慢）重复：只触发一次（前进逻辑跳过第二次出现）。
 */
export function computeNextCronRun(
  fields: CronFields,
  from: Date,
): Date | null {
  const minuteSet = new Set(fields.minute)
  const hourSet = new Set(fields.hour)
  const domSet = new Set(fields.dayOfMonth)
  const monthSet = new Set(fields.month)
  const dowSet = new Set(fields.dayOfWeek)

  // 判断字段是否为全范围通配（31天/7天）
  const domWild = fields.dayOfMonth.length === 31
  const dowWild = fields.dayOfWeek.length === 7

  // 进位到 `from` 之后的下一整分钟
  const t = new Date(from.getTime())
  t.setSeconds(0, 0)
  t.setMinutes(t.getMinutes() + 1)

  const maxIter = 366 * 24 * 60
  for (let i = 0; i < maxIter; i++) {
    const month = t.getMonth() + 1
    if (!monthSet.has(month)) {
      // 月份不匹配：跳至下个月 1 日 0 时
      t.setMonth(t.getMonth() + 1, 1)
      t.setHours(0, 0, 0, 0)
      continue
    }

    const dom = t.getDate()
    const dow = t.getDay()
    // 当 dom/dow 均受约束时，任意一个匹配即可（OR 语义）
    const dayMatches =
      domWild && dowWild
        ? true
        : domWild
          ? dowSet.has(dow)
          : dowWild
            ? domSet.has(dom)
            : domSet.has(dom) || dowSet.has(dow)

    if (!dayMatches) {
      // 日期不匹配：跳至次日 0 时
      t.setDate(t.getDate() + 1)
      t.setHours(0, 0, 0, 0)
      continue
    }

    if (!hourSet.has(t.getHours())) {
      // 小时不匹配：前进到下一小时的 0 分
      t.setHours(t.getHours() + 1, 0, 0, 0)
      continue
    }

    if (!minuteSet.has(t.getMinutes())) {
      // 分钟不匹配：前进一分钟
      t.setMinutes(t.getMinutes() + 1)
      continue
    }

    return t
  }

  return null
}

// --- cronToHuman ------------------------------------------------------------
// 故意保持窄范围：覆盖常见模式，其他情况直接返回原始 cron 字符串。
// `utc` 选项为 CCR 远程触发（agents-platform.tsx）而设，
// 这些任务在服务器上运行，cron 字符串始终使用 UTC——
// 该路径将 UTC→本地时间进行显示转换，星期几情况还需要跨午夜逻辑。
// 本地调度任务（默认）无需上述处理。

const DAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
]

/**
 * 将本地时间的分钟和小时格式化为可读字符串。
 * 使用 1 月 1 日（2000-01-01）以避免夏令时间隙：
 * 若使用当日（new Date()），在每年唯一的春季拨钟日，凌晨 2 点会跳到 3 点。
 */
function formatLocalTime(minute: number, hour: number): string {
  // January 1 — no DST gap anywhere. Using `new Date()` (today) would roll
  // 2am→3am on the one spring-forward day per year.
  const d = new Date(2000, 0, 1, hour, minute)
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
}

/**
 * 将 UTC 时间的分钟和小时转换为用户本地时区的可读字符串（附带时区缩写）。
 * 用于 CCR 远程触发场景的显示。
 */
function formatUtcTimeAsLocal(minute: number, hour: number): string {
  // 在 UTC 中创建时间点，再以用户本地时区格式化
  const d = new Date()
  d.setUTCHours(hour, minute, 0, 0)
  return d.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  })
}

/**
 * 将 cron 表达式转换为人类可读的描述字符串。
 * 覆盖常见模式：每 N 分钟、每小时、每 N 小时、每天、指定星期、工作日。
 * 不匹配时直接返回原始 cron 字符串。
 *
 * @param cron - 标准 5 字段 cron 表达式
 * @param opts.utc - 为 true 时将 UTC 时间转换为本地时区显示（CCR 远程触发场景）
 */
export function cronToHuman(cron: string, opts?: { utc?: boolean }): string {
  const utc = opts?.utc ?? false
  const parts = cron.trim().split(/\s+/)
  if (parts.length !== 5) return cron

  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts as [
    string,
    string,
    string,
    string,
    string,
  ]

  // 每 N 分钟：*/N * * * *
  const everyMinMatch = minute.match(/^\*\/(\d+)$/)
  if (
    everyMinMatch &&
    hour === '*' &&
    dayOfMonth === '*' &&
    month === '*' &&
    dayOfWeek === '*'
  ) {
    const n = parseInt(everyMinMatch[1]!, 10)
    return n === 1 ? 'Every minute' : `Every ${n} minutes`
  }

  // 每小时（整点或指定分钟）：M * * * *
  if (
    minute.match(/^\d+$/) &&
    hour === '*' &&
    dayOfMonth === '*' &&
    month === '*' &&
    dayOfWeek === '*'
  ) {
    const m = parseInt(minute, 10)
    if (m === 0) return 'Every hour'
    return `Every hour at :${m.toString().padStart(2, '0')}`
  }

  // 每 N 小时：M */N * * *
  const everyHourMatch = hour.match(/^\*\/(\d+)$/)
  if (
    minute.match(/^\d+$/) &&
    everyHourMatch &&
    dayOfMonth === '*' &&
    month === '*' &&
    dayOfWeek === '*'
  ) {
    const n = parseInt(everyHourMatch[1]!, 10)
    const m = parseInt(minute, 10)
    const suffix = m === 0 ? '' : ` at :${m.toString().padStart(2, '0')}`
    return n === 1 ? `Every hour${suffix}` : `Every ${n} hours${suffix}`
  }

  // --- 以下情形需引用具体小时和分钟，按 utc 分支处理 ----------------

  // 分钟或小时含通配/步进时无法精确描述，直接返回原始字符串
  if (!minute.match(/^\d+$/) || !hour.match(/^\d+$/)) return cron
  const m = parseInt(minute, 10)
  const h = parseInt(hour, 10)
  // 根据 utc 标志选择时间格式化函数
  const fmtTime = utc ? formatUtcTimeAsLocal : formatLocalTime

  // 每天特定时刻：M H * * *
  if (dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    return `Every day at ${fmtTime(m, h)}`
  }

  // 每周特定星期几：M H * * D
  if (dayOfMonth === '*' && month === '*' && dayOfWeek.match(/^\d$/)) {
    const dayIndex = parseInt(dayOfWeek, 10) % 7 // 将 7（周日别名）归一化为 0
    let dayName: string | undefined
    if (utc) {
      // UTC 日期+时间可能因跨午夜而落在不同的本地星期几，
      // 通过构造 UTC 时刻计算实际的本地星期几。
      const ref = new Date()
      const daysToAdd = (dayIndex - ref.getUTCDay() + 7) % 7
      ref.setUTCDate(ref.getUTCDate() + daysToAdd)
      ref.setUTCHours(h, m, 0, 0)
      dayName = DAY_NAMES[ref.getDay()]
    } else {
      dayName = DAY_NAMES[dayIndex]
    }
    if (dayName) return `Every ${dayName} at ${fmtTime(m, h)}`
  }

  // 工作日（周一到周五）：M H * * 1-5
  if (dayOfMonth === '*' && month === '*' && dayOfWeek === '1-5') {
    return `Weekdays at ${fmtTime(m, h)}`
  }

  return cron
}
