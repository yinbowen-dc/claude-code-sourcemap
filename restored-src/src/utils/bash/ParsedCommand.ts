/**
 * 已解析命令对象模块。
 *
 * 在 Claude Code 系统中，该模块定义 IParsedCommand 接口及其两个实现：
 * - RegexParsedCommand_DEPRECATED：基于 shell-quote 的旧版正则回退实现
 * - TreeSitterParsedCommand（内部类）：基于 tree-sitter AST 的精准实现，
 *   支持 UTF-8 字节偏移切片，正确处理多字节字符
 * - ParsedCommand 对象：提供 parse() 工厂方法，优先使用 tree-sitter，
 *   不可用时回退到正则实现；带单条目缓存，避免对同一命令重复解析
 * - buildParsedCommandFromRoot()：从已有 AST 根节点构建命令对象，跳过冗余解析
 *
 * IParsedCommand 接口方法：
 * - toString()：返回原始命令字符串
 * - getPipeSegments()：按管道符分割命令片段
 * - withoutOutputRedirections()：返回去除输出重定向后的命令
 * - getOutputRedirections()：返回输出重定向信息列表
 * - getTreeSitterAnalysis()：返回 tree-sitter 安全分析结果（正则实现返回 null）
 */
import memoize from 'lodash-es/memoize.js'
import {
  extractOutputRedirections,
  splitCommandWithOperators,
} from './commands.js'
import type { Node } from './parser.js'
import {
  analyzeCommand,
  type TreeSitterAnalysis,
} from './treeSitterAnalysis.js'

export type OutputRedirection = {
  target: string
  operator: '>' | '>>'
}

/**
 * Interface for parsed command implementations.
 * Both tree-sitter and regex fallback implementations conform to this.
 */
export interface IParsedCommand {
  readonly originalCommand: string
  toString(): string
  getPipeSegments(): string[]
  withoutOutputRedirections(): string
  getOutputRedirections(): OutputRedirection[]
  /**
   * Returns tree-sitter analysis data if available.
   * Returns null for the regex fallback implementation.
   */
  getTreeSitterAnalysis(): TreeSitterAnalysis | null
}

/**
 * @deprecated 旧版正则/shell-quote 解析路径，仅在 tree-sitter 不可用时使用。
 * 主要安全门控在 parseForSecurity（ast.ts）中，此类仅作回退兜底。
 *
 * 基于 shell-quote 解析器的正则实现，功能有限：
 * - getPipeSegments：按 | 分割，无法正确处理引号内的管道符
 * - withoutOutputRedirections：通过字符串匹配移除重定向，可能误伤引号内的 >
 * - getTreeSitterAnalysis：始终返回 null，无安全分析能力
 */
export class RegexParsedCommand_DEPRECATED implements IParsedCommand {
  readonly originalCommand: string

  constructor(command: string) {
    this.originalCommand = command
  }

  toString(): string {
    return this.originalCommand
  }

  getPipeSegments(): string[] {
    try {
      // 用 shell-quote 分词，按 | 分隔符重组各段
      const parts = splitCommandWithOperators(this.originalCommand)
      const segments: string[] = []
      let currentSegment: string[] = []

      for (const part of parts) {
        if (part === '|') {
          // 遇到管道符，将当前累积的词组合为一段
          if (currentSegment.length > 0) {
            segments.push(currentSegment.join(' '))
            currentSegment = []
          }
        } else {
          currentSegment.push(part)
        }
      }

      // 处理最后一段（无管道符结尾的情况）
      if (currentSegment.length > 0) {
        segments.push(currentSegment.join(' '))
      }

      return segments.length > 0 ? segments : [this.originalCommand]
    } catch {
      // 解析失败时将整个命令作为单段返回
      return [this.originalCommand]
    }
  }

  withoutOutputRedirections(): string {
    // 快速路径：命令中没有 > 符号则无需处理
    if (!this.originalCommand.includes('>')) {
      return this.originalCommand
    }
    const { commandWithoutRedirections, redirections } =
      extractOutputRedirections(this.originalCommand)
    // 只有确实提取到重定向时才返回去掉重定向后的命令
    return redirections.length > 0
      ? commandWithoutRedirections
      : this.originalCommand
  }

  getOutputRedirections(): OutputRedirection[] {
    const { redirections } = extractOutputRedirections(this.originalCommand)
    return redirections
  }

  getTreeSitterAnalysis(): TreeSitterAnalysis | null {
    return null
  }
}

// 重定向节点：在 OutputRedirection 基础上增加 AST 字节偏移，用于从原始命令中精确切除重定向片段
type RedirectionNode = OutputRedirection & {
  startIndex: number
  endIndex: number
}

/**
 * 深度优先遍历 AST 节点，对每个节点调用 visitor 回调。
 * 用于提取管道位置和重定向节点等需要全树扫描的场景。
 */
function visitNodes(node: Node, visitor: (node: Node) => void): void {
  visitor(node)
  for (const child of node.children) {
    visitNodes(child, visitor)
  }
}

/**
 * 从 AST 根节点中提取所有管道符（|）的字节偏移位置列表。
 * 对于 `a | b && c | d` 这类嵌套管道，depth-first 遍历顺序可能乱序，
 * 因此结果需按偏移量排序，确保后续切片左到右进行。
 */
function extractPipePositions(rootNode: Node): number[] {
  const pipePositions: number[] = []
  visitNodes(rootNode, node => {
    if (node.type === 'pipeline') {
      for (const child of node.children) {
        if (child.type === '|') {
          pipePositions.push(child.startIndex)
        }
      }
    }
  })
  // visitNodes 是深度优先遍历。对于 `a | b && c | d`，外层 list 节点将
  // 第二个 pipeline 作为第一个的兄弟节点，外层 | 先于内层被访问，导致位置乱序。
  // getPipeSegments 按顺序切片，因此必须在此排序。
  return pipePositions.sort((a, b) => a - b)
}

/**
 * 从 AST 根节点中提取所有输出重定向节点（file_redirect），
 * 包含操作符类型（> 或 >>）、目标文件名及字节偏移，
 * 供 withoutOutputRedirections() 精确切除重定向片段。
 */
function extractRedirectionNodes(rootNode: Node): RedirectionNode[] {
  const redirections: RedirectionNode[] = []
  visitNodes(rootNode, node => {
    if (node.type === 'file_redirect') {
      const children = node.children
      // 查找重定向操作符节点（> 或 >>）
      const op = children.find(c => c.type === '>' || c.type === '>>')
      // 查找目标文件名节点
      const target = children.find(c => c.type === 'word')
      if (op && target) {
        redirections.push({
          startIndex: node.startIndex,
          endIndex: node.endIndex,
          target: target.text,
          operator: op.type as '>' | '>>',
        })
      }
    }
  })
  return redirections
}

class TreeSitterParsedCommand implements IParsedCommand {
  readonly originalCommand: string
  // tree-sitter 的 startIndex/endIndex 是 UTF-8 字节偏移，而 JS String.slice()
  // 使用 UTF-16 码元索引。对于 ASCII 两者一致；对于多字节码点（如 U+2014 "—"：
  // 3 个 UTF-8 字节，1 个 UTF-16 码元），直接用字节偏移切 JS 字符串会落在词元中间。
  // 将命令编码为 UTF-8 Buffer，用字节偏移切片后再解码为字符串，可正确处理任意宽度字符。
  private readonly commandBytes: Buffer
  private readonly pipePositions: number[]
  private readonly redirectionNodes: RedirectionNode[]
  private readonly treeSitterAnalysis: TreeSitterAnalysis

  constructor(
    command: string,
    pipePositions: number[],
    redirectionNodes: RedirectionNode[],
    treeSitterAnalysis: TreeSitterAnalysis,
  ) {
    this.originalCommand = command
    this.commandBytes = Buffer.from(command, 'utf8')
    this.pipePositions = pipePositions
    this.redirectionNodes = redirectionNodes
    this.treeSitterAnalysis = treeSitterAnalysis
  }

  toString(): string {
    return this.originalCommand
  }

  getPipeSegments(): string[] {
    // 无管道符则整个命令作为单段返回
    if (this.pipePositions.length === 0) {
      return [this.originalCommand]
    }

    const segments: string[] = []
    let currentStart = 0

    for (const pipePos of this.pipePositions) {
      // 从 UTF-8 字节缓冲区按字节偏移切片，再解码为字符串（正确处理多字节字符）
      const segment = this.commandBytes
        .subarray(currentStart, pipePos)
        .toString('utf8')
        .trim()
      if (segment) {
        segments.push(segment)
      }
      // 跳过管道符本身（1 个字节）
      currentStart = pipePos + 1
    }

    // 处理最后一段管道符之后的命令
    const lastSegment = this.commandBytes
      .subarray(currentStart)
      .toString('utf8')
      .trim()
    if (lastSegment) {
      segments.push(lastSegment)
    }

    return segments
  }

  withoutOutputRedirections(): string {
    if (this.redirectionNodes.length === 0) return this.originalCommand

    // 从后向前按字节偏移删除重定向片段，避免前面删除后影响后面的偏移
    const sorted = [...this.redirectionNodes].sort(
      (a, b) => b.startIndex - a.startIndex,
    )

    let result = this.commandBytes
    for (const redir of sorted) {
      // 拼接重定向节点前后的字节，将该重定向片段从命令中切除
      result = Buffer.concat([
        result.subarray(0, redir.startIndex),
        result.subarray(redir.endIndex),
      ])
    }
    // 解码并规范化空白（多余空格合并为单个空格）
    return result.toString('utf8').trim().replace(/\s+/g, ' ')
  }

  getOutputRedirections(): OutputRedirection[] {
    return this.redirectionNodes.map(({ target, operator }) => ({
      target,
      operator,
    }))
  }

  getTreeSitterAnalysis(): TreeSitterAnalysis {
    return this.treeSitterAnalysis
  }
}

// 记忆化检测 tree-sitter 是否可用：尝试解析 'echo test'，成功则返回 true。
// 使用 memoize 确保只检测一次，避免重复初始化开销。
const getTreeSitterAvailable = memoize(async (): Promise<boolean> => {
  try {
    const { parseCommand } = await import('./parser.js')
    const testResult = await parseCommand('echo test')
    return testResult !== null
  } catch {
    return false
  }
})

/**
 * 从已有 AST 根节点构建 TreeSitterParsedCommand 对象。
 * 供已完成 native.parse 的调用方使用，跳过 ParsedCommand.parse() 中冗余的二次解析，
 * 节省约 1 次原生解析 + 6 次树遍历的开销。
 */
export function buildParsedCommandFromRoot(
  command: string,
  root: Node,
): IParsedCommand {
  const pipePositions = extractPipePositions(root)
  const redirectionNodes = extractRedirectionNodes(root)
  const analysis = analyzeCommand(root, command)
  return new TreeSitterParsedCommand(
    command,
    pipePositions,
    redirectionNodes,
    analysis,
  )
}

async function doParse(command: string): Promise<IParsedCommand | null> {
  if (!command) return null

  // 检测 tree-sitter 是否可用（首次调用时做一次 'echo test' 探针，结果被记忆化）
  const treeSitterAvailable = await getTreeSitterAvailable()
  if (treeSitterAvailable) {
    try {
      const { parseCommand } = await import('./parser.js')
      const data = await parseCommand(command)
      if (data) {
        // 原生 NAPI 解析器返回普通 JS 对象（无 WASM 句柄），无需手动释放内存
        return buildParsedCommandFromRoot(command, data.rootNode)
      }
    } catch {
      // 解析失败则跌落到正则实现
    }
  }

  // tree-sitter 不可用或解析失败时，回退到旧版正则实现
  return new RegexParsedCommand_DEPRECATED(command)
}

// 单条目缓存：旧版调用方（bashCommandIsSafeAsync、buildSegmentWithoutRedirections）
// 可能对同一命令字符串多次调用 ParsedCommand.parse()。每次 parse() 约需 1 次
// native.parse + 6 次树遍历，缓存最近一次命令可跳过冗余工作。
// 大小上限为 1，避免 TreeSitterParsedCommand 实例泄漏。
let lastCmd: string | undefined
let lastResult: Promise<IParsedCommand | null> | undefined

/**
 * ParsedCommand 工厂对象，提供解析 shell 命令字符串的统一入口。
 * 优先使用 tree-sitter 进行引号感知的精确解析，不可用时回退到正则实现。
 * 内置单条目缓存，对同一命令的重复解析直接返回缓存结果。
 */
export const ParsedCommand = {
  /**
   * 解析命令字符串，返回 IParsedCommand 实例。
   * 解析完全失败时返回 null（仅当命令为空字符串时发生）。
   */
  parse(command: string): Promise<IParsedCommand | null> {
    // 命中单条目缓存则直接返回，避免重复解析
    if (command === lastCmd && lastResult !== undefined) {
      return lastResult
    }
    lastCmd = command
    lastResult = doParse(command)
    return lastResult
  },
}
