/**
 * formatters.ts — LSP 工具结果格式化器集合
 *
 * 【在 Claude Code 系统中的位置】
 * 本文件为 LSPTool 提供纯函数格式化器，位于 LSPTool 目录下。
 * LSPTool.ts 在 formatResult() 中根据操作类型分发到本文件中对应的格式化函数，
 * 将 vscode-languageserver-types 中的 LSP 原始数据结构转换为模型可读的文本描述。
 *
 * 【主要功能】
 * 所有函数均为纯格式化，无 I/O 操作：
 * - formatGoToDefinitionResult：处理 Location/LocationLink/数组，过滤无效 URI
 * - formatFindReferencesResult：按文件分组展示引用位置列表
 * - formatHoverResult：提取 MarkupContent/MarkedString 文本，附加位置信息
 * - formatDocumentSymbolResult：检测 DocumentSymbol[] vs SymbolInformation[]，
 *   分别以层级树或平铺列表格式展示
 * - formatWorkspaceSymbolResult：按文件分组展示工作区符号
 * - formatPrepareCallHierarchyResult：展示调用层次入口项
 * - formatIncomingCallsResult：展示调用当前函数的调用方（按文件分组）
 * - formatOutgoingCallsResult：展示当前函数调用的被调方（按文件分组）
 *
 * 内部工具函数：
 * - formatUri：file:// 去除、Windows 盘符处理、URI 解码、相对路径转换
 * - groupByFile：泛型按文件 URI 分组
 * - formatLocation：位置格式化（1-based 行列）
 * - locationLinkToLocation：LocationLink → Location 规范化
 * - isLocationLink：类型守卫
 * - extractMarkupText：提取 MarkupContent/MarkedString 文本
 * - symbolKindToString：SymbolKind 枚举（1-26）映射为可读字符串
 * - formatDocumentSymbolNode：递归格式化 DocumentSymbol 树节点
 * - formatCallHierarchyItem：格式化调用层次项（含 URI 校验）
 */

import { relative } from 'path'
import type {
  CallHierarchyIncomingCall,
  CallHierarchyItem,
  CallHierarchyOutgoingCall,
  DocumentSymbol,
  Hover,
  Location,
  LocationLink,
  MarkedString,
  MarkupContent,
  SymbolInformation,
  SymbolKind,
} from 'vscode-languageserver-types'
import { logForDebugging } from '../../utils/debug.js'
import { errorMessage } from '../../utils/errors.js'
import { plural } from '../../utils/stringUtils.js'

/**
 * 将 LSP URI 转换为可读文件路径字符串。
 *
 * 处理流程：
 * 1. undefined/null URI 防御性处理，返回 '<unknown location>'
 * 2. 去除 file:// 协议前缀
 * 3. Windows 驱动器路径处理（/C:/path → C:/path）
 * 4. URI 解码（%20 等），解码失败时降级使用未解码路径
 * 5. 若提供 cwd，转换为相对路径（仅当相对路径更短且不以 ../../ 开头时）
 * 6. 统一将路径分隔符转换为正斜杠（Windows 兼容）
 *
 * @param uri - LSP 返回的文件 URI
 * @param cwd - 可选的当前工作目录，用于生成相对路径
 * @returns 可读的文件路径字符串
 */
function formatUri(uri: string | undefined, cwd?: string): string {
  // Handle undefined/null URIs - this indicates malformed LSP data
  if (!uri) {
    // NOTE: This should ideally be caught earlier with proper error logging
    // This is a defensive backstop in the formatting layer
    // URI 为空：记录警告并返回占位符（防御性兜底，理想情况下应在更早的层次捕获）
    logForDebugging(
      'formatUri called with undefined URI - indicates malformed LSP server response',
      { level: 'warn' },
    )
    return '<unknown location>'
  }

  // Remove file:// protocol if present
  // On Windows, file:///C:/path becomes /C:/path after replacing file://
  // We need to strip the leading slash for Windows drive-letter paths
  // 去除 file:// 协议前缀；Windows 路径 file:///C:/... → /C:/... 需额外去除前导斜杠
  let filePath = uri.replace(/^file:\/\//, '')
  if (/^\/[A-Za-z]:/.test(filePath)) {
    // 匹配 Windows 驱动器路径（/C:/path），去除前导斜杠
    filePath = filePath.slice(1)
  }

  // Decode URI encoding - handle malformed URIs gracefully
  // 解码 URI 编码（%20 等），遇到格式错误时降级使用原始路径
  try {
    filePath = decodeURIComponent(filePath)
  } catch (error) {
    // Log for debugging but continue with un-decoded path
    const errorMsg = errorMessage(error)
    logForDebugging(
      `Failed to decode LSP URI '${uri}': ${errorMsg}. Using un-decoded path: ${filePath}`,
      { level: 'warn' },
    )
    // filePath already contains the un-decoded path, which is still usable
    // filePath 保持未解码状态，仍然可用
  }

  // Convert to relative path if cwd is provided
  if (cwd) {
    // Normalize separators to forward slashes for consistent display output
    // 计算相对路径，统一使用正斜杠
    const relativePath = relative(cwd, filePath).replaceAll('\\', '/')
    // Only use relative path if it's shorter and doesn't start with ../..
    // 仅当相对路径更短且不超过两级父目录时才使用相对路径
    if (
      relativePath.length < filePath.length &&
      !relativePath.startsWith('../../')
    ) {
      return relativePath
    }
  }

  // Normalize separators to forward slashes for consistent display output
  // 统一使用正斜杠（Windows 兼容）
  return filePath.replaceAll('\\', '/')
}

/**
 * 将结果列表按文件 URI 分组。
 *
 * 泛型辅助函数，支持 Location[]（有 uri 字段）
 * 和 SymbolInformation[]（有 location.uri 字段）两种格式。
 *
 * @param items - 待分组的 LSP 结果项列表
 * @param cwd - 可选工作目录（传递给 formatUri）
 * @returns 以格式化路径为 key，结果项数组为 value 的 Map
 */
function groupByFile<T extends { uri: string } | { location: { uri: string } }>(
  items: T[],
  cwd?: string,
): Map<string, T[]> {
  const byFile = new Map<string, T[]>()
  for (const item of items) {
    // 兼容两种结构：直接含 uri 字段，或通过 location.uri 访问
    const uri = 'uri' in item ? item.uri : item.location.uri
    const filePath = formatUri(uri, cwd)
    const existingItems = byFile.get(filePath)
    if (existingItems) {
      existingItems.push(item)
    } else {
      byFile.set(filePath, [item])
    }
  }
  return byFile
}

/**
 * 格式化单个 Location 为 "文件路径:行:列" 格式（1-based 行列）。
 *
 * @param location - LSP Location 对象
 * @param cwd - 可选工作目录（传递给 formatUri）
 * @returns 格式化后的位置字符串
 */
function formatLocation(location: Location, cwd?: string): string {
  const filePath = formatUri(location.uri, cwd)
  const line = location.range.start.line + 1       // LSP 使用 0-based，转为 1-based
  const character = location.range.start.character + 1  // 同上
  return `${filePath}:${line}:${character}`
}

/**
 * 将 LocationLink 转换为 Location 格式，统一处理逻辑。
 * 优先使用 targetSelectionRange（更精确的符号选择范围），
 * 回退到 targetRange（整个定义范围）。
 *
 * @param link - LSP LocationLink 对象
 * @returns 等效的 Location 对象
 */
function locationLinkToLocation(link: LocationLink): Location {
  return {
    uri: link.targetUri,
    range: link.targetSelectionRange || link.targetRange,
  }
}

/**
 * 类型守卫：判断对象是 LocationLink（有 targetUri 字段）还是 Location（有 uri 字段）。
 *
 * @param item - Location 或 LocationLink 对象
 * @returns true 表示是 LocationLink
 */
function isLocationLink(item: Location | LocationLink): item is LocationLink {
  return 'targetUri' in item
}

/**
 * 格式化 goToDefinition（跳转到定义）的结果。
 *
 * 支持以下返回格式（LSP 规范允许多种变体）：
 * - null：未找到定义
 * - Location：单个定义位置
 * - LocationLink：单个定义位置（含选择范围信息）
 * - Location[]：多个定义位置
 * - LocationLink[]：多个定义位置（含选择范围信息）
 *
 * 会过滤掉 URI 为 undefined 的无效位置，并记录警告。
 *
 * @param result - LSP textDocument/definition 的响应结果
 * @param cwd - 可选工作目录（用于相对路径转换）
 * @returns 格式化后的定义位置描述字符串
 */
export function formatGoToDefinitionResult(
  result: Location | Location[] | LocationLink | LocationLink[] | null,
  cwd?: string,
): string {
  if (!result) {
    return 'No definition found. This may occur if the cursor is not on a symbol, or if the definition is in an external library not indexed by the LSP server.'
  }

  if (Array.isArray(result)) {
    // 将 LocationLink 数组统一转换为 Location 数组，便于后续处理
    const locations: Location[] = result.map(item =>
      isLocationLink(item) ? locationLinkToLocation(item) : item,
    )

    // 过滤并记录无效位置（URI 为 undefined）
    const invalidLocations = locations.filter(loc => !loc || !loc.uri)
    if (invalidLocations.length > 0) {
      logForDebugging(
        `formatGoToDefinitionResult: Filtering out ${invalidLocations.length} invalid location(s) - this should have been caught earlier`,
        { level: 'warn' },
      )
    }

    const validLocations = locations.filter(loc => loc && loc.uri)

    if (validLocations.length === 0) {
      return 'No definition found. This may occur if the cursor is not on a symbol, or if the definition is in an external library not indexed by the LSP server.'
    }
    if (validLocations.length === 1) {
      return `Defined in ${formatLocation(validLocations[0]!, cwd)}`
    }
    // 多个定义时列出所有位置
    const locationList = validLocations
      .map(loc => `  ${formatLocation(loc, cwd)}`)
      .join('\n')
    return `Found ${validLocations.length} definitions:\n${locationList}`
  }

  // 单个结果：如果是 LocationLink 则先转换为 Location
  const location = isLocationLink(result)
    ? locationLinkToLocation(result)
    : result
  return `Defined in ${formatLocation(location, cwd)}`
}

/**
 * 格式化 findReferences（查找引用）的结果。
 *
 * 将引用按文件分组，每组内列出行列位置。
 * 会过滤掉 URI 为 undefined 的无效位置，并记录警告。
 *
 * @param result - LSP textDocument/references 的响应结果
 * @param cwd - 可选工作目录（用于相对路径转换）
 * @returns 格式化后的引用列表字符串
 */
export function formatFindReferencesResult(
  result: Location[] | null,
  cwd?: string,
): string {
  if (!result || result.length === 0) {
    return 'No references found. This may occur if the symbol has no usages, or if the LSP server has not fully indexed the workspace.'
  }

  // 过滤并记录无效位置（URI 为 undefined）
  const invalidLocations = result.filter(loc => !loc || !loc.uri)
  if (invalidLocations.length > 0) {
    logForDebugging(
      `formatFindReferencesResult: Filtering out ${invalidLocations.length} invalid location(s) - this should have been caught earlier`,
      { level: 'warn' },
    )
  }

  const validLocations = result.filter(loc => loc && loc.uri)

  if (validLocations.length === 0) {
    return 'No references found. This may occur if the symbol has no usages, or if the LSP server has not fully indexed the workspace.'
  }

  if (validLocations.length === 1) {
    return `Found 1 reference:\n  ${formatLocation(validLocations[0]!, cwd)}`
  }

  // 按文件分组展示，列出每个文件内的引用行列
  const byFile = groupByFile(validLocations, cwd)

  const lines: string[] = [
    `Found ${validLocations.length} references across ${byFile.size} files:`,
  ]

  for (const [filePath, locations] of byFile) {
    lines.push(`\n${filePath}:`)
    for (const loc of locations) {
      const line = loc.range.start.line + 1        // 转为 1-based
      const character = loc.range.start.character + 1  // 转为 1-based
      lines.push(`  Line ${line}:${character}`)
    }
  }

  return lines.join('\n')
}

/**
 * 从 MarkupContent、MarkedString 或 MarkedString[] 中提取纯文本内容。
 *
 * LSP hover 响应的 contents 字段可能为以下几种格式：
 * - string：直接返回
 * - MarkedString（{ language, value } 或 string）：提取 value
 * - MarkedString[]：多段拼接，以双换行分隔
 * - MarkupContent（{ kind, value }）：提取 value（markdown 或 plaintext）
 *
 * @param contents - hover 响应的 contents 字段
 * @returns 提取的纯文本字符串
 */
function extractMarkupText(
  contents: MarkupContent | MarkedString | MarkedString[],
): string {
  if (Array.isArray(contents)) {
    // MarkedString 数组：将各段拼接，字符串直接使用，对象提取 value
    return contents
      .map(item => {
        if (typeof item === 'string') {
          return item
        }
        return item.value
      })
      .join('\n\n')
  }

  if (typeof contents === 'string') {
    // 直接是字符串
    return contents
  }

  if ('kind' in contents) {
    // MarkupContent 格式（含 kind 字段：'markdown' 或 'plaintext'）
    return contents.value
  }

  // MarkedString 对象格式（{ language, value }）
  return contents.value
}

/**
 * 格式化 hover（悬停信息）的结果。
 *
 * 若结果包含 range 字段，则在信息前附加位置坐标。
 *
 * @param result - LSP textDocument/hover 的响应结果
 * @param _cwd - 未使用（接口一致性保留）
 * @returns 格式化后的悬停信息字符串
 */
export function formatHoverResult(result: Hover | null, _cwd?: string): string {
  if (!result) {
    return 'No hover information available. This may occur if the cursor is not on a symbol, or if the LSP server has not fully indexed the file.'
  }

  const content = extractMarkupText(result.contents)

  if (result.range) {
    // 附加悬停位置信息（1-based 行列）
    const line = result.range.start.line + 1
    const character = result.range.start.character + 1
    return `Hover info at ${line}:${character}:\n\n${content}`
  }

  return content
}

/**
 * 将 LSP SymbolKind 枚举值（1-26）映射为可读的类型名称字符串。
 *
 * 完整覆盖 LSP 规范定义的所有 26 种符号类型，
 * 未知值返回 'Unknown'。
 *
 * @param kind - LSP SymbolKind 枚举值
 * @returns 可读的符号类型名称
 */
function symbolKindToString(kind: SymbolKind): string {
  const kinds: Record<SymbolKind, string> = {
    [1]: 'File',
    [2]: 'Module',
    [3]: 'Namespace',
    [4]: 'Package',
    [5]: 'Class',
    [6]: 'Method',
    [7]: 'Property',
    [8]: 'Field',
    [9]: 'Constructor',
    [10]: 'Enum',
    [11]: 'Interface',
    [12]: 'Function',
    [13]: 'Variable',
    [14]: 'Constant',
    [15]: 'String',
    [16]: 'Number',
    [17]: 'Boolean',
    [18]: 'Array',
    [19]: 'Object',
    [20]: 'Key',
    [21]: 'Null',
    [22]: 'EnumMember',
    [23]: 'Struct',
    [24]: 'Event',
    [25]: 'Operator',
    [26]: 'TypeParameter',
  }
  return kinds[kind] || 'Unknown'
}

/**
 * 递归格式化单个 DocumentSymbol 节点（含子节点）。
 *
 * 输出格式：`[缩进]名称 (类型) [详情] - Line 行号`
 * 子节点递归增加缩进（每级 2 空格）。
 *
 * @param symbol - DocumentSymbol 对象
 * @param indent - 当前缩进级别（默认 0）
 * @returns 格式化后的文本行数组
 */
function formatDocumentSymbolNode(
  symbol: DocumentSymbol,
  indent: number = 0,
): string[] {
  const lines: string[] = []
  const prefix = '  '.repeat(indent)  // 每级 2 空格缩进
  const kind = symbolKindToString(symbol.kind)

  let line = `${prefix}${symbol.name} (${kind})`
  if (symbol.detail) {
    // 附加符号详情（如函数签名等）
    line += ` ${symbol.detail}`
  }

  const symbolLine = symbol.range.start.line + 1  // 转为 1-based 行号
  line += ` - Line ${symbolLine}`

  lines.push(line)

  // 递归处理子符号（如类的方法、属性等）
  if (symbol.children && symbol.children.length > 0) {
    for (const child of symbol.children) {
      lines.push(...formatDocumentSymbolNode(child, indent + 1))
    }
  }

  return lines
}

/**
 * 格式化 documentSymbol（文档符号大纲）的结果。
 *
 * LSP 规范允许 textDocument/documentSymbol 返回两种格式：
 * - DocumentSymbol[]：层级结构（含 range 字段，支持嵌套子符号）
 * - SymbolInformation[]：平铺结构（含 location.range 字段）
 *
 * 本函数通过检查第一个元素是否有 location 字段来区分两种格式，
 * SymbolInformation[] 格式委托给 formatWorkspaceSymbolResult 处理。
 *
 * @param result - LSP textDocument/documentSymbol 的响应结果
 * @param cwd - 可选工作目录（传递给 formatWorkspaceSymbolResult）
 * @returns 格式化后的符号大纲字符串
 */
export function formatDocumentSymbolResult(
  result: DocumentSymbol[] | SymbolInformation[] | null,
  cwd?: string,
): string {
  if (!result || result.length === 0) {
    return 'No symbols found in document. This may occur if the file is empty, not supported by the LSP server, or if the server has not fully indexed the file.'
  }

  // Detect format: DocumentSymbol has 'range' directly, SymbolInformation has 'location.range'
  // Check the first valid element to determine format
  // 格式检测：通过第一个元素是否有 location 字段区分两种结构
  const firstSymbol = result[0]
  const isSymbolInformation = firstSymbol && 'location' in firstSymbol

  if (isSymbolInformation) {
    // SymbolInformation[] 格式：委托给工作区符号格式化器
    return formatWorkspaceSymbolResult(result as SymbolInformation[], cwd)
  }

  // DocumentSymbol[] 格式（层级树结构）
  const lines: string[] = ['Document symbols:']

  for (const symbol of result as DocumentSymbol[]) {
    lines.push(...formatDocumentSymbolNode(symbol))
  }

  return lines.join('\n')
}

/**
 * 格式化 workspaceSymbol（工作区符号搜索）的结果。
 *
 * 将符号按文件分组，每组内列出符号名、类型、行号和容器名（如有）。
 * 会过滤掉 location.uri 为 undefined 的无效符号，并记录警告。
 *
 * @param result - LSP workspace/symbol 的响应结果
 * @param cwd - 可选工作目录（用于相对路径转换）
 * @returns 格式化后的符号列表字符串
 */
export function formatWorkspaceSymbolResult(
  result: SymbolInformation[] | null,
  cwd?: string,
): string {
  if (!result || result.length === 0) {
    return 'No symbols found in workspace. This may occur if the workspace is empty, or if the LSP server has not finished indexing the project.'
  }

  // 过滤并记录无效符号（location.uri 为 undefined）
  const invalidSymbols = result.filter(
    sym => !sym || !sym.location || !sym.location.uri,
  )
  if (invalidSymbols.length > 0) {
    logForDebugging(
      `formatWorkspaceSymbolResult: Filtering out ${invalidSymbols.length} invalid symbol(s) - this should have been caught earlier`,
      { level: 'warn' },
    )
  }

  const validSymbols = result.filter(
    sym => sym && sym.location && sym.location.uri,
  )

  if (validSymbols.length === 0) {
    return 'No symbols found in workspace. This may occur if the workspace is empty, or if the LSP server has not finished indexing the project.'
  }

  const lines: string[] = [
    `Found ${validSymbols.length} ${plural(validSymbols.length, 'symbol')} in workspace:`,
  ]

  // 按文件分组
  const byFile = groupByFile(validSymbols, cwd)

  for (const [filePath, symbols] of byFile) {
    lines.push(`\n${filePath}:`)
    for (const symbol of symbols) {
      const kind = symbolKindToString(symbol.kind)
      const line = symbol.location.range.start.line + 1  // 转为 1-based
      let symbolLine = `  ${symbol.name} (${kind}) - Line ${line}`

      // 若有容器名（如所属类或模块），附加显示
      if (symbol.containerName) {
        symbolLine += ` in ${symbol.containerName}`
      }

      lines.push(symbolLine)
    }
  }

  return lines.join('\n')
}

/**
 * 格式化单个 CallHierarchyItem（调用层次项）为可读字符串。
 *
 * 输出格式：`名称 (类型) - 文件路径:行号 [详情]`
 * 会对 URI 为 undefined 的项做防御性处理。
 *
 * @param item - LSP CallHierarchyItem 对象
 * @param cwd - 可选工作目录（用于相对路径转换）
 * @returns 格式化后的调用层次项字符串
 */
function formatCallHierarchyItem(
  item: CallHierarchyItem,
  cwd?: string,
): string {
  // Validate URI - handle undefined/null gracefully
  if (!item.uri) {
    logForDebugging(
      'formatCallHierarchyItem: CallHierarchyItem has undefined URI',
      { level: 'warn' },
    )
    return `${item.name} (${symbolKindToString(item.kind)}) - <unknown location>`
  }

  const filePath = formatUri(item.uri, cwd)
  const line = item.range.start.line + 1  // 转为 1-based
  const kind = symbolKindToString(item.kind)
  let result = `${item.name} (${kind}) - ${filePath}:${line}`
  if (item.detail) {
    result += ` [${item.detail}]`
  }
  return result
}

/**
 * 格式化 prepareCallHierarchy（准备调用层次）的结果。
 *
 * 返回目标位置的调用层次入口项（通常为 1 个）。
 *
 * @param result - LSP callHierarchy/prepareCallHierarchy 的响应结果
 * @param cwd - 可选工作目录（用于相对路径转换）
 * @returns 格式化后的调用层次入口描述字符串
 */
export function formatPrepareCallHierarchyResult(
  result: CallHierarchyItem[] | null,
  cwd?: string,
): string {
  if (!result || result.length === 0) {
    return 'No call hierarchy item found at this position'
  }

  if (result.length === 1) {
    return `Call hierarchy item: ${formatCallHierarchyItem(result[0]!, cwd)}`
  }

  // 多个入口项时列出所有
  const lines = [`Found ${result.length} call hierarchy items:`]
  for (const item of result) {
    lines.push(`  ${formatCallHierarchyItem(item, cwd)}`)
  }
  return lines.join('\n')
}

/**
 * 格式化 incomingCalls（调用方查询）的结果。
 *
 * 展示所有调用了目标函数/方法的调用方，按文件分组。
 * 每个调用方还会显示具体的调用发生位置（fromRanges）。
 *
 * @param result - LSP callHierarchy/incomingCalls 的响应结果
 * @param cwd - 可选工作目录（用于相对路径转换）
 * @returns 格式化后的调用方列表字符串
 */
export function formatIncomingCallsResult(
  result: CallHierarchyIncomingCall[] | null,
  cwd?: string,
): string {
  if (!result || result.length === 0) {
    return 'No incoming calls found (nothing calls this function)'
  }

  const lines = [
    `Found ${result.length} incoming ${plural(result.length, 'call')}:`,
  ]

  // 按文件分组（调用方所在文件）
  const byFile = new Map<string, CallHierarchyIncomingCall[]>()
  for (const call of result) {
    if (!call.from) {
      // from 字段为 undefined：记录警告并跳过
      logForDebugging(
        'formatIncomingCallsResult: CallHierarchyIncomingCall has undefined from field',
        { level: 'warn' },
      )
      continue
    }
    const filePath = formatUri(call.from.uri, cwd)
    const existing = byFile.get(filePath)
    if (existing) {
      existing.push(call)
    } else {
      byFile.set(filePath, [call])
    }
  }

  for (const [filePath, calls] of byFile) {
    lines.push(`\n${filePath}:`)
    for (const call of calls) {
      if (!call.from) {
        continue // 已在上面记录日志
      }
      const kind = symbolKindToString(call.from.kind)
      const line = call.from.range.start.line + 1  // 转为 1-based
      let callLine = `  ${call.from.name} (${kind}) - Line ${line}`

      // 显示调用发生的具体位置（一个调用方可能在多处调用目标）
      if (call.fromRanges && call.fromRanges.length > 0) {
        const callSites = call.fromRanges
          .map(r => `${r.start.line + 1}:${r.start.character + 1}`)
          .join(', ')
        callLine += ` [calls at: ${callSites}]`
      }

      lines.push(callLine)
    }
  }

  return lines.join('\n')
}

/**
 * 格式化 outgoingCalls（被调方查询）的结果。
 *
 * 展示目标函数/方法调用的所有其他函数/方法，按被调方所在文件分组。
 * 每个被调方还会显示在当前函数中的调用位置（fromRanges）。
 *
 * @param result - LSP callHierarchy/outgoingCalls 的响应结果
 * @param cwd - 可选工作目录（用于相对路径转换）
 * @returns 格式化后的被调方列表字符串
 */
export function formatOutgoingCallsResult(
  result: CallHierarchyOutgoingCall[] | null,
  cwd?: string,
): string {
  if (!result || result.length === 0) {
    return 'No outgoing calls found (this function calls nothing)'
  }

  const lines = [
    `Found ${result.length} outgoing ${plural(result.length, 'call')}:`,
  ]

  // 按文件分组（被调方所在文件）
  const byFile = new Map<string, CallHierarchyOutgoingCall[]>()
  for (const call of result) {
    if (!call.to) {
      // to 字段为 undefined：记录警告并跳过
      logForDebugging(
        'formatOutgoingCallsResult: CallHierarchyOutgoingCall has undefined to field',
        { level: 'warn' },
      )
      continue
    }
    const filePath = formatUri(call.to.uri, cwd)
    const existing = byFile.get(filePath)
    if (existing) {
      existing.push(call)
    } else {
      byFile.set(filePath, [call])
    }
  }

  for (const [filePath, calls] of byFile) {
    lines.push(`\n${filePath}:`)
    for (const call of calls) {
      if (!call.to) {
        continue // 已在上面记录日志
      }
      const kind = symbolKindToString(call.to.kind)
      const line = call.to.range.start.line + 1  // 转为 1-based
      let callLine = `  ${call.to.name} (${kind}) - Line ${line}`

      // 显示在当前函数中发起调用的具体位置
      if (call.fromRanges && call.fromRanges.length > 0) {
        const callSites = call.fromRanges
          .map(r => `${r.start.line + 1}:${r.start.character + 1}`)
          .join(', ')
        callLine += ` [called from: ${callSites}]`
      }

      lines.push(callLine)
    }
  }

  return lines.join('\n')
}
