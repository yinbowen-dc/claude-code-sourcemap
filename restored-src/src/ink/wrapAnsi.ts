/**
 * 文件：wrapAnsi.ts
 *
 * 【在 Claude Code 系统流程中的位置】
 * 本文件是 Ink 层的 ANSI 文本折行适配器，提供统一的 `wrapAnsi` 函数接口。
 * wrap-text.ts 通过此模块进行文本折行，无需关心底层实现来自 Bun 还是 npm 包。
 *
 * 【主要功能】
 * - 优先使用 Bun 内置的 `Bun.wrapAnsi`（若运行在 Bun 环境且该函数存在）
 *   Bun 内置版本有性能优势且无需额外依赖
 * - 回退到 npm 包 `wrap-ansi`（在 Node.js 或不支持 Bun.wrapAnsi 的环境中）
 * - 导出统一的 `wrapAnsi` 函数，调用方无感知底层差异
 */

import wrapAnsiNpm from 'wrap-ansi'

/** wrapAnsi 函数的选项类型 */
type WrapAnsiOptions = {
  hard?: boolean    // true=硬折行（超宽强制断行），false=软折行（在单词边界折行）
  wordWrap?: boolean // 是否按单词边界折行
  trim?: boolean    // true=去除折行后各行的首尾空格
}

/**
 * 尝试使用 Bun 内置的 wrapAnsi 函数。
 *
 * 在 Bun 运行时环境中，`Bun.wrapAnsi` 为内置高性能实现；
 * 若 `Bun` 全局对象不存在或 `Bun.wrapAnsi` 不是函数，则置为 null，
 * 以便下方的回退逻辑选择 npm 包。
 */
const wrapAnsiBun =
  typeof Bun !== 'undefined' && typeof Bun.wrapAnsi === 'function'
    ? Bun.wrapAnsi
    : null

/**
 * 统一的 ANSI 文本折行函数。
 *
 * 优先级：Bun.wrapAnsi（若可用）> wrap-ansi npm 包
 *
 * 使用空值合并运算符（??）实现回退：
 * - wrapAnsiBun 非 null：使用 Bun 内置实现
 * - wrapAnsiBun 为 null：使用 npm 包 wrap-ansi
 *
 * 两者接口兼容，均接受 (input, columns, options?) 参数。
 */
const wrapAnsi: (
  input: string,
  columns: number,
  options?: WrapAnsiOptions,
) => string = wrapAnsiBun ?? wrapAnsiNpm

export { wrapAnsi }
