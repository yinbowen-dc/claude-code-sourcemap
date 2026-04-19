/**
 * XAA IdP 登录模块 — OIDC authorization_code + PKCE 流程
 *
 * 在 Claude Code 系统流程中的位置：
 * 本文件是 XAA（Cross-App Access）流程的第一步：通过标准 OIDC
 * authorization_code + PKCE 流程，从企业 IdP 获取 id_token 并缓存到密钥链。
 * 这是 XAA "一次浏览器弹窗" 价值主张的核心：用户只需在 IdP 完成一次登录，
 * 后续 N 个 MCP 服务器均可静默授权，无需重复弹出浏览器。
 *
 * 主要功能：
 * - isXaaEnabled：检测 CLAUDE_CODE_ENABLE_XAA 环境变量，判断 XAA 功能是否启用
 * - getXaaIdpSettings：从 settings 读取 xaaIdp 配置（issuer、clientId、callbackPort）
 * - issuerKey：规范化 IdP issuer URL，用于密钥链缓存键
 * - getCachedIdpIdToken：从安全存储读取已缓存的 id_token，并检查过期时间（提前 60 秒视为过期）
 * - saveIdpIdTokenFromJwt：解析 JWT exp 字段，将外部提供的 id_token 写入缓存
 * - discoverOidc：发现 OIDC 配置，路径追加而非替换（兼容 Azure AD、Okta、Keycloak）
 * - waitForCallback：在本地启动回调服务器，等待 OAuth code，含 CSRF 防护和 5 分钟超时
 * - acquireIdpIdToken：主入口，缓存命中则直接返回，否则发起完整 OIDC 登录流程
 *
 * 设计说明：
 * - jwtExp：仅解析 JWT 的 exp 声明用于缓存 TTL，不验证签名（IdP 在 token exchange 时验证）
 * - waitForCallback：监听就绪后才打开浏览器（防止 EADDRINUSE 错误后已打开标签页）
 * - idToken 缓存优先使用 JWT 的 exp 字段，回退到 expires_in（两者可能不同）
 */

import {
  exchangeAuthorization,
  startAuthorization,
} from '@modelcontextprotocol/sdk/client/auth.js'
import {
  type OAuthClientInformation,
  type OpenIdProviderDiscoveryMetadata,
  OpenIdProviderDiscoveryMetadataSchema,
} from '@modelcontextprotocol/sdk/shared/auth.js'
import { randomBytes } from 'crypto'
import { createServer, type Server } from 'http'
import { parse } from 'url'
import xss from 'xss'
import { openBrowser } from '../../utils/browser.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { toError } from '../../utils/errors.js'
import { logMCPDebug } from '../../utils/log.js'
import { getPlatform } from '../../utils/platform.js'
import { getSecureStorage } from '../../utils/secureStorage/index.js'
import { getInitialSettings } from '../../utils/settings/settings.js'
import { jsonParse } from '../../utils/slowOperations.js'
import { buildRedirectUri, findAvailablePort } from './oauthPort.js'

/**
 * 检测 XAA 功能是否启用
 *
 * 作用：通过 CLAUDE_CODE_ENABLE_XAA 环境变量检测 XAA 功能开关。
 * XAA 功能目前为环境变量门控的实验性功能。
 */
export function isXaaEnabled(): boolean {
  return isEnvTruthy(process.env.CLAUDE_CODE_ENABLE_XAA)
}

/** XAA IdP 配置结构 */
export type XaaIdpSettings = {
  issuer: string
  clientId: string
  callbackPort?: number
}

/**
 * 读取 settings.xaaIdp 配置
 *
 * 作用：从 settings 中读取 xaaIdp 字段配置（issuer、clientId、callbackPort）。
 * xaaIdp 字段在 SettingsSchema 中受环境变量门控，不会出现在 SDK 类型/文档中，
 * 因此编译时类型中不包含此字段，需要通过类型断言读取。此处是唯一的类型断言点。
 *
 * @returns XaaIdpSettings 或 undefined（未配置时）
 */
export function getXaaIdpSettings(): XaaIdpSettings | undefined {
  // 使用类型断言读取 env-gated 字段，这是唯一的类型断言点
  return (getInitialSettings() as { xaaIdp?: XaaIdpSettings }).xaaIdp
}

// IdP 登录总超时时间：5 分钟（用户需要在此时间内完成浏览器授权）
const IDP_LOGIN_TIMEOUT_MS = 5 * 60 * 1000
// 单次 HTTP 请求超时：30 秒（OIDC discovery 和 token exchange 使用）
const IDP_REQUEST_TIMEOUT_MS = 30000
// id_token 过期时间提前量：提前 60 秒视为过期，防止在请求途中令牌失效
const ID_TOKEN_EXPIRY_BUFFER_S = 60

/** IdP 登录参数选项 */
export type IdpLoginOptions = {
  idpIssuer: string
  idpClientId: string
  /**
   * 可选的 IdP 客户端密钥（适用于机密客户端）。认证方式
   * （client_secret_post、client_secret_basic、none）根据 IdP 元数据选择。
   * 公共客户端（仅 PKCE）可省略此项。
   */
  idpClientSecret?: string
  /**
   * 固定回调端口。省略时随机选择可用端口。
   * 当 IdP 客户端已预注册特定回调 URI 时使用
   * （RFC 8252 §7.3 建议 IdP 应接受任意端口的 localhost，但许多 IdP 不支持）。
   */
  callbackPort?: number
  /** 获得授权 URL 后的回调（在打开浏览器之前或代替打开浏览器） */
  onAuthorizationUrl?: (url: string) => void
  /** 若为 true，不自动打开浏览器，仅调用 onAuthorizationUrl */
  skipBrowserOpen?: boolean
  abortSignal?: AbortSignal
}

/**
 * 规范化 IdP issuer URL，用于密钥链缓存键
 *
 * 作用：将 issuer URL 规范化（去除末尾斜杠、小写 host），确保来自配置和
 * OIDC 发现的 issuer URL 在外观上有微小差异时仍能命中同一缓存槽位。
 * 已导出，供 setup 命令在比对 issuer 时使用相同的规范化逻辑。
 *
 * @param issuer IdP issuer URL
 * @returns 规范化后的 URL 字符串
 */
export function issuerKey(issuer: string): string {
  try {
    const u = new URL(issuer)
    // 去除 pathname 末尾斜杠
    u.pathname = u.pathname.replace(/\/+$/, '')
    // 小写 host 部分
    u.host = u.host.toLowerCase()
    return u.toString()
  } catch {
    // URL 解析失败时，仅去除末尾斜杠
    return issuer.replace(/\/+$/, '')
  }
}

/**
 * 从安全存储读取已缓存的 id_token
 *
 * 作用：检查给定 IdP issuer 对应的 id_token 是否缓存且未过期。
 * 提前 60 秒视为过期（ID_TOKEN_EXPIRY_BUFFER_S），防止请求途中令牌失效。
 *
 * @param idpIssuer IdP issuer URL
 * @returns 有效的 id_token 字符串，或 undefined（无缓存或已过期）
 */
export function getCachedIdpIdToken(idpIssuer: string): string | undefined {
  const storage = getSecureStorage()
  const data = storage.read()
  // 使用规范化后的 issuer 作为键读取缓存条目
  const entry = data?.mcpXaaIdp?.[issuerKey(idpIssuer)]
  if (!entry) return undefined
  // 检查是否在提前量内即将过期
  const remainingMs = entry.expiresAt - Date.now()
  if (remainingMs <= ID_TOKEN_EXPIRY_BUFFER_S * 1000) return undefined
  return entry.idToken
}

/**
 * 将 id_token 写入安全存储缓存
 *
 * 作用：以规范化的 issuerKey 为键，将 id_token 和过期时间写入安全存储
 * 的 mcpXaaIdp 字段，供下次使用时通过 getCachedIdpIdToken 读取。
 *
 * @param idpIssuer IdP issuer URL
 * @param idToken 要缓存的 id_token 字符串
 * @param expiresAt 过期时间（Unix 毫秒时间戳）
 */
function saveIdpIdToken(
  idpIssuer: string,
  idToken: string,
  expiresAt: number,
): void {
  const storage = getSecureStorage()
  const existing = storage.read() || {}
  storage.update({
    ...existing,
    mcpXaaIdp: {
      ...existing.mcpXaaIdp,
      // 使用规范化 issuer 作为键存储令牌和过期时间
      [issuerKey(idpIssuer)]: { idToken, expiresAt },
    },
  })
}

/**
 * 将外部提供的 id_token 写入 XAA 缓存
 *
 * 作用：供合规测试使用，Mock IdP 会提供预签名的 id_token 但不提供 /authorize 端点。
 * 解析 JWT 的 exp 声明作为缓存 TTL（与 acquireIdpIdToken 逻辑一致）。
 * 已导出，供调用方获取计算出的 expiresAt 用于日志输出。
 *
 * @param idpIssuer IdP issuer URL
 * @param idToken 外部提供的 id_token JWT 字符串
 * @returns 计算出的过期时间（Unix 毫秒时间戳）
 */
export function saveIdpIdTokenFromJwt(
  idpIssuer: string,
  idToken: string,
): number {
  // 从 JWT payload 解析 exp 字段
  const expFromJwt = jwtExp(idToken)
  // exp 字段存在则用 JWT 自身的过期时间，否则默认 1 小时
  const expiresAt = expFromJwt ? expFromJwt * 1000 : Date.now() + 3600 * 1000
  saveIdpIdToken(idpIssuer, idToken, expiresAt)
  return expiresAt
}

/**
 * 清除指定 IdP 的缓存 id_token
 *
 * 作用：当 id_token 被 XAA 流程判定为无效（shouldClearIdToken=true）时，
 * 从安全存储中删除对应缓存条目，强制下次重新登录。
 *
 * @param idpIssuer IdP issuer URL
 */
export function clearIdpIdToken(idpIssuer: string): void {
  const storage = getSecureStorage()
  const existing = storage.read()
  const key = issuerKey(idpIssuer)
  // 若不存在则直接返回，无需更新存储
  if (!existing?.mcpXaaIdp?.[key]) return
  delete existing.mcpXaaIdp[key]
  storage.update(existing)
}

/**
 * 将 IdP 客户端密钥写入安全存储
 *
 * 作用：保存 IdP 侧的客户端密钥，与 MCP 服务器 AS 的密钥分开存储（不同信任域）。
 * 返回存储更新结果，供调用方检测密钥链故障（钥匙串锁定、security 命令非零退出），
 * 避免静默丢失密钥导致后续出现 invalid_client 错误。
 *
 * @param idpIssuer IdP issuer URL
 * @param clientSecret 要保存的客户端密钥
 * @returns 存储更新结果，含 success 标志和可选的警告信息
 */
export function saveIdpClientSecret(
  idpIssuer: string,
  clientSecret: string,
): { success: boolean; warning?: string } {
  const storage = getSecureStorage()
  const existing = storage.read() || {}
  return storage.update({
    ...existing,
    mcpXaaIdpConfig: {
      ...existing.mcpXaaIdpConfig,
      [issuerKey(idpIssuer)]: { clientSecret },
    },
  })
}

/**
 * 从安全存储读取指定 IdP 的客户端密钥
 *
 * @param idpIssuer IdP issuer URL
 * @returns 客户端密钥字符串，或 undefined（未存储时）
 */
export function getIdpClientSecret(idpIssuer: string): string | undefined {
  const storage = getSecureStorage()
  const data = storage.read()
  return data?.mcpXaaIdpConfig?.[issuerKey(idpIssuer)]?.clientSecret
}

/**
 * 从安全存储删除指定 IdP 的客户端密钥
 *
 * 作用：供 `claude mcp xaa clear` 命令使用，清除指定 IdP 的客户端密钥配置。
 *
 * @param idpIssuer IdP issuer URL
 */
export function clearIdpClientSecret(idpIssuer: string): void {
  const storage = getSecureStorage()
  const existing = storage.read()
  const key = issuerKey(idpIssuer)
  if (!existing?.mcpXaaIdpConfig?.[key]) return
  delete existing.mcpXaaIdpConfig[key]
  storage.update(existing)
}

/**
 * OIDC 发现文档获取与验证
 *
 * 作用：获取 IdP 的 OIDC 配置文档（/.well-known/openid-configuration）。
 *
 * 重要的路径处理逻辑：
 * OIDC 发现规范 §4.1 要求路径为 `{issuer}/.well-known/openid-configuration`（路径追加）。
 * 不能使用 `new URL('/.well-known/...', issuer)` 加前导斜杠，因为这是 WHATWG 绝对路径引用
 * 会丢弃 issuer 的 pathname，破坏以下场景：
 * - Azure AD（login.microsoftonline.com/{tenant}/v2.0）
 * - Okta 自定义授权服务器
 * - Keycloak realm
 * 正确做法：末尾斜杠 base + 相对路径。
 *
 * 已导出，供 auth.ts 使用相同的发现逻辑。
 *
 * @param idpIssuer IdP issuer URL
 * @returns 解析后的 OIDC Provider 元数据
 * @throws 若 HTTP 请求失败、返回非 JSON（强制门户）、结构无效或 token endpoint 非 HTTPS
 */
export async function discoverOidc(
  idpIssuer: string,
): Promise<OpenIdProviderDiscoveryMetadata> {
  // 确保 base URL 以斜杠结尾，再追加相对路径（避免绝对路径引用覆盖 pathname）
  const base = idpIssuer.endsWith('/') ? idpIssuer : idpIssuer + '/'
  const url = new URL('.well-known/openid-configuration', base)
  // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(IDP_REQUEST_TIMEOUT_MS),
  })
  if (!res.ok) {
    throw new Error(
      `XAA IdP: OIDC discovery failed: HTTP ${res.status} at ${url}`,
    )
  }
  // 强制门户和代理认证页面会返回 200 但内容是 HTML
  // res.json() 会抛出原始 SyntaxError，使用 try/catch 给出更友好的错误信息
  let body: unknown
  try {
    body = await res.json()
  } catch {
    throw new Error(
      `XAA IdP: OIDC discovery returned non-JSON at ${url} (captive portal or proxy?)`,
    )
  }
  // 使用 MCP SDK 的 Schema 验证元数据结构
  const parsed = OpenIdProviderDiscoveryMetadataSchema.safeParse(body)
  if (!parsed.success) {
    throw new Error(`XAA IdP: invalid OIDC metadata: ${parsed.error.message}`)
  }
  // 强制要求 HTTPS token endpoint，防止令牌明文传输
  if (new URL(parsed.data.token_endpoint).protocol !== 'https:') {
    throw new Error(
      `XAA IdP: refusing non-HTTPS token endpoint: ${parsed.data.token_endpoint}`,
    )
  }
  return parsed.data
}

/**
 * 从 JWT 中解析 exp 声明（不验证签名）
 *
 * 作用：仅用于从 id_token 中提取过期时间作为缓存 TTL，不做完整 JWT 验证。
 *
 * 不验证签名/iss/aud/nonce 的原因（安全分析）：
 * 按 SEP-990，此 id_token 是 RFC 8693 token exchange 中 IdP 自身 token endpoint 的
 * subject_token。IdP 会在 token exchange 时验证自己颁发的令牌。
 * 攻击者若能伪造令牌欺骗 IdP，则无需先欺骗我们；若不能，则会在 IdP 处得到 401。
 * 客户端验证会增加代码复杂度但不提升安全性。
 *
 * @param jwt JWT 字符串
 * @returns exp 字段值（Unix 秒时间戳），解析失败或不含 exp 时返回 undefined
 */
function jwtExp(jwt: string): number | undefined {
  // JWT 由三部分组成（header.payload.signature），验证格式
  const parts = jwt.split('.')
  if (parts.length !== 3) return undefined
  try {
    // Base64url 解码 payload 部分，解析为 JSON
    const payload = jsonParse(
      Buffer.from(parts[1]!, 'base64url').toString('utf-8'),
    ) as { exp?: number }
    return typeof payload.exp === 'number' ? payload.exp : undefined
  } catch {
    return undefined
  }
}

/**
 * 在本地启动 OAuth 回调服务器，等待授权码
 *
 * 作用：在本地 127.0.0.1:port 启动 HTTP 服务器，等待 OAuth 授权码回调。
 * 包含 CSRF 防护（state 参数匹配）、5 分钟超时和取消信号支持。
 *
 * 重要设计：onListening 在 socket 实际绑定后才触发（listen 是异步的），
 * 用于延迟打开浏览器，确保 EADDRINUSE 在弹出标签页之前就能被检测到。
 *
 * 安全特性：
 * - 仅接受 /callback 路径的请求
 * - 使用 xss() 过滤错误信息，防止 XSS
 * - state 参数不匹配时返回 400 并拒绝 Promise（CSRF 防护）
 *
 * @param port 监听端口
 * @param expectedState CSRF 防护用的 state 参数期望值
 * @param abortSignal 外部取消信号
 * @param onListening 服务器实际开始监听时的回调（此时打开浏览器）
 * @returns 授权码字符串
 */
function waitForCallback(
  port: number,
  expectedState: string,
  abortSignal: AbortSignal | undefined,
  onListening: () => void,
): Promise<string> {
  let server: Server | null = null
  let timeoutId: NodeJS.Timeout | null = null
  let abortHandler: (() => void) | null = null
  // cleanup：关闭服务器、清除定时器、移除取消事件监听器
  const cleanup = () => {
    server?.removeAllListeners()
    // 防御性处理：removeAllListeners() 会移除 error handler，在 close 期间吞掉后续错误
    server?.on('error', () => {})
    server?.close()
    server = null
    if (timeoutId) {
      clearTimeout(timeoutId)
      timeoutId = null
    }
    if (abortSignal && abortHandler) {
      abortSignal.removeEventListener('abort', abortHandler)
      abortHandler = null
    }
  }
  return new Promise<string>((resolve, reject) => {
    let resolved = false
    // resolveOnce/rejectOnce：确保 Promise 只被结算一次，防止多次调用
    const resolveOnce = (v: string) => {
      if (resolved) return
      resolved = true
      cleanup()
      resolve(v)
    }
    const rejectOnce = (e: Error) => {
      if (resolved) return
      resolved = true
      cleanup()
      reject(e)
    }

    // 注册取消信号处理器：用户取消时立即 reject
    if (abortSignal) {
      abortHandler = () => rejectOnce(new Error('XAA IdP: login cancelled'))
      // 若信号已经触发，立即取消
      if (abortSignal.aborted) {
        abortHandler()
        return
      }
      abortSignal.addEventListener('abort', abortHandler, { once: true })
    }

    // 创建本地 HTTP 服务器处理 OAuth 回调
    server = createServer((req, res) => {
      const parsed = parse(req.url || '', true)
      // 仅处理 /callback 路径
      if (parsed.pathname !== '/callback') {
        res.writeHead(404)
        res.end()
        return
      }
      const code = parsed.query.code as string | undefined
      const state = parsed.query.state as string | undefined
      const err = parsed.query.error as string | undefined

      // IdP 返回错误参数时，展示 XSS 过滤后的错误页面并 reject
      if (err) {
        const desc = parsed.query.error_description as string | undefined
        const safeErr = xss(err)
        const safeDesc = desc ? xss(desc) : ''
        res.writeHead(400, { 'Content-Type': 'text/html' })
        res.end(
          `<html><body><h3>IdP login failed</h3><p>${safeErr}</p><p>${safeDesc}</p></body></html>`,
        )
        rejectOnce(new Error(`XAA IdP: ${err}${desc ? ` — ${desc}` : ''}`))
        return
      }

      // CSRF 防护：验证 state 参数匹配
      if (state !== expectedState) {
        res.writeHead(400, { 'Content-Type': 'text/html' })
        res.end('<html><body><h3>State mismatch</h3></body></html>')
        rejectOnce(new Error('XAA IdP: state mismatch (possible CSRF)'))
        return
      }

      // 缺少授权码时报错
      if (!code) {
        res.writeHead(400, { 'Content-Type': 'text/html' })
        res.end('<html><body><h3>Missing code</h3></body></html>')
        rejectOnce(new Error('XAA IdP: callback missing code'))
        return
      }

      // 成功获取授权码：返回成功页面并 resolve
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end(
        '<html><body><h3>IdP login complete — you can close this window.</h3></body></html>',
      )
      resolveOnce(code)
    })

    // 服务器错误处理（如端口占用）
    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        // 提供平台特定的端口占用诊断命令
        const findCmd =
          getPlatform() === 'windows'
            ? `netstat -ano | findstr :${port}`
            : `lsof -ti:${port} -sTCP:LISTEN`
        rejectOnce(
          new Error(
            `XAA IdP: callback port ${port} is already in use. Run \`${findCmd}\` to find the holder.`,
          ),
        )
      } else {
        rejectOnce(new Error(`XAA IdP: callback server failed: ${err.message}`))
      }
    })

    // 监听本地回调端口（仅接受 localhost 连接）
    server.listen(port, '127.0.0.1', () => {
      try {
        // 服务器实际绑定后触发回调（此时安全打开浏览器）
        onListening()
      } catch (e) {
        rejectOnce(toError(e))
      }
    })
    // server.unref()：允许 Node.js 进程在等待回调时正常退出（如果用户关闭程序）
    server.unref()
    // 5 分钟超时：用户未完成浏览器授权时 reject
    timeoutId = setTimeout(
      rej => rej(new Error('XAA IdP: login timed out')),
      IDP_LOGIN_TIMEOUT_MS,
      rejectOnce,
    )
    // timeoutId.unref()：超时计时器不阻止进程退出
    timeoutId.unref()
  })
}

/**
 * 获取 IdP id_token：缓存命中则直接返回，否则发起完整 OIDC 登录流程
 *
 * 作用：这是 XAA IdP 登录的主入口。实现了 "一次浏览器弹窗" 的核心逻辑：
 * 缓存有效时直接返回，无需任何用户交互；缓存过期时发起完整的
 * OIDC authorization_code + PKCE 流程。
 *
 * 完整流程（缓存未命中时）：
 * 1. OIDC 发现：获取 IdP 的 openid-configuration（discoverOidc）
 * 2. 端口选择：优先使用配置的固定端口，否则随机选择可用端口
 * 3. 授权请求：通过 MCP SDK 的 startAuthorization 生成授权 URL 和 PKCE 参数
 * 4. 等待回调：启动本地服务器等待授权码（waitForCallback）
 * 5. 服务器就绪后：调用 onAuthorizationUrl 并（可选地）打开浏览器
 * 6. 令牌交换：通过 MCP SDK 的 exchangeAuthorization 将授权码换取 token
 * 7. 缓存写入：优先用 JWT exp 字段，回退到 expires_in，默认 1 小时
 *
 * @param opts 登录选项（issuer、clientId、可选的 callbackPort、取消信号等）
 * @returns id_token 字符串
 * @throws 若任意步骤失败（OIDC 发现错误、端口占用、state 不匹配、token 缺少 id_token 等）
 */
export async function acquireIdpIdToken(
  opts: IdpLoginOptions,
): Promise<string> {
  const { idpIssuer, idpClientId } = opts

  // 优先使用缓存的 id_token（提前 60 秒视为过期）
  const cached = getCachedIdpIdToken(idpIssuer)
  if (cached) {
    logMCPDebug('xaa', `Using cached id_token for ${idpIssuer}`)
    return cached
  }

  logMCPDebug('xaa', `No cached id_token for ${idpIssuer}; starting OIDC login`)

  // 步骤 1：发现 IdP 的 OIDC 元数据
  const metadata = await discoverOidc(idpIssuer)
  // 步骤 2：选择回调端口（固定端口或随机可用端口）
  const port = opts.callbackPort ?? (await findAvailablePort())
  const redirectUri = buildRedirectUri(port)
  // 生成 CSRF 防护用的随机 state 参数
  const state = randomBytes(32).toString('base64url')
  const clientInformation: OAuthClientInformation = {
    client_id: idpClientId,
    // 若有客户端密钥则包含（机密客户端），否则省略（公共客户端）
    ...(opts.idpClientSecret ? { client_secret: opts.idpClientSecret } : {}),
  }

  // 步骤 3：生成授权 URL 和 PKCE 参数
  const { authorizationUrl, codeVerifier } = await startAuthorization(
    idpIssuer,
    {
      metadata,
      clientInformation,
      redirectUrl: redirectUri,
      scope: 'openid', // 仅请求 openid scope 以获取 id_token
      state,
    },
  )

  // 步骤 4 + 5：等待授权码，服务器就绪后才打开浏览器
  // 在 listen 回调中打开浏览器，防止固定端口时 EADDRINUSE 在弹出标签页后才暴露
  const authorizationCode = await waitForCallback(
    port,
    state,
    opts.abortSignal,
    () => {
      // 服务器已绑定：通知调用方授权 URL
      if (opts.onAuthorizationUrl) {
        opts.onAuthorizationUrl(authorizationUrl.toString())
      }
      // 若未设置 skipBrowserOpen，则自动打开浏览器
      if (!opts.skipBrowserOpen) {
        logMCPDebug('xaa', `Opening browser to IdP authorization endpoint`)
        void openBrowser(authorizationUrl.toString())
      }
    },
  )

  // 步骤 6：用授权码换取 token（含 id_token）
  const tokens = await exchangeAuthorization(idpIssuer, {
    metadata,
    clientInformation,
    authorizationCode,
    codeVerifier,
    redirectUri,
    fetchFn: (url, init) =>
      // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
      fetch(url, {
        ...init,
        signal: AbortSignal.timeout(IDP_REQUEST_TIMEOUT_MS),
      }),
  })
  // 验证响应包含 id_token（需要 scope=openid）
  if (!tokens.id_token) {
    throw new Error(
      'XAA IdP: token response missing id_token (check scope=openid)',
    )
  }

  // 步骤 7：计算过期时间并写入缓存
  // 优先使用 id_token JWT 自身的 exp 声明（而非 access_token 的 expires_in，两者可能不同）
  const expFromJwt = jwtExp(tokens.id_token)
  const expiresAt = expFromJwt
    ? expFromJwt * 1000
    : Date.now() + (tokens.expires_in ?? 3600) * 1000

  saveIdpIdToken(idpIssuer, tokens.id_token, expiresAt)
  logMCPDebug(
    'xaa',
    `Cached id_token for ${idpIssuer} (expires ${new Date(expiresAt).toISOString()})`,
  )

  return tokens.id_token
}
