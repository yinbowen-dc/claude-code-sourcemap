/**
 * @file migrateOpusToOpus1m.ts
 * @description 数据迁移模块 — opus 别名升级至 opus[1m]
 *
 * 在 Claude Code 系统启动流程中，该文件属于"启动时数据迁移"层：
 * 它将符合条件的用户（Max/Team Premium 一方订阅者）在 userSettings 中
 * 固定的 'opus' 别名升级至 'opus[1m]'，使其享受 Opus 1M 合并体验。
 *
 * 跳过条件：
 * - Opus 1M 合并功能未开启（isOpus1mMergeEnabled 返回 false）
 * - userSettings.model 不是精确的 'opus'（已是 opus[1m] 或其他值）
 * - Pro 订阅者（保留独立的 Opus 和 Opus 1M 选项）
 * - 三方用户（使用完整模型 ID，不用别名）
 *
 * 特殊逻辑：若 opus[1m] 解析结果与当前默认模型相同，则将 model 设为
 * undefined（使用默认值），避免冗余的显式固定。
 *
 * 仅修改 userSettings，CLI --model opus 运行时覆盖不受影响。
 * 调用时机：Claude Code 每次启动时执行，具有幂等性。
 */

import { logEvent } from '../services/analytics/index.js'
import {
  getDefaultMainLoopModelSetting,
  isOpus1mMergeEnabled,
  parseUserSpecifiedModel,
} from '../utils/model/model.js'
import {
  getSettingsForSource,
  updateSettingsForSource,
} from '../utils/settings/settings.js'

/**
 * 将符合条件用户的 userSettings.model 从 'opus' 升级至 'opus[1m]'。
 *
 * 迁移流程：
 * 1. 检查 Opus 1M 合并功能开关，未开启则直接返回
 * 2. 读取 userSettings.model，非精确 'opus' 则直接返回
 * 3. 解析 'opus[1m]' 与当前默认模型，若两者相同则写入 undefined（保持默认）
 * 4. 否则写入 'opus[1m]' 别名
 * 5. 上报迁移事件
 */
export function migrateOpusToOpus1m(): void {
  // 检查 Opus 1M 合并体验功能开关，未开启时无需迁移
  if (!isOpus1mMergeEnabled()) {
    return
  }

  // 仅当 userSettings.model 精确为 'opus' 时才执行迁移
  const model = getSettingsForSource('userSettings')?.model
  if (model !== 'opus') {
    return
  }

  // 确定迁移目标值：若 opus[1m] 已是当前默认模型，则写入 undefined 避免冗余固定
  const migrated = 'opus[1m]'
  const modelToSet =
    parseUserSpecifiedModel(migrated) ===
    parseUserSpecifiedModel(getDefaultMainLoopModelSetting())
      ? undefined  // opus[1m] 即为当前默认，无需显式固定
      : migrated   // opus[1m] 与默认不同，显式写入
  updateSettingsForSource('userSettings', { model: modelToSet })

  // 上报迁移事件至分析服务
  logEvent('tengu_opus_to_opus1m_migration', {})
}
