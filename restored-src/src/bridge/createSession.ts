/**
 * createSession.ts — Bridge 会话生命周期管理（创建/查询/归档/重命名）
 *
 * 在 Claude Code 系统流程中的位置：
 *   Bridge 会话管理层（bridgeMain.ts / replBridge.ts / bridge 斜线命令）
 *     └─> createSession.ts（本文件）——封装 POST/GET/PATCH/Archive 等 CCR 会话 HTTP API
 *
 * 背景：
 *   Bridge 模式（Remote Control）需要在后端创建"会话"供 claude.ai 用户连接。
 *   本文件提供四个生命周期函数：
 *   - createBridgeSession：创建新会话（POST /v1/sessions），支持历史事件预加载和 Git 上下文
 *   - getBridgeSession：查询会话信息（GET /v1/sessions/{id}），用于 --session-id 恢复
 *   - archiveBridgeSession：归档会话（POST /v1/sessions/{id}/archive），关闭时释放资源
 *   - updateBridgeSessionTitle：更新会话标题（PATCH /v1/sessions/{id}），/rename 命令同步
 *
 * 注意：所有函数均使用动态 import（延迟加载）以避免在 Bridge 未启用时拉取重型依赖树。
 * 鉴权使用 OAuth Bearer Token + org UUID + ccr-byoc-2025-07-29 beta 头。
 */
import type { SDKMessage } from '../entrypoints/agentSdkTypes.js'
import { logForDebugging } from '../utils/debug.js'
import { errorMessage } from '../utils/errors.js'
import { extractErrorDetail } from './debugUtils.js'
import { toCompatSessionId } from './sessionIdCompat.js'

/** Git 仓库来源（用于会话上下文 sources 字段） */
type GitSource = {
  type: 'git_repository'
  url: string
  revision?: string
}

/** Git 仓库输出上下文（用于会话上下文 outcomes 字段，包含目标分支） */
type GitOutcome = {
  type: 'git_repository'
  git_info: { type: 'github'; repo: string; branches: string[] }
}

// 事件必须包装为 { type: 'event', data: <sdk_message> } 格式发送给 POST /v1/sessions
// （判别联合格式，后端区分事件和其他类型的消息）
type SessionEvent = {
  type: 'event'
  data: SDKMessage
}

/**
 * 在 Bridge 环境中创建新会话（POST /v1/sessions）。
 *
 * 使用场景：
 *   - `claude remote-control`：创建空会话，用户立即可输入
 *   - `/remote-control` 斜线命令：创建预填充对话历史的会话
 *
 * 构建流程：
 *   1. 获取 accessToken 和 orgUUID（鉴权前置）
 *   2. 解析 gitRepoUrl → 构建 gitSource（Git 来源） + gitOutcome（目标分支）
 *   3. 拼装请求体（title / events / session_context / environment_id）
 *   4. POST 请求，提取响应中的 session ID
 *
 * 成功返回 session ID（字符串），失败返回 null（非致命错误，调用方决策重试）。
 */
export async function createBridgeSession({
  environmentId,
  title,
  events,
  gitRepoUrl,
  branch,
  signal,
  baseUrl: baseUrlOverride,
  getAccessToken,
  permissionMode,
}: {
  environmentId: string
  title?: string
  events: SessionEvent[]
  gitRepoUrl: string | null
  branch: string
  signal: AbortSignal
  baseUrl?: string
  getAccessToken?: () => string | undefined
  permissionMode?: string
}): Promise<string | null> {
  // 延迟导入：避免在 Bridge 未启用时加载鉴权/仓库检测等重型模块
  const { getClaudeAIOAuthTokens } = await import('../utils/auth.js')
  const { getOrganizationUUID } = await import('../services/oauth/client.js')
  const { getOauthConfig } = await import('../constants/oauth.js')
  const { getOAuthHeaders } = await import('../utils/teleport/api.js')
  const { parseGitHubRepository } = await import('../utils/detectRepository.js')
  const { getDefaultBranch } = await import('../utils/git.js')
  const { getMainLoopModel } = await import('../utils/model/model.js')
  const { default: axios } = await import('axios')

  // 获取访问令牌（调用方注入 > 环境缓存）
  const accessToken =
    getAccessToken?.() ?? getClaudeAIOAuthTokens()?.accessToken
  if (!accessToken) {
    logForDebugging('[bridge] No access token for session creation')
    return null
  }

  // 获取组织 UUID（必须，用于 x-organization-uuid 请求头）
  const orgUUID = await getOrganizationUUID()
  if (!orgUUID) {
    logForDebugging('[bridge] No org UUID for session creation')
    return null
  }

  // 构建 Git 来源和输出上下文（提供给后端用于代码提交流程）
  let gitSource: GitSource | null = null
  let gitOutcome: GitOutcome | null = null

  if (gitRepoUrl) {
    const { parseGitRemote } = await import('../utils/detectRepository.js')
    const parsed = parseGitRemote(gitRepoUrl)
    if (parsed) {
      const { host, owner, name } = parsed
      const revision = branch || (await getDefaultBranch()) || undefined
      gitSource = {
        type: 'git_repository',
        url: `https://${host}/${owner}/${name}`,
        revision,
      }
      gitOutcome = {
        type: 'git_repository',
        git_info: {
          type: 'github',
          repo: `${owner}/${name}`,
          branches: [`claude/${branch || 'task'}`], // 目标分支名（claude/ 前缀）
        },
      }
    } else {
      // 回退：尝试 parseGitHubRepository 解析 owner/repo 格式
      const ownerRepo = parseGitHubRepository(gitRepoUrl)
      if (ownerRepo) {
        const [owner, name] = ownerRepo.split('/')
        if (owner && name) {
          const revision = branch || (await getDefaultBranch()) || undefined
          gitSource = {
            type: 'git_repository',
            url: `https://github.com/${owner}/${name}`,
            revision,
          }
          gitOutcome = {
            type: 'git_repository',
            git_info: {
              type: 'github',
              repo: `${owner}/${name}`,
              branches: [`claude/${branch || 'task'}`],
            },
          }
        }
      }
    }
  }

  const requestBody = {
    ...(title !== undefined && { title }),                    // 可选：会话标题
    events,                                                    // 预加载的历史事件
    session_context: {
      sources: gitSource ? [gitSource] : [],                 // Git 来源上下文
      outcomes: gitOutcome ? [gitOutcome] : [],              // Git 输出上下文
      model: getMainLoopModel(),                             // 使用的模型标识
    },
    environment_id: environmentId,                           // Bridge 环境 ID
    source: 'remote-control',                               // 来源标识
    ...(permissionMode && { permission_mode: permissionMode }), // 可选：权限模式
  }

  const headers = {
    ...getOAuthHeaders(accessToken),
    'anthropic-beta': 'ccr-byoc-2025-07-29', // BYOC（自带凭证）beta 标识
    'x-organization-uuid': orgUUID,
  }

  const url = `${baseUrlOverride ?? getOauthConfig().BASE_API_URL}/v1/sessions`
  let response
  try {
    response = await axios.post(url, requestBody, {
      headers,
      signal,                        // 支持 AbortSignal 取消请求
      validateStatus: s => s < 500,  // 4xx 由状态码检查处理，不作为 axios 错误
    })
  } catch (err: unknown) {
    logForDebugging(
      `[bridge] Session creation request failed: ${errorMessage(err)}`,
    )
    return null
  }
  const isSuccess = response.status === 200 || response.status === 201

  if (!isSuccess) {
    const detail = extractErrorDetail(response.data)
    logForDebugging(
      `[bridge] Session creation failed with status ${response.status}${detail ? `: ${detail}` : ''}`,
    )
    return null
  }

  // 严格验证响应体中的 session ID
  const sessionData: unknown = response.data
  if (
    !sessionData ||
    typeof sessionData !== 'object' ||
    !('id' in sessionData) ||
    typeof sessionData.id !== 'string'
  ) {
    logForDebugging('[bridge] No session ID in response')
    return null
  }

  return sessionData.id
}

/**
 * 查询 Bridge 会话信息（GET /v1/sessions/{id}）。
 *
 * 返回会话的 environment_id（用于 --session-id 恢复流程）和 title。
 * 注意：此处使用 org 级 headers（含 ccr-byoc beta 头 + orgUUID），
 * 而 bridgeApi.ts 中的环境级客户端使用不同的 beta 头且无 orgUUID，
 * 使用环境级头会导致 Sessions API 返回 404。
 */
export async function getBridgeSession(
  sessionId: string,
  opts?: { baseUrl?: string; getAccessToken?: () => string | undefined },
): Promise<{ environment_id?: string; title?: string } | null> {
  const { getClaudeAIOAuthTokens } = await import('../utils/auth.js')
  const { getOrganizationUUID } = await import('../services/oauth/client.js')
  const { getOauthConfig } = await import('../constants/oauth.js')
  const { getOAuthHeaders } = await import('../utils/teleport/api.js')
  const { default: axios } = await import('axios')

  const accessToken =
    opts?.getAccessToken?.() ?? getClaudeAIOAuthTokens()?.accessToken
  if (!accessToken) {
    logForDebugging('[bridge] No access token for session fetch')
    return null
  }

  const orgUUID = await getOrganizationUUID()
  if (!orgUUID) {
    logForDebugging('[bridge] No org UUID for session fetch')
    return null
  }

  const headers = {
    ...getOAuthHeaders(accessToken),
    'anthropic-beta': 'ccr-byoc-2025-07-29',
    'x-organization-uuid': orgUUID,
  }

  const url = `${opts?.baseUrl ?? getOauthConfig().BASE_API_URL}/v1/sessions/${sessionId}`
  logForDebugging(`[bridge] Fetching session ${sessionId}`)

  let response
  try {
    response = await axios.get<{ environment_id?: string; title?: string }>(
      url,
      { headers, timeout: 10_000, validateStatus: s => s < 500 },
    )
  } catch (err: unknown) {
    logForDebugging(
      `[bridge] Session fetch request failed: ${errorMessage(err)}`,
    )
    return null
  }

  if (response.status !== 200) {
    const detail = extractErrorDetail(response.data)
    logForDebugging(
      `[bridge] Session fetch failed with status ${response.status}${detail ? `: ${detail}` : ''}`,
    )
    return null
  }

  return response.data
}

/**
 * 归档 Bridge 会话（POST /v1/sessions/{id}/archive）。
 *
 * CCR 服务器不会自动归档会话——归档始终是客户端显式发起的操作。
 * `claude remote-control`（独立 bridge）和 `/remote-control` REPL bridge
 * 均会在关闭时调用此函数归档存活的会话。
 *
 * 端点接受任意状态（running/idle/requires_action/pending）的会话，
 * 若会话已归档则返回 409——因此幂等调用是安全的。
 *
 * 注意：此函数不含 try/catch，5xx/超时/网络错误会直接抛出。
 * 归档是尽力而为（best-effort）的清理操作，调用方应用 .catch() 包裹。
 */
export async function archiveBridgeSession(
  sessionId: string,
  opts?: {
    baseUrl?: string
    getAccessToken?: () => string | undefined
    timeoutMs?: number
  },
): Promise<void> {
  const { getClaudeAIOAuthTokens } = await import('../utils/auth.js')
  const { getOrganizationUUID } = await import('../services/oauth/client.js')
  const { getOauthConfig } = await import('../constants/oauth.js')
  const { getOAuthHeaders } = await import('../utils/teleport/api.js')
  const { default: axios } = await import('axios')

  const accessToken =
    opts?.getAccessToken?.() ?? getClaudeAIOAuthTokens()?.accessToken
  if (!accessToken) {
    logForDebugging('[bridge] No access token for session archive')
    return
  }

  const orgUUID = await getOrganizationUUID()
  if (!orgUUID) {
    logForDebugging('[bridge] No org UUID for session archive')
    return
  }

  const headers = {
    ...getOAuthHeaders(accessToken),
    'anthropic-beta': 'ccr-byoc-2025-07-29',
    'x-organization-uuid': orgUUID,
  }

  const url = `${opts?.baseUrl ?? getOauthConfig().BASE_API_URL}/v1/sessions/${sessionId}/archive`
  logForDebugging(`[bridge] Archiving session ${sessionId}`)

  // 注意：此处不捕获异常，由调用方的 .catch() 处理（归档是 best-effort 操作）
  const response = await axios.post(
    url,
    {},
    {
      headers,
      timeout: opts?.timeoutMs ?? 10_000,
      validateStatus: s => s < 500,
    },
  )

  if (response.status === 200) {
    logForDebugging(`[bridge] Session ${sessionId} archived successfully`)
  } else {
    const detail = extractErrorDetail(response.data)
    logForDebugging(
      `[bridge] Session archive failed with status ${response.status}${detail ? `: ${detail}` : ''}`,
    )
  }
}

/**
 * 更新 Bridge 会话标题（PATCH /v1/sessions/{id}）。
 *
 * 当用户通过 /rename 命令重命名会话时调用，使 claude.ai/code 上的
 * 会话标题与本地保持同步。
 *
 * 注意：兼容网关只接受 session_* 格式的 ID（compat/convert.go:27）；
 * v2 调用方可能传入 cse_* 格式，此处通过 toCompatSessionId 转换。
 * 错误被静默吞掉——标题同步是尽力而为的操作。
 */
export async function updateBridgeSessionTitle(
  sessionId: string,
  title: string,
  opts?: { baseUrl?: string; getAccessToken?: () => string | undefined },
): Promise<void> {
  const { getClaudeAIOAuthTokens } = await import('../utils/auth.js')
  const { getOrganizationUUID } = await import('../services/oauth/client.js')
  const { getOauthConfig } = await import('../constants/oauth.js')
  const { getOAuthHeaders } = await import('../utils/teleport/api.js')
  const { default: axios } = await import('axios')

  const accessToken =
    opts?.getAccessToken?.() ?? getClaudeAIOAuthTokens()?.accessToken
  if (!accessToken) {
    logForDebugging('[bridge] No access token for session title update')
    return
  }

  const orgUUID = await getOrganizationUUID()
  if (!orgUUID) {
    logForDebugging('[bridge] No org UUID for session title update')
    return
  }

  const headers = {
    ...getOAuthHeaders(accessToken),
    'anthropic-beta': 'ccr-byoc-2025-07-29',
    'x-organization-uuid': orgUUID,
  }

  // 兼容网关只接受 session_* 前缀；toCompatSessionId 对 v1 的 session_* 和
  // bridgeMain 已转换的 compatSessionId 均幂等（不改变）
  const compatId = toCompatSessionId(sessionId)
  const url = `${opts?.baseUrl ?? getOauthConfig().BASE_API_URL}/v1/sessions/${compatId}`
  logForDebugging(`[bridge] Updating session title: ${compatId} → ${title}`)

  try {
    const response = await axios.patch(
      url,
      { title },
      { headers, timeout: 10_000, validateStatus: s => s < 500 },
    )

    if (response.status === 200) {
      logForDebugging(`[bridge] Session title updated successfully`)
    } else {
      const detail = extractErrorDetail(response.data)
      logForDebugging(
        `[bridge] Session title update failed with status ${response.status}${detail ? `: ${detail}` : ''}`,
      )
    }
  } catch (err: unknown) {
    logForDebugging(
      `[bridge] Session title update request failed: ${errorMessage(err)}`,
    )
  }
}

/**
 * Create a session on a bridge environment via POST /v1/sessions.
 *
 * Used by both `claude remote-control` (empty session so the user has somewhere to
 * type immediately) and `/remote-control` (session pre-populated with conversation
 * history).
 *
 * Returns the session ID on success, or null if creation fails (non-fatal).
 */
export async function createBridgeSession({
  environmentId,
  title,
  events,
  gitRepoUrl,
  branch,
  signal,
  baseUrl: baseUrlOverride,
  getAccessToken,
  permissionMode,
}: {
  environmentId: string
  title?: string
  events: SessionEvent[]
  gitRepoUrl: string | null
  branch: string
  signal: AbortSignal
  baseUrl?: string
  getAccessToken?: () => string | undefined
  permissionMode?: string
}): Promise<string | null> {
  const { getClaudeAIOAuthTokens } = await import('../utils/auth.js')
  const { getOrganizationUUID } = await import('../services/oauth/client.js')
  const { getOauthConfig } = await import('../constants/oauth.js')
  const { getOAuthHeaders } = await import('../utils/teleport/api.js')
  const { parseGitHubRepository } = await import('../utils/detectRepository.js')
  const { getDefaultBranch } = await import('../utils/git.js')
  const { getMainLoopModel } = await import('../utils/model/model.js')
  const { default: axios } = await import('axios')

  const accessToken =
    getAccessToken?.() ?? getClaudeAIOAuthTokens()?.accessToken
  if (!accessToken) {
    logForDebugging('[bridge] No access token for session creation')
    return null
  }

  const orgUUID = await getOrganizationUUID()
  if (!orgUUID) {
    logForDebugging('[bridge] No org UUID for session creation')
    return null
  }

  // Build git source and outcome context
  let gitSource: GitSource | null = null
  let gitOutcome: GitOutcome | null = null

  if (gitRepoUrl) {
    const { parseGitRemote } = await import('../utils/detectRepository.js')
    const parsed = parseGitRemote(gitRepoUrl)
    if (parsed) {
      const { host, owner, name } = parsed
      const revision = branch || (await getDefaultBranch()) || undefined
      gitSource = {
        type: 'git_repository',
        url: `https://${host}/${owner}/${name}`,
        revision,
      }
      gitOutcome = {
        type: 'git_repository',
        git_info: {
          type: 'github',
          repo: `${owner}/${name}`,
          branches: [`claude/${branch || 'task'}`],
        },
      }
    } else {
      // Fallback: try parseGitHubRepository for owner/repo format
      const ownerRepo = parseGitHubRepository(gitRepoUrl)
      if (ownerRepo) {
        const [owner, name] = ownerRepo.split('/')
        if (owner && name) {
          const revision = branch || (await getDefaultBranch()) || undefined
          gitSource = {
            type: 'git_repository',
            url: `https://github.com/${owner}/${name}`,
            revision,
          }
          gitOutcome = {
            type: 'git_repository',
            git_info: {
              type: 'github',
              repo: `${owner}/${name}`,
              branches: [`claude/${branch || 'task'}`],
            },
          }
        }
      }
    }
  }

  const requestBody = {
    ...(title !== undefined && { title }),
    events,
    session_context: {
      sources: gitSource ? [gitSource] : [],
      outcomes: gitOutcome ? [gitOutcome] : [],
      model: getMainLoopModel(),
    },
    environment_id: environmentId,
    source: 'remote-control',
    ...(permissionMode && { permission_mode: permissionMode }),
  }

  const headers = {
    ...getOAuthHeaders(accessToken),
    'anthropic-beta': 'ccr-byoc-2025-07-29',
    'x-organization-uuid': orgUUID,
  }

  const url = `${baseUrlOverride ?? getOauthConfig().BASE_API_URL}/v1/sessions`
  let response
  try {
    response = await axios.post(url, requestBody, {
      headers,
      signal,
      validateStatus: s => s < 500,
    })
  } catch (err: unknown) {
    logForDebugging(
      `[bridge] Session creation request failed: ${errorMessage(err)}`,
    )
    return null
  }
  const isSuccess = response.status === 200 || response.status === 201

  if (!isSuccess) {
    const detail = extractErrorDetail(response.data)
    logForDebugging(
      `[bridge] Session creation failed with status ${response.status}${detail ? `: ${detail}` : ''}`,
    )
    return null
  }

  const sessionData: unknown = response.data
  if (
    !sessionData ||
    typeof sessionData !== 'object' ||
    !('id' in sessionData) ||
    typeof sessionData.id !== 'string'
  ) {
    logForDebugging('[bridge] No session ID in response')
    return null
  }

  return sessionData.id
}

/**
 * Fetch a bridge session via GET /v1/sessions/{id}.
 *
 * Returns the session's environment_id (for `--session-id` resume) and title.
 * Uses the same org-scoped headers as create/archive — the environments-level
 * client in bridgeApi.ts uses a different beta header and no org UUID, which
 * makes the Sessions API return 404.
 */
export async function getBridgeSession(
  sessionId: string,
  opts?: { baseUrl?: string; getAccessToken?: () => string | undefined },
): Promise<{ environment_id?: string; title?: string } | null> {
  const { getClaudeAIOAuthTokens } = await import('../utils/auth.js')
  const { getOrganizationUUID } = await import('../services/oauth/client.js')
  const { getOauthConfig } = await import('../constants/oauth.js')
  const { getOAuthHeaders } = await import('../utils/teleport/api.js')
  const { default: axios } = await import('axios')

  const accessToken =
    opts?.getAccessToken?.() ?? getClaudeAIOAuthTokens()?.accessToken
  if (!accessToken) {
    logForDebugging('[bridge] No access token for session fetch')
    return null
  }

  const orgUUID = await getOrganizationUUID()
  if (!orgUUID) {
    logForDebugging('[bridge] No org UUID for session fetch')
    return null
  }

  const headers = {
    ...getOAuthHeaders(accessToken),
    'anthropic-beta': 'ccr-byoc-2025-07-29',
    'x-organization-uuid': orgUUID,
  }

  const url = `${opts?.baseUrl ?? getOauthConfig().BASE_API_URL}/v1/sessions/${sessionId}`
  logForDebugging(`[bridge] Fetching session ${sessionId}`)

  let response
  try {
    response = await axios.get<{ environment_id?: string; title?: string }>(
      url,
      { headers, timeout: 10_000, validateStatus: s => s < 500 },
    )
  } catch (err: unknown) {
    logForDebugging(
      `[bridge] Session fetch request failed: ${errorMessage(err)}`,
    )
    return null
  }

  if (response.status !== 200) {
    const detail = extractErrorDetail(response.data)
    logForDebugging(
      `[bridge] Session fetch failed with status ${response.status}${detail ? `: ${detail}` : ''}`,
    )
    return null
  }

  return response.data
}

/**
 * Archive a bridge session via POST /v1/sessions/{id}/archive.
 *
 * The CCR server never auto-archives sessions — archival is always an
 * explicit client action. Both `claude remote-control` (standalone bridge) and the
 * always-on `/remote-control` REPL bridge call this during shutdown to archive any
 * sessions that are still alive.
 *
 * The archive endpoint accepts sessions in any status (running, idle,
 * requires_action, pending) and returns 409 if already archived, making
 * it safe to call even if the server-side runner already archived the
 * session.
 *
 * Callers must handle errors — this function has no try/catch; 5xx,
 * timeouts, and network errors throw. Archival is best-effort during
 * cleanup; call sites wrap with .catch().
 */
export async function archiveBridgeSession(
  sessionId: string,
  opts?: {
    baseUrl?: string
    getAccessToken?: () => string | undefined
    timeoutMs?: number
  },
): Promise<void> {
  const { getClaudeAIOAuthTokens } = await import('../utils/auth.js')
  const { getOrganizationUUID } = await import('../services/oauth/client.js')
  const { getOauthConfig } = await import('../constants/oauth.js')
  const { getOAuthHeaders } = await import('../utils/teleport/api.js')
  const { default: axios } = await import('axios')

  const accessToken =
    opts?.getAccessToken?.() ?? getClaudeAIOAuthTokens()?.accessToken
  if (!accessToken) {
    logForDebugging('[bridge] No access token for session archive')
    return
  }

  const orgUUID = await getOrganizationUUID()
  if (!orgUUID) {
    logForDebugging('[bridge] No org UUID for session archive')
    return
  }

  const headers = {
    ...getOAuthHeaders(accessToken),
    'anthropic-beta': 'ccr-byoc-2025-07-29',
    'x-organization-uuid': orgUUID,
  }

  const url = `${opts?.baseUrl ?? getOauthConfig().BASE_API_URL}/v1/sessions/${sessionId}/archive`
  logForDebugging(`[bridge] Archiving session ${sessionId}`)

  const response = await axios.post(
    url,
    {},
    {
      headers,
      timeout: opts?.timeoutMs ?? 10_000,
      validateStatus: s => s < 500,
    },
  )

  if (response.status === 200) {
    logForDebugging(`[bridge] Session ${sessionId} archived successfully`)
  } else {
    const detail = extractErrorDetail(response.data)
    logForDebugging(
      `[bridge] Session archive failed with status ${response.status}${detail ? `: ${detail}` : ''}`,
    )
  }
}

/**
 * Update the title of a bridge session via PATCH /v1/sessions/{id}.
 *
 * Called when the user renames a session via /rename while a bridge
 * connection is active, so the title stays in sync on claude.ai/code.
 *
 * Errors are swallowed — title sync is best-effort.
 */
export async function updateBridgeSessionTitle(
  sessionId: string,
  title: string,
  opts?: { baseUrl?: string; getAccessToken?: () => string | undefined },
): Promise<void> {
  const { getClaudeAIOAuthTokens } = await import('../utils/auth.js')
  const { getOrganizationUUID } = await import('../services/oauth/client.js')
  const { getOauthConfig } = await import('../constants/oauth.js')
  const { getOAuthHeaders } = await import('../utils/teleport/api.js')
  const { default: axios } = await import('axios')

  const accessToken =
    opts?.getAccessToken?.() ?? getClaudeAIOAuthTokens()?.accessToken
  if (!accessToken) {
    logForDebugging('[bridge] No access token for session title update')
    return
  }

  const orgUUID = await getOrganizationUUID()
  if (!orgUUID) {
    logForDebugging('[bridge] No org UUID for session title update')
    return
  }

  const headers = {
    ...getOAuthHeaders(accessToken),
    'anthropic-beta': 'ccr-byoc-2025-07-29',
    'x-organization-uuid': orgUUID,
  }

  // Compat gateway only accepts session_* (compat/convert.go:27). v2 callers
  // pass raw cse_*; retag here so all callers can pass whatever they hold.
  // Idempotent for v1's session_* and bridgeMain's pre-converted compatSessionId.
  const compatId = toCompatSessionId(sessionId)
  const url = `${opts?.baseUrl ?? getOauthConfig().BASE_API_URL}/v1/sessions/${compatId}`
  logForDebugging(`[bridge] Updating session title: ${compatId} → ${title}`)

  try {
    const response = await axios.patch(
      url,
      { title },
      { headers, timeout: 10_000, validateStatus: s => s < 500 },
    )

    if (response.status === 200) {
      logForDebugging(`[bridge] Session title updated successfully`)
    } else {
      const detail = extractErrorDetail(response.data)
      logForDebugging(
        `[bridge] Session title update failed with status ${response.status}${detail ? `: ${detail}` : ''}`,
      )
    }
  } catch (err: unknown) {
    logForDebugging(
      `[bridge] Session title update request failed: ${errorMessage(err)}`,
    )
  }
}
