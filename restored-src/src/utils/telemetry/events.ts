/**
 * telemetry/events.ts — OTel 事件日志发射器
 *
 * 在 Claude Code 的可观测性体系中，本文件提供 logOTelEvent 函数，
 * 用于将结构化事件（如用户操作、工具调用、会话生命周期等）
 * 写入 OpenTelemetry LoggerProvider，最终导出到分析后端（BigQuery 等）。
 *
 * 核心设计：
 *   - 单调递增的 eventSequence 计数器，确保事件在会话内有明确的顺序
 *   - 附加公共遥测属性（用户 ID、会话 ID 等）到每个事件
 *   - 附加 prompt.id（当前 LLM 请求 ID），但不用于指标维度（避免高基数）
 *   - 附加 workspace.host_paths（桌面应用宿主路径），仅用于事件（不用于指标）
 *   - 通过 OTEL_LOG_USER_PROMPTS 环境变量控制用户提示词的脱敏
 *
 * 事件命名格式：claude_code.<eventName>（在 LogRecord.body 中体现）
 */

import type { Attributes } from '@opentelemetry/api'
import { getEventLogger, getPromptId } from 'src/bootstrap/state.js'
import { logForDebugging } from '../debug.js'
import { isEnvTruthy } from '../envUtils.js'
import { getTelemetryAttributes } from '../telemetryAttributes.js'

// 会话内事件的单调递增序号，用于在后端排序事件（每次函数调用自增）
let eventSequence = 0

// 标记是否已警告过 event logger 未初始化，避免重复打印相同警告
let hasWarnedNoEventLogger = false

/**
 * 检查是否启用了用户提示词明文日志记录。
 * 默认关闭（敏感），需要通过 OTEL_LOG_USER_PROMPTS=1 显式开启。
 */
function isUserPromptLoggingEnabled() {
  return isEnvTruthy(process.env.OTEL_LOG_USER_PROMPTS)
}

/**
 * 根据用户提示词日志配置决定是否对内容脱敏。
 *
 * 用于处理可能包含用户输入的字段。若未启用明文日志，
 * 则将内容替换为 '<REDACTED>' 以保护用户隐私。
 *
 * @param content - 原始内容字符串
 * @returns 原始内容（若启用了明文日志）或 '<REDACTED>'
 */
export function redactIfDisabled(content: string): string {
  return isUserPromptLoggingEnabled() ? content : '<REDACTED>'
}

/**
 * 发射一个结构化的 OTel 事件日志记录。
 *
 * 执行流程：
 *   1. 获取 event logger（若未初始化则跳过并警告）
 *   2. 测试环境（NODE_ENV=test）跳过发射
 *   3. 合并公共遥测属性 + 事件特有属性：
 *      - event.name     : 事件名称
 *      - event.timestamp: ISO 8601 时间戳
 *      - event.sequence : 单调递增序号（每次调用递增）
 *      - prompt.id      : 当前 LLM 请求 ID（若存在）
 *      - workspace.host_paths : 工作空间宿主路径数组（若存在，来自桌面应用）
 *   4. 将 metadata 中的键值对展开为 OTel 属性
 *   5. 调用 eventLogger.emit() 写入日志
 *
 * 注意：prompt.id 和 workspace.host_paths 仅附加到事件，不用于指标，
 * 因为它们的基数（cardinality）会导致指标存储爆炸。
 *
 * @param eventName - 事件名称（如 'tool_use', 'session_start'）
 * @param metadata  - 事件特有的附加元数据（键值对）
 */
export async function logOTelEvent(
  eventName: string,
  metadata: { [key: string]: string | undefined } = {},
): Promise<void> {
  // 获取全局 event logger（由 instrumentation.ts 在启动时初始化）
  const eventLogger = getEventLogger()
  if (!eventLogger) {
    // 只警告一次，避免日志刷屏
    if (!hasWarnedNoEventLogger) {
      hasWarnedNoEventLogger = true
      logForDebugging(
        `[3P telemetry] Event dropped (no event logger initialized): ${eventName}`,
        { level: 'warn' },
      )
    }
    return
  }

  // 测试环境中不发射真实事件，避免污染分析数据
  if (process.env.NODE_ENV === 'test') {
    return
  }

  // 构建完整的属性集合：公共属性 + 事件特有属性
  const attributes: Attributes = {
    ...getTelemetryAttributes(),  // 用户 ID、会话 ID、版本等公共属性
    'event.name': eventName,
    'event.timestamp': new Date().toISOString(),
    'event.sequence': eventSequence++,  // 使用后自增，保证单调递增
  }

  // 附加 prompt ID（用于关联同一 LLM 请求中的多个事件）
  // 注意：不用于指标维度，因为每次请求的 promptId 都不同（无界基数）
  const promptId = getPromptId()
  if (promptId) {
    attributes['prompt.id'] = promptId
  }

  // 附加工作空间宿主路径（来自桌面应用，宿主机路径可能与容器内路径不同）
  // 文件系统路径对指标维度来说基数过高，因此仅用于事件
  // BQ 指标管道绝不应看到这些路径
  const workspaceDir = process.env.CLAUDE_CODE_WORKSPACE_HOST_PATHS
  if (workspaceDir) {
    // 多个路径用 '|' 分隔，展开为数组
    attributes['workspace.host_paths'] = workspaceDir.split('|')
  }

  // 将调用方传入的 metadata 展开为 OTel 属性
  // undefined 值跳过（OTel 不支持 undefined 属性值）
  for (const [key, value] of Object.entries(metadata)) {
    if (value !== undefined) {
      attributes[key] = value
    }
  }

  // 发射 OTel 日志记录，body 使用 "claude_code.<eventName>" 格式
  eventLogger.emit({
    body: `claude_code.${eventName}`,
    attributes,
  })
}
