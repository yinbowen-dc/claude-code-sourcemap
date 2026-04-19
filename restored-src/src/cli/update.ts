/**
 * 自更新命令 — 实现 `claude update` 命令，负责将 Claude Code 更新到最新版本。
 *
 * 在整个 Claude Code 系统中的位置：
 * 本文件是 CLI 层的自更新入口，支持四种安装类型的更新路径：
 *   - native       — 使用原生安装器（nativeInstaller）更新预编译二进制
 *   - npm-local    — 使用本地 npm 安装器（localInstaller）更新本地 node_modules
 *   - npm-global   — 使用全局 npm 安装器（autoUpdater）更新全局包
 *   - package-manager — Homebrew/winget/apk 等系统包管理器，提示用户手动更新
 *   - development  — 开发构建，禁止自动更新
 *
 * 更新前会运行诊断（getDoctorDiagnostic）检测安装类型、多重安装、配置不一致等问题，
 * 并在更新成功后重新生成 shell 补全缓存。
 */
import chalk from 'chalk'
import { logEvent } from 'src/services/analytics/index.js'
import {
  getLatestVersion,
  type InstallStatus,
  installGlobalPackage,
} from 'src/utils/autoUpdater.js'
import { regenerateCompletionCache } from 'src/utils/completionCache.js'
import {
  getGlobalConfig,
  type InstallMethod,
  saveGlobalConfig,
} from 'src/utils/config.js'
import { logForDebugging } from 'src/utils/debug.js'
import { getDoctorDiagnostic } from 'src/utils/doctorDiagnostic.js'
import { gracefulShutdown } from 'src/utils/gracefulShutdown.js'
import {
  installOrUpdateClaudePackage,
  localInstallationExists,
} from 'src/utils/localInstaller.js'
import {
  installLatest as installLatestNative,
  removeInstalledSymlink,
} from 'src/utils/nativeInstaller/index.js'
import { getPackageManager } from 'src/utils/nativeInstaller/packageManagers.js'
import { writeToStdout } from 'src/utils/process.js'
import { gte } from 'src/utils/semver.js'
import { getInitialSettings } from 'src/utils/settings/settings.js'

/**
 * `claude update` 命令的主处理函数。
 *
 * 流程：
 * 1. 上报分析事件，打印当前版本和目标 channel（latest/stable）。
 * 2. 运行 getDoctorDiagnostic 获取安装类型、配置方法、多重安装和告警信息。
 * 3. 如有多重安装，打印告警列表（注明哪个是当前运行的）。
 * 4. 如有诊断告警，打印 Warning 和 Fix 提示（PATH 相关告警始终显示）。
 * 5. 若 config.installMethod 未设置且非 package-manager，自动检测并写入配置。
 * 6. 开发构建：打印警告并以退出码 1 终止。
 * 7. 包管理器安装（homebrew/winget/apk/其他）：检查是否有新版本，打印对应更新命令，退出 0。
 * 8. 检查 config/reality 不一致：若当前运行类型与配置不符，更新配置以匹配实际。
 * 9. native 安装：调用 installLatestNative，处理锁竞争、版本检查、成功提示，退出 0/1。
 * 10. JS/npm 安装（npm-local/npm-global）：
 *     - 移除可能残留的 native symlink。
 *     - 从 npm registry 获取最新版本号。
 *     - 若已是最新版本则退出 0。
 *     - 否则根据安装类型调用对应的 install 函数，处理各种 InstallStatus 后退出。
 */
export async function update() {
  // 上报更新检查事件，用于统计用户更新行为
  logEvent('tengu_update_check', {})
  writeToStdout(`Current version: ${MACRO.VERSION}\n`)

  // 读取 channel 配置（latest 或 stable），默认为 latest
  const channel = getInitialSettings()?.autoUpdatesChannel ?? 'latest'
  writeToStdout(`Checking for updates to ${channel} version...\n`)

  logForDebugging('update: Starting update check')

  // 运行诊断以检测潜在问题：安装类型、配置方法、多重安装、PATH 告警等
  logForDebugging('update: Running diagnostic')
  const diagnostic = await getDoctorDiagnostic()
  logForDebugging(`update: Installation type: ${diagnostic.installationType}`)
  logForDebugging(
    `update: Config install method: ${diagnostic.configInstallMethod}`,
  )

  // 检测到多重安装时，列出所有安装路径并标注当前正在运行的那个
  if (diagnostic.multipleInstallations.length > 1) {
    writeToStdout('\n')
    writeToStdout(chalk.yellow('Warning: Multiple installations found') + '\n')
    for (const install of diagnostic.multipleInstallations) {
      const current =
        diagnostic.installationType === install.type
          ? ' (currently running)'
          : ''
      writeToStdout(`- ${install.type} at ${install.path}${current}\n`)
    }
  }

  // 输出所有诊断告警；PATH 告警始终显示（告知用户 `which claude` 指向其他位置）
  if (diagnostic.warnings.length > 0) {
    writeToStdout('\n')
    for (const warning of diagnostic.warnings) {
      logForDebugging(`update: Warning detected: ${warning.issue}`)

      // 不跳过 PATH 告警 — 用户需要知道 'which claude' 指向别处
      logForDebugging(`update: Showing warning: ${warning.issue}`)

      writeToStdout(chalk.yellow(`Warning: ${warning.issue}\n`))

      writeToStdout(chalk.bold(`Fix: ${warning.fix}\n`))
    }
  }

  // 若 installMethod 未设置且不是包管理器安装，自动检测并写入全局配置
  const config = getGlobalConfig()
  if (
    !config.installMethod &&
    diagnostic.installationType !== 'package-manager'
  ) {
    writeToStdout('\n')
    writeToStdout('Updating configuration to track installation method...\n')
    let detectedMethod: 'local' | 'native' | 'global' | 'unknown' = 'unknown'

    // 将诊断安装类型映射到配置中使用的安装方法标识
    switch (diagnostic.installationType) {
      case 'npm-local':
        detectedMethod = 'local'
        break
      case 'native':
        detectedMethod = 'native'
        break
      case 'npm-global':
        detectedMethod = 'global'
        break
      default:
        detectedMethod = 'unknown'
    }

    // 将检测到的安装方法持久化到全局配置
    saveGlobalConfig(current => ({
      ...current,
      installMethod: detectedMethod,
    }))
    writeToStdout(`Installation method set to: ${detectedMethod}\n`)
  }

  // 开发构建不支持自动更新，直接报错退出
  if (diagnostic.installationType === 'development') {
    writeToStdout('\n')
    writeToStdout(
      chalk.yellow('Warning: Cannot update development build') + '\n',
    )
    await gracefulShutdown(1)
  }

  // 系统包管理器安装：根据包管理器类型给出对应的手动更新命令
  if (diagnostic.installationType === 'package-manager') {
    const packageManager = await getPackageManager()
    writeToStdout('\n')

    if (packageManager === 'homebrew') {
      writeToStdout('Claude is managed by Homebrew.\n')
      const latest = await getLatestVersion(channel)
      if (latest && !gte(MACRO.VERSION, latest)) {
        writeToStdout(`Update available: ${MACRO.VERSION} → ${latest}\n`)
        writeToStdout('\n')
        writeToStdout('To update, run:\n')
        // 给出 Homebrew 更新命令
        writeToStdout(chalk.bold('  brew upgrade claude-code') + '\n')
      } else {
        writeToStdout('Claude is up to date!\n')
      }
    } else if (packageManager === 'winget') {
      writeToStdout('Claude is managed by winget.\n')
      const latest = await getLatestVersion(channel)
      if (latest && !gte(MACRO.VERSION, latest)) {
        writeToStdout(`Update available: ${MACRO.VERSION} → ${latest}\n`)
        writeToStdout('\n')
        writeToStdout('To update, run:\n')
        // 给出 winget 更新命令
        writeToStdout(
          chalk.bold('  winget upgrade Anthropic.ClaudeCode') + '\n',
        )
      } else {
        writeToStdout('Claude is up to date!\n')
      }
    } else if (packageManager === 'apk') {
      writeToStdout('Claude is managed by apk.\n')
      const latest = await getLatestVersion(channel)
      if (latest && !gte(MACRO.VERSION, latest)) {
        writeToStdout(`Update available: ${MACRO.VERSION} → ${latest}\n`)
        writeToStdout('\n')
        writeToStdout('To update, run:\n')
        // 给出 apk 更新命令
        writeToStdout(chalk.bold('  apk upgrade claude-code') + '\n')
      } else {
        writeToStdout('Claude is up to date!\n')
      }
    } else {
      // pacman、deb、rpm 等包管理器各有多个前端（yay/paru、apt/apt-get、dnf/yum 等），
      // 无法给出统一命令，只提示用户使用自己的包管理器更新
      writeToStdout('Claude is managed by a package manager.\n')
      writeToStdout('Please use your package manager to update.\n')
    }

    await gracefulShutdown(0)
  }

  // 检查配置与实际安装类型是否一致（跳过包管理器安装）
  if (
    config.installMethod &&
    diagnostic.configInstallMethod !== 'not set' &&
    diagnostic.installationType !== 'package-manager'
  ) {
    const runningType = diagnostic.installationType
    const configExpects = diagnostic.configInstallMethod

    // 将诊断安装类型规范化为配置中使用的短名称，便于比较
    const typeMapping: Record<string, string> = {
      'npm-local': 'local',
      'npm-global': 'global',
      native: 'native',
      development: 'development',
      unknown: 'unknown',
    }

    const normalizedRunningType = typeMapping[runningType] || runningType

    if (
      normalizedRunningType !== configExpects &&
      configExpects !== 'unknown'  // unknown 不做不一致处理，避免误报
    ) {
      writeToStdout('\n')
      writeToStdout(chalk.yellow('Warning: Configuration mismatch') + '\n')
      writeToStdout(`Config expects: ${configExpects} installation\n`)
      writeToStdout(`Currently running: ${runningType}\n`)
      writeToStdout(
        chalk.yellow(
          `Updating the ${runningType} installation you are currently using`,
        ) + '\n',
      )

      // 将配置更新为与实际运行类型一致，避免后续更新走错路径
      saveGlobalConfig(current => ({
        ...current,
        installMethod: normalizedRunningType as InstallMethod,
      }))
      writeToStdout(
        `Config updated to reflect current installation method: ${normalizedRunningType}\n`,
      )
    }
  }

  // native 安装：优先使用原生更新器（绕过 npm）
  if (diagnostic.installationType === 'native') {
    logForDebugging(
      'update: Detected native installation, using native updater',
    )
    try {
      // 发起原生更新，传入 channel 和 verbose=true
      const result = await installLatestNative(channel, true)

      // 处理锁竞争：另一个 Claude 进程正在更新时，优雅地等待
      if (result.lockFailed) {
        const pidInfo = result.lockHolderPid
          ? ` (PID ${result.lockHolderPid})`
          : ''
        writeToStdout(
          chalk.yellow(
            `Another Claude process${pidInfo} is currently running. Please try again in a moment.`,
          ) + '\n',
        )
        await gracefulShutdown(0)
      }

      // 获取最新版本失败则报错退出
      if (!result.latestVersion) {
        process.stderr.write('Failed to check for updates\n')
        await gracefulShutdown(1)
      }

      if (result.latestVersion === MACRO.VERSION) {
        // 已是最新版本
        writeToStdout(
          chalk.green(`Claude Code is up to date (${MACRO.VERSION})`) + '\n',
        )
      } else {
        // 更新成功，打印版本变更信息并重新生成补全缓存
        writeToStdout(
          chalk.green(
            `Successfully updated from ${MACRO.VERSION} to version ${result.latestVersion}`,
          ) + '\n',
        )
        await regenerateCompletionCache()
      }
      await gracefulShutdown(0)
    } catch (error) {
      process.stderr.write('Error: Failed to install native update\n')
      process.stderr.write(String(error) + '\n')
      process.stderr.write('Try running "claude doctor" for diagnostics\n')
      await gracefulShutdown(1)
    }
  }

  // 回退到 JS/npm 更新逻辑
  // 若当前不是 native 安装，移除可能残留的 native 安装符号链接
  if (config.installMethod !== 'native') {
    await removeInstalledSymlink()
  }

  logForDebugging('update: Checking npm registry for latest version')
  logForDebugging(`update: Package URL: ${MACRO.PACKAGE_URL}`)
  // stable channel 使用 npm tag "stable"，其他使用 "latest"
  const npmTag = channel === 'stable' ? 'stable' : 'latest'
  const npmCommand = `npm view ${MACRO.PACKAGE_URL}@${npmTag} version`
  logForDebugging(`update: Running: ${npmCommand}`)
  // 从 npm registry 获取最新版本号
  const latestVersion = await getLatestVersion(channel)
  logForDebugging(
    `update: Latest version from npm: ${latestVersion || 'FAILED'}`,
  )

  if (!latestVersion) {
    // 无法从 npm registry 获取版本时，给出详细的排查提示
    logForDebugging('update: Failed to get latest version from npm registry')
    process.stderr.write(chalk.red('Failed to check for updates') + '\n')
    process.stderr.write('Unable to fetch latest version from npm registry\n')
    process.stderr.write('\n')
    process.stderr.write('Possible causes:\n')
    process.stderr.write('  • Network connectivity issues\n')
    process.stderr.write('  • npm registry is unreachable\n')
    process.stderr.write('  • Corporate proxy/firewall blocking npm\n')
    if (MACRO.PACKAGE_URL && !MACRO.PACKAGE_URL.startsWith('@anthropic')) {
      process.stderr.write(
        '  • Internal/development build not published to npm\n',
      )
    }
    process.stderr.write('\n')
    process.stderr.write('Try:\n')
    process.stderr.write('  • Check your internet connection\n')
    process.stderr.write('  • Run with --debug flag for more details\n')
    const packageName =
      MACRO.PACKAGE_URL ||
      (process.env.USER_TYPE === 'ant'
        ? '@anthropic-ai/claude-cli'
        : '@anthropic-ai/claude-code')
    process.stderr.write(
      `  • Manually check: npm view ${packageName} version\n`,
    )

    process.stderr.write('  • Check if you need to login: npm whoami\n')
    await gracefulShutdown(1)
  }

  // 版本完全匹配（含构建元数据如 SHA）时视为已是最新版本
  if (latestVersion === MACRO.VERSION) {
    writeToStdout(
      chalk.green(`Claude Code is up to date (${MACRO.VERSION})`) + '\n',
    )
    await gracefulShutdown(0)
  }

  writeToStdout(
    `New version available: ${latestVersion} (current: ${MACRO.VERSION})\n`,
  )
  writeToStdout('Installing update...\n')

  // 根据当前实际运行的安装类型决定更新方式
  let useLocalUpdate = false
  let updateMethodName = ''

  switch (diagnostic.installationType) {
    case 'npm-local':
      // 本地安装：使用 installOrUpdateClaudePackage 更新 ~/.claude/local 下的包
      useLocalUpdate = true
      updateMethodName = 'local'
      break
    case 'npm-global':
      // 全局安装：使用 installGlobalPackage 更新全局 npm 包
      useLocalUpdate = false
      updateMethodName = 'global'
      break
    case 'unknown': {
      // 无法确定安装类型时，回退到文件系统探测
      const isLocal = await localInstallationExists()
      useLocalUpdate = isLocal
      updateMethodName = isLocal ? 'local' : 'global'
      writeToStdout(
        chalk.yellow('Warning: Could not determine installation type') + '\n',
      )
      writeToStdout(
        `Attempting ${updateMethodName} update based on file detection...\n`,
      )
      break
    }
    default:
      // 其他类型（如 native、development）不走 npm 更新路径，报错退出
      process.stderr.write(
        `Error: Cannot update ${diagnostic.installationType} installation\n`,
      )
      await gracefulShutdown(1)
  }

  writeToStdout(`Using ${updateMethodName} installation update method...\n`)

  logForDebugging(`update: Update method determined: ${updateMethodName}`)
  logForDebugging(`update: useLocalUpdate: ${useLocalUpdate}`)

  let status: InstallStatus

  if (useLocalUpdate) {
    logForDebugging(
      'update: Calling installOrUpdateClaudePackage() for local update',
    )
    // 本地安装更新：在 ~/.claude/local 目录执行 npm install
    status = await installOrUpdateClaudePackage(channel)
  } else {
    logForDebugging('update: Calling installGlobalPackage() for global update')
    // 全局安装更新：执行 npm install -g
    status = await installGlobalPackage()
  }

  logForDebugging(`update: Installation status: ${status}`)

  // 根据安装状态输出对应的成功/失败信息
  switch (status) {
    case 'success':
      // 更新成功：打印版本变更信息，重新生成 shell 补全缓存
      writeToStdout(
        chalk.green(
          `Successfully updated from ${MACRO.VERSION} to version ${latestVersion}`,
        ) + '\n',
      )
      await regenerateCompletionCache()
      break
    case 'no_permissions':
      // 权限不足：给出手动更新命令
      process.stderr.write(
        'Error: Insufficient permissions to install update\n',
      )
      if (useLocalUpdate) {
        process.stderr.write('Try manually updating with:\n')
        process.stderr.write(
          `  cd ~/.claude/local && npm update ${MACRO.PACKAGE_URL}\n`,
        )
      } else {
        process.stderr.write('Try running with sudo or fix npm permissions\n')
        process.stderr.write(
          'Or consider using native installation with: claude install\n',
        )
      }
      await gracefulShutdown(1)
      break
    case 'install_failed':
      // 安装失败：给出手动更新命令或替代方案
      process.stderr.write('Error: Failed to install update\n')
      if (useLocalUpdate) {
        process.stderr.write('Try manually updating with:\n')
        process.stderr.write(
          `  cd ~/.claude/local && npm update ${MACRO.PACKAGE_URL}\n`,
        )
      } else {
        process.stderr.write(
          'Or consider using native installation with: claude install\n',
        )
      }
      await gracefulShutdown(1)
      break
    case 'in_progress':
      // 另一个实例正在执行更新，等待后重试
      process.stderr.write(
        'Error: Another instance is currently performing an update\n',
      )
      process.stderr.write('Please wait and try again later\n')
      await gracefulShutdown(1)
      break
  }
  await gracefulShutdown(0)
}
