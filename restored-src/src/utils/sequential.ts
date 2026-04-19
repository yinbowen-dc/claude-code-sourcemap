/**
 * 顺序执行队列包装器模块
 *
 * 在 Claude Code 系统中的位置：
 * 并发控制层 → 文件写入 / 数据库操作等需要串行化的异步场景 → sequential
 *
 * 主要功能：
 * 将任意异步函数包装成"串行执行"版本，保证并发调用时按到达顺序逐一执行，
 * 彻底消除竞态条件，同时正确地将返回值/异常路由回各自的调用方。
 */

/**
 * 队列项类型：描述等待执行的一次函数调用所需的全部信息
 *
 * @template T - 被包装函数的参数元组类型
 * @template R - 被包装函数的返回值类型
 *
 * 字段说明：
 * - args:    调用时传入的参数列表
 * - resolve: 对应 Promise 的 resolve 回调，执行成功后调用
 * - reject:  对应 Promise 的 reject 回调，执行失败后调用
 * - context: 调用时的 this 上下文，保持函数绑定语义
 */
type QueueItem<T extends unknown[], R> = {
  args: T
  resolve: (value: R) => void
  reject: (reason?: unknown) => void
  context: unknown
}

/**
 * 将异步函数包装为顺序（串行）执行版本，防止并发竞争条件
 *
 * 核心机制：
 * - 内部维护一个 QueueItem 数组（queue）和一个 processing 标志
 * - 每次调用都将 {args, resolve, reject, context} 推入队列，然后尝试启动消费
 * - 若 processing === true，说明已有执行循环在跑，直接返回，新项会被现有循环处理
 * - 若 processing === false，启动 processQueue() 开始消费队列
 * - processQueue() 循环取出队头项执行，执行完成（成功或失败）后继续取下一项
 * - 循环结束（queue 空）后重置 processing = false，并再次检查是否有并发期间新增的项
 *
 * 适用场景：文件写入、JSONL 追加、数据库更新等不可并发的操作
 *
 * @param fn - 需要串行化的原始异步函数
 * @returns 具有相同签名、但调用被串行化的包装函数
 */
export function sequential<T extends unknown[], R>(
  fn: (...args: T) => Promise<R>,
): (...args: T) => Promise<R> {
  // 等待执行的调用队列
  const queue: QueueItem<T, R>[] = []
  // 标志位：当前是否有消费循环正在运行
  let processing = false

  /**
   * 内部队列消费循环
   *
   * 每次启动时先检查 processing 标志，避免重入（两处调用会同时消费同一队列）。
   * while 循环逐一取出队头任务，串行 await 执行，并将结果/异常分发给对应的 Promise。
   * 结束后先清 processing，再检查是否有在 while 循环中途新入队的项，若有则再次触发。
   */
  async function processQueue(): Promise<void> {
    // 防止重入：若已有循环在运行则直接返回
    if (processing) return
    // 队列为空时无需启动
    if (queue.length === 0) return

    processing = true

    while (queue.length > 0) {
      // 取出队头，queue.shift() 返回值一定非空（已判断 length > 0）
      const { args, resolve, reject, context } = queue.shift()!

      try {
        // 使用原始 this 上下文执行被包装函数
        const result = await fn.apply(context, args)
        resolve(result)
      } catch (error) {
        reject(error)
      }
    }

    // 结束本次循环，清除处理标志
    processing = false

    // 处理循环进行期间可能新增的队列项
    if (queue.length > 0) {
      void processQueue()
    }
  }

  // 返回的包装函数：将调用入队，并返回对应 Promise
  return function (this: unknown, ...args: T): Promise<R> {
    return new Promise((resolve, reject) => {
      // 将本次调用的所有信息存入队列
      queue.push({ args, resolve, reject, context: this })
      // 尝试启动消费（若已在运行则 processQueue 内部会跳过）
      void processQueue()
    })
  }
}
