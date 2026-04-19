/**
 * 插件核心操作模块（安装、卸载、启用、禁用、更新）
 *
 * 在 Claude Code 系统流程中的位置：
 * 本文件是插件子系统的纯库层，提供不含任何副作用（无 process.exit、无 console 输出）
 * 的核心操作函数，可被 CLI 命令层（pluginCliCommands.ts）和交互式 UI（ManagePlugins.tsx）共同调用。
 * 它位于以下层次结构中：
 *   - 调用方：pluginCliCommands.ts（CLI 入口）、ManagePlugins.tsx（UI 入口）
 *   - 本模块：纯库函数，返回 PluginOperationResult / PluginUpdateResult 对象
 *   - 下层：pluginInstallationHelpers.ts（安装解析）、installedPluginsManager.ts（V2 文件）、
 *           marketplaceManager.ts（市场查询）、settingsManager.ts（配置读写）
 *
 * 主要功能：
 * - VALID_INSTALLABLE_SCOPES / VALID_UPDATE_SCOPES：有效作用域常量
 * - assertInstallableScope / isInstallableScope：运行时作用域校验与类型守卫
 * - installPluginOp：settings-first 安装，搜索物化市场后写设置再缓存
 * - uninstallPluginOp：从设置 + installed_plugins_v2.json 移除，处理最后作用域孤化和选项清除
 * - setPluginEnabledOp：启用/禁用，含作用域解析、策略守卫、幂等检查、反向依赖警告
 * - enablePluginOp / disablePluginOp：setPluginEnabledOp 的语义包装
 * - disableAllPluginsOp：批量禁用所有已启用插件
 * - updatePluginOp / performPluginUpdate：非原地更新（临时下载 → 计算版本 → 复制到版本化缓存 → 更新磁盘记录 → 清理旧版本）
 *
 * 设计说明：
 * - Settings-first：写设置是"意图"，缓存是"物化"；安装时优先写设置，启动时 reconcile 补充市场物化
 * - V2 installed_plugins.json：独立于市场状态追踪各作用域安装记录
 * - 作用域优先级：local > project > user（查找时先查最具体的作用域）
 */

/**
 * Core plugin operations (install, uninstall, enable, disable, update)
 *
 * This module provides pure library functions that can be used by both:
 * - CLI commands (`claude plugin install/uninstall/enable/disable/update`)
 * - Interactive UI (ManagePlugins.tsx)
 *
 * Functions in this module:
 * - Do NOT call process.exit()
 * - Do NOT write to console
 * - Return result objects indicating success/failure with messages
 * - Can throw errors for unexpected failures
 */
import { dirname, join } from 'path'
import { getOriginalCwd } from '../../bootstrap/state.js'
import { isBuiltinPluginId } from '../../plugins/builtinPlugins.js'
import type { LoadedPlugin, PluginManifest } from '../../types/plugin.js'
import { isENOENT, toError } from '../../utils/errors.js'
import { getFsImplementation } from '../../utils/fsOperations.js'
import { logError } from '../../utils/log.js'
import {
  clearAllCaches,
  markPluginVersionOrphaned,
} from '../../utils/plugins/cacheUtils.js'
import {
  findReverseDependents,
  formatReverseDependentsSuffix,
} from '../../utils/plugins/dependencyResolver.js'
import {
  loadInstalledPluginsFromDisk,
  loadInstalledPluginsV2,
  removePluginInstallation,
  updateInstallationPathOnDisk,
} from '../../utils/plugins/installedPluginsManager.js'
import {
  getMarketplace,
  getPluginById,
  loadKnownMarketplacesConfig,
} from '../../utils/plugins/marketplaceManager.js'
import { deletePluginDataDir } from '../../utils/plugins/pluginDirectories.js'
import {
  parsePluginIdentifier,
  scopeToSettingSource,
} from '../../utils/plugins/pluginIdentifier.js'
import {
  formatResolutionError,
  installResolvedPlugin,
} from '../../utils/plugins/pluginInstallationHelpers.js'
import {
  cachePlugin,
  copyPluginToVersionedCache,
  getVersionedCachePath,
  getVersionedZipCachePath,
  loadAllPlugins,
  loadPluginManifest,
} from '../../utils/plugins/pluginLoader.js'
import { deletePluginOptions } from '../../utils/plugins/pluginOptionsStorage.js'
import { isPluginBlockedByPolicy } from '../../utils/plugins/pluginPolicy.js'
import { getPluginEditableScopes } from '../../utils/plugins/pluginStartupCheck.js'
import { calculatePluginVersion } from '../../utils/plugins/pluginVersioning.js'
import type {
  PluginMarketplaceEntry,
  PluginScope,
} from '../../utils/plugins/schemas.js'
import {
  getSettingsForSource,
  updateSettingsForSource,
} from '../../utils/settings/settings.js'
import { plural } from '../../utils/stringUtils.js'

/** 有效可安装作用域（不含 'managed'，该作用域只能通过 managed-settings.json 安装） */
export const VALID_INSTALLABLE_SCOPES = ['user', 'project', 'local'] as const

/** 从 VALID_INSTALLABLE_SCOPES 派生的可安装作用域类型 */
export type InstallableScope = (typeof VALID_INSTALLABLE_SCOPES)[number]

/** 更新操作的有效作用域（包含 'managed'，托管插件也可更新） */
export const VALID_UPDATE_SCOPES: readonly PluginScope[] = [
  'user',
  'project',
  'local',
  'managed',
] as const

/**
 * 运行时断言：验证 scope 是有效的可安装作用域
 *
 * 用于 CLI 入口处的早期参数校验，无效 scope 立即抛出错误。
 *
 * @param scope 要验证的作用域字符串
 * @throws Error 如果 scope 不是有效的可安装作用域
 */
export function assertInstallableScope(
  scope: string,
): asserts scope is InstallableScope {
  if (!VALID_INSTALLABLE_SCOPES.includes(scope as InstallableScope)) {
    throw new Error(
      `Invalid scope "${scope}". Must be one of: ${VALID_INSTALLABLE_SCOPES.join(', ')}`,
    )
  }
}

/**
 * 类型守卫：判断 scope 是否为可安装作用域（排除 'managed'）
 *
 * 用于条件分支中的类型收窄，区分可通过 CLI 操作的作用域和托管作用域。
 */
export function isInstallableScope(
  scope: PluginScope,
): scope is InstallableScope {
  return VALID_INSTALLABLE_SCOPES.includes(scope as InstallableScope)
}

/**
 * 获取项目特定作用域对应的项目路径
 *
 * 'project' 和 'local' 作用域需要项目路径（用于多项目环境区分安装位置），
 * 'user' 和 'managed' 作用域不需要项目路径（全局作用域）。
 */
export function getProjectPathForScope(scope: PluginScope): string | undefined {
  return scope === 'project' || scope === 'local' ? getOriginalCwd() : undefined
}

/**
 * 检查插件是否在 .claude/settings.json（project scope）中被启用
 *
 * 与 V2 installed_plugins.json 的作用域不同：V2 文件追踪安装位置，
 * settings.json 追踪启用意图。同一插件可在 user scope 安装但在 project scope 启用。
 * 卸载 UI 需要检查此值，因为即使 user-scope 安装被移除，project-scope 的启用配置
 * 仍会导致插件继续运行。
 */
export function isPluginEnabledAtProjectScope(pluginId: string): boolean {
  return (
    getSettingsForSource('projectSettings')?.enabledPlugins?.[pluginId] === true
  )
}

// ============================================================================
// 结果类型定义
// ============================================================================

/**
 * 插件操作结果类型
 *
 * 所有操作函数（安装、卸载、启用、禁用）均返回此类型，
 * 调用方通过 result.success 判断操作是否成功，
 * result.message 包含用户友好的操作结果描述。
 */
export type PluginOperationResult = {
  success: boolean
  message: string
  pluginId?: string
  pluginName?: string
  scope?: PluginScope
  /** 声明当前插件为依赖的其他插件列表（卸载/禁用时作为警告） */
  reverseDependents?: string[]
}

/**
 * 插件更新操作结果类型
 *
 * 更新操作额外包含版本信息（oldVersion/newVersion）和
 * alreadyUpToDate 标志（避免不必要的重新缓存）。
 */
export type PluginUpdateResult = {
  success: boolean
  message: string
  pluginId?: string
  newVersion?: string
  oldVersion?: string
  alreadyUpToDate?: boolean
  scope?: PluginScope
}

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 在所有可编辑的设置作用域中搜索匹配给定输入的插件 ID
 *
 * 搜索策略：
 * - 若 plugin 包含 '@'，视为完整 pluginId，在各作用域直接匹配
 * - 若 plugin 是裸名称，搜索以 "{plugin}@" 开头的键
 *
 * 作用域优先级（最具体优先）：local > project > user，第一个匹配即返回。
 *
 * @param plugin 插件标识符（完整 pluginId 或裸名称）
 * @returns 包含 pluginId 和 scope 的对象，未找到时返回 null
 */
function findPluginInSettings(plugin: string): {
  pluginId: string
  scope: InstallableScope
} | null {
  const hasMarketplace = plugin.includes('@')
  // 作用域搜索顺序：最具体的 local 优先，第一个匹配即返回
  const searchOrder: InstallableScope[] = ['local', 'project', 'user']

  for (const scope of searchOrder) {
    const enabledPlugins = getSettingsForSource(
      scopeToSettingSource(scope),
    )?.enabledPlugins
    if (!enabledPlugins) continue

    for (const key of Object.keys(enabledPlugins)) {
      // 完整 pluginId：精确匹配；裸名称：前缀匹配 "name@"
      if (hasMarketplace ? key === plugin : key.startsWith(`${plugin}@`)) {
        return { pluginId: key, scope }
      }
    }
  }
  return null
}

/**
 * 从已加载插件列表中按标识符查找插件
 *
 * 支持以下匹配方式：
 * 1. 精确名称匹配（p.name === plugin 或 p.name === name）
 * 2. 含市场名时，检查插件 source 字段是否包含 "@{marketplace}"
 *
 * @param plugin 插件标识符（支持带或不带市场名）
 * @param plugins 已加载插件列表
 * @returns 匹配的插件对象，未找到时返回 undefined
 */
function findPluginByIdentifier(
  plugin: string,
  plugins: LoadedPlugin[],
): LoadedPlugin | undefined {
  const { name, marketplace } = parsePluginIdentifier(plugin)

  return plugins.find(p => {
    // 精确名称匹配
    if (p.name === plugin || p.name === name) return true

    // 若指定了市场名，检查插件 source 字段
    if (marketplace && p.source) {
      return p.name === name && p.source.includes(`@${marketplace}`)
    }

    return false
  })
}

/**
 * 从 V2 已安装插件数据中解析可能已从市场下架的插件 ID
 *
 * 当插件从市场下架后，loadAllPlugins 无法找到它，但 installed_plugins_v2.json
 * 中仍有安装记录。此函数通过 V2 数据恢复插件 ID，支持卸载已下架的插件。
 *
 * @param plugin 插件标识符
 * @returns 包含 pluginId 和 pluginName 的对象，未找到时返回 null
 */
function resolveDelistedPluginId(
  plugin: string,
): { pluginId: string; pluginName: string } | null {
  const { name } = parsePluginIdentifier(plugin)
  const installedData = loadInstalledPluginsV2()

  // 先尝试精确匹配，再按名称搜索
  if (installedData.plugins[plugin]?.length) {
    return { pluginId: plugin, pluginName: name }
  }

  const matchingKey = Object.keys(installedData.plugins).find(key => {
    const { name: keyName } = parsePluginIdentifier(key)
    return keyName === name && (installedData.plugins[key]?.length ?? 0) > 0
  })

  if (matchingKey) {
    return { pluginId: matchingKey, pluginName: name }
  }

  return null
}

/**
 * 从 V2 数据中获取插件最相关的安装记录
 *
 * 优先级：local（当前项目）> project（当前项目）> user > 第一条记录（可能是 managed）
 * 对于项目/本地作用域的插件，优先匹配当前项目路径的安装记录。
 *
 * @param pluginId 完整插件 ID
 * @returns 包含 scope 和可选 projectPath 的对象
 */
export function getPluginInstallationFromV2(pluginId: string): {
  scope: PluginScope
  projectPath?: string
} {
  const installedData = loadInstalledPluginsV2()
  const installations = installedData.plugins[pluginId]

  if (!installations || installations.length === 0) {
    return { scope: 'user' }
  }

  const currentProjectPath = getOriginalCwd()

  // 按优先级依次查找：local > project > user > managed
  const localInstall = installations.find(
    inst => inst.scope === 'local' && inst.projectPath === currentProjectPath,
  )
  if (localInstall) {
    return { scope: localInstall.scope, projectPath: localInstall.projectPath }
  }

  const projectInstall = installations.find(
    inst => inst.scope === 'project' && inst.projectPath === currentProjectPath,
  )
  if (projectInstall) {
    return {
      scope: projectInstall.scope,
      projectPath: projectInstall.projectPath,
    }
  }

  const userInstall = installations.find(inst => inst.scope === 'user')
  if (userInstall) {
    return { scope: userInstall.scope }
  }

  // 回退到第一条安装记录（可能是 managed 作用域）
  return {
    scope: installations[0]!.scope,
    projectPath: installations[0]!.projectPath,
  }
}

// ============================================================================
// 核心操作函数
// ============================================================================

/**
 * 安装插件（settings-first 模式）
 *
 * 操作顺序：
 * 1. 在物化市场（已克隆到本地的市场）中搜索插件
 * 2. 写入设置（"意图"声明）
 * 3. 缓存插件 + 记录版本提示（"物化"）
 *
 * 注意：市场 reconcile 不是本函数的职责，由启动时的后台 reconcile 处理。
 * 若市场未找到，直接返回"找不到"错误。
 *
 * @param plugin 插件标识符（名称或 plugin@marketplace）
 * @param scope 安装作用域：user、project 或 local（默认 'user'）
 * @returns 操作结果对象
 */
export async function installPluginOp(
  plugin: string,
  scope: InstallableScope = 'user',
): Promise<PluginOperationResult> {
  // 运行时验证作用域（早期错误检测）
  assertInstallableScope(scope)

  const { name: pluginName, marketplace: marketplaceName } =
    parsePluginIdentifier(plugin)

  // ── 在物化市场中搜索插件 ──
  let foundPlugin: PluginMarketplaceEntry | undefined
  let foundMarketplace: string | undefined
  let marketplaceInstallLocation: string | undefined

  if (marketplaceName) {
    // 指定了市场名：直接在该市场查找
    const pluginInfo = await getPluginById(plugin)
    if (pluginInfo) {
      foundPlugin = pluginInfo.entry
      foundMarketplace = marketplaceName
      marketplaceInstallLocation = pluginInfo.marketplaceInstallLocation
    }
  } else {
    // 未指定市场：遍历所有已知市场查找
    const marketplaces = await loadKnownMarketplacesConfig()
    for (const [mktName, mktConfig] of Object.entries(marketplaces)) {
      try {
        const marketplace = await getMarketplace(mktName)
        const pluginEntry = marketplace.plugins.find(p => p.name === pluginName)
        if (pluginEntry) {
          foundPlugin = pluginEntry
          foundMarketplace = mktName
          marketplaceInstallLocation = mktConfig.installLocation
          break
        }
      } catch (error) {
        // 单个市场加载失败不影响其他市场的搜索
        logError(toError(error))
        continue
      }
    }
  }

  if (!foundPlugin || !foundMarketplace) {
    // 插件未找到：根据是否指定了市场名提供不同的错误描述
    const location = marketplaceName
      ? `marketplace "${marketplaceName}"`
      : 'any configured marketplace'
    return {
      success: false,
      message: `Plugin "${pluginName}" not found in ${location}`,
    }
  }

  const entry = foundPlugin
  // 构建完整 pluginId：name@marketplace
  const pluginId = `${entry.name}@${foundMarketplace}`

  // 调用安装辅助函数：写设置 + 缓存（含策略检查、依赖处理等）
  const result = await installResolvedPlugin({
    pluginId,
    entry,
    scope,
    marketplaceInstallLocation,
  })

  if (!result.ok) {
    // 安装失败：将内部错误原因映射为用户友好的错误消息
    switch (result.reason) {
      case 'local-source-no-location':
        return {
          success: false,
          message: `Cannot install local plugin "${result.pluginName}" without marketplace install location`,
        }
      case 'settings-write-failed':
        return {
          success: false,
          message: `Failed to update settings: ${result.message}`,
        }
      case 'resolution-failed':
        return {
          success: false,
          message: formatResolutionError(result.resolution),
        }
      case 'blocked-by-policy':
        return {
          success: false,
          message: `Plugin "${result.pluginName}" is blocked by your organization's policy and cannot be installed`,
        }
      case 'dependency-blocked-by-policy':
        return {
          success: false,
          message: `Plugin "${result.pluginName}" depends on "${result.blockedDependency}", which is blocked by your organization's policy`,
        }
    }
  }

  // 安装成功：返回含 pluginId、pluginName、scope 的结果对象
  return {
    success: true,
    message: `Successfully installed plugin: ${pluginId} (scope: ${scope})${result.depNote}`,
    pluginId,
    pluginName: entry.name,
    scope,
  }
}

/**
 * 卸载插件
 *
 * 完整流程：
 * 1. 加载所有已启用/禁用插件，查找目标插件（支持下架插件的回退查找）
 * 2. 验证目标作用域中确实存在该安装记录
 * 3. 从设置文件中删除 enabledPlugins[pluginId]（undefined 信号触发删除）
 * 4. 清除所有缓存
 * 5. 从 installed_plugins_v2.json 中移除该作用域的安装记录
 * 6. 若是最后一个作用域：标记插件版本为孤化、删除插件选项和数据目录
 * 7. 返回含反向依赖警告的结果
 *
 * @param plugin 插件名称或 plugin@marketplace 标识符
 * @param scope 卸载作用域（默认 'user'）
 * @param deleteDataDir 是否删除插件数据目录（默认 true）
 * @returns 操作结果对象
 */
export async function uninstallPluginOp(
  plugin: string,
  scope: InstallableScope = 'user',
  deleteDataDir = true,
): Promise<PluginOperationResult> {
  // 运行时验证作用域（早期错误检测）
  assertInstallableScope(scope)

  const { enabled, disabled } = await loadAllPlugins()
  const allPlugins = [...enabled, ...disabled]

  // 在已加载插件中查找目标插件
  const foundPlugin = findPluginByIdentifier(plugin, allPlugins)

  const settingSource = scopeToSettingSource(scope)
  const settings = getSettingsForSource(settingSource)

  let pluginId: string
  let pluginName: string

  if (foundPlugin) {
    // 从设置键中查找与插件匹配的完整 pluginId（用户可能使用短名称）
    pluginId =
      Object.keys(settings?.enabledPlugins ?? {}).find(
        k =>
          k === plugin ||
          k === foundPlugin.name ||
          k.startsWith(`${foundPlugin.name}@`),
      ) ?? (plugin.includes('@') ? plugin : foundPlugin.name)
    pluginName = foundPlugin.name
  } else {
    // 插件未在市场找到（可能已下架）：回退到 V2 安装记录
    const resolved = resolveDelistedPluginId(plugin)
    if (!resolved) {
      return {
        success: false,
        message: `Plugin "${plugin}" not found in installed plugins`,
      }
    }
    pluginId = resolved.pluginId
    pluginName = resolved.pluginName
  }

  // 在 V2 文件中验证该作用域确实存在安装记录
  const projectPath = getProjectPathForScope(scope)
  const installedData = loadInstalledPluginsV2()
  const installations = installedData.plugins[pluginId]
  const scopeInstallation = installations?.find(
    i => i.scope === scope && i.projectPath === projectPath,
  )

  if (!scopeInstallation) {
    // 安装记录不在此作用域：提供友好的错误提示，指引用户使用正确的作用域
    const { scope: actualScope } = getPluginInstallationFromV2(pluginId)
    if (actualScope !== scope && installations && installations.length > 0) {
      // project 作用域特殊处理：.claude/settings.json 是团队共享文件，
      // 指引用户使用 local 作用域的本地覆盖机制
      if (actualScope === 'project') {
        return {
          success: false,
          message: `Plugin "${plugin}" is enabled at project scope (.claude/settings.json, shared with your team). To disable just for you: claude plugin disable ${plugin} --scope local`,
        }
      }
      return {
        success: false,
        message: `Plugin "${plugin}" is installed in ${actualScope} scope, not ${scope}. Use --scope ${actualScope} to uninstall.`,
      }
    }
    return {
      success: false,
      message: `Plugin "${plugin}" is not installed in ${scope} scope. Use --scope to specify the correct scope.`,
    }
  }

  const installPath = scopeInstallation.installPath

  // 从设置文件中删除插件（设置 undefined 触发 mergeWith 中的删除逻辑）
  const newEnabledPlugins: Record<string, boolean | string[] | undefined> = {
    ...settings?.enabledPlugins,
  }
  newEnabledPlugins[pluginId] = undefined
  updateSettingsForSource(settingSource, {
    enabledPlugins: newEnabledPlugins,
  })

  // 清除所有内存缓存（确保后续加载反映最新配置）
  clearAllCaches()

  // 从 V2 文件中移除该作用域的安装记录
  removePluginInstallation(pluginId, scope, projectPath)

  // 检查是否是最后一个作用域（决定是否清理版本缓存和选项）
  const updatedData = loadInstalledPluginsV2()
  const remainingInstallations = updatedData.plugins[pluginId]
  const isLastScope =
    !remainingInstallations || remainingInstallations.length === 0
  if (isLastScope && installPath) {
    // 最后一个作用域且有安装路径：标记该版本为孤化（等待 GC 清理）
    await markPluginVersionOrphaned(installPath)
  }
  // 最后一个作用域移除后：清理插件选项和密钥（不需要 installPath）
  // 注意：deletePluginOptions 在无存储数据时为空操作，因此无需特性开关
  if (isLastScope) {
    deletePluginOptions(pluginId)
    if (deleteDataDir) {
      await deletePluginDataDir(pluginId)
    }
  }

  // 获取反向依赖（依赖此插件的其他插件），作为警告而不是阻塞
  // 阻塞会导致「墓碑」问题：无法拆除含已下架插件的依赖图
  const reverseDependents = findReverseDependents(pluginId, allPlugins)
  const depWarn = formatReverseDependentsSuffix(reverseDependents)

  return {
    success: true,
    message: `Successfully uninstalled plugin: ${pluginName} (scope: ${scope})${depWarn}`,
    pluginId,
    pluginName,
    scope,
    reverseDependents:
      reverseDependents.length > 0 ? reverseDependents : undefined,
  }
}

/**
 * 设置插件启用/禁用状态（settings-first 模式）
 *
 * 此函数是 enablePluginOp 和 disablePluginOp 的共同实现。
 * 从设置中解析插件 ID 和作用域，不预先检查 installed_plugins.json。
 * 设置声明意图；若插件尚未缓存，下次加载时会自动缓存。
 *
 * 完整流程：
 * 1. 内置插件：直接使用 user-scope 设置，跳过普通流程
 * 2. 解析 pluginId 和作用域（显式指定 or 自动检测 or 默认 user）
 * 3. 策略守卫：组织策略阻止的插件不能被启用
 * 4. 跨作用域提示：指定了错误作用域时，指引用户使用正确的 --scope
 * 5. 幂等检查：已是目标状态时直接返回"已是..."消息
 * 6. 禁用前：捕获反向依赖快照（写设置前捕获，避免缓存清除后丢失）
 * 7. 写设置（ACTION：enabledPlugins[pluginId] = enabled）
 * 8. clearAllCaches → 返回结果（含反向依赖警告）
 *
 * @param plugin 插件名称或 plugin@marketplace 标识符
 * @param enabled true 为启用，false 为禁用
 * @param scope 可选作用域。未提供时自动检测最具体的作用域
 * @returns 操作结果对象
 */
export async function setPluginEnabledOp(
  plugin: string,
  enabled: boolean,
  scope?: InstallableScope,
): Promise<PluginOperationResult> {
  const operation = enabled ? 'enable' : 'disable'

  // 内置插件特殊处理：始终使用 user-scope 设置，跳过市场查找和安装记录检查
  if (isBuiltinPluginId(plugin)) {
    const { error } = updateSettingsForSource('userSettings', {
      enabledPlugins: {
        ...getSettingsForSource('userSettings')?.enabledPlugins,
        [plugin]: enabled,
      },
    })
    if (error) {
      return {
        success: false,
        message: `Failed to ${operation} built-in plugin: ${error.message}`,
      }
    }
    clearAllCaches()
    const { name: pluginName } = parsePluginIdentifier(plugin)
    return {
      success: true,
      message: `Successfully ${operation}d built-in plugin: ${pluginName}`,
      pluginId: plugin,
      pluginName,
      scope: 'user',
    }
  }

  if (scope) {
    assertInstallableScope(scope)
  }

  // ── 从设置中解析 pluginId 和作用域 ──
  // 搜索所有可编辑作用域中对该插件的任意提及（无论启用/禁用状态）
  // 不预先检查 installed_plugins.json（settings-first 模式）
  let pluginId: string
  let resolvedScope: InstallableScope

  const found = findPluginInSettings(plugin)

  if (scope) {
    // 显式作用域：使用指定作用域，从设置中解析 pluginId（若可能）
    resolvedScope = scope
    if (found) {
      pluginId = found.pluginId
    } else if (plugin.includes('@')) {
      // 未在设置中找到但提供了完整 pluginId：直接使用
      pluginId = plugin
    } else {
      return {
        success: false,
        message: `Plugin "${plugin}" not found in settings. Use plugin@marketplace format.`,
      }
    }
  } else if (found) {
    // 自动检测作用域：使用设置中最具体的作用域（local > project > user）
    pluginId = found.pluginId
    resolvedScope = found.scope
  } else if (plugin.includes('@')) {
    // 未在任何作用域设置中找到，但提供了完整 pluginId：默认 user 作用域
    // 这允许启用已缓存但从未声明的插件
    pluginId = plugin
    resolvedScope = 'user'
  } else {
    return {
      success: false,
      message: `Plugin "${plugin}" not found in any editable settings scope. Use plugin@marketplace format.`,
    }
  }

  // ── 策略守卫 ──
  // 组织阻止的插件不能在任何作用域被启用
  // 在 pluginId 解析后检查，以捕获完整标识符和裸名称两种情况
  if (enabled && isPluginBlockedByPolicy(pluginId)) {
    return {
      success: false,
      message: `Plugin "${pluginId}" is blocked by your organization's policy and cannot be enabled`,
    }
  }

  const settingSource = scopeToSettingSource(resolvedScope)
  const scopeSettingsValue =
    getSettingsForSource(settingSource)?.enabledPlugins?.[pluginId]

  // ── 跨作用域提示：指定了作用域但插件在其他作用域 ──
  // 若插件不在请求的作用域但在其他作用域，指引用户使用 --scope 正确参数
  // 例外：允许写入更高优先级的作用域来覆盖低优先级的设置
  //（如 "disable --scope local" 覆盖 project-enabled 插件，无需修改共享的 .claude/settings.json）
  const SCOPE_PRECEDENCE: Record<InstallableScope, number> = {
    user: 0,
    project: 1,
    local: 2,
  }
  const isOverride =
    scope && found && SCOPE_PRECEDENCE[scope] > SCOPE_PRECEDENCE[found.scope]
  if (
    scope &&
    scopeSettingsValue === undefined &&
    found &&
    found.scope !== scope &&
    !isOverride
  ) {
    return {
      success: false,
      message: `Plugin "${plugin}" is installed at ${found.scope} scope, not ${scope}. Use --scope ${found.scope} or omit --scope to auto-detect.`,
    }
  }

  // ── 幂等检查（避免重复操作的用户友好提示）──
  // 显式作用域（非覆盖）：直接检查该作用域的设置值
  // 自动检测或覆盖：使用合并的有效状态（getPluginEditableScopes 反映实际启用状态）
  // 覆盖场景的特殊处理：scopeSettingsValue 为 undefined（插件不在此作用域），
  // 读作"已禁用"会导致覆盖操作被误判为幂等，需用合并状态
  const isCurrentlyEnabled =
    scope && !isOverride
      ? scopeSettingsValue === true
      : getPluginEditableScopes().has(pluginId)
  if (enabled === isCurrentlyEnabled) {
    return {
      success: false,
      message: `Plugin "${plugin}" is already ${enabled ? 'enabled' : 'disabled'}${scope ? ` at ${scope} scope` : ''}`,
    }
  }

  // 禁用操作前：从预禁用快照捕获反向依赖（写设置会清除记忆化插件缓存）
  let reverseDependents: string[] | undefined
  if (!enabled) {
    const { enabled: loadedEnabled, disabled } = await loadAllPlugins()
    const rdeps = findReverseDependents(pluginId, [
      ...loadedEnabled,
      ...disabled,
    ])
    if (rdeps.length > 0) reverseDependents = rdeps
  }

  // ── ACTION：写设置 ──
  // 设置 enabledPlugins[pluginId] = enabled（true/false）
  const { error } = updateSettingsForSource(settingSource, {
    enabledPlugins: {
      ...getSettingsForSource(settingSource)?.enabledPlugins,
      [pluginId]: enabled,
    },
  })
  if (error) {
    return {
      success: false,
      message: `Failed to ${operation} plugin: ${error.message}`,
    }
  }

  // 清除所有缓存，确保后续加载反映最新配置
  clearAllCaches()

  const { name: pluginName } = parsePluginIdentifier(pluginId)
  const depWarn = formatReverseDependentsSuffix(reverseDependents)
  return {
    success: true,
    message: `Successfully ${operation}d plugin: ${pluginName} (scope: ${resolvedScope})${depWarn}`,
    pluginId,
    pluginName,
    scope: resolvedScope,
    reverseDependents,
  }
}

/**
 * 启用插件
 *
 * setPluginEnabledOp(plugin, true, scope) 的语义包装，
 * 参数和返回值与 setPluginEnabledOp 完全一致。
 *
 * @param plugin 插件名称或 plugin@marketplace 标识符
 * @param scope 可选作用域（未提供时自动检测最具体的作用域）
 * @returns 操作结果对象
 */
export async function enablePluginOp(
  plugin: string,
  scope?: InstallableScope,
): Promise<PluginOperationResult> {
  return setPluginEnabledOp(plugin, true, scope)
}

/**
 * 禁用插件
 *
 * setPluginEnabledOp(plugin, false, scope) 的语义包装，
 * 参数和返回值与 setPluginEnabledOp 完全一致。
 *
 * @param plugin 插件名称或 plugin@marketplace 标识符
 * @param scope 可选作用域（未提供时自动检测最具体的作用域）
 * @returns 操作结果对象
 */
export async function disablePluginOp(
  plugin: string,
  scope?: InstallableScope,
): Promise<PluginOperationResult> {
  return setPluginEnabledOp(plugin, false, scope)
}

/**
 * 禁用所有已启用插件
 *
 * 遍历 getPluginEditableScopes() 返回的所有已启用插件，
 * 逐个调用 setPluginEnabledOp(pluginId, false) 禁用。
 * 部分失败时收集错误消息，最终返回统计结果（成功数 + 失败详情）。
 *
 * @returns 操作结果对象（含成功禁用数量和失败列表）
 */
export async function disableAllPluginsOp(): Promise<PluginOperationResult> {
  const enabledPlugins = getPluginEditableScopes()

  if (enabledPlugins.size === 0) {
    return { success: true, message: 'No enabled plugins to disable' }
  }

  const disabled: string[] = []
  const errors: string[] = []

  for (const [pluginId] of enabledPlugins) {
    const result = await setPluginEnabledOp(pluginId, false)
    if (result.success) {
      disabled.push(pluginId)
    } else {
      errors.push(`${pluginId}: ${result.message}`)
    }
  }

  if (errors.length > 0) {
    return {
      success: false,
      message: `Disabled ${disabled.length} ${plural(disabled.length, 'plugin')}, ${errors.length} failed:\n${errors.join('\n')}`,
    }
  }

  return {
    success: true,
    message: `Disabled ${disabled.length} ${plural(disabled.length, 'plugin')}`,
  }
}

/**
 * 更新插件到最新版本
 *
 * 此函数执行非原地（NON-INPLACE）更新：
 * 1. 从市场获取插件信息
 * 2. 远程插件：下载到临时目录后计算版本
 * 3. 本地插件：从市场 source 路径计算版本
 * 4. 若版本与当前不同：复制到新的版本化缓存目录
 * 5. 更新 V2 文件中的安装记录（内存中不变，重启后生效）
 * 6. 若旧版本不再被任何安装引用：标记为孤化
 *
 * 与安装/卸载/启用/禁用不同，此函数允许 managed 作用域。
 *
 * @param plugin 插件名称或 plugin@marketplace 标识符
 * @param scope 要更新的作用域（含 managed）
 * @returns 更新结果对象（含版本信息）
 */
export async function updatePluginOp(
  plugin: string,
  scope: PluginScope,
): Promise<PluginUpdateResult> {
  // 解析插件标识符，构建完整 pluginId
  const { name: pluginName, marketplace: marketplaceName } =
    parsePluginIdentifier(plugin)
  const pluginId = marketplaceName ? `${pluginName}@${marketplaceName}` : plugin

  // 从市场获取插件信息（含 entry 和 marketplaceInstallLocation）
  const pluginInfo = await getPluginById(plugin)
  if (!pluginInfo) {
    return {
      success: false,
      message: `Plugin "${pluginName}" not found`,
      pluginId,
      scope,
    }
  }

  const { entry, marketplaceInstallLocation } = pluginInfo

  // 从磁盘加载安装记录（不使用内存缓存，确保读取最新状态）
  const diskData = loadInstalledPluginsFromDisk()
  const installations = diskData.plugins[pluginId]

  if (!installations || installations.length === 0) {
    return {
      success: false,
      message: `Plugin "${pluginName}" is not installed`,
      pluginId,
      scope,
    }
  }

  // 根据 scope 确定 projectPath（local/project 作用域需要项目路径）
  const projectPath = getProjectPathForScope(scope)

  // 在安装列表中查找目标作用域的安装记录
  const installation = installations.find(
    inst => inst.scope === scope && inst.projectPath === projectPath,
  )
  if (!installation) {
    const scopeDesc = projectPath ? `${scope} (${projectPath})` : scope
    return {
      success: false,
      message: `Plugin "${pluginName}" is not installed at scope ${scopeDesc}`,
      pluginId,
      scope,
    }
  }

  // 执行实际的更新操作（下载/版本计算/复制/磁盘更新）
  return performPluginUpdate({
    pluginId,
    pluginName,
    entry,
    marketplaceInstallLocation,
    installation,
    scope,
    projectPath,
  })
}

/**
 * 执行插件的实际更新操作（从 updatePluginOp 中提取的核心更新逻辑）
 *
 * 完整流程：
 * 1. 远程插件：cachePlugin 下载到临时目录（含 gitCommitSha），计算新版本号
 * 2. 本地插件：stat 验证 marketplaceInstallLocation 和 sourcePath 存在，加载 manifest，计算新版本号
 * 3. 版本比较：安装路径已是新版本 → 返回 alreadyUpToDate: true
 * 4. copyPluginToVersionedCache：将源目录复制到版本化缓存（返回实际路径，可能是 .zip）
 * 5. updateInstallationPathOnDisk：更新 V2 文件中的安装路径和版本号（内存不变）
 * 6. 检查旧版本是否还被其他安装引用，若不是则标记为孤化
 * 7. finally 块：清理临时下载目录（远程插件）
 */
async function performPluginUpdate({
  pluginId,
  pluginName,
  entry,
  marketplaceInstallLocation,
  installation,
  scope,
  projectPath,
}: {
  pluginId: string
  pluginName: string
  entry: PluginMarketplaceEntry
  marketplaceInstallLocation: string
  installation: { version?: string; installPath: string }
  scope: PluginScope
  projectPath: string | undefined
}): Promise<PluginUpdateResult> {
  const fs = getFsImplementation()
  const oldVersion = installation.version

  let sourcePath: string
  let newVersion: string
  let shouldCleanupSource = false
  let gitCommitSha: string | undefined

  // 根据插件类型（远程 vs 本地）选择不同的版本获取策略
  if (typeof entry.source !== 'string') {
    // 远程插件：先下载到临时目录，再计算版本
    const cacheResult = await cachePlugin(entry.source, {
      manifest: { name: entry.name },
    })
    sourcePath = cacheResult.path
    shouldCleanupSource = true
    gitCommitSha = cacheResult.gitCommitSha

    // 计算版本：对于 git-subdir source，cachePlugin 在提取子目录前捕获了 commit SHA，
    // 因为提取后的子目录没有 .git，基于 installPath 的回退无法恢复 SHA
    newVersion = await calculatePluginVersion(
      pluginId,
      entry.source,
      cacheResult.manifest,
      cacheResult.path,
      entry.version,
      cacheResult.gitCommitSha,
    )
  } else {
    // 本地插件：使用市场安装路径下的源目录
    // 直接 stat 检查，避免预检存在性（TOCTOU 问题可忽略）
    let marketplaceStats
    try {
      marketplaceStats = await fs.stat(marketplaceInstallLocation)
    } catch (e: unknown) {
      if (isENOENT(e)) {
        return {
          success: false,
          message: `Marketplace directory not found at ${marketplaceInstallLocation}`,
          pluginId,
          scope,
        }
      }
      throw e
    }
    // 若 installLocation 是文件（如 plugins.json），取其父目录作为市场目录
    const marketplaceDir = marketplaceStats.isDirectory()
      ? marketplaceInstallLocation
      : dirname(marketplaceInstallLocation)
    sourcePath = join(marketplaceDir, entry.source)

    // 验证 sourcePath 存在（必须验证，否则两种下游操作都会静默失败）：
    // 1. calculatePluginVersion 会沿目录树向上找 .git，可能误用市场 SHA → 误报 alreadyUpToDate
    // 2. copyPluginToVersionedCache 版本不同时会直接抛出 ENOENT，无友好错误
    try {
      await fs.stat(sourcePath)
    } catch (e: unknown) {
      if (isENOENT(e)) {
        return {
          success: false,
          message: `Plugin source not found at ${sourcePath}`,
          pluginId,
          scope,
        }
      }
      throw e
    }

    // 尝试从插件目录加载 manifest（用于版本信息）
    let pluginManifest: PluginManifest | undefined
    const manifestPath = join(sourcePath, '.claude-plugin', 'plugin.json')
    try {
      pluginManifest = await loadPluginManifest(
        manifestPath,
        entry.name,
        entry.source,
      )
    } catch {
      // 加载失败时使用其他版本来源（git SHA 或 entry.version）
    }

    // 从本地源路径计算版本（基于 manifest 版本或 git SHA）
    newVersion = await calculatePluginVersion(
      pluginId,
      entry.source,
      pluginManifest,
      sourcePath,
      entry.version,
    )
  }

  // 使用 try/finally 确保临时目录在任何情况下都被清理
  try {
    // 检查此版本是否已在缓存中存在
    let versionedPath = getVersionedCachePath(pluginId, newVersion)

    // 判断当前安装是否已是最新版本（三种等价判断：版本号相同、目录路径相同、zip 路径相同）
    const zipPath = getVersionedZipCachePath(pluginId, newVersion)
    const isUpToDate =
      installation.version === newVersion ||
      installation.installPath === versionedPath ||
      installation.installPath === zipPath
    if (isUpToDate) {
      return {
        success: true,
        message: `${pluginName} is already at the latest version (${newVersion}).`,
        pluginId,
        newVersion,
        oldVersion,
        alreadyUpToDate: true,
        scope,
      }
    }

    // 将源目录复制到版本化缓存（返回实际路径，可能是 .zip 格式）
    versionedPath = await copyPluginToVersionedCache(
      sourcePath,
      pluginId,
      newVersion,
      entry,
    )

    // 保存旧版本路径，用于后续孤化检查
    const oldVersionPath = installation.installPath

    // 更新 V2 文件中的安装路径和版本号（内存中不变，重启后生效）
    updateInstallationPathOnDisk(
      pluginId,
      scope,
      projectPath,
      versionedPath,
      newVersion,
      gitCommitSha,
    )

    // 检查旧版本是否还被其他安装引用，若无引用则标记为孤化
    if (oldVersionPath && oldVersionPath !== versionedPath) {
      const updatedDiskData = loadInstalledPluginsFromDisk()
      const isOldVersionStillReferenced = Object.values(
        updatedDiskData.plugins,
      ).some(pluginInstallations =>
        pluginInstallations.some(inst => inst.installPath === oldVersionPath),
      )

      if (!isOldVersionStillReferenced) {
        await markPluginVersionOrphaned(oldVersionPath)
      }
    }

    const scopeDesc = projectPath ? `${scope} (${projectPath})` : scope
    const message = `Plugin "${pluginName}" updated from ${oldVersion || 'unknown'} to ${newVersion} for scope ${scopeDesc}. Restart to apply changes.`

    return {
      success: true,
      message,
      pluginId,
      newVersion,
      oldVersion,
      scope,
    }
  } finally {
    // 清理临时下载目录（仅远程插件需要，且路径不与版本化缓存路径相同时）
    if (
      shouldCleanupSource &&
      sourcePath !== getVersionedCachePath(pluginId, newVersion)
    ) {
      await fs.rm(sourcePath, { recursive: true, force: true })
    }
  }
}
