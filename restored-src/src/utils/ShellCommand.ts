/**
 * Shell 命令执行结果与生命周期管理模块。
 *
 * 在 Claude Code 系统中，该模块位于 Shell.ts 之下，负责封装子进程（ChildProcess）
 * 的完整生命周期：
 * - 监听进程退出（exit/error 事件）
 * - 处理超时、中止信号及用户中断
 * - 支持将命令"后台化"（backgrounded），允许长时间运行的命令在后台持续执行
 * - 通过 StreamWrapper 将 stdout/stderr 管道数据写入 TaskOutput
 * - 通过文件大小看门狗防止后台进程输出无限增长
 *
 * 主要导出：
 * - `wrapSpawn()`：将子进程包装为 ShellCommand
 * - `createAbortedCommand()`：创建表示"执行前已中止"的静态 ShellCommand
 * - `createFailedCommand()`：创建表示"spawn 前失败"的静态 ShellCommand
 */
import type { ChildProcess } from 'child_process'
import { stat } from 'fs/promises'
import type { Readable } from 'stream'
import treeKill from 'tree-kill'
import { generateTaskId } from '../Task.js'
import { formatDuration } from './format.js'
import {
  MAX_TASK_OUTPUT_BYTES,
  MAX_TASK_OUTPUT_BYTES_DISPLAY,
} from './task/diskOutput.js'
import { TaskOutput } from './task/TaskOutput.js'

/** 命令执行结果，由 ShellCommand.result 解析后得到 */
export type ExecResult = {
  stdout: string
  stderr: string
  code: number
  interrupted: boolean
  backgroundTaskId?: string
  backgroundedByUser?: boolean
  /** Set when assistant-mode auto-backgrounded a long-running blocking command. */
  assistantAutoBackgrounded?: boolean
  /** Set when stdout was too large to fit inline — points to the output file on disk. */
  outputFilePath?: string
  /** Total size of the output file in bytes (set when outputFilePath is set). */
  outputFileSize?: number
  /** The task ID for the output file (set when outputFilePath is set). */
  outputTaskId?: string
  /** Error message when the command failed before spawning (e.g., deleted cwd). */
  preSpawnError?: string
}

/** Shell 命令的运行时句柄，提供状态查询、终止和后台化能力 */
export type ShellCommand = {
  background: (backgroundTaskId: string) => boolean
  result: Promise<ExecResult>
  kill: () => void
  status: 'running' | 'backgrounded' | 'completed' | 'killed'
  /**
   * Cleans up stream resources (event listeners).
   * Should be called after the command completes or is killed to prevent memory leaks.
   */
  cleanup: () => void
  onTimeout?: (
    callback: (backgroundFn: (taskId: string) => boolean) => void,
  ) => void
  /** The TaskOutput instance that owns all stdout/stderr data and progress. */
  taskOutput: TaskOutput
}

// SIGKILL 信号对应的退出码（128 + 9）
const SIGKILL = 137
// SIGTERM 信号对应的退出码（128 + 15）
const SIGTERM = 143

// Background tasks write stdout/stderr directly to a file fd (no JS involvement),
// so a stuck append loop can fill the disk. Poll file size and kill when exceeded.
// 后台任务文件大小检查间隔（5 秒）
const SIZE_WATCHDOG_INTERVAL_MS = 5_000

/** 在 stderr 前追加前缀，若 stderr 非空则加空格分隔 */
function prependStderr(prefix: string, stderr: string): string {
  return stderr ? `${prefix} ${stderr}` : prefix
}

/**
 * 将子进程流（stdout/stderr）的数据通过管道写入 TaskOutput 的轻量包装。
 * 用于 pipe 模式（hooks）下的 stdout 和 stderr 流。
 * 在文件模式（bash 命令）下，两个 fd 直接指向输出文件，
 * 子进程流为 null，不会创建 StreamWrapper。
 *
 * Thin pipe from a child process stream into TaskOutput.
 * Used in pipe mode (hooks) for stdout and stderr.
 */
class StreamWrapper {
  #stream: Readable | null
  #isCleanedUp = false
  #taskOutput: TaskOutput | null
  #isStderr: boolean
  // 绑定的数据处理函数，保存引用以便后续 removeListener
  #onData = this.#dataHandler.bind(this)

  constructor(stream: Readable, taskOutput: TaskOutput, isStderr: boolean) {
    this.#stream = stream
    this.#taskOutput = taskOutput
    this.#isStderr = isStderr
    // Emit strings instead of Buffers - avoids repeated .toString() calls
    stream.setEncoding('utf-8')
    stream.on('data', this.#onData)
  }

  /** 接收数据块，写入 TaskOutput 的 stdout 或 stderr 缓冲 */
  #dataHandler(data: Buffer | string): void {
    const str = typeof data === 'string' ? data : data.toString()

    if (this.#isStderr) {
      this.#taskOutput!.writeStderr(str)
    } else {
      this.#taskOutput!.writeStdout(str)
    }
  }

  /** 清理事件监听器并释放对流和 TaskOutput 的引用，允许 GC */
  cleanup(): void {
    if (this.#isCleanedUp) {
      return
    }
    this.#isCleanedUp = true
    this.#stream!.removeListener('data', this.#onData)
    // Release references so the stream, its StringDecoder, and
    // the TaskOutput can be GC'd independently of this wrapper.
    this.#stream = null
    this.#taskOutput = null
    this.#onData = () => {}
  }
}

/**
 * ShellCommand 的完整实现，包装一个 ChildProcess。
 *
 * 文件模式（bash 命令）：stdout 和 stderr 均通过 stdio[1]/[2] 写入文件 fd，
 *   JS 侧无介入，通过轮询文件尾部提取进度。
 * 管道模式（hooks）：使用 StreamWrapper 实时检测数据流。
 *
 * Implementation of ShellCommand that wraps a child process.
 */
class ShellCommandImpl implements ShellCommand {
  // 当前命令状态
  #status: 'running' | 'backgrounded' | 'completed' | 'killed' = 'running'
  #backgroundTaskId: string | undefined
  // pipe 模式下的流包装器
  #stdoutWrapper: StreamWrapper | null
  #stderrWrapper: StreamWrapper | null
  #childProcess: ChildProcess
  // 超时定时器
  #timeoutId: NodeJS.Timeout | null = null
  // 后台文件大小看门狗定时器
  #sizeWatchdog: NodeJS.Timeout | null = null
  // 是否因输出超大而被 kill
  #killedForSize = false
  #maxOutputBytes: number
  #abortSignal: AbortSignal
  // 超时时的回调（用于自动后台化）
  #onTimeoutCallback:
    | ((backgroundFn: (taskId: string) => boolean) => void)
    | undefined
  #timeout: number
  #shouldAutoBackground: boolean
  // 结果 Promise 的 resolver
  #resultResolver: ((result: ExecResult) => void) | null = null
  // 退出码 Promise 的 resolver
  #exitCodeResolver: ((code: number) => void) | null = null
  // abort 事件处理函数引用（便于 removeEventListener）
  #boundAbortHandler: (() => void) | null = null
  readonly taskOutput: TaskOutput

  /** 超时处理：若启用自动后台化则调用回调，否则发送 SIGTERM */
  static #handleTimeout(self: ShellCommandImpl): void {
    if (self.#shouldAutoBackground && self.#onTimeoutCallback) {
      self.#onTimeoutCallback(self.background.bind(self))
    } else {
      self.#doKill(SIGTERM)
    }
  }

  readonly result: Promise<ExecResult>
  readonly onTimeout?: (
    callback: (backgroundFn: (taskId: string) => boolean) => void,
  ) => void

  constructor(
    childProcess: ChildProcess,
    abortSignal: AbortSignal,
    timeout: number,
    taskOutput: TaskOutput,
    shouldAutoBackground = false,
    maxOutputBytes = MAX_TASK_OUTPUT_BYTES,
  ) {
    this.#childProcess = childProcess
    this.#abortSignal = abortSignal
    this.#timeout = timeout
    this.#shouldAutoBackground = shouldAutoBackground
    this.#maxOutputBytes = maxOutputBytes
    this.taskOutput = taskOutput

    // In file mode (bash commands), both stdout and stderr go to the
    // output file fd — childProcess.stdout/.stderr are both null.
    // In pipe mode (hooks), wrap streams to funnel data into TaskOutput.
    this.#stderrWrapper = childProcess.stderr
      ? new StreamWrapper(childProcess.stderr, taskOutput, true)
      : null
    this.#stdoutWrapper = childProcess.stdout
      ? new StreamWrapper(childProcess.stdout, taskOutput, false)
      : null

    // 若支持自动后台化，暴露 onTimeout 接口供调用方注册回调
    if (shouldAutoBackground) {
      this.onTimeout = (callback): void => {
        this.#onTimeoutCallback = callback
      }
    }

    this.result = this.#createResultPromise()
  }

  get status(): 'running' | 'backgrounded' | 'completed' | 'killed' {
    return this.#status
  }

  /** abort 信号处理：若为用户中断（interrupt）则不 kill，允许调用方后台化 */
  #abortHandler(): void {
    // On 'interrupt' (user submitted a new message), don't kill — let the
    // caller background the process so the model can see partial output.
    if (this.#abortSignal.reason === 'interrupt') {
      return
    }
    this.kill()
  }

  /** 进程退出事件处理：将退出码或信号映射为数字 */
  #exitHandler(code: number | null, signal: NodeJS.Signals | null): void {
    const exitCode =
      code !== null && code !== undefined
        ? code
        : signal === 'SIGTERM'
          ? 144
          : 1
    this.#resolveExitCode(exitCode)
  }

  /** 进程错误事件处理：以退出码 1 结束 */
  #errorHandler(): void {
    this.#resolveExitCode(1)
  }

  /** 解析退出码 Promise，确保只解析一次 */
  #resolveExitCode(code: number): void {
    if (this.#exitCodeResolver) {
      this.#exitCodeResolver(code)
      this.#exitCodeResolver = null
    }
  }

  // Note: exit/error listeners are NOT removed here — they're needed for
  // the result promise to resolve. They clean up when the child process exits.
  /** 清理超时定时器和 abort 监听器（exit/error 监听器保留直到进程退出） */
  #cleanupListeners(): void {
    this.#clearSizeWatchdog()
    const timeoutId = this.#timeoutId
    if (timeoutId) {
      clearTimeout(timeoutId)
      this.#timeoutId = null
    }
    const boundAbortHandler = this.#boundAbortHandler
    if (boundAbortHandler) {
      this.#abortSignal.removeEventListener('abort', boundAbortHandler)
      this.#boundAbortHandler = null
    }
  }

  /** 停止后台文件大小看门狗定时器 */
  #clearSizeWatchdog(): void {
    if (this.#sizeWatchdog) {
      clearInterval(this.#sizeWatchdog)
      this.#sizeWatchdog = null
    }
  }

  /**
   * 启动后台输出文件大小看门狗。
   * 每隔 5 秒检查输出文件大小，超过上限时 SIGKILL 进程（防止磁盘溢出）。
   */
  #startSizeWatchdog(): void {
    this.#sizeWatchdog = setInterval(() => {
      void stat(this.taskOutput.path).then(
        s => {
          // Bail if the watchdog was cleared while this stat was in flight
          // (process exited on its own) — otherwise we'd mislabel stderr.
          if (
            s.size > this.#maxOutputBytes &&
            this.#status === 'backgrounded' &&
            this.#sizeWatchdog !== null
          ) {
            this.#killedForSize = true
            this.#clearSizeWatchdog()
            this.#doKill(SIGKILL)
          }
        },
        () => {
          // ENOENT before first write, or unlinked mid-run — skip this tick
        },
      )
    }, SIZE_WATCHDOG_INTERVAL_MS)
    // unref 防止看门狗阻止进程正常退出
    this.#sizeWatchdog.unref()
  }

  /** 创建结果 Promise，注册 abort/exit/error 监听器和超时定时器 */
  #createResultPromise(): Promise<ExecResult> {
    this.#boundAbortHandler = this.#abortHandler.bind(this)
    this.#abortSignal.addEventListener('abort', this.#boundAbortHandler, {
      once: true,
    })

    // Use 'exit' not 'close': 'close' waits for stdio to close, which includes
    // grandchild processes that inherit file descriptors (e.g. `sleep 30 &`).
    // 'exit' fires when the shell itself exits, returning control immediately.
    this.#childProcess.once('exit', this.#exitHandler.bind(this))
    this.#childProcess.once('error', this.#errorHandler.bind(this))

    // 设置命令超时定时器
    this.#timeoutId = setTimeout(
      ShellCommandImpl.#handleTimeout,
      this.#timeout,
      this,
    ) as NodeJS.Timeout

    const exitPromise = new Promise<number>(resolve => {
      this.#exitCodeResolver = resolve
    })

    return new Promise<ExecResult>(resolve => {
      this.#resultResolver = resolve
      void exitPromise.then(this.#handleExit.bind(this))
    })
  }

  /** 进程退出后异步读取输出并构建最终的 ExecResult */
  async #handleExit(code: number): Promise<void> {
    this.#cleanupListeners()
    if (this.#status === 'running' || this.#status === 'backgrounded') {
      this.#status = 'completed'
    }

    // 从 TaskOutput 读取 stdout（可能来自文件）
    const stdout = await this.taskOutput.getStdout()
    const result: ExecResult = {
      code,
      stdout,
      stderr: this.taskOutput.getStderr(),
      interrupted: code === SIGKILL,
      backgroundTaskId: this.#backgroundTaskId,
    }

    // 若输出文件未冗余（文件大于内联阈值），将文件路径写入结果
    if (this.taskOutput.stdoutToFile && !this.#backgroundTaskId) {
      if (this.taskOutput.outputFileRedundant) {
        // Small file — full content is in result.stdout, delete the file
        void this.taskOutput.deleteOutputFile()
      } else {
        // Large file — tell the caller where the full output lives
        result.outputFilePath = this.taskOutput.path
        result.outputFileSize = this.taskOutput.outputFileSize
        result.outputTaskId = this.taskOutput.taskId
      }
    }

    // 根据终止原因在 stderr 前追加说明信息
    if (this.#killedForSize) {
      result.stderr = prependStderr(
        `Background command killed: output file exceeded ${MAX_TASK_OUTPUT_BYTES_DISPLAY}`,
        result.stderr,
      )
    } else if (code === SIGTERM) {
      result.stderr = prependStderr(
        `Command timed out after ${formatDuration(this.#timeout)}`,
        result.stderr,
      )
    }

    const resultResolver = this.#resultResolver
    if (resultResolver) {
      this.#resultResolver = null
      resultResolver(result)
    }
  }

  /** 发送 SIGKILL（或指定信号）强制终止进程树 */
  #doKill(code?: number): void {
    this.#status = 'killed'
    if (this.#childProcess.pid) {
      treeKill(this.#childProcess.pid, 'SIGKILL')
    }
    this.#resolveExitCode(code ?? SIGKILL)
  }

  kill(): void {
    this.#doKill()
  }

  /**
   * 将运行中的命令切换为后台模式。
   * 清除前台超时定时器，启动文件大小看门狗（文件模式），
   * 或将内存缓冲溢出到磁盘（管道模式）。
   */
  background(taskId: string): boolean {
    if (this.#status === 'running') {
      this.#backgroundTaskId = taskId
      this.#status = 'backgrounded'
      this.#cleanupListeners()
      if (this.taskOutput.stdoutToFile) {
        // File mode: child writes directly to the fd with no JS involvement.
        // The foreground timeout is gone, so watch file size to prevent
        // a stuck append loop from filling the disk (768GB incident).
        this.#startSizeWatchdog()
      } else {
        // Pipe mode: spill the in-memory buffer so readers can find it on disk.
        this.taskOutput.spillToDisk()
      }
      return true
    }
    return false
  }

  /**
   * 清理所有资源：StreamWrapper、TaskOutput、监听器及对象引用。
   * 应在命令完成或被 kill 后调用，防止内存泄漏。
   */
  cleanup(): void {
    this.#stdoutWrapper?.cleanup()
    this.#stderrWrapper?.cleanup()
    this.taskOutput.clear()
    // Must run before nulling #abortSignal — #cleanupListeners() calls
    // removeEventListener on it. Without this, a kill()+cleanup() sequence
    // crashes: kill() queues #handleExit as a microtask, cleanup() nulls
    // #abortSignal, then #handleExit runs #cleanupListeners() on the null ref.
    this.#cleanupListeners()
    // Release references to allow GC of ChildProcess internals and AbortController chain
    this.#childProcess = null!
    this.#abortSignal = null!
    this.#onTimeoutCallback = undefined
  }
}

/**
 * 将子进程包装为 ShellCommand，提供结果追踪、超时、中止和后台化能力。
 *
 * Wraps a child process to enable flexible handling of shell command execution.
 */
export function wrapSpawn(
  childProcess: ChildProcess,
  abortSignal: AbortSignal,
  timeout: number,
  taskOutput: TaskOutput,
  shouldAutoBackground = false,
  maxOutputBytes = MAX_TASK_OUTPUT_BYTES,
): ShellCommand {
  return new ShellCommandImpl(
    childProcess,
    abortSignal,
    timeout,
    taskOutput,
    shouldAutoBackground,
    maxOutputBytes,
  )
}

/**
 * 静态 ShellCommand 实现，表示在执行前已中止的命令。
 * result 立即解析为 interrupted=true 的 ExecResult。
 *
 * Static ShellCommand implementation for commands that were aborted before execution.
 */
class AbortedShellCommand implements ShellCommand {
  readonly status = 'killed' as const
  readonly result: Promise<ExecResult>
  readonly taskOutput: TaskOutput

  constructor(opts?: {
    backgroundTaskId?: string
    stderr?: string
    code?: number
  }) {
    this.taskOutput = new TaskOutput(generateTaskId('local_bash'), null)
    this.result = Promise.resolve({
      code: opts?.code ?? 145,
      stdout: '',
      stderr: opts?.stderr ?? 'Command aborted before execution',
      interrupted: true,
      backgroundTaskId: opts?.backgroundTaskId,
    })
  }

  background(): boolean {
    return false
  }

  kill(): void {}

  cleanup(): void {}
}

/** 创建一个表示"执行前已中止"的 ShellCommand */
export function createAbortedCommand(
  backgroundTaskId?: string,
  opts?: { stderr?: string; code?: number },
): ShellCommand {
  return new AbortedShellCommand({
    backgroundTaskId,
    ...opts,
  })
}

/** 创建一个表示"spawn 前失败"（如 cwd 已被删除）的 ShellCommand */
export function createFailedCommand(preSpawnError: string): ShellCommand {
  const taskOutput = new TaskOutput(generateTaskId('local_bash'), null)
  return {
    status: 'completed' as const,
    result: Promise.resolve({
      code: 1,
      stdout: '',
      stderr: preSpawnError,
      interrupted: false,
      preSpawnError,
    }),
    taskOutput,
    background(): boolean {
      return false
    },
    kill(): void {},
    cleanup(): void {},
  }
}
