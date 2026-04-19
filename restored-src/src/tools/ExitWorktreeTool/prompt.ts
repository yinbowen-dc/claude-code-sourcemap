/**
 * 【ExitWorktreeTool 提示词模块】
 *
 * 在 Claude Code 系统流程中的位置：
 *   本文件为 ExitWorktreeTool 提供发送给 Claude 模型的工具使用说明（system prompt 片段）。
 *   ExitWorktreeTool.ts 的 prompt() 钩子调用 getExitWorktreeToolPrompt() 生成此内容。
 *
 * 主要功能：
 *   - 说明工具的作用域：仅操作本会话中由 EnterWorktree 创建的 worktree
 *   - 描述使用时机：用户明确要求"退出 worktree"时调用
 *   - 列出 action 参数的语义（keep / remove）和 discard_changes 的用法
 *   - 说明退出后的行为：恢复原始 CWD、清除缓存、tmux 会话处理
 */

/**
 * 生成 ExitWorktreeTool 的工具提示词字符串。
 *
 * 内容结构：
 * - Scope：说明哪些 worktree 在操作范围内（仅限当前会话 EnterWorktree 创建的）
 * - When to Use：仅限用户明确要求退出时调用
 * - Parameters：action（keep/remove）和 discard_changes（强制丢弃变更标志）
 * - Behavior：退出效果——恢复 CWD、清缓存、tmux 处理
 */
export function getExitWorktreeToolPrompt(): string {
  return `Exit a worktree session created by EnterWorktree and return the session to the original working directory.

## Scope

This tool ONLY operates on worktrees created by EnterWorktree in this session. It will NOT touch:
- Worktrees you created manually with \`git worktree add\`
- Worktrees from a previous session (even if created by EnterWorktree then)
- The directory you're in if EnterWorktree was never called

If called outside an EnterWorktree session, the tool is a **no-op**: it reports that no worktree session is active and takes no action. Filesystem state is unchanged.

## When to Use

- The user explicitly asks to "exit the worktree", "leave the worktree", "go back", or otherwise end the worktree session
- Do NOT call this proactively — only when the user asks

## Parameters

- \`action\` (required): \`"keep"\` or \`"remove"\`
  - \`"keep"\` — leave the worktree directory and branch intact on disk. Use this if the user wants to come back to the work later, or if there are changes to preserve.
  - \`"remove"\` — delete the worktree directory and its branch. Use this for a clean exit when the work is done or abandoned.
- \`discard_changes\` (optional, default false): only meaningful with \`action: "remove"\`. If the worktree has uncommitted files or commits not on the original branch, the tool will REFUSE to remove it unless this is set to \`true\`. If the tool returns an error listing changes, confirm with the user before re-invoking with \`discard_changes: true\`.

## Behavior

- Restores the session's working directory to where it was before EnterWorktree
- Clears CWD-dependent caches (system prompt sections, memory files, plans directory) so the session state reflects the original directory
- If a tmux session was attached to the worktree: killed on \`remove\`, left running on \`keep\` (its name is returned so the user can reattach)
- Once exited, EnterWorktree can be called again to create a fresh worktree
`
}
