/**
 * 内存版本工具模块 — Git 仓库同步检测助手。
 *
 * 在 Claude Code 系统中，该模块被 markdownConfigLoader（配置文件扫描）
 * 以及记忆目录初始化逻辑调用，用于同步判断当前工作目录是否处于 Git 仓库中。
 *
 * 与 `git.ts` 中的异步版本 `dirIsInGitRepo()` 不同，
 * 此处提供纯文件系统遍历的同步版本（无子进程开销），
 * 适合在启动路径或不能 await 的同步上下文（如模块初始化）中调用。
 */
import { findGitRoot } from '../git.js'

// Note: This is used to check git repo status synchronously
// Uses findGitRoot which walks the filesystem (no subprocess)
// Prefer `dirIsInGitRepo()` for async checks

/**
 * 同步检查指定工作目录是否处于 Git 仓库中。
 *
 * 内部调用 `findGitRoot(cwd)` 沿目录树向上遍历查找 `.git` 目录或文件；
 * 若找到则返回 true，否则返回 false。
 *
 * 注意事项：
 * - 此函数为同步操作，直接遍历文件系统，无子进程开销
 * - 支持 git worktree（`.git` 文件而非目录）和 submodule 场景
 * - 在异步上下文中优先使用 `dirIsInGitRepo()`，避免阻塞事件循环
 *
 * @param cwd 待检查的工作目录绝对路径
 * @returns 若该目录位于 Git 仓库中则返回 true，否则返回 false
 */
export function projectIsInGitRepo(cwd: string): boolean {
  // findGitRoot 沿目录树向上查找 .git 目录/文件，未找到则返回 null
  return findGitRoot(cwd) !== null
}
