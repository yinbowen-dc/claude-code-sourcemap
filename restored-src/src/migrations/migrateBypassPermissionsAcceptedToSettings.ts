/**
 * @file migrateBypassPermissionsAcceptedToSettings.ts
 * @description 数据迁移模块 — 危险模式权限提示接受状态迁移
 *
 * 在 Claude Code 系统启动流程中，该文件属于"启动时数据迁移"层：
 * 它将旧版全局配置文件（~/.claude.json）中存储的 bypassPermissionsModeAccepted 字段
 * 迁移至新的 settings.json 用户设置文件，以 skipDangerousModePermissionPrompt 字段保存。
 * settings.json 是用户可配置的标准设置文件，是该字段更合适的存放位置。
 * 迁移完成后从全局配置中移除旧字段，实现向后兼容的配置清理。
 *
 * 调用时机：Claude Code 每次启动时执行一次，具有幂等性。
 */

import { logEvent } from 'src/services/analytics/index.js'
import { getGlobalConfig, saveGlobalConfig } from '../utils/config.js'
import { logError } from '../utils/log.js'
import {
  hasSkipDangerousModePermissionPrompt,
  updateSettingsForSource,
} from '../utils/settings/settings.js'

/**
 * 将用户对危险模式权限提示的接受状态从全局配置迁移至 settings.json。
 *
 * 迁移流程：
 * 1. 读取全局配置，若未设置 bypassPermissionsModeAccepted 则直接返回（无需迁移）
 * 2. 检查 settings.json 中是否已存在 skipDangerousModePermissionPrompt，避免重复写入
 * 3. 将 skipDangerousModePermissionPrompt: true 写入 userSettings
 * 4. 上报迁移事件，然后从全局配置中删除旧字段
 *
 * 幂等性保证：若目标字段已存在，则跳过写入步骤，但仍清理旧字段。
 */
export function migrateBypassPermissionsAcceptedToSettings(): void {
  const globalConfig = getGlobalConfig()

  // 若旧字段不存在，说明无需迁移，直接返回
  if (!globalConfig.bypassPermissionsModeAccepted) {
    return
  }

  try {
    // 仅在目标字段尚未设置时才写入，避免覆盖用户后续的主动修改
    if (!hasSkipDangerousModePermissionPrompt()) {
      updateSettingsForSource('userSettings', {
        skipDangerousModePermissionPrompt: true, // 跳过危险模式权限提示
      })
    }

    // 上报迁移成功事件至分析服务
    logEvent('tengu_migrate_bypass_permissions_accepted', {})

    // 从全局配置中移除已迁移的旧字段，保持配置文件整洁
    saveGlobalConfig(current => {
      // 若旧字段已不存在（可能被其他进程清除），则直接返回，避免无意义写入
      if (!('bypassPermissionsModeAccepted' in current)) return current
      const { bypassPermissionsModeAccepted: _, ...updatedConfig } = current
      return updatedConfig
    })
  } catch (error) {
    // 迁移失败时记录错误，但不抛出异常以免阻断启动流程
    logError(
      new Error(`Failed to migrate bypass permissions accepted: ${error}`),
    )
  }
}
