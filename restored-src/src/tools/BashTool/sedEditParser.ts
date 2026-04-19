/**
 * BashTool/sedEditParser.ts
 *
 * 【在 Claude Code 系统中的位置】
 * 本文件属于 BashTool 工具模块，负责解析并执行 `sed -i 's/pattern/replacement/flags' file`
 * 形式的原地编辑命令。其解析结果供 BashTool 渲染层使用，以文件编辑视图展示 sed 的修改内容。
 *
 * 【主要功能】
 * - BRE→ERE 转换占位符（null 字节哨兵）：安全地将 sed BRE 正则转换为 JavaScript ERE，
 *   利用空字节占位符避免多步替换中的误匹配。
 * - SedEditInfo：解析后的 sed 编辑信息类型（文件路径、pattern、replacement、flags、是否 ERE）。
 * - isSedInPlaceEdit：判断命令是否为简单的 sed 原地编辑命令。
 * - parseSedEditCommand：完整解析 `sed -i 's/.../.../' file` 命令，提取各字段。
 * - applySedSubstitution：将 SedEditInfo 应用到文件内容字符串，返回替换后的新内容。
 *
 * Parser for sed edit commands (-i flag substitutions)
 * Extracts file paths and substitution patterns to enable file-edit-style rendering
 */

import { randomBytes } from 'crypto'
import { tryParseShellCommand } from '../../utils/bash/shellQuote.js'

// BRE→ERE 转换占位符（空字节哨兵，永远不会出现在用户输入中）
// 用于多步正则替换中作为中间占位，防止已替换内容被后续步骤误匹配
// BRE→ERE conversion placeholders (null-byte sentinels, never appear in user input)
const BACKSLASH_PLACEHOLDER = '\x00BACKSLASH\x00'
const PLUS_PLACEHOLDER = '\x00PLUS\x00'
const QUESTION_PLACEHOLDER = '\x00QUESTION\x00'
const PIPE_PLACEHOLDER = '\x00PIPE\x00'
const LPAREN_PLACEHOLDER = '\x00LPAREN\x00'
const RPAREN_PLACEHOLDER = '\x00RPAREN\x00'
// 各占位符对应的全局替换正则（预编译，避免重复构建）
const BACKSLASH_PLACEHOLDER_RE = new RegExp(BACKSLASH_PLACEHOLDER, 'g')
const PLUS_PLACEHOLDER_RE = new RegExp(PLUS_PLACEHOLDER, 'g')
const QUESTION_PLACEHOLDER_RE = new RegExp(QUESTION_PLACEHOLDER, 'g')
const PIPE_PLACEHOLDER_RE = new RegExp(PIPE_PLACEHOLDER, 'g')
const LPAREN_PLACEHOLDER_RE = new RegExp(LPAREN_PLACEHOLDER, 'g')
const RPAREN_PLACEHOLDER_RE = new RegExp(RPAREN_PLACEHOLDER, 'g')

/**
 * SedEditInfo
 *
 * 【说明】
 * parseSedEditCommand 解析成功后返回的结构化 sed 编辑信息类型。
 * 包含渲染文件编辑视图和应用替换所需的所有字段。
 */
export type SedEditInfo = {
  /** The file path being edited */
  filePath: string
  /** The search pattern (regex) */
  pattern: string
  /** The replacement string */
  replacement: string
  /** Substitution flags (g, i, etc.) */
  flags: string
  /** Whether to use extended regex (-E or -r flag) */
  extendedRegex: boolean
}

/**
 * isSedInPlaceEdit
 *
 * 【函数作用】
 * 判断给定命令字符串是否为简单的 sed 原地编辑命令。
 * 内部委托 parseSedEditCommand 完成解析，返回是否解析成功（非 null）。
 * 供 BashTool 渲染层用于判断是否以文件编辑视图展示命令结果。
 *
 * Check if a command is a sed in-place edit command
 * Returns true only for simple sed -i 's/pattern/replacement/flags' file commands
 */
export function isSedInPlaceEdit(command: string): boolean {
  const info = parseSedEditCommand(command)
  return info !== null
}

/**
 * parseSedEditCommand
 *
 * 【函数作用】
 * 解析 `sed -i 's/pattern/replacement/flags' file` 形式的命令字符串，
 * 提取文件路径、substitution expression、flags 及是否使用扩展正则等信息。
 *
 * 【解析流程】
 *   1. 确认命令以 `sed` 开头，截取 sed 后的部分；
 *   2. 使用 tryParseShellCommand 进行 shell tokenization，提取字符串 token；
 *      遇到 glob 等复杂 token 直接返回 null（不支持）；
 *   3. 迭代 token 列表：
 *      - `-i` / `--in-place`：标记 hasInPlaceFlag；macOS 场景下跳过紧随的备份后缀；
 *      - `-E` / `-r`：标记 extendedRegex；
 *      - `-e` / `--expression=`：提取 expression（仅支持单个表达式）；
 *      - 其他未知 flag：返回 null（安全拒绝）；
 *      - 非 flag 参数：依次赋给 expression 和 filePath；多文件时返回 null；
 *   4. 检查必需字段（hasInPlaceFlag、expression、filePath）；
 *   5. 解析 substitution expression `s/pattern/replacement/flags`，
 *      逐字符跟踪转义，分离三个部分；
 *   6. 校验 flags 仅包含安全字符集 `[gpimIM1-9]`；
 *   7. 返回 SedEditInfo 结构，解析失败任何步骤均返回 null。
 *
 * Parse a sed edit command and extract the edit information
 * Returns null if the command is not a valid sed in-place edit
 */
export function parseSedEditCommand(command: string): SedEditInfo | null {
  const trimmed = command.trim()

  // 命令必须以 sed 开头
  // Must start with sed
  const sedMatch = trimmed.match(/^\s*sed\s+/)
  if (!sedMatch) return null

  // 截取 sed 关键字后的部分，交给 shell tokenizer
  const withoutSed = trimmed.slice(sedMatch[0].length)
  const parseResult = tryParseShellCommand(withoutSed)
  if (!parseResult.success) return null
  const tokens = parseResult.tokens

  // 仅提取字符串类型的 token；glob token 过于复杂，直接拒绝
  // Extract string tokens only
  const args: string[] = []
  for (const token of tokens) {
    if (typeof token === 'string') {
      args.push(token)
    } else if (
      typeof token === 'object' &&
      token !== null &&
      'op' in token &&
      token.op === 'glob'
    ) {
      // Glob patterns are too complex for this simple parser
      return null
    }
  }

  // 解析 flag 和参数，构建解析状态
  // Parse flags and arguments
  let hasInPlaceFlag = false
  let extendedRegex = false
  let expression: string | null = null
  let filePath: string | null = null

  let i = 0
  while (i < args.length) {
    const arg = args[i]!

    // 处理 -i flag（可带或不带备份后缀）
    // Handle -i flag (with or without backup suffix)
    if (arg === '-i' || arg === '--in-place') {
      hasInPlaceFlag = true
      i++
      // On macOS, -i requires a suffix argument (even if empty string)
      // Check if next arg looks like a backup suffix (empty, or starts with dot)
      // Don't consume flags (-E, -r) or sed expressions (starting with s, y, d)
      if (i < args.length) {
        const nextArg = args[i]
        // macOS 的 -i 需要紧随一个备份后缀参数（空字符串或以 . 开头）
        // If next arg is empty string or starts with dot, it's a backup suffix
        if (
          typeof nextArg === 'string' &&
          !nextArg.startsWith('-') &&
          (nextArg === '' || nextArg.startsWith('.'))
        ) {
          i++ // Skip the backup suffix
        }
      }
      continue
    }
    if (arg.startsWith('-i')) {
      // 内联备份后缀形式，如 -i.bak
      // -i.bak or similar (inline suffix)
      hasInPlaceFlag = true
      i++
      continue
    }

    // 处理扩展正则标志（-E、-r、--regexp-extended）
    // Handle extended regex flags
    if (arg === '-E' || arg === '-r' || arg === '--regexp-extended') {
      extendedRegex = true
      i++
      continue
    }

    // 处理 -e / --expression= 形式的表达式参数（仅支持单条）
    // Handle -e flag with expression
    if (arg === '-e' || arg === '--expression') {
      if (i + 1 < args.length && typeof args[i + 1] === 'string') {
        // Only support single expression
        if (expression !== null) return null
        expression = args[i + 1]!
        i += 2
        continue
      }
      return null
    }
    if (arg.startsWith('--expression=')) {
      if (expression !== null) return null
      expression = arg.slice('--expression='.length)
      i++
      continue
    }

    // 遇到未知 flag，无法安全解析，直接返回 null
    // Skip other flags we don't understand
    if (arg.startsWith('-')) {
      // Unknown flag - not safe to parse
      return null
    }

    // 非 flag 参数：依次赋给 expression 和 filePath
    // Non-flag argument
    if (expression === null) {
      // First non-flag arg is the expression
      expression = arg
    } else if (filePath === null) {
      // Second non-flag arg is the file path
      filePath = arg
    } else {
      // 多于一个文件，不支持简单渲染
      // More than one file - not supported for simple rendering
      return null
    }

    i++
  }

  // 必须同时具备 -i flag、expression 和文件路径
  // Must have -i flag, expression, and file path
  if (!hasInPlaceFlag || !expression || !filePath) {
    return null
  }

  // 解析 substitution expression：s/pattern/replacement/flags
  // 简化实现：仅支持 / 作为分隔符
  // Parse the substitution expression: s/pattern/replacement/flags
  // Only support / as delimiter for simplicity
  const substMatch = expression.match(/^s\//)
  if (!substMatch) {
    return null
  }

  const rest = expression.slice(2) // 跳过 's/' // Skip 's/'

  // 逐字符跟踪转义，分离 pattern、replacement、flags 三个部分
  // Find pattern and replacement by tracking escaped characters
  let pattern = ''
  let replacement = ''
  let flags = ''
  let state: 'pattern' | 'replacement' | 'flags' = 'pattern'
  let j = 0

  while (j < rest.length) {
    const char = rest[j]!

    if (char === '\\' && j + 1 < rest.length) {
      // 转义字符：将 \ 和下一个字符一起追加到当前段
      // Escaped character
      if (state === 'pattern') {
        pattern += char + rest[j + 1]
      } else if (state === 'replacement') {
        replacement += char + rest[j + 1]
      } else {
        flags += char + rest[j + 1]
      }
      j += 2
      continue
    }

    if (char === '/') {
      // 分隔符：切换解析状态
      if (state === 'pattern') {
        state = 'replacement'
      } else if (state === 'replacement') {
        state = 'flags'
      } else {
        // flags 段出现额外分隔符，格式异常
        // Extra delimiter in flags - unexpected
        return null
      }
      j++
      continue
    }

    if (state === 'pattern') {
      pattern += char
    } else if (state === 'replacement') {
      replacement += char
    } else {
      flags += char
    }
    j++
  }

  // 必须已到达 flags 状态（即找到了三个分隔符段）
  // Must have found all three parts (pattern, replacement delimiter, and optional flags)
  if (state !== 'flags') {
    return null
  }

  // 校验 flags 仅包含安全字符集
  // Validate flags - only allow safe substitution flags
  const validFlags = /^[gpimIM1-9]*$/
  if (!validFlags.test(flags)) {
    return null
  }

  return {
    filePath,
    pattern,
    replacement,
    flags,
    extendedRegex,
  }
}

/**
 * applySedSubstitution
 *
 * 【函数作用】
 * 将解析后的 SedEditInfo 应用到文件内容字符串，返回替换后的新内容。
 * 内部完成以下转换：
 *   1. 将 SedEditInfo.flags 映射为 JavaScript RegExp flags（g/i/m）；
 *   2. 若非扩展正则（BRE 模式），执行 BRE→ERE 转换：
 *      - Step 1：用空字节占位符保护 \\（字面反斜杠）；
 *      - Step 2：将 BRE 元字符转义（\+、\?、\|、\(、\)）替换为占位符；
 *      - Step 3：将未转义的 BRE 字面元字符（+、?、|、(、)）加上 JS 转义；
 *      - Step 4：将占位符还原为 JS 正则元字符（不带转义）。
 *   3. 转换 replacement 字符串：\/ → /；\& → 占位符；& → $&（JS 全匹配语法）；占位符还原为 &；
 *      使用随机 salt 的占位符防止注入攻击。
 *   4. 构建 RegExp 并执行 content.replace；正则无效时返回原始内容（静默失败）。
 *
 * Apply a sed substitution to file content
 * Returns the new content after applying the substitution
 */
export function applySedSubstitution(
  content: string,
  sedInfo: SedEditInfo,
): string {
  // 构建 JavaScript RegExp flags 字符串
  // Convert sed pattern to JavaScript regex
  let regexFlags = ''

  // 处理全局替换 flag
  // Handle global flag
  if (sedInfo.flags.includes('g')) {
    regexFlags += 'g'
  }

  // 处理大小写不敏感 flag（sed 中为 i 或 I）
  // Handle case-insensitive flag (i or I in sed)
  if (sedInfo.flags.includes('i') || sedInfo.flags.includes('I')) {
    regexFlags += 'i'
  }

  // 处理多行 flag（sed 中为 m 或 M）
  // Handle multiline flag (m or M in sed)
  if (sedInfo.flags.includes('m') || sedInfo.flags.includes('M')) {
    regexFlags += 'm'
  }

  // 将 sed pattern 转换为 JavaScript 正则 pattern
  // Convert sed pattern to JavaScript regex pattern
  let jsPattern = sedInfo.pattern
    // 先将 \/ 反转义为 /
    // Unescape \/ to /
    .replace(/\\\//g, '/')

  // BRE 模式下，元字符转义语义与 ERE/JS 相反：
  // BRE: \+ 表示"一个或多个"，+ 是字面量
  // ERE/JS: + 表示"一个或多个"，\+ 是字面量
  // In BRE mode (no -E flag), metacharacters have opposite escaping:
  // BRE: \+ means "one or more", + is literal
  // ERE/JS: + means "one or more", \+ is literal
  // We need to convert BRE escaping to ERE for JavaScript regex
  if (!sedInfo.extendedRegex) {
    jsPattern = jsPattern
      // Step 1：用占位符保护字面反斜杠 \\（BRE 和 ERE 中均为字面反斜杠）
      // Step 1: Protect literal backslashes (\\) first - in both BRE and ERE, \\ is literal backslash
      .replace(/\\\\/g, BACKSLASH_PLACEHOLDER)
      // Step 2：将 BRE 转义元字符替换为占位符（这些在 JS 中应变为非转义）
      // Step 2: Replace escaped metacharacters with placeholders (these should become unescaped in JS)
      .replace(/\\\+/g, PLUS_PLACEHOLDER)
      .replace(/\\\?/g, QUESTION_PLACEHOLDER)
      .replace(/\\\|/g, PIPE_PLACEHOLDER)
      .replace(/\\\(/g, LPAREN_PLACEHOLDER)
      .replace(/\\\)/g, RPAREN_PLACEHOLDER)
      // Step 3：将 BRE 中的字面元字符加上 JS 转义（BRE 中未转义的这些字符是字面量）
      // Step 3: Escape unescaped metacharacters (these are literal in BRE)
      .replace(/\+/g, '\\+')
      .replace(/\?/g, '\\?')
      .replace(/\|/g, '\\|')
      .replace(/\(/g, '\\(')
      .replace(/\)/g, '\\)')
      // Step 4：将占位符还原为 JS 正则等价形式
      // Step 4: Replace placeholders with their JS equivalents
      .replace(BACKSLASH_PLACEHOLDER_RE, '\\\\')
      .replace(PLUS_PLACEHOLDER_RE, '+')
      .replace(QUESTION_PLACEHOLDER_RE, '?')
      .replace(PIPE_PLACEHOLDER_RE, '|')
      .replace(LPAREN_PLACEHOLDER_RE, '(')
      .replace(RPAREN_PLACEHOLDER_RE, ')')
  }

  // 转换 replacement 字符串中的 sed 特定转义序列
  // 使用含随机 salt 的占位符，防止 \& 与 & 的替换链中出现注入攻击
  // Unescape sed-specific escapes in replacement
  // Convert \n to newline, & to $& (match), etc.
  // Use a unique placeholder with random salt to prevent injection attacks
  const salt = randomBytes(8).toString('hex')
  const ESCAPED_AMP_PLACEHOLDER = `___ESCAPED_AMPERSAND_${salt}___`
  const jsReplacement = sedInfo.replacement
    // \/ → /
    // Unescape \/ to /
    .replace(/\\\//g, '/')
    // 先将 \& 替换为占位符（防止后续 & → $& 步骤将其误匹配）
    // First escape \& to a placeholder
    .replace(/\\&/g, ESCAPED_AMP_PLACEHOLDER)
    // & → $&（JS replacement 中的全匹配引用语法）
    // Convert & to $& (full match) - use $$& to get literal $& in output
    .replace(/&/g, '$$&')
    // 将占位符还原为字面量 &
    // Convert placeholder back to literal &
    .replace(new RegExp(ESCAPED_AMP_PLACEHOLDER, 'g'), '&')

  try {
    // 构建最终正则并执行替换
    const regex = new RegExp(jsPattern, regexFlags)
    return content.replace(regex, jsReplacement)
  } catch {
    // 正则无效时静默失败，返回原始内容
    // If regex is invalid, return original content
    return content
  }
}
