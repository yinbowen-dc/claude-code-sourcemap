/**
 * 后台远程会话类型与资格检测模块。
 *
 * 在 Claude Code 系统中，该模块定义后台远程会话（BackgroundRemoteSession）的数据结构，
 * 并提供 checkBackgroundRemoteSessionEligibility() 函数，
 * 在创建远程会话前依次检测一组前置条件（policy、登录、远程环境、git 仓库、GitHub App 等），
 * 返回所有失败的前置条件列表（空数组表示全部通过）。
 * Bundle seed 模式下（tengu_ccr_bundle_seed_enabled 特性开关开启）仅需存在 .git/ 目录，
 * 跳过 GitHub remote 和 App 安装检测。
 */
import type { SDKMessage } from 'src/entrypoints/agentSdkTypes.js'
import { checkGate_CACHED_OR_BLOCKING } from '../../../services/analytics/growthbook.js'
import { isPolicyAllowed } from '../../../services/policyLimits/index.js'
import { detectCurrentRepositoryWithHost } from '../../detectRepository.js'
import { isEnvTruthy } from '../../envUtils.js'
import type { TodoList } from '../../todo/types.js'
import {
  checkGithubAppInstalled,
  checkHasRemoteEnvironment,
  checkIsInGitRepo,
  checkNeedsClaudeAiLogin,
} from './preconditions.js'

/**
 * 后台远程会话类型，用于管理 teleport 远程代理任务
 */
export type BackgroundRemoteSession = {
  id: string
  command: string
  startTime: number
  status: 'starting' | 'running' | 'completed' | 'failed' | 'killed'
  todoList: TodoList
  title: string
  type: 'remote_session'
  log: SDKMessage[]
}

/**
 * 后台远程会话前置条件失败类型，枚举所有可能的检测失败原因
 */
export type BackgroundRemoteSessionPrecondition =
  | { type: 'not_logged_in' }
  | { type: 'no_remote_environment' }
  | { type: 'not_in_git_repo' }
  | { type: 'no_git_remote' }
  | { type: 'github_app_not_installed' }
  | { type: 'policy_blocked' }

/**
 * 检测当前环境是否满足创建后台远程会话的所有前置条件。
 * 检测顺序：policy 策略 → 登录状态 → 远程环境 → git 仓库 → GitHub App。
 * @param skipBundle 为 true 时跳过 bundle seed 特性开关查询
 * @returns 失败的前置条件数组；空数组表示全部通过
 */
export async function checkBackgroundRemoteSessionEligibility({
  skipBundle = false,
}: {
  skipBundle?: boolean
} = {}): Promise<BackgroundRemoteSessionPrecondition[]> {
  const errors: BackgroundRemoteSessionPrecondition[] = []

  // 策略检测优先：若策略不允许远程会话，无需继续检测其他前置条件
  if (!isPolicyAllowed('allow_remote_sessions')) {
    errors.push({ type: 'policy_blocked' })
    return errors
  }

  // 并发检测登录状态、远程环境可用性和当前仓库信息（互相独立，可并行）
  const [needsLogin, hasRemoteEnv, repository] = await Promise.all([
    checkNeedsClaudeAiLogin(),
    checkHasRemoteEnvironment(),
    detectCurrentRepositoryWithHost(),
  ])

  if (needsLogin) {
    errors.push({ type: 'not_logged_in' })
  }

  if (!hasRemoteEnv) {
    errors.push({ type: 'no_remote_environment' })
  }

  // Bundle seed 模式下仅需在 git 仓库中即可（CCR 可从本地 bundle 启动）；
  // 无需 GitHub remote 或 App 安装检测。与 teleport.tsx 的 bundleSeedGateOn 逻辑一致。
  const bundleSeedGateOn =
    !skipBundle &&
    (isEnvTruthy(process.env.CCR_FORCE_BUNDLE) ||
      isEnvTruthy(process.env.CCR_ENABLE_BUNDLE) ||
      (await checkGate_CACHED_OR_BLOCKING('tengu_ccr_bundle_seed_enabled')))

  if (!checkIsInGitRepo()) {
    // 当前目录不在任何 git 仓库中
    errors.push({ type: 'not_in_git_repo' })
  } else if (bundleSeedGateOn) {
    // 存在 .git/ 目录且 bundle seed 已启用，跳过 remote 和 GitHub App 检测
  } else if (repository === null) {
    // 在 git 仓库中但没有配置 remote（纯本地仓库）
    errors.push({ type: 'no_git_remote' })
  } else if (repository.host === 'github.com') {
    // 仅对 github.com 仓库检测 GitHub App 安装状态（其他 Git 托管平台不需要）
    const hasGithubApp = await checkGithubAppInstalled(
      repository.owner,
      repository.name,
    )
    if (!hasGithubApp) {
      errors.push({ type: 'github_app_not_installed' })
    }
  }

  return errors
}
