/**
 * OAuth 授权码重定向监听器
 *
 * 在 Claude Code 系统流程中的位置：
 * 本文件是 OAuth PKCE 授权流程的回调捕获层，在用户通过浏览器完成授权后，
 * 负责接收 OAuth 服务器重定向回来的授权码（authorization code）。
 * 它在 OAuth 流程中的位置：
 *   授权请求 → 浏览器授权 → OAuth 服务器重定向到 localhost → 本模块捕获授权码
 *   → 令牌交换 → 完成 OAuth 流程
 *
 * 主要功能：
 * - AuthCodeListener 类：本地 HTTP 服务器，监听 OAuth 回调重定向
 * - start(port?)：绑定端口（或让 OS 分配可用端口），避免端口竞争
 * - waitForAuthorization(state, onReady)：等待授权码，包含 CSRF state 验证
 * - handleSuccessRedirect：授权成功后将浏览器重定向到成功页面
 * - handleErrorRedirect：授权失败时将浏览器重定向到错误页面
 * - close：关闭服务器，若有未处理的挂起响应则先发送错误重定向
 *
 * 设计说明：
 * - 服务器在 start() 时即开始监听，waitForAuthorization 调用时服务器已就绪
 * - state 参数用于 CSRF 防护，必须与请求时的 state 完全匹配
 * - pendingResponse 存储挂起的 HTTP 响应对象，等待上层逻辑决定重定向目标
 */

import type { IncomingMessage, ServerResponse } from 'http'
import { createServer, type Server } from 'http'
import type { AddressInfo } from 'net'
import { logEvent } from 'src/services/analytics/index.js'
import { getOauthConfig } from '../../constants/oauth.js'
import { logError } from '../../utils/log.js'
import { shouldUseClaudeAIAuth } from './client.js'

/**
 * 临时本地 HTTP 服务器，用于捕获 OAuth 授权码重定向
 *
 * 当用户在浏览器中完成授权后，OAuth 服务器将浏览器重定向到：
 * http://localhost:[port]/callback?code=AUTH_CODE&state=STATE
 *
 * 本服务器捕获该重定向并提取授权码。
 * 注意：这不是 OAuth 服务器，仅是重定向捕获机制。
 */
export class AuthCodeListener {
  // 本地 HTTP 服务器实例
  private localServer: Server
  // 实际绑定的端口号（start() 后确定）
  private port: number = 0
  // Promise resolve 函数，在收到有效授权码时调用
  private promiseResolver: ((authorizationCode: string) => void) | null = null
  // Promise reject 函数，在发生错误时调用
  private promiseRejecter: ((error: Error) => void) | null = null
  private expectedState: string | null = null // State parameter for CSRF protection
  private pendingResponse: ServerResponse | null = null // Response object for final redirect
  // 可配置的回调路径，默认为 '/callback'
  private callbackPath: string // Configurable callback path

  constructor(callbackPath: string = '/callback') {
    // 创建 HTTP 服务器但不立即绑定端口，延迟到 start() 调用
    this.localServer = createServer()
    this.callbackPath = callbackPath
  }

  /**
   * 启动本地 HTTP 服务器并返回绑定的端口号
   *
   * 设计要点：
   * - 在 waitForAuthorization 之前调用，确保服务器就绪后再打开浏览器
   * - port 参数可选：不提供时让 OS 分配可用端口（port 0），避免端口冲突
   * - 将端口号保存到 this.port，供 getPort() 获取
   *
   * @param port 可选的指定端口；不提供时使用 OS 分配的可用端口
   * @returns 实际绑定的端口号
   */
  async start(port?: number): Promise<number> {
    return new Promise((resolve, reject) => {
      // 监听一次性 error 事件，捕获端口绑定失败（如 EADDRINUSE）
      this.localServer.once('error', err => {
        reject(
          new Error(`Failed to start OAuth callback server: ${err.message}`),
        )
      })

      // Listen on specified port or 0 to let the OS assign an available port
      // port ?? 0：未指定端口时传 0，让 OS 分配可用端口（避免端口冲突）
      this.localServer.listen(port ?? 0, 'localhost', () => {
        const address = this.localServer.address() as AddressInfo
        this.port = address.port
        resolve(this.port)
      })
    })
  }

  /**
   * 获取当前绑定的端口号
   *
   * 需在 start() 成功后调用，否则返回初始值 0。
   */
  getPort(): number {
    return this.port
  }

  /**
   * 检查是否有挂起的 HTTP 响应等待处理
   *
   * 挂起响应表示授权码已收到但上层逻辑尚未决定重定向目标。
   */
  hasPendingResponse(): boolean {
    return this.pendingResponse !== null
  }

  /**
   * 等待 OAuth 授权码的核心方法
   *
   * 流程：
   * 1. 保存 Promise 的 resolve/reject 函数供后续回调使用
   * 2. 设置期望的 state 参数（CSRF 防护）
   * 3. 调用 startLocalListener 注册请求处理器，并立即触发 onReady 回调
   *    （onReady 通常用于打开浏览器授权页面）
   * 4. 返回 Promise，等待 handleRedirect 捕获到有效授权码后 resolve
   *
   * @param state CSRF 防护用的随机 state 参数
   * @param onReady 服务器就绪后的回调（通常用于打开浏览器）
   * @returns 授权码字符串（Promise）
   */
  async waitForAuthorization(
    state: string,
    onReady: () => Promise<void>,
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      this.promiseResolver = resolve
      this.promiseRejecter = reject
      // 存储期望的 state，用于 validateAndRespond 中的 CSRF 校验
      this.expectedState = state
      this.startLocalListener(onReady)
    })
  }

  /**
   * 处理授权成功后的浏览器重定向
   *
   * 根据授权范围（scopes）选择重定向目标：
   * - 若 scopes 匹配 Claude AI 授权，重定向到 CLAUDEAI_SUCCESS_URL
   * - 否则重定向到 CONSOLE_SUCCESS_URL（开发者控制台）
   * - 支持自定义处理器（customHandler）替代默认重定向逻辑
   *
   * @param scopes 授权范围数组（决定重定向目标页面）
   * @param customHandler 可选的自定义响应处理器（替代默认重定向）
   */
  handleSuccessRedirect(
    scopes: string[],
    customHandler?: (res: ServerResponse, scopes: string[]) => void,
  ): void {
    // 若无挂起响应，直接返回（可能已被 close() 处理）
    if (!this.pendingResponse) return

    // If custom handler provided, use it instead of default redirect
    // 自定义处理器：允许调用方完全控制响应（如展示自定义成功页面）
    if (customHandler) {
      customHandler(this.pendingResponse, scopes)
      this.pendingResponse = null
      logEvent('tengu_oauth_automatic_redirect', { custom_handler: true })
      return
    }

    // Default behavior: Choose success page based on granted permissions
    // 根据授权范围决定重定向目标：Claude AI 授权 vs 开发者控制台
    const successUrl = shouldUseClaudeAIAuth(scopes)
      ? getOauthConfig().CLAUDEAI_SUCCESS_URL
      : getOauthConfig().CONSOLE_SUCCESS_URL

    // Send browser to success page
    // 发送 302 重定向响应，将用户浏览器导航到成功页面
    this.pendingResponse.writeHead(302, { Location: successUrl })
    this.pendingResponse.end()
    this.pendingResponse = null

    logEvent('tengu_oauth_automatic_redirect', {})
  }

  /**
   * 处理授权失败后的浏览器重定向
   *
   * 在授权流程出错时（如 state 不匹配、无授权码），
   * 将挂起的浏览器响应重定向到成功页面（TODO：未来切换为专用错误页面）。
   * 记录 tengu_oauth_automatic_redirect_error 分析事件。
   */
  handleErrorRedirect(): void {
    if (!this.pendingResponse) return

    // TODO: swap to a different url once we have an error page
    // TODO：待有专用错误页面后替换此 URL
    const errorUrl = getOauthConfig().CLAUDEAI_SUCCESS_URL

    // Send browser to error page
    this.pendingResponse.writeHead(302, { Location: errorUrl })
    this.pendingResponse.end()
    this.pendingResponse = null

    logEvent('tengu_oauth_automatic_redirect_error', {})
  }

  /**
   * 启动本地 HTTP 请求监听器
   *
   * 服务器已在 start() 时绑定端口并开始监听，
   * 此方法仅负责注册请求处理器和错误处理器，
   * 然后立即调用 onReady（因为服务器已经就绪）。
   *
   * @param onReady 服务器就绪回调（立即执行，用于打开浏览器）
   */
  private startLocalListener(onReady: () => Promise<void>): void {
    // Server is already created and listening, just set up handlers
    // 服务器已在 start() 时创建并监听，此处仅绑定请求处理器
    this.localServer.on('request', this.handleRedirect.bind(this))
    this.localServer.on('error', this.handleError.bind(this))

    // Server is already listening, so we can call onReady immediately
    // 服务器已就绪，立即调用 onReady（通常在此打开浏览器授权页）
    void onReady()
  }

  /**
   * 处理传入的 HTTP 请求
   *
   * 验证请求路径是否为配置的回调路径（callbackPath），
   * 然后提取 code 和 state 查询参数，委托 validateAndRespond 处理。
   * 非回调路径的请求返回 404。
   *
   * @param req 传入的 HTTP 请求
   * @param res HTTP 响应对象
   */
  private handleRedirect(req: IncomingMessage, res: ServerResponse): void {
    // 解析请求 URL，使用 localhost 作为基础 URL 以确保正确解析
    const parsedUrl = new URL(
      req.url || '',
      `http://${req.headers.host || 'localhost'}`,
    )

    // 仅处理配置的回调路径，其他路径返回 404
    if (parsedUrl.pathname !== this.callbackPath) {
      res.writeHead(404)
      res.end()
      return
    }

    // 从查询参数中提取授权码和 state（不存在时为 undefined）
    const authCode = parsedUrl.searchParams.get('code') ?? undefined
    const state = parsedUrl.searchParams.get('state') ?? undefined

    this.validateAndRespond(authCode, state, res)
  }

  /**
   * 验证授权码和 state 参数，并解决等待中的 Promise
   *
   * 验证逻辑：
   * 1. 检查授权码是否存在（400 错误：无授权码）
   * 2. 检查 state 是否与期望值匹配（400 错误：CSRF 防护失败）
   * 3. 将响应对象存入 pendingResponse，等待上层决定重定向目标
   * 4. 调用 resolve(authCode) 通知 waitForAuthorization 授权码已就绪
   *
   * @param authCode 从 URL 参数提取的授权码
   * @param state 从 URL 参数提取的 state
   * @param res HTTP 响应对象（用于后续重定向）
   */
  private validateAndRespond(
    authCode: string | undefined,
    state: string | undefined,
    res: ServerResponse,
  ): void {
    // 检查授权码是否存在
    if (!authCode) {
      res.writeHead(400)
      res.end('Authorization code not found')
      this.reject(new Error('No authorization code received'))
      return
    }

    // CSRF 防护：验证 state 参数与请求时生成的 state 一致
    if (state !== this.expectedState) {
      res.writeHead(400)
      res.end('Invalid state parameter')
      this.reject(new Error('Invalid state parameter'))
      return
    }

    // Store the response for later redirect
    // 将响应对象存入 pendingResponse，等待 handleSuccessRedirect 发送最终重定向
    this.pendingResponse = res

    // 通知 waitForAuthorization Promise 授权码已就绪
    this.resolve(authCode)
  }

  /**
   * 处理 HTTP 服务器错误事件
   *
   * 错误发生时关闭服务器并 reject 等待中的 Promise。
   */
  private handleError(err: Error): void {
    logError(err)
    this.close()
    this.reject(err)
  }

  /**
   * 解决等待中的 Promise（仅执行一次）
   *
   * 调用后清除 promiseResolver 和 promiseRejecter，防止重复解决。
   *
   * @param authorizationCode 有效的授权码
   */
  private resolve(authorizationCode: string): void {
    if (this.promiseResolver) {
      this.promiseResolver(authorizationCode)
      // 清除引用，防止重复调用
      this.promiseResolver = null
      this.promiseRejecter = null
    }
  }

  /**
   * 拒绝等待中的 Promise（仅执行一次）
   *
   * 调用后清除 promiseResolver 和 promiseRejecter，防止重复拒绝。
   *
   * @param error 触发拒绝的错误
   */
  private reject(error: Error): void {
    if (this.promiseRejecter) {
      this.promiseRejecter(error)
      // 清除引用，防止重复调用
      this.promiseResolver = null
      this.promiseRejecter = null
    }
  }

  /**
   * 关闭本地监听服务器
   *
   * 关闭流程：
   * 1. 若有挂起的浏览器响应（pendingResponse 不为 null），先发送错误重定向
   *    确保用户浏览器不会停留在等待页面
   * 2. 移除所有事件监听器（防止内存泄漏）
   * 3. 关闭 HTTP 服务器
   */
  close(): void {
    // If we have a pending response, send a redirect before closing
    // 关闭前处理挂起响应：确保浏览器得到明确的重定向而不是连接中断
    if (this.pendingResponse) {
      this.handleErrorRedirect()
    }

    if (this.localServer) {
      // Remove all listeners to prevent memory leaks
      // 移除所有事件监听器，防止 GC 无法回收该对象
      this.localServer.removeAllListeners()
      this.localServer.close()
    }
  }
}
