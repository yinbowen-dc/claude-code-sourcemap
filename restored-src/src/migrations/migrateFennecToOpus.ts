/**
 * @file migrateFennecToOpus.ts
 * @description 数据迁移模块 — Fennec 模型别名迁移至 Opus 4.6
 *
 * 在 Claude Code 系统启动流程中，该文件属于"启动时数据迁移"层：
 * 它将已下线的 fennec-* 系列模型别名映射至对应的 Opus 4.6 别名，
 * 确保内部用户（USER_TYPE === 'ant'）在模型下线后依然能正常使用等效模型。
 *
 * 映射规则：
 *   fennec-latest        → opus
 *   fennec-latest[1m]    → opus[1m]
 *   fennec-fast-latest   → opus[1m] + fastMode
 *   opus-4-5-fast        → opus[1m] + fastMode
 *
 * 仅修改 userSettings，不触碰 project/local/policy 层设置。
 * 读写同一来源保证幂等性，无需完成标志。
 * 调用时机：Claude Code 每次启动时执行，具有幂等性。
 */

import {
  getSettingsForSource,
  updateSettingsForSource,
} from '../utils/settings/settings.js'

/**
 * 将已下线的 fennec 模型别名迁移至对应的 Opus 4.6 别名。
 *
 * 迁移流程：
 * 1. 检查环境变量 USER_TYPE，仅对内部用户（ant）执行迁移
 * 2. 读取 userSettings 中的 model 字段
 * 3. 按前缀匹配规则将旧别名替换为新别名，部分别名同时启用 fastMode
 *
 * 幂等性保证：只读写 userSettings，映射后的值不再匹配任何旧前缀，
 * 因此重复执行无副作用，无需完成标志。
 */
export function migrateFennecToOpus(): void {
  // 仅对内部用户（ant 类型）执行 fennec 别名迁移
  if (process.env.USER_TYPE !== 'ant') {
    return
  }

  // 读取 userSettings 中的模型配置
  const settings = getSettingsForSource('userSettings')

  const model = settings?.model
  if (typeof model === 'string') {
    if (model.startsWith('fennec-latest[1m]')) {
      // fennec-latest[1m] → opus[1m]（保留 1M 上下文窗口）
      updateSettingsForSource('userSettings', {
        model: 'opus[1m]',
      })
    } else if (model.startsWith('fennec-latest')) {
      // fennec-latest → opus（标准 Opus 4.6 别名）
      updateSettingsForSource('userSettings', {
        model: 'opus',
      })
    } else if (
      model.startsWith('fennec-fast-latest') ||
      model.startsWith('opus-4-5-fast')
    ) {
      // fennec-fast-latest / opus-4-5-fast → opus[1m] + fastMode（保留快速模式）
      updateSettingsForSource('userSettings', {
        model: 'opus[1m]',
        fastMode: true, // 同时启用快速模式，忠实保留用户原有选择
      })
    }
  }
}
