/**
 * 【文件定位】mTLS（双向 TLS）与 CA 证书配置模块 — Claude Code 安全通信基础设施层
 *
 * 在 Claude Code 的系统架构中，本文件处于"网络请求安全层"：
 *   API 调用 / WebSocket 连接 → [本模块：注入 TLS 配置] → HTTPS/WSS 请求 → Anthropic API
 *
 * 主要职责：
 *   1. 从环境变量读取客户端证书（cert）、私钥（key）和密码（passphrase），构建 mTLS 配置
 *   2. 创建带有自定义 CA 证书和客户端证书的 HTTPS Agent，供 Node.js 原生 HTTPS 使用
 *   3. 为 WebSocket 连接提供 TLS 连接选项
 *   4. 为 undici/Bun 的 fetch 提供 TLS dispatcher 配置
 *   5. 提供全局 Node.js TLS 配置初始化入口
 *
 * 环境变量：
 *   CLAUDE_CODE_CLIENT_CERT     - 客户端 PEM 证书文件路径
 *   CLAUDE_CODE_CLIENT_KEY      - 客户端私钥文件路径
 *   CLAUDE_CODE_CLIENT_KEY_PASSPHRASE - 私钥保护密码
 *   NODE_EXTRA_CA_CERTS         - 由 Node.js 运行时自动处理，追加到内置 CA 链
 *
 * 所有高开销函数均使用 lodash memoize 缓存，确保证书文件只读取一次。
 */

import type * as https from 'https'
import { Agent as HttpsAgent } from 'https'
import memoize from 'lodash-es/memoize.js'
import type * as tls from 'tls'
import type * as undici from 'undici'
import { getCACertificates } from './caCerts.js'
import { logForDebugging } from './debug.js'
import { getFsImplementation } from './fsOperations.js'

/**
 * mTLS 客户端身份验证配置类型
 * （只包含客户端身份证明部分，不含 CA 根证书）
 */
export type MTLSConfig = {
  cert?: string       // PEM 格式的客户端证书内容
  key?: string        // PEM 格式的客户端私钥内容
  passphrase?: string // 私钥加密密码（如有）
}

/**
 * 完整 TLS 配置类型（mTLS 配置 + 自定义 CA 证书）
 */
export type TLSConfig = MTLSConfig & {
  ca?: string | string[] | Buffer // 自定义 CA 证书（用于验证服务器身份）
}

/**
 * 从环境变量读取并构建 mTLS 客户端证书配置（带记忆化缓存）。
 *
 * 流程：
 *   1. 读取 CLAUDE_CODE_CLIENT_CERT 环境变量，若存在则读取对应文件内容
 *   2. 读取 CLAUDE_CODE_CLIENT_KEY 环境变量，若存在则读取对应文件内容
 *   3. 读取 CLAUDE_CODE_CLIENT_KEY_PASSPHRASE 环境变量（直接使用字符串值）
 *   4. 若没有任何配置项，返回 undefined（表示不使用 mTLS）
 *
 * 注意：NODE_EXTRA_CA_CERTS 由 Node.js 运行时自动处理，无需手动读取。
 * memoize 确保证书文件在进程生命周期内只读取一次。
 *
 * @returns mTLS 配置对象，或 undefined（未配置时）
 */
export const getMTLSConfig = memoize((): MTLSConfig | undefined => {
  const config: MTLSConfig = {}

  // 注意：NODE_EXTRA_CA_CERTS 由 Node.js 在启动时自动追加到内置 CA 列表
  // 无需在此手动处理，Node.js 会在运行时自动读取该环境变量

  // 读取客户端证书文件（PEM 格式）
  if (process.env.CLAUDE_CODE_CLIENT_CERT) {
    try {
      config.cert = getFsImplementation().readFileSync(
        process.env.CLAUDE_CODE_CLIENT_CERT,
        { encoding: 'utf8' },
      )
      logForDebugging(
        'mTLS: Loaded client certificate from CLAUDE_CODE_CLIENT_CERT',
      )
    } catch (error) {
      // 文件不存在或无读取权限，记录错误但不中断启动
      logForDebugging(`mTLS: Failed to load client certificate: ${error}`, {
        level: 'error',
      })
    }
  }

  // 读取客户端私钥文件（PEM 格式）
  if (process.env.CLAUDE_CODE_CLIENT_KEY) {
    try {
      config.key = getFsImplementation().readFileSync(
        process.env.CLAUDE_CODE_CLIENT_KEY,
        { encoding: 'utf8' },
      )
      logForDebugging('mTLS: Loaded client key from CLAUDE_CODE_CLIENT_KEY')
    } catch (error) {
      logForDebugging(`mTLS: Failed to load client key: ${error}`, {
        level: 'error',
      })
    }
  }

  // 直接从环境变量读取私钥密码（不需要文件读取）
  if (process.env.CLAUDE_CODE_CLIENT_KEY_PASSPHRASE) {
    config.passphrase = process.env.CLAUDE_CODE_CLIENT_KEY_PASSPHRASE
    logForDebugging('mTLS: Using client key passphrase')
  }

  // 若没有任何 mTLS 配置项，返回 undefined 表示不需要 mTLS
  if (Object.keys(config).length === 0) {
    return undefined
  }

  return config
})

/**
 * 创建带有 mTLS 和自定义 CA 证书的 HTTPS Agent（带记忆化缓存）。
 *
 * 用于 Node.js 原生 http/https 模块以及 axios 等基于 http.Agent 的库。
 * 仅在 mTLS 配置或自定义 CA 证书存在时才创建 Agent，否则返回 undefined，
 * 让调用方使用 Node.js 默认的 HTTPS 处理。
 *
 * 启用 keepAlive 以提升长期连接的性能（避免重复 TLS 握手）。
 *
 * @returns 配置了证书的 HttpsAgent，或 undefined（无 TLS 配置时）
 */
export const getMTLSAgent = memoize((): HttpsAgent | undefined => {
  const mtlsConfig = getMTLSConfig()
  const caCerts = getCACertificates()

  // 两者均无配置时，返回 undefined 使用默认 HTTPS 行为
  if (!mtlsConfig && !caCerts) {
    return undefined
  }

  const agentOptions: https.AgentOptions = {
    // 展开 mTLS 客户端证书配置（cert/key/passphrase）
    ...mtlsConfig,
    // 若有自定义 CA 证书，追加到 Agent 配置
    ...(caCerts && { ca: caCerts }),
    // 启用长连接以减少重复握手开销
    keepAlive: true,
  }

  logForDebugging('mTLS: Creating HTTPS agent with custom certificates')
  return new HttpsAgent(agentOptions)
})

/**
 * 获取 WebSocket 连接的 TLS 配置选项。
 *
 * WebSocket 使用 ws 库，其 TLS 选项格式与 Node.js tls.connect 相同，
 * 因此返回 tls.ConnectionOptions 类型（而非 HTTPS Agent）。
 *
 * @returns TLS 连接选项，或 undefined（无自定义证书时）
 */
export function getWebSocketTLSOptions(): tls.ConnectionOptions | undefined {
  const mtlsConfig = getMTLSConfig()
  const caCerts = getCACertificates()

  // 无任何自定义证书配置时，返回 undefined 使用默认 TLS
  if (!mtlsConfig && !caCerts) {
    return undefined
  }

  // 合并 mTLS 客户端证书和自定义 CA 证书
  return {
    ...mtlsConfig,
    ...(caCerts && { ca: caCerts }),
  }
}

/**
 * 获取用于 fetch（undici/Bun）的 TLS 配置选项。
 *
 * Bun 和 Node.js 的 fetch 使用不同的底层库：
 *   - Bun：使用 Bun 内置 fetch，通过 tls 字段配置
 *   - Node.js：使用 undici，需要创建自定义 Agent 作为 dispatcher
 *
 * undici 包（~1.5MB）采用惰性加载，仅在实际需要 TLS 配置时才引入，
 * 避免在不需要 mTLS 的常规用户场景中增加启动时间。
 *
 * @returns 包含 tls 或 dispatcher 字段的选项对象，无配置时返回空对象
 */
export function getTLSFetchOptions(): {
  tls?: TLSConfig
  dispatcher?: undici.Dispatcher
} {
  const mtlsConfig = getMTLSConfig()
  const caCerts = getCACertificates()

  // 无需 TLS 自定义时，返回空对象（fetch 使用默认行为）
  if (!mtlsConfig && !caCerts) {
    return {}
  }

  // 合并客户端证书和 CA 证书为统一的 TLSConfig
  const tlsConfig: TLSConfig = {
    ...mtlsConfig,
    ...(caCerts && { ca: caCerts }),
  }

  // Bun 运行时通过 tls 字段配置，不使用 undici
  if (typeof Bun !== 'undefined') {
    return { tls: tlsConfig }
  }
  logForDebugging('TLS: Created undici agent with custom certificates')
  // Node.js 场景：惰性加载 undici，创建携带自定义证书的 Agent
  // 惰性加载可以避免 ~1.5MB 的 undici 包在无需 mTLS 时被提前引入
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const undiciMod = require('undici') as typeof undici
  const agent = new undiciMod.Agent({
    connect: {
      cert: tlsConfig.cert,
      key: tlsConfig.key,
      passphrase: tlsConfig.passphrase,
      // 仅在有自定义 CA 时才传入，避免覆盖系统 CA 链
      ...(tlsConfig.ca && { ca: tlsConfig.ca }),
    },
    // pipeline=1 禁用 HTTP 管道以确保每个请求的 TLS 状态独立
    pipelining: 1,
  })

  return { dispatcher: agent }
}

/**
 * 清除 mTLS 配置缓存（用于测试或配置热重载场景）。
 *
 * 调用场景：
 *   - 单元测试中需要在不同测试用例间切换证书配置
 *   - 用户通过 /login 重新登录后需要重新加载证书
 */
export function clearMTLSCache(): void {
  // 清除 getMTLSConfig 的 memoize 缓存
  getMTLSConfig.cache.clear?.()
  // 清除 getMTLSAgent 的 memoize 缓存
  getMTLSAgent.cache.clear?.()
  logForDebugging('Cleared mTLS configuration cache')
}

/**
 * 初始化全局 Node.js TLS 配置（在应用启动时调用）。
 *
 * 当前仅处理 NODE_EXTRA_CA_CERTS 的日志记录，
 * 实际 CA 证书由 Node.js 在进程启动时自动读取该环境变量。
 * 如果 mTLS 未配置（无客户端证书），此函数为空操作。
 */
export function configureGlobalMTLS(): void {
  const mtlsConfig = getMTLSConfig()

  // 无 mTLS 配置时，无需任何全局 TLS 调整
  if (!mtlsConfig) {
    return
  }

  // NODE_EXTRA_CA_CERTS 由 Node.js 自动处理，此处仅记录日志供调试
  if (process.env.NODE_EXTRA_CA_CERTS) {
    logForDebugging(
      'NODE_EXTRA_CA_CERTS detected - Node.js will automatically append to built-in CAs',
    )
  }
}
