/**
 * envLessBridgeConfig.ts — Bridge v2（无环境变量）运行时配置
 *
 * 在 Claude Code 系统流程中的位置：
 *   Bridge v2 初始化流程（remoteBridgeCore.ts / initReplBridge.ts）
 *     └─> envLessBridgeConfig.ts（本文件）——从 GrowthBook 读取 v2 bridge 运行时参数
 *
 * 背景：
 *   Bridge v2（env-less bridge，不依赖环境变量注入）需要一套独立的运行时配置，
 *   与 v1（env-based）的 tengu_bridge_min_version 配置分离，使两者可以独立调整。
 *
 * 主要配置项：
 *   - init_retry_*：会话初始化阶段（createSession、POST /bridge、recovery）的重试退避参数
 *   - http_timeout_ms：POST /sessions、/bridge、/archive 的 axios 超时时间
 *   - uuid_dedup_buffer_size：BoundedUUIDSet 环形缓冲大小（消息去重）
 *   - heartbeat_interval_ms：CCRClient Worker 心跳间隔（服务端 TTL 60s，20s 给 3× 余量）
 *   - heartbeat_jitter_fraction：心跳间隔的随机抖动幅度（分散集群负载）
 *   - token_refresh_buffer_ms：JWT 主动预刷新提前量（越大 = 刷新越频繁）
 *   - teardown_archive_timeout_ms：优雅关闭时归档请求的超时（必须 < gracefulShutdown 2s 上限）
 *   - connect_timeout_ms：transport.connect() 到 onConnect 触发的等待超时
 *   - min_version：v2 bridge 的最低 CLI 版本要求
 *   - should_show_app_upgrade_message：是否提示用户升级 claude.ai App（v2 会话列表兼容期间）
 *
 * Schema 防御设计（defense-in-depth）：
 *   每个字段都设置了合理的 min/max 边界，非法值会拒绝整个配置对象（而非部分信任），
 *   降级到 DEFAULT_ENV_LESS_BRIDGE_CONFIG，防止运维误配置导致的紧密循环或超时过长。
 */
import { z } from 'zod/v4'
import { getFeatureValue_DEPRECATED } from '../services/analytics/growthbook.js'
import { lazySchema } from '../utils/lazySchema.js'
import { lt } from '../utils/semver.js'
import { isEnvLessBridgeEnabled } from './bridgeEnabled.js'

/** v2 Bridge 运行时配置类型（从 GrowthBook 读取，含类型文档） */
export type EnvLessBridgeConfig = {
  // withRetry — init-phase backoff (createSession, POST /bridge, recovery /bridge)
  /** 初始化阶段重试最大次数 */
  init_retry_max_attempts: number
  /** 初始化阶段重试基础延迟（毫秒） */
  init_retry_base_delay_ms: number
  /** 初始化阶段重试随机抖动比例（0-1） */
  init_retry_jitter_fraction: number
  /** 初始化阶段重试最大延迟（毫秒，指数退避上限） */
  init_retry_max_delay_ms: number
  // axios timeout for POST /sessions, POST /bridge, POST /archive
  /** axios HTTP 请求超时时间（毫秒） */
  http_timeout_ms: number
  // BoundedUUIDSet ring size (echo + re-delivery dedup)
  /** 消息去重缓冲区大小（环形 UUID 集合） */
  uuid_dedup_buffer_size: number
  // CCRClient worker heartbeat cadence. Server TTL is 60s — 20s gives 3× margin.
  /** Worker 心跳间隔（毫秒，服务端 TTL 60s，20s 提供 3× 余量） */
  heartbeat_interval_ms: number
  // ±fraction of interval — per-beat jitter to spread fleet load.
  /** 心跳间隔随机抖动比例（用于分散集群负载） */
  heartbeat_jitter_fraction: number
  // Fire proactive JWT refresh this long before expires_in. Larger buffer =
  // more frequent refresh (refresh cadence ≈ expires_in - buffer).
  /** JWT 主动预刷新提前量（毫秒，越大 = 刷新越频繁，刷新周期 ≈ expires_in - buffer） */
  token_refresh_buffer_ms: number
  // Archive POST timeout in teardown(). Distinct from http_timeout_ms because
  // gracefulShutdown races runCleanupFunctions() against a 2s cap — a 10s
  // axios timeout on a slow/stalled archive burns the whole budget on a
  // request that forceExit will kill anyway.
  /** teardown 时归档请求的超时（必须 < gracefulShutdown 2s 竞争上限） */
  teardown_archive_timeout_ms: number
  // Deadline for onConnect after transport.connect(). If neither onConnect
  // nor onClose fires before this, emit tengu_bridge_repl_connect_timeout
  // — the only telemetry for the ~1% of sessions that emit `started` then
  // go silent (no error, no event, just nothing).
  /** transport.connect() 到 onConnect 触发的超时（超时上报 tengu_bridge_repl_connect_timeout） */
  connect_timeout_ms: number
  // Semver floor for the env-less bridge path. Separate from the v1
  // tengu_bridge_min_version config so a v2-specific bug can force upgrades
  // without blocking v1 (env-based) clients, and vice versa.
  /** v2 bridge 要求的最低 CLI 版本（与 v1 的 tengu_bridge_min_version 独立） */
  min_version: string
  // When true, tell users their claude.ai app may be too old to see v2
  // sessions — lets us roll the v2 bridge before the app ships the new
  // session-list query.
  /** 是否在 v2 会话启动时提示用户升级 claude.ai App（v2 会话列表上线前的过渡期） */
  should_show_app_upgrade_message: boolean
}

/** v2 Bridge 运行时配置默认值（GrowthBook 不可用时的兜底） */
export const DEFAULT_ENV_LESS_BRIDGE_CONFIG: EnvLessBridgeConfig = {
  init_retry_max_attempts: 3,
  init_retry_base_delay_ms: 500,
  init_retry_jitter_fraction: 0.25,
  init_retry_max_delay_ms: 4000,
  http_timeout_ms: 10_000,
  uuid_dedup_buffer_size: 2000,
  heartbeat_interval_ms: 20_000,
  heartbeat_jitter_fraction: 0.1,
  token_refresh_buffer_ms: 300_000,
  teardown_archive_timeout_ms: 1500,
  connect_timeout_ms: 15_000,
  min_version: '0.0.0',
  should_show_app_upgrade_message: false,
}

// Schema 边界值防御：超出范围时拒绝整个对象（降级到 DEFAULT），而非部分信任
// 与 pollConfig.ts 采用相同的 defense-in-depth 策略
const envLessBridgeConfigSchema = lazySchema(() =>
  z.object({
    init_retry_max_attempts: z.number().int().min(1).max(10).default(3),
    init_retry_base_delay_ms: z.number().int().min(100).default(500),
    init_retry_jitter_fraction: z.number().min(0).max(1).default(0.25),
    init_retry_max_delay_ms: z.number().int().min(500).default(4000),
    http_timeout_ms: z.number().int().min(2000).default(10_000),
    uuid_dedup_buffer_size: z.number().int().min(100).max(50_000).default(2000),
    // Server TTL is 60s. Floor 5s prevents thrash; cap 30s keeps ≥2× margin.
    heartbeat_interval_ms: z
      .number()
      .int()
      .min(5000)
      .max(30_000)
      .default(20_000),
    // ±fraction per beat. Cap 0.5: at max interval (30s) × 1.5 = 45s worst case,
    // still under the 60s TTL.
    heartbeat_jitter_fraction: z.number().min(0).max(0.5).default(0.1),
    // Floor 30s prevents tight-looping. Cap 30min rejects buffer-vs-delay
    // semantic inversion: ops entering expires_in-5min (the *delay until
    // refresh*) instead of 5min (the *buffer before expiry*) yields
    // delayMs = expires_in - buffer ≈ 5min instead of ≈4h. Both are positive
    // durations so .min() alone can't distinguish; .max() catches the
    // inverted value since buffer ≥ 30min is nonsensical for a multi-hour JWT.
    token_refresh_buffer_ms: z
      .number()
      .int()
      .min(30_000)
      .max(1_800_000)
      .default(300_000),
    // Cap 2000 keeps this under gracefulShutdown's 2s cleanup race — a higher
    // timeout just lies to axios since forceExit kills the socket regardless.
    teardown_archive_timeout_ms: z
      .number()
      .int()
      .min(500)
      .max(2000)
      .default(1500),
    // Observed p99 connect is ~2-3s; 15s is ~5× headroom. Floor 5s bounds
    // false-positive rate under transient slowness; cap 60s bounds how long
    // a truly-stalled session stays dark.
    connect_timeout_ms: z.number().int().min(5_000).max(60_000).default(15_000),
    min_version: z
      .string()
      .refine(v => {
        try {
          lt(v, '0.0.0')
          return true
        } catch {
          return false
        }
      })
      .default('0.0.0'),
    should_show_app_upgrade_message: z.boolean().default(false),
  }),
)

/**
 * 从 GrowthBook 获取 v2 Bridge 运行时配置。
 *
 * 每次 initEnvLessBridgeCore 调用时读取一次——配置在 Bridge 会话生命周期内固定不变。
 *
 * 使用阻塞 getter（而非 _CACHED_MAY_BE_STALE）的原因：
 * /remote-control 在 GrowthBook 初始化完成后才执行，initializeGrowthBook() 即时 resolve，
 * 因此无启动性能损失，且能获取内存中最新的 remoteEval 值（而非磁盘缓存的旧值）。
 * _DEPRECATED 后缀仅警示不要在启动路径使用，此处不受影响。
 *
 * Fetch the env-less bridge timing config from GrowthBook. Read once per
 * initEnvLessBridgeCore call — config is fixed for the lifetime of a bridge
 * session.
 */
export async function getEnvLessBridgeConfig(): Promise<EnvLessBridgeConfig> {
  const raw = await getFeatureValue_DEPRECATED<unknown>(
    'tengu_bridge_repl_v2_config',
    DEFAULT_ENV_LESS_BRIDGE_CONFIG,
  )
  const parsed = envLessBridgeConfigSchema().safeParse(raw)
  return parsed.success ? parsed.data : DEFAULT_ENV_LESS_BRIDGE_CONFIG // 解析失败时降级到默认值
}

/**
 * 检查当前 CLI 版本是否满足 v2 Bridge 的最低版本要求。
 *
 * 对应 v1 的 checkBridgeMinVersion()，但读取 tengu_bridge_repl_v2_config 中的 min_version，
 * 使两个实现可以独立设置版本下限（v2 特定 bug 可强制升级而不影响 v1 客户端，反之亦然）。
 *
 * Returns an error message if the current CLI version is below the minimum
 * required for the env-less (v2) bridge path, or null if the version is fine.
 */
export async function checkEnvLessBridgeMinVersion(): Promise<string | null> {
  const cfg = await getEnvLessBridgeConfig()
  if (cfg.min_version && lt(MACRO.VERSION, cfg.min_version)) {
    return `Your version of Claude Code (${MACRO.VERSION}) is too old for Remote Control.\nVersion ${cfg.min_version} or higher is required. Run \`claude update\` to update.`
  }
  return null
}

/**
 * 判断是否应在 v2 Remote Control 会话启动时显示 App 升级提示。
 *
 * 仅在 v2 bridge 激活（isEnvLessBridgeEnabled）且配置中 should_show_app_upgrade_message 为 true 时返回 true。
 * 用于 v2 bridge 上线但 claude.ai App 还未支持 v2 会话列表查询的过渡期。
 *
 * Whether to nudge users toward upgrading their claude.ai app when a
 * Remote Control session starts.
 */
export async function shouldShowAppUpgradeMessage(): Promise<boolean> {
  if (!isEnvLessBridgeEnabled()) return false
  const cfg = await getEnvLessBridgeConfig()
  return cfg.should_show_app_upgrade_message
}
