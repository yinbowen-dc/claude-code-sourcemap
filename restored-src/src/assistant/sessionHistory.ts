// 会话历史分页加载模块 - 用于从 Anthropic API 拉取会话历史消息
import axios from 'axios'
import { getOauthConfig } from '../constants/oauth.js'
import type { SDKMessage } from '../entrypoints/agentSdkTypes.js'
import { logForDebugging } from '../utils/debug.js'
import { getOAuthHeaders, prepareApiRequest } from '../utils/teleport/api.js'

// 默认每页加载的消息数量
export const HISTORY_PAGE_SIZE = 100

/**
 * 历史页面数据结构
 * 表示一次分页请求返回的结果
 */
export type HistoryPage = {
  /** 本页的消息列表，按时间顺序排列（从旧到新） */
  events: SDKMessage[]
  /** 本页最旧消息的ID，作为获取下一页的游标 */
  firstId: string | null
  /** 是否还有更早的历史消息 */
  hasMore: boolean
}

/**
 * API 响应数据结构
 * 对应 Anthropic API 的原始响应格式
 */
type SessionEventsResponse = {
  data: SDKMessage[]        // 消息数据数组
  has_more: boolean         // 是否还有更多数据
  first_id: string | null   // 第一项消息的ID
  last_id: string | null    // 最后一项消息的ID
}

/**
 * 认证上下文
 * 包含请求所需的基础URL和认证头信息，可复用于多次请求
 */
export type HistoryAuthCtx = {
  baseUrl: string                   // 基础API地址
  headers: Record<string, string>   // 认证头信息
}

/**
 * 创建认证上下文
 * 一次性准备认证信息，避免重复鉴权操作
 * @param sessionId 会话ID
 * @returns 包含基础URL和认证头的上下文对象
 */
export async function createHistoryAuthCtx(
  sessionId: string,
): Promise<HistoryAuthCtx> {
  // 准备API请求所需的认证信息
  const { accessToken, orgUUID } = await prepareApiRequest()
  
  return {
    // 构建完整的API端点URL
    baseUrl: `${getOauthConfig().BASE_API_URL}/v1/sessions/${sessionId}/events`,
    headers: {
      ...getOAuthHeaders(accessToken),          // 基础认证头
      'anthropic-beta': 'ccr-byoc-2025-07-29',  // Beta功能标识
      'x-organization-uuid': orgUUID,           // 组织UUID
    },
  }
}

/**
 * 底层分页请求函数
 * 处理实际的HTTP请求、错误处理和响应解析
 * @param ctx 认证上下文
 * @param params 请求参数
 * @param label 调试标签
 * @returns 解析后的历史页面或null（请求失败时）
 */
async function fetchPage(
  ctx: HistoryAuthCtx,
  params: Record<string, string | number | boolean>,
  label: string,
): Promise<HistoryPage | null> {
  // 发送HTTP GET请求
  const resp = await axios
    .get<SessionEventsResponse>(ctx.baseUrl, {
      headers: ctx.headers,          // 使用预置的认证头
      params,                        // 查询参数
      timeout: 15000,                // 15秒超时
      validateStatus: () => true,    // 接收所有状态码，不抛出异常
    })
    .catch(() => null)               // 捕获所有异常，返回null
  
  // 检查响应状态
  if (!resp || resp.status !== 200) {
    // 记录调试信息
    logForDebugging(`[${label}] HTTP ${resp?.status ?? 'error'}`)
    return null
  }
  
  // 解析响应数据
  return {
    events: Array.isArray(resp.data.data) ? resp.data.data : [],  // 确保数据是数组
    firstId: resp.data.first_id,      // 最旧消息ID
    hasMore: resp.data.has_more,      // 是否还有更多数据
  }
}

/**
 * 获取最新的事件页面
 * 用于初次加载或刷新时获取最新的消息
 * @param ctx 认证上下文
 * @param limit 每页数量，默认为HISTORY_PAGE_SIZE
 * @returns 最新的事件页面或null
 */
export async function fetchLatestEvents(
  ctx: HistoryAuthCtx,
  limit = HISTORY_PAGE_SIZE,
): Promise<HistoryPage | null> {
  // 使用 anchor_to_latest 参数获取最新消息
  return fetchPage(ctx, { limit, anchor_to_latest: true }, 'fetchLatestEvents')
}

/**
 * 获取更早的事件页面
 * 用于分页加载历史消息（向前翻页）
 * @param ctx 认证上下文
 * @param beforeId 游标ID，表示要获取这个ID之前的消息
 * @param limit 每页数量，默认为HISTORY_PAGE_SIZE
 * @returns 更早的事件页面或null
 */
export async function fetchOlderEvents(
  ctx: HistoryAuthCtx,
  beforeId: string,
  limit = HISTORY_PAGE_SIZE,
): Promise<HistoryPage | null> {
  // 使用 before_id 参数获取指定游标之前的历史消息
  return fetchPage(ctx, { limit, before_id: beforeId }, 'fetchOlderEvents')
}
