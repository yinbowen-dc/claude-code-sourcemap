/**
 * API 提供商检测工具（API Provider Detection）
 *
 * 【在 Claude Code 系统流中的位置】
 * 本文件是模型系统最基础的环境感知模块，被几乎所有与提供商相关的模块依赖
 * （configs.ts、model.ts、bedrock.ts、modelStrings.ts 等）。
 * 它通过读取环境变量确定当前 Claude Code 运行于哪种 API 提供商环境，
 * 以便其他模块选择正确的模型 ID 格式、认证方式和功能集。
 *
 * 【主要功能】
 * 1. getAPIProvider              — 根据环境变量判断当前提供商（firstParty/bedrock/vertex/foundry）
 * 2. getAPIProviderForStatsig    — 获取用于统计分析的提供商标识（类型安全包装）
 * 3. isFirstPartyAnthropicBaseUrl — 检测 ANTHROPIC_BASE_URL 是否指向 Anthropic 官方 API
 */

import type { AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from '../../services/analytics/index.js'
import { isEnvTruthy } from '../envUtils.js'

// 四种受支持的 API 提供商类型
export type APIProvider = 'firstParty' | 'bedrock' | 'vertex' | 'foundry'

/**
 * 根据环境变量判断当前使用的 API 提供商。
 *
 * 【优先级顺序】（高 → 低）
 * 1. CLAUDE_CODE_USE_BEDROCK=1  → 'bedrock'（AWS Bedrock）
 * 2. CLAUDE_CODE_USE_VERTEX=1   → 'vertex'（Google Cloud Vertex AI）
 * 3. CLAUDE_CODE_USE_FOUNDRY=1  → 'foundry'（Azure AI Foundry）
 * 4. 默认                       → 'firstParty'（Anthropic 官方 API）
 *
 * 使用嵌套三元表达式按优先级依次检测，保证互斥性。
 */
export function getAPIProvider(): APIProvider {
  return isEnvTruthy(process.env.CLAUDE_CODE_USE_BEDROCK)
    ? 'bedrock'
    : isEnvTruthy(process.env.CLAUDE_CODE_USE_VERTEX)
      ? 'vertex'
      : isEnvTruthy(process.env.CLAUDE_CODE_USE_FOUNDRY)
        ? 'foundry'
        : 'firstParty' // 未设置任何 3P 环境变量时默认为官方 API
}

/**
 * 获取用于 Statsig 分析系统的 API 提供商标识。
 * 对 getAPIProvider() 的结果进行类型强制转换，以满足分析元数据的类型约束。
 * 类型名称中的长后缀（_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS）是防止
 * 敏感字符串误入分析管道的安全约束标记。
 */
export function getAPIProviderForStatsig(): AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS {
  return getAPIProvider() as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
}

/**
 * 检测 ANTHROPIC_BASE_URL 是否指向 Anthropic 官方 API 域名。
 *
 * 【返回 true 的条件】
 * - ANTHROPIC_BASE_URL 未设置（使用默认 API）
 * - 域名为 api.anthropic.com
 * - 用户类型为 'ant' 时，域名也可以是 api-staging.anthropic.com（内部测试环境）
 *
 * 【用途】
 * modelCapabilities.ts 用此函数决定是否从 /v1/models 端点拉取能力元数据
 * （仅对官方 API 端点有效，第三方无此接口）。
 */
export function isFirstPartyAnthropicBaseUrl(): boolean {
  const baseUrl = process.env.ANTHROPIC_BASE_URL
  // 未自定义 base URL，使用默认官方 API
  if (!baseUrl) {
    return true
  }
  try {
    const host = new URL(baseUrl).host
    // 默认允许的官方域名列表
    const allowedHosts = ['api.anthropic.com']
    // ant 内部用户额外允许预发布环境域名
    if (process.env.USER_TYPE === 'ant') {
      allowedHosts.push('api-staging.anthropic.com')
    }
    return allowedHosts.includes(host)
  } catch {
    // URL 解析失败（格式非法），保守返回 false
    return false
  }
}
