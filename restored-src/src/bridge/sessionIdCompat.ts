/**
 * sessionIdCompat.ts — CCR v2 兼容层会话 ID 标签转换
 *
 * 在 Claude Code 系统流程中的位置：
 *   Bridge 会话管理层（bridgeMain.ts / replBridgeTransport.ts）
 *     └─> sessionIdCompat.ts（本文件）——在 cse_* 与 session_* 前缀间互转
 *
 * 背景：
 *   CCR v2 基础设施层使用 `cse_*` 前缀的会话 ID（infra tag），
 *   而 v1 兼容 API（/v1/sessions、/v1/sessions/{id}/archive 等）只接受 `session_*` 前缀（compat tag）。
 *   两者底层 UUID 相同，仅前缀不同（"同一实体的不同服装"）。
 *
 *   bridgeMain 维护单一 sessionId 变量，用于 worker 注册和会话管理两类调用：
 *   - worker 端点（/v1/code/sessions/{id}/worker/*）：需要 cse_* 前缀
 *   - compat 端点（/v1/sessions/{id}、archive 等）：需要 session_* 前缀
 *
 * 设计说明（为何独立成文件）：
 *   sessionHandle.ts 和 replBridgeTransport.ts（bridge.mjs 入口）可以只 import workSecret.ts
 *   而不捆绑这两个转换函数，避免不必要的依赖链。
 *
 * GrowthBook 门控注入（setCseShimGate）：
 *   使用依赖注入而非静态 import，避免引入 bridgeEnabled.ts → growthbook.ts → config.ts 的
 *   完整依赖链（这些模块被禁止出现在 sdk.mjs bundle 中）。
 *
 * Session ID tag translation helpers for the CCR v2 compat layer.
 *
 * Lives in its own file (rather than workSecret.ts) so that sessionHandle.ts
 * and replBridgeTransport.ts (bridge.mjs entry points) can import from
 * workSecret.ts without pulling in these retag functions.
 *
 * The isCseShimEnabled kill switch is injected via setCseShimGate() to avoid
 * a static import of bridgeEnabled.ts → growthbook.ts → config.ts — all
 * banned from the sdk.mjs bundle (scripts/build-agent-sdk.sh). Callers that
 * already import bridgeEnabled.ts register the gate; the SDK path never does,
 * so the shim defaults to active (matching isCseShimEnabled()'s own default).
 */

/** GrowthBook 门控函数（通过 setCseShimGate 注入，默认 undefined） */
let _isCseShimEnabled: (() => boolean) | undefined

/**
 * 注册 cse_shim 的 GrowthBook 门控函数。
 *
 * 由已导入 bridgeEnabled.ts 的 Bridge 初始化代码调用（如 bridgeMain.ts）。
 * SDK 路径不调用此函数，因此 shim 默认激活（与 isCseShimEnabled() 默认值一致）。
 *
 * Register the GrowthBook gate for the cse_ shim. Called from bridge
 * init code that already imports bridgeEnabled.ts.
 */
export function setCseShimGate(gate: () => boolean): void {
  _isCseShimEnabled = gate
}

/**
 * 将 `cse_*` 会话 ID 转换为 `session_*`，供 v1 兼容 API 使用。
 *
 * worker 端点（/v1/code/sessions/{id}/worker/*）使用 cse_* 前缀，
 * compat 端点（/v1/sessions/{id}、/v1/sessions/{id}/archive 等）
 * 需要 session_* 前缀（compat/convert.go:27 校验 TagSession）。
 * 底层 UUID 相同，只换前缀（"同一实体，不同服装"）。
 *
 * 非 cse_* 前缀的 ID 直接返回（无操作）。
 * GrowthBook 门控禁用时也直接返回。
 *
 * Re-tag a `cse_*` session ID to `session_*` for use with the v1 compat API.
 */
export function toCompatSessionId(id: string): string {
  if (!id.startsWith('cse_')) return id // 非 cse_* 前缀，无需转换
  if (_isCseShimEnabled && !_isCseShimEnabled()) return id // GrowthBook 门控禁用，跳过转换
  return 'session_' + id.slice('cse_'.length) // 替换前缀：cse_ → session_
}

/**
 * 将 `session_*` 会话 ID 转换为 `cse_*`，供基础设施层调用使用。
 *
 * toCompatSessionId 的逆操作。
 * POST /v1/environments/{id}/bridge/reconnect 位于 compat 层之下：
 * 当 ccr_v2_compat_enabled 服务端开启后，该接口通过 cse_* 标签查找会话。
 * 但 createBridgeSession 返回的是 session_* 前缀（compat/convert.go:41），
 * bridge-pointer 也存储 session_* 格式，导致永久重连时传错前缀而报"Session not found"。
 *
 * 非 session_* 前缀的 ID 直接返回（无操作）。
 *
 * Re-tag a `session_*` session ID to `cse_*` for infrastructure-layer calls.
 *
 * Inverse of toCompatSessionId. POST /v1/environments/{id}/bridge/reconnect
 * lives below the compat layer: once ccr_v2_compat_enabled is on server-side,
 * it looks sessions up by their infra tag (`cse_*`). createBridgeSession still
 * returns `session_*` (compat/convert.go:41) and that's what bridge-pointer
 * stores — so perpetual reconnect passes the wrong costume and gets "Session
 * not found" back. Same UUID, wrong tag. No-op for IDs that aren't `session_*`.
 */
export function toInfraSessionId(id: string): string {
  if (!id.startsWith('session_')) return id // 非 session_* 前缀，无需转换
  return 'cse_' + id.slice('session_'.length) // 替换前缀：session_ → cse_
}
