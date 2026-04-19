/**
 * 命令前缀静态提取模块。
 *
 * 在 Claude Code 系统中，该模块提供基于 tree-sitter AST 的命令前缀提取能力，
 * 用于权限规则匹配和标志（flag）允许列表：
 * - getCommandPrefixStatic()：提取单条命令的命令+子命令前缀，
 *   支持包装命令（如 sudo/nice）递归展开（深度 ≤10，包装层数 ≤2）
 * - getCompoundCommandPrefixesStatic()：提取复合命令（&&/||/;）的所有子命令前缀，
 *   按根命令分组后通过词对齐最长公共前缀折叠
 * - longestCommonPrefix()（内部）：计算字符串数组的词对齐最长公共前缀
 *
 * 环境变量赋值前缀（如 FOO=bar cmd）会保留在返回前缀中。
 */
import { buildPrefix } from '../shell/specPrefix.js'
import { splitCommand_DEPRECATED } from './commands.js'
import { extractCommandArguments, parseCommand } from './parser.js'
import { getCommandSpec } from './registry.js'

// 匹配纯数字字符串（用于过滤 nice -5 中的优先级数字参数）
const NUMERIC = /^\d+$/
// 匹配环境变量赋值前缀（如 FOO=bar），用于在包装命令参数中跳过环境变量
const ENV_VAR = /^[A-Za-z_][A-Za-z0-9_]*=/

// 包含复杂选项处理逻辑、无法用规范文件表达的包装命令集合
// nice 命令的包装位置取决于其选项个数，需要特殊处理
const WRAPPER_COMMANDS = new Set([
  'nice', // 命令在参数中的位置随选项数量变化
])

// 将单值或数组统一转换为数组，用于处理规范文件中 args 字段可能是单对象或数组的情况
const toArray = <T>(val: T | T[]): T[] => (Array.isArray(val) ? val : [val])

/**
 * 检查给定参数是否匹配规范中已知的子命令名称。
 * 用于区分包装命令与具有子命令的命令（如 git 的别名规范中含有 isCommand 参数），
 * 避免把 git commit 中的 commit 误判为被包装的子进程命令。
 */
function isKnownSubcommand(
  arg: string,
  spec: { subcommands?: { name: string | string[] }[] } | null,
): boolean {
  if (!spec?.subcommands?.length) return false
  // 遍历所有子命令定义，name 可能是字符串或字符串数组（支持别名）
  return spec.subcommands.some(sub =>
    Array.isArray(sub.name) ? sub.name.includes(arg) : sub.name === arg,
  )
}

/**
 * 提取单条命令的权限前缀（命令 + 子命令部分）。
 *
 * 流程：
 * 1. 用 tree-sitter 解析命令，提取命令节点和环境变量前缀；
 * 2. 查询命令规范，判断是否为包装命令（WRAPPER_COMMANDS 或规范中含 isCommand 参数）；
 * 3. 若首个参数已匹配已知子命令，则不视为包装命令（如 git commit 不是包装）；
 * 4. 包装命令走 handleWrapper() 递归展开；普通命令走 buildPrefix() 按规范提取前缀；
 * 5. 将环境变量前缀拼接到结果前缀前返回。
 *
 * 递归深度 ≤10，包装层数 ≤2，防止无限展开。
 */
export async function getCommandPrefixStatic(
  command: string,
  recursionDepth = 0,
  wrapperCount = 0,
): Promise<{ commandPrefix: string | null } | null> {
  // 超过递归深度或包装层数上限，返回 null 表示无法处理
  if (wrapperCount > 2 || recursionDepth > 10) return null

  // 用 tree-sitter 解析命令；返回 null 说明解析失败（命令过长或语法错误）
  const parsed = await parseCommand(command)
  if (!parsed) return null
  // 无命令节点说明是纯赋值或空命令，返回 null 前缀
  if (!parsed.commandNode) {
    return { commandPrefix: null }
  }

  const { envVars, commandNode } = parsed
  // 从命令节点提取实际的命令名和参数列表
  const cmdArgs = extractCommandArguments(commandNode)

  // 第一个元素是命令名；若为空则无法提取前缀
  const [cmd, ...args] = cmdArgs
  if (!cmd) return { commandPrefix: null }

  // 查询该命令对应的规范文件，用于判断是否为包装命令及构建前缀
  const spec = await getCommandSpec(cmd)
  // 判断是否为包装命令：在 WRAPPER_COMMANDS 集合中，或规范 args 中含有 isCommand 标记
  let isWrapper =
    WRAPPER_COMMANDS.has(cmd) ||
    (spec?.args && toArray(spec.args).some(arg => arg?.isCommand))

  // 特殊情况：若命令有子命令定义且首个参数匹配已知子命令，
  // 则视为普通命令而非包装命令（例如 git 规范含 isCommand 但 git commit 不应展开）
  if (isWrapper && args[0] && isKnownSubcommand(args[0], spec)) {
    isWrapper = false
  }

  // 包装命令递归展开内部命令；普通命令按规范构建前缀
  const prefix = isWrapper
    ? await handleWrapper(cmd, args, recursionDepth, wrapperCount)
    : await buildPrefix(cmd, args, spec)

  // 顶层包装命令展开失败（返回 null），说明无法解析被包装命令，整体返回 null
  if (prefix === null && recursionDepth === 0 && isWrapper) {
    return null
  }

  // 将环境变量前缀（如 FOO=bar ）拼接到命令前缀之前
  const envPrefix = envVars.length ? `${envVars.join(' ')} ` : ''
  return { commandPrefix: prefix ? envPrefix + prefix : null }
}

/**
 * 处理包装命令（如 sudo、nice）的前缀提取。
 *
 * 流程：
 * 1. 先尝试按规范文件中的 isCommand 参数位置定位被包装的子命令；
 *    按 commandArgIndex 遍历参数，跳过选项，在指定位置递归提取子命令前缀；
 * 2. 若无规范或规范不含 isCommand，则回退到"第一个非选项、非数字、非环境变量"参数，
 *    将其后的所有参数作为被包装命令递归提取前缀；
 * 3. 返回格式为：包装命令名 + 路径参数 + 子命令前缀（空格分隔）。
 */
async function handleWrapper(
  command: string,
  args: string[],
  recursionDepth: number,
  wrapperCount: number,
): Promise<string | null> {
  const spec = await getCommandSpec(command)

  if (spec?.args) {
    // 找到规范中第一个 isCommand 参数的位置索引
    const commandArgIndex = toArray(spec.args).findIndex(arg => arg?.isCommand)

    if (commandArgIndex !== -1) {
      // 构建前缀部分，包含包装命令名及到达子命令前的非选项参数
      const parts = [command]

      for (let i = 0; i < args.length && i <= commandArgIndex; i++) {
        if (i === commandArgIndex) {
          // 到达 isCommand 位置，将剩余参数拼成字符串后递归提取子命令前缀
          const result = await getCommandPrefixStatic(
            args.slice(i).join(' '),
            recursionDepth + 1,
            wrapperCount + 1,
          )
          if (result?.commandPrefix) {
            // 把子命令前缀拆分后附加到 parts，最后拼接为完整前缀
            parts.push(...result.commandPrefix.split(' '))
            return parts.join(' ')
          }
          break
        } else if (
          args[i] &&
          !args[i]!.startsWith('-') &&  // 跳过选项参数（如 -u root）
          !ENV_VAR.test(args[i]!)        // 跳过环境变量赋值（如 FOO=bar）
        ) {
          // 将非选项、非环境变量的中间参数（如 sudo -u root 中的 root）加入前缀
          parts.push(args[i]!)
        }
      }
    }
  }

  // 回退路径：在参数中找到第一个非选项、非纯数字、非环境变量的参数作为子命令起点
  const wrapped = args.find(
    arg => !arg.startsWith('-') && !NUMERIC.test(arg) && !ENV_VAR.test(arg),
  )
  // 若无法找到被包装命令，返回包装命令本身作为前缀
  if (!wrapped) return command

  // 从找到的子命令参数起点递归提取前缀
  const result = await getCommandPrefixStatic(
    args.slice(args.indexOf(wrapped)).join(' '),
    recursionDepth + 1,
    wrapperCount + 1,
  )

  // 子命令前缀为空则返回 null；否则拼接为"包装命令 子命令前缀"
  return !result?.commandPrefix ? null : `${command} ${result.commandPrefix}`
}

/**
 * Computes prefixes for a compound command (with && / || / ;).
 * For single commands, returns a single-element array with the prefix.
 *
 * 处理复合命令（由 &&、||、; 连接的多条子命令）的前缀提取：
 * 1. 用 splitCommand_DEPRECATED 将复合命令拆分为子命令列表；
 * 2. 对每个子命令调用 getCommandPrefixStatic 获取前缀；
 * 3. 按根命令（第一个单词）分组，同根命令的多个前缀通过词对齐 LCP 折叠为一条；
 * 4. 返回折叠后的前缀数组，供权限规则建议使用。
 *
 * @param excludeSubcommand — optional filter; return true for subcommands
 *   that should be excluded from the prefix suggestion (e.g. read-only
 *   commands that are already auto-allowed).
 */
export async function getCompoundCommandPrefixesStatic(
  command: string,
  excludeSubcommand?: (subcommand: string) => boolean,
): Promise<string[]> {
  // 拆分复合命令为子命令列表
  const subcommands = splitCommand_DEPRECATED(command)
  // 单条命令直接提取前缀，无需分组折叠
  if (subcommands.length <= 1) {
    const result = await getCommandPrefixStatic(command)
    return result?.commandPrefix ? [result.commandPrefix] : []
  }

  const prefixes: string[] = []
  for (const subcmd of subcommands) {
    const trimmed = subcmd.trim()
    // 跳过调用方指定要排除的子命令（如只读命令已在自动允许列表中）
    if (excludeSubcommand?.(trimmed)) continue
    const result = await getCommandPrefixStatic(trimmed)
    if (result?.commandPrefix) {
      prefixes.push(result.commandPrefix)
    }
  }

  if (prefixes.length === 0) return []

  // 按根命令（前缀第一个单词）分组，为后续 LCP 折叠做准备
  const groups = new Map<string, string[]>()
  for (const prefix of prefixes) {
    const root = prefix.split(' ')[0]!
    const group = groups.get(root)
    if (group) {
      group.push(prefix)
    } else {
      groups.set(root, [prefix])
    }
  }

  // 对每个根命令分组计算词对齐 LCP，折叠为单条前缀
  const collapsed: string[] = []
  for (const [, group] of groups) {
    collapsed.push(longestCommonPrefix(group))
  }
  return collapsed
}

/**
 * 计算字符串数组的词对齐最长公共前缀（LCP）。
 * 按空格分词后逐词比较，返回所有字符串共有的单词序列拼接结果。
 * 即使公共单词为零也至少返回第一个单词，确保结果不为空字符串。
 *
 * 示例：
 * ["git fetch", "git worktree"] → "git"
 * ["npm run test", "npm run lint"] → "npm run"
 */
function longestCommonPrefix(strings: string[]): string {
  if (strings.length === 0) return ''
  if (strings.length === 1) return strings[0]!

  const first = strings[0]!
  const words = first.split(' ')
  // 从第一个字符串的单词数开始，逐步向下缩减
  let commonWords = words.length

  for (let i = 1; i < strings.length; i++) {
    const otherWords = strings[i]!.split(' ')
    let shared = 0
    // 逐词比较，找到第一个不同的单词位置
    while (
      shared < commonWords &&
      shared < otherWords.length &&
      words[shared] === otherWords[shared]
    ) {
      shared++
    }
    // 更新公共单词数为当前最小值
    commonWords = shared
  }

  // 至少保留 1 个单词（根命令），避免返回空字符串
  return words.slice(0, Math.max(1, commonWords)).join(' ')
}
