/**
 * FileReadTool.ts — 文件读取工具核心实现
 *
 * 【在 Claude Code 系统中的位置】
 * 本文件是 Claude Code 工具链中最核心的文件读取入口，位于 src/tools/FileReadTool/ 目录下。
 * 它被 Claude 主循环调用，当模型需要查看本地文件内容时会触发此工具。
 *
 * 【主要功能】
 * - 支持读取文本文件（带行号、分页）、图片（PNG/JPG/GIF/WebP）、PDF、Jupyter Notebook
 * - 内置去重机制（readFileState），避免在同一会话中重复传输未变更文件
 * - 对图片进行 token 预算内的压缩处理
 * - 对 PDF 支持按页范围提取
 * - 权限检查（deny 规则、UNC 路径、设备文件屏蔽等）
 * - 通过 fileReadListeners 通知其他服务文件已被读取
 * - 触发技能目录发现（skills）与条件技能激活
 * - 记录分析埋点（文件大小、行数、Token 数等）
 */

import type { Base64ImageSource } from '@anthropic-ai/sdk/resources/index.mjs'
import { readdir, readFile as readFileAsync } from 'fs/promises'
import * as path from 'path'
import { posix, win32 } from 'path'
import { z } from 'zod/v4'
import {
  PDF_AT_MENTION_INLINE_THRESHOLD,
  PDF_EXTRACT_SIZE_THRESHOLD,
  PDF_MAX_PAGES_PER_READ,
} from '../../constants/apiLimits.js'
import { hasBinaryExtension } from '../../constants/files.js'
import { memoryFreshnessNote } from '../../memdir/memoryAge.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import { logEvent } from '../../services/analytics/index.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  getFileExtensionForAnalytics,
} from '../../services/analytics/metadata.js'
import {
  countTokensWithAPI,
  roughTokenCountEstimationForFileType,
} from '../../services/tokenEstimation.js'
import {
  activateConditionalSkillsForPaths,
  addSkillDirectories,
  discoverSkillDirsForPaths,
} from '../../skills/loadSkillsDir.js'
import type { ToolUseContext } from '../../Tool.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { getCwd } from '../../utils/cwd.js'
import { getClaudeConfigHomeDir, isEnvTruthy } from '../../utils/envUtils.js'
import { getErrnoCode, isENOENT } from '../../utils/errors.js'
import {
  addLineNumbers,
  FILE_NOT_FOUND_CWD_NOTE,
  findSimilarFile,
  getFileModificationTimeAsync,
  suggestPathUnderCwd,
} from '../../utils/file.js'
import { logFileOperation } from '../../utils/fileOperationAnalytics.js'
import { formatFileSize } from '../../utils/format.js'
import { getFsImplementation } from '../../utils/fsOperations.js'
import {
  compressImageBufferWithTokenLimit,
  createImageMetadataText,
  detectImageFormatFromBuffer,
  type ImageDimensions,
  ImageResizeError,
  maybeResizeAndDownsampleImageBuffer,
} from '../../utils/imageResizer.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { logError } from '../../utils/log.js'
import { isAutoMemFile } from '../../utils/memoryFileDetection.js'
import { createUserMessage } from '../../utils/messages.js'
import { getCanonicalName, getMainLoopModel } from '../../utils/model/model.js'
import {
  mapNotebookCellsToToolResult,
  readNotebook,
} from '../../utils/notebook.js'
import { expandPath } from '../../utils/path.js'
import { extractPDFPages, getPDFPageCount, readPDF } from '../../utils/pdf.js'
import {
  isPDFExtension,
  isPDFSupported,
  parsePDFPageRange,
} from '../../utils/pdfUtils.js'
import {
  checkReadPermissionForTool,
  matchingRuleForInput,
} from '../../utils/permissions/filesystem.js'
import type { PermissionDecision } from '../../utils/permissions/PermissionResult.js'
import { matchWildcardPattern } from '../../utils/permissions/shellRuleMatching.js'
import { readFileInRange } from '../../utils/readFileInRange.js'
import { semanticNumber } from '../../utils/semanticNumber.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { BASH_TOOL_NAME } from '../BashTool/toolName.js'
import { getDefaultFileReadingLimits } from './limits.js'
import {
  DESCRIPTION,
  FILE_READ_TOOL_NAME,
  FILE_UNCHANGED_STUB,
  LINE_FORMAT_INSTRUCTION,
  OFFSET_INSTRUCTION_DEFAULT,
  OFFSET_INSTRUCTION_TARGETED,
  renderPromptTemplate,
} from './prompt.js'
import {
  getToolUseSummary,
  renderToolResultMessage,
  renderToolUseErrorMessage,
  renderToolUseMessage,
  renderToolUseTag,
  userFacingName,
} from './UI.js'

// 会导致进程挂起的设备文件路径集合：无限输出或阻塞输入的设备
// 仅通过路径检查，不进行 I/O。/dev/null 等安全设备被故意排除在外。
const BLOCKED_DEVICE_PATHS = new Set([
  // 无限输出 — 永远不会到达 EOF
  '/dev/zero',
  '/dev/random',
  '/dev/urandom',
  '/dev/full',
  // 等待输入时会阻塞进程
  '/dev/stdin',
  '/dev/tty',
  '/dev/console',
  // 读取无意义
  '/dev/stdout',
  '/dev/stderr',
  // stdin/stdout/stderr 的 fd 别名
  '/dev/fd/0',
  '/dev/fd/1',
  '/dev/fd/2',
])

/**
 * 检查给定文件路径是否为被屏蔽的设备文件。
 * 纯路径字符串检查，不产生任何 I/O。
 *
 * @param filePath - 要检查的文件路径
 * @returns 如果是被屏蔽的设备文件则返回 true
 */
function isBlockedDevicePath(filePath: string): boolean {
  // 直接查询已知设备路径集合
  if (BLOCKED_DEVICE_PATHS.has(filePath)) return true
  // /proc/self/fd/0-2 和 /proc/<pid>/fd/0-2 是 Linux 上 stdio 的别名
  if (
    filePath.startsWith('/proc/') &&
    (filePath.endsWith('/fd/0') ||
      filePath.endsWith('/fd/1') ||
      filePath.endsWith('/fd/2'))
  )
    return true
  return false
}

// macOS 部分版本在截图文件名中使用窄不换行空格（U+202F）替代普通空格
const THIN_SPACE = String.fromCharCode(8239)

/**
 * Resolves macOS screenshot paths that may have different space characters.
 * macOS uses either regular space or thin space (U+202F) before AM/PM in screenshot
 * filenames depending on the macOS version. This function tries the alternate space
 * character if the file doesn't exist with the given path.
 *
 * @param filePath - The normalized file path to resolve
 * @returns The path to the actual file on disk (may differ in space character)
 */
/**
 * 处理 macOS 截图路径中 AM/PM 前空格字符不一致的问题。
 * macOS 不同版本在截图文件名的 AM/PM 前使用普通空格或窄不换行空格。
 * 若原路径不存在，返回替换了空格字符的备用路径；若文件名不匹配此模式则返回 undefined。
 *
 * @param filePath - 已规范化的文件路径
 * @returns 备用路径字符串，或 undefined（路径不符合截图命名模式）
 */
function getAlternateScreenshotPath(filePath: string): string | undefined {
  // 获取文件名部分
  const filename = path.basename(filePath)
  // 匹配形如 "Screenshot ... 3.42 PM.png" 中 AM/PM 前的空格字符
  const amPmPattern = /^(.+)([ \u202F])(AM|PM)(\.png)$/
  const match = filename.match(amPmPattern)
  if (!match) return undefined

  // 确定当前使用的空格类型，切换为另一种
  const currentSpace = match[2]
  const alternateSpace = currentSpace === ' ' ? THIN_SPACE : ' '
  // 替换空格字符并返回新路径
  return filePath.replace(
    `${currentSpace}${match[3]}${match[4]}`,
    `${alternateSpace}${match[3]}${match[4]}`,
  )
}

// 文件读取监听器列表 — 允许其他服务在文件被读取时收到通知
type FileReadListener = (filePath: string, content: string) => void
const fileReadListeners: FileReadListener[] = []

/**
 * 注册一个文件读取监听器，当文件被读取后会收到回调。
 * 返回一个取消注册函数，调用后该监听器将不再接收通知。
 *
 * @param listener - 当文件被读取时调用的回调函数
 * @returns 取消注册该监听器的函数
 */
export function registerFileReadListener(
  listener: FileReadListener,
): () => void {
  // 将监听器加入全局列表
  fileReadListeners.push(listener)
  // 返回取消注册函数
  return () => {
    const i = fileReadListeners.indexOf(listener)
    if (i >= 0) fileReadListeners.splice(i, 1) // 从列表中移除该监听器
  }
}

/**
 * 当文件内容 Token 数超过允许上限时抛出此错误。
 * 提示用户使用 offset/limit 参数读取文件的特定片段。
 */
export class MaxFileReadTokenExceededError extends Error {
  constructor(
    public tokenCount: number,
    public maxTokens: number,
  ) {
    super(
      `File content (${tokenCount} tokens) exceeds maximum allowed tokens (${maxTokens}). Use offset and limit parameters to read specific portions of the file, or search for specific content instead of reading the whole file.`,
    )
    this.name = 'MaxFileReadTokenExceededError'
  }
}

// 常见图片扩展名集合，用于快速判断文件是否为图片
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp'])

/**
 * 检测给定文件路径是否属于会话相关文件（用于分析埋点）。
 * 仅匹配 Claude 配置目录（~/.claude）内的文件。
 * 返回文件类型或 null（不是会话文件）。
 *
 * @param filePath - 要检测的文件路径
 * @returns 'session_memory' | 'session_transcript' | null
 */
function detectSessionFileType(
  filePath: string,
): 'session_memory' | 'session_transcript' | null {
  // 获取 Claude 配置目录路径
  const configDir = getClaudeConfigHomeDir()

  // 仅匹配 Claude 配置目录内的文件
  if (!filePath.startsWith(configDir)) {
    return null
  }

  // 统一使用正斜杠进行跨平台路径匹配
  const normalizedPath = filePath.split(win32.sep).join(posix.sep)

  // 会话记忆文件：~/.claude/session-memory/*.md（含 summary.md）
  if (
    normalizedPath.includes('/session-memory/') &&
    normalizedPath.endsWith('.md')
  ) {
    return 'session_memory'
  }

  // 会话 JSONL 转录文件：~/.claude/projects/*/*.jsonl
  if (
    normalizedPath.includes('/projects/') &&
    normalizedPath.endsWith('.jsonl')
  ) {
    return 'session_transcript'
  }

  return null
}

// 工具输入参数的 Zod Schema（懒加载以减少启动开销）
const inputSchema = lazySchema(() =>
  z.strictObject({
    file_path: z.string().describe('The absolute path to the file to read'),
    // offset：从第几行开始读取（仅在文件过大时提供）
    offset: semanticNumber(z.number().int().nonnegative().optional()).describe(
      'The line number to start reading from. Only provide if the file is too large to read at once',
    ),
    // limit：最多读取多少行（仅在文件过大时提供）
    limit: semanticNumber(z.number().int().positive().optional()).describe(
      'The number of lines to read. Only provide if the file is too large to read at once.',
    ),
    // pages：PDF 页范围（仅对 PDF 文件有效）
    pages: z
      .string()
      .optional()
      .describe(
        `Page range for PDF files (e.g., "1-5", "3", "10-20"). Only applicable to PDF files. Maximum ${PDF_MAX_PAGES_PER_READ} pages per request.`,
      ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

export type Input = z.infer<InputSchema>

// 工具输出结果的 Zod Schema，使用判别联合（discriminated union）区分不同文件类型
const outputSchema = lazySchema(() => {
  // 图片媒体类型枚举
  const imageMediaTypes = z.enum([
    'image/jpeg',
    'image/png',
    'image/gif',
    'image/webp',
  ])

  return z.discriminatedUnion('type', [
    // 文本文件输出
    z.object({
      type: z.literal('text'),
      file: z.object({
        filePath: z.string().describe('The path to the file that was read'),
        content: z.string().describe('The content of the file'),
        numLines: z
          .number()
          .describe('Number of lines in the returned content'),
        startLine: z.number().describe('The starting line number'),
        totalLines: z.number().describe('Total number of lines in the file'),
      }),
    }),
    // 图片文件输出（base64 编码）
    z.object({
      type: z.literal('image'),
      file: z.object({
        base64: z.string().describe('Base64-encoded image data'),
        type: imageMediaTypes.describe('The MIME type of the image'),
        originalSize: z.number().describe('Original file size in bytes'),
        dimensions: z
          .object({
            originalWidth: z
              .number()
              .optional()
              .describe('Original image width in pixels'),
            originalHeight: z
              .number()
              .optional()
              .describe('Original image height in pixels'),
            displayWidth: z
              .number()
              .optional()
              .describe('Displayed image width in pixels (after resizing)'),
            displayHeight: z
              .number()
              .optional()
              .describe('Displayed image height in pixels (after resizing)'),
          })
          .optional()
          .describe('Image dimension info for coordinate mapping'),
      }),
    }),
    // Jupyter Notebook 输出（cell 数组）
    z.object({
      type: z.literal('notebook'),
      file: z.object({
        filePath: z.string().describe('The path to the notebook file'),
        cells: z.array(z.any()).describe('Array of notebook cells'),
      }),
    }),
    // PDF 文件输出（base64 编码的整个 PDF）
    z.object({
      type: z.literal('pdf'),
      file: z.object({
        filePath: z.string().describe('The path to the PDF file'),
        base64: z.string().describe('Base64-encoded PDF data'),
        originalSize: z.number().describe('Original file size in bytes'),
      }),
    }),
    // PDF 按页提取输出（图片文件目录）
    z.object({
      type: z.literal('parts'),
      file: z.object({
        filePath: z.string().describe('The path to the PDF file'),
        originalSize: z.number().describe('Original file size in bytes'),
        count: z.number().describe('Number of pages extracted'),
        outputDir: z
          .string()
          .describe('Directory containing extracted page images'),
      }),
    }),
    // 文件未变更（去重 stub）
    z.object({
      type: z.literal('file_unchanged'),
      file: z.object({
        filePath: z.string().describe('The path to the file'),
      }),
    }),
  ])
})
type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.infer<OutputSchema>

/**
 * FileReadTool — Claude Code 文件读取工具定义
 *
 * 整体流程：
 * 1. prompt() 生成提示词，描述工具用途与参数说明
 * 2. validateInput() 做纯字符串/路径层面的前置校验（无 I/O）
 * 3. checkPermissions() 调用权限系统判断是否允许读取
 * 4. call() 执行实际读取逻辑，根据文件类型分派到不同处理路径
 * 5. mapToolResultToToolResultBlockParam() 将结果序列化为 API 消息块
 */
export const FileReadTool = buildTool({
  name: FILE_READ_TOOL_NAME,
  searchHint: 'read files, images, PDFs, notebooks',
  // 输出大小由 validateContentTokens 中的 maxTokens 限制，不依赖字符数上限
  maxResultSizeChars: Infinity,
  strict: true,
  /** 返回工具功能描述字符串 */
  async description() {
    return DESCRIPTION
  },
  /**
   * 生成工具的提示词文本。
   * 根据当前限制配置动态插入文件大小说明和偏移量说明。
   */
  async prompt() {
    const limits = getDefaultFileReadingLimits()
    // 若配置要求在提示词中展示最大文件大小，则生成对应说明
    const maxSizeInstruction = limits.includeMaxSizeInPrompt
      ? `. Files larger than ${formatFileSize(limits.maxSizeBytes)} will return an error; use offset and limit for larger files`
      : ''
    // 根据是否启用精准范围提示选择不同的偏移量说明
    const offsetInstruction = limits.targetedRangeNudge
      ? OFFSET_INSTRUCTION_TARGETED
      : OFFSET_INSTRUCTION_DEFAULT
    return renderPromptTemplate(
      pickLineFormatInstruction(),
      maxSizeInstruction,
      offsetInstruction,
    )
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  userFacingName,
  getToolUseSummary,
  /** 返回活动描述字符串，供 UI 展示当前操作 */
  getActivityDescription(input) {
    const summary = getToolUseSummary(input)
    return summary ? `Reading ${summary}` : 'Reading file'
  },
  /** 文件读取是并发安全的（只读操作） */
  isConcurrencySafe() {
    return true
  },
  /** 文件读取是只读操作 */
  isReadOnly() {
    return true
  },
  /** 返回用于自动分类器的输入字符串（文件路径） */
  toAutoClassifierInput(input) {
    return input.file_path
  },
  /** 标记为读操作（非搜索操作） */
  isSearchOrReadCommand() {
    return { isSearch: false, isRead: true }
  },
  /** 返回文件路径，用于权限检查和日志 */
  getPath({ file_path }): string {
    return file_path || getCwd()
  },
  /**
   * 在观察输入之前展开路径（将 ~ 和相对路径转为绝对路径），
   * 防止 hook 允许列表被 ~ 或相对路径绕过。
   */
  backfillObservableInput(input) {
    // hooks.mdx 要求 file_path 为绝对路径；展开以防 ~ 或相对路径绕过 hook 允许列表
    if (typeof input.file_path === 'string') {
      input.file_path = expandPath(input.file_path)
    }
  },
  /** 准备权限匹配器，用于与通配符规则进行匹配 */
  async preparePermissionMatcher({ file_path }) {
    return pattern => matchWildcardPattern(pattern, file_path)
  },
  /**
   * 检查读取权限。
   * 查询应用状态中的工具权限上下文，返回 allow/deny/ask 决策。
   */
  async checkPermissions(input, context): Promise<PermissionDecision> {
    const appState = context.getAppState()
    return checkReadPermissionForTool(
      FileReadTool,
      input,
      appState.toolPermissionContext,
    )
  },
  renderToolUseMessage,
  renderToolUseTag,
  renderToolResultMessage,
  // UI.tsx:140 — 所有类型仅渲染摘要 chrome（如 "Read N lines"、"Read image (42KB)"）
  // 不渲染内容本身。模型侧序列化（下方）会附加内容 + 提醒 + 行号前缀；UI 不展示这些。
  // 无需索引内容，测试中已验证此处返回空字符串的正确性。
  extractSearchText() {
    return ''
  },
  renderToolUseErrorMessage,
  /**
   * 输入验证（无 I/O 的前置检查）。
   * 按顺序执行：pages 格式校验 → 路径展开 → deny 规则 → UNC 路径 → 二进制扩展名 → 设备文件屏蔽
   */
  async validateInput({ file_path, pages }, toolUseContext: ToolUseContext) {
    // 校验 pages 参数格式（纯字符串解析，无 I/O）
    if (pages !== undefined) {
      const parsed = parsePDFPageRange(pages)
      if (!parsed) {
        return {
          result: false,
          message: `Invalid pages parameter: "${pages}". Use formats like "1-5", "3", or "10-20". Pages are 1-indexed.`,
          errorCode: 7,
        }
      }
      // 检查页范围是否超过单次最大读取页数
      const rangeSize =
        parsed.lastPage === Infinity
          ? PDF_MAX_PAGES_PER_READ + 1
          : parsed.lastPage - parsed.firstPage + 1
      if (rangeSize > PDF_MAX_PAGES_PER_READ) {
        return {
          result: false,
          message: `Page range "${pages}" exceeds maximum of ${PDF_MAX_PAGES_PER_READ} pages per request. Please use a smaller range.`,
          errorCode: 8,
        }
      }
    }

    // 展开路径 + 检查 deny 规则（无 I/O）
    const fullFilePath = expandPath(file_path)

    const appState = toolUseContext.getAppState()
    // 查找匹配 deny 规则
    const denyRule = matchingRuleForInput(
      fullFilePath,
      appState.toolPermissionContext,
      'read',
      'deny',
    )
    if (denyRule !== null) {
      return {
        result: false,
        message:
          'File is in a directory that is denied by your permission settings.',
        errorCode: 1,
      }
    }

    // 安全：UNC 路径检查（无 I/O）— 将文件系统操作延迟到用户授权之后，防止 NTLM 凭据泄漏
    const isUncPath =
      fullFilePath.startsWith('\\\\') || fullFilePath.startsWith('//')
    if (isUncPath) {
      return { result: true }
    }

    // 二进制扩展名检查（仅字符串操作，无 I/O）
    // PDF、图片、SVG 被排除，因为此工具可以原生处理它们
    const ext = path.extname(fullFilePath).toLowerCase()
    if (
      hasBinaryExtension(fullFilePath) &&
      !isPDFExtension(ext) &&
      !IMAGE_EXTENSIONS.has(ext.slice(1))
    ) {
      return {
        result: false,
        message: `This tool cannot read binary files. The file appears to be a binary ${ext} file. Please use appropriate tools for binary file analysis.`,
        errorCode: 4,
      }
    }

    // 屏蔽会导致进程挂起的设备文件（无限输出或阻塞输入）
    // 纯路径检查，无 I/O；/dev/null 等安全设备不受影响
    if (isBlockedDevicePath(fullFilePath)) {
      return {
        result: false,
        message: `Cannot read '${file_path}': this device file would block or produce infinite output.`,
        errorCode: 9,
      }
    }

    return { result: true }
  },
  /**
   * 执行文件读取的主函数。
   *
   * 流程：
   * 1. 获取读取限制（maxSizeBytes, maxTokens）
   * 2. 去重检查（readFileState + mtime 对比）
   * 3. 触发技能发现与激活
   * 4. 调用 callInner 完成实际读取
   * 5. ENOENT 时尝试 macOS 截图路径备用，并提供相似文件建议
   */
  async call(
    { file_path, offset = 1, limit = undefined, pages },
    context,
    _canUseTool?,
    parentMessage?,
  ) {
    const { readFileState, fileReadingLimits } = context

    // 获取本次读取的大小和 token 上限（优先使用上下文中的覆盖值）
    const defaults = getDefaultFileReadingLimits()
    const maxSizeBytes =
      fileReadingLimits?.maxSizeBytes ?? defaults.maxSizeBytes
    const maxTokens = fileReadingLimits?.maxTokens ?? defaults.maxTokens

    // 遥测：记录调用方覆盖了默认读取限制的情况（仅在覆盖时触发，低频事件）
    if (fileReadingLimits !== undefined) {
      logEvent('tengu_file_read_limits_override', {
        hasMaxTokens: fileReadingLimits.maxTokens !== undefined,
        hasMaxSizeBytes: fileReadingLimits.maxSizeBytes !== undefined,
      })
    }

    // 提取文件扩展名（小写，去掉点）
    const ext = path.extname(file_path).toLowerCase().slice(1)
    // 使用 expandPath 统一路径规范化（与 FileEditTool/FileWriteTool 保持一致）
    const fullFilePath = expandPath(file_path)

    // 去重逻辑：若已读取过相同范围且文件未变更，返回 stub 而非完整内容。
    // 早期的 Read 工具结果仍在上下文中——发送两份完整内容会在每轮对话中
    // 浪费 cache_creation token。BQ 代理数据显示约 18% 的 Read 调用存在同文件碰撞。
    // 仅适用于文本/notebook 读取——图片/PDF 不缓存在 readFileState 中，不会命中此处。
    //
    // 通过 GrowthBook 特性开关 tengu_read_dedup_killswitch 可紧急关闭此功能
    const dedupKillswitch = getFeatureValue_CACHED_MAY_BE_STALE(
      'tengu_read_dedup_killswitch',
      false,
    )
    // 若杀开关未激活，则尝试读取已缓存的状态
    const existingState = dedupKillswitch
      ? undefined
      : readFileState.get(fullFilePath)
    // 仅对来自上一次 Read 调用的条目去重（offset 必须有值）
    // Edit/Write 存储的条目 offset=undefined——它们反映编辑后的 mtime，
    // 若对其去重会错误地将模型指向编辑前的 Read 内容
    if (
      existingState &&
      !existingState.isPartialView &&
      existingState.offset !== undefined
    ) {
      // 检查读取范围是否完全匹配
      const rangeMatch =
        existingState.offset === offset && existingState.limit === limit
      if (rangeMatch) {
        try {
          // 异步获取文件修改时间
          const mtimeMs = await getFileModificationTimeAsync(fullFilePath)
          if (mtimeMs === existingState.timestamp) {
            // 文件未变更，记录去重事件并返回 stub
            const analyticsExt = getFileExtensionForAnalytics(fullFilePath)
            logEvent('tengu_file_read_dedup', {
              ...(analyticsExt !== undefined && { ext: analyticsExt }),
            })
            return {
              data: {
                type: 'file_unchanged' as const,
                file: { filePath: file_path },
              },
            }
          }
        } catch {
          // stat 失败 — 回退到完整读取
        }
      }
    }

    // 从此文件路径发现技能目录（fire-and-forget，不阻塞主流程）
    // 简单模式下跳过此步骤（无技能可用）
    const cwd = getCwd()
    if (!isEnvTruthy(process.env.CLAUDE_CODE_SIMPLE)) {
      const newSkillDirs = await discoverSkillDirsForPaths([fullFilePath], cwd)
      if (newSkillDirs.length > 0) {
        // 记录发现的目录以供 UI 展示
        for (const dir of newSkillDirs) {
          context.dynamicSkillDirTriggers?.add(dir)
        }
        // 不等待技能加载，让其在后台完成
        addSkillDirectories(newSkillDirs).catch(() => {})
      }

      // 激活路径模式匹配此文件的条件技能
      activateConditionalSkillsForPaths([fullFilePath], cwd)
    }

    try {
      // 调用内部实现函数执行实际读取
      return await callInner(
        file_path,
        fullFilePath,
        fullFilePath,
        ext,
        offset,
        limit,
        pages,
        maxSizeBytes,
        maxTokens,
        readFileState,
        context,
        parentMessage?.message.id,
      )
    } catch (error) {
      // 处理文件不存在的情况：建议相似文件
      const code = getErrnoCode(error)
      if (code === 'ENOENT') {
        // macOS 截图文件名中 AM/PM 前的空格字符可能不同
        // 在放弃之前尝试备用路径
        const altPath = getAlternateScreenshotPath(fullFilePath)
        if (altPath) {
          try {
            return await callInner(
              file_path,
              fullFilePath,
              altPath,
              ext,
              offset,
              limit,
              pages,
              maxSizeBytes,
              maxTokens,
              readFileState,
              context,
              parentMessage?.message.id,
            )
          } catch (altError) {
            if (!isENOENT(altError)) {
              throw altError
            }
            // 备用路径同样不存在 — 继续到友好错误提示
          }
        }

        // 查找相似文件名，为用户提供建议
        const similarFilename = findSimilarFile(fullFilePath)
        const cwdSuggestion = await suggestPathUnderCwd(fullFilePath)
        let message = `File does not exist. ${FILE_NOT_FOUND_CWD_NOTE} ${getCwd()}.`
        if (cwdSuggestion) {
          message += ` Did you mean ${cwdSuggestion}?`
        } else if (similarFilename) {
          message += ` Did you mean ${similarFilename}?`
        }
        throw new Error(message)
      }
      throw error
    }
  },
  /**
   * 将工具结果转换为 Anthropic API 所需的消息块格式。
   * 根据输出类型（text/image/notebook/pdf/parts/file_unchanged）分别处理。
   */
  mapToolResultToToolResultBlockParam(data, toolUseID) {
    switch (data.type) {
      case 'image': {
        // 图片以 base64 内联图片块返回
        return {
          tool_use_id: toolUseID,
          type: 'tool_result',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                data: data.file.base64,
                media_type: data.file.type,
              },
            },
          ],
        }
      }
      case 'notebook':
        // Notebook 各 cell 转换为工具结果块
        return mapNotebookCellsToToolResult(data.file.cells, toolUseID)
      case 'pdf':
        // 仅返回 PDF 元数据；实际内容通过 supplemental DocumentBlockParam 发送
        return {
          tool_use_id: toolUseID,
          type: 'tool_result',
          content: `PDF file read: ${data.file.filePath} (${formatFileSize(data.file.originalSize)})`,
        }
      case 'parts':
        // 提取的页图片将在 mapToolResultToAPIMessage 中作为图片块发送
        return {
          tool_use_id: toolUseID,
          type: 'tool_result',
          content: `PDF pages extracted: ${data.file.count} page(s) from ${data.file.filePath} (${formatFileSize(data.file.originalSize)})`,
        }
      case 'file_unchanged':
        // 返回 stub 消息，告知模型文件未变更，可引用之前的读取结果
        return {
          tool_use_id: toolUseID,
          type: 'tool_result',
          content: FILE_UNCHANGED_STUB,
        }
      case 'text': {
        let content: string

        if (data.file.content) {
          // 构建内容：记忆文件鲜度前缀 + 带行号的文件内容 + 网络安全提醒（部分模型豁免）
          content =
            memoryFileFreshnessPrefix(data) +
            formatFileLines(data.file) +
            (shouldIncludeFileReadMitigation()
              ? CYBER_RISK_MITIGATION_REMINDER
              : '')
        } else {
          // 文件为空或 offset 超出范围时的警告
          content =
            data.file.totalLines === 0
              ? '<system-reminder>Warning: the file exists but the contents are empty.</system-reminder>'
              : `<system-reminder>Warning: the file exists but is shorter than the provided offset (${data.file.startLine}). The file has ${data.file.totalLines} lines.</system-reminder>`
        }

        return {
          tool_use_id: toolUseID,
          type: 'tool_result',
          content,
        }
      }
    }
  },
} satisfies ToolDef<InputSchema, Output>)

/**
 * 选择行格式说明字符串。
 * 当前固定返回 LINE_FORMAT_INSTRUCTION，预留扩展空间。
 */
function pickLineFormatInstruction(): string {
  return LINE_FORMAT_INSTRUCTION
}

/** 为文件内容添加行号前缀（cat -n 格式）。 */
function formatFileLines(file: { content: string; startLine: number }): string {
  return addLineNumbers(file)
}

/**
 * 网络安全风险缓解提醒。
 * 附加在每次文件读取结果之后（部分模型豁免），提示模型注意恶意代码风险。
 */
export const CYBER_RISK_MITIGATION_REMINDER =
  '\n\n<system-reminder>\nWhenever you read a file, you should consider whether it would be considered malware. You CAN and SHOULD provide analysis of malware, what it is doing. But you MUST refuse to improve or augment the code. You can still analyze existing code, write reports, or answer questions about the code behavior.\n</system-reminder>\n'

// 豁免网络安全提醒的模型列表（这些模型内置了更强的安全意识）
const MITIGATION_EXEMPT_MODELS = new Set(['claude-opus-4-6'])

/**
 * 判断当前主循环模型是否需要附加网络安全提醒。
 * 豁免列表中的模型（如 claude-opus-4-6）不需要此提醒。
 */
function shouldIncludeFileReadMitigation(): boolean {
  const shortName = getCanonicalName(getMainLoopModel())
  return !MITIGATION_EXEMPT_MODELS.has(shortName)
}

/**
 * call() 到 mapToolResultToToolResultBlockParam 的副信道：
 * 存储自动记忆文件的 mtime，以对象引用为键。
 * 避免在输出 Schema（流入 SDK 类型）中添加仅用于展示的字段，
 * 也避免在映射器中进行同步文件系统操作。
 * WeakMap 在数据对象渲染后变为不可达时自动 GC。
 */
const memoryFileMtimes = new WeakMap<object, number>()

/**
 * 为自动记忆文件的读取结果生成鲜度前缀。
 * 若无 mtime 记录则返回空字符串。
 */
function memoryFileFreshnessPrefix(data: object): string {
  const mtimeMs = memoryFileMtimes.get(data)
  if (mtimeMs === undefined) return ''
  return memoryFreshnessNote(mtimeMs)
}

/**
 * 验证文件内容的 Token 数是否在允许范围内。
 *
 * 流程：先用粗估算法快速判断，若接近上限则调用 API 精确计数。
 * 超出上限时抛出 MaxFileReadTokenExceededError。
 *
 * @param content - 文件内容字符串
 * @param ext - 文件扩展名（用于选择合适的估算策略）
 * @param maxTokens - 允许的最大 Token 数
 */
async function validateContentTokens(
  content: string,
  ext: string,
  maxTokens?: number,
): Promise<void> {
  const effectiveMaxTokens =
    maxTokens ?? getDefaultFileReadingLimits().maxTokens

  // 粗估：若估算值小于上限的 1/4，直接跳过精确计数（避免 API 调用开销）
  const tokenEstimate = roughTokenCountEstimationForFileType(content, ext)
  if (!tokenEstimate || tokenEstimate <= effectiveMaxTokens / 4) return

  // 调用 API 精确计数
  const tokenCount = await countTokensWithAPI(content)
  const effectiveCount = tokenCount ?? tokenEstimate

  if (effectiveCount > effectiveMaxTokens) {
    throw new MaxFileReadTokenExceededError(effectiveCount, effectiveMaxTokens)
  }
}

// 图片读取结果类型（供内部函数使用）
type ImageResult = {
  type: 'image'
  file: {
    base64: string
    type: Base64ImageSource['media_type']
    originalSize: number
    dimensions?: ImageDimensions
  }
}

/**
 * 构建图片读取结果对象。
 * 将 Buffer 转为 base64 并附加媒体类型和原始大小信息。
 */
function createImageResponse(
  buffer: Buffer,
  mediaType: string,
  originalSize: number,
  dimensions?: ImageDimensions,
): ImageResult {
  return {
    type: 'image',
    file: {
      base64: buffer.toString('base64'),
      type: `image/${mediaType}` as Base64ImageSource['media_type'],
      originalSize,
      dimensions,
    },
  }
}

/**
 * call() 的内部实现，与外层分离以便 ENOENT 处理逻辑在外层捕获。
 *
 * 按文件类型分派：
 * - .ipynb：读取 Notebook cells
 * - 图片扩展名：读取图片并按 Token 预算压缩
 * - PDF：按页提取或整体读取
 * - 其他：按行范围读取文本文件
 */
async function callInner(
  file_path: string,       // 原始（未展开的）文件路径，用于输出和日志
  fullFilePath: string,    // 展开后的完整路径，用于 readFileState 键
  resolvedFilePath: string, // 实际要读取的路径（可能是备用截图路径）
  ext: string,             // 文件扩展名（小写，无点）
  offset: number,          // 从第几行开始读取（1-based）
  limit: number | undefined, // 最多读取多少行
  pages: string | undefined, // PDF 页范围
  maxSizeBytes: number,    // 文件大小上限（字节）
  maxTokens: number,       // Token 数上限
  readFileState: ToolUseContext['readFileState'], // 文件状态缓存
  context: ToolUseContext,
  messageId: string | undefined, // 父消息 ID（用于埋点）
): Promise<{
  data: Output
  newMessages?: ReturnType<typeof createUserMessage>[]
}> {
  // --- Notebook 处理分支 ---
  if (ext === 'ipynb') {
    // 读取 Notebook 并序列化为 JSON
    const cells = await readNotebook(resolvedFilePath)
    const cellsJson = jsonStringify(cells)

    // 检查 Notebook 内容大小是否超限
    const cellsJsonBytes = Buffer.byteLength(cellsJson)
    if (cellsJsonBytes > maxSizeBytes) {
      throw new Error(
        `Notebook content (${formatFileSize(cellsJsonBytes)}) exceeds maximum allowed size (${formatFileSize(maxSizeBytes)}). ` +
          `Use ${BASH_TOOL_NAME} with jq to read specific portions:\n` +
          `  cat "${file_path}" | jq '.cells[:20]' # First 20 cells\n` +
          `  cat "${file_path}" | jq '.cells[100:120]' # Cells 100-120\n` +
          `  cat "${file_path}" | jq '.cells | length' # Count total cells\n` +
          `  cat "${file_path}" | jq '.cells[] | select(.cell_type=="code") | .source' # All code sources`,
      )
    }

    // 验证 Token 数
    await validateContentTokens(cellsJson, ext, maxTokens)

    // 记录文件状态（用于去重和变更检测）
    const stats = await getFsImplementation().stat(resolvedFilePath)
    readFileState.set(fullFilePath, {
      content: cellsJson,
      timestamp: Math.floor(stats.mtimeMs),
      offset,
      limit,
    })
    context.nestedMemoryAttachmentTriggers?.add(fullFilePath)

    const data = {
      type: 'notebook' as const,
      file: { filePath: file_path, cells },
    }

    logFileOperation({
      operation: 'read',
      tool: 'FileReadTool',
      filePath: fullFilePath,
      content: cellsJson,
    })

    return { data }
  }

  // --- 图片处理分支（单次读取，无二次读取）---
  if (IMAGE_EXTENSIONS.has(ext)) {
    // 图片有独立的大小限制（Token 预算 + 压缩），不应用文本的 maxSizeBytes 上限
    const data = await readImageWithTokenBudget(resolvedFilePath, maxTokens)
    context.nestedMemoryAttachmentTriggers?.add(fullFilePath)

    logFileOperation({
      operation: 'read',
      tool: 'FileReadTool',
      filePath: fullFilePath,
      content: data.file.base64,
    })

    // 若有尺寸信息，生成元数据文本（坐标映射用）
    const metadataText = data.file.dimensions
      ? createImageMetadataText(data.file.dimensions)
      : null

    return {
      data,
      ...(metadataText && {
        newMessages: [
          createUserMessage({ content: metadataText, isMeta: true }),
        ],
      }),
    }
  }

  // --- PDF 处理分支 ---
  if (isPDFExtension(ext)) {
    if (pages) {
      // 指定了页范围：提取对应页面为图片
      const parsedRange = parsePDFPageRange(pages)
      const extractResult = await extractPDFPages(
        resolvedFilePath,
        parsedRange ?? undefined,
      )
      if (!extractResult.success) {
        throw new Error(extractResult.error.message)
      }
      logEvent('tengu_pdf_page_extraction', {
        success: true,
        pageCount: extractResult.data.file.count,
        fileSize: extractResult.data.file.originalSize,
        hasPageRange: true,
      })
      logFileOperation({
        operation: 'read',
        tool: 'FileReadTool',
        filePath: fullFilePath,
        content: `PDF pages ${pages}`,
      })
      // 读取提取出的页面图片，调整大小后以图片块返回
      const entries = await readdir(extractResult.data.file.outputDir)
      const imageFiles = entries.filter(f => f.endsWith('.jpg')).sort()
      const imageBlocks = await Promise.all(
        imageFiles.map(async f => {
          const imgPath = path.join(extractResult.data.file.outputDir, f)
          const imgBuffer = await readFileAsync(imgPath)
          // 必要时调整图片大小
          const resized = await maybeResizeAndDownsampleImageBuffer(
            imgBuffer,
            imgBuffer.length,
            'jpeg',
          )
          return {
            type: 'image' as const,
            source: {
              type: 'base64' as const,
              media_type:
                `image/${resized.mediaType}` as Base64ImageSource['media_type'],
              data: resized.buffer.toString('base64'),
            },
          }
        }),
      )
      return {
        data: extractResult.data,
        ...(imageBlocks.length > 0 && {
          newMessages: [
            createUserMessage({ content: imageBlocks, isMeta: true }),
          ],
        }),
      }
    }

    // 未指定页范围：检查总页数
    const pageCount = await getPDFPageCount(resolvedFilePath)
    if (pageCount !== null && pageCount > PDF_AT_MENTION_INLINE_THRESHOLD) {
      throw new Error(
        `This PDF has ${pageCount} pages, which is too many to read at once. ` +
          `Use the pages parameter to read specific page ranges (e.g., pages: "1-5"). ` +
          `Maximum ${PDF_MAX_PAGES_PER_READ} pages per request.`,
      )
    }

    const fs = getFsImplementation()
    const stats = await fs.stat(resolvedFilePath)
    // 若不支持原生 PDF 或文件超过提取大小阈值，则按页提取为图片
    const shouldExtractPages =
      !isPDFSupported() || stats.size > PDF_EXTRACT_SIZE_THRESHOLD

    if (shouldExtractPages) {
      const extractResult = await extractPDFPages(resolvedFilePath)
      if (extractResult.success) {
        logEvent('tengu_pdf_page_extraction', {
          success: true,
          pageCount: extractResult.data.file.count,
          fileSize: extractResult.data.file.originalSize,
        })
      } else {
        logEvent('tengu_pdf_page_extraction', {
          success: false,
          available: extractResult.error.reason !== 'unavailable',
          fileSize: stats.size,
        })
      }
    }

    // 若当前模型不支持 PDF，抛出友好错误
    if (!isPDFSupported()) {
      throw new Error(
        'Reading full PDFs is not supported with this model. Use a newer model (Sonnet 3.5 v2 or later), ' +
          `or use the pages parameter to read specific page ranges (e.g., pages: "1-5", maximum ${PDF_MAX_PAGES_PER_READ} pages per request). ` +
          'Page extraction requires poppler-utils: install with `brew install poppler` on macOS or `apt-get install poppler-utils` on Debian/Ubuntu.',
      )
    }

    // 整体读取 PDF（base64 编码）
    const readResult = await readPDF(resolvedFilePath)
    if (!readResult.success) {
      throw new Error(readResult.error.message)
    }
    const pdfData = readResult.data
    logFileOperation({
      operation: 'read',
      tool: 'FileReadTool',
      filePath: fullFilePath,
      content: pdfData.file.base64,
    })

    // 返回 PDF 数据，同时附加 supplemental document 块
    return {
      data: pdfData,
      newMessages: [
        createUserMessage({
          content: [
            {
              type: 'document',
              source: {
                type: 'base64',
                media_type: 'application/pdf',
                data: pdfData.file.base64,
              },
            },
          ],
          isMeta: true,
        }),
      ],
    }
  }

  // --- 文本文件处理分支（通过 readFileInRange 异步读取）---
  // 将 1-based offset 转为 0-based 行索引
  const lineOffset = offset === 0 ? 0 : offset - 1
  // 读取指定范围的文件内容
  const { content, lineCount, totalLines, totalBytes, readBytes, mtimeMs } =
    await readFileInRange(
      resolvedFilePath,
      lineOffset,
      limit,
      // 仅在无显式 limit 时应用 maxSizeBytes 限制（有 limit 时文件会被截断）
      limit === undefined ? maxSizeBytes : undefined,
      context.abortController.signal,
    )

  // 验证内容 Token 数
  await validateContentTokens(content, ext, maxTokens)

  // 更新文件状态缓存（包含内容、mtime、读取范围）
  readFileState.set(fullFilePath, {
    content,
    timestamp: Math.floor(mtimeMs),
    offset,
    limit,
  })
  context.nestedMemoryAttachmentTriggers?.add(fullFilePath)

  // 通知所有注册的监听器文件已被读取
  // 快照数组以防监听器在回调中取消注册（避免修改迭代中的数组）
  for (const listener of fileReadListeners.slice()) {
    listener(resolvedFilePath, content)
  }

  const data = {
    type: 'text' as const,
    file: {
      filePath: file_path,
      content,
      numLines: lineCount,
      startLine: offset,
      totalLines,
    },
  }
  // 若是自动记忆文件，存储 mtime 供鲜度前缀使用（via WeakMap 副信道）
  if (isAutoMemFile(fullFilePath)) {
    memoryFileMtimes.set(data, mtimeMs)
  }

  logFileOperation({
    operation: 'read',
    tool: 'FileReadTool',
    filePath: fullFilePath,
    content,
  })

  // 记录会话文件读取的分析埋点
  const sessionFileType = detectSessionFileType(fullFilePath)
  const analyticsExt = getFileExtensionForAnalytics(fullFilePath)
  logEvent('tengu_session_file_read', {
    totalLines,
    readLines: lineCount,
    totalBytes,
    readBytes,
    offset,
    ...(limit !== undefined && { limit }),
    ...(analyticsExt !== undefined && { ext: analyticsExt }),
    ...(messageId !== undefined && {
      messageID:
        messageId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    }),
    is_session_memory: sessionFileType === 'session_memory',
    is_session_transcript: sessionFileType === 'session_transcript',
  })

  return { data }
}

/**
 * 读取图片文件并在必要时应用 Token 预算内的压缩。
 * 仅读取文件一次，然后依次尝试：标准缩放 → 积极压缩 → 最终降级压缩。
 *
 * @param filePath - 图片文件路径
 * @param maxTokens - 图片的最大 Token 预算
 * @param maxBytes - 可选的字节数上限（防止超大文件 OOM）
 * @returns 带有适当压缩的图片数据对象
 */
export async function readImageWithTokenBudget(
  filePath: string,
  maxTokens: number = getDefaultFileReadingLimits().maxTokens,
  maxBytes?: number,
): Promise<ImageResult> {
  // 一次性读取文件，使用 maxBytes 上限防止超大文件 OOM
  const imageBuffer = await getFsImplementation().readFileBytes(
    filePath,
    maxBytes,
  )
  const originalSize = imageBuffer.length

  // 空文件直接报错
  if (originalSize === 0) {
    throw new Error(`Image file is empty: ${filePath}`)
  }

  // 从文件头字节检测图片格式（不依赖扩展名）
  const detectedMediaType = detectImageFormatFromBuffer(imageBuffer)
  const detectedFormat = detectedMediaType.split('/')[1] || 'png'

  // 第一步：尝试标准缩放（降分辨率但保留质量）
  let result: ImageResult
  try {
    const resized = await maybeResizeAndDownsampleImageBuffer(
      imageBuffer,
      originalSize,
      detectedFormat,
    )
    result = createImageResponse(
      resized.buffer,
      resized.mediaType,
      originalSize,
      resized.dimensions,
    )
  } catch (e) {
    if (e instanceof ImageResizeError) throw e
    logError(e)
    // 缩放失败时使用原始 buffer
    result = createImageResponse(imageBuffer, detectedFormat, originalSize)
  }

  // 估算结果的 Token 数（base64 长度 × 0.125 ≈ 字节数）
  const estimatedTokens = Math.ceil(result.file.base64.length * 0.125)
  if (estimatedTokens > maxTokens) {
    // 第二步：积极压缩（使用相同 buffer，无二次读取）
    try {
      const compressed = await compressImageBufferWithTokenLimit(
        imageBuffer,
        maxTokens,
        detectedMediaType,
      )
      return {
        type: 'image',
        file: {
          base64: compressed.base64,
          type: compressed.mediaType,
          originalSize,
        },
      }
    } catch (e) {
      logError(e)
      // 第三步：最终降级 — 强制压缩到 400×400、quality=20 的 JPEG
      try {
        const sharpModule = await import('sharp')
        const sharp =
          (
            sharpModule as {
              default?: typeof sharpModule
            } & typeof sharpModule
          ).default || sharpModule

        const fallbackBuffer = await sharp(imageBuffer)
          .resize(400, 400, {
            fit: 'inside',
            withoutEnlargement: true,
          })
          .jpeg({ quality: 20 })
          .toBuffer()

        return createImageResponse(fallbackBuffer, 'jpeg', originalSize)
      } catch (error) {
        logError(error)
        // 所有压缩方案均失败，返回原始 buffer
        return createImageResponse(imageBuffer, detectedFormat, originalSize)
      }
    }
  }

  return result
}
