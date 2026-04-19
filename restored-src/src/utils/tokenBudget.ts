/**
 * 【文件定位】输入处理层 — token 预算表达式解析与高亮定位
 *
 * 在 Claude Code 系统流程中的位置：
 *   用户在输入框中输入含 token 预算表达式的 Prompt（如 "+500k"、"use 2M tokens"）
 *     → thinking.ts 调用本模块 parseTokenBudget() 解析出预算数值
 *     → UI 层调用 findTokenBudgetPositions() 获取高亮区间，渲染彩色标注
 *     → LLM 输出被截断时，getBudgetContinuationMessage() 生成继续工作的提示语
 *
 * 主要职责：
 *   1. 正则表达式定义    — SHORTHAND_START_RE / SHORTHAND_END_RE / VERBOSE_RE
 *   2. parseTokenBudget()            — 从文本中解析出 token 预算数值（或 null）
 *   3. findTokenBudgetPositions()    — 返回所有匹配区间的 {start, end}[]，供 UI 高亮
 *   4. getBudgetContinuationMessage() — 格式化"已达 N% 预算"的继续工作提示
 *
 * 正则匹配策略：
 *   - SHORTHAND_START_RE：锚定行首，匹配 "+500k" / "+2.5m" 等行首简写形式
 *   - SHORTHAND_END_RE  ：锚定行尾，匹配行尾简写（用前导空格而非 lookbehind 避免 JIT 问题）
 *   - VERBOSE_RE        ：无位置限制，匹配 "use 2M tokens" / "spend 500k tokens"
 */

// 行首简写：+500k / +2.5M / +1b（锚定到行首，避免正文中误匹配）
const SHORTHAND_START_RE = /^\s*\+(\d+(?:\.\d+)?)\s*(k|m|b)\b/i
// 行尾简写：捕获前导空格而非使用 lookbehind（避免 YARR JIT 在 JavaScriptCore 中退化为 O(n) 扫描）
// 调用方在需要精确位置时需将 match.index +1（跳过前导空格）
const SHORTHAND_END_RE = /\s\+(\d+(?:\.\d+)?)\s*(k|m|b)\s*[.!?]?\s*$/i
// 完整写法：可出现在文本任意位置（使用 \b 单词边界避免误匹配）
const VERBOSE_RE = /\b(?:use|spend)\s+(\d+(?:\.\d+)?)\s*(k|m|b)\s*tokens?\b/i
// VERBOSE_RE 的全局版本，用于 matchAll 查找多个匹配
const VERBOSE_RE_G = new RegExp(VERBOSE_RE.source, 'gi')

// k/m/b 对应的数值倍数
const MULTIPLIERS: Record<string, number> = {
  k: 1_000,
  m: 1_000_000,
  b: 1_000_000_000,
}

/**
 * 将匹配结果中的数字和单位后缀转换为实际 token 数。
 *
 * @param value  数字部分（可能含小数，如 "2.5"）
 * @param suffix 单位后缀（'k' | 'm' | 'b'，不区分大小写）
 * @returns token 数（如 "2.5m" → 2_500_000）
 */
function parseBudgetMatch(value: string, suffix: string): number {
  return parseFloat(value) * MULTIPLIERS[suffix.toLowerCase()]!
}

/**
 * 从文本中解析 token 预算数值。
 *
 * 按优先级依次尝试三种正则：行首简写 → 行尾简写 → 完整写法。
 * 第一个匹配成功即返回，未匹配则返回 null。
 *
 * @param text 用户输入的文本
 * @returns 解析出的 token 数，或 null（未找到预算表达式）
 */
export function parseTokenBudget(text: string): number | null {
  const startMatch = text.match(SHORTHAND_START_RE)
  if (startMatch) return parseBudgetMatch(startMatch[1]!, startMatch[2]!)
  const endMatch = text.match(SHORTHAND_END_RE)
  if (endMatch) return parseBudgetMatch(endMatch[1]!, endMatch[2]!)
  const verboseMatch = text.match(VERBOSE_RE)
  if (verboseMatch) return parseBudgetMatch(verboseMatch[1]!, verboseMatch[2]!)
  return null
}

/**
 * 查找文本中所有 token 预算表达式的字符位置范围，供 UI 高亮渲染使用。
 *
 * 流程：
 *   1. 检查行首简写（SHORTHAND_START_RE），计算精确起止位置
 *   2. 检查行尾简写（SHORTHAND_END_RE），跳过前导空格（+1 偏移），
 *      并检查是否与行首结果重叠（避免 "+500k" 单独一行被计数两次）
 *   3. 使用 VERBOSE_RE_G 查找所有完整写法匹配
 *
 * @param text 用户输入的文本
 * @returns 每个 token 预算表达式的 {start, end} 位置数组（可见字符索引）
 */
export function findTokenBudgetPositions(
  text: string,
): Array<{ start: number; end: number }> {
  const positions: Array<{ start: number; end: number }> = []
  const startMatch = text.match(SHORTHAND_START_RE)
  if (startMatch) {
    // 去掉前导空白，得到实际高亮起始位置
    const offset =
      startMatch.index! +
      startMatch[0].length -
      startMatch[0].trimStart().length
    positions.push({
      start: offset,
      end: startMatch.index! + startMatch[0].length,
    })
  }
  const endMatch = text.match(SHORTHAND_END_RE)
  if (endMatch) {
    // Avoid double-counting when input is just "+500k"
    const endStart = endMatch.index! + 1 // +1: regex includes leading \s
    // 如果此区间已被行首匹配覆盖，则跳过（防止 "+500k" 被计数两次）
    const alreadyCovered = positions.some(
      p => endStart >= p.start && endStart < p.end,
    )
    if (!alreadyCovered) {
      positions.push({
        start: endStart,
        end: endMatch.index! + endMatch[0].length,
      })
    }
  }
  // 查找所有完整写法（"use 2M tokens" 等），可能有多处
  for (const match of text.matchAll(VERBOSE_RE_G)) {
    positions.push({ start: match.index, end: match.index + match[0].length })
  }
  return positions
}

/**
 * 生成"已达 N% token 预算"的继续工作提示消息。
 *
 * 当 LLM 响应达到 token 预算百分比阈值时，系统会插入此消息提醒模型继续工作，
 * 而非主动进行总结，保持任务的连续性。
 *
 * @param pct        已使用的预算百分比（0-100）
 * @param turnTokens 本轮实际消耗的 token 数
 * @param budget     本次任务设定的 token 预算总量
 * @returns 格式化后的提示字符串
 */
export function getBudgetContinuationMessage(
  pct: number,
  turnTokens: number,
  budget: number,
): string {
  // 使用 Intl.NumberFormat 将数字格式化为带千分位的字符串（如 1,500,000）
  const fmt = (n: number): string => new Intl.NumberFormat('en-US').format(n)
  return `Stopped at ${pct}% of token target (${fmt(turnTokens)} / ${fmt(budget)}). Keep working \u2014 do not summarize.`
}
