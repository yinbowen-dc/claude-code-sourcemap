/**
 * 文件差异计算模块（diff.ts）
 *
 * 【在系统流程中的位置】
 * 该模块位于工具层，被 FileEditTool 等编辑工具调用，
 * 负责将文件的旧内容与新内容进行结构化 diff 计算，
 * 同时统计 LOC（代码行数）变更并上报至分析服务。
 *
 * 【主要功能】
 * - adjustHunkLineNumbers()：将 hunk 行号偏移（用于局部文件上下文）
 * - getPatchFromContents()：根据原始内容字符串计算结构化 patch
 * - getPatchForDisplay()：应用编辑列表后计算用于 UI 展示的 patch
 * - countLinesChanged()：统计增删行数并更新全局 LOC 计数器
 *
 * 【特殊处理】
 * `&` 和 `$` 字符会在 diff 计算前被替换为占位符，计算后还原，
 * 以规避 diff 库对这两个字符的解析异常。
 */
import { type StructuredPatchHunk, structuredPatch } from 'diff'
import { logEvent } from 'src/services/analytics/index.js'
import { getLocCounter } from '../bootstrap/state.js'
import { addToTotalLinesChanged } from '../cost-tracker.js'
import type { FileEdit } from '../tools/FileEditTool/types.js'
import { count } from './array.js'
import { convertLeadingTabsToSpaces } from './file.js'

/** 差异展示时的上下文行数（每个 hunk 前后各保留 3 行） */
export const CONTEXT_LINES = 3
/** diff 计算超时时间（毫秒），防止超大文件导致 UI 阻塞 */
export const DIFF_TIMEOUT_MS = 5_000

/**
 * 将 hunk 的行号整体偏移指定量。
 *
 * 【使用场景】
 * 当调用方传入的是文件的一个切片（如 readEditContext 返回的局部内容）
 * 而非完整文件时，diff 计算出的行号是切片内的相对行号。
 * 此函数将其转换为文件全局行号，调用方传入 `ctx.lineOffset - 1` 作为偏移量。
 *
 * @param hunks   原始 hunk 数组
 * @param offset  行号偏移量（0 表示不偏移，直接返回原数组）
 */
export function adjustHunkLineNumbers(
  hunks: StructuredPatchHunk[],
  offset: number,
): StructuredPatchHunk[] {
  // 偏移量为 0 时直接返回原引用，避免不必要的数组重建
  if (offset === 0) return hunks
  // 对每个 hunk 同时偏移旧文件起始行号和新文件起始行号
  return hunks.map(h => ({
    ...h,
    oldStart: h.oldStart + offset,
    newStart: h.newStart + offset,
  }))
}

// diff 库对 & 字符的处理存在 bug，用占位符代替，计算完成后还原
const AMPERSAND_TOKEN = '<<:AMPERSAND_TOKEN:>>'

// diff 库对 $ 字符同样存在解析问题，使用占位符规避
const DOLLAR_TOKEN = '<<:DOLLAR_TOKEN:>>'

/**
 * 将字符串中的 & 和 $ 替换为安全占位符，供 diff 计算使用。
 */
function escapeForDiff(s: string): string {
  return s.replaceAll('&', AMPERSAND_TOKEN).replaceAll('$', DOLLAR_TOKEN)
}

/**
 * 将 diff 计算结果中的占位符还原为原始的 & 和 $ 字符。
 */
function unescapeFromDiff(s: string): string {
  return s.replaceAll(AMPERSAND_TOKEN, '&').replaceAll(DOLLAR_TOKEN, '$')
}

/**
 * 统计 patch 中的增删行数，并更新全局 LOC 计数器与分析事件。
 *
 * 【流程说明】
 * 1. 若 patch 为空且提供了新文件内容（新建文件），将所有行计为新增
 * 2. 否则遍历所有 hunk，统计以 `+` 开头的新增行和以 `-` 开头的删除行
 * 3. 调用 addToTotalLinesChanged() 更新会话级别的总行变更计数
 * 4. 通过 getLocCounter() 更新 OpenTelemetry LOC 指标
 * 5. 触发分析事件 `tengu_file_changed`，附带增删行数
 *
 * @param patch          结构化 diff hunk 数组
 * @param newFileContent 可选：新建文件时提供的文件内容字符串
 */
export function countLinesChanged(
  patch: StructuredPatchHunk[],
  newFileContent?: string,
): void {
  let numAdditions = 0
  let numRemovals = 0

  if (patch.length === 0 && newFileContent) {
    // 新建文件场景：没有 hunk，但所有行都是新增的，按换行符分割计数
    numAdditions = newFileContent.split(/\r?\n/).length
  } else {
    // 已有文件编辑场景：遍历所有 hunk，分别统计 + 和 - 开头的行
    numAdditions = patch.reduce(
      (acc, hunk) => acc + count(hunk.lines, _ => _.startsWith('+')),
      0,
    )
    numRemovals = patch.reduce(
      (acc, hunk) => acc + count(hunk.lines, _ => _.startsWith('-')),
      0,
    )
  }

  // 更新会话级别的总行变更计数（用于成本追踪）
  addToTotalLinesChanged(numAdditions, numRemovals)

  // 更新 OpenTelemetry LOC 指标（可能为 null，安全调用）
  getLocCounter()?.add(numAdditions, { type: 'added' })
  getLocCounter()?.add(numRemovals, { type: 'removed' })

  // 上报文件变更分析事件
  logEvent('tengu_file_changed', {
    lines_added: numAdditions,
    lines_removed: numRemovals,
  })
}

/**
 * 根据旧内容和新内容字符串，计算结构化 patch hunk 数组。
 *
 * 【流程说明】
 * 1. 对两份内容进行 & / $ 字符转义
 * 2. 调用 diff 库的 structuredPatch() 计算差异
 * 3. 将结果 hunk 中的占位符还原为原始字符
 * 4. diff 库返回 falsy 时（如超时）返回空数组
 *
 * @param filePath         文件路径（仅用于 diff 标头，不影响计算）
 * @param oldContent       文件修改前的内容
 * @param newContent       文件修改后的内容
 * @param ignoreWhitespace 是否忽略空白字符差异，默认 false
 * @param singleHunk       是否将所有变更合并为单个 hunk（使用超大上下文行数），默认 false
 */
export function getPatchFromContents({
  filePath,
  oldContent,
  newContent,
  ignoreWhitespace = false,
  singleHunk = false,
}: {
  filePath: string
  oldContent: string
  newContent: string
  ignoreWhitespace?: boolean
  singleHunk?: boolean
}): StructuredPatchHunk[] {
  const result = structuredPatch(
    filePath,
    filePath,
    escapeForDiff(oldContent),
    escapeForDiff(newContent),
    undefined,
    undefined,
    {
      ignoreWhitespace,
      // singleHunk 模式使用极大上下文行数，强制所有变更合并为一个 hunk
      context: singleHunk ? 100_000 : CONTEXT_LINES,
      timeout: DIFF_TIMEOUT_MS,
    },
  )
  // diff 库超时或出错时返回 falsy，此时返回空数组
  if (!result) {
    return []
  }
  // 还原每行中的转义占位符
  return result.hunks.map(_ => ({
    ..._,
    lines: _.lines.map(unescapeFromDiff),
  }))
}

/**
 * 将编辑列表（FileEdit[]）应用于文件内容，计算用于 UI 展示的 patch。
 *
 * 【流程说明】
 * 1. 对原始文件内容转义 & / $ 并将前导 Tab 转换为空格（统一显示）
 * 2. 用 reduce 将所有 FileEdit 依次应用（replace / replaceAll）得到新内容
 * 3. 调用 diff 库计算旧内容与新内容的结构化差异
 * 4. 还原占位符后返回 hunk 数组
 *
 * 注意：所有前导 Tab 会被转换为空格用于展示，不影响实际写盘内容。
 *
 * @param filePath         文件路径
 * @param fileContents     当前文件内容（未应用编辑）
 * @param edits            要应用的编辑列表
 * @param ignoreWhitespace 是否忽略空白字符差异，默认 false
 */
export function getPatchForDisplay({
  filePath,
  fileContents,
  edits,
  ignoreWhitespace = false,
}: {
  filePath: string
  fileContents: string
  edits: FileEdit[]
  ignoreWhitespace?: boolean
}): StructuredPatchHunk[] {
  // 对原始内容进行 Tab→空格转换和特殊字符转义，作为 diff 的旧内容
  const preparedFileContents = escapeForDiff(
    convertLeadingTabsToSpaces(fileContents),
  )
  const result = structuredPatch(
    filePath,
    filePath,
    preparedFileContents,
    // 将所有编辑顺序应用于旧内容，得到新内容（同样经过转义处理）
    edits.reduce((p, edit) => {
      const { old_string, new_string } = edit
      // replace_all 字段控制是否替换所有匹配（仅 FileEditTool 扩展类型有此字段）
      const replace_all = 'replace_all' in edit ? edit.replace_all : false
      const escapedOldString = escapeForDiff(
        convertLeadingTabsToSpaces(old_string),
      )
      const escapedNewString = escapeForDiff(
        convertLeadingTabsToSpaces(new_string),
      )

      if (replace_all) {
        // replaceAll 模式：替换文件中所有匹配的 old_string
        return p.replaceAll(escapedOldString, () => escapedNewString)
      } else {
        // 默认模式：只替换第一个匹配的 old_string
        return p.replace(escapedOldString, () => escapedNewString)
      }
    }, preparedFileContents),
    undefined,
    undefined,
    {
      context: CONTEXT_LINES,
      ignoreWhitespace,
      timeout: DIFF_TIMEOUT_MS,
    },
  )
  // diff 库超时或出错时返回空数组
  if (!result) {
    return []
  }
  // 还原每行中的转义占位符后返回
  return result.hunks.map(_ => ({
    ..._,
    lines: _.lines.map(unescapeFromDiff),
  }))
}
