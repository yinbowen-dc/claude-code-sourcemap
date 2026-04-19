/**
 * schemas.ts — LSPTool 的判别联合输入 Schema 定义
 *
 * 【在 Claude Code 系统中的位置】
 * 本文件为 LSPTool 提供严格类型安全的判别联合输入 Schema。
 * LSPTool.ts 中使用 `inputSchema`（普通 ZodStrictObject）注册工具，
 * 但在 validateInput() 中调用本文件的 `lspToolInputSchema`（判别联合）
 * 完成更精确的类型校验和错误信息生成。
 *
 * 【主要功能】
 * 1. lspToolInputSchema（懒加载）：
 *    - 为 9 种 LSP 操作各自定义独立的 ZodStrictObject Schema
 *    - 所有操作共享相同的 filePath、line、character 字段定义
 *    - 通过 z.discriminatedUnion('operation', [...]) 组合为判别联合
 *    - 判别联合在校验失败时可精确定位是哪个操作的哪个字段出错
 * 2. 导出 LSPToolInput 类型（从 Schema 推断）
 * 3. 导出 isValidLSPOperation() 类型守卫（运行时校验操作名称合法性）
 */

import { z } from 'zod/v4'
import { lazySchema } from '../../utils/lazySchema.js'

/**
 * LSPTool 的判别联合输入 Schema（懒加载）。
 *
 * 每种操作对应一个独立的 ZodStrictObject，使用 'operation' 字段作为判别器。
 * 使用判别联合而非普通 union 的优势：
 * - 校验失败时能精确定位到对应操作的 Schema（而非逐一尝试所有 union 分支）
 * - 错误信息更清晰，便于模型理解并纠正输入
 *
 * 所有 9 个操作 Schema 共享相同的字段结构：
 * - operation：具体操作名称的字面量类型
 * - filePath：目标文件路径（绝对或相对）
 * - line：行号（1-based，与编辑器显示一致）
 * - character：字符偏移（1-based，与编辑器显示一致）
 */
export const lspToolInputSchema = lazySchema(() => {
  /**
   * goToDefinition 操作：查找符号在指定位置的定义
   */
  const goToDefinitionSchema = z.strictObject({
    operation: z.literal('goToDefinition'),
    filePath: z.string().describe('The absolute or relative path to the file'),
    line: z
      .number()
      .int()
      .positive()
      .describe('The line number (1-based, as shown in editors)'),
    character: z
      .number()
      .int()
      .positive()
      .describe('The character offset (1-based, as shown in editors)'),
  })

  /**
   * findReferences 操作：查找指定位置符号的所有引用
   */
  const findReferencesSchema = z.strictObject({
    operation: z.literal('findReferences'),
    filePath: z.string().describe('The absolute or relative path to the file'),
    line: z
      .number()
      .int()
      .positive()
      .describe('The line number (1-based, as shown in editors)'),
    character: z
      .number()
      .int()
      .positive()
      .describe('The character offset (1-based, as shown in editors)'),
  })

  /**
   * hover 操作：获取指定位置符号的悬浮提示（文档、类型信息）
   */
  const hoverSchema = z.strictObject({
    operation: z.literal('hover'),
    filePath: z.string().describe('The absolute or relative path to the file'),
    line: z
      .number()
      .int()
      .positive()
      .describe('The line number (1-based, as shown in editors)'),
    character: z
      .number()
      .int()
      .positive()
      .describe('The character offset (1-based, as shown in editors)'),
  })

  /**
   * documentSymbol 操作：获取文档中的所有符号（函数、类、变量等）
   */
  const documentSymbolSchema = z.strictObject({
    operation: z.literal('documentSymbol'),
    filePath: z.string().describe('The absolute or relative path to the file'),
    line: z
      .number()
      .int()
      .positive()
      .describe('The line number (1-based, as shown in editors)'),
    character: z
      .number()
      .int()
      .positive()
      .describe('The character offset (1-based, as shown in editors)'),
  })

  /**
   * workspaceSymbol 操作：在整个工作区中搜索符号
   */
  const workspaceSymbolSchema = z.strictObject({
    operation: z.literal('workspaceSymbol'),
    filePath: z.string().describe('The absolute or relative path to the file'),
    line: z
      .number()
      .int()
      .positive()
      .describe('The line number (1-based, as shown in editors)'),
    character: z
      .number()
      .int()
      .positive()
      .describe('The character offset (1-based, as shown in editors)'),
  })

  /**
   * goToImplementation 操作：查找接口或抽象方法的实现位置
   */
  const goToImplementationSchema = z.strictObject({
    operation: z.literal('goToImplementation'),
    filePath: z.string().describe('The absolute or relative path to the file'),
    line: z
      .number()
      .int()
      .positive()
      .describe('The line number (1-based, as shown in editors)'),
    character: z
      .number()
      .int()
      .positive()
      .describe('The character offset (1-based, as shown in editors)'),
  })

  /**
   * prepareCallHierarchy 操作：获取指定位置的调用层次条目（调用层次的第一步）
   */
  const prepareCallHierarchySchema = z.strictObject({
    operation: z.literal('prepareCallHierarchy'),
    filePath: z.string().describe('The absolute or relative path to the file'),
    line: z
      .number()
      .int()
      .positive()
      .describe('The line number (1-based, as shown in editors)'),
    character: z
      .number()
      .int()
      .positive()
      .describe('The character offset (1-based, as shown in editors)'),
  })

  /**
   * incomingCalls 操作：查找所有调用指定位置函数的调用者
   */
  const incomingCallsSchema = z.strictObject({
    operation: z.literal('incomingCalls'),
    filePath: z.string().describe('The absolute or relative path to the file'),
    line: z
      .number()
      .int()
      .positive()
      .describe('The line number (1-based, as shown in editors)'),
    character: z
      .number()
      .int()
      .positive()
      .describe('The character offset (1-based, as shown in editors)'),
  })

  /**
   * outgoingCalls 操作：查找指定位置函数调用的所有被调用者
   */
  const outgoingCallsSchema = z.strictObject({
    operation: z.literal('outgoingCalls'),
    filePath: z.string().describe('The absolute or relative path to the file'),
    line: z
      .number()
      .int()
      .positive()
      .describe('The line number (1-based, as shown in editors)'),
    character: z
      .number()
      .int()
      .positive()
      .describe('The character offset (1-based, as shown in editors)'),
  })

  // 将 9 个操作 Schema 组合为判别联合，使用 'operation' 字段作为判别器
  return z.discriminatedUnion('operation', [
    goToDefinitionSchema,
    findReferencesSchema,
    hoverSchema,
    documentSymbolSchema,
    workspaceSymbolSchema,
    goToImplementationSchema,
    prepareCallHierarchySchema,
    incomingCallsSchema,
    outgoingCallsSchema,
  ])
})

/**
 * LSPTool 输入的 TypeScript 类型（从 Schema 推断）。
 * 供工具实现文件使用，确保类型安全。
 */
export type LSPToolInput = z.infer<ReturnType<typeof lspToolInputSchema>>

/**
 * 类型守卫：校验字符串是否为合法的 LSP 操作名称。
 *
 * 用于运行时快速检查 operation 字段合法性，
 * 相比完整 Schema 校验更轻量，适用于仅需操作名验证的场景。
 *
 * @param operation - 待校验的操作名称字符串
 * @returns true 表示是合法的 LSPToolInput['operation'] 类型
 */
export function isValidLSPOperation(
  operation: string,
): operation is LSPToolInput['operation'] {
  return [
    'goToDefinition',
    'findReferences',
    'hover',
    'documentSymbol',
    'workspaceSymbol',
    'goToImplementation',
    'prepareCallHierarchy',
    'incomingCalls',
    'outgoingCalls',
  ].includes(operation)
}
