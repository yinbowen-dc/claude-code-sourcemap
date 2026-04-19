/**
 * 纯 TypeScript Bash 解析器，生成与 tree-sitter-bash 兼容的 AST。
 *
 * 在 Claude Code 系统中，该模块为 parser.ts / ast.ts / prefix.ts /
 * ParsedCommand.ts 等下游模块提供 Bash 语法树；下游代码按字段名遍历节点。
 * startIndex / endIndex 为 UTF-8 字节偏移量（非 JS 字符串索引）。
 * 语法参考：tree-sitter-bash；已通过对 WASM 解析器生成的 3449 条黄金语料库验证。
 */

/**
 * AST 节点类型，与 tree-sitter 节点结构兼容。
 * startIndex / endIndex 均为 UTF-8 字节偏移（非 JS 字符串下标）。
 * children 保存子节点列表；叶子节点的 children 为空数组。
 */
export type TsNode = {
  type: string
  text: string
  startIndex: number
  endIndex: number
  children: TsNode[]
}

/** 解析器模块接口，parse() 返回根节点或在超时/异常时返回 null。 */
type ParserModule = {
  parse: (source: string, timeoutMs?: number) => TsNode | null
}

/**
 * 50ms 墙钟超时上限 —— 对病态/对抗性输入触发中止。
 * 可通过 `parse(src, Infinity)` 禁用（用于正确性测试，避免 CI 抖动导致误报 null）。
 */
const PARSE_TIMEOUT_MS = 50

/** 节点数量上限 —— 在深度嵌套输入造成 OOM 之前中止解析。 */
const MAX_NODES = 50_000

const MODULE: ParserModule = { parse: parseSource }

const READY = Promise.resolve()

/** 无操作：纯 TS 解析器无需异步初始化，保留此函数以维持 API 兼容性。 */
export function ensureParserInitialized(): Promise<void> {
  return READY
}

/** 始终返回解析器模块（纯 TS 实现，无需初始化）。 */
export function getParserModule(): ParserModule | null {
  return MODULE
}

// ───────────────────────────── Tokenizer ─────────────────────────────

/**
 * 词法单元类型枚举。
 * WORD：普通单词；NUMBER：纯数字字面量；OP：操作符/标点；
 * NEWLINE：换行符；COMMENT：注释；DQUOTE/SQUOTE/ANSI_C：各类引号；
 * DOLLAR/DOLLAR_PAREN/DOLLAR_BRACE/DOLLAR_DPAREN：$、$(、${、$(( 前缀；
 * BACKTICK：反引号；LT_PAREN/GT_PAREN：<( / >(（进程替换）；EOF：文件末。
 */
  | 'WORD'
  | 'NUMBER'
  | 'OP'
  | 'NEWLINE'
  | 'COMMENT'
  | 'DQUOTE'
  | 'SQUOTE'
  | 'ANSI_C'
  | 'DOLLAR'
  | 'DOLLAR_PAREN'
  | 'DOLLAR_BRACE'
  | 'DOLLAR_DPAREN'
  | 'BACKTICK'
  | 'LT_PAREN'
  | 'GT_PAREN'
  | 'EOF'

/** 词法单元，携带类型、文本值和 UTF-8 字节偏移范围。 */
type Token = {
  type: TokenType
  value: string
  /** 首个字符的 UTF-8 字节偏移 */
  start: number
  /** 末尾字符下一位的 UTF-8 字节偏移 */
  end: number
}

/** Bash 特殊变量字符集，用于 $? $$ $@ $* $# $- $! $_ 的快速识别。 */

/** 声明类关键字集合，命令以这些关键字开头时路由到 parseDeclaration。 */
const DECL_KEYWORDS = new Set([
  'export',
  'declare',
  'typeset',
  'readonly',
  'local',
])

/**
 * Shell 控制流关键字集合，导出供 ast.ts 用于拒绝不可能作为 argv[0] 的值。
 * 包含 if/for/while/case/function 等所有 Bash 复合命令关键字。
 */
export const SHELL_KEYWORDS = new Set([
  'if',
  'then',
  'elif',
  'else',
  'fi',
  'while',
  'until',
  'for',
  'in',
  'do',
  'done',
  'case',
  'esac',
  'function',
  'select',
])

/**
 * 词法分析器状态。
 * 同时追踪 JS 字符串下标（用于 charAt）和 UTF-8 字节偏移（用于 TsNode 位置）。
 * ASCII 快速路径：字节偏移 == 字符下标；非 ASCII 按代码点逐字符累加字节数。
 */
type Lexer = {
  src: string
  len: number
  /** JS 字符串下标 */
  i: number
  /** UTF-8 字节偏移 */
  b: number
  /** 等待在下一个换行处扫描正文的 heredoc 记录列表 */
  heredocs: HeredocPending[]
  /** 每个字符下标对应的字节偏移预计算表（首次遇到非 ASCII 时惰性构建） */
  byteTable: Uint32Array | null
}

/**
 * 待处理 heredoc 记录。
 * delim：分隔符文本；stripTabs：<<- 时为 true；quoted：分隔符被引号时为 true。
 * bodyStart/bodyEnd/endStart/endEnd 在扫描正文后填入。
 */
  delim: string
  stripTabs: boolean
  quoted: boolean
  /** 正文扫描后填入 */
  bodyStart: number
  bodyEnd: number
  endStart: number
  endEnd: number
}

/** 创建并返回初始化为 src 起始位置的词法分析器。 */
function makeLexer(src: string): Lexer {
  return {
    src,
    len: src.length,
    i: 0,
    b: 0,
    heredocs: [],
    byteTable: null,
  }
}

/**
 * 前进一个 JS 字符，同步更新 UTF-8 字节偏移。
 * - ASCII（< 0x80）：+1 字节；2 字节序列（< 0x800）：+2；
 * - 高代理对（0xD800-0xDBFF）：消耗两个 JS char，+4 字节；其余 BMP：+3。
 */
function advance(L: Lexer): void {
  const c = L.src.charCodeAt(L.i)
  L.i++
  if (c < 0x80) {
    L.b++
  } else if (c < 0x800) {
    L.b += 2
  } else if (c >= 0xd800 && c <= 0xdbff) {
    // 高代理对 —— 下一个 JS char 构成完整代理对，共占 4 个 UTF-8 字节
    L.b += 4
    L.i++
  } else {
    L.b += 3
  }
}

/** 查看当前位置起第 off 个字符（不前进）；超出范围返回空字符串。 */
function peek(L: Lexer, off = 0): string {
  return L.i + off < L.len ? L.src[L.i + off]! : ''
}

/**
 * 返回字符下标 charIdx 对应的 UTF-8 字节偏移。
 * 若 byteTable 尚未构建（首次非 ASCII 使用），则惰性构建全表。
 */
function byteAt(L: Lexer, charIdx: number): number {
  // 快速路径：全 ASCII 前缀时字符下标 == 字节偏移，byteTable 已存在时直接查表
  if (L.byteTable) return L.byteTable[charIdx]!
  // 首次非 ASCII 查询时构建完整的字符下标→字节偏移映射表
  const t = new Uint32Array(L.len + 1)
  let b = 0
  let i = 0
  while (i < L.len) {
    t[i] = b
    const c = L.src.charCodeAt(i)
    if (c < 0x80) {
      b++
      i++
    } else if (c < 0x800) {
      b += 2
      i++
    } else if (c >= 0xd800 && c <= 0xdbff) {
      t[i + 1] = b + 2
      b += 4
      i += 2
    } else {
      b += 3
      i++
    }
  }
  t[L.len] = b
  L.byteTable = t
  return t[charIdx]!
}

/**
 * 判断字符是否为 Bash 单词字符（可出现在 word token 中）。
 * 包含字母、数字及不构成操作符起始的各类标点：
 * _ / . - + : @ % , ~ ^ ? * ! = [ ]
 */
function isWordChar(c: string): boolean {
  return (
    (c >= 'a' && c <= 'z') ||
    (c >= 'A' && c <= 'Z') ||
    (c >= '0' && c <= '9') ||
    c === '_' ||
    c === '/' ||
    c === '.' ||
    c === '-' ||
    c === '+' ||
    c === ':' ||
    c === '@' ||
    c === '%' ||
    c === ',' ||
    c === '~' ||
    c === '^' ||
    c === '?' ||
    c === '*' ||
    c === '!' ||
    c === '=' ||
    c === '[' ||
    c === ']'
  )
}

/** 判断字符是否可以作为单词起始（isWordChar 或反斜杠转义）。 */
function isWordStart(c: string): boolean {
  return isWordChar(c) || c === '\\'
}

/** 判断字符是否为标识符起始字符（字母或下划线）。 */
function isIdentStart(c: string): boolean {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_'
}

/** 判断字符是否为标识符字符（字母、数字或下划线）。 */
function isIdentChar(c: string): boolean {
  return isIdentStart(c) || (c >= '0' && c <= '9')
}

/** 判断字符是否为十进制数字 0-9。 */
function isDigit(c: string): boolean {
  return c >= '0' && c <= '9'
}

/** 判断字符是否为十六进制数字（0-9、a-f、A-F），用于 0x 前缀数字字面量。 */
function isHexDigit(c: string): boolean {
  return isDigit(c) || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')
}

/**
 * 判断字符是否为 Bash BASE#DIGITS 进制数字（最高支持 base-64）。
 * 包含字母、数字、@ 和 _，例如：2#1010、16#ff、64#Az@_。
 */
  return isIdentChar(c) || c === '@'
}

/**
 * 判断字符是否可以作为未引号 heredoc 分隔符的组成字符。
 * Bash 接受除元字符（空白、重定向、管道/列表操作符、括号、引号、反斜杠）之外的大多数字符，
 * 例如 <<!HEREDOC! 中的 ! - . + 等均合法。
 */
function isHeredocDelimChar(c: string): boolean {
  return (
    c !== '' &&
    c !== ' ' &&
    c !== '\t' &&
    c !== '\n' &&
    c !== '<' &&
    c !== '>' &&
    c !== '|' &&
    c !== '&' &&
    c !== ';' &&
    c !== '(' &&
    c !== ')' &&
    c !== "'" &&
    c !== '"' &&
    c !== '`' &&
    c !== '\\'
  )
}

/** 跳过空白（空格、制表符、\r）及行续接（\<换行>），推进词法器位置。 */
function skipBlanks(L: Lexer): void {
  while (L.i < L.len) {
    const c = L.src[L.i]!
    if (c === ' ' || c === '\t' || c === '\r') {
      // \r 是 tree-sitter-bash extras /\s/ 允许的空白 —— 处理 CRLF 输入
      advance(L)
    } else if (c === '\\') {
      const nx = L.src[L.i + 1]
      if (nx === '\n' || (nx === '\r' && L.src[L.i + 2] === '\n')) {
        // 行续接 —— tree-sitter extras: /\\\r?\n/
        advance(L)
        advance(L)
        if (nx === '\r') advance(L)
      } else if (nx === ' ' || nx === '\t') {
        // \<空格> 或 \<制表> —— tree-sitter 的 _whitespace 规则 /\\?[ \t\v]+/
        advance(L)
        advance(L)
      } else {
        break
      }
    } else {
      break
    }
  }
}

/**
 * 扫描并返回下一个词法单元。
 * 上下文敏感：cmd 模式下 [ 被视为操作符（test 命令起始），
 * arg 模式下 [ 被视为单词字符（glob/数组下标）。
 * 多字符操作符采用最长匹配优先策略。
 */
function nextToken(L: Lexer, ctx: 'cmd' | 'arg' = 'arg'): Token {
  skipBlanks(L)
  const start = L.b
  if (L.i >= L.len) return { type: 'EOF', value: '', start, end: start }

  const c = L.src[L.i]!
  const c1 = peek(L, 1)
  const c2 = peek(L, 2)

  if (c === '\n') {
    advance(L)
    return { type: 'NEWLINE', value: '\n', start, end: L.b }
  }

  if (c === '#') {
    const si = L.i
    while (L.i < L.len && L.src[L.i] !== '\n') advance(L)
    return {
      type: 'COMMENT',
      value: L.src.slice(si, L.i),
      start,
      end: L.b,
    }
  }

  // 多字符操作符（最长匹配优先）
  if (c === '&' && c1 === '&') {
    advance(L)
    advance(L)
    return { type: 'OP', value: '&&', start, end: L.b }
  }
  if (c === '|' && c1 === '|') {
    advance(L)
    advance(L)
    return { type: 'OP', value: '||', start, end: L.b }
  }
  if (c === '|' && c1 === '&') {
    advance(L)
    advance(L)
    return { type: 'OP', value: '|&', start, end: L.b }
  }
  if (c === ';' && c1 === ';' && c2 === '&') {
    advance(L)
    advance(L)
    advance(L)
    return { type: 'OP', value: ';;&', start, end: L.b }
  }
  if (c === ';' && c1 === ';') {
    advance(L)
    advance(L)
    return { type: 'OP', value: ';;', start, end: L.b }
  }
  if (c === ';' && c1 === '&') {
    advance(L)
    advance(L)
    return { type: 'OP', value: ';&', start, end: L.b }
  }
  if (c === '>' && c1 === '>') {
    advance(L)
    advance(L)
    return { type: 'OP', value: '>>', start, end: L.b }
  }
  if (c === '>' && c1 === '&' && c2 === '-') {
    advance(L)
    advance(L)
    advance(L)
    return { type: 'OP', value: '>&-', start, end: L.b }
  }
  if (c === '>' && c1 === '&') {
    advance(L)
    advance(L)
    return { type: 'OP', value: '>&', start, end: L.b }
  }
  if (c === '>' && c1 === '|') {
    advance(L)
    advance(L)
    return { type: 'OP', value: '>|', start, end: L.b }
  }
  if (c === '&' && c1 === '>' && c2 === '>') {
    advance(L)
    advance(L)
    advance(L)
    return { type: 'OP', value: '&>>', start, end: L.b }
  }
  if (c === '&' && c1 === '>') {
    advance(L)
    advance(L)
    return { type: 'OP', value: '&>', start, end: L.b }
  }
  if (c === '<' && c1 === '<' && c2 === '<') {
    advance(L)
    advance(L)
    advance(L)
    return { type: 'OP', value: '<<<', start, end: L.b }
  }
  if (c === '<' && c1 === '<' && c2 === '-') {
    advance(L)
    advance(L)
    advance(L)
    return { type: 'OP', value: '<<-', start, end: L.b }
  }
  if (c === '<' && c1 === '<') {
    advance(L)
    advance(L)
    return { type: 'OP', value: '<<', start, end: L.b }
  }
  if (c === '<' && c1 === '&' && c2 === '-') {
    advance(L)
    advance(L)
    advance(L)
    return { type: 'OP', value: '<&-', start, end: L.b }
  }
  if (c === '<' && c1 === '&') {
    advance(L)
    advance(L)
    return { type: 'OP', value: '<&', start, end: L.b }
  }
  if (c === '<' && c1 === '(') {
    advance(L)
    advance(L)
    return { type: 'LT_PAREN', value: '<(', start, end: L.b }
  }
  if (c === '>' && c1 === '(') {
    advance(L)
    advance(L)
    return { type: 'GT_PAREN', value: '>(', start, end: L.b }
  }
  if (c === '(' && c1 === '(') {
    advance(L)
    advance(L)
    return { type: 'OP', value: '((', start, end: L.b }
  }
  if (c === ')' && c1 === ')') {
    advance(L)
    advance(L)
    return { type: 'OP', value: '))', start, end: L.b }
  }

  if (c === '|' || c === '&' || c === ';' || c === '>' || c === '<') {
    advance(L)
    return { type: 'OP', value: c, start, end: L.b }
  }
  if (c === '(' || c === ')') {
    advance(L)
    return { type: 'OP', value: c, start, end: L.b }
  }

  // 在 cmd 位置：[ [[ 启动 test 命令，{ 启动组命令；arg 位置时它们是单词字符
  if (ctx === 'cmd') {
    if (c === '[' && c1 === '[') {
      advance(L)
      advance(L)
      return { type: 'OP', value: '[[', start, end: L.b }
    }
    if (c === '[') {
      advance(L)
      return { type: 'OP', value: '[', start, end: L.b }
    }
    if (c === '{' && (c1 === ' ' || c1 === '\t' || c1 === '\n')) {
      advance(L)
      return { type: 'OP', value: '{', start, end: L.b }
    }
    if (c === '}') {
      advance(L)
      return { type: 'OP', value: '}', start, end: L.b }
    }
    if (c === '!' && (c1 === ' ' || c1 === '\t')) {
      advance(L)
      return { type: 'OP', value: '!', start, end: L.b }
    }
  }

  if (c === '"') {
    advance(L)
    return { type: 'DQUOTE', value: '"', start, end: L.b }
  }
  if (c === "'") {
    const si = L.i
    advance(L)
    while (L.i < L.len && L.src[L.i] !== "'") advance(L)
    if (L.i < L.len) advance(L)
    return {
      type: 'SQUOTE',
      value: L.src.slice(si, L.i),
      start,
      end: L.b,
    }
  }

  if (c === '$') {
    if (c1 === '(' && c2 === '(') {
      advance(L)
      advance(L)
      advance(L)
      return { type: 'DOLLAR_DPAREN', value: '$((', start, end: L.b }
    }
    if (c1 === '(') {
      advance(L)
      advance(L)
      return { type: 'DOLLAR_PAREN', value: '$(', start, end: L.b }
    }
    if (c1 === '{') {
      advance(L)
      advance(L)
      return { type: 'DOLLAR_BRACE', value: '${', start, end: L.b }
    }
    // ANSI-C 字符串 $'...'
      const si = L.i
      advance(L)
      advance(L)
      while (L.i < L.len && L.src[L.i] !== "'") {
        if (L.src[L.i] === '\\' && L.i + 1 < L.len) advance(L)
        advance(L)
      }
      if (L.i < L.len) advance(L)
      return {
        type: 'ANSI_C',
        value: L.src.slice(si, L.i),
        start,
        end: L.b,
      }
    }
    advance(L)
    return { type: 'DOLLAR', value: '$', start, end: L.b }
  }

  if (c === '`') {
    advance(L)
    return { type: 'BACKTICK', value: '`', start, end: L.b }
  }

  // 文件描述符（重定向前的数字）：紧跟 > 或 < 的数字序列
  if (isDigit(c)) {
    let j = L.i
    while (j < L.len && isDigit(L.src[j]!)) j++
    const after = j < L.len ? L.src[j]! : ''
    if (after === '>' || after === '<') {
      const si = L.i
      while (L.i < j) advance(L)
      return {
        type: 'WORD',
        value: L.src.slice(si, L.i),
        start,
        end: L.b,
      }
    }
  }

  // 单词 / 数字字面量
  if (isWordStart(c) || c === '{' || c === '}') {
    const si = L.i
    while (L.i < L.len) {
      const ch = L.src[L.i]!
      if (ch === '\\') {
        if (L.i + 1 >= L.len) {
          // 文件末尾孤立的 `\` —— tree-sitter 将其排除在单词之外并生成 ERROR 兄弟节点，
          // 在此停止以确保单词在 `\` 之前结束
          break
        }
        // 转义下一个字符（包括行续接 \<换行>）
        if (L.src[L.i + 1] === '\n') {
          advance(L)
          advance(L)
          continue
        }
        advance(L)
        advance(L)
        continue
      }
      if (!isWordChar(ch) && ch !== '{' && ch !== '}') {
        break
      }
      advance(L)
    }
    if (L.i > si) {
      const v = L.src.slice(si, L.i)
      // 数字字面量：可选负号加纯数字序列
      if (/^-?\d+$/.test(v)) {
        return { type: 'NUMBER', value: v, start, end: L.b }
      }
      return { type: 'WORD', value: v, start, end: L.b }
    }
    // 空单词（文件末孤立 `\`）—— 跳过，由后续单字符消费处理
  }

  // 未知字符 —— 消耗为单字符单词，确保词法器始终前进
  advance(L)
  return { type: 'WORD', value: c, start, end: L.b }
}

// ───────────────────────────── Parser ─────────────────────────────

/**
 * 解析器上下文，贯穿整个解析过程传递。
 * L：词法分析器；src/srcBytes：原始源码及其 UTF-8 字节长度；
 * isAscii：全 ASCII 时字节偏移 == 字符下标，可走快速路径；
 * nodeCount：已创建节点数，超出 MAX_NODES 时中止；
 * deadline：超时截止时间（performance.now() 毫秒）；
 * aborted：超时或预算耗尽时置为 true；
 * inBacktick：反引号嵌套深度，> 0 时 ` 作为终止符；
 * stopToken：当前 parseSimpleCommand 的停止 token（用于 [ 回溯）。
 */
  L: Lexer
  src: string
  srcBytes: number
  /** 全 ASCII 时字节偏移 == 字符下标（无多字节 UTF-8） */
  isAscii: boolean
  nodeCount: number
  deadline: number
  aborted: boolean
  /** 反引号嵌套深度 —— 在 `...` 内时 ` 作为终止符 */
  inBacktick: number
  /** 设置后 parseSimpleCommand 在该 token 处停止（用于 `[` 回溯） */
  stopToken: string | null
}

/**
 * 解析 Bash 源码字符串，返回 AST 根节点（program）；
 * 超时或发生异常时返回 null。
 * timeoutMs 默认 50ms（PARSE_TIMEOUT_MS），传入 Infinity 可禁用超时（用于测试）。
 */
function parseSource(source: string, timeoutMs?: number): TsNode | null {
  const L = makeLexer(source)
  const srcBytes = byteLengthUtf8(source)
  const P: ParseState = {
    L,
    src: source,
    srcBytes,
    isAscii: srcBytes === source.length,
    nodeCount: 0,
    deadline: performance.now() + (timeoutMs ?? PARSE_TIMEOUT_MS),
    aborted: false,
    inBacktick: 0,
    stopToken: null,
  }
  try {
    const program = parseProgram(P)
    if (P.aborted) return null
    return program
  } catch {
    return null
  }
}

/**
 * 计算字符串的 UTF-8 编码字节长度（无需实际编码）。
 * 用于初始化 ParseState.srcBytes 以构建程序根节点的字节范围。
 */
  let b = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 0x80) b++
    else if (c < 0x800) b += 2
    else if (c >= 0xd800 && c <= 0xdbff) {
      b += 4
      i++
    } else b += 3
  }
  return b
}

/**
 * 检查解析预算：每次创建节点时调用。
 * 超出 MAX_NODES 节点上限时抛出 'budget' 异常；
 * 每 128 个节点检查一次墙钟超时，超时时抛出 'timeout' 异常。
 */
  P.nodeCount++
  if (P.nodeCount > MAX_NODES) {
    P.aborted = true
    throw new Error('budget')
  }
  if ((P.nodeCount & 0x7f) === 0 && performance.now() > P.deadline) {
    P.aborted = true
    throw new Error('timeout')
  }
}

/**
 * 构建 AST 节点。通过字节范围在源码中查找对应字符区间并提取文本。
 * start/end 均为 UTF-8 字节偏移；ASCII 时直接切片，非 ASCII 时查表二分查找。
 */
function mk(
  P: ParseState,
  type: string,
  start: number,
  end: number,
  children: TsNode[],
): TsNode {
  checkBudget(P)
  return {
    type,
    text: sliceBytes(P, start, end),
    startIndex: start,
    endIndex: end,
    children,
  }
}

/**
 * 从源码中提取 [startByte, endByte) 字节范围对应的字符串。
 * ASCII 快速路径直接切片；非 ASCII 时构建 byteTable 后二分查找字符边界。
 */
function sliceBytes(P: ParseState, startByte: number, endByte: number): string {
  if (P.isAscii) return P.src.slice(startByte, endByte)
  // 查找字节偏移对应的字符下标，如需先构建 byteTable
  const L = P.L
  if (!L.byteTable) byteAt(L, 0)
  const t = L.byteTable!
  // 二分查找：找到字节偏移 startByte 对应的字符下标
  let lo = 0
  let hi = P.src.length
  while (lo < hi) {
    const m = (lo + hi) >>> 1
    if (t[m]! < startByte) lo = m + 1
    else hi = m
  }
  const sc = lo
  lo = sc
  hi = P.src.length
  while (lo < hi) {
    const m = (lo + hi) >>> 1
    if (t[m]! < endByte) lo = m + 1
    else hi = m
  }
  return P.src.slice(sc, lo)
}

/** 根据 Token 构建叶子节点（无子节点的终端节点）。 */
function leaf(P: ParseState, type: string, tok: Token): TsNode {
  return mk(P, type, tok.start, tok.end, [])
}

/**
 * 解析整个 Bash 程序，返回 program 根节点。
 * 跳过顶层注释和空行后开始解析语句序列；无法解析时发出 ERROR 节点并跳过一个 token。
 * tree-sitter 规范：program 节点的字节范围覆盖首尾空白。
 */
  const children: TsNode[] = []
  // 跳过前导空白和换行 —— program 起始位置为第一个实际内容的字节偏移
  skipBlanks(P.L)
  while (true) {
    const save = saveLex(P.L)
    const t = nextToken(P.L, 'cmd')
    if (t.type === 'NEWLINE') {
      skipBlanks(P.L)
      continue
    }
    restoreLex(P.L, save)
    break
  }
  const progStart = P.L.b
  while (P.L.i < P.L.len) {
    const save = saveLex(P.L)
    const t = nextToken(P.L, 'cmd')
    if (t.type === 'EOF') break
    if (t.type === 'NEWLINE') continue
    if (t.type === 'COMMENT') {
      children.push(leaf(P, 'comment', t))
      continue
    }
    restoreLex(P.L, save)
    const stmts = parseStatements(P, null)
    for (const s of stmts) children.push(s)
    if (stmts.length === 0) {
      // 无法解析 —— 发出 ERROR 节点并跳过一个 token
      const errTok = nextToken(P.L, 'cmd')
      if (errTok.type === 'EOF') break
      // 顶层游离的 `;;`（如 `var=;;` 出现在 case 外）—— tree-sitter 静默忽略。
      // 保留前导 `;` 作为 ERROR（安全性：防止粘贴产物逃逸）
      if (
        errTok.type === 'OP' &&
        errTok.value === ';;' &&
        children.length > 0
      ) {
        continue
      }
      children.push(mk(P, 'ERROR', errTok.start, errTok.end, []))
    }
  }
  // tree-sitter 将尾部空白计入 program 节点范围
  const progEnd = children.length > 0 ? P.srcBytes : progStart
  return mk(P, 'program', progStart, progEnd, children)
}

/**
 * 词法状态保存点，压缩为单个整数以避免每次回溯时的堆分配。
 * 编码方式：(b << 16) | i，其中 b 为字节偏移，i 为字符下标。
 * 适用于 b < 65536 字节的脚本；超大脚本极罕见，不影响安全性。
 */
type LexSave = number
/** 保存当前词法位置为压缩整数，用于后续回溯。 */
function saveLex(L: Lexer): LexSave {
  return L.b * 0x10000 + L.i
}
/** 从保存点恢复词法位置（解压缩字节偏移和字符下标）。 */
function restoreLex(L: Lexer, s: LexSave): void {
  L.i = s & 0xffff
  L.b = s >>> 16
}

/**
 * 解析由 ; & 换行分隔的语句序列，返回展平的节点列表。
 * ; 和 & 作为兄弟叶子节点保留（不包裹为 'list'，只有 && || 才这样做）。
 * 在遇到 terminator、EOF、闭合操作符或关键字（then/fi/do/done/esac 等）时停止。
 */
function parseStatements(P: ParseState, terminator: string | null): TsNode[] {
  const out: TsNode[] = []
  while (true) {
    skipBlanks(P.L)
    const save = saveLex(P.L)
    const t = nextToken(P.L, 'cmd')
    if (t.type === 'EOF') {
      restoreLex(P.L, save)
      break
    }
    if (t.type === 'NEWLINE') {
      // 遇到换行时处理所有待扫描的 heredoc 正文
      if (P.L.heredocs.length > 0) {
        scanHeredocBodies(P)
      }
      continue
    }
    if (t.type === 'COMMENT') {
      out.push(leaf(P, 'comment', t))
      continue
    }
    if (terminator && t.type === 'OP' && t.value === terminator) {
      restoreLex(P.L, save)
      break
    }
    if (
      t.type === 'OP' &&
      (t.value === ')' ||
        t.value === '}' ||
        t.value === ';;' ||
        t.value === ';&' ||
        t.value === ';;&' ||
        t.value === '))' ||
        t.value === ']]' ||
        t.value === ']')
    ) {
      restoreLex(P.L, save)
      break
    }
    if (t.type === 'BACKTICK' && P.inBacktick > 0) {
      restoreLex(P.L, save)
      break
    }
    if (
      t.type === 'WORD' &&
      (t.value === 'then' ||
        t.value === 'elif' ||
        t.value === 'else' ||
        t.value === 'fi' ||
        t.value === 'do' ||
        t.value === 'done' ||
        t.value === 'esac')
    ) {
      restoreLex(P.L, save)
      break
    }
    restoreLex(P.L, save)
    const stmt = parseAndOr(P)
    if (!stmt) break
    out.push(stmt)
    // 查找分隔符
    skipBlanks(P.L)
    const save2 = saveLex(P.L)
    const sep = nextToken(P.L, 'cmd')
    if (sep.type === 'OP' && (sep.value === ';' || sep.value === '&')) {
      // 检查是否紧跟终止符 —— 若是，则发出分隔符后停止
      const save3 = saveLex(P.L)
      const after = nextToken(P.L, 'cmd')
      restoreLex(P.L, save3)
      out.push(leaf(P, sep.value, sep))
      if (
        after.type === 'EOF' ||
        (after.type === 'OP' &&
          (after.value === ')' ||
            after.value === '}' ||
            after.value === ';;' ||
            after.value === ';&' ||
            after.value === ';;&')) ||
        (after.type === 'WORD' &&
          (after.value === 'then' ||
            after.value === 'elif' ||
            after.value === 'else' ||
            after.value === 'fi' ||
            after.value === 'do' ||
            after.value === 'done' ||
            after.value === 'esac'))
      ) {
    // 尾部分隔符处理：不在顶层保留，但内层保留
        continue
      }
    } else if (sep.type === 'NEWLINE') {
      if (P.L.heredocs.length > 0) {
        scanHeredocBodies(P)
      }
      continue
    } else {
      restoreLex(P.L, save2)
    }
  }
  // 若在顶层，裁剪末尾的分隔符
  return out
}

/**
 * 解析由 && || 连接的管道链，构建左结合的 list 节点。
 * tree-sitter 特殊行为：最后一个管道的尾部重定向会将整个 list 包裹在
 * redirected_statement 中 —— 例如 `a > x && b > y` 生成
 * redirected_statement(list(redirected_statement(a,>x), &&, b), >y)。
 */
function parseAndOr(P: ParseState): TsNode | null {
  let left = parsePipeline(P)
  if (!left) return null
  while (true) {
    const save = saveLex(P.L)
    const t = nextToken(P.L, 'cmd')
    if (t.type === 'OP' && (t.value === '&&' || t.value === '||')) {
      const op = leaf(P, t.value, t)
      skipNewlines(P)
      const right = parsePipeline(P)
      if (!right) {
        left = mk(P, 'list', left.startIndex, op.endIndex, [left, op])
        break
      }
      // 若右侧为 redirected_statement，将其重定向提升以包裹整个 list 节点
      if (right.type === 'redirected_statement' && right.children.length >= 2) {
        const inner = right.children[0]!
        const redirs = right.children.slice(1)
        const listNode = mk(P, 'list', left.startIndex, inner.endIndex, [
          left,
          op,
          inner,
        ])
        const lastR = redirs[redirs.length - 1]!
        left = mk(
          P,
          'redirected_statement',
          listNode.startIndex,
          lastR.endIndex,
          [listNode, ...redirs],
        )
      } else {
        left = mk(P, 'list', left.startIndex, right.endIndex, [left, op, right])
      }
    } else {
      restoreLex(P.L, save)
      break
    }
  }
  return left
}

/** 跳过零个或多个换行符（解析 && || 后右侧可能有多个换行）。 */
function skipNewlines(P: ParseState): void {
  while (true) {
    const save = saveLex(P.L)
    const t = nextToken(P.L, 'cmd')
    if (t.type !== 'NEWLINE') {
      restoreLex(P.L, save)
      break
    }
  }
}

/**
 * 解析由 | 或 |& 连接的命令管道，子节点展平存储（操作符也作为叶子节点）。
 * tree-sitter 特殊行为：`a | b 2>nul | c` 中 b 的重定向会提升并包裹前段管道：
 * pipeline(redirected_statement(pipeline(a,|,b), 2>nul), |, c)。
 */
function parsePipeline(P: ParseState): TsNode | null {
  let first = parseCommand(P)
  if (!first) return null
  const parts: TsNode[] = [first]
  while (true) {
    const save = saveLex(P.L)
    const t = nextToken(P.L, 'cmd')
    if (t.type === 'OP' && (t.value === '|' || t.value === '|&')) {
      const op = leaf(P, t.value, t)
      skipNewlines(P)
      const next = parseCommand(P)
      if (!next) {
        parts.push(op)
        break
      }
      // 将 next 的尾部重定向提升，包裹当前管道片段
      if (
        next.type === 'redirected_statement' &&
        next.children.length >= 2 &&
        parts.length >= 1
      ) {
        const inner = next.children[0]!
        const redirs = next.children.slice(1)
        // 将已有片段 + op + inner 包裹为管道节点
        const pipeKids = [...parts, op, inner]
        const pipeNode = mk(
          P,
          'pipeline',
          pipeKids[0]!.startIndex,
          inner.endIndex,
          pipeKids,
        )
        const lastR = redirs[redirs.length - 1]!
        const wrapped = mk(
          P,
          'redirected_statement',
          pipeNode.startIndex,
          lastR.endIndex,
          [pipeNode, ...redirs],
        )
        parts.length = 0
        parts.push(wrapped)
        first = wrapped
        continue
      }
      parts.push(op, next)
    } else {
      restoreLex(P.L, save)
      break
    }
  }
  if (parts.length === 1) return parts[0]!
  const last = parts[parts.length - 1]!
  return mk(P, 'pipeline', parts[0]!.startIndex, last.endIndex, parts)
}

/**
 * 解析单条命令：简单命令、复合命令或控制结构。
 * 优先处理 !（取反）、(（子 shell）、((（算术）、{（组命令）、[ [[（test）；
 * 然后检查控制流关键字（if/while/for/case/function 等）；
 * 最后回退到 parseSimpleCommand。
 */
function parseCommand(P: ParseState): TsNode | null {
  skipBlanks(P.L)
  const save = saveLex(P.L)
  const t = nextToken(P.L, 'cmd')

  if (t.type === 'EOF') {
    restoreLex(P.L, save)
    return null
  }

  // 取反命令 —— tree-sitter 仅包裹命令本体，重定向置于外层：
  // `! cmd > out` → redirected_statement(negated_command(!, cmd), >out)
  if (t.type === 'OP' && t.value === '!') {
    const bang = leaf(P, '!', t)
    const inner = parseCommand(P)
    if (!inner) {
      restoreLex(P.L, save)
      return null
    }
    // 若内层已经是 redirected_statement，将重定向提升到取反命令之外
    if (inner.type === 'redirected_statement' && inner.children.length >= 2) {
      const cmd = inner.children[0]!
      const redirs = inner.children.slice(1)
      const neg = mk(P, 'negated_command', bang.startIndex, cmd.endIndex, [
        bang,
        cmd,
      ])
      const lastR = redirs[redirs.length - 1]!
      return mk(P, 'redirected_statement', neg.startIndex, lastR.endIndex, [
        neg,
        ...redirs,
      ])
    }
    return mk(P, 'negated_command', bang.startIndex, inner.endIndex, [
      bang,
      inner,
    ])
  }

  if (t.type === 'OP' && t.value === '(') {
    const open = leaf(P, '(', t)
    const body = parseStatements(P, ')')
    const closeTok = nextToken(P.L, 'cmd')
    const close =
      closeTok.type === 'OP' && closeTok.value === ')'
        ? leaf(P, ')', closeTok)
        : mk(P, ')', open.endIndex, open.endIndex, [])
    const node = mk(P, 'subshell', open.startIndex, close.endIndex, [
      open,
      ...body,
      close,
    ])
    return maybeRedirect(P, node)
  }

  if (t.type === 'OP' && t.value === '((') {
    const open = leaf(P, '((', t)
    const exprs = parseArithCommaList(P, '))', 'var')
    const closeTok = nextToken(P.L, 'cmd')
    const close =
      closeTok.value === '))'
        ? leaf(P, '))', closeTok)
        : mk(P, '))', open.endIndex, open.endIndex, [])
    return mk(P, 'compound_statement', open.startIndex, close.endIndex, [
      open,
      ...exprs,
      close,
    ])
  }

  if (t.type === 'OP' && t.value === '{') {
    const open = leaf(P, '{', t)
    const body = parseStatements(P, '}')
    const closeTok = nextToken(P.L, 'cmd')
    const close =
      closeTok.type === 'OP' && closeTok.value === '}'
        ? leaf(P, '}', closeTok)
        : mk(P, '}', open.endIndex, open.endIndex, [])
    const node = mk(P, 'compound_statement', open.startIndex, close.endIndex, [
      open,
      ...body,
      close,
    ])
    return maybeRedirect(P, node)
  }

  if (t.type === 'OP' && (t.value === '[' || t.value === '[[')) {
    const open = leaf(P, t.value, t)
    const closer = t.value === '[' ? ']' : ']]'
    // 语法：`[` 内容可为 _expression 或 redirected_statement。
    // 优先尝试 _expression；若解析后未到达 `]`，回溯并尝试解析为 redirected_statement
    // （处理 `[ ! cmd -v go &>/dev/null ]` 等模式）
    const exprSave = saveLex(P.L)
    let expr = parseTestExpr(P, closer)
    skipBlanks(P.L)
    if (t.value === '[' && peek(P.L) !== ']') {
      // 表达式解析未能到达 `]` —— 改为解析 redirected_statement。
      // 传入 `]` stop-token，防止 parseSimpleCommand 将 `]` 作为参数吃掉
      restoreLex(P.L, exprSave)
      const prevStop = P.stopToken
      P.stopToken = ']'
      const rstmt = parseCommand(P)
      P.stopToken = prevStop
      if (rstmt && rstmt.type === 'redirected_statement') {
        expr = rstmt
      } else {
        // 两种方式均失败 —— 恢复并使用表达式解析结果
        restoreLex(P.L, exprSave)
        expr = parseTestExpr(P, closer)
      }
      skipBlanks(P.L)
    }
    const closeTok = nextToken(P.L, 'arg')
    let close: TsNode
    if (closeTok.value === closer) {
      close = leaf(P, closer, closeTok)
    } else {
      close = mk(P, closer, open.endIndex, open.endIndex, [])
    }
    const kids = expr ? [open, expr, close] : [open, close]
    return mk(P, 'test_command', open.startIndex, close.endIndex, kids)
  }

  if (t.type === 'WORD') {
    if (t.value === 'if') return maybeRedirect(P, parseIf(P, t), true)
    if (t.value === 'while' || t.value === 'until')
      return maybeRedirect(P, parseWhile(P, t), true)
    if (t.value === 'for') return maybeRedirect(P, parseFor(P, t), true)
    if (t.value === 'select') return maybeRedirect(P, parseFor(P, t), true)
    if (t.value === 'case') return maybeRedirect(P, parseCase(P, t), true)
    if (t.value === 'function') return parseFunction(P, t)
    if (DECL_KEYWORDS.has(t.value))
      return maybeRedirect(P, parseDeclaration(P, t))
    if (t.value === 'unset' || t.value === 'unsetenv') {
      return maybeRedirect(P, parseUnset(P, t))
    }
  }

  restoreLex(P.L, save)
  return parseSimpleCommand(P)
}

/**
 * 解析简单命令：[赋值]* 命令名 [参数|重定向]*。
 * 若只有单个赋值而无命令名，则直接返回 variable_assignment 节点；
 * 支持检测函数定义（name() { ... }）并返回 function_definition 节点。
 */
function parseSimpleCommand(P: ParseState): TsNode | null {
  const start = P.L.b
  const assignments: TsNode[] = []
  const preRedirects: TsNode[] = []

  while (true) {
    skipBlanks(P.L)
    const a = tryParseAssignment(P)
    if (a) {
      assignments.push(a)
      continue
    }
    const r = tryParseRedirect(P)
    if (r) {
      preRedirects.push(r)
      continue
    }
    break
  }

  skipBlanks(P.L)
  const save = saveLex(P.L)
  const nameTok = nextToken(P.L, 'cmd')
  if (
    nameTok.type === 'EOF' ||
    nameTok.type === 'NEWLINE' ||
    nameTok.type === 'COMMENT' ||
    (nameTok.type === 'OP' &&
      nameTok.value !== '{' &&
      nameTok.value !== '[' &&
      nameTok.value !== '[[') ||
    (nameTok.type === 'WORD' &&
      SHELL_KEYWORDS.has(nameTok.value) &&
      nameTok.value !== 'in')
  ) {
    restoreLex(P.L, save)
    // 无命令名 —— 仅有独立赋值或重定向
    if (assignments.length === 1 && preRedirects.length === 0) {
      return assignments[0]!
    }
    if (preRedirects.length > 0 && assignments.length === 0) {
      // 裸重定向 → 仅含 file_redirect 子节点的 redirected_statement
      const last = preRedirects[preRedirects.length - 1]!
      return mk(
        P,
        'redirected_statement',
        preRedirects[0]!.startIndex,
        last.endIndex,
        preRedirects,
      )
    }
    if (assignments.length > 1 && preRedirects.length === 0) {
      // `A=1 B=2` 无命令名 → variable_assignments（复数）
      const last = assignments[assignments.length - 1]!
      return mk(
        P,
        'variable_assignments',
        assignments[0]!.startIndex,
        last.endIndex,
        assignments,
      )
    }
    if (assignments.length > 0 || preRedirects.length > 0) {
      const all = [...assignments, ...preRedirects]
      const last = all[all.length - 1]!
      return mk(P, 'command', start, last.endIndex, all)
    }
    return null
  }
  restoreLex(P.L, save)

  // 检查函数定义：name() { ... }
  const fnSave = saveLex(P.L)
  const nm = parseWord(P, 'cmd')
  if (nm && nm.type === 'word') {
    skipBlanks(P.L)
    if (peek(P.L) === '(' && peek(P.L, 1) === ')') {
      const oTok = nextToken(P.L, 'cmd')
      const cTok = nextToken(P.L, 'cmd')
      const oParen = leaf(P, '(', oTok)
      const cParen = leaf(P, ')', cTok)
      skipBlanks(P.L)
      skipNewlines(P)
      const body = parseCommand(P)
      if (body) {
      // 若函数体已经是 redirected_statement(compound_statement, file_redirect...)，
      // 按 tree-sitter 语法将重定向提升到 function_definition 层级
        let bodyKids: TsNode[] = [body]
        if (
          body.type === 'redirected_statement' &&
          body.children.length >= 2 &&
          body.children[0]!.type === 'compound_statement'
        ) {
          bodyKids = body.children
        }
        const last = bodyKids[bodyKids.length - 1]!
        return mk(P, 'function_definition', nm.startIndex, last.endIndex, [
          nm,
          oParen,
          cParen,
          ...bodyKids,
        ])
      }
    }
  }
  restoreLex(P.L, fnSave)

  const nameArg = parseWord(P, 'cmd')
  if (!nameArg) {
    if (assignments.length === 1) return assignments[0]!
    return null
  }

  const cmdName = mk(P, 'command_name', nameArg.startIndex, nameArg.endIndex, [
    nameArg,
  ])

  const args: TsNode[] = []
  const redirects: TsNode[] = []
  let heredocRedirect: TsNode | null = null

  while (true) {
    skipBlanks(P.L)
    // 命令名后的重定向是贪婪的（repeat1 $._literal）——
    // 一旦出现重定向，后续字面量都挂到该重定向下（语法的 prec.left）：
    // `grep 2>/dev/null -q foo` → file_redirect 吃掉 `-q foo`。
    // 在第一个重定向前解析的参数仍属于命令（cat a b > out 正常工作）
    const r = tryParseRedirect(P, true)
    if (r) {
      if (r.type === 'heredoc_redirect') {
        heredocRedirect = r
      } else if (r.type === 'herestring_redirect') {
        args.push(r)
      } else {
        redirects.push(r)
      }
      continue
    }
    // 出现 file_redirect 后命令参数解析结束 —— 语法的 command 规则在命令名后
    // 不允许 file_redirect，后续内容属于 redirected_statement 的子节点
    if (redirects.length > 0) break
    // `[` test_command 回溯 —— 在 `]` 处停止，让外层处理器消费它
    if (P.stopToken === ']' && peek(P.L) === ']') break
    const save2 = saveLex(P.L)
    const pk = nextToken(P.L, 'arg')
    if (
      pk.type === 'EOF' ||
      pk.type === 'NEWLINE' ||
      pk.type === 'COMMENT' ||
      (pk.type === 'OP' &&
        (pk.value === '|' ||
          pk.value === '|&' ||
          pk.value === '&&' ||
          pk.value === '||' ||
          pk.value === ';' ||
          pk.value === ';;' ||
          pk.value === ';&' ||
          pk.value === ';;&' ||
          pk.value === '&' ||
          pk.value === ')' ||
          pk.value === '}' ||
          pk.value === '))'))
    ) {
      restoreLex(P.L, save2)
      break
    }
    restoreLex(P.L, save2)
    const arg = parseWord(P, 'arg')
    if (!arg) {
      // arg 位置的孤立 `(` —— tree-sitter 将其解析为 subshell 参数：
      // 例如 `echo =(cmd)` → command 含 ERROR(=)、subshell(cmd) 作为参数
      if (peek(P.L) === '(') {
        const oTok = nextToken(P.L, 'cmd')
        const open = leaf(P, '(', oTok)
        const body = parseStatements(P, ')')
        const cTok = nextToken(P.L, 'cmd')
        const close =
          cTok.type === 'OP' && cTok.value === ')'
            ? leaf(P, ')', cTok)
            : mk(P, ')', open.endIndex, open.endIndex, [])
        args.push(
          mk(P, 'subshell', open.startIndex, close.endIndex, [
            open,
            ...body,
            close,
          ]),
        )
        continue
      }
      break
    }
    // arg 位置的孤立 `=` 是 bash 解析错误 —— tree-sitter 用 ERROR 包裹恢复。
    // 在 `echo =(cmd)` (zsh 进程替换) 等场景中出现
    if (arg.type === 'word' && arg.text === '=') {
      args.push(mk(P, 'ERROR', arg.startIndex, arg.endIndex, [arg]))
      continue
    }
    // 单词紧跟 `(` 时（无空白）是解析错误 —— bash 不允许 glob-then-subshell 紧邻。
    // tree-sitter 用 ERROR 包裹该单词。捕获 zsh glob 限定符如 `*.(e:'cmd':)`
    if (
      (arg.type === 'word' || arg.type === 'concatenation') &&
      peek(P.L) === '(' &&
      P.L.b === arg.endIndex
    ) {
      args.push(mk(P, 'ERROR', arg.startIndex, arg.endIndex, [arg]))
      continue
    }
    args.push(arg)
  }

  // preRedirects（如 `2>&1 cat`、`<<<str cmd`）按 tree-sitter 语法位于命令节点内
  // 的 command_name 之前，而非在 redirected_statement 层级
  const cmdChildren = [...assignments, ...preRedirects, cmdName, ...args]
  const cmdEnd =
    cmdChildren.length > 0
      ? cmdChildren[cmdChildren.length - 1]!.endIndex
      : cmdName.endIndex
  const cmdStart = cmdChildren[0]!.startIndex
  const cmd = mk(P, 'command', cmdStart, cmdEnd, cmdChildren)

  if (heredocRedirect) {
    // 立即扫描 heredoc 正文，将 body/end 节点追加到 heredoc_redirect 子节点中
    scanHeredocBodies(P)
    const hd = P.L.heredocs.shift()
    if (hd && heredocRedirect.children.length >= 2) {
      const bodyNode = mk(
        P,
        'heredoc_body',
        hd.bodyStart,
        hd.bodyEnd,
        hd.quoted ? [] : parseHeredocBodyContent(P, hd.bodyStart, hd.bodyEnd),
      )
      const endNode = mk(P, 'heredoc_end', hd.endStart, hd.endEnd, [])
      heredocRedirect.children.push(bodyNode, endNode)
      heredocRedirect.endIndex = hd.endEnd
      heredocRedirect.text = sliceBytes(
        P,
        heredocRedirect.startIndex,
        hd.endEnd,
      )
    }
    const allR = [...preRedirects, heredocRedirect, ...redirects]
    const rStart =
      preRedirects.length > 0
        ? Math.min(cmd.startIndex, preRedirects[0]!.startIndex)
        : cmd.startIndex
    return mk(P, 'redirected_statement', rStart, heredocRedirect.endIndex, [
      cmd,
      ...allR,
    ])
  }

  if (redirects.length > 0) {
    const last = redirects[redirects.length - 1]!
    return mk(P, 'redirected_statement', cmd.startIndex, last.endIndex, [
      cmd,
      ...redirects,
    ])
  }

  return cmd
}

/**
 * 尝试在 node 后附加重定向，若存在则返回 redirected_statement；否则返回原节点。
 * allowHerestring 为 true 时允许 herestring_redirect（用于控制结构）。
 */
function maybeRedirect(
  P: ParseState,
  node: TsNode,
  allowHerestring = false,
): TsNode {
  const redirects: TsNode[] = []
  while (true) {
    skipBlanks(P.L)
    const save = saveLex(P.L)
    const r = tryParseRedirect(P)
    if (!r) break
    if (r.type === 'herestring_redirect' && !allowHerestring) {
      restoreLex(P.L, save)
      break
    }
    redirects.push(r)
  }
  if (redirects.length === 0) return node
  const last = redirects[redirects.length - 1]!
  return mk(P, 'redirected_statement', node.startIndex, last.endIndex, [
    node,
    ...redirects,
  ])
}

/**
 * 尝试解析变量赋值语句（identifier[subscript]?[+]=value）。
 * 必须以标识符起始，后跟 = 或 += 操作符才构成赋值；否则回溯并返回 null。
 */
function tryParseAssignment(P: ParseState): TsNode | null {
  const save = saveLex(P.L)
  skipBlanks(P.L)
  const startB = P.L.b
  // 赋值语句必须以标识符起始
  if (!isIdentStart(peek(P.L))) {
    restoreLex(P.L, save)
    return null
  }
  while (isIdentChar(peek(P.L))) advance(P.L)
  const nameEnd = P.L.b
  // 可选下标 [index]（如 arr[0]=value 或 map[key]=value）
  let subEnd = nameEnd
  if (peek(P.L) === '[') {
    advance(P.L)
    let depth = 1
    while (P.L.i < P.L.len && depth > 0) {
      const c = peek(P.L)
      if (c === '[') depth++
      else if (c === ']') depth--
      advance(P.L)
    }
    subEnd = P.L.b
  }
  const c = peek(P.L)
  const c1 = peek(P.L, 1)
  let op: string
  if (c === '=' && c1 !== '=') {
    op = '='
  } else if (c === '+' && c1 === '=') {
    op = '+='
  } else {
    restoreLex(P.L, save)
    return null
  }
  const nameNode = mk(P, 'variable_name', startB, nameEnd, [])
  // 若存在下标部分，将标识符节点包裹进 subscript 节点
  let lhs: TsNode = nameNode
  if (subEnd > nameEnd) {
    const brOpen = mk(P, '[', nameEnd, nameEnd + 1, [])
    const idx = parseSubscriptIndex(P, nameEnd + 1, subEnd - 1)
    const brClose = mk(P, ']', subEnd - 1, subEnd, [])
    lhs = mk(P, 'subscript', startB, subEnd, [nameNode, brOpen, idx, brClose])
  }
  const opStart = P.L.b
  advance(P.L)
  if (op === '+=') advance(P.L)
  const opEnd = P.L.b
  const opNode = mk(P, op, opStart, opEnd, [])
  let val: TsNode | null = null
  if (peek(P.L) === '(') {
    // 数组赋值：arr=(elem1 elem2 ...)
    const aoTok = nextToken(P.L, 'cmd')
    const aOpen = leaf(P, '(', aoTok)
    const elems: TsNode[] = [aOpen]
    while (true) {
      skipBlanks(P.L)
      if (peek(P.L) === ')') break
      const e = parseWord(P, 'arg')
      if (!e) break
      elems.push(e)
    }
    const acTok = nextToken(P.L, 'cmd')
    const aClose =
      acTok.value === ')'
        ? leaf(P, ')', acTok)
        : mk(P, ')', aOpen.endIndex, aOpen.endIndex, [])
    elems.push(aClose)
    val = mk(P, 'array', aOpen.startIndex, aClose.endIndex, elems)
  } else {
    const c2 = peek(P.L)
    if (
      c2 &&
      c2 !== ' ' &&
      c2 !== '\t' &&
      c2 !== '\n' &&
      c2 !== ';' &&
      c2 !== '&' &&
      c2 !== '|' &&
      c2 !== ')' &&
      c2 !== '}'
    ) {
      val = parseWord(P, 'arg')
    }
  }
  const kids = val ? [lhs, opNode, val] : [lhs, opNode]
  const end = val ? val.endIndex : opEnd
  return mk(P, 'variable_assignment', startB, end, kids)
}

/**
 * 解析下标索引内容（内联版，用于扩展表达式中的 `${a[…]}` 语法）。
 * 按 tree-sitter grammar 的算术规则解析：
 * - `@ / *` 单独出现 → word（关联数组全部键）
 * - `(( expr ))` → compound_statement 包裹内部算术表达式
 * - 其他情况 → parseArithExpr（'word' 模式，裸标识符视为 word）
 */
function parseSubscriptIndexInline(P: ParseState): TsNode | null {
  skipBlanks(P.L)
  const c = peek(P.L)
  // @ 或 * 单独出现 → word（如 ${arr[@]} / ${arr[*]}）
  if ((c === '@' || c === '*') && peek(P.L, 1) === ']') {
    const s = P.L.b
    advance(P.L)
    return mk(P, 'word', s, P.L.b, [])
  }
  // (( expr )) → compound_statement 包裹内部算术表达式
  if (c === '(' && peek(P.L, 1) === '(') {
    const oStart = P.L.b
    advance(P.L)
    advance(P.L)
    const open = mk(P, '((', oStart, P.L.b, [])
    const inner = parseArithExpr(P, '))', 'var')
    skipBlanks(P.L)
    let close: TsNode
    if (peek(P.L) === ')' && peek(P.L, 1) === ')') {
      const cs = P.L.b
      advance(P.L)
      advance(P.L)
      close = mk(P, '))', cs, P.L.b, [])
    } else {
      close = mk(P, '))', P.L.b, P.L.b, [])
    }
    const kids = inner ? [open, inner, close] : [open, close]
    return mk(P, 'compound_statement', open.startIndex, close.endIndex, kids)
  }
  // 算术表达式模式：裸标识符在下标中视为 word（与 tree-sitter 一致）
  // 如 ${words[++counter]} → unary_expression(word)
  return parseArithExpr(P, ']', 'word')
}

/**
 * 旧版字节范围下标索引解析器（供预先扫描的调用方使用）。
 * 按文本内容判断类型：纯数字 → number，$var → simple_expansion，其他 → word。
 */
function parseSubscriptIndex(
  P: ParseState,
  startB: number,
  endB: number,
): TsNode {
  const text = sliceBytes(P, startB, endB)
  if (/^\d+$/.test(text)) return mk(P, 'number', startB, endB, [])
  const m = /^\$([a-zA-Z_]\w*)$/.exec(text)
  if (m) {
    const dollar = mk(P, '$', startB, startB + 1, [])
    const vn = mk(P, 'variable_name', startB + 1, endB, [])
    return mk(P, 'simple_expansion', startB, endB, [dollar, vn])
  }
  if (text.length === 2 && text[0] === '$' && SPECIAL_VARS.has(text[1]!)) {
    const dollar = mk(P, '$', startB, startB + 1, [])
    const vn = mk(P, 'special_variable_name', startB + 1, endB, [])
    return mk(P, 'simple_expansion', startB, endB, [dollar, vn])
  }
  return mk(P, 'word', startB, endB, [])
}

/**
 * 判断当前位置是否可以作为重定向目标字面量的起始位置。
 * 遇到重定向操作符、命令终止符、或文件描述符前缀时返回 false，
 * 确保 file_redirect 的 repeat1($._literal) 在正确边界停止。
 */
function isRedirectLiteralStart(P: ParseState): boolean {
  const c = peek(P.L)
  if (c === '' || c === '\n') return false
  // Shell 终止符和操作符
  if (c === '|' || c === '&' || c === ';' || c === '(' || c === ')')
    return false
  // 重定向操作符（< > 及其变体；<( >( 进程替换由调用方处理）
  if (c === '<' || c === '>') {
    // <( >( 是进程替换 — 这些属于字面量，允许通过
    return peek(P.L, 1) === '('
  }
  // N< N> 文件描述符前缀 — 开始新的重定向，不是字面量
  if (isDigit(c)) {
    let j = P.L.i
    while (j < P.L.len && isDigit(P.L.src[j]!)) j++
    const after = j < P.L.len ? P.L.src[j]! : ''
    if (after === '>' || after === '<') return false
  }
  // `}` 在顶层会终止 compound_statement — 需要在此停止
  if (c === '}') return false
  // 测试命令关闭符 — 当 parseSimpleCommand 从 `[` 上下文调用时，
  // `]` 必须终止，以便 parseCommand 返回并由 `[` 处理器消费
  if (P.stopToken === ']' && c === ']') return false
  return true
}

/**
 * 解析重定向操作符及其目标字面量。
 * @param greedy 为 true 时，file_redirect 按语法的 prec.left 贪婪消费多个字面量
 *   （如 `cmd >f a b c` 中 `a b c` 均附属于重定向）。
 *   为 false（preRedirect 上下文）时仅取 1 个目标，
 *   因为 command 的动态优先级高于 redirected_statement 的 prec(-1)。
 */
function tryParseRedirect(P: ParseState, greedy = false): TsNode | null {
  const save = saveLex(P.L)
  skipBlanks(P.L)
  // 文件描述符前缀（如 2> 或 1<）
  let fd: TsNode | null = null
  if (isDigit(peek(P.L))) {
    const startB = P.L.b
    let j = P.L.i
    while (j < P.L.len && isDigit(P.L.src[j]!)) j++
    const after = j < P.L.len ? P.L.src[j]! : ''
    if (after === '>' || after === '<') {
      while (P.L.i < j) advance(P.L)
      fd = mk(P, 'file_descriptor', startB, P.L.b, [])
    }
  }
  const t = nextToken(P.L, 'arg')
  if (t.type !== 'OP') {
    restoreLex(P.L, save)
    return null
  }
  const v = t.value
  if (v === '<<<') {
    const op = leaf(P, '<<<', t)
    skipBlanks(P.L)
    const target = parseWord(P, 'arg')
    const end = target ? target.endIndex : op.endIndex
    const kids = target ? [op, target] : [op]
    return mk(
      P,
      'herestring_redirect',
      fd ? fd.startIndex : op.startIndex,
      end,
      fd ? [fd, ...kids] : kids,
    )
  }
  if (v === '<<' || v === '<<-') {
    const op = leaf(P, v, t)
    // Heredoc 起始 — 分隔符单词（可能带引号，引号控制主体是否展开变量）
    skipBlanks(P.L)
    const dStart = P.L.b
    let quoted = false
    let delim = ''
    const dc = peek(P.L)
    if (dc === "'" || dc === '"') {
      quoted = true
      advance(P.L)
      while (P.L.i < P.L.len && peek(P.L) !== dc) {
        delim += peek(P.L)
        advance(P.L)
      }
      if (P.L.i < P.L.len) advance(P.L)
    } else if (dc === '\\') {
      // 反斜杠转义分隔符：\X — 恰好一个转义字符，主体为字面量（已引号）
      // 涵盖 <<\EOF <<\' <<\\ 等形式
      quoted = true
      advance(P.L)
      if (P.L.i < P.L.len && peek(P.L) !== '\n') {
        delim += peek(P.L)
        advance(P.L)
      }
      // 后面可能跟随更多标识符字符（如 <<\EOF → 分隔符为 "EOF"）
      while (P.L.i < P.L.len && isIdentChar(peek(P.L))) {
        delim += peek(P.L)
        advance(P.L)
      }
    } else {
      // 未引号的分隔符：bash 接受大多数非元字符（不限于标识符）
      // 允许 !、-、. 等字符 — 遇到 shell 元字符时停止
      while (P.L.i < P.L.len && isHeredocDelimChar(peek(P.L))) {
        delim += peek(P.L)
        advance(P.L)
      }
    }
    const dEnd = P.L.b
    const startNode = mk(P, 'heredoc_start', dStart, dEnd, [])
    // 注册待扫描的 heredoc — 主体在下一个换行符处扫描
    P.L.heredocs.push({
      delim,
      stripTabs: v === '<<-',
      quoted,
      bodyStart: 0,
      bodyEnd: 0,
      endStart: 0,
      endEnd: 0,
    })
    const kids = fd ? [fd, op, startNode] : [op, startNode]
    const startIdx = fd ? fd.startIndex : op.startIndex
    // 安全性：tree-sitter 将 heredoc_start 与换行之间的 pipeline/list/file_redirect
    // 作为 heredoc_redirect 的子节点嵌套。
    // `ls <<'EOF' | rm -rf /tmp/evil` 不能静默丢弃 rm。
    // 正确解析末尾的 word 和 file_redirect（ast.ts 的 walkHeredocRedirect
    // 通过 tooComplex 对所有未识别的子节点关闭失败路径）。
    // pipeline/list 操作符（| && || ;）结构复杂 — 发出 ERROR 让同一失败路径拒绝它们。
    while (true) {
      skipBlanks(P.L)
      const tc = peek(P.L)
      if (tc === '\n' || tc === '' || P.L.i >= P.L.len) break
      // 分隔符后的文件重定向：cat <<EOF > out.txt
      if (tc === '>' || tc === '<' || isDigit(tc)) {
        const rSave = saveLex(P.L)
        const r = tryParseRedirect(P)
        if (r && r.type === 'file_redirect') {
          kids.push(r)
          continue
        }
        restoreLex(P.L, rSave)
      }
      // heredoc_start 后的管道：`one <<EOF | grep two` — tree-sitter
      // 将管道作为 heredoc_redirect 的子节点嵌套。ast.ts 的
      // walkHeredocRedirect 通过 tooComplex 对 pipeline/command 执行 fail-closed。
      if (tc === '|' && peek(P.L, 1) !== '|') {
        advance(P.L)
        skipBlanks(P.L)
        const pipeCmds: TsNode[] = []
        while (true) {
          const cmd = parseCommand(P)
          if (!cmd) break
          pipeCmds.push(cmd)
          skipBlanks(P.L)
          if (peek(P.L) === '|' && peek(P.L, 1) !== '|') {
            const ps = P.L.b
            advance(P.L)
            pipeCmds.push(mk(P, '|', ps, P.L.b, []))
            skipBlanks(P.L)
            continue
          }
          break
        }
        if (pipeCmds.length > 0) {
          const pl = pipeCmds[pipeCmds.length - 1]!
          // tree-sitter 在 `|` 之后总是包裹 pipeline，即使只有单条命令
          kids.push(
            mk(P, 'pipeline', pipeCmds[0]!.startIndex, pl.endIndex, pipeCmds),
          )
        }
        continue
      }
      // heredoc_start 后的 && / ||：`cat <<-EOF || die "..."` — tree-sitter
      // 仅将 RHS 命令（而非完整 list）嵌套为 heredoc_redirect 的子节点。
      if (
        (tc === '&' && peek(P.L, 1) === '&') ||
        (tc === '|' && peek(P.L, 1) === '|')
      ) {
        advance(P.L)
        advance(P.L)
        skipBlanks(P.L)
        const rhs = parseCommand(P)
        if (rhs) kids.push(rhs)
        continue
      }
      // 终止符/未处理元字符 — 将该行其余内容作为 ERROR 消费（ast.ts 拒绝）
      // 涵盖 ; & ( )
      if (tc === '&' || tc === ';' || tc === '(' || tc === ')') {
        const eStart = P.L.b
        while (P.L.i < P.L.len && peek(P.L) !== '\n') advance(P.L)
        kids.push(mk(P, 'ERROR', eStart, P.L.b, []))
        break
      }
      // 末尾单词参数：如 newins <<-EOF - org.freedesktop.service
      const w = parseWord(P, 'arg')
      if (w) {
        kids.push(w)
        continue
      }
      // 无法识别 — 将行剩余内容作为 ERROR 消费
      const eStart = P.L.b
      while (P.L.i < P.L.len && peek(P.L) !== '\n') advance(P.L)
      if (P.L.b > eStart) kids.push(mk(P, 'ERROR', eStart, P.L.b, []))
      break
    }
    return mk(P, 'heredoc_redirect', startIdx, P.L.b, kids)
  }
  // 关闭文件描述符变体：`<&-` `>&-` 的目标是可选的（0 或 1 个）
  if (v === '<&-' || v === '>&-') {
    const op = leaf(P, v, t)
    const kids: TsNode[] = []
    if (fd) kids.push(fd)
    kids.push(op)
    // 可选的单个目标 — 仅在下一字符是字面量时消费
    skipBlanks(P.L)
    const dSave = saveLex(P.L)
    const dest = isRedirectLiteralStart(P) ? parseWord(P, 'arg') : null
    if (dest) {
      kids.push(dest)
    } else {
      restoreLex(P.L, dSave)
    }
    const startIdx = fd ? fd.startIndex : op.startIndex
    const end = dest ? dest.endIndex : op.endIndex
    return mk(P, 'file_redirect', startIdx, end, kids)
  }
  if (
    v === '>' ||
    v === '>>' ||
    v === '>&' ||
    v === '>|' ||
    v === '&>' ||
    v === '&>>' ||
    v === '<' ||
    v === '<&'
  ) {
    const op = leaf(P, v, t)
    const kids: TsNode[] = []
    if (fd) kids.push(fd)
    kids.push(op)
    // 语法：目标为 repeat1($._literal) — 贪婪消费字面量，
    // 直到非字面量（重定向操作符、终止符等）。tree-sitter 的
    // prec.left 使 `cmd >f a b c` 中的 `a b c` 归属 file_redirect，
    // 而非命令本体。这是结构上的特殊性，但为满足语料库一致性必须保留。
    // preRedirect 上下文（greedy=false）只取 1 个字面量，
    // 因为 command 的动态优先级高于 redirected_statement 的 prec(-1)。
    let end = op.endIndex
    let taken = 0
    while (true) {
      skipBlanks(P.L)
      if (!isRedirectLiteralStart(P)) break
      if (!greedy && taken >= 1) break
      const tc = peek(P.L)
      const tc1 = peek(P.L, 1)
      let target: TsNode | null = null
      if ((tc === '<' || tc === '>') && tc1 === '(') {
        target = parseProcessSub(P)
      } else {
        target = parseWord(P, 'arg')
      }
      if (!target) break
      kids.push(target)
      end = target.endIndex
      taken++
    }
    const startIdx = fd ? fd.startIndex : op.startIndex
    return mk(P, 'file_redirect', startIdx, end, kids)
  }
  restoreLex(P.L, save)
  return null
}

function parseProcessSub(P: ParseState): TsNode | null {
  const c = peek(P.L)
  if ((c !== '<' && c !== '>') || peek(P.L, 1) !== '(') return null
  const start = P.L.b
  advance(P.L)
  advance(P.L)
  const open = mk(P, c + '(', start, P.L.b, [])
  const body = parseStatements(P, ')')
  skipBlanks(P.L)
  let close: TsNode
  if (peek(P.L) === ')') {
    const cs = P.L.b
    advance(P.L)
    close = mk(P, ')', cs, P.L.b, [])
  } else {
    close = mk(P, ')', P.L.b, P.L.b, [])
  }
  return mk(P, 'process_substitution', start, close.endIndex, [
    open,
    ...body,
    close,
  ])
}

/**
 * 扫描并填充所有待处理 heredoc 的主体内容。
 * 跳到当前行末尾的换行符，然后逐行读取直到找到分隔符行，
 * 记录主体起始/结束字节偏移及分隔符行的起始/结束偏移。
 */
function scanHeredocBodies(P: ParseState): void {
  // 若还未在换行符处，先跳至行末
  while (P.L.i < P.L.len && P.L.src[P.L.i] !== '\n') advance(P.L)
  if (P.L.i < P.L.len) advance(P.L)
  for (const hd of P.L.heredocs) {
    hd.bodyStart = P.L.b
    const delimLen = hd.delim.length
    while (P.L.i < P.L.len) {
      const lineStart = P.L.i
      const lineStartB = P.L.b
      // 若为 <<-，跳过前导 tab
      let checkI = lineStart
      if (hd.stripTabs) {
        while (checkI < P.L.len && P.L.src[checkI] === '\t') checkI++
      }
      // 检查当前行是否为分隔符行
      if (
        P.L.src.startsWith(hd.delim, checkI) &&
        (checkI + delimLen >= P.L.len ||
          P.L.src[checkI + delimLen] === '\n' ||
          P.L.src[checkI + delimLen] === '\r')
      ) {
        hd.bodyEnd = lineStartB
        // 跳过 tab 字符
        while (P.L.i < checkI) advance(P.L)
        hd.endStart = P.L.b
        // 跳过分隔符字符
        for (let k = 0; k < delimLen; k++) advance(P.L)
        hd.endEnd = P.L.b
        // 跳过尾部换行符
        if (P.L.i < P.L.len && P.L.src[P.L.i] === '\n') advance(P.L)
        return
      }
      // 消费当前行内容
      while (P.L.i < P.L.len && P.L.src[P.L.i] !== '\n') advance(P.L)
      if (P.L.i < P.L.len) advance(P.L)
    }
    // 未终止的 heredoc
    hd.bodyEnd = P.L.b
    hd.endStart = P.L.b
    hd.endEnd = P.L.b
  }
}

/**
 * 解析未引号 heredoc 主体内的扩展表达式，返回 heredoc_content/expansion 节点列表。
 * 按字节范围 [start, end) 扫描；将 $.../ `...` 扩展与纯文本段分开为独立节点。
 * 若主体内无任何扩展，返回空数组（调用方直接用叶节点表示 heredoc_body）。
 */
function parseHeredocBodyContent(
  P: ParseState,
  start: number,
  end: number,
): TsNode[] {
  // 解析未引号 heredoc 主体内的扩展表达式
  const saved = saveLex(P.L)
  // 将 lexer 定位到主体起始字节
  restoreLexToByte(P, start)
  const out: TsNode[] = []
  let contentStart = P.L.b
  // tree-sitter-bash 的 heredoc_body 规则隐藏了初始文本段
  // (_heredoc_body_beginning) — 只有第一个展开之后的内容才以
  // heredoc_content 形式发出。此处跟踪是否已遇到展开。
  let sawExpansion = false
  while (P.L.b < end) {
    const c = peek(P.L)
    // 反斜杠转义抑制展开：\$ \` 在 heredoc 中保持字面量。
    if (c === '\\') {
      const nxt = peek(P.L, 1)
      if (nxt === '$' || nxt === '`' || nxt === '\\') {
        advance(P.L)
        advance(P.L)
        continue
      }
      advance(P.L)
      continue
    }
    if (c === '$' || c === '`') {
      const preB = P.L.b
      const exp = parseDollarLike(P)
      // 裸 `$` 后接非名称字符（如正则中的 `$'`）返回单独的 '$' 叶节点，
      // 而非展开节点 — 视为字面量内容，不拆分。
      if (
        exp &&
        (exp.type === 'simple_expansion' ||
          exp.type === 'expansion' ||
          exp.type === 'command_substitution' ||
          exp.type === 'arithmetic_expansion')
      ) {
        if (sawExpansion && preB > contentStart) {
          out.push(mk(P, 'heredoc_content', contentStart, preB, []))
        }
        out.push(exp)
        contentStart = P.L.b
        sawExpansion = true
      }
      continue
    }
    advance(P.L)
  }
  // 只有存在展开时才发出 heredoc_content 子节点 ——
  // 否则 heredoc_body 是叶节点（tree-sitter 约定）。
  if (sawExpansion) {
    out.push(mk(P, 'heredoc_content', contentStart, end, []))
  }
  restoreLex(P.L, saved)
  return out
}

/**
 * 将 lexer 的位置恢复到指定 UTF-8 字节偏移处。
 * 通过二分搜索 byteTable（JS char index → UTF-8 byte offset）找到对应的字符索引。
 * 用于 heredoc 主体扫描：heredoc 结束后需跳回主体起始字节重新解析扩展内容。
 */
function restoreLexToByte(P: ParseState, targetByte: number): void {
  if (!P.L.byteTable) byteAt(P.L, 0)
  const t = P.L.byteTable!
  let lo = 0
  let hi = P.src.length
  while (lo < hi) {
    const m = (lo + hi) >>> 1
    if (t[m]! < targetByte) lo = m + 1
    else hi = m
  }
  P.L.i = lo
  P.L.b = targetByte
}

/**
 * 解析单词位置的元素：裸单词、字符串、展开表达式，或它们的拼接。
 * 返回单个节点；若存在多个相邻片段，则包裹在 concatenation 节点中。
 */
function parseWord(P: ParseState, _ctx: 'cmd' | 'arg'): TsNode | null {
  skipBlanks(P.L)
  const parts: TsNode[] = []
  while (P.L.i < P.L.len) {
    const c = peek(P.L)
    if (
      c === ' ' ||
      c === '\t' ||
      c === '\n' ||
      c === '\r' ||
      c === '' ||
      c === '|' ||
      c === '&' ||
      c === ';' ||
      c === '(' ||
      c === ')'
    ) {
      break
    }
    // < > 是重定向操作符，除非是 <( >( 进程替换
    if (c === '<' || c === '>') {
      if (peek(P.L, 1) === '(') {
        const ps = parseProcessSub(P)
        if (ps) parts.push(ps)
        continue
      }
      break
    }
    if (c === '"') {
      parts.push(parseDoubleQuoted(P))
      continue
    }
    if (c === "'") {
      const tok = nextToken(P.L, 'arg')
      parts.push(leaf(P, 'raw_string', tok))
      continue
    }
    if (c === '$') {
      const c1 = peek(P.L, 1)
      if (c1 === "'") {
        const tok = nextToken(P.L, 'arg')
        parts.push(leaf(P, 'ansi_c_string', tok))
        continue
      }
      if (c1 === '"') {
        // 翻译字符串 $"..."：先发出 $ 叶节点，再发出 string 节点
        const dTok: Token = {
          type: 'DOLLAR',
          value: '$',
          start: P.L.b,
          end: P.L.b + 1,
        }
        advance(P.L)
        parts.push(leaf(P, '$', dTok))
        parts.push(parseDoubleQuoted(P))
        continue
      }
      if (c1 === '`') {
        // `$` 后接反引号 — tree-sitter 完全省略 $，只发出 (command_substitution)。
        // 消费 $ 并让下一次迭代处理反引号。
        advance(P.L)
        continue
      }
      const exp = parseDollarLike(P)
      if (exp) parts.push(exp)
      continue
    }
    if (c === '`') {
      if (P.inBacktick > 0) break
      const bt = parseBacktick(P)
      if (bt) parts.push(bt)
      continue
    }
    // 大括号展开 {1..5} 或 {a,b,c} — 仅在看起来是展开时尝试
    if (c === '{') {
      const be = tryParseBraceExpr(P)
      if (be) {
        parts.push(be)
        continue
      }
      // 安全性：若 `{` 紧跟命令终止符（; | & 换行 或 EOF），
      // 则它是独立单词 — 不通过 tryParseBraceLikeCat 吞噬后续内容。
      // `echo {;touch /tmp/evil` 必须在 `;` 处断开，
      // 使安全扫描器能看到 `touch`。
      const nc = peek(P.L, 1)
      if (
        nc === ';' ||
        nc === '|' ||
        nc === '&' ||
        nc === '\n' ||
        nc === '' ||
        nc === ')' ||
        nc === ' ' ||
        nc === '\t'
      ) {
        const bStart = P.L.b
        advance(P.L)
        parts.push(mk(P, 'word', bStart, P.L.b, []))
        continue
      }
      // 否则将 { 和 } 作为单词片段处理
      const cat = tryParseBraceLikeCat(P)
      if (cat) {
        for (const p of cat) parts.push(p)
        continue
      }
    }
    // arg 位置的独立 `}` 是一个单词（如 `echo }foo`）。
    // parseBareWord 在 `}` 处停止，需在此处单独处理。
    if (c === '}') {
      const bStart = P.L.b
      advance(P.L)
      parts.push(mk(P, 'word', bStart, P.L.b, []))
      continue
    }
    // `[` 和 `]` 是单字符单词片段（tree-sitter 在方括号处分割，
    // 如 `[:lower:]` → `[` `:lower:` `]`，`{o[k]}` → 6 个单词）。
    if (c === '[' || c === ']') {
      const bStart = P.L.b
      advance(P.L)
      parts.push(mk(P, 'word', bStart, P.L.b, []))
      continue
    }
    // 裸单词片段
    const frag = parseBareWord(P)
    if (!frag) break
    // `NN#${...}` 或 `NN#$(...)` → (number (expansion|command_substitution))。
    // 语法：number 可以是 seq(/-?(0x)?[0-9]+#/, choice(expansion, cmd_sub))。
    // `10#${cmd}` 不能是拼接节点 — 它是含展开子节点的单个 number 节点。
    // 检测：frag 以 `#` 结尾，下一字符是 $ 且紧跟 {/(。
    if (
      frag.type === 'word' &&
      /^-?(0x)?[0-9]+#$/.test(frag.text) &&
      peek(P.L) === '$' &&
      (peek(P.L, 1) === '{' || peek(P.L, 1) === '(')
    ) {
      const exp = parseDollarLike(P)
      if (exp) {
        // 前缀 `NN#` 是语法中的匿名模式 — 只有展开/命令替换是具名子节点。
        parts.push(mk(P, 'number', frag.startIndex, exp.endIndex, [exp]))
        continue
      }
    }
    parts.push(frag)
  }
  if (parts.length === 0) return null
  if (parts.length === 1) return parts[0]!
  // 拼接多个片段为 concatenation 节点
  const first = parts[0]!
  const last = parts[parts.length - 1]!
  return mk(P, 'concatenation', first.startIndex, last.endIndex, parts)
}

/**
 * 解析裸单词片段（不含引号、展开、大括号）。
 * 遇到空白、shell 元字符或特殊字符时停止；
 * 内容为纯数字时返回 number 节点，否则返回 word 节点。
 */
function parseBareWord(P: ParseState): TsNode | null {
  const start = P.L.b
  const startI = P.L.i
  while (P.L.i < P.L.len) {
    const c = peek(P.L)
    if (c === '\\') {
      if (P.L.i + 1 >= P.L.len) {
        // 真正的 EOF 处出现无对应的末尾 `\` — tree-sitter 发出不含 `\` 的单词
        // 加一个兄弟 ERROR 节点。在此停止，由调用方发出 ERROR。
        break
      }
      const nx = P.L.src[P.L.i + 1]
      if (nx === '\n' || (nx === '\r' && P.L.src[P.L.i + 2] === '\n')) {
        // 行续接会断开当前单词（tree-sitter 特性）— 兼容 \r?\n
        break
      }
      advance(P.L)
      advance(P.L)
      continue
    }
    if (
      c === ' ' ||
      c === '\t' ||
      c === '\n' ||
      c === '\r' ||
      c === '' ||
      c === '|' ||
      c === '&' ||
      c === ';' ||
      c === '(' ||
      c === ')' ||
      c === '<' ||
      c === '>' ||
      c === '"' ||
      c === "'" ||
      c === '$' ||
      c === '`' ||
      c === '{' ||
      c === '}' ||
      c === '[' ||
      c === ']'
    ) {
      break
    }
    advance(P.L)
  }
  if (P.L.b === start) return null
  const text = P.src.slice(startI, P.L.i)
  const type = /^-?\d+$/.test(text) ? 'number' : 'word'
  return mk(P, type, start, P.L.b, [])
}

/**
 * 尝试解析 `{N..M}` 大括号范围表达式（brace_expression）。
 * 两端必须同为数字或同为单字符，混合类型则回溯并返回 null。
 * 成功时返回包含 `{`、p1、`..`、p2、`}` 五个子节点的 brace_expression 节点。
 */
function tryParseBraceExpr(P: ParseState): TsNode | null {
  // {N..M}：其中 N、M 为数字或单字符
  const save = saveLex(P.L)
  if (peek(P.L) !== '{') return null
  const oStart = P.L.b
  advance(P.L)
  const oEnd = P.L.b
  // 第一部分
  const p1Start = P.L.b
  while (isDigit(peek(P.L)) || isIdentStart(peek(P.L))) advance(P.L)
  const p1End = P.L.b
  if (p1End === p1Start || peek(P.L) !== '.' || peek(P.L, 1) !== '.') {
    restoreLex(P.L, save)
    return null
  }
  const dotStart = P.L.b
  advance(P.L)
  advance(P.L)
  const dotEnd = P.L.b
  const p2Start = P.L.b
  while (isDigit(peek(P.L)) || isIdentStart(peek(P.L))) advance(P.L)
  const p2End = P.L.b
  if (p2End === p2Start || peek(P.L) !== '}') {
    restoreLex(P.L, save)
    return null
  }
  const cStart = P.L.b
  advance(P.L)
  const cEnd = P.L.b
  const p1Text = sliceBytes(P, p1Start, p1End)
  const p2Text = sliceBytes(P, p2Start, p2End)
  const p1IsNum = /^\d+$/.test(p1Text)
  const p2IsNum = /^\d+$/.test(p2Text)
  // 有效大括号展开：两者均为数字，或两者均为单字符。混合则拒绝。
  if (p1IsNum !== p2IsNum) {
    restoreLex(P.L, save)
    return null
  }
  if (!p1IsNum && (p1Text.length !== 1 || p2Text.length !== 1)) {
    restoreLex(P.L, save)
    return null
  }
  const p1Type = p1IsNum ? 'number' : 'word'
  const p2Type = p2IsNum ? 'number' : 'word'
  return mk(P, 'brace_expression', oStart, cEnd, [
    mk(P, '{', oStart, oEnd, []),
    mk(P, p1Type, p1Start, p1End, []),
    mk(P, '..', dotStart, dotEnd, []),
    mk(P, p2Type, p2Start, p2End, []),
    mk(P, '}', cStart, cEnd, []),
  ])
}

/**
 * 尝试解析 `{a,b,c}` 或 `{}` 形式的大括号类表达式，将其分割为多个 word 片段节点。
 * 按照 tree-sitter 的行为，`{`、内部各段、`}` 分别作为独立 word 节点返回。
 * 安全：在命令终止符处停止，防止 `{foo;cmd}` 管道注入。
 * `[` 和 `]` 也作为独立单字符 word 节点拆分。
 */
function tryParseBraceLikeCat(P: ParseState): TsNode[] | null {
  // {a,b,c} 或 {} → 像 tree-sitter 一样分割为单词片段
  if (peek(P.L) !== '{') return null
  const oStart = P.L.b
  advance(P.L)
  const oEnd = P.L.b
  const inner: TsNode[] = [mk(P, 'word', oStart, oEnd, [])]
  while (P.L.i < P.L.len) {
    const bc = peek(P.L)
    // 安全：在命令终止符处停止，确保 `{foo;rm x` 能正确分割。
    if (
      bc === '}' ||
      bc === '\n' ||
      bc === ';' ||
      bc === '|' ||
      bc === '&' ||
      bc === ' ' ||
      bc === '\t' ||
      bc === '<' ||
      bc === '>' ||
      bc === '(' ||
      bc === ')'
    ) {
      break
    }
    // `[` 和 `]` 是单字符单词：{o[k]} → { o [ k ] }
    if (bc === '[' || bc === ']') {
      const bStart = P.L.b
      advance(P.L)
      inner.push(mk(P, 'word', bStart, P.L.b, []))
      continue
    }
    const midStart = P.L.b
    while (P.L.i < P.L.len) {
      const mc = peek(P.L)
      if (
        mc === '}' ||
        mc === '\n' ||
        mc === ';' ||
        mc === '|' ||
        mc === '&' ||
        mc === ' ' ||
        mc === '\t' ||
        mc === '<' ||
        mc === '>' ||
        mc === '(' ||
        mc === ')' ||
        mc === '[' ||
        mc === ']'
      ) {
        break
      }
      advance(P.L)
    }
    const midEnd = P.L.b
    if (midEnd > midStart) {
      const midText = sliceBytes(P, midStart, midEnd)
      const midType = /^-?\d+$/.test(midText) ? 'number' : 'word'
      inner.push(mk(P, midType, midStart, midEnd, []))
    } else {
      break
    }
  }
  if (peek(P.L) === '}') {
    const cStart = P.L.b
    advance(P.L)
    inner.push(mk(P, 'word', cStart, P.L.b, []))
  }
  return inner
}

/**
 * 解析双引号字符串 `"..."` 并返回 string 节点。
 * 内部识别 `$(...)`、`${...}`、`$var`、`` `...` ``、裸 `$` 等展开形式，
 * 纯文本段作为 string_content 节点；纯空白段按 tree-sitter extras 规则省略。
 * 换行处会分割 string_content，确保字节范围连续。
 */
function parseDoubleQuoted(P: ParseState): TsNode {
  const qStart = P.L.b
  advance(P.L)
  const qEnd = P.L.b
  const openQ = mk(P, '"', qStart, qEnd, [])
  const parts: TsNode[] = [openQ]
  let contentStart = P.L.b
  let contentStartI = P.L.i
  const flushContent = (): void => {
    if (P.L.b > contentStart) {
      // tree-sitter 的 extras 规则 /\s/ 优先级高于 string_content（prec -1），
      // 因此纯空白段会被省略。
      // `" ${x} "` → (string (expansion)) 而非 (string (string_content)(expansion)(string_content))。
      // 注意：此处有意偏离保留全部内容的做法 — 依赖纯空白 string_content 的测试需更新。
      const txt = P.src.slice(contentStartI, P.L.i)
      if (!/^[ \t]+$/.test(txt)) {
        parts.push(mk(P, 'string_content', contentStart, P.L.b, []))
      }
    }
  }
  while (P.L.i < P.L.len) {
    const c = peek(P.L)
    if (c === '"') break
    if (c === '\\' && P.L.i + 1 < P.L.len) {
      advance(P.L)
      advance(P.L)
      continue
    }
    if (c === '\n') {
      // 在换行处分割 string_content
      flushContent()
      advance(P.L)
      contentStart = P.L.b
      contentStartI = P.L.i
      continue
    }
    if (c === '$') {
      const c1 = peek(P.L, 1)
      if (
        c1 === '(' ||
        c1 === '{' ||
        isIdentStart(c1) ||
        SPECIAL_VARS.has(c1) ||
        isDigit(c1)
      ) {
        flushContent()
        const exp = parseDollarLike(P)
        if (exp) parts.push(exp)
        contentStart = P.L.b
        contentStartI = P.L.i
        continue
      }
      // 裸 $ 不在字符串末尾：tree-sitter 将其作为匿名 '$' token 发出，
      // 从而分割 string_content。紧靠闭合 " 前的 $ 被并入前面的 string_content。
      if (c1 !== '"' && c1 !== '') {
        flushContent()
        const dS = P.L.b
        advance(P.L)
        parts.push(mk(P, '$', dS, P.L.b, []))
        contentStart = P.L.b
        contentStartI = P.L.i
        continue
      }
    }
    if (c === '`') {
      flushContent()
      const bt = parseBacktick(P)
      if (bt) parts.push(bt)
      contentStart = P.L.b
      contentStartI = P.L.i
      continue
    }
    advance(P.L)
  }
  flushContent()
  let close: TsNode
  if (peek(P.L) === '"') {
    const cStart = P.L.b
    advance(P.L)
    close = mk(P, '"', cStart, P.L.b, [])
  } else {
    close = mk(P, '"', P.L.b, P.L.b, [])
  }
  parts.push(close)
  return mk(P, 'string', qStart, close.endIndex, parts)
}

/**
 * 解析以 `$` 开头的各类展开表达式，返回对应节点或 null。
 * 支持分支：
 * - `$((expr))` → arithmetic_expansion
 * - `$[expr]` → arithmetic_expansion（bash 遗留语法）
 * - `$(cmd)` → command_substitution；`$(< file)` 解包为 file_redirect
 * - `${...}` → expansion（委托给 parseExpansionBody）
 * - `$VAR`、`$?`、`$$` 等 → simple_expansion
 * - 裸 `$` → `$` 叶节点
 */
function parseDollarLike(P: ParseState): TsNode | null {
  const c1 = peek(P.L, 1)
  const dStart = P.L.b
  if (c1 === '(' && peek(P.L, 2) === '(') {
    // $(( 算术展开 ))
    advance(P.L)
    advance(P.L)
    advance(P.L)
    const open = mk(P, '$((', dStart, P.L.b, [])
    const exprs = parseArithCommaList(P, '))', 'var')
    skipBlanks(P.L)
    let close: TsNode
    if (peek(P.L) === ')' && peek(P.L, 1) === ')') {
      const cStart = P.L.b
      advance(P.L)
      advance(P.L)
      close = mk(P, '))', cStart, P.L.b, [])
    } else {
      close = mk(P, '))', P.L.b, P.L.b, [])
    }
    return mk(P, 'arithmetic_expansion', dStart, close.endIndex, [
      open,
      ...exprs,
      close,
    ])
  }
  if (c1 === '[') {
    // $[ 算术展开 ] — bash 遗留语法，等同于 $((...))
    advance(P.L)
    advance(P.L)
    const open = mk(P, '$[', dStart, P.L.b, [])
    const exprs = parseArithCommaList(P, ']', 'var')
    skipBlanks(P.L)
    let close: TsNode
    if (peek(P.L) === ']') {
      const cStart = P.L.b
      advance(P.L)
      close = mk(P, ']', cStart, P.L.b, [])
    } else {
      close = mk(P, ']', P.L.b, P.L.b, [])
    }
    return mk(P, 'arithmetic_expansion', dStart, close.endIndex, [
      open,
      ...exprs,
      close,
    ])
  }
  if (c1 === '(') {
    advance(P.L)
    advance(P.L)
    const open = mk(P, '$(', dStart, P.L.b, [])
    let body = parseStatements(P, ')')
    skipBlanks(P.L)
    let close: TsNode
    if (peek(P.L) === ')') {
      const cStart = P.L.b
      advance(P.L)
      close = mk(P, ')', cStart, P.L.b, [])
    } else {
      close = mk(P, ')', P.L.b, P.L.b, [])
    }
    // $(< file) 简写：将 redirected_statement 解包为裸 file_redirect
    // tree-sitter 直接发出 (command_substitution (file_redirect (word)))
    if (
      body.length === 1 &&
      body[0]!.type === 'redirected_statement' &&
      body[0]!.children.length === 1 &&
      body[0]!.children[0]!.type === 'file_redirect'
    ) {
      body = body[0]!.children
    }
    return mk(P, 'command_substitution', dStart, close.endIndex, [
      open,
      ...body,
      close,
    ])
  }
  if (c1 === '{') {
    advance(P.L)
    advance(P.L)
    const open = mk(P, '${', dStart, P.L.b, [])
    const inner = parseExpansionBody(P)
    let close: TsNode
    if (peek(P.L) === '}') {
      const cStart = P.L.b
      advance(P.L)
      close = mk(P, '}', cStart, P.L.b, [])
    } else {
      close = mk(P, '}', P.L.b, P.L.b, [])
    }
    return mk(P, 'expansion', dStart, close.endIndex, [open, ...inner, close])
  }
  // 简单展开 $VAR 或 $? $$ $@ 等
  advance(P.L)
  const dEnd = P.L.b
  const dollar = mk(P, '$', dStart, dEnd, [])
  const nc = peek(P.L)
  // $_ 仅在后面不跟标识符字符时才是 special_variable_name
  if (nc === '_' && !isIdentChar(peek(P.L, 1))) {
    const vStart = P.L.b
    advance(P.L)
    const vn = mk(P, 'special_variable_name', vStart, P.L.b, [])
    return mk(P, 'simple_expansion', dStart, P.L.b, [dollar, vn])
  }
  if (isIdentStart(nc)) {
    const vStart = P.L.b
    while (isIdentChar(peek(P.L))) advance(P.L)
    const vn = mk(P, 'variable_name', vStart, P.L.b, [])
    return mk(P, 'simple_expansion', dStart, P.L.b, [dollar, vn])
  }
  if (isDigit(nc)) {
    const vStart = P.L.b
    advance(P.L)
    const vn = mk(P, 'variable_name', vStart, P.L.b, [])
    return mk(P, 'simple_expansion', dStart, P.L.b, [dollar, vn])
  }
  if (SPECIAL_VARS.has(nc)) {
    const vStart = P.L.b
    advance(P.L)
    const vn = mk(P, 'special_variable_name', vStart, P.L.b, [])
    return mk(P, 'simple_expansion', dStart, P.L.b, [dollar, vn])
  }
  // 裸 $ — 仅发出 $ 叶节点（tree-sitter 将末尾 $ 视为字面量）
  return dollar
}

/**
 * 解析 `${...}` 大括号展开的主体内容，返回子节点列表。
 * 处理 `#` 长度前缀、`!`/`=`/`~` 间接展开前缀、变量名/特殊变量、
 * 可选下标 `[idx]`、尾部 `*`/`@` 间接枚举、`@op` 参数变换，
 * 以及 `:-`、`:=`、`#`、`%`、`/` 等操作符及其 RHS 内容。
 * 特殊情况：`${#!}`、`${!#}`、`${!##}` 等返回空节点列表。
 */
function parseExpansionBody(P: ParseState): TsNode[] {
  const out: TsNode[] = []
  skipBlanks(P.L)
  // 特殊情况：${#!} ${!#} ${!##} ${!# } ${!## } 全部发出空 (expansion)
  // — # 和 ! 在仅与对方组合（以及可选的 } 前空格）时均变为匿名节点。
  // 注意：${!##/} 不匹配（后面有内容），因此会正常解析为 (special_variable_name)(regex)。
  {
    const c0 = peek(P.L)
    const c1 = peek(P.L, 1)
    if (c0 === '#' && c1 === '!' && peek(P.L, 2) === '}') {
      advance(P.L)
      advance(P.L)
      return out
    }
    if (c0 === '!' && c1 === '#') {
      // ${!#} ${!##}，后面可选空格再接 }
      let j = 2
      if (peek(P.L, j) === '#') j++
      if (peek(P.L, j) === ' ') j++
      if (peek(P.L, j) === '}') {
        while (j-- > 0) advance(P.L)
        return out
      }
    }
  }
  // 可选 # 前缀，用于获取长度
  if (peek(P.L) === '#') {
    const s = P.L.b
    advance(P.L)
    out.push(mk(P, '#', s, P.L.b, []))
  }
  // 可选 ! 前缀，用于间接展开：${!varname} ${!prefix*} ${!prefix@}
  // 仅在后接标识符时有效 — 单独的 ${!} 是特殊变量 $!
  // = ~ 前缀为 zsh 风格（${=var} ${~var}）
  const pc = peek(P.L)
  if (
    (pc === '!' || pc === '=' || pc === '~') &&
    (isIdentStart(peek(P.L, 1)) || isDigit(peek(P.L, 1)))
  ) {
    const s = P.L.b
    advance(P.L)
    out.push(mk(P, pc, s, P.L.b, []))
  }
  skipBlanks(P.L)
  // 变量名（标识符、数字或特殊变量）
  if (isIdentStart(peek(P.L))) {
    const s = P.L.b
    while (isIdentChar(peek(P.L))) advance(P.L)
    out.push(mk(P, 'variable_name', s, P.L.b, []))
  } else if (isDigit(peek(P.L))) {
    const s = P.L.b
    while (isDigit(peek(P.L))) advance(P.L)
    out.push(mk(P, 'variable_name', s, P.L.b, []))
  } else if (SPECIAL_VARS.has(peek(P.L))) {
    const s = P.L.b
    advance(P.L)
    out.push(mk(P, 'special_variable_name', s, P.L.b, []))
  }
  // 可选下标 [idx] — 以算术方式解析
  if (peek(P.L) === '[') {
    const varNode = out[out.length - 1]
    const brOpen = P.L.b
    advance(P.L)
    const brOpenNode = mk(P, '[', brOpen, P.L.b, [])
    const idx = parseSubscriptIndexInline(P)
    skipBlanks(P.L)
    const brClose = P.L.b
    if (peek(P.L) === ']') advance(P.L)
    const brCloseNode = mk(P, ']', brClose, P.L.b, [])
    if (varNode) {
      const kids = idx
        ? [varNode, brOpenNode, idx, brCloseNode]
        : [varNode, brOpenNode, brCloseNode]
      out[out.length - 1] = mk(P, 'subscript', varNode.startIndex, P.L.b, kids)
    }
  }
  skipBlanks(P.L)
  // 间接展开的末尾 * 或 @（${!prefix*} ${!prefix@}），
  // 或参数变换的 @operator（${var@U} ${var@Q}）— 均为匿名节点
  const tc = peek(P.L)
  if ((tc === '*' || tc === '@') && peek(P.L, 1) === '}') {
    const s = P.L.b
    advance(P.L)
    out.push(mk(P, tc, s, P.L.b, []))
    return out
  }
  if (tc === '@' && isIdentStart(peek(P.L, 1))) {
    // ${var@U} 变换 — @ 为匿名节点，消费操作符字符
    const s = P.L.b
    advance(P.L)
    out.push(mk(P, '@', s, P.L.b, []))
    while (isIdentChar(peek(P.L))) advance(P.L)
    return out
  }
  // 操作符：:- := :? :+ - = ? + # ## % %% / // ^ ^^ , ,, 等
  const c = peek(P.L)
  // 裸 `:` 子串操作符 ${var:off:len} — 偏移量和长度以算术方式解析。
  // 必须在通用操作符处理之前处理，以便 `:` 后的 `(` 进入括号表达式路径，
  // 而非数组路径。`:-` `:=` `:?` `:+`（无空格）仍为默认值操作符；
  // `: -1`（- 前有空格）是带负偏移量的子串展开。
  if (c === ':') {
    const c1 = peek(P.L, 1)
    // `:\n` 或 `:}` — 空子串展开，不发出任何节点（仅有 variable_name）
    if (c1 === '\n' || c1 === '}') {
      advance(P.L)
      while (peek(P.L) === '\n') advance(P.L)
      return out
    }
    if (c1 !== '-' && c1 !== '=' && c1 !== '?' && c1 !== '+') {
      advance(P.L)
      skipBlanks(P.L)
      // 偏移量 — 算术解析。顶层的 `-N` 按 tree-sitter 规则发出单个 number 节点；
      // 括号内则发出 unary_expression(number)。
      const offC = peek(P.L)
      let off: TsNode | null
      if (offC === '-' && isDigit(peek(P.L, 1))) {
        const ns = P.L.b
        advance(P.L)
        while (isDigit(peek(P.L))) advance(P.L)
        off = mk(P, 'number', ns, P.L.b, [])
      } else {
        off = parseArithExpr(P, ':}', 'var')
      }
      if (off) out.push(off)
      skipBlanks(P.L)
      if (peek(P.L) === ':') {
        advance(P.L)
        skipBlanks(P.L)
        const lenC = peek(P.L)
        let len: TsNode | null
        if (lenC === '-' && isDigit(peek(P.L, 1))) {
          const ns = P.L.b
          advance(P.L)
          while (isDigit(peek(P.L))) advance(P.L)
          len = mk(P, 'number', ns, P.L.b, [])
        } else {
          len = parseArithExpr(P, '}', 'var')
        }
        if (len) out.push(len)
      }
      return out
    }
  }
  if (
    c === ':' ||
    c === '#' ||
    c === '%' ||
    c === '/' ||
    c === '^' ||
    c === ',' ||
    c === '-' ||
    c === '=' ||
    c === '?' ||
    c === '+'
  ) {
    const s = P.L.b
    const c1 = peek(P.L, 1)
    let op = c
    if (c === ':' && (c1 === '-' || c1 === '=' || c1 === '?' || c1 === '+')) {
      advance(P.L)
      advance(P.L)
      op = c + c1
    } else if (
      (c === '#' || c === '%' || c === '/' || c === '^' || c === ',') &&
      c1 === c
    ) {
      // 双字符操作符：## %% // ^^ ,,
      advance(P.L)
      advance(P.L)
      op = c + c
    } else {
      advance(P.L)
    }
    out.push(mk(P, op, s, P.L.b, []))
    // 其余部分为默认值/替换值 — 解析为单词或正则表达式直至 }
    // 模式匹配操作符（# ## % %% / // ^ ^^ , ,,）发出 regex；
    // 值替换操作符（:- := :? :+ - = ? + :）发出 word。
    // `/` 和 `//` 在下一个 `/` 处拆分为 (regex)+(word)（用于 pat/repl）。
    const isPattern =
      op === '#' ||
      op === '##' ||
      op === '%' ||
      op === '%%' ||
      op === '/' ||
      op === '//' ||
      op === '^' ||
      op === '^^' ||
      op === ',' ||
      op === ',,'
    if (op === '/' || op === '//') {
      // 可选 /# 或 /% 锚定前缀 — 匿名节点
      const ac = peek(P.L)
      if (ac === '#' || ac === '%') {
        const aStart = P.L.b
        advance(P.L)
        out.push(mk(P, ac, aStart, P.L.b, []))
      }
      // 模式：按语法 _expansion_regex_replacement，模式为
      // choice(regex, string, cmd_sub, seq(string, regex))。若以 " 开头，
      // 发出 (string)，其余字符变为 (regex)。
      // `${v//"${old}"/}` → (string(expansion))；`${v//"${c}"\//}` →
      // (string)(regex)。
      if (peek(P.L) === '"') {
        out.push(parseDoubleQuoted(P))
        const tail = parseExpansionRest(P, 'regex', true)
        if (tail) out.push(tail)
      } else {
        const regex = parseExpansionRest(P, 'regex', true)
        if (regex) out.push(regex)
      }
      if (peek(P.L) === '/') {
        const sepStart = P.L.b
        advance(P.L)
        out.push(mk(P, '/', sepStart, P.L.b, []))
        // 替换值：按语法，choice 包含 `seq(cmd_sub, word)`，
        // 发出两个兄弟节点（不是拼接节点）。替换值起始的 `(` 是普通单词字符，
        // 而非数组 — 与 `:-` 默认值上下文不同。`${v/(/(Gentoo ${x}, }` 的替换
        // `(Gentoo ${x}, ` 为 (concatenation (word)(expansion)(word))。
        const repl = parseExpansionRest(P, 'replword', false)
        if (repl) {
          // seq(cmd_sub, word) 特殊情况 → 兄弟节点。检测条件：
          // 替换值为恰好 2 个部分的拼接节点，且第一个为 command_substitution。
          if (
            repl.type === 'concatenation' &&
            repl.children.length === 2 &&
            repl.children[0]!.type === 'command_substitution'
          ) {
            out.push(repl.children[0]!)
            out.push(repl.children[1]!)
          } else {
            out.push(repl)
          }
        }
      }
    } else if (op === '#' || op === '##' || op === '%' || op === '%%') {
      // 模式删除：按语法 _expansion_regex，模式为
      // repeat(choice(regex, string, raw_string, ')'))。每个引号/字符串
      // 作为兄弟节点，不合并为单个 regex。`${f%'str'*}` →
      // (raw_string)(regex)；`${f/'str'*}`（斜杠）保持单个 regex。
      for (const p of parseExpansionRegexSegmented(P)) out.push(p)
    } else {
      const rest = parseExpansionRest(P, isPattern ? 'regex' : 'word', false)
      if (rest) out.push(rest)
    }
  }
  return out
}

/**
 * 解析 `${...}` 展开操作符后的 RHS 内容，返回单个节点或 null。
 * - `nodeType='word'`：值替换模式，识别嵌套展开、引号字符串等，并在 `(` 处解析为 array；
 * - `nodeType='regex'`：模式匹配模式，整体扫描为单个 regex 节点，引号被跳过；
 * - `nodeType='replword'`：类似 word 但 `(` 不触发 array（用于 `/` `//` 替换值）。
 * `stopAtSlash=true` 在 `/` 处停止，用于 `${var/pat/repl}` 模式/替换拆分。
 * 前导纯空白段在有后续内容时丢弃（与 tree-sitter extras 规则一致）。
 */
function parseExpansionRest(
  P: ParseState,
  nodeType: string,
  stopAtSlash: boolean,
): TsNode | null {
  // 不调用 skipBlanks — `${var:- }` 中的空格就是单词内容。在 } 或换行处停止
  // （`${var:\n}` 不发出任何单词）。stopAtSlash=true 在 `/` 处停止，
  // 用于 ${var/pat/repl} 中的 pat/repl 分割。nodeType 'replword' 是 `/` `//`
  // 替换值的单词模式 — 与 'word' 相同，但 `(` 不作为数组处理。
  const start = P.L.b
  // 值替换 RHS 以 `(` 开头时解析为数组：${var:-(x)} →
  // (expansion (variable_name) (array (word)))。仅适用于 'word' 上下文（
  // 不适用于发出 regex 的模式匹配操作符，以及语法 `_expansion_regex_replacement`
  // 中 `(` 为普通字符的 'replword'）。
  if (nodeType === 'word' && peek(P.L) === '(') {
    advance(P.L)
    const open = mk(P, '(', start, P.L.b, [])
    const elems: TsNode[] = [open]
    while (P.L.i < P.L.len) {
      skipBlanks(P.L)
      const c = peek(P.L)
      if (c === ')' || c === '}' || c === '\n' || c === '') break
      const wStart = P.L.b
      while (P.L.i < P.L.len) {
        const wc = peek(P.L)
        if (
          wc === ')' ||
          wc === '}' ||
          wc === ' ' ||
          wc === '\t' ||
          wc === '\n' ||
          wc === ''
        ) {
          break
        }
        advance(P.L)
      }
      if (P.L.b > wStart) elems.push(mk(P, 'word', wStart, P.L.b, []))
      else break
    }
    if (peek(P.L) === ')') {
      const cStart = P.L.b
      advance(P.L)
      elems.push(mk(P, ')', cStart, P.L.b, []))
    }
    while (peek(P.L) === '\n') advance(P.L)
    return mk(P, 'array', start, P.L.b, elems)
  }
  // REGEX 模式：平坦单跨度扫描。引号不透明（跳过，防止其中的 `/` 触发 stopAtSlash），
  // 但不作为独立节点发出 — 整个范围变为一个 regex 节点。
  if (nodeType === 'regex') {
    let braceDepth = 0
    while (P.L.i < P.L.len) {
      const c = peek(P.L)
      if (c === '\n') break
      if (braceDepth === 0) {
        if (c === '}') break
        if (stopAtSlash && c === '/') break
      }
      if (c === '\\' && P.L.i + 1 < P.L.len) {
        advance(P.L)
        advance(P.L)
        continue
      }
      if (c === '"' || c === "'") {
        advance(P.L)
        while (P.L.i < P.L.len && peek(P.L) !== c) {
          if (peek(P.L) === '\\' && P.L.i + 1 < P.L.len) advance(P.L)
          advance(P.L)
        }
        if (peek(P.L) === c) advance(P.L)
        continue
      }
      // 跳过嵌套的 ${...} $(...) $[...]，防止其 } / 终止当前扫描
      if (c === '$') {
        const c1 = peek(P.L, 1)
        if (c1 === '{') {
          let d = 0
          advance(P.L)
          advance(P.L)
          d++
          while (P.L.i < P.L.len && d > 0) {
            const nc = peek(P.L)
            if (nc === '{') d++
            else if (nc === '}') d--
            advance(P.L)
          }
          continue
        }
        if (c1 === '(') {
          let d = 0
          advance(P.L)
          advance(P.L)
          d++
          while (P.L.i < P.L.len && d > 0) {
            const nc = peek(P.L)
            if (nc === '(') d++
            else if (nc === ')') d--
            advance(P.L)
          }
          continue
        }
      }
      if (c === '{') braceDepth++
      else if (c === '}' && braceDepth > 0) braceDepth--
      advance(P.L)
    }
    const end = P.L.b
    while (peek(P.L) === '\n') advance(P.L)
    if (end === start) return null
    return mk(P, 'regex', start, end, [])
  }
  // WORD 模式：分段解析器 — 识别嵌套的 ${...}、$(...)、$'...'、
  // "..."、'...'、$ident、<(...)/>(...)；裸字符累积为 word 段。
  // 多个部分 → 包裹为 concatenation 节点。
  const parts: TsNode[] = []
  let segStart = P.L.b
  let braceDepth = 0
  const flushSeg = (): void => {
    if (P.L.b > segStart) {
      parts.push(mk(P, 'word', segStart, P.L.b, []))
    }
  }
  while (P.L.i < P.L.len) {
    const c = peek(P.L)
    if (c === '\n') break
    if (braceDepth === 0) {
      if (c === '}') break
      if (stopAtSlash && c === '/') break
    }
    if (c === '\\' && P.L.i + 1 < P.L.len) {
      advance(P.L)
      advance(P.L)
      continue
    }
    const c1 = peek(P.L, 1)
    if (c === '$') {
      if (c1 === '{' || c1 === '(' || c1 === '[') {
        flushSeg()
        const exp = parseDollarLike(P)
        if (exp) parts.push(exp)
        segStart = P.L.b
        continue
      }
      if (c1 === "'") {
        // $'...' ANSI-C 字符串
        flushSeg()
        const aStart = P.L.b
        advance(P.L)
        advance(P.L)
        while (P.L.i < P.L.len && peek(P.L) !== "'") {
          if (peek(P.L) === '\\' && P.L.i + 1 < P.L.len) advance(P.L)
          advance(P.L)
        }
        if (peek(P.L) === "'") advance(P.L)
        parts.push(mk(P, 'ansi_c_string', aStart, P.L.b, []))
        segStart = P.L.b
        continue
      }
      if (isIdentStart(c1) || isDigit(c1) || SPECIAL_VARS.has(c1)) {
        flushSeg()
        const exp = parseDollarLike(P)
        if (exp) parts.push(exp)
        segStart = P.L.b
        continue
      }
    }
    if (c === '"') {
      flushSeg()
      parts.push(parseDoubleQuoted(P))
      segStart = P.L.b
      continue
    }
    if (c === "'") {
      flushSeg()
      const rStart = P.L.b
      advance(P.L)
      while (P.L.i < P.L.len && peek(P.L) !== "'") advance(P.L)
      if (peek(P.L) === "'") advance(P.L)
      parts.push(mk(P, 'raw_string', rStart, P.L.b, []))
      segStart = P.L.b
      continue
    }
    if ((c === '<' || c === '>') && c1 === '(') {
      flushSeg()
      const ps = parseProcessSub(P)
      if (ps) parts.push(ps)
      segStart = P.L.b
      continue
    }
    if (c === '`') {
      flushSeg()
      const bt = parseBacktick(P)
      if (bt) parts.push(bt)
      segStart = P.L.b
      continue
    }
    // 大括号深度跟踪，防止嵌套 {a,b} 的字符过早终止
    // （罕见，但 `${cond}?` 中的 `?` 应视为单词字符）。
    if (c === '{') braceDepth++
    else if (c === '}' && braceDepth > 0) braceDepth--
    advance(P.L)
  }
  flushSeg()
  // 消费尾部换行符（在 } 之前），使调用方能看到 }
  while (peek(P.L) === '\n') advance(P.L)
  // tree-sitter 在展开 RHS 有内容时跳过前导空白（extras）：
  // `${2+ ${2}}` → 仅有 (expansion)。但 `${v:- }`（纯空白 RHS）
  // 保留空格作为 (word)。因此，若前导纯空白 word 段不是唯一部分，则丢弃。
  if (
    parts.length > 1 &&
    parts[0]!.type === 'word' &&
    /^[ \t]+$/.test(parts[0]!.text)
  ) {
    parts.shift()
  }
  if (parts.length === 0) return null
  if (parts.length === 1) return parts[0]!
  // 多个部分：包裹为 concatenation（word 模式保留拼接包裹；
  // regex 模式在混合引号+glob 模式时也按 tree-sitter 拼接）。
  const last = parts[parts.length - 1]!
  return mk(P, 'concatenation', parts[0]!.startIndex, last.endIndex, parts)
}

/**
 * 解析 `#` `##` `%` `%%` 操作符后的正则模式，返回 regex/string/raw_string 节点列表。
 * 按语法 `_expansion_regex` 规则，每个引号块作为独立兄弟节点，不合并到 regex 中。
 * 遇到嵌套 `${...}` / `$(...)` 时，以不透明方式跳过，防止其 `}` 提前终止扫描。
 */
function parseExpansionRegexSegmented(P: ParseState): TsNode[] {
  const out: TsNode[] = []
  let segStart = P.L.b
  const flushRegex = (): void => {
    if (P.L.b > segStart) out.push(mk(P, 'regex', segStart, P.L.b, []))
  }
  while (P.L.i < P.L.len) {
    const c = peek(P.L)
    if (c === '}' || c === '\n') break
    if (c === '\\' && P.L.i + 1 < P.L.len) {
      advance(P.L)
      advance(P.L)
      continue
    }
    if (c === '"') {
      flushRegex()
      out.push(parseDoubleQuoted(P))
      segStart = P.L.b
      continue
    }
    if (c === "'") {
      flushRegex()
      const rStart = P.L.b
      advance(P.L)
      while (P.L.i < P.L.len && peek(P.L) !== "'") advance(P.L)
      if (peek(P.L) === "'") advance(P.L)
      out.push(mk(P, 'raw_string', rStart, P.L.b, []))
      segStart = P.L.b
      continue
    }
    // 嵌套 ${...} $(...) — 不透明扫描，防止其 } 终止当前扫描
    if (c === '$') {
      const c1 = peek(P.L, 1)
      if (c1 === '{') {
        let d = 1
        advance(P.L)
        advance(P.L)
        while (P.L.i < P.L.len && d > 0) {
          const nc = peek(P.L)
          if (nc === '{') d++
          else if (nc === '}') d--
          advance(P.L)
        }
        continue
      }
      if (c1 === '(') {
        let d = 1
        advance(P.L)
        advance(P.L)
        while (P.L.i < P.L.len && d > 0) {
          const nc = peek(P.L)
          if (nc === '(') d++
          else if (nc === ')') d--
          advance(P.L)
        }
        continue
      }
    }
    advance(P.L)
  }
  flushRegex()
  while (peek(P.L) === '\n') advance(P.L)
  return out
}

/**
 * 解析反引号命令替换 `` `...` ``，返回 command_substitution 节点或 null。
 * 内部语句委托给 parseAndOr 解析；支持分号/`&` 分隔的多语句。
 * 空反引号（仅含空白/换行）被 tree-sitter 忽略，此时返回 null——
 * 可用作行续接技巧：`"foo"``\n``"bar"` → (concatenation (string)(string))。
 * 使用 `P.inBacktick` 计数器支持嵌套反引号（如 `` `echo \`date\`` ``）。
 */
function parseBacktick(P: ParseState): TsNode | null {
  const start = P.L.b
  advance(P.L)
  const open = mk(P, '`', start, P.L.b, [])
  P.inBacktick++
  // 内联解析语句 — 在反引号处停止
  const body: TsNode[] = []
  while (true) {
    skipBlanks(P.L)
    if (peek(P.L) === '`' || peek(P.L) === '') break
    const save = saveLex(P.L)
    const t = nextToken(P.L, 'cmd')
    if (t.type === 'EOF' || t.type === 'BACKTICK') {
      restoreLex(P.L, save)
      break
    }
    if (t.type === 'NEWLINE') continue
    restoreLex(P.L, save)
    const stmt = parseAndOr(P)
    if (!stmt) break
    body.push(stmt)
    skipBlanks(P.L)
    if (peek(P.L) === '`') break
    const save2 = saveLex(P.L)
    const sep = nextToken(P.L, 'cmd')
    if (sep.type === 'OP' && (sep.value === ';' || sep.value === '&')) {
      body.push(leaf(P, sep.value, sep))
    } else if (sep.type !== 'NEWLINE') {
      restoreLex(P.L, save2)
    }
  }
  P.inBacktick--
  let close: TsNode
  if (peek(P.L) === '`') {
    const cStart = P.L.b
    advance(P.L)
    close = mk(P, '`', cStart, P.L.b, [])
  } else {
    close = mk(P, '`', P.L.b, P.L.b, [])
  }
  // 空反引号（仅含空白/换行）会被 tree-sitter 完全省略 —
  // 常用作行续接技巧：`"foo"``<newline>``"bar"`
  // → (concatenation (string) (string))，不含 command_substitution。
  if (body.length === 0) return null
  return mk(P, 'command_substitution', start, close.endIndex, [
    open,
    ...body,
    close,
  ])
}

/**
 * 解析 `if...then...elif...else...fi` 语句，返回 if_statement 节点。
 * 循环处理 elif_clause 和 else_clause；通过 consumeKeyword 消费 then/fi 关键字。
 */
function parseIf(P: ParseState, ifTok: Token): TsNode {
  const ifKw = leaf(P, 'if', ifTok)
  const kids: TsNode[] = [ifKw]
  const cond = parseStatements(P, null)
  kids.push(...cond)
  consumeKeyword(P, 'then', kids)
  const body = parseStatements(P, null)
  kids.push(...body)
  while (true) {
    const save = saveLex(P.L)
    const t = nextToken(P.L, 'cmd')
    if (t.type === 'WORD' && t.value === 'elif') {
      const eKw = leaf(P, 'elif', t)
      const eCond = parseStatements(P, null)
      const eKids: TsNode[] = [eKw, ...eCond]
      consumeKeyword(P, 'then', eKids)
      const eBody = parseStatements(P, null)
      eKids.push(...eBody)
      const last = eKids[eKids.length - 1]!
      kids.push(mk(P, 'elif_clause', eKw.startIndex, last.endIndex, eKids))
    } else if (t.type === 'WORD' && t.value === 'else') {
      const elKw = leaf(P, 'else', t)
      const elBody = parseStatements(P, null)
      const last = elBody.length > 0 ? elBody[elBody.length - 1]! : elKw
      kids.push(
        mk(P, 'else_clause', elKw.startIndex, last.endIndex, [elKw, ...elBody]),
      )
    } else {
      restoreLex(P.L, save)
      break
    }
  }
  consumeKeyword(P, 'fi', kids)
  const last = kids[kids.length - 1]!
  return mk(P, 'if_statement', ifKw.startIndex, last.endIndex, kids)
}

/**
 * 解析 `while`/`until` 循环，返回 while_statement 节点。
 * 条件部分由 parseStatements 解析，循环体由 parseDoGroup 解析。
 */
function parseWhile(P: ParseState, kwTok: Token): TsNode {
  const kw = leaf(P, kwTok.value, kwTok)
  const kids: TsNode[] = [kw]
  const cond = parseStatements(P, null)
  kids.push(...cond)
  const dg = parseDoGroup(P)
  if (dg) kids.push(dg)
  const last = kids[kids.length - 1]!
  return mk(P, 'while_statement', kw.startIndex, last.endIndex, kids)
}

/**
 * 解析 `for`/`select` 循环，返回 for_statement 或 c_style_for_statement 节点。
 * - C 风格 `for (( init; cond; update ))` → c_style_for_statement，仅 `for` 支持；
 * - 普通 `for VAR in words; do...done` → for_statement；
 * - `select VAR in words; do...done` → select_statement。
 * 循环体既可以是 do/done 组，也可以是 `{...}` 复合语句（C 风格 for 特有）。
 */
function parseFor(P: ParseState, forTok: Token): TsNode {
  const forKw = leaf(P, forTok.value, forTok)
  skipBlanks(P.L)
  // C 风格 for (( ; ; )) — 仅适用于 `for`，不适用于 `select`
  if (forTok.value === 'for' && peek(P.L) === '(' && peek(P.L, 1) === '(') {
    const oStart = P.L.b
    advance(P.L)
    advance(P.L)
    const open = mk(P, '((', oStart, P.L.b, [])
    const kids: TsNode[] = [forKw, open]
    // init; cond; update — 三个子句均使用 'assign' 模式，使 `c = expr` 发出
    // variable_assignment，而裸标识符（如 `c<=5` 中的 c）→ word。每个子句
    // 均可为逗号分隔的列表。
    for (let k = 0; k < 3; k++) {
      skipBlanks(P.L)
      const es = parseArithCommaList(P, k < 2 ? ';' : '))', 'assign')
      kids.push(...es)
      if (k < 2) {
        if (peek(P.L) === ';') {
          const s = P.L.b
          advance(P.L)
          kids.push(mk(P, ';', s, P.L.b, []))
        }
      }
    }
    skipBlanks(P.L)
    if (peek(P.L) === ')' && peek(P.L, 1) === ')') {
      const cStart = P.L.b
      advance(P.L)
      advance(P.L)
      kids.push(mk(P, '))', cStart, P.L.b, []))
    }
    // 可选的 ; 或换行符
    const save = saveLex(P.L)
    const sep = nextToken(P.L, 'cmd')
    if (sep.type === 'OP' && sep.value === ';') {
      kids.push(leaf(P, ';', sep))
    } else if (sep.type !== 'NEWLINE') {
      restoreLex(P.L, save)
    }
    const dg = parseDoGroup(P)
    if (dg) {
      kids.push(dg)
    } else {
      // C 风格 for 也可用 `{ ... }` 替代 `do ... done` 作为循环体
      skipNewlines(P)
      skipBlanks(P.L)
      if (peek(P.L) === '{') {
        const bOpen = P.L.b
        advance(P.L)
        const brace = mk(P, '{', bOpen, P.L.b, [])
        const body = parseStatements(P, '}')
        let bClose: TsNode
        if (peek(P.L) === '}') {
          const cs = P.L.b
          advance(P.L)
          bClose = mk(P, '}', cs, P.L.b, [])
        } else {
          bClose = mk(P, '}', P.L.b, P.L.b, [])
        }
        kids.push(
          mk(P, 'compound_statement', brace.startIndex, bClose.endIndex, [
            brace,
            ...body,
            bClose,
          ]),
        )
      }
    }
    const last = kids[kids.length - 1]!
    return mk(P, 'c_style_for_statement', forKw.startIndex, last.endIndex, kids)
  }
  // 普通 for VAR in words; do ... done
  const kids: TsNode[] = [forKw]
  const varTok = nextToken(P.L, 'arg')
  kids.push(mk(P, 'variable_name', varTok.start, varTok.end, []))
  skipBlanks(P.L)
  const save = saveLex(P.L)
  const inTok = nextToken(P.L, 'arg')
  if (inTok.type === 'WORD' && inTok.value === 'in') {
    kids.push(leaf(P, 'in', inTok))
    while (true) {
      skipBlanks(P.L)
      const c = peek(P.L)
      if (c === ';' || c === '\n' || c === '') break
      const w = parseWord(P, 'arg')
      if (!w) break
      kids.push(w)
    }
  } else {
    restoreLex(P.L, save)
  }
  // 分隔符（; 或换行）
  const save2 = saveLex(P.L)
  const sep = nextToken(P.L, 'cmd')
  if (sep.type === 'OP' && sep.value === ';') {
    kids.push(leaf(P, ';', sep))
  } else if (sep.type !== 'NEWLINE') {
    restoreLex(P.L, save2)
  }
  const dg = parseDoGroup(P)
  if (dg) kids.push(dg)
  const last = kids[kids.length - 1]!
  return mk(P, 'for_statement', forKw.startIndex, last.endIndex, kids)
}

/**
 * 解析 `do...done` 循环体组，返回 do_group 节点或 null。
 * 期望下一个 token 为 `do` 关键字；若不符合则回溯并返回 null。
 * 内部语句由 parseStatements 解析，`done` 由 consumeKeyword 消费。
 */
function parseDoGroup(P: ParseState): TsNode | null {
  skipNewlines(P)
  const save = saveLex(P.L)
  const doTok = nextToken(P.L, 'cmd')
  if (doTok.type !== 'WORD' || doTok.value !== 'do') {
    restoreLex(P.L, save)
    return null
  }
  const doKw = leaf(P, 'do', doTok)
  const body = parseStatements(P, null)
  const kids: TsNode[] = [doKw, ...body]
  consumeKeyword(P, 'done', kids)
  const last = kids[kids.length - 1]!
  return mk(P, 'do_group', doKw.startIndex, last.endIndex, kids)
}

/**
 * 解析 `case WORD in ... esac` 语句，返回 case_statement 节点。
 * 循环读取 case_item 分支，直至遇到 `esac` 关键字或 EOF 为止。
 * 每个分支委托给 parseCaseItem 解析。
 */
function parseCase(P: ParseState, caseTok: Token): TsNode {
  const caseKw = leaf(P, 'case', caseTok)
  const kids: TsNode[] = [caseKw]
  skipBlanks(P.L)
  const word = parseWord(P, 'arg')
  if (word) kids.push(word)
  skipBlanks(P.L)
  consumeKeyword(P, 'in', kids)
  skipNewlines(P)
  while (true) {
    skipBlanks(P.L)
    skipNewlines(P)
    const save = saveLex(P.L)
    const t = nextToken(P.L, 'arg')
    if (t.type === 'WORD' && t.value === 'esac') {
      kids.push(leaf(P, 'esac', t))
      break
    }
    if (t.type === 'EOF') break
    restoreLex(P.L, save)
    const item = parseCaseItem(P)
    if (!item) break
    kids.push(item)
  }
  const last = kids[kids.length - 1]!
  return mk(P, 'case_statement', caseKw.startIndex, last.endIndex, kids)
}

/**
 * 解析单个 case 分支项（case_item），返回节点或 null（无模式时）。
 * 结构：可选 `(` → 一或多个模式（`|` 分隔）→ `)` → 语句体 → `;;`/`;&`/`;;&` 终止符。
 * tree-sitter 特性：后续备选项含多段时包裹为 concatenation，首段保留平铺形式。
 * 空 body 且模式形如 extglob 操作符前缀时降级为普通 word 节点。
 */
function parseCaseItem(P: ParseState): TsNode | null {
  skipBlanks(P.L)
  const start = P.L.b
  const kids: TsNode[] = []
  // 可选的前置 '('（bash 允许 (pattern) 语法）
  if (peek(P.L) === '(') {
    const s = P.L.b
    advance(P.L)
    kids.push(mk(P, '(', s, P.L.b, []))
  }
  // 模式（可能多个）
  let isFirstAlt = true
  while (true) {
    skipBlanks(P.L)
    const c = peek(P.L)
    if (c === ')' || c === '') break
    const pats = parseCasePattern(P)
    if (pats.length === 0) break
    // tree-sitter 特性：第一个含引号的备选项以平铺兄弟节点形式内联；
    // 后续备选项包裹在 (concatenation) 中，裸段使用 `word` 而非 `extglob_pattern`。
    if (!isFirstAlt && pats.length > 1) {
      const rewritten = pats.map(p =>
        p.type === 'extglob_pattern'
          ? mk(P, 'word', p.startIndex, p.endIndex, [])
          : p,
      )
      const first = rewritten[0]!
      const last = rewritten[rewritten.length - 1]!
      kids.push(
        mk(P, 'concatenation', first.startIndex, last.endIndex, rewritten),
      )
    } else {
      kids.push(...pats)
    }
    isFirstAlt = false
    skipBlanks(P.L)
    // \<换行> 行续接（备选项之间）
    if (peek(P.L) === '\\' && peek(P.L, 1) === '\n') {
      advance(P.L)
      advance(P.L)
      skipBlanks(P.L)
    }
    if (peek(P.L) === '|') {
      const s = P.L.b
      advance(P.L)
      kids.push(mk(P, '|', s, P.L.b, []))
      // \<换行> 在 | 之后同样为行续接
      if (peek(P.L) === '\\' && peek(P.L, 1) === '\n') {
        advance(P.L)
        advance(P.L)
      }
    } else {
      break
    }
  }
  if (peek(P.L) === ')') {
    const s = P.L.b
    advance(P.L)
    kids.push(mk(P, ')', s, P.L.b, []))
  }
  const body = parseStatements(P, null)
  kids.push(...body)
  const save = saveLex(P.L)
  const term = nextToken(P.L, 'cmd')
  if (
    term.type === 'OP' &&
    (term.value === ';;' || term.value === ';&' || term.value === ';;&')
  ) {
    kids.push(leaf(P, term.value, term))
  } else {
    restoreLex(P.L, save)
  }
  if (kids.length === 0) return null
  // tree-sitter 特性：case_item 空 body 且单个模式匹配 extglob 操作符字符前缀
  // （无实际 glob 元字符）时降级为 word。
  // `-o) owner=$2 ;;`（有 body）→ extglob_pattern；`-g) ;;`（空）→ word。
  if (body.length === 0) {
    for (let i = 0; i < kids.length; i++) {
      const k = kids[i]!
      if (k.type !== 'extglob_pattern') continue
      const text = sliceBytes(P, k.startIndex, k.endIndex)
      if (/^[-+?*@!][a-zA-Z]/.test(text) && !/[*?(]/.test(text)) {
        kids[i] = mk(P, 'word', k.startIndex, k.endIndex, [])
      }
    }
  }
  const last = kids[kids.length - 1]!
  return mk(P, 'case_item', start, last.endIndex, kids)
}

/**
 * 解析单个 case 模式，返回节点数组（可能为空）。
 * 扫描至 `)` `|` 空白 或换行为止；遇到引号则跳过其内容（避免 `|` 误截断）。
 * - 含引号但无 extglob 括号：委托给 parseCasePatternSegmented 按段分割；
 * - 含 `$` 或 `[`（无 extglob 括号）：委托给 parseWord 获得 concatenation；
 * - 其余：依据是否有 extglob 元字符决定节点类型（extglob_pattern 或 word）。
 */
function parseCasePattern(P: ParseState): TsNode[] {
  skipBlanks(P.L)
  const save = saveLex(P.L)
  const start = P.L.b
  const startI = P.L.i
  let parenDepth = 0
  let hasDollar = false
  let hasBracketOutsideParen = false
  let hasQuote = false
  while (P.L.i < P.L.len) {
    const c = peek(P.L)
    if (c === '\\' && P.L.i + 1 < P.L.len) {
    // 转义字符 — 同时消费两个字符（处理 `bar\ baz` 作为单一模式）
    // \<换行> 为行续接；消费但继续扫描。
    advance(P.L)
      advance(P.L)
      continue
    }
    if (c === '"' || c === "'") {
      hasQuote = true
      // 跳过引号段内容（空格、| 等），避免干扰前瞻扫描。
      advance(P.L)
      while (P.L.i < P.L.len && peek(P.L) !== c) {
        if (peek(P.L) === '\\' && P.L.i + 1 < P.L.len) advance(P.L)
        advance(P.L)
      }
      if (peek(P.L) === c) advance(P.L)
      continue
    }
    // 圆括号计数：模式中的任何 ( 开启一个作用域；在括号平衡前不在 ) 或 | 处断开。
    // 处理 extglob *(a|b) 以及嵌套形态 *([0-9])([0-9])。
    if (c === '(') {
      parenDepth++
      advance(P.L)
      continue
    }
    if (parenDepth > 0) {
      if (c === ')') {
        parenDepth--
        advance(P.L)
        continue
      }
      if (c === '\n') break
      advance(P.L)
      continue
    }
    if (c === ')' || c === '|' || c === ' ' || c === '\t' || c === '\n') break
    if (c === '$') hasDollar = true
    if (c === '[') hasBracketOutsideParen = true
    advance(P.L)
  }
  if (P.L.b === start) return []
  const text = P.src.slice(startI, P.L.i)
  const hasExtglobParen = /[*?+@!]\(/.test(text)
  // 模式中的引号段：tree-sitter 在引号边界处分割为多个兄弟节点。
  // `*"foo"*` → (extglob_pattern)(string)(extglob_pattern)。使用分段扫描重新处理。
  if (hasQuote && !hasExtglobParen) {
    restoreLex(P.L, save)
    return parseCasePatternSegmented(P)
  }
  // tree-sitter 对含 [ 或 $ 的模式通过 word 解析分割为 concatenation，
  // 除非模式含 extglob 圆括号（此时覆盖并发出 extglob_pattern）。
  // `*.[1357]` → concat(word word number word)；`${PN}.pot` → concat(expansion word)；
  // 但 `*([0-9])` → extglob_pattern（含 extglob 圆括号）。
  if (!hasExtglobParen && (hasDollar || hasBracketOutsideParen)) {
    restoreLex(P.L, save)
    const w = parseWord(P, 'arg')
    return w ? [w] : []
  }
  // 以 extglob 操作符字符（+ - ? * @ !）加标识符字符开头的模式，
  // 即使没有圆括号或 glob 元字符，tree-sitter 也视为 extglob_pattern。
  // `-o)` → extglob_pattern；普通 `foo)` → word。
  const type =
    hasExtglobParen || /[*?]/.test(text) || /^[-+?*@!][a-zA-Z]/.test(text)
      ? 'extglob_pattern'
      : 'word'
  return [mk(P, type, start, P.L.b, [])]
}

// 含引号 case 模式的分段扫描：`*"foo"*` →
// [extglob_pattern, string, extglob_pattern]。裸段若含 */? 则为 extglob_pattern，否则为 word。
// 在引号外遇到 ) | 空格 制表符 换行 时停止。
/**
 * 对含引号的 case 模式进行分段扫描，返回子节点列表。
 * `*"foo"*` → [extglob_pattern, string, extglob_pattern]。
 * 裸文本段依据是否含 `*`/`?` 决定类型；`"..."` 委托给 parseDoubleQuoted，`'...'` 作为 raw_string。
 * 在引号外遇到 `)` `|` 空白 换行时停止。
 */
function parseCasePatternSegmented(P: ParseState): TsNode[] {
  const parts: TsNode[] = []
  let segStart = P.L.b
  let segStartI = P.L.i
  const flushSeg = (): void => {
    if (P.L.i > segStartI) {
      const t = P.src.slice(segStartI, P.L.i)
      const type = /[*?]/.test(t) ? 'extglob_pattern' : 'word'
      parts.push(mk(P, type, segStart, P.L.b, []))
    }
  }
  while (P.L.i < P.L.len) {
    const c = peek(P.L)
    if (c === '\\' && P.L.i + 1 < P.L.len) {
      advance(P.L)
      advance(P.L)
      continue
    }
    if (c === '"') {
      flushSeg()
      parts.push(parseDoubleQuoted(P))
      segStart = P.L.b
      segStartI = P.L.i
      continue
    }
    if (c === "'") {
      flushSeg()
      const tok = nextToken(P.L, 'arg')
      parts.push(leaf(P, 'raw_string', tok))
      segStart = P.L.b
      segStartI = P.L.i
      continue
    }
    if (c === ')' || c === '|' || c === ' ' || c === '\t' || c === '\n') break
    advance(P.L)
  }
  flushSeg()
  return parts
}

/**
 * 解析 `function NAME [()]` 函数定义，返回 function_definition 节点。
 * 可选的 `()` 括号对被消费为子节点；函数体由 parseCommand 解析。
 * tree-sitter 特性：若函数体为 `redirected_statement(compound_statement, ...)` 形式，
 * 其重定向子节点会被提升（hoist）到 function_definition 顶层。
 */
function parseFunction(P: ParseState, fnTok: Token): TsNode {
  const fnKw = leaf(P, 'function', fnTok)
  skipBlanks(P.L)
  const nameTok = nextToken(P.L, 'arg')
  const name = mk(P, 'word', nameTok.start, nameTok.end, [])
  const kids: TsNode[] = [fnKw, name]
  skipBlanks(P.L)
  if (peek(P.L) === '(' && peek(P.L, 1) === ')') {
    const o = nextToken(P.L, 'cmd')
    const c = nextToken(P.L, 'cmd')
    kids.push(leaf(P, '(', o))
    kids.push(leaf(P, ')', c))
  }
  skipBlanks(P.L)
  skipNewlines(P)
  const body = parseCommand(P)
  if (body) {
    // 将重定向从 redirected_statement(compound_statement, ...) 提升至
    // function_definition 层级（按 tree-sitter 语法规则）
    if (
      body.type === 'redirected_statement' &&
      body.children.length >= 2 &&
      body.children[0]!.type === 'compound_statement'
    ) {
      kids.push(...body.children)
    } else {
      kids.push(body)
    }
  }
  const last = kids[kids.length - 1]!
  return mk(P, 'function_definition', fnKw.startIndex, last.endIndex, kids)
}

/**
 * 解析声明命令（`local`/`declare`/`export`/`readonly`/`typeset` 等），
 * 返回 declaration_command 节点。
 * 循环消费赋值表达式、引号字符串、标志参数（`-a`）或裸变量名，
 * 直至遇到命令终止符为止。
 */
function parseDeclaration(P: ParseState, kwTok: Token): TsNode {
  const kw = leaf(P, kwTok.value, kwTok)
  const kids: TsNode[] = [kw]
  while (true) {
    skipBlanks(P.L)
    const c = peek(P.L)
    if (
      c === '' ||
      c === '\n' ||
      c === ';' ||
      c === '&' ||
      c === '|' ||
      c === ')' ||
      c === '<' ||
      c === '>'
    ) {
      break
    }
    const a = tryParseAssignment(P)
    if (a) {
      kids.push(a)
      continue
    }
    // 引号字符串或拼接：`export "FOO=bar"`、`export 'X'`
    if (c === '"' || c === "'" || c === '$') {
      const w = parseWord(P, 'arg')
      if (w) {
        kids.push(w)
        continue
      }
      break
    }
    // 标志（如 -a）或裸变量名
    const save = saveLex(P.L)
    const tok = nextToken(P.L, 'arg')
    if (tok.type === 'WORD' || tok.type === 'NUMBER') {
      if (tok.value.startsWith('-')) {
        kids.push(leaf(P, 'word', tok))
      } else if (isIdentStart(tok.value[0] ?? '')) {
        kids.push(mk(P, 'variable_name', tok.start, tok.end, []))
      } else {
        kids.push(leaf(P, 'word', tok))
      }
    } else {
      restoreLex(P.L, save)
      break
    }
  }
  const last = kids[kids.length - 1]!
  return mk(P, 'declaration_command', kw.startIndex, last.endIndex, kids)
}

/**
 * 解析 `unset`/`unsetenv` 命令，返回 unset_command 节点。
 * 安全性：使用 parseWord（而非裸 nextToken）解析参数，
 * 确保 `unset 'a[$(id)]'` 中的引号字符串以 raw_string 节点呈现，
 * 从而让安全检查器能够拒绝算术下标代码执行向量。
 * `-f`/`-v` 等标志作为 word 节点保留；裸变量名升级为 variable_name 节点。
 */
function parseUnset(P: ParseState, kwTok: Token): TsNode {
  const kw = leaf(P, 'unset', kwTok)
  const kids: TsNode[] = [kw]
  while (true) {
    skipBlanks(P.L)
    const c = peek(P.L)
    if (
      c === '' ||
      c === '\n' ||
      c === ';' ||
      c === '&' ||
      c === '|' ||
      c === ')' ||
      c === '<' ||
      c === '>'
    ) {
      break
    }
    // 安全：使用 parseWord（而非原始 nextToken），确保 `unset 'a[$(id)]'` 这类
    // 引号字符串以 raw_string 子节点形式发出，使 ast.ts 能够拒绝。
    // 此前 `break` 会静默丢弃非 WORD 参数，从而对安全遍历器隐藏
    // 算术下标代码执行漏洞。
    const arg = parseWord(P, 'arg')
    if (!arg) break
    if (arg.type === 'word') {
      if (arg.text.startsWith('-')) {
        kids.push(arg)
      } else {
        kids.push(mk(P, 'variable_name', arg.startIndex, arg.endIndex, []))
      }
    } else {
      kids.push(arg)
    }
  }
  const last = kids[kids.length - 1]!
  return mk(P, 'unset_command', kw.startIndex, last.endIndex, kids)
}

/**
 * 尝试消费指定名称的关键字 token，若成功则追加到 kids 数组。
 * 跳过换行后读取下一个 token；若不匹配则回溯，不修改 kids。
 * 用于消费 `then`/`do`/`done`/`fi`/`in` 等控制结构关键字。
 */
function consumeKeyword(P: ParseState, name: string, kids: TsNode[]): void {
  skipNewlines(P)
  const save = saveLex(P.L)
  const t = nextToken(P.L, 'cmd')
  if (t.type === 'WORD' && t.value === name) {
    kids.push(leaf(P, name, t))
  } else {
    restoreLex(P.L, save)
  }
}

// ───────────────────── Test & Arithmetic Expressions ─────────────────────

/**
 * 解析测试表达式（`[[ ... ]]` 或 `[ ... ]` 内部），
 * 委托给 parseTestOr 作为顶层入口。
 */
function parseTestExpr(P: ParseState, closer: string): TsNode | null {
  return parseTestOr(P, closer)
}

/**
 * 解析测试 `||` 或运算层，返回 binary_expression 或委托给 parseTestAnd。
 */
function parseTestOr(P: ParseState, closer: string): TsNode | null {
  let left = parseTestAnd(P, closer)
  if (!left) return null
  while (true) {
    skipBlanks(P.L)
    const save = saveLex(P.L)
    if (peek(P.L) === '|' && peek(P.L, 1) === '|') {
      const s = P.L.b
      advance(P.L)
      advance(P.L)
      const op = mk(P, '||', s, P.L.b, [])
      const right = parseTestAnd(P, closer)
      if (!right) {
        restoreLex(P.L, save)
        break
      }
      left = mk(P, 'binary_expression', left.startIndex, right.endIndex, [
        left,
        op,
        right,
      ])
    } else {
      break
    }
  }
  return left
}

/**
 * 解析测试 `&&` 与运算层，返回 binary_expression 或委托给 parseTestUnary。
 */
function parseTestAnd(P: ParseState, closer: string): TsNode | null {
  let left = parseTestUnary(P, closer)
  if (!left) return null
  while (true) {
    skipBlanks(P.L)
    if (peek(P.L) === '&' && peek(P.L, 1) === '&') {
      const s = P.L.b
      advance(P.L)
      advance(P.L)
      const op = mk(P, '&&', s, P.L.b, [])
      const right = parseTestUnary(P, closer)
      if (!right) break
      left = mk(P, 'binary_expression', left.startIndex, right.endIndex, [
        left,
        op,
        right,
      ])
    } else {
      break
    }
  }
  return left
}

/**
 * 解析测试一元表达式层。
 * 处理括号分组 `(...)` → parenthesized_expression；
 * 其余委托给 parseTestBinary 解析二元比较或可否定原子式。
 */
function parseTestUnary(P: ParseState, closer: string): TsNode | null {
  skipBlanks(P.L)
  const c = peek(P.L)
  if (c === '(') {
    const s = P.L.b
    advance(P.L)
    const open = mk(P, '(', s, P.L.b, [])
    const inner = parseTestOr(P, closer)
    skipBlanks(P.L)
    let close: TsNode
    if (peek(P.L) === ')') {
      const cs = P.L.b
      advance(P.L)
      close = mk(P, ')', cs, P.L.b, [])
    } else {
      close = mk(P, ')', P.L.b, P.L.b, [])
    }
    const kids = inner ? [open, inner, close] : [open, close]
    return mk(
      P,
      'parenthesized_expression',
      open.startIndex,
      close.endIndex,
      kids,
    )
  }
  return parseTestBinary(P, closer)
}

/**
 * 解析 `!` 取反或测试操作符（`-f`）或带括号的主元 — 但不解析二元比较。
 * 作为 binary_expression 的左侧使用，使 `! x =~ y` 中的 `!` 仅绑定 `x`，
 * 而非整个 `x =~ y`。
 */
function parseTestNegatablePrimary(
  P: ParseState,
  closer: string,
): TsNode | null {
  skipBlanks(P.L)
  const c = peek(P.L)
  if (c === '!') {
    const s = P.L.b
    advance(P.L)
    const bang = mk(P, '!', s, P.L.b, [])
    const inner = parseTestNegatablePrimary(P, closer)
    if (!inner) return bang
    return mk(P, 'unary_expression', bang.startIndex, inner.endIndex, [
      bang,
      inner,
    ])
  }
  if (c === '-' && isIdentStart(peek(P.L, 1))) {
    const s = P.L.b
    advance(P.L)
    while (isIdentChar(peek(P.L))) advance(P.L)
    const op = mk(P, 'test_operator', s, P.L.b, [])
    skipBlanks(P.L)
    const arg = parseTestPrimary(P, closer)
    if (!arg) return op
    return mk(P, 'unary_expression', op.startIndex, arg.endIndex, [op, arg])
  }
  return parseTestPrimary(P, closer)
}

/**
 * 解析测试二元比较层，返回 binary_expression 或单侧原子节点。
 * LHS 由 parseTestNegatablePrimary 解析；操作符包括 `==` `!=` `=~` `=` `<` `>` `-eq` 等。
 * 在 `[[ ]]` 上下文中：`=~` RHS 解析为 regex；`=` RHS 解析为 regex；
 * `==`/`!=` RHS 解析为 extglob_pattern 分段列表。
 */
function parseTestBinary(P: ParseState, closer: string): TsNode | null {
  skipBlanks(P.L)
  // `!` 在 test 上下文中比 =~/== 绑定更紧。
  // `[[ ! "x" =~ y ]]` → (binary_expression (unary_expression (string)) (regex))
  // `[[ ! -f x ]]` → (unary_expression ! (unary_expression (test_operator) (word)))
  const left = parseTestNegatablePrimary(P, closer)
  if (!left) return null
  skipBlanks(P.L)
  // 二元比较：== != =~ -eq -lt 等
  const c = peek(P.L)
  const c1 = peek(P.L, 1)
  let op: TsNode | null = null
  const os = P.L.b
  if (c === '=' && c1 === '=') {
    advance(P.L)
    advance(P.L)
    op = mk(P, '==', os, P.L.b, [])
  } else if (c === '!' && c1 === '=') {
    advance(P.L)
    advance(P.L)
    op = mk(P, '!=', os, P.L.b, [])
  } else if (c === '=' && c1 === '~') {
    advance(P.L)
    advance(P.L)
    op = mk(P, '=~', os, P.L.b, [])
  } else if (c === '=' && c1 !== '=') {
    advance(P.L)
    op = mk(P, '=', os, P.L.b, [])
  } else if (c === '<' && c1 !== '<') {
    advance(P.L)
    op = mk(P, '<', os, P.L.b, [])
  } else if (c === '>' && c1 !== '>') {
    advance(P.L)
    op = mk(P, '>', os, P.L.b, [])
  } else if (c === '-' && isIdentStart(c1)) {
    advance(P.L)
    while (isIdentChar(peek(P.L))) advance(P.L)
    op = mk(P, 'test_operator', os, P.L.b, [])
  }
  if (!op) return left
  skipBlanks(P.L)
  // 在 [[ ]] 中，==/!=/=/=~ 的右侧使用特殊模式解析：
  // 括号计数确保 @(a|b|c) 不在 | 处断开，各段成为 extglob_pattern/regex。
  if (closer === ']]') {
    const opText = op.type
    if (opText === '=~') {
      skipBlanks(P.L)
      // 若整个 RHS 为引号字符串，发出 string/raw_string 而非 regex：
      // `[[ "$x" =~ "$y" ]]` → (binary_expression (string) (string))。
      // 若引号后还有内容（如 `' boop '(.*)$`），整个 RHS 保持为单个 (regex)。
      // 向前窥探引号之后的内容以判断。
      const rc = peek(P.L)
      let rhs: TsNode | null = null
      if (rc === '"' || rc === "'") {
        const save = saveLex(P.L)
        const quoted =
          rc === '"'
            ? parseDoubleQuoted(P)
            : leaf(P, 'raw_string', nextToken(P.L, 'arg'))
        // 检查 RHS 是否到此结束：后面只有空白，然后是 ]] 或 &&/|| 或换行
        let j = P.L.i
        while (j < P.L.len && (P.src[j] === ' ' || P.src[j] === '\t')) j++
        const nc = P.src[j] ?? ''
        const nc1 = P.src[j + 1] ?? ''
        if (
          (nc === ']' && nc1 === ']') ||
          (nc === '&' && nc1 === '&') ||
          (nc === '|' && nc1 === '|') ||
          nc === '\n' ||
          nc === ''
        ) {
          rhs = quoted
        } else {
          restoreLex(P.L, save)
        }
      }
      if (!rhs) rhs = parseTestRegexRhs(P)
      if (!rhs) return left
      return mk(P, 'binary_expression', left.startIndex, rhs.endIndex, [
        left,
        op,
        rhs,
      ])
    }
    // 单个 `=` 按 tree-sitter 发出 (regex)；`==` 和 `!=` 发出 extglob_pattern
    if (opText === '=') {
      const rhs = parseTestRegexRhs(P)
      if (!rhs) return left
      return mk(P, 'binary_expression', left.startIndex, rhs.endIndex, [
        left,
        op,
        rhs,
      ])
    }
    if (opText === '==' || opText === '!=') {
      const parts = parseTestExtglobRhs(P)
      if (parts.length === 0) return left
      const last = parts[parts.length - 1]!
      return mk(P, 'binary_expression', left.startIndex, last.endIndex, [
        left,
        op,
        ...parts,
      ])
    }
  }
  const right = parseTestPrimary(P, closer)
  if (!right) return left
  return mk(P, 'binary_expression', left.startIndex, right.endIndex, [
    left,
    op,
    right,
  ])
}

// [[ ]] 中 =~ 的右侧 — 以括号/方括号计数扫描为单个 (regex) 节点，
// 使正则中的 | ( ) 不干扰解析。遇到 ]] 或 空白+&&/|| 时停止。
/**
 * 解析 `[[ ]]` 中 `=~` 的右侧，返回单个 regex 节点。
 * 维护括号深度与方括号深度，确保正则内的 `|` `(` `)` 不被误识别为测试终止符。
 * 遇到 `]]`、空白后跟 `&&`/`||` 或换行时停止扫描。
 */
function parseTestRegexRhs(P: ParseState): TsNode | null {
  skipBlanks(P.L)
  const start = P.L.b
  let parenDepth = 0
  let bracketDepth = 0
  while (P.L.i < P.L.len) {
    const c = peek(P.L)
    if (c === '\\' && P.L.i + 1 < P.L.len) {
      advance(P.L)
      advance(P.L)
      continue
    }
    if (c === '\n') break
    if (parenDepth === 0 && bracketDepth === 0) {
      if (c === ']' && peek(P.L, 1) === ']') break
      if (c === ' ' || c === '\t') {
        // 跳过空白，窥探 ]] 或 &&/||
        let j = P.L.i
        while (j < P.L.len && (P.L.src[j] === ' ' || P.L.src[j] === '\t')) j++
        const nc = P.L.src[j] ?? ''
        const nc1 = P.L.src[j + 1] ?? ''
        if (
          (nc === ']' && nc1 === ']') ||
          (nc === '&' && nc1 === '&') ||
          (nc === '|' && nc1 === '|')
        ) {
          break
        }
        advance(P.L)
        continue
      }
    }
    if (c === '(') parenDepth++
    else if (c === ')' && parenDepth > 0) parenDepth--
    else if (c === '[') bracketDepth++
    else if (c === ']' && bracketDepth > 0) bracketDepth--
    advance(P.L)
  }
  if (P.L.b === start) return null
  return mk(P, 'regex', start, P.L.b, [])
}

// [[ ]] 中 ==/!=/= 的右侧 — 返回节点数组。裸文本 → extglob_pattern
// （含括号计数以处理 @(a|b)）；$(...)/$/引号 → 对应节点类型。
// 多个部分作为 binary_expression 的平铺子节点（按 tree-sitter 规则）。
/**
 * 解析 `[[ ]]` 中 `==`/`!=`/`=` 的右侧，返回节点数组。
 * 裸文本段（含 extglob 括号计数）生成 extglob_pattern；`$`/引号生成对应节点类型。
 * 多个部分作为 binary_expression 的平铺子节点存在（tree-sitter 规则）。
 */
function parseTestExtglobRhs(P: ParseState): TsNode[] {
  skipBlanks(P.L)
  const parts: TsNode[] = []
  let segStart = P.L.b
  let segStartI = P.L.i
  let parenDepth = 0
  const flushSeg = () => {
    if (P.L.i > segStartI) {
      const text = P.src.slice(segStartI, P.L.i)
      // 纯数字保持为 number；其他一律为 extglob_pattern
      const type = /^\d+$/.test(text) ? 'number' : 'extglob_pattern'
      parts.push(mk(P, type, segStart, P.L.b, []))
    }
  }
  while (P.L.i < P.L.len) {
    const c = peek(P.L)
    if (c === '\\' && P.L.i + 1 < P.L.len) {
      advance(P.L)
      advance(P.L)
      continue
    }
    if (c === '\n') break
    if (parenDepth === 0) {
      if (c === ']' && peek(P.L, 1) === ']') break
      if (c === ' ' || c === '\t') {
        let j = P.L.i
        while (j < P.L.len && (P.L.src[j] === ' ' || P.L.src[j] === '\t')) j++
        const nc = P.L.src[j] ?? ''
        const nc1 = P.L.src[j + 1] ?? ''
        if (
          (nc === ']' && nc1 === ']') ||
          (nc === '&' && nc1 === '&') ||
          (nc === '|' && nc1 === '|')
        ) {
          break
        }
        advance(P.L)
        continue
      }
    }
    // $ " ' 即使在 @( ) extglob 括号内也必须解析 — parseDollarLike
    // 会消费对应的 )，从而保持 parenDepth 一致性。
    if (c === '$') {
      const c1 = peek(P.L, 1)
      if (
        c1 === '(' ||
        c1 === '{' ||
        isIdentStart(c1) ||
        SPECIAL_VARS.has(c1)
      ) {
        flushSeg()
        const exp = parseDollarLike(P)
        if (exp) parts.push(exp)
        segStart = P.L.b
        segStartI = P.L.i
        continue
      }
    }
    if (c === '"') {
      flushSeg()
      parts.push(parseDoubleQuoted(P))
      segStart = P.L.b
      segStartI = P.L.i
      continue
    }
    if (c === "'") {
      flushSeg()
      const tok = nextToken(P.L, 'arg')
      parts.push(leaf(P, 'raw_string', tok))
      segStart = P.L.b
      segStartI = P.L.i
      continue
    }
    if (c === '(') parenDepth++
    else if (c === ')' && parenDepth > 0) parenDepth--
    advance(P.L)
  }
  flushSeg()
  return parts
}

/**
 * 解析测试原子项（primary）：检查 closer 边界后委托给 parseWord 获取单个词节点。
 * `closer=']]'` 时在双方括号前停止；`closer=']'` 时在单方括号前停止。
 */
function parseTestPrimary(P: ParseState, closer: string): TsNode | null {
  skipBlanks(P.L)
  // 在 closer 处停止
  if (closer === ']' && peek(P.L) === ']') return null
  if (closer === ']]' && peek(P.L) === ']' && peek(P.L, 1) === ']') return null
  return parseWord(P, 'arg')
}

/**
 * 算术上下文模式：
 * - 'var'：裸标识符 → variable_name（默认，用于 $((..))/((..))）
 * - 'word'：裸标识符 → word（C 风格 for 循环头的条件/更新子句）
 * - 'assign'：含 = 的标识符 → variable_assignment（C 风格 for 循环的 init 子句）
 */
type ArithMode = 'var' | 'word' | 'assign'

/** 操作符优先级表（值越大绑定越紧）。 */
const ARITH_PREC: Record<string, number> = {
  '=': 2,
  '+=': 2,
  '-=': 2,
  '*=': 2,
  '/=': 2,
  '%=': 2,
  '<<=': 2,
  '>>=': 2,
  '&=': 2,
  '^=': 2,
  '|=': 2,
  '||': 4,
  '&&': 5,
  '|': 6,
  '^': 7,
  '&': 8,
  '==': 9,
  '!=': 9,
  '<': 10,
  '>': 10,
  '<=': 10,
  '>=': 10,
  '<<': 11,
  '>>': 11,
  '+': 12,
  '-': 12,
  '*': 13,
  '/': 13,
  '%': 13,
  '**': 14,
}

/** 右结合操作符（赋值与幂运算）。 */
const ARITH_RIGHT_ASSOC = new Set([
  '=',
  '+=',
  '-=',
  '*=',
  '/=',
  '%=',
  '<<=',
  '>>=',
  '&=',
  '^=',
  '|=',
  '**',
])

/**
 * 解析算术表达式顶层入口，委托给 parseArithTernary。
 * `stop` 指定终止字符串（`))` `}` `)` `;` `:` `]` `:}` 等）；
 * `mode` 控制裸标识符解析为 variable_name（var）或 word（word/assign）。
 */
function parseArithExpr(
  P: ParseState,
  stop: string,
  mode: ArithMode = 'var',
): TsNode | null {
  return parseArithTernary(P, stop, mode)
}

/** 顶层：逗号分隔列表。arithmetic_expansion 发出多个子节点。 */
function parseArithCommaList(
  P: ParseState,
  stop: string,
  mode: ArithMode = 'var',
): TsNode[] {
  const out: TsNode[] = []
  while (true) {
    const e = parseArithTernary(P, stop, mode)
    if (e) out.push(e)
    skipBlanks(P.L)
    if (peek(P.L) === ',' && !isArithStop(P, stop)) {
      advance(P.L)
      continue
    }
    break
  }
  return out
}

/**
 * 解析算术三元表达式 `cond ? true : false`，返回 ternary_expression 节点或传递给 parseArithBinary。
 * `?` 和 `:` 分别作为独立叶节点；缺少 `:` 时以零长度节点占位。
 */
function parseArithTernary(
  P: ParseState,
  stop: string,
  mode: ArithMode,
): TsNode | null {
  const cond = parseArithBinary(P, stop, 0, mode)
  if (!cond) return null
  skipBlanks(P.L)
  if (peek(P.L) === '?') {
    const qs = P.L.b
    advance(P.L)
    const q = mk(P, '?', qs, P.L.b, [])
    const t = parseArithBinary(P, ':', 0, mode)
    skipBlanks(P.L)
    let colon: TsNode
    if (peek(P.L) === ':') {
      const cs = P.L.b
      advance(P.L)
      colon = mk(P, ':', cs, P.L.b, [])
    } else {
      colon = mk(P, ':', P.L.b, P.L.b, [])
    }
    const f = parseArithTernary(P, stop, mode)
    const last = f ?? colon
    const kids: TsNode[] = [cond, q]
    if (t) kids.push(t)
    kids.push(colon)
    if (f) kids.push(f)
    return mk(P, 'ternary_expression', cond.startIndex, last.endIndex, kids)
  }
  return cond
}

/** 扫描下一个算术二元操作符；返回 [文本, 长度] 或 null。 */
function scanArithOp(P: ParseState): [string, number] | null {
  const c = peek(P.L)
  const c1 = peek(P.L, 1)
  const c2 = peek(P.L, 2)
  // 三字符操作符：<<= >>=
  if (c === '<' && c1 === '<' && c2 === '=') return ['<<=', 3]
  if (c === '>' && c1 === '>' && c2 === '=') return ['>>=', 3]
  // 双字符操作符
  if (c === '*' && c1 === '*') return ['**', 2]
  if (c === '<' && c1 === '<') return ['<<', 2]
  if (c === '>' && c1 === '>') return ['>>', 2]
  if (c === '=' && c1 === '=') return ['==', 2]
  if (c === '!' && c1 === '=') return ['!=', 2]
  if (c === '<' && c1 === '=') return ['<=', 2]
  if (c === '>' && c1 === '=') return ['>=', 2]
  if (c === '&' && c1 === '&') return ['&&', 2]
  if (c === '|' && c1 === '|') return ['||', 2]
  if (c === '+' && c1 === '=') return ['+=', 2]
  if (c === '-' && c1 === '=') return ['-=', 2]
  if (c === '*' && c1 === '=') return ['*=', 2]
  if (c === '/' && c1 === '=') return ['/=', 2]
  if (c === '%' && c1 === '=') return ['%=', 2]
  if (c === '&' && c1 === '=') return ['&=', 2]
  if (c === '^' && c1 === '=') return ['^=', 2]
  if (c === '|' && c1 === '=') return ['|=', 2]
  // 单字符操作符 — 但不含 ++ --（它们是前/后缀操作符）
  if (c === '+' && c1 !== '+') return ['+', 1]
  if (c === '-' && c1 !== '-') return ['-', 1]
  if (c === '*') return ['*', 1]
  if (c === '/') return ['/', 1]
  if (c === '%') return ['%', 1]
  if (c === '<') return ['<', 1]
  if (c === '>') return ['>', 1]
  if (c === '&') return ['&', 1]
  if (c === '|') return ['|', 1]
  if (c === '^') return ['^', 1]
  if (c === '=') return ['=', 1]
  return null
}

/** 优先级爬升二元表达式解析器。 */
function parseArithBinary(
  P: ParseState,
  stop: string,
  minPrec: number,
  mode: ArithMode,
): TsNode | null {
  let left = parseArithUnary(P, stop, mode)
  if (!left) return null
  while (true) {
    skipBlanks(P.L)
    if (isArithStop(P, stop)) break
    if (peek(P.L) === ',') break
    const opInfo = scanArithOp(P)
    if (!opInfo) break
    const [opText, opLen] = opInfo
    const prec = ARITH_PREC[opText]
    if (prec === undefined || prec < minPrec) break
    const os = P.L.b
    for (let k = 0; k < opLen; k++) advance(P.L)
    const op = mk(P, opText, os, P.L.b, [])
    const nextMin = ARITH_RIGHT_ASSOC.has(opText) ? prec : prec + 1
    const right = parseArithBinary(P, stop, nextMin, mode)
    if (!right) break
    left = mk(P, 'binary_expression', left.startIndex, right.endIndex, [
      left,
      op,
      right,
    ])
  }
  return left
}

/**
 * 解析算术一元表达式层：前缀 `++`/`--`、`-`/`+`/`!`/`~` 操作符。
 * `word`/`assign` 模式下 `-N`（负数字面量）不产生 unary_expression，直接作为 number 节点。
 * 无一元操作符时委托给 parseArithPostfix。
 */
function parseArithUnary(
  P: ParseState,
  stop: string,
  mode: ArithMode,
): TsNode | null {
  skipBlanks(P.L)
  if (isArithStop(P, stop)) return null
  const c = peek(P.L)
  const c1 = peek(P.L, 1)
  // 前缀 ++ --
  if ((c === '+' && c1 === '+') || (c === '-' && c1 === '-')) {
    const s = P.L.b
    advance(P.L)
    advance(P.L)
    const op = mk(P, c + c1, s, P.L.b, [])
    const inner = parseArithUnary(P, stop, mode)
    if (!inner) return op
    return mk(P, 'unary_expression', op.startIndex, inner.endIndex, [op, inner])
  }
  if (c === '-' || c === '+' || c === '!' || c === '~') {
    // 在 'word'/'assign' 模式（C 风格 for 循环头）中，`-N` 是单个数字字面量，
    // 而非 unary_expression（tree-sitter 规则）。'var' 模式使用 unary。
    if (mode !== 'var' && c === '-' && isDigit(c1)) {
      const s = P.L.b
      advance(P.L)
      while (isDigit(peek(P.L))) advance(P.L)
      return mk(P, 'number', s, P.L.b, [])
    }
    const s = P.L.b
    advance(P.L)
    const op = mk(P, c, s, P.L.b, [])
    const inner = parseArithUnary(P, stop, mode)
    if (!inner) return op
    return mk(P, 'unary_expression', op.startIndex, inner.endIndex, [op, inner])
  }
  return parseArithPostfix(P, stop, mode)
}

/**
 * 解析算术后缀表达式层：后缀 `++`/`--` 操作符。
 * 先尝试解析 primary；若其后紧跟 `++`/`--` 则包装为 postfix_expression。
 */
function parseArithPostfix(
  P: ParseState,
  stop: string,
  mode: ArithMode,
): TsNode | null {
  const prim = parseArithPrimary(P, stop, mode)
  if (!prim) return null
  const c = peek(P.L)
  const c1 = peek(P.L, 1)
  if ((c === '+' && c1 === '+') || (c === '-' && c1 === '-')) {
    const s = P.L.b
    advance(P.L)
    advance(P.L)
    const op = mk(P, c + c1, s, P.L.b, [])
    return mk(P, 'postfix_expression', prim.startIndex, op.endIndex, [prim, op])
  }
  return prim
}

/**
 * 解析算术原子项（primary）：括号表达式、双引号字符串、`$` 展开、数字字面量、标识符。
 * - 括号 `(...)` → parenthesized_expression（支持逗号列表）
 * - 数字：支持十进制、十六进制（`0x`）、Base#Digits 记法
 * - 标识符：`assign` 模式下若后跟 `=` 则生成 variable_assignment；
 *   后跟 `[` 则生成 subscript；其余依 mode 生成 variable_name 或 word
 */
function parseArithPrimary(
  P: ParseState,
  stop: string,
  mode: ArithMode,
): TsNode | null {
  skipBlanks(P.L)
  if (isArithStop(P, stop)) return null
  const c = peek(P.L)
  if (c === '(') {
    const s = P.L.b
    advance(P.L)
    const open = mk(P, '(', s, P.L.b, [])
    // 带括号表达式可包含逗号分隔的多个表达式
    const inners = parseArithCommaList(P, ')', mode)
    skipBlanks(P.L)
    let close: TsNode
    if (peek(P.L) === ')') {
      const cs = P.L.b
      advance(P.L)
      close = mk(P, ')', cs, P.L.b, [])
    } else {
      close = mk(P, ')', P.L.b, P.L.b, [])
    }
    return mk(P, 'parenthesized_expression', open.startIndex, close.endIndex, [
      open,
      ...inners,
      close,
    ])
  }
  if (c === '"') {
    return parseDoubleQuoted(P)
  }
  if (c === '$') {
    return parseDollarLike(P)
  }
  if (isDigit(c)) {
    const s = P.L.b
    while (isDigit(peek(P.L))) advance(P.L)
    // 十六进制：0x1f
    if (
      P.L.b - s === 1 &&
      c === '0' &&
      (peek(P.L) === 'x' || peek(P.L) === 'X')
    ) {
      advance(P.L)
      while (isHexDigit(peek(P.L))) advance(P.L)
    }
    // 基数表示法：BASE#DIGITS，如 2#1010、16#ff
    else if (peek(P.L) === '#') {
      advance(P.L)
      while (isBaseDigit(peek(P.L))) advance(P.L)
    }
    return mk(P, 'number', s, P.L.b, [])
  }
  if (isIdentStart(c)) {
    const s = P.L.b
    while (isIdentChar(peek(P.L))) advance(P.L)
    const nc = peek(P.L)
    // 'assign' 模式下的赋值（C 风格 for 循环 init 子句）：发出 variable_assignment，
    // 使链式 `a = b = c = 1` 正确嵌套。其他模式通过优先级表将 `=` 视为 binary_expression 操作符。
    if (mode === 'assign') {
      skipBlanks(P.L)
      const ac = peek(P.L)
      const ac1 = peek(P.L, 1)
      if (ac === '=' && ac1 !== '=') {
        const vn = mk(P, 'variable_name', s, P.L.b, [])
        const es = P.L.b
        advance(P.L)
        const eq = mk(P, '=', es, P.L.b, [])
        // RHS 本身也可能是赋值（链式赋值）
        const val = parseArithTernary(P, stop, mode)
        const end = val ? val.endIndex : eq.endIndex
        const kids = val ? [vn, eq, val] : [vn, eq]
        return mk(P, 'variable_assignment', s, end, kids)
      }
    }
    // 下标访问
    if (nc === '[') {
      const vn = mk(P, 'variable_name', s, P.L.b, [])
      const brS = P.L.b
      advance(P.L)
      const brOpen = mk(P, '[', brS, P.L.b, [])
      const idx = parseArithTernary(P, ']', 'var') ?? parseDollarLike(P)
      skipBlanks(P.L)
      let brClose: TsNode
      if (peek(P.L) === ']') {
        const cs = P.L.b
        advance(P.L)
        brClose = mk(P, ']', cs, P.L.b, [])
      } else {
        brClose = mk(P, ']', P.L.b, P.L.b, [])
      }
      const kids = idx ? [vn, brOpen, idx, brClose] : [vn, brOpen, brClose]
      return mk(P, 'subscript', s, brClose.endIndex, kids)
    }
    // 裸标识符：'var' 模式 → variable_name，'word'/'assign' 模式 → word。
    // 'assign' 模式在没有 `=` 跟随时降级为 word（C 风格 for 的条件/更新子句：
    // `c<=5` → binary_expression(word, number)）。
    const identType = mode === 'var' ? 'variable_name' : 'word'
    return mk(P, identType, s, P.L.b, [])
  }
  return null
}

/**
 * 判断当前位置是否为算术表达式的终止边界。
 * 根据 `stop` 字符串匹配对应的终止字符：
 * `))` `)` `;` `:` `]` `}` `:}`（`:`或`}`均可）以及 EOF / 换行。
 */
function isArithStop(P: ParseState, stop: string): boolean {
  const c = peek(P.L)
  if (stop === '))') return c === ')' && peek(P.L, 1) === ')'
  if (stop === ')') return c === ')'
  if (stop === ';') return c === ';'
  if (stop === ':') return c === ':'
  if (stop === ']') return c === ']'
  if (stop === '}') return c === '}'
  if (stop === ':}') return c === ':' || c === '}'
  return c === '' || c === '\n'
}
