/**
 * Windows 路径工具模块。
 *
 * 在 Claude Code 系统流程中的位置：
 * 此模块是 Windows 平台支持层，处理 Windows 路径与 POSIX 路径之间的
 * 转换，以及 git-bash 可执行文件的查找。被 BashTool、Shell.ts
 * 以及所有需要在 Windows 上执行 shell 命令的模块调用。
 *
 * 主要功能：
 * - setShellIfWindows：将 SHELL 环境变量设置为 git-bash 路径
 * - findGitBashPath：查找 bash.exe（含环境变量覆盖、CWD 安全过滤）
 * - windowsPathToPosixPath：Windows 路径 → POSIX 路径（LRU 缓存 500 条）
 * - posixPathToWindowsPath：POSIX 路径 → Windows 路径（LRU 缓存 500 条）
 *
 * 安全考量：
 * - findExecutable 过滤 where.exe 返回的 CWD 结果，防止执行恶意的
 *   git.bat/cmd/exe（DLL/binary hijacking 防护）
 */

import memoize from 'lodash-es/memoize.js'
import * as path from 'path'
import * as pathWin32 from 'path/win32'
import { getCwd } from './cwd.js'
import { logForDebugging } from './debug.js'
import { execSync_DEPRECATED } from './execSyncWrapper.js'
import { memoizeWithLRU } from './memoize.js'
import { getPlatform } from './platform.js'

/**
 * 使用 Windows dir 命令检查路径是否存在。
 *
 * @param path 要检查的路径
 * @returns 路径存在返回 true，否则返回 false
 */
function checkPathExists(path: string): boolean {
  try {
    // dir 命令执行成功说明路径存在
    execSync_DEPRECATED(`dir "${path}"`, { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

/**
 * 使用 where.exe 在 Windows 上查找可执行文件。
 *
 * 流程：
 * 1. 对 git 特殊处理：先检查常见安装路径（64位优先于32位）
 * 2. 回退到 where.exe 全局搜索
 * 3. 安全过滤：跳过 CWD 中的可执行文件（防止恶意文件劫持）
 * 4. 返回第一个有效路径，未找到返回 null
 *
 * @param executable 要查找的可执行文件名
 * @returns 可执行文件的完整路径，未找到时返回 null
 */
function findExecutable(executable: string): string | null {
  // git 特殊处理：优先检查已知安装位置，避免依赖 PATH 环境变量
  if (executable === 'git') {
    const defaultLocations = [
      // 优先检查 64 位安装路径
      'C:\\Program Files\\Git\\cmd\\git.exe',
      'C:\\Program Files (x86)\\Git\\cmd\\git.exe',
      // 不检查 C:\Program Files\Git\mingw64\bin\git.exe
      // 因为该目录是无环境设置的"原始"工具
    ]

    for (const location of defaultLocations) {
      if (checkPathExists(location)) {
        return location
      }
    }
  }

  // 回退到 where.exe 全局搜索
  try {
    const result = execSync_DEPRECATED(`where.exe ${executable}`, {
      stdio: 'pipe',
      encoding: 'utf8',
    }).trim()

    // 安全措施：过滤当前目录中的结果，防止执行恶意的 git.bat/cmd/exe
    const paths = result.split('\r\n').filter(Boolean)
    const cwd = getCwd().toLowerCase()

    for (const candidatePath of paths) {
      // 标准化并比较路径，确保不在当前工作目录中
      const normalizedPath = path.resolve(candidatePath).toLowerCase()
      const pathDir = path.dirname(normalizedPath).toLowerCase()

      // 跳过位于当前工作目录中的可执行文件（安全防护）
      if (pathDir === cwd || normalizedPath.startsWith(cwd + path.sep)) {
        logForDebugging(
          `Skipping potentially malicious executable in current directory: ${candidatePath}`,
        )
        continue
      }

      // 返回第一个不在 CWD 中的有效路径
      return candidatePath
    }

    return null
  } catch {
    return null
  }
}

/**
 * 若在 Windows 上运行，将 SHELL 环境变量设置为 git-bash 路径。
 * 供 BashTool 和 Shell.ts 用于执行用户 shell 命令。
 * COMSPEC 保持不变，供系统进程执行使用。
 */
export function setShellIfWindows(): void {
  if (getPlatform() === 'windows') {
    const gitBashPath = findGitBashPath()
    process.env.SHELL = gitBashPath
    logForDebugging(`Using bash path: "${gitBashPath}"`)
  }
}

/**
 * 查找 git-bash 中包含的 bash.exe 路径。
 * 若未找到则退出进程（Claude Code 在 Windows 上依赖 git-bash）。
 *
 * 流程：
 * 1. 检查环境变量 CLAUDE_CODE_GIT_BASH_PATH 覆盖
 * 2. 通过 findExecutable('git') 定位 git 安装目录
 * 3. 从 git 路径推导 bash.exe 路径（../bin/bash.exe）
 * 4. 若所有路径均失败，打印错误并退出进程
 *
 * 使用 lodash memoize 缓存结果，整个进程生命周期只查找一次。
 */
export const findGitBashPath = memoize((): string => {
  // 优先使用用户指定的路径环境变量
  if (process.env.CLAUDE_CODE_GIT_BASH_PATH) {
    if (checkPathExists(process.env.CLAUDE_CODE_GIT_BASH_PATH)) {
      return process.env.CLAUDE_CODE_GIT_BASH_PATH
    }
    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.error(
      `Claude Code was unable to find CLAUDE_CODE_GIT_BASH_PATH path "${process.env.CLAUDE_CODE_GIT_BASH_PATH}"`,
    )
    // eslint-disable-next-line custom-rules/no-process-exit
    process.exit(1)
  }

  // 通过 git 安装目录推导 bash.exe 路径
  const gitPath = findExecutable('git')
  if (gitPath) {
    // git.exe 在 cmd/ 目录，bash.exe 在 bin/ 目录（上两级 + bin）
    const bashPath = pathWin32.join(gitPath, '..', '..', 'bin', 'bash.exe')
    if (checkPathExists(bashPath)) {
      return bashPath
    }
  }

  // 所有路径均失败：打印安装指引并退出
  // biome-ignore lint/suspicious/noConsole:: intentional console output
  console.error(
    'Claude Code on Windows requires git-bash (https://git-scm.com/downloads/win). If installed but not in PATH, set environment variable pointing to your bash.exe, similar to: CLAUDE_CODE_GIT_BASH_PATH=C:\\Program Files\\Git\\bin\\bash.exe',
  )
  // eslint-disable-next-line custom-rules/no-process-exit
  process.exit(1)
})

/**
 * 将 Windows 路径转换为 POSIX 路径（纯 JS 实现）。
 * 使用 LRU 缓存（容量 500）避免对相同路径重复计算。
 *
 * 转换规则：
 * - UNC 路径：\\server\share → //server/share
 * - 驱动器路径：C:\Users\foo → /c/Users/foo
 * - 其他：仅将反斜杠替换为正斜杠
 */
export const windowsPathToPosixPath = memoizeWithLRU(
  (windowsPath: string): string => {
    // UNC 路径处理：\\server\share → //server/share
    if (windowsPath.startsWith('\\\\')) {
      return windowsPath.replace(/\\/g, '/')
    }
    // 驱动器路径处理：C:\... → /c/...
    const match = windowsPath.match(/^([A-Za-z]):[/\\]/)
    if (match) {
      const driveLetter = match[1]!.toLowerCase()
      // 去掉 "X:" 前缀，将剩余反斜杠替换为正斜杠，加上 /驱动器字母 前缀
      return '/' + driveLetter + windowsPath.slice(2).replace(/\\/g, '/')
    }
    // 已是 POSIX 格式或相对路径：仅替换反斜杠
    return windowsPath.replace(/\\/g, '/')
  },
  (p: string) => p, // LRU 缓存键函数：路径字符串本身
  500,              // LRU 缓存容量
)

/**
 * 将 POSIX 路径转换为 Windows 路径（纯 JS 实现）。
 * 使用 LRU 缓存（容量 500）避免对相同路径重复计算。
 *
 * 转换规则：
 * - UNC 路径：//server/share → \\server\share
 * - /cygdrive/c/... 格式（Cygwin）→ C:\...
 * - /c/... 格式（MSYS2/Git Bash）→ C:\...
 * - 其他：仅将正斜杠替换为反斜杠
 */
export const posixPathToWindowsPath = memoizeWithLRU(
  (posixPath: string): string => {
    // UNC 路径处理：//server/share → \\server\share
    if (posixPath.startsWith('//')) {
      return posixPath.replace(/\//g, '\\')
    }
    // Cygwin 格式处理：/cygdrive/c/... → C:\...
    const cygdriveMatch = posixPath.match(/^\/cygdrive\/([A-Za-z])(\/|$)/)
    if (cygdriveMatch) {
      const driveLetter = cygdriveMatch[1]!.toUpperCase()
      const rest = posixPath.slice(('/cygdrive/' + cygdriveMatch[1]).length)
      return driveLetter + ':' + (rest || '\\').replace(/\//g, '\\')
    }
    // MSYS2/Git Bash 格式处理：/c/... → C:\...
    const driveMatch = posixPath.match(/^\/([A-Za-z])(\/|$)/)
    if (driveMatch) {
      const driveLetter = driveMatch[1]!.toUpperCase()
      const rest = posixPath.slice(2) // 去掉 "/c" 前缀
      return driveLetter + ':' + (rest || '\\').replace(/\//g, '\\')
    }
    // 已是 Windows 格式或相对路径：仅替换正斜杠
    return posixPath.replace(/\//g, '\\')
  },
  (p: string) => p, // LRU 缓存键函数：路径字符串本身
  500,              // LRU 缓存容量
)
