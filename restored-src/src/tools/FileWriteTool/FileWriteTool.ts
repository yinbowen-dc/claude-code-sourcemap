/**
 * FileWriteTool.ts — 文件写入工具实现
 *
 * 【在 Claude Code 系统中的位置】
 * 本文件实现了 Claude Code 的文件写入能力，是文件编辑管道的核心之一。
 * 它与 FileEditTool（精确替换）、FileReadTool（读取）共同构成文件操作三元组。
 * 工具名称为 "Write"，在会话中通过 buildTool() 注册后，
 * 模型可以调用它来创建新文件或完整替换已有文件的内容。
 *
 * 【主要功能】
 * 1. 输入验证（validateInput）：
 *    - 拒绝写入包含秘钥的 team memory 文件
 *    - 检查路径是否被 deny 规则拒绝
 *    - 跳过 UNC 路径的文件系统操作，防止 NTLM 凭证泄露
 *    - 验证文件是否已被读取（必须先 Read 才能 Write）
 *    - 检查文件自最后一次读取后是否被外部修改（mtime 比较）
 * 2. 写入流程（call）：
 *    - 触发技能目录发现（fire-and-forget）
 *    - 确保父目录存在（mkdir）
 *    - 可选记录文件历史（fileHistory）
 *    - 同步读取当前文件内容 + mtime（原子性关键路径）
 *    - Windows 云同步兼容：mtime 变化但内容不变时允许写入
 *    - 使用 LF 行尾写入，避免行尾符污染
 *    - 通知 LSP 服务器（didChange + didSave）
 *    - 通知 VSCode 文件更新（diff 视图）
 *    - 更新 readFileState 缓存
 *    - 可选计算 git diff（远程模式 + tengu_quartz_lantern 特性标志）
 * 3. 结果映射（mapToolResultToToolResultBlockParam）：
 *    - 'create'：返回"文件创建成功"消息
 *    - 'update'：返回"文件更新成功"消息 + structuredPatch diff
 */

import { dirname, sep } from 'path'
import { logEvent } from 'src/services/analytics/index.js'
import { z } from 'zod/v4'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import { diagnosticTracker } from '../../services/diagnosticTracking.js'
import { clearDeliveredDiagnosticsForFile } from '../../services/lsp/LSPDiagnosticRegistry.js'
import { getLspServerManager } from '../../services/lsp/manager.js'
import { notifyVscodeFileUpdated } from '../../services/mcp/vscodeSdkMcp.js'
import { checkTeamMemSecrets } from '../../services/teamMemorySync/teamMemSecretGuard.js'
import {
  activateConditionalSkillsForPaths,
  addSkillDirectories,
  discoverSkillDirsForPaths,
} from '../../skills/loadSkillsDir.js'
import type { ToolUseContext } from '../../Tool.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { getCwd } from '../../utils/cwd.js'
import { logForDebugging } from '../../utils/debug.js'
import { countLinesChanged, getPatchForDisplay } from '../../utils/diff.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { isENOENT } from '../../utils/errors.js'
import { getFileModificationTime, writeTextContent } from '../../utils/file.js'
import {
  fileHistoryEnabled,
  fileHistoryTrackEdit,
} from '../../utils/fileHistory.js'
import { logFileOperation } from '../../utils/fileOperationAnalytics.js'
import { readFileSyncWithMetadata } from '../../utils/fileRead.js'
import { getFsImplementation } from '../../utils/fsOperations.js'
import {
  fetchSingleFileGitDiff,
  type ToolUseDiff,
} from '../../utils/gitDiff.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { logError } from '../../utils/log.js'
import { expandPath } from '../../utils/path.js'
import {
  checkWritePermissionForTool,
  matchingRuleForInput,
} from '../../utils/permissions/filesystem.js'
import type { PermissionDecision } from '../../utils/permissions/PermissionResult.js'
import { matchWildcardPattern } from '../../utils/permissions/shellRuleMatching.js'
import { FILE_UNEXPECTEDLY_MODIFIED_ERROR } from '../FileEditTool/constants.js'
import { gitDiffSchema, hunkSchema } from '../FileEditTool/types.js'
import { FILE_WRITE_TOOL_NAME, getWriteToolDescription } from './prompt.js'
import {
  getToolUseSummary,
  isResultTruncated,
  renderToolResultMessage,
  renderToolUseErrorMessage,
  renderToolUseMessage,
  renderToolUseRejectedMessage,
  userFacingName,
} from './UI.js'

/**
 * 输入 Schema（懒加载）：仅需 file_path（绝对路径）和 content（写入内容）。
 * 使用 lazySchema 包装，推迟 Zod 对象构建至首次访问，减少启动耗时。
 */
const inputSchema = lazySchema(() =>
  z.strictObject({
    file_path: z
      .string()
      .describe(
        'The absolute path to the file to write (must be absolute, not relative)',
      ),
    content: z.string().describe('The content to write to the file'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

/**
 * 输出 Schema（懒加载）：描述写入操作的结果。
 * - type: 'create'（新建）或 'update'（更新）
 * - filePath: 写入路径
 * - content: 写入内容
 * - structuredPatch: 结构化 diff patch（更新时为 hunk 数组，新建时为空数组）
 * - originalFile: 写入前的原始内容（新建时为 null）
 * - gitDiff: 可选的 git diff（远程模式特性标志开启时）
 */
const outputSchema = lazySchema(() =>
  z.object({
    type: z
      .enum(['create', 'update'])
      .describe(
        'Whether a new file was created or an existing file was updated',
      ),
    filePath: z.string().describe('The path to the file that was written'),
    content: z.string().describe('The content that was written to the file'),
    structuredPatch: z
      .array(hunkSchema())
      .describe('Diff patch showing the changes'),
    originalFile: z
      .string()
      .nullable()
      .describe(
        'The original file content before the write (null for new files)',
      ),
    gitDiff: gitDiffSchema().optional(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.infer<OutputSchema>
export type FileWriteToolInput = InputSchema

/**
 * FileWriteTool 工具定义。
 *
 * 通过 buildTool() 构建后注册到 Claude Code 工具系统，
 * 模型可通过名称 "Write" 调用本工具写入或创建本地文件。
 */
export const FileWriteTool = buildTool({
  name: FILE_WRITE_TOOL_NAME,
  searchHint: 'create or overwrite files',
  maxResultSizeChars: 100_000,
  strict: true,
  async description() {
    return 'Write a file to the local filesystem.'
  },
  userFacingName,
  getToolUseSummary,
  /** 生成活动描述，用于 UI 进度显示 */
  getActivityDescription(input) {
    const summary = getToolUseSummary(input)
    return summary ? `Writing ${summary}` : 'Writing file'
  },
  /** 返回完整工具提示词（来自 prompt.ts 的 getWriteToolDescription） */
  async prompt() {
    return getWriteToolDescription()
  },
  renderToolUseMessage,
  isResultTruncated,
  /** 懒加载输入 Schema */
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  /** 懒加载输出 Schema */
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  /** 供自动分类器使用：将 file_path 和 content 拼接为字符串 */
  toAutoClassifierInput(input) {
    return `${input.file_path}: ${input.content}`
  },
  /** 返回文件路径，供权限系统和搜索索引使用 */
  getPath(input): string {
    return input.file_path
  },
  /**
   * 在权限钩子执行前展开路径（~ 和相对路径），
   * 防止钩子允许列表被绕过。
   */
  backfillObservableInput(input) {
    // hooks.mdx documents file_path as absolute; expand so hook allowlists
    // can't be bypassed via ~ or relative paths.
    if (typeof input.file_path === 'string') {
      input.file_path = expandPath(input.file_path)
    }
  },
  /** 返回通配符匹配函数，供权限系统做路径规则匹配 */
  async preparePermissionMatcher({ file_path }) {
    return pattern => matchWildcardPattern(pattern, file_path)
  },
  /**
   * 权限检查：调用 checkWritePermissionForTool 验证是否允许写入目标路径。
   * 综合考虑 allow/deny 规则和用户授权状态。
   */
  async checkPermissions(input, context): Promise<PermissionDecision> {
    const appState = context.getAppState()
    return checkWritePermissionForTool(
      FileWriteTool,
      input,
      appState.toolPermissionContext,
    )
  },
  renderToolUseRejectedMessage,
  renderToolUseErrorMessage,
  renderToolResultMessage,
  /**
   * 搜索文本提取：返回空字符串。
   * 理由：UI 展示新建时用 HighlightedCode 渲染 content，更新时展示 structuredPatch，
   * 若将 content 加入搜索索引，更新模式下会产生不展示内容的幽灵索引；
   * tool_use 节点已通过 file_path 建立了索引。
   */
  extractSearchText() {
    // Transcript render shows either content (create, via HighlightedCode)
    // or a structured diff (update). The heuristic's 'content' allowlist key
    // would index the raw content string even in update mode where it's NOT
    // shown — phantom. Under-count: tool_use already indexes file_path.
    return ''
  },
  /**
   * 输入验证（在 call 之前执行）。
   *
   * 按以下顺序依次检查：
   * 1. team memory 秘钥检查（防止写入含密钥的协作配置文件）
   * 2. deny 规则检查（路径被配置禁止时返回错误）
   * 3. UNC 路径安全跳过（避免触发 SMB NTLM 认证）
   * 4. 文件不存在则允许写入（新建场景）
   * 5. 必须先读取才能写入（readFileState 缓存验证）
   * 6. 文件自上次读取后未被外部修改（mtime 验证）
   *
   * @returns { result: true } 表示通过，{ result: false, message, errorCode } 表示拒绝
   */
  async validateInput({ file_path, content }, toolUseContext: ToolUseContext) {
    const fullFilePath = expandPath(file_path)

    // 1. 拒绝写入包含秘钥的 team memory 文件
    const secretError = checkTeamMemSecrets(fullFilePath, content)
    if (secretError) {
      return { result: false, message: secretError, errorCode: 0 }
    }

    // 2. 检查路径是否被 deny 规则拒绝
    const appState = toolUseContext.getAppState()
    const denyRule = matchingRuleForInput(
      fullFilePath,
      appState.toolPermissionContext,
      'edit',
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

    // SECURITY: Skip filesystem operations for UNC paths to prevent NTLM credential leaks.
    // On Windows, fs.existsSync() on UNC paths triggers SMB authentication which could
    // leak credentials to malicious servers. Let the permission check handle UNC paths.
    // 3. UNC 路径（\\server\share 或 //server/share）安全跳过，防止 NTLM 凭证泄露
    if (fullFilePath.startsWith('\\\\') || fullFilePath.startsWith('//')) {
      return { result: true }
    }

    const fs = getFsImplementation()
    let fileMtimeMs: number
    try {
      // 4. 获取文件 stat，若文件不存在则直接允许（新建场景）
      const fileStat = await fs.stat(fullFilePath)
      fileMtimeMs = fileStat.mtimeMs
    } catch (e) {
      if (isENOENT(e)) {
        return { result: true }
      }
      throw e
    }

    // 5. 验证文件是否已被本次会话读取过
    const readTimestamp = toolUseContext.readFileState.get(fullFilePath)
    if (!readTimestamp || readTimestamp.isPartialView) {
      return {
        result: false,
        message:
          'File has not been read yet. Read it first before writing to it.',
        errorCode: 2,
      }
    }

    // Reuse mtime from the stat above — avoids a redundant statSync via
    // getFileModificationTime. The readTimestamp guard above ensures this
    // block is always reached when the file exists.
    // 6. 比较文件 mtime 与最后一次读取时间，检测外部修改
    const lastWriteTime = Math.floor(fileMtimeMs)
    if (lastWriteTime > readTimestamp.timestamp) {
      return {
        result: false,
        message:
          'File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.',
        errorCode: 3,
      }
    }

    return { result: true }
  },
  /**
   * 执行文件写入的核心逻辑。
   *
   * 流程概览：
   * 1. 展开路径，解析父目录
   * 2. 后台触发技能目录发现（discoverSkillDirsForPaths）
   * 3. 激活条件技能（activateConditionalSkillsForPaths）
   * 4. 通知诊断追踪器（beforeFileEdited）
   * 5. 确保父目录存在（mkdir）
   * 6. 可选备份文件历史（fileHistoryTrackEdit）
   * 7. 【关键路径】同步读取当前文件内容与 mtime，验证无并发修改
   * 8. 写入文件（强制 LF 行尾）
   * 9. 通知 LSP：clearDeliveredDiagnostics + didChange + didSave
   * 10. 通知 VSCode（notifyVscodeFileUpdated）
   * 11. 更新 readFileState 缓存
   * 12. 记录 CLAUDE.md 写入事件
   * 13. 可选计算 git diff（远程模式）
   * 14. 返回 create 或 update 类型的结果数据
   */
  async call(
    { file_path, content },
    { readFileState, updateFileHistoryState, dynamicSkillDirTriggers },
    _,
    parentMessage,
  ) {
    const fullFilePath = expandPath(file_path)
    const dir = dirname(fullFilePath)

    // 后台发现并加载与此文件路径相关的技能目录（非阻塞）
    const cwd = getCwd()
    const newSkillDirs = await discoverSkillDirsForPaths([fullFilePath], cwd)
    if (newSkillDirs.length > 0) {
      // 将发现的技能目录存入 dynamicSkillDirTriggers，用于 UI 附件展示
      for (const dir of newSkillDirs) {
        dynamicSkillDirTriggers?.add(dir)
      }
      // 不等待，让技能加载在后台进行
      addSkillDirectories(newSkillDirs).catch(() => {})
    }

    // 激活与此文件路径匹配的条件技能
    activateConditionalSkillsForPaths([fullFilePath], cwd)

    // 通知诊断追踪器文件即将被编辑
    await diagnosticTracker.beforeFileEdited(fullFilePath)

    // Ensure parent directory exists before the atomic read-modify-write section.
    // Must stay OUTSIDE the critical section below (a yield between the staleness
    // check and writeTextContent lets concurrent edits interleave), and BEFORE the
    // write (lazy-mkdir-on-ENOENT would fire a spurious tengu_atomic_write_error
    // inside writeFileSyncAndFlush_DEPRECATED before ENOENT propagates back).
    // 确保父目录存在（必须在原子读改写关键路径之外，且在写入之前执行）
    await getFsImplementation().mkdir(dir)
    if (fileHistoryEnabled()) {
      // Backup captures pre-edit content — safe to call before the staleness
      // check (idempotent v1 backup keyed on content hash; if staleness fails
      // later we just have an unused backup, not corrupt state).
      // 备份编辑前内容（基于内容哈希的幂等操作，即使后续因过期检查失败也不影响状态）
      await fileHistoryTrackEdit(
        updateFileHistoryState,
        fullFilePath,
        parentMessage.uuid,
      )
    }

    // Load current state and confirm no changes since last read.
    // Please avoid async operations between here and writing to disk to preserve atomicity.
    // 【关键路径开始】同步读取文件内容，确保从此处到写盘之间没有异步操作（保持原子性）
    let meta: ReturnType<typeof readFileSyncWithMetadata> | null
    try {
      meta = readFileSyncWithMetadata(fullFilePath)
    } catch (e) {
      if (isENOENT(e)) {
        // 文件不存在，视为新建
        meta = null
      } else {
        throw e
      }
    }

    if (meta !== null) {
      const lastWriteTime = getFileModificationTime(fullFilePath)
      const lastRead = readFileState.get(fullFilePath)
      if (!lastRead || lastWriteTime > lastRead.timestamp) {
        // Timestamp indicates modification, but on Windows timestamps can change
        // without content changes (cloud sync, antivirus, etc.). For full reads,
        // compare content as a fallback to avoid false positives.
        // Windows 兼容：mtime 变化时还需比较内容（云同步/杀毒软件可能在不修改内容的情况下更新 mtime）
        const isFullRead =
          lastRead &&
          lastRead.offset === undefined &&
          lastRead.limit === undefined
        // meta.content 已经过 CRLF 规范化，与 readFileState 中的内容格式一致
        if (!isFullRead || meta.content !== lastRead.content) {
          throw new Error(FILE_UNEXPECTEDLY_MODIFIED_ERROR)
        }
      }
    }

    // 获取原始文件的编码（新建文件默认 utf8）和内容（新建为 null）
    const enc = meta?.encoding ?? 'utf8'
    const oldContent = meta?.content ?? null

    // Write is a full content replacement — the model sent explicit line endings
    // in `content` and meant them. Do not rewrite them. Previously we preserved
    // the old file's line endings (or sampled the repo via ripgrep for new
    // files), which silently corrupted e.g. bash scripts with \r on Linux when
    // overwriting a CRLF file or when binaries in cwd poisoned the repo sample.
    // 强制使用 LF 行尾写入，避免行尾符污染（之前曾尝试保留原行尾符，导致多种问题）
    writeTextContent(fullFilePath, content, enc, 'LF')

    // 通知 LSP 服务器文件内容已变更（didChange）和已保存（didSave）
    const lspManager = getLspServerManager()
    if (lspManager) {
      // 清除已投递的诊断，以便新的诊断能够显示
      clearDeliveredDiagnosticsForFile(`file://${fullFilePath}`)
      // didChange：通知 LSP 服务器文件内容已修改
      lspManager.changeFile(fullFilePath, content).catch((err: Error) => {
        logForDebugging(
          `LSP: Failed to notify server of file change for ${fullFilePath}: ${err.message}`,
        )
        logError(err)
      })
      // didSave：通知 LSP 服务器文件已保存（触发 TypeScript 服务器等的诊断分析）
      lspManager.saveFile(fullFilePath).catch((err: Error) => {
        logForDebugging(
          `LSP: Failed to notify server of file save for ${fullFilePath}: ${err.message}`,
        )
        logError(err)
      })
    }

    // 通知 VSCode 文件已更新，用于 diff 视图展示
    notifyVscodeFileUpdated(fullFilePath, oldContent, content)

    // 更新 readFileState 缓存，将写入内容和新 mtime 存入，防止后续写入判断为过期
    readFileState.set(fullFilePath, {
      content,
      timestamp: getFileModificationTime(fullFilePath),
      offset: undefined,
      limit: undefined,
    })

    // 记录 CLAUDE.md 写入事件（用于遥测）
    if (fullFilePath.endsWith(`${sep}CLAUDE.md`)) {
      logEvent('tengu_write_claudemd', {})
    }

    // 可选：在远程模式且特性标志开启时，异步计算 git diff（用于 UI 展示）
    let gitDiff: ToolUseDiff | undefined
    if (
      isEnvTruthy(process.env.CLAUDE_CODE_REMOTE) &&
      getFeatureValue_CACHED_MAY_BE_STALE('tengu_quartz_lantern', false)
    ) {
      const startTime = Date.now()
      const diff = await fetchSingleFileGitDiff(fullFilePath)
      if (diff) gitDiff = diff
      logEvent('tengu_tool_use_diff_computed', {
        isWriteTool: true,
        durationMs: Date.now() - startTime,
        hasDiff: !!diff,
      })
    }

    if (oldContent) {
      // 文件已存在：生成结构化 diff patch，返回 update 类型结果
      const patch = getPatchForDisplay({
        filePath: file_path,
        fileContents: oldContent,
        edits: [
          {
            old_string: oldContent,
            new_string: content,
            replace_all: false,
          },
        ],
      })

      const data = {
        type: 'update' as const,
        filePath: file_path,
        content,
        structuredPatch: patch,
        originalFile: oldContent,
        ...(gitDiff && { gitDiff }),
      }
      // 在返回结果前统计新增/删除行数（用于遥测）
      countLinesChanged(patch)

      logFileOperation({
        operation: 'write',
        tool: 'FileWriteTool',
        filePath: fullFilePath,
        type: 'update',
      })

      return {
        data,
      }
    }

    // 文件不存在：返回 create 类型结果，structuredPatch 为空数组
    const data = {
      type: 'create' as const,
      filePath: file_path,
      content,
      structuredPatch: [],
      originalFile: null,
      ...(gitDiff && { gitDiff }),
    }

    // 新建文件时将全部行计为新增行（用于遥测）
    countLinesChanged([], content)

    logFileOperation({
      operation: 'write',
      tool: 'FileWriteTool',
      filePath: fullFilePath,
      type: 'create',
    })

    return {
      data,
    }
  },
  /**
   * 将工具调用结果映射为 Anthropic API 的 tool_result 消息格式。
   * 根据操作类型（create/update）返回不同的成功提示文本。
   */
  mapToolResultToToolResultBlockParam({ filePath, type }, toolUseID) {
    switch (type) {
      case 'create':
        // 新建文件：返回文件路径确认消息
        return {
          tool_use_id: toolUseID,
          type: 'tool_result',
          content: `File created successfully at: ${filePath}`,
        }
      case 'update':
        // 更新文件：返回更新成功确认消息
        return {
          tool_use_id: toolUseID,
          type: 'tool_result',
          content: `The file ${filePath} has been updated successfully.`,
        }
    }
  },
} satisfies ToolDef<InputSchema, Output>)
