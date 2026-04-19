/**
 * @file migrateLegacyOpusToCurrent.ts
 * @description 数据迁移模块 — 旧版 Opus 4.0/4.1 显式模型字符串迁移
 *
 * 在 Claude Code 系统启动流程中，该文件属于"启动时数据迁移"层：
 * 它将用户在 settings.json 中显式固定的旧版 Opus 模型字符串
 *（如 claude-opus-4-0、claude-opus-4-1 等）迁移至通用 'opus' 别名。
 *
 * 背景：
 * - 'opus' 别名已在一方（firstParty）环境中解析为 Opus 4.6
 * - parseUserSpecifiedModel 在运行时会静默重映射这些旧字符串
 * - 但不清理 settings.json，导致 /model 命令显示过时的模型名
 * - 本迁移清理 settings.json，同时写入时间戳，供 REPL 展示一次性通知
 *
 * 仅修改 userSettings，保留 project/local/policy 层设置不变。
 * 读写同一来源保证幂等性，无需完成标志。
 * 调用时机：Claude Code 每次启动时执行，具有幂等性。
 */

import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../services/analytics/index.js'
import { saveGlobalConfig } from '../utils/config.js'
import { isLegacyModelRemapEnabled } from '../utils/model/model.js'
import { getAPIProvider } from '../utils/model/providers.js'
import {
  getSettingsForSource,
  updateSettingsForSource,
} from '../utils/settings/settings.js'

/**
 * 将一方用户的旧版 Opus 4.0/4.1 显式模型字符串迁移至 'opus' 别名。
 *
 * 迁移流程：
 * 1. 检查 API 提供方，仅对一方（firstParty）用户执行
 * 2. 检查旧版模型重映射功能开关是否已启用
 * 3. 读取 userSettings.model，检查是否为待迁移的旧版字符串之一
 * 4. 将 model 更新为 'opus' 别名，写入 legacyOpusMigrationTimestamp 时间戳
 * 5. 上报迁移事件（含原始模型字符串）
 *
 * 幂等性保证：仅读写 userSettings，迁移后模型值为 'opus'，
 * 不匹配任何待迁移字符串，重复执行无副作用。
 */
export function migrateLegacyOpusToCurrent(): void {
  // 仅对一方（firstParty）用户执行迁移，三方用户使用完整模型 ID 无需处理
  if (getAPIProvider() !== 'firstParty') {
    return
  }

  // 检查旧版模型重映射功能是否已启用（由功能开关控制）
  if (!isLegacyModelRemapEnabled()) {
    return
  }

  // 读取 userSettings 中的模型配置，检查是否为待迁移的旧版字符串
  const model = getSettingsForSource('userSettings')?.model
  if (
    model !== 'claude-opus-4-20250514' &&   // 旧版 Opus 4.0 完整发布字符串
    model !== 'claude-opus-4-1-20250805' &&  // 旧版 Opus 4.1 完整发布字符串
    model !== 'claude-opus-4-0' &&           // 旧版 Opus 4.0 短别名
    model !== 'claude-opus-4-1'              // 旧版 Opus 4.1 短别名
  ) {
    return
  }

  // 将旧模型字符串替换为通用 'opus' 别名，确保 /model 命令显示正确
  updateSettingsForSource('userSettings', { model: 'opus' })
  // 写入迁移时间戳，供 REPL 展示一次性"已升级到 Opus"通知
  saveGlobalConfig(current => ({
    ...current,
    legacyOpusMigrationTimestamp: Date.now(),
  }))
  // 上报迁移事件，携带原始模型字符串供分析
  logEvent('tengu_legacy_opus_migration', {
    from_model:
      model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  })
}
