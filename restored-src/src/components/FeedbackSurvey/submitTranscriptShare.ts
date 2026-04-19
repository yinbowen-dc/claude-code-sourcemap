/**
 * submitTranscriptShare.ts — 会话转录共享提交模块
 *
 * 在 Claude Code 系统流程中的位置：
 *   反馈调查 → 用户同意共享转录 → submitTranscriptShare → Anthropic 内部 API
 *
 * 主要功能：
 *   submitTranscriptShare：异步函数，收集完整会话转录（含子代理转录和原始 JSONL 文件），
 *   经过 redactSensitiveInfo 脱敏后通过 axios POST 提交至 Anthropic 转录共享 API。
 *
 * 触发来源（TranscriptShareTrigger）：
 *   - 'bad_feedback_survey'：用户给出差评后触发
 *   - 'good_feedback_survey'：用户给出好评后触发
 *   - 'frustration'：检测到用户沮丧信号时触发
 *   - 'memory_survey'：记忆功能调查后触发
 *
 * 安全考虑：
 *   - 原始 JSONL 有大小上限（MAX_TRANSCRIPT_READ_BYTES），防止 OOM
 *   - 序列化后所有内容经 redactSensitiveInfo 统一脱敏
 *   - OAuth Token 在提交前自动刷新
 */
import axios from 'axios'
import { readFile, stat } from 'fs/promises'
import type { Message } from '../../types/message.js'
import { checkAndRefreshOAuthTokenIfNeeded } from '../../utils/auth.js'
import { logForDebugging } from '../../utils/debug.js'
import { errorMessage } from '../../utils/errors.js'
import { getAuthHeaders, getUserAgent } from '../../utils/http.js'
import { normalizeMessagesForAPI } from '../../utils/messages.js'
import {
  extractAgentIdsFromMessages,
  getTranscriptPath,
  loadSubagentTranscripts,
  MAX_TRANSCRIPT_READ_BYTES,
} from '../../utils/sessionStorage.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { redactSensitiveInfo } from '../Feedback.js'

type TranscriptShareResult = {
  success: boolean
  transcriptId?: string
}

export type TranscriptShareTrigger =
  | 'bad_feedback_survey'
  | 'good_feedback_survey'
  | 'frustration'
  | 'memory_survey'

/**
 * submitTranscriptShare
 *
 * 整体流程：
 *   1. 将消息列表规范化为 API 格式（normalizeMessagesForAPI）
 *   2. 提取子代理 ID，从磁盘加载子代理转录（loadSubagentTranscripts）
 *   3. 尝试读取原始 JSONL 转录文件（带大小保护，超过上限则跳过）
 *   4. 组装请求数据对象（trigger、version、platform、transcript、subagentTranscripts、rawTranscriptJsonl）
 *   5. JSON 序列化后通过 redactSensitiveInfo 脱敏
 *   6. 刷新 OAuth Token，获取认证请求头
 *   7. POST 到 Anthropic 共享转录 API（30s 超时）
 *   8. 成功（HTTP 200/201）→ 返回 { success: true, transcriptId }
 *   9. 失败（任何异常）→ 记录调试日志，返回 { success: false }
 *
 * 在系统中的角色：
 *   是用户同意共享转录后的唯一执行路径，
 *   上报数据用于 Anthropic 改进 Claude Code 的行为和质量。
 */
export async function submitTranscriptShare(
  messages: Message[],
  trigger: TranscriptShareTrigger,
  appearanceId: string,
): Promise<TranscriptShareResult> {
  try {
    logForDebugging('Collecting transcript for sharing', { level: 'info' })

    const transcript = normalizeMessagesForAPI(messages)

    // Collect subagent transcripts
    const agentIds = extractAgentIdsFromMessages(messages)
    const subagentTranscripts = await loadSubagentTranscripts(agentIds)

    // Read raw JSONL transcript (with size guard to prevent OOM)
    let rawTranscriptJsonl: string | undefined
    try {
      const transcriptPath = getTranscriptPath()
      const { size } = await stat(transcriptPath)
      if (size <= MAX_TRANSCRIPT_READ_BYTES) {
        rawTranscriptJsonl = await readFile(transcriptPath, 'utf-8')
      } else {
        logForDebugging(
          `Skipping raw transcript read: file too large (${size} bytes)`,
          { level: 'warn' },
        )
      }
    } catch {
      // File may not exist
    }

    const data = {
      trigger,
      version: MACRO.VERSION,
      platform: process.platform,
      transcript,
      subagentTranscripts:
        Object.keys(subagentTranscripts).length > 0
          ? subagentTranscripts
          : undefined,
      rawTranscriptJsonl,
    }

    const content = redactSensitiveInfo(jsonStringify(data))

    await checkAndRefreshOAuthTokenIfNeeded()

    const authResult = getAuthHeaders()
    if (authResult.error) {
      return { success: false }
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': getUserAgent(),
      ...authResult.headers,
    }

    const response = await axios.post(
      'https://api.anthropic.com/api/claude_code_shared_session_transcripts',
      { content, appearance_id: appearanceId },
      {
        headers,
        timeout: 30000,
      },
    )

    if (response.status === 200 || response.status === 201) {
      const result = response.data
      logForDebugging('Transcript shared successfully', { level: 'info' })
      return {
        success: true,
        transcriptId: result?.transcript_id,
      }
    }

    return { success: false }
  } catch (err) {
    logForDebugging(errorMessage(err), {
      level: 'error',
    })
    return { success: false }
  }
}
