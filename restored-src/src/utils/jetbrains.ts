/**
 * JetBrains IDE 插件检测模块
 *
 * 【在 Claude Code 系统流程中的位置】
 * 本模块位于 IDE 集成层，负责检测用户系统中是否安装了 Claude Code 的
 * JetBrains 插件。当 Claude Code 需要与 JetBrains 系列 IDE（IntelliJ、
 * PyCharm、WebStorm 等）进行集成时，通过本模块确认插件存在性，从而决定
 * 是否启用 IDE 特定功能（如文件同步、代码导航、状态栏信息等）。
 *
 * 【主要功能】
 * 1. buildCommonPluginDirectoryPaths：构造各平台下 JetBrains 配置目录路径列表；
 * 2. detectPluginDirectories：实际扫描文件系统，找出存在的插件安装目录；
 * 3. isJetBrainsPluginInstalled：检查特定 IDE 的插件是否已安装；
 * 4. isJetBrainsPluginInstalledCached / isJetBrainsPluginInstalledCachedSync：
 *    带缓存版本的插件检测，避免重复文件系统扫描。
 */

import { homedir, platform } from 'os'
import { join } from 'path'
import { getFsImplementation } from '../utils/fsOperations.js'
import type { IdeType } from './ide.js'

// Claude Code JetBrains 插件的目录名前缀
const PLUGIN_PREFIX = 'claude-code-jetbrains-plugin'

// IDE 名称到文件系统目录名模式的映射表
// 每个 IDE 可能有多种目录名变体（如 IntelliJ 有 IntelliJIdea 和 IdeaIC 两种）
const ideNameToDirMap: { [key: string]: string[] } = {
  pycharm: ['PyCharm'],
  intellij: ['IntelliJIdea', 'IdeaIC'],
  webstorm: ['WebStorm'],
  phpstorm: ['PhpStorm'],
  rubymine: ['RubyMine'],
  clion: ['CLion'],
  goland: ['GoLand'],
  rider: ['Rider'],
  datagrip: ['DataGrip'],
  appcode: ['AppCode'],
  dataspell: ['DataSpell'],
  aqua: ['Aqua'],
  gateway: ['Gateway'],
  fleet: ['Fleet'],
  androidstudio: ['AndroidStudio'],
}

/**
 * 构造指定 IDE 的 JetBrains 插件配置目录候选路径列表。
 * 路径随操作系统不同而不同，参考官方文档：
 * https://www.jetbrains.com/help/pycharm/directories-used-by-the-ide-to-store-settings-caches-plugins-and-logs.html#plugins-directory
 *
 * 【各平台路径规则】
 * - macOS：~/Library/Application Support/JetBrains（及 Google/ for AndroidStudio）
 * - Windows：%APPDATA%/JetBrains 和 %LOCALAPPDATA%/JetBrains
 * - Linux：~/.config/JetBrains 和 ~/.local/share/JetBrains（及 ~/.{IdeName} 旧格式）
 */
function buildCommonPluginDirectoryPaths(ideName: string): string[] {
  const homeDir = homedir()
  const directories: string[] = []
  // 查找 IDE 对应的目录名模式，若不支持则返回空数组
  const idePatterns = ideNameToDirMap[ideName.toLowerCase()]
  if (!idePatterns) {
    return directories
  }

  // Windows 环境变量回退（若未设置则使用默认路径）
  const appData = process.env.APPDATA || join(homeDir, 'AppData', 'Roaming')
  const localAppData =
    process.env.LOCALAPPDATA || join(homeDir, 'AppData', 'Local')

  switch (platform()) {
    case 'darwin':
      // macOS 主要配置目录
      directories.push(
        join(homeDir, 'Library', 'Application Support', 'JetBrains'),
        join(homeDir, 'Library', 'Application Support'),
      )
      // Android Studio 在 macOS 上使用 Google 子目录
      if (ideName.toLowerCase() === 'androidstudio') {
        directories.push(
          join(homeDir, 'Library', 'Application Support', 'Google'),
        )
      }
      break

    case 'win32':
      // Windows 同时检查漫游配置和本地配置目录
      directories.push(
        join(appData, 'JetBrains'),
        join(localAppData, 'JetBrains'),
        join(appData),
      )
      // Android Studio 在 Windows 上使用 Google 子目录（本地）
      if (ideName.toLowerCase() === 'androidstudio') {
        directories.push(join(localAppData, 'Google'))
      }
      break

    case 'linux':
      // Linux 标准 XDG 目录
      directories.push(
        join(homeDir, '.config', 'JetBrains'),
        join(homeDir, '.local', 'share', 'JetBrains'),
      )
      // Linux 旧版 JetBrains 使用隐藏目录（如 ~/.WebStorm2023.3）
      for (const pattern of idePatterns) {
        directories.push(join(homeDir, '.' + pattern))
      }
      // Android Studio 在 Linux 上使用 Google 子目录（XDG config）
      if (ideName.toLowerCase() === 'androidstudio') {
        directories.push(join(homeDir, '.config', 'Google'))
      }
      break
    default:
      break
  }

  return directories
}

/**
 * 实际扫描文件系统，找出所有存在的 JetBrains 插件安装目录。
 *
 * 【扫描逻辑】
 * 1. 获取候选父目录列表；
 * 2. 对每个父目录执行 readdir，匹配 IDE 目录名模式；
 * 3. 接受目录和符号链接（GNU stow 用户可能通过符号链接管理 JetBrains 配置）；
 * 4. 除 Linux 外，在匹配目录下进一步查找 plugins/ 子目录；
 * 5. 对结果进行去重，防止同一路径被多次计算。
 *
 * 正则表达式在循环外预编译（每个模式只编译一次），提高性能。
 */
async function detectPluginDirectories(ideName: string): Promise<string[]> {
  const foundDirectories: string[] = []
  const fs = getFsImplementation()

  const pluginDirPaths = buildCommonPluginDirectoryPaths(ideName)
  const idePatterns = ideNameToDirMap[ideName.toLowerCase()]
  if (!idePatterns) {
    return foundDirectories
  }

  // 在循环外预编译正则表达式（idePatterns 在遍历 baseDirs 过程中不变）
  const regexes = idePatterns.map(p => new RegExp('^' + p))

  for (const baseDir of pluginDirPaths) {
    try {
      const entries = await fs.readdir(baseDir)
      for (const regex of regexes) {
        for (const entry of entries) {
          // 检查目录名是否匹配 IDE 模式
          if (!regex.test(entry.name)) continue
          // 接受目录和符号链接；dirent.isDirectory() 对符号链接返回 false，
          // 但 GNU stow 用户会符号链接其 JetBrains 配置目录。
          // 下游的 fs.stat() 调用会过滤掉指向非目录的符号链接。
          if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
          const dir = join(baseDir, entry.name)
          // Linux 是唯一一个没有独立 plugins 子目录的平台
          if (platform() === 'linux') {
            foundDirectories.push(dir)
            continue
          }
          // 非 Linux 平台：在 IDE 目录下寻找 plugins/ 子目录
          const pluginDir = join(dir, 'plugins')
          try {
            await fs.stat(pluginDir)
            foundDirectories.push(pluginDir)
          } catch {
            // plugins 目录不存在，跳过（可能是旧版 IDE 或损坏的安装）
          }
        }
      }
    } catch {
      // 忽略过时 IDE 目录产生的错误（ENOENT、EACCES 等）
      continue
    }
  }

  // 去重（同一路径可能在多个基础目录下被匹配到）
  return foundDirectories.filter(
    (dir, index) => foundDirectories.indexOf(dir) === index,
  )
}

/**
 * 检查指定 IDE 类型的 JetBrains 插件是否已安装。
 * 在所有检测到的插件目录中查找 claude-code-jetbrains-plugin 文件夹/文件。
 * 找到即返回 true，全部未找到则返回 false。
 */
export async function isJetBrainsPluginInstalled(
  ideType: IdeType,
): Promise<boolean> {
  const pluginDirs = await detectPluginDirectories(ideType)
  for (const dir of pluginDirs) {
    // 构造插件的完整路径并检查是否存在
    const pluginPath = join(dir, PLUGIN_PREFIX)
    try {
      await getFsImplementation().stat(pluginPath)
      return true // 找到插件，立即返回
    } catch {
      // 此目录下未找到插件，继续检查下一个目录
    }
  }
  return false
}

// ── 缓存机制 ──────────────────────────────────────────────────────────────────
// 两级缓存：resolved 结果缓存（布尔值）+ Promise 缓存（防止并发重复请求）

// 已解析的布尔结果缓存（用于同步访问）
const pluginInstalledCache = new Map<IdeType, boolean>()
// 进行中的 Promise 缓存（防止同一 IDE 类型的并发重复检测）
const pluginInstalledPromiseCache = new Map<IdeType, Promise<boolean>>()

/**
 * 带缓存的插件检测（内部实现，支持强制刷新）。
 * 若缓存中已有对应 IDE 的 Promise（且非强制刷新），直接返回缓存 Promise；
 * 否则启动新的检测流程，将 Promise 存入缓存，并在 resolve 后更新布尔缓存。
 */
async function isJetBrainsPluginInstalledMemoized(
  ideType: IdeType,
  forceRefresh = false,
): Promise<boolean> {
  if (!forceRefresh) {
    // 有缓存 Promise 时直接复用（并发请求会共享同一个 Promise）
    const existing = pluginInstalledPromiseCache.get(ideType)
    if (existing) {
      return existing
    }
  }
  // 启动新的检测，同时更新布尔缓存供同步访问
  const promise = isJetBrainsPluginInstalled(ideType).then(result => {
    pluginInstalledCache.set(ideType, result)
    return result
  })
  pluginInstalledPromiseCache.set(ideType, promise)
  return promise
}

/**
 * 公开的带缓存插件检测接口，支持强制刷新缓存。
 * 强制刷新时会清除两级缓存，确保触发新的文件系统扫描。
 * 适用于用户安装/卸载插件后需要立即感知变化的场景。
 */
export async function isJetBrainsPluginInstalledCached(
  ideType: IdeType,
  forceRefresh = false,
): Promise<boolean> {
  if (forceRefresh) {
    // 清除两级缓存，强制重新检测
    pluginInstalledCache.delete(ideType)
    pluginInstalledPromiseCache.delete(ideType)
  }
  return isJetBrainsPluginInstalledMemoized(ideType, forceRefresh)
}

/**
 * 同步版本的缓存插件检测（仅读取已解析的布尔结果缓存）。
 * 若异步检测尚未完成，返回 false（保守值）。
 * 适用于同步上下文（如 Ink 组件的 isActive 检查），这些场景不能使用 async/await。
 */
export function isJetBrainsPluginInstalledCachedSync(
  ideType: IdeType,
): boolean {
  // 若尚无缓存结果（Promise 未 resolve），返回 false 作为保守默认值
  return pluginInstalledCache.get(ideType) ?? false
}
