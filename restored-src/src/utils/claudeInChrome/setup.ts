/**
 * Claude in Chrome 安装与配置模块（完整版）。
 *
 * 在 Claude Code 系统中，该模块负责完整的 Claude in Chrome 集成安装流程：
 * - 检测已安装的 Chromium 浏览器、读取扩展安装状态
 * - 生成 native messaging host manifest 并写入各浏览器配置目录
 * - 将 MCP 服务端配置写入 Claude Code 全局配置
 * - 在交互式 / 非交互式会话中自动或提示安装
 * 依赖 @ant/claude-for-chrome-mcp 和 setupPortable.ts 的基础工具函数。
 */
import { BROWSER_TOOLS } from '@ant/claude-for-chrome-mcp'
import { chmod, mkdir, readFile, writeFile } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import { fileURLToPath } from 'url'
import {
  getIsInteractive,
  getIsNonInteractiveSession,
  getSessionBypassPermissionsMode,
} from '../../bootstrap/state.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import type { ScopedMcpServerConfig } from '../../services/mcp/types.js'
import { isInBundledMode } from '../bundledMode.js'
import { getGlobalConfig, saveGlobalConfig } from '../config.js'
import { logForDebugging } from '../debug.js'
import {
  getClaudeConfigHomeDir,
  isEnvDefinedFalsy,
  isEnvTruthy,
} from '../envUtils.js'
import { execFileNoThrowWithCwd } from '../execFileNoThrow.js'
import { getPlatform } from '../platform.js'
import { jsonStringify } from '../slowOperations.js'
import {
  CLAUDE_IN_CHROME_MCP_SERVER_NAME,
  getAllBrowserDataPaths,
  getAllNativeMessagingHostsDirs,
  getAllWindowsRegistryKeys,
  openInChrome,
} from './common.js'
import { getChromeSystemPrompt } from './prompt.js'
import { isChromeExtensionInstalledPortable } from './setupPortable.js'

const CHROME_EXTENSION_RECONNECT_URL = 'https://clau.de/chrome/reconnect'

const NATIVE_HOST_IDENTIFIER = 'com.anthropic.claude_code_browser_extension'
const NATIVE_HOST_MANIFEST_NAME = `${NATIVE_HOST_IDENTIFIER}.json`

/**
 * 判断是否应启用 Claude in Chrome 功能。
 *
 * 决策优先级（从高到低）：
 * 1. 非交互式会话（SDK/CI）且未显式通过 CLI 标志开启 → 禁用
 * 2. CLI 标志 chromeFlag 为 true/false → 直接遵从
 * 3. 环境变量 CLAUDE_CODE_ENABLE_CFC 为真/假 → 遵从环境变量
 * 4. 全局配置 claudeInChromeDefaultEnabled → 遵从配置值
 * 5. 以上均未设置 → 默认禁用（false）
 *
 * @param chromeFlag 命令行 --chrome 标志的值，undefined 表示未传入
 * @returns 是否应启用 Claude in Chrome
 */
export function shouldEnableClaudeInChrome(chromeFlag?: boolean): boolean {
  // Disable by default in non-interactive sessions (e.g., SDK, CI)
  // 非交互式会话下（SDK/CI），除非明确通过 CLI 标志强制开启，否则默认禁用
  if (getIsNonInteractiveSession() && chromeFlag !== true) {
    return false
  }

  // Check CLI flags
  // CLI 标志最高优先级，直接决定启用或禁用
  if (chromeFlag === true) {
    return true
  }
  if (chromeFlag === false) {
    return false
  }

  // Check environment variables
  // 环境变量次优先级
  if (isEnvTruthy(process.env.CLAUDE_CODE_ENABLE_CFC)) {
    return true
  }
  if (isEnvDefinedFalsy(process.env.CLAUDE_CODE_ENABLE_CFC)) {
    return false
  }

  // Check default config settings
  // 从全局配置文件读取用户持久化的默认启用状态
  const config = getGlobalConfig()
  if (config.claudeInChromeDefaultEnabled !== undefined) {
    return config.claudeInChromeDefaultEnabled
  }

  // 所有条件均未命中，默认禁用
  return false
}

// 模块级缓存变量，避免每次调用都重新读取配置和扩展安装状态
let shouldAutoEnable: boolean | undefined = undefined

/**
 * 判断是否应自动启用 Claude in Chrome（带模块级缓存）。
 *
 * 自动启用条件（同时满足）：
 * 1. 当前为交互式会话（非 SDK/CI/pipe）
 * 2. Chrome 扩展已安装（读取磁盘缓存，后台更新）
 * 3. ant 内部用户 OR GrowthBook 功能开关 tengu_chrome_auto_enable 已开启
 *
 * 结果在首次调用后缓存到模块变量，进程内不会重新计算。
 *
 * @returns 是否应自动启用 Claude in Chrome
 */
export function shouldAutoEnableClaudeInChrome(): boolean {
  // 已有缓存结果则直接返回，避免重复读取配置
  if (shouldAutoEnable !== undefined) {
    return shouldAutoEnable
  }

  // 同时满足交互式 + 扩展已安装 + 内部用户或功能开关才自动启用
  shouldAutoEnable =
    getIsInteractive() &&
    isChromeExtensionInstalled_CACHED_MAY_BE_STALE() &&
    (process.env.USER_TYPE === 'ant' ||
      getFeatureValue_CACHED_MAY_BE_STALE('tengu_chrome_auto_enable', false))

  return shouldAutoEnable
}

/**
 * 初始化并返回 Claude in Chrome MCP 服务端配置及允许的工具列表。
 *
 * 执行步骤：
 * 1. 判断当前是否为打包模式（bundled binary）还是开发模式（Node.js + cli.js）
 * 2. 构建 MCP stdio 配置（command/args/env）
 * 3. 异步 fire-and-forget 创建 wrapper 脚本并安装 native messaging host manifest
 * 4. 返回 mcpConfig、allowedTools 和系统提示文本
 *
 * @returns MCP 配置、允许的工具列表和系统提示字符串
 */
export function setupClaudeInChrome(): {
  mcpConfig: Record<string, ScopedMcpServerConfig>
  allowedTools: string[]
  systemPrompt: string
} {
  // 判断是否为打包后的可执行文件（bundled mode）
  const isNativeBuild = isInBundledMode()
  // 从 @ant/claude-for-chrome-mcp 获取所有已知浏览器工具，添加 MCP 前缀
  const allowedTools = BROWSER_TOOLS.map(
    tool => `mcp__claude-in-chrome__${tool.name}`,
  )

  // 构建环境变量覆盖（如 bypass permissions 模式）
  const env: Record<string, string> = {}
  if (getSessionBypassPermissionsMode()) {
    // bypass permissions 模式下跳过所有权限检查
    env.CLAUDE_CHROME_PERMISSION_MODE = 'skip_all_permission_checks'
  }
  const hasEnv = Object.keys(env).length > 0

  if (isNativeBuild) {
    // Create a wrapper script that calls the same binary with --chrome-native-host. This
    // is needed because the native host manifest "path" field cannot contain arguments.
    // 打包模式：wrapper 脚本调用同一二进制文件加 --chrome-native-host 参数
    // 因为 native host manifest 的 path 字段不支持携带参数，必须通过 wrapper 传入
    const execCommand = `"${process.execPath}" --chrome-native-host`

    // Run asynchronously without blocking; best-effort so swallow errors
    // 异步 fire-and-forget：创建 wrapper + 安装 manifest，失败时仅记录日志
    void createWrapperScript(execCommand)
      .then(manifestBinaryPath =>
        installChromeNativeHostManifest(manifestBinaryPath),
      )
      .catch(e =>
        logForDebugging(
          `[Claude in Chrome] Failed to install native host: ${e}`,
          { level: 'error' },
        ),
      )

    return {
      mcpConfig: {
        [CLAUDE_IN_CHROME_MCP_SERVER_NAME]: {
          type: 'stdio' as const,
          command: process.execPath,
          args: ['--claude-in-chrome-mcp'],
          scope: 'dynamic' as const,
          ...(hasEnv && { env }),
        },
      },
      allowedTools,
      systemPrompt: getChromeSystemPrompt(),
    }
  } else {
    // 开发模式：通过 Node.js 执行 cli.js，传入 --claude-in-chrome-mcp 参数
    const __filename = fileURLToPath(import.meta.url)
    const __dirname = join(__filename, '..')
    const cliPath = join(__dirname, 'cli.js')

    // 同样异步安装 native host manifest，不阻塞返回
    void createWrapperScript(
      `"${process.execPath}" "${cliPath}" --chrome-native-host`,
    )
      .then(manifestBinaryPath =>
        installChromeNativeHostManifest(manifestBinaryPath),
      )
      .catch(e =>
        logForDebugging(
          `[Claude in Chrome] Failed to install native host: ${e}`,
          { level: 'error' },
        ),
      )

    const mcpConfig = {
      [CLAUDE_IN_CHROME_MCP_SERVER_NAME]: {
        type: 'stdio' as const,
        command: process.execPath,
        args: [`${cliPath}`, '--claude-in-chrome-mcp'],
        scope: 'dynamic' as const,
        ...(hasEnv && { env }),
      },
    }

    return {
      mcpConfig,
      allowedTools,
      systemPrompt: getChromeSystemPrompt(),
    }
  }
}

/**
 * 获取当前平台下所有浏览器的 native messaging host 清单目录路径列表。
 *
 * - Windows：使用单一目录（AppData/Claude Code/ChromeNativeHost），
 *   注册表指向该目录下的 manifest 文件，由 registerWindowsNativeHosts 写入
 * - macOS/Linux：返回所有已知浏览器各自的 NativeMessagingHosts 目录
 *
 * @returns manifest 应写入的目录路径数组
 */
function getNativeMessagingHostsDirs(): string[] {
  const platform = getPlatform()

  if (platform === 'windows') {
    // Windows uses a single location with registry entries pointing to it
    // Windows 平台：集中存放在 AppData/Claude Code/ChromeNativeHost，注册表中各浏览器均指向此处
    const home = homedir()
    const appData = process.env.APPDATA || join(home, 'AppData', 'Local')
    return [join(appData, 'Claude Code', 'ChromeNativeHost')]
  }

  // macOS and Linux: return all browser native messaging directories
  // macOS/Linux：返回所有浏览器各自的 NativeMessagingHosts 目录列表
  return getAllNativeMessagingHostsDirs().map(({ path }) => path)
}

/**
 * 生成并安装 native messaging host manifest 到所有浏览器配置目录。
 *
 * manifest 内容包括：host 标识符、描述、二进制路径、allowed_origins（扩展 ID 白名单）。
 * ant 内部用户会额外包含 DEV 和 ANT 扩展 ID。
 *
 * 安装流程：
 * 1. 遍历所有目标目录，比对文件内容（内容相同则跳过）
 * 2. 创建目录（如不存在）并写入 manifest JSON
 * 3. Windows 平台额外调用 registerWindowsNativeHosts 写入注册表
 * 4. 若有任意 manifest 被更新，且扩展已安装，则打开重连页面触发扩展刷新
 *
 * @param manifestBinaryPath native host 可执行文件（wrapper 脚本）的绝对路径
 */
export async function installChromeNativeHostManifest(
  manifestBinaryPath: string,
): Promise<void> {
  const manifestDirs = getNativeMessagingHostsDirs()
  if (manifestDirs.length === 0) {
    throw Error('Claude in Chrome Native Host not supported on this platform')
  }

  // 构建 manifest 对象
  const manifest = {
    name: NATIVE_HOST_IDENTIFIER,
    description: 'Claude Code Browser Extension Native Host',
    path: manifestBinaryPath,
    type: 'stdio',
    allowed_origins: [
      `chrome-extension://fcoeoabgfenejglbffodgkkbkcdhcgfn/`, // PROD_EXTENSION_ID
      // ant 内部用户额外允许开发版和 ant 版扩展 ID
      ...(process.env.USER_TYPE === 'ant'
        ? [
            'chrome-extension://dihbgbndebgnbjfmelmegjepbnkhlgni/', // DEV_EXTENSION_ID
            'chrome-extension://dngcpimnedloihjnnfngkgjoidhnaolf/', // ANT_EXTENSION_ID
          ]
        : []),
    ],
  }

  const manifestContent = jsonStringify(manifest, null, 2)
  // 追踪是否有任意 manifest 发生了实际写入（用于决定是否触发重连）
  let anyManifestUpdated = false

  // Install manifest to all browser directories
  // 遍历所有目标目录，逐一写入 manifest 文件
  for (const manifestDir of manifestDirs) {
    const manifestPath = join(manifestDir, NATIVE_HOST_MANIFEST_NAME)

    // Check if content matches to avoid unnecessary writes
    // 内容相同时跳过，避免不必要的 I/O 和后续重连操作
    const existingContent = await readFile(manifestPath, 'utf-8').catch(
      () => null,
    )
    if (existingContent === manifestContent) {
      continue
    }

    try {
      // 确保目录存在（包括中间目录），再写入 manifest 文件
      await mkdir(manifestDir, { recursive: true })
      await writeFile(manifestPath, manifestContent)
      logForDebugging(
        `[Claude in Chrome] Installed native host manifest at: ${manifestPath}`,
      )
      anyManifestUpdated = true
    } catch (error) {
      // Log but don't fail - the browser might not be installed
      // 目录或文件写入失败时仅记录日志，不抛出（可能该浏览器未安装）
      logForDebugging(
        `[Claude in Chrome] Failed to install manifest at ${manifestPath}: ${error}`,
      )
    }
  }

  // Windows requires registry entries pointing to the manifest for each browser
  // Windows 需要将 manifest 路径写入注册表，各浏览器才能发现 native host
  if (getPlatform() === 'windows') {
    const manifestPath = join(manifestDirs[0]!, NATIVE_HOST_MANIFEST_NAME)
    registerWindowsNativeHosts(manifestPath)
  }

  // Restart the native host if we have rewritten any manifest
  // 若有 manifest 被更新（首次安装或路径变更），触发浏览器重连
  if (anyManifestUpdated) {
    void isChromeExtensionInstalled().then(isInstalled => {
      if (isInstalled) {
        logForDebugging(
          `[Claude in Chrome] First-time install detected, opening reconnect page in browser`,
        )
        // 打开重连页面，让扩展重新发现 native host
        void openInChrome(CHROME_EXTENSION_RECONNECT_URL)
      } else {
        logForDebugging(
          `[Claude in Chrome] First-time install detected, but extension not installed, skipping reconnect`,
        )
      }
    })
  }
}

/**
 * 将 native messaging host 清单路径写入 Windows 注册表，供所有已知浏览器识别。
 *
 * 使用 reg.exe add 命令写入各浏览器的 NativeMessagingHosts 注册表键：
 * HKCU\Software\{Browser}\NativeMessagingHosts\com.anthropic.claude_code_browser_extension
 *
 * fire-and-forget：写入结果仅记录日志，不阻塞调用方。
 *
 * @param manifestPath manifest JSON 文件的绝对路径
 */
function registerWindowsNativeHosts(manifestPath: string): void {
  const registryKeys = getAllWindowsRegistryKeys()

  for (const { browser, key } of registryKeys) {
    const fullKey = `${key}\\${NATIVE_HOST_IDENTIFIER}`
    // Use reg.exe to add the registry entry
    // https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging
    // 调用 reg.exe 写入注册表，/ve 设置默认值，/f 强制覆盖
    void execFileNoThrowWithCwd('reg', [
      'add',
      fullKey,
      '/ve', // Set the default (unnamed) value
      '/t',
      'REG_SZ',
      '/d',
      manifestPath,
      '/f', // Force overwrite without prompt
    ]).then(result => {
      if (result.code === 0) {
        logForDebugging(
          `[Claude in Chrome] Registered native host for ${browser} in Windows registry: ${fullKey}`,
        )
      } else {
        logForDebugging(
          `[Claude in Chrome] Failed to register native host for ${browser} in Windows registry: ${result.stderr}`,
        )
      }
    })
  }
}

/**
 * 创建用于 Chrome native messaging 的 wrapper 启动脚本。
 *
 * 背景：Chrome native host manifest 的 path 字段只能是可执行文件路径，不能包含参数。
 * 因此需要一个 wrapper 脚本，让 Chrome 通过它间接调用带参数的命令。
 *
 * 脚本生成规则：
 * - Windows：生成 .bat 文件（@echo off + %command%）
 * - 其他平台：生成 shell 脚本（#!/bin/sh + exec %command%），并设置 0755 权限
 *
 * 内容相同时幂等跳过，避免不必要的文件写入。
 *
 * @param command 要在 wrapper 中执行的完整命令字符串
 * @returns wrapper 脚本的绝对路径
 */
async function createWrapperScript(command: string): Promise<string> {
  const platform = getPlatform()
  // wrapper 脚本存放在 ~/.claude/chrome/ 目录下
  const chromeDir = join(getClaudeConfigHomeDir(), 'chrome')
  // Windows 使用 .bat，其他平台使用无扩展名 shell 脚本
  const wrapperPath =
    platform === 'windows'
      ? join(chromeDir, 'chrome-native-host.bat')
      : join(chromeDir, 'chrome-native-host')

  const scriptContent =
    platform === 'windows'
      ? `@echo off
REM Chrome native host wrapper script
REM Generated by Claude Code - do not edit manually
${command}
`
      : `#!/bin/sh
# Chrome native host wrapper script
# Generated by Claude Code - do not edit manually
exec ${command}
`

  // Check if content matches to avoid unnecessary writes
  // 内容未变化则直接返回路径，避免重复写入
  const existingContent = await readFile(wrapperPath, 'utf-8').catch(() => null)
  if (existingContent === scriptContent) {
    return wrapperPath
  }

  // 创建目录并写入脚本内容
  await mkdir(chromeDir, { recursive: true })
  await writeFile(wrapperPath, scriptContent)

  // 非 Windows 平台设置可执行权限
  if (platform !== 'windows') {
    await chmod(wrapperPath, 0o755)
  }

  logForDebugging(
    `[Claude in Chrome] Created Chrome native host wrapper script: ${wrapperPath}`,
  )
  return wrapperPath
}

/**
 * 同步读取缓存中的 Chrome 扩展安装状态，同时在后台异步更新缓存。
 *
 * 设计说明：
 * - 仅缓存"已安装"结果（正向检测），不缓存"未安装"。
 *   理由：在共享 ~/.claude.json 的远程开发环境中，本机无 Chrome 导致的负向结果
 *   不应污染共享配置，否则会使自动启用功能在所有机器上永久失效。
 * - 后台更新确保下次调用时缓存是最新的，但当前调用立即返回，不阻塞启动。
 *
 * @returns 缓存中记录的扩展安装状态（可能是上次检测结果），未检测过时返回 false
 */
function isChromeExtensionInstalled_CACHED_MAY_BE_STALE(): boolean {
  // Update cache in background without blocking
  // 后台异步更新缓存（不阻塞当前调用）
  void isChromeExtensionInstalled().then(isInstalled => {
    // Only persist positive detections — see docstring. The cost of a stale
    // `true` is one silent MCP connection attempt per session; the cost of a
    // stale `false` is auto-enable never working again without manual repair.
    // 只将"已安装"写入持久化缓存，防止负向结果污染共享配置
    if (!isInstalled) {
      return
    }
    const config = getGlobalConfig()
    if (config.cachedChromeExtensionInstalled !== isInstalled) {
      // 缓存值变化时才写入配置，减少不必要的磁盘 I/O
      saveGlobalConfig(prev => ({
        ...prev,
        cachedChromeExtensionInstalled: isInstalled,
      }))
    }
  })

  // Return cached value immediately from disk
  // 立即返回磁盘上的缓存值（可能为 undefined，转为 false）
  const cached = getGlobalConfig().cachedChromeExtensionInstalled
  return cached ?? false
}

/**
 * 异步检测 Claude in Chrome 扩展是否已安装在系统中的任意浏览器。
 *
 * 获取当前平台的所有已知浏览器数据目录路径，
 * 委托给 setupPortable.ts 的 isChromeExtensionInstalledPortable 执行实际检测。
 *
 * @returns 扩展是否已安装
 */
export async function isChromeExtensionInstalled(): Promise<boolean> {
  const browserPaths = getAllBrowserDataPaths()
  if (browserPaths.length === 0) {
    logForDebugging(
      `[Claude in Chrome] Unsupported platform for extension detection: ${getPlatform()}`,
    )
    return false
  }
  // 委托给轻量可移植版本执行文件系统扫描
  return isChromeExtensionInstalledPortable(browserPaths, logForDebugging)
}
