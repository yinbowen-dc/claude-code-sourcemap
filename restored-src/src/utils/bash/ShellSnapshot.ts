/**
 * Shell 环境快照模块。
 *
 * 在 Claude Code 系统中，该模块负责捕获用户 shell 的环境状态（函数、别名、选项），
 * 并将其保存为可 source 的快照文件，供 Claude 的子进程以用户环境执行命令：
 * - createArgv0ShellFunction()（内部）：生成利用 ARGV0 dispatch 调用嵌入式工具
 *   （rg/bfs/ugrep）的 shell 函数，兼容 zsh/bash/Windows git-bash
 * - createRipgrepShellIntegration()：为嵌入式 ripgrep 生成 shell 函数或别名片段
 * - createFindGrepShellIntegration()：为嵌入式 bfs/ugrep 生成 find/grep 覆盖函数，
 *   注入默认标志以匹配 GlobTool/GrepTool 语义（含 VCS 目录排除、gitignore 支持等）
 * - getUserSnapshotContent()（内部）：生成捕获用户函数/选项/别名的 shell 脚本片段
 * - getClaudeCodeSnapshotContent()（内部）：生成 Claude Code 专属快照内容（PATH、rg 等）
 * - getSnapshotScript()（内部）：组合 source 配置文件 + 捕获环境的完整脚本
 * - createAndSaveSnapshot()：执行快照脚本并返回快照文件路径；失败时返回 undefined
 *
 * 快照创建超时：10 秒；快照文件位于 ~/.claude/shell-snapshots/；会在进程退出时清理。
 */
import { execFile } from 'child_process'
import { execa } from 'execa'
import { mkdir, stat } from 'fs/promises'
import * as os from 'os'
import { join } from 'path'
import { logEvent } from 'src/services/analytics/index.js'
import { registerCleanup } from '../cleanupRegistry.js'
import { getCwd } from '../cwd.js'
import { logForDebugging } from '../debug.js'
import {
  embeddedSearchToolsBinaryPath,
  hasEmbeddedSearchTools,
} from '../embeddedTools.js'
import { getClaudeConfigHomeDir } from '../envUtils.js'
import { pathExists } from '../file.js'
import { getFsImplementation } from '../fsOperations.js'
import { logError } from '../log.js'
import { getPlatform } from '../platform.js'
import { ripgrepCommand } from '../ripgrep.js'
import { subprocessEnv } from '../subprocessEnv.js'
import { quote } from './shellQuote.js'

const LITERAL_BACKSLASH = '\\'
const SNAPSHOT_CREATION_TIMEOUT = 10000 // 10 seconds

/**
 * 生成一个以特定 argv[0] 调用 binaryPath 的 shell 函数。
 * 利用 bun 内部的 ARGV0 dispatch 机制：bun 二进制检测自身 argv[0]，
 * 并运行与其匹配的嵌入式工具（rg、bfs、ugrep）。
 *
 * 兼容三种执行环境：
 * - zsh：直接通过 ARGV0 环境变量设置 argv[0]
 * - Windows git-bash（msys/cygwin）：exec -a 不可用，同样使用 ARGV0 环境变量
 * - bash（非子 shell）：通过 exec -a 设置 argv[0]，并使用子 shell 包装避免替换当前进程
 *
 * @param prependArgs 注入用户参数之前的默认标志列表；每个元素须为合法 shell 词（不含空格或特殊字符）
 */
function createArgv0ShellFunction(
  funcName: string,
  argv0: string,
  binaryPath: string,
  prependArgs: string[] = [],
): string {
  const quotedPath = quote([binaryPath])
  const argSuffix =
    prependArgs.length > 0 ? `${prependArgs.join(' ')} "$@"` : '"$@"'
  return [
    `function ${funcName} {`,
    '  if [[ -n $ZSH_VERSION ]]; then',
    `    ARGV0=${argv0} ${quotedPath} ${argSuffix}`,
    '  elif [[ "$OSTYPE" == "msys" ]] || [[ "$OSTYPE" == "cygwin" ]] || [[ "$OSTYPE" == "win32" ]]; then',
    // On Windows (git bash), exec -a does not work, so use ARGV0 env var instead
    // The bun binary reads from ARGV0 natively to set argv[0]
    `    ARGV0=${argv0} ${quotedPath} ${argSuffix}`,
    '  elif [[ $BASHPID != $$ ]]; then',
    `    exec -a ${argv0} ${quotedPath} ${argSuffix}`,
    '  else',
    `    (exec -a ${argv0} ${quotedPath} ${argSuffix})`,
    '  fi',
    '}',
  ].join('\n')
}

/**
 * 为嵌入式 ripgrep 生成 shell 集成片段（函数或别名）。
 * - 若 ripgrep 是通过 bun ARGV0 dispatch 内嵌的，则生成 shell 函数以正确设置 argv[0]。
 * - 若使用系统 ripgrep，则生成简单别名目标（含可选的默认参数）。
 * 返回对象包含类型标记（'alias' | 'function'）和对应的 shell 片段字符串，
 * 供 getClaudeCodeSnapshotContent() 写入快照文件。
 */
export function createRipgrepShellIntegration(): {
  type: 'alias' | 'function'
  snippet: string
} {
  const rgCommand = ripgrepCommand()

  // For embedded ripgrep (bun-internal), we need a shell function that sets argv0
  if (rgCommand.argv0) {
    return {
      type: 'function',
      snippet: createArgv0ShellFunction(
        'rg',
        rgCommand.argv0,
        rgCommand.rgPath,
      ),
    }
  }

  // For regular ripgrep, use a simple alias target
  const quotedPath = quote([rgCommand.rgPath])
  const quotedArgs = rgCommand.rgArgs.map(arg => quote([arg]))
  const aliasTarget =
    rgCommand.rgArgs.length > 0
      ? `${quotedPath} ${quotedArgs.join(' ')}`
      : quotedPath

  return { type: 'alias', snippet: aliasTarget }
}

/**
 * VCS directories to exclude from grep searches. Matches the list in
 * GrepTool (see GrepTool.ts: VCS_DIRECTORIES_TO_EXCLUDE).
 */
const VCS_DIRECTORIES_TO_EXCLUDE = [
  '.git',
  '.svn',
  '.hg',
  '.bzr',
  '.jj',
  '.sl',
] as const

/**
 * 为嵌入式 bfs（find 替换）和 ugrep（grep 替换）生成 shell 集成函数。
 * 仅在 ant-native 构建（hasEmbeddedSearchTools() 为 true）时生效；否则返回 null。
 *
 * 生成的 find 函数包装 bfs，注入 `-regextype findutils-default` 以匹配
 * GlobTool 的正则语义；生成的 grep 函数包装 ugrep，注入 `-G`（BRE 模式）、
 * `--ignore-files`、`--hidden`、`-I` 以及各 VCS 目录的 `--exclude-dir`，
 * 与 GrepTool 的行为保持一致。
 * 函数定义前先执行 `unalias find/grep` 以防用户别名（如 `alias find=gfind`）绕过覆盖。
 */
export function createFindGrepShellIntegration(): string | null {
  if (!hasEmbeddedSearchTools()) {
    return null
  }
  const binaryPath = embeddedSearchToolsBinaryPath()
  return [
    // User shell configs may define aliases like `alias find=gfind` or
    // `alias grep=ggrep` (common on macOS with Homebrew GNU tools). The
    // snapshot sources user aliases before these function definitions, and
    // bash expands aliases before function lookup — so a renaming alias
    // would silently bypass the embedded bfs/ugrep dispatch. Clear them first
    // (same fix the rg integration uses).
    'unalias find 2>/dev/null || true',
    'unalias grep 2>/dev/null || true',
    createArgv0ShellFunction('find', 'bfs', binaryPath, [
      '-regextype',
      'findutils-default',
    ]),
    createArgv0ShellFunction('grep', 'ugrep', binaryPath, [
      '-G',
      '--ignore-files',
      '--hidden',
      '-I',
      ...VCS_DIRECTORIES_TO_EXCLUDE.map(d => `--exclude-dir=${d}`),
    ]),
  ].join('\n')
}

/**
 * 根据 shell 路径推断对应的用户配置文件路径（.zshrc / .bashrc / .profile）。
 * 以 shell 路径中是否含有 'zsh' 或 'bash' 字样来判断 shell 类型；
 * 对于其他 shell（如 sh、fish），回退到 .profile。
 * 返回拼接了用户主目录的完整配置文件路径，供 getSnapshotScript() 决定是否 source。
 */
function getConfigFile(shellPath: string): string {
  const fileName = shellPath.includes('zsh')
    ? '.zshrc'
    : shellPath.includes('bash')
      ? '.bashrc'
      : '.profile'

  const configPath = join(os.homedir(), fileName)

  return configPath
}

/**
 * 生成捕获用户 shell 环境（函数、选项、别名）的脚本片段。
 * 仅在用户配置文件存在时调用，针对 zsh 和 bash 分别生成对应的捕获命令：
 * - 函数：zsh 用 `typeset -f`，bash 用 `declare -F` + base64 编码（避免特殊字符损坏）
 * - Shell 选项：zsh 用 `setopt`，bash 用 `shopt -p` + `set -o`，
 *   bash 额外追加 `shopt -s expand_aliases` 以确保别名在子 shell 中生效
 * - 别名：两者均通过 `alias` 命令导出；在 Windows（msys/cygwin）上过滤
 *   `winpty` 别名，防止无 TTY 时出现"stdin is not a tty"错误
 * 输出写入环境变量 $SNAPSHOT_FILE 指定的文件，每节以注释行分隔。
 */
function getUserSnapshotContent(configFile: string): string {
  const isZsh = configFile.endsWith('.zshrc')

  let content = ''

  // User functions
  if (isZsh) {
    content += `
      echo "# Functions" >> "$SNAPSHOT_FILE"

      # Force autoload all functions first
      typeset -f > /dev/null 2>&1

      # Now get user function names - filter completion functions (single underscore prefix)
      # but keep double-underscore helpers (e.g. __zsh_like_cd from mise, __pyenv_init)
      typeset +f | grep -vE '^_[^_]' | while read func; do
        typeset -f "$func" >> "$SNAPSHOT_FILE"
      done
    `
  } else {
    content += `
      echo "# Functions" >> "$SNAPSHOT_FILE"

      # Force autoload all functions first
      declare -f > /dev/null 2>&1

      # Now get user function names - filter completion functions (single underscore prefix)
      # but keep double-underscore helpers (e.g. __zsh_like_cd from mise, __pyenv_init)
      declare -F | cut -d' ' -f3 | grep -vE '^_[^_]' | while read func; do
        # Encode the function to base64, preserving all special characters
        encoded_func=$(declare -f "$func" | base64 )
        # Write the function definition to the snapshot
        echo "eval ${LITERAL_BACKSLASH}"${LITERAL_BACKSLASH}$(echo '$encoded_func' | base64 -d)${LITERAL_BACKSLASH}" > /dev/null 2>&1" >> "$SNAPSHOT_FILE"
      done
    `
  }

  // Shell options
  if (isZsh) {
    content += `
      echo "# Shell Options" >> "$SNAPSHOT_FILE"
      setopt | sed 's/^/setopt /' | head -n 1000 >> "$SNAPSHOT_FILE"
    `
  } else {
    content += `
      echo "# Shell Options" >> "$SNAPSHOT_FILE"
      shopt -p | head -n 1000 >> "$SNAPSHOT_FILE"
      set -o | grep "on" | awk '{print "set -o " $1}' | head -n 1000 >> "$SNAPSHOT_FILE"
      echo "shopt -s expand_aliases" >> "$SNAPSHOT_FILE"
    `
  }

  // User aliases
  content += `
      echo "# Aliases" >> "$SNAPSHOT_FILE"
      # Filter out winpty aliases on Windows to avoid "stdin is not a tty" errors
      # Git Bash automatically creates aliases like "alias node='winpty node.exe'" for
      # programs that need Win32 Console in mintty, but winpty fails when there's no TTY
      if [[ "$OSTYPE" == "msys" ]] || [[ "$OSTYPE" == "cygwin" ]]; then
        alias | grep -v "='winpty " | sed 's/^alias //g' | sed 's/^/alias -- /' | head -n 1000 >> "$SNAPSHOT_FILE"
      else
        alias | sed 's/^alias //g' | sed 's/^/alias -- /' | head -n 1000 >> "$SNAPSHOT_FILE"
      fi
  `

  return content
}

/**
 * 生成 Claude Code 专属的快照内容（与用户配置无关，始终注入）。
 * 主要包含：
 * 1. rg 可用性检测：若系统 rg 不存在，写入 rg 的 alias 或函数定义（嵌入式/系统两种）。
 *    检测前先在子 shell 中 `unalias rg`，防止用户 `alias rg='rg --smart-case'` 遮蔽真实二进制。
 * 2. find/grep 覆盖（ant-native 构建）：无条件写入 bfs/ugrep 的 shell 函数，
 *    替换系统 find/grep 以匹配 GlobTool/GrepTool 的语义与性能。
 * 3. PATH 导出：将当前进程的 PATH（Windows 下读取 Cygwin PATH）写入快照，
 *    确保子 shell 能找到所有已知命令。
 */
async function getClaudeCodeSnapshotContent(): Promise<string> {
  // Get the appropriate PATH based on platform
  let pathValue = process.env.PATH
  if (getPlatform() === 'windows') {
    // On Windows with git-bash, read the Cygwin PATH
    const cygwinResult = await execa('echo $PATH', {
      shell: true,
      reject: false,
    })
    if (cygwinResult.exitCode === 0 && cygwinResult.stdout) {
      pathValue = cygwinResult.stdout.trim()
    }
    // Fall back to process.env.PATH if we can't get Cygwin PATH
  }

  const rgIntegration = createRipgrepShellIntegration()

  let content = ''

  // Check if rg is available, if not create an alias/function to bundled ripgrep
  // We use a subshell to unalias rg before checking, so that user aliases like
  // `alias rg='rg --smart-case'` don't shadow the real binary check. The subshell
  // ensures we don't modify the user's aliases in the parent shell.
  content += `
      # Check for rg availability
      echo "# Check for rg availability" >> "$SNAPSHOT_FILE"
      echo "if ! (unalias rg 2>/dev/null; command -v rg) >/dev/null 2>&1; then" >> "$SNAPSHOT_FILE"
  `

  if (rgIntegration.type === 'function') {
    // For embedded ripgrep, write the function definition using heredoc
    content += `
      cat >> "$SNAPSHOT_FILE" << 'RIPGREP_FUNC_END'
  ${rgIntegration.snippet}
RIPGREP_FUNC_END
    `
  } else {
    // For regular ripgrep, write a simple alias
    const escapedSnippet = rgIntegration.snippet.replace(/'/g, "'\\''")
    content += `
      echo '  alias rg='"'${escapedSnippet}'" >> "$SNAPSHOT_FILE"
    `
  }

  content += `
      echo "fi" >> "$SNAPSHOT_FILE"
  `

  // For ant-native builds, shadow find/grep with bfs/ugrep embedded in the bun
  // binary. Unlike rg (which only activates if system rg is absent), we always
  // shadow find/grep since bfs/ugrep are drop-in replacements and we want
  // consistent fast behavior in Claude's shell.
  const findGrepIntegration = createFindGrepShellIntegration()
  if (findGrepIntegration !== null) {
    content += `
      # Shadow find/grep with embedded bfs/ugrep (ant-native only)
      echo "# Shadow find/grep with embedded bfs/ugrep" >> "$SNAPSHOT_FILE"
      cat >> "$SNAPSHOT_FILE" << 'FIND_GREP_FUNC_END'
${findGrepIntegration}
FIND_GREP_FUNC_END
    `
  }

  // Add PATH to the file
  content += `

      # Add PATH to the file
      echo "export PATH=${quote([pathValue || ''])}" >> "$SNAPSHOT_FILE"
  `

  return content
}

/**
 * 组合完整的快照脚本：source 用户配置 → 清空快照文件 → 写入环境数据。
 * 脚本结构：
 * 1. 若配置文件存在，先 `source "<configFile>" < /dev/null` 加载用户环境。
 * 2. 创建或清空 $SNAPSHOT_FILE（使用 `>|` 强制覆盖，跳过 noclobber 选项）。
 * 3. 写入 `unalias -a` 以避免函数定义捕获时别名冻结导致的意外行为。
 * 4. 写入 getUserSnapshotContent()（函数、选项、别名）。
 * 5. 写入 getClaudeCodeSnapshotContent()（PATH、rg/find/grep 集成）。
 * 6. 校验快照文件已生成，否则输出错误并以退出码 1 退出。
 */
async function getSnapshotScript(
  shellPath: string,
  snapshotFilePath: string,
  configFileExists: boolean,
): Promise<string> {
  const configFile = getConfigFile(shellPath)
  const isZsh = configFile.endsWith('.zshrc')

  // Generate the user content and Claude Code content
  const userContent = configFileExists
    ? getUserSnapshotContent(configFile)
    : !isZsh
      ? // we need to manually force alias expansion in bash - normally `getUserSnapshotContent` takes care of this
        'echo "shopt -s expand_aliases" >> "$SNAPSHOT_FILE"'
      : ''
  const claudeCodeContent = await getClaudeCodeSnapshotContent()

  const script = `SNAPSHOT_FILE=${quote([snapshotFilePath])}
      ${configFileExists ? `source "${configFile}" < /dev/null` : '# No user config file to source'}

      # First, create/clear the snapshot file
      echo "# Snapshot file" >| "$SNAPSHOT_FILE"

      # When this file is sourced, we first unalias to avoid conflicts
      # This is necessary because aliases get "frozen" inside function definitions at definition time,
      # which can cause unexpected behavior when functions use commands that conflict with aliases
      echo "# Unset all aliases to avoid conflicts with functions" >> "$SNAPSHOT_FILE"
      echo "unalias -a 2>/dev/null || true" >> "$SNAPSHOT_FILE"

      ${userContent}

      ${claudeCodeContent}

      # Exit silently on success, only report errors
      if [ ! -f "$SNAPSHOT_FILE" ]; then
        echo "Error: Snapshot file was not created at $SNAPSHOT_FILE" >&2
        exit 1
      fi
    `

  return script
}

/**
 * 创建并保存 shell 环境快照，返回快照文件路径；失败时返回 undefined。
 *
 * 完整执行流程：
 * 1. 根据 binShell 路径推断 shellType（zsh/bash/sh）。
 * 2. 调用 getConfigFile() 定位用户配置文件，并检查其是否存在。
 * 3. 在 ~/.claude/shell-snapshots/ 下生成带时间戳和随机 ID 的快照文件名。
 * 4. 调用 getSnapshotScript() 构建快照脚本，通过 execFile() 在用户 shell 中执行。
 *    执行时注入 CLAUDECODE=1、GIT_EDITOR=true 等环境变量；超时 10 秒。
 * 5. 执行成功后通过 registerCleanup() 注册进程退出时删除快照文件的清理钩子。
 * 6. 执行失败时记录详细调试日志、上报 analytics 事件，并 resolve(undefined)。
 *
 * @param binShell 用户 shell 的完整路径（如 /bin/zsh）
 * @returns 快照文件的绝对路径，或创建失败时的 undefined
 */
export const createAndSaveSnapshot = async (
  binShell: string,
): Promise<string | undefined> => {
  const shellType = binShell.includes('zsh')
    ? 'zsh'
    : binShell.includes('bash')
      ? 'bash'
      : 'sh'

  logForDebugging(`Creating shell snapshot for ${shellType} (${binShell})`)

  return new Promise(async resolve => {
    try {
      const configFile = getConfigFile(binShell)
      logForDebugging(`Looking for shell config file: ${configFile}`)
      const configFileExists = await pathExists(configFile)

      if (!configFileExists) {
        logForDebugging(
          `Shell config file not found: ${configFile}, creating snapshot with Claude Code defaults only`,
        )
      }

      // Create unique snapshot path with timestamp and random ID
      const timestamp = Date.now()
      const randomId = Math.random().toString(36).substring(2, 8)
      const snapshotsDir = join(getClaudeConfigHomeDir(), 'shell-snapshots')
      logForDebugging(`Snapshots directory: ${snapshotsDir}`)
      const shellSnapshotPath = join(
        snapshotsDir,
        `snapshot-${shellType}-${timestamp}-${randomId}.sh`,
      )

      // Ensure snapshots directory exists
      await mkdir(snapshotsDir, { recursive: true })

      const snapshotScript = await getSnapshotScript(
        binShell,
        shellSnapshotPath,
        configFileExists,
      )
      logForDebugging(`Creating snapshot at: ${shellSnapshotPath}`)
      logForDebugging(`Execution timeout: ${SNAPSHOT_CREATION_TIMEOUT}ms`)
      execFile(
        binShell,
        ['-c', '-l', snapshotScript],
        {
          env: {
            ...((process.env.CLAUDE_CODE_DONT_INHERIT_ENV
              ? {}
              : subprocessEnv()) as typeof process.env),
            SHELL: binShell,
            GIT_EDITOR: 'true',
            CLAUDECODE: '1',
          },
          timeout: SNAPSHOT_CREATION_TIMEOUT,
          maxBuffer: 1024 * 1024, // 1MB buffer
          encoding: 'utf8',
        },
        async (error, stdout, stderr) => {
          if (error) {
            const execError = error as Error & {
              killed?: boolean
              signal?: string
              code?: number
            }
            logForDebugging(`Shell snapshot creation failed: ${error.message}`)
            logForDebugging(`Error details:`)
            logForDebugging(`  - Error code: ${execError?.code}`)
            logForDebugging(`  - Error signal: ${execError?.signal}`)
            logForDebugging(`  - Error killed: ${execError?.killed}`)
            logForDebugging(`  - Shell path: ${binShell}`)
            logForDebugging(`  - Config file: ${getConfigFile(binShell)}`)
            logForDebugging(`  - Config file exists: ${configFileExists}`)
            logForDebugging(`  - Working directory: ${getCwd()}`)
            logForDebugging(`  - Claude home: ${getClaudeConfigHomeDir()}`)
            logForDebugging(`Full snapshot script:\n${snapshotScript}`)
            if (stdout) {
              logForDebugging(
                `stdout output (${stdout.length} chars):\n${stdout}`,
              )
            } else {
              logForDebugging(`No stdout output captured`)
            }
            if (stderr) {
              logForDebugging(
                `stderr output (${stderr.length} chars): ${stderr}`,
              )
            } else {
              logForDebugging(`No stderr output captured`)
            }
            logError(
              new Error(`Failed to create shell snapshot: ${error.message}`),
            )
            // Convert signal name to number if present
            const signalNumber = execError?.signal
              ? os.constants.signals[
                  execError.signal as keyof typeof os.constants.signals
                ]
              : undefined
            logEvent('tengu_shell_snapshot_failed', {
              stderr_length: stderr?.length || 0,
              has_error_code: !!execError?.code,
              error_signal_number: signalNumber,
              error_killed: execError?.killed,
            })
            resolve(undefined)
          } else {
            let snapshotSize: number | undefined
            try {
              snapshotSize = (await stat(shellSnapshotPath)).size
            } catch {
              // Snapshot file not found
            }

            if (snapshotSize !== undefined) {
              logForDebugging(
                `Shell snapshot created successfully (${snapshotSize} bytes)`,
              )

              // Register cleanup to remove snapshot on graceful shutdown
              registerCleanup(async () => {
                try {
                  await getFsImplementation().unlink(shellSnapshotPath)
                  logForDebugging(
                    `Cleaned up session snapshot: ${shellSnapshotPath}`,
                  )
                } catch (error) {
                  logForDebugging(
                    `Error cleaning up session snapshot: ${error}`,
                  )
                }
              })

              resolve(shellSnapshotPath)
            } else {
              logForDebugging(
                `Shell snapshot file not found after creation: ${shellSnapshotPath}`,
              )
              logForDebugging(
                `Checking if parent directory still exists: ${snapshotsDir}`,
              )
              try {
                const dirContents =
                  await getFsImplementation().readdir(snapshotsDir)
                logForDebugging(
                  `Directory contains ${dirContents.length} files`,
                )
              } catch {
                logForDebugging(
                  `Parent directory does not exist or is not accessible: ${snapshotsDir}`,
                )
              }
              logEvent('tengu_shell_unknown_error', {})
              resolve(undefined)
            }
          }
        },
      )
    } catch (error) {
      logForDebugging(`Unexpected error during snapshot creation: ${error}`)
      if (error instanceof Error) {
        logForDebugging(`Error stack trace: ${error.stack}`)
      }
      logError(error)
      logEvent('tengu_shell_snapshot_error', {})
      resolve(undefined)
    }
  })
}
