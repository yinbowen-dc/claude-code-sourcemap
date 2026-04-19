/**
 * 插件标识符解析与作用域映射模块 — Claude Code 插件系统的标识层
 *
 * 在 Claude Code 插件系统中，此文件定义了插件标识符的核心数据结构和转换逻辑：
 *   插件 ID（"name@marketplace"）→ 解析/构建 → 作用域（scope）→ 设置源（settingSource）
 *
 * 职责：
 *   - 定义 ExtendedPluginScope（包含 'flag' 会话临时作用域）和 PersistablePluginScope
 *   - 维护 SettingSource → PluginScope 的映射常量 SETTING_SOURCE_TO_SCOPE
 *   - 提供 parsePluginIdentifier / buildPluginId 解析和构建插件 ID
 *   - 提供 isOfficialMarketplaceName 用于遥测脱敏判断
 *   - 提供 scopeToSettingSource / settingSourceToScope 双向转换
 *
 * 遥测注意：
 *   - 官方市场（ALLOWED_OFFICIAL_MARKETPLACE_NAMES）中的插件 ID 可以写入通用 additional_metadata
 *   - 第三方市场的插件 ID 含有 PII 风险，只能写入 PII 标记的 _PROTO_* BigQuery 列
 */

import type {
  EditableSettingSource,
  SettingSource,
} from '../settings/constants.js'
import {
  ALLOWED_OFFICIAL_MARKETPLACE_NAMES,
  type PluginScope,
} from './schemas.js'

/**
 * 扩展的插件作用域类型，包含 'flag'（会话临时）作用域。
 * 'flag' 作用域来自 --plugin-dir CLI 标志或 SDK plugins 选项，不持久化到 installed_plugins.json。
 */
export type ExtendedPluginScope = PluginScope | 'flag'

/**
 * 可持久化的插件作用域类型。
 * 排除 'flag'（会话临时），剩余作用域写入 installed_plugins.json。
 */
export type PersistablePluginScope = Exclude<ExtendedPluginScope, 'flag'>

/**
 * SettingSource → ExtendedPluginScope 的映射常量。
 *
 * 用于将设置读取来源转换为插件作用域语义：
 *   - policySettings → 'managed'（组织策略，只读）
 *   - userSettings   → 'user'（用户级别）
 *   - projectSettings→ 'project'（项目级别）
 *   - localSettings  → 'local'（本地级别）
 *   - flagSettings   → 'flag'（会话临时，不持久化）
 */
export const SETTING_SOURCE_TO_SCOPE = {
  policySettings: 'managed',
  userSettings: 'user',
  projectSettings: 'project',
  localSettings: 'local',
  flagSettings: 'flag',
} as const satisfies Record<SettingSource, ExtendedPluginScope>

/**
 * 已解析的插件标识符，包含名称和可选的市场名称。
 */
export type ParsedPluginIdentifier = {
  name: string       // 插件名称（@ 符号之前的部分）
  marketplace?: string  // 市场名称（@ 符号之后的部分，可选）
}

/**
 * 解析插件标识符字符串，拆分为名称和市场名称。
 *
 * 解析规则：
 *   - 以第一个 '@' 为分隔符
 *   - "plugin@marketplace" → { name: "plugin", marketplace: "marketplace" }
 *   - "plugin" → { name: "plugin" }
 *   - "plugin@a@b" → 只使用第一个 '@'，marketplace = "a"，忽略后续 '@b'
 *     （这是有意设计：市场名称不应包含 '@'）
 *
 * @param plugin - 插件标识符字符串
 * @returns 解析后的名称和市场名称
 */
export function parsePluginIdentifier(plugin: string): ParsedPluginIdentifier {
  if (plugin.includes('@')) {
    // 以 '@' 分割，取前两段：names[0] = 插件名，names[1] = 市场名
    const parts = plugin.split('@')
    return { name: parts[0] || '', marketplace: parts[1] }
  }
  // 无 '@' 时，整个字符串即为插件名
  return { name: plugin }
}

/**
 * 从名称和市场名称构建插件 ID 字符串。
 *
 * @param name - 插件名称
 * @param marketplace - 可选的市场名称
 * @returns 格式为 "name" 或 "name@marketplace" 的插件 ID
 */
export function buildPluginId(name: string, marketplace?: string): string {
  // 有市场名称时使用 @ 连接，否则只返回插件名
  return marketplace ? `${name}@${marketplace}` : name
}

/**
 * 判断市场名称是否为官方（Anthropic 控制）市场。
 *
 * 用于遥测脱敏：
 *   - 官方市场的插件 ID 可以安全写入通用 additional_metadata 日志列
 *   - 第三方市场的插件 ID 可能含有 PII，只能写入 _PROTO_* BQ 列
 *
 * @param marketplace - 市场名称（可为 undefined）
 * @returns 若为官方市场返回 true，否则返回 false
 */
export function isOfficialMarketplaceName(
  marketplace: string | undefined,
): boolean {
  return (
    marketplace !== undefined &&
    // 查询官方市场名称白名单（不区分大小写）
    ALLOWED_OFFICIAL_MARKETPLACE_NAMES.has(marketplace.toLowerCase())
  )
}

/**
 * 可安装插件作用域 → 可编辑设置源的映射表。
 * 这是 SETTING_SOURCE_TO_SCOPE 的逆向映射，仅覆盖可编辑作用域。
 * 注意：'managed' 作用域由策略控制，用户无法安装，故不包含在此映射中。
 */
const SCOPE_TO_EDITABLE_SOURCE: Record<
  Exclude<PluginScope, 'managed'>,
  EditableSettingSource
> = {
  user: 'userSettings',
  project: 'projectSettings',
  local: 'localSettings',
}

/**
 * 将插件作用域转换为对应的可编辑设置源。
 *
 * @param scope - 插件安装作用域
 * @returns 对应的设置源，用于读写 settings.json
 * @throws Error 若 scope 为 'managed'（策略作用域，用户无法安装）
 */
export function scopeToSettingSource(
  scope: PluginScope,
): EditableSettingSource {
  if (scope === 'managed') {
    // managed 作用域由组织策略控制，禁止用户安装
    throw new Error('Cannot install plugins to managed scope')
  }
  return SCOPE_TO_EDITABLE_SOURCE[scope]
}

/**
 * 将可编辑设置源转换为对应的插件作用域。
 * 从 SETTING_SOURCE_TO_SCOPE 派生，保持单一数据源。
 *
 * @param source - 设置源
 * @returns 对应的插件作用域（排除 'managed'）
 */
export function settingSourceToScope(
  source: EditableSettingSource,
): Exclude<PluginScope, 'managed'> {
  // 利用 SETTING_SOURCE_TO_SCOPE 常量做反向查询，保持映射一致性
  return SETTING_SOURCE_TO_SCOPE[source] as Exclude<PluginScope, 'managed'>
}
