/**
 * Anthropic API 预连接模块（TCP+TLS 握手预热）。
 *
 * 在 Claude Code 系统中，该模块在初始化阶段以 fire-and-forget 方式向
 * Anthropic API 发起 HEAD 请求，将 TCP+TLS 握手（约 100-200ms）与启动
 * 工作并行化，从而减少第一次真实 API 调用的延迟。
 *
 * 原理：Bun 的 fetch 在全局共享一个 keep-alive 连接池，因此此处预热的
 * 连接可直接被后续 API 请求复用。
 *
 * 调用时机：在 init.ts 中于 applyExtraCACertsFromConfig() 和
 * configureGlobalAgents() 之后调用，确保 settings.json 中的环境变量已
 * 加载、TLS 证书存储已就绪。
 *
 * 跳过条件：
 * - 使用 Bedrock/Vertex/Foundry（不同端点与认证方式）
 * - 配置了代理（proxy）、mTLS 或 Unix socket（SDK 使用自定义 dispatcher，
 *   不共享全局连接池，预连接无效甚至有害）
 *
 * Preconnect to the Anthropic API to overlap TCP+TLS handshake with startup.
 */

import { getOauthConfig } from '../constants/oauth.js'
import { isEnvTruthy } from './envUtils.js'

// 幂等标志，确保同一进程中只触发一次预连接
let fired = false

/**
 * 触发一次 fire-and-forget 的 HEAD 请求以预热 API 连接池。
 * 已触发过、使用云厂商端点或配置了代理/mTLS/unix socket 时直接跳过。
 */
export function preconnectAnthropicApi(): void {
  if (fired) return
  fired = true

  // Skip if using a cloud provider — different endpoint + auth
  if (
    isEnvTruthy(process.env.CLAUDE_CODE_USE_BEDROCK) ||
    isEnvTruthy(process.env.CLAUDE_CODE_USE_VERTEX) ||
    isEnvTruthy(process.env.CLAUDE_CODE_USE_FOUNDRY)
  ) {
    return
  }
  // Skip if proxy/mTLS/unix — SDK's custom dispatcher won't reuse this pool
  if (
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    process.env.ANTHROPIC_UNIX_SOCKET ||
    process.env.CLAUDE_CODE_CLIENT_CERT ||
    process.env.CLAUDE_CODE_CLIENT_KEY
  ) {
    return
  }

  // Use configured base URL (staging, local, or custom gateway). Covers
  // ANTHROPIC_BASE_URL env + USE_STAGING_OAUTH + USE_LOCAL_OAUTH in one lookup.
  // NODE_EXTRA_CA_CERTS no longer a skip — init.ts applied it before this fires.
  const baseUrl =
    process.env.ANTHROPIC_BASE_URL || getOauthConfig().BASE_API_URL

  // Fire and forget. HEAD means no response body — the connection is eligible
  // for keep-alive pool reuse immediately after headers arrive. 10s timeout
  // so a slow network doesn't hang the process; abort is fine since the real
  // request will handshake fresh if needed.
  // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
  void fetch(baseUrl, {
    method: 'HEAD',
    signal: AbortSignal.timeout(10_000),
  }).catch(() => {})
}
