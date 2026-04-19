/**
 * telemetry/bigqueryExporter.ts — 自定义 OTel 指标导出器（BigQuery/Anthropic API）
 *
 * 在 Claude Code 的可观测性体系中，本文件实现了一个自定义的 OpenTelemetry
 * PushMetricExporter，将收集到的指标数据推送到 Anthropic 的内部指标 API
 * （https://api.anthropic.com/api/claude_code/metrics），最终写入 BigQuery。
 *
 * 核心设计：
 *   - 实现 OTel PushMetricExporter 接口，集成到标准的 MeterProvider 流程
 *   - 使用 DELTA 聚合时态（Aggregation Temporality），适合计数器类型指标
 *   - 在导出前进行两项前置检查：
 *     1. 信任对话框是否已接受（避免在非交互式场景中触发认证弹窗）
 *     2. 组织级别的指标上报是否已启用（遵循用户隐私偏好）
 *   - 维护 pendingExports 列表，确保 forceFlush 能等待所有进行中的导出完成
 *   - ant 用户支持通过 ANT_CLAUDE_CODE_METRICS_ENDPOINT 自定义端点
 *
 * 数据变换流程：
 *   OTel ResourceMetrics → InternalMetricsPayload → POST to Anthropic API
 */

import type { Attributes, HrTime } from '@opentelemetry/api'
import { type ExportResult, ExportResultCode } from '@opentelemetry/core'
import {
  AggregationTemporality,
  type MetricData,
  type DataPoint as OTelDataPoint,
  type PushMetricExporter,
  type ResourceMetrics,
} from '@opentelemetry/sdk-metrics'
import axios from 'axios'
import { checkMetricsEnabled } from 'src/services/api/metricsOptOut.js'
import { getIsNonInteractiveSession } from '../../bootstrap/state.js'
import { getSubscriptionType, isClaudeAISubscriber } from '../auth.js'
import { checkHasTrustDialogAccepted } from '../config.js'
import { logForDebugging } from '../debug.js'
import { errorMessage, toError } from '../errors.js'
import { getAuthHeaders } from '../http.js'
import { logError } from '../log.js'
import { jsonStringify } from '../slowOperations.js'
import { getClaudeCodeUserAgent } from '../userAgent.js'

/** 内部数据点格式：属性字典、数值和 ISO 时间戳 */
type DataPoint = {
  attributes: Record<string, string>
  value: number
  timestamp: string
}

/** 内部指标格式：描述符 + 数据点列表 */
type Metric = {
  name: string
  description?: string
  unit?: string
  data_points: DataPoint[]
}

/** 发送给 Anthropic API 的完整指标负载格式 */
type InternalMetricsPayload = {
  resource_attributes: Record<string, string>
  metrics: Metric[]
}

/**
 * Claude Code 自定义 BigQuery 指标导出器。
 *
 * 实现 OTel PushMetricExporter 接口，将指标批量推送到 Anthropic 内部指标 API。
 * 该类由 initializeTelemetry 在启动时实例化并注册到 MeterProvider。
 */
export class BigQueryMetricsExporter implements PushMetricExporter {
  /** 目标 API 端点（支持 ant 用户自定义） */
  private readonly endpoint: string
  /** HTTP 请求超时时间（毫秒），默认 5000 */
  private readonly timeout: number
  /** 进行中的导出 Promise 列表，用于 forceFlush 等待 */
  private pendingExports: Promise<void>[] = []
  /** 是否已关闭（关闭后拒绝新的导出请求） */
  private isShutdown = false

  /**
   * 构造函数：初始化端点和超时配置。
   *
   * ant 用户优先使用 ANT_CLAUDE_CODE_METRICS_ENDPOINT 环境变量指定的端点，
   * 其他用户使用默认的 Anthropic API 端点。
   */
  constructor(options: { timeout?: number } = {}) {
    const defaultEndpoint = 'https://api.anthropic.com/api/claude_code/metrics'

    // ant 内部用户可以通过环境变量指向内部端点
    if (
      process.env.USER_TYPE === 'ant' &&
      process.env.ANT_CLAUDE_CODE_METRICS_ENDPOINT
    ) {
      this.endpoint =
        process.env.ANT_CLAUDE_CODE_METRICS_ENDPOINT +
        '/api/claude_code/metrics'
    } else {
      this.endpoint = defaultEndpoint
    }

    // 超时默认 5 秒，调用方可以自定义
    this.timeout = options.timeout || 5000
  }

  /**
   * OTel PushMetricExporter 接口实现：接收指标数据并触发导出。
   *
   * 使用异步导出模式：将 doExport 添加到 pendingExports 列表，
   * 导出完成后自动从列表中移除。
   *
   * @param metrics        - OTel 资源指标数据
   * @param resultCallback - 导出完成后的回调（SUCCESS 或 FAILED）
   */
  async export(
    metrics: ResourceMetrics,
    resultCallback: (result: ExportResult) => void,
  ): Promise<void> {
    // 已关闭的导出器拒绝新请求
    if (this.isShutdown) {
      resultCallback({
        code: ExportResultCode.FAILED,
        error: new Error('Exporter has been shutdown'),
      })
      return
    }

    const exportPromise = this.doExport(metrics, resultCallback)
    // 追踪进行中的导出，forceFlush 需要等待所有导出完成
    this.pendingExports.push(exportPromise)

    // 导出完成后自动从追踪列表中移除（防止内存泄漏）
    void exportPromise.finally(() => {
      const index = this.pendingExports.indexOf(exportPromise)
      if (index > -1) {
        void this.pendingExports.splice(index, 1)
      }
    })
  }

  /**
   * 实际执行导出的私有方法。
   *
   * 执行流程：
   *   1. 检查信任对话框（交互模式下）→ 未接受则跳过
   *   2. 检查组织级指标上报设置 → 已禁用则跳过
   *   3. 调用 transformMetricsForInternal 转换数据格式
   *   4. 获取认证头（API Key 或 OAuth）
   *   5. POST 请求到指标 API 端点
   *   6. 处理成功/失败响应
   */
  private async doExport(
    metrics: ResourceMetrics,
    resultCallback: (result: ExportResult) => void,
  ): Promise<void> {
    try {
      // 在交互模式下，若用户未接受信任对话框，则跳过导出
      // 这样可以防止在信任对话框显示之前触发 API 认证助手
      const hasTrust =
        checkHasTrustDialogAccepted() || getIsNonInteractiveSession()
      if (!hasTrust) {
        logForDebugging(
          'BigQuery metrics export: trust not established, skipping',
        )
        resultCallback({ code: ExportResultCode.SUCCESS })
        return
      }

      // 检查组织级别的指标上报开关（由组织管理员控制）
      const metricsStatus = await checkMetricsEnabled()
      if (!metricsStatus.enabled) {
        logForDebugging('Metrics export disabled by organization setting')
        resultCallback({ code: ExportResultCode.SUCCESS })
        return
      }

      // 将 OTel 格式的指标数据转换为 Anthropic API 所需格式
      const payload = this.transformMetricsForInternal(metrics)

      // 获取认证头（支持 API Key 和 OAuth 两种认证方式）
      const authResult = getAuthHeaders()
      if (authResult.error) {
        logForDebugging(`Metrics export failed: ${authResult.error}`)
        resultCallback({
          code: ExportResultCode.FAILED,
          error: new Error(authResult.error),
        })
        return
      }

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'User-Agent': getClaudeCodeUserAgent(),
        ...authResult.headers, // 展开认证相关头（如 x-api-key 或 Authorization）
      }

      // 发送指标数据到 Anthropic 内部指标 API
      const response = await axios.post(this.endpoint, payload, {
        timeout: this.timeout,
        headers,
      })

      logForDebugging('BigQuery metrics exported successfully')
      logForDebugging(
        `BigQuery API Response: ${jsonStringify(response.data, null, 2)}`,
      )
      resultCallback({ code: ExportResultCode.SUCCESS })
    } catch (error) {
      logForDebugging(`BigQuery metrics export failed: ${errorMessage(error)}`)
      logError(error)
      resultCallback({
        code: ExportResultCode.FAILED,
        error: toError(error),
      })
    }
  }

  /**
   * 将 OTel ResourceMetrics 转换为 Anthropic 内部 API 所需的 InternalMetricsPayload 格式。
   *
   * 转换内容：
   *   - resource.attributes → resourceAttributes（提取 service.name/version、os、arch 等）
   *   - 附加 aggregation.temporality（delta/cumulative）
   *   - 附加用户类型（claude_ai / api）和订阅类型
   *   - 展平 scopeMetrics → metrics 数组（跳过 scope 层级）
   *
   * @param metrics - OTel 资源指标数据
   * @returns Anthropic API 期望的指标负载格式
   */
  private transformMetricsForInternal(
    metrics: ResourceMetrics,
  ): InternalMetricsPayload {
    const attrs = metrics.resource.attributes

    // 提取并标准化资源级属性
    const resourceAttributes: Record<string, string> = {
      'service.name': (attrs['service.name'] as string) || 'claude-code',
      'service.version': (attrs['service.version'] as string) || 'unknown',
      'os.type': (attrs['os.type'] as string) || 'unknown',
      'os.version': (attrs['os.version'] as string) || 'unknown',
      'host.arch': (attrs['host.arch'] as string) || 'unknown',
      // 聚合时态标记（DELTA = 增量，CUMULATIVE = 累积）
      'aggregation.temporality':
        this.selectAggregationTemporality() === AggregationTemporality.DELTA
          ? 'delta'
          : 'cumulative',
    }

    // WSL 版本：仅在存在时附加（不提供默认值）
    if (attrs['wsl.version']) {
      resourceAttributes['wsl.version'] = attrs['wsl.version'] as string
    }

    // 附加用户类型（Claude.ai 订阅用户 vs API 用户）及订阅计划
    if (isClaudeAISubscriber()) {
      resourceAttributes['user.customer_type'] = 'claude_ai'
      const subscriptionType = getSubscriptionType()
      if (subscriptionType) {
        resourceAttributes['user.subscription_type'] = subscriptionType
      }
    } else {
      resourceAttributes['user.customer_type'] = 'api'
    }

    // 展平 scopeMetrics 层级，将所有指标合并为一个平面数组
    const transformed = {
      resource_attributes: resourceAttributes,
      metrics: metrics.scopeMetrics.flatMap(scopeMetric =>
        scopeMetric.metrics.map(metric => ({
          name: metric.descriptor.name,
          description: metric.descriptor.description,
          unit: metric.descriptor.unit,
          data_points: this.extractDataPoints(metric),
        })),
      ),
    }

    return transformed
  }

  /**
   * 从单个 OTel 指标中提取并转换数据点列表。
   *
   * 过滤条件：仅处理数值类型的数据点（排除直方图等非数值类型）。
   * 时间戳优先级：endTime > startTime > 当前时间（转换为 HrTime 格式）。
   *
   * @param metric - 单个 OTel 指标数据
   * @returns 转换后的内部数据点数组
   */
  private extractDataPoints(metric: MetricData): DataPoint[] {
    const dataPoints = metric.dataPoints || []

    return dataPoints
      // 只处理数值类型的数据点（过滤非数值，如直方图桶数据）
      .filter(
        (point): point is OTelDataPoint<number> =>
          typeof point.value === 'number',
      )
      .map(point => ({
        // 将 OTel 属性转换为字符串键值对
        attributes: this.convertAttributes(point.attributes),
        value: point.value,
        // 优先使用结束时间，其次开始时间，最后使用当前时间
        timestamp: this.hrTimeToISOString(
          point.endTime || point.startTime || [Date.now() / 1000, 0],
        ),
      }))
  }

  /**
   * 关闭导出器：标记为已关闭并等待所有进行中的导出完成。
   */
  async shutdown(): Promise<void> {
    this.isShutdown = true
    await this.forceFlush()
    logForDebugging('BigQuery metrics exporter shutdown complete')
  }

  /**
   * 强制刷新：等待所有进行中的导出 Promise 完成。
   * 在程序退出或用户登出前调用，确保不丢失指标数据。
   */
  async forceFlush(): Promise<void> {
    await Promise.all(this.pendingExports)
    logForDebugging('BigQuery metrics exporter flush complete')
  }

  /**
   * 将 OTel Attributes 对象转换为字符串键值对字典。
   * undefined/null 值会被跳过（内部 API 只接受字符串值）。
   */
  private convertAttributes(
    attributes: Attributes | undefined,
  ): Record<string, string> {
    const result: Record<string, string> = {}
    if (attributes) {
      for (const [key, value] of Object.entries(attributes)) {
        if (value !== undefined && value !== null) {
          result[key] = String(value)
        }
      }
    }
    return result
  }

  /**
   * 将 OTel HrTime（[seconds, nanoseconds] 元组）转换为 ISO 8601 时间戳字符串。
   *
   * @param hrTime - [秒, 纳秒] 格式的高精度时间
   * @returns ISO 8601 格式的时间戳字符串
   */
  private hrTimeToISOString(hrTime: HrTime): string {
    const [seconds, nanoseconds] = hrTime
    // 秒转毫秒 + 纳秒转毫秒，构造 Date 对象
    const date = new Date(seconds * 1000 + nanoseconds / 1000000)
    return date.toISOString()
  }

  /**
   * 选择聚合时态：始终返回 DELTA（增量）。
   *
   * ⚠️ 警告：请勿将此改为 CUMULATIVE（累积）！
   * 改为 CUMULATIVE 会破坏 CC 生产力指标仪表板的聚合逻辑。
   * DELTA 时态意味着每次导出的数据代表自上次导出以来的增量，
   * 这是指标后端正确计算总量所必需的。
   */
  selectAggregationTemporality(): AggregationTemporality {
    // 警告：请勿修改为 CUMULATIVE，这会破坏指标聚合
    return AggregationTemporality.DELTA
  }
}
