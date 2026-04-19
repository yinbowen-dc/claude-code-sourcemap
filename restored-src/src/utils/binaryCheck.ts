/**
 * 系统二进制文件存在性检测模块。
 *
 * 在 Claude Code 系统中，该模块用于检测指定命令（如 gopls、rust-analyzer 等语言服务器）
 * 是否已安装并可在系统 PATH 中找到：
 * - isBinaryInstalled()：使用 which 工具检测命令是否可用，结果缓存于会话级 Map
 * - clearBinaryCache()：清除检测缓存（用于测试重置）
 */
import { logForDebugging } from './debug.js'
import { which } from './which.js'

// Session cache to avoid repeated checks
const binaryCache = new Map<string, boolean>()

/**
 * 检测指定二进制命令是否已安装并可在系统 PATH 中找到。
 * 结果缓存于会话级 Map，避免重复调用 which 命令。
 * Unix（macOS/Linux/WSL）使用 which，Windows 使用 where。
 *
 * @param command - 待检测的命令名称（如 'gopls'、'rust-analyzer'）
 * @returns 若命令存在则返回 true，否则返回 false
 */
export async function isBinaryInstalled(command: string): Promise<boolean> {
  // Edge case: empty or whitespace-only command
  if (!command || !command.trim()) {
    logForDebugging('[binaryCheck] Empty command provided, returning false')
    return false
  }

  // Trim the command to handle whitespace
  const trimmedCommand = command.trim()

  // Check cache first
  const cached = binaryCache.get(trimmedCommand)
  if (cached !== undefined) {
    logForDebugging(
      `[binaryCheck] Cache hit for '${trimmedCommand}': ${cached}`,
    )
    return cached
  }

  let exists = false
  if (await which(trimmedCommand).catch(() => null)) {
    exists = true
  }

  // Cache the result
  binaryCache.set(trimmedCommand, exists)

  logForDebugging(
    `[binaryCheck] Binary '${trimmedCommand}' ${exists ? 'found' : 'not found'}`,
  )

  return exists
}

/** 清除二进制检测缓存（用于测试重置）。 */
export function clearBinaryCache(): void {
  binaryCache.clear()
}
