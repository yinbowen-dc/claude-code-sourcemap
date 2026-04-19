/**
 * 基于 tree-sitter AST 的 bash 命令安全分析模块。
 *
 * 在 Claude Code 系统中，该模块替代 bashSecurity.ts / commands.ts 中
 * shell-quote + 手写字符遍历的旧方案，通过 tree-sitter-bash 解析并以显式
 * 节点类型白名单遍历 AST，对任何不在白名单中的节点类型将命令分类为 'too-complex'，
 * 从而触发正常权限提示流程（Fail-Closed 设计原则）。
 *
 * 核心设计属性：FAIL-CLOSED — 对未显式白名单化的结构拒绝提取 argv，
 * 调用方必须询问用户。该模块不是沙箱，不阻止危险命令执行；
 * 仅回答一个问题："能否为每个简单命令生成可信的 argv[]？"
 *
 * 基于 tree-sitter AST 的 bash 命令分析，替代 bashSecurity.ts / commands.ts 中
 * shell-quote + 手写字符遍历的旧方案。
 */

import { SHELL_KEYWORDS } from './bashParser.js'
import type { Node } from './parser.js'
import { PARSE_ABORTED, parseCommandRaw } from './parser.js'

export type Redirect = {
  op: '>' | '>>' | '<' | '<<' | '>&' | '>|' | '<&' | '&>' | '&>>' | '<<<'
  target: string
  fd?: number
}

export type SimpleCommand = {
  /** argv[0] 为命令名，其余为已解析引号的参数列表 */
  argv: string[]
  /** 命令前的 VAR=val 环境变量赋值 */
  envVars: { name: string; value: string }[]
  /** 输出/输入重定向列表 */
  redirects: Redirect[]
  /** 该命令在原始源码中的文本片段（用于 UI 显示） */
  text: string
}

export type ParseForSecurityResult =
  | { kind: 'simple'; commands: SimpleCommand[] }
  | { kind: 'too-complex'; reason: string; nodeType?: string }
  | { kind: 'parse-unavailable' }

/**
 * 命令组合结构节点类型集合，遍历时递归穿透这些节点以找到叶子 `command` 节点。
 * `program` 为 AST 根节点；`list` 对应 `a && b || c`；
 * `pipeline` 对应 `a | b`；`redirected_statement` 将命令与其重定向包裹在一起。
 * 分号分隔的命令直接作为 `program` 的子节点出现（无包装节点）。
 *
 * 命令组合结构节点类型集合，遍历时递归穿透这些节点以找到叶子 `command` 节点。
 * `program` 为 AST 根节点；`list` 对应 `a && b || c`；
 * `pipeline` 对应 `a | b`；`redirected_statement` 将命令与其重定向包裹在一起。
 * 分号分隔的命令直接作为 `program` 的子节点出现（无包装节点）。
 */
const STRUCTURAL_TYPES = new Set([
  'program',
  'list',
  'pipeline',
  'redirected_statement',
])

/**
 * 命令分隔符令牌集合。这些叶子节点出现在 `list`/`pipeline`/`program` 中的命令之间，
 * 本身不携带任何有效载荷，遍历时可安全跳过。
 *
 * 命令分隔符令牌集合，出现在命令之间、本身不携带有效载荷，遍历时可安全跳过。
 */
const SEPARATOR_TYPES = new Set(['&&', '||', '|', ';', '&', '|&', '\n'])

/**
 * $() 命令替换在外层 argv 中使用的占位符字符串。
 * $() 的实际输出在运行时才确定；其内层命令会单独与权限规则匹配检测。
 * 使用占位符可保持外层 argv 干净（避免多行 heredoc 内容污染路径提取
 * 或触发换行符检查）。
 *
 * $() 命令替换在外层 argv 中使用的占位符字符串。外层 argv 保持干净，
 * 避免多行 heredoc 内容污染路径提取或触发换行符检查；
 * 内层命令会单独与权限规则匹配检测。
 */
const CMDSUB_PLACEHOLDER = '__CMDSUB_OUTPUT__'

/**
 * 针对同一命令中通过 variable_assignment 提前赋值的变量引用（$VAR）所使用的占位符。
 * 由于我们已追踪到该赋值，可知该变量存在，其值要么是静态字符串，
 * 要么是 __CMDSUB_OUTPUT__（若通过 $() 赋值）。两种情况均可安全替换。
 *
 * 针对同一命令中 variable_assignment 已追踪变量的 $VAR 引用所用占位符。
 * 由于已追踪该赋值，可知变量存在，其值为静态字符串或 __CMDSUB_OUTPUT__，均可安全替换。
 */
const VAR_PLACEHOLDER = '__TRACKED_VAR__'

/**
 * 所有占位符字符串集合，用于纵深防御：若 varScope 中某个值包含任意占位符
 * （精确匹配或内嵌形式），则该值不是纯字面量，不可作为裸参数信任。
 * 涵盖 `VAR="prefix$(cmd)"` → `"prefix__CMDSUB_OUTPUT__"` 这类合成情形——
 * 子字符串检查可捕获 Set.has() 精确匹配会漏掉的情况。
 *
 * 同时拦截与占位符字符串碰撞的用户输入字面量：
 * `VAR=__TRACKED_VAR__ && rm $VAR` — 视为非字面量（保守处理）。
 *
 * 所有占位符字符串集合，用于纵深防御：子字符串检查可捕获 Set.has() 精确匹配会漏掉的情况。
 */
function containsAnyPlaceholder(value: string): boolean {
  return value.includes(CMDSUB_PLACEHOLDER) || value.includes(VAR_PLACEHOLDER)
}

/**
 * 裸（无引号）$VAR 扩展在 bash 中会经历单词分割（按 $IFS：空格/制表符/换行符）
 * 和路径名扩展（glob 匹配 * ? [）。我们的 argv 只存一个字符串——
 * 但运行时 bash 可能产生多个参数，或通过 glob 匹配到路径。
 * 包含这些元字符的值不可作为裸参数信任：
 * `VAR="-rf /" && rm $VAR` → bash 执行 `rm -rf /`（两个参数），
 * 而我们的 argv 会是 `['rm', '-rf /']`（一个参数）。
 * 在双引号内（"$VAR"），分割和 glob 均不发生——该值确实是单一字面量参数。
 *
 * 裸（无引号）$VAR 会经历单词分割和路径名扩展，含这些元字符的值不可信任为裸参数。
 * 在双引号内（"$VAR"），分割和 glob 均不发生——值确实是单一字面量参数。
 */
const BARE_VAR_UNSAFE_RE = /[ \t\n*?[]/

// stdbuf flag 形式 —— 从包装器剥离 while 循环中提升
const STDBUF_SHORT_SEP_RE = /^-[ioe]$/
const STDBUF_SHORT_FUSED_RE = /^-[ioe]./
const STDBUF_LONG_RE = /^--(input|output|error)=/

/**
 * 已知安全的 bash 自动设置环境变量集合，其值由 shell/OS 控制，
 * 而非任意用户输入。通过 $VAR 引用这些变量是安全的——扩展结果确定，
 * 不引入注入风险。涵盖 `$HOME`、`$PWD`、`$USER`、`$PATH`、`$SHELL` 等。
 * 有意保持集合较小：仅包含 bash/login 始终设置、值为路径/名称（非任意内容）的变量。
 *
 * bash 自动设置的已知安全环境变量集合，值由 shell/OS 控制而非任意用户输入。
 * 有意保持集合较小：仅包含 bash/login 始终设置、值为路径/名称（非任意内容）的变量。
 */
const SAFE_ENV_VARS = new Set([
  'HOME', // 用户主目录
  'PWD', // 当前工作目录（bash 维护）
  'OLDPWD', // 上一个目录
  'USER', // 当前用户名
  'LOGNAME', // 登录名
  'SHELL', // 用户登录 shell
  'PATH', // 可执行文件搜索路径
  'HOSTNAME', // 机器主机名
  'UID', // 用户 ID
  'EUID', // 有效用户 ID
  'PPID', // 父进程 ID
  'RANDOM', // 随机数（bash 内置）
  'SECONDS', // shell 启动后经过的秒数
  'LINENO', // 当前行号
  'TMPDIR', // 临时目录
  // 特殊 bash 变量 —— 始终由 shell 设置：
  'BASH_VERSION', // bash 版本字符串
  'BASHPID', // 当前 bash 进程 ID
  'SHLVL', // shell 嵌套层级
  'HISTFILE', // 历史文件路径
  'IFS', // 字段分隔符（注意：仅在字符串内部安全；作为裸参数
  //       $IFS 是经典注入原语，resolveSimpleExpansion 中的 insideString 门控会正确阻断）
])

/**
 * 特殊 shell 变量集合（$?、$$、$!、$#、$0-$9）。tree-sitter 对这些变量
 * 使用 `special_variable_name` 节点（而非 `variable_name`）。
 * 其值由 shell 控制：退出状态、PID、位置参数。
 * 仅在字符串内部才可安全解析（与 SAFE_ENV_VARS 的理由相同——
 * 作为裸参数时其值本身就是参数，可能是来自 $1 等的路径/标志）。
 *
 * 安全说明：'@' 和 '*' 不在此集合中。在 "..." 内它们扩展为位置参数——
 * 而在 BashTool 新建的 bash shell 中这些参数为空。
 * 保留 $? / $$ / $! / $# / $0 / $- 作为安全子集。
 *
 * 特殊 shell 变量（$?、$$、$!、$#、$0-$9），值由 shell 控制。
 * 仅在字符串内部安全解析；'@' 和 '*' 有意不在此集合中。
 */
const SPECIAL_VAR_NAMES = new Set([
  '?', // 上一条命令的退出状态
  '$', // 当前 shell PID
  '!', // 最后一个后台进程 PID
  '#', // 位置参数个数
  '0', // 脚本名称
  '-', // shell 选项标志
])

/**
 * 表示"无法静态分析此命令"的节点类型集合。
 * 这些类型要么执行任意代码（替换、子 shell、控制流），
 * 要么扩展为静态无法确定的值（参数/算术扩展、花括号表达式）。
 *
 * 此集合并不穷举——仅记录已知危险类型。真正的安全属性
 * 来自 walkArgument/walkCommand 中的白名单：任何未被显式处理的类型
 * 同样触发 too-complex。
 *
 * 表示"无法静态分析此命令"的节点类型集合。
 * 此集合并不穷举——真正的安全属性来自 walkArgument/walkCommand 中的白名单。
 */
const DANGEROUS_TYPES = new Set([
  'command_substitution',
  'process_substitution',
  'expansion',
  'simple_expansion',
  'brace_expression',
  'subshell',
  'compound_statement',
  'for_statement',
  'while_statement',
  'until_statement',
  'if_statement',
  'case_statement',
  'function_definition',
  'test_command',
  'ansi_c_string',
  'translated_string',
  'herestring_redirect',
  'heredoc_redirect',
])

/**
 * 危险节点类型的数值 ID 映射，供分析事件上报使用（logEvent 不接受字符串）。
 * 按 DANGEROUS_TYPES 索引：0 = 未知/其他，-1 = ERROR（解析失败），-2 = 预检查阶段。
 * 新增条目应追加到末尾以保持 ID 稳定。
 *
 * 危险节点类型的数值 ID 映射，供分析事件上报使用。
 * 0 = 未知/其他，-1 = ERROR（解析失败），-2 = 预检查阶段。
 */
const DANGEROUS_TYPE_IDS = [...DANGEROUS_TYPES]
export function nodeTypeId(nodeType: string | undefined): number {
  if (!nodeType) return -2
  if (nodeType === 'ERROR') return -1
  const i = DANGEROUS_TYPE_IDS.indexOf(nodeType)
  return i >= 0 ? i + 1 : 0
}

/**
 * 重定向运算符令牌到规范运算符的映射表。
 * tree-sitter 将这些令牌作为 `file_redirect` 的子节点产出。
 *
 * 重定向运算符令牌到规范运算符的映射表，tree-sitter 将这些令牌作为 `file_redirect` 的子节点产出。
 */
const REDIRECT_OPS: Record<string, Redirect['op']> = {
  '>': '>',
  '>>': '>>',
  '<': '<',
  '>&': '>&',
  '<&': '<&',
  '>|': '>|',
  '&>': '&>',
  '&>>': '&>>',
  '<<<': '<<<',
}

/**
 * 花括号扩展模式：{a,b} 或 {a..b}，要求花括号内含有 , 或 ..。
 * 我们有意不尝试判断开括号是否被反斜杠转义：tree-sitter 不对反斜杠反转义，
 * 因此区分 `\{a,b}`（转义、字面量）与 `\\{a,b}`（字面量反斜杠 + 扩展）
 * 需要重新实现 bash 引号去除逻辑。故两种情况均拒绝——
 * 转义花括号的场景罕见，且可轻松改写为单引号形式。
 *
 * 花括号扩展模式：{a,b} 或 {a..b}。有意不尝试判断开括号是否被反斜杠转义，
 * 因为区分转义与否需要重新实现 bash 引号去除逻辑，故两种情况均拒绝。
 */
const BRACE_EXPANSION_RE = /\{[^{}\s]*(,|\.\.)[^{}\s]*\}/

/**
 * bash 会静默丢弃但会混淆静态分析的控制字符。
 * 含 CR（0x0D）：tree-sitter 将 CR 视为单词分隔符，
 * 而 bash 的默认 IFS 不含 CR，导致两者对单词边界的判断不一致。
 *
 * bash 会静默丢弃但会混淆静态分析的控制字符。
 * 含 CR（0x0D）：tree-sitter 将 CR 视为单词分隔符，而 bash 的默认 IFS 不含 CR。
 */
// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_RE = /[\x00-\x08\x0B-\x1F\x7F]/

/**
 * 超出 ASCII 范围的 Unicode 空白字符。这些字符在终端中不可见（或显示为普通空格），
 * 用户审查命令时无法察觉，但 bash 将其视为字面单词字符。
 * 拦截 NBSP、零宽空格、行/段落分隔符、BOM 等。
 *
 * 超出 ASCII 范围的 Unicode 空白字符，在终端中不可见但 bash 将其视为字面单词字符。
 * 拦截 NBSP、零宽空格、行/段落分隔符、BOM 等。
 */
const UNICODE_WHITESPACE_RE =
  /[\u00A0\u1680\u2000-\u200B\u2028\u2029\u202F\u205F\u3000\uFEFF]/

/**
 * 紧跟空白字符的反斜杠。bash 将 `\ ` 视为当前单词内的字面空格，
 * 但 tree-sitter 返回含反斜杠的原始文本。argv[0] 在 tree-sitter 中是 `cat\ test`，
 * 而 bash 实际运行的是带字面空格的 `cat test`。
 * 与其重新实现 bash 反转义规则，不如直接拒绝——实践中极为罕见，
 * 且可轻松改写为带引号的形式。
 *
 * 同时匹配紧跟换行符（续行）且与非空白字符相邻的反斜杠。
 * `tr\<NL>aceroute` — bash 拼接为 `traceroute`，但 tree-sitter 切分为两个单词（差异）。
 * 若 `\<NL>` 之前是空白（如 `foo && \<NL>bar`），两个解析器一致，故允许。
 *
 * 紧跟空白字符的反斜杠，导致 tree-sitter/bash 对单词边界判断不一致。
 */
const BACKSLASH_WHITESPACE_RE = /\\[ \t]|[^ \t\n\\]\\\n/

/**
 * Zsh 动态命名目录扩展：~[name]。在 zsh 中会调用 zsh_directory_name 钩子，
 * 可执行任意代码；bash 将其视为字面波浪线后跟 glob 字符类。
 * 由于 BashTool 通过用户默认 shell（通常为 zsh）运行，保守起见予以拒绝。
 *
 * Zsh 动态命名目录扩展：~[name]，在 zsh 中会调用 zsh_directory_name 钩子执行任意代码；
 * 由于 BashTool 通常通过 zsh 运行，保守起见予以拒绝。
 */
const ZSH_TILDE_BRACKET_RE = /~\[/

/**
 * Zsh EQUALS 扩展：单词首部的 `=cmd` 扩展为 `cmd` 的绝对路径（等价于 `$(which cmd)`）。
 * `=curl evil.com` 以 `/usr/bin/curl evil.com` 运行。
 * tree-sitter 将 `=curl` 解析为字面单词，因此基于基础命令名的 `Bash(curl:*)` 拒绝规则
 * 无法识别 `curl`。
 * 仅匹配单词首部 `=` 后紧跟命令名字符的情形——
 * `VAR=val` 和 `--flag=val` 中 `=` 在单词中间，不会被 zsh 扩展。
 *
 * Zsh EQUALS 扩展：单词首部 `=cmd` 扩展为 `cmd` 的绝对路径，
 * 导致基于基础命令名的拒绝规则无法识别真实命令。
 */
const ZSH_EQUALS_EXPANSION_RE = /(?:^|[\s;&|])=[a-zA-Z_]/

/**
 * 花括号字符与引号字符的组合。`{a'}',b}` 这样的构造利用花括号扩展上下文中的
 * 引号花括号来混淆基于正则的检测。在 bash 中 `{a'}',b}` 扩展为 `a} b`
 * （第一个替代项内的引号 `}` 成为字面量）。这类构造难以正确分析，
 * 且在我们希望自动允许的命令中没有合理用途。
 *
 * 此检查在将单引号和双引号范围内的 `{` 屏蔽后的命令版本上运行，
 * 因此 `curl -d '{"k":"v"}'` 等 JSON 载荷不会触发误报。
 * 引号字符本身保持可见，因此 `{a'}',b}` 和 `{@'{'0},...}` 仍通过外层
 * 非引号 `{` 匹配。
 *
 * 花括号字符与引号字符的组合，用于检测利用花括号扩展上下文中引号花括号混淆基于正则检测的构造。
 * 此检查在将引号范围内的 `{` 屏蔽后的命令版本上运行，避免 JSON 载荷触发误报。
 */
const BRACE_WITH_QUOTE_RE = /\{[^}]*['"]/

/**
 * 将单引号或双引号上下文内的 `{` 字符屏蔽为空格。
 * 使用单遍 bash 感知引号状态扫描器，而非正则表达式。
 *
 * 简单正则（`/'[^']*'/g`）在双引号字符串内含 `'` 时会误判范围：
 * 对于 `echo "it's" {a'}',b}`，会从 `it's` 中的 `'` 匹配到 `{a'}` 中的 `'`，
 * 屏蔽了非引号 `{` 并产生漏报。扫描器追踪实际 bash 引号状态：
 * `'` 仅在非引号上下文中切换单引号；`"` 仅在单引号外切换双引号；
 * `\` 在非引号上下文转义下一字符，在双引号内转义 `"` / `\\`。
 *
 * 花括号扩展在两种引号上下文中均不可能发生，因此屏蔽其中的 `{` 是安全的。
 * 次级防御：walkArgument 中的 BRACE_EXPANSION_RE。
 *
 * @param cmd 原始 bash 命令字符串
 * @returns 引号内 `{` 被替换为空格后的命令字符串
 */
function maskBracesInQuotedContexts(cmd: string): string {
  // 快速路径：无 `{` 则无需屏蔽，跳过逐字符扫描（>90% 的命令不含花括号）
  if (!cmd.includes('{')) return cmd
  const out: string[] = []
  let inSingle = false
  let inDouble = false
  let i = 0
  while (i < cmd.length) {
    const c = cmd[i]!
    if (inSingle) {
      // bash 单引号：无转义，`'` 始终终止单引号上下文
      if (c === "'") inSingle = false
      out.push(c === '{' ? ' ' : c)
      i++
    } else if (inDouble) {
      // bash 双引号：`\` 转义 `"` 和 `\`（也转义 `$`、反引号、换行——
      // 但这些不影响引号状态，故直接透传）
      if (c === '\\' && (cmd[i + 1] === '"' || cmd[i + 1] === '\\')) {
        out.push(c, cmd[i + 1]!)
        i += 2
      } else {
        if (c === '"') inDouble = false
        out.push(c === '{' ? ' ' : c)
        i++
      }
    } else {
      // 非引号上下文：`\` 转义紧跟的下一字符
      if (c === '\\' && i + 1 < cmd.length) {
        out.push(c, cmd[i + 1]!)
        i += 2
      } else {
        if (c === "'") inSingle = true
        else if (c === '"') inDouble = true
        out.push(c)
        i++
      }
    }
  }
  return out.join('')
}

const DOLLAR = String.fromCharCode(0x24)

/**
 * 解析 bash 命令字符串并提取扁平的简单命令列表。
 * 若命令使用了无法静态分析的 shell 特性，返回 'too-complex'；
 * 若 tree-sitter WASM 尚未加载，返回 'parse-unavailable'——调用方应回退到保守处理。
 *
 * @param cmd 待解析的 bash 命令字符串
 * @returns 解析结果：简单命令列表、过于复杂或解析不可用
 */
export async function parseForSecurity(
  cmd: string,
): Promise<ParseForSecurityResult> {
  // parseCommandRaw('') 返回 null（假值检查），此处短路处理空命令。
  // 不使用 .trim()——它会剥离 Unicode 空白字符（\u00a0 等），
  // 而 parseForSecurityFromAst 的预检查需要看到并拒绝这些字符。
  if (cmd === '') return { kind: 'simple', commands: [] }
  const root = await parseCommandRaw(cmd)
  return root === null
    ? { kind: 'parse-unavailable' }
    : parseForSecurityFromAst(cmd, root)
}

/**
 * 与 parseForSecurity 相同，但接受预解析的 AST 根节点，
 * 供需要将语法树用于其他目的的调用方复用，避免重复解析。
 * 预检查仍在 `cmd` 上运行——它们捕获成功解析后无法发现的
 * tree-sitter/bash 差异。
 *
 * @param cmd 原始命令字符串（用于预检查）
 * @param root 预解析的 AST 根节点或 PARSE_ABORTED 标志
 * @returns 解析结果
 */
export function parseForSecurityFromAst(
  cmd: string,
  root: Node | typeof PARSE_ABORTED,
): ParseForSecurityResult {
  // 预检查：导致 tree-sitter 与 bash 对单词边界判断不一致的字符。
  // 这些检查在 tree-sitter 解析之前运行，因为它们是已知的差异点。
  // 此后的所有处理均信任 tree-sitter 的分词结果。
  if (CONTROL_CHAR_RE.test(cmd)) {
    return { kind: 'too-complex', reason: 'Contains control characters' }
  }
  if (UNICODE_WHITESPACE_RE.test(cmd)) {
    return { kind: 'too-complex', reason: 'Contains Unicode whitespace' }
  }
  if (BACKSLASH_WHITESPACE_RE.test(cmd)) {
    return {
      kind: 'too-complex',
      reason: 'Contains backslash-escaped whitespace',
    }
  }
  if (ZSH_TILDE_BRACKET_RE.test(cmd)) {
    return {
      kind: 'too-complex',
      reason: 'Contains zsh ~[ dynamic directory syntax',
    }
  }
  if (ZSH_EQUALS_EXPANSION_RE.test(cmd)) {
    return {
      kind: 'too-complex',
      reason: 'Contains zsh =cmd equals expansion',
    }
  }
  if (BRACE_WITH_QUOTE_RE.test(maskBracesInQuotedContexts(cmd))) {
    return {
      kind: 'too-complex',
      reason: 'Contains brace with quote character (expansion obfuscation)',
    }
  }

  const trimmed = cmd.trim()
  if (trimmed === '') {
    return { kind: 'simple', commands: [] }
  }

  if (root === PARSE_ABORTED) {
    // 安全说明：模块已加载但解析被中止（超时 / 节点预算 / panic）。
    // 可被对抗性输入主动触发——约 2800 个下标的 `(( a[0][0]... ))` 在
    // 10K 长度限制内会触发 PARSE_TIMEOUT_MICROS。
    // 以前此情况与模块未加载无法区分 → 路由到旧路径（parse-unavailable），
    // 旧路径缺少 EVAL_LIKE_BUILTINS 检测，`trap`、`enable`、`hash` 等
    // 在 Bash(*) 规则下可绕过。失败关闭：too-complex → 询问用户。
    return {
      kind: 'too-complex',
      reason:
        'Parser aborted (timeout or resource limit) — possible adversarial input',
      nodeType: 'PARSE_ABORT',
    }
  }

  return walkProgram(root)
}

function walkProgram(root: Node): ParseForSecurityResult {
  // ERROR 节点检查已折入 collectCommands——任何未处理的节点类型
  // （包括 ERROR）在 default 分支中都会调用 tooComplex()，
  // 避免为错误检测单独进行一次完整的树遍历。
  const commands: SimpleCommand[] = []
  // 追踪同一命令中较早赋值的变量。当 simple_expansion（$VAR）引用已追踪变量时，
  // 可用占位符替代，而非返回 too-complex。
  // 例如 `NOW=$(date) && jq --arg now "$NOW" ...` — $NOW 已知为 $(date) 的输出
  // （内层命令已单独提取）。
  const varScope = new Map<string, string>()
  const err = collectCommands(root, commands, varScope)
  if (err) return err
  return { kind: 'simple', commands }
}

/**
 * 从结构包装节点递归收集叶子 `command` 节点。
 * 遇到任何不允许的节点类型时返回错误结果，成功时返回 null。
 *
 * @param node 当前 AST 节点
 * @param commands 收集到的简单命令列表（就地追加）
 * @param varScope 当前作用域内已赋值的变量映射
 * @returns 错误结果或 null（成功）
 */
function collectCommands(
  node: Node,
  commands: SimpleCommand[],
  varScope: Map<string, string>,
): ParseForSecurityResult | null {
  if (node.type === 'command') {
    // 将 `commands` 作为 innerCommands 累加器——walkCommand 提取的任何 $()
    // 都会与外层命令一同追加到列表中。
    const result = walkCommand(node, [], commands, varScope)
    if (result.kind !== 'simple') return result
    commands.push(...result.commands)
    return null
  }

  if (node.type === 'redirected_statement') {
    return walkRedirectedStatement(node, commands, varScope)
  }

  if (node.type === 'comment') {
    return null
  }

  if (STRUCTURAL_TYPES.has(node.type)) {
    // 安全说明：`||`、`|`、`|&`、`&` 不能线性传播 varScope。在 bash 中：
    //   `||` 右侧条件执行 → 其中设置的变量可能不存在
    //   `|`/`|&` 各阶段在子 shell 中运行 → 其中设置的变量对后续不可见
    //   `&` 左侧在后台子 shell 中运行 → 同上
    // 标志省略攻击示例：`true || FLAG=--dry-run && cmd $FLAG`——bash 跳过 `||` 右侧
    // （FLAG 未设置 → $FLAG 为空），在没有 --dry-run 的情况下运行 `cmd`。
    // 若使用线性 scope，我们的 argv 为 ['cmd','--dry-run'] → 看起来安全 → 绕过检测。
    //
    // 修复方案：在入口处对传入 scope 做快照。遇到这些分隔符后重置为快照——
    // 各子句内设置的变量不会泄漏到后续子句。`&&`/`;` 链的各段共享状态
    //（常见模式 `VAR=x && cmd $VAR`）。`||`/`|`/`&` 之后只使用入口前快照。
    //
    // 注意：首次出现 `||`/`|`/`&` 后，`scope` 和 `varScope` 会分叉。
    // 调用方的 varScope 仅对 `&&`/`;` 前缀发生变化——保守但安全。
    //
    // 效率：快照仅在遇到 `||`/`|`/`|&`/`&` 时才需要。
    // 对于主导情况（`ls`、`git status` 等无此类分隔符的命令），
    // 通过廉价预扫描跳过 Map 分配。
    const isPipeline = node.type === 'pipeline'
    let needsSnapshot = false
    if (!isPipeline) {
      for (const c of node.children) {
        if (c && (c.type === '||' || c.type === '&')) {
          needsSnapshot = true
          break
        }
      }
    }
    const snapshot = needsSnapshot ? new Map(varScope) : null
    // pipeline 的所有阶段都在子 shell 中运行——从副本开始，不污染调用方 scope；
    // list/program 中 `&&`/`;` 链会修改调用方 scope（顺序执行）；仅在 `||`/`&` 时分叉。
    let scope = isPipeline ? new Map(varScope) : varScope
    for (const child of node.children) {
      if (!child) continue
      if (SEPARATOR_TYPES.has(child.type)) {
        if (
          child.type === '||' ||
          child.type === '|' ||
          child.type === '|&' ||
          child.type === '&'
        ) {
          // pipeline：varScope 未改动（已从副本开始）；
          // list/program：snapshot 非空（预扫描已设置）。
          // `|`/`|&` 仅出现在 `pipeline` 节点下；`||`/`&` 出现在 list 下。
          scope = new Map(snapshot ?? varScope)
        }
        continue
      }
      const err = collectCommands(child, commands, scope)
      if (err) return err
    }
    return null
  }

  if (node.type === 'negated_command') {
    // `! cmd` 仅反转退出码——不执行代码也不影响 argv。
    // 递归进入被包装的命令。CI 中常见：`! grep err`、`! test -f lock`、`! git diff --quiet`。
    for (const child of node.children) {
      if (!child) continue
      if (child.type === '!') continue
      return collectCommands(child, commands, varScope)
    }
    return null
  }

  if (node.type === 'declaration_command') {
    // `export`/`local`/`readonly`/`declare`/`typeset`。
    // tree-sitter 将这些命令解析为 declaration_command 而非 command，
    // 以前会直接落入 tooComplex。
    // 值通过 walkVariableAssignment 验证：值中的 `$()` 递归提取（内层命令追加到
    // commands[]，外层 argv 得到 CMDSUB_PLACEHOLDER）；
    // 其他不允许的扩展仍通过 walkArgument 拒绝。
    // argv[0] 为内置命令名，因此 `Bash(export:*)` 规则可正常匹配。
    const argv: string[] = []
    for (const child of node.children) {
      if (!child) continue
      switch (child.type) {
        case 'export':
        case 'local':
        case 'readonly':
        case 'declare':
        case 'typeset':
          argv.push(child.text)
          break
        case 'word':
        case 'number':
        case 'raw_string':
        case 'string':
        case 'concatenation': {
          // 标志（`declare -r`）、带引号的名称（`export "FOO=bar"`）、数字（`declare -i 42`）。
          // 与 walkCommand 的 argv 处理保持镜像——此前 `export "FOO=bar"` 会因
          // `string` 子节点触发 tooComplex。walkArgument 验证每个参数（扩展仍拒绝）。
          const arg = walkArgument(child, commands, varScope)
          if (typeof arg !== 'string') return arg
          // 安全说明：declare/typeset/local 中改变赋值语义的标志会破坏静态模型。
          // -n（nameref）：`declare -n X=Y` 后 `$X` 解引用到 $Y 的值——
          //   varScope 存储 'Y'（目标名称），argv[0] 显示 'Y' 而 bash 运行 $Y 的值。
          // -i（integer）：`declare -i X='a[$(cmd)]'` 在赋值时算术求值 RHS，
          //   即使来自单引号 raw_string 也会运行 $(cmd)（与 walkArithmetic 在 $((...)) 中
          //   的保护相同）。
          // -a/-A（array）：赋值时对下标算术求值。
          // -r/-x/-g/-p/-f/-F 是惰性的（不影响语义）。
          // 检查解析后的 arg（而非 child.text），以捕获 `\-n` 和带引号的 `-n`。
          // 仅限 declare/typeset/local：`export -n` 表示"移除导出属性"（非 nameref），
          // export/readonly 不接受 -i；readonly -a/-A 对下标参数报无效标识符错误，
          // 因此下标算术不触发。
          if (
            (argv[0] === 'declare' ||
              argv[0] === 'typeset' ||
              argv[0] === 'local') &&
            /^-[a-zA-Z]*[niaA]/.test(arg)
          ) {
            return {
              kind: 'too-complex',
              reason: `declare flag ${arg} changes assignment semantics (nameref/integer/array)`,
              nodeType: 'declaration_command',
            }
          }
          // 安全说明：带下标的裸位置赋值同样会求值——无需 -a/-i 标志。
          // `declare 'x[$(id)]=val'` 隐式创建数组元素，算术求值下标并运行 $(id)。
          // tree-sitter 将单引号形式作为 raw_string 叶子传递，walkArgument 只看到字面文本。
          // 仅限 declare/typeset/local：export/readonly 在求值前就拒绝标识符中的 `[`。
          if (
            (argv[0] === 'declare' ||
              argv[0] === 'typeset' ||
              argv[0] === 'local') &&
            arg[0] !== '-' &&
            /^[^=]*\[/.test(arg)
          ) {
            return {
              kind: 'too-complex',
              reason: `declare positional '${arg}' contains array subscript — bash evaluates $(cmd) in subscripts`,
              nodeType: 'declaration_command',
            }
          }
          argv.push(arg)
          break
        }
        case 'variable_assignment': {
          const ev = walkVariableAssignment(child, commands, varScope)
          if ('kind' in ev) return ev
          // export/declare 赋值同样更新作用域，以便后续 $VAR 引用能正确解析
          applyVarToScope(varScope, ev)
          argv.push(`${ev.name}=${ev.value}`)
          break
        }
        case 'variable_name':
          // `export FOO` — 裸变量名，无赋值
          argv.push(child.text)
          break
        default:
          return tooComplex(child)
      }
    }
    commands.push({ argv, envVars: [], redirects: [], text: node.text })
    return null
  }

  if (node.type === 'variable_assignment') {
    // 语句级别的裸 `VAR=value`（不是命令的 env 前缀）。
    // 设置 shell 变量——无代码执行，无文件系统 I/O。
    // 值通过 walkVariableAssignment → walkArgument 验证，
    // 因此 `VAR=$(evil)` 仍会递归提取/拒绝内层命令。
    // 不推送到 commands——裸赋值不需要权限规则（它是惰性的）。
    // 常见模式：`VAR=x && cmd`（cmd 引用 $VAR）。约占 ant top-5k 命令中 too-complex 的 35%。
    const ev = walkVariableAssignment(node, commands, varScope)
    if ('kind' in ev) return ev
    // 更新作用域，使后续 `$VAR` 引用能正确解析
    applyVarToScope(varScope, ev)
    return null
  }

  if (node.type === 'for_statement') {
    // `for VAR in WORD...; do BODY; done` — 对每个单词迭代执行 BODY 一次。
    // BODY 命令只提取一次；每次迭代执行相同的命令集。
    //
    // 安全说明：循环变量始终视为未知值（VAR_PLACEHOLDER）。
    // 即使"静态"迭代单词也可能是：
    //  - 绝对路径：`for i in /etc/passwd; do rm $i; done`——
    //    body argv 只含占位符，路径验证永远看不到 /etc/passwd。
    //  - Glob：`for i in /etc/*; do rm $i; done`——
    //    `/etc/*` 在解析时是静态单词，但 bash 运行时会扩展它。
    //  - 标志：`for i in -rf /; do rm $i; done`——标志走私。
    //
    // VAR_PLACEHOLDER 意味着 body 中的裸 `$i` → too-complex。
    // 只有字符串嵌入（`echo "item: $i"`）才保持 simple。
    // 这回退了原始 PR 中部分 too-complex→simple 的改动——每一个都是潜在的路径验证绕过。
    let loopVar: string | null = null
    let doGroup: Node | null = null
    for (const child of node.children) {
      if (!child) continue
      if (child.type === 'variable_name') {
        loopVar = child.text
      } else if (child.type === 'do_group') {
        doGroup = child
      } else if (
        child.type === 'for' ||
        child.type === 'in' ||
        child.type === 'select' ||
        child.type === ';'
      ) {
        continue // 结构性令牌，跳过
      } else if (child.type === 'command_substitution') {
        // `for i in $(seq 1 3)` — 内层命令会被提取并进行规则检查
        const err = collectCommandSubstitution(child, commands, varScope)
        if (err) return err
      } else {
        // 迭代值——通过 walkArgument 验证。值被丢弃：
        // body argv 无论迭代单词是什么都得到 VAR_PLACEHOLDER，
        // body 中的裸 `$i` → too-complex（见上方安全说明）。
        // 但仍需验证以拒绝如 `for i in $(cmd); do ...; done` 这类
        // 迭代单词本身是不允许扩展的情况。
        const arg = walkArgument(child, commands, varScope)
        if (typeof arg !== 'string') return arg
      }
    }
    if (loopVar === null || doGroup === null) return tooComplex(node)
    // 安全说明：`for PS4 in '$(id)'; do set -x; :; done` 会直接通过下方
    // varScope.set 设置 PS4——walkVariableAssignment 的 PS4/IFS 检查永远不会触发。
    // PS4 导致 trace-time RCE，IFS 绕过单词分割。无合法用途，拒绝。
    if (loopVar === 'PS4' || loopVar === 'IFS') {
      return {
        kind: 'too-complex',
        reason: `${loopVar} as loop variable bypasses assignment validation`,
        nodeType: 'for_statement',
      }
    }
    // 安全说明：body 使用 scope 副本——循环体内赋值的变量不会泄漏到 `done` 之后。
    // 循环变量本身设置在真实 scope 中（bash 语义：循环后 $i 仍然存在），
    // 并复制到 body scope 中。始终使用 VAR_PLACEHOLDER——见上方说明。
    varScope.set(loopVar, VAR_PLACEHOLDER)
    const bodyScope = new Map(varScope)
    for (const c of doGroup.children) {
      if (!c) continue
      if (c.type === 'do' || c.type === 'done' || c.type === ';') continue
      const err = collectCommands(c, commands, bodyScope)
      if (err) return err
    }
    return null
  }

  if (node.type === 'if_statement' || node.type === 'while_statement') {
    // `if COND; then BODY; [elif...; else...;] fi`
    // `while COND; do BODY; done`
    // 提取条件命令和所有分支/body 命令，全部检查权限规则。
    // `while read VAR` 会追踪 VAR，以便 body 可引用 $VAR。
    //
    // 安全说明：分支 body 使用 scope 副本——条件分支内（可能不执行的）
    // 赋值不能泄漏到 fi/done 之后。`if false; then T=safe; fi && rm $T` 必须拒绝 $T。
    // 条件命令使用真实 varScope（始终执行，因此赋值无条件——
    // 例如 `while read V` 的追踪必须延续到 body 副本中）。
    //
    // tree-sitter if_statement 子节点：if、COND...、then、THEN-BODY...、
    // [elif_clause...]、[else_clause]、fi。
    // 通过追踪是否已见到 `then` 令牌来区分条件和 then-body。
    let seenThen = false
    for (const child of node.children) {
      if (!child) continue
      if (
        child.type === 'if' ||
        child.type === 'fi' ||
        child.type === 'else' ||
        child.type === 'elif' ||
        child.type === 'while' ||
        child.type === 'until' ||
        child.type === ';'
      ) {
        continue
      }
      if (child.type === 'then') {
        seenThen = true
        continue
      }
      if (child.type === 'do_group') {
        // while body：使用 scope 副本递归（body 赋值不泄漏到 done 之后）。
        // 副本包含来自条件的 `read VAR` 追踪（此时已在真实 varScope 中）。
        const bodyScope = new Map(varScope)
        for (const c of child.children) {
          if (!c) continue
          if (c.type === 'do' || c.type === 'done' || c.type === ';') continue
          const err = collectCommands(c, commands, bodyScope)
          if (err) return err
        }
        continue
      }
      if (child.type === 'elif_clause' || child.type === 'else_clause') {
        // elif_clause：elif、cond、;、then、body... / else_clause：else、body...
        // 使用 scope 副本——elif/else 分支赋值不泄漏到 fi 之后。
        const branchScope = new Map(varScope)
        for (const c of child.children) {
          if (!c) continue
          if (
            c.type === 'elif' ||
            c.type === 'else' ||
            c.type === 'then' ||
            c.type === ';'
          ) {
            continue
          }
          const err = collectCommands(c, commands, branchScope)
          if (err) return err
        }
        continue
      }
      // 条件（seenThen=false）或 then-body（seenThen=true）。
      // 条件使用真实 varScope（始终执行）；then-body 使用副本。
      // 特殊情况：`while read VAR`——条件中 `read VAR` 被收集后，
      // 在真实 scope 中追踪 VAR，以便 body 副本能继承该变量。
      const targetScope = seenThen ? new Map(varScope) : varScope
      const before = commands.length
      const err = collectCommands(child, commands, targetScope)
      if (err) return err
      // 若条件中包含 `read VAR...`，在真实 scope 中追踪相关变量。
      // read 的变量值未知（来自 stdin）→ 使用 VAR_PLACEHOLDER（未知值哨兵，仅限字符串）。
      if (!seenThen) {
        for (let i = before; i < commands.length; i++) {
          const c = commands[i]
          if (c?.argv[0] === 'read') {
            for (const a of c.argv.slice(1)) {
              // 跳过标志（-r、-d 等）；将裸标识符参数作为变量名追踪
              if (!a.startsWith('-') && /^[A-Za-z_][A-Za-z0-9_]*$/.test(a)) {
                // 安全说明：commands[] 是扁平累加器。条件中的 `true || read VAR`：
                // list 处理器正确地对 ||-右侧使用 scope 副本（可能不执行），
                // 但 `read VAR` 仍被推入 commands[]——从此处无法判断它是否在 scope 隔离中。
                // `echo | read VAR`（pipeline，bash 子 shell）和 `(read VAR)`（子 shell）同理。
                // 用 VAR_PLACEHOLDER 覆盖已追踪的字面量会隐藏路径穿越：
                // `VAR=../../etc/passwd && if true || read VAR; then cat "/tmp/$VAR"; fi`
                // ——解析器看到 /tmp/__TRACKED_VAR__，bash 读取 /etc/passwd。
                // 当被追踪的字面量将被覆盖时失败关闭（fail closed）；
                // 安全情况（无先前值或已是占位符）→ 继续。
                const existing = varScope.get(a)
                if (
                  existing !== undefined &&
                  !containsAnyPlaceholder(existing)
                ) {
                  return {
                    kind: 'too-complex',
                    reason: `'read ${a}' in condition may not execute (||/pipeline/subshell); cannot prove it overwrites tracked literal '${existing}'`,
                    nodeType: 'if_statement',
                  }
                }
                varScope.set(a, VAR_PLACEHOLDER)
              }
            }
          }
        }
      }
    }
    return null
  }

  if (node.type === 'subshell') {
    // `(cmd1; cmd2)` — 在子 shell 中运行命令。内层命令会被执行，
    // 因此提取它们进行权限检查。子 shell 有独立的作用域：
    // 内部赋值的变量不会泄漏出去。使用 varScope 副本
    // （外层变量可见，内层变更被丢弃）。
    const innerScope = new Map(varScope)
    for (const child of node.children) {
      if (!child) continue
      if (child.type === '(' || child.type === ')') continue
      const err = collectCommands(child, commands, innerScope)
      if (err) return err
    }
    return null
  }

  if (node.type === 'test_command') {
    // `[[ EXPR ]]` 或 `[ EXPR ]` — 条件测试。基于文件测试（-f、-d）、
    // 字符串比较（==、!=）等求值为 true/false。
    // 无代码执行（若内部含 command_substitution，会作为子节点被 walkArgument 递归并拒绝）。
    // 以 argv[0]='[[' 推送为合成命令，以便权限规则可以匹配
    // （`Bash([[ :*)` 规则虽罕见但合法）。
    // 遍历参数以验证（操作数内无 cmdsub/扩展）。
    const argv: string[] = ['[[']
    for (const child of node.children) {
      if (!child) continue
      if (child.type === '[[' || child.type === ']]') continue
      if (child.type === '[' || child.type === ']') continue
      // 递归进入测试表达式结构：unary_expression、binary_expression、
      // parenthesized_expression、negated_expression。
      // 叶子节点为 test_operator（-f、-d、==）和操作数单词。
      const err = walkTestExpr(child, argv, commands, varScope)
      if (err) return err
    }
    commands.push({ argv, envVars: [], redirects: [], text: node.text })
    return null
  }

  if (node.type === 'unset_command') {
    // `unset FOO BAR`、`unset -f func`。安全：仅从当前 shell 中移除变量/函数——
    // 无代码执行，无文件系统 I/O。tree-sitter 为其生成专用节点类型，
    // 之前会直接落入 tooComplex。子节点：`unset` 关键字、
    // 各变量名的 `variable_name` 节点、以及 `-f`/`-v` 等标志的 `word` 节点。
    const argv: string[] = []
    for (const child of node.children) {
      if (!child) continue
      switch (child.type) {
        case 'unset':
          argv.push(child.text)
          break
        case 'variable_name':
          argv.push(child.text)
          // 安全说明：unset 从 bash 作用域移除变量。同步从 varScope 删除，
          // 使后续 `$VAR` 引用正确拒绝。
          // `VAR=safe && unset VAR && rm $VAR` 不得解析 $VAR。
          varScope.delete(child.text)
          break
        case 'word': {
          const arg = walkArgument(child, commands, varScope)
          if (typeof arg !== 'string') return arg
          argv.push(arg)
          break
        }
        default:
          return tooComplex(child)
      }
    }
    commands.push({ argv, envVars: [], redirects: [], text: node.text })
    return null
  }

  return tooComplex(node)
}

/**
 * 递归遍历 test_command 的表达式树（unary/binary/negated/parenthesized 表达式）。
 * 叶子节点为 test_operator 令牌和操作数（word/string/number 等）。
 * 操作数通过 walkArgument 验证。
 *
 * @param node 当前表达式节点
 * @param argv 输出 argv 数组（就地追加）
 * @param innerCommands 内层命令累加器（用于传递 $() 提取）
 * @param varScope 当前变量作用域
 */
function walkTestExpr(
  node: Node,
  argv: string[],
  innerCommands: SimpleCommand[],
  varScope: Map<string, string>,
): ParseForSecurityResult | null {
  switch (node.type) {
    case 'unary_expression':
    case 'binary_expression':
    case 'negated_expression':
    case 'parenthesized_expression': {
      for (const c of node.children) {
        if (!c) continue
        const err = walkTestExpr(c, argv, innerCommands, varScope)
        if (err) return err
      }
      return null
    }
    case 'test_operator':
    case '!':
    case '(':
    case ')':
    case '&&':
    case '||':
    case '==':
    case '=':
    case '!=':
    case '<':
    case '>':
    case '=~':
      argv.push(node.text)
      return null
    case 'regex':
    case 'extglob_pattern':
      // `=~` 或 `==/!=` 的 `[[ ]]` 右侧。仅为模式文本——无代码执行。
      // 解析器将这些作为叶子节点输出，无子节点（模式内的 $(...) 或 ${...}
      // 是兄弟节点，不是子节点，会被单独遍历）。
      argv.push(node.text)
      return null
    default: {
      // 操作数——word、string、number 等，通过 walkArgument 验证
      const arg = walkArgument(node, innerCommands, varScope)
      if (typeof arg !== 'string') return arg
      argv.push(arg)
      return null
    }
  }
}

/**
 * `redirected_statement` 节点将一个命令（或管道）与一个或多个
 * `file_redirect`/`heredoc_redirect` 节点包裹在一起。
 * 提取重定向，遍历内层命令，并将重定向附加到最后一个命令
 * （即其输出被重定向的命令）。
 *
 * @param node redirected_statement AST 节点
 * @param commands 收集到的命令列表（就地追加）
 * @param varScope 当前变量作用域
 */
function walkRedirectedStatement(
  node: Node,
  commands: SimpleCommand[],
  varScope: Map<string, string>,
): ParseForSecurityResult | null {
  const redirects: Redirect[] = []
  let innerCommand: Node | null = null

  for (const child of node.children) {
    if (!child) continue
    if (child.type === 'file_redirect') {
      // 传入 `commands` 以便重定向目标中的 $()（如 `> $(mktemp)`）
      // 可以提取内层命令进行权限检查
      const r = walkFileRedirect(child, commands, varScope)
      if ('kind' in r) return r
      redirects.push(r)
    } else if (child.type === 'heredoc_redirect') {
      const r = walkHeredocRedirect(child)
      if (r) return r
    } else if (
      child.type === 'command' ||
      child.type === 'pipeline' ||
      child.type === 'list' ||
      child.type === 'negated_command' ||
      child.type === 'declaration_command' ||
      child.type === 'unset_command'
    ) {
      innerCommand = child
    } else {
      return tooComplex(child)
    }
  }

  if (!innerCommand) {
    // `> file` 单独使用在 bash 中合法（清空文件）。
    // 以空 argv 表示为命令，以便下游能看到这次写入操作。
    commands.push({ argv: [], envVars: [], redirects, text: node.text })
    return null
  }

  const before = commands.length
  const err = collectCommands(innerCommand, commands, varScope)
  if (err) return err
  if (commands.length > before && redirects.length > 0) {
    const last = commands[commands.length - 1]
    if (last) last.redirects.push(...redirects)
  }
  return null
}

/**
 * 从 `file_redirect` 节点提取运算符和目标。目标必须是静态单词或字符串。
 *
 * @param node file_redirect AST 节点
 * @param innerCommands 内层命令累加器（用于传递 $() 提取）
 * @param varScope 当前变量作用域
 * @returns 重定向对象或 too-complex 错误
 */
function walkFileRedirect(
  node: Node,
  innerCommands: SimpleCommand[],
  varScope: Map<string, string>,
): Redirect | ParseForSecurityResult {
  let op: Redirect['op'] | null = null
  let target: string | null = null
  let fd: number | undefined

  for (const child of node.children) {
    if (!child) continue
    if (child.type === 'file_descriptor') {
      fd = Number(child.text)
    } else if (child.type in REDIRECT_OPS) {
      op = REDIRECT_OPS[child.type] ?? null
    } else if (child.type === 'word' || child.type === 'number') {
      // 安全说明：`number` 节点可能通过 `NN#<expansion>` 算术进制语法包含扩展子节点——
      // 与 walkArgument 的 number 情形相同。`> 10#$(cmd)` 在运行时会执行 cmd。
      // 普通 word/number 节点没有子节点。
      if (child.children.length > 0) return tooComplex(child)
      // 与 walkArgument（约第 608 行）的对称性：`echo foo > {a,b}` 在 bash 中是
      // 模糊的重定向。tree-sitter 实际上将花括号目标解析为 `concatenation` 节点
      // （被下方 default 分支捕获），但也对 `word` 文本进行纵深防御检查。
      if (BRACE_EXPANSION_RE.test(child.text)) return tooComplex(child)
      // 对反斜杠序列做反转义——与 walkArgument 相同。bash 引号去除将 `\X` → `X`。
      // 不做此处理时，`cat < /proc/self/\environ` 目标为 `/proc/self/\environ`，
      // 能绕过 PROC_ENVIRON_RE，但 bash 实际读取的是 /proc/self/environ。
      target = child.text.replace(/\\(.)/g, '$1')
    } else if (child.type === 'raw_string') {
      target = stripRawString(child.text)
    } else if (child.type === 'string') {
      const s = walkString(child, innerCommands, varScope)
      if (typeof s !== 'string') return s
      target = s
    } else if (child.type === 'concatenation') {
      // `echo > "foo"bar` — tree-sitter 将字符串+word 的混合体解析为 concatenation 节点。
      // walkArgument 已处理 concatenation：拒绝展开、检查花括号语法，并拼接返回文本。
      const s = walkArgument(child, innerCommands, varScope)
      if (typeof s !== 'string') return s
      target = s
    } else {
      return tooComplex(child)
    }
  }

  // 运算符或目标缺失时，返回 too-complex（例如仅有 fd 的不完整重定向语法）
  if (!op || target === null) {
    return {
      kind: 'too-complex',
      reason: 'Unrecognized redirect shape',
      nodeType: node.type,
    }
  }
  return { op, target, fd }
}

/**
 * 处理 heredoc 重定向节点（`<<'EOF'...EOF`）。
 * 仅允许带引号定界符的 heredoc（`<<'EOF'`）——其主体为纯字面文本，无 shell 展开。
 * 不带引号的定界符（`<<EOF`）会对主体进行完整的参数/命令/算术展开，必须拒绝。
 *
 * 安全说明：tree-sitter-bash 存在语法缺陷——不带引号 heredoc 主体中的反引号（`` `...` ``）
 * 不会被解析为 command_substitution 节点（body.children 为空，反引号仅出现在 body.text 中）。
 * 但 bash 实际上会执行这些反引号。因此无法通过检查子节点是否含展开节点来放宽
 * 对不带引号 heredoc 的限制——这样会漏掉反引号替换。
 * 始终拒绝所有不带引号的 heredoc；用户应使用 `<<'EOF'` 获得纯字面主体。
 */
function walkHeredocRedirect(node: Node): ParseForSecurityResult | null {
  let startText: string | null = null
  let body: Node | null = null

  for (const child of node.children) {
    if (!child) continue
    if (child.type === 'heredoc_start') startText = child.text
    else if (child.type === 'heredoc_body') body = child
    else if (
      child.type === '<<' ||
      child.type === '<<-' ||
      child.type === 'heredoc_end' ||
      child.type === 'file_descriptor'
    ) {
      // 预期的结构性令牌——可安全跳过。file_descriptor 覆盖 fd 前缀 heredoc
      // （如 `cat 3<<'EOF'`）——walkFileRedirect 已将其视为无害的结构令牌。
    } else {
      // 安全说明：tree-sitter 会将同一行中跟在定界符后的 pipeline/command/file_redirect/&&
      // 等作为 heredoc_redirect 的子节点（如 `ls <<'EOF' | rm x`）。
      // 此前这些子节点被静默跳过，导致管道命令对权限检查不可见。
      // 与所有其他 walker 一致，采用失败关闭策略。
      return tooComplex(child)
    }
  }

  // 判断定界符是否带引号：单引号包裹、双引号包裹或以反斜杠开头（`\EOF`）
  const isQuoted =
    startText !== null &&
    ((startText.startsWith("'") && startText.endsWith("'")) ||
      (startText.startsWith('"') && startText.endsWith('"')) ||
      startText.startsWith('\\'))

  // 不带引号的 heredoc 主体会被 bash 展开——拒绝
  if (!isQuoted) {
    return {
      kind: 'too-complex',
      reason: 'Heredoc with unquoted delimiter undergoes shell expansion',
      nodeType: 'heredoc_redirect',
    }
  }

  // 带引号定界符的 heredoc：主体子节点必须全为 heredoc_content（纯文本），否则拒绝
  if (body) {
    for (const child of body.children) {
      if (!child) continue
      if (child.type !== 'heredoc_content') {
        return tooComplex(child)
      }
    }
  }
  return null
}

/**
 * 处理 here-string 重定向（`<<< content`）。
 * 内容作为 stdin 传入——不是 argv，也不是路径。
 * 内容为字面 word、raw_string 或无展开的 string 时安全；
 * 含有 `$()`/`${}`/`$VAR` 时必须拒绝——这些会执行任意代码或注入运行时值。
 *
 * 复用 walkArgument 验证内容：它会拒绝 command_substitution、expansion，
 * 以及（对于 string）无法静态解析的 simple_expansion。
 * 返回的字符串被丢弃——这里只关心其是否可静态解析。
 *
 * 注意：`VAR=$(cmd) && cat <<< "$VAR"` 在原理上是安全的（内部 cmd 已被
 * 单独提取，here-string 内容为 stdin）。但目前被保守地拒绝——walkString 的
 * solo-placeholder 守卫会触发，因为它不了解 here-string 与 argv 的上下文区别。
 */
function walkHerestringRedirect(
  node: Node,
  innerCommands: SimpleCommand[],
  varScope: Map<string, string>,
): ParseForSecurityResult | null {
  for (const child of node.children) {
    if (!child) continue
    if (child.type === '<<<') continue
    // 内容节点：复用 walkArgument 验证。成功时返回字符串（被丢弃——内容为 stdin，
    // 与权限检查无关），失败时（发现展开或无法解析的变量）返回 too-complex。
    const content = walkArgument(child, innerCommands, varScope)
    if (typeof content !== 'string') return content
    // here-string 内容被丢弃（不出现在 argv/envVars/redirects 中），但仍通过
    // 原始 node.text 保留在 .text 中。此处扫描以确保 checkSemantics 的
    // NEWLINE_HASH 不变式（bashPermissions.ts 依赖此约束）仍然成立。
    if (NEWLINE_HASH_RE.test(content)) return tooComplex(child)
  }
  return null
}
  node: Node,
  innerCommands: SimpleCommand[],
  varScope: Map<string, string>,
): ParseForSecurityResult | null {
  for (const child of node.children) {
    if (!child) continue
    if (child.type === '<<<') continue
    // 内容节点：复用 walkArgument 验证。成功时返回字符串（被丢弃——内容为 stdin，
    // 与权限检查无关），失败时（发现展开或无法解析的变量）返回 too-complex。
    const content = walkArgument(child, innerCommands, varScope)
    if (typeof content !== 'string') return content
    // here-string 内容被丢弃（不出现在 argv/envVars/redirects 中），但仍通过
    // 原始 node.text 保留在 .text 中。此处扫描以确保 checkSemantics 的
    // NEWLINE_HASH 不变式（bashPermissions.ts 依赖此约束）仍然成立。
    if (NEWLINE_HASH_RE.test(content)) return tooComplex(child)
  }
  return null
}

/**
 * 遍历 `command` 节点并提取 argv。子节点顺序为：
 * [variable_assignment...] command_name [argument...] [file_redirect...]
 * 任何未被显式处理的子节点类型均触发 too-complex。
 */
function walkCommand(
  node: Node,
  extraRedirects: Redirect[],
  innerCommands: SimpleCommand[],
  varScope: Map<string, string>,
): ParseForSecurityResult {
  const argv: string[] = []
  const envVars: { name: string; value: string }[] = []
  const redirects: Redirect[] = [...extraRedirects]

  for (const child of node.children) {
    if (!child) continue

    switch (child.type) {
      case 'variable_assignment': {
        const ev = walkVariableAssignment(child, innerCommands, varScope)
        if ('kind' in ev) return ev
        // 安全说明：环境变量前缀赋值（`VAR=x cmd`）在 bash 中仅对当前命令可见，
        // 不影响后续命令。不应写入全局 varScope——否则 `VAR=safe cmd1 && rm $VAR`
        // 会错误解析 $VAR（bash 已将其清除）。
        envVars.push({ name: ev.name, value: ev.value })
        break
      }
      case 'command_name': {
        const arg = walkArgument(
          child.children[0] ?? child,
          innerCommands,
          varScope,
        )
        if (typeof arg !== 'string') return arg
        argv.push(arg)
        break
      }
      case 'word':
      case 'number':
      case 'raw_string':
      case 'string':
      case 'concatenation':
      case 'arithmetic_expansion': {
        const arg = walkArgument(child, innerCommands, varScope)
        if (typeof arg !== 'string') return arg
        argv.push(arg)
        break
      }
      // 注意：裸参数位置的 command_substitution（非字符串内部）在此处有意不处理——
      // `$()` 的输出就是该参数本身，对于路径敏感命令（cd、rm、chmod）占位符
      // 会对下游检查隐藏真实路径。`cd $(echo /etc)` 必须保持 too-complex，
      // 防止路径检查被绕过。`$()` 在字符串内部（如 "Timer: $(date)"）
      // 由 walkString 处理，其输出嵌入在较长字符串中（相对更安全）。
      case 'simple_expansion': {
        // 裸 `$VAR` 作为参数。已追踪的静态变量返回实际值（如 VAR=/etc → '/etc'）。
        // 含有 IFS/glob 字符或占位符的值则拒绝。详见 resolveSimpleExpansion。
        const v = resolveSimpleExpansion(child, varScope, false)
        if (typeof v !== 'string') return v
        argv.push(v)
        break
      }
      case 'file_redirect': {
        const r = walkFileRedirect(child, innerCommands, varScope)
        if ('kind' in r) return r
        redirects.push(r)
        break
      }
      case 'herestring_redirect': {
        // `cmd <<< "content"` — 内容作为 stdin 传入，不是 argv。
        // 验证内容为字面量（无展开）；丢弃内容字符串本身。
        const err = walkHerestringRedirect(child, innerCommands, varScope)
        if (err) return err
        break
      }
      default:
        return tooComplex(child)
    }
  }

  // .text 为原始源码片段。下游（bashToolCheckPermission → splitCommand_DEPRECATED）
  // 通过 shell-quote 对其重新分词。通常 .text 保持不变——但若将 $VAR 解析为 argv，
  // .text 会产生偏差（包含原始 `$VAR`），导致下游规则匹配遗漏拒绝规则。
  //
  // 安全说明：`SUB=push && git $SUB --force` 配合 `Bash(git push:*)` 拒绝规则：
  //   argv = ['git', 'push', '--force']  ← 正确，路径验证能看到 'push'
  //   .text = 'git $SUB --force'         ← 拒绝规则 'git push:*' 无法前缀匹配
  //
  // 检测方案：node.text 中的 `$<identifier>` 表示存在 simple_expansion 被解析
  // （否则会返回 too-complex）。`$(...)` 不匹配（括号不是标识符起始）。
  // 单引号中的 `'$VAR'`：tree-sitter 的 .text 包含引号，朴素检查会误报；
  // 但单引号内 $ 在 bash 中是字面量——argv 已含字面 `$VAR`，重建后结果相同，
  // 不会导致规则匹配错误。
  //
  // 从 argv 重建 .text：对每个参数做 shell 转义（单引号包裹，嵌入单引号用 `'\''`）。
  // 空字符串、元字符、占位符均被引号包裹。下游 shell-quote 重新解析时结果正确。
  //
  // 注意：此处不在重建后的 .text 中包含 redirects/envVars——
  // walkFileRedirect 拒绝 simple_expansion，envVars 不参与规则匹配。
  // 若二者发生改变，此重建逻辑必须同步更新。
  //
  // 安全说明：node.text 包含换行符时也需重建。行延续符 `<space>\<LF>` 对 argv
  // 不可见（tree-sitter 折叠处理），但在 node.text 中保留。
  // `timeout 5 \<LF>curl evil.com` → argv 正确，但原始 .text → stripSafeWrappers
  // 匹配 `timeout 5 `（空格在 \ 前），剩余 `\<LF>curl evil.com` 导致 Bash(curl:*)
  // 前缀匹配失败。重建后 .text 以空格连接 argv，无换行，stripSafeWrappers 正常工作。
  // 同时覆盖 heredoc 主体泄漏的情形。
  const text =
    /\$[A-Za-z_]/.test(node.text) || node.text.includes('\n')
      ? argv
          .map(a =>
            a === '' || /["'\\ \t\n$`;|&<>(){}*?[\]~#]/.test(a)
              ? `'${a.replace(/'/g, "'\\''")}'`
              : a,
          )
          .join(' ')
      : node.text
  return {
    kind: 'simple',
    commands: [{ argv, envVars, redirects, text }],
  }
}

/**
 * 递归处理 command_substitution 节点的内部命令。若内部命令解析为简单命令，
 * 将其加入 innerCommands 累加器并返回 null（成功）。
 * 若内部命令本身 too-complex（如嵌套算术展开、进程替换），则返回错误。
 * 此机制实现递归权限检查：`echo $(git rev-parse HEAD)` 同时提取
 * 外层 `echo $(git rev-parse HEAD)` 和内层 `git rev-parse HEAD`，
 * 权限规则必须匹配两者整体才允许执行。
 */
function collectCommandSubstitution(
  csNode: Node,
  innerCommands: SimpleCommand[],
  varScope: Map<string, string>,
): ParseForSecurityResult | null {
  // `$()` 之前设置的变量在内部可见（bash 子 shell 语义），
  // 但内部的赋值不会外泄。传入外部作用域的副本，防止内部赋值修改外部 map。
  const innerScope = new Map(varScope)
  // command_substitution 的子节点：`$(` 或 `` ` ``、内部语句、`)`
  for (const child of csNode.children) {
    if (!child) continue
    if (child.type === '$(' || child.type === '`' || child.type === ')') {
      continue
    }
    const err = collectCommands(child, innerCommands, innerScope)
    if (err) return err
  }
  return null
}

/**
 * 将参数节点转换为字面字符串值，同时解析引号。
 * 本函数实现参数位置的允许列表。
 */
function walkArgument(
  node: Node | null,
  innerCommands: SimpleCommand[],
  varScope: Map<string, string>,
): string | ParseForSecurityResult {
  if (!node) {
    return { kind: 'too-complex', reason: 'Null argument node' }
  }

  switch (node.type) {
    case 'word': {
      // 反转义反斜杠序列。在非引号上下文中，bash 的引号删除将 `\X` → `X`（X 为任意字符）。
      // tree-sitter 保留原始文本。此处处理是为了让 checkSemantics 正确工作：
      // `\eval` 需要匹配 EVAL_LIKE_BUILTINS，`\zmodload` 需要匹配 ZSH_DANGEROUS_BUILTINS。
      // 同时也让 argv 更准确：`find -exec {} \;` → argv 中是 `;` 而非 `\;`。
      // （拒绝规则对 .text 的匹配通过下游 splitCommand_DEPRECATED 反转义已能正常工作——
      // 见 walkCommand 注释。）`\<whitespace>` 已被 BACKSLASH_WHITESPACE_RE 拒绝。
      if (BRACE_EXPANSION_RE.test(node.text)) {
        return {
          kind: 'too-complex',
          reason: 'Word contains brace expansion syntax',
          nodeType: 'word',
        }
      }
      return node.text.replace(/\\(.)/g, '$1')
    }

    case 'number':
      // 安全说明：tree-sitter-bash 将 `NN#<expansion>`（算术进制语法）解析为
      // `number` 节点，并将展开内容作为其子节点。`10#$(cmd)` 是一个 number 节点，
      // 其 .text 为完整字面文本，但子节点为 command_substitution——bash 会执行该替换。
      // 含子节点的 .text 会把展开偷渡过权限检查。纯数字（`10`、`16#ff`）的子节点为零个。
      if (node.children.length > 0) {
        return {
          kind: 'too-complex',
          reason: 'Number node contains expansion (NN# arithmetic base syntax)',
          nodeType: node.children[0]?.type,
        }
      }
      return node.text

    case 'raw_string':
      return stripRawString(node.text)

    case 'string':
      return walkString(node, innerCommands, varScope)

    case 'concatenation': {
      // 先检查整体文本是否含有花括号展开（`{a,b}` 等），防止花括号展开混淆规则匹配
      if (BRACE_EXPANSION_RE.test(node.text)) {
        return {
          kind: 'too-complex',
          reason: 'Brace expansion',
          nodeType: 'concatenation',
        }
      }
      let result = ''
      // 递归处理每个子节点，拼接各部分的字面值
      for (const child of node.children) {
        if (!child) continue
        const part = walkArgument(child, innerCommands, varScope)
        if (typeof part !== 'string') return part
        result += part
      }
      return result
    }

    case 'arithmetic_expansion': {
      const err = walkArithmetic(node)
      if (err) return err
      return node.text
    }

    case 'simple_expansion': {
      // 在 concatenation 内部的 `$VAR`（如 `prefix$VAR`）。
      // 规则与 walkCommand 中的裸参数情形相同：必须已追踪或属于 SAFE_ENV_VARS。
      // concatenation 内部等同于裸参数（整个 concatenation 就是该参数）
      return resolveSimpleExpansion(node, varScope, false)
    }

    // 注意：参数位置的 command_substitution（裸或 concatenation 内部）有意不处理——
    // 其输出是/成为位置参数的一部分，可能是路径或 flag。
    // `rm $(foo)` 或 `rm $(foo)bar` 会用占位符掩盖真实路径。
    // 只有 `string` 节点内的 `$()`（walkString）才会被提取，因为其输出嵌入在更长的
    // 字符串中，而非直接作为参数本身。

    default:
      return tooComplex(node)
  }
}

/**
 * 从双引号字符串节点提取字面内容。`string` 节点的子节点包括 `"` 定界符、
 * `string_content` 字面量，以及可能存在的展开节点。
 *
 * tree-sitter 特殊行为：双引号内的字面换行符不会出现在 `string_content` 节点的文本中。
 * bash 保留这些换行符。对于 `"a\nb"`，tree-sitter 生成两个 `string_content` 子节点
 * （`"a"`、`"b"`），换行符不在其中任何一个里。对于 `"\n#"`，只生成一个子节点（`"#"`），
 * 开头的换行符被丢弃。直接拼接子节点会丢失换行符。
 *
 * 修复方案：追踪子节点的 `startIndex`，在索引间隙处插入对应数量的 `\n`。
 * 间隙就是被丢弃的换行符。这使 argv 的值与 bash 实际接收到的值匹配。
 */
function walkString(
  node: Node,
  innerCommands: SimpleCommand[],
  varScope: Map<string, string>,
): string | ParseForSecurityResult {
  let result = ''
  let cursor = -1
  // 安全说明：追踪字符串中是否出现运行时未知的占位符（`$()` 输出或未知值的已追踪变量）
  // 与任何字面内容。仅为占位符的字符串（`"$(cmd)"`、`"$VAR"` 且 VAR 持有未知哨兵值）
  // 会生成一个 argv 元素，其值 IS 占位符——下游路径验证将其解析为 cwd 相对路径，
  // 从而绕过检查。`cd "$(echo /etc)"` 通过验证但运行时会 cd 到 /etc。
  // 因此拒绝 solo-占位符字符串；占位符与字面内容混合（`"prefix: $(cmd)"`）则安全——
  // 运行时值不可能等于纯路径。
  let sawDynamicPlaceholder = false
  let sawLiteralContent = false
  for (const child of node.children) {
    if (!child) continue
    // 当前子节点与上一个之间的索引间隙 = 被丢弃的换行符。
    // 忽略第一个非定界符子节点之前的间隙（cursor === -1）。
    // 跳过 `"` 定界符的间隙填充：开头的 `"` 之后的间隙是 tree-sitter 仅含空白字符串的特殊情形
    // （空格/制表符，而非换行）——让下方的修复 C 检查将其标记为 too-complex，
    // 而非用 `\n` 错误填充导致与 bash 行为不符。
    if (cursor !== -1 && child.startIndex > cursor && child.type !== '"') {
      result += '\n'.repeat(child.startIndex - cursor)
      sawLiteralContent = true
    }
    cursor = child.endIndex
    switch (child.type) {
      case '"':
        // 记录开头引号结束后的 cursor，以捕获 `"` 与第一个内容子节点之间的间隙
        cursor = child.endIndex
        break
      case 'string_content':
        // bash 双引号转义规则（非 walkArgument 中对非引号 word 使用的通用 /\\(.)/g）：
        // 在 "..." 内，反斜杠仅转义 $ ` " \——其他序列如 \n 保持字面量。
        // `"fix \"bug\""` → `fix "bug"`，但 `"a\nb"` → `a\nb`（反斜杠保留）。
        // tree-sitter 在 .text 中保留原始转义；此处解析使 argv 与 bash 实际传入的值匹配。
        result += child.text.replace(/\\([$`"\\])/g, '$1')
        sawLiteralContent = true
        break
      case DOLLAR:
        // 在结尾引号之前或非名称字符之前的裸美元符号在 bash 中是字面量。
        // tree-sitter 将其作为独立节点输出。
        result += DOLLAR
        sawLiteralContent = true
        break
      case 'command_substitution': {
        // 特殊情形：`$(cat <<'EOF' ... EOF)` 是安全的。带引号定界符的 heredoc 主体
        // 为字面量（无展开），`cat` 只是打印它。替换结果因此是已知的静态字符串。
        // 此模式是向 `gh pr create --body` 等工具传递多行内容的惯用方式。
        // 用占位符 argv 值替换该替换——权限检查不关心实际内容，只关心其是否静态。
        const heredocBody = extractSafeCatHeredoc(child)
        if (heredocBody === 'DANGEROUS') return tooComplex(child)
        if (heredocBody !== null) {
          // 安全说明：主体 IS 替换结果。此前我们丢弃它 → `rm "$(cat <<'EOF'\n/etc/passwd\nEOF)"`
          // 产生 argv ['rm','']，而 bash 运行 `rm /etc/passwd`。validatePath('')
          // 解析为 cwd → 被允许。每个路径约束命令都可通过此方式绕过。
          // 现在：追加主体（末尾 LF 去除——bash `$()` 去除尾部换行）。
          //
          // 权衡：含内部换行的主体为多行文本（markdown、脚本），不可能是有效路径——
          // 安全地丢弃以避免 NEWLINE_HASH_RE 对 `## Summary` 产生误报。
          // 单行主体（如 `/etc/passwd`）必须进入 argv，使下游路径验证看到真实目标。
          const trimmed = heredocBody.replace(/\n+$/, '')
          if (trimmed.includes('\n')) {
            sawLiteralContent = true
            break
          }
          result += trimmed
          sawLiteralContent = true
          break
        }
        // 一般 `"..."` 内的 `$()`：递归处理内部命令。若解析成功，内部命令成为
        // 权限系统必须匹配规则的额外子命令。外层 argv 以原始 `$()` 文本作为占位符。
        // `echo "SHA: $(git rev-parse HEAD)"` → 同时提取
        // `echo "SHA: $(...)"` 和 `git rev-parse HEAD`——两者均须匹配权限规则。
        // 约占 ant 前 5k 命令中 too-complex 的 27%。
        const err = collectCommandSubstitution(child, innerCommands, varScope)
        if (err) return err
        result += CMDSUB_PLACEHOLDER
        sawDynamicPlaceholder = true
        break
      }
      case 'simple_expansion': {
        // `"..."` 内的 `$VAR`。已追踪/安全的变量解析；未追踪的拒绝。
        const v = resolveSimpleExpansion(child, varScope, true)
        if (typeof v !== 'string') return v
        // VAR_PLACEHOLDER = 运行时未知（循环变量、read 变量、`$()` 输出、
        // SAFE_ENV_VARS、特殊变量）。其他字符串 = 来自已追踪静态变量的实际字面值
        // （如 VAR=/tmp → v='/tmp'）。
        if (v === VAR_PLACEHOLDER) sawDynamicPlaceholder = true
        else sawLiteralContent = true
        result += v
        break
      }
      case 'arithmetic_expansion': {
        const err = walkArithmetic(child)
        if (err) return err
        result += child.text
        // 已验证为纯字面数值——属于静态内容
        sawLiteralContent = true
        break
      }
      default:
        // `"..."` 内的 expansion（`${...}`）
        return tooComplex(child)
    }
  }
  // 安全说明：拒绝 solo-占位符字符串。`"$(cmd)"` 或 `"$VAR"`（VAR 持有未知值）
  // 会产生一个 argv 元素，其值 IS 占位符——从而绕过下游路径验证（validatePath
  // 将占位符解析为 cwd 相对文件名）。只允许占位符嵌入在字面内容中（`"prefix: $(cmd)"`）。
  if (sawDynamicPlaceholder && !sawLiteralContent) {
    return tooComplex(node)
  }
  // 安全说明：tree-sitter-bash 特殊行为——仅含空白字符的双引号字符串（`" "`、`"  "`、`"\t"`）
  // 不产生任何 string_content 子节点；空白字符归属到结尾 `"` 节点的文本中。
  // 我们的循环只从 string_content/展开子节点向 `result` 添加内容，
  // 因此会返回 ""，而 bash 实际看到的是 " "。
  // 检测方案：两个标志均为 false（既无字面内容也无占位符被添加），但源码片段长度大于 2。
  // 真正的 `""` 的 text.length==2。带 V="" 的 `"$V"` 不会触发此分支——
  // simple_expansion 子节点通过 `else` 分支设置了 sawLiteralContent（即便 v 为空）。
  if (!sawLiteralContent && !sawDynamicPlaceholder && node.text.length > 2) {
    return tooComplex(node)
  }
  return result
}

/**
 * 算术展开内部的安全叶子节点：十进制/十六进制/八进制/bash 进制数字字面量，
 * 以及运算符/括号令牌。任何其他叶子节点（尤其是非数字字面量的 variable_name）均拒绝。
 */
const ARITH_LEAF_RE =
  /^(?:[0-9]+|0[xX][0-9a-fA-F]+|[0-9]+#[0-9a-zA-Z]+|[-+*/%^&|~!<>=?:(),]+|<<|>>|\*\*|&&|\|\||[<>=!]=|\$\(\(|\)\))$/

/**
 * 递归验证 arithmetic_expansion 节点，仅允许纯字面数值表达式——
 * 不含变量，不含替换。安全时返回 null，不安全时返回 too-complex。
 *
 * 拒绝变量是因为 bash 算术会递归展开变量值：
 * 若 x='a[$(cmd)]'，则 `$((x))` 会执行 cmd。
 * 参见 https://www.vidarholen.net/contents/blog/?p=716（算术注入）。
 *
 * 验证通过后，调用方将完整的 `$((…))` 片段作为字面字符串放入 argv。
 * bash 在运行时将其展开为整数；静态字符串不会匹配任何敏感路径/拒绝规则。
 */
function walkArithmetic(node: Node): ParseForSecurityResult | null {
  for (const child of node.children) {
    if (!child) continue
    if (child.children.length === 0) {
      // 叶子节点：验证是否为纯字面量（数字、运算符、括号）
      if (!ARITH_LEAF_RE.test(child.text)) {
        return {
          kind: 'too-complex',
          reason: `Arithmetic expansion references variable or non-literal: ${child.text}`,
          nodeType: 'arithmetic_expansion',
        }
      }
      continue
    }
    switch (child.type) {
      case 'binary_expression':
      case 'unary_expression':
      case 'ternary_expression':
      case 'parenthesized_expression': {
        // 递归验证复合算术表达式
        const err = walkArithmetic(child)
        if (err) return err
        break
      }
      default:
        return tooComplex(child)
    }
  }
  return null
}

/**
 * 检查 command_substitution 节点是否恰好为 `$(cat <<'DELIM'...DELIM)`，
 * 若是则返回 heredoc 主体；任何偏差（cat 含额外参数、定界符不带引号、附加命令）返回 null。
 *
 * tree-sitter 节点结构：
 *   command_substitution
 *     $(
 *     redirected_statement
 *       command → command_name → word "cat"    （恰好一个子节点）
 *       heredoc_redirect
 *         <<
 *         heredoc_start 'DELIM'                （带引号）
 *         heredoc_body                         （纯 heredoc_content）
 *         heredoc_end
 *     )
 */
function extractSafeCatHeredoc(subNode: Node): string | 'DANGEROUS' | null {
  // 期望恰好：$( + 一个 redirected_statement + )
  let stmt: Node | null = null
  for (const child of subNode.children) {
    if (!child) continue
    if (child.type === '$(' || child.type === ')') continue
    if (child.type === 'redirected_statement' && stmt === null) {
      stmt = child
    } else {
      return null
    }
  }
  if (!stmt) return null

  // redirected_statement 必须为：command(cat) + heredoc_redirect（带引号）
  let sawCat = false
  let body: string | null = null
  for (const child of stmt.children) {
    if (!child) continue
    if (child.type === 'command') {
      // 必须是裸 `cat`——无参数，无环境变量
      const cmdChildren = child.children.filter(c => c)
      if (cmdChildren.length !== 1) return null
      const nameNode = cmdChildren[0]
      if (nameNode?.type !== 'command_name' || nameNode.text !== 'cat') {
        return null
      }
      sawCat = true
    } else if (child.type === 'heredoc_redirect') {
      // 复用现有验证器：带引号定界符，主体为纯文本。
      // walkHeredocRedirect 成功时返回 null，拒绝时返回非 null。
      if (walkHeredocRedirect(child) !== null) return null
      for (const hc of child.children) {
        if (hc?.type === 'heredoc_body') body = hc.text
      }
    } else {
      return null
    }
  }

  if (!sawCat || body === null) return null
  // 安全说明：heredoc 主体通过替换成为外层命令的 argv 值，
  // 因此形如 `/proc/self/environ` 的主体在语义上等同于 `cat /proc/self/environ`。
  // checkSemantics 不会看到主体（在 walkString 调用点被丢弃以避免换行+# 误报）。
  // 在此返回 `null` 会导致 walkString 中降级到 collectCommandSubstitution，
  // 后者通过 walkHeredocRedirect 提取内层 `cat`（主体文本不被检查）——
  // 相当于绕过了此检查。因此返回独特的哨兵值，使调用方拒绝而非降级处理。
  if (PROC_ENVIRON_RE.test(body)) return 'DANGEROUS'
  // jq system() 同理：checkSemantics 检查 argv 但不会看到 heredoc 主体。
  // 无条件检查（我们不知道外层命令是什么）。
  if (/\bsystem\s*\(/.test(body)) return 'DANGEROUS'
  return body
}

/**
 * 处理变量赋值节点，提取变量名、值和是否为追加赋值（`+=`）。
 * 对多种安全威胁进行防御：无效变量名（被 bash 当作命令执行）、
 * IFS 赋值（改变分词行为）、PS4 赋值（可在 set -x 追踪时执行代码）、
 * 赋值值中的波浪号展开（bash 在赋值时展开 `~`）。
 */
function walkVariableAssignment(
  node: Node,
  innerCommands: SimpleCommand[],
  varScope: Map<string, string>,
): { name: string; value: string; isAppend: boolean } | ParseForSecurityResult {
  let name: string | null = null
  let value = ''
  let isAppend = false

  for (const child of node.children) {
    if (!child) continue
    if (child.type === 'variable_name') {
      name = child.text
    } else if (child.type === '=' || child.type === '+=') {
      // `PATH+=":/new"` — tree-sitter 将 `+=` 作为独立运算符节点输出。
      // 若无此分支，会降级到下方 walkArgument → 因未知类型 `+=` 返回 tooComplex。
      isAppend = child.type === '+='
      continue
    } else if (child.type === 'command_substitution') {
      // `$()` 作为变量值。输出成为存储在变量中的字符串——不是位置参数（无路径/flag 顾虑）。
      // `VAR=$(date)` 执行 `date` 并存储输出。`VAR=$(rm -rf /)` 执行 `rm`——
      // 内部命令会被权限规则检查，所以 `rm` 必须匹配规则。变量只是持有 `rm` 打印的内容。
      const err = collectCommandSubstitution(child, innerCommands, varScope)
      if (err) return err
      value = CMDSUB_PLACEHOLDER
    } else if (child.type === 'simple_expansion') {
      // `VAR=$OTHER` — 赋值 RHS 在 bash 中不进行分词或 glob 展开
      // （与命令参数不同）。`A="a b"; B=$A` 将 B 设为字面量 "a b"。
      // 以 insideString=true 解析，避免 BARE_VAR_UNSAFE_RE 过度拒绝。
      // 结果值可能含空格/glob——若 B 后来被用作裸参数，THAT 处的使用
      // 会通过 BARE_VAR_UNSAFE_RE 正确拒绝。
      const v = resolveSimpleExpansion(child, varScope, true)
      if (typeof v !== 'string') return v
      // 若 v 为 VAR_PLACEHOLDER（OTHER 持有未知值），存储它——
      // 结合调用方的 containsAnyPlaceholder 将其视为未知。
      value = v
    } else {
      const v = walkArgument(child, innerCommands, varScope)
      if (typeof v !== 'string') return v
      value = v
    }
  }

  if (name === null) {
    return {
      kind: 'too-complex',
      reason: 'Variable assignment without name',
      nodeType: 'variable_assignment',
    }
  }
  // 安全说明：tree-sitter-bash 接受无效变量名（如 `1VAR=value`）作为 variable_assignment。
  // bash 只识别 [A-Za-z_][A-Za-z0-9_]*——其他格式被作为命令执行。
  // `1VAR=value` → bash 尝试从 PATH 执行 `1VAR=value`。不得将其视为无害赋值。
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    return {
      kind: 'too-complex',
      reason: `Invalid variable name (bash treats as command): ${name}`,
      nodeType: 'variable_assignment',
    }
  }
  // 安全说明：设置 IFS 会改变后续非引号 $VAR 展开的分词行为。
  // `IFS=: && VAR=a:b && rm $VAR` → bash 按 `:` 分词 → `rm a b`。
  // 我们的 BARE_VAR_UNSAFE_RE 仅检查默认 IFS 字符（空格/制表符/换行）——
  // 无法对自定义 IFS 建模。拒绝。
  if (name === 'IFS') {
    return {
      kind: 'too-complex',
      reason: 'IFS assignment changes word-splitting — cannot model statically',
      nodeType: 'variable_assignment',
    }
  }
  // 安全说明：PS4 通过 promptvars（默认启用）在 `set -x` 追踪的每条命令上展开。
  // 包含 `$(cmd)` 或 `` `cmd` `` 的原始字符串值在追踪时执行：
  // `PS4='$(id)' && set -x && :` 运行 id，但我们的 argv 只有 [["set","-x"],["："]]——
  // 载荷对权限检查不可见。PS0-3 和 PROMPT_COMMAND 在非交互式 shell（BashTool）中不展开。
  //
  // 使用允许列表，而非拒绝列表。5 轮补丁修复经验表明，基于值的拒绝列表在结构上脆弱：
  //   - `+=` 有效值计算与 bash 在多个作用域模型缺口处存在分歧：`||` 重置、
  //     env 前缀链（`PS4='' && PS4='$' PS4+='(id)' cmd` 读取父作用域的旧值）、子 shell。
  //   - bash 的 decode_prompt_string 在 promptvars 之前运行，因此 `\044(id)`
  //     （`$` 的八进制）在追踪时变成 `$(id)`——任何字面字符检查都必须精确模拟提示转义解码。
  //   - 赋值路径存在于 walkVariableAssignment 之外（for_statement 直接设置 loopVar，
  //     见该处理器的 PS4 检查）。
  //
  // 策略：(1) 彻底拒绝 `+=`——无作用域追踪依赖；用户可合并为一条 PS4=...；
  // (2) 拒绝占位符——运行时不可知；(3) 对剩余值允许列表：
  // ${identifier} 引用（仅值读取，安全）及 [A-Za-z0-9 _+:.\/=[\]-]。
  // 不允许裸 `$`（阻断分裂原语）、不允许 `\`（阻断八进制 \044/\140）、
  // 不允许反引号、不允许括号。覆盖所有已知编码向量及未来可能出现的向量——
  // 超出允许列表的任何字符均失败。合法的 `PS4='+${BASH_SOURCE}:${LINENO}: '` 仍可通过。
  if (name === 'PS4') {
    if (isAppend) {
      return {
        kind: 'too-complex',
        reason:
          'PS4 += cannot be statically verified — combine into a single PS4= assignment',
        nodeType: 'variable_assignment',
      }
    }
    if (containsAnyPlaceholder(value)) {
      return {
        kind: 'too-complex',
        reason: 'PS4 value derived from cmdsub/variable — runtime unknowable',
        nodeType: 'variable_assignment',
      }
    }
    if (
      !/^[A-Za-z0-9 _+:./=[\]-]*$/.test(
        value.replace(/\$\{[A-Za-z_][A-Za-z0-9_]*\}/g, ''),
      )
    ) {
      return {
        kind: 'too-complex',
        reason:
          'PS4 value outside safe charset — only ${VAR} refs and [A-Za-z0-9 _+:.=/[]-] allowed',
        nodeType: 'variable_assignment',
      }
    }
  }
  // 安全说明：赋值 RHS 中的波浪号展开。`VAR=~/x`（非引号）→
  // bash 在赋值时展开 `~` → VAR='/home/user/x'。但我们看到的是字面量 `~/x`。
  // 后续 `cd $VAR` → 我们的 argv `['cd','~/x']`，bash 运行 `cd /home/user/x`。
  // 波浪号展开也在赋值值的 `=` 和 `:` 后发生（如 PATH=~/bin:~/sbin）。
  // 我们无法对其建模——拒绝值中含 `~` 的情形（引号字面量中 bash 不展开，已处理）。
  // 保守策略：值中任何 `~` → 拒绝。
  if (value.includes('~')) {
    return {
      kind: 'too-complex',
      reason: 'Tilde in assignment value — bash may expand at assignment time',
      nodeType: 'variable_assignment',
    }
  }
  return { name, value, isAppend }
}

/**
 * 解析 `simple_expansion`（`$VAR`）节点，返回 VAR_PLACEHOLDER（若可解析）
 * 或 too-complex（若不可解析）。
 *
 * @param insideString 为 true 时，`$VAR` 位于 `string` 节点（`"...$VAR..."`）内，
 *   而非裸参数或 concatenation 参数中。SAFE_ENV_VARS 和持有未知值的已追踪变量
 *   仅允许在字符串内部——作为裸参数时，其运行时值就是该参数，我们无法静态得知。
 *   `cd $HOME/../x` 会用占位符掩盖真实路径；
 *   `echo "Home: $HOME"` 只是在字符串中嵌入文本。
 *   持有静态字面量的已追踪变量（VAR=literal）在两种位置均允许，因为其值已知。
 */
function resolveSimpleExpansion(
  node: Node,
  varScope: Map<string, string>,
  insideString: boolean,
): string | ParseForSecurityResult {
  let varName: string | null = null
  let isSpecial = false
  // 从子节点提取变量名或特殊变量名（`$?`、`$$`、`$@` 等）
  for (const c of node.children) {
    if (c?.type === 'variable_name') {
      varName = c.text
      break
    }
    if (c?.type === 'special_variable_name') {
      varName = c.text
      isSpecial = true
      break
    }
  }
  if (varName === null) return tooComplex(node)
  // 已追踪变量：检查存储的值。字面字符串（如 VAR=/tmp）直接返回，
  // 使下游路径验证看到真实路径。非字面值（含任何占位符——循环变量、$() 输出、
  // read 变量、组合值如 `VAR="prefix$(cmd)"`）仅在字符串内部安全；
  // 作为裸参数会对路径验证隐藏运行时路径/flag。
  //
  // 安全说明：返回实际 trackedValue（而非占位符）是关键修复。
  // `VAR=/etc && rm $VAR` → argv ['rm', '/etc'] → validatePath 正确拒绝。
  // 此前返回占位符 → validatePath 看到 '__LOOP_STATIC__'，解析为 cwd 相对路径 → 通过 → 绕过。
  const trackedValue = varScope.get(varName)
  if (trackedValue !== undefined) {
    if (containsAnyPlaceholder(trackedValue)) {
      // 非字面量：裸参数 → 拒绝，字符串内部 → VAR_PLACEHOLDER
      // （walkString 的 solo-placeholder 守卫拒绝单独的 `"$VAR"`）
      if (!insideString) return tooComplex(node)
      return VAR_PLACEHOLDER
    }
    // 纯字面量（如 '/tmp'、'foo'）——直接返回。下游路径验证/checkSemantics 使用真实值。
    //
    // 安全说明：裸参数（非字符串内部）时，bash 对 $IFS 分词并 glob 展开结果。
    // `VAR="-rf /" && rm $VAR` → bash 运行 `rm -rf /`（两个参数）；
    // `VAR="/etc/*" && cat $VAR` → 展开为所有文件。
    // 拒绝含 IFS/glob 字符的值，除非在 "..." 内。
    //
    // 安全说明：裸参数位置的空值。bash 对 "" 分词后产生零个字段——展开消失。
    // `V="" && $V eval x` → bash 运行 `eval x`（我们的 argv 为 ["","eval","x"]，
    // name="" → 所有 EVAL_LIKE/ZSH/关键字检查均漏掉）。
    // `V="" && ls $V /etc` → bash 运行 `ls /etc`，我们的 argv 有一个虚位移动位置。
    // 在 "..." 内：`"$V"` → bash 产生一个空字符串参数 → 我们的 "" 正确，继续允许。
    if (!insideString) {
      if (trackedValue === '') return tooComplex(node)
      if (BARE_VAR_UNSAFE_RE.test(trackedValue)) return tooComplex(node)
    }
    return trackedValue
  }
  // SAFE_ENV_VARS 及特殊变量（`$?`、`$$`、`$@`、`$1` 等）：值未知
  // （由 shell 控制）。仅在字符串内嵌入时安全，不能作为路径敏感命令的裸参数。
  if (insideString) {
    if (SAFE_ENV_VARS.has(varName)) return VAR_PLACEHOLDER
    if (
      isSpecial &&
      (SPECIAL_VAR_NAMES.has(varName) || /^[0-9]+$/.test(varName))
    ) {
      return VAR_PLACEHOLDER
    }
  }
  return tooComplex(node)
}

/**
 * 将变量赋值应用到作用域，处理 `+=` 追加语义。
 * 安全说明：若现有值或追加值中任一含有占位符，结果为非字面量——
 * 存储 VAR_PLACEHOLDER，使后续 $VAR 作为裸参数时正确拒绝。
 * `VAR=/etc && VAR+=$(cmd)` 不得使 VAR 看起来仍为静态字面量。
 */
function applyVarToScope(
  varScope: Map<string, string>,
  ev: { name: string; value: string; isAppend: boolean },
): void {
  const existing = varScope.get(ev.name) ?? ''
  const combined = ev.isAppend ? existing + ev.value : ev.value
  // 若组合值含任何占位符（运行时未知），存储 VAR_PLACEHOLDER 而非组合字符串
  varScope.set(
    ev.name,
    containsAnyPlaceholder(combined) ? VAR_PLACEHOLDER : combined,
  )
}

/** 去除 raw_string（单引号字符串）的首尾引号，返回字面内容 */
function stripRawString(text: string): string {
  return text.slice(1, -1)
}

/** 根据节点类型生成 too-complex 错误结果，区分解析错误、危险类型和未处理节点 */
function tooComplex(node: Node): ParseForSecurityResult {
  const reason =
    node.type === 'ERROR'
      ? 'Parse error'
      : DANGEROUS_TYPES.has(node.type)
        ? `Contains ${node.type}`
        : `Unhandled node type: ${node.type}`
  return { kind: 'too-complex', reason, nodeType: node.type }
}

// ────────────────────────────────────────────────────────────────────────────
// argv 后语义检查
//
// 以上所有函数回答"能否分词？"。以下回答"分词后的 argv 是否在与解析无关的方面危险？"。
// 这些检查作用于 argv[0] 或 argv 内容，是原 bashSecurity.ts 校验器执行的逻辑，
// 但与解析器差异无关。放在此处（而非 bashSecurity.ts）是因为它们操作 SimpleCommand，
// 且需要对每条提取出的命令执行。
// ────────────────────────────────────────────────────────────────────────────

/**
 * Zsh 模块内置命令。这些不是 PATH 上的二进制文件——它们是通过 zmodload 加载的 zsh 内部模块。
 * 由于 BashTool 通过用户默认 shell（通常为 zsh）运行，且这些命令被解析为普通 `command` 节点
 * 没有任何区分性语法，只能通过名称捕获。
 */
const ZSH_DANGEROUS_BUILTINS = new Set([
  'zmodload',
  'emulate',
  'sysopen',
  'sysread',
  'syswrite',
  'sysseek',
  'zpty',
  'ztcp',
  'zsocket',
  'zf_rm',
  'zf_mv',
  'zf_ln',
  'zf_chmod',
  'zf_chown',
  'zf_mkdir',
  'zf_rmdir',
  'zf_chgrp',
])

/**
 * 将参数作为代码求值或以其他方式突破 argv 抽象的 shell 内置命令。
 * 例如 `eval "rm -rf /"` 的 argv 为 ['eval', 'rm -rf /']，对 flag 验证看似无害，
 * 但实际执行了该字符串。对这些命令采用与命令替换相同的处理方式。
 */
const EVAL_LIKE_BUILTINS = new Set([
  'eval',
  'source',
  '.',
  'exec',
  'command',
  'builtin',
  'fc',
  // `coproc rm -rf /` 以协处理方式生成 rm。tree-sitter 将其解析为
  // argv[0]='coproc' 的普通命令，权限规则和路径验证会检查 'coproc' 而非 'rm'。
  'coproc',
  // Zsh 预命令修饰符：`noglob cmd args` 在关闭 globbing 的情况下运行 cmd。
  // 它们被解析为普通命令（noglob 是 argv[0]，真实命令是 argv[1]），
  // 因此对 argv[0] 的权限匹配会看到 'noglob'，而非被包装的命令。
  'noglob',
  'nocorrect',
  // `trap 'cmd' SIGNAL` — cmd 在信号/退出时作为 shell 代码运行。
  // EXIT 在每次 BashTool 调用结束时触发，因此这保证执行。
  'trap',
  // `enable -f /path/lib.so name` — 以 dlopen 方式加载任意 .so 作为内置。
  // 原生代码执行。
  'enable',
  // `mapfile -C callback -c N` / `readarray -C callback` — 每 N 行输入执行一次 callback（shell 代码）。
  'mapfile',
  'readarray',
  // `hash -p /path cmd` — 毒化 bash 命令查找缓存。同一命令中后续的 `cmd`
  // 解析为 /path 而非 PATH 查找。
  'hash',
  // `bind -x '"key":cmd'` / `complete -C cmd` — 仅交互式回调，
  // 但仍然是代码字符串参数。在非交互式 BashTool shell 中影响有限，
  // 为一致性而阻断。`compgen -C cmd` 不是仅交互式：
  // 它立即执行 -C 参数以生成补全候选。
  'bind',
  'complete',
  'compgen',
  // `alias name='cmd'` — 别名默认不在非交互式 bash 中展开，
  // 但 `shopt -s expand_aliases` 可启用。作为纵深防御也阻断
  // （别名后在同一命令中使用名称）。
  'alias',
  // `let EXPR` 对 EXPR 算术求值——等同于 `$(( EXPR ))`。
  // 即使参数以单引号传入，表达式中的数组下标仍会展开 `$(cmd)`：
  // `let 'x=a[$(id)]'` 执行 id。
  // tree-sitter 将 raw_string 视为不透明叶子节点。与 walkArithmetic 保护相同，
  // 但 `let` 是普通命令节点。
  'let',
])

/**
 * 在内部重新解析 NAME 操作数并对 `arr[EXPR]` 下标进行算术求值的内置命令。
 * 即使 argv 元素来自单引号 raw_string（对 tree-sitter 而言是不透明叶子），
 * bash 仍会对下标中的 `$(cmd)` 求值并执行命令。
 * 例如 `test -v 'a[$(id)]'` → tree-sitter 看到不透明叶子，但 bash 执行了 id。
 * 数据结构：内置命令名 → 其后紧跟 NAME 参数的危险 flag 集合。
 */
const SUBSCRIPT_EVAL_FLAGS: Record<string, Set<string>> = {
  test: new Set(['-v', '-R']),
  '[': new Set(['-v', '-R']),
  '[[': new Set(['-v', '-R']),
  printf: new Set(['-v']),
  read: new Set(['-a']),
  unset: new Set(['-v']),
  // bash 5.1+：`wait -p VAR [id...]` 将等待到的 PID 存入 VAR。
  // 当 VAR 为 `arr[EXPR]` 时，bash 对下标进行算术求值，
  // 即使来自单引号 raw_string 也会执行 $(cmd)。
  // 已在 bash 5.3.9 验证：`: & wait -p 'a[$(id)]' %1` 会执行 id。
  wait: new Set(['-p']),
}

/**
 * `[[ ARG1 OP ARG2 ]]` 中的算术比较运算符。
 * bash 手册："当与 [[ 一起使用时，Arg1 和 Arg2 作为算术表达式求值。"
 * 算术求值会递归展开数组下标，因此即使操作数是单引号 raw_string，
 * `[[ 'a[$(id)]' -eq 0 ]]` 也会执行 id。
 * 与 -v/-R（一元，flag 之后跟 NAME）不同，这些运算符是二元的——
 * 下标可出现在任意一侧，SUBSCRIPT_EVAL_FLAGS 的"下一个参数"逻辑无法覆盖此场景。
 * `[` / `test` 不受影响（bash 会报错"integer expression expected"），
 * 但 test_command 处理器将两种形式的 argv[0] 都规范化为 `[[`，
 * 因此同样会通过此检测——存在轻微过度阻断，但偏安全侧处理。
 */
const TEST_ARITH_CMP_OPS = new Set(['-eq', '-ne', '-lt', '-le', '-gt', '-ge'])

/**
 * 每个非 flag 位置参数均为 NAME 的内置命令——无需特定 flag 即触发下标求值。
 * `read 'a[$(id)]'` 会执行 id：每个位置参数都是赋值目标变量名，
 * `arr[EXPR]` 在此处是合法语法。`unset NAME...` 同理
 * （虽然 tree-sitter 的 unset_command 处理器目前会拒绝 raw_string 子节点，
 * 但本检测作为纵深防御仍保留）。
 * 不包括 printf（位置参数是 FORMAT/data）、test/[（操作数是值，仅 -v/-R 接受 NAME）。
 * declare/typeset/local 在 declaration_command 中处理，不会以普通命令到达这里。
 */
const BARE_SUBSCRIPT_NAME_BUILTINS = new Set(['read', 'unset'])

/**
 * `read` 中下一个参数为数据（提示符/分隔符/字符数/文件描述符）而非 NAME 的 flag。
 * 例如 `read -p '[foo] ' var`：`[` 出现在提示符字符串中，不应触发下标求值检测。
 * `-a` 有意不在此列——其操作数确实是 NAME（数组赋值目标）。
 */
const READ_DATA_FLAGS = new Set(['-p', '-d', '-n', '-N', '-t', '-u', '-i'])

// SHELL_KEYWORDS 从 bashParser.ts 导入——shell 保留字不可能作为合法的 argv[0]；
// 若出现，说明解析器对复合命令解析有误。拒绝以避免无意义的 argv 到达下游。

// 使用 `.*` 而非 `[^/]*`——Linux 会解析 procfs 中的 `..`，
// 因此 `/proc/self/../self/environ` 同样有效，必须被捕获。
const PROC_ENVIRON_RE = /\/proc\/.*\/environ/

/**
 * argv 元素、环境变量值或重定向目标中出现的"换行符后跟 `#`"模式。
 * 下游的 stripSafeWrappers 按行重新分词 .text，并将换行符后的 `#` 视为注释，
 * 从而隐藏其后的参数，绕过路径验证。
 */
const NEWLINE_HASH_RE = /\n[ \t]*#/

export type SemanticCheckResult = { ok: true } | { ok: false; reason: string }

/**
 * argv 后语义检查。在 parseForSecurity 返回 'simple' 后运行，
 * 捕获分词正确但因命令名或参数内容而存在危险的命令。
 * 返回第一个失败原因，或 {ok: true}（全部通过）。
 */
export function checkSemantics(commands: SimpleCommand[]): SemanticCheckResult {
  for (const cmd of commands) {
    // 剥离安全包装命令（nohup、time、timeout N、nice -n N），
    // 以确保 `nohup eval "..."` 和 `timeout 5 jq 'system(...)'`
    // 针对被包装的命令而非包装器本身进行检测。
    // 内联此逻辑以避免与 bashPermissions.ts 产生循环导入。
    let a = cmd.argv
    for (;;) {
      if (a[0] === 'time' || a[0] === 'nohup') {
        a = a.slice(1)
      } else if (a[0] === 'timeout') {
        // `timeout 5`、`timeout 5s`、`timeout 5.5`，以及可选的 GNU flags（在时长之前）。
        // 长格式：--foreground、--kill-after=N、--signal=SIG、--preserve-status。
        // 短格式：-k DUR、-s SIG、-v（融合形式：-k5、-sTERM）。
        // 安全说明（SAST Mar 2026）：之前的循环只跳过 `--long` 格式 flag，
        // 导致 `timeout -k 5 10 eval ...` 以 name='timeout' 跳出，
        // 被包装的 eval 从未被检测。现在处理已知短 flag，
        // 并对任何未识别的 flag 采用失败关闭（fail-closed）策略——
        // 未知 flag 意味着无法定位被包装命令，不能静默跳到 name='timeout'。
        let i = 1
        while (i < a.length) {
          const arg = a[i]!
          if (
            arg === '--foreground' ||
            arg === '--preserve-status' ||
            arg === '--verbose'
          ) {
            i++ // 已知无参数长 flag
          } else if (/^--(?:kill-after|signal)=[A-Za-z0-9_.+-]+$/.test(arg)) {
            i++ // --kill-after=5、--signal=TERM（值与 = 融合）
          } else if (
            (arg === '--kill-after' || arg === '--signal') &&
            a[i + 1] &&
            /^[A-Za-z0-9_.+-]+$/.test(a[i + 1]!)
          ) {
            i += 2 // --kill-after 5、--signal TERM（空格分隔）
          } else if (arg.startsWith('--')) {
            // 未知长 flag，或 --kill-after/--signal 后跟非允许列表值
            // （例如来自 $() 替换的占位符）。采用失败关闭策略。
            return {
              ok: false,
              reason: `timeout with ${arg} flag cannot be statically analyzed`,
            }
          } else if (arg === '-v') {
            i++ // --verbose，无参数
          } else if (
            (arg === '-k' || arg === '-s') &&
            a[i + 1] &&
            /^[A-Za-z0-9_.+-]+$/.test(a[i + 1]!)
          ) {
            i += 2 // -k DURATION / -s SIGNAL——空格分隔值
          } else if (/^-[ks][A-Za-z0-9_.+-]+$/.test(arg)) {
            i++ // 融合形式：-k5、-sTERM
          } else if (arg.startsWith('-')) {
            // 未知 flag 或 -k/-s 后跟非允许列表值——无法定位被包装命令。
            // 拒绝，不跳到 name='timeout'。
            return {
              ok: false,
              reason: `timeout with ${arg} flag cannot be statically analyzed`,
            }
          } else {
            break // 非 flag——应为时长参数
          }
        }
        if (a[i] && /^\d+(?:\.\d+)?[smhd]?$/.test(a[i]!)) {
          a = a.slice(i + 1)
        } else if (a[i]) {
          // 安全说明（PR #21503 第 3 轮）：a[i] 存在但不匹配时长正则。
          // GNU timeout 通过 xstrtod()（libc strtod）解析，接受
          // `.5`、`+5`、`5e-1`、`inf`、`infinity`、十六进制浮点——
          // 均不匹配 `/^\d+(\.\d+)?[smhd]?$/`。实测验证：
          // `timeout .5 echo ok` 可正常运行。
          // 之前此分支 `break`（失败开放），导致
          // `timeout .5 eval "id"` 在 `Bash(timeout:*)` 下留下 name='timeout'，
          // eval 从未被检测。现在采用失败关闭——
          // 与上面的未知 flag 处理一致。
          return {
            ok: false,
            reason: `timeout duration '${a[i]}' cannot be statically analyzed`,
          }
        } else {
          break // 无更多参数——单独的 `timeout`，无实际操作
        }
      } else if (a[0] === 'nice') {
        // `nice cmd`、`nice -n N cmd`、`nice -N cmd`（旧版语法）。
        // 均以较低优先级运行 cmd。argv[0] 检测必须能看到被包装的 cmd。
        if (a[1] === '-n' && a[2] && /^-?\d+$/.test(a[2])) {
          a = a.slice(3)
        } else if (a[1] && /^-\d+$/.test(a[1])) {
          a = a.slice(2) // `nice -10 cmd`
        } else if (a[1] && /[$(`]/.test(a[1])) {
          // 安全说明：walkArgument 对 arithmetic_expansion 返回 node.text，
          // 因此 `nice $((0-5)) jq ...` 的 a[1]='$((0-5))'。
          // bash 将其展开为 '-5'（旧版 nice 语法）并执行 jq；
          // 若此处 slice(1)，name 变为 '$((0-5))'，完全跳过 jq system() 检测。
          // 采用失败关闭——与上面 timeout 时长的失败关闭处理保持一致。
          return {
            ok: false,
            reason: `nice argument '${a[1]}' contains expansion — cannot statically determine wrapped command`,
          }
        } else {
          a = a.slice(1) // 裸 `nice cmd`
        }
      } else if (a[0] === 'env') {
        // `env [VAR=val...] [-i] [-0] [-v] [-u NAME...] cmd args` 运行 cmd。
        // argv[0] 检测必须能看到 cmd，而非 env。仅跳过已知安全形式。
        // 安全说明：-S 将字符串拆分为 argv（类似 mini-shell）——必须拒绝。
        // -C/-P 改变 cwd/PATH——被包装的 cmd 在不同环境运行，拒绝。
        // 任何其他 flag → 拒绝（失败关闭，不跳到 name='env'）。
        let i = 1
        while (i < a.length) {
          const arg = a[i]!
          if (arg.includes('=') && !arg.startsWith('-')) {
            i++ // VAR=val 赋值
          } else if (arg === '-i' || arg === '-0' || arg === '-v') {
            i++ // 无参数的 flag
          } else if (arg === '-u' && a[i + 1]) {
            i += 2 // -u NAME 取消设置；消耗一个参数
          } else if (arg.startsWith('-')) {
            // -S（argv 分割器）、-C（更改 cwd）、-P（更改 PATH）、--anything
            // 或未知 flag。无法建模——拒绝整条命令。
            return {
              ok: false,
              reason: `env with ${arg} flag cannot be statically analyzed`,
            }
          } else {
            break // 被包装的命令
          }
        }
        if (i < a.length) {
          a = a.slice(i)
        } else {
          break // 单独的 `env`（无被包装命令）——无实际操作，name='env'
        }
      } else if (a[0] === 'stdbuf') {
        // `stdbuf -o0 cmd`（融合）、`stdbuf -o 0 cmd`（空格分隔）、
        // 多个 flag（`stdbuf -o0 -eL cmd`）、长格式（`--output=0`）。
        // 安全说明：之前的处理只剥离一个 flag，对未识别的内容执行 slice(2)，
        // 导致 `stdbuf --output 0 eval` → ['0','eval',...] → name='0' 隐藏了 eval。
        // 现在遍历所有已知 flag 形式，对任何未知 flag 采用失败关闭策略。
        let i = 1
        while (i < a.length) {
          const arg = a[i]!
          if (STDBUF_SHORT_SEP_RE.test(arg) && a[i + 1]) {
            i += 2 // -o MODE（空格分隔）
          } else if (STDBUF_SHORT_FUSED_RE.test(arg)) {
            i++ // -o0（融合形式）
          } else if (STDBUF_LONG_RE.test(arg)) {
            i++ // --output=MODE（融合长格式）
          } else if (arg.startsWith('-')) {
            // --output MODE（空格分隔长格式）或未知 flag。
            // GNU stdbuf 长选项使用 `=` 语法，但 getopt_long 也接受空格分隔——
            // 无法安全枚举，拒绝。
            return {
              ok: false,
              reason: `stdbuf with ${arg} flag cannot be statically analyzed`,
            }
          } else {
            break // 被包装的命令
          }
        }
        if (i > 1 && i < a.length) {
          a = a.slice(i)
        } else {
          break // `stdbuf` 无 flag 或无被包装命令——无实际操作
        }
      } else {
        break
      }
    }
    const name = a[0]
    if (name === undefined) continue

    // 安全说明：空命令名。带引号的空字符串（`"" cmd`）无害——
    // bash 尝试执行 "" 并报错"command not found"。
    // 但命令位置的无引号空展开（`V="" && $V cmd`）是一种绕过方式：
    // bash 丢弃空字段并以 `cmd` 作为 argv[0] 运行，
    // 而我们的 name="" 会跳过下面所有内置命令检测。
    // resolveSimpleExpansion 已拒绝 $V 情形；
    // 此处捕获其他任何导致 argv[0] 为空的路径
    // （空值拼接、walkString 空白符特殊行为、未来的 bug）。
    if (name === '') {
      return {
        ok: false,
        reason: 'Empty command name — argv[0] may not reflect what bash runs',
      }
    }

    // 纵深防御：经过变量追踪修复后，argv[0] 不应含有占位符
    // （静态变量返回真实值，未知变量被拒绝）。
    // 但若上游某处 bug 导致占位符漏出，此处予以捕获——
    // 以占位符作为命令名意味着运行时决定命令 → 不安全。
    if (name.includes(CMDSUB_PLACEHOLDER) || name.includes(VAR_PLACEHOLDER)) {
      return {
        ok: false,
        reason: 'Command name is runtime-determined (placeholder argv[0])',
      }
    }

    // argv[0] 以运算符/flag 开头：这是一个片段，不是完整命令。
    // 可能是行续接符泄漏或其他错误。
    if (name.startsWith('-') || name.startsWith('|') || name.startsWith('&')) {
      return {
        ok: false,
        reason: 'Command appears to be an incomplete fragment',
      }
    }

    // 安全说明：在内部重新解析 NAME 操作数的内置命令。
    // bash 对 NAME 位置的 `arr[EXPR]` 进行算术求值，
    // 即使 argv 元素来自单引号 raw_string（tree-sitter 的不透明叶子），
    // 也会执行下标中的 $(cmd)。两种形式：
    // 分离形式（`printf -v NAME`）和融合形式（`printf -vNAME`，getopt 风格）。
    // `printf '[%s]' x` 仍然安全——`[` 在格式字符串中，不在 `-v` 之后。
    const dangerFlags = SUBSCRIPT_EVAL_FLAGS[name]
    if (dangerFlags !== undefined) {
      for (let i = 1; i < a.length; i++) {
        const arg = a[i]!
        // 分离形式：`-v` 后 NAME 在下一个参数中。
        if (dangerFlags.has(arg) && a[i + 1]?.includes('[')) {
          return {
            ok: false,
            reason: `'${name} ${arg}' operand contains array subscript — bash evaluates $(cmd) in subscripts`,
          }
        }
        // 组合短 flag：`-ra` 是 `-r -a` 的 bash 缩写。
        // 检测融合 flag 字符串中是否出现危险 flag 字符。
        // 危险 flag 的 NAME 操作数在下一个参数中。
        if (
          arg.length > 2 &&
          arg[0] === '-' &&
          arg[1] !== '-' &&
          !arg.includes('[')
        ) {
          for (const flag of dangerFlags) {
            if (flag.length === 2 && arg.includes(flag[1]!)) {
              if (a[i + 1]?.includes('[')) {
                return {
                  ok: false,
                  reason: `'${name} ${flag}' (combined in '${arg}') operand contains array subscript — bash evaluates $(cmd) in subscripts`,
                }
              }
            }
          }
        }
        // 融合形式：`-vNAME` 合并为一个参数。仅短选项 flag 支持融合
        // （getopt），因此检测 -v/-a/-R。`[[` 仅使用 test_operator 节点。
        for (const flag of dangerFlags) {
          if (
            flag.length === 2 &&
            arg.startsWith(flag) &&
            arg.length > 2 &&
            arg.includes('[')
          ) {
            return {
              ok: false,
              reason: `'${name} ${flag}' (fused) operand contains array subscript — bash evaluates $(cmd) in subscripts`,
            }
          }
        }
      }
    }

    // 安全说明：`[[ ARG OP ARG ]]` 算术比较。bash 将两个操作数
    // 均作为算术表达式求值，即使来自单引号 raw_string，
    // 也会递归展开 `arr[$(cmd)]` 下标。
    // 检测算术比较运算符两侧的操作数——
    // SUBSCRIPT_EVAL_FLAGS 的"flag 后紧跟参数"模式无法表达"二元运算符两侧"的语义。
    // 字符串比较（==/!=/=~）不触发算术求值——
    // `[[ 'a[x]' == y ]]` 是字面字符串比较。
    if (name === '[[') {
      // i 从 2 开始：a[0]='[['（含 '['），a[1] 是第一个真实操作数。
      // 二元运算符不可能出现在索引 2 之前。
      for (let i = 2; i < a.length; i++) {
        if (!TEST_ARITH_CMP_OPS.has(a[i]!)) continue
        if (a[i - 1]?.includes('[') || a[i + 1]?.includes('[')) {
          return {
            ok: false,
            reason: `'[[ ... ${a[i]} ... ]]' operand contains array subscript — bash arithmetically evaluates $(cmd) in subscripts`,
          }
        }
      }
    }

    // 安全说明：`read`/`unset` 将每个裸位置参数视为 NAME——
    // 无需 flag 触发。`read 'a[$(id)]' <<< data` 执行 id，
    // 即使 argv[1] 来自单引号 raw_string 且没有 -a flag。
    // 与 SUBSCRIPT_EVAL_FLAGS 相同的底层机制，但触发条件是位置，而非 flag 门控。
    // 跳过 read 的数据型 flag 的操作数（如 -p PROMPT），
    // 避免误阻断 `read -p '[foo] ' var`。
    if (BARE_SUBSCRIPT_NAME_BUILTINS.has(name)) {
      let skipNext = false
      for (let i = 1; i < a.length; i++) {
        const arg = a[i]!
        if (skipNext) {
          skipNext = false
          continue
        }
        if (arg[0] === '-') {
          if (name === 'read') {
            if (READ_DATA_FLAGS.has(arg)) {
              skipNext = true
            } else if (arg.length > 2 && arg[1] !== '-') {
              // 组合短 flag，如 `-rp`。getopt 风格：第一个数据 flag 字符
              // 消耗其后的字符串作为操作数（`-p[foo]` → prompt=`[foo]`），
              // 或若位于末尾则消耗下一个参数（`-rp '[foo]'` → prompt=`[foo]`）。
              // 因此当数据 flag 字符出现在末尾（仅前面是无参 flag 如 `-r`/`-s`）时，
              // skipNext 为 true。
              for (let j = 1; j < arg.length; j++) {
                if (READ_DATA_FLAGS.has('-' + arg[j])) {
                  if (j === arg.length - 1) skipNext = true
                  break
                }
              }
            }
          }
          continue
        }
        if (arg.includes('[')) {
          return {
            ok: false,
            reason: `'${name}' positional NAME '${arg}' contains array subscript — bash evaluates $(cmd) in subscripts`,
          }
        }
      }
    }

    // 安全说明：shell 保留关键字作为 argv[0] 表明 tree-sitter 解析有误。
    // `! for i in a; do :; done` 被解析为 `command "for i in a"`
    // + `command "do :"` + `command "done"`——tree-sitter 无法识别
    // `!` 之后的 `for` 为复合命令起始。
    // 拒绝：关键字永远不可能是合法的命令名，
    // ['do','false'] 这样的 argv 是无意义的。
    if (SHELL_KEYWORDS.has(name)) {
      return {
        ok: false,
        reason: `Shell keyword '${name}' as command name — tree-sitter mis-parse`,
      }
    }

    // 检测 argv（而非 .text）以同时捕获单引号（`'\n#'`）和双引号（`"\n#"`）变体。
    // 环境变量和重定向也在 .text 跨度内，因此同样受下游 bug 影响。
    // heredoc 主体不包含在 argv 中，避免 markdown 的 `##` 标题误触发此检测。
    // TODO：一旦下游路径验证改为操作 argv，移除此检测。
    for (const arg of cmd.argv) {
      if (arg.includes('\n') && NEWLINE_HASH_RE.test(arg)) {
        return {
          ok: false,
          reason:
            'Newline followed by # inside a quoted argument can hide arguments from path validation',
        }
      }
    }
    for (const ev of cmd.envVars) {
      if (ev.value.includes('\n') && NEWLINE_HASH_RE.test(ev.value)) {
        return {
          ok: false,
          reason:
            'Newline followed by # inside an env var value can hide arguments from path validation',
        }
      }
    }
    for (const r of cmd.redirects) {
      if (r.target.includes('\n') && NEWLINE_HASH_RE.test(r.target)) {
        return {
          ok: false,
          reason:
            'Newline followed by # inside a redirect target can hide arguments from path validation',
        }
      }
    }

    // jq 的 system() 内置函数执行任意 shell 命令，
    // --from-file 等 flag 可将任意文件读取为 jq 变量。
    // 在旧路径中，这些由 bashSecurity.ts 的 validateJqCommand 捕获，
    // 但该验证器受 `astSubcommands === null` 门控，AST 解析成功时不会运行。
    // 在此处镜像相同的检测，确保 AST 路径具备同等防护。
    if (name === 'jq') {
      for (const arg of a) {
        if (/\bsystem\s*\(/.test(arg)) {
          return {
            ok: false,
            reason:
              'jq command contains system() function which executes arbitrary commands',
          }
        }
      }
      if (
        a.some(arg =>
          /^(?:-[fL](?:$|[^A-Za-z])|--(?:from-file|rawfile|slurpfile|library-path)(?:$|=))/.test(
            arg,
          ),
        )
      ) {
        return {
          ok: false,
          reason:
            'jq command contains dangerous flags that could execute code or read arbitrary files',
        }
      }
    }

    if (ZSH_DANGEROUS_BUILTINS.has(name)) {
      return {
        ok: false,
        reason: `Zsh builtin '${name}' can bypass security checks`,
      }
    }

    if (EVAL_LIKE_BUILTINS.has(name)) {
      // `command -v foo` / `command -V foo` 是 POSIX 存在性检测，
      // 仅打印路径——不执行 argv[1]。
      // 裸 `command foo` 确实会绕过函数/别名查找（这是安全关注点），因此继续阻断。
      if (name === 'command' && (a[1] === '-v' || a[1] === '-V')) {
        // 放行，继续后续检测
      } else if (
        name === 'fc' &&
        !a.slice(1).some(arg => /^-[^-]*[es]/.test(arg))
      ) {
        // `fc -l`、`fc -ln` 列出历史记录——安全。
        // `fc -e ed` 调用编辑器然后执行。
        // `fc -s [pat=rep]` 重新执行上一条匹配命令（可选替换）——等同于 eval，危险。
        // 阻断任何包含 `e` 或 `s` 的短选项，
        // 避免对 `fc -l`（列出历史）引入误报。
      } else if (
        name === 'compgen' &&
        !a.slice(1).some(arg => /^-[^-]*[CFW]/.test(arg))
      ) {
        // `compgen -c/-f/-v` 只列出补全项——安全。
        // `compgen -C cmd` 直接执行 cmd；`-F func` 调用 shell 函数；
        // `-W list` 对参数进行字展开（包括 $(cmd)，即使来自单引号 raw_string）。
        // 阻断任何包含 C/F/W 的短选项（区分大小写：-c/-f 安全）。
      } else {
        return {
          ok: false,
          reason: `'${name}' evaluates arguments as shell code`,
        }
      }
    }

    // /proc/*/environ 暴露其他进程的环境变量（可能包含密钥）。
    // 同时检测 argv 和重定向目标——
    // `cat /proc/self/environ` 和 `cat < /proc/self/environ` 均会读取该文件。
    for (const arg of cmd.argv) {
      if (arg.includes('/proc/') && PROC_ENVIRON_RE.test(arg)) {
        return {
          ok: false,
          reason: 'Accesses /proc/*/environ which may expose secrets',
        }
      }
    }
    for (const r of cmd.redirects) {
      if (r.target.includes('/proc/') && PROC_ENVIRON_RE.test(r.target)) {
        return {
          ok: false,
          reason: 'Accesses /proc/*/environ which may expose secrets',
        }
      }
    }
  }
  return { ok: true }
}
