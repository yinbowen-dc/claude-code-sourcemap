/**
 * bridgePointer.ts — Bridge 会话崩溃恢复指针管理
 *
 * 在 Claude Code 系统流程中的位置：
 *   Remote Control 会话生命周期管理层
 *     └─> bridgePointer.ts（本文件）——提供跨进程崩溃恢复机制
 *           ├─ writeBridgePointer()    — Bridge 初始化后立即写入恢复指针
 *           ├─ readBridgePointer()     — 启动时检测是否有未完成的 Bridge 会话
 *           ├─ readBridgePointerAcrossWorktrees() — 跨 git 工作树扫描恢复指针
 *           └─ clearBridgePointer()   — 正常关闭时清除指针
 *
 * 工作原理：
 *   Bridge 会话创建后立即写入一个 bridge-pointer.json 文件（位于项目数据目录），
 *   记录 sessionId、environmentId 和来源（standalone/repl）。
 *   - 正常关闭：clearBridgePointer 删除该文件；
 *   - 异常退出（崩溃/kill -9/终端关闭）：文件持久存在；
 *   - 下次启动时：readBridgePointer 检测到该文件，提示用户通过 --session-id 恢复。
 *
 *   新鲜度判断基于文件 mtime（而非内嵌时间戳），因此周期性重写（内容不变）
 *   等同于刷新"心跳"，与后端的 BRIDGE_LAST_POLL_TTL（4h）语义一致。
 *   超过 4 小时未刷新的指针视为过期并自动删除。
 *
 *   每个工作目录独立存储指针（与对话记录 JSONL 文件并列），
 *   支持不同仓库的多个 Bridge 实例并发而不互相干扰。
 */
import { mkdir, readFile, stat, unlink, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { z } from 'zod/v4'
import { logForDebugging } from '../utils/debug.js'
import { isENOENT } from '../utils/errors.js'
import { getWorktreePathsPortable } from '../utils/getWorktreePathsPortable.js'
import { lazySchema } from '../utils/lazySchema.js'
import {
  getProjectsDir,
  sanitizePath,
} from '../utils/sessionStoragePortable.js'
import { jsonParse, jsonStringify } from '../utils/slowOperations.js'

/**
 * 工作树扇出的最大数量上限。
 * git worktree list 本身有边界（50 个已经很多了），
 * 此常量限制并行 stat() 的爆发量，防止病态配置。
 * 超过此限制时，--continue 回退为仅检查当前目录。
 *
 * Upper bound on worktree fanout. git worktree list is naturally bounded
 * (50 is a LOT), but this caps the parallel stat() burst and guards against
 * pathological setups. Above this, --continue falls back to current-dir-only.
 */
const MAX_WORKTREE_FANOUT = 50

/**
 * Crash-recovery pointer for Remote Control sessions.
 *
 * Written immediately after a bridge session is created, periodically
 * refreshed during the session, and cleared on clean shutdown. If the
 * process dies unclean (crash, kill -9, terminal closed), the pointer
 * persists. On next startup, `claude remote-control` detects it and offers
 * to resume via the --session-id flow from #20460.
 *
 * Staleness is checked against the file's mtime (not an embedded timestamp)
 * so that a periodic re-write with the same content serves as a refresh —
 * matches the backend's rolling BRIDGE_LAST_POLL_TTL (4h) semantics. A
 * bridge that's been polling for 5+ hours and then crashes still has a
 * fresh pointer as long as the refresh ran within the window.
 *
 * Scoped per working directory (alongside transcript JSONL files) so two
 * concurrent bridges in different repos don't clobber each other.
 *
 * Bridge 崩溃恢复指针：
 *   - Bridge 会话创建后立即写入，会话期间周期性刷新（更新 mtime），正常关闭时删除；
 *   - 进程异常退出时文件持续存在，下次启动时被检测到并提示用户恢复；
 *   - 新鲜度检测基于文件 mtime（4 小时有效期），过期指针自动删除；
 *   - 按工作目录分别存储，多仓库并发 Bridge 不互相干扰。
 */

/** Bridge 指针的有效期（毫秒），与后端 BRIDGE_LAST_POLL_TTL 保持一致（4 小时） */
export const BRIDGE_POINTER_TTL_MS = 4 * 60 * 60 * 1000

/** Bridge 指针的 Zod 验证模式，惰性初始化避免启动时不必要的解析开销 */
const BridgePointerSchema = lazySchema(() =>
  z.object({
    sessionId: z.string(),       // Claude 会话 ID（用于 /resume）
    environmentId: z.string(),   // Bridge 环境 ID（用于重新注册）
    source: z.enum(['standalone', 'repl']), // 启动来源：独立模式或 REPL 模式
  }),
)

/** Bridge 指针的类型定义，从 Zod 模式推导 */
export type BridgePointer = z.infer<ReturnType<typeof BridgePointerSchema>>

/**
 * 获取指定工作目录对应的 Bridge 指针文件路径。
 * 路径格式：{projectsDir}/{sanitized(dir)}/bridge-pointer.json
 */
export function getBridgePointerPath(dir: string): string {
  return join(getProjectsDir(), sanitizePath(dir), 'bridge-pointer.json')
}

/**
 * 写入 Bridge 崩溃恢复指针文件。
 *
 * 同时用于两个场景：
 *   1. Bridge 会话首次创建时的初始写入；
 *   2. 长期运行会话中的周期性刷新（相同内容写入 = 更新 mtime = 刷新有效期计时器）。
 *
 * 最大努力操作（best-effort）——崩溃恢复文件本身不应引发崩溃，
 * 任何错误均会被记录并静默吞掉。
 *
 * Write the pointer. Also used to refresh mtime during long sessions —
 * calling with the same IDs is a cheap no-content-change write that bumps
 * the staleness clock. Best-effort — a crash-recovery file must never
 * itself cause a crash. Logs and swallows on error.
 */
export async function writeBridgePointer(
  dir: string,
  pointer: BridgePointer,
): Promise<void> {
  const path = getBridgePointerPath(dir)
  try {
    await mkdir(dirname(path), { recursive: true }) // 确保父目录存在
    await writeFile(path, jsonStringify(pointer), 'utf8')
    logForDebugging(`[bridge:pointer] wrote ${path}`)
  } catch (err: unknown) {
    logForDebugging(`[bridge:pointer] write failed: ${err}`, { level: 'warn' })
  }
}

/**
 * 读取 Bridge 指针及其文件年龄（自最后写入的毫秒数）。
 *
 * 直接操作，不做存在性预检（遵循 CLAUDE.md TOCTOU 规则）。
 * 任何失败情况均返回 null：文件不存在、JSON 损坏、模式不匹配、过期（>4h）。
 * 过期或无效指针在返回 null 前会被自动删除，
 * 防止后端已 GC 该环境后还反复提示用户恢复。
 *
 * Read the pointer and its age (ms since last write). Operates directly
 * and handles errors — no existence check (CLAUDE.md TOCTOU rule). Returns
 * null on any failure: missing file, corrupted JSON, schema mismatch, or
 * stale (mtime > 4h ago). Stale/invalid pointers are deleted so they don't
 * keep re-prompting after the backend has already GC'd the env.
 */
export async function readBridgePointer(
  dir: string,
): Promise<(BridgePointer & { ageMs: number }) | null> {
  const path = getBridgePointerPath(dir)
  let raw: string
  let mtimeMs: number
  try {
    // stat for mtime (staleness anchor), then read. Two syscalls, but both
    // are needed — mtime IS the data we return, not a TOCTOU guard.
    // 先 stat 获取 mtime（新鲜度基准），再 read 内容；两次系统调用均必要
    mtimeMs = (await stat(path)).mtimeMs
    raw = await readFile(path, 'utf8')
  } catch {
    return null // 文件不存在或读取失败
  }

  const parsed = BridgePointerSchema().safeParse(safeJsonParse(raw))
  if (!parsed.success) {
    logForDebugging(`[bridge:pointer] invalid schema, clearing: ${path}`)
    await clearBridgePointer(dir) // 模式验证失败，删除损坏的文件
    return null
  }

  const ageMs = Math.max(0, Date.now() - mtimeMs)
  if (ageMs > BRIDGE_POINTER_TTL_MS) {
    logForDebugging(`[bridge:pointer] stale (>4h mtime), clearing: ${path}`)
    await clearBridgePointer(dir) // 指针已过期（>4h），自动清除
    return null
  }

  return { ...parsed.data, ageMs }
}

/**
 * 跨 git 工作树查找最新的 Bridge 恢复指针（用于 --continue 选项）。
 *
 * 背景：REPL Bridge 将指针写入 getOriginalCwd()，但工作树切换操作
 * (EnterWorktreeTool/activeWorktreeSession) 可能改变 cwd，
 * 而 `claude remote-control --continue` 使用 resolve('.') = shell 的 CWD。
 * 为与 /resume 语义保持一致，本函数扫描所有 git 工作树兄弟目录。
 *
 * 快速路径：先检查 dir 本身（最常见情况：一次 stat，零次 exec）；
 * 仅当未找到时才调用 git worktree list（慢路径）。
 * 并行读取候选目录，最多 MAX_WORKTREE_FANOUT 个。
 *
 * 返回指针及其所在目录（供恢复失败时清除正确的文件）。
 *
 * Worktree-aware read for `--continue`. The REPL bridge writes its pointer
 * to `getOriginalCwd()` which EnterWorktreeTool/activeWorktreeSession can
 * mutate to a worktree path — but `claude remote-control --continue` runs
 * with `resolve('.')` = shell CWD. This fans out across git worktree
 * siblings to find the freshest pointer, matching /resume's semantics.
 */
export async function readBridgePointerAcrossWorktrees(
  dir: string,
): Promise<{ pointer: BridgePointer & { ageMs: number }; dir: string } | null> {
  // Fast path: current dir. Covers standalone bridge (always matches) and
  // REPL bridge when no worktree mutation happened.
  // 快速路径：先检查当前目录（独立模式始终命中，REPL 模式未发生工作树切换时也命中）
  const here = await readBridgePointer(dir)
  if (here) {
    return { pointer: here, dir }
  }

  // Fanout: scan worktree siblings. getWorktreePathsPortable has a 5s
  // timeout and returns [] on any error (not a git repo, git not installed).
  // 扇出：扫描工作树兄弟目录；getWorktreePathsPortable 有 5s 超时，出错返回 []
  const worktrees = await getWorktreePathsPortable(dir)
  if (worktrees.length <= 1) return null // 无其他工作树
  if (worktrees.length > MAX_WORKTREE_FANOUT) {
    logForDebugging(
      `[bridge:pointer] ${worktrees.length} worktrees exceeds fanout cap ${MAX_WORKTREE_FANOUT}, skipping`,
    )
    return null
  }

  // Dedupe against `dir` so we don't re-stat it. sanitizePath normalizes
  // case/separators so worktree-list output matches our fast-path key even
  // on Windows where git may emit C:/ vs stored c:/.
  // 去重：排除已在快速路径检查过的 dir，sanitizePath 规范化大小写和路径分隔符
  const dirKey = sanitizePath(dir)
  const candidates = worktrees.filter(wt => sanitizePath(wt) !== dirKey)

  // Parallel stat+read. Each readBridgePointer is a stat() that ENOENTs
  // for worktrees with no pointer (cheap) plus a ~100-byte read for the
  // rare ones that have one. Promise.all → latency ≈ slowest single stat.
  // 并行读取：ENOENT 的 stat 开销极低；Promise.all → 延迟 ≈ 最慢的单个 stat
  const results = await Promise.all(
    candidates.map(async wt => {
      const p = await readBridgePointer(wt)
      return p ? { pointer: p, dir: wt } : null
    }),
  )

  // Pick freshest (lowest ageMs). The pointer stores environmentId so
  // resume reconnects to the right env regardless of which worktree
  // --continue was invoked from.
  // 选取最新（ageMs 最小）的指针；environmentId 确保恢复时连接到正确的环境
  let freshest: {
    pointer: BridgePointer & { ageMs: number }
    dir: string
  } | null = null
  for (const r of results) {
    if (r && (!freshest || r.pointer.ageMs < freshest.pointer.ageMs)) {
      freshest = r
    }
  }
  if (freshest) {
    logForDebugging(
      `[bridge:pointer] fanout found pointer in worktree ${freshest.dir} (ageMs=${freshest.pointer.ageMs})`,
    )
  }
  return freshest
}

/**
 * 删除 Bridge 指针文件（幂等操作）。
 *
 * 正常关闭时调用，ENOENT 错误被静默忽略（之前已正常关闭过则不存在该文件）。
 *
 * Delete the pointer. Idempotent — ENOENT is expected when the process
 * shut down clean previously.
 */
export async function clearBridgePointer(dir: string): Promise<void> {
  const path = getBridgePointerPath(dir)
  try {
    await unlink(path)
    logForDebugging(`[bridge:pointer] cleared ${path}`)
  } catch (err: unknown) {
    if (!isENOENT(err)) {
      // 非预期错误（ENOENT 是正常的，其他错误才需要记录）
      logForDebugging(`[bridge:pointer] clear failed: ${err}`, {
        level: 'warn',
      })
    }
  }
}

/**
 * 安全解析 JSON 字符串，解析失败时返回 null（避免抛出异常）。
 * 用于读取可能损坏的 bridge-pointer.json 文件。
 */
function safeJsonParse(raw: string): unknown {
  try {
    return jsonParse(raw)
  } catch {
    return null // JSON 损坏，返回 null 供调用方处理
  }
}
