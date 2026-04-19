/**
 * jsonRead.ts — JSON 文件读取叶子模块（BOM 剥离）
 *
 * 【在 Claude Code 系统流程中的位置】
 * 本文件是 JSON 解析管道中的最底层"叶子"工具模块，专门解决一个具体问题：
 * 打破 settings → json → log → types/logs → settings 的循环依赖。
 *
 * 背景：
 *   json.ts 需要 log.ts 来记录解析错误（logError），
 *   而 log.ts 需要 types/logs.ts 的类型，
 *   types/logs.ts 又依赖 settings.ts，
 *   settings.ts 又需要 json.ts ——形成循环依赖。
 *
 *   解决方案：将 stripBOM 提取到本文件，作为最小依赖的叶子模块。
 *   无法导入 json.ts 的调用方（如 syncCacheState）可以直接导入 stripBOM，
 *   并内联使用 JSON.parse，彻底绕开循环依赖。
 *
 * UTF-8 BOM 说明：
 *   BOM（U+FEFF，字节序列 EF BB BF）是 UTF-8 编码的可选前缀。
 *   Windows PowerShell 5.x 的 Out-File、Set-Content 等命令默认写入
 *   带 BOM 的 UTF-8 文件，我们无法控制用户环境，因此必须在读取时剥离。
 *   若不剥离，JSON.parse 会报错："Unexpected token \uFEFF"。
 */

// UTF-8 字节序标记（BOM）的 Unicode 字符
const UTF8_BOM = '\uFEFF'

/**
 * 剥离字符串开头的 UTF-8 BOM 字节序标记（若存在）。
 *
 * 纯文本操作，无副作用，无外部依赖，可安全用于任何模块。
 *
 * @param content - 可能含 BOM 的字符串
 * @returns 不含 BOM 的字符串（若无 BOM 则原样返回）
 */
export function stripBOM(content: string): string {
  // startsWith 比正则更快，且仅在确有 BOM 时才创建新字符串（避免不必要的内存分配）
  return content.startsWith(UTF8_BOM) ? content.slice(1) : content
}
