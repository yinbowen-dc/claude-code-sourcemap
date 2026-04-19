/**
 * teleport/api.ts — 远程云会话（Teleport）Sessions API 客户端
 *
 * 在 Claude Code 的 Teleport（远程会话）功能中，本文件是与 Anthropic Sessions API
 * 交互的核心客户端层，提供以下能力：
 *   1. 带指数退避重试的 HTTP GET 请求（axiosGetWithRetry）
 *   2. OAuth 认证头构建（getOAuthHeaders）
 *   3. API 请求前置验证（prepareApiRequest）
 *   4. 会话列表获取与格式转换（fetchCodeSessionsFromSessionsAPI）
 *   5. 单个会话详情获取（fetchSession）
 *   6. 从会话中提取分支信息（getBranchFromSession）
 *   7. 向远程会话发送消息事件（sendEventToRemoteSession）
 *   8. 更新会话标题（updateSessionTitle）
 *
 * API 端点格式：
 *   GET    /v1/sessions              → 会话列表
 *   GET    /v1/sessions/:id          → 单个会话
 *   POST   /v1/sessions/:id/events   → 发送事件
 *   PATCH  /v1/sessions/:id          → 更新会话属性
 *
 * 认证方式：Bearer Token（Claude.ai OAuth），需同时提供 x-organization-uuid 头
 * Beta 标志：anthropic-beta: ccr-byoc-2025-07-29
 */

import axios, { type AxiosRequestConfig, type AxiosResponse } from 'axios'
import { randomUUID } from 'crypto'
import { getOauthConfig } from 'src/constants/oauth.js'
import { getOrganizationUUID } from 'src/services/oauth/client.js'
import z from 'zod/v4'
import { getClaudeAIOAuthTokens } from '../auth.js'
import { logForDebugging } from '../debug.js'
import { parseGitHubRepository } from '../detectRepository.js'
import { errorMessage, toError } from '../errors.js'
import { lazySchema } from '../lazySchema.js'
import { logError } from '../log.js'
import { sleep } from '../sleep.js'
import { jsonStringify } from '../slowOperations.js'

// ─── 重试配置 ────────────────────────────────────────────────────────────────
// 对 Teleport API 请求使用指数退避策略：2s → 4s → 8s → 16s（共 4 次重试）
const TELEPORT_RETRY_DELAYS = [2000, 4000, 8000, 16000] // 指数退避延迟列表（毫秒）
const MAX_TELEPORT_RETRIES = TELEPORT_RETRY_DELAYS.length // 最大重试次数 = 4

/** CCR BYOC Beta 功能标识，添加到所有请求的 anthropic-beta 头 */
export const CCR_BYOC_BETA = 'ccr-byoc-2025-07-29'

/**
 * 判断 axios 错误是否为应该重试的瞬时网络错误。
 *
 * 重试条件：
 *   - 网络层错误（无响应，如 DNS 失败、连接超时）
 *   - 服务器错误（5xx 状态码，如 500 Internal Server Error）
 *
 * 不重试：
 *   - 非 axios 错误（如 JSON 解析错误、程序逻辑错误）
 *   - 客户端错误（4xx，表示请求本身有问题，重试无意义）
 *
 * @param error - 捕获到的错误对象
 * @returns true 表示应该重试
 */
export function isTransientNetworkError(error: unknown): boolean {
  // 非 axios 错误（如编程错误）不应重试
  if (!axios.isAxiosError(error)) {
    return false
  }

  // 没有收到响应（网络层错误）→ 重试
  if (!error.response) {
    return true
  }

  // 服务器端错误（5xx）→ 重试（服务器可能暂时不可用）
  if (error.response.status >= 500) {
    return true
  }

  // 客户端错误（4xx）→ 不重试（请求本身有问题）
  return false
}

/**
 * 带自动重试的 axios GET 请求封装。
 *
 * 重试策略：指数退避，最多 4 次重试（共 5 次尝试）
 *   - 第 1 次失败 → 等待 2000ms 后重试
 *   - 第 2 次失败 → 等待 4000ms 后重试
 *   - 第 3 次失败 → 等待 8000ms 后重试
 *   - 第 4 次失败 → 等待 16000ms 后重试
 *   - 第 5 次失败 → 抛出错误
 *
 * 只对瞬时网络错误（isTransientNetworkError）进行重试。
 *
 * @param url    - 请求 URL
 * @param config - axios 请求配置（headers、timeout 等）
 * @returns axios 响应对象
 */
export async function axiosGetWithRetry<T>(
  url: string,
  config?: AxiosRequestConfig,
): Promise<AxiosResponse<T>> {
  let lastError: unknown

  // 循环最多 MAX_TELEPORT_RETRIES + 1 次（含首次尝试）
  for (let attempt = 0; attempt <= MAX_TELEPORT_RETRIES; attempt++) {
    try {
      return await axios.get<T>(url, config)
    } catch (error) {
      lastError = error

      // 非瞬时错误（如 4xx）直接抛出，不重试
      if (!isTransientNetworkError(error)) {
        throw error
      }

      // 已耗尽所有重试次数，记录日志并抛出
      if (attempt >= MAX_TELEPORT_RETRIES) {
        logForDebugging(
          `Teleport request failed after ${attempt + 1} attempts: ${errorMessage(error)}`,
        )
        throw error
      }

      // 根据当前尝试次数选择对应的退避延迟
      const delay = TELEPORT_RETRY_DELAYS[attempt] ?? 2000
      logForDebugging(
        `Teleport request failed (attempt ${attempt + 1}/${MAX_TELEPORT_RETRIES + 1}), retrying in ${delay}ms: ${errorMessage(error)}`,
      )
      // 等待指定延迟后进行下次重试
      await sleep(delay)
    }
  }

  // 理论上不会到达此处（for 循环内总会 return 或 throw）
  throw lastError
}

// ─── API 响应类型定义 ─────────────────────────────────────────────────────────
// 与后端 api/schemas/sessions/sessions.py 中的定义保持一致

/** 会话状态枚举：需要操作 / 运行中 / 空闲 / 已归档 */
export type SessionStatus = 'requires_action' | 'running' | 'idle' | 'archived'

/** Git 仓库来源：包含仓库 URL、修订版本和推送权限 */
export type GitSource = {
  type: 'git_repository'
  url: string
  revision?: string | null
  allow_unrestricted_git_push?: boolean
}

/** 知识库来源：通过知识库 ID 引用 */
export type KnowledgeBaseSource = {
  type: 'knowledge_base'
  knowledge_base_id: string
}

/** 会话上下文来源：Git 仓库或知识库（联合类型） */
export type SessionContextSource = GitSource | KnowledgeBaseSource

// 来自 api/schemas/sandbox.py 的 Outcome 类型
/** GitHub 仓库结果信息：包含仓库路径和分支列表 */
export type OutcomeGitInfo = {
  type: 'github'
  repo: string
  branches: string[]
}

/** Git 仓库执行结果：会话对 Git 仓库的操作输出（如推送的分支） */
export type GitRepositoryOutcome = {
  type: 'git_repository'
  git_info: OutcomeGitInfo
}

/** 会话执行结果（目前只有 Git 仓库类型） */
export type Outcome = GitRepositoryOutcome

/** 会话上下文：包含来源、工作目录、执行结果、提示词、模型等完整配置 */
export type SessionContext = {
  sources: SessionContextSource[]
  cwd: string
  outcomes: Outcome[] | null
  custom_system_prompt: string | null
  append_system_prompt: string | null
  model: string | null
  // 通过 Files API 上传的 git bundle 文件 ID，用于初始化文件系统
  seed_bundle_file_id?: string
  github_pr?: { owner: string; repo: string; number: number }
  reuse_outcome_branches?: boolean
}

/** 完整的会话资源对象（来自 Sessions API 响应） */
export type SessionResource = {
  type: 'session'
  id: string
  title: string | null
  session_status: SessionStatus
  environment_id: string
  created_at: string
  updated_at: string
  session_context: SessionContext
}

/** 会话列表响应（含分页信息） */
export type ListSessionsResponse = {
  data: SessionResource[]
  has_more: boolean
  first_id: string | null
  last_id: string | null
}

/**
 * CodeSession Zod 校验模式（懒加载以优化启动性能）。
 *
 * 定义了前端使用的会话数据结构，与后端 SessionResource 有所不同：
 *   - status 字段为枚举（idle/working/waiting/completed/archived/cancelled/rejected）
 *   - 包含 repo 信息（从 GitSource 转换而来）
 *   - 包含 turns 数组（消息轮次）
 */
export const CodeSessionSchema = lazySchema(() =>
  z.object({
    id: z.string(),
    title: z.string(),
    description: z.string(),
    status: z.enum([
      'idle',
      'working',
      'waiting',
      'completed',
      'archived',
      'cancelled',
      'rejected',
    ]),
    repo: z
      .object({
        name: z.string(),
        owner: z.object({
          login: z.string(),
        }),
        default_branch: z.string().optional(),
      })
      .nullable(),
    turns: z.array(z.string()),
    created_at: z.string(),
    updated_at: z.string(),
  }),
)

/** 从 CodeSessionSchema 推断的 TypeScript 类型 */
export type CodeSession = z.infer<ReturnType<typeof CodeSessionSchema>>

/**
 * API 请求前置验证：获取 OAuth 访问令牌和组织 UUID。
 *
 * 调用所有需要认证的 API 函数之前，必须先调用此函数。
 * 若未登录或无法获取组织信息，则抛出带有指引信息的错误。
 *
 * @returns 包含 accessToken 和 orgUUID 的对象
 * @throws Error - 未登录或无法获取组织 UUID 时抛出
 */
export async function prepareApiRequest(): Promise<{
  accessToken: string
  orgUUID: string
}> {
  // 从本地存储获取 OAuth 令牌（需要已登录）
  const accessToken = getClaudeAIOAuthTokens()?.accessToken
  if (accessToken === undefined) {
    throw new Error(
      'Claude Code web sessions require authentication with a Claude.ai account. API key authentication is not sufficient. Please run /login to authenticate, or check your authentication status with /status.',
    )
  }

  // 获取当前用户的组织 UUID（从 OAuth 令牌中解析）
  const orgUUID = await getOrganizationUUID()
  if (!orgUUID) {
    throw new Error('Unable to get organization UUID')
  }

  return { accessToken, orgUUID }
}

/**
 * 从 Sessions API 获取代码会话列表并转换为 CodeSession 格式。
 *
 * 执行流程：
 *   1. 调用 prepareApiRequest() 获取认证信息
 *   2. GET /v1/sessions（带 CCR BYOC beta 头）
 *   3. 将 SessionResource[] 转换为 CodeSession[]：
 *      - 从 sources 中提取 git_repository 来源
 *      - 解析 GitHub URL 获取仓库 owner/name
 *      - 将 session_status 映射为 CodeSession.status
 *
 * @returns CodeSession 数组
 * @throws Error - 认证失败、请求失败或状态码非 200 时抛出
 */
export async function fetchCodeSessionsFromSessionsAPI(): Promise<
  CodeSession[]
> {
  const { accessToken, orgUUID } = await prepareApiRequest()

  const url = `${getOauthConfig().BASE_API_URL}/v1/sessions`

  try {
    const headers = {
      ...getOAuthHeaders(accessToken),
      'anthropic-beta': 'ccr-byoc-2025-07-29', // CCR BYOC Beta 功能标志
      'x-organization-uuid': orgUUID,           // 组织 UUID（多租户隔离）
    }

    // 使用带重试的 GET 请求获取会话列表
    const response = await axiosGetWithRetry<ListSessionsResponse>(url, {
      headers,
    })

    if (response.status !== 200) {
      throw new Error(`Failed to fetch code sessions: ${response.statusText}`)
    }

    // 将 SessionResource[] 转换为前端使用的 CodeSession[] 格式
    const sessions: CodeSession[] = response.data.data.map(session => {
      // 从会话上下文的 sources 中找到 git_repository 类型的来源
      const gitSource = session.session_context.sources.find(
        (source): source is GitSource => source.type === 'git_repository',
      )

      let repo: CodeSession['repo'] = null
      if (gitSource?.url) {
        // 使用现有工具函数解析 GitHub URL，提取 "owner/name" 格式
        const repoPath = parseGitHubRepository(gitSource.url)
        if (repoPath) {
          const [owner, name] = repoPath.split('/')
          if (owner && name) {
            repo = {
              name,
              owner: {
                login: owner,
              },
              // 使用 revision 字段作为默认分支（若存在）
              default_branch: gitSource.revision || undefined,
            }
          }
        }
      }

      return {
        id: session.id,
        title: session.title || 'Untitled', // 无标题时使用默认值
        description: '',                    // SessionResource 无 description 字段
        status: session.session_status as CodeSession['status'], // 映射状态字段
        repo,
        turns: [],                          // SessionResource 无 turns 字段
        created_at: session.created_at,
        updated_at: session.updated_at,
      }
    })

    return sessions
  } catch (error) {
    const err = toError(error)
    logError(err)
    throw error
  }
}

/**
 * 构建 OAuth 认证请求头对象。
 *
 * 所有需要认证的 API 请求都应使用此函数构建基础头，
 * 再通过展开运算符（...）追加特定头（如 x-organization-uuid）。
 *
 * @param accessToken - OAuth 访问令牌（Bearer Token）
 * @returns 包含 Authorization、Content-Type 和 anthropic-version 的头对象
 */
export function getOAuthHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,   // Bearer Token 认证
    'Content-Type': 'application/json',        // 请求体格式
    'anthropic-version': '2023-06-01',         // Anthropic API 版本
  }
}

/**
 * 通过 Sessions API 获取单个会话的详细信息。
 *
 * 与 fetchCodeSessionsFromSessionsAPI 不同，此函数返回原始的 SessionResource
 * 格式（不做转换），适用于需要完整会话上下文的场景（如恢复会话、获取分支）。
 *
 * 错误处理：
 *   - 404 → 抛出 "Session not found" 错误
 *   - 401 → 抛出 "Session expired" 错误（提示重新登录）
 *   - 其他非 200 → 使用 API 返回的错误消息或默认消息
 *
 * @param sessionId - 会话 ID
 * @returns 完整的 SessionResource 对象
 * @throws Error - 会话不存在、认证过期或其他 API 错误时抛出
 */
export async function fetchSession(
  sessionId: string,
): Promise<SessionResource> {
  const { accessToken, orgUUID } = await prepareApiRequest()

  const url = `${getOauthConfig().BASE_API_URL}/v1/sessions/${sessionId}`
  const headers = {
    ...getOAuthHeaders(accessToken),
    'anthropic-beta': 'ccr-byoc-2025-07-29',
    'x-organization-uuid': orgUUID,
  }

  // validateStatus: 接受所有小于 500 的状态码（不自动抛出 4xx 错误）
  const response = await axios.get<SessionResource>(url, {
    headers,
    timeout: 15000,                              // 15 秒超时
    validateStatus: status => status < 500,      // 5xx 才自动抛出
  })

  if (response.status !== 200) {
    // 尝试从响应体中提取 API 提供的错误消息
    const errorData = response.data as { error?: { message?: string } }
    const apiMessage = errorData?.error?.message

    // 404 → 会话不存在
    if (response.status === 404) {
      throw new Error(`Session not found: ${sessionId}`)
    }

    // 401 → 认证过期，引导用户重新登录
    if (response.status === 401) {
      throw new Error('Session expired. Please run /login to sign in again.')
    }

    // 其他错误 → 优先使用 API 错误消息，否则使用默认消息
    throw new Error(
      apiMessage ||
        `Failed to fetch session: ${response.status} ${response.statusText}`,
    )
  }

  return response.data
}

/**
 * 从会话的 Git 仓库执行结果中提取第一个分支名。
 *
 * 会话完成后，outcomes 字段会记录会话对 Git 仓库的影响（如推送了哪些分支）。
 * 此函数提取第一个分支名，用于后续的 PR 创建或代码审查流程。
 *
 * @param session - 会话资源对象
 * @returns 第一个分支名；若无 Git 仓库结果则返回 undefined
 */
export function getBranchFromSession(
  session: SessionResource,
): string | undefined {
  // 在 outcomes 中查找 git_repository 类型的结果
  const gitOutcome = session.session_context.outcomes?.find(
    (outcome): outcome is GitRepositoryOutcome =>
      outcome.type === 'git_repository',
  )
  // 返回分支列表中的第一个分支名
  return gitOutcome?.git_info?.branches[0]
}

/**
 * 远程会话消息内容类型。
 * 支持纯字符串或遵循 Anthropic API 规范的内容块数组（文本、图片等）。
 */
export type RemoteMessageContent =
  | string
  | Array<{ type: string; [key: string]: unknown }>

/**
 * 向现有远程会话发送用户消息事件。
 *
 * 用于将本地用户输入转发给正在运行的远程 CCR 会话。
 * 该端点可能会阻塞等待 CCR worker 就绪（冷启动容器约需 2.6s），
 * 因此设置了 30 秒超时以应对极端情况。
 *
 * 消息格式：
 *   { events: [{ uuid, session_id, type: 'user', message: { role: 'user', content } }] }
 *
 * @param sessionId      - 目标会话 ID
 * @param messageContent - 消息内容（字符串或内容块数组）
 * @param opts.uuid      - 可选的消息 UUID；若调用方已在本地创建了消息记录，
 *                         传入其 UUID 可避免回显时重复显示
 * @returns true 表示发送成功（2xx），false 表示失败（4xx 或网络错误）
 */
export async function sendEventToRemoteSession(
  sessionId: string,
  messageContent: RemoteMessageContent,
  opts?: { uuid?: string },
): Promise<boolean> {
  try {
    const { accessToken, orgUUID } = await prepareApiRequest()

    const url = `${getOauthConfig().BASE_API_URL}/v1/sessions/${sessionId}/events`
    const headers = {
      ...getOAuthHeaders(accessToken),
      'anthropic-beta': 'ccr-byoc-2025-07-29',
      'x-organization-uuid': orgUUID,
    }

    // 构建用户事件对象，遵循 Sessions API 的事件格式规范
    const userEvent = {
      uuid: opts?.uuid ?? randomUUID(), // 若调用方未提供 UUID，则生成新的
      session_id: sessionId,
      type: 'user',
      parent_tool_use_id: null,          // 非工具结果消息，parent 为 null
      message: {
        role: 'user',
        content: messageContent,
      },
    }

    const requestBody = {
      events: [userEvent],
    }

    logForDebugging(
      `[sendEventToRemoteSession] Sending event to session ${sessionId}`,
    )
    // 该端点可能阻塞等待 CCR worker 就绪；正常情况约 2.6s，允许 30s 超时
    const response = await axios.post(url, requestBody, {
      headers,
      validateStatus: status => status < 500, // 不自动抛出 4xx
      timeout: 30000,                          // 30 秒超时（应对冷启动）
    })

    // 201 Created 也是成功状态（首次发送消息时可能返回 201）
    if (response.status === 200 || response.status === 201) {
      logForDebugging(
        `[sendEventToRemoteSession] Successfully sent event to session ${sessionId}`,
      )
      return true
    }

    logForDebugging(
      `[sendEventToRemoteSession] Failed with status ${response.status}: ${jsonStringify(response.data)}`,
    )
    return false
  } catch (error) {
    // 网络层错误（如超时）→ 返回 false 而非抛出，让调用方决定是否重试
    logForDebugging(`[sendEventToRemoteSession] Error: ${errorMessage(error)}`)
    return false
  }
}

/**
 * 更新远程会话的标题。
 *
 * 在会话完成后（如生成标题逻辑执行后），通过 PATCH 请求
 * 将新标题同步到 Sessions API。
 *
 * @param sessionId - 目标会话 ID
 * @param title     - 新的会话标题
 * @returns true 表示更新成功（200），false 表示失败
 */
export async function updateSessionTitle(
  sessionId: string,
  title: string,
): Promise<boolean> {
  try {
    const { accessToken, orgUUID } = await prepareApiRequest()

    const url = `${getOauthConfig().BASE_API_URL}/v1/sessions/${sessionId}`
    const headers = {
      ...getOAuthHeaders(accessToken),
      'anthropic-beta': 'ccr-byoc-2025-07-29',
      'x-organization-uuid': orgUUID,
    }

    logForDebugging(
      `[updateSessionTitle] Updating title for session ${sessionId}: "${title}"`,
    )
    // PATCH 请求，仅发送需要更新的字段（title）
    const response = await axios.patch(
      url,
      { title },
      {
        headers,
        validateStatus: status => status < 500, // 不自动抛出 4xx
      },
    )

    if (response.status === 200) {
      logForDebugging(
        `[updateSessionTitle] Successfully updated title for session ${sessionId}`,
      )
      return true
    }

    logForDebugging(
      `[updateSessionTitle] Failed with status ${response.status}: ${jsonStringify(response.data)}`,
    )
    return false
  } catch (error) {
    logForDebugging(`[updateSessionTitle] Error: ${errorMessage(error)}`)
    return false
  }
}
