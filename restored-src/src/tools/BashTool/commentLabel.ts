/**
 * BashTool/commentLabel.ts
 *
 * 【在 Claude Code 系统中的位置】
 * 本文件属于 BashTool 工具模块，提供一个轻量级的辅助函数。
 * BashTool 在展示全屏模式（fullscreen mode）的工具调用标签时，
 * 会从命令首行尝试提取注释文本，将其用作可读的 UI 标签。
 *
 * 【主要功能】
 * - 导出 extractBashCommentLabel：从 bash 命令首行提取 # 注释标签。
 *   若首行是合法注释（非 shebang），返回去掉 `#` 前缀的文本；否则返回 undefined。
 */

/**
 * extractBashCommentLabel
 *
 * 【函数作用】
 * 若 bash 命令的第一行是 `# 注释`（而非 `#!` shebang），
 * 则返回去掉 `#` 前缀的注释文本；否则返回 undefined。
 *
 * 在全屏模式下，此注释文本将用作工具调用的非详细标签，
 * 同时也作为折叠组（collapse-group）⎿ 提示——这是 Claude 为用户撰写的可读说明。
 *
 * If the first line of a bash command is a `# comment` (not a `#!` shebang),
 * return the comment text stripped of the `#` prefix. Otherwise undefined.
 *
 * Under fullscreen mode this is the non-verbose tool-use label AND the
 * collapse-group ⎿ hint — it's what Claude wrote for the human to read.
 */
export function extractBashCommentLabel(command: string): string | undefined {
  // 找到第一个换行符位置，截取首行
  const nl = command.indexOf('\n')
  const firstLine = (nl === -1 ? command : command.slice(0, nl)).trim()
  // 若首行不以 # 开头，或是 shebang (#!)，则无标签
  if (!firstLine.startsWith('#') || firstLine.startsWith('#!')) return undefined
  // 去除连续的 # 及紧跟的空白，返回注释正文；空字符串返回 undefined
  return firstLine.replace(/^#+\s*/, '') || undefined
}
