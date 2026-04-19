/**
 * @file migrateEnableAllProjectMcpServersToSettings.ts
 * @description 数据迁移模块 — MCP 服务器审批字段迁移
 *
 * 在 Claude Code 系统启动流程中，该文件属于"启动时数据迁移"层：
 * 它将项目配置文件中存储的 MCP 服务器审批相关字段
 *（enableAllProjectMcpServers、enabledMcpjsonServers、disabledMcpjsonServers）
 * 迁移至 settings.json 的 localSettings 层，以统一配置管理体系，
 * 并提升 MCP 服务器审批状态的一致性和可维护性。
 *
 * 迁移策略：对于列表类字段，采用去重合并而非简单覆盖，保留已有设置。
 * 调用时机：Claude Code 每次启动时执行一次，具有幂等性。
 */

import { logEvent } from 'src/services/analytics/index.js'
import {
  getCurrentProjectConfig,
  saveCurrentProjectConfig,
} from '../utils/config.js'
import { logError } from '../utils/log.js'
import {
  getSettingsForSource,
  updateSettingsForSource,
} from '../utils/settings/settings.js'

/**
 * 将 MCP 服务器审批字段从项目配置迁移至 localSettings。
 *
 * 迁移流程：
 * 1. 读取当前项目配置，检测三个目标字段是否存在
 * 2. 若三个字段均不存在，则直接返回（无需迁移）
 * 3. 读取现有 localSettings，逐字段对比后按规则写入：
 *    - enableAllProjectMcpServers：目标不存在时迁移，已存在则仅标记清理
 *    - enabledMcpjsonServers：与现有列表去重合并
 *    - disabledMcpjsonServers：与现有列表去重合并
 * 4. 批量写入更新后的 localSettings
 * 5. 从项目配置中删除已迁移的三个字段
 * 6. 上报迁移统计事件
 */
export function migrateEnableAllProjectMcpServersToSettings(): void {
  const projectConfig = getCurrentProjectConfig()

  // 检查项目配置中是否存在需要迁移的字段
  const hasEnableAll = projectConfig.enableAllProjectMcpServers !== undefined
  const hasEnabledServers =
    projectConfig.enabledMcpjsonServers &&
    projectConfig.enabledMcpjsonServers.length > 0
  const hasDisabledServers =
    projectConfig.disabledMcpjsonServers &&
    projectConfig.disabledMcpjsonServers.length > 0

  // 若三个字段均不存在，无需执行任何迁移操作
  if (!hasEnableAll && !hasEnabledServers && !hasDisabledServers) {
    return
  }

  try {
    // 读取现有 localSettings，若不存在则使用空对象作为基准
    const existingSettings = getSettingsForSource('localSettings') || {}
    // 收集本次需要写入的更新内容
    const updates: Partial<{
      enableAllProjectMcpServers: boolean
      enabledMcpjsonServers: string[]
      disabledMcpjsonServers: string[]
    }> = {}
    // 收集需要从项目配置中删除的字段名
    const fieldsToRemove: Array<
      | 'enableAllProjectMcpServers'
      | 'enabledMcpjsonServers'
      | 'disabledMcpjsonServers'
    > = []

    // 迁移 enableAllProjectMcpServers：目标不存在时写入，已存在时仅标记清理
    if (
      hasEnableAll &&
      existingSettings.enableAllProjectMcpServers === undefined
    ) {
      // 目标字段尚未迁移，写入新值
      updates.enableAllProjectMcpServers =
        projectConfig.enableAllProjectMcpServers
      fieldsToRemove.push('enableAllProjectMcpServers')
    } else if (hasEnableAll) {
      // 目标字段已存在（之前迁移过），仅标记旧字段待删除
      fieldsToRemove.push('enableAllProjectMcpServers')
    }

    // 迁移 enabledMcpjsonServers：与现有列表去重合并，保留所有已审批服务器
    if (hasEnabledServers && projectConfig.enabledMcpjsonServers) {
      const existingEnabledServers =
        existingSettings.enabledMcpjsonServers || []
      // 使用 Set 去重，避免重复添加同一服务器
      updates.enabledMcpjsonServers = [
        ...new Set([
          ...existingEnabledServers,
          ...projectConfig.enabledMcpjsonServers,
        ]),
      ]
      fieldsToRemove.push('enabledMcpjsonServers')
    }

    // 迁移 disabledMcpjsonServers：与现有列表去重合并，保留所有已禁用服务器
    if (hasDisabledServers && projectConfig.disabledMcpjsonServers) {
      const existingDisabledServers =
        existingSettings.disabledMcpjsonServers || []
      // 使用 Set 去重，避免重复添加同一服务器
      updates.disabledMcpjsonServers = [
        ...new Set([
          ...existingDisabledServers,
          ...projectConfig.disabledMcpjsonServers,
        ]),
      ]
      fieldsToRemove.push('disabledMcpjsonServers')
    }

    // 仅在有实际更新内容时才写入 localSettings
    if (Object.keys(updates).length > 0) {
      updateSettingsForSource('localSettings', updates)
    }

    // 从项目配置中批量删除已迁移的旧字段
    if (
      fieldsToRemove.includes('enableAllProjectMcpServers') ||
      fieldsToRemove.includes('enabledMcpjsonServers') ||
      fieldsToRemove.includes('disabledMcpjsonServers')
    ) {
      saveCurrentProjectConfig(current => {
        const {
          enableAllProjectMcpServers: _enableAll,   // 迁移后删除
          enabledMcpjsonServers: _enabledServers,    // 迁移后删除
          disabledMcpjsonServers: _disabledServers,  // 迁移后删除
          ...configWithoutFields
        } = current
        return configWithoutFields
      })
    }

    // 上报迁移成功事件，记录本次迁移的字段数量
    logEvent('tengu_migrate_mcp_approval_fields_success', {
      migratedCount: fieldsToRemove.length,
    })
  } catch (e: unknown) {
    // 迁移失败时记录错误并上报，不抛出异常以免阻断启动流程
    logError(e)
    logEvent('tengu_migrate_mcp_approval_fields_error', {})
  }
}
