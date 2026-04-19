/**
 * 可执行文件查找模块。
 *
 * 在 Claude Code 系统中，该模块提供轻量的可执行文件路径解析工具，
 * 替代 spawn-rx 的 findActualExecutable 以避免引入 rxjs（约 313 KB）依赖：
 * - findExecutable()：在 PATH 中搜索给定名称的可执行文件（类似 which 命令）
 * - 返回 { cmd, args } 结构以兼容 spawn-rx 的 API 形态
 * - 若找到则 cmd 为绝对路径，未找到则保留原始名称
 */
/**
 * 可执行文件查找模块。
 *
 * 在 Claude Code 系统中，该模块提供轻量的可执行文件路径解析工具，
 * 替代 spawn-rx 的 findActualExecutable 以避免引入 rxjs（约 313 KB）依赖：
 * - findExecutable()：在 PATH 中搜索给定名称的可执行文件（类似 which 命令）
 * - 返回 { cmd, args } 结构以兼容 spawn-rx 的 API 形态
 * - 若找到则 cmd 为绝对路径，未找到则保留原始名称
 */
import { whichSync } from './which.js'

/**
 * Find an executable by searching PATH, similar to `which`.
 * Replaces spawn-rx's findActualExecutable to avoid pulling in rxjs (~313 KB).
 *
 * Returns { cmd, args } to match the spawn-rx API shape.
 * `cmd` is the resolved path if found, or the original name if not.
 * `args` is always the pass-through of the input args.
 */
export function findExecutable(
  exe: string,
  args: string[],
): { cmd: string; args: string[] } {
  const resolved = whichSync(exe)
  return { cmd: resolved ?? exe, args }
}
