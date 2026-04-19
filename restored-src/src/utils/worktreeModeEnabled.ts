/**
 * Worktree 模式开关模块。
 *
 * 在 Claude Code 系统流程中的位置：
 * 此模块控制 git worktree 功能是否对所有用户启用。
 * 被 worktree.ts 中的创建和管理逻辑以及 CLI 参数解析层引用，
 * 用于决定是否允许执行 --worktree 相关操作。
 *
 * 主要功能：
 * - 以前通过 GrowthBook 特性标志 'tengu_worktree_mode' 控制
 * - 由于 CACHED_MAY_BE_STALE 模式在首次启动前返回默认值（false），
 *   会静默吞掉 --worktree 参数（见 issue #27044）
 * - 现已移除特性标志，无条件返回 true，对所有用户启用 worktree 模式
 */

/**
 * 判断 worktree 模式是否已启用。
 *
 * 流程：
 * - 直接返回 true，无条件启用
 * - 先前通过 GrowthBook 标志动态读取，但因缓存时序问题已弃用该方式
 *
 * @returns 始终为 true
 */
export function isWorktreeModeEnabled(): boolean {
  // worktree 模式已对所有用户无条件启用
  return true
}
