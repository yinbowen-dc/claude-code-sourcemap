/**
 * Teammate 关闭通知折叠模块。
 *
 * 在 Claude Code 系统中，当多个进程内 teammate 实例连续关闭时，
 * 该模块将这些 task_status 附件合并为单条 teammate_shutdown_batch 附件，
 * 以携带关闭数量而非显示多条独立通知：
 * - collapseTeammateShutdowns()：折叠连续的 in_process_teammate completed 附件
 */
import type { AttachmentMessage, RenderableMessage } from '../types/message.js'

/**
 * 判断消息是否为进程内 teammate 关闭通知附件。
 * 须同时满足：attachment 类型为 task_status、taskType 为 in_process_teammate、
 * 且 status 为 completed（其他状态如 running/failed 不在折叠范围内）。
 */
function isTeammateShutdownAttachment(
  msg: RenderableMessage,
): msg is AttachmentMessage {
  return (
    msg.type === 'attachment' &&
    msg.attachment.type === 'task_status' &&
    msg.attachment.taskType === 'in_process_teammate' &&
    msg.attachment.status === 'completed'
  )
}

/**
 * 将连续的进程内 teammate 关闭通知折叠为单条批量通知。
 * 多个 teammate 依次关闭时会产生若干相邻的 task_status 附件，
 * 合并后替换为 teammate_shutdown_batch 类型附件，携带关闭数量 count，
 * 供渲染层显示"N 个 teammate 已关闭"而非逐条展示。
 */
export function collapseTeammateShutdowns(
  messages: RenderableMessage[],
): RenderableMessage[] {
  const result: RenderableMessage[] = []
  let i = 0

  while (i < messages.length) {
    const msg = messages[i]!
    if (isTeammateShutdownAttachment(msg)) {
      // 统计连续的 teammate 关闭通知数量
      let count = 0
      while (
        i < messages.length &&
        isTeammateShutdownAttachment(messages[i]!)
      ) {
        count++
        i++
      }
      if (count === 1) {
        // 只有一条时无需折叠，直接保留原附件
        result.push(msg)
      } else {
        // 多条时合成 teammate_shutdown_batch 批量附件，继承首条消息的 uuid 和 timestamp
        result.push({
          type: 'attachment',
          uuid: msg.uuid,
          timestamp: msg.timestamp,
          attachment: {
            type: 'teammate_shutdown_batch',
            count,
          },
        })
      }
    } else {
      // 非 teammate 关闭通知直接透传
      result.push(msg)
      i++
    }
  }

  return result
}
