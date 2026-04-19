/**
 * 消息映射器模块 — Claude Code 系统流程中的消息格式转换层
 *
 * 本文件位于消息处理管道的核心位置，负责在以下三种消息格式之间进行双向转换：
 *   1. 内部消息格式 (Message / AssistantMessage)  — 系统内部使用
 *   2. SDK 消息格式 (SDKMessage / SDKAssistantMessage) — 对外暴露给 SDK 消费者
 *   3. 对话压缩元数据 (CompactMetadata / SDKCompactMetadata) — 会话压缩边界标记
 *
 * 在整个系统流程中，本模块的作用链路如下：
 *   QueryEngine / useReplBridge
 *     → 产生内部 Message[]
 *     → mappers.ts (toSDKMessages) → SDK 消费者（移动端、远程 REPL 等）
 *   SDK 消费者发来的 SDKMessage[]
 *     → mappers.ts (toInternalMessages) → 内部存储与渲染
 *
 * 主要导出函数：
 *   - toInternalMessages      : SDK 消息 → 内部消息
 *   - toSDKMessages           : 内部消息 → SDK 消息
 *   - toSDKCompactMetadata    : 内部压缩元数据 → SDK 格式
 *   - fromSDKCompactMetadata  : SDK 压缩元数据 → 内部格式
 *   - localCommandOutputToSDKAssistantMessage : 本地命令输出 → SDK 助手消息
 *   - toSDKRateLimitInfo      : 内部限速信息 → SDK 限速信息
 */

import type { BetaContentBlock } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import { randomUUID, type UUID } from 'crypto'
import { getSessionId } from 'src/bootstrap/state.js'
import {
  LOCAL_COMMAND_STDERR_TAG,
  LOCAL_COMMAND_STDOUT_TAG,
} from 'src/constants/xml.js'
import type {
  SDKAssistantMessage,
  SDKCompactBoundaryMessage,
  SDKMessage,
  SDKRateLimitInfo,
} from 'src/entrypoints/agentSdkTypes.js'
import type { ClaudeAILimits } from 'src/services/claudeAiLimits.js'
import { EXIT_PLAN_MODE_V2_TOOL_NAME } from 'src/tools/ExitPlanModeTool/constants.js'
import type {
  AssistantMessage,
  CompactMetadata,
  Message,
} from 'src/types/message.js'
import type { DeepImmutable } from 'src/types/utils.js'
import stripAnsi from 'strip-ansi'
import { createAssistantMessage } from '../messages.js'
import { getPlan } from '../plans.js'

/**
 * 将 SDK 消息数组转换为系统内部消息格式。
 *
 * 流程：
 *   - 遍历每条 SDKMessage，按 type 分支处理：
 *     · 'assistant' → 补充 requestId / timestamp，生成内部 AssistantMessage
 *     · 'user'      → 补充 uuid（若缺失）/ timestamp / isMeta 字段
 *     · 'system'    → 仅处理 compact_boundary 子类型，其余系统消息直接丢弃
 *   - 使用 flatMap 将每条消息映射为 0 或 1 个内部消息
 *
 * @param messages 只读的 SDK 消息数组（深度不可变）
 * @returns 内部 Message 数组
 */
export function toInternalMessages(
  messages: readonly DeepImmutable<SDKMessage>[],
): Message[] {
  return messages.flatMap(message => {
    switch (message.type) {
      case 'assistant':
        // 将 SDK 助手消息结构直接映射到内部格式，requestId 在此阶段未知故置 undefined
        return [
          {
            type: 'assistant',
            message: message.message,
            uuid: message.uuid,
            requestId: undefined,
            timestamp: new Date().toISOString(),
          } as Message,
        ]
      case 'user':
        // 若 SDK 消息缺少 uuid 则生成随机 UUID；isMeta 对应 SDK 的 isSynthetic 字段
        return [
          {
            type: 'user',
            message: message.message,
            uuid: message.uuid ?? randomUUID(),
            timestamp: message.timestamp ?? new Date().toISOString(),
            isMeta: message.isSynthetic,
          } as Message,
        ]
      case 'system':
        // 处理对话压缩边界消息
        if (message.subtype === 'compact_boundary') {
          const compactMsg = message
          return [
            {
              type: 'system',
              content: 'Conversation compacted',
              level: 'info',
              subtype: 'compact_boundary',
              // 将 SDK 格式的压缩元数据转换为内部格式
              compactMetadata: fromSDKCompactMetadata(
                compactMsg.compact_metadata,
              ),
              uuid: message.uuid,
              timestamp: new Date().toISOString(),
            },
          ]
        }
        // 其他系统消息（如 init）不需要转入内部，直接返回空数组
        return []
      default:
        return []
    }
  })
}

// SDK CompactBoundaryMessage 中 compact_metadata 字段的类型别名，方便后续引用
type SDKCompactMetadata = SDKCompactBoundaryMessage['compact_metadata']

/**
 * 将内部压缩元数据（CompactMetadata）转换为 SDK 对外格式（SDKCompactMetadata）。
 *
 * 字段映射关系：
 *   内部字段            →  SDK 字段
 *   trigger             →  trigger
 *   preTokens           →  pre_tokens
 *   preservedSegment    →  preserved_segment（snake_case 嵌套对象）
 *
 * @param meta 内部格式的压缩元数据
 * @returns SDK 格式的压缩元数据
 */
export function toSDKCompactMetadata(
  meta: CompactMetadata,
): SDKCompactMetadata {
  const seg = meta.preservedSegment
  return {
    trigger: meta.trigger,
    pre_tokens: meta.preTokens,
    // 仅当 preservedSegment 存在时才展开，避免写入 undefined 字段
    ...(seg && {
      preserved_segment: {
        head_uuid: seg.headUuid,
        anchor_uuid: seg.anchorUuid,
        tail_uuid: seg.tailUuid,
      },
    }),
  }
}

/**
 * SDK → 内部格式的压缩元数据转换器（与 toSDKCompactMetadata 互为逆操作）。
 *
 * 字段映射关系（与上方函数相反）：
 *   SDK 字段                →  内部字段
 *   trigger                 →  trigger
 *   pre_tokens              →  preTokens
 *   preserved_segment       →  preservedSegment（camelCase 嵌套对象）
 */
export function fromSDKCompactMetadata(
  meta: SDKCompactMetadata,
): CompactMetadata {
  const seg = meta.preserved_segment
  return {
    trigger: meta.trigger,
    preTokens: meta.pre_tokens,
    // 仅当 preserved_segment 存在时才展开
    ...(seg && {
      preservedSegment: {
        headUuid: seg.head_uuid,
        anchorUuid: seg.anchor_uuid,
        tailUuid: seg.tail_uuid,
      },
    }),
  }
}

/**
 * 将内部消息数组转换为 SDK 消息格式，供远程客户端（移动端 App、Web UI 等）消费。
 *
 * 流程：
 *   - 'assistant' 消息：调用 normalizeAssistantMessageForSDK 注入 ExitPlanModeV2 的 plan 内容
 *   - 'user' 消息：附加 isSynthetic / toolUseResult 等扩展字段
 *   - 'system' 消息：
 *     · compact_boundary 子类型 → 生成 SDKCompactBoundaryMessage
 *     · local_command 子类型（含 stdout/stderr 标签）→ 转为 SDKAssistantMessage
 *     · 其他系统消息 → 丢弃（不下发给 SDK）
 *
 * @param messages 内部消息数组
 * @returns SDK 消息数组
 */
export function toSDKMessages(messages: Message[]): SDKMessage[] {
  return messages.flatMap((message): SDKMessage[] => {
    switch (message.type) {
      case 'assistant':
        return [
          {
            type: 'assistant',
            // 对助手消息内容进行规范化处理（主要注入 plan 数据）
            message: normalizeAssistantMessageForSDK(message),
            session_id: getSessionId(),
            parent_tool_use_id: null,
            uuid: message.uuid,
            error: message.error,
          },
        ]
      case 'user':
        return [
          {
            type: 'user',
            message: message.message,
            session_id: getSessionId(),
            parent_tool_use_id: null,
            uuid: message.uuid,
            timestamp: message.timestamp,
            // isSynthetic 为 true 时表示该消息不是真实用户输入
            isSynthetic: message.isMeta || message.isVisibleInTranscriptOnly,
            // 结构化工具输出（非发给模型的字符串内容，而是完整的 Output 对象）
            // 通过 protobuf catchall 传递，供 Web 端读取，不污染模型上下文
            ...(message.toolUseResult !== undefined
              ? { tool_use_result: message.toolUseResult }
              : {}),
          },
        ]
      case 'system':
        if (message.subtype === 'compact_boundary' && message.compactMetadata) {
          // 将内部压缩边界消息转为 SDK 格式
          return [
            {
              type: 'system',
              subtype: 'compact_boundary' as const,
              session_id: getSessionId(),
              uuid: message.uuid,
              compact_metadata: toSDKCompactMetadata(message.compactMetadata),
            },
          ]
        }
        // 只转换包含实际命令输出（stdout/stderr）的 local_command 消息。
        // 同类型还用于命令输入元数据（如 <command-name>...</command-name>），
        // 这类内容不能泄漏给 RC Web UI，所以需要通过标签检测来过滤。
        if (
          message.subtype === 'local_command' &&
          (message.content.includes(`<${LOCAL_COMMAND_STDOUT_TAG}>`) ||
            message.content.includes(`<${LOCAL_COMMAND_STDERR_TAG}>`))
        ) {
          return [
            localCommandOutputToSDKAssistantMessage(
              message.content,
              message.uuid,
            ),
          ]
        }
        return []
      default:
        return []
    }
  })
}

/**
 * 将本地命令输出（如 /voice、/cost 等斜杠命令的输出）转换为格式完整的 SDKAssistantMessage，
 * 使下游消费者（移动端 App、session-ingress v1alpha→v1beta 转换器）无需 schema 变更即可解析。
 *
 * 选择以 assistant 消息格式输出（而非专用的 SDKLocalCommandOutputMessage）的原因：
 *   - 安卓端 SdkMessageTypes.kt 没有 local_command_output 处理器
 *   - api-go session-ingress 的 convertSystemEvent 只处理 init/compact_boundary
 * 参见：https://anthropic.sentry.io/issues/7266299248/（安卓端问题）
 *
 * 处理步骤：
 *   1. 剥离 ANSI 控制码（如 chalk.dim() 在 /cost 中产生的颜色代码）
 *   2. 去掉 XML 包装标签（local-command-stdout / local-command-stderr）
 *   3. 调用 createAssistantMessage 生成包含所有必要字段的合成助手消息
 *
 * @param rawContent 原始命令输出字符串（含 ANSI 码和 XML 标签）
 * @param uuid 消息的唯一标识符
 * @returns 格式完整的 SDKAssistantMessage
 */
export function localCommandOutputToSDKAssistantMessage(
  rawContent: string,
  uuid: UUID,
): SDKAssistantMessage {
  // 先去除 ANSI 控制码，再用正则提取 XML 标签内的实际内容
  const cleanContent = stripAnsi(rawContent)
    .replace(/<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/, '$1')
    .replace(/<local-command-stderr>([\s\S]*?)<\/local-command-stderr>/, '$1')
    .trim()
  // createAssistantMessage 生成完整的 APIAssistantMessage，
  // 包含 id、type、model: SYNTHETIC_MODEL、role、stop_reason、usage 等
  // 下游反序列化器（如安卓端 SdkAssistantMessage）要求这些字段全部存在
  const synthetic = createAssistantMessage({ content: cleanContent })
  return {
    type: 'assistant',
    message: synthetic.message,
    parent_tool_use_id: null,
    session_id: getSessionId(),
    uuid,
  }
}

/**
 * 将内部 ClaudeAILimits 映射为 SDK 对外暴露的 SDKRateLimitInfo 类型。
 *
 * 主要作用：过滤掉仅供内部使用的字段（如 unifiedRateLimitFallbackAvailable），
 * 只保留 SDK 消费者需要的公开限速信息。
 * 所有可选字段均使用条件展开，避免将 undefined 写入 SDK 消息对象。
 *
 * @param limits 内部限速信息（可为 undefined）
 * @returns SDK 限速信息（若 limits 为 undefined 则返回 undefined）
 */
export function toSDKRateLimitInfo(
  limits: ClaudeAILimits | undefined,
): SDKRateLimitInfo | undefined {
  if (!limits) {
    return undefined
  }
  return {
    status: limits.status,
    // 各字段仅在内部对象中存在时才写入，防止写入无意义的 undefined
    ...(limits.resetsAt !== undefined && { resetsAt: limits.resetsAt }),
    ...(limits.rateLimitType !== undefined && {
      rateLimitType: limits.rateLimitType,
    }),
    ...(limits.utilization !== undefined && {
      utilization: limits.utilization,
    }),
    ...(limits.overageStatus !== undefined && {
      overageStatus: limits.overageStatus,
    }),
    ...(limits.overageResetsAt !== undefined && {
      overageResetsAt: limits.overageResetsAt,
    }),
    ...(limits.overageDisabledReason !== undefined && {
      overageDisabledReason: limits.overageDisabledReason,
    }),
    ...(limits.isUsingOverage !== undefined && {
      isUsingOverage: limits.isUsingOverage,
    }),
    ...(limits.surpassedThreshold !== undefined && {
      surpassedThreshold: limits.surpassedThreshold,
    }),
  }
}

/**
 * 对助手消息内容进行规范化处理，以满足 SDK 消费者的期望格式。
 *
 * 核心逻辑：
 *   ExitPlanModeV2 工具（V2 版本）从文件而非工具输入读取 plan 内容，
 *   但 SDK 消费者期望 tool_input.plan 字段存在。
 *   本函数负责将当前 plan 内容注入到对应工具调用块的 input 中，
 *   使 SDK 侧看到一致的数据结构。
 *
 * @param message 内部助手消息
 * @returns 规范化后的助手消息内容（message 字段）
 */
function normalizeAssistantMessageForSDK(
  message: AssistantMessage,
): AssistantMessage['message'] {
  const content = message.message.content
  // 若内容不是数组（纯文本响应），直接返回原始消息，无需处理
  if (!Array.isArray(content)) {
    return message.message
  }

  const normalizedContent = content.map((block): BetaContentBlock => {
    // 非工具调用块直接透传，不做任何修改
    if (block.type !== 'tool_use') {
      return block
    }

    // 仅对 ExitPlanModeV2 工具块注入 plan 内容
    if (block.name === EXIT_PLAN_MODE_V2_TOOL_NAME) {
      const plan = getPlan()
      if (plan) {
        // 保留原有 input 字段，追加 plan 属性
        return {
          ...block,
          input: { ...(block.input as Record<string, unknown>), plan },
        }
      }
    }

    // 其他工具调用块直接透传
    return block
  })

  return {
    ...message.message,
    content: normalizedContent,
  }
}
