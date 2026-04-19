/**
 * 【EnterWorktreeTool 提示词模块】
 *
 * 在 Claude Code 系统流程中的位置：
 *   本文件为 EnterWorktreeTool 提供发送给 Claude 模型的工具使用说明（system prompt 片段）。
 *   通过 getEnterWorktreeToolPrompt() 被 EnterWorktreeTool.ts 的 prompt() 钩子调用。
 *
 * 主要功能：
 *   - 明确说明工具的调用条件：仅在用户明确提到 "worktree" 时才触发
 *   - 描述禁止调用的场景（切换分支/修复 bug 等不需要 worktree 的任务）
 *   - 列出前置要求（git 仓库或配置 hooks）、行为说明和参数说明
 */

/**
 * 生成 EnterWorktreeTool 的工具提示词字符串。
 *
 * 内容包括：
 * - When to Use：仅限用户明确说 "worktree" 时调用
 * - When NOT to Use：切换分支、修 bug、实现功能等均不需要 worktree
 * - Requirements：需要 git 仓库或配置了 WorktreeCreate/WorktreeRemove hooks
 * - Behavior：描述 worktree 创建位置（.claude/worktrees/）和会话切换行为
 * - Parameters：可选 name 参数说明
 */
export function getEnterWorktreeToolPrompt(): string {
  return `Use this tool ONLY when the user explicitly asks to work in a worktree. This tool creates an isolated git worktree and switches the current session into it.

## When to Use

- The user explicitly says "worktree" (e.g., "start a worktree", "work in a worktree", "create a worktree", "use a worktree")

## When NOT to Use

- The user asks to create a branch, switch branches, or work on a different branch — use git commands instead
- The user asks to fix a bug or work on a feature — use normal git workflow unless they specifically mention worktrees
- Never use this tool unless the user explicitly mentions "worktree"

## Requirements

- Must be in a git repository, OR have WorktreeCreate/WorktreeRemove hooks configured in settings.json
- Must not already be in a worktree

## Behavior

- In a git repository: creates a new git worktree inside \`.claude/worktrees/\` with a new branch based on HEAD
- Outside a git repository: delegates to WorktreeCreate/WorktreeRemove hooks for VCS-agnostic isolation
- Switches the session's working directory to the new worktree
- Use ExitWorktree to leave the worktree mid-session (keep or remove). On session exit, if still in the worktree, the user will be prompted to keep or remove it

## Parameters

- \`name\` (optional): A name for the worktree. If not provided, a random name is generated.
`
}
