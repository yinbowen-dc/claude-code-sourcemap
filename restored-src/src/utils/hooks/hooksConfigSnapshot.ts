/**
 * 【Hook 配置快照模块】
 *
 * 本文件在 Claude Code 系统流中的位置：
 *   应用启动 / 配置变更 → hooksConfigSnapshot（当前文件）→ Hook 执行引擎 / hooksSettings
 *
 * 主要职责：
 * 1. captureHooksConfigSnapshot()：在会话启动时拍摄 Hook 配置快照，防止运行时配置漂移
 * 2. updateHooksConfigSnapshot()：在设置变更后刷新快照（先重置缓存确保读取最新数据）
 * 3. getHooksConfigFromSnapshot()：懒初始化地返回当前快照
 * 4. resetHooksConfigSnapshot()：测试用途，重置快照和 SDK 初始化状态
 *
 * 设计要点：
 * - 快照存储在模块级变量 initialHooksConfig 中（null 表示尚未初始化）
 * - updateHooksConfigSnapshot 在读取前重置设置缓存，处理外部编辑 settings.json 后
 *   文件监听器尚未触发稳定性阈值的情况
 * - resetHooksConfigSnapshot 同时调用 resetSdkInitState，防止测试间污染
 *
 * 注意：此模块是 hooksConfigManager 的薄封装，核心逻辑在 hooksConfigManager 中实现。
 * 此文件专注于快照的生命周期管理。
 */

import { resetSdkInitState } from '../../bootstrap/state.js'
import { isRestrictedToPluginOnly } from '../settings/pluginOnlyPolicy.js'
// 以模块对象方式导入，确保测试中 spyOn 能正常拦截（直接命名导入会绕过 spy）
import * as settingsModule from '../settings/settings.js'
import { resetSettingsCache } from '../settings/settingsCache.js'
import type { HooksSettings } from '../settings/types.js'

// 模块级快照存储：null 表示尚未初始化，等待首次 captureHooksConfigSnapshot 调用
let initialHooksConfig: HooksSettings | null = null

/**
 * 从所有被允许的配置源中读取并聚合 Hook 配置。
 * 实现完整策略层级（policySettings > userSettings > projectSettings > localSettings）。
 *
 * 策略优先级：
 * 1. policySettings.disableAllHooks → 完全禁用
 * 2. policySettings.allowManagedHooksOnly → 仅托管 Hook
 * 3. isRestrictedToPluginOnly('hooks') → 严格插件模式
 * 4. 合并设置中 disableAllHooks → 非托管禁用，托管仍运行
 * 5. 默认 → 返回所有来源合并的 Hook
 */
function getHooksFromAllowedSources(): HooksSettings {
  const policySettings = settingsModule.getSettingsForSource('policySettings')

  // 策略 1：托管设置完全禁用所有 Hook
  if (policySettings?.disableAllHooks === true) {
    return {}
  }

  // 策略 2：仅允许托管 Hook 运行
  if (policySettings?.allowManagedHooksOnly === true) {
    return policySettings.hooks ?? {}
  }

  // 策略 3：严格插件专用定制模式（用户/项目/本地 Hook 均被屏蔽）
  // Plugin hooks 通过独立注册通道处理，不受此策略影响
  // Agent frontmatter hooks 在注册时（runAgent.ts）按来源分类，不在此处拦截
  if (isRestrictedToPluginOnly('hooks')) {
    return policySettings?.hooks ?? {}
  }

  const mergedSettings = settingsModule.getSettings_DEPRECATED()

  // 策略 4：非托管设置禁用 Hook，但托管 Hook 仍可运行
  if (mergedSettings.disableAllHooks === true) {
    return policySettings?.hooks ?? {}
  }

  // 策略 5：默认返回所有来源合并的 Hook（向后兼容）
  return mergedSettings.hooks ?? {}
}

/**
 * 检查是否只允许托管 Hook 运行。
 *
 * 满足以下任一条件时返回 true：
 * 1. policySettings.allowManagedHooksOnly = true（显式策略限制）
 * 2. 非托管设置中 disableAllHooks = true 但托管设置未完全禁用
 *    （隐式降级：非托管 Hook 被禁用，托管 Hook 仍运行）
 */
export function shouldAllowManagedHooksOnly(): boolean {
  const policySettings = settingsModule.getSettingsForSource('policySettings')
  // 条件 1：策略层明确要求只允许托管 Hook
  if (policySettings?.allowManagedHooksOnly === true) {
    return true
  }
  // 条件 2：非托管设置禁用了 Hook（但托管设置未同时禁用）
  if (
    settingsModule.getSettings_DEPRECATED().disableAllHooks === true &&
    policySettings?.disableAllHooks !== true
  ) {
    return true
  }
  return false
}

/**
 * 检查是否应禁用所有 Hook（含托管 Hook）。
 * 仅当 policySettings.disableAllHooks = true 时返回 true。
 * 非托管设置中的 disableAllHooks 无权禁用托管 Hook。
 */
export function shouldDisableAllHooksIncludingManaged(): boolean {
  return (
    settingsModule.getSettingsForSource('policySettings')?.disableAllHooks ===
    true
  )
}

/**
 * 拍摄 Hook 配置快照（应在应用启动时调用一次）。
 * 将当前有效的 Hook 配置缓存到 initialHooksConfig，
 * 确保 Hook 执行期间使用一致的配置，不受运行时修改影响。
 */
export function captureHooksConfigSnapshot(): void {
  initialHooksConfig = getHooksFromAllowedSources()
}

/**
 * 刷新 Hook 配置快照（在设置被修改后调用）。
 * 例如用户通过 /hooks 命令编辑了 settings.json 后调用此函数。
 *
 * 执行步骤：
 * 1. 重置设置缓存（强制从磁盘读取，避免读到过期缓存数据）
 * 2. 重新拍摄快照
 *
 * 注意：不先重置缓存可能导致外部编辑 settings.json 后，
 * 在文件监听器稳定性阈值到期之前仍读取到旧数据。
 */
export function updateHooksConfigSnapshot(): void {
  // 重置会话缓存，确保读取最新磁盘数据
  resetSettingsCache()
  initialHooksConfig = getHooksFromAllowedSources()
}

/**
 * 获取 Hook 配置快照（懒初始化）。
 * 若快照尚未初始化，则自动触发 captureHooksConfigSnapshot。
 *
 * @returns 当前 Hook 配置快照，若从未配置过则返回 null
 */
export function getHooksConfigFromSnapshot(): HooksSettings | null {
  // 懒初始化：首次调用时自动捕获快照
  if (initialHooksConfig === null) {
    captureHooksConfigSnapshot()
  }
  return initialHooksConfig
}

/**
 * 重置 Hook 配置快照（仅用于测试隔离）。
 * 同时调用 resetSdkInitState 防止测试用例间的状态泄漏。
 */
export function resetHooksConfigSnapshot(): void {
  initialHooksConfig = null  // 清除快照，下次访问时重新初始化
  resetSdkInitState()        // 重置 SDK 状态，防止测试污染
}
