/**
 * 目录补全工具模块
 *
 * 在 Claude Code 系统流程中的位置：
 * 该模块属于提示输入（PromptInput）UI 层的自动补全子系统。
 * 当用户在提示框中输入以路径字符开头的词元（如 `./ ~/  / ../`）时，
 * UI 层会调用本模块提供目录或文件路径的候选建议列表。
 *
 * 主要功能：
 * 1. 解析用户输入的部分路径（parsePartialPath）
 * 2. 扫描目录返回子目录列表（scanDirectory），仅目录，带 LRU 缓存
 * 3. 扫描目录返回文件+子目录列表（scanDirectoryForPaths），带 LRU 缓存
 * 4. 组装最终补全建议（getDirectoryCompletions / getPathCompletions）
 * 5. 判断输入词元是否像路径（isPathLikeToken）
 * 6. 清空缓存（clearDirectoryCache / clearPathCache）
 *
 * 两个 LRU 缓存各最多存储 500 条，TTL 为 5 分钟，避免频繁的文件系统调用。
 */

import { LRUCache } from 'lru-cache'
import { basename, dirname, join, sep } from 'path'
import type { SuggestionItem } from 'src/components/PromptInput/PromptInputFooterSuggestions.js'
import { getCwd } from 'src/utils/cwd.js'
import { getFsImplementation } from 'src/utils/fsOperations.js'
import { logError } from 'src/utils/log.js'
import { expandPath } from 'src/utils/path.js'

// ─── 类型定义 ────────────────────────────────────────────────────────────────

/** 仅目录类型的条目，用于 directoryCache */
export type DirectoryEntry = {
  name: string
  path: string
  type: 'directory'
}

/** 文件或目录条目，用于 pathCache */
export type PathEntry = {
  name: string
  path: string
  type: 'directory' | 'file'
}

/** 补全选项：可指定基准路径和最多返回条数 */
export type CompletionOptions = {
  basePath?: string
  maxResults?: number
}

/** 路径补全选项：在基础选项之上增加是否包含文件、是否包含隐藏条目 */
export type PathCompletionOptions = CompletionOptions & {
  includeFiles?: boolean
  includeHidden?: boolean
}

/** 内部类型：解析后的路径对象，包含父目录和文件名前缀 */
type ParsedPath = {
  directory: string
  prefix: string
}

// ─── 缓存配置 ─────────────────────────────────────────────────────────────────

// 缓存最大条目数
const CACHE_SIZE = 500
// 缓存 TTL：5 分钟（毫秒），期间文件系统变更会被忽略
const CACHE_TTL = 5 * 60 * 1000 // 5 minutes

// 仅存储子目录的 LRU 缓存（键为绝对目录路径）
const directoryCache = new LRUCache<string, DirectoryEntry[]>({
  max: CACHE_SIZE,
  ttl: CACHE_TTL,
})

// 存储文件+子目录的 LRU 缓存（键为 `${dirPath}:${includeHidden}`）
const pathCache = new LRUCache<string, PathEntry[]>({
  max: CACHE_SIZE,
  ttl: CACHE_TTL,
})

// ─── 核心函数 ─────────────────────────────────────────────────────────────────

/**
 * 将用户输入的部分路径解析为「父目录 + 文件名前缀」两部分。
 *
 * 流程：
 * 1. 输入为空时，返回 basePath（或 cwd）作为目录，前缀为空字符串。
 * 2. 使用 expandPath 展开 ~ 并处理相对路径，得到绝对路径。
 * 3. 若路径以路径分隔符结尾，说明用户想补全该目录下的内容，前缀为空。
 * 4. 否则用 dirname/basename 拆分为目录和前缀。
 */
export function parsePartialPath(
  partialPath: string,
  basePath?: string,
): ParsedPath {
  // 输入为空：补全 basePath 或 cwd 下的内容
  if (!partialPath) {
    const directory = basePath || getCwd()
    return { directory, prefix: '' }
  }

  // 展开 ~ 等特殊符号，并将相对路径转换为绝对路径
  const resolved = expandPath(partialPath, basePath)

  // 路径以分隔符结尾（如 "src/"），表示已经指定了完整目录
  // 兼容 POSIX 的 "/" 和 Windows 的 sep
  if (partialPath.endsWith('/') || partialPath.endsWith(sep)) {
    return { directory: resolved, prefix: '' }
  }

  // 用 dirname 取父目录、basename 取文件名前缀
  const directory = dirname(resolved)
  const prefix = basename(partialPath)

  return { directory, prefix }
}

/**
 * 扫描指定目录，返回其直接子目录列表（不递归）。
 *
 * 流程：
 * 1. 优先从 directoryCache 中取缓存结果，命中则直接返回。
 * 2. 读取目录内容，过滤出目录类型且不以 "." 开头的条目。
 * 3. 最多返回 100 条，写入缓存后返回。
 * 4. 出错时记录错误日志并返回空数组，保证调用方不抛出异常。
 */
export async function scanDirectory(
  dirPath: string,
): Promise<DirectoryEntry[]> {
  // 命中缓存则直接返回，避免重复的文件系统 I/O
  const cached = directoryCache.get(dirPath)
  if (cached) {
    return cached
  }

  try {
    // 读取目录的 dirent 列表（带类型信息）
    const fs = getFsImplementation()
    const entries = await fs.readdir(dirPath)

    // 只保留目录类型、且不是隐藏目录（不以 "." 开头）
    const directories = entries
      .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
      .map(entry => ({
        name: entry.name,
        path: join(dirPath, entry.name),
        type: 'directory' as const,
      }))
      .slice(0, 100) // MVP 阶段限制最多 100 条，防止列表过长

    // 写入缓存
    directoryCache.set(dirPath, directories)

    return directories
  } catch (error) {
    // 目录不存在或无权限等异常，记录日志但不向上抛出
    logError(error)
    return []
  }
}

/**
 * 获取目录补全建议列表（仅目录）。
 *
 * 流程：
 * 1. 解析 partialPath 为 directory + prefix。
 * 2. 扫描 directory 取子目录列表。
 * 3. 过滤出以 prefix 开头（不区分大小写）的条目，限制 maxResults 条。
 * 4. 组装为 SuggestionItem 格式返回，displayText 以 "/" 结尾表示目录。
 */
export async function getDirectoryCompletions(
  partialPath: string,
  options: CompletionOptions = {},
): Promise<SuggestionItem[]> {
  const { basePath = getCwd(), maxResults = 10 } = options

  // 解析出父目录路径和当前输入的名称前缀
  const { directory, prefix } = parsePartialPath(partialPath, basePath)
  const entries = await scanDirectory(directory)
  const prefixLower = prefix.toLowerCase()

  // 过滤：名称以用户输入前缀开头（不区分大小写）
  const matches = entries
    .filter(entry => entry.name.toLowerCase().startsWith(prefixLower))
    .slice(0, maxResults)

  // 组装 SuggestionItem：id 为绝对路径，displayText 加 "/" 后缀，类型为 directory
  return matches.map(entry => ({
    id: entry.path,
    displayText: entry.name + '/',
    description: 'directory',
    metadata: { type: 'directory' as const },
  }))
}

/**
 * 清空目录专用缓存（directoryCache）。
 * 适合在文件系统发生变更（如新建目录）后主动刷新。
 */
export function clearDirectoryCache(): void {
  directoryCache.clear()
}

/**
 * 判断一个词元是否看起来像路径。
 *
 * 识别的前缀模式：~/、/、./、../，以及单独的 ~、.、..。
 * UI 层用此函数决定是否触发路径补全而非普通关键字补全。
 */
export function isPathLikeToken(token: string): boolean {
  return (
    token.startsWith('~/') ||
    token.startsWith('/') ||
    token.startsWith('./') ||
    token.startsWith('../') ||
    token === '~' ||
    token === '.' ||
    token === '..'
  )
}

/**
 * 扫描目录，返回文件和子目录的混合列表。
 *
 * 与 scanDirectory 的区别：同时包含文件；可选是否包含隐藏条目。
 * 缓存键为 `${dirPath}:${includeHidden}`，区分两种模式。
 *
 * 排序规则：目录优先，同类型按字母序排列。
 * 最多返回 100 条，写入 pathCache 后返回。
 */
export async function scanDirectoryForPaths(
  dirPath: string,
  includeHidden = false,
): Promise<PathEntry[]> {
  // 缓存键区分是否包含隐藏条目
  const cacheKey = `${dirPath}:${includeHidden}`
  const cached = pathCache.get(cacheKey)
  if (cached) {
    return cached
  }

  try {
    const fs = getFsImplementation()
    const entries = await fs.readdir(dirPath)

    const paths = entries
      // 如果不包含隐藏条目，过滤掉以 "." 开头的名称
      .filter(entry => includeHidden || !entry.name.startsWith('.'))
      .map(entry => ({
        name: entry.name,
        path: join(dirPath, entry.name),
        // 根据 isDirectory() 决定类型
        type: entry.isDirectory() ? ('directory' as const) : ('file' as const),
      }))
      .sort((a, b) => {
        // 目录排在文件前面
        if (a.type === 'directory' && b.type !== 'directory') return -1
        if (a.type !== 'directory' && b.type === 'directory') return 1
        // 同类型按字母序
        return a.name.localeCompare(b.name)
      })
      .slice(0, 100)

    pathCache.set(cacheKey, paths)
    return paths
  } catch (error) {
    logError(error)
    return []
  }
}

/**
 * 获取文件+目录混合补全建议列表。
 *
 * 流程：
 * 1. 解析 partialPath 为 directory + prefix。
 * 2. 扫描目录取混合列表（可选是否包含文件/隐藏条目）。
 * 3. 过滤并取前 maxResults 条匹配项。
 * 4. 计算相对路径前缀（dirPortion），拼接条目名称作为 displayText。
 *    - 剥离开头的 "./" 前缀，避免冗余显示。
 *    - 兼容 Windows 路径分隔符（sep）。
 * 5. 目录条目的 displayText 以 "/" 结尾；文件不加后缀。
 */
export async function getPathCompletions(
  partialPath: string,
  options: PathCompletionOptions = {},
): Promise<SuggestionItem[]> {
  const {
    basePath = getCwd(),
    maxResults = 10,
    includeFiles = true,
    includeHidden = false,
  } = options

  const { directory, prefix } = parsePartialPath(partialPath, basePath)
  const entries = await scanDirectoryForPaths(directory, includeHidden)
  const prefixLower = prefix.toLowerCase()

  const matches = entries
    .filter(entry => {
      // 若不包含文件则跳过文件条目
      if (!includeFiles && entry.type === 'file') return false
      return entry.name.toLowerCase().startsWith(prefixLower)
    })
    .slice(0, maxResults)

  // 计算相对路径中的「目录前缀」部分
  // 例如：partialPath = "src/c" → dirPortion = "src/"
  // Strip leading "./" since it's just used for cwd search
  // 兼容 POSIX 的 "/" 和 Windows 的 sep
  const hasSeparator = partialPath.includes('/') || partialPath.includes(sep)
  let dirPortion = ''
  if (hasSeparator) {
    // 找到最后一个路径分隔符的位置
    const lastSlash = partialPath.lastIndexOf('/')
    const lastSep = partialPath.lastIndexOf(sep)
    const lastSeparatorPos = Math.max(lastSlash, lastSep)
    dirPortion = partialPath.substring(0, lastSeparatorPos + 1)
  }
  // 剥离开头的 "./"，避免显示多余的 "./"
  if (dirPortion.startsWith('./') || dirPortion.startsWith('.' + sep)) {
    dirPortion = dirPortion.slice(2)
  }

  return matches.map(entry => {
    const fullPath = dirPortion + entry.name
    return {
      id: fullPath,
      // 目录加 "/" 后缀，文件不加
      displayText: entry.type === 'directory' ? fullPath + '/' : fullPath,
      metadata: { type: entry.type },
    }
  })
}

/**
 * 清空所有路径相关缓存（directoryCache 和 pathCache）。
 * 供测试或外部强制刷新使用。
 */
export function clearPathCache(): void {
  directoryCache.clear()
  pathCache.clear()
}
