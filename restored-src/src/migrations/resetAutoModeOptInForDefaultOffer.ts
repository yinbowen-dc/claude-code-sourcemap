/**
 * @file resetAutoModeOptInForDefaultOffer.ts
 * @description 数据迁移模块 — 重置 AutoMode 选择以展示新的"设为默认"对话框
 *
 * 在 Claude Code 系统启动流程中，该文件属于"启动时数据迁移"层：
 * 它清除 skipAutoPermissionPrompt 标志，使曾接受旧版两选项 AutoModeOptInDialog
 * 但尚未将 auto 设为默认模式的用户，在下次启动时看到新版"设为我的默认模式"对话框。
 *
 * 触发条件（全部满足）：
 * - TRANSCRIPT_CLASSIFIER 功能特性标志已启用
 * - hasResetAutoModeOptInForDefaultOffer 尚未设置（防止重复执行）
 * - getAutoModeEnabledState() === 'enabled'（仅对 enabled 用户执行）
 * - 用户设置中 skipAutoPermissionPrompt 为 true 且 defaultMode 不是 'auto'
 *
 * 完成标志存储在 GlobalConfig（~/.claude.json）中，而非 settings.json，
 * 确保 settings 重置后迁移不会重新触发。
 * 调用时机：Claude Code 每次启动时检查，完成后不再执行。
 */

import { feature } from 'bun:bundle'
import { logEvent } from 'src/services/analytics/index.js'
import { getGlobalConfig, saveGlobalConfig } from '../utils/config.js'
import { logError } from '../utils/log.js'
import { getAutoModeEnabledState } from '../utils/permissions/permissionSetup.js'
import {
  getSettingsForSource,
  updateSettingsForSource,
} from '../utils/settings/settings.js'

/**
 * 重置满足条件用户的 skipAutoPermissionPrompt，使其看到新版 AutoMode 默认设置对话框。
 *
 * 迁移流程：
 * 1. 检查 TRANSCRIPT_CLASSIFIER 功能标志，未启用则直接返回
 * 2. 读取全局配置，若已设置 hasResetAutoModeOptInForDefaultOffer 则返回（防重复）
 * 3. 检查 AutoMode 启用状态，仅 'enabled' 状态执行（'opt-in' 状态跳过）
 * 4. 读取 userSettings，若 skipAutoPermissionPrompt 为 true 且 defaultMode 不是 'auto'
 *    则清除 skipAutoPermissionPrompt（设为 undefined）
 * 5. 写入全局配置完成标志，上报事件
 */
export function resetAutoModeOptInForDefaultOffer(): void {
  // 检查 TRANSCRIPT_CLASSIFIER 功能特性标志，仅在此特性启用时执行
  if (feature('TRANSCRIPT_CLASSIFIER')) {
    const config = getGlobalConfig()
    // 完成标志已设置，防止重复重置
    if (config.hasResetAutoModeOptInForDefaultOffer) return
    // 仅对 'enabled' 状态的用户执行；'opt-in' 状态下清除会导致对话框不可达
    if (getAutoModeEnabledState() !== 'enabled') return

    try {
      const user = getSettingsForSource('userSettings')
      // 条件：用户已跳过旧提示（skipAutoPermissionPrompt: true）
      // 且尚未将 auto 设为默认模式（defaultMode !== 'auto'）
      if (
        user?.skipAutoPermissionPrompt &&
        user?.permissions?.defaultMode !== 'auto'
      ) {
        // 清除跳过标志，使用户在下次启动时看到新版对话框
        updateSettingsForSource('userSettings', {
          skipAutoPermissionPrompt: undefined, // 重置为未设置状态
        })
        // 上报重置事件至分析服务
        logEvent('tengu_migrate_reset_auto_opt_in_for_default_offer', {})
      }

      // 写入完成标志，无论是否实际清除了字段，均标记为已处理
      saveGlobalConfig(c => {
        if (c.hasResetAutoModeOptInForDefaultOffer) return c
        return { ...c, hasResetAutoModeOptInForDefaultOffer: true }
      })
    } catch (error) {
      // 迁移失败时记录错误，不抛出异常以免阻断启动流程
      logError(new Error(`Failed to reset auto mode opt-in: ${error}`))
    }
  }
}
