/**
 * git worktree 路径检测模块（含遥测版）。
 *
 * 【在 Claude Code 系统中的位置】
 * 该模块是 git worktree 路径检测的完整版实现，位于 CLI 工具链中，
 * 被需要 worktree 路径且运行在 CLI 上下文的模块调用（如 REPL 初始化、
 * 会话管理等），使用 CLI 的 gitExe() 解析器并上报遥测数据。
 * 若需要不依赖 CLI 的轻量版，请使用 getWorktreePathsPortable()。
 *
 * 【主要功能】
 * - getWorktreePaths(cwd)：运行 `git worktree list --porcelain`，
 *   解析 worktree 路径，上报检测耗时与 worktree 数量到遥测系统，
 *   将当前 worktree 排在数组首位，其余按字母顺序排列。
 *   多个 worktree 时才有意义，单个或无 worktree 时返回空数组。
 */

import { sep } from 'path'
import { logEvent } from '../services/analytics/index.js'
import { execFileNoThrowWithCwd } from './execFileNoThrow.js'
import { gitExe } from './git.js'

/**
 * 获取当前 git 仓库的所有 worktree 路径（含遥测上报）。
 *
 * 【流程】
 * 1. 记录开始时间，执行 `git worktree list --porcelain`；
 * 2. 计算耗时，若命令失败则上报失败事件并返回空数组；
 * 3. 解析 porcelain 输出，提取所有 `worktree <path>` 行中的路径；
 * 4. 上报成功事件（含耗时与 worktree 数量）；
 * 5. 将当前 worktree（cwd 所在或 cwd 的祖先路径）排在首位，
 *    其余按字母顺序排列后拼接返回。
 *
 * 该版本使用 CLI 的 gitExe() 解析器，并通过 logEvent 上报遥测数据。
 * 若不需要遥测或在 SDK 上下文中，请使用 getWorktreePathsPortable()。
 *
 * @param cwd - 运行 git 命令的工作目录
 * @returns 所有 worktree 的绝对路径数组（当前 worktree 在首位）；
 *          出错或只有一个 worktree 时返回空数组
 */
export async function getWorktreePaths(cwd: string): Promise<string[]> {
  const startTime = Date.now() // 记录开始时间，用于遥测

  const { stdout, code } = await execFileNoThrowWithCwd(
    gitExe(),                              // 使用 CLI 的 git 可执行文件路径
    ['worktree', 'list', '--porcelain'],   // porcelain 格式，易于解析
    {
      cwd,
      preserveOutputOnError: false,
    },
  )

  const durationMs = Date.now() - startTime // 计算命令耗时

  if (code !== 0) {
    // 命令失败：上报失败遥测并返回空数组
    logEvent('tengu_worktree_detection', {
      duration_ms: durationMs,
      worktree_count: 0,
      success: false,
    })
    return []
  }

  // 解析 porcelain 格式输出，提取 "worktree <path>" 行
  // porcelain 格式示例：
  // worktree /Users/foo/repo
  // HEAD abc123
  // branch refs/heads/main
  //
  // worktree /Users/foo/repo-wt1
  // HEAD def456
  // branch refs/heads/feature
  const worktreePaths = stdout
    .split('\n')
    .filter(line => line.startsWith('worktree '))       // 仅保留路径行
    .map(line => line.slice('worktree '.length).normalize('NFC')) // 提取路径并 NFC 规范化

  // 上报成功遥测
  logEvent('tengu_worktree_detection', {
    duration_ms: durationMs,
    worktree_count: worktreePaths.length,
    success: true,
  })

  // 将当前 worktree（cwd 所在目录或 cwd 的父路径）排在首位
  const currentWorktree = worktreePaths.find(
    path => cwd === path || cwd.startsWith(path + sep), // cwd 精确匹配或以该路径为前缀
  )
  const otherWorktrees = worktreePaths
    .filter(path => path !== currentWorktree) // 排除当前 worktree
    .sort((a, b) => a.localeCompare(b))       // 其余按字母顺序排列

  // 若找到当前 worktree，将其置于数组首位
  return currentWorktree ? [currentWorktree, ...otherWorktrees] : otherWorktrees
}
