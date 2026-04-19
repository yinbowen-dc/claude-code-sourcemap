/**
 * PowerShell 可执行文件检测与缓存模块。
 *
 * 在 Claude Code 系统流中，本模块处于以下位置：
 *   Shell.ts（getPsProvider）→ powershellDetection.ts（getCachedPowerShellPath）
 *                              ↓
 *   powershellProvider.ts（createPowerShellProvider）
 *
 * 职责：
 * 1. 检测系统中可用的 PowerShell 可执行文件路径
 *    - 优先 pwsh（PowerShell Core 7+）
 *    - 回退到 powershell（Windows PowerShell 5.1）
 *    - 在 Linux 上绕过 snap launcher 的子进程挂起问题
 * 2. 对检测结果进行内存缓存，避免重复探测（使用模块级 Promise 缓存）
 * 3. 推断 PowerShell 版本（Core vs Desktop），用于向模型提供正确的语法提示
 */
import { realpath, stat } from 'fs/promises'
import { getPlatform } from '../platform.js'
import { which } from '../which.js'

/**
 * 探测指定路径是否为普通文件（排除目录、设备等）。
 *
 * @param p 要探测的文件系统路径
 * @returns 若路径存在且为普通文件，返回该路径；否则返回 null
 */
async function probePath(p: string): Promise<string | null> {
  try {
    // stat() 会跟随符号链接，返回目标文件的信息
    return (await stat(p)).isFile() ? p : null
  } catch {
    // 路径不存在或无访问权限时返回 null
    return null
  }
}

/**
 * 在系统 PATH 中查找 PowerShell 可执行文件。
 *
 * 查找策略：
 * 1. 优先尝试 `pwsh`（PowerShell Core 7+，支持 `&&`、`||` 等现代操作符）
 * 2. 在 Linux 上，若 which() 返回的是 snap launcher 路径（/snap/...），
 *    则改为探测 APT/RPM 安装路径（/opt/microsoft/powershell/7/pwsh 等）。
 *    原因：snap launcher 在子进程中可能因 snapd 初始化而挂起，直接路径更可靠。
 * 3. 回退到 `powershell`（Windows PowerShell 5.1）
 * 4. 均不可用则返回 null
 *
 * @returns PowerShell 可执行文件的绝对路径，或 null（未安装）
 */
export async function findPowerShell(): Promise<string | null> {
  const pwshPath = await which('pwsh')
  if (pwshPath) {
    // Linux 上的 snap launcher 挂起问题：
    // 检查 PATH 解析路径和符号链接目标，判断是否为 snap 路径。
    // 某些发行版 /usr/bin/pwsh 是指向 /snap/bin/pwsh 的符号链接，
    // 需要同时检查原始路径和解析后的路径。
    if (getPlatform() === 'linux') {
      const resolved = await realpath(pwshPath).catch(() => pwshPath)
      if (pwshPath.startsWith('/snap/') || resolved.startsWith('/snap/')) {
        // 尝试已知的 APT/RPM 安装路径，确保不再解析到 snap 路径
        const direct =
          (await probePath('/opt/microsoft/powershell/7/pwsh')) ??
          (await probePath('/usr/bin/pwsh'))
        if (direct) {
          const directResolved = await realpath(direct).catch(() => direct)
          // 再次确认直接路径不是 snap 路径
          if (
            !direct.startsWith('/snap/') &&
            !directResolved.startsWith('/snap/')
          ) {
            return direct
          }
        }
      }
    }
    // 非 Linux 平台或非 snap 路径，直接返回 which 的结果
    return pwshPath
  }

  // pwsh 不可用时，尝试 Windows PowerShell 5.1
  const powershellPath = await which('powershell')
  if (powershellPath) {
    return powershellPath
  }

  // 系统中未安装任何 PowerShell
  return null
}

// 模块级 Promise 缓存——通过懒初始化确保 findPowerShell() 只调用一次
let cachedPowerShellPath: Promise<string | null> | null = null

/**
 * 获取缓存的 PowerShell 路径（懒加载 + 单例缓存）。
 *
 * 首次调用时触发 findPowerShell() 并缓存 Promise。
 * 后续调用直接返回同一 Promise，无论是否已解析完成。
 *
 * @returns 解析为 PowerShell 路径（string）或 null 的 Promise
 */
export function getCachedPowerShellPath(): Promise<string | null> {
  if (!cachedPowerShellPath) {
    // 首次调用，触发检测并缓存 Promise
    cachedPowerShellPath = findPowerShell()
  }
  return cachedPowerShellPath
}

/**
 * PowerShell 版本类型：
 * - 'core'：PowerShell Core 7+（pwsh），支持 &&、||、?:、?? 等管道链操作符
 * - 'desktop'：Windows PowerShell 5.1（powershell），不支持管道链操作符
 */
export type PowerShellEdition = 'core' | 'desktop'

/**
 * 通过可执行文件名推断 PowerShell 版本类型（无需 spawn 进程）。
 *
 * 推断规则：
 * - 文件名为 `pwsh` 或 `pwsh.exe` → 'core'（PowerShell 7+）
 * - 文件名为 `powershell` 或 `powershell.exe` → 'desktop'（Windows PowerShell 5.1）
 *
 * PowerShell 6（也使用 pwsh 名称，但不支持 &&）已于 2020 年 EOL，
 * 不在支持范围内，因此 'core' 安全地隐含 7+ 语义。
 *
 * 此结果用于工具提示，向模型提供版本相关的语法指导——
 * 避免在 5.1 上生成 `cmd1 && cmd2`（解析错误）或在 7+ 上规避 `&&`（正确操作符）。
 *
 * @returns PowerShell 版本类型，未安装时返回 null
 */
export async function getPowerShellEdition(): Promise<PowerShellEdition | null> {
  const p = await getCachedPowerShellPath()
  if (!p) return null
  // 提取文件名（去除目录和 .exe 扩展名），不区分大小写。
  // 覆盖路径示例：
  //   C:\Program Files\PowerShell\7\pwsh.exe
  //   /opt/microsoft/powershell/7/pwsh
  //   C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe
  const base = p
    .split(/[/\\]/)   // 同时支持 POSIX（/）和 Windows（\）路径分隔符
    .pop()!
    .toLowerCase()
    .replace(/\.exe$/, '')  // 去除 Windows 可执行文件扩展名
  return base === 'pwsh' ? 'core' : 'desktop'
}

/**
 * 重置 PowerShell 路径缓存（仅供测试使用）。
 *
 * 允许测试用例模拟不同的 PowerShell 安装场景，
 * 通过在测试间重置缓存来避免状态污染。
 */
export function resetPowerShellCache(): void {
  cachedPowerShellPath = null
}
