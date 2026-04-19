/**
 * Shell 命令引号化与重定向工具模块。
 *
 * 在 Claude Code 系统中，该模块提供一组用于 shell 命令安全处理的工具函数：
 * - containsHeredoc()：检测命令是否包含 here-doc（<<EOF 等）语法，排除位移运算符
 * - containsMultilineString()：检测命令中是否存在跨行引号字符串
 * - quoteShellCommand()：对命令进行引号化，对 heredoc / 多行字符串特殊处理，可选追加 stdin 重定向
 * - hasStdinRedirect()：检测命令是否已包含 stdin 重定向（排除 heredoc / 进程替换）
 * - shouldAddStdinRedirect()：判断是否可安全追加 stdin 重定向
 * - rewriteWindowsNullRedirect()：将模型可能幻觉出的 Windows `>nul` 重定向替换为 POSIX `/dev/null`
 */
import { quote } from './shellQuote.js'

/**
 * 检测命令字符串是否包含 here-doc 语法（<<EOF、<<'EOF'、<<"EOF"、<<-EOF 等）。
 * 优先排除数字位移运算符（`1 << 2`、`$(( ... << ... ))`）后再匹配 heredoc 模式。
 */
function containsHeredoc(command: string): boolean {
  // 匹配 heredoc 模式：<< 后跟可选的 -、可选的引号或反斜杠，再跟单词
  // 匹配：<<EOF、<<'EOF'、<<"EOF"、<<-EOF、<<-'EOF'、<<\EOF
  // 先检查位移运算符并排除
  if (
    /\d\s*<<\s*\d/.test(command) ||
    /\[\[\s*\d+\s*<<\s*\d+\s*\]\]/.test(command) ||
    /\$\(\(.*<<.*\)\)/.test(command)
  ) {
    return false
  }

  // 检查 heredoc 模式
  const heredocRegex = /<<-?\s*(?:(['"]?)(\w+)\1|\\(\w+))/
  return heredocRegex.test(command)
}

/**
 * 检测命令中是否包含跨行引号字符串（单引号或双引号内含实际换行符）。
 * 支持引号内的转义序列（如 `\'`、`\"`）。
 */
function containsMultilineString(command: string): boolean {
  // 检查字符串中是否包含实际换行符
  // 通过更复杂的模式处理转义引号
  // 匹配单引号：'...\n...'，内容可包含转义引号 \'
  // 匹配双引号："...\n..."，内容可包含转义引号 \"
  const singleQuoteMultiline = /'(?:[^'\\]|\\.)*\n(?:[^'\\]|\\.)*'/
  const doubleQuoteMultiline = /"(?:[^"\\]|\\.)*\n(?:[^"\\]|\\.)*"/

  return (
    singleQuoteMultiline.test(command) || doubleQuoteMultiline.test(command)
  )
}

/**
 * 对 shell 命令进行引号化，正确处理 heredoc 和多行字符串。
 * heredoc 命令：使用单引号 eval 方式引号化，不追加 stdin 重定向（heredoc 自带输入流）。
 * 多行字符串命令：同样使用单引号方式，可选追加 stdin 重定向。
 * 普通命令：直接使用 shell-quote 的 quote()，可选追加 stdin 重定向。
 * @param command 待处理的 shell 命令字符串
 * @param addStdinRedirect 是否追加 `< /dev/null`（默认 true）
 */
export function quoteShellCommand(
  command: string,
  addStdinRedirect: boolean = true,
): string {
  // 若命令含 heredoc 或多行字符串，进行特殊处理
  // shell-quote 库在这些情况下会错误地将 ! 转义为 \!
  if (containsHeredoc(command) || containsMultilineString(command)) {
    // 对 heredoc 和多行字符串需要为 eval 引号化，
    // 同时避免 shell-quote 的激进转义
    // 使用单引号，仅转义命令中的单引号
    const escaped = command.replace(/'/g, "'\"'\"'")
    const quoted = `'${escaped}'`

    // heredoc 自带输入流，不追加 stdin 重定向
    if (containsHeredoc(command)) {
      return quoted
    }

    // 无 heredoc 的多行字符串，按需追加 stdin 重定向
    return addStdinRedirect ? `${quoted} < /dev/null` : quoted
  }

  // 普通命令使用 shell-quote
  if (addStdinRedirect) {
    return quote([command, '<', '/dev/null'])
  }

  return quote([command])
}

/**
 * 检测命令是否已包含 stdin 重定向（`< file`、`< /dev/null` 等）。
 * 排除 heredoc（`<<`）和进程替换（`<(`）语法，避免误判。
 */
export function hasStdinRedirect(command: string): boolean {
  // 查找 < 后跟空白和文件名/路径的模式
  // 负向前瞻排除 << 和 <( 语法
  // 前面必须是空白、命令分隔符或字符串开头
  return /(?:^|[\s;&|])<(?![<(])\s*\S+/.test(command)
}

/**
 * 判断是否可安全向命令追加 stdin 重定向（`< /dev/null`）。
 * heredoc 命令自带输入流，不可追加；已有 stdin 重定向的命令也不可追加。
 * @param command 待检查的 shell 命令字符串
 * @returns 可安全追加时返回 true
 */
export function shouldAddStdinRedirect(command: string): boolean {
  // heredoc 自带输入流，追加 stdin 重定向会干扰 heredoc 结束符
  if (containsHeredoc(command)) {
    return false
  }

  // 命令已有 stdin 重定向时不再追加
  if (hasStdinRedirect(command)) {
    return false
  }

  // 其他命令通常可安全追加 stdin 重定向
  return true
}

/**
 * 将 Windows CMD 风格的 `>nul` 重定向替换为 POSIX `/dev/null`。
 *
 * 模型有时会幻觉出 Windows CMD 语法（如 `ls 2>nul`），
 * 而 Git Bash / WSL 的 bash 遇到 `2>nul` 时会创建名为 `nul` 的文件
 * （Windows 保留设备名，极难删除，会导致 `git add .` 和 `git clone` 损坏）。
 * 参见 anthropics/claude-code#4928。
 *
 * 匹配：`>nul`、`> NUL`、`2>nul`、`&>nul`、`>>nul`（大小写不敏感）
 * 不匹配：`>null`、`>nullable`、`>nul.txt`、`cat nul.txt`
 *
 * 注：该正则不解析 shell 引号，`echo ">nul"` 也会被替换，
 * 但此类极少见场景下替换为 `/dev/null` 是无害的。
 */
const NUL_REDIRECT_REGEX = /(\d?&?>+\s*)[Nn][Uu][Ll](?=\s|$|[|&;)\n])/g

export function rewriteWindowsNullRedirect(command: string): string {
  return command.replace(NUL_REDIRECT_REGEX, '$1/dev/null')
}
