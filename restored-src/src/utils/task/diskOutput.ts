/**
 * task/diskOutput.ts — 任务输出磁盘写入与读取模块
 *
 * 在 Claude Code 系统流程中的位置：
 *   任务基础设施层。为 bash 命令任务、Hook 管道任务等所有需要持久化输出的任务
 *   提供统一的磁盘 I/O 能力，是 TaskOutput（内存层）向磁盘溢出的底层实现。
 *
 * 主要职责：
 *   1. 管理任务输出目录（按 sessionId 隔离，防止多会话冲突）；
 *   2. 提供 DiskTaskOutput 类：带写入队列、内存高效的异步磁盘写入；
 *   3. 提供一组工厂/辅助函数：appendTaskOutput、flushTaskOutput、evictTaskOutput、
 *      getTaskOutputDelta、getTaskOutput、getTaskOutputSize、cleanupTaskOutput、
 *      initTaskOutput、initTaskOutputAsSymlink；
 *   4. 跟踪所有 fire-and-forget 的异步操作（_pendingOps），供测试清理使用。
 *
 * 安全说明：
 *   使用 O_NOFOLLOW 标志打开文件，防止沙箱中的符号链接攻击（Unix 特有风险）。
 */

import { constants as fsConstants } from 'fs'
import {
  type FileHandle,
  mkdir,
  open,
  stat,
  symlink,
  unlink,
} from 'fs/promises'
import { join } from 'path'
import { getSessionId } from '../../bootstrap/state.js'
import { getErrnoCode } from '../errors.js'
import { readFileRange, tailFile } from '../fsOperations.js'
import { logError } from '../log.js'
import { getProjectTempDir } from '../permissions/filesystem.js'

// 安全措施：O_NOFOLLOW 防止打开文件时跟随符号链接。
// 若不使用此标志，沙箱内的攻击者可在任务目录中创建符号链接指向任意文件，
// 导致 Claude Code 主机进程向目标文件写入内容。
// O_NOFOLLOW 在 Windows 上不可用，但沙箱攻击向量仅存在于 Unix 系统。
const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0

/** 默认单次读取的最大字节数（8MB） */
const DEFAULT_MAX_READ_BYTES = 8 * 1024 * 1024 // 8MB

/**
 * 任务输出文件的磁盘容量上限（5GB）。
 *
 * file 模式（bash）：看门狗轮询文件大小并在超限时杀死进程；
 * pipe 模式（hooks）：DiskTaskOutput 在超过此限制后丢弃后续数据块。
 * 两者共享同一常量以保持一致。
 */
export const MAX_TASK_OUTPUT_BYTES = 5 * 1024 * 1024 * 1024
export const MAX_TASK_OUTPUT_BYTES_DISPLAY = '5GB'

/**
 * 获取当前会话的任务输出目录路径。
 *
 * 执行流程：
 *   1. 首次调用时，基于 getProjectTempDir() 和 getSessionId() 构建路径；
 *   2. 将结果缓存到 _taskOutputDir，后续调用直接返回缓存值。
 *
 * 【重要设计细节】
 * - 按 sessionId 隔离：防止同一项目的多个并发会话互相覆盖输出文件；
 * - 路径在首次调用时捕获：/clear 会调用 regenerateSessionId()，
 *   但已存在的 TaskOutput 实例保留旧路径，不受影响；
 * - 目录位于项目临时目录中，使 checkReadableInternalPath() 自动允许读取。
 *
 * @returns 当前会话任务输出目录的绝对路径
 */
let _taskOutputDir: string | undefined
export function getTaskOutputDir(): string {
  if (_taskOutputDir === undefined) {
    _taskOutputDir = join(getProjectTempDir(), getSessionId(), 'tasks')
  }
  return _taskOutputDir
}

/** 测试辅助函数：清除已缓存的目录路径（允许下次调用重新计算） */
export function _resetTaskOutputDirForTest(): void {
  _taskOutputDir = undefined
}

/**
 * 确保任务输出目录存在（若不存在则递归创建）。
 */
async function ensureOutputDir(): Promise<void> {
  await mkdir(getTaskOutputDir(), { recursive: true })
}

/**
 * 获取指定任务的输出文件路径。
 *
 * @param taskId - 任务 ID
 * @returns 形如 "{taskOutputDir}/{taskId}.output" 的绝对路径
 */
export function getTaskOutputPath(taskId: string): string {
  return join(getTaskOutputDir(), `${taskId}.output`)
}

// 跟踪 fire-and-forget 的异步操作（initTaskOutput、initTaskOutputAsSymlink、
// evictTaskOutput、#drain 等），供测试在清理前等待所有操作完成。
// 防止异步操作在测试 afterEach 删除临时目录后继续执行，导致 ENOENT 的偶发失败。
// 使用 allSettled 而非 all，以避免一个 rejection 中断其他仍在进行的操作。
const _pendingOps = new Set<Promise<unknown>>()
function track<T>(p: Promise<T>): Promise<T> {
  _pendingOps.add(p)
  // 完成后自动从集合中移除（无论成功或失败）
  void p.finally(() => _pendingOps.delete(p)).catch(() => {})
  return p
}

/**
 * 封装单个任务输出的异步磁盘写入操作。
 *
 * 设计原则：
 *   - 使用平铺数组作为写入队列，由单一 drain 循环处理；
 *   - 每个数据块在其写入完成后即可被 GC 回收；
 *   - 避免链式 .then() 闭包导致的内存保留问题
 *     （链式结构中每个回调会持有数据直至整个链完成）。
 */
export class DiskTaskOutput {
  /** 任务输出文件路径 */
  #path: string
  /** 当前打开的文件句柄（仅在 drain 期间持有） */
  #fileHandle: FileHandle | null = null
  /** 待写入数据块队列 */
  #queue: string[] = []
  /** 已写入的总字节数（UTF-16 估算，可能低于实际 UTF-8 字节数） */
  #bytesWritten = 0
  /** 是否已达容量上限（上限后的写入被丢弃） */
  #capped = false
  /** 当前 flush 操作的 Promise（无待刷新操作时为 null） */
  #flushPromise: Promise<void> | null = null
  /** flush Promise 的 resolve 回调 */
  #flushResolve: (() => void) | null = null

  constructor(taskId: string) {
    this.#path = getTaskOutputPath(taskId)
  }

  /**
   * 追加一段内容到写入队列。
   *
   * 执行流程：
   *   1. 若已达容量上限（#capped），直接返回；
   *   2. 累加字节数估算（使用 UTF-16 长度，可能低估，但足够粗粒度保护）；
   *   3. 若超过上限，将截断通知推入队列并标记 #capped；
   *   4. 否则将内容推入队列；
   *   5. 若 drain 循环尚未运行，启动它。
   *
   * @param content - 要追加的字符串内容
   */
  append(content: string): void {
    if (this.#capped) {
      return
    }
    // content.length 为 UTF-16 代码单元数，低估 UTF-8 字节数最多约 3 倍
    // 对粗粒度磁盘保护可接受——避免对每个数据块重新扫描
    this.#bytesWritten += content.length
    if (this.#bytesWritten > MAX_TASK_OUTPUT_BYTES) {
      this.#capped = true
      // 追加截断提示通知
      this.#queue.push(
        `\n[output truncated: exceeded ${MAX_TASK_OUTPUT_BYTES_DISPLAY} disk cap]\n`,
      )
    } else {
      this.#queue.push(content)
    }
    if (!this.#flushPromise) {
      // 启动新的 drain 循环并跟踪其 Promise
      this.#flushPromise = new Promise<void>(resolve => {
        this.#flushResolve = resolve
      })
      void track(this.#drain())
    }
  }

  /**
   * 返回当前 flush 操作的 Promise；若无待刷新操作则立即 resolve。
   */
  flush(): Promise<void> {
    return this.#flushPromise ?? Promise.resolve()
  }

  /**
   * 清空写入队列（取消所有待写入数据块）。
   * 不中止正在进行的磁盘写入，仅清空排队但尚未写入的内容。
   */
  cancel(): void {
    this.#queue.length = 0
  }

  /**
   * 核心写入循环：持续处理队列直至全部清空。
   *
   * 执行流程：
   *   1. 若文件未打开，先确保目录存在并打开文件（使用 O_NOFOLLOW | O_APPEND | O_CREAT）；
   *   2. 循环调用 #writeAllChunks() 直至队列清空；
   *   3. 关闭文件句柄；
   *   4. 若关闭期间有新的 append()，重新循环。
   */
  async #drainAllChunks(): Promise<void> {
    while (true) {
      try {
        if (!this.#fileHandle) {
          await ensureOutputDir()
          // Windows 不支持数字标志（O_NOFOLLOW），使用字符串 'a'
          this.#fileHandle = await open(
            this.#path,
            process.platform === 'win32'
              ? 'a'
              : fsConstants.O_WRONLY |
                  fsConstants.O_APPEND |
                  fsConstants.O_CREAT |
                  O_NOFOLLOW,
          )
        }
        while (true) {
          await this.#writeAllChunks()
          if (this.#queue.length === 0) {
            break
          }
        }
      } finally {
        // 确保文件句柄总被关闭，即使写入出错
        if (this.#fileHandle) {
          const fileHandle = this.#fileHandle
          this.#fileHandle = null
          await fileHandle.close()
        }
      }
      // 文件关闭期间可能有新的 append()，关闭后需再次检查队列
      if (this.#queue.length) {
        continue
      }

      break
    }
  }

  /**
   * 将队列中所有数据块批量写入文件（单次 appendFile 调用）。
   *
   * 【极其重要】：此方法内部不得使用 await！
   * 在此方法中 await 会导致队列中的 Buffer[] 长期驻留内存，引起内存膨胀。
   * 可以在调用此方法的上层（#drainAllChunks）中使用 await。
   */
  #writeAllChunks(): Promise<void> {
    return this.#fileHandle!.appendFile(
      // 此变量需尽快被 GC 回收——调用 #queueToBuffers() 拿到 Buffer 后立即传给 appendFile
      this.#queueToBuffers(),
    )
  }

  /**
   * 将写入队列中的所有字符串合并为单个 Buffer。
   * 单独提取为方法，以便 GC 在此作用域结束后及时回收队列数组。
   *
   * 执行流程：
   *   1. 用 splice 原地清空队列（GC 友好）；
   *   2. 预计算所有字符串的 UTF-8 总字节数；
   *   3. 分配精确大小的 Buffer 并依次写入每个字符串；
   *   4. 返回合并后的 Buffer。
   */
  #queueToBuffers(): Buffer {
    // splice 原地清空并返回旧内容，通知 GC 可以释放
    const queue = this.#queue.splice(0, this.#queue.length)

    // 预先计算总字节数以避免动态扩容
    let totalLength = 0
    for (const str of queue) {
      totalLength += Buffer.byteLength(str, 'utf8')
    }

    const buffer = Buffer.allocUnsafe(totalLength)
    let offset = 0
    for (const str of queue) {
      offset += buffer.write(str, offset, 'utf8')
    }

    return buffer
  }

  /**
   * drain 的外层包装：处理错误、重试及 flush Promise 的 resolve。
   *
   * 执行流程：
   *   1. 调用 #drainAllChunks() 执行实际写入；
   *   2. 若发生错误，记录日志，若队列非空则重试一次；
   *   3. 无论成功与否，最终 resolve flush Promise 并清除引用。
   */
  async #drain(): Promise<void> {
    try {
      await this.#drainAllChunks()
    } catch (e) {
      // 瞬态文件系统错误（繁忙 CI 上的 EMFILE、Windows 挂起删除的 EPERM）
      // 以前会通过 void this.#drain() 成为未处理的 rejection，而 flush promise 仍会 resolve，
      // 调用方会看到空文件但无错误。对瞬态情况重试一次（若 open() 失败队列仍完整），
      // 之后记录日志并放弃。
      logError(e)
      if (this.#queue.length > 0) {
        try {
          await this.#drainAllChunks()
        } catch (e2) {
          logError(e2)
        }
      }
    } finally {
      // 无论成功失败，均 resolve flush Promise 并清除引用
      const resolve = this.#flushResolve!
      this.#flushPromise = null
      this.#flushResolve = null
      resolve()
    }
  }
}

/** 全局 DiskTaskOutput 实例映射（taskId → 实例） */
const outputs = new Map<string, DiskTaskOutput>()

/**
 * 测试辅助函数：取消所有待写入操作，等待所有进行中的操作完成，清空映射。
 *
 * 在测试的 afterEach 中、rmSync 之前调用，避免异步写入在临时目录被删除后继续
 * 执行而触发 ENOENT，导致偶发测试失败。
 * 循环等待直至 _pendingOps 稳定，因为某些 settling 的 Promise 可能启动新操作
 * （如 initTaskOutputAsSymlink 的 catch → initTaskOutput）。
 */
export async function _clearOutputsForTest(): Promise<void> {
  for (const output of outputs.values()) {
    output.cancel()
  }
  while (_pendingOps.size > 0) {
    await Promise.allSettled([..._pendingOps])
  }
  outputs.clear()
}

/**
 * 获取或创建指定 taskId 对应的 DiskTaskOutput 实例。
 *
 * @param taskId - 任务 ID
 * @returns 对应的 DiskTaskOutput 实例（复用或新建）
 */
function getOrCreateOutput(taskId: string): DiskTaskOutput {
  let output = outputs.get(taskId)
  if (!output) {
    output = new DiskTaskOutput(taskId)
    outputs.set(taskId, output)
  }
  return output
}

/**
 * 异步追加内容到任务的磁盘输出文件（若文件不存在则自动创建）。
 *
 * @param taskId   - 任务 ID
 * @param content  - 要追加的字符串内容
 */
export function appendTaskOutput(taskId: string, content: string): void {
  getOrCreateOutput(taskId).append(content)
}

/**
 * 等待指定任务所有待写入操作完成。
 * 在读取任务输出前调用以确保所有数据已落盘。
 *
 * @param taskId - 任务 ID
 */
export async function flushTaskOutput(taskId: string): Promise<void> {
  const output = outputs.get(taskId)
  if (output) {
    await output.flush()
  }
}

/**
 * 从内存映射中驱逐任务的 DiskTaskOutput（flush 后）。
 * 与 cleanupTaskOutput 不同：不删除磁盘上的输出文件。
 * 在任务完成且其输出已被消费后调用。
 *
 * @param taskId - 任务 ID
 * @returns 驱逐完成的 Promise
 */
export function evictTaskOutput(taskId: string): Promise<void> {
  return track(
    (async () => {
      const output = outputs.get(taskId)
      if (output) {
        await output.flush()
        outputs.delete(taskId)
      }
    })(),
  )
}

/**
 * 获取指定任务自上次读取位置起的增量输出（仅读取新增内容）。
 *
 * 执行流程：
 *   1. 调用 readFileRange() 从 fromOffset 开始读取最多 maxBytes 字节；
 *   2. 若文件不存在（ENOENT），返回空内容和原始偏移量；
 *   3. 返回新内容及更新后的偏移量。
 *
 * @param taskId     - 任务 ID
 * @param fromOffset - 上次读取的字节偏移量（从此处开始读取新内容）
 * @param maxBytes   - 单次读取最大字节数
 * @returns 新增内容和更新后的偏移量
 */
export async function getTaskOutputDelta(
  taskId: string,
  fromOffset: number,
  maxBytes: number = DEFAULT_MAX_READ_BYTES,
): Promise<{ content: string; newOffset: number }> {
  try {
    const result = await readFileRange(
      getTaskOutputPath(taskId),
      fromOffset,
      maxBytes,
    )
    if (!result) {
      return { content: '', newOffset: fromOffset }
    }
    return {
      content: result.content,
      newOffset: fromOffset + result.bytesRead,
    }
  } catch (e) {
    const code = getErrnoCode(e)
    if (code === 'ENOENT') {
      // 文件不存在（任务尚未产生输出），返回空内容
      return { content: '', newOffset: fromOffset }
    }
    logError(e)
    return { content: '', newOffset: fromOffset }
  }
}

/**
 * 读取任务输出文件的末尾内容（避免将超大文件完整加载到内存）。
 *
 * 执行流程：
 *   1. 调用 tailFile() 读取文件末尾最多 maxBytes 字节；
 *   2. 若文件总大小超过已读字节数，在开头添加"省略了 N KB 早期输出"的提示；
 *   3. 若文件不存在，返回空字符串。
 *
 * @param taskId   - 任务 ID
 * @param maxBytes - 最大读取字节数（默认 8MB）
 * @returns 任务输出内容字符串
 */
export async function getTaskOutput(
  taskId: string,
  maxBytes: number = DEFAULT_MAX_READ_BYTES,
): Promise<string> {
  try {
    const { content, bytesTotal, bytesRead } = await tailFile(
      getTaskOutputPath(taskId),
      maxBytes,
    )
    if (bytesTotal > bytesRead) {
      // 输出超过读取上限，添加截断提示
      return `[${Math.round((bytesTotal - bytesRead) / 1024)}KB of earlier output omitted]\n${content}`
    }
    return content
  } catch (e) {
    const code = getErrnoCode(e)
    if (code === 'ENOENT') {
      return ''
    }
    logError(e)
    return ''
  }
}

/**
 * 获取任务输出文件当前的字节大小（即当前写入偏移量）。
 *
 * @param taskId - 任务 ID
 * @returns 文件大小（字节数）；文件不存在时返回 0
 */
export async function getTaskOutputSize(taskId: string): Promise<number> {
  try {
    return (await stat(getTaskOutputPath(taskId))).size
  } catch (e) {
    const code = getErrnoCode(e)
    if (code === 'ENOENT') {
      return 0
    }
    logError(e)
    return 0
  }
}

/**
 * 清理任务的输出文件及写入队列（删除磁盘文件）。
 *
 * 执行流程：
 *   1. 取消内存中的待写入队列并从映射中移除；
 *   2. 尝试删除磁盘上的输出文件；
 *   3. 若文件不存在（已删除），静默忽略。
 *
 * @param taskId - 任务 ID
 */
export async function cleanupTaskOutput(taskId: string): Promise<void> {
  const output = outputs.get(taskId)
  if (output) {
    output.cancel()
    outputs.delete(taskId)
  }

  try {
    await unlink(getTaskOutputPath(taskId))
  } catch (e) {
    const code = getErrnoCode(e)
    if (code === 'ENOENT') {
      return
    }
    logError(e)
  }
}

/**
 * 为新任务初始化输出文件（创建空文件以确保路径存在）。
 *
 * 执行流程：
 *   1. 确保输出目录存在；
 *   2. 以 O_EXCL | O_NOFOLLOW 标志创建新文件（若已存在则失败）；
 *   3. 立即关闭文件句柄；
 *   4. 返回文件路径。
 *
 * 安全措施：
 *   O_NOFOLLOW 防止符号链接跟随攻击；O_EXCL 确保创建全新文件。
 *
 * @param taskId - 任务 ID
 * @returns 创建的输出文件路径
 */
export function initTaskOutput(taskId: string): Promise<string> {
  return track(
    (async () => {
      await ensureOutputDir()
      const outputPath = getTaskOutputPath(taskId)
      // 安全措施：O_NOFOLLOW 防止沙箱中的符号链接跟随攻击
      // O_EXCL 确保创建新文件，若已存在则 EEXIST
      // Windows 使用字符串标志 'wx'（数字 O_EXCL 会触发 libuv EINVAL）
      const fh = await open(
        outputPath,
        process.platform === 'win32'
          ? 'wx'
          : fsConstants.O_WRONLY |
              fsConstants.O_CREAT |
              fsConstants.O_EXCL |
              O_NOFOLLOW,
      )
      await fh.close()
      return outputPath
    })(),
  )
}

/**
 * 将任务输出文件初始化为指向另一文件的符号链接（如 Agent transcript 文件）。
 *
 * 执行流程：
 *   1. 确保输出目录存在；
 *   2. 尝试创建符号链接；若目标路径已存在文件，先删除再重试；
 *   3. 若整个过程失败，回退到调用 initTaskOutput() 创建空文件。
 *
 * @param taskId     - 任务 ID
 * @param targetPath - 符号链接指向的目标文件路径
 * @returns 创建的符号链接路径
 */
export function initTaskOutputAsSymlink(
  taskId: string,
  targetPath: string,
): Promise<string> {
  return track(
    (async () => {
      try {
        await ensureOutputDir()
        const outputPath = getTaskOutputPath(taskId)

        try {
          await symlink(targetPath, outputPath)
        } catch {
          // 若路径已存在，先删除再尝试创建符号链接
          await unlink(outputPath)
          await symlink(targetPath, outputPath)
        }

        return outputPath
      } catch (error) {
        // 符号链接创建彻底失败，回退到创建普通空文件
        logError(error)
        return initTaskOutput(taskId)
      }
    })(),
  )
}
