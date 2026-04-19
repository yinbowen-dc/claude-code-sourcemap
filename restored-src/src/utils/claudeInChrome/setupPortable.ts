/**
 * Claude in Chrome 安装检测模块（轻量/可移植版）。
 *
 * 在 Claude Code 系统中，该模块提供不依赖 @ant/claude-for-chrome-mcp 的轻量安装检测能力：
 * - CHROME_EXTENSION_URL：Chrome 扩展安装链接
 * - ChromiumBrowser 类型：浏览器标识符枚举
 * - getExtensionIds()：根据用户类型返回允许的扩展 ID 列表
 * - getInstalledChromiumBrowsers()：检测系统中已安装的 Chromium 系浏览器
 * - isClaudeInChromeExtensionInstalled()：检测 Claude 扩展是否已安装在指定浏览器
 */
import { readdir } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import { isFsInaccessible } from '../errors.js'

export const CHROME_EXTENSION_URL = 'https://claude.ai/chrome'

// Production extension ID
const PROD_EXTENSION_ID = 'fcoeoabgfenejglbffodgkkbkcdhcgfn'
// Dev extension IDs (for internal use)
const DEV_EXTENSION_ID = 'dihbgbndebgnbjfmelmegjepbnkhlgni'
const ANT_EXTENSION_ID = 'dngcpimnedloihjnnfngkgjoidhnaolf'

/**
 * 根据用户类型返回允许匹配的 Chrome 扩展 ID 列表。
 *
 * - 外部用户（非 ant）：仅包含生产版扩展 ID（PROD_EXTENSION_ID）
 * - ant 内部用户（USER_TYPE=ant）：同时包含生产版、开发版和 ant 内部版三个 ID，
 *   以支持在各种内部构建的扩展上进行安装检测
 *
 * @returns 当前用户类型下需要检测的扩展 ID 字符串数组
 */
function getExtensionIds(): string[] {
  // ant 内部用户同时匹配三种构建的扩展，外部用户仅匹配生产版
  return process.env.USER_TYPE === 'ant'
    ? [PROD_EXTENSION_ID, DEV_EXTENSION_ID, ANT_EXTENSION_ID]
    : [PROD_EXTENSION_ID]
}

// Must match ChromiumBrowser from common.ts
export type ChromiumBrowser =
  | 'chrome'
  | 'brave'
  | 'arc'
  | 'chromium'
  | 'edge'
  | 'vivaldi'
  | 'opera'

export type BrowserPath = {
  browser: ChromiumBrowser
  path: string
}

type Logger = (message: string) => void

// Browser detection order - must match BROWSER_DETECTION_ORDER from common.ts
const BROWSER_DETECTION_ORDER: ChromiumBrowser[] = [
  'chrome',
  'brave',
  'arc',
  'edge',
  'chromium',
  'vivaldi',
  'opera',
]

type BrowserDataConfig = {
  macos: string[]
  linux: string[]
  windows: { path: string[]; useRoaming?: boolean }
}

// Must match CHROMIUM_BROWSERS dataPath from common.ts
const CHROMIUM_BROWSERS: Record<ChromiumBrowser, BrowserDataConfig> = {
  chrome: {
    macos: ['Library', 'Application Support', 'Google', 'Chrome'],
    linux: ['.config', 'google-chrome'],
    windows: { path: ['Google', 'Chrome', 'User Data'] },
  },
  brave: {
    macos: ['Library', 'Application Support', 'BraveSoftware', 'Brave-Browser'],
    linux: ['.config', 'BraveSoftware', 'Brave-Browser'],
    windows: { path: ['BraveSoftware', 'Brave-Browser', 'User Data'] },
  },
  arc: {
    macos: ['Library', 'Application Support', 'Arc', 'User Data'],
    linux: [],
    windows: { path: ['Arc', 'User Data'] },
  },
  chromium: {
    macos: ['Library', 'Application Support', 'Chromium'],
    linux: ['.config', 'chromium'],
    windows: { path: ['Chromium', 'User Data'] },
  },
  edge: {
    macos: ['Library', 'Application Support', 'Microsoft Edge'],
    linux: ['.config', 'microsoft-edge'],
    windows: { path: ['Microsoft', 'Edge', 'User Data'] },
  },
  vivaldi: {
    macos: ['Library', 'Application Support', 'Vivaldi'],
    linux: ['.config', 'vivaldi'],
    windows: { path: ['Vivaldi', 'User Data'] },
  },
  opera: {
    macos: ['Library', 'Application Support', 'com.operasoftware.Opera'],
    linux: ['.config', 'opera'],
    windows: { path: ['Opera Software', 'Opera Stable'], useRoaming: true },
  },
}

/**
 * 获取所有浏览器数据目录路径，用于后续检测扩展是否已安装。
 *
 * 本函数是 common.ts 中 `getAllBrowserDataPaths()` 的轻量可移植版本，
 * 直接使用 `process.platform` 判断当前操作系统，无需依赖 `@ant/claude-for-chrome-mcp`。
 * 适合在 VS Code 扩展等不依赖完整 MCP 包的环境中使用。
 *
 * 路径组装规则：
 * - macOS：`~/Library/Application Support/<browser>/...`
 * - Linux：`~/.config/<browser>/...`
 * - Windows：`%APPDATA%\<browser>\...`（Opera 使用 Roaming，其余使用 Local）
 *   Windows 路径组装完毕后直接 `continue`，跳过非 Windows 分支，不重复入列
 *
 * @returns 按 BROWSER_DETECTION_ORDER 顺序排列的 {browser, path} 列表
 */
export function getAllBrowserDataPathsPortable(): BrowserPath[] {
  // 获取当前用户主目录，用于拼接平台相关路径
  const home = homedir()
  const paths: BrowserPath[] = []

  for (const browserId of BROWSER_DETECTION_ORDER) {
    const config = CHROMIUM_BROWSERS[browserId]
    let dataPath: string[] | undefined

    switch (process.platform) {
      case 'darwin':
        // macOS：从 ~/Library/Application Support 下读取各浏览器数据目录
        dataPath = config.macos
        break
      case 'linux':
        // Linux：从 ~/.config 下读取各浏览器数据目录
        dataPath = config.linux
        break
      case 'win32': {
        if (config.windows.path.length > 0) {
          // Opera 使用 Roaming AppData，其他浏览器使用 Local AppData
          const appDataBase = config.windows.useRoaming
            ? join(home, 'AppData', 'Roaming')
            : join(home, 'AppData', 'Local')
          paths.push({
            browser: browserId,
            path: join(appDataBase, ...config.windows.path),
          })
        }
        // Windows 路径已处理完毕，跳过下方非 Windows 分支的 push
        continue
      }
    }

    // 非 Windows 平台：路径有效时加入列表，空路径数组（如 arc 的 linux）则跳过
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
 * 通过扫描浏览器 Extensions 目录检测 Claude in Chrome 扩展是否已安装。
 *
 * 检测策略：
 * 1. 遍历 `browserPaths` 中每个浏览器的数据目录
 * 2. 在该目录下列出所有符合规则的 Profile 子目录（"Default" 或 "Profile N"）
 * 3. 对每个 Profile，依次检查 `Extensions/<extensionId>/` 目录是否可读
 * 4. 首次命中即返回，避免不必要的 I/O
 *
 * 可移植说明：本函数既适用于 Claude Code TUI，也适用于 VS Code 扩展，
 * 不依赖 `@ant/claude-for-chrome-mcp` 包。
 *
 * @param browserPaths - 由 `getAllBrowserDataPathsPortable()` 等函数提供的浏览器路径数组
 * @param log - 可选的调试日志回调，用于记录检测过程中的关键信息
 * @returns `{ isInstalled: boolean, browser: ChromiumBrowser | null }` 检测结果
 */
export async function detectExtensionInstallationPortable(
  browserPaths: BrowserPath[],
  log?: Logger,
): Promise<{
  isInstalled: boolean
  browser: ChromiumBrowser | null
}> {
  if (browserPaths.length === 0) {
    log?.(`[Claude in Chrome] No browser paths to check`)
    return { isInstalled: false, browser: null }
  }

  // 根据用户类型获取需要检测的扩展 ID 列表
  const extensionIds = getExtensionIds()

  // 逐个浏览器检测，按 BROWSER_DETECTION_ORDER 优先级顺序进行
  for (const { browser, path: browserBasePath } of browserPaths) {
    let browserProfileEntries = []

    try {
      // 读取浏览器数据目录下的所有条目，用于过滤 Profile 子目录
      browserProfileEntries = await readdir(browserBasePath, {
        withFileTypes: true,
      })
    } catch (e) {
      // 浏览器未安装或路径不存在属于正常情况，跳过继续检测下一个
      if (isFsInaccessible(e)) continue
      throw e
    }

    // 仅保留 "Default" 和 "Profile N" 形式的目录，忽略缓存、Crashpad 等非 Profile 目录
    const profileDirs = browserProfileEntries
      .filter(entry => entry.isDirectory())
      .filter(
        entry => entry.name === 'Default' || entry.name.startsWith('Profile '),
      )
      .map(entry => entry.name)

    if (profileDirs.length > 0) {
      log?.(
        `[Claude in Chrome] Found ${browser} profiles: ${profileDirs.join(', ')}`,
      )
    }

    // 在每个 Profile 的 Extensions 目录下检查是否存在目标扩展 ID 对应的目录
    for (const profile of profileDirs) {
      for (const extensionId of extensionIds) {
        const extensionPath = join(
          browserBasePath,
          profile,
          'Extensions',
          extensionId,
        )

        try {
          // readdir 成功说明扩展目录存在，即扩展已安装
          await readdir(extensionPath)
          log?.(
            `[Claude in Chrome] Extension ${extensionId} found in ${browser} ${profile}`,
          )
          // 首次命中立即返回，不再继续遍历
          return { isInstalled: true, browser }
        } catch {
          // 目录不存在或不可读，继续检测下一个 extensionId / profile
        }
      }
    }
  }

  log?.(`[Claude in Chrome] Extension not found in any browser`)
  return { isInstalled: false, browser: null }
}

/**
 * `detectExtensionInstallationPortable` 的简单布尔值包装。
 *
 * 当调用方只需知道扩展是否已安装、不关心具体在哪个浏览器中找到时，
 * 使用本函数替代 `detectExtensionInstallationPortable` 以简化调用代码。
 *
 * @param browserPaths - 浏览器数据路径数组
 * @param log - 可选调试日志回调
 * @returns 扩展已安装返回 `true`，否则返回 `false`
 */
export async function isChromeExtensionInstalledPortable(
  browserPaths: BrowserPath[],
  log?: Logger,
): Promise<boolean> {
  // 委托给 detectExtensionInstallationPortable，仅取 isInstalled 字段返回
  const result = await detectExtensionInstallationPortable(browserPaths, log)
  return result.isInstalled
}

/**
 * 自动获取浏览器路径并检测 Claude in Chrome 扩展是否已安装的便捷函数。
 *
 * 当调用方无需自定义浏览器路径时，使用本函数替代手动调用
 * `getAllBrowserDataPathsPortable()` + `isChromeExtensionInstalledPortable()` 的组合，
 * 减少样板代码。路径由 `getAllBrowserDataPathsPortable()` 根据当前平台自动组装。
 *
 * @param log - 可选调试日志回调
 * @returns 扩展已安装返回 `true`，否则返回 `false`
 */
export function isChromeExtensionInstalled(log?: Logger): Promise<boolean> {
  // 自动组装当前平台的浏览器数据路径，再委托给 isChromeExtensionInstalledPortable
  const browserPaths = getAllBrowserDataPathsPortable()
  return isChromeExtensionInstalledPortable(browserPaths, log)
}
