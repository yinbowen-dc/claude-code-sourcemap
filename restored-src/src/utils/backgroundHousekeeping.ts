/**
 * 后台定期维护任务模块。
 *
 * 在 Claude Code 系统中，该模块负责在进程启动后异步执行低优先级的后台任务：
 * - 初始化 MagicDocs / AutoDream / SkillImprovement / ExtractMemories 等服务
 * - 自动更新 Marketplace 插件
 * - 注册 deep link 协议（LODESTONE 功能开启时）
 * - 延迟执行清理旧版本文件等慢操作（避免阻塞用户交互）
 * - 对 ant 用户定期每 24 小时清理 npm 缓存和旧版本
 */
import { feature } from 'bun:bundle'
import { initMagicDocs } from '../services/MagicDocs/magicDocs.js'
import { initSkillImprovement } from './hooks/skillImprovement.js'

/* eslint-disable @typescript-eslint/no-require-imports */
const extractMemoriesModule = feature('EXTRACT_MEMORIES')
  ? (require('../services/extractMemories/extractMemories.js') as typeof import('../services/extractMemories/extractMemories.js'))
  : null
const registerProtocolModule = feature('LODESTONE')
  ? (require('./deepLink/registerProtocol.js') as typeof import('./deepLink/registerProtocol.js'))
  : null

/* eslint-enable @typescript-eslint/no-require-imports */

import { getIsInteractive, getLastInteractionTime } from '../bootstrap/state.js'
import {
  cleanupNpmCacheForAnthropicPackages,
  cleanupOldMessageFilesInBackground,
  cleanupOldVersionsThrottled,
} from './cleanup.js'
import { cleanupOldVersions } from './nativeInstaller/index.js'
import { autoUpdateMarketplacesAndPluginsInBackground } from './plugins/pluginAutoupdate.js'

// 24 小时（毫秒），用于 ant 用户 npm 缓存 / 旧版本清理的重复间隔
const RECURRING_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000

// 启动后 10 分钟再执行慢操作，避免与用户交互争用 I/O
const DELAY_VERY_SLOW_OPERATIONS_THAT_HAPPEN_EVERY_SESSION = 10 * 60 * 1000

/**
 * 启动所有后台维护任务。
 * 在进程启动后立即调用：初始化各服务、安排延迟慢操作（10 分钟后执行），
 * 并对 ant 用户设置每 24 小时一次的 npm 缓存 / 旧版本清理定时器。
 * 所有定时器均调用 unref() 以避免阻止进程退出。
 */
export function startBackgroundHousekeeping(): void {
  // 初始化文档智能、技能改进、记忆提取等 AI 辅助服务
  void initMagicDocs()
  void initSkillImprovement()
  if (feature('EXTRACT_MEMORIES')) {
    extractMemoriesModule!.initExtractMemories()
  }
  initAutoDream()
  // 后台自动更新 Marketplace 插件
  void autoUpdateMarketplacesAndPluginsInBackground()
  // 仅在交互式会话中注册 deep link 协议（LODESTONE 功能开关控制）
  if (feature('LODESTONE') && getIsInteractive()) {
    void registerProtocolModule!.ensureDeepLinkProtocolRegistered()
  }

  let needsCleanup = true
  async function runVerySlowOps(): Promise<void> {
    // 若用户在过去 1 分钟内有操作，推迟慢操作执行，避免干扰用户体验
    if (
      getIsInteractive() &&
      getLastInteractionTime() > Date.now() - 1000 * 60
    ) {
      setTimeout(
        runVerySlowOps,
        DELAY_VERY_SLOW_OPERATIONS_THAT_HAPPEN_EVERY_SESSION,
      ).unref()
      return
    }

    if (needsCleanup) {
      needsCleanup = false
      // 清理旧消息文件（仅首次执行）
      await cleanupOldMessageFilesInBackground()
    }

    // 再次检查用户活跃度，若刚发生交互则推迟后续慢操作
    if (
      getIsInteractive() &&
      getLastInteractionTime() > Date.now() - 1000 * 60
    ) {
      setTimeout(
        runVerySlowOps,
        DELAY_VERY_SLOW_OPERATIONS_THAT_HAPPEN_EVERY_SESSION,
      ).unref()
      return
    }

    // 清理原生安装的旧版本二进制文件
    await cleanupOldVersions()
  }

  // 延迟 10 分钟后执行慢操作；unref() 确保定时器不阻止进程自然退出
  setTimeout(
    runVerySlowOps,
    DELAY_VERY_SLOW_OPERATIONS_THAT_HAPPEN_EVERY_SESSION,
  ).unref()

  // 对于长时间运行的会话（ant 用户），每 24 小时触发一次 npm 缓存和旧版本清理。
  // 两个清理函数均使用标记文件和锁，确保每天只执行一次，且在锁竞争时跳过。
  if (process.env.USER_TYPE === 'ant') {
    const interval = setInterval(() => {
      void cleanupNpmCacheForAnthropicPackages()
      void cleanupOldVersionsThrottled()
    }, RECURRING_CLEANUP_INTERVAL_MS)

    // unref() 避免此定时器使进程保持存活状态
    interval.unref()
  }
}
