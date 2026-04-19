/**
 * PowerShell Shell 提供者模块（PowerShellProvider）。
 *
 * 在 Claude Code 系统流中，本模块处于以下位置：
 *   Shell.ts（exec → getPsProvider）→ powershellProvider.ts（buildExecCommand）→ spawn 子进程
 *
 * 职责：
 * 1. 构建 PowerShell 命令字符串，附加 cwd 跟踪（(Get-Location).Path | Out-File ...）
 *    和退出码捕获（$LASTEXITCODE / $?）逻辑
 * 2. 沙箱模式下，将命令编码为 Base64 UTF-16LE（-EncodedCommand），
 *    以避免沙箱运行时的 shellquote 层破坏特殊字符（!、$、? 等）
 * 3. 提供 getSpawnArgs()：包装 -NoProfile -NonInteractive 等启动标志
 * 4. 提供 getEnvironmentOverrides()：注入沙箱临时目录及会话级环境变量
 */
import { tmpdir } from 'os'
import { join } from 'path'
import { join as posixJoin } from 'path/posix'
import { getSessionEnvVars } from '../sessionEnvVars.js'
import type { ShellProvider } from './shellProvider.js'

/**
 * 构建 PowerShell spawn 参数数组（含 -NoProfile -NonInteractive 等启动标志）。
 *
 * 此函数被 provider 的 getSpawnArgs 和 hooks.ts 中的 hook spawn 路径共用，
 * 确保启动标志集中在一处维护。
 *
 * @param cmd 要执行的 PowerShell 命令字符串
 * @returns 传给 spawn() 的参数数组
 */
export function buildPowerShellArgs(cmd: string): string[] {
  return ['-NoProfile', '-NonInteractive', '-Command', cmd]
}

/**
 * 将字符串编码为 UTF-16LE Base64，用于 PowerShell 的 -EncodedCommand 参数。
 *
 * 编码原因：
 * - @anthropic-ai/sandbox-runtime 的 shellquote.quote() 会将单引号字符串中的
 *   !、$、? 重新转义（如 !→\!）。
 * - Base64 字符集仅包含 [A-Za-z0-9+/=]，不含任何需要 shell 转义的字符，
 *   因此能安全穿越任意 shell 引用层。
 * - 与 parser.ts 的 toUtf16LeBase64 使用相同的编码方式。
 *
 * @param psCommand 要编码的 PowerShell 命令字符串
 * @returns Base64 编码后的 UTF-16LE 字符串
 */
function encodePowerShellCommand(psCommand: string): string {
  // PowerShell -EncodedCommand 要求 UTF-16LE 编码（即 Windows 的 "Unicode" 编码）
  return Buffer.from(psCommand, 'utf16le').toString('base64')
}

/**
 * 创建 PowerShell ShellProvider 实例。
 *
 * 整体流程：
 * 1. 构建包含 cwd 跟踪和退出码捕获的 PowerShell 命令字符串
 * 2. 沙箱模式下，对命令进行 Base64 编码并包装为 /bin/sh 可执行的格式
 * 3. 非沙箱模式下，直接返回 PowerShell 命令，由 getSpawnArgs 添加启动标志
 *
 * @param shellPath 已验证的 PowerShell 可执行文件路径（pwsh 或 powershell）
 */
export function createPowerShellProvider(shellPath: string): ShellProvider {
  // 当前沙箱临时目录（每次 buildExecCommand 调用时更新）
  let currentSandboxTmpDir: string | undefined

  return {
    type: 'powershell' as ShellProvider['type'],
    shellPath,
    // PowerShell 不使用 detached 模式（与 bash 的进程组管理不同）
    detached: false,

    /**
     * 构建 PowerShell 执行命令字符串，并返回 cwd 跟踪文件路径。
     *
     * 构建流程：
     * 1. 确定 cwd 跟踪文件路径（沙箱模式写入沙箱 tmpdir，否则写入系统 tmpdir）
     * 2. 拼接退出码捕获和 cwd 跟踪代码片段（cwdTracking）
     * 3. 沙箱模式：将命令 Base64 编码，构建 `pwsh -NoProfile ... -EncodedCommand <b64>` 格式
     * 4. 非沙箱模式：直接返回原始 PowerShell 命令，由 getSpawnArgs 添加标志
     */
    async buildExecCommand(
      command: string,
      opts: {
        id: number | string
        sandboxTmpDir?: string
        useSandbox: boolean
      },
    ): Promise<{ commandString: string; cwdFilePath: string }> {
      // 存储沙箱临时目录供 getEnvironmentOverrides 使用（与 bashProvider 保持一致）
      currentSandboxTmpDir = opts.useSandbox ? opts.sandboxTmpDir : undefined

      // 确定 cwd 跟踪文件路径：
      // - 沙箱模式下，系统 tmpdir() 不可写，必须使用沙箱 tmpdir（沙箱只允许写入此目录）
      // - 仅在 Linux/macOS/WSL2 上有沙箱；Windows 原生下沙箱永不启用，此分支为死代码
      const cwdFilePath =
        opts.useSandbox && opts.sandboxTmpDir
          ? posixJoin(opts.sandboxTmpDir, `claude-pwd-ps-${opts.id}`)
          : join(tmpdir(), `claude-pwd-ps-${opts.id}`)
      // 转义 cwd 文件路径中的单引号（PowerShell 单引号字符串用 '' 转义）
      const escapedCwdFilePath = cwdFilePath.replace(/'/g, "''")
      // 退出码捕获逻辑：
      // - 优先使用 $LASTEXITCODE（native exe 的退出码）
      // - $LASTEXITCODE 为 $null 时（仅 cmdlet 运行），回退到 $?
      // - 这避免了 PS 5.1 的 bug：native 命令将 stderr 重定向到 PS 流时，
      //   即使 exe 返回 0，也会将 $? 设为 $false（误报失败）
      const cwdTracking = `\n; $_ec = if ($null -ne $LASTEXITCODE) { $LASTEXITCODE } elseif ($?) { 0 } else { 1 }\n; (Get-Location).Path | Out-File -FilePath '${escapedCwdFilePath}' -Encoding utf8 -NoNewline\n; exit $_ec`
      const psCommand = command + cwdTracking

      // 沙箱模式的特殊处理：
      // 沙箱运行时会将命令包装为 `<binShell> -c '<cmd>'`（硬编码 -c，无法注入 -NoProfile 等标志）。
      // 解决方案：构建一个自身调用 pwsh 的命令，以完整标志集执行 Base64 编码的命令。
      // Shell.ts 传入 /bin/sh 作为沙箱的 binShell，最终产生：
      //   bwrap ... sh -c 'pwsh -NoProfile -NonInteractive -EncodedCommand <base64>'
      //
      // 使用 -EncodedCommand（Base64 UTF-16LE）而非 -Command 的原因：
      // 沙箱运行时会对返回的 commandString 应用 shellquote.quote()，
      // 含单引号的字符串会触发双引号模式，将 ! 转义为 \!，导致 pwsh 解析错误。
      // Base64 字符集 [A-Za-z0-9+/=] 不含任何引用层会破坏的字符。
      //
      // shellPath 使用 POSIX 单引号转义，确保含空格的安装路径能正确处理
      const commandString = opts.useSandbox
        ? [
            `'${shellPath.replace(/'/g, `'\\''`)}'`,  // POSIX 单引号转义 shellPath
            '-NoProfile',
            '-NonInteractive',
            '-EncodedCommand',
            encodePowerShellCommand(psCommand),        // Base64 编码命令
          ].join(' ')
        : psCommand  // 非沙箱模式直接使用原始命令，getSpawnArgs 会添加 -NoProfile 等标志

      return { commandString, cwdFilePath }
    },

    /**
     * 返回传给 spawn() 的 PowerShell 参数数组。
     *
     * 委托给 buildPowerShellArgs()，确保标志集在 provider 和 hooks 路径间保持一致。
     */
    getSpawnArgs(commandString: string): string[] {
      return buildPowerShellArgs(commandString)
    },

    /**
     * 返回此 PowerShell 实例所需的额外环境变量覆盖。
     *
     * 主要逻辑：
     * 1. 应用通过 /env 命令设置的会话级环境变量（优先于沙箱 TMPDIR，
     *    防止用户的 `/env TMPDIR=...` 覆盖沙箱隔离）
     * 2. 沙箱模式下，覆盖 TMPDIR 和 CLAUDE_CODE_TMPDIR 为沙箱临时目录
     *    （PowerShell 在 Linux/macOS 上通过 TMPDIR 获取临时路径）
     */
    async getEnvironmentOverrides(): Promise<Record<string, string>> {
      const env: Record<string, string> = {}
      // 1. 应用会话级环境变量（通过 /env 设置，仅影响子进程，不影响 REPL）。
      //    顺序：会话变量优先，使沙箱 TMPDIR 不会被 `/env TMPDIR=...` 覆盖。
      for (const [key, value] of getSessionEnvVars()) {
        env[key] = value
      }
      if (currentSandboxTmpDir) {
        // PowerShell 在 Linux/macOS 上通过 TMPDIR 获取 [System.IO.Path]::GetTempPath()
        env.TMPDIR = currentSandboxTmpDir
        env.CLAUDE_CODE_TMPDIR = currentSandboxTmpDir
      }
      return env
    },
  }
}
