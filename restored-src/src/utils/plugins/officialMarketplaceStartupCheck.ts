/**
 * 官方 Anthropic 插件市场启动自动安装模块。
 *
 * 在 Claude Code 插件系统流程中，本文件处于"首次使用引导"层：
 *   - 在应用启动时作为后台 fire-and-forget 任务调用，
 *     自动为新用户安装官方 Anthropic 插件市场；
 *   - 安装策略（按优先级）：
 *     1. GCS 镜像下载（fetchOfficialMarketplaceFromGcs）—— 无需 git，不直接访问 GitHub；
 *     2. git clone（addMarketplaceSource）—— GCS 失败且 git 可用且特性开关允许时回退；
 *   - 使用指数退避重试机制（初始 1 小时，最大 1 周，最多 10 次），
 *     持久化安装状态到 GlobalConfig（`~/.claude/settings.json`）；
 *   - 在以下情况下跳过安装：
 *     · 已成功安装（already_installed）
 *     · 企业策略禁止（policy_blocked）—— 不重试
 *     · 环境变量禁用（CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL）
 *     · 已达最大重试次数（already_attempted）
 *
 * 主要导出：
 *   - checkAndInstallOfficialMarketplace()：启动时自动安装的总入口
 *   - isOfficialMarketplaceAutoInstallDisabled()：检查环境变量禁用状态
 *   - RETRY_CONFIG：重试配置常量
 *   - OfficialMarketplaceSkipReason / OfficialMarketplaceCheckResult：结果类型
 */

import { join } from 'path'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import { logEvent } from '../../services/analytics/index.js'
import { getGlobalConfig, saveGlobalConfig } from '../config.js'
import { logForDebugging } from '../debug.js'
import { isEnvTruthy } from '../envUtils.js'
import { toError } from '../errors.js'
import { logError } from '../log.js'
import { checkGitAvailable, markGitUnavailable } from './gitAvailability.js'
import { isSourceAllowedByPolicy } from './marketplaceHelpers.js'
import {
  addMarketplaceSource,
  getMarketplacesCacheDir,
  loadKnownMarketplacesConfig,
  saveKnownMarketplacesConfig,
} from './marketplaceManager.js'
import {
  OFFICIAL_MARKETPLACE_NAME,
  OFFICIAL_MARKETPLACE_SOURCE,
} from './officialMarketplace.js'
import { fetchOfficialMarketplaceFromGcs } from './officialMarketplaceGcs.js'

/**
 * 官方市场未安装时的跳过原因枚举。
 *
 * - already_attempted：已尝试过且达到最大重试次数
 * - already_installed：市场已存在于 known_marketplaces.json
 * - policy_blocked：企业策略或环境变量禁止安装（永久，不重试）
 * - git_unavailable：git 不可用（临时，会重试）
 * - gcs_unavailable：GCS 下载失败且 git 回退被特性开关禁用（临时，会重试）
 * - unknown：其他安装失败（临时，会重试）
 */
export type OfficialMarketplaceSkipReason =
  | 'already_attempted'
  | 'already_installed'
  | 'policy_blocked'
  | 'git_unavailable'
  | 'gcs_unavailable'
  | 'unknown'

/**
 * 检查是否通过环境变量禁用了官方市场自动安装。
 *
 * 环境变量：CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL
 * 设置为真值（"1"、"true" 等）时禁用自动安装。
 */
export function isOfficialMarketplaceAutoInstallDisabled(): boolean {
  return isEnvTruthy(
    process.env.CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL,
  )
}

/**
 * 指数退避重试配置。
 *
 * - MAX_ATTEMPTS：最大重试次数（10 次）
 * - INITIAL_DELAY_MS：首次失败后的等待时间（1 小时）
 * - BACKOFF_MULTIPLIER：每次重试的等待时间倍增系数（2x）
 * - MAX_DELAY_MS：最大等待时间上限（1 周）
 *
 * 重试延迟序列（近似）：1h, 2h, 4h, 8h, 16h, 32h, 64h, 128h(→ 1 周), 1 周, 1 周
 */
export const RETRY_CONFIG = {
  MAX_ATTEMPTS: 10,
  INITIAL_DELAY_MS: 60 * 60 * 1000, // 1 小时（毫秒）
  BACKOFF_MULTIPLIER: 2, // 指数退避倍增系数
  MAX_DELAY_MS: 7 * 24 * 60 * 60 * 1000, // 1 周（毫秒）
}

/**
 * 根据重试次数计算下次重试的等待时间（指数退避）。
 *
 * 公式：min(初始延迟 × 倍增系数^重试次数, 最大延迟)
 *
 * @param retryCount 已重试次数（0 表示首次失败后的第一次重试）
 * @returns 下次重试前需等待的毫秒数
 */
function calculateNextRetryDelay(retryCount: number): number {
  // 指数退避：初始延迟 × 2^retryCount，最大不超过 MAX_DELAY_MS
  const delay =
    RETRY_CONFIG.INITIAL_DELAY_MS *
    Math.pow(RETRY_CONFIG.BACKOFF_MULTIPLIER, retryCount)
  return Math.min(delay, RETRY_CONFIG.MAX_DELAY_MS)
}

/**
 * 根据 GlobalConfig 中的失败原因和重试状态，判断是否应该重试安装。
 *
 * 跳过重试的条件：
 *   - 从未尝试过 → 立即尝试（返回 true）
 *   - 已成功安装 → 不重试（返回 false）
 *   - 重试次数已达上限（>= MAX_ATTEMPTS）→ 不重试（返回 false）
 *   - 失败原因为 policy_blocked → 永久跳过（返回 false）
 *   - 下次重试时间未到 → 等待（返回 false）
 *   - 其他临时失败（unknown、git_unavailable、gcs_unavailable、undefined） → 重试（返回 true）
 *
 * @param config 当前 GlobalConfig 对象
 * @returns true 表示应该尝试安装，false 表示应该跳过
 */
function shouldRetryInstallation(
  config: ReturnType<typeof getGlobalConfig>,
): boolean {
  // 从未尝试过：应该立即尝试
  if (!config.officialMarketplaceAutoInstallAttempted) {
    return true
  }

  // 已成功安装：不需要重试
  if (config.officialMarketplaceAutoInstalled) {
    return false
  }

  const failReason = config.officialMarketplaceAutoInstallFailReason
  const retryCount = config.officialMarketplaceAutoInstallRetryCount || 0
  const nextRetryTime = config.officialMarketplaceAutoInstallNextRetryTime
  const now = Date.now()

  // 已达最大重试次数：不再重试
  if (retryCount >= RETRY_CONFIG.MAX_ATTEMPTS) {
    return false
  }

  // 策略阻止（永久性失败）：不重试
  if (failReason === 'policy_blocked') {
    return false
  }

  // 下次重试时间尚未到达：等待
  if (nextRetryTime && now < nextRetryTime) {
    return false
  }

  // 临时失败（unknown）、半永久失败（git_unavailable、gcs_unavailable）
  // 以及旧版状态（undefined，在重试逻辑引入前的状态）均应重试
  return (
    failReason === 'unknown' ||
    failReason === 'git_unavailable' ||
    failReason === 'gcs_unavailable' ||
    failReason === undefined
  )
}

/**
 * 官方市场自动安装检查的结果类型。
 */
export type OfficialMarketplaceCheckResult = {
  /** 是否成功安装了市场 */
  installed: boolean
  /** 是否跳过了安装（以及跳过原因） */
  skipped: boolean
  /** 跳过原因（仅在 skipped 为 true 时有值） */
  reason?: OfficialMarketplaceSkipReason
  /** 保存重试元数据到 GlobalConfig 时是否失败 */
  configSaveFailed?: boolean
}

/**
 * 在启动时检查并安装官方插件市场。
 *
 * 设计为 fire-and-forget 操作（在启动时调用，不阻塞主流程）。
 *
 * 执行流程：
 *   1. 调用 shouldRetryInstallation() 判断是否需要尝试安装；
 *   2. 检查环境变量禁用标志；
 *   3. 检查市场是否已存在于 known_marketplaces.json；
 *   4. 检查企业策略是否允许官方市场来源；
 *   5. 优先尝试 GCS 镜像下载（fetchOfficialMarketplaceFromGcs）：
 *      - 成功：直接注册市场，写入 known_marketplaces.json，返回成功；
 *      - 失败：检查特性开关（tengu_plugin_official_mkt_git_fallback），
 *        若关闭则以 gcs_unavailable 记录并退避重试；
 *   6. GCS 失败且特性开关允许时：检查 git 可用性，调用 addMarketplaceSource() 克隆；
 *   7. 任何失败均记录退避时间和重试计数到 GlobalConfig，并上报遥测事件；
 *   8. macOS xcrun shim 特殊处理：shim 存在但 Xcode CLT 未安装时，
 *      clone 会报 "xcrun: error"，此时标记 git 不可用并返回（不记录退避，下次启动重试）。
 *
 * @returns 安装结果（包含是否成功、跳过原因等）
 */
export async function checkAndInstallOfficialMarketplace(): Promise<OfficialMarketplaceCheckResult> {
  const config = getGlobalConfig()

  // 判断是否需要尝试安装（基于失败原因、重试次数和下次重试时间）
  if (!shouldRetryInstallation(config)) {
    const reason: OfficialMarketplaceSkipReason =
      config.officialMarketplaceAutoInstallFailReason ?? 'already_attempted'
    logForDebugging(`Official marketplace auto-install skipped: ${reason}`)
    return {
      installed: false,
      skipped: true,
      reason,
    }
  }

  try {
    // ── 检查 1：环境变量禁用标志 ──
    if (isOfficialMarketplaceAutoInstallDisabled()) {
      logForDebugging(
        'Official marketplace auto-install disabled via env var, skipping',
      )
      // 标记为策略阻止（永久跳过，不再重试）
      saveGlobalConfig(current => ({
        ...current,
        officialMarketplaceAutoInstallAttempted: true,
        officialMarketplaceAutoInstalled: false,
        officialMarketplaceAutoInstallFailReason: 'policy_blocked',
      }))
      logEvent('tengu_official_marketplace_auto_install', {
        installed: false,
        skipped: true,
        policy_blocked: true,
      })
      return { installed: false, skipped: true, reason: 'policy_blocked' }
    }

    // ── 检查 2：市场是否已安装 ──
    const knownMarketplaces = await loadKnownMarketplacesConfig()
    if (knownMarketplaces[OFFICIAL_MARKETPLACE_NAME]) {
      logForDebugging(
        `Official marketplace '${OFFICIAL_MARKETPLACE_NAME}' already installed, skipping`,
      )
      // 标记为已安装，避免每次启动都读取 known_marketplaces.json
      saveGlobalConfig(current => ({
        ...current,
        officialMarketplaceAutoInstallAttempted: true,
        officialMarketplaceAutoInstalled: true,
      }))
      return { installed: false, skipped: true, reason: 'already_installed' }
    }

    // ── 检查 3：企业策略是否允许 ──
    if (!isSourceAllowedByPolicy(OFFICIAL_MARKETPLACE_SOURCE)) {
      logForDebugging(
        'Official marketplace blocked by enterprise policy, skipping',
      )
      // 策略阻止是永久性失败，不设置退避时间
      saveGlobalConfig(current => ({
        ...current,
        officialMarketplaceAutoInstallAttempted: true,
        officialMarketplaceAutoInstalled: false,
        officialMarketplaceAutoInstallFailReason: 'policy_blocked',
      }))
      logEvent('tengu_official_marketplace_auto_install', {
        installed: false,
        skipped: true,
        policy_blocked: true,
      })
      return { installed: false, skipped: true, reason: 'policy_blocked' }
    }

    // ── 步骤 1：优先尝试 GCS 镜像下载 ──
    // 无需 git，不直接访问 GitHub，适合受限网络环境（inc-5046）。
    // 后端（anthropic#317037）将市场 ZIP 发布到与原生二进制相同的 GCS 存储桶。
    // 若 GCS 成功，注册市场（来源类型仍为 'github'，GCS 只是镜像）并跳过 git。
    const cacheDir = getMarketplacesCacheDir()
    const installLocation = join(cacheDir, OFFICIAL_MARKETPLACE_NAME)
    const gcsSha = await fetchOfficialMarketplaceFromGcs(
      installLocation,
      cacheDir,
    )
    if (gcsSha !== null) {
      // GCS 下载成功：手动注册市场到 known_marketplaces.json
      const known = await loadKnownMarketplacesConfig()
      known[OFFICIAL_MARKETPLACE_NAME] = {
        source: OFFICIAL_MARKETPLACE_SOURCE, // 来源仍为 github（GCS 是镜像）
        installLocation,
        lastUpdated: new Date().toISOString(),
      }
      await saveKnownMarketplacesConfig(known)

      // 清除所有重试状态，标记安装成功
      saveGlobalConfig(current => ({
        ...current,
        officialMarketplaceAutoInstallAttempted: true,
        officialMarketplaceAutoInstalled: true,
        officialMarketplaceAutoInstallFailReason: undefined,
        officialMarketplaceAutoInstallRetryCount: undefined,
        officialMarketplaceAutoInstallLastAttemptTime: undefined,
        officialMarketplaceAutoInstallNextRetryTime: undefined,
      }))
      logEvent('tengu_official_marketplace_auto_install', {
        installed: true,
        skipped: false,
        via_gcs: true, // 标记通过 GCS 安装（便于区分 git vs GCS 路径）
      })
      return { installed: true, skipped: false }
    }

    // GCS 失败（后端尚未发布、网络问题等）。
    // 仅当特性开关允许时才回退到 git（与 refreshMarketplace() 的开关一致）。
    if (
      !getFeatureValue_CACHED_MAY_BE_STALE(
        'tengu_plugin_official_mkt_git_fallback',
        true, // 默认值：允许 git 回退
      )
    ) {
      logForDebugging(
        'Official marketplace GCS failed; git fallback disabled by flag — skipping install',
      )
      // 与 git_unavailable 相同的退避逻辑：GCS 失败是临时的，会指数退避重试
      const retryCount =
        (config.officialMarketplaceAutoInstallRetryCount || 0) + 1
      const now = Date.now()
      const nextRetryTime = now + calculateNextRetryDelay(retryCount)
      saveGlobalConfig(current => ({
        ...current,
        officialMarketplaceAutoInstallAttempted: true,
        officialMarketplaceAutoInstalled: false,
        officialMarketplaceAutoInstallFailReason: 'gcs_unavailable',
        officialMarketplaceAutoInstallRetryCount: retryCount,
        officialMarketplaceAutoInstallLastAttemptTime: now,
        officialMarketplaceAutoInstallNextRetryTime: nextRetryTime,
      }))
      logEvent('tengu_official_marketplace_auto_install', {
        installed: false,
        skipped: true,
        gcs_unavailable: true,
        retry_count: retryCount,
      })
      return { installed: false, skipped: true, reason: 'gcs_unavailable' }
    }

    // ── 步骤 2：检查 git 可用性（GCS 失败后的回退路径）──
    const gitAvailable = await checkGitAvailable()
    if (!gitAvailable) {
      logForDebugging(
        'Git not available, skipping official marketplace auto-install',
      )
      // 计算下次重试时间（指数退避）
      const retryCount =
        (config.officialMarketplaceAutoInstallRetryCount || 0) + 1
      const now = Date.now()
      const nextRetryDelay = calculateNextRetryDelay(retryCount)
      const nextRetryTime = now + nextRetryDelay

      let configSaveFailed = false
      try {
        // 保存 git_unavailable 状态到 GlobalConfig（包含退避时间）
        saveGlobalConfig(current => ({
          ...current,
          officialMarketplaceAutoInstallAttempted: true,
          officialMarketplaceAutoInstalled: false,
          officialMarketplaceAutoInstallFailReason: 'git_unavailable',
          officialMarketplaceAutoInstallRetryCount: retryCount,
          officialMarketplaceAutoInstallLastAttemptTime: now,
          officialMarketplaceAutoInstallNextRetryTime: nextRetryTime,
        }))
      } catch (saveError) {
        // 保存失败：记录错误但不影响主流程的返回值
        configSaveFailed = true
        const configError = toError(saveError)
        logError(configError)
        logForDebugging(
          `Failed to save marketplace auto-install git_unavailable state: ${saveError}`,
          { level: 'error' },
        )
      }
      logEvent('tengu_official_marketplace_auto_install', {
        installed: false,
        skipped: true,
        git_unavailable: true,
        retry_count: retryCount,
      })
      return {
        installed: false,
        skipped: true,
        reason: 'git_unavailable',
        configSaveFailed, // 调用方可用此标志决定是否显示警告
      }
    }

    // ── 步骤 3：通过 git clone 安装市场 ──
    logForDebugging('Attempting to auto-install official marketplace')
    await addMarketplaceSource(OFFICIAL_MARKETPLACE_SOURCE)

    // 安装成功：清除所有重试状态
    logForDebugging('Successfully auto-installed official marketplace')
    const previousRetryCount =
      config.officialMarketplaceAutoInstallRetryCount || 0
    saveGlobalConfig(current => ({
      ...current,
      officialMarketplaceAutoInstallAttempted: true,
      officialMarketplaceAutoInstalled: true,
      // 成功后清除所有重试元数据
      officialMarketplaceAutoInstallFailReason: undefined,
      officialMarketplaceAutoInstallRetryCount: undefined,
      officialMarketplaceAutoInstallLastAttemptTime: undefined,
      officialMarketplaceAutoInstallNextRetryTime: undefined,
    }))
    logEvent('tengu_official_marketplace_auto_install', {
      installed: true,
      skipped: false,
      retry_count: previousRetryCount, // 上报最终成功时的重试次数
    })
    return { installed: true, skipped: false }
  } catch (error) {
    // ── 全局错误处理 ──
    const errorMessage = error instanceof Error ? error.message : String(error)

    // macOS 特殊情况处理：/usr/bin/git 是一个 xcrun shim，在未安装 Xcode CLT 时
    // `which git` 会成功（通过 checkGitAvailable()），但实际 clone 时报
    // "xcrun: error: invalid active developer path (...)"。
    // 处理方式：标记 git 不可用（毒化 memoized 可用性检查），
    // 返回 git_unavailable 但不记录退避状态（下次启动重试）。
    if (errorMessage.includes('xcrun: error:')) {
      markGitUnavailable() // 使当前会话中其他 git 调用也跳过
      logForDebugging(
        'Official marketplace auto-install: git is a non-functional macOS xcrun shim, treating as git_unavailable',
      )
      logEvent('tengu_official_marketplace_auto_install', {
        installed: false,
        skipped: true,
        git_unavailable: true,
        macos_xcrun_shim: true, // 特殊标记，便于遥测区分
      })
      return {
        installed: false,
        skipped: true,
        reason: 'git_unavailable',
        // 不设置 configSaveFailed：此情况下我们主动选择不保存退避状态
      }
    }

    // 其他安装失败：记录错误并设置指数退避重试
    logForDebugging(
      `Failed to auto-install official marketplace: ${errorMessage}`,
      { level: 'error' },
    )
    logError(toError(error))

    // 计算下次重试时间
    const retryCount =
      (config.officialMarketplaceAutoInstallRetryCount || 0) + 1
    const now = Date.now()
    const nextRetryDelay = calculateNextRetryDelay(retryCount)
    const nextRetryTime = now + nextRetryDelay

    let configSaveFailed = false
    try {
      // 保存失败状态和退避时间到 GlobalConfig
      saveGlobalConfig(current => ({
        ...current,
        officialMarketplaceAutoInstallAttempted: true,
        officialMarketplaceAutoInstalled: false,
        officialMarketplaceAutoInstallFailReason: 'unknown',
        officialMarketplaceAutoInstallRetryCount: retryCount,
        officialMarketplaceAutoInstallLastAttemptTime: now,
        officialMarketplaceAutoInstallNextRetryTime: nextRetryTime,
      }))
    } catch (saveError) {
      // 保存失败：记录错误，但仍返回安装失败的结果
      configSaveFailed = true
      const configError = toError(saveError)
      logError(configError)
      logForDebugging(
        `Failed to save marketplace auto-install failure state: ${saveError}`,
        { level: 'error' },
      )
      // 即使 config 保存失败，也正确上报安装失败结果
    }
    logEvent('tengu_official_marketplace_auto_install', {
      installed: false,
      skipped: true,
      failed: true,
      retry_count: retryCount,
    })

    return {
      installed: false,
      skipped: true,
      reason: 'unknown',
      configSaveFailed, // 调用方可用此标志决定是否显示警告
    }
  }
}
