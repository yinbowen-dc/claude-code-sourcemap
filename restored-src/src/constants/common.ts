/**
 * 日期/时间工具函数
 *
 * 本文件提供与日期相关的辅助函数，主要服务于系统提示（system prompt）的生成。
 * 其中最关键的设计点是「会话级记忆」：getSessionStartDate 使用 memoize
 * 确保整个会话期间使用同一个日期，从而保持提示缓存（prompt cache）稳定，
 * 避免因跨天日期变化导致缓存失效和额外的 API 费用。
 *
 * 函数说明：
 * - getLocalISODate()     → 返回当前本地日期（ISO 格式 YYYY-MM-DD），支持测试覆盖
 * - getSessionStartDate() → getLocalISODate 的 memoize 版本，确保会话内日期不变
 * - getLocalMonthYear()   → 返回 "Month YYYY" 格式的月份，用于工具提示以减少缓存失效
 */
import memoize from 'lodash-es/memoize.js'

/**
 * 获取本地日期（ISO 格式 YYYY-MM-DD）。
 *
 * 工作流程：
 * 1. 检查 CLAUDE_CODE_OVERRIDE_DATE 环境变量（Anthropic 内部测试专用）
 * 2. 如存在覆盖值则直接返回，否则根据本地时区计算当前日期
 * 3. 手动拼接年月日，确保使用本地时区而非 UTC
 */
export function getLocalISODate(): string {
  // 检查是否设置了 ant 专用的日期覆盖（用于测试）
  if (process.env.CLAUDE_CODE_OVERRIDE_DATE) {
    return process.env.CLAUDE_CODE_OVERRIDE_DATE
  }

  const now = new Date()
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0') // 月份从 0 开始，需 +1
  const day = String(now.getDate()).padStart(2, '0')         // 补零确保两位数格式
  return `${year}-${month}-${day}`
}

/**
 * 获取会话开始时记录的本地日期（memoized，整个会话期间返回同一个值）。
 *
 * memoize 设计原因：
 * - 主交互路径：context.ts 中的 memoize(getUserContext) 已经实现了类似效果
 * - 简单模式（--bare）：每次请求都调用 getSystemPrompt，需要独立的 memoize
 *   确保午夜前后日期不变，否则会导致整个会话的提示缓存前缀失效
 * - 权衡取舍：午夜后日期可能过时，但这优于缓存全量失效带来的额外费用
 *   （getDateChangeAttachments 会在队尾追加新日期，但简单模式不支持 attachments）
 */
export const getSessionStartDate = memoize(getLocalISODate)

/**
 * 获取当前本地时区的 "Month YYYY" 格式字符串（例如 "February 2026"）。
 *
 * 与 getLocalISODate 不同，此函数按月变化而非按天变化，
 * 用于工具提示（tool prompts）中以最小化缓存失效频率。
 * 同样支持 CLAUDE_CODE_OVERRIDE_DATE 覆盖以便测试。
 */
export function getLocalMonthYear(): string {
  // 如果设置了日期覆盖，从覆盖值解析月份；否则使用当前时间
  const date = process.env.CLAUDE_CODE_OVERRIDE_DATE
    ? new Date(process.env.CLAUDE_CODE_OVERRIDE_DATE)
    : new Date()
  // 使用 en-US locale 格式化为 "Month YYYY"，确保输出语言一致
  return date.toLocaleString('en-US', { month: 'long', year: 'numeric' })
}
