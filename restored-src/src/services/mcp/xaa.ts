/**
 * 跨应用访问（Cross-App Access，XAA）/ 企业托管授权（Enterprise Managed Authorization，SEP-990）
 *
 * 在 Claude Code 系统流程中的位置：
 * 本文件实现了企业场景下无需浏览器同意页面获取 MCP 访问令牌的完整 OAuth 流程。
 * 在用户已通过 IdP（身份提供方）登录并持有 id_token 的前提下，此模块通过
 * 两步 OAuth 链式请求完成身份断言授权：
 *   1. RFC 8693 Token Exchange（令牌交换）：在 IdP 侧将 id_token 换取 ID-JAG
 *   2. RFC 7523 JWT Bearer Grant（JWT 持有者授权）：在 AS 侧将 ID-JAG 换取 access_token
 *
 * 规范参考：
 *   - ID-JAG（IETF 草案）：https://datatracker.ietf.org/doc/draft-ietf-oauth-identity-assertion-authz-grant/
 *   - MCP ext-auth（SEP-990）：https://github.com/modelcontextprotocol/ext-auth
 *   - RFC 8693（Token Exchange）、RFC 7523（JWT Bearer）、RFC 9728（PRM）
 *
 * 架构层次：
 * - Layer 2（发现层）：discoverProtectedResource、discoverAuthorizationServer
 * - Layer 2（交换层）：requestJwtAuthorizationGrant、exchangeJwtAuthGrant
 * - Layer 3（编排层）：performCrossAppAccess — 组合上述四个操作完成完整流程
 *
 * 主要功能：
 * - makeXaaFetch：统一超时（30 秒）+ 可选用户取消信号的 fetch 包装器
 * - XaaTokenExchangeError：携带 shouldClearIdToken 语义，区分 4xx（清除缓存）与 5xx（保留缓存）
 * - SENSITIVE_TOKEN_RE：正则脱敏，防止令牌泄漏到调试日志
 * - 所有 Layer-2 操作对齐 TS SDK PR #1593 的 Layer-2 接口形状，便于未来迁移
 */

import {
  discoverAuthorizationServerMetadata,
  discoverOAuthProtectedResourceMetadata,
} from '@modelcontextprotocol/sdk/client/auth.js'
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'
import { z } from 'zod/v4'
import { lazySchema } from '../../utils/lazySchema.js'
import { logMCPDebug } from '../../utils/log.js'
import { jsonStringify } from '../../utils/slowOperations.js'

// XAA 所有 HTTP 请求的统一超时时间：30 秒
const XAA_REQUEST_TIMEOUT_MS = 30000

// OAuth grant_type URN 常量
const TOKEN_EXCHANGE_GRANT = 'urn:ietf:params:oauth:grant-type:token-exchange'
const JWT_BEARER_GRANT = 'urn:ietf:params:oauth:grant-type:jwt-bearer'
// ID-JAG 令牌类型 URN（Identity Assertion Authorization Grant）
const ID_JAG_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:id-jag'
// OIDC id_token 类型 URN
const ID_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:id_token'

/**
 * 创建带统一超时和可选取消信号的 fetch 包装器
 *
 * 作用：为所有 XAA HTTP 请求注入 30 秒超时控制，并支持与调用方提供的
 * AbortSignal 组合（使用 AbortSignal.any），确保用户按 Esc 取消时
 * 能真正中止进行中的请求，而不会被超时信号覆盖。
 *
 * @param abortSignal 可选的外部取消信号（如用户交互取消）
 * @returns 符合 FetchLike 接口的 fetch 函数
 */
function makeXaaFetch(abortSignal?: AbortSignal): FetchLike {
  return (url, init) => {
    // 创建 30 秒超时信号
    const timeout = AbortSignal.timeout(XAA_REQUEST_TIMEOUT_MS)
    // 若有外部取消信号，则将两者合并：任一触发即中止请求
    const signal = abortSignal
      ? // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
        AbortSignal.any([timeout, abortSignal])
      : timeout
    // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
    return fetch(url, { ...init, signal })
  }
}

// 无取消信号的默认 fetch 实例，供不需要取消语义的发现操作使用
const defaultFetch = makeXaaFetch()

/**
 * RFC 3986 §6.2.2 URL 规范化
 *
 * 作用：对 URL 进行语法规范化（小写 scheme+host、去除默认端口），
 * 并去除末尾斜杠，用于 RFC 8414 §3.3 / RFC 9728 §3.3 的标识符比对。
 * 防止因大小写或末尾斜杠差异导致的误判（mix-up 攻击防护）。
 *
 * @param url 待规范化的 URL 字符串
 * @returns 规范化后的 URL 字符串
 */
function normalizeUrl(url: string): string {
  try {
    // 通过 URL 构造函数进行 RFC 3986 §6.2.2 规范化（小写 scheme+host，去除默认端口）
    return new URL(url).href.replace(/\/$/, '')
  } catch {
    // URL 解析失败时，仅去除末尾斜杠作为降级处理
    return url.replace(/\/$/, '')
  }
}

/**
 * XAA 令牌交换错误类
 *
 * 作用：当 IdP 侧的 RFC 8693 Token Exchange 失败时抛出，携带
 * shouldClearIdToken 语义标志，让调用方根据错误性质决策是否清除
 * 本地缓存的 id_token：
 *   - 4xx / invalid_grant / invalid_token → id_token 已失效，应清除缓存
 *   - 5xx → IdP 临时故障，id_token 可能仍有效，应保留缓存
 *   - 200 但响应结构异常 → 协议违规，应清除缓存
 */
export class XaaTokenExchangeError extends Error {
  // 是否应清除本地缓存的 id_token
  readonly shouldClearIdToken: boolean
  constructor(message: string, shouldClearIdToken: boolean) {
    super(message)
    this.name = 'XaaTokenExchangeError'
    this.shouldClearIdToken = shouldClearIdToken
  }
}

// 令牌敏感字段脱敏正则
// 匹配 JSON 中已知令牌字段的引号值，无论嵌套深度如何
// 同时适用于解析后序列化的响应体和原始文本错误体（如 AS 在 4xx 错误中回显令牌时）
// 防止 access_token、refresh_token、id_token 等敏感值泄漏到调试日志
const SENSITIVE_TOKEN_RE =
  /"(access_token|refresh_token|id_token|assertion|subject_token|client_secret)"\s*:\s*"[^"]*"/g

/**
 * 对原始数据进行令牌脱敏处理
 *
 * 作用：将字符串或对象中所有匹配 SENSITIVE_TOKEN_RE 的令牌值替换为 [REDACTED]，
 * 确保调试日志不泄漏敏感令牌信息。
 *
 * @param raw 待脱敏的原始数据（字符串或任意对象）
 * @returns 脱敏后的字符串
 */
function redactTokens(raw: unknown): string {
  // 若非字符串则先序列化为 JSON 字符串
  const s = typeof raw === 'string' ? raw : jsonStringify(raw)
  // 将所有匹配的令牌字段值替换为 [REDACTED]，保留字段名
  return s.replace(SENSITIVE_TOKEN_RE, (_, k) => `"${k}":"[REDACTED]"`)
}

// ─── Zod Schemas ────────────────────────────────────────────────────────────

/**
 * RFC 8693 令牌交换响应 Schema
 *
 * 使用 z.coerce.number() 兼容部分 PHP 后端 IdP 将 expires_in 作为字符串返回的情况
 * （技术上不符合 RFC，但在实际生产环境中广泛存在）
 */
const TokenExchangeResponseSchema = lazySchema(() =>
  z.object({
    access_token: z.string().optional(),
    issued_token_type: z.string().optional(),
    // z.coerce 容忍 PHP 后端 IdP 将 expires_in 作为字符串返回的情况
    expires_in: z.coerce.number().optional(),
    scope: z.string().optional(),
  }),
)

/**
 * RFC 7523 JWT Bearer 授权响应 Schema
 *
 * token_type 使用默认值 'Bearer'：许多 AS 省略此字段，因为 Bearer 是唯一实用值
 * （RFC 6750），不应因缺少标签而拒绝有效的 access_token。
 */
const JwtBearerResponseSchema = lazySchema(() =>
  z.object({
    access_token: z.string().min(1),
    // 许多 AS 省略 token_type，Bearer 是唯一实用值，使用默认值兼容
    token_type: z.string().default('Bearer'),
    expires_in: z.coerce.number().optional(),
    scope: z.string().optional(),
    refresh_token: z.string().optional(),
  }),
)

// ─── Layer 2: Discovery ─────────────────────────────────────────────────────

/** RFC 9728 受保护资源元数据（PRM）结构 */
export type ProtectedResourceMetadata = {
  resource: string
  authorization_servers: string[]
}

/**
 * RFC 9728 PRM 发现与验证
 *
 * 作用：通过 MCP SDK 发现受保护资源元数据，并进行 RFC 9728 §3.3 资源 URL 匹配验证
 * （mix-up 防护，未来计划上游合并到 SDK 中）。
 *
 * 流程：
 * 1. 调用 SDK 的 discoverOAuthProtectedResourceMetadata 获取 PRM
 * 2. 验证 PRM 包含 resource 字段和至少一个 authorization_servers
 * 3. 使用 normalizeUrl 比对 PRM.resource 与 serverUrl，防止资源混淆攻击
 *
 * @param serverUrl MCP 服务器 URL
 * @param opts.fetchFn 可选的自定义 fetch 函数（用于注入超时/取消信号）
 * @returns 包含 resource 和 authorization_servers 的 PRM 数据
 * @throws 若 PRM 发现失败、字段缺失或资源 URL 不匹配
 */
export async function discoverProtectedResource(
  serverUrl: string,
  opts?: { fetchFn?: FetchLike },
): Promise<ProtectedResourceMetadata> {
  let prm
  try {
    // 通过 MCP SDK 发现受保护资源元数据
    prm = await discoverOAuthProtectedResourceMetadata(
      serverUrl,
      undefined,
      opts?.fetchFn ?? defaultFetch,
    )
  } catch (e) {
    throw new Error(
      `XAA: PRM discovery failed: ${e instanceof Error ? e.message : String(e)}`,
    )
  }
  // 验证 PRM 包含必要字段
  if (!prm.resource || !prm.authorization_servers?.[0]) {
    throw new Error(
      'XAA: PRM discovery failed: PRM missing resource or authorization_servers',
    )
  }
  // RFC 9728 §3.3 资源 URL 匹配验证：防止 mix-up 攻击
  if (normalizeUrl(prm.resource) !== normalizeUrl(serverUrl)) {
    throw new Error(
      `XAA: PRM discovery failed: PRM resource mismatch: expected ${serverUrl}, got ${prm.resource}`,
    )
  }
  return {
    resource: prm.resource,
    authorization_servers: prm.authorization_servers,
  }
}

/** 授权服务器元数据结构 */
export type AuthorizationServerMetadata = {
  issuer: string
  token_endpoint: string
  grant_types_supported?: string[]
  token_endpoint_auth_methods_supported?: string[]
}

/**
 * RFC 8414 + OIDC 授权服务器元数据发现与验证
 *
 * 作用：通过 MCP SDK 发现授权服务器元数据，并进行以下验证：
 * 1. RFC 8414 §3.3 颁发者 URL 匹配验证（mix-up 防护，未来计划上游合并到 SDK 中）
 * 2. RFC 8414 §3.3 / RFC 9728 §3 强制要求 HTTPS token endpoint
 *    （防止 id_token + client_secret 通过明文 HTTP 传输）
 *
 * @param asUrl 授权服务器 URL
 * @param opts.fetchFn 可选的自定义 fetch 函数
 * @returns 包含 issuer、token_endpoint 等字段的 AS 元数据
 * @throws 若元数据获取失败、颁发者不匹配或 token endpoint 非 HTTPS
 */
export async function discoverAuthorizationServer(
  asUrl: string,
  opts?: { fetchFn?: FetchLike },
): Promise<AuthorizationServerMetadata> {
  // 通过 MCP SDK 发现 AS 元数据（先尝试 RFC 8414，失败则回退到 OIDC 发现文档）
  const meta = await discoverAuthorizationServerMetadata(asUrl, {
    fetchFn: opts?.fetchFn ?? defaultFetch,
  })
  // 验证元数据包含必要字段
  if (!meta?.issuer || !meta.token_endpoint) {
    throw new Error(
      `XAA: AS metadata discovery failed: no valid metadata at ${asUrl}`,
    )
  }
  // RFC 8414 §3.3 颁发者 URL 匹配验证：防止 mix-up 攻击
  if (normalizeUrl(meta.issuer) !== normalizeUrl(asUrl)) {
    throw new Error(
      `XAA: AS metadata discovery failed: issuer mismatch: expected ${asUrl}, got ${meta.issuer}`,
    )
  }
  // 强制要求 HTTPS token endpoint，防止令牌通过明文传输泄漏
  // 注意：即使 AS 在 PRM 中自洽地声明 http:// issuer，此处也会拒绝
  if (new URL(meta.token_endpoint).protocol !== 'https:') {
    throw new Error(
      `XAA: refusing non-HTTPS token endpoint: ${meta.token_endpoint}`,
    )
  }
  return {
    issuer: meta.issuer,
    token_endpoint: meta.token_endpoint,
    grant_types_supported: meta.grant_types_supported,
    token_endpoint_auth_methods_supported:
      meta.token_endpoint_auth_methods_supported,
  }
}

// ─── Layer 2: Exchange ──────────────────────────────────────────────────────

/** JWT 授权授予结果（即 ID-JAG 令牌及元数据） */
export type JwtAuthGrantResult = {
  /** ID-JAG（Identity Assertion Authorization Grant）令牌值 */
  jwtAuthGrant: string
  expiresIn?: number
  scope?: string
}

/**
 * RFC 8693 令牌交换：id_token → ID-JAG（在 IdP 侧执行）
 *
 * 作用：向 IdP 的 token endpoint 发送令牌交换请求，将用户的 OIDC id_token
 * 换取 ID-JAG（Identity Assertion Authorization Grant）令牌。
 *
 * 流程：
 * 1. 构建 URLSearchParams：grant_type=token-exchange + 相关参数
 * 2. 若有 clientSecret 则通过 client_secret_post 附加（部分 IdP 要求）
 * 3. 发送 POST 请求，处理错误：4xx 清除 id_token，5xx 保留 id_token
 * 4. 解析响应，验证 issued_token_type === ID_JAG_TOKEN_TYPE
 * 5. 返回 ID-JAG 令牌及元数据
 *
 * 注意：clientSecret 为可选，某些 IdP 即使声明 none auth method 仍需要它
 *
 * @param opts.tokenEndpoint IdP 的 token endpoint URL
 * @param opts.audience 目标 AS 的 issuer URL（ID-JAG 的受众）
 * @param opts.resource 受保护资源 URL（MCP 服务器 URL）
 * @param opts.idToken 用户的 OIDC id_token
 * @param opts.clientId IdP 侧注册的客户端 ID
 * @param opts.clientSecret 可选的 IdP 客户端密钥（client_secret_post）
 * @param opts.scope 可选的请求权限范围
 * @throws XaaTokenExchangeError（携带 shouldClearIdToken 标志）
 */
export async function requestJwtAuthorizationGrant(opts: {
  tokenEndpoint: string
  audience: string
  resource: string
  idToken: string
  clientId: string
  clientSecret?: string
  scope?: string
  fetchFn?: FetchLike
}): Promise<JwtAuthGrantResult> {
  const fetchFn = opts.fetchFn ?? defaultFetch
  // 构建令牌交换请求参数
  const params = new URLSearchParams({
    grant_type: TOKEN_EXCHANGE_GRANT,
    requested_token_type: ID_JAG_TOKEN_TYPE,
    audience: opts.audience,
    resource: opts.resource,
    subject_token: opts.idToken,
    subject_token_type: ID_TOKEN_TYPE,
    client_id: opts.clientId,
  })
  // 若有客户端密钥，通过 client_secret_post 方式附加
  if (opts.clientSecret) {
    params.set('client_secret', opts.clientSecret)
  }
  if (opts.scope) {
    params.set('scope', opts.scope)
  }

  const res = await fetchFn(opts.tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params,
  })
  if (!res.ok) {
    // 脱敏后截取响应体前 200 字符，防止令牌泄漏到错误信息
    const body = redactTokens(await res.text()).slice(0, 200)
    // 4xx → id_token 被拒绝（invalid_grant 等），应清除本地缓存
    // 5xx → IdP 故障，id_token 可能仍有效，应保留缓存
    const shouldClear = res.status < 500
    throw new XaaTokenExchangeError(
      `XAA: token exchange failed: HTTP ${res.status}: ${body}`,
      shouldClear,
    )
  }
  let rawExchange: unknown
  try {
    rawExchange = await res.json()
  } catch {
    // JSON 解析失败（如强制门户页面劫持）→ 临时网络问题，保留 id_token 缓存
    throw new XaaTokenExchangeError(
      `XAA: token exchange returned non-JSON (captive portal?) at ${opts.tokenEndpoint}`,
      false,
    )
  }
  // 验证响应结构
  const exchangeParsed = TokenExchangeResponseSchema().safeParse(rawExchange)
  if (!exchangeParsed.success) {
    // 响应结构异常属于协议违规，清除 id_token
    throw new XaaTokenExchangeError(
      `XAA: token exchange response did not match expected shape: ${redactTokens(rawExchange)}`,
      true,
    )
  }
  const result = exchangeParsed.data
  // 验证响应包含 access_token 字段（即 ID-JAG 令牌值）
  if (!result.access_token) {
    throw new XaaTokenExchangeError(
      `XAA: token exchange response missing access_token: ${redactTokens(result)}`,
      true,
    )
  }
  // 验证 issued_token_type 为 ID-JAG，防止 AS 返回错误类型令牌
  if (result.issued_token_type !== ID_JAG_TOKEN_TYPE) {
    throw new XaaTokenExchangeError(
      `XAA: token exchange returned unexpected issued_token_type: ${result.issued_token_type}`,
      true,
    )
  }
  return {
    jwtAuthGrant: result.access_token,
    expiresIn: result.expires_in,
    scope: result.scope,
  }
}

/** XAA 令牌结果（MCP 服务器的访问令牌及元数据） */
export type XaaTokenResult = {
  access_token: string
  token_type: string
  expires_in?: number
  scope?: string
  refresh_token?: string
}

/** 完整 XAA 结果，附带授权服务器 URL（供后续 refresh/revoke 使用） */
export type XaaResult = XaaTokenResult & {
  /**
   * 通过 PRM 发现的 AS 颁发者 URL。调用方必须将其持久化为
   * discoveryState.authorizationServerUrl，以便 refresh（auth.ts _doRefresh）
   * 和 revocation（revokeServerTokens）能定位 token/revocation endpoint —
   * 在典型 XAA 配置中，MCP URL 与 AS URL 不同。
   */
  authorizationServerUrl: string
}

/**
 * RFC 7523 JWT Bearer 授权：ID-JAG → access_token（在 AS 侧执行）
 *
 * 作用：向 AS 的 token endpoint 发送 JWT Bearer 授权请求，将 ID-JAG 令牌
 * 换取最终的 MCP access_token。
 *
 * 流程：
 * 1. 构建请求参数：grant_type=jwt-bearer + assertion（ID-JAG 值）
 * 2. 根据 authMethod 决定客户端认证方式：
 *    - client_secret_basic（默认）：Base64 编码 clientId:clientSecret 放入 Authorization 头
 *    - client_secret_post：将 clientId 和 clientSecret 放入请求体
 * 3. 发送 POST 请求，脱敏处理错误响应
 * 4. 解析并验证响应结构
 *
 * 注意：authMethod 默认为 client_secret_basic，符合 SEP-990 合规测试要求
 *
 * @param opts.tokenEndpoint AS 的 token endpoint URL
 * @param opts.assertion ID-JAG 令牌值
 * @param opts.clientId AS 侧注册的客户端 ID
 * @param opts.clientSecret AS 侧的客户端密钥
 * @param opts.authMethod 认证方式（默认 client_secret_basic）
 */
export async function exchangeJwtAuthGrant(opts: {
  tokenEndpoint: string
  assertion: string
  clientId: string
  clientSecret: string
  authMethod?: 'client_secret_basic' | 'client_secret_post'
  scope?: string
  fetchFn?: FetchLike
}): Promise<XaaTokenResult> {
  const fetchFn = opts.fetchFn ?? defaultFetch
  // 默认使用 client_secret_basic（Base64 头部认证），符合 SEP-990 合规要求
  const authMethod = opts.authMethod ?? 'client_secret_basic'

  // 构建基础请求参数
  const params = new URLSearchParams({
    grant_type: JWT_BEARER_GRANT,
    assertion: opts.assertion,
  })
  if (opts.scope) {
    params.set('scope', opts.scope)
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
  }
  if (authMethod === 'client_secret_basic') {
    // client_secret_basic：将 clientId:clientSecret URL 编码后 Base64 放入 Authorization 头
    const basicAuth = Buffer.from(
      `${encodeURIComponent(opts.clientId)}:${encodeURIComponent(opts.clientSecret)}`,
    ).toString('base64')
    headers.Authorization = `Basic ${basicAuth}`
  } else {
    // client_secret_post：将凭据放入请求体参数中
    params.set('client_id', opts.clientId)
    params.set('client_secret', opts.clientSecret)
  }

  const res = await fetchFn(opts.tokenEndpoint, {
    method: 'POST',
    headers,
    body: params,
  })
  if (!res.ok) {
    // 脱敏处理错误响应，防止令牌泄漏
    const body = redactTokens(await res.text()).slice(0, 200)
    throw new Error(`XAA: jwt-bearer grant failed: HTTP ${res.status}: ${body}`)
  }
  let rawTokens: unknown
  try {
    rawTokens = await res.json()
  } catch {
    throw new Error(
      `XAA: jwt-bearer grant returned non-JSON (captive portal?) at ${opts.tokenEndpoint}`,
    )
  }
  // 验证响应结构
  const tokensParsed = JwtBearerResponseSchema().safeParse(rawTokens)
  if (!tokensParsed.success) {
    throw new Error(
      `XAA: jwt-bearer response did not match expected shape: ${redactTokens(rawTokens)}`,
    )
  }
  return tokensParsed.data
}

// ─── Layer 3: Orchestrator ──────────────────────────────────────────────────

/**
 * XAA 完整流程所需配置
 *
 * 对齐合规测试 context 形状（ClientConformanceContextSchema），
 * 包含 AS 侧和 IdP 侧两组凭据。
 */
export type XaaConfig = {
  /** 在 MCP 服务器的授权服务器（AS）注册的客户端 ID */
  clientId: string
  /** MCP 服务器授权服务器（AS）的客户端密钥 */
  clientSecret: string
  /** 在 IdP 注册的客户端 ID（用于令牌交换请求） */
  idpClientId: string
  /** 可选的 IdP 客户端密钥（client_secret_post），部分 IdP 要求 */
  idpClientSecret?: string
  /** 用户在 IdP 登录后的 OIDC id_token */
  idpIdToken: string
  /** IdP 的 token endpoint（发送 RFC 8693 令牌交换的目标） */
  idpTokenEndpoint: string
}

/**
 * 完整 XAA 流程编排器：PRM 发现 → AS 元数据 → 令牌交换 → JWT Bearer → access_token
 *
 * 作用：组合四个 Layer-2 操作，完成无浏览器参与的企业托管授权完整流程。
 * 被 performMCPXaaAuth、ClaudeAuthProvider.xaaRefresh 和调试脚本使用。
 *
 * 完整流程：
 * 1. PRM 发现：通过 MCP 服务器 URL 发现受保护资源元数据，获取 AS 列表
 * 2. AS 元数据发现：遍历 AS 列表，找到第一个支持 jwt-bearer grant 的 AS
 *    （grant_types_supported 缺失时不跳过，让 token endpoint 自行决定）
 * 3. 认证方式选择：从 AS 的 token_endpoint_auth_methods_supported 选择
 *    client_secret_basic（默认）或 client_secret_post
 * 4. 令牌交换（IdP 侧）：使用 requestJwtAuthorizationGrant 获取 ID-JAG
 * 5. JWT Bearer 授权（AS 侧）：使用 exchangeJwtAuthGrant 获取 access_token
 *
 * @param serverUrl MCP 服务器 URL（如 `https://mcp.example.com/mcp`）
 * @param config IdP + AS 凭据配置
 * @param serverName 用于调试日志的服务器名称标识
 * @param abortSignal 可选的取消信号
 * @returns 包含 access_token 和 authorizationServerUrl 的 XaaResult
 * @throws 若无任何 AS 支持 jwt-bearer，或任意步骤失败
 */
export async function performCrossAppAccess(
  serverUrl: string,
  config: XaaConfig,
  serverName = 'xaa',
  abortSignal?: AbortSignal,
): Promise<XaaResult> {
  // 创建带取消信号的 fetch 函数，整个流程共用
  const fetchFn = makeXaaFetch(abortSignal)

  // 步骤 1：RFC 9728 PRM 发现，获取受保护资源元数据和 AS 列表
  logMCPDebug(serverName, `XAA: discovering PRM for ${serverUrl}`)
  const prm = await discoverProtectedResource(serverUrl, { fetchFn })
  logMCPDebug(
    serverName,
    `XAA: discovered resource=${prm.resource} ASes=[${prm.authorization_servers.join(', ')}]`,
  )

  // 步骤 2：遍历 AS 列表，发现元数据并选择支持 jwt-bearer 的 AS
  // grant_types_supported 为 RFC 8414 §2 可选字段：
  // 若 AS 明确声明支持列表但不含 jwt-bearer，则跳过；若未声明，则让 token endpoint 决定
  let asMeta: AuthorizationServerMetadata | undefined
  const asErrors: string[] = []
  for (const asUrl of prm.authorization_servers) {
    let candidate: AuthorizationServerMetadata
    try {
      candidate = await discoverAuthorizationServer(asUrl, { fetchFn })
    } catch (e) {
      // 用户取消时立即重新抛出，不继续尝试下一个 AS
      if (abortSignal?.aborted) throw e
      asErrors.push(`${asUrl}: ${e instanceof Error ? e.message : String(e)}`)
      continue
    }
    // 若 AS 明确声明不支持 jwt-bearer，跳过此 AS
    if (
      candidate.grant_types_supported &&
      !candidate.grant_types_supported.includes(JWT_BEARER_GRANT)
    ) {
      asErrors.push(
        `${asUrl}: does not advertise jwt-bearer grant (supported: ${candidate.grant_types_supported.join(', ')})`,
      )
      continue
    }
    asMeta = candidate
    break
  }
  // 若所有 AS 均不支持 jwt-bearer，抛出汇总错误
  if (!asMeta) {
    throw new Error(
      `XAA: no authorization server supports jwt-bearer. Tried: ${asErrors.join('; ')}`,
    )
  }
  // 步骤 2.5：从 AS 支持的认证方式中选择：优先 client_secret_basic（SEP-990 合规要求）
  // 仅当 AS 明确不支持 basic 且支持 post 时才使用 post
  const authMethods = asMeta.token_endpoint_auth_methods_supported
  const authMethod: 'client_secret_basic' | 'client_secret_post' =
    authMethods &&
    !authMethods.includes('client_secret_basic') &&
    authMethods.includes('client_secret_post')
      ? 'client_secret_post'
      : 'client_secret_basic'
  logMCPDebug(
    serverName,
    `XAA: AS issuer=${asMeta.issuer} token_endpoint=${asMeta.token_endpoint} auth_method=${authMethod}`,
  )

  // 步骤 3：RFC 8693 令牌交换（IdP 侧）：id_token → ID-JAG
  logMCPDebug(serverName, `XAA: exchanging id_token for ID-JAG at IdP`)
  const jag = await requestJwtAuthorizationGrant({
    tokenEndpoint: config.idpTokenEndpoint,
    audience: asMeta.issuer,
    resource: prm.resource,
    idToken: config.idpIdToken,
    clientId: config.idpClientId,
    clientSecret: config.idpClientSecret,
    fetchFn,
  })
  logMCPDebug(serverName, `XAA: ID-JAG obtained`)

  // 步骤 4：RFC 7523 JWT Bearer 授权（AS 侧）：ID-JAG → access_token
  logMCPDebug(serverName, `XAA: exchanging ID-JAG for access_token at AS`)
  const tokens = await exchangeJwtAuthGrant({
    tokenEndpoint: asMeta.token_endpoint,
    assertion: jag.jwtAuthGrant,
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    authMethod,
    fetchFn,
  })
  logMCPDebug(serverName, `XAA: access_token obtained`)

  // 将 AS 颁发者 URL 附加到结果中，供调用方后续 refresh/revoke 使用
  return { ...tokens, authorizationServerUrl: asMeta.issuer }
}
