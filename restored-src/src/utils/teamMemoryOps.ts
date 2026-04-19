/**
 * teamMemoryOps.ts — 团队共享记忆文件操作辅助函数
 *
 * 在 Claude Code 多智能体架构中，团队成员可以通过"团队记忆"（Team Memory）
 * 共享信息。团队记忆文件存储在特定路径（由 memdir/teamMemPaths.ts 管理），
 * 与普通项目文件区分。
 *
 * 本文件提供三个职责：
 *   1. 重导出 isTeamMemFile() — 判断路径是否为团队记忆文件
 *   2. isTeamMemorySearch()   — 判断搜索工具调用是否针对团队记忆
 *   3. isTeamMemoryWriteOrEdit() — 判断写入/编辑工具调用是否针对团队记忆
 *   4. appendTeamMemorySummaryParts() — 为操作摘要文本追加团队记忆相关描述
 *
 * 这些函数被上层（如 getSearchReadSummaryText）用于区分普通文件操作和
 * 团队记忆操作，从而在 UI 中显示不同的描述文本。
 */

import { isTeamMemFile } from '../memdir/teamMemPaths.js'
import { FILE_EDIT_TOOL_NAME } from '../tools/FileEditTool/constants.js'
import { FILE_WRITE_TOOL_NAME } from '../tools/FileWriteTool/prompt.js'

// 重导出路径判断工具函数，方便调用方统一从本模块导入
export { isTeamMemFile }

/**
 * 判断一个搜索工具调用（Search/Grep 等）是否以团队记忆文件为目标。
 *
 * 通过检查工具输入中的 path 字段来判断。如果 path 指向团队记忆目录，
 * 则认为这是一次团队记忆搜索操作。
 *
 * @param toolInput - 工具调用的输入参数（通常含 path / pattern / glob 字段）
 * @returns true 表示该搜索针对团队记忆文件
 */
export function isTeamMemorySearch(toolInput: unknown): boolean {
  // 将 unknown 类型转换为已知的搜索工具输入结构
  const input = toolInput as
    | { path?: string; pattern?: string; glob?: string }
    | undefined
  if (!input) {
    return false
  }
  // 检查 path 字段是否指向团队记忆目录
  if (input.path && isTeamMemFile(input.path)) {
    return true
  }
  return false
}

/**
 * 判断一个文件写入或编辑工具调用是否针对团队记忆文件。
 *
 * 仅对 FileWrite 和 FileEdit 工具生效；其他工具直接返回 false。
 * 通过 file_path 或 path 字段判断目标文件是否为团队记忆文件。
 *
 * @param toolName  - 工具名称（如 "Write" / "Edit"）
 * @param toolInput - 工具调用的输入参数
 * @returns true 表示该写入/编辑操作针对团队记忆文件
 */
export function isTeamMemoryWriteOrEdit(
  toolName: string,
  toolInput: unknown,
): boolean {
  // 仅对写文件和编辑文件工具进行检查
  if (toolName !== FILE_WRITE_TOOL_NAME && toolName !== FILE_EDIT_TOOL_NAME) {
    return false
  }
  // 兼容两种字段名：file_path（FileWrite）和 path（FileEdit）
  const input = toolInput as { file_path?: string; path?: string } | undefined
  const filePath = input?.file_path ?? input?.path
  return filePath !== undefined && isTeamMemFile(filePath)
}

/**
 * 向摘要文本片段数组追加团队记忆相关的描述。
 *
 * 根据操作是否正在进行（isActive），选择动词的现在进行时或过去时，
 * 并区分单数/复数（memory vs memories）。
 *
 * 该函数被 getSearchReadSummaryText() 等摘要生成函数调用，
 * 用于将团队记忆读取、搜索、写入的次数转换为自然语言描述片段。
 *
 * @param memoryCounts - 各类操作计数（读/搜索/写）
 * @param isActive     - 操作是否仍在进行中（影响动词时态）
 * @param parts        - 摘要文本片段数组，函数会向其追加内容
 */
export function appendTeamMemorySummaryParts(
  memoryCounts: {
    teamMemoryReadCount?: number
    teamMemorySearchCount?: number
    teamMemoryWriteCount?: number
  },
  isActive: boolean,
  parts: string[],
): void {
  const teamReadCount = memoryCounts.teamMemoryReadCount ?? 0
  const teamSearchCount = memoryCounts.teamMemorySearchCount ?? 0
  const teamWriteCount = memoryCounts.teamMemoryWriteCount ?? 0

  // 处理团队记忆读取计数：生成 "Recalling N team memories" 或 "Recalled N team memories"
  if (teamReadCount > 0) {
    // 根据 isActive 和 parts 是否为空决定动词形式（首字母大写 / 小写）
    const verb = isActive
      ? parts.length === 0
        ? 'Recalling'
        : 'recalling'
      : parts.length === 0
        ? 'Recalled'
        : 'recalled'
    parts.push(
      `${verb} ${teamReadCount} team ${teamReadCount === 1 ? 'memory' : 'memories'}`,
    )
  }

  // 处理团队记忆搜索计数：生成 "Searching team memories" 或 "Searched team memories"
  if (teamSearchCount > 0) {
    const verb = isActive
      ? parts.length === 0
        ? 'Searching'
        : 'searching'
      : parts.length === 0
        ? 'Searched'
        : 'searched'
    parts.push(`${verb} team memories`)
  }

  // 处理团队记忆写入计数：生成 "Writing N team memories" 或 "Wrote N team memories"
  if (teamWriteCount > 0) {
    const verb = isActive
      ? parts.length === 0
        ? 'Writing'
        : 'writing'
      : parts.length === 0
        ? 'Wrote'
        : 'wrote'
    parts.push(
      `${verb} ${teamWriteCount} team ${teamWriteCount === 1 ? 'memory' : 'memories'}`,
    )
  }
}
