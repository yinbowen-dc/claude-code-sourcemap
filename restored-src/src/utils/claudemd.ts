/**
 * CLAUDE.md 记忆文件加载模块。
 *
 * 在 Claude Code 系统中，该模块负责发现和加载各层级的 CLAUDE.md 记忆文件，
 * 按以下优先级顺序加载（越靠后优先级越高，模型将更关注）：
 * 1. 托管记忆（/etc/claude-code/CLAUDE.md）— 面向所有用户的全局指令
 * 2. 用户记忆（~/.claude/CLAUDE.md）— 跨项目全局私有指令
 * 3. 项目记忆（CLAUDE.md / .claude/CLAUDE.md / .claude/rules/*.md）— 代码库级指令
 * 4. 本地记忆（CLAUDE.local.md）— 项目专属私有指令
 *
 * 文件发现：从当前目录向上遍历至根目录，更接近当前目录的文件优先级更高。
 *
 * @include 指令：记忆文件可通过 @path / @./relative / @~/home / @/absolute 引用其他文件，
 * 仅在叶文本节点中有效（不在代码块内），循环引用通过已处理文件集防止，不存在的文件静默忽略。
 *
 * Files are loaded in reverse order of priority — later files have higher priority.
 * Memory @include directive: @path, @./relative/path, @~/home/path, or @/absolute/path.
 */

import { feature } from 'bun:bundle'
import ignore from 'ignore'
import memoize from 'lodash-es/memoize.js'
import { Lexer } from 'marked'
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  parse,
  relative,
  sep,
} from 'path'
import picomatch from 'picomatch'
import { logEvent } from 'src/services/analytics/index.js'
import {
  getAdditionalDirectoriesForClaudeMd,
  getOriginalCwd,
} from '../bootstrap/state.js'
import { truncateEntrypointContent } from '../memdir/memdir.js'
import { getAutoMemEntrypoint, isAutoMemoryEnabled } from '../memdir/paths.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js'
import {
  getCurrentProjectConfig,
  getManagedClaudeRulesDir,
  getMemoryPath,
  getUserClaudeRulesDir,
} from './config.js'
import { logForDebugging } from './debug.js'
import { logForDiagnosticsNoPII } from './diagLogs.js'
import { getClaudeConfigHomeDir, isEnvTruthy } from './envUtils.js'
import { getErrnoCode } from './errors.js'
import { normalizePathForComparison } from './file.js'
import { cacheKeys, type FileStateCache } from './fileStateCache.js'
import {
  parseFrontmatter,
  splitPathInFrontmatter,
} from './frontmatterParser.js'
import { getFsImplementation, safeResolvePath } from './fsOperations.js'
import { findCanonicalGitRoot, findGitRoot } from './git.js'
import {
  executeInstructionsLoadedHooks,
  hasInstructionsLoadedHook,
  type InstructionsLoadReason,
  type InstructionsMemoryType,
} from './hooks.js'
import type { MemoryType } from './memory/types.js'
import { expandPath } from './path.js'
import { pathInWorkingPath } from './permissions/filesystem.js'
import { isSettingSourceEnabled } from './settings/constants.js'
import { getInitialSettings } from './settings/settings.js'

/* eslint-disable @typescript-eslint/no-require-imports */
const teamMemPaths = feature('TEAMMEM')
  ? (require('../memdir/teamMemPaths.js') as typeof import('../memdir/teamMemPaths.js'))
  : null
/* eslint-enable @typescript-eslint/no-require-imports */

let hasLoggedInitialLoad = false

const MEMORY_INSTRUCTION_PROMPT =
  'Codebase and user instructions are shown below. Be sure to adhere to these instructions. IMPORTANT: These instructions OVERRIDE any default behavior and you MUST follow them exactly as written.'
// Recommended max character count for a memory file
export const MAX_MEMORY_CHARACTER_COUNT = 40000

// File extensions that are allowed for @include directives
// This prevents binary files (images, PDFs, etc.) from being loaded into memory
const TEXT_FILE_EXTENSIONS = new Set([
  // Markdown and text
  '.md',
  '.txt',
  '.text',
  // Data formats
  '.json',
  '.yaml',
  '.yml',
  '.toml',
  '.xml',
  '.csv',
  // Web
  '.html',
  '.htm',
  '.css',
  '.scss',
  '.sass',
  '.less',
  // JavaScript/TypeScript
  '.js',
  '.ts',
  '.tsx',
  '.jsx',
  '.mjs',
  '.cjs',
  '.mts',
  '.cts',
  // Python
  '.py',
  '.pyi',
  '.pyw',
  // Ruby
  '.rb',
  '.erb',
  '.rake',
  // Go
  '.go',
  // Rust
  '.rs',
  // Java/Kotlin/Scala
  '.java',
  '.kt',
  '.kts',
  '.scala',
  // C/C++
  '.c',
  '.cpp',
  '.cc',
  '.cxx',
  '.h',
  '.hpp',
  '.hxx',
  // C#
  '.cs',
  // Swift
  '.swift',
  // Shell
  '.sh',
  '.bash',
  '.zsh',
  '.fish',
  '.ps1',
  '.bat',
  '.cmd',
  // Config
  '.env',
  '.ini',
  '.cfg',
  '.conf',
  '.config',
  '.properties',
  // Database
  '.sql',
  '.graphql',
  '.gql',
  // Protocol
  '.proto',
  // Frontend frameworks
  '.vue',
  '.svelte',
  '.astro',
  // Templating
  '.ejs',
  '.hbs',
  '.pug',
  '.jade',
  // Other languages
  '.php',
  '.pl',
  '.pm',
  '.lua',
  '.r',
  '.R',
  '.dart',
  '.ex',
  '.exs',
  '.erl',
  '.hrl',
  '.clj',
  '.cljs',
  '.cljc',
  '.edn',
  '.hs',
  '.lhs',
  '.elm',
  '.ml',
  '.mli',
  '.f',
  '.f90',
  '.f95',
  '.for',
  // Build files
  '.cmake',
  '.make',
  '.makefile',
  '.gradle',
  '.sbt',
  // Documentation
  '.rst',
  '.adoc',
  '.asciidoc',
  '.org',
  '.tex',
  '.latex',
  // Lock files (often text-based)
  '.lock',
  // Misc
  '.log',
  '.diff',
  '.patch',
])

export type MemoryFileInfo = {
  path: string
  type: MemoryType
  content: string
  parent?: string // Path of the file that included this one
  globs?: string[] // Glob patterns for file paths this rule applies to
  // True when auto-injection transformed `content` (stripped HTML comments,
  // stripped frontmatter, truncated MEMORY.md) such that it no longer matches
  // the bytes on disk. When set, `rawContent` holds the unmodified disk bytes
  // so callers can cache a `isPartialView` readFileState entry — presence in
  // cache provides dedup + change detection, but Edit/Write still require an
  // explicit Read before proceeding.
  contentDiffersFromDisk?: boolean
  rawContent?: string
}

function pathInOriginalCwd(path: string): boolean {
  return pathInWorkingPath(path, getOriginalCwd())
}

/**
 * 从记忆文件的 frontmatter 中解析内容和 glob 路径匹配模式。
 *
 * frontmatter 形如：
 * ```
 * ---
 * paths:
 *   - src/**
 *   - tests/**
 * ---
 * 实际内容...
 * ```
 *
 * 处理规则：
 * - `/**` 后缀会被去掉——ignore 库在匹配路径时已同时包含目录本身及其内部条目
 * - 若 paths 为空或全部为 `**`（匹配所有），等价于无 glob 限制，返回 `paths: undefined`
 *
 * @param rawContent 含 frontmatter 的原始文件内容
 * @returns `{ content, paths? }` — content 为去掉 frontmatter 后的正文，paths 为 glob 模式数组或 undefined
 */
function parseFrontmatterPaths(rawContent: string): {
  content: string
  paths?: string[]
} {
  // 解析 frontmatter，content 为去除 frontmatter 后的正文
  const { frontmatter, content } = parseFrontmatter(rawContent)

  if (!frontmatter.paths) {
    return { content }
  }

  const patterns = splitPathInFrontmatter(frontmatter.paths)
    .map(pattern => {
      // 去掉 /** 后缀——ignore 库会将路径同时匹配到目录本身及其内部条目
      return pattern.endsWith('/**') ? pattern.slice(0, -3) : pattern
    })
    .filter((p: string) => p.length > 0)

  // 全为 ** 等价于无限制，返回 undefined 表示该文件适用于所有路径
  if (patterns.length === 0 || patterns.every((p: string) => p === '**')) {
    return { content }
  }

  return { content, paths: patterns }
}

/**
 * 从 Markdown 内容中剥除块级 HTML 注释（`<!-- ... -->`）。
 *
 * 使用 marked Lexer 在块级别（block-level）识别注释，因此：
 * - 代码块（fenced code block）和行内代码（code span）内的注释保留不变
 * - 段落内的行内 HTML 注释也保留——该函数仅针对独立成行的注释块
 * - 未关闭的注释（只有 `<!--` 无对应 `-->`）不做处理，避免 typo 导致整个文件内容消失
 *
 * @param content 原始 Markdown 字符串
 * @returns `{ content: string, stripped: boolean }` — 去掉注释后的文本，以及是否发生了剥除
 */
export function stripHtmlComments(content: string): {
  content: string
  stripped: boolean
} {
  // 快速路径：无 <!-- 则无需 lex，直接返回
  if (!content.includes('<!--')) {
    return { content, stripped: false }
  }
  // gfm:false 足够用于 html-block 检测（CommonMark 规则），与 GFM 无关
  return stripHtmlCommentsFromTokens(new Lexer({ gfm: false }).lex(content))
}

/**
 * 基于预先 lex 好的 token 列表执行 HTML 注释剥除。
 *
 * 从 `stripHtmlComments` 和 `parseMemoryFileContent` 共享调用，
 * 避免对同一份内容重复执行 lex。
 *
 * 处理规则：
 * - `html` 类型 token 且以 `<!--` 开头：用正则剥除其中所有注释跨度，保留注释外的残余文本
 * - 其他 token：原样拼回输出
 *
 * @param tokens marked Lexer 生成的 token 数组
 * @returns 去掉 HTML 注释后的 `{ content, stripped }` 结果
 */
function stripHtmlCommentsFromTokens(tokens: ReturnType<Lexer['lex']>): {
  content: string
  stripped: boolean
} {
  let result = ''
  let stripped = false

  // 非贪心匹配，允许同一行出现多个注释；[\s\S] 支持跨行匹配
  const commentSpan = /<!--[\s\S]*?-->/g

  for (const token of tokens) {
    if (token.type === 'html') {
      const trimmed = token.raw.trimStart()
      if (trimmed.startsWith('<!--') && trimmed.includes('-->')) {
        // CommonMark type-2 HTML block 在包含 --> 的行结束；
        // 剥除注释跨度后，保留该 token 中注释以外的残余内容
        const residue = token.raw.replace(commentSpan, '')
        stripped = true
        if (residue.trim().length > 0) {
          // 残余内容不为空（如 `<!-- note --> Use bun`）则保留
          result += residue
        }
        continue
      }
    }
    result += token.raw
  }

  return { content: result, stripped }
}

/**
 * 将原始记忆文件内容解析为 `MemoryFileInfo`，纯函数——不产生 I/O。
 *
 * 处理流程：
 * 1. 检测文件扩展名，非文本类型（图片、PDF 等）直接跳过，返回 null
 * 2. 解析 frontmatter，剥离路径 glob 并获取正文（`parseFrontmatterPaths`）
 * 3. 若内容含 `<!--` 或需要解析 @include，统一执行一次 Lexer（gfm:false），
 *    避免对同一内容多次 lex
 * 4. 剥除 HTML 注释（仅当内容实际含注释时）
 * 5. 提取 @include 路径（仅当 `includeBasePath` 存在时）
 * 6. AutoMem / TeamMem 类型额外调用 `truncateEntrypointContent` 截断到行数/字节上限
 * 7. 计算 `contentDiffersFromDisk`：三种转换（frontmatter 剥离、注释剥除、截断）
 *    任一发生则为 true，同时保存原始内容到 `rawContent`
 *
 * @param rawContent 磁盘上的原始文件内容
 * @param filePath 文件绝对路径（用于扩展名检测和调试日志）
 * @param type 记忆文件类型
 * @param includeBasePath 可选；传入时同步提取 @include 路径，与 lex 复用同一 token 列表
 * @returns `{ info: MemoryFileInfo | null, includePaths: string[] }`
 */
function parseMemoryFileContent(
  rawContent: string,
  filePath: string,
  type: MemoryType,
  includeBasePath?: string,
): { info: MemoryFileInfo | null; includePaths: string[] } {
  // 非文本文件扩展名（图片、PDF 等）跳过，防止二进制数据加载进记忆
  const ext = extname(filePath).toLowerCase()
  if (ext && !TEXT_FILE_EXTENSIONS.has(ext)) {
    logForDebugging(`Skipping non-text file in @include: ${filePath}`)
    return { info: null, includePaths: [] }
  }

  const { content: withoutFrontmatter, paths } =
    parseFrontmatterPaths(rawContent)

  // 共用一次 lex：gfm:false 由 @include 提取需要（~/path 不被识别为删除线），
  // 对注释剥除同样适用（html block 是 CommonMark 规则）
  const hasComment = withoutFrontmatter.includes('<!--')
  const tokens =
    hasComment || includeBasePath !== undefined
      ? new Lexer({ gfm: false }).lex(withoutFrontmatter)
      : undefined

  // 仅在确实含注释时才通过 token 重建字符串——
  // marked 在 lex 时会将 \r\n 规范化，对 CRLF 文件直接 round-trip 会误判 contentDiffersFromDisk
  const strippedContent =
    hasComment && tokens
      ? stripHtmlCommentsFromTokens(tokens).content
      : withoutFrontmatter

  // 仅在调用方需要 @include 解析时提取路径
  const includePaths =
    tokens && includeBasePath !== undefined
      ? extractIncludePathsFromTokens(tokens, includeBasePath)
      : []

  // AutoMem / TeamMem 的入口文件需额外截断到行数和字节上限
  let finalContent = strippedContent
  if (type === 'AutoMem' || type === 'TeamMem') {
    finalContent = truncateEntrypointContent(strippedContent).content
  }

  // 涵盖 frontmatter 剥除、HTML 注释剥除、MEMORY.md 截断三种转换
  const contentDiffersFromDisk = finalContent !== rawContent
  return {
    info: {
      path: filePath,
      type,
      content: finalContent,
      globs: paths,
      contentDiffersFromDisk,
      // contentDiffersFromDisk 时保存原始内容，供缓存层做去重和变更检测
      rawContent: contentDiffersFromDisk ? rawContent : undefined,
    },
    includePaths,
  }
}

/**
 * 处理读取记忆文件时发生的错误，区分可忽略错误和需要上报的错误。
 *
 * - ENOENT（文件不存在）/ EISDIR（是目录）：正常情况，静默忽略
 * - EACCES（权限不足）：可操作的错误，上报 analytics 事件但不抛出；
 *   事件中不记录完整路径以避免 PII 泄露，仅记录是否在 claude config 目录下
 * - 其他错误：静默忽略（调用方 safelyReadMemoryFileAsync 也不重新抛出）
 *
 * @param error 捕获到的异常
 * @param filePath 出错的文件路径（仅用于 has_home_dir 判断）
 */
function handleMemoryFileReadError(error: unknown, filePath: string): void {
  const code = getErrnoCode(error)
  // 文件不存在或路径是目录，属于预期情况，直接忽略
  if (code === 'ENOENT' || code === 'EISDIR') {
    return
  }
  // 权限错误（EACCES）属于可操作问题，上报 analytics 但不记录完整路径（PII 安全）
  if (code === 'EACCES') {
    logEvent('tengu_claude_md_permission_error', {
      is_access_error: 1,
      // 仅标记是否在 claude 配置目录下，不泄露具体路径
      has_home_dir: filePath.includes(getClaudeConfigHomeDir()) ? 1 : 0,
    })
  }
}

/**
 * 异步读取记忆文件并解析为 `MemoryFileInfo`，出错时静默返回 null。
 *
 * 在 `processMemoryFile → getMemoryFiles` 调用链中使用异步版本，
 * 保持事件循环响应性——目录向上遍历过程中会产生大量 readFile 调用，
 * 大多数以 ENOENT 告终，同步版本会阻塞事件循环。
 *
 * 当 `includeBasePath` 有值时，@include 路径在同一 lex pass 中被提取，
 * 与文件内容共用同一 token 列表，无需二次 lex。
 *
 * @param filePath 要读取的文件绝对路径
 * @param type 记忆文件类型（User / Project / Local / Managed / AutoMem / TeamMem）
 * @param includeBasePath 可选；有值时同步提取 @include 路径
 * @returns `{ info, includePaths }` — 读取/解析失败时 info 为 null，includePaths 为 []
 */
async function safelyReadMemoryFileAsync(
  filePath: string,
  type: MemoryType,
  includeBasePath?: string,
): Promise<{ info: MemoryFileInfo | null; includePaths: string[] }> {
  try {
    const fs = getFsImplementation()
    // 异步读取文件内容，保持事件循环响应
    const rawContent = await fs.readFile(filePath, { encoding: 'utf-8' })
    return parseMemoryFileContent(rawContent, filePath, type, includeBasePath)
  } catch (error) {
    // 区分可忽略错误（ENOENT/EISDIR）和需上报错误（EACCES），均不重新抛出
    handleMemoryFileReadError(error, filePath)
    return { info: null, includePaths: [] }
  }
}

type MarkdownToken = {
  type: string
  text?: string
  href?: string
  tokens?: MarkdownToken[]
  raw?: string
  items?: MarkdownToken[]
}

/**
 * 从预先 lex 好的 Markdown token 列表中提取 `@path` 引用，并解析为绝对路径。
 *
 * 支持的 @include 语法：
 * - `@path/to/file`  — 相对于 basePath 所在目录
 * - `@./relative`    — 显式相对路径
 * - `@~/home/path`   — 相对于用户主目录
 * - `@/absolute`     — 绝对路径
 *
 * 跳过规则：
 * - `code` / `codespan` token：避免误匹配代码块内的 @mentions
 * - `html` token 中纯注释部分：注释内的 @path 不应被包含；但注释外的残余文本仍会处理
 * - 以 `@`、`#%^&*()` 等特殊字符开头的 token：非文件路径
 *
 * gfm:false 由调用方确保——GFM 删除线语法会将 `@~/path` 误解为删除线。
 *
 * @param tokens marked Lexer（gfm:false）生成的 token 列表
 * @param basePath @include 相对路径的参照文件路径（通常为包含 @include 的 CLAUDE.md 路径）
 * @returns 去重后的绝对路径数组
 */
function extractIncludePathsFromTokens(
  tokens: ReturnType<Lexer['lex']>,
  basePath: string,
): string[] {
  const absolutePaths = new Set<string>()

  // 从文本字符串中提取 @path 引用，并将解析后的绝对路径加入 absolutePaths
  function extractPathsFromText(textContent: string) {
    // 正则匹配行首或空白后跟 @ 的路径引用，支持路径中的转义空格（\ ）
    const includeRegex = /(?:^|\s)@((?:[^\s\\]|\\ )+)/g
    let match
    while ((match = includeRegex.exec(textContent)) !== null) {
      let path = match[1]
      if (!path) continue

      // 去掉片段标识符（#heading、#section-name 等），它们不是文件路径的一部分
      const hashIndex = path.indexOf('#')
      if (hashIndex !== -1) {
        path = path.substring(0, hashIndex)
      }
      if (!path) continue

      // 将路径中的转义空格 "\ " 还原为普通空格
      path = path.replace(/\\ /g, ' ')

      // 仅接受合法路径前缀：./、~/、/（非根目录）或以字母数字._-开头的相对路径
      if (path) {
        const isValidPath =
          path.startsWith('./') ||
          path.startsWith('~/') ||
          (path.startsWith('/') && path !== '/') ||
          (!path.startsWith('@') &&
            !path.match(/^[#%^&*()]+/) &&
            path.match(/^[a-zA-Z0-9._-]/))

        if (isValidPath) {
          // expandPath 处理 ~/home、./relative、/absolute 三种形式
          const resolvedPath = expandPath(path, dirname(basePath))
          absolutePaths.add(resolvedPath)
        }
      }
    }
  }

  // 递归遍历 token 树，在叶子文本节点中查找 @path 引用
  function processElements(elements: MarkdownToken[]) {
    for (const element of elements) {
      // 跳过代码块和行内代码——其中的 @mentions 不应被当作文件引用
      if (element.type === 'code' || element.type === 'codespan') {
        continue
      }

      // html token：对于含注释的块，剥除注释后检查残余文本中的 @path；
      // 非注释型 html 标签（如 <div>）直接跳过
      if (element.type === 'html') {
        const raw = element.raw || ''
        const trimmed = raw.trimStart()
        if (trimmed.startsWith('<!--') && trimmed.includes('-->')) {
          const commentSpan = /<!--[\s\S]*?-->/g
          const residue = raw.replace(commentSpan, '')
          if (residue.trim().length > 0) {
            extractPathsFromText(residue)
          }
        }
        continue
      }

      // 文本节点：直接提取 @path 引用
      if (element.type === 'text') {
        extractPathsFromText(element.text || '')
      }

      // 递归处理子 token（段落、标题、链接等嵌套结构）
      if (element.tokens) {
        processElements(element.tokens)
      }

      // 列表项的特殊处理（items 字段而非 tokens 字段）
      if (element.items) {
        processElements(element.items)
      }
    }
  }

  processElements(tokens as MarkdownToken[])
  return [...absolutePaths]
}

const MAX_INCLUDE_DEPTH = 5

/**
 * 判断指定 CLAUDE.md 文件路径是否被 `claudeMdExcludes` 设置排除。
 *
 * 排除逻辑：
 * - 仅适用于 User、Project、Local 类型；Managed、AutoMem、TeamMem 始终不排除
 * - 使用 picomatch 对规范化（反斜杠→正斜杠）后的路径做 glob 匹配
 * - 同时匹配原始路径和 realpath 解析后的路径，处理 macOS 上 /tmp → /private/tmp 的符号链接
 *
 * @param filePath 要检测的文件路径
 * @param type 记忆文件类型
 * @returns 若文件应被排除则返回 true
 */
function isClaudeMdExcluded(filePath: string, type: MemoryType): boolean {
  // Managed / AutoMem / TeamMem 类型始终不排除
  if (type !== 'User' && type !== 'Project' && type !== 'Local') {
    return false
  }

  const patterns = getInitialSettings().claudeMdExcludes
  if (!patterns || patterns.length === 0) {
    return false
  }

  const matchOpts = { dot: true }
  // 将 Windows 反斜杠统一为正斜杠，便于 picomatch 匹配
  const normalizedPath = filePath.replaceAll('\\', '/')

  // 同时解析模式中的符号链接前缀，使 /tmp/project 和 /private/tmp/project 都能匹配
  const expandedPatterns = resolveExcludePatterns(patterns).filter(
    p => p.length > 0,
  )
  if (expandedPatterns.length === 0) {
    return false
  }

  return picomatch.isMatch(normalizedPath, expandedPatterns, matchOpts)
}

/**
 * 将 `claudeMdExcludes` 中的绝对路径 glob 模式展开为含符号链接解析版本的列表。
 *
 * 仅处理绝对路径模式（以 `/` 开头）；纯 glob 模式（如 `**\/*.md`）不含文件系统前缀，跳过。
 * 对含 glob 字符的模式，找出第一个 glob 字符前的静态前缀目录并解析符号链接；
 * 若解析结果与原路径不同，则将解析后的版本追加到列表，实现双版本同时匹配。
 *
 * 在同步调用链中（`isClaudeMdExcluded → processMemoryFile → getMemoryFiles`）使用同步 I/O。
 *
 * @param patterns 原始 glob 模式数组（来自 settings.claudeMdExcludes）
 * @returns 含原始模式和符号链接解析版本的展开数组
 */
function resolveExcludePatterns(patterns: string[]): string[] {
  const fs = getFsImplementation()
  // 统一将反斜杠替换为正斜杠（Windows 兼容）
  const expanded: string[] = patterns.map(p => p.replaceAll('\\', '/'))

  for (const normalized of expanded) {
    // 仅处理绝对路径模式，相对 glob 无法从文件系统解析符号链接
    if (!normalized.startsWith('/')) {
      continue
    }

    // 找到第一个 glob 字符的位置，取其前的静态前缀
    const globStart = normalized.search(/[*?{[]/)
    const staticPrefix =
      globStart === -1 ? normalized : normalized.slice(0, globStart)
    const dirToResolve = dirname(staticPrefix)

    try {
      // 同步调用——在同步调用链中（isClaudeMdExcluded → processMemoryFile → getMemoryFiles）
      const resolvedDir = fs.realpathSync(dirToResolve).replaceAll('\\', '/')
      if (resolvedDir !== dirToResolve) {
        // 解析结果与原路径不同（存在符号链接），追加解析后的版本
        const resolvedPattern =
          resolvedDir + normalized.slice(dirToResolve.length)
        expanded.push(resolvedPattern)
      }
    } catch {
      // 目录不存在，跳过此模式的符号链接解析
    }
  }

  return expanded
}

/**
 * 递归处理一个记忆文件及其所有 `@include` 引用，返回包含主文件和所有包含文件的数组。
 *
 * 处理顺序：主文件先入列，然后依次递归其 @include 文件（父文件在前，子文件在后）。
 *
 * 防护机制：
 * - `processedPaths`：已处理路径集合，防止循环引用；Windows 驱动器盘符大小写不一致时通过规范化处理
 * - `depth >= MAX_INCLUDE_DEPTH`：超过最大嵌套深度时跳过
 * - `isClaudeMdExcluded`：被 `claudeMdExcludes` 设置排除的文件跳过
 * - 符号链接：提前解析 realpath，同时将原始路径和解析路径都加入 `processedPaths`
 * - 外部文件（不在 originalCwd 内）：`includeExternal` 为 false 时跳过
 *
 * @param filePath 要处理的文件绝对路径
 * @param type 记忆文件类型
 * @param processedPaths 已处理文件路径集合（由调用方维护，跨递归共享）
 * @param includeExternal 是否允许加载 cwd 外部的 @include 引用文件
 * @param depth 当前递归深度（初始为 0）
 * @param parent 包含当前文件的父文件路径（用于填充 MemoryFileInfo.parent）
 * @returns MemoryFileInfo 数组，主文件在前，@include 文件在后
 */
export async function processMemoryFile(
  filePath: string,
  type: MemoryType,
  processedPaths: Set<string>,
  includeExternal: boolean,
  depth: number = 0,
  parent?: string,
): Promise<MemoryFileInfo[]> {
  // 跳过已处理或超过最大嵌套深度的文件；
  // 规范化路径以处理 Windows 驱动器盘符大小写差异（如 C:\Users 与 c:\Users）
  const normalizedPath = normalizePathForComparison(filePath)
  if (processedPaths.has(normalizedPath) || depth >= MAX_INCLUDE_DEPTH) {
    return []
  }

  // 被 claudeMdExcludes 设置排除的文件不加载
  if (isClaudeMdExcluded(filePath, type)) {
    return []
  }

  // 提前解析符号链接，@import 路径解析以 realpath 为基准，避免重复处理同一物理文件
  const { resolvedPath, isSymlink } = safeResolvePath(
    getFsImplementation(),
    filePath,
  )

  // 同时记录原始路径和解析路径，防止通过不同路径重入
  processedPaths.add(normalizedPath)
  if (isSymlink) {
    processedPaths.add(normalizePathForComparison(resolvedPath))
  }

  const { info: memoryFile, includePaths: resolvedIncludePaths } =
    await safelyReadMemoryFileAsync(filePath, type, resolvedPath)
  // 内容为空（文件不存在或读取失败）则跳过
  if (!memoryFile || !memoryFile.content.trim()) {
    return []
  }

  // 填充父文件路径（用于 /memory 界面展示包含层级）
  if (parent) {
    memoryFile.parent = parent
  }

  const result: MemoryFileInfo[] = []

  // 主文件先入列（父文件在子文件之前）
  result.push(memoryFile)

  for (const resolvedIncludePath of resolvedIncludePaths) {
    // 外部文件（cwd 之外）：须 includeExternal=true 才加载
    const isExternal = !pathInOriginalCwd(resolvedIncludePath)
    if (isExternal && !includeExternal) {
      continue
    }

    // 递归处理 @include 文件，将当前文件作为父文件传入
    const includedFiles = await processMemoryFile(
      resolvedIncludePath,
      type,
      processedPaths,
      includeExternal,
      depth + 1,
      filePath, // 当前文件作为子文件的父文件
    )
    result.push(...includedFiles)
  }

  return result
}

/**
 * 递归处理 `.claude/rules/` 目录（及子目录）中的所有 `.md` 文件。
 *
 * 文件过滤规则由 `conditionalRule` 参数控制：
 * - `conditionalRule: false`：仅加载**无** frontmatter paths 的文件（无条件规则）
 * - `conditionalRule: true`：仅加载**有** frontmatter paths 的文件（条件规则，需额外 glob 匹配）
 *
 * 符号链接处理：
 * - 对目录条目使用 `safeResolvePath` 检测符号链接
 * - 若是符号链接目录，`visitedDirs` 同时记录原始路径和 realpath，防止循环遍历
 * - 对文件使用 `stat` 确认类型（避免 Dirent.isDirectory() 对符号链接的误判）
 *
 * 权限错误上报：EACCES 上报 analytics 但不抛出，其他 I/O 错误同样静默返回 []。
 *
 * @param rulesDir 规则目录路径
 * @param type 记忆文件类型
 * @param processedPaths 已处理文件路径集合（会被修改）
 * @param includeExternal 是否允许加载 cwd 外部的 @include 引用文件
 * @param conditionalRule true 仅含 frontmatter paths 的文件；false 仅不含的文件
 * @param visitedDirs 已访问目录真实路径集合（用于循环检测，默认新建空集合）
 * @returns MemoryFileInfo 数组
 */
export async function processMdRules({
  rulesDir,
  type,
  processedPaths,
  includeExternal,
  conditionalRule,
  visitedDirs = new Set(),
}: {
  rulesDir: string
  type: MemoryType
  processedPaths: Set<string>
  includeExternal: boolean
  conditionalRule: boolean
  visitedDirs?: Set<string>
}): Promise<MemoryFileInfo[]> {
  // 同一目录已访问过则直接返回，防止符号链接环路
  if (visitedDirs.has(rulesDir)) {
    return []
  }

  try {
    const fs = getFsImplementation()

    // 解析符号链接，获取目录的真实路径
    const { resolvedPath: resolvedRulesDir, isSymlink } = safeResolvePath(
      fs,
      rulesDir,
    )

    // 同时记录原始路径和 realpath，避免通过不同路径重入
    visitedDirs.add(rulesDir)
    if (isSymlink) {
      visitedDirs.add(resolvedRulesDir)
    }

    const result: MemoryFileInfo[] = []
    let entries: import('fs').Dirent[]
    try {
      // 读取目录条目，ENOENT / EACCES / ENOTDIR 均视为目录不存在，返回空
      entries = await fs.readdir(resolvedRulesDir)
    } catch (e: unknown) {
      const code = getErrnoCode(e)
      if (code === 'ENOENT' || code === 'EACCES' || code === 'ENOTDIR') {
        return []
      }
      throw e
    }

    for (const entry of entries) {
      const entryPath = join(rulesDir, entry.name)
      const { resolvedPath: resolvedEntryPath, isSymlink } = safeResolvePath(
        fs,
        entryPath,
      )

      // 非符号链接时直接使用 Dirent 方法，避免额外 stat 调用；
      // 符号链接需要 stat 目标文件来确定类型
      const stats = isSymlink ? await fs.stat(resolvedEntryPath) : null
      const isDirectory = stats ? stats.isDirectory() : entry.isDirectory()
      const isFile = stats ? stats.isFile() : entry.isFile()

      if (isDirectory) {
        // 目录：递归处理，传入同一 visitedDirs 集合防止环路
        result.push(
          ...(await processMdRules({
            rulesDir: resolvedEntryPath,
            type,
            processedPaths,
            includeExternal,
            conditionalRule,
            visitedDirs,
          })),
        )
      } else if (isFile && entry.name.endsWith('.md')) {
        // 仅处理 .md 文件，根据 conditionalRule 决定保留有/无 globs 的文件
        const files = await processMemoryFile(
          resolvedEntryPath,
          type,
          processedPaths,
          includeExternal,
        )
        result.push(
          ...files.filter(f => (conditionalRule ? f.globs : !f.globs)),
        )
      }
    }

    return result
  } catch (error) {
    // EACCES 权限错误上报 analytics（不含完整路径以避免 PII 泄露）
    if (error instanceof Error && error.message.includes('EACCES')) {
      logEvent('tengu_claude_rules_md_permission_error', {
        is_access_error: 1,
        has_home_dir: rulesDir.includes(getClaudeConfigHomeDir()) ? 1 : 0,
      })
    }
    return []
  }
}

/**
 * 发现并加载所有层级的记忆文件，使用 lodash memoize 缓存结果。
 *
 * 加载顺序（低优先级 → 高优先级，越靠后模型越关注）：
 * 1. Managed（/etc/claude-code/CLAUDE.md + rules/）—— 面向所有用户的全局指令
 * 2. User（~/.claude/CLAUDE.md + rules/）—— 跨项目私有指令（需 userSettings 启用）
 * 3. Project（从根目录到 CWD 的每层 CLAUDE.md / .claude/CLAUDE.md / .claude/rules/*.md）
 * 4. Local（CLAUDE.local.md，私有且不提交到版本控制）
 * 5. AutoMem（MEMORY.md 自动记忆入口，需功能开关）
 * 6. TeamMem（团队共享记忆入口，需 TEAMMEM feature flag）
 *
 * 嵌套 worktree 处理：检测 gitRoot ≠ canonicalRoot 且嵌套关系，跳过主 repo 内
 * 但 worktree 外的 Project 类型文件（避免同一内容被加载两次），Local 文件不受影响。
 *
 * --add-dir 支持：`CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD` 环境变量启用时，
 * 从额外目录加载 Project 类型文件。
 *
 * @param forceIncludeExternal 强制允许加载 cwd 外部的 @include 引用文件
 *   （仅用于 getExternalClaudeMdIncludes 的审批检查，普通调用不传）
 * @returns 按加载顺序排列的 MemoryFileInfo 数组
 */
export const getMemoryFiles = memoize(
  async (forceIncludeExternal: boolean = false): Promise<MemoryFileInfo[]> => {
    const startTime = Date.now()
    logForDiagnosticsNoPII('info', 'memory_files_started')

    const result: MemoryFileInfo[] = []
    const processedPaths = new Set<string>()
    const config = getCurrentProjectConfig()
    // forceIncludeExternal 强制开启时，或项目已授权外部包含时，允许加载外部文件
    const includeExternal =
      forceIncludeExternal ||
      config.hasClaudeMdExternalIncludesApproved ||
      false

    // 1. 加载 Managed 文件（始终加载，用于全局策略指令）
    const managedClaudeMd = getMemoryPath('Managed')
    result.push(
      ...(await processMemoryFile(
        managedClaudeMd,
        'Managed',
        processedPaths,
        includeExternal,
      )),
    )
    // 加载 Managed .claude/rules/*.md 中的无条件规则
    const managedClaudeRulesDir = getManagedClaudeRulesDir()
    result.push(
      ...(await processMdRules({
        rulesDir: managedClaudeRulesDir,
        type: 'Managed',
        processedPaths,
        includeExternal,
        conditionalRule: false,
      })),
    )

    // 2. 加载 User 文件（需 userSettings 启用）
    if (isSettingSourceEnabled('userSettings')) {
      const userClaudeMd = getMemoryPath('User')
      result.push(
        ...(await processMemoryFile(
          userClaudeMd,
          'User',
          processedPaths,
          true, // User 记忆始终允许包含外部文件
        )),
      )
      // 加载 User ~/.claude/rules/*.md 中的无条件规则
      const userClaudeRulesDir = getUserClaudeRulesDir()
      result.push(
        ...(await processMdRules({
          rulesDir: userClaudeRulesDir,
          type: 'User',
          processedPaths,
          includeExternal: true,
          conditionalRule: false,
        })),
      )
    }

    // 3. 加载 Project 和 Local 文件：收集从 originalCwd 向上直到根目录的所有目录
    const dirs: string[] = []
    const originalCwd = getOriginalCwd()
    let currentDir = originalCwd

    // 向上遍历目录树，收集路径（从 CWD 到根目录，不含根目录）
    while (currentDir !== parse(currentDir).root) {
      dirs.push(currentDir)
      currentDir = dirname(currentDir)
    }

    // 嵌套 worktree 检测：gitRoot（worktree 工作目录）≠ canonicalRoot（主 repo 根目录）
    // 且 gitRoot 在 canonicalRoot 内部时，说明当前在嵌套 worktree 中
    const gitRoot = findGitRoot(originalCwd)
    const canonicalRoot = findCanonicalGitRoot(originalCwd)
    const isNestedWorktree =
      gitRoot !== null &&
      canonicalRoot !== null &&
      normalizePathForComparison(gitRoot) !==
        normalizePathForComparison(canonicalRoot) &&
      pathInWorkingPath(gitRoot, canonicalRoot)

    // 反转目录列表，从根目录向下加载（根目录优先级最低，CWD 最高）
    for (const dir of dirs.reverse()) {
      // 嵌套 worktree 中跳过主 repo 内（但 worktree 外）的 Project 文件，避免重复加载
      const skipProject =
        isNestedWorktree &&
        pathInWorkingPath(dir, canonicalRoot) &&
        !pathInWorkingPath(dir, gitRoot)

      // 加载 Project 类型文件（需 projectSettings 启用且未被跳过）
      if (isSettingSourceEnabled('projectSettings') && !skipProject) {
        const projectPath = join(dir, 'CLAUDE.md')
        result.push(
          ...(await processMemoryFile(
            projectPath,
            'Project',
            processedPaths,
            includeExternal,
          )),
        )

        // 加载 .claude/CLAUDE.md（Project）
        const dotClaudePath = join(dir, '.claude', 'CLAUDE.md')
        result.push(
          ...(await processMemoryFile(
            dotClaudePath,
            'Project',
            processedPaths,
            includeExternal,
          )),
        )

        // 加载 .claude/rules/*.md 中的无条件规则（Project）
        const rulesDir = join(dir, '.claude', 'rules')
        result.push(
          ...(await processMdRules({
            rulesDir,
            type: 'Project',
            processedPaths,
            includeExternal,
            conditionalRule: false,
          })),
        )
      }

      // 加载 Local 类型文件 CLAUDE.local.md（需 localSettings 启用）
      if (isSettingSourceEnabled('localSettings')) {
        const localPath = join(dir, 'CLAUDE.local.md')
        result.push(
          ...(await processMemoryFile(
            localPath,
            'Local',
            processedPaths,
            includeExternal,
          )),
        )
      }
    }

    // 4. 额外目录（--add-dir）支持：环境变量启用时从额外目录加载 Project 文件
    // 注：不检查 projectSettings，因为 --add-dir 是用户显式操作，SDK 默认 settingSources 为 []
    if (isEnvTruthy(process.env.CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD)) {
      const additionalDirs = getAdditionalDirectoriesForClaudeMd()
      for (const dir of additionalDirs) {
        // 从额外目录加载 CLAUDE.md
        const projectPath = join(dir, 'CLAUDE.md')
        result.push(
          ...(await processMemoryFile(
            projectPath,
            'Project',
            processedPaths,
            includeExternal,
          )),
        )

        // 从额外目录加载 .claude/CLAUDE.md
        const dotClaudePath = join(dir, '.claude', 'CLAUDE.md')
        result.push(
          ...(await processMemoryFile(
            dotClaudePath,
            'Project',
            processedPaths,
            includeExternal,
          )),
        )

        // 从额外目录加载 .claude/rules/*.md 中的无条件规则
        const rulesDir = join(dir, '.claude', 'rules')
        result.push(
          ...(await processMdRules({
            rulesDir,
            type: 'Project',
            processedPaths,
            includeExternal,
            conditionalRule: false,
          })),
        )
      }
    }

    // 5. AutoMem（MEMORY.md）入口文件：功能开关启用且文件存在时加载
    if (isAutoMemoryEnabled()) {
      const { info: memdirEntry } = await safelyReadMemoryFileAsync(
        getAutoMemEntrypoint(),
        'AutoMem',
      )
      if (memdirEntry) {
        const normalizedPath = normalizePathForComparison(memdirEntry.path)
        if (!processedPaths.has(normalizedPath)) {
          processedPaths.add(normalizedPath)
          result.push(memdirEntry)
        }
      }
    }

    // 6. TeamMem（团队共享记忆）入口文件：TEAMMEM feature 启用时加载
    if (feature('TEAMMEM') && teamMemPaths!.isTeamMemoryEnabled()) {
      const { info: teamMemEntry } = await safelyReadMemoryFileAsync(
        teamMemPaths!.getTeamMemEntrypoint(),
        'TeamMem',
      )
      if (teamMemEntry) {
        const normalizedPath = normalizePathForComparison(teamMemEntry.path)
        if (!processedPaths.has(normalizedPath)) {
          processedPaths.add(normalizedPath)
          result.push(teamMemEntry)
        }
      }
    }

    const totalContentLength = result.reduce(
      (sum, f) => sum + f.content.length,
      0,
    )

    logForDiagnosticsNoPII('info', 'memory_files_completed', {
      duration_ms: Date.now() - startTime,
      file_count: result.length,
      total_content_length: totalContentLength,
    })

    const typeCounts: Record<string, number> = {}
    for (const f of result) {
      typeCounts[f.type] = (typeCounts[f.type] ?? 0) + 1
    }

    // 仅在会话首次加载时上报 analytics 事件，避免重复记录
    if (!hasLoggedInitialLoad) {
      hasLoggedInitialLoad = true
      logEvent('tengu_claudemd__initial_load', {
        file_count: result.length,
        total_content_length: totalContentLength,
        user_count: typeCounts['User'] ?? 0,
        project_count: typeCounts['Project'] ?? 0,
        local_count: typeCounts['Local'] ?? 0,
        managed_count: typeCounts['Managed'] ?? 0,
        automem_count: typeCounts['AutoMem'] ?? 0,
        ...(feature('TEAMMEM')
          ? { teammem_count: typeCounts['TeamMem'] ?? 0 }
          : {}),
        duration_ms: Date.now() - startTime,
      })
    }

    // 触发 InstructionsLoaded hook（仅 !forceIncludeExternal 时）：
    // - forceIncludeExternal=true 仅用于 getExternalClaudeMdIncludes 的审批检查，
    //   不是真正的上下文构建，在此触发会导致重复触发
    // - AutoMem / TeamMem 排除在外（不属于 CLAUDE.md/rules 意义上的"指令"）
    // - one-shot 标志即使没有 hook 也会消费，防止会话中途注册 hook 后
    //   因直接 .cache.clear() 导致 'session_start' 原因错报
    if (!forceIncludeExternal) {
      const eagerLoadReason = consumeNextEagerLoadReason()
      if (eagerLoadReason !== undefined && hasInstructionsLoadedHook()) {
        for (const file of result) {
          if (!isInstructionsMemoryType(file.type)) continue
          // @include 来的文件使用 'include' 原因，顶层文件使用 eagerLoadReason
          const loadReason = file.parent ? 'include' : eagerLoadReason
          void executeInstructionsLoadedHooks(
            file.path,
            file.type,
            loadReason,
            {
              globs: file.globs,
              parentFilePath: file.parent,
            },
          )
        }
      }
    }

    return result
  },
)

function isInstructionsMemoryType(
  type: MemoryType,
): type is InstructionsMemoryType {
  return (
    type === 'User' ||
    type === 'Project' ||
    type === 'Local' ||
    type === 'Managed'
  )
}

// Load reason to report for top-level (non-included) files on the next eager
// getMemoryFiles() pass. Set to 'compact' by resetGetMemoryFilesCache when
// compaction clears the cache, so the InstructionsLoaded hook reports the
// reload correctly instead of misreporting it as 'session_start'. One-shot:
// reset to 'session_start' after being read.
let nextEagerLoadReason: InstructionsLoadReason = 'session_start'

// Whether the InstructionsLoaded hook should fire on the next cache miss.
// true initially (for session_start), consumed after firing, re-enabled only
// by resetGetMemoryFilesCache(). Callers that only need cache invalidation
// for correctness (e.g. worktree enter/exit, settings sync, /memory dialog)
// should use clearMemoryFileCaches() instead to avoid spurious hook fires.
let shouldFireHook = true

function consumeNextEagerLoadReason(): InstructionsLoadReason | undefined {
  if (!shouldFireHook) return undefined
  shouldFireHook = false
  const reason = nextEagerLoadReason
  nextEagerLoadReason = 'session_start'
  return reason
}

/**
 * 清除 `getMemoryFiles` 的 memoize 缓存，**不**触发 InstructionsLoaded hook。
 *
 * 适用于仅需缓存失效（正确性保障）的场景，如：
 * - worktree 进入/退出
 * - 设置同步
 * - /memory 对话框刷新
 *
 * 若需同时触发 InstructionsLoaded hook（如压缩后重载指令），
 * 请改用 `resetGetMemoryFilesCache()`。
 */
export function clearMemoryFileCaches(): void {
  // ?.cache：测试中可能通过 spyOn 替换 memoize wrapper，此时 .cache 可能不存在
  getMemoryFiles.cache?.clear?.()
}

/**
 * 重置 `getMemoryFiles` 的 memoize 缓存，并**启用** InstructionsLoaded hook。
 *
 * 与 `clearMemoryFileCaches()` 的区别：
 * - 设置 `nextEagerLoadReason`，下次缓存未命中时以指定原因触发 hook
 * - 重新启用 `shouldFireHook` 标志
 * - 然后委托给 `clearMemoryFileCaches()` 清除缓存
 *
 * 适用于指令实际被重新加载进上下文的场景（如压缩后，reason 为 'compact'）。
 *
 * @param reason 触发 InstructionsLoaded hook 时报告的原因（默认 'session_start'）
 */
export function resetGetMemoryFilesCache(
  reason: InstructionsLoadReason = 'session_start',
): void {
  nextEagerLoadReason = reason
  shouldFireHook = true
  clearMemoryFileCaches()
}

/**
 * 从 MemoryFileInfo 列表中筛选出超过字符数上限的大文件。
 *
 * 供 /memory 界面等调用方展示警告，提醒用户某些记忆文件过大。
 *
 * @param files getMemoryFiles() 返回的文件列表
 * @returns 内容长度超过 MAX_MEMORY_CHARACTER_COUNT 的文件列表
 */
export function getLargeMemoryFiles(files: MemoryFileInfo[]): MemoryFileInfo[] {
  return files.filter(f => f.content.length > MAX_MEMORY_CHARACTER_COUNT)
}

/**
 * 根据 `tengu_moth_copse` 功能开关过滤注入系统提示的记忆文件。
 *
 * 当 `tengu_moth_copse` 开启时，`findRelevantMemories` 预取机制会通过 attachment
 * 注入记忆文件，因此 MEMORY.md 索引不再写入系统提示。关心"实际进入上下文的文件"
 * 的调用方（上下文构建器、/context 可视化）应通过本函数过滤。
 *
 * @param files 完整记忆文件列表
 * @returns 过滤后的文件列表（开关关闭时返回原列表，开启时去除 AutoMem / TeamMem）
 */
export function filterInjectedMemoryFiles(
  files: MemoryFileInfo[],
): MemoryFileInfo[] {
  const skipMemoryIndex = getFeatureValue_CACHED_MAY_BE_STALE(
    'tengu_moth_copse',
    false,
  )
  // 功能开关未启用时，所有文件均注入系统提示，无需过滤
  if (!skipMemoryIndex) return files
  // 开启时，AutoMem / TeamMem 通过 attachment 注入，从系统提示中排除
  return files.filter(f => f.type !== 'AutoMem' && f.type !== 'TeamMem')
}

/**
 * 将 MemoryFileInfo 列表格式化为注入系统提示的记忆文本。
 *
 * 格式为：
 * ```
 * <MEMORY_INSTRUCTION_PROMPT>
 *
 * Contents of <path> (<description>):
 *
 * <content>
 *
 * Contents of ...
 * ```
 * TeamMem 内容额外用 `<team-memory-content source="shared">` 包裹。
 *
 * `tengu_paper_halyard` 开关启用时跳过 Project / Local 类型文件。
 *
 * @param memoryFiles 记忆文件列表（通常来自 filterInjectedMemoryFiles 的结果）
 * @param filter 可选类型过滤函数，返回 false 的类型跳过
 * @returns 格式化后的系统提示字符串，无内容时返回空字符串
 */
export const getClaudeMds = (
  memoryFiles: MemoryFileInfo[],
  filter?: (type: MemoryType) => boolean,
): string => {
  const memories: string[] = []
  const skipProjectLevel = getFeatureValue_CACHED_MAY_BE_STALE(
    'tengu_paper_halyard',
    false,
  )

  for (const file of memoryFiles) {
    if (filter && !filter(file.type)) continue
    if (skipProjectLevel && (file.type === 'Project' || file.type === 'Local'))
      continue
    if (file.content) {
      const description =
        file.type === 'Project'
          ? ' (project instructions, checked into the codebase)'
          : file.type === 'Local'
            ? " (user's private project instructions, not checked in)"
            : feature('TEAMMEM') && file.type === 'TeamMem'
              ? ' (shared team memory, synced across the organization)'
              : file.type === 'AutoMem'
                ? " (user's auto-memory, persists across conversations)"
                : " (user's private global instructions for all projects)"

      const content = file.content.trim()
      if (feature('TEAMMEM') && file.type === 'TeamMem') {
        memories.push(
          `Contents of ${file.path}${description}:\n\n<team-memory-content source="shared">\n${content}\n</team-memory-content>`,
        )
      } else {
        memories.push(`Contents of ${file.path}${description}:\n\n${content}`)
      }
    }
  }

  if (memories.length === 0) {
    return ''
  }

  return `${MEMORY_INSTRUCTION_PROMPT}\n\n${memories.join('\n\n')}`
}

/**
 * 获取与目标路径匹配的 Managed 和 User 条件规则（嵌套内存加载的第一阶段）。
 *
 * 在嵌套内存加载流程中，本函数负责收集全局级别的条件规则：
 * 1. 始终处理 Managed（管理级）的 .claude/rules/ 目录中含 frontmatter globs 的规则文件
 * 2. 仅当 userSettings 启用时，额外处理 User（用户级）的 .claude/rules/ 条件规则
 *    User 规则启用 includeExternal=true，允许引用 CWD 以外的文件
 *
 * @param targetPath 目标文件路径，用于与规则的 frontmatter glob 模式进行匹配
 * @param processedPaths 已处理文件路径集合（会被本函数写入，防止重复加载）
 * @returns 所有与 targetPath 匹配的条件规则 MemoryFileInfo 数组
 */
export async function getManagedAndUserConditionalRules(
  targetPath: string,
  processedPaths: Set<string>,
): Promise<MemoryFileInfo[]> {
  const result: MemoryFileInfo[] = []

  // 处理 Managed（管理员下发）级别的条件规则：.claude/rules/*.md（含 frontmatter globs）
  const managedClaudeRulesDir = getManagedClaudeRulesDir()
  result.push(
    ...(await processConditionedMdRules(
      targetPath,
      managedClaudeRulesDir,
      'Managed',
      processedPaths,
      false, // Managed 规则不允许引用外部文件
    )),
  )

  if (isSettingSourceEnabled('userSettings')) {
    // userSettings 启用时，追加用户级条件规则
    const userClaudeRulesDir = getUserClaudeRulesDir()
    result.push(
      ...(await processConditionedMdRules(
        targetPath,
        userClaudeRulesDir,
        'User',
        processedPaths,
        true, // User 规则允许 @include 引用 CWD 外部文件
      )),
    )
  }

  return result
}

/**
 * 为单个嵌套目录（CWD 与目标文件之间的某一层级）加载内存文件。
 *
 * 对指定目录依次执行：
 * 1. 加载 CLAUDE.md 和 .claude/CLAUDE.md（Project 类型，需 projectSettings 启用）
 * 2. 加载 CLAUDE.local.md（Local 类型，需 localSettings 启用）
 * 3. 加载该目录 .claude/rules/ 下的无条件规则（unconditional，conditionalRule=false）
 *    使用独立的 unconditionalProcessedPaths 集合，避免把无条件规则路径提前写入
 *    主集合而导致后续条件规则加载时误判为"已处理"
 * 4. 加载该目录 .claude/rules/ 下与 targetPath 匹配的条件规则（conditionalRule=true）
 * 5. 将独立集合中的路径合并回主 processedPaths，供后续更高层目录使用
 *
 * @param dir 要处理的嵌套目录路径
 * @param targetPath 目标文件路径（用于条件规则 glob 匹配）
 * @param processedPaths 已处理文件路径集合（会被本函数写入）
 * @returns 该目录下所有匹配的 MemoryFileInfo 数组
 */
export async function getMemoryFilesForNestedDirectory(
  dir: string,
  targetPath: string,
  processedPaths: Set<string>,
): Promise<MemoryFileInfo[]> {
  const result: MemoryFileInfo[] = []

  // 加载项目级内存文件：CLAUDE.md 和 .claude/CLAUDE.md
  if (isSettingSourceEnabled('projectSettings')) {
    const projectPath = join(dir, 'CLAUDE.md')
    result.push(
      ...(await processMemoryFile(
        projectPath,
        'Project',
        processedPaths,
        false,
      )),
    )
    const dotClaudePath = join(dir, '.claude', 'CLAUDE.md')
    result.push(
      ...(await processMemoryFile(
        dotClaudePath,
        'Project',
        processedPaths,
        false,
      )),
    )
  }

  // 加载本地私有内存文件：CLAUDE.local.md（不提交到版本库）
  if (isSettingSourceEnabled('localSettings')) {
    const localPath = join(dir, 'CLAUDE.local.md')
    result.push(
      ...(await processMemoryFile(localPath, 'Local', processedPaths, false)),
    )
  }

  const rulesDir = join(dir, '.claude', 'rules')

  // 加载该目录下未经急加载的无条件规则（conditionalRule=false）
  // 使用独立集合，避免无条件规则路径污染主 processedPaths，
  // 导致后续条件规则（conditionalRule=true）被误认为已处理而跳过
  const unconditionalProcessedPaths = new Set(processedPaths)
  result.push(
    ...(await processMdRules({
      rulesDir,
      type: 'Project',
      processedPaths: unconditionalProcessedPaths,
      includeExternal: false,
      conditionalRule: false,
    })),
  )

  // 加载该目录下与 targetPath 匹配的条件规则（含 frontmatter globs 的规则文件）
  result.push(
    ...(await processConditionedMdRules(
      targetPath,
      rulesDir,
      'Project',
      processedPaths,
      false,
    )),
  )

  // 将无条件规则路径合并回主集合，供后续更高层级目录使用
  for (const path of unconditionalProcessedPaths) {
    processedPaths.add(path)
  }

  return result
}

/**
 * 获取 CWD 层级目录（从根目录到 CWD 路径上各节点）的条件规则。
 *
 * 与 `getMemoryFilesForNestedDirectory` 不同，此函数仅处理条件规则（conditionalRule=true），
 * 因为 CWD 层级的无条件规则已在启动时急加载（eagerly loaded）。
 * 直接委托给 `processConditionedMdRules`，传入该目录的 .claude/rules 路径。
 *
 * @param dir 要处理的目录路径（CWD 或其祖先目录之一）
 * @param targetPath 目标文件路径（用于 frontmatter glob 匹配）
 * @param processedPaths 已处理文件路径集合（会被本函数写入）
 * @returns 与 targetPath 匹配的条件规则 MemoryFileInfo 数组
 */
export async function getConditionalRulesForCwdLevelDirectory(
  dir: string,
  targetPath: string,
  processedPaths: Set<string>,
): Promise<MemoryFileInfo[]> {
  // 组装该目录的 .claude/rules 路径，直接委托条件规则处理
  const rulesDir = join(dir, '.claude', 'rules')
  return processConditionedMdRules(
    targetPath,
    rulesDir,
    'Project',
    processedPaths,
    false, // CWD 层级 Project 规则不引用外部文件
  )
}

/**
 * 扫描 .claude/rules/ 目录下所有 .md 文件，过滤出 frontmatter globs 与目标路径匹配的条件规则。
 *
 * 处理流程：
 * 1. 调用 `processMdRules` 读取 rulesDir 下全部 .md 文件（conditionalRule=true，
 *    即仅返回含 frontmatter `paths:` 字段的规则文件）
 * 2. 对每个文件，根据 type 计算 glob 匹配的基准目录：
 *    - Project：取 rulesDir 所属 .claude/ 的父目录（即项目根目录）
 *    - Managed / User：取 getOriginalCwd()（启动时的工作目录）
 * 3. 将 targetPath 转为相对于 baseDir 的路径；若路径逃逸（以 `../` 开头）
 *    或为绝对路径（Windows 跨驱动器 relative() 可能返回绝对路径），直接排除
 * 4. 使用 `ignore().add(file.globs).ignores(relativePath)` 执行 gitignore 风格匹配
 *
 * @param targetPath 目标文件路径（绝对或相对），用于与规则 frontmatter 中的 glob 模式匹配
 * @param rulesDir .claude/rules/ 目录路径
 * @param type 规则类型（User / Project / Managed），影响 glob 基准目录选择
 * @param processedPaths 已处理路径集合（写入，防止重复加载）
 * @param includeExternal 是否允许 @include 引用 CWD 外部文件
 * @returns 与 targetPath 匹配的规则 MemoryFileInfo 数组
 */
export async function processConditionedMdRules(
  targetPath: string,
  rulesDir: string,
  type: MemoryType,
  processedPaths: Set<string>,
  includeExternal: boolean,
): Promise<MemoryFileInfo[]> {
  // 先加载所有含 frontmatter globs 的条件规则文件
  const conditionedRuleMdFiles = await processMdRules({
    rulesDir,
    type,
    processedPaths,
    includeExternal,
    conditionalRule: true,
  })

  // 过滤：仅保留 globs 不为空且与 targetPath 匹配的规则文件
  return conditionedRuleMdFiles.filter(file => {
    if (!file.globs || file.globs.length === 0) {
      // 无 globs 的条件规则文件不应出现在此，但做防御性过滤
      return false
    }

    // Project 规则：glob 相对于 .claude 的父目录（即项目根）
    // Managed/User 规则：glob 相对于启动时 CWD
    const baseDir =
      type === 'Project'
        ? dirname(dirname(rulesDir)) // .claude/rules → .claude → 项目根
        : getOriginalCwd() // 管理/用户规则统一以启动 CWD 为基准

    // 将 targetPath 转为相对路径，用于 gitignore 风格 glob 匹配
    const relativePath = isAbsolute(targetPath)
      ? relative(baseDir, targetPath)
      : targetPath
    // ignore() 对空字符串、逃逸路径（../）和绝对路径会抛出异常；
    // CWD 外部路径本身也无法匹配 baseDir 相对的 glob，直接排除
    if (
      !relativePath ||
      relativePath.startsWith('..') ||
      isAbsolute(relativePath)
    ) {
      return false
    }
    // 使用 ignore 库执行 gitignore 风格的 glob 匹配
    return ignore().add(file.globs).ignores(relativePath)
  })
}

export type ExternalClaudeMdInclude = {
  path: string
  parent: string
}

/**
 * 收集内存文件列表中所有外部引用（@include 指向 CWD 以外的文件）。
 *
 * 判断条件：
 * - 文件类型不为 'User'（User 级规则允许引用外部文件，无需警告）
 * - 文件有 parent 字段（即通过 @include 引入，而非直接发现）
 * - 文件路径不在当前工作目录（pathInOriginalCwd 返回 false）
 *
 * @param files MemoryFileInfo 数组（通常由 getMemoryFiles 返回）
 * @returns 外部引用信息数组，每项包含 path（被引用文件）和 parent（引用方文件）
 */
export function getExternalClaudeMdIncludes(
  files: MemoryFileInfo[],
): ExternalClaudeMdInclude[] {
  const externals: ExternalClaudeMdInclude[] = []
  for (const file of files) {
    // 非 User 类型、来自 @include、且路径在 CWD 以外 → 视为外部引用
    if (file.type !== 'User' && file.parent && !pathInOriginalCwd(file.path)) {
      externals.push({ path: file.path, parent: file.parent })
    }
  }
  return externals
}

/**
 * 判断内存文件列表中是否存在外部引用（CWD 以外的 @include 文件）。
 *
 * 是 `getExternalClaudeMdIncludes` 的布尔值包装，
 * 供调用方快速判断是否需要显示外部引用警告，而无需处理数组细节。
 *
 * @param files MemoryFileInfo 数组
 * @returns 存在外部引用时返回 true，否则返回 false
 */
export function hasExternalClaudeMdIncludes(files: MemoryFileInfo[]): boolean {
  return getExternalClaudeMdIncludes(files).length > 0
}

/**
 * 判断是否需要向用户显示外部 @include 引用警告。
 *
 * 若满足以下任一条件则跳过警告（返回 false）：
 * - 用户已主动批准外部引用（hasClaudeMdExternalIncludesApproved=true）
 * - 警告在本次会话中已显示过（hasClaudeMdExternalIncludesWarningShown=true）
 *
 * 否则，重新加载内存文件（includeProjectFiles=true）并检查是否存在外部引用。
 *
 * @returns 需要显示警告时返回 true，否则返回 false
 */
export async function shouldShowClaudeMdExternalIncludesWarning(): Promise<boolean> {
  const config = getCurrentProjectConfig()
  if (
    config.hasClaudeMdExternalIncludesApproved ||      // 用户已批准，跳过警告
    config.hasClaudeMdExternalIncludesWarningShown     // 已显示过，避免重复提示
  ) {
    return false
  }

  // 重新加载含 Project 文件的内存列表，检查是否存在外部引用
  return hasExternalClaudeMdIncludes(await getMemoryFiles(true))
}

/**
 * 判断给定文件路径是否为内存文件（CLAUDE.md、CLAUDE.local.md 或 .claude/rules/*.md）。
 *
 * 判断规则（两条，任一满足即返回 true）：
 * 1. 文件名为 "CLAUDE.md" 或 "CLAUDE.local.md"（不限目录深度）
 * 2. 文件名以 ".md" 结尾，且路径中包含 `.claude/rules/`（或 Windows 下 `.claude\rules\`）
 *
 * 用于在 readFileState 缓存中快速筛选内存文件路径，
 * 以便 `getAllMemoryFilePaths` 合并子目录中的内存文件。
 *
 * @param filePath 待判断的文件路径（绝对或相对均可）
 * @returns 是内存文件路径时返回 true，否则返回 false
 */
export function isMemoryFilePath(filePath: string): boolean {
  const name = basename(filePath)

  // 规则 1：文件名为 CLAUDE.md 或 CLAUDE.local.md（任意目录深度）
  if (name === 'CLAUDE.md' || name === 'CLAUDE.local.md') {
    return true
  }

  // 规则 2：.md 扩展名且路径包含 .claude/rules/ 分隔符（跨平台兼容）
  if (
    name.endsWith('.md') &&
    filePath.includes(`${sep}.claude${sep}rules${sep}`)
  ) {
    return true
  }

  return false
}

/**
 * 获取所有内存文件路径，合并标准发现路径和 readFileState 缓存中的内存文件路径。
 *
 * 两个来源：
 * 1. `getMemoryFiles()` 返回的 MemoryFileInfo 列表（CWD 向上到根目录的标准加载）
 *    仅包含内容非空的文件路径，过滤空文件避免无意义的监视
 * 2. readFileState 缓存键中满足 `isMemoryFilePath()` 的路径
 *    可覆盖子目录（CWD 以下）中用户手动打开的 CLAUDE.md / rules/*.md 文件
 *
 * 使用 Set 自动去重后转为数组返回。
 *
 * @param files getMemoryFiles() 返回的 MemoryFileInfo 数组
 * @param readFileState 当前会话的文件状态缓存
 * @returns 去重后的内存文件绝对路径数组
 */
export function getAllMemoryFilePaths(
  files: MemoryFileInfo[],
  readFileState: FileStateCache,
): string[] {
  const paths = new Set<string>()
  // 来源 1：标准加载的内存文件，仅收录内容非空的文件
  for (const file of files) {
    if (file.content.trim().length > 0) {
      paths.add(file.path)
    }
  }

  // 来源 2：readFileState 中满足内存文件命名规则的路径（含子目录）
  for (const filePath of cacheKeys(readFileState)) {
    if (isMemoryFilePath(filePath)) {
      paths.add(filePath)
    }
  }

  return Array.from(paths)
}
