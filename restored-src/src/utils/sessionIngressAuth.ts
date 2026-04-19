/**
 * 会话入口认证令牌模块
 *
 * 在 Claude Code 系统中的位置：
 * 远程会话传输层 → CCR (Claude Code Remote) 认证 → sessionIngressAuth
 *
 * 主要功能：
 * 提供获取和构建会话入口（Session Ingress）认证凭证的统一接口，
 * 支持三种令牌来源（按优先级降序）：
 * 1. 环境变量 CLAUDE_CODE_SESSION_ACCESS_TOKEN（在启动时注入或运行中更新）
 * 2. 文件描述符 CLAUDE_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR（仅可读取一次，读后缓存）
 * 3. 约定文件（well-known file）：CLAUDE_SESSION_INGRESS_TOKEN_FILE 或默认路径
 *
 * 认证头构建规则：
 * - sk-ant-sid 开头的令牌 → Cookie: sessionKey={token} + 可选 X-Organization-Uuid 头
 * - JWT（其他格式）→ Authorization: Bearer {token}
 */

import {
  getSessionIngressToken,
  setSessionIngressToken,
} from '../bootstrap/state.js'
import {
  CCR_SESSION_INGRESS_TOKEN_PATH,
  maybePersistTokenForSubprocesses,
  readTokenFromWellKnownFile,
} from './authFileDescriptor.js'
import { logForDebugging } from './debug.js'
import { errorMessage } from './errors.js'
import { getFsImplementation } from './fsOperations.js'

/**
 * 通过文件描述符（或约定文件）读取会话入口令牌
 *
 * 函数流程：
 * 1. 先检查全局状态缓存（getSessionIngressToken），已有结果直接返回（FD 只能读一次）
 * 2. 若无 CLAUDE_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR 环境变量：
 *    - 可能是非 CCR 环境，或父进程已去掉了无用的 FD 变量
 *    - 回退到 CLAUDE_SESSION_INGRESS_TOKEN_FILE 或 CCR_SESSION_INGRESS_TOKEN_PATH 约定文件
 * 3. 若有 FD 变量，将其解析为数字：
 *    - 格式非法（NaN）→ 缓存 null，返回 null
 * 4. 根据操作系统选择 FD 路径（macOS/BSD: /dev/fd/N, Linux: /proc/self/fd/N）
 * 5. 读取后去空白，成功则缓存并通过 maybePersistTokenForSubprocesses 写入约定文件
 * 6. 读取失败（通常是子进程继承了 FD 变量但没有 FD，ENXIO）→ 回退约定文件
 *
 * 注：全局缓存避免对文件描述符的重复读取（FD 一旦读取即关闭）。
 */
function getTokenFromFileDescriptor(): string | null {
  // 检查全局缓存，避免对 FD 的重复读取
  const cachedToken = getSessionIngressToken()
  if (cachedToken !== undefined) {
    return cachedToken
  }

  const fdEnv = process.env.CLAUDE_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR
  if (!fdEnv) {
    // 无 FD 变量：非 CCR 环境，或子进程已被去掉无用的 FD 变量
    // 直接尝试从约定文件读取
    const path =
      process.env.CLAUDE_SESSION_INGRESS_TOKEN_FILE ??
      CCR_SESSION_INGRESS_TOKEN_PATH
    const fromFile = readTokenFromWellKnownFile(path, 'session ingress token')
    setSessionIngressToken(fromFile)
    return fromFile
  }

  // 解析 FD 编号
  const fd = parseInt(fdEnv, 10)
  if (Number.isNaN(fd)) {
    logForDebugging(
      `CLAUDE_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR must be a valid file descriptor number, got: ${fdEnv}`,
      { level: 'error' },
    )
    setSessionIngressToken(null)
    return null
  }

  try {
    // 通过文件描述符路径读取令牌内容
    const fsOps = getFsImplementation()
    // macOS/BSD 使用 /dev/fd/N，Linux 使用 /proc/self/fd/N
    const fdPath =
      process.platform === 'darwin' || process.platform === 'freebsd'
        ? `/dev/fd/${fd}`
        : `/proc/self/fd/${fd}`

    const token = fsOps.readFileSync(fdPath, { encoding: 'utf8' }).trim()
    if (!token) {
      logForDebugging('File descriptor contained empty token', {
        level: 'error',
      })
      setSessionIngressToken(null)
      return null
    }
    logForDebugging(`Successfully read token from file descriptor ${fd}`)
    setSessionIngressToken(token)
    // 将令牌持久化到约定文件，供子进程使用（子进程无法继承 FD）
    maybePersistTokenForSubprocesses(
      CCR_SESSION_INGRESS_TOKEN_PATH,
      token,
      'session ingress token',
    )
    return token
  } catch (error) {
    logForDebugging(
      `Failed to read token from file descriptor ${fd}: ${errorMessage(error)}`,
      { level: 'error' },
    )
    // FD 读取失败（子进程继承了变量但 FD 已关闭，ENXIO 错误）→ 回退约定文件
    const path =
      process.env.CLAUDE_SESSION_INGRESS_TOKEN_FILE ??
      CCR_SESSION_INGRESS_TOKEN_PATH
    const fromFile = readTokenFromWellKnownFile(path, 'session ingress token')
    setSessionIngressToken(fromFile)
    return fromFile
  }
}

/**
 * 获取会话入口认证令牌
 *
 * 优先级顺序（从高到低）：
 * 1. 环境变量 CLAUDE_CODE_SESSION_ACCESS_TOKEN
 *    - 在进程启动时由父进程注入
 *    - 可通过 updateSessionIngressAuthToken() 或 stdin update_environment_variables 消息在运行时更新
 * 2. 文件描述符路径（传统方式，读一次后缓存）
 *    - CLAUDE_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR
 * 3. 约定文件路径（覆盖子进程场景）
 *    - CLAUDE_SESSION_INGRESS_TOKEN_FILE 或 /home/claude/.claude/remote/.session_ingress_token
 *
 * @returns 认证令牌字符串，获取失败时返回 null
 */
export function getSessionIngressAuthToken(): string | null {
  // 优先级 1：环境变量（最新值，可在运行中被替换）
  const envToken = process.env.CLAUDE_CODE_SESSION_ACCESS_TOKEN
  if (envToken) {
    return envToken
  }

  // 优先级 2 & 3：文件描述符（含约定文件回退）
  return getTokenFromFileDescriptor()
}

/**
 * 根据当前会话令牌构建 HTTP 认证头
 *
 * 认证方式判断：
 * - 令牌以 "sk-ant-sid" 开头 → Anthropic 会话密钥格式
 *   - 使用 Cookie: sessionKey={token} 头
 *   - 若有 CLAUDE_CODE_ORGANIZATION_UUID，追加 X-Organization-Uuid 头
 * - 其他格式（JWT 等）→ Bearer Token 格式
 *   - 使用 Authorization: Bearer {token} 头
 *
 * @returns 认证头对象（键值对），无令牌时返回空对象
 */
export function getSessionIngressAuthHeaders(): Record<string, string> {
  const token = getSessionIngressAuthToken()
  if (!token) return {}
  if (token.startsWith('sk-ant-sid')) {
    // Anthropic 会话密钥：使用 Cookie 认证
    const headers: Record<string, string> = {
      Cookie: `sessionKey=${token}`,
    }
    // 若有组织 UUID，添加对应头（用于多组织场景）
    const orgUuid = process.env.CLAUDE_CODE_ORGANIZATION_UUID
    if (orgUuid) {
      headers['X-Organization-Uuid'] = orgUuid
    }
    return headers
  }
  // JWT 等格式：使用 Bearer 认证
  return { Authorization: `Bearer ${token}` }
}

/**
 * 在进程内更新会话入口认证令牌（修改 process.env）
 *
 * 用于 REPL Bridge 在重新连接后注入新令牌，无需重启进程。
 * 下次调用 getSessionIngressAuthToken() 时会读取到新值。
 *
 * @param token - 新的认证令牌字符串
 */
export function updateSessionIngressAuthToken(token: string): void {
  // 直接写入环境变量，使其在优先级 1 中被优先使用
  process.env.CLAUDE_CODE_SESSION_ACCESS_TOKEN = token
}
