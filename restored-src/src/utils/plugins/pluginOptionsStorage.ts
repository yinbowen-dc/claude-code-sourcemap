/**
 * 插件选项存储与变量替换模块 — Claude Code 插件配置持久化层
 *
 * 在 Claude Code 插件系统中，此文件负责插件用户配置选项的读写和变量替换：
 *   用户配置选项（manifest.userConfig）→ 按敏感性分流 → 非敏感: settings.json / 敏感: keychain
 *
 * 存储架构：
 *   - 非敏感选项（sensitive !== true）→ settings.json 的 pluginConfigs[pluginId].options
 *   - 敏感选项（sensitive === true）→ secureStorage（macOS 使用 keychain，其他平台使用 .credentials.json）
 *   - loadPluginOptions 读取时合并两个来源，secureStorage 在键冲突时胜出
 *
 * 变量替换：
 *   - ${CLAUDE_PLUGIN_ROOT}：插件版本化安装目录（更新时重建）
 *   - ${CLAUDE_PLUGIN_DATA}：插件持久化数据目录（更新后保留）
 *   - ${user_config.KEY}：用户配置值（MCP/LSP/hook 场景下替换；技能内容场景下敏感值替换为占位符）
 *
 * 注意：loadPluginOptions 使用 lodash memoize 按 pluginId 缓存，
 * /reload-plugins 时通过 clearPluginOptionsCache 清除。
 */

import memoize from 'lodash-es/memoize.js'
import type { LoadedPlugin } from '../../types/plugin.js'
import { logForDebugging } from '../debug.js'
import { logError } from '../log.js'
import { getSecureStorage } from '../secureStorage/index.js'
import {
  getSettings_DEPRECATED,
  updateSettingsForSource,
} from '../settings/settings.js'
import {
  type UserConfigSchema,
  type UserConfigValues,
  validateUserConfig,
} from './mcpbHandler.js'
import { getPluginDataDir } from './pluginDirectories.js'

// 重新导出类型别名，供外部模块使用
export type PluginOptionValues = UserConfigValues
export type PluginOptionSchema = UserConfigSchema

/**
 * 获取插件在 settings.json 和 secureStorage 中的存储键。
 *
 * 规则：存储键 = plugin.source，固定格式为 "${name}@${marketplace}"
 * （由 pluginLoader.ts 的 :1400 行设置）。
 * plugin.repository 是向后兼容别名，值与 source 相同，但不应用于存储。
 *
 * 此函数作为唯一存储键来源，未来若键格式变更只需修改此处。
 *
 * @param plugin - 已加载的插件对象
 * @returns 存储键字符串
 */
export function getPluginStorageId(plugin: LoadedPlugin): string {
  return plugin.source
}

/**
 * 加载插件已保存的配置选项，合并非敏感（来自 settings）和敏感（来自 secureStorage）两个来源。
 * secureStorage 的值在键冲突时胜出。
 *
 * 性能优化：使用 lodash memoize 按 pluginId 缓存，避免每次工具调用都重复读取：
 *   - macOS 上 keychain 读取（security find-generic-password）约 50-100ms（同步阻塞）
 *   - 每个 pluginId 在会话期间只读取一次
 *   - /reload-plugins 后通过 clearPluginOptionsCache 强制刷新
 */
export const loadPluginOptions = memoize(
  (pluginId: string): PluginOptionValues => {
    // 读取 settings.json 中的非敏感选项
    const settings = getSettings_DEPRECATED()
    const nonSensitive =
      settings.pluginConfigs?.[pluginId]?.options ?? ({} as PluginOptionValues)

    // 读取 secureStorage 中的敏感选项
    // 注意：macOS 上会阻塞约 50-100ms（spawn security 命令）
    // memoize 保证每个插件每会话只执行一次，不影响性能
    const storage = getSecureStorage()
    const sensitive =
      storage.read()?.pluginSecrets?.[pluginId] ??
      ({} as Record<string, string>)

    // 合并两个来源，secureStorage 胜出（更可信的来源）
    return { ...nonSensitive, ...sensitive }
  },
)

/**
 * 清除 loadPluginOptions 的 memoize 缓存。
 * 应在插件重新加载或设置变更后调用。
 */
export function clearPluginOptionsCache(): void {
  loadPluginOptions.cache?.clear?.()
}

/**
 * 保存插件配置选项，按敏感性分流到不同存储后端。
 *
 * 保存流程：
 *   1. 按 schema[key].sensitive 将 values 分为 sensitive 和 nonSensitive 两组
 *   2. 计算需要从另一存储中清除的键（防止配置漂移）
 *   3. 先写 secureStorage（keychain 失败时不污染 settings.json）
 *   4. 再写 settings.json（用 undefined 值标记待删除的敏感键）
 *   5. 清除 memoize 缓存，使下次读取获取最新数据
 *
 * @param pluginId - 插件存储键（来自 getPluginStorageId）
 * @param values - 要保存的配置值
 * @param schema - 配置选项 schema（含 sensitive 标志）
 */
export function savePluginOptions(
  pluginId: string,
  values: PluginOptionValues,
  schema: PluginOptionSchema,
): void {
  // 按敏感性分组
  const nonSensitive: PluginOptionValues = {}
  const sensitive: Record<string, string> = {}

  for (const [key, value] of Object.entries(values)) {
    if (schema[key]?.sensitive === true) {
      sensitive[key] = String(value)
    } else {
      nonSensitive[key] = value
    }
  }

  // 记录本次保存中各组的键集合，用于交叉清除
  const sensitiveKeysInThisSave = new Set(Object.keys(sensitive))
  const nonSensitiveKeysInThisSave = new Set(Object.keys(nonSensitive))

  // 步骤 1：先写 secureStorage（原子性：keychain 失败则整体不写 settings.json）
  const storage = getSecureStorage()
  const existingInSecureStorage =
    storage.read()?.pluginSecrets?.[pluginId] ?? undefined
  // 从 secureStorage 中删除此次改为非敏感的键（防止旧数据残留）
  const secureScrubbed = existingInSecureStorage
    ? Object.fromEntries(
        Object.entries(existingInSecureStorage).filter(
          ([k]) => !nonSensitiveKeysInThisSave.has(k),
        ),
      )
    : undefined
  const needSecureScrub =
    secureScrubbed &&
    existingInSecureStorage &&
    Object.keys(secureScrubbed).length !==
      Object.keys(existingInSecureStorage).length
  if (Object.keys(sensitive).length > 0 || needSecureScrub) {
    const existing = storage.read() ?? {}
    if (!existing.pluginSecrets) {
      existing.pluginSecrets = {}
    }
    existing.pluginSecrets[pluginId] = {
      ...secureScrubbed,
      ...sensitive,
    }
    const result = storage.update(existing)
    if (!result.success) {
      const err = new Error(
        `Failed to save sensitive plugin options for ${pluginId} to secure storage`,
      )
      logError(err)
      throw err
    }
    if (result.warning) {
      logForDebugging(`Plugin secrets save warning: ${result.warning}`, {
        level: 'warn',
      })
    }
  }

  // 步骤 2：写 settings.json（用 undefined 标记从 settings 删除的敏感键）
  //
  // TODO：getSettings_DEPRECATED 返回跨所有作用域的合并设置，
  // 向 userSettings 写回可能导致 project-scope 的 pluginConfigs 漏入 ~/.claude/settings.json。
  // 目前安全（pluginConfigs 只在此处写入 user 作用域），但若未来添加 project 作用域选项需修复。
  const settings = getSettings_DEPRECATED()
  const existingInSettings = settings.pluginConfigs?.[pluginId]?.options ?? {}
  // 找出需要从 settings 中删除的键（此次已改为敏感存储）
  const keysToScrubFromSettings = Object.keys(existingInSettings).filter(k =>
    sensitiveKeysInThisSave.has(k),
  )
  if (
    Object.keys(nonSensitive).length > 0 ||
    keysToScrubFromSettings.length > 0
  ) {
    if (!settings.pluginConfigs) {
      settings.pluginConfigs = {}
    }
    if (!settings.pluginConfigs[pluginId]) {
      settings.pluginConfigs[pluginId] = {}
    }
    // 用 undefined 标记待删除的键（mergeWith 会删除 undefined 的键）
    const scrubbed = Object.fromEntries(
      keysToScrubFromSettings.map(k => [k, undefined]),
    ) as Record<string, undefined>
    settings.pluginConfigs[pluginId].options = {
      ...nonSensitive,
      ...scrubbed,
    } as PluginOptionValues
    const result = updateSettingsForSource('userSettings', settings)
    if (result.error) {
      logError(result.error)
      throw new Error(
        `Failed to save plugin options for ${pluginId}: ${result.error.message}`,
      )
    }
  }

  // 清除 memoize 缓存，使下次读取获取最新数据
  clearPluginOptionsCache()
}

/**
 * 删除插件的所有已保存配置选项（非敏感 + 敏感两个存储后端）。
 *
 * 使用场景：插件被完全卸载时（最后一个安装实例被移除）。
 * 注意：不应在每次作用域卸载时调用——同一插件可能安装在多个作用域，
 * 配置应在所有作用域都卸载后才删除。
 *
 * 删除操作是"尽力而为"的：keychain 写入失败仅记录日志，不抛出异常，
 * 避免因清理副作用显示令人困惑的"卸载失败"消息。
 *
 * @param pluginId - 插件存储键
 */
export function deletePluginOptions(pluginId: string): void {
  // 从 settings.json 中删除 pluginConfigs[pluginId]
  // 使用 undefined 值（非 delete）触发 mergeWith 的删除逻辑
  const settings = getSettings_DEPRECATED()
  type PluginConfigs = NonNullable<typeof settings.pluginConfigs>
  if (settings.pluginConfigs?.[pluginId]) {
    // Partial<Record<K,V>> 允许 undefined 值，配合 mergeWith 删除语义
    const pluginConfigs: Partial<PluginConfigs> = { [pluginId]: undefined }
    const { error } = updateSettingsForSource('userSettings', {
      pluginConfigs: pluginConfigs as PluginConfigs,
    })
    if (error) {
      logForDebugging(
        `deletePluginOptions: failed to clear settings.pluginConfigs[${pluginId}]: ${error.message}`,
        { level: 'warn' },
      )
    }
  }

  // 从 secureStorage 中删除顶层 pluginSecrets[pluginId]
  // 以及所有 per-server 复合键 `${pluginId}/${server}`（来自 saveMcpServerUserConfig）
  // '/' 前缀匹配是安全的：插件 ID 格式为 "name@marketplace"，不含 '/'，不会误匹配其他插件
  const storage = getSecureStorage()
  const existing = storage.read()
  if (existing?.pluginSecrets) {
    const prefix = `${pluginId}/`
    // 保留不属于此插件的所有键
    const survivingEntries = Object.entries(existing.pluginSecrets).filter(
      ([k]) => k !== pluginId && !k.startsWith(prefix),
    )
    if (
      survivingEntries.length !== Object.keys(existing.pluginSecrets).length
    ) {
      const result = storage.update({
        ...existing,
        pluginSecrets:
          survivingEntries.length > 0
            ? Object.fromEntries(survivingEntries)
            : undefined,  // 若无剩余键，设为 undefined（清空）
      })
      if (!result.success) {
        logForDebugging(
          `deletePluginOptions: failed to clear pluginSecrets for ${pluginId} from keychain`,
          { level: 'warn' },
        )
      }
    }
  }

  // 清除 memoize 缓存
  clearPluginOptionsCache()
}

/**
 * 找出配置值不满足 schema 的选项键——即需要提示用户填写的字段。
 * 返回这些键的 schema 子集；若全部有效则返回空对象。
 * manifest.userConfig 为空或未定义时直接返回空对象。
 *
 * 被 PluginOptionsFlow 用于判断插件启用后是否需要显示配置提示。
 *
 * @param plugin - 已加载的插件对象
 * @returns 需要配置的选项 schema 子集
 */
export function getUnconfiguredOptions(
  plugin: LoadedPlugin,
): PluginOptionSchema {
  const manifestSchema = plugin.manifest.userConfig
  // manifest 中无配置选项时直接返回
  if (!manifestSchema || Object.keys(manifestSchema).length === 0) {
    return {}
  }

  // 加载当前已保存的配置值
  const saved = loadPluginOptions(getPluginStorageId(plugin))
  const validation = validateUserConfig(saved, manifestSchema)
  if (validation.valid) {
    // 所有字段均有效，无需重新配置
    return {}
  }

  // 逐字段检查，找出校验失败的字段
  const unconfigured: PluginOptionSchema = {}
  for (const [key, fieldSchema] of Object.entries(manifestSchema)) {
    const single = validateUserConfig(
      { [key]: saved[key] } as PluginOptionValues,
      { [key]: fieldSchema },
    )
    if (!single.valid) {
      unconfigured[key] = fieldSchema
    }
  }
  return unconfigured
}

/**
 * 替换字符串中的插件内置变量：${CLAUDE_PLUGIN_ROOT} 和 ${CLAUDE_PLUGIN_DATA}。
 *
 * 变量含义：
 *   - ${CLAUDE_PLUGIN_ROOT}：插件的版本化安装目录（每次更新后重建）
 *   - ${CLAUDE_PLUGIN_DATA}：插件的持久化数据目录（更新后保留）
 *
 * Windows 处理：将路径中的反斜杠转换为正斜杠，防止 shell 命令将其解释为转义字符。
 *
 * 安全细节：使用函数替换形式（.replace(pattern, () => value)），
 * 避免路径中的 $&, $`, $' 等特殊替换模式被误解释。
 *
 * 使用场景：MCP/LSP 服务器的 command/args/env，hook 命令，技能/代理内容。
 *
 * @param value - 含变量占位符的字符串
 * @param plugin - 包含 path（安装路径）和可选 source（存储 ID）的插件信息
 * @returns 替换后的字符串
 */
export function substitutePluginVariables(
  value: string,
  plugin: { path: string; source?: string },
): string {
  // Windows 下统一使用正斜杠
  const normalize = (p: string) =>
    process.platform === 'win32' ? p.replace(/\\/g, '/') : p
  // 替换 ${CLAUDE_PLUGIN_ROOT}
  let out = value.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, () =>
    normalize(plugin.path),
  )
  // 替换 ${CLAUDE_PLUGIN_DATA}（仅当 plugin.source 存在时替换）
  // source 可能缺失（如 hooks 中 pluginRoot 是技能根目录，无插件上下文）
  if (plugin.source) {
    const source = plugin.source
    out = out.replace(/\$\{CLAUDE_PLUGIN_DATA\}/g, () =>
      normalize(getPluginDataDir(source)),
    )
  }
  return out
}

/**
 * 替换字符串中的用户配置变量：${user_config.KEY}。
 *
 * 用于 MCP/LSP server 配置中的变量替换，在校验通过后调用。
 * 若遇到未声明的键（schema 中不存在），抛出错误以暴露插件开发 bug。
 *
 * 注意：技能/代理内容中请使用 substituteUserConfigInContent，
 * 该函数对敏感键做特殊处理（不暴露实际值到模型提示词中）。
 *
 * @param value - 含 ${user_config.KEY} 占位符的字符串
 * @param userConfig - 用户配置值映射表
 * @returns 替换后的字符串
 * @throws Error 若引用了未声明的配置键
 */
export function substituteUserConfigVariables(
  value: string,
  userConfig: PluginOptionValues,
): string {
  return value.replace(/\$\{user_config\.([^}]+)\}/g, (_match, key) => {
    const configValue = userConfig[key]
    if (configValue === undefined) {
      // 未声明的键：这是插件开发错误，应在变量替换前完成校验
      throw new Error(
        `Missing required user configuration value: ${key}. ` +
          `This should have been validated before variable substitution.`,
      )
    }
    return String(configValue)
  })
}

/**
 * 内容安全版本的用户配置变量替换，用于技能/代理 Markdown 内容。
 *
 * 与 substituteUserConfigVariables 的区别：
 *   - 敏感键（schema[key].sensitive === true）替换为描述性占位符，
 *     而非实际值（技能内容会进入模型提示词，不能包含密钥）
 *   - 未知键保持原样（不抛出异常），与 ${VAR} 环境变量的默认行为一致
 *
 * 若敏感键被引用，占位符会让插件作者注意到并将其移至 hook/MCP env 中。
 *
 * @param content - 含 ${user_config.KEY} 占位符的内容字符串
 * @param options - 用户配置值映射表
 * @param schema - 配置选项 schema（含 sensitive 标志）
 * @returns 替换后的字符串
 */
export function substituteUserConfigInContent(
  content: string,
  options: PluginOptionValues,
  schema: PluginOptionSchema,
): string {
  return content.replace(/\$\{user_config\.([^}]+)\}/g, (match, key) => {
    // 敏感键：替换为占位符，不暴露实际值到模型提示词
    if (schema[key]?.sensitive === true) {
      return `[sensitive option '${key}' not available in skill content]`
    }
    const value = options[key]
    if (value === undefined) {
      // 未知键：保持原样（不抛出）
      return match
    }
    return String(value)
  })
}
