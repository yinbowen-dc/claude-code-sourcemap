/**
 * SyntheticOutputTool/SyntheticOutputTool.ts — 结构化输出工具定义
 *
 * 在 Claude Code 系统流程中的位置：
 *   工具层（Tools Layer）→ SyntheticOutputTool 子模块 → 工具执行层
 *
 * 主要功能：
 *   - 为非交互式 SDK 会话提供结构化 JSON 输出能力
 *   - 基础工具（SyntheticOutputTool）：透传任意输入，不做 schema 校验
 *   - 工厂函数（createSyntheticOutputTool）：接受 JSON Schema，编译 Ajv 验证器后返回带校验的工具实例
 *   - WeakMap 身份缓存（toolCache）：同一 schema 对象引用只编译一次，大幅降低重复构建开销
 *
 * 设计说明：
 *   - isSyntheticOutputToolEnabled()：仅在非交互式会话（isNonInteractiveSession=true）时启用
 *   - SyntheticOutputTool 基础定义一旦创建即始终启用（isEnabled 固定返回 true）
 *   - buildSyntheticOutputTool()：使用 Ajv allErrors 模式编译 schema，验证失败时抛出 TelemetrySafeError
 *   - toolCache 使用 WeakMap 存储，schema 对象被 GC 时缓存自动释放，无内存泄漏风险
 */

import { Ajv } from 'ajv'
import { z } from 'zod/v4'
import type { Tool, ToolInputJSONSchema } from '../../Tool.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from '../../utils/errors.js'
import { lazySchema } from '../../utils/lazySchema.js'
import type { PermissionResult } from '../../utils/permissions/PermissionResult.js'
import { jsonStringify } from '../../utils/slowOperations.js'

// 输入 Schema：透传任意对象（passthrough），schema 由调用方动态提供
// Allow any input object since the schema is provided dynamically
const inputSchema = lazySchema(() => z.object({}).passthrough())
type InputSchema = ReturnType<typeof inputSchema>

// 输出 Schema：结构化输出工具结果（字符串形式）
const outputSchema = lazySchema(() =>
  z.string().describe('Structured output tool result'),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

// 结构化输出工具的注册名称，供工具列表和模型调用时识别
export const SYNTHETIC_OUTPUT_TOOL_NAME = 'StructuredOutput'

/**
 * 判断结构化输出工具是否应启用
 *
 * @param opts.isNonInteractiveSession 是否为非交互式 SDK 会话
 * @returns true 表示启用（仅非交互式会话）
 */
export function isSyntheticOutputToolEnabled(opts: {
  isNonInteractiveSession: boolean
}): boolean {
  // 仅在非交互式 SDK/CLI 会话中启用，交互式对话不需要结构化输出
  return opts.isNonInteractiveSession
}

/**
 * SyntheticOutputTool — 结构化输出工具的基础定义
 *
 * 此工具为基础模板，不执行 JSON Schema 校验。
 * 实际使用时应通过 createSyntheticOutputTool() 获取带 schema 校验的版本。
 *
 * 整体流程（基础版）：
 *   1. 接收任意输入对象（passthrough）
 *   2. checkPermissions 固定返回 allow（只读数据返回，无需权限）
 *   3. call() 直接返回成功消息 + 原始输入（作为 structured_output）
 *   4. mapToolResultToToolResultBlockParam 返回透传的内容字符串
 */
export const SyntheticOutputTool = buildTool({
  isMcp: false,
  /**
   * 工具启用状态：基础工具一旦被创建即始终启用
   * （实际启用条件由 main.tsx 中的 isSyntheticOutputToolEnabled() 控制工具创建）
   */
  isEnabled() {
    // This tool is only created when conditions are met (see main.tsx where
    // isSyntheticOutputToolEnabled() gates tool creation). Once created, always enabled.
    return true
  },
  /**
   * 标记为并发安全：只返回数据，不存在状态竞争
   */
  isConcurrencySafe() {
    return true
  },
  /**
   * 标记为只读：仅返回数据，不修改任何状态
   */
  isReadOnly() {
    return true
  },
  /**
   * 标记为封闭世界：不访问任何外部资源
   */
  isOpenWorld() {
    return false
  },
  // 工具注册名，供模型调用时识别
  name: SYNTHETIC_OUTPUT_TOOL_NAME,
  // 自动分类器使用的搜索提示
  searchHint: 'return the final response as structured JSON',
  // 单次工具调用结果的最大字符数
  maxResultSizeChars: 100_000,
  /**
   * 返回工具的功能简介
   */
  async description(): Promise<string> {
    return 'Return structured output in the requested format'
  },
  /**
   * 返回系统提示词：告知模型必须在响应末尾恰好调用一次此工具以提供结构化输出
   */
  async prompt(): Promise<string> {
    return `Use this tool to return your final response in the requested structured format. You MUST call this tool exactly once at the end of your response to provide the structured output.`
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  /**
   * 工具执行逻辑（基础版，无 schema 校验）：
   *   直接将输入作为 structured_output 返回，不做任何校验
   */
  async call(input) {
    // The tool just validates and returns the input as the structured output
    return {
      data: 'Structured output provided successfully',
      structured_output: input,
    }
  },
  /**
   * 权限检查：固定允许（仅返回数据，无需写权限）
   */
  async checkPermissions(input): Promise<PermissionResult> {
    // Always allow this tool - it's just returning data
    return {
      behavior: 'allow',
      updatedInput: input,
    }
  },
  // Minimal UI implementations - this tool is for non-interactive SDK/CLI use
  /**
   * 工具调用时的 UI 展示：
   *   - 无字段时返回 null（静默）
   *   - 3 个及以下字段时展示所有键值对
   *   - 超过 3 个字段时展示字段数量及前三个字段名（省略号截断）
   */
  renderToolUseMessage(input: Record<string, unknown>) {
    const keys = Object.keys(input)
    // 无字段时静默不展示
    if (keys.length === 0) return null
    // 3 个及以下字段：展示所有键值对
    if (keys.length <= 3) {
      return keys.map(k => `${k}: ${jsonStringify(input[k])}`).join(', ')
    }
    // 超过 3 个字段：展示字段总数及前三个字段名（省略号截断）
    return `${keys.length} fields: ${keys.slice(0, 3).join(', ')}…`
  },
  /**
   * 工具调用被拒绝时的 UI 展示
   */
  renderToolUseRejectedMessage() {
    return 'Structured output rejected'
  },
  /**
   * 工具调用出错时的 UI 展示
   */
  renderToolUseErrorMessage() {
    return 'Structured output error'
  },
  /**
   * 工具调用进行中的 UI 展示（不展示）
   */
  renderToolUseProgressMessage() {
    return null
  },
  /**
   * 工具结果的 UI 展示：直接透传输出字符串
   */
  renderToolResultMessage(output: string) {
    return output
  },
  /**
   * 将工具输出映射为 Anthropic API 格式的 tool_result 块
   */
  mapToolResultToToolResultBlockParam(content: string, toolUseID: string) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result' as const,
      content,
    }
  },
} satisfies ToolDef<InputSchema, Output>)

// createSyntheticOutputTool 的返回类型：成功时含 tool，失败时含 error 字符串
type CreateResult = { tool: Tool<InputSchema> } | { error: string }

// Workflow scripts call agent({schema: BUGS_SCHEMA}) 30-80 times per run with
// the same schema object reference. Without caching, each call does
// new Ajv() + validateSchema() + compile() (~1.4ms of JIT codegen). Identity
// cache brings 80-call workflows from ~110ms to ~4ms Ajv overhead.
// WeakMap 身份缓存：以 schema 对象引用为键，避免同一 schema 重复编译
// 工作流脚本会对同一 schema 对象引用调用 30-80 次 agent()，
// 通过身份缓存将 80 次调用的 Ajv 开销从 ~110ms 降至 ~4ms
const toolCache = new WeakMap<object, CreateResult>()

/**
 * 创建带 JSON Schema 校验的 SyntheticOutputTool 实例
 *
 * 整体流程：
 *   1. 检查 toolCache 中是否已有该 schema 对象对应的编译结果（身份缓存）
 *   2. 缓存命中时直接返回，避免重复编译
 *   3. 缓存未命中时调用 buildSyntheticOutputTool() 编译 schema
 *   4. 将编译结果存入缓存后返回
 *
 * Create a SyntheticOutputTool configured with the given JSON schema.
 * Returns {tool} on success or {error} with Ajv's diagnostic message
 * (e.g. "data/properties/bugs should be object") on invalid schema.
 *
 * @param jsonSchema 用于校验模型输出的 JSON Schema 对象
 * @returns { tool } 成功时含工具实例；{ error } 失败时含 Ajv 错误信息
 */
export function createSyntheticOutputTool(
  jsonSchema: Record<string, unknown>,
): CreateResult {
  // 检查身份缓存，同一对象引用直接返回
  const cached = toolCache.get(jsonSchema)
  if (cached) return cached

  // 编译 schema 并创建工具实例
  const result = buildSyntheticOutputTool(jsonSchema)
  // 将结果存入身份缓存
  toolCache.set(jsonSchema, result)
  return result
}

/**
 * 内部函数：使用 Ajv 编译 JSON Schema 并构建带校验逻辑的工具实例
 *
 * 整体流程：
 *   1. 创建 Ajv 实例（allErrors 模式：收集所有错误而非遇到第一个就停止）
 *   2. 用 validateSchema() 验证 schema 本身是否合法
 *   3. schema 非法时返回 { error: ajv.errorsText() }
 *   4. schema 合法时 compile() 生成高效的验证函数
 *   5. 返回扩展了 SyntheticOutputTool 的新工具对象，其 call() 方法包含 schema 校验逻辑
 *   6. 输入不符合 schema 时抛出 TelemetrySafeError（含用户可读的字段路径和错误描述）
 *
 * @param jsonSchema 待编译的 JSON Schema 对象
 * @returns { tool } 或 { error }
 */
function buildSyntheticOutputTool(
  jsonSchema: Record<string, unknown>,
): CreateResult {
  try {
    // 创建 Ajv 实例，启用 allErrors 以收集所有校验错误
    const ajv = new Ajv({ allErrors: true })
    // 先验证 schema 本身的合法性（meta-schema 校验）
    const isValidSchema = ajv.validateSchema(jsonSchema)
    if (!isValidSchema) {
      // schema 本身非法，返回 Ajv 错误文本（用于向调用方报告配置错误）
      return { error: ajv.errorsText(ajv.errors) }
    }
    // 将 schema 编译为高效的验证函数（JIT 代码生成）
    const validateSchema = ajv.compile(jsonSchema)

    return {
      tool: {
        // 基于 SyntheticOutputTool 基础定义扩展，替换 inputJSONSchema 和 call
        ...SyntheticOutputTool,
        // 将 JSON Schema 注入工具定义，供 API 层向模型传递参数约束
        inputJSONSchema: jsonSchema as ToolInputJSONSchema,
        /**
         * 带 schema 校验的 call() 实现：
         *   1. 使用编译好的 validateSchema 函数校验模型输入
         *   2. 校验失败时，将所有错误格式化为"字段路径: 错误描述"并抛出 TelemetrySafeError
         *   3. 校验通过时返回成功消息和 structured_output
         */
        async call(input) {
          // 使用编译好的验证函数校验输入
          const isValid = validateSchema(input)
          if (!isValid) {
            // 将所有校验错误格式化为可读字符串（字段路径 + 错误描述）
            const errors = validateSchema.errors
              ?.map(e => `${e.instancePath || 'root'}: ${e.message}`)
              .join(', ')
            // 抛出遥测安全错误（不包含代码或文件路径等敏感信息）
            throw new TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS(
              `Output does not match required schema: ${errors}`,
              // 遥测消息截断至 150 字符，防止大量字段信息泄漏
              `StructuredOutput schema mismatch: ${(errors ?? '').slice(0, 150)}`,
            )
          }
          return {
            data: 'Structured output provided successfully',
            structured_output: input,
          }
        },
      },
    }
  } catch (e) {
    // 捕获 Ajv compile() 抛出的意外错误（如不支持的 schema 关键字）
    return { error: e instanceof Error ? e.message : String(e) }
  }
}
