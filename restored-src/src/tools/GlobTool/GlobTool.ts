/**
 * GlobTool.ts — 文件名模式匹配工具实现
 *
 * 【在 Claude Code 系统中的位置】
 * 本文件实现了 Claude Code 的 Glob 文件搜索工具，工具名称为 "Glob"。
 * 它与 GrepTool（内容搜索）、FileReadTool（文件读取）并列，为模型提供按文件名模式
 * 快速定位文件的能力。GlobTool 是只读工具（isReadOnly=true），支持并发调用（isConcurrencySafe=true）。
 *
 * 【主要功能】
 * 1. 输入验证（validateInput）：
 *    - 若提供了 path 参数，验证路径存在且为目录
 *    - 跳过 UNC 路径的文件系统操作（NTLM 安全）
 *    - 路径不存在时生成友好错误信息，含 CWD 提示和路径猜测
 * 2. 权限检查（checkPermissions）：调用 checkReadPermissionForTool 验证读取权限
 * 3. 执行（call）：
 *    - 调用 glob() 工具函数，支持 globLimits.maxResults（默认 100）
 *    - 将绝对路径转换为相对路径（节省 token）
 *    - 返回 { filenames, durationMs, numFiles, truncated }
 * 4. 结果映射（mapToolResultToToolResultBlockParam）：
 *    - 无匹配时返回 "No files found"
 *    - 有匹配时返回换行连接的文件名列表，超限时附加截断提示
 */

import { z } from 'zod/v4'
import type { ValidationResult } from '../../Tool.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { getCwd } from '../../utils/cwd.js'
import { isENOENT } from '../../utils/errors.js'
import {
  FILE_NOT_FOUND_CWD_NOTE,
  suggestPathUnderCwd,
} from '../../utils/file.js'
import { getFsImplementation } from '../../utils/fsOperations.js'
import { glob } from '../../utils/glob.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { expandPath, toRelativePath } from '../../utils/path.js'
import { checkReadPermissionForTool } from '../../utils/permissions/filesystem.js'
import type { PermissionDecision } from '../../utils/permissions/PermissionResult.js'
import { matchWildcardPattern } from '../../utils/permissions/shellRuleMatching.js'
import { DESCRIPTION, GLOB_TOOL_NAME } from './prompt.js'
import {
  getToolUseSummary,
  renderToolResultMessage,
  renderToolUseErrorMessage,
  renderToolUseMessage,
  userFacingName,
} from './UI.js'

/**
 * 输入 Schema（懒加载）：
 * - pattern：glob 匹配模式（必填），如 "**\/*.ts"
 * - path：搜索目录（可选，默认为 cwd）
 */
const inputSchema = lazySchema(() =>
  z.strictObject({
    pattern: z.string().describe('The glob pattern to match files against'),
    path: z
      .string()
      .optional()
      .describe(
        'The directory to search in. If not specified, the current working directory will be used. IMPORTANT: Omit this field to use the default directory. DO NOT enter "undefined" or "null" - simply omit it for the default behavior. Must be a valid directory path if provided.',
      ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

/**
 * 输出 Schema（懒加载）：
 * - durationMs：搜索耗时（毫秒）
 * - numFiles：匹配到的文件总数
 * - filenames：匹配文件路径数组（相对路径）
 * - truncated：结果是否被截断（超出 maxResults 限制）
 */
const outputSchema = lazySchema(() =>
  z.object({
    durationMs: z
      .number()
      .describe('Time taken to execute the search in milliseconds'),
    numFiles: z.number().describe('Total number of files found'),
    filenames: z
      .array(z.string())
      .describe('Array of file paths that match the pattern'),
    truncated: z
      .boolean()
      .describe('Whether results were truncated (limited to 100 files)'),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.infer<OutputSchema>

/**
 * GlobTool 工具定义。
 *
 * 通过 buildTool() 构建后注册到 Claude Code 工具系统，
 * 模型可通过名称 "Glob" 调用本工具按文件名模式查找文件。
 */
export const GlobTool = buildTool({
  name: GLOB_TOOL_NAME,
  searchHint: 'find files by name pattern or wildcard',
  maxResultSizeChars: 100_000,
  async description() {
    return DESCRIPTION
  },
  userFacingName,
  getToolUseSummary,
  /** 生成活动描述，用于 UI 进度显示 */
  getActivityDescription(input) {
    const summary = getToolUseSummary(input)
    return summary ? `Finding ${summary}` : 'Finding files'
  },
  /** 懒加载输入 Schema */
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  /** 懒加载输出 Schema */
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  /** 支持并发：Glob 为只读操作，可与其他工具同时运行 */
  isConcurrencySafe() {
    return true
  },
  /** 只读工具：不修改文件系统 */
  isReadOnly() {
    return true
  },
  /** 供自动分类器使用：直接返回 glob 模式字符串 */
  toAutoClassifierInput(input) {
    return input.pattern
  },
  /** 标记为搜索类命令，UI 可据此折叠结果 */
  isSearchOrReadCommand() {
    return { isSearch: true, isRead: false }
  },
  /** 返回搜索根目录（提供 path 则展开，否则使用 cwd） */
  getPath({ path }): string {
    return path ? expandPath(path) : getCwd()
  },
  /** 返回通配符匹配函数，供权限系统对 pattern 做规则匹配 */
  async preparePermissionMatcher({ pattern }) {
    return rulePattern => matchWildcardPattern(rulePattern, pattern)
  },
  /**
   * 输入验证：若提供 path，验证路径存在且为目录。
   * UNC 路径直接跳过（防止 NTLM 凭证泄露）。
   */
  async validateInput({ path }): Promise<ValidationResult> {
    // 如果提供了 path，验证其存在且为目录
    if (path) {
      const fs = getFsImplementation()
      const absolutePath = expandPath(path)

      // SECURITY: Skip filesystem operations for UNC paths to prevent NTLM credential leaks.
      // UNC 路径安全跳过，防止 Windows NTLM 凭证泄露
      if (absolutePath.startsWith('\\\\') || absolutePath.startsWith('//')) {
        return { result: true }
      }

      let stats
      try {
        stats = await fs.stat(absolutePath)
      } catch (e: unknown) {
        if (isENOENT(e)) {
          // 路径不存在：生成友好错误信息，含 CWD 提示和路径猜测
          const cwdSuggestion = await suggestPathUnderCwd(absolutePath)
          let message = `Directory does not exist: ${path}. ${FILE_NOT_FOUND_CWD_NOTE} ${getCwd()}.`
          if (cwdSuggestion) {
            message += ` Did you mean ${cwdSuggestion}?`
          }
          return {
            result: false,
            message,
            errorCode: 1,
          }
        }
        throw e
      }

      // 路径存在但不是目录
      if (!stats.isDirectory()) {
        return {
          result: false,
          message: `Path is not a directory: ${path}`,
          errorCode: 2,
        }
      }
    }

    return { result: true }
  },
  /**
   * 权限检查：调用 checkReadPermissionForTool 验证是否允许读取目标路径。
   */
  async checkPermissions(input, context): Promise<PermissionDecision> {
    const appState = context.getAppState()
    return checkReadPermissionForTool(
      GlobTool,
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
  // Reuses Grep's render (UI.tsx:65) — shows filenames.join. durationMs/
  // numFiles are "Found 3 files in 12ms" chrome (under-count, fine).
  /** 提取搜索文本（用于摘要索引）：将文件名列表换行连接 */
  extractSearchText({ filenames }) {
    return filenames.join('\n')
  },
  /**
   * 执行 glob 搜索。
   *
   * 流程：
   * 1. 记录开始时间
   * 2. 获取结果上限（globLimits?.maxResults，默认 100）
   * 3. 调用 glob() 执行模式匹配，传入 abortSignal 支持取消
   * 4. 将绝对路径转为相对路径（节省 token）
   * 5. 返回结果对象
   */
  async call(input, { abortController, getAppState, globLimits }) {
    const start = Date.now()
    const appState = getAppState()
    // 获取最大结果数，若未配置则默认 100
    const limit = globLimits?.maxResults ?? 100
    const { files, truncated } = await glob(
      input.pattern,
      GlobTool.getPath(input),
      { limit, offset: 0 },
      abortController.signal,
      appState.toolPermissionContext,
    )
    // 将绝对路径转为相对路径，节省传回给模型的 token 消耗（与 GrepTool 行为一致）
    const filenames = files.map(toRelativePath)
    const output: Output = {
      filenames,
      durationMs: Date.now() - start,
      numFiles: filenames.length,
      truncated,
    }
    return {
      data: output,
    }
  },
  /**
   * 将工具结果映射为 Anthropic API 的 tool_result 消息格式。
   * - 无匹配文件：返回 "No files found"
   * - 有匹配：返回换行连接的文件名列表，若结果被截断则附加提示
   */
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    if (output.filenames.length === 0) {
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content: 'No files found',
      }
    }
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: [
        ...output.filenames,
        ...(output.truncated
          ? [
              '(Results are truncated. Consider using a more specific path or pattern.)',
            ]
          : []),
      ].join('\n'),
    }
  },
} satisfies ToolDef<InputSchema, Output>)
