/**
 * Bash 管道命令重排模块。
 *
 * 在 Claude Code 系统中，该模块负责将含管道（|）的 shell 命令安全地重排，
 * 使 stdin 重定向（< /dev/null）作用于管道第一段命令而非 eval 整体：
 * - rearrangePipeCommand()：主入口，解析后重排或降级为整体 eval-quote
 * - 安全降级场景：反引号、$()、shell 变量引用、控制结构、行续接后含换行、
 *   shell-quote 的单引号 bug、token 格式异常（注入防护）
 * - buildCommandParts()：重建命令片段，正确处理 FD 重定向与环境变量赋值
 * - singleQuoteForEval()：将命令单引号化以供 eval 使用，不破坏 jq/awk 过滤器
 */
import {
  hasMalformedTokens,
  hasShellQuoteSingleQuoteBug,
  type ParseEntry,
  quote,
  tryParseShellCommand,
} from './shellQuote.js'

/**
 * 将含管道的命令重排，使 stdin 重定向紧接第一段命令之后插入。
 * 修复 eval 将整条管道命令视为单一单元时，stdin 重定向作用于 eval 本身而非第一段命令的问题。
 * 遇到反引号、$()、shell 变量、控制结构、换行符、单引号 bug 或 token 格式异常时，
 * 降级为对整条命令进行整体 eval-quote（安全回退）。
 */
export function rearrangePipeCommand(command: string): string {
  // Skip if command has backticks - shell-quote doesn't handle them well
  if (command.includes('`')) {
    return quoteWithEvalStdinRedirect(command)
  }

  // Skip if command has command substitution - shell-quote parses $() incorrectly,
  // treating ( and ) as separate operators instead of recognizing command substitution
  if (command.includes('$(')) {
    return quoteWithEvalStdinRedirect(command)
  }

  // Skip if command references shell variables ($VAR, ${VAR}). shell-quote's parse()
  // expands these to empty string when no env is passed, silently dropping the
  // reference. Even if we preserved the token via an env function, quote() would
  // then escape the $ during rebuild, preventing runtime expansion. See #9732.
  if (/\$[A-Za-z_{]/.test(command)) {
    return quoteWithEvalStdinRedirect(command)
  }

  // Skip if command contains bash control structures (for/while/until/if/case/select)
  // shell-quote cannot parse these correctly and will incorrectly find pipes inside
  // the control structure body, breaking the command when rearranged
  if (containsControlStructure(command)) {
    return quoteWithEvalStdinRedirect(command)
  }

  // Join continuation lines before parsing: shell-quote doesn't handle \<newline>
  // and produces empty string tokens for each occurrence, causing spurious empty
  // arguments in the reconstructed command
  const joined = joinContinuationLines(command)

  // shell-quote treats bare newlines as whitespace, not command separators.
  // Parsing+rebuilding 'cmd1 | head\ncmd2 | grep' yields 'cmd1 | head cmd2 | grep',
  // silently merging pipelines. Line-continuation (\<newline>) is already stripped
  // above; any remaining newline is a real separator. Bail to the eval fallback,
  // which preserves the newline inside a single-quoted arg. See #32515.
  if (joined.includes('\n')) {
    return quoteWithEvalStdinRedirect(command)
  }

  // SECURITY: shell-quote treats \' inside single quotes as an escape, but
  // bash treats it as literal \ followed by a closing quote. The pattern
  // '\' <payload> '\' makes shell-quote merge <payload> into the quoted
  // string, hiding operators like ; from the token stream. Rebuilding from
  // that merged token can expose the operators when bash re-parses.
  if (hasShellQuoteSingleQuoteBug(joined)) {
    return quoteWithEvalStdinRedirect(command)
  }

  const parseResult = tryParseShellCommand(joined)

  // If parsing fails (malformed syntax), fall back to quoting the whole command
  if (!parseResult.success) {
    return quoteWithEvalStdinRedirect(command)
  }

  const parsed = parseResult.tokens

  // SECURITY: shell-quote tokenizes differently from bash. Input like
  // `echo {"hi":\"hi;calc.exe"}` is a bash syntax error (unbalanced quote),
  // but shell-quote parses it into tokens with `;` as an operator and
  // `calc.exe` as a separate word. Rebuilding from those tokens produces
  // valid bash that executes `calc.exe` — turning a syntax error into an
  // injection. Unbalanced delimiters in a string token signal this
  // misparsing; fall back to whole-command quoting, which preserves the
  // original (bash then rejects it with the same syntax error it would have
  // raised without us).
  if (hasMalformedTokens(joined, parsed)) {
    return quoteWithEvalStdinRedirect(command)
  }

  const firstPipeIndex = findFirstPipeOperator(parsed)

  if (firstPipeIndex <= 0) {
    return quoteWithEvalStdinRedirect(command)
  }

  // Rebuild: first_command < /dev/null | rest_of_pipeline
  const parts = [
    ...buildCommandParts(parsed, 0, firstPipeIndex),
    '< /dev/null',
    ...buildCommandParts(parsed, firstPipeIndex, parsed.length),
  ]

  return singleQuoteForEval(parts.join(' '))
}

/**
 * 在已解析的 shell token 数组中查找第一个管道运算符（|）的位置。
 * 返回其索引；若不存在则返回 -1。
 */
function findFirstPipeOperator(parsed: ParseEntry[]): number {
  for (let i = 0; i < parsed.length; i++) {
    const entry = parsed[i]
    if (isOperator(entry, '|')) {
      return i
    }
  }
  return -1
}

/**
 * 从解析后的 token 数组中重建指定范围的命令片段列表。
 * 对字符串 token 进行 shell quote；特殊处理 FD 重定向（2>&1、2>/dev/null 等）
 * 使其合并为单一部分；对环境变量赋值（VAR=value）仅对值部分进行 quote。
 */
function buildCommandParts(
  parsed: ParseEntry[],
  start: number,
  end: number,
): string[] {
  const parts: string[] = []
  // Track if we've seen a non-env-var string token yet
  // Environment variables are only valid at the start of a command
  let seenNonEnvVar = false

  for (let i = start; i < end; i++) {
    const entry = parsed[i]

    // Check for file descriptor redirections (e.g., 2>&1, 2>/dev/null)
    if (
      typeof entry === 'string' &&
      /^[012]$/.test(entry) &&
      i + 2 < end &&
      isOperator(parsed[i + 1])
    ) {
      const op = parsed[i + 1] as { op: string }
      const target = parsed[i + 2]

      // Handle 2>&1 style redirections
      if (
        op.op === '>&' &&
        typeof target === 'string' &&
        /^[012]$/.test(target)
      ) {
        parts.push(`${entry}>&${target}`)
        i += 2
        continue
      }

      // Handle 2>/dev/null style redirections
      if (op.op === '>' && target === '/dev/null') {
        parts.push(`${entry}>/dev/null`)
        i += 2
        continue
      }

      // Handle 2> &1 style (space between > and &1)
      if (
        op.op === '>' &&
        typeof target === 'string' &&
        target.startsWith('&')
      ) {
        const fd = target.slice(1)
        if (/^[012]$/.test(fd)) {
          parts.push(`${entry}>&${fd}`)
          i += 2
          continue
        }
      }
    }

    // Handle regular entries
    if (typeof entry === 'string') {
      // Environment variable assignments are only valid at the start of a command,
      // before any non-env-var tokens (the actual command and its arguments)
      const isEnvVar = !seenNonEnvVar && isEnvironmentVariableAssignment(entry)

      if (isEnvVar) {
        // For env var assignments, we need to preserve the = but quote the value if needed
        // Split into name and value parts
        const eqIndex = entry.indexOf('=')
        const name = entry.slice(0, eqIndex)
        const value = entry.slice(eqIndex + 1)

        // Quote the value part to handle spaces and special characters
        const quotedValue = quote([value])
        parts.push(`${name}=${quotedValue}`)
      } else {
        // Once we see a non-env-var string, all subsequent strings are arguments
        seenNonEnvVar = true
        parts.push(quote([entry]))
      }
    } else if (isOperator(entry)) {
      // Special handling for glob operators
      if (entry.op === 'glob' && 'pattern' in entry) {
        // Don't quote glob patterns - they need to remain as-is for shell expansion
        parts.push(entry.pattern as string)
      } else {
        parts.push(entry.op)
        // Reset after command separators - the next command can have its own env vars
        if (isCommandSeparator(entry.op)) {
          seenNonEnvVar = false
        }
      }
    }
  }

  return parts
}

/**
 * 判断字符串是否为环境变量赋值形式（VAR=value）。
 * 变量名须以字母或下划线开头，后跟字母、数字或下划线，再接 `=`。
 */
function isEnvironmentVariableAssignment(str: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(str)
}

/**
 * 判断运算符是否为命令分隔符（&&、||、;）。
 * 遇到命令分隔符后，下一段命令允许再次出现环境变量赋值。
 */
function isCommandSeparator(op: string): boolean {
  return op === '&&' || op === '||' || op === ';'
}

/**
 * 类型守卫：判断解析后的 entry 是否为运算符对象（{ op: string }）。
 * 可选第二参数 op 用于精确匹配运算符字符串。
 */
function isOperator(entry: unknown, op?: string): entry is { op: string } {
  if (!entry || typeof entry !== 'object' || !('op' in entry)) {
    return false
  }
  return op ? entry.op === op : true
}

/**
 * 检测命令是否包含 shell-quote 无法正确解析的控制结构关键字
 * （for / while / until / if / case / select），以关键字后接空白字符来匹配，
 * 避免将命令名或参数中恰好含有这些词的情况误判。
 */
function containsControlStructure(command: string): boolean {
  return /\b(for|while|until|if|case|select)\s/.test(command)
}

/**
 * 对无法解析管道边界的命令（含 $()、反引号、控制结构等），将整条命令
 * 单引号化后追加 ` < /dev/null` 作为 eval 级别的 stdin 重定向。
 * 注意：` < /dev/null` 在引号外，由 shell 直接处理，而非作为 eval 的参数。
 */
function quoteWithEvalStdinRedirect(command: string): string {
  return singleQuoteForEval(command) + ' < /dev/null'
}

/**
 * 将字符串以单引号包裹，使其可作为 eval 的参数安全传递。
 * 内嵌单引号通过 `'"'"'` 序列转义（关闭单引号→双引号内字面单引号→重开单引号）。
 * 不使用 shell-quote 的 quote()，因其在含单引号时会切换为双引号模式并转义 `!`，
 * 破坏 jq/awk 中的 `select(.x != .y)` 等过滤器。
 */
function singleQuoteForEval(s: string): string {
  return "'" + s.replace(/'/g, `'"'"'`) + "'"
}

/**
 * 将命令中的行续接序列（反斜杠 + 换行）合并为单行。
 * 仅合并奇数个反斜杠后接换行的情况（最后一个反斜杠转义换行）；
 * 偶数个反斜杠（两两配对为转义序列）时保留换行作为真正的分隔符。
 */
function joinContinuationLines(command: string): string {
  return command.replace(/\\+\n/g, match => {
    const backslashCount = match.length - 1 // -1 for the newline
    if (backslashCount % 2 === 1) {
      // Odd number: last backslash escapes the newline (line continuation)
      return '\\'.repeat(backslashCount - 1)
    } else {
      // Even number: all pair up, newline is a real separator
      return match
    }
  })
}
