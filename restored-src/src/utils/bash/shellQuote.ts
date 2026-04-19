/**
 * shell-quote 库安全封装模块。
 *
 * 在 Claude Code 系统中，该模块对 shell-quote 库的 parse/quote 函数进行安全包装，
 * 提供带错误处理的替代版本，并实现两个关键安全检测函数：
 * - tryParseShellCommand()：安全解析 shell 命令，异常时返回错误对象而非抛出
 * - tryQuoteShellArgs()：安全 shell 引号化参数列表，类型校验后引号化
 * - hasMalformedTokens()：检测 shell-quote 解析结果中的畸形 token（防止注入，HackerOne #3482049）
 * - hasShellQuoteSingleQuoteBug()：检测 shell-quote 对单引号内反斜杠的错误处理差异
 * - quote()：对参数列表进行 shell 引号化，含宽松回退路径
 *
 * 以下为 shell-quote 库函数的安全封装，能够优雅处理错误。
 * 可直接替换原始函数使用。
 */

import {
  type ParseEntry,
  parse as shellQuoteParse,
  quote as shellQuoteQuote,
} from 'shell-quote'
import { logError } from '../log.js'
import { jsonStringify } from '../slowOperations.js'

export type { ParseEntry } from 'shell-quote'

export type ShellParseResult =
  | { success: true; tokens: ParseEntry[] }
  | { success: false; error: string }

export type ShellQuoteResult =
  | { success: true; quoted: string }
  | { success: false; error: string }

/**
 * 安全解析 shell 命令字符串，将其分解为 token 列表。
 * 支持传入环境变量映射或查找函数进行变量展开。
 * 解析异常时记录错误并返回 { success: false } 而非抛出。
 * @param cmd 待解析的 shell 命令字符串
 * @param env 可选的环境变量映射或查找函数
 */
export function tryParseShellCommand(
  cmd: string,
  env?:
    | Record<string, string | undefined>
    | ((key: string) => string | undefined),
): ShellParseResult {
  try {
    const tokens =
      typeof env === 'function'
        ? shellQuoteParse(cmd, env)
        : shellQuoteParse(cmd, env)
    return { success: true, tokens }
  } catch (error) {
    if (error instanceof Error) {
      logError(error)
    }
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown parse error',
    }
  }
}

/**
 * 对参数列表进行 shell 引号化，返回可安全传入 shell 的字符串。
 * 仅接受 string/number/boolean/null/undefined 类型；
 * object/symbol/function 类型参数将导致返回 { success: false }。
 * @param args 待引号化的参数列表（允许混合类型）
 */
export function tryQuoteShellArgs(args: unknown[]): ShellQuoteResult {
  try {
    const validated: string[] = args.map((arg, index) => {
      if (arg === null || arg === undefined) {
        return String(arg)
      }

      const type = typeof arg

      if (type === 'string') {
        return arg as string
      }
      if (type === 'number' || type === 'boolean') {
        return String(arg)
      }

      if (type === 'object') {
        throw new Error(
          `Cannot quote argument at index ${index}: object values are not supported`,
        )
      }
      if (type === 'symbol') {
        throw new Error(
          `Cannot quote argument at index ${index}: symbol values are not supported`,
        )
      }
      if (type === 'function') {
        throw new Error(
          `Cannot quote argument at index ${index}: function values are not supported`,
        )
      }

      throw new Error(
        `Cannot quote argument at index ${index}: unsupported type ${type}`,
      )
    })

    const quoted = shellQuoteQuote(validated)
    return { success: true, quoted }
  } catch (error) {
    if (error instanceof Error) {
      logError(error)
    }
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown quote error',
    }
  }
}

/**
 * 检测 shell-quote 解析结果中是否存在畸形 token，防止命令注入（HackerOne #3482049）。
 *
 * shell-quote 可能将含歧义模式的命令（如含分号的 JSON 字符串）按 shell 规则解析，
 * 产生括号/引号不平衡的 token 碎片；合法命令的 token 应保持平衡。
 * 例如 `echo {"hi":"hi;evil"}` 会将 `;` 解析为运算符，产生 `{hi:"hi` 等畸形 token。
 *
 * 同时检测原始命令中的未闭合引号：shell-quote 会静默丢弃未匹配的 `"` 或 `'`，
 * 不在 token 中留下痕迹；本函数按 bash 语义遍历原始命令并检测引号奇偶性。
 *
 * @param command 原始 shell 命令字符串
 * @param parsed shell-quote 解析得到的 token 列表
 * @returns 若存在畸形 token 或未闭合引号则返回 true
 */
export function hasMalformedTokens(
  command: string,
  parsed: ParseEntry[],
): boolean {
  // 检测原始命令中的未闭合引号。shell-quote 会静默丢弃不匹配的引号，
  // 且在 token 中不留任何痕迹，因此必须检查原始字符串。
  // 按 bash 语义遍历：在单引号外，反斜杠转义下一个字符；在单引号内无转义。
  let inSingle = false
  let inDouble = false
  let doubleCount = 0
  let singleCount = 0
  for (let i = 0; i < command.length; i++) {
    const c = command[i]
    if (c === '\\' && !inSingle) {
      i++
      continue
    }
    if (c === '"' && !inSingle) {
      doubleCount++
      inDouble = !inDouble
    } else if (c === "'" && !inDouble) {
      singleCount++
      inSingle = !inSingle
    }
  }
  if (doubleCount % 2 !== 0 || singleCount % 2 !== 0) return true

  for (const entry of parsed) {
    if (typeof entry !== 'string') continue

    // 检查花括号是否平衡
    const openBraces = (entry.match(/{/g) || []).length
    const closeBraces = (entry.match(/}/g) || []).length
    if (openBraces !== closeBraces) return true

    // 检查圆括号是否平衡
    const openParens = (entry.match(/\(/g) || []).length
    const closeParens = (entry.match(/\)/g) || []).length
    if (openParens !== closeParens) return true

    // 检查方括号是否平衡
    const openBrackets = (entry.match(/\[/g) || []).length
    const closeBrackets = (entry.match(/\]/g) || []).length
    if (openBrackets !== closeBrackets) return true

    // 检查双引号是否平衡
    // 统计未转义（前无反斜杠）的引号数量
    // token 中奇数个未转义引号视为畸形
    // eslint-disable-next-line custom-rules/no-lookbehind-regex -- gated by hasCommandSeparator check at caller, runs on short per-token strings
    const doubleQuotes = entry.match(/(?<!\\)"/g) || []
    if (doubleQuotes.length % 2 !== 0) return true

    // 检查单引号是否平衡
    // eslint-disable-next-line custom-rules/no-lookbehind-regex -- same as above
    const singleQuotes = entry.match(/(?<!\\)'/g) || []
    if (singleQuotes.length % 2 !== 0) return true
  }
  return false
}

/**
 * 检测命令中是否存在 shell-quote 对单引号内反斜杠的错误处理差异。
 *
 * 在 bash 中，单引号内所有字符均为字面值，反斜杠无转义作用：
 * `'\'` 即 `\`（引号开，含 \，下一个 `'` 闭合）。
 * 但 shell-quote 错误地将 `\` 视为转义符，导致 `'\'` 不能闭合引号。
 *
 * 攻击者可利用 `'\'` <payload> `'\'` 模式将 payload 隐藏在单引号字符串中，
 * 绕过安全检测。本函数按正确的 bash 语义遍历命令，检测此差异。
 *
 * @param command 原始 shell 命令字符串
 * @returns 若命令中存在可被 shell-quote 误解析的单引号反斜杠模式则返回 true
 */
export function hasShellQuoteSingleQuoteBug(command: string): boolean {
  // 按正确的 bash 单引号语义遍历命令
  let inSingleQuote = false
  let inDoubleQuote = false

  for (let i = 0; i < command.length; i++) {
    const char = command[i]

    // 在单引号外处理反斜杠转义
    if (char === '\\' && !inSingleQuote) {
      // 跳过下一个字符（已被转义）
      i++
      continue
    }

    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote
      continue
    }

    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote

      // 检查我们刚刚关闭单引号后内容是否以尾随反斜杠结尾。
      // shell-quote 的分块正则 '((\\'|[^'])*?)' 错误地将 \' 视为单引号内的
      // 转义序列，而 bash 将反斜杠视为字面量。这造成解析差异：
      // shell-quote 合并了 bash 视为独立的 token。
      //
      // 奇数个尾随 \' = 必然是 bug：
      //   '\' -> shell-quote：\' = 字面 '，引号仍未闭合。bash：\，已闭合。
      //   'abc\' -> shell-quote：abc 后跟 \' = 字面 '，仍未闭合。bash：abc\，已闭合。
      //   '\\\'  -> shell-quote：\\ + \'，仍未闭合。bash：\\\，已闭合。
      //
      // 偶数个尾随 \' = 仅当命令中后续存在 ' 时才是 bug：
      //   单独的 '\\' -> shell-quote 回溯，两个解析器均同意字符串闭合。正常。
      //   '\\' 'next' -> shell-quote：\' 消耗闭合 '，找到 next 的 ' 作为假闭合，
      //                   合并 token。bash：两个独立 token。
      //
      //   细节：正则交替在 [^'] 之前尝试 \'。对于 '\\'，首先通过 [^'] 匹配第一个 \
      //   （下一字符是 \，不是 '），再通过 \' 匹配第二个 \（下一字符确实是 '）。
      //   这消耗了闭合 '。正则继续读取直到找到另一个 ' 关闭匹配。
      //   若不存在，则对第二个 \ 回溯到 [^'] 并正确闭合。若后续存在 '
      //   （如下一个单引号参数的开始），则不发生回溯，token 被合并。
      //   参见 H1 报告：git ls-remote 'safe\\' '--upload-pack=evil' 'repo'
      //   shell-quote: ["git","ls-remote","safe\\\\ --upload-pack=evil repo"]
      //   bash:        ["git","ls-remote","safe\\\\","--upload-pack=evil","repo"]
      if (!inSingleQuote) {
        let backslashCount = 0
        let j = i - 1
        while (j >= 0 && command[j] === '\\') {
          backslashCount++
          j--
        }
        if (backslashCount > 0 && backslashCount % 2 === 1) {
          return true
        }
        // 偶数个尾随反斜杠：仅当后续存在 ' 可被分块正则当作假闭合引号时才是 bug。
        // 检查任意后续 '，因为正则不遵守 bash 引号状态
        // （例如双引号内的 ' 也可被消耗）。
        if (
          backslashCount > 0 &&
          backslashCount % 2 === 0 &&
          command.indexOf("'", i + 1) !== -1
        ) {
          return true
        }
      }
      continue
    }
  }

  return false
}

/**
 * 对任意参数列表进行 shell 引号化，优先使用严格校验路径，
 * 失败时回退到宽松路径（将 object/symbol/function 转换为字符串后引号化）。
 * 注意：宽松路径使用 JSON.stringify 而非双引号，以防命令执行注入。
 * @param args 待引号化的参数列表（ReadonlyArray，允许任意类型）
 */
export function quote(args: ReadonlyArray<unknown>): string {
  // 首先尝试严格校验路径
  const result = tryQuoteShellArgs([...args])

  if (result.success) {
    return result.quoted
  }

  // 若严格校验失败，使用宽松回退路径
  // 将 object/symbol/function 等类型转换为字符串后引号化
  try {
    const stringArgs = args.map(arg => {
      if (arg === null || arg === undefined) {
        return String(arg)
      }

      const type = typeof arg

      if (type === 'string' || type === 'number' || type === 'boolean') {
        return String(arg)
      }

      // 对不支持的类型，使用 JSON.stringify 作为安全回退
      // 保证不崩溃并获得有意义的字符串表示
      return jsonStringify(arg)
    })

    return shellQuoteQuote(stringArgs)
  } catch (error) {
    // 安全：切勿将 JSON.stringify 作为 shell 引号化的回退。
    // JSON.stringify 使用双引号，无法阻止 shell 命令执行。
    // 例如 jsonStringify(['echo', '$(whoami)']) 会产生 "echo" "$(whoami)"
    if (error instanceof Error) {
      logError(error)
    }
    throw new Error('Failed to quote shell arguments safely')
  }
}
