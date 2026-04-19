/**
 * renderPlaceholder.ts
 *
 * 【在系统流程中的位置】
 * 本文件属于 Claude Code 的「输入框渲染」子系统。
 * 当用户尚未在提示输入框中输入任何内容时，需要显示一段提示文本（placeholder）
 * 和可选的光标效果（inverse 反色块）。本文件封装了这套占位文本的渲染逻辑，
 * 供 PromptInput 组件调用。
 *
 * 支持场景：
 * - 普通占位文本：灰色（chalk.dim）提示文字，首字符高亮反色表示光标位置；
 * - 语音录制模式（hidePlaceholderText=true）：只显示光标块，不显示文字；
 * - 失焦状态：不显示光标，只显示灰色提示文字或空白。
 */

import chalk from 'chalk'

/** renderPlaceholder 函数的输入参数类型 */
type PlaceholderRendererProps = {
  placeholder?: string          // 占位提示文本内容
  value: string                 // 输入框当前值（用于判断是否显示占位文本）
  showCursor?: boolean          // 是否显示光标
  focus?: boolean               // 输入框是否获得焦点
  terminalFocus: boolean        // 终端窗口是否获得焦点
  invert?: (text: string) => string  // 反色渲染函数，默认为 chalk.inverse
  hidePlaceholderText?: boolean  // 是否隐藏占位文字（仅显示光标，语音录制用）
}

/**
 * 根据输入状态渲染占位文本和光标效果。
 *
 * 渲染规则：
 * 1. 无 placeholder 属性 → renderedPlaceholder 为 undefined，不显示；
 * 2. hidePlaceholderText = true（语音录制模式）：
 *    - 聚焦时：仅显示反色空格（光标块）；
 *    - 失焦时：显示空字符串；
 * 3. 普通模式：
 *    - 占位文本始终以 chalk.dim（灰色）显示；
 *    - 聚焦 + 终端聚焦 + showCursor 时：首字符反色高亮（模拟光标）；
 * 4. showPlaceholder 仅在输入框为空且有 placeholder 时为 true。
 *
 * @returns { renderedPlaceholder, showPlaceholder }
 *   renderedPlaceholder: 最终要渲染的字符串（含 ANSI 颜色码），undefined 表示不渲染
 *   showPlaceholder:     是否应该渲染占位区域
 */
export function renderPlaceholder({
  placeholder,
  value,
  showCursor,
  focus,
  terminalFocus = true,
  invert = chalk.inverse,  // 默认使用 chalk 的反色函数
  hidePlaceholderText = false,
}: PlaceholderRendererProps): {
  renderedPlaceholder: string | undefined
  showPlaceholder: boolean
} {
  // 初始化为 undefined（无 placeholder 时保持此值）
  let renderedPlaceholder: string | undefined = undefined

  if (placeholder) {
    if (hidePlaceholderText) {
      // ── 语音录制模式：只显示光标块，不显示文字 ────────────────────────
      // 仅在输入框聚焦且终端聚焦时显示反色光标，否则显示空字符串
      renderedPlaceholder =
        showCursor && focus && terminalFocus ? invert(' ') : ''
    } else {
      // ── 普通模式：灰色占位文字 + 可选光标高亮 ─────────────────────────
      // 基础样式：灰色占位文本
      renderedPlaceholder = chalk.dim(placeholder)

      // 当输入框和终端都聚焦时，显示反色首字符模拟光标
      if (showCursor && focus && terminalFocus) {
        renderedPlaceholder =
          placeholder.length > 0
            // 首字符反色 + 其余字符灰色
            ? invert(placeholder[0]!) + chalk.dim(placeholder.slice(1))
            // placeholder 为空字符串时，显示一个反色空格作为光标
            : invert(' ')
      }
    }
  }

  // 仅当输入框为空且存在 placeholder 时才应该显示占位区域
  const showPlaceholder = value.length === 0 && Boolean(placeholder)

  return {
    renderedPlaceholder,
    showPlaceholder,
  }
}
