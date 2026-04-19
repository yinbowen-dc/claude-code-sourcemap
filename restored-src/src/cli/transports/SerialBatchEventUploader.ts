/**
 * 串行批量事件上传器 — 带重试、背压和指数退避的有序批量 POST 发送器。
 *
 * 在整个 Claude Code 系统中的位置：
 * 本文件是 HybridTransport 和 CCRClient 共用的底层发送原语。
 * 它将调用方写入的 StdoutMessage（或其他泛型事件）以串行、批量、
 * 可重试的方式通过 HTTP POST 发送到远端，并提供以下保证：
 *   - 串行性：同一时刻最多只有 1 个 POST 在飞行中（flight），避免并发写冲突
 *   - 批量性：每次 POST 最多发送 maxBatchSize 条或 maxBatchBytes 字节的事件
 *   - 重试性：发送失败时以指数退避（含抖动）无限重试，直到成功或 close()
 *   - 背压：当 pending 队列达到 maxQueueSize 时，enqueue() 将阻塞调用方
 *
 * 与 CCR v2 / HybridTransport 的关系：
 *   - HybridTransport 用此类批量化写入流（stream_event）和其他消息到 Session Ingress
 *   - CCRClient 用此类将 transcript / internal event 发送到 CCR 后端
 */
import { jsonStringify } from '../../utils/slowOperations.js'

/**
 * 串行批量事件上传器的核心特性说明：
 *
 * - enqueue()   将事件追加到待发送缓冲区
 * - 同一时刻最多 1 个 POST 在飞行中
 * - 每次 POST 最多 maxBatchSize 条事件
 * - 新事件在 POST 飞行中持续积累
 * - 失败时：指数退避（上限 maxDelayMs），无限重试
 *   直到成功或 close()；若设置了 maxConsecutiveFailures，
 *   则达到上限后丢弃当前批次并继续处理下一条
 * - flush() 阻塞直到 pending 队列为空，并在需要时启动 drain
 * - 背压：当 pending 长度达到 maxQueueSize 时，enqueue() 阻塞
 */

/**
 * 可重试错误类 — 从 config.send() 抛出此类错误，可携带服务端提供的重试延迟。
 *
 * 使用场景：服务端返回 429（Too Many Requests）并附带 Retry-After 响应头时，
 * 调用方可将头部值（毫秒）包装成 RetryableError 抛出，上传器会优先采用
 * retryAfterMs 作为本次延迟（覆盖指数退避），并施以抖动防止同一速率限制下
 * 多个 session 同时重试形成"惊群效应"（thundering herd）。
 *
 * 若不传 retryAfterMs，则行为与普通错误一致（走指数退避逻辑）。
 */
export class RetryableError extends Error {
  constructor(
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message)
  }
}

/**
 * SerialBatchEventUploader 的配置类型，泛型参数 T 为待发送事件的类型。
 */
type SerialBatchEventUploaderConfig<T> = {
  /** 每次 POST 最多包含的事件条数（= 1 时等效于无批量合并） */
  maxBatchSize: number
  /**
   * 每次 POST 序列化后最大字节数。
   * 第一条事件无论大小都会被发送；后续事件仅在累积 JSON 字节数
   * 不超过此限制时才追加进同一批次。
   * 若为 undefined，则不限制字节数（仅按条数批量）。
   */
  maxBatchBytes?: number
  /** pending 队列最大长度，超过此值时 enqueue() 将阻塞直到有空间 */
  maxQueueSize: number
  /** 实际 HTTP 发送函数，由调用方负责构造请求体格式 */
  send: (batch: T[]) => Promise<void>
  /** 指数退避基础延迟（毫秒） */
  baseDelayMs: number
  /** 指数退避最大延迟上限（毫秒） */
  maxDelayMs: number
  /** 每次重试延迟的随机抖动范围（毫秒），防止惊群效应 */
  jitterMs: number
  /**
   * 连续失败次数上限。达到上限后，当前批次会被丢弃并继续处理下一条。
   * 新批次拥有独立的失败计数器（重置为 0）。
   * 若为 undefined，则无限重试（默认行为）。
   */
  maxConsecutiveFailures?: number
  /** 批次因连续失败被丢弃时的回调（用于诊断日志） */
  onBatchDropped?: (batchSize: number, failures: number) => void
}

/**
 * 串行批量事件上传器。
 *
 * 核心机制：
 * - pending 队列存储待发送事件；drain() 循环每次取一批次发送。
 * - draining 标志保证同一时刻最多只有一个 drain() 协程在运行。
 * - 背压（backpressure）通过 backpressureResolvers 实现：
 *   队列满时 enqueue() 挂起，drain 消耗事件后唤醒被阻塞的调用方。
 * - flush() 通过 flushResolvers 在 pending 清空时统一唤醒等待者。
 * - sleep() 保存 sleepResolve 引用以便 close() 提前打断退避等待。
 */
export class SerialBatchEventUploader<T> {
  private pending: T[] = []
  // close() 时记录关闭瞬间的队列深度，供后续诊断读取
  private pendingAtClose = 0
  private draining = false
  private closed = false
  // 队列满时等待空间的 Promise resolve 列表（背压）
  private backpressureResolvers: Array<() => void> = []
  // 当前退避 sleep 的取消函数（close() 时用于提前唤醒）
  private sleepResolve: (() => void) | null = null
  // flush() 等待队列清空的 Promise resolve 列表
  private flushResolvers: Array<() => void> = []
  // 因连续失败超限而被丢弃的批次计数（单调递增）
  private droppedBatches = 0
  private readonly config: SerialBatchEventUploaderConfig<T>

  constructor(config: SerialBatchEventUploaderConfig<T>) {
    this.config = config
  }

  /**
   * 已丢弃批次的单调计数器。
   * 调用方可在 flush() 前后对比此值，以判断是否有事件被静默丢弃
   * （flush() 正常 resolve 并不代表所有事件都成功发送）。
   */
  get droppedBatchCount(): number {
    return this.droppedBatches
  }

  /**
   * 当前 pending 队列深度。
   * close() 之后返回关闭时刻的快照值（close() 会清空队列，
   * 但关机诊断可能在 close() 后读取此值）。
   */
  get pendingCount(): number {
    return this.closed ? this.pendingAtClose : this.pending.length
  }

  /**
   * 将事件追加到 pending 队列并触发 drain。
   *
   * 若队列有空间则立即返回；若队列已满，则挂起等待 drain 释放空间
   * （背压机制，防止内存无限增长）。
   * 已关闭（closed）后调用直接丢弃。
   */
  async enqueue(events: T | T[]): Promise<void> {
    if (this.closed) return
    const items = Array.isArray(events) ? events : [events]
    if (items.length === 0) return

    // 背压：若加入后超过 maxQueueSize，则等待 drain 释放空间
    while (
      this.pending.length + items.length > this.config.maxQueueSize &&
      !this.closed
    ) {
      await new Promise<void>(resolve => {
        this.backpressureResolvers.push(resolve)
      })
    }

    if (this.closed) return
    this.pending.push(...items)
    // 触发 drain（若未在运行中）
    void this.drain()
  }

  /**
   * 阻塞直到所有 pending 事件均已发送（队列清空）。
   * 常用于消息回合边界（turn boundary）和优雅关闭前的最终 flush。
   */
  flush(): Promise<void> {
    if (this.pending.length === 0 && !this.draining) {
      return Promise.resolve()
    }
    void this.drain()
    return new Promise<void>(resolve => {
      this.flushResolvers.push(resolve)
    })
  }

  /**
   * 丢弃所有 pending 事件并停止 drain 循环。
   * 唤醒所有被 enqueue() 和 flush() 阻塞的调用方，
   * 并打断正在退避的 sleep()，使 drain 循环尽快退出。
   */
  close(): void {
    if (this.closed) return
    this.closed = true
    // 记录关闭瞬间的队列深度
    this.pendingAtClose = this.pending.length
    this.pending = []
    // 提前唤醒正在等待的退避 sleep
    this.sleepResolve?.()
    this.sleepResolve = null
    // 唤醒所有背压等待者
    for (const resolve of this.backpressureResolvers) resolve()
    this.backpressureResolvers = []
    // 唤醒所有 flush 等待者
    for (const resolve of this.flushResolvers) resolve()
    this.flushResolvers = []
  }

  /**
   * Drain 循环：串行消费 pending 队列并发送批次。
   *
   * 由 draining 标志保证同一时刻只有一个实例在运行。
   * 每次循环取一批次（takeBatch），调用 config.send() 发送：
   *   - 成功：重置失败计数，释放背压等待者。
   *   - 失败：
   *     - 若未超过 maxConsecutiveFailures，将批次重新放回队列头部，
   *       等待退避延迟后重试。
   *     - 若超过 maxConsecutiveFailures，丢弃批次并继续处理下一条。
   * 队列清空后唤醒所有 flush 等待者。
   */
  private async drain(): Promise<void> {
    if (this.draining || this.closed) return
    this.draining = true
    let failures = 0

    try {
      while (this.pending.length > 0 && !this.closed) {
        const batch = this.takeBatch()
        if (batch.length === 0) continue

        try {
          await this.config.send(batch)
          // 发送成功：重置连续失败计数
          failures = 0
        } catch (err) {
          failures++
          if (
            this.config.maxConsecutiveFailures !== undefined &&
            failures >= this.config.maxConsecutiveFailures
          ) {
            // 达到连续失败上限：丢弃此批次，继续处理下一条
            this.droppedBatches++
            this.config.onBatchDropped?.(batch.length, failures)
            failures = 0
            this.releaseBackpressure()
            continue
          }
          // 将失败批次重新放回 pending 队列头部。
          // 使用 concat（单次内存分配）而非 unshift(...batch)
          // 以避免对每个已有元素执行 O(batch.length) 次移位操作。
          // 此路径只在失败时触发，性能可接受。
          this.pending = batch.concat(this.pending)
          // 若为 RetryableError 则使用服务端提供的 retryAfterMs，否则走指数退避
          const retryAfterMs =
            err instanceof RetryableError ? err.retryAfterMs : undefined
          await this.sleep(this.retryDelay(failures, retryAfterMs))
          continue
        }

        // 成功发送后：释放因队列满而阻塞的 enqueue() 调用方
        this.releaseBackpressure()
      }
    } finally {
      this.draining = false
      // 队列清空后唤醒所有 flush() 等待者
      if (this.pending.length === 0) {
        for (const resolve of this.flushResolvers) resolve()
        this.flushResolvers = []
      }
    }
  }

  /**
   * 从 pending 队列头部取出下一批次。
   *
   * 同时遵守 maxBatchSize（条数上限）和 maxBatchBytes（字节上限）：
   * - 第一条事件无论大小都会被取出（避免毒瘤事件永久阻塞队列）。
   * - 后续事件仅在累积字节数不超过 maxBatchBytes 时才追加。
   *
   * 无法序列化的事件（含 BigInt、循环引用、抛异常的 toJSON）会被
   * 原地丢弃——此类事件无法被发送，若留在队列头会导致 flush() 永久挂起。
   */
  private takeBatch(): T[] {
    const { maxBatchSize, maxBatchBytes } = this.config
    // 若无字节限制，直接按条数截取
    if (maxBatchBytes === undefined) {
      return this.pending.splice(0, maxBatchSize)
    }
    let bytes = 0
    let count = 0
    while (count < this.pending.length && count < maxBatchSize) {
      let itemBytes: number
      try {
        itemBytes = Buffer.byteLength(jsonStringify(this.pending[count]))
      } catch {
        // 无法序列化：原地丢弃，避免毒化队列
        this.pending.splice(count, 1)
        continue
      }
      // 第一条事件（count === 0）无论大小都加入批次；后续超字节则停止
      if (count > 0 && bytes + itemBytes > maxBatchBytes) break
      bytes += itemBytes
      count++
    }
    return this.pending.splice(0, count)
  }

  /**
   * 计算本次重试的延迟时间。
   *
   * 若提供了 retryAfterMs（来自服务端 Retry-After 头）：
   *   将其 clamp 到 [baseDelayMs, maxDelayMs]，再加随机抖动。
   * 否则使用指数退避：baseDelayMs * 2^(failures-1)，上限 maxDelayMs，加抖动。
   */
  private retryDelay(failures: number, retryAfterMs?: number): number {
    const jitter = Math.random() * this.config.jitterMs
    if (retryAfterMs !== undefined) {
      // 使用服务端提供的延迟提示，clamp 到合法范围，加抖动防止惊群
      // （多个 session 共享同一速率限制时不会同时重试）
      const clamped = Math.max(
        this.config.baseDelayMs,
        Math.min(retryAfterMs, this.config.maxDelayMs),
      )
      return clamped + jitter
    }
    // 指数退避：failures 次失败后延迟 = base * 2^(failures-1)，上限 maxDelayMs
    const exponential = Math.min(
      this.config.baseDelayMs * 2 ** (failures - 1),
      this.config.maxDelayMs,
    )
    return exponential + jitter
  }

  /**
   * 唤醒所有因背压而阻塞的 enqueue() 调用方。
   * 当 pending 队列有空间时（批次发送成功或被丢弃后）调用。
   */
  private releaseBackpressure(): void {
    const resolvers = this.backpressureResolvers
    this.backpressureResolvers = []
    for (const resolve of resolvers) resolve()
  }

  /**
   * 可被 close() 提前打断的 sleep 函数。
   *
   * 将 resolve 引用存入 sleepResolve，使 close() 能在进程退出时
   * 立即唤醒正在等待退避延迟的 drain 循环，而无需等到 setTimeout 触发。
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => {
      this.sleepResolve = resolve
      setTimeout(
        (self, resolve) => {
          self.sleepResolve = null
          resolve()
        },
        ms,
        this,
        resolve,
      )
    })
  }
}
