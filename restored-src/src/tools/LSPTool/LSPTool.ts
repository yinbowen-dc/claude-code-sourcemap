/**
 * LSPTool.ts — Language Server Protocol 代码智能工具实现
 *
 * 【在 Claude Code 系统中的位置】
 * 本文件实现了 Claude Code 的 LSP 工具，工具名称为 "LSP"。
 * 它基于 Language Server Protocol（语言服务器协议）为模型提供代码智能功能，
 * 包括跳转定义、查找引用、悬浮提示、文档符号、工作区符号、跳转实现及调用层次结构等。
 * 通过 `lspToolInputSchema`（判别联合 Schema）完成严格输入校验，
 * 通过 `getLspServerManager()` 与底层 LSP 服务器通信，
 * 通过 `formatters.ts` 将原始 LSP 响应格式化为人类可读的文本。
 *
 * 【主要功能】
 * 1. 输入 Schema（懒加载，strictObject）：
 *    - operation：枚举，9 种 LSP 操作
 *    - filePath：目标文件路径（绝对或相对）
 *    - line / character：1-based 坐标（用户友好格式，内部转换为 0-based）
 * 2. 输出 Schema（懒加载）：
 *    - operation, result（格式化字符串）, filePath
 *    - resultCount（结果数量，可选）, fileCount（涉及文件数，可选）
 * 3. 工具特性：
 *    - isLsp: true（标记为 LSP 工具）
 *    - shouldDefer: true（延迟初始化，等待 LSP 连接建立）
 *    - isEnabled(): 仅在 LSP 已连接时启用
 *    - isConcurrencySafe / isReadOnly: true（只读，可并发）
 * 4. validateInput()：判别联合校验 + UNC 路径跳过 + 文件存在性/类型校验
 * 5. call() 核心流程：
 *    - 等待 LSP 初始化完成（pending 状态时 await）
 *    - 获取 LSP 服务器管理器（未初始化时返回错误提示）
 *    - 调用 getMethodAndParams() 将操作名映射为 LSP 方法与参数（1→0-based 坐标转换）
 *    - 如文件未打开：检查文件大小（>10MB 跳过），读取文件内容后 openFile()
 *    - sendRequest() 发送 LSP 请求
 *    - incomingCalls/outgoingCalls 需两步：先 prepareCallHierarchy，再发送实际调用请求
 *    - 对 findReferences/goToDefinition/goToImplementation/workspaceSymbol 结果进行 gitignore 过滤
 *    - formatResult() 格式化结果并提取 resultCount / fileCount
 * 6. filterGitIgnoredLocations()：批量调用 `git check-ignore`（批大小 50）过滤被 gitignore 的路径
 * 7. 辅助计数函数：
 *    - countSymbols()（递归统计 DocumentSymbol 树）
 *    - countUniqueFiles()、countUniqueFilesFromCallItems/IncomingCalls/OutgoingCalls()
 */

import { open } from 'fs/promises'
import * as path from 'path'
import { pathToFileURL } from 'url'
import type {
  CallHierarchyIncomingCall,
  CallHierarchyItem,
  CallHierarchyOutgoingCall,
  DocumentSymbol,
  Hover,
  Location,
  LocationLink,
  SymbolInformation,
} from 'vscode-languageserver-types'
import { z } from 'zod/v4'
import {
  getInitializationStatus,
  getLspServerManager,
  isLspConnected,
  waitForInitialization,
} from '../../services/lsp/manager.js'
import type { ValidationResult } from '../../Tool.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { uniq } from '../../utils/array.js'
import { getCwd } from '../../utils/cwd.js'
import { logForDebugging } from '../../utils/debug.js'
import { isENOENT, toError } from '../../utils/errors.js'
import { execFileNoThrowWithCwd } from '../../utils/execFileNoThrow.js'
import { getFsImplementation } from '../../utils/fsOperations.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { logError } from '../../utils/log.js'
import { expandPath } from '../../utils/path.js'
import { checkReadPermissionForTool } from '../../utils/permissions/filesystem.js'
import type { PermissionDecision } from '../../utils/permissions/PermissionResult.js'
import {
  formatDocumentSymbolResult,
  formatFindReferencesResult,
  formatGoToDefinitionResult,
  formatHoverResult,
  formatIncomingCallsResult,
  formatOutgoingCallsResult,
  formatPrepareCallHierarchyResult,
  formatWorkspaceSymbolResult,
} from './formatters.js'
import { DESCRIPTION, LSP_TOOL_NAME } from './prompt.js'
import { lspToolInputSchema } from './schemas.js'
import {
  renderToolResultMessage,
  renderToolUseErrorMessage,
  renderToolUseMessage,
  userFacingName,
} from './UI.js'

/** LSP 文件大小上限：超过 10MB 的文件跳过分析，避免内存溢出 */
const MAX_LSP_FILE_SIZE_BYTES = 10_000_000

/**
 * 工具兼容的输入 Schema（懒加载，普通 ZodStrictObject 而非判别联合）。
 *
 * 使用普通 ZodStrictObject 而非判别联合的原因：
 * Claude API 的 tool definition 需要单一 JSON Schema 对象。
 * 判别联合会生成 anyOf 结构，部分 API 版本不支持。
 * 真正的类型安全校验由 validateInput() 中的 lspToolInputSchema 判别联合完成。
 */
const inputSchema = lazySchema(() =>
  z.strictObject({
    operation: z
      .enum([
        'goToDefinition',
        'findReferences',
        'hover',
        'documentSymbol',
        'workspaceSymbol',
        'goToImplementation',
        'prepareCallHierarchy',
        'incomingCalls',
        'outgoingCalls',
      ])
      .describe('The LSP operation to perform'),
    filePath: z.string().describe('The absolute or relative path to the file'),
    line: z
      .number()
      .int()
      .positive()
      .describe('The line number (1-based, as shown in editors)'),
    character: z
      .number()
      .int()
      .positive()
      .describe('The character offset (1-based, as shown in editors)'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

/**
 * 输出 Schema（懒加载）：LSP 操作结果。
 * 包含：
 * - operation：执行的操作名称
 * - result：格式化后的人类可读结果字符串
 * - filePath：操作目标文件路径
 * - resultCount：结果数量（定义数、引用数、符号数等，可选）
 * - fileCount：涉及文件数量（可选）
 */
const outputSchema = lazySchema(() =>
  z.object({
    operation: z
      .enum([
        'goToDefinition',
        'findReferences',
        'hover',
        'documentSymbol',
        'workspaceSymbol',
        'goToImplementation',
        'prepareCallHierarchy',
        'incomingCalls',
        'outgoingCalls',
      ])
      .describe('The LSP operation that was performed'),
    result: z.string().describe('The formatted result of the LSP operation'),
    filePath: z
      .string()
      .describe('The file path the operation was performed on'),
    resultCount: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe('Number of results (definitions, references, symbols)'),
    fileCount: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe('Number of files containing results'),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.infer<OutputSchema>
export type Input = z.infer<InputSchema>

/**
 * LSPTool 工具定义。
 *
 * 通过 buildTool() 构建后注册到 Claude Code 工具系统，
 * 模型可通过名称 "LSP" 调用本工具执行各类 LSP 代码智能操作。
 * 仅在 LSP 服务器已连接时启用（isEnabled()），延迟初始化（shouldDefer: true）。
 */
export const LSPTool = buildTool({
  name: LSP_TOOL_NAME,
  searchHint: 'code intelligence (definitions, references, symbols, hover)',
  maxResultSizeChars: 100_000,
  /** 标记为 LSP 工具，用于框架内部区分和特殊处理 */
  isLsp: true,
  async description() {
    return DESCRIPTION
  },
  userFacingName,
  /** 延迟初始化：等待 LSP 服务器连接建立后再可用 */
  shouldDefer: true,
  /** 仅在 LSP 已连接时启用该工具 */
  isEnabled() {
    return isLspConnected()
  },
  /** 懒加载输入 Schema */
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  /** 懒加载输出 Schema */
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  /** 只读操作，支持并发调用 */
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },
  /** 返回目标文件的绝对路径，供权限检查使用 */
  getPath({ filePath }): string {
    return expandPath(filePath)
  },
  /**
   * 输入校验。
   *
   * 校验流程：
   * 1. 使用判别联合 Schema（lspToolInputSchema）进行严格类型校验
   * 2. 跳过 UNC 路径（避免 NTLM 凭证泄漏）
   * 3. 校验文件是否存在（ENOENT → errorCode 1）
   * 4. 校验路径是否为普通文件（非目录等 → errorCode 2）
   */
  async validateInput(input: Input): Promise<ValidationResult> {
    // 首先使用判别联合 Schema 校验，获得更精确的错误信息
    const parseResult = lspToolInputSchema().safeParse(input)
    if (!parseResult.success) {
      return {
        result: false,
        message: `Invalid input: ${parseResult.error.message}`,
        errorCode: 3,
      }
    }

    // 校验文件是否存在且为普通文件
    const fs = getFsImplementation()
    const absolutePath = expandPath(input.filePath)

    // 安全：跳过 UNC 路径的文件系统操作，防止 NTLM 凭证泄漏
    if (absolutePath.startsWith('\\\\') || absolutePath.startsWith('//')) {
      return { result: true }
    }

    let stats
    try {
      stats = await fs.stat(absolutePath)
    } catch (error) {
      if (isENOENT(error)) {
        return {
          result: false,
          message: `File does not exist: ${input.filePath}`,
          errorCode: 1,
        }
      }
      const err = toError(error)
      // 记录文件系统访问错误，便于追踪问题
      logError(
        new Error(
          `Failed to access file stats for LSP operation on ${input.filePath}: ${err.message}`,
        ),
      )
      return {
        result: false,
        message: `Cannot access file: ${input.filePath}. ${err.message}`,
        errorCode: 4,
      }
    }

    // 校验路径为普通文件而非目录
    if (!stats.isFile()) {
      return {
        result: false,
        message: `Path is not a file: ${input.filePath}`,
        errorCode: 2,
      }
    }

    return { result: true }
  },
  /**
   * 权限检查：调用读权限检查工具，确认 filePath 在允许范围内。
   */
  async checkPermissions(input, context): Promise<PermissionDecision> {
    const appState = context.getAppState()
    return checkReadPermissionForTool(
      LSPTool,
      input,
      appState.toolPermissionContext,
    )
  },
  async prompt() {
    return DESCRIPTION
  },
  renderToolUseMessage,
  renderToolUseErrorMessage,
  renderToolResultMessage,
  /**
   * 执行 LSP 操作的核心逻辑。
   *
   * 流程：
   * 1. 等待 LSP 初始化完成（status === 'pending' 时 await waitForInitialization()）
   * 2. 获取 LSP 服务器管理器，未初始化则返回错误提示
   * 3. 调用 getMethodAndParams() 将 operation 映射为 LSP 协议方法和参数
   *    （坐标从 1-based 转换为 0-based）
   * 4. 文件未在 LSP 服务器中打开时：
   *    - 检查文件大小（>10MB → 返回大文件提示，跳过分析）
   *    - 读取文件内容，调用 manager.openFile()
   * 5. 发送 LSP 请求（manager.sendRequest()）
   * 6. incomingCalls/outgoingCalls 特殊处理（两步协议）：
   *    - 第一步：prepareCallHierarchy 获取 CallHierarchyItem[]
   *    - 第二步：用 item[0] 发送 callHierarchy/incomingCalls 或 outgoingCalls
   * 7. 对返回位置结果进行 gitignore 过滤（findReferences/goToDefinition/goToImplementation/workspaceSymbol）
   * 8. formatResult() 格式化结果并提取 resultCount / fileCount
   * 9. 异常时记录日志并返回错误信息（不抛出）
   */
  async call(input: Input, _context) {
    const absolutePath = expandPath(input.filePath)
    const cwd = getCwd()

    // 等待 LSP 初始化完成，避免在初始化期间返回"无服务器可用"的错误
    const status = getInitializationStatus()
    if (status.status === 'pending') {
      await waitForInitialization()
    }

    // 获取 LSP 服务器管理器
    const manager = getLspServerManager()
    if (!manager) {
      // 记录系统级别的启动失败，便于排查问题
      logError(
        new Error('LSP server manager not initialized when tool was called'),
      )

      const output: Output = {
        operation: input.operation,
        result:
          'LSP server manager not initialized. This may indicate a startup issue.',
        filePath: input.filePath,
      }
      return {
        data: output,
      }
    }

    // 将 operation 名称映射为 LSP 协议方法和参数
    const { method, params } = getMethodAndParams(input, absolutePath)

    try {
      // 确保目标文件已在 LSP 服务器中打开（大多数 LSP 服务器要求先 didOpen）
      // 仅在文件未打开时执行 I/O，避免重复读取
      if (!manager.isFileOpen(absolutePath)) {
        const handle = await open(absolutePath, 'r')
        try {
          const stats = await handle.stat()
          // 超过 10MB 的文件跳过 LSP 分析，防止内存溢出
          if (stats.size > MAX_LSP_FILE_SIZE_BYTES) {
            const output: Output = {
              operation: input.operation,
              result: `File too large for LSP analysis (${Math.ceil(stats.size / 1_000_000)}MB exceeds 10MB limit)`,
              filePath: input.filePath,
            }
            return { data: output }
          }
          const fileContent = await handle.readFile({ encoding: 'utf-8' })
          await manager.openFile(absolutePath, fileContent)
        } finally {
          await handle.close()
        }
      }

      // 向 LSP 服务器发送请求
      let result = await manager.sendRequest(absolutePath, method, params)

      if (result === undefined) {
        // 记录调试信息，跟踪使用模式和潜在问题
        logForDebugging(
          `No LSP server available for file type ${path.extname(absolutePath)} for operation ${input.operation} on file ${input.filePath}`,
        )

        const output: Output = {
          operation: input.operation,
          result: `No LSP server available for file type: ${path.extname(absolutePath)}`,
          filePath: input.filePath,
        }
        return {
          data: output,
        }
      }

      // incomingCalls/outgoingCalls 需要两步协议：
      // 1. 先通过 prepareCallHierarchy 获取 CallHierarchyItem[]
      // 2. 再用获取到的 item 发送实际的调用层次请求
      if (
        input.operation === 'incomingCalls' ||
        input.operation === 'outgoingCalls'
      ) {
        const callItems = result as CallHierarchyItem[]
        if (!callItems || callItems.length === 0) {
          const output: Output = {
            operation: input.operation,
            result: 'No call hierarchy item found at this position',
            filePath: input.filePath,
            resultCount: 0,
            fileCount: 0,
          }
          return { data: output }
        }

        // 使用第一个调用层次条目请求实际的调用关系
        const callMethod =
          input.operation === 'incomingCalls'
            ? 'callHierarchy/incomingCalls'
            : 'callHierarchy/outgoingCalls'

        result = await manager.sendRequest(absolutePath, callMethod, {
          item: callItems[0],
        })

        if (result === undefined) {
          logForDebugging(
            `LSP server returned undefined for ${callMethod} on ${input.filePath}`,
          )
          // 继续传递给格式化器，formatters 可优雅处理 null/undefined
        }
      }

      // 对位置类操作结果过滤掉被 gitignore 的文件
      if (
        result &&
        Array.isArray(result) &&
        (input.operation === 'findReferences' ||
          input.operation === 'goToDefinition' ||
          input.operation === 'goToImplementation' ||
          input.operation === 'workspaceSymbol')
      ) {
        if (input.operation === 'workspaceSymbol') {
          // SymbolInformation 的位置信息在 location.uri 字段
          const symbols = result as SymbolInformation[]
          const locations = symbols
            .filter(s => s?.location?.uri)
            .map(s => s.location)
          const filteredLocations = await filterGitIgnoredLocations(
            locations,
            cwd,
          )
          const filteredUris = new Set(filteredLocations.map(l => l.uri))
          result = symbols.filter(
            s => !s?.location?.uri || filteredUris.has(s.location.uri),
          )
        } else {
          // Location[] 或 (Location | LocationLink)[] — 统一转换为 Location 后过滤
          const locations = (result as (Location | LocationLink)[]).map(
            toLocation,
          )
          const filteredLocations = await filterGitIgnoredLocations(
            locations,
            cwd,
          )
          const filteredUris = new Set(filteredLocations.map(l => l.uri))
          result = (result as (Location | LocationLink)[]).filter(item => {
            const loc = toLocation(item)
            return !loc.uri || filteredUris.has(loc.uri)
          })
        }
      }

      // 根据操作类型格式化结果，并提取摘要计数
      const { formatted, resultCount, fileCount } = formatResult(
        input.operation,
        result,
        cwd,
      )

      const output: Output = {
        operation: input.operation,
        result: formatted,
        filePath: input.filePath,
        resultCount,
        fileCount,
      }

      return {
        data: output,
      }
    } catch (error) {
      const err = toError(error)
      const errorMessage = err.message

      // 记录错误，便于追踪
      logError(
        new Error(
          `LSP tool request failed for ${input.operation} on ${input.filePath}: ${errorMessage}`,
        ),
      )

      const output: Output = {
        operation: input.operation,
        result: `Error performing ${input.operation}: ${errorMessage}`,
        filePath: input.filePath,
      }
      return {
        data: output,
      }
    }
  },
  /**
   * 将工具结果映射为 Anthropic API 的 tool_result 消息格式。
   * LSP 结果已经是格式化字符串，直接作为 content 返回。
   */
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: output.result,
    }
  },
} satisfies ToolDef<InputSchema, Output>)

/**
 * 将 LSPTool 的 operation 名称映射为 LSP 协议方法和参数。
 *
 * 坐标转换：用户输入 1-based（line/character），LSP 协议使用 0-based。
 *
 * 特殊处理：incomingCalls/outgoingCalls 第一步都映射到
 * `textDocument/prepareCallHierarchy`，因为需要先获取 CallHierarchyItem。
 * 第二步在 call() 中完成。
 *
 * @param input - 工具输入（含 operation, filePath, line, character）
 * @param absolutePath - 目标文件的绝对路径
 * @returns LSP 请求方法名和参数对象
 */
function getMethodAndParams(
  input: Input,
  absolutePath: string,
): { method: string; params: unknown } {
  const uri = pathToFileURL(absolutePath).href
  // 将坐标从 1-based（用户友好）转换为 0-based（LSP 协议要求）
  const position = {
    line: input.line - 1,
    character: input.character - 1,
  }

  switch (input.operation) {
    case 'goToDefinition':
      return {
        method: 'textDocument/definition',
        params: {
          textDocument: { uri },
          position,
        },
      }
    case 'findReferences':
      return {
        method: 'textDocument/references',
        params: {
          textDocument: { uri },
          position,
          context: { includeDeclaration: true },  // 包含声明位置
        },
      }
    case 'hover':
      return {
        method: 'textDocument/hover',
        params: {
          textDocument: { uri },
          position,
        },
      }
    case 'documentSymbol':
      return {
        method: 'textDocument/documentSymbol',
        params: {
          textDocument: { uri },
        },
      }
    case 'workspaceSymbol':
      return {
        method: 'workspace/symbol',
        params: {
          query: '', // 空查询返回所有符号
        },
      }
    case 'goToImplementation':
      return {
        method: 'textDocument/implementation',
        params: {
          textDocument: { uri },
          position,
        },
      }
    case 'prepareCallHierarchy':
      return {
        method: 'textDocument/prepareCallHierarchy',
        params: {
          textDocument: { uri },
          position,
        },
      }
    case 'incomingCalls':
      // incomingCalls/outgoingCalls 需要先调用 prepareCallHierarchy 获取 CallHierarchyItem
      // 第二步请求在 call() 中完成
      return {
        method: 'textDocument/prepareCallHierarchy',
        params: {
          textDocument: { uri },
          position,
        },
      }
    case 'outgoingCalls':
      return {
        method: 'textDocument/prepareCallHierarchy',
        params: {
          textDocument: { uri },
          position,
        },
      }
  }
}

/**
 * 递归统计 DocumentSymbol 树中的符号总数（含嵌套子符号）。
 *
 * DocumentSymbol 格式支持树状嵌套结构（如类 → 方法 → 局部变量），
 * 需要递归统计所有层级的符号数量。
 *
 * @param symbols - 顶层符号数组
 * @returns 总符号数（含所有嵌套子符号）
 */
function countSymbols(symbols: DocumentSymbol[]): number {
  let count = symbols.length
  for (const symbol of symbols) {
    if (symbol.children && symbol.children.length > 0) {
      count += countSymbols(symbol.children)
    }
  }
  return count
}

/**
 * 统计位置数组中涉及的唯一文件数（通过 URI 去重）。
 *
 * @param locations - Location 数组
 * @returns 唯一文件（URI）数量
 */
function countUniqueFiles(locations: Location[]): number {
  return new Set(locations.map(loc => loc.uri)).size
}

/**
 * 将 file:// URI 转换为本地文件路径（含 URL 解码）。
 *
 * 处理步骤：
 * 1. 移除 file:// 前缀
 * 2. Windows 驱动器路径修正（/C:/path → C:/path）
 * 3. URI 解码百分号编码字符（如 %20 → 空格）
 *
 * @param uri - file:// 格式的 URI
 * @returns 本地文件系统路径
 */
function uriToFilePath(uri: string): string {
  let filePath = uri.replace(/^file:\/\//, '')
  // Windows 路径：file:///C:/path 解析后为 /C:/path，需去掉前导斜杠
  if (/^\/[A-Za-z]:/.test(filePath)) {
    filePath = filePath.slice(1)
  }
  try {
    filePath = decodeURIComponent(filePath)
  } catch {
    // 解码失败时使用未解码的路径（路径中含非法 URI 字符）
  }
  return filePath
}

/**
 * 过滤掉被 gitignore 的位置（文件路径）。
 *
 * 使用 `git check-ignore` 批量检查路径是否被 gitignore，
 * 批次大小为 50，避免参数列表过长。
 *
 * 退出码说明：
 * - 0：至少一个路径被 gitignore
 * - 1：没有路径被 gitignore
 * - 128：不在 git 仓库中（直接返回原始列表）
 *
 * @param locations - 待过滤的位置数组（泛型 T extends Location）
 * @param cwd - 工作目录（用于 git 命令）
 * @returns 过滤后的位置数组（移除被 gitignore 的条目）
 */
async function filterGitIgnoredLocations<T extends Location>(
  locations: T[],
  cwd: string,
): Promise<T[]> {
  if (locations.length === 0) {
    return locations
  }

  // 收集所有唯一的文件路径（从 URI 转换而来）
  const uriToPath = new Map<string, string>()
  for (const loc of locations) {
    if (loc.uri && !uriToPath.has(loc.uri)) {
      uriToPath.set(loc.uri, uriToFilePath(loc.uri))
    }
  }

  const uniquePaths = uniq(uriToPath.values())
  if (uniquePaths.length === 0) {
    return locations
  }

  // 分批调用 git check-ignore 检查路径是否被 gitignore
  // 批次大小为 50，避免命令行参数过长
  const ignoredPaths = new Set<string>()
  const BATCH_SIZE = 50
  for (let i = 0; i < uniquePaths.length; i += BATCH_SIZE) {
    const batch = uniquePaths.slice(i, i + BATCH_SIZE)
    const result = await execFileNoThrowWithCwd(
      'git',
      ['check-ignore', ...batch],
      {
        cwd,
        preserveOutputOnError: false,
        timeout: 5_000,  // 5 秒超时，避免阻塞
      },
    )

    // 退出码 0：stdout 中的路径均被 gitignore，逐行收集
    if (result.code === 0 && result.stdout) {
      for (const line of result.stdout.split('\n')) {
        const trimmed = line.trim()
        if (trimmed) {
          ignoredPaths.add(trimmed)
        }
      }
    }
  }

  // 无被 gitignore 的路径时直接返回原始列表（快速路径）
  if (ignoredPaths.size === 0) {
    return locations
  }

  // 过滤掉文件路径在 ignoredPaths 集合中的位置条目
  return locations.filter(loc => {
    const filePath = uriToPath.get(loc.uri)
    return !filePath || !ignoredPaths.has(filePath)
  })
}

/**
 * 类型守卫：判断 item 是 LocationLink（有 targetUri）还是 Location（有 uri）。
 *
 * @param item - Location 或 LocationLink
 * @returns true 表示是 LocationLink
 */
function isLocationLink(item: Location | LocationLink): item is LocationLink {
  return 'targetUri' in item
}

/**
 * 将 LocationLink 或 Location 统一转换为 Location 格式，便于后续统一处理。
 *
 * LocationLink 有 targetUri/targetRange/targetSelectionRange，
 * Location 有 uri/range，转换时优先使用 targetSelectionRange（更精确的选区范围）。
 *
 * @param item - Location 或 LocationLink
 * @returns 统一的 Location 格式
 */
function toLocation(item: Location | LocationLink): Location {
  if (isLocationLink(item)) {
    return {
      uri: item.targetUri,
      range: item.targetSelectionRange || item.targetRange,
    }
  }
  return item
}

/**
 * 根据操作类型格式化 LSP 结果，并提取摘要计数信息。
 *
 * 针对每种操作调用对应的格式化函数（来自 formatters.ts），
 * 同时统计 resultCount（结果数）和 fileCount（涉及文件数）。
 *
 * 特殊处理：
 * - goToDefinition/goToImplementation：先统一转换为 Location[]，再统计
 * - documentSymbol：检测格式（DocumentSymbol 有 'range'，SymbolInformation 有 'location'），
 *   DocumentSymbol 需递归统计子符号
 * - workspaceSymbol：过滤无效 URI 的符号后再统计
 * - 无效 URI 的位置/符号记录 logError 警告
 *
 * @param operation - LSP 操作名称
 * @param result - LSP 服务器返回的原始结果
 * @param cwd - 当前工作目录（用于路径相对化）
 * @returns 格式化字符串和计数对象
 */
function formatResult(
  operation: Input['operation'],
  result: unknown,
  cwd: string,
): { formatted: string; resultCount: number; fileCount: number } {
  switch (operation) {
    case 'goToDefinition': {
      // 统一处理 Location 和 LocationLink 两种格式
      const rawResults = Array.isArray(result)
        ? result
        : result
          ? [result as Location | LocationLink]
          : []

      // 转换为 Location 格式，便于统一统计
      const locations = rawResults.map(toLocation)

      // 记录并过滤 URI 为 undefined 的无效位置（LSP 服务器数据异常）
      const invalidLocations = locations.filter(loc => !loc || !loc.uri)
      if (invalidLocations.length > 0) {
        logError(
          new Error(
            `LSP server returned ${invalidLocations.length} location(s) with undefined URI for goToDefinition on ${cwd}. ` +
              `This indicates malformed data from the LSP server.`,
          ),
        )
      }

      const validLocations = locations.filter(loc => loc && loc.uri)
      return {
        formatted: formatGoToDefinitionResult(
          result as
            | Location
            | Location[]
            | LocationLink
            | LocationLink[]
            | null,
          cwd,
        ),
        resultCount: validLocations.length,
        fileCount: countUniqueFiles(validLocations),
      }
    }
    case 'findReferences': {
      const locations = (result as Location[]) || []

      // 记录并过滤 URI 为 undefined 的无效位置
      const invalidLocations = locations.filter(loc => !loc || !loc.uri)
      if (invalidLocations.length > 0) {
        logError(
          new Error(
            `LSP server returned ${invalidLocations.length} location(s) with undefined URI for findReferences on ${cwd}. ` +
              `This indicates malformed data from the LSP server.`,
          ),
        )
      }

      const validLocations = locations.filter(loc => loc && loc.uri)
      return {
        formatted: formatFindReferencesResult(result as Location[] | null, cwd),
        resultCount: validLocations.length,
        fileCount: countUniqueFiles(validLocations),
      }
    }
    case 'hover': {
      return {
        formatted: formatHoverResult(result as Hover | null, cwd),
        // hover 结果有内容时计为 1 个结果
        resultCount: result ? 1 : 0,
        fileCount: result ? 1 : 0,
      }
    }
    case 'documentSymbol': {
      // LSP 允许 documentSymbol 返回 DocumentSymbol[] 或 SymbolInformation[] 两种格式
      const symbols = (result as (DocumentSymbol | SymbolInformation)[]) || []
      // 格式检测：DocumentSymbol 有 'range' 字段，SymbolInformation 有 'location' 字段
      const isDocumentSymbol =
        symbols.length > 0 && symbols[0] && 'range' in symbols[0]
      // DocumentSymbol 支持树状嵌套，需递归统计；SymbolInformation 是扁平列表
      const count = isDocumentSymbol
        ? countSymbols(symbols as DocumentSymbol[])
        : symbols.length
      return {
        formatted: formatDocumentSymbolResult(
          result as (DocumentSymbol[] | SymbolInformation[]) | null,
          cwd,
        ),
        resultCount: count,
        // documentSymbol 结果来自单个文件
        fileCount: symbols.length > 0 ? 1 : 0,
      }
    }
    case 'workspaceSymbol': {
      const symbols = (result as SymbolInformation[]) || []

      // 记录并过滤 location.uri 为 undefined 的无效符号（LSP 服务器数据异常）
      const invalidSymbols = symbols.filter(
        sym => !sym || !sym.location || !sym.location.uri,
      )
      if (invalidSymbols.length > 0) {
        logError(
          new Error(
            `LSP server returned ${invalidSymbols.length} symbol(s) with undefined location URI for workspaceSymbol on ${cwd}. ` +
              `This indicates malformed data from the LSP server.`,
          ),
        )
      }

      const validSymbols = symbols.filter(
        sym => sym && sym.location && sym.location.uri,
      )
      const locations = validSymbols.map(s => s.location)
      return {
        formatted: formatWorkspaceSymbolResult(
          result as SymbolInformation[] | null,
          cwd,
        ),
        resultCount: validSymbols.length,
        fileCount: countUniqueFiles(locations),
      }
    }
    case 'goToImplementation': {
      // goToImplementation 格式与 goToDefinition 相同，复用相同处理逻辑
      const rawResults = Array.isArray(result)
        ? result
        : result
          ? [result as Location | LocationLink]
          : []

      const locations = rawResults.map(toLocation)

      // 记录并过滤 URI 为 undefined 的无效位置
      const invalidLocations = locations.filter(loc => !loc || !loc.uri)
      if (invalidLocations.length > 0) {
        logError(
          new Error(
            `LSP server returned ${invalidLocations.length} location(s) with undefined URI for goToImplementation on ${cwd}. ` +
              `This indicates malformed data from the LSP server.`,
          ),
        )
      }

      const validLocations = locations.filter(loc => loc && loc.uri)
      return {
        // 复用 goToDefinition 格式化器（结果格式完全相同）
        formatted: formatGoToDefinitionResult(
          result as
            | Location
            | Location[]
            | LocationLink
            | LocationLink[]
            | null,
          cwd,
        ),
        resultCount: validLocations.length,
        fileCount: countUniqueFiles(validLocations),
      }
    }
    case 'prepareCallHierarchy': {
      const items = (result as CallHierarchyItem[]) || []
      return {
        formatted: formatPrepareCallHierarchyResult(
          result as CallHierarchyItem[] | null,
          cwd,
        ),
        resultCount: items.length,
        fileCount: items.length > 0 ? countUniqueFilesFromCallItems(items) : 0,
      }
    }
    case 'incomingCalls': {
      const calls = (result as CallHierarchyIncomingCall[]) || []
      return {
        formatted: formatIncomingCallsResult(
          result as CallHierarchyIncomingCall[] | null,
          cwd,
        ),
        resultCount: calls.length,
        fileCount:
          calls.length > 0 ? countUniqueFilesFromIncomingCalls(calls) : 0,
      }
    }
    case 'outgoingCalls': {
      const calls = (result as CallHierarchyOutgoingCall[]) || []
      return {
        formatted: formatOutgoingCallsResult(
          result as CallHierarchyOutgoingCall[] | null,
          cwd,
        ),
        resultCount: calls.length,
        fileCount:
          calls.length > 0 ? countUniqueFilesFromOutgoingCalls(calls) : 0,
      }
    }
  }
}

/**
 * 统计 CallHierarchyItem 数组中涉及的唯一文件数。
 * 过滤 URI 为 undefined 的无效条目后去重统计。
 *
 * @param items - CallHierarchyItem 数组
 * @returns 唯一文件（URI）数量
 */
function countUniqueFilesFromCallItems(items: CallHierarchyItem[]): number {
  const validUris = items.map(item => item.uri).filter(uri => uri)
  return new Set(validUris).size
}

/**
 * 统计 CallHierarchyIncomingCall 数组中涉及的唯一文件数（来自 call.from.uri）。
 * 过滤无效 URI 后去重统计。
 *
 * @param calls - CallHierarchyIncomingCall 数组
 * @returns 唯一文件（URI）数量
 */
function countUniqueFilesFromIncomingCalls(
  calls: CallHierarchyIncomingCall[],
): number {
  const validUris = calls.map(call => call.from?.uri).filter(uri => uri)
  return new Set(validUris).size
}

/**
 * 统计 CallHierarchyOutgoingCall 数组中涉及的唯一文件数（来自 call.to.uri）。
 * 过滤无效 URI 后去重统计。
 *
 * @param calls - CallHierarchyOutgoingCall 数组
 * @returns 唯一文件（URI）数量
 */
function countUniqueFilesFromOutgoingCalls(
  calls: CallHierarchyOutgoingCall[],
): number {
  const validUris = calls.map(call => call.to?.uri).filter(uri => uri)
  return new Set(validUris).size
}
