/**
 * 插件 CLI 命令包装层
 *
 * 在 Claude Code 系统流程中的位置：
 * 本文件是插件子系统的 CLI 交互层，封装核心插件操作以适配命令行使用场景（进度输出、进程退出等）。
 * 它位于以下层次结构中：
 *   - 调用方：CLI 入口（`claude plugin install/uninstall/enable/disable/update`）
 *   - 本模块：为每条 CLI 命令提供 console.log + process.exit 包装
 *   - 下层：pluginOperations.ts（纯库函数，无副作用）
 *
 * 主要功能：
 * - handlePluginCommandError：通用错误处理，记录 tengu_plugin_command_failed 后 process.exit(1)
 * - installPlugin：安装插件，记录 tengu_plugin_installed_cli 分析事件
 * - uninstallPlugin：卸载插件，记录 tengu_plugin_uninstalled_cli 分析事件
 * - enablePlugin：启用插件，记录 tengu_plugin_enabled_cli 分析事件
 * - disablePlugin：禁用插件，记录 tengu_plugin_disabled_cli 分析事件
 * - disableAllPlugins：禁用所有插件，记录 tengu_plugin_disabled_all_cli 分析事件
 * - updatePluginCli：更新插件（使用 writeToStdout + gracefulShutdown，区别于其他命令的 process.exit）
 *
 * 设计说明：
 * - 所有 PII 字段（插件名、市场名）均通过 _PROTO_* 前缀路由到 BigQuery 受保护列
 * - updatePluginCli 使用 gracefulShutdown(0) 而非 process.exit(0)，以确保异步清理完成
 * - 重新导出 VALID_INSTALLABLE_SCOPES 和 VALID_UPDATE_SCOPES 供 CLI 入口使用
 */

/**
 * CLI command wrappers for plugin operations
 *
 * This module provides thin wrappers around the core plugin operations
 * that handle CLI-specific concerns like console output and process exit.
 *
 * For the core operations (without CLI side effects), see pluginOperations.ts
 */
import figures from 'figures'
import { errorMessage } from '../../utils/errors.js'
import { gracefulShutdown } from '../../utils/gracefulShutdown.js'
import { logError } from '../../utils/log.js'
import { getManagedPluginNames } from '../../utils/plugins/managedPlugins.js'
import { parsePluginIdentifier } from '../../utils/plugins/pluginIdentifier.js'
import type { PluginScope } from '../../utils/plugins/schemas.js'
import { writeToStdout } from '../../utils/process.js'
import {
  buildPluginTelemetryFields,
  classifyPluginCommandError,
} from '../../utils/telemetry/pluginTelemetry.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
  logEvent,
} from '../analytics/index.js'
import {
  disableAllPluginsOp,
  disablePluginOp,
  enablePluginOp,
  type InstallableScope,
  installPluginOp,
  uninstallPluginOp,
  updatePluginOp,
  VALID_INSTALLABLE_SCOPES,
  VALID_UPDATE_SCOPES,
} from './pluginOperations.js'

// 重新导出有效作用域常量，供 CLI 入口解析命令行参数时使用
export { VALID_INSTALLABLE_SCOPES, VALID_UPDATE_SCOPES }

// CLI 命令枚举类型：限制 handlePluginCommandError 的 command 参数范围
type PluginCliCommand =
  | 'install'
  | 'uninstall'
  | 'enable'
  | 'disable'
  | 'disable-all'
  | 'update'

/**
 * 插件 CLI 命令通用错误处理函数
 *
 * 在任何插件 CLI 命令失败时调用，执行以下操作：
 * 1. 调用 logError 记录错误到日志系统
 * 2. 输出格式化错误信息到 stderr（含 ✖ 前缀）
 * 3. 构建遥测字段（含 PII 标记的插件名和市场名）
 * 4. 记录 tengu_plugin_command_failed 分析事件（含 command + error_category）
 * 5. 调用 process.exit(1) 终止进程（非零退出码表示错误）
 *
 * 此函数返回类型为 never，确保调用方的 TypeScript 类型检查正确处理控制流。
 *
 * @param error 捕获的错误对象
 * @param command 失败的 CLI 命令名称
 * @param plugin 可选的插件标识符（用于遥测字段构建）
 */
function handlePluginCommandError(
  error: unknown,
  command: PluginCliCommand,
  plugin?: string,
): never {
  // 记录错误到调试日志系统
  logError(error)
  // 构建用户友好的操作描述（插件专属 or 全局命令）
  const operation = plugin
    ? `${command} plugin "${plugin}"`
    : command === 'disable-all'
      ? 'disable all plugins'
      : `${command} plugins`
  // biome-ignore lint/suspicious/noConsole:: intentional console output
  // 输出错误信息到 stderr，包含 ✖ 符号和错误详情
  console.error(
    `${figures.cross} Failed to ${operation}: ${errorMessage(error)}`,
  )
  // 若提供了插件标识符，解析插件名和市场名以构建遥测字段
  const telemetryFields = plugin
    ? (() => {
        const { name, marketplace } = parsePluginIdentifier(plugin)
        return {
          // _PROTO_* 前缀：路由到 BigQuery PII 标记列（不进入通用 additional_metadata）
          _PROTO_plugin_name:
            name as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
          ...(marketplace && {
            _PROTO_marketplace_name:
              marketplace as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
          }),
          // 构建托管插件相关的遥测字段（是否为托管插件等）
          ...buildPluginTelemetryFields(
            name,
            marketplace,
            getManagedPluginNames(),
          ),
        }
      })()
    : {}
  // 记录失败事件到分析系统，含命令名称和错误分类
  logEvent('tengu_plugin_command_failed', {
    command:
      command as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    // classifyPluginCommandError：将错误分为 not_found / already_installed 等标准类别
    error_category: classifyPluginCommandError(
      error,
    ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    ...telemetryFields,
  })
  // eslint-disable-next-line custom-rules/no-process-exit
  // 以非零退出码终止进程，表示命令执行失败
  process.exit(1)
}

/**
 * CLI 命令：非交互式安装插件
 *
 * 完整流程：
 * 1. 向 stdout 输出安装进度提示
 * 2. 调用 installPluginOp 执行核心安装逻辑
 * 3. 若失败（result.success === false），抛出错误交由 handlePluginCommandError 处理
 * 4. 成功则输出 ✔ 结果消息
 * 5. 解析实际安装的 pluginId，记录 tengu_plugin_installed_cli 分析事件
 * 6. process.exit(0) 正常退出
 *
 * 注意：PII 字段（插件名、市场名）通过 _PROTO_* 前缀路由到受保护列，
 * 不进入通用的 additional_metadata（防止日志泄露）。
 *
 * @param plugin 插件标识符（名称或 plugin@marketplace 格式）
 * @param scope 安装作用域：user、project 或 local（默认 'user'）
 */
export async function installPlugin(
  plugin: string,
  scope: InstallableScope = 'user',
): Promise<void> {
  try {
    // biome-ignore lint/suspicious/noConsole:: intentional console output
    // 输出安装进度提示
    console.log(`Installing plugin "${plugin}"...`)

    // 执行核心安装操作（纯库函数，无副作用）
    const result = await installPluginOp(plugin, scope)

    if (!result.success) {
      // 操作失败：抛出错误，交由 catch 块中的 handlePluginCommandError 处理
      throw new Error(result.message)
    }

    // biome-ignore lint/suspicious/noConsole:: intentional console output
    // 安装成功：输出带 ✔ 前缀的结果消息
    console.log(`${figures.tick} ${result.message}`)

    // _PROTO_* routes to PII-tagged plugin_name/marketplace_name BQ columns.
    // Unredacted plugin_id was previously logged to general-access
    // additional_metadata for all users — dropped in favor of the privileged
    // column route.
    // 解析实际安装的 pluginId（优先使用 result.pluginId，fallback 到输入的 plugin）
    const { name, marketplace } = parsePluginIdentifier(
      result.pluginId || plugin,
    )
    // 记录安装成功事件，PII 字段走受保护列路由
    logEvent('tengu_plugin_installed_cli', {
      _PROTO_plugin_name:
        name as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
      ...(marketplace && {
        _PROTO_marketplace_name:
          marketplace as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
      }),
      scope: (result.scope ||
        scope) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      // install_source: cli-explicit 表示用户主动通过 CLI 安装（区别于自动安装）
      install_source:
        'cli-explicit' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      ...buildPluginTelemetryFields(name, marketplace, getManagedPluginNames()),
    })

    // eslint-disable-next-line custom-rules/no-process-exit
    // 正常退出，退出码 0 表示命令执行成功
    process.exit(0)
  } catch (error) {
    // 统一错误处理：记录日志 + 分析事件 + process.exit(1)
    handlePluginCommandError(error, 'install', plugin)
  }
}

/**
 * CLI 命令：非交互式卸载插件
 *
 * 完整流程：
 * 1. 调用 uninstallPluginOp 执行核心卸载逻辑（含 deleteDataDir 参数由 keepData 控制）
 * 2. 若失败，抛出错误交由 handlePluginCommandError 处理
 * 3. 成功则输出 ✔ 结果消息
 * 4. 记录 tengu_plugin_uninstalled_cli 分析事件
 * 5. process.exit(0) 正常退出
 *
 * @param plugin 插件名称或 plugin@marketplace 标识符
 * @param scope 卸载作用域：user、project 或 local（默认 'user'）
 * @param keepData 是否保留插件数据目录（默认 false，即删除数据）
 */
export async function uninstallPlugin(
  plugin: string,
  scope: InstallableScope = 'user',
  keepData = false,
): Promise<void> {
  try {
    // deleteDataDir = !keepData：keepData=true 时保留数据目录，false 时删除
    const result = await uninstallPluginOp(plugin, scope, !keepData)

    if (!result.success) {
      throw new Error(result.message)
    }

    // biome-ignore lint/suspicious/noConsole:: intentional console output
    // 卸载成功：输出结果消息
    console.log(`${figures.tick} ${result.message}`)

    // 解析插件标识符，构建遥测字段
    const { name, marketplace } = parsePluginIdentifier(
      result.pluginId || plugin,
    )
    // 记录卸载成功事件
    logEvent('tengu_plugin_uninstalled_cli', {
      _PROTO_plugin_name:
        name as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
      ...(marketplace && {
        _PROTO_marketplace_name:
          marketplace as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
      }),
      scope: (result.scope ||
        scope) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      ...buildPluginTelemetryFields(name, marketplace, getManagedPluginNames()),
    })

    // eslint-disable-next-line custom-rules/no-process-exit
    process.exit(0)
  } catch (error) {
    handlePluginCommandError(error, 'uninstall', plugin)
  }
}

/**
 * CLI 命令：非交互式启用插件
 *
 * 完整流程：
 * 1. 调用 enablePluginOp 执行核心启用逻辑（settings-first，作用域自动检测）
 * 2. 若失败，抛出错误
 * 3. 成功则输出 ✔ 结果消息，记录 tengu_plugin_enabled_cli 事件
 * 4. process.exit(0) 正常退出
 *
 * @param plugin 插件名称或 plugin@marketplace 标识符
 * @param scope 可选作用域。若未提供，自动检测当前项目最具体的作用域
 */
export async function enablePlugin(
  plugin: string,
  scope?: InstallableScope,
): Promise<void> {
  try {
    // 执行启用操作，scope 可选（自动检测 local > project > user）
    const result = await enablePluginOp(plugin, scope)

    if (!result.success) {
      throw new Error(result.message)
    }

    // biome-ignore lint/suspicious/noConsole:: intentional console output
    // 启用成功：输出结果消息
    console.log(`${figures.tick} ${result.message}`)

    const { name, marketplace } = parsePluginIdentifier(
      result.pluginId || plugin,
    )
    // 记录启用成功事件，result.scope 为实际解析到的作用域
    logEvent('tengu_plugin_enabled_cli', {
      _PROTO_plugin_name:
        name as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
      ...(marketplace && {
        _PROTO_marketplace_name:
          marketplace as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
      }),
      scope:
        result.scope as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      ...buildPluginTelemetryFields(name, marketplace, getManagedPluginNames()),
    })

    // eslint-disable-next-line custom-rules/no-process-exit
    process.exit(0)
  } catch (error) {
    handlePluginCommandError(error, 'enable', plugin)
  }
}

/**
 * CLI 命令：非交互式禁用插件
 *
 * 完整流程：
 * 1. 调用 disablePluginOp 执行核心禁用逻辑
 * 2. 若失败，抛出错误
 * 3. 成功则输出 ✔ 结果消息，记录 tengu_plugin_disabled_cli 事件
 * 4. process.exit(0) 正常退出
 *
 * @param plugin 插件名称或 plugin@marketplace 标识符
 * @param scope 可选作用域。若未提供，自动检测当前项目最具体的作用域
 */
export async function disablePlugin(
  plugin: string,
  scope?: InstallableScope,
): Promise<void> {
  try {
    const result = await disablePluginOp(plugin, scope)

    if (!result.success) {
      throw new Error(result.message)
    }

    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.log(`${figures.tick} ${result.message}`)

    const { name, marketplace } = parsePluginIdentifier(
      result.pluginId || plugin,
    )
    logEvent('tengu_plugin_disabled_cli', {
      _PROTO_plugin_name:
        name as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
      ...(marketplace && {
        _PROTO_marketplace_name:
          marketplace as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
      }),
      scope:
        result.scope as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      ...buildPluginTelemetryFields(name, marketplace, getManagedPluginNames()),
    })

    // eslint-disable-next-line custom-rules/no-process-exit
    process.exit(0)
  } catch (error) {
    handlePluginCommandError(error, 'disable', plugin)
  }
}

/**
 * CLI 命令：非交互式禁用所有已启用插件
 *
 * 完整流程：
 * 1. 调用 disableAllPluginsOp 批量禁用所有已启用插件
 * 2. 若部分失败（success=false），抛出错误（含失败详情）
 * 3. 成功则输出 ✔ 结果消息，记录 tengu_plugin_disabled_all_cli 事件（无 PII 字段）
 * 4. process.exit(0) 正常退出
 */
export async function disableAllPlugins(): Promise<void> {
  try {
    const result = await disableAllPluginsOp()

    if (!result.success) {
      throw new Error(result.message)
    }

    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.log(`${figures.tick} ${result.message}`)

    // 无 PII 字段：禁用全部无需记录具体插件名
    logEvent('tengu_plugin_disabled_all_cli', {})

    // eslint-disable-next-line custom-rules/no-process-exit
    process.exit(0)
  } catch (error) {
    handlePluginCommandError(error, 'disable-all')
  }
}

/**
 * CLI 命令：非交互式更新插件
 *
 * 与其他命令的区别：
 * - 使用 writeToStdout 而非 console.log（与 REPL 的输出流一致）
 * - 使用 gracefulShutdown(0) 而非 process.exit(0)（确保异步清理完成）
 * - 仅在实际发生版本更新时（!result.alreadyUpToDate）才记录分析事件
 *
 * 完整流程：
 * 1. 通过 writeToStdout 输出检查更新进度提示
 * 2. 调用 updatePluginOp 执行核心更新（下载 → 版本计算 → 缓存 → 更新 V2 文件）
 * 3. 若失败，抛出错误
 * 4. 成功则输出 ✔ 结果消息
 * 5. 若有实际更新，记录 tengu_plugin_updated_cli 事件（含 old_version/new_version）
 * 6. gracefulShutdown(0) 优雅退出
 *
 * @param plugin 插件名称或 plugin@marketplace 标识符
 * @param scope 要更新的作用域（含 managed，允许更新托管插件）
 */
export async function updatePluginCli(
  plugin: string,
  scope: PluginScope,
): Promise<void> {
  try {
    // 使用 writeToStdout 而非 console.log，与 REPL 输出流保持一致
    writeToStdout(
      `Checking for updates for plugin "${plugin}" at ${scope} scope…\n`,
    )

    const result = await updatePluginOp(plugin, scope)

    if (!result.success) {
      throw new Error(result.message)
    }

    // 输出更新结果（可能是"已是最新"或"更新成功"）
    writeToStdout(`${figures.tick} ${result.message}\n`)

    // alreadyUpToDate=true 时跳过分析事件（无实际更新）
    if (!result.alreadyUpToDate) {
      const { name, marketplace } = parsePluginIdentifier(
        result.pluginId || plugin,
      )
      // 记录更新事件，含版本号变化信息（old_version → new_version）
      logEvent('tengu_plugin_updated_cli', {
        _PROTO_plugin_name:
          name as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
        ...(marketplace && {
          _PROTO_marketplace_name:
            marketplace as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
        }),
        old_version: (result.oldVersion ||
          'unknown') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        new_version: (result.newVersion ||
          'unknown') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        ...buildPluginTelemetryFields(
          name,
          marketplace,
          getManagedPluginNames(),
        ),
      })
    }

    // gracefulShutdown：优雅关闭，确保所有异步清理（如日志刷新）在退出前完成
    await gracefulShutdown(0)
  } catch (error) {
    handlePluginCommandError(error, 'update', plugin)
  }
}
