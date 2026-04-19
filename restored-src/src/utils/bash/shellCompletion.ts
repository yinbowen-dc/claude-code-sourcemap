/**
 * Shell 命令补全模块。
 *
 * 在 Claude Code 系统中，该模块为提示输入框提供基于 shell 的 Tab 补全能力，
 * 支持 bash 和 zsh（通过 compgen / zsh 原生补全命令实现）：
 * - isCommandOperator()：判断解析 token 是否为命令操作符（|/||/&&/;）
 * - getCompletionTypeFromPrefix()：根据前缀特征判断补全类型（command/variable/file）
 * - findLastStringToken()：从 token 列表中找最后一个字符串 token
 * - isNewCommandContext()：判断当前 token 位置是否为新命令起始位置
 * - parseInputContext()：解析输入字符串与光标偏移，提取补全上下文
 * - getBashCompletionCommand()：生成 bash compgen 补全命令（含注入防御）
 * - getZshCompletionCommand()：生成 zsh 原生补全命令
 * - getCompletionsForShell()：调用 Shell.exec 执行补全命令并解析结果
 * - getShellCompletions()：对外入口，返回 SuggestionItem[] 列表
 *
 * 补全上限：15 项；超时：1000ms；未支持的 shell 类型直接返回空数组。
 */
import type { SuggestionItem } from 'src/components/PromptInput/PromptInputFooterSuggestions.js'
import {
  type ParseEntry,
  quote,
  tryParseShellCommand,
} from '../bash/shellQuote.js'
import { logForDebugging } from '../debug.js'
import { getShellType } from '../localInstaller.js'
import * as Shell from '../Shell.js'

// 补全结果条数上限，超过部分截断
const MAX_SHELL_COMPLETIONS = 15
// 补全命令执行超时时间（毫秒），防止卡顿
const SHELL_COMPLETION_TIMEOUT_MS = 1000
// 触发"新命令起始"判断的操作符列表
const COMMAND_OPERATORS = ['|', '||', '&&', ';'] as const

export type ShellCompletionType = 'command' | 'variable' | 'file'

type InputContext = {
  prefix: string
  completionType: ShellCompletionType
}

/**
 * 判断已解析的 token 是否为命令操作符（|、||、&&、;）。
 * 用于在 isNewCommandContext() 中检查当前 token 前一个 token 的类型，
 * 从而确定光标所在位置是否期待一个新的命令名称。
 * shell-quote 操作符以含 `op` 属性的对象形式表示，字符串 token 不是操作符。
 */
function isCommandOperator(token: ParseEntry): boolean {
  return (
    typeof token === 'object' &&
    token !== null &&
    'op' in token && // 排除字符串类型的 token（字符串无 op 属性）
    (COMMAND_OPERATORS as readonly string[]).includes(token.op as string) // 确认 op 值在已知操作符集合中
  )
}

/**
 * 仅根据前缀字符串的特征判断补全类型（command / variable / file）。
 * - 以 `$` 开头 → variable（环境变量）
 * - 包含 `/` 或以 `~`、`.` 开头 → file（路径）
 * - 其余情况 → command（命令名）
 * 该函数不考虑上下文位置，仅作字符串模式匹配。
 */
function getCompletionTypeFromPrefix(prefix: string): ShellCompletionType {
  if (prefix.startsWith('$')) {
    return 'variable' // $VAR 形式，触发环境变量补全
  }
  if (
    prefix.includes('/') || // 绝对或相对路径
    prefix.startsWith('~') || // 家目录展开
    prefix.startsWith('.') // 当前/上级目录
  ) {
    return 'file'
  }
  return 'command' // 不含路径特征，视为命令名
}

/**
 * 从已解析的 token 列表中找出最后一个字符串类型的 token 及其下标。
 * shell-quote 解析结果中既有字符串 token，也有操作符对象；
 * 该函数跳过所有非字符串 token，取最末尾的字符串作为"光标处的当前词"。
 * 若列表中不存在字符串 token，则返回 null。
 */
function findLastStringToken(
  tokens: ParseEntry[],
): { token: string; index: number } | null {
  const i = tokens.findLastIndex(t => typeof t === 'string') // 从末尾向前找最后一个字符串 token
  return i !== -1 ? { token: tokens[i] as string, index: i } : null
}

/**
 * 判断当前 token 位置是否处于"期待新命令名称"的上下文中。
 * 两种情况满足条件：
 * 1. 当前 token 是 token 列表中的第一个（整条输入的起始位置）。
 * 2. 当前 token 的前一个 token 是命令操作符（|/||/&&/;），
 *    意味着前一条命令已结束，接下来期待新命令。
 */
function isNewCommandContext(
  tokens: ParseEntry[],
  currentTokenIndex: number,
): boolean {
  if (currentTokenIndex === 0) {
    return true // 第一个 token 必然是命令名
  }
  const prevToken = tokens[currentTokenIndex - 1]
  return prevToken !== undefined && isCommandOperator(prevToken) // 操作符之后期待新命令
}

/**
 * 解析输入字符串与光标偏移，提取当前补全上下文（前缀 + 补全类型）。
 *
 * 处理流程：
 * 1. 截取光标前的文本 beforeCursor。
 * 2. 优先用正则检测 `$变量名` 模式，直接返回 variable 类型。
 * 3. 用 tryParseShellCommand() 解析；失败时降级为空格切分，
 *    取最后一词并推断类型（第一词 → command，其余 → getCompletionTypeFromPrefix）。
 * 4. 解析成功后，对最后一个字符串 token 判断类型；
 *    末尾有空格说明用户正在开始新参数，返回空前缀 + file 类型。
 */
function parseInputContext(input: string, cursorOffset: number): InputContext {
  const beforeCursor = input.slice(0, cursorOffset) // 仅分析光标左侧的文本

  // 在 shell-quote 展开之前先检测 $变量 前缀，避免 shell-quote 展开变量名
  const varMatch = beforeCursor.match(/\$[a-zA-Z_][a-zA-Z0-9_]*$/)
  if (varMatch) {
    return { prefix: varMatch[0], completionType: 'variable' }
  }

  // 用 shell-quote 安全解析命令
  const parseResult = tryParseShellCommand(beforeCursor)
  if (!parseResult.success) {
    // shell-quote 解析失败，降级为简单空格切分
    const tokens = beforeCursor.split(/\s+/)
    const prefix = tokens[tokens.length - 1] || ''
    const isFirstToken = tokens.length === 1 && !beforeCursor.includes(' ')
    const completionType = isFirstToken
      ? 'command' // 只有一个词且无空格，肯定是命令名
      : getCompletionTypeFromPrefix(prefix)
    return { prefix, completionType }
  }

  // 提取最后一个字符串 token 作为当前补全前缀
  const lastToken = findLastStringToken(parseResult.tokens)
  if (!lastToken) {
    // token 列表中无字符串（如输入仅含操作符），默认返回命令类型
    const lastParsedToken = parseResult.tokens[parseResult.tokens.length - 1]
    const completionType =
      lastParsedToken && isCommandOperator(lastParsedToken)
        ? 'command'
        : 'command' // 默认为命令名类型
    return { prefix: '', completionType }
  }

  // 末尾有空格说明用户刚完成一个参数，正在开始下一个（文件路径）
  if (beforeCursor.endsWith(' ')) {
    // 第一个 token（命令名）后有空格 = 期待文件参数
    return { prefix: '', completionType: 'file' }
  }

  // 根据前缀特征初步判断类型
  const baseType = getCompletionTypeFromPrefix(lastToken.token)

  // 明确为 variable 或 file 前缀时直接返回，无需进一步上下文判断
  if (baseType === 'variable' || baseType === 'file') {
    return { prefix: lastToken.token, completionType: baseType }
  }

  // command-like 前缀：结合位置上下文区分"命令名"和"文件路径参数"
  const completionType = isNewCommandContext(
    parseResult.tokens,
    lastToken.index,
  )
    ? 'command'
    : 'file' // 操作符之后 = 文件参数

  return { prefix: lastToken.token, completionType }
}

/**
 * 根据前缀和补全类型，生成 bash compgen 补全命令字符串。
 * - variable：`compgen -v <varName>`（去掉 `$` 前缀后引号化）
 * - file：`compgen -f <prefix>` + `while IFS= read -r` 管道，
 *   为目录追加 `/`、为文件追加空格，防止含换行符文件名引发命令注入
 * - command：`compgen -c <prefix>`
 * 所有前缀均通过 quote() 引号化以防注入。
 */
function getBashCompletionCommand(
  prefix: string,
  completionType: ShellCompletionType,
): string {
  if (completionType === 'variable') {
    // 变量补全：去掉 $ 前缀后引号化
    const varName = prefix.slice(1) // 去掉 $ 前缀再引号化
    return `compgen -v ${quote([varName])} 2>/dev/null`
  } else if (completionType === 'file') {
    // 文件补全：为目录追加 /，为文件追加空格
    // 使用 'while read' 防止含换行符的文件名引发命令注入
    return `compgen -f ${quote([prefix])} 2>/dev/null | head -${MAX_SHELL_COMPLETIONS} | while IFS= read -r f; do [ -d "$f" ] && echo "$f/" || echo "$f "; done`
  } else {
    // 命令名补全
    return `compgen -c ${quote([prefix])} 2>/dev/null`
  }
}

/**
 * 根据前缀和补全类型，生成 zsh 原生补全命令字符串。
 * - variable：利用 zsh `${(k)parameters[(I)...]}` 参数展开过滤匹配变量名
 * - file：使用 zsh glob 展开 `prefix*(N[1,N])`，天然防命令注入
 * - command：利用 zsh `${(k)commands[(I)...]}` 内置命令哈希表过滤命令名
 * 所有前缀均通过 quote() 引号化以防注入。
 */
function getZshCompletionCommand(
  prefix: string,
  completionType: ShellCompletionType,
): string {
  if (completionType === 'variable') {
    // 变量补全：使用 zsh 参数展开安全过滤
    const varName = prefix.slice(1) // 去掉 $ 前缀
    return `print -rl -- \${(k)parameters[(I)${quote([varName])}*]} 2>/dev/null`
  } else if (completionType === 'file') {
    // 文件补全：为目录追加 /，为文件追加空格
    // 注：zsh glob 展开天然防命令注入（不同于 bash for-in 循环）
    return `for f in ${quote([prefix])}*(N[1,${MAX_SHELL_COMPLETIONS}]); do [[ -d "$f" ]] && echo "$f/" || echo "$f "; done`
  } else {
    // 命令名补全：使用 zsh 参数展开安全过滤
    return `print -rl -- \${(k)commands[(I)${quote([prefix])}*]} 2>/dev/null`
  }
}

/**
 * 调用 Shell.exec 执行补全命令并将 stdout 解析为 SuggestionItem 数组。
 * 根据 shellType 选择 bash/zsh 补全命令生成函数；
 * 不支持的 shell 类型直接返回空数组。
 * 执行超时为 SHELL_COMPLETION_TIMEOUT_MS；结果按换行分割并过滤空行，
 * 最多返回 MAX_SHELL_COMPLETIONS 条。
 */
async function getCompletionsForShell(
  shellType: 'bash' | 'zsh',
  prefix: string,
  completionType: ShellCompletionType,
  abortSignal: AbortSignal,
): Promise<SuggestionItem[]> {
  let command: string

  if (shellType === 'bash') {
    command = getBashCompletionCommand(prefix, completionType)
  } else if (shellType === 'zsh') {
    command = getZshCompletionCommand(prefix, completionType)
  } else {
    // 不支持的 shell 类型
    return []
  }

  const shellCommand = await Shell.exec(command, abortSignal, 'bash', {
    timeout: SHELL_COMPLETION_TIMEOUT_MS,
  })
  const result = await shellCommand.result
  return result.stdout
    .split('\n')
    .filter((line: string) => line.trim()) // 过滤空行
    .slice(0, MAX_SHELL_COMPLETIONS) // 截断超出上限的结果
    .map((text: string) => ({
      id: text,
      displayText: text,
      description: undefined,
      metadata: { completionType }, // 携带补全类型供 UI 层判断显示样式
    }))
}

/**
 * 对外暴露的 shell 补全入口函数，返回 SuggestionItem[] 补全列表。
 *
 * 执行流程：
 * 1. 获取当前 shell 类型；仅支持 bash/zsh，其他直接返回空数组。
 * 2. 调用 parseInputContext() 提取前缀和补全类型。
 * 3. 若前缀为空，跳过补全直接返回空数组（避免无意义的全量补全）。
 * 4. 调用 getCompletionsForShell() 执行补全命令并获取结果。
 * 5. 为每条补全结果的 metadata 附加 inputSnapshot（当前输入快照），
 *    供调用方检测输入是否已变更（补全结果是否仍然有效）。
 * 6. 任何异常均被捕获并静默忽略，记录调试日志后返回空数组。
 */
export async function getShellCompletions(
  input: string,
  cursorOffset: number,
  abortSignal: AbortSignal,
): Promise<SuggestionItem[]> {
  const shellType = getShellType()

  // 仅支持 bash/zsh（与 Shell.ts 执行支持匹配）
  if (shellType !== 'bash' && shellType !== 'zsh') {
    return []
  }

  try {
    const { prefix, completionType } = parseInputContext(input, cursorOffset)

    if (!prefix) {
      return [] // 前缀为空时不执行补全，避免返回大量无关结果
    }

    const completions = await getCompletionsForShell(
      shellType,
      prefix,
      completionType,
      abortSignal,
    )

    // 为所有补全结果附加 inputSnapshot，以便检测输入变化时使其失效
    return completions.map(suggestion => ({
      ...suggestion,
      metadata: {
        ...(suggestion.metadata as { completionType: ShellCompletionType }),
        inputSnapshot: input, // 记录补全时的输入快照，用于失效检测
      },
    }))
  } catch (error) {
    logForDebugging(`Shell completion failed: ${error}`)
    return [] // 静默失败
  }
}
