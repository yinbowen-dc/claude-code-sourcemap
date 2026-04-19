/**
 * flushGate.ts — Bridge 初始刷新期间的消息写入门控状态机
 *
 * 在 Claude Code 系统流程中的位置：
 *   Bridge 传输层（replBridgeTransport.ts / remoteBridgeCore.ts）
 *     └─> flushGate.ts（本文件）——防止历史消息刷新与新消息的乱序写入
 *
 * 背景：
 *   当 Bridge 会话启动时，历史消息通过单次 HTTP POST 批量刷新到服务器。
 *   在刷新期间，新产生的消息（工具调用结果、流式输出等）必须被缓冲，
 *   防止它们与历史消息交织到达服务器，导致顺序混乱。
 *
 * 生命周期：
 *   start()    → 激活门控，enqueue() 开始排队缓冲
 *   end()      → 关闭门控，返回已缓冲的消息供调用方发送，enqueue() 恢复直通
 *   drop()     → 丢弃所有缓冲消息（传输层永久关闭时清理）
 *   deactivate() → 仅清除活跃标志，不丢弃缓冲消息
 *                  （传输替换场景——新传输层的 flush 会排空缓冲）
 *
 * State machine for gating message writes during an initial flush.
 *
 * When a bridge session starts, historical messages are flushed to the
 * server via a single HTTP POST. During that flush, new messages must
 * be queued to prevent them from arriving at the server interleaved
 * with the historical messages.
 *
 * Lifecycle:
 *   start() → enqueue() returns true, items are queued
 *   end()   → returns queued items for draining, enqueue() returns false
 *   drop()  → discards queued items (permanent transport close)
 *   deactivate() → clears active flag without dropping items
 *                   (transport replacement — new transport will drain)
 */
export class FlushGate<T> {
  private _active = false   // 是否处于刷新期间（门控激活）
  private _pending: T[] = [] // 刷新期间缓冲的消息队列

  /** 门控是否激活（刷新进行中） */
  get active(): boolean {
    return this._active
  }

  /** 当前缓冲的消息数量 */
  get pendingCount(): number {
    return this._pending.length
  }

  /**
   * 激活门控，标记刷新开始。
   * 调用后 enqueue() 将开始缓冲消息而非直接发送。
   */
  start(): void {
    this._active = true
  }

  /**
   * 关闭门控，标记刷新结束。
   * 返回所有已缓冲的消息（供调用方按顺序发送），并清空缓冲区。
   * 调用后 enqueue() 恢复直通模式（返回 false）。
   */
  end(): T[] {
    this._active = false
    return this._pending.splice(0) // 清空并返回所有缓冲消息
  }

  /**
   * 若门控激活，将消息入队并返回 true（调用方不发送）；
   * 若门控未激活，返回 false（调用方应直接发送）。
   */
  enqueue(...items: T[]): boolean {
    if (!this._active) return false
    this._pending.push(...items) // 缓冲消息到队列
    return true
  }

  /**
   * 丢弃所有缓冲消息（传输层永久关闭时清理）。
   * 同时停用门控，返回被丢弃的消息数量。
   */
  drop(): number {
    this._active = false
    const count = this._pending.length
    this._pending.length = 0 // 清空缓冲区
    return count
  }

  /**
   * 仅清除门控激活标志，不丢弃已缓冲的消息。
   *
   * 用于传输层替换场景（onWorkReceived）：
   * 旧传输层关闭但仍有缓冲消息，新传输层的刷新流程
   * 会在建连后排空这些缓冲消息，保证消息不丢失。
   */
  deactivate(): void {
    this._active = false
  }
}
