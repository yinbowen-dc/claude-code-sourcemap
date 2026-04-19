/**
 * macOS Keychain 预取模块 (keychainPrefetch.ts)
 *
 * 在 Claude Code 系统流程中的位置：
 *   main.tsx 启动顶层 → 【本模块：Keychain 预取】→ 填充 keychainCacheState → 后续同步读取命中缓存
 *
 * 主要职责：
 *   1. 在 main.tsx 模块评估期间（约 65ms）并行启动两个 security(1) 子进程，
 *      消除 macOS 启动时顺序读取 Keychain 的 ~65ms 阻塞延迟
 *   2. 预取完成后填充 keychainCacheState（credentials）和 legacyApiKeyPrefetch（旧 API Key）
 *   3. 超时或进程异常时不填充缓存，允许后续同步调用重试
 *
 * 性能背景：
 *   isRemoteManagedSettingsEligible() 在 applySafeConfigEnvironmentVariables() 中
 *   顺序调用两次 security execSync：
 *     1. "Claude Code-credentials"（OAuth tokens）  — ~32ms
 *     2. "Claude Code"（legacy API key）            — ~33ms
 *   顺序总耗时约 65ms。将两次调用并行化后，
 *   main.tsx preAction 中 await ensureKeychainPrefetchCompleted() 几乎零等待。
 *
 * 导入约束（不可放松）：
 *   本模块在 main.tsx 模块评估最早期被引入，必须避免引入重量级模块。
 *   严禁导入 execa（→ human-signals → cross-spawn，同步模块初始化约 58ms）。
 *   仅允许：child_process + macOsKeychainHelpers.ts（其依赖链已在 startupProfiler.ts 中预热）。
 */

import { execFile } from 'child_process'
import { isBareMode } from '../envUtils.js'
import {
  CREDENTIALS_SERVICE_SUFFIX,
  getMacOsKeychainStorageServiceName,
  getUsername,
  primeKeychainCacheFromPrefetch,
} from './macOsKeychainHelpers.js'

// 预取超时：10 秒，超时则不填充缓存，让后续同步调用自行重试
const KEYCHAIN_PREFETCH_TIMEOUT_MS = 10_000

// 旧版 API Key 预取结果（与 auth.ts getApiKeyFromConfigOrMacOSKeychain() 共享）。
// null = 预取尚未完成或未启动
// { stdout: null } = 预取已完成但无 key（entry not found）
// { stdout: string } = 预取已完成且找到 key
let legacyApiKeyPrefetch: { stdout: string | null } | null = null

// 预取 Promise 单例，防止重复启动
let prefetchPromise: Promise<void> | null = null

// 子进程执行结果类型
type SpawnResult = { stdout: string | null; timedOut: boolean }

/**
 * 通过 execFile 异步调用 security(1) 查找 Keychain 条目。
 *
 * 使用原生 child_process.execFile（非 execa），避免触发重量级模块初始化。
 *
 * 退出码语义：
 *   - 0：找到条目，stdout 包含 key
 *   - 44：条目不存在（entry not found）：安全的"无 key"结果，填充 null
 *   - err.killed=true：超时，不填充缓存（keychain 可能有 key，但暂时不可达）
 *
 * @param serviceName Keychain 服务名称（含可选的目录哈希后缀）
 * @returns { stdout, timedOut }
 */
function spawnSecurity(serviceName: string): Promise<SpawnResult> {
  return new Promise(resolve => {
    execFile(
      'security',
      ['find-generic-password', '-a', getUsername(), '-w', '-s', serviceName],
      { encoding: 'utf-8', timeout: KEYCHAIN_PREFETCH_TIMEOUT_MS },
      (err, stdout) => {
        // timedOut = err.killed：进程被 Node.js 因超时而 kill
        // 超时时不能填充 null（可能有 key，只是暂时读不到），让同步路径重试
        // biome-ignore lint/nursery/noFloatingPromises: resolve() is not a floating promise
        resolve({
          stdout: err ? null : stdout?.trim() || null,
          timedOut: Boolean(err && 'killed' in err && err.killed),
        })
      },
    )
  })
}

/**
 * 启动 Keychain 预取（两个子进程并行执行）。
 *
 * 流程：
 *   1. 仅在 macOS 且未启动过预取且非 bare 模式时执行（非 darwin 为 no-op）
 *   2. 同时 spawn credentials 和 legacy API key 两个 security 进程
 *   3. 两者均完成后：
 *      - oauth 未超时 → 调用 primeKeychainCacheFromPrefetch() 填充 keychainCacheState
 *      - legacy 未超时 → 填充 legacyApiKeyPrefetch
 *
 * 在 main.tsx 顶层立即调用（与 startMdmRawRead() 同层），
 * 子进程与 main.tsx 模块评估并行运行。
 */
export function startKeychainPrefetch(): void {
  // 非 macOS / 已启动 / bare 模式：直接返回
  if (process.platform !== 'darwin' || prefetchPromise || isBareMode()) return

  // 立即并行启动两个子进程（非阻塞）
  const oauthSpawn = spawnSecurity(
    getMacOsKeychainStorageServiceName(CREDENTIALS_SERVICE_SUFFIX),
  )
  const legacySpawn = spawnSecurity(getMacOsKeychainStorageServiceName())

  prefetchPromise = Promise.all([oauthSpawn, legacySpawn]).then(
    ([oauth, legacy]) => {
      // 超时的预取不填充缓存：让后续同步路径使用自己的（更长）超时重试
      // 非超时的预取：填充对应缓存
      if (!oauth.timedOut) primeKeychainCacheFromPrefetch(oauth.stdout)
      if (!legacy.timedOut) legacyApiKeyPrefetch = { stdout: legacy.stdout }
    },
  )
}

/**
 * 等待预取完成（供 main.tsx preAction 调用）。
 *
 * 由于子进程与 main.tsx 模块评估并行运行，await 时子进程几乎已完成，
 * 实际等待时间接近零。非 macOS 平台直接 resolve。
 */
export async function ensureKeychainPrefetchCompleted(): Promise<void> {
  if (prefetchPromise) await prefetchPromise
}

/**
 * 返回旧版 API Key 预取结果，供 auth.ts getApiKeyFromConfigOrMacOSKeychain() 使用。
 *
 * 若预取已完成且有结果，调用方可跳过同步 execSync 调用。
 * 若返回 null，表示预取尚未完成，调用方需自行同步读取。
 *
 * @returns { stdout } 或 null（预取未完成时）
 */
export function getLegacyApiKeyPrefetchResult(): {
  stdout: string | null
} | null {
  return legacyApiKeyPrefetch
}

/**
 * 清除旧版 API Key 预取结果缓存。
 *
 * 与 getApiKeyFromConfigOrMacOSKeychain() 缓存失效逻辑同步调用，
 * 防止过时的预取结果遮蔽新写入的数据。
 */
export function clearLegacyApiKeyPrefetch(): void {
  legacyApiKeyPrefetch = null
}
