/**
 * 【API 错误工具函数模块】api/errorUtils.ts
 *
 * 在 Claude Code 系统流程中的位置：
 * - 属于 API 服务层，提供底层 API 错误解析和格式化工具
 * - 被 api/errors.ts 的 getAssistantMessageFromError() 等函数调用
 * - 也被 OAuth token 交换、预检连通性检查等非主 API 路径直接调用
 * - 与 errors.ts 分离的原因：避免引入 messages.ts / BashTool.tsx 等重量级依赖
 *
 * 核心功能：
 * - SSL_ERROR_CODES: OpenSSL 错误码白名单（Node.js 和 Bun 通用）
 * - extractConnectionErrorDetails(): 递归遍历错误 cause 链，提取根因错误码和消息
 * - getSSLErrorHint(): 为 SSL/TLS 错误返回可操作的用户提示（企业代理场景）
 * - sanitizeAPIError(): 从 APIError.message 中剥离 HTML 内容（CloudFlare 错误页面）
 * - formatAPIError(): 将 APIError 转换为用户友好的字符串（超时/SSL/嵌套错误/HTML 消息）
 *
 * 设计决策：
 * - extractConnectionErrorDetails() 设置 maxDepth=5 防止循环引用导致的无限递归
 * - formatAPIError() 优先从 cause 链提取根因，再尝试嵌套 error 对象，最后返回 .message
 * - getSSLErrorHint() 专为非主 API 路径设计（OAuth/preflight），主路径使用 formatAPIError()
 */

import type { APIError } from '@anthropic-ai/sdk'

/**
 * SSL/TLS 错误码集合（来自 OpenSSL，Node.js 和 Bun 通用）
 *
 * 包含证书验证错误、自签名证书错误、证书链错误、主机名错误和 TLS 握手错误。
 * 企业用户使用 TLS 拦截代理（如 Zscaler）时常遇到这些错误。
 *
 * See: https://www.openssl.org/docs/man3.1/man3/X509_STORE_CTX_get_error.html
 */
// SSL/TLS error codes from OpenSSL (used by both Node.js and Bun)
// See: https://www.openssl.org/docs/man3.1/man3/X509_STORE_CTX_get_error.html
const SSL_ERROR_CODES = new Set([
  // Certificate verification errors
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_SIGNATURE_FAILURE',
  'CERT_NOT_YET_VALID',
  'CERT_HAS_EXPIRED',
  'CERT_REVOKED',
  'CERT_REJECTED',
  'CERT_UNTRUSTED',
  // Self-signed certificate errors
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  // Chain errors
  'CERT_CHAIN_TOO_LONG',
  'PATH_LENGTH_EXCEEDED',
  // Hostname/altname errors
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'HOSTNAME_MISMATCH',
  // TLS handshake errors
  'ERR_TLS_HANDSHAKE_TIMEOUT',
  'ERR_SSL_WRONG_VERSION_NUMBER',
  'ERR_SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC',
])

/** 连接错误详情：错误码、消息、以及是否为 SSL/TLS 错误 */
export type ConnectionErrorDetails = {
  code: string
  message: string
  isSSLError: boolean
}

/**
 * 从错误的 cause 链中提取连接错误详情
 *
 * Anthropic SDK 会将底层错误包装在 `cause` 属性中，
 * 因此需要遍历 cause 链才能找到携带错误码的根因错误。
 *
 * 设计要点：
 * - 设置 maxDepth=5 防止循环引用导致的无限遍历
 * - 只处理携带 `code` 字符串属性的 Error 实例
 * - 若整个 cause 链中均无 code，返回 null
 *
 * Extracts connection error details from the error cause chain.
 * The Anthropic SDK wraps underlying errors in the `cause` property.
 * This function walks the cause chain to find the root error code/message.
 */
export function extractConnectionErrorDetails(
  error: unknown,
): ConnectionErrorDetails | null {
  if (!error || typeof error !== 'object') {
    return null
  }

  // 遍历 cause 链，查找携带 code 属性的根因错误
  let current: unknown = error
  const maxDepth = 5 // 最大遍历深度，防止循环引用导致无限循环
  let depth = 0

  while (current && depth < maxDepth) {
    if (
      current instanceof Error &&
      'code' in current &&
      typeof current.code === 'string'
    ) {
      const code = current.code
      // 检查错误码是否为已知的 SSL/TLS 错误
      const isSSLError = SSL_ERROR_CODES.has(code)
      return {
        code,
        message: current.message,
        isSSLError,
      }
    }

    // 移动到下一层 cause（防止指向自身的循环引用）
    if (
      current instanceof Error &&
      'cause' in current &&
      current.cause !== current
    ) {
      current = current.cause
      depth++
    } else {
      break
    }
  }

  return null
}

/**
 * 为 SSL/TLS 错误返回可操作的用户提示
 *
 * 适用场景：非主 API 客户端路径（OAuth token 交换、预检连通性检查），
 * 这些场景不经过 formatAPIError()。
 *
 * 设计动机：企业用户使用 TLS 拦截代理（如 Zscaler）时，
 * 浏览器中完成 OAuth 流程，但 CLI 的 token 交换请求因原始 SSL 错误码静默失败。
 * 提供具体的修复建议可以减少一轮技术支持沟通。
 *
 * Returns an actionable hint for SSL/TLS errors, intended for contexts outside
 * the main API client (OAuth token exchange, preflight connectivity checks)
 * where `formatAPIError` doesn't apply.
 */
export function getSSLErrorHint(error: unknown): string | null {
  const details = extractConnectionErrorDetails(error)
  if (!details?.isSSLError) {
    return null
  }
  // 提供具体的修复建议：设置 NODE_EXTRA_CA_CERTS 或联系 IT 将 *.anthropic.com 加白
  return `SSL certificate error (${details.code}). If you are behind a corporate proxy or TLS-intercepting firewall, set NODE_EXTRA_CA_CERTS to your CA bundle path, or ask IT to allowlist *.anthropic.com. Run /doctor for details.`
}

/**
 * 从消息字符串中剥离 HTML 内容（如 CloudFlare 错误页面）
 *
 * 某些中间层（CDN、代理）在服务不可用时返回 HTML 错误页面，
 * API 客户端可能将其作为 error.message 传入。
 * 若检测到 HTML，尝试提取 <title> 作为用户友好消息；否则返回原始消息。
 *
 * Strips HTML content (e.g., CloudFlare error pages) from a message string,
 * returning a user-friendly title or empty string if HTML is detected.
 * Returns the original message unchanged if no HTML is found.
 */
function sanitizeMessageHTML(message: string): string {
  if (message.includes('<!DOCTYPE html') || message.includes('<html')) {
    // 尝试从 <title> 标签提取页面标题作为用户友好消息
    const titleMatch = message.match(/<title>([^<]+)<\/title>/)
    if (titleMatch && titleMatch[1]) {
      return titleMatch[1].trim()
    }
    // 无法提取标题时返回空字符串（调用方会回退到通用错误消息）
    return ''
  }
  return message
}

/**
 * 检测 APIError.message 中是否含有 HTML 内容并返回净化后的消息
 *
 * 主要用于处理 CloudFlare 等 CDN 返回的 HTML 错误页面，
 * 避免将 HTML 标签直接展示给用户。
 *
 * Detects if an error message contains HTML content (e.g., CloudFlare error pages)
 * and returns a user-friendly message instead
 */
export function sanitizeAPIError(apiError: APIError): string {
  const message = apiError.message
  if (!message) {
    // Sometimes message is undefined
    // TODO: figure out why
    return ''
  }
  return sanitizeMessageHTML(message)
}

/**
 * 从 JSON 反序列化的 API 错误中提取嵌套的错误消息
 *
 * 从 session JSONL 文件反序列化后，SDK 的 APIError 会丢失顶层 .message 属性。
 * 实际消息存储在不同层级，取决于 API 提供商：
 * - Bedrock/代理：{ error: { message: "..." } }
 * - 标准 Anthropic API：{ error: { error: { message: "..." } } }
 *   （外层 .error 是响应体，内层 .error 是 API 错误对象）
 *
 * 检查顺序：从深层到浅层（优先采用更具体的错误消息）
 *
 * Shapes of deserialized API errors from session JSONL.
 *
 * After JSON round-tripping, the SDK's APIError loses its `.message` property.
 * The actual message lives at different nesting levels depending on the provider:
 *
 * - Bedrock/proxy: `{ error: { message: "..." } }`
 * - Standard Anthropic API: `{ error: { error: { message: "..." } } }`
 *   (the outer `.error` is the response body, the inner `.error` is the API error)
 *
 * See also: `getErrorMessage` in `logging.ts` which handles the same shapes.
 */
type NestedAPIError = {
  error?: {
    message?: string
    error?: { message?: string }
  }
}

/** 类型守卫：检查 value 是否具有嵌套的 error 对象结构 */
function hasNestedError(value: unknown): value is NestedAPIError {
  return (
    typeof value === 'object' &&
    value !== null &&
    'error' in value &&
    typeof value.error === 'object' &&
    value.error !== null
  )
}

/**
 * 从缺少顶层 .message 的反序列化 API 错误中提取可读消息
 *
 * 检查两级嵌套（从深层开始，优先采用更具体的消息）：
 * 1. error.error.error.message — 标准 Anthropic API 形态
 * 2. error.error.message — Bedrock 形态
 *
 * Extract a human-readable message from a deserialized API error that lacks
 * a top-level `.message`.
 */
function extractNestedErrorMessage(error: APIError): string | null {
  if (!hasNestedError(error)) {
    return null
  }

  // 通过收窄类型访问 .error，使 TypeScript 能识别嵌套结构
  // instead of the SDK's `Object | undefined`.
  const narrowed: NestedAPIError = error
  const nested = narrowed.error

  // 标准 Anthropic API 形态：{ error: { error: { message } } }（更深层，优先检查）
  const deepMsg = nested?.error?.message
  if (typeof deepMsg === 'string' && deepMsg.length > 0) {
    const sanitized = sanitizeMessageHTML(deepMsg)
    if (sanitized.length > 0) {
      return sanitized
    }
  }

  // Bedrock 形态：{ error: { message } }（浅层，次优先）
  const msg = nested?.message
  if (typeof msg === 'string' && msg.length > 0) {
    const sanitized = sanitizeMessageHTML(msg)
    if (sanitized.length > 0) {
      return sanitized
    }
  }

  return null
}

/**
 * 将 APIError 格式化为用户友好的错误字符串
 *
 * 处理优先级：
 * 1. 从 cause 链提取连接错误详情（超时 / SSL/TLS 错误 → 特定提示）
 * 2. "Connection error." 通用连接错误（带/不带错误码）
 * 3. 无 .message 的反序列化错误 → 尝试嵌套消息提取，回退到 "API error (status X)"
 * 4. HTML 净化后的消息 vs 原始 .message
 */
export function formatAPIError(error: APIError): string {
  // 第一步：从 cause 链提取连接错误详情（超时 + SSL 优先处理）
  const connectionDetails = extractConnectionErrorDetails(error)

  if (connectionDetails) {
    const { code, isSSLError } = connectionDetails

    // 超时错误：给出连接和代理设置建议
    if (code === 'ETIMEDOUT') {
      return 'Request timed out. Check your internet connection and proxy settings'
    }

    // SSL/TLS 错误：根据具体错误码返回针对性建议
    if (isSSLError) {
      switch (code) {
        case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
        case 'UNABLE_TO_GET_ISSUER_CERT':
        case 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY':
          return 'Unable to connect to API: SSL certificate verification failed. Check your proxy or corporate SSL certificates'
        case 'CERT_HAS_EXPIRED':
          return 'Unable to connect to API: SSL certificate has expired'
        case 'CERT_REVOKED':
          return 'Unable to connect to API: SSL certificate has been revoked'
        case 'DEPTH_ZERO_SELF_SIGNED_CERT':
        case 'SELF_SIGNED_CERT_IN_CHAIN':
          return 'Unable to connect to API: Self-signed certificate detected. Check your proxy or corporate SSL certificates'
        case 'ERR_TLS_CERT_ALTNAME_INVALID':
        case 'HOSTNAME_MISMATCH':
          return 'Unable to connect to API: SSL certificate hostname mismatch'
        case 'CERT_NOT_YET_VALID':
          return 'Unable to connect to API: SSL certificate is not yet valid'
        default:
          return `Unable to connect to API: SSL error (${code})`
      }
    }
  }

  // 第二步：通用连接错误（非 SSL），尽可能附上错误码辅助调试
  if (error.message === 'Connection error.') {
    if (connectionDetails?.code) {
      return `Unable to connect to API (${connectionDetails.code})`
    }
    return 'Unable to connect to API. Check your internet connection'
  }

  // 第三步：处理从 JSONL 反序列化的错误（可能丢失 .message 属性）
  // Guard: when deserialized from JSONL (e.g. --resume), the error object may
  // be a plain object without a `.message` property.  Return a safe fallback
  // instead of undefined, which would crash callers that access `.length`.
  if (!error.message) {
    return (
      extractNestedErrorMessage(error) ??
      `API error (status ${error.status ?? 'unknown'})`
    )
  }

  // 第四步：净化 HTML（CloudFlare 等返回的错误页面），若消息未变则直接返回
  const sanitizedMessage = sanitizeAPIError(error)
  // Use sanitized message if it's different from the original (i.e., HTML was sanitized)
  return sanitizedMessage !== error.message && sanitizedMessage.length > 0
    ? sanitizedMessage
    : error.message
}
