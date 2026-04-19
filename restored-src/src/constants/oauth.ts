/**
 * OAuth 2.0 认证配置
 *
 * 本文件集中管理 Claude Code 的 OAuth 认证配置，支持三种环境：
 * - prod（生产环境）：默认配置，面向所有用户
 * - staging（预发布环境）：仅限 Anthropic 内部员工（USER_TYPE=ant），
 *   通过 USE_STAGING_OAUTH 环境变量启用
 * - local（本地开发环境）：仅限 ant 员工，通过 USE_LOCAL_OAUTH 启用，
 *   默认连接 localhost:8000/4000/3000，可通过环境变量覆盖
 *
 * 安全特性：
 * - CLAUDE_CODE_CUSTOM_OAUTH_URL 支持 FedStart/PubSec 部署，
 *   但只允许白名单中的端点，防止 OAuth token 被发送到任意地址
 * - CLAUDE_CODE_OAUTH_CLIENT_ID 允许为 Xcode 等集成覆盖客户端 ID
 *
 * OAuth 流程：
 * 1. 用户通过 CONSOLE_AUTHORIZE_URL 或 CLAUDE_AI_AUTHORIZE_URL 授权
 * 2. 使用 TOKEN_URL 换取访问令牌
 * 3. 使用 API_KEY_URL 创建 API 密钥（Console 路径）或直接推理（Claude.ai 路径）
 *
 * 使用 MCP OAuth（CIMD/SEP-991）时，MCP_CLIENT_METADATA_URL 作为客户端 ID
 * 指向 Anthropic 托管的 JSON 元数据文档。
 */
import { isEnvTruthy } from 'src/utils/envUtils.js'

// OAuth 配置类型：生产/预发布/本地
type OauthConfigType = 'prod' | 'staging' | 'local'

/**
 * 根据环境变量确定当前使用的 OAuth 配置类型。
 *
 * 优先级：local > staging > prod（仅 ant 用户可切换到非 prod 配置）
 */
function getOauthConfigType(): OauthConfigType {
  if (process.env.USER_TYPE === 'ant') {
    if (isEnvTruthy(process.env.USE_LOCAL_OAUTH)) {
      return 'local'  // 本地开发环境，连接 localhost
    }
    if (isEnvTruthy(process.env.USE_STAGING_OAUTH)) {
      return 'staging'  // 预发布环境
    }
  }
  return 'prod'  // 默认生产环境
}

/**
 * 返回当前 OAuth 配置对应的文件名后缀，用于区分不同环境的 token 存储文件。
 * 例如：prod 无后缀，staging 为 "-staging-oauth"，local 为 "-local-oauth"。
 */
export function fileSuffixForOauthConfig(): string {
  if (process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL) {
    return '-custom-oauth'  // 自定义 OAuth URL（FedStart 部署）
  }
  switch (getOauthConfigType()) {
    case 'local':
      return '-local-oauth'
    case 'staging':
      return '-staging-oauth'
    case 'prod':
      // 生产配置无后缀
      return ''
  }
}

// Claude.ai 推理权限 scope
export const CLAUDE_AI_INFERENCE_SCOPE = 'user:inference' as const
// Claude.ai 用户资料 scope
export const CLAUDE_AI_PROFILE_SCOPE = 'user:profile' as const
// Console API 密钥创建 scope（内部使用，不对外暴露）
const CONSOLE_SCOPE = 'org:create_api_key' as const
// OAuth beta 请求头标识
export const OAUTH_BETA_HEADER = 'oauth-2025-04-20' as const

// Console OAuth scopes - 用于通过 Console 创建 API 密钥
export const CONSOLE_OAUTH_SCOPES = [
  CONSOLE_SCOPE,
  CLAUDE_AI_PROFILE_SCOPE,
] as const

// Claude.ai OAuth scopes - 用于 Claude.ai 订阅用户（Pro/Max/Team/Enterprise）直接推理
export const CLAUDE_AI_OAUTH_SCOPES = [
  CLAUDE_AI_PROFILE_SCOPE,
  CLAUDE_AI_INFERENCE_SCOPE,
  'user:sessions:claude_code',  // Claude Code 会话管理
  'user:mcp_servers',           // MCP 服务器访问
  'user:file_upload',           // 文件上传权限
] as const

// 完整 OAuth scopes - Console 和 Claude.ai scopes 的并集
// 登录时请求全部 scopes，以便同时支持 Console → Claude.ai 重定向流程
// 注意：apps 仓库的 OAuthConsentPage 需与此列表保持同步
export const ALL_OAUTH_SCOPES = Array.from(
  new Set([...CONSOLE_OAUTH_SCOPES, ...CLAUDE_AI_OAUTH_SCOPES]),
)

// OAuth 配置结构定义
type OauthConfig = {
  BASE_API_URL: string           // API 基础 URL
  CONSOLE_AUTHORIZE_URL: string  // Console 授权页面 URL
  CLAUDE_AI_AUTHORIZE_URL: string // Claude.ai 授权页面 URL
  /**
   * Claude.ai 网页来源（origin）。与 CLAUDE_AI_AUTHORIZE_URL 分开定义，
   * 因为授权 URL 现在通过 claude.com/cai/* 路由以进行归因统计——
   * 从该 URL 推导 .origin 会得到 claude.com，导致 /code、/settings/connectors
   * 等 claude.ai 页面链接失效。
   */
  CLAUDE_AI_ORIGIN: string
  TOKEN_URL: string              // Token 交换端点
  API_KEY_URL: string            // API 密钥创建端点
  ROLES_URL: string              // 用户角色查询端点
  CONSOLE_SUCCESS_URL: string    // Console 授权成功回调 URL
  CLAUDEAI_SUCCESS_URL: string   // Claude.ai 授权成功回调 URL
  MANUAL_REDIRECT_URL: string    // 手动重定向 URL（用于非浏览器环境）
  CLIENT_ID: string              // OAuth 客户端 ID
  OAUTH_FILE_SUFFIX: string      // token 文件存储后缀
  MCP_PROXY_URL: string          // MCP 代理服务器 URL
  MCP_PROXY_PATH: string         // MCP 代理路径模板（含 {server_id} 占位符）
}

// 生产环境 OAuth 配置 - 正常运行时使用
const PROD_OAUTH_CONFIG = {
  BASE_API_URL: 'https://api.anthropic.com',
  CONSOLE_AUTHORIZE_URL: 'https://platform.claude.com/oauth/authorize',
  // 通过 claude.com/cai/* 中转，用于将 CLI 登录归因到 claude.com 访问
  // 经两次 307 跳转最终到达 claude.ai/oauth/authorize
  CLAUDE_AI_AUTHORIZE_URL: 'https://claude.com/cai/oauth/authorize',
  CLAUDE_AI_ORIGIN: 'https://claude.ai',
  TOKEN_URL: 'https://platform.claude.com/v1/oauth/token',
  API_KEY_URL: 'https://api.anthropic.com/api/oauth/claude_cli/create_api_key',
  ROLES_URL: 'https://api.anthropic.com/api/oauth/claude_cli/roles',
  CONSOLE_SUCCESS_URL:
    'https://platform.claude.com/buy_credits?returnUrl=/oauth/code/success%3Fapp%3Dclaude-code',
  CLAUDEAI_SUCCESS_URL:
    'https://platform.claude.com/oauth/code/success?app=claude-code',
  MANUAL_REDIRECT_URL: 'https://platform.claude.com/oauth/code/callback',
  CLIENT_ID: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
  // 生产配置无后缀
  OAUTH_FILE_SUFFIX: '',
  MCP_PROXY_URL: 'https://mcp-proxy.anthropic.com',
  MCP_PROXY_PATH: '/v1/mcp/{server_id}',
} as const

/**
 * MCP OAuth 的客户端 ID 元数据文档 URL（CIMD / SEP-991）。
 * 当 MCP 认证服务器声明支持 client_id_metadata_document_supported: true 时，
 * Claude Code 使用此 URL 作为 client_id，而不是动态客户端注册（DCR）。
 * 该 URL 必须指向 Anthropic 托管的 JSON 文档。
 * 参见：https://datatracker.ietf.org/doc/html/draft-ietf-oauth-client-id-metadata-document-00
 */
export const MCP_CLIENT_METADATA_URL =
  'https://claude.ai/oauth/claude-code-client-metadata'

// 预发布环境 OAuth 配置 - 仅包含在 ant 构建中且需要 staging 标志
// 使用字面量检查以支持 dead code elimination（外部构建时整个块被移除）
const STAGING_OAUTH_CONFIG =
  process.env.USER_TYPE === 'ant'
    ? ({
        BASE_API_URL: 'https://api-staging.anthropic.com',
        CONSOLE_AUTHORIZE_URL:
          'https://platform.staging.ant.dev/oauth/authorize',
        CLAUDE_AI_AUTHORIZE_URL:
          'https://claude-ai.staging.ant.dev/oauth/authorize',
        CLAUDE_AI_ORIGIN: 'https://claude-ai.staging.ant.dev',
        TOKEN_URL: 'https://platform.staging.ant.dev/v1/oauth/token',
        API_KEY_URL:
          'https://api-staging.anthropic.com/api/oauth/claude_cli/create_api_key',
        ROLES_URL:
          'https://api-staging.anthropic.com/api/oauth/claude_cli/roles',
        CONSOLE_SUCCESS_URL:
          'https://platform.staging.ant.dev/buy_credits?returnUrl=/oauth/code/success%3Fapp%3Dclaude-code',
        CLAUDEAI_SUCCESS_URL:
          'https://platform.staging.ant.dev/oauth/code/success?app=claude-code',
        MANUAL_REDIRECT_URL:
          'https://platform.staging.ant.dev/oauth/code/callback',
        CLIENT_ID: '22422756-60c9-4084-8eb7-27705fd5cf9a',
        OAUTH_FILE_SUFFIX: '-staging-oauth',
        MCP_PROXY_URL: 'https://mcp-proxy-staging.anthropic.com',
        MCP_PROXY_PATH: '/v1/mcp/{server_id}',
      } as const)
    : undefined

/**
 * 构建本地开发环境的 OAuth 配置。
 *
 * 三个本地服务器：
 * - :8000 → api-proxy（`api dev start -g ccr`）
 * - :4000 → claude-ai 前端
 * - :3000 → Console 前端
 *
 * 可通过以下环境变量覆盖默认端口（供 scripts/claude-localhost 使用）：
 * - CLAUDE_LOCAL_OAUTH_API_BASE
 * - CLAUDE_LOCAL_OAUTH_APPS_BASE
 * - CLAUDE_LOCAL_OAUTH_CONSOLE_BASE
 */
function getLocalOauthConfig(): OauthConfig {
  // 读取各服务器基础 URL，去除尾部斜杠，默认使用 localhost
  const api =
    process.env.CLAUDE_LOCAL_OAUTH_API_BASE?.replace(/\/$/, '') ??
    'http://localhost:8000'
  const apps =
    process.env.CLAUDE_LOCAL_OAUTH_APPS_BASE?.replace(/\/$/, '') ??
    'http://localhost:4000'
  const consoleBase =
    process.env.CLAUDE_LOCAL_OAUTH_CONSOLE_BASE?.replace(/\/$/, '') ??
    'http://localhost:3000'
  return {
    BASE_API_URL: api,
    CONSOLE_AUTHORIZE_URL: `${consoleBase}/oauth/authorize`,
    CLAUDE_AI_AUTHORIZE_URL: `${apps}/oauth/authorize`,
    CLAUDE_AI_ORIGIN: apps,
    TOKEN_URL: `${api}/v1/oauth/token`,
    API_KEY_URL: `${api}/api/oauth/claude_cli/create_api_key`,
    ROLES_URL: `${api}/api/oauth/claude_cli/roles`,
    CONSOLE_SUCCESS_URL: `${consoleBase}/buy_credits?returnUrl=/oauth/code/success%3Fapp%3Dclaude-code`,
    CLAUDEAI_SUCCESS_URL: `${consoleBase}/oauth/code/success?app=claude-code`,
    MANUAL_REDIRECT_URL: `${consoleBase}/oauth/code/callback`,
    CLIENT_ID: '22422756-60c9-4084-8eb7-27705fd5cf9a',
    OAUTH_FILE_SUFFIX: '-local-oauth',
    MCP_PROXY_URL: 'http://localhost:8205',
    MCP_PROXY_PATH: '/v1/toolbox/shttp/mcp/{server_id}',
  }
}

// 允许使用 CLAUDE_CODE_CUSTOM_OAUTH_URL 覆盖的 OAuth 基础 URL 白名单。
// 仅允许 FedStart/PubSec 部署，防止 OAuth token 被发送到任意端点。
const ALLOWED_OAUTH_BASE_URLS = [
  'https://beacon.claude-ai.staging.ant.dev',
  'https://claude.fedstart.com',
  'https://claude-staging.fedstart.com',
]

/**
 * 获取当前环境的 OAuth 配置（默认生产，可通过环境变量切换）。
 *
 * 工作流程：
 * 1. 根据 getOauthConfigType() 选择 local/staging/prod 基础配置
 * 2. 如果设置了 CLAUDE_CODE_CUSTOM_OAUTH_URL，校验白名单后覆盖所有 URL
 * 3. 如果设置了 CLAUDE_CODE_OAUTH_CLIENT_ID，覆盖客户端 ID（如 Xcode 集成）
 * 4. 返回最终配置对象
 */
export function getOauthConfig(): OauthConfig {
  // 步骤 1：选择基础配置
  let config: OauthConfig = (() => {
    switch (getOauthConfigType()) {
      case 'local':
        return getLocalOauthConfig()
      case 'staging':
        // staging 配置仅在 ant 构建中存在，否则回退到 prod
        return STAGING_OAUTH_CONFIG ?? PROD_OAUTH_CONFIG
      case 'prod':
        return PROD_OAUTH_CONFIG
    }
  })()

  // 步骤 2：处理 FedStart/PubSec 自定义 OAuth URL 覆盖
  // 仅允许白名单中的端点，防止凭证泄露到任意地址
  const oauthBaseUrl = process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL
  if (oauthBaseUrl) {
    const base = oauthBaseUrl.replace(/\/$/, '')  // 去除尾部斜杠
    if (!ALLOWED_OAUTH_BASE_URLS.includes(base)) {
      throw new Error(
        'CLAUDE_CODE_CUSTOM_OAUTH_URL is not an approved endpoint.',
      )
    }
    // 将所有 URL 重定向到自定义端点
    config = {
      ...config,
      BASE_API_URL: base,
      CONSOLE_AUTHORIZE_URL: `${base}/oauth/authorize`,
      CLAUDE_AI_AUTHORIZE_URL: `${base}/oauth/authorize`,
      CLAUDE_AI_ORIGIN: base,
      TOKEN_URL: `${base}/v1/oauth/token`,
      API_KEY_URL: `${base}/api/oauth/claude_cli/create_api_key`,
      ROLES_URL: `${base}/api/oauth/claude_cli/roles`,
      CONSOLE_SUCCESS_URL: `${base}/oauth/code/success?app=claude-code`,
      CLAUDEAI_SUCCESS_URL: `${base}/oauth/code/success?app=claude-code`,
      MANUAL_REDIRECT_URL: `${base}/oauth/code/callback`,
      OAUTH_FILE_SUFFIX: '-custom-oauth',
    }
  }

  // 步骤 3：处理客户端 ID 覆盖（如 Xcode 集成等第三方集成场景）
  const clientIdOverride = process.env.CLAUDE_CODE_OAUTH_CLIENT_ID
  if (clientIdOverride) {
    config = {
      ...config,
      CLIENT_ID: clientIdOverride,
    }
  }

  return config
}
