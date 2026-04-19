/**
 * iTerm2 配置备份恢复模块
 *
 * 【在 Claude Code 系统流程中的位置】
 * 本模块处于 Claude Code 启动流程（Bootstrap）与系统集成层之间，专门处理
 * iTerm2 终端集成功能的配置安全问题。当 Claude Code 为 iTerm2 设置集成配置
 * （如启用 Shell Integration、自定义颜色方案等）时，会先备份原始 plist 文件；
 * 若设置过程被意外中断（进程崩溃、强制退出），下次启动时本模块会自动检测并
 * 恢复备份，防止用户的 iTerm2 配置被损坏。
 *
 * 【主要功能】
 * 1. markITerm2SetupComplete：在全局配置中标记 iTerm2 设置流程已完成，
 *    清除恢复标志，防止下次启动时错误地触发恢复逻辑；
 * 2. getIterm2RecoveryInfo：从全局配置中读取恢复所需的信息；
 * 3. getITerm2PlistPath：返回 iTerm2 偏好设置文件的标准路径；
 * 4. checkAndRestoreITerm2Backup：核心入口，检测并恢复受损的 iTerm2 配置。
 */

import { copyFile, stat } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import { getGlobalConfig, saveGlobalConfig } from './config.js'
import { logError } from './log.js'

/**
 * 在全局配置中标记 iTerm2 设置流程已安全完成。
 * 将 iterm2SetupInProgress 标志置为 false，防止下次启动时
 * 误判为设置中断并错误地执行恢复操作。
 */
export function markITerm2SetupComplete(): void {
  saveGlobalConfig(current => ({
    ...current,
    iterm2SetupInProgress: false, // 清除"设置进行中"标志
  }))
}

/**
 * 从全局配置中读取 iTerm2 恢复相关信息。
 * 返回设置是否正在进行（inProgress）以及备份文件路径（backupPath）。
 * 若从未设置过，inProgress 默认为 false，backupPath 默认为 null。
 */
function getIterm2RecoveryInfo(): {
  inProgress: boolean
  backupPath: string | null
} {
  const config = getGlobalConfig()
  return {
    // ?? false：若配置项不存在，默认视为未在进行中
    inProgress: config.iterm2SetupInProgress ?? false,
    // || null：空字符串也视为无备份路径
    backupPath: config.iterm2BackupPath || null,
  }
}

/**
 * 获取 iTerm2 偏好设置文件（plist）的标准路径。
 * 路径格式：~/Library/Preferences/com.googlecode.iterm2.plist
 * 该路径在 macOS 上是固定的，不受用户配置影响。
 */
function getITerm2PlistPath(): string {
  return join(
    homedir(),
    'Library',
    'Preferences',
    'com.googlecode.iterm2.plist',
  )
}

/**
 * 恢复操作的结果类型（判别联合类型）。
 * - 'restored'：备份成功恢复，iTerm2 配置已还原；
 * - 'no_backup'：没有需要恢复的备份（正常情况）；
 * - 'failed'：恢复尝试失败，需要用户手动操作（附带备份路径供用户参考）。
 */
type RestoreResult =
  | {
      status: 'restored' | 'no_backup'
    }
  | {
      status: 'failed'
      backupPath: string  // 备份文件路径，供用户手动恢复参考
    }

/**
 * 检测上次启动是否有未完成的 iTerm2 设置流程，并在必要时自动恢复备份。
 *
 * 【检测与恢复流程】
 * 1. 读取全局配置，检查 iterm2SetupInProgress 标志；
 *    若为 false，说明上次设置已正常完成，直接返回 'no_backup'；
 * 2. 若 inProgress 为 true 但没有备份路径，说明设置在创建备份前就中断了，
 *    标记完成并返回 'no_backup'（无需恢复）；
 * 3. 若有备份路径，检查备份文件是否存在（stat）；
 *    若不存在，标记完成并返回 'no_backup'（备份已被清理）；
 * 4. 尝试将备份文件复制回 iTerm2 plist 路径（覆盖被修改的配置）；
 *    成功则标记完成并返回 'restored'；
 *    失败则标记完成并返回 'failed'（附带备份路径）。
 *
 * 注意：无论恢复成功与否，最终都会调用 markITerm2SetupComplete() 清除标志，
 * 防止无限重试。
 */
export async function checkAndRestoreITerm2Backup(): Promise<RestoreResult> {
  const { inProgress, backupPath } = getIterm2RecoveryInfo()

  // 设置流程已正常完成，无需恢复
  if (!inProgress) {
    return { status: 'no_backup' }
  }

  // 有进行中标志但无备份路径（设置在备份前中断），清除标志
  if (!backupPath) {
    markITerm2SetupComplete()
    return { status: 'no_backup' }
  }

  // 检查备份文件是否真实存在
  try {
    await stat(backupPath)
  } catch {
    // 备份文件不存在（可能已被手动删除或路径变更）
    markITerm2SetupComplete()
    return { status: 'no_backup' }
  }

  // 尝试将备份恢复到 iTerm2 配置文件原路径
  try {
    await copyFile(backupPath, getITerm2PlistPath())

    // 恢复成功，清除"进行中"标志
    markITerm2SetupComplete()
    return { status: 'restored' }
  } catch (restoreError) {
    // 恢复失败（权限问题、磁盘错误等），记录错误并通知调用方
    logError(
      new Error(`Failed to restore iTerm2 settings with: ${restoreError}`),
    )
    // 即使恢复失败也要清除标志，防止无限重试
    markITerm2SetupComplete()
    return { status: 'failed', backupPath }
  }
}
