/**
 * Zod 模式到 JSON Schema 的转换器
 *
 * 在 Claude Code 系统流程中的位置：
 * 此模块是工具 API 接口的底层转换层。每次 API 请求时，
 * toolToAPISchema() 会调用此函数将所有工具的 Zod 输入模式转换为
 * Anthropic API 可接受的 JSON Schema 格式。
 *
 * 主要功能：
 * - 利用 Zod v4 原生的 toJSONSchema() 将 ZodTypeAny 转换为标准 JSON Schema
 * - 通过 WeakMap 按 schema 对象引用缓存转换结果，避免重复计算
 * - 每次对话会话约调用 60–250 次，缓存策略极为关键
 */

import { toJSONSchema, type ZodTypeAny } from 'zod/v4'

// 通用 JSON Schema 类型，表示任意 JSON 对象结构
export type JsonSchema7Type = Record<string, unknown>

// toolToAPISchema() 在每次 API 请求时对每个工具执行此操作（约 60-250 次/轮）。
// 工具模式由 lazySchema() 包装，保证每个会话中同一 ZodTypeAny 引用不变，
// 因此可以按对象引用（WeakMap 键）缓存，命中时直接返回，无需重复转换。
const cache = new WeakMap<ZodTypeAny, JsonSchema7Type>()

/**
 * 将 Zod v4 schema 转换为 JSON Schema 格式。
 *
 * 流程：
 * 1. 先在 WeakMap 缓存中按对象引用查找
 * 2. 缓存命中 → 直接返回已计算结果，零重新计算开销
 * 3. 缓存未命中 → 调用 Zod v4 原生 toJSONSchema() 转换
 * 4. 将转换结果写入缓存，供后续请求复用
 *
 * @param schema 要转换的 Zod v4 schema 对象
 * @returns 符合 JSON Schema 规范的对象
 */
export function zodToJsonSchema(schema: ZodTypeAny): JsonSchema7Type {
  // 尝试从缓存中获取已转换的结果
  const hit = cache.get(schema)
  if (hit) return hit // 命中缓存，直接返回

  // 缓存未命中，调用 Zod v4 原生转换方法
  const result = toJSONSchema(schema) as JsonSchema7Type

  // 将结果存入缓存，按 schema 对象引用索引
  cache.set(schema, result)
  return result
}
