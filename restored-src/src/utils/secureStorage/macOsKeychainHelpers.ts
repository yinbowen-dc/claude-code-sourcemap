/**
 * macOS Keychain 共享辅助模块 (macOsKeychainHelpers.ts)
 *
 * 在 Claude Code 系统流程中的位置：
 *   keychainPrefetch.ts（启动预取） + macOsKeychainStorage.ts（正常读写）
 *     → 【本模块：共享缓存状态 + 服务名生成 + 缓存操作】
 *
 * 主要职责：
 *   1. 生成唯一且稳定的 Keychain 服务名（支持自定义配置目录时附加 SHA256 哈希后缀）
 *   2. 维护跨模块共享的 Keychain 读取缓存（TTL=30s，三字段状态机）
 *   3. 提供缓存失效（clearKeychainCache）和预取结果填充（primeKeychainCacheFromPrefetch）接口
 *
 * 严格导入约束（不可放松）：
 *   本模块被 keychainPrefetch.ts 在 main.tsx 最早期导入。
 *   必须 **不能** 导入 execa / execFileNoThrow / execFileNoThrowPortable：
 *   execa → human-signals → cross-spawn 链会在模块初始化时同步执行约 58ms。
 *   允许的依赖（已在 startupProfiler.ts:5 预热）：crypto、os、envUtils、oauth constants。
 *
 * 使用 keychainCacheState 对象包装三个字段的原因：
 *   ES 模块 `let` 绑定跨模块不可写（只有本模块能修改），
 *   包装为对象后，两个导入方（keychainPrefetch.ts 和 macOsKeychainStorage.ts）
 *   均可通过对象引用修改 cache / generation / readInFlight。
 */

import { createHash } from 'crypto'
import { userInfo } from 'os'
import { getOauthConfig } from 'src/constants/oauth.js'
import { getClaudeConfigHomeDir } from '../envUtils.js'
import type { SecureStorageData } from './types.js'

// Keychain 条目后缀：区分 OAuth credentials 条目与旧版 API key 条目（旧版无后缀）。
// 警告：**不可更改此值** —— 它是 Keychain 查找键的一部分，修改会导致已存凭证成为孤儿。
export const CREDENTIALS_SERVICE_SUFFIX = '-credentials'

/**
 * 生成 Keychain 服务名。
 *
 * 命名规则：
 *   `Claude Code{OAUTH_FILE_SUFFIX}{serviceSuffix}{dirHash}`
 *
 * dirHash 逻辑：
 *   - 使用默认配置目录（未设置 CLAUDE_CONFIG_DIR）：无哈希后缀（保持向后兼容）
 *   - 使用自定义配置目录：附加 configDir 路径的 SHA256 前 8 位（确保不同目录的条目互不干扰）
 *
 * @param serviceSuffix 条目类型后缀，默认为空字符串（旧版 API key 条目）
 * @returns Keychain 服务名字符串
 */
export function getMacOsKeychainStorageServiceName(
  serviceSuffix: string = '',
): string {
  const configDir = getClaudeConfigHomeDir()
  const isDefaultDir = !process.env.CLAUDE_CONFIG_DIR

  // 自定义目录：取路径 SHA256 前 8 位作为后缀，防止多个实例条目冲突
  const dirHash = isDefaultDir
    ? ''
    : `-${createHash('sha256').update(configDir).digest('hex').substring(0, 8)}`
  return `Claude Code${getOauthConfig().OAUTH_FILE_SUFFIX}${serviceSuffix}${dirHash}`
}

/**
 * 获取当前系统用户名，用于 Keychain 账户字段（-a 参数）。
 *
 * 优先读取 process.env.USER，其次通过 os.userInfo() 获取，
 * 两者均失败时（如某些容器/CI 环境）使用硬编码后备值。
 *
 * @returns 系统用户名字符串
 */
export function getUsername(): string {
  try {
    return process.env.USER || userInfo().username
  } catch {
    return 'claude-code-user'
  }
}

// --
// Keychain 读取缓存
// --
//
// 设计目标：
//   - 避免每次读取都调用 security(1)（同步约 500ms/次）
//   - TTL=30s 覆盖跨进程场景（另一个 CC 实例刷新/失效 token），
//     30s 以内的过期可接受：OAuth token 以小时计过期，跨进程写入方仅为另一个 CC 的 /login
//   - 进程内写入直接通过 clearKeychainCache() 失效，无需等待 TTL
//
// 历史背景（性能问题）：
//   同步 read() 约 500ms/spawn。50+ claude.ai MCP 连接器并发启动时，
//   TTL 短则并发到期触发多次同步读取，导致事件循环阻塞 5.5s。
//   TTL=30s 可安全覆盖绝大多数场景（参考 go/ccshare/adamj-20260326-212235）。
//
// 存放于本模块（非 macOsKeychainStorage.ts）的原因：
//   keychainPrefetch.ts 需在不引入 execa 的前提下填充缓存，
//   而 macOsKeychainStorage.ts 依赖 execa，不可被预取模块直接引用。
export const KEYCHAIN_CACHE_TTL_MS = 30_000

/**
 * Keychain 缓存状态对象（跨模块共享，通过对象引用可写）。
 *
 * cache：
 *   - data：缓存数据（null = 无数据或已失效）
 *   - cachedAt：缓存时间戳（0 = 尚未缓存）
 *
 * generation：
 *   每次调用 clearKeychainCache() 时自增。
 *   readAsync() 在启动子进程前捕获当前 generation，
 *   子进程完成后若 generation 已变则丢弃结果，防止过时数据覆盖更新的写入。
 *
 * readInFlight：
 *   去重并发的 readAsync() 调用：TTL 到期时若同时有 N 个调用，
 *   只启动一个子进程，其余等待同一 Promise，不产生 N 次 spawn。
 *   缓存失效时同步清空，确保新调用不复用已失效的 in-flight Promise。
 */
export const keychainCacheState: {
  cache: { data: SecureStorageData | null; cachedAt: number } // cachedAt=0 表示未缓存
  generation: number
  readInFlight: Promise<SecureStorageData | null> | null
} = {
  cache: { data: null, cachedAt: 0 },
  generation: 0,
  readInFlight: null,
}

/**
 * 立即失效 Keychain 缓存，确保下次读取不使用旧数据。
 *
 * 在 update() 和 delete() 之前调用，防止写入后立即读取时命中旧缓存。
 * generation 自增 + readInFlight 清空，使进行中的 readAsync() 不会覆盖新写入的数据。
 */
export function clearKeychainCache(): void {
  keychainCacheState.cache = { data: null, cachedAt: 0 }
  keychainCacheState.generation++
  keychainCacheState.readInFlight = null
}

/**
 * 将 keychainPrefetch.ts 的预取结果填充到缓存（仅在缓存未被其他路径填充时执行）。
 *
 * 安全保护：仅当 cachedAt === 0 时才填充（表示缓存自模块加载以来未被触碰）。
 * 若同步 read() 或 update() 已先行执行，其结果具有更高权威性，丢弃预取结果。
 *
 * @param stdout security(1) 的原始输出（JSON 字符串或 null）
 */
export function primeKeychainCacheFromPrefetch(stdout: string | null): void {
  // 缓存已被其他路径填充：丢弃预取结果
  if (keychainCacheState.cache.cachedAt !== 0) return
  let data: SecureStorageData | null = null
  if (stdout) {
    try {
      // 注意：此处直接使用 JSON.parse 而非 jsonParse()，
      // 避免 jsonParse() 依赖的 lodash-es/cloneDeep 进入早期启动导入链
      // eslint-disable-next-line custom-rules/no-direct-json-operations
      data = JSON.parse(stdout)
    } catch {
      // 预取结果格式错误：丢弃，让同步 read() 重新获取
      return
    }
  }
  keychainCacheState.cache = { data, cachedAt: Date.now() }
}
