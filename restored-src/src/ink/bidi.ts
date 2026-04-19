/**
 * 双向文本重排序模块（Bidirectional Text Reordering）
 *
 * 【在 Claude Code / Ink 系统中的位置】
 * 本文件处于 Ink 终端渲染管线的"字符输出"阶段：
 *   React 组件树 → 虚拟 DOM → Yoga 布局 → 逐字符渲染 → [本模块：双向文本重排] → 终端输出
 *
 * 【主要功能】
 * 终端（尤其是 Windows 终端）不实现 Unicode 双向算法（Bidi Algorithm），
 * 因此希伯来语、阿拉伯语等从右到左（RTL）的文字会以错误的顺序显示。
 * 本模块在 Ink 的从左到右单元格渲染循环之前，将 ClusteredChar 数组从
 * 逻辑顺序重排为视觉顺序，使 RTL 文字在不支持 Bidi 的终端中正确呈现。
 *
 * 【平台检测策略】
 * - macOS 的 Terminal.app、iTerm2 等终端原生支持 Bidi，无需软件处理。
 * - Windows Terminal（含 WSL）不支持 Bidi（参见 https://github.com/microsoft/terminal/issues/538）。
 * - 检测方式：Windows 平台、WT_SESSION 环境变量（WSL 内的 Windows Terminal）、
 *   TERM_PROGRAM=vscode（VS Code 集成终端，使用 xterm.js）时启用软件 Bidi。
 */
import bidiFactory from 'bidi-js'

// 表示一个"字符簇"——可能包含多个 Unicode 码位（如带组合字符的基字符）
type ClusteredChar = {
  value: string           // 字符簇的字符串内容（可能多于一个码位）
  width: number           // 在终端中占用的列宽（东亚宽字符为 2，普通字符为 1）
  styleId: number         // 样式 ID，用于复用渲染样式
  hyperlink: string | undefined  // 超链接 URL（OSC 8），无则为 undefined
}

// bidi-js 库的单例实例，懒初始化以避免不必要的开销
let bidiInstance: ReturnType<typeof bidiFactory> | undefined
// 缓存当前环境是否需要软件 Bidi 处理，避免重复检测
let needsSoftwareBidi: boolean | undefined

/**
 * 判断当前终端环境是否需要软件 Bidi 重排。
 *
 * 该函数执行一次后将结果缓存到 needsSoftwareBidi，后续调用直接返回缓存值。
 * 触发条件：Windows 平台、WSL 中的 Windows Terminal（WT_SESSION）、
 * 或 VS Code 集成终端（TERM_PROGRAM=vscode）。
 */
function needsBidi(): boolean {
  if (needsSoftwareBidi === undefined) {
    // 满足任一条件则开启软件 Bidi
    needsSoftwareBidi =
      process.platform === 'win32' ||
      typeof process.env['WT_SESSION'] === 'string' || // WSL 内运行的 Windows Terminal
      process.env['TERM_PROGRAM'] === 'vscode' // VS Code 集成终端（xterm.js）
  }
  return needsSoftwareBidi
}

/**
 * 获取 bidi-js 库的单例实例。
 *
 * 懒初始化：仅在首次需要时创建实例，避免在不需要 Bidi 的平台上浪费资源。
 */
function getBidi() {
  if (!bidiInstance) {
    // 首次调用时初始化 bidi-js 工厂
    bidiInstance = bidiFactory()
  }
  return bidiInstance
}

/**
 * 将 ClusteredChar 数组从逻辑顺序重排为视觉顺序（Unicode Bidi Algorithm）。
 *
 * 【整体流程】
 * 1. 检测当前终端是否需要软件 Bidi，如不需要则直接返回原数组。
 * 2. 拼接所有字符为纯文本字符串，检测是否包含 RTL 字符，如无则跳过。
 * 3. 调用 bidi-js 获取每个码位的嵌入级别（embedding levels）。
 * 4. 将嵌入级别映射回 ClusteredChar 粒度（因为一个字符簇可能对应多个码位）。
 * 5. 实现标准 Bidi 重排算法：从最高级别开始逐级反转连续的同级段（runs）。
 *
 * @param characters - 待重排的字符簇数组（逻辑顺序）
 * @returns 视觉顺序的字符簇数组（不支持 Bidi 的终端返回重排后数组，否则返回原数组）
 */
export function reorderBidi(characters: ClusteredChar[]): ClusteredChar[] {
  // 如果不需要软件 Bidi 或数组为空，直接返回原数组（快速路径）
  if (!needsBidi() || characters.length === 0) {
    return characters
  }

  // 将所有字符簇拼接为纯文本字符串，供 bidi-js 分析
  const plainText = characters.map(c => c.value).join('')

  // 快速检测是否含有 RTL 字符，若全为 LTR 则跳过 Bidi 处理（性能优化）
  if (!hasRTLCharacters(plainText)) {
    return characters
  }

  // 获取 bidi-js 实例并计算每个码位的嵌入级别
  const bidi = getBidi()
  const { levels } = bidi.getEmbeddingLevels(plainText, 'auto')

  // 将码位级别的嵌入级别映射回 ClusteredChar 级别。
  // 每个 ClusteredChar 的 value 可能对应多个码位（如带组合字符的基字符），
  // 因此用 offset 追踪当前在 plainText 中的位置。
  const charLevels: number[] = []
  let offset = 0
  for (let i = 0; i < characters.length; i++) {
    // 取字符簇在 plainText 中起始位置的嵌入级别作为该字符簇的级别
    charLevels.push(levels[offset]!)
    // 推进偏移量（按字符簇的 UTF-16 码元长度，不是字素数量）
    offset += characters[i]!.value.length
  }

  // 实现标准 Unicode Bidi 重排算法：
  // 从最高嵌入级别开始，逐级向下，对每个连续的"同级或更高级"的段（run）进行就地反转。
  // 奇数级别 = RTL，偶数级别 = LTR；每次反转会将 RTL 段翻转为视觉顺序。
  const reordered = [...characters]
  const maxLevel = Math.max(...charLevels)

  for (let level = maxLevel; level >= 1; level--) {
    let i = 0
    while (i < reordered.length) {
      if (charLevels[i]! >= level) {
        // 找到当前连续段（run）的结束位置
        let j = i + 1
        while (j < reordered.length && charLevels[j]! >= level) {
          j++
        }
        // 同步反转字符簇数组和嵌入级别数组，保持两者对应关系
        reverseRange(reordered, i, j - 1)
        reverseRangeNumbers(charLevels, i, j - 1)
        i = j
      } else {
        i++
      }
    }
  }

  return reordered
}

/**
 * 就地反转泛型数组的指定范围 [start, end]（双指针交换）。
 *
 * @param arr - 目标数组
 * @param start - 反转起始下标（含）
 * @param end - 反转结束下标（含）
 */
function reverseRange<T>(arr: T[], start: number, end: number): void {
  while (start < end) {
    const temp = arr[start]!
    arr[start] = arr[end]!  // 将末尾元素移到起始位置
    arr[end] = temp          // 将起始元素移到末尾位置
    start++
    end--
  }
}

/**
 * 就地反转数字数组的指定范围 [start, end]（双指针交换）。
 * 与 reverseRange 逻辑相同，专门用于 charLevels 数组，避免泛型装箱开销。
 *
 * @param arr - 目标数字数组
 * @param start - 反转起始下标（含）
 * @param end - 反转结束下标（含）
 */
function reverseRangeNumbers(arr: number[], start: number, end: number): void {
  while (start < end) {
    const temp = arr[start]!
    arr[start] = arr[end]!
    arr[end] = temp
    start++
    end--
  }
}

/**
 * 快速检测字符串中是否包含 RTL 字符（希伯来语、阿拉伯语等）。
 *
 * 【作用】
 * 在纯 LTR 文本（全英文、数字等）上跳过完整的 Bidi 算法调用，提升性能。
 * 覆盖的 Unicode 区段：
 * - 希伯来语：U+0590–U+05FF、U+FB1D–U+FB4F
 * - 阿拉伯语：U+0600–U+06FF、U+0750–U+077F、U+08A0–U+08FF、U+FB50–U+FDFF、U+FE70–U+FEFF
 * - Thaana（马尔代夫文）：U+0780–U+07BF
 * - 叙利亚文：U+0700–U+074F
 *
 * @param text - 待检测的纯文本字符串
 * @returns 包含 RTL 字符返回 true，否则返回 false
 */
function hasRTLCharacters(text: string): boolean {
  // Hebrew: U+0590-U+05FF, U+FB1D-U+FB4F
  // Arabic: U+0600-U+06FF, U+0750-U+077F, U+08A0-U+08FF, U+FB50-U+FDFF, U+FE70-U+FEFF
  // Thaana: U+0780-U+07BF
  // Syriac: U+0700-U+074F
  return /[\u0590-\u05FF\uFB1D-\uFB4F\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF\u0780-\u07BF\u0700-\u074F]/u.test(
    text,
  )
}
