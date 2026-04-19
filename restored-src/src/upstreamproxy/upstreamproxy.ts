/**
 * CCR upstreamproxy — container-side wiring.
 *
 * When running inside a CCR session container with upstreamproxy configured,
 * this module:
 *   1. Reads the session token from /run/ccr/session_token
 *   2. Sets prctl(PR_SET_DUMPABLE, 0) to block same-UID ptrace of the heap
 *   3. Downloads the upstreamproxy CA cert and concatenates it with the
 *      system bundle so curl/gh/python trust the MITM proxy
 *   4. Starts a local CONNECT→WebSocket relay (see relay.ts)
 *   5. Unlinks the token file (token stays heap-only; file is gone before
 *      the agent loop can see it, but only after the relay is confirmed up
 *      so a supervisor restart can retry)
 *   6. Exposes HTTPS_PROXY / SSL_CERT_FILE env vars for all agent subprocesses
 *
 * Every step fails open: any error logs a warning and disables the proxy.
 * A broken proxy setup must never break an otherwise-working session.
 *
 * Design doc: api-go/ccr/docs/plans/CCR_AUTH_DESIGN.md § "Week-1 pilot scope".
 */

/**
 * 【模块概述】CCR 上行代理 — 容器侧初始化与子进程环境注入。
 *
 * 在 Claude Code 远程运行（CCR）架构中，本模块处于容器启动流程的初始化阶段，
 * 由 init.ts 的初始化序列调用一次。整体作用链如下：
 *
 *   容器启动
 *     └─ init.ts → initUpstreamProxy()
 *           ├─ 读取会话令牌（/run/ccr/session_token）
 *           ├─ 设置进程不可 dump（防止同 UID 进程 ptrace 窃取令牌）
 *           ├─ 下载 MITM 代理 CA 证书，拼接系统 CA bundle 写入本地文件
 *           ├─ 启动 CONNECT→WebSocket 本地 TCP 中继（见 relay.ts）
 *           └─ 删除令牌文件（令牌仅驻留堆内存，文件不留痕迹）
 *
 *   子进程启动（Bash 工具 / MCP 服务器 / LSP / Hooks）
 *     └─ subprocessEnv() → getUpstreamProxyEnv()
 *           └─ 注入 HTTPS_PROXY / NO_PROXY / SSL_CERT_FILE 等环境变量
 *
 * 所有步骤均采用 fail-open 策略：任何错误只记录警告并禁用代理，
 * 保证代理配置失败不影响正常会话的运行。
 */

import { mkdir, readFile, unlink, writeFile } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import { registerCleanup } from '../utils/cleanupRegistry.js'
import { logForDebugging } from '../utils/debug.js'
import { isEnvTruthy } from '../utils/envUtils.js'
import { isENOENT } from '../utils/errors.js'
import { startUpstreamProxyRelay } from './relay.js'

export const SESSION_TOKEN_PATH = '/run/ccr/session_token'
const SYSTEM_CA_BUNDLE = '/etc/ssl/certs/ca-certificates.crt'

// 不经代理直接访问的主机列表：覆盖本地回环、RFC1918 私网地址、IMDS 地址段
// 以及包注册表和 GitHub（CCR 容器本身已可直接访问这些地址）。
// anthropic.com 以三种形式列出，兼容不同运行时的 NO_PROXY 解析方式：
//   *.anthropic.com — Bun、curl、Go（通配符匹配）
//   .anthropic.com  — Python urllib/httpx（前缀点后缀匹配，会自动去掉前导点）
//   anthropic.com   — 顶级域名兜底（不带前缀的 fallback）
const NO_PROXY_LIST = [
  'localhost',
  '127.0.0.1',
  '::1',
  '169.254.0.0/16',
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  // Anthropic API: no upstream route will ever match, and the MITM breaks
  // non-Bun runtimes (Python httpx/certifi doesn't trust the forged CA).
  // Three forms because NO_PROXY parsing differs across runtimes:
  //   *.anthropic.com  — Bun, curl, Go (glob match)
  //   .anthropic.com   — Python urllib/httpx (suffix match, strips leading dot)
  //   anthropic.com    — apex domain fallback
  'anthropic.com',
  '.anthropic.com',
  '*.anthropic.com',
  'github.com',
  'api.github.com',
  '*.github.com',
  '*.githubusercontent.com',
  'registry.npmjs.org',
  'pypi.org',
  'files.pythonhosted.org',
  'index.crates.io',
  'proxy.golang.org',
].join(',')

// 模块级代理状态，记录中继端口号和 CA bundle 路径，供 getUpstreamProxyEnv() 读取
type UpstreamProxyState = {
  enabled: boolean
  port?: number
  caBundlePath?: string
}

// 初始状态为未启用；由 initUpstreamProxy() 在成功配置后更新为 enabled:true
let state: UpstreamProxyState = { enabled: false }

/**
 * Initialize upstreamproxy. Called once from init.ts. Safe to call when the
 * feature is off or the token file is absent — returns {enabled: false}.
 *
 * Overridable paths are for tests; production uses the defaults.
 */
/**
 * 初始化上行代理，由 init.ts 在容器启动时调用一次。
 *
 * 执行流程（任一步骤失败则返回 {enabled: false}）：
 *   1. 检查 CLAUDE_CODE_REMOTE 和 CCR_UPSTREAM_PROXY_ENABLED 开关
 *   2. 读取 CLAUDE_CODE_REMOTE_SESSION_ID（用于构造 Basic Auth）
 *   3. 读取磁盘上的会话令牌文件
 *   4. 调用 setNonDumpable() 防止堆内存被 ptrace 窃取
 *   5. 从 CCR API 下载 MITM CA 证书并写入本地 CA bundle
 *   6. 启动 CONNECT→WebSocket 中继，注册清理回调
 *   7. 更新模块级 state，再删除令牌文件（确保失败时可重试）
 *
 * @param opts - 可选的路径覆盖参数（主要用于单元测试）
 * @returns 代理状态对象；enabled=false 表示代理未启用
 */
export async function initUpstreamProxy(opts?: {
  tokenPath?: string
  systemCaPath?: string
  caBundlePath?: string
  ccrBaseUrl?: string
}): Promise<UpstreamProxyState> {
  // 仅在 CCR 远程容器环境中才启用代理（本地开发不设置此变量）
  if (!isEnvTruthy(process.env.CLAUDE_CODE_REMOTE)) {
    return state
  }
  // CCR evaluates ccr_upstream_proxy_enabled server-side (where GrowthBook is
  // warm) and injects this env var via StartupContext.EnvironmentVariables.
  // Every CCR session is a fresh container with no GB cache, so a client-side
  // GB check here always returned the default (false).
  // 由 CCR 服务端在启动上下文中注入，客户端不做功能开关查询
  if (!isEnvTruthy(process.env.CCR_UPSTREAM_PROXY_ENABLED)) {
    return state
  }

  // sessionId 用于构建代理认证头部（Basic Auth 格式：sessionId:token）
  const sessionId = process.env.CLAUDE_CODE_REMOTE_SESSION_ID
  if (!sessionId) {
    logForDebugging(
      '[upstreamproxy] CLAUDE_CODE_REMOTE_SESSION_ID unset; proxy disabled',
      { level: 'warn' },
    )
    return state
  }

  // 读取磁盘上的会话令牌文件；文件不存在时返回 null（静默失败）
  const tokenPath = opts?.tokenPath ?? SESSION_TOKEN_PATH
  const token = await readToken(tokenPath)
  if (!token) {
    logForDebugging('[upstreamproxy] no session token file; proxy disabled')
    return state
  }

  // 令牌读入内存后立即锁定进程堆不可 dump，防止通过 ptrace/gdb 读取令牌
  setNonDumpable()

  // CCR injects ANTHROPIC_BASE_URL via StartupContext (sessionExecutor.ts /
  // sessionHandler.ts). getOauthConfig() is wrong here: it keys off
  // USER_TYPE + USE_{LOCAL,STAGING}_OAUTH, none of which the container sets,
  // so it always returned the prod URL and the CA fetch 404'd.
  // 使用容器注入的 ANTHROPIC_BASE_URL，而非 getOauthConfig()（容器内不设置对应变量）
  const baseUrl =
    opts?.ccrBaseUrl ??
    process.env.ANTHROPIC_BASE_URL ??
    'https://api.anthropic.com'
  // CA bundle 输出到 ~/.ccr/ca-bundle.crt，子进程通过 SSL_CERT_FILE 使用
  const caBundlePath =
    opts?.caBundlePath ?? join(homedir(), '.ccr', 'ca-bundle.crt')

  // 下载 MITM CA 证书并与系统证书合并；失败则禁用代理并返回
  const caOk = await downloadCaBundle(
    baseUrl,
    opts?.systemCaPath ?? SYSTEM_CA_BUNDLE,
    caBundlePath,
  )
  if (!caOk) return state

  try {
    // 将 HTTP(S) URL 转换为 WebSocket URL，指向 CCR 上行代理的 WS 端点
    const wsUrl = baseUrl.replace(/^http/, 'ws') + '/v1/code/upstreamproxy/ws'
    // 启动本地 TCP 中继，绑定到随机空闲端口（0 表示由 OS 分配）
    const relay = await startUpstreamProxyRelay({ wsUrl, sessionId, token })
    // 注册进程退出清理回调，确保会话结束时关闭中继服务器
    registerCleanup(async () => relay.stop())
    // 更新模块状态，记录中继端口和 CA bundle 路径供子进程使用
    state = { enabled: true, port: relay.port, caBundlePath }
    logForDebugging(`[upstreamproxy] enabled on 127.0.0.1:${relay.port}`)
    // Only unlink after the listener is up: if CA download or listen()
    // fails, a supervisor restart can retry with the token still on disk.
    // 中继成功启动后才删除令牌文件：失败时保留文件以供监督进程重启重试
    await unlink(tokenPath).catch(() => {
      logForDebugging('[upstreamproxy] token file unlink failed', {
        level: 'warn',
      })
    })
  } catch (err) {
    logForDebugging(
      `[upstreamproxy] relay start failed: ${err instanceof Error ? err.message : String(err)}; proxy disabled`,
      { level: 'warn' },
    )
  }

  return state
}

/**
 * Env vars to merge into every agent subprocess. Empty when the proxy is
 * disabled. Called from subprocessEnv() so Bash/MCP/LSP/hooks all inherit
 * the same recipe.
 */
/**
 * 获取需要注入所有子进程的代理环境变量字典。
 *
 * 调用时机：subprocessEnv() 中，在启动 Bash/MCP/LSP/Hooks 等子进程前调用，
 * 使所有子进程都自动使用本地中继代理。
 *
 * 三种情况处理：
 *   1. 代理已启用（state.enabled=true）→ 返回完整的 HTTPS_PROXY 等变量
 *   2. 代理未启用但父进程已有代理变量（子 CLI 进程）→ 透传父进程的变量给孙进程
 *   3. 代理未启用且无父进程变量 → 返回空对象
 *
 * 注意：仅代理 HTTPS 流量。中继只处理 CONNECT 方法，HTTP 流量不经过代理，
 * 否则对只注入 HTTPS 凭据的纯 HTTP 请求会返回 405 错误。
 */
export function getUpstreamProxyEnv(): Record<string, string> {
  if (!state.enabled || !state.port || !state.caBundlePath) {
    // Child CLI processes can't re-initialize the relay (token file was
    // unlinked by the parent), but the parent's relay is still running and
    // reachable at 127.0.0.1:<port>. If we inherited proxy vars from the
    // parent (HTTPS_PROXY + SSL_CERT_FILE both set), pass them through so
    // our subprocesses also route through the parent's relay.
    // 子 CLI 进程无法重建中继（令牌已删除），但可以透传父进程注入的代理变量
    if (process.env.HTTPS_PROXY && process.env.SSL_CERT_FILE) {
      const inherited: Record<string, string> = {}
      // 同时透传大写和小写两种形式，兼容 curl/Go（大写）和 Python/部分工具（小写）
      for (const key of [
        'HTTPS_PROXY',
        'https_proxy',
        'NO_PROXY',
        'no_proxy',
        'SSL_CERT_FILE',
        'NODE_EXTRA_CA_CERTS',
        'REQUESTS_CA_BUNDLE',
        'CURL_CA_BUNDLE',
      ]) {
        if (process.env[key]) inherited[key] = process.env[key]
      }
      return inherited
    }
    return {}
  }
  // 本地中继监听在回环地址，外部无法访问
  const proxyUrl = `http://127.0.0.1:${state.port}`
  // HTTPS only: the relay handles CONNECT and nothing else. Plain HTTP has
  // no credentials to inject, so routing it through the relay would just
  // break the request with a 405.
  return {
    HTTPS_PROXY: proxyUrl,            // curl、Go、Node.js 等读取大写形式
    https_proxy: proxyUrl,            // Python requests、部分 Linux 工具读小写
    NO_PROXY: NO_PROXY_LIST,          // 不经代理的主机列表（大写，兼容 curl/Go）
    no_proxy: NO_PROXY_LIST,          // 不经代理的主机列表（小写，兼容 Python）
    SSL_CERT_FILE: state.caBundlePath,           // OpenSSL / curl 使用的 CA bundle
    NODE_EXTRA_CA_CERTS: state.caBundlePath,     // Node.js 追加信任的 CA 证书
    REQUESTS_CA_BUNDLE: state.caBundlePath,      // Python requests 库使用的 CA
    CURL_CA_BUNDLE: state.caBundlePath,          // curl 覆盖默认 CA bundle
  }
}

/** Test-only: reset module state between test cases. */
/**
 * 仅用于测试：在测试用例之间重置模块级 state，防止测试间状态污染。
 */
export function resetUpstreamProxyForTests(): void {
  state = { enabled: false }
}

/**
 * 从指定路径读取会话令牌文件，返回去除首尾空白后的字符串。
 *
 * 错误处理：
 *   - 文件不存在（ENOENT）→ 静默返回 null（正常情况，如已被删除）
 *   - 其他 IO 错误 → 记录警告并返回 null
 *   - 文件内容为空 → 返回 null
 */
async function readToken(path: string): Promise<string | null> {
  try {
    const raw = await readFile(path, 'utf8')
    // trim() 去除换行符等空白字符；空文件视为无令牌
    return raw.trim() || null
  } catch (err) {
    // ENOENT 是预期情况（令牌文件不存在），静默处理
    if (isENOENT(err)) return null
    logForDebugging(
      `[upstreamproxy] token read failed: ${err instanceof Error ? err.message : String(err)}`,
      { level: 'warn' },
    )
    return null
  }
}

/**
 * prctl(PR_SET_DUMPABLE, 0) via libc FFI. Blocks same-UID ptrace of this
 * process, so a prompt-injected `gdb -p $PPID` can't scrape the token from
 * the heap. Linux-only; silently no-ops elsewhere.
 */
/**
 * 通过 Bun FFI 调用 Linux libc 的 prctl(PR_SET_DUMPABLE, 0)，
 * 禁止同 UID 的其他进程对本进程进行 ptrace 内存读取。
 *
 * 安全目的：防止提示注入攻击通过 `gdb -p $PPID` 从进程堆内存中读取会话令牌。
 * 限制：仅在 Linux 平台 + Bun 运行时下调用 FFI；其他平台（macOS、Windows）
 * 或 Node.js 运行时下静默跳过，不影响功能。
 */
function setNonDumpable(): void {
  // 仅 Linux 平台且在 Bun 运行时下才有 bun:ffi 可用
  if (process.platform !== 'linux' || typeof Bun === 'undefined') return
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ffi = require('bun:ffi') as typeof import('bun:ffi')
    // 动态加载 libc.so.6，声明 prctl 函数签名（5 个参数，返回 int）
    const lib = ffi.dlopen('libc.so.6', {
      prctl: {
        args: ['int', 'u64', 'u64', 'u64', 'u64'],
        returns: 'int',
      },
    } as const)
    const PR_SET_DUMPABLE = 4   // Linux prctl 操作码 4：设置/获取进程 dumpable 标志
    // 第二参数 0n = 禁止 dump（也禁止同 UID ptrace）；后三个参数对此操作码无意义
    const rc = lib.symbols.prctl(PR_SET_DUMPABLE, 0n, 0n, 0n, 0n)
    if (rc !== 0) {
      logForDebugging(
        '[upstreamproxy] prctl(PR_SET_DUMPABLE,0) returned nonzero',
        {
          level: 'warn',
        },
      )
    }
  } catch (err) {
    logForDebugging(
      `[upstreamproxy] prctl unavailable: ${err instanceof Error ? err.message : String(err)}`,
      { level: 'warn' },
    )
  }
}

/**
 * 从 CCR API 下载 MITM 代理 CA 证书，与系统 CA bundle 合并后写入本地文件。
 *
 * 下载流程：
 *   1. GET {baseUrl}/v1/code/upstreamproxy/ca-cert（5 秒超时，防止 Bun 无限阻塞）
 *   2. 读取系统 CA bundle（/etc/ssl/certs/ca-certificates.crt）
 *   3. 将 systemCa + '\n' + ccrCa 写入 outPath（~/.ccr/ca-bundle.crt）
 *
 * 任何步骤失败均记录警告并返回 false，上层据此跳过代理初始化。
 *
 * @param baseUrl      CCR API 基础 URL（如 https://api.anthropic.com）
 * @param systemCaPath 系统 CA bundle 路径（默认 /etc/ssl/certs/ca-certificates.crt）
 * @param outPath      合并后的 CA bundle 输出路径（默认 ~/.ccr/ca-bundle.crt）
 * @returns 成功返回 true，任意步骤失败返回 false
 */
async function downloadCaBundle(
  baseUrl: string,
  systemCaPath: string,
  outPath: string,
): Promise<boolean> {
  try {
    // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
    const resp = await fetch(`${baseUrl}/v1/code/upstreamproxy/ca-cert`, {
      // Bun has no default fetch timeout — a hung endpoint would block CLI
      // startup forever. 5s is generous for a small PEM.
      signal: AbortSignal.timeout(5000),  // 5 秒硬超时，防止 Bun 因无默认超时而永久挂起
    })
    if (!resp.ok) {
      logForDebugging(
        `[upstreamproxy] ca-cert fetch ${resp.status}; proxy disabled`,
        { level: 'warn' },
      )
      return false
    }
    const ccrCa = await resp.text()   // CCR MITM 代理的 PEM 格式 CA 证书内容
    // 读取系统 CA bundle；文件不存在时降级为空字符串，不阻断流程
    const systemCa = await readFile(systemCaPath, 'utf8').catch(() => '')
    // 确保输出目录 ~/.ccr/ 存在（recursive 避免目录已存在时报错）
    await mkdir(join(outPath, '..'), { recursive: true })
    // 系统 CA 在前，CCR CA 在后，合并为子进程信任的完整证书链
    await writeFile(outPath, systemCa + '\n' + ccrCa, 'utf8')
    return true
  } catch (err) {
    logForDebugging(
      `[upstreamproxy] ca-cert download failed: ${err instanceof Error ? err.message : String(err)}; proxy disabled`,
      { level: 'warn' },
    )
    return false
  }
}
