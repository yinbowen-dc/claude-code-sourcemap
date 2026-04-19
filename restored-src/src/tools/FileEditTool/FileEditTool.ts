/**
 * 【FileEditTool 主模块】
 *
 * 在 Claude Code 系统流程中的位置：
 *   FileEditTool 是 Claude Code 最核心的写文件工具之一，负责对磁盘上的文件
 *   执行精确的字符串替换（old_string → new_string）。
 *   典型调用链：AI 生成编辑请求 → validateInput() 多层安全校验 → call() 原子读改写。
 *
 * 主要功能：
 *   - validateInput()：10+ 层顺序校验（秘密检测、同内容拒绝、权限规则、UNC 路径、
 *     文件大小、文件读取、存在性检查、Jupyter 拒绝、读时间戳、修改时间、
 *     findActualString quote 规范化、多匹配检测、settings 文件校验）
 *   - call()：8 步原子读改写流程（skills 发现、诊断追踪、mkdir、文件历史备份、
 *     原子读取、quote 保留、patch 生成、磁盘写入、LSP 通知、VSCode 通知、
 *     readFileState 更新、分析事件、git diff 可选采集）
 *   - readFileForEdit()：同步读取文件内容及元数据的辅助函数
 */

import { dirname, isAbsolute, sep } from 'path'
import { logEvent } from 'src/services/analytics/index.js'
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
import { countLinesChanged } from '../../utils/diff.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { isENOENT } from '../../utils/errors.js'
import {
  FILE_NOT_FOUND_CWD_NOTE,
  findSimilarFile,
  getFileModificationTime,
  suggestPathUnderCwd,
  writeTextContent,
} from '../../utils/file.js'
import {
  fileHistoryEnabled,
  fileHistoryTrackEdit,
} from '../../utils/fileHistory.js'
import { logFileOperation } from '../../utils/fileOperationAnalytics.js'
import {
  type LineEndingType,
  readFileSyncWithMetadata,
} from '../../utils/fileRead.js'
import { formatFileSize } from '../../utils/format.js'
import { getFsImplementation } from '../../utils/fsOperations.js'
import {
  fetchSingleFileGitDiff,
  type ToolUseDiff,
} from '../../utils/gitDiff.js'
import { logError } from '../../utils/log.js'
import { expandPath } from '../../utils/path.js'
import {
  checkWritePermissionForTool,
  matchingRuleForInput,
} from '../../utils/permissions/filesystem.js'
import type { PermissionDecision } from '../../utils/permissions/PermissionResult.js'
import { matchWildcardPattern } from '../../utils/permissions/shellRuleMatching.js'
import { validateInputForSettingsFileEdit } from '../../utils/settings/validateEditTool.js'
import { NOTEBOOK_EDIT_TOOL_NAME } from '../NotebookEditTool/constants.js'
import {
  FILE_EDIT_TOOL_NAME,
  FILE_UNEXPECTEDLY_MODIFIED_ERROR,
} from './constants.js'
import { getEditToolDescription } from './prompt.js'
import {
  type FileEditInput,
  type FileEditOutput,
  inputSchema,
  outputSchema,
} from './types.js'
import {
  getToolUseSummary,
  renderToolResultMessage,
  renderToolUseErrorMessage,
  renderToolUseMessage,
  renderToolUseRejectedMessage,
  userFacingName,
} from './UI.js'
import {
  areFileEditsInputsEquivalent,
  findActualString,
  getPatchForEdit,
  preserveQuoteStyle,
} from './utils.js'

// V8/Bun string length limit is ~2^30 characters (~1 billion). For typical
// ASCII/Latin-1 files, 1 byte on disk = 1 character, so 1 GiB in stat bytes
// ≈ 1 billion characters ≈ the runtime string limit. Multi-byte UTF-8 files
// can be larger on disk per character, but 1 GiB is a safe byte-level guard
// that prevents OOM without being unnecessarily restrictive.
// 最大可编辑文件大小：1 GiB（stat 字节数），防止超大文件导致 OOM
const MAX_EDIT_FILE_SIZE = 1024 * 1024 * 1024 // 1 GiB (stat bytes)

export const FileEditTool = buildTool({
  name: FILE_EDIT_TOOL_NAME,
  searchHint: 'modify file contents in place',
  maxResultSizeChars: 100_000,
  strict: true,
  async description() {
    return 'A tool for editing files'
  },
  async prompt() {
    // 从 prompt.ts 获取工具使用说明（含前置阅读要求、缩进格式等）
    return getEditToolDescription()
  },
  userFacingName,
  getToolUseSummary,
  getActivityDescription(input) {
    // 构造进度条显示文本，如 "Editing src/foo.ts"
    const summary = getToolUseSummary(input)
    return summary ? `Editing ${summary}` : 'Editing file'
  },
  get inputSchema() {
    return inputSchema()
  },
  get outputSchema() {
    return outputSchema()
  },
  toAutoClassifierInput(input) {
    // 自动分类器输入：文件路径 + 新内容（用于判断操作类型）
    return `${input.file_path}: ${input.new_string}`
  },
  getPath(input): string {
    // 返回文件路径，用于权限匹配和路径显示
    return input.file_path
  },
  backfillObservableInput(input) {
    // hooks.mdx 文档要求 file_path 为绝对路径；expandPath 展开 ~ 和相对路径，
    // 防止 hook 允许列表被 ~ 或相对路径绕过
    if (typeof input.file_path === 'string') {
      input.file_path = expandPath(input.file_path)
    }
  },
  async preparePermissionMatcher({ file_path }) {
    // 返回通配符模式匹配函数，供权限系统用于检查 file_path 是否匹配规则
    return pattern => matchWildcardPattern(pattern, file_path)
  },
  async checkPermissions(input, context): Promise<PermissionDecision> {
    // 检查写权限：查询当前 AppState 中的 toolPermissionContext，返回允许/拒绝/询问决策
    const appState = context.getAppState()
    return checkWritePermissionForTool(
      FileEditTool,
      input,
      appState.toolPermissionContext,
    )
  },
  renderToolUseMessage,
  renderToolResultMessage,
  renderToolUseRejectedMessage,
  renderToolUseErrorMessage,
  /**
   * 输入校验：10+ 层顺序安全检查
   *
   * 校验顺序：
   * 1. 秘密检测：拒绝向 team memory 文件写入密钥
   * 2. 同内容拒绝：old_string === new_string 时无需操作
   * 3. 权限 deny 规则：路径被 toolPermissionContext 明确拒绝时
   * 4. UNC 路径跳过：Windows UNC 路径跳过 fs 操作，防止 NTLM 凭证泄漏
   * 5. 文件大小：超过 1 GiB 拒绝（防 OOM）
   * 6. 文件读取：读取字节检测编码（UTF-16LE BOM 检测）
   * 7. 存在性检查：文件不存在时根据 old_string 是否为空决定是新建还是报错
   * 8. Jupyter 拒绝：.ipynb 文件引导使用 NotebookEditTool
   * 9. 读时间戳：文件未读过（readFileState 无记录）时拒绝
   * 10. 修改时间：文件在读后被修改（timestamp > readTimestamp）时拒绝
   *     - Windows 例外：全量读取且内容相同时允许（避免云同步/杀毒软件的误报）
   * 11. findActualString：quote 规范化后查找实际匹配字符串
   * 12. 多匹配检测：old_string 匹配多处且 replace_all=false 时拒绝
   * 13. settings 文件校验：模拟编辑结果并验证 Claude settings 文件合法性
   */
  async validateInput(input: FileEditInput, toolUseContext: ToolUseContext) {
    const { file_path, old_string, new_string, replace_all = false } = input
    // expandPath 统一路径格式（Windows 上 "/" vs "\" 可导致 readFileState 查找不匹配）
    const fullFilePath = expandPath(file_path)

    // 1. 拒绝向 team memory 文件写入密钥（防止秘密扩散）
    const secretError = checkTeamMemSecrets(fullFilePath, new_string)
    if (secretError) {
      return { result: false, message: secretError, errorCode: 0 }
    }
    // 2. old_string 与 new_string 完全相同时无需操作，要求 AI 重试
    if (old_string === new_string) {
      return {
        result: false,
        behavior: 'ask',
        message:
          'No changes to make: old_string and new_string are exactly the same.',
        errorCode: 1,
      }
    }

    // 3. 检查路径是否被权限 deny 规则拒绝（toolPermissionContext 中的 edit deny 规则）
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
        behavior: 'ask',
        message:
          'File is in a directory that is denied by your permission settings.',
        errorCode: 2,
      }
    }

    // 4. 安全：跳过 UNC 路径的文件系统操作，防止 NTLM 凭证泄漏到恶意 SMB 服务器
    //    Windows 上 fs.existsSync() 访问 UNC 路径会触发 SMB 认证
    if (fullFilePath.startsWith('\\\\') || fullFilePath.startsWith('//')) {
      return { result: true }
    }

    const fs = getFsImplementation()

    // 5. 防止超大文件（多 GB）导致 OOM，stat 超过 1 GiB 时拒绝
    try {
      const { size } = await fs.stat(fullFilePath)
      if (size > MAX_EDIT_FILE_SIZE) {
        return {
          result: false,
          behavior: 'ask',
          message: `File is too large to edit (${formatFileSize(size)}). Maximum editable file size is ${formatFileSize(MAX_EDIT_FILE_SIZE)}.`,
          errorCode: 10,
        }
      }
    } catch (e) {
      if (!isENOENT(e)) {
        throw e
      }
      // ENOENT 时文件不存在，继续后续校验
    }

    // 6. 读取文件字节以检测编码（UTF-16LE BOM 以 0xFF 0xFE 开头）
    //    先读字节而非直接调用 detectFileEncoding（后者会重复一次 readSync，ENOENT 时浪费 I/O）
    let fileContent: string | null
    try {
      const fileBuffer = await fs.readFileBytes(fullFilePath)
      // BOM 检测：UTF-16 LE 文件以 0xFF 0xFE 开头
      const encoding: BufferEncoding =
        fileBuffer.length >= 2 &&
        fileBuffer[0] === 0xff &&
        fileBuffer[1] === 0xfe
          ? 'utf16le'
          : 'utf8'
      // 统一将 CRLF 转换为 LF，方便后续字符串匹配
      fileContent = fileBuffer.toString(encoding).replaceAll('\r\n', '\n')
    } catch (e) {
      if (isENOENT(e)) {
        fileContent = null  // 文件不存在，后续根据 old_string 判断是否新建
      } else {
        throw e
      }
    }

    // 7. 文件不存在时的处理
    if (fileContent === null) {
      // old_string 为空代表新建文件——合法，允许
      if (old_string === '') {
        return { result: true }
      }
      // 尝试找同名不同扩展名的文件，给 AI 提示
      const similarFilename = findSimilarFile(fullFilePath)
      const cwdSuggestion = await suggestPathUnderCwd(fullFilePath)
      let message = `File does not exist. ${FILE_NOT_FOUND_CWD_NOTE} ${getCwd()}.`

      if (cwdSuggestion) {
        message += ` Did you mean ${cwdSuggestion}?`
      } else if (similarFilename) {
        message += ` Did you mean ${similarFilename}?`
      }

      return {
        result: false,
        behavior: 'ask',
        message,
        errorCode: 4,
      }
    }

    // 文件存在但 old_string 为空：仅当文件本身为空内容时合法（覆盖空文件）
    if (old_string === '') {
      // 文件有内容时拒绝（防止意外覆盖非空文件）
      if (fileContent.trim() !== '') {
        return {
          result: false,
          behavior: 'ask',
          message: 'Cannot create new file - file already exists.',
          errorCode: 3,
        }
      }

      // 空文件 + 空 old_string = 用 new_string 覆盖空文件，合法
      return {
        result: true,
      }
    }

    // 8. Jupyter Notebook 文件引导使用 NotebookEditTool
    if (fullFilePath.endsWith('.ipynb')) {
      return {
        result: false,
        behavior: 'ask',
        message: `File is a Jupyter Notebook. Use the ${NOTEBOOK_EDIT_TOOL_NAME} to edit this file.`,
        errorCode: 5,
      }
    }

    // 9. 检查 readFileState：若文件从未被读过或仅被部分读取，拒绝编辑
    //    （防止 AI 在未确认文件内容的情况下盲目修改）
    const readTimestamp = toolUseContext.readFileState.get(fullFilePath)
    if (!readTimestamp || readTimestamp.isPartialView) {
      return {
        result: false,
        behavior: 'ask',
        message:
          'File has not been read yet. Read it first before writing to it.',
        meta: {
          isFilePathAbsolute: String(isAbsolute(file_path)),
        },
        errorCode: 6,
      }
    }

    // 10. 修改时间校验：文件在读后被外部修改（linter、用户等）时拒绝，要求重新读取
    if (readTimestamp) {
      const lastWriteTime = getFileModificationTime(fullFilePath)
      if (lastWriteTime > readTimestamp.timestamp) {
        // Windows 上时间戳可能因云同步/杀毒软件改变而不反映内容变化；
        // 全量读取时，回退到内容比对来避免误报
        const isFullRead =
          readTimestamp.offset === undefined &&
          readTimestamp.limit === undefined
        if (isFullRead && fileContent === readTimestamp.content) {
          // 内容未变，尽管时间戳更新——允许继续
        } else {
          return {
            result: false,
            behavior: 'ask',
            message:
              'File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.',
            errorCode: 7,
          }
        }
      }
    }

    const file = fileContent

    // 11. findActualString：处理 quote 规范化（弯引号 ↔ 直引号）后查找实际匹配字符串
    const actualOldString = findActualString(file, old_string)
    if (!actualOldString) {
      return {
        result: false,
        behavior: 'ask',
        message: `String to replace not found in file.\nString: ${old_string}`,
        meta: {
          isFilePathAbsolute: String(isAbsolute(file_path)),
        },
        errorCode: 8,
      }
    }

    // 12. 多匹配检测：old_string 在文件中出现多次且 replace_all=false 时要求提供更多上下文
    const matches = file.split(actualOldString).length - 1

    if (matches > 1 && !replace_all) {
      return {
        result: false,
        behavior: 'ask',
        message: `Found ${matches} matches of the string to replace, but replace_all is false. To replace all occurrences, set replace_all to true. To replace only one occurrence, please provide more context to uniquely identify the instance.\nString: ${old_string}`,
        meta: {
          isFilePathAbsolute: String(isAbsolute(file_path)),
          actualOldString,
        },
        errorCode: 9,
      }
    }

    // 13. settings 文件校验：模拟编辑结果，验证 Claude settings 文件格式合法性
    const settingsValidationResult = validateInputForSettingsFileEdit(
      fullFilePath,
      file,
      () => {
        // 用与工具执行相同的逻辑模拟编辑，获取最终内容
        return replace_all
          ? file.replaceAll(actualOldString, new_string)
          : file.replace(actualOldString, new_string)
      },
    )

    if (settingsValidationResult !== null) {
      return settingsValidationResult
    }

    // 所有校验通过，将 actualOldString（quote 规范化后的实际字符串）附加到 meta
    return { result: true, meta: { actualOldString } }
  },
  inputsEquivalent(input1, input2) {
    // 判断两次编辑请求是否等价（用于去重/合并相同编辑）
    return areFileEditsInputsEquivalent(
      {
        file_path: input1.file_path,
        edits: [
          {
            old_string: input1.old_string,
            new_string: input1.new_string,
            replace_all: input1.replace_all ?? false,
          },
        ],
      },
      {
        file_path: input2.file_path,
        edits: [
          {
            old_string: input2.old_string,
            new_string: input2.new_string,
            replace_all: input2.replace_all ?? false,
          },
        ],
      },
    )
  },
  /**
   * 执行文件编辑：8 步原子读改写流程
   *
   * Step 1：获取当前状态
   *   - skills 发现：根据文件路径发现新 skill 目录（fire-and-forget，不阻塞）
   *   - diagnosticTracker.beforeFileEdited：记录编辑前诊断状态
   *   - fs.mkdir：确保父目录存在
   *   - fileHistoryTrackEdit：备份编辑前内容（内容哈希去重，幂等）
   *
   * Step 2：原子读取（关键区段——此处到磁盘写入之间避免 await，防止并发编辑交叉）
   *   - readFileForEdit()：同步读取文件内容、编码、行尾格式
   *   - 修改时间二次校验（Windows 回退到内容比对）
   *
   * Step 3：quote 处理
   *   - findActualString()：quote 规范化后定位实际被替换字符串
   *   - preserveQuoteStyle()：将文件中的弯引号风格应用到 new_string
   *
   * Step 4：生成 patch（getPatchForEdit）
   *
   * Step 5：写入磁盘（writeTextContent，保留原始编码和行尾格式）
   *
   * Step 6：更新 readFileState（写后立即更新时间戳，使后续校验基准正确）
   *
   * Step 7：日志和分析事件
   *   - CLAUDE.md 写入事件
   *   - countLinesChanged（统计变更行数）
   *   - logFileOperation（文件操作审计）
   *   - tengu_edit_string_lengths（字节长度统计）
   *   - git diff 可选采集（仅 REMOTE + feature 开关启用时）
   *
   * Step 8：返回结构化结果
   */
  async call(
    input: FileEditInput,
    {
      readFileState,
      userModified,
      updateFileHistoryState,
      dynamicSkillDirTriggers,
    },
    _,
    parentMessage,
  ) {
    const { file_path, old_string, new_string, replace_all = false } = input

    // Step 1: 获取当前状态
    const fs = getFsImplementation()
    const absoluteFilePath = expandPath(file_path)  // 展开路径（~、相对路径）

    // 根据文件路径发现并激活新 skill 目录（非 simple 模式下才运行）
    const cwd = getCwd()
    if (!isEnvTruthy(process.env.CLAUDE_CODE_SIMPLE)) {
      const newSkillDirs = await discoverSkillDirsForPaths(
        [absoluteFilePath],
        cwd,
      )
      if (newSkillDirs.length > 0) {
        // 记录触发源目录，供 UI 附件显示
        for (const dir of newSkillDirs) {
          dynamicSkillDirTriggers?.add(dir)
        }
        // 后台加载 skill 目录（不阻塞编辑流程）
        addSkillDirectories(newSkillDirs).catch(() => {})
      }

      // 激活路径模式匹配的条件 skill（如针对特定文件类型的 skill）
      activateConditionalSkillsForPaths([absoluteFilePath], cwd)
    }

    // 通知诊断追踪器：文件即将被编辑（记录编辑前诊断快照）
    await diagnosticTracker.beforeFileEdited(absoluteFilePath)

    // 确保父目录存在（新文件场景需要先创建目录）
    // 这些 await 必须在原子区段之外——yield 点在 staleness 检查和 writeTextContent 之间
    // 会导致并发编辑交叉
    await fs.mkdir(dirname(absoluteFilePath))
    if (fileHistoryEnabled()) {
      // 备份编辑前内容（基于内容哈希的幂等 v1 备份；
      // 即使 staleness 检查后失败也只是留下未用的备份，不会导致状态损坏）
      await fileHistoryTrackEdit(
        updateFileHistoryState,
        absoluteFilePath,
        parentMessage.uuid,
      )
    }

    // Step 2: 原子读取并确认文件在上次读取后未被修改
    // 请避免在此处到磁盘写入之间使用 async 操作，以保证原子性
    const {
      content: originalFileContents,
      fileExists,
      encoding,
      lineEndings: endings,
    } = readFileForEdit(absoluteFilePath)

    if (fileExists) {
      const lastWriteTime = getFileModificationTime(absoluteFilePath)
      const lastRead = readFileState.get(absoluteFilePath)
      if (!lastRead || lastWriteTime > lastRead.timestamp) {
        // Windows 上时间戳可能无意义地变化（云同步、杀毒等）；
        // 全量读取时回退到内容比对来避免误报
        const isFullRead =
          lastRead &&
          lastRead.offset === undefined &&
          lastRead.limit === undefined
        const contentUnchanged =
          isFullRead && originalFileContents === lastRead.content
        if (!contentUnchanged) {
          // 文件在校验后到执行时之间被修改——抛出特定错误，上层捕获后提示 AI 重新读取
          throw new Error(FILE_UNEXPECTEDLY_MODIFIED_ERROR)
        }
      }
    }

    // Step 3: quote 规范化处理
    // findActualString 处理 AI 输出直引号、文件使用弯引号的情形
    const actualOldString =
      findActualString(originalFileContents, old_string) || old_string

    // preserveQuoteStyle：当匹配是通过 quote 规范化找到的，将文件原有弯引号风格应用到 new_string
    const actualNewString = preserveQuoteStyle(
      old_string,
      actualOldString,
      new_string,
    )

    // Step 4: 生成 patch（仅内存计算，不写磁盘）
    const { patch, updatedFile } = getPatchForEdit({
      filePath: absoluteFilePath,
      fileContents: originalFileContents,
      oldString: actualOldString,
      newString: actualNewString,
      replaceAll: replace_all,
    })

    // Step 5: 写入磁盘（保留原始编码和行尾格式，如 UTF-16LE、CRLF 等）
    writeTextContent(absoluteFilePath, updatedFile, encoding, endings)

    // 通知 LSP 服务器文件内容已修改（didChange）和已保存（didSave）
    const lspManager = getLspServerManager()
    if (lspManager) {
      // 清除已投递的诊断，确保新诊断会被显示
      clearDeliveredDiagnosticsForFile(`file://${absoluteFilePath}`)
      // didChange：通知内容已变更（TypeScript server 等 LSP 服务器需要此事件更新内部状态）
      lspManager
        .changeFile(absoluteFilePath, updatedFile)
        .catch((err: Error) => {
          logForDebugging(
            `LSP: Failed to notify server of file change for ${absoluteFilePath}: ${err.message}`,
          )
          logError(err)
        })
      // didSave：通知文件已保存到磁盘（TypeScript server 在 didSave 后才触发诊断）
      lspManager.saveFile(absoluteFilePath).catch((err: Error) => {
        logForDebugging(
          `LSP: Failed to notify server of file save for ${absoluteFilePath}: ${err.message}`,
        )
        logError(err)
      })
    }

    // 通知 VSCode MCP 文件已更新（用于 diff 视图展示）
    notifyVscodeFileUpdated(absoluteFilePath, originalFileContents, updatedFile)

    // Step 6: 更新 readFileState（写后立即更新读取时间戳，
    // 防止后续编辑因"时间戳新于读取时间"而被误判为外部修改）
    readFileState.set(absoluteFilePath, {
      content: updatedFile,
      timestamp: getFileModificationTime(absoluteFilePath),
      offset: undefined,
      limit: undefined,
    })

    // Step 7: 日志和分析事件
    // 若编辑的是 CLAUDE.md，记录特定事件（用于追踪 AI 自修改记忆文件的行为）
    if (absoluteFilePath.endsWith(`${sep}CLAUDE.md`)) {
      logEvent('tengu_write_claudemd', {})
    }
    // 统计本次编辑的变更行数（供分析和 UI 显示）
    countLinesChanged(patch)

    // 审计日志：记录文件操作类型（edit）和工具名
    logFileOperation({
      operation: 'edit',
      tool: 'FileEditTool',
      filePath: absoluteFilePath,
    })

    // 记录 old_string 和 new_string 的字节长度（用于性能和使用量分析）
    logEvent('tengu_edit_string_lengths', {
      oldStringBytes: Buffer.byteLength(old_string, 'utf8'),
      newStringBytes: Buffer.byteLength(new_string, 'utf8'),
      replaceAll: replace_all,
    })

    // 可选：REMOTE 模式 + feature 开关启用时，采集 git diff 信息（用于 Quartz Lantern 功能）
    let gitDiff: ToolUseDiff | undefined
    if (
      isEnvTruthy(process.env.CLAUDE_CODE_REMOTE) &&
      getFeatureValue_CACHED_MAY_BE_STALE('tengu_quartz_lantern', false)
    ) {
      const startTime = Date.now()
      const diff = await fetchSingleFileGitDiff(absoluteFilePath)
      if (diff) gitDiff = diff
      logEvent('tengu_tool_use_diff_computed', {
        isEditTool: true,
        durationMs: Date.now() - startTime,
        hasDiff: !!diff,
      })
    }

    // Step 8: 返回结构化结果（供 UI 渲染 diff 预览和 AI 反馈）
    const data = {
      filePath: file_path,
      oldString: actualOldString,        // 经 quote 规范化后的实际被替换字符串
      newString: new_string,             // 原始 new_string（未经 quote 转换）
      originalFile: originalFileContents, // 编辑前完整文件内容（UI diff 渲染用）
      structuredPatch: patch,            // 结构化 diff hunk 数组
      userModified: userModified ?? false, // 用户是否在审批时修改了提议
      replaceAll: replace_all,
      ...(gitDiff && { gitDiff }),       // 可选 git diff 信息
    }
    return {
      data,
    }
  },
  /**
   * 将结构化输出转换为 API tool_result 格式。
   *
   * 区分两种情况：
   * - replace_all=true：反馈"所有匹配项已替换"
   * - 普通替换：反馈"文件已更新"
   * 若用户在审批时修改了提议，附加提示说明。
   */
  mapToolResultToToolResultBlockParam(data: FileEditOutput, toolUseID) {
    const { filePath, userModified, replaceAll } = data
    // 若用户在审批时修改了 AI 的提议，附加说明（帮助 AI 理解实际生效的内容）
    const modifiedNote = userModified
      ? '.  The user modified your proposed changes before accepting them. '
      : ''

    if (replaceAll) {
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content: `The file ${filePath} has been updated${modifiedNote}. All occurrences were successfully replaced.`,
      }
    }

    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: `The file ${filePath} has been updated successfully${modifiedNote}.`,
    }
  },
} satisfies ToolDef<ReturnType<typeof inputSchema>, FileEditOutput>)

// --

/**
 * 同步读取文件内容及元数据的辅助函数。
 *
 * 在 call() 的原子区段中使用（避免异步 I/O 导致竞争条件）：
 * - 读取文件内容、编码（UTF-8/UTF-16LE）、行尾格式（LF/CRLF）
 * - ENOENT 时返回空内容（fileExists=false），其他错误直接抛出
 *
 * @param absoluteFilePath - 文件的绝对路径
 * @returns 包含内容、存在标志、编码和行尾格式的对象
 */
function readFileForEdit(absoluteFilePath: string): {
  content: string
  fileExists: boolean
  encoding: BufferEncoding
  lineEndings: LineEndingType
} {
  try {
    // eslint-disable-next-line custom-rules/no-sync-fs
    const meta = readFileSyncWithMetadata(absoluteFilePath)
    return {
      content: meta.content,
      fileExists: true,
      encoding: meta.encoding,
      lineEndings: meta.lineEndings,
    }
  } catch (e) {
    if (isENOENT(e)) {
      // 文件不存在时返回空内容（用于新建文件的情形）
      return {
        content: '',
        fileExists: false,
        encoding: 'utf8',
        lineEndings: 'LF',
      }
    }
    throw e
  }
}
