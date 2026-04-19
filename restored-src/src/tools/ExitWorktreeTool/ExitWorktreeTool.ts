/**
 * 【ExitWorktreeTool 主模块】
 *
 * 在 Claude Code 系统流程中的位置：
 *   ExitWorktreeTool 是 git worktree 会话隔离的退出工具，是 EnterWorktreeTool 的逆操作。
 *   当用户请求离开当前 worktree 会话时，AI 调用此工具；
 *   工具恢复进程工作目录、会话 CWD 及所有相关缓存到进入 worktree 之前的状态。
 *
 * 主要功能：
 *   - countWorktreeChanges()：检测 worktree 中的未提交文件数和新增提交数（fail-closed：
 *     无法确定时返回 null，视为不安全）
 *   - restoreSessionToOriginalCwd()：EnterWorktreeTool 所有会话级变更的逆操作
 *   - validateInput()：
 *       - 范围守卫：仅操作本会话 EnterWorktree 创建的 worktree
 *       - 安全守卫：action=remove 且无 discard_changes=true 时检测是否有未保存工作
 *   - call()：
 *       - keep：调用 keepWorktree() + 恢复会话状态 + 上报事件
 *       - remove：先杀死 tmux 会话（若有） + cleanupWorktree() + 恢复会话状态 + 上报事件
 */

import { z } from 'zod/v4'
import {
  getOriginalCwd,
  getProjectRoot,
  setOriginalCwd,
  setProjectRoot,
} from '../../bootstrap/state.js'
import { clearSystemPromptSections } from '../../constants/systemPromptSections.js'
import { logEvent } from '../../services/analytics/index.js'
import type { Tool } from '../../Tool.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { count } from '../../utils/array.js'
import { clearMemoryFileCaches } from '../../utils/claudemd.js'
import { execFileNoThrow } from '../../utils/execFileNoThrow.js'
import { updateHooksConfigSnapshot } from '../../utils/hooks/hooksConfigSnapshot.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { getPlansDirectory } from '../../utils/plans.js'
import { setCwd } from '../../utils/Shell.js'
import { saveWorktreeState } from '../../utils/sessionStorage.js'
import {
  cleanupWorktree,
  getCurrentWorktreeSession,
  keepWorktree,
  killTmuxSession,
} from '../../utils/worktree.js'
import { EXIT_WORKTREE_TOOL_NAME } from './constants.js'
import { getExitWorktreeToolPrompt } from './prompt.js'
import { renderToolResultMessage, renderToolUseMessage } from './UI.js'

// 输入 Schema：action（keep/remove）和可选的 discard_changes 强制确认标志
const inputSchema = lazySchema(() =>
  z.strictObject({
    action: z
      .enum(['keep', 'remove'])
      .describe(
        '"keep" leaves the worktree and branch on disk; "remove" deletes both.',
      ),
    discard_changes: z
      .boolean()
      .optional()
      .describe(
        'Required true when action is "remove" and the worktree has uncommitted files or unmerged commits. The tool will refuse and list them otherwise.',
      ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

// 输出 Schema：包含执行的操作、路径信息、丢弃统计和确认消息
const outputSchema = lazySchema(() =>
  z.object({
    action: z.enum(['keep', 'remove']),
    originalCwd: z.string(),
    worktreePath: z.string(),
    worktreeBranch: z.string().optional(),
    tmuxSessionName: z.string().optional(),
    discardedFiles: z.number().optional(),
    discardedCommits: z.number().optional(),
    message: z.string(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

// worktree 变更统计摘要类型
type ChangeSummary = {
  changedFiles: number
  commits: number
}

/**
 * 统计 worktree 中的未提交变更文件数和相对于原始 HEAD 的新增提交数。
 *
 * 采用 fail-closed 策略：
 * - 当无法可靠确定状态时返回 null（而非 0/0），调用方应视 null 为"不安全"
 * - 这防止了 cleanupWorktree 在 git 状态异常时误删真实工作成果
 *
 * 返回 null 的情形：
 * - git status 或 rev-list 退出码非零（锁文件/索引损坏/引用错误等）
 * - originalHeadCommit 未定义但 git status 成功——这是 hook-based worktree 包装 git 的情形
 *   （worktree.ts:525-532 不设置 originalHeadCommit）：工作目录是 git 仓库但无基准提交，
 *   无法证明分支干净，因此 fail-closed
 *
 * @param worktreePath       - worktree 的绝对路径
 * @param originalHeadCommit - 进入 worktree 时的原始 HEAD 提交 SHA（可能为 undefined）
 * @returns ChangeSummary 或 null（无法确定状态时）
 */
async function countWorktreeChanges(
  worktreePath: string,
  originalHeadCommit: string | undefined,
): Promise<ChangeSummary | null> {
  // 执行 git status --porcelain 获取文件级变更列表
  const status = await execFileNoThrow('git', [
    '-C',
    worktreePath,
    'status',
    '--porcelain',
  ])
  if (status.code !== 0) {
    // git status 失败（可能是锁文件或损坏的索引），无法确定状态
    return null
  }
  // 统计非空行数（每行对应一个有变更的文件）
  const changedFiles = count(status.stdout.split('\n'), l => l.trim() !== '')

  if (!originalHeadCommit) {
    // git status 成功（说明这是 git 仓库），但无基准提交无法计算提交数——fail-closed
    return null
  }

  // 统计相对于原始 HEAD 的新增提交数
  const revList = await execFileNoThrow('git', [
    '-C',
    worktreePath,
    'rev-list',
    '--count',
    `${originalHeadCommit}..HEAD`,
  ])
  if (revList.code !== 0) {
    return null
  }
  const commits = parseInt(revList.stdout.trim(), 10) || 0

  return { changedFiles, commits }
}

/**
 * 将会话状态恢复到进入 worktree 之前的状态。
 * 这是 EnterWorktreeTool.call() 中会话级变更的精确逆操作。
 *
 * keepWorktree()/cleanupWorktree() 负责 process.chdir 和 currentWorktreeSession；
 * 本函数负责 worktree 工具层之上的所有状态恢复。
 *
 * @param originalCwd         - 进入 worktree 之前的工作目录路径
 * @param projectRootIsWorktree - 是否需要同步恢复 projectRoot（仅 --worktree 启动模式需要）
 */
function restoreSessionToOriginalCwd(
  originalCwd: string,
  projectRootIsWorktree: boolean,
): void {
  setCwd(originalCwd)  // 恢复会话工作目录
  // EnterWorktree 将 originalCwd 设置为 worktree 路径（有意为之——参见 state.ts 注释）。
  // 重置为真正的原始目录。
  setOriginalCwd(originalCwd)
  // --worktree 启动时将 projectRoot 设置为 worktree；
  // mid-session EnterWorktreeTool 不修改 projectRoot，只有实际变更了才还原，
  // 否则会将 projectRoot 移动到进入 worktree 之前用户所在的任意目录，破坏"稳定项目标识"契约。
  if (projectRootIsWorktree) {
    setProjectRoot(originalCwd)
    // setup.ts 的 --worktree 块调用了 updateHooksConfigSnapshot() 以从 worktree 重新读取 hooks；
    // 这里对称地恢复（mid-session EnterWorktreeTool 从未触及快照，因此这里是无操作）
    updateHooksConfigSnapshot()
  }
  saveWorktreeState(null)         // 清除持久化的 worktree 状态
  clearSystemPromptSections()     // 清除系统提示词章节缓存，下次重新以原目录生成
  clearMemoryFileCaches()         // 清除 CLAUDE.md 等记忆文件的 memoize 缓存
  getPlansDirectory.cache.clear?.()  // 清除 plans 目录路径缓存
}

export const ExitWorktreeTool: Tool<InputSchema, Output> = buildTool({
  name: EXIT_WORKTREE_TOOL_NAME,
  searchHint: 'exit a worktree session and return to the original directory',
  maxResultSizeChars: 100_000,
  async description() {
    return 'Exits a worktree session created by EnterWorktree and restores the original working directory'
  },
  async prompt() {
    return getExitWorktreeToolPrompt()
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  userFacingName() {
    return 'Exiting worktree'  // 在 UI 进度提示中显示
  },
  shouldDefer: true,  // 退出 worktree 需要用户批准（尤其是 remove 操作）
  isDestructive(input) {
    // remove 操作会永久删除 worktree 及分支，标记为破坏性操作
    return input.action === 'remove'
  },
  toAutoClassifierInput(input) {
    // 自动分类器输入：操作类型（keep/remove）
    return input.action
  },
  /**
   * 输入校验：双重安全守卫
   *
   * 1. 范围守卫：仅操作本会话 EnterWorktree 创建的 worktree
   *    - getCurrentWorktreeSession() 为 null 时直接返回无操作
   *    - 不触碰 `git worktree add` 手动创建的或其他会话创建的 worktree
   *
   * 2. 安全守卫（仅 action=remove 且未设 discard_changes=true 时）：
   *    - 调用 countWorktreeChanges() 检测未保存工作
   *    - null（无法确定状态）→ 拒绝执行（fail-closed）
   *    - 有未提交文件或新增提交 → 提示用户确认并以 discard_changes=true 重试
   */
  async validateInput(input) {
    // 范围守卫：getCurrentWorktreeSession() 仅在本会话 createWorktreeForSession 运行后非 null。
    // 手动创建的 worktree 或前一会话创建的 worktree 不会填充此值。
    // 这是唯一的入口守卫——通过此处后的所有操作均针对 EnterWorktree 创建的路径。
    const session = getCurrentWorktreeSession()
    if (!session) {
      return {
        result: false,
        message:
          'No-op: there is no active EnterWorktree session to exit. This tool only operates on worktrees created by EnterWorktree in the current session — it will not touch worktrees created manually or in a previous session. No filesystem changes were made.',
        errorCode: 1,
      }
    }

    // 安全守卫：remove 操作且未明确确认丢弃时，检测工作内容
    if (input.action === 'remove' && !input.discard_changes) {
      const summary = await countWorktreeChanges(
        session.worktreePath,
        session.originalHeadCommit,
      )
      if (summary === null) {
        // fail-closed：无法确认 worktree 是干净的，拒绝删除
        return {
          result: false,
          message: `Could not verify worktree state at ${session.worktreePath}. Refusing to remove without explicit confirmation. Re-invoke with discard_changes: true to proceed — or use action: "keep" to preserve the worktree.`,
          errorCode: 3,
        }
      }
      const { changedFiles, commits } = summary
      if (changedFiles > 0 || commits > 0) {
        // 有未保存工作，告知用户具体情况并要求明确确认
        const parts: string[] = []
        if (changedFiles > 0) {
          parts.push(
            `${changedFiles} uncommitted ${changedFiles === 1 ? 'file' : 'files'}`,
          )
        }
        if (commits > 0) {
          parts.push(
            `${commits} ${commits === 1 ? 'commit' : 'commits'} on ${session.worktreeBranch ?? 'the worktree branch'}`,
          )
        }
        return {
          result: false,
          message: `Worktree has ${parts.join(' and ')}. Removing will discard this work permanently. Confirm with the user, then re-invoke with discard_changes: true — or use action: "keep" to preserve the worktree.`,
          errorCode: 2,
        }
      }
    }

    return { result: true }
  },
  renderToolUseMessage,
  renderToolResultMessage,
  /**
   * 执行 worktree 退出操作
   *
   * keep 分支：
   *   1. 调用 keepWorktree()（更新 currentWorktreeSession + process.chdir 到原目录）
   *   2. 恢复会话级状态（setCwd/originalCwd/projectRoot/缓存）
   *   3. 记录分析事件（含变更统计）
   *   4. 若有 tmux 会话，附加重新连接提示
   *
   * remove 分支：
   *   1. 若有关联 tmux 会话，先终止（killTmuxSession）
   *   2. 调用 cleanupWorktree()（删除 worktree 目录和分支 + process.chdir）
   *   3. 恢复会话级状态
   *   4. 记录分析事件（含丢弃统计）
   */
  async call(input) {
    const session = getCurrentWorktreeSession()
    if (!session) {
      // validateInput 已守卫此处，但 currentWorktreeSession 是模块级可变状态——
      // 防御校验与执行之间的竞争条件
      throw new Error('Not in a worktree session')
    }

    // 在 keepWorktree/cleanupWorktree 将 currentWorktreeSession 置 null 之前捕获所有字段
    const {
      originalCwd,
      worktreePath,
      worktreeBranch,
      tmuxSessionName,
      originalHeadCommit,
    } = session

    // 判断 projectRoot 是否指向 worktree（仅 --worktree 启动时为 true）：
    // --worktree 启动时：setup.ts 紧接着 setCwd(worktreePath) 后调用
    //   setOriginalCwd(getCwd()) 和 setProjectRoot(getCwd())，两者相同，BashTool cd 不会修改它们。
    // mid-session EnterWorktreeTool：只设置了 originalCwd，未修改 projectRoot。
    // （不能用 getCwd()——BashTool 的每次 cd 都会修改它；
    //  不能用 session.worktreePath——它是 join() 拼接的，不是 realpath 处理的）
    const projectRootIsWorktree = getProjectRoot() === getOriginalCwd()

    // 在执行时重新统计变更（validateInput 时的状态可能已改变），
    // null（git 失败）回退到 0/0；安全守卫已在 validateInput 完成，
    // 这里只影响分析事件和输出消息的准确性
    const { changedFiles, commits } = (await countWorktreeChanges(
      worktreePath,
      originalHeadCommit,
    )) ?? { changedFiles: 0, commits: 0 }

    // ── keep 分支 ─────────────────────────────────────────────────────────
    if (input.action === 'keep') {
      await keepWorktree()  // 更新 worktree 状态 + process.chdir 到原目录
      restoreSessionToOriginalCwd(originalCwd, projectRootIsWorktree)

      logEvent('tengu_worktree_kept', {
        mid_session: true,
        commits,
        changed_files: changedFiles,
      })

      // 若有关联的 tmux 会话，提供重新连接命令
      const tmuxNote = tmuxSessionName
        ? ` Tmux session ${tmuxSessionName} is still running; reattach with: tmux attach -t ${tmuxSessionName}`
        : ''
      return {
        data: {
          action: 'keep' as const,
          originalCwd,
          worktreePath,
          worktreeBranch,
          tmuxSessionName,
          message: `Exited worktree. Your work is preserved at ${worktreePath}${worktreeBranch ? ` on branch ${worktreeBranch}` : ''}. Session is now back in ${originalCwd}.${tmuxNote}`,
        },
      }
    }

    // ── remove 分支 ───────────────────────────────────────────────────────
    // 先终止关联的 tmux 会话（避免 tmux 会话持有文件句柄影响目录删除）
    if (tmuxSessionName) {
      await killTmuxSession(tmuxSessionName)
    }
    // 删除 worktree 目录和分支，并 process.chdir 到原目录
    await cleanupWorktree()
    restoreSessionToOriginalCwd(originalCwd, projectRootIsWorktree)

    logEvent('tengu_worktree_removed', {
      mid_session: true,
      commits,
      changed_files: changedFiles,
    })

    // 构造丢弃内容描述（用于用户反馈消息）
    const discardParts: string[] = []
    if (commits > 0) {
      discardParts.push(`${commits} ${commits === 1 ? 'commit' : 'commits'}`)
    }
    if (changedFiles > 0) {
      discardParts.push(
        `${changedFiles} uncommitted ${changedFiles === 1 ? 'file' : 'files'}`,
      )
    }
    const discardNote =
      discardParts.length > 0 ? ` Discarded ${discardParts.join(' and ')}.` : ''
    return {
      data: {
        action: 'remove' as const,
        originalCwd,
        worktreePath,
        worktreeBranch,
        discardedFiles: changedFiles,
        discardedCommits: commits,
        message: `Exited and removed worktree at ${worktreePath}.${discardNote} Session is now back in ${originalCwd}.`,
      },
    }
  },
  /**
   * 将结构化输出转换为 API tool_result 格式。
   * 直接返回操作结果消息，通知 AI 当前会话已回到原目录。
   */
  mapToolResultToToolResultBlockParam({ message }, toolUseID) {
    return {
      type: 'tool_result',
      content: message,
      tool_use_id: toolUseID,
    }
  },
} satisfies ToolDef<InputSchema, Output>)
