/**
 * /commit 命令实现模块。
 *
 * 在 Claude Code 的版本控制辅助流程中，此文件实现了 /commit 命令（type: 'prompt'），
 * 通过构建一个包含 git 状态上下文的结构化 prompt，让模型代替用户执行暂存与提交操作。
 *
 * 核心机制：
 * - `getPromptContent()` 内嵌 !\`shell command\` 语法，由 executeShellCommandsInPrompt
 *   在运行时展开（注入 git status/diff/log/branch 的实际输出）
 * - ALLOWED_TOOLS 白名单严格限制模型只能调用 git add/status/commit 三个操作
 * - contentLength: 0 表示内容长度为动态值（shell 展开后才确定）
 * - undercover 模式下会在 prompt 前插入隐身指令（仅限 Anthropic 内部员工）
 *
 * 对应命令：/commit（无参数）
 */
import type { Command } from '../commands.js'
import { getAttributionTexts } from '../utils/attribution.js'
import { executeShellCommandsInPrompt } from '../utils/promptShellExecution.js'
import { getUndercoverInstructions, isUndercover } from '../utils/undercover.js'

// 严格限制模型可调用的 Bash 工具集合，防止模型执行超出提交范围的破坏性 git 操作
const ALLOWED_TOOLS = [
  'Bash(git add:*)',
  'Bash(git status:*)',
  'Bash(git commit:*)',
]

/**
 * 构建 /commit 命令的 prompt 内容。
 *
 * 生成包含以下部分的结构化 prompt：
 * 1. Context 段：内嵌 shell 命令占位符（git status/diff/branch/log），运行时展开
 * 2. Git Safety Protocol：禁止 amend、跳过 hooks、提交 secrets 等安全规则
 * 3. Task 段：要求模型分析变更、生成 commit message，并用 HEREDOC 语法提交
 *
 * undercover 模式（Anthropic 内部员工）下，在 prompt 最前面插入隐身指令。
 *
 * @returns 待传入 executeShellCommandsInPrompt 的原始 prompt 字符串
 */
function getPromptContent(): string {
  const { commit: commitAttribution } = getAttributionTexts()

  // undercover 模式：在 prompt 最前面插入隐身指令（仅 Anthropic 内部员工可触发）
  let prefix = ''
  if (process.env.USER_TYPE === 'ant' && isUndercover()) {
    prefix = getUndercoverInstructions() + '\n'
  }

  return `${prefix}## Context

- Current git status: !\`git status\`
- Current git diff (staged and unstaged changes): !\`git diff HEAD\`
- Current branch: !\`git branch --show-current\`
- Recent commits: !\`git log --oneline -10\`

## Git Safety Protocol

- NEVER update the git config
- NEVER skip hooks (--no-verify, --no-gpg-sign, etc) unless the user explicitly requests it
- CRITICAL: ALWAYS create NEW commits. NEVER use git commit --amend, unless the user explicitly requests it
- Do not commit files that likely contain secrets (.env, credentials.json, etc). Warn the user if they specifically request to commit those files
- If there are no changes to commit (i.e., no untracked files and no modifications), do not create an empty commit
- Never use git commands with the -i flag (like git rebase -i or git add -i) since they require interactive input which is not supported

## Your task

Based on the above changes, create a single git commit:

1. Analyze all staged changes and draft a commit message:
   - Look at the recent commits above to follow this repository's commit message style
   - Summarize the nature of the changes (new feature, enhancement, bug fix, refactoring, test, docs, etc.)
   - Ensure the message accurately reflects the changes and their purpose (i.e. "add" means a wholly new feature, "update" means an enhancement to an existing feature, "fix" means a bug fix, etc.)
   - Draft a concise (1-2 sentences) commit message that focuses on the "why" rather than the "what"

2. Stage relevant files and create the commit using HEREDOC syntax:
\`\`\`
git commit -m "$(cat <<'EOF'
Commit message here.${commitAttribution ? `\n\n${commitAttribution}` : ''}
EOF
)"
\`\`\`

You have the capability to call multiple tools in a single response. Stage and create the commit using a single message. Do not use any other tools or do anything else. Do not send any other text or messages besides these tool calls.`
}

/**
 * /commit 命令注册描述符。
 *
 * type: 'prompt' 表示此命令通过将 prompt 注入对话来驱动模型完成任务，
 * 而非直接执行代码。getPromptForCommand 负责将 prompt 模板展开为最终内容。
 */
const command = {
  type: 'prompt',
  name: 'commit',
  description: 'Create a git commit',
  allowedTools: ALLOWED_TOOLS,
  contentLength: 0, // Dynamic content
  progressMessage: 'creating commit',
  source: 'builtin',
  async getPromptForCommand(_args, context) {
    const promptContent = getPromptContent()
    // 展开 !\`shell command\` 占位符，注入实际的 git 状态信息
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
              // 临时注入 ALLOWED_TOOLS 作为始终允许规则，使 shell 展开时能执行 git 命令
              alwaysAllowRules: {
                ...appState.toolPermissionContext.alwaysAllowRules,
                command: ALLOWED_TOOLS,
              },
            },
          }
        },
      },
      '/commit',
    )

    return [{ type: 'text', text: finalContent }]
  },
} satisfies Command

export default command
