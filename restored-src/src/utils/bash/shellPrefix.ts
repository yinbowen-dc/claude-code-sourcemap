/**
 * Shell 前缀命令格式化模块。
 *
 * 在 Claude Code 系统中，该模块提供 formatShellPrefixCommand() 工具函数，
 * 用于将 shell 可执行路径（含可选参数）与待执行命令组合为正确引号化的命令字符串。
 * 支持三种场景：
 * - 纯可执行名（如 "bash"）→ 引号化为 'bash' command
 * - 带参数的路径（如 "/usr/bin/bash -c"）→ 分割路径与参数后分别引号化
 * - Windows 路径（如 "C:\Program Files\Git\bin\bash.exe -c"）→ 正确处理含空格的路径
 */
import { quote } from './shellQuote.js'

/**
 * 解析可能包含可执行路径和参数的 shell 前缀字符串，
 * 将其与待执行命令拼合为带正确引号的完整命令行。
 *
 * 处理逻辑：
 * 1. 在前缀中查找最后一个 " -" 位置，以此区分可执行路径与命令行参数。
 * 2. 若找到该分隔位置，则对路径部分单独引号化，参数部分原样保留，
 *    再将 command 引号化后追加在末尾。
 * 3. 若未找到，则将整个 prefix 作为可执行路径进行引号化处理。
 *
 * 示例：
 * - "bash"                              → 'bash' 'command'
 * - "/usr/bin/bash -c"                  → '/usr/bin/bash' -c 'command'
 * - "C:\Program Files\Git\bin\bash.exe -c" → 'C:\Program Files\Git\bin\bash.exe' -c 'command'
 *
 * @param prefix 包含可执行路径及可选参数的 shell 前缀字符串
 * @param command 需要被执行的目标命令
 * @returns 各部分均已正确引号化的完整命令字符串
 */
export function formatShellPrefixCommand(
  prefix: string,
  command: string,
): string {
  // 在最后一个 " -" 处切分，将可执行路径与命令行参数（如 -c）分离
  const spaceBeforeDash = prefix.lastIndexOf(' -')
  if (spaceBeforeDash > 0) {
    // 分别提取可执行路径和参数部分
    const execPath = prefix.substring(0, spaceBeforeDash)
    const args = prefix.substring(spaceBeforeDash + 1)
    // 仅对路径和 command 引号化，保留参数原样
    return `${quote([execPath])} ${args} ${quote([command])}`
  } else {
    // 无参数分隔符，整体作为可执行路径引号化
    return `${quote([prefix])} ${quote([command])}`
  }
}
