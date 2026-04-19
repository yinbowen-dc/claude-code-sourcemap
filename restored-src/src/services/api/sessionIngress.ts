/**
 * Session Ingress（会话持久化）模块
 *
 * 在 Claude Code 系统流程中的位置：
 *   Claude Code 每次生成会话条目（消息/工具调用/结果等）→ 调用 appendSessionLog() 追加到服务端
 *   → 会话恢复/Teleport 时调用 getSessionLogs()/getSessionLogsViaOAuth()/getTeleportEvents() 拉取全量日志
 *
 * 主要功能：
 *  - appendSessionLog          — 追加单条日志到会话（JWT 认证，顺序执行，幂等重试）
 *  - getSessionLogs            — 拉取会话全量日志用于水化（JWT 认证）
 *  - getSessionLogsViaOAuth    — 通过 OAuth 拉取会话日志（Teleport 场景）
 *  - getTeleportEvents         — 通过 CCR v2 Sessions API 分页拉取 Teleport 事件（新接口）
 *  - clearSession              — 清除指定会话的缓存状态
 *  - clearAllSessions          — 清除所有会话的缓存状态（/clear 命令时调用）
 *
 * 关键设计：
 *  - 追加链（append chain）：每次写入附带 Last-Uuid 请求头，服务端通过 UUID 链保证追加顺序
 *  - 乐观并发控制：409 冲突时从响应头或重拉会话获取最新 UUID，然后重试
 *  - 顺序执行：每个会话有独立的 sequential 包装器，防止并发写入同一会话
 *  - 指数退避重试：最多 MAX_RETRIES=10 次，基础延迟 BASE_DELAY_MS=500ms，上限 8s
 *  - Teleport 分页：1000 条/页，最多 100 页（共 10 万条），防止无限循环
 */

import axios, { type AxiosError } from 'axios'
import type { UUID } from 'crypto'
import { getOauthConfig } from '../../constants/oauth.js'
import type { Entry, TranscriptMessage } from '../../types/logs.js'
import { logForDebugging } from '../../utils/debug.js'
import { logForDiagnosticsNoPII } from '../../utils/diagLogs.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { logError } from '../../utils/log.js'
import { sequential } from '../../utils/sequential.js'
import { getSessionIngressAuthToken } from '../../utils/sessionIngressAuth.js'
import { sleep } from '../../utils/sleep.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { getOAuthHeaders } from '../../utils/teleport/api.js'

/** Session Ingress API 的错误响应结构 */
interface SessionIngressError {
  error?: {
    message?: string
    type?: string
  }
}

// 模块级状态：记录每个会话最后一次成功写入的 UUID，用于追加链的 Last-Uuid 请求头
const lastUuidMap: Map<string, UUID> = new Map()

// 最大重试次数：10 次（用于网络错误、5xx、429 等可重试场景）
const MAX_RETRIES = 10
// 基础重试延迟：500ms，实际延迟 = min(BASE_DELAY_MS * 2^(attempt-1), 8000)
const BASE_DELAY_MS = 500

// 每个会话的顺序执行包装器 Map，防止同一会话的并发写入产生 UUID 链冲突
const sequentialAppendBySession: Map<
  string,
  (
    entry: TranscriptMessage,
    url: string,
    headers: Record<string, string>,
  ) => Promise<boolean>
> = new Map()

/**
 * 获取或创建指定会话的顺序执行包装器。
 *
 * 每个会话维护一个独立的 sequential 包装器，确保该会话的日志追加操作
 * 逐一按顺序执行，避免并发写入导致 UUID 链冲突（409 错误）。
 */
function getOrCreateSequentialAppend(sessionId: string) {
  let sequentialAppend = sequentialAppendBySession.get(sessionId)
  if (!sequentialAppend) {
    sequentialAppend = sequential(
      async (
        entry: TranscriptMessage,
        url: string,
        headers: Record<string, string>,
      ) => await appendSessionLogImpl(sessionId, entry, url, headers),
    )
    sequentialAppendBySession.set(sessionId, sequentialAppend)
  }
  return sequentialAppend
}

/**
 * 追加会话日志的核心实现（含重试逻辑）。
 *
 * 重试策略：
 *  - 网络错误、5xx、429 → 可重试（指数退避）
 *  - 409 冲突（UUID 链不匹配）→ 从响应头或重拉会话采纳服务端最新 UUID，然后重试
 *  - 401 未授权 → 不可重试，立即返回 false
 *
 * 409 处理细节：
 *  - 若服务端返回 x-last-uuid 且等于本条目 UUID → 条目已成功写入（之前响应丢失），直接返回 true
 *  - 若服务端返回 x-last-uuid 且不同 → 采纳该 UUID 作为新 Last-Uuid 重试
 *  - 若无 x-last-uuid → 重拉会话找到最后一个有效 UUID 后重试
 */
async function appendSessionLogImpl(
  sessionId: string,
  entry: TranscriptMessage,
  url: string,
  headers: Record<string, string>,
): Promise<boolean> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const lastUuid = lastUuidMap.get(sessionId)
      const requestHeaders = { ...headers }
      if (lastUuid) {
        // 追加链头部：告知服务端当前客户端认为的最后一条 UUID
        requestHeaders['Last-Uuid'] = lastUuid
      }

      const response = await axios.put(url, entry, {
        headers: requestHeaders,
        validateStatus: status => status < 500, // 5xx 直接抛出，4xx 由下方逻辑处理
      })

      if (response.status === 200 || response.status === 201) {
        // 成功写入：更新本地追踪的最后 UUID
        lastUuidMap.set(sessionId, entry.uuid)
        logForDebugging(
          `Successfully persisted session log entry for session ${sessionId}`,
        )
        return true
      }

      if (response.status === 409) {
        // 409 冲突：UUID 链不匹配，需要采纳服务端最新 UUID
        const serverLastUuid = response.headers['x-last-uuid']
        if (serverLastUuid === entry.uuid) {
          // 当前条目就是服务端最后一条——之前已成功写入，只是客户端未收到响应
          // 恢复 stale 状态，视为成功
          lastUuidMap.set(sessionId, entry.uuid)
          logForDebugging(
            `Session entry ${entry.uuid} already present on server, recovering from stale state`,
          )
          logForDiagnosticsNoPII('info', 'session_persist_recovered_from_409')
          return true
        }

        // 另一个写入者（如已被杀死进程的 in-flight 请求）推进了服务端链头
        // 优先从响应头获取最新 UUID，若无则重拉整个会话
        if (serverLastUuid) {
          // 直接从响应头采纳最新 UUID，避免额外的 GET 请求
          lastUuidMap.set(sessionId, serverLastUuid as UUID)
          logForDebugging(
            `Session 409: adopting server lastUuid=${serverLastUuid} from header, retrying entry ${entry.uuid}`,
          )
        } else {
          // 服务端未返回 x-last-uuid（旧版 v1 接口），重拉整个会话找到链头
          const logs = await fetchSessionLogsFromUrl(sessionId, url, headers)
          const adoptedUuid = findLastUuid(logs)
          if (adoptedUuid) {
            lastUuidMap.set(sessionId, adoptedUuid)
            logForDebugging(
              `Session 409: re-fetched ${logs!.length} entries, adopting lastUuid=${adoptedUuid}, retrying entry ${entry.uuid}`,
            )
          } else {
            // 无法确定服务端状态，放弃本次写入
            const errorData = response.data as SessionIngressError
            const errorMessage =
              errorData.error?.message || 'Concurrent modification detected'
            logError(
              new Error(
                `Session persistence conflict: UUID mismatch for session ${sessionId}, entry ${entry.uuid}. ${errorMessage}`,
              ),
            )
            logForDiagnosticsNoPII(
              'error',
              'session_persist_fail_concurrent_modification',
            )
            return false
          }
        }
        logForDiagnosticsNoPII('info', 'session_persist_409_adopt_server_uuid')
        continue // 使用更新后的 lastUuid 重试
      }

      if (response.status === 401) {
        // 401：令牌过期或无效，不可重试
        logForDebugging('Session token expired or invalid')
        logForDiagnosticsNoPII('error', 'session_persist_fail_bad_token')
        return false
      }

      // 其他 4xx（如 429）：可重试
      logForDebugging(
        `Failed to persist session log: ${response.status} ${response.statusText}`,
      )
      logForDiagnosticsNoPII('error', 'session_persist_fail_status', {
        status: response.status,
        attempt,
      })
    } catch (error) {
      // 网络错误或 5xx：可重试
      const axiosError = error as AxiosError<SessionIngressError>
      logError(new Error(`Error persisting session log: ${axiosError.message}`))
      logForDiagnosticsNoPII('error', 'session_persist_fail_status', {
        status: axiosError.status,
        attempt,
      })
    }

    if (attempt === MAX_RETRIES) {
      // 已达最大重试次数，放弃
      logForDebugging(`Remote persistence failed after ${MAX_RETRIES} attempts`)
      logForDiagnosticsNoPII(
        'error',
        'session_persist_error_retries_exhausted',
        { attempt },
      )
      return false
    }

    // 指数退避：延迟 = min(500ms * 2^(attempt-1), 8000ms)
    const delayMs = Math.min(BASE_DELAY_MS * Math.pow(2, attempt - 1), 8000)
    logForDebugging(
      `Remote persistence attempt ${attempt}/${MAX_RETRIES} failed, retrying in ${delayMs}ms…`,
    )
    await sleep(delayMs)
  }

  return false
}

/**
 * 追加单条日志条目到指定会话（使用 JWT 令牌认证）。
 *
 * 流程：
 *  1. 获取 JWT 会话令牌，无令牌则直接返回 false
 *  2. 构造 Bearer 认证头
 *  3. 通过顺序包装器执行追加（防止并发写入同一会话）
 *
 * 使用乐观并发控制（Last-Uuid 请求头），确保追加链的顺序性。
 */
export async function appendSessionLog(
  sessionId: string,
  entry: TranscriptMessage,
  url: string,
): Promise<boolean> {
  const sessionToken = getSessionIngressAuthToken()
  if (!sessionToken) {
    logForDebugging('No session token available for session persistence')
    logForDiagnosticsNoPII('error', 'session_persist_fail_jwt_no_token')
    return false
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${sessionToken}`, // JWT Bearer 认证
    'Content-Type': 'application/json',
  }

  // 通过顺序包装器确保同一会话的写入串行执行
  const sequentialAppend = getOrCreateSequentialAppend(sessionId)
  return sequentialAppend(entry, url, headers)
}

/**
 * 拉取指定会话的全量日志（用于会话水化，JWT 认证）。
 *
 * 成功获取日志后，将最后一条有效 UUID 存入 lastUuidMap，
 * 确保后续 appendSessionLog 能正确设置 Last-Uuid 请求头。
 */
export async function getSessionLogs(
  sessionId: string,
  url: string,
): Promise<Entry[] | null> {
  const sessionToken = getSessionIngressAuthToken()
  if (!sessionToken) {
    logForDebugging('No session token available for fetching session logs')
    logForDiagnosticsNoPII('error', 'session_get_fail_no_token')
    return null
  }

  const headers = { Authorization: `Bearer ${sessionToken}` }
  const logs = await fetchSessionLogsFromUrl(sessionId, url, headers)

  if (logs && logs.length > 0) {
    // 更新 lastUuid，使后续追加操作能正确衔接已有的 UUID 链
    const lastEntry = logs.at(-1)
    if (lastEntry && 'uuid' in lastEntry && lastEntry.uuid) {
      lastUuidMap.set(sessionId, lastEntry.uuid)
    }
  }

  return logs
}

/**
 * 通过 OAuth 认证拉取会话全量日志（Teleport 场景使用）。
 *
 * 与 getSessionLogs 的区别：使用 OAuth Bearer Token + 组织 UUID 认证，
 * 而非 JWT 令牌，适用于从 Sessions API teleport 会话的场景。
 */
export async function getSessionLogsViaOAuth(
  sessionId: string,
  accessToken: string,
  orgUUID: string,
): Promise<Entry[] | null> {
  const url = `${getOauthConfig().BASE_API_URL}/v1/session_ingress/session/${sessionId}`
  logForDebugging(`[session-ingress] Fetching session logs from: ${url}`)
  const headers = {
    ...getOAuthHeaders(accessToken),
    'x-organization-uuid': orgUUID,
  }
  const result = await fetchSessionLogsFromUrl(sessionId, url, headers)
  return result
}

/**
 * GET /v1/code/sessions/{id}/teleport-events 的响应结构。
 * WorkerEvent.payload 即为 Entry（TranscriptMessage 结构）——
 * CLI 通过 AddWorkerEvent 写入，服务端不透明存储，本接口读取回来。
 */
type TeleportEventsResponse = {
  data: Array<{
    event_id: string
    event_type: string
    is_compaction: boolean
    payload: Entry | null // null 表示非泛型事件（服务端跳过）或加密失败
    created_at: string
  }>
  // 无更多页时此字段不存在——这是流结束信号（无独立的 has_more 字段）
  next_cursor?: string
}

/**
 * 通过 CCR v2 Sessions API 分页拉取 Teleport 事件（新版接口，替代 getSessionLogsViaOAuth）。
 *
 * 服务端按会话分发：v2 原生会话使用 Spanner，migration 前的旧会话使用 threadstore。
 * 分页游标对客户端不透明，原样回传直到 next_cursor 不存在（流结束）。
 *
 * 分页参数：
 *  - 每页 1000 条（服务端上限）
 *  - 最多 100 页（共 10 万条）——超限时截断返回，防止无限循环
 */
export async function getTeleportEvents(
  sessionId: string,
  accessToken: string,
  orgUUID: string,
): Promise<Entry[] | null> {
  const baseUrl = `${getOauthConfig().BASE_API_URL}/v1/code/sessions/${sessionId}/teleport-events`
  const headers = {
    ...getOAuthHeaders(accessToken),
    'x-organization-uuid': orgUUID,
  }

  logForDebugging(`[teleport] Fetching events from: ${baseUrl}`)

  const all: Entry[] = []
  let cursor: string | undefined
  let pages = 0

  // 防无限循环守卫：1000条/页 × 100页 = 10万条
  // 超过此限制时可能是服务端游标异常（不推进）—— 截断返回而非挂起
  const maxPages = 100

  while (pages < maxPages) {
    const params: Record<string, string | number> = { limit: 1000 }
    if (cursor !== undefined) {
      params.cursor = cursor // 回传游标以获取下一页
    }

    let response
    try {
      response = await axios.get<TeleportEventsResponse>(baseUrl, {
        headers,
        params,
        timeout: 20000, // 20 秒超时
        validateStatus: status => status < 500, // 5xx 直接抛出
      })
    } catch (e) {
      const err = e as AxiosError
      logError(new Error(`Teleport events fetch failed: ${err.message}`))
      logForDiagnosticsNoPII('error', 'teleport_events_fetch_fail')
      return null
    }

    if (response.status === 404) {
      // 404 在迁移窗口期语义模糊：
      //   (a) 会话确实不存在（Spanner 和 threadstore 均无）—— 无数据可拉
      //   (b) 路由级 404：接口未部署，或 threadstore 会话尚未回填到 Spanner
      // 无法从响应区分两种情况，返回 null 让调用方回退到 session-ingress 接口
      // 第 0 页以后出现 404 说明会话在分页中途被删除，返回已获取的部分数据
      logForDebugging(
        `[teleport] Session ${sessionId} not found (page ${pages})`,
      )
      logForDiagnosticsNoPII('warn', 'teleport_events_not_found')
      return pages === 0 ? null : all
    }

    if (response.status === 401) {
      // 401：令牌过期，抛出用户可见错误提示登录
      logForDiagnosticsNoPII('error', 'teleport_events_bad_token')
      throw new Error(
        'Your session has expired. Please run /login to sign in again.',
      )
    }

    if (response.status !== 200) {
      logError(
        new Error(
          `Teleport events returned ${response.status}: ${jsonStringify(response.data)}`,
        ),
      )
      logForDiagnosticsNoPII('error', 'teleport_events_bad_status')
      return null
    }

    const { data, next_cursor } = response.data
    if (!Array.isArray(data)) {
      logError(
        new Error(
          `Teleport events invalid response shape: ${jsonStringify(response.data)}`,
        ),
      )
      logForDiagnosticsNoPII('error', 'teleport_events_invalid_shape')
      return null
    }

    // payload 即为 Entry，null payload 出现于非泛型 threadstore 事件或加密失败，跳过
    for (const ev of data) {
      if (ev.payload !== null) {
        all.push(ev.payload)
      }
    }

    pages++
    // == null 同时覆盖 null 和 undefined：
    // proto 在流末尾省略此字段，但部分序列化器会输出 null。
    // 严格使用 === undefined 会在 cursor=null 时无限循环（null 被字符串化为 "null"）
    if (next_cursor == null) {
      break // 无更多页，流结束
    }
    cursor = next_cursor
  }

  if (pages >= maxPages) {
    // 触达页数上限：截断返回而不是失败——部分数据比完全不 teleport 更好
    logError(
      new Error(`Teleport events hit page cap (${maxPages}) for ${sessionId}`),
    )
    logForDiagnosticsNoPII('warn', 'teleport_events_page_cap')
  }

  logForDebugging(
    `[teleport] Fetched ${all.length} events over ${pages} page(s) for ${sessionId}`,
  )
  return all
}

/**
 * 通用的会话日志拉取实现（供多个公开函数复用）。
 *
 * 处理逻辑：
 *  - 200 → 验证响应结构，返回 Entry 数组
 *  - 404 → 该会话无日志，返回空数组
 *  - 401 → 令牌过期，抛出用户可见错误
 *  - 其他状态码 → 记录错误，返回 null
 *  - 网络异常 → 记录错误，返回 null
 *
 * 支持 CLAUDE_AFTER_LAST_COMPACT 环境变量：启用时仅拉取最后一次压缩之后的日志。
 */
async function fetchSessionLogsFromUrl(
  sessionId: string,
  url: string,
  headers: Record<string, string>,
): Promise<Entry[] | null> {
  try {
    const response = await axios.get(url, {
      headers,
      timeout: 20000, // 20 秒超时
      validateStatus: status => status < 500,
      // CLAUDE_AFTER_LAST_COMPACT=true 时仅拉取最后一次压缩后的条目
      params: isEnvTruthy(process.env.CLAUDE_AFTER_LAST_COMPACT)
        ? { after_last_compact: true }
        : undefined,
    })

    if (response.status === 200) {
      const data = response.data

      // 验证响应格式：必须有 loglines 数组
      if (!data || typeof data !== 'object' || !Array.isArray(data.loglines)) {
        logError(
          new Error(
            `Invalid session logs response format: ${jsonStringify(data)}`,
          ),
        )
        logForDiagnosticsNoPII('error', 'session_get_fail_invalid_response')
        return null
      }

      const logs = data.loglines as Entry[]
      logForDebugging(
        `Fetched ${logs.length} session logs for session ${sessionId}`,
      )
      return logs
    }

    if (response.status === 404) {
      // 该会话尚无日志（新会话首次拉取）
      logForDebugging(`No existing logs for session ${sessionId}`)
      logForDiagnosticsNoPII('warn', 'session_get_no_logs_for_session')
      return []
    }

    if (response.status === 401) {
      // 令牌过期，抛出用户可见错误
      logForDebugging('Auth token expired or invalid')
      logForDiagnosticsNoPII('error', 'session_get_fail_bad_token')
      throw new Error(
        'Your session has expired. Please run /login to sign in again.',
      )
    }

    logForDebugging(
      `Failed to fetch session logs: ${response.status} ${response.statusText}`,
    )
    logForDiagnosticsNoPII('error', 'session_get_fail_status', {
      status: response.status,
    })
    return null
  } catch (error) {
    const axiosError = error as AxiosError<SessionIngressError>
    logError(new Error(`Error fetching session logs: ${axiosError.message}`))
    logForDiagnosticsNoPII('error', 'session_get_fail_status', {
      status: axiosError.status,
    })
    return null
  }
}

/**
 * 从日志条目列表中向后查找最后一个有效 UUID。
 *
 * 部分条目类型（SummaryMessage、TagMessage 等）不含 uuid 字段，
 * 需要从末尾向前搜索找到第一个有 uuid 的条目。
 */
function findLastUuid(logs: Entry[] | null): UUID | undefined {
  if (!logs) {
    return undefined
  }
  const entry = logs.findLast(e => 'uuid' in e && e.uuid)
  return entry && 'uuid' in entry ? (entry.uuid as UUID) : undefined
}

/**
 * 清除指定会话的本地缓存状态（lastUuid 和顺序执行包装器）。
 * 会话结束或重置时调用。
 */
export function clearSession(sessionId: string): void {
  lastUuidMap.delete(sessionId)
  sequentialAppendBySession.delete(sessionId)
}

/**
 * 清除所有会话的本地缓存状态。
 * 用户执行 /clear 命令时调用，释放所有子 Agent 会话的内存占用。
 */
export function clearAllSessions(): void {
  lastUuidMap.clear()
  sequentialAppendBySession.clear()
}
