/**
 * ThemedText.tsx — 主题感知文本组件
 *
 * 在 Claude Code 系统流程中的位置：
 *   设计系统（design-system）层 → UI 基础原语 → 文本渲染
 *
 * 主要功能：
 *   1. 对 Ink 框架的 Text 组件进行封装，支持以主题键（keyof Theme）或原始颜色值
 *      作为 color / backgroundColor，自动解析为实际颜色码。
 *   2. 导出 TextHoverColorContext：跨越 Box 边界的悬停颜色上下文。
 *      Ink 的样式层叠不穿透 Box，通过 Context 可以将悬停色传递给子树中的
 *      ThemedText，优先级：显式 color > 悬停色 > dimColor。
 *   3. dimColor 模式使用主题的 inactive 色（而非 ANSI dim 指令），
 *      兼容 bold 加粗显示。
 *   4. 利用 React Compiler 记忆化缓存（_c(10)）避免不必要的重新渲染。
 *
 * 使用场景：
 *   整个 Claude Code 终端 UI 中所有需要跟随主题切换颜色的文本内容，
 *   替代直接使用 Ink 的 Text 组件。
 */
import { c as _c } from "react/compiler-runtime";
import type { ReactNode } from 'react';
import React, { useContext } from 'react';
import Text from '../../ink/components/Text.js';
import type { Color, Styles } from '../../ink/styles.js';
import { getTheme, type Theme } from '../../utils/theme.js';
import { useTheme } from './ThemeProvider.js';

/** 跨 Box 边界的悬停颜色上下文。
 * 为子树中没有显式 color 的 ThemedText 着色。
 * 优先级：显式 color > 此上下文 > dimColor。
 * 之所以用 Context 而非 Ink 样式层叠，是因为 Ink 的样式不穿透 Box 边界。*/
export const TextHoverColorContext = React.createContext<keyof Theme | undefined>(undefined);
export type Props = {
  /**
   * Change text color. Accepts a theme key or raw color value.
   */
  readonly color?: keyof Theme | Color;

  /**
   * Same as `color`, but for background. Must be a theme key.
   */
  readonly backgroundColor?: keyof Theme;

  /**
   * Dim the color using the theme's inactive color.
   * This is compatible with bold (unlike ANSI dim).
   */
  readonly dimColor?: boolean;

  /**
   * Make the text bold.
   */
  readonly bold?: boolean;

  /**
   * Make the text italic.
   */
  readonly italic?: boolean;

  /**
   * Make the text underlined.
   */
  readonly underline?: boolean;

  /**
   * Make the text crossed with a line.
   */
  readonly strikethrough?: boolean;

  /**
   * Inverse background and foreground colors.
   */
  readonly inverse?: boolean;

  /**
   * This property tells Ink to wrap or truncate text if its width is larger than container.
   * If `wrap` is passed (by default), Ink will wrap text and split it into multiple lines.
   * If `truncate-*` is passed, Ink will truncate text instead, which will result in one line of text with the rest cut off.
   */
  readonly wrap?: Styles['textWrap'];
  readonly children?: ReactNode;
};

/**
 * resolveColor — 将颜色值（主题键或原始颜色）解析为实际颜色码
 *
 * 整体流程：
 *   1. 若 color 为空则返回 undefined
 *   2. 若 color 以 rgb(/# /ansi256(/ansi: 开头，视为原始颜色直接返回
 *   3. 否则视为主题键，从 theme 对象查找并返回实际颜色值
 *
 * 在文件中的作用：供 ThemedText 组件统一解析颜色 props。
 */
function resolveColor(color: keyof Theme | Color | undefined, theme: Theme): Color | undefined {
  // 空值快速返回
  if (!color) return undefined;
  // 判断是否为原始颜色格式（rgb(、#、ansi256(、ansi:）
  if (color.startsWith('rgb(') || color.startsWith('#') || color.startsWith('ansi256(') || color.startsWith('ansi:')) {
    // 原始颜色直接返回，无需主题查找
    return color as Color;
  }
  // 主题键：从当前主题对象取出实际颜色码
  return theme[color as keyof Theme] as Color;
}

/**
 * ThemedText — 主题感知的 Ink Text 包装组件
 *
 * 整体流程：
 *   1. 解构所有 props，对布尔 props 提供默认值（false），wrap 默认 'wrap'
 *   2. 通过 useTheme() 获取当前主题名称，getTheme() 取出主题配色对象
 *   3. 通过 useContext(TextHoverColorContext) 获取悬停色（由祖先注入）
 *   4. 按优先级计算 resolvedColor：
 *      - 若无显式 color 且有悬停色 → 用悬停色
 *      - 否则若 dimColor=true → 用 theme.inactive
 *      - 否则用 resolveColor(color, theme)（可能是主题键或原始颜色）
 *   5. resolvedBackgroundColor：直接从 theme 查 backgroundColor 键
 *   6. React Compiler 记忆化（$[0]~$[9]）：任一输出 prop 变化时重建 JSX，否则复用
 *
 * 在系统中的作用：
 *   Claude Code 终端 UI 中所有需主题感知的文本节点，
 *   同时充当悬停色层叠的接收端。
 */
export default function ThemedText(t0) {
  // 初始化大小为 10 的 React 编译器记忆缓存槽数组
  const $ = _c(10);
  const {
    color,
    backgroundColor,
    dimColor: t1,   // dimColor 默认 false
    bold: t2,       // bold 默认 false
    italic: t3,     // italic 默认 false
    underline: t4,  // underline 默认 false
    strikethrough: t5, // strikethrough 默认 false
    inverse: t6,    // inverse 默认 false
    wrap: t7,       // wrap 默认 'wrap'
    children
  } = t0;
  // 为各布尔 prop 应用默认值（编译器将默认参数展开为三元表达式）
  const dimColor = t1 === undefined ? false : t1;
  const bold = t2 === undefined ? false : t2;
  const italic = t3 === undefined ? false : t3;
  const underline = t4 === undefined ? false : t4;
  const strikethrough = t5 === undefined ? false : t5;
  const inverse = t6 === undefined ? false : t6;
  const wrap = t7 === undefined ? "wrap" : t7;
  // 获取当前主题名称及对应配色对象
  const [themeName] = useTheme();
  const theme = getTheme(themeName);
  // 读取祖先注入的悬停颜色（跨 Box 边界传递）
  const hoverColor = useContext(TextHoverColorContext);
  // 按优先级解析最终前景色：悬停色 > dimColor（inactive） > 显式 color
  const resolvedColor = !color && hoverColor ? resolveColor(hoverColor, theme) : dimColor ? theme.inactive as Color : resolveColor(color, theme);
  // 解析背景色（只接受主题键，直接查主题对象）
  const resolvedBackgroundColor = backgroundColor ? theme[backgroundColor] as Color : undefined;
  let t8;
  // 记忆化：仅当任一 prop 发生变化时重新创建 JSX
  if ($[0] !== bold || $[1] !== children || $[2] !== inverse || $[3] !== italic || $[4] !== resolvedBackgroundColor || $[5] !== resolvedColor || $[6] !== strikethrough || $[7] !== underline || $[8] !== wrap) {
    // 将解析后的颜色和样式 props 传给 Ink Text 组件
    t8 = <Text color={resolvedColor} backgroundColor={resolvedBackgroundColor} bold={bold} italic={italic} underline={underline} strikethrough={strikethrough} inverse={inverse} wrap={wrap}>{children}</Text>;
    $[0] = bold;
    $[1] = children;
    $[2] = inverse;
    $[3] = italic;
    $[4] = resolvedBackgroundColor;
    $[5] = resolvedColor;
    $[6] = strikethrough;
    $[7] = underline;
    $[8] = wrap;
    $[9] = t8;
  } else {
    // 缓存命中：复用上次渲染结果
    t8 = $[9];
  }
  return t8;
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJSZWFjdE5vZGUiLCJSZWFjdCIsInVzZUNvbnRleHQiLCJUZXh0IiwiQ29sb3IiLCJTdHlsZXMiLCJnZXRUaGVtZSIsIlRoZW1lIiwidXNlVGhlbWUiLCJUZXh0SG92ZXJDb2xvckNvbnRleHQiLCJjcmVhdGVDb250ZXh0IiwidW5kZWZpbmVkIiwiUHJvcHMiLCJjb2xvciIsImJhY2tncm91bmRDb2xvciIsImRpbUNvbG9yIiwiYm9sZCIsIml0YWxpYyIsInVuZGVybGluZSIsInN0cmlrZXRocm91Z2giLCJpbnZlcnNlIiwid3JhcCIsImNoaWxkcmVuIiwicmVzb2x2ZUNvbG9yIiwidGhlbWUiLCJzdGFydHNXaXRoIiwiVGhlbWVkVGV4dCIsInQwIiwiJCIsIl9jIiwidDEiLCJ0MiIsInQzIiwidDQiLCJ0NSIsInQ2IiwidDciLCJ0aGVtZU5hbWUiLCJob3ZlckNvbG9yIiwicmVzb2x2ZWRDb2xvciIsImluYWN0aXZlIiwicmVzb2x2ZWRCYWNrZ3JvdW5kQ29sb3IiLCJ0OCJdLCJzb3VyY2VzIjpbIlRoZW1lZFRleHQudHN4Il0sInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB0eXBlIHsgUmVhY3ROb2RlIH0gZnJvbSAncmVhY3QnXG5pbXBvcnQgUmVhY3QsIHsgdXNlQ29udGV4dCB9IGZyb20gJ3JlYWN0J1xuaW1wb3J0IFRleHQgZnJvbSAnLi4vLi4vaW5rL2NvbXBvbmVudHMvVGV4dC5qcydcbmltcG9ydCB0eXBlIHsgQ29sb3IsIFN0eWxlcyB9IGZyb20gJy4uLy4uL2luay9zdHlsZXMuanMnXG5pbXBvcnQgeyBnZXRUaGVtZSwgdHlwZSBUaGVtZSB9IGZyb20gJy4uLy4uL3V0aWxzL3RoZW1lLmpzJ1xuaW1wb3J0IHsgdXNlVGhlbWUgfSBmcm9tICcuL1RoZW1lUHJvdmlkZXIuanMnXG5cbi8qKiBDb2xvcnMgdW5jb2xvcmVkIFRoZW1lZFRleHQgaW4gdGhlIHN1YnRyZWUuIFByZWNlZGVuY2U6IGV4cGxpY2l0IGBjb2xvcmAgPlxuICogIHRoaXMgPiBkaW1Db2xvci4gQ3Jvc3NlcyBCb3ggYm91bmRhcmllcyAoSW5rJ3Mgc3R5bGUgY2FzY2FkZSBkb2Vzbid0KS4gKi9cbmV4cG9ydCBjb25zdCBUZXh0SG92ZXJDb2xvckNvbnRleHQgPSBSZWFjdC5jcmVhdGVDb250ZXh0PFxuICBrZXlvZiBUaGVtZSB8IHVuZGVmaW5lZFxuPih1bmRlZmluZWQpXG5cbmV4cG9ydCB0eXBlIFByb3BzID0ge1xuICAvKipcbiAgICogQ2hhbmdlIHRleHQgY29sb3IuIEFjY2VwdHMgYSB0aGVtZSBrZXkgb3IgcmF3IGNvbG9yIHZhbHVlLlxuICAgKi9cbiAgcmVhZG9ubHkgY29sb3I/OiBrZXlvZiBUaGVtZSB8IENvbG9yXG5cbiAgLyoqXG4gICAqIFNhbWUgYXMgYGNvbG9yYCwgYnV0IGZvciBiYWNrZ3JvdW5kLiBNdXN0IGJlIGEgdGhlbWUga2V5LlxuICAgKi9cbiAgcmVhZG9ubHkgYmFja2dyb3VuZENvbG9yPzoga2V5b2YgVGhlbWVcblxuICAvKipcbiAgICogRGltIHRoZSBjb2xvciB1c2luZyB0aGUgdGhlbWUncyBpbmFjdGl2ZSBjb2xvci5cbiAgICogVGhpcyBpcyBjb21wYXRpYmxlIHdpdGggYm9sZCAodW5saWtlIEFOU0kgZGltKS5cbiAgICovXG4gIHJlYWRvbmx5IGRpbUNvbG9yPzogYm9vbGVhblxuXG4gIC8qKlxuICAgKiBNYWtlIHRoZSB0ZXh0IGJvbGQuXG4gICAqL1xuICByZWFkb25seSBib2xkPzogYm9vbGVhblxuXG4gIC8qKlxuICAgKiBNYWtlIHRoZSB0ZXh0IGl0YWxpYy5cbiAgICovXG4gIHJlYWRvbmx5IGl0YWxpYz86IGJvb2xlYW5cblxuICAvKipcbiAgICogTWFrZSB0aGUgdGV4dCB1bmRlcmxpbmVkLlxuICAgKi9cbiAgcmVhZG9ubHkgdW5kZXJsaW5lPzogYm9vbGVhblxuXG4gIC8qKlxuICAgKiBNYWtlIHRoZSB0ZXh0IGNyb3NzZWQgd2l0aCBhIGxpbmUuXG4gICAqL1xuICByZWFkb25seSBzdHJpa2V0aHJvdWdoPzogYm9vbGVhblxuXG4gIC8qKlxuICAgKiBJbnZlcnNlIGJhY2tncm91bmQgYW5kIGZvcmVncm91bmQgY29sb3JzLlxuICAgKi9cbiAgcmVhZG9ubHkgaW52ZXJzZT86IGJvb2xlYW5cblxuICAvKipcbiAgICogVGhpcyBwcm9wZXJ0eSB0ZWxscyBJbmsgdG8gd3JhcCBvciB0cnVuY2F0ZSB0ZXh0IGlmIGl0cyB3aWR0aCBpcyBsYXJnZXIgdGhhbiBjb250YWluZXIuXG4gICAqIElmIGB3cmFwYCBpcyBwYXNzZWQgKGJ5IGRlZmF1bHQpLCBJbmsgd2lsbCB3cmFwIHRleHQgYW5kIHNwbGl0IGl0IGludG8gbXVsdGlwbGUgbGluZXMuXG4gICAqIElmIGB0cnVuY2F0ZS0qYCBpcyBwYXNzZWQsIEluayB3aWxsIHRydW5jYXRlIHRleHQgaW5zdGVhZCwgd2hpY2ggd2lsbCByZXN1bHQgaW4gb25lIGxpbmUgb2YgdGV4dCB3aXRoIHRoZSByZXN0IGN1dCBvZmYuXG4gICAqL1xuICByZWFkb25seSB3cmFwPzogU3R5bGVzWyd0ZXh0V3JhcCddXG5cbiAgcmVhZG9ubHkgY2hpbGRyZW4/OiBSZWFjdE5vZGVcbn1cblxuLyoqXG4gKiBSZXNvbHZlcyBhIGNvbG9yIHZhbHVlIHRoYXQgbWF5IGJlIGEgdGhlbWUga2V5IHRvIGEgcmF3IENvbG9yLlxuICovXG5mdW5jdGlvbiByZXNvbHZlQ29sb3IoXG4gIGNvbG9yOiBrZXlvZiBUaGVtZSB8IENvbG9yIHwgdW5kZWZpbmVkLFxuICB0aGVtZTogVGhlbWUsXG4pOiBDb2xvciB8IHVuZGVmaW5lZCB7XG4gIGlmICghY29sb3IpIHJldHVybiB1bmRlZmluZWRcbiAgLy8gQ2hlY2sgaWYgaXQncyBhIHJhdyBjb2xvciAoc3RhcnRzIHdpdGggcmdiKCwgIywgYW5zaTI1NigsIG9yIGFuc2k6KVxuICBpZiAoXG4gICAgY29sb3Iuc3RhcnRzV2l0aCgncmdiKCcpIHx8XG4gICAgY29sb3Iuc3RhcnRzV2l0aCgnIycpIHx8XG4gICAgY29sb3Iuc3RhcnRzV2l0aCgnYW5zaTI1NignKSB8fFxuICAgIGNvbG9yLnN0YXJ0c1dpdGgoJ2Fuc2k6JylcbiAgKSB7XG4gICAgcmV0dXJuIGNvbG9yIGFzIENvbG9yXG4gIH1cbiAgLy8gSXQncyBhIHRoZW1lIGtleSAtIHJlc29sdmUgaXRcbiAgcmV0dXJuIHRoZW1lW2NvbG9yIGFzIGtleW9mIFRoZW1lXSBhcyBDb2xvclxufVxuXG4vKipcbiAqIFRoZW1lLWF3YXJlIFRleHQgY29tcG9uZW50IHRoYXQgcmVzb2x2ZXMgdGhlbWUgY29sb3Iga2V5cyB0byByYXcgY29sb3JzLlxuICogVGhpcyB3cmFwcyB0aGUgYmFzZSBUZXh0IGNvbXBvbmVudCB3aXRoIHRoZW1lIHJlc29sdXRpb24uXG4gKi9cbmV4cG9ydCBkZWZhdWx0IGZ1bmN0aW9uIFRoZW1lZFRleHQoe1xuICBjb2xvcixcbiAgYmFja2dyb3VuZENvbG9yLFxuICBkaW1Db2xvciA9IGZhbHNlLFxuICBib2xkID0gZmFsc2UsXG4gIGl0YWxpYyA9IGZhbHNlLFxuICB1bmRlcmxpbmUgPSBmYWxzZSxcbiAgc3RyaWtldGhyb3VnaCA9IGZhbHNlLFxuICBpbnZlcnNlID0gZmFsc2UsXG4gIHdyYXAgPSAnd3JhcCcsXG4gIGNoaWxkcmVuLFxufTogUHJvcHMpOiBSZWFjdC5SZWFjdE5vZGUge1xuICBjb25zdCBbdGhlbWVOYW1lXSA9IHVzZVRoZW1lKClcbiAgY29uc3QgdGhlbWUgPSBnZXRUaGVtZSh0aGVtZU5hbWUpXG4gIGNvbnN0IGhvdmVyQ29sb3IgPSB1c2VDb250ZXh0KFRleHRIb3ZlckNvbG9yQ29udGV4dClcblxuICAvLyBSZXNvbHZlIHRoZW1lIGtleXMgdG8gcmF3IGNvbG9yc1xuICBjb25zdCByZXNvbHZlZENvbG9yID1cbiAgICAhY29sb3IgJiYgaG92ZXJDb2xvclxuICAgICAgPyByZXNvbHZlQ29sb3IoaG92ZXJDb2xvciwgdGhlbWUpXG4gICAgICA6IGRpbUNvbG9yXG4gICAgICAgID8gKHRoZW1lLmluYWN0aXZlIGFzIENvbG9yKVxuICAgICAgICA6IHJlc29sdmVDb2xvcihjb2xvciwgdGhlbWUpXG4gIGNvbnN0IHJlc29sdmVkQmFja2dyb3VuZENvbG9yID0gYmFja2dyb3VuZENvbG9yXG4gICAgPyAodGhlbWVbYmFja2dyb3VuZENvbG9yXSBhcyBDb2xvcilcbiAgICA6IHVuZGVmaW5lZFxuXG4gIHJldHVybiAoXG4gICAgPFRleHRcbiAgICAgIGNvbG9yPXtyZXNvbHZlZENvbG9yfVxuICAgICAgYmFja2dyb3VuZENvbG9yPXtyZXNvbHZlZEJhY2tncm91bmRDb2xvcn1cbiAgICAgIGJvbGQ9e2JvbGR9XG4gICAgICBpdGFsaWM9e2l0YWxpY31cbiAgICAgIHVuZGVybGluZT17dW5kZXJsaW5lfVxuICAgICAgc3RyaWtldGhyb3VnaD17c3RyaWtldGhyb3VnaH1cbiAgICAgIGludmVyc2U9e2ludmVyc2V9XG4gICAgICB3cmFwPXt3cmFwfVxuICAgID5cbiAgICAgIHtjaGlsZHJlbn1cbiAgICA8L1RleHQ+XG4gIClcbn1cbiJdLCJtYXBwaW5ncyI6IjtBQUFBLGNBQWNBLFNBQVMsUUFBUSxPQUFPO0FBQ3RDLE9BQU9DLEtBQUssSUFBSUMsVUFBVSxRQUFRLE9BQU87QUFDekMsT0FBT0MsSUFBSSxNQUFNLDhCQUE4QjtBQUMvQyxjQUFjQyxLQUFLLEVBQUVDLE1BQU0sUUFBUSxxQkFBcUI7QUFDeEQsU0FBU0MsUUFBUSxFQUFFLEtBQUtDLEtBQUssUUFBUSxzQkFBc0I7QUFDM0QsU0FBU0MsUUFBUSxRQUFRLG9CQUFvQjs7QUFFN0M7QUFDQTtBQUNBLE9BQU8sTUFBTUMscUJBQXFCLEdBQUdSLEtBQUssQ0FBQ1MsYUFBYSxDQUN0RCxNQUFNSCxLQUFLLEdBQUcsU0FBUyxDQUN4QixDQUFDSSxTQUFTLENBQUM7QUFFWixPQUFPLEtBQUtDLEtBQUssR0FBRztFQUNsQjtBQUNGO0FBQ0E7RUFDRSxTQUFTQyxLQUFLLENBQUMsRUFBRSxNQUFNTixLQUFLLEdBQUdILEtBQUs7O0VBRXBDO0FBQ0Y7QUFDQTtFQUNFLFNBQVNVLGVBQWUsQ0FBQyxFQUFFLE1BQU1QLEtBQUs7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