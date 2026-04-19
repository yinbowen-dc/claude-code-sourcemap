/**
 * Worker 状态合并上传器 — 用于 CCR v2 PUT /worker 接口的节流与合并写入。
 *
 * 在整个 Claude Code 系统中的位置：
 * 本文件由 CCRClient 使用，负责将 worker 状态（worker_status、
 * external_metadata、internal_metadata）批量上报给 CCR 后端。
 * 处于传输层（transports/）内，是 CCR v2 协议实现的一部分。
 *
 * 核心设计：
 * - 同一时刻最多 1 个 in-flight PUT 请求 + 1 个 pending patch 槽位，
 *   天然将并发写入合并，避免对同一 worker 文档的并发 PUT 冲突。
 * - pending 槽位采用 RFC 7396 合并语义：metadata 子键按后来者覆盖规则合并，
 *   null 值保留（服务端收到后执行删除操作）。
 * - 无需背压机制 — 最多只有 2 个槽位，不会无限堆积。
 * - 失败时指数退避重试，直至成功或 close() 被调用。
 */
import { sleep } from '../../utils/sleep.js'

/**
 * Coalescing uploader for PUT /worker (session state + metadata).
 *
 * - 1 in-flight PUT + 1 pending patch
 * - New calls coalesce into pending (never grows beyond 1 slot)
 * - On success: send pending if exists
 * - On failure: exponential backoff (clamped), retries indefinitely
 *   until success or close(). Absorbs any pending patches before each retry.
 * - No backpressure needed — naturally bounded at 2 slots
 *
 * Coalescing rules:
 * - Top-level keys (worker_status, external_metadata) — last value wins
 * - Inside external_metadata / internal_metadata — RFC 7396 merge:
 *   keys are added/overwritten, null values preserved (server deletes)
 */

/** 上传器的配置接口：包含发送函数和退避参数 */
type WorkerStateUploaderConfig = {
  /** 实际发送 PUT /worker 的函数，返回 true 表示成功 */
  send: (body: Record<string, unknown>) => Promise<boolean>
  /** Base delay for exponential backoff (ms) */
  baseDelayMs: number
  /** Max delay cap (ms) */
  maxDelayMs: number
  /** Random jitter range added to retry delay (ms) */
  jitterMs: number
}

export class WorkerStateUploader {
  /** 当前 in-flight 的 PUT Promise（最多 1 个） */
  private inflight: Promise<void> | null = null
  /** 等待发送的合并补丁（最多 1 个槽位） */
  private pending: Record<string, unknown> | null = null
  /** 是否已关闭，关闭后不再处理任何新请求 */
  private closed = false
  private readonly config: WorkerStateUploaderConfig

  constructor(config: WorkerStateUploaderConfig) {
    this.config = config
  }

  /**
   * 将补丁加入待发送队列，与现有 pending 合并后触发 drain。
   *
   * 流程：若已关闭则直接返回；否则将 patch 与现有 pending 合并（RFC 7396），
   * 然后调用 drain() 尝试异步发送。调用方无需 await 此方法（fire-and-forget）。
   */
  enqueue(patch: Record<string, unknown>): void {
    if (this.closed) return
    // 将新补丁与现有 pending 合并；若 pending 为空则直接赋值
    this.pending = this.pending ? coalescePatches(this.pending, patch) : patch
    void this.drain()
  }

  /** 标记关闭，丢弃所有 pending 数据，后续 enqueue 调用均被忽略 */
  close(): void {
    this.closed = true
    this.pending = null
  }

  /**
   * 内部排水循环：若无 in-flight 请求且有 pending 数据，则取出并发送。
   *
   * 流程：
   * 1. 若已有 in-flight 或已关闭或无 pending，直接返回
   * 2. 取出 pending，置 inflight = sendWithRetry(payload)
   * 3. sendWithRetry 完成后清除 inflight，若仍有 pending 则递归调用 drain
   */
  private async drain(): Promise<void> {
    if (this.inflight || this.closed) return
    if (!this.pending) return

    const payload = this.pending
    this.pending = null

    this.inflight = this.sendWithRetry(payload).then(() => {
      this.inflight = null
      // 发送完成后若有新的 pending，继续排水
      if (this.pending && !this.closed) {
        void this.drain()
      }
    })
  }

  /**
   * 带指数退避的无限重试发送。
   *
   * 流程：在未关闭的循环中调用 config.send(current)；
   * 成功（返回 true）则直接返回；失败则等待退避时间，
   * 并在等待期间吸收新到的 pending 补丁（合并后一并重试）。
   */
  private async sendWithRetry(payload: Record<string, unknown>): Promise<void> {
    let current = payload
    let failures = 0
    while (!this.closed) {
      const ok = await this.config.send(current)
      if (ok) return

      failures++
      // 等待指数退避时间
      await sleep(this.retryDelay(failures))

      // 退避期间可能有新补丁到达，将其合并到当前 payload 中一并重试
      if (this.pending && !this.closed) {
        current = coalescePatches(current, this.pending)
        this.pending = null
      }
    }
  }

  /** 计算第 failures 次失败后的退避时间（指数 + 随机抖动） */
  private retryDelay(failures: number): number {
    const exponential = Math.min(
      // 2^(failures-1) 倍基础延迟，上限为 maxDelayMs
      this.config.baseDelayMs * 2 ** (failures - 1),
      this.config.maxDelayMs,
    )
    // 加入随机抖动，避免多个实例同时重试（雷群效应）
    const jitter = Math.random() * this.config.jitterMs
    return exponential + jitter
  }
}

/**
 * 合并两个 PUT /worker 补丁（RFC 7396 语义）。
 *
 * 合并规则：
 * - 顶层键（worker_status 等）：overlay 值直接覆盖 base（后来者优先）
 * - external_metadata / internal_metadata 子对象：逐键合并，
 *   overlay 的键覆盖 base 的同名键；null 值保留，服务端收到后执行删除
 *
 * 流程：创建 base 的浅拷贝，遍历 overlay 的每个键值对；
 * 若键为 metadata 类型且两侧均为对象，则执行一层深度的 RFC 7396 合并；
 * 否则 overlay 值直接覆盖。
 */
function coalescePatches(
  base: Record<string, unknown>,
  overlay: Record<string, unknown>,
): Record<string, unknown> {
  const merged = { ...base }  // 浅拷贝 base，避免修改原对象

  for (const [key, value] of Object.entries(overlay)) {
    if (
      // 仅对 metadata 类型的键执行深度合并
      (key === 'external_metadata' || key === 'internal_metadata') &&
      merged[key] &&
      typeof merged[key] === 'object' &&
      typeof value === 'object' &&
      value !== null
    ) {
      // RFC 7396 合并：overlay 键胜出，null 值保留（供服务端删除）
      merged[key] = {
        ...(merged[key] as Record<string, unknown>),
        ...(value as Record<string, unknown>),
      }
    } else {
      // 非 metadata 键：直接覆盖
      merged[key] = value
    }
  }

  return merged
}
