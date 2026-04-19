/**
 * shared/gitOperationTracking.ts — Shell 无关的 Git 操作追踪工具
 *
 * 在 Claude Code 系统流程中的位置：
 *   工具层（shared 工具）→ Git 操作检测 → OTLP 计数器 + 分析事件上报
 *
 * 主要功能：
 *   - 通过正则表达式检测命令字符串中的 git/gh/glab/curl 操作
 *   - detectGitOperation：从命令和输出中提取 commit/push/branch/PR 操作详情
 *   - trackGitOperations：在操作成功时递增 OTLP 计数器并上报 analytics 事件
 *
 * 设计说明：
 *   - 正则表达式作用于原始命令文本，因此对 Bash 和 PowerShell 均适用
 *   - 检测逻辑依赖命令文本（而非仅输出），避免将 `git log` 等查询命令
 *     中出现的 SHA/URL 误判为写操作
 *   - 支持的操作：git commit、git push、git cherry-pick、git merge、git rebase、
 *     gh pr create/edit/merge/comment/close/ready、glab mr create、curl 创建 PR
 */

import { getCommitCounter, getPrCounter } from '../../bootstrap/state.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js'

/**
 * gitCmdRe — 构建能容忍 git 全局选项的子命令正则表达式
 *
 * 目的：在 `git` 和子命令之间允许出现全局选项，例如：
 *   `git -c commit.gpgsign=false commit`（模型在签名失败后常用此方式重试）
 *   `git -C /path push`
 *
 * 正则结构：
 *   \bgit                         — 匹配单词边界后的 "git"
 *   (?:\s+-[cC]\s+\S+|            — 可选的 -c/-C 选项（后跟参数）
 *   \s+--\S+=\S+)*               — 可选的 --key=val 格式选项（0 次或多次）
 *   \s+<subcmd>\b                 — 子命令名称（单词边界）
 *   <suffix>                      — 调用方可追加的额外后缀正则
 *
 * @param subcmd 要匹配的 git 子命令名称
 * @param suffix 追加到子命令后的额外正则后缀（默认为空）
 * @returns 编译后的 RegExp 对象
 */
function gitCmdRe(subcmd: string, suffix = ''): RegExp {
  return new RegExp(
    `\\bgit(?:\\s+-[cC]\\s+\\S+|\\s+--\\S+=\\S+)*\\s+${subcmd}\\b${suffix}`,
  )
}

// 各 git 子命令的正则匹配器
const GIT_COMMIT_RE = gitCmdRe('commit')
const GIT_PUSH_RE = gitCmdRe('push')
const GIT_CHERRY_PICK_RE = gitCmdRe('cherry-pick')
// merge 正则追加 (?!-) 以排除 --merge 等带连字符的选项值
const GIT_MERGE_RE = gitCmdRe('merge', '(?!-)')
const GIT_REBASE_RE = gitCmdRe('rebase')

// commit 操作的种类枚举（普通提交 / amend / cherry-pick）
export type CommitKind = 'committed' | 'amended' | 'cherry-picked'
// 分支操作的种类枚举（merge / rebase）
export type BranchAction = 'merged' | 'rebased'
// PR 操作的种类枚举（创建 / 编辑 / 合并 / 评论 / 关闭 / 标记就绪）
export type PrAction =
  | 'created'
  | 'edited'
  | 'merged'
  | 'commented'
  | 'closed'
  | 'ready'

// gh pr 子命令的正则匹配表：每项包含命令正则、PR 操作类型和 analytics 事件名
const GH_PR_ACTIONS: readonly { re: RegExp; action: PrAction; op: string }[] = [
  { re: /\bgh\s+pr\s+create\b/, action: 'created', op: 'pr_create' },
  { re: /\bgh\s+pr\s+edit\b/, action: 'edited', op: 'pr_edit' },
  { re: /\bgh\s+pr\s+merge\b/, action: 'merged', op: 'pr_merge' },
  { re: /\bgh\s+pr\s+comment\b/, action: 'commented', op: 'pr_comment' },
  { re: /\bgh\s+pr\s+close\b/, action: 'closed', op: 'pr_close' },
  { re: /\bgh\s+pr\s+ready\b/, action: 'ready', op: 'pr_ready' },
]

/**
 * parsePrUrl — 从 GitHub PR URL 中解析 PR 信息
 *
 * @param url 包含 github.com 的 PR URL
 * @returns { prNumber, prUrl, prRepository } 或 null（非有效 PR URL 时）
 */
function parsePrUrl(
  url: string,
): { prNumber: number; prUrl: string; prRepository: string } | null {
  const match = url.match(/https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/)
  if (match?.[1] && match?.[2]) {
    return {
      prNumber: parseInt(match[2], 10),
      prUrl: url,
      prRepository: match[1],
    }
  }
  return null
}

/**
 * findPrInStdout — 在命令输出中查找 GitHub PR URL 并解析
 *
 * @param stdout 命令的标准输出文本
 * @returns 解析后的 PR 信息，未找到时返回 null
 */
function findPrInStdout(stdout: string): ReturnType<typeof parsePrUrl> {
  const m = stdout.match(/https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+/)
  return m ? parsePrUrl(m[0]) : null
}

/**
 * parseGitCommitId — 从 git commit 输出中解析 commit SHA
 *
 * git commit 输出格式：`[branch abc1234] message`
 * 或 root commit：`[branch (root-commit) abc1234] message`
 *
 * 导出供测试使用
 *
 * @param stdout git commit 的标准输出
 * @returns 7 字符短 SHA，未找到时返回 undefined
 */
// Exported for testing purposes
export function parseGitCommitId(stdout: string): string | undefined {
  // git commit output: [branch abc1234] message
  // or for root commit: [branch (root-commit) abc1234] message
  const match = stdout.match(/\[[\w./-]+(?: \(root-commit\))? ([0-9a-f]+)\]/)
  return match?.[1]
}

/**
 * parseGitPushBranch — 从 git push 输出中解析被推送的分支名
 *
 * git push 的进度信息写入 stderr，但 ref 更新行同时出现在 stdout 和 stderr：
 *   - 更新格式：`abc..def  branch -> branch`
 *   - 新分支格式：`* [new branch]  branch -> branch`
 *   - 强推格式：` + abc...def  branch -> branch (forced update)`
 * 每行前有状态标志符（空格、+、-、*、!、=），正则容忍任意标志符
 *
 * @param output stdout + stderr 的合并文本
 * @returns 分支名称，未找到时返回 undefined
 */
function parseGitPushBranch(output: string): string | undefined {
  const match = output.match(
    /^\s*[+\-*!= ]?\s*(?:\[new branch\]|\S+\.\.+\S+)\s+\S+\s*->\s*(\S+)/m,
  )
  return match?.[1]
}

/**
 * parsePrNumberFromText — 从文本中提取 PR 编号
 *
 * gh pr merge/close/ready 的输出格式为：
 *   "✓ Merged pull request owner/repo#1234"（无 URL）
 * 此函数从这类文本中提取 PR 编号
 *
 * @param stdout 命令输出文本
 * @returns PR 编号，未找到时返回 undefined
 */
function parsePrNumberFromText(stdout: string): number | undefined {
  const match = stdout.match(/[Pp]ull request (?:\S+#)?#?(\d+)/)
  return match?.[1] ? parseInt(match[1], 10) : undefined
}

/**
 * parseRefFromCommand — 从 `git merge/rebase <ref>` 命令中提取目标引用
 *
 * 跳过 flag（以 `-` 开头的参数）和 shell 特殊符号（`&|;><`），
 * 第一个非 flag 参数即为目标 ref
 *
 * @param command 完整命令字符串
 * @param verb 子命令名称（"merge" 或 "rebase"）
 * @returns 目标 ref 字符串，未找到时返回 undefined
 */
function parseRefFromCommand(
  command: string,
  verb: string,
): string | undefined {
  const after = command.split(gitCmdRe(verb))[1]
  if (!after) return undefined
  for (const t of after.trim().split(/\s+/)) {
    // 遇到 shell 管道/重定向符号时停止解析
    if (/^[&|;><]/.test(t)) break
    // 跳过 flag 参数
    if (t.startsWith('-')) continue
    return t
  }
  return undefined
}

/**
 * detectGitOperation — 从命令和输出中检测 Git 操作
 *
 * 目的：生成折叠的工具调用摘要（如 "committed a1b2c3, created PR #42, ran 3 bash commands"）
 *
 * 整体流程：
 *   1. 检测 commit（含 cherry-pick 和 amend）：从输出中解析 SHA
 *   2. 检测 push：从输出中解析分支名
 *   3. 检测 merge（仅成功时）：从命令中解析目标 ref
 *   4. 检测 rebase（仅成功时）：从命令中解析目标 ref
 *   5. 检测 gh pr 操作：从输出中解析 PR URL 或 PR 编号
 *
 * 注意：必须同时传入命令文本，以避免将 `git log` 等查询命令中的 SHA 误判为写操作
 *
 * @param command 完整命令字符串
 * @param output stdout + stderr 合并文本
 * @returns 检测到的操作详情对象（字段均为可选）
 */
export function detectGitOperation(
  command: string,
  output: string,
): {
  commit?: { sha: string; kind: CommitKind }
  push?: { branch: string }
  branch?: { ref: string; action: BranchAction }
  pr?: { number: number; url?: string; action: PrAction }
} {
  const result: ReturnType<typeof detectGitOperation> = {}
  // commit 和 cherry-pick 的输出格式相同（均产生 "[branch sha] msg" 行）
  const isCherryPick = GIT_CHERRY_PICK_RE.test(command)
  if (GIT_COMMIT_RE.test(command) || isCherryPick) {
    const sha = parseGitCommitId(output)
    if (sha) {
      result.commit = {
        sha: sha.slice(0, 6), // 只保留 6 字符短 SHA
        kind: isCherryPick
          ? 'cherry-picked'
          : /--amend\b/.test(command)
            ? 'amended'
            : 'committed',
      }
    }
  }
  if (GIT_PUSH_RE.test(command)) {
    const branch = parseGitPushBranch(output)
    if (branch) result.push = { branch }
  }
  // merge 检测：命令中有 merge 子命令 且 输出中包含成功标志
  if (
    GIT_MERGE_RE.test(command) &&
    /(Fast-forward|Merge made by)/.test(output)
  ) {
    const ref = parseRefFromCommand(command, 'merge')
    if (ref) result.branch = { ref, action: 'merged' }
  }
  // rebase 检测：命令中有 rebase 子命令 且 输出中包含 "Successfully rebased"
  if (GIT_REBASE_RE.test(command) && /Successfully rebased/.test(output)) {
    const ref = parseRefFromCommand(command, 'rebase')
    if (ref) result.branch = { ref, action: 'rebased' }
  }
  // gh pr 操作检测：先匹配 action，再从输出中提取 PR URL 或编号
  const prAction = GH_PR_ACTIONS.find(a => a.re.test(command))?.action
  if (prAction) {
    const pr = findPrInStdout(output)
    if (pr) {
      result.pr = { number: pr.prNumber, url: pr.prUrl, action: prAction }
    } else {
      // URL 未找到时，尝试从文本中提取 PR 编号（gh merge/close/ready 的输出格式）
      const num = parsePrNumberFromText(output)
      if (num) result.pr = { number: num, action: prAction }
    }
  }
  return result
}

/**
 * trackGitOperations — 在 Git 操作成功时上报 analytics 事件和 OTLP 计数器
 *
 * 整体流程：
 *   1. 仅在 exitCode === 0 时处理（失败操作不上报）
 *   2. 检测 git commit（含 amend）：上报事件并递增 commit 计数器
 *   3. 检测 git push：上报事件
 *   4. 检测 gh pr 操作：上报对应事件；若为 create，还递增 PR 计数器并关联 session
 *   5. 检测 glab mr create：上报事件并递增 PR 计数器
 *   6. 检测 curl 创建 PR（REST API 方式）：上报事件并递增 PR 计数器
 *
 * 导出供测试使用
 *
 * @param command 完整命令字符串
 * @param exitCode 命令退出码
 * @param stdout 标准输出文本（用于提取 PR URL 并关联 session）
 */
// Exported for testing purposes
export function trackGitOperations(
  command: string,
  exitCode: number,
  stdout?: string,
): void {
  const success = exitCode === 0
  // 非成功退出码直接返回，不追踪失败操作
  if (!success) {
    return
  }

  if (GIT_COMMIT_RE.test(command)) {
    // 上报 commit 事件
    logEvent('tengu_git_operation', {
      operation:
        'commit' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    if (command.match(/--amend\b/)) {
      // amend 是 commit 的特殊形式，额外上报 commit_amend 事件
      logEvent('tengu_git_operation', {
        operation:
          'commit_amend' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
    }
    // 递增 OTLP commit 计数器
    getCommitCounter()?.add(1)
  }
  if (GIT_PUSH_RE.test(command)) {
    // 上报 push 事件
    logEvent('tengu_git_operation', {
      operation:
        'push' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
  }
  const prHit = GH_PR_ACTIONS.find(a => a.re.test(command))
  if (prHit) {
    // 上报 gh pr 操作事件（使用 prHit.op 作为 operation 名称）
    logEvent('tengu_git_operation', {
      operation:
        prHit.op as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
  }
  if (prHit?.action === 'created') {
    // 递增 OTLP PR 计数器
    getPrCounter()?.add(1)
    // Auto-link session to PR if we can extract PR URL from stdout
    // 从 stdout 中提取 PR URL，将当前 session 关联到该 PR（异步，不阻塞主流程）
    if (stdout) {
      const prInfo = findPrInStdout(stdout)
      if (prInfo) {
        // Import is done dynamically to avoid circular dependency
        // 动态导入以避免循环依赖
        void import('../../utils/sessionStorage.js').then(
          ({ linkSessionToPR }) => {
            void import('../../bootstrap/state.js').then(({ getSessionId }) => {
              const sessionId = getSessionId()
              if (sessionId) {
                void linkSessionToPR(
                  sessionId as `${string}-${string}-${string}-${string}-${string}`,
                  prInfo.prNumber,
                  prInfo.prUrl,
                  prInfo.prRepository,
                )
              }
            })
          },
        )
      }
    }
  }
  if (command.match(/\bglab\s+mr\s+create\b/)) {
    // GitLab MR 创建：上报 pr_create 事件并递增 PR 计数器
    logEvent('tengu_git_operation', {
      operation:
        'pr_create' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    getPrCounter()?.add(1)
  }
  // Detect PR creation via curl to REST APIs (Bitbucket, GitHub API, GitLab API)
  // Check for POST method and PR endpoint separately to handle any argument order
  // Also detect implicit POST when -d is used (curl defaults to POST with data)
  // 通过 curl 调用 REST API 创建 PR 的检测（支持 Bitbucket、GitHub API、GitLab API）
  // 分别检查 POST 方法标志和 PR 端点，以兼容任意参数顺序
  const isCurlPost =
    command.match(/\bcurl\b/) &&
    (command.match(/-X\s*POST\b/i) ||
      command.match(/--request\s*=?\s*POST\b/i) ||
      command.match(/\s-d\s/))  // -d 参数隐式触发 POST
  // Match PR endpoints in URLs, but not sub-resources like /pulls/123/comments
  // Require https?:// prefix to avoid matching text in POST body or other params
  // 匹配 PR 端点 URL（排除 /pulls/123/comments 等子资源；要求 https:// 前缀）
  const isPrEndpoint = command.match(
    /https?:\/\/[^\s'"]*\/(pulls|pull-requests|merge[-_]requests)(?!\/\d)/i,
  )
  if (isCurlPost && isPrEndpoint) {
    // curl POST 到 PR 端点：上报 pr_create 事件并递增计数器
    logEvent('tengu_git_operation', {
      operation:
        'pr_create' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    getPrCounter()?.add(1)
  }
}
