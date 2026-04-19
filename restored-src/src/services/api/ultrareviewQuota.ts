/**
 * Ultrareview 配额查询模块
 *
 * 在 Claude Code 系统流程中的位置：
 *   Claude Code 展示 Ultrareview 功能入口前 → 调用 fetchUltrareviewQuota() 获取配额信息
 *   → 根据剩余量和是否超额决定是否展示功能入口或超额提示
 *
 * 主要功能：
 *  - fetchUltrareviewQuota — 查询当前组织的 Ultrareview 配额使用情况
 *
 * 设计特点：
 *  - 订阅用户门控：非 Claude.ai 订阅用户直接返回 null，不发起请求
 *  - 静默失败：API 调用失败时记录调试日志并返回 null，不影响主流程
 *  - 消费发生在服务端（创建会话时），此接口仅用于查询配额状态以供 UI 展示
 */

import axios from 'axios'
import { getOauthConfig } from '../../constants/oauth.js'
import { isClaudeAISubscriber } from '../../utils/auth.js'
import { logForDebugging } from '../../utils/debug.js'
import { getOAuthHeaders, prepareApiRequest } from '../../utils/teleport/api.js'

/** Ultrareview 配额响应结构 */
export type UltrareviewQuotaResponse = {
  reviews_used: number      // 本周期已使用的 Ultrareview 次数
  reviews_limit: number     // 本周期 Ultrareview 配额上限
  reviews_remaining: number // 本周期剩余可用次数
  is_overage: boolean       // 是否已超额（超额时可能产生额外费用）
}

/**
 * 查询当前组织的 Ultrareview 配额使用情况（仅供展示和提示决策使用）。
 *
 * 注意：Ultrareview 配额的实际消费发生在服务端的会话创建阶段，
 * 本函数仅查询当前配额状态，用于 UI 展示和超额提示。
 *
 * 流程：
 *  1. 非订阅用户 → 直接返回 null（不发起请求）
 *  2. 准备 OAuth 认证信息（accessToken + orgUUID）
 *  3. 调用 GET /v1/ultrareview/quota，5 秒超时
 *  4. 返回配额响应；失败时记录调试日志并返回 null
 *
 * @returns 配额信息；非订阅用户或请求失败时返回 null
 */
export async function fetchUltrareviewQuota(): Promise<UltrareviewQuotaResponse | null> {
  // 非订阅用户不具备 Ultrareview 功能，直接返回 null
  if (!isClaudeAISubscriber()) return null
  try {
    // 准备 OAuth 认证信息（访问令牌 + 组织 UUID）
    const { accessToken, orgUUID } = await prepareApiRequest()
    const response = await axios.get<UltrareviewQuotaResponse>(
      `${getOauthConfig().BASE_API_URL}/v1/ultrareview/quota`,
      {
        headers: {
          ...getOAuthHeaders(accessToken),
          'x-organization-uuid': orgUUID, // 标识当前组织，服务端按组织隔离配额
        },
        timeout: 5000, // 5 秒超时，避免阻塞 UI 渲染
      },
    )
    return response.data
  } catch (error) {
    // 静默失败：记录调试日志后返回 null，不影响主功能流程
    logForDebugging(`fetchUltrareviewQuota failed: ${error}`)
    return null
  }
}
