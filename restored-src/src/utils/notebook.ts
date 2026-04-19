/**
 * 【文件定位】Jupyter Notebook 解析模块 — Claude Code 工具层的 .ipynb 文件处理组件
 *
 * 在 Claude Code 的系统架构中，本文件处于\"工具结果处理\"环节：
 *   ReadNotebookTool 调用 → [本模块：解析 .ipynb 文件] → 生成 ToolResultBlockParam → 发送给 API
 *
 * 主要职责：
 *   1. 读取并解析 Jupyter Notebook 的 JSON 格式（.ipynb），提取各类单元格内容
 *   2. 处理四种输出类型：stream（流输出）、execute_result（执行结果）、display_data（展示数据）、error（错误堆栈）
 *   3. 提取 PNG/JPEG 图像数据，转换为 API 所需的 base64 格式
 *   4. 对超过阈值（10000 字节）的大输出自动替换为 BashTool + jq 建议，避免 token 浪费
 *   5. 将处理后的单元格内容转换为 Anthropic API 的 ToolResultBlockParam 格式，并合并相邻文本块
 *
 * 关键常量：
 *   LARGE_OUTPUT_THRESHOLD = 10000（字节），超出此阈值的 cell 输出将被替换为提示信息
 */

import type {
  ImageBlockParam,
  TextBlockParam,
  ToolResultBlockParam,
} from '@anthropic-ai/sdk/resources/index.mjs'
import { BASH_TOOL_NAME } from '../tools/BashTool/toolName.js'
import { formatOutput } from '../tools/BashTool/utils.js'
import type {
  NotebookCell,
  NotebookCellOutput,
  NotebookCellSource,
  NotebookCellSourceOutput,
  NotebookContent,
  NotebookOutputImage,
} from '../types/notebook.js'
import { getFsImplementation } from './fsOperations.js'
import { expandPath } from './path.js'
import { jsonParse } from './slowOperations.js'

// 单个 cell 所有输出的总大小阈值（字节）
// 超过此值的输出将被替换为「请使用 BashTool + jq 查看」的建议，避免大量 token 消耗
const LARGE_OUTPUT_THRESHOLD = 10000

/**
 * 判断一组处理后的输出总大小是否超过阈值。
 *
 * 流程：累加所有输出的文本长度和图像 base64 数据长度，一旦超过阈值立即返回 true（短路求值）。
 *
 * @param outputs - 处理后的输出数组（含 text 和 image 两类）
 * @returns 是否超出阈值
 */
function isLargeOutputs(
  outputs: (NotebookCellSourceOutput | undefined)[],
): boolean {
  let size = 0
  for (const o of outputs) {
    if (!o) continue
    // 累加文本长度和图像 base64 数据长度
    size += (o.text?.length ?? 0) + (o.image?.image_data.length ?? 0)
    // 一旦超过阈值立即返回（避免继续遍历）
    if (size > LARGE_OUTPUT_THRESHOLD) return true
  }
  return false
}

/**
 * 将输出文本（字符串或字符串数组）统一处理为截断后的单一字符串。
 *
 * 流程：
 *   1. 若 text 为数组（Jupyter 的行数组格式），先合并为一个字符串
 *   2. 调用 BashTool 的 formatOutput 进行截断处理，防止超长输出
 *
 * @param text - 原始文本（字符串、字符串数组或 undefined）
 * @returns 处理后的字符串（可能含省略号表示截断）
 */
function processOutputText(text: string | string[] | undefined): string {
  if (!text) return ''
  // Jupyter 的 text 字段可能是行数组（["line1\n", "line2\n"]），需合并
  const rawText = Array.isArray(text) ? text.join('') : text
  // 使用 BashTool 的截断逻辑（与命令行输出处理保持一致）
  const { truncatedContent } = formatOutput(rawText)
  return truncatedContent
}

/**
 * 从 output.data 字典中提取图像数据（PNG 优先，JPEG 次之）。
 *
 * Jupyter 输出的 data 字段是以 MIME 类型为 key 的字典，
 * 本函数提取第一个可用的图像格式并去除 base64 中的空白字符。
 *
 * @param data - output.data 字典（如 { 'image/png': 'base64data', 'text/plain': '...' }）
 * @returns 图像数据对象（含 base64 数据和 MIME 类型），无图像时返回 undefined
 */
function extractImage(
  data: Record<string, unknown>,
): NotebookOutputImage | undefined {
  // 优先提取 PNG（视觉质量更高）
  if (typeof data['image/png'] === 'string') {
    return {
      // 去除 base64 字符串中的换行符和空格，确保数据格式规范
      image_data: data['image/png'].replace(/\s/g, ''),
      media_type: 'image/png',
    }
  }
  // 其次提取 JPEG
  if (typeof data['image/jpeg'] === 'string') {
    return {
      image_data: data['image/jpeg'].replace(/\s/g, ''),
      media_type: 'image/jpeg',
    }
  }
  return undefined
}

/**
 * 处理单个 cell 输出，将 Jupyter 格式转换为内部统一格式。
 *
 * Jupyter 支持四种输出类型：
 *   - stream：print()、stderr 等流输出，直接包含 text 字段
 *   - execute_result：执行结果（最后一行表达式的值），data 字典格式
 *   - display_data：显示数据（如 matplotlib 图表），data 字典格式
 *   - error：异常信息，包含 ename/evalue/traceback 字段
 *
 * @param output - Jupyter 原始输出对象
 * @returns 内部统一格式的输出对象（含 text 和可选的 image）
 */
function processOutput(output: NotebookCellOutput) {
  switch (output.output_type) {
    case 'stream':
      // 流输出直接提取 text 字段
      return {
        output_type: output.output_type,
        text: processOutputText(output.text),
      }
    case 'execute_result':
    case 'display_data':
      // 执行结果和展示数据：提取纯文本表示和图像数据
      return {
        output_type: output.output_type,
        text: processOutputText(output.data?.['text/plain']),
        image: output.data && extractImage(output.data),
      }
    case 'error':
      // 错误输出：拼接错误名、错误值和堆栈跟踪
      return {
        output_type: output.output_type,
        text: processOutputText(
          `${output.ename}: ${output.evalue}\n${output.traceback.join('\n')}`,
        ),
      }
  }
}

/**
 * 处理单个 Notebook Cell，返回内部统一格式的 NotebookCellSource 对象。
 *
 * 流程：
 *   1. 确定 cell ID（使用 cell.id 或生成 cell-{index} 形式的备用 ID）
 *   2. 合并 cell.source 数组为单一字符串
 *   3. 仅对代码 cell 设置编程语言
 *   4. 处理代码 cell 的输出列表
 *   5. 若输出总大小超过阈值，替换为 BashTool + jq 提示信息
 *
 * @param cell - Jupyter 原始 cell 对象
 * @param index - cell 在 notebook 中的索引（0-based）
 * @param codeLanguage - notebook 的编程语言（如 'python'）
 * @param includeLargeOutputs - 是否强制包含大输出（单独查询特定 cell 时为 true）
 * @returns 处理后的 NotebookCellSource 对象
 */
function processCell(
  cell: NotebookCell,
  index: number,
  codeLanguage: string,
  includeLargeOutputs: boolean,
): NotebookCellSource {
  // 若 cell 无 id 字段（旧版 Jupyter 格式），使用索引生成兼容 ID
  const cellId = cell.id ?? `cell-${index}`
  const cellData: NotebookCellSource = {
    cellType: cell.cell_type,
    // source 可以是字符串或字符串数组，统一合并为字符串
    source: Array.isArray(cell.source) ? cell.source.join('') : cell.source,
    // 只有代码 cell 才有执行计数（Markdown cell 为 undefined）
    execution_count:
      cell.cell_type === 'code' ? cell.execution_count || undefined : undefined,
    cell_id: cellId,
  }
  // Markdown 等非代码 cell 不需要编程语言标注
  if (cell.cell_type === 'code') {
    cellData.language = codeLanguage
  }

  if (cell.cell_type === 'code' && cell.outputs?.length) {
    const outputs = cell.outputs.map(processOutput)
    if (!includeLargeOutputs && isLargeOutputs(outputs)) {
      // 输出过大：替换为建议用 BashTool + jq 直接查询 notebook 文件的提示
      cellData.outputs = [
        {
          output_type: 'stream',
          text: `Outputs are too large to include. Use ${BASH_TOOL_NAME} with: cat <notebook_path> | jq '.cells[${index}].outputs'`,
        },
      ]
    } else {
      cellData.outputs = outputs
    }
  }

  return cellData
}

/**
 * 将单个 cell 内容转换为 API 所需的 TextBlockParam 格式。
 *
 * 格式说明：
 *   - 非代码 cell（Markdown 等）添加 <cell_type> 标签标注类型
 *   - 非 Python 代码 cell 添加 <language> 标签标注编程语言
 *   - 所有 cell 内容包裹在 <cell id="...">...</cell id="..."> 标签中（便于 AI 识别边界）
 *
 * @param cell - 处理后的 cell 数据
 * @returns TextBlockParam 对象（type: 'text'）
 */
function cellContentToToolResult(cell: NotebookCellSource): TextBlockParam {
  const metadata = []
  // 非代码 cell 需标注类型（如 markdown、raw）
  if (cell.cellType !== 'code') {
    metadata.push(`<cell_type>${cell.cellType}</cell_type>`)
  }
  // 非 Python 代码 cell 需标注语言
  if (cell.language !== 'python' && cell.cellType === 'code') {
    metadata.push(`<language>${cell.language}</language>`)
  }
  // 使用 XML 风格标签包裹 cell，id 写在开始和结束标签中便于精确定位
  const cellContent = `<cell id="${cell.cell_id}">${metadata.join('')}${cell.source}</cell id="${cell.cell_id}">`
  return {
    text: cellContent,
    type: 'text',
  }
}

/**
 * 将 cell 的输出列表转换为 TextBlockParam 和 ImageBlockParam 的混合数组。
 *
 * 流程：
 *   - 有 text 内容 → 创建 TextBlockParam（前置换行符与 cell 内容分隔）
 *   - 有 image 数据 → 创建 ImageBlockParam（base64 格式）
 *
 * @param output - 处理后的单个输出数据
 * @returns 对应的 API Block 数组（可能包含文本和/或图像）
 */
function cellOutputToToolResult(output: NotebookCellSourceOutput) {
  const outputs: (TextBlockParam | ImageBlockParam)[] = []
  if (output.text) {
    outputs.push({
      text: `\n${output.text}`,
      type: 'text',
    })
  }
  if (output.image) {
    // 图像以 base64 source 格式发送给 API
    outputs.push({
      type: 'image',
      source: {
        data: output.image.image_data,
        media_type: output.image.media_type,
        type: 'base64',
      },
    })
  }
  return outputs
}

/**
 * 将单个 cell 的内容和输出合并为 API Block 数组。
 *
 * @param cell - 处理后的 cell 数据
 * @returns cell 内容 Block + 所有输出 Block 的平铺数组
 */
function getToolResultFromCell(cell: NotebookCellSource) {
  const contentResult = cellContentToToolResult(cell)
  const outputResults = cell.outputs?.flatMap(cellOutputToToolResult)
  return [contentResult, ...(outputResults ?? [])]
}

/**
 * 读取并解析 Jupyter Notebook 文件，返回处理后的 cell 数组（主要入口）。
 *
 * 流程：
 *   1. 展开路径（处理 ~ 等）后读取文件内容
 *   2. JSON 解析 .ipynb 格式
 *   3. 提取 notebook 的编程语言（默认为 'python'）
 *   4. 若指定了 cellId，只处理该特定 cell（强制包含其完整输出，不受大小限制）
 *   5. 否则处理所有 cell（大输出会被替换为建议提示）
 *
 * @param notebookPath - Notebook 文件路径（支持 ~ 展开）
 * @param cellId - 可选，只返回指定 ID 的 cell
 * @returns 处理后的 cell 数组
 */
export async function readNotebook(
  notebookPath: string,
  cellId?: string,
): Promise<NotebookCellSource[]> {
  // 展开 ~ 等路径符号，获取绝对路径
  const fullPath = expandPath(notebookPath)
  const buffer = await getFsImplementation().readFileBytes(fullPath)
  const content = buffer.toString('utf-8')
  // .ipynb 本质是 JSON 文件，包含 metadata、nbformat、cells 等字段
  const notebook = jsonParse(content) as NotebookContent
  // 从 metadata 中读取编程语言，默认为 python（最常见的 notebook 语言）
  const language = notebook.metadata.language_info?.name ?? 'python'
  if (cellId) {
    // 单 cell 模式：精确查找指定 ID，包含完整输出（不受大小阈值限制）
    const cell = notebook.cells.find(c => c.id === cellId)
    if (!cell) {
      throw new Error(`Cell with ID "${cellId}" not found in notebook`)
    }
    return [processCell(cell, notebook.cells.indexOf(cell), language, true)]
  }
  // 全量模式：处理所有 cell，大输出会被替换为建议提示
  return notebook.cells.map((cell, index) =>
    processCell(cell, index, language, false),
  )
}

/**
 * 将处理后的 cell 数组转换为 API 所需的 ToolResultBlockParam 格式。
 *
 * 关键优化：合并相邻的文本 Block，减少 API 消息中的 Block 数量，降低解析开销。
 *
 * 流程：
 *   1. 对每个 cell 调用 getToolResultFromCell，获取其 Block 列表
 *   2. 平铺所有 Block 为一维数组
 *   3. 通过 reduce 合并相邻 TextBlockParam（直接修改 prev.text，避免创建新对象）
 *
 * @param data - readNotebook 返回的 cell 数组
 * @param toolUseID - 对应的 tool_use 消息 ID（用于关联 tool_result）
 * @returns 包含所有 cell 内容的 ToolResultBlockParam
 */
export function mapNotebookCellsToToolResult(
  data: NotebookCellSource[],
  toolUseID: string,
): ToolResultBlockParam {
  const allResults = data.flatMap(getToolResultFromCell)

  // 合并相邻文本块，减少消息中 Block 的数量
  return {
    tool_use_id: toolUseID,
    type: 'tool_result' as const,
    content: allResults.reduce<(TextBlockParam | ImageBlockParam)[]>(
      (acc, curr) => {
        if (acc.length === 0) return [curr]

        const prev = acc[acc.length - 1]
        if (prev && prev.type === 'text' && curr.type === 'text') {
          // 将当前文本追加到上一个文本 Block（避免创建多个相邻的文本 Block）
          prev.text += '\n' + curr.text
          return acc
        }

        acc.push(curr)
        return acc
      },
      [],
    ),
  }
}

/**
 * 将合成的 cell ID（格式：cell-{数字}）解析回对应的数字索引。
 *
 * 适用场景：当 cell.id 不存在时，系统生成 'cell-{index}' 作为 ID，
 * 此函数用于将这类合成 ID 逆向解析回原始索引值。
 *
 * @param cellId - cell ID 字符串（如 'cell-3'）
 * @returns 对应的数字索引，或 undefined（不符合合成 ID 格式时）
 */
export function parseCellId(cellId: string): number | undefined {
  // 匹配 'cell-数字' 格式
  const match = cellId.match(/^cell-(\d+)$/)
  if (match && match[1]) {
    const index = parseInt(match[1], 10)
    // 防御 NaN（理论上不应出现，但作为安全保障）
    return isNaN(index) ? undefined : index
  }
  return undefined
}
