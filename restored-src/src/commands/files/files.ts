/**
 * files 命令实现模块（files.ts）
 *
 * 本文件实现 /files 斜杠命令的核心逻辑，用于展示当前会话上下文中
 * Claude 已读取过的文件列表。
 *
 * 在 Claude Code 的工具调用体系中，每当 Claude 使用 Read 工具读取文件时，
 * 该文件的路径和内容会被缓存到 `ToolUseContext.readFileState` 中，
 * 形成一个"会话文件状态缓存"。/files 命令通过读取这个缓存来列出
 * 所有已被 Claude 访问过的文件，帮助用户了解 Claude 当前"看到"了哪些文件。
 *
 * 流程位置：用户输入 /files → files/index.ts 懒加载本模块
 *           → call() 读取 readFileState 缓存键 → 转换为相对路径 → 返回文本列表
 */
import { relative } from 'path'
import type { ToolUseContext } from '../../Tool.js'
import type { LocalCommandResult } from '../../types/command.js'
import { getCwd } from '../../utils/cwd.js'
import { cacheKeys } from '../../utils/fileStateCache.js'

/**
 * /files 命令的执行函数
 *
 * 从工具使用上下文的文件状态缓存中提取所有已读取文件的路径，
 * 并转换为相对于当前工作目录的相对路径，逐行输出。
 *
 * 若 readFileState 不存在或缓存为空（Claude 尚未读取任何文件），
 * 则返回"No files in context"提示。
 */
export async function call(
  _args: string,
  context: ToolUseContext,
): Promise<LocalCommandResult> {
  // 从文件状态缓存中提取所有已读取文件的绝对路径；缓存不存在时使用空数组
  const files = context.readFileState ? cacheKeys(context.readFileState) : []

  if (files.length === 0) {
    // 空状态提示：Claude 在本次会话中尚未通过 Read 工具读取过任何文件
    return { type: 'text' as const, value: 'No files in context' }
  }

  // 将绝对路径转换为相对于当前工作目录的路径，提升可读性
  const fileList = files.map(file => relative(getCwd(), file)).join('\n')
  return { type: 'text' as const, value: `Files in context:\n${fileList}` }
}
