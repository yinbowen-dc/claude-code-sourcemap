/**
 * 【文件定位】包管理器检测模块 — Claude Code 自更新系统的安装来源识别层
 *
 * 在 Claude Code 的系统架构中，本文件处于\"安装方式识别\"环节：
 *   installer.ts（自更新决策） → [本模块：识别安装来源] → 决定是否自动更新
 *
 * 主要职责：
 *   1. 识别 Claude Code 当前是由哪种包管理器安装的（Homebrew、winget、pacman、deb、rpm、apk、mise、asdf）
 *   2. 通过检查可执行文件路径（同步）或查询包管理器数据库（异步）完成识别
 *   3. 读取 /etc/os-release 获取 Linux 发行版信息，避免在不兼容的发行版上调用错误的包管理器
 *   4. 所有异步检测器均使用 memoize 缓存，避免重复执行耗时的子进程调用
 *
 * 识别优先级（先快后慢）：
 *   1. Homebrew（路径检查，同步） → 2. winget（路径检查，同步）
 *   3. mise（路径检查，同步）     → 4. asdf（路径检查，同步）
 *   5. pacman（查询 DB，异步）    → 6. apk（查询 DB，异步）
 *   7. deb/dpkg（查询 DB，异步） → 8. rpm（查询 DB，异步）
 *   → 9. unknown（默认兜底）
 */

import { readFile } from 'fs/promises'
import memoize from 'lodash-es/memoize.js'
import { logForDebugging } from '../debug.js'
import { execFileNoThrow } from '../execFileNoThrow.js'
import { getPlatform } from '../platform.js'

/**
 * 已知包管理器的联合类型
 * 'unknown' 表示未检测到任何已知包管理器（如通过 npm install -g 安装）
 */
export type PackageManager =
  | 'homebrew'
  | 'winget'
  | 'pacman'
  | 'deb'
  | 'rpm'
  | 'apk'
  | 'mise'
  | 'asdf'
  | 'unknown'

/**
 * 解析 /etc/os-release 文件，提取发行版 ID 及其父族信息（带记忆化缓存）。
 *
 * 流程：
 *   1. 异步读取 /etc/os-release 文件内容
 *   2. 用正则提取 ID 字段（发行版自身标识，如 ubuntu、arch）
 *   3. 用正则提取 ID_LIKE 字段（父族，如 ubuntu 的 ID_LIKE=debian）
 *   4. 读取失败（非 systemd 系统或路径不存在）时返回 null，调用方降级为直接执行包管理器命令
 *
 * 作用：避免在 Debian 系统上执行 pacman（可能命中 /usr/games/pacman 游戏）
 *
 * @returns 包含 id 和 idLike 数组的对象，读取失败时返回 null
 */
export const getOsRelease = memoize(
  async (): Promise<{ id: string; idLike: string[] } | null> => {
    try {
      // 读取 Linux 发行版标准描述文件
      const content = await readFile('/etc/os-release', 'utf8')
      // 匹配 ID= 行，支持有无引号两种格式
      const idMatch = content.match(/^ID=["']?(\S+?)["']?\s*$/m)
      // 匹配 ID_LIKE= 行（多个值以空格分隔）
      const idLikeMatch = content.match(/^ID_LIKE=["']?(.+?)["']?\s*$/m)
      return {
        id: idMatch?.[1] ?? '',
        idLike: idLikeMatch?.[1]?.split(' ') ?? [],
      }
    } catch {
      // 非 systemd 系统、容器环境或旧版 Linux 中该文件可能不存在
      return null
    }
  },
)

/**
 * 判断给定的 OS 发行版信息是否属于指定的发行族（如 debian、arch）。
 *
 * 流程：
 *   先检查 id 是否直接匹配，再检查 idLike 中是否有匹配项
 *
 * @param osRelease - 从 /etc/os-release 解析出的发行版信息
 * @param families - 要匹配的发行族名称列表
 * @returns 属于指定族则返回 true
 */
function isDistroFamily(
  osRelease: { id: string; idLike: string[] },
  families: string[],
): boolean {
  return (
    // 直接匹配发行版 ID（如 arch）
    families.includes(osRelease.id) ||
    // 匹配父族（如 ubuntu 的父族 debian）
    osRelease.idLike.some(like => families.includes(like))
  )
}

/**
 * 检测 Claude Code 是否通过 mise（多语言工具版本管理器）安装（同步路径检查）。
 *
 * 判断依据：检查可执行文件路径是否包含 mise 的标准安装目录模式
 *   mise 安装路径格式：~/.local/share/mise/installs/<工具>/<版本>/
 *
 * @returns 若在 mise 安装目录中运行则返回 true
 */
export function detectMise(): boolean {
  // 获取当前进程的可执行文件路径
  const execPath = process.execPath || process.argv[0] || ''

  // 检查路径是否包含 mise/installs/ 目录结构（兼容 Unix 和 Windows 路径分隔符）
  if (/[/\\]mise[/\\]installs[/\\]/i.test(execPath)) {
    logForDebugging(`Detected mise installation: ${execPath}`)
    return true
  }

  return false
}

/**
 * 检测 Claude Code 是否通过 asdf（另一种多语言版本管理器）安装（同步路径检查）。
 *
 * 判断依据：检查可执行文件路径是否包含 asdf 的标准安装目录模式
 *   asdf 安装路径格式：~/.asdf/installs/<工具>/<版本>/
 *
 * @returns 若在 asdf 安装目录中运行则返回 true
 */
export function detectAsdf(): boolean {
  const execPath = process.execPath || process.argv[0] || ''

  // 匹配 .asdf 或 asdf 目录下的 installs 子目录（兼容新旧版本的路径约定）
  if (/[/\\]\.?asdf[/\\]installs[/\\]/i.test(execPath)) {
    logForDebugging(`Detected asdf installation: ${execPath}`)
    return true
  }

  return false
}

/**
 * 检测 Claude Code 是否通过 Homebrew Cask 安装（同步路径检查）。
 *
 * 注意事项（重要）：
 *   Homebrew 的 npm 全局包也安装在 Homebrew 前缀下（如 /opt/homebrew/lib/node_modules/）
 *   因此不能简单检查路径是否包含 /homebrew/，而必须精确匹配 /Caskroom/ 子目录，
 *   以区分「Homebrew Cask 安装的二进制包」与「通过 Homebrew 的 npm 安装的 npm 包」。
 *
 * 仅在 macOS、Linux 和 WSL 平台执行，Windows 上直接返回 false。
 *
 * @returns 若在 Homebrew Caskroom 安装目录中运行则返回 true
 */
export function detectHomebrew(): boolean {
  const platform = getPlatform()

  // Homebrew 仅支持 macOS、Linux 和 WSL
  if (platform !== 'macos' && platform !== 'linux' && platform !== 'wsl') {
    return false
  }

  const execPath = process.execPath || process.argv[0] || ''

  // 精确检查 Caskroom 子目录，避免误匹配 Homebrew 安装的 npm 包
  if (execPath.includes('/Caskroom/')) {
    logForDebugging(`Detected Homebrew cask installation: ${execPath}`)
    return true
  }

  return false
}

/**
 * 检测 Claude Code 是否通过 winget（Windows 包管理器）安装（同步路径检查）。
 *
 * winget 安装路径格式（两种）：
 *   - 用户级：%LOCALAPPDATA%\Microsoft\WinGet\Packages\
 *   - 系统级：C:\Program Files\WinGet\Packages\
 *   - 链接：%LOCALAPPDATA%\Microsoft\WinGet\Links\
 *
 * 仅在 Windows 平台执行，其他平台直接返回 false。
 *
 * @returns 若在 winget 安装目录中运行则返回 true
 */
export function detectWinget(): boolean {
  const platform = getPlatform()

  // winget 仅在 Windows 上存在
  if (platform !== 'windows') {
    return false
  }

  const execPath = process.execPath || process.argv[0] || ''

  // 覆盖两种 WinGet 路径模式（兼容正反斜杠）
  const wingetPatterns = [
    /Microsoft[/\\]WinGet[/\\]Packages/i,
    /Microsoft[/\\]WinGet[/\\]Links/i,
  ]

  for (const pattern of wingetPatterns) {
    if (pattern.test(execPath)) {
      logForDebugging(`Detected winget installation: ${execPath}`)
      return true
    }
  }

  return false
}

/**
 * 检测 Claude Code 是否通过 pacman（Arch Linux 包管理器）安装（异步 DB 查询，带缓存）。
 *
 * 流程：
 *   1. 非 Linux 平台直接返回 false
 *   2. 读取 /etc/os-release，若确定非 Arch 族发行版则跳过（防止命中 pacman 游戏）
 *   3. 执行 pacman -Qo <execPath> 查询文件所属包，5 秒超时
 *   4. 退出码为 0 且有输出则判定为 pacman 安装
 *
 * @returns 若为 pacman 安装返回 true，否则 false
 */
export const detectPacman = memoize(async (): Promise<boolean> => {
  const platform = getPlatform()

  // 非 Linux 无需检测
  if (platform !== 'linux') {
    return false
  }

  const osRelease = await getOsRelease()
  // 确认是 Arch 族才执行 pacman，避免在 Ubuntu 上命中 /usr/games/pacman
  if (osRelease && !isDistroFamily(osRelease, ['arch'])) {
    return false
  }

  const execPath = process.execPath || process.argv[0] || ''

  // 查询 pacman 数据库，判断该可执行文件是否由 pacman 管理
  const result = await execFileNoThrow('pacman', ['-Qo', execPath], {
    timeout: 5000,
    useCwd: false,
  })

  if (result.code === 0 && result.stdout) {
    logForDebugging(`Detected pacman installation: ${result.stdout.trim()}`)
    return true
  }

  return false
})

/**
 * 检测 Claude Code 是否通过 .deb 包（dpkg/apt）安装（异步 DB 查询，带缓存）。
 *
 * 流程：
 *   1. 非 Linux 平台直接返回 false
 *   2. 读取 /etc/os-release，若确定非 Debian 族则跳过
 *   3. 执行 dpkg -S <execPath> 查询文件归属包，5 秒超时
 *
 * @returns 若为 deb 包安装返回 true，否则 false
 */
export const detectDeb = memoize(async (): Promise<boolean> => {
  const platform = getPlatform()

  if (platform !== 'linux') {
    return false
  }

  const osRelease = await getOsRelease()
  // 确认是 Debian 族（包含 Ubuntu）才检测 dpkg
  if (osRelease && !isDistroFamily(osRelease, ['debian'])) {
    return false
  }

  const execPath = process.execPath || process.argv[0] || ''

  // 使用 dpkg -S 查询文件由哪个 .deb 包提供
  const result = await execFileNoThrow('dpkg', ['-S', execPath], {
    timeout: 5000,
    useCwd: false,
  })

  if (result.code === 0 && result.stdout) {
    logForDebugging(`Detected deb installation: ${result.stdout.trim()}`)
    return true
  }

  return false
})

/**
 * 检测 Claude Code 是否通过 RPM 包（dnf/yum）安装（异步 DB 查询，带缓存）。
 *
 * 流程：
 *   1. 非 Linux 平台直接返回 false
 *   2. 读取 /etc/os-release，若确定非 RPM 族（Fedora/RHEL/SUSE）则跳过
 *   3. 执行 rpm -qf <execPath> 查询文件归属 RPM 包，5 秒超时
 *
 * @returns 若为 RPM 包安装返回 true，否则 false
 */
export const detectRpm = memoize(async (): Promise<boolean> => {
  const platform = getPlatform()

  if (platform !== 'linux') {
    return false
  }

  const osRelease = await getOsRelease()
  // 确认是 RPM 族发行版（Fedora、RHEL、openSUSE 等）
  if (osRelease && !isDistroFamily(osRelease, ['fedora', 'rhel', 'suse'])) {
    return false
  }

  const execPath = process.execPath || process.argv[0] || ''

  // 使用 rpm -qf 查询文件由哪个 RPM 包提供
  const result = await execFileNoThrow('rpm', ['-qf', execPath], {
    timeout: 5000,
    useCwd: false,
  })

  if (result.code === 0 && result.stdout) {
    logForDebugging(`Detected rpm installation: ${result.stdout.trim()}`)
    return true
  }

  return false
})

/**
 * 检测 Claude Code 是否通过 Alpine APK 包管理器安装（异步 DB 查询，带缓存）。
 *
 * 流程：
 *   1. 非 Linux 平台直接返回 false
 *   2. 读取 /etc/os-release，若确定非 Alpine 族则跳过
 *   3. 执行 apk info --who-owns <execPath> 查询文件归属，5 秒超时
 *
 * @returns 若为 APK 包安装返回 true，否则 false
 */
export const detectApk = memoize(async (): Promise<boolean> => {
  const platform = getPlatform()

  if (platform !== 'linux') {
    return false
  }

  const osRelease = await getOsRelease()
  // 确认是 Alpine Linux 才检测 apk
  if (osRelease && !isDistroFamily(osRelease, ['alpine'])) {
    return false
  }

  const execPath = process.execPath || process.argv[0] || ''

  // 使用 apk info --who-owns 查询文件所属 Alpine 软件包
  const result = await execFileNoThrow(
    'apk',
    ['info', '--who-owns', execPath],
    {
      timeout: 5000,
      useCwd: false,
    },
  )

  if (result.code === 0 && result.stdout) {
    logForDebugging(`Detected apk installation: ${result.stdout.trim()}`)
    return true
  }

  return false
})

/**
 * 按优先级顺序检测 Claude Code 的安装包管理器（异步，带记忆化缓存）。
 *
 * 检测顺序（由快到慢）：
 *   1. Homebrew（同步路径检查）
 *   2. winget（同步路径检查）
 *   3. mise（同步路径检查）
 *   4. asdf（同步路径检查）
 *   5. pacman（异步 DB 查询）
 *   6. apk（异步 DB 查询）
 *   7. deb（异步 DB 查询）
 *   8. rpm（异步 DB 查询）
 *   → 都未命中时返回 'unknown'（如通过 npm install -g 安装）
 *
 * 使用 memoize 确保整个进程生命周期内只执行一次检测。
 *
 * @returns 检测到的包管理器名称，或 'unknown'
 */
export const getPackageManager = memoize(async (): Promise<PackageManager> => {
  // 同步检查（无子进程开销，速度最快）
  if (detectHomebrew()) {
    return 'homebrew'
  }

  if (detectWinget()) {
    return 'winget'
  }

  if (detectMise()) {
    return 'mise'
  }

  if (detectAsdf()) {
    return 'asdf'
  }

  // 异步检查（需要子进程查询包数据库，速度较慢）
  if (await detectPacman()) {
    return 'pacman'
  }

  if (await detectApk()) {
    return 'apk'
  }

  if (await detectDeb()) {
    return 'deb'
  }

  if (await detectRpm()) {
    return 'rpm'
  }

  // 所有检测均未命中，归类为未知安装方式（如 npm install -g）
  return 'unknown'
})
