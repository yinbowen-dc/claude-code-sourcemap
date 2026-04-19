/**
 * 【FileEditTool 类型定义模块】
 *
 * 在 Claude Code 系统流程中的位置：
 *   本文件为 FileEditTool 定义所有输入/输出的 Zod Schema 和 TypeScript 类型。
 *   FileEditTool.ts、utils.ts 等核心模块均从此处导入类型和 Schema。
 *
 * 主要功能：
 *   - inputSchema：定义工具的输入结构（file_path、old_string、new_string、replace_all）
 *   - FileEditInput / EditInput / FileEdit：对应不同使用场景的输入类型
 *   - hunkSchema：diff 格式的单个变更块（hunk）结构
 *   - gitDiffSchema：Git diff 结果的完整结构（含 GitHub 仓库信息）
 *   - outputSchema：call() 返回值的 Zod Schema
 *   - FileEditOutput：call() 返回值的 TypeScript 类型
 */

import { z } from 'zod/v4'
import { lazySchema } from '../../utils/lazySchema.js'
import { semanticBoolean } from '../../utils/semanticBoolean.js'

/**
 * FileEditTool 输入 Schema（懒加载，避免循环依赖）。
 *
 * 字段说明：
 * - file_path：要修改的文件的绝对路径
 * - old_string：被替换的文本（必须唯一，否则需要 replace_all）
 * - new_string：替换后的文本（必须与 old_string 不同）
 * - replace_all：是否替换所有匹配项（默认 false；使用 semanticBoolean 兼容字符串 "true"/"false"）
 */
// The input schema with optional replace_all
const inputSchema = lazySchema(() =>
  z.strictObject({
    file_path: z.string().describe('The absolute path to the file to modify'),
    old_string: z.string().describe('The text to replace'),
    new_string: z
      .string()
      .describe(
        'The text to replace it with (must be different from old_string)',
      ),
    replace_all: semanticBoolean(
      z.boolean().default(false).optional(),
    ).describe('Replace all occurrences of old_string (default false)'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

// 解析后的输出类型——call() 接收的是 z.output 而非 z.input：
// semanticBoolean 的输入侧接受任意类型（preprocess 接受一切），
// 故使用 z.output 确保 replace_all 已被转换为 boolean
export type FileEditInput = z.output<InputSchema>

// 不含 file_path 的单次编辑输入类型（用于批量编辑工具内部）
export type EditInput = Omit<FileEditInput, 'file_path'>

// 运行时版本：replace_all 始终为 boolean（已去除 undefined 可能性）
export type FileEdit = {
  old_string: string
  new_string: string
  replace_all: boolean
}

/**
 * diff hunk（变更块）Schema：表示 diff 中的一个连续变更区段。
 * 字段含义与 unified diff 格式一致（oldStart/newStart 为 1-based 行号）。
 */
export const hunkSchema = lazySchema(() =>
  z.object({
    oldStart: z.number(),   // 旧文件变更起始行号
    oldLines: z.number(),   // 旧文件变更行数
    newStart: z.number(),   // 新文件变更起始行号
    newLines: z.number(),   // 新文件变更行数
    lines: z.array(z.string()),  // 变更行（" " 上下文行，"-" 删除行，"+" 新增行）
  }),
)

/**
 * Git diff 结果 Schema：用于 REMOTE 模式下获取实际 git diff 信息。
 * repository 字段在可用时提供 GitHub owner/repo 引用。
 */
export const gitDiffSchema = lazySchema(() =>
  z.object({
    filename: z.string(),                      // 变更文件名
    status: z.enum(['modified', 'added']),     // 文件状态
    additions: z.number(),                     // 新增行数
    deletions: z.number(),                     // 删除行数
    changes: z.number(),                       // 总变更行数
    patch: z.string(),                         // diff patch 文本
    repository: z
      .string()
      .nullable()
      .optional()
      .describe('GitHub owner/repo when available'),  // GitHub 仓库（可选）
  }),
)

/**
 * FileEditTool 输出 Schema：call() 返回给 UI 和 AI 的结构化数据。
 *
 * 字段说明：
 * - filePath：被编辑的文件路径
 * - oldString：实际被替换的文本（经过 quote 规范化后的实际内容）
 * - newString：替换后的文本
 * - originalFile：编辑前的完整文件内容（用于 diff 渲染）
 * - structuredPatch：结构化的 diff hunk 数组（供 UI 渲染变更预览）
 * - userModified：用户是否在审批时修改了提议的变更
 * - replaceAll：是否使用了 replace_all 模式
 * - gitDiff：可选的 git diff 信息（仅 REMOTE + feature 开关启用时填充）
 */
// Output schema for FileEditTool
const outputSchema = lazySchema(() =>
  z.object({
    filePath: z.string().describe('The file path that was edited'),
    oldString: z.string().describe('The original string that was replaced'),
    newString: z.string().describe('The new string that replaced it'),
    originalFile: z
      .string()
      .describe('The original file contents before editing'),
    structuredPatch: z
      .array(hunkSchema())
      .describe('Diff patch showing the changes'),
    userModified: z
      .boolean()
      .describe('Whether the user modified the proposed changes'),
    replaceAll: z.boolean().describe('Whether all occurrences were replaced'),
    gitDiff: gitDiffSchema().optional(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type FileEditOutput = z.infer<OutputSchema>

export { inputSchema, outputSchema }
