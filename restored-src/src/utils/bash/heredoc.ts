/**
 * Here-doc 提取与还原工具模块。
 *
 * 在 Claude Code 系统中，shell-quote 库将 `<<` 解析为两个独立的 `<` 重定向运算符，
 * 从而破坏含 heredoc 语法的命令分割。该模块在解析前提取 heredoc，解析后再还原：
 * - extractHeredocs()：将 heredoc 替换为随机盐值占位符，供 shell-quote 安全解析
 * - restoreHeredocs()：将占位符数组替换回原始 heredoc 内容
 * - containsHeredoc()：快速检测命令是否包含 heredoc 语法
 *
 * 支持的 heredoc 变体：
 * - <<WORD      — 基本形式
 * - <<'WORD'    — 单引号定界符（正文不展开变量）
 * - <<"WORD"    — 双引号定界符（正文展开变量）
 * - <<-WORD     — dash 前缀（去除正文行首 tab）
 * - <<-'WORD'   — 组合形式
 *
 * 提取失败时命令原样透传，安全地回退到整体审批流程。
 *
 * Heredoc extraction and restoration utilities.
 * @module
 */

import { randomBytes } from 'crypto'

const HEREDOC_PLACEHOLDER_PREFIX = '__HEREDOC_'
const HEREDOC_PLACEHOLDER_SUFFIX = '__'

/**
 * 生成随机十六进制盐值字符串，用于构造唯一占位符。
 * 防止命令文本中出现与占位符字面量冲突的内容。
 */
function generatePlaceholderSalt(): string {
  // 生成 8 个随机字节的十六进制字符串（共 16 个字符）
  return randomBytes(8).toString('hex')
}

/**
 * 匹配 heredoc 起始语法的正则模式。
 *
 * 两个分支分别处理引号定界符与无引号定界符：
 *
 * 分支一（有引号）：(['"]) (\\?\w+) \2
 *   捕获开引号，然后捕获定界符词（在引号内可含前导反斜杠，因为在引号内是字面量），
 *   再捕获闭引号。在 bash 中，单引号使所有字符均为字面值，包括反斜杠：
 *     <<'\EOF' → 定界符为 \EOF（含反斜杠）
 *     <<'EOF'  → 定界符为 EOF
 *   双引号同样保留非特殊字符前的反斜杠：
 *     <<"\EOF" → 定界符为 \EOF
 *
 * 分支二（无引号）：\\?(\w+)
 *   可选消耗前导反斜杠（转义），然后捕获单词。
 *   在 bash 中，无引号的反斜杠转义下一个字符：
 *     <<\EOF → 定界符为 EOF（反斜杠已被消耗）
 *     <<EOF  → 定界符为 EOF（普通形式）
 *
 * 安全说明：对有引号定界符，反斜杠必须位于捕获组内；
 * 对无引号定界符，反斜杠必须位于捕获组外。
 * 旧正则将 \\? 无条件置于捕获组外，导致 <<'\EOF' 被提取为定界符 "EOF"，
 * 而 bash 实际使用 "\EOF"，从而允许命令走私（command smuggling）。
 *
 * 注：使用 [ \t]*（非 \s*）以避免跨行匹配，跨行匹配会带来安全风险
 * （可在 << 和定界符之间隐藏命令）。
 */
const HEREDOC_START_PATTERN =
  // eslint-disable-next-line custom-rules/no-lookbehind-regex -- gated by command.includes('<<') at extractHeredocs() entry
  /(?<!<)<<(?!<)(-)?[ \t]*(?:(['"])(\\?\w+)\2|\\?(\w+))/

export type HeredocInfo = {
  /** 完整的 heredoc 文本，包含 << 运算符、定界符、正文及闭合定界符 */
  fullText: string
  /** 定界符词（不含引号） */
  delimiter: string
  /** << 运算符在原始命令中的起始偏移量 */
  operatorStartIndex: number
  /** << 运算符的结束偏移量（不含）—— 同行后续内容从此处起保留 */
  operatorEndIndex: number
  /** heredoc 正文的起始偏移量（正文前的换行符位置） */
  contentStartIndex: number
  /** heredoc 正文（含闭合定界符）的结束偏移量（不含） */
  contentEndIndex: number
}

export type HeredocExtractionResult = {
  /** 替换 heredoc 为占位符后的命令字符串 */
  processedCommand: string
  /** 占位符字符串到原始 heredoc 信息的映射表 */
  heredocs: Map<string, HeredocInfo>
}

/**
 * 从命令字符串中提取 heredoc，并以占位符替换，使 shell-quote 可安全解析命令。
 * 解析完成后，使用 `restoreHeredocs` 将占位符替换回原始内容。
 *
 * 包含多项安全防御：
 * - 跳过 `$'...'` / `$"..."` ANSI-C 引号（影响引号跟踪）
 * - 跳过含反引号命令替换的命令（heredoc 闭合语义复杂）
 * - 跳过算术上下文（`((` 未闭合）中的 `<<`（可能是位移运算符）
 * - 跳过引号字符串内的 `<<`
 * - 跳过注释内的 `<<`
 * - 检测行续接（`\<newline>`）导致的 heredoc 解析错位
 *
 * @param command 可能含 heredoc 的 shell 命令字符串
 * @param options.quotedOnly 若为 true，跳过未引号定界符的 heredoc（其正文含命令展开）
 * @returns 包含处理后命令和占位符映射的对象
 */
export function extractHeredocs(
  command: string,
  options?: { quotedOnly?: boolean },
): HeredocExtractionResult {
  const heredocs = new Map<string, HeredocInfo>()

  // 快速检查：若命令中不含 <<，直接跳过处理
  if (!command.includes('<<')) {
    return { processedCommand: command, heredocs }
  }

  // 安全性：偏执预验证。以下增量引号/注释扫描器（见 advanceScan）
  // 采用简化解析，无法处理所有 bash 引号构造。若命令含有可能导致
  // 引号跟踪失步的构造，整体放弃提取，而非冒险以错误边界提取 heredoc。
  // 这是纵深防御：以下每种构造都曾导致或可能导致安全绕过。
  //
  // 具体而言，遇到以下情况时放弃：
  // 1. $'...' 或 $"..."（ANSI-C / 本地化引号——引号追踪器
  //    不处理 $ 前缀，会错误解析引号）
  // 2. 反引号命令替换（反引号嵌套有复杂解析规则，
  //    且反引号充当 make_cmd.c:606 中 PST_EOFTOKEN 的 shell_eof_token，
  //    会启用我们的解析器无法复现的早期 heredoc 闭合）
  if (/\$['"]/.test(command)) {
    return { processedCommand: command, heredocs }
  }
  // 检查命令文本中第一个 << 之前是否含有反引号。
  // 反引号嵌套有复杂的解析规则，且反引号充当
  // PST_EOFTOKEN（make_cmd.c:606）的 shell_eof_token，
  // 会启用我们的解析器无法复现的早期 heredoc 闭合。
  // 只检查 << 之前是因为 heredoc 正文中的反引号无害。
  const firstHeredocPos = command.indexOf('<<')
  if (firstHeredocPos > 0 && command.slice(0, firstHeredocPos).includes('`')) {
    return { processedCommand: command, heredocs }
  }

  // 安全性：检查第一个 `<<` 之前是否存在算术求值上下文。
  // 在 bash 中，`(( x = 1 << 2 ))` 中的 `<<` 是位移运算符，而非 heredoc。
  // 若误提取，后续行将成为"heredoc 正文"，从而被安全验证器隐藏，
  // 而 bash 却将其作为独立命令执行。若 `((` 在 `<<` 之前出现且没有对应的 `))`，
  // 整体放弃——无法可靠区分算术 `<<` 与 heredoc `<<`。
  // 注：$(( 已由 validateDangerousPatterns 捕获，但裸 (( 未被处理。
  if (firstHeredocPos > 0) {
    const beforeHeredoc = command.slice(0, firstHeredocPos)
    // 统计 (( 和 )) 的出现次数——若不平衡，`<<` 可能是算术运算符
    const openArith = (beforeHeredoc.match(/\(\(/g) || []).length
    const closeArith = (beforeHeredoc.match(/\)\)/g) || []).length
    if (openArith > closeArith) {
      return { processedCommand: command, heredocs }
    }
  }

  // 为迭代创建带全局标志的正则实例
  const heredocStartPattern = new RegExp(HEREDOC_START_PATTERN.source, 'g')

  const heredocMatches: HeredocInfo[] = []
  // 安全性：当 quotedOnly 跳过无引号 heredoc 时，仍需跟踪其正文范围，
  // 以便嵌套过滤器拒绝位于被跳过的无引号 heredoc 正文内部的引号 heredoc。
  // 若不跟踪，`cat <<EOF\n<<'SAFE'\n$(evil)\nSAFE\nEOF` 会将 <<'SAFE'
  // 提取为顶层 heredoc，将 $(evil) 从验证器中隐藏——尽管在 bash 中
  // $(evil) 确实会被执行（无引号 <<EOF 会展开其正文）。
  const skippedHeredocRanges: Array<{
    contentStartIndex: number
    contentEndIndex: number
  }> = []
  let match: RegExpExecArray | null

  // 增量引号/注释扫描器状态。
  //
  // 正则向前遍历命令，match.index 单调递增。以前每次匹配时，
  // isInsideQuotedString 和 isInsideComment 都从位置 0 重新扫描——
  // 当 heredoc 正文含大量 `<<`（如含 `std::cout << ...` 的 C++ heredoc）
  // 时为 O(n²)。一个 200 行的 C++ heredoc 每次 extractHeredocs 调用耗时 ~3.7ms，
  // 而 Bash 安全验证器每条命令会多次调用 extractHeredocs。
  //
  // 改为增量跟踪引号/注释/转义状态，从上次扫描位置开始向前推进。
  // 这保留了旧辅助函数的精确语义：
  //
  //   引号状态（原 isInsideQuotedString）对注释视而不见——
  //   它从不感知 `#`，也不因"在注释中"而跳过字符。在单引号内，
  //   所有内容均为字面量。在双引号内，反斜杠转义下一个字符。
  //   在无引号上下文中，奇数个连续反斜杠转义下一个字符。
  //
  //   注释状态（原 isInsideComment）感知引号状态（引号内的 #
  //   不是注释），但反过来不成立。旧辅助函数使用每次调用的
  //   `lineStart = lastIndexOf('\n', pos-1)+1` 边界来决定哪个 `#` 生效；
  //   等价地，任何物理 `\n` 均清除注释状态——包括引号内的 `\n`
  //   （因为 lastIndexOf 对引号视而不见）。
  //
  // 安全性：不得让注释模式抑制引号状态更新。若 `#` 使扫描器进入
  // 某种跳过引号字符的模式，则 `echo x#"\n<<...`（bash 将 `#` 视为
  // 单词 `x#` 的一部分，而非注释）会将 `<<` 报告为无引号并提取它，
  // 从而向安全验证器隐藏内容。旧版 isInsideQuotedString 对注释视而不见；
  // 我们保留此特性。新旧实现都会过于积极地将任意无引号 `#` 视为注释
  // （bash 要求位于词首），但由于引号跟踪独立进行，
  // 这种过激只影响注释检查——导致跳过（安全方向），而非额外提取。
  let scanPos = 0
  let scanInSingleQuote = false
  let scanInDoubleQuote = false
  let scanInComment = false
  // 在双引号内："...": 若前一个字符为反斜杠（下一个字符已被转义），则为 true。
  // 跨 advanceScan 调用持久保存，使 scanPos-1 处的 `\` 能正确转义 scanPos 处的字符。
  let scanDqEscapeNext = false
  // 无引号上下文：紧接 scanPos-1 结尾的连续反斜杠数量。
  // 用于判断 scanPos 处的字符是否被转义（奇数个 = 已转义）。
  let scanPendingBackslashes = 0

  const advanceScan = (target: number): void => {
    for (let i = scanPos; i < target; i++) {
      const ch = command[i]!

      // 任何物理换行符均清除注释状态。旧版 isInsideComment
      // 使用 `lineStart = lastIndexOf('\n', pos-1)+1`（对引号视而不见），
      // 因此引号内的 `\n` 同样会推进 lineStart。此处在引号分支之前清除，
      // 以匹配原有行为。
      if (ch === '\n') scanInComment = false

      if (scanInSingleQuote) {
        if (ch === "'") scanInSingleQuote = false
        continue
      }

      if (scanInDoubleQuote) {
        if (scanDqEscapeNext) {
          scanDqEscapeNext = false
          continue
        }
        if (ch === '\\') {
          scanDqEscapeNext = true
          continue
        }
        if (ch === '"') scanInDoubleQuote = false
        continue
      }

      // 无引号上下文。引号跟踪对注释视而不见（与旧版
      // isInsideQuotedString 相同）：不因处于注释中而跳过字符。
      // 只有 `#` 检测本身才以"非注释中"为前提条件。
      if (ch === '\\') {
        scanPendingBackslashes++
        continue
      }
      const escaped = scanPendingBackslashes % 2 === 1
      scanPendingBackslashes = 0
      if (escaped) continue

      if (ch === "'") scanInSingleQuote = true
      else if (ch === '"') scanInDoubleQuote = true
      else if (!scanInComment && ch === '#') scanInComment = true
    }
    scanPos = target
  }

  while ((match = heredocStartPattern.exec(command)) !== null) {
    const startIndex = match.index

    // 将增量扫描器推进到当前匹配位置。完成后，
    // scanInSingleQuote/scanInDoubleQuote/scanInComment 反映 startIndex
    // 正前方的解析器状态，scanPendingBackslashes 是紧接 startIndex
    // 之前的无引号 `\` 数量。
    advanceScan(startIndex)

    // 若此 << 位于引号字符串内，则跳过（不是真正的 heredoc 运算符）。
    if (scanInSingleQuote || scanInDoubleQuote) {
      continue
    }

    // 安全性：若此 << 位于注释中（无引号 # 之后），则跳过。
    // 在 bash 中，`# <<EOF` 是注释——提取它会将后续行作为"heredoc 正文"隐藏，
    // 而 bash 实际上会执行这些行。
    if (scanInComment) {
      continue
    }

    // 安全性：若此 << 前面有奇数个反斜杠，则跳过。
    // 在 bash 中，`\<<EOF` 不是 heredoc——`\<` 是字面 `<`，`<EOF` 是输入重定向。
    // 提取它会使同行命令从安全检查中消失。扫描器跟踪紧接 startIndex
    // 之前结尾的无引号反斜杠数量（scanPendingBackslashes）。
    if (scanPendingBackslashes % 2 === 1) {
      continue
    }

    // 安全性：若此 `<<` 落在之前被跳过的 heredoc（quotedOnly 模式下的无引号 heredoc）
    // 正文范围内，则放弃。在 bash 中，heredoc 正文内的 `<<` 只是文本，
    // 不是嵌套 heredoc 运算符。提取它会隐藏 bash 实际展开的内容。
    let insideSkipped = false
    for (const skipped of skippedHeredocRanges) {
      if (
        startIndex > skipped.contentStartIndex &&
        startIndex < skipped.contentEndIndex
      ) {
        insideSkipped = true
        break
      }
    }
    if (insideSkipped) {
      continue
    }

    const fullMatch = match[0]
    const isDash = match[1] === '-'
    // 第 3 组 = 有引号的定界符（可含反斜杠），第 4 组 = 无引号定界符
    const delimiter = (match[3] || match[4])!
    const operatorEndIndex = startIndex + fullMatch.length

    // 安全性：两项检查确保正则捕获了完整的定界符词。
    // 若我们解析的定界符与 bash 实际使用的定界符不符，
    // 可能允许命令走私绕过权限检查。

    // 检查 1：若捕获了引号字符（第 2 组），验证闭合引号确实被正则的 \2 匹配
    // （有引号分支要求闭合引号）。正则的 \w+ 只匹配 [a-zA-Z0-9_]，
    // 因此引号内的非单词字符（空格、连字符、点）会使 \w+ 提前停止，
    // 导致闭合引号未被匹配。
    // 示例：<<"EO F"——正则捕获 "EO"，漏掉闭合 "，定界符应为 "EO F"
    // 但我们会使用 "EO"。跳过以防止不匹配。
    const quoteChar = match[2]
    if (quoteChar && command[operatorEndIndex - 1] !== quoteChar) {
      continue
    }

    // 安全性：判断定界符是否有引号（'EOF'、"EOF"）或转义（\EOF）。
    // 在 bash 中，有引号/转义的定界符会抑制 heredoc 正文中的所有展开——
    // 内容是字面文本。无引号定界符（<<EOF）会对正文执行完整 shell 展开：
    // 正文中的 $()、反引号、${} 均会被执行。设置 quotedOnly 时，
    // 跳过无引号 heredoc，使其正文对安全验证器可见（可能含可执行的命令替换）。
    const isEscapedDelimiter = fullMatch.includes('\\')
    const isQuotedOrEscaped = !!quoteChar || isEscapedDelimiter
    // 注：设置 quotedOnly 时，不再在此处立即跳过无引号 heredoc。
    // 而是计算其正文范围并添加到 skippedHeredocRanges，然后在找到闭合定界符后跳过。
    // 这样嵌套过滤器才能正确拒绝位于无引号 heredoc 正文内的引号"heredoc"。

    // 检查 2：验证匹配结果后的下一个字符是 bash 词终止符（元字符或字符串末尾）。
    // 若后续是词字符、引号、$、\，说明 bash 的词延伸到我们的匹配之后
    // （如 <<'EOF'a，bash 使用 "EOFa" 但我们捕获了 "EOF"）。
    // 重要：只匹配 bash 的实际元字符——空格（0x20）、制表（0x09）、
    // 换行（0x0A）、|、&、;、(、)、<、>。不使用 \s，因为 \s 还匹配
    // \r、\f、\v 以及 Unicode 空白，而 bash 将它们视为普通词字符，而非终止符。
    if (operatorEndIndex < command.length) {
      const nextChar = command[operatorEndIndex]!
      if (!/^[ \t\n|&;()<>]$/.test(nextChar)) {
        continue
      }
    }

    // 在 bash 中，heredoc 正文从运算符所在行的下一行开始。
    // <<EOF 同行后方的任何内容（如 " && echo done"）是命令的一部分，
    // 而非 heredoc 正文。
    //
    // 安全性："同行"必须是逻辑命令行，而非第一个物理换行符。
    // 多行引号字符串会延伸逻辑行——bash 等待引号闭合后才开始读取 heredoc 正文。
    // 对引号视而不见的 `indexOf('\n')` 会找到引号字符串内的换行符，
    // 导致正文提前开始。
    //
    // 利用示例：`echo <<'EOF' '${}\n' ; curl evil.com\nEOF`
    //   - `'${}\n'` 内的 `\n` 被引号包裹（字符串参数中的字面换行符）
    //   - Bash：等待 `'` 闭合 → 逻辑行为
    //     `echo <<'EOF' '${}\n' ; curl evil.com` → heredoc 正文 = `EOF`
    //   - 旧代码：indexOf('\n') 找到引号内的换行 → 正文从
    //     `' ; curl evil.com\nEOF` 开始 → curl 被吞入占位符 →
    //     永远不会进入权限检查。
    //
    // 修复：从 operatorEndIndex 向前扫描，使用引号状态跟踪，
    // 找到第一个不在引号字符串内的换行符。引号跟踪语义与 advanceScan 相同
    // （已用于验证 `<<` 运算符位置）。
    let firstNewlineOffset = -1
    {
      let inSingleQuote = false
      let inDoubleQuote = false
      // 从干净的引号状态开始——advanceScan 已拒绝了 `<<` 运算符本身位于引号内的情况。
      for (let k = operatorEndIndex; k < command.length; k++) {
        const ch = command[k]
        if (inSingleQuote) {
          if (ch === "'") inSingleQuote = false
          continue
        }
        if (inDoubleQuote) {
          if (ch === '\\') {
            k++ // 跳过双引号内被转义的字符
            continue
          }
          if (ch === '"') inDoubleQuote = false
          continue
        }
        // 无引号上下文
        if (ch === '\n') {
          firstNewlineOffset = k - operatorEndIndex
          break
        }
        // 在无引号上下文中统计反斜杠数量以检测转义
        let backslashCount = 0
        for (let j = k - 1; j >= operatorEndIndex && command[j] === '\\'; j--) {
          backslashCount++
        }
        if (backslashCount % 2 === 1) continue // 被转义的字符
        if (ch === "'") inSingleQuote = true
        else if (ch === '"') inDoubleQuote = true
      }
      // 若扫描结束时仍在引号内，则逻辑行永远不会结束——
      // 该 heredoc 没有正文。将 firstNewlineOffset 保持为 -1（见下方处理）。
    }

    // 若未找到无引号换行符，该 heredoc 无正文——跳过
    if (firstNewlineOffset === -1) {
      continue
    }

    // 安全性：检查同行内容末尾（运算符与换行之间的文本）是否有反斜杠换行续接。
    // 在 bash 中，`\<换行>` 在 heredoc 解析前就会将多行合并——因此：
    //   cat <<'EOF' && \
    //   rm -rf /
    //   content
    //   EOF
    // bash 合并为 `cat <<'EOF' && rm -rf /`（rm 属于命令行），
    // 然后 heredoc 正文 = `content`。我们的提取器在续接合并之前运行
    // （commands.ts:82），因此会将 `rm -rf /` 放入 heredoc 正文，
    // 使其对所有验证器不可见。若同行内容末尾有奇数个反斜杠，则放弃。
    const sameLineContent = command.slice(
      operatorEndIndex,
      operatorEndIndex + firstNewlineOffset,
    )
    let trailingBackslashes = 0
    for (let j = sameLineContent.length - 1; j >= 0; j--) {
      if (sameLineContent[j] === '\\') {
        trailingBackslashes++
      } else {
        break
      }
    }
    if (trailingBackslashes % 2 === 1) {
      // Odd number of trailing backslashes → last one escapes the newline
      // → this is a line continuation. Our heredoc-before-continuation order
      // would misparse this. Bail out.
      continue
    }

    const contentStartIndex = operatorEndIndex + firstNewlineOffset
    const afterNewline = command.slice(contentStartIndex + 1) // +1 to skip the newline itself
    const contentLines = afterNewline.split('\n')

    // Find the closing delimiter - must be on its own line
    // Security: Must match bash's exact behavior to prevent parsing discrepancies
    // that could allow command smuggling past permission checks.
    let closingLineIndex = -1
    for (let i = 0; i < contentLines.length; i++) {
      const line = contentLines[i]!

      if (isDash) {
        // <<- strips leading TABS only (not spaces), per POSIX/bash spec.
        // The line after stripping leading tabs must be exactly the delimiter.
        const stripped = line.replace(/^\t*/, '')
        if (stripped === delimiter) {
          closingLineIndex = i
          break
        }
      } else {
        // << requires the closing delimiter to be exactly alone on the line
        // with NO leading or trailing whitespace. This matches bash behavior.
        if (line === delimiter) {
          closingLineIndex = i
          break
        }
      }

      // Security: Check for PST_EOFTOKEN-like early closure (make_cmd.c:606).
      // Inside $(), ${}, or backtick substitution, bash closes a heredoc when
      // a line STARTS with the delimiter and contains the shell_eof_token
      // (`)`, `}`, or backtick) anywhere after it. Our parser only does exact
      // line matching, so this discrepancy could hide smuggled commands.
      //
      // Paranoid extension: also bail on bash metacharacters (|, &, ;, (, <,
      // >) after the delimiter, which could indicate command syntax from a
      // parsing discrepancy we haven't identified.
      //
      // For <<- heredocs, bash strips leading tabs before this check.
      const eofCheckLine = isDash ? line.replace(/^\t*/, '') : line
      if (
        eofCheckLine.length > delimiter.length &&
        eofCheckLine.startsWith(delimiter)
      ) {
        const charAfterDelimiter = eofCheckLine[delimiter.length]!
        if (/^[)}`|&;(<>]$/.test(charAfterDelimiter)) {
          // Shell metacharacter or substitution closer after delimiter —
          // bash may close the heredoc early here. Bail out.
          closingLineIndex = -1
          break
        }
      }
    }

    // Security: If quotedOnly mode is set and this is an unquoted heredoc,
    // record its content range for nesting checks but do NOT add it to
    // heredocMatches. This ensures quoted "heredocs" inside its body are
    // correctly rejected by the insideSkipped check on subsequent iterations.
    //
    // CRITICAL: We do this BEFORE the closingLineIndex === -1 check. If the
    // unquoted heredoc has no closing delimiter, bash still treats everything
    // to end-of-input as the heredoc body (and expands $() within it). We
    // must block extraction of any subsequent quoted "heredoc" that falls
    // inside that unbounded body.
    if (options?.quotedOnly && !isQuotedOrEscaped) {
      let skipContentEndIndex: number
      if (closingLineIndex === -1) {
        // No closing delimiter — in bash, heredoc body extends to end of
        // input. Track the entire remaining range as "skipped body".
        skipContentEndIndex = command.length
      } else {
        const skipLinesUpToClosing = contentLines.slice(0, closingLineIndex + 1)
        const skipContentLength = skipLinesUpToClosing.join('\n').length
        skipContentEndIndex = contentStartIndex + 1 + skipContentLength
      }
      skippedHeredocRanges.push({
        contentStartIndex,
        contentEndIndex: skipContentEndIndex,
      })
      continue
    }

    // If no closing delimiter found, this is malformed - skip it
    if (closingLineIndex === -1) {
      continue
    }

    // Calculate end position: contentStartIndex + 1 (newline) + length of lines up to and including closing delimiter
    const linesUpToClosing = contentLines.slice(0, closingLineIndex + 1)
    const contentLength = linesUpToClosing.join('\n').length
    const contentEndIndex = contentStartIndex + 1 + contentLength

    // Security: Bail if this heredoc's content range OVERLAPS with any
    // previously-skipped heredoc's content range. This catches the case where
    // two heredocs share a command line (`cat <<EOF <<'SAFE'`) and the first
    // is unquoted (skipped in quotedOnly mode). In bash, when multiple heredocs
    // share a line, their bodies appear SEQUENTIALLY (first's body, then
    // second's). Both compute contentStartIndex from the SAME newline, so the
    // second's body search walks through the first's body. For:
    //   cat <<EOF <<'SAFE'
    //   $(evil_command)
    //   EOF
    //   safe body
    //   SAFE
    // ...the quoted <<'SAFE' would incorrectly extract lines 2-4 as its body,
    // swallowing `$(evil_command)` (which bash EXECUTES via the unquoted
    // <<EOF's expansion) into the placeholder, hiding it from validators.
    //
    // The insideSkipped check above doesn't catch this because the quoted
    // operator's startIndex is on the command line BEFORE contentStart.
    // The contentStartPositions dedup check below doesn't catch it because the
    // skipped heredoc is in skippedHeredocRanges, not topLevelHeredocs.
    let overlapsSkipped = false
    for (const skipped of skippedHeredocRanges) {
      // Ranges [a,b) and [c,d) overlap iff a < d && c < b
      if (
        contentStartIndex < skipped.contentEndIndex &&
        skipped.contentStartIndex < contentEndIndex
      ) {
        overlapsSkipped = true
        break
      }
    }
    if (overlapsSkipped) {
      continue
    }

    // Build fullText: operator + newline + content (normalized form for restoration)
    // This creates a clean heredoc that can be restored correctly
    const operatorText = command.slice(startIndex, operatorEndIndex)
    const contentText = command.slice(contentStartIndex, contentEndIndex)
    const fullText = operatorText + contentText

    heredocMatches.push({
      fullText,
      delimiter,
      operatorStartIndex: startIndex,
      operatorEndIndex,
      contentStartIndex,
      contentEndIndex,
    })
  }

  // If no valid heredocs found, return original
  if (heredocMatches.length === 0) {
    return { processedCommand: command, heredocs }
  }

  // Filter out nested heredocs - any heredoc whose operator starts inside
  // another heredoc's content range should be excluded.
  // This prevents corruption when heredoc content contains << patterns.
  const topLevelHeredocs = heredocMatches.filter((candidate, _i, all) => {
    // Check if this candidate's operator is inside any other heredoc's content
    for (const other of all) {
      if (candidate === other) continue
      // Check if candidate's operator starts within other's content range
      if (
        candidate.operatorStartIndex > other.contentStartIndex &&
        candidate.operatorStartIndex < other.contentEndIndex
      ) {
        // This heredoc is nested inside another - filter it out
        return false
      }
    }
    return true
  })

  // If filtering removed all heredocs, return original
  if (topLevelHeredocs.length === 0) {
    return { processedCommand: command, heredocs }
  }

  // Check for multiple heredocs sharing the same content start position
  // (i.e., on the same line). This causes index corruption during replacement
  // because indices are calculated on the original string but applied to
  // a progressively modified string. Return without extraction - the fallback
  // is safe (requires manual approval or fails parsing).
  const contentStartPositions = new Set(
    topLevelHeredocs.map(h => h.contentStartIndex),
  )
  if (contentStartPositions.size < topLevelHeredocs.length) {
    return { processedCommand: command, heredocs }
  }

  // Sort by content end position descending so we can replace from end to start
  // (this preserves indices for earlier replacements)
  topLevelHeredocs.sort((a, b) => b.contentEndIndex - a.contentEndIndex)

  // Generate a unique salt for this extraction to prevent placeholder collisions
  // with literal "__HEREDOC_N__" text in commands
  const salt = generatePlaceholderSalt()

  let processedCommand = command
  topLevelHeredocs.forEach((info, index) => {
    // Use reverse index since we sorted descending
    const placeholderIndex = topLevelHeredocs.length - 1 - index
    const placeholder = `${HEREDOC_PLACEHOLDER_PREFIX}${placeholderIndex}_${salt}${HEREDOC_PLACEHOLDER_SUFFIX}`

    heredocs.set(placeholder, info)

    // Replace heredoc with placeholder while preserving same-line content:
    // - Keep everything before the operator
    // - Replace operator with placeholder
    // - Keep content between operator and heredoc content (e.g., " && echo done")
    // - Remove the heredoc content (from newline through closing delimiter)
    // - Keep everything after the closing delimiter
    processedCommand =
      processedCommand.slice(0, info.operatorStartIndex) +
      placeholder +
      processedCommand.slice(info.operatorEndIndex, info.contentStartIndex) +
      processedCommand.slice(info.contentEndIndex)
  })

  return { processedCommand, heredocs }
}

/**
 * 将单个字符串中的 heredoc 占位符还原为原始内容。
 * 供 restoreHeredocs 内部调用。
 */
function restoreHeredocsInString(
  text: string,
  heredocs: Map<string, HeredocInfo>,
): string {
  let result = text
  for (const [placeholder, info] of heredocs) {
    result = result.replaceAll(placeholder, info.fullText)
  }
  return result
}

/**
 * 将字符串数组中的 heredoc 占位符批量还原为原始内容。
 * @param parts 可能含 heredoc 占位符的字符串数组
 * @param heredocs extractHeredocs 返回的占位符映射
 * @returns 还原后的新数组
 */
export function restoreHeredocs(
  parts: string[],
  heredocs: Map<string, HeredocInfo>,
): string[] {
  if (heredocs.size === 0) {
    return parts
  }

  return parts.map(part => restoreHeredocsInString(part, heredocs))
}

/**
 * 快速检测命令字符串是否包含 heredoc 语法。
 * 仅检测模式是否存在，不校验 heredoc 是否格式完整。
 * @param command shell 命令字符串
 * @returns 若命令中存在 heredoc 语法则返回 true
 */
export function containsHeredoc(command: string): boolean {
  return HEREDOC_START_PATTERN.test(command)
}
