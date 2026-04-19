/**
 * 文件读取缓存模块。
 *
 * 在 Claude Code 系统中，该模块为文件读取操作提供内存缓存层，
 * 避免对同一文件进行重复 I/O 操作，提升工具链（如 Read/Edit）的响应速度：
 * - 缓存 key 为文件路径，value 为文件内容字符串与编码信息
 * - 通过 mtime/size 变更检测自动失效缓存条目
 * - 由 file.ts 在读取前统一查询，写入后主动淘汰对应缓存
 */
/**
 * 文件读取缓存模块。
 *
 * 在 Claude Code 系统中，该模块为文件读取操作提供内存缓存层，
 * 避免对同一文件进行重复 I/O 操作，提升工具链（如 Read/Edit）的响应速度：
 * - 缓存 key 为文件路径，value 为文件内容字符串与编码信息
 * - 通过 mtime/size 变更检测自动失效缓存条目
 * - 由 file.ts 在读取前统一查询，写入后主动淘汰对应缓存
 */
import { detectFileEncoding } from './file.js'
import { getFsImplementation } from './fsOperations.js'

type CachedFileData = {
  content: string
  encoding: BufferEncoding
  mtime: number
}

/**
 * A simple in-memory cache for file contents with automatic invalidation based on modification time.
 * This eliminates redundant file reads in FileEditTool operations.
 */
class FileReadCache {
  private cache = new Map<string, CachedFileData>()
  private readonly maxCacheSize = 1000

  /**
   * Reads a file with caching. Returns both content and encoding.
   * Cache key includes file path and modification time for automatic invalidation.
   */
  readFile(filePath: string): { content: string; encoding: BufferEncoding } {
    const fs = getFsImplementation()

    // Get file stats for cache invalidation
    let stats
    try {
      stats = fs.statSync(filePath)
    } catch (error) {
      // File was deleted, remove from cache and re-throw
      this.cache.delete(filePath)
      throw error
    }

    const cacheKey = filePath
    const cachedData = this.cache.get(cacheKey)

    // Check if we have valid cached data
    if (cachedData && cachedData.mtime === stats.mtimeMs) {
      return {
        content: cachedData.content,
        encoding: cachedData.encoding,
      }
    }

    // Cache miss or stale data - read the file
    const encoding = detectFileEncoding(filePath)
    const content = fs
      .readFileSync(filePath, { encoding })
      .replaceAll('\r\n', '\n')

    // Update cache
    this.cache.set(cacheKey, {
      content,
      encoding,
      mtime: stats.mtimeMs,
    })

    // Evict oldest entries if cache is too large
    if (this.cache.size > this.maxCacheSize) {
      const firstKey = this.cache.keys().next().value
      if (firstKey) {
        this.cache.delete(firstKey)
      }
    }

    return { content, encoding }
  }

  /**
   * Clears the entire cache. Useful for testing or memory management.
   */
  clear(): void {
    this.cache.clear()
  }

  /**
   * Removes a specific file from the cache.
   */
  invalidate(filePath: string): void {
    this.cache.delete(filePath)
  }

  /**
   * Gets cache statistics for debugging/monitoring.
   */
  getStats(): { size: number; entries: string[] } {
    return {
      size: this.cache.size,
      entries: Array.from(this.cache.keys()),
    }
  }
}

// Export a singleton instance
export const fileReadCache = new FileReadCache()
