/**
 * GitHub Pull Request 状态获取模块（ghPrStatus）。
 *
 * 【在 Claude Code 系统中的位置】
 * 该模块位于 GitHub 集成服务层，被终端 UI 的状态栏组件调用，
 * 用于在 REPL 界面实时显示当前分支关联的 PR 状态（审查状态、URL 等）。
 *
 * 【主要功能】
 * - PrReviewState 类型：PR 审查状态枚举（approved / pending / changes_requested / draft / merged / closed）
 * - PrStatus 类型：包含 PR 编号、URL 和审查状态
 * - GH_TIMEOUT_MS：gh 命令超时时间（5000ms）
 * - deriveReviewState()：将 GitHub API 的 isDraft 与 reviewDecision 映射为 PrReviewState
 * - fetchPrStatus()：调用 `gh pr view` 获取当前分支的 PR 详情，
 *   屏蔽默认分支、已合并/已关闭的 PR，避免误导性显示
 */

import { execFileNoThrow } from './execFileNoThrow.js'
import { getBranch, getDefaultBranch, getIsGit } from './git.js'
import { jsonParse } from './slowOperations.js'

/**
 * PR 审查状态枚举类型。
 * - 'approved'：已通过审查
 * - 'pending'：等待审查（包括需要审查但尚未有决定的情况）
 * - 'changes_requested'：审查者要求修改
 * - 'draft'：草稿状态（尚未准备好审查）
 * - 'merged'：已合并（内部使用，fetchPrStatus 不会返回此值）
 * - 'closed'：已关闭（内部使用，fetchPrStatus 不会返回此值）
 */
export type PrReviewState =
  | 'approved'
  | 'pending'
  | 'changes_requested'
  | 'draft'
  | 'merged'
  | 'closed'

/**
 * PR 状态数据结构，包含显示 PR 信息所需的最小字段集。
 */
export type PrStatus = {
  number: number         // PR 编号（如 #123）
  url: string            // PR 的 GitHub 页面链接
  reviewState: PrReviewState  // 当前审查状态
}

/** gh CLI 命令的超时时间（毫秒），防止网络请求长时间阻塞 UI */
const GH_TIMEOUT_MS = 5000

/**
 * 将 GitHub API 返回的原始字段映射为 PrReviewState。
 *
 * 【映射规则】
 * - isDraft=true → 'draft'（优先级最高，覆盖其他状态）
 * - reviewDecision='APPROVED' → 'approved'
 * - reviewDecision='CHANGES_REQUESTED' → 'changes_requested'
 * - 其他（REVIEW_REQUIRED、空字符串等） → 'pending'
 *
 * @param isDraft - 是否为草稿 PR
 * @param reviewDecision - GitHub API 返回的审查决定字符串
 * @returns 对应的 PrReviewState 枚举值
 */
export function deriveReviewState(
  isDraft: boolean,
  reviewDecision: string,
): PrReviewState {
  if (isDraft) return 'draft' // 草稿状态优先级最高
  switch (reviewDecision) {
    case 'APPROVED':
      return 'approved'           // 已批准
    case 'CHANGES_REQUESTED':
      return 'changes_requested'  // 需要修改
    default:
      return 'pending'            // 等待审查或其他未知状态
  }
}

/**
 * 获取当前分支关联的 PR 状态。
 *
 * 【流程】
 * 1. 检查当前目录是否为 git 仓库，不是则返回 null；
 * 2. 并发获取当前分支名和默认分支名；
 * 3. 若当前分支即为默认分支（main/master），返回 null
 *    （`gh pr view` 在默认分支上会返回最近合并的 PR，具有误导性）；
 * 4. 调用 `gh pr view --json` 获取 PR 详情；
 * 5. 过滤掉 head 分支为默认分支的 PR（从默认分支开启的 PR）；
 * 6. 过滤掉已合并或已关闭的 PR（仅显示开放中的 PR）；
 * 7. 调用 deriveReviewState 计算审查状态并返回。
 *
 * @returns PR 状态对象，或 null（任何失败情况均返回 null）
 */
export async function fetchPrStatus(): Promise<PrStatus | null> {
  const isGit = await getIsGit() // 检查是否在 git 仓库中
  if (!isGit) return null

  // 并发获取当前分支和默认分支，若在默认分支上则跳过
  // 原因：gh pr view 在默认分支上会返回最近合并的 PR，具有误导性
  const [branch, defaultBranch] = await Promise.all([
    getBranch(),
    getDefaultBranch(),
  ])
  if (branch === defaultBranch) return null // 在默认分支上，不查询 PR

  const { stdout, code } = await execFileNoThrow(
    'gh',
    [
      'pr',
      'view',
      '--json',
      'number,url,reviewDecision,isDraft,headRefName,state', // 仅请求所需字段
    ],
    { timeout: GH_TIMEOUT_MS, preserveOutputOnError: false },
  )

  if (code !== 0 || !stdout.trim()) return null // gh 命令失败或无输出

  try {
    const data = jsonParse(stdout) as {
      number: number
      url: string
      reviewDecision: string
      isDraft: boolean
      headRefName: string
      state: string
    }

    // 过滤从默认分支开启的 PR（如从 main 向其他分支开 PR 的情况）
    // 不显示此类 PR 的状态，因为这种情况极少见且易造成混淆
    if (
      data.headRefName === defaultBranch ||
      data.headRefName === 'main' ||
      data.headRefName === 'master'
    ) {
      return null
    }

    // 过滤已合并或已关闭的 PR，仅显示开放中的 PR
    // gh pr view 会返回分支最近关联的 PR，可能是已合并/关闭的历史 PR
    if (data.state === 'MERGED' || data.state === 'CLOSED') {
      return null
    }

    return {
      number: data.number,
      url: data.url,
      reviewState: deriveReviewState(data.isDraft, data.reviewDecision), // 映射审查状态
    }
  } catch {
    return null // JSON 解析失败，返回 null
  }
}
