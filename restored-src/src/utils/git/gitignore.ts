/**
 * git .gitignore 管理模块。
 *
 * 【在 Claude Code 系统中的位置】
 * 该模块位于 git 集成工具层，被文件权限检查、工具执行上下文等需要
 * 判断文件是否被 git 忽略的模块调用，同时提供向全局 gitignore 添加
 * 规则的功能（用于自动忽略 Claude 的工作文件）。
 *
 * 【主要功能】
 * - isPathGitignored(filePath, cwd)：通过 `git check-ignore` 判断路径是否被忽略，
 *   利用 git 自身的规则优先级（本地 .gitignore、.git/info/exclude、全局 gitignore）
 * - getGlobalGitignorePath()：返回全局 gitignore 文件路径（~/.config/git/ignore）
 * - addFileGlobRuleToGitignore(filename, cwd)：若文件尚未被任何 gitignore 规则覆盖，
 *   将 `**\/filename` 模式追加到全局 gitignore，并自动创建所需目录
 */

import { appendFile, mkdir, readFile, writeFile } from 'fs/promises'
import { homedir } from 'os'
import { dirname, join } from 'path'
import { getCwd } from '../cwd.js'
import { getErrnoCode } from '../errors.js'
import { execFileNoThrowWithCwd } from '../execFileNoThrow.js'
import { dirIsInGitRepo } from '../git.js'
import { logError } from '../log.js'

/**
 * 检查给定路径是否被 git 忽略（通过 `git check-ignore` 命令）。
 *
 * 【流程】
 * 1. 以 cwd 为工作目录运行 `git check-ignore <filePath>`；
 * 2. 根据退出码判断结果：
 *    - 0：路径被忽略，返回 true
 *    - 1：路径未被忽略，返回 false
 *    - 128：不在 git 仓库中（fail-open，返回 false）
 *
 * 该方法咨询所有适用的 gitignore 来源（嵌套的 .gitignore、
 * .git/info/exclude、全局 gitignore），按正确的优先级解析，
 * 因为是由 git 自身来处理的。
 *
 * @param filePath - 要检查的路径（绝对路径或相对于 cwd 的路径）
 * @param cwd - 运行 git 命令的工作目录
 * @returns 若路径被忽略返回 true，否则返回 false（包括不在 git 仓库的情况）
 */
export async function isPathGitignored(
  filePath: string,
  cwd: string,
): Promise<boolean> {
  const { code } = await execFileNoThrowWithCwd(
    'git',
    ['check-ignore', filePath], // 检查路径是否被任何 gitignore 规则覆盖
    {
      preserveOutputOnError: false,
      cwd,
    },
  )

  return code === 0 // 退出码 0 表示路径被忽略
}

/**
 * 返回全局 gitignore 文件的路径（~/.config/git/ignore）。
 *
 * 该路径遵循 XDG 规范，是 git 官方支持的全局忽略规则文件位置。
 *
 * @returns 全局 gitignore 文件的绝对路径
 */
export function getGlobalGitignorePath(): string {
  return join(homedir(), '.config', 'git', 'ignore') // XDG 规范的全局 gitignore 路径
}

/**
 * 将文件名 glob 规则追加到全局 gitignore 文件（若尚未被忽略）。
 *
 * 【流程】
 * 1. 检查当前目录是否在 git 仓库中，不是则直接返回；
 * 2. 构造 gitignore 条目（`**\/filename`），并确定测试路径
 *    （对于目录模式，使用内部的示例文件路径）；
 * 3. 通过 isPathGitignored 检查路径是否已被现有规则覆盖，若是则返回；
 * 4. 获取全局 gitignore 路径，确保父目录存在（mkdir -p）；
 * 5. 读取现有内容，若条目已存在则不重复写入；
 * 6. 追加新条目；若文件不存在（ENOENT）则直接创建；
 * 7. 捕获所有错误并通过 logError 记录，不抛出。
 *
 * @param filename - 要忽略的文件名或目录名（如 `.claude_cache/` 或 `*.tmp`）
 * @param cwd - 检查 gitignore 时的工作目录，默认为当前工作目录
 */
export async function addFileGlobRuleToGitignore(
  filename: string,
  cwd: string = getCwd(),
): Promise<void> {
  try {
    if (!(await dirIsInGitRepo(cwd))) {
      return // 不在 git 仓库中，无需操作
    }

    // 构造全局 gitignore 条目：使用 **/ 前缀，匹配任意目录深度
    const gitignoreEntry = `**/${filename}`
    // 对于目录模式（如 `cache/`），需要用内部文件路径来测试是否已被忽略
    const testPath = filename.endsWith('/')
      ? `${filename}sample-file.txt` // 目录模式：测试目录内的示例文件
      : filename
    if (await isPathGitignored(testPath, cwd)) {
      // 已被现有规则（本地或全局 gitignore）覆盖，无需重复添加
      return
    }

    // 获取全局 gitignore 文件路径（~/.config/git/ignore）
    const globalGitignorePath = getGlobalGitignorePath()

    // 确保父目录存在（~/.config/git/），使用 recursive 避免目录已存在时报错
    const configGitDir = dirname(globalGitignorePath)
    await mkdir(configGitDir, { recursive: true })

    // 读取现有内容并检查是否已包含该条目
    try {
      const content = await readFile(globalGitignorePath, { encoding: 'utf-8' })
      if (content.includes(gitignoreEntry)) {
        return // 条目已存在，不重复写入
      }
      await appendFile(globalGitignorePath, `\n${gitignoreEntry}\n`) // 追加新条目
    } catch (e: unknown) {
      const code = getErrnoCode(e)
      if (code === 'ENOENT') {
        // 全局 gitignore 文件不存在，直接创建并写入条目
        await writeFile(globalGitignorePath, `${gitignoreEntry}\n`, 'utf-8')
      } else {
        throw e // 其他文件系统错误，继续向上抛出
      }
    }
  } catch (error) {
    logError(error) // 捕获所有错误并记录，不影响主流程
  }
}
