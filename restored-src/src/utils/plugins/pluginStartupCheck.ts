/**
 * 插件启动检查模块 — Claude Code 插件系统的启动状态核查层
 *
 * 在 Claude Code 插件系统中，此文件负责：
 *   1. 确定哪些插件处于「已启用」状态（checkEnabledPlugins）
 *   2. 追踪各插件归属的可编辑作用域（getPluginEditableScopes，用于写回定位）
 *   3. 查询已安装的插件列表（getInstalledPlugins，含 V1→V2 格式迁移）
 *   4. 找出「已启用但尚未安装」的插件（findMissingPlugins）
 *   5. 批量安装选定插件（installSelectedPlugins，含进度回调和作用域感知写回）
 *
 * 与 pluginIdentifier.ts 的区别：
 *   - pluginIdentifier.ts 负责标识符解析和作用域类型定义
 *   - 本文件负责运行时启动检查和实际的安装调度
 *
 * 作用域优先级（从低到高）：
 *   0. addDir（--add-dir CLI 标志，会话临时）
 *   1. managed（policySettings，只读）
 *   2. user（userSettings）
 *   3. project（projectSettings）
 *   4. local（localSettings）
 *   5. flag（flagSettings，会话临时，不持久化）
 */

import { join } from 'path'
import { getCwd } from '../cwd.js'
import { logForDebugging } from '../debug.js'
import { logError } from '../log.js'
import type { SettingSource } from '../settings/constants.js'
import {
  getInitialSettings,
  getSettingsForSource,
  updateSettingsForSource,
} from '../settings/settings.js'
import { getAddDirEnabledPlugins } from './addDirPluginSettings.js'
import {
  getInMemoryInstalledPlugins,
  migrateFromEnabledPlugins,
} from './installedPluginsManager.js'
import { getPluginById } from './marketplaceManager.js'
import {
  type ExtendedPluginScope,
  type PersistablePluginScope,
  SETTING_SOURCE_TO_SCOPE,
  scopeToSettingSource,
} from './pluginIdentifier.js'
import {
  cacheAndRegisterPlugin,
  registerPluginInstallation,
} from './pluginInstallationHelpers.js'
import { isLocalPluginSource, type PluginScope } from './schemas.js'

/**
 * 检查所有设置源中（含 --add-dir）已启用的插件列表。
 *
 * 这是权威的「此插件是否已启用」检查入口，不应委托给 getPluginEditableScopes()
 * （后者服务于不同目的：写回定位的作用域追踪）。
 *
 * 合并策略：
 *   1. 先收集 --add-dir 启用的插件（最低优先级）
 *   2. 再用合并后的 settings（policy > local > project > user）覆盖：
 *      - value === true  → 未在列表中则添加
 *      - value === false → 从列表中移除（即使 --add-dir 启用了它）
 *
 * @returns 已启用的插件 ID 数组（格式：\"plugin@marketplace\"）
 */
export async function checkEnabledPlugins(): Promise<string[]> {
  // 读取合并后的 settings（policy 优先级最高）
  const settings = getInitialSettings()
  const enabledPlugins: string[] = []

  // 步骤 1：先收集 --add-dir 启用的插件（最低优先级）
  const addDirPlugins = getAddDirEnabledPlugins()
  for (const [pluginId, value] of Object.entries(addDirPlugins)) {
    // 只处理含 '@' 的合法插件 ID
    if (pluginId.includes('@') && value) {
      enabledPlugins.push(pluginId)
    }
  }

  // 步骤 2：用合并后的 settings 覆盖（policy > local > project > user）
  if (settings.enabledPlugins) {
    for (const [pluginId, value] of Object.entries(settings.enabledPlugins)) {
      // 跳过不含 '@' 的非法格式
      if (!pluginId.includes('@')) {
        continue
      }
      const idx = enabledPlugins.indexOf(pluginId)
      if (value) {
        // 启用：若不在列表中则添加
        if (idx === -1) {
          enabledPlugins.push(pluginId)
        }
      } else {
        // 明确禁用：从列表中移除（即使 --add-dir 启用了它）
        if (idx !== -1) {
          enabledPlugins.splice(idx, 1)
        }
      }
    }
  }

  return enabledPlugins
}

/**
 * 获取每个已启用插件归属的用户可编辑作用域映射表。
 *
 * 用途：确定写回目标（用户启用/禁用某插件时，应写入哪个 settings 文件）。
 * 注意：这不是权威的「插件是否启用」检查，请用 checkEnabledPlugins() 代替。
 *
 * 处理顺序（从低到高优先级，后者覆盖前者）：
 *   0. addDir（--add-dir 目录，会话临时，优先级最低）
 *   1. managed（policySettings，不可编辑）
 *   2. user（userSettings）
 *   3. project（projectSettings）
 *   4. local（localSettings）
 *   5. flag（flagSettings，会话临时，不持久化）
 *
 * 为什么 managed 排第一（最低）？因为用户无法编辑它，
 * 作用域应解析为最高的用户可控来源。
 *
 * @returns Map<pluginId, ExtendedPluginScope>，记录每个插件所属的可编辑作用域
 */
export function getPluginEditableScopes(): Map<string, ExtendedPluginScope> {
  const result = new Map<string, ExtendedPluginScope>()

  // 步骤 1：先处理 --add-dir 目录（最低优先级，会被所有标准来源覆盖）
  const addDirPlugins = getAddDirEnabledPlugins()
  for (const [pluginId, value] of Object.entries(addDirPlugins)) {
    // 跳过不含 '@' 的非法格式
    if (!pluginId.includes('@')) {
      continue
    }
    if (value === true) {
      // 'flag' 作用域 = 会话临时，不需要写回
      result.set(pluginId, 'flag')
    } else if (value === false) {
      // 明确禁用：从映射中移除
      result.delete(pluginId)
    }
  }

  // 步骤 2：按优先级从低到高处理各标准来源（后处理的优先级更高）
  const scopeSources: Array<{
    scope: ExtendedPluginScope
    source: SettingSource
  }> = [
    { scope: 'managed', source: 'policySettings' },  // 最低（不可编辑）
    { scope: 'user', source: 'userSettings' },
    { scope: 'project', source: 'projectSettings' },
    { scope: 'local', source: 'localSettings' },
    { scope: 'flag', source: 'flagSettings' },        // 最高（会话临时）
  ]

  for (const { scope, source } of scopeSources) {
    const settings = getSettingsForSource(source)
    // 此来源无 enabledPlugins 配置时跳过
    if (!settings?.enabledPlugins) {
      continue
    }

    for (const [pluginId, value] of Object.entries(settings.enabledPlugins)) {
      // 跳过不含 '@' 的非法格式
      if (!pluginId.includes('@')) {
        continue
      }

      // 标准来源覆盖 --add-dir 时记录日志，便于调试
      if (pluginId in addDirPlugins && addDirPlugins[pluginId] !== value) {
        logForDebugging(
          `Plugin ${pluginId} from --add-dir (${addDirPlugins[pluginId]}) overridden by ${source} (${value})`,
        )
      }

      if (value === true) {
        // 启用：记录此插件归属的作用域（后处理的更高优先级覆盖之前的结果）
        result.set(pluginId, scope)
      } else if (value === false) {
        // 明确禁用：从映射中移除（不再追踪其作用域）
        result.delete(pluginId)
      }
      // 注意：其他值（如未来 P2 阶段的版本字符串）暂时忽略
    }
  }

  logForDebugging(
    `Found ${result.size} enabled plugins with scopes: ${Array.from(
      result.entries(),
    )
      .map(([id, scope]) => `${id}(${scope})`)
      .join(', ')}`,
  )

  return result
}

/**
 * 检查作用域是否为可持久化作用域（非会话临时）。
 *
 * 'flag' 作用域来自 --plugin-dir CLI 标志，仅在会话期间有效，
 * 不应写入 installed_plugins.json。
 *
 * @param scope - 待检查的作用域
 * @returns 若作用域应持久化到 installed_plugins.json 则返回 true
 */
export function isPersistableScope(
  scope: ExtendedPluginScope,
): scope is PersistablePluginScope {
  // 只有 'flag' 是会话临时的，其他所有作用域均可持久化
  return scope !== 'flag'
}

/**
 * 将 SettingSource 转换为对应的插件作用域。
 *
 * 委托给 pluginIdentifier.ts 的 SETTING_SOURCE_TO_SCOPE 映射常量，
 * 此处作为局部工具函数导出，供模块内部调用方使用。
 *
 * @param source - 设置来源
 * @returns 对应的扩展插件作用域
 */
export function settingSourceToScope(
  source: SettingSource,
): ExtendedPluginScope {
  return SETTING_SOURCE_TO_SCOPE[source]
}

/**
 * 获取当前已安装的插件列表。
 *
 * 读取 installed_plugins.json，追踪全局安装状态。
 * 首次调用时自动触发 V1→V2 格式迁移（后台执行，不阻塞启动）。
 *
 * 始终使用 V2 格式并初始化内存会话状态（触发 V1→V2 迁移）。
 * V1→V2 迁移：将 settings.json 中的 enabledPlugins 同步写入 installed_plugins.json。
 *
 * @returns 已安装的插件 ID 数组
 */
export async function getInstalledPlugins(): Promise<string[]> {
  // 在后台触发同步（不等待——不阻塞启动流程）
  // 此同步将 settings.json 中的 enabledPlugins 迁移到 installed_plugins.json
  void migrateFromEnabledPlugins().catch(error => {
    logError(error)
  })

  // 始终使用 V2 格式——初始化内存会话状态，并在需要时触发 V1→V2 迁移
  const v2Data = getInMemoryInstalledPlugins()
  const installed = Object.keys(v2Data.plugins)
  logForDebugging(`Found ${installed.length} installed plugins`)
  return installed
}

/**
 * 找出已启用但尚未安装的插件（需要安装才能使用）。
 *
 * 流程：
 *   1. 获取当前已安装的插件列表
 *   2. 过滤出未安装的插件 ID
 *   3. 并发查询市场，确认这些插件是否存在于某个市场
 *   4. 返回「已启用且在市场中存在」的缺失插件列表
 *
 * 注意：不在任何市场中的插件会被排除在返回列表之外（视为无效插件 ID）。
 *
 * @param enabledPlugins - 已启用的插件 ID 数组
 * @returns 需要安装的缺失插件 ID 数组
 */
export async function findMissingPlugins(
  enabledPlugins: string[],
): Promise<string[]> {
  try {
    const installedPlugins = await getInstalledPlugins()

    // 先同步过滤出未安装的插件，再并发查询市场（保持原始顺序）
    const notInstalled = enabledPlugins.filter(
      id => !installedPlugins.includes(id),
    )
    // 并发查询所有未安装插件是否在市场中存在
    const lookups = await Promise.all(
      notInstalled.map(async pluginId => {
        try {
          const plugin = await getPluginById(pluginId)
          // 插件在市场中存在时才认为是「缺失的」（需要安装）
          return { pluginId, found: plugin !== null && plugin !== undefined }
        } catch (error) {
          logForDebugging(
            `Failed to check plugin ${pluginId} in marketplace: ${error}`,
          )
          // 插件在任何市场中都不存在，将作为错误处理（不列入缺失列表）
          return { pluginId, found: false }
        }
      }),
    )
    // 只保留市场中存在的插件
    const missing = lookups
      .filter(({ found }) => found)
      .map(({ pluginId }) => pluginId)

    return missing
  } catch (error) {
    logError(error)
    return []
  }
}

/**
 * 插件安装操作的结果类型
 */
export type PluginInstallResult = {
  installed: string[]                            // 成功安装的插件 ID 列表
  failed: Array<{ name: string; error: string }> // 安装失败的插件及错误信息
}

/**
 * 可安装的插件作用域类型（排除 'managed'——策略作用域，用户无权安装）
 */
type InstallableScope = Exclude<PluginScope, 'managed'>

/**
 * 批量安装选定的插件，支持进度回调和作用域感知写回。
 *
 * 安装流程（串行，逐个执行）：
 *   1. 从市场查询插件信息（getPluginById）
 *   2. 根据来源类型分流：
 *      - 外部来源（非本地）→ 下载、缓存并注册（cacheAndRegisterPlugin）
 *      - 本地来源 → 直接注册安装路径（registerPluginInstallation）
 *   3. 将插件标记为已启用（updatedEnabledPlugins[pluginId] = true）
 *   4. 安装完成后批量写回对应作用域的 settings 文件
 *
 * 设计说明：
 *   - 串行而非并发：避免并发 git clone 竞争导致的文件系统冲突
 *   - scope 默认为 'user'：用户级别是最常用的安装作用域
 *   - 非 user 作用域需要传入 projectPath（写回 project/local settings）
 *
 * @param pluginsToInstall - 要安装的插件 ID 数组
 * @param onProgress - 可选的进度回调（插件名称、当前序号、总数）
 * @param scope - 安装作用域，默认为 'user'
 * @returns 安装结果（成功列表 + 失败列表）
 */
export async function installSelectedPlugins(
  pluginsToInstall: string[],
  onProgress?: (name: string, index: number, total: number) => void,
  scope: InstallableScope = 'user',
): Promise<PluginInstallResult> {
  // 非 user 作用域需要项目路径（用于写回 project/local settings）
  const projectPath = scope !== 'user' ? getCwd() : undefined

  // 根据安装作用域确定对应的 settings 来源
  const settingSource = scopeToSettingSource(scope)
  const settings = getSettingsForSource(settingSource)
  // 复制当前 enabledPlugins，安装成功后逐步追加
  const updatedEnabledPlugins = { ...settings?.enabledPlugins }
  const installed: string[] = []
  const failed: Array<{ name: string; error: string }> = []

  // 串行安装每个插件（避免并发 git clone 竞争）
  for (let i = 0; i < pluginsToInstall.length; i++) {
    const pluginId = pluginsToInstall[i]
    if (!pluginId) continue

    // 触发进度回调（1-based 序号）
    if (onProgress) {
      onProgress(pluginId, i + 1, pluginsToInstall.length)
    }

    try {
      // 步骤 1：从市场查询插件信息
      const pluginInfo = await getPluginById(pluginId)
      if (!pluginInfo) {
        // 在任何市场中都找不到此插件
        failed.push({
          name: pluginId,
          error: 'Plugin not found in any marketplace',
        })
        continue
      }

      const { entry, marketplaceInstallLocation } = pluginInfo
      if (!isLocalPluginSource(entry.source)) {
        // 步骤 2a：外部来源——下载、缓存并注册（需要 scope 用于安装位置确定）
        await cacheAndRegisterPlugin(pluginId, entry, scope, projectPath)
      } else {
        // 步骤 2b：本地来源——直接注册安装路径，无需下载
        registerPluginInstallation(
          {
            pluginId,
            installPath: join(marketplaceInstallLocation, entry.source),
            version: entry.version,
          },
          scope,
          projectPath,
        )
      }

      // 步骤 3：标记为已启用，待安装循环结束后批量写回
      updatedEnabledPlugins[pluginId] = true
      installed.push(pluginId)
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error)
      failed.push({ name: pluginId, error: errorMessage })
      logError(error)
    }
  }

  // 步骤 4：将新启用的插件批量写回到对应作用域的 settings 文件
  updateSettingsForSource(settingSource, {
    ...settings,
    enabledPlugins: updatedEnabledPlugins,
  })

  return { installed, failed }
}
