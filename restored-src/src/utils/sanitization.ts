/**
 * Unicode 净化模块 (sanitization.ts)
 *
 * 在 Claude Code 系统流程中的位置：
 *   外部输入层（MCP 工具结果 / 用户提示词）→ 【本模块：Unicode 安全过滤】→ AI 处理层
 *
 * 主要职责：
 *   1. 抵御 Unicode 隐藏字符攻击（ASCII Smuggling、隐形提示注入）
 *   2. 通过 NFKC 规范化 + 危险 Unicode 类别/范围剥离，清除不可见恶意字符
 *   3. 提供递归版本，支持对嵌套 string/array/object 数据结构的全面净化
 *
 * 安全背景：
 *   攻击者可利用 Unicode Tag 字符（E0000–E007F）、格式控制字符、私有区字符等
 *   向 AI 注入对用户不可见的隐藏指令（Hidden Prompt Injection）。
 *   参考：HackerOne #3086545 / https://embracethered.com/blog/posts/2024/hiding-and-finding-text-with-unicode-tags/
 *
 * 与其他模块的关系：
 *   - 被工具调用结果处理层调用，过滤所有来自外部的文本输入
 *   - 始终启用，不受用户配置控制
 */

/**
 * 对单个字符串执行迭代式 Unicode 净化。
 *
 * 净化策略（每轮迭代均执行）：
 *   1. NFKC 规范化：将合成字符序列（如兼容分解形式）统一展开，
 *      防止攻击者借助未规范化形式绕过正则过滤
 *   2. 主防护（Method 1）：使用 Unicode 属性类正则剥离危险类别
 *      - \p{Cf}：格式字符（零宽连字、方向控制等）
 *      - \p{Co}：私有区字符（PUA）
 *      - \p{Cn}：未分配字符（包括 Tag 字符）
 *   3. 补充防护（Method 2）：针对部分运行时不支持属性类正则的环境，
 *      显式剥除已知危险的具体 Unicode 范围
 *
 * 迭代机制：
 *   - 每轮检测内容是否不再变化（previous === current）则提前退出
 *   - 最多执行 MAX_ITERATIONS = 10 轮，超出则抛出错误（防止无限循环）
 *
 * @param prompt 待净化的字符串
 * @returns 净化后的字符串
 * @throws 若迭代次数达到上限（可能存在 bug 或恶意输入）
 */
export function partiallySanitizeUnicode(prompt: string): string {
  let current = prompt
  let previous = ''
  let iterations = 0
  const MAX_ITERATIONS = 10 // 防无限循环安全上限

  // 迭代净化，直到内容稳定或达到次数上限
  while (current !== previous && iterations < MAX_ITERATIONS) {
    previous = current

    // 步骤 1：NFKC 规范化，防止合成字符序列绕过后续过滤
    current = current.normalize('NFKC')

    // 步骤 2（主防护）：通过 Unicode 属性类剥离格式/私有/未分配字符
    // \p{Cf}=格式字符, \p{Co}=私有区, \p{Cn}=未分配（含 Tag 字符 E0000–E007F）
    current = current.replace(/[\p{Cf}\p{Co}\p{Cn}]/gu, '')

    // 步骤 3（补充防护）：显式剥除具体危险 Unicode 范围，
    // 覆盖不支持属性类正则的运行时环境
    current = current
      .replace(/[\u200B-\u200F]/g, '') // 零宽空格、LTR/RTL 标记
      .replace(/[\u202A-\u202E]/g, '') // 方向嵌入/覆盖控制字符
      .replace(/[\u2066-\u2069]/g, '') // 方向隔离控制字符
      .replace(/[\uFEFF]/g, '')        // BOM（字节序标记）
      .replace(/[\uE000-\uF8FF]/g, '') // 基本多语言平面私有区（BMP PUA）

    iterations++
  }

  // 达到最大迭代次数：抛出错误，此情况通常意味着代码 bug 或恶意深嵌套输入
  if (iterations >= MAX_ITERATIONS) {
    throw new Error(
      `Unicode sanitization reached maximum iterations (${MAX_ITERATIONS}) for input: ${prompt.slice(0, 100)}`,
    )
  }

  return current
}

/**
 * 递归净化任意数据结构中的所有字符串（函数重载版本）。
 *
 * 支持的数据类型：
 *   - string：直接净化
 *   - T[]：递归处理每个元素
 *   - object：递归处理所有键和值（键名也会被净化，防止 key 注入）
 *   - 其他原始值（number、boolean、null、undefined）：原样返回
 *
 * 使用重载确保类型安全：调用方传入什么类型，返回什么类型。
 */
export function recursivelySanitizeUnicode(value: string): string
export function recursivelySanitizeUnicode<T>(value: T[]): T[]
export function recursivelySanitizeUnicode<T extends object>(value: T): T
export function recursivelySanitizeUnicode<T>(value: T): T
export function recursivelySanitizeUnicode(value: unknown): unknown {
  // 字符串：直接净化
  if (typeof value === 'string') {
    return partiallySanitizeUnicode(value)
  }

  // 数组：递归处理每个元素
  if (Array.isArray(value)) {
    return value.map(recursivelySanitizeUnicode)
  }

  // 对象：递归处理所有键和值（键名同样可能携带恶意字符）
  if (value !== null && typeof value === 'object') {
    const sanitized: Record<string, unknown> = {}
    for (const [key, val] of Object.entries(value)) {
      sanitized[recursivelySanitizeUnicode(key)] =
        recursivelySanitizeUnicode(val)
    }
    return sanitized
  }

  // 其他原始类型（number、boolean、null、undefined）：原样返回
  return value
}
