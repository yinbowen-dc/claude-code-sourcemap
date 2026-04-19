/**
 * Shell 补全脚本安装与缓存管理模块。
 *
 * 在 Claude Code 系统中，该模块负责生成并安装 bash/zsh/fish 的命令行补全脚本，
 * 将脚本缓存至 ~/.claude/completion.{zsh,bash,fish} 并向 RC 文件追加 source 指令：
 * - setupShellCompletion()：检测当前 shell，生成补全脚本并写入 RC 文件
 * - regenerateCompletionCache()：claude update 后重新生成补全缓存，与新二进制保持同步
 */
import chalk from 'chalk'
import { mkdir, readFile, writeFile } from 'fs/promises'
import { homedir } from 'os'
import { dirname, join } from 'path'
import { pathToFileURL } from 'url'
import { color } from '../components/design-system/color.js'
import { supportsHyperlinks } from '../ink/supports-hyperlinks.js'
import { logForDebugging } from './debug.js'
import { isENOENT } from './errors.js'
import { execFileNoThrow } from './execFileNoThrow.js'
import { logError } from './log.js'
import type { ThemeName } from './theme.js'

const EOL = '\n'

type ShellInfo = {
  name: string
  rcFile: string
  cacheFile: string
  completionLine: string
  shellFlag: string
}

/**
 * 检测当前 shell 类型，返回对应的补全配置信息。
 * 支持 zsh、bash、fish；无法识别时返回 null。
 */
function detectShell(): ShellInfo | null {
  const shell = process.env.SHELL || ''
  const home = homedir()
  const claudeDir = join(home, '.claude')

  if (shell.endsWith('/zsh') || shell.endsWith('/zsh.exe')) {
    const cacheFile = join(claudeDir, 'completion.zsh')
    return {
      name: 'zsh',
      rcFile: join(home, '.zshrc'),
      cacheFile,
      completionLine: `[[ -f "${cacheFile}" ]] && source "${cacheFile}"`,
      shellFlag: 'zsh',
    }
  }
  if (shell.endsWith('/bash') || shell.endsWith('/bash.exe')) {
    const cacheFile = join(claudeDir, 'completion.bash')
    return {
      name: 'bash',
      rcFile: join(home, '.bashrc'),
      cacheFile,
      completionLine: `[ -f "${cacheFile}" ] && source "${cacheFile}"`,
      shellFlag: 'bash',
    }
  }
  if (shell.endsWith('/fish') || shell.endsWith('/fish.exe')) {
    const xdg = process.env.XDG_CONFIG_HOME || join(home, '.config')
    const cacheFile = join(claudeDir, 'completion.fish')
    return {
      name: 'fish',
      rcFile: join(xdg, 'fish', 'config.fish'),
      cacheFile,
      completionLine: `[ -f "${cacheFile}" ] && source "${cacheFile}"`,
      shellFlag: 'fish',
    }
  }
  return null
}

/**
 * 将文件路径格式化为支持点击跳转的超链接（终端支持时）。
 * 不支持超链接时直接返回路径字符串。
 */
function formatPathLink(filePath: string): string {
  if (!supportsHyperlinks()) {
    return filePath
  }
  const fileUrl = pathToFileURL(filePath).href
  return `\x1b]8;;${fileUrl}\x07${filePath}\x1b]8;;\x07`
}

/**
 * 生成并缓存补全脚本，然后向 shell 的 RC 文件追加 source 指令。
 * 返回供用户查看的状态消息。
 */
export async function setupShellCompletion(theme: ThemeName): Promise<string> {
  const shell = detectShell()
  if (!shell) {
    return ''
  }

  // 确保缓存目录存在
  try {
    await mkdir(dirname(shell.cacheFile), { recursive: true })
  } catch (e: unknown) {
    logError(e)
    return `${EOL}${color('warning', theme)(`Could not write ${shell.name} completion cache`)}${EOL}${chalk.dim(`Run manually: claude completion ${shell.shellFlag} > ${shell.cacheFile}`)}${EOL}`
  }

  // 通过直接写入缓存文件来生成补全脚本。
  // 使用 --output 可避免通过 stdout 输出时 process.exit() 在管道缓冲区刷新前截断内容。
  const claudeBin = process.argv[1] || 'claude'
  const result = await execFileNoThrow(claudeBin, [
    'completion',
    shell.shellFlag,
    '--output',
    shell.cacheFile,
  ])
  if (result.code !== 0) {
    return `${EOL}${color('warning', theme)(`Could not generate ${shell.name} shell completions`)}${EOL}${chalk.dim(`Run manually: claude completion ${shell.shellFlag} > ${shell.cacheFile}`)}${EOL}`
  }

  // 检查 RC 文件是否已包含补全 source 指令
  let existing = ''
  try {
    existing = await readFile(shell.rcFile, { encoding: 'utf-8' })
    if (
      existing.includes('claude completion') ||
      existing.includes(shell.cacheFile)
    ) {
      return `${EOL}${color('success', theme)(`Shell completions updated for ${shell.name}`)}${EOL}${chalk.dim(`See ${formatPathLink(shell.rcFile)}`)}${EOL}`
    }
  } catch (e: unknown) {
    if (!isENOENT(e)) {
      logError(e)
      return `${EOL}${color('warning', theme)(`Could not install ${shell.name} shell completions`)}${EOL}${chalk.dim(`Add this to ${formatPathLink(shell.rcFile)}:`)}${EOL}${chalk.dim(shell.completionLine)}${EOL}`
    }
  }

  // 向 RC 文件追加 source 指令
  try {
    const configDir = dirname(shell.rcFile)
    await mkdir(configDir, { recursive: true })

    const separator = existing && !existing.endsWith('\n') ? '\n' : ''
    const content = `${existing}${separator}\n# Claude Code shell completions\n${shell.completionLine}\n`
    await writeFile(shell.rcFile, content, { encoding: 'utf-8' })

    return `${EOL}${color('success', theme)(`Installed ${shell.name} shell completions`)}${EOL}${chalk.dim(`Added to ${formatPathLink(shell.rcFile)}`)}${EOL}${chalk.dim(`Run: source ${shell.rcFile}`)}${EOL}`
  } catch (error) {
    logError(error)
    return `${EOL}${color('warning', theme)(`Could not install ${shell.name} shell completions`)}${EOL}${chalk.dim(`Add this to ${formatPathLink(shell.rcFile)}:`)}${EOL}${chalk.dim(shell.completionLine)}${EOL}`
  }
}

/**
 * 重新生成 ~/.claude/ 目录下的 shell 补全脚本缓存。
 * 在 `claude update` 后调用，确保补全与新二进制文件保持同步。
 */
export async function regenerateCompletionCache(): Promise<void> {
  const shell = detectShell()
  if (!shell) {
    return
  }

  logForDebugging(`update: Regenerating ${shell.name} completion cache`)

  const claudeBin = process.argv[1] || 'claude'
  const result = await execFileNoThrow(claudeBin, [
    'completion',
    shell.shellFlag,
    '--output',
    shell.cacheFile,
  ])

  if (result.code !== 0) {
    logForDebugging(
      `update: Failed to regenerate ${shell.name} completion cache`,
    )
    return
  }

  logForDebugging(
    `update: Regenerated ${shell.name} completion cache at ${shell.cacheFile}`,
  )
}
