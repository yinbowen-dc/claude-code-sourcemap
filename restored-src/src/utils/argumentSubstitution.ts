/**
 * 参数占位符替换工具模块。
 *
 * 在 Claude Code 系统中，该模块为 skill/command 提示词中的 $ARGUMENTS
 * 占位符提供替换功能，支持以下占位符形式：
 * - $ARGUMENTS：替换为完整参数字符串
 * - $ARGUMENTS[0]、$ARGUMENTS[1] 等：替换为按索引取出的单个参数
 * - $0、$1 等：$ARGUMENTS[n] 的简写形式
 * - 命名参数（如 $foo、$bar）：通过 frontmatter 中的 arguments 字段定义
 *
 * 参数解析使用 shell-quote，支持带引号的参数正确处理。
 *
 * Utility for substituting $ARGUMENTS placeholders in skill/command prompts.
 */

import { tryParseShellCommand } from './bash/shellQuote.js'

/**
 * 将参数字符串解析为单个参数数组。
 * 使用 shell-quote 正确处理带引号的参数（单引号、双引号均支持）。
 *
 * Parse an arguments string into an array of individual arguments.
 */
export function parseArguments(args: string): string[] {
  if (!args || !args.trim()) {
    return []
  }

  // Return $KEY to preserve variable syntax literally (don't expand variables)
  const result = tryParseShellCommand(args, key => `$${key}`)
  if (!result.success) {
    // Fall back to simple whitespace split if parsing fails
    return args.split(/\s+/).filter(Boolean)
  }

  // Filter to only string tokens (ignore shell operators, etc.)
  return result.tokens.filter(
    (token): token is string => typeof token === 'string',
  )
}

/**
 * 从 frontmatter 的 arguments 字段解析参数名称列表。
 * 接受空格分隔的字符串或字符串数组，过滤空值和纯数字名称（与 $0/$1 简写冲突）。
 *
 * Parse argument names from the frontmatter 'arguments' field.
 */
export function parseArgumentNames(
  argumentNames: string | string[] | undefined,
): string[] {
  if (!argumentNames) {
    return []
  }

  // Filter out empty strings and numeric-only names (which conflict with $0, $1 shorthand)
  const isValidName = (name: string): boolean =>
    typeof name === 'string' && name.trim() !== '' && !/^\d+$/.test(name)

  if (Array.isArray(argumentNames)) {
    return argumentNames.filter(isValidName)
  }
  if (typeof argumentNames === 'string') {
    return argumentNames.split(/\s+/).filter(isValidName)
  }
  return []
}

/**
 * 生成渐进式参数提示，显示用户尚未填写的参数名称。
 * 例如已输入 1 个参数而 argNames 有 3 个时，返回 "[arg2] [arg3]"。
 */
export function generateProgressiveArgumentHint(
  argNames: string[],
  typedArgs: string[],
): string | undefined {
  const remaining = argNames.slice(typedArgs.length)
  if (remaining.length === 0) return undefined
  return remaining.map(name => `[${name}]`).join(' ')
}

/**
 * 将提示词内容中的 $ARGUMENTS 占位符替换为实际参数值。
 * 替换顺序：命名参数 → $ARGUMENTS[n] 索引 → $n 简写 → $ARGUMENTS 整体。
 * 若未找到任何占位符且 appendIfNoPlaceholder=true，则在末尾追加 "ARGUMENTS: {args}"。
 * args 为 undefined/null 时直接返回原内容。
 *
 * Substitute $ARGUMENTS placeholders in content with actual argument values.
 */
export function substituteArguments(
  content: string,
  args: string | undefined,
  appendIfNoPlaceholder = true,
  argumentNames: string[] = [],
): string {
  // undefined/null means no args provided - return content unchanged
  // empty string is a valid input that should replace placeholders with empty
  if (args === undefined || args === null) {
    return content
  }

  const parsedArgs = parseArguments(args)
  const originalContent = content

  // Replace named arguments (e.g., $foo, $bar) with their values
  // Named arguments map to positions: argumentNames[0] -> parsedArgs[0], etc.
  for (let i = 0; i < argumentNames.length; i++) {
    const name = argumentNames[i]
    if (!name) continue

    // Match $name but not $name[...] or $nameXxx (word chars)
    // Also ensure we match word boundaries to avoid partial matches
    content = content.replace(
      new RegExp(`\\$${name}(?![\\[\\w])`, 'g'),
      parsedArgs[i] ?? '',
    )
  }

  // Replace indexed arguments ($ARGUMENTS[0], $ARGUMENTS[1], etc.)
  content = content.replace(/\$ARGUMENTS\[(\d+)\]/g, (_, indexStr: string) => {
    const index = parseInt(indexStr, 10)
    return parsedArgs[index] ?? ''
  })

  // Replace shorthand indexed arguments ($0, $1, etc.)
  content = content.replace(/\$(\d+)(?!\w)/g, (_, indexStr: string) => {
    const index = parseInt(indexStr, 10)
    return parsedArgs[index] ?? ''
  })

  // Replace $ARGUMENTS with the full arguments string
  content = content.replaceAll('$ARGUMENTS', args)

  // If no placeholders were found and appendIfNoPlaceholder is true, append
  // But only if args is non-empty (empty string means command invoked with no args)
  if (content === originalContent && appendIfNoPlaceholder && args) {
    content = content + `\n\nARGUMENTS: ${args}`
  }

  return content
}
