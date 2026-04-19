/**
 * Agent 持久化内存模块
 *
 * 在 Claude Code 工具层中，该模块负责管理子 Agent 的持久化内存系统。
 * Agent 可以将跨会话保留的记忆存储在文件系统的特定目录中，
 * 根据作用域分为用户级、项目级和本地级三种。
 *
 * 核心职责：
 * 1. 定义 AgentMemoryScope 类型（user / project / local）
 * 2. 根据作用域和 Agent 类型名称，计算对应的内存目录路径
 * 3. 检测给定路径是否属于 Agent 内存目录（安全校验用途）
 * 4. 构建传递给 Agent 系统提示的内存 prompt 片段
 *
 * 路径约定：
 * - user 作用域：~/.claude/agent-memory/<agentType>/
 * - project 作用域：<cwd>/.claude/agent-memory/<agentType>/
 * - local 作用域：<cwd>/.claude/agent-memory-local/<agentType>/（不进入版本控制）
 *   若设置了 CLAUDE_CODE_REMOTE_MEMORY_DIR 环境变量，则存储到远程挂载点。
 */

import { join, normalize, sep } from 'path'
import { getProjectRoot } from '../../bootstrap/state.js'
import {
  buildMemoryPrompt,
  ensureMemoryDirExists,
} from '../../memdir/memdir.js'
import { getMemoryBaseDir } from '../../memdir/paths.js'
import { getCwd } from '../../utils/cwd.js'
import { findCanonicalGitRoot } from '../../utils/git.js'
import { sanitizePath } from '../../utils/path.js'

// Agent 内存作用域类型：'user' 用户级 / 'project' 项目级 / 'local' 本地级（不入版本控制）
// Persistent agent memory scope: 'user' (~/.claude/agent-memory/), 'project' (.claude/agent-memory/), or 'local' (.claude/agent-memory-local/)
export type AgentMemoryScope = 'user' | 'project' | 'local'

/**
 * 将 Agent 类型名称清理为合法的目录名称。
 *
 * 将冒号替换为短横线，避免 Windows 文件系统不兼容问题。
 * 冒号在插件命名空间化的 Agent 类型中使用，例如 "my-plugin:my-agent"。
 *
 * @param agentType 原始 Agent 类型字符串
 * @returns 可安全用作目录名的清理后字符串
 */
function sanitizeAgentTypeForPath(agentType: string): string {
  // 将所有冒号替换为短横线，以兼容 Windows 路径限制
  return agentType.replace(/:/g, '-')
}

/**
 * 获取本地作用域的 Agent 内存目录路径。
 *
 * 若环境变量 CLAUDE_CODE_REMOTE_MEMORY_DIR 已设置，则内存持久化到
 * 远程挂载点，并以项目 Git 根目录为命名空间，避免跨项目冲突；
 * 否则，使用当前工作目录下的 .claude/agent-memory-local/ 路径。
 *
 * @param dirName 已清理的 Agent 类型目录名
 * @returns 本地作用域的内存目录路径（以路径分隔符结尾）
 */
function getLocalAgentMemoryDir(dirName: string): string {
  if (process.env.CLAUDE_CODE_REMOTE_MEMORY_DIR) {
    // 使用远程挂载点：以 Git 项目根目录作为命名空间区分不同项目的内存
    return (
      join(
        process.env.CLAUDE_CODE_REMOTE_MEMORY_DIR,
        'projects',
        sanitizePath(
          // 优先使用规范 Git 根目录，若不在 Git 仓库则退回项目根目录
          findCanonicalGitRoot(getProjectRoot()) ?? getProjectRoot(),
        ),
        'agent-memory-local',
        dirName,
      ) + sep // 末尾追加路径分隔符以标识目录
    )
  }
  // 默认本地路径：<cwd>/.claude/agent-memory-local/<agentType>/
  return join(getCwd(), '.claude', 'agent-memory-local', dirName) + sep
}

/**
 * 根据 Agent 类型和作用域，返回对应的内存目录路径。
 *
 * 路径规则：
 * - 'user' 作用域：<memoryBase>/agent-memory/<agentType>/
 * - 'project' 作用域：<cwd>/.claude/agent-memory/<agentType>/
 * - 'local' 作用域：参见 getLocalAgentMemoryDir()
 *
 * @param agentType Agent 类型名称
 * @param scope 内存作用域
 * @returns 内存目录的绝对路径（以路径分隔符结尾）
 */
export function getAgentMemoryDir(
  agentType: string,
  scope: AgentMemoryScope,
): string {
  // 将 Agent 类型名清理为合法目录名
  const dirName = sanitizeAgentTypeForPath(agentType)
  switch (scope) {
    case 'project':
      // 项目作用域：存放在项目 .claude 目录下，可通过版本控制共享
      return join(getCwd(), '.claude', 'agent-memory', dirName) + sep
    case 'local':
      // 本地作用域：不入版本控制，支持可选的远程挂载
      return getLocalAgentMemoryDir(dirName)
    case 'user':
      // 用户作用域：存放在全局 Claude 内存目录下，跨项目共享
      return join(getMemoryBaseDir(), 'agent-memory', dirName) + sep
  }
}

/**
 * 检测给定的绝对路径是否属于任意作用域的 Agent 内存目录。
 *
 * 该函数主要用于权限系统安全校验，判断文件操作是否针对 Agent 内存区域。
 *
 * @param absolutePath 待检测的绝对路径
 * @returns 若路径位于 Agent 内存目录范围内则返回 true
 */
// Check if file is within an agent memory directory (any scope).
export function isAgentMemoryPath(absolutePath: string): boolean {
  // SECURITY: Normalize to prevent path traversal bypasses via .. segments
  // 安全：先规范化路径，防止通过 ".." 进行路径穿越攻击
  const normalizedPath = normalize(absolutePath)
  const memoryBase = getMemoryBaseDir()

  // 检查用户作用域：基于全局内存基础目录
  // User scope: check memory base (may be custom dir or config home)
  if (normalizedPath.startsWith(join(memoryBase, 'agent-memory') + sep)) {
    return true
  }

  // 检查项目作用域：始终基于当前工作目录（不受远程挂载影响）
  // Project scope: always cwd-based (not redirected)
  if (
    normalizedPath.startsWith(join(getCwd(), '.claude', 'agent-memory') + sep)
  ) {
    return true
  }

  // 检查本地作用域：根据是否配置远程挂载走不同分支
  // Local scope: persisted to mount when CLAUDE_CODE_REMOTE_MEMORY_DIR is set, otherwise cwd-based
  if (process.env.CLAUDE_CODE_REMOTE_MEMORY_DIR) {
    // 远程挂载情况：路径需同时包含 agent-memory-local 段且位于远程挂载 projects 目录下
    if (
      normalizedPath.includes(sep + 'agent-memory-local' + sep) &&
      normalizedPath.startsWith(
        join(process.env.CLAUDE_CODE_REMOTE_MEMORY_DIR, 'projects') + sep,
      )
    ) {
      return true
    }
  } else if (
    // 无远程挂载：基于当前工作目录的本地路径
    normalizedPath.startsWith(
      join(getCwd(), '.claude', 'agent-memory-local') + sep,
    )
  ) {
    return true
  }

  return false
}

/**
 * 获取指定 Agent 类型和作用域下的内存入口文件路径（MEMORY.md）。
 *
 * @param agentType Agent 类型名称
 * @param scope 内存作用域
 * @returns MEMORY.md 文件的绝对路径
 */
export function getAgentMemoryEntrypoint(
  agentType: string,
  scope: AgentMemoryScope,
): string {
  // 内存入口文件固定命名为 MEMORY.md，位于对应作用域目录下
  return join(getAgentMemoryDir(agentType, scope), 'MEMORY.md')
}

/**
 * 获取内存作用域的人类可读展示文本。
 *
 * 用于 UI 展示当前 Agent 的内存配置信息，展示具体路径以便用户了解存储位置。
 *
 * @param memory 内存作用域，传入 undefined 表示未启用内存
 * @returns 格式化的展示字符串
 */
export function getMemoryScopeDisplay(
  memory: AgentMemoryScope | undefined,
): string {
  switch (memory) {
    case 'user':
      // 用户作用域：展示全局内存基础目录下的路径
      return `User (${join(getMemoryBaseDir(), 'agent-memory')}/)`
    case 'project':
      // 项目作用域：固定展示相对于项目的路径
      return 'Project (.claude/agent-memory/)'
    case 'local':
      // 本地作用域：展示实际本地内存目录路径（用占位符 "..." 替代 agentType）
      return `Local (${getLocalAgentMemoryDir('...')})`
    default:
      // 未启用内存
      return 'None'
  }
}

/**
 * 为启用了持久内存的 Agent 加载内存 prompt 片段。
 *
 * 该函数在 Agent 启动时调用（系统提示生成阶段），会：
 * 1. 根据作用域生成范围提示文字（scopeNote），告知 Agent 应该如何使用内存
 * 2. 异步（fire-and-forget）确保内存目录存在
 * 3. 构建并返回包含内存内容的 prompt 字符串
 *
 * 注意：目录创建为异步触发（非阻塞），因为该函数在 React 渲染路径中
 * 被同步调用，无法等待异步操作。Agent 在实际写入内存前会经历完整
 * 的 API 往返，届时目录创建早已完成。
 *
 * @param agentType Agent 类型名称，用于确定内存目录
 * @param scope 内存作用域，决定存储位置和范围提示文字
 * @returns 包含内存内容的系统提示 prompt 字符串
 */
export function loadAgentMemoryPrompt(
  agentType: string,
  scope: AgentMemoryScope,
): string {
  // 根据作用域生成范围说明文字，指导 Agent 如何维护其内存
  let scopeNote: string
  switch (scope) {
    case 'user':
      // 用户作用域：内存跨项目共享，应保存通用性知识
      scopeNote =
        '- Since this memory is user-scope, keep learnings general since they apply across all projects'
      break
    case 'project':
      // 项目作用域：内存通过版本控制与团队共享，应针对当前项目定制
      scopeNote =
        '- Since this memory is project-scope and shared with your team via version control, tailor your memories to this project'
      break
    case 'local':
      // 本地作用域：不入版本控制，应针对当前项目和机器环境定制
      scopeNote =
        '- Since this memory is local-scope (not checked into version control), tailor your memories to this project and machine'
      break
  }

  const memoryDir = getAgentMemoryDir(agentType, scope)

  // 异步触发目录创建（fire-and-forget）：
  // 该函数在同步的 getSystemPrompt() 回调中被调用，无法使用 async/await。
  // Agent 在第一次 API 往返后才会尝试写入，届时目录早已创建完毕。
  // 即使未完成，FileWriteTool 也会自行创建父目录。
  // Fire-and-forget: this runs at agent-spawn time inside a sync
  // getSystemPrompt() callback (called from React render in AgentDetail.tsx,
  // so it cannot be async). The spawned agent won't try to Write until after
  // a full API round-trip, by which time mkdir will have completed. Even if
  // it hasn't, FileWriteTool does its own mkdir of the parent directory.
  void ensureMemoryDirExists(memoryDir)

  // 可选的额外指引（来自 CLAUDE_COWORK_MEMORY_EXTRA_GUIDELINES 环境变量）
  const coworkExtraGuidelines =
    process.env.CLAUDE_COWORK_MEMORY_EXTRA_GUIDELINES
  // 构建并返回内存提示 prompt，包含范围说明和可选的额外指引
  return buildMemoryPrompt({
    displayName: 'Persistent Agent Memory',
    memoryDir,
    extraGuidelines:
      coworkExtraGuidelines && coworkExtraGuidelines.trim().length > 0
        ? [scopeNote, coworkExtraGuidelines] // 额外指引非空时，追加到范围说明后
        : [scopeNote],                        // 仅使用范围说明
  })
}
