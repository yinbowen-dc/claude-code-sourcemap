/**
 * 技能文件变更检测模块（SkillChangeDetector）。
 *
 * 在 Claude Code 系统中，该模块处于以下位置：
 *   应用启动 → skillChangeDetector.initialize()（监控技能目录）
 *   → chokidar 文件监视器（add/change/unlink 事件）
 *   → handleChange() → scheduleReload()（防抖 300ms）
 *   → clearSkillCaches() + clearCommandsCache() + skillsChanged.emit()
 *   → 订阅方（如 UI 组件）接收通知并重新加载技能列表
 *
 * 核心机制：
 * - 使用 chokidar 监视以下目录（深度 2，支持 skill-name/SKILL.md 格式）：
 *   * ~/.claude/skills（用户技能目录）
 *   * ~/.claude/commands（用户命令目录）
 *   * .claude/skills（项目技能目录）
 *   * .claude/commands（项目命令目录）
 *   * --add-dir 附加目录下的 .claude/skills
 * - 防抖（RELOAD_DEBOUNCE_MS = 300ms）：将多个文件变更事件合并为一次重新加载，
 *   防止大批量文件操作（如 git checkout、auto-update）触发大量级联重载，
 *   避免 Bun 事件循环因 FSWatcher 频繁 watch/unwatch 而死锁
 * - Bun 环境下强制使用 stat() 轮询（USE_POLLING）：绕过 Bun 原生 fs.watch() 的死锁 bug
 *   （oven-sh/bun#27469：主线程关闭 watcher 时与文件监视线程的事件投递发生死锁）
 * - 使用 Signal 原语（createSignal）进行订阅/通知，无状态，轻量级
 * - 执行 ConfigChange hook：允许用户通过 hook 阻断技能重载
 *
 * 主要导出：
 * - `initialize()`：启动文件监视（幂等，重复调用无副作用）
 * - `dispose()`：停止文件监视，清理所有状态和监听器
 * - `subscribe`：订阅技能变更通知的函数（来自 skillsChanged.subscribe）
 * - `resetForTesting()`：仅供测试使用，重置所有内部状态
 * - `skillChangeDetector`：整合以上函数的对象
 */

import chokidar, { type FSWatcher } from 'chokidar'
import * as platformPath from 'path'
import { getAdditionalDirectoriesForClaudeMd } from '../../bootstrap/state.js'
import {
  clearCommandMemoizationCaches,
  clearCommandsCache,
} from '../../commands.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js'
import {
  clearSkillCaches,
  getSkillsPath,
  onDynamicSkillsLoaded,
} from '../../skills/loadSkillsDir.js'
import { resetSentSkillNames } from '../attachments.js'
import { registerCleanup } from '../cleanupRegistry.js'
import { logForDebugging } from '../debug.js'
import { getFsImplementation } from '../fsOperations.js'
import { executeConfigChangeHooks, hasBlockingResult } from '../hooks.js'
import { createSignal } from '../signal.js'

/**
 * 文件写入稳定等待时间（毫秒）。
 * chokidar 的 awaitWriteFinish 选项会等待文件内容稳定后再触发事件，
 * 防止编辑器分阶段写入时多次触发。
 */
const FILE_STABILITY_THRESHOLD_MS = 1000

/**
 * 文件稳定性轮询间隔（毫秒）。
 * chokidar 检查文件大小是否稳定的轮询频率。
 */
const FILE_STABILITY_POLL_INTERVAL_MS = 500

/**
 * 技能变更事件防抖延迟（毫秒）。
 *
 * 将快速连续的技能变更事件合并为单次重新加载。
 * 当大量技能文件同时发生变更时（如 auto-update 安装新二进制或另一个会话修改技能目录），
 * 每个文件变更都会触发独立的 chokidar 事件。若无防抖，
 * 每次事件都会触发完整的 clearSkillCaches() + clearCommandsCache() + 监听器通知周期，
 * 30 个事件意味着 30 次完整重载，可能通过 FSWatcher 频繁 watch/unwatch 使 Bun 事件循环死锁。
 */
const RELOAD_DEBOUNCE_MS = 300

/**
 * chokidar 启用轮询时的轮询间隔（毫秒）。
 *
 * 技能文件变更频率低（手动编辑、git 操作），2 秒间隔以极小的延迟代价
 * 大幅减少 stat() 调用次数（相比默认的 100ms）。
 */
const POLLING_INTERVAL_MS = 2000

/**
 * 是否在 Bun 运行时下强制使用 stat() 轮询代替原生 fs.watch()。
 *
 * Bun 原生 fs.watch() 存在 PathWatcherManager 死锁（oven-sh/bun#27469, #26385）：
 * 主线程关闭 watcher 时，若文件监视线程正在投递事件，两个线程可能在 __ulock_wait2 中永久阻塞。
 * 当 chokidar 以 depth: 2 监视包含大量子目录的技能目录时，
 * git 操作同时触碰大量目录会可靠地复现此死锁——chokidar 内部在添加/删除目录时
 * 会关闭并重新打开每个目录的 FSWatcher。
 *
 * 解决方案：在 Bun 下使用 stat() 轮询，无 FSWatcher = 无死锁。
 * 等待上游 Bun PR 合并后移除此 workaround。
 */
const USE_POLLING = typeof Bun !== 'undefined'

// 模块级状态变量
let watcher: FSWatcher | null = null                     // chokidar 文件监视器实例
let reloadTimer: ReturnType<typeof setTimeout> | null = null  // 防抖定时器
const pendingChangedPaths = new Set<string>()            // 待处理的变更路径集合
let initialized = false                                   // 是否已初始化
let disposed = false                                      // 是否已释放
let dynamicSkillsCallbackRegistered = false              // 动态技能回调是否已注册
let unregisterCleanup: (() => void) | null = null        // 取消优雅关闭清理的函数
const skillsChanged = createSignal()                      // 技能变更通知信号

// 测试用时间常量覆盖（仅供 resetForTesting 使用）
let testOverrides: {
  stabilityThreshold?: number
  pollInterval?: number
  reloadDebounce?: number
  /** chokidar 启用 stat() 轮询时的轮询间隔（毫秒） */
  chokidarInterval?: number
} | null = null

/**
 * 初始化技能目录文件监视器。
 *
 * 流程：
 * 1. 幂等检查：若已初始化或已释放，直接返回
 * 2. 注册动态技能加载回调（onDynamicSkillsLoaded），仅注册一次
 * 3. 获取所有可监视路径（用户/项目技能和命令目录，以及附加目录）
 * 4. 创建 chokidar 监视器，监听 add/change/unlink 事件
 * 5. 注册优雅关闭清理回调（cleanupRegistry）
 */
export async function initialize(): Promise<void> {
  // 幂等：重复初始化或在 dispose 后调用直接返回
  if (initialized || disposed) return
  initialized = true

  // 注册动态技能加载回调（仅注册一次，防止多次 initialize 重复注册）
  if (!dynamicSkillsCallbackRegistered) {
    dynamicSkillsCallbackRegistered = true
    onDynamicSkillsLoaded(() => {
      // 仅清除记忆化缓存（而非 clearCommandsCache），
      // 因为 clearCommandsCache 会调用 clearSkillCaches，
      // 清除掉我们刚刚加载的动态技能
      clearCommandMemoizationCaches()
      // 通知订阅方技能已变更
      skillsChanged.emit()
    })
  }

  const paths = await getWatchablePaths()
  if (paths.length === 0) return

  logForDebugging(
    `Watching for changes in skill/command directories: ${paths.join(', ')}...`,
  )

  // 创建 chokidar 文件监视器
  watcher = chokidar.watch(paths, {
    persistent: true,                    // 保持进程运行
    ignoreInitial: true,                  // 忽略初始扫描事件
    depth: 2,                             // 技能使用 skill-name/SKILL.md 格式，需要深度 2
    awaitWriteFinish: {
      // 等待文件稳定后再触发事件（防止编辑器分阶段写入时多次触发）
      stabilityThreshold:
        testOverrides?.stabilityThreshold ?? FILE_STABILITY_THRESHOLD_MS,
      pollInterval:
        testOverrides?.pollInterval ?? FILE_STABILITY_POLL_INTERVAL_MS,
    },
    // 忽略特殊文件类型（socket、FIFO、设备文件）和 .git 目录
    ignored: (path, stats) => {
      // 不可监视的特殊文件类型（在 macOS 上会触发 EOPNOTSUPP），只允许普通文件和目录
      if (stats && !stats.isFile() && !stats.isDirectory()) return true
      // 忽略 .git 目录
      return path.split(platformPath.sep).some(dir => dir === '.git')
    },
    ignorePermissionErrors: true,         // 忽略权限错误（避免崩溃）
    usePolling: USE_POLLING,              // Bun 环境下使用 stat() 轮询
    interval: testOverrides?.chokidarInterval ?? POLLING_INTERVAL_MS,
    atomic: true,                         // 原子写入支持（vim 等编辑器的 rename 写入）
  })

  // 监听文件增/改/删事件，均路由到 handleChange
  watcher.on('add', handleChange)
  watcher.on('change', handleChange)
  watcher.on('unlink', handleChange)

  // 注册优雅关闭清理回调，确保进程退出时正确关闭文件监视器
  unregisterCleanup = registerCleanup(async () => {
    await dispose()
  })
}

/**
 * 清理文件监视器并重置所有状态。
 *
 * - 关闭 chokidar watcher
 * - 取消防抖定时器
 * - 清空待处理路径集合
 * - 清除技能变更信号的所有监听器
 * - 取消注册清理回调
 *
 * @returns 关闭 watcher 的 Promise
 */
export function dispose(): Promise<void> {
  disposed = true
  // 取消注册优雅关闭清理回调
  if (unregisterCleanup) {
    unregisterCleanup()
    unregisterCleanup = null
  }
  let closePromise: Promise<void> = Promise.resolve()
  // 关闭 chokidar 文件监视器
  if (watcher) {
    closePromise = watcher.close()
    watcher = null
  }
  // 取消防抖定时器
  if (reloadTimer) {
    clearTimeout(reloadTimer)
    reloadTimer = null
  }
  pendingChangedPaths.clear()
  skillsChanged.clear()
  return closePromise
}

/**
 * 订阅技能变更通知。
 * 实际上是 skillsChanged.subscribe 的引用，调用者接收通知时无参数。
 */
export const subscribe = skillsChanged.subscribe

/**
 * 获取所有可监视的技能/命令目录路径。
 *
 * 检查以下目录是否存在（跳过不存在的路径）：
 * - 用户技能目录（~/.claude/skills）
 * - 用户命令目录（~/.claude/commands）
 * - 项目技能目录（.claude/skills，解析为绝对路径）
 * - 项目命令目录（.claude/commands，解析为绝对路径）
 * - --add-dir 附加目录下的 .claude/skills 目录
 *
 * @returns 存在的可监视路径数组
 */
async function getWatchablePaths(): Promise<string[]> {
  const fs = getFsImplementation()
  const paths: string[] = []

  // 用户技能目录（~/.claude/skills）
  const userSkillsPath = getSkillsPath('userSettings', 'skills')
  if (userSkillsPath) {
    try {
      await fs.stat(userSkillsPath)
      paths.push(userSkillsPath)
    } catch {
      // 路径不存在，跳过
    }
  }

  // 用户命令目录（~/.claude/commands）
  const userCommandsPath = getSkillsPath('userSettings', 'commands')
  if (userCommandsPath) {
    try {
      await fs.stat(userCommandsPath)
      paths.push(userCommandsPath)
    } catch {
      // 路径不存在，跳过
    }
  }

  // 项目技能目录（.claude/skills，需解析为绝对路径）
  const projectSkillsPath = getSkillsPath('projectSettings', 'skills')
  if (projectSkillsPath) {
    try {
      const absolutePath = platformPath.resolve(projectSkillsPath)
      await fs.stat(absolutePath)
      paths.push(absolutePath)
    } catch {
      // 路径不存在，跳过
    }
  }

  // 项目命令目录（.claude/commands，需解析为绝对路径）
  const projectCommandsPath = getSkillsPath('projectSettings', 'commands')
  if (projectCommandsPath) {
    try {
      const absolutePath = platformPath.resolve(projectCommandsPath)
      await fs.stat(absolutePath)
      paths.push(absolutePath)
    } catch {
      // 路径不存在，跳过
    }
  }

  // --add-dir 附加目录下的 .claude/skills 目录
  for (const dir of getAdditionalDirectoriesForClaudeMd()) {
    const additionalSkillsPath = platformPath.join(dir, '.claude', 'skills')
    try {
      await fs.stat(additionalSkillsPath)
      paths.push(additionalSkillsPath)
    } catch {
      // 路径不存在，跳过
    }
  }

  return paths
}

/**
 * 处理单个文件变更事件。
 *
 * 记录调试日志和分析事件，然后将路径加入防抖队列（scheduleReload）。
 *
 * @param path 发生变更的文件路径
 */
function handleChange(path: string): void {
  logForDebugging(`Detected skill change: ${path}`)
  logEvent('tengu_skill_file_changed', {
    source:
      'chokidar' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  })

  scheduleReload(path)
}

/**
 * 将技能变更事件防抖为单次重新加载。
 *
 * 当多个技能文件同时发生变更时（如 auto-update 安装新二进制或另一个会话修改技能目录），
 * 每个文件都会触发独立的 chokidar 事件。若无防抖，每次事件都会触发完整重载周期，
 * 可能通过 FSWatcher 频繁 watch/unwatch 使 Bun 事件循环死锁。
 *
 * 防抖逻辑：将变更路径加入集合，重置定时器；定时器到期后：
 * 1. 对所有待处理路径执行一次 ConfigChange hook（以第一个路径为代表）
 * 2. 若 hook 阻断，记录日志并返回
 * 3. 清除技能缓存和命令缓存
 * 4. 发送技能变更信号通知所有订阅方
 *
 * @param changedPath 发生变更的文件路径
 */
function scheduleReload(changedPath: string): void {
  // 将路径加入待处理集合（Set 自动去重）
  pendingChangedPaths.add(changedPath)
  // 重置防抖定时器
  if (reloadTimer) clearTimeout(reloadTimer)
  reloadTimer = setTimeout(async () => {
    reloadTimer = null
    const paths = [...pendingChangedPaths]
    pendingChangedPaths.clear()
    // 对整批路径执行一次 ConfigChange hook（以第一个路径为代表）。
    // hook 查询始终为 'skills'，按路径逐一触发（git 操作可能产生数百个路径）
    // 只会产生大量相同的查询，因此只触发一次。
    const results = await executeConfigChangeHooks('skills', paths[0]!)
    if (hasBlockingResult(results)) {
      logForDebugging(
        `ConfigChange hook blocked skill reload (${paths.length} paths)`,
      )
      return
    }
    // 清除技能缓存和命令缓存，确保下次访问时重新加载最新技能
    clearSkillCaches()
    clearCommandsCache()
    // 重置已发送技能名称记录，使新技能得以重新发送
    resetSentSkillNames()
    // 通知所有订阅方（如 UI 组件）技能已变更
    skillsChanged.emit()
  }, testOverrides?.reloadDebounce ?? RELOAD_DEBOUNCE_MS)
}

/**
 * 重置所有内部状态，仅供测试使用。
 *
 * 关闭现有 watcher（避免资源泄漏），清除定时器和待处理路径，
 * 重置 initialized/disposed 标志，并应用测试时间常量覆盖。
 *
 * @param overrides 可选的时间常量覆盖值（stabilityThreshold/pollInterval/reloadDebounce/chokidarInterval）
 */
export async function resetForTesting(overrides?: {
  stabilityThreshold?: number
  pollInterval?: number
  reloadDebounce?: number
  chokidarInterval?: number
}): Promise<void> {
  // 关闭现有 watcher，避免资源泄漏
  if (watcher) {
    await watcher.close()
    watcher = null
  }
  // 清除防抖定时器
  if (reloadTimer) {
    clearTimeout(reloadTimer)
    reloadTimer = null
  }
  pendingChangedPaths.clear()
  skillsChanged.clear()
  initialized = false
  disposed = false
  testOverrides = overrides ?? null
}

/** 技能变更检测器对象，整合 initialize/dispose/subscribe/resetForTesting */
export const skillChangeDetector = {
  initialize,
  dispose,
  subscribe,
  resetForTesting,
}
