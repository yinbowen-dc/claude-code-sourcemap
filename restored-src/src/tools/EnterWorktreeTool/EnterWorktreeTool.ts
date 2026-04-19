/**
 * 【EnterWorktreeTool 主模块】
 *
 * 在 Claude Code 系统流程中的位置：
 *   EnterWorktreeTool 是 git worktree 会话隔离的入口工具。
 *   当用户明确要求"在 worktree 中工作"时，AI 调用此工具；
 *   工具通过 createWorktreeForSession 在主仓库下创建新的 git worktree，
 *   然后切换进程工作目录（process.chdir）和会话 CWD，使后续所有文件操作
 *   都在独立的 worktree 分支上进行，不影响主分支。
 *
 * 主要功能：
 *   - 校验当前会话是否已在 worktree 中（防止嵌套）
 *   - 解析并切换到主仓库根目录（兼容在 worktree 内部再次创建 worktree 的场景）
 *   - 调用 createWorktreeForSession 创建 worktree（支持 git 原生或 hooks 插件）
 *   - 更新进程 CWD、会话 CWD、originalCwd，持久化 worktree 状态
 *   - 清除依赖 CWD 的缓存：系统提示词章节、记忆文件缓存、plans 目录缓存
 *   - 上报 tengu_worktree_created 分析事件
 */

import { z } from 'zod/v4'
import { getSessionId, setOriginalCwd } from '../../bootstrap/state.js'
import { clearSystemPromptSections } from '../../constants/systemPromptSections.js'
import { logEvent } from '../../services/analytics/index.js'
import type { Tool } from '../../Tool.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { clearMemoryFileCaches } from '../../utils/claudemd.js'
import { getCwd } from '../../utils/cwd.js'
import { findCanonicalGitRoot } from '../../utils/git.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { getPlanSlug, getPlansDirectory } from '../../utils/plans.js'
import { setCwd } from '../../utils/Shell.js'
import { saveWorktreeState } from '../../utils/sessionStorage.js'
import {
  createWorktreeForSession,
  getCurrentWorktreeSession,
  validateWorktreeSlug,
} from '../../utils/worktree.js'
import { ENTER_WORKTREE_TOOL_NAME } from './constants.js'
import { getEnterWorktreeToolPrompt } from './prompt.js'
import { renderToolResultMessage, renderToolUseMessage } from './UI.js'

// 输入 Schema：可选的 name 参数，用于命名新建的 worktree
const inputSchema = lazySchema(() =>
  z.strictObject({
    name: z
      .string()
      .superRefine((s, ctx) => {
        // 调用 validateWorktreeSlug 校验名称格式：仅允许字母/数字/点/下划线/短横线，最长 64 字符
        try {
          validateWorktreeSlug(s)
        } catch (e) {
          ctx.addIssue({ code: 'custom', message: (e as Error).message })
        }
      })
      .optional()
      .describe(
        'Optional name for the worktree. Each "/"-separated segment may contain only letters, digits, dots, underscores, and dashes; max 64 chars total. A random name is generated if not provided.',
      ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

// 输出 Schema：worktree 路径、分支名（可选）和确认消息
const outputSchema = lazySchema(() =>
  z.object({
    worktreePath: z.string(),
    worktreeBranch: z.string().optional(),
    message: z.string(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

export const EnterWorktreeTool: Tool<InputSchema, Output> = buildTool({
  name: ENTER_WORKTREE_TOOL_NAME,
  searchHint: 'create an isolated git worktree and switch into it',
  maxResultSizeChars: 100_000,
  async description() {
    return 'Creates an isolated worktree (via git or configured hooks) and switches the session into it'
  },
  async prompt() {
    return getEnterWorktreeToolPrompt()
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  userFacingName() {
    return 'Creating worktree'  // 在 UI 进度提示中显示
  },
  shouldDefer: true,  // 创建 worktree 需要用户批准
  toAutoClassifierInput(input) {
    // 自动分类器输入：提供 worktree 名称（若未指定则为空字符串）
    return input.name ?? ''
  },
  renderToolUseMessage,
  renderToolResultMessage,
  /**
   * 执行 worktree 创建和会话切换
   *
   * 流程：
   * 1. 检查是否已处于 worktree 会话中（防止重复创建）
   * 2. 查找主仓库根目录，若当前不在主仓库根则切换过去（兼容 worktree 内嵌套场景）
   * 3. 确定 slug（优先使用 input.name，否则使用 getPlanSlug() 生成随机名称）
   * 4. 调用 createWorktreeForSession 创建 worktree（git 原生或 hooks 插件）
   * 5. 更新进程 CWD（process.chdir）→ 更新会话 CWD（setCwd）→ 设置 originalCwd
   * 6. 持久化 worktree 状态到 session storage（ExitWorktreeTool 恢复时依赖）
   * 7. 清除所有依赖 CWD 的缓存（系统提示词章节、记忆文件、plans 目录）
   * 8. 上报分析事件
   * 9. 返回 worktree 路径、分支和操作指引消息
   */
  async call(input) {
    // 1. 防止嵌套：若当前会话已在 worktree 中，直接抛错
    if (getCurrentWorktreeSession()) {
      throw new Error('Already in a worktree session')
    }

    // 2. 解析主仓库根目录，确保 worktree 创建命令从正确位置执行
    const mainRepoRoot = findCanonicalGitRoot(getCwd())
    if (mainRepoRoot && mainRepoRoot !== getCwd()) {
      // 从 worktree 子目录内切换到主仓库根，避免 git worktree add 路径错误
      process.chdir(mainRepoRoot)
      setCwd(mainRepoRoot)
    }

    // 3. 确定 worktree slug（名称）
    const slug = input.name ?? getPlanSlug()

    // 4. 创建 worktree（内部实现：git worktree add 或委托给 WorktreeCreate hook）
    const worktreeSession = await createWorktreeForSession(getSessionId(), slug)

    // 5. 切换进程和会话工作目录到新 worktree
    process.chdir(worktreeSession.worktreePath)
    setCwd(worktreeSession.worktreePath)
    setOriginalCwd(getCwd())  // 记录 worktree 中的原始 CWD，供 ExitWorktreeTool 恢复

    // 6. 持久化 worktree 状态（worktreePath、worktreeBranch 等）
    saveWorktreeState(worktreeSession)

    // 7. 清除依赖 CWD 的缓存，确保后续调用基于新 worktree 路径重新计算
    clearSystemPromptSections()  // 强制 env_info_simple 在新目录下重新生成
    clearMemoryFileCaches()       // 清除 CLAUDE.md 等记忆文件的 memoize 缓存
    getPlansDirectory.cache.clear?.()  // 清除 plans 目录路径缓存

    // 8. 上报 worktree 创建事件（mid_session=true 表示在会话中途创建）
    logEvent('tengu_worktree_created', {
      mid_session: true,
    })

    // 9. 构造分支信息后缀（可能无分支信息）
    const branchInfo = worktreeSession.worktreeBranch
      ? ` on branch ${worktreeSession.worktreeBranch}`
      : ''

    return {
      data: {
        worktreePath: worktreeSession.worktreePath,
        worktreeBranch: worktreeSession.worktreeBranch,
        message: `Created worktree at ${worktreeSession.worktreePath}${branchInfo}. The session is now working in the worktree. Use ExitWorktree to leave mid-session, or exit the session to be prompted.`,
      },
    }
  },
  /**
   * 将结构化输出转换为 API tool_result 格式。
   * 直接返回确认消息字符串，通知 AI 当前已切换到 worktree。
   */
  mapToolResultToToolResultBlockParam({ message }, toolUseID) {
    return {
      type: 'tool_result',
      content: message,
      tool_use_id: toolUseID,
    }
  },
} satisfies ToolDef<InputSchema, Output>)
