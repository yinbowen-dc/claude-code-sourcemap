/**
 * Hook 摘要消息折叠模块。
 *
 * 在 Claude Code 系统中，并行工具调用时每个调用均会触发 PostToolUse 等 hook，
 * 该模块将相同 hookLabel 的连续 stop_hook_summary 消息合并为单条摘要，
 * 避免界面出现重复的 hook 摘要：
 * - collapseHookSummaries()：合并同标签的连续 hook 摘要，聚合 hookCount、
 *   hookInfos、hookErrors、preventedContinuation、hasOutput 及最大 totalDurationMs
 */
import type {
  RenderableMessage,
  SystemStopHookSummaryMessage,
} from '../types/message.js'

/**
 * 判断消息是否为带标签的 hook 摘要消息。
 * 需同时满足：类型为 system、子类型为 stop_hook_summary、且 hookLabel 已定义。
 */
function isLabeledHookSummary(
  msg: RenderableMessage,
): msg is SystemStopHookSummaryMessage {
  return (
    msg.type === 'system' &&
    msg.subtype === 'stop_hook_summary' &&
    msg.hookLabel !== undefined
  )
}

/**
 * 将相同 hookLabel（如 PostToolUse）的连续 hook 摘要消息合并为单条。
 * 并行工具调用时每个调用各自触发 hook，会产生多条相邻的同标签摘要，
 * 合并规则：累加 hookCount 和 hookInfos/hookErrors，OR 合并布尔字段，
 * 取 totalDurationMs 的最大值（因并行 hook 时间重叠，最大值最接近挂钟耗时）。
 */
export function collapseHookSummaries(
  messages: RenderableMessage[],
): RenderableMessage[] {
  const result: RenderableMessage[] = []
  let i = 0

  while (i < messages.length) {
    const msg = messages[i]!
    if (isLabeledHookSummary(msg)) {
      const label = msg.hookLabel
      // 收集所有连续且标签相同的 hook 摘要消息
      const group: SystemStopHookSummaryMessage[] = []
      while (i < messages.length) {
        const next = messages[i]!
        // 标签不同或不是 hook 摘要时停止收集
        if (!isLabeledHookSummary(next) || next.hookLabel !== label) break
        group.push(next)
        i++
      }
      if (group.length === 1) {
        // 只有一条时无需合并
        result.push(msg)
      } else {
        // 多条时合并为单条聚合摘要
        result.push({
          ...msg,
          hookCount: group.reduce((sum, m) => sum + m.hookCount, 0),
          hookInfos: group.flatMap(m => m.hookInfos),
          hookErrors: group.flatMap(m => m.hookErrors),
          // 任一 hook 阻止继续时整体标记为 preventedContinuation
          preventedContinuation: group.some(m => m.preventedContinuation),
          // 任一 hook 有输出时整体标记为 hasOutput
          hasOutput: group.some(m => m.hasOutput),
          // 并行调用的 hook 时间段重叠，取最大值近似为真实挂钟耗时
          totalDurationMs: Math.max(...group.map(m => m.totalDurationMs ?? 0)),
        })
      }
    } else {
      // 非 hook 摘要消息直接透传
      result.push(msg)
      i++
    }
  }

  return result
}
