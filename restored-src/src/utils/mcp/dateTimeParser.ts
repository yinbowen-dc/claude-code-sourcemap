/**
 * dateTimeParser.ts — MCP 自然语言日期时间解析模块
 *
 * 【系统流程定位】
 * 本模块处于 MCP（Model Context Protocol）表单验证层的辅助解析路径上。
 * 当 MCP Elicitation（用户数据采集）表单中存在 date / date-time 格式字段时，
 * 如果用户输入的是自然语言（如 "明天下午三点"），Zod 直接校验会失败。
 * 本模块在同步校验失败后作为异步回退路径，将自然语言转换为 ISO 8601 格式，
 * 再交还给 elicitationValidation.ts 进行二次校验。
 *
 * 【主要职责】
 * 1. parseNaturalLanguageDateTime：将用户输入的自然语言日期/时间调用
 *    Haiku 模型解析为 ISO 8601 格式字符串（带时区感知）；
 * 2. looksLikeISO8601：正则预检，避免对已经是 ISO 8601 格式的输入发起不必要的 API 调用；
 * 3. 通过 AbortSignal 支持表单关闭时的取消操作，防止孤悬 API 请求。
 *
 * 【典型调用链】
 * validateElicitationInputAsync() → Zod校验失败 → !looksLikeISO8601() →
 *   parseNaturalLanguageDateTime() → queryHaiku() → ISO 8601字符串 →
 *   再次Zod校验 → ValidationResult
 */

import { queryHaiku } from '../../services/api/claude.js'
import { logError } from '../log.js'
import { extractTextContent } from '../messages.js'
import { asSystemPrompt } from '../systemPromptType.js'

/**
 * 日期/时间解析结果类型。
 *
 * 成功时携带 ISO 8601 格式的字符串值；
 * 失败时携带用户可读的错误提示，建议用户手动输入标准格式。
 */
export type DateTimeParseResult =
  | { success: true; value: string }
  | { success: false; error: string }

/**
 * 将自然语言日期/时间输入解析为 ISO 8601 格式，内部通过 Haiku 模型完成解析。
 *
 * 【解析流程】
 * 1. 采集当前时间信息：UTC ISO 字符串、本地时区偏移、星期几；
 * 2. 构建系统提示词（systemPrompt），明确要求模型只返回 ISO 8601 或 "INVALID"；
 * 3. 构建用户提示词（userPrompt），将时间上下文和用户输入一起传给模型，
 *    同时指明所需的输出格式（date 仅日期 / date-time 含时区全格式）；
 * 4. 调用 queryHaiku 发送请求，通过 signal 支持取消；
 * 5. 提取文本内容后进行基础校验：
 *    - 空串或 "INVALID" → 解析失败；
 *    - 不以四位数字年份开头 → 解析失败；
 *    - 通过以上校验 → 返回成功结果。
 *
 * 示例：
 * - "tomorrow at 3pm" → "2025-10-15T15:00:00-07:00"
 * - "next Monday"     → "2025-10-20"
 * - "in 2 hours"      → "2025-10-14T12:30:00-07:00"
 *
 * @param input  用户输入的自然语言日期/时间字符串
 * @param format 解析目标格式：'date'（YYYY-MM-DD）或 'date-time'（完整 ISO 8601 含时区）
 * @param signal 用于取消请求的 AbortSignal（表单关闭时由调用方触发）
 * @returns      解析成功时返回 ISO 8601 字符串，失败时返回错误消息
 */
export async function parseNaturalLanguageDateTime(
  input: string,
  format: 'date' | 'date-time',
  signal: AbortSignal,
): Promise<DateTimeParseResult> {
  // 获取当前时刻的完整时间信息，作为 Haiku 解析的上下文依据
  const now = new Date()
  const currentDateTime = now.toISOString()
  // getTimezoneOffset() 返回"本地 - UTC"分钟数，正西负东；取反得到 UTC 偏移
  const timezoneOffset = -now.getTimezoneOffset() // 分钟数，符号已翻转
  const tzHours = Math.floor(Math.abs(timezoneOffset) / 60)
  const tzMinutes = Math.abs(timezoneOffset) % 60
  const tzSign = timezoneOffset >= 0 ? '+' : '-'
  // 格式化为 ±HH:MM 形式的时区偏移字符串（用于 date-time 格式输出示例）
  const timezone = `${tzSign}${String(tzHours).padStart(2, '0')}:${String(tzMinutes).padStart(2, '0')}`
  const dayOfWeek = now.toLocaleDateString('en-US', { weekday: 'long' })

  // 构建系统提示词：限制模型只输出 ISO 8601 或 "INVALID"，禁止任何解释文字
  const systemPrompt = asSystemPrompt([
    'You are a date/time parser that converts natural language into ISO 8601 format.',
    'You MUST respond with ONLY the ISO 8601 formatted string, with no explanation or additional text.',
    'If the input is ambiguous, prefer future dates over past dates.',
    "For times without dates, use today's date.",
    'For dates without times, do not include a time component.',
    'If the input is incomplete or you cannot confidently parse it into a valid date, respond with exactly "INVALID" (nothing else).',
    'Examples of INVALID input: partial dates like "2025-01-", lone numbers like "13", gibberish.',
    'Examples of valid natural language: "tomorrow", "next Monday", "jan 1st 2025", "in 2 hours", "yesterday".',
  ])

  // 根据 format 参数构建输出格式描述字符串，用于提示模型返回正确格式
  const formatDescription =
    format === 'date'
      ? 'YYYY-MM-DD (date only, no time)'
      : `YYYY-MM-DDTHH:MM:SS${timezone} (full date-time with timezone)`

  // 构建用户提示词：提供当前日期时间上下文 + 用户输入 + 期望的输出格式
  const userPrompt = `Current context:
- Current date and time: ${currentDateTime} (UTC)
- Local timezone: ${timezone}
- Day of week: ${dayOfWeek}

User input: "${input}"

Output format: ${formatDescription}

Parse the user's input into ISO 8601 format. Return ONLY the formatted string, or "INVALID" if the input is incomplete or unparseable.`

  try {
    // 调用 Haiku 模型（轻量快速，适合简单解析任务），通过 signal 支持取消
    const result = await queryHaiku({
      systemPrompt,
      userPrompt,
      signal,
      options: {
        querySource: 'mcp_datetime_parse',
        agents: [],
        isNonInteractiveSession: false,
        hasAppendSystemPrompt: false,
        mcpTools: [],
        enablePromptCaching: false,
      },
    })

    // 从模型响应中提取纯文本内容并去除首尾空白
    const parsedText = extractTextContent(result.message.content).trim()

    // 模型返回空串或明确 "INVALID"：说明输入无法解析
    if (!parsedText || parsedText === 'INVALID') {
      return {
        success: false,
        error: 'Unable to parse date/time from input',
      }
    }

    // 基础合理性校验：ISO 8601 必须以四位年份数字开头（如 "2025"）
    // 若模型仍返回了非预期格式，此处作为兜底拦截
    if (!/^\d{4}/.test(parsedText)) {
      return {
        success: false,
        error: 'Unable to parse date/time from input',
      }
    }

    // 通过所有校验，返回解析成功结果
    return { success: true, value: parsedText }
  } catch (error) {
    // 仅记录内部错误日志，不将技术细节暴露给用户
    logError(error)
    return {
      success: false,
      // 提示用户改为手动输入标准 ISO 8601 格式，降级到可靠路径
      error:
        'Unable to parse date/time. Please enter in ISO 8601 format manually.',
    }
  }
}

/**
 * 检查字符串是否看起来像 ISO 8601 日期/时间格式。
 *
 * 用途：在调用 Haiku 之前做前置判断——如果用户输入本身已经是 ISO 8601 格式
 * （同步 Zod 校验已通过或失败于其他约束），则无需再发起一次 API 调用。
 *
 * 匹配规则：以四位年份 + 月 + 日开头，后接 "T"（日期时间分隔符）或字符串结束。
 * 匹配示例：
 * - "2024-03-15"           → true（纯日期）
 * - "2024-03-15T14:30:00Z" → true（完整日期时间）
 * - "tomorrow at 3pm"      → false（自然语言）
 * - "March 15"             → false（非标准格式）
 *
 * @param input 待检查的字符串（会去除首尾空白后测试）
 * @returns 若符合 ISO 8601 日期前缀格式则返回 true
 */
export function looksLikeISO8601(input: string): boolean {
  // 正则匹配 YYYY-MM-DD 或 YYYY-MM-DDTHH:... 格式的前缀
  // (T|$) 确保纯日期格式（末尾无 T）也能正确匹配
  return /^\d{4}-\d{2}-\d{2}(T|$)/.test(input.trim())
}
