/**
 * 基于 tree-sitter AST 的 bash 命令安全分析工具模块。
 *
 * 在 Claude Code 系统中，该模块从 tree-sitter 解析树中提取安全相关信息，
 * 比正则/shell-quote 方案更精确。每个函数接收 AST 根节点和命令字符串，
 * 返回结构化数据供安全校验器使用：
 * - extractQuoteContext()：提取引号上下文（单引号/双引号/ANSI-C/heredoc 跨越范围）
 * - extractCompoundStructure()：提取复合命令结构（&&/||/;/管道/子 shell/命令组）
 * - hasActualOperatorNodes()：判断 AST 中是否存在真实操作符节点（消除 find \; 误报）
 * - extractDangerousPatterns()：检测危险模式（命令替换/$()、进程替换、参数展开、heredoc、注释）
 * - analyzeCommand()：一次性完整分析，整合上述所有结果
 *
 * NAPI 原生解析器返回普通 JS 对象，无需调用 tree.delete() 释放资源。
 */

type TreeSitterNode = {
  type: string
  text: string
  startIndex: number
  endIndex: number
  children: TreeSitterNode[]
  childCount: number
}

export type QuoteContext = {
  /** 删除单引号内容后的命令文本（双引号内容保留） */
  withDoubleQuotes: string
  /** 删除所有引号内容后的命令文本 */
  fullyUnquoted: string
  /** 类似 fullyUnquoted，但保留引号字符本身（'、"） */
  unquotedKeepQuoteChars: string
}

export type CompoundStructure = {
  /** 命令顶层是否含有复合操作符（&&、||、;） */
  hasCompoundOperators: boolean
  /** 命令是否含有管道 */
  hasPipeline: boolean
  /** 命令是否含有子 shell */
  hasSubshell: boolean
  /** 命令是否含有命令组（{...}） */
  hasCommandGroup: boolean
  /** 顶层发现的复合操作符类型列表 */
  operators: string[]
  /** 按复合操作符切分后的各命令段 */
  segments: string[]
}

export type DangerousPatterns = {
  /** 是否含有 $() 或反引号命令替换（处于引号外，不被引号保护） */
  hasCommandSubstitution: boolean
  /** 是否含有 <() 或 >() 进程替换 */
  hasProcessSubstitution: boolean
  /** 是否含有 ${...} 参数展开 */
  hasParameterExpansion: boolean
  /** 是否含有 heredoc */
  hasHeredoc: boolean
  /** 是否含有注释 */
  hasComment: boolean
}

export type TreeSitterAnalysis = {
  quoteContext: QuoteContext
  compoundStructure: CompoundStructure
  /** 是否存在真实操作符节点（;、&&、||）——若无，则 \; 只是 word 参数而非操作符 */
  hasActualOperatorNodes: boolean
  dangerousPatterns: DangerousPatterns
}

type QuoteSpans = {
  raw: Array<[number, number]> // raw_string（单引号）
  ansiC: Array<[number, number]> // ansi_c_string（$'...'）
  double: Array<[number, number]> // string（双引号）
  heredoc: Array<[number, number]> // 带引号的 heredoc_redirect
}

/**
 * 单次遍历收集所有引号相关的字符范围（span）。
 *
 * 原来需要 5 次独立树遍历（每种引号类型各一次 + allQuoteTypes + heredoc），
 * 合并后减少约 5 倍的 AST 遍历开销。
 *
 * 复现原有分类型遍历语义：
 * - raw_string 遍历会穿过 string 节点（不是目标类型）继续向下，
 *   以找到 $(...) 内部嵌套的 raw_string；
 * - string 遍历则在首次遇到 string 节点时停止（最外层）。
 * 用 `inDouble` 标记当前是否处于双引号内部，
 * 以便仅收集每条路径上最外层的 string span，
 * 同时仍递归进入 $()/${} 体内寻找嵌套 raw_string/ansi_c_string。
 *
 * raw_string / ansi_c_string / 带引号的 heredoc 体均为 bash 字面值（不展开），
 * 内部不存在嵌套引号节点，遇到后直接 return 不再递归。
 */
function collectQuoteSpans(
  node: TreeSitterNode,
  out: QuoteSpans,
  inDouble: boolean,
): void {
  switch (node.type) {
    case 'raw_string':
      out.raw.push([node.startIndex, node.endIndex])
      return // 字面量体，内部不存在嵌套引号
    case 'ansi_c_string':
      out.ansiC.push([node.startIndex, node.endIndex])
      return // 字面量体
    case 'string':
      // 仅收集最外层 string（与旧版逐类型遍历遇到首匹配即停止的语义一致）。
      // 无论如何继续递归——"$(cmd 'x')" 中嵌套在 "..." 内的 $() 含有真实的内层 raw_string。
      if (!inDouble) out.double.push([node.startIndex, node.endIndex])
      for (const child of node.children) {
        if (child) collectQuoteSpans(child, out, true)
      }
      return
    case 'heredoc_redirect': {
      // 带引号的 heredoc（<<'EOF'、<<"EOF"、<<\EOF）：字面量体。
      // 不带引号的 heredoc（<<EOF）会展开 $()/${} ——其体内可包含
      // 含有内层 '...' 的 $(cmd 'x')，内层 '...' 是真实的 raw_string 节点。
      // 判断方式：heredoc_start 文本以 '/"/\\ 开头。
      // 与同步路径的 extractHeredocs({ quotedOnly: true }) 对齐。
      let isQuoted = false
      for (const child of node.children) {
        if (child && child.type === 'heredoc_start') {
          const first = child.text[0]
          isQuoted = first === "'" || first === '"' || first === '\\'
          break
        }
      }
      if (isQuoted) {
        out.heredoc.push([node.startIndex, node.endIndex])
        return // 字面量体，内部无嵌套引号节点
      }
      // 不带引号：递归进入 heredoc_body → command_substitution →
      // 内层引号节点。原有逐类型遍历不会在 heredoc_redirect 处停止
      // （不在其类型集内），因此会继续递归此处。
      break
    }
  }

  for (const child of node.children) {
    if (child) collectQuoteSpans(child, out, inDouble)
  }
}

/**
 * 构建覆盖给定 span 数组所有字符位置的 Set。
 * 用于逐字符判断某位置是否处于引号区间内，
 * 避免对每个字符重复遍历 span 数组（O(n) → O(1)）。
 */
function buildPositionSet(spans: Array<[number, number]>): Set<number> {
  const set = new Set<number>()
  for (const [start, end] of spans) {
    for (let i = start; i < end; i++) {
      set.add(i)
    }
  }
  return set
}

/**
 * 将给定 span 数组中被完全包含于其他 span 的条目过滤掉，仅保留最外层 span。
 *
 * 嵌套引号（如 `"$(echo 'hi')"` ）会产生重叠 span：
 * 外层 string 和内层 raw_string 在递归时均被收集。
 * 若直接处理重叠 span，外层 span 的替换会使内层 span 的索引偏移失效。
 * 本函数过滤掉被完全包含的内层 span，确保只对最外层 span 进行字符串操作。
 */
function dropContainedSpans<T extends readonly [number, number, ...unknown[]]>(
  spans: T[],
): T[] {
  return spans.filter(
    (s, i) =>
      !spans.some(
        (other, j) =>
          j !== i &&
          other[0] <= s[0] &&
          other[1] >= s[1] &&
          (other[0] < s[0] || other[1] > s[1]),
      ),
  )
}

/**
 * 从命令字符串中删除所有给定 span 覆盖的字符区间。
 * 先过滤掉被包含的内层 span，再按起始位置降序排列后从后向前删除，
 * 避免前向删除时引发的索引偏移问题。
 */
function removeSpans(command: string, spans: Array<[number, number]>): string {
  if (spans.length === 0) return command

  // 过滤掉被完全包含的内层 span，再按起始位置降序排列，
  // 从后向前拼接，避免前向删除引发的索引偏移。
  const sorted = dropContainedSpans(spans).sort((a, b) => b[0] - a[0])
  let result = command
  for (const [start, end] of sorted) {
    result = result.slice(0, start) + result.slice(end)
  }
  return result
}

/**
 * 将各 span 区间的内容替换为仅保留首尾引号字符（open/close 参数）的形式。
 * 用于生成 unquotedKeepQuoteChars 视图：保留 `/"/\`` 等引号标记，
 * 但去除引号内部实际内容，以便安全检测器识别引号结构而不受内容干扰。
 */
function replaceSpansKeepQuotes(
  command: string,
  spans: Array<[number, number, string, string]>,
): string {
  if (spans.length === 0) return command

  const sorted = dropContainedSpans(spans).sort((a, b) => b[0] - a[0])
  let result = command
  for (const [start, end, open, close] of sorted) {
    // 替换内容但保留引号分隔符
    result = result.slice(0, start) + open + close + result.slice(end)
  }
  return result
}

/**
 * 从 tree-sitter AST 中提取引号上下文，生成三种命令文本视图。
 *
 * 三种视图的语义：
 * - withDoubleQuotes：删除单引号/ANSI-C 引号/带引号 heredoc 覆盖的字符，
 *   仅保留双引号内容（但去掉 `"` 分隔符本身），供需区分单/双引号语义的检测器使用。
 * - fullyUnquoted：删除所有引号区间的字符，得到纯未引号化文本，
 *   用于检测裸露的危险模式（如 `; rm -rf`）。
 * - unquotedKeepQuoteChars：删除引号内容但保留引号标记字符，
 *   供需识别引号结构（如不平衡引号检测）的检测器使用。
 *
 * 替代了原来基于字符遍历的 extractQuotedContent() 函数，
 * 精度更高（tree-sitter 准确区分节点类型，不受转义歧义影响）。
 *
 * tree-sitter 节点类型说明：
 * - raw_string：单引号字符串 ('...')
 * - string：双引号字符串 ("...")
 * - ansi_c_string：ANSI-C 引号字符串 ($'...'，span 包含前导 $)
 * - heredoc_redirect：仅带引号的 heredoc（<<'EOF'、<<"EOF"、<<\EOF），
 *   整个重定向区间（<<、分隔符、体、换行）均被删除，
 *   不带引号的 heredoc（<<EOF）保留，因为 bash 会展开其中的 $()/${...}
 */
export function extractQuoteContext(
  rootNode: unknown,
  command: string,
): QuoteContext {
  // 单次遍历收集所有引号 span 类型。
  const spans: QuoteSpans = { raw: [], ansiC: [], double: [], heredoc: [] }
  collectQuoteSpans(rootNode as TreeSitterNode, spans, false)
  const singleQuoteSpans = spans.raw
  const ansiCSpans = spans.ansiC
  const doubleQuoteSpans = spans.double
  const quotedHeredocSpans = spans.heredoc
  const allQuoteSpans = [
    ...singleQuoteSpans,
    ...ansiCSpans,
    ...doubleQuoteSpans,
    ...quotedHeredocSpans,
  ]

  // 构建各输出变体所需排除的位置集合。
  // withDoubleQuotes：完整删除单引号 span，同时删除双引号 span 的首尾 `"` 分隔符
  // （但保留其内部内容）。这与旧版正则 extractQuotedContent() 语义一致：
  // `"` 切换引号状态，但内容仍然输出。
  const singleQuoteSet = buildPositionSet([
    ...singleQuoteSpans,
    ...ansiCSpans,
    ...quotedHeredocSpans,
  ])
  const doubleQuoteDelimSet = new Set<number>()
  for (const [start, end] of doubleQuoteSpans) {
    doubleQuoteDelimSet.add(start) // 起始 "
    doubleQuoteDelimSet.add(end - 1) // 结束 "
  }
  let withDoubleQuotes = ''
  for (let i = 0; i < command.length; i++) {
    if (singleQuoteSet.has(i)) continue
    if (doubleQuoteDelimSet.has(i)) continue
    withDoubleQuotes += command[i]
  }

  // fullyUnquoted：删除所有引号内容
  const fullyUnquoted = removeSpans(command, allQuoteSpans)

  // unquotedKeepQuoteChars：删除内容但保留分隔符字符
  const spansWithQuoteChars: Array<[number, number, string, string]> = []
  for (const [start, end] of singleQuoteSpans) {
    spansWithQuoteChars.push([start, end, "'", "'"])
  }
  for (const [start, end] of ansiCSpans) {
    // ansi_c_string span 包含前导 $；保留它以与正则路径保持一致，
    // 正则路径将 $ 视为未引号化的前置字符。
    spansWithQuoteChars.push([start, end, "$'", "'"])
  }
  for (const [start, end] of doubleQuoteSpans) {
    spansWithQuoteChars.push([start, end, '"', '"'])
  }
  for (const [start, end] of quotedHeredocSpans) {
    // heredoc redirect span 内联无引号分隔符——完整删除。
    spansWithQuoteChars.push([start, end, '', ''])
  }
  const unquotedKeepQuoteChars = replaceSpansKeepQuotes(
    command,
    spansWithQuoteChars,
  )

  return { withDoubleQuotes, fullyUnquoted, unquotedKeepQuoteChars }
}

/**
 * 从 AST 中提取复合命令结构，替代 isUnsafeCompoundCommand() 和 splitCommand()。
 *
 * 顶层遍历 program 节点的直接子节点，识别：
 * - &&/|| 操作符（在 list 节点内）
 * - ; 分隔符（直接作为 program 的子节点）
 * - pipeline（管道链）
 * - subshell（子 shell，即 (...) ）
 * - compound_statement（命令组，即 {...} ）
 * - redirected_statement（带重定向的语句，需递归展开内部结构）
 * - 控制流（if/while/for/case/function）：记录为段落并递归检测内部结构
 *
 * 返回 CompoundStructure，供安全校验器判断命令是否为复合命令及其各段落文本。
 */
export function extractCompoundStructure(
  rootNode: unknown,
  command: string,
): CompoundStructure {
  const n = rootNode as TreeSitterNode
  const operators: string[] = []
  const segments: string[] = []
  let hasSubshell = false
  let hasCommandGroup = false
  let hasPipeline = false

  // 遍历 program 节点的顶层子节点
  function walkTopLevel(node: TreeSitterNode): void {
    for (const child of node.children) {
      if (!child) continue

      if (child.type === 'list') {
        // list 节点包含 && 和 || 操作符
        for (const listChild of child.children) {
          if (!listChild) continue
          if (listChild.type === '&&' || listChild.type === '||') {
            operators.push(listChild.type)
          } else if (
            listChild.type === 'list' ||
            listChild.type === 'redirected_statement'
          ) {
            // 嵌套的 list 或包装了 list/pipeline 的 redirected_statement——
            // 递归检测内层操作符/管道。
            // 对于 `cmd1 && cmd2 2>/dev/null && cmd3`，redirected_statement
            // 包装了 `list(cmd1 && cmd2)`，不递归则会遗漏内层 `&&`。
            walkTopLevel({ ...node, children: [listChild] } as TreeSitterNode)
          } else if (listChild.type === 'pipeline') {
            hasPipeline = true
            segments.push(listChild.text)
          } else if (listChild.type === 'subshell') {
            hasSubshell = true
            segments.push(listChild.text)
          } else if (listChild.type === 'compound_statement') {
            hasCommandGroup = true
            segments.push(listChild.text)
          } else {
            segments.push(listChild.text)
          }
        }
      } else if (child.type === ';') {
        operators.push(';')
      } else if (child.type === 'pipeline') {
        hasPipeline = true
        segments.push(child.text)
      } else if (child.type === 'subshell') {
        hasSubshell = true
        segments.push(child.text)
      } else if (child.type === 'compound_statement') {
        hasCommandGroup = true
        segments.push(child.text)
      } else if (
        child.type === 'command' ||
        child.type === 'declaration_command' ||
        child.type === 'variable_assignment'
      ) {
        segments.push(child.text)
      } else if (child.type === 'redirected_statement') {
        // `cd ~/src && find path 2>/dev/null`——tree-sitter 将整个复合命令
        // 包装成 redirected_statement：program → redirected_statement →
        // (list → cmd1, &&, cmd2) + file_redirect。
        // `cmd1 | cmd2 > out`（包装 pipeline）和 `(cmd) > out`（包装子 shell）同理。
        // 递归检测内部结构；跳过 file_redirect 子节点（重定向不影响复合/管道分类）。
        let foundInner = false
        for (const inner of child.children) {
          if (!inner || inner.type === 'file_redirect') continue
          foundInner = true
          walkTopLevel({ ...child, children: [inner] } as TreeSitterNode)
        }
        if (!foundInner) {
          // 无体的独立重定向（理论上不应出现，作为安全兜底）
          segments.push(child.text)
        }
      } else if (child.type === 'negated_command') {
        // `! cmd`——递归进入内层命令以检测其结构
        // （pipeline/subshell 等），同时将完整的否定文本作为一段记录，
        // 确保 segments.length 语义保持有意义。
        segments.push(child.text)
        walkTopLevel(child)
      } else if (
        child.type === 'if_statement' ||
        child.type === 'while_statement' ||
        child.type === 'for_statement' ||
        child.type === 'case_statement' ||
        child.type === 'function_definition'
      ) {
        // 控制流结构：整体作为一段，但递归检测内部 pipeline/subshell/操作符。
        segments.push(child.text)
        walkTopLevel(child)
      }
    }
  }

  walkTopLevel(n)

  // 未找到任何段落时，将整个命令作为单段
  if (segments.length === 0) {
    segments.push(command)
  }

  return {
    hasCompoundOperators: operators.length > 0,
    hasPipeline,
    hasSubshell,
    hasCommandGroup,
    operators,
    segments,
  }
}

/**
 * 检查 AST 中是否存在真实操作符节点（;、&&、||）。
 *
 * 这是消除 `find -exec \;` 误报的核心函数。
 * tree-sitter 将 `\;` 解析为 `word` 节点（find 的参数），
 * 而非 `;` 操作符节点。因此若 AST 中不存在真实的 `;` 操作符节点，
 * 则不存在复合命令，可跳过 hasBackslashEscapedOperator() 检查。
 */
export function hasActualOperatorNodes(rootNode: unknown): boolean {
  const n = rootNode as TreeSitterNode

  function walk(node: TreeSitterNode): boolean {
    // 检测表示复合命令的操作符类型
    if (node.type === ';' || node.type === '&&' || node.type === '||') {
      // 确认该节点是 list 或 program 的子节点，而非命令内部
      return true
    }

    if (node.type === 'list') {
      // list 节点表示存在复合操作符
      return true
    }

    for (const child of node.children) {
      if (child && walk(child)) return true
    }
    return false
  }

  return walk(n)
}

/**
 * 从 AST 中提取危险模式信息，遍历所有节点，检测以下节点类型：
 * - command_substitution：命令替换（$() 或反引号）
 * - process_substitution：进程替换（<() 或 >()）
 * - expansion：参数展开（${...}）
 * - heredoc_redirect：here-doc 语法
 * - comment：注释（可被用于混淆命令）
 *
 * 返回 DangerousPatterns，供安全校验器按需拒绝或警告。
 */
export function extractDangerousPatterns(rootNode: unknown): DangerousPatterns {
  const n = rootNode as TreeSitterNode
  let hasCommandSubstitution = false
  let hasProcessSubstitution = false
  let hasParameterExpansion = false
  let hasHeredoc = false
  let hasComment = false

  function walk(node: TreeSitterNode): void {
    switch (node.type) {
      case 'command_substitution':
        hasCommandSubstitution = true
        break
      case 'process_substitution':
        hasProcessSubstitution = true
        break
      case 'expansion':
        hasParameterExpansion = true
        break
      case 'heredoc_redirect':
        hasHeredoc = true
        break
      case 'comment':
        hasComment = true
        break
    }

    for (const child of node.children) {
      if (child) walk(child)
    }
  }

  walk(n)

  return {
    hasCommandSubstitution,
    hasProcessSubstitution,
    hasParameterExpansion,
    hasHeredoc,
    hasComment,
  }
}

/**
 * 对命令执行完整的 tree-sitter 安全分析，一次性提取所有安全相关数据。
 *
 * 整合调用：
 * - extractQuoteContext()：生成三种引号视图
 * - extractCompoundStructure()：检测复合命令结构
 * - hasActualOperatorNodes()：消除 \; 误报
 * - extractDangerousPatterns()：检测危险 AST 节点
 *
 * 返回 TreeSitterAnalysis 供调用方在 tree.delete() 之前提取所有必要数据。
 * （NAPI 原生解析器返回普通 JS 对象，实际无需手动释放，但接口保持一致。）
 */
export function analyzeCommand(
  rootNode: unknown,
  command: string,
): TreeSitterAnalysis {
  return {
    quoteContext: extractQuoteContext(rootNode, command),
    compoundStructure: extractCompoundStructure(rootNode, command),
    hasActualOperatorNodes: hasActualOperatorNodes(rootNode),
    dangerousPatterns: extractDangerousPatterns(rootNode),
  }
}
