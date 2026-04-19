/**
 * 【文件定位】Teleport 子系统 — 环境选择决策层
 *
 * 在 Claude Code 系统流程中的位置：
 *   environments.ts（拉取可用列表）→ 本模块（决策选用哪个环境）→
 *   远端 Session 初始化（将所选 environment_id 写入 SessionContext）
 *
 * 主要职责：
 *   将"可用环境列表"与"用户配置的默认环境偏好"两个信息源合并，
 *   输出一个统一的 EnvironmentSelectionInfo 对象，供 UI 层和 Session 创建层使用。
 *
 * 选择优先级（高到低）：
 *   1. 用户在某个配置源（project / user / global / flag 等）中显式指定的
 *      remote.defaultEnvironmentId
 *   2. 列表中第一个非 bridge 类型的环境
 *   3. 列表的第一个环境（兜底）
 */

import { SETTING_SOURCES, type SettingSource } from '../settings/constants.js'
import {
  getSettings_DEPRECATED,
  getSettingsForSource,
} from '../settings/settings.js'
import { type EnvironmentResource, fetchEnvironments } from './environments.js'

// 对外暴露的选择结果类型，包含全量列表、当前选中项及配置来源
export type EnvironmentSelectionInfo = {
  availableEnvironments: EnvironmentResource[]      // 所有可用环境
  selectedEnvironment: EnvironmentResource | null   // 最终选中的环境（无环境时为 null）
  selectedEnvironmentSource: SettingSource | null   // 选中依据来自哪个配置层（null = 默认逻辑）
}

/**
 * 查询可用环境列表并推断当前应使用哪个环境。
 *
 * 流程：
 *   1. 调用 fetchEnvironments() 获取全量可用环境
 *   2. 若列表为空，立即返回全 null 的结果
 *   3. 读取合并后的设置，查看是否有 remote.defaultEnvironmentId
 *   4. 若有显式配置的 ID：
 *      a. 在列表中查找匹配的环境对象
 *      b. 逆序遍历 SETTING_SOURCES（优先级从高到低），找到该 ID 实际来自哪个配置层
 *   5. 若无显式配置：选择列表中第一个非 bridge 环境（或整体第一个）
 *   6. 返回 EnvironmentSelectionInfo
 *
 * @returns Promise<EnvironmentSelectionInfo>
 */
export async function getEnvironmentSelectionInfo(): Promise<EnvironmentSelectionInfo> {
  // 第一步：拉取可用环境列表
  const environments = await fetchEnvironments()

  // 无环境时直接返回空结果，避免后续逻辑出错
  if (environments.length === 0) {
    return {
      availableEnvironments: [],
      selectedEnvironment: null,
      selectedEnvironmentSource: null,
    }
  }

  // 第二步：获取当前生效的合并配置（已按优先级叠加所有配置源）
  const mergedSettings = getSettings_DEPRECATED()
  const defaultEnvironmentId = mergedSettings?.remote?.defaultEnvironmentId

  // 默认选择：第一个非 bridge 环境；若全是 bridge 则退而选首个
  // bridge 类型是桥接环境，通常不直接用于 CCR 会话
  let selectedEnvironment: EnvironmentResource =
    environments.find(env => env.kind !== 'bridge') ?? environments[0]!
  // 未找到明确配置来源时为 null（表示使用"默认优先"逻辑）
  let selectedEnvironmentSource: SettingSource | null = null

  if (defaultEnvironmentId) {
    // 尝试在列表中精确匹配用户指定的 environment_id
    const matchingEnvironment = environments.find(
      env => env.environment_id === defaultEnvironmentId,
    )

    if (matchingEnvironment) {
      // 找到匹配项，使用显式指定的环境
      selectedEnvironment = matchingEnvironment

      // 逆序遍历配置源数组（从高优先级往低优先级）
      // 找到最后一个（即最高优先级）包含该 defaultEnvironmentId 的配置层
      for (let i = SETTING_SOURCES.length - 1; i >= 0; i--) {
        const source = SETTING_SOURCES[i]
        if (!source || source === 'flagSettings') {
          // flagSettings 是内部运行时标志，不属于用户可见的配置层，跳过
          continue
        }
        const sourceSettings = getSettingsForSource(source)
        // 若该配置源中也有相同的 defaultEnvironmentId，则记录并停止遍历
        if (
          sourceSettings?.remote?.defaultEnvironmentId === defaultEnvironmentId
        ) {
          selectedEnvironmentSource = source
          break
        }
      }
    }
  }

  // 返回完整的选择信息
  return {
    availableEnvironments: environments,
    selectedEnvironment,
    selectedEnvironmentSource,
  }
}
