/**
 * debugUtils.ts — Bridge 调试工具函数集合
 *
 * 在 Claude Code 系统流程中的位置：
 *   Bridge 各模块（bridgeMain / remoteBridgeCore / createSession 等）
 *     └─> debugUtils.ts（本文件）——提供调试日志格式化、密钥脱敏和错误提取工具
 *
 * 功能概览：
 *   - redactSecrets：对调试字符串中的敏感字段进行部分脱敏（保留前 8 后 4 字符）
 *   - debugTruncate：截断调试字符串并折叠换行（上限 2000 字符）
 *   - debugBody：序列化任意值 + 脱敏 + 截断（调试日志标准入口）
 *   - describeAxiosError：提取 axios 错误的服务端消息（补全 HTTP 状态码信息）
 *   - extractHttpStatus：从 axios 错误中安全提取 HTTP 状态码
 *   - extractErrorDetail：从 API 响应体中提取可读的错误消息
 *   - logBridgeSkip：记录 Bridge 初始化跳过事件（调试日志 + 上报分析事件）
 *
 * 设计原则：
 *   所有函数均为纯函数或无副作用的日志包装，不持有状态。
 *   密钥脱敏采用正则表达式批量替换，确保调试日志不意外泄露令牌。
 */
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../services/analytics/index.js'
import { logForDebugging } from '../utils/debug.js'
import { errorMessage } from '../utils/errors.js'
import { jsonStringify } from '../utils/slowOperations.js'

/** 调试日志的最大字符长度（超出部分被截断并附加字符数提示） */
const DEBUG_MSG_LIMIT = 2000

/** 需要脱敏的敏感字段名列表 */
const SECRET_FIELD_NAMES = [
  'session_ingress_token',
  'environment_secret',
  'access_token',
  'secret',
  'token',
]

/** 敏感字段的 JSON 键值对正则表达式（匹配 "field_name": "value" 格式） */
const SECRET_PATTERN = new RegExp(
  `"(${SECRET_FIELD_NAMES.join('|')})"\\s*:\\s*"([^"]*)"`,
  'g',
)

/** 触发脱敏的最小值长度（短于此长度的值完全替换为 [REDACTED]） */
const REDACT_MIN_LENGTH = 16

/**
 * 对字符串中的敏感字段值进行部分脱敏。
 *
 * 脱敏策略：
 *   - 值长度 < 16：完全替换为 [REDACTED]
 *   - 值长度 >= 16：保留前 8 位 + "..." + 后 4 位
 *
 * 确保调试日志可用于排查问题的同时不泄露完整令牌。
 */
export function redactSecrets(s: string): string {
  return s.replace(SECRET_PATTERN, (_match, field: string, value: string) => {
    if (value.length < REDACT_MIN_LENGTH) {
      return `"${field}":"[REDACTED]"` // 短值完全脱敏
    }
    const redacted = `${value.slice(0, 8)}...${value.slice(-4)}` // 保留首尾
    return `"${field}":"${redacted}"`
  })
}

/**
 * 截断调试字符串，折叠换行符，限制在 DEBUG_MSG_LIMIT 字符以内。
 *
 * \n 替换为 \\n 使日志在单行中可读；
 * 超出部分附加 "... (N chars)" 提示。
 */
export function debugTruncate(s: string): string {
  const flat = s.replace(/\n/g, '\\n') // 折叠换行，单行展示
  if (flat.length <= DEBUG_MSG_LIMIT) {
    return flat
  }
  return flat.slice(0, DEBUG_MSG_LIMIT) + `... (${flat.length} chars)`
}

/**
 * 将任意值序列化为调试字符串（JSON 序列化 + 脱敏 + 截断）。
 *
 * 字符串直接使用，非字符串值先 JSON 序列化。
 * 适用于记录 HTTP 请求/响应体等调试信息。
 */
export function debugBody(data: unknown): string {
  const raw = typeof data === 'string' ? data : jsonStringify(data)
  const s = redactSecrets(raw) // 脱敏敏感字段
  if (s.length <= DEBUG_MSG_LIMIT) {
    return s
  }
  return s.slice(0, DEBUG_MSG_LIMIT) + `... (${s.length} chars)`
}

/**
 * 从 axios 错误中提取完整的错误描述（含服务端消息）。
 *
 * axios 默认错误消息只含 HTTP 状态码；此函数额外检查
 * response.data.message 或 response.data.error.message，
 * 拼接为更有用的调试信息。
 */
export function describeAxiosError(err: unknown): string {
  const msg = errorMessage(err)
  if (err && typeof err === 'object' && 'response' in err) {
    const response = (err as { response?: { data?: unknown } }).response
    if (response?.data && typeof response.data === 'object') {
      const data = response.data as Record<string, unknown>
      // 优先检查 data.message，其次检查 data.error.message
      const detail =
        typeof data.message === 'string'
          ? data.message
          : typeof data.error === 'object' &&
              data.error &&
              'message' in data.error &&
              typeof (data.error as Record<string, unknown>).message ===
                'string'
            ? (data.error as Record<string, unknown>).message
            : undefined
      if (detail) {
        return `${msg}: ${detail}` // 拼接服务端错误消息
      }
    }
  }
  return msg
}

/**
 * 从 axios 错误中安全提取 HTTP 状态码。
 *
 * 网络错误（无响应）返回 undefined；
 * HTTP 错误返回 response.status 数值。
 */
export function extractHttpStatus(err: unknown): number | undefined {
  if (
    err &&
    typeof err === 'object' &&
    'response' in err &&
    (err as { response?: { status?: unknown } }).response &&
    typeof (err as { response: { status?: unknown } }).response.status ===
      'number'
  ) {
    return (err as { response: { status: number } }).response.status
  }
  return undefined
}

/**
 * 从 API 响应体中提取可读的错误消息。
 *
 * 按优先级检查：
 *   1. data.message（字符串）
 *   2. data.error.message（字符串）
 * 均不存在时返回 undefined。
 *
 * 用于在 HTTP 4xx 响应中提取后端返回的具体错误原因。
 */
export function extractErrorDetail(data: unknown): string | undefined {
  if (!data || typeof data !== 'object') return undefined
  if ('message' in data && typeof data.message === 'string') {
    return data.message // 直接消息字段
  }
  if (
    'error' in data &&
    data.error !== null &&
    typeof data.error === 'object' &&
    'message' in data.error &&
    typeof data.error.message === 'string'
  ) {
    return data.error.message // 嵌套错误对象的消息字段
  }
  return undefined
}

/**
 * 记录 Bridge 初始化跳过事件（调试日志 + 分析上报）。
 *
 * 封装 `tengu_bridge_repl_skipped` 分析事件和可选调试消息，
 * 避免各调用点重复 5 行样板代码。
 *
 * @param reason 跳过原因（上报到分析）
 * @param debugMsg 可选的调试日志消息
 * @param v2 是否为 v2 bridge 跳过（可选，用于区分 v1/v2）
 */
export function logBridgeSkip(
  reason: string,
  debugMsg?: string,
  v2?: boolean,
): void {
  if (debugMsg) {
    logForDebugging(debugMsg) // 写入调试日志
  }
  logEvent('tengu_bridge_repl_skipped', {
    reason:
      reason as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    ...(v2 !== undefined && { v2 }), // 可选：附加 v2 标识
  })
}
