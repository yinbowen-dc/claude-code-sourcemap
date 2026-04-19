/**
 * Shell 历史命令补全模块
 *
 * 在 Claude Code 系统流程中的位置：
 * 该模块属于提示输入（PromptInput）UI 层的自动补全子系统。
 * 当用户在提示框中输入以 "!" 开头的词元时，UI 层会调用本模块
 * 查找历史对话中的 Shell 命令，并以"幽灵文本（ghost text）"
 * 形式显示匹配命令的剩余部分供用户快速补全。
 *
 * 工作原理：
 * - Claude 在历史记录中以 "!" 前缀标记 Shell 命令（如 "!git status"）。
 * - 本模块读取这些历史条目，去重后缓存（最多 50 条，TTL 60 秒）。
 * - 用户每次输入时进行前缀匹配，返回第一个匹配的完整命令及其后缀。
 *
 * 主要导出：
 * - getShellHistoryCompletion：主入口，获取最佳匹配
 * - clearShellHistoryCache：清空缓存
 * - prependToShellHistoryCache：将新命令插入缓存头部（无需完整刷新）
 */

import { getHistory } from '../../history.js'
import { logForDebugging } from '../debug.js'

/**
 * Shell 历史命令补全结果类型。
 * fullCommand 为完整命令，suffix 为用户尚未输入的后缀（用于 ghost text）。
 */
export type ShellHistoryMatch = {
  /** 历史记录中的完整命令 */
  fullCommand: string
  /** 要显示为幽灵文本的后缀（即用户输入之后的部分） */
  suffix: string
}

// ─── 模块级缓存 ───────────────────────────────────────────────────────────────

// Shell 历史命令缓存，null 表示尚未初始化
let shellHistoryCache: string[] | null = null
// 缓存写入时的时间戳（毫秒）
let shellHistoryCacheTimestamp = 0
// 缓存 TTL：60 秒。用户打字过程中历史不会改变，长 TTL 合理
const CACHE_TTL_MS = 60000 // 60 seconds - history won't change while typing

// ─── 内部函数 ─────────────────────────────────────────────────────────────────

/**
 * 读取并缓存 Shell 历史命令列表（私有，带 60 秒 TTL 缓存）。
 *
 * 流程：
 * 1. 若缓存仍在有效期内，直接返回缓存。
 * 2. 遍历 getHistory() 异步迭代器，筛选以 "!" 开头的 display 条目。
 * 3. 去除 "!" 前缀，去重，最多保留 50 条最新的唯一命令。
 * 4. 更新缓存和时间戳后返回。
 */
async function getShellHistoryCommands(): Promise<string[]> {
  const now = Date.now()

  // 缓存命中：仍在 TTL 内，直接返回
  if (shellHistoryCache && now - shellHistoryCacheTimestamp < CACHE_TTL_MS) {
    return shellHistoryCache
  }

  const commands: string[] = []
  const seen = new Set<string>()

  try {
    // 遍历历史记录条目，筛选 Shell 命令
    for await (const entry of getHistory()) {
      if (entry.display && entry.display.startsWith('!')) {
        // 去掉 "!" 前缀，获取实际命令内容
        const command = entry.display.slice(1).trim()
        if (command && !seen.has(command)) {
          seen.add(command)
          commands.push(command)
        }
      }
      // 最多保留 50 条去重命令，超出后提前退出循环
      if (commands.length >= 50) {
        break
      }
    }
  } catch (error) {
    // 读取历史失败时记录调试日志，不向上抛出异常
    logForDebugging(`Failed to read shell history: ${error}`)
  }

  // 更新缓存和时间戳
  shellHistoryCache = commands
  shellHistoryCacheTimestamp = now
  return commands
}

// ─── 导出函数 ─────────────────────────────────────────────────────────────────

/**
 * 清空 Shell 历史缓存。
 * 当用户提交新命令后可调用此函数，使下次查询能读取到最新历史。
 */
export function clearShellHistoryCache(): void {
  shellHistoryCache = null
  shellHistoryCacheTimestamp = 0
}

/**
 * 将指定命令插入缓存头部，无需清空整个缓存。
 *
 * 使用场景：用户刚提交一条命令，希望它立刻出现在补全候选的最前面，
 * 但不想触发完整的历史重新读取。
 *
 * 流程：
 * 1. 若缓存尚未初始化（null），不做操作（下次查询会完整读取历史）。
 * 2. 若命令已在缓存中，先将其从原位置移除（去重）。
 * 3. 将命令插入缓存头部（unshift）。
 *
 * @param command 要插入缓存头部的命令字符串（不含 "!" 前缀）
 */
export function prependToShellHistoryCache(command: string): void {
  // 缓存未初始化时为 no-op
  if (!shellHistoryCache) {
    return
  }
  // 若命令已存在，先从原位置删除以实现去重
  const idx = shellHistoryCache.indexOf(command)
  if (idx !== -1) {
    shellHistoryCache.splice(idx, 1)
  }
  // 插入到头部，使其优先被匹配
  shellHistoryCache.unshift(command)
}

/**
 * 根据用户当前输入，从历史命令中找到最佳前缀匹配项。
 *
 * 流程：
 * 1. 输入为空或长度小于 2 时，返回 null（避免无意义的补全）。
 * 2. trim 后仍为空（如纯空格），返回 null。
 * 3. 获取缓存的历史命令列表。
 * 4. 线性查找第一个以 input 开头且不等于 input 的命令。
 * 5. 返回完整命令和 suffix（命令中 input 之后的部分）。
 *
 * 注意：匹配使用精确前缀（含空格），"ls " 可匹配 "ls -lah"，
 * 但 "ls  "（两个空格）不会匹配 "ls -lah"。
 *
 * @param input 当前用户输入（不含 "!" 前缀）
 * @returns 最佳匹配项，或 null（无匹配）
 */
export async function getShellHistoryCompletion(
  input: string,
): Promise<ShellHistoryMatch | null> {
  // 输入为空或过短，不提供补全建议
  if (!input || input.length < 2) {
    return null
  }

  // 纯空白输入也不提供补全
  const trimmedInput = input.trim()
  if (!trimmedInput) {
    return null
  }

  const commands = await getShellHistoryCommands()

  // 线性扫描，找到第一个以 input 为前缀且不完全相同的历史命令
  for (const command of commands) {
    if (command.startsWith(input) && command !== input) {
      return {
        fullCommand: command,
        // suffix 是用户尚未输入的部分，用于 ghost text 显示
        suffix: command.slice(input.length),
      }
    }
  }

  // 无匹配
  return null
}
