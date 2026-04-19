/**
 * 后台 bash 通知折叠模块。
 *
 * 在 Claude Code 系统中，当多个后台 bash 任务连续完成时，该模块将这些通知
 * 合并为单条"N 个后台命令已完成"消息，避免界面被大量通知刷屏：
 * - collapseBackgroundBashNotifications()：折叠连续的 completed 状态后台 bash 通知，
 *   verbose 模式和非全屏模式下直接透传，失败/中止的任务及 agent 通知不受影响
 */
import {
  STATUS_TAG,
  SUMMARY_TAG,
  TASK_NOTIFICATION_TAG,
} from '../constants/xml.js'
import { BACKGROUND_BASH_SUMMARY_PREFIX } from '../tasks/LocalShellTask/LocalShellTask.js'
import type {
  NormalizedUserMessage,
  RenderableMessage,
} from '../types/message.js'
import { isFullscreenEnvEnabled } from './fullscreen.js'
import { extractTag } from './messages.js'

/**
 * 判断消息是否为已成功完成的后台 bash 任务通知。
 * 仅匹配 type='user'、含 TASK_NOTIFICATION_TAG、status='completed'
 * 且摘要以 BACKGROUND_BASH_SUMMARY_PREFIX 开头的消息，
 * 确保失败/中止任务和 agent/monitor 类型通知不被误判为可折叠对象。
 */
function isCompletedBackgroundBash(
  msg: RenderableMessage,
): msg is NormalizedUserMessage {
  if (msg.type !== 'user') return false
  const content = msg.message.content[0]
  if (content?.type !== 'text') return false
  if (!content.text.includes(`<${TASK_NOTIFICATION_TAG}`)) return false
  // 只折叠成功完成（completed）的通知；失败/被杀死的任务保持单独可见
  if (extractTag(content.text, STATUS_TAG) !== 'completed') return false
  // BACKGROUND_BASH_SUMMARY_PREFIX 前缀区分 bash 类型与 agent/workflow/monitor 类型；
  // monitor 类型的完成摘要有独立文案，不在此处折叠
  return (
    extractTag(content.text, SUMMARY_TAG)?.startsWith(
      BACKGROUND_BASH_SUMMARY_PREFIX,
    ) ?? false
  )
}

/**
 * 将连续的已完成后台 bash 任务通知折叠为单条汇总消息。
 * 失败/中止的任务和 agent/workflow 通知保持原样不受影响。
 * monitor 流事件（enqueueStreamEvent）没有 <status> 标签，永远不会命中此逻辑。
 *
 * 在 verbose 模式（ctrl+O）和非全屏模式下直接透传，让用户看到每条完成通知。
 */
export function collapseBackgroundBashNotifications(
  messages: RenderableMessage[],
  verbose: boolean,
): RenderableMessage[] {
  // 非全屏模式下不折叠，保持原始消息列表
  if (!isFullscreenEnvEnabled()) return messages
  // verbose 模式下用户希望看到所有通知，跳过折叠
  if (verbose) return messages

  const result: RenderableMessage[] = []
  let i = 0

  while (i < messages.length) {
    const msg = messages[i]!
    if (isCompletedBackgroundBash(msg)) {
      // 统计连续的已完成后台 bash 通知数量
      let count = 0
      while (i < messages.length && isCompletedBackgroundBash(messages[i]!)) {
        count++
        i++
      }
      if (count === 1) {
        // 只有一条时无需合并，直接保留
        result.push(msg)
      } else {
        // 多条时合成一条 XML task-notification 消息，
        // UserAgentNotificationMessage 已知如何渲染此格式，无需新增渲染器
        result.push({
          ...msg,
          message: {
            role: 'user',
            content: [
              {
                type: 'text',
                text: `<${TASK_NOTIFICATION_TAG}><${STATUS_TAG}>completed</${STATUS_TAG}><${SUMMARY_TAG}>${count} background commands completed</${SUMMARY_TAG}></${TASK_NOTIFICATION_TAG}>`,
              },
            ],
          },
        })
      }
    } else {
      // 非后台 bash 通知直接透传
      result.push(msg)
      i++
    }
  }

  return result
}
