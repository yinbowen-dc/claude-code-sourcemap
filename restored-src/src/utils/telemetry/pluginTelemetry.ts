/**
 * telemetry/pluginTelemetry.ts — 插件遥测辅助函数库
 *
 * 在 Claude Code 的分析体系中，本文件实现了插件生命周期事件的遥测上报，
 * 采用"双列隐私模式"（twin-column privacy pattern）保护用户定义的插件名称。
 *
 * 核心隐私设计：
 *   - 每个含有用户自定义名称的字段都对应两列：
 *     1. 原始值列（_PROTO_* 路由到 BigQuery PII 标记列，受限访问）
 *     2. 脱敏副本列（官方/内置插件保留真实名称，第三方插件替换为 'third-party'）
 *   - plugin_id_hash：使用 SHA-256(name@marketplace + FIXED_SALT) 截取 16 位，
 *     提供无隐私依赖的聚合键，可回答 DISTINCT COUNT 和趋势问题
 *
 * 主要功能：
 *   1. hashPluginId()                  — 生成插件不透明 ID（用于聚合）
 *   2. getTelemetryPluginScope()        — 判断插件来源范围
 *   3. buildPluginTelemetryFields()     — 构建公共遥测字段
 *   4. buildPluginCommandTelemetryFields() — 构建命令级遥测字段
 *   5. logPluginsEnabledForSession()    — 会话启动时上报启用的插件
 *   6. logPluginLoadErrors()            — 上报插件加载错误
 *   7. classifyPluginCommandError()     — 将错误消息分类为有界枚举
 */

import { createHash } from 'crypto'
import { sep } from 'path'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
  logEvent,
} from '../../services/analytics/index.js'
import type {
  LoadedPlugin,
  PluginError,
  PluginManifest,
} from '../../types/plugin.js'
import {
  isOfficialMarketplaceName,
  parsePluginIdentifier,
} from '../plugins/pluginIdentifier.js'

// 内联 BUILTIN_MARKETPLACE_NAME 以避免通过 commands.js 产生循环依赖
// Marketplace schemas.ts 保证 'builtin' 是保留字
const BUILTIN_MARKETPLACE_NAME = 'builtin'

/**
 * plugin_id_hash 的固定盐值。
 *
 * 在所有仓库和上报位置使用相同的常量——不按组织区分、不轮换：
 *   - 按组织盐会导致跨组织 DISTINCT COUNT 失效
 *   - 轮换会破坏趋势线
 *
 * 客户可以使用已知插件名计算相同的哈希，从而在自己的遥测数据中反向匹配。
 */
const PLUGIN_ID_HASH_SALT = 'claude-plugin-telemetry-v1'

/**
 * 计算插件的不透明聚合标识符（plugin_id_hash）。
 *
 * 算法：SHA-256(name@marketplace_lowercase + SALT)，截取前 16 个十六进制字符。
 *
 * 设计考量：
 *   - 16 字符在预计 10k 插件规模下碰撞概率可忽略不计
 *   - 保留插件名的大小写（enabledPlugins 键区分大小写）
 *   - marketplace 后缀统一转小写以确保可重现性
 *
 * @param name        - 插件名称
 * @param marketplace - 可选的市场名称
 * @returns 16 字符的十六进制哈希
 */
export function hashPluginId(name: string, marketplace?: string): string {
  // 构建哈希输入：name@marketplace（marketplace 转小写）或仅 name
  const key = marketplace ? `${name}@${marketplace.toLowerCase()}` : name
  return createHash('sha256')
    .update(key + PLUGIN_ID_HASH_SALT) // 追加固定盐值
    .digest('hex')
    .slice(0, 16) // 截取前 16 字符
}

/**
 * 插件来源范围的 4 值枚举。
 *
 * 注意：与 PluginScope（managed/user/project/local，表示安装目标）不同，
 * 这里表示的是市场来源（marketplace origin）：
 *
 *   - official      : 来自 Anthropic 允许列表中的官方市场
 *   - default-bundle: 随产品内置（@builtin），自动启用
 *   - org           : 企业管理员通过 policySettings 推送
 *   - user-local    : 用户手动添加的市场或本地插件
 */
export type TelemetryPluginScope =
  | 'official'
  | 'org'
  | 'user-local'
  | 'default-bundle'

/**
 * 根据插件名称、市场和管理名称集合确定插件的来源范围。
 *
 * 判断优先级（从高到低）：
 *   1. builtin 市场 → 'default-bundle'
 *   2. 官方市场（允许列表） → 'official'
 *   3. 在管理名称集合中 → 'org'
 *   4. 其他 → 'user-local'
 *
 * @param name         - 插件名称
 * @param marketplace  - 市场名称（可能为 undefined）
 * @param managedNames - 组织管理的插件名称集合（可能为 null）
 */
export function getTelemetryPluginScope(
  name: string,
  marketplace: string | undefined,
  managedNames: Set<string> | null,
): TelemetryPluginScope {
  if (marketplace === BUILTIN_MARKETPLACE_NAME) return 'default-bundle'
  if (isOfficialMarketplaceName(marketplace)) return 'official'
  if (managedNames?.has(name)) return 'org'
  return 'user-local'
}

/**
 * 插件进入本次会话的方式枚举。
 *
 * 补充 plugin_scope 的语义（plugin_scope 不区分用户安装与组织推送，
 * 因为官方插件既可以是用户安装的，也可以是组织推送的）：
 *
 *   - user-install  : 用户主动安装
 *   - org-policy    : 组织策略强制启用
 *   - default-enable: 产品内置默认启用
 *   - seed-mount    : 通过种子目录挂载
 */
export type EnabledVia =
  | 'user-install'
  | 'org-policy'
  | 'default-enable'
  | 'seed-mount'

/** 技能/命令调用的触发方式 */
export type InvocationTrigger =
  | 'user-slash'        // 用户通过 /命令 主动触发
  | 'claude-proactive'  // Claude 主动调用
  | 'nested-skill'      // 技能嵌套调用

/** 技能调用的执行上下文 */
export type SkillExecutionContext =
  | 'fork'    // 在子进程中执行
  | 'inline'  // 内联执行（当前进程）
  | 'remote'  // 远程执行

/** 插件安装的发起方式 */
export type InstallSource =
  | 'cli-explicit'   // CLI 显式安装命令
  | 'ui-discover'    // 通过 UI 发现并安装
  | 'ui-suggestion'  // UI 建议安装
  | 'deep-link'      // 通过深度链接安装

/**
 * 确定插件进入当前会话的方式（EnabledVia）。
 *
 * 判断优先级：
 *   1. 内置插件（isBuiltin） → 'default-enable'
 *   2. 在管理名称集合中 → 'org-policy'
 *   3. 路径以种子目录开头 → 'seed-mount'（使用路径分隔符防止前缀误匹配）
 *   4. 其他 → 'user-install'
 *
 * @param plugin       - 已加载的插件对象
 * @param managedNames - 组织管理的插件名称集合
 * @param seedDirs     - 种子目录路径列表
 */
export function getEnabledVia(
  plugin: LoadedPlugin,
  managedNames: Set<string> | null,
  seedDirs: string[],
): EnabledVia {
  if (plugin.isBuiltin) return 'default-enable'
  if (managedNames?.has(plugin.name)) return 'org-policy'
  // 路径分隔符检查：/opt/plugins 不能误匹配 /opt/plugins-extra
  if (
    seedDirs.some(dir =>
      plugin.path.startsWith(dir.endsWith(sep) ? dir : dir + sep),
    )
  ) {
    return 'seed-mount'
  }
  return 'user-install'
}

/**
 * 构建基于 name@marketplace 的公共插件遥测字段。
 *
 * 返回哈希、范围枚举和脱敏双列字段。
 * 原始的 _PROTO_* PII 字段由调用方单独添加（需要 PII 标记类型）。
 *
 * 脱敏规则：
 *   - Anthropic 控制的插件（官方市场 + 内置）→ 保留真实名称
 *   - 第三方插件 → 名称和市场名均替换为 'third-party'
 *
 * @param name         - 插件名称
 * @param marketplace  - 市场名称（可能为 undefined）
 * @param managedNames - 组织管理名称集合（默认 null）
 */
export function buildPluginTelemetryFields(
  name: string,
  marketplace: string | undefined,
  managedNames: Set<string> | null = null,
): {
  plugin_id_hash: AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
  plugin_scope: AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
  plugin_name_redacted: AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
  marketplace_name_redacted: AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
  is_official_plugin: boolean
} {
  const scope = getTelemetryPluginScope(name, marketplace, managedNames)
  // 官方市场和内置插件均由 Anthropic 控制，脱敏列中可以保留真实名称
  const isAnthropicControlled =
    scope === 'official' || scope === 'default-bundle'
  return {
    // 无隐私依赖的聚合键（可用于 DISTINCT COUNT 等操作）
    plugin_id_hash: hashPluginId(
      name,
      marketplace,
    ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    // 来源范围枚举（4 个有界值）
    plugin_scope:
      scope as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    // 脱敏插件名：Anthropic 控制则保留，否则为 'third-party'
    plugin_name_redacted: (isAnthropicControlled
      ? name
      : 'third-party') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    // 脱敏市场名：Anthropic 控制且有市场名则保留，否则为 'third-party'
    marketplace_name_redacted: (isAnthropicControlled && marketplace
      ? marketplace
      : 'third-party') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    is_official_plugin: isAnthropicControlled,
  }
}

/**
 * 构建命令级插件遥测字段（per-invocation 版本）。
 *
 * 调用方（SkillTool、processSlashCommand）传入 managedNames=null，
 * 因为每次调用时读取设置的开销不值得。
 * 会话级的 tengu_plugin_enabled_for_session 事件会携带权威的 plugin_scope，
 * 而每次调用的记录可以通过 plugin_id_hash 连接（JOIN）获取范围信息。
 *
 * @param pluginInfo   - 包含插件 manifest 和 repository 的对象
 * @param managedNames - 组织管理名称集合（热路径中传入 null）
 */
export function buildPluginCommandTelemetryFields(
  pluginInfo: { pluginManifest: PluginManifest; repository: string },
  managedNames: Set<string> | null = null,
): ReturnType<typeof buildPluginTelemetryFields> {
  // 从 repository 字符串中解析出 marketplace 信息
  const { marketplace } = parsePluginIdentifier(pluginInfo.repository)
  return buildPluginTelemetryFields(
    pluginInfo.pluginManifest.name,
    marketplace,
    managedNames,
  )
}

/**
 * 在会话启动时为每个已启用的插件发射 tengu_plugin_enabled_for_session 事件。
 *
 * 补充 tengu_skill_loaded（仍按技能粒度触发）：
 *   - 本函数用于插件级聚合（不需要 DISTINCT-on-prefix 等技巧）
 *   - 一个含 5 个技能的插件会产生 5 条 skill_loaded 记录但只有 1 条本事件
 *
 * 事件字段包含：插件名（PII 标记）、市场名、哈希、范围、启用方式、
 * 路径数量、是否有 MCP 服务器、是否有 Hooks 配置、版本号等。
 *
 * @param plugins      - 已加载的插件列表
 * @param managedNames - 组织管理名称集合
 * @param seedDirs     - 种子目录路径列表
 */
export function logPluginsEnabledForSession(
  plugins: LoadedPlugin[],
  managedNames: Set<string> | null,
  seedDirs: string[],
): void {
  for (const plugin of plugins) {
    // 从 repository 标识符解析市场名
    const { marketplace } = parsePluginIdentifier(plugin.repository)

    logEvent('tengu_plugin_enabled_for_session', {
      // 原始插件名（路由到 BQ PII 标记列）
      _PROTO_plugin_name:
        plugin.name as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
      // 原始市场名（若存在，路由到 BQ PII 标记列）
      ...(marketplace && {
        _PROTO_marketplace_name:
          marketplace as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
      }),
      // 公共遥测字段（哈希、范围、脱敏名称）
      ...buildPluginTelemetryFields(plugin.name, marketplace, managedNames),
      // 插件进入会话的方式
      enabled_via: getEnabledVia(
        plugin,
        managedNames,
        seedDirs,
      ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      // 技能路径数量（skillsPath + skillsPaths 之和）
      skill_path_count:
        (plugin.skillsPath ? 1 : 0) + (plugin.skillsPaths?.length ?? 0),
      // 命令路径数量（commandsPath + commandsPaths 之和）
      command_path_count:
        (plugin.commandsPath ? 1 : 0) + (plugin.commandsPaths?.length ?? 0),
      // 是否包含 MCP 服务器配置
      has_mcp: plugin.manifest.mcpServers !== undefined,
      // 是否包含 Hooks 配置
      has_hooks: plugin.hooksConfig !== undefined,
      // 可选的版本号字段
      ...(plugin.manifest.version && {
        version: plugin.manifest
          .version as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      }),
    })
  }
}

/**
 * CLI 插件操作失败的有界错误分类枚举。
 *
 * 将自由格式的错误消息映射为 5 个稳定类别，
 * 使仪表板 GROUP BY 查询保持可控基数：
 *   - network    : 网络连接相关错误
 *   - not-found  : 资源不存在（404 等）
 *   - permission : 权限/认证错误
 *   - validation : 数据格式/校验错误
 *   - unknown    : 无法分类的其他错误
 */
export type PluginCommandErrorCategory =
  | 'network'
  | 'not-found'
  | 'permission'
  | 'validation'
  | 'unknown'

/**
 * 将错误对象分类为有界错误类别。
 *
 * 通过正则表达式匹配错误消息，按优先级依次检测：
 *   1. 网络错误关键词（ENOTFOUND、ECONNREFUSED、ETIMEDOUT 等）
 *   2. 资源不存在关键词（404、not found、does not exist 等）
 *   3. 权限错误关键词（401、403、EACCES、permission denied 等）
 *   4. 校验错误关键词（invalid、malformed、schema、validation 等）
 *   5. 无法匹配 → 'unknown'
 *
 * @param error - 捕获到的错误对象
 * @returns 5 值错误类别枚举
 */
export function classifyPluginCommandError(
  error: unknown,
): PluginCommandErrorCategory {
  // 提取错误消息字符串，兼容 Error 对象和非标准错误
  const msg = String((error as { message?: unknown })?.message ?? error)

  // 网络层错误：DNS 失败、连接被拒绝、超时等
  if (
    /ENOTFOUND|ECONNREFUSED|EAI_AGAIN|ETIMEDOUT|ECONNRESET|network|Could not resolve|Connection refused|timed out/i.test(
      msg,
    )
  ) {
    return 'network'
  }

  // 资源不存在错误：404 状态码或文字描述
  if (/\b404\b|not found|does not exist|no such plugin/i.test(msg)) {
    return 'not-found'
  }

  // 权限/认证错误：4xx 状态码（401/403）或 POSIX 权限错误
  if (/\b40[13]\b|EACCES|EPERM|permission denied|unauthorized/i.test(msg)) {
    return 'permission'
  }

  // 数据校验错误：JSON 解析、Schema 校验等
  if (/invalid|malformed|schema|validation|parse error/i.test(msg)) {
    return 'validation'
  }

  return 'unknown'
}

/**
 * 在会话启动时为每个插件加载错误发射 tengu_plugin_load_failed 事件。
 *
 * 与 tengu_plugin_enabled_for_session 配对使用，仪表板可以计算加载成功率。
 * PluginError.type 本身已经是有界枚举，直接用作 error_category。
 *
 * @param errors       - 插件加载错误列表
 * @param managedNames - 组织管理名称集合
 */
export function logPluginLoadErrors(
  errors: PluginError[],
  managedNames: Set<string> | null,
): void {
  for (const err of errors) {
    // 从错误来源解析插件名和市场名
    const { name, marketplace } = parsePluginIdentifier(err.source)
    // 并非所有 PluginError 变体都有 name 字段（有些有 pluginId，有些是市场级错误）
    // 优先使用 'plugin' 属性，回退到从 err.source 解析的名称
    const pluginName = 'plugin' in err && err.plugin ? err.plugin : name
    logEvent('tengu_plugin_load_failed', {
      // 错误类别（来自 PluginError.type 枚举，已有界）
      error_category:
        err.type as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      // 原始插件名（路由到 BQ PII 标记列）
      _PROTO_plugin_name:
        pluginName as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
      // 原始市场名（若存在）
      ...(marketplace && {
        _PROTO_marketplace_name:
          marketplace as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
      }),
      // 公共遥测字段（哈希、范围、脱敏名称）
      ...buildPluginTelemetryFields(pluginName, marketplace, managedNames),
    })
  }
}
