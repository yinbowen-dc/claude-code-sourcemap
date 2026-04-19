/**
 * Bash/Zsh Shell 提供者模块（BashShellProvider）。
 *
 * 在 Claude Code 系统流中，本模块处于以下位置：
 *   Shell.ts（exec）→ bashProvider.ts（buildExecCommand）→ spawn 子进程
 *
 * 职责：
 * 1. 构建每次命令执行所需的完整 shell 命令字符串
 *    - 加载 shell 快照（ShellSnapshot）以恢复会话环境变量
 *    - 注入会话级环境脚本（sessionEnvironmentScript）
 *    - 禁用 extglob/EXTENDED_GLOB 以防止恶意文件名注入
 *    - 用 eval 二次解析以展开别名
 *    - 末尾追加 `pwd -P` 以跟踪工作目录变化
 * 2. 提供 getSpawnArgs()：当快照可用时省略 `-l`（login-shell），加速启动
 * 3. 提供 getEnvironmentOverrides()：按需初始化 tmux 隔离 socket，
 *    并将沙箱临时目录注入到 TMPDIR/TMPPREFIX 等环境变量中
 */
import { feature } from 'bun:bundle'
import { access } from 'fs/promises'
import { tmpdir as osTmpdir } from 'os'
import { join as nativeJoin } from 'path'
import { join as posixJoin } from 'path/posix'
import { rearrangePipeCommand } from '../bash/bashPipeCommand.js'
import { createAndSaveSnapshot } from '../bash/ShellSnapshot.js'
import { formatShellPrefixCommand } from '../bash/shellPrefix.js'
import { quote } from '../bash/shellQuote.js'
import {
  quoteShellCommand,
  rewriteWindowsNullRedirect,
  shouldAddStdinRedirect,
} from '../bash/shellQuoting.js'
import { logForDebugging } from '../debug.js'
import { getPlatform } from '../platform.js'
import { getSessionEnvironmentScript } from '../sessionEnvironment.js'
import { getSessionEnvVars } from '../sessionEnvVars.js'
import {
  ensureSocketInitialized,
  getClaudeTmuxEnv,
  hasTmuxToolBeenUsed,
} from '../tmuxSocket.js'
import { windowsPathToPosixPath } from '../windowsPaths.js'
import type { ShellProvider } from './shellProvider.js'

/**
 * 返回用于禁用扩展 glob 模式的 shell 命令。
 *
 * 扩展 glob（bash extglob / zsh EXTENDED_GLOB）在安全校验通过后，
 * 恶意文件名可能触发意外展开，构成安全风险。
 *
 * 当 CLAUDE_CODE_SHELL_PREFIX 被设置时，实际执行的 shell 可能与 shellPath 不同
 * （例如 shellPath 是 zsh，但包装器运行的是 bash）。此时同时输出 bash 和 zsh 的
 * 禁用命令，并将 stdout/stderr 都重定向到 /dev/null，避免 zsh 的
 * command_not_found_handler 向 STDOUT 写入干扰。
 *
 * @param shellPath 当前使用的 shell 路径（含 "bash" 或 "zsh" 字样）
 * @returns 要在命令前执行的禁用 extglob 字符串，不需要时返回 null
 */
function getDisableExtglobCommand(shellPath: string): string | null {
  // 设置了 CLAUDE_CODE_SHELL_PREFIX 时，包装器 shell 可能与 shellPath 不同，
  // 需要同时包含 bash 和 zsh 的禁用命令
  if (process.env.CLAUDE_CODE_SHELL_PREFIX) {
    // 同时重定向 stdout 和 stderr，因为 zsh 的 command_not_found_handler
    // 会向 stdout 写入（而非 stderr）
    return '{ shopt -u extglob || setopt NO_EXTENDED_GLOB; } >/dev/null 2>&1 || true'
  }

  // 无 shell 前缀时，按检测到的 shell 类型选择对应命令
  if (shellPath.includes('bash')) {
    return 'shopt -u extglob 2>/dev/null || true'
  } else if (shellPath.includes('zsh')) {
    return 'setopt NO_EXTENDED_GLOB 2>/dev/null || true'
  }
  // 未知 shell，不执行任何操作
  return null
}

/**
 * 创建 Bash/Zsh ShellProvider 实例。
 *
 * 整体流程：
 * 1. 异步创建并保存 shell 快照（捕获用户 .bashrc/.zshrc 中的环境变量、别名等）
 * 2. 返回实现了 ShellProvider 接口的对象，供 Shell.ts 的 exec() 调用
 *
 * @param shellPath  已验证可执行的 shell 路径（bash 或 zsh）
 * @param options    可选配置，skipSnapshot=true 跳过快照创建（用于测试）
 */
export async function createBashShellProvider(
  shellPath: string,
  options?: { skipSnapshot?: boolean },
): Promise<ShellProvider> {
  // 当前沙箱临时目录（每次 buildExecCommand 调用时更新）
  let currentSandboxTmpDir: string | undefined
  // 快照文件路径的 Promise，若 skipSnapshot=true 则解析为 undefined
  const snapshotPromise: Promise<string | undefined> = options?.skipSnapshot
    ? Promise.resolve(undefined)
    : createAndSaveSnapshot(shellPath).catch(error => {
        logForDebugging(`Failed to create shell snapshot: ${error}`)
        return undefined
      })
  // 记录最近一次解析到的快照路径，供 getSpawnArgs 判断是否跳过 -l 标志
  let lastSnapshotFilePath: string | undefined

  return {
    type: 'bash',
    shellPath,
    // bash 提供者使用 detached=true，使进程组独立，以便 tree-kill 能正确终止子进程树
    detached: true,

    /**
     * 构建完整的 shell 执行命令字符串，并返回 cwd 跟踪文件路径。
     *
     * 构建流程：
     * 1. 等待并检查快照文件是否仍然存在
     * 2. 规范化命令（Windows null 重定向、stdin 重定向）
     * 3. 拼接命令块：source 快照 → 注入 session env → 禁用 extglob → eval 命令 → 记录 pwd
     * 4. 若设置了 CLAUDE_CODE_SHELL_PREFIX，用前缀包装整个命令
     */
    async buildExecCommand(
      command: string,
      opts: {
        id: number | string
        sandboxTmpDir?: string
        useSandbox: boolean
      },
    ): Promise<{ commandString: string; cwdFilePath: string }> {
      let snapshotFilePath = await snapshotPromise
      // 检查快照文件是否仍然存在（避免 tmpdir 清理导致静默失败）。
      // 若快照已消失，清空 lastSnapshotFilePath，让 getSpawnArgs 添加 -l
      // 以通过 login-shell 重新初始化环境。
      if (snapshotFilePath) {
        try {
          await access(snapshotFilePath)
        } catch {
          logForDebugging(
            `Snapshot file missing, falling back to login shell: ${snapshotFilePath}`,
          )
          snapshotFilePath = undefined
        }
      }
      // 更新最新快照路径供 getSpawnArgs 使用
      lastSnapshotFilePath = snapshotFilePath

      // 存储沙箱临时目录供 getEnvironmentOverrides 使用
      currentSandboxTmpDir = opts.sandboxTmpDir

      const tmpdir = osTmpdir()
      const isWindows = getPlatform() === 'windows'
      // Windows 下 Git Bash 需要 POSIX 风格路径
      const shellTmpdir = isWindows ? windowsPathToPosixPath(tmpdir) : tmpdir

      // shellCwdFilePath：用于 bash 命令内部（pwd -P >| ...），需要 POSIX 格式
      // cwdFilePath：用于 Node.js 的 readFileSync/unlinkSync，需要原生 OS 格式
      // 非 Windows 下两者相同
      const shellCwdFilePath = opts.useSandbox
        ? posixJoin(opts.sandboxTmpDir!, `cwd-${opts.id}`)
        : posixJoin(shellTmpdir, `claude-${opts.id}-cwd`)
      const cwdFilePath = opts.useSandbox
        ? posixJoin(opts.sandboxTmpDir!, `cwd-${opts.id}`)
        : nativeJoin(tmpdir, `claude-${opts.id}-cwd`)

      // 防御性重写：模型有时会生成 Windows CMD 风格的 `2>nul` 重定向。
      // 在 POSIX bash（包括 Windows 上的 Git Bash）中，这会创建名为 `nul` 的
      // 文件——这是一个保留设备名，会破坏 git。见 anthropics/claude-code#4928。
      const normalizedCommand = rewriteWindowsNullRedirect(command)
      const addStdinRedirect = shouldAddStdinRedirect(normalizedCommand)
      let quotedCommand = quoteShellCommand(normalizedCommand, addStdinRedirect)

      // 对 heredoc/多行命令启用调试日志（仅当开启 COMMIT_ATTRIBUTION 功能时）
      if (
        feature('COMMIT_ATTRIBUTION') &&
        (command.includes('<<') || command.includes('\n'))
      ) {
        logForDebugging(
          `Shell: Command before quoting (first 500 chars):\n${command.slice(0, 500)}`,
        )
        logForDebugging(
          `Shell: Quoted command (first 500 chars):\n${quotedCommand.slice(0, 500)}`,
        )
      }

      // 管道命令的特殊处理：将 stdin 重定向移至第一个管道命令之后。
      // 这确保重定向作用于第一个命令，而不是 eval 自身。
      // 若不处理，`eval 'rg foo | wc -l' < /dev/null` 会变成
      // `rg foo | wc -l < /dev/null`——wc 读取 /dev/null 输出 0，
      // 而 rg（无路径参数）会在 spawn 的 stdin 管道上永久阻塞。
      if (normalizedCommand.includes('|') && addStdinRedirect) {
        quotedCommand = rearrangePipeCommand(normalizedCommand)
      }

      // 各命令块依次推入数组，最终用 && 连接
      const commandParts: string[] = []

      // 1. source 快照文件，恢复用户的 shell 环境（别名、函数、环境变量等）。
      //    `|| true` 防止快照文件在 access() 检查与实际 source 之间消失时导致整链失败。
      if (snapshotFilePath) {
        const finalPath =
          getPlatform() === 'windows'
            ? windowsPathToPosixPath(snapshotFilePath)
            : snapshotFilePath
        commandParts.push(`source ${quote([finalPath])} 2>/dev/null || true`)
      }

      // 2. source 会话环境脚本（通过 session-start hooks 捕获的变量）
      const sessionEnvScript = await getSessionEnvironmentScript()
      if (sessionEnvScript) {
        commandParts.push(sessionEnvScript)
      }

      // 3. 禁用扩展 glob，防止安全校验通过后被恶意文件名利用（在 source 用户配置后执行，以覆盖用户设置）
      const disableExtglobCmd = getDisableExtglobCommand(shellPath)
      if (disableExtglobCmd) {
        commandParts.push(disableExtglobCmd)
      }

      // 4. 用 eval 执行命令：source 文件中的别名在同一命令行中不会立即展开，
      //    eval 触发二次解析，此时别名已可用。
      commandParts.push(`eval ${quotedCommand}`)
      // 5. 用 `pwd -P` 记录命令执行后的物理工作目录（解析符号链接）
      commandParts.push(`pwd -P >| ${quote([shellCwdFilePath])}`)
      let commandString = commandParts.join(' && ')

      // 若设置了 CLAUDE_CODE_SHELL_PREFIX，用前缀包装完整命令字符串
      if (process.env.CLAUDE_CODE_SHELL_PREFIX) {
        commandString = formatShellPrefixCommand(
          process.env.CLAUDE_CODE_SHELL_PREFIX,
          commandString,
        )
      }

      return { commandString, cwdFilePath }
    },

    /**
     * 返回传给 spawn() 的 shell 参数数组。
     *
     * 若快照文件存在（环境已被 source 进命令字符串），跳过 -l（login-shell）标志，
     * 避免重复加载 .bashrc/.zshrc，提高启动速度。
     * 快照消失时，回退到 -l 以确保 shell 初始化正确执行。
     */
    getSpawnArgs(commandString: string): string[] {
      // 快照存在时跳过 login-shell，避免重复初始化
      const skipLoginShell = lastSnapshotFilePath !== undefined
      if (skipLoginShell) {
        logForDebugging('Spawning shell without login (-l flag skipped)')
      }
      return ['-c', ...(skipLoginShell ? [] : ['-l']), commandString]
    },

    /**
     * 返回此 shell 类型所需的额外环境变量覆盖。
     *
     * 主要逻辑：
     * 1. 按需初始化 Claude 的 tmux 隔离 socket（仅在 tmux 工具被使用或命令含 tmux 时）
     * 2. 若已初始化，将 TMUX 覆盖为 Claude 的私有 socket（隔离用户 tmux 会话）
     * 3. 沙箱模式下，将 TMPDIR/CLAUDE_CODE_TMPDIR/TMPPREFIX 指向沙箱临时目录
     * 4. 应用通过 /env 命令设置的会话级环境变量
     *
     * @param command 即将执行的原始命令字符串（用于检测是否含 tmux）
     */
    async getEnvironmentOverrides(
      command: string,
    ): Promise<Record<string, string>> {
      // TMUX SOCKET 隔离（延迟初始化）：
      // 仅在 Tmux 工具被使用过，或当前命令包含 tmux 时，才初始化 Claude 的 tmux socket。
      // 一旦初始化，后续所有 Bash 命令都通过 TMUX 环境变量使用 Claude 的隔离 socket。
      const commandUsesTmux = command.includes('tmux')
      if (
        process.env.USER_TYPE === 'ant' &&
        (hasTmuxToolBeenUsed() || commandUsesTmux)
      ) {
        await ensureSocketInitialized()
      }
      const claudeTmuxEnv = getClaudeTmuxEnv()
      const env: Record<string, string> = {}
      // 关键：将 TMUX 覆盖为 Claude 的隔离 socket，
      // 防止 Claude 的命令干扰用户的 tmux 会话。
      // claudeTmuxEnv 为 null 时（socket 尚未初始化），保留用户的 TMUX 值。
      if (claudeTmuxEnv) {
        env.TMUX = claudeTmuxEnv
      }
      if (currentSandboxTmpDir) {
        let posixTmpDir = currentSandboxTmpDir
        // Windows 下转换为 POSIX 路径格式
        if (getPlatform() === 'windows') {
          posixTmpDir = windowsPathToPosixPath(posixTmpDir)
        }
        // 将临时目录指向沙箱内的目录，防止沙箱进程访问主机 tmpdir
        env.TMPDIR = posixTmpDir
        env.CLAUDE_CODE_TMPDIR = posixTmpDir
        // zsh 使用 TMPPREFIX（默认 /tmp/zsh）存储 heredoc 临时文件，
        // 而非 TMPDIR。将其指向沙箱 tmpdir 内的子路径，
        // 使沙箱化的 zsh 命令能正常使用 heredoc。
        // 对非 zsh shell 无影响（被忽略）。
        env.TMPPREFIX = posixJoin(posixTmpDir, 'zsh')
      }
      // 应用通过 /env 命令设置的会话级环境变量（仅影响子进程，不影响 REPL）
      for (const [key, value] of getSessionEnvVars()) {
        env[key] = value
      }
      return env
    },
  }
}
