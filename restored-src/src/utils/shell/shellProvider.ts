/**
 * Shell 提供者接口定义模块（ShellProvider）。
 *
 * 在 Claude Code 系统流中，本模块处于以下位置：
 *   Shell.ts（exec）→ ShellProvider 接口 → bashProvider / powershellProvider
 *
 * 职责：
 * - 定义所有 shell 类型的统一抽象接口（ShellProvider），
 *   使 Shell.ts 的 exec() 可以用相同方式驱动 bash 和 PowerShell
 * - 定义 ShellType（'bash' | 'powershell'）联合类型
 * - 定义钩子系统使用的默认 shell 类型（DEFAULT_HOOK_SHELL）
 *
 * 扩展性：
 * - 若需要支持新 shell（如 fish），只需实现此接口并在 Shell.ts 的 resolveProvider 中注册
 */

// 所有支持的 shell 类型的常量元组（const assertion 确保类型精确）
export const SHELL_TYPES = ['bash', 'powershell'] as const

// Shell 类型的联合类型：'bash' | 'powershell'
export type ShellType = (typeof SHELL_TYPES)[number]

// 钩子系统（hooks）使用的默认 shell 类型
// 与平台无关，钩子始终通过 bash 路径执行
export const DEFAULT_HOOK_SHELL: ShellType = 'bash'

/**
 * Shell 提供者接口：抽象不同 shell 的命令构建与 spawn 参数差异。
 *
 * 每种 shell 类型（bash/powershell）各有一个实现：
 * - bashProvider：bash/zsh 的提供者
 * - powershellProvider：pwsh/powershell 的提供者
 */
export type ShellProvider = {
  /** shell 类型标识符，用于日志和分支判断 */
  type: ShellType
  /** shell 可执行文件的完整路径（如 /bin/bash、/usr/bin/pwsh） */
  shellPath: string
  /**
   * 是否使用 detached 模式 spawn 子进程。
   * bash：true（独立进程组，便于 tree-kill 终止整个进程树）
   * powershell：false（不使用 detached，PowerShell 有自己的进程管理）
   */
  detached: boolean

  /**
   * 构建包含所有 shell 特定初始化逻辑的完整命令字符串。
   *
   * bash 的命令字符串包括：
   *   source 快照文件 → source 会话环境脚本 → 禁用 extglob → eval 命令 → pwd -P 跟踪 cwd
   *
   * powershell 的命令字符串包括：
   *   命令主体 → 退出码捕获（$LASTEXITCODE/$?）→ cwd 跟踪（Out-File）
   *
   * @param command 用户原始命令字符串
   * @param opts    执行选项（ID、沙箱 tmpdir、是否启用沙箱）
   * @returns 最终命令字符串 + cwd 跟踪文件路径
   */
  buildExecCommand(
    command: string,
    opts: {
      /** 当前命令的唯一 ID（用于生成临时文件名，避免并发冲突） */
      id: number | string
      /** 沙箱临时目录路径（仅沙箱模式下提供） */
      sandboxTmpDir?: string
      /** 是否启用沙箱执行 */
      useSandbox: boolean
    },
  ): Promise<{ commandString: string; cwdFilePath: string }>

  /**
   * 返回传给 spawn() 的 shell 参数数组。
   *
   * 示例：
   * - bash（有快照）：['-c', commandString]
   * - bash（无快照）：['-c', '-l', commandString]（-l 触发 login-shell 初始化）
   * - powershell：['-NoProfile', '-NonInteractive', '-Command', commandString]
   *
   * @param commandString buildExecCommand 返回的完整命令字符串
   */
  getSpawnArgs(commandString: string): string[]

  /**
   * 返回此 shell 类型所需的额外进程环境变量覆盖。
   *
   * 可能执行异步初始化（如 bash 的 tmux socket 设置）。
   *
   * @param command 原始命令字符串（bash 用于检测是否含 tmux）
   * @returns 要注入到子进程 env 中的键值对
   */
  getEnvironmentOverrides(command: string): Promise<Record<string, string>>
}
