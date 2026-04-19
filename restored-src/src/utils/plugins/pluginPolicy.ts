/**
 * 插件策略检查模块 — Claude Code 插件系统的策略门卫层
 *
 * 在 Claude Code 插件系统的三层模型中，此文件处于最顶层（策略层）：
 *   策略设置（managed-settings.json）→ 用户/项目设置 → 本地/标志设置
 *
 * 职责：
 *   - 读取 policySettings（托管设置，由组织管理员下发）中的 enabledPlugins 字段
 *   - 判断某个插件是否被组织策略强制禁用
 *   - 被安装入口（installResolvedPlugin）、启用操作和 UI 过滤器统一调用
 *
 * 设计为叶子模块（仅依赖 settings，不依赖其他插件子系统）以避免循环依赖：
 *   marketplaceHelpers → marketplaceManager → 几乎整个插件子系统
 *   若此文件引入了 marketplaceHelpers，则会形成循环。
 */

import { getSettingsForSource } from '../settings/settings.js'

/**
 * 检查某个插件是否被组织策略强制禁用（managed-settings.json）。
 *
 * 流程：
 *   1. 读取 policySettings（托管设置源）中的 enabledPlugins 字段
 *   2. 若该字段对目标 pluginId 显式设置为 false，则视为被策略阻止
 *   3. 返回 true 表示被阻止，false 表示未被策略限制（包括未配置的情况）
 *
 * 用途：被安装检查点、启用操作和 UI 过滤器统一调用，是策略阻止的唯一权威来源。
 * 策略阻止的插件无法被用户在任何作用域安装或启用。
 *
 * @param pluginId - 插件标识符，格式为 "name@marketplace" 或 "name"
 * @returns 若被策略阻止返回 true，否则返回 false
 */
export function isPluginBlockedByPolicy(pluginId: string): boolean {
  // 读取 policySettings（托管设置）中的 enabledPlugins 映射表
  const policyEnabled = getSettingsForSource('policySettings')?.enabledPlugins
  // 仅当显式设置为 false 时才视为被阻止；undefined/true 均允许通过
  return policyEnabled?.[pluginId] === false
}
