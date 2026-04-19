/**
 * AutoDream 功能开关配置模块
 *
 * 在 Claude Code 系统流程中的位置：
 *   autoDream.ts 中的 isGateOpen() → 调用 isAutoDreamEnabled() 检查功能开关
 *   → UI 组件也可直接调用此函数，判断是否显示 AutoDream 相关入口
 *
 * 主要功能：
 *  - isAutoDreamEnabled — 判断后台记忆整合功能是否启用
 *
 * 设计特点：
 *  - 叶子模块（leaf module）：故意保持最小依赖，UI 组件可直接引用，
 *    无需拖入 forkedAgent / 任务注册表 / 消息构建器等重量级依赖链
 *  - 优先级：用户 settings.json 中的 autoDreamEnabled 字段（显式设置时优先）
 *    → 回退到 GrowthBook feature flag（tengu_onyx_plover.enabled）
 */

import { getInitialSettings } from '../../utils/settings/settings.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../analytics/growthbook.js'

/**
 * 判断后台记忆整合（AutoDream）功能是否启用。
 *
 * 流程：
 *  1. 读取 settings.json 中的 autoDreamEnabled 字段
 *  2. 若显式设置（非 undefined），直接返回该值（用户设置优先）
 *  3. 否则，读取 GrowthBook feature flag（tengu_onyx_plover.enabled）作为默认值
 *
 * @returns true 表示功能已启用，false 表示已禁用
 */
export function isAutoDreamEnabled(): boolean {
  const setting = getInitialSettings().autoDreamEnabled
  // 用户显式设置时优先使用（即使值为 false 也会生效）
  if (setting !== undefined) return setting
  // 未显式设置时回退到 GrowthBook feature flag（缓存值，可能轻微过期）
  const gb = getFeatureValue_CACHED_MAY_BE_STALE<{ enabled?: unknown } | null>(
    'tengu_onyx_plover',
    null,
  )
  return gb?.enabled === true // 严格相等：null / undefined / 非 boolean 均视为 false
}
