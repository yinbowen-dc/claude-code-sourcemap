/**
 * 异步生成器工具模块（Async Generator Utilities）。
 *
 * 【在 Claude Code 系统中的位置】
 * 该模块是底层并发与流式处理的核心工具集，被工具执行引擎、搜索管道等
 * 需要并发处理多个异步数据流的模块广泛调用。
 * 典型使用场景：并发执行多个工具调用并流式输出结果、将数组转换为生成器管道。
 *
 * 【主要功能】
 * - NO_VALUE 符号：用于区分"尚未产生值"与"值为 undefined"的哨兵值
 * - QueuedGenerator 类型：内部队列节点，绑定生成器与其当前 Promise
 * - lastX：消费整个异步生成器并返回最后一个值
 * - returnValue：消费异步生成器直到完成并返回其 return 值（非 yield 值）
 * - all：并发运行多个异步生成器（带并发上限），按到达顺序 yield 结果
 * - toArray：将异步生成器的所有 yield 值收集为数组
 * - fromArray：将普通数组包装为异步生成器
 */

/** 哨兵符号，用于标记"尚未产生任何值"的状态，区别于值为 undefined 的情况 */
const NO_VALUE = Symbol('NO_VALUE')

/**
 * 消费整个异步生成器，返回最后一个被 yield 的值。
 *
 * 【流程】
 * 1. 遍历生成器的全部 yield 值，每次更新 lastValue；
 * 2. 遍历结束后，若从未产生任何值（lastValue 仍为哨兵），抛出错误；
 * 3. 返回最后一个值。
 *
 * @param as - 待消费的异步生成器
 * @returns 最后一个 yield 的值
 * @throws 若生成器未产生任何值
 */
export async function lastX<A>(as: AsyncGenerator<A>): Promise<A> {
  let lastValue: A | typeof NO_VALUE = NO_VALUE // 初始化为哨兵，表示尚未取到值
  for await (const a of as) {
    lastValue = a // 每次迭代更新为最新值
  }
  if (lastValue === NO_VALUE) {
    throw new Error('No items in generator') // 生成器为空，抛出错误
  }
  return lastValue
}

/**
 * 消费异步生成器直到其完成（done=true），并返回生成器的 return 值。
 *
 * 【流程】
 * 1. 反复调用 as.next()，直到 done 为 true；
 * 2. 返回 IteratorResult.value（即 return 语句的返回值，而非 yield 的值）。
 *
 * @param as - 带返回值类型 A 的异步生成器
 * @returns 生成器的最终 return 值（非 yield 值）
 */
export async function returnValue<A>(
  as: AsyncGenerator<unknown, A>,
): Promise<A> {
  let e
  do {
    e = await as.next() // 推进生成器直到完成
  } while (!e.done)
  return e.value // 返回最终值（return 语句的值）
}

/**
 * 内部队列节点类型，将生成器与其下一次 next() 的 Promise 绑定在一起，
 * 用于在 all() 函数中通过 Promise.race 调度多个并发生成器。
 */
type QueuedGenerator<A> = {
  done: boolean | void          // 该次 next() 是否已完成
  value: A | void               // 本次 yield 的值
  generator: AsyncGenerator<A, void>  // 对应的生成器引用
  promise: Promise<QueuedGenerator<A>>  // 该节点自身的 Promise（用于从 Set 中精确删除）
}

/**
 * 并发运行多个异步生成器（带可选并发上限），按到达顺序 yield 每个值。
 *
 * 【流程】
 * 1. 将所有生成器放入等待队列；
 * 2. 按并发上限启动初始批次，每个生成器调用 next() 并包装为 QueuedGenerator；
 * 3. 通过 Promise.race 等待最快完成的那个；
 * 4. 若未完成（done=false）：yield 值，并为同一生成器启动下一次 next()；
 * 5. 若已完成（done=true）：从等待队列取出下一个生成器并启动；
 * 6. 重复直到所有生成器均完成且 Promise 集合为空。
 *
 * @param generators - 待并发运行的异步生成器数组
 * @param concurrencyCap - 最大并发数，默认为 Infinity（无限制）
 * @yields 各生成器产生的值，按实际到达顺序输出
 */
// 并发运行所有生成器（带并发上限），按到达顺序 yield 值
export async function* all<A>(
  generators: AsyncGenerator<A, void>[],
  concurrencyCap = Infinity,
): AsyncGenerator<A, void> {
  // 将生成器的 next() 调用包装为 QueuedGenerator Promise，便于 Promise.race 识别来源
  const next = (generator: AsyncGenerator<A, void>) => {
    const promise: Promise<QueuedGenerator<A>> = generator
      .next()
      .then(({ done, value }) => ({
        done,
        value,
        generator,
        promise, // 循环引用自身，用于从 Set 中删除
      }))
    return promise
  }
  const waiting = [...generators]                         // 等待启动的生成器队列
  const promises = new Set<Promise<QueuedGenerator<A>>>() // 当前活跃的 Promise 集合

  // 按并发上限启动初始批次
  while (promises.size < concurrencyCap && waiting.length > 0) {
    const gen = waiting.shift()! // 取出队首生成器
    promises.add(next(gen))      // 启动并加入活跃集合
  }

  while (promises.size > 0) {
    // 等待最快完成的 Promise
    const { done, value, generator, promise } = await Promise.race(promises)
    promises.delete(promise) // 从活跃集合中移除已完成的 Promise

    if (!done) {
      // 生成器尚未结束：为其启动下一次 next()，并 yield 当前值
      promises.add(next(generator))
      // TODO: Clean this up
      if (value !== undefined) {
        yield value // 将值传递给调用方
      }
    } else if (waiting.length > 0) {
      // 当前生成器已完成：从等待队列启动一个新生成器以维持并发数
      const nextGen = waiting.shift()!
      promises.add(next(nextGen))
    }
  }
}

/**
 * 将异步生成器的所有 yield 值收集到数组并返回。
 *
 * @param generator - 待收集的异步生成器
 * @returns 所有 yield 值组成的数组
 */
export async function toArray<A>(
  generator: AsyncGenerator<A, void>,
): Promise<A[]> {
  const result: A[] = []
  for await (const a of generator) {
    result.push(a) // 逐个追加到结果数组
  }
  return result
}

/**
 * 将普通数组包装为异步生成器，逐个 yield 每个元素。
 *
 * 常用于将静态数据注入需要异步生成器的管道（如 all() 函数）。
 *
 * @param values - 待转换的值数组
 * @yields 数组中的每个元素
 */
export async function* fromArray<T>(values: T[]): AsyncGenerator<T, void> {
  for (const value of values) {
    yield value // 逐个 yield 数组元素
  }
}
