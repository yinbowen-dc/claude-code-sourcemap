/**
 * symbolContext.ts — LSPTool 工具调用消息的符号上下文提取
 *
 * 【在 Claude Code 系统中的位置】
 * 本文件为 LSPTool 的 renderToolUseMessage（同步 React 渲染函数）提供辅助功能，
 * 用于在工具调用消息中显示"当前操作的目标符号"而非仅显示坐标，提升可读性。
 * 由于 renderToolUseMessage 是同步函数，本文件使用同步文件 I/O 读取文件内容。
 *
 * 【主要功能】
 * - MAX_READ_BYTES = 64 * 1024（64KB 读取上限，覆盖约 1000 行典型代码）
 * - getSymbolAtPosition()：
 *   1. 同步读取文件前 64KB 内容
 *   2. 按行分割后定位目标行
 *   3. 使用正则表达式提取光标位置处的符号/单词
 *   4. 截断到 30 字符后返回
 *   5. 任何错误（文件不存在、权限、编码等）均静默降级返回 null
 */

import { logForDebugging } from '../../utils/debug.js'
import { truncate } from '../../utils/format.js'
import { getFsImplementation } from '../../utils/fsOperations.js'
import { expandPath } from '../../utils/path.js'

/** 同步读取文件时的最大字节数：64KB，覆盖约 1000 行典型代码 */
const MAX_READ_BYTES = 64 * 1024

/**
 * 提取文件中指定位置处的符号/单词。
 * 用于在工具调用消息中显示上下文（如 "goToDefinition: myFunction"）。
 *
 * 设计约束：
 * - 本函数从 renderToolUseMessage（同步 React 渲染函数）调用，因此必须使用同步 I/O
 * - 使用 eslint 禁用注释豁免 custom-rules/no-sync-fs 规则
 * - 任何错误均降级返回 null，不影响工具调用消息的正常渲染
 *
 * 符号提取规则：
 * - 标准标识符：字母数字 + 下划线 + 美元符号
 * - Rust 生命周期：'a, 'static
 * - Rust 宏：macro_name!
 * - 运算符和特殊符号：+, -, *, / 等
 * - 模式匹配区间包含性：character >= start && character < end
 * - 结果截断至 30 字符（避免过长符号）
 *
 * @param filePath - 目标文件路径（绝对或相对）
 * @param line - 0-indexed 行号（来自 LSP 协议，已完成 1→0 转换）
 * @param character - 0-indexed 字符位置（来自 LSP 协议）
 * @returns 找到的符号字符串（最多 30 字符），或 null（提取失败时降级）
 */
export function getSymbolAtPosition(
  filePath: string,
  line: number,
  character: number,
): string | null {
  try {
    const fs = getFsImplementation()
    const absolutePath = expandPath(filePath)

    // 只读取文件前 64KB，而非整个文件。
    // 大多数 LSP hover/goto 目标在最近编辑附近，64KB 可覆盖约 1000 行典型代码。
    // 如果目标行超出该窗口，返回 null，UI 会降级显示 "position: line:char"。
    // eslint-disable-next-line custom-rules/no-sync-fs -- 从同步 React 渲染（renderToolUseMessage）调用
    const { buffer, bytesRead } = fs.readSync(absolutePath, {
      length: MAX_READ_BYTES,
    })
    const content = buffer.toString('utf-8', 0, bytesRead)
    const lines = content.split('\n')

    // 行号越界检查
    if (line < 0 || line >= lines.length) {
      return null
    }
    // 如果读满了缓冲区，文件还有后续内容，最后一个分割元素可能被截断（行内容不完整）
    if (bytesRead === MAX_READ_BYTES && line === lines.length - 1) {
      return null
    }

    const lineContent = lines[line]
    // 行内容为空或字符位置越界时返回 null
    if (!lineContent || character < 0 || character >= lineContent.length) {
      return null
    }

    // 提取光标位置处的符号/单词
    // 正则模式匹配范围：
    // - [\w$'!]+：标准标识符（字母数字下划线美元符号）、Rust 生命周期（'a）、Rust 宏（!）
    // - [+\-*/%&|^~<>=]+：运算符和特殊符号
    // 比标准 \w+ 更宽泛，支持多种编程语言的符号命名规范
    const symbolPattern = /[\w$'!]+|[+\-*/%&|^~<>=]+/g
    let match: RegExpExecArray | null

    while ((match = symbolPattern.exec(lineContent)) !== null) {
      const start = match.index
      const end = start + match[0].length

      // 检查字符位置是否落在当前匹配区间内（左闭右开）
      if (character >= start && character < end) {
        const symbol = match[0]
        // 截断到 30 字符，避免过长符号影响 UI 显示
        return truncate(symbol, 30)
      }
    }

    return null
  } catch (error) {
    // 记录意外错误用于调试（权限问题、编码问题等）
    // 使用 logForDebugging 而非 logError，因为本功能仅用于显示增强，非关键路径
    if (error instanceof Error) {
      logForDebugging(
        `Symbol extraction failed for ${filePath}:${line}:${character}: ${error.message}`,
        { level: 'warn' },
      )
    }
    // 降级返回 null，UI 会显示 "position: line:char"
    return null
  }
}
