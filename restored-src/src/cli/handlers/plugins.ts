/**
 * 插件与市场子命令处理器 — 从 main.tsx 中抽出以实现懒加载。
 *
 * 在整个 Claude Code 系统中的位置：
 * 本文件包含所有 `claude plugin *` 和 `claude plugin marketplace *` 子命令的执行逻辑。
 * 它们通过动态 import 懒加载，只有当用户实际运行插件相关命令时才会被加载，
 * 从而避免在 CLI 启动时引入不必要的依赖开销。
 *
 * 包含的命令组：
 *   - plugin validate  — 验证插件清单文件格式与内容
 *   - plugin list      — 列出已安装及（可选）可用插件
 *   - plugin install   — 在指定作用域安装插件
 *   - plugin uninstall — 卸载插件
 *   - plugin enable    — 启用插件
 *   - plugin disable   — 禁用单个或所有插件
 *   - plugin update    — 更新插件至最新版本
 *   - marketplace add    — 添加插件市场源
 *   - marketplace list   — 列出已配置的市场
 *   - marketplace remove — 移除市场源
 *   - marketplace update — 刷新市场缓存
 */
/* eslint-disable custom-rules/no-process-exit -- CLI subcommand handlers intentionally exit */
import figures from 'figures'
import { basename, dirname } from 'path'
import { setUseCoworkPlugins } from '../../bootstrap/state.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
  logEvent,
} from '../../services/analytics/index.js'
import {
  disableAllPlugins,
  disablePlugin,
  enablePlugin,
  installPlugin,
  uninstallPlugin,
  updatePluginCli,
  VALID_INSTALLABLE_SCOPES,
  VALID_UPDATE_SCOPES,
} from '../../services/plugins/pluginCliCommands.js'
import { getPluginErrorMessage } from '../../types/plugin.js'
import { errorMessage } from '../../utils/errors.js'
import { logError } from '../../utils/log.js'
import { clearAllCaches } from '../../utils/plugins/cacheUtils.js'
import { getInstallCounts } from '../../utils/plugins/installCounts.js'
import {
  isPluginInstalled,
  loadInstalledPluginsV2,
} from '../../utils/plugins/installedPluginsManager.js'
import {
  createPluginId,
  loadMarketplacesWithGracefulDegradation,
} from '../../utils/plugins/marketplaceHelpers.js'
import {
  addMarketplaceSource,
  loadKnownMarketplacesConfig,
  refreshAllMarketplaces,
  refreshMarketplace,
  removeMarketplaceSource,
  saveMarketplaceToSettings,
} from '../../utils/plugins/marketplaceManager.js'
import { loadPluginMcpServers } from '../../utils/plugins/mcpPluginIntegration.js'
import { parseMarketplaceInput } from '../../utils/plugins/parseMarketplaceInput.js'
import {
  parsePluginIdentifier,
  scopeToSettingSource,
} from '../../utils/plugins/pluginIdentifier.js'
import { loadAllPlugins } from '../../utils/plugins/pluginLoader.js'
import type { PluginSource } from '../../utils/plugins/schemas.js'
import {
  type ValidationResult,
  validateManifest,
  validatePluginContents,
} from '../../utils/plugins/validatePlugin.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { plural } from '../../utils/stringUtils.js'
import { cliError, cliOk } from '../exit.js'

// 重新导出供 main.tsx 在选项定义（--scope 等枚举值）中直接引用
export { VALID_INSTALLABLE_SCOPES, VALID_UPDATE_SCOPES }

/**
 * 统一处理市场命令执行失败的工具函数。
 *
 * 将错误写入日志后调用 cliError() 展示友好提示并退出进程（never 返回）。
 * 所有 marketplace 子命令的 catch 块均通过此函数汇聚，确保错误格式一致。
 */
export function handleMarketplaceError(error: unknown, action: string): never {
  logError(error)
  cliError(`${figures.cross} Failed to ${action}: ${errorMessage(error)}`)
}

/**
 * 将 ValidationResult 中的错误与警告逐条打印到 stdout。
 *
 * 分两组输出：
 *   - errors（错误）：以 ✖ 前缀汇总数量，逐条展示 path + message
 *   - warnings（警告）：以 ⚠ 前缀汇总数量，逐条展示 path + message
 * 调用方（pluginValidateHandler）根据此函数的输出决定最终退出码。
 */
function printValidationResult(result: ValidationResult): void {
  if (result.errors.length > 0) {
    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.log(
      `${figures.cross} Found ${result.errors.length} ${plural(result.errors.length, 'error')}:\n`,
    )
    result.errors.forEach(error => {
      // biome-ignore lint/suspicious/noConsole:: intentional console output
      console.log(`  ${figures.pointer} ${error.path}: ${error.message}`)
    })
    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.log('')
  }
  if (result.warnings.length > 0) {
    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.log(
      `${figures.warning} Found ${result.warnings.length} ${plural(result.warnings.length, 'warning')}:\n`,
    )
    result.warnings.forEach(warning => {
      // biome-ignore lint/suspicious/noConsole:: intentional console output
      console.log(`  ${figures.pointer} ${warning.path}: ${warning.message}`)
    })
    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.log('')
  }
}

// plugin validate
/**
 * `claude plugin validate` 命令处理器：验证插件清单文件的格式与内容。
 *
 * 流程：
 * 1. 若 --cowork 标志，切换到 cowork 插件集。
 * 2. 调用 validateManifest() 解析并校验 plugin.json / skill.json 等清单文件。
 * 3. 若清单位于 .claude-plugin 目录内（插件根目录结构），
 *    额外调用 validatePluginContents() 校验 skills/agents/commands/hooks 等内容文件。
 * 4. 汇总所有验证结果：全部通过则 cliOk（有警告时注明），否则 process.exit(1)。
 * 5. 捕获意外异常以 process.exit(2) 退出。
 */
export async function pluginValidateHandler(
  manifestPath: string,
  options: { cowork?: boolean },
): Promise<void> {
  if (options.cowork) setUseCoworkPlugins(true)
  try {
    const result = await validateManifest(manifestPath)

    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.log(`Validating ${result.fileType} manifest: ${result.filePath}\n`)
    printValidationResult(result)

    // If this is a plugin manifest located inside a .claude-plugin directory,
    // also validate the plugin's content files (skills, agents, commands,
    // hooks). Works whether the user passed a directory or the plugin.json
    // path directly.
    let contentResults: ValidationResult[] = []
    if (result.fileType === 'plugin') {
      const manifestDir = dirname(result.filePath)
      // 仅在清单文件位于 .claude-plugin 目录时才验证内容文件
      if (basename(manifestDir) === '.claude-plugin') {
        // validatePluginContents 的参数是插件的外层目录（.claude-plugin 的父目录）
        contentResults = await validatePluginContents(dirname(manifestDir))
        for (const r of contentResults) {
          // biome-ignore lint/suspicious/noConsole:: intentional console output
          console.log(`Validating ${r.fileType}: ${r.filePath}\n`)
          printValidationResult(r)
        }
      }
    }

    const allSuccess = result.success && contentResults.every(r => r.success)
    const hasWarnings =
      result.warnings.length > 0 ||
      contentResults.some(r => r.warnings.length > 0)

    if (allSuccess) {
      cliOk(
        hasWarnings
          ? `${figures.tick} Validation passed with warnings`
          : `${figures.tick} Validation passed`,
      )
    } else {
      // biome-ignore lint/suspicious/noConsole:: intentional console output
      console.log(`${figures.cross} Validation failed`)
      process.exit(1)
    }
  } catch (error) {
    logError(error)
    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.error(
      `${figures.cross} Unexpected error during validation: ${errorMessage(error)}`,
    )
    process.exit(2)
  }
}

// plugin list (lines 5217–5416)
/**
 * `claude plugin list` 命令处理器：列出已安装及（可选）可用插件。
 *
 * 流程：
 * 1. 从 installedData 读取所有已安装插件的 bookkeeping 记录。
 * 2. 调用 loadAllPlugins() 实际加载所有插件，获取加载错误和 inline 插件信息。
 * 3. 若 --json，以 JSON 格式输出（含 installed 列表，--available 时额外含 available 列表）；
 *    否则以人类可读格式逐条展示插件 ID、版本、作用域、启用状态、加载错误。
 * 4. 特殊处理 session-only（--plugin-dir）插件：它们不在 installedData 中，
 *    由 inlinePlugins 和 inlineLoadErrors 单独列出。
 * 5. 若 --available，并发加载已配置市场中未安装的插件，追加到输出。
 */
export async function pluginListHandler(options: {
  json?: boolean
  available?: boolean
  cowork?: boolean
}): Promise<void> {
  if (options.cowork) setUseCoworkPlugins(true)
  logEvent('tengu_plugin_list_command', {})

  const installedData = loadInstalledPluginsV2()
  const { getPluginEditableScopes } = await import(
    '../../utils/plugins/pluginStartupCheck.js'
  )
  const enabledPlugins = getPluginEditableScopes()

  const pluginIds = Object.keys(installedData.plugins)

  // Load all plugins once. The JSON and human paths both need:
  //  - loadErrors (to show load failures per plugin)
  //  - inline plugins (session-only via --plugin-dir, source='name@inline')
  //    which are NOT in installedData.plugins (V2 bookkeeping) — they must
  //    be surfaced separately or `plugin list` silently ignores --plugin-dir.
  // 同时加载已启用和已禁用插件，合并后用于 inline 插件过滤
  const {
    enabled: loadedEnabled,
    disabled: loadedDisabled,
    errors: loadErrors,
  } = await loadAllPlugins()
  const allLoadedPlugins = [...loadedEnabled, ...loadedDisabled]
  const inlinePlugins = allLoadedPlugins.filter(p =>
    p.source.endsWith('@inline'),
  )
  // Path-level inline failures (dir doesn't exist, parse error before
  // manifest is read) use source='inline[N]'. Plugin-level errors after
  // manifest read use source='name@inline'. Collect both for the session
  // section — these are otherwise invisible since they have no pluginId.
  // 同时收集路径级（inline[N]）和插件级（name@inline）的加载失败，
  // 避免因 --plugin-dir 指向不存在路径时静默无输出
  const inlineLoadErrors = loadErrors.filter(
    e => e.source.endsWith('@inline') || e.source.startsWith('inline['),
  )

  if (options.json) {
    // Create a map of plugin source to loaded plugin for quick lookup
    const loadedPluginMap = new Map(allLoadedPlugins.map(p => [p.source, p]))

    const plugins: Array<{
      id: string
      version: string
      scope: string
      enabled: boolean
      installPath: string
      installedAt?: string
      lastUpdated?: string
      projectPath?: string
      mcpServers?: Record<string, unknown>
      errors?: string[]
    }> = []

    for (const pluginId of pluginIds.sort()) {
      const installations = installedData.plugins[pluginId]
      if (!installations || installations.length === 0) continue

      // Find loading errors for this plugin
      const pluginName = parsePluginIdentifier(pluginId).name
      const pluginErrors = loadErrors
        .filter(
          e =>
            e.source === pluginId || ('plugin' in e && e.plugin === pluginName),
        )
        .map(getPluginErrorMessage)

      for (const installation of installations) {
        // Try to find the loaded plugin to get MCP servers
        const loadedPlugin = loadedPluginMap.get(pluginId)
        let mcpServers: Record<string, unknown> | undefined

        if (loadedPlugin) {
          // Load MCP servers if not already cached
          const servers =
            loadedPlugin.mcpServers ||
            (await loadPluginMcpServers(loadedPlugin))
          if (servers && Object.keys(servers).length > 0) {
            mcpServers = servers
          }
        }

        plugins.push({
          id: pluginId,
          version: installation.version || 'unknown',
          scope: installation.scope,
          enabled: enabledPlugins.has(pluginId),
          installPath: installation.installPath,
          installedAt: installation.installedAt,
          lastUpdated: installation.lastUpdated,
          projectPath: installation.projectPath,
          mcpServers,
          errors: pluginErrors.length > 0 ? pluginErrors : undefined,
        })
      }
    }

    // Session-only plugins: scope='session', no install metadata.
    // Filter from inlineLoadErrors (not loadErrors) so an installed plugin
    // with the same manifest name doesn't cross-contaminate via e.plugin.
    // The e.plugin fallback catches the dirName≠manifestName case:
    // createPluginFromPath tags errors with `${dirName}@inline` but
    // plugin.source is reassigned to `${manifest.name}@inline` afterward
    // (pluginLoader.ts loadInlinePlugins), so e.source !== p.source when
    // a dev checkout dir like ~/code/my-fork/ has manifest name 'cool-plugin'.
    for (const p of inlinePlugins) {
      const servers = p.mcpServers || (await loadPluginMcpServers(p))
      const pErrors = inlineLoadErrors
        .filter(
          e => e.source === p.source || ('plugin' in e && e.plugin === p.name),
        )
        .map(getPluginErrorMessage)
      plugins.push({
        id: p.source,
        version: p.manifest.version ?? 'unknown',
        scope: 'session',
        enabled: p.enabled !== false,
        installPath: p.path,
        mcpServers:
          servers && Object.keys(servers).length > 0 ? servers : undefined,
        errors: pErrors.length > 0 ? pErrors : undefined,
      })
    }
    // Path-level inline failures (--plugin-dir /nonexistent): no LoadedPlugin
    // exists so the loop above can't surface them. Mirror the human-path
    // handling so JSON consumers see the failure instead of silent omission.
    for (const e of inlineLoadErrors.filter(e =>
      e.source.startsWith('inline['),
    )) {
      plugins.push({
        id: e.source,
        version: 'unknown',
        scope: 'session',
        enabled: false,
        installPath: 'path' in e ? e.path : '',
        errors: [getPluginErrorMessage(e)],
      })
    }

    // If --available is set, also load available plugins from marketplaces
    if (options.available) {
      const available: Array<{
        pluginId: string
        name: string
        description?: string
        marketplaceName: string
        version?: string
        source: PluginSource
        installCount?: number
      }> = []

      try {
        const [config, installCounts] = await Promise.all([
          loadKnownMarketplacesConfig(),
          getInstallCounts(),
        ])
        const { marketplaces } =
          await loadMarketplacesWithGracefulDegradation(config)

        for (const {
          name: marketplaceName,
          data: marketplace,
        } of marketplaces) {
          if (marketplace) {
            for (const entry of marketplace.plugins) {
              const pluginId = createPluginId(entry.name, marketplaceName)
              // Only include plugins that are not already installed
              if (!isPluginInstalled(pluginId)) {
                available.push({
                  pluginId,
                  name: entry.name,
                  description: entry.description,
                  marketplaceName,
                  version: entry.version,
                  source: entry.source,
                  installCount: installCounts?.get(pluginId),
                })
              }
            }
          }
        }
      } catch {
        // Silently ignore marketplace loading errors
      }

      cliOk(jsonStringify({ installed: plugins, available }, null, 2))
    } else {
      cliOk(jsonStringify(plugins, null, 2))
    }
  }

  if (pluginIds.length === 0 && inlinePlugins.length === 0) {
    // inlineLoadErrors can exist with zero inline plugins (e.g. --plugin-dir
    // points at a nonexistent path). Don't early-exit over them — fall
    // through to the session section so the failure is visible.
    if (inlineLoadErrors.length === 0) {
      cliOk(
        'No plugins installed. Use `claude plugin install` to install a plugin.',
      )
    }
  }

  if (pluginIds.length > 0) {
    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.log('Installed plugins:\n')
  }

  for (const pluginId of pluginIds.sort()) {
    const installations = installedData.plugins[pluginId]
    if (!installations || installations.length === 0) continue

    // Find loading errors for this plugin
    const pluginName = parsePluginIdentifier(pluginId).name
    const pluginErrors = loadErrors.filter(
      e => e.source === pluginId || ('plugin' in e && e.plugin === pluginName),
    )

    for (const installation of installations) {
      const isEnabled = enabledPlugins.has(pluginId)
      const status =
        pluginErrors.length > 0
          ? `${figures.cross} failed to load`
          : isEnabled
            ? `${figures.tick} enabled`
            : `${figures.cross} disabled`
      const version = installation.version || 'unknown'
      const scope = installation.scope

      // biome-ignore lint/suspicious/noConsole:: intentional console output
      console.log(`  ${figures.pointer} ${pluginId}`)
      // biome-ignore lint/suspicious/noConsole:: intentional console output
      console.log(`    Version: ${version}`)
      // biome-ignore lint/suspicious/noConsole:: intentional console output
      console.log(`    Scope: ${scope}`)
      // biome-ignore lint/suspicious/noConsole:: intentional console output
      console.log(`    Status: ${status}`)
      for (const error of pluginErrors) {
        // biome-ignore lint/suspicious/noConsole:: intentional console output
        console.log(`    Error: ${getPluginErrorMessage(error)}`)
      }
      // biome-ignore lint/suspicious/noConsole:: intentional console output
      console.log('')
    }
  }

  if (inlinePlugins.length > 0 || inlineLoadErrors.length > 0) {
    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.log('Session-only plugins (--plugin-dir):\n')
    for (const p of inlinePlugins) {
      // Same dirName≠manifestName fallback as the JSON path above — error
      // sources use the dir basename but p.source uses the manifest name.
      const pErrors = inlineLoadErrors.filter(
        e => e.source === p.source || ('plugin' in e && e.plugin === p.name),
      )
      const status =
        pErrors.length > 0
          ? `${figures.cross} loaded with errors`
          : `${figures.tick} loaded`
      // biome-ignore lint/suspicious/noConsole:: intentional console output
      console.log(`  ${figures.pointer} ${p.source}`)
      // biome-ignore lint/suspicious/noConsole:: intentional console output
      console.log(`    Version: ${p.manifest.version ?? 'unknown'}`)
      // biome-ignore lint/suspicious/noConsole:: intentional console output
      console.log(`    Path: ${p.path}`)
      // biome-ignore lint/suspicious/noConsole:: intentional console output
      console.log(`    Status: ${status}`)
      for (const e of pErrors) {
        // biome-ignore lint/suspicious/noConsole:: intentional console output
        console.log(`    Error: ${getPluginErrorMessage(e)}`)
      }
      // biome-ignore lint/suspicious/noConsole:: intentional console output
      console.log('')
    }
    // Path-level failures: no LoadedPlugin object exists. Show them so
    // `--plugin-dir /typo` doesn't just silently produce nothing.
    for (const e of inlineLoadErrors.filter(e =>
      e.source.startsWith('inline['),
    )) {
      // biome-ignore lint/suspicious/noConsole:: intentional console output
      console.log(
        `  ${figures.pointer} ${e.source}: ${figures.cross} ${getPluginErrorMessage(e)}\n`,
      )
    }
  }

  cliOk()
}

// marketplace add (lines 5433–5487)
/**
 * `claude plugin marketplace add` 命令处理器：解析并添加新的插件市场源。
 *
 * 流程：
 * 1. 调用 parseMarketplaceInput() 将用户输入（owner/repo、https://...、./path）解析为结构化源。
 * 2. 验证 scope 合法性（user/project/local），转换为 SettingSource。
 * 3. 若提供了 --sparse，将稀疏路径合并进 marketplaceSource（仅 github/git 支持）。
 * 4. 调用 addMarketplaceSource() 实际拉取/物化市场数据（含进度回调）。
 * 5. 将市场源声明写入指定作用域的配置文件（saveMarketplaceToSettings）。
 * 6. 清空所有插件缓存，记录分析事件。
 */
export async function marketplaceAddHandler(
  source: string,
  options: { cowork?: boolean; sparse?: string[]; scope?: string },
): Promise<void> {
  if (options.cowork) setUseCoworkPlugins(true)
  try {
    const parsed = await parseMarketplaceInput(source)

    if (!parsed) {
      cliError(
        `${figures.cross} Invalid marketplace source format. Try: owner/repo, https://..., or ./path`,
      )
    }

    if ('error' in parsed) {
      cliError(`${figures.cross} ${parsed.error}`)
    }

    // Validate scope
    // 验证并转换 --scope 参数为 SettingSource（user/project/local → 对应配置文件）
    const scope = options.scope ?? 'user'
    if (scope !== 'user' && scope !== 'project' && scope !== 'local') {
      cliError(
        `${figures.cross} Invalid scope '${scope}'. Use: user, project, or local`,
      )
    }
    const settingSource = scopeToSettingSource(scope)

    let marketplaceSource = parsed

    if (options.sparse && options.sparse.length > 0) {
      if (
        marketplaceSource.source === 'github' ||
        marketplaceSource.source === 'git'
      ) {
        marketplaceSource = {
          ...marketplaceSource,
          sparsePaths: options.sparse,
        }
      } else {
        cliError(
          `${figures.cross} --sparse is only supported for github and git marketplace sources (got: ${marketplaceSource.source})`,
        )
      }
    }

    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.log('Adding marketplace...')

    const { name, alreadyMaterialized, resolvedSource } =
      await addMarketplaceSource(marketplaceSource, message => {
        // biome-ignore lint/suspicious/noConsole:: intentional console output
        console.log(message)
      })

    // Write intent to settings at the requested scope
    // 将市场源声明持久化到对应作用域的设置文件（此时市场数据已物化到磁盘）
    saveMarketplaceToSettings(name, { source: resolvedSource }, settingSource)

    clearAllCaches()

    let sourceType = marketplaceSource.source
    if (marketplaceSource.source === 'github') {
      sourceType =
        marketplaceSource.repo as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
    }
    logEvent('tengu_marketplace_added', {
      source_type:
        sourceType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })

    cliOk(
      alreadyMaterialized
        ? `${figures.tick} Marketplace '${name}' already on disk — declared in ${scope} settings`
        : `${figures.tick} Successfully added marketplace: ${name} (declared in ${scope} settings)`,
    )
  } catch (error) {
    handleMarketplaceError(error, 'add marketplace')
  }
}

// marketplace list (lines 5497–5565)
/**
 * `claude plugin marketplace list` 命令处理器：列出所有已配置的插件市场。
 *
 * 从 loadKnownMarketplacesConfig() 读取当前生效的市场配置，
 * 以 --json 模式输出结构化 JSON（含 source 类型、repo/url/path 等字段），
 * 或以人类可读格式逐条展示市场名称和来源详情。
 */
export async function marketplaceListHandler(options: {
  json?: boolean
  cowork?: boolean
}): Promise<void> {
  if (options.cowork) setUseCoworkPlugins(true)
  try {
    const config = await loadKnownMarketplacesConfig()
    const names = Object.keys(config)

    if (options.json) {
      const marketplaces = names.sort().map(name => {
        const marketplace = config[name]
        const source = marketplace?.source
        return {
          name,
          source: source?.source,
          ...(source?.source === 'github' && { repo: source.repo }),
          ...(source?.source === 'git' && { url: source.url }),
          ...(source?.source === 'url' && { url: source.url }),
          ...(source?.source === 'directory' && { path: source.path }),
          ...(source?.source === 'file' && { path: source.path }),
          installLocation: marketplace?.installLocation,
        }
      })
      cliOk(jsonStringify(marketplaces, null, 2))
    }

    if (names.length === 0) {
      cliOk('No marketplaces configured')
    }

    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.log('Configured marketplaces:\n')
    names.forEach(name => {
      const marketplace = config[name]
      // biome-ignore lint/suspicious/noConsole:: intentional console output
      console.log(`  ${figures.pointer} ${name}`)

      if (marketplace?.source) {
        const src = marketplace.source
        if (src.source === 'github') {
          // biome-ignore lint/suspicious/noConsole:: intentional console output
          console.log(`    Source: GitHub (${src.repo})`)
        } else if (src.source === 'git') {
          // biome-ignore lint/suspicious/noConsole:: intentional console output
          console.log(`    Source: Git (${src.url})`)
        } else if (src.source === 'url') {
          // biome-ignore lint/suspicious/noConsole:: intentional console output
          console.log(`    Source: URL (${src.url})`)
        } else if (src.source === 'directory') {
          // biome-ignore lint/suspicious/noConsole:: intentional console output
          console.log(`    Source: Directory (${src.path})`)
        } else if (src.source === 'file') {
          // biome-ignore lint/suspicious/noConsole:: intentional console output
          console.log(`    Source: File (${src.path})`)
        }
      }
      // biome-ignore lint/suspicious/noConsole:: intentional console output
      console.log('')
    })

    cliOk()
  } catch (error) {
    handleMarketplaceError(error, 'list marketplaces')
  }
}

// marketplace remove (lines 5576–5598)
/**
 * `claude plugin marketplace remove` 命令处理器：移除指定的插件市场源。
 *
 * 调用 removeMarketplaceSource() 从所有作用域的配置中删除该市场，
 * 随后清空所有插件缓存（避免使用已失效的市场数据），并记录分析事件。
 */
export async function marketplaceRemoveHandler(
  name: string,
  options: { cowork?: boolean },
): Promise<void> {
  if (options.cowork) setUseCoworkPlugins(true)
  try {
    await removeMarketplaceSource(name)
    clearAllCaches()

    logEvent('tengu_marketplace_removed', {
      marketplace_name:
        name as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })

    cliOk(`${figures.tick} Successfully removed marketplace: ${name}`)
  } catch (error) {
    handleMarketplaceError(error, 'remove marketplace')
  }
}

// marketplace update (lines 5609–5672)
/**
 * `claude plugin marketplace update [name]` 命令处理器：刷新市场缓存。
 *
 * 若提供了市场名称，仅刷新该市场；
 * 若未提供名称，并发刷新所有已配置市场（refreshAllMarketplaces）。
 * 刷新后清空插件缓存，记录分析事件（单个或 all 两种事件类型）。
 */
export async function marketplaceUpdateHandler(
  name: string | undefined,
  options: { cowork?: boolean },
): Promise<void> {
  if (options.cowork) setUseCoworkPlugins(true)
  try {
    if (name) {
      // biome-ignore lint/suspicious/noConsole:: intentional console output
      console.log(`Updating marketplace: ${name}...`)

      await refreshMarketplace(name, message => {
        // biome-ignore lint/suspicious/noConsole:: intentional console output
        console.log(message)
      })

      clearAllCaches()

      logEvent('tengu_marketplace_updated', {
        marketplace_name:
          name as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })

      cliOk(`${figures.tick} Successfully updated marketplace: ${name}`)
    } else {
      const config = await loadKnownMarketplacesConfig()
      const marketplaceNames = Object.keys(config)

      if (marketplaceNames.length === 0) {
        cliOk('No marketplaces configured')
      }

      // biome-ignore lint/suspicious/noConsole:: intentional console output
      console.log(`Updating ${marketplaceNames.length} marketplace(s)...`)

      await refreshAllMarketplaces()
      clearAllCaches()

      logEvent('tengu_marketplace_updated_all', {
        count:
          marketplaceNames.length as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })

      cliOk(
        `${figures.tick} Successfully updated ${marketplaceNames.length} marketplace(s)`,
      )
    }
  } catch (error) {
    handleMarketplaceError(error, 'update marketplace(s)')
  }
}

// plugin install (lines 5690–5721)
/**
 * `claude plugin install` 命令处理器：在指定作用域安装插件。
 *
 * 流程：
 * 1. 验证 scope 合法性（user/project/local），--cowork 时强制 user scope。
 * 2. 解析插件标识符，将插件名和市场名通过 PII 标记列写入分析日志
 *    （旧的 additional_metadata 明文记录方式已废弃，改用特权 BQ 列）。
 * 3. 调用 installPlugin() 实际完成安装（下载、解压、写入 bookkeeping）。
 */
export async function pluginInstallHandler(
  plugin: string,
  options: { scope?: string; cowork?: boolean },
): Promise<void> {
  if (options.cowork) setUseCoworkPlugins(true)
  const scope = options.scope || 'user'
  if (options.cowork && scope !== 'user') {
    cliError('--cowork can only be used with user scope')
  }
  if (
    !VALID_INSTALLABLE_SCOPES.includes(
      scope as (typeof VALID_INSTALLABLE_SCOPES)[number],
    )
  ) {
    cliError(
      `Invalid scope: ${scope}. Must be one of: ${VALID_INSTALLABLE_SCOPES.join(', ')}.`,
    )
  }
  // _PROTO_* routes to PII-tagged plugin_name/marketplace_name BQ columns.
  // Unredacted plugin arg was previously logged to general-access
  // additional_metadata for all users — dropped in favor of the privileged
  // column route. marketplace may be undefined (fires before resolution).
  // _PROTO_* 前缀表示该字段走特权 BigQuery 列（PII 标记），不进入通用访问的 additional_metadata
  const { name, marketplace } = parsePluginIdentifier(plugin)
  logEvent('tengu_plugin_install_command', {
    _PROTO_plugin_name: name as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
    ...(marketplace && {
      _PROTO_marketplace_name:
        marketplace as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
    }),
    scope: scope as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  })

  await installPlugin(plugin, scope as 'user' | 'project' | 'local')
}

// plugin uninstall (lines 5738–5769)
/**
 * `claude plugin uninstall` 命令处理器：卸载指定插件。
 *
 * 验证 scope 合法性后记录 PII 标记的分析事件，
 * 再调用 uninstallPlugin() 完成卸载（可选 --keepData 保留插件数据目录）。
 */
export async function pluginUninstallHandler(
  plugin: string,
  options: { scope?: string; cowork?: boolean; keepData?: boolean },
): Promise<void> {
  if (options.cowork) setUseCoworkPlugins(true)
  const scope = options.scope || 'user'
  if (options.cowork && scope !== 'user') {
    cliError('--cowork can only be used with user scope')
  }
  if (
    !VALID_INSTALLABLE_SCOPES.includes(
      scope as (typeof VALID_INSTALLABLE_SCOPES)[number],
    )
  ) {
    cliError(
      `Invalid scope: ${scope}. Must be one of: ${VALID_INSTALLABLE_SCOPES.join(', ')}.`,
    )
  }
  const { name, marketplace } = parsePluginIdentifier(plugin)
  logEvent('tengu_plugin_uninstall_command', {
    _PROTO_plugin_name: name as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
    ...(marketplace && {
      _PROTO_marketplace_name:
        marketplace as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
    }),
    scope: scope as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  })

  await uninstallPlugin(
    plugin,
    scope as 'user' | 'project' | 'local',
    options.keepData,
  )
}

// plugin enable (lines 5783–5818)
/**
 * `claude plugin enable` 命令处理器：在指定作用域启用插件。
 *
 * 作用域解析规则：
 *   - --cowork 且未指定 scope → 默认 user scope
 *   - --cowork 且 scope 非 user → 报错
 *   - 未指定 scope → 由 enablePlugin() 自动推断最佳作用域
 * 记录 PII 标记的分析事件后委托 enablePlugin() 执行。
 */
export async function pluginEnableHandler(
  plugin: string,
  options: { scope?: string; cowork?: boolean },
): Promise<void> {
  if (options.cowork) setUseCoworkPlugins(true)
  let scope: (typeof VALID_INSTALLABLE_SCOPES)[number] | undefined
  if (options.scope) {
    if (
      !VALID_INSTALLABLE_SCOPES.includes(
        options.scope as (typeof VALID_INSTALLABLE_SCOPES)[number],
      )
    ) {
      cliError(
        `Invalid scope "${options.scope}". Valid scopes: ${VALID_INSTALLABLE_SCOPES.join(', ')}`,
      )
    }
    scope = options.scope as (typeof VALID_INSTALLABLE_SCOPES)[number]
  }
  if (options.cowork && scope !== undefined && scope !== 'user') {
    cliError('--cowork can only be used with user scope')
  }

  // --cowork always operates at user scope
  // --cowork 未指定 scope 时，默认使用 user scope（cowork 插件仅支持用户级作用域）
  if (options.cowork && scope === undefined) {
    _PROTO_plugin_name: name as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
    ...(marketplace && {
      _PROTO_marketplace_name:
        marketplace as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
    }),
    scope: (scope ??
      'auto') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  })

  await enablePlugin(plugin, scope)
}

// plugin disable (lines 5833–5902)
/**
 * `claude plugin disable [plugin]` 命令处理器：禁用单个或所有插件。
 *
 * 两种模式：
 *   - --all：忽略 scope 参数，调用 disableAllPlugins() 禁用全部已启用插件；
 *     此模式下分析事件中 plugin_name 为 NULL（由空 logEvent 体标识）。
 *   - 指定 plugin 名称：验证 scope，记录 PII 标记的分析事件，
 *     调用 disablePlugin() 在指定作用域禁用该插件。
 * --cowork 与 --all 不兼容（scope 概念在 all 模式下无意义）。
 */
export async function pluginDisableHandler(
  plugin: string | undefined,
  options: { scope?: string; cowork?: boolean; all?: boolean },
): Promise<void> {
  if (options.all && plugin) {
    cliError('Cannot use --all with a specific plugin')
  }

  if (!options.all && !plugin) {
    cliError('Please specify a plugin name or use --all to disable all plugins')
  }

  if (options.cowork) setUseCoworkPlugins(true)

  if (options.all) {
    if (options.scope) {
      cliError('Cannot use --scope with --all')
    }

    // No _PROTO_plugin_name here — --all disables all plugins.
    // Distinguishable from the specific-plugin branch by plugin_name IS NULL.
    // --all 模式不上报具体插件名（BQ 中 plugin_name IS NULL 即为全量禁用事件）
    logEvent('tengu_plugin_disable_command', {})

    await disableAllPlugins()
    return
  }

  let scope: (typeof VALID_INSTALLABLE_SCOPES)[number] | undefined
  if (options.scope) {
    if (
      !VALID_INSTALLABLE_SCOPES.includes(
        options.scope as (typeof VALID_INSTALLABLE_SCOPES)[number],
      )
    ) {
      cliError(
        `Invalid scope "${options.scope}". Valid scopes: ${VALID_INSTALLABLE_SCOPES.join(', ')}`,
      )
    }
    scope = options.scope as (typeof VALID_INSTALLABLE_SCOPES)[number]
  }
  if (options.cowork && scope !== undefined && scope !== 'user') {
    cliError('--cowork can only be used with user scope')
  }

  // --cowork always operates at user scope
  // --cowork 未指定 scope 时，默认使用 user scope
  if (options.cowork && scope === undefined) {
    scope = 'user'
  }

  const { name, marketplace } = parsePluginIdentifier(plugin!)
  logEvent('tengu_plugin_disable_command', {
    _PROTO_plugin_name: name as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
    ...(marketplace && {
      _PROTO_marketplace_name:
        marketplace as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
    }),
    scope: (scope ??
      'auto') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  })

  await disablePlugin(plugin!, scope)
}

// plugin update (lines 5918–5948)
/**
 * `claude plugin update` 命令处理器：将插件更新至最新版本。
 *
 * 在记录 PII 标记的分析事件后，验证 scope 合法性（使用 VALID_UPDATE_SCOPES
 * 而非 VALID_INSTALLABLE_SCOPES，两者包含的作用域略有差异），
 * 最终委托 updatePluginCli() 执行实际更新操作。
 */
export async function pluginUpdateHandler(
  plugin: string,
  options: { scope?: string; cowork?: boolean },
): Promise<void> {
  if (options.cowork) setUseCoworkPlugins(true)
  const { name, marketplace } = parsePluginIdentifier(plugin)
  logEvent('tengu_plugin_update_command', {
    _PROTO_plugin_name: name as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
    ...(marketplace && {
      _PROTO_marketplace_name:
        marketplace as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
    }),
  })

  let scope: (typeof VALID_UPDATE_SCOPES)[number] = 'user'
  if (options.scope) {
    if (
      !VALID_UPDATE_SCOPES.includes(
        options.scope as (typeof VALID_UPDATE_SCOPES)[number],
      )
    ) {
      cliError(
        `Invalid scope "${options.scope}". Valid scopes: ${VALID_UPDATE_SCOPES.join(', ')}`,
      )
    }
    scope = options.scope as (typeof VALID_UPDATE_SCOPES)[number]
  }
  if (options.cowork && scope !== 'user') {
    cliError('--cowork can only be used with user scope')
  }

  await updatePluginCli(plugin, scope)
}
