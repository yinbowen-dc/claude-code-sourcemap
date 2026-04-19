/**
 * PermissionRequestTitle.tsx
 *
 * 【在 Claude Code 系统流程中的位置】
 * 本文件是权限对话框标题区域的渲染组件，位于权限 UI 层级的标题子组件层。
 * 被 PermissionDialog 组件引用，用于统一渲染所有权限请求弹框的标题行和副标题行。
 *
 * 【主要功能】
 * - 渲染粗体彩色标题文字（使用主题色 "permission" 或自定义色）
 * - 可选渲染 WorkerBadge（子 Worker 标识，显示为 "· @name" 灰色文字）
 * - 可选渲染副标题（subtitle）：字符串类型自动包裹在截断文本中，其他类型直接渲染
 * - 通过 React Compiler (_c) 对各子树进行细粒度 memoization 优化
 */
import { c as _c } from "react/compiler-runtime";
import * as React from 'react';
import { Box, Text } from '../../ink.js';
import type { Theme } from '../../utils/theme.js';
import type { WorkerBadgeProps } from './WorkerBadge.js';

// 组件 Props 类型定义
type Props = {
  // 必填：标题文字
  title: string;
  // 可选：副标题，可为字符串或任意 React 节点
  subtitle?: React.ReactNode;
  // 可选：标题颜色，对应主题色键名（默认 "permission"）
  color?: keyof Theme;
  // 可选：Worker 徽标信息，显示在标题右侧
  workerBadge?: WorkerBadgeProps;
};

/**
 * PermissionRequestTitle 组件
 *
 * 权限对话框标题区域，渲染流程：
 * 1. 解构 props，若未传 color 则默认 "permission"
 * 2. 通过 React Compiler 生成的 _c(13) 缓存，对四段子树分别进行依赖比较
 * 3. 第一段：粗体彩色 title 文字节点（依赖 color、title）
 * 4. 第二段：Worker 徽标节点（依赖 workerBadge）— 仅当 workerBadge 存在时渲染
 * 5. 第三段：标题行（title + workerBadge 横排，gap=1）
 * 6. 第四段：副标题节点（依赖 subtitle）— 字符串截断显示，其他节点直传
 * 7. 最终组合为列方向 Box：上方标题行，下方副标题
 *
 * @param t0 - 组件 props（由 React Compiler 重写为单一参数形式）
 * @returns 权限对话框标题区域节点
 */
export function PermissionRequestTitle(t0) {
  // React Compiler 生成的 memoization 缓存，共 13 个槽位
  const $ = _c(13);
  // 解构 props（React Compiler 将解构统一为单参数 t0）
  const {
    title,
    subtitle,
    color: t1,
    workerBadge
  } = t0;
  // 若未传入 color，则默认使用主题色 "permission"
  const color = t1 === undefined ? "permission" : t1;

  // ---- memoization 第一段：粗体彩色 title 文字节点 ----
  // 依赖：color、title
  let t2;
  if ($[0] !== color || $[1] !== title) {
    // 用主题色渲染粗体标题
    t2 = <Text bold={true} color={color}>{title}</Text>;
    $[0] = color;
    $[1] = title;
    $[2] = t2;
  } else {
    // 依赖未变，复用缓存节点
    t2 = $[2];
  }

  // ---- memoization 第二段：Worker 徽标节点 ----
  // 依赖：workerBadge
  let t3;
  if ($[3] !== workerBadge) {
    // 仅当 workerBadge 存在时渲染灰色 "· @name" 文字
    t3 = workerBadge && <Text dimColor={true}>{"\xB7 "}@{workerBadge.name}</Text>;
    $[3] = workerBadge;
    $[4] = t3;
  } else {
    // 依赖未变，复用缓存节点
    t3 = $[4];
  }

  // ---- memoization 第三段：标题行（title + workerBadge 横排）----
  // 依赖：t2（title 节点）、t3（workerBadge 节点）
  let t4;
  if ($[5] !== t2 || $[6] !== t3) {
    // 横排 Box，gap=1，左边粗体标题，右边可选 Worker 徽标
    t4 = <Box flexDirection="row" gap={1}>{t2}{t3}</Box>;
    $[5] = t2;
    $[6] = t3;
    $[7] = t4;
  } else {
    // 依赖未变，复用缓存节点
    t4 = $[7];
  }

  // ---- memoization 第四段：副标题节点 ----
  // 依赖：subtitle
  let t5;
  if ($[8] !== subtitle) {
    // subtitle 非空时渲染：
    // - 字符串类型：用 dimColor + wrap="truncate-start" 截断显示
    // - 其他类型（如 React 元素）：直接透传渲染
    t5 = subtitle != null && (typeof subtitle === "string" ? <Text dimColor={true} wrap="truncate-start">{subtitle}</Text> : subtitle);
    $[8] = subtitle;
    $[9] = t5;
  } else {
    // 依赖未变，复用缓存节点
    t5 = $[9];
  }

  // ---- memoization 第五段：最外层列方向容器 ----
  // 依赖：t4（标题行）、t5（副标题节点）
  let t6;
  if ($[10] !== t4 || $[11] !== t5) {
    // 列方向 Box：上方标题行，下方副标题
    t6 = <Box flexDirection="column">{t4}{t5}</Box>;
    $[10] = t4;
    $[11] = t5;
    $[12] = t6;
  } else {
    // 依赖未变，复用缓存节点
    t6 = $[12];
  }
  return t6;
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJSZWFjdCIsIkJveCIsIlRleHQiLCJUaGVtZSIsIldvcmtlckJhZGdlUHJvcHMiLCJQcm9wcyIsInRpdGxlIiwic3VidGl0bGUiLCJSZWFjdE5vZGUiLCJjb2xvciIsIndvcmtlckJhZGdlIiwiUGVybWlzc2lvblJlcXVlc3RUaXRsZSIsInQwIiwiJCIsIl9jIiwidDEiLCJ1bmRlZmluZWQiLCJ0MiIsInQzIiwibmFtZSIsInQ0IiwidDUiLCJ0NiJdLCJzb3VyY2VzIjpbIlBlcm1pc3Npb25SZXF1ZXN0VGl0bGUudHN4Il0sInNvdXJjZXNDb250ZW50IjpbImltcG9ydCAqIGFzIFJlYWN0IGZyb20gJ3JlYWN0J1xuaW1wb3J0IHsgQm94LCBUZXh0IH0gZnJvbSAnLi4vLi4vaW5rLmpzJ1xuaW1wb3J0IHR5cGUgeyBUaGVtZSB9IGZyb20gJy4uLy4uL3V0aWxzL3RoZW1lLmpzJ1xuaW1wb3J0IHR5cGUgeyBXb3JrZXJCYWRnZVByb3BzIH0gZnJvbSAnLi9Xb3JrZXJCYWRnZS5qcydcblxudHlwZSBQcm9wcyA9IHtcbiAgdGl0bGU6IHN0cmluZ1xuICBzdWJ0aXRsZT86IFJlYWN0LlJlYWN0Tm9kZVxuICBjb2xvcj86IGtleW9mIFRoZW1lXG4gIHdvcmtlckJhZGdlPzogV29ya2VyQmFkZ2VQcm9wc1xufVxuXG5leHBvcnQgZnVuY3Rpb24gUGVybWlzc2lvblJlcXVlc3RUaXRsZSh7XG4gIHRpdGxlLFxuICBzdWJ0aXRsZSxcbiAgY29sb3IgPSAncGVybWlzc2lvbicsXG4gIHdvcmtlckJhZGdlLFxufTogUHJvcHMpOiBSZWFjdC5SZWFjdE5vZGUge1xuICByZXR1cm4gKFxuICAgIDxCb3ggZmxleERpcmVjdGlvbj1cImNvbHVtblwiPlxuICAgICAgPEJveCBmbGV4RGlyZWN0aW9uPVwicm93XCIgZ2FwPXsxfT5cbiAgICAgICAgPFRleHQgYm9sZCBjb2xvcj17Y29sb3J9PlxuICAgICAgICAgIHt0aXRsZX1cbiAgICAgICAgPC9UZXh0PlxuICAgICAgICB7d29ya2VyQmFkZ2UgJiYgKFxuICAgICAgICAgIDxUZXh0IGRpbUNvbG9yPlxuICAgICAgICAgICAgeyfCtyAnfUB7d29ya2VyQmFkZ2UubmFtZX1cbiAgICAgICAgICA8L1RleHQ+XG4gICAgICAgICl9XG4gICAgICA8L0JveD5cbiAgICAgIHtzdWJ0aXRsZSAhPSBudWxsICYmXG4gICAgICAgICh0eXBlb2Ygc3VidGl0bGUgPT09ICdzdHJpbmcnID8gKFxuICAgICAgICAgIDxUZXh0IGRpbUNvbG9yIHdyYXA9XCJ0cnVuY2F0ZS1zdGFydFwiPlxuICAgICAgICAgICAge3N1YnRpdGxlfVxuICAgICAgICAgIDwvVGV4dD5cbiAgICAgICAgKSA6IChcbiAgICAgICAgICBzdWJ0aXRsZVxuICAgICAgICApKX1cbiAgICA8L0JveD5cbiAgKVxufVxuIl0sIm1hcHBpbmdzIjoiO0FBQUEsT0FBTyxLQUFLQSxLQUFLLE1BQU0sT0FBTztBQUM5QixTQUFTQyxHQUFHLEVBQUVDLElBQUksUUFBUSxjQUFjO0FBQ3hDLGNBQWNDLEtBQUssUUFBUSxzQkFBc0I7QUFDakQsY0FBY0MsZ0JBQWdCLFFBQVEsa0JBQWtCO0FBRXhELEtBQUtDLEtBQUssR0FBRztFQUNYQyxLQUFLLEVBQUUsTUFBTTtFQUNiQyxRQUFRLENBQUMsRUFBRVAsS0FBSyxDQUFDUSxTQUFTO0VBQzFCQyxLQUFLLENBQUMsRUFBRSxNQUFNTixLQUFLO0VBQ25CTyxXQUFXLENBQUMsRUFBRU4sZ0JBQWdCO0FBQ2hDLENBQUM7QUFFRCxPQUFPLFNBQUFPLHVCQUFBQyxFQUFBO0VBQUEsTUFBQUMsQ0FBQSxHQUFBQyxFQUFBO0VBQWdDO0lBQUFSLEtBQUE7SUFBQUMsUUFBQTtJQUFBRSxLQUFBLEVBQUFNLEVBQUE7SUFBQUw7RUFBQSxJQUFBRSxFQUt6QjtFQUZOLE1BQUFILEtBQUEsR0FBQU0sRUFBb0IsS0FBcEJDLFNBQW9CLEdBQXBCLFlBQW9CLEdBQXBCRCxFQUFvQjtFQUFBLElBQUFFLEVBQUE7RUFBQSxJQUFBSixDQUFBLFFBQUFKLEtBQUEsSUFBQUksQ0FBQSxRQUFBUCxLQUFBO0lBTWRXLEVBQUEsSUFBQyxJQUFJLENBQUMsSUFBSSxDQUFKLEtBQUcsQ0FBQyxDQUFRUixLQUFLLENBQUxBLE1BQUksQ0FBQyxDQUNwQkgsTUFBSSxDQUNQLEVBRkMsSUFBSSxDQUVFO0lBQUFPLENBQUEsTUFBQUosS0FBQTtJQUFBSSxDQUFBLE1BQUFQLEtBQUE7SUFBQU8sQ0FBQSxNQUFBSSxFQUFBO0VBQUE7SUFBQUEsRUFBQSxHQUFBSixDQUFBO0VBQUE7RUFBQSxJQUFBSyxFQUFBO0VBQUEsSUFBQUwsQ0FBQSxRQUFBSCxXQUFBO0lBQ05RLEVBQUEsR0FBQVIsV0FJQSxJQUhDLENBQUMsSUFBSSxDQUFDLFFBQVEsQ0FBUixLQUFPLENBQUMsQ0FDWCxRQUFHLENBQUUsQ0FBRSxDQUFBQSxXQUFXLENBQUFTLElBQUksQ0FDekIsRUFGQyxJQUFJLENBR047SUFBQU4sQ0FBQSxNQUFBSCxXQUFBO0lBQUFHLENBQUEsTUFBQUssRUFBQTtFQUFBO0lBQUFBLEVBQUEsR0FBQUwsQ0FBQTtFQUFBO0VBQUEsSUFBQU8sRUFBQTtFQUFBLElBQUFQLENBQUEsUUFBQUksRUFBQSxJQUFBSixDQUFBLFFBQUFLLEVBQUE7SUFSSEUsRUFBQSxJQUFDLEdBQUcsQ0FBZSxhQUFLLENBQUwsS0FBSyxDQUFNLEdBQUMsQ0FBRCxHQUFDLENBQzdCLENBQUFILEVBRU0sQ0FDTCxDQUFBQyxFQUlELENBQ0YsRUFUQyxHQUFHLENBU0U7SUFBQUwsQ0FBQSxNQUFBSSxFQUFBO0lBQUFKLENBQUEsTUFBQUssRUFBQTtJQUFBTCxDQUFBLE1BQUFRLEVBQUE7RUFBQTtJQUFBQSxFQUFBLEdBQUFSLENBQUE7RUFBQTtFQUFBLElBQUFTLEVBQUE7RUFBQSxJQUFBVCxDQUFBLFFBQUFOLFFBQUE7SUFDTGMsRUFBQSxHQUFBZCxRQUFRLElBQUksSUFPVCxLQU5ELE9BQU9BLFFBQVEsS0FBSyxRQU1wQixHQUxDLENBQUMsSUFBSSxDQUFDLFFBQVEsQ0FBUixLQUFPLENBQUMsQ0FBTSxJQUFnQixDQUFoQixnQkFBZ0IsQ0FDakNBLFNBQU8sQ0FDVixFQUZDLElBQUksQ0FLTixHQU5BQSxRQU1DO0lBQUFNLENBQUEsTUFBQU4sUUFBQTtJQUFBTSxDQUFBLE1BQUFRLEVBQUE7RUFBQTtJQUFBQSxFQUFBLEdBQUFSLENBQUE7RUFBQTtFQUFBLElBQUFTLEVBQUE7RUFBQSxJQUFBVCxDQUFBLFNBQUFPLEVBQUEsSUFBQVAsQ0FBQSxTQUFBUSxFQUFBO0lBbEJOQyxFQUFBLElBQUMsR0FBRyxDQUFlLGFBQVEsQ0FBUixRQUFRLENBQ3pCLENBQUFGLEVBU0ssQ0FDSixDQUFBQyxFQU9FLENBQ0wsRUFuQkMsR0FBRyxDQW1CRTtJQUFBUixDQUFBLE9BQUFRLEVBQUE7SUFBQVIsQ0FBQSxPQUFBUyxFQUFBO0lBQUFULENBQUEsT0FBQVUsRUFBQTtFQUFBO0lBQUFBLEVBQUEsR0FBQVYsQ0FBQTtFQUFBO0VBQUEsT0FuQk5VLEVBbUJNO0FBQUEiLCJpZ25vcmVMaXN0IjpbXX0=
