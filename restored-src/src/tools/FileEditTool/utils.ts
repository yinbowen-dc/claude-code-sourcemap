/**
 * 【FileEditTool 工具函数模块】
 *
 * 在 Claude Code 系统流程中的位置：
 *   本文件是 FileEditTool 的核心工具库，提供从字符串匹配到 diff 生成的全套底层能力。
 *   FileEditTool.ts 在 validateInput() 和 call() 中直接调用此处的导出函数；
 *   BatchFileEditTool 等批量编辑工具也依赖 getPatchForEdits() 和 normalizeFileEditInput()。
 *
 * 主要功能：
 *   - 弯引号处理：LEFT/RIGHT_SINGLE/DOUBLE_CURLY_QUOTE 常量 + normalizeQuotes() + preserveQuoteStyle()
 *   - 空白处理：stripTrailingWhitespace()（保留行尾符）
 *   - 字符串查找：findActualString()（精确匹配优先，次选规范化引号匹配）
 *   - 文件编辑：applyEditToFile()（执行单次字符串替换，支持 replaceAll）
 *   - Patch 生成：getPatchForEdit() / getPatchForEdits()（不写盘，只返回 diff）
 *   - Diff 片段：getSnippetForTwoFileDiff() / getSnippetForPatch() / getSnippet()
 *   - Patch 反解：getEditsForPatch()（StructuredPatchHunk[] → FileEdit[]）
 *   - 反脱敏：DESANITIZATIONS + desanitizeMatchString() + normalizeFileEditInput()
 *   - 等价比较：areFileEditsEquivalent() / areFileEditsInputsEquivalent()
 */

import { type StructuredPatchHunk, structuredPatch } from 'diff'
import { logError } from 'src/utils/log.js'
import { expandPath } from 'src/utils/path.js'
import { countCharInString } from 'src/utils/stringUtils.js'
import {
  DIFF_TIMEOUT_MS,
  getPatchForDisplay,
  getPatchFromContents,
} from '../../utils/diff.js'
import { errorMessage, isENOENT } from '../../utils/errors.js'
import {
  addLineNumbers,
  convertLeadingTabsToSpaces,
  readFileSyncCached,
} from '../../utils/file.js'
import type { EditInput, FileEdit } from './types.js'

// Claude 无法直接输出弯引号，故在此以常量形式定义供代码引用。
// 编辑应用时会将弯引号规范化为直引号，以便进行精确字符串匹配。
export const LEFT_SINGLE_CURLY_QUOTE = '\u2018'   // ' 左单弯引号
export const RIGHT_SINGLE_CURLY_QUOTE = '\u2019'  // ' 右单弯引号
export const LEFT_DOUBLE_CURLY_QUOTE = '\u201C'   // " 左双弯引号
export const RIGHT_DOUBLE_CURLY_QUOTE = '\u201D'  // " 右双弯引号

/**
 * 将字符串中的弯引号（curly quotes）全部替换为对应的直引号（straight quotes）。
 *
 * 用于在匹配 old_string 前对 fileContent 和 searchString 同步规范化，
 * 消除引号形式差异对字符串匹配的干扰。
 * @param str 待规范化的字符串
 * @returns 所有弯引号已替换为直引号的字符串
 */
export function normalizeQuotes(str: string): string {
  return str
    .replaceAll(LEFT_SINGLE_CURLY_QUOTE, "'")
    .replaceAll(RIGHT_SINGLE_CURLY_QUOTE, "'")
    .replaceAll(LEFT_DOUBLE_CURLY_QUOTE, '"')
    .replaceAll(RIGHT_DOUBLE_CURLY_QUOTE, '"')
}

/**
 * 在保留原始行尾符（CRLF/LF/CR）的前提下，去除每行末尾的空白字符。
 *
 * 实现方式：用正则按行尾符分割（奇数索引为行尾符，偶数索引为行内容），
 * 只对行内容部分执行 /\s+$/ 替换，行尾符原样保留。
 * @param str 待处理的字符串
 * @returns 每行尾部空白已去除的字符串
 */
export function stripTrailingWhitespace(str: string): string {
  // 用捕获组分割以同时保留行尾符（CRLF、LF、CR）
  const lines = str.split(/(\r\n|\n|\r)/)

  let result = ''
  for (let i = 0; i < lines.length; i++) {
    const part = lines[i]
    if (part !== undefined) {
      if (i % 2 === 0) {
        // 偶数索引：行内容，去除尾部空白
        result += part.replace(/\s+$/, '')
      } else {
        // 奇数索引：行尾符，原样保留
        result += part
      }
    }
  }

  return result
}

/**
 * 在文件内容中查找与 searchString 匹配的实际字符串（考虑引号规范化）。
 *
 * 匹配策略（优先级从高到低）：
 * 1. 精确匹配：searchString 直接出现在 fileContent 中 → 返回 searchString 本身
 * 2. 规范化匹配：对 fileContent 和 searchString 分别调用 normalizeQuotes()，
 *    在规范化后的文件中定位索引，再从原始 fileContent 截取同等长度的子串返回
 *    （确保返回的是文件中实际使用的弯引号形式）
 * 3. 未找到 → 返回 null
 *
 * @param fileContent  目标文件的完整内容
 * @param searchString 待查找的字符串（可能含直引号）
 * @returns 文件中实际出现的字符串，或 null（未找到时）
 */
export function findActualString(
  fileContent: string,
  searchString: string,
): string | null {
  // 第一步：精确匹配
  if (fileContent.includes(searchString)) {
    return searchString
  }

  // 第二步：引号规范化后匹配，返回文件中的实际片段（保留弯引号形式）
  const normalizedSearch = normalizeQuotes(searchString)
  const normalizedFile = normalizeQuotes(fileContent)

  const searchIndex = normalizedFile.indexOf(normalizedSearch)
  if (searchIndex !== -1) {
    // 从原始文件内容截取相同位置和长度，保留文件原有引号风格
    return fileContent.substring(searchIndex, searchIndex + searchString.length)
  }

  return null
}

/**
 * 当 old_string 通过引号规范化才匹配到文件内容时，
 * 将相同的弯引号风格应用到 new_string，确保编辑后文件的排版一致性。
 *
 * 开闭引号启发式判断（isOpeningContext）：
 *   前驱字符为空白、字符串起始、或开括号（([ { em/en dash）时视为开引号，否则为闭引号。
 *
 * @param oldString       原始 old_string（模型提供，可能含直引号）
 * @param actualOldString 文件中实际的字符串（可能含弯引号）
 * @param newString       原始 new_string（模型提供，可能含直引号）
 * @returns 应用了弯引号风格后的 new_string
 */
export function preserveQuoteStyle(
  oldString: string,
  actualOldString: string,
  newString: string,
): string {
  // 若两者相同，说明未经规范化匹配，无需修改 new_string
  if (oldString === actualOldString) {
    return newString
  }

  // 检测文件实际内容中使用了哪种弯引号
  const hasDoubleQuotes =
    actualOldString.includes(LEFT_DOUBLE_CURLY_QUOTE) ||
    actualOldString.includes(RIGHT_DOUBLE_CURLY_QUOTE)
  const hasSingleQuotes =
    actualOldString.includes(LEFT_SINGLE_CURLY_QUOTE) ||
    actualOldString.includes(RIGHT_SINGLE_CURLY_QUOTE)

  // 若文件中无弯引号，直接返回原始 new_string
  if (!hasDoubleQuotes && !hasSingleQuotes) {
    return newString
  }

  let result = newString

  // 按文件中出现的引号类型分别应用弯引号转换
  if (hasDoubleQuotes) {
    result = applyCurlyDoubleQuotes(result)
  }
  if (hasSingleQuotes) {
    result = applyCurlySingleQuotes(result)
  }

  return result
}

/**
 * 判断当前位置是否处于"开引号"上下文。
 *
 * 规则：位于字符串起始（index === 0）或前驱字符为空白/开括号/破折号时，
 * 视为开引号位置，应使用左引号；否则视为闭引号位置，使用右引号。
 *
 * @param chars 目标字符串拆分后的字符数组
 * @param index 当前引号字符的位置索引
 * @returns 若为开引号上下文则返回 true
 */
function isOpeningContext(chars: string[], index: number): boolean {
  if (index === 0) {
    return true  // 字符串起始位置始终视为开引号
  }
  const prev = chars[index - 1]
  return (
    prev === ' ' ||
    prev === '\t' ||
    prev === '\n' ||
    prev === '\r' ||
    prev === '(' ||
    prev === '[' ||
    prev === '{' ||
    prev === '\u2014' || // em dash（—）
    prev === '\u2013'   // en dash（–）
  )
}

/**
 * 将字符串中的直双引号（"）替换为左右弯双引号（" "）。
 * 使用 isOpeningContext() 判断每个引号应用左引号还是右引号。
 */
function applyCurlyDoubleQuotes(str: string): string {
  const chars = [...str]
  const result: string[] = []
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] === '"') {
      result.push(
        isOpeningContext(chars, i)
          ? LEFT_DOUBLE_CURLY_QUOTE   // " 开引号
          : RIGHT_DOUBLE_CURLY_QUOTE, // " 闭引号
      )
    } else {
      result.push(chars[i]!)
    }
  }
  return result.join('')
}

/**
 * 将字符串中的直单引号（'）替换为左右弯单引号（' '）。
 *
 * 缩写词特殊处理：两侧均为字母的单引号（如 don't、it's）视为撇号，
 * 统一替换为右单弯引号（'），而非开引号。
 */
function applyCurlySingleQuotes(str: string): string {
  const chars = [...str]
  const result: string[] = []
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] === "'") {
      // 获取前后字符，判断是否为缩写词中的撇号
      const prev = i > 0 ? chars[i - 1] : undefined
      const next = i < chars.length - 1 ? chars[i + 1] : undefined
      const prevIsLetter = prev !== undefined && /\p{L}/u.test(prev)
      const nextIsLetter = next !== undefined && /\p{L}/u.test(next)
      if (prevIsLetter && nextIsLetter) {
        // 缩写词中的撇号（如 don't）→ 右单弯引号
        result.push(RIGHT_SINGLE_CURLY_QUOTE)
      } else {
        // 普通引号 → 按上下文判断开/闭
        result.push(
          isOpeningContext(chars, i)
            ? LEFT_SINGLE_CURLY_QUOTE   // ' 开引号
            : RIGHT_SINGLE_CURLY_QUOTE, // ' 闭引号
        )
      }
    } else {
      result.push(chars[i]!)
    }
  }
  return result.join('')
}

/**
 * 对文件内容执行单次字符串替换，返回修改后的文件内容（不写盘）。
 *
 * 特殊处理：当 newString 为空（即删除操作）且 oldString 后紧跟换行符时，
 * 同时删除该换行符（避免删除一行后留下多余空行）。
 *
 * @param originalContent 原始文件内容
 * @param oldString       被替换的字符串（已通过 findActualString 定位）
 * @param newString       替换后的字符串（空字符串表示纯删除）
 * @param replaceAll      是否替换所有匹配项（默认 false，仅替换第一个）
 * @returns 替换后的文件内容
 */
export function applyEditToFile(
  originalContent: string,
  oldString: string,
  newString: string,
  replaceAll: boolean = false,
): string {
  // 根据 replaceAll 选择 replaceAll() 或 replace()（均使用函数回调，防止 $ 转义问题）
  const f = replaceAll
    ? (content: string, search: string, replace: string) =>
        content.replaceAll(search, () => replace)
    : (content: string, search: string, replace: string) =>
        content.replace(search, () => replace)

  if (newString !== '') {
    // 非删除操作：直接替换
    return f(originalContent, oldString, newString)
  }

  // 删除操作：若 oldString 后紧跟换行符，则连同换行符一并删除
  const stripTrailingNewline =
    !oldString.endsWith('\n') && originalContent.includes(oldString + '\n')

  return stripTrailingNewline
    ? f(originalContent, oldString + '\n', newString)
    : f(originalContent, oldString, newString)
}

/**
 * 对单次编辑生成结构化 diff patch（不写盘）。
 *
 * 这是 getPatchForEdits() 的单编辑便捷包装，将参数组装为 FileEdit 数组后委托调用。
 * 返回值中的 patch 仅用于展示（tab 已转为空格），updatedFile 为实际修改后内容。
 */
export function getPatchForEdit({
  filePath,
  fileContents,
  oldString,
  newString,
  replaceAll = false,
}: {
  filePath: string
  fileContents: string
  oldString: string
  newString: string
  replaceAll?: boolean
}): { patch: StructuredPatchHunk[]; updatedFile: string } {
  return getPatchForEdits({
    filePath,
    fileContents,
    edits: [
      { old_string: oldString, new_string: newString, replace_all: replaceAll },
    ],
  })
}

/**
 * 对一组编辑操作依序应用到文件内容，生成结构化 diff patch（不写盘）。
 *
 * 流程：
 * 1. 空文件且唯一编辑为 old=''/new='' → 特殊处理返回空 patch
 * 2. 依序遍历每个 edit：
 *    a. 检查 old_string（去掉尾部换行后）是否为已应用 new_string 的子串 → 抛出错误
 *    b. old_string 为空 → 直接以 new_string 覆盖全文（新建文件语义）
 *    c. 否则调用 applyEditToFile() 执行替换
 *    d. 若替换前后内容不变 → 抛出"String not found"错误
 * 3. 全部编辑后与原始内容相同 → 抛出"Original and edited file match"错误
 * 4. 调用 getPatchFromContents()（tab→空格 后）生成展示用 patch
 *
 * 注意：返回的 patch 因 convertLeadingTabsToSpaces 处理，仅用于 UI 渲染而非精确重放。
 */
export function getPatchForEdits({
  filePath,
  fileContents,
  edits,
}: {
  filePath: string
  fileContents: string
  edits: FileEdit[]
}): { patch: StructuredPatchHunk[]; updatedFile: string } {
  let updatedFile = fileContents
  const appliedNewStrings: string[] = []

  // 特殊情况：空文件 + 唯一空编辑（old=''，new=''）→ 返回空内容与空 patch
  if (
    !fileContents &&
    edits.length === 1 &&
    edits[0] &&
    edits[0].old_string === '' &&
    edits[0].new_string === ''
  ) {
    const patch = getPatchForDisplay({
      filePath,
      fileContents,
      edits: [
        {
          old_string: fileContents,
          new_string: updatedFile,
          replace_all: false,
        },
      ],
    })
    return { patch, updatedFile: '' }
  }

  // 依序应用每个编辑
  for (const edit of edits) {
    // 检查 old_string 是否为此前已应用的某个 new_string 的子串（防止重叠编辑）
    const oldStringToCheck = edit.old_string.replace(/\n+$/, '')

    for (const previousNewString of appliedNewStrings) {
      if (
        oldStringToCheck !== '' &&
        previousNewString.includes(oldStringToCheck)
      ) {
        throw new Error(
          'Cannot edit file: old_string is a substring of a new_string from a previous edit.',
        )
      }
    }

    const previousContent = updatedFile
    // old_string 为空：以 new_string 替换全部内容（新建文件或清空文件）
    updatedFile =
      edit.old_string === ''
        ? edit.new_string
        : applyEditToFile(
            updatedFile,
            edit.old_string,
            edit.new_string,
            edit.replace_all,
          )

    // 替换后内容不变 → old_string 未在文件中找到
    if (updatedFile === previousContent) {
      throw new Error('String not found in file. Failed to apply edit.')
    }

    // 记录已应用的 new_string，用于后续子串检测
    appliedNewStrings.push(edit.new_string)
  }

  // 所有编辑均未产生变化（逻辑上不应出现，作为防御性检查）
  if (updatedFile === fileContents) {
    throw new Error(
      'Original and edited file match exactly. Failed to apply edit.',
    )
  }

  // 将 tab 转为空格后生成展示用 patch（此转换仅影响 UI，不影响写盘内容）
  const patch = getPatchFromContents({
    filePath,
    oldContent: convertLeadingTabsToSpaces(fileContents),
    newContent: convertLeadingTabsToSpaces(updatedFile),
  })

  return { patch, updatedFile }
}

// diff 片段最大字节数上限：8KB。
// 经观测，大文件 format-on-save 注入的完整文件内容最大约 16.1KB（约 14K tokens/session）。
// 8KB 在保留有效上下文的同时限制了最坏情况下的资源消耗。
const DIFF_SNIPPET_MAX_BYTES = 8192

/**
 * 对两个文件版本生成截断至 8KB 的 diff 片段（用于附件展示）。
 *
 * 流程：
 * 1. 调用 diff 库的 structuredPatch() 生成带 8 行上下文的 diff
 * 2. 过滤掉删除行（-）和元数据行（\）只保留新版本内容
 * 3. 拼接各 hunk 的带行号内容（hunk 间用 "..." 分隔）
 * 4. 若超过 8KB，在最后一个完整行边界处截断，并追加"N lines truncated"提示
 */
export function getSnippetForTwoFileDiff(
  fileAContents: string,
  fileBContents: string,
): string {
  const patch = structuredPatch(
    'file.txt',
    'file.txt',
    fileAContents,
    fileBContents,
    undefined,
    undefined,
    {
      context: 8,           // 每个 hunk 前后各保留 8 行上下文
      timeout: DIFF_TIMEOUT_MS,
    },
  )

  if (!patch) {
    return ''
  }

  // 拼接各 hunk 的带行号内容（只保留上下文行和新增行，跳过删除行和元数据行）
  const full = patch.hunks
    .map(_ => ({
      startLine: _.oldStart,
      content: _.lines
        .filter(_ => !_.startsWith('-') && !_.startsWith('\\'))
        .map(_ => _.slice(1))  // 去掉 diff 前缀符（' '、'+'、'\\'）
        .join('\n'),
    }))
    .map(addLineNumbers)
    .join('\n...\n')  // hunk 间用省略号分隔

  // 未超限则直接返回
  if (full.length <= DIFF_SNIPPET_MAX_BYTES) {
    return full
  }

  // 在最后一个完整行边界截断，追加剩余行数提示
  const cutoff = full.lastIndexOf('\n', DIFF_SNIPPET_MAX_BYTES)
  const kept =
    cutoff > 0 ? full.slice(0, cutoff) : full.slice(0, DIFF_SNIPPET_MAX_BYTES)
  const remaining = countCharInString(full, '\n', kept.length) + 1
  return `${kept}\n\n... [${remaining} lines truncated] ...`
}

// getSnippetForPatch 中每个 hunk 前后的上下文行数
const CONTEXT_LINES = 4

/**
 * 根据 patch hunks 从新文件中提取带行号的上下文片段。
 *
 * 流程：
 * 1. 遍历所有 hunk，确定最小起始行和最大结束行（使用 newLines 计算新文件中的行范围）
 * 2. 在变更范围前后各扩展 CONTEXT_LINES（4）行
 * 3. 从 newFile 按行截取，调用 addLineNumbers() 格式化
 *
 * @param patch   diff hunk 数组（来自 getPatchForEdit）
 * @param newFile 编辑后的完整文件内容
 * @returns 带行号的片段字符串及片段起始行号
 */
export function getSnippetForPatch(
  patch: StructuredPatchHunk[],
  newFile: string,
): { formattedSnippet: string; startLine: number } {
  if (patch.length === 0) {
    // 无变更时返回空片段
    return { formattedSnippet: '', startLine: 1 }
  }

  // 遍历所有 hunk，计算变更的行范围（以原文件行号为基准）
  let minLine = Infinity
  let maxLine = -Infinity

  for (const hunk of patch) {
    if (hunk.oldStart < minLine) {
      minLine = hunk.oldStart
    }
    // 结束行：用 newLines 而非 oldLines，因为我们展示的是新文件内容
    const hunkEnd = hunk.oldStart + (hunk.newLines || 0) - 1
    if (hunkEnd > maxLine) {
      maxLine = hunkEnd
    }
  }

  // 在变更范围前后各扩展 CONTEXT_LINES 行（确保不超出文件范围）
  const startLine = Math.max(1, minLine - CONTEXT_LINES)
  const endLine = maxLine + CONTEXT_LINES

  // 从新文件按行截取片段，调用 addLineNumbers() 格式化
  const fileLines = newFile.split(/\r?\n/)
  const snippetLines = fileLines.slice(startLine - 1, endLine)
  const snippet = snippetLines.join('\n')

  const formattedSnippet = addLineNumbers({
    content: snippet,
    startLine,
  })

  return { formattedSnippet, startLine }
}

/**
 * 获取单次编辑前后的上下文片段（便捷函数）。
 *
 * 使用 before.split(oldString)[0] 定位替换位置，
 * 然后从 applyEditToFile() 的结果中截取 contextLines 行的上下文。
 *
 * @param originalFile  编辑前的文件内容
 * @param oldString     被替换的字符串
 * @param newString     替换后的字符串
 * @param contextLines  前后上下文行数（默认 4）
 * @returns 片段内容及 1-based 起始行号
 */
export function getSnippet(
  originalFile: string,
  oldString: string,
  newString: string,
  contextLines: number = 4,
): { snippet: string; startLine: number } {
  // 定位替换位置：取 oldString 之前的内容，按行拆分后取最后一行的行号
  const before = originalFile.split(oldString)[0] ?? ''
  const replacementLine = before.split(/\r?\n/).length - 1
  const newFileLines = applyEditToFile(
    originalFile,
    oldString,
    newString,
  ).split(/\r?\n/)

  // 计算片段范围（0-based），前后各扩展 contextLines 行
  const startLine = Math.max(0, replacementLine - contextLines)
  const endLine =
    replacementLine + contextLines + newString.split(/\r?\n/).length

  const snippetLines = newFileLines.slice(startLine, endLine)
  const snippet = snippetLines.join('\n')

  return { snippet, startLine: startLine + 1 }  // 返回 1-based 行号
}

/**
 * 将 StructuredPatchHunk[] 反解为 FileEdit[] 数组。
 *
 * 每个 hunk 被转换为一个 FileEdit：
 * - ' '（空格）前缀的行：上下文行，同时进入 old_string 和 new_string
 * - '-' 前缀的行：仅进入 old_string（被删除的行）
 * - '+' 前缀的行：仅进入 new_string（新增的行）
 *
 * 主要用于 userModified 场景：用户在审批界面直接修改了 diff，
 * 需将用户修改后的 patch 反解回 edits 再次应用。
 */
export function getEditsForPatch(patch: StructuredPatchHunk[]): FileEdit[] {
  return patch.map(hunk => {
    const contextLines: string[] = []
    const oldLines: string[] = []
    const newLines: string[] = []

    // 按 diff 前缀分类处理每一行
    for (const line of hunk.lines) {
      if (line.startsWith(' ')) {
        // 上下文行：在新旧版本中均出现
        contextLines.push(line.slice(1))
        oldLines.push(line.slice(1))
        newLines.push(line.slice(1))
      } else if (line.startsWith('-')) {
        // 删除行：仅在旧版本中出现
        oldLines.push(line.slice(1))
      } else if (line.startsWith('+')) {
        // 新增行：仅在新版本中出现
        newLines.push(line.slice(1))
      }
    }

    return {
      old_string: oldLines.join('\n'),
      new_string: newLines.join('\n'),
      replace_all: false,
    }
  })
}

/**
 * 反脱敏替换表：Claude API 对特定 XML 标签做了脱敏处理，
 * 导致模型输出中出现缩写形式（如 fnr 标签）而非原始形式（如 function_results 标签）。
 * 本映射表将缩写形式还原为原始形式，用于在 old_string 匹配失败时进行兜底尝试。
 *
 * 同时包含对话格式脱敏："\n\nH:" → "\n\nHuman:"，"\n\nA:" → "\n\nAssistant:"
 */
const DESANITIZATIONS: Record<string, string> = {
  // XML 标签缩写形式 → 原始形式
  '<fnr>': '<function_results>',
  '<n>': '<name>',
  '</n>': '</name>',
  '<o>': '<output>',
  '</o>': '</output>',
  '<e>': '<error>',
  '</e>': '</error>',
  '<s>': '<system>',
  '</s>': '</system>',
  '<r>': '<result>',
  '</r>': '</result>',
  '< META_START >': '