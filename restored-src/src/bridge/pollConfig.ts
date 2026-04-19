/**
 * pollConfig.ts — Bridge 轮询间隔配置（从 GrowthBook 动态读取）
 *
 * 在 Claude Code 系统流程中的位置：
 *   Bridge 轮询循环（bridgeMain.ts / replBridge.ts）
 *     └─> pollConfig.ts（本文件）——从 GrowthBook 读取并校验 Bridge 轮询间隔参数
 *
 * 背景：
 *   Bridge 的 /poll 轮询频率需要在多种工作负载场景下平衡：
 *   - not_at_capacity（等待工作）：高频轮询以降低响应延迟
 *   - at_capacity（正在处理工作）：低频或禁用轮询，避免向 DB 发送无用请求
 *   - partial_capacity（多会话部分忙碌）：中频轮询
 *   GrowthBook 允许运维在不发布新版本的情况下调整整个集群的轮询频率。
 *
 * Schema 防御设计：
 *   - .min(100)：防止误配置（如单位误填秒而非毫秒）导致 10ms 级轮询
 *   - 0-or-≥100 refinement：0 表示禁用（仅心跳），1-99 为非法值（防止 "10秒" 被误理解为 10ms）
 *   - 对象级 refine：at-capacity 状态下至少保证一种存活机制（心跳 OR 轮询），
 *     防止两者均禁用时紧密循环
 *   - 解析失败时降级到 DEFAULT_POLL_CONFIG（全对象拒绝而非部分信任）
 */
import { z } from 'zod/v4'
import { getFeatureValue_CACHED_WITH_REFRESH } from '../services/analytics/growthbook.js'
import { lazySchema } from '../utils/lazySchema.js'
import {
  DEFAULT_POLL_CONFIG,
  type PollIntervalConfig,
} from './pollConfigDefaults.js'

// .min(100) 数值下限：防止运维误配置（如将秒误填为毫秒）触发 10ms 级轮询
// 与直接 clamp 不同：Zod 会因字段违规拒绝整个对象，降级到 DEFAULT_POLL_CONFIG
//
// at_capacity 间隔使用 0-or-≥100 refinement：
//   0 = 禁用（仅心跳模式），≥100 = 正常轮询下限，1-99 = 非法值
//   防止运维以为单位是秒而填入 10（会导致 10ms 每次轮询 VerifyEnvironmentSecretAuth DB）
//
// 对象级 refine 要求 at-capacity 时至少一种存活机制（心跳 OR 轮询）：
//   防止 hb=0, atCapMs=0 的漂移配置（运维禁用心跳却忘记恢复 at_capacity 轮询），
//   使轮询循环以 HTTP 往返速度无休止运行
const zeroOrAtLeast100 = {
  message: 'must be 0 (disabled) or ≥100ms',
}
const pollIntervalConfigSchema = lazySchema(() =>
  z
    .object({
      poll_interval_ms_not_at_capacity: z.number().int().min(100),
      // 0 = no at-capacity polling. Independent of heartbeat — both can be
      // enabled (heartbeat runs, periodically breaks out to poll).
      poll_interval_ms_at_capacity: z
        .number()
        .int()
        .refine(v => v === 0 || v >= 100, zeroOrAtLeast100),
      // 0 = disabled; positive value = heartbeat at this interval while at
      // capacity. Runs alongside at-capacity polling, not instead of it.
      // Named non_exclusive to distinguish from the old heartbeat_interval_ms
      // (either-or semantics in pre-#22145 clients). .default(0) so existing
      // GrowthBook configs without this field parse successfully.
      non_exclusive_heartbeat_interval_ms: z.number().int().min(0).default(0),
      // Multisession (bridgeMain.ts) intervals. Defaults match the
      // single-session values so existing configs without these fields
      // preserve current behavior.
      multisession_poll_interval_ms_not_at_capacity: z
        .number()
        .int()
        .min(100)
        .default(
          DEFAULT_POLL_CONFIG.multisession_poll_interval_ms_not_at_capacity,
        ),
      multisession_poll_interval_ms_partial_capacity: z
        .number()
        .int()
        .min(100)
        .default(
          DEFAULT_POLL_CONFIG.multisession_poll_interval_ms_partial_capacity,
        ),
      multisession_poll_interval_ms_at_capacity: z
        .number()
        .int()
        .refine(v => v === 0 || v >= 100, zeroOrAtLeast100)
        .default(DEFAULT_POLL_CONFIG.multisession_poll_interval_ms_at_capacity),
      // .min(1) matches the server's ge=1 constraint (work_v1.py:230).
      reclaim_older_than_ms: z.number().int().min(1).default(5000),
      session_keepalive_interval_v2_ms: z
        .number()
        .int()
        .min(0)
        .default(120_000),
    })
    .refine(
      cfg =>
        cfg.non_exclusive_heartbeat_interval_ms > 0 ||
        cfg.poll_interval_ms_at_capacity > 0,
      {
        message:
          'at-capacity liveness requires non_exclusive_heartbeat_interval_ms > 0 or poll_interval_ms_at_capacity > 0',
      },
    )
    .refine(
      cfg =>
        cfg.non_exclusive_heartbeat_interval_ms > 0 ||
        cfg.multisession_poll_interval_ms_at_capacity > 0,
      {
        message:
          'at-capacity liveness requires non_exclusive_heartbeat_interval_ms > 0 or multisession_poll_interval_ms_at_capacity > 0',
      },
    ),
)

/**
 * 从 GrowthBook 获取 Bridge 轮询间隔配置（带 5 分钟缓存刷新）。
 *
 * 对获取的 JSON 进行 Zod Schema 校验：
 *   - 配置不存在、格式错误或任何字段违规 → 降级到 DEFAULT_POLL_CONFIG
 *
 * bridgeMain.ts（独立模式）和 replBridge.ts（REPL 模式）共享此函数，
 * 使运维可通过一次 GrowthBook 配置推送调整整个集群的轮询频率。
 *
 * Fetch the bridge poll interval config from GrowthBook with a 5-minute
 * refresh window.
 */
export function getPollIntervalConfig(): PollIntervalConfig {
  const raw = getFeatureValue_CACHED_WITH_REFRESH<unknown>(
    'tengu_bridge_poll_interval_config',
    DEFAULT_POLL_CONFIG,
    5 * 60 * 1000, // 5 分钟缓存刷新窗口
  )
  const parsed = pollIntervalConfigSchema().safeParse(raw)
  return parsed.success ? parsed.data : DEFAULT_POLL_CONFIG // 解析失败时降级到默认值
}
