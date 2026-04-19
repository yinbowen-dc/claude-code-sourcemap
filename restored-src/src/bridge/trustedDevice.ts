/**
 * trustedDevice.ts — Bridge v2 受信任设备令牌管理
 *
 * 在 Claude Code 系统流程中的位置：
 *   Bridge 认证层（bridgeApi.ts / login 流程）
 *     └─> trustedDevice.ts（本文件）——管理 ELEVATED 安全级别的设备令牌（获取、注册、清除）
 *
 * 背景（CCR v2 ELEVATED 认证）：
 *   Bridge 会话在服务端具有 SecurityTier=ELEVATED 安全级别（CCR v2）。
 *   服务端通过 ConnectBridgeWorker 接口门控受信任设备检查。
 *   客户端通过在 HTTP 请求头中携带 X-Trusted-Device-Token 来满足此检查。
 *
 * 双重门控（两阶段功能开关）：
 *   1. 服务端门控（sessions_elevated_auth_enforcement）：控制服务端是否校验令牌
 *   2. 客户端门控（tengu_sessions_elevated_auth_enforcement）：控制 CLI 是否发送令牌
 *   先开启客户端门控（令牌开始流动，服务端暂不处理）→ 再开启服务端门控（分阶段推进）。
 *
 * 注册约束：
 *   POST /auth/trusted_devices 由服务端限制为：account_session.created_at < 10 分钟内。
 *   因此注册必须在 /login 流程中立即执行，而不能在后续（如 /bridge 403 时）懒加载注册。
 *
 * 令牌存储：
 *   - 令牌有效期 90 天（滚动过期），持久化到系统 keychain（secureStorage）
 *   - readStoredToken() 通过 memoize 缓存，避免每次 poll/心跳/ack 都调用 macOS security 子进程（~40ms）
 *
 * 相关规格文档：anthropics/anthropic#274559（规格）、#310375（B1b 租户 RPC）、
 *   #295987（B2 Python 路由）、#307150（C1' CCR v2 门控）
 */
import axios from 'axios'
import memoize from 'lodash-es/memoize.js'
import { hostname } from 'os'
import { getOauthConfig } from '../constants/oauth.js'
import {
  checkGate_CACHED_OR_BLOCKING,
  getFeatureValue_CACHED_MAY_BE_STALE,
} from '../services/analytics/growthbook.js'
import { logForDebugging } from '../utils/debug.js'
import { errorMessage } from '../utils/errors.js'
import { isEssentialTrafficOnly } from '../utils/privacyLevel.js'
import { getSecureStorage } from '../utils/secureStorage/index.js'
import { jsonStringify } from '../utils/slowOperations.js'

/**
 * Trusted device token source for bridge (remote-control) sessions.
 *
 * Bridge sessions have SecurityTier=ELEVATED on the server (CCR v2).
 * The server gates ConnectBridgeWorker on its own flag
 * (sessions_elevated_auth_enforcement in Anthropic Main); this CLI-side
 * flag controls whether the CLI sends X-Trusted-Device-Token at all.
 * Two flags so rollout can be staged: flip CLI-side first (headers
 * start flowing, server still no-ops), then flip server-side.
 *
 * Enrollment (POST /auth/trusted_devices) is gated server-side by
 * account_session.created_at < 10min, so it must happen during /login.
 * Token is persistent (90d rolling expiry) and stored in keychain.
 *
 * See anthropics/anthropic#274559 (spec), #310375 (B1b tenant RPCs),
 * #295987 (B2 Python routes), #307150 (C1' CCR v2 gate).
 */

/** GrowthBook feature flag 名称（控制客户端是否发送 X-Trusted-Device-Token） */
const TRUSTED_DEVICE_GATE = 'tengu_sessions_elevated_auth_enforcement'

/**
 * 检查客户端 GrowthBook 门控是否启用。
 *
 * 使用 _CACHED_MAY_BE_STALE 变体：允许轻微的数据陈旧，
 * 但每次调用都会读取最新缓存，避免对每次轮询/心跳的性能影响。
 */
function isGateEnabled(): boolean {
  return getFeatureValue_CACHED_MAY_BE_STALE(TRUSTED_DEVICE_GATE, false)
}

/**
 * 从 keychain 读取受信任设备令牌（带 memoize 缓存）。
 *
 * 缓存原因：secureStorage.read() 会调用 macOS security 子进程（约 40ms 延迟）。
 * bridgeApi.ts 在每次 poll/heartbeat/ack 的 getHeaders() 中调用此函数——无缓存会严重影响性能。
 *
 * 仅缓存存储读取结果——GrowthBook 门控每次实时检查，
 * 使门控翻转后无需重启即可生效（GrowthBook 刷新后自动更新）。
 *
 * 优先级：环境变量 CLAUDE_TRUSTED_DEVICE_TOKEN > keychain 存储令牌
 * （环境变量适用于测试/金丝雀场景）。
 *
 * 缓存清除时机：注册成功后（enrollTrustedDevice）、登出时（clearAuthRelatedCaches）。
 *
 * Memoized — secureStorage.read() spawns a macOS `security` subprocess (~40ms).
 * bridgeApi.ts calls this from getHeaders() on every poll/heartbeat/ack.
 */
const readStoredToken = memoize((): string | undefined => {
  // 环境变量优先级最高（测试/金丝雀场景）
  const envToken = process.env.CLAUDE_TRUSTED_DEVICE_TOKEN
  if (envToken) {
    return envToken
  }
  return getSecureStorage().read()?.trustedDeviceToken // 从 keychain 读取
})

/**
 * 获取受信任设备令牌（供 bridgeApi.ts 的 getHeaders() 调用）。
 *
 * 流程：
 *   1. 检查 GrowthBook 门控（isGateEnabled）——未启用时返回 undefined
 *   2. 调用 readStoredToken()（带缓存）读取令牌
 *
 * 返回 undefined 时，调用方不应在请求头中携带 X-Trusted-Device-Token。
 */
export function getTrustedDeviceToken(): string | undefined {
  if (!isGateEnabled()) {
    return undefined // 门控未启用，不发送令牌
  }
  return readStoredToken()
}

/**
 * 清除受信任设备令牌的 memoize 缓存。
 *
 * 在注册新令牌后调用（enrollTrustedDevice），
 * 以及在登出时通过 clearAuthRelatedCaches 调用，
 * 确保后续 getHeaders() 调用能读取最新令牌。
 */
export function clearTrustedDeviceTokenCache(): void {
  readStoredToken.cache?.clear?.()
}

/**
 * 从 keychain 删除受信任设备令牌并清除 memoize 缓存。
 *
 * 在 enrollTrustedDevice() 执行前（/login 期间）调用，
 * 防止旧账户的令牌在注册进行中时被发送为 X-Trusted-Device-Token
 * （enrollTrustedDevice 是异步的——注册完成前的 bridge API 调用
 * 否则仍会读取旧缓存的令牌）。
 *
 * 仅在门控启用时操作（与其他操作保持一致）。
 * Best-effort：存储不可访问时记录日志并继续，不阻断登录流程。
 *
 * Clear the stored trusted device token from secure storage and the memo cache.
 * Called before enrollTrustedDevice() during /login so a stale token from the
 * previous account isn't sent as X-Trusted-Device-Token while enrollment is
 * in-flight.
 */
export function clearTrustedDeviceToken(): void {
  if (!isGateEnabled()) {
    return // 门控未启用，无操作
  }
  const secureStorage = getSecureStorage()
  try {
    const data = secureStorage.read()
    if (data?.trustedDeviceToken) {
      delete data.trustedDeviceToken // 删除令牌字段
      secureStorage.update(data) // 持久化更改
    }
  } catch {
    // Best-effort——存储不可访问时不阻断登录流程
  }
  readStoredToken.cache?.clear?.() // 清除 memoize 缓存
}

/**
 * 注册本设备为受信任设备并将令牌持久化到 keychain。
 *
 * 注册流程（Best-effort，失败时记录日志并返回，不阻断登录）：
 *   1. 等待 GrowthBook 刷新完成（checkGate_CACHED_OR_BLOCKING，获取后刷新值）
 *   2. 检查门控——门控关闭时跳过注册
 *   3. 检查环境变量——CLAUDE_TRUSTED_DEVICE_TOKEN 已设置时跳过注册
 *   4. 懒加载 utils/auth.ts（避免引入 ~1300 个模块的重型依赖链）
 *   5. 获取当前 OAuth 访问令牌——无令牌时跳过
 *   6. 检查 essential traffic only 模式——启用时跳过
 *   7. POST /api/auth/trusted_devices（含机器名和平台信息）
 *   8. 解析响应中的 device_token
 *   9. 将令牌写入 keychain（secureStorage.update）
 *   10. 清除 memoize 缓存，使后续 getHeaders() 读取新令牌
 *
 * 注意：服务端要求 account_session.created_at < 10 分钟，
 * 因此必须在 /login 完成后立即调用，不能懒加载（如在 /bridge 403 时）。
 *
 * Enroll this device via POST /auth/trusted_devices and persist the token
 * to keychain. Best-effort — logs and returns on failure so callers
 * (post-login hooks) don't block the login flow.
 */
export async function enrollTrustedDevice(): Promise<void> {
  try {
    // checkGate_CACHED_OR_BLOCKING 会等待任何进行中的 GrowthBook 重初始化完成
    // （由 login.tsx 中的 refreshGrowthBookAfterAuthChange 触发），
    // 确保读取到刷新后的门控值（而非登录前的旧缓存值）
    if (!(await checkGate_CACHED_OR_BLOCKING(TRUSTED_DEVICE_GATE))) {
      logForDebugging(
        `[trusted-device] Gate ${TRUSTED_DEVICE_GATE} is off, skipping enrollment`,
      )
      return // 门控未开启，跳过注册
    }
    // 若 CLAUDE_TRUSTED_DEVICE_TOKEN 已设置（如企业封装脚本注入），
    // 跳过注册——环境变量在 readStoredToken() 中优先，任何注册的令牌都会被遮蔽
    if (process.env.CLAUDE_TRUSTED_DEVICE_TOKEN) {
      logForDebugging(
        '[trusted-device] CLAUDE_TRUSTED_DEVICE_TOKEN env var is set, skipping enrollment (env var takes precedence)',
      )
      return // 环境变量已设置，无需注册
    }
    // 懒加载 utils/auth.ts——该模块传递依赖约 1300 个模块
    // （config → file → permissions → sessionStorage → commands）。
    // daemon 调用方（只调用 getTrustedDeviceToken）不需要此依赖；仅 /login 需要。
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { getClaudeAIOAuthTokens } =
      require('../utils/auth.js') as typeof import('../utils/auth.js')
    /* eslint-enable @typescript-eslint/no-require-imports */
    const accessToken = getClaudeAIOAuthTokens()?.accessToken
    if (!accessToken) {
      logForDebugging('[trusted-device] No OAuth token, skipping enrollment')
      return // 无 OAuth 令牌，跳过注册
    }
    // 每次 /login 都重新注册——现有令牌可能属于其他账户
    // （账户切换但未 /logout）。跳过注册会导致旧账户令牌被发送到新账户的 bridge 调用
    const secureStorage = getSecureStorage()

    if (isEssentialTrafficOnly()) {
      logForDebugging(
        '[trusted-device] Essential traffic only, skipping enrollment',
      )
      return // 仅必要流量模式，跳过注册
    }

    const baseUrl = getOauthConfig().BASE_API_URL
    let response
    try {
      // POST /api/auth/trusted_devices，附带机器名和平台信息
      response = await axios.post<{
        device_token?: string
        device_id?: string
      }>(
        `${baseUrl}/api/auth/trusted_devices`,
        { display_name: `Claude Code on ${hostname()} · ${process.platform}` },
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          timeout: 10_000, // 10 秒超时
          validateStatus: s => s < 500, // 4xx 响应不抛出异常（允许处理错误详情）
        },
      )
    } catch (err: unknown) {
      logForDebugging(
        `[trusted-device] Enrollment request failed: ${errorMessage(err)}`,
      )
      return // 网络错误，跳过（best-effort）
    }

    if (response.status !== 200 && response.status !== 201) {
      logForDebugging(
        `[trusted-device] Enrollment failed ${response.status}: ${jsonStringify(response.data).slice(0, 200)}`,
      )
      return // 服务端拒绝，跳过（best-effort）
    }

    const token = response.data?.device_token
    if (!token || typeof token !== 'string') {
      logForDebugging(
        '[trusted-device] Enrollment response missing device_token field',
      )
      return // 响应体缺少令牌字段，跳过
    }

    try {
      // 将 device_token 持久化到 keychain
      const storageData = secureStorage.read()
      if (!storageData) {
        logForDebugging(
          '[trusted-device] Cannot read storage, skipping token persist',
        )
        return
      }
      storageData.trustedDeviceToken = token // 写入令牌
      const result = secureStorage.update(storageData)
      if (!result.success) {
        logForDebugging(
          `[trusted-device] Failed to persist token: ${result.warning ?? 'unknown'}`,
        )
        return
      }
      readStoredToken.cache?.clear?.() // 清除旧令牌缓存，使后续调用读取新令牌
      logForDebugging(
        `[trusted-device] Enrolled device_id=${response.data.device_id ?? 'unknown'}`,
      )
    } catch (err: unknown) {
      logForDebugging(
        `[trusted-device] Storage write failed: ${errorMessage(err)}`,
      )
    }
  } catch (err: unknown) {
    logForDebugging(`[trusted-device] Enrollment error: ${errorMessage(err)}`)
  }
}
