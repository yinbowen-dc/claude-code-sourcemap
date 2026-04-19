/**
 * ultrareview 远端审查核心逻辑（commands/review/reviewRemote.ts）
 *
 * 本文件是 /ultrareview 命令的"发射台"，负责将代码审查任务从本地 Claude Code 实例
 * 传送（teleport）至 claude.ai/code 的远端 CCR 环境，在云端启动 bughunter 分析引擎。
 *
 * 在整个系统流程中的位置：
 *   /ultrareview 命令触发 → ultrareviewCommand.tsx 处理 UI/计费对话框
 *   → checkOverageGate() 确认计费状态 → launchRemoteReview() 执行远端启动
 *   → registerRemoteAgentTask() 注册轮询任务 → 分析结果通过 task-notification 回传。
 *
 * 支持两种模式：
 *   - PR 模式：通过 GitHub refs/pull/N/head 拉取指定 PR，需要 GitHub App 安装；
 *   - 分支模式：打包当前工作区（bundle）发送，无需推送 PR，适合本地未发布的更改。
 */

/**
 * Teleported /ultrareview execution. Creates a CCR session with the current repo,
 * sends the review prompt as the initial message, and registers a
 * RemoteAgentTask so the polling loop pipes results back into the local
 * session via task-notification. Mirrors the /ultraplan → CCR flow.
 *
 * TODO(#22051): pass useBundleMode once landed so local-only / uncommitted
 * repo state is captured. The GitHub-clone path (current) only works for
 * pushed branches on repos with the Claude GitHub app installed.
 */

import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js'
import { fetchUltrareviewQuota } from '../../services/api/ultrareviewQuota.js'
import { fetchUtilization } from '../../services/api/usage.js'
import type { ToolUseContext } from '../../Tool.js'
import {
  checkRemoteAgentEligibility,
  formatPreconditionError,
  getRemoteTaskSessionUrl,
  registerRemoteAgentTask,
} from '../../tasks/RemoteAgentTask/RemoteAgentTask.js'
import { isEnterpriseSubscriber, isTeamSubscriber } from '../../utils/auth.js'
import { detectCurrentRepositoryWithHost } from '../../utils/detectRepository.js'
import { execFileNoThrow } from '../../utils/execFileNoThrow.js'
import { getDefaultBranch, gitExe } from '../../utils/git.js'
import { teleportToRemote } from '../../utils/teleport.js'

// One-time session flag: once the user confirms overage billing via the
// dialog, all subsequent /ultrareview invocations in this session proceed
// without re-prompting.
// 会话级超额确认标志：用户在计费对话框点击"确认"后置为 true，当次会话内不再重复弹窗
let sessionOverageConfirmed = false

/**
 * 将会话级超额标志置为已确认。
 * 由 ultrareviewCommand.tsx 中的计费对话框"确认"按钮回调调用。
 */
export function confirmOverage(): void {
  sessionOverageConfirmed = true
}

/**
 * 超额计费门控结果的联合类型，描述用户当前能否发起 ultrareview 及其计费状态：
 * - proceed: 可以继续，billingNote 说明计费情况（免费额度内或超额付费）；
 * - not-enabled: 未开通 Extra Usage，无法在免费额度耗尽后继续使用；
 * - low-balance: Extra Usage 余额不足（低于 10 美元）；
 * - needs-confirm: 额度耗尽且余额充足，需用户在弹窗确认超额计费。
 */
export type OverageGate =
  | { kind: 'proceed'; billingNote: string }
  | { kind: 'not-enabled' }
  | { kind: 'low-balance'; available: number }
  | { kind: 'needs-confirm' }

/**
 * Determine whether the user can launch an ultrareview and under what
 * billing terms. Fetches quota and utilization in parallel.
 *
 * 检查用户是否满足发起 ultrareview 的计费条件，按以下优先级依次判断：
 *   1. Team/Enterprise 订阅者直接放行，无需检查额度；
 *   2. 并行拉取 ultrareview 专属配额和总使用量；
 *   3. 配额接口失败（非订阅者/网络故障）→ 放行（服务端兜底）；
 *   4. 仍有免费次数 → 放行并附"第 N/M 次免费"提示；
 *   5. 免费次数耗尽且未开通 Extra Usage → 返回 not-enabled；
 *   6. 余额低于 10 美元 → 返回 low-balance；
 *   7. 本次会话未经用户确认超额 → 返回 needs-confirm（触发弹窗）；
 *   8. 已确认 → 放行并注明"按 Extra Usage 计费"。
 */
export async function checkOverageGate(): Promise<OverageGate> {
  // Team and Enterprise plans include ultrareview — no free-review quota
  // or Extra Usage dialog. The quota endpoint is scoped to consumer plans
  // (pro/max); hitting it on team/ent would surface a confusing dialog.
  // Team/Enterprise 计划内置 ultrareview 权益，跳过所有消费者计划的额度检查
  if (isTeamSubscriber() || isEnterpriseSubscriber()) {
    return { kind: 'proceed', billingNote: '' }
  }

  // 并行拉取两个接口，减少等待时间
  const [quota, utilization] = await Promise.all([
    fetchUltrareviewQuota(),
    fetchUtilization().catch(() => null),
  ])

  // No quota info (non-subscriber or endpoint down) — let it through,
  // server-side billing will handle it.
  // 配额接口返回空（非订阅用户或接口故障）→ 放行，由服务端负责计费裁决
  if (!quota) {
    return { kind: 'proceed', billingNote: '' }
  }

  if (quota.reviews_remaining > 0) {
    // 仍有免费次数，向用户展示"第 N 次，共 M 次"的友好提示
    return {
      kind: 'proceed',
      billingNote: ` This is free ultrareview ${quota.reviews_used + 1} of ${quota.reviews_limit}.`,
    }
  }

  // Utilization fetch failed (transient network error, timeout, etc.) —
  // let it through, same rationale as the quota fallback above.
  // 使用量接口失败（网络抖动等瞬时错误）→ 同样放行，服务端兜底
  if (!utilization) {
    return { kind: 'proceed', billingNote: '' }
  }

  // Free reviews exhausted — check Extra Usage setup.
  // 免费次数耗尽，检查用户是否已开启 Extra Usage（超额计费功能）
  const extraUsage = utilization.extra_usage
  if (!extraUsage?.is_enabled) {
    logEvent('tengu_review_overage_not_enabled', {})
    return { kind: 'not-enabled' }
  }

  // Check available balance (null monthly_limit = unlimited).
  // 计算当月剩余可用额度；monthly_limit 为 null 表示无上限
  const monthlyLimit = extraUsage.monthly_limit
  const usedCredits = extraUsage.used_credits ?? 0
  const available =
    monthlyLimit === null || monthlyLimit === undefined
      ? Infinity
      : monthlyLimit - usedCredits

  if (available < 10) {
    // 剩余额度不足 10 美元，拒绝执行以防超支
    logEvent('tengu_review_overage_low_balance', { available })
    return { kind: 'low-balance', available }
  }

  if (!sessionOverageConfirmed) {
    // 用户本次会话尚未确认超额计费，触发弹窗
    logEvent('tengu_review_overage_dialog_shown', {})
    return { kind: 'needs-confirm' }
  }

  // 已确认超额计费，放行并附计费说明
  return {
    kind: 'proceed',
    billingNote: ' This review bills as Extra Usage.',
  }
}

/**
 * Launch a teleported review session. Returns ContentBlockParam[] describing
 * the launch outcome for injection into the local conversation (model is then
 * queried with this content, so it can narrate the launch to the user).
 *
 * Returns ContentBlockParam[] with user-facing error messages on recoverable
 * failures (missing merge-base, empty diff, bundle too large), or null on
 * other failures so the caller falls through to the local-review prompt.
 * Reason is captured in analytics.
 *
 * Caller must run checkOverageGate() BEFORE calling this function
 * (ultrareviewCommand.tsx handles the dialog).
 *
 * 启动远端 ultrareview 会话的主函数，执行流程：
 *   1. 校验远端 CCR 执行环境的前置条件（登录态、网络等），不满足则返回错误内容；
 *   2. 根据 args 判断进入 PR 模式还是分支 bundle 模式；
 *   3. 通过 teleportToRemote() 在远端创建 CCR 会话；
 *   4. 调用 registerRemoteAgentTask() 启动轮询，将远端结果通过 task-notification 回传；
 *   5. 返回启动成功的确认内容块，供模型向用户简要播报。
 *
 * @param args         用户传入的参数（PR 号或空字符串表示分支模式）
 * @param context      工具调用上下文，包含终止信号和应用状态
 * @param billingNote  由 checkOverageGate() 计算的计费说明字符串
 */
export async function launchRemoteReview(
  args: string,
  context: ToolUseContext,
  billingNote?: string,
): Promise<ContentBlockParam[] | null> {
  const eligibility = await checkRemoteAgentEligibility()
  // Synthetic DEFAULT_CODE_REVIEW_ENVIRONMENT_ID works without per-org CCR
  // setup, so no_remote_environment isn't a blocker. Server-side quota
  // consume at session creation routes billing: first N zero-rate, then
  // anthropic:cccr org-service-key (overage-only).
  // no_remote_environment 错误不是真正的阻塞项（合成环境 ID 可绕过），过滤后只看真正的阻塞错误
  if (!eligibility.eligible) {
    const blockers = eligibility.errors.filter(
      e => e.type !== 'no_remote_environment',
    )
    if (blockers.length > 0) {
      // 存在真正的前置条件未满足（如未登录），记录埋点并返回用户可见的错误说明
      logEvent('tengu_review_remote_precondition_failed', {
        precondition_errors: blockers
          .map(e => e.type)
          .join(
            ',',
          ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
      const reasons = blockers.map(formatPreconditionError).join('\n')
      return [
        {
          type: 'text',
          text: `Ultrareview cannot launch:\n${reasons}`,
        },
      ]
    }
  }

  const resolvedBillingNote = billingNote ?? ''

  const prNumber = args.trim()
  const isPrNumber = /^\d+$/.test(prNumber) // 判断参数是否为纯数字（PR 号）
  // Synthetic code_review env. Go taggedid.FromUUID(TagEnvironment,
  // UUID{...,0x02}) encodes with version prefix '01' — NOT Python's
  // legacy tagged_id() format. Verified in prod.
  // 合成环境 ID，用于绑定 CCR 代码审查专用执行环境，无需每个组织单独配置
  const CODE_REVIEW_ENV_ID = 'env_011111111111111111111113'
  // Lite-review bypasses bughunter.go entirely, so it doesn't see the
  // webhook's bug_hunter_config (different GB project). These env vars are
  // the only tuning surface — without them, run_hunt.sh's bash defaults
  // apply (60min, 120s agent timeout), and 120s kills verifiers mid-run
  // which causes infinite respawn.
  //
  // total_wallclock must stay below RemoteAgentTask's 30min poll timeout
  // with headroom for finalization (~3min synthesis). Per-field guards
  // match autoDream.ts — GB cache can return stale wrong-type values.
  // 从 GrowthBook 获取 bughunter 运行参数配置（舰队规模、超时时长等）
  const raw = getFeatureValue_CACHED_MAY_BE_STALE<Record<
    string,
    unknown
  > | null>('tengu_review_bughunter_config', null)
  // 安全地将 GB 配置值解析为正整数，非法值回退到安全默认值，防止 GB 缓存返回错误类型
  const posInt = (v: unknown, fallback: number, max?: number): number => {
    if (typeof v !== 'number' || !Number.isFinite(v)) return fallback
    const n = Math.floor(v)
    if (n <= 0) return fallback
    return max !== undefined && n > max ? fallback : n
  }
  // Upper bounds: 27min on wallclock leaves ~3min for finalization under
  // RemoteAgentTask's 30min poll timeout. If GB is set above that, the
  // hang we're fixing comes back — fall to the safe default instead.
  // 将 GB 配置转换为 bughunter 进程所需的环境变量，所有值都经过上界约束
  const commonEnvVars = {
    BUGHUNTER_DRY_RUN: '1',
    BUGHUNTER_FLEET_SIZE: String(posInt(raw?.fleet_size, 5, 20)),         // 并发 agent 数量，默认 5，上限 20
    BUGHUNTER_MAX_DURATION: String(posInt(raw?.max_duration_minutes, 10, 25)),  // 最长运行分钟数，默认 10
    BUGHUNTER_AGENT_TIMEOUT: String(
      posInt(raw?.agent_timeout_seconds, 600, 1800),  // 单个 agent 超时秒数，默认 600s
    ),
    BUGHUNTER_TOTAL_WALLCLOCK: String(
      posInt(raw?.total_wallclock_minutes, 22, 27),   // 总挂钟时间，不超过 27min 以留出 3min 收尾
    ),
    ...(process.env.BUGHUNTER_DEV_BUNDLE_B64 && {
      // 仅开发调试使用：允许通过环境变量注入自定义 bundle
      BUGHUNTER_DEV_BUNDLE_B64: process.env.BUGHUNTER_DEV_BUNDLE_B64,
    }),
  }

  let session
  let command
  let target
  if (isPrNumber) {
    // PR 模式：通过 GitHub refs/pull/N/head 拉取 PR，调用 bughunter orchestrator --pr N
    const repo = await detectCurrentRepositoryWithHost()
    if (!repo || repo.host !== 'github.com') {
      // 仅支持 github.com，非 GitHub 仓库直接降级（返回 null 让调用方走本地审查）
      logEvent('tengu_review_remote_precondition_failed', {})
      return null
    }
    session = await teleportToRemote({
      initialMessage: null,
      description: `ultrareview: ${repo.owner}/${repo.name}#${prNumber}`,
      signal: context.abortController.signal,
      branchName: `refs/pull/${prNumber}/head`,  // 指向 PR 的 GitHub 引用路径
      environmentId: CODE_REVIEW_ENV_ID,
      environmentVariables: {
        BUGHUNTER_PR_NUMBER: prNumber,
        BUGHUNTER_REPOSITORY: `${repo.owner}/${repo.name}`,
        ...commonEnvVars,
      },
    })
    command = `/ultrareview ${prNumber}`
    target = `${repo.owner}/${repo.name}#${prNumber}`
  } else {
    // 分支模式：将本地工作区打包（bundle）发送，orchestrator 与 fork point 做 diff
    const baseBranch = (await getDefaultBranch()) || 'main'
    // Env-manager's `git remote remove origin` after bundle-clone
    // deletes refs/remotes/origin/* — the base branch name won't resolve
    // in the container. Pass the merge-base SHA instead: it's reachable
    // from HEAD's history so `git diff <sha>` works without a named ref.
    // 容器内 remote 被删除后分支名失效，改用 merge-base SHA 作为基准，SHA 始终可达
    const { stdout: mbOut, code: mbCode } = await execFileNoThrow(
      gitExe(),
      ['merge-base', baseBranch, 'HEAD'],
      { preserveOutputOnError: false },
    )
    const mergeBaseSha = mbOut.trim()
    if (mbCode !== 0 || !mergeBaseSha) {
      // 无法找到与主分支的合并基点，向用户返回可理解的错误信息
      logEvent('tengu_review_remote_precondition_failed', {})
      return [
        {
          type: 'text',
          text: `Could not find merge-base with ${baseBranch}. Make sure you're in a git repo with a ${baseBranch} branch.`,
        },
      ]
    }

    // Bail early on empty diffs instead of launching a container that
    // will just echo "no changes".
    // 提前检测空 diff，避免浪费远端资源启动一个"无变更"的容器
    const { stdout: diffStat, code: diffCode } = await execFileNoThrow(
      gitExe(),
      ['diff', '--shortstat', mergeBaseSha],
      { preserveOutputOnError: false },
    )
    if (diffCode === 0 && !diffStat.trim()) {
      // diff 为空，提示用户先提交或暂存修改
      logEvent('tengu_review_remote_precondition_failed', {})
      return [
        {
          type: 'text',
          text: `No changes against the ${baseBranch} fork point. Make some commits or stage files first.`,
        },
      ]
    }

    // 通过 bundle 模式将工作区打包上传至远端 CCR 环境
    session = await teleportToRemote({
      initialMessage: null,
      description: `ultrareview: ${baseBranch}`,
      signal: context.abortController.signal,
      useBundle: true,            // 启用 bundle 模式，将本地代码打包传输
      environmentId: CODE_REVIEW_ENV_ID,
      environmentVariables: {
        BUGHUNTER_BASE_BRANCH: mergeBaseSha,  // 传 SHA 而非分支名，容器内可靠可达
        ...commonEnvVars,
      },
    })
    if (!session) {
      // bundle 过大（仓库体积超限），提示用户改用 PR 模式
      logEvent('tengu_review_remote_teleport_failed', {})
      return [
        {
          type: 'text',
          text: 'Repo is too large. Push a PR and use `/ultrareview <PR#>` instead.',
        },
      ]
    }
    command = '/ultrareview'
    target = baseBranch
  }

  if (!session) {
    // teleport 失败（未知原因），返回 null 让调用方降级到本地审查
    logEvent('tengu_review_remote_teleport_failed', {})
    return null
  }
  // 注册 RemoteAgentTask 轮询任务，后台监听远端 bughunter 完成并通过通知回传结果
  registerRemoteAgentTask({
    remoteTaskType: 'ultrareview',
    session,
    command,
    context,
    isRemoteReview: true,
  })
  logEvent('tengu_review_remote_launched', {})
  const sessionUrl = getRemoteTaskSessionUrl(session.id)
  // Concise — the tool-output block is visible to the user, so the model
  // shouldn't echo the same info. Just enough for Claude to acknowledge the
  // launch without restating the target/URL (both already printed above).
  // 返回简洁的启动确认内容，模型据此向用户简要播报（目标和 URL 已在工具输出中显示，不需重复）
  return [
    {
      type: 'text',
      text: `Ultrareview launched for ${target} (~10–20 min, runs in the cloud). Track: ${sessionUrl}${resolvedBillingNote} Findings arrive via task-notification. Briefly acknowledge the launch to the user without repeating the target or URL — both are already visible in the tool output above.`,
    },
  ]
}
