/**
 * 【Hook 配置策略管理模块】
 *
 * 本文件在 Claude Code 系统流中的位置：
 *   应用启动 / 设置变更 → hooksConfigManager（当前文件）→ hooksConfigSnapshot → Hook 执行引擎
 *
 * 主要职责：
 * 1. 实现完整的 Hook 配置策略层级：policySettings > userSettings > projectSettings > localSettings
 * 2. 提供 shouldAllowManagedHooksOnly()：检查是否只允许托管 Hook 运行
 * 3. 提供 shouldDisableAllHooksIncludingManaged()：检查是否禁用所有 Hook（含托管 Hook）
 * 4. 提供快照管理函数：captureHooksConfigSnapshot、updateHooksConfigSnapshot、
 *    getHooksConfigFromSnapshot、resetHooksConfigSnapshot
 *
 * 策略层级说明：
 * - policySettings.disableAllHooks = true → 完全禁用所有 Hook（包括托管 Hook）
 * - policySettings.allowManagedHooksOnly = true → 仅允许托管 Hook
 * - 非托管设置中 disableAllHooks = true → 禁用用户/项目/本地 Hook，托管 Hook 仍运行
 * - isRestrictedToPluginOnly('hooks') → 严格插件模式，非策略 Hook 被屏蔽
 *
 * 设计要点：
 * - 以 `* as settingsModule` 方式导入，确保测试中 spyOn 能正常拦截
 */

import { resetSdkInitState } from '../../bootstrap/state.js'
import { isRestrictedToPluginOnly } from '../settings/pluginOnlyPolicy.js'
// 以模块对象方式导入，确保测试中 spyOn 能正常拦截（直接导入会绕过 spy）
import * as settingsModule from '../settings/settings.js'
import { resetSettingsCache } from '../settings/settingsCache.js'
import type { HooksSettings } from '../settings/types.js'

// 会话启动时捕获的 Hook 配置快照（null 表示尚未初始化）
let initialHooksConfig: HooksSettings | null = null

/**
 * 从允许的配置源中获取 Hook 配置，实现完整策略层级。
 *
 * 策略优先级（从高到低）：
 * 1. policySettings.disableAllHooks = true → 返回空对象（完全禁用）
 * 2. policySettings.allowManagedHooksOnly = true → 仅返回 policySettings.hooks
 * 3. isRestrictedToPluginOnly('hooks') → 仅返回 policySettings.hooks
 * 4. 非托管设置中 disableAllHooks = true → 仅返回 policySettings.hooks（托管 Hook 仍运行）
 * 5. 其他情况 → 返回所有来源合并后的 hooks（向后兼容）
 *
 * 注意：Plugin hooks 和 agent frontmatter hooks 在各自注册点独立控制，不受此函数影响。
 */
function getHooksFromAllowedSources(): HooksSettings {
  const policySettings = settingsModule.getSettingsForSource('policySettings')

  // 规则 1：托管设置完全禁用所有 Hook
  if (policySettings?.disableAllHooks === true) {
    return {}
  }

  // 规则 2：仅允许托管 Hook（allowManagedHooksOnly 由策略层设置）
  if (policySettings?.allowManagedHooksOnly === true) {
    return policySettings.hooks ?? {}
  }

  // 规则 3：严格插件专用模式（用户/项目/本地 Hook 被屏蔽）
  // Plugin hooks 通过独立通道注册，不受此处限制
  // Agent frontmatter hooks 在注册时（runAgent.ts）按来源判断，不在此处拦截
  if (isRestrictedToPluginOnly('hooks')) {
    return policySettings?.hooks ?? {}
  }

  const mergedSettings = settingsModule.getSettings_DEPRECATED()

  // 规则 4：非托管设置禁用 Hook，但托管 Hook 仍可运行
  if (mergedSettings.disableAllHooks === true) {
    return policySettings?.hooks ?? {}
  }

  // 规则 5：默认情况，返回所有来源合并后的 Hook（向后兼容）
  return mergedSettings.hooks ?? {}
}

/**
 * 检查是否只允许托管 Hook 运行。
 *
 * 返回 true 的两种情况：
 * 1. policySettings.allowManagedHooksOnly = true（显式策略限制）
 * 2. 非托管设置中 disableAllHooks = true，但托管设置未禁用（隐式降级为托管专用）
 *
 * @returns true 表示只有托管 Hook 可以运行
 */
export function shouldAllowManagedHooksOnly(): boolean {
  const policySettings = settingsModule.getSettingsForSource('policySettings')
  // 情况 1：策略层明确限制只允许托管 Hook
  if (policySettings?.allowManagedHooksOnly === true) {
    return true
  }
  // 情况 2：非托管设置禁用了 Hook，但托管设置未禁用
  // 效果：非托管 Hook 被禁用，托管 Hook 仍运行（降级为托管专用模式）
  if (
    settingsModule.getSettings_DEPRECATED().disableAllHooks === true &&
    policySettings?.disableAllHooks !== true
  ) {
    return true
  }
  return false
}

/**
 * 检查是否应禁用所有 Hook（包括托管 Hook）。
 * 仅当 policySettings.disableAllHooks = true 时返回 true。
 * 非托管设置中的 disableAllHooks 不能禁用托管 Hook，因此不影响此函数。
 *
 * @returns true 表示所有 Hook（含托管 Hook）都应被禁用
 */
export function shouldDisableAllHooksIncludingManaged(): boolean {
  // 只有托管/策略设置有权禁用托管 Hook
  return (
    settingsModule.getSettingsForSource('policySettings')?.disableAllHooks ===
    true
  )
}

/**
 * 捕获当前 Hook 配置快照。
 * 应在应用启动时调用一次，将当前配置缓存到 initialHooksConfig。
 * 快照机制确保 Hook 执行期间使用一致的配置，不受运行时设置变更影响。
 */
export function captureHooksConfigSnapshot(): void {
  initialHooksConfig = getHooksFromAllowedSources()
}

/**
 * 更新 Hook 配置快照（用于设置变更后刷新）。
 * 在通过 /hooks 命令修改设置后调用。
 *
 * 工作流程：
 * 1. 重置设置缓存（强制从磁盘重新读取，处理外部编辑 settings.json 的场景）
 * 2. 重新捕获快照
 *
 * 注意：若不先重置缓存，文件监听器的稳定性延迟可能导致读取到过期数据。
 */
export function updateHooksConfigSnapshot(): void {
  // 重置会话缓存，确保读取最新设置（处理外部编辑且文件监听器尚未触发的情况）
  resetSettingsCache()
  initialHooksConfig = getHooksFromAllowedSources()
}

/**
 * 获取 Hook 配置快照（懒初始化）。
 * 若快照尚未初始化，则自动触发捕获。
 *
 * @returns 当前 Hook 配置，若尚未配置则返回 null
 */
export function getHooksConfigFromSnapshot(): HooksSettings | null {
  // 懒初始化：首次调用时自动捕获快照
  if (initialHooksConfig === null) {
    captureHooksConfigSnapshot()
  }
  return initialHooksConfig
}

/**
 * 重置 Hook 配置快照（用于测试隔离）。
 * 同时重置 SDK 初始化状态，防止测试间的状态污染。
 */
export function resetHooksConfigSnapshot(): void {
  initialHooksConfig = null    // 清除快照，下次访问时重新捕获
  resetSdkInitState()          // 重置 SDK 初始化状态，防止测试污染
}
