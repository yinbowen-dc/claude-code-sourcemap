/**
 * 活动时间追踪管理器模块。
 *
 * 在 Claude Code 系统中，该模块负责分别统计用户活动时间和 CLI（工具执行、
 * AI 响应等）活动时间，用于分析和遥测上报。
 *
 * 核心设计：
 * - 单例模式（ActivityManager.getInstance()），全局共享一个实例
 * - 通过 operationId Set 对重叠的 CLI 操作自动去重
 * - 用户活动有 5 秒超时窗口：超时后的活动不计入统计，避免"AFK"时间被误计
 * - CLI 活动优先：CLI 运行期间不记录用户时间
 * - 通过 getActiveTimeCounter() 将时间数据上报到 OpenTelemetry 计数器
 */
import { getActiveTimeCounter as getActiveTimeCounterImpl } from '../bootstrap/state.js'

type ActivityManagerOptions = {
  getNow?: () => number
  getActiveTimeCounter?: typeof getActiveTimeCounterImpl
}

/**
 * 活动管理器，统一处理用户与 CLI 操作的活动时间追踪。
 * 自动对重叠操作去重，并分别提供用户活跃时间和 CLI 活跃时间的度量。
 *
 * ActivityManager handles generic activity tracking for both user and CLI operations.
 */
export class ActivityManager {
  // 当前正在进行的 CLI 操作集合（用 operationId 去重）
  private activeOperations = new Set<string>()

  // 最后一次用户活动的时间戳（0 表示尚无活动记录）
  private lastUserActivityTime: number = 0 // Start with 0 to indicate no activity yet
  // 最后一次 CLI 时间记录点
  private lastCLIRecordedTime: number

  // CLI 是否当前处于活跃状态
  private isCLIActive: boolean = false

  // 用户活动超时窗口：5 秒内的连续活动视为连续活跃
  private readonly USER_ACTIVITY_TIMEOUT_MS = 5000 // 5 seconds

  private readonly getNow: () => number
  private readonly getActiveTimeCounter: typeof getActiveTimeCounterImpl

  // 单例实例
  private static instance: ActivityManager | null = null

  constructor(options?: ActivityManagerOptions) {
    this.getNow = options?.getNow ?? (() => Date.now())
    this.getActiveTimeCounter =
      options?.getActiveTimeCounter ?? getActiveTimeCounterImpl
    this.lastCLIRecordedTime = this.getNow()
  }

  /** 获取全局单例实例 */
  static getInstance(): ActivityManager {
    if (!ActivityManager.instance) {
      ActivityManager.instance = new ActivityManager()
    }
    return ActivityManager.instance
  }

  /**
   * 重置单例实例（仅用于测试）。
   *
   * Reset the singleton instance (for testing purposes)
   */
  static resetInstance(): void {
    ActivityManager.instance = null
  }

  /**
   * 使用自定义选项创建新实例（仅用于测试）。
   *
   * Create a new instance with custom options (for testing purposes)
   */
  static createInstance(options?: ActivityManagerOptions): ActivityManager {
    ActivityManager.instance = new ActivityManager(options)
    return ActivityManager.instance
  }

  /**
   * 记录一次用户活动（键入、命令等）。
   *
   * 若 CLI 当前活跃则跳过（CLI 优先）；否则计算与上次活动的时间差，
   * 若在超时窗口内则将该时间段记录为 "user" 类型活跃时间。
   *
   * Called when user interacts with the CLI (typing, commands, etc.)
   */
  recordUserActivity(): void {
    // Don't record user time if CLI is active (CLI takes precedence)
    if (!this.isCLIActive && this.lastUserActivityTime !== 0) {
      const now = this.getNow()
      const timeSinceLastActivity = (now - this.lastUserActivityTime) / 1000

      if (timeSinceLastActivity > 0) {
        const activeTimeCounter = this.getActiveTimeCounter()
        if (activeTimeCounter) {
          const timeoutSeconds = this.USER_ACTIVITY_TIMEOUT_MS / 1000

          // Only record time if within the timeout window
          if (timeSinceLastActivity < timeoutSeconds) {
            activeTimeCounter.add(timeSinceLastActivity, { type: 'user' })
          }
        }
      }
    }

    // 更新最后一次用户活动时间戳
    this.lastUserActivityTime = this.getNow()
  }

  /**
   * 开始追踪一个 CLI 操作（工具执行、AI 响应等）。
   *
   * 若该 operationId 已存在（说明上次未正常清理），先强制结束旧记录
   * 以避免高估时间。首个操作开始时标记 CLI 为活跃并记录起始时间。
   *
   * Starts tracking CLI activity (tool execution, AI response, etc.)
   */
  startCLIActivity(operationId: string): void {
    // If operation already exists, it likely means the previous one didn't clean up
    // properly (e.g., component crashed/unmounted without calling end). Force cleanup
    // to avoid overestimating time - better to underestimate than overestimate.
    if (this.activeOperations.has(operationId)) {
      this.endCLIActivity(operationId)
    }

    const wasEmpty = this.activeOperations.size === 0
    this.activeOperations.add(operationId)

    if (wasEmpty) {
      // 第一个操作：CLI 开始活跃，记录起始时间
      this.isCLIActive = true
      this.lastCLIRecordedTime = this.getNow()
    }
  }

  /**
   * 停止追踪一个 CLI 操作。
   *
   * 若所有操作均已结束，计算本次 CLI 活跃时长并以 "cli" 类型上报。
   *
   * Stops tracking CLI activity
   */
  endCLIActivity(operationId: string): void {
    this.activeOperations.delete(operationId)

    if (this.activeOperations.size === 0) {
      // Last operation ended - CLI becoming inactive
      // Record the CLI time before switching to inactive
      const now = this.getNow()
      const timeSinceLastRecord = (now - this.lastCLIRecordedTime) / 1000

      if (timeSinceLastRecord > 0) {
        const activeTimeCounter = this.getActiveTimeCounter()
        if (activeTimeCounter) {
          // 将本次 CLI 活跃时长上报为 "cli" 类型
          activeTimeCounter.add(timeSinceLastRecord, { type: 'cli' })
        }
      }

      this.lastCLIRecordedTime = now
      this.isCLIActive = false
    }
  }

  /**
   * 便捷方法：自动追踪一个异步操作的 CLI 时间（主要用于测试/调试）。
   * 通过 try/finally 确保操作无论成功还是失败都会结束计时。
   *
   * Convenience method to track an async operation automatically (mainly for testing/debugging)
   */
  async trackOperation<T>(
    operationId: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    this.startCLIActivity(operationId)
    try {
      return await fn()
    } finally {
      this.endCLIActivity(operationId)
    }
  }

  /**
   * 获取当前活动状态（主要用于测试/调试）。
   *
   * Gets current activity states (mainly for testing/debugging)
   */
  getActivityStates(): {
    isUserActive: boolean
    isCLIActive: boolean
    activeOperationCount: number
  } {
    const now = this.getNow()
    const timeSinceUserActivity = (now - this.lastUserActivityTime) / 1000
    // 用户活跃：距最后活动时间在超时窗口内
    const isUserActive =
      timeSinceUserActivity < this.USER_ACTIVITY_TIMEOUT_MS / 1000

    return {
      isUserActive,
      isCLIActive: this.isCLIActive,
      activeOperationCount: this.activeOperations.size,
    }
  }
}

// 导出全局单例实例
export const activityManager = ActivityManager.getInstance()
