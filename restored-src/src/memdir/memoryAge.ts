/**
 * @file memoryAge.ts
 * @description 记忆目录模块 — 记忆新鲜度计算工具
 *
 * 在 Claude Code 记忆系统中，该文件提供一组用于衡量记忆文件"陈旧程度"的工具函数。
 * 背景：模型对原始 ISO 时间戳的时效性判断较弱，但对"47 天前"这样的相对描述
 * 能更好地触发"该记忆可能已过时"的推理。
 *
 * 提供三个层次的新鲜度表达：
 * 1. memoryAgeDays  — 返回数值（天数），供逻辑判断
 * 2. memoryAge      — 返回人类可读字符串（"today"/"yesterday"/"N days ago"）
 * 3. memoryFreshnessText / memoryFreshnessNote — 返回针对过时记忆的警告文本，
 *    供注入消息上下文或文件读取工具输出
 *
 * 调用方：messages.ts（相关记忆注入）、FileReadTool 输出、记忆内容展示层。
 */

/**
 * 计算从记忆文件 mtime 到当前时间经过的完整天数（向下取整）。
 *
 * - 今天修改：返回 0
 * - 昨天修改：返回 1
 * - 更早修改：返回对应天数
 * - 未来时间（时钟漂移/时区问题）：返回 0（下限钳制）
 *
 * @param mtimeMs 文件最后修改时间（毫秒时间戳）
 * @returns       已过天数（非负整数）
 */
export function memoryAgeDays(mtimeMs: number): number {
  // 86_400_000 毫秒 = 1 天；Math.floor 确保当天修改始终返回 0
  return Math.max(0, Math.floor((Date.now() - mtimeMs) / 86_400_000))
}

/**
 * 将记忆文件的修改时间转换为人类可读的相对时间字符串。
 *
 * 模型对原始 ISO 时间戳的时效性推理较弱，
 * "47 days ago"这样的描述能更有效地触发过时检查逻辑。
 *
 * @param mtimeMs 文件最后修改时间（毫秒时间戳）
 * @returns       "today" | "yesterday" | "N days ago"
 */
export function memoryAge(mtimeMs: number): string {
  const d = memoryAgeDays(mtimeMs)
  if (d === 0) return 'today'      // 今天修改的记忆，无需特别提示
  if (d === 1) return 'yesterday'  // 昨天修改，友好显示
  return `${d} days ago`           // 更早的记忆，明确标出天数
}

/**
 * 为超过 1 天的记忆生成纯文本陈旧警告，新鲜记忆（今天/昨天）返回空字符串。
 *
 * 用途：供调用方已有包装层的场景（如 messages.ts 的 relevant_memories
 * → wrapMessagesInSystemReminder），避免双重包装。
 *
 * 引入原因：用户报告过时的"代码状态"类记忆（含 file:line 引用）被模型当作
 * 当前事实断言——引用使过时的声明看起来更权威，而非更可疑。
 *
 * @param mtimeMs 文件最后修改时间（毫秒时间戳）
 * @returns       陈旧警告文本，或空字符串（记忆新鲜时）
 */
export function memoryFreshnessText(mtimeMs: number): string {
  const d = memoryAgeDays(mtimeMs)
  if (d <= 1) return '' // 今天或昨天的记忆不加噪音警告
  return (
    `This memory is ${d} days old. ` +
    `Memories are point-in-time observations, not live state — ` +
    `claims about code behavior or file:line citations may be outdated. ` +
    `Verify against current code before asserting as fact.`
  )
}

/**
 * 将陈旧警告文本包装在 <system-reminder> 标签中，返回完整的提醒节点字符串。
 * 新鲜记忆（≤1 天）返回空字符串。
 *
 * 适用于调用方不自带 system-reminder 包装层的场景（如 FileReadTool 输出），
 * 直接在文件内容前追加此字符串即可注入陈旧提醒。
 *
 * @param mtimeMs 文件最后修改时间（毫秒时间戳）
 * @returns       带 <system-reminder> 包装的陈旧警告字符串，或空字符串
 */
export function memoryFreshnessNote(mtimeMs: number): string {
  const text = memoryFreshnessText(mtimeMs)
  if (!text) return '' // 新鲜记忆不添加任何提醒
  // 在 system-reminder 标签后添加换行，确保与后续内容之间有分隔
  return `<system-reminder>${text}</system-reminder>\n`
}
