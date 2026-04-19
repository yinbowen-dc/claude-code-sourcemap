/**
 * Claude in Chrome 浏览器集成公共模块。
 *
 * 在 Claude Code 系统中，该模块提供各 Chrome 系浏览器的配置清单和安装状态检测工具，
 * 供 setup.ts / setupPortable.ts 使用：
 * - CLAUDE_IN_CHROME_MCP_SERVER_NAME：MCP 服务端名称常量
 * - BrowserConfig 类型：描述各平台（macOS/Linux/Windows）的浏览器路径配置
 * - ChromiumBrowser 类型（从 setupPortable.ts 重新导出）
 * - 各浏览器（Chrome/Chromium/Edge/Brave/Arc/Opera 等）配置清单
 * - 浏览器安装检测、native messaging host 路径计算等工具函数
 */
import { readdirSync } from 'fs'
import { stat } from 'fs/promises'
import { homedir, platform, tmpdir, userInfo } from 'os'
import { join } from 'path'
import { normalizeNameForMCP } from '../../services/mcp/normalization.js'
import { logForDebugging } from '../debug.js'
import { isFsInaccessible } from '../errors.js'
import { execFileNoThrow } from '../execFileNoThrow.js'
import { getPlatform } from '../platform.js'
import { which } from '../which.js'

export const CLAUDE_IN_CHROME_MCP_SERVER_NAME = 'claude-in-chrome'

// Re-export ChromiumBrowser type for setup.ts
export type { ChromiumBrowser } from './setupPortable.js'

// Import for local use
import type { ChromiumBrowser } from './setupPortable.js'

type BrowserConfig = {
  name: string
  macos: {
    appName: string
    dataPath: string[]
    nativeMessagingPath: string[]
  }
  linux: {
    binaries: string[]
    dataPath: string[]
    nativeMessagingPath: string[]
  }
  windows: {
    dataPath: string[]
    registryKey: string
    useRoaming?: boolean // Opera uses Roaming instead of Local
  }
}

export const CHROMIUM_BROWSERS: Record<ChromiumBrowser, BrowserConfig> = {
  chrome: {
    name: 'Google Chrome',
    macos: {
      appName: 'Google Chrome',
      dataPath: ['Library', 'Application Support', 'Google', 'Chrome'],
      nativeMessagingPath: [
        'Library',
        'Application Support',
        'Google',
        'Chrome',
        'NativeMessagingHosts',
      ],
    },
    linux: {
      binaries: ['google-chrome', 'google-chrome-stable'],
      dataPath: ['.config', 'google-chrome'],
      nativeMessagingPath: ['.config', 'google-chrome', 'NativeMessagingHosts'],
    },
    windows: {
      dataPath: ['Google', 'Chrome', 'User Data'],
      registryKey: 'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts',
    },
  },
  brave: {
    name: 'Brave',
    macos: {
      appName: 'Brave Browser',
      dataPath: [
        'Library',
        'Application Support',
        'BraveSoftware',
        'Brave-Browser',
      ],
      nativeMessagingPath: [
        'Library',
        'Application Support',
        'BraveSoftware',
        'Brave-Browser',
        'NativeMessagingHosts',
      ],
    },
    linux: {
      binaries: ['brave-browser', 'brave'],
      dataPath: ['.config', 'BraveSoftware', 'Brave-Browser'],
      nativeMessagingPath: [
        '.config',
        'BraveSoftware',
        'Brave-Browser',
        'NativeMessagingHosts',
      ],
    },
    windows: {
      dataPath: ['BraveSoftware', 'Brave-Browser', 'User Data'],
      registryKey:
        'HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts',
    },
  },
  arc: {
    name: 'Arc',
    macos: {
      appName: 'Arc',
      dataPath: ['Library', 'Application Support', 'Arc', 'User Data'],
      nativeMessagingPath: [
        'Library',
        'Application Support',
        'Arc',
        'User Data',
        'NativeMessagingHosts',
      ],
    },
    linux: {
      // Arc is not available on Linux
      binaries: [],
      dataPath: [],
      nativeMessagingPath: [],
    },
    windows: {
      // Arc Windows is Chromium-based
      dataPath: ['Arc', 'User Data'],
      registryKey: 'HKCU\\Software\\ArcBrowser\\Arc\\NativeMessagingHosts',
    },
  },
  chromium: {
    name: 'Chromium',
    macos: {
      appName: 'Chromium',
      dataPath: ['Library', 'Application Support', 'Chromium'],
      nativeMessagingPath: [
        'Library',
        'Application Support',
        'Chromium',
        'NativeMessagingHosts',
      ],
    },
    linux: {
      binaries: ['chromium', 'chromium-browser'],
      dataPath: ['.config', 'chromium'],
      nativeMessagingPath: ['.config', 'chromium', 'NativeMessagingHosts'],
    },
    windows: {
      dataPath: ['Chromium', 'User Data'],
      registryKey: 'HKCU\\Software\\Chromium\\NativeMessagingHosts',
    },
  },
  edge: {
    name: 'Microsoft Edge',
    macos: {
      appName: 'Microsoft Edge',
      dataPath: ['Library', 'Application Support', 'Microsoft Edge'],
      nativeMessagingPath: [
        'Library',
        'Application Support',
        'Microsoft Edge',
        'NativeMessagingHosts',
      ],
    },
    linux: {
      binaries: ['microsoft-edge', 'microsoft-edge-stable'],
      dataPath: ['.config', 'microsoft-edge'],
      nativeMessagingPath: [
        '.config',
        'microsoft-edge',
        'NativeMessagingHosts',
      ],
    },
    windows: {
      dataPath: ['Microsoft', 'Edge', 'User Data'],
      registryKey: 'HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts',
    },
  },
  vivaldi: {
    name: 'Vivaldi',
    macos: {
      appName: 'Vivaldi',
      dataPath: ['Library', 'Application Support', 'Vivaldi'],
      nativeMessagingPath: [
        'Library',
        'Application Support',
        'Vivaldi',
        'NativeMessagingHosts',
      ],
    },
    linux: {
      binaries: ['vivaldi', 'vivaldi-stable'],
      dataPath: ['.config', 'vivaldi'],
      nativeMessagingPath: ['.config', 'vivaldi', 'NativeMessagingHosts'],
    },
    windows: {
      dataPath: ['Vivaldi', 'User Data'],
      registryKey: 'HKCU\\Software\\Vivaldi\\NativeMessagingHosts',
    },
  },
  opera: {
    name: 'Opera',
    macos: {
      appName: 'Opera',
      dataPath: ['Library', 'Application Support', 'com.operasoftware.Opera'],
      nativeMessagingPath: [
        'Library',
        'Application Support',
        'com.operasoftware.Opera',
        'NativeMessagingHosts',
      ],
    },
    linux: {
      binaries: ['opera'],
      dataPath: ['.config', 'opera'],
      nativeMessagingPath: ['.config', 'opera', 'NativeMessagingHosts'],
    },
    windows: {
      dataPath: ['Opera Software', 'Opera Stable'],
      registryKey:
        'HKCU\\Software\\Opera Software\\Opera Stable\\NativeMessagingHosts',
      useRoaming: true, // Opera uses Roaming AppData, not Local
    },
  },
}

// Priority order for browser detection (most common first)
export const BROWSER_DETECTION_ORDER: ChromiumBrowser[] = [
  'chrome',
  'brave',
  'arc',
  'edge',
  'chromium',
  'vivaldi',
  'opera',
]

/**
 * 获取所有支持浏览器的用户数据目录路径列表，用于检测扩展是否已安装。
 *
 * 按 BROWSER_DETECTION_ORDER 顺序遍历所有已知 Chromium 系浏览器，
 * 根据当前平台（macOS/Linux/WSL/Windows）拼接各浏览器的 dataPath，
 * Windows 还需区分 Roaming / Local AppData（Opera 使用 Roaming）。
 *
 * @returns 浏览器 ID 与对应数据目录绝对路径的数组
 */
export function getAllBrowserDataPaths(): {
  browser: ChromiumBrowser
  path: string
}[] {
  const platform = getPlatform()
  const home = homedir()
  const paths: { browser: ChromiumBrowser; path: string }[] = []

  for (const browserId of BROWSER_DETECTION_ORDER) {
    const config = CHROMIUM_BROWSERS[browserId]
    let dataPath: string[] | undefined

    switch (platform) {
      case 'macos':
        // macOS：从 home 目录拼接 Library/Application Support/... 路径
        dataPath = config.macos.dataPath
        break
      case 'linux':
      case 'wsl':
        // Linux/WSL：从 home 目录拼接 .config/... 路径
        dataPath = config.linux.dataPath
        break
      case 'windows': {
        // Windows：Opera 使用 Roaming，其他浏览器使用 Local AppData
        if (config.windows.dataPath.length > 0) {
          const appDataBase = config.windows.useRoaming
            ? join(home, 'AppData', 'Roaming')
            : join(home, 'AppData', 'Local')
          paths.push({
            browser: browserId,
            path: join(appDataBase, ...config.windows.dataPath),
          })
        }
        // Windows 已在 if 块内 push，使用 continue 跳过后续通用 push 逻辑
        continue
      }
    }

    if (dataPath && dataPath.length > 0) {
      paths.push({
        browser: browserId,
        path: join(home, ...dataPath),
      })
    }
  }

  return paths
}

/**
 * 获取所有支持浏览器的 native messaging host 清单目录路径列表。
 *
 * macOS/Linux：返回各浏览器配置目录下的 NativeMessagingHosts 子目录绝对路径。
 * Windows：native messaging 通过注册表注册，不使用文件目录，此平台下返回空。
 *
 * @returns 浏览器 ID 与对应 NativeMessagingHosts 目录绝对路径的数组
 */
export function getAllNativeMessagingHostsDirs(): {
  browser: ChromiumBrowser
  path: string
}[] {
  const platform = getPlatform()
  const home = homedir()
  const paths: { browser: ChromiumBrowser; path: string }[] = []

  for (const browserId of BROWSER_DETECTION_ORDER) {
    const config = CHROMIUM_BROWSERS[browserId]

    switch (platform) {
      case 'macos':
        // macOS：拼接 ~/Library/Application Support/.../NativeMessagingHosts
        if (config.macos.nativeMessagingPath.length > 0) {
          paths.push({
            browser: browserId,
            path: join(home, ...config.macos.nativeMessagingPath),
          })
        }
        break
      case 'linux':
      case 'wsl':
        // Linux/WSL：拼接 ~/.config/.../NativeMessagingHosts
        if (config.linux.nativeMessagingPath.length > 0) {
          paths.push({
            browser: browserId,
            path: join(home, ...config.linux.nativeMessagingPath),
          })
        }
        break
      case 'windows':
        // Windows uses registry, not file paths for native messaging
        // Windows 通过注册表管理 native messaging host，无需文件路径
        break
    }
  }

  return paths
}

/**
 * 获取所有支持浏览器在 Windows 注册表中的 native messaging host 注册路径。
 *
 * 仅返回有 registryKey 配置的浏览器（所有已知 Chromium 系浏览器均有）。
 * 用于 setup.ts 在 Windows 平台批量写入注册表项。
 *
 * @returns 浏览器 ID 与对应注册表键路径的数组
 */
export function getAllWindowsRegistryKeys(): {
  browser: ChromiumBrowser
  key: string
}[] {
  const keys: { browser: ChromiumBrowser; key: string }[] = []

  for (const browserId of BROWSER_DETECTION_ORDER) {
    const config = CHROMIUM_BROWSERS[browserId]
    // 筛选有 Windows 注册表键配置的浏览器
    if (config.windows.registryKey) {
      keys.push({
        browser: browserId,
        key: config.windows.registryKey,
      })
    }
  }

  return keys
}

/**
 * 按优先级顺序检测当前系统中已安装的第一个 Chromium 系浏览器。
 *
 * 检测策略：
 * - macOS：检查 /Applications/{AppName}.app 目录是否存在
 * - Linux/WSL：依次 which 各候选二进制名，找到任意一个则返回
 * - Windows：检查对应 AppData 数据目录是否存在
 *
 * @returns 找到的浏览器 ID，或 null（未安装任何支持的浏览器）
 */
export async function detectAvailableBrowser(): Promise<ChromiumBrowser | null> {
  const platform = getPlatform()

  for (const browserId of BROWSER_DETECTION_ORDER) {
    const config = CHROMIUM_BROWSERS[browserId]

    switch (platform) {
      case 'macos': {
        // Check if the .app bundle (a directory) exists
        // macOS：.app 包是一个目录，通过 isDirectory() 验证是否已安装
        const appPath = `/Applications/${config.macos.appName}.app`
        try {
          const stats = await stat(appPath)
          if (stats.isDirectory()) {
            logForDebugging(
              `[Claude in Chrome] Detected browser: ${config.name}`,
            )
            return browserId
          }
        } catch (e) {
          if (!isFsInaccessible(e)) throw e
          // App not found, continue checking
          // 应用不存在属正常情况，继续检查下一个浏览器
        }
        break
      }
      case 'wsl':
      case 'linux': {
        // Check if any binary exists
        // Linux/WSL：遍历候选二进制名，any which 成功即视为已安装
        for (const binary of config.linux.binaries) {
          if (await which(binary).catch(() => null)) {
            logForDebugging(
              `[Claude in Chrome] Detected browser: ${config.name}`,
            )
            return browserId
          }
        }
        break
      }
      case 'windows': {
        // Check if data path exists (indicates browser is installed)
        // Windows：通过检查 AppData 数据目录是否存在来判断浏览器是否已安装
        const home = homedir()
        if (config.windows.dataPath.length > 0) {
          // Opera 使用 Roaming，其他使用 Local AppData
          const appDataBase = config.windows.useRoaming
            ? join(home, 'AppData', 'Roaming')
            : join(home, 'AppData', 'Local')
          const dataPath = join(appDataBase, ...config.windows.dataPath)
          try {
            const stats = await stat(dataPath)
            if (stats.isDirectory()) {
              logForDebugging(
                `[Claude in Chrome] Detected browser: ${config.name}`,
              )
              return browserId
            }
          } catch (e) {
            if (!isFsInaccessible(e)) throw e
            // Browser not found, continue checking
            // 数据目录不存在，继续检查下一个浏览器
          }
        }
        break
      }
    }
  }

  // 所有浏览器均未检测到
  return null
}

/**
 * 判断给定 MCP 服务端名称是否对应 Claude in Chrome MCP 服务。
 * 通过规范化名称（normalizeNameForMCP）比较，忽略大小写和特殊字符差异。
 *
 * @param name MCP 服务端配置中的名称字段
 * @returns 是否为 claude-in-chrome MCP 服务
 */
export function isClaudeInChromeMCPServer(name: string): boolean {
  return normalizeNameForMCP(name) === CLAUDE_IN_CHROME_MCP_SERVER_NAME
}

// 最多追踪的标签页 ID 数量，防止无限增长（内存保护上限）
const MAX_TRACKED_TABS = 200
// 当前已追踪的 Claude in Chrome 标签页 ID 集合
const trackedTabIds = new Set<number>()

/**
 * 将 Claude in Chrome 标签页 ID 记录到追踪集合。
 *
 * 若集合已达上限且该 ID 不在其中，则清空集合再添加（滚动窗口策略）。
 *
 * @param tabId 要追踪的浏览器标签页 ID
 */
export function trackClaudeInChromeTabId(tabId: number): void {
  // 达到上限且不是已有 ID 时，清空集合，避免内存持续增长
  if (trackedTabIds.size >= MAX_TRACKED_TABS && !trackedTabIds.has(tabId)) {
    trackedTabIds.clear()
  }
  trackedTabIds.add(tabId)
}

/**
 * 查询指定标签页 ID 是否已被追踪（即是否来自 Claude in Chrome 会话）。
 *
 * @param tabId 要查询的浏览器标签页 ID
 * @returns 该 ID 是否在追踪集合中
 */
export function isTrackedClaudeInChromeTabId(tabId: number): boolean {
  return trackedTabIds.has(tabId)
}

/**
 * 使用当前系统中检测到的第一个可用 Chromium 系浏览器打开指定 URL。
 *
 * 平台策略：
 * - macOS：调用 `open -a {AppName} {url}`
 * - Windows：调用 `rundll32 url,OpenURL {url}`（避免 cmd.exe 元字符问题）
 * - Linux/WSL：依次尝试各候选二进制名，直到成功
 *
 * @param url 要在浏览器中打开的 URL
 * @returns 是否成功打开（进程退出码为 0）
 */
export async function openInChrome(url: string): Promise<boolean> {
  const currentPlatform = getPlatform()

  // Detect the best available browser
  // 检测当前系统中可用的浏览器（按优先级）
  const browser = await detectAvailableBrowser()

  if (!browser) {
    logForDebugging('[Claude in Chrome] No compatible browser found')
    return false
  }

  const config = CHROMIUM_BROWSERS[browser]

  switch (currentPlatform) {
    case 'macos': {
      // macOS 使用 open -a 命令打开指定应用并传入 URL
      const { code } = await execFileNoThrow('open', [
        '-a',
        config.macos.appName,
        url,
      ])
      return code === 0
    }
    case 'windows': {
      // Use rundll32 to avoid cmd.exe metacharacter issues with URLs containing & | > <
      // Windows 使用 rundll32 调用系统 URL 处理器，规避 cmd.exe 特殊字符问题
      const { code } = await execFileNoThrow('rundll32', ['url,OpenURL', url])
      return code === 0
    }
    case 'wsl':
    case 'linux': {
      // Linux/WSL 依次尝试各候选浏览器二进制，第一个成功则返回
      for (const binary of config.linux.binaries) {
        const { code } = await execFileNoThrow(binary, [url])
        if (code === 0) {
          return true
        }
      }
      return false
    }
    default:
      return false
  }
}

/**
 * 获取 Unix 平台下 MCP-Chrome bridge socket 文件存放目录路径。
 *
 * 路径格式：/tmp/claude-mcp-browser-bridge-{username}
 * 目录名包含用户名，避免多用户系统下的命名冲突。
 *
 * @returns socket 目录的绝对路径
 */
export function getSocketDir(): string {
  return `/tmp/claude-mcp-browser-bridge-${getUsername()}`
}

/**
 * 获取当前进程专属的安全 socket 路径（Unix）或 named pipe 名称（Windows）。
 *
 * - Unix：路径格式为 {socketDir}/{pid}.sock，含 PID 确保每个进程独占
 * - Windows：格式为 \\.\pipe\claude-mcp-browser-bridge-{username}
 *
 * @returns socket 文件绝对路径或 Windows named pipe 名称
 */
export function getSecureSocketPath(): string {
  if (platform() === 'win32') {
    // Windows named pipe 格式，与 Claude in Chrome MCP 侧保持一致
    return `\\\\.\\pipe\\${getSocketName()}`
  }
  // Unix：按 PID 命名，保证进程间不冲突
  return join(getSocketDir(), `${process.pid}.sock`)
}

/**
 * 获取 socket 目录中所有现存的 socket 文件路径列表（含旧版兼容路径）。
 *
 * 该函数使用同步 readdir（readdirSync），因为外部调用方（claude-for-chrome-mcp）
 * 的接口签名要求同步回调，无法使用异步版本。
 *
 * 返回值包含：
 * 1. 目录中所有 *.sock 文件的绝对路径（当前版本格式）
 * 2. 旧版遗留路径（tmpdir/legacy 和 /tmp/legacy）用于向后兼容
 *
 * @returns 所有可能的 socket 路径（字符串数组）
 */
export function getAllSocketPaths(): string[] {
  // Windows uses named pipes, not Unix sockets
  // Windows 使用 named pipe，直接返回 pipe 名称列表
  if (platform() === 'win32') {
    return [`\\\\.\\pipe\\${getSocketName()}`]
  }

  const paths: string[] = []
  const socketDir = getSocketDir()

  // Scan for *.sock files in the socket directory
  // 扫描 socket 目录，收集所有 *.sock 文件路径
  try {
    // eslint-disable-next-line custom-rules/no-sync-fs -- ClaudeForChromeContext.getSocketPaths (external @ant/claude-for-chrome-mcp) requires a sync () => string[] callback
    // 注意：此处必须使用同步 API，外部调用方的接口不支持异步
    const files = readdirSync(socketDir)
    for (const file of files) {
      if (file.endsWith('.sock')) {
        paths.push(join(socketDir, file))
      }
    }
  } catch {
    // Directory may not exist yet
    // 目录尚未创建属正常情况（host 未启动），忽略错误
  }

  // Legacy fallback paths
  // 追加旧版遗留路径，确保与旧版 Chrome 扩展的向后兼容
  const legacyName = `claude-mcp-browser-bridge-${getUsername()}`
  const legacyTmpdir = join(tmpdir(), legacyName)
  const legacyTmp = `/tmp/${legacyName}`

  // 避免重复添加（当 tmpdir() 就是 /tmp 时两个路径相同）
  if (!paths.includes(legacyTmpdir)) {
    paths.push(legacyTmpdir)
  }
  if (legacyTmpdir !== legacyTmp && !paths.includes(legacyTmp)) {
    paths.push(legacyTmp)
  }

  return paths
}

/**
 * 获取 MCP-Chrome bridge 的 socket / pipe 名称。
 * 命名规则与 Claude in Chrome MCP 侧保持严格一致，两侧必须相同才能连接。
 *
 * @returns socket 或 pipe 名称字符串
 */
function getSocketName(): string {
  // NOTE: This must match the one used in the Claude in Chrome MCP
  // 注意：此名称必须与 Claude in Chrome MCP 侧使用的名称完全一致
  return `claude-mcp-browser-bridge-${getUsername()}`
}

/**
 * 获取当前登录用户名，用于构造进程级别唯一的 socket 路径。
 *
 * 优先使用 os.userInfo()，失败时回退到环境变量 USER/USERNAME，
 * 最终回退到 'default' 以避免路径为空。
 *
 * @returns 当前用户名字符串
 */
function getUsername(): string {
  try {
    // userInfo() 获取系统级用户信息，比环境变量更可靠
    return userInfo().username || 'default'
  } catch {
    // 容器环境或 /etc/passwd 不可读时回退到环境变量
    return process.env.USER || process.env.USERNAME || 'default'
  }
}
