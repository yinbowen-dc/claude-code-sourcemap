/**
 * @file migrateSonnet1mToSonnet45.ts
 * @description 数据迁移模块 — sonnet[1m] 别名锁定至 Sonnet 4.5 显式版本
 *
 * 在 Claude Code 系统启动流程中，该文件属于"启动时数据迁移"层：
 * 它将用户在 userSettings 中保存的 'sonnet[1m]' 别名迁移至显式版本字符串
 * 'sonnet-4-5-20250929[1m]'，防止 'sonnet' 别名迁移到 Sonnet 4.6 后
 * 意外将这批用户升级到 Sonnet 4.6 1M（两个版本的 1M 面向不同用户群）。
 *
 * 同时迁移内存中的运行时模型覆盖值，确保当前会话立即生效。
 * 一次性迁移，由 globalConfig.sonnet1m45MigrationComplete 标志跟踪完成状态。
 * 调用时机：Claude Code 每次启动时执行，完成后不再重复执行。
 */

import {
  getMainLoopModelOverride,
  setMainLoopModelOverride,
} from '../bootstrap/state.js'
import { getGlobalConfig, saveGlobalConfig } from '../utils/config.js'
import {
  getSettingsForSource,
  updateSettingsForSource,
} from '../utils/settings/settings.js'

/**
 * 将 userSettings 中的 'sonnet[1m]' 别名锁定至 Sonnet 4.5 显式版本字符串。
 *
 * 迁移流程：
 * 1. 检查 globalConfig.sonnet1m45MigrationComplete，已完成则直接返回
 * 2. 读取 userSettings.model，若为 'sonnet[1m]' 则改写为显式版本
 * 3. 检查并迁移内存中的运行时模型覆盖（getMainLoopModelOverride）
 * 4. 在 globalConfig 中记录迁移完成标志，防止重复执行
 *
 * 仅读写 userSettings，不触碰 project/local/policy 层设置，
 * 避免将项目级固定提升为全局默认值。
 */
export function migrateSonnet1mToSonnet45(): void {
  const config = getGlobalConfig()
  // 完成标志存在时直接跳过，确保一次性语义
  if (config.sonnet1m45MigrationComplete) {
    return
  }

  // 仅在 userSettings.model 精确为 'sonnet[1m]' 时迁移至显式 4.5 版本
  const model = getSettingsForSource('userSettings')?.model
  if (model === 'sonnet[1m]') {
    updateSettingsForSource('userSettings', {
      model: 'sonnet-4-5-20250929[1m]', // 显式锁定至 Sonnet 4.5 1M 版本
    })
  }

  // 同时迁移内存中的运行时覆盖，使当前会话立即生效，无需重启
  const override = getMainLoopModelOverride()
  if (override === 'sonnet[1m]') {
    setMainLoopModelOverride('sonnet-4-5-20250929[1m]')
  }

  // 写入完成标志，后续启动时直接跳过本迁移
  saveGlobalConfig(current => ({
    ...current,
    sonnet1m45MigrationComplete: true, // 标记迁移已完成
  }))
}
