/**
 * macOS 空闲睡眠防止模块
 *
 * 在 Claude Code 系统流程中的位置：
 * 本文件是系统级资源管理层的一部分，在 Claude 执行长时间 API 请求或工具调用时，
 * 阻止 macOS 进入空闲睡眠状态，确保操作不被系统中断。
 * 它位于以下层次结构中：
 *   - 调用方：REPL 主循环、工具执行层（在开始/完成工作时调用 start/stop）
 *   - 本模块：引用计数 + caffeinate 进程生命周期管理
 *   - 下层：系统 `caffeinate` 命令（macOS 内置的电源管理工具）
 *
 * 主要功能：
 * - startPreventSleep：引用计数 +1，若首次调用则启动 caffeinate 进程和定时重启间隔
 * - stopPreventSleep：引用计数 -1，若归零则停止重启间隔并终止 caffeinate 进程
 * - forceStopPreventSleep：强制将引用计数归零，立即停止所有睡眠防止资源（用于进程退出时清理）
 * - spawnCaffeinate：以 `caffeinate -i -t 300` 启动子进程，-i 防止空闲睡眠，-t 300 设置5分钟自动退出超时
 * - startRestartInterval：每4分钟重启一次 caffeinate，避免5分钟超时导致防睡失效
 * - killCaffeinate：发送 SIGKILL 立即终止 caffeinate 进程
 *
 * 设计说明：
 * - 引用计数（refCount）：支持多个工作单元同时请求防睡，最后一个完成才真正停止
 * - 自愈机制：caffeinate 带 -t 超时，即使 Node 进程被 SIGKILL 杀死，孤儿 caffeinate 也会在超时后自动退出
 * - .unref()：caffeinate 进程和重启间隔均调用 unref()，不阻止 Node.js 进程的正常退出
 * - cleanupRegistered 标志：防止重复向 cleanupRegistry 注册清理函数
 * - 仅在 macOS（process.platform === 'darwin'）上运行，其他平台为空操作
 */

/**
 * Prevents macOS from sleeping while Claude is working.
 *
 * Uses the built-in `caffeinate` command to create a power assertion that
 * prevents idle sleep. This keeps the Mac awake during API requests and
 * tool execution so long-running operations don't get interrupted.
 *
 * The caffeinate process is spawned with a timeout and periodically restarted.
 * This provides self-healing behavior: if the Node process is killed with
 * SIGKILL (which doesn't run cleanup handlers), the orphaned caffeinate will
 * automatically exit after the timeout expires.
 *
 * Only runs on macOS - no-op on other platforms.
 */
import { type ChildProcess, spawn } from 'child_process'
import { registerCleanup } from '../utils/cleanupRegistry.js'
import { logForDebugging } from '../utils/debug.js'

// Caffeinate timeout in seconds. Process auto-exits after this duration.
// We restart it before expiry to maintain continuous sleep prevention.
// caffeinate 超时时间（秒）：进程在此时间后自动退出。定时重启确保持续防睡。
const CAFFEINATE_TIMEOUT_SECONDS = 300 // 5 minutes

// Restart interval - restart caffeinate before it expires.
// Use 4 minutes to give plenty of buffer before the 5 minute timeout.
// 重启间隔：4分钟重启一次，在5分钟超时前留有充足缓冲时间
const RESTART_INTERVAL_MS = 4 * 60 * 1000

// 当前 caffeinate 子进程引用（null 表示未运行）
let caffeinateProcess: ChildProcess | null = null
// 定时重启间隔计时器（null 表示未启动）
let restartInterval: ReturnType<typeof setInterval> | null = null
// 引用计数：记录当前有多少工作单元请求防睡（归零时停止 caffeinate）
let refCount = 0
// 清理函数是否已注册到 cleanupRegistry（防止重复注册）
let cleanupRegistered = false

/**
 * 递增引用计数，若为首次调用则启动睡眠防止机制
 *
 * 完整流程：
 * 1. refCount 自增（允许多个调用方叠加）
 * 2. 若 refCount === 1（第一个调用方）：
 *    - spawnCaffeinate：启动 caffeinate 子进程
 *    - startRestartInterval：启动定时重启间隔
 *
 * Increment the reference count and start preventing sleep if needed.
 * Call this when starting work that should keep the Mac awake.
 */
export function startPreventSleep(): void {
  // 引用计数 +1（允许嵌套调用）
  refCount++

  // 仅在第一次调用时启动防睡机制（避免重复启动）
  if (refCount === 1) {
    spawnCaffeinate()
    startRestartInterval()
  }
}

/**
 * 递减引用计数，若归零则停止睡眠防止机制
 *
 * 完整流程：
 * 1. 若 refCount > 0：refCount 自减
 * 2. 若 refCount === 0（最后一个调用方完成）：
 *    - stopRestartInterval：清除定时重启间隔
 *    - killCaffeinate：终止 caffeinate 进程
 *
 * Decrement the reference count and allow sleep if no more work is pending.
 * Call this when work completes.
 */
export function stopPreventSleep(): void {
  // 防止引用计数变为负数
  if (refCount > 0) {
    refCount--
  }

  // 所有工作单元均已完成时停止防睡
  if (refCount === 0) {
    stopRestartInterval()
    killCaffeinate()
  }
}

/**
 * 强制停止睡眠防止机制，忽略当前引用计数
 *
 * 用于进程退出时的强制清理：
 * 1. 将 refCount 强制归零（忽略当前活跃的工作单元数）
 * 2. 停止定时重启间隔
 * 3. 终止 caffeinate 进程
 *
 * Force stop preventing sleep, regardless of reference count.
 * Use this for cleanup on exit.
 */
export function forceStopPreventSleep(): void {
  // 强制归零，绕过引用计数逻辑
  refCount = 0
  stopRestartInterval()
  killCaffeinate()
}

/**
 * 启动 caffeinate 定时重启间隔
 *
 * 在 macOS 上每 RESTART_INTERVAL_MS（4分钟）重启一次 caffeinate，
 * 确保在5分钟超时到期前维持持续的防睡状态。
 *
 * 关键设计：
 * - restartInterval.unref()：间隔不阻止 Node.js 进程退出（重要！）
 * - 重启前检查 refCount > 0，避免在不再需要防睡时重启
 */
function startRestartInterval(): void {
  // 仅在 macOS 上运行（其他平台直接返回）
  if (process.platform !== 'darwin') {
    return
  }

  // 防止重复启动（已有间隔时直接返回）
  if (restartInterval !== null) {
    return
  }

  restartInterval = setInterval(() => {
    // 仅在仍需防睡时重启（refCount > 0 表示有活跃工作单元）
    if (refCount > 0) {
      logForDebugging('Restarting caffeinate to maintain sleep prevention')
      killCaffeinate()
      spawnCaffeinate()
    }
  }, RESTART_INTERVAL_MS)

  // Don't let the interval keep the Node process alive
  // 调用 unref()：防止此间隔阻止 Node.js 进程正常退出
  restartInterval.unref()
}

/**
 * 停止 caffeinate 定时重启间隔
 *
 * 清除 setInterval 并将 restartInterval 置为 null，
 * 允许后续 startRestartInterval 重新启动。
 */
function stopRestartInterval(): void {
  if (restartInterval !== null) {
    clearInterval(restartInterval)
    // 重置为 null，允许后续重新启动
    restartInterval = null
  }
}

/**
 * 启动 caffeinate 子进程以防止空闲睡眠
 *
 * 完整流程：
 * 1. 仅在 macOS 上运行（其他平台直接返回）
 * 2. 若 caffeinateProcess 已存在则直接返回（防止重复启动）
 * 3. 首次启动时注册 cleanupRegistry 清理函数（通过 cleanupRegistered 标志防止重复注册）
 * 4. 以 `caffeinate -i -t TIMEOUT` 参数启动子进程：
 *    - `-i`：防止空闲睡眠（最温和的防睡选项，屏幕仍可关闭）
 *    - `-t 300`：5分钟超时，提供自愈机制（Node 被 SIGKILL 后 caffeinate 自动退出）
 * 5. 调用 .unref()：caffeinate 不阻止 Node.js 进程退出
 * 6. 监听 'error' 和 'exit' 事件，通过闭包比较清除 caffeinateProcess 引用
 */
function spawnCaffeinate(): void {
  // 仅在 macOS 上运行
  if (process.platform !== 'darwin') {
    return
  }

  // 防止重复启动（已有进程时直接返回）
  if (caffeinateProcess !== null) {
    return
  }

  // Register cleanup on first use to ensure caffeinate is killed on exit
  // 首次启动时注册退出清理函数（cleanupRegistered 标志防止重复注册）
  if (!cleanupRegistered) {
    cleanupRegistered = true
    registerCleanup(async () => {
      // 进程退出时强制停止，确保 caffeinate 被终止
      forceStopPreventSleep()
    })
  }

  try {
    // -i: Create an assertion to prevent idle sleep
    //     This is the least aggressive option - display can still sleep
    // -t: Timeout in seconds - caffeinate exits automatically after this
    //     This provides self-healing if Node is killed with SIGKILL
    // 启动 caffeinate：-i 防止空闲睡眠，-t 设置自动退出超时（自愈机制）
    caffeinateProcess = spawn(
      'caffeinate',
      ['-i', '-t', String(CAFFEINATE_TIMEOUT_SECONDS)],
      {
        // stdio:'ignore' 避免 caffeinate 的 stdout/stderr 干扰主进程的流
        stdio: 'ignore',
      },
    )

    // Don't let caffeinate keep the Node process alive
    // 调用 .unref()：caffeinate 进程不阻止 Node.js 进程正常退出
    caffeinateProcess.unref()

    // 通过闭包捕获当前进程引用，用于后续事件处理中的比较（防止错误清除新进程引用）
    const thisProc = caffeinateProcess
    caffeinateProcess.on('error', err => {
      logForDebugging(`caffeinate spawn error: ${err.message}`)
      // 仅当错误属于当前进程时才清除引用（防止清除掉重启后的新进程）
      if (caffeinateProcess === thisProc) caffeinateProcess = null
    })

    caffeinateProcess.on('exit', () => {
      // 进程退出时清除引用（同上，防止误清除新进程）
      if (caffeinateProcess === thisProc) caffeinateProcess = null
    })

    logForDebugging('Started caffeinate to prevent sleep')
  } catch {
    // Silently fail - caffeinate not available or spawn failed
    // 静默失败：caffeinate 命令不可用或 spawn 失败（非致命错误）
    caffeinateProcess = null
  }
}

/**
 * 以 SIGKILL 立即终止 caffeinate 进程
 *
 * 使用 SIGKILL（而非 SIGTERM）确保立即终止，不等待进程自愿退出。
 * 在终止前先将 caffeinateProcess 置为 null，防止 exit 事件回调再次清除引用
 * （事件顺序：我们先清空引用 → 发送 SIGKILL → exit 事件触发但 thisProc 对比失败 → 不重复清除）。
 */
function killCaffeinate(): void {
  if (caffeinateProcess !== null) {
    // 先将引用置为 null，防止 exit 事件与 null 比较失效
    const proc = caffeinateProcess
    caffeinateProcess = null
    try {
      // SIGKILL for immediate termination - SIGTERM could be delayed
      // 使用 SIGKILL 立即终止（SIGTERM 可能有延迟，不够可靠）
      proc.kill('SIGKILL')
      logForDebugging('Stopped caffeinate, allowing sleep')
    } catch {
      // Process may have already exited
      // 进程可能已自行退出，捕获异常不做处理
    }
  }
}
