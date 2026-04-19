/**
 * 企业托管插件名称读取模块。
 *
 * 在 Claude Code 插件系统流程中，本文件处于"企业策略执行"层：
 *   - 企业管理员可以通过 policySettings.enabledPlugins 字段声明哪些插件
 *     受到策略保护（布尔值形式的 "name@marketplace": true/false 条目）；
 *   - marketplaceHelpers.ts 和 UI 层在决定是否允许用户卸载/修改某个插件时，
 *     会调用本模块的 getManagedPluginNames() 进行查询；
 *   - 返回 null 表示当前会话中没有任何企业策略生效（最常见情况）。
 *
 * 主要导出：
 *   - getManagedPluginNames()：从 policySettings 读取受管理的插件名称集合
 */

import { getSettingsForSource } from '../settings/settings.js'

/**
 * 读取由组织策略锁定的插件名称集合。
 *
 * 流程：
 *   1. 从 policySettings（由 MDM/管理员配置写入）读取 enabledPlugins 对象；
 *   2. 遍历其中所有键，过滤出符合 "name@marketplace" 格式且值为布尔类型的条目；
 *   3. 提取插件名称部分（@ 符号前的部分）并收集为 Set；
 *   4. 若集合非空则返回，否则返回 null。
 *
 * @returns 受管理的插件名称集合；若无策略配置则返回 null
 */
export function getManagedPluginNames(): Set<string> | null {
  // 读取 policySettings 来源的 enabledPlugins 字段
  const enabledPlugins = getSettingsForSource('policySettings')?.enabledPlugins
  // 若管理员未声明任何插件策略，直接返回 null（无策略生效）
  if (!enabledPlugins) {
    return null
  }
  const names = new Set<string>()
  for (const [pluginId, value] of Object.entries(enabledPlugins)) {
    // 只处理布尔值形式的 "name@marketplace" 条目（true 或 false 均视为受管）
    // 旧版 owner/repo 数组形式不纳入管理范围
    if (typeof value !== 'boolean' || !pluginId.includes('@')) {
      continue
    }
    // 提取 @ 符号前的插件名称部分
    const name = pluginId.split('@')[0]
    if (name) {
      names.add(name)
    }
  }
  // 集合为空则返回 null，表示策略字段存在但无有效条目
  return names.size > 0 ? names : null
}
