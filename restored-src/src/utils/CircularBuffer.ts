/**
 * 固定大小循环缓冲区数据结构。
 *
 * 在 Claude Code 系统中，该模块被用于维护滚动窗口数据（如最近的日志行、
 * 输出内容片段等），当缓冲区满时自动淘汰最旧的条目，避免无限增长。
 *
 * 典型使用场景：
 * - 保留最近 N 条 shell 命令输出行用于进度显示
 * - 维护有界大小的事件历史记录
 */

/**
 * A fixed-size circular buffer that automatically evicts the oldest items
 * when the buffer is full. Useful for maintaining a rolling window of data.
 */
export class CircularBuffer<T> {
  // 底层存储数组，长度固定为 capacity
  private buffer: T[]
  // 下一个写入位置的索引（环形移动）
  private head = 0
  // 当前实际存储的元素数量（最大为 capacity）
  private size = 0

  constructor(private capacity: number) {
    // 预分配固定大小的数组，避免动态扩容
    this.buffer = new Array(capacity)
  }

  /**
   * 向缓冲区添加一个元素。
   * 若缓冲区已满，最旧的元素将被自动覆盖（循环写入）。
   *
   * Add an item to the buffer. If the buffer is full,
   * the oldest item will be evicted.
   */
  add(item: T): void {
    // 将新元素写入当前 head 位置
    this.buffer[this.head] = item
    // head 向前移动一位，到达末尾时循环回 0
    this.head = (this.head + 1) % this.capacity
    // 仅在未满时增加 size，满后 size 保持等于 capacity
    if (this.size < this.capacity) {
      this.size++
    }
  }

  /**
   * 批量添加多个元素到缓冲区，依次调用 add()。
   *
   * Add multiple items to the buffer at once.
   */
  addAll(items: T[]): void {
    for (const item of items) {
      this.add(item)
    }
  }

  /**
   * 获取缓冲区中最近的 N 个元素（按时间顺序，最旧在前）。
   * 若缓冲区中元素不足 N 个，则返回所有现有元素。
   *
   * Get the most recent N items from the buffer.
   * Returns fewer items if the buffer contains less than N items.
   */
  getRecent(count: number): T[] {
    const result: T[] = []
    // 若缓冲区未满，起始读取位置为 0；否则从 head（最旧元素）开始
    const start = this.size < this.capacity ? 0 : this.head
    // 实际可返回的元素数不超过当前 size
    const available = Math.min(count, this.size)

    for (let i = 0; i < available; i++) {
      // 计算第 i 个元素在底层数组中的实际索引
      const index = (start + this.size - available + i) % this.capacity
      result.push(this.buffer[index]!)
    }

    return result
  }

  /**
   * 以从旧到新的顺序返回缓冲区中所有元素。
   *
   * Get all items currently in the buffer, in order from oldest to newest.
   */
  toArray(): T[] {
    if (this.size === 0) return []

    const result: T[] = []
    // 若缓冲区未满，从索引 0 开始；否则从 head（最旧元素位置）开始
    const start = this.size < this.capacity ? 0 : this.head

    for (let i = 0; i < this.size; i++) {
      // 按环形顺序逐个读取元素
      const index = (start + i) % this.capacity
      result.push(this.buffer[index]!)
    }

    return result
  }

  /**
   * 清空缓冲区，重置所有状态。
   *
   * Clear all items from the buffer.
   */
  clear(): void {
    this.buffer.length = 0
    this.head = 0
    this.size = 0
  }

  /**
   * 返回当前缓冲区中存储的元素数量。
   *
   * Get the current number of items in the buffer.
   */
  length(): number {
    return this.size
  }
}
