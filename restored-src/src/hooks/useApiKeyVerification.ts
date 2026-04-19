/**
 * useApiKeyVerification.ts
 *
 * 【在系统流程中的位置】
 * 本文件属于 Claude Code 的「API Key 校验」子系统，是应用启动时验证
 * Anthropic API Key 有效性的核心 hook。
 *
 * 主要职责：
 * - 管理 API Key 校验的状态机（loading / valid / invalid / missing / error）；
 * - 在初始化时跳过 apiKeyHelper 执行（skipRetrievingKeyFromApiKeyHelper=true），
 *   防止在信任对话框展示前通过 settings.json 触发任意代码执行（RCE 风险）；
 * - 提供 reverify 回调，允许用户或系统在任意时刻重新发起校验；
 * - 如果 apiKeyHelper 已配置（但尚未执行），初始状态返回 'loading'，
 *   等待后续显式调用 verify 来完成真正的校验。
 */

import { useCallback, useState } from 'react'
import { getIsNonInteractiveSession } from '../bootstrap/state.js'
import { verifyApiKey } from '../services/api/claude.js'
import {
  getAnthropicApiKeyWithSource,
  getApiKeyFromApiKeyHelper,
  isAnthropicAuthEnabled,
  isClaudeAISubscriber,
} from '../utils/auth.js'

/** API Key 校验状态枚举：
 * - 'loading'：正在校验（key 存在或 apiKeyHelper 已配置但尚未执行）
 * - 'valid'：校验通过
 * - 'invalid'：API Key 无效（如 401 响应）
 * - 'missing'：未找到 API Key
 * - 'error'：校验过程中发生异常（非无效 key 错误）
 */
export type VerificationStatus =
  | 'loading'
  | 'valid'
  | 'invalid'
  | 'missing'
  | 'error'

/** API Key 校验结果类型：
 * - status：当前校验状态
 * - reverify：触发重新校验的回调函数
 * - error：最近一次校验的错误对象（仅 'error' 状态时非 null）
 */
export type ApiKeyVerificationResult = {
  status: VerificationStatus
  reverify: () => Promise<void>
  error: Error | null
}

/**
 * API Key 校验 hook。
 *
 * 状态初始化（惰性 useState）：
 * - 若 Anthropic 鉴权未启用或用户已是 Claude AI 订阅者，直接 'valid'；
 * - 初始化时使用 skipRetrievingKeyFromApiKeyHelper=true，
 *   避免在信任对话框前执行 apiKeyHelper（安全隔离）；
 * - 若已有 key 或来源为 apiKeyHelper，返回 'loading'（等待后续 verify）；
 * - 否则返回 'missing'。
 *
 * verify 回调流程：
 * 1. 检查鉴权条件（非 Anthropic 鉴权或订阅者直接 'valid'）；
 * 2. 预热 apiKeyHelper 缓存（若未配置则无操作）；
 * 3. 读取当前最新 key；
 * 4. 无 key 时处理 'missing' 或 'error' 状态；
 * 5. 调用 verifyApiKey 请求校验，更新为 'valid' 或 'invalid'；
 * 6. 若抛出异常，设置 'error' 状态并保存错误对象。
 */
export function useApiKeyVerification(): ApiKeyVerificationResult {
  // 惰性初始化状态：仅在首次渲染时执行初始化逻辑
  const [status, setStatus] = useState<VerificationStatus>(() => {
    if (!isAnthropicAuthEnabled() || isClaudeAISubscriber()) {
      return 'valid'
    }
    // Use skipRetrievingKeyFromApiKeyHelper to avoid executing apiKeyHelper
    // before trust dialog is shown (security: prevents RCE via settings.json)
    const { key, source } = getAnthropicApiKeyWithSource({
      skipRetrievingKeyFromApiKeyHelper: true,
    })
    // If apiKeyHelper is configured, we have a key source even though we
    // haven't executed it yet - return 'loading' to indicate we'll verify later
    if (key || source === 'apiKeyHelper') {
      return 'loading'
    }
    return 'missing'
  })
  // 最近一次校验的错误对象（仅 'error' 状态时非 null）
  const [error, setError] = useState<Error | null>(null)

  /**
   * 发起 API Key 校验的核心函数。
   * 使用 useCallback 包裹，依赖数组为空（无需随外部变量变化而重建）。
   */
  const verify = useCallback(async (): Promise<void> => {
    if (!isAnthropicAuthEnabled() || isClaudeAISubscriber()) {
      setStatus('valid')
      return
    }
    // Warm the apiKeyHelper cache (no-op if not configured), then read from
    // all sources. getAnthropicApiKeyWithSource() reads the now-warm cache.
    await getApiKeyFromApiKeyHelper(getIsNonInteractiveSession())
    const { key: apiKey, source } = getAnthropicApiKeyWithSource()
    if (!apiKey) {
      if (source === 'apiKeyHelper') {
        // apiKeyHelper 配置了但未返回有效 key，视为错误
        setStatus('error')
        setError(new Error('API key helper did not return a valid key'))
        return
      }
      const newStatus = 'missing'
      setStatus(newStatus)
      return
    }

    try {
      // 向 Anthropic API 发起校验请求（false 表示不使用缓存）
      const isValid = await verifyApiKey(apiKey, false)
      const newStatus = isValid ? 'valid' : 'invalid'
      setStatus(newStatus)
      return
    } catch (error) {
      // This happens when there an error response from the API but it's not an invalid API key error
      // In this case, we still mark the API key as invalid - but we also log the error so we can
      // display it to the user to be more helpful
      setError(error as Error)
      const newStatus = 'error'
      setStatus(newStatus)
      return
    }
  }, [])

  return {
    status,
    reverify: verify,  // 暴露 reverify 供外部触发重新校验
    error,
  }
}
