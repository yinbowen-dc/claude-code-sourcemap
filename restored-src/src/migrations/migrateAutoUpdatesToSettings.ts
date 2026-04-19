/**
 * @file migrateAutoUpdatesToSettings.ts
 * @description 数据迁移模块 — 自动更新偏好设置迁移
 *
 * 在 Claude Code 系统启动流程中，该文件属于"启动时数据迁移"层：
 * 它将旧版全局配置文件（~/.claude.json）中存储的 autoUpdates 字段
 * 迁移至新的 settings.json 用户设置文件，以 DISABLE_AUTOUPDATER 环境变量的形式保存。
 * 迁移完成后从全局配置中移除旧字段，实现向后兼容的配置清理。
 *
 * 调用时机：Claude Code 每次启动时执行一次，具有幂等性。
 */

import { logEvent } from 'src/services/analytics/index.js'
import { getGlobalConfig, saveGlobalConfig } from '../utils/config.js'
import { logError } from '../utils/log.js'
import {
  getSettingsForSource,
  updateSettingsForSource,
} from '../utils/settings/settings.js'

/**
 * 将用户设置的自动更新偏好从全局配置迁移至 settings.json 的 env 块。
 *
 * 迁移流程：
 * 1. 读取全局配置，判断是否需要迁移（仅当用户主动禁用且非原生保护场景）
 * 2. 将 DISABLE_AUTOUPDATER=1 写入 userSettings 的 env 字段
 * 3. 同步设置当前进程环境变量，令禁用立即生效
 * 4. 从全局配置中删除旧的 autoUpdates 和 autoUpdatesProtectedForNative 字段
 *
 * 只在用户明确将 autoUpdates 设为 false（而非原生安装的自动保护）时执行迁移，
 * 以忠实保留用户意图，同时允许原生安装正常自动更新。
 */
export function migrateAutoUpdatesToSettings(): void {
  const globalConfig = getGlobalConfig()

  // 仅当用户主动将 autoUpdates 设为 false，且不是因原生保护机制自动置为 false 时才迁移
  if (
    globalConfig.autoUpdates !== false ||
    globalConfig.autoUpdatesProtectedForNative === true
  ) {
    return
  }

  try {
    // 读取现有的用户设置，若不存在则使用空对象
    const userSettings = getSettingsForSource('userSettings') || {}

    // 将 DISABLE_AUTOUPDATER 写入用户设置的 env 块，覆盖已有值以确保迁移完整
    updateSettingsForSource('userSettings', {
      ...userSettings,
      env: {
        ...userSettings.env,
        DISABLE_AUTOUPDATER: '1', // 禁用自动更新的环境变量标志
      },
    })

    // 上报迁移事件至分析服务，记录是否已存在该环境变量
    logEvent('tengu_migrate_autoupdates_to_settings', {
      was_user_preference: true,
      already_had_env_var: !!userSettings.env?.DISABLE_AUTOUPDATER,
    })

    // 立即在当前进程环境变量中生效，无需重启
    process.env.DISABLE_AUTOUPDATER = '1'

    // 从全局配置中移除已迁移的旧字段，保持配置文件整洁
    saveGlobalConfig(current => {
      const {
        autoUpdates: _,               // 旧的自动更新开关字段，迁移后删除
        autoUpdatesProtectedForNative: __, // 原生保护标志，迁移后删除
        ...updatedConfig
      } = current
      return updatedConfig
    })
  } catch (error) {
    // 迁移失败时记录错误并上报，但不抛出异常以免阻断启动流程
    logError(new Error(`Failed to migrate auto-updates: ${error}`))
    logEvent('tengu_migrate_autoupdates_error', {
      has_error: true,
    })
  }
}
