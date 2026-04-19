/**
 * 内容数组插入工具模块。
 *
 * 在 Claude Code 系统中，该模块提供将内容块插入 API 消息内容数组的工具函数，
 * 用于在 tool_result 块之后正确定位辅助内容（如缓存编辑指令）：
 * - 若存在 tool_result 块：在最后一个之后插入
 * - 否则：在最后一个块之前插入
 * - 若插入后该块位于末尾，则追加文本续接块（部分 API 要求 prompt 不以非文本内容结尾）
 */

/**
 * 将内容块插入到内容数组中最后一个 tool_result 块之后。
 * 直接修改传入的数组（in-place mutate）。
 *
 * 插入规则：
 * 1. 存在 tool_result 块 → 插入到最后一个之后（insertPos = lastIndex + 1）
 *    - 若插入后该块位于末尾，则追加 `{ type: 'text', text: '.' }` 续接块，
 *      因为部分 API 要求 user turn 不能以非文本内容结尾
 * 2. 不存在 tool_result 块 → 插入到最后一个块之前（insertIndex = length - 1）
 *
 * @param content - 要修改的内容数组
 * @param block - 要插入的内容块
 */
export function insertBlockAfterToolResults(
  content: unknown[],
  block: unknown,
): void {
  // 找到最后一个 tool_result 块的索引，遍历全部以确保取最后一个
  let lastToolResultIndex = -1
  for (let i = 0; i < content.length; i++) {
    const item = content[i]
    if (
      item &&
      typeof item === 'object' &&
      'type' in item &&
      (item as { type: string }).type === 'tool_result'
    ) {
      lastToolResultIndex = i
    }
  }

  if (lastToolResultIndex >= 0) {
    // 在最后一个 tool_result 之后插入
    const insertPos = lastToolResultIndex + 1
    content.splice(insertPos, 0, block)
    // 插入后若该块已位于末尾，追加文本续接块（API 兼容性要求）
    if (insertPos === content.length - 1) {
      content.push({ type: 'text', text: '.' })
    }
  } else {
    // 无 tool_result 块 → 插入到最后一个块之前（保证末尾元素不被替换）
    const insertIndex = Math.max(0, content.length - 1)
    content.splice(insertIndex, 0, block)
  }
}
