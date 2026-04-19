/**
 * elicitationValidation.ts — MCP Elicitation 输入校验模块
 *
 * 【系统流程定位】
 * 本模块处于 MCP（Model Context Protocol）Elicitation（用户数据采集）
 * 表单的输入校验层。当 MCP 服务端通过 elicitation 机制请求用户填写结构化数据时，
 * Claude Code 会弹出交互式表单，本模块负责在提交前对用户输入进行校验。
 *
 * 【主要职责】
 * 1. 将 MCP PrimitiveSchemaDefinition 转换为 Zod v4 校验 Schema（getZodSchema）；
 * 2. 提供同步校验入口（validateElicitationInput），用于即时输入反馈；
 * 3. 提供异步校验入口（validateElicitationInputAsync），在 date/date-time 字段
 *    同步校验失败时，尝试通过 Haiku 进行自然语言日期解析后再校验；
 * 4. 提供枚举 Schema 的值/标签提取工具函数，兼容 legacy enum 和新 oneOf 格式；
 * 5. 提供格式提示生成（getFormatHint），用于在表单 UI 中显示输入格式示例。
 *
 * 【枚举 Schema 双格式兼容】
 * MCP SDK 中枚举字段有两种表示方式：
 * - 旧格式：{ type: 'string', enum: ['a', 'b'], enumNames: ['A', 'B'] }
 * - 新格式：{ type: 'string', oneOf: [{ const: 'a', title: 'A' }] }
 * 所有枚举工具函数均兼容两种格式，通过 'oneOf' in schema 分支判断。
 *
 * 【多选枚举】
 * 类型为 array 且 items 含 enum/anyOf 的 Schema 被视为多选枚举（MultiSelectEnumSchema）。
 * items.anyOf 对应新格式（每项含 const + title），items.enum 对应旧格式。
 *
 * 【典型调用链】
 * 用户输入 → validateElicitationInput()（同步）
 *   → 成功 → ValidationResult { isValid: true, value }
 *   → 失败 → isDateTimeSchema() && !looksLikeISO8601() →
 *     parseNaturalLanguageDateTime() → validateElicitationInput()（二次校验）
 *       → 成功 → ValidationResult { isValid: true, value }
 *       → 失败 → 原始同步错误的 ValidationResult
 */

import type {
  EnumSchema,
  MultiSelectEnumSchema,
  PrimitiveSchemaDefinition,
  StringSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod/v4'
import { jsonStringify } from '../slowOperations.js'
import { plural } from '../stringUtils.js'
import {
  looksLikeISO8601,
  parseNaturalLanguageDateTime,
} from './dateTimeParser.js'

/**
 * 校验结果类型。
 *
 * - isValid=true：value 为校验通过后的类型化值（string | number | boolean）；
 * - isValid=false：error 为用户可读的错误提示字符串。
 */
export type ValidationResult = {
  value?: string | number | boolean
  isValid: boolean
  error?: string
}

/**
 * 字符串格式的描述与示例映射表。
 *
 * 用于 getFormatHint() 为 email、uri、date、date-time 格式字段
 * 生成友好的占位提示文本（如 "email address, e.g. user@example.com"）。
 */
const STRING_FORMATS = {
  email: {
    description: 'email address',
    example: 'user@example.com',
  },
  uri: {
    description: 'URI',
    example: 'https://example.com',
  },
  date: {
    description: 'date',
    example: '2024-03-15',
  },
  'date-time': {
    description: 'date-time',
    example: '2024-03-15T14:30:00Z',
  },
}

/**
 * 判断 Schema 是否为单选枚举类型。
 *
 * 同时兼容：
 * - 旧格式：{ type: 'string', enum: [...] }
 * - 新格式：{ type: 'string', oneOf: [...] }
 *
 * @param schema MCP 原始 Schema 定义
 * @returns 若为枚举 Schema 则为 true，并将类型收窄为 EnumSchema
 */
export const isEnumSchema = (
  schema: PrimitiveSchemaDefinition,
): schema is EnumSchema => {
  // 类型为 string 且含有 enum 或 oneOf 属性即视为枚举
  return schema.type === 'string' && ('enum' in schema || 'oneOf' in schema)
}

/**
 * 判断 Schema 是否为多选枚举类型（type: "array" 且 items 含枚举定义）。
 *
 * 兼容：
 * - items.enum（旧格式）
 * - items.anyOf（新格式，每项含 const + title）
 *
 * @param schema MCP 原始 Schema 定义
 * @returns 若为多选枚举 Schema 则为 true，并将类型收窄为 MultiSelectEnumSchema
 */
export function isMultiSelectEnumSchema(
  schema: PrimitiveSchemaDefinition,
): schema is MultiSelectEnumSchema {
  return (
    schema.type === 'array' &&
    'items' in schema &&
    typeof schema.items === 'object' &&
    schema.items !== null &&
    // 支持旧格式 items.enum 和新格式 items.anyOf
    ('enum' in schema.items || 'anyOf' in schema.items)
  )
}

/**
 * 从多选枚举 Schema 中提取选项值列表。
 *
 * - anyOf 格式：取每个 item 的 const 字段；
 * - enum 格式：直接返回 enum 数组。
 *
 * @param schema 多选枚举 Schema
 * @returns 选项值字符串数组
 */
export function getMultiSelectValues(schema: MultiSelectEnumSchema): string[] {
  if ('anyOf' in schema.items) {
    // 新格式：items.anyOf 中每项的 const 即为选项值
    return schema.items.anyOf.map(item => item.const)
  }
  if ('enum' in schema.items) {
    // 旧格式：直接使用 items.enum 数组
    return schema.items.enum
  }
  return []
}

/**
 * 从多选枚举 Schema 中提取选项显示标签列表。
 *
 * - anyOf 格式：取每个 item 的 title 字段（人类可读名称）；
 * - enum 格式：标签与值相同（旧格式不区分值和标签）。
 *
 * @param schema 多选枚举 Schema
 * @returns 选项标签字符串数组（顺序与 getMultiSelectValues 对应）
 */
export function getMultiSelectLabels(schema: MultiSelectEnumSchema): string[] {
  if ('anyOf' in schema.items) {
    // 新格式：title 为显示用的人类可读标签
    return schema.items.anyOf.map(item => item.title)
  }
  if ('enum' in schema.items) {
    // 旧格式无单独标签，直接复用枚举值作为标签
    return schema.items.enum
  }
  return []
}

/**
 * 获取多选枚举中特定值对应的显示标签。
 *
 * 通过 getMultiSelectValues 找到值的索引，再从 getMultiSelectLabels 取对应标签。
 * 若值不在枚举中，回退返回原始值字符串。
 *
 * @param schema 多选枚举 Schema
 * @param value  要查找的枚举值
 * @returns 对应的显示标签，若未找到则返回原始值
 */
export function getMultiSelectLabel(
  schema: MultiSelectEnumSchema,
  value: string,
): string {
  const index = getMultiSelectValues(schema).indexOf(value)
  // index < 0 表示值不在枚举中，回退到原始值；避免显示 undefined
  return index >= 0 ? (getMultiSelectLabels(schema)[index] ?? value) : value
}

/**
 * 从单选枚举 Schema 中提取选项值列表。
 *
 * 兼容新旧两种枚举格式：
 * - oneOf 格式：取每个 item 的 const 字段；
 * - enum 格式：直接返回 enum 数组。
 *
 * @param schema 单选枚举 Schema（EnumSchema）
 * @returns 枚举值字符串数组
 */
export function getEnumValues(schema: EnumSchema): string[] {
  if ('oneOf' in schema) {
    // 新格式：oneOf 中每项的 const 为选项值
    return schema.oneOf.map(item => item.const)
  }
  if ('enum' in schema) {
    // 旧格式：直接使用 enum 数组
    return schema.enum
  }
  return []
}

/**
 * 从单选枚举 Schema 中提取选项显示标签列表。
 *
 * - oneOf 格式：取每个 item 的 title 字段；
 * - enum 格式：优先取 enumNames（人类可读名称），否则回退到 enum 值本身。
 *
 * @param schema 单选枚举 Schema（EnumSchema）
 * @returns 枚举标签字符串数组（顺序与 getEnumValues 对应）
 */
export function getEnumLabels(schema: EnumSchema): string[] {
  if ('oneOf' in schema) {
    // 新格式：title 为人类可读标签
    return schema.oneOf.map(item => item.title)
  }
  if ('enum' in schema) {
    // 旧格式：若有 enumNames 则用它，否则用 enum 值作为标签
    return ('enumNames' in schema ? schema.enumNames : undefined) ?? schema.enum
  }
  return []
}

/**
 * 获取单选枚举中特定值对应的显示标签。
 *
 * @param schema 单选枚举 Schema（EnumSchema）
 * @param value  要查找的枚举值
 * @returns 对应的显示标签，若未找到则返回原始值
 */
export function getEnumLabel(schema: EnumSchema, value: string): string {
  const index = getEnumValues(schema).indexOf(value)
  // 未找到时回退到原始值，避免显示 undefined
  return index >= 0 ? (getEnumLabels(schema)[index] ?? value) : value
}

/**
 * 将 MCP PrimitiveSchemaDefinition 转换为对应的 Zod v4 校验 Schema。
 *
 * 【各类型处理逻辑】
 * - 枚举（isEnumSchema）：构建 z.enum([first, ...rest])；若值列表为空则返回 z.never()；
 * - string：按 minLength/maxLength/format 叠加校验约束；
 *   - email → z.string().email()
 *   - uri   → z.string().url()
 *   - date  → z.string().date()
 *   - date-time → z.string().datetime({ offset: true })（允许带时区偏移）
 * - number/integer：使用 z.coerce.number()（自动从字符串转换），
 *   构建一条统一的范围错误消息（rangeMsg），叠加 int()/min()/max() 约束；
 * - boolean：z.coerce.boolean()（支持从字符串 "true"/"false" 转换）；
 * - 其他类型：抛出不支持错误。
 *
 * @param schema MCP 原始 Schema 定义
 * @returns 对应的 Zod v4 Schema 对象
 * @throws 若 schema.type 不在支持列表中则抛出 Error
 */
function getZodSchema(schema: PrimitiveSchemaDefinition): z.ZodTypeAny {
  // 枚举类型：将枚举值列表转为 z.enum 元组
  if (isEnumSchema(schema)) {
    const [first, ...rest] = getEnumValues(schema)
    if (!first) {
      // 空枚举无法构建合法 z.enum，返回 z.never()（永远校验失败）
      return z.never()
    }
    return z.enum([first, ...rest])
  }
  // 字符串类型：从基础 z.string() 开始，按 Schema 约束逐步叠加
  if (schema.type === 'string') {
    let stringSchema = z.string()
    if (schema.minLength !== undefined) {
      stringSchema = stringSchema.min(schema.minLength, {
        message: `Must be at least ${schema.minLength} ${plural(schema.minLength, 'character')}`,
      })
    }
    if (schema.maxLength !== undefined) {
      stringSchema = stringSchema.max(schema.maxLength, {
        message: `Must be at most ${schema.maxLength} ${plural(schema.maxLength, 'character')}`,
      })
    }
    switch (schema.format) {
      case 'email':
        // 电子邮件格式校验，提供 RFC 5321 格式示例
        stringSchema = stringSchema.email({
          message: 'Must be a valid email address, e.g. user@example.com',
        })
        break
      case 'uri':
        // URI 格式校验，提示 https:// 格式
        stringSchema = stringSchema.url({
          message: 'Must be a valid URI, e.g. https://example.com',
        })
        break
      case 'date':
        // ISO 8601 纯日期格式，消息中包含自然语言提示（Haiku 可处理）
        stringSchema = stringSchema.date(
          'Must be a valid date, e.g. 2024-03-15, today, next Monday',
        )
        break
      case 'date-time':
        // ISO 8601 日期时间格式，offset: true 允许带时区偏移（非 UTC-only）
        // 消息中包含自然语言提示（Haiku 可处理）
        stringSchema = stringSchema.datetime({
          offset: true,
          message:
            'Must be a valid date-time, e.g. 2024-03-15T14:30:00Z, tomorrow at 3pm',
        })
        break
      default:
        // 未知格式不添加额外约束，仍可通过基础字符串校验
        break
    }
    return stringSchema
  }
  // 数字/整数类型：使用 coerce 支持从文本框字符串输入转换
  if (schema.type === 'number' || schema.type === 'integer') {
    const typeLabel = schema.type === 'integer' ? 'an integer' : 'a number'
    const isInteger = schema.type === 'integer'
    // 数字格式化辅助：整数的浮点数边界显示为 "3.0" 以区分浮点语义
    const formatNum = (n: number) =>
      Number.isInteger(n) && !isInteger ? `${n}.0` : String(n)

    // 将范围约束合并为一条统一的错误消息，避免多条消息令用户困惑
    const rangeMsg =
      schema.minimum !== undefined && schema.maximum !== undefined
        ? `Must be ${typeLabel} between ${formatNum(schema.minimum)} and ${formatNum(schema.maximum)}`
        : schema.minimum !== undefined
          ? `Must be ${typeLabel} >= ${formatNum(schema.minimum)}`
          : schema.maximum !== undefined
            ? `Must be ${typeLabel} <= ${formatNum(schema.maximum)}`
            : `Must be ${typeLabel}`

    // z.coerce.number() 会将字符串输入自动转为数字，适合表单文本框
    let numberSchema = z.coerce.number({
      error: rangeMsg,
    })
    if (schema.type === 'integer') {
      // 整数类型额外添加 .int() 约束，拒绝浮点数输入
      numberSchema = numberSchema.int({ message: rangeMsg })
    }
    if (schema.minimum !== undefined) {
      numberSchema = numberSchema.min(schema.minimum, {
        message: rangeMsg,
      })
    }
    if (schema.maximum !== undefined) {
      numberSchema = numberSchema.max(schema.maximum, {
        message: rangeMsg,
      })
    }
    return numberSchema
  }
  // 布尔类型：coerce 支持从 "true"/"false" 字符串转换
  if (schema.type === 'boolean') {
    return z.coerce.boolean()
  }

  // 到此说明传入了不支持的 schema.type，抛出明确错误
  throw new Error(`Unsupported schema: ${jsonStringify(schema)}`)
}

/**
 * 同步校验用户输入（立即返回，不调用任何 API）。
 *
 * 流程：
 * 1. 通过 getZodSchema 构建对应的 Zod Schema；
 * 2. 调用 safeParse 进行校验（不抛出异常）；
 * 3. 成功时将 parseResult.data 类型断言为 string | number | boolean 返回；
 * 4. 失败时将所有 issue 的 message 以 "; " 拼接为单条错误消息返回。
 *
 * 注意：对于 date/date-time 格式，此函数只接受严格的 ISO 8601 格式；
 * 自然语言输入需要通过 validateElicitationInputAsync 进行异步解析。
 *
 * @param stringValue 用户输入的原始字符串值
 * @param schema      字段的 MCP Schema 定义
 * @returns           ValidationResult（isValid + value 或 error）
 */
export function validateElicitationInput(
  stringValue: string,
  schema: PrimitiveSchemaDefinition,
): ValidationResult {
  const zodSchema = getZodSchema(schema)
  const parseResult = zodSchema.safeParse(stringValue)

  if (parseResult.success) {
    // Elicitation 的所有基础类型（string/number/boolean）均为原始类型，直接断言
    return {
      value: parseResult.data as string | number | boolean,
      isValid: true,
    }
  }
  // 将所有校验错误的消息拼接为一条用户可读的错误提示
  return {
    isValid: false,
    error: parseResult.error.issues.map(e => e.message).join('; '),
  }
}

/**
 * 类型守卫：判断 Schema 是否为含 format 字段的 StringSchema。
 * 仅在内部用于 getFormatHint 的格式分支判断。
 *
 * @param schema 待检查的 Schema
 * @returns 若为带 format 的 StringSchema 则为 true
 */
const hasStringFormat = (
  schema: PrimitiveSchemaDefinition,
): schema is StringSchema & { format: string } => {
  return (
    schema.type === 'string' &&
    'format' in schema &&
    typeof schema.format === 'string'
  )
}

/**
 * 为指定 Schema 生成输入格式提示字符串，用于表单 UI 占位符或说明文字。
 *
 * 各类型生成逻辑：
 * - string 且无 format：返回 undefined（无需额外提示）；
 * - string 含 format：从 STRING_FORMATS 映射表中取 description/example，
 *   格式为 "description, e.g. example"；
 * - number/integer：根据 minimum/maximum 的存在情况生成范围提示，
 *   如 "(integer between 1 and 100)"、"(number >= 0.0)"；
 * - 其他类型（boolean/enum）：返回 undefined。
 *
 * @param schema 字段的 MCP Schema 定义
 * @returns 格式提示字符串，若无需提示则返回 undefined
 */
export function getFormatHint(
  schema: PrimitiveSchemaDefinition,
): string | undefined {
  if (schema.type === 'string') {
    if (!hasStringFormat(schema)) {
      // 无 format 字段的字符串无需额外格式提示
      return undefined
    }

    const { description, example } = STRING_FORMATS[schema.format] || {}
    return `${description}, e.g. ${example}`
  }

  if (schema.type === 'number' || schema.type === 'integer') {
    const isInteger = schema.type === 'integer'
    // 数字格式化：为浮点范围边界添加 ".0" 后缀，视觉上区分整数和浮点
    const formatNum = (n: number) =>
      Number.isInteger(n) && !isInteger ? `${n}.0` : String(n)

    if (schema.minimum !== undefined && schema.maximum !== undefined) {
      // 两侧都有范围约束
      return `(${schema.type} between ${formatNum(schema.minimum!)} and ${formatNum(schema.maximum!)})`
    } else if (schema.minimum !== undefined) {
      // 仅有下界约束
      return `(${schema.type} >= ${formatNum(schema.minimum!)})`
    } else if (schema.maximum !== undefined) {
      // 仅有上界约束
      return `(${schema.type} <= ${formatNum(schema.maximum!)})`
    } else {
      // 无范围约束，只提示类型和示例值
      const example = schema.type === 'integer' ? '42' : '3.14'
      return `(${schema.type}, e.g. ${example})`
    }
  }

  // boolean、enum 等类型无需格式提示
  return undefined
}

/**
 * 判断 Schema 是否为支持自然语言解析的日期/时间格式 Schema。
 *
 * 条件：
 * 1. type 为 'string'；
 * 2. 存在 format 字段；
 * 3. format 值为 'date' 或 'date-time'。
 *
 * 用途：validateElicitationInputAsync 通过此函数决定是否触发 Haiku 自然语言解析路径。
 *
 * @param schema 待检查的 Schema
 * @returns 若为 date 或 date-time 格式 Schema 则为 true，类型收窄为对应的 StringSchema
 */
export function isDateTimeSchema(
  schema: PrimitiveSchemaDefinition,
): schema is StringSchema & { format: 'date' | 'date-time' } {
  return (
    schema.type === 'string' &&
    'format' in schema &&
    (schema.format === 'date' || schema.format === 'date-time')
  )
}

/**
 * 异步校验，在同步校验失败时尝试通过 Haiku 进行自然语言日期/时间解析。
 *
 * 【完整校验流程】
 * 1. 先调用 validateElicitationInput 进行同步校验；
 * 2. 同步校验通过 → 直接返回成功结果（大多数情况）；
 * 3. 同步校验失败 → 判断是否为 date/date-time 字段且输入非 ISO 8601：
 *    a. 是 → 调用 parseNaturalLanguageDateTime（Haiku 解析）；
 *       - 解析成功 → 对解析后的 ISO 8601 值再次进行同步校验（验证模型输出合法性）；
 *         * 二次校验通过 → 返回成功结果（值为 Haiku 解析后的 ISO 8601 字符串）；
 *         * 二次校验失败 → 说明 Haiku 输出仍不符合 Schema 约束（如 minLength 等），
 *           回退到原始同步错误；
 *       - 解析失败 → 回退到原始同步错误；
 *    b. 否 → 直接返回原始同步错误（不是日期字段或已是 ISO 格式）。
 *
 * 设计意图：对于用户输入 "明天" 等自然语言，先尝试 AI 解析再二次校验，
 * 透明地将自然语言转换为 ISO 8601，用户无需感知底层实现。
 *
 * @param stringValue 用户输入的原始字符串值
 * @param schema      字段的 MCP Schema 定义
 * @param signal      用于取消 Haiku 调用的 AbortSignal
 * @returns           ValidationResult（isValid + value 或 error）
 */
export async function validateElicitationInputAsync(
  stringValue: string,
  schema: PrimitiveSchemaDefinition,
  signal: AbortSignal,
): Promise<ValidationResult> {
  // 先尝试同步校验，大多数有效输入（ISO 格式、枚举、数字等）在此直接通过
  const syncResult = validateElicitationInput(stringValue, schema)
  if (syncResult.isValid) {
    return syncResult
  }

  // 同步失败后，检查是否为 date/date-time 字段且输入不是 ISO 8601 格式
  // 只有这种情况才值得发起 Haiku API 调用尝试自然语言解析
  if (isDateTimeSchema(schema) && !looksLikeISO8601(stringValue)) {
    const parseResult = await parseNaturalLanguageDateTime(
      stringValue,
      schema.format,
      signal,
    )

    if (parseResult.success) {
      // Haiku 解析成功，对其输出再次进行同步校验
      // 确保 Haiku 返回的 ISO 8601 字符串满足 Schema 的其他约束（如 format 精确匹配）
      const validatedParsed = validateElicitationInput(
        parseResult.value,
        schema,
      )
      if (validatedParsed.isValid) {
        // 二次校验通过，返回使用 Haiku 解析结果的成功响应
        return validatedParsed
      }
    }
  }

  // 所有路径均失败，返回最初的同步校验错误（最具可读性）
  return syncResult
}
