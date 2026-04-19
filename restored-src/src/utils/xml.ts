/**
 * XML/HTML 特殊字符转义工具。
 *
 * 在 Claude Code 系统流程中的位置：
 * 此模块是内容安全层的底层工具，被系统提示构建、工具输出渲染、
 * 以及任何需要将不可信字符串（进程输出、用户输入、外部数据）
 * 插入 XML/HTML 结构的场景调用。
 *
 * 主要功能：
 * - escapeXml：转义标签内容中的危险字符（& < >）
 * - escapeXmlAttr：在 escapeXml 基础上额外转义引号，用于属性值
 */

/**
 * 转义 XML/HTML 元素文本内容中的特殊字符。
 * 用于将不可信字符串安全地插入标签之间：`<tag>${here}</tag>`。
 *
 * 流程：
 * 1. 将 & 替换为 &amp;（必须最先处理，防止二次转义）
 * 2. 将 < 替换为 &lt;
 * 3. 将 > 替换为 &gt;
 *
 * @param s 需要转义的原始字符串
 * @returns 已转义的 XML 安全字符串
 */
export function escapeXml(s: string): string {
  // 先转义 & 防止后续替换产生的 & 被再次转义
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * 转义用于 XML/HTML 属性值的字符串（双引号或单引号包裹均可）。
 * 用于将不可信字符串插入属性值：`<tag attr="${here}">`。
 *
 * 流程：
 * 1. 调用 escapeXml 处理 & < >
 * 2. 额外将 " 替换为 &quot;
 * 3. 额外将 ' 替换为 &apos;
 *
 * @param s 需要转义的原始字符串
 * @returns 已转义的 XML 属性安全字符串
 */
export function escapeXmlAttr(s: string): string {
  // 先处理基础 XML 字符，再处理属性中的引号
  return escapeXml(s).replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}
