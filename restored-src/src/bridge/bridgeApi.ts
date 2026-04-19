/**
 * bridgeApi.ts — Bridge HTTP API 客户端
 *
 * 在 Claude Code 系统流程中的位置：
 *   CLI/Daemon 启动
 *     └─> bridgeMain.ts（Bridge 主控）
 *           └─> bridgeApi.ts（本文件）——封装所有与 Anthropic 后端的 HTTP 通信
 *                 ├─ 注册/注销 Bridge 环境（Environment）
 *                 ├─ 轮询新工作任务（Work/Session）
 *                 ├─ 确认(ack)、停止(stop)工作任务
 *                 ├─ 发送心跳（heartbeat）保持租约
 *                 └─ 发送权限响应事件（PermissionResponseEvent）
 *
 * 该文件是 Bridge 功能与 Anthropic REST API 之间的唯一 HTTP 通信层，
 * 负责认证头构造、OAuth Token 刷新重试、ID 安全校验及统一的错误处理。
 */
import axios from 'axios'

import { debugBody, extractErrorDetail } from './debugUtils.js'
import {
  BRIDGE_LOGIN_INSTRUCTION,
  type BridgeApiClient,
  type BridgeConfig,
  type PermissionResponseEvent,
  type WorkResponse,
} from './types.js'

/**
 * createBridgeApiClient 的依赖注入参数类型。
 * 将外部可变依赖（Token 获取、调试回调等）与 API 逻辑解耦，
 * 便于在测试中替换实现，也避免引入大量传递依赖模块。
 */
type BridgeApiDeps = {
  /** Anthropic API 的基础 URL，例如 https://api.anthropic.com */
  baseUrl: string
  /** 返回当前有效的 OAuth Access Token，若未登录则返回 undefined */
  getAccessToken: () => string | undefined
  /** 运行器版本号，通过 x-environment-runner-version 请求头上报 */
  runnerVersion: string
  /** 可选的调试日志回调，用于输出 API 请求/响应的诊断信息 */
  onDebug?: (msg: string) => void
  /**
   * Called on 401 to attempt OAuth token refresh. Returns true if refreshed,
   * in which case the request is retried once. Injected because
   * handleOAuth401Error from utils/auth.ts transitively pulls in config.ts →
   * file.ts → permissions/filesystem.ts → sessionStorage.ts → commands.ts
   * (~1300 modules). Daemon callers using env-var tokens omit this — their
   * tokens don't refresh, so 401 goes straight to BridgeFatalError.
   *
   * 收到 401 时调用，尝试刷新 OAuth Token。返回 true 表示刷新成功，
   * 随后请求会重试一次。使用依赖注入是因为直接引入 handleOAuth401Error
   * 会传递引入约 1300 个模块；Daemon 模式使用环境变量 Token，
   * Token 不可刷新，401 直接抛出 BridgeFatalError。
   */
  onAuth401?: (staleAccessToken: string) => Promise<boolean>
  /**
   * Returns the trusted device token to send as X-Trusted-Device-Token on
   * bridge API calls. Bridge sessions have SecurityTier=ELEVATED on the
   * server (CCR v2); when the server's enforcement flag is on,
   * ConnectBridgeWorker requires a trusted device at JWT-issuance.
   * Optional — when absent or returning undefined, the header is omitted
   * and the server falls through to its flag-off/no-op path. The CLI-side
   * gate is tengu_sessions_elevated_auth_enforcement (see trustedDevice.ts).
   *
   * 返回可信设备 Token，通过 X-Trusted-Device-Token 请求头发送。
   * Bridge 会话在服务端使用 SecurityTier=ELEVATED；当服务端强制检查时，
   * ConnectBridgeWorker 要求在 JWT 签发时已绑定可信设备。
   * 可选——若不提供或返回 undefined，则忽略该请求头，服务端走降级路径。
   */
  getTrustedDeviceToken?: () => string | undefined
}

/** anthropic-beta 请求头的值，用于标识所使用的 Environments API 版本 */
const BETA_HEADER = 'environments-2025-11-01'

/** 服务端返回的 ID 在插入 URL 路径段之前，必须匹配此安全白名单正则。 */
const SAFE_ID_PATTERN = /^[a-zA-Z0-9_-]+$/

/**
 * 校验服务端返回的 ID 是否可以安全插入 URL 路径段。
 *
 * 作用：防止路径遍历攻击（如 `../../admin`）以及含斜线、点号或
 * 其他特殊字符的 ID 注入 URL。
 * 若 ID 不合法则抛出错误；合法则原样返回，便于链式调用。
 */
export function validateBridgeId(id: string, label: string): string {
  if (!id || !SAFE_ID_PATTERN.test(id)) {
    // ID 为空或包含不安全字符，拒绝继续执行
    throw new Error(`Invalid ${label}: contains unsafe characters`)
  }
  return id
}

/**
 * Bridge 不可恢复的致命错误类。
 *
 * 用于封装认证失败（401）、权限拒绝（403）、资源不存在（404）、
 * 环境过期（410）等不应重试的 HTTP 错误。
 * 调用方可通过 `err instanceof BridgeFatalError` 区分致命错误与临时错误。
 */
export class BridgeFatalError extends Error {
  /** 触发该错误的 HTTP 状态码 */
  readonly status: number
  /** 服务端返回的错误类型字符串，例如 "environment_expired" */
  readonly errorType: string | undefined
  constructor(message: string, status: number, errorType?: string) {
    super(message)
    this.name = 'BridgeFatalError'
    this.status = status
    this.errorType = errorType
  }
}

/**
 * 创建并返回一个 BridgeApiClient 实例。
 *
 * 整体流程：
 *   1. 通过闭包持有 deps（依赖），对外暴露一组 API 方法；
 *   2. 所有写操作（注册/停止/注销/归档等）使用 withOAuthRetry 包装，
 *      支持 401 时自动刷新 Token 并重试一次；
 *   3. 轮询（pollForWork）直接发起请求，不走 OAuth 刷新（使用 environmentSecret）；
 *   4. 所有请求完成后调用 handleErrorStatus 统一处理非 2xx 状态码。
 */
export function createBridgeApiClient(deps: BridgeApiDeps): BridgeApiClient {
  /** 内部调试日志辅助函数，若未注入 onDebug 则为空操作 */
  function debug(msg: string): void {
    deps.onDebug?.(msg)
  }

  /** 连续空轮询计数器，用于控制日志输出频率，避免刷屏 */
  let consecutiveEmptyPolls = 0
  /** 每隔多少次空轮询才输出一条日志 */
  const EMPTY_POLL_LOG_INTERVAL = 100

  /**
   * 构造请求头对象。
   *
   * 包含：
   *   - Authorization: Bearer Token（OAuth Access Token 或 environmentSecret）
   *   - Content-Type / anthropic-version / anthropic-beta：API 协议头
   *   - x-environment-runner-version：上报本地运行器版本
   *   - X-Trusted-Device-Token（可选）：可信设备 Token，用于 ELEVATED 安全级别
   */
  function getHeaders(accessToken: string): Record<string, string> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
      'anthropic-beta': BETA_HEADER,
      'x-environment-runner-version': deps.runnerVersion,
    }
    // 若有可信设备 Token，则附加到请求头
    const deviceToken = deps.getTrustedDeviceToken?.()
    if (deviceToken) {
      headers['X-Trusted-Device-Token'] = deviceToken
    }
    return headers
  }

  /**
   * 获取当前 Access Token，若未登录则抛出提示用户登录的错误。
   */
  function resolveAuth(): string {
    const accessToken = deps.getAccessToken()
    if (!accessToken) {
      // 未登录，抛出登录指引错误
      throw new Error(BRIDGE_LOGIN_INSTRUCTION)
    }
    return accessToken
  }

  /**
   * 用 OAuth Token 执行请求，并在收到 401 时尝试自动刷新后重试一次。
   *
   * 流程：
   *   1. 调用 resolveAuth() 获取当前 Token，执行 fn(token)；
   *   2. 若响应不是 401，直接返回；
   *   3. 若没有 onAuth401 处理器（Daemon 模式），直接返回 401 供上层抛出致命错误；
   *   4. 调用 onAuth401 尝试刷新 Token：
   *      - 刷新成功：用新 Token 重试请求一次，非 401 则返回；
   *      - 重试仍为 401 或刷新失败：返回 401 响应，由 handleErrorStatus 抛出 BridgeFatalError。
   *
   * 与 withRetry.ts 中处理 v1/messages 的模式保持一致。
   */
  async function withOAuthRetry<T>(
    fn: (accessToken: string) => Promise<{ status: number; data: T }>,
    context: string,
  ): Promise<{ status: number; data: T }> {
    const accessToken = resolveAuth()
    const response = await fn(accessToken)

    // 非 401，直接返回成功或其他错误响应
    if (response.status !== 401) {
      return response
    }

    // 没有 Token 刷新处理器（Daemon 模式），直接返回 401
    if (!deps.onAuth401) {
      debug(`[bridge:api] ${context}: 401 received, no refresh handler`)
      return response
    }

    // Attempt token refresh — matches the pattern in withRetry.ts
    // 尝试刷新 Token，与 withRetry.ts 中的模式保持一致
    debug(`[bridge:api] ${context}: 401 received, attempting token refresh`)
    const refreshed = await deps.onAuth401(accessToken)
    if (refreshed) {
      debug(`[bridge:api] ${context}: Token refreshed, retrying request`)
      const newToken = resolveAuth() // 获取刷新后的新 Token
      const retryResponse = await fn(newToken) // 用新 Token 重试请求
      if (retryResponse.status !== 401) {
        return retryResponse // 重试成功，返回结果
      }
      debug(`[bridge:api] ${context}: Retry after refresh also got 401`)
    } else {
      debug(`[bridge:api] ${context}: Token refresh failed`)
    }

    // Refresh failed — return 401 for handleErrorStatus to throw
    // 刷新失败，返回 401 响应，由 handleErrorStatus 抛出 BridgeFatalError
    return response
  }

  return {
    /**
     * 向 Anthropic 后端注册一个 Bridge 环境（Environment）。
     *
     * 流程：
     *   1. 发送 POST /v1/environments/bridge，携带机器名、工作目录、分支、
     *      Git 仓库 URL、最大会话数、worker 类型等信息；
     *   2. 若配置了 reuseEnvironmentId（--session-id 续连模式），
     *      则附带旧环境 ID，服务端会尝试复用而非新建；
     *   3. 返回 { environment_id, environment_secret }，
     *      后续轮询和心跳使用这两个值进行认证。
     *
     * 认证：使用 OAuth Access Token（withOAuthRetry 包装，支持自动刷新）。
     */
    async registerBridgeEnvironment(
      config: BridgeConfig,
    ): Promise<{ environment_id: string; environment_secret: string }> {
      debug(
        `[bridge:api] POST /v1/environments/bridge bridgeId=${config.bridgeId}`,
      )

      const response = await withOAuthRetry(
        (token: string) =>
          axios.post<{
            environment_id: string
            environment_secret: string
          }>(
            `${deps.baseUrl}/v1/environments/bridge`,
            {
              machine_name: config.machineName,
              directory: config.dir,
              branch: config.branch,
              git_repo_url: config.gitRepoUrl,
              // Advertise session capacity so claude.ai/code can show
              // "2/4 sessions" badges and only block the picker when
              // actually at capacity. Backends that don't yet accept
              // this field will silently ignore it.
              // 上报最大并发会话数，供 claude.ai 显示 "2/4 sessions" 徽章
              max_sessions: config.maxSessions,
              // worker_type lets claude.ai filter environments by origin
              // (e.g. assistant picker only shows assistant-mode workers).
              // Desktop cowork app sends "cowork"; we send a distinct value.
              // worker_type 用于 claude.ai 按来源过滤环境（如只显示 assistant 模式的 worker）
              metadata: { worker_type: config.workerType },
              // Idempotent re-registration: if we have a backend-issued
              // environment_id from a prior session (--session-id resume),
              // send it back so the backend reattaches instead of creating
              // a new env. The backend may still hand back a fresh ID if
              // the old one expired — callers must compare the response.
              // 幂等重注册：若有上次会话的 environment_id（--session-id 续连），
              // 则回传给服务端，服务端会尝试复用旧环境而非新建
              ...(config.reuseEnvironmentId && {
                environment_id: config.reuseEnvironmentId,
              }),
            },
            {
              headers: getHeaders(token),
              timeout: 15_000, // 注册操作超时 15 秒
              validateStatus: status => status < 500, // 允许 4xx 状态码通过，由 handleErrorStatus 处理
            },
          ),
        'Registration',
      )

      handleErrorStatus(response.status, response.data, 'Registration')
      debug(
        `[bridge:api] POST /v1/environments/bridge -> ${response.status} environment_id=${response.data.environment_id}`,
      )
      debug(
        `[bridge:api] >>> ${debugBody({ machine_name: config.machineName, directory: config.dir, branch: config.branch, git_repo_url: config.gitRepoUrl, max_sessions: config.maxSessions, metadata: { worker_type: config.workerType } })}`,
      )
      debug(`[bridge:api] <<< ${debugBody(response.data)}`)
      return response.data
    },

    /**
     * 轮询服务端是否有新的工作任务（Work/Session）待处理。
     *
     * 流程：
     *   1. 发送 GET /v1/environments/{environmentId}/work/poll；
     *   2. 使用 environmentSecret 作为 Bearer Token（非 OAuth Token）；
     *   3. 若返回空体或 null，表示当前没有待处理任务；
     *   4. 连续空轮询时使用计数器控制日志频率（首次 + 每 100 次输出一次）；
     *   5. 支持 AbortSignal 取消和 reclaimOlderThanMs 参数（回收超时的旧任务）。
     *
     * 注意：此方法不走 withOAuthRetry，因为它使用 environmentSecret 认证，
     * 该 Token 不支持 OAuth 刷新流程。
     */
    async pollForWork(
      environmentId: string,
      environmentSecret: string,
      signal?: AbortSignal,
      reclaimOlderThanMs?: number,
    ): Promise<WorkResponse | null> {
      validateBridgeId(environmentId, 'environmentId')

      // Save and reset so errors break the "consecutive empty" streak.
      // Restored below when the response is truly empty.
      // 保存并重置连续空轮询计数，错误响应不应累计到空轮询计数中
      const prevEmptyPolls = consecutiveEmptyPolls
      consecutiveEmptyPolls = 0

      const response = await axios.get<WorkResponse | null>(
        `${deps.baseUrl}/v1/environments/${environmentId}/work/poll`,
        {
          headers: getHeaders(environmentSecret), // 使用 environmentSecret 认证
          params:
            reclaimOlderThanMs !== undefined
              ? { reclaim_older_than_ms: reclaimOlderThanMs } // 回收超过指定时间的旧任务
              : undefined,
          timeout: 10_000, // 轮询超时 10 秒
          signal, // 支持 AbortSignal 取消轮询
          validateStatus: status => status < 500,
        },
      )

      handleErrorStatus(response.status, response.data, 'Poll')

      // Empty body or null = no work available
      // 返回空体或 null 表示当前没有待处理任务
      if (!response.data) {
        consecutiveEmptyPolls = prevEmptyPolls + 1 // 恢复并递增空轮询计数
        if (
          consecutiveEmptyPolls === 1 ||
          consecutiveEmptyPolls % EMPTY_POLL_LOG_INTERVAL === 0
        ) {
          // 首次或每 100 次空轮询才输出一条日志，避免日志刷屏
          debug(
            `[bridge:api] GET .../work/poll -> ${response.status} (no work, ${consecutiveEmptyPolls} consecutive empty polls)`,
          )
        }
        return null
      }

      // 有新任务，记录任务 ID、类型和会话 ID
      debug(
        `[bridge:api] GET .../work/poll -> ${response.status} workId=${response.data.id} type=${response.data.data?.type}${response.data.data?.id ? ` sessionId=${response.data.data.id}` : ''}`,
      )
      debug(`[bridge:api] <<< ${debugBody(response.data)}`)
      return response.data
    },

    /**
     * 确认（Acknowledge）已接收到一个工作任务，防止服务端重复分发。
     *
     * 流程：
     *   1. 校验 environmentId 和 workId 的安全性；
     *   2. 发送 POST /v1/environments/{environmentId}/work/{workId}/ack；
     *   3. 使用 sessionToken 认证（由服务端在分发任务时提供）。
     *
     * 在 pollForWork 返回任务后、实际处理任务之前应立即调用此方法。
     */
    async acknowledgeWork(
      environmentId: string,
      workId: string,
      sessionToken: string,
    ): Promise<void> {
      validateBridgeId(environmentId, 'environmentId')
      validateBridgeId(workId, 'workId')

      debug(`[bridge:api] POST .../work/${workId}/ack`)

      const response = await axios.post(
        `${deps.baseUrl}/v1/environments/${environmentId}/work/${workId}/ack`,
        {},
        {
          headers: getHeaders(sessionToken), // 使用任务绑定的 sessionToken 认证
          timeout: 10_000,
          validateStatus: s => s < 500,
        },
      )

      handleErrorStatus(response.status, response.data, 'Acknowledge')
      debug(`[bridge:api] POST .../work/${workId}/ack -> ${response.status}`)
    },

    /**
     * 停止（Stop）一个正在处理的工作任务。
     *
     * 流程：
     *   1. 校验 environmentId 和 workId；
     *   2. 发送 POST /v1/environments/{environmentId}/work/{workId}/stop；
     *   3. force=true 时强制停止（不等待优雅退出）；
     *   4. 使用 OAuth Token（withOAuthRetry 包装，支持自动刷新）。
     *
     * 通常在用户取消任务或会话超时时调用。
     */
    async stopWork(
      environmentId: string,
      workId: string,
      force: boolean,
    ): Promise<void> {
      validateBridgeId(environmentId, 'environmentId')
      validateBridgeId(workId, 'workId')

      debug(`[bridge:api] POST .../work/${workId}/stop force=${force}`)

      const response = await withOAuthRetry(
        (token: string) =>
          axios.post(
            `${deps.baseUrl}/v1/environments/${environmentId}/work/${workId}/stop`,
            { force }, // force=true 表示强制停止，不等待优雅关闭
            {
              headers: getHeaders(token),
              timeout: 10_000,
              validateStatus: s => s < 500,
            },
          ),
        'StopWork',
      )

      handleErrorStatus(response.status, response.data, 'StopWork')
      debug(`[bridge:api] POST .../work/${workId}/stop -> ${response.status}`)
    },

    /**
     * 注销（Deregister）一个 Bridge 环境，通知服务端该环境已关闭。
     *
     * 流程：
     *   1. 校验 environmentId；
     *   2. 发送 DELETE /v1/environments/bridge/{environmentId}；
     *   3. 使用 OAuth Token（withOAuthRetry 包装）。
     *
     * 在 Bridge 正常退出（graceful shutdown）时调用，确保服务端
     * 及时将该环境标记为离线，避免用户在 claude.ai 上看到僵尸环境。
     */
    async deregisterEnvironment(environmentId: string): Promise<void> {
      validateBridgeId(environmentId, 'environmentId')

      debug(`[bridge:api] DELETE /v1/environments/bridge/${environmentId}`)

      const response = await withOAuthRetry(
        (token: string) =>
          axios.delete(
            `${deps.baseUrl}/v1/environments/bridge/${environmentId}`,
            {
              headers: getHeaders(token),
              timeout: 10_000,
              validateStatus: s => s < 500,
            },
          ),
        'Deregister',
      )

      handleErrorStatus(response.status, response.data, 'Deregister')
      debug(
        `[bridge:api] DELETE /v1/environments/bridge/${environmentId} -> ${response.status}`,
      )
    },

    /**
     * 归档（Archive）一个已完成的会话。
     *
     * 流程：
     *   1. 校验 sessionId；
     *   2. 发送 POST /v1/sessions/{sessionId}/archive；
     *   3. 409 Conflict 表示已经归档（幂等操作），视为成功，不抛错；
     *   4. 使用 OAuth Token（withOAuthRetry 包装）。
     *
     * 会话完成（无论成功或失败）后调用，用于释放服务端资源并
     * 使会话在 claude.ai 上显示为"已完成"状态。
     */
    async archiveSession(sessionId: string): Promise<void> {
      validateBridgeId(sessionId, 'sessionId')

      debug(`[bridge:api] POST /v1/sessions/${sessionId}/archive`)

      const response = await withOAuthRetry(
        (token: string) =>
          axios.post(
            `${deps.baseUrl}/v1/sessions/${sessionId}/archive`,
            {},
            {
              headers: getHeaders(token),
              timeout: 10_000,
              validateStatus: s => s < 500,
            },
          ),
        'ArchiveSession',
      )

      // 409 = already archived (idempotent, not an error)
      // 409 表示该会话已被归档，属于幂等操作，不视为错误
      if (response.status === 409) {
        debug(
          `[bridge:api] POST /v1/sessions/${sessionId}/archive -> 409 (already archived)`,
        )
        return
      }

      handleErrorStatus(response.status, response.data, 'ArchiveSession')
      debug(
        `[bridge:api] POST /v1/sessions/${sessionId}/archive -> ${response.status}`,
      )
    },

    /**
     * 重连（Reconnect）一个已存在的会话到当前环境。
     *
     * 流程：
     *   1. 校验 environmentId 和 sessionId；
     *   2. 发送 POST /v1/environments/{environmentId}/bridge/reconnect，
     *      携带 session_id；
     *   3. 使用 OAuth Token（withOAuthRetry 包装）。
     *
     * 用于在 Bridge 重启（如网络断线重连、进程重启）后，
     * 将已有会话重新绑定到当前环境，恢复中断的工作流程。
     */
    async reconnectSession(
      environmentId: string,
      sessionId: string,
    ): Promise<void> {
      validateBridgeId(environmentId, 'environmentId')
      validateBridgeId(sessionId, 'sessionId')

      debug(
        `[bridge:api] POST /v1/environments/${environmentId}/bridge/reconnect session_id=${sessionId}`,
      )

      const response = await withOAuthRetry(
        (token: string) =>
          axios.post(
            `${deps.baseUrl}/v1/environments/${environmentId}/bridge/reconnect`,
            { session_id: sessionId }, // 需要重连的会话 ID
            {
              headers: getHeaders(token),
              timeout: 10_000,
              validateStatus: s => s < 500,
            },
          ),
        'ReconnectSession',
      )

      handleErrorStatus(response.status, response.data, 'ReconnectSession')
      debug(`[bridge:api] POST .../bridge/reconnect -> ${response.status}`)
    },

    /**
     * 发送心跳（Heartbeat）以延长工作任务的租约（Lease）。
     *
     * 流程：
     *   1. 校验 environmentId 和 workId；
     *   2. 发送 POST /v1/environments/{environmentId}/work/{workId}/heartbeat；
     *   3. 使用 sessionToken 认证；
     *   4. 返回 { lease_extended, state } 供调用方判断任务是否仍有效。
     *
     * Bridge 在处理长时间运行的任务时，需定期调用此方法，
     * 否则服务端会认为 worker 已失联，进而回收该工作任务分配给其他 worker。
     */
    async heartbeatWork(
      environmentId: string,
      workId: string,
      sessionToken: string,
    ): Promise<{ lease_extended: boolean; state: string }> {
      validateBridgeId(environmentId, 'environmentId')
      validateBridgeId(workId, 'workId')

      debug(`[bridge:api] POST .../work/${workId}/heartbeat`)

      const response = await axios.post<{
        lease_extended: boolean  // 租约是否成功延长
        state: string            // 当前工作任务状态
        last_heartbeat: string   // 上次心跳时间戳
        ttl_seconds: number      // 租约剩余有效秒数
      }>(
        `${deps.baseUrl}/v1/environments/${environmentId}/work/${workId}/heartbeat`,
        {},
        {
          headers: getHeaders(sessionToken), // 使用任务绑定的 sessionToken 认证
          timeout: 10_000,
          validateStatus: s => s < 500,
        },
      )

      handleErrorStatus(response.status, response.data, 'Heartbeat')
      debug(
        `[bridge:api] POST .../work/${workId}/heartbeat -> ${response.status} lease_extended=${response.data.lease_extended} state=${response.data.state}`,
      )
      return response.data
    },

    /**
     * 向服务端发送权限响应事件（PermissionResponseEvent）。
     *
     * 流程：
     *   1. 校验 sessionId；
     *   2. 发送 POST /v1/sessions/{sessionId}/events，
     *      事件数组中包含单条 PermissionResponseEvent；
     *   3. 使用 sessionToken 认证。
     *
     * 当用户在 claude.ai 上点击"允许/拒绝"权限弹窗时，
     * 服务端会将该决策通过此接口回传给本地 CLI，
     * CLI 据此决定是否继续执行需要该权限的操作。
     */
    async sendPermissionResponseEvent(
      sessionId: string,
      event: PermissionResponseEvent,
      sessionToken: string,
    ): Promise<void> {
      validateBridgeId(sessionId, 'sessionId')

      debug(
        `[bridge:api] POST /v1/sessions/${sessionId}/events type=${event.type}`,
      )

      const response = await axios.post(
        `${deps.baseUrl}/v1/sessions/${sessionId}/events`,
        { events: [event] }, // 以数组形式发送事件，便于后续批量扩展
        {
          headers: getHeaders(sessionToken),
          timeout: 10_000,
          validateStatus: s => s < 500,
        },
      )

      handleErrorStatus(
        response.status,
        response.data,
        'SendPermissionResponseEvent',
      )
      debug(
        `[bridge:api] POST /v1/sessions/${sessionId}/events -> ${response.status}`,
      )
      debug(`[bridge:api] >>> ${debugBody({ events: [event] })}`)
      debug(`[bridge:api] <<< ${debugBody(response.data)}`)
    },
  }
}

/**
 * 统一处理 HTTP 响应状态码，对非成功状态抛出对应错误。
 *
 * 处理逻辑：
 *   - 200 / 204：正常，直接返回
 *   - 401：认证失败，抛出 BridgeFatalError（不可重试）
 *   - 403：权限拒绝，抛出 BridgeFatalError（过期类型有专属消息）
 *   - 404：资源不存在，抛出 BridgeFatalError
 *   - 410：资源已过期（环境/会话过期），抛出 BridgeFatalError
 *   - 429：限流，抛出普通 Error（可重试）
 *   - 其他：抛出带状态码的通用 Error
 */
function handleErrorStatus(
  status: number,
  data: unknown,
  context: string,
): void {
  if (status === 200 || status === 204) {
    return // 成功状态码，无需处理
  }
  const detail = extractErrorDetail(data)         // 从响应体中提取错误详情文本
  const errorType = extractErrorTypeFromData(data) // 从响应体中提取错误类型字符串
  switch (status) {
    case 401:
      // 认证失败：Token 无效或已过期，不可重试，提示用户重新登录
      throw new BridgeFatalError(
        `${context}: Authentication failed (401)${detail ? `: ${detail}` : ''}. ${BRIDGE_LOGIN_INSTRUCTION}`,
        401,
        errorType,
      )
    case 403:
      // 权限拒绝：若错误类型为"已过期"，显示会话过期消息；否则显示权限不足消息
      throw new BridgeFatalError(
        isExpiredErrorType(errorType)
          ? 'Remote Control session has expired. Please restart with `claude remote-control` or /remote-control.'
          : `${context}: Access denied (403)${detail ? `: ${detail}` : ''}. Check your organization permissions.`,
        403,
        errorType,
      )
    case 404:
      // 资源不存在：环境或任务 ID 无效，或该组织未开启 Remote Control 功能
      throw new BridgeFatalError(
        detail ??
          `${context}: Not found (404). Remote Control may not be available for this organization.`,
        404,
        errorType,
      )
    case 410:
      // 资源已过期（Gone）：环境或会话已超出生命周期，需要重启
      throw new BridgeFatalError(
        detail ??
          'Remote Control session has expired. Please restart with `claude remote-control` or /remote-control.',
        410,
        errorType ?? 'environment_expired', // 默认 errorType 为 environment_expired
      )
    case 429:
      // 触发限流，轮询频率过高，抛出普通 Error（可由上层决定是否退避重试）
      throw new Error(`${context}: Rate limited (429). Polling too frequently.`)
    default:
      // 其他未预期的错误状态码
      throw new Error(
        `${context}: Failed with status ${status}${detail ? `: ${detail}` : ''}`,
      )
  }
}

/**
 * 判断错误类型字符串是否表示会话/环境已过期。
 *
 * 服务端错误类型中包含 "expired" 或 "lifetime" 关键字时，
 * 认为是过期类错误，handleErrorStatus 会为其显示专属的重启提示。
 */
export function isExpiredErrorType(errorType: string | undefined): boolean {
  if (!errorType) {
    return false
  }
  return errorType.includes('expired') || errorType.includes('lifetime')
}

/**
 * 判断一个 BridgeFatalError 是否属于可抑制的 403 权限错误。
 *
 * 某些 403 错误（如缺少 external_poll_sessions 或 environments:manage 权限）
 * 不影响核心功能，不应向用户展示，调用方可据此决定是否静默忽略。
 */
export function isSuppressible403(err: BridgeFatalError): boolean {
  if (err.status !== 403) {
    return false
  }
  return (
    err.message.includes('external_poll_sessions') ||
    err.message.includes('environments:manage')
  )
}

/**
 * 从服务端响应数据中提取 error.type 字段的值。
 *
 * 服务端错误响应通常格式为：{ error: { type: "...", message: "..." } }
 * 若无法提取，返回 undefined。
 */
function extractErrorTypeFromData(data: unknown): string | undefined {
  if (data && typeof data === 'object') {
    if (
      'error' in data &&
      data.error &&
      typeof data.error === 'object' &&
      'type' in data.error &&
      typeof data.error.type === 'string'
    ) {
      return data.error.type // 返回服务端错误类型字符串
    }
  }
  return undefined
}
