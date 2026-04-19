/**
 * 已标记插件追踪管理模块。
 *
 * 在 Claude Code 插件系统流程中，本文件处于"插件下架处理"层：
 *   - 当插件从市场下架后，pluginBlocklist.ts 会调用本模块将其标记（flagged）；
 *   - 标记信息持久化到 ~/.claude/plugins/flagged-plugins.json；
 *   - 被标记的插件在 /plugins 界面中以"已标记"分区显示，直到用户手动解除；
 *   - 用户看到通知后（markFlaggedPluginsSeen），48 小时后条目自动清除，
 *     避免已处理的通知永久残留。
 *
 * 缓存设计：
 *   使用模块级内存缓存（cache），使 getFlaggedPlugins() 可在 React 渲染中
 *   同步调用（渲染函数不能直接 await）。缓存由首次异步调用预热，
 *   并在每次写入时同步更新。
 *
 * 主要导出：
 *   - loadFlaggedPlugins()：从磁盘加载到内存缓存（含过期清理）
 *   - getFlaggedPlugins()：同步读取内存缓存
 *   - addFlaggedPlugin(pluginId)：添加标记记录
 *   - markFlaggedPluginsSeen(pluginIds)：标记为已查看
 *   - removeFlaggedPlugin(pluginId)：用户手动解除标记
 */

import { randomBytes } from 'crypto'
import { readFile, rename, unlink, writeFile } from 'fs/promises'
import { join } from 'path'
import { logForDebugging } from '../debug.js'
import { getFsImplementation } from '../fsOperations.js'
import { logError } from '../log.js'
import { jsonParse, jsonStringify } from '../slowOperations.js'
import { getPluginsDirectory } from './pluginDirectories.js'

// 标记插件列表的持久化文件名
const FLAGGED_PLUGINS_FILENAME = 'flagged-plugins.json'

/**
 * 单个已标记插件的数据结构。
 *
 * - flaggedAt：标记时的 ISO 时间戳（插件被自动下架的时间）
 * - seenAt：用户首次在 /plugins 界面看到此通知的 ISO 时间戳
 *   （设置后开始计算 48 小时的自动清除倒计时）
 */
export type FlaggedPlugin = {
  flaggedAt: string
  seenAt?: string
}

// 标记插件的"已查看后"自动过期时间：48 小时
const SEEN_EXPIRY_MS = 48 * 60 * 60 * 1000 // 48 小时（毫秒）

// 模块级内存缓存：由 loadFlaggedPlugins() 预热，每次写入时同步更新。
// null 表示尚未从磁盘加载（getFlaggedPlugins() 此时返回空对象）。
let cache: Record<string, FlaggedPlugin> | null = null

/**
 * 获取标记插件 JSON 文件的完整路径。
 * 文件位于 <pluginsDir>/flagged-plugins.json。
 */
function getFlaggedPluginsPath(): string {
  return join(getPluginsDirectory(), FLAGGED_PLUGINS_FILENAME)
}

/**
 * 解析标记插件 JSON 文件内容为 Record<string, FlaggedPlugin>。
 *
 * 进行严格的结构验证（防御性解析），任何格式异常都返回空对象而非抛出，
 * 确保损坏的文件不会导致插件加载失败。
 *
 * 期望的 JSON 格式：
 * { "plugins": { "name@marketplace": { "flaggedAt": "ISO时间", "seenAt"?: "ISO时间" } } }
 *
 * @param content JSON 文件内容字符串
 * @returns 解析成功的标记插件映射，或空对象（格式不合法时）
 */
function parsePluginsData(content: string): Record<string, FlaggedPlugin> {
  const parsed = jsonParse(content) as unknown
  // 校验顶层结构：必须是含 plugins 字段的对象
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('plugins' in parsed) ||
    typeof (parsed as { plugins: unknown }).plugins !== 'object' ||
    (parsed as { plugins: unknown }).plugins === null
  ) {
    return {}
  }
  const plugins = (parsed as { plugins: Record<string, unknown> }).plugins
  const result: Record<string, FlaggedPlugin> = {}

  // 遍历每个插件条目，逐一验证字段类型
  for (const [id, entry] of Object.entries(plugins)) {
    if (
      entry &&
      typeof entry === 'object' &&
      'flaggedAt' in entry &&
      typeof (entry as { flaggedAt: unknown }).flaggedAt === 'string'
    ) {
      // 构建最小有效的 FlaggedPlugin 对象（仅包含必填字段）
      const parsed: FlaggedPlugin = {
        flaggedAt: (entry as { flaggedAt: string }).flaggedAt,
      }
      // 可选的 seenAt 字段：仅在类型正确时包含
      if (
        'seenAt' in entry &&
        typeof (entry as { seenAt: unknown }).seenAt === 'string'
      ) {
        parsed.seenAt = (entry as { seenAt: string }).seenAt
      }
      result[id] = parsed
    }
    // 格式不合法的条目静默丢弃
  }
  return result
}

/**
 * 从磁盘读取标记插件数据。
 *
 * 若文件不存在（ENOENT）或读取失败，返回空对象（不抛出异常）。
 */
async function readFromDisk(): Promise<Record<string, FlaggedPlugin>> {
  try {
    const content = await readFile(getFlaggedPluginsPath(), {
      encoding: 'utf-8',
    })
    return parsePluginsData(content)
  } catch {
    // 文件不存在或其他读取错误：返回空对象（首次运行时的正常情况）
    return {}
  }
}

/**
 * 将标记插件数据原子性地写入磁盘。
 *
 * 使用临时文件 + rename 的原子写入模式：
 *   1. 将内容写入 <flaggedPluginsPath>.<随机十六进制>.tmp；
 *   2. 重命名为目标路径（原子操作）；
 *   3. 同时更新内存缓存；
 *   4. 若写入失败，尝试清理临时文件并记录错误。
 *
 * 文件权限设置为 0o600（仅所有者可读写），保护插件状态数据。
 *
 * @param plugins 要写入的标记插件映射
 */
async function writeToDisk(
  plugins: Record<string, FlaggedPlugin>,
): Promise<void> {
  const filePath = getFlaggedPluginsPath()
  // 使用随机十六进制后缀生成临时文件名，避免并发写入冲突
  const tempPath = `${filePath}.${randomBytes(8).toString('hex')}.tmp`

  try {
    // 确保插件目录存在（首次运行时可能尚未创建）
    await getFsImplementation().mkdir(getPluginsDirectory())

    // 序列化数据（格式化输出便于调试）并写入临时文件
    const content = jsonStringify({ plugins }, null, 2)
    await writeFile(tempPath, content, {
      encoding: 'utf-8',
      mode: 0o600, // 仅所有者可读写
    })
    // 原子替换：rename 在同一文件系统内是原子操作
    await rename(tempPath, filePath)
    // 写入成功后同步更新内存缓存
    cache = plugins
  } catch (error) {
    // 写入失败：记录错误
    logError(error)
    // 尝试清理临时文件（忽略清理错误）
    try {
      await unlink(tempPath)
    } catch {
      // 临时文件可能不存在（写入前就失败了），忽略清理错误
    }
  }
}

/**
 * 从磁盘加载标记插件数据到内存缓存，并清理已过期的条目。
 *
 * 必须在调用 getFlaggedPlugins() 之前 await 此函数，
 * 否则 getFlaggedPlugins() 将返回空对象。
 * 由 useManagePlugins 在插件刷新时调用。
 *
 * 过期逻辑：已设置 seenAt 且距今超过 48 小时的条目会被自动删除，
 * 避免已处理的通知永久占用存储。
 */
export async function loadFlaggedPlugins(): Promise<void> {
  const all = await readFromDisk()
  const now = Date.now()
  let changed = false

  // 检查并清理已过期的条目（已查看且超过 48 小时）
  for (const [id, entry] of Object.entries(all)) {
    if (
      entry.seenAt &&
      now - new Date(entry.seenAt).getTime() >= SEEN_EXPIRY_MS
    ) {
      // 条目已过期：从映射中删除
      delete all[id]
      changed = true
    }
  }

  // 更新内存缓存
  cache = all
  // 若有过期条目被清理，将更新后的数据持久化到磁盘
  if (changed) {
    await writeToDisk(all)
  }
}

/**
 * 同步读取内存缓存中的标记插件数据。
 *
 * 若 loadFlaggedPlugins() 尚未调用，返回空对象（而非 null），
 * 确保 React 渲染中的同步调用不会因缓存未预热而崩溃。
 *
 * @returns 当前内存缓存中的标记插件映射（pluginId → FlaggedPlugin）
 */
export function getFlaggedPlugins(): Record<string, FlaggedPlugin> {
  return cache ?? {} // null 时返回空对象，保证类型安全
}

/**
 * 将指定插件 ID 添加到标记列表。
 *
 * 若内存缓存未预热，先从磁盘读取。
 * 写入时使用当前时间作为 flaggedAt 时间戳。
 *
 * @param pluginId 插件 ID（"name@marketplace" 格式）
 */
export async function addFlaggedPlugin(pluginId: string): Promise<void> {
  // 若缓存未预热，先从磁盘读取（懒加载）
  if (cache === null) {
    cache = await readFromDisk()
  }

  // 构建新的标记记录（扩展现有缓存）
  const updated = {
    ...cache,
    [pluginId]: {
      flaggedAt: new Date().toISOString(), // 记录标记时间
    },
  }

  // 原子写入磁盘（同时更新内存缓存）
  await writeToDisk(updated)
  logForDebugging(`Flagged plugin: ${pluginId}`)
}

/**
 * 将指定插件标记为"已查看"。
 *
 * 在 /plugins 界面渲染标记插件列表时调用。
 * 仅对尚未设置 seenAt 的条目更新时间戳（幂等）。
 * seenAt 设置后，48 小时计时器开始，到期后条目在下次 loadFlaggedPlugins() 时自动清除。
 *
 * @param pluginIds 要标记为已查看的插件 ID 列表
 */
export async function markFlaggedPluginsSeen(
  pluginIds: string[],
): Promise<void> {
  // 若缓存未预热，先从磁盘读取
  if (cache === null) {
    cache = await readFromDisk()
  }
  const now = new Date().toISOString()
  let changed = false

  const updated = { ...cache }
  for (const id of pluginIds) {
    const entry = updated[id]
    // 仅对存在且未设置 seenAt 的条目更新（幂等：已设置则跳过）
    if (entry && !entry.seenAt) {
      updated[id] = { ...entry, seenAt: now }
      changed = true
    }
  }

  // 只有实际发生变化时才写入磁盘（避免不必要的 I/O）
  if (changed) {
    await writeToDisk(updated)
  }
}

/**
 * 从标记列表中移除指定插件。
 *
 * 在用户于 /plugins 界面手动解除标记通知时调用。
 * 若插件不在标记列表中，直接返回（幂等）。
 *
 * @param pluginId 要解除标记的插件 ID（"name@marketplace" 格式）
 */
export async function removeFlaggedPlugin(pluginId: string): Promise<void> {
  // 若缓存未预热，先从磁盘读取
  if (cache === null) {
    cache = await readFromDisk()
  }
  // 若插件不在标记列表中，直接返回（幂等操作）
  if (!(pluginId in cache)) return

  // 解构赋值移除指定键（rest 为去掉 pluginId 后的映射）
  const { [pluginId]: _, ...rest } = cache
  cache = rest // 立即更新内存缓存
  await writeToDisk(rest) // 原子写入磁盘
}
