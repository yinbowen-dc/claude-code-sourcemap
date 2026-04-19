/**
 * 【管理员请求 API 模块】api/adminRequests.ts
 *
 * 在 Claude Code 系统流程中的位置：
 * - 属于 API 服务层，封装了与 Anthropic 后端的管理员请求（Admin Request）交互
 * - 被用于 Team/Enterprise 用户的配额申请和席位升级流程
 * - 通过 OAuth 认证（Bearer token + 组织 UUID）与 Anthropic 的 Organization API 通信
 * - 依赖 teleport/api.ts 的 prepareApiRequest() 获取访问令牌和组织 UUID
 *
 * 核心功能：
 * - createAdminRequest(): 创建新的管理员请求（限额申请或席位升级），若同类型请求已存在则返回现有请求
 * - getMyAdminRequests(): 查询当前用户指定类型和状态的管理员请求列表
 * - checkAdminRequestEligibility(): 检查当前组织是否有权创建指定类型的管理员请求
 *
 * 适用场景：
 * - 非管理员/非计费权限的 Team/Enterprise 用户申请提高使用限额或升级席位
 * - 管理员可在后台审核并批准/拒绝这些请求
 */

import axios from 'axios'
import { getOauthConfig } from '../../constants/oauth.js'
import { getOAuthHeaders, prepareApiRequest } from '../../utils/teleport/api.js'

/** 管理员请求类型：限额申请或席位升级 */
export type AdminRequestType = 'limit_increase' | 'seat_upgrade'

/** 管理员请求状态：待审核、已批准或已忽略 */
export type AdminRequestStatus = 'pending' | 'approved' | 'dismissed'

/** 席位升级请求的附加详情（可选的用户消息和当前席位级别） */
export type AdminRequestSeatUpgradeDetails = {
  message?: string | null
  current_seat_tier?: string | null
}

/**
 * 创建管理员请求时的参数类型
 *
 * 使用联合类型确保 request_type 与 details 的类型一致性：
 * - 'limit_increase'：details 必须为 null（无额外详情）
 * - 'seat_upgrade'：details 包含席位升级所需的详情字段
 */
export type AdminRequestCreateParams =
  | {
      request_type: 'limit_increase'
      details: null
    }
  | {
      request_type: 'seat_upgrade'
      details: AdminRequestSeatUpgradeDetails
    }

/**
 * 管理员请求的完整数据结构
 *
 * 包含请求的基础字段（uuid、status、requester_uuid、created_at）
 * 以及与请求类型对应的 details 字段（联合类型）
 */
export type AdminRequest = {
  uuid: string
  status: AdminRequestStatus
  requester_uuid?: string | null
  created_at: string
} & (
  | {
      request_type: 'limit_increase'
      details: null
    }
  | {
      request_type: 'seat_upgrade'
      details: AdminRequestSeatUpgradeDetails
    }
)

/**
 * 为当前用户创建一个管理员请求（限额申请或席位升级）
 *
 * 适用场景：
 * - Team/Enterprise 用户没有计费/管理员权限，但需要申请更高限额或席位升级
 * - 创建后，其组织的管理员可以在后台审核并处理该请求
 *
 * 幂等性：若该用户已存在同类型的 pending 请求，返回现有请求而非创建新请求
 *
 * Create an admin request (limit increase or seat upgrade).
 *
 * For Team/Enterprise users who don't have billing/admin permissions,
 * this creates a request that their admin can act on.
 *
 * If a pending request of the same type already exists for this user,
 * returns the existing request instead of creating a new one.
 */
export async function createAdminRequest(
  params: AdminRequestCreateParams,
): Promise<AdminRequest> {
  // 获取 OAuth 访问令牌和组织 UUID（prepareApiRequest 负责刷新和验证）
  const { accessToken, orgUUID } = await prepareApiRequest()

  // 构建包含 OAuth Bearer token 和组织标识的请求头
  const headers = {
    ...getOAuthHeaders(accessToken),
    'x-organization-uuid': orgUUID,
  }

  // 构建 API 端点 URL（路径包含组织 UUID）
  const url = `${getOauthConfig().BASE_API_URL}/api/oauth/organizations/${orgUUID}/admin_requests`

  // 通过 POST 请求创建管理员请求
  const response = await axios.post<AdminRequest>(url, params, { headers })

  return response.data
}

/**
 * 获取当前用户指定类型和状态的管理员请求列表
 *
 * 通过 request_type 和 statuses 过滤，返回当前用户提交的管理员请求列表
 * （若不存在符合条件的请求，则返回 null）
 *
 * Get pending admin request of a specific type for the current user.
 *
 * Returns the pending request if one exists, otherwise null.
 */
export async function getMyAdminRequests(
  requestType: AdminRequestType,
  statuses: AdminRequestStatus[],
): Promise<AdminRequest[] | null> {
  // 获取 OAuth 令牌和组织 UUID
  const { accessToken, orgUUID } = await prepareApiRequest()

  // 构建请求头（含 OAuth 认证和组织标识）
  const headers = {
    ...getOAuthHeaders(accessToken),
    'x-organization-uuid': orgUUID,
  }

  // 构建带查询参数的 URL（request_type 和多个 statuses 参数）
  let url = `${getOauthConfig().BASE_API_URL}/api/oauth/organizations/${orgUUID}/admin_requests/me?request_type=${requestType}`
  for (const status of statuses) {
    url += `&statuses=${status}` // 追加每个 status 过滤条件
  }

  // 通过 GET 请求查询用户的管理员请求列表
  const response = await axios.get<AdminRequest[] | null>(url, {
    headers,
  })

  return response.data
}

/** 管理员请求资格检查结果 */
type AdminRequestEligibilityResponse = {
  request_type: AdminRequestType
  is_allowed: boolean
}

/**
 * 检查当前组织是否有权创建指定类型的管理员请求
 *
 * 在用户触发申请流程前，先通过此接口检查资格，
 * 防止不符合条件的组织提交无效请求。
 *
 * Check if a specific admin request type is allowed for this org.
 */
export async function checkAdminRequestEligibility(
  requestType: AdminRequestType,
): Promise<AdminRequestEligibilityResponse | null> {
  // 获取 OAuth 令牌和组织 UUID
  const { accessToken, orgUUID } = await prepareApiRequest()

  // 构建请求头（含 OAuth 认证和组织标识）
  const headers = {
    ...getOAuthHeaders(accessToken),
    'x-organization-uuid': orgUUID,
  }

  // 构建资格检查端点 URL（带 request_type 查询参数）
  const url = `${getOauthConfig().BASE_API_URL}/api/oauth/organizations/${orgUUID}/admin_requests/eligibility?request_type=${requestType}`

  // 通过 GET 请求检查资格
  const response = await axios.get<AdminRequestEligibilityResponse>(url, {
    headers,
  })

  return response.data
}
