/**
 * Apple Terminal 偏好设置备份与恢复模块。
 *
 * 在 Claude Code 系统中，当需要修改 Apple Terminal.app 的配色方案或配置时
 * （例如安装深色主题），该模块负责在操作前备份原有偏好设置 plist 文件，
 * 并在安装失败或用户要求时将其恢复。
 *
 * 主要功能：
 * 1. markTerminalSetupInProgress()：在全局配置中记录安装进行中状态及备份路径
 * 2. markTerminalSetupComplete()：清除安装进行中标志
 * 3. backupTerminalPreferences()：导出 Terminal.app 偏好到 .bak 文件
 * 4. checkAndRestoreTerminalBackup()：检查是否存在待恢复的备份并执行还原
 */
import { stat } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import { getGlobalConfig, saveGlobalConfig } from './config.js'
import { execFileNoThrow } from './execFileNoThrow.js'
import { logError } from './log.js'
/** 在全局配置中记录 Terminal 安装进行中状态及备份路径。 */
export function markTerminalSetupInProgress(backupPath: string): void {
  saveGlobalConfig(current => ({
    ...current,
    appleTerminalSetupInProgress: true,
    appleTerminalBackupPath: backupPath,
  }))
}

/** 清除全局配置中的 Terminal 安装进行中标志。 */
export function markTerminalSetupComplete(): void {
  saveGlobalConfig(current => ({
    ...current,
    appleTerminalSetupInProgress: false,
  }))
}

/** 从全局配置中读取 Terminal 恢复信息（安装状态及备份路径）。 */
function getTerminalRecoveryInfo(): {
  inProgress: boolean
  backupPath: string | null
} {
  const config = getGlobalConfig()
  return {
    inProgress: config.appleTerminalSetupInProgress ?? false,
    backupPath: config.appleTerminalBackupPath || null,
  }
}

/** 返回 Terminal.app 偏好设置 plist 文件的完整路径。 */
export function getTerminalPlistPath(): string {
  return join(homedir(), 'Library', 'Preferences', 'com.apple.Terminal.plist')
}

/**
 * 使用 `defaults export` 命令将 Terminal.app 偏好设置导出到 .bak 文件。
 * 成功时标记安装进行中并返回备份路径；失败时返回 null。
 */
export async function backupTerminalPreferences(): Promise<string | null> {
  const terminalPlistPath = getTerminalPlistPath()
  const backupPath = `${terminalPlistPath}.bak`

  try {
    const { code } = await execFileNoThrow('defaults', [
      'export',
      'com.apple.Terminal',
      terminalPlistPath,
    ])

    if (code !== 0) {
      return null
    }

    try {
      await stat(terminalPlistPath)
    } catch {
      return null
    }

    await execFileNoThrow('defaults', [
      'export',
      'com.apple.Terminal',
      backupPath,
    ])

    markTerminalSetupInProgress(backupPath)

    return backupPath
  } catch (error) {
    logError(error)
    return null
  }
}

type RestoreResult =
  | {
      status: 'restored' | 'no_backup'
    }
  | {
      status: 'failed'
      backupPath: string
    }

/**
 * 检查是否存在中断的 Terminal 安装，若存在则使用 `defaults import` 恢复备份。
 * 恢复成功后清除进行中标志；备份不存在或无需恢复时返回 'no_backup'。
 */
export async function checkAndRestoreTerminalBackup(): Promise<RestoreResult> {
  const { inProgress, backupPath } = getTerminalRecoveryInfo()
  if (!inProgress) {
    return { status: 'no_backup' }
  }

  if (!backupPath) {
    markTerminalSetupComplete()
    return { status: 'no_backup' }
  }

  try {
    await stat(backupPath)
  } catch {
    markTerminalSetupComplete()
    return { status: 'no_backup' }
  }

  try {
    const { code } = await execFileNoThrow('defaults', [
      'import',
      'com.apple.Terminal',
      backupPath,
    ])

    if (code !== 0) {
      return { status: 'failed', backupPath }
    }

    await execFileNoThrow('killall', ['cfprefsd'])

    markTerminalSetupComplete()
    return { status: 'restored' }
  } catch (restoreError) {
    logError(
      new Error(
        `Failed to restore Terminal.app settings with: ${restoreError}`,
      ),
    )
    markTerminalSetupComplete()
    return { status: 'failed', backupPath }
  }
}
