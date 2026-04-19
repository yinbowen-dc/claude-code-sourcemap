/**
 * 带缓冲的写入器工厂模块。
 *
 * 在 Claude Code 系统中，该模块提供 BufferedWriter 对象，
 * 将频繁的小写入聚合后批量刷新到底层 writeFn，以减少 I/O 次数：
 * - 定时刷新（flushIntervalMs，默认 1 秒）
 * - 超出条数（maxBufferSize，默认 100 条）或字节上限时触发异步溢出刷新（flushDeferred）
 * - immediateMode：直接透传，不缓冲（用于非交互场景）
 * - flush()：同步强制刷新；dispose()：等同于 flush，用于清理时调用
 * - 溢出写入使用 setImmediate 延迟，避免阻塞当前 tick（如渲染或键盘响应）
 */
type WriteFn = (content: string) => void

export type BufferedWriter = {
  write: (content: string) => void
  flush: () => void
  dispose: () => void
}

/**
 * 创建带缓冲的写入器。
 * @param writeFn - 实际执行写入的函数（如 appendFileSync 包装）
 * @param flushIntervalMs - 定时刷新间隔（默认 1000ms）
 * @param maxBufferSize - 触发溢出刷新的最大缓冲条数（默认 100）
 * @param maxBufferBytes - 触发溢出刷新的最大缓冲字节数（默认无限制）
 * @param immediateMode - 若为 true 则直接透传，不缓冲
 */
export function createBufferedWriter({
  writeFn,
  flushIntervalMs = 1000,
  maxBufferSize = 100,
  maxBufferBytes = Infinity,
  immediateMode = false,
}: {
  writeFn: WriteFn
  flushIntervalMs?: number
  maxBufferSize?: number
  maxBufferBytes?: number
  immediateMode?: boolean
}): BufferedWriter {
  let buffer: string[] = []
  let bufferBytes = 0
  let flushTimer: NodeJS.Timeout | null = null
  // Batch detached by overflow that hasn't been written yet. Tracked so
  // flush()/dispose() can drain it synchronously if the process exits
  // before the setImmediate fires.
  let pendingOverflow: string[] | null = null

  function clearTimer(): void {
    if (flushTimer) {
      clearTimeout(flushTimer)
      flushTimer = null
    }
  }

  function flush(): void {
    if (pendingOverflow) {
      writeFn(pendingOverflow.join(''))
      pendingOverflow = null
    }
    if (buffer.length === 0) return
    writeFn(buffer.join(''))
    buffer = []
    bufferBytes = 0
    clearTimer()
  }

  function scheduleFlush(): void {
    if (!flushTimer) {
      flushTimer = setTimeout(flush, flushIntervalMs)
    }
  }

  // Detach the buffer synchronously so the caller never waits on writeFn.
  // writeFn may block (e.g. errorLogSink.ts appendFileSync) — if overflow fires
  // mid-render or mid-keystroke, deferring the write keeps the current tick
  // short. Timer-based flushes already run outside user code paths so they
  // stay synchronous.
  function flushDeferred(): void {
    if (pendingOverflow) {
      // A previous overflow write is still queued. Coalesce into it to
      // preserve ordering — writes land in a single setImmediate-ordered batch.
      pendingOverflow.push(...buffer)
      buffer = []
      bufferBytes = 0
      clearTimer()
      return
    }
    const detached = buffer
    buffer = []
    bufferBytes = 0
    clearTimer()
    pendingOverflow = detached
    setImmediate(() => {
      const toWrite = pendingOverflow
      pendingOverflow = null
      if (toWrite) writeFn(toWrite.join(''))
    })
  }

  return {
    write(content: string): void {
      if (immediateMode) {
        writeFn(content)
        return
      }
      buffer.push(content)
      bufferBytes += content.length
      scheduleFlush()
      if (buffer.length >= maxBufferSize || bufferBytes >= maxBufferBytes) {
        flushDeferred()
      }
    },
    flush,
    dispose(): void {
      flush()
    },
  }
}
