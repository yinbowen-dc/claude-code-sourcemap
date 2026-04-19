/**
 * Computer Use 会话文件锁模块。
 *
 * 在 Claude Code 系统中，该模块通过 O_EXCL 原子创建 ~/.claude/computer-use.lock
 * 文件来保证同一时刻只有一个 Computer Use 会话处于活跃状态：
 * - tryAcquireComputerUseLock()：尝试获取锁，返回 AcquireResult（成功/已被本地持有/被其他进程占用）
 * - checkComputerUseLock()：检查锁状态，返回 CheckResult（空闲/本地持有/远程占用）
 * - isLockHeldLocally()：判断当前进程是否持有锁
 * - releaseComputerUseLock()：释放锁并删除锁文件
 */
import { mkdir, readFile, unlink, writeFile } from 'fs/promises'
import { join } from 'path'
import { getSessionId } from '../../bootstrap/state.js'
import { registerCleanup } from '../../utils/cleanupRegistry.js'
import { logForDebugging } from '../../utils/debug.js'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import { jsonParse, jsonStringify } from '../../utils/slowOperations.js'
import { getErrnoCode } from '../errors.js'

const LOCK_FILENAME = 'computer-use.lock'

// 持有关闭清理处理器的注销函数。
// 获取锁时设置，释放锁时清除。
let unregisterCleanup: (() => void) | undefined

type ComputerUseLock = {
  readonly sessionId: string
  readonly pid: number
  readonly acquiredAt: number
}

export type AcquireResult =
  | { readonly kind: 'acquired'; readonly fresh: boolean }
  | { readonly kind: 'blocked'; readonly by: string }

export type CheckResult =
  | { readonly kind: 'free' }
  | { readonly kind: 'held_by_self' }
  | { readonly kind: 'blocked'; readonly by: string }

const FRESH: AcquireResult = { kind: 'acquired', fresh: true }
const REENTRANT: AcquireResult = { kind: 'acquired', fresh: false }

function isComputerUseLock(value: unknown): value is ComputerUseLock {
  if (typeof value !== 'object' || value === null) return false
  return (
    'sessionId' in value &&
    typeof value.sessionId === 'string' &&
    'pid' in value &&
    typeof value.pid === 'number'
  )
}

function getLockPath(): string {
  return join(getClaudeConfigHomeDir(), LOCK_FILENAME)
}

async function readLock(): Promise<ComputerUseLock | undefined> {
  try {
    const raw = await readFile(getLockPath(), 'utf8')
    const parsed: unknown = jsonParse(raw)
    return isComputerUseLock(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * 检查进程是否仍在运行（发送信号 0 探测）。
 *
 * 注意：PID 复用存在极短的竞争窗口 —— 若持锁进程退出后，
 * 另一个不相关的进程恰好被分配了相同的 PID，此检查会返回 true。
 * 实际中极为罕见。
 */
function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * 以 O_EXCL 标志原子创建锁文件。
 * 成功返回 true，文件已存在返回 false。
 * 其他错误则抛出。
 */
async function tryCreateExclusive(lock: ComputerUseLock): Promise<boolean> {
  try {
    await writeFile(getLockPath(), jsonStringify(lock), { flag: 'wx' })
    return true
  } catch (e: unknown) {
    if (getErrnoCode(e) === 'EEXIST') return false
    throw e
  }
}

/**
 * 注册关机清理处理器，确保即使未到达轮次结束清理（如用户在工具调用
 * 进行中执行 /exit），锁也会被释放。
 */
function registerLockCleanup(): void {
  unregisterCleanup?.()
  unregisterCleanup = registerCleanup(async () => {
    await releaseComputerUseLock()
  })
}

/**
 * 不获取锁，仅检查锁状态。用于 `request_access` /
 * `list_granted_applications` —— 包的 `defersLockAcquire` 契约：
 * 这些工具只检查不持有锁，因此仅在询问权限时不会触发进入通知和覆盖层。
 *
 * 执行过期 PID 恢复（unlink），防止已终止 session 的锁阻塞 `request_access`。
 * 不创建锁 —— 那是 `tryAcquireComputerUseLock` 的职责。
 */
export async function checkComputerUseLock(): Promise<CheckResult> {
  const existing = await readLock()
  if (!existing) return { kind: 'free' }
  if (existing.sessionId === getSessionId()) return { kind: 'held_by_self' }
  if (isProcessRunning(existing.pid)) {
    return { kind: 'blocked', by: existing.sessionId }
  }
  logForDebugging(
    `Recovering stale computer-use lock from session ${existing.sessionId} (PID ${existing.pid})`,
  )
  await unlink(getLockPath()).catch(() => {})
  return { kind: 'free' }
}

/**
 * 零系统调用检查：当前进程是否认为自己持有锁？
 * 当且仅当 `tryAcquireComputerUseLock` 已成功且 `releaseComputerUseLock`
 * 尚未执行时返回 true。用于控制 `cleanup.ts` 中每轮次的释放操作，
 * 避免非 CU 轮次接触磁盘。
 */
export function isLockHeldLocally(): boolean {
  return unregisterCleanup !== undefined
}

/**
 * 尝试为当前 session 获取 computer-use 锁。
 *
 * `{kind: 'acquired', fresh: true}` —— CU 轮次的首次工具调用，调用方在此触发进入通知。
 * `{kind: 'acquired', fresh: false}` —— 可重入，当前 session 已持有锁。
 * `{kind: 'blocked', by}` —— 另一个活跃 session 持有锁。
 *
 * 使用 O_EXCL（open 'wx'）进行原子测试并设置 —— 操作系统保证最多一个进程看到创建成功。
 * 若文件已存在，检查所有权和 PID 活跃性；对过期锁执行 unlink 后重试一次独占创建。
 * 若两个 session 同时尝试恢复同一个过期锁，只有一个创建成功（另一个读取胜者结果）。
 */
export async function tryAcquireComputerUseLock(): Promise<AcquireResult> {
  const sessionId = getSessionId()
  const lock: ComputerUseLock = {
    sessionId,
    pid: process.pid,
    acquiredAt: Date.now(),
  }

  await mkdir(getClaudeConfigHomeDir(), { recursive: true })

  // 首次获取。
  if (await tryCreateExclusive(lock)) {
    registerLockCleanup()
    return FRESH
  }

  const existing = await readLock()

  // 内容损坏/无法解析 —— 视为过期（无法提取阻塞 ID）。
  if (!existing) {
    await unlink(getLockPath()).catch(() => {})
    if (await tryCreateExclusive(lock)) {
      registerLockCleanup()
      return FRESH
    }
    return { kind: 'blocked', by: (await readLock())?.sessionId ?? 'unknown' }
  }

  // 已由当前会话持有。
  if (existing.sessionId === sessionId) return REENTRANT

  // 另一个活跃会话持有锁 —— 被阻塞。
  if (isProcessRunning(existing.pid)) {
    return { kind: 'blocked', by: existing.sessionId }
  }

  // 过期锁 —— 执行恢复。删除后重试独占创建。
  // 若另一会话也在恢复，某一方会遇到 EEXIST 并读取胜者的信息。
  logForDebugging(
    `Recovering stale computer-use lock from session ${existing.sessionId} (PID ${existing.pid})`,
  )
  await unlink(getLockPath()).catch(() => {})
  if (await tryCreateExclusive(lock)) {
    registerLockCleanup()
    return FRESH
  }
  return { kind: 'blocked', by: (await readLock())?.sessionId ?? 'unknown' }
}

/**
 * 若当前会话持有 computer-use 锁则释放。
 * 若实际删除了文件（即我们持有锁）则返回 `true` —— 调用方在此触发退出通知。
 * 幂等：后续调用返回 `false`。
 */
export async function releaseComputerUseLock(): Promise<boolean> {
  unregisterCleanup?.()
  unregisterCleanup = undefined

  const existing = await readLock()
  if (!existing || existing.sessionId !== getSessionId()) return false
  try {
    await unlink(getLockPath())
    logForDebugging('Released computer-use lock')
    return true
  } catch {
    return false
  }
}
