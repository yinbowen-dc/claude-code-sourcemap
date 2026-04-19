/**
 * ThemedBox.tsx — 主题感知盒子组件
 *
 * 在 Claude Code 系统流程中的位置：
 *   设计系统（design-system）层 → UI 基础原语 → 布局容器
 *
 * 主要功能：
 *   1. 对 Ink 框架的 Box 组件进行封装，支持以主题键（ThemeName key）作为
 *      颜色值传入，自动解析为实际颜色码，使整个 UI 可跟随主题切换。
 *   2. 支持 borderColor、backgroundColor 等所有颜色属性接受主题键或
 *      原始颜色值（#hex / rgb() / ansi256() / ansi:）。
 *   3. 利用 React Compiler（react/compiler-runtime）的记忆化缓存（_c）
 *      避免不必要的重新渲染。
 *
 * 使用场景：
 *   整个 Claude Code 终端 UI 中所有需要带边框或背景色且需跟随主题的盒子布局，
 *   替代直接使用 Ink 的 Box 组件。
 */
import { c as _c } from "react/compiler-runtime";
import React, { type PropsWithChildren, type Ref } from 'react';
import Box from '../../ink/components/Box.js';
import type { DOMElement } from '../../ink/dom.js';
import type { ClickEvent } from '../../ink/events/click-event.js';
import type { FocusEvent } from '../../ink/events/focus-event.js';
import type { KeyboardEvent } from '../../ink/events/keyboard-event.js';
import type { Color, Styles } from '../../ink/styles.js';
import { getTheme, type Theme } from '../../utils/theme.js';
import { useTheme } from './ThemeProvider.js';

// 颜色 Props 类型：支持主题键（keyof Theme）或原始颜色值（Color）作为颜色属性
type ThemedColorProps = {
  readonly borderColor?: keyof Theme | Color;       // 全边框颜色
  readonly borderTopColor?: keyof Theme | Color;    // 上边框颜色
  readonly borderBottomColor?: keyof Theme | Color; // 下边框颜色
  readonly borderLeftColor?: keyof Theme | Color;   // 左边框颜色
  readonly borderRightColor?: keyof Theme | Color;  // 右边框颜色
  readonly backgroundColor?: keyof Theme | Color;   // 背景色
};

// 从 Ink Styles 中剔除颜色相关属性，避免与 ThemedColorProps 冲突（后者允许主题键）
type BaseStylesWithoutColors = Omit<Styles, 'textWrap' | 'borderColor' | 'borderTopColor' | 'borderBottomColor' | 'borderLeftColor' | 'borderRightColor' | 'backgroundColor'>;
export type Props = BaseStylesWithoutColors & ThemedColorProps & {
  ref?: Ref<DOMElement>;
  tabIndex?: number;
  autoFocus?: boolean;
  onClick?: (event: ClickEvent) => void;
  onFocus?: (event: FocusEvent) => void;
  onFocusCapture?: (event: FocusEvent) => void;
  onBlur?: (event: FocusEvent) => void;
  onBlurCapture?: (event: FocusEvent) => void;
  onKeyDown?: (event: KeyboardEvent) => void;
  onKeyDownCapture?: (event: KeyboardEvent) => void;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
};

/**
 * resolveColor — 将颜色值（主题键或原始颜色）解析为实际颜色码
 *
 * 整体流程：
 *   1. 若 color 为空，直接返回 undefined（不需要着色）
 *   2. 判断 color 是否为原始颜色格式（rgb(、#、ansi256(、ansi:），
 *      是则直接强转为 Color 类型返回，无需查主题表
 *   3. 否则将其视为主题键（如 'error'、'promptBorder'），
 *      从 theme 对象中取出对应的实际颜色码返回
 *
 * 在文件中的作用：
 *   被 ThemedBox 组件调用，为每个颜色 prop 统一解析出可直接传给 Ink Box 的颜色值。
 */
function resolveColor(color: keyof Theme | Color | undefined, theme: Theme): Color | undefined {
  // 空值快速返回，避免后续字符串操作
  if (!color) return undefined;
  // 判断是否为原始颜色格式（rgb(、#、ansi256(、ansi:）
  if (color.startsWith('rgb(') || color.startsWith('#') || color.startsWith('ansi256(') || color.startsWith('ansi:')) {
    // 是原始颜色，直接类型断言返回，无需查主题映射表
    return color as Color;
  }
  // 是主题键，从当前主题对象取出实际颜色码
  return theme[color as keyof Theme] as Color;
}

/**
 * ThemedBox — 主题感知的 Ink Box 包装组件
 *
 * 整体流程：
 *   1. 接收所有 Box 支持的布局 props + 颜色 props（可为主题键或原始颜色）
 *   2. 通过 useTheme() 获取当前主题名称（如 'dark'/'light'）
 *   3. 将 borderColor / borderTopColor / borderBottomColor / borderLeftColor /
 *      borderRightColor / backgroundColor 等颜色 props 用 resolveColor() 解析
 *      为实际颜色字符串（或 undefined）
 *   4. 将解析后的颜色和其余 props 一并传给 Ink 的 Box 组件渲染
 *
 * React Compiler 记忆化策略（_c(33)，共 33 个缓存槽）：
 *   - $[0]~$[9]：对比 props 对象 t0 是否变化，变化时重新解构各 prop
 *   - $[10]~$[22]：对比 6 个颜色 props + themeName 是否变化，
 *                   变化时重新调用 resolveColor() 解析全部颜色
 *   - $[23]~$[32]：对比 children、ref、已解析颜色和 rest 是否变化，
 *                   变化时重新创建 JSX，否则复用缓存
 *
 * 在系统中的作用：
 *   作为整个 Claude Code 终端 UI 中带颜色边框/背景布局的通用容器，
 *   使所有颜色跟随主题自动切换，无需手动读取主题色值。
 */
function ThemedBox(t0) {
  // 初始化大小为 33 的 React 编译器记忆缓存槽数组
  const $ = _c(33);
  let backgroundColor;
  let borderBottomColor;
  let borderColor;
  let borderLeftColor;
  let borderRightColor;
  let borderTopColor;
  let children;
  let ref;
  let rest;
  // 第一层缓存：若 props 对象 t0 变化，则重新解构所有 prop 并存入缓存
  if ($[0] !== t0) {
    ({
      borderColor,
      borderTopColor,
      borderBottomColor,
      borderLeftColor,
      borderRightColor,
      backgroundColor,
      children,
      ref,
      ...rest
    } = t0);
    $[0] = t0;       // 存入新 t0 引用
    $[1] = backgroundColor;
    $[2] = borderBottomColor;
    $[3] = borderColor;
    $[4] = borderLeftColor;
    $[5] = borderRightColor;
    $[6] = borderTopColor;
    $[7] = children;
    $[8] = ref;
    $[9] = rest;
  } else {
    // 缓存命中，直接从缓存槽取出各 prop，跳过解构
    backgroundColor = $[1];
    borderBottomColor = $[2];
    borderColor = $[3];
    borderLeftColor = $[4];
    borderRightColor = $[5];
    borderTopColor = $[6];
    children = $[7];
    ref = $[8];
    rest = $[9];
  }
  // 从 ThemeProvider 获取当前主题名称（'dark' | 'light' | 'auto'）
  const [themeName] = useTheme();
  let resolvedBorderBottomColor;
  let resolvedBorderColor;
  let resolvedBorderLeftColor;
  let resolvedBorderRightColor;
  let resolvedBorderTopColor;
  let t1;
  // 第二层缓存：若任一颜色 prop 或 themeName 变化，则重新解析所有颜色值
  if ($[10] !== backgroundColor || $[11] !== borderBottomColor || $[12] !== borderColor || $[13] !== borderLeftColor || $[14] !== borderRightColor || $[15] !== borderTopColor || $[16] !== themeName) {
    // 根据当前主题名取出主题配色对象
    const theme = getTheme(themeName);
    // 将各颜色 prop（可能是主题键或原始颜色）解析为实际颜色字符串
    resolvedBorderColor = resolveColor(borderColor, theme);
    resolvedBorderTopColor = resolveColor(borderTopColor, theme);
    resolvedBorderBottomColor = resolveColor(borderBottomColor, theme);
    resolvedBorderLeftColor = resolveColor(borderLeftColor, theme);
    resolvedBorderRightColor = resolveColor(borderRightColor, theme);
    t1 = resolveColor(backgroundColor, theme); // 解析背景色（t1 暂存后赋给 resolvedBackgroundColor）
    // 将本次输入和结果存入对应缓存槽
    $[10] = backgroundColor;
    $[11] = borderBottomColor;
    $[12] = borderColor;
    $[13] = borderLeftColor;
    $[14] = borderRightColor;
    $[15] = borderTopColor;
    $[16] = themeName;
    $[17] = resolvedBorderBottomColor;
    $[18] = resolvedBorderColor;
    $[19] = resolvedBorderLeftColor;
    $[20] = resolvedBorderRightColor;
    $[21] = resolvedBorderTopColor;
    $[22] = t1;
  } else {
    // 缓存命中，从缓存槽取出上次解析结果
    resolvedBorderBottomColor = $[17];
    resolvedBorderColor = $[18];
    resolvedBorderLeftColor = $[19];
    resolvedBorderRightColor = $[20];
    resolvedBorderTopColor = $[21];
    t1 = $[22];
  }
  // 将 t1（已解析的 backgroundColor）赋给语义化变量
  const resolvedBackgroundColor = t1;
  let t2;
  // 第三层缓存：若任一输出 prop（children/ref/已解析颜色/rest）变化，则重新创建 JSX
  if ($[23] !== children || $[24] !== ref || $[25] !== resolvedBackgroundColor || $[26] !== resolvedBorderBottomColor || $[27] !== resolvedBorderColor || $[28] !== resolvedBorderLeftColor || $[29] !== resolvedBorderRightColor || $[30] !== resolvedBorderTopColor || $[31] !== rest) {
    // 创建 Ink Box JSX，传入全部解析后的颜色 props 和其余布局 props
    t2 = <Box ref={ref} borderColor={resolvedBorderColor} borderTopColor={resolvedBorderTopColor} borderBottomColor={resolvedBorderBottomColor} borderLeftColor={resolvedBorderLeftColor} borderRightColor={resolvedBorderRightColor} backgroundColor={resolvedBackgroundColor} {...rest}>{children}</Box>;
    $[23] = children;
    $[24] = ref;
    $[25] = resolvedBackgroundColor;
    $[26] = resolvedBorderBottomColor;
    $[27] = resolvedBorderColor;
    $[28] = resolvedBorderLeftColor;
    $[29] = resolvedBorderRightColor;
    $[30] = resolvedBorderTopColor;
    $[31] = rest;
    $[32] = t2;
  } else {
    // 缓存命中，复用上次 JSX 渲染结果
    t2 = $[32];
  }
  return t2;
}
export default ThemedBox;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJSZWFjdCIsIlByb3BzV2l0aENoaWxkcmVuIiwiUmVmIiwiQm94IiwiRE9NRWxlbWVudCIsIkNsaWNrRXZlbnQiLCJGb2N1c0V2ZW50IiwiS2V5Ym9hcmRFdmVudCIsIkNvbG9yIiwiU3R5bGVzIiwiZ2V0VGhlbWUiLCJUaGVtZSIsInVzZVRoZW1lIiwiVGhlbWVkQ29sb3JQcm9wcyIsImJvcmRlckNvbG9yIiwiYm9yZGVyVG9wQ29sb3IiLCJib3JkZXJCb3R0b21Db2xvciIsImJvcmRlckxlZnRDb2xvciIsImJvcmRlclJpZ2h0Q29sb3IiLCJiYWNrZ3JvdW5kQ29sb3IiLCJCYXNlU3R5bGVzV2l0aG91dENvbG9ycyIsIk9taXQiLCJQcm9wcyIsInJlZiIsInRhYkluZGV4IiwiYXV0b0ZvY3VzIiwib25DbGljayIsImV2ZW50Iiwib25Gb2N1cyIsIm9uRm9jdXNDYXB0dXJlIiwib25CbHVyIiwib25CbHVyQ2FwdHVyZSIsIm9uS2V5RG93biIsIm9uS2V5RG93bkNhcHR1cmUiLCJvbk1vdXNlRW50ZXIiLCJvbk1vdXNlTGVhdmUiLCJyZXNvbHZlQ29sb3IiLCJjb2xvciIsInRoZW1lIiwidW5kZWZpbmVkIiwic3RhcnRzV2l0aCIsIlRoZW1lZEJveCIsInQwIiwiJCIsIl9jIiwiY2hpbGRyZW4iLCJyZXN0IiwidGhlbWVOYW1lIiwicmVzb2x2ZWRCb3JkZXJCb3R0b21Db2xvciIsInJlc29sdmVkQm9yZGVyQ29sb3IiLCJyZXNvbHZlZEJvcmRlckxlZnRDb2xvciIsInJlc29sdmVkQm9yZGVyUmlnaHRDb2xvciIsInJlc29sdmVkQm9yZGVyVG9wQ29sb3IiLCJ0MSIsInJlc29sdmVkQmFja2dyb3VuZENvbG9yIiwidDIiXSwic291cmNlcyI6WyJUaGVtZWRCb3gudHN4Il0sInNvdXJjZXNDb250ZW50IjpbImltcG9ydCBSZWFjdCwgeyB0eXBlIFByb3BzV2l0aENoaWxkcmVuLCB0eXBlIFJlZiB9IGZyb20gJ3JlYWN0J1xuaW1wb3J0IEJveCBmcm9tICcuLi8uLi9pbmsvY29tcG9uZW50cy9Cb3guanMnXG5pbXBvcnQgdHlwZSB7IERPTUVsZW1lbnQgfSBmcm9tICcuLi8uLi9pbmsvZG9tLmpzJ1xuaW1wb3J0IHR5cGUgeyBDbGlja0V2ZW50IH0gZnJvbSAnLi4vLi4vaW5rL2V2ZW50cy9jbGljay1ldmVudC5qcydcbmltcG9ydCB0eXBlIHsgRm9jdXNFdmVudCB9IGZyb20gJy4uLy4uL2luay9ldmVudHMvZm9jdXMtZXZlbnQuanMnXG5pbXBvcnQgdHlwZSB7IEtleWJvYXJkRXZlbnQgfSBmcm9tICcuLi8uLi9pbmsvZXZlbnRzL2tleWJvYXJkLWV2ZW50LmpzJ1xuaW1wb3J0IHR5cGUgeyBDb2xvciwgU3R5bGVzIH0gZnJvbSAnLi4vLi4vaW5rL3N0eWxlcy5qcydcbmltcG9ydCB7IGdldFRoZW1lLCB0eXBlIFRoZW1lIH0gZnJvbSAnLi4vLi4vdXRpbHMvdGhlbWUuanMnXG5pbXBvcnQgeyB1c2VUaGVtZSB9IGZyb20gJy4vVGhlbWVQcm92aWRlci5qcydcblxuLy8gQ29sb3IgcHJvcHMgdGhhdCBhY2NlcHQgdGhlbWUga2V5c1xudHlwZSBUaGVtZWRDb2xvclByb3BzID0ge1xuICByZWFkb25seSBib3JkZXJDb2xvcj86IGtleW9mIFRoZW1lIHwgQ29sb3JcbiAgcmVhZG9ubHkgYm9yZGVyVG9wQ29sb3I/OiBrZXlvZiBUaGVtZSB8IENvbG9yXG4gIHJlYWRvbmx5IGJvcmRlckJvdHRvbUNvbG9yPzoga2V5b2YgVGhlbWUgfCBDb2xvclxuICByZWFkb25seSBib3JkZXJMZWZ0Q29sb3I/OiBrZXlvZiBUaGVtZSB8IENvbG9yXG4gIHJlYWRvbmx5IGJvcmRlclJpZ2h0Q29sb3I/OiBrZXlvZiBUaGVtZSB8IENvbG9yXG4gIHJlYWRvbmx5IGJhY2tncm91bmRDb2xvcj86IGtleW9mIFRoZW1lIHwgQ29sb3Jcbn1cblxuLy8gQmFzZSBTdHlsZXMgd2l0aG91dCBjb2xvciBwcm9wcyAodGhleSdsbCBiZSBvdmVycmlkZGVuKVxudHlwZSBCYXNlU3R5bGVzV2l0aG91dENvbG9ycyA9IE9taXQ8XG4gIFN0eWxlcyxcbiAgfCAndGV4dFdyYXAnXG4gIHwgJ2JvcmRlckNvbG9yJ1xuICB8ICdib3JkZXJUb3BDb2xvcidcbiAgfCAnYm9yZGVyQm90dG9tQ29sb3InXG4gIHwgJ2JvcmRlckxlZnRDb2xvcidcbiAgfCAnYm9yZGVyUmlnaHRDb2xvcidcbiAgfCAnYmFja2dyb3VuZENvbG9yJ1xuPlxuXG5leHBvcnQgdHlwZSBQcm9wcyA9IEJhc2VTdHlsZXNXaXRob3V0Q29sb3JzICZcbiAgVGhlbWVkQ29sb3JQcm9wcyAmIHtcbiAgICByZWY/OiBSZWY8RE9NRWxlbWVudD5cbiAgICB0YWJJbmRleD86IG51bWJlclxuICAgIGF1dG9Gb2N1cz86IGJvb2xlYW5cbiAgICBvbkNsaWNrPzogKGV2ZW50OiBDbGlja0V2ZW50KSA9PiB2b2lkXG4gICAgb25Gb2N1cz86IChldmVudDogRm9jdXNFdmVudCkgPT4gdm9pZFxuICAgIG9uRm9jdXNDYXB0dXJlPzogKGV2ZW50OiBGb2N1c0V2ZW50KSA9PiB2b2lkXG4gICAgb25CbHVyPzogKGV2ZW50OiBGb2N1c0V2ZW50KSA9PiB2b2lkXG4gICAgb25CbHVyQ2FwdHVyZT86IChldmVudDogRm9jdXNFdmVudCkgPT4gdm9pZFxuICAgIG9uS2V5RG93bj86IChldmVudDogS2V5Ym9hcmRFdmVudCkgPT4gdm9pZFxuICAgIG9uS2V5RG93bkNhcHR1cmU/OiAoZXZlbnQ6IEtleWJvYXJkRXZlbnQpID0+IHZvaWRcbiAgICBvbk1vdXNlRW50ZXI/OiAoKSA9PiB2b2lkXG4gICAgb25Nb3VzZUxlYXZlPzogKCkgPT4gdm9pZFxuICB9XG5cbi8qKlxuICogUmVzb2x2ZXMgYSBjb2xvciB2YWx1ZSB0aGF0IG1heSBiZSBhIHRoZW1lIGtleSB0byBhIHJhdyBDb2xvci5cbiAqL1xuZnVuY3Rpb24gcmVzb2x2ZUNvbG9yKFxuICBjb2xvcjoga2V5b2YgVGhlbWUgfCBDb2xvciB8IHVuZGVmaW5lZCxcbiAgdGhlbWU6IFRoZW1lLFxuKTogQ29sb3IgfCB1bmRlZmluZWQge1xuICBpZiAoIWNvbG9yKSByZXR1cm4gdW5kZWZpbmVkXG4gIC8vIENoZWNrIGlmIGl0J3MgYSByYXcgY29sb3IgKHN0YXJ0cyB3aXRoIHJnYigsICMsIGFuc2kyNTYoLCBvciBhbnNpOilcbiAgaWYgKFxuICAgIGNvbG9yLnN0YXJ0c1dpdGgoJ3JnYignKSB8fFxuICAgIGNvbG9yLnN0YXJ0c1dpdGgoJyMnKSB8fFxuICAgIGNvbG9yLnN0YXJ0c1dpdGgoJ2Fuc2kyNTYoJykgfHxcbiAgICBjb2xvci5zdGFydHNXaXRoKCdhbnNpOicpXG4gICkge1xuICAgIHJldHVybiBjb2xvciBhcyBDb2xvclxuICB9XG4gIC8vIEl0J3MgYSB0aGVtZSBrZXkgLSByZXNvbHZlIGl0XG4gIHJldHVybiB0aGVtZVtjb2xvciBhcyBrZXlvZiBUaGVtZV0gYXMgQ29sb3Jcbn1cblxuLyoqXG4gKiBUaGVtZS1hd2FyZSBCb3ggY29tcG9uZW50IHRoYXQgcmVzb2x2ZXMgdGhlbWUgY29sb3Iga2V5cyB0byByYXcgY29sb3JzLlxuICogVGhpcyB3cmFwcyB0aGUgYmFzZSBCb3ggY29tcG9uZW50IHdpdGggdGhlbWUgcmVzb2x1dGlvbiBmb3IgYm9yZGVyIGNvbG9ycy5cbiAqL1xuZnVuY3Rpb24gVGhlbWVkQm94KHtcbiAgYm9yZGVyQ29sb3IsXG4gIGJvcmRlclRvcENvbG9yLFxuICBib3JkZXJCb3R0b21Db2xvcixcbiAgYm9yZGVyTGVmdENvbG9yLFxuICBib3JkZXJSaWdodENvbG9yLFxuICBiYWNrZ3JvdW5kQ29sb3IsXG4gIGNoaWxkcmVuLFxuICByZWYsXG4gIC4uLnJlc3Rcbn06IFByb3BzV2l0aENoaWxkcmVuPFByb3BzPik6IFJlYWN0LlJlYWN0Tm9kZSB7XG4gIGNvbnN0IFt0aGVtZU5hbWVdID0gdXNlVGhlbWUoKVxuICBjb25zdCB0aGVtZSA9IGdldFRoZW1lKHRoZW1lTmFtZSlcblxuICAvLyBSZXNvbHZlIHRoZW1lIGtleXMgdG8gcmF3IGNvbG9yc1xuICBjb25zdCByZXNvbHZlZEJvcmRlckNvbG9yID0gcmVzb2x2ZUNvbG9yKGJvcmRlckNvbG9yLCB0aGVtZSlcbiAgY29uc3QgcmVzb2x2ZWRCb3JkZXJUb3BDb2xvciA9IHJlc29sdmVDb2xvcihib3JkZXJUb3BDb2xvciwgdGhlbWUpXG4gIGNvbnN0IHJlc29sdmVkQm9yZGVyQm90dG9tQ29sb3IgPSByZXNvbHZlQ29sb3IoYm9yZGVyQm90dG9tQ29sb3IsIHRoZW1lKVxuICBjb25zdCByZXNvbHZlZEJvcmRlckxlZnRDb2xvciA9IHJlc29sdmVDb2xvcihib3JkZXJMZWZ0Q29sb3IsIHRoZW1lKVxuICBjb25zdCByZXNvbHZlZEJvcmRlclJpZ2h0Q29sb3IgPSByZXNvbHZlQ29sb3IoYm9yZGVyUmlnaHRDb2xvciwgdGhlbWUpXG4gIGNvbnN0IHJlc29sdmVkQmFja2dyb3VuZENvbG9yID0gcmVzb2x2ZUNvbG9yKGJhY2tncm91bmRDb2xvciwgdGhlbWUpXG5cbiAgcmV0dXJuIChcbiAgICA8Qm94XG4gICAgICByZWY9e3JlZn1cbiAgICAgIGJvcmRlckNvbG9yPXtyZXNvbHZlZEJvcmRlckNvbG9yfVxuICAgICAgYm9yZGVyVG9wQ29sb3I9e3Jlc29sdmVkQm9yZGVyVG9wQ29sb3J9XG4gICAgICBib3JkZXJCb3R0b21Db2xvcj17cmVzb2x2ZWRCb3JkZXJCb3R0b21Db2xvcn1cbiAgICAgIGJvcmRlckxlZnRDb2xvcj17cmVzb2x2ZWRCb3JkZXJMZWZ0Q29sb3J9XG4gICAgICBib3JkZXJSaWdodENvbG9yPXtyZXNvbHZlZEJvcmRlclJpZ2h0Q29sb3J9XG4gICAgICBiYWNrZ3JvdW5kQ29sb3I9e3Jlc29sdmVkQmFja2dyb3VuZENvbG9yfVxuICAgICAgey4uLnJlc3R9XG4gICAgPlxuICAgICAge2NoaWxkcmVufVxuICAgIDwvQm94PlxuICApXG59XG5cbmV4cG9ydCBkZWZhdWx0IFRoZW1lZEJveFxuIl0sIm1hcHBpbmdzIjoiO0FBQUEsT0FBT0EsS0FBSyxJQUFJLEtBQUtDLGlCQUFpQixFQUFFLEtBQUtDLEdBQUcsUUFBUSxPQUFPO0FBQy9ELE9BQU9DLEdBQUcsTUFBTSw2QkFBNkI7QUFDN0MsY0FBY0MsVUFBVSxRQUFRLGtCQUFrQjtBQUNsRCxjQUFjQyxVQUFVLFFBQVEsaUNBQWlDO0FBQ2pFLGNBQWNDLFVBQVUsUUFBUSxpQ0FBaUM7QUFDakUsY0FBY0MsYUFBYSxRQUFRLG9DQUFvQztBQUN2RSxjQUFjQyxLQUFLLEVBQUVDLE1BQU0sUUFBUSxxQkFBcUI7QUFDeEQsU0FBU0MsUUFBUSxFQUFFLEtBQUtDLEtBQUssUUFBUSxzQkFBc0I7QUFDM0QsU0FBU0MsUUFBUSxRQUFRLG9CQUFvQjs7QUFFN0M7QUFDQSxLQUFLQyxnQkFBZ0IsR0FBRztFQUN0QixTQUFTQyxXQUFXLENBQUMsRUFBRSxNQUFNSCxLQUFLLEdBQUdILEtBQUs7RUFDMUMsU0FBU08sY0FBYyxDQUFDLEVBQUUsTUFBTUosS0FBSyxHQUFHSCxLQUFLO0VBQzdDLFNBQVNRLGlCQUFpQixDQUFDLEVBQUUsTUFBTUwsS0FBSyxHQUFHSCxLQUFLO0VBQ2hELFNBQVNTLGVBQWUsQ0FBQyxFQUFFLE1BQU1OLEtBQUssR0FBR0gsS0FBSztFQUM5QyxTQUFTVSxnQkFBZ0IsQ0FBQyxFQUFFLE1BQU1QLEtBQUssR0FBR0gsS0FBSztFQUMvQyxTQUFTVyxlQUFlLENBQUMsRUFBRSxNQUFNUixLQUFLLEdBQUdILEtBQUs7QUFDaEQsQ0FBQzs7QUFFRDtBQUNBLEtBQUtZLHVCQUF1QixHQUFHQyxJQUFJLENBQ2pDWixNQUFNLEVBQ0osVUFBVSxHQUNWLGFBQWEsR0FDYixnQkFBZ0IsR0FDaEIsbUJBQW1CLEdBQ25CLGlCQUFpQixHQUNqQixrQkFBa0IsR0FDbEIsaUJBQWlCLENBQ3BCO0FBRUQsT0FBTyxLQUFLYSxLQUFLLEdBQUdGLHVCQUF1QixHQUN6Q1AsZ0JBQWdCLEdBQUc7RUFDakJVLEdBQUcsQ0FBQyxFQUFFckIsR0FBRyxDQUFDRSxVQUFVLENBQUM7RUFDckJvQixRQUFRLENBQUMsRUFBRSxNQUFNO0VBQ2pCQyxTQUFTLENBQUMsRUFBRSxPQUFPO0VBQ25CQyxPQUFPLENBQUMsRUFBRSxDQUFDQyxLQUFLLEVBQUV0QixVQUFVLEVBQUUsR0FBRyxJQUFJO0VBQ3JDdUIsT0FBTyxDQUFDLEVBQUUsQ0FBQ0QsS0FBSyxFQUFFckIsVUFBVSxFQUFFLEdBQUcsSUFBSTtFQUNyQ3VCLGNBQWMsQ0FBQyxFQUFFLENBQUNGLEtBQUssRUFBRXJCLFVBQVUsRUFBRSxHQUFHLElBQUk7RUFDNUN3QixNQUFNLENBQUMsRUFBRSxDQUFDSCxLQUFLLEVBQUVyQixVQUFVLEVBQUUsR0FBRyxJQUFJO0VBQ3BDeUIsYUFBYSxDQUFDLEVBQUUsQ0FBQ0osS0FBSyxFQUFFckIsVUFBVSxFQUFFLEdBQUcsSUFBSTtFQUMzQzBCLFNBQVMsQ0FBQyxFQUFFLENBQUNMLEtBQUssRUFBRXBCLGFBQWEsRUFBRSxHQUFHLElBQUk7RUFDMUMwQixnQkFBZ0IsQ0FBQyxFQUFFLENBQUNOLEtBQUssRUFBRXBCLGFBQWEsRUFBRSxHQUFHLElBQUk7RUFDakQyQixZQUFZLENBQUMsRUFBRSxHQUFHLEdBQUcsSUFBSTtFQUN6QkMsWUFBWSxDQUFDLEVBQUUsR0FBRyxHQUFHLElBQUk7QUFDM0IsQ0FBQzs7QUFFSDtBQUNBO0FBQ0E7QUFDQSxTQUFTQyxZQUFZQSxDQUNuQkMsS0FBSyxFQUFFLE1BQU0xQixLQUFLLEdBQUdILEtBQUssR0FBRyxTQUFTLEVBQ3RDOEIsS0FBSyxFQUFFM0IsS0FBSyxDQUNiLEVBQUVILEtBQUssR0FBRyxTQUFTLENBQUM7RUFDbkIsSUFBSSxDQUFDNkIsS0FBSyxFQUFFLE9BQU9FLFNBQVM7RUFDNUI7RUFDQSxJQUNFRixLQUFLLENBQUNHLFVBQVUsQ0FBQyxNQUFNLENBQUMsSUFDeEJILEtBQUssQ0FBQ0csVUFBVSxDQUFDLEdBQUcsQ0FBQyxJQUNyQkgsS0FBSyxDQUFDRyxVQUFVLENBQUMsVUFBVSxDQUFDLElBQzVCSCxLQUFLLENBQUNHLFVBQVUsQ0FBQyxPQUFPLENBQUMsRUFDekI7SUFDQSxPQUFPSCxLQUFLLElBQUk3QixLQUFLO0VBQ3ZCO0VBQ0E7RUFDQSxPQUFPOEIsS0FBSyxDQUFDRCxLQUFLLElBQUksTUFBTTFCLEtBQUssQ0FBQyxJQUFJSCxLQUFLO0FBQzdDOztBQUVBO0FBQ0E7QUFDQTtBQUNBO0FBQ0EsU0FBQWlDLFVBQUFDLEVBQUE7RUFBQSxNQUFBQyxDQUFBLEdBQUFDLEVBQUE7RUFBQSxJQUFBekIsZUFBQTtFQUFBLElBQUFILGlCQUFBO0VBQUEsSUFBQUYsV0FBQTtFQUFBLElBQUFHLGVBQUE7RUFBQSxJQUFBQyxnQkFBQTtFQUFBLElBQUFILGNBQUE7RUFBQSxJQUFBOEIsUUFBQTtFQUFBLElBQUF0QixHQUFBO0VBQUEsSUFBQXVCLElBQUE7RUFBQSxJQUFBSCxDQUFBLFFBQUFELEVBQUE7SUFBbUI7TUFBQTVCLFdBQUE7TUFBQUMsY0FBQTtNQUFBQyxpQkFBQTtNQUFBQyxlQUFBO01BQUFDLGdCQUFBO01BQUFDLGVBQUE7TUFBQTBCLFFBQUE7TUFBQXRCLEdBQUE7TUFBQSxHQUFBdUI7SUFBQSxJQUFBSixFQVVRO0lBQUFDLENBQUEsTUFBQUQsRUFBQTtJQUFBQyxDQUFBLE1BQUF4QixlQUFBO0lBQUF3QixDQUFBLE1BQUEzQixpQkFBQTtJQUFBMkIsQ0FBQSxNQUFBN0IsV0FBQTtJQUFBNkIsQ0FBQSxNQUFBMUIsZUFBQTtJQUFBMEIsQ0FBQSxNQUFBekIsZ0JBQUE7SUFBQXlCLENBQUEsTUFBQTVCLGNBQUE7SUFBQTRCLENBQUEsTUFBQUUsUUFBQTtJQUFBRixDQUFBLE1BQUFwQixHQUFBO0lBQUFvQixDQUFBLE1BQUFHLElBQUE7RUFBQTtJQUFBM0IsZUFBQSxHQUFBd0IsQ0FBQTtJQUFBM0IsaUJBQUEsR0FBQTJCLENBQUE7SUFBQTdCLFdBQUEsR0FBQTZCLENBQUE7SUFBQTFCLGVBQUEsR0FBQTBCLENBQUE7SUFBQXpCLGdCQUFBLEdBQUF5QixDQUFBO0lBQUE1QixjQUFBLEdBQUE0QixDQUFBO0lBQUFFLFFBQUEsR0FBQUYsQ0FBQTtJQUFBcEIsR0FBQSxHQUFBb0IsQ0FBQTtJQUFBRyxJQUFBLEdBQUFILENBQUE7RUFBQTtFQUN6QixPQUFBSSxTQUFBLElBQW9CbkMsUUFBUSxDQUFDLENBQUM7RUFBQSxJQUFBb0MseUJBQUE7RUFBQSxJQUFBQyxtQkFBQTtFQUFBLElBQUFDLHVCQUFBO0VBQUEsSUFBQUMsd0JBQUE7RUFBQSxJQUFBQyxzQkFBQTtFQUFBLElBQUFDLEVBQUE7RUFBQSxJQUFBVixDQUFBLFNBQUF4QixlQUFBLElBQUF3QixDQUFBLFNBQUEzQixpQkFBQSxJQUFBMkIsQ0FBQSxTQUFBN0IsV0FBQSxJQUFBNkIsQ0FBQSxTQUFBMUIsZUFBQSxJQUFBMEIsQ0FBQSxTQUFBekIsZ0JBQUEsSUFBQXlCLENBQUEsU0FBQTVCLGNBQUEsSUFBQTRCLENBQUEsU0FBQUksU0FBQTtJQUM5QixNQUFBVCxLQUFBLEdBQWM1QixRQUFRLENBQUNxQyxTQUFTLENBQUM7SUFHakNFLG1CQUFBLEdBQTRCYixZQUFZLENBQUN0QixXQUFXLEVBQUV3QixLQUFLLENBQUM7SUFDNURjLHNCQUFBLEdBQStCaEIsWUFBWSxDQUFDckIsY0FBYyxFQUFFdUIsS0FBSyxDQUFDO0lBQ2xFVSx5QkFBQSxHQUFrQ1osWUFBWSxDQUFDcEIsaUJBQWlCLEVBQUVzQixLQUFLLENBQUM7SUFDeEVZLHVCQUFBLEdBQWdDZCxZQUFZLENBQUNuQixlQUFlLEVBQUVxQixLQUFLLENBQUM7SUFDcEVhLHdCQUFBLEdBQWlDZixZQUFZLENBQUNsQixnQkFBZ0IsRUFBRW9CLEtBQUssQ0FBQztJQUN0Q2UsRUFBQSxHQUFBakIsWUFBWSxDQUFDakIsZUFBZSxFQUFFbUIsS0FBSyxDQUFDO0lBQUFLLENBQUEsT0FBQXhCLGVBQUE7SUFBQXdCLENBQUEsT0FBQTNCLGlCQUFBO0lBQUEyQixDQUFBLE9BQUE3QixXQUFBO0lBQUE2QixDQUFBLE9BQUExQixlQUFBO0lBQUEwQixDQUFBLE9BQUF6QixnQkFBQTtJQUFBeUIsQ0FBQSxPQUFBNUIsY0FBQTtJQUFBNEIsQ0FBQSxPQUFBSSxTQUFBO0lBQUFKLENBQUEsT0FBQUsseUJBQUE7SUFBQUwsQ0FBQSxPQUFBTSxtQkFBQTtJQUFBTixDQUFBLE9BQUFPLHVCQUFBO0lBQUFQLENBQUEsT0FBQVEsd0JBQUE7SUFBQVIsQ0FBQSxPQUFBUyxzQkFBQTtJQUFBVCxDQUFBLE9BQUFVLEVBQUE7RUFBQTtJQUFBTCx5QkFBQSxHQUFBTCxDQUFBO0lBQUFNLG1CQUFBLEdBQUFOLENBQUE7SUFBQU8sdUJBQUEsR0FBQVAsQ0FBQTtJQUFBUSx3QkFBQSxHQUFBUixDQUFBO0lBQUFTLHNCQUFBLEdBQUFULENBQUE7SUFBQVUsRUFBQSxHQUFBVixDQUFBO0VBQUE7RUFBcEUsTUFBQVcsdUJBQUEsR0FBZ0NELEVBQW9DO0VBQUEsSUFBQUUsRUFBQTtFQUFBLElBQUFaLENBQUEsU0FBQUUsUUFBQSxJQUFBRixDQUFBLFNBQUFwQixHQUFBLElBQUFvQixDQUFBLFNBQUFXLHVCQUFBLElBQUFYLENBQUEsU0FBQUsseUJBQUEsSUFBQUwsQ0FBQSxTQUFBTSxtQkFBQSxJQUFBTixDQUFBLFNBQUFPLHVCQUFBLElBQUFQLENBQUEsU0FBQVEsd0JBQUEsSUFBQVIsQ0FBQSxTQUFBUyxzQkFBQSxJQUFBVCxDQUFBLFNBQUFHLElBQUE7SUFHbEVTLEVBQUEsSUFBQyxHQUFHLENBQ0doQyxHQUFHLENBQUhBLElBQUUsQ0FBQyxDQUNLMEIsV0FBbUIsQ0FBbkJBLG9CQUFrQixDQUFDLENBQ2hCRyxjQUFzQixDQUF0QkEsdUJBQXFCLENBQUMsQ0FDbkJKLGlCQUF5QixDQUF6QkEsMEJBQXdCLENBQUMsQ0FDM0JFLGVBQXVCLENBQXZCQSx3QkFBc0IsQ0FBQyxDQUN0QkMsZ0JBQXdCLENBQXhCQSx5QkFBdUIsQ0FBQyxDQUN6QkcsZUFBdUIsQ0FBdkJBLHdCQUFzQixDQUFDLEtBQ3BDUixJQUFJLEVBRVBELFNBQU8sQ0FDVixFQVhDLEdBQUcsQ0FXRTtJQUFBRixDQUFBLE9BQUFFLFFBQUE7SUFBQUYsQ0FBQSxPQUFBcEIsR0FBQTtJQUFBb0IsQ0FBQSxPQUFBVyx1QkFBQTtJQUFBWCxDQUFBLE9BQUFLLHlCQUFBO0lBQUFMLENBQUEsT0FBQU0sbUJBQUE7SUFBQU4sQ0FBQSxPQUFBTyx1QkFBQTtJQUFBUCxDQUFBLE9BQUFRLHdCQUFBO0lBQUFSLENBQUEsT0FBQVMsc0JBQUE7SUFBQVQsQ0FBQSxPQUFBRyxJQUFBO0lBQUFILENBQUEsT0FBQVksRUFBQTtFQUFBO0lBQUFBLEVBQUEsR0FBQVosQ0FBQTtFQUFBO0VBQUEsT0FYTlksRUFXTTtBQUFBO0FBSVYsZUFBZWQsU0FBUyIsImlnbm9yZUxpc3QiOltdfQ==