/**
 * 插件安装辅助函数模块 — Claude Code 插件系统的安装调度层
 *
 * 在 Claude Code 插件系统中，此文件封装了插件安装流程中的公共操作，
 * 被 CLI 路径（installPluginOp）和交互式 UI 路径（installPluginFromMarketplace）共用：
 *
 *   市场条目（PluginMarketplaceEntry）
 *     → installResolvedPlugin（核心安装逻辑）
 *       → 策略检查 → 依赖闭包解析 → settings 写回 → 缓存物化 → 清空缓存
 *     → installPluginFromMarketplace（UI 包装：错误捕获 + 遥测 + 消息格式化）
 *
 * 关键职责：
 *   - validatePathWithinBase：防止路径遍历攻击
 *   - cacheAndRegisterPlugin：下载/复制到版本化缓存路径，并注册到 installed_plugins.json
 *   - registerPluginInstallation：仅注册，不下载（本地来源插件）
 *   - parsePluginId：解析 \"plugin@marketplace\" 格式
 *   - installResolvedPlugin：安装核心逻辑（策略检查 + 依赖解析 + 写回 + 物化）
 *   - installPluginFromMarketplace：UI 路径入口（包装 installResolvedPlugin）
 *
 * 遥测注意：
 *   - 官方市场的插件 ID 写入 additional_metadata，第三方写 'third-party'（脱敏）
 *   - 插件名称和市场名称路由到 _PROTO_* PII 标记的 BQ 列
 */

import { randomBytes } from 'crypto'
import { rename, rm } from 'fs/promises'
import { dirname, join, resolve, sep } from 'path'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
  logEvent,
} from '../../services/analytics/index.js'
import { getCwd } from '../cwd.js'
import { toError } from '../errors.js'
import { getFsImplementation } from '../fsOperations.js'
import { logError } from '../log.js'
import {
  getSettingsForSource,
  updateSettingsForSource,
} from '../settings/settings.js'
import { buildPluginTelemetryFields } from '../telemetry/pluginTelemetry.js'
import { clearAllCaches } from './cacheUtils.js'
import {
  formatDependencyCountSuffix,
  getEnabledPluginIdsForScope,
  type ResolutionResult,
  resolveDependencyClosure,
} from './dependencyResolver.js'
import {
  addInstalledPlugin,
  getGitCommitSha,
} from './installedPluginsManager.js'
import { getManagedPluginNames } from './managedPlugins.js'
import { getMarketplaceCacheOnly, getPluginById } from './marketplaceManager.js'
import {
  isOfficialMarketplaceName,
  parsePluginIdentifier,
  scopeToSettingSource,
} from './pluginIdentifier.js'
import {
  cachePlugin,
  getVersionedCachePath,
  getVersionedZipCachePath,
} from './pluginLoader.js'
import { isPluginBlockedByPolicy } from './pluginPolicy.js'
import { calculatePluginVersion } from './pluginVersioning.js'
import {
  isLocalPluginSource,
  type PluginMarketplaceEntry,
  type PluginScope,
  type PluginSource,
} from './schemas.js'
import {
  convertDirectoryToZipInPlace,
  isPluginZipCacheEnabled,
} from './zipCache.js'

/**
 * installed_plugins.json 中的插件安装元数据类型
 */
export type PluginInstallationInfo = {
  pluginId: string    // 插件 ID（格式：\"plugin@marketplace\"）
  installPath: string // 安装路径
  version?: string    // 可选的版本字符串
}

/**
 * 获取当前 ISO 格式时间戳字符串。
 * 用于记录 installedAt 和 lastUpdated 时间。
 *
 * @returns ISO 8601 格式的时间戳字符串
 */
export function getCurrentTimestamp(): string {
  return new Date().toISOString()
}

/**
 * 验证解析后的路径是否在指定的基础目录内。
 *
 * 安全目的：防止路径遍历攻击（malicious paths like '../../../etc/passwd'
 * 可能逃逸出预期的目录）。
 *
 * 实现细节：
 *   - 拼接路径分隔符（sep）到 normalizedBase，避免部分目录名误匹配
 *     （例如 /foo/bar 不应匹配 /foo/barbaz）
 *   - 同时允许解析结果等于 basePath 本身（无尾部分隔符的场景）
 *
 * @param basePath - 解析结果必须在其内的基础目录
 * @param relativePath - 待验证的相对路径
 * @returns 验证通过后的绝对路径
 * @throws Error 若路径会逃逸出基础目录
 */
export function validatePathWithinBase(
  basePath: string,
  relativePath: string,
): string {
  const resolvedPath = resolve(basePath, relativePath)
  // 追加路径分隔符，防止部分目录名误匹配
  const normalizedBase = resolve(basePath) + sep

  // 检查解析后的路径是否以基础目录路径为前缀
  if (
    !resolvedPath.startsWith(normalizedBase) &&
    resolvedPath !== resolve(basePath)
  ) {
    throw new Error(
      `Path traversal detected: "${relativePath}" would escape the base directory`,
    )
  }

  return resolvedPath
}

/**
 * 缓存插件（本地或外部来源）并将其添加到 installed_plugins.json。
 *
 * 此函数封装了安装流程中的公共模式：
 *   1. 缓存插件到 ~/.claude/plugins/cache/（调用 cachePlugin）
 *   2. 计算版本号（manifest.version > provided > git SHA > 'unknown'）
 *   3. 将缓存目录移动到版本化路径 cache/marketplace/plugin/version/
 *      - 特殊情况：若版本化路径是缓存路径的子目录（市场名 = 插件名），
 *        先移动到临时路径再移动到最终位置，避免自我嵌套
 *   4. Zip 缓存模式下：将目录转换为 ZIP 文件（用于 Filestore 挂载场景）
 *   5. 添加到 installed_plugins.json（含 scope 和 projectPath）
 *
 * 本地插件和外部插件均写入相同的缓存位置，保证行为一致性。
 *
 * @param pluginId - 插件 ID（格式：\"plugin@marketplace\"）
 * @param entry - 插件市场条目
 * @param scope - 安装作用域，默认为 'user'
 * @param projectPath - project/local 作用域需要项目路径
 * @param localSourcePath - 本地插件源目录的解析绝对路径
 * @returns 最终安装路径（版本化路径或 ZIP 路径）
 */
export async function cacheAndRegisterPlugin(
  pluginId: string,
  entry: PluginMarketplaceEntry,
  scope: PluginScope = 'user',
  projectPath?: string,
  localSourcePath?: string,
): Promise<string> {
  // 本地插件使用解析后的绝对路径作为 source，确保 cachePlugin 能找到正确位置
  const source: PluginSource =
    typeof entry.source === 'string' && localSourcePath
      ? (localSourcePath as PluginSource)
      : entry.source

  // 步骤 1：调用 cachePlugin 缓存插件内容
  const cacheResult = await cachePlugin(source, {
    manifest: entry as PluginMarketplaceEntry,
  })

  // 步骤 2：确定用于计算 git SHA 的路径
  // 本地插件：使用原始来源路径（缓存临时目录无 .git）
  // 外部插件：使用缓存路径
  // git-subdir：cachePlugin 已在丢弃临时克隆前捕获 SHA
  const pathForGitSha = localSourcePath || cacheResult.path
  const gitCommitSha =
    cacheResult.gitCommitSha ?? (await getGitCommitSha(pathForGitSha))

  const now = getCurrentTimestamp()
  // 步骤 2b：计算版本号（优先级：manifest > provided > git SHA > 'unknown'）
  const version = await calculatePluginVersion(
    pluginId,
    entry.source,
    cacheResult.manifest,
    pathForGitSha,
    entry.version,
    cacheResult.gitCommitSha,
  )

  // 步骤 3：将缓存目录移动到版本化路径 cache/marketplace/plugin/version/
  const versionedPath = getVersionedCachePath(pluginId, version)
  let finalPath = cacheResult.path

  // 只在路径不同时才需要移动
  if (cacheResult.path !== versionedPath) {
    // 创建版本化目录结构
    await getFsImplementation().mkdir(dirname(versionedPath))

    // 移除已存在的版本化路径（force: 路径不存在时不报错）
    await rm(versionedPath, { recursive: true, force: true })

    // 检查版本化路径是否是缓存路径的子目录
    // 当市场名 = 插件名时会触发（如 "exa-mcp-server@exa-mcp-server"）
    // 不能直接 rename，因为会把目录移动到自身的子目录中
    const normalizedCachePath = cacheResult.path.endsWith(sep)
      ? cacheResult.path
      : cacheResult.path + sep
    const isSubdirectory = versionedPath.startsWith(normalizedCachePath)

    if (isSubdirectory) {
      // 先移到临时位置，再移到最终目标
      // 临时路径放在 cacheResult.path 的父目录（同文件系统），
      // 避免 /tmp 跨文件系统 EXDEV 错误（e.g., tmpfs）
      const tempPath = join(
        dirname(cacheResult.path),
        `.claude-plugin-temp-${Date.now()}-${randomBytes(4).toString('hex')}`,
      )
      await rename(cacheResult.path, tempPath)
      await getFsImplementation().mkdir(dirname(versionedPath))
      await rename(tempPath, versionedPath)
    } else {
      // 直接移动到版本化位置
      await rename(cacheResult.path, versionedPath)
    }
    finalPath = versionedPath
  }

  // 步骤 4：Zip 缓存模式——将目录转换为 ZIP 并删除原目录
  // 用于 Filestore 挂载的短暂容器场景（CLAUDE_CODE_PLUGIN_USE_ZIP_CACHE 环境变量）
  if (isPluginZipCacheEnabled()) {
    const zipPath = getVersionedZipCachePath(pluginId, version)
    await convertDirectoryToZipInPlace(finalPath, zipPath)
    finalPath = zipPath
  }

  // 步骤 5：注册到 installed_plugins.json（V1 + V2 格式，含正确的 scope）
  addInstalledPlugin(
    pluginId,
    {
      version,
      installedAt: now,
      lastUpdated: now,
      installPath: finalPath,
      gitCommitSha,
    },
    scope,
    projectPath,
  )

  return finalPath
}

/**
 * 注册插件安装信息，不执行缓存/下载操作。
 *
 * 适用于本地插件（已在磁盘上，无需远程缓存）。
 * 外部插件应使用 cacheAndRegisterPlugin()。
 *
 * @param info - 插件安装信息（ID、路径、版本）
 * @param scope - 安装作用域，默认为 'user'
 * @param projectPath - project/local 作用域需要项目路径
 */
export function registerPluginInstallation(
  info: PluginInstallationInfo,
  scope: PluginScope = 'user',
  projectPath?: string,
): void {
  const now = getCurrentTimestamp()
  // 直接写入 installed_plugins.json，不执行任何文件系统操作
  addInstalledPlugin(
    info.pluginId,
    {
      version: info.version || 'unknown',
      installedAt: now,
      lastUpdated: now,
      installPath: info.installPath,
    },
    scope,
    projectPath,
  )
}

/**
 * 解析插件 ID 字符串为名称和市场名称两个组件。
 *
 * 与 pluginIdentifier.ts 的 parsePluginIdentifier 的区别：
 *   此函数要求严格的 \"name@marketplace\" 格式（恰好一个 '@'，两侧非空），
 *   不满足时返回 null。
 *
 * @param pluginId - 格式为 \"plugin@marketplace\" 的插件 ID
 * @returns 解析后的组件，若格式无效则返回 null
 */
export function parsePluginId(
  pluginId: string,
): { name: string; marketplace: string } | null {
  const parts = pluginId.split('@')
  // 要求恰好两个部分且均非空
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return null
  }

  return {
    name: parts[0],
    marketplace: parts[1],
  }
}

/**
 * installResolvedPlugin 的结构化返回类型。
 *
 * 区分多种失败场景，供调用方（CLI、UI）格式化各自的错误消息。
 * 成功时返回依赖闭包列表和可选的依赖数量注释字符串。
 */
export type InstallCoreResult =
  | { ok: true; closure: string[]; depNote: string }
  | { ok: false; reason: 'local-source-no-location'; pluginName: string }
  | { ok: false; reason: 'settings-write-failed'; message: string }
  | {
      ok: false
      reason: 'resolution-failed'
      resolution: ResolutionResult & { ok: false }
    }
  | { ok: false; reason: 'blocked-by-policy'; pluginName: string }
  | {
      ok: false
      reason: 'dependency-blocked-by-policy'
      pluginName: string
      blockedDependency: string
    }

/**
 * 将失败的 ResolutionResult 格式化为面向用户的错误消息。
 *
 * 统一使用 CLI 风格的消息（含「Is the X marketplace added?」提示），
 * 因为此提示对 UI 用户同样有用。
 *
 * 场景覆盖：
 *   - 'cycle'：依赖循环
 *   - 'cross-marketplace'：跨市场依赖未列入白名单
 *   - 'not-found'：依赖在市场中不存在
 *
 * @param r - 失败的解析结果
 * @returns 面向用户的错误消息字符串
 */
export function formatResolutionError(
  r: ResolutionResult & { ok: false },
): string {
  switch (r.reason) {
    case 'cycle':
      // 依赖循环：展示循环链
      return `Dependency cycle: ${r.chain.join(' → ')}`
    case 'cross-marketplace': {
      // 跨市场依赖：说明哪个市场未被允许，并给出添加白名单的提示
      const depMkt = parsePluginIdentifier(r.dependency).marketplace
      const where = depMkt
        ? `marketplace "${depMkt}"`
        : 'a different marketplace'
      const hint = depMkt
        ? ` Add "${depMkt}" to allowCrossMarketplaceDependenciesOn in the ROOT marketplace's marketplace.json (the marketplace of the plugin you're installing — only its allowlist applies; no transitive trust).`
        : ''
      return `Dependency "${r.dependency}" (required by ${r.requiredBy}) is in ${where}, which is not in the allowlist — cross-marketplace dependencies are blocked by default. Install it manually first.${hint}`
    }
    case 'not-found': {
      // 依赖不存在：提示用户是否添加了对应市场
      const { marketplace: depMkt } = parsePluginIdentifier(r.missing)
      return depMkt
        ? `Dependency "${r.missing}" (required by ${r.requiredBy}) not found. Is the "${depMkt}" marketplace added?`
        : `Dependency "${r.missing}" (required by ${r.requiredBy}) not found in any configured marketplace`
    }
  }
}

/**
 * 插件安装核心逻辑，被 CLI 路径和交互式 UI 路径共用。
 *
 * 给定一个已解析的市场条目，执行：
 *   1. 本地来源检查：确保本地插件有 marketplaceInstallLocation（否则缓存会静默失败）
 *   2. 策略检查（根插件）：组织策略阻止的插件不能安装
 *   3. 依赖闭包解析：收集所有传递依赖（启用 PLUGIN_DEPENDENCIES 时）
 *   4. 策略检查（传递依赖）：确保依赖项也未被策略阻止
 *   5. 写回 settings：一次性将整个闭包写入 enabledPlugins
 *   6. 物化：为每个闭包成员调用 cacheAndRegisterPlugin（下载/复制）
 *   7. 清空缓存：确保后续 loadAllPlugins 读取最新状态
 *
 * 返回结构化结果，消息格式化、遥测、异常捕获留给调用方包装层。
 *
 * @param marketplaceInstallLocation - 若调用方已有此值则传入，避免重复查询市场
 */
export async function installResolvedPlugin({
  pluginId,
  entry,
  scope,
  marketplaceInstallLocation,
}: {
  pluginId: string
  entry: PluginMarketplaceEntry
  scope: 'user' | 'project' | 'local'
  marketplaceInstallLocation?: string
}): Promise<InstallCoreResult> {
  const settingSource = scopeToSettingSource(scope)

  // ── 步骤 1：策略检查（根插件）──
  // 组织策略阻止的插件（managed-settings.json enabledPlugins: false）不能安装。
  // 在此统一检查，覆盖所有安装路径（CLI、UI、hint 触发）。
  if (isPluginBlockedByPolicy(pluginId)) {
    return { ok: false, reason: 'blocked-by-policy', pluginName: entry.name }
  }

  // ── 步骤 2：解析依赖闭包 ──
  // depInfo 缓存市场查询结果，避免物化循环中重复 fetch。
  // 若调用方提供了 marketplaceInstallLocation 则预填种子。
  const depInfo = new Map<
    string,
    { entry: PluginMarketplaceEntry; marketplaceInstallLocation: string }
  >()
  // 安全检查：本地来源插件必须有 marketplaceInstallLocation。
  // 若缺失：depInfo 未被种子，物化循环的 `if (!info) continue` 会跳过根插件，
  // 导致"成功安装"提示但实际什么都没缓存。
  if (isLocalPluginSource(entry.source) && !marketplaceInstallLocation) {
    return {
      ok: false,
      reason: 'local-source-no-location',
      pluginName: entry.name,
    }
  }
  if (marketplaceInstallLocation) {
    depInfo.set(pluginId, { entry, marketplaceInstallLocation })
  }

  // 读取根插件所在市场的跨市场依赖白名单
  const rootMarketplace = parsePluginIdentifier(pluginId).marketplace
  const allowedCrossMarketplaces = new Set(
    (rootMarketplace
      ? (await getMarketplaceCacheOnly(rootMarketplace))
          ?.allowCrossMarketplaceDependenciesOn
      : undefined) ?? [],
  )
  // 执行依赖闭包解析
  const resolution = await resolveDependencyClosure(
    pluginId,
    async id => {
      // 优先从 depInfo 缓存取，避免重复 fetch
      if (depInfo.has(id)) return depInfo.get(id)!.entry
      if (id === pluginId) return entry
      const info = await getPluginById(id)
      if (info) depInfo.set(id, info)
      return info?.entry ?? null
    },
    getEnabledPluginIdsForScope(settingSource),
    allowedCrossMarketplaces,
  )
  if (!resolution.ok) {
    return { ok: false, reason: 'resolution-failed', resolution }
  }

  // ── 步骤 3：策略检查（传递依赖）──
  // 根插件已在步骤 1 检查，此处检查闭包中的其他依赖。
  // 确保非阻止插件不能引入被阻止的依赖。
  for (const id of resolution.closure) {
    if (id !== pluginId && isPluginBlockedByPolicy(id)) {
      return {
        ok: false,
        reason: 'dependency-blocked-by-policy',
        pluginName: entry.name,
        blockedDependency: id,
      }
    }
  }

  // ── 步骤 4：写回 settings（一次性将整个闭包写入 enabledPlugins）──
  const closureEnabled: Record<string, true> = {}
  for (const id of resolution.closure) closureEnabled[id] = true
  const { error } = updateSettingsForSource(settingSource, {
    enabledPlugins: {
      ...getSettingsForSource(settingSource)?.enabledPlugins,
      ...closureEnabled,
    },
  })
  if (error) {
    return {
      ok: false,
      reason: 'settings-write-failed',
      message: error.message,
    }
  }

  // ── 步骤 5：物化——为每个闭包成员缓存插件 ──
  const projectPath = scope !== 'user' ? getCwd() : undefined
  for (const id of resolution.closure) {
    let info = depInfo.get(id)
    // 根插件未预填种子（调用方未传 marketplaceInstallLocation 且非本地来源）
    // 现在去 fetch，缓存写入需要此信息
    if (!info && id === pluginId) {
      const mktLocation = (await getPluginById(id))?.marketplaceInstallLocation
      if (mktLocation) info = { entry, marketplaceInstallLocation: mktLocation }
    }
    if (!info) continue  // 无法获取信息时跳过（极少数情况）

    let localSourcePath: string | undefined
    const { source } = info.entry
    if (isLocalPluginSource(source)) {
      // 本地来源：验证路径在市场安装目录内（防路径遍历），并获取绝对路径
      localSourcePath = validatePathWithinBase(
        info.marketplaceInstallLocation,
        source,
      )
    }
    await cacheAndRegisterPlugin(
      id,
      info.entry,
      scope,
      projectPath,
      localSourcePath,
    )
  }

  // 步骤 6：清空所有 memoize 缓存，确保后续 loadAllPlugins 读取最新状态
  clearAllCaches()

  // 构建依赖数量注释字符串（如 \" (+ 2 dependencies)\"）
  const depNote = formatDependencyCountSuffix(
    resolution.closure.filter(id => id !== pluginId),
  )
  return { ok: true, closure: resolution.closure, depNote }
}

/**
 * 插件安装操作的结果类型
 */
export type InstallPluginResult =
  | { success: true; message: string }
  | { success: false; error: string }

/**
 * 从市场安装插件的参数类型
 */
export type InstallPluginParams = {
  pluginId: string              // 插件 ID（格式：\"plugin@marketplace\"）
  entry: PluginMarketplaceEntry // 市场条目
  marketplaceName: string       // 市场名称（用于遥测）
  scope?: 'user' | 'project' | 'local'  // 安装作用域（默认 'user'）
  trigger?: 'hint' | 'user'    // 安装触发来源（用于遥测）
}

/**
 * 从市场安装单个插件的交互式 UI 入口函数。
 *
 * 此函数是 installResolvedPlugin 的 UI 路径包装层，额外处理：
 *   - try/catch：将所有异常转换为 { success: false, error } 格式
 *   - 错误消息格式化：将结构化错误转换为 UI 友好的字符串
 *   - 遥测上报：成功安装后记录 tengu_plugin_installed 事件
 *     - 官方市场：pluginId 写入 additional_metadata
 *     - 第三方市场：pluginId 脱敏为 'third-party'
 *     - 插件名和市场名路由到 _PROTO_* PII 标记列
 *
 * @param params - 安装参数（插件 ID、市场条目、作用域、触发来源）
 * @returns 安装结果（成功消息或错误字符串）
 */
export async function installPluginFromMarketplace({
  pluginId,
  entry,
  marketplaceName,
  scope = 'user',
  trigger = 'user',
}: InstallPluginParams): Promise<InstallPluginResult> {
  try {
    // 查询市场安装位置（本地来源插件需要此值）
    // 不传此值的话，本地插件会在 installResolvedPlugin 中提前失败
    const pluginInfo = await getPluginById(pluginId)
    const marketplaceInstallLocation = pluginInfo?.marketplaceInstallLocation

    // 调用核心安装逻辑
    const result = await installResolvedPlugin({
      pluginId,
      entry,
      scope,
      marketplaceInstallLocation,
    })

    if (!result.ok) {
      // 将结构化错误转换为 UI 友好的字符串
      switch (result.reason) {
        case 'local-source-no-location':
          return {
            success: false,
            error: `Cannot install local plugin "${result.pluginName}" without marketplace install location`,
          }
        case 'settings-write-failed':
          return {
            success: false,
            error: `Failed to update settings: ${result.message}`,
          }
        case 'resolution-failed':
          return {
            success: false,
            error: formatResolutionError(result.resolution),
          }
        case 'blocked-by-policy':
          return {
            success: false,
            error: `Plugin "${result.pluginName}" is blocked by your organization's policy and cannot be installed`,
          }
        case 'dependency-blocked-by-policy':
          return {
            success: false,
            error: `Cannot install "${result.pluginName}": dependency "${result.blockedDependency}" is blocked by your organization's policy`,
          }
      }
    }

    // 遥测上报：tengu_plugin_installed 事件
    // _PROTO_* 路由到 PII 标记的 plugin_name/marketplace_name BQ 列
    // plugin_id 写入 additional_metadata（官方市场保留原值，第三方脱敏为 'third-party'）
    // dbt external_claude_code_plugin_installs.sql 使用 $.plugin_id 追踪官方市场安装
    logEvent('tengu_plugin_installed', {
      _PROTO_plugin_name:
        entry.name as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
      _PROTO_marketplace_name:
        marketplaceName as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
      plugin_id: (isOfficialMarketplaceName(marketplaceName)
        ? pluginId
        : 'third-party') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      trigger:
        trigger as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      install_source: (trigger === 'hint'
        ? 'ui-suggestion'
        : 'ui-discover') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      // 构建插件遥测字段（含 managed 状态）
      ...buildPluginTelemetryFields(
        entry.name,
        marketplaceName,
        getManagedPluginNames(),
      ),
      ...(entry.version && {
        version:
          entry.version as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      }),
    })

    return {
      success: true,
      message: `✓ Installed ${entry.name}${result.depNote}. Run /reload-plugins to activate.`,
    }
  } catch (err) {
    // 将所有未预期异常转换为 { success: false, error } 格式
    const errorMessage = err instanceof Error ? err.message : String(err)
    logError(toError(err))
    return { success: false, error: `Failed to install: ${errorMessage}` }
  }
}
