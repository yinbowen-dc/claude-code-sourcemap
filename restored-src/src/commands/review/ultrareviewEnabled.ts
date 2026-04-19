/**
 * ultrareview 功能开关检查（commands/review/ultrareviewEnabled.ts）
 *
 * 本文件提供一个轻量级的运行时开关函数，通过读取 GrowthBook feature flag
 * 来决定 /ultrareview 命令是否对当前用户可见。
 *
 * 在 Claude Code 命令系统中的位置：
 *   commands 注册时调用每个命令的 isEnabled() → 此函数 → GrowthBook 缓存
 *   → 返回布尔值决定命令是否出现在 /help 列表及命令补全中。
 *
 * 设计原则：只读缓存值（MAY_BE_STALE），不发起网络请求，保证命令列表渲染无阻塞。
 */

import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'

/**
 * Runtime gate for /ultrareview. GB config's `enabled` field controls
 * visibility — isEnabled() on the command filters it from getCommands()
 * when false, so ungated users don't see the command at all.
 *
 * 检查 /ultrareview 命令是否对当前用户开放。
 * 从 GrowthBook 的本地缓存中读取 `tengu_review_bughunter_config` 配置对象，
 * 仅当其 `enabled` 字段严格等于 true 时才返回 true。
 *
 * 注意：使用缓存值（CACHED_MAY_BE_STALE）意味着结果可能滞后于远端配置变更，
 * 重启应用后才会获取最新的 flag 值。
 */
export function isUltrareviewEnabled(): boolean {
  // 从 GrowthBook 本地缓存读取 bughunter 配置，默认 null（未配置时命令隐藏）
  const cfg = getFeatureValue_CACHED_MAY_BE_STALE<Record<
    string,
    unknown
  > | null>('tengu_review_bughunter_config', null)
  // 严格检查 enabled === true，避免将 truthy 字符串或数字误判为已开启
  return cfg?.enabled === true
}
