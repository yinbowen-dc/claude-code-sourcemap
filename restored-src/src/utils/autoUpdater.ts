/**
 * 自动更新器模块。
 *
 * 在 Claude Code 系统中，该模块负责管理 claude CLI 工具的自动更新逻辑：
 * - 从 npm registry 或 GCS bucket 获取最新版本
 * - 校验最低版本要求（assertMinVersion）与最高允许版本（getMaxVersion）
 * - 通过锁文件防止并发更新（acquireLock / releaseLock）
 * - 执行 npm/bun 全局安装，更新到最新或指定版本
 * - 从 shell 配置文件中清除旧的 claude alias
 * - 支持 stable / latest 两个发布渠道（release channel）
 */
import axios from 'axios'
import { constants as fsConstants } from 'fs'
import { access, writeFile } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import { getDynamicConfig_BLOCKS_ON_INIT } from 'src/services/analytics/growthbook.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js'
import { type ReleaseChannel, saveGlobalConfig } from './config.js'
import { logForDebugging } from './debug.js'
import { env } from './env.js'
import { getClaudeConfigHomeDir } from './envUtils.js'
import { ClaudeError, getErrnoCode, isENOENT } from './errors.js'
import { execFileNoThrowWithCwd } from './execFileNoThrow.js'
import { getFsImplementation } from './fsOperations.js'
import { gracefulShutdownSync } from './gracefulShutdown.js'
import { logError } from './log.js'
import { gte, lt } from './semver.js'
import { getInitialSettings } from './settings/settings.js'
import {
  filterClaudeAliases,
  getShellConfigPaths,
  readFileLines,
  writeFileLines,
} from './shellConfig.js'
import { jsonParse } from './slowOperations.js'

const GCS_BUCKET_URL =
  'https://storage.googleapis.com/claude-code-dist-86c565f3-f756-42ad-8dfa-d59b1c096819/claude-code-releases'

class AutoUpdaterError extends ClaudeError {}

export type InstallStatus =
  | 'success'
  | 'no_permissions'
  | 'install_failed'
  | 'in_progress'

export type AutoUpdaterResult = {
  version: string | null
  status: InstallStatus
  notifications?: string[]
}

export type MaxVersionConfig = {
  external?: string
  ant?: string
  external_message?: string
  ant_message?: string
}

/**
 * 检查当前版本是否满足 Statsig 动态配置下发的最低版本要求；
 * 若版本过低，打印错误信息并终止进程。
 *
 * 注：版本号使用 X.X.X+SHA 构建元数据格式（SemVer 规范中构建元数据在比较时忽略）。
 * assertMinVersion 使用语义版本比较；而 'claude update' 使用精确字符串比较以检测 SHA 变化。
 */
export async function assertMinVersion(): Promise<void> {
  if (process.env.NODE_ENV === 'test') {
    return
  }

  try {
    // 从 Statsig 动态配置获取 minVersion，默认值为 '0.0.0'（表示无限制）
    const versionConfig = await getDynamicConfig_BLOCKS_ON_INIT<{
      minVersion: string
    }>('tengu_version_config', { minVersion: '0.0.0' })

    if (
      versionConfig.minVersion &&
      lt(MACRO.VERSION, versionConfig.minVersion)  // 当前版本低于最低要求版本
    ) {
      // biome-ignore lint/suspicious/noConsole:: intentional console output
      console.error(`
It looks like your version of Claude Code (${MACRO.VERSION}) needs an update.
A newer version (${versionConfig.minVersion} or higher) is required to continue.

To update, please run:
    claude update

This will ensure you have access to the latest features and improvements.
`)
      // 打印提示后立即终止进程（退出码 1），强制用户更新
      gracefulShutdownSync(1)
    }
  } catch (error) {
    logError(error as Error)
  }
}

/**
 * 返回当前用户类型对应的最高允许版本（来自服务端动态配置）。
 * ant 用户取 `ant` 字段，外部用户取 `external` 字段。
 * 用于在发生事故时服务端暂停自动更新（kill switch）。
 */
export async function getMaxVersion(): Promise<string | undefined> {
  const config = await getMaxVersionConfig()
  if (process.env.USER_TYPE === 'ant') {
    return config.ant || undefined
  }
  return config.external || undefined
}

/**
 * 返回服务端配置的已知问题说明消息（当前版本超过最高允许版本时显示于警告横幅）。
 */
export async function getMaxVersionMessage(): Promise<string | undefined> {
  const config = await getMaxVersionConfig()
  if (process.env.USER_TYPE === 'ant') {
    return config.ant_message || undefined
  }
  return config.external_message || undefined
}

async function getMaxVersionConfig(): Promise<MaxVersionConfig> {
  try {
    return await getDynamicConfig_BLOCKS_ON_INIT<MaxVersionConfig>(
      'tengu_max_version_config',
      {},
    )
  } catch (error) {
    logError(error as Error)
    return {}
  }
}

/**
 * 检查目标版本是否因用户 minimumVersion 设置而应跳过（不降级）。
 * 切换到 stable 渠道时，用户可选择保持当前版本直到 stable 追上，防止降级。
 */
export function shouldSkipVersion(targetVersion: string): boolean {
  const settings = getInitialSettings()
  const minimumVersion = settings?.minimumVersion
  if (!minimumVersion) {
    return false
  }
  // 若目标版本低于用户设置的最低版本（如从 latest 切换到 stable 时防止降级），跳过安装
  const shouldSkip = !gte(targetVersion, minimumVersion)
  if (shouldSkip) {
    logForDebugging(
      `Skipping update to ${targetVersion} - below minimumVersion ${minimumVersion}`,
    )
  }
  return shouldSkip
}

// 自动更新锁文件，防止多进程并发更新
const LOCK_TIMEOUT_MS = 5 * 60 * 1000 // 锁文件超时时间：5 分钟

/**
 * 返回更新锁文件路径。运行时求值以确保在测试环境中正确获取路径。
 */
export function getLockFilePath(): string {
  return join(getClaudeConfigHomeDir(), '.update.lock')
}

/**
 * 尝试获取更新锁（原子性写锁文件）。
 * 若同一进程或其他进程已持有未过期锁（5 分钟超时），返回 false；否则返回 true。
 */
async function acquireLock(): Promise<boolean> {
  const fs = getFsImplementation()
  const lockPath = getLockFilePath()

  // 检查现有锁：乐观路径只需 1 次 stat()（锁不存在或新鲜锁）；
  // 陈旧锁恢复需 2 次（发现陈旧后立即重新确认，关闭 TOCTOU 竞态）。
  try {
    const stats = await fs.stat(lockPath)
    const age = Date.now() - stats.mtimeMs
    if (age < LOCK_TIMEOUT_MS) {
      // 锁文件存在且未超时，说明另一进程正在更新
      return false
    }
    // 锁已过期，尝试删除后接管。在 unlink 前再次核实陈旧性：
    // 若两个进程同时发现陈旧锁，A 先 unlink 并写入新锁，B 此时读到 A 的新锁（mtime 新鲜），
    // B 会退出，避免两个进程同时认为持有锁（TOCTOU 竞态关闭）。
    try {
      const recheck = await fs.stat(lockPath)
      if (Date.now() - recheck.mtimeMs < LOCK_TIMEOUT_MS) {
        // 重新检查发现锁已被刷新（另一进程接管），放弃
        return false
      }
      await fs.unlink(lockPath)
    } catch (err) {
      if (!isENOENT(err)) {
        logError(err as Error)
        return false
      }
    }
  } catch (err) {
    if (!isENOENT(err)) {
      logError(err as Error)
      return false
    }
    // ENOENT：锁文件不存在，继续创建
  }

  // 使用 O_EXCL（flag: 'wx'）原子写入锁文件：若另一进程抢先创建，收到 EEXIST 并退出。
  // 若配置目录不存在（ENOENT），惰性创建目录后重试。
  try {
    await writeFile(lockPath, `${process.pid}`, {
      encoding: 'utf8',
      flag: 'wx',  // O_EXCL：文件存在时失败，保证原子性
    })
    return true
  } catch (err) {
    const code = getErrnoCode(err)
    if (code === 'EEXIST') {
      // 另一进程赢得了竞争，退出
      return false
    }
    if (code === 'ENOENT') {
      try {
        // getFsImplementation() 的 mkdir 始终使用 recursive:true 并内部吞掉 EEXIST，
        // 因此目录创建竞态不会到达下面的 catch；只有 writeFile 的 EEXIST（真正的锁竞争）才会。
        await fs.mkdir(getClaudeConfigHomeDir())
        await writeFile(lockPath, `${process.pid}`, {
          encoding: 'utf8',
          flag: 'wx',
        })
        return true
      } catch (mkdirErr) {
        if (getErrnoCode(mkdirErr) === 'EEXIST') {
          return false
        }
        logError(mkdirErr as Error)
        return false
      }
    }
    logError(err as Error)
    return false
  }
}

/**
 * 释放当前进程持有的更新锁（仅删除由本 PID 写入的锁文件）。
 */
async function releaseLock(): Promise<void> {
  const fs = getFsImplementation()
  const lockPath = getLockFilePath()
  try {
    const lockData = await fs.readFile(lockPath, { encoding: 'utf8' })
    // 只删除由当前进程 PID 写入的锁，避免误删其他进程持有的锁
    if (lockData === `${process.pid}`) {
      await fs.unlink(lockPath)
    }
  } catch (err) {
    if (isENOENT(err)) {
      return  // 锁文件已不存在，无需处理
    }
    logError(err as Error)
  }
}

async function getInstallationPrefix(): Promise<string | null> {
  // 在用户主目录运行，避免读取项目级 .npmrc/.bunfig.toml（防止注册表劫持）
  const isBun = env.isRunningWithBun()
  let prefixResult = null
  if (isBun) {
    prefixResult = await execFileNoThrowWithCwd('bun', ['pm', 'bin', '-g'], {
      cwd: homedir(),
    })
  } else {
    prefixResult = await execFileNoThrowWithCwd(
      'npm',
      ['-g', 'config', 'get', 'prefix'],
      { cwd: homedir() },
    )
  }
  if (prefixResult.code !== 0) {
    logError(new Error(`Failed to check ${isBun ? 'bun' : 'npm'} permissions`))
    return null
  }
  return prefixResult.stdout.trim()
}

/**
 * 检查全局包安装目录是否具有写权限，返回是否有权限及 npm 前缀路径。
 */
export async function checkGlobalInstallPermissions(): Promise<{
  hasPermissions: boolean
  npmPrefix: string | null
}> {
  try {
    const prefix = await getInstallationPrefix()
    if (!prefix) {
      return { hasPermissions: false, npmPrefix: null }
    }

    try {
      await access(prefix, fsConstants.W_OK)
      return { hasPermissions: true, npmPrefix: prefix }
    } catch {
      logError(
        new AutoUpdaterError(
          'Insufficient permissions for global npm install.',
        ),
      )
      return { hasPermissions: false, npmPrefix: prefix }
    }
  } catch (error) {
    logError(error as Error)
    return { hasPermissions: false, npmPrefix: null }
  }
}

/**
 * 从 npm registry 获取指定发布渠道（stable / latest）的最新版本号。
 * 从用户主目录运行以避免读取项目级 .npmrc（防止恶意重定向到攻击者 registry）。
 */
export async function getLatestVersion(
  channel: ReleaseChannel,
): Promise<string | null> {
  const npmTag = channel === 'stable' ? 'stable' : 'latest'

  // Run from home directory to avoid reading project-level .npmrc
  // which could be maliciously crafted to redirect to an attacker's registry
  const result = await execFileNoThrowWithCwd(
    'npm',
    ['view', `${MACRO.PACKAGE_URL}@${npmTag}`, 'version', '--prefer-online'],
    { abortSignal: AbortSignal.timeout(5000), cwd: homedir() },
  )
  if (result.code !== 0) {
    logForDebugging(`npm view failed with code ${result.code}`)
    if (result.stderr) {
      logForDebugging(`npm stderr: ${result.stderr.trim()}`)
    } else {
      logForDebugging('npm stderr: (empty)')
    }
    if (result.stdout) {
      logForDebugging(`npm stdout: ${result.stdout.trim()}`)
    }
    return null
  }
  return result.stdout.trim()
}

export type NpmDistTags = {
  latest: string | null
  stable: string | null
}

/**
 * 从 npm registry 获取 dist-tags（latest 与 stable 版本号）。
 * 用于 doctor 命令向用户展示可用版本。
 */
export async function getNpmDistTags(): Promise<NpmDistTags> {
  // Run from home directory to avoid reading project-level .npmrc
  const result = await execFileNoThrowWithCwd(
    'npm',
    ['view', MACRO.PACKAGE_URL, 'dist-tags', '--json', '--prefer-online'],
    { abortSignal: AbortSignal.timeout(5000), cwd: homedir() },
  )

  if (result.code !== 0) {
    logForDebugging(`npm view dist-tags failed with code ${result.code}`)
    return { latest: null, stable: null }
  }

  try {
    const parsed = jsonParse(result.stdout.trim()) as Record<string, unknown>
    return {
      latest: typeof parsed.latest === 'string' ? parsed.latest : null,
      stable: typeof parsed.stable === 'string' ? parsed.stable : null,
    }
  } catch (error) {
    logForDebugging(`Failed to parse dist-tags: ${error}`)
    return { latest: null, stable: null }
  }
}

/**
 * 从 GCS bucket 获取指定发布渠道的最新版本号。
 * 用于无 npm 环境（如包管理器安装方式）的版本检查。
 */
export async function getLatestVersionFromGcs(
  channel: ReleaseChannel,
): Promise<string | null> {
  try {
    const response = await axios.get(`${GCS_BUCKET_URL}/${channel}`, {
      timeout: 5000,
      responseType: 'text',
    })
    return response.data.trim()
  } catch (error) {
    logForDebugging(`Failed to fetch ${channel} from GCS: ${error}`)
    return null
  }
}

/**
 * 从 GCS bucket 同时获取 latest 和 stable 渠道版本号（原生安装方式使用）。
 */
export async function getGcsDistTags(): Promise<NpmDistTags> {
  const [latest, stable] = await Promise.all([
    getLatestVersionFromGcs('latest'),
    getLatestVersionFromGcs('stable'),
  ])

  return { latest, stable }
}

/**
 * 获取版本历史（仅限 ant 用户）。
 * 从 npm registry 返回最近 limit 条版本，优先使用原生包 URL 以确保列出的版本均有原生二进制文件。
 */
export async function getVersionHistory(limit: number): Promise<string[]> {
  if (process.env.USER_TYPE !== 'ant') {
    return []
  }

  // Use native package URL when available to ensure we only show versions
  // that have native binaries (not all JS package versions have native builds)
  const packageUrl = MACRO.NATIVE_PACKAGE_URL ?? MACRO.PACKAGE_URL

  // Run from home directory to avoid reading project-level .npmrc
  const result = await execFileNoThrowWithCwd(
    'npm',
    ['view', packageUrl, 'versions', '--json', '--prefer-online'],
    // Longer timeout for version list
    { abortSignal: AbortSignal.timeout(30000), cwd: homedir() },
  )

  if (result.code !== 0) {
    logForDebugging(`npm view versions failed with code ${result.code}`)
    if (result.stderr) {
      logForDebugging(`npm stderr: ${result.stderr.trim()}`)
    }
    return []
  }

  try {
    const versions = jsonParse(result.stdout.trim()) as string[]
    // Take last N versions, then reverse to get newest first
    return versions.slice(-limit).reverse()
  } catch (error) {
    logForDebugging(`Failed to parse version history: ${error}`)
    return []
  }
}

/**
 * 执行 npm/bun 全局安装，将 claude 更新到最新或指定版本。
 * 通过锁文件防止并发安装；检测 WSL 中 Windows npm 并给出修复提示；
 * 安装成功后将 installMethod 记录为 'global'。
 */
export async function installGlobalPackage(
  specificVersion?: string | null,
): Promise<InstallStatus> {
  // 尝试获取更新锁；若已有其他进程在更新则直接返回 in_progress
  if (!(await acquireLock())) {
    logError(
      new AutoUpdaterError('Another process is currently installing an update'),
    )
    // 记录锁竞争事件，用于监控并发更新频率
    logEvent('tengu_auto_updater_lock_contention', {
      pid: process.pid,
      currentVersion:
        MACRO.VERSION as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    return 'in_progress'
  }

  try {
    // 清理 shell 配置文件中的旧版 claude alias（旧安装方式的遗留）
    await removeClaudeAliasesFromShellConfigs()
    // 检查是否在 WSL 中使用了 Windows 的 npm（/mnt/c/...），此种情况不支持更新
    if (!env.isRunningWithBun() && env.isNpmFromWindowsPath()) {
      logError(new Error('Windows NPM detected in WSL environment'))
      logEvent('tengu_auto_updater_windows_npm_in_wsl', {
        currentVersion:
          MACRO.VERSION as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
      // biome-ignore lint/suspicious/noConsole:: intentional console output
      console.error(`
Error: Windows NPM detected in WSL

You're running Claude Code in WSL but using the Windows NPM installation from /mnt/c/.
This configuration is not supported for updates.

To fix this issue:
  1. Install Node.js within your Linux distribution: e.g. sudo apt install nodejs npm
  2. Make sure Linux NPM is in your PATH before the Windows version
  3. Try updating again with 'claude update'
`)
      return 'install_failed'
    }

    // 检查全局安装目录是否有写权限
    const { hasPermissions } = await checkGlobalInstallPermissions()
    if (!hasPermissions) {
      return 'no_permissions'
    }

    // 构建安装包规格：指定版本时用 package@version，否则用最新版
    const packageSpec = specificVersion
      ? `${MACRO.PACKAGE_URL}@${specificVersion}`
      : MACRO.PACKAGE_URL

    // 在主目录运行安装命令，避免读取项目级 .npmrc/.bunfig.toml（防止注册表劫持攻击）
    const packageManager = env.isRunningWithBun() ? 'bun' : 'npm'
    const installResult = await execFileNoThrowWithCwd(
      packageManager,
      ['install', '-g', packageSpec],
      { cwd: homedir() },
    )
    if (installResult.code !== 0) {
      const error = new AutoUpdaterError(
        `Failed to install new version of claude: ${installResult.stdout} ${installResult.stderr}`,
      )
      logError(error)
      return 'install_failed'
    }

    // 安装成功后将 installMethod 记录为 'global'，用于后续判断更新策略
    saveGlobalConfig(current => ({
      ...current,
      installMethod: 'global',
    }))

    return 'success'
  } finally {
    // 无论成功还是失败，都必须释放锁，防止死锁
    await releaseLock()
  }
}

/**
 * 从各 shell 配置文件中移除 claude alias 行。
 * 在切换到原生或 npm 全局安装方式时清理旧安装方式遗留的 alias。
 */
async function removeClaudeAliasesFromShellConfigs(): Promise<void> {
  const configMap = getShellConfigPaths()

  // 遍历所有 shell 配置文件（.bashrc、.zshrc 等）
  for (const [, configFile] of Object.entries(configMap)) {
    try {
      const lines = await readFileLines(configFile)
      if (!lines) continue

      // 过滤掉 claude alias 行并检查是否有改动
      const { filtered, hadAlias } = filterClaudeAliases(lines)

      if (hadAlias) {
        // 只有确实存在 alias 时才写回文件，减少不必要的磁盘 I/O
        await writeFileLines(configFile, filtered)
        logForDebugging(`Removed claude alias from ${configFile}`)
      }
    } catch (error) {
      // 单个文件处理失败不影响其他文件的清理，记录日志后继续
      logForDebugging(`Failed to remove alias from ${configFile}: ${error}`, {
        level: 'error',
      })
    }
  }
}
