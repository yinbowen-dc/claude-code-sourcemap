/**
 * managedEnv.ts — 受管理环境变量应用模块
 *
 * 【系统流程定位】
 * 本模块处于 Claude Code 启动流程的早期配置阶段，在信任对话框（Trust Dialog）
 * 前后分两阶段将来自不同设置来源的环境变量合并到 process.env。
 *
 * 【两阶段设计】
 * 1. applySafeConfigEnvironmentVariables()（信任对话框之前调用）：
 *    - 先应用全局配置（~/.claude.json）中的 env；
 *    - 再应用受信任来源（userSettings / flagSettings / policySettings）的所有 env；
 *    - 最后仅应用合并后所有设置中属于 SAFE_ENV_VARS 白名单的 env。
 *
 * 2. applyConfigEnvironmentVariables()（信任建立后调用）：
 *    - 应用所有来源的全部 env（包括可能危险的 LD_PRELOAD、PATH 等），
 *    - 并刷新 CA 证书、mTLS、代理缓存。
 *
 * 【安全过滤链（filterSettingsEnv）】
 * 每个来源的 env 对象在应用前都经过三层过滤：
 *   SSH 隧道变量剥离 → 宿主管理的 Provider 变量剥离 → CCD 启动环境变量剥离
 */

import { isRemoteManagedSettingsEligible } from '../services/remoteManagedSettings/syncCache.js'
import { clearCACertsCache } from './caCerts.js'
import { getGlobalConfig } from './config.js'
import { isEnvTruthy } from './envUtils.js'
import {
  isProviderManagedEnvVar,
  SAFE_ENV_VARS,
} from './managedEnvConstants.js'
import { clearMTLSCache } from './mtls.js'
import { clearProxyCache, configureGlobalAgents } from './proxy.js'
import { isSettingSourceEnabled } from './settings/constants.js'
import {
  getSettings_DEPRECATED,
  getSettingsForSource,
} from './settings/settings.js'

/**
 * 从 settings 来源的 env 对象中剥离 SSH 隧道相关变量。
 *
 * 背景：
 * `claude ssh` 远程模式下，ANTHROPIC_UNIX_SOCKET 将认证路由到通过 SSH -R 转发的
 * 本地代理 Socket，启动器会预设一批占位认证变量。
 * 如果远端 ~/.claude/settings.env 覆盖了这些变量，会破坏 SSH 隧道认证。
 * 因此只要检测到 ANTHROPIC_UNIX_SOCKET 已存在于 process.env，
 * 就从 settings 来源的 env 中剥离所有 SSH 隧道相关认证变量。
 *
 * @param env 待过滤的 env 对象（来自 settings 配置）
 * @returns 剥离 SSH 隧道变量后的 env 对象
 */
function withoutSSHTunnelVars(
  env: Record<string, string> | undefined,
): Record<string, string> {
  // 若 env 不存在或当前进程没有 SSH 隧道 socket，直接返回原 env
  if (!env || !process.env.ANTHROPIC_UNIX_SOCKET) return env || {}
  // 解构剥离所有 SSH 隧道认证相关变量，返回其余变量
  const {
    ANTHROPIC_UNIX_SOCKET: _1,
    ANTHROPIC_BASE_URL: _2,
    ANTHROPIC_API_KEY: _3,
    ANTHROPIC_AUTH_TOKEN: _4,
    CLAUDE_CODE_OAUTH_TOKEN: _5,
    ...rest
  } = env
  return rest
}

/**
 * 从 settings 来源的 env 对象中剥离受宿主管理的 Provider 路由变量。
 *
 * 背景：
 * 当宿主（如企业部署的 Host）在进程启动 env 中设置了
 * CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST=true，
 * 则用户 ~/.claude/settings.json 中的 env 不允许覆盖 Provider 选择、
 * 端点 URL、认证 key 等路由变量，防止将请求重定向到其他 Provider。
 *
 * @param env 待过滤的 env 对象
 * @returns 剥离受宿主管理变量后的 env 对象
 */
function withoutHostManagedProviderVars(
  env: Record<string, string> | undefined,
): Record<string, string> {
  if (!env) return {}
  // 若宿主未声明管理 Provider，直接返回原 env 不做剥离
  if (!isEnvTruthy(process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST)) {
    return env
  }
  // 逐键过滤：只保留不属于受管理 Provider 变量的 key-value 对
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (!isProviderManagedEnvVar(key)) {
      out[key] = value
    }
  }
  return out
}

/**
 * CCD（Claude Code Desktop）启动 env 的快照 Key 集合。
 *
 * 在 Claude Desktop 作为宿主启动子进程时，Desktop 会在启动 env 中设置
 * 若干操作变量（如 OTEL_LOGS_EXPORTER=console 用于 stdio JSON-RPC 传输）。
 * settings.env 不能覆盖这些变量，否则会破坏 stdio JSON-RPC 通信。
 *
 * 此 Set 在首次调用 applySafeConfigEnvironmentVariables() 时懒惰初始化，
 * 捕获 settings.env 应用之前 process.env 中的所有 key。
 * 会话期间用户/项目 settings.json 新增的 key 不在此 Set 中，
 * 因此 mid-session 的 settings.json 变更仍然可以生效。
 *
 * undefined = 尚未初始化；null = 非 CCD 模式（不需要快照）
 */
let ccdSpawnEnvKeys: Set<string> | null | undefined

/**
 * 从 settings 来源的 env 对象中剥离 CCD 启动 env 中已有的 key。
 *
 * @param env 待过滤的 env 对象
 * @returns 剥离 CCD 启动 key 后的 env 对象
 */
function withoutCcdSpawnEnvKeys(
  env: Record<string, string> | undefined,
): Record<string, string> {
  // 若 env 不存在或非 CCD 模式（快照为 null），直接返回
  if (!env || !ccdSpawnEnvKeys) return env || {}
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    // 只保留不在 CCD 启动快照中的 key（即用户/settings 新增的 key）
    if (!ccdSpawnEnvKeys.has(key)) out[key] = value
  }
  return out
}

/**
 * 组合所有过滤层：对每个 settings 来源的 env 对象依次应用三层过滤。
 *
 * 过滤顺序（内到外）：
 * 1. withoutSSHTunnelVars：剥离 SSH 隧道认证变量
 * 2. withoutHostManagedProviderVars：剥离宿主管理的 Provider 路由变量
 * 3. withoutCcdSpawnEnvKeys：剥离 CCD 启动环境中已有的 key
 *
 * @param env 原始 settings env 对象
 * @returns 经过三层过滤后可安全应用的 env 对象
 */
function filterSettingsEnv(
  env: Record<string, string> | undefined,
): Record<string, string> {
  return withoutCcdSpawnEnvKeys(
    withoutHostManagedProviderVars(withoutSSHTunnelVars(env)),
  )
}

/**
 * 在信任对话框之前，可以安全应用 env 的受信任来源列表。
 *
 * - userSettings（~/.claude/settings.json）：用户自己控制，与项目无关；
 * - flagSettings（--settings CLI flag 或 SDK 内联 settings）：用户显式传入；
 * - policySettings（企业 API 或本地 managed-settings.json）：IT/管理员控制，优先级最高。
 *
 * 注意：projectSettings / localSettings 被排除，因为它们位于项目目录中，
 * 恶意代码可能通过提交 settings.json 将 ANTHROPIC_BASE_URL 重定向到攻击者服务器。
 */
const TRUSTED_SETTING_SOURCES = [
  'userSettings',
  'flagSettings',
  'policySettings',
] as const

/**
 * 在信任对话框之前，从受信任的设置来源应用环境变量到 process.env。
 *
 * 【两阶段逻辑】
 * 阶段一（受信任来源，应用所有 env）：
 * 1. 应用全局配置 ~/.claude.json 的 env（用户控制）；
 * 2. 按顺序应用 userSettings、flagSettings 的 env；
 * 3. 计算远程托管设置的资格（依赖前两步的 env，如 CLAUDE_CODE_USE_BEDROCK）；
 * 4. 应用 policySettings（最高优先级）的 env。
 *
 * 阶段二（所有来源，仅应用安全变量白名单）：
 * 5. 从完整合并设置（含 projectSettings）中过滤出 SAFE_ENV_VARS 白名单变量并应用。
 */
export function applySafeConfigEnvironmentVariables(): void {
  // 懒惰初始化 CCD 启动 env 快照（只在第一次调用时捕获）
  if (ccdSpawnEnvKeys === undefined) {
    ccdSpawnEnvKeys =
      // 仅在 claude-desktop entrypoint 模式下需要快照
      process.env.CLAUDE_CODE_ENTRYPOINT === 'claude-desktop'
        ? new Set(Object.keys(process.env))
        : null
  }

  // 应用全局配置（~/.claude.json）的 env。
  // 在 CCD 模式下，filterSettingsEnv 会剥除 Desktop 启动 env 中已有的 key，
  // 防止 Desktop 的操作变量（OTEL 等）被覆盖。
  Object.assign(process.env, filterSettingsEnv(getGlobalConfig().env))

  // 应用受信任来源（userSettings / flagSettings）的所有 env。
  // 通过 isSettingSourceEnabled 判断来源是否被 SDK 的 settingSources 选项启用，
  // 防止 SDK 隔离模式（settingSources: []）下 userSettings 的 env 泄漏（gh#217）。
  for (const source of TRUSTED_SETTING_SOURCES) {
    if (source === 'policySettings') continue // policySettings 单独处理（见下方）
    if (!isSettingSourceEnabled(source)) continue
    Object.assign(
      process.env,
      filterSettingsEnv(getSettingsForSource(source)?.env),
    )
  }

  // 在 userSettings 和 flagSettings 的 env 已应用后，计算远程托管设置的资格。
  // 此时 CLAUDE_CODE_USE_BEDROCK、ANTHROPIC_BASE_URL 等已生效，
  // 这是 isRemoteManagedSettingsEligible 所需的最小 env 集合。
  // policySettings 的 getSettingsForSource 会查询远程缓存，该缓存受此资格保护。
  isRemoteManagedSettingsEligible()

  // 应用 policySettings（最高优先级，IT/管理员控制，不能被用户覆盖）
  Object.assign(
    process.env,
    filterSettingsEnv(getSettingsForSource('policySettings')?.env),
  )

  // 从完整合并设置（含 projectSettings / localSettings）中仅应用 SAFE_ENV_VARS 白名单变量。
  // 对于白名单变量中也存在于受信任来源的变量，项目来源的合并值可能会覆盖受信任来源的值——
  // 这是可接受的，因为白名单变量已被认定无安全风险。
  // policySettings 的值（合并优先级最高）在两个循环中均有保证——
  // 唯一例外是 CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST 已设置时，
  // filterSettingsEnv 会从所有来源剥除 Provider 路由变量。
  const settingsEnv = filterSettingsEnv(getSettings_DEPRECATED()?.env)
  for (const [key, value] of Object.entries(settingsEnv)) {
    if (SAFE_ENV_VARS.has(key.toUpperCase())) {
      process.env[key] = value
    }
  }
}

/**
 * 信任建立后，应用来自设置的所有环境变量到 process.env。
 *
 * 与 applySafeConfigEnvironmentVariables 的区别：
 * - 本函数会应用所有 env 变量，包括潜在危险的 LD_PRELOAD、PATH 等；
 * - 只有在用户对项目目录表示信任之后才应调用本函数；
 * - 应用后会清除并重建 CA 证书、mTLS、代理缓存，使新的代理配置生效。
 *
 * 注意：仍然会经过 filterSettingsEnv 过滤（SSH 隧道变量 / 宿主 Provider 变量 / CCD 快照）。
 */
export function applyConfigEnvironmentVariables(): void {
  // 应用全局配置（~/.claude.json）的所有 env
  Object.assign(process.env, filterSettingsEnv(getGlobalConfig().env))

  // 应用完整合并设置（含 projectSettings / localSettings）的所有 env
  Object.assign(process.env, filterSettingsEnv(getSettings_DEPRECATED()?.env))

  // 清除各种网络相关缓存，确保新的代理/证书配置生效
  clearCACertsCache()  // 清除 CA 证书缓存
  clearMTLSCache()     // 清除 mTLS 缓存
  clearProxyCache()    // 清除代理配置缓存

  // 使用最新的 env 重新配置全局 HTTP(S) 代理和 mTLS Agent
  configureGlobalAgents()
}
