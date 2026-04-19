/**
 * prompt.ts — FileReadTool 的提示词模板与常量定义
 *
 * 【在 Claude Code 系统中的位置】
 * 本文件为 FileReadTool 提供工具名称、行为常量和提示词生成函数。
 * FileReadTool.ts 在构建工具定义时调用 renderPromptTemplate() 动态生成完整提示词，
 * 并将本文件导出的常量用于去重判断（FILE_UNCHANGED_STUB）、分页控制（MAX_LINES_TO_READ）
 * 以及返回给模型的格式说明（LINE_FORMAT_INSTRUCTION、OFFSET_INSTRUCTION_*）。
 *
 * 【主要功能】
 * - 导出工具名称常量 FILE_READ_TOOL_NAME，供全局引用（避免循环依赖）
 * - 导出 FILE_UNCHANGED_STUB：文件未变化时返回给模型的轻量占位文本
 * - 导出 MAX_LINES_TO_READ：单次读取的默认最大行数（2000）
 * - 导出三条可插拔的提示词片段（LINE_FORMAT_INSTRUCTION、OFFSET_INSTRUCTION_DEFAULT、
 *   OFFSET_INSTRUCTION_TARGETED），由 FileReadTool 根据运行时配置选择注入
 * - renderPromptTemplate()：将三段动态片段拼装为完整的工具提示词字符串，
 *   并根据 isPDFSupported() 决定是否插入 PDF 使用说明
 */

import { isPDFSupported } from '../../utils/pdfUtils.js'
import { BASH_TOOL_NAME } from '../BashTool/toolName.js'

// 使用字符串常量存储工具名称，避免因直接引用工具对象产生循环依赖
export const FILE_READ_TOOL_NAME = 'Read'

/**
 * 文件未变化时返回给模型的占位文本。
 * 当 FileReadTool 检测到文件自上次读取以来未发生变化（mtime + 内容均相同）时，
 * 返回此字符串代替完整文件内容，节省 token 消耗并提示模型复用之前的读取结果。
 */
export const FILE_UNCHANGED_STUB =
  'File unchanged since last read. The content from the earlier Read tool_result in this conversation is still current — refer to that instead of re-reading.'

/** 单次文件读取返回的默认最大行数。超出此行数时模型应使用 offset/limit 分段读取。 */
export const MAX_LINES_TO_READ = 2000

/** 工具简短描述，用于 Claude API tool definition 的 description 字段 */
export const DESCRIPTION = 'Read a file from the local filesystem.'

/**
 * 提示词片段：说明输出格式为 cat -n 风格（附行号，从 1 开始）。
 * 由 renderPromptTemplate() 注入到完整提示词中。
 */
export const LINE_FORMAT_INSTRUCTION =
  '- Results are returned using cat -n format, with line numbers starting at 1'

/**
 * 默认的分页偏移说明：告知模型可以指定 offset/limit，但推荐不指定以读取完整文件。
 * 适用于未开启 targetedRangeNudge 特性标志时的场景。
 */
export const OFFSET_INSTRUCTION_DEFAULT =
  "- You can optionally specify a line offset and limit (especially handy for long files), but it's recommended to read the whole file by not providing these parameters"

/**
 * 精准范围分页说明：鼓励模型仅读取所需部分，对大文件尤为重要。
 * 当 GrowthBook 特性标志 targetedRangeNudge 为 true 时，FileReadTool 使用此版本替换默认说明。
 */
export const OFFSET_INSTRUCTION_TARGETED =
  '- When you already know which part of the file you need, only read that part. This can be important for larger files.'

/**
 * 生成 FileReadTool 的完整提示词字符串。
 *
 * 调用方（FileReadTool）负责提供运行时动态计算的三段内容：
 * - lineFormat：行号格式说明（来自 LINE_FORMAT_INSTRUCTION）
 * - maxSizeInstruction：最大文件大小/行数说明（含换行前缀，可为空字符串）
 * - offsetInstruction：分页偏移说明（DEFAULT 或 TARGETED 版本）
 *
 * 此外，函数内部通过 isPDFSupported() 探测运行环境是否支持 PDF 读取，
 * 若支持则插入 PDF 专属使用约束（分页参数、最大页数等）。
 *
 * @param lineFormat - 行号格式说明片段
 * @param maxSizeInstruction - 文件大小限制说明（可为空）
 * @param offsetInstruction - 分页偏移使用说明
 * @returns 完整的工具提示词字符串
 */
export function renderPromptTemplate(
  lineFormat: string,
  maxSizeInstruction: string,
  offsetInstruction: string,
): string {
  return `Reads a file from the local filesystem. You can access any file directly by using this tool.
Assume this tool is able to read all files on the machine. If the User provides a path to a file assume that path is valid. It is okay to read a file that does not exist; an error will be returned.

Usage:
- The file_path parameter must be an absolute path, not a relative path
- By default, it reads up to ${MAX_LINES_TO_READ} lines starting from the beginning of the file${maxSizeInstruction}
${offsetInstruction}
${lineFormat}
- This tool allows Claude Code to read images (eg PNG, JPG, etc). When reading an image file the contents are presented visually as Claude Code is a multimodal LLM.${
    // 仅在运行环境支持 PDF（安装了 poppler-utils 或 API 原生支持）时插入 PDF 说明
    isPDFSupported()
      ? '\n- This tool can read PDF files (.pdf). For large PDFs (more than 10 pages), you MUST provide the pages parameter to read specific page ranges (e.g., pages: "1-5"). Reading a large PDF without the pages parameter will fail. Maximum 20 pages per request.'
      : ''
  }
- This tool can read Jupyter notebooks (.ipynb files) and returns all cells with their outputs, combining code, text, and visualizations.
- This tool can only read files, not directories. To read a directory, use an ls command via the ${BASH_TOOL_NAME} tool.
- You will regularly be asked to read screenshots. If the user provides a path to a screenshot, ALWAYS use this tool to view the file at the path. This tool will work with all temporary file paths.
- If you read a file that exists but has empty contents you will receive a system reminder warning in place of file contents.`
}
