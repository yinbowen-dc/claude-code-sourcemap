/**
 * BashTool/sedValidation.ts
 *
 * 【在 Claude Code 系统中的位置】
 * 本文件属于 BashTool 工具模块，负责 sed 命令的安全性校验。
 * 在 BashTool 权限流程中，sed 命令需经过本文件校验，
 * 阻止含危险操作（w/W/e/E 命令，可写文件或执行任意代码）的 sed 调用。
 *
 * 【主要功能】
 * - validateFlagsAgainstAllowlist：通用 flag 白名单校验辅助函数（支持组合 flag）。
 * - isLinePrintingCommand：模式一——判断是否为带 -n 的行打印命令（`Np`/`N,Mp`/`;` 分隔多个 `p`）。
 * - isPrintCommand：辅助函数——判断单条表达式是否为合法打印命令（严格白名单）。
 * - isSubstitutionCommand：模式二——判断是否为替换命令（`s/pattern/replacement/flags`），
 *   含 allowFileWrites 选项（acceptEdits 模式下允许 -i flag）。
 * - sedCommandIsAllowedByAllowlist：对外主函数——检查 sed 命令是否在白名单内（允许列表 + 拒绝列表）。
 * - hasFileArgs：判断 sed 命令是否含文件参数（非 stdin 模式）。
 * - extractSedExpressions：从 sed 命令中提取所有 sed 表达式（供后续危险操作检测使用）。
 * - containsDangerousOperations：对单条表达式执行拒绝列表检查（w/W/e/E 及各种危险模式）。
 * - checkSedConstraints：对外导出的 sed 约束入口，供 BashTool 权限流程调用。
 */
import type { ToolPermissionContext } from '../../Tool.js'
import { splitCommand_DEPRECATED } from '../../utils/bash/commands.js'
import { tryParseShellCommand } from '../../utils/bash/shellQuote.js'
import type { PermissionResult } from '../../utils/permissions/PermissionResult.js'

/**
 * validateFlagsAgainstAllowlist
 *
 * 【函数作用】
 * 通用 flag 白名单校验辅助函数。
 * 对每个 flag 进行处理：
 *   - 组合 flag（如 -nE）：逐字符拆分为单字符 flag，各自验证；
 *   - 单字符 flag 或长 flag：直接在白名单中查找。
 * 所有 flag 均在白名单中则返回 true，否则返回 false。
 *
 * Helper: Validate flags against an allowlist
 * Handles both single flags and combined flags (e.g., -nE)
 * @param flags Array of flags to validate
 * @param allowedFlags Array of allowed single-character and long flags
 * @returns true if all flags are valid, false otherwise
 */
function validateFlagsAgainstAllowlist(
  flags: string[],
  allowedFlags: string[],
): boolean {
  for (const flag of flags) {
    // 处理组合 flag（如 -nE 或 -Er），逐字符拆解后校验
    // Handle combined flags like -nE or -Er
    if (flag.startsWith('-') && !flag.startsWith('--') && flag.length > 2) {
      // Check each character in combined flag
      for (let i = 1; i < flag.length; i++) {
        const singleFlag = '-' + flag[i]
        if (!allowedFlags.includes(singleFlag)) {
          return false
        }
      }
    } else {
      // 单字符 flag 或长 flag，直接查找
      // Single flag or long flag
      if (!allowedFlags.includes(flag)) {
        return false
      }
    }
  }
  return true
}

/**
 * isLinePrintingCommand
 *
 * 【函数作用】
 * 模式一：判断 sed 命令是否为带 -n 的行打印命令。
 * 允许以下形式：
 *   - `sed -n 'Np'`、`sed -n 'N,Mp'`（打印指定行或范围）
 *   - `sed -n '1p;2p;3p'`（分号分隔的多个打印命令）
 * 允许附带文件参数。
 *
 * 【校验逻辑】
 *   1. 确认命令以 sed 开头；
 *   2. shell tokenize 后提取所有 flag，通过 validateFlagsAgainstAllowlist 校验；
 *   3. 必须含 -n 标志；
 *   4. 必须有至少一个表达式；
 *   5. 所有表达式（分号分隔后的子命令）必须通过 isPrintCommand 严格校验。
 *
 * Pattern 1: Check if this is a line printing command with -n flag
 * Allows: sed -n 'N' | sed -n 'N,M' with optional -E, -r, -z flags
 * Allows semicolon-separated print commands like: sed -n '1p;2p;3p'
 * File arguments are ALLOWED for this pattern
 * @internal Exported for testing
 */
export function isLinePrintingCommand(
  command: string,
  expressions: string[],
): boolean {
  const sedMatch = command.match(/^\s*sed\s+/)
  if (!sedMatch) return false

  const withoutSed = command.slice(sedMatch[0].length)
  const parseResult = tryParseShellCommand(withoutSed)
  if (!parseResult.success) return false
  const parsed = parseResult.tokens

  // 提取命令中所有 flag（非 -- 结束符的以 - 开头的参数）
  // Extract all flags
  const flags: string[] = []
  for (const arg of parsed) {
    if (typeof arg === 'string' && arg.startsWith('-') && arg !== '--') {
      flags.push(arg)
    }
  }

  // 校验 flag：只允许 -n 及扩展正则相关 flag
  // Validate flags - only allow -n, -E, -r, -z and their long forms
  const allowedFlags = [
    '-n',
    '--quiet',
    '--silent',
    '-E',
    '--regexp-extended',
    '-r',
    '-z',
    '--zero-terminated',
    '--posix',
  ]

  if (!validateFlagsAgainstAllowlist(flags, allowedFlags)) {
    return false
  }

  // 模式一要求必须存在 -n flag（含组合 flag 中的 n）
  // Check if -n flag is present (required for Pattern 1)
  let hasNFlag = false
  for (const flag of flags) {
    if (flag === '-n' || flag === '--quiet' || flag === '--silent') {
      hasNFlag = true
      break
    }
    // Check in combined flags
    if (flag.startsWith('-') && !flag.startsWith('--') && flag.includes('n')) {
      hasNFlag = true
      break
    }
  }

  // Must have -n flag for Pattern 1
  if (!hasNFlag) {
    return false
  }

  // 至少需要一个表达式
  // Must have at least one expression
  if (expressions.length === 0) {
    return false
  }

  // 所有表达式（分号拆分后）必须均为打印命令（严格白名单）
  // All expressions must be print commands (strict allowlist)
  // Allow semicolon-separated commands
  for (const expr of expressions) {
    const commands = expr.split(';')
    for (const cmd of commands) {
      if (!isPrintCommand(cmd.trim())) {
        return false
      }
    }
  }

  return true
}

/**
 * isPrintCommand
 *
 * 【函数作用】
 * 严格白名单——判断单条 sed 表达式是否为合法打印命令。
 * 仅允许以下精确形式：
 *   - `p`：打印全部
 *   - `Np`：打印第 N 行（N 为数字）
 *   - `N,Mp`：打印 N~M 行范围
 * 其他任何形式（包括 w、W、e、E 命令）均拒绝。
 *
 * Helper: Check if a single command is a valid print command
 * STRICT ALLOWLIST - only these exact forms are allowed:
 * - p (print all)
 * - Np (print line N, where N is digits)
 * - N,Mp (print lines N through M)
 * Anything else (including w, W, e, E commands) is rejected.
 * @internal Exported for testing
 */
export function isPrintCommand(cmd: string): boolean {
  if (!cmd) return false
  // 精确正则：^(?:\d+|\d+,\d+)?p$ 仅匹配：p、1p、123p、1,5p、10,200p
  // Single strict regex that only matches allowed print commands
  // ^(?:\d+|\d+,\d+)?p$ matches: p, 1p, 123p, 1,5p, 10,200p
  return /^(?:\d+|\d+,\d+)?p$/.test(cmd)
}

/**
 * isSubstitutionCommand
 *
 * 【函数作用】
 * 模式二：判断 sed 命令是否为替换命令（`s/pattern/replacement/flags`）。
 * 仅允许 flags 为 `g`、`p`、`i`、`I`、`m`、`M`、`1-9` 的组合。
 *
 * 【allowFileWrites 选项】
 *   - false（默认，只读模式）：不允许文件参数，不允许 -i flag；
 *   - true（acceptEdits 模式）：允许 -i/--in-place flag 和文件参数（原地编辑）。
 *
 * 【校验逻辑】
 *   1. 检查文件参数与 allowFileWrites 的兼容性；
 *   2. shell tokenize 并提取 flag，按模式校验白名单；
 *   3. 仅允许恰好一个表达式；
 *   4. 表达式必须以 `s` 开头，使用 `/` 作为分隔符；
 *   5. 逐字符解析，确认恰好两个分隔符；
 *   6. 校验表达式 flags 仅含安全字符。
 *
 * Pattern 2: Check if this is a substitution command
 * Allows: sed 's/pattern/replacement/flags' where flags are only: g, p, i, I, m, M, 1-9
 * When allowFileWrites is true, allows -i flag and file arguments for in-place editing
 * When allowFileWrites is false (default), requires stdout-only (no file arguments, no -i flag)
 * @internal Exported for testing
 */
function isSubstitutionCommand(
  command: string,
  expressions: string[],
  hasFileArguments: boolean,
  options?: { allowFileWrites?: boolean },
): boolean {
  const allowFileWrites = options?.allowFileWrites ?? false

  // 只读模式下不允许文件参数
  // When not allowing file writes, must NOT have file arguments
  if (!allowFileWrites && hasFileArguments) {
    return false
  }

  const sedMatch = command.match(/^\s*sed\s+/)
  if (!sedMatch) return false

  const withoutSed = command.slice(sedMatch[0].length)
  const parseResult = tryParseShellCommand(withoutSed)
  if (!parseResult.success) return false
  const parsed = parseResult.tokens

  // 提取所有 flag
  // Extract all flags
  const flags: string[] = []
  for (const arg of parsed) {
    if (typeof arg === 'string' && arg.startsWith('-') && arg !== '--') {
      flags.push(arg)
    }
  }

  // 根据模式确定允许的 flag 列表
  // Validate flags based on mode
  // Base allowed flags for both modes
  const allowedFlags = ['-E', '--regexp-extended', '-r', '--posix']

  // allowFileWrites 模式下额外允许 -i
  // When allowing file writes, also permit -i and --in-place
  if (allowFileWrites) {
    allowedFlags.push('-i', '--in-place')
  }

  if (!validateFlagsAgainstAllowlist(flags, allowedFlags)) {
    return false
  }

  // 恰好一个表达式
  // Must have exactly one expression
  if (expressions.length !== 1) {
    return false
  }

  const expr = expressions[0]!.trim()

  // 严格白名单：必须以 's' 开头（拒绝 e、w 等独立命令）
  // STRICT ALLOWLIST: Must be exactly a substitution command starting with 's'
  // This rejects standalone commands like 'e', 'w file', etc.
  if (!expr.startsWith('s')) {
    return false
  }

  // 解析替换表达式：s/pattern/replacement/flags，仅允许 / 作为分隔符
  // Parse substitution: s/pattern/replacement/flags
  // Only allow / as delimiter (strict)
  const substitutionMatch = expr.match(/^s\/(.*?)$/)
  if (!substitutionMatch) {
    return false
  }

  const rest = substitutionMatch[1]!

  // 逐字符统计分隔符数量，跳过转义字符
  // Find the positions of / delimiters
  let delimiterCount = 0
  let lastDelimiterPos = -1
  let i = 0
  while (i < rest.length) {
    if (rest[i] === '\\') {
      // 跳过转义字符
      // Skip escaped character
      i += 2
      continue
    }
    if (rest[i] === '/') {
      delimiterCount++
      lastDelimiterPos = i
    }
    i++
  }

  // 必须恰好两个分隔符（pattern 和 replacement）
  // Must have found exactly 2 delimiters (pattern and replacement)
  if (delimiterCount !== 2) {
    return false
  }

  // 提取最后一个分隔符之后的表达式 flags
  // Extract flags (everything after the last delimiter)
  const exprFlags = rest.slice(lastDelimiterPos + 1)

  // 校验表达式 flags 仅含安全字符（g/p/i/I/m/M 及可选一位数字 1-9）
  // Validate flags: only allow g, p, i, I, m, M, and optionally ONE digit 1-9
  const allowedFlagChars = /^[gpimIM]*[1-9]?[gpimIM]*$/
  if (!allowedFlagChars.test(exprFlags)) {
    return false
  }

  return true
}

/**
 * sedCommandIsAllowedByAllowlist
 *
 * 【函数作用】
 * 检查 sed 命令是否在允许列表内（允许列表 + 拒绝列表双重校验）。
 *
 * 【执行流程】
 *   1. 提取 sed 表达式（extractSedExpressions），解析失败则拒绝；
 *   2. 检测命令是否含文件参数（hasFileArgs）；
 *   3. 按 allowFileWrites 模式尝试模式一（行打印）和/或模式二（替换）匹配；
 *      任一未匹配则返回 false；
 *   4. 模式二不允许表达式中含分号（防命令链注入），模式一允许；
 *   5. 深度防御：即使允许列表命中，仍通过 containsDangerousOperations 拒绝列表检查。
 *
 * Checks if a sed command is allowed by the allowlist.
 * The allowlist patterns themselves are strict enough to reject dangerous operations.
 * @param command The sed command to check
 * @param options.allowFileWrites When true, allows -i flag and file arguments for substitution commands
 * @returns true if the command is allowed (matches allowlist and passes denylist check), false otherwise
 */
export function sedCommandIsAllowedByAllowlist(
  command: string,
  options?: { allowFileWrites?: boolean },
): boolean {
  const allowFileWrites = options?.allowFileWrites ?? false

  // 提取 sed 表达式，解析失败则拒绝
  // Extract sed expressions (content inside quotes where actual sed commands live)
  let expressions: string[]
  try {
    expressions = extractSedExpressions(command)
  } catch (_error) {
    // If parsing failed, treat as not allowed
    return false
  }

  // 检测是否含文件参数
  // Check if sed command has file arguments
  const hasFileArguments = hasFileArgs(command)

  // 尝试匹配模式一或模式二
  // Check if command matches allowlist patterns
  let isPattern1 = false
  let isPattern2 = false

  if (allowFileWrites) {
    // allowFileWrites 模式：仅检查替换命令（行打印不需要文件写入）
    // When allowing file writes, only check substitution commands (Pattern 2 variant)
    // Pattern 1 (line printing) doesn't need file writes
    isPattern2 = isSubstitutionCommand(command, expressions, hasFileArguments, {
      allowFileWrites: true,
    })
  } else {
    // 标准只读模式：同时检查两种模式
    // Standard read-only mode: check both patterns
    isPattern1 = isLinePrintingCommand(command, expressions)
    isPattern2 = isSubstitutionCommand(command, expressions, hasFileArguments)
  }

  if (!isPattern1 && !isPattern2) {
    return false
  }

  // 模式二不允许分号（命令分隔符）；模式一允许分号分隔打印命令
  // Pattern 2 does not allow semicolons (command separators)
  // Pattern 1 allows semicolons for separating print commands
  for (const expr of expressions) {
    if (isPattern2 && expr.includes(';')) {
      return false
    }
  }

  // 深度防御：即使允许列表命中，仍执行拒绝列表检查
  // Defense-in-depth: Even if allowlist matches, check denylist
  for (const expr of expressions) {
    if (containsDangerousOperations(expr)) {
      return false
    }
  }

  return true
}

/**
 * hasFileArgs
 *
 * 【函数作用】
 * 判断 sed 命令是否含文件参数（非纯 stdin 模式）。
 *
 * 【判断逻辑】
 *   - 有 -e flag：-e 之后的所有非 flag 参数均为文件参数；
 *   - 无 -e flag：第一个非 flag 参数为 sed 表达式，第二个起为文件参数；
 *   - glob token（如 *.log）直接视为文件参数；
 *   - 解析失败时保守返回 true（假定有文件参数）。
 *
 * Check if a sed command has file arguments (not just stdin)
 * @internal Exported for testing
 */
export function hasFileArgs(command: string): boolean {
  const sedMatch = command.match(/^\s*sed\s+/)
  if (!sedMatch) return false

  const withoutSed = command.slice(sedMatch[0].length)
  const parseResult = tryParseShellCommand(withoutSed)
  if (!parseResult.success) return true // 解析失败时保守处理
  const parsed = parseResult.tokens

  try {
    let argCount = 0
    let hasEFlag = false

    for (let i = 0; i < parsed.length; i++) {
      const arg = parsed[i]

      // Handle both string arguments and glob patterns (like *.log)
      if (typeof arg !== 'string' && typeof arg !== 'object') continue

      // glob 模式直接视为文件参数
      // If it's a glob pattern, it counts as a file argument
      if (
        typeof arg === 'object' &&
        arg !== null &&
        'op' in arg &&
        arg.op === 'glob'
      ) {
        return true
      }

      // Skip non-string arguments that aren't glob patterns
      if (typeof arg !== 'string') continue

      // 处理 -e flag，跳过其后的表达式参数
      // Handle -e flag followed by expression
      if ((arg === '-e' || arg === '--expression') && i + 1 < parsed.length) {
        hasEFlag = true
        i++ // Skip the next argument since it's the expression
        continue
      }

      // 处理 --expression=value 形式
      // Handle --expression=value format
      if (arg.startsWith('--expression=')) {
        hasEFlag = true
        continue
      }

      // 处理 -e=value 形式（非标准，深度防御）
      // Handle -e=value format (non-standard but defense in depth)
      if (arg.startsWith('-e=')) {
        hasEFlag = true
        continue
      }

      // 跳过其他 flag
      // Skip other flags
      if (arg.startsWith('-')) continue

      argCount++

      // 使用了 -e flag：所有非 flag 参数均为文件参数
      // If we used -e flags, ALL non-flag arguments are file arguments
      if (hasEFlag) {
        return true
      }

      // 无 -e flag：第一个非 flag 参数是 sed 表达式，第二个起才是文件参数
      // If we didn't use -e flags, the first non-flag argument is the sed expression,
      // so we need more than 1 non-flag argument to have file arguments
      if (argCount > 1) {
        return true
      }
    }

    return false
  } catch (_error) {
    return true // Assume dangerous if parsing fails
  }
}

/**
 * extractSedExpressions
 *
 * 【函数作用】
 * 从 sed 命令中提取所有 sed 表达式字符串，供后续 containsDangerousOperations 检查使用。
 *
 * 【提取规则】
 *   - 检测并拒绝危险 flag 组合（如 -ew、-eW、-ee、-we）；
 *   - 支持 -e expr、--expression=expr、-e=expr 三种表达式指定方式；
 *   - 若无 -e flag，则第一个非 flag 参数为 sed 表达式；
 *   - 表达式之后的非 flag 参数视为文件名，停止提取。
 *
 * Extract sed expressions from command, ignoring flags and filenames
 * @param command Full sed command
 * @returns Array of sed expressions to check for dangerous operations
 * @throws Error if parsing fails
 * @internal Exported for testing
 */
export function extractSedExpressions(command: string): string[] {
  const expressions: string[] = []

  // 截取 sed 关键字后的部分
  // Calculate withoutSed by trimming off the first N characters (removing 'sed ')
  const sedMatch = command.match(/^\s*sed\s+/)
  if (!sedMatch) return expressions

  const withoutSed = command.slice(sedMatch[0].length)

  // 预检危险 flag 组合（-ew、-eW 等）：这些组合可能将危险命令混入 -e 标志解析路径
  // Reject dangerous flag combinations like -ew, -eW, -ee, -we (combined -e/-w with dangerous commands)
  if (/-e[wWe]/.test(withoutSed) || /-w[eE]/.test(withoutSed)) {
    throw new Error('Dangerous flag combination detected')
  }

  // 使用 shell tokenizer 解析参数
  // Use shell-quote to parse the arguments properly
  const parseResult = tryParseShellCommand(withoutSed)
  if (!parseResult.success) {
    // Malformed shell syntax - throw error to be caught by caller
    throw new Error(`Malformed shell syntax: ${parseResult.error}`)
  }
  const parsed = parseResult.tokens
  try {
    let foundEFlag = false
    let foundExpression = false

    for (let i = 0; i < parsed.length; i++) {
      const arg = parsed[i]

      // 跳过非字符串 token（控制操作符等）
      // Skip non-string arguments (like control operators)
      if (typeof arg !== 'string') continue

      // 处理 -e / --expression 形式的表达式
      // Handle -e flag followed by expression
      if ((arg === '-e' || arg === '--expression') && i + 1 < parsed.length) {
        foundEFlag = true
        const nextArg = parsed[i + 1]
        if (typeof nextArg === 'string') {
          expressions.push(nextArg)
          i++ // Skip the next argument since we consumed it
        }
        continue
      }

      // 处理 --expression=value 形式
      // Handle --expression=value format
      if (arg.startsWith('--expression=')) {
        foundEFlag = true
        expressions.push(arg.slice('--expression='.length))
        continue
      }

      // 处理 -e=value 形式（非标准，深度防御）
      // Handle -e=value format (non-standard but defense in depth)
      if (arg.startsWith('-e=')) {
        foundEFlag = true
        expressions.push(arg.slice('-e='.length))
        continue
      }

      // 跳过其他 flag
      // Skip other flags
      if (arg.startsWith('-')) continue

      // 无 -e flag 时，第一个非 flag 参数为 sed 表达式
      // If we haven't found any -e flags, the first non-flag argument is the sed expression
      if (!foundEFlag && !foundExpression) {
        expressions.push(arg)
        foundExpression = true
        continue
      }

      // 已找到 -e flag 或独立表达式后，剩余非 flag 参数为文件名，停止提取
      // If we've already found -e flags or a standalone expression,
      // remaining non-flag arguments are filenames
      break
    }
  } catch (error) {
    // 解析失败时抛出错误，由调用方处理
    // If shell-quote parsing fails, treat the sed command as unsafe
    throw new Error(
      `Failed to parse sed command: ${error instanceof Error ? error.message : 'Unknown error'}`,
    )
  }

  return expressions
}

/**
 * containsDangerousOperations
 *
 * 【函数作用】
 * 对单条 sed 表达式执行拒绝列表检查（深度防御层）。
 * 即使允许列表已命中，本函数仍会拒绝含以下危险模式的表达式：
 *   - 非 ASCII 字符（Unicode 同形字、组合字符）
 *   - 花括号（代码块，解析过于复杂）
 *   - 换行符（多行命令）
 *   - 注释 # （sed 脚本注释）
 *   - 取反操作符 !
 *   - GNU 步进地址格式 digit~digit
 *   - 各种危险写命令（w/W + 路径）
 *   - 执行命令（e/E + 任意内容）
 *   - 替换表达式 flags 中含 w/W/e/E
 *   - y 命令中含 w/W/e/E
 *
 * Check if a sed expression contains dangerous operations (denylist)
 * @param expression Single sed expression (without quotes)
 * @returns true if dangerous, false if safe
 */
function containsDangerousOperations(expression: string): boolean {
  const cmd = expression.trim()
  if (!cmd) return false

  // 保守拒绝策略：有疑问则视为不安全

  // 拒绝非 ASCII 字符（Unicode 同形字、组合字符等）
  // Reject non-ASCII characters (Unicode homoglyphs, combining chars, etc.)
  // Examples: ｗ (fullwidth), ᴡ (small capital), w̃ (combining tilde)
  // Check for characters outside ASCII range (0x01-0x7F, excluding null byte)
  // eslint-disable-next-line no-control-regex
  if (/[^\x01-\x7F]/.test(cmd)) {
    return true
  }

  // 拒绝花括号（代码块），解析复杂度过高
  // Reject curly braces (blocks) - too complex to parse
  if (cmd.includes('{') || cmd.includes('}')) {
    return true
  }

  // 拒绝换行符，多行命令过于复杂
  // Reject newlines - multi-line commands are too complex
  if (cmd.includes('\n')) {
    return true
  }

  // 拒绝注释 # （仅允许 s 命令中作为自定义分隔符紧跟在 s 之后）
  // Reject comments (# not immediately after s command)
  // Comments look like: #comment or start with #
  // Delimiter looks like: s#pattern#replacement#
  const hashIndex = cmd.indexOf('#')
  if (hashIndex !== -1 && !(hashIndex > 0 && cmd[hashIndex - 1] === 's')) {
    return true
  }

  // 拒绝取反操作符 !
  // Reject negation operator
  // Negation can appear: at start (!/pattern/), after address (/pattern/!, 1,10!, $!)
  // Delimiter looks like: s!pattern!replacement! (has 's' before it)
  if (/^!/.test(cmd) || /[/\d$]!/.test(cmd)) {
    return true
  }

  // 拒绝 GNU 步进地址格式（digit~digit、,~digit、$~digit）
  // Reject tilde in GNU step address format (digit~digit, ,~digit, or $~digit)
  // Allow whitespace around tilde
  if (/\d\s*~\s*\d|,\s*~\s*\d|\$\s*~\s*\d/.test(cmd)) {
    return true
  }

  // 拒绝以逗号开头（1,$ 地址范围的简写）
  // Reject comma at start (bare comma is shorthand for 1,$ address range)
  if (/^,/.test(cmd)) {
    return true
  }

  // 拒绝逗号后跟 +/- （GNU 偏移地址）
  // Reject comma followed by +/- (GNU offset addresses)
  if (/,\s*[+-]/.test(cmd)) {
    return true
  }

  // 拒绝反斜杠技巧（s\ 替换分隔符，或 \| \# \% \@ 等替换分隔符）
  // Reject backslash tricks:
  // 1. s\ (substitution with backslash delimiter)
  // 2. \X where X could be an alternate delimiter (|, #, %, etc.) - not regex escapes
  if (/s\\/.test(cmd) || /\\[|#%@]/.test(cmd)) {
    return true
  }

  // 拒绝转义斜杠后跟 w/W（如 /\/path\/to\/file/w）
  // Reject escaped slashes followed by w/W (patterns like /\/path\/to\/file/w)
  if (/\\\/.*[wW]/.test(cmd)) {
    return true
  }

  // 拒绝斜杠后跟非斜杠内容、空白、再跟危险命令（如 /pattern w file）
  // Reject malformed/suspicious patterns we don't understand
  // If there's a slash followed by non-slash chars, then whitespace, then dangerous commands
  // Examples: /pattern w file, /pattern e cmd, /foo X;w file
  if (/\/[^/]*\s+[wWeE]/.test(cmd)) {
    return true
  }

  // 拒绝格式异常的替换命令（缺少分隔符或多余分隔符）
  // Reject malformed substitution commands that don't follow normal pattern
  // Examples: s/foobareoutput.txt (missing delimiters), s/foo/bar//w (extra delimiter)
  if (/^s\//.test(cmd) && !/^s\/[^/]*\/[^/]*\/[^/]*$/.test(cmd)) {
    return true
  }

  // 偏执防御：任何以 s 开头、以危险字符（w/W/e/E）结尾且非正规替换格式的命令一律拒绝
  // PARANOID: Reject any command starting with 's' that ends with dangerous chars (w, W, e, E)
  // and doesn't match our known safe substitution pattern. This catches malformed s commands
  // with non-slash delimiters that might be trying to use dangerous flags.
  if (/^s./.test(cmd) && /[wWeE]$/.test(cmd)) {
    // Check if it's a properly formed substitution (any delimiter, not just /)
    const properSubst = /^s([^\\\n]).*?\1.*?\1[^wWeE]*$/.test(cmd)
    if (!properSubst) {
      return true
    }
  }

  // 检测危险写命令 w/W（各种地址前缀形式）
  // Check for dangerous write commands
  // Patterns: [address]w filename, [address]W filename, /pattern/w filename, /pattern/W filename
  // Simplified to avoid exponential backtracking (CodeQL issue)
  // Check for w/W in contexts where it would be a command (with optional whitespace)
  if (
    /^[wW]\s*\S+/.test(cmd) || // At start: w file
    /^\d+\s*[wW]\s*\S+/.test(cmd) || // After line number: 1w file or 1 w file
    /^\$\s*[wW]\s*\S+/.test(cmd) || // After $: $w file or $ w file
    /^\/[^/]*\/[IMim]*\s*[wW]\s*\S+/.test(cmd) || // After pattern: /pattern/w file
    /^\d+,\d+\s*[wW]\s*\S+/.test(cmd) || // After range: 1,10w file
    /^\d+,\$\s*[wW]\s*\S+/.test(cmd) || // After range: 1,$w file
    /^\/[^/]*\/[IMim]*,\/[^/]*\/[IMim]*\s*[wW]\s*\S+/.test(cmd) // After pattern range: /s/,/e/w file
  ) {
    return true
  }

  // 检测危险执行命令 e（各种地址前缀形式）
  // Check for dangerous execute commands
  // Patterns: [address]e [command], /pattern/e [command], or commands starting with e
  // Simplified to avoid exponential backtracking (CodeQL issue)
  // Check for e in contexts where it would be a command (with optional whitespace)
  if (
    /^e/.test(cmd) || // At start: e cmd
    /^\d+\s*e/.test(cmd) || // After line number: 1e or 1 e
    /^\$\s*e/.test(cmd) || // After $: $e or $ e
    /^\/[^/]*\/[IMim]*\s*e/.test(cmd) || // After pattern: /pattern/e
    /^\d+,\d+\s*e/.test(cmd) || // After range: 1,10e
    /^\d+,\$\s*e/.test(cmd) || // After range: 1,$e
    /^\/[^/]*\/[IMim]*,\/[^/]*\/[IMim]*\s*e/.test(cmd) // After pattern range: /s/,/e/e
  ) {
    return true
  }

  // 检测替换命令 flags 中含危险标志（w/W 写文件，e/E 执行命令）
  // Check for substitution commands with dangerous flags
  // Pattern: s<delim>pattern<delim>replacement<delim>flags where flags contain w or e
  // Per POSIX, sed allows any character except backslash and newline as delimiter
  const substitutionMatch = cmd.match(/s([^\\\n]).*?\1.*?\1(.*?)$/)
  if (substitutionMatch) {
    const flags = substitutionMatch[2] || ''

    // 写 flag：s/old/new/w filename 或 s/old/new/gw filename
    // Check for write flag: s/old/new/w filename or s/old/new/gw filename
    if (flags.includes('w') || flags.includes('W')) {
      return true
    }

    // 执行 flag：s/old/new/e 或 s/old/new/ge
    // Check for execute flag: s/old/new/e or s/old/new/ge
    if (flags.includes('e') || flags.includes('E')) {
      return true
    }
  }

  // 检测 y 命令中含危险字符（偏执：y 命令罕见，含 w/e 则可疑）
  // Check for y (transliterate) command followed by dangerous operations
  // Pattern: y<delim>source<delim>dest<delim> followed by anything
  // The y command uses same delimiter syntax as s command
  // PARANOID: Reject any y command that has w/W/e/E anywhere after the delimiters
  const yCommandMatch = cmd.match(/y([^\\\n])/)
  if (yCommandMatch) {
    // If we see a y command, check if there's any w, W, e, or E in the entire command
    // This is paranoid but safe - y commands are rare and w/e after y is suspicious
    if (/[wWeE]/.test(cmd)) {
      return true
    }
  }

  return false
}

/**
 * checkSedConstraints
 *
 * 【函数作用】
 * 对外导出的 sed 约束入口，供 BashTool 权限流程调用。
 * 遍历复合命令中的所有 sed 子命令：
 *   - acceptEdits 模式：允许 -i 文件写入，但仍拒绝危险操作（w/W/e/E）；
 *   - 其他模式（只读）：不允许任何文件写入。
 * 发现危险 sed 命令则返回 behavior: 'ask' 请求用户确认；
 * 全部安全或无 sed 命令则返回 behavior: 'passthrough'。
 *
 * Cross-cutting validation step for sed commands.
 *
 * This is a constraint check that blocks dangerous sed operations regardless of mode.
 * It returns 'passthrough' for non-sed commands or safe sed commands,
 * and 'ask' for dangerous sed operations (w/W/e/E commands).
 *
 * @param input - Object containing the command string
 * @param toolPermissionContext - Context containing mode and permissions
 * @returns
 * - 'ask' if any sed command contains dangerous operations
 * - 'passthrough' if no sed commands or all are safe
 */
export function checkSedConstraints(
  input: { command: string },
  toolPermissionContext: ToolPermissionContext,
): PermissionResult {
  const commands = splitCommand_DEPRECATED(input.command)

  for (const cmd of commands) {
    // 跳过非 sed 命令
    // Skip non-sed commands
    const trimmed = cmd.trim()
    const baseCmd = trimmed.split(/\s+/)[0]
    if (baseCmd !== 'sed') {
      continue
    }

    // acceptEdits 模式下允许 -i（文件原地修改），仍拒绝危险操作
    // In acceptEdits mode, allow file writes (-i flag) but still block dangerous operations
    const allowFileWrites = toolPermissionContext.mode === 'acceptEdits'

    const isAllowed = sedCommandIsAllowedByAllowlist(trimmed, {
      allowFileWrites,
    })

    if (!isAllowed) {
      return {
        behavior: 'ask',
        message:
          'sed command requires approval (contains potentially dangerous operations)',
        decisionReason: {
          type: 'other',
          reason:
            'sed command contains operations that require explicit approval (e.g., write commands, execute commands)',
        },
      }
    }
  }

  // 无危险 sed 命令（或无 sed 命令），放行
  // No dangerous sed commands found (or no sed commands at all)
  return {
    behavior: 'passthrough',
    message: 'No dangerous sed operations detected',
  }
}
