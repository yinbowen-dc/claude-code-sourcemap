/**
 * nullRenderingAttachments.ts
 *
 * 在 Claude Code 系统流程中的位置：
 * 该模块是消息渲染管线的"前置过滤层"，专门用于在 Messages.tsx 对消息列表
 * 进行渲染上限（200 条）计数之前，识别并过滤掉那些最终会渲染为 null 的
 * attachment 消息，从而防止它们占用渲染预算（CC-724）。
 *
 * 主要功能：
 * - 定义 NULL_RENDERING_TYPES 常量数组，枚举所有渲染结果为 null 的 attachment 类型
 * - 导出 NullRenderingAttachmentType 联合类型，供 TypeScript 类型系统强制同步
 * - 导出 isNullRenderingAttachment(msg) 函数，供 Messages.tsx 在计数前过滤不可见消息
 *
 * 类型同步机制：
 * AttachmentMessage 的 switch default 分支通过 `satisfies NullRenderingAttachmentType`
 * 断言来确保：每当新增一种始终渲染为 null 的 Attachment 类型时，开发者必须
 * 同步在此文件的 NULL_RENDERING_TYPES 中添加对应条目，否则编译将失败。
 */
import type { Attachment } from 'src/utils/attachments.js'
import type { Message, NormalizedMessage } from '../../types/message.js'

/**
 * 所有渲染结果为 null 的 attachment 类型列表
 *
 * 这些类型在 AttachmentMessage 中的 switch 语句里没有可见的 case 分支，
 * 最终输出为 null（无 UI 元素）。Messages.tsx 在渲染上限计数之前
 * 将这些消息过滤掉，使不可见条目不消耗 200 条的渲染预算（CC-724）。
 *
 * 类型强制同步：AttachmentMessage 的 switch `default:` 分支
 * 使用 `attachment.type satisfies NullRenderingAttachmentType` 断言。
 * 若新增一种 Attachment 类型但既未提供 case 也未加入此列表，则类型检查失败。
 */
const NULL_RENDERING_TYPES = [
  'hook_success',               // hook 执行成功（无需显示）
  'hook_additional_context',    // hook 附加上下文（无需显示）
  'hook_cancelled',             // hook 被取消（无需显示）
  'command_permissions',        // 命令权限信息（无需显示）
  'agent_mention',              // 智能体提及（无需显示）
  'budget_usd',                 // 美元预算信息（无需显示）
  'critical_system_reminder',   // 关键系统提醒（无需显示）
  'edited_image_file',          // 已编辑图像文件（无需显示）
  'edited_text_file',           // 已编辑文本文件（无需显示）
  'opened_file_in_ide',         // 在 IDE 中打开的文件（无需显示）
  'output_style',               // 输出样式配置（无需显示）
  'plan_mode',                  // 计划模式（无需显示）
  'plan_mode_exit',             // 退出计划模式（无需显示）
  'plan_mode_reentry',          // 重新进入计划模式（无需显示）
  'structured_output',          // 结构化输出（无需显示）
  'team_context',               // 团队上下文（无需显示）
  'todo_reminder',              // 待办提醒（无需显示）
  'context_efficiency',         // 上下文效率（无需显示）
  'deferred_tools_delta',       // 延迟工具差量（无需显示）
  'mcp_instructions_delta',     // MCP 指令差量（无需显示）
  'companion_intro',            // 伴随介绍（无需显示）
  'token_usage',                // token 使用量（无需显示）
  'ultrathink_effort',          // 超级思考力度（无需显示）
  'max_turns_reached',          // 已达最大轮次（无需显示）
  'task_reminder',              // 任务提醒（无需显示）
  'auto_mode',                  // 自动模式（无需显示）
  'auto_mode_exit',             // 退出自动模式（无需显示）
  'output_token_usage',         // 输出 token 使用量（无需显示）
  'pen_mode_enter',             // 进入笔模式（无需显示）
  'pen_mode_exit',              // 退出笔模式（无需显示）
  'verify_plan_reminder',       // 验证计划提醒（无需显示）
  'current_session_memory',     // 当前会话记忆（无需显示）
  'compaction_reminder',        // 压缩提醒（无需显示）
  'date_change',                // 日期变更（无需显示）
] as const satisfies readonly Attachment['type'][]

// 导出联合类型，供 AttachmentMessage 的 switch default 分支做 satisfies 断言
export type NullRenderingAttachmentType = (typeof NULL_RENDERING_TYPES)[number]

// 将数组转换为 Set，供 isNullRenderingAttachment 做 O(1) 查找
const NULL_RENDERING_ATTACHMENT_TYPES: ReadonlySet<Attachment['type']> =
  new Set(NULL_RENDERING_TYPES)

/**
 * isNullRenderingAttachment
 *
 * 流程说明：
 * 1. 判断消息类型是否为 'attachment'（排除非附件消息）
 * 2. 在 NULL_RENDERING_ATTACHMENT_TYPES 集合中查找该附件的 type
 * 3. 返回布尔值；返回 true 表示该消息无可见输出，可在计数前安全过滤
 *
 * 在系统流程中的角色：
 * 由 Messages.tsx 在渲染上限计数（200 条预算）之前调用，
 * 过滤掉不可见的 hook 附件（hook_success、hook_additional_context、hook_cancelled 等），
 * 防止它们虚增"N 条消息"计数或占用渲染预算（CC-724）。
 */
export function isNullRenderingAttachment(
  msg: Message | NormalizedMessage,
): boolean {
  // 首先确认消息类型为 attachment，再查询其 attachment.type 是否在集合中
  return (
    msg.type === 'attachment' &&
    NULL_RENDERING_ATTACHMENT_TYPES.has(msg.attachment.type)
  )
}
