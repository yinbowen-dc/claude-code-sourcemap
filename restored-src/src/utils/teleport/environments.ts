/**
 * 【Teleport 环境资源模块】
 *
 * 在 Claude Code 系统流程中的位置：
 *   用户发起 Web Session（CCR/Teleport）请求
 *     → 本模块通过 OAuth 认证向 Anthropic 后端拉取可用的远程执行环境列表
 *     → 上层 environmentSelection.ts 使用本模块的结果确定最终选中的环境
 *     → Session 启动时将选中的 environment_id 写入 SessionContext
 *
 * 主要功能：
 *   1. 定义远程执行环境的核心类型（EnvironmentKind / EnvironmentResource 等）
 *   2. fetchEnvironments()  — 从 /v1/environment_providers 拉取环境列表
 *   3. createDefaultCloudEnvironment() — 当用户没有环境时，自动创建一个默认的
 *      anthropic_cloud 环境
 *
 * 认证依赖：
 *   - 必须通过 /login 完成 OAuth 认证，API Key 认证无效
 *   - 请求头携带 Bearer Token + Organization UUID
 */

import axios from 'axios'
import { getOauthConfig } from 'src/constants/oauth.js'
import { getOrganizationUUID } from 'src/services/oauth/client.js'
import { getClaudeAIOAuthTokens } from '../auth.js'
import { toError } from '../errors.js'
import { logError } from '../log.js'
import { getOAuthHeaders } from './api.js'

// 环境提供者的种类：Anthropic 官方云 / 用户自带云 / 桥接模式
export type EnvironmentKind = 'anthropic_cloud' | 'byoc' | 'bridge'
// 当前仅支持 'active' 状态的环境
export type EnvironmentState = 'active'

/**
 * 单个远程执行环境的资源描述对象，由后端 API 返回。
 * 包含标识信息（kind / environment_id / name）以及创建时间和运行状态。
 */
export type EnvironmentResource = {
  kind: EnvironmentKind
  environment_id: string
  name: string
  created_at: string
  state: EnvironmentState
}

/**
 * /v1/environment_providers 接口的分页响应结构。
 * has_more 表示还有更多页，first_id / last_id 用于游标翻页。
 */
export type EnvironmentListResponse = {
  environments: EnvironmentResource[]
  has_more: boolean
  first_id: string | null
  last_id: string | null
}

/**
 * 从 Anthropic 后端拉取当前用户可用的远程执行环境列表。
 *
 * 执行流程：
 *   1. 从本地 OAuth 缓存中读取 accessToken，未登录则抛错提示用户执行 /login
 *   2. 获取组织 UUID（多租户场景下区分不同组织）
 *   3. 构造带 OAuth 头 + x-organization-uuid 头的 GET 请求
 *   4. 请求超时 15 秒，防止 UI 卡顿
 *   5. 解析响应并返回 environments 数组
 *
 * @returns Promise<EnvironmentResource[]> 可用环境数组
 * @throws 未认证 / 无法获取组织 UUID / API 请求失败时抛出 Error
 */
export async function fetchEnvironments(): Promise<EnvironmentResource[]> {
  // 从缓存读取 OAuth 访问令牌；未登录时令牌为 undefined
  const accessToken = getClaudeAIOAuthTokens()?.accessToken
  if (!accessToken) {
    // 明确提示：Web Session 必须使用 Claude.ai 账号认证，API Key 不够
    throw new Error(
      'Claude Code web sessions require authentication with a Claude.ai account. API key authentication is not sufficient. Please run /login to authenticate, or check your authentication status with /status.',
    )
  }

  // 获取组织 UUID，用于多租户环境隔离
  const orgUUID = await getOrganizationUUID()
  if (!orgUUID) {
    throw new Error('Unable to get organization UUID')
  }

  // 构造 API 端点 URL，BASE_API_URL 来自 OAuth 配置
  const url = `${getOauthConfig().BASE_API_URL}/v1/environment_providers`

  try {
    // 合并 OAuth 标准头与组织 UUID 头
    const headers = {
      ...getOAuthHeaders(accessToken),
      'x-organization-uuid': orgUUID,
    }

    // 发起 GET 请求，15 秒超时避免长时间阻塞
    const response = await axios.get<EnvironmentListResponse>(url, {
      headers,
      timeout: 15000,
    })

    // 仅 200 为成功，其他状态码视为错误
    if (response.status !== 200) {
      throw new Error(
        `Failed to fetch environments: ${response.status} ${response.statusText}`,
      )
    }

    // 返回环境列表（忽略分页信息，当前仅取第一页）
    return response.data.environments
  } catch (error) {
    // 统一将 axios 错误转换为标准 Error 对象，并写入日志
    const err = toError(error)
    logError(err)
    throw new Error(`Failed to fetch environments: ${err.message}`)
  }
}

/**
 * 为没有任何环境的用户自动创建一个默认的 anthropic_cloud 环境。
 *
 * 执行流程：
 *   1. 获取 accessToken 和 orgUUID（同 fetchEnvironments）
 *   2. 向 /v1/environment_providers/cloud/create 发起 POST 请求
 *   3. 请求体包含默认语言运行时（Python 3.11 + Node 20）和网络配置
 *   4. 携带 anthropic-beta 头以启用 BYOC 功能
 *   5. 返回新创建的 EnvironmentResource
 *
 * @param name 新环境的显示名称
 * @returns 新创建的 EnvironmentResource 对象
 */
export async function createDefaultCloudEnvironment(
  name: string,
): Promise<EnvironmentResource> {
  // 同样需要 OAuth 令牌，否则无法调用创建接口
  const accessToken = getClaudeAIOAuthTokens()?.accessToken
  if (!accessToken) {
    throw new Error('No access token available')
  }
  const orgUUID = await getOrganizationUUID()
  if (!orgUUID) {
    throw new Error('Unable to get organization UUID')
  }

  // 创建端点专属路径，区别于列表接口
  const url = `${getOauthConfig().BASE_API_URL}/v1/environment_providers/cloud/create`
  const response = await axios.post<EnvironmentResource>(
    url,
    {
      name,
      kind: 'anthropic_cloud', // 固定为 Anthropic 官方云类型
      description: '',
      config: {
        environment_type: 'anthropic',
        cwd: '/home/user',            // 默认工作目录
        init_script: null,            // 无自定义初始化脚本
        environment: {},              // 无额外环境变量
        languages: [
          { name: 'python', version: '3.11' }, // 预装 Python 3.11
          { name: 'node', version: '20' },      // 预装 Node.js 20
        ],
        network_config: {
          allowed_hosts: [],          // 无额外白名单
          allow_default_hosts: true,  // 开放默认可访问域名
        },
      },
    },
    {
      headers: {
        ...getOAuthHeaders(accessToken),
        'anthropic-beta': 'ccr-byoc-2025-07-29', // 启用 BYOC beta 功能标记
        'x-organization-uuid': orgUUID,
      },
      timeout: 15000,
    },
  )
  return response.data
}
