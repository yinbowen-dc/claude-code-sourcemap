/**
 * remote-setup/api.ts —— Web 设置流程的 API 交互层
 *
 * 在整体流程中的位置：
 *   /web-setup 命令 → remote-setup.js UI 组件 → 调用本文件中的函数
 *   与 Anthropic CCR 后端交互，完成 GitHub Token 导入和默认环境创建
 *
 * 模块职责：
 *   1. RedactedGithubToken —— 安全包装 GitHub PAT，防止令牌在日志/序列化中泄露
 *   2. importGithubToken   —— 将 GitHub 令牌 POST 到 CCR 后端，完成验证与加密存储
 *   3. createDefaultEnvironment —— 为首次设置的用户自动创建默认云端运行环境
 *   4. isSignedIn          —— 检查当前 OAuth 凭证是否有效
 *   5. getCodeWebUrl       —— 返回 claude.ai/code 的完整 URL
 *
 * 安全设计要点：
 *   GitHub PAT 通过 RedactedGithubToken 包装，toString/toJSON/inspect 均返回
 *   "[REDACTED:gh-token]"，仅在 HTTP body 组装时通过 reveal() 解包，
 *   从根源上防止令牌在错误日志、调试输出或序列化中意外暴露。
 */
import axios from 'axios'
import { getOauthConfig } from '../../constants/oauth.js'
import { logForDebugging } from '../../utils/debug.js'
import { getOAuthHeaders, prepareApiRequest } from '../../utils/teleport/api.js'
import { fetchEnvironments } from '../../utils/teleport/environments.js'

// CCR BYOC（Bring Your Own Credentials）功能的 Beta API 版本标识头
const CCR_BYOC_BETA_HEADER = 'ccr-byoc-2025-07-29'

/**
 * RedactedGithubToken —— GitHub 令牌的安全包装类
 *
 * 设计目标：
 *   在令牌生命周期内，确保其原始值仅在 HTTP body 组装这一个安全点暴露，
 *   任何其他路径（日志、JSON 序列化、模板字符串、Node.js inspect）均输出
 *   "[REDACTED:gh-token]" 占位符，杜绝令牌意外泄露到日志文件或错误报告中。
 *
 * 使用方式：
 *   const token = new RedactedGithubToken(rawPat)
 *   // 仅在发送 HTTP 请求体时调用 reveal()
 *   axios.post(url, { token: token.reveal() })
 */
export class RedactedGithubToken {
  readonly #value: string // 私有字段，防止通过属性访问泄露
  constructor(raw: string) {
    this.#value = raw
  }
  /** 返回原始令牌字符串，仅应在 HTTP 请求体组装处调用 */
  reveal(): string {
    return this.#value
  }
  /** 拦截 String() / 模板字符串，返回脱敏占位符 */
  toString(): string {
    return '[REDACTED:gh-token]'
  }
  /** 拦截 JSON.stringify，防止令牌出现在序列化输出中 */
  toJSON(): string {
    return '[REDACTED:gh-token]'
  }
  /** 拦截 Node.js util.inspect，防止令牌出现在调试输出中 */
  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return '[REDACTED:gh-token]'
  }
}

/** importGithubToken 成功时的返回数据：包含 GitHub 用户名 */
export type ImportTokenResult = {
  github_username: string
}

/** importGithubToken 失败时的错误类型（判别联合） */
export type ImportTokenError =
  | { kind: 'not_signed_in' }           // 未登录或 OAuth token 无效
  | { kind: 'invalid_token' }           // GitHub PAT 无效或权限不足
  | { kind: 'server'; status: number }  // 后端返回非预期的 HTTP 状态码
  | { kind: 'network' }                 // 网络连接失败

/**
 * importGithubToken —— 将 GitHub PAT 上传至 CCR 后端完成绑定
 *
 * 流程：
 *   1. 调用 prepareApiRequest 获取当前用户的 OAuth accessToken 和 orgUUID
 *      失败（未登录）时提前返回 not_signed_in 错误
 *   2. 向 /v1/code/github/import-token 发送 POST 请求，
 *      携带 CCR BYOC Beta 头和 x-organization-uuid 头
 *   3. 后端校验 GitHub 令牌有效性后，以 Fernet 加密存储在 sync_user_tokens 表中，
 *      后续 clone/push 操作可直接使用该存储的令牌
 *   4. 根据 HTTP 状态码映射到具体错误类型，网络层异常统一归为 network 类型
 *
 * 安全说明：令牌仅通过 token.reveal() 在请求体中传输，不会出现在任何日志中
 *
 * @param token 已包装的 GitHub PAT
 * @returns     成功时 { ok: true, result }，失败时 { ok: false, error }
 */
export async function importGithubToken(
  token: RedactedGithubToken,
): Promise<
  | { ok: true; result: ImportTokenResult }
  | { ok: false; error: ImportTokenError }
> {
  let accessToken: string, orgUUID: string
  try {
    // 获取当前用户的 OAuth 凭证和组织 UUID，失败说明未登录
    ;({ accessToken, orgUUID } = await prepareApiRequest())
  } catch {
    return { ok: false, error: { kind: 'not_signed_in' } }
  }

  // 构造 import-token 接口 URL
  const url = `${getOauthConfig().BASE_API_URL}/v1/code/github/import-token`
  const headers = {
    ...getOAuthHeaders(accessToken),                   // 标准 OAuth 鉴权头
    'anthropic-beta': CCR_BYOC_BETA_HEADER,            // BYOC Beta 功能标识
    'x-organization-uuid': orgUUID,                    // 组织归属标识
  }

  try {
    const response = await axios.post<ImportTokenResult>(
      url,
      { token: token.reveal() }, // 唯一调用 reveal() 的位置，令牌仅出现在请求体中
      { headers, timeout: 15000, validateStatus: () => true }, // 15s 超时，不让 axios 抛 HTTP 错误
    )
    if (response.status === 200) {
      return { ok: true, result: response.data } // 导入成功
    }
    if (response.status === 400) {
      return { ok: false, error: { kind: 'invalid_token' } } // GitHub PAT 无效
    }
    if (response.status === 401) {
      return { ok: false, error: { kind: 'not_signed_in' } } // OAuth 凭证过期
    }
    // 其他非预期状态码，记录调试日志但不抛出
    logForDebugging(`import-token returned ${response.status}`, {
      level: 'error',
    })
    return { ok: false, error: { kind: 'server', status: response.status } }
  } catch (err) {
    if (axios.isAxiosError(err)) {
      // err.config.data would contain the POST body with the raw token.
      // Do not include it in any log. The error code alone is enough.
      // 注意：err.config.data 含有请求体（含令牌），绝对不能打印；只记录错误码
      logForDebugging(`import-token network error: ${err.code ?? 'unknown'}`, {
        level: 'error',
      })
    }
    return { ok: false, error: { kind: 'network' } }
  }
}

/**
 * hasExistingEnvironment —— 检查用户是否已有远程运行环境
 * 用于防止重复创建默认环境
 */
async function hasExistingEnvironment(): Promise<boolean> {
  try {
    const envs = await fetchEnvironments()
    return envs.length > 0 // 已存在至少一个环境
  } catch {
    return false // 获取失败时保守判断为无环境，后续创建逻辑会处理
  }
}

/**
 * createDefaultEnvironment —— 为首次设置的用户自动创建默认云端环境
 *
 * 流程：
 *   1. 获取 OAuth 凭证，失败时返回 false（尽力而为，不阻塞主流程）
 *   2. 检查是否已存在环境，若有则跳过创建（防止重复执行 /web-setup 堆积环境）
 *   3. 向 /v1/environment_providers/cloud/create 发送 POST，
 *      创建预设的 Anthropic Cloud 环境（Python 3.11 + Node 20，允许默认网络）
 *   4. 任何失败均静默返回 false，因为令牌导入已成功，
 *      web 状态机会在下次加载时自动回退到环境设置流程
 *
 * @returns true 表示创建成功或已存在环境；false 表示失败（不影响主流程）
 */
export async function createDefaultEnvironment(): Promise<boolean> {
  let accessToken: string, orgUUID: string
  try {
    ;({ accessToken, orgUUID } = await prepareApiRequest())
  } catch {
    return false // 未登录，跳过环境创建
  }

  // 已有环境则无需重复创建
  if (await hasExistingEnvironment()) {
    return true
  }

  // The /private/organizations/{org}/ path rejects CLI OAuth tokens (wrong
  // auth dep). The public path uses build_flexible_auth — same path
  // fetchEnvironments() uses. Org is passed via x-organization-uuid header.
  // 使用公共路径（build_flexible_auth），通过 x-organization-uuid 传递组织信息
  const url = `${getOauthConfig().BASE_API_URL}/v1/environment_providers/cloud/create`
  const headers = {
    ...getOAuthHeaders(accessToken),
    'x-organization-uuid': orgUUID,
  }

  try {
    const response = await axios.post(
      url,
      {
        name: 'Default',
        kind: 'anthropic_cloud',
        description: 'Default - trusted network access',
        config: {
          environment_type: 'anthropic',
          cwd: '/home/user',       // 默认工作目录
          init_script: null,       // 无自定义初始化脚本
          environment: {},         // 无额外环境变量
          languages: [
            { name: 'python', version: '3.11' }, // 预装 Python 3.11
            { name: 'node', version: '20' },      // 预装 Node.js 20
          ],
          network_config: {
            allowed_hosts: [],         // 无额外允许域名
            allow_default_hosts: true, // 开启默认网络访问
          },
        },
      },
      { headers, timeout: 15000, validateStatus: () => true },
    )
    return response.status >= 200 && response.status < 300 // 2xx 即为成功
  } catch {
    return false // 网络失败，尽力而为，静默降级
  }
}

/** isSignedIn —— 通过尝试准备 API 请求来检测当前 OAuth 凭证是否有效 */
export async function isSignedIn(): Promise<boolean> {
  try {
    await prepareApiRequest() // 若凭证无效会抛出异常
    return true
  } catch {
    return false
  }
}

/** getCodeWebUrl —— 返回 claude.ai/code 的完整 URL，用于引导用户跳转 */
export function getCodeWebUrl(): string {
  return `${getOauthConfig().CLAUDE_AI_ORIGIN}/code`
}
