/**
 * 【第一方事件日志导出器】analytics/firstPartyEventLoggingExporter.ts
 *
 * 在 Claude Code 系统流程中的位置：
 * - 属于分析（analytics）子系统，是 1P 上报通道的实际 HTTP 发送层
 * - 由 firstPartyEventLogger.ts 的 initialize1PEventLogging() 实例化
 * - 被 OTel BatchLogRecordProcessor 在批次就绪时调用 export()
 * - 依赖 metadata.ts 的 to1PEventFormat() 将 EventMetadata 转换为 proto 格式
 *
 * 核心功能：
 * - 实现 OTel LogRecordExporter 接口（export / forceFlush / shutdown）
 * - 弹性磁盘队列：导出失败的事件追加写入 JSONL 文件（append-only，并发安全）
 * - 二次方退避重试：delay = base * attempts²，上限 maxBackoffDelayMs（默认 30s）
 * - Auth 回退：先尝试 OAuth 认证请求，收到 401 时自动降为无认证重试
 * - sendEventsInBatches()：按 maxBatchSize 分块，首个批次失败时短路剩余批次
 * - transformLogsToEvents()：路由 GrowthbookExperimentEvent 与 ClaudeCodeInternalEvent
 *   并在 additional_metadata 写入前防御性剥离 _PROTO_* 键
 * - retryPreviousBatches()：启动时自动重试本 session 上次进程遗留的失败事件文件
 */

import type { HrTime } from '@opentelemetry/api'
import { type ExportResult, ExportResultCode } from '@opentelemetry/core'
import type {
  LogRecordExporter,
  ReadableLogRecord,
} from '@opentelemetry/sdk-logs'
import axios from 'axios'
import { randomUUID } from 'crypto'
import { appendFile, mkdir, readdir, unlink, writeFile } from 'fs/promises'
import * as path from 'path'
import type { CoreUserData } from 'src/utils/user.js'
import {
  getIsNonInteractiveSession,
  getSessionId,
} from '../../bootstrap/state.js'
import { ClaudeCodeInternalEvent } from '../../types/generated/events_mono/claude_code/v1/claude_code_internal_event.js'
import { GrowthbookExperimentEvent } from '../../types/generated/events_mono/growthbook/v1/growthbook_experiment_event.js'
import {
  getClaudeAIOAuthTokens,
  hasProfileScope,
  isClaudeAISubscriber,
} from '../../utils/auth.js'
import { checkHasTrustDialogAccepted } from '../../utils/config.js'
import { logForDebugging } from '../../utils/debug.js'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import { errorMessage, isFsInaccessible, toError } from '../../utils/errors.js'
import { getAuthHeaders } from '../../utils/http.js'
import { readJSONLFile } from '../../utils/json.js'
import { logError } from '../../utils/log.js'
import { sleep } from '../../utils/sleep.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { getClaudeCodeUserAgent } from '../../utils/userAgent.js'
import { isOAuthTokenExpired } from '../oauth/client.js'
import { stripProtoFields } from './index.js'
import { type EventMetadata, to1PEventFormat } from './metadata.js'

// 本次进程运行的唯一 UUID — 用于隔离不同进程运行之间的失败事件文件
const BATCH_UUID = randomUUID()

// 失败事件文件名前缀（方便 readdir 过滤）
const FILE_PREFIX = '1p_failed_events.'

/**
 * 获取失败事件的存储目录路径
 * 在运行时动态求值，以便测试用例通过 CLAUDE_CONFIG_DIR 覆盖路径
 */
function getStorageDir(): string {
  return path.join(getClaudeConfigHomeDir(), 'telemetry')
}

/**
 * API 信封类型：event_data 是 proto toJSON() 的输出（序列化后的 JSON 对象）
 * event_type 用于服务端区分 proto schema 进行反序列化
 */
type FirstPartyEventLoggingEvent = {
  event_type: 'ClaudeCodeInternalEvent' | 'GrowthbookExperimentEvent'
  event_data: unknown
}

/** HTTP POST 请求 body 结构 */
type FirstPartyEventLoggingPayload = {
  events: FirstPartyEventLoggingEvent[]
}

/**
 * 第一方事件日志导出器
 *
 * 实现 OTel LogRecordExporter 接口，将批量日志记录上报到 /api/event_logging/batch。
 *
 * 导出周期由 OTel BatchLogRecordProcessor 控制，在以下情况触发 export()：
 * - 时间间隔到期（默认：scheduledDelayMillis = 10s）
 * - 批次大小达到上限（默认：maxExportBatchSize = 200 条）
 *
 * 弹性设计：
 * - 追加写 JSONL 磁盘队列（并发安全）
 * - 二次方退避重试失败事件，超过 maxAttempts 后丢弃
 * - 任意导出成功后立即重试磁盘队列（端点恢复时快速清空积压）
 * - 大批次分块发送
 * - Auth 回退：401 时自动降为无认证重试
 *
 * Exporter for 1st-party event logging to /api/event_logging/batch.
 *
 * Export cycles are controlled by OpenTelemetry's BatchLogRecordProcessor, which
 * triggers export() when either:
 * - Time interval elapses (default: 5 seconds via scheduledDelayMillis)
 * - Batch size is reached (default: 200 events via maxExportBatchSize)
 *
 * This exporter adds resilience on top:
 * - Append-only log for failed events (concurrency-safe)
 * - Quadratic backoff retry for failed events, dropped after maxAttempts
 * - Immediate retry of queued events when any export succeeds (endpoint is healthy)
 * - Chunking large event sets into smaller batches
 * - Auth fallback: retries without auth on 401 errors
 */
export class FirstPartyEventLoggingExporter implements LogRecordExporter {
  private readonly endpoint: string           // 事件上报端点 URL
  private readonly timeout: number            // HTTP 请求超时（毫秒）
  private readonly maxBatchSize: number       // 每批最大事件数
  private readonly skipAuth: boolean          // 是否跳过认证（测试用）
  private readonly batchDelayMs: number       // 批次间的延迟（毫秒）
  private readonly baseBackoffDelayMs: number // 退避基础延迟（毫秒）
  private readonly maxBackoffDelayMs: number  // 退避最大延迟（毫秒）
  private readonly maxAttempts: number        // 最大重试次数（超过后丢弃事件）
  private readonly isKilled: () => boolean    // killswitch 探针（每次 POST 前检查）
  private pendingExports: Promise<void>[] = [] // 进行中的导出 Promise 列表（forceFlush 用）
  private isShutdown = false                   // 是否已关闭
  private readonly schedule: (              // 定时调度器（可注入，便于测试）
    fn: () => Promise<void>,
    delayMs: number,
  ) => () => void
  private cancelBackoff: (() => void) | null = null  // 取消当前退避定时器的函数
  private attempts = 0                        // 当前重试次数（用于二次方退避计算）
  private isRetrying = false                  // 是否正在执行磁盘队列重试（防并发）
  private lastExportErrorContext: string | undefined  // 上次导出错误的上下文字符串（用于日志）

  constructor(
    options: {
      timeout?: number
      maxBatchSize?: number
      skipAuth?: boolean
      batchDelayMs?: number
      baseBackoffDelayMs?: number
      maxBackoffDelayMs?: number
      maxAttempts?: number
      path?: string
      baseUrl?: string
      // 注入的 killswitch 探针，每次 POST 前检查；通过注入而非直接导入，避免与 firstPartyEventLogger.ts 形成循环引用
      // Injected killswitch probe. Checked per-POST so that disabling the
      // firstParty sink also stops backoff retries (not just new emits).
      // Passed in rather than imported to avoid a cycle with firstPartyEventLogger.ts.
      isKilled?: () => boolean
      schedule?: (fn: () => Promise<void>, delayMs: number) => () => void
    } = {},
  ) {
    // 默认使用生产端点，除非 ANTHROPIC_BASE_URL 明确指向 staging；
    // 也可通过 tengu_1p_event_batch_config.baseUrl 覆盖
    // Default: prod, except when ANTHROPIC_BASE_URL is explicitly staging.
    // Overridable via tengu_1p_event_batch_config.baseUrl.
    const baseUrl =
      options.baseUrl ||
      (process.env.ANTHROPIC_BASE_URL === 'https://api-staging.anthropic.com'
        ? 'https://api-staging.anthropic.com'
        : 'https://api.anthropic.com')

    this.endpoint = `${baseUrl}${options.path || '/api/event_logging/batch'}`

    this.timeout = options.timeout || 10000
    this.maxBatchSize = options.maxBatchSize || 200
    this.skipAuth = options.skipAuth ?? false
    this.batchDelayMs = options.batchDelayMs || 100
    this.baseBackoffDelayMs = options.baseBackoffDelayMs || 500
    this.maxBackoffDelayMs = options.maxBackoffDelayMs || 30000
    this.maxAttempts = options.maxAttempts ?? 8
    this.isKilled = options.isKilled ?? (() => false)
    this.schedule =
      options.schedule ??
      ((fn, ms) => {
        const t = setTimeout(fn, ms)
        return () => clearTimeout(t)
      })

    // 在后台重试本 session 上次进程遗留的失败事件（启动时自动清理）
    void this.retryPreviousBatches()
  }

  /** 获取当前磁盘队列中的待重试事件数（暴露给测试） */
  // Expose for testing
  async getQueuedEventCount(): Promise<number> {
    return (await this.loadEventsFromCurrentBatch()).length
  }

  // --- 磁盘存储工具方法 ---

  /** 获取当前批次的磁盘文件路径（按 sessionId + BATCH_UUID 命名，确保进程间隔离） */
  private getCurrentBatchFilePath(): string {
    return path.join(
      getStorageDir(),
      `${FILE_PREFIX}${getSessionId()}.${BATCH_UUID}.json`,
    )
  }

  /** 从指定 JSONL 文件加载事件列表（读取失败时返回空数组） */
  private async loadEventsFromFile(
    filePath: string,
  ): Promise<FirstPartyEventLoggingEvent[]> {
    try {
      return await readJSONLFile<FirstPartyEventLoggingEvent>(filePath)
    } catch {
      return []
    }
  }

  /** 从当前批次文件加载待重试事件 */
  private async loadEventsFromCurrentBatch(): Promise<
    FirstPartyEventLoggingEvent[]
  > {
    return this.loadEventsFromFile(this.getCurrentBatchFilePath())
  }

  /**
   * 将事件列表写入磁盘文件
   * 若事件列表为空，则删除文件（清理空文件）
   */
  private async saveEventsToFile(
    filePath: string,
    events: FirstPartyEventLoggingEvent[],
  ): Promise<void> {
    try {
      if (events.length === 0) {
        try {
          await unlink(filePath)
        } catch {
          // 文件不存在，无需删除
        }
      } else {
        // 确保存储目录存在
        await mkdir(getStorageDir(), { recursive: true })
        // 写为 JSONL 格式（每行一条事件）
        const content = events.map(e => jsonStringify(e)).join('\n') + '\n'
        await writeFile(filePath, content, 'utf8')
      }
    } catch (error) {
      logError(error)
    }
  }

  /**
   * 追加事件到磁盘文件（append-only，在大多数文件系统上具有原子性，并发安全）
   * 导出失败时调用，避免与同时进行的读操作产生竞争
   */
  private async appendEventsToFile(
    filePath: string,
    events: FirstPartyEventLoggingEvent[],
  ): Promise<void> {
    if (events.length === 0) return
    try {
      // 确保存储目录存在
      await mkdir(getStorageDir(), { recursive: true })
      // 追加 JSONL 格式（每行一条事件）
      const content = events.map(e => jsonStringify(e)).join('\n') + '\n'
      await appendFile(filePath, content, 'utf8')
    } catch (error) {
      logError(error)
    }
  }

  /** 删除磁盘文件（忽略文件不存在等错误） */
  private async deleteFile(filePath: string): Promise<void> {
    try {
      await unlink(filePath)
    } catch {
      // 文件不存在或无法删除，忽略
    }
  }

  // --- 启动时重试上次进程遗留的失败批次 ---

  /**
   * 在后台重试本 session 上次进程遗留的失败事件文件
   *
   * 工作流程：
   * 1. 列出存储目录中属于本 session、非当前批次的失败事件文件
   * 2. 对每个文件调用 retryFileInBackground() 独立重试（并行）
   * 3. 遇到文件系统不可访问错误时静默返回（如沙盒环境）
   */
  private async retryPreviousBatches(): Promise<void> {
    try {
      // 过滤：只处理本 session 的失败文件，排除当前进程的批次文件
      const prefix = `${FILE_PREFIX}${getSessionId()}.`
      let files: string[]
      try {
        files = (await readdir(getStorageDir()))
          .filter((f: string) => f.startsWith(prefix) && f.endsWith('.json'))
          .filter((f: string) => !f.includes(BATCH_UUID)) // 排除当前批次文件
      } catch (e) {
        if (isFsInaccessible(e)) return  // 文件系统不可访问（沙盒等），静默退出
        throw e
      }

      // 并行重试每个文件
      for (const file of files) {
        const filePath = path.join(getStorageDir(), file)
        void this.retryFileInBackground(filePath)
      }
    } catch (error) {
      logError(error)
    }
  }

  /**
   * 后台重试指定失败事件文件
   *
   * 若已达最大重试次数则直接删除文件（丢弃事件）；
   * 重试成功后删除文件，失败则将剩余失败事件写回文件。
   */
  private async retryFileInBackground(filePath: string): Promise<void> {
    // 已达最大重试次数：丢弃文件
    if (this.attempts >= this.maxAttempts) {
      await this.deleteFile(filePath)
      return
    }

    const events = await this.loadEventsFromFile(filePath)
    if (events.length === 0) {
      await this.deleteFile(filePath)  // 空文件直接删除
      return
    }

    if (process.env.USER_TYPE === 'ant') {
      logForDebugging(
        `1P event logging: retrying ${events.length} events from previous batch`,
      )
    }

    const failedEvents = await this.sendEventsInBatches(events)
    if (failedEvents.length === 0) {
      // 全部成功：删除文件
      await this.deleteFile(filePath)
      if (process.env.USER_TYPE === 'ant') {
        logForDebugging('1P event logging: previous batch retry succeeded')
      }
    } else {
      // 部分失败：只将失败事件写回文件（非所有原始事件）
      await this.saveEventsToFile(filePath, failedEvents)
      if (process.env.USER_TYPE === 'ant') {
        logForDebugging(
          `1P event logging: previous batch retry failed, ${failedEvents.length} events remain`,
        )
      }
    }
  }

  /**
   * OTel LogRecordExporter 接口：导出批量日志记录
   *
   * 工作流程：
   * 1. 若已 shutdown 则立即返回 FAILED
   * 2. 启动 doExport() 异步任务并注册到 pendingExports（供 forceFlush 等待）
   * 3. 导出完成后从 pendingExports 移除
   */
  async export(
    logs: ReadableLogRecord[],
    resultCallback: (result: ExportResult) => void,
  ): Promise<void> {
    if (this.isShutdown) {
      if (process.env.USER_TYPE === 'ant') {
        logForDebugging(
          '1P event logging export failed: Exporter has been shutdown',
        )
      }
      resultCallback({
        code: ExportResultCode.FAILED,
        error: new Error('Exporter has been shutdown'),
      })
      return
    }

    const exportPromise = this.doExport(logs, resultCallback)
    this.pendingExports.push(exportPromise)

    // 导出完成后从 pendingExports 移除（防止内存泄漏）
    void exportPromise.finally(() => {
      const index = this.pendingExports.indexOf(exportPromise)
      if (index > -1) {
        void this.pendingExports.splice(index, 1)
      }
    })
  }

  /**
   * 实际导出逻辑
   *
   * 工作流程：
   * 1. 过滤只属于 'com.anthropic.claude_code.events' scope 的日志记录
   * 2. 调用 transformLogsToEvents() 转换为 API 事件格式
   * 3. 检查是否超过最大重试次数（超过则丢弃）
   * 4. 调用 sendEventsInBatches() 发送
   * 5. 失败时：追加失败事件到磁盘，调度退避重试
   * 6. 成功时：重置退避，立即重试磁盘队列（趁端点健康时清空积压）
   */
  private async doExport(
    logs: ReadableLogRecord[],
    resultCallback: (result: ExportResult) => void,
  ): Promise<void> {
    try {
      // 过滤：只处理来自内部事件 logger 的日志记录（排除其他 OTel 日志源）
      const eventLogs = logs.filter(
        log =>
          log.instrumentationScope?.name === 'com.anthropic.claude_code.events',
      )

      if (eventLogs.length === 0) {
        resultCallback({ code: ExportResultCode.SUCCESS })
        return
      }

      // 转换 OTel 日志记录为 1P API 事件格式（失败事件通过退避独立重试）
      const events = this.transformLogsToEvents(eventLogs).events

      if (events.length === 0) {
        resultCallback({ code: ExportResultCode.SUCCESS })
        return
      }

      // 已达最大重试次数：丢弃本批事件（不再入磁盘队列）
      if (this.attempts >= this.maxAttempts) {
        resultCallback({
          code: ExportResultCode.FAILED,
          error: new Error(
            `Dropped ${events.length} events: max attempts (${this.maxAttempts}) reached`,
          ),
        })
        return
      }

      // 分批发送事件
      const failedEvents = await this.sendEventsInBatches(events)
      this.attempts++

      if (failedEvents.length > 0) {
        // 有失败事件：追加到磁盘队列，调度退避重试
        await this.queueFailedEvents(failedEvents)
        this.scheduleBackoffRetry()
        const context = this.lastExportErrorContext
          ? ` (${this.lastExportErrorContext})`
          : ''
        resultCallback({
          code: ExportResultCode.FAILED,
          error: new Error(
            `Failed to export ${failedEvents.length} events${context}`,
          ),
        })
        return
      }

      // 全部成功：重置退避计数，立即尝试清空磁盘队列（趁端点健康）
      this.resetBackoff()
      if ((await this.getQueuedEventCount()) > 0 && !this.isRetrying) {
        void this.retryFailedEvents()
      }
      resultCallback({ code: ExportResultCode.SUCCESS })
    } catch (error) {
      if (process.env.USER_TYPE === 'ant') {
        logForDebugging(
          `1P event logging export failed: ${errorMessage(error)}`,
        )
      }
      logError(error)
      resultCallback({
        code: ExportResultCode.FAILED,
        error: toError(error),
      })
    }
  }

  /**
   * 将事件列表分批发送到 API 端点
   *
   * 设计：
   * - 按 maxBatchSize 将事件分块（减少单次请求大小）
   * - 批次间等待 batchDelayMs（减轻服务端压力）
   * - 首个批次失败时短路：将失败批次 + 所有剩余未发送批次合并返回，不再尝试后续批次
   * - 短路设计原因：端点出问题时继续尝试只会浪费网络资源；退避重试会恢复
   *
   * @returns 所有失败事件的合并列表（成功时返回空数组）
   */
  private async sendEventsInBatches(
    events: FirstPartyEventLoggingEvent[],
  ): Promise<FirstPartyEventLoggingEvent[]> {
    // 将事件列表分块
    const batches: FirstPartyEventLoggingEvent[][] = []
    for (let i = 0; i < events.length; i += this.maxBatchSize) {
      batches.push(events.slice(i, i + this.maxBatchSize))
    }

    if (process.env.USER_TYPE === 'ant') {
      logForDebugging(
        `1P event logging: exporting ${events.length} events in ${batches.length} batch(es)`,
      )
    }

    // 依次发送每个批次；首个失败时短路剩余批次
    // Send each batch with delay between them. On first failure, assume the
    // endpoint is down and short-circuit: queue the failed batch plus all
    // remaining unsent batches without POSTing them. The backoff retry will
    // probe again with a single batch next tick.
    const failedBatchEvents: FirstPartyEventLoggingEvent[] = []
    let lastErrorContext: string | undefined
    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i]!
      try {
        await this.sendBatchWithRetry({ events: batch })
      } catch (error) {
        lastErrorContext = getAxiosErrorContext(error)
        // 短路：将失败批次和所有剩余未发送批次合并到 failedBatchEvents
        for (let j = i; j < batches.length; j++) {
          failedBatchEvents.push(...batches[j]!)
        }
        if (process.env.USER_TYPE === 'ant') {
          const skipped = batches.length - 1 - i
          logForDebugging(
            `1P event logging: batch ${i + 1}/${batches.length} failed (${lastErrorContext}); short-circuiting ${skipped} remaining batch(es)`,
          )
        }
        break
      }

      // 批次间延迟（非最后一批次时等待）
      if (i < batches.length - 1 && this.batchDelayMs > 0) {
        await sleep(this.batchDelayMs)
      }
    }

    // 记录错误上下文供日志使用
    if (failedBatchEvents.length > 0 && lastErrorContext) {
      this.lastExportErrorContext = lastErrorContext
    }

    return failedBatchEvents
  }

  /**
   * 将失败事件追加写入磁盘队列并记录错误日志
   *
   * 追加写（append-only）确保与同时进行的 loadEventsFromFile 不产生竞争；
   * 在大多数文件系统上 appendFile 具有原子性。
   */
  private async queueFailedEvents(
    events: FirstPartyEventLoggingEvent[],
  ): Promise<void> {
    const filePath = this.getCurrentBatchFilePath()

    // 追加写：仅追加新失败事件（原子性，并发安全）
    // Append-only: just add new events to file (atomic on most filesystems)
    await this.appendEventsToFile(filePath, events)

    const context = this.lastExportErrorContext
      ? ` (${this.lastExportErrorContext})`
      : ''
    const message = `1P event logging: ${events.length} events failed to export${context}`
    logError(new Error(message))
  }

  /**
   * 调度退避重试定时器
   *
   * 二次方退避（与 Statsig SDK 保持一致）：delay = base * attempts²
   * 上限为 maxBackoffDelayMs（默认 30s）。
   * 若已有退避定时器、正在重试或已 shutdown，则不重复调度。
   */
  private scheduleBackoffRetry(): void {
    // 已有退避定时器 / 正在重试 / 已 shutdown：不重复调度
    if (this.cancelBackoff || this.isRetrying || this.isShutdown) {
      return
    }

    // 二次方退避（matching Statsig SDK）：base * attempts²，上限 maxBackoffDelayMs
    // Quadratic backoff (matching Statsig SDK): base * attempts²
    const delay = Math.min(
      this.baseBackoffDelayMs * this.attempts * this.attempts,
      this.maxBackoffDelayMs,
    )

    if (process.env.USER_TYPE === 'ant') {
      logForDebugging(
        `1P event logging: scheduling backoff retry in ${delay}ms (attempt ${this.attempts})`,
      )
    }

    this.cancelBackoff = this.schedule(async () => {
      this.cancelBackoff = null
      await this.retryFailedEvents()
    }, delay)
  }

  /**
   * 重试磁盘队列中的失败事件
   *
   * 工作流程（循环直到磁盘队列为空或 shutdown）：
   * 1. 从磁盘加载待重试事件
   * 2. 已达最大重试次数：删除文件并返回
   * 3. 先删除磁盘文件（内存中已有副本），防止并发追加写引发重复
   * 4. 尝试发送，成功后重置退避并继续循环（清空新积压的事件）
   * 5. 失败后将剩余失败事件写回磁盘，重新调度退避
   */
  private async retryFailedEvents(): Promise<void> {
    const filePath = this.getCurrentBatchFilePath()

    // 循环直到磁盘队列为空或已 shutdown
    while (!this.isShutdown) {
      const events = await this.loadEventsFromFile(filePath)
      if (events.length === 0) break  // 队列已清空

      // 已达最大重试次数：丢弃所有剩余失败事件
      if (this.attempts >= this.maxAttempts) {
        if (process.env.USER_TYPE === 'ant') {
          logForDebugging(
            `1P event logging: max attempts (${this.maxAttempts}) reached, dropping ${events.length} events`,
          )
        }
        await this.deleteFile(filePath)
        this.resetBackoff()
        return
      }

      this.isRetrying = true

      // 先删除磁盘文件（内存中已有副本），避免与并发追加写产生冲突
      // Clear file before retry (we have events in memory now)
      await this.deleteFile(filePath)

      if (process.env.USER_TYPE === 'ant') {
        logForDebugging(
          `1P event logging: retrying ${events.length} failed events (attempt ${this.attempts + 1})`,
        )
      }

      const failedEvents = await this.sendEventsInBatches(events)
      this.attempts++

      this.isRetrying = false

      if (failedEvents.length > 0) {
        // 仍有失败事件：写回磁盘，重新调度退避
        await this.saveEventsToFile(filePath, failedEvents)
        this.scheduleBackoffRetry()
        return  // 等待下一次退避重试
      }

      // 全部成功：重置退避，继续循环检查是否有新积压事件
      this.resetBackoff()
      if (process.env.USER_TYPE === 'ant') {
        logForDebugging('1P event logging: backoff retry succeeded')
      }
    }
  }

  /** 重置退避状态（重试次数归零，取消当前退避定时器） */
  private resetBackoff(): void {
    this.attempts = 0
    if (this.cancelBackoff) {
      this.cancelBackoff()
      this.cancelBackoff = null
    }
  }

  /**
   * 发送单个批次到 API 端点（含 auth 回退逻辑）
   *
   * 工作流程：
   * 1. 检查 killswitch：已触发则抛出异常（调用方会短路并入磁盘队列）
   * 2. 构建基础请求头（Content-Type、User-Agent、x-service-name）
   * 3. 判断是否应跳过认证（信任对话未接受 / OAuth token 过期 / 无 profile scope）
   * 4. 若启用认证则附加 auth 请求头
   * 5. 发送 POST 请求；若 401 且原本使用了认证，自动降为无认证重试
   *
   * killswitch 触发时抛出异常（而非静默跳过）的原因：
   * 使调用方（sendEventsInBatches）能够短路剩余批次并将所有事件入队，
   * 零网络流量；退避定时器仍在运行，GrowthBook 缓存清除 killswitch 后自动恢复
   */
  private async sendBatchWithRetry(
    payload: FirstPartyEventLoggingPayload,
  ): Promise<void> {
    if (this.isKilled()) {
      // 抛出异常使调用方短路剩余批次并将所有事件入队磁盘
      // Throw so the caller short-circuits remaining batches and queues
      // everything to disk. Zero network traffic while killed; the backoff
      // timer keeps ticking and will resume POSTs as soon as the GrowthBook
      // cache picks up the cleared flag.
      throw new Error('firstParty sink killswitch active')
    }

    // 基础请求头（不含认证信息）
    const baseHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': getClaudeCodeUserAgent(),
      'x-service-name': 'claude-code',
    }

    // 信任检查：信任对话未接受前跳过认证（防止在信任对话前执行 apiKeyHelper 命令）
    // 非交互式 session 默认拥有工作区信任
    // Skip auth if trust hasn't been established yet
    // This prevents executing apiKeyHelper commands before the trust dialog
    // Non-interactive sessions implicitly have workspace trust
    const hasTrust =
      checkHasTrustDialogAccepted() || getIsNonInteractiveSession()
    if (process.env.USER_TYPE === 'ant' && !hasTrust) {
      logForDebugging('1P event logging: Trust not accepted')
    }

    // 判断是否应跳过认证：
    // - 显式配置跳过（skipAuth）
    // - 信任对话未接受
    // - Claude.ai 订阅用户且无 profile scope（服务密钥会话）
    // - Claude.ai 订阅用户且 OAuth token 已过期
    // Skip auth when the OAuth token is expired or lacks user:profile
    // scope (service key sessions). Falls through to unauthenticated send.
    let shouldSkipAuth = this.skipAuth || !hasTrust
    if (!shouldSkipAuth && isClaudeAISubscriber()) {
      const tokens = getClaudeAIOAuthTokens()
      if (!hasProfileScope()) {
        shouldSkipAuth = true  // 无 profile scope（服务密钥会话）
      } else if (tokens && isOAuthTokenExpired(tokens.expiresAt)) {
        shouldSkipAuth = true  // OAuth token 已过期，跳过认证避免 401
        if (process.env.USER_TYPE === 'ant') {
          logForDebugging(
            '1P event logging: OAuth token expired, skipping auth to avoid 401',
          )
        }
      }
    }

    // 根据是否跳过认证决定使用的请求头
    // Try with auth headers first (unless trust not established or token is known to be expired)
    const authResult = shouldSkipAuth
      ? { headers: {}, error: 'trust not established or Oauth token expired' }
      : getAuthHeaders()
    const useAuth = !authResult.error

    if (!useAuth && process.env.USER_TYPE === 'ant') {
      logForDebugging(
        `1P event logging: auth not available, sending without auth`,
      )
    }

    const headers = useAuth
      ? { ...baseHeaders, ...authResult.headers }
      : baseHeaders

    try {
      const response = await axios.post(this.endpoint, payload, {
        timeout: this.timeout,
        headers,
      })
      this.logSuccess(payload.events.length, useAuth, response.data)
      return
    } catch (error) {
      // 处理 401：使用了认证但收到 401 → 自动降为无认证重试（一次机会）
      if (
        useAuth &&
        axios.isAxiosError(error) &&
        error.response?.status === 401
      ) {
        if (process.env.USER_TYPE === 'ant') {
          logForDebugging(
            '1P event logging: 401 auth error, retrying without auth',
          )
        }
        const response = await axios.post(this.endpoint, payload, {
          timeout: this.timeout,
          headers: baseHeaders,  // 不含认证头的基础请求头
        })
        this.logSuccess(payload.events.length, false, response.data)
        return
      }

      throw error  // 其他错误向上抛出
    }
  }

  /** 记录成功导出日志（仅 ant 用户） */
  private logSuccess(
    eventCount: number,
    withAuth: boolean,
    responseData: unknown,
  ): void {
    if (process.env.USER_TYPE === 'ant') {
      logForDebugging(
        `1P event logging: ${eventCount} events exported successfully${withAuth ? ' (with auth)' : ' (without auth)'}`,
      )
      logForDebugging(`API Response: ${jsonStringify(responseData, null, 2)}`)
    }
  }

  /** 将 OTel HrTime（高精度时间元组）转换为 JavaScript Date 对象 */
  private hrTimeToDate(hrTime: HrTime): Date {
    const [seconds, nanoseconds] = hrTime
    return new Date(seconds * 1000 + nanoseconds / 1000000)
  }

  /**
   * 将 OTel ReadableLogRecord 列表转换为 1P API 事件格式
   *
   * 路由逻辑：
   * - attributes.event_type === 'GrowthbookExperimentEvent' → GrowthbookExperimentEvent proto
   * - 其他 → ClaudeCodeInternalEvent proto
   *
   * _PROTO_* 键处理（ClaudeCodeInternalEvent 路径）：
   * 1. 从 formatted.additional 解构已知的 _PROTO_* 键（skill_name、plugin_name、marketplace_name）
   * 2. 将这些键提升为 proto 顶层字段（映射到有访问控制的特权 BQ 列）
   * 3. 对 rest（剩余字段）调用 stripProtoFields() 防御性剥离未知的 _PROTO_* 键，
   *    防止将来新增的 _PROTO_foo 意外进入通用访问的 additional_metadata BQ JSON blob
   */
  private transformLogsToEvents(
    logs: ReadableLogRecord[],
  ): FirstPartyEventLoggingPayload {
    const events: FirstPartyEventLoggingEvent[] = []

    for (const log of logs) {
      const attributes = log.attributes || {}

      // 路由：GrowthBook 实验事件
      if (attributes.event_type === 'GrowthbookExperimentEvent') {
        const timestamp = this.hrTimeToDate(log.hrTime)
        const account_uuid = attributes.account_uuid as string | undefined
        const organization_uuid = attributes.organization_uuid as
          | string
          | undefined
        events.push({
          event_type: 'GrowthbookExperimentEvent',
          event_data: GrowthbookExperimentEvent.toJSON({
            event_id: attributes.event_id as string,
            timestamp,
            experiment_id: attributes.experiment_id as string,
            variation_id: attributes.variation_id as number,
            environment: attributes.environment as string,
            user_attributes: attributes.user_attributes as string,
            experiment_metadata: attributes.experiment_metadata as string,
            device_id: attributes.device_id as string,
            session_id: attributes.session_id as string,
            auth:
              account_uuid || organization_uuid
                ? { account_uuid, organization_uuid }
                : undefined,
          }),
        })
        continue
      }

      // 提取事件名（按优先级：event_name 属性 > log body > 'unknown'）
      const eventName =
        (attributes.event_name as string) || (log.body as string) || 'unknown'

      // 直接从 OTel attributes 提取元数据对象（无需 JSON 解析，OTel 支持嵌套对象）
      const coreMetadata = attributes.core_metadata as EventMetadata | undefined
      const userMetadata = attributes.user_metadata as CoreUserData
      const eventMetadata = (attributes.event_metadata || {}) as Record<
        string,
        unknown
      >

      if (!coreMetadata) {
        // core_metadata 缺失时发送部分事件（标记 transform_error，便于后端识别异常）
        if (process.env.USER_TYPE === 'ant') {
          logForDebugging(
            `1P event logging: core_metadata missing for event ${eventName}`,
          )
        }
        events.push({
          event_type: 'ClaudeCodeInternalEvent',
          event_data: ClaudeCodeInternalEvent.toJSON({
            event_id: attributes.event_id as string | undefined,
            event_name: eventName,
            client_timestamp: this.hrTimeToDate(log.hrTime),
            session_id: getSessionId(),
            additional_metadata: Buffer.from(
              jsonStringify({
                transform_error: 'core_metadata attribute is missing',
              }),
            ).toString('base64'),
          }),
        })
        continue
      }

      // 调用 to1PEventFormat() 将 EventMetadata 转换为 1P proto 格式各子对象
      const formatted = to1PEventFormat(
        coreMetadata,
        userMetadata,
        eventMetadata,
      )

      // _PROTO_* 键处理：
      // - 解构已知的 _PROTO_* 键，提升为 proto 顶层字段（特权 BQ 列）
      // - 对剩余字段防御性调用 stripProtoFields()，阻止未来新增的未知 _PROTO_* 键
      //   意外进入通用访问的 additional_metadata BQ JSON blob
      // _PROTO_* keys are PII-tagged values meant only for privileged BQ
      // columns. Hoist known keys to proto fields, then defensively strip any
      // remaining _PROTO_* so an unrecognized future key can't silently land
      // in the general-access additional_metadata blob. sink.ts applies the
      // same strip before Datadog; this closes the 1P side.
      const {
        _PROTO_skill_name,
        _PROTO_plugin_name,
        _PROTO_marketplace_name,
        ...rest
      } = formatted.additional
      const additionalMetadata = stripProtoFields(rest)  // 防御性剥离未知 _PROTO_* 键

      events.push({
        event_type: 'ClaudeCodeInternalEvent',
        event_data: ClaudeCodeInternalEvent.toJSON({
          event_id: attributes.event_id as string | undefined,
          event_name: eventName,
          client_timestamp: this.hrTimeToDate(log.hrTime),
          device_id: attributes.user_id as string | undefined,
          email: userMetadata?.email,
          auth: formatted.auth,
          ...formatted.core,
          env: formatted.env,
          process: formatted.process,
          // 将已知 _PROTO_* 键提升为 proto 字段（仅接受 string 类型）
          skill_name:
            typeof _PROTO_skill_name === 'string'
              ? _PROTO_skill_name
              : undefined,
          plugin_name:
            typeof _PROTO_plugin_name === 'string'
              ? _PROTO_plugin_name
              : undefined,
          marketplace_name:
            typeof _PROTO_marketplace_name === 'string'
              ? _PROTO_marketplace_name
              : undefined,
          // 将剩余附加元数据序列化为 base64 JSON（存入通用访问的 BQ 列）
          additional_metadata:
            Object.keys(additionalMetadata).length > 0
              ? Buffer.from(jsonStringify(additionalMetadata)).toString(
                  'base64',
                )
              : undefined,
        }),
      })
    }

    return { events }
  }

  /**
   * OTel LogRecordExporter 接口：关闭导出器
   * 置 isShutdown 标志，取消退避定时器，等待所有进行中的导出完成
   */
  async shutdown(): Promise<void> {
    this.isShutdown = true
    this.resetBackoff()  // 取消退避定时器
    await this.forceFlush()  // 等待所有进行中的导出完成
    if (process.env.USER_TYPE === 'ant') {
      logForDebugging('1P event logging exporter shutdown complete')
    }
  }

  /**
   * OTel LogRecordExporter 接口：强制刷新
   * 等待所有进行中的导出 Promise 完成（用于 forceFlush() 和 shutdown()）
   */
  async forceFlush(): Promise<void> {
    await Promise.all(this.pendingExports)
    if (process.env.USER_TYPE === 'ant') {
      logForDebugging('1P event logging exporter flush complete')
    }
  }
}

/**
 * 从 Axios 错误中提取结构化错误上下文字符串
 *
 * 提取内容（按优先级拼接）：
 * - response.headers['request-id']（服务端请求 ID，用于追踪）
 * - response.status（HTTP 状态码）
 * - error.code（Axios 错误码，如 ECONNREFUSED）
 * - error.message（错误消息）
 *
 * 非 Axios 错误直接返回 errorMessage(error)。
 */
function getAxiosErrorContext(error: unknown): string {
  if (!axios.isAxiosError(error)) {
    return errorMessage(error)
  }

  const parts: string[] = []

  // 服务端请求 ID（用于追踪和调试）
  const requestId = error.response?.headers?.['request-id']
  if (requestId) {
    parts.push(`request-id=${requestId}`)
  }

  // HTTP 状态码
  if (error.response?.status) {
    parts.push(`status=${error.response.status}`)
  }

  // Axios 错误码（如 ECONNREFUSED、ETIMEDOUT 等）
  if (error.code) {
    parts.push(`code=${error.code}`)
  }

  // 错误消息
  if (error.message) {
    parts.push(error.message)
  }

  return parts.join(', ')
}
