/**
 * 定期数据清理模块。
 *
 * 在 Claude Code 系统中，该模块负责清理过期的会话数据、缓存、图片和工具结果等，
 * 默认保留期为 30 天（可通过 settings.cleanupPeriodDays 配置）：
 * - getCutoffDate()（内部）：根据配置计算清理截止日期
 * - addCleanupResults()：合并两个 CleanupResult 统计对象
 * - cleanupMessages()：清理过期的消息记录目录
 * - cleanupErrors()：清理过期的错误日志目录
 * - cleanupToolResults()：清理工具结果存储中的过期文件
 * - cleanup()：执行所有清理任务并汇总结果，同时触发旧版本/旧缓存清理
 */
import * as fs from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import { logEvent } from '../services/analytics/index.js'
import { CACHE_PATHS } from './cachePaths.js'
import { logForDebugging } from './debug.js'
import { getClaudeConfigHomeDir } from './envUtils.js'
import { type FsOperations, getFsImplementation } from './fsOperations.js'
import { cleanupOldImageCaches } from './imageStore.js'
import * as lockfile from './lockfile.js'
import { logError } from './log.js'
import { cleanupOldVersions } from './nativeInstaller/index.js'
import { cleanupOldPastes } from './pasteStore.js'
import { getProjectsDir } from './sessionStorage.js'
import { getSettingsWithAllErrors } from './settings/allErrors.js'
import {
  getSettings_DEPRECATED,
  rawSettingsContainsKey,
} from './settings/settings.js'
import { TOOL_RESULTS_SUBDIR } from './toolResultStorage.js'
import { cleanupStaleAgentWorktrees } from './worktree.js'

// 默认数据保留天数：30 天
const DEFAULT_CLEANUP_PERIOD_DAYS = 30

/**
 * 根据用户配置计算清理截止日期。
 * 早于该日期的文件/目录将被视为过期并删除。
 * 若未配置 cleanupPeriodDays，则回退到 30 天的默认值。
 */
function getCutoffDate(): Date {
  const settings = getSettings_DEPRECATED() || {}
  // 读取用户自定义的保留天数，未设置则使用默认值
  const cleanupPeriodDays =
    settings.cleanupPeriodDays ?? DEFAULT_CLEANUP_PERIOD_DAYS
  // 将天数转换为毫秒，用于与 Date.now() 做差值运算
  const cleanupPeriodMs = cleanupPeriodDays * 24 * 60 * 60 * 1000
  return new Date(Date.now() - cleanupPeriodMs)
}

export type CleanupResult = {
  messages: number
  errors: number
}

/**
 * 合并两个清理统计结果，将各字段数值相加。
 * 用于将多个子目录的清理结果汇聚成一个总计。
 */
export function addCleanupResults(
  a: CleanupResult,
  b: CleanupResult,
): CleanupResult {
  return {
    messages: a.messages + b.messages,
    errors: a.errors + b.errors,
  }
}

/**
 * 将文件名（ISO 时间戳格式，冒号和点被替换为连字符）还原为 Date 对象。
 * 文件名形如 "2024-01-15T12-30-45-123Z.jsonl"，需还原冒号和小数点后才能解析。
 */
export function convertFileNameToDate(filename: string): Date {
  const isoStr = filename
    .split('.')[0]!
    .replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/, 'T$1:$2:$3.$4Z')
  return new Date(isoStr)
}

/**
 * 遍历指定目录，删除早于截止日期的过期文件。
 * @param dirPath       目标目录路径
 * @param cutoffDate    截止日期，早于该时间的文件将被删除
 * @param isMessagePath 若为 true，则将删除计数计入 messages；否则计入 errors
 * @returns             包含删除消息数与错误数的清理统计
 */
async function cleanupOldFilesInDirectory(
  dirPath: string,
  cutoffDate: Date,
  isMessagePath: boolean,
): Promise<CleanupResult> {
  const result: CleanupResult = { messages: 0, errors: 0 }

  try {
    const files = await getFsImplementation().readdir(dirPath)

    for (const file of files) {
      try {
        // 将文件名中被替换的时间分隔符还原，解析出文件的创建时间戳
        const timestamp = convertFileNameToDate(file.name)
        if (timestamp < cutoffDate) {
          await getFsImplementation().unlink(join(dirPath, file.name))
          // 根据路径类型选择计数器：消息文件用 messages，错误日志用 errors
          if (isMessagePath) {
            result.messages++
          } else {
            result.errors++
          }
        }
      } catch (error) {
        // 单个文件处理失败时记录错误但继续处理其他文件，避免整体中断
        logError(error as Error)
      }
    }
  } catch (error: unknown) {
    // 目录不存在（ENOENT）属于正常情况，仅记录其他类型的异常
    if (error instanceof Error && 'code' in error && error.code !== 'ENOENT') {
      logError(error)
    }
  }

  return result
}

/**
 * 清理错误日志目录及所有 MCP 日志子目录中的过期文件。
 * 通过枚举 baseLogs 路径下以 "mcp-logs-" 开头的子目录，逐个调用
 * cleanupOldFilesInDirectory，并在目录清空后尝试删除空目录。
 */
export async function cleanupOldMessageFiles(): Promise<CleanupResult> {
  const fsImpl = getFsImplementation()
  const cutoffDate = getCutoffDate()
  const errorPath = CACHE_PATHS.errors()
  const baseCachePath = CACHE_PATHS.baseLogs()

  // 先清理错误日志目录（false 表示计入 errors 而非 messages）
  let result = await cleanupOldFilesInDirectory(errorPath, cutoffDate, false)

  // 再清理所有 MCP 日志目录
  try {
    let dirents
    try {
      dirents = await fsImpl.readdir(baseCachePath)
    } catch {
      // baseCachePath 不存在时直接返回已有结果
      return result
    }

    // 过滤出以 "mcp-logs-" 开头的子目录
    const mcpLogDirs = dirents
      .filter(
        dirent => dirent.isDirectory() && dirent.name.startsWith('mcp-logs-'),
      )
      .map(dirent => join(baseCachePath, dirent.name))

    for (const mcpLogDir of mcpLogDirs) {
      // 清理各 MCP 日志目录内的过期文件，结果合并到 result
      result = addCleanupResults(
        result,
        await cleanupOldFilesInDirectory(mcpLogDir, cutoffDate, true),
      )
      // 文件清理完毕后尝试删除空目录（非空则静默忽略）
      await tryRmdir(mcpLogDir, fsImpl)
    }
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code !== 'ENOENT') {
      logError(error)
    }
  }

  return result
}

/**
 * 检查单个文件是否早于截止日期，若是则删除并返回 true。
 * 调用方负责捕获异常（stat/unlink 均可能抛出）。
 */
async function unlinkIfOld(
  filePath: string,
  cutoffDate: Date,
  fsImpl: FsOperations,
): Promise<boolean> {
  const stats = await fsImpl.stat(filePath)
  if (stats.mtime < cutoffDate) {
    await fsImpl.unlink(filePath)
    return true
  }
  return false
}

/**
 * 尝试删除空目录，若目录非空或不存在则静默忽略。
 * 作为清理后的收尾步骤，确保不留下空目录。
 */
async function tryRmdir(dirPath: string, fsImpl: FsOperations): Promise<void> {
  try {
    await fsImpl.rmdir(dirPath)
  } catch {
    // 目录非空或不存在时不抛出，静默跳过
  }
}

/**
 * 清理所有项目会话目录（~/.claude/projects/）中的过期 JSONL/cast 文件
 * 以及会话目录下的 tool-results 子目录中的过期文件。
 *
 * 遍历结构：projects/<projectDir>/<sessionFiles|sessionDirs>/tool-results/<toolDirs>/<files>
 * 每一层清空后尝试删除空目录，避免残留空壳目录占用文件系统 inode。
 */
export async function cleanupOldSessionFiles(): Promise<CleanupResult> {
  const cutoffDate = getCutoffDate()
  const result: CleanupResult = { messages: 0, errors: 0 }
  const projectsDir = getProjectsDir()
  const fsImpl = getFsImplementation()

  let projectDirents
  try {
    projectDirents = await fsImpl.readdir(projectsDir)
  } catch {
    return result
  }

  for (const projectDirent of projectDirents) {
    if (!projectDirent.isDirectory()) continue
    const projectDir = join(projectsDir, projectDirent.name)

    // 每个项目目录只做一次 readdir —— 将结果分为普通文件和会话目录
    let entries
    try {
      entries = await fsImpl.readdir(projectDir)
    } catch {
      result.errors++
      continue
    }

    for (const entry of entries) {
      if (entry.isFile()) {
        // 只处理会话记录文件（.jsonl）和终端录制文件（.cast）
        if (!entry.name.endsWith('.jsonl') && !entry.name.endsWith('.cast')) {
          continue
        }
        try {
          if (
            await unlinkIfOld(join(projectDir, entry.name), cutoffDate, fsImpl)
          ) {
            result.messages++
          }
        } catch {
          result.errors++
        }
      } else if (entry.isDirectory()) {
        // 处理会话子目录：清理其下的 tool-results 工具结果文件
        const sessionDir = join(projectDir, entry.name)
        const toolResultsDir = join(sessionDir, TOOL_RESULTS_SUBDIR)
        let toolDirs
        try {
          toolDirs = await fsImpl.readdir(toolResultsDir)
        } catch {
          // tool-results 目录不存在时，仍尝试删除空的会话目录
          await tryRmdir(sessionDir, fsImpl)
          continue
        }
        for (const toolEntry of toolDirs) {
          if (toolEntry.isFile()) {
            try {
              if (
                await unlinkIfOld(
                  join(toolResultsDir, toolEntry.name),
                  cutoffDate,
                  fsImpl,
                )
              ) {
                result.messages++
              }
            } catch {
              result.errors++
            }
          } else if (toolEntry.isDirectory()) {
            // 工具结果目录内可能还有二级子目录（如截图等）
            const toolDirPath = join(toolResultsDir, toolEntry.name)
            let toolFiles
            try {
              toolFiles = await fsImpl.readdir(toolDirPath)
            } catch {
              continue
            }
            for (const tf of toolFiles) {
              if (!tf.isFile()) continue
              try {
                if (
                  await unlinkIfOld(
                    join(toolDirPath, tf.name),
                    cutoffDate,
                    fsImpl,
                  )
                ) {
                  result.messages++
                }
              } catch {
                result.errors++
              }
            }
            // 清理完工具子目录内的文件后，尝试删除空目录
            await tryRmdir(toolDirPath, fsImpl)
          }
        }
        // 逐层向上清理空目录
        await tryRmdir(toolResultsDir, fsImpl)
        await tryRmdir(sessionDir, fsImpl)
      }
    }

    // 所有会话清理完毕后，尝试删除空的项目目录
    await tryRmdir(projectDir, fsImpl)
  }

  return result
}

/**
 * 清理单个目录中过期的特定扩展名文件，可选地在清理后删除空目录。
 * 是 cleanupOldPlanFiles 等单目录清理函数的通用后端实现。
 * @param dirPath        要清理的目录路径
 * @param extension      文件扩展名过滤（如 '.md'、'.jsonl'）
 * @param removeEmptyDir 清理后是否尝试删除目录（默认 true）
 */
async function cleanupSingleDirectory(
  dirPath: string,
  extension: string,
  removeEmptyDir: boolean = true,
): Promise<CleanupResult> {
  const cutoffDate = getCutoffDate()
  const result: CleanupResult = { messages: 0, errors: 0 }
  const fsImpl = getFsImplementation()

  let dirents
  try {
    dirents = await fsImpl.readdir(dirPath)
  } catch {
    return result
  }

  for (const dirent of dirents) {
    if (!dirent.isFile() || !dirent.name.endsWith(extension)) continue
    try {
      if (await unlinkIfOld(join(dirPath, dirent.name), cutoffDate, fsImpl)) {
        result.messages++
      }
    } catch {
      result.errors++
    }
  }

  if (removeEmptyDir) {
    await tryRmdir(dirPath, fsImpl)
  }

  return result
}

/**
 * 清理 ~/.claude/plans/ 目录中过期的 Markdown 计划文件。
 * 委托给通用的 cleanupSingleDirectory，按 .md 后缀过滤。
 */
export function cleanupOldPlanFiles(): Promise<CleanupResult> {
  const plansDir = join(getClaudeConfigHomeDir(), 'plans')
  return cleanupSingleDirectory(plansDir, '.md')
}

/**
 * 清理 ~/.claude/file-history/ 下过期的文件历史备份目录。
 * 以会话为粒度（每个子目录对应一个会话），当整个会话目录的 mtime
 * 早于截止日期时，递归删除整个目录树，而非逐文件处理。
 */
export async function cleanupOldFileHistoryBackups(): Promise<CleanupResult> {
  const cutoffDate = getCutoffDate()
  const result: CleanupResult = { messages: 0, errors: 0 }
  const fsImpl = getFsImplementation()

  try {
    const configDir = getClaudeConfigHomeDir()
    const fileHistoryStorageDir = join(configDir, 'file-history')

    let dirents
    try {
      dirents = await fsImpl.readdir(fileHistoryStorageDir)
    } catch {
      return result
    }

    const fileHistorySessionsDirs = dirents
      .filter(dirent => dirent.isDirectory())
      .map(dirent => join(fileHistoryStorageDir, dirent.name))

    await Promise.all(
      fileHistorySessionsDirs.map(async fileHistorySessionDir => {
        try {
          const stats = await fsImpl.stat(fileHistorySessionDir)
          if (stats.mtime < cutoffDate) {
            // 整个会话备份目录已过期，递归删除（force 避免因子文件权限问题中断）
            await fsImpl.rm(fileHistorySessionDir, {
              recursive: true,
              force: true,
            })
            result.messages++
          }
        } catch {
          result.errors++
        }
      }),
    )

    // 所有会话目录处理完毕后，尝试删除已空的根目录
    await tryRmdir(fileHistoryStorageDir, fsImpl)
  } catch (error) {
    logError(error as Error)
  }

  return result
}

/**
 * 清理 ~/.claude/session-env/ 下过期的会话环境变量目录。
 * 每个子目录对应一个会话的环境快照，以目录 mtime 判断是否过期，
 * 过期则整体递归删除。
 */
export async function cleanupOldSessionEnvDirs(): Promise<CleanupResult> {
  const cutoffDate = getCutoffDate()
  const result: CleanupResult = { messages: 0, errors: 0 }
  const fsImpl = getFsImplementation()

  try {
    const configDir = getClaudeConfigHomeDir()
    const sessionEnvBaseDir = join(configDir, 'session-env')

    let dirents
    try {
      dirents = await fsImpl.readdir(sessionEnvBaseDir)
    } catch {
      return result
    }

    const sessionEnvDirs = dirents
      .filter(dirent => dirent.isDirectory())
      .map(dirent => join(sessionEnvBaseDir, dirent.name))

    for (const sessionEnvDir of sessionEnvDirs) {
      try {
        const stats = await fsImpl.stat(sessionEnvDir)
        if (stats.mtime < cutoffDate) {
          await fsImpl.rm(sessionEnvDir, { recursive: true, force: true })
          result.messages++
        }
      } catch {
        result.errors++
      }
    }

    await tryRmdir(sessionEnvBaseDir, fsImpl)
  } catch (error) {
    logError(error as Error)
  }

  return result
}

/**
 * 清理 ~/.claude/debug/ 目录中过期的调试日志文件（.txt）。
 * 特别保留名为 "latest" 的符号链接（指向当前会话日志），
 * 即使其他文件全部删除后也不移除 debug 目录本身（供后续日志写入）。
 */
export async function cleanupOldDebugLogs(): Promise<CleanupResult> {
  const cutoffDate = getCutoffDate()
  const result: CleanupResult = { messages: 0, errors: 0 }
  const fsImpl = getFsImplementation()
  const debugDir = join(getClaudeConfigHomeDir(), 'debug')

  let dirents
  try {
    dirents = await fsImpl.readdir(debugDir)
  } catch {
    return result
  }

  for (const dirent of dirents) {
    // 跳过非 .txt 文件和 "latest" 符号链接（当前会话日志的入口点）
    if (
      !dirent.isFile() ||
      !dirent.name.endsWith('.txt') ||
      dirent.name === 'latest'
    ) {
      continue
    }
    try {
      if (await unlinkIfOld(join(debugDir, dirent.name), cutoffDate, fsImpl)) {
        result.messages++
      }
    } catch {
      result.errors++
    }
  }

  // 刻意不删除 debugDir 本身，即使为空——后续日志需要该目录存在
  return result
}

// 节流清理的时间窗口：同一清理任务 24 小时内最多执行一次
const ONE_DAY_MS = 24 * 60 * 60 * 1000

/**
 * 清理 npm 缓存中 @anthropic-ai/claude-* 包的旧版本条目。
 * 以每个包保留最近 5 个版本为准，并删除超过 1 天的旧条目，
 * 避免频繁发布的 dev 版本导致 npm 缓存无限膨胀。
 *
 * 使用标记文件 + 文件锁限制每天最多执行一次，且只在 Anthropic 内部用户
 * （process.env.USER_TYPE === 'ant'）的环境中运行。
 * 采用 cacache.ls.stream() 替代 cacache.verify()，避免全量完整性校验
 * 在大型缓存上耗时 60 秒以上、阻塞事件循环的问题。
 */
export async function cleanupNpmCacheForAnthropicPackages(): Promise<void> {
  const markerPath = join(getClaudeConfigHomeDir(), '.npm-cache-cleanup')

  try {
    const stat = await fs.stat(markerPath)
    if (Date.now() - stat.mtimeMs < ONE_DAY_MS) {
      // 标记文件存在且在 24 小时内更新过，跳过本次清理
      logForDebugging('npm cache cleanup: skipping, ran recently')
      return
    }
  } catch {
    // 标记文件不存在，说明从未运行过，继续执行
  }

  try {
    // 使用文件锁避免多进程并发执行同一清理任务（retries: 0 表示获取失败立即放弃）
    await lockfile.lock(markerPath, { retries: 0, realpath: false })
  } catch {
    logForDebugging('npm cache cleanup: skipping, lock held')
    return
  }

  logForDebugging('npm cache cleanup: starting')

  const npmCachePath = join(homedir(), '.npm', '_cacache')

  const NPM_CACHE_RETENTION_COUNT = 5

  const startTime = Date.now()
  try {
    const cacache = await import('cacache')
    const cutoff = startTime - ONE_DAY_MS

    // 使用流式 API 遍历缓存索引，只收集 @anthropic-ai/claude-* 条目，
    // 避免 cacache.verify() 对所有内容块进行完整性校验（会触发全量 I/O）
    const stream = cacache.ls.stream(npmCachePath)
    const anthropicEntries: { key: string; time: number }[] = []
    for await (const entry of stream as AsyncIterable<{
      key: string
      time: number
    }>) {
      if (entry.key.includes('@anthropic-ai/claude-')) {
        anthropicEntries.push({ key: entry.key, time: entry.time })
      }
    }

    // 按包名分组：截取最后一个 @ 之前的部分作为包名键
    const byPackage = new Map<string, { key: string; time: number }[]>()
    for (const entry of anthropicEntries) {
      const atVersionIdx = entry.key.lastIndexOf('@')
      const pkgName =
        atVersionIdx > 0 ? entry.key.slice(0, atVersionIdx) : entry.key
      const existing = byPackage.get(pkgName) ?? []
      existing.push(entry)
      byPackage.set(pkgName, existing)
    }

    // 对每个包：保留最新的 N 个版本，同时删除超过 1 天的旧条目
    const keysToRemove: string[] = []
    for (const [, entries] of byPackage) {
      entries.sort((a, b) => b.time - a.time) // 按时间降序（最新的排最前）
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i]!
        // 超过保留数量上限，或者条目本身已超过 1 天，均标记为待删除
        if (entry.time < cutoff || i >= NPM_CACHE_RETENTION_COUNT) {
          keysToRemove.push(entry.key)
        }
      }
    }

    await Promise.all(
      keysToRemove.map(key => cacache.rm.entry(npmCachePath, key)),
    )

    // 更新标记文件时间戳，记录本次清理时间
    await fs.writeFile(markerPath, new Date().toISOString())

    const durationMs = Date.now() - startTime
    if (keysToRemove.length > 0) {
      logForDebugging(
        `npm cache cleanup: Removed ${keysToRemove.length} old @anthropic-ai entries in ${durationMs}ms`,
      )
    } else {
      logForDebugging(`npm cache cleanup: completed in ${durationMs}ms`)
    }
    logEvent('tengu_npm_cache_cleanup', {
      success: true,
      durationMs,
      entriesRemoved: keysToRemove.length,
    })
  } catch (error) {
    logError(error as Error)
    logEvent('tengu_npm_cache_cleanup', {
      success: false,
      durationMs: Date.now() - startTime,
    })
  } finally {
    await lockfile.unlock(markerPath, { realpath: false }).catch(() => {})
  }
}

/**
 * 节流版旧版本清理：封装 cleanupOldVersions()，限制每 24 小时最多执行一次。
 * 使用标记文件记录上次执行时间，文件锁防止多进程并发执行。
 * 与安装流程（installer）中直接调用 cleanupOldVersions() 不同，
 * 此函数专用于长会话中的定期后台清理，不阻塞用户操作。
 */
export async function cleanupOldVersionsThrottled(): Promise<void> {
  const markerPath = join(getClaudeConfigHomeDir(), '.version-cleanup')

  try {
    const stat = await fs.stat(markerPath)
    if (Date.now() - stat.mtimeMs < ONE_DAY_MS) {
      // 24 小时内已执行过，跳过
      logForDebugging('version cleanup: skipping, ran recently')
      return
    }
  } catch {
    // 标记文件不存在，首次执行，继续
  }

  try {
    // 获取文件锁，失败（锁已被其他进程持有）则跳过本次清理
    await lockfile.lock(markerPath, { retries: 0, realpath: false })
  } catch {
    logForDebugging('version cleanup: skipping, lock held')
    return
  }

  logForDebugging('version cleanup: starting (throttled)')

  try {
    await cleanupOldVersions()
    await fs.writeFile(markerPath, new Date().toISOString())
  } catch (error) {
    logError(error as Error)
  } finally {
    await lockfile.unlock(markerPath, { realpath: false }).catch(() => {})
  }
}

/**
 * 后台批量执行所有清理任务的入口函数。
 * 按顺序调用各类清理函数（消息、会话、计划、文件历史、环境目录、
 * 调试日志、图片缓存、粘贴内容、Agent worktree 等），并汇报统计结果。
 *
 * 安全防护：若 settings.json 含校验错误且用户显式配置了 cleanupPeriodDays，
 * 则跳过所有清理，避免因配置解析失败导致使用错误的保留周期而误删文件。
 *
 * Anthropic 内部用户（USER_TYPE=ant）还会额外执行 npm 缓存清理。
 */
export async function cleanupOldMessageFilesInBackground(): Promise<void> {
  // 若设置文件有错误但用户明确配置了 cleanupPeriodDays，跳过清理以防误删
  const { errors } = getSettingsWithAllErrors()
  if (errors.length > 0 && rawSettingsContainsKey('cleanupPeriodDays')) {
    logForDebugging(
      'Skipping cleanup: settings have validation errors but cleanupPeriodDays was explicitly set. Fix settings errors to enable cleanup.',
    )
    return
  }

  await cleanupOldMessageFiles()
  await cleanupOldSessionFiles()
  await cleanupOldPlanFiles()
  await cleanupOldFileHistoryBackups()
  await cleanupOldSessionEnvDirs()
  await cleanupOldDebugLogs()
  await cleanupOldImageCaches()
  await cleanupOldPastes(getCutoffDate())
  // 清理过期的 Agent worktree，并在有实际删除时上报统计事件
  const removedWorktrees = await cleanupStaleAgentWorktrees(getCutoffDate())
  if (removedWorktrees > 0) {
    logEvent('tengu_worktree_cleanup', { removed: removedWorktrees })
  }
  // npm 缓存清理仅对 Anthropic 内部用户开启（外部用户无需此操作）
  if (process.env.USER_TYPE === 'ant') {
    await cleanupNpmCacheForAnthropicPackages()
  }
}
