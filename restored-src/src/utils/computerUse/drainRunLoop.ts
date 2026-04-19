/**
 * CFRunLoop 泵送模块（macOS）。
 *
 * 在 Claude Code 系统中，该模块为 `@ant/computer-use-swift` 中标注 @MainActor 的方法
 * 提供共享引用计数的 CFRunLoop.main 泵送机制，避免在 libuv 环境下这些方法挂起：
 * - retainPump()：增加引用计数，首次调用时启动 1ms 间隔的 setInterval 泵送
 * - releasePump()：减少引用计数，降至 0 时清除 setInterval
 * - drainRunLoop<T>()：在持有泵的情况下执行异步操作，超时 TIMEOUT_MS = 30000ms 后中止
 */
import { logForDebugging } from '../debug.js'

/**
 * 共享 CFRunLoop 泵。Swift 的四个 `@MainActor` 异步方法
 * （captureExcluding、captureRegion、apps.listInstalled、resolvePrepareCapture）
 * 以及 `@ant/computer-use-input` 的 key()/keys() 均分发至 DispatchQueue.main。
 * 在 libuv（Node/bun）环境下，该队列从不排空 —— promise 会永久挂起。
 * Electron 通过 CFRunLoop 排空队列，因此 Cowork 不需要此机制。
 *
 * 一个引用计数的 setInterval 在任何依赖主队列的调用待处理时，
 * 每 1ms 调用一次 `_drainMainRunLoop`（RunLoop.main.run）。
 * 多个并发的 drainRunLoop() 调用通过 retain/release 共享同一个泵。
 */

let pump: ReturnType<typeof setInterval> | undefined
let pending = 0

function drainTick(cu: ReturnType<typeof requireComputerUseSwift>): void {
  cu._drainMainRunLoop()
}

function retain(): void {
  pending++
  if (pump === undefined) {
    pump = setInterval(drainTick, 1, requireComputerUseSwift())
    logForDebugging('[drainRunLoop] pump started', { level: 'verbose' })
  }
}

function release(): void {
  pending--
  if (pending <= 0 && pump !== undefined) {
    clearInterval(pump)
    pump = undefined
    logForDebugging('[drainRunLoop] pump stopped', { level: 'verbose' })
    pending = 0
  }
}

const TIMEOUT_MS = 30_000

function timeoutReject(reject: (e: Error) => void): void {
  reject(new Error(`computer-use native call exceeded ${TIMEOUT_MS}ms`))
}

/**
 * 在长生命周期注册（如 CGEventTap Esc 处理器）的存续期间持有泵引用。
 * 与 `drainRunLoop(fn)` 不同，此操作没有超时 —— 调用方负责调用 `releasePump()`。
 * 与 drainRunLoop 调用使用同一引用计数，因此嵌套调用是安全的。
 */
export const retainPump = retain
export const releasePump = release

/**
 * 在共享排空泵运行期间等待 `fn()`。可安全嵌套 ——
 * 多个并发的 drainRunLoop() 调用共享同一个 setInterval。
 */
export async function drainRunLoop<T>(fn: () => Promise<T>): Promise<T> {
  retain()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    // 若超时赢得竞争，fn() 的 promise 将变为孤立 promise —— 原生层的延迟拒绝
    // 会变成 unhandledRejection。附加 no-op catch 可吞掉该拒绝；最终暴露的是超时错误。
    // fn() 在 try 块内，确保同步抛出（如 NAPI 参数校验失败）仍能到达 release() ——
    // 否则泵会泄漏。
    const work = fn()
    work.catch(() => {})
    const timeout = withResolvers<never>()
    timer = setTimeout(timeoutReject, TIMEOUT_MS, timeout.reject)
    return await Promise.race([work, timeout.promise])
  } finally {
    clearTimeout(timer)
    release()
  }
}
