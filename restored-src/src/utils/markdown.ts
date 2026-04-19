/**
 * markdown.ts — Markdown 渲染到终端 ANSI 样式模块
 *
 * 【系统流程定位】
 * 本模块处于 Claude Code 的终端 UI 渲染层，
 * 负责将 Claude 返回的 Markdown 文本转换为带有 ANSI 颜色/样式的终端输出。
 * 被消息渲染组件（MessageContent 等）调用，
 * 也被命令输出、工具结果等场景复用。
 *
 * 【主要职责】
 * 1. configureMarked()：全局配置 marked.js 解析器，禁用 ~ 删除线 token（模型常用 ~ 表示"约"）；
 * 2. applyMarkdown()：入口函数，剥离 XML 标签 → 词法分析 → 逐 token 渲染为终端文本；
 * 3. formatToken()：核心 token 渲染器，对每种 Markdown token 类型应用 chalk ANSI 样式；
 * 4. linkifyIssueReferences()：将 owner/repo#NNN 格式引用转换为 OSC 8 可点击超链接；
 * 5. padAligned()：ANSI 感知的表格单元格对齐填充；
 * 6. numberToLetter() / numberToRoman() / getListNumber()：有序列表编号格式转换。
 */

import chalk from 'chalk'
import { marked, type Token, type Tokens } from 'marked'
import stripAnsi from 'strip-ansi'
import { color } from '../components/design-system/color.js'
import { BLOCKQUOTE_BAR } from '../constants/figures.js'
import { stringWidth } from '../ink/stringWidth.js'
import { supportsHyperlinks } from '../ink/supports-hyperlinks.js'
import type { CliHighlight } from './cliHighlight.js'
import { logForDebugging } from './debug.js'
import { createHyperlink } from './hyperlink.js'
import { stripPromptXMLTags } from './messages.js'
import type { ThemeName } from './theme.js'

// 强制使用 \n 而非 os.EOL（Windows 上 os.EOL 为 \r\n）。
// 多余的 \r 会破坏 applyStylesToWrappedText 的字符到分段映射，
// 导致样式文本向右偏移。
const EOL = '\n'

// 全局配置状态标志，确保 marked 只配置一次
let markedConfigured = false

/**
 * 全局配置 marked.js 解析器。
 *
 * 目前只做一件事：禁用删除线（strikethrough）token 解析器。
 * 原因：模型输出中 ~ 常用于"约等于"（如 ~100），而非 Markdown 删除线，
 * 禁用后 ~100~ 会作为普通文本渲染，避免误渲染为删除线样式。
 *
 * 使用 markedConfigured 守卫确保幂等（多次调用只生效一次）。
 */
export function configureMarked(): void {
  if (markedConfigured) return
  markedConfigured = true

  // 禁用 strikethrough 解析器 —— 模型常用 ~ 表示"约"（如 ~100），
  // 而非 Markdown 删除线语义
  marked.use({
    tokenizer: {
      del() {
        // 返回 undefined 即禁用该 tokenizer
        return undefined
      },
    },
  })
}

/**
 * 将 Markdown 字符串渲染为带 ANSI 样式的终端文本。
 *
 * 处理流程：
 * 1. 调用 configureMarked() 确保解析器已配置；
 * 2. 用 stripPromptXMLTags() 剥离 XML 提示标签（如 <antThinking>）；
 * 3. 用 marked.lexer() 进行词法分析，得到 token 数组；
 * 4. 对每个 token 调用 formatToken() 渲染为终端字符串；
 * 5. join 后 trim() 去除首尾空白。
 *
 * @param content 原始 Markdown 字符串（可能含 XML 提示标签）
 * @param theme 当前终端主题名称（影响颜色选取）
 * @param highlight 代码高亮器（可选，null 时代码块不着色）
 * @returns 渲染后的 ANSI 样式终端文本
 */
export function applyMarkdown(
  content: string,
  theme: ThemeName,
  highlight: CliHighlight | null = null,
): string {
  configureMarked()
  return marked
    .lexer(stripPromptXMLTags(content)) // 词法分析，剥离 XML 标签
    .map(_ => formatToken(_, theme, 0, null, null, highlight)) // 逐 token 渲染
    .join('')
    .trim() // 去除首尾空白
}

/**
 * 将单个 marked Token 渲染为终端 ANSI 样式字符串。
 *
 * 这是 Markdown 渲染的核心函数，通过 switch 分发处理每种 token 类型：
 * - blockquote：每行加 dim 竖线前缀 + italic 样式
 * - code：无高亮时输出纯文本；有高亮时调用 highlight.highlight()
 * - codespan：使用 permission 颜色（inline code 样式）
 * - em / strong：chalk.italic / chalk.bold
 * - heading：h1 = bold+italic+underline；h2/h3+ = bold
 * - list / list_item：递归渲染，处理有序/无序和嵌套缩进
 * - table：计算列宽后格式化表头、分隔行、数据行
 * - link：mailto 显示纯文本；有意义文本时创建 OSC 8 超链接
 * - text：父级为 link 则直接返回；父级为 list_item 则加列表符号
 * - escape / def / del / html：分别返回转义文本或空字符串
 *
 * @param token 待渲染的 marked Token
 * @param theme 终端主题名称
 * @param listDepth 当前列表嵌套深度（用于缩进和编号格式选择）
 * @param orderedListNumber 当前有序列表项的序号（null 表示无序列表）
 * @param parent 父级 token（用于 text 节点上下文判断）
 * @param highlight 代码高亮器
 * @returns 渲染后的 ANSI 样式字符串
 */
export function formatToken(
  token: Token,
  theme: ThemeName,
  listDepth = 0,
  orderedListNumber: number | null = null,
  parent: Token | null = null,
  highlight: CliHighlight | null = null,
): string {
  switch (token.type) {
    case 'blockquote': {
      // 先递归渲染内层 token，再对每行加 dim 竖线前缀
      const inner = (token.tokens ?? [])
        .map(_ => formatToken(_, theme, 0, null, null, highlight))
        .join('')
      // 前缀用 dim 竖线，内容用 italic 但保持正常亮度——chalk.dim 在深色主题下几乎不可见
      const bar = chalk.dim(BLOCKQUOTE_BAR)
      return inner
        .split(EOL)
        .map(line =>
          // 只有非空行才加前缀，空行保持原样（避免孤立的竖线符号）
          stripAnsi(line).trim() ? `${bar} ${chalk.italic(line)}` : line,
        )
        .join(EOL)
    }
    case 'code': {
      // 无高亮器时直接返回代码文本
      if (!highlight) {
        return token.text + EOL
      }
      // 有高亮器时，检查语言是否受支持，不支持则退回 plaintext
      let language = 'plaintext'
      if (token.lang) {
        if (highlight.supportsLanguage(token.lang)) {
          language = token.lang
        } else {
          logForDebugging(
            `Language not supported while highlighting code, falling back to plaintext: ${token.lang}`,
          )
        }
      }
      return highlight.highlight(token.text, { language }) + EOL
    }
    case 'codespan': {
      // inline code：使用主题的 permission 颜色（通常为浅青色/绿色）
      return color('permission', theme)(token.text)
    }
    case 'em':
      // 斜体：递归渲染子 token 后应用 chalk.italic
      return chalk.italic(
        (token.tokens ?? [])
          .map(_ => formatToken(_, theme, 0, null, parent, highlight))
          .join(''),
      )
    case 'strong':
      // 粗体：递归渲染子 token 后应用 chalk.bold
      return chalk.bold(
        (token.tokens ?? [])
          .map(_ => formatToken(_, theme, 0, null, parent, highlight))
          .join(''),
      )
    case 'heading':
      switch (token.depth) {
        case 1: // h1：粗体 + 斜体 + 下划线，后跟两个空行
          return (
            chalk.bold.italic.underline(
              (token.tokens ?? [])
                .map(_ => formatToken(_, theme, 0, null, null, highlight))
                .join(''),
            ) +
            EOL +
            EOL
          )
        case 2: // h2：粗体，后跟两个空行
          return (
            chalk.bold(
              (token.tokens ?? [])
                .map(_ => formatToken(_, theme, 0, null, null, highlight))
                .join(''),
            ) +
            EOL +
            EOL
          )
        default: // h3+：同 h2，粗体加两个空行
          return (
            chalk.bold(
              (token.tokens ?? [])
                .map(_ => formatToken(_, theme, 0, null, null, highlight))
                .join(''),
            ) +
            EOL +
            EOL
          )
      }
    case 'hr':
      // 水平分割线：输出固定的 ---
      return '---'
    case 'image':
      // 图片：终端无法渲染图片，仅显示 URL
      return token.href
    case 'link': {
      // mailto 链接：提取邮件地址显示为纯文本，不创建超链接
      if (token.href.startsWith('mailto:')) {
        // 剥离 mailto: 前缀，显示纯邮件地址
        const email = token.href.replace(/^mailto:/, '')
        return email
      }
      // 从子 token 提取显示文本
      const linkText = (token.tokens ?? [])
        .map(_ => formatToken(_, theme, 0, null, token, highlight))
        .join('')
      const plainLinkText = stripAnsi(linkText)
      // 若显示文本与 URL 不同（有实际意义），创建 OSC 8 可点击超链接
      // 用户在支持超链接的终端中可悬停/点击查看 URL
      if (plainLinkText && plainLinkText !== token.href) {
        return createHyperlink(token.href, linkText)
      }
      // 显示文本与 URL 相同或为空时，直接创建以 URL 为文本的超链接
      return createHyperlink(token.href)
    }
    case 'list': {
      // 列表：遍历每个列表项，传递有序/无序信息和序号
      return token.items
        .map((_: Token, index: number) =>
          formatToken(
            _,
            theme,
            listDepth,
            // 有序列表传入 start + index 作为序号；无序列表传 null
            token.ordered ? token.start + index : null,
            token,
            highlight,
          ),
        )
        .join('')
    }
    case 'list_item':
      // 列表项：对每个子 token 渲染后加缩进前缀（深度 * 2 个空格）
      return (token.tokens ?? [])
        .map(
          _ =>
            `${'  '.repeat(listDepth)}${formatToken(_, theme, listDepth + 1, orderedListNumber, token, highlight)}`,
        )
        .join('')
    case 'paragraph':
      // 段落：渲染子 token 后追加一个换行符
      return (
        (token.tokens ?? [])
          .map(_ => formatToken(_, theme, 0, null, null, highlight))
          .join('') + EOL
      )
    case 'space':
      // 空行 token：输出一个换行符
      return EOL
    case 'br':
      // 强制换行符：输出一个换行符
      return EOL
    case 'text':
      if (parent?.type === 'link') {
        // 已在 markdown link 内部 —— link 处理器会包裹 OSC 8 超链接。
        // 若在此处 linkify，会嵌套两层 OSC 8，终端将以最内层为准，
        // 导致覆盖 link 的实际 href。
        return token.text
      }
      if (parent?.type === 'list_item') {
        // 列表项文本：加列表符号（无序用 -，有序用 getListNumber()）
        return `${orderedListNumber === null ? '-' : getListNumber(listDepth, orderedListNumber) + '.'} ${token.tokens ? token.tokens.map(_ => formatToken(_, theme, listDepth, orderedListNumber, token, highlight)).join('') : linkifyIssueReferences(token.text)}${EOL}`
      }
      // 普通文本：尝试将 owner/repo#NNN 转换为超链接
      return linkifyIssueReferences(token.text)
    case 'table': {
      const tableToken = token as Tokens.Table

      // 辅助函数：获取 token 数组渲染后的可见文本（stripAnsi 后的字符串），
      // 用于计算显示宽度（不含 ANSI 转义序列）
      function getDisplayText(tokens: Token[] | undefined): string {
        return stripAnsi(
          tokens
            ?.map(_ => formatToken(_, theme, 0, null, null, highlight))
            .join('') ?? '',
        )
      }

      // 计算每列的最大显示宽度（遍历表头和所有数据行）
      const columnWidths = tableToken.header.map((header, index) => {
        let maxWidth = stringWidth(getDisplayText(header.tokens))
        for (const row of tableToken.rows) {
          const cellLength = stringWidth(getDisplayText(row[index]?.tokens))
          maxWidth = Math.max(maxWidth, cellLength)
        }
        // 最小列宽为 3（保证最短分隔符 ---）
        return Math.max(maxWidth, 3)
      })

      // 渲染表头行
      let tableOutput = '| '
      tableToken.header.forEach((header, index) => {
        const content =
          header.tokens
            ?.map(_ => formatToken(_, theme, 0, null, null, highlight))
            .join('') ?? ''
        const displayText = getDisplayText(header.tokens)
        const width = columnWidths[index]!
        const align = tableToken.align?.[index]
        tableOutput +=
          padAligned(content, stringWidth(displayText), width, align) + ' | '
      })
      tableOutput = tableOutput.trimEnd() + EOL

      // 添加分隔行（只用横线，不显示对齐冒号）
      tableOutput += '|'
      columnWidths.forEach(width => {
        // +2 为每侧一个空格的留白
        const separator = '-'.repeat(width + 2)
        tableOutput += separator + '|'
      })
      tableOutput += EOL

      // 渲染数据行
      tableToken.rows.forEach(row => {
        tableOutput += '| '
        row.forEach((cell, index) => {
          const content =
            cell.tokens
              ?.map(_ => formatToken(_, theme, 0, null, null, highlight))
              .join('') ?? ''
          const displayText = getDisplayText(cell.tokens)
          const width = columnWidths[index]!
          const align = tableToken.align?.[index]
          tableOutput +=
            padAligned(content, stringWidth(displayText), width, align) + ' | '
        })
        tableOutput = tableOutput.trimEnd() + EOL
      })

      return tableOutput + EOL
    }
    case 'escape':
      // Markdown 转义：\) → )，\\ → \ 等，直接返回转义后的文本
      return token.text
    case 'def':
    case 'del':
    case 'html':
      // 这些 token 类型不渲染（def=链接定义、del=已禁用删除线、html=原生HTML）
      return ''
  }
  return ''
}

// 匹配 owner/repo#NNN 格式的 GitHub issue/PR 引用。
// 使用完整的 owner/repo 格式（不支持裸 #NNN），避免猜测当前仓库。
// owner 部分禁止点号（GitHub 用户名只允许字母数字和连字符），
// 防止 docs.github.io/guide#42 这类 URL 误匹配。
// repo 部分允许点号（如 cc.kurs.web）。
// 避免使用 lookbehind（在 JSC 的 YARR JIT 中性能较差）。
const ISSUE_REF_PATTERN =
  /(^|[^\w./-])([A-Za-z0-9][\w-]*\/[A-Za-z0-9][\w.-]*)#(\d+)\b/g

/**
 * 将文本中的 owner/repo#123 格式引用替换为可点击的 GitHub 超链接。
 *
 * 仅在终端支持超链接（OSC 8）时执行替换；
 * 不支持时直接返回原始文本，避免污染输出。
 *
 * @param text 原始文本（可能含 issue 引用）
 * @returns 替换后的文本（超链接或原文）
 */
function linkifyIssueReferences(text: string): string {
  // 终端不支持超链接时，直接返回原文
  if (!supportsHyperlinks()) {
    return text
  }
  return text.replace(
    ISSUE_REF_PATTERN,
    // prefix：引用前的分隔符；repo：owner/repo；num：issue 编号
    (_match, prefix, repo, num) =>
      prefix +
      createHyperlink(
        `https://github.com/${repo}/issues/${num}`,
        `${repo}#${num}`,
      ),
  )
}

/**
 * 将正整数转换为字母序号（a, b, ..., z, aa, ab, ...）。
 * 用于有序列表第二级缩进的编号格式。
 *
 * @param n 正整数（从 1 开始）
 * @returns 对应的小写字母序号字符串
 */
function numberToLetter(n: number): string {
  let result = ''
  while (n > 0) {
    n-- // 转换为 0-based 便于取模
    result = String.fromCharCode(97 + (n % 26)) + result // 97 = 'a'
    n = Math.floor(n / 26)
  }
  return result
}

// 罗马数字值-符号对照表（降序排列，用于贪心算法）
const ROMAN_VALUES: ReadonlyArray<[number, string]> = [
  [1000, 'm'],
  [900, 'cm'],
  [500, 'd'],
  [400, 'cd'],
  [100, 'c'],
  [90, 'xc'],
  [50, 'l'],
  [40, 'xl'],
  [10, 'x'],
  [9, 'ix'],
  [5, 'v'],
  [4, 'iv'],
  [1, 'i'],
]

/**
 * 将正整数转换为小写罗马数字。
 * 用于有序列表第三级缩进的编号格式。
 *
 * 使用贪心算法：从大到小依次减去最大可减的值并追加对应符号。
 *
 * @param n 正整数
 * @returns 对应的小写罗马数字字符串
 */
function numberToRoman(n: number): string {
  let result = ''
  for (const [value, numeral] of ROMAN_VALUES) {
    while (n >= value) {
      result += numeral
      n -= value
    }
  }
  return result
}

/**
 * 根据列表嵌套深度选择合适的编号格式。
 *
 * 编号格式按深度：
 * - 深度 0/1（顶层）：阿拉伯数字（1, 2, 3...）
 * - 深度 2：小写字母（a, b, c...）
 * - 深度 3：小写罗马数字（i, ii, iii...）
 * - 深度 4+：退回阿拉伯数字
 *
 * @param listDepth 列表嵌套深度
 * @param orderedListNumber 当前项的序号（1-based）
 * @returns 格式化后的编号字符串
 */
function getListNumber(listDepth: number, orderedListNumber: number): string {
  switch (listDepth) {
    case 0:
    case 1:
      // 顶层：阿拉伯数字
      return orderedListNumber.toString()
    case 2:
      // 二级：小写字母
      return numberToLetter(orderedListNumber)
    case 3:
      // 三级：小写罗马数字
      return numberToRoman(orderedListNumber)
    default:
      // 更深层：退回阿拉伯数字
      return orderedListNumber.toString()
  }
}

/**
 * 对内容字符串按照指定对齐方式填充到目标宽度。
 *
 * 设计要点：
 * - content 可能含 ANSI 转义序列（chalk 样式），不能直接用 .length 计算宽度；
 * - displayWidth 由调用方通过 stringWidth(stripAnsi(content)) 预先计算传入；
 * - 填充量 = max(0, targetWidth - displayWidth)，避免负数填充。
 *
 * 对齐规则：
 * - 'center'：左侧 floor(padding/2) 个空格，右侧其余空格；
 * - 'right'：全部填充在左侧；
 * - 'left' 或 null/undefined：全部填充在右侧（默认左对齐）。
 *
 * @param content 带 ANSI 样式的内容字符串
 * @param displayWidth content 的可见字符宽度（调用方计算）
 * @param targetWidth 目标列宽
 * @param align 对齐方式
 * @returns 填充后的字符串
 */
export function padAligned(
  content: string,
  displayWidth: number,
  targetWidth: number,
  align: 'left' | 'center' | 'right' | null | undefined,
): string {
  const padding = Math.max(0, targetWidth - displayWidth)
  if (align === 'center') {
    // 居中：左侧填充 floor(padding/2)，右侧填充其余
    const leftPad = Math.floor(padding / 2)
    return ' '.repeat(leftPad) + content + ' '.repeat(padding - leftPad)
  }
  if (align === 'right') {
    // 右对齐：全部填充在左侧
    return ' '.repeat(padding) + content
  }
  // 左对齐（默认）：全部填充在右侧
  return content + ' '.repeat(padding)
}
