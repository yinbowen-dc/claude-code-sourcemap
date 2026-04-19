/**
 * Tree-sitter bash 命令解析器封装模块。
 *
 * 在 Claude Code 系统中，该模块封装 tree-sitter-bash 原生模块，
 * 提供 bash 命令的 AST 解析能力：
 * - ensureInitialized()：初始化 tree-sitter 解析器（幂等，供外部调用）
 * - parseCommand()：完整解析，提取根节点、命令节点、环境变量（供 ParsedCommand 使用）
 * - parseCommandRaw()：仅返回 AST 根节点，跳过多余树遍历（供 ast.ts 安全分析使用）
 * - PARSE_ABORTED：特殊哨兵值，区分"解析器不可用"与"解析器已加载但中止"
 *   （超时/节点预算耗尽/Rust panic），调用方 MUST 以 fail-closed 方式处理
 * - extractCommandArguments()：从命令节点提取参数列表
 *
 * 特性开关：TREE_SITTER_BASH（正式启用）/ TREE_SITTER_BASH_SHADOW（影子模式）
 * 命令长度上限：10000 字符；解析超时：50ms；最大节点数：50000
 */
import { feature } from 'bun:bundle'
import { logEvent } from '../../services/analytics/index.js'
import { logForDebugging } from '../debug.js'
import {
  ensureParserInitialized,
  getParserModule,
  type TsNode,
} from './bashParser.js'

export type Node = TsNode

export interface ParsedCommandData {
  rootNode: Node
  envVars: string[]
  commandNode: Node | null
  originalCommand: string
}

const MAX_COMMAND_LENGTH = 10000
const DECLARATION_COMMANDS = new Set([
  'export',
  'declare',
  'typeset',
  'readonly',
  'local',
  'unset',
  'unsetenv',
])
const ARGUMENT_TYPES = new Set(['word', 'string', 'raw_string', 'number'])
const SUBSTITUTION_TYPES = new Set([
  'command_substitution',
  'process_substitution',
])
const COMMAND_TYPES = new Set(['command', 'declaration_command'])

let logged = false
function logLoadOnce(success: boolean): void {
  if (logged) return
  logged = true
  logForDebugging(
    success ? 'tree-sitter: native module loaded' : 'tree-sitter: unavailable',
  )
  logEvent('tengu_tree_sitter_load', { success })
}

/**
 * 等待 WASM 初始化完成（Parser.init + Language.load）。
 * 必须在 parseCommand/parseCommandRaw 之前调用，否则解析器不可用。幂等。
 */
export async function ensureInitialized(): Promise<void> {
  if (feature('TREE_SITTER_BASH') || feature('TREE_SITTER_BASH_SHADOW')) {
    await ensureParserInitialized()
  }
}

export async function parseCommand(
  command: string,
): Promise<ParsedCommandData | null> {
  // 命令为空或超过 10000 字符上限时直接返回 null
  if (!command || command.length > MAX_COMMAND_LENGTH) return null

  // 特性门控：仅在 TREE_SITTER_BASH 启用时走 tree-sitter 路径；
  // 外部构建版本（未启用该特性）将回退到旧版正则路径。
  // 整个逻辑内嵌在正分支中，使 Bun DCE 可以删除 NAPI import，
  // 同时保证遥测数据的准确性——只有在真正尝试加载时才上报 tengu_tree_sitter_load。
  if (feature('TREE_SITTER_BASH')) {
    await ensureParserInitialized()
    const mod = getParserModule()
    // 记录首次加载结果（成功/失败），仅上报一次
    logLoadOnce(mod !== null)
    if (!mod) return null

    try {
      // 调用 native 模块解析命令字符串，获取 AST 根节点
      const rootNode = mod.parse(command)
      if (!rootNode) return null

      // 在 AST 中找到主命令节点（跳过管道、重定向等外层包装）
      const commandNode = findCommandNode(rootNode, null)
      // 提取命令节点中位于命令名之前的环境变量赋值列表
      const envVars = extractEnvVars(commandNode)

      return { rootNode, envVars, commandNode, originalCommand: command }
    } catch {
      return null
    }
  }
  return null
}

/**
 * 安全说明：`parse-aborted` 哨兵值，表示"解析器已加载并尝试解析，但中止"
 * （超时 / 节点预算耗尽 / Rust panic）。与 `null`（模块未加载）不同。
 * 对抗性输入可在 MAX_COMMAND_LENGTH 范围内触发中止：
 * 约含 2800 个下标的 `(( a[0][0]... ))` 会触发 PARSE_TIMEOUT_MICROS。
 * 调用方必须以 fail-closed（拒绝/too-complex）方式处理，不得路由到旧版路径。
 */
export const PARSE_ABORTED = Symbol('parse-aborted')

/**
 * 原始解析——跳过 findCommandNode/extractEnvVars（ast.ts 安全遍历器不使用这两者）。
 * 每条 bash 命令节省一次树遍历开销。
 *
 * 返回值：
 *   - Node：解析成功
 *   - null：模块未加载 / 特性未启用 / 命令为空 / 超过长度上限
 *   - PARSE_ABORTED：模块已加载但解析失败（超时/panic）
 */
export async function parseCommandRaw(
  command: string,
): Promise<Node | null | typeof PARSE_ABORTED> {
  // 空命令或超长命令直接返回 null（模块不可用语义）
  if (!command || command.length > MAX_COMMAND_LENGTH) return null
  if (feature('TREE_SITTER_BASH') || feature('TREE_SITTER_BASH_SHADOW')) {
    await ensureParserInitialized()
    const mod = getParserModule()
    logLoadOnce(mod !== null)
    if (!mod) return null
    try {
      const result = mod.parse(command)
      // 安全要点：模块已加载但 parse() 返回 null，说明在 bashParser.ts 中触发了
      // 超时（PARSE_TIMEOUT_MS=50）或节点预算（MAX_NODES=50000）中止。
      // 此前直接 return null 导致回退到旧版路径，而旧版缺少 EVAL_LIKE_BUILTINS 检查，
      // 造成 trap、enable、hash 等危险内建命令可被绕过。
      // 现在返回 PARSE_ABORTED 哨兵值，调用方必须以 fail-closed（拒绝）方式处理。
      if (result === null) {
        logEvent('tengu_tree_sitter_parse_abort', {
          cmdLength: command.length,
          panic: false,
        })
        return PARSE_ABORTED
      }
      return result
    } catch {
      // 捕获 Rust panic 等异常，同样返回 PARSE_ABORTED 而非 null
      logEvent('tengu_tree_sitter_parse_abort', {
        cmdLength: command.length,
        panic: true,
      })
      return PARSE_ABORTED
    }
  }
  return null
}

function findCommandNode(node: Node, parent: Node | null): Node | null {
  const { type, children } = node

  // 命令节点或声明命令节点直接返回
  if (COMMAND_TYPES.has(type)) return node

  // 变量赋值节点（如 FOO=bar cmd）：在同一父节点的后续兄弟中找命令节点
  if (type === 'variable_assignment' && parent) {
    return (
      parent.children.find(
        c => COMMAND_TYPES.has(c.type) && c.startIndex > node.startIndex,
      ) ?? null
    )
  }

  // 管道节点：递归检查第一个子节点（可能是 redirected_statement 包装）
  if (type === 'pipeline') {
    for (const child of children) {
      const result = findCommandNode(child, node)
      if (result) return result
    }
    return null
  }

  // 带重定向的语句（如 cmd > file）：直接在子节点中找命令节点
  if (type === 'redirected_statement') {
    return children.find(c => COMMAND_TYPES.has(c.type)) ?? null
  }

  // 其他节点类型：递归搜索所有子节点
  for (const child of children) {
    const result = findCommandNode(child, node)
    if (result) return result
  }

  return null
}

function extractEnvVars(commandNode: Node | null): string[] {
  // 只处理普通 command 节点；declaration_command（如 export）不含前置环境变量
  if (!commandNode || commandNode.type !== 'command') return []

  const envVars: string[] = []
  for (const child of commandNode.children) {
    if (child.type === 'variable_assignment') {
      // 收集命令名之前的所有环境变量赋值（如 FOO=bar BAZ=qux cmd）
      envVars.push(child.text)
    } else if (child.type === 'command_name' || child.type === 'word') {
      // 遇到命令名节点，停止收集（命令名之后的赋值不是环境变量前缀）
      break
    }
  }
  return envVars
}

export function extractCommandArguments(commandNode: Node): string[] {
  // 声明命令（export/declare 等）只返回声明关键字本身，不展开参数
  if (commandNode.type === 'declaration_command') {
    const firstChild = commandNode.children[0]
    return firstChild && DECLARATION_COMMANDS.has(firstChild.text)
      ? [firstChild.text]
      : []
  }

  const args: string[] = []
  let foundCommandName = false

  for (const child of commandNode.children) {
    // 跳过命令名前的环境变量赋值节点
    if (child.type === 'variable_assignment') continue

    // 命令名节点（command_name 类型，或未找到命令名时的首个 word 节点）
    if (
      child.type === 'command_name' ||
      (!foundCommandName && child.type === 'word')
    ) {
      foundCommandName = true
      args.push(child.text)
      continue
    }

    // 普通参数类型：word、string、raw_string、number
    if (ARGUMENT_TYPES.has(child.type)) {
      // 去除引号包裹，还原实际参数值
      args.push(stripQuotes(child.text))
    } else if (SUBSTITUTION_TYPES.has(child.type)) {
      // 遇到命令替换或进程替换时停止收集（内容不确定，无法静态分析）
      break
    }
  }
  return args
}

function stripQuotes(text: string): string {
  return text.length >= 2 &&
    ((text[0] === '"' && text.at(-1) === '"') ||
      (text[0] === "'" && text.at(-1) === "'"))
    ? text.slice(1, -1)
    : text
}
