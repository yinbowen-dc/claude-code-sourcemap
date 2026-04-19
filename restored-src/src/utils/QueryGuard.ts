/**
 * 查询生命周期状态机（QueryGuard）。
 *
 * 在 Claude Code 系统中，该模块位于用户输入处理层，负责协调 React UI 与
 * 底层异步查询之间的状态同步。它实现了一个同步状态机，与 React 的
 * `useSyncExternalStore` API 兼容，确保在同一时刻只有一个查询在执行，
 * 防止并发重入。
 *
 * 三种状态：
 *   idle        → 无查询，可以出队并处理新请求
 *   dispatching → 已出队一个条目，异步链尚未到达 onQuery
 *   running     → onQuery 已调用 tryStart()，查询正在执行
 *
 * 状态转换：
 *   idle → dispatching  （reserve）
 *   dispatching → running  （tryStart）
 *   idle → running  （tryStart，用于用户直接提交）
 *   running → idle  （end / forceEnd）
 *   dispatching → idle  （cancelReservation，当 processQueueIfReady 失败时）
 *
 * `isActive` 对 dispatching 和 running 均返回 true，
 * 在异步间隙期间阻止队列处理器重入。
 *
 * Usage with React:
 *   const queryGuard = useRef(new QueryGuard()).current
 *   const isQueryActive = useSyncExternalStore(
 *     queryGuard.subscribe,
 *     queryGuard.getSnapshot,
 *   )
 */
import { createSignal } from './signal.js'

export class QueryGuard {
  // 当前状态：空闲、分派中或运行中
  private _status: 'idle' | 'dispatching' | 'running' = 'idle'
  // 代数生成计数器，用于识别过期的 finally 块
  private _generation = 0
  // 状态变更信号，用于通知订阅者（React useSyncExternalStore）
  private _changed = createSignal()

  /**
   * 为队列处理预留守卫（idle → dispatching）。
   * 若当前非空闲（另一查询或分派中）则返回 false。
   *
   * Reserve the guard for queue processing. Transitions idle → dispatching.
   * Returns false if not idle (another query or dispatch in progress).
   */
  reserve(): boolean {
    if (this._status !== 'idle') return false
    this._status = 'dispatching'
    this._notify()
    return true
  }

  /**
   * 当 processQueueIfReady 无内容可处理时取消预留（dispatching → idle）。
   *
   * Cancel a reservation when processQueueIfReady had nothing to process.
   * Transitions dispatching → idle.
   */
  cancelReservation(): void {
    if (this._status !== 'dispatching') return
    this._status = 'idle'
    this._notify()
  }

  /**
   * 启动一个查询。
   * 成功时返回代数编号，若查询已在运行则返回 null（并发守卫）。
   * 支持从 idle（用户直接提交）和 dispatching（队列处理路径）两种状态转换。
   *
   * Start a query. Returns the generation number on success,
   * or null if a query is already running (concurrent guard).
   */
  tryStart(): number | null {
    if (this._status === 'running') return null
    this._status = 'running'
    ++this._generation
    this._notify()
    return this._generation
  }

  /**
   * 结束一个查询。
   * 若此代数仍为当前代数，返回 true（调用者应执行清理）；
   * 若已有更新的查询启动，返回 false（来自已取消查询的过期 finally 块）。
   *
   * End a query. Returns true if this generation is still current.
   */
  end(generation: number): boolean {
    if (this._generation !== generation) return false
    if (this._status !== 'running') return false
    this._status = 'idle'
    this._notify()
    return true
  }

  /**
   * 强制结束当前查询，无论代数编号。
   * 用于 onCancel 场景，递增代数使过期的 finally 块在比较时看到不匹配而跳过清理。
   *
   * Force-end the current query regardless of generation.
   */
  forceEnd(): void {
    if (this._status === 'idle') return
    this._status = 'idle'
    ++this._generation
    this._notify()
  }

  /**
   * 守卫是否激活（dispatching 或 running）？
   * 始终同步，不受 React 状态批处理延迟影响。
   *
   * Is the guard active (dispatching or running)?
   */
  get isActive(): boolean {
    return this._status !== 'idle'
  }

  get generation(): number {
    return this._generation
  }

  // --
  // useSyncExternalStore interface

  /** 订阅状态变更。稳定引用，可安全用作 useEffect 依赖。 */
  subscribe = this._changed.subscribe

  /** useSyncExternalStore 的快照函数，返回 isActive。 */
  getSnapshot = (): boolean => {
    return this._status !== 'idle'
  }

  /** 发出状态变更通知 */
  private _notify(): void {
    this._changed.emit()
  }
}
