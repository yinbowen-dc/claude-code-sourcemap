/**
 * 文件：tabstops.ts
 *
 * 【在 Claude Code 系统流程中的位置】
 * 本文件位于 Ink 渲染层的文本预处理流水线中。
 * 在 Claude Code 渲染终端输出内容之前，需要将原始文本中的制表符（`\t`）
 * 展开为等量空格，以确保布局引擎（Yoga）能够正确计算字符宽度和列对齐。
 *
 * 【主要功能】
 * `expandTabs`：将文本中的制表符按 POSIX 标准（8 列间隔）展开为空格。
 * 实现灵感来自 Ghostty 的 Tabstops.zig 模块。
 *
 * 【处理策略】
 * 1. 快速路径：不含 `\t` 的字符串直接返回原文，无额外开销
 * 2. 使用 termio Tokenizer 将字符串分为"文本 token"和"ANSI 序列 token"，
 *    ANSI 序列不贡献列宽，文本部分则根据实际显示宽度推进列计数
 * 3. 每遇到 `\t`：计算到下一个制表位的距离（`interval - column % interval`），
 *    替换为对应数量的空格
 * 4. 每遇到 `\n`：列计数重置为 0
 */

// 制表符展开，灵感来自 Ghostty 的 Tabstops.zig
// 使用 8 列间隔（POSIX 默认值，终端如 Ghostty 硬编码此值）

import { stringWidth } from './stringWidth.js'
import { createTokenizer } from './termio/tokenize.js'

// POSIX 标准制表停靠点间隔（终端默认 8 列）
const DEFAULT_TAB_INTERVAL = 8

/**
 * 将字符串中的制表符展开为空格。
 *
 * 【流程】
 * 1. 若字符串不含制表符，直接返回（快速路径）
 * 2. 创建 termio Tokenizer，将输入分割为文本 token 和 ANSI 序列 token
 * 3. 遍历所有 token：
 *    - 'sequence' token（ANSI 转义）：原样输出，不更新列计数
 *    - 'text' token：按 `\t` 和 `\n` 分割，逐段处理：
 *        - `\t` → 插入 (interval - column % interval) 个空格，更新列计数
 *        - `\n` → 输出换行，列计数归零
 *        - 其他文本 → 原样输出，通过 stringWidth 更新列计数
 *
 * @param text     待处理的文本字符串
 * @param interval 制表停靠点间隔（默认 8，与 POSIX 终端一致）
 * @returns        制表符已展开的字符串
 */
export function expandTabs(
  text: string,
  interval = DEFAULT_TAB_INTERVAL,
): string {
  // 快速路径：不含制表符时直接返回，避免无意义的 tokenizer 开销
  if (!text.includes('\t')) {
    return text
  }

  // 创建流式 tokenizer，区分文本内容和 ANSI 转义序列
  const tokenizer = createTokenizer()
  const tokens = tokenizer.feed(text)
  // flush() 处理缓冲区中尚未输出的不完整序列
  tokens.push(...tokenizer.flush())

  let result = ''  // 输出缓冲区
  let column = 0   // 当前所在列（从 0 开始，追踪终端光标列位置）

  for (const token of tokens) {
    if (token.type === 'sequence') {
      // ANSI 转义序列不占用列宽，直接追加到输出，不更新 column
      result += token.value
    } else {
      // 文本 token：按制表符和换行符分段处理
      const parts = token.value.split(/(\t|\n)/)
      for (const part of parts) {
        if (part === '\t') {
          // 计算到下一个制表停靠点需要插入的空格数
          const spaces = interval - (column % interval)
          result += ' '.repeat(spaces)
          column += spaces  // 推进列计数
        } else if (part === '\n') {
          result += part
          column = 0  // 换行后列计数归零
        } else {
          result += part
          // 使用 stringWidth 获取真实显示宽度（正确处理宽字符和 ANSI）
          column += stringWidth(part)
        }
      }
    }
  }

  return result
}
