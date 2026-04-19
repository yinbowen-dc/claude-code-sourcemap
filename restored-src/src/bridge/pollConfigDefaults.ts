/**
 * pollConfigDefaults.ts — Bridge 轮询间隔默认值（静态常量，无 GrowthBook 依赖）
 *
 * 在 Claude Code 系统流程中的位置：
 *   Bridge 轮询配置系统
 *     ├─> pollConfigDefaults.ts（本文件）——定义轮询间隔的静态默认值和 PollIntervalConfig 类型
 *     └─> pollConfig.ts ——从 GrowthBook 动态读取配置，解析失败时降级到本文件的 DEFAULT_POLL_CONFIG
 *
 * 背景：
 *   本文件从 pollConfig.ts 中提取，原因是部分调用方（如通过 Agent SDK 运行的 daemon）
 *   不需要 GrowthBook 动态调优，不应引入以下完整依赖链：
 *     growthbook.ts → config.ts → file.ts → sessionStorage.ts → commands.ts
 *   独立文件使这些调用方可以只导入默认值，而不捆绑 GrowthBook 相关模块。
 *
 * 轮询状态与间隔：
 *   - not_at_capacity（等待工作）：2s 高频轮询，降低初次接收工作的响应延迟
 *   - at_capacity（已有 transport 连接）：10min 低频轮询，作为存活信号和永久断线保底
 *   - partial_capacity（多会话部分忙碌）：与 not_at_capacity 相同频率（2s）
 *
 * Bridge poll interval defaults. Extracted from pollConfig.ts so callers
 * that don't need live GrowthBook tuning (daemon via Agent SDK) can avoid
 * the growthbook.ts → config.ts → file.ts → sessionStorage.ts → commands.ts
 * transitive dependency chain.
 */

/**
 * 等待工作时的轮询间隔（单位：毫秒）。
 *
 * 适用场景：尚无传输连接，或当前会话数低于 maxSessions 阈值时。
 * 决定用户可见的"connecting…"延迟和服务端重新派发工作后的恢复速度。
 * 设置为 2s 以在响应性（低延迟接取任务）与轮询开销之间取得平衡。
 *
 * Poll interval when actively seeking work (no transport / below maxSessions).
 * Governs user-visible "connecting…" latency on initial work pickup and
 * recovery speed after the server re-dispatches a work item.
 */
const POLL_INTERVAL_MS_NOT_AT_CAPACITY = 2000

/**
 * transport 已连接时的轮询间隔（单位：毫秒）。
 *
 * 独立于心跳运行——两者均启用时，心跳循环定期中断并以此间隔执行一次轮询。
 * 设为 0 可完全禁用 at-capacity 轮询（仅依赖心跳保活）。
 *
 * 服务端约束：
 *   - BRIDGE_LAST_POLL_TTL = 4h（Redis 键过期 → 环境自动归档）
 *   - max_poll_stale_seconds = 24h（会话创建健康检查门限，当前已禁用）
 *
 * 10 分钟对 Redis TTL（4h）提供 24× 余量，同时仍能在一个轮询周期内
 * 接收服务端发起的 token 轮换重派发。
 * transport 本身在 WS 瞬时故障时会自动重连 10 分钟，
 * 因此轮询不是恢复路径——仅作存活信号和永久断线的兜底机制。
 *
 * Poll interval when the transport is connected. Runs independently of
 * heartbeat — when both are enabled, the heartbeat loop breaks out to poll
 * at this interval. Set to 0 to disable at-capacity polling entirely.
 */
const POLL_INTERVAL_MS_AT_CAPACITY = 600_000

/**
 * 多会话 bridge（bridgeMain.ts）的轮询间隔默认值。
 *
 * 默认值与单会话值一致，确保现有不含这些字段的 GrowthBook 配置
 * 保持当前行为不变（兼容性设计）。
 * 运维可通过 tengu_bridge_poll_interval_config GrowthBook flag 独立调整。
 *
 * Multisession bridge (bridgeMain.ts) poll intervals. Defaults match the
 * single-session values so existing GrowthBook configs without these fields
 * preserve current behavior.
 */
const MULTISESSION_POLL_INTERVAL_MS_NOT_AT_CAPACITY =
  POLL_INTERVAL_MS_NOT_AT_CAPACITY
const MULTISESSION_POLL_INTERVAL_MS_PARTIAL_CAPACITY =
  POLL_INTERVAL_MS_NOT_AT_CAPACITY
const MULTISESSION_POLL_INTERVAL_MS_AT_CAPACITY = POLL_INTERVAL_MS_AT_CAPACITY

/**
 * Bridge 轮询间隔配置类型定义。
 *
 * 由 pollConfig.ts 从 GrowthBook 读取后填充，
 * 解析失败时降级到 DEFAULT_POLL_CONFIG。
 *
 * 字段说明：
 *   - poll_interval_ms_not_at_capacity：等待工作时的单会话轮询间隔
 *   - poll_interval_ms_at_capacity：满载时的单会话轮询间隔（0 = 禁用）
 *   - non_exclusive_heartbeat_interval_ms：at-capacity 模式心跳间隔（0 = 禁用）
 *   - multisession_*：多会话 bridge 的对应间隔
 *   - reclaim_older_than_ms：reclaim 未确认工作项的时间阈值
 *   - session_keepalive_interval_v2_ms：v2 bridge 保活帧发送间隔（0 = 禁用）
 */
export type PollIntervalConfig = {
  poll_interval_ms_not_at_capacity: number
  poll_interval_ms_at_capacity: number
  non_exclusive_heartbeat_interval_ms: number
  multisession_poll_interval_ms_not_at_capacity: number
  multisession_poll_interval_ms_partial_capacity: number
  multisession_poll_interval_ms_at_capacity: number
  reclaim_older_than_ms: number
  session_keepalive_interval_v2_ms: number
}

/**
 * Bridge 轮询间隔默认配置（GrowthBook 不可用时的兜底）。
 *
 * pollConfig.ts 解析 GrowthBook 配置失败时降级到此对象。
 * 各字段的详细说明见类型定义 PollIntervalConfig。
 */
export const DEFAULT_POLL_CONFIG: PollIntervalConfig = {
  poll_interval_ms_not_at_capacity: POLL_INTERVAL_MS_NOT_AT_CAPACITY,
  poll_interval_ms_at_capacity: POLL_INTERVAL_MS_AT_CAPACITY,
  // 0 = 禁用。
  // 启用时（> 0），at-capacity 循环以此间隔为每个工作项发送心跳。
  // 独立于 poll_interval_ms_at_capacity——两者可同时运行（心跳定期让出，执行一次轮询）。
  // 60s 对服务端心跳 TTL（300s）提供 5× 余量。
  // 命名为 non_exclusive 以区分旧的 heartbeat_interval_ms 字段
  // （pre-#22145 客户端中心跳与轮询互斥，心跳会抑制轮询）。
  // 旧客户端忽略此键；运维在推进过程中可同时设置两个字段。
  non_exclusive_heartbeat_interval_ms: 0,
  multisession_poll_interval_ms_not_at_capacity:
    MULTISESSION_POLL_INTERVAL_MS_NOT_AT_CAPACITY,
  multisession_poll_interval_ms_partial_capacity:
    MULTISESSION_POLL_INTERVAL_MS_PARTIAL_CAPACITY,
  multisession_poll_interval_ms_at_capacity:
    MULTISESSION_POLL_INTERVAL_MS_AT_CAPACITY,
  // 轮询查询参数：reclaim 比此时间更早的未确认工作项。
  // 与服务端的 DEFAULT_RECLAIM_OLDER_THAN_MS（work_service.py:24）一致。
  // 在 JWT 过期后恢复挂起工作时有效——之前的 ack 因 session_ingress_token 已过期而失败。
  reclaim_older_than_ms: 5000,
  // 0 = 禁用。
  // 启用时（> 0），以此间隔向 session-ingress 推送静默 {type:'keep_alive'} 帧，
  // 防止上游代理 GC 空闲的远程控制会话。默认 2 分钟。
  // _v2 后缀：bridge-only 门控（pre-v2 客户端读取旧键，新客户端忽略旧键）。
  session_keepalive_interval_v2_ms: 120_000,
}
