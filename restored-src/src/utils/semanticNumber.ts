/**
 * 语义数字预处理器模块
 *
 * 在 Claude Code 系统中的位置：
 * 工具输入验证层 → Zod Schema 定义 → semanticNumber
 *
 * 主要功能：
 * 提供一个 Zod 预处理器，使数字型字段同时接受 JavaScript 原生数字
 * 和形如 "30"、"-5"、"3.14" 的数字字符串字面量。
 *
 * 背景：模型在生成 JSON 工具调用参数时，有时会将数字错误地引号括起来，
 * 例如 `"head_limit":"30"` 而非 `"head_limit":30`。
 * z.coerce.number() 会将 "" / null 等非法值强制转换为 0，掩盖 bug，
 * 因此需要本模块的精确语义化处理。
 */

import { z } from 'zod/v4'

/**
 * 接受数字字符串字面量的数字型 Zod 预处理器
 *
 * 函数流程：
 * 1. 使用 z.preprocess 在核心 schema 校验之前拦截原始值
 * 2. 若值为字符串，且匹配严格的十进制数字正则 /^-?\d+(\.\d+)?$/
 *    → 用 Number() 转换
 * 3. 转换后进一步检查 Number.isFinite，排除 NaN 和 Infinity 等非法值
 * 4. 条件不满足时原值透传，由内层 schema 决定是否报错
 * 5. 内层 schema 默认为 z.number()，也可传入 .optional()/.default()
 *
 * 注意：z.preprocess 向 API 输出的 JSON Schema 仍然是 {"type":"number"}，
 * 因此模型侧感知不到这层字符串容错，对模型完全透明。
 *
 * .optional()/.default() 必须写在内层 schema 上（而非链式追加到返回值），
 * 否则 Zod v4 中 ZodPipe 的输出类型会退化为 unknown。
 *
 * @param inner - 可选的内层 Zod schema，默认为 z.number()
 * @returns 包含字符串兼容的数字型预处理 schema
 *
 * 使用示例：
 *   semanticNumber()                          → number
 *   semanticNumber(z.number().optional())     → number | undefined
 *   semanticNumber(z.number().default(0))     → number
 */
export function semanticNumber<T extends z.ZodType>(
  inner: T = z.number() as unknown as T,
) {
  return z.preprocess((v: unknown) => {
    // 只处理字符串，且必须严格匹配十进制数字格式（支持负号和小数点）
    if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v)) {
      const n = Number(v)
      // 额外的有限性检查，防止极端情况下出现 Infinity 或 NaN
      if (Number.isFinite(n)) return n
    }
    // 非字符串或格式不匹配时，原值透传，交由内层 schema 处理
    return v
  }, inner)
}
