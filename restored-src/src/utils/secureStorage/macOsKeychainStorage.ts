/**
 * macOS Keychain 存储实现 (macOsKeychainStorage.ts)
 *
 * 在 Claude Code 系统流程中的位置：
 *   认证层 → getSecureStorage() → createFallbackStorage → 【本模块：Keychain 主存储】
 *
 * 主要职责：
 *   1. 封装 macOS security(1) CLI，实现凭证的 Keychain 读写删除
 *   2. 维护带 TTL（30s）的进程级缓存，避免频繁调用 security spawn
 *   3. 写入时优先使用 stdin 管道（security -i），防止进程监控工具（CrowdStrike 等）在命令行中嗅探凭证
 *   4. Payload 超出 stdin 缓冲区限制（4096-64 字节）时自动降级为 argv 传参
 *   5. 提供 stale-while-error 策略：临时读取失败时继续提供旧缓存，避免"未登录"抖动
 *   6. readAsync() 使用 generation 机制去重并发调用，防止过时结果覆盖新写入
 *
 * 与其他模块的关系：
 *   - keychainCacheState 来自 macOsKeychainHelpers.ts（与 keychainPrefetch.ts 共享）
 *   - 被 secureStorage/index.ts 通过 createFallbackStorage 组合使用
 */

import { execaSync } from 'execa'
import { logForDebugging } from '../debug.js'
import { execFileNoThrow } from '../execFileNoThrow.js'
import { execSyncWithDefaults_DEPRECATED } from '../execFileNoThrowPortable.js'
import { jsonParse, jsonStringify } from '../slowOperations.js'
import {
  CREDENTIALS_SERVICE_SUFFIX,
  clearKeychainCache,
  getMacOsKeychainStorageServiceName,
  getUsername,
  KEYCHAIN_CACHE_TTL_MS,
  keychainCacheState,
} from './macOsKeychainHelpers.js'
import type { SecureStorage, SecureStorageData } from './types.js'

// security -i 使用 fgets(BUFSIZ) 读取 stdin，BUFSIZ 在 darwin 上为 4096 字节。
// 超出此限制的命令行会被截断：第一个 4096 字节作为一条命令解析（未闭合引号 → 失败），
// 溢出部分被解析为第二条未知命令。净结果：非零退出 + **无数据写入**，
// 但旧 Keychain 条目保持不变 —— fallbackStorage 随后读取到过期数据（参考 #30337）。
// 预留 64 字节余量，防止行终止符计数的边缘差异。
const SECURITY_STDIN_LINE_LIMIT = 4096 - 64

/**
 * macOS Keychain 存储实现，满足 SecureStorage 接口。
 */
export const macOsKeychainStorage = {
  name: 'keychain',

  /**
   * 同步读取 Keychain 凭证。
   *
   * 流程：
   *   1. TTL 未到期：直接返回缓存（快速路径）
   *   2. 调用 security find-generic-password 获取 JSON 数据
   *   3. 解析 JSON 并更新缓存
   *   4. stale-while-error：读取失败时若曾有有效数据，继续提供旧缓存并记录 warn
   *   5. 无历史数据时缓存 null
   *
   * 性能说明：
   *   security 同步 spawn 约 500ms，TTL=30s 大幅降低调用频率。
   */
  read(): SecureStorageData | null {
    const prev = keychainCacheState.cache
    // 缓存有效：直接返回
    if (Date.now() - prev.cachedAt < KEYCHAIN_CACHE_TTL_MS) {
      return prev.data
    }

    try {
      const storageServiceName = getMacOsKeychainStorageServiceName(
        CREDENTIALS_SERVICE_SUFFIX,
      )
      const username = getUsername()
      const result = execSyncWithDefaults_DEPRECATED(
        `security find-generic-password -a "${username}" -w -s "${storageServiceName}"`,
      )
      if (result) {
        const data = jsonParse(result)
        // 成功读取：更新缓存
        keychainCacheState.cache = { data, cachedAt: Date.now() }
        return data
      }
    } catch (_e) {
      // 读取失败：进入 stale-while-error 处理
    }
    // stale-while-error：旧数据仍有效时继续使用旧缓存，
    // 防止单次 security spawn 失败导致所有子系统显示"未登录"
    // （clearKeychainCache() 将 data 设为 null，确保显式失效仍会穿透）
    if (prev.data !== null) {
      logForDebugging('[keychain] read failed; serving stale cache', {
        level: 'warn',
      })
      // 刷新 cachedAt，延长旧数据的有效期（避免下次立即重试失败的 spawn）
      keychainCacheState.cache = { data: prev.data, cachedAt: Date.now() }
      return prev.data
    }
    // 无历史数据：缓存 null
    keychainCacheState.cache = { data: null, cachedAt: Date.now() }
    return null
  },

  /**
   * 异步读取 Keychain 凭证（非阻塞，供 readAsync 路径使用）。
   *
   * 相比 read()，额外提供：
   *   - generation 机制：子进程完成时若缓存已被更新（新写入/失效），丢弃结果
   *   - in-flight 去重：TTL 到期时并发的 readAsync() 调用只启动一个子进程
   *
   * 流程：
   *   1. TTL 未到期：直接返回缓存
   *   2. 有 in-flight Promise（正在进行中的子进程）：复用该 Promise
   *   3. 启动新子进程，记录当前 generation 用于结果有效性校验
   *   4. 子进程完成后：若 generation 匹配则更新缓存，否则丢弃
   *   5. stale-while-error 与 read() 一致
   */
  async readAsync(): Promise<SecureStorageData | null> {
    const prev = keychainCacheState.cache
    // 缓存命中：直接返回
    if (Date.now() - prev.cachedAt < KEYCHAIN_CACHE_TTL_MS) {
      return prev.data
    }
    // in-flight 去重：复用正在进行的子进程 Promise
    if (keychainCacheState.readInFlight) {
      return keychainCacheState.readInFlight
    }

    // 捕获当前 generation，用于后续检查结果是否仍有效
    const gen = keychainCacheState.generation
    const promise = doReadAsync().then(data => {
      // generation 已变（update/delete 导致缓存失效）：丢弃过时结果
      if (gen === keychainCacheState.generation) {
        // stale-while-error：读取失败时复用旧数据
        if (data === null && prev.data !== null) {
          logForDebugging('[keychain] readAsync failed; serving stale cache', {
            level: 'warn',
          })
        }
        const next = data ?? prev.data
        keychainCacheState.cache = { data: next, cachedAt: Date.now() }
        keychainCacheState.readInFlight = null
        return next
      }
      return data
    })
    // 注册 in-flight Promise，使并发调用复用
    keychainCacheState.readInFlight = promise
    return promise
  },

  /**
   * 向 Keychain 写入凭证数据。
   *
   * 安全策略：
   *   - 优先通过 stdin（security -i）传输凭证，进程监控工具（CrowdStrike 等）
   *     只会看到 "security -i"，而不是带 payload 的命令行（参考 INC-3028）
   *   - Payload 转为十六进制，进一步防止明文 grep 规则匹配
   *   - 当 stdin 命令行长度超过 SECURITY_STDIN_LINE_LIMIT（4096-64）时，
   *     降级为 argv 传参（ARG_MAX 约 1MB，实际无限制）并记录 warn
   *
   * 流程：
   *   1. 失效缓存（确保下次读取不使用旧数据）
   *   2. 序列化并编码为十六进制
   *   3. 根据 payload 长度选择 stdin 或 argv 模式
   *   4. 检查 exitCode，成功则更新缓存
   */
  update(data: SecureStorageData): { success: boolean; warning?: string } {
    // 写入前先失效缓存
    clearKeychainCache()

    try {
      const storageServiceName = getMacOsKeychainStorageServiceName(
        CREDENTIALS_SERVICE_SUFFIX,
      )
      const username = getUsername()
      const jsonString = jsonStringify(data)

      // 将 JSON 转为十六进制：防止任何转义问题，同时隐藏明文内容
      const hexValue = Buffer.from(jsonString, 'utf-8').toString('hex')

      // 构建 stdin 命令字符串（security -i 期望每行一条命令）
      const command = `add-generic-password -U -a "${username}" -s "${storageServiceName}" -X "${hexValue}"\n`

      let result
      if (command.length <= SECURITY_STDIN_LINE_LIMIT) {
        // stdin 模式：安全，进程监控工具不可见 payload
        result = execaSync('security', ['-i'], {
          input: command,
          stdio: ['pipe', 'pipe', 'pipe'],
          reject: false,
        })
      } else {
        // argv 模式：Payload 过大，降级到命令行参数（仍使用十六进制，抵御简单 grep）
        logForDebugging(
          `Keychain payload (${jsonString.length}B JSON) exceeds security -i stdin limit; using argv`,
          { level: 'warn' },
        )
        result = execaSync(
          'security',
          [
            'add-generic-password',
            '-U',
            '-a',
            username,
            '-s',
            storageServiceName,
            '-X',
            hexValue,
          ],
          { stdio: ['ignore', 'pipe', 'pipe'], reject: false },
        )
      }

      if (result.exitCode !== 0) {
        return { success: false }
      }

      // 写入成功：更新缓存（无需再次读取 Keychain）
      keychainCacheState.cache = { data, cachedAt: Date.now() }
      return { success: true }
    } catch (_e) {
      return { success: false }
    }
  },

  /**
   * 从 Keychain 删除凭证条目。
   *
   * 流程：
   *   1. 失效缓存
   *   2. 调用 security delete-generic-password
   *   3. 成功返回 true，任何异常返回 false
   */
  delete(): boolean {
    // 删除前先失效缓存
    clearKeychainCache()

    try {
      const storageServiceName = getMacOsKeychainStorageServiceName(
        CREDENTIALS_SERVICE_SUFFIX,
      )
      const username = getUsername()
      execSyncWithDefaults_DEPRECATED(
        `security delete-generic-password -a "${username}" -s "${storageServiceName}"`,
      )
      return true
    } catch (_e) {
      return false
    }
  },
} satisfies SecureStorage

/**
 * doReadAsync 的内部实现：通过 execFileNoThrow 异步调用 security，
 * 解析并返回凭证数据。
 *
 * 与 read() 的区别：使用异步 execFileNoThrow（非同步 execSyncWithDefaults_DEPRECATED），
 * 避免阻塞 Node.js 事件循环。
 *
 * @returns 解析后的凭证数据，读取失败时返回 null
 */
async function doReadAsync(): Promise<SecureStorageData | null> {
  try {
    const storageServiceName = getMacOsKeychainStorageServiceName(
      CREDENTIALS_SERVICE_SUFFIX,
    )
    const username = getUsername()
    const { stdout, code } = await execFileNoThrow(
      'security',
      ['find-generic-password', '-a', username, '-w', '-s', storageServiceName],
      { useCwd: false, preserveOutputOnError: false },
    )
    if (code === 0 && stdout) {
      return jsonParse(stdout.trim())
    }
  } catch (_e) {
    // 读取失败：调用方处理 null
  }
  return null
}

// 进程级 Keychain 锁定状态缓存（undefined = 尚未检测）
let keychainLockedCache: boolean | undefined

/**
 * 检查 macOS Keychain 是否处于锁定状态。
 *
 * 场景：SSH 会话中 Keychain 通常不会自动解锁，导致读写失败。
 * 通过 security show-keychain-info 的退出码 36 检测锁定状态。
 *
 * 缓存策略：
 *   结果缓存为进程级单例（不过期）。
 *   原因：security(1) spawn 约 27ms，本函数从 AssistantTextMessage render 调用。
 *   虚拟滚动重挂载时（含"未登录"消息的会话），每次重挂载都会触发，
 *   未缓存时每条消息增加 27ms 提交耗时。
 *   Keychain 锁定状态在 CLI 会话期间不会改变，进程级缓存安全。
 *
 * @returns true = macOS 且 Keychain 已锁定；false = 其他
 */
export function isMacOsKeychainLocked(): boolean {
  // 已有缓存结果：直接返回
  if (keychainLockedCache !== undefined) return keychainLockedCache
  // 非 macOS：不可能锁定
  if (process.platform !== 'darwin') {
    keychainLockedCache = false
    return false
  }

  try {
    const result = execaSync('security', ['show-keychain-info'], {
      reject: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    // 退出码 36 = Keychain 已锁定（errSecInteractionRequired）
    keychainLockedCache = result.exitCode === 36
  } catch {
    // 命令失败（系统异常等）：假设未锁定，允许后续正常读写
    keychainLockedCache = false
  }
  return keychainLockedCache
}
