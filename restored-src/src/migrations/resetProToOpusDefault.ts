/**
 * @file resetProToOpusDefault.ts
 * @description 数据迁移模块 — Pro 用户 Opus 默认模型升级通知
 *
 * 在 Claude Code 系统启动流程中，该文件属于"启动时数据迁移"层：
 * 它为符合条件的一方 Pro 用户记录 opusProMigrationTimestamp 时间戳，
 * 触发 REPL 展示一次性"您已获得 Opus 4.5 作为默认模型"通知。
 *
 * 执行逻辑：
 * - 非一方用户或非 Pro 订阅者：仅标记完成，上报 skipped: true
 * - 一方 Pro 用户，无自定义模型：写入时间戳，触发通知
 * - 一方 Pro 用户，已有自定义模型：仅标记完成，不触发通知
 *
 * 通过 globalConfig 的 opusProMigrationComplete 标志保证仅执行一次。
 * 调用时机：Claude Code 每次启动时检查，完成后不再执行。
 */

import { logEvent } from 'src/services/analytics/index.js'
import { isProSubscriber } from '../utils/auth.js'
import { getGlobalConfig, saveGlobalConfig } from '../utils/config.js'
import { getAPIProvider } from '../utils/model/providers.js'
import { getSettings_DEPRECATED } from '../utils/settings/settings.js'

/**
 * 为无自定义模型的一方 Pro 用户写入 Opus 默认模型迁移时间戳，触发升级通知。
 *
 * 迁移流程：
 * 1. 读取全局配置，若 opusProMigrationComplete 已设置则直接返回
 * 2. 检查 API 提供方和订阅类型，不满足条件则标记完成并上报跳过
 * 3. 读取合并后的 settings，检查用户是否有自定义模型配置
 * 4. 无自定义模型时：写入时间戳 + 完成标志，供 REPL 展示通知
 * 5. 有自定义模型时：仅写入完成标志，不展示通知
 */
export function resetProToOpusDefault(): void {
  const config = getGlobalConfig()

  // 完成标志已设置，之前已执行过迁移，直接跳过
  if (config.opusProMigrationComplete) {
    return
  }

  const apiProvider = getAPIProvider()

  // 非一方用户或非 Pro 订阅者，不需要此迁移，仅标记完成
  if (apiProvider !== 'firstParty' || !isProSubscriber()) {
    saveGlobalConfig(current => ({
      ...current,
      opusProMigrationComplete: true, // 标记完成，避免重复检查
    }))
    logEvent('tengu_reset_pro_to_opus_default', { skipped: true })
    return
  }

  // 读取合并后的用户设置，判断是否存在自定义模型配置
  const settings = getSettings_DEPRECATED()

  // 用户未设置自定义模型（使用系统默认），写入时间戳以触发升级通知
  if (settings?.model === undefined) {
    const opusProMigrationTimestamp = Date.now()
    saveGlobalConfig(current => ({
      ...current,
      opusProMigrationComplete: true,
      opusProMigrationTimestamp, // REPL 据此时间戳展示"已升级到 Opus"通知
    }))
    logEvent('tengu_reset_pro_to_opus_default', {
      skipped: false,
      had_custom_model: false, // 用户未自定义模型，触发通知
    })
  } else {
    // 用户已有自定义模型设置，无需打扰，仅标记完成
    saveGlobalConfig(current => ({
      ...current,
      opusProMigrationComplete: true, // 标记完成，不写入时间戳
    }))
    logEvent('tengu_reset_pro_to_opus_default', {
      skipped: false,
      had_custom_model: true, // 用户已有自定义模型，跳过通知
    })
  }
}
