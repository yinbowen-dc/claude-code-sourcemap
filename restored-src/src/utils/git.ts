/**
 * Git 仓库工具模块。
 *
 * 在 Claude Code 系统中，该模块封装了与 git 仓库交互的所有核心功能，
 * 为权限检测、项目配置、issue 提交等子系统提供统一的 git 操作接口：
 * - findGitRoot()：从指定目录向上查找 .git 目录（含 LRU 缓存）
 * - findCanonicalGitRoot()：解析 worktree 到主仓库根目录
 * - gitExe()：查找并缓存 git 可执行文件路径
 * - getIsGit()：判断当前工作目录是否在 git 仓库中
 * - normalizeGitRemoteUrl()：将 SSH/HTTPS remote URL 标准化
 * - getRepoRemoteHash()：生成仓库 remote URL 的匿名 hash
 * - getGitState()：并发获取仓库完整状态（分支、HEAD、dirty 等）
 * - preserveGitStateForIssue()：为 issue/share 功能保存可重放的 git 快照
 * - isCurrentDirectoryBareGitRepo()：检测裸仓库攻击（沙箱逃逸防御）
 * - stashToCleanState()：将所有变更（含未跟踪文件）stash 到干净状态
 */
import { createHash } from 'crypto'
import { readFileSync, realpathSync, statSync } from 'fs'
import { open, readFile, realpath, stat } from 'fs/promises'
import memoize from 'lodash-es/memoize.js'
import { basename, dirname, join, resolve, sep } from 'path'
import { hasBinaryExtension, isBinaryContent } from '../constants/files.js'
import { getCwd } from './cwd.js'
import { logForDebugging } from './debug.js'
import { logForDiagnosticsNoPII } from './diagLogs.js'
import { execFileNoThrow } from './execFileNoThrow.js'
import { getFsImplementation } from './fsOperations.js'
import {
  getCachedBranch,
  getCachedDefaultBranch,
  getCachedHead,
  getCachedRemoteUrl,
  getWorktreeCountFromFs,
  isShallowClone as isShallowCloneFs,
  resolveGitDir,
} from './git/gitFilesystem.js'
import { logError } from './log.js'
import { memoizeWithLRU } from './memoize.js'
import { whichSync } from './which.js'

// 哨兵值：区分"找不到 git 根目录"（GIT_ROOT_NOT_FOUND）与"找到了"（路径字符串），
// 避免在 LRU 缓存中将 null 与"缓存未命中"混淆。
const GIT_ROOT_NOT_FOUND = Symbol('git-root-not-found')

/**
 * 实际执行 git 根目录查找的核心函数（带 LRU 缓存）。
 * 从 startPath 向上逐级检测 .git 文件/目录，直到文件系统根目录为止。
 * 最多缓存 50 个不同起始路径的结果，防止 gitDiff 等频繁调用时无限增长。
 */
const findGitRootImpl = memoizeWithLRU(
  (startPath: string): string | typeof GIT_ROOT_NOT_FOUND => {
    const startTime = Date.now()
    logForDiagnosticsNoPII('info', 'find_git_root_started')

    let current = resolve(startPath) // 解析为绝对路径
    const root = current.substring(0, current.indexOf(sep) + 1) || sep // 文件系统根目录（如 /）
    let statCount = 0

    while (current !== root) {
      try {
        const gitPath = join(current, '.git')
        statCount++
        const stat = statSync(gitPath)
        // .git 可以是目录（普通仓库）或文件（worktree/submodule 使用文件形式）
        if (stat.isDirectory() || stat.isFile()) {
          logForDiagnosticsNoPII('info', 'find_git_root_completed', {
            duration_ms: Date.now() - startTime,
            stat_count: statCount,
            found: true,
          })
          return current.normalize('NFC')
        }
      } catch {
        // 当前层级不存在 .git，继续向上一级查找
      }
      const parent = dirname(current)
      if (parent === current) {
        break // 到达文件系统根目录
      }
      current = parent
    }

    // 检查根目录（while 循环条件为 current !== root，不包含根，单独处理）
    try {
      const gitPath = join(root, '.git')
      statCount++
      const stat = statSync(gitPath)
      if (stat.isDirectory() || stat.isFile()) {
        logForDiagnosticsNoPII('info', 'find_git_root_completed', {
          duration_ms: Date.now() - startTime,
          stat_count: statCount,
          found: true,
        })
        return root.normalize('NFC')
      }
    } catch {
      // 根目录也不存在 .git
    }

    logForDiagnosticsNoPII('info', 'find_git_root_completed', {
      duration_ms: Date.now() - startTime,
      stat_count: statCount,
      found: false,
    })
    return GIT_ROOT_NOT_FOUND
  },
  path => path,
  50,
)

/**
 * 从指定目录向上查找 git 根目录，找到含 .git 的目录后返回其路径。
 * .git 可以是目录（普通仓库）或文件（worktree/submodule）。
 * 未找到时返回 null。
 *
 * 内部使用 LRU 缓存（最多 50 条），防止 gitDiff 等以不同 dirname 调用时无限积累缓存条目。
 */
export const findGitRoot = createFindGitRoot()

/**
 * 创建 findGitRoot 函数，将 GIT_ROOT_NOT_FOUND 哨兵映射为 null，
 * 并将内部 LRU cache 暴露给外部（供测试或强制失效使用）。
 */
function createFindGitRoot(): {
  (startPath: string): string | null
  cache: typeof findGitRootImpl.cache
} {
  function wrapper(startPath: string): string | null {
    const result = findGitRootImpl(startPath)
    return result === GIT_ROOT_NOT_FOUND ? null : result
  }
  wrapper.cache = findGitRootImpl.cache
  return wrapper
}

/**
 * 将 git 根目录解析为规范主仓库根目录，穿透 worktree 引用链。
 * 普通仓库直接返回输入路径（无操作）。
 * Worktree：.git 文件 → gitdir: → commondir → 主仓库工作目录。
 *
 * 安全说明：.git 文件和 commondir 均为攻击者可控内容（克隆/下载的仓库），
 * 需进行两层验证以防止路径遍历绕过 trust dialog：
 * 1. worktreeGitDir 必须是 <commonDir>/worktrees/ 的直接子目录
 * 2. <worktreeGitDir>/gitdir 必须回指 <gitRoot>/.git
 *
 * Submodule（无 commondir）直接返回输入根目录（submodule 是独立仓库）。
 * 使用 LRU 缓存（50 条）避免权限检测和 prompt 构建热路径上的重复 I/O。
 */
const resolveCanonicalRoot = memoizeWithLRU(
  (gitRoot: string): string => {
    try {
      // Worktree 中 .git 是含 "gitdir: <path>" 的文件；普通仓库 .git 是目录（会抛 EISDIR）
      const gitContent = readFileSync(join(gitRoot, '.git'), 'utf-8').trim()
      if (!gitContent.startsWith('gitdir:')) {
        return gitRoot
      }
      const worktreeGitDir = resolve(
        gitRoot,
        gitContent.slice('gitdir:'.length).trim(),
      )
      // commondir 指向共享 .git 目录（相对于 worktree gitdir）。
      // Submodule 无 commondir（readFileSync 抛 ENOENT），直接 fall through。
      const commonDir = resolve(
        worktreeGitDir,
        readFileSync(join(worktreeGitDir, 'commondir'), 'utf-8').trim(),
      )
      // 安全说明（SECURITY）：.git 文件和 commondir 在克隆/下载的仓库中均受攻击者控制。
      // 若不验证，恶意仓库可将 commondir 指向受害者信任的任意路径，
      // 绕过 trust dialog 并在启动时执行 .claude/settings.json 中的 hooks。
      //
      // 验证条件须同时满足：
      //   1. worktreeGitDir 是 <commonDir>/worktrees/ 的直接子目录
      //      → 确保我们读取的 commondir 文件位于已解析的公共目录内，
      //        而非攻击者仓库内部
      //   2. <worktreeGitDir>/gitdir 回指 <gitRoot>/.git
      //      → 防止攻击者通过猜测路径借用受害者现有 worktree 条目
      // 仅满足条件 (1)：若受害者有该信任仓库的 worktree，仍可被绕过；
      // 仅满足条件 (2)：攻击者控制 worktreeGitDir，仍可绕过。
      if (resolve(dirname(worktreeGitDir)) !== join(commonDir, 'worktrees')) {
        return gitRoot
      }
      // Git 以 strbuf_realpath()（已解析符号链接）写入 gitdir，
      // 而 findGitRoot() 返回的 gitRoot 仅作词法解析。
      // 对 gitRoot 进行 realpath，确保通过符号链接路径访问的合法 worktree
      // （如 macOS /tmp → /private/tmp）不会被误拒绝。
      // 对目录 realpath 再 join '.git'，避免对 .git 文件本身 realpath
      // 导致通过符号链接 .git 借用受害者的反向链接。
      const backlink = realpathSync(
        readFileSync(join(worktreeGitDir, 'gitdir'), 'utf-8').trim(),
      )
      if (backlink !== join(realpathSync(gitRoot), '.git')) {
        return gitRoot
      }
      // 裸仓库 worktree：公共目录不在工作目录内部。
      // 使用公共目录本身作为稳定标识（anthropics/claude-code#27994）。
      if (basename(commonDir) !== '.git') {
        return commonDir.normalize('NFC')
      }
      return dirname(commonDir).normalize('NFC')
    } catch {
      return gitRoot
    }
  },
  root => root,
  50,
)

/**
 * 查找规范 git 仓库根目录，自动解析 worktree 引用链。
 *
 * 与 findGitRoot 不同，本函数不返回 worktree 的工作目录（含 .git 文件），
 * 而是返回主仓库的工作目录，确保同一仓库的所有 worktree 映射到同一项目标识。
 *
 * 在需要项目级状态时应优先使用本函数（如 auto-memory、项目配置、agent 记忆），
 * 以便各 worktree 共享同一主仓库状态。
 */
export const findCanonicalGitRoot = createFindCanonicalGitRoot()

/**
 * 创建 findCanonicalGitRoot 函数，组合 findGitRoot + resolveCanonicalRoot，
 * 并暴露内部 LRU cache 供外部使用（测试/失效场景）。
 */
function createFindCanonicalGitRoot(): {
  (startPath: string): string | null
  cache: typeof resolveCanonicalRoot.cache
} {
  function wrapper(startPath: string): string | null {
    const root = findGitRoot(startPath)
    if (!root) {
      return null
    }
    return resolveCanonicalRoot(root)
  }
  wrapper.cache = resolveCanonicalRoot.cache
  return wrapper
}

// 缓存 git 可执行文件路径，避免每次 spawn 子进程时重复执行 PATH 查找
export const gitExe = memoize((): string => {
  // 每次生成子进程都需要查找路径，通过 memoize 只执行一次查找
  return whichSync('git') || 'git'
})

/** 判断当前工作目录是否在 git 仓库中（带 memoize，仅查询一次）。 */
export const getIsGit = memoize(async (): Promise<boolean> => {
  const startTime = Date.now()
  logForDiagnosticsNoPII('info', 'is_git_check_started')

  const isGit = findGitRoot(getCwd()) !== null

  logForDiagnosticsNoPII('info', 'is_git_check_completed', {
    duration_ms: Date.now() - startTime,
    is_git: isGit,
  })
  return isGit
})

/** 获取当前工作目录对应的 git 目录路径（.git 的绝对路径，含 worktree 支持）。 */
export function getGitDir(cwd: string): Promise<string | null> {
  return resolveGitDir(cwd)
}

/** 判断当前工作目录是否正好是 git 根目录（非子目录），通过 realpath 解析符号链接后比较。 */
export async function isAtGitRoot(): Promise<boolean> {
  const cwd = getCwd()
  const gitRoot = findGitRoot(cwd)
  if (!gitRoot) {
    return false
  }
  // 解析符号链接以确保路径比较准确
  try {
    const [resolvedCwd, resolvedGitRoot] = await Promise.all([
      realpath(cwd),
      realpath(gitRoot),
    ])
    return resolvedCwd === resolvedGitRoot
  } catch {
    return cwd === gitRoot
  }
}

/** 检查指定目录是否在某个 git 仓库中（findGitRoot 的异步包装）。 */
export const dirIsInGitRepo = async (cwd: string): Promise<boolean> => {
  return findGitRoot(cwd) !== null
}

/** 获取当前分支的最新 commit SHA（委托给 gitFilesystem 的缓存实现）。 */
export const getHead = async (): Promise<string> => {
  return getCachedHead()
}

/** 获取当前分支名称（委托给 gitFilesystem 的缓存实现）。 */
export const getBranch = async (): Promise<string> => {
  return getCachedBranch()
}

/** 获取仓库的默认分支名称（委托给 gitFilesystem 的缓存实现）。 */
export const getDefaultBranch = async (): Promise<string> => {
  return getCachedDefaultBranch()
}

/** 获取仓库的远程 URL（委托给 gitFilesystem 的缓存实现，无 remote 时返回 null）。 */
export const getRemoteUrl = async (): Promise<string | null> => {
  return getCachedRemoteUrl()
}

/**
 * 将 git remote URL 标准化为统一格式：host/owner/repo（小写，去掉 .git 后缀）。
 * 同时处理 SSH 格式（git@host:owner/repo.git）和 HTTPS/SSH URL 格式。
 * 对 CCR git 代理 URL（127.0.0.1:PORT/git/...）进行特殊处理，还原实际 host。
 *
 * 示例转换：
 * - git@github.com:owner/repo.git → github.com/owner/repo
 * - https://github.com/owner/repo.git → github.com/owner/repo
 * - ssh://git@github.com/owner/repo → github.com/owner/repo
 * - http://local_proxy@127.0.0.1:16583/git/owner/repo → github.com/owner/repo
 */
export function normalizeGitRemoteUrl(url: string): string | null {
  const trimmed = url.trim()
  if (!trimmed) return null

  // 处理 SSH 格式：git@host:owner/repo.git
  const sshMatch = trimmed.match(/^git@([^:]+):(.+?)(?:\.git)?$/)
  if (sshMatch && sshMatch[1] && sshMatch[2]) {
    return `${sshMatch[1]}/${sshMatch[2]}`.toLowerCase()
  }

  // 处理 HTTPS/SSH URL 格式：https://host/owner/repo.git 或 ssh://git@host/owner/repo
  const urlMatch = trimmed.match(
    /^(?:https?|ssh):\/\/(?:[^@]+@)?([^/]+)\/(.+?)(?:\.git)?$/,
  )
  if (urlMatch && urlMatch[1] && urlMatch[2]) {
    const host = urlMatch[1]
    const path = urlMatch[2]

    // CCR git 代理 URL 格式：
    //   旧版：http://...@127.0.0.1:PORT/git/owner/repo（默认假设 github.com）
    //   GHE：http://...@127.0.0.1:PORT/git/ghe.host/owner/repo（路径中编码了 host）
    // 去掉 /git/ 前缀；若第一段含 . 则为主机名（GitHub org 不含 .），否则假设 github.com。
    if (isLocalHost(host) && path.startsWith('git/')) {
      const proxyPath = path.slice(4) // 去掉 "git/" 前缀
      const segments = proxyPath.split('/')
      // 3+ 段且首段含 . → host/owner/repo（GHE 格式）
      if (segments.length >= 3 && segments[0]!.includes('.')) {
        return proxyPath.toLowerCase()
      }
      // 2 段 → owner/repo（旧版格式，默认 github.com）
      return `github.com/${proxyPath}`.toLowerCase()
    }

    return `${host}/${path}`.toLowerCase()
  }

  return null
}

/**
 * 返回仓库 remote URL 经标准化后 SHA256 哈希的前 16 位。
 * 提供全局唯一的仓库标识，且：
 * - SSH 克隆与 HTTPS 克隆结果相同
 * - 不在日志中暴露实际仓库名
 */
export async function getRepoRemoteHash(): Promise<string | null> {
  const remoteUrl = await getRemoteUrl()
  if (!remoteUrl) return null

  const normalized = normalizeGitRemoteUrl(remoteUrl)
  if (!normalized) return null

  const hash = createHash('sha256').update(normalized).digest('hex')
  return hash.substring(0, 16)
}

/** 判断 HEAD 是否在某个远程分支上（即是否已 push 到 remote）。 */
export const getIsHeadOnRemote = async (): Promise<boolean> => {
  const { code } = await execFileNoThrow(gitExe(), ['rev-parse', '@{u}'], {
    preserveOutputOnError: false,
  })
  return code === 0
}

/** 判断本地分支是否有未推送到 remote 的 commit。 */
export const hasUnpushedCommits = async (): Promise<boolean> => {
  const { stdout, code } = await execFileNoThrow(
    gitExe(),
    ['rev-list', '--count', '@{u}..HEAD'],
    { preserveOutputOnError: false },
  )
  return code === 0 && parseInt(stdout.trim(), 10) > 0
}

/**
 * 检测工作目录是否干净（无未提交的已跟踪变更）。
 * ignoreUntracked 为 true 时忽略未跟踪文件（分支切换不会丢失这些文件）。
 */
export const getIsClean = async (options?: {
  ignoreUntracked?: boolean
}): Promise<boolean> => {
  const args = ['--no-optional-locks', 'status', '--porcelain']
  if (options?.ignoreUntracked) {
    args.push('-uno')
  }
  const { stdout } = await execFileNoThrow(gitExe(), args, {
    preserveOutputOnError: false,
  })
  return stdout.trim().length === 0
}

/** 获取所有已修改文件的路径列表（含已跟踪变更和未跟踪文件）。 */
export const getChangedFiles = async (): Promise<string[]> => {
  const { stdout } = await execFileNoThrow(
    gitExe(),
    ['--no-optional-locks', 'status', '--porcelain'],
    {
      preserveOutputOnError: false,
    },
  )
  return stdout
    .trim()
    .split('\n')
    .map(line => line.trim().split(' ', 2)[1]?.trim()) // 去除状态前缀（如 "M "、"A "、"??"）
    .filter(line => typeof line === 'string') // 过滤空条目
}

export type GitFileStatus = {
  tracked: string[]
  untracked: string[]
}

/** 获取仓库文件变更状态，将文件分为已跟踪（tracked）和未跟踪（untracked）两类。 */
export const getFileStatus = async (): Promise<GitFileStatus> => {
  const { stdout } = await execFileNoThrow(
    gitExe(),
    ['--no-optional-locks', 'status', '--porcelain'],
    {
      preserveOutputOnError: false,
    },
  )

  const tracked: string[] = []
  const untracked: string[] = []

  stdout
    .trim()
    .split('\n')
    .filter(line => line.length > 0)
    .forEach(line => {
      const status = line.substring(0, 2)
      const filename = line.substring(2).trim()

      if (status === '??') {
        untracked.push(filename) // 未跟踪文件（"??" 状态）
      } else if (filename) {
        tracked.push(filename) // 已跟踪且有变更的文件
      }
    })

  return { tracked, untracked }
}

/** 获取当前仓库的 worktree 数量（委托给 gitFilesystem 的文件系统实现）。 */
export const getWorktreeCount = async (): Promise<number> => {
  return getWorktreeCountFromFs()
}

/**
 * 将所有变更（含未跟踪文件）stash 到干净状态，便于分支切换等操作。
 * 重要：先将未跟踪文件 add 到暂存区再 stash，防止数据丢失。
 * @param message - stash 条目的自定义描述（默认含时间戳）
 * @returns stash 成功返回 true，否则返回 false
 */
export const stashToCleanState = async (message?: string): Promise<boolean> => {
  try {
    const stashMessage =
      message || `Claude Code auto-stash - ${new Date().toISOString()}`

    // 检查是否有未跟踪文件
    const { untracked } = await getFileStatus()

    // 若有未跟踪文件，先将其加入暂存区以防 stash 时被删除
    if (untracked.length > 0) {
      const { code: addCode } = await execFileNoThrow(
        gitExe(),
        ['add', ...untracked],
        { preserveOutputOnError: false },
      )

      if (addCode !== 0) {
        return false // add 失败，不继续执行 stash
      }
    }

    // 将已暂存和未暂存的所有变更 stash 起来
    const { code } = await execFileNoThrow(
      gitExe(),
      ['stash', 'push', '--message', stashMessage],
      { preserveOutputOnError: false },
    )
    return code === 0
  } catch (_) {
    return false
  }
}

export type GitRepoState = {
  commitHash: string
  branchName: string
  remoteUrl: string | null
  isHeadOnRemote: boolean
  isClean: boolean
  worktreeCount: number
}

/**
 * 并发获取当前仓库的完整状态快照，供遥测和 UI 使用。
 * 失败时静默返回 null（git 状态为尽力而为）。
 */
export async function getGitState(): Promise<GitRepoState | null> {
  try {
    const [
      commitHash,
      branchName,
      remoteUrl,
      isHeadOnRemote,
      isClean,
      worktreeCount,
    ] = await Promise.all([
      getHead(),
      getBranch(),
      getRemoteUrl(),
      getIsHeadOnRemote(),
      getIsClean(),
      getWorktreeCount(),
    ])

    return {
      commitHash,
      branchName,
      remoteUrl,
      isHeadOnRemote,
      isClean,
      worktreeCount,
    }
  } catch (_) {
    // 静默失败——git 状态为尽力而为，不阻塞主流程
    return null
  }
}

/**
 * 获取当前仓库对应的 GitHub 仓库名（格式：owner/repo）。
 * 仅返回 github.com 仓库，非 github.com remote 返回 null。
 * 调用方（如 issue 提交）依赖此结果为 github.com 仓库。
 */
export async function getGithubRepo(): Promise<string | null> {
  const { parseGitRemote } = await import('./detectRepository.js')
  const remoteUrl = await getRemoteUrl()
  if (!remoteUrl) {
    logForDebugging('Local GitHub repo: unknown')
    return null
  }
  // 仅返回 github.com 仓库（非 github.com 的 remote 返回 null）
  // Only return results for github.com — callers (e.g. issue submission)
  // assume the result is a github.com repository.
  const parsed = parseGitRemote(remoteUrl)
  if (parsed && parsed.host === 'github.com') {
    const result = `${parsed.owner}/${parsed.name}`
    logForDebugging(`Local GitHub repo: ${result}`)
    return result
  }
  logForDebugging('Local GitHub repo: unknown') // 非 github.com 仓库
  return null
}

/**
 * 为 issue 提交保存的 git 状态快照类型。
 * 以远端分支（如 origin/main）为基准，而非本地提交，
 * 原因：远端分支极少被 force push，本地提交在 force push 后可能被 GC 清除。
 * Preserved git state for issue submission.
 * Uses remote base (e.g., origin/main) which is rarely force-pushed,
 * unlike local commits that can be GC'd after force push.
 */
export type PreservedGitState = {
  /** 与远端分支的 merge-base SHA（即分叉点提交哈希）
   *  The SHA of the merge-base with the remote branch */
  remote_base_sha: string | null
  /** 使用的远端分支名（如 "origin/main"）
   *  The remote branch used (e.g., "origin/main") */
  remote_base: string | null
  /** 从 merge-base 到当前状态的 diff patch（含未提交变更）
   *  Patch from merge-base to current state (includes uncommitted changes) */
  patch: string
  /** 未跟踪文件列表及其内容（git diff 不包含这些文件）
   *  Untracked files with their contents */
  untracked_files: Array<{ path: string; content: string }>
  /** git format-patch 输出，用于重建 merge-base 到 HEAD 之间的提交链
   *  （保留 author/date/message），供 replay 容器重建真实提交；
   *  若 merge-base 与 HEAD 之间无新提交则为 null。
   *  git format-patch output for committed changes between merge-base and HEAD.
   *  Used to reconstruct the actual commit chain (author, date, message) in
   *  replay containers. null when there are no commits between merge-base and HEAD. */
  format_patch: string | null
  /** 当前 HEAD SHA（特性分支的顶端提交）
   *  The current HEAD SHA (tip of the feature branch) */
  head_sha: string | null
  /** 当前分支名（如 "feat/my-feature"）
   *  The current branch name (e.g., "feat/my-feature") */
  branch_name: string | null
}

// 未跟踪文件捕获的大小限制
// Size limits for untracked file capture
const MAX_FILE_SIZE_BYTES = 500 * 1024 * 1024 // 单文件上限 500MB per file
const MAX_TOTAL_SIZE_BYTES = 5 * 1024 * 1024 * 1024 // 总大小上限 5GB total
const MAX_FILE_COUNT = 20000 // 最多捕获 20000 个文件

// 二进制嗅探 + 内容复用的初始读取缓冲区大小。
// 64KB 能覆盖大多数源文件的单次读取；isBinaryContent() 内部仅扫描前 8KB 做二进制判断，
// 额外字节的作用是：若文件确实是文本，则无需第二次 readFile，直接复用已读缓冲区。
// Initial read buffer for binary detection + content reuse. 64KB covers
// most source files in a single read; isBinaryContent() internally scans
// only its first 8KB for the binary heuristic, so the extra bytes are
// purely for avoiding a second read when the file turns out to be text.
const SNIFF_BUFFER_SIZE = 64 * 1024

/**
 * 寻找最合适的远端分支作为 issue 快照的基准。
 * 优先级：当前分支的 tracking 远端 > origin/main > origin/staging > origin/master。
 *
 * 三阶段查找策略：
 * 1. 通过 @{u} 获取当前分支已配置的 upstream tracking 分支（最精确）；
 * 2. 通过 `remote show origin HEAD` 获取 origin 的默认分支；
 * 3. 遍历 origin/main / origin/staging / origin/master 候选列表，取第一个存在的。
 * Find the best remote branch to use as a base.
 * Priority: tracking branch > origin/main > origin/staging > origin/master
 */
export async function findRemoteBase(): Promise<string | null> {
  // 第一阶段：获取当前分支的 upstream tracking 分支（`@{u}` 语法）
  // First try: get the tracking branch for the current branch
  const { stdout: trackingBranch, code: trackingCode } = await execFileNoThrow(
    gitExe(),
    ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'],
    { preserveOutputOnError: false },
  )

  if (trackingCode === 0 && trackingBranch.trim()) {
    return trackingBranch.trim()
  }

  // 第二阶段：通过 `remote show origin HEAD` 获取 origin 的默认分支
  // Second try: check for common default branch names on origin
  const { stdout: remoteRefs, code: remoteCode } = await execFileNoThrow(
    gitExe(),
    ['remote', 'show', 'origin', '--', 'HEAD'],
    { preserveOutputOnError: false },
  )

  if (remoteCode === 0) {
    // 从 remote show 输出中解析 "HEAD branch: <name>"
    // Parse the default branch from remote show output
    const match = remoteRefs.match(/HEAD branch: (\S+)/)
    if (match && match[1]) {
      return `origin/${match[1]}`
    }
  }

  // 第三阶段：遍历候选列表，取第一个能被 rev-parse 验证存在的分支
  // Third try: check which common branches exist
  const candidates = ['origin/main', 'origin/staging', 'origin/master']
  for (const candidate of candidates) {
    const { code } = await execFileNoThrow(
      gitExe(),
      ['rev-parse', '--verify', candidate],
      { preserveOutputOnError: false },
    )
    if (code === 0) {
      return candidate
    }
  }

  return null
}

/**
 * 检测当前仓库是否为浅克隆（shallow clone）。
 * 浅克隆时 `<gitDir>/shallow` 文件存在，此时 merge-base 计算可能失败，
 * 需降级为仅使用 HEAD 模式生成 issue 快照。
 * Check if we're in a shallow clone by looking for <gitDir>/shallow.
 */
function isShallowClone(): Promise<boolean> {
  return isShallowCloneFs()
}

/**
 * 捕获所有未跟踪文件（git diff 不包含这些文件）及其内容，
 * 供 issue/share 快照功能补充完整的工作区状态。
 *
 * 处理流程：
 * 1. 用 `git ls-files --others --exclude-standard` 列出未跟踪文件（已遵守 .gitignore）；
 * 2. 按二进制扩展名快速跳过（零 I/O 开销）；
 * 3. 对文本文件先读取 SNIFF_BUFFER_SIZE(64KB) 字节做二进制嗅探；
 *    若判断为二进制则跳过，否则复用已读缓冲区（文件≤64KB）或完整 readFile（文件>64KB）；
 * 4. 受三重上限保护：单文件大小 / 总大小 / 文件数量。
 * Capture untracked files (git diff doesn't include them).
 * Respects size limits and skips binary files.
 */
async function captureUntrackedFiles(): Promise<
  Array<{ path: string; content: string }>
> {
  const { stdout, code } = await execFileNoThrow(
    gitExe(),
    ['ls-files', '--others', '--exclude-standard'], // 列出未跟踪且被 .gitignore 排除之外的文件
    { preserveOutputOnError: false },
  )

  const trimmed = stdout.trim()
  if (code !== 0 || !trimmed) {
    return []
  }

  const files = trimmed.split('\n').filter(Boolean)
  const result: Array<{ path: string; content: string }> = []
  let totalSize = 0

  for (const filePath of files) {
    // 超过文件数量上限时终止
    // Check file count limit
    if (result.length >= MAX_FILE_COUNT) {
      logForDebugging(
        `Untracked file capture: reached max file count (${MAX_FILE_COUNT})`,
      )
      break
    }

    // 按扩展名快速跳过二进制文件（无需打开文件）
    // Skip binary files by extension - zero I/O
    if (hasBinaryExtension(filePath)) {
      continue
    }

    try {
      const stats = await stat(filePath)
      const fileSize = stats.size

      // 超过单文件大小上限则跳过
      // Skip files exceeding per-file limit
      if (fileSize > MAX_FILE_SIZE_BYTES) {
        logForDebugging(
          `Untracked file capture: skipping ${filePath} (exceeds ${MAX_FILE_SIZE_BYTES} bytes)`,
        )
        continue
      }

      // 累计总大小超出上限时终止
      // Check total size limit
      if (totalSize + fileSize > MAX_TOTAL_SIZE_BYTES) {
        logForDebugging(
          `Untracked file capture: reached total size limit (${MAX_TOTAL_SIZE_BYTES} bytes)`,
        )
        break
      }

      // 空文件直接记录，无需打开
      if (fileSize === 0) {
        result.push({ path: filePath, content: '' })
        continue
      }

      // 二进制嗅探：读取最多 SNIFF_BUFFER_SIZE(64KB) 字节。
      // 对于二进制文件，读取上限为 64KB；对于文本文件：
      //   - 文件 ≤ 64KB：直接复用已读缓冲区，避免第二次 readFile；
      //   - 文件 > 64KB：使用带 encoding 的 readFile，运行时直接解码为字符串，
      //     避免同时持有完整 Buffer 和解码字符串造成内存加倍。
      // Binary sniff on up to SNIFF_BUFFER_SIZE bytes. Caps binary-file reads
      // at SNIFF_BUFFER_SIZE even though MAX_FILE_SIZE_BYTES allows up to 500MB.
      // If the file fits in the sniff buffer we reuse it as the content; for
      // larger text files we fall back to readFile with encoding so the runtime
      // decodes to a string without materializing a full-size Buffer in JS.
      const sniffSize = Math.min(SNIFF_BUFFER_SIZE, fileSize)
      const fd = await open(filePath, 'r')
      try {
        const sniffBuf = Buffer.alloc(sniffSize)
        const { bytesRead } = await fd.read(sniffBuf, 0, sniffSize, 0)
        const sniff = sniffBuf.subarray(0, bytesRead)

        if (isBinaryContent(sniff)) {
          continue // 二进制文件跳过
        }

        let content: string
        if (fileSize <= sniffSize) {
          // 嗅探缓冲区已覆盖整个文件，直接复用
          // Sniff already covers the whole file
          content = sniff.toString('utf-8')
        } else {
          // 大文件：带 encoding 的 readFile 避免内存双倍占用
          // readFile with encoding decodes to string directly, avoiding a
          // full-size Buffer living alongside the decoded string. The extra
          // open/close is cheaper than doubling peak memory for large files.
          content = await readFile(filePath, 'utf-8')
        }

        result.push({ path: filePath, content })
        totalSize += fileSize
      } finally {
        await fd.close()
      }
    } catch (err) {
      // 无法读取的文件静默跳过（权限不足、符号链接失效等）
      // Skip files we can't read
      logForDebugging(`Failed to read untracked file ${filePath}: ${err}`)
    }
  }

  return result
}

/**
 * 为 issue/share 功能保存可重放的 git 状态快照。
 * 以远端分支为基准，确保快照在 force push 后仍然有效。
 *
 * 执行流程：
 * 1. 若非 git 仓库，直接返回 null；
 * 2. 浅克隆检测：浅克隆无法可靠计算 merge-base，降级为 HEAD-only 模式；
 * 3. 通过 findRemoteBase() 寻找最合适的远端基准分支；
 *    若无远端，降级为 HEAD-only 模式；
 * 4. 计算当前 HEAD 与远端基准的 merge-base SHA（分叉点）；
 *    失败时降级为 HEAD-only 模式；
 * 5. 以 merge-base 为基准，并发执行 5 个 git 操作：
 *    - `git diff <mergeBase>` 生成完整 patch（含未提交变更）；
 *    - captureUntrackedFiles() 捕获未跟踪文件；
 *    - `git format-patch <mergeBase>..HEAD --stdout` 重建提交链；
 *    - `git rev-parse HEAD` 获取 HEAD SHA；
 *    - `git rev-parse --abbrev-ref HEAD` 获取分支名。
 * Preserve git state for issue submission.
 * Uses remote base for more stable replay capability.
 *
 * Edge cases handled:
 * - Detached HEAD: falls back to merge-base with default branch directly
 * - No remote: returns null for remote fields, uses HEAD-only mode
 * - Shallow clone: falls back to HEAD-only mode
 */
export async function preserveGitStateForIssue(): Promise<PreservedGitState | null> {
  try {
    const isGit = await getIsGit()
    if (!isGit) {
      return null
    }

    // 浅克隆无法可靠计算 merge-base，降级为 HEAD-only 模式
    // Check for shallow clone - fall back to simpler mode
    if (await isShallowClone()) {
      logForDebugging('Shallow clone detected, using HEAD-only mode for issue')
      const [{ stdout: patch }, untrackedFiles] = await Promise.all([
        execFileNoThrow(gitExe(), ['diff', 'HEAD']),
        captureUntrackedFiles(),
      ])
      return {
        remote_base_sha: null,
        remote_base: null,
        patch: patch || '',
        untracked_files: untrackedFiles,
        format_patch: null,
        head_sha: null,
        branch_name: null,
      }
    }

    // 查找最合适的远端基准分支
    // Find the best remote base
    const remoteBase = await findRemoteBase()

    if (!remoteBase) {
      // 无远端分支，降级为 HEAD-only 模式（仅捕获未提交变更）
      // No remote found - use HEAD-only mode
      logForDebugging('No remote found, using HEAD-only mode for issue')
      const [{ stdout: patch }, untrackedFiles] = await Promise.all([
        execFileNoThrow(gitExe(), ['diff', 'HEAD']),
        captureUntrackedFiles(),
      ])
      return {
        remote_base_sha: null,
        remote_base: null,
        patch: patch || '',
        untracked_files: untrackedFiles,
        format_patch: null,
        head_sha: null,
        branch_name: null,
      }
    }

    // 计算 HEAD 与远端基准的 merge-base（分叉点提交哈希）
    // Get the merge-base with remote
    const { stdout: mergeBase, code: mergeBaseCode } = await execFileNoThrow(
      gitExe(),
      ['merge-base', 'HEAD', remoteBase],
      { preserveOutputOnError: false },
    )

    if (mergeBaseCode !== 0 || !mergeBase.trim()) {
      // merge-base 计算失败，降级为 HEAD-only 模式
      // Merge-base failed - fall back to HEAD-only
      logForDebugging('Merge-base failed, using HEAD-only mode for issue')
      const [{ stdout: patch }, untrackedFiles] = await Promise.all([
        execFileNoThrow(gitExe(), ['diff', 'HEAD']),
        captureUntrackedFiles(),
      ])
      return {
        remote_base_sha: null,
        remote_base: null,
        patch: patch || '',
        untracked_files: untrackedFiles,
        format_patch: null,
        head_sha: null,
        branch_name: null,
      }
    }

    const remoteBaseSha = mergeBase.trim()

    // 以下 5 个操作仅依赖 remoteBaseSha，可全部并发执行。
    // 串行约 5×90ms → 并发约 90ms（在 /issue 和 /share 命令中提升明显）。
    // All 5 commands below depend only on remoteBaseSha — run them in parallel.
    // ~5×90ms serial → ~90ms parallel on Bun native (used by /issue and /share).
    const [
      { stdout: patch },
      untrackedFiles,
      { stdout: formatPatchOut, code: formatPatchCode },
      { stdout: headSha },
      { stdout: branchName },
    ] = await Promise.all([
      // 从 merge-base 到当前状态的 diff（含暂存区变更）
      // Patch from merge-base to current state (including staged changes)
      execFileNoThrow(gitExe(), ['diff', remoteBaseSha]),
      // 未跟踪文件单独捕获
      // Untracked files captured separately
      captureUntrackedFiles(),
      // format-patch 重建 merge-base..HEAD 之间的提交链，
      // 保留真实的 author/date/message，供 replay 容器重建分支结构。
      // 使用 --stdout 将所有 patch 输出为单一文本流。
      // format-patch for committed changes between merge-base and HEAD.
      // Preserves the actual commit chain (author, date, message) so replay
      // containers can reconstruct the branch with real commits instead of a
      // squashed diff. Uses --stdout to emit all patches as a single text stream.
      execFileNoThrow(gitExe(), [
        'format-patch',
        `${remoteBaseSha}..HEAD`,
        '--stdout',
      ]),
      // HEAD SHA（用于 replay 定位）
      // HEAD SHA for replay
      execFileNoThrow(gitExe(), ['rev-parse', 'HEAD']),
      // 分支名（用于 replay 重建同名分支）
      // Branch name for replay
      execFileNoThrow(gitExe(), ['rev-parse', '--abbrev-ref', 'HEAD']),
    ])

    let formatPatch: string | null = null
    if (formatPatchCode === 0 && formatPatchOut && formatPatchOut.trim()) {
      formatPatch = formatPatchOut // merge-base 与 HEAD 之间有提交，保存 format-patch
    }

    const trimmedBranch = branchName?.trim()
    return {
      remote_base_sha: remoteBaseSha,
      remote_base: remoteBase,
      patch: patch || '',
      untracked_files: untrackedFiles,
      format_patch: formatPatch,
      head_sha: headSha?.trim() || null,
      branch_name:
        trimmedBranch && trimmedBranch !== 'HEAD' ? trimmedBranch : null, // 分离 HEAD 状态返回 null
    }
  } catch (err) {
    logError(err)
    return null
  }
}

/**
 * 判断给定 host 字符串是否为本地主机。
 * 支持 "localhost" 字面量和 127.x.x.x 回环地址（含端口号剥离）。
 * 用于在 normalizeGitRemoteUrl 中跳过本地仓库的 host 处理。
 */
function isLocalHost(host: string): boolean {
  const hostWithoutPort = host.split(':')[0] ?? '' // 剥离端口号后再比较
  return (
    hostWithoutPort === 'localhost' ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostWithoutPort) // 127.0.0.0/8 回环段
  )
}

/**
 * 检测当前工作目录是否看起来像裸 git 仓库，或被攻击者伪造为裸仓库（沙箱逃逸攻击向量）。
 *
 * 安全背景：
 * Git 的 is_git_directory()（setup.c:417-455）会在当前目录查找裸仓库标志：
 * 1. HEAD 文件——必须是有效的 ref；
 * 2. objects/ 目录——必须存在且可访问；
 * 3. refs/ 目录——必须存在且可访问。
 * 若三者全部存在于当前目录（而非 .git 子目录），Git 会将 cwd 视为裸仓库，
 * 并执行其中的 hooks/pre-commit 等钩子脚本。
 *
 * 攻击场景：
 * 1. 攻击者在 cwd 中创建 HEAD、objects/、refs/ 和 hooks/pre-commit；
 * 2. 删除或破坏 .git/HEAD 使正常 git 目录失效；
 * 3. 用户运行 `git status` 时，Git 将 cwd 识别为 git 目录并执行恶意钩子。
 *
 * 防御策略（fail-safe）：
 * - 若 .git 是文件（worktree/submodule gitdir 引用）→ 安全，返回 false；
 * - 若 .git 是目录且 .git/HEAD 是普通文件 → 安全，返回 false；
 * - 否则逐个检查 cwd 中的裸仓库标志文件，任一存在即返回 true。
 *
 * SECURITY: Git's is_git_directory() function (setup.c:417-455) checks for:
 * 1. HEAD file - Must be a valid ref
 * 2. objects/ directory - Must exist and be accessible
 * 3. refs/ directory - Must exist and be accessible
 *
 * If all three exist in the current directory (not in a .git subdirectory),
 * Git treats the current directory as a bare repository and will execute
 * hooks/pre-commit and other hook scripts from the cwd.
 *
 * Attack scenario:
 * 1. Attacker creates HEAD, objects/, refs/, and hooks/pre-commit in cwd
 * 2. Attacker deletes or corrupts .git/HEAD to invalidate the normal git directory
 * 3. When user runs 'git status', Git treats cwd as the git dir and runs the hook
 *
 * @returns true if the cwd looks like a bare/exploited git directory
 */
/* eslint-disable custom-rules/no-sync-fs -- sync permission-eval check */
export function isCurrentDirectoryBareGitRepo(): boolean {
  const fs = getFsImplementation()
  const cwd = getCwd()

  const gitPath = join(cwd, '.git')
  try {
    const stats = fs.statSync(gitPath)
    if (stats.isFile()) {
      // .git 为文件：worktree 或 submodule 的 gitdir 引用，Git 会跟随引用，安全
      // worktree/submodule — Git follows the gitdir reference
      return false
    }
    if (stats.isDirectory()) {
      const gitHeadPath = join(gitPath, 'HEAD')
      try {
        // 安全检查：确认 .git/HEAD 是普通文件。
        // 攻击者若将 .git/HEAD 创建为目录，statSync 虽然成功，
        // 但 Git 的 setup_git_directory 会拒绝（非有效 HEAD），
        // 并回退到 cwd 发现逻辑，触发裸仓库识别。
        // SECURITY: check isFile(). An attacker creating .git/HEAD as a
        // DIRECTORY would pass a bare statSync but Git's setup_git_directory
        // rejects it (not a valid HEAD) and falls back to cwd discovery.
        if (fs.statSync(gitHeadPath).isFile()) {
          // 正常仓库：.git/HEAD 有效，Git 不会回退到 cwd 发现
          // normal repo — .git/HEAD valid, Git won't fall back to cwd
          return false
        }
        // .git/HEAD 存在但不是普通文件，继续检查裸仓库标志
        // .git/HEAD exists but is not a regular file — fall through
      } catch {
        // .git 存在但 HEAD 不存在，继续检查裸仓库标志
        // .git exists but no HEAD — fall through to bare-repo check
      }
    }
  } catch {
    // 无 .git 目录，继续检查裸仓库标志
    // no .git — fall through to bare git repo indicator check
  }

  // 未找到有效的 .git/HEAD，检查 cwd 中是否存在裸仓库标志文件。
  // 采用保守策略：任一指标存在即视为可疑，返回 true。
  // 各指标用独立 try/catch 隔离，避免一个检查失败遮蔽其他结果。
  // No valid .git/HEAD found. Check if cwd has bare git repo indicators.
  // Be cautious — flag if ANY of these exist without a valid .git reference.
  // Per-indicator try/catch so an error on one doesn't mask another.
  try {
    if (fs.statSync(join(cwd, 'HEAD')).isFile()) return true // cwd/HEAD 文件存在
  } catch {
    // no HEAD
  }
  try {
    if (fs.statSync(join(cwd, 'objects')).isDirectory()) return true // cwd/objects/ 目录存在
  } catch {
    // no objects/
  }
  try {
    if (fs.statSync(join(cwd, 'refs')).isDirectory()) return true // cwd/refs/ 目录存在
  } catch {
    // no refs/
  }
  return false // 无任何裸仓库标志，视为安全
}
/* eslint-enable custom-rules/no-sync-fs */
