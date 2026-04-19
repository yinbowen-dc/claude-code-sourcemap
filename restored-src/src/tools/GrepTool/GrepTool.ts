/**
 * GrepTool.ts — 文件内容正则搜索工具实现（基于 ripgrep）
 *
 * 【在 Claude Code 系统中的位置】
 * 本文件实现了 Claude Code 的 Grep 内容搜索工具，工具名称为 "Grep"。
 * 它底层调用 ripgrep（rg）提供高性能的正则表达式搜索，与 GlobTool（文件名搜索）、
 * FileReadTool（文件读取）共同构成文件查找与浏览体系。
 * GrepTool 是只读工具（isReadOnly=true），支持并发调用（isConcurrencySafe=true）。
 *
 * 【主要功能】
 * 1. 丰富的输入选项：
 *    - pattern：正则表达式（必填）
 *    - path：搜索路径（可选，默认 cwd）
 *    - glob：文件名过滤模式（可选，映射到 rg --glob）
 *    - output_mode：输出模式（'content'|'files_with_matches'|'count'，默认 files_with_matches）
 *    - -B/-A/-C/context：上下文行数（仅 content 模式）
 *    - -n：显示行号（content 模式默认 true）
 *    - -i：大小写不敏感
 *    - type：文件类型过滤（映射到 rg --type）
 *    - head_limit/offset：分页控制（默认限制 250 行）
 *    - multiline：跨行匹配模式
 * 2. 自动排除版本控制目录（.git/.svn/.hg/.bzr/.jj/.sl）
 * 3. 应用 getFileReadIgnorePatterns 忽略规则和孤儿插件缓存排除
 * 4. 三种输出模式的分别处理与路径相对化
 * 5. files_with_matches 模式下按 mtime 降序排列结果（最近修改优先）
 * 6. applyHeadLimit() 实现 head_limit/offset 分页，limit=0 为无限制逃生出口
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
import { lazySchema } from '../../utils/lazySchema.js'
import { expandPath, toRelativePath } from '../../utils/path.js'
import {
  checkReadPermissionForTool,
  getFileReadIgnorePatterns,
  normalizePatternsToPath,
} from '../../utils/permissions/filesystem.js'
import type { PermissionDecision } from '../../utils/permissions/PermissionResult.js'
import { matchWildcardPattern } from '../../utils/permissions/shellRuleMatching.js'
import { getGlobExclusionsForPluginCache } from '../../utils/plugins/orphanedPluginFilter.js'
import { ripGrep } from '../../utils/ripgrep.js'
import { semanticBoolean } from '../../utils/semanticBoolean.js'
import { semanticNumber } from '../../utils/semanticNumber.js'
import { plural } from '../../utils/stringUtils.js'
import { GREP_TOOL_NAME, getDescription } from './prompt.js'
import {
  getToolUseSummary,
  renderToolResultMessage,
  renderToolUseErrorMessage,
  renderToolUseMessage,
} from './UI.js'

/**
 * 输入 Schema（懒加载）：完整的 ripgrep 参数映射。
 * 使用 semanticNumber/semanticBoolean 包装数值和布尔字段，
 * 支持模型以字符串形式传入（如 "true"、"3"）时的自动类型转换。
 */
const inputSchema = lazySchema(() =>
  z.strictObject({
    pattern: z
      .string()
      .describe(
        'The regular expression pattern to search for in file contents',
      ),
    path: z
      .string()
      .optional()
      .describe(
        'File or directory to search in (rg PATH). Defaults to current working directory.',
      ),
    glob: z
      .string()
      .optional()
      .describe(
        'Glob pattern to filter files (e.g. "*.js", "*.{ts,tsx}") - maps to rg --glob',
      ),
    output_mode: z
      .enum(['content', 'files_with_matches', 'count'])
      .optional()
      .describe(
        'Output mode: "content" shows matching lines (supports -A/-B/-C context, -n line numbers, head_limit), "files_with_matches" shows file paths (supports head_limit), "count" shows match counts (supports head_limit). Defaults to "files_with_matches".',
      ),
    '-B': semanticNumber(z.number().optional()).describe(
      'Number of lines to show before each match (rg -B). Requires output_mode: "content", ignored otherwise.',
    ),
    '-A': semanticNumber(z.number().optional()).describe(
      'Number of lines to show after each match (rg -A). Requires output_mode: "content", ignored otherwise.',
    ),
    '-C': semanticNumber(z.number().optional()).describe('Alias for context.'),
    context: semanticNumber(z.number().optional()).describe(
      'Number of lines to show before and after each match (rg -C). Requires output_mode: "content", ignored otherwise.',
    ),
    '-n': semanticBoolean(z.boolean().optional()).describe(
      'Show line numbers in output (rg -n). Requires output_mode: "content", ignored otherwise. Defaults to true.',
    ),
    '-i': semanticBoolean(z.boolean().optional()).describe(
      'Case insensitive search (rg -i)',
    ),
    type: z
      .string()
      .optional()
      .describe(
        'File type to search (rg --type). Common types: js, py, rust, go, java, etc. More efficient than include for standard file types.',
      ),
    head_limit: semanticNumber(z.number().optional()).describe(
      'Limit output to first N lines/entries, equivalent to "| head -N". Works across all output modes: content (limits output lines), files_with_matches (limits file paths), count (limits count entries). Defaults to 250 when unspecified. Pass 0 for unlimited (use sparingly — large result sets waste context).',
    ),
    offset: semanticNumber(z.number().optional()).describe(
      'Skip first N lines/entries before applying head_limit, equivalent to "| tail -n +N | head -N". Works across all output modes. Defaults to 0.',
    ),
    multiline: semanticBoolean(z.boolean().optional()).describe(
      'Enable multiline mode where . matches newlines and patterns can span lines (rg -U --multiline-dotall). Default: false.',
    ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

// Version control system directories to exclude from searches
// These are excluded automatically because they create noise in search results
/**
 * 自动排除的版本控制目录列表。
 * 搜索时默认添加 `--glob !<dir>` 参数，避免版本控制元数据污染结果。
 */
const VCS_DIRECTORIES_TO_EXCLUDE = [
  '.git',   // Git
  '.svn',   // Subversion
  '.hg',    // Mercurial
  '.bzr',   // Bazaar
  '.jj',    // Jujutsu
  '.sl',    // Sapling
] as const

// Default cap on grep results when head_limit is unspecified. Unbounded content-mode
// greps can fill up to the 20KB persist threshold (~6-24K tokens/grep-heavy session).
// 250 is generous enough for exploratory searches while preventing context bloat.
// Pass head_limit=0 explicitly for unlimited.
/**
 * 当 head_limit 未指定时的默认结果行数上限。
 * 250 行足够探索性搜索，同时避免无边界的 content 模式搜索塞满 context 窗口。
 * 传入 head_limit=0 可明确要求无限制（慎用）。
 */
const DEFAULT_HEAD_LIMIT = 250

/**
 * 对结果列表应用 head_limit 和 offset 分页。
 *
 * 分页逻辑：
 * - limit=0：无限制逃生出口，跳过 offset 后返回全部
 * - 未指定 limit：使用 DEFAULT_HEAD_LIMIT（250）
 * - 指定 limit>0：从 offset 开始，最多取 limit 条
 * - 仅在实际发生截断时才设置 appliedLimit，以便模型感知分页
 *
 * @param items - 待分页的结果数组
 * @param limit - 用户指定的上限（undefined 使用默认值，0 为无限制）
 * @param offset - 跳过的起始条目数（默认 0）
 * @returns { items: 分页后的结果, appliedLimit: 实际应用的上限（仅截断时设置）}
 */
function applyHeadLimit<T>(
  items: T[],
  limit: number | undefined,
  offset: number = 0,
): { items: T[]; appliedLimit: number | undefined } {
  // 显式传入 0 表示无限制
  if (limit === 0) {
    return { items: items.slice(offset), appliedLimit: undefined }
  }
  const effectiveLimit = limit ?? DEFAULT_HEAD_LIMIT
  const sliced = items.slice(offset, offset + effectiveLimit)
  // Only report appliedLimit when truncation actually occurred, so the model
  // knows there may be more results and can paginate with offset.
  // 仅在实际截断时才报告 appliedLimit，提示模型存在更多结果可以通过 offset 分页
  const wasTruncated = items.length - offset > effectiveLimit
  return {
    items: sliced,
    appliedLimit: wasTruncated ? effectiveLimit : undefined,
  }
}

// Format limit/offset information for display in tool results.
// appliedLimit is only set when truncation actually occurred (see applyHeadLimit),
// so it may be undefined even when appliedOffset is set — build parts conditionally
// to avoid "limit: undefined" appearing in user-visible output.
/**
 * 格式化分页信息为展示字符串（如 "limit: 250, offset: 500"）。
 * appliedLimit 仅在截断发生时有值（见 applyHeadLimit），条件构建避免显示 "limit: undefined"。
 *
 * @param appliedLimit - 实际应用的上限（仅截断时有值）
 * @param appliedOffset - 应用的偏移量
 * @returns 分页信息字符串，如 "limit: 250, offset: 500"，无分页时返回空字符串
 */
function formatLimitInfo(
  appliedLimit: number | undefined,
  appliedOffset: number | undefined,
): string {
  const parts: string[] = []
  if (appliedLimit !== undefined) parts.push(`limit: ${appliedLimit}`)
  if (appliedOffset) parts.push(`offset: ${appliedOffset}`)
  return parts.join(', ')
}

/**
 * 输出 Schema（懒加载）：描述三种输出模式的结果结构。
 * - mode：输出模式
 * - numFiles：匹配的文件数
 * - filenames：匹配的文件路径数组（相对路径）
 * - content：内容/计数模式下的原始输出文本
 * - numLines：content 模式下的行数
 * - numMatches：count 模式下的总匹配次数
 * - appliedLimit/appliedOffset：分页信息
 */
const outputSchema = lazySchema(() =>
  z.object({
    mode: z.enum(['content', 'files_with_matches', 'count']).optional(),
    numFiles: z.number(),
    filenames: z.array(z.string()),
    content: z.string().optional(),
    numLines: z.number().optional(), // For content mode
    numMatches: z.number().optional(), // For count mode
    appliedLimit: z.number().optional(), // The limit that was applied (if any)
    appliedOffset: z.number().optional(), // The offset that was applied
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

type Output = z.infer<OutputSchema>

/**
 * GrepTool 工具定义。
 *
 * 通过 buildTool() 构建后注册到 Claude Code 工具系统，
 * 模型可通过名称 "Grep" 调用本工具使用正则表达式搜索文件内容。
 */
export const GrepTool = buildTool({
  name: GREP_TOOL_NAME,
  searchHint: 'search file contents with regex (ripgrep)',
  // 20K chars - tool result persistence threshold
  // 20K 字符，对应工具结果持久化阈值
  maxResultSizeChars: 20_000,
  strict: true,
  async description() {
    return getDescription()
  },
  userFacingName() {
    return 'Search'
  },
  getToolUseSummary,
  /** 生成活动描述，用于 UI 进度显示 */
  getActivityDescription(input) {
    const summary = getToolUseSummary(input)
    return summary ? `Searching for ${summary}` : 'Searching'
  },
  /** 懒加载输入 Schema */
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  /** 懒加载输出 Schema */
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  /** 支持并发：Grep 为只读操作 */
  isConcurrencySafe() {
    return true
  },
  /** 只读工具：不修改文件系统 */
  isReadOnly() {
    return true
  },
  /** 供自动分类器使用：pattern + path 拼接 */
  toAutoClassifierInput(input) {
    return input.path ? `${input.pattern} in ${input.path}` : input.pattern
  },
  /** 标记为搜索类命令，UI 可据此折叠结果 */
  isSearchOrReadCommand() {
    return { isSearch: true, isRead: false }
  },
  /** 返回搜索路径（有 path 则使用，否则返回 cwd） */
  getPath({ path }): string {
    return path || getCwd()
  },
  /** 返回通配符匹配函数，供权限系统对 pattern 做规则匹配 */
  async preparePermissionMatcher({ pattern }) {
    return rulePattern => matchWildcardPattern(rulePattern, pattern)
  },
  /**
   * 输入验证：若提供 path，验证路径存在。
   * UNC 路径直接跳过（防止 NTLM 凭证泄露）。
   */
  async validateInput({ path }): Promise<ValidationResult> {
    // 如果提供了 path，验证其存在
    if (path) {
      const fs = getFsImplementation()
      const absolutePath = expandPath(path)

      // SECURITY: Skip filesystem operations for UNC paths to prevent NTLM credential leaks.
      // UNC 路径安全跳过
      if (absolutePath.startsWith('\\\\') || absolutePath.startsWith('//')) {
        return { result: true }
      }

      try {
        await fs.stat(absolutePath)
      } catch (e: unknown) {
        if (isENOENT(e)) {
          // 路径不存在：生成友好错误信息，含 CWD 提示和路径猜测
          const cwdSuggestion = await suggestPathUnderCwd(absolutePath)
          let message = `Path does not exist: ${path}. ${FILE_NOT_FOUND_CWD_NOTE} ${getCwd()}.`
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
    }

    return { result: true }
  },
  /**
   * 权限检查：调用 checkReadPermissionForTool 验证是否允许读取目标路径。
   */
  async checkPermissions(input, context): Promise<PermissionDecision> {
    const appState = context.getAppState()
    return checkReadPermissionForTool(
      GrepTool,
      input,
      appState.toolPermissionContext,
    )
  },
  async prompt() {
    return getDescription()
  },
  renderToolUseMessage,
  renderToolUseErrorMessage,
  renderToolResultMessage,
  // SearchResultSummary shows content (mode=content) or filenames.join.
  // numFiles/numLines/numMatches are chrome ("Found 3 files") — fine to
  // skip (under-count, not phantom). Glob reuses this via UI.tsx:65.
  /**
   * 提取搜索文本（用于摘要索引）：
   * - content 模式：返回原始内容行
   * - 其他模式：返回换行连接的文件名列表
   */
  extractSearchText({ mode, content, filenames }) {
    if (mode === 'content' && content) return content
    return filenames.join('\n')
  },
  /**
   * 将工具结果映射为 Anthropic API 的 tool_result 消息格式。
   *
   * 三种模式各有不同的格式化逻辑：
   * - content：附加分页信息，无匹配时显示 "No matches found"
   * - count：附加总匹配数和文件数统计
   * - files_with_matches（默认）：显示文件数和文件列表，附加分页信息
   */
  mapToolResultToToolResultBlockParam(
    {
      mode = 'files_with_matches',
      numFiles,
      filenames,
      content,
      numLines: _numLines,
      numMatches,
      appliedLimit,
      appliedOffset,
    },
    toolUseID,
  ) {
    if (mode === 'content') {
      // content 模式：显示匹配内容行，附加分页信息
      const limitInfo = formatLimitInfo(appliedLimit, appliedOffset)
      const resultContent = content || 'No matches found'
      const finalContent = limitInfo
        ? `${resultContent}\n\n[Showing results with pagination = ${limitInfo}]`
        : resultContent
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content: finalContent,
      }
    }

    if (mode === 'count') {
      // count 模式：显示每个文件的匹配次数，附加总计统计
      const limitInfo = formatLimitInfo(appliedLimit, appliedOffset)
      const rawContent = content || 'No matches found'
      const matches = numMatches ?? 0
      const files = numFiles ?? 0
      const summary = `\n\nFound ${matches} total ${matches === 1 ? 'occurrence' : 'occurrences'} across ${files} ${files === 1 ? 'file' : 'files'}.${limitInfo ? ` with pagination = ${limitInfo}` : ''}`
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content: rawContent + summary,
      }
    }

    // files_with_matches 模式（默认）：显示匹配文件数和文件列表
    const limitInfo = formatLimitInfo(appliedLimit, appliedOffset)
    if (numFiles === 0) {
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content: 'No files found',
      }
    }
    // head_limit 已在 call() 中应用，此处直接展示所有文件名
    const result = `Found ${numFiles} ${plural(numFiles, 'file')}${limitInfo ? ` ${limitInfo}` : ''}\n${filenames.join('\n')}`
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: result,
    }
  },
  /**
   * 执行 ripgrep 搜索的核心逻辑。
   *
   * 参数构建流程：
   * 1. 展开路径，添加 --hidden 显示隐藏文件
   * 2. 排除 VCS 目录（--glob !.git 等）
   * 3. 限制列宽（--max-columns 500，防止 base64/压缩内容塞满输出）
   * 4. 可选：跨行匹配（-U --multiline-dotall）
   * 5. 可选：大小写不敏感（-i）
   * 6. 输出模式标志（-l 文件列表 / -c 计数 / 默认内容）
   * 7. content 模式：行号（-n）、上下文行数（-C/-B/-A，-C/-context 优先）
   * 8. 以 -e 传递以 "-" 开头的模式（防止被解析为选项）
   * 9. 文件类型过滤（--type）
   * 10. glob 过滤（支持逗号/空格分隔，大括号模式不拆分）
   * 11. 应用 getFileReadIgnorePatterns 忽略规则
   * 12. 排除孤儿插件缓存目录
   * 13. 执行 ripGrep()，处理三种输出模式
   */
  async call(
    {
      pattern,
      path,
      glob,
      type,
      output_mode = 'files_with_matches',
      '-B': context_before,
      '-A': context_after,
      '-C': context_c,
      context,
      '-n': show_line_numbers = true,
      '-i': case_insensitive = false,
      head_limit,
      offset = 0,
      multiline = false,
    },
    { abortController, getAppState },
  ) {
    const absolutePath = path ? expandPath(path) : getCwd()
    const args = ['--hidden']  // 显示隐藏文件（.开头的文件/目录）

    // 排除版本控制目录，避免搜索结果被版本控制元数据污染
    for (const dir of VCS_DIRECTORIES_TO_EXCLUDE) {
      args.push('--glob', `!${dir}`)
    }

    // 限制每行最大列数，防止 base64 编码或压缩内容塞满输出
    args.push('--max-columns', '500')

    // 仅在明确请求时开启跨行匹配模式
    if (multiline) {
      args.push('-U', '--multiline-dotall')
    }

    // 添加可选标志
    if (case_insensitive) {
      args.push('-i')
    }

    // 根据输出模式添加对应的 ripgrep 标志
    if (output_mode === 'files_with_matches') {
      args.push('-l')  // 仅输出匹配文件名
    } else if (output_mode === 'count') {
      args.push('-c')  // 输出每个文件的匹配计数
    }

    // content 模式下添加行号标志
    if (show_line_numbers && output_mode === 'content') {
      args.push('-n')
    }

    // 添加上下文标志（-C/context 优先于 -B/-A 组合）
    if (output_mode === 'content') {
      if (context !== undefined) {
        // context 参数（-C 的别名）
        args.push('-C', context.toString())
      } else if (context_c !== undefined) {
        // -C 参数（上下文行数）
        args.push('-C', context_c.toString())
      } else {
        // -B（前文行数）和 -A（后文行数）分别设置
        if (context_before !== undefined) {
          args.push('-B', context_before.toString())
        }
        if (context_after !== undefined) {
          args.push('-A', context_after.toString())
        }
      }
    }

    // If pattern starts with dash, use -e flag to specify it as a pattern
    // This prevents ripgrep from interpreting it as a command-line option
    // 以 "-" 开头的模式使用 -e 显式指定，防止被 ripgrep 解析为命令行选项
    if (pattern.startsWith('-')) {
      args.push('-e', pattern)
    } else {
      args.push(pattern)
    }

    // 添加文件类型过滤
    if (type) {
      args.push('--type', type)
    }

    if (glob) {
      // Split on commas and spaces, but preserve patterns with braces
      // 按空格分割，对含大括号的模式不再按逗号拆分（保留 {ts,tsx} 等模式）
      const globPatterns: string[] = []
      const rawPatterns = glob.split(/\s+/)

      for (const rawPattern of rawPatterns) {
        // If pattern contains braces, don't split further
        if (rawPattern.includes('{') && rawPattern.includes('}')) {
          // 含大括号的模式（如 *.{ts,tsx}）整体保留，不按逗号拆分
          globPatterns.push(rawPattern)
        } else {
          // 不含大括号的模式按逗号拆分（如 "*.ts,*.tsx" → ["*.ts", "*.tsx"]）
          globPatterns.push(...rawPattern.split(',').filter(Boolean))
        }
      }

      for (const globPattern of globPatterns.filter(Boolean)) {
        args.push('--glob', globPattern)
      }
    }

    // 添加来自权限配置的忽略模式
    const appState = getAppState()
    const ignorePatterns = normalizePatternsToPath(
      getFileReadIgnorePatterns(appState.toolPermissionContext),
      getCwd(),
    )
    for (const ignorePattern of ignorePatterns) {
      // Note: ripgrep only applies gitignore patterns relative to the working directory
      // So for non-absolute paths, we need to prefix them with '**'
      // See: https://github.com/BurntSushi/ripgrep/discussions/2156#discussioncomment-2316335
      //
      // We also need to negate the pattern with `!` to exclude it
      // ripgrep 的 gitignore 模式相对于工作目录；非绝对路径需加 **/ 前缀，并用 ! 取反
      const rgIgnorePattern = ignorePattern.startsWith('/')
        ? `!${ignorePattern}`
        : `!**/${ignorePattern}`
      args.push('--glob', rgIgnorePattern)
    }

    // 排除孤儿插件版本目录（防止旧版本缓存污染搜索结果）
    for (const exclusion of await getGlobExclusionsForPluginCache(
      absolutePath,
    )) {
      args.push('--glob', exclusion)
    }

    // WSL has severe performance penalty for file reads (3-5x slower on WSL2)
    // The timeout is handled by ripgrep itself via execFile timeout option
    // We don't use AbortController for timeout to avoid interrupting the agent loop
    // If ripgrep times out, it throws RipgrepTimeoutError which propagates up
    // so Claude knows the search didn't complete (rather than thinking there were no matches)
    // WSL 环境下文件读取有严重性能惩罚（WSL2 慢 3-5 倍），超时由 ripgrep execFile timeout 处理
    const results = await ripGrep(args, absolutePath, abortController.signal)

    if (output_mode === 'content') {
      // content 模式：结果为实际匹配的内容行，需将绝对路径转为相对路径
      // 先应用 head_limit，再做路径转换（避免处理将被丢弃的行，提升性能）
      const { items: limitedResults, appliedLimit } = applyHeadLimit(
        results,
        head_limit,
        offset,
      )

      const finalLines = limitedResults.map(line => {
        // 内容行格式：/absolute/path:line_content 或 /absolute/path:num:content
        const colonIndex = line.indexOf(':')
        if (colonIndex > 0) {
          const filePath = line.substring(0, colonIndex)
          const rest = line.substring(colonIndex)
          return toRelativePath(filePath) + rest
        }
        return line
      })
      const output = {
        mode: 'content' as const,
        numFiles: 0, // content 模式不适用文件计数
        filenames: [],
        content: finalLines.join('\n'),
        numLines: finalLines.length,
        ...(appliedLimit !== undefined && { appliedLimit }),
        ...(offset > 0 && { appliedOffset: offset }),
      }
      return { data: output }
    }

    if (output_mode === 'count') {
      // count 模式：结果为 filename:count 格式，先应用分页再转换路径
      const { items: limitedResults, appliedLimit } = applyHeadLimit(
        results,
        head_limit,
        offset,
      )

      // 将绝对路径转为相对路径（节省 token）
      const finalCountLines = limitedResults.map(line => {
        // 计数行格式：/absolute/path:count
        const colonIndex = line.lastIndexOf(':')
        if (colonIndex > 0) {
          const filePath = line.substring(0, colonIndex)
          const count = line.substring(colonIndex)
          return toRelativePath(filePath) + count
        }
        return line
      })

      // 解析计数输出，提取总匹配数和文件数
      let totalMatches = 0
      let fileCount = 0
      for (const line of finalCountLines) {
        const colonIndex = line.lastIndexOf(':')
        if (colonIndex > 0) {
          const countStr = line.substring(colonIndex + 1)
          const count = parseInt(countStr, 10)
          if (!isNaN(count)) {
            totalMatches += count
            fileCount += 1
          }
        }
      }

      const output = {
        mode: 'count' as const,
        numFiles: fileCount,
        filenames: [],
        content: finalCountLines.join('\n'),
        numMatches: totalMatches,
        ...(appliedLimit !== undefined && { appliedLimit }),
        ...(offset > 0 && { appliedOffset: offset }),
      }
      return { data: output }
    }

    // files_with_matches 模式（默认）
    // Use allSettled so a single ENOENT (file deleted between ripgrep's scan
    // and this stat) does not reject the whole batch. Failed stats sort as mtime 0.
    // 使用 allSettled 避免单个文件的 ENOENT（ripgrep 扫描到写入之间被删除）导致整批失败
    const stats = await Promise.allSettled(
      results.map(_ => getFsImplementation().stat(_)),
    )
    const sortedMatches = results
      // 按修改时间降序排列（最近修改的文件优先）
      .map((_, i) => {
        const r = stats[i]!
        return [
          _,
          r.status === 'fulfilled' ? (r.value.mtimeMs ?? 0) : 0,
        ] as const
      })
      .sort((a, b) => {
        if (process.env.NODE_ENV === 'test') {
          // 测试环境下按文件名排序，确保结果确定性
          return a[0].localeCompare(b[0])
        }
        const timeComparison = b[1] - a[1]
        if (timeComparison === 0) {
          // mtime 相同时按文件名排序作为次级排序键
          return a[0].localeCompare(b[0])
        }
        return timeComparison
      })
      .map(_ => _[0])

    // 对排序后的文件列表应用 head_limit 分页
    const { items: finalMatches, appliedLimit } = applyHeadLimit(
      sortedMatches,
      head_limit,
      offset,
    )

    // 将绝对路径转为相对路径（节省 token）
    const relativeMatches = finalMatches.map(toRelativePath)

    const output = {
      mode: 'files_with_matches' as const,
      filenames: relativeMatches,
      numFiles: relativeMatches.length,
      ...(appliedLimit !== undefined && { appliedLimit }),
      ...(offset > 0 && { appliedOffset: offset }),
    }

    return {
      data: output,
    }
  },
} satisfies ToolDef<InputSchema, Output>)
