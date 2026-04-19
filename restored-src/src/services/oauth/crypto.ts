/**
 * OAuth PKCE 加密工具模块
 *
 * 在 Claude Code 系统流程中的位置：
 * 本文件是 OAuth PKCE（Proof Key for Code Exchange）流程的底层加密工具层，
 * 为 OAuth 授权码流程提供必要的随机值生成和哈希计算功能。
 * 在 OAuth PKCE 流程中的位置：
 *   1. generateCodeVerifier() → 生成高熵随机字符串（code_verifier）
 *   2. generateCodeChallenge(verifier) → SHA-256 哈希后 base64url 编码 → code_challenge
 *   3. generateState() → 生成 CSRF 防护用的随机 state 参数
 *
 * 主要功能：
 * - base64URLEncode：将 Buffer 转换为 base64url 格式（替换 +/-/= 字符）
 * - generateCodeVerifier：生成 32 字节随机 code_verifier（RFC 7636 要求高熵）
 * - generateCodeChallenge：对 verifier 进行 SHA-256 哈希后 base64url 编码
 * - generateState：生成 32 字节随机 state 参数（CSRF 防护）
 *
 * 安全说明：
 * - 使用 Node.js crypto 模块的 randomBytes（密码学安全随机数）
 * - code_verifier 和 code_challenge 用于防止授权码拦截攻击
 * - state 参数用于防止 CSRF 攻击
 */

import { createHash, randomBytes } from 'crypto'

/**
 * 将 Buffer 编码为 base64url 格式字符串
 *
 * base64url 是 base64 的 URL 安全变体（RFC 4648 §5），
 * 通过以下字符替换保证在 URL 查询参数中不需要额外转义：
 * - '+' → '-'（base64 标准字符 → URL 安全字符）
 * - '/' → '_'（base64 标准字符 → URL 安全字符）
 * - '=' → ''（去除 base64 填充字符，OAuth PKCE 规范要求无填充）
 *
 * @param buffer 要编码的原始字节 Buffer
 * @returns base64url 编码的字符串
 */
function base64URLEncode(buffer: Buffer): string {
  return buffer
    .toString('base64')   // 先转为标准 base64
    .replace(/\+/g, '-')  // '+' → '-'
    .replace(/\//g, '_')  // '/' → '_'
    .replace(/=/g, '')    // 去除填充字符 '='
}

/**
 * 生成 OAuth PKCE 的 code_verifier
 *
 * code_verifier 是 PKCE 流程的核心随机秘密：
 * - 由客户端生成并保存，用于后续 token 请求时证明授权码的合法性
 * - RFC 7636 要求长度在 43-128 个字符之间，且必须高熵随机
 * - 32 字节随机数经 base64url 编码后约 43 个字符，满足最小长度要求
 *
 * @returns 43 字符的高熵随机字符串（base64url 编码）
 */
export function generateCodeVerifier(): string {
  // 生成 32 字节密码学安全随机数，经 base64url 编码得到约 43 个字符
  return base64URLEncode(randomBytes(32))
}

/**
 * 从 code_verifier 生成 code_challenge
 *
 * PKCE 流程要求 code_challenge = BASE64URL(SHA256(code_verifier))：
 * 1. 对 code_verifier 字符串进行 SHA-256 哈希（输出 32 字节）
 * 2. 将哈希值经 base64url 编码得到 code_challenge
 *
 * code_challenge 在授权请求时发送给服务器，服务器保存后等待 token 请求时
 * 验证客户端提供的 code_verifier 哈希值是否与之匹配，防止授权码拦截攻击。
 *
 * @param verifier 由 generateCodeVerifier() 生成的 code_verifier
 * @returns base64url 编码的 SHA-256 哈希值（code_challenge）
 */
export function generateCodeChallenge(verifier: string): string {
  // 创建 SHA-256 哈希实例
  const hash = createHash('sha256')
  // 对 verifier 字符串进行哈希
  hash.update(verifier)
  // 将 32 字节哈希结果经 base64url 编码返回
  return base64URLEncode(hash.digest())
}

/**
 * 生成 OAuth state 参数（CSRF 防护）
 *
 * state 参数在 OAuth 授权请求中发送，OAuth 服务器会在回调时原样返回，
 * 客户端验证返回的 state 与发送的 state 一致，以防止 CSRF 攻击。
 *
 * - 使用 32 字节密码学安全随机数，经 base64url 编码
 * - 每次 OAuth 流程开始前生成新的 state，单次使用
 *
 * @returns 43 字符的随机 state 字符串（base64url 编码）
 */
export function generateState(): string {
  // 生成 32 字节随机数，经 base64url 编码得到约 43 个字符的随机 state
  return base64URLEncode(randomBytes(32))
}
