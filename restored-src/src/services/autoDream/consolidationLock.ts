/**
 * AutoDream 整合锁文件管理模块
 *
 * 在 Claude Code 系统流程中的位置：
 *   autoDream.ts 执行门控检查时 → readLastConsolidatedAt() 读取上次整合时间
 *   → 通过时间门后 → tryAcquireConsolidationLock() 尝试获取互斥锁
 *   → 整合成功后锁文件 mtime 保持为"现在"（记录整合时间）
 *   → 整合失败后 → rollbackConsolidationLock() 回退 mtime 至整合前
 *   → 手动 /dream 命令执行后 → recordConsolidation() 更新整合时间戳
 *
 * 主要功能：
 *  - readLastConsolidatedAt   — 读取锁文件 mtime 作为上次整合时间（0 表示从未整合）
 *  - tryAcquireConsolidationLock — 尝试获取互斥锁；返回 priorMtime 或 null（已被占用）
 *  - rollbackConsolidationLock   — 整合失败时回滚 mtime 至整合前状态
 *  - listSessionsTouchedSince    — 列出指定时间后修改过的会话 ID
 *  - recordConsolidation         — 手动 /dream 后记录整合时间戳（乐观记录）
 *
 * 锁文件设计（.consolidate-lock）：
 *  - 文件内容 = 持有者 PID（用于死进程检测）
 *  - 文件 mtime = lastConsolidatedAt（整合时间戳的唯一来源）
 *  - 存放在 getAutoMemPath() 目录下（与记忆文件同目录，确保可写）
 *  - HOLDER_STALE_MS=1小时：即使持有者 PID 存活，超时后也视为过期（防 PID 复用）
 *
 * 锁获取的竞争处理（double-check）：
 *  - 两个进程都写入 PID 后，重新读取文件内容确认自己的 PID 仍在
 *  - 最后写入者的 PID 保留，先写入的进程退出（last-write-wins 语义）
 */

// Lock file whose mtime IS lastConsolidatedAt. Body is the holder's PID.
//
// Lives inside the memory dir (getAutoMemPath) so it keys on git-root
// like memory does, and so it's writable even when the memory path comes
// from an env/settings override whose parent may not be.

import { mkdir, readFile, stat, unlink, utimes, writeFile } from 'fs/promises'
import { join } from 'path'
import { getOriginalCwd } from '../../bootstrap/state.js'
import { getAutoMemPath } from '../../memdir/paths.js'
import { logForDebugging } from '../../utils/debug.js'
import { isProcessRunning } from '../../utils/genericProcessUtils.js'
import { listCandidates } from '../../utils/listSessionsImpl.js'
import { getProjectDir } from '../../utils/sessionStorage.js'

const LOCK_FILE = '.consolidate-lock' // 锁文件名（隐藏文件，位于记忆目录根部）

// 即使持有者 PID 存活，超过此时长也视为过期（防止 PID 复用导致误判）
const HOLDER_STALE_MS = 60 * 60 * 1000 // 1 小时

/** 返回锁文件的完整路径（依赖 getAutoMemPath 的运行时值） */
function lockPath(): string {
  return join(getAutoMemPath(), LOCK_FILE)
}

/**
 * 读取上次整合时间（锁文件的 mtime）。
 *
 * 设计：锁文件的 mtime 即为 lastConsolidatedAt，不单独存储整合时间。
 * 成功整合后锁文件 mtime = 整合完成时间；文件不存在时返回 0（表示从未整合）。
 * 每轮调用开销：一次 fs.stat。
 *
 * @returns 上次整合的 Unix 毫秒时间戳；文件不存在时返回 0
 */
export async function readLastConsolidatedAt(): Promise<number> {
  try {
    const s = await stat(lockPath())
    return s.mtimeMs // mtime 即为整合时间戳
  } catch {
    return 0 // 文件不存在（ENOENT）：从未整合过
  }
}

/**
 * 尝试获取整合互斥锁。
 *
 * 流程：
 *  1. 读取当前锁文件的 mtime（priorMtime）和 PID 内容
 *  2. 检查是否被活跃进程持有（mtime 新鲜 + PID 存活）→ 返回 null
 *  3. 死 PID 或文件不存在 → 创建/覆盖文件，写入当前 PID
 *  4. Double-check：重读文件确认 PID 是自己的（处理并发竞争）
 *  5. 成功 → 返回 priorMtime（用于失败时回滚）
 *
 * 返回值语义：
 *  - number：成功获取锁，值为整合前的时间戳（失败时回滚到此值）
 *  - null：锁被其他进程持有（或竞争失败），应跳过本次整合
 *
 * 成功后的状态：锁文件存在，内容为本进程 PID，mtime = 获取锁的时间
 * 失败后的回滚：rollbackConsolidationLock(priorMtime) 恢复 mtime
 * 崩溃后的恢复：mtime 停止推进，PID 死亡 → 下个进程自动接管
 */
export async function tryAcquireConsolidationLock(): Promise<number | null> {
  const path = lockPath()

  let mtimeMs: number | undefined
  let holderPid: number | undefined
  try {
    // 并行读取文件元数据和内容（减少文件系统调用次数）
    const [s, raw] = await Promise.all([stat(path), readFile(path, 'utf8')])
    mtimeMs = s.mtimeMs
    const parsed = parseInt(raw.trim(), 10)
    holderPid = Number.isFinite(parsed) ? parsed : undefined
  } catch {
    // ENOENT：文件不存在，直接跳过到创建步骤
  }

  // 检查是否被活跃进程持有：mtime 在新鲜期内 AND 持有者进程存活
  if (mtimeMs !== undefined && Date.now() - mtimeMs < HOLDER_STALE_MS) {
    if (holderPid !== undefined && isProcessRunning(holderPid)) {
      logForDebugging(
        `[autoDream] lock held by live PID ${holderPid} (mtime ${Math.round((Date.now() - mtimeMs) / 1000)}s ago)`,
      )
      return null // 锁被活跃进程持有，放弃本次竞争
    }
    // PID 已死或无法解析 → 锁过期，可以接管
  }

  // 确保记忆目录存在（首次运行时可能尚未创建）
  await mkdir(getAutoMemPath(), { recursive: true })
  await writeFile(path, String(process.pid)) // 写入本进程 PID

  // Double-check：处理两个进程同时到达这里的竞争情况
  // 两者都写入 → 最后写入者的 PID 保留；先写入者在此处检测失败，退出
  let verify: string
  try {
    verify = await readFile(path, 'utf8')
  } catch {
    return null // 读取失败（极低概率），放弃
  }
  if (parseInt(verify.trim(), 10) !== process.pid) return null // 竞争失败：PID 被后来者覆盖

  return mtimeMs ?? 0 // 返回整合前的时间戳（文件不存在时为 0）
}

/**
 * 回滚整合锁至整合前状态（整合失败时调用）。
 *
 * 回滚策略：
 *  - priorMtime === 0（文件原本不存在）→ 删除文件，恢复"从未整合"状态
 *  - priorMtime > 0 → 清空文件内容（避免死进程误判）并用 utimes 恢复 mtime
 *
 * 注意：清空内容而非写入空字符串是为了确保下次读取时 PID 解析为 NaN，
 * 避免本进程（仍在运行）被 isProcessRunning 误判为持有者。
 */
export async function rollbackConsolidationLock(
  priorMtime: number,
): Promise<void> {
  const path = lockPath()
  try {
    if (priorMtime === 0) {
      // 文件原本不存在 → 删除恢复原始状态
      await unlink(path)
      return
    }
    await writeFile(path, '') // 清空 PID 内容（本进程仍存活，防止被 isProcessRunning 误判）
    const t = priorMtime / 1000 // utimes 接受秒为单位
    await utimes(path, t, t)   // 恢复 atime 和 mtime 为整合前的值
  } catch (e: unknown) {
    logForDebugging(
      `[autoDream] rollback failed: ${(e as Error).message} — next trigger delayed to minHours`,
    )
  }
}

/**
 * 列出指定时间后有修改的会话 ID。
 *
 * 使用 mtime（文件最后修改时间）而非 birthtime（在 ext4 等文件系统上为 0）。
 * listCandidates 会校验 UUID 格式（排除 agent-*.jsonl 等非会话文件）并并行 stat。
 * 调用方负责排除当前会话（当前会话 mtime 始终是最近的）。
 * 仅扫描当前工作目录的会话记录——这是"跳过门"逻辑，低估 worktree 会话数是安全的。
 *
 * @param sinceMs - Unix 毫秒时间戳，只返回 mtime > sinceMs 的会话
 * @returns 满足条件的会话 ID 列表
 */
export async function listSessionsTouchedSince(
  sinceMs: number,
): Promise<string[]> {
  const dir = getProjectDir(getOriginalCwd())
  const candidates = await listCandidates(dir, true)
  return candidates.filter(c => c.mtime > sinceMs).map(c => c.sessionId)
}

/**
 * 记录手动 /dream 命令的整合时间戳（乐观记录）。
 *
 * 在提示词构建时调用（fire-and-forget），不等待 /dream 技能执行完毕。
 * 写入当前 PID 作为文件内容，mtime 自动更新为当前时间。
 * 若记忆目录尚不存在（手动 /dream 早于任何自动触发），先创建目录。
 */
export async function recordConsolidation(): Promise<void> {
  try {
    // 记忆目录可能尚未创建（手动 /dream 早于任何自动触发时）
    await mkdir(getAutoMemPath(), { recursive: true })
    await writeFile(lockPath(), String(process.pid)) // mtime 自动更新为当前时间
  } catch (e: unknown) {
    logForDebugging(
      `[autoDream] recordConsolidation write failed: ${(e as Error).message}`,
    )
  }
}
