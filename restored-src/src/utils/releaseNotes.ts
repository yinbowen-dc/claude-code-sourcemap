/**
 * 版本发布说明模块 (releaseNotes.ts)
 *
 * 在 Claude Code 系统流程中的位置：
 *   启动流程 → setup.ts → 【本模块：更新日志获取 & 展示】 → UI 组件渲染层
 *
 * 主要职责：
 *   1. 从 GitHub 异步拉取 CHANGELOG.md，缓存至 ~/.claude/cache/changelog.md
 *   2. 维护三层缓存：HTTP 响应 → 文件缓存 → 内存缓存
 *   3. 解析 Markdown 格式的更新日志，提取各版本条目
 *   4. 比较当前版本与上次已读版本，返回需要展示的新版本说明
 *   5. 提供同步变体供 React 渲染路径使用（避免在 render 中 await）
 *
 * 与其他模块的关系：
 *   - 被 setup.ts 在首次渲染前 await，确保内存缓存已填充
 *   - 被 React 组件通过同步变体（checkForReleaseNotesSync）读取
 *   - ant 构建路径通过 MACRO.VERSION_CHANGELOG 宏替换，绕过 HTTP 请求
 */

import axios from 'axios'
import { mkdir, readFile, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { coerce } from 'semver'
import { getIsNonInteractiveSession } from '../bootstrap/state.js'
import { getGlobalConfig, saveGlobalConfig } from './config.js'
import { getClaudeConfigHomeDir } from './envUtils.js'
import { toError } from './errors.js'
import { logError } from './log.js'
import { isEssentialTrafficOnly } from './privacyLevel.js'
import { gt } from './semver.js'

// 单次启动最多展示的版本条目数量，避免更新说明列表过长
const MAX_RELEASE_NOTES_SHOWN = 5

/**
 * 更新日志来源 URL（渲染展示用）及原始内容 URL（抓取用）。
 *
 * 说明：更新日志不随构建打包，而是从 GitHub 动态获取。
 * 原因：Ink 的静态渲染模型难以在初次渲染后动态更新组件，
 * 因此将更新日志写入缓存文件，确保下次启动时即可立即读取，
 * 无需再次触发完整的 UI 重绘。
 *
 * 流程：
 *   1. 用户升级到新版本
 *   2. 后台拉取更新日志并写入缓存
 *   3. 下次启动时直接从缓存读取，无感知延迟
 */
export const CHANGELOG_URL =
  'https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md'
// 原始 Markdown 内容地址（可直接读取，无 HTML 包装）
const RAW_CHANGELOG_URL =
  'https://raw.githubusercontent.com/anthropics/claude-code/refs/heads/main/CHANGELOG.md'

/**
 * 返回更新日志缓存文件的路径。
 * 固定存储在 ~/.claude/cache/changelog.md。
 */
function getChangelogCachePath(): string {
  return join(getClaudeConfigHomeDir(), 'cache', 'changelog.md')
}

// 内存缓存：由异步读取填充；同步调用方（React render、同步工具函数）
// 在 setup.ts await checkForReleaseNotes() 之后从此缓存读取。
let changelogMemoryCache: string | null = null

/**
 * 重置内存缓存，仅供测试使用。
 * @internal
 */
export function _resetChangelogCacheForTesting(): void {
  changelogMemoryCache = null
}

/**
 * 将旧版本中存储在全局 config 里的更新日志迁移到文件缓存。
 *
 * 流程：
 *   1. 检查全局配置中是否存在已废弃的 cachedChangelog 字段
 *   2. 若存在且缓存文件尚不存在，则将内容写入文件（flag:'wx' 防止覆盖）
 *   3. 从全局配置中删除该废弃字段，防止后续 saveGlobalConfig 重新写入
 *
 * 应在启动时尽早调用一次，确保迁移在任何其他 config 保存之前完成。
 */
export async function migrateChangelogFromConfig(): Promise<void> {
  const config = getGlobalConfig()
  // 旧字段不存在则跳过
  if (!config.cachedChangelog) {
    return
  }

  const cachePath = getChangelogCachePath()

  // 若缓存文件不存在，则从旧 config 中创建
  try {
    await mkdir(dirname(cachePath), { recursive: true })
    await writeFile(cachePath, config.cachedChangelog, {
      encoding: 'utf-8',
      flag: 'wx', // 仅在文件不存在时写入，存在则静默跳过
    })
  } catch {
    // 文件已存在（EEXIST），忽略即可
  }

  // 从 config 中删除已废弃字段（解构剔除）
  saveGlobalConfig(({ cachedChangelog: _, ...rest }) => rest)
}

/**
 * 从 GitHub 拉取最新更新日志并写入缓存文件，同时更新内存缓存。
 *
 * 流程：
 *   1. 非交互式会话（CI/headless）跳过，避免无效网络请求
 *   2. 隐私级别为"仅必要流量"时跳过
 *   3. 发起 GET 请求获取 CHANGELOG.md 原始内容
 *   4. 内容与内存缓存完全相同时跳过写入（防止无意义磁盘 I/O）
 *   5. 确保缓存目录存在，写入文件并更新内存缓存
 *   6. 更新全局 config 中的 changelogLastFetched 时间戳
 *
 * 此函数在后台异步执行，不阻塞 UI 渲染。
 */
export async function fetchAndStoreChangelog(): Promise<void> {
  // 非交互式模式不需要展示更新说明
  if (getIsNonInteractiveSession()) {
    return
  }

  // 隐私模式：禁止非必要网络请求
  if (isEssentialTrafficOnly()) {
    return
  }

  const response = await axios.get(RAW_CHANGELOG_URL)
  if (response.status === 200) {
    const changelogContent = response.data

    // 内容未变化时跳过写入：避免文件时间戳变动导致 saveGlobalConfig 脏检测误判
    if (changelogContent === changelogMemoryCache) {
      return
    }

    const cachePath = getChangelogCachePath()

    // 确保缓存目录存在（首次运行时可能不存在）
    await mkdir(dirname(cachePath), { recursive: true })

    // 写入缓存文件并更新内存缓存
    await writeFile(cachePath, changelogContent, { encoding: 'utf-8' })
    changelogMemoryCache = changelogContent

    // 更新全局配置中的最后拉取时间
    const changelogLastFetched = Date.now()
    saveGlobalConfig(current => ({
      ...current,
      changelogLastFetched,
    }))
  }
}

/**
 * 从文件缓存读取更新日志，并填充内存缓存供后续同步读取。
 *
 * 流程：
 *   1. 内存缓存已填充时直接返回（避免重复磁盘 I/O）
 *   2. 读取缓存文件，写入内存缓存
 *   3. 文件不存在或读取失败时返回空字符串，并缓存空值防止重复尝试
 *
 * @returns 缓存的更新日志内容，无可用缓存时返回空字符串
 */
export async function getStoredChangelog(): Promise<string> {
  // 内存缓存命中：直接返回
  if (changelogMemoryCache !== null) {
    return changelogMemoryCache
  }
  const cachePath = getChangelogCachePath()
  try {
    const content = await readFile(cachePath, 'utf-8')
    changelogMemoryCache = content
    return content
  } catch {
    // 文件不存在或读取失败：缓存空字符串，下次跳过磁盘 I/O
    changelogMemoryCache = ''
    return ''
  }
}

/**
 * 同步访问更新日志（仅读取内存缓存）。
 *
 * 适用于 React 渲染路径（render 函数不能 await）。
 * setup.ts 在首次渲染前已 await checkForReleaseNotes()，
 * 保证渲染时内存缓存已填充。
 *
 * @returns 内存缓存中的更新日志内容，未填充时返回空字符串
 */
export function getStoredChangelogFromMemory(): string {
  return changelogMemoryCache ?? ''
}

/**
 * 将 Markdown 格式的更新日志解析为结构化数据。
 *
 * 流程：
 *   1. 按 `## ` 标题行分割，跳过文件头部（首个 section）
 *   2. 逐 section 提取版本号（支持 "1.2.3" 和 "1.2.3 - YYYY-MM-DD" 两种格式）
 *   3. 提取各版本的 `- ` 开头的子弹条目
 *   4. 跳过没有有效条目的版本
 *
 * @param content 更新日志的 Markdown 字符串
 * @returns 以版本号为键、更新条目数组为值的映射
 */
export function parseChangelog(content: string): Record<string, string[]> {
  try {
    if (!content) return {}

    const releaseNotes: Record<string, string[]> = {}

    // 按二级标题（## X.X.X）分割，slice(1) 跳过文件头部
    const sections = content.split(/^## /gm).slice(1)

    for (const section of sections) {
      const lines = section.trim().split('\n')
      if (lines.length === 0) continue

      // 第一行为版本号行：支持带日期后缀格式，取 ' - ' 前的部分
      const versionLine = lines[0]
      if (!versionLine) continue

      const version = versionLine.split(' - ')[0]?.trim() || ''
      if (!version) continue

      // 提取 '- ' 开头的子弹条目，去除前缀和首尾空白
      const notes = lines
        .slice(1)
        .filter(line => line.trim().startsWith('- '))
        .map(line => line.trim().substring(2).trim())
        .filter(Boolean)

      // 只记录有实际内容的版本
      if (notes.length > 0) {
        releaseNotes[version] = notes
      }
    }

    return releaseNotes
  } catch (error) {
    logError(toError(error))
    return {}
  }
}

/**
 * 根据上次已读版本，返回需要展示的最新版本说明（最多 MAX_RELEASE_NOTES_SHOWN 条）。
 *
 * 流程：
 *   1. 解析更新日志，获取版本 → 条目映射
 *   2. 使用 semver coerce 标准化当前和历史版本号（去除 SHA 等后缀）
 *   3. 筛选出所有比上次已读版本更新的版本
 *   4. 按版本从新到旧排序，展平所有条目，截取前 MAX_RELEASE_NOTES_SHOWN 条
 *
 * @param currentVersion  当前应用版本
 * @param previousVersion 上次已读版本（null 表示首次使用）
 * @param changelogContent 更新日志内容（默认从内存缓存读取）
 * @returns 需要展示的更新条目数组
 */
export function getRecentReleaseNotes(
  currentVersion: string,
  previousVersion: string | null | undefined,
  changelogContent: string = getStoredChangelogFromMemory(),
): string[] {
  try {
    const releaseNotes = parseChangelog(changelogContent)

    // coerce 可以将带 SHA 的版本号（如 "1.2.3-abc123"）规范化为纯数字版本
    const baseCurrentVersion = coerce(currentVersion)
    const basePreviousVersion = previousVersion ? coerce(previousVersion) : null

    if (
      !basePreviousVersion ||
      (baseCurrentVersion &&
        gt(baseCurrentVersion.version, basePreviousVersion.version))
    ) {
      // 获取所有比上次已读版本更新的条目，按版本从新到旧排序
      return Object.entries(releaseNotes)
        .filter(
          ([version]) =>
            !basePreviousVersion || gt(version, basePreviousVersion.version),
        )
        .sort(([versionA], [versionB]) => (gt(versionA, versionB) ? -1 : 1)) // 最新版本优先
        .flatMap(([_, notes]) => notes)
        .filter(Boolean)
        .slice(0, MAX_RELEASE_NOTES_SHOWN) // 截取展示上限
    }
  } catch (error) {
    logError(toError(error))
    return []
  }
  return []
}

/**
 * 返回所有版本的更新说明（最旧版本在前）。
 *
 * 流程：
 *   1. 解析更新日志
 *   2. 按版本从旧到新排序
 *   3. 过滤掉没有有效条目的版本
 *
 * @param changelogContent 更新日志内容（默认从内存缓存读取）
 * @returns [版本号, 更新条目[]] 数组（最旧版本在前）
 */
export function getAllReleaseNotes(
  changelogContent: string = getStoredChangelogFromMemory(),
): Array<[string, string[]]> {
  try {
    const releaseNotes = parseChangelog(changelogContent)

    // 按版本从旧到新排序（gt 为 true 时返回 1 = 排在后面）
    const sortedVersions = Object.keys(releaseNotes).sort((a, b) =>
      gt(a, b) ? 1 : -1,
    )

    return sortedVersions
      .map(version => {
        const versionNotes = releaseNotes[version]
        if (!versionNotes || versionNotes.length === 0) return null

        const notes = versionNotes.filter(Boolean)
        if (notes.length === 0) return null

        return [version, notes] as [string, string[]]
      })
      .filter((item): item is [string, string[]] => item !== null)
  } catch (error) {
    logError(toError(error))
    return []
  }
}

/**
 * 检查是否有需要展示的更新说明（异步版本）。
 *
 * 流程：
 *   1. ant 构建路径：从构建时注入的 MACRO.VERSION_CHANGELOG 宏读取提交记录
 *   2. 确保内存缓存已填充（await getStoredChangelog()）
 *   3. 若版本有变化或无缓存，异步后台触发更新日志拉取（不阻塞 UI）
 *   4. 计算并返回需要展示的更新条目
 *
 * @param lastSeenVersion 用户上次已读版本号
 * @param currentVersion  当前应用版本号（默认 MACRO.VERSION）
 * @returns { hasReleaseNotes, releaseNotes }
 */
export async function checkForReleaseNotes(
  lastSeenVersion: string | null | undefined,
  currentVersion: string = MACRO.VERSION,
): Promise<{ hasReleaseNotes: boolean; releaseNotes: string[] }> {
  // ant 构建：使用构建时注入的 CHANGELOG 宏，跳过 HTTP 请求
  if (process.env.USER_TYPE === 'ant') {
    const changelog = MACRO.VERSION_CHANGELOG
    if (changelog) {
      // 每行一条提交记录
      const commits = changelog.trim().split('\n').filter(Boolean)
      return {
        hasReleaseNotes: commits.length > 0,
        releaseNotes: commits,
      }
    }
    return {
      hasReleaseNotes: false,
      releaseNotes: [],
    }
  }

  // 确保内存缓存已填充，供后续同步读取
  const cachedChangelog = await getStoredChangelog()

  // 版本有变化或无缓存时，后台异步拉取最新更新日志
  if (lastSeenVersion !== currentVersion || !cachedChangelog) {
    fetchAndStoreChangelog().catch(error => logError(toError(error)))
  }

  const releaseNotes = getRecentReleaseNotes(
    currentVersion,
    lastSeenVersion,
    cachedChangelog,
  )
  const hasReleaseNotes = releaseNotes.length > 0

  return {
    hasReleaseNotes,
    releaseNotes,
  }
}

/**
 * 检查是否有需要展示的更新说明（同步版本，供 React 渲染路径使用）。
 *
 * 与异步版本的区别：
 *   - 仅读取内存缓存，不发起 I/O 或网络请求
 *   - setup.ts 在首次渲染前已 await checkForReleaseNotes()，
 *     因此渲染时内存缓存已保证填充
 *
 * @param lastSeenVersion 用户上次已读版本号
 * @param currentVersion  当前应用版本号（默认 MACRO.VERSION）
 * @returns { hasReleaseNotes, releaseNotes }
 */
export function checkForReleaseNotesSync(
  lastSeenVersion: string | null | undefined,
  currentVersion: string = MACRO.VERSION,
): { hasReleaseNotes: boolean; releaseNotes: string[] } {
  // ant 构建：同样优先使用宏注入的 CHANGELOG
  if (process.env.USER_TYPE === 'ant') {
    const changelog = MACRO.VERSION_CHANGELOG
    if (changelog) {
      const commits = changelog.trim().split('\n').filter(Boolean)
      return {
        hasReleaseNotes: commits.length > 0,
        releaseNotes: commits,
      }
    }
    return {
      hasReleaseNotes: false,
      releaseNotes: [],
    }
  }

  // 仅从内存缓存获取（同步，无 I/O）
  const releaseNotes = getRecentReleaseNotes(currentVersion, lastSeenVersion)
  return {
    hasReleaseNotes: releaseNotes.length > 0,
    releaseNotes,
  }
}
