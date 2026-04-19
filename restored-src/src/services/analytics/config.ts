/**
 * 【分析配置模块】analytics/config.ts
 *
 * 在 Claude Code 系统流程中的位置：
 * - 这是分析（analytics）子系统的基础配置文件
 * - 被 analytics/datadog.ts、analytics/index.ts、analytics/sink.ts 等所有分析模块引用
 * - 提供统一的"是否禁用分析"判断逻辑，避免各模块各自重复判断环境变量
 *
 * 核心功能：
 * - isAnalyticsDisabled(): 判断当前环境是否应完全禁用数据采集（测试环境或第三方云）
 * - isFeedbackSurveyDisabled(): 判断是否应禁用反馈调查（仅考虑隐私级别，不排除第三方云）
 *
 * Shared analytics configuration
 *
 * Common logic for determining when analytics should be disabled
 * across all analytics systems (Datadog, 1P)
 */

import { isEnvTruthy } from '../../utils/envUtils.js'
import { isTelemetryDisabled } from '../../utils/privacyLevel.js'

/**
 * 判断是否应完全禁用分析功能
 *
 * 以下情况之一满足则返回 true（禁用分析）：
 * 1. 测试环境（NODE_ENV === 'test'）：防止测试数据污染生产环境的分析数据
 * 2. 使用第三方云服务（Bedrock/Vertex/Foundry）：这些用户的数据不应上报给 Anthropic
 * 3. 隐私级别设置为 no-telemetry 或 essential-traffic
 *
 * Check if analytics operations should be disabled
 *
 * Analytics is disabled in the following cases:
 * - Test environment (NODE_ENV === 'test')
 * - Third-party cloud providers (Bedrock/Vertex)
 * - Privacy level is no-telemetry or essential-traffic
 */
export function isAnalyticsDisabled(): boolean {
  return (
    process.env.NODE_ENV === 'test' || // 测试环境：禁用以避免污染生产数据
    isEnvTruthy(process.env.CLAUDE_CODE_USE_BEDROCK) || // AWS Bedrock 用户：禁用 Anthropic 分析
    isEnvTruthy(process.env.CLAUDE_CODE_USE_VERTEX) || // Google Vertex 用户：禁用 Anthropic 分析
    isEnvTruthy(process.env.CLAUDE_CODE_USE_FOUNDRY) || // Azure Foundry 用户：禁用 Anthropic 分析
    isTelemetryDisabled() // 用户隐私设置为禁用遥测
  )
}

/**
 * 判断是否应禁用反馈调查
 *
 * 与 isAnalyticsDisabled() 的区别：
 * - 不排除第三方云服务（Bedrock/Vertex/Foundry）用户
 * - 原因：反馈调查是纯本地 UI 提示，不传输会话内容；企业用户通过 OTEL 自行采集响应
 * - 仅在测试环境或用户明确禁用遥测时才禁用
 *
 * Check if the feedback survey should be suppressed.
 *
 * Unlike isAnalyticsDisabled(), this does NOT block on 3P providers
 * (Bedrock/Vertex/Foundry). The survey is a local UI prompt with no
 * transcript data — enterprise customers capture responses via OTEL.
 */
export function isFeedbackSurveyDisabled(): boolean {
  return process.env.NODE_ENV === 'test' || isTelemetryDisabled()
}
