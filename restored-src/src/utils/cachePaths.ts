/**
 * 缓存路径管理模块。
 *
 * 在 Claude Code 系统中，该模块提供各类缓存目录路径的统一计算方式，
 * 基于 env-paths 获取平台标准缓存根目录，以当前工作目录的 djb2 哈希作为子目录名：
 * - CACHE_PATHS.baseLogs()：当前项目的日志根目录
 * - CACHE_PATHS.errors()：错误日志目录
 * - CACHE_PATHS.messages()：消息记录目录
 * - CACHE_PATHS.mcpLogs(serverName)：指定 MCP 服务端的日志目录
 *
 * 路径名净化（sanitizePath）使用 djb2Hash 而非 Bun.hash（wyhash），
 * 确保缓存目录名跨版本升级保持稳定，防止旧缓存数据孤立。
 */
import envPaths from 'env-paths'
import { join } from 'path'
import { getFsImplementation } from './fsOperations.js'
import { djb2Hash } from './hash.js'

const paths = envPaths('claude-cli')

// Local sanitizePath using djb2Hash — NOT the shared version from
// sessionStoragePortable.ts which uses Bun.hash (wyhash) when available.
// Cache directory names must remain stable across upgrades so existing cache
// data (error logs, MCP logs) is not orphaned.
const MAX_SANITIZED_LENGTH = 200
function sanitizePath(name: string): string {
  const sanitized = name.replace(/[^a-zA-Z0-9]/g, '-')
  if (sanitized.length <= MAX_SANITIZED_LENGTH) {
    return sanitized
  }
  return `${sanitized.slice(0, MAX_SANITIZED_LENGTH)}-${Math.abs(djb2Hash(name)).toString(36)}`
}

function getProjectDir(cwd: string): string {
  return sanitizePath(cwd)
}

export const CACHE_PATHS = {
  baseLogs: () => join(paths.cache, getProjectDir(getFsImplementation().cwd())),
  errors: () =>
    join(paths.cache, getProjectDir(getFsImplementation().cwd()), 'errors'),
  messages: () =>
    join(paths.cache, getProjectDir(getFsImplementation().cwd()), 'messages'),
  mcpLogs: (serverName: string) =>
    join(
      paths.cache,
      getProjectDir(getFsImplementation().cwd()),
      // Sanitize server name for Windows compatibility (colons are reserved for drive letters)
      `mcp-logs-${sanitizePath(serverName)}`,
    ),
}
