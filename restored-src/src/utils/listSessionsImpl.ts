/**
 * listSessionsImpl.ts — Agent SDK 会话列表实现模块
 *
 * 【在 Claude Code 系统流程中的位置】
 * 本文件是 Agent SDK 的独立会话列表实现，与 CLI 的会话管理模块解耦。
 * 核心设计原则：最小化依赖——不引入 bootstrap/state.ts、analytics、
 * bun:bundle 或模块级可变状态，确保可从 SDK 入口安全导入而不触发
 * CLI 初始化或引入昂贵的依赖链。
 *
 * 【主要功能】
 * 1. parseSessionInfoFromLite   — 从 head/tail/stat 轻量读取中提取 SessionInfo；
 * 2. listCandidates             — 通过 readdir 枚举候选会话文件（可选 stat 获取 mtime）；
 * 3. listSessionsImpl           — 主入口：列出所有会话并返回按修改时间排序的结果；
 * 4. gatherProjectCandidates   — 单项目扫描（支持 git worktree 感知）；
 * 5. gatherAllCandidates        — 全项目扫描。
 *
 * 【性能优化】
 * - 设置了 limit/offset 时，先做廉价的 stat-only 预扫描（1 次 syscall/文件），
 *   按修改时间排序后，仅对排在前面的候选做昂贵的 head/tail 内容读取；
 * - 未设置 limit/offset 时跳过 stat 预扫描，直接读取所有文件再排序
 *   （与原始实现的 I/O 开销相同）。
 */

import type { Dirent } from 'fs'
import { readdir, stat } from 'fs/promises'
import { basename, join } from 'path'
import { getWorktreePathsPortable } from './getWorktreePathsPortable.js'
import type { LiteSessionFile } from './sessionStoragePortable.js'
import {
  canonicalizePath,
  extractFirstPromptFromHead,
  extractJsonStringField,
  extractLastJsonStringField,
  findProjectDir,
  getProjectsDir,
  MAX_SANITIZED_LENGTH,
  readSessionLite,
  sanitizePath,
  validateUuid,
} from './sessionStoragePortable.js'

/**
 * listSessions 返回的会话元数据结构。
 * 所有字段均可从 stat + head/tail 读取中提取，无需完整解析 JSONL 文件。
 */
export type SessionInfo = {
  sessionId: string
  summary: string           // 会话摘要（customTitle > aiTitle > lastPrompt > firstPrompt）
  lastModified: number      // 最后修改时间（epoch ms）
  fileSize?: number         // 文件大小（字节）
  customTitle?: string      // 用户手动设置的标题
  firstPrompt?: string      // 会话的第一条用户提示
  gitBranch?: string        // 会话关联的 git 分支
  cwd?: string              // 会话工作目录
  tag?: string              // 会话标签（来自 {"type":"tag"} 行）
  /** epoch ms — 来自第一条记录的 ISO 时间戳。无法解析时为 undefined。 */
  createdAt?: number
}

/**
 * listSessionsImpl 的选项参数类型。
 */
export type ListSessionsOptions = {
  /**
   * 要列出会话的项目目录。提供时，返回该项目目录（及其 git worktree）的会话。
   * 省略时，返回所有项目的会话。
   */
  dir?: string
  /** 返回的最大会话数量。 */
  limit?: number
  /**
   * 从排序结果集开头跳过的会话数量，与 limit 配合实现分页。默认为 0。
   */
  offset?: number
  /**
   * 当 dir 指向 git 仓库时，是否包含所有 git worktree 的会话。默认为 true。
   */
  includeWorktrees?: boolean
}

// ---------------------------------------------------------------------------
// 字段提取 — 供 listSessionsImpl 和 getSessionInfoImpl 共用
// ---------------------------------------------------------------------------

/**
 * 从轻量会话读取（head/tail/stat）中解析 SessionInfo 字段。
 * 对于 sidechain 会话或无法提取摘要的纯元数据会话，返回 null。
 *
 * 供 getSessionInfoImpl 复用，因此导出。
 */
export function parseSessionInfoFromLite(
  sessionId: string,
  lite: LiteSessionFile,
  projectPath?: string,
): SessionInfo | null {
  const { head, tail, mtime, size } = lite

  // 检测第一行是否为 sidechain 会话标记
  const firstNewline = head.indexOf('\n')
  const firstLine = firstNewline >= 0 ? head.slice(0, firstNewline) : head
  if (
    firstLine.includes('"isSidechain":true') ||
    firstLine.includes('"isSidechain": true')
  ) {
    // sidechain 会话不纳入列表（它是主会话的辅助流）
    return null
  }

  // 标题优先级：用户自定义标题（customTitle）> AI 生成标题（aiTitle）
  // extractLastJsonStringField 自然区分字段名，无需额外处理
  const customTitle =
    extractLastJsonStringField(tail, 'customTitle') ||
    extractLastJsonStringField(head, 'customTitle') ||
    extractLastJsonStringField(tail, 'aiTitle') ||
    extractLastJsonStringField(head, 'aiTitle') ||
    undefined

  const firstPrompt = extractFirstPromptFromHead(head) || undefined

  // 第一条记录的 ISO 时间戳 → epoch ms
  // 比 stat().birthtime 更可靠（部分文件系统不支持 birthtime）
  const firstTimestamp = extractJsonStringField(head, 'timestamp')
  let createdAt: number | undefined
  if (firstTimestamp) {
    const parsed = Date.parse(firstTimestamp)
    if (!Number.isNaN(parsed)) createdAt = parsed
  }

  // 摘要优先级：自定义标题 > lastPrompt（尾部） > summary（尾部） > firstPrompt
  const summary =
    customTitle ||
    extractLastJsonStringField(tail, 'lastPrompt') ||
    extractLastJsonStringField(tail, 'summary') ||
    firstPrompt

  // 无任何可用摘要信息的纯元数据会话，跳过
  if (!summary) return null

  const gitBranch =
    extractLastJsonStringField(tail, 'gitBranch') ||
    extractJsonStringField(head, 'gitBranch') ||
    undefined

  const sessionCwd =
    extractJsonStringField(head, 'cwd') || projectPath || undefined

  // 将 tag 提取限定在 {"type":"tag"} 行，避免与工具调用中含 tag 参数的行混淆
  // （如 git tag、Docker tag、云资源标签等），与 sessionStorage.ts:608 保持一致
  const tagLine = tail.split('\n').findLast(l => l.startsWith('{"type":"tag"'))
  const tag = tagLine
    ? extractLastJsonStringField(tagLine, 'tag') || undefined
    : undefined

  return {
    sessionId,
    summary,
    lastModified: mtime,
    fileSize: size,
    customTitle,
    firstPrompt,
    gitBranch,
    cwd: sessionCwd,
    tag,
    createdAt,
  }
}

// ---------------------------------------------------------------------------
// 候选文件发现 — 仅 stat 阶段。开销低：每文件 1 次 syscall，不读取内容。
// 允许在执行昂贵的 head/tail 读取前先排序/过滤候选列表。
// ---------------------------------------------------------------------------

/** 候选会话文件的元数据（仅包含排序所需的基本字段）。 */
type Candidate = {
  sessionId: string
  filePath: string
  mtime: number           // 修改时间（epoch ms）；doStat=false 时为 0
  /** 缺少 cwd 字段时用于回退的项目路径。 */
  projectPath?: string
}

/**
 * 通过 readdir 枚举目录中的候选会话文件，可选地 stat 获取 mtime。
 * 当 doStat 为 false 时，mtime 设为 0（调用方需在读取文件内容后排序/去重）。
 */
export async function listCandidates(
  projectDir: string,
  doStat: boolean,
  projectPath?: string,
): Promise<Candidate[]> {
  let names: string[]
  try {
    names = await readdir(projectDir)
  } catch {
    // 目录不存在或无权限，返回空数组
    return []
  }

  const results = await Promise.all(
    names.map(async (name): Promise<Candidate | null> => {
      if (!name.endsWith('.jsonl')) return null  // 只处理 JSONL 文件
      const sessionId = validateUuid(name.slice(0, -6))  // 去掉 .jsonl 后缀，验证 UUID
      if (!sessionId) return null  // 非 UUID 文件名，跳过
      const filePath = join(projectDir, name)
      if (!doStat) return { sessionId, filePath, mtime: 0, projectPath }  // 跳过 stat
      try {
        const s = await stat(filePath)
        return { sessionId, filePath, mtime: s.mtime.getTime(), projectPath }
      } catch {
        return null  // 文件已被删除或无法访问
      }
    }),
  )

  return results.filter((c): c is Candidate => c !== null)
}

/**
 * 读取候选文件内容并提取完整的 SessionInfo。
 * 若该会话应被过滤掉（sidechain、无摘要），返回 null。
 */
async function readCandidate(c: Candidate): Promise<SessionInfo | null> {
  const lite = await readSessionLite(c.filePath)
  if (!lite) return null

  const info = parseSessionInfoFromLite(c.sessionId, lite, c.projectPath)
  if (!info) return null

  // 优先使用 stat 预扫描阶段获取的 mtime 保证排序键一致性；
  // 若 doStat=false（c.mtime 为 0 占位符），则使用 lite.mtime
  if (c.mtime) info.lastModified = c.mtime

  return info
}

// ---------------------------------------------------------------------------
// 排序 + 限量 — 按排序顺序批量读取候选，直到收集到 limit 条有效结果
// （部分候选在完整读取后会被过滤掉）。
// ---------------------------------------------------------------------------

/** 并发读取的批次大小。 */
const READ_BATCH_SIZE = 32

/**
 * 排序比较器：按 lastModified 降序排列；mtime 相同时按 sessionId 降序（确保稳定性）。
 */
function compareDesc(a: Candidate, b: Candidate): number {
  if (b.mtime !== a.mtime) return b.mtime - a.mtime
  return b.sessionId < a.sessionId ? -1 : b.sessionId > a.sessionId ? 1 : 0
}

/**
 * 对候选列表排序，然后分批读取，直到收集到足够数量的有效 SessionInfo。
 *
 * 优化原理：limit=20 时，对 1000 个文件只做 ~1000 次 stat + ~20 次内容读取，
 * 而非 1000 次内容读取。
 */
async function applySortAndLimit(
  candidates: Candidate[],
  limit: number | undefined,
  offset: number,
): Promise<SessionInfo[]> {
  // 按修改时间降序排序
  candidates.sort(compareDesc)

  const sessions: SessionInfo[] = []
  // limit 为 0 表示"不限制"（与 getSessionMessages 语义一致）
  const want = limit && limit > 0 ? limit : Infinity
  let skipped = 0

  // 去重逻辑（后处理）：候选已按 mtime 降序排列，对同一 sessionId 首次出现的非空读取
  // 自然就是修改时间最新的有效副本。先过滤再去重可能丢掉最新副本（若其内容不可读），
  // 这会与 readAllAndSort 路径产生行为差异，因此在这里做后处理去重。
  const seen = new Set<string>()

  for (let i = 0; i < candidates.length && sessions.length < want; ) {
    // 每次处理一批（批量并发读取）
    const batchEnd = Math.min(i + READ_BATCH_SIZE, candidates.length)
    const batch = candidates.slice(i, batchEnd)
    const results = await Promise.all(batch.map(readCandidate))
    for (let j = 0; j < results.length && sessions.length < want; j++) {
      i++
      const r = results[j]
      if (!r) continue                       // 会话被过滤掉（sidechain 等）
      if (seen.has(r.sessionId)) continue    // 去重：跳过已见过的 sessionId
      seen.add(r.sessionId)
      if (skipped < offset) {
        skipped++                            // 跳过 offset 条（分页用）
        continue
      }
      sessions.push(r)
    }
  }

  return sessions
}

/**
 * 无 limit/offset 时的完整读取路径，跳过 stat 预扫描阶段。
 * 读取所有候选后，按文件内容中的真实 mtime 排序并去重。
 * I/O 开销与原始实现相同（无额外的 stat 调用）。
 */
async function readAllAndSort(candidates: Candidate[]): Promise<SessionInfo[]> {
  const all = await Promise.all(candidates.map(readCandidate))

  // 按 sessionId 去重：保留每个 sessionId 中 lastModified 最大的记录
  const byId = new Map<string, SessionInfo>()
  for (const s of all) {
    if (!s) continue
    const existing = byId.get(s.sessionId)
    if (!existing || s.lastModified > existing.lastModified) {
      byId.set(s.sessionId, s)
    }
  }

  const sessions = [...byId.values()]
  // 最终按修改时间降序排列（mtime 相同时按 sessionId 降序保证稳定性）
  sessions.sort((a, b) =>
    b.lastModified !== a.lastModified
      ? b.lastModified - a.lastModified
      : b.sessionId < a.sessionId
        ? -1
        : b.sessionId > a.sessionId
          ? 1
          : 0,
  )
  return sessions
}

// ---------------------------------------------------------------------------
// 项目目录枚举（单项目 vs 全项目）
// ---------------------------------------------------------------------------

/**
 * 收集指定项目目录（及其 git worktree）的候选会话文件。
 */
async function gatherProjectCandidates(
  dir: string,
  includeWorktrees: boolean,
  doStat: boolean,
): Promise<Candidate[]> {
  // 规范化路径（解析符号链接、规范化大小写等）
  const canonicalDir = await canonicalizePath(dir)

  let worktreePaths: string[]
  if (includeWorktrees) {
    try {
      worktreePaths = await getWorktreePathsPortable(canonicalDir)
    } catch {
      worktreePaths = []  // git 不可用或仓库无 worktree
    }
  } else {
    worktreePaths = []
  }

  // 无 worktree（或 git 不可用）时，仅扫描单个项目目录
  if (worktreePaths.length <= 1) {
    const projectDir = await findProjectDir(canonicalDir)
    if (!projectDir) return []
    return listCandidates(projectDir, doStat, canonicalDir)
  }

  // Worktree 感知扫描：找出所有匹配任意 worktree 路径的项目目录
  const projectsDir = getProjectsDir()
  const caseInsensitive = process.platform === 'win32'  // Windows 文件系统不区分大小写

  // 对 worktree 路径按 sanitized 前缀长度降序排列（最长优先），
  // 确保更具体的路径匹配优先于较短的前缀
  const indexed = worktreePaths.map(wt => {
    const sanitized = sanitizePath(wt)
    return {
      path: wt,
      prefix: caseInsensitive ? sanitized.toLowerCase() : sanitized,
    }
  })
  indexed.sort((a, b) => b.prefix.length - a.prefix.length)

  let allDirents: Dirent[]
  try {
    allDirents = await readdir(projectsDir, { withFileTypes: true })
  } catch {
    // 项目目录列表读取失败，回退到单项目扫描
    const projectDir = await findProjectDir(canonicalDir)
    if (!projectDir) return []
    return listCandidates(projectDir, doStat, canonicalDir)
  }

  const all: Candidate[] = []
  const seenDirs = new Set<string>()

  // 始终包含用户实际目录（处理子目录如 /repo/packages/my-app 不匹配 worktree 根路径的情况）
  const canonicalProjectDir = await findProjectDir(canonicalDir)
  if (canonicalProjectDir) {
    const dirBase = basename(canonicalProjectDir)
    seenDirs.add(caseInsensitive ? dirBase.toLowerCase() : dirBase)
    all.push(
      ...(await listCandidates(canonicalProjectDir, doStat, canonicalDir)),
    )
  }

  // 遍历所有项目目录，匹配 worktree 路径前缀
  for (const dirent of allDirents) {
    if (!dirent.isDirectory()) continue
    const dirName = caseInsensitive ? dirent.name.toLowerCase() : dirent.name
    if (seenDirs.has(dirName)) continue  // 跳过已处理的目录

    for (const { path: wtPath, prefix } of indexed) {
      // 对于截断路径（超过 MAX_SANITIZED_LENGTH 时后接哈希后缀），使用前缀匹配；
      // 对于短路径，要求完全匹配，避免 /root/project 误匹配 /root/project-foo
      const isMatch =
        dirName === prefix ||
        (prefix.length >= MAX_SANITIZED_LENGTH &&
          dirName.startsWith(prefix + '-'))
      if (isMatch) {
        seenDirs.add(dirName)
        all.push(
          ...(await listCandidates(
            join(projectsDir, dirent.name),
            doStat,
            wtPath,
          )),
        )
        break  // 一个目录只匹配一个 worktree
      }
    }
  }

  return all
}

/**
 * 收集所有项目目录下的候选会话文件。
 */
async function gatherAllCandidates(doStat: boolean): Promise<Candidate[]> {
  const projectsDir = getProjectsDir()

  let dirents: Dirent[]
  try {
    dirents = await readdir(projectsDir, { withFileTypes: true })
  } catch {
    return []  // 项目根目录不存在
  }

  // 并发枚举所有项目子目录
  const perProject = await Promise.all(
    dirents
      .filter(d => d.isDirectory())
      .map(d => listCandidates(join(projectsDir, d.name), doStat)),
  )

  return perProject.flat()
}

/**
 * 列出会话并返回按修改时间排序的 SessionInfo 数组（主入口）。
 *
 * 当设置了 dir 时，返回该项目目录（及其 git worktree）的会话；
 * 未设置 dir 时，返回所有项目的会话。
 *
 * 分页行为（limit/offset）：
 *   - 设置了 limit 或 offset 时：先做廉价的 stat 预扫描排序候选，
 *     然后仅对排在前面的候选执行昂贵的 head/tail 读取。
 *     例如：目录有 1000 个会话、limit=20 时，只需 ~1000 次 stat + ~20 次内容读取。
 *   - 未设置时：跳过 stat 预扫描，直接读取所有候选再排序（与原始实现 I/O 开销相同）。
 */
export async function listSessionsImpl(
  options?: ListSessionsOptions,
): Promise<SessionInfo[]> {
  const { dir, limit, offset, includeWorktrees } = options ?? {}
  const off = offset ?? 0

  // 仅在需要先排序再读取时才执行 stat（limit:0 等同于"不限制"，视为未设置）
  const doStat = (limit !== undefined && limit > 0) || off > 0

  // 根据是否指定目录，选择项目级扫描还是全量扫描
  const candidates = dir
    ? await gatherProjectCandidates(dir, includeWorktrees ?? true, doStat)
    : await gatherAllCandidates(doStat)

  if (!doStat) return readAllAndSort(candidates)   // 无 limit/offset：读取全部后排序
  return applySortAndLimit(candidates, limit, off)  // 有 limit/offset：排序后按需读取
}
