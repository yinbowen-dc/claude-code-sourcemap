/**
 * @file migrateSonnet45ToSonnet46.ts
 * @description 数据迁移模块 — Sonnet 4.5 显式字符串升级至 sonnet 别名
 *
 * 在 Claude Code 系统启动流程中，该文件属于"启动时数据迁移"层：
 * 它将 Pro/Max/Team Premium 一方用户 settings.json 中固定的 Sonnet 4.5
 * 显式版本字符串升级至 'sonnet' 或 'sonnet[1m]' 通用别名，
 * 使其自动跟进至 Sonnet 4.6。
 *
 * 需要迁移的模型字符串：
 *   claude-sonnet-4-5-20250929      → sonnet
 *   claude-sonnet-4-5-20250929[1m]  → sonnet[1m]
 *   sonnet-4-5-20250929             → sonnet
 *   sonnet-4-5-20250929[1m]         → sonnet[1m]
 *
 * 背景：部分用户通过 migrateSonnet1mToSonnet45 或手动 /model 命令固定了 4.5 字符串。
 * 仅修改 userSettings，保留 project/local 层设置不变。
 * 读写同一来源保证幂等性，无需完成标志。
 * 调用时机：Claude Code 每次启动时执行，具有幂等性。
 */

import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../services/analytics/index.js'
import {
  isMaxSubscriber,
  isProSubscriber,
  isTeamPremiumSubscriber,
} from '../utils/auth.js'
import { getGlobalConfig, saveGlobalConfig } from '../utils/config.js'
import { getAPIProvider } from '../utils/model/providers.js'
import {
  getSettingsForSource,
  updateSettingsForSource,
} from '../utils/settings/settings.js'

/**
 * 将 Pro/Max/Team Premium 一方用户的 Sonnet 4.5 显式字符串升级至 sonnet 别名。
 *
 * 迁移流程：
 * 1. 检查 API 提供方，仅对一方（firstParty）用户执行
 * 2. 检查订阅类型，仅对 Pro/Max/Team Premium 订阅者执行
 * 3. 读取 userSettings.model，检查是否为四种待迁移字符串之一
 * 4. 根据是否携带 [1m] 后缀，分别映射至 'sonnet[1m]' 或 'sonnet'
 * 5. 对非新用户（numStartups > 1）写入时间戳，供 REPL 展示升级通知
 * 6. 上报迁移事件（含原始字符串和是否携带 1m）
 */
export function migrateSonnet45ToSonnet46(): void {
  // 仅对一方（firstParty）用户执行，三方用户使用完整模型 ID
  if (getAPIProvider() !== 'firstParty') {
    return
  }

  // 仅对 Pro、Max 或 Team Premium 订阅者执行迁移
  if (!isProSubscriber() && !isMaxSubscriber() && !isTeamPremiumSubscriber()) {
    return
  }

  // 读取 userSettings.model，检查是否为待迁移的 Sonnet 4.5 显式字符串
  const model = getSettingsForSource('userSettings')?.model
  if (
    model !== 'claude-sonnet-4-5-20250929' &&      // 旧版完整前缀字符串
    model !== 'claude-sonnet-4-5-20250929[1m]' &&  // 旧版完整前缀字符串（1M 版）
    model !== 'sonnet-4-5-20250929' &&             // 旧版短前缀字符串
    model !== 'sonnet-4-5-20250929[1m]'            // 旧版短前缀字符串（1M 版）
  ) {
    return
  }

  // 检查原字符串是否携带 [1m] 后缀，以决定目标别名
  const has1m = model.endsWith('[1m]')
  updateSettingsForSource('userSettings', {
    model: has1m ? 'sonnet[1m]' : 'sonnet', // 保留 1M 上下文窗口选择
  })

  // 对非新用户写入迁移时间戳，以便 REPL 展示"已升级到 Sonnet 4.6"一次性通知
  const config = getGlobalConfig()
  if (config.numStartups > 1) {
    saveGlobalConfig(current => ({
      ...current,
      sonnet45To46MigrationTimestamp: Date.now(), // 触发 REPL 升级通知的时间戳
    }))
  }

  // 上报迁移事件，携带原始模型字符串和 1m 标志
  logEvent('tengu_sonnet45_to_46_migration', {
    from_model:
      model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    has_1m: has1m, // 是否携带 1M 上下文
  })
}
