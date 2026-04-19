/**
 * 跨平台进程工具模块（Generic Process Utilities）。
 *
 * 【在 Claude Code 系统中的位置】
 * 该模块是底层进程管理工具集，为锁文件管理、会话检测、进程树分析等
 * 上层功能提供平台无关的进程操作接口。
 * 该模块中的所有函数均需同时处理 Win32 和 Unix/BSD 的差异：
 * - Win32：使用 PowerShell + WMI（Get-CimInstance Win32_Process）查询进程信息
 * - Unix：使用 sh + ps 命令，但需注意 GNU ps 与 BSD ps 的参数差异
 *
 * 【主要功能】
 * - isProcessRunning(pid)：信号 0 探测，判断进程是否存活
 * - getAncestorPidsAsync(pid, maxDepth)：异步获取进程的祖先 PID 链
 * - getProcessCommand(pid)：（已弃用）同步获取进程命令行
 * - getAncestorCommandsAsync(pid, maxDepth)：异步获取进程及其祖先的命令行列表
 * - getChildPids(pid)：同步获取子进程 PID 列表
 */

import {
  execFileNoThrowWithCwd,
  execSyncWithDefaults_DEPRECATED,
} from './execFileNoThrow.js'

// 该文件包含 ps 类命令的平台无关实现。
// 向此文件添加新代码时，请确保处理：
// - Win32：cygwin 和 WSL 中的 ps 在访问宿主进程时行为可能不符合预期
// - Unix vs BSD 风格 ps 的选项不同

/**
 * 通过信号 0 探测判断给定 PID 的进程是否正在运行。
 *
 * 【注意事项】
 * - PID ≤ 1 直接返回 false（0 表示进程组，1 为 init）
 * - `process.kill(pid, 0)` 在进程存在但属于其他用户时会抛出 EPERM，
 *   此时将进程报告为"未运行"（保守策略，避免误夺活跃的锁文件）
 *
 * @param pid - 要检测的进程 ID
 * @returns 若进程存活返回 true，否则返回 false
 */
export function isProcessRunning(pid: number): boolean {
  if (pid <= 1) return false // 保护性检查：PID 0/1 不作为目标进程
  try {
    process.kill(pid, 0) // 信号 0：不发送真实信号，仅检查进程是否存在
    return true           // 未抛出异常 → 进程存在
  } catch {
    return false           // ESRCH（进程不存在）或 EPERM（无权限，保守报告为不存在）
  }
}

/**
 * 异步获取给定进程的祖先 PID 链（从直接父进程到最远祖先）。
 *
 * 【平台差异处理】
 * - Win32：执行 PowerShell 脚本，循环调用 Get-CimInstance Win32_Process
 *   查询 ParentProcessId，用逗号分隔输出
 * - Unix：执行 sh 脚本，循环调用 `ps -o ppid= -p <pid>` 逐级向上遍历，
 *   每行输出一个 PID
 *
 * @param pid - 起始进程 ID
 * @param maxDepth - 最多向上追溯的层数，默认为 10
 * @returns 祖先 PID 数组（从直接父进程到最远祖先），出错时返回空数组
 */
export async function getAncestorPidsAsync(
  pid: string | number,
  maxDepth = 10,
): Promise<number[]> {
  if (process.platform === 'win32') {
    // Win32：使用 PowerShell 遍历进程树，逗号分隔输出祖先 PID
    const script = `
      $pid = ${String(pid)}
      $ancestors = @()
      for ($i = 0; $i -lt ${maxDepth}; $i++) {
        $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$pid" -ErrorAction SilentlyContinue
        if (-not $proc -or -not $proc.ParentProcessId -or $proc.ParentProcessId -eq 0) { break }
        $pid = $proc.ParentProcessId
        $ancestors += $pid
      }
      $ancestors -join ','
    `.trim()

    const result = await execFileNoThrowWithCwd(
      'powershell.exe',
      ['-NoProfile', '-Command', script],
      { timeout: 3000 },
    )
    if (result.code !== 0 || !result.stdout?.trim()) {
      return [] // PowerShell 执行失败或无输出
    }
    return result.stdout
      .trim()
      .split(',')
      .filter(Boolean)
      .map(p => parseInt(p, 10))
      .filter(p => !isNaN(p)) // 过滤非数字行（防御性处理）
  }

  // Unix：使用 sh 脚本遍历进程树，每行输出一个 PPID
  // 单次进程调用（非多次顺序调用），避免频繁 fork 开销
  const script = `pid=${String(pid)}; for i in $(seq 1 ${maxDepth}); do ppid=$(ps -o ppid= -p $pid 2>/dev/null | tr -d ' '); if [ -z "$ppid" ] || [ "$ppid" = "0" ] || [ "$ppid" = "1" ]; then break; fi; echo $ppid; pid=$ppid; done`

  const result = await execFileNoThrowWithCwd('sh', ['-c', script], {
    timeout: 3000,
  })
  if (result.code !== 0 || !result.stdout?.trim()) {
    return [] // 脚本执行失败或无输出
  }
  return result.stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(p => parseInt(p, 10))
    .filter(p => !isNaN(p)) // 过滤空行和非数字
}

/**
 * 同步获取给定进程的命令行字符串。
 *
 * @param pid - 要查询的进程 ID
 * @returns 命令行字符串，进程不存在或查询失败时返回 null
 * @deprecated 请使用 getAncestorCommandsAsync 替代，该函数效率更高
 */
export function getProcessCommand(pid: string | number): string | null {
  try {
    const pidStr = String(pid)
    // 根据平台选择不同的命令：Win32 用 PowerShell，Unix 用 ps
    const command =
      process.platform === 'win32'
        ? `powershell.exe -NoProfile -Command "(Get-CimInstance Win32_Process -Filter \\"ProcessId=${pidStr}\\").CommandLine"`
        : `ps -o command= -p ${pidStr}`

    const result = execSyncWithDefaults_DEPRECATED(command, { timeout: 1000 })
    return result ? result.trim() : null
  } catch {
    return null
  }
}

/**
 * 异步获取给定进程及其所有祖先进程的命令行列表（单次调用）。
 *
 * 【平台差异处理】
 * - Win32：PowerShell 脚本遍历进程树，收集每级命令行，
 *   以 null 字节（\0）分隔，避免命令行中的换行符干扰解析
 * - Unix：sh 脚本遍历进程树，同样以 null 字节分隔，
 *   使用 `printf '%s\0'` 输出命令，支持命令行中含换行符的情况
 *
 * @param pid - 起始进程 ID
 * @param maxDepth - 最多向上追溯的层数，默认为 10
 * @returns 命令行字符串数组（含起始进程自身），出错时返回空数组
 */
export async function getAncestorCommandsAsync(
  pid: string | number,
  maxDepth = 10,
): Promise<string[]> {
  if (process.platform === 'win32') {
    // Win32：PowerShell 脚本遍历进程树，以 null 字节分隔命令行
    const script = `
      $currentPid = ${String(pid)}
      $commands = @()
      for ($i = 0; $i -lt ${maxDepth}; $i++) {
        $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$currentPid" -ErrorAction SilentlyContinue
        if (-not $proc) { break }
        if ($proc.CommandLine) { $commands += $proc.CommandLine }
        if (-not $proc.ParentProcessId -or $proc.ParentProcessId -eq 0) { break }
        $currentPid = $proc.ParentProcessId
      }
      $commands -join [char]0
    `.trim()

    const result = await execFileNoThrowWithCwd(
      'powershell.exe',
      ['-NoProfile', '-Command', script],
      { timeout: 3000 },
    )
    if (result.code !== 0 || !result.stdout?.trim()) {
      return [] // PowerShell 执行失败或无输出
    }
    return result.stdout.split('\0').filter(Boolean) // 以 null 字节分割，过滤空项
  }

  // Unix：sh 脚本遍历进程树，以 null 字节（\0）分隔命令行
  // 使用 null 字节作分隔符，支持命令行中含换行符的情况
  const script = `currentpid=${String(pid)}; for i in $(seq 1 ${maxDepth}); do cmd=$(ps -o command= -p $currentpid 2>/dev/null); if [ -n "$cmd" ]; then printf '%s\\0' "$cmd"; fi; ppid=$(ps -o ppid= -p $currentpid 2>/dev/null | tr -d ' '); if [ -z "$ppid" ] || [ "$ppid" = "0" ] || [ "$ppid" = "1" ]; then break; fi; currentpid=$ppid; done`

  const result = await execFileNoThrowWithCwd('sh', ['-c', script], {
    timeout: 3000,
  })
  if (result.code !== 0 || !result.stdout?.trim()) {
    return [] // 脚本执行失败或无输出
  }
  return result.stdout.split('\0').filter(Boolean) // 以 null 字节分割，过滤空项
}

/**
 * 同步获取给定进程的直接子进程 PID 列表。
 *
 * 【平台差异处理】
 * - Win32：PowerShell + WMI 查询 ParentProcessId 匹配的进程
 * - Unix：使用 `pgrep -P <pid>` 获取子进程（更简洁高效）
 *
 * @param pid - 父进程 ID
 * @returns 子进程 PID 数组，出错或无子进程时返回空数组
 */
export function getChildPids(pid: string | number): number[] {
  try {
    const pidStr = String(pid)
    // 根据平台选择不同命令
    const command =
      process.platform === 'win32'
        ? `powershell.exe -NoProfile -Command "(Get-CimInstance Win32_Process -Filter \\"ParentProcessId=${pidStr}\\").ProcessId"`
        : `pgrep -P ${pidStr}` // Unix：pgrep 按父 PID 查找子进程

    const result = execSyncWithDefaults_DEPRECATED(command, { timeout: 1000 })
    if (!result) {
      return [] // 无输出（无子进程）
    }
    return result
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(p => parseInt(p, 10))
      .filter(p => !isNaN(p)) // 过滤空行和非数字
  } catch {
    return [] // 命令执行失败，返回空数组
  }
}
