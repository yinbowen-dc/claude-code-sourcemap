/**
 * 【文件定位】PID 进程生命周期锁模块 — Claude Code 自更新系统的版本并发保护层
 *
 * 在 Claude Code 的系统架构中，本文件处于\"版本并发安全\"环节：
 *   installer.ts（清理旧版本）→ [本模块：检查版本是否仍被进程占用] → 决定是否删除
 *
 * 主要职责：
 *   1. 通过 JSON 锁文件（记录 PID、版本、execPath、时间戳）标记正在运行的版本
 *   2. 使用 process.kill(pid, 0) 检测进程是否存活，代替旧的 mtime（30 天超时）机制
 *   3. 提供 tryAcquireLock（非阻塞尝试）/ withLock（RAII 模式）/ acquireProcessLifetimeLock（进程级持久锁）三种锁获取方式
 *   4. 通过 isClaudeProcess() 验证 PID 归属，防止 PID 复用导致误判
 *   5. 提供 cleanupStaleLocks() 清理失效锁（进程已退出 或 锁超过 2 小时兜底超时）
 *   6. 通过 GrowthBook gate（tengu_pid_based_version_locking）控制灰度开启
 *
 * 与旧机制对比：
 *   旧机制（proper-lockfile mtime 方式）：崩溃后锁可能持续 30 天，导致旧版本无法清理
 *   新机制（PID 方式）：进程退出后锁立即失效，兜底超时仅 2 小时
 */

import { basename, join } from 'path'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import { logForDebugging } from '../debug.js'
import { isEnvDefinedFalsy, isEnvTruthy } from '../envUtils.js'
import { isENOENT, toError } from '../errors.js'
import { getFsImplementation } from '../fsOperations.js'
import { getProcessCommand } from '../genericProcessUtils.js'
import { logError } from '../log.js'
import {
  jsonParse,
  jsonStringify,
  writeFileSync_DEPRECATED,
} from '../slowOperations.js'

/**
 * 判断 PID 进程生命周期锁机制是否已启用。
 *
 * 优先级（由高到低）：
 *   1. 环境变量 ENABLE_PID_BASED_VERSION_LOCKING=true → 强制启用
 *   2. 环境变量 ENABLE_PID_BASED_VERSION_LOCKING=false → 强制禁用
 *   3. GrowthBook gate（tengu_pid_based_version_locking）控制灰度 → 按返回值决定
 *
 * 未设置环境变量时，由 GrowthBook 控制渐进式推出（外部用户默认为 false）。
 *
 * @returns 是否启用 PID 锁机制
 */
export function isPidBasedLockingEnabled(): boolean {
  const envVar = process.env.ENABLE_PID_BASED_VERSION_LOCKING
  // 环境变量显式设置为 true，优先级最高
  if (isEnvTruthy(envVar)) {
    return true
  }
  // 环境变量显式设置为 false，强制禁用
  if (isEnvDefinedFalsy(envVar)) {
    return false
  }
  // 未设置环境变量，由 GrowthBook 控制灰度开启（外部用户默认 false）
  return getFeatureValue_CACHED_MAY_BE_STALE(
    'tengu_pid_based_version_locking',
    false,
  )
}

/**
 * PID 锁文件中存储的内容结构
 * 锁文件以 JSON 格式存储，包含足够信息用于存活性检测和 PID 复用防护
 */
export type VersionLockContent = {
  pid: number        // 持有锁的进程 ID
  version: string    // 被锁定的 Claude Code 版本号
  execPath: string   // 进程的可执行文件路径（用于 PID 复用验证）
  acquiredAt: number // 获取锁的时间戳（毫秒，用于兜底超时判断）
}

/**
 * 用于诊断目的的锁信息结构（包含计算后的衍生字段）
 */
export type LockInfo = {
  version: string           // 被锁定的版本
  pid: number               // 持有锁的进程 ID
  isProcessRunning: boolean // 该进程当前是否存活
  execPath: string          // 进程可执行文件路径
  acquiredAt: Date          // 获取锁的时间（Date 对象）
  lockFilePath: string      // 锁文件的完整路径
}

// 兜底超时（2 小时）：适用于 PID 检查无法确认（如网络文件系统）的情况
// 相比旧机制的 30 天超时大幅缩短，覆盖大多数异常场景
const FALLBACK_STALE_MS = 2 * 60 * 60 * 1000

/**
 * 检测指定 PID 的进程是否仍在运行。
 *
 * 原理：向进程发送信号 0（不实际发送信号，仅检查进程是否可被信号到达）。
 *   - process.kill(pid, 0) 成功 → 进程存在且可接收信号 → 返回 true
 *   - 抛出异常（ESRCH：进程不存在，EPERM：无权限）→ 返回 false
 *
 * 特殊 PID 处理：
 *   - PID ≤ 1：PID 0 指代当前进程组，PID 1 是 init，均不作为有效锁持有者
 *
 * @param pid - 要检查的进程 ID
 * @returns 进程存活返回 true，否则 false
 */
export function isProcessRunning(pid: number): boolean {
  // PID 0 指代当前进程组（非真实进程），PID 1 是 init/systemd（始终运行但不持有锁）
  if (pid <= 1) {
    return false
  }

  try {
    // 发送信号 0 进行存活检查（不影响目标进程运行）
    process.kill(pid, 0)
    return true
  } catch {
    // ESRCH（进程不存在）或 EPERM（无权限）均视为进程不存在
    return false
  }
}

/**
 * 验证运行中的进程是否确实是 Claude Code 进程（防止 PID 复用误判）。
 *
 * 流程：
 *   1. 先通过 isProcessRunning 确认进程存活
 *   2. 若 PID 等于当前进程（pid === process.pid）直接认为有效（测试环境兼容）
 *   3. 获取目标进程的命令名称，检查是否包含 'claude' 或 execPath
 *   4. 命令获取失败时保守处理（不删除可能正在运行的版本）
 *
 * @param pid - 要验证的进程 ID
 * @param expectedExecPath - 锁文件中记录的 execPath（用于路径匹配）
 * @returns 确认是 Claude 进程返回 true，否则 false
 */
function isClaudeProcess(pid: number, expectedExecPath: string): boolean {
  if (!isProcessRunning(pid)) {
    return false
  }

  // 如果 PID 就是当前进程，一定有效（涵盖测试环境中命令可能不含 'claude' 的情况）
  if (pid === process.pid) {
    return true
  }

  try {
    const command = getProcessCommand(pid)
    if (!command) {
      // 无法获取命令时，保守处理：宁可认为是有效锁，也不误删正在运行的版本
      return true
    }

    // 大小写不敏感匹配 'claude' 关键字或 execPath 字符串
    const normalizedCommand = command.toLowerCase()
    const normalizedExecPath = expectedExecPath.toLowerCase()

    return (
      normalizedCommand.includes('claude') ||
      normalizedCommand.includes(normalizedExecPath)
    )
  } catch {
    // 命令检查失败时同样保守处理
    return true
  }
}

/**
 * 读取并解析锁文件内容（JSON 格式）。
 *
 * 流程：
 *   1. 同步读取锁文件内容
 *   2. 检查内容非空
 *   3. JSON 解析
 *   4. 校验必要字段（pid 为数字、version 和 execPath 非空）
 *   5. 任何异常均返回 null（文件不存在、解析失败、字段缺失）
 *
 * @param lockFilePath - 锁文件路径
 * @returns 锁内容对象，或 null（文件无效时）
 */
export function readLockContent(
  lockFilePath: string,
): VersionLockContent | null {
  const fs = getFsImplementation()

  try {
    const content = fs.readFileSync(lockFilePath, { encoding: 'utf8' })
    // 空文件不是有效锁
    if (!content || content.trim() === '') {
      return null
    }

    const parsed = jsonParse(content) as VersionLockContent

    // 校验关键字段，防止读取到损坏的锁文件
    if (typeof parsed.pid !== 'number' || !parsed.version || !parsed.execPath) {
      return null
    }

    return parsed
  } catch {
    // ENOENT、JSON 解析错误等均返回 null
    return null
  }
}

/**
 * 判断锁文件代表的锁是否仍然有效（进程仍在运行且确实是 Claude 进程）。
 *
 * 判断流程（三层验证）：
 *   1. 读取锁内容，内容无效 → false
 *   2. PID 存活检查（process.kill 0）→ 不存活则 false
 *   3. Claude 进程验证（防 PID 复用）→ 不是 Claude 进程则 false
 *   4. 兜底超时检查：若锁超过 2 小时且 PID 再次确认不存活 → false
 *
 * @param lockFilePath - 锁文件路径
 * @returns 锁仍然有效返回 true
 */
export function isLockActive(lockFilePath: string): boolean {
  const content = readLockContent(lockFilePath)

  // 锁内容无效（文件损坏、不存在等）→ 视为未上锁
  if (!content) {
    return false
  }

  const { pid, execPath } = content

  // 主检查：进程是否存活
  if (!isProcessRunning(pid)) {
    return false
  }

  // 辅助验证：是否真的是 Claude 进程（防止 PID 复用导致误判为有效锁）
  if (!isClaudeProcess(pid, execPath)) {
    logForDebugging(
      `Lock PID ${pid} is running but does not appear to be Claude - treating as stale`,
    )
    return false
  }

  // 兜底检查：若锁存在超过 2 小时，重新验证进程存活性
  // 主要覆盖网络文件系统等 PID 检查可能失效的边缘场景
  const fs = getFsImplementation()
  try {
    const stats = fs.statSync(lockFilePath)
    const age = Date.now() - stats.mtimeMs
    if (age > FALLBACK_STALE_MS) {
      // 超时后再次确认进程存活
      if (!isProcessRunning(pid)) {
        return false
      }
    }
  } catch {
    // 无法 stat 文件时，信任之前的 PID 检查结果
  }

  return true
}

/**
 * 原子写入锁文件（先写临时文件，再 rename 到目标路径）。
 *
 * 原子性保证：
 *   通过「写临时文件 → rename」两步操作确保锁文件要么完全写入，要么不存在，
 *   避免多个进程同时写入时产生损坏的部分内容文件。
 *
 * @param lockFilePath - 目标锁文件路径
 * @param content - 要写入的锁内容
 */
function writeLockFile(
  lockFilePath: string,
  content: VersionLockContent,
): void {
  const fs = getFsImplementation()
  // 临时文件名包含 PID 和时间戳，保证跨进程唯一性
  const tempPath = `${lockFilePath}.tmp.${process.pid}.${Date.now()}`

  try {
    // 先写临时文件（flush 确保内容落盘）
    writeFileSync_DEPRECATED(tempPath, jsonStringify(content, null, 2), {
      encoding: 'utf8',
      flush: true,
    })
    // 原子 rename：在大多数文件系统上是原子操作
    fs.renameSync(tempPath, lockFilePath)
  } catch (error) {
    // 写入失败时尽力清理临时文件（ENOENT 是预期的，不报错）
    try {
      fs.unlinkSync(tempPath)
    } catch {
      // 忽略清理错误
    }
    throw error
  }
}

/**
 * 非阻塞尝试获取指定版本的锁（带竞争条件检测）。
 *
 * 流程：
 *   1. 检查是否已有活跃锁（包括自身进程）→ 已有则返回 null（获取失败）
 *   2. 写入包含当前进程信息的锁文件（原子写）
 *   3. 重新读取锁文件，验证 PID 是否仍然是自己（检测写后竞争）
 *   4. 成功则返回释放函数；释放时检查 PID 归属，防止释放他人的锁
 *
 * @param versionPath - 被锁定的版本目录路径
 * @param lockFilePath - 锁文件路径
 * @returns 成功时返回释放函数（调用即释放），失败时返回 null
 */
export async function tryAcquireLock(
  versionPath: string,
  lockFilePath: string,
): Promise<(() => void) | null> {
  const fs = getFsImplementation()
  const versionName = basename(versionPath)

  // 检查是否已存在活跃锁（如果是自己也不允许重复获取，保持一致性）
  if (isLockActive(lockFilePath)) {
    const existingContent = readLockContent(lockFilePath)
    logForDebugging(
      `Cannot acquire lock for ${versionName} - held by PID ${existingContent?.pid}`,
    )
    return null
  }

  // 构造要写入锁文件的内容（包含当前进程信息）
  const lockContent: VersionLockContent = {
    pid: process.pid,
    version: versionName,
    execPath: process.execPath,
    acquiredAt: Date.now(),
  }

  try {
    // 原子写入锁文件
    writeLockFile(lockFilePath, lockContent)

    // 写入后再次读取，验证是否存在并发写入导致的竞争（check-write-recheck 模式）
    const verifyContent = readLockContent(lockFilePath)
    if (verifyContent?.pid !== process.pid) {
      // 另一个进程在我们写入前后赢得了竞争
      return null
    }

    logForDebugging(`Acquired PID lock for ${versionName} (PID ${process.pid})`)

    // 返回释放函数（调用者负责在适当时机调用）
    return () => {
      try {
        // 只有当锁文件中记录的 PID 仍然是自己时才释放
        // 防止在异常情况下释放其他进程持有的锁
        const currentContent = readLockContent(lockFilePath)
        if (currentContent?.pid === process.pid) {
          fs.unlinkSync(lockFilePath)
          logForDebugging(`Released PID lock for ${versionName}`)
        }
      } catch (error) {
        logForDebugging(`Failed to release lock for ${versionName}: ${error}`)
      }
    }
  } catch (error) {
    logForDebugging(`Failed to acquire lock for ${versionName}: ${error}`)
    return null
  }
}

/**
 * 获取进程生命周期级别的持久锁（进程退出时自动释放）。
 *
 * 适用场景：锁定当前正在运行的 Claude Code 版本，防止 cleanupOldVersions 误删。
 *
 * 流程：
 *   1. 调用 tryAcquireLock 尝试获取锁
 *   2. 注册 exit/SIGINT/SIGTERM 事件，确保进程退出时自动调用 release()
 *   3. 不主动调用 release()，锁持续到进程退出
 *
 * @param versionPath - 被锁定的版本目录路径
 * @param lockFilePath - 锁文件路径
 * @returns 成功获取锁返回 true，失败（已被占用）返回 false
 */
export async function acquireProcessLifetimeLock(
  versionPath: string,
  lockFilePath: string,
): Promise<boolean> {
  const release = await tryAcquireLock(versionPath, lockFilePath)

  if (!release) {
    return false
  }

  // 注册进程退出清理处理器，确保锁在所有退出路径上被释放
  const cleanup = () => {
    try {
      release()
    } catch {
      // 进程退出阶段忽略清理错误
    }
  }

  process.on('exit', cleanup)   // 正常退出
  process.on('SIGINT', cleanup)  // Ctrl+C
  process.on('SIGTERM', cleanup) // kill 命令

  // 不调用 release()，让锁一直持续到进程退出
  return true
}

/**
 * RAII 模式：在持有锁的状态下执行回调，结束后自动释放锁。
 *
 * 无论回调成功还是抛出异常，finally 块都会确保锁被释放。
 *
 * @param versionPath - 被锁定的版本目录路径
 * @param lockFilePath - 锁文件路径
 * @param callback - 在锁保护下执行的回调函数（支持 async）
 * @returns 成功执行回调返回 true，锁获取失败返回 false
 */
export async function withLock(
  versionPath: string,
  lockFilePath: string,
  callback: () => void | Promise<void>,
): Promise<boolean> {
  const release = await tryAcquireLock(versionPath, lockFilePath)

  if (!release) {
    return false
  }

  try {
    await callback()
    return true
  } finally {
    // 无论成功还是失败，都确保释放锁
    release()
  }
}

/**
 * 获取指定目录中所有版本锁的诊断信息。
 *
 * 流程：
 *   1. 列出 locksDir 中所有 .lock 文件
 *   2. 解析每个锁文件内容
 *   3. 为每个有效锁添加实时的进程存活状态（isProcessRunning）
 *
 * @param locksDir - 存放锁文件的目录路径
 * @returns LockInfo 数组，包含每个版本锁的完整信息
 */
export function getAllLockInfo(locksDir: string): LockInfo[] {
  const fs = getFsImplementation()
  const lockInfos: LockInfo[] = []

  try {
    // 仅处理 .lock 后缀的文件
    const lockFiles = fs
      .readdirStringSync(locksDir)
      .filter((f: string) => f.endsWith('.lock'))

    for (const lockFile of lockFiles) {
      const lockFilePath = join(locksDir, lockFile)
      const content = readLockContent(lockFilePath)

      if (content) {
        lockInfos.push({
          version: content.version,
          pid: content.pid,
          // 实时查询进程存活状态，提供最新诊断信息
          isProcessRunning: isProcessRunning(content.pid),
          execPath: content.execPath,
          acquiredAt: new Date(content.acquiredAt),
          lockFilePath,
        })
      }
    }
  } catch (error) {
    // 目录不存在时视为无锁文件（正常初始状态）
    if (isENOENT(error)) {
      return lockInfos
    }
    logError(toError(error))
  }

  return lockInfos
}

/**
 * 清理失效锁文件（进程已退出或超过兜底超时的锁）。
 *
 * 处理两类锁：
 *   1. PID 锁文件（JSON 文件）：进程不存活 → 删除
 *   2. 旧版 proper-lockfile 目录锁：启用 PID 锁后无条件清理旧格式目录锁
 *
 * @param locksDir - 存放锁文件的目录路径
 * @returns 成功清理的锁数量
 */
export function cleanupStaleLocks(locksDir: string): number {
  const fs = getFsImplementation()
  let cleanedCount = 0

  try {
    const lockEntries = fs
      .readdirStringSync(locksDir)
      .filter((f: string) => f.endsWith('.lock'))

    for (const lockEntry of lockEntries) {
      const lockFilePath = join(locksDir, lockEntry)

      try {
        const stats = fs.lstatSync(lockFilePath)

        if (stats.isDirectory()) {
          // 旧版 proper-lockfile 使用目录作为锁，启用 PID 锁后应全部清理
          fs.rmSync(lockFilePath, { recursive: true, force: true })
          cleanedCount++
          logForDebugging(`Cleaned up legacy directory lock: ${lockEntry}`)
        } else if (!isLockActive(lockFilePath)) {
          // PID 锁文件：进程不存活（或超过兜底超时）→ 清理
          fs.unlinkSync(lockFilePath)
          cleanedCount++
          logForDebugging(`Cleaned up stale lock: ${lockEntry}`)
        }
      } catch {
        // 忽略单个锁文件的清理错误，继续处理其他锁
      }
    }
  } catch (error) {
    // 目录不存在是正常情况，静默返回 0
    if (isENOENT(error)) {
      return 0
    }
    logError(toError(error))
  }

  return cleanedCount
}
