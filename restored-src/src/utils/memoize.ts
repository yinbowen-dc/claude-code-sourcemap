/**
 * 函数记忆化（Memoize）工具模块。
 *
 * 在 Claude Code 系统中，该模块为高频调用的纯函数和异步函数提供缓存层，
 * 降低重复计算和 I/O 开销：
 * - memoizeWithTTL()：基于 TTL 的同步函数记忆化（后台刷新，返回过期值）
 * - memoizeWithTTLAsync()：基于 TTL 的异步函数记忆化（含 inFlight 请求去重）
 * - memoizeWithLRU()：基于 LRU 淘汰策略的记忆化（防止无界内存增长）
 *
 * 所有三种实现均支持 cache.clear()；LRU 版本额外暴露 size/delete/get/has 方法。
 * TTL 系列默认缓存 5 分钟；LRU 系列默认最大缓存 100 条。
 */
import { LRUCache } from 'lru-cache'
import { logError } from './log.js'
import { jsonStringify } from './slowOperations.js'

type CacheEntry<T> = {
  value: T
  timestamp: number
  refreshing: boolean
}

type MemoizedFunction<Args extends unknown[], Result> = {
  (...args: Args): Result
  cache: {
    clear: () => void
  }
}

type LRUMemoizedFunction<Args extends unknown[], Result> = {
  (...args: Args): Result
  cache: {
    clear: () => void
    size: () => number
    delete: (key: string) => boolean
    get: (key: string) => Result | undefined
    has: (key: string) => boolean
  }
}

/**
 * 带 TTL 的同步函数记忆化（写透缓存模式）。
 *
 * 缓存行为：
 * - 缓存新鲜 → 立即返回缓存值；
 * - 缓存过期 → 返回过期值，同时在后台异步刷新（SWR 模式，不阻塞调用方）；
 * - 无缓存   → 同步计算并缓存后返回。
 *
 * 并发安全：后台刷新和 cache.clear() 均通过 identity-guard（比较 entry 引用）保护，
 * 防止 clear() 后的冷缺失被过期刷新结果覆盖。
 *
 * @param f 需要记忆化的同步函数
 * @param cacheLifetimeMs 缓存有效期（毫秒），默认 5 分钟
 * Creates a memoized function that returns cached values while refreshing in parallel.
 * This implements a write-through cache pattern:
 * - If cache is fresh, return immediately
 * - If cache is stale, return the stale value but refresh it in the background
 * - If no cache exists, block and compute the value
 *
 * @param f The function to memoize
 * @param cacheLifetimeMs The lifetime of cached values in milliseconds
 * @returns A memoized version of the function
 */
export function memoizeWithTTL<Args extends unknown[], Result>(
  f: (...args: Args) => Result,
  cacheLifetimeMs: number = 5 * 60 * 1000, // Default 5 minutes
): MemoizedFunction<Args, Result> {
  const cache = new Map<string, CacheEntry<Result>>()

  const memoized = (...args: Args): Result => {
    const key = jsonStringify(args)
    const cached = cache.get(key)
    const now = Date.now()

    // 缓存未命中，同步计算并存入缓存
    // Populate cache
    if (!cached) {
      const value = f(...args)
      cache.set(key, {
        value,
        timestamp: now,
        refreshing: false,
      })
      return value
    }

    // 缓存已过期且未在刷新中：标记为刷新中，后台异步更新，立即返回过期值
    // If we have a stale cache entry and it's not already refreshing
    if (
      cached &&
      now - cached.timestamp > cacheLifetimeMs &&
      !cached.refreshing
    ) {
      // 标记为刷新中，防止并发多次触发后台刷新
      // Mark as refreshing to prevent multiple parallel refreshes
      cached.refreshing = true

      // 后台异步刷新（非阻塞）。.then 和 .catch 均做 identity-guard：
      // 若并发的 cache.clear() + 冷缺失在此 microtask 队列等待期间存入了新条目，
      // 以刷新结果覆盖新条目（.then）比以删除（.catch）更差——
      // 前者导致错误数据持续整个 TTL，后者下次调用可自我修复。
      // Schedule async refresh (non-blocking). Both .then and .catch are
      // identity-guarded: a concurrent cache.clear() + cold-miss stores a
      // newer entry while this microtask is queued. .then overwriting with
      // the stale refresh's result is worse than .catch deleting (persists
      // wrong data for full TTL vs. self-correcting on next call).
      Promise.resolve()
        .then(() => {
          const newValue = f(...args)
          if (cache.get(key) === cached) {
            cache.set(key, {
              value: newValue,
              timestamp: Date.now(),
              refreshing: false,
            })
          }
        })
        .catch(e => {
          logError(e)
          if (cache.get(key) === cached) {
            cache.delete(key) // 刷新失败则删除缓存，下次调用重新计算
          }
        })

      // 立即返回过期值（非阻塞）
      // Return the stale value immediately
      return cached.value
    }

    return cache.get(key)!.value
  }

  // 暴露 cache.clear() 方法供外部手动清除缓存
  // Add cache clear method
  memoized.cache = {
    clear: () => cache.clear(),
  }

  return memoized
}

/**
 * 带 TTL 的异步函数记忆化（写透缓存模式，含冷缺失请求去重）。
 *
 * 相比同步版本额外引入 inFlight Map 做并发冷缺失去重：
 * 同步版本在第一个 await 之前同步存入 Promise，天然合并并发调用；
 * 异步版本 await 完成后才写入 cache，若多个调用同时冷缺失
 * 则各自独立调用 f()（如并发的 `aws sso login`）。
 * inFlight Map 确保同一 key 的并发冷缺失只发起一次 f() 调用。
 * （参考 auth.ts 中 pending401Handlers 的相同模式）
 *
 * 缓存行为与同步版本相同（SWR 刷新 + identity-guard）。
 *
 * Creates a memoized async function that returns cached values while refreshing in parallel.
 * This implements a write-through cache pattern for async functions:
 * - If cache is fresh, return immediately
 * - If cache is stale, return the stale value but refresh it in the background
 * - If no cache exists, block and compute the value
 *
 * @param f The async function to memoize
 * @param cacheLifetimeMs The lifetime of cached values in milliseconds
 * @returns A memoized version of the async function
 */
export function memoizeWithTTLAsync<Args extends unknown[], Result>(
  f: (...args: Args) => Promise<Result>,
  cacheLifetimeMs: number = 5 * 60 * 1000, // Default 5 minutes
): ((...args: Args) => Promise<Result>) & { cache: { clear: () => void } } {
  const cache = new Map<string, CacheEntry<Result>>()
  // 冷缺失并发去重 Map。
  // 旧版 memoizeWithTTL（同步）偶然提供了此能力：在第一个 await 之前同步存入 Promise，
  // 并发调用者因此共享同一个 f() 调用。异步版本 await 后才写入 cache，
  // 若无 inFlight 则并发冷缺失会各自触发 f()（如 refreshAndGetAwsCredentials 并发多次 `aws sso login`）。
  // 与 auth.ts:1171 中 pending401Handlers 使用相同模式。
  // In-flight cold-miss dedup. The old memoizeWithTTL (sync) accidentally
  // provided this: it stored the Promise synchronously before the first
  // await, so concurrent callers shared one f() invocation. This async
  // variant awaits before cache.set, so concurrent cold-miss callers would
  // each invoke f() independently without this map. For
  // refreshAndGetAwsCredentials that means N concurrent `aws sso login`
  // spawns. Same pattern as pending401Handlers in auth.ts:1171.
  const inFlight = new Map<string, Promise<Result>>()

  const memoized = async (...args: Args): Promise<Result> => {
    const key = jsonStringify(args)
    const cached = cache.get(key)
    const now = Date.now()

    // 冷缺失：检查是否有 inFlight 请求，有则复用；否则发起新请求
    // Populate cache - if this throws, nothing gets cached
    if (!cached) {
      const pending = inFlight.get(key)
      if (pending) return pending // 复用已在飞的请求
      const promise = f(...args)
      inFlight.set(key, promise)
      try {
        const result = await promise
        // identity-guard：若在 await 期间 cache.clear() 被调用，
        // inFlight 也被清空，此处检查确保不将过期结果存回新 cache。
        // Identity-guard: cache.clear() during the await should discard this
        // result (clear intent is to invalidate). If we're still in-flight,
        // store it. clear() wipes inFlight too, so this check catches that.
        if (inFlight.get(key) === promise) {
          cache.set(key, {
            value: result,
            timestamp: now,
            refreshing: false,
          })
        }
        return result
      } finally {
        if (inFlight.get(key) === promise) {
          inFlight.delete(key) // 请求完成后清理 inFlight 条目
        }
      }
    }

    // 缓存过期且未在刷新：后台异步更新，立即返回过期值
    // If we have a stale cache entry and it's not already refreshing
    if (
      cached &&
      now - cached.timestamp > cacheLifetimeMs &&
      !cached.refreshing
    ) {
      // 标记为刷新中，防止并发多次触发后台刷新
      // Mark as refreshing to prevent multiple parallel refreshes
      cached.refreshing = true

      // 后台刷新的 identity-guard 与同步版本相同：
      // 防止过期刷新结果覆盖 clear() + 冷缺失存入的新条目。
      // .then 覆盖（持续错误数据整个 TTL）比 .catch 删除（下次调用自愈）更差。
      // Schedule async refresh (non-blocking). Both .then and .catch are
      // identity-guarded against a concurrent cache.clear() + cold-miss
      // storing a newer entry while this refresh is in flight. .then
      // overwriting with the stale refresh's result is worse than .catch
      // deleting - wrong data persists for full TTL (e.g. credentials from
      // the old awsAuthRefresh command after a settings change).
      const staleEntry = cached
      f(...args)
        .then(newValue => {
          if (cache.get(key) === staleEntry) {
            cache.set(key, {
              value: newValue,
              timestamp: Date.now(),
              refreshing: false,
            })
          }
        })
        .catch(e => {
          logError(e)
          if (cache.get(key) === staleEntry) {
            cache.delete(key) // 刷新失败则删除缓存，下次调用重新请求
          }
        })

      // 立即返回过期值（非阻塞）
      // Return the stale value immediately
      return cached.value
    }

    return cache.get(key)!.value
  }

  // cache.clear() 同时清理 inFlight：
  // clear() 期间若有冷缺失 await 在途，不应让过期的 inFlight Promise 返回给下一个调用方
  // （违背 clear() 的失效语义）。try/finally 中的 identity-guard 确保 inFlight
  // 条目的删除不会误删 clear()+冷缺失 后存入的新条目。
  // Add cache clear method. Also clear inFlight: clear() during a cold-miss
  // await should not let the stale in-flight promise be returned to the next
  // caller (defeats the purpose of clear). The try/finally above
  // identity-guards inFlight.delete so the stale promise doesn't delete a
  // fresh one if clear+cold-miss happens before the finally fires.
  memoized.cache = {
    clear: () => {
      cache.clear()
      inFlight.clear()
    },
  }

  return memoized as ((...args: Args) => Promise<Result>) & {
    cache: { clear: () => void }
  }
}

/**
 * Creates a memoized function with LRU (Least Recently Used) eviction policy.
 * This prevents unbounded memory growth by evicting the least recently used entries
 * when the cache reaches its maximum size.
 *
 * Note: Cache size for memoized message processing functions
 * Chosen to prevent unbounded memory growth (was 300MB+ with lodash memoize)
 * while maintaining good cache hit rates for typical conversations.
 *
 * @param f The function to memoize
 * @returns A memoized version of the function with cache management methods
 */
export function memoizeWithLRU<
  Args extends unknown[],
  Result extends NonNullable<unknown>,
>(
  f: (...args: Args) => Result,
  cacheFn: (...args: Args) => string,
  maxCacheSize: number = 100,
): LRUMemoizedFunction<Args, Result> {
  const cache = new LRUCache<string, Result>({
    max: maxCacheSize,
  })

  const memoized = (...args: Args): Result => {
    const key = cacheFn(...args)
    const cached = cache.get(key)
    if (cached !== undefined) {
      return cached
    }

    const result = f(...args)
    cache.set(key, result)
    return result
  }

  // Add cache management methods
  memoized.cache = {
    clear: () => cache.clear(),
    size: () => cache.size,
    delete: (key: string) => cache.delete(key),
    // peek() avoids updating recency — we only want to observe, not promote
    get: (key: string) => cache.peek(key),
    has: (key: string) => cache.has(key),
  }

  return memoized
}
