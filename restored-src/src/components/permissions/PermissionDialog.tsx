/**
 * PermissionDialog.tsx
 *
 * 【在 Claude Code 系统流程中的位置】
 * 本文件是权限请求 UI 的基础布局容器组件，位于权限系统的最底层视觉框架层。
 * 所有具体的权限对话框（BashPermissionRequest、SandboxPermissionRequest、
 * SedEditPermissionRequest 等）都依赖此组件来提供统一的圆角边框外壳和标题区域。
 *
 * 【主要功能】
 * - 渲染带有圆角顶部边框（round 风格，仅上边框）的 Ink.js Box 容器
 * - 在标题区域并排显示 PermissionRequestTitle（左）和 titleRight 插槽（右）
 * - 支持通过 color 属性控制边框颜色（默认使用主题中的 "permission" 色）
 * - 通过 React Compiler (_c) 对各子树进行细粒度 memoization 优化
 */
import { c as _c } from "react/compiler-runtime";
import * as React from 'react';
import { Box } from '../../ink.js';
import type { Theme } from '../../utils/theme.js';
import { PermissionRequestTitle } from './PermissionRequestTitle.js';
import type { WorkerBadgeProps } from './WorkerBadge.js';
type Props = {
  title: string;
  subtitle?: React.ReactNode;
  color?: keyof Theme;
  titleColor?: keyof Theme;
  innerPaddingX?: number;
  workerBadge?: WorkerBadgeProps;
  titleRight?: React.ReactNode;
  children: React.ReactNode;
};
/**
 * PermissionDialog 组件
 *
 * 所有权限请求弹框的通用外壳。渲染流程：
 * 1. 解构 props，将缺省的 color 设为 "permission"，innerPaddingX 设为 1
 * 2. 借助 React Compiler 生成的 _c(15) 缓存，对三段子树（标题行、titleRight 行、内容区）
 *    分别进行依赖比较，仅在依赖变化时重新创建对应 JSX 节点
 * 3. 最终组合成一个顶部圆角边框 Box，上方是标题行，下方是子内容区
 *
 * @param t0 - 组件 props（由 React Compiler 重写为单一参数形式）
 * @returns 带圆角顶部边框的权限对话框外壳节点
 */
export function PermissionDialog(t0) {
  // React Compiler 生成的 memoization 缓存，共 15 个槽位
  const $ = _c(15);
  // 解构 props（React Compiler 将解构统一为单参数 t0）
  const {
    title,
    subtitle,
    color: t1,
    titleColor,
    innerPaddingX: t2,
    workerBadge,
    titleRight,
    children
  } = t0;
  // 若未传入 color，则默认使用主题色 "permission"
  const color = t1 === undefined ? "permission" : t1;
  // 若未传入 innerPaddingX，则默认左右内边距为 1
  const innerPaddingX = t2 === undefined ? 1 : t2;

  // ---- memoization 第一段：PermissionRequestTitle 节点 ----
  // 依赖：subtitle、title、titleColor、workerBadge
  let t3;
  if ($[0] !== subtitle || $[1] !== title || $[2] !== titleColor || $[3] !== workerBadge) {
    // 任意依赖变化时重新创建标题节点
    t3 = <PermissionRequestTitle title={title} subtitle={subtitle} color={titleColor} workerBadge={workerBadge} />;
    $[0] = subtitle;
    $[1] = title;
    $[2] = titleColor;
    $[3] = workerBadge;
    $[4] = t3;
  } else {
    // 依赖未变，复用缓存节点
    t3 = $[4];
  }

  // ---- memoization 第二段：标题行（标题 + 右侧插槽）----
  // 依赖：t3（标题节点）、titleRight
  let t4;
  if ($[5] !== t3 || $[6] !== titleRight) {
    // 标题行：左边 PermissionRequestTitle，右边 titleRight（可选，如调试按钮）
    t4 = <Box paddingX={1} flexDirection="column"><Box justifyContent="space-between">{t3}{titleRight}</Box></Box>;
    $[5] = t3;
    $[6] = titleRight;
    $[7] = t4;
  } else {
    t4 = $[7];
  }

  // ---- memoization 第三段：内容区 ----
  // 依赖：children、innerPaddingX
  let t5;
  if ($[8] !== children || $[9] !== innerPaddingX) {
    // 子内容区，左右内边距由 innerPaddingX 控制（默认 1）
    t5 = <Box flexDirection="column" paddingX={innerPaddingX}>{children}</Box>;
    $[8] = children;
    $[9] = innerPaddingX;
    $[10] = t5;
  } else {
    t5 = $[10];
  }

  // ---- memoization 第四段：最外层容器 ----
  // 依赖：color、t4（标题行）、t5（内容区）
  let t6;
  if ($[11] !== color || $[12] !== t4 || $[13] !== t5) {
    // 圆角样式只保留上边框，左/右/下边框均隐藏，顶部留 1 行间距
    t6 = <Box flexDirection="column" borderStyle="round" borderColor={color} borderLeft={false} borderRight={false} borderBottom={false} marginTop={1}>{t4}{t5}</Box>;
    $[11] = color;
    $[12] = t4;
    $[13] = t5;
    $[14] = t6;
  } else {
    t6 = $[14];
  }
  return t6;
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJSZWFjdCIsIkJveCIsIlRoZW1lIiwiUGVybWlzc2lvblJlcXVlc3RUaXRsZSIsIldvcmtlckJhZGdlUHJvcHMiLCJQcm9wcyIsInRpdGxlIiwic3VidGl0bGUiLCJSZWFjdE5vZGUiLCJjb2xvciIsInRpdGxlQ29sb3IiLCJpbm5lclBhZGRpbmdYIiwid29ya2VyQmFkZ2UiLCJ0aXRsZVJpZ2h0IiwiY2hpbGRyZW4iLCJQZXJtaXNzaW9uRGlhbG9nIiwidDAiLCIkIiwiX2MiLCJ0MSIsInQyIiwidW5kZWZpbmVkIiwidDMiLCJ0NCIsInQ1IiwidDYiXSwic291cmNlcyI6WyJQZXJtaXNzaW9uRGlhbG9nLnRzeCJdLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgKiBhcyBSZWFjdCBmcm9tICdyZWFjdCdcbmltcG9ydCB7IEJveCB9IGZyb20gJy4uLy4uL2luay5qcydcbmltcG9ydCB0eXBlIHsgVGhlbWUgfSBmcm9tICcuLi8uLi91dGlscy90aGVtZS5qcydcbmltcG9ydCB7IFBlcm1pc3Npb25SZXF1ZXN0VGl0bGUgfSBmcm9tICcuL1Blcm1pc3Npb25SZXF1ZXN0VGl0bGUuanMnXG5pbXBvcnQgdHlwZSB7IFdvcmtlckJhZGdlUHJvcHMgfSBmcm9tICcuL1dvcmtlckJhZGdlLmpzJ1xuXG50eXBlIFByb3BzID0ge1xuICB0aXRsZTogc3RyaW5nXG4gIHN1YnRpdGxlPzogUmVhY3QuUmVhY3ROb2RlXG4gIGNvbG9yPzoga2V5b2YgVGhlbWVcbiAgdGl0bGVDb2xvcj86IGtleW9mIFRoZW1lXG4gIGlubmVyUGFkZGluZ1g/OiBudW1iZXJcbiAgd29ya2VyQmFkZ2U/OiBXb3JrZXJCYWRnZVByb3BzXG4gIHRpdGxlUmlnaHQ/OiBSZWFjdC5SZWFjdE5vZGVcbiAgY2hpbGRyZW46IFJlYWN0LlJlYWN0Tm9kZVxufVxuXG5leHBvcnQgZnVuY3Rpb24gUGVybWlzc2lvbkRpYWxvZyh7XG4gIHRpdGxlLFxuICBzdWJ0aXRsZSxcbiAgY29sb3IgPSAncGVybWlzc2lvbicsXG4gIHRpdGxlQ29sb3IsXG4gIGlubmVyUGFkZGluZ1ggPSAxLFxuICB3b3JrZXJCYWRnZSxcbiAgdGl0bGVSaWdodCxcbiAgY2hpbGRyZW4sXG59OiBQcm9wcyk6IFJlYWN0LlJlYWN0Tm9kZSB7XG4gIHJldHVybiAoXG4gICAgPEJveFxuICAgICAgZmxleERpcmVjdGlvbj1cImNvbHVtblwiXG4gICAgICBib3JkZXJTdHlsZT1cInJvdW5kXCJcbiAgICAgIGJvcmRlckNvbG9yPXtjb2xvcn1cbiAgICAgIGJvcmRlckxlZnQ9e2ZhbHNlfVxuICAgICAgYm9yZGVyUmlnaHQ9e2ZhbHNlfVxuICAgICAgYm9yZGVyQm90dG9tPXtmYWxzZX1cbiAgICAgIG1hcmdpblRvcD17MX1cbiAgICA+XG4gICAgICA8Qm94IHBhZGRpbmdYPXsxfSBmbGV4RGlyZWN0aW9uPVwiY29sdW1uXCI+XG4gICAgICAgIDxCb3gganVzdGlmeUNvbnRlbnQ9XCJzcGFjZS1iZXR3ZWVuXCI+XG4gICAgICAgICAgPFBlcm1pc3Npb25SZXF1ZXN0VGl0bGVcbiAgICAgICAgICAgIHRpdGxlPXt0aXRsZX1cbiAgICAgICAgICAgIHN1YnRpdGxlPXtzdWJ0aXRsZX1cbiAgICAgICAgICAgIGNvbG9yPXt0aXRsZUNvbG9yfVxuICAgICAgICAgICAgd29ya2VyQmFkZ2U9e3dvcmtlckJhZGdlfVxuICAgICAgICAgIC8+XG4gICAgICAgICAge3RpdGxlUmlnaHR9XG4gICAgICAgIDwvQm94PlxuICAgICAgPC9Cb3g+XG4gICAgICA8Qm94IGZsZXhEaXJlY3Rpb249XCJjb2x1bW5cIiBwYWRkaW5nWD17aW5uZXJQYWRkaW5nWH0+XG4gICAgICAgIHtjaGlsZHJlbn1cbiAgICAgIDwvQm94PlxuICAgIDwvQm94PlxuICApXG59XG4iXSwibWFwcGluZ3MiOiI7QUFBQSxPQUFPLEtBQUtBLEtBQUssTUFBTSxPQUFPO0FBQzlCLFNBQVNDLEdBQUcsUUFBUSxjQUFjO0FBQ2xDLGNBQWNDLEtBQUssUUFBUSxzQkFBc0I7QUFDakQsU0FBU0Ms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