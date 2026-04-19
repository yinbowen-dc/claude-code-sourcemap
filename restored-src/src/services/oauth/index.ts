/**
 * OAuth 2.0 授权码流程服务模块（PKCE）
 *
 * 在 Claude Code 系统流程中的位置：
 * 本文件是 OAuth 子系统的顶层编排层，封装完整的 OAuth 2.0 授权码流程（含 PKCE）。
 * 它位于以下层次结构中：
 *   - 调用方：auth.ts（installOAuthTokens）、claude_authenticate SDK 控制协议
 *   - 本模块：OAuthService 类，编排完整 OAuth 流程
 *   - 下层：AuthCodeListener（回调捕获）、client.ts（令牌交换/刷新）、crypto.ts（PKCE 工具）
 *
 * 主要功能：
 * - OAuthService 类：维护单次 OAuth 会话状态（codeVerifier、port、pendingResolver 等）
 * - startOAuthFlow：启动完整 PKCE 流程，支持自动（浏览器重定向）和 skipBrowserOpen（SDK 协议）两种模式
 * - waitForAuthorizationCode：同时监听自动（localhost 回调）和手动（paste code）两条路径的 race
 * - handleManualAuthCodeInput：处理用户手动粘贴授权码的场景
 * - formatTokens：将令牌交换响应格式化为统一的 OAuthTokens 对象
 * - cleanup：关闭监听服务器，释放资源
 *
 * 设计说明：
 * - skipBrowserOpen 选项：由 SDK 控制协议（claude_authenticate）使用，调用方拥有用户显示权，
 *   两条 URL（自动 + 手动）均通过 authURLHandler 传递给调用方
 * - waitForAuthorizationCode 实现 race 模式：authCodeListener（自动）和 manualAuthCodeResolver（手动）
 *   任意一个先完成即 resolve，另一个被忽略
 */

import { logEvent } from 'src/services/analytics/index.js'
import { openBrowser } from '../../utils/browser.js'
import { AuthCodeListener } from './auth-code-listener.js'
import * as client from './client.js'
import * as crypto from './crypto.js'
import type {
  OAuthProfileResponse,
  OAuthTokenExchangeResponse,
  OAuthTokens,
  RateLimitTier,
  SubscriptionType,
} from './types.js'

/**
 * OAuth service that handles the OAuth 2.0 authorization code flow with PKCE.
 *
 * Supports two ways to get authorization codes:
 * 1. Automatic: Opens browser, redirects to localhost where we capture the code
 * 2. Manual: User manually copies and pastes the code (used in non-browser environments)
 *
 * OAuth 2.0 PKCE 授权码流程服务类
 *
 * 支持两种获取授权码的方式：
 * 1. 自动模式：打开浏览器，授权后重定向到 localhost 监听服务器自动捕获授权码
 * 2. 手动模式：用户手动复制粘贴授权码（用于无浏览器环境或 SDK 调用）
 */
export class OAuthService {
  // PKCE 核心秘密：在构造时生成，贯穿整个授权流程
  private codeVerifier: string
  // 本地 HTTP 监听服务器（自动模式专用）
  private authCodeListener: AuthCodeListener | null = null
  // 监听服务器实际绑定的端口号
  private port: number | null = null
  // 手动模式的 Promise resolve 函数（用户粘贴授权码时调用）
  private manualAuthCodeResolver: ((authorizationCode: string) => void) | null =
    null

  constructor() {
    // 在实例创建时立即生成 code_verifier（RFC 7636 要求高熵随机值）
    this.codeVerifier = crypto.generateCodeVerifier()
  }

  /**
   * 启动完整的 OAuth 2.0 PKCE 授权码流程
   *
   * 完整流程：
   * 1. 创建 AuthCodeListener 并绑定端口（获取 OS 分配的可用端口）
   * 2. 生成 PKCE 参数（codeChallenge）和 CSRF 防护参数（state）
   * 3. 构建手动模式 URL 和自动模式 URL（两者 isManual 参数不同）
   * 4. 调用 waitForAuthorizationCode：race 自动流和手动流
   *    - skipBrowserOpen=false（默认）：调用 authURLHandler 展示手动链接，然后 openBrowser 打开自动链接
   *    - skipBrowserOpen=true（SDK 模式）：两个 URL 均通过 authURLHandler 传给调用方
   * 5. 判断授权码来源（automatic vs manual），记录分析事件
   * 6. 调用 exchangeCodeForTokens 换取访问令牌（15s 超时）
   * 7. 调用 fetchProfileInfo 获取订阅类型和速率限制等级
   * 8. 自动模式下发送成功重定向（handleSuccessRedirect）；失败时发送错误重定向
   * 9. 调用 formatTokens 将响应格式化为 OAuthTokens
   * 10. finally 块中始终调用 authCodeListener.close() 释放端口
   *
   * @param authURLHandler 授权 URL 处理器（展示链接或打开浏览器等）
   * @param options 可选配置项
   * @returns 完整的 OAuthTokens 对象
   */
  async startOAuthFlow(
    authURLHandler: (url: string, automaticUrl?: string) => Promise<void>,
    options?: {
      loginWithClaudeAi?: boolean
      inferenceOnly?: boolean
      expiresIn?: number
      orgUUID?: string
      loginHint?: string
      loginMethod?: string
      /**
       * Don't call openBrowser(). Caller takes both URLs via authURLHandler
       * and decides how/where to open them. Used by the SDK control protocol
       * (claude_authenticate) where the SDK client owns the user's display,
       * not this process.
       */
      skipBrowserOpen?: boolean
    },
  ): Promise<OAuthTokens> {
    // Create OAuth callback listener and start it
    // 创建本地回调监听器并绑定端口（port=0 让 OS 分配可用端口）
    this.authCodeListener = new AuthCodeListener()
    this.port = await this.authCodeListener.start()

    // Generate PKCE values and state
    // 基于已生成的 code_verifier 计算 code_challenge（SHA-256 + base64url）
    const codeChallenge = crypto.generateCodeChallenge(this.codeVerifier)
    // 生成 CSRF 防护用随机 state 参数
    const state = crypto.generateState()

    // Build auth URLs for both automatic and manual flows
    // 提取公共参数，分别构建手动和自动模式的授权 URL
    const opts = {
      codeChallenge,
      state,
      port: this.port,
      loginWithClaudeAi: options?.loginWithClaudeAi,
      inferenceOnly: options?.inferenceOnly,
      orgUUID: options?.orgUUID,
      loginHint: options?.loginHint,
      loginMethod: options?.loginMethod,
    }
    // 手动模式：使用固定 MANUAL_REDIRECT_URL，用户从该页面复制授权码
    const manualFlowUrl = client.buildAuthUrl({ ...opts, isManual: true })
    // 自动模式：使用 localhost:port/callback，授权后浏览器自动重定向到本地监听服务器
    const automaticFlowUrl = client.buildAuthUrl({ ...opts, isManual: false })

    // Wait for either automatic or manual auth code
    // 同时监听两条路径，任意一条先完成即获取授权码
    const authorizationCode = await this.waitForAuthorizationCode(
      state,
      async () => {
        if (options?.skipBrowserOpen) {
          // Hand both URLs to the caller. The automatic one still works
          // if the caller opens it on the same host (localhost listener
          // is running); the manual one works from anywhere.
          // SDK 模式：两个 URL 均传给调用方，由调用方决定如何展示
          await authURLHandler(manualFlowUrl, automaticFlowUrl)
        } else {
          // 标准模式：展示手动链接（authURLHandler），同时打开浏览器（自动流）
          await authURLHandler(manualFlowUrl) // Show manual option to user
          await openBrowser(automaticFlowUrl) // Try automatic flow
        }
      },
    )

    // Check if the automatic flow is still active (has a pending response)
    // 通过检查 pendingResponse 判断授权码来自自动流（有挂起响应）还是手动流
    const isAutomaticFlow = this.authCodeListener?.hasPendingResponse() ?? false
    logEvent('tengu_oauth_auth_code_received', { automatic: isAutomaticFlow })

    try {
      // Exchange authorization code for tokens
      // 用授权码换取访问令牌（含 PKCE code_verifier 验证）
      const tokenResponse = await client.exchangeCodeForTokens(
        authorizationCode,
        state,
        this.codeVerifier,
        this.port!,
        !isAutomaticFlow, // Pass isManual=true if it's NOT automatic flow
        options?.expiresIn,
      )

      // Fetch profile info (subscription type and rate limit tier) for the
      // returned OAuthTokens. Logout and account storage are handled by the
      // caller (installOAuthTokens in auth.ts).
      // 获取用户 profile（订阅类型、速率等级等）—— 账户存储由调用方（installOAuthTokens）负责
      const profileInfo = await client.fetchProfileInfo(
        tokenResponse.access_token,
      )

      // Handle success redirect for automatic flow
      // 自动模式：令牌获取成功后，将用户浏览器重定向到成功页面
      if (isAutomaticFlow) {
        const scopes = client.parseScopes(tokenResponse.scope)
        this.authCodeListener?.handleSuccessRedirect(scopes)
      }

      // 格式化并返回统一的 OAuthTokens 对象
      return this.formatTokens(
        tokenResponse,
        profileInfo.subscriptionType,
        profileInfo.rateLimitTier,
        profileInfo.rawProfile,
      )
    } catch (error) {
      // If we have a pending response, send an error redirect before closing
      // 令牌交换或 profile 获取失败：向浏览器发送错误重定向（避免浏览器停留在等待页面）
      if (isAutomaticFlow) {
        this.authCodeListener?.handleErrorRedirect()
      }
      throw error
    } finally {
      // Always cleanup
      // 无论成功或失败，始终关闭本地监听服务器（释放端口）
      this.authCodeListener?.close()
    }
  }

  /**
   * 等待授权码（自动流和手动流的 race）
   *
   * 实现双路竞争模式：
   * 1. 保存 manualAuthCodeResolver（供 handleManualAuthCodeInput 调用）
   * 2. 启动 authCodeListener.waitForAuthorization（自动模式，监听 localhost 回调）
   * 3. 两条路径均指向同一个外层 Promise 的 resolve/reject
   * 4. 任意一条先完成即 resolve 该 Promise，另一条的结果被忽略
   *
   * @param state CSRF 防护用 state 参数（传给 AuthCodeListener 用于校验）
   * @param onReady 服务器就绪回调（通常在此打开浏览器或展示授权链接）
   * @returns 授权码字符串（Promise）
   */
  private async waitForAuthorizationCode(
    state: string,
    onReady: () => Promise<void>,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      // Set up manual auth code resolver
      // 保存手动流的 resolve 函数，供外部 handleManualAuthCodeInput 调用
      this.manualAuthCodeResolver = resolve

      // Start automatic flow
      // 启动自动流：AuthCodeListener 监听 localhost 回调，获取授权码后 resolve 外层 Promise
      this.authCodeListener
        ?.waitForAuthorization(state, onReady)
        .then(authorizationCode => {
          // 自动流完成：清空手动流 resolver（防止重复 resolve），然后 resolve 外层 Promise
          this.manualAuthCodeResolver = null
          resolve(authorizationCode)
        })
        .catch(error => {
          // 自动流失败（如服务器错误）：reject 外层 Promise
          this.manualAuthCodeResolver = null
          reject(error)
        })
    })
  }

  /**
   * 处理手动授权码输入（用户粘贴授权码时调用）
   *
   * 当用户从手动模式页面复制授权码并粘贴时，此方法被调用：
   * 1. 若 manualAuthCodeResolver 存在（等待中），调用它 resolve 外层 Promise
   * 2. 清空 resolver，防止重复调用
   * 3. 关闭本地监听服务器（手动模式不再需要自动监听）
   *
   * @param params 含 authorizationCode 和 state 的对象
   */
  // Handle manual flow callback when user pastes the auth code
  handleManualAuthCodeInput(params: {
    authorizationCode: string
    state: string
  }): void {
    if (this.manualAuthCodeResolver) {
      // 使用手动输入的授权码 resolve 等待中的 Promise
      this.manualAuthCodeResolver(params.authorizationCode)
      this.manualAuthCodeResolver = null
      // Close the auth code listener since manual input was used
      // 手动模式已获取授权码，关闭自动流监听服务器（释放端口）
      this.authCodeListener?.close()
    }
  }

  /**
   * 将令牌交换响应格式化为统一的 OAuthTokens 对象
   *
   * 主要转换：
   * - expiresAt：从相对秒数（expires_in）转为绝对毫秒时间戳（Date.now() + expires_in * 1000）
   * - scopes：调用 parseScopes 将空格分隔字符串转为数组
   * - tokenAccount：若响应含 account 字段，则构建 tokenAccount 子对象
   *
   * @param response 令牌交换原始响应
   * @param subscriptionType 用户订阅类型（从 profile 获取）
   * @param rateLimitTier 速率限制等级（从 profile 获取）
   * @param profile 原始 profile 响应（可选，供调用方缓存）
   * @returns 格式化后的 OAuthTokens 对象
   */
  private formatTokens(
    response: OAuthTokenExchangeResponse,
    subscriptionType: SubscriptionType | null,
    rateLimitTier: RateLimitTier | null,
    profile?: OAuthProfileResponse,
  ): OAuthTokens {
    return {
      accessToken: response.access_token,
      refreshToken: response.refresh_token,
      // 将相对过期时间（秒）转换为绝对过期时间戳（毫秒）
      expiresAt: Date.now() + response.expires_in * 1000,
      // 将空格分隔的 scope 字符串解析为数组
      scopes: client.parseScopes(response.scope),
      subscriptionType,
      rateLimitTier,
      profile,
      // 令牌响应中若含账户信息则构建 tokenAccount 对象
      tokenAccount: response.account
        ? {
            uuid: response.account.uuid,
            emailAddress: response.account.email_address,
            organizationUuid: response.organization?.uuid,
          }
        : undefined,
    }
  }

  /**
   * 清理 OAuth 会话资源
   *
   * 在 OAuth 流程被取消或异常中止时调用，确保：
   * 1. 关闭本地 HTTP 监听服务器（释放端口，避免资源泄漏）
   * 2. 清空手动授权码 resolver（防止内存泄漏）
   */
  // Clean up any resources (like the local server)
  cleanup(): void {
    this.authCodeListener?.close()
    this.manualAuthCodeResolver = null
  }
}
