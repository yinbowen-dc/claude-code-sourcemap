/**
 * jwtUtils.ts — JWT 工具函数集合 + 令牌刷新调度器
 *
 * 在 Claude Code 系统流程中的位置：
 *   Bridge 传输层（replBridgeTransport.ts / bridgeMain.ts / sessionRunner.ts）
 *     └─> jwtUtils.ts（本文件）——JWT 解码工具 + 主动预刷新调度器
 *
 * 主要功能：
 *   - decodeJwtPayload：不验签地解码 JWT payload（支持 sk-ant-si- 前缀剥离）
 *   - decodeJwtExpiry：提取 JWT 的 exp claim（Unix 秒）
 *   - createTokenRefreshScheduler：基于 JWT 过期时间的主动预刷新调度器
 *
 * 令牌刷新调度器设计：
 *   - 在令牌过期前 refreshBufferMs（默认 5 分钟）触发刷新
 *   - 代次（generation）机制：schedule/cancel 递增代次，
 *     异步 doRefresh() 比对代次，若不匹配则放弃设置后续定时器（防止孤儿定时器）
 *   - 失败重试：最多 MAX_REFRESH_FAILURES 次，每次间隔 60 秒
 *   - 保底续期：成功刷新后自动调度 30 分钟后的兜底刷新
 *     （防止长时间会话在首次刷新窗口后令牌过期）
 */
import { logEvent } from '../services/analytics/index.js'
import { logForDebugging } from '../utils/debug.js'
import { logForDiagnosticsNoPII } from '../utils/diagLogs.js'
import { errorMessage } from '../utils/errors.js'
import { jsonParse } from '../utils/slowOperations.js'

/** 格式化毫秒时长为可读字符串（如 "5m 30s"），用于调试日志 */
function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  const m = Math.floor(ms / 60_000)
  const s = Math.round((ms % 60_000) / 1000)
  return s > 0 ? `${m}m ${s}s` : `${m}m`
}

/**
 * 不验签地解码 JWT 的 payload 段。
 *
 * 支持剥离 `sk-ant-si-` session-ingress 前缀（该前缀是 Anthropic 会话令牌的特殊标识）。
 * 解码流程：
 *   1. 剥离 sk-ant-si- 前缀（若存在）
 *   2. 按 '.' 分割，取第二段（payload 部分）
 *   3. base64url 解码 → UTF-8 字符串 → JSON 解析
 *
 * 注意：不验证签名，仅用于读取 exp 等公开 claim。
 *
 * Decode a JWT's payload segment without verifying the signature.
 * Strips the `sk-ant-si-` session-ingress prefix if present.
 * Returns the parsed JSON payload as `unknown`, or `null` if the
 * token is malformed or the payload is not valid JSON.
 */
export function decodeJwtPayload(token: string): unknown | null {
  const jwt = token.startsWith('sk-ant-si-')
    ? token.slice('sk-ant-si-'.length) // 剥离 Anthropic session-ingress 前缀
    : token
  const parts = jwt.split('.')
  if (parts.length !== 3 || !parts[1]) return null // JWT 格式校验（header.payload.signature）
  try {
    return jsonParse(Buffer.from(parts[1], 'base64url').toString('utf8')) // base64url 解码后 JSON 解析
  } catch {
    return null // 非合法 JSON，返回 null
  }
}

/**
 * 从 JWT 中提取 exp（过期时间）claim，不验证签名。
 *
 * 调用 decodeJwtPayload，然后从 payload 中读取 exp 字段。
 * exp 的单位为 Unix 秒（非毫秒）。
 *
 * Decode the `exp` (expiry) claim from a JWT without verifying the signature.
 * @returns The `exp` value in Unix seconds, or `null` if unparseable
 */
export function decodeJwtExpiry(token: string): number | null {
  const payload = decodeJwtPayload(token)
  if (
    payload !== null &&
    typeof payload === 'object' &&
    'exp' in payload &&
    typeof payload.exp === 'number'
  ) {
    return payload.exp
  }
  return null
}

/** 令牌刷新缓冲时间：在令牌过期前 5 分钟触发刷新 */
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000

/** 无法解码 JWT 过期时间时的兜底刷新间隔（30 分钟） */
const FALLBACK_REFRESH_INTERVAL_MS = 30 * 60 * 1000 // 30 minutes

/** 连续失败达此次数后放弃刷新链，不再重试 */
const MAX_REFRESH_FAILURES = 3

/** getAccessToken 返回 undefined 时的重试延迟（60 秒） */
const REFRESH_RETRY_DELAY_MS = 60_000

/**
 * 创建基于 JWT 过期时间的令牌主动预刷新调度器。
 *
 * 同时用于独立 bridge 模式和 REPL bridge 模式：
 * - 独立 bridge：将新令牌写入子进程 stdin
 * - REPL bridge：触发 WebSocket 重连以使用新令牌
 *
 * 调度器接口：
 *   - schedule(sessionId, token)：解码 JWT exp，计算延迟后设置定时器
 *   - scheduleFromExpiresIn(sessionId, expiresInSeconds)：直接用 TTL 秒数调度（适用于不透明 JWT）
 *   - cancel(sessionId)：取消指定会话的刷新定时器
 *   - cancelAll()：取消所有定时器
 *
 * 代次（generation）机制：
 *   每次 schedule/cancel 调用都会递增对应 sessionId 的代次值。
 *   异步 doRefresh() 完成后检查代次是否匹配，不匹配则放弃设置后续定时器，
 *   防止被取消或已重新调度的会话产生孤儿定时器，避免重复刷新。
 *
 * Creates a token refresh scheduler that proactively refreshes session tokens
 * before they expire. Used by both the standalone bridge and the REPL bridge.
 */
export function createTokenRefreshScheduler({
  getAccessToken,
  onRefresh,
  label,
  refreshBufferMs = TOKEN_REFRESH_BUFFER_MS,
}: {
  getAccessToken: () => string | undefined | Promise<string | undefined>
  onRefresh: (sessionId: string, oauthToken: string) => void
  label: string
  /** How long before expiry to fire refresh. Defaults to 5 min. */
  refreshBufferMs?: number
}): {
  schedule: (sessionId: string, token: string) => void
  scheduleFromExpiresIn: (sessionId: string, expiresInSeconds: number) => void
  cancel: (sessionId: string) => void
  cancelAll: () => void
} {
  const timers = new Map<string, ReturnType<typeof setTimeout>>()   // 每个 sessionId 的刷新定时器
  const failureCounts = new Map<string, number>()                   // 每个 sessionId 的连续失败次数
  // 代次计数器：schedule()/cancel() 递增，doRefresh() 完成后比对，
  // 不匹配说明已被取消或重新调度，应跳过后续定时器设置（防止孤儿定时器）
  const generations = new Map<string, number>()

  /** 递增指定 sessionId 的代次，返回新代次值 */
  function nextGeneration(sessionId: string): number {
    const gen = (generations.get(sessionId) ?? 0) + 1
    generations.set(sessionId, gen)
    return gen
  }

  /**
   * 根据 JWT token 的 exp claim 调度刷新定时器。
   *
   * 若 token 无法解码（如 REPL bridge 传入的 OAuth token），
   * 保留已有定时器（如 doRefresh 设置的后续刷新），避免破坏刷新链。
   * 解码成功时：清除已有定时器 → 递增代次 → 计算延迟 → 设置新定时器。
   * 若距过期已 <= 0（已过期或在缓冲窗口内），立即触发刷新。
   */
  function schedule(sessionId: string, token: string): void {
    const expiry = decodeJwtExpiry(token)
    if (!expiry) {
      // 无法解码 JWT 过期时间（如 REPL bridge 的 OAuth token 传入此处）
      // 保留已有定时器（如 doRefresh 设置的后续刷新）以维持刷新链不断
      logForDebugging(
        `[${label}:token] Could not decode JWT expiry for sessionId=${sessionId}, token prefix=${token.slice(0, 15)}…, keeping existing timer`,
      )
      return
    }

    // 有具体过期时间，清除旧定时器，以新时间重新调度
    const existing = timers.get(sessionId)
    if (existing) {
      clearTimeout(existing) // 清除旧定时器，避免与新调度冲突
    }

    // 递增代次以使所有进行中的 doRefresh 调用失效
    const gen = nextGeneration(sessionId)

    const expiryDate = new Date(expiry * 1000).toISOString()
    const delayMs = expiry * 1000 - Date.now() - refreshBufferMs
    if (delayMs <= 0) {
      logForDebugging(
        `[${label}:token] Token for sessionId=${sessionId} expires=${expiryDate} (past or within buffer), refreshing immediately`,
      )
      void doRefresh(sessionId, gen)
      return
    }

    logForDebugging(
      `[${label}:token] Scheduled token refresh for sessionId=${sessionId} in ${formatDuration(delayMs)} (expires=${expiryDate}, buffer=${refreshBufferMs / 1000}s)`,
    )

    const timer = setTimeout(doRefresh, delayMs, sessionId, gen)
    timers.set(sessionId, timer)
  }

  /**
   * 使用显式 TTL 秒数（而非解码 JWT exp claim）调度刷新定时器。
   *
   * 适用于令牌不透明无法解码的场景（如 POST /v1/code/sessions/{id}/bridge 直接返回 expires_in）。
   * 延迟时间下限 30 秒：防止 refreshBufferMs 超过 expires_in 时 delayMs 为负数导致紧密循环。
   *
   * Schedule refresh using an explicit TTL (seconds until expiry) rather
   * than decoding a JWT's exp claim. Used by callers whose JWT is opaque
   * (e.g. POST /v1/code/sessions/{id}/bridge returns expires_in directly).
   */
  function scheduleFromExpiresIn(
    sessionId: string,
    expiresInSeconds: number,
  ): void {
    const existing = timers.get(sessionId)
    if (existing) clearTimeout(existing) // 清除旧定时器
    const gen = nextGeneration(sessionId) // 递增代次
    // 下限 30 秒：防止 refreshBufferMs 超过 expires_in 时延迟为负，导致紧密循环刷新
    const delayMs = Math.max(expiresInSeconds * 1000 - refreshBufferMs, 30_000)
    logForDebugging(
      `[${label}:token] Scheduled token refresh for sessionId=${sessionId} in ${formatDuration(delayMs)} (expires_in=${expiresInSeconds}s, buffer=${refreshBufferMs / 1000}s)`,
    )
    const timer = setTimeout(doRefresh, delayMs, sessionId, gen)
    timers.set(sessionId, timer)
  }

  /**
   * 异步执行令牌刷新操作。
   *
   * 流程：
   *   1. 调用 getAccessToken() 获取 OAuth 令牌
   *   2. 比对代次（检测是否已被 cancel/reschedule 使本次刷新过期）
   *   3. 无令牌时：记录失败，若未超过最大重试次数则调度重试
   *   4. 有令牌时：重置失败计数，调用 onRefresh 通知调用方使用新令牌
   *   5. 调度保底续期（FALLBACK_REFRESH_INTERVAL_MS 后再次刷新）
   */
  async function doRefresh(sessionId: string, gen: number): Promise<void> {
    let oauthToken: string | undefined
    try {
      oauthToken = await getAccessToken()
    } catch (err) {
      logForDebugging(
        `[${label}:token] getAccessToken threw for sessionId=${sessionId}: ${errorMessage(err)}`,
        { level: 'error' },
      )
    }

    // 若等待 getAccessToken() 期间会话已被取消或重新调度（代次变化），放弃本次刷新
    if (generations.get(sessionId) !== gen) {
      logForDebugging(
        `[${label}:token] doRefresh for sessionId=${sessionId} stale (gen ${gen} vs ${generations.get(sessionId)}), skipping`,
      )
      return
    }

    if (!oauthToken) {
      const failures = (failureCounts.get(sessionId) ?? 0) + 1
      failureCounts.set(sessionId, failures)
      logForDebugging(
        `[${label}:token] No OAuth token available for refresh, sessionId=${sessionId} (failure ${failures}/${MAX_REFRESH_FAILURES})`,
        { level: 'error' },
      )
      logForDiagnosticsNoPII('error', 'bridge_token_refresh_no_oauth')
      // 调度重试——令牌可能因短暂缓存清除而暂时不可用，稍后可恢复
      // 超过最大重试次数后停止，避免在真正失败时持续重试
      if (failures < MAX_REFRESH_FAILURES) {
        const retryTimer = setTimeout(
          doRefresh,
          REFRESH_RETRY_DELAY_MS,
          sessionId,
          gen, // 使用相同代次，cancel() 会清除此定时器
        )
        timers.set(sessionId, retryTimer)
      }
      return
    }

    // 获取令牌成功，重置失败计数
    failureCounts.delete(sessionId)

    logForDebugging(
      `[${label}:token] Refreshing token for sessionId=${sessionId}: new token prefix=${oauthToken.slice(0, 15)}…`,
    )
    logEvent('tengu_bridge_token_refreshed', {})
    onRefresh(sessionId, oauthToken) // 通知调用方使用新令牌

    // 调度保底续期——防止长时间运行会话在首次刷新窗口后令牌过期
    // 若不设置此后续定时器，一次性定时器会使会话在首次刷新后无防护
    const timer = setTimeout(
      doRefresh,
      FALLBACK_REFRESH_INTERVAL_MS,
      sessionId,
      gen, // 使用相同代次（cancel() 会使此定时器失效）
    )
    timers.set(sessionId, timer)
    logForDebugging(
      `[${label}:token] Scheduled follow-up refresh for sessionId=${sessionId} in ${formatDuration(FALLBACK_REFRESH_INTERVAL_MS)}`,
    )
  }

  /**
   * 取消指定 sessionId 的刷新定时器。
   *
   * 递增代次使进行中的 doRefresh 放弃后续定时器设置，
   * 然后清除定时器并重置失败计数。
   */
  function cancel(sessionId: string): void {
    // 递增代次，使进行中的 doRefresh 失效（防止孤儿定时器）
    nextGeneration(sessionId)
    const timer = timers.get(sessionId)
    if (timer) {
      clearTimeout(timer)
      timers.delete(sessionId)
    }
    failureCounts.delete(sessionId)
  }

  /**
   * 取消所有会话的刷新定时器。
   *
   * 递增所有 sessionId 的代次，使所有进行中的 doRefresh 失效，
   * 然后清除所有定时器和失败计数。
   */
  function cancelAll(): void {
    // 递增所有代次，使进行中的 doRefresh 调用均失效
    for (const sessionId of generations.keys()) {
      nextGeneration(sessionId)
    }
    for (const timer of timers.values()) {
      clearTimeout(timer)
    }
    timers.clear()
    failureCounts.clear()
  }

  return { schedule, scheduleFromExpiresIn, cancel, cancelAll }
}
