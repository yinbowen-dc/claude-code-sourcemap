/**
 * Doctor 系统诊断模块（doctorDiagnostic.ts）
 *
 * 【在系统流程中的位置】
 * 该模块是 `claude doctor` 命令的核心诊断后端，被 doctor 命令处理器调用。
 * 它通过检查安装路径、进程参数、npm 配置、包管理器等信息，
 * 生成完整的 DiagnosticInfo 结构，供命令行 UI 格式化输出给用户。
 *
 * 【主要功能】
 * - getCurrentInstallationType()：检测当前运行的安装类型（npm-global/npm-local/native 等）
 * - getDoctorDiagnostic()：汇总所有诊断信息，包括版本、路径、多重安装检测、配置告警等
 * - detectMultipleInstallations()：扫描系统中是否存在多个 Claude Code 安装
 * - detectConfigurationIssues()：检测 PATH 缺失、配置不匹配等配置问题
 * - detectLinuxGlobPatternWarnings()：检测 Linux 沙箱 glob 模式不兼容警告
 */
import { execa } from 'execa'
import { readFile, realpath } from 'fs/promises'
import { homedir } from 'os'
import { delimiter, join, posix, win32 } from 'path'
import { checkGlobalInstallPermissions } from './autoUpdater.js'
import { isInBundledMode } from './bundledMode.js'
import {
  formatAutoUpdaterDisabledReason,
  getAutoUpdaterDisabledReason,
  getGlobalConfig,
  type InstallMethod,
} from './config.js'
import { getCwd } from './cwd.js'
import { isEnvTruthy } from './envUtils.js'
import { execFileNoThrow } from './execFileNoThrow.js'
import { getFsImplementation } from './fsOperations.js'
import {
  getShellType,
  isRunningFromLocalInstallation,
  localInstallationExists,
} from './localInstaller.js'
import {
  detectApk,
  detectAsdf,
  detectDeb,
  detectHomebrew,
  detectMise,
  detectPacman,
  detectRpm,
  detectWinget,
  getPackageManager,
} from './nativeInstaller/packageManagers.js'
import { getPlatform } from './platform.js'
import { getRipgrepStatus } from './ripgrep.js'
import { SandboxManager } from './sandbox/sandbox-adapter.js'
import { getManagedFilePath } from './settings/managedPath.js'
import { CUSTOMIZATION_SURFACES } from './settings/types.js'
import {
  findClaudeAlias,
  findValidClaudeAlias,
  getShellConfigPaths,
} from './shellConfig.js'
import { jsonParse } from './slowOperations.js'
import { which } from './which.js'

/** Claude Code 的安装类型枚举 */
export type InstallationType =
  | 'npm-global'    // 通过 npm -g 全局安装
  | 'npm-local'     // 通过本地 npm 安装（~/.claude/local）
  | 'native'        // 原生/捆绑二进制安装
  | 'package-manager' // 通过系统包管理器安装（Homebrew、apt 等）
  | 'development'   // 开发模式运行
  | 'unknown'       // 无法识别的安装方式

/** getDoctorDiagnostic() 返回的完整诊断信息结构 */
export type DiagnosticInfo = {
  installationType: InstallationType
  version: string
  installationPath: string
  invokedBinary: string
  configInstallMethod: InstallMethod | 'not set'
  autoUpdates: string
  hasUpdatePermissions: boolean | null
  multipleInstallations: Array<{ type: string; path: string }>
  warnings: Array<{ issue: string; fix: string }>
  recommendation?: string
  packageManager?: string
  ripgrepStatus: {
    working: boolean
    mode: 'system' | 'builtin' | 'embedded'
    systemPath: string | null
  }
}

/**
 * 获取规范化后的调用路径和 Node.js 可执行文件路径。
 *
 * 【流程说明】
 * - 在 Windows 平台上将反斜杠统一替换为正斜杠，保证后续路径比较的一致性
 * - 返回 [调用路径, 可执行文件路径] 元组
 */
function getNormalizedPaths(): [invokedPath: string, execPath: string] {
  let invokedPath = process.argv[1] || ''
  let execPath = process.execPath || process.argv[0] || ''

  // Windows 平台：将路径分隔符统一为正斜杠，便于字符串匹配
  if (getPlatform() === 'windows') {
    invokedPath = invokedPath.split(win32.sep).join(posix.sep)
    execPath = execPath.split(win32.sep).join(posix.sep)
  }

  return [invokedPath, execPath]
}

/**
 * 检测当前进程的 Claude Code 安装类型。
 *
 * 【流程说明】
 * 1. NODE_ENV=development 时直接返回 'development'
 * 2. 捆绑模式下，依次检测各系统包管理器；匹配则返回 'package-manager'，否则返回 'native'
 * 3. 本地 npm 安装时返回 'npm-local'
 * 4. 路径包含已知 npm 全局目录时返回 'npm-global'
 * 5. 通过 `npm config get prefix` 获取全局前缀并比对路径
 * 6. 无法识别时返回 'unknown'
 */
export async function getCurrentInstallationType(): Promise<InstallationType> {
  // 开发模式直接返回，无需检测安装路径
  if (process.env.NODE_ENV === 'development') {
    return 'development'
  }

  const [invokedPath] = getNormalizedPaths()

  // 捆绑模式下先检测系统包管理器
  if (isInBundledMode()) {
    // 依次检测 Homebrew、Winget、Mise、Asdf、Pacman、Deb、RPM、Apk
    if (
      detectHomebrew() ||
      detectWinget() ||
      detectMise() ||
      detectAsdf() ||
      (await detectPacman()) ||
      (await detectDeb()) ||
      (await detectRpm()) ||
      (await detectApk())
    ) {
      return 'package-manager'
    }
    // 捆绑模式但非包管理器安装，视为原生安装
    return 'native'
  }

  // 检测是否从本地 npm 安装目录运行
  if (isRunningFromLocalInstallation()) {
    return 'npm-local'
  }

  // 检查调用路径是否包含已知的 npm 全局安装目录
  const npmGlobalPaths = [
    '/usr/local/lib/node_modules',
    '/usr/lib/node_modules',
    '/opt/homebrew/lib/node_modules',
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/.nvm/versions/node/', // nvm 管理的 Node.js 安装路径
  ]

  if (npmGlobalPaths.some(path => invokedPath.includes(path))) {
    return 'npm-global'
  }

  // 路径包含 /npm/ 或 /nvm/ 也视为全局安装
  if (invokedPath.includes('/npm/') || invokedPath.includes('/nvm/')) {
    return 'npm-global'
  }

  // 通过 npm config 获取全局前缀，与调用路径比对
  const npmConfigResult = await execa('npm config get prefix', {
    shell: true,
    reject: false,
  })
  const globalPrefix =
    npmConfigResult.exitCode === 0 ? npmConfigResult.stdout.trim() : null

  if (globalPrefix && invokedPath.startsWith(globalPrefix)) {
    return 'npm-global'
  }

  // 无法判断时返回 unknown
  return 'unknown'
}

/**
 * 获取 Claude Code 的安装路径字符串。
 *
 * 【流程说明】
 * 1. 开发模式：返回当前工作目录
 * 2. 捆绑模式：依次尝试 realpath(execPath)、which('claude')、~/.local/bin/claude
 * 3. npm 安装：返回 process.argv[0]（Node.js 可执行路径）
 * 4. 任何步骤抛出异常时返回 'unknown'
 */
async function getInstallationPath(): Promise<string> {
  // 开发模式返回当前工作目录
  if (process.env.NODE_ENV === 'development') {
    return getCwd()
  }

  // 捆绑/原生模式：尝试多种方式定位实际二进制文件
  if (isInBundledMode()) {
    try {
      // 优先通过 realpath 解析符号链接，获取真实路径
      return await realpath(process.execPath)
    } catch {
      // 解析失败，继续尝试其他方式
    }

    try {
      // 通过 PATH 查找 claude 命令的位置
      const path = await which('claude')
      if (path) {
        return path
      }
    } catch {
      // 查找失败，继续尝试
    }

    // 检查常见的原生安装位置 ~/.local/bin/claude
    try {
      await getFsImplementation().stat(join(homedir(), '.local/bin/claude'))
      return join(homedir(), '.local/bin/claude')
    } catch {
      // 不存在，返回占位符
    }
    return 'native'
  }

  // npm 安装：返回 Node.js 可执行路径
  try {
    return process.argv[0] || 'unknown'
  } catch {
    return 'unknown'
  }
}

/**
 * 获取实际调用的二进制文件路径。
 *
 * 【流程说明】
 * - 捆绑模式：返回 process.execPath（编译后的可执行文件）
 * - npm/开发模式：返回 process.argv[1]（JavaScript 入口脚本路径）
 */
export function getInvokedBinary(): string {
  try {
    // 捆绑/编译可执行文件：使用 execPath
    if (isInBundledMode()) {
      return process.execPath || 'unknown'
    }

    // npm/开发模式：使用脚本路径
    return process.argv[1] || 'unknown'
  } catch {
    return 'unknown'
  }
}

/**
 * 扫描系统中存在的多个 Claude Code 安装实例。
 *
 * 【流程说明】
 * 1. 检测本地安装（~/.claude/local）
 * 2. 检测全局 npm 安装：先查 bin/claude 符号链接，再检查孤立包目录
 * 3. 检测原生安装（~/.local/bin/claude）
 * 4. Homebrew 安装时跳过 npm 全局路径（避免重复计数）
 * 5. 返回所有发现的安装实例数组
 */
async function detectMultipleInstallations(): Promise<
  Array<{ type: string; path: string }>
> {
  const fs = getFsImplementation()
  const installations: Array<{ type: string; path: string }> = []

  // 检测本地安装（~/.claude/local 目录）
  const localPath = join(homedir(), '.claude', 'local')
  if (await localInstallationExists()) {
    installations.push({ type: 'npm-local', path: localPath })
  }

  // 检测 npm 全局安装
  const packagesToCheck = ['@anthropic-ai/claude-code']
  // 如果有自定义包名（非默认），也加入检测列表
  if (MACRO.PACKAGE_URL && MACRO.PACKAGE_URL !== '@anthropic-ai/claude-code') {
    packagesToCheck.push(MACRO.PACKAGE_URL)
  }
  // 获取 npm 全局安装前缀
  const npmResult = await execFileNoThrow('npm', [
    '-g',
    'config',
    'get',
    'prefix',
  ])
  if (npmResult.code === 0 && npmResult.stdout) {
    const npmPrefix = npmResult.stdout.trim()
    const isWindows = getPlatform() === 'windows'

    // Linux/macOS：prefix/bin/claude；Windows：prefix/claude
    const globalBinPath = isWindows
      ? join(npmPrefix, 'claude')
      : join(npmPrefix, 'bin', 'claude')

    let globalBinExists = false
    try {
      await fs.stat(globalBinPath)
      globalBinExists = true
    } catch {
      // 全局二进制不存在
    }

    if (globalBinExists) {
      // 检查是否为 Homebrew Cask 安装（通过符号链接目标路径中的 Caskroom 判断）
      let isCurrentHomebrewInstallation = false

      try {
        // 解析符号链接的真实路径
        const realPath = await realpath(globalBinPath)

        // 若目标路径含 /Caskroom/，且当前进程也是 Homebrew 安装，则跳过
        if (realPath.includes('/Caskroom/')) {
          isCurrentHomebrewInstallation = detectHomebrew()
        }
      } catch {
        // 无法解析符号链接，仍然计入安装列表
      }

      if (!isCurrentHomebrewInstallation) {
        installations.push({ type: 'npm-global', path: globalBinPath })
      }
    } else {
      // bin/claude 不存在，检查孤立包目录（有包但无符号链接）
      for (const packageName of packagesToCheck) {
        const globalPackagePath = isWindows
          ? join(npmPrefix, 'node_modules', packageName)
          : join(npmPrefix, 'lib', 'node_modules', packageName)

        try {
          await fs.stat(globalPackagePath)
          installations.push({
            type: 'npm-global-orphan',
            path: globalPackagePath,
          })
        } catch {
          // 包不存在
        }
      }
    }
  }

  // 检测原生安装（~/.local/bin/claude）
  const nativeBinPath = join(homedir(), '.local', 'bin', 'claude')
  try {
    await fs.stat(nativeBinPath)
    installations.push({ type: 'native', path: nativeBinPath })
  } catch {
    // 原生二进制不存在
  }

  // 如果配置文件显示为 native 安装，额外检查数据目录
  const config = getGlobalConfig()
  if (config.installMethod === 'native') {
    const nativeDataPath = join(homedir(), '.local', 'share', 'claude')
    try {
      await fs.stat(nativeDataPath)
      // 避免重复添加 native 安装条目
      if (!installations.some(i => i.type === 'native')) {
        installations.push({ type: 'native', path: nativeDataPath })
      }
    } catch {
      // 数据目录不存在
    }
  }

  return installations
}

/**
 * 检测安装配置问题并生成警告列表。
 *
 * 【流程说明】
 * 1. 读取 managed-settings.json，检测 strictPluginOnlyCustomization 字段合法性
 * 2. 开发模式：仅返回上述托管设置警告，跳过其他检测
 * 3. native 安装：检测 ~/.local/bin 是否在 PATH 中（Windows/Unix 分别处理）
 * 4. 安装类型与配置文件记录的 installMethod 不匹配时生成警告
 * 5. 本地安装不可通过 PATH 访问且无有效 alias 时生成警告
 *
 * @param type  当前检测到的安装类型
 */
async function detectConfigurationIssues(
  type: InstallationType,
): Promise<Array<{ issue: string; fix: string }>> {
  const warnings: Array<{ issue: string; fix: string }> = []

  // 检测 managed-settings.json 中 strictPluginOnlyCustomization 的合法性
  // schema 的 .catch() 会静默丢弃非法值，但管理员需要知晓配置问题
  try {
    const raw = await readFile(
      join(getManagedFilePath(), 'managed-settings.json'),
      'utf-8',
    )
    const parsed: unknown = jsonParse(raw)
    const field =
      parsed && typeof parsed === 'object'
        ? (parsed as Record<string, unknown>).strictPluginOnlyCustomization
        : undefined
    if (field !== undefined && typeof field !== 'boolean') {
      if (!Array.isArray(field)) {
        // 字段存在但既非布尔值也非数组，属于无效配置
        warnings.push({
          issue: `managed-settings.json: strictPluginOnlyCustomization has an invalid value (expected true or an array, got ${typeof field})`,
          fix: `The field is silently ignored (schema .catch rescues it). Set it to true, or an array of: ${CUSTOMIZATION_SURFACES.join(', ')}.`,
        })
      } else {
        // 数组类型：检测是否包含当前版本不识别的枚举值（前向兼容性问题）
        const unknown = field.filter(
          x =>
            typeof x === 'string' &&
            !(CUSTOMIZATION_SURFACES as readonly string[]).includes(x),
        )
        if (unknown.length > 0) {
          warnings.push({
            issue: `managed-settings.json: strictPluginOnlyCustomization has ${unknown.length} value(s) this client doesn't recognize: ${unknown.map(String).join(', ')}`,
            fix: `These are silently ignored (forwards-compat). Known surfaces for this version: ${CUSTOMIZATION_SURFACES.join(', ')}. Either remove them, or this client is older than the managed-settings intended.`,
          })
        }
      }
    }
  } catch {
    // ENOENT（无托管设置文件）或 JSON 解析错误，由 settings loader 处理，此处跳过
  }

  const config = getGlobalConfig()

  // 开发模式：只返回托管设置警告，跳过安装路径相关检测
  if (type === 'development') {
    return warnings
  }

  // native 安装：检测 ~/.local/bin 是否在 PATH 中
  if (type === 'native') {
    const path = process.env.PATH || ''
    const pathDirectories = path.split(delimiter)
    const homeDir = homedir()
    const localBinPath = join(homeDir, '.local', 'bin')

    // Windows 上将路径分隔符统一为正斜杠
    let normalizedLocalBinPath = localBinPath
    if (getPlatform() === 'windows') {
      normalizedLocalBinPath = localBinPath.split(win32.sep).join(posix.sep)
    }

    // 检查 PATH 中是否包含 ~/.local/bin（支持展开和未展开两种形式，忽略尾部斜杠）
    const localBinInPath = pathDirectories.some(dir => {
      let normalizedDir = dir
      if (getPlatform() === 'windows') {
        normalizedDir = dir.split(win32.sep).join(posix.sep)
      }
      // 去除尾部斜杠后比较（用户 PATH 中可能有 /home/user/.local/bin/）
      const trimmedDir = normalizedDir.replace(/\/+$/, '')
      const trimmedRawDir = dir.replace(/[/\\]+$/, '')
      return (
        trimmedDir === normalizedLocalBinPath ||
        trimmedRawDir === '~/.local/bin' ||
        trimmedRawDir === '$HOME/.local/bin'
      )
    })

    if (!localBinInPath) {
      const isWindows = getPlatform() === 'windows'
      if (isWindows) {
        // Windows：提示通过系统属性界面添加 PATH
        const windowsLocalBinPath = localBinPath
          .split(posix.sep)
          .join(win32.sep)
        warnings.push({
          issue: `Native installation exists but ${windowsLocalBinPath} is not in your PATH`,
          fix: `Add it by opening: System Properties → Environment Variables → Edit User PATH → New → Add the path above. Then restart your terminal.`,
        })
      } else {
        // Unix：提示通过 shell 配置文件添加 PATH
        const shellType = getShellType()
        const configPaths = getShellConfigPaths()
        const configFile = configPaths[shellType as keyof typeof configPaths]
        const displayPath = configFile
          ? configFile.replace(homedir(), '~')
          : 'your shell config file'

        warnings.push({
          issue:
            'Native installation exists but ~/.local/bin is not in your PATH',
          fix: `Run: echo 'export PATH="$HOME/.local/bin:$PATH"' >> ${displayPath} then open a new terminal or run: source ${displayPath}`,
        })
      }
    }
  }

  // 检测安装类型与配置文件记录的 installMethod 是否匹配
  // DISABLE_INSTALLATION_CHECKS 环境变量可跳过此检测（如 HFI 环境）
  if (!isEnvTruthy(process.env.DISABLE_INSTALLATION_CHECKS)) {
    if (type === 'npm-local' && config.installMethod !== 'local') {
      warnings.push({
        issue: `Running from local installation but config install method is '${config.installMethod}'`,
        fix: 'Consider using native installation: claude install',
      })
    }

    if (type === 'native' && config.installMethod !== 'native') {
      warnings.push({
        issue: `Running native installation but config install method is '${config.installMethod}'`,
        fix: 'Run claude install to update configuration',
      })
    }
  }

  // npm 全局安装时若本地安装也存在，提示迁移到原生安装
  if (type === 'npm-global' && (await localInstallationExists())) {
    warnings.push({
      issue: 'Local installation exists but not being used',
      fix: 'Consider using native installation: claude install',
    })
  }

  const existingAlias = await findClaudeAlias()
  const validAlias = await findValidClaudeAlias()

  // 本地安装可访问性检测：claude 既不在 PATH 中，也没有有效 alias 时生成警告
  if (type === 'npm-local') {
    const whichResult = await which('claude')
    const claudeInPath = !!whichResult

    // 只有 claude 不在 PATH 且无有效 alias 时才告警
    if (!claudeInPath && !validAlias) {
      if (existingAlias) {
        // alias 指向无效目标
        warnings.push({
          issue: 'Local installation not accessible',
          fix: `Alias exists but points to invalid target: ${existingAlias}. Update alias: alias claude="~/.claude/local/claude"`,
        })
      } else {
        // 完全没有 alias
        warnings.push({
          issue: 'Local installation not accessible',
          fix: 'Create alias: alias claude="~/.claude/local/claude"',
        })
      }
    }
  }

  return warnings
}

/**
 * 检测 Linux 平台下沙箱权限规则中的 glob 模式兼容性警告。
 *
 * 【流程说明】
 * 1. 非 Linux 平台直接返回空数组
 * 2. 调用 SandboxManager.getLinuxGlobPatternWarnings() 获取存在问题的 glob 模式
 * 3. 最多展示前 3 个模式，超出部分以数量表示
 */
export function detectLinuxGlobPatternWarnings(): Array<{
  issue: string
  fix: string
}> {
  // 非 Linux 平台无需检测
  if (getPlatform() !== 'linux') {
    return []
  }

  const warnings: Array<{ issue: string; fix: string }> = []
  // 获取沙箱权限规则中存在兼容性问题的 glob 模式列表
  const globPatterns = SandboxManager.getLinuxGlobPatternWarnings()

  if (globPatterns.length > 0) {
    // 最多展示前 3 个模式，超出部分以 (N more) 形式提示
    const displayPatterns = globPatterns.slice(0, 3).join(', ')
    const remaining = globPatterns.length - 3
    const patternList =
      remaining > 0 ? `${displayPatterns} (${remaining} more)` : displayPatterns

    warnings.push({
      issue: `Glob patterns in sandbox permission rules are not fully supported on Linux`,
      fix: `Found ${globPatterns.length} pattern(s): ${patternList}. On Linux, glob patterns in Edit/Read rules will be ignored.`,
    })
  }

  return warnings
}

/**
 * 汇总所有诊断信息，生成完整的 DiagnosticInfo 对象。
 *
 * 【流程说明】
 * 1. 并行获取安装类型、安装路径、多重安装情况、配置告警
 * 2. 追加 Linux glob 模式警告
 * 3. native 安装时，将残留的 npm 安装条目转化为警告（附带卸载命令）
 * 4. 全局 npm 安装时检测更新权限
 * 5. 获取 ripgrep 状态和包管理器信息
 * 6. 组装 DiagnosticInfo 并返回
 */
export async function getDoctorDiagnostic(): Promise<DiagnosticInfo> {
  // 并行获取安装类型
  const installationType = await getCurrentInstallationType()
  // 从构建宏获取版本号，若不可用则返回 'unknown'
  const version =
    typeof MACRO !== 'undefined' && MACRO.VERSION ? MACRO.VERSION : 'unknown'
  const installationPath = await getInstallationPath()
  const invokedBinary = getInvokedBinary()
  const multipleInstallations = await detectMultipleInstallations()
  const warnings = await detectConfigurationIssues(installationType)

  // 追加 Linux 沙箱 glob 模式兼容性警告
  warnings.push(...detectLinuxGlobPatternWarnings())

  // native 安装时，对残留的 npm 安装生成带卸载命令的警告
  if (installationType === 'native') {
    const npmInstalls = multipleInstallations.filter(
      i =>
        i.type === 'npm-global' ||
        i.type === 'npm-global-orphan' ||
        i.type === 'npm-local',
    )

    const isWindows = getPlatform() === 'windows'

    for (const install of npmInstalls) {
      if (install.type === 'npm-global') {
        // 全局 npm 安装：提供 npm -g uninstall 命令
        let uninstallCmd = 'npm -g uninstall @anthropic-ai/claude-code'
        if (
          MACRO.PACKAGE_URL &&
          MACRO.PACKAGE_URL !== '@anthropic-ai/claude-code'
        ) {
          uninstallCmd += ` && npm -g uninstall ${MACRO.PACKAGE_URL}`
        }
        warnings.push({
          issue: `Leftover npm global installation at ${install.path}`,
          fix: `Run: ${uninstallCmd}`,
        })
      } else if (install.type === 'npm-global-orphan') {
        // 孤立包（有 node_modules 但无 bin/claude）：提供 rm -rf 命令
        warnings.push({
          issue: `Orphaned npm global package at ${install.path}`,
          fix: isWindows
            ? `Run: rmdir /s /q "${install.path}"`
            : `Run: rm -rf ${install.path}`,
        })
      } else if (install.type === 'npm-local') {
        // 残留的本地安装：提供 rm -rf 命令
        warnings.push({
          issue: `Leftover npm local installation at ${install.path}`,
          fix: isWindows
            ? `Run: rmdir /s /q "${install.path}"`
            : `Run: rm -rf ${install.path}`,
        })
      }
    }
  }

  const config = getGlobalConfig()

  // 获取配置文件中记录的安装方式，未设置时显示 'not set'
  const configInstallMethod = config.installMethod || 'not set'

  // npm 全局安装时检查是否有全局更新权限
  let hasUpdatePermissions: boolean | null = null
  if (installationType === 'npm-global') {
    const permCheck = await checkGlobalInstallPermissions()
    hasUpdatePermissions = permCheck.hasPermissions

    // 无权限且自动更新未被其他原因禁用时，生成权限警告
    if (!hasUpdatePermissions && !getAutoUpdaterDisabledReason()) {
      warnings.push({
        issue: 'Insufficient permissions for auto-updates',
        fix: 'Do one of: (1) Re-install node without sudo, or (2) Use `claude install` for native installation',
      })
    }
  }

  // 获取 ripgrep 状态（工作中/模式/系统路径）
  const ripgrepStatusRaw = getRipgrepStatus()

  const ripgrepStatus = {
    working: ripgrepStatusRaw.working ?? true, // 若尚未测试，默认假设可用
    mode: ripgrepStatusRaw.mode,
    systemPath:
      ripgrepStatusRaw.mode === 'system' ? ripgrepStatusRaw.path : null,
  }

  // 包管理器安装时获取具体的包管理器名称
  const packageManager =
    installationType === 'package-manager'
      ? await getPackageManager()
      : undefined

  // 组装最终的诊断信息对象
  const diagnostic: DiagnosticInfo = {
    installationType,
    version,
    installationPath,
    invokedBinary,
    configInstallMethod,
    // 格式化自动更新状态：禁用时附带原因
    autoUpdates: (() => {
      const reason = getAutoUpdaterDisabledReason()
      return reason
        ? `disabled (${formatAutoUpdaterDisabledReason(reason)})`
        : 'enabled'
    })(),
    hasUpdatePermissions,
    multipleInstallations,
    warnings,
    packageManager,
    ripgrepStatus,
  }

  return diagnostic
}
