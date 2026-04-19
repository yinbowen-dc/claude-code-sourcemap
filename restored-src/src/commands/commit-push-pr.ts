/**
 * /commit-push-pr 命令的实现模块。
 *
 * 在 Claude Code 的 Git 工作流集成中，此命令将"提交→推送→创建 PR"三步操作合并为一个
 * 一键式 prompt 命令，通过向 AI 模型注入上下文感知的指令模板来自动化整个流程。
 *
 * 核心机制：
 * - 通过 `!`shell 命令 语法在 prompt 中内联执行 git status/diff/branch 等命令，
 *   将实时仓库状态注入给模型，避免模型产生幻觉
 * - 仅授权最小工具集（ALLOWED_TOOLS），防止模型执行意外的破坏性操作
 * - 支持 undercover 模式（Anthropic 内部）：隐藏身份标识信息，不添加 reviewer/changelog
 * - 通过 getEnhancedPRAttribution 获取增强的 PR attribution 文本
 */
import type { Command } from '../commands.js'
import {
  getAttributionTexts,
  getEnhancedPRAttribution,
} from '../utils/attribution.js'
import { getDefaultBranch } from '../utils/git.js'
import { executeShellCommandsInPrompt } from '../utils/promptShellExecution.js'
import { getUndercoverInstructions, isUndercover } from '../utils/undercover.js'

// 严格限制 AI 可使用的工具，只允许 git/gh 基础操作和 Slack 通知
// 防止模型在创建 PR 过程中触发其他不相关的工具调用
const ALLOWED_TOOLS = [
  'Bash(git checkout --branch:*)',
  'Bash(git checkout -b:*)',
  'Bash(git add:*)',
  'Bash(git status:*)',
  'Bash(git push:*)',
  'Bash(git commit:*)',
  'Bash(gh pr create:*)',
  'Bash(gh pr edit:*)',
  'Bash(gh pr view:*)',
  'Bash(gh pr merge:*)',
  'ToolSearch',
  'mcp__slack__send_message',
  'mcp__claude_ai_Slack__slack_send_message',
]

/**
 * 生成注入给 AI 模型的 prompt 内容。
 *
 * 动态构造包含以下部分的 prompt：
 * 1. Context 节：通过 shell 命令内联当前 git 状态（status/diff/branch/PR 信息）
 * 2. Git Safety Protocol 节：约束模型不执行危险操作
 * 3. Your task 节：分步指令（创建分支→提交→推送→创建/更新 PR→Slack 通知）
 *
 * 在 undercover 模式下，隐藏 reviewer、changelog 和 Slack 相关步骤，
 * 并在开头注入 undercover 专属指令前缀。
 *
 * @param defaultBranch 仓库默认分支名（用于 git diff base 和分支保护提示）
 * @param prAttribution 可选的增强 PR attribution 文本（覆盖默认值）
 */
function getPromptContent(
  defaultBranch: string,
  prAttribution?: string,
): string {
  const { commit: commitAttribution, pr: defaultPrAttribution } =
    getAttributionTexts()
  // 优先使用调用方提供的 PR attribution，否则回退到默认值
  const effectivePrAttribution = prAttribution ?? defaultPrAttribution
  const safeUser = process.env.SAFEUSER || ''
  const username = process.env.USER || ''

  let prefix = ''
  let reviewerArg = ' and `--reviewer anthropics/claude-code`'
  let addReviewerArg = ' (and add `--add-reviewer anthropics/claude-code`)'
  let changelogSection = `

## Changelog
<!-- CHANGELOG:START -->
[If this PR contains user-facing changes, add a changelog entry here. Otherwise, remove this section.]
<!-- CHANGELOG:END -->`
  let slackStep = `

5. After creating/updating the PR, check if the user's CLAUDE.md mentions posting to Slack channels. If it does, use ToolSearch to search for "slack send message" tools. If ToolSearch finds a Slack tool, ask the user if they'd like you to post the PR URL to the relevant Slack channel. Only post if the user confirms. If ToolSearch returns no results or errors, skip this step silently—do not mention the failure, do not attempt workarounds, and do not try alternative approaches.`
  if (process.env.USER_TYPE === 'ant' && isUndercover()) {
    // undercover 模式：清除所有 Anthropic 专属内容，避免暴露内部身份
    prefix = getUndercoverInstructions() + '\n'
    reviewerArg = ''
    addReviewerArg = ''
    changelogSection = ''
    slackStep = ''
  }

  return `${prefix}## Context

- \`SAFEUSER\`: ${safeUser}
- \`whoami\`: ${username}
- \`git status\`: !\`git status\`
- \`git diff HEAD\`: !\`git diff HEAD\`
- \`git branch --show-current\`: !\`git branch --show-current\`
- \`git diff ${defaultBranch}...HEAD\`: !\`git diff ${defaultBranch}...HEAD\`
- \`gh pr view --json number 2>/dev/null || true\`: !\`gh pr view --json number 2>/dev/null || true\`

## Git Safety Protocol

- NEVER update the git config
- NEVER run destructive/irreversible git commands (like push --force, hard reset, etc) unless the user explicitly requests them
- NEVER skip hooks (--no-verify, --no-gpg-sign, etc) unless the user explicitly requests it
- NEVER run force push to main/master, warn the user if they request it
- Do not commit files that likely contain secrets (.env, credentials.json, etc)
- Never use git commands with the -i flag (like git rebase -i or git add -i) since they require interactive input which is not supported

## Your task

Analyze all changes that will be included in the pull request, making sure to look at all relevant commits (NOT just the latest commit, but ALL commits that will be included in the pull request from the git diff ${defaultBranch}...HEAD output above).

Based on the above changes:
1. Create a new branch if on ${defaultBranch} (use SAFEUSER from context above for the branch name prefix, falling back to whoami if SAFEUSER is empty, e.g., \`username/feature-name\`)
2. Create a single commit with an appropriate message using heredoc syntax${commitAttribution ? `, ending with the attribution text shown in the example below` : ''}:
\`\`\`
git commit -m "$(cat <<'EOF'
Commit message here.${commitAttribution ? `\n\n${commitAttribution}` : ''}
EOF
)"
\`\`\`
3. Push the branch to origin
4. If a PR already exists for this branch (check the gh pr view output above), update the PR title and body using \`gh pr edit\` to reflect the current diff${addReviewerArg}. Otherwise, create a pull request using \`gh pr create\` with heredoc syntax for the body${reviewerArg}.
   - IMPORTANT: Keep PR titles short (under 70 characters). Use the body for details.
\`\`\`
gh pr create --title "Short, descriptive title" --body "$(cat <<'EOF'
## Summary
<1-3 bullet points>

## Test plan
[Bulleted markdown checklist of TODOs for testing the pull request...]${changelogSection}${effectivePrAttribution ? `\n\n${effectivePrAttribution}` : ''}
EOF
)"
\`\`\`

You have the capability to call multiple tools in a single response. You MUST do all of the above in a single message.${slackStep}

Return the PR URL when you're done, so the user can see it.`
}

/**
 * /commit-push-pr 命令描述符。
 *
 * 'prompt' 类型命令：将 getPromptForCommand 生成的文本作为用户消息发给 AI 模型，
 * 由模型调用 ALLOWED_TOOLS 中的工具依次完成提交→推送→PR 的完整流程。
 *
 * contentLength 使用 getter 而非静态值，因为 prompt 内容依赖运行时的 attribution 文本，
 * 此处以 'main' 作为分支名估算 token 数，用于上下文窗口使用量的预估。
 */
const command = {
  type: 'prompt',
  name: 'commit-push-pr',
  description: 'Commit, push, and open a PR',
  allowedTools: ALLOWED_TOOLS,
  get contentLength() {
    // 以 'main' 作为分支名估算 prompt 长度，用于上下文窗口使用量预估
    return getPromptContent('main').length
  },
  progressMessage: 'creating commit and PR',
  source: 'builtin',
  async getPromptForCommand(args, context) {
    // 并发获取默认分支名和增强 PR attribution，减少等待时间
    const [defaultBranch, prAttribution] = await Promise.all([
      getDefaultBranch(),
      getEnhancedPRAttribution(context.getAppState),
    ])
    let promptContent = getPromptContent(defaultBranch, prAttribution)

    // 若用户提供了额外指令，追加到 prompt 末尾作为补充要求
    const trimmedArgs = args?.trim()
    if (trimmedArgs) {
      promptContent += `\n\n## Additional instructions from user\n\n${trimmedArgs}`
    }

    // 执行 prompt 中的 shell 命令占位符（!`...` 语法），将实时 git 状态替换进去
    const finalContent = await executeShellCommandsInPrompt(
      promptContent,
      {
        ...context,
        getAppState() {
          const appState = context.getAppState()
          return {
            ...appState,
            toolPermissionContext: {
              ...appState.toolPermissionContext,
              alwaysAllowRules: {
                ...appState.toolPermissionContext.alwaysAllowRules,
                // 注入命令白名单，确保 shell 执行时不受额外权限限制
                command: ALLOWED_TOOLS,
              },
            },
          }
        },
      },
      '/commit-push-pr',
    )

    return [{ type: 'text', text: finalContent }]
  },
} satisfies Command

export default command
