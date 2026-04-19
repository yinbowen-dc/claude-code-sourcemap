/**
 * 语义布尔值预处理器模块
 *
 * 在 Claude Code 系统中的位置：
 * 工具输入验证层 → Zod Schema 定义 → semanticBoolean
 *
 * 主要功能：
 * 提供一个 Zod 预处理器，使布尔型字段同时接受 JavaScript 原生布尔值
 * 和字符串字面量 "true" / "false"。
 *
 * 背景：模型在生成 JSON 工具调用参数时，有时会将布尔值错误地引号括起来，
 * 例如 `"replace_all":"false"` 而非 `"replace_all":false`。
 * 直接使用 z.boolean() 会拒绝此类字符串，z.coerce.boolean() 又会将
 * "false" 视为 truthy（JS 真值），因此需要本模块的语义化处理。
 */

import { z } from 'zod/v4'

/**
 * 接受字符串字面量 "true"/"false" 的布尔型 Zod 预处理器
 *
 * 函数流程：
 * 1. 使用 z.preprocess 在核心 schema 校验之前拦截原始值
 * 2. 若原始值是字符串 "true" → 转换为 true
 * 3. 若原始值是字符串 "false" → 转换为 false
 * 4. 否则不做转换，原值透传给内层 schema
 * 5. 内层 schema 默认为 z.boolean()，也可传入 .optional()/.default()
 *
 * 注意：z.preprocess 向 API 输出的 JSON Schema 仍然是 {"type":"boolean"}，
 * 因此模型侧感知不到这层字符串容错，对模型完全透明。
 *
 * .optional()/.default() 必须写在内层 schema 上（而非链式追加到返回值），
 * 否则 Zod v4 中 ZodPipe 的输出类型会退化为 unknown。
 *
 * @param inner - 可选的内层 Zod schema，默认为 z.boolean()
 * @returns 包含字符串兼容的布尔型预处理 schema
 *
 * 使用示例：
 *   semanticBoolean()                           → boolean
 *   semanticBoolean(z.boolean().optional())     → boolean | undefined
 *   semanticBoolean(z.boolean().default(false)) → boolean
 */
export function semanticBoolean<T extends z.ZodType>(
  inner: T = z.boolean() as unknown as T,
) {
  return z.preprocess(
    // 仅处理字符串类型的 "true"/"false"；其余值（包括原生 boolean）直接透传
    (v: unknown) => (v === 'true' ? true : v === 'false' ? false : v),
    inner,
  )
}
