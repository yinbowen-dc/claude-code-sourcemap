/**
 * 轻量级 git worktree 路径检测模块（Portable版）。
 *
 * 【在 Claude Code 系统中的位置】
 * 该模块是 git worktree 路径检测的轻量级实现，专供 SDK 路径（listSessionsImpl.ts）
 * 及不依赖 CLI 工具链的场景使用，仅依赖 Node.js 内置 child_process 模块，
 * 不引入 execa、cross-spawn、which 等依赖，避免拉入 CLI 的完整依赖链。
 * 与 getWorktreePaths.ts 的完整版相比，该模块不包含遥测上报功能。
 *
 * 【主要功能】
 * - getWorktreePathsPortable(cwd)：运行 `git worktree list --porcelain`，
 *   解析输出中的 `worktree ` 行提取路径，对路径进行 NFC Unicode 规范化，
 *   任何错误均静默返回空数组。
 */

import { execFile as execFileCb } from 'child_process'
import { promisify } from 'util'

/** 将 execFile 的回调式 API 转换为 Promise 式，便于 async/await 使用 */
const execFileAsync = promisify(execFileCb)

/**
 * 便携式 worktree 路径检测：仅使用 child_process，无遥测、无 bootstrap 依赖、无 execa。
 *
 * 【使用场景】
 * 适用于 listSessionsImpl.ts（SDK 路径）及任何需要 worktree 路径但
 * 不希望引入 CLI 依赖链（execa → cross-spawn → which）的地方。
 *
 * 【流程】
 * 1. 以 cwd 为工作目录执行 `git worktree list --porcelain`；
 * 2. 过滤以 `worktree ` 开头的行（每个 worktree 块的第一行）；
 * 3. 截取路径部分并进行 NFC Unicode 规范化（处理 macOS HFS+ 路径分解问题）；
 * 4. 发生任何错误（非 git 仓库、git 不存在、超时等）时静默返回空数组。
 *
 * @param cwd - 运行 git 命令的工作目录（通常为项目根目录）
 * @returns 所有 worktree 的绝对路径数组；出错时返回空数组
 */
export async function getWorktreePathsPortable(cwd: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['worktree', 'list', '--porcelain'], // porcelain 格式输出，每个 worktree 块首行为 "worktree <path>"
      { cwd, timeout: 5000 },              // 5 秒超时，防止 git 操作阻塞
    )
    if (!stdout) return [] // 无输出（空仓库或无 worktree）
    return stdout
      .split('\n')
      .filter(line => line.startsWith('worktree '))       // 仅保留 "worktree <path>" 行
      .map(line => line.slice('worktree '.length).normalize('NFC')) // 提取路径并 NFC 规范化
  } catch {
    return [] // 任何错误（非 git 仓库、命令不存在等）静默返回空数组
  }
}
