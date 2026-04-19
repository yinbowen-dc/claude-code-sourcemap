/**
 * 后台远程会话前置条件检测模块。
 *
 * 在 Claude Code 系统中，该模块提供一组独立的异步前置条件检测函数，
 * 供 checkBackgroundRemoteSessionEligibility() 等调用方在启动远程会话前进行校验：
 * - checkNeedsClaudeAiLogin()：是否需要 claude.ai OAuth 登录
 * - checkIsGitClean()：工作目录是否干净（忽略未跟踪文件）
 * - checkHasRemoteEnvironment()：是否有可用的远程环境
 * - checkIsInGitRepo()：当前目录是否在 git 仓库中
 * - checkHasGitRemote()：当前仓库是否有 GitHub remote
 * - checkGithubAppInstalled()：指定仓库是否已安装 GitHub App
 * - checkGithubTokenSynced()：用户是否通过 /web-setup 同步了 GitHub token
 * - checkRepoForRemoteAccess()：分层检测仓库访问方式（GitHub App > token sync > none）
 */
import axios from 'axios'
import { getOauthConfig } from 'src/constants/oauth.js'
import { getOrganizationUUID } from 'src/services/oauth/client.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../../services/analytics/growthbook.js'
import {
  checkAndRefreshOAuthTokenIfNeeded,
  getClaudeAIOAuthTokens,
  isClaudeAISubscriber,
} from '../../auth.js'
import { getCwd } from '../../cwd.js'
import { logForDebugging } from '../../debug.js'
import { detectCurrentRepository } from '../../detectRepository.js'
import { errorMessage } from '../../errors.js'
import { findGitRoot, getIsClean } from '../../git.js'
import { getOAuthHeaders } from '../../teleport/api.js'
import { fetchEnvironments } from '../../teleport/environments.js'

/**
 * 检测用户是否需要通过 claude.ai 登录（OAuth token 缺失或已失效）。
 * 非 claude.ai 订阅用户直接返回 false。
 */
export async function checkNeedsClaudeAiLogin(): Promise<boolean> {
  if (!isClaudeAISubscriber()) {
    return false
  }
  return checkAndRefreshOAuthTokenIfNeeded()
}

/**
 * 检测 git 工作目录是否干净（未提交的已跟踪文件变更为空）。
 * 忽略未跟踪文件，因为分支切换不会丢失这些文件。
 */
export async function checkIsGitClean(): Promise<boolean> {
  const isClean = await getIsClean({ ignoreUntracked: true })
  return isClean
}

/**
 * 检测用户是否有至少一个可用的远程环境。
 * 获取失败时返回 false（不抛出错误）。
 */
export async function checkHasRemoteEnvironment(): Promise<boolean> {
  try {
    const environments = await fetchEnvironments()
    return environments.length > 0
  } catch (error) {
    logForDebugging(`checkHasRemoteEnvironment failed: ${errorMessage(error)}`)
    return false
  }
}

/**
 * 检测当前目录是否在 git 仓库中（存在 .git/ 目录）。
 * 注意：本地纯仓库（无 remote）可通过此检测但不能通过 checkHasGitRemote。
 */
export function checkIsInGitRepo(): boolean {
  return findGitRoot(getCwd()) !== null
}

/**
 * 检测当前仓库是否配置了 GitHub remote（origin）。
 * 仅本地仓库（无 remote）返回 false。
 */
export async function checkHasGitRemote(): Promise<boolean> {
  const repository = await detectCurrentRepository()
  return repository !== null
}

/**
 * 检测指定 GitHub 仓库是否已安装 GitHub App。
 * 通过 claude.ai OAuth token 调用 API 查询；4xx 错误视为未安装；其他错误返回 false。
 * @param owner 仓库所属组织或用户名
 * @param repo 仓库名称
 */
export async function checkGithubAppInstalled(
  owner: string,
  repo: string,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    // 获取 OAuth access token，无 token 则认为未安装
    const accessToken = getClaudeAIOAuthTokens()?.accessToken
    if (!accessToken) {
      logForDebugging(
        'checkGithubAppInstalled: No access token found, assuming app not installed',
      )
      return false
    }

    // 获取组织 UUID，用于构建 API 请求路径
    const orgUUID = await getOrganizationUUID()
    if (!orgUUID) {
      logForDebugging(
        'checkGithubAppInstalled: No org UUID found, assuming app not installed',
      )
      return false
    }

    // 构建查询仓库访问状态的 API URL
    const url = `${getOauthConfig().BASE_API_URL}/api/oauth/organizations/${orgUUID}/code/repos/${owner}/${repo}`
    const headers = {
      ...getOAuthHeaders(accessToken),
      'x-organization-uuid': orgUUID,
    }

    logForDebugging(`Checking GitHub app installation for ${owner}/${repo}`)

    const response = await axios.get<{
      repo: {
        name: string
        owner: { login: string }
        default_branch: string
      }
      status: {
        app_installed: boolean
        relay_enabled: boolean
      } | null
    }>(url, {
      headers,
      timeout: 15000,
      signal,
    })

    if (response.status === 200) {
      if (response.data.status) {
        // status 字段存在时，读取 app_installed 字段判断安装状态
        const installed = response.data.status.app_installed
        logForDebugging(
          `GitHub app ${installed ? 'is' : 'is not'} installed on ${owner}/${repo}`,
        )
        return installed
      }
      // status 为 null 时表示 GitHub App 未安装在该仓库
      logForDebugging(
        `GitHub app is not installed on ${owner}/${repo} (status is null)`,
      )
      return false
    }

    logForDebugging(
      `checkGithubAppInstalled: Unexpected response status ${response.status}`,
    )
    return false
  } catch (error) {
    // 4xx 错误通常表示 App 未安装或仓库不可访问，视为未安装
    if (axios.isAxiosError(error)) {
      const status = error.response?.status
      if (status && status >= 400 && status < 500) {
        logForDebugging(
          `checkGithubAppInstalled: Got ${status} error, app likely not installed on ${owner}/${repo}`,
        )
        return false
      }
    }

    logForDebugging(`checkGithubAppInstalled error: ${errorMessage(error)}`)
    return false
  }
}

/**
 * 检测用户是否已通过 /web-setup 同步了 GitHub token。
 * 通过调用 sync/github/auth API 判断；4xx 错误视为未同步。
 */
export async function checkGithubTokenSynced(): Promise<boolean> {
  try {
    const accessToken = getClaudeAIOAuthTokens()?.accessToken
    if (!accessToken) {
      logForDebugging('checkGithubTokenSynced: No access token found')
      return false
    }

    const orgUUID = await getOrganizationUUID()
    if (!orgUUID) {
      logForDebugging('checkGithubTokenSynced: No org UUID found')
      return false
    }

    // 查询 GitHub auth 同步状态的 API 端点
    const url = `${getOauthConfig().BASE_API_URL}/api/oauth/organizations/${orgUUID}/sync/github/auth`
    const headers = {
      ...getOAuthHeaders(accessToken),
      'x-organization-uuid': orgUUID,
    }

    logForDebugging('Checking if GitHub token is synced via web-setup')

    const response = await axios.get(url, {
      headers,
      timeout: 15000,
    })

    // 200 响应且 is_authenticated 为 true 表示已同步
    const synced =
      response.status === 200 && response.data?.is_authenticated === true
    logForDebugging(
      `GitHub token synced: ${synced} (status=${response.status}, data=${JSON.stringify(response.data)})`,
    )
    return synced
  } catch (error) {
    // 4xx 错误通常表示 token 未同步，视为 false
    if (axios.isAxiosError(error)) {
      const status = error.response?.status
      if (status && status >= 400 && status < 500) {
        logForDebugging(
          `checkGithubTokenSynced: Got ${status}, token not synced`,
        )
        return false
      }
    }

    logForDebugging(`checkGithubTokenSynced error: ${errorMessage(error)}`)
    return false
  }
}

type RepoAccessMethod = 'github-app' | 'token-sync' | 'none'

/**
 * 分层检测指定 GitHub 仓库是否可用于远程操作，返回访问方式：
 * 1. `github-app`：GitHub App 已安装
 * 2. `token-sync`：用户已通过 /web-setup 同步 GitHub token（需 tengu_cobalt_lantern 特性开关）
 * 3. `none`：均不满足，需提示用户配置访问权限
 */
export async function checkRepoForRemoteAccess(
  owner: string,
  repo: string,
): Promise<{ hasAccess: boolean; method: RepoAccessMethod }> {
  if (await checkGithubAppInstalled(owner, repo)) {
    return { hasAccess: true, method: 'github-app' }
  }
  if (
    getFeatureValue_CACHED_MAY_BE_STALE('tengu_cobalt_lantern', false) &&
    (await checkGithubTokenSynced())
  ) {
    return { hasAccess: true, method: 'token-sync' }
  }
  return { hasAccess: false, method: 'none' }
}
