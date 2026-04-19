/**
 * fileSuggestions.ts
 *
 * 【在 Claude Code 系统中的位置】
 * 本文件属于 hooks 层，是用户在 PromptInput 输入框中键入 "@" 或文件路径时，
 * 提供文件自动补全候选项的核心模块。
 *
 * 【主要功能】
 * 1. 通过 git ls-files（快速）或 ripgrep（兜底）获取项目所有文件列表；
 * 2. 将文件列表加载进 Rust/nucleo 的 FileIndex，支持模糊搜索；
 * 3. 管理文件索引缓存、增量刷新（后台拉取未跟踪文件）；
 * 4. 暴露 generateFileSuggestions / applyFileSuggestion 等方法给 UI 层使用；
 * 5. 支持 .ignore/.rgignore 过滤、tilde 路径展开、自定义 fileSuggestion 命令钩子。
 */

import { statSync } from 'fs'
import ignore from 'ignore'
import * as path from 'path'
import {
  CLAUDE_CONFIG_DIRECTORIES,
  loadMarkdownFilesForSubdir,
} from 'src/utils/markdownConfigLoader.js'
import type { SuggestionItem } from '../components/PromptInput/PromptInputFooterSuggestions.js'
import {
  CHUNK_MS,
  FileIndex,
  yieldToEventLoop,
} from '../native-ts/file-index/index.js'
import { logEvent } from '../services/analytics/index.js'
import type { FileSuggestionCommandInput } from '../types/fileSuggestion.js'
import { getGlobalConfig } from '../utils/config.js'
import { getCwd } from '../utils/cwd.js'
import { logForDebugging } from '../utils/debug.js'
import { errorMessage } from '../utils/errors.js'
import { execFileNoThrowWithCwd } from '../utils/execFileNoThrow.js'
import { getFsImplementation } from '../utils/fsOperations.js'
import { findGitRoot, gitExe } from '../utils/git.js'
import {
  createBaseHookInput,
  executeFileSuggestionCommand,
} from '../utils/hooks.js'
import { logError } from '../utils/log.js'
import { expandPath } from '../utils/path.js'
import { ripGrep } from '../utils/ripgrep.js'
import { getInitialSettings } from '../utils/settings/settings.js'
import { createSignal } from '../utils/signal.js'

// 惰性初始化的单例 FileIndex，首次调用 getFileIndex() 时创建
let fileIndex: FileIndex | null = null

/**
 * 获取 FileIndex 单例。
 * 若尚未创建则新建一个，保证全局只有一个 FileIndex 实例。
 */
function getFileIndex(): FileIndex {
  if (!fileIndex) {
    // 首次调用时初始化 Rust/nucleo 文件索引对象
    fileIndex = new FileIndex()
  }
  return fileIndex
}

// 当前正在进行的文件列表刷新 Promise，防止并发重复刷新
let fileListRefreshPromise: Promise<FileIndex> | null = null
// 索引构建完成信号：让 typeahead UI 在部分结果升级为完整结果后重新搜索
const indexBuildComplete = createSignal()
// 订阅索引构建完成事件的函数，供外部 hook 使用
export const onIndexBuildComplete = indexBuildComplete.subscribe
// 缓存代数：每次 clearFileSuggestionCaches() 时递增，用于检测过期数据
let cacheGeneration = 0

// 后台拉取未跟踪文件的 Promise（不阻塞主流程）
let untrackedFetchPromise: Promise<void> | null = null

// 已跟踪文件列表缓存，供 mergeUntrackedIntoNormalizedCache 使用
let cachedTrackedFiles: string[] = []
// Claude 配置文件列表缓存，合并时一并写入 FileIndex
let cachedConfigFiles: string[] = []
// 已跟踪文件的目录列表缓存，避免合并时重复计算 ~270k 次 path.dirname()
let cachedTrackedDirs: string[] = []

// .ignore/.rgignore 忽略规则缓存（以 repoRoot:cwd 为 key）
let ignorePatternsCache: ReturnType<typeof ignore> | null = null
let ignorePatternsCacheKey: string | null = null

// 后台刷新节流状态：
// - .git/index mtime 变化时立即刷新（git add/checkout/commit/rm 等操作）
// - 否则每 5 秒最多刷新一次（用于捕获未跟踪文件变化）
let lastRefreshMs = 0
let lastGitIndexMtime: number | null = null

// 已加载到 Rust 索引的路径列表签名（两个分别对应两个 loadFromFileList 调用场景）
// 签名相同时跳过 nucleo.restart()，避免 git ls-files 返回相同结果时重建
let loadedTrackedSignature: string | null = null
let loadedMergedSignature: string | null = null

/**
 * 清空所有文件建议缓存。
 * 恢复会话时调用，确保重新发现文件列表，不使用过期数据。
 */
export function clearFileSuggestionCaches(): void {
  fileIndex = null                       // 销毁 FileIndex 单例
  fileListRefreshPromise = null          // 取消进行中的刷新 Promise
  cacheGeneration++                      // 递增代数，使旧异步任务的结果失效
  untrackedFetchPromise = null           // 取消后台未跟踪文件拉取
  cachedTrackedFiles = []                // 清空已跟踪文件缓存
  cachedConfigFiles = []                 // 清空配置文件缓存
  cachedTrackedDirs = []                 // 清空目录缓存
  indexBuildComplete.clear()             // 清空构建完成信号的订阅
  ignorePatternsCache = null             // 清空 ignore 规则缓存
  ignorePatternsCacheKey = null          // 清空 ignore 缓存 key
  lastRefreshMs = 0                      // 重置上次刷新时间
  lastGitIndexMtime = null               // 重置 .git/index mtime 记录
  loadedTrackedSignature = null          // 重置已加载的跟踪路径签名
  loadedMergedSignature = null           // 重置已加载的合并路径签名
}

/**
 * 计算路径列表的内容哈希签名。
 *
 * 采样策略：每 N 条路径采样一次（加上长度和首尾路径），
 * 在 346k 条路径的列表上只哈希 ~700 条，耗时 <1ms。
 * 能检测到 git checkout/rebase/add/rm 等操作引起的变化。
 * 极少情况下（采样间隙内的单次重命名）可能漏检，但 5 秒兜底刷新会补上。
 *
 * @param paths 路径数组
 * @returns 格式为 "length:hex" 的签名字符串
 */
export function pathListSignature(paths: string[]): string {
  const n = paths.length
  // 计算采样步长，最小为 1
  const stride = Math.max(1, Math.floor(n / 500))
  // FNV-1a 32 位哈希初始值
  let h = 0x811c9dc5 | 0
  for (let i = 0; i < n; i += stride) {
    const p = paths[i]!
    // 对每个采样路径的每个字符进行 FNV-1a 哈希
    for (let j = 0; j < p.length; j++) {
      h = ((h ^ p.charCodeAt(j)) * 0x01000193) | 0
    }
    // 路径间分隔哈希，避免 "ab"+"c" 与 "a"+"bc" 碰撞
    h = (h * 0x01000193) | 0
  }
  // 始终包含最后一条路径，捕获尾部增删
  if (n > 0) {
    const last = paths[n - 1]!
    for (let j = 0; j < last.length; j++) {
      h = ((h ^ last.charCodeAt(j)) * 0x01000193) | 0
    }
  }
  // 返回 "总数:哈希十六进制" 格式，总数不同时直接短路
  return `${n}:${(h >>> 0).toString(16)}`
}

/**
 * 通过 stat .git/index 检测 git 状态变化，无需运行 git ls-files。
 *
 * 对 worktree（.git 是文件 → ENOTDIR）、空仓库（无 index → ENOENT）
 * 以及非 git 目录返回 null，调用方回退到时间节流逻辑。
 *
 * @returns .git/index 的 mtime 毫秒数，或 null
 */
function getGitIndexMtime(): number | null {
  const repoRoot = findGitRoot(getCwd())
  if (!repoRoot) return null
  try {
    // 同步 stat，因为这里只读 mtime，开销可接受（findGitRoot 本身已同步遍历）
    // eslint-disable-next-line custom-rules/no-sync-fs -- mtimeMs is the operation here, not a pre-check. findGitRoot above already stat-walks synchronously; one more stat is marginal vs spawning git ls-files on every keystroke. Async would force startBackgroundCacheRefresh to become async, breaking the synchronous fileListRefreshPromise contract at the cold-start await site.
    return statSync(path.join(repoRoot, '.git', 'index')).mtimeMs
  } catch {
    // 无法读取时静默返回 null
    return null
  }
}

/**
 * 将 git ls-files 返回的相对路径（相对于仓库根）转换为相对于 originalCwd 的路径。
 *
 * @param files    git ls-files 返回的路径列表（相对于 repoRoot）
 * @param repoRoot git 仓库根目录绝对路径
 * @param originalCwd 当前工作目录绝对路径
 * @returns 相对于 originalCwd 的路径数组
 */
function normalizeGitPaths(
  files: string[],
  repoRoot: string,
  originalCwd: string,
): string[] {
  // 若工作目录与仓库根相同，路径无需转换
  if (originalCwd === repoRoot) {
    return files
  }
  // 先拼成绝对路径，再转为相对于 cwd 的路径
  return files.map(f => {
    const absolutePath = path.join(repoRoot, f)
    return path.relative(originalCwd, absolutePath)
  })
}

/**
 * 将已归一化的未跟踪文件合并进缓存，并重建 FileIndex。
 *
 * 合并逻辑：将已跟踪文件、配置文件、目录、未跟踪文件及其目录全部写入 nucleo。
 * 若合并后路径签名未变化则跳过重建，避免无意义的 nucleo.restart()。
 *
 * @param normalizedUntracked 已归一化（相对于 cwd）的未跟踪文件路径数组
 */
async function mergeUntrackedIntoNormalizedCache(
  normalizedUntracked: string[],
): Promise<void> {
  // 无未跟踪文件或缓存尚未初始化时直接返回
  if (normalizedUntracked.length === 0) return
  if (!fileIndex || cachedTrackedFiles.length === 0) return

  // 异步获取未跟踪文件的目录列表（大文件集避免阻塞主线程）
  const untrackedDirs = await getDirectoryNamesAsync(normalizedUntracked)
  // 合并所有路径：已跟踪 + 配置文件 + 已跟踪目录 + 未跟踪 + 未跟踪目录
  const allPaths = [
    ...cachedTrackedFiles,
    ...cachedConfigFiles,
    ...cachedTrackedDirs,
    ...normalizedUntracked,
    ...untrackedDirs,
  ]
  // 计算合并后签名，与上次已加载签名比较
  const sig = pathListSignature(allPaths)
  if (sig === loadedMergedSignature) {
    // 签名未变，跳过重建
    logForDebugging(
      `[FileIndex] skipped index rebuild — merged paths unchanged`,
    )
    return
  }
  // 异步加载合并路径到 FileIndex
  await fileIndex.loadFromFileListAsync(allPaths).done
  loadedMergedSignature = sig
  logForDebugging(
    `[FileIndex] rebuilt index with ${cachedTrackedFiles.length} tracked + ${normalizedUntracked.length} untracked files`,
  )
}

/**
 * 从 .ignore/.rgignore 文件加载 ripgrep 专用忽略规则。
 *
 * 在 repoRoot 和 cwd 两个目录下各查找 .ignore 和 .rgignore。
 * 结果按 repoRoot:cwd 缓存，同一会话内复用。
 *
 * @param repoRoot git 仓库根目录绝对路径
 * @param cwd      当前工作目录绝对路径
 * @returns 含有规则的 ignore 实例，或在没有规则文件时返回 null
 */
async function loadRipgrepIgnorePatterns(
  repoRoot: string,
  cwd: string,
): Promise<ReturnType<typeof ignore> | null> {
  const cacheKey = `${repoRoot}:${cwd}`

  // 命中缓存时直接返回
  if (ignorePatternsCacheKey === cacheKey) {
    return ignorePatternsCache
  }

  const fs = getFsImplementation()
  const ignoreFiles = ['.ignore', '.rgignore']
  // 用 Set 去重（repoRoot 与 cwd 可能相同）
  const directories = [...new Set([repoRoot, cwd])]

  const ig = ignore()
  let hasPatterns = false

  // 构建所有待读取路径：repoRoot/.ignore, repoRoot/.rgignore, cwd/.ignore, cwd/.rgignore
  const paths = directories.flatMap(dir =>
    ignoreFiles.map(f => path.join(dir, f)),
  )
  // 并发读取所有文件，读取失败时静默返回 null
  const contents = await Promise.all(
    paths.map(p => fs.readFile(p, { encoding: 'utf8' }).catch(() => null)),
  )
  for (const [i, content] of contents.entries()) {
    if (content === null) continue
    ig.add(content)         // 将文件内容添加到 ignore 实例
    hasPatterns = true
    logForDebugging(`[FileIndex] loaded ignore patterns from ${paths[i]}`)
  }

  // 没有规则文件时缓存 null，避免重复读取
  const result = hasPatterns ? ig : null
  ignorePatternsCache = result
  ignorePatternsCacheKey = cacheKey

  return result
}

/**
 * 使用 git ls-files 获取项目文件列表（比 ripgrep 快得多）。
 *
 * 立即返回已跟踪文件，未跟踪文件在后台异步拉取并合并。
 *
 * 注意：与 ripgrep --follow 不同，git ls-files 不跟随符号链接（git 将其作为链接跟踪）。
 *
 * @param abortSignal      中止信号，超时或取消时使用
 * @param respectGitignore 是否在未跟踪文件中排除 .gitignore 匹配项
 * @returns 归一化的已跟踪文件路径数组，非 git 目录或失败时返回 null
 */
async function getFilesUsingGit(
  abortSignal: AbortSignal,
  respectGitignore: boolean,
): Promise<string[] | null> {
  const startTime = Date.now()
  logForDebugging(`[FileIndex] getFilesUsingGit called`)

  // 检查是否处于 git 仓库（findGitRoot 带 LRU 缓存）
  const repoRoot = findGitRoot(getCwd())
  if (!repoRoot) {
    logForDebugging(`[FileIndex] not a git repo, returning null`)
    return null
  }

  try {
    const cwd = getCwd()

    // 运行 git ls-files 获取已跟踪文件（从仓库根运行以获得相对仓库根的路径）
    const lsFilesStart = Date.now()
    const trackedResult = await execFileNoThrowWithCwd(
      gitExe(),
      ['-c', 'core.quotepath=false', 'ls-files', '--recurse-submodules'],
      { timeout: 5000, abortSignal, cwd: repoRoot },
    )
    logForDebugging(
      `[FileIndex] git ls-files (tracked) took ${Date.now() - lsFilesStart}ms`,
    )

    if (trackedResult.code !== 0) {
      // git ls-files 失败，回退到 ripgrep
      logForDebugging(
        `[FileIndex] git ls-files failed (code=${trackedResult.code}, stderr=${trackedResult.stderr}), falling back to ripgrep`,
      )
      return null
    }

    // 解析标准输出，过滤空行
    const trackedFiles = trackedResult.stdout.trim().split('\n').filter(Boolean)

    // 将路径归一化为相对于当前工作目录
    let normalizedTracked = normalizeGitPaths(trackedFiles, repoRoot, cwd)

    // 应用 .ignore/.rgignore 规则（比回退到 ripgrep 更快）
    const ignorePatterns = await loadRipgrepIgnorePatterns(repoRoot, cwd)
    if (ignorePatterns) {
      const beforeCount = normalizedTracked.length
      normalizedTracked = ignorePatterns.filter(normalizedTracked)
      logForDebugging(
        `[FileIndex] applied ignore patterns: ${beforeCount} -> ${normalizedTracked.length} files`,
      )
    }

    // 缓存已跟踪文件，供后续与未跟踪文件合并使用
    cachedTrackedFiles = normalizedTracked

    const duration = Date.now() - startTime
    logForDebugging(
      `[FileIndex] git ls-files: ${normalizedTracked.length} tracked files in ${duration}ms`,
    )

    // 上报 analytics 事件
    logEvent('tengu_file_suggestions_git_ls_files', {
      file_count: normalizedTracked.length,
      tracked_count: normalizedTracked.length,
      untracked_count: 0,
      duration_ms: duration,
    })

    // 在后台拉取未跟踪文件（不阻塞主流程），仅在首次或上次完成后启动
    if (!untrackedFetchPromise) {
      // 根据 respectGitignore 决定是否排除 .gitignore 中的文件
      const untrackedArgs = respectGitignore
        ? [
            '-c',
            'core.quotepath=false',
            'ls-files',
            '--others',
            '--exclude-standard', // 遵循 .gitignore
          ]
        : ['-c', 'core.quotepath=false', 'ls-files', '--others']

      const generation = cacheGeneration
      untrackedFetchPromise = execFileNoThrowWithCwd(gitExe(), untrackedArgs, {
        timeout: 10000,
        cwd: repoRoot,
      })
        .then(async untrackedResult => {
          // 若缓存已被清空（会话切换），丢弃过期数据
          if (generation !== cacheGeneration) {
            return
          }
          if (untrackedResult.code === 0) {
            const rawUntrackedFiles = untrackedResult.stdout
              .trim()
              .split('\n')
              .filter(Boolean)

            // 归一化路径（与已跟踪文件保持一致）
            let normalizedUntracked = normalizeGitPaths(
              rawUntrackedFiles,
              repoRoot,
              cwd,
            )

            // 对归一化后的未跟踪文件应用 .ignore/.rgignore 规则
            const ignorePatterns = await loadRipgrepIgnorePatterns(
              repoRoot,
              cwd,
            )
            if (ignorePatterns && normalizedUntracked.length > 0) {
              const beforeCount = normalizedUntracked.length
              normalizedUntracked = ignorePatterns.filter(normalizedUntracked)
              logForDebugging(
                `[FileIndex] applied ignore patterns to untracked: ${beforeCount} -> ${normalizedUntracked.length} files`,
              )
            }

            logForDebugging(
              `[FileIndex] background untracked fetch: ${normalizedUntracked.length} files`,
            )
            // 将已归一化的未跟踪文件合并进缓存（fire-and-forget）
            void mergeUntrackedIntoNormalizedCache(normalizedUntracked)
          }
        })
        .catch(error => {
          // 后台拉取失败时仅记录日志，不影响主流程
          logForDebugging(
            `[FileIndex] background untracked fetch failed: ${error}`,
          )
        })
        .finally(() => {
          // 完成后重置 Promise，允许下次触发
          untrackedFetchPromise = null
        })
    }

    return normalizedTracked
  } catch (error) {
    logForDebugging(`[FileIndex] git ls-files error: ${errorMessage(error)}`)
    return null
  }
}

/**
 * 收集文件路径数组中每个文件的所有祖先目录名，返回带尾部分隔符的唯一目录列表。
 *
 * 例如输入 ['src/index.js', 'src/utils/helpers.js']，
 * 输出 ['src/', 'src/utils/']。
 *
 * @param files 文件路径数组
 * @returns 带尾部路径分隔符的唯一目录名数组
 */
export function getDirectoryNames(files: string[]): string[] {
  const directoryNames = new Set<string>()
  collectDirectoryNames(files, 0, files.length, directoryNames)
  // 为每个目录名添加尾部分隔符
  return [...directoryNames].map(d => d + path.sep)
}

/**
 * getDirectoryNames 的异步版本：每处理 ~10k 条文件后让出事件循环，
 * 避免在 270k+ 文件列表上阻塞主线程超过 10ms。
 *
 * @param files 文件路径数组
 * @returns 带尾部路径分隔符的唯一目录名数组
 */
export async function getDirectoryNamesAsync(
  files: string[],
): Promise<string[]> {
  const directoryNames = new Set<string>()
  // 基于时间的分块：超过 CHUNK_MS 后让出，慢机器自动获得更小的块
  let chunkStart = performance.now()
  for (let i = 0; i < files.length; i++) {
    collectDirectoryNames(files, i, i + 1, directoryNames)
    // 每 256 条检查一次时间，超过阈值则让出事件循环
    if ((i & 0xff) === 0xff && performance.now() - chunkStart > CHUNK_MS) {
      await yieldToEventLoop()
      chunkStart = performance.now()
    }
  }
  return [...directoryNames].map(d => d + path.sep)
}

/**
 * 内部辅助函数：将 files[start..end) 范围内文件的所有祖先目录收集到 out 集合中。
 *
 * 使用"已见即跳过"提前退出策略：一旦遇到已在集合中的目录，
 * 其所有祖先也必然已在集合中，直接停止向上遍历。
 *
 * @param files 文件路径数组
 * @param start 起始索引（含）
 * @param end   结束索引（不含）
 * @param out   输出目录集合
 */
function collectDirectoryNames(
  files: string[],
  start: number,
  end: number,
  out: Set<string>,
): void {
  for (let i = start; i < end; i++) {
    let currentDir = path.dirname(files[i]!)
    // 当目录为 '.' 或已处理过时退出；path.dirname 到根时返回自身（不动点）
    while (currentDir !== '.' && !out.has(currentDir)) {
      const parent = path.dirname(currentDir)
      // path.dirname 到达根时返回自身，此时停止，避免将根目录加入结果
      if (parent === currentDir) break
      out.add(currentDir)
      currentDir = parent
    }
  }
}

/**
 * 从 Claude 配置目录获取额外的 Markdown 文件路径（如 .claude/commands/）。
 *
 * @param cwd 当前工作目录
 * @returns 配置目录下所有 Markdown 文件的路径数组
 */
async function getClaudeConfigFiles(cwd: string): Promise<string[]> {
  // 并发从所有配置子目录加载 Markdown 文件
  const markdownFileArrays = await Promise.all(
    CLAUDE_CONFIG_DIRECTORIES.map(subdir =>
      loadMarkdownFilesForSubdir(subdir, cwd),
    ),
  )
  // 展开二维数组并提取文件路径
  return markdownFileArrays.flatMap(markdownFiles =>
    markdownFiles.map(f => f.filePath),
  )
}

/**
 * 获取项目文件列表：优先使用 git ls-files（快），失败则回退到 ripgrep。
 *
 * @param abortSignal      中止信号
 * @param respectGitignore 是否遵循 .gitignore 规则
 * @returns 相对于当前工作目录的文件路径数组
 */
async function getProjectFiles(
  abortSignal: AbortSignal,
  respectGitignore: boolean,
): Promise<string[]> {
  logForDebugging(
    `[FileIndex] getProjectFiles called, respectGitignore=${respectGitignore}`,
  )

  // 优先尝试 git ls-files（git 仓库下速度极快）
  const gitFiles = await getFilesUsingGit(abortSignal, respectGitignore)
  if (gitFiles !== null) {
    logForDebugging(
      `[FileIndex] using git ls-files result (${gitFiles.length} files)`,
    )
    return gitFiles
  }

  // git ls-files 不可用（非 git 仓库或失败），回退到 ripgrep
  logForDebugging(
    `[FileIndex] git ls-files returned null, falling back to ripgrep`,
  )
  const startTime = Date.now()
  // 构建 ripgrep 参数：列出所有文件，排除常见 VCS 目录
  const rgArgs = [
    '--files',
    '--follow',   // 跟随符号链接
    '--hidden',   // 包含隐藏文件
    '--glob', '!.git/',
    '--glob', '!.svn/',
    '--glob', '!.hg/',
    '--glob', '!.bzr/',
    '--glob', '!.jj/',
    '--glob', '!.sl/',
  ]
  if (!respectGitignore) {
    // 不遵循 VCS 忽略规则（用于 --no-ignore-vcs 场景）
    rgArgs.push('--no-ignore-vcs')
  }

  const files = await ripGrep(rgArgs, '.', abortSignal)
  // 转换为相对于当前工作目录的路径
  const relativePaths = files.map(f => path.relative(getCwd(), f))

  const duration = Date.now() - startTime
  logForDebugging(
    `[FileIndex] ripgrep: ${relativePaths.length} files in ${duration}ms`,
  )

  // 上报 analytics 事件
  logEvent('tengu_file_suggestions_ripgrep', {
    file_count: relativePaths.length,
    duration_ms: duration,
  })

  return relativePaths
}

/**
 * 获取用于建议的所有路径（文件 + 目录），并将其加载进 FileIndex 以支持模糊搜索。
 *
 * 流程：
 * 1. 读取项目设置和全局配置，确定是否遵循 .gitignore；
 * 2. 并发获取项目文件和 Claude 配置文件；
 * 3. 计算目录列表；
 * 4. 若路径签名未变则跳过重建；
 * 5. 异步加载到 FileIndex（构建期间可渐进查询）。
 *
 * @returns 已填充数据的 FileIndex 实例（可能部分构建完成）
 */
export async function getPathsForSuggestions(): Promise<FileIndex> {
  // 10 秒超时保护
  const signal = AbortSignal.timeout(10_000)
  const index = getFileIndex()

  try {
    // 读取项目设置，优先项目级，其次全局级，最后默认 true
    const projectSettings = getInitialSettings()
    const globalConfig = getGlobalConfig()
    const respectGitignore =
      projectSettings.respectGitignore ?? globalConfig.respectGitignore ?? true

    const cwd = getCwd()
    // 并发获取项目文件和 Claude 配置文件
    const [projectFiles, configFiles] = await Promise.all([
      getProjectFiles(signal, respectGitignore),
      getClaudeConfigFiles(cwd),
    ])

    // 缓存配置文件，供 mergeUntrackedIntoNormalizedCache 合并时使用
    cachedConfigFiles = configFiles

    // 合并所有文件，计算目录列表
    const allFiles = [...projectFiles, ...configFiles]
    const directories = await getDirectoryNamesAsync(allFiles)
    cachedTrackedDirs = directories
    // 目录在前（更常用），文件在后
    const allPathsList = [...directories, ...allFiles]

    // 与上次已加载签名比较，相同则跳过 nucleo 重建
    const sig = pathListSignature(allPathsList)
    if (sig !== loadedTrackedSignature) {
      // 等待完整构建完成，保证冷启动时返回完整结果
      // 构建过程每 ~4ms 让出一次，UI 可在等待期间继续响应输入
      await index.loadFromFileListAsync(allPathsList).done
      loadedTrackedSignature = sig
      // 刚用仅跟踪数据替换了合并索引，强制下次未跟踪合并重建
      loadedMergedSignature = null
    } else {
      logForDebugging(
        `[FileIndex] skipped index rebuild — tracked paths unchanged`,
      )
    }
  } catch (error) {
    logError(error)
  }

  return index
}

/**
 * 找出两个字符串的公共前缀。
 *
 * @param a 字符串 a
 * @param b 字符串 b
 * @returns 公共前缀字符串
 */
function findCommonPrefix(a: string, b: string): string {
  const minLength = Math.min(a.length, b.length)
  let i = 0
  // 逐字符比较直到不同或到达较短字符串末尾
  while (i < minLength && a[i] === b[i]) {
    i++
  }
  return a.substring(0, i)
}

/**
 * 在建议列表中找出所有项目 displayText 的最长公共前缀。
 * 用于自动补全时确定可直接插入的公共部分。
 *
 * @param suggestions 建议项数组
 * @returns 所有建议项的最长公共前缀，空数组时返回空字符串
 */
export function findLongestCommonPrefix(suggestions: SuggestionItem[]): string {
  if (suggestions.length === 0) return ''

  const strings = suggestions.map(item => item.displayText)
  let prefix = strings[0]!
  for (let i = 1; i < strings.length; i++) {
    const currentString = strings[i]!
    // 逐步收缩前缀，找出与当前字符串的公共部分
    prefix = findCommonPrefix(prefix, currentString)
    if (prefix === '') return '' // 已无公共前缀，提前退出
  }
  return prefix
}

/**
 * 根据文件路径创建建议项对象。
 *
 * @param filePath 文件路径字符串
 * @param score    可选的模糊匹配得分（来自 nucleo）
 * @returns 格式化的 SuggestionItem
 */
function createFileSuggestionItem(
  filePath: string,
  score?: number,
): SuggestionItem {
  return {
    id: `file-${filePath}`,          // 唯一标识符，用于 React key
    displayText: filePath,             // 显示给用户的文本
    metadata: score !== undefined ? { score } : undefined, // 附带得分供排序使用
  }
}

/** 每次查询返回的最大建议数量 */
const MAX_SUGGESTIONS = 15

/**
 * 在 FileIndex 中搜索匹配给定部分路径的文件和目录。
 *
 * @param fileIndex   FileIndex 实例
 * @param partialPath 用户输入的部分路径
 * @returns 最多 MAX_SUGGESTIONS 条建议项
 */
function findMatchingFiles(
  fileIndex: FileIndex,
  partialPath: string,
): SuggestionItem[] {
  // 调用 nucleo 引擎进行模糊匹配
  const results = fileIndex.search(partialPath, MAX_SUGGESTIONS)
  return results.map(result =>
    createFileSuggestionItem(result.path, result.score),
  )
}

/** 后台刷新节流间隔（毫秒） */
const REFRESH_THROTTLE_MS = 5_000

/**
 * 在后台启动文件索引缓存刷新（若未在进行中）。
 *
 * 节流策略：
 * - 首次（冷启动）：立即刷新；
 * - 有缓存时：仅当 .git/index mtime 变化（已跟踪文件变化）或距上次刷新超过 5s 时刷新；
 * - 5s 兜底刷新用于捕获未跟踪文件的变化（不影响 .git/index）。
 */
export function startBackgroundCacheRefresh(): void {
  // 已有刷新任务进行中时直接返回
  if (fileListRefreshPromise) return

  // 冷启动必须立即刷新；有缓存时检查是否需要刷新
  const indexMtime = getGitIndexMtime()
  if (fileIndex) {
    // 检查 .git/index mtime 是否变化（表示已跟踪文件有变更）
    const gitStateChanged =
      indexMtime !== null && indexMtime !== lastGitIndexMtime
    // 未变化且距上次刷新不足 5s，跳过
    if (!gitStateChanged && Date.now() - lastRefreshMs < REFRESH_THROTTLE_MS) {
      return
    }
  }

  const generation = cacheGeneration
  const refreshStart = Date.now()
  // 提前确保 FileIndex 单例存在：构建期间可渐进查询，返回部分结果
  getFileIndex()
  fileListRefreshPromise = getPathsForSuggestions()
    .then(result => {
      // 若缓存在刷新期间被清空（会话切换），丢弃结果
      if (generation !== cacheGeneration) {
        return result
      }
      fileListRefreshPromise = null
      // 通知订阅者索引构建完成，触发 typeahead 重新搜索以升级部分结果
      indexBuildComplete.emit()
      // 刷新成功后记录 mtime，下次可检测变化
      lastGitIndexMtime = indexMtime
      lastRefreshMs = Date.now()
      logForDebugging(
        `[FileIndex] cache refresh completed in ${Date.now() - refreshStart}ms`,
      )
      return result
    })
    .catch(error => {
      logForDebugging(
        `[FileIndex] Cache refresh failed: ${errorMessage(error)}`,
      )
      logError(error)
      if (generation === cacheGeneration) {
        // 刷新失败，重置 Promise 允许下次重试
        fileListRefreshPromise = null
      }
      return getFileIndex()
    })
}

/**
 * 获取当前工作目录顶层的文件和目录列表（用于输入为空时展示）。
 *
 * @returns 顶层文件/目录的相对路径数组（目录带尾部分隔符）
 */
async function getTopLevelPaths(): Promise<string[]> {
  const fs = getFsImplementation()
  const cwd = getCwd()

  try {
    // 读取当前目录下的所有条目
    const entries = await fs.readdir(cwd)
    return entries.map(entry => {
      const fullPath = path.join(cwd, entry.name)
      const relativePath = path.relative(cwd, fullPath)
      // 目录添加尾部分隔符以区分文件和目录
      return entry.isDirectory() ? relativePath + path.sep : relativePath
    })
  } catch (error) {
    logError(error as Error)
    return []
  }
}

/**
 * 根据用户当前输入和光标位置生成文件建议列表。
 *
 * 流程：
 * 1. 若配置了自定义 fileSuggestion 命令，调用命令钩子；
 * 2. 若输入为空或为 './'，返回顶层目录内容；
 * 3. 否则启动后台刷新，在 FileIndex 中搜索匹配项；
 * 4. 处理 './' 前缀和 '~' tilde 展开。
 *
 * @param partialPath  用户输入的部分文件路径
 * @param showOnEmpty  是否在输入为空时也显示建议（用于 '@' 触发场景）
 * @returns 建议项数组（最多 MAX_SUGGESTIONS 条）
 */
export async function generateFileSuggestions(
  partialPath: string,
  showOnEmpty = false,
): Promise<SuggestionItem[]> {
  // 输入为空且不需要在空时显示时，直接返回空列表
  if (!partialPath && !showOnEmpty) {
    return []
  }

  // 若配置了自定义 fileSuggestion 命令，使用命令返回的预排序结果
  if (getInitialSettings().fileSuggestion?.type === 'command') {
    const input: FileSuggestionCommandInput = {
      ...createBaseHookInput(),
      query: partialPath,
    }
    const results = await executeFileSuggestionCommand(input)
    return results.slice(0, MAX_SUGGESTIONS).map(createFileSuggestionItem)
  }

  // 输入为空、'.' 或 './' 时展示顶层目录内容
  if (partialPath === '' || partialPath === '.' || partialPath === './') {
    const topLevelPaths = await getTopLevelPaths()
    // 同时触发后台缓存刷新，为后续输入做准备
    startBackgroundCacheRefresh()
    return topLevelPaths.slice(0, MAX_SUGGESTIONS).map(createFileSuggestionItem)
  }

  const startTime = Date.now()

  try {
    // 启动后台刷新（若 FileIndex 正在构建则返回部分结果）
    const wasBuilding = fileListRefreshPromise !== null
    startBackgroundCacheRefresh()

    // 处理 './' 和 '.\' 前缀，去除后再搜索
    let normalizedPath = partialPath
    const currentDirPrefix = '.' + path.sep
    if (partialPath.startsWith(currentDirPrefix)) {
      normalizedPath = partialPath.substring(2)
    }

    // 处理 '~' tilde 展开（将 ~ 替换为家目录路径）
    if (normalizedPath.startsWith('~')) {
      normalizedPath = expandPath(normalizedPath)
    }

    // 在 FileIndex 中搜索匹配路径（索引未初始化时返回空数组）
    const matches = fileIndex
      ? findMatchingFiles(fileIndex, normalizedPath)
      : []

    const duration = Date.now() - startTime
    logForDebugging(
      `[FileIndex] generateFileSuggestions: ${matches.length} results in ${duration}ms (${wasBuilding ? 'partial' : 'full'} index)`,
    )
    // 上报 analytics 事件
    logEvent('tengu_file_suggestions_query', {
      duration_ms: duration,
      cache_hit: !wasBuilding,
      result_count: matches.length,
      query_length: partialPath.length,
    })

    return matches
  } catch (error) {
    logError(error)
    return []
  }
}

/**
 * 将选中的文件建议应用到输入框。
 *
 * 用选中的文件路径替换输入框中的部分路径，并将光标移到路径末尾。
 *
 * @param suggestion      选中的建议项（字符串或 SuggestionItem）
 * @param input           当前完整输入字符串
 * @param partialPath     当前正在补全的部分路径（将被替换）
 * @param startPos        部分路径在 input 中的起始位置
 * @param onInputChange   更新输入值的回调函数
 * @param setCursorOffset 设置光标位置的回调函数
 */
export function applyFileSuggestion(
  suggestion: string | SuggestionItem,
  input: string,
  partialPath: string,
  startPos: number,
  onInputChange: (value: string) => void,
  setCursorOffset: (offset: number) => void,
): void {
  // 从字符串或 SuggestionItem 中提取建议文本
  const suggestionText =
    typeof suggestion === 'string' ? suggestion : suggestion.displayText

  // 用建议路径替换输入框中的部分路径
  const newInput =
    input.substring(0, startPos) +          // 部分路径之前的内容
    suggestionText +                          // 替换为完整路径
    input.substring(startPos + partialPath.length) // 部分路径之后的内容
  onInputChange(newInput)

  // 将光标移到插入路径的末尾
  const newCursorPos = startPos + suggestionText.length
  setCursorOffset(newCursorPos)
}
