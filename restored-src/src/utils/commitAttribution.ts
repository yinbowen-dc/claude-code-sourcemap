/**
 * Git commit 归因追踪模块。
 *
 * 在 Claude Code 系统中，该模块追踪 Claude 对文件的字符级贡献，
 * 并在 git commit 时将归因数据写入 git notes：
 * - trackFileModification/Creation/Deletion/BulkFileChanges()：记录 Claude 对文件的变更贡献
 * - calculateCommitAttribution()：汇总多 session 的归因数据，计算 Claude/human 字符占比
 * - isInternalModelRepo()：检查当前仓库是否在内部白名单，决定 commit trailer 是否使用内部模型名
 * - stateToSnapshotMessage() / restoreAttributionStateFromSnapshots()：归因状态序列化与恢复
 * - incrementPromptCount()：记录 prompt 次数快照，用于跨 compaction 持久化
 */
import { createHash, randomUUID, type UUID } from 'crypto'
import { stat } from 'fs/promises'
import { isAbsolute, join, relative, sep } from 'path'
import { getOriginalCwd, getSessionId } from '../bootstrap/state.js'
import type {
  AttributionSnapshotMessage,
  FileAttributionState,
} from '../types/logs.js'
import { getCwd } from './cwd.js'
import { logForDebugging } from './debug.js'
import { execFileNoThrowWithCwd } from './execFileNoThrow.js'
import { getFsImplementation } from './fsOperations.js'
import { isGeneratedFile } from './generatedFiles.js'
import { getRemoteUrlForDir, resolveGitDir } from './git/gitFilesystem.js'
import { findGitRoot, gitExe } from './git.js'
import { logError } from './log.js'
import { getCanonicalName, type ModelName } from './model/model.js'
import { sequential } from './sequential.js'

/**
 * 允许在 commit trailer 中使用内部模型名称的仓库白名单。
 * 同时包含 SSH 和 HTTPS 两种 URL 格式。
 *
 * 注意：这里是仓库级白名单，不是 org 级检查。
 * anthropics 和 anthropic-experimental 组织下存在公开仓库
 *（如 anthropics/claude-code、anthropic-experimental/sandbox-runtime），
 * 在这些仓库中必须保持隐身模式以防止内部代号泄漏。
 * 只将确认为私有的仓库添加至此列表。
 */
const INTERNAL_MODEL_REPOS = [
  'github.com:anthropics/claude-cli-internal',
  'github.com/anthropics/claude-cli-internal',
  'github.com:anthropics/anthropic',
  'github.com/anthropics/anthropic',
  'github.com:anthropics/apps',
  'github.com/anthropics/apps',
  'github.com:anthropics/casino',
  'github.com/anthropics/casino',
  'github.com:anthropics/dbt',
  'github.com/anthropics/dbt',
  'github.com:anthropics/dotfiles',
  'github.com/anthropics/dotfiles',
  'github.com:anthropics/terraform-config',
  'github.com/anthropics/terraform-config',
  'github.com:anthropics/hex-export',
  'github.com/anthropics/hex-export',
  'github.com:anthropics/feedback-v2',
  'github.com/anthropics/feedback-v2',
  'github.com:anthropics/labs',
  'github.com/anthropics/labs',
  'github.com:anthropics/argo-rollouts',
  'github.com/anthropics/argo-rollouts',
  'github.com:anthropics/starling-configs',
  'github.com/anthropics/starling-configs',
  'github.com:anthropics/ts-tools',
  'github.com/anthropics/ts-tools',
  'github.com:anthropics/ts-capsules',
  'github.com/anthropics/ts-capsules',
  'github.com:anthropics/feldspar-testing',
  'github.com/anthropics/feldspar-testing',
  'github.com:anthropics/trellis',
  'github.com/anthropics/trellis',
  'github.com:anthropics/claude-for-hiring',
  'github.com/anthropics/claude-for-hiring',
  'github.com:anthropics/forge-web',
  'github.com/anthropics/forge-web',
  'github.com:anthropics/infra-manifests',
  'github.com/anthropics/infra-manifests',
  'github.com:anthropics/mycro_manifests',
  'github.com/anthropics/mycro_manifests',
  'github.com:anthropics/mycro_configs',
  'github.com/anthropics/mycro_configs',
  'github.com:anthropics/mobile-apps',
  'github.com/anthropics/mobile-apps',
]

/**
 * 获取归因操作所用的仓库根目录。
 * 使用 getCwd()（支持 agent worktree 的 AsyncLocalStorage 覆盖），
 * 再解析到 git 根目录以处理 `cd subdir` 的情况。
 * 若无法确定 git 根目录，则回退到 getOriginalCwd()。
 */
export function getAttributionRepoRoot(): string {
  const cwd = getCwd()
  return findGitRoot(cwd) ?? getOriginalCwd()
}

// 仓库分类结果缓存，每个进程初始化时预先填充一次。
// 'internal' = 远程 URL 匹配 INTERNAL_MODEL_REPOS 白名单
// 'external' = 有远程 URL，但不在白名单中（公开/开源仓库）
// 'none'     = 无远程 URL（非 git 仓库，或未配置远程）
let repoClassCache: 'internal' | 'external' | 'none' | null = null

/**
 * 同步返回已缓存的仓库分类结果。
 * 若异步检查尚未执行，则返回 null。
 */
export function getRepoClassCached(): 'internal' | 'external' | 'none' | null {
  return repoClassCache
}

/**
 * 同步返回 isInternalModelRepo() 的缓存结果。
 * 若检查尚未运行，返回 false（安全默认值：不泄露信息）。
 */
export function isInternalModelRepoCached(): boolean {
  return repoClassCache === 'internal'
}

/**
 * 检查当前仓库是否在内部模型名称白名单中。
 * 已记忆化 — 每个进程只检查一次。
 */
export const isInternalModelRepo = sequential(async (): Promise<boolean> => {
  if (repoClassCache !== null) {
    return repoClassCache === 'internal'
  }

  const cwd = getAttributionRepoRoot()
  const remoteUrl = await getRemoteUrlForDir(cwd)

  if (!remoteUrl) {
    repoClassCache = 'none'
    return false
  }
  const isInternal = INTERNAL_MODEL_REPOS.some(repo => remoteUrl.includes(repo))
  repoClassCache = isInternal ? 'internal' : 'external'
  return isInternal
})

/**
 * 将 surface key 转换为使用公开模型名称的版本。
 * 将内部模型变体转换为其公开等价名称。
 */
export function sanitizeSurfaceKey(surfaceKey: string): string {
  // 将 surface key 拆分为 surface 和 model 两部分（如 "cli/opus-4-5-fast" → ["cli", "opus-4-5-fast"]）
  const slashIndex = surfaceKey.lastIndexOf('/')
  if (slashIndex === -1) {
    return surfaceKey
  }

  const surface = surfaceKey.slice(0, slashIndex)
  const model = surfaceKey.slice(slashIndex + 1)
  const sanitizedModel = sanitizeModelName(model)

  return `${surface}/${sanitizedModel}`
}

// @[MODEL LAUNCH]: 为新模型 ID 添加映射，以便 git commit trailer 显示公开名称。
/**
 * 将模型名称转换为其公开等价版本。
 * 根据模型系列将内部变体映射到公开名称。
 */
export function sanitizeModelName(shortName: string): string {
  // 根据模型系列将内部变体映射为公开名称
  if (shortName.includes('opus-4-6')) return 'claude-opus-4-6'
  if (shortName.includes('opus-4-5')) return 'claude-opus-4-5'
  if (shortName.includes('opus-4-1')) return 'claude-opus-4-1'
  if (shortName.includes('opus-4')) return 'claude-opus-4'
  if (shortName.includes('sonnet-4-6')) return 'claude-sonnet-4-6'
  if (shortName.includes('sonnet-4-5')) return 'claude-sonnet-4-5'
  if (shortName.includes('sonnet-4')) return 'claude-sonnet-4'
  if (shortName.includes('sonnet-3-7')) return 'claude-sonnet-3-7'
  if (shortName.includes('haiku-4-5')) return 'claude-haiku-4-5'
  if (shortName.includes('haiku-3-5')) return 'claude-haiku-3-5'
  // 未知模型使用通用名称
  return 'claude'
}

/**
 * 追踪 Claude 对文件贡献的归因状态类型。
 */
export type AttributionState = {
  // 以相对路径（相对于 cwd）为键的文件状态映射
  fileStates: Map<string, FileAttributionState>
  // 用于计算净变更量的 session 基线状态
  sessionBaselines: Map<string, { contentHash: string; mtime: number }>
  // 编辑操作来源的客户端 surface
  surface: string
  // session 开始时的 HEAD SHA（用于检测外部提交）
  startingHeadSha: string | null
  // session 中的 prompt 总次数（用于计算 steer 次数）
  promptCount: number
  // 上次提交时的 prompt 次数（用于计算当前提交的 steer 次数）
  promptCountAtLastCommit: number
  // 权限提示次数追踪
  permissionPromptCount: number
  permissionPromptCountAtLastCommit: number
  // ESC 按键次数追踪（用户取消了权限提示）
  escapeCount: number
  escapeCountAtLastCommit: number
}

/**
 * 一次提交中 Claude 贡献量的汇总摘要。
 */
export type AttributionSummary = {
  claudePercent: number
  claudeChars: number
  humanChars: number
  surfaces: string[]
}

/**
 * git notes 中单个文件的归因详情。
 */
export type FileAttribution = {
  claudeChars: number
  humanChars: number
  percent: number
  surface: string
}

/**
 * git notes JSON 中存储的完整归因数据。
 */
export type AttributionData = {
  version: 1
  summary: AttributionSummary
  files: Record<string, FileAttribution>
  surfaceBreakdown: Record<string, { claudeChars: number; percent: number }>
  excludedGenerated: string[]
  sessions: string[]
}

/**
 * 从环境变量获取当前客户端 surface 名称。
 */
export function getClientSurface(): string {
  return process.env.CLAUDE_CODE_ENTRYPOINT ?? 'cli'
}

/**
 * 构建包含模型名称的 surface key。
 * 格式：`"surface/model"`（如 `"cli/claude-sonnet"`）
 */
export function buildSurfaceKey(surface: string, model: ModelName): string {
  return `${surface}/${getCanonicalName(model)}`
}

/**
 * 计算内容的 SHA-256 哈希值。
 */
export function computeContentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

/**
 * 将文件路径规范化为相对于 cwd 的相对路径，以实现一致的追踪。
 * 解析符号链接以处理 macOS 上 /tmp 与 /private/tmp 的差异。
 */
export function normalizeFilePath(filePath: string): string {
  const fs = getFsImplementation()
  const cwd = getAttributionRepoRoot()

  if (!isAbsolute(filePath)) {
    return filePath
  }

  // 解析两个路径中的符号链接以保证比较一致
  // （如 macOS 上 /tmp → /private/tmp）
  let resolvedPath = filePath
  let resolvedCwd = cwd

  try {
    resolvedPath = fs.realpathSync(filePath)
  } catch {
    // 文件可能尚不存在，使用原始路径
  }

  try {
    resolvedCwd = fs.realpathSync(cwd)
  } catch {
    // 保留原始 cwd
  }

  if (
    resolvedPath.startsWith(resolvedCwd + sep) ||
    resolvedPath === resolvedCwd
  ) {
    // 规范化为正斜杠，使键与 Windows 上的 git diff 输出一致
    return relative(resolvedCwd, resolvedPath).replaceAll(sep, '/')
  }

  // 回退：尝试原始路径进行比较
  if (filePath.startsWith(cwd + sep) || filePath === cwd) {
    return relative(cwd, filePath).replaceAll(sep, '/')
  }

  return filePath
}

/**
 * 将相对路径展开为绝对路径。
 */
export function expandFilePath(filePath: string): string {
  if (isAbsolute(filePath)) {
    return filePath
  }
  return join(getAttributionRepoRoot(), filePath)
}

/**
 * 为新 session 创建空的归因状态。
 */
export function createEmptyAttributionState(): AttributionState {
  return {
    fileStates: new Map(),
    sessionBaselines: new Map(),
    surface: getClientSurface(),
    startingHeadSha: null,
    promptCount: 0,
    promptCountAtLastCommit: 0,
    permissionPromptCount: 0,
    permissionPromptCountAtLastCommit: 0,
    escapeCount: 0,
    escapeCountAtLastCommit: 0,
  }
}

/**
 * 计算文件修改的字符贡献量。
 * 返回待存储的 FileAttributionState，追踪失败时返回 null。
 */
function computeFileModificationState(
  existingFileStates: Map<string, FileAttributionState>,
  filePath: string,
  oldContent: string,
  newContent: string,
  mtime: number,
): FileAttributionState | null {
  const normalizedPath = normalizeFilePath(filePath)

  try {
    // 计算 Claude 的字符贡献量
    let claudeContribution: number

    if (oldContent === '' || newContent === '') {
      // 新建文件或完整删除——贡献量等于内容长度
      claudeContribution =
        oldContent === '' ? newContent.length : oldContent.length
    } else {
      // 通过公共前缀/后缀匹配找到实际变更区域。
      // 正确处理等长替换（如 "Esc" → "esc"），
      // 此时 Math.abs(newLen - oldLen) 为 0 会漏判。
      const minLen = Math.min(oldContent.length, newContent.length)
      let prefixEnd = 0
      while (
        prefixEnd < minLen &&
        oldContent[prefixEnd] === newContent[prefixEnd]
      ) {
        prefixEnd++
      }
      let suffixLen = 0
      while (
        suffixLen < minLen - prefixEnd &&
        oldContent[oldContent.length - 1 - suffixLen] ===
          newContent[newContent.length - 1 - suffixLen]
      ) {
        suffixLen++
      }
      const oldChangedLen = oldContent.length - prefixEnd - suffixLen
      const newChangedLen = newContent.length - prefixEnd - suffixLen
      claudeContribution = Math.max(oldChangedLen, newChangedLen)
    }

    // 获取已有文件状态（如存在）
    const existingState = existingFileStates.get(normalizedPath)
    const existingContribution = existingState?.claudeContribution ?? 0

    return {
      contentHash: computeContentHash(newContent),
      claudeContribution: existingContribution + claudeContribution,
      mtime,
    }
  } catch (error) {
    logError(error as Error)
    return null
  }
}

/**
 * 获取文件的修改时间（mtimeMs），若文件不存在则回退到 Date.now()。
 * 此为异步函数，以便在进入同步 setAppState 回调之前预先计算。
 */
export async function getFileMtime(filePath: string): Promise<number> {
  const normalizedPath = normalizeFilePath(filePath)
  const absPath = expandFilePath(normalizedPath)
  try {
    const stats = await stat(absPath)
    return stats.mtimeMs
  } catch {
    return Date.now()
  }
}

/**
 * 追踪 Claude 对文件的修改。
 * 在 Edit/Write 工具完成后调用。
 */
export function trackFileModification(
  state: AttributionState,
  filePath: string,
  oldContent: string,
  newContent: string,
  _userModified: boolean,
  mtime: number = Date.now(),
): AttributionState {
  const normalizedPath = normalizeFilePath(filePath)
  const newFileState = computeFileModificationState(
    state.fileStates,
    filePath,
    oldContent,
    newContent,
    mtime,
  )
  if (!newFileState) {
    return state
  }

  const newFileStates = new Map(state.fileStates)
  newFileStates.set(normalizedPath, newFileState)

  logForDebugging(
    `Attribution: Tracked ${newFileState.claudeContribution} chars for ${normalizedPath}`,
  )

  return {
    ...state,
    fileStates: newFileStates,
  }
}

/**
 * 追踪 Claude 通过 bash 命令创建的文件。
 * 在 Claude 通过非受监控机制创建新文件时使用。
 */
export function trackFileCreation(
  state: AttributionState,
  filePath: string,
  content: string,
  mtime: number = Date.now(),
): AttributionState {
  // 创建本质上是从空内容到新内容的修改
  return trackFileModification(state, filePath, '', content, false, mtime)
}

/**
 * 追踪 Claude 通过 bash rm 命令删除的文件。
 * 在 Claude 通过非受监控机制删除文件时使用。
 */
export function trackFileDeletion(
  state: AttributionState,
  filePath: string,
  oldContent: string,
): AttributionState {
  const normalizedPath = normalizeFilePath(filePath)
  const existingState = state.fileStates.get(normalizedPath)
  const existingContribution = existingState?.claudeContribution ?? 0
  const deletedChars = oldContent.length

  const newFileState: FileAttributionState = {
    contentHash: '', // 已删除文件使用空哈希
    claudeContribution: existingContribution + deletedChars,
    mtime: Date.now(),
  }

  const newFileStates = new Map(state.fileStates)
  newFileStates.set(normalizedPath, newFileState)

  logForDebugging(
    `Attribution: Tracked deletion of ${normalizedPath} (${deletedChars} chars removed, total contribution: ${newFileState.claudeContribution})`,
  )

  return {
    ...state,
    fileStates: newFileStates,
  }
}

// --

/**
 * 批量追踪多个文件变更，只复制一次 Map 后依次修改。
 * 处理大型 git diff（如 jj 操作涉及数十万个文件）时，
 * 避免每个文件都复制 Map 带来的 O(n²) 开销。
 */
export function trackBulkFileChanges(
  state: AttributionState,
  changes: ReadonlyArray<{
    path: string
    type: 'modified' | 'created' | 'deleted'
    oldContent: string
    newContent: string
    mtime?: number
  }>,
): AttributionState {
  // 复制一次 Map，然后对每个文件就地修改
  const newFileStates = new Map(state.fileStates)

  for (const change of changes) {
    const mtime = change.mtime ?? Date.now()
    if (change.type === 'deleted') {
      const normalizedPath = normalizeFilePath(change.path)
      const existingState = newFileStates.get(normalizedPath)
      const existingContribution = existingState?.claudeContribution ?? 0
      const deletedChars = change.oldContent.length

      newFileStates.set(normalizedPath, {
        contentHash: '',
        claudeContribution: existingContribution + deletedChars,
        mtime,
      })

      logForDebugging(
        `Attribution: Tracked deletion of ${normalizedPath} (${deletedChars} chars removed, total contribution: ${existingContribution + deletedChars})`,
      )
    } else {
      const newFileState = computeFileModificationState(
        newFileStates,
        change.path,
        change.oldContent,
        change.newContent,
        mtime,
      )
      if (newFileState) {
        const normalizedPath = normalizeFilePath(change.path)
        newFileStates.set(normalizedPath, newFileState)

        logForDebugging(
          `Attribution: Tracked ${newFileState.claudeContribution} chars for ${normalizedPath}`,
        )
      }
    }
  }

  return {
    ...state,
    fileStates: newFileStates,
  }
}

/**
 * 计算已暂存文件的最终归因数据。
 * 将 session 基线与提交状态进行对比。
 */
export async function calculateCommitAttribution(
  states: AttributionState[],
  stagedFiles: string[],
): Promise<AttributionData> {
  const cwd = getAttributionRepoRoot()
  const sessionId = getSessionId()

  const files: Record<string, FileAttribution> = {}
  const excludedGenerated: string[] = []
  const surfaces = new Set<string>()
  const surfaceCounts: Record<string, number> = {}

  let totalClaudeChars = 0
  let totalHumanChars = 0

  // 合并所有 session 的文件状态
  const mergedFileStates = new Map<string, FileAttributionState>()
  const mergedBaselines = new Map<
    string,
    { contentHash: string; mtime: number }
  >()

  for (const state of states) {
    surfaces.add(state.surface)

    // 合并基线（最早的基线优先）
    // 兼容 Map 和普通对象（防止序列化后类型丢失）
    const baselines =
      state.sessionBaselines instanceof Map
        ? state.sessionBaselines
        : new Map(
            Object.entries(
              (state.sessionBaselines ?? {}) as Record<
                string,
                { contentHash: string; mtime: number }
              >,
            ),
          )
    for (const [path, baseline] of baselines) {
      if (!mergedBaselines.has(path)) {
        mergedBaselines.set(path, baseline)
      }
    }

    // 合并文件状态（累加贡献量）
    // 兼容 Map 和普通对象（防止序列化后类型丢失）
    const fileStates =
      state.fileStates instanceof Map
        ? state.fileStates
        : new Map(
            Object.entries(
              (state.fileStates ?? {}) as Record<string, FileAttributionState>,
            ),
          )
    for (const [path, fileState] of fileStates) {
      const existing = mergedFileStates.get(path)
      if (existing) {
        mergedFileStates.set(path, {
          ...fileState,
          claudeContribution:
            existing.claudeContribution + fileState.claudeContribution,
        })
      } else {
        mergedFileStates.set(path, fileState)
      }
    }
  }

  // 并行处理所有文件
  const fileResults = await Promise.all(
    stagedFiles.map(async file => {
      // 跳过生成文件
      if (isGeneratedFile(file)) {
        return { type: 'generated' as const, file }
      }

      const absPath = join(cwd, file)
      const fileState = mergedFileStates.get(file)
      const baseline = mergedBaselines.get(file)

      // 获取该文件的 surface 来源
      const fileSurface = states[0]!.surface

      let claudeChars = 0
      let humanChars = 0

      // 检查文件是否已被删除
      const deleted = await isFileDeleted(file)

      if (deleted) {
        // 文件已删除
        if (fileState) {
          // Claude 删除了该文件（已追踪的删除）
          claudeChars = fileState.claudeContribution
          humanChars = 0
        } else {
          // 人类删除了该文件（未追踪的删除）
          // 使用 diff 大小获取实际变更量
          const diffSize = await getGitDiffSize(file)
          humanChars = diffSize > 0 ? diffSize : 100 // 删除操作的最小归因量
        }
      } else {
        try {
          // 只需要文件大小，无需读取内容——stat() 可避免将 GB 级别的
          // 构建产物加载进内存。stats.size（字节数）可作为字符数的近似值。
          const stats = await stat(absPath)

          if (fileState) {
            // 该文件有已追踪的修改记录
            claudeChars = fileState.claudeContribution
            humanChars = 0
          } else if (baseline) {
            // 文件已修改但未被追踪——属于人类的修改
            const diffSize = await getGitDiffSize(file)
            humanChars = diffSize > 0 ? diffSize : stats.size
          } else {
            // Claude 未创建的新文件
            humanChars = stats.size
          }
        } catch {
          // 文件不存在或 stat 失败——跳过
          return null
        }
      }

      // 确保值非负
      claudeChars = Math.max(0, claudeChars)
      humanChars = Math.max(0, humanChars)

      const total = claudeChars + humanChars
      const percent = total > 0 ? Math.round((claudeChars / total) * 100) : 0

      return {
        type: 'file' as const,
        file,
        claudeChars,
        humanChars,
        percent,
        surface: fileSurface,
      }
    }),
  )

  // 汇总各文件处理结果
  for (const result of fileResults) {
    if (!result) continue

    if (result.type === 'generated') {
      excludedGenerated.push(result.file)
      continue
    }

    files[result.file] = {
      claudeChars: result.claudeChars,
      humanChars: result.humanChars,
      percent: result.percent,
      surface: result.surface,
    }

    totalClaudeChars += result.claudeChars
    totalHumanChars += result.humanChars

    surfaceCounts[result.surface] =
      (surfaceCounts[result.surface] ?? 0) + result.claudeChars
  }

  const totalChars = totalClaudeChars + totalHumanChars
  const claudePercent =
    totalChars > 0 ? Math.round((totalClaudeChars / totalChars) * 100) : 0

  // 计算各 surface 的贡献占比（占总内容的百分比）
  const surfaceBreakdown: Record<
    string,
    { claudeChars: number; percent: number }
  > = {}
  for (const [surface, chars] of Object.entries(surfaceCounts)) {
    // 计算该 surface 占总内容的百分比
    const percent = totalChars > 0 ? Math.round((chars / totalChars) * 100) : 0
    surfaceBreakdown[surface] = { claudeChars: chars, percent }
  }

  return {
    version: 1,
    summary: {
      claudePercent,
      claudeChars: totalClaudeChars,
      humanChars: totalHumanChars,
      surfaces: Array.from(surfaces),
    },
    files,
    surfaceBreakdown,
    excludedGenerated,
    sessions: [sessionId],
  }
}

/**
 * 从 git diff 获取文件变更的字符数量。
 * 返回新增/删除的字符数（绝对差值）。
 * 新建文件返回文件总大小；已删除文件返回被删内容的大小。
 */
export async function getGitDiffSize(filePath: string): Promise<number> {
  const cwd = getAttributionRepoRoot()

  try {
    // 使用 git diff --stat 获取变更摘要
    const result = await execFileNoThrowWithCwd(
      gitExe(),
      ['diff', '--cached', '--stat', '--', filePath],
      { cwd, timeout: 5000 },
    )

    if (result.code !== 0 || !result.stdout) {
      return 0
    }

    // 解析 stat 输出以提取新增和删除行数
    // 格式：" file | 5 ++---" 或 " file | 10 +"
    const lines = result.stdout.split('\n').filter(Boolean)
    let totalChanges = 0

    for (const line of lines) {
      // 跳过汇总行（如 "1 file changed, 3 insertions(+), 2 deletions(-)"）
      if (line.includes('file changed') || line.includes('files changed')) {
        const insertMatch = line.match(/(\d+) insertions?/)
        const deleteMatch = line.match(/(\d+) deletions?/)

        // 使用行级别的变更量，以每行约 40 字符作为近似字符数
        const insertions = insertMatch ? parseInt(insertMatch[1]!, 10) : 0
        const deletions = deleteMatch ? parseInt(deleteMatch[1]!, 10) : 0
        totalChanges += (insertions + deletions) * 40
      }
    }

    return totalChanges
  } catch {
    return 0
  }
}

/**
 * 检查文件是否在已暂存的变更中被删除。
 */
export async function isFileDeleted(filePath: string): Promise<boolean> {
  const cwd = getAttributionRepoRoot()

  try {
    const result = await execFileNoThrowWithCwd(
      gitExe(),
      ['diff', '--cached', '--name-status', '--', filePath],
      { cwd, timeout: 5000 },
    )

    if (result.code === 0 && result.stdout) {
      // 格式："D\tfilename" 表示已删除文件
      return result.stdout.trim().startsWith('D\t')
    }
  } catch {
    // 忽略错误
  }

  return false
}

/**
 * 从 git 获取已暂存的文件列表。
 */
export async function getStagedFiles(): Promise<string[]> {
  const cwd = getAttributionRepoRoot()

  try {
    const result = await execFileNoThrowWithCwd(
      gitExe(),
      ['diff', '--cached', '--name-only'],
      { cwd, timeout: 5000 },
    )

    if (result.code === 0 && result.stdout) {
      return result.stdout.split('\n').filter(Boolean)
    }
  } catch (error) {
    logError(error as Error)
  }

  return []
}

// formatAttributionTrailer 已移至 attributionTrailer.ts 以便 tree-shaking
// （该文件包含不应出现在外部构建中的特定字符串）

/**
 * 检查当前是否处于 git 临时状态（rebase、merge、cherry-pick）。
 */
export async function isGitTransientState(): Promise<boolean> {
  const gitDir = await resolveGitDir(getAttributionRepoRoot())
  if (!gitDir) return false

  const indicators = [
    'rebase-merge',
    'rebase-apply',
    'MERGE_HEAD',
    'CHERRY_PICK_HEAD',
    'BISECT_LOG',
  ]

  const results = await Promise.all(
    indicators.map(async indicator => {
      try {
        await stat(join(gitDir, indicator))
        return true
      } catch {
        return false
      }
    }),
  )

  return results.some(exists => exists)
}

/**
 * 将归因状态转换为快照消息以持久化。
 */
export function stateToSnapshotMessage(
  state: AttributionState,
  messageId: UUID,
): AttributionSnapshotMessage {
  const fileStates: Record<string, FileAttributionState> = {}

  for (const [path, fileState] of state.fileStates) {
    fileStates[path] = fileState
  }

  return {
    type: 'attribution-snapshot',
    messageId,
    surface: state.surface,
    fileStates,
    promptCount: state.promptCount,
    promptCountAtLastCommit: state.promptCountAtLastCommit,
    permissionPromptCount: state.permissionPromptCount,
    permissionPromptCountAtLastCommit: state.permissionPromptCountAtLastCommit,
    escapeCount: state.escapeCount,
    escapeCountAtLastCommit: state.escapeCountAtLastCommit,
  }
}

/**
 * 从快照消息中恢复归因状态。
 */
export function restoreAttributionStateFromSnapshots(
  snapshots: AttributionSnapshotMessage[],
): AttributionState {
  const state = createEmptyAttributionState()

  // 快照是完整状态转储（参见 stateToSnapshotMessage），而非增量更新。
  // 最后一条快照包含每个路径的最新计数 —— fileStates 只增不减。
  // 跨快照迭代并累加计数会导致恢复时二次方增长
  //（837 条快照 × 280 个文件 → 在 5 天 session 中一个 5KB 文件被记录了 1.15 × 10¹⁵ 个"字符"）。
  const lastSnapshot = snapshots[snapshots.length - 1]
  if (!lastSnapshot) {
    return state
  }

  state.surface = lastSnapshot.surface
  for (const [path, fileState] of Object.entries(lastSnapshot.fileStates)) {
    state.fileStates.set(path, fileState)
  }

  // 从最后一条快照（最新状态）恢复 prompt 计数
  state.promptCount = lastSnapshot.promptCount ?? 0
  state.promptCountAtLastCommit = lastSnapshot.promptCountAtLastCommit ?? 0
  state.permissionPromptCount = lastSnapshot.permissionPromptCount ?? 0
  state.permissionPromptCountAtLastCommit =
    lastSnapshot.permissionPromptCountAtLastCommit ?? 0
  state.escapeCount = lastSnapshot.escapeCount ?? 0
  state.escapeCountAtLastCommit = lastSnapshot.escapeCountAtLastCommit ?? 0

  return state
}

/**
 * 在 session 恢复时从日志快照中还原归因状态。
 */
export function attributionRestoreStateFromLog(
  attributionSnapshots: AttributionSnapshotMessage[],
  onUpdateState: (newState: AttributionState) => void,
): void {
  const state = restoreAttributionStateFromSnapshots(attributionSnapshots)
  onUpdateState(state)
}

/**
 * 递增 promptCount 并保存归因快照。
 * 用于跨 compaction 持久化 prompt 计数。
 *
 * @param attribution - 当前归因状态
 * @param saveSnapshot - 保存快照的回调函数（允许调用方异步处理）
 * @returns 已递增 promptCount 的新归因状态
 */
export function incrementPromptCount(
  attribution: AttributionState,
  saveSnapshot: (snapshot: AttributionSnapshotMessage) => void,
): AttributionState {
  const newAttribution = {
    ...attribution,
    promptCount: attribution.promptCount + 1,
  }
  const snapshot = stateToSnapshotMessage(newAttribution, randomUUID())
  saveSnapshot(snapshot)
  return newAttribution
}
