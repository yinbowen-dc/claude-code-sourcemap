/**
 * 显示标签处理模块（displayTags.ts）
 *
 * 【在系统流程中的位置】
 * 该模块位于 UI 展示层，被会话标题生成逻辑（/rewind、/resume、bridge 会话）
 * 和用户输入重提交（UP 箭头）等功能调用，负责从用户可见的文本中
 * 剥离系统注入的 XML 标签块，确保 UI 只展示有意义的用户内容。
 *
 * 【主要功能】
 * - stripDisplayTags()：移除所有小写 XML 标签块（内容为空时保留原文）
 * - stripDisplayTagsAllowEmpty()：移除所有小写 XML 标签块（允许返回空字符串）
 * - stripIdeContextTags()：仅移除 IDE 注入的上下文标签（ide_opened_file / ide_selection）
 *
 * 【设计原则】
 * 仅匹配小写标签名，避免误删用户 prose 中提及的 JSX/HTML 组件（如 <Button>）。
 * 系统注入的标签（IDE 元数据、hook 输出、任务通知等）使用小写命名约定。
 */

/**
 * 匹配完整 XML 标签块的正则表达式：
 * - 标签名：小写字母开头，可含字母/数字/连字符/下划线
 * - 属性：可选，不含 `>`
 * - 内容：多行匹配（[\s\S]*?）
 * - 结尾：闭合标签 + 可选换行符
 * 使用 g 标志进行全局替换。
 */
const XML_TAG_BLOCK_PATTERN = /<([a-z][\w-]*)(?:\s[^>]*)?>[\s\S]*?<\/\1>\n?/g

/**
 * 从文本中剥离 XML 风格标签块，用于生成 UI 标题。
 *
 * 【使用场景】
 * /rewind、/resume 命令和 bridge 会话标题生成时调用，
 * 防止系统注入的 IDE 元数据、hook 输出、任务通知等
 * 以原始标签形式出现在标题中。
 *
 * 【安全策略】
 * 若剥离后结果为空字符串（即输入全为标签），返回原始文本，
 * 确保 UI 中始终有内容可展示（显示有内容胜于显示空白）。
 *
 * @param text  原始文本（可能含有系统注入的 XML 标签块）
 * @returns     剥离标签后的文本；若结果为空则返回原始文本
 */
export function stripDisplayTags(text: string): string {
  // 替换所有匹配的 XML 标签块并去除首尾空白
  const result = text.replace(XML_TAG_BLOCK_PATTERN, '').trim()
  // 剥离后为空时返回原文，避免标题变为空字符串
  return result || text
}

/**
 * 从文本中剥离 XML 风格标签块，允许返回空字符串。
 *
 * 【与 stripDisplayTags 的区别】
 * 当全部内容都是系统标签时，返回空字符串而非原文。
 * 供调用方检测"纯命令输入"（如 /clear）并跳过该消息，
 * 转而使用下一个标题回退策略。
 *
 * 【使用场景】
 * - getLogDisplayTitle()：检测纯命令提示，以便回退到后续标题逻辑
 * - extractTitleText()：bridge 标题推导时跳过纯 XML 消息
 *
 * @param text  原始文本
 * @returns     剥离标签后的文本（可能为空字符串）
 */
export function stripDisplayTagsAllowEmpty(text: string): string {
  // 与 stripDisplayTags 相同的替换逻辑，但不做空字符串回退
  return text.replace(XML_TAG_BLOCK_PATTERN, '').trim()
}

/**
 * 仅匹配 IDE 注入的上下文标签（ide_opened_file 和 ide_selection）的正则表达式。
 * 比 XML_TAG_BLOCK_PATTERN 更精确，只针对这两个特定标签，
 * 保留用户手动输入的其他 HTML/XML 内容。
 */
const IDE_CONTEXT_TAGS_PATTERN =
  /<(ide_opened_file|ide_selection)(?:\s[^>]*)?>[\s\S]*?<\/\1>\n?/g

/**
 * 仅剥离 IDE 注入的上下文标签（ide_opened_file、ide_selection）。
 *
 * 【使用场景】
 * textForResubmit() 中使用，当用户按 UP 键重提交时，
 * 需要去掉 IDE 自动注入的上下文（打开的文件、选中的代码段），
 * 同时完整保留用户手动输入的内容，
 * 包括用户在 prose 中写的小写 HTML（如 `<code>foo</code>`）。
 *
 * @param text  原始文本（可能含有 IDE 注入的上下文标签）
 * @returns     去除 IDE 标签后的文本
 */
export function stripIdeContextTags(text: string): string {
  // 仅替换 ide_opened_file 和 ide_selection 这两种标签，其余内容不受影响
  return text.replace(IDE_CONTEXT_TAGS_PATTERN, '').trim()
}
