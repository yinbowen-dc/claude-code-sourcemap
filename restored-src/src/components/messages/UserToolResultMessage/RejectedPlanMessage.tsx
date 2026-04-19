/**
 * RejectedPlanMessage.tsx
 *
 * 【在 Claude Code 系统流中的位置】
 * 属于工具结果消息渲染层，由 UserToolErrorMessage 路由分发。
 * 当用户拒绝 Claude 的计划时（错误内容以 PLAN_REJECTION_PREFIX 开头），
 * 由 UserToolErrorMessage 提取计划内容后调用本组件，
 * 在终端 UI 中展示被拒绝的计划及静态提示文本。
 *
 * 【主要功能】
 * RejectedPlanMessage：
 * - 渲染固定提示语 "User rejected Claude's plan:"（subtle 颜色）
 * - 将计划内容以 Markdown 格式在圆角 planMode 颜色边框中展示
 * - 整体包裹在 MessageResponse 中，提供连接线样式
 * - overflow="hidden" 确保在 Windows Terminal 中正确渲染
 */
import { c as _c } from "react/compiler-runtime";
import * as React from 'react';
import { Markdown } from 'src/components/Markdown.js';
import { MessageResponse } from 'src/components/MessageResponse.js';
import { Box, Text } from '../../../ink.js';

// 组件 Props 类型定义
type Props = {
  plan: string; // 计划内容（Markdown 格式文本）
};

/**
 * RejectedPlanMessage — 被拒绝计划的渲染组件
 *
 * 流程：
 * 1. 通过 memo_cache_sentinel 一次性初始化静态提示文本节点（$[0]）
 * 2. 当 plan 变更时，重新构建完整 MessageResponse 节点（$[1]/$[2]）
 * 3. 返回包含静态提示语和 Markdown 计划内容的嵌套 Box 布局
 *
 * React 编译器优化：_c(3)
 * - $[0]：静态 Text 节点（memo_cache_sentinel 一次性初始化）
 * - $[1]：plan 依赖缓存键
 * - $[2]：完整 MessageResponse JSX 节点
 */
export function RejectedPlanMessage(t0) {
  // React 编译器注入的缓存数组，共 3 个槽位
  const $ = _c(3);
  const {
    plan
  } = t0;

  // 静态提示文本：一次性初始化（memo_cache_sentinel），组件生命周期内不变
  let t1;
  if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
    // subtle 颜色渲染提示语，告知用户已拒绝 Claude 的计划
    t1 = <Text color="subtle">User rejected Claude's plan:</Text>;
    $[0] = t1;
  } else {
    t1 = $[0];
  }

  // 完整节点：依赖 plan；plan 变化时重新构建
  let t2;
  if ($[1] !== plan) {
    // MessageResponse 提供左侧连接线；Box 纵向排列静态提示和计划内容
    // borderStyle="round" 圆角边框，borderColor="planMode" 使用计划模式颜色
    // paddingX={1} 左右内边距，overflow="hidden" 确保 Windows Terminal 正确渲染
    t2 = <MessageResponse><Box flexDirection="column">{t1}<Box borderStyle="round" borderColor="planMode" paddingX={1} overflow="hidden"><Markdown>{plan}</Markdown></Box></Box></MessageResponse>;
    $[1] = plan;
    $[2] = t2;
  } else {
    t2 = $[2];
  }
  return t2;
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJSZWFjdCIsIk1hcmtkb3duIiwiTWVzc2FnZVJlc3BvbnNlIiwiQm94IiwiVGV4dCIsIlByb3BzIiwicGxhbiIsIlJlamVjdGVkUGxhbk1lc3NhZ2UiLCJ0MCIsIiQiLCJfYyIsInQxIiwiU3ltYm9sIiwiZm9yIiwidDIiXSwic291cmNlcyI6WyJSZWplY3RlZFBsYW5NZXNzYWdlLnRzeCJdLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgKiBhcyBSZWFjdCBmcm9tICdyZWFjdCdcbmltcG9ydCB7IE1hcmtkb3duIH0gZnJvbSAnc3JjL2NvbXBvbmVudHMvTWFya2Rvd24uanMnXG5pbXBvcnQgeyBNZXNzYWdlUmVzcG9uc2UgfSBmcm9tICdzcmMvY29tcG9uZW50cy9NZXNzYWdlUmVzcG9uc2UuanMnXG5pbXBvcnQgeyBCb3gsIFRleHQgfSBmcm9tICcuLi8uLi8uLi9pbmsuanMnXG5cbnR5cGUgUHJvcHMgPSB7XG4gIHBsYW46IHN0cmluZ1xufVxuXG5leHBvcnQgZnVuY3Rpb24gUmVqZWN0ZWRQbGFuTWVzc2FnZSh7IHBsYW4gfTogUHJvcHMpOiBSZWFjdC5SZWFjdE5vZGUge1xuICByZXR1cm4gKFxuICAgIDxNZXNzYWdlUmVzcG9uc2U+XG4gICAgICA8Qm94IGZsZXhEaXJlY3Rpb249XCJjb2x1bW5cIj5cbiAgICAgICAgPFRleHQgY29sb3I9XCJzdWJ0bGVcIj5Vc2VyIHJlamVjdGVkIENsYXVkZSZhcG9zO3MgcGxhbjo8L1RleHQ+XG4gICAgICAgIDxCb3hcbiAgICAgICAgICBib3JkZXJTdHlsZT1cInJvdW5kXCJcbiAgICAgICAgICBib3JkZXJDb2xvcj1cInBsYW5Nb2RlXCJcbiAgICAgICAgICBwYWRkaW5nWD17MX1cbiAgICAgICAgICAvLyBOZWNlc3NhcnkgZm9yIFdpbmRvd3MgVGVybWluYWwgdG8gcmVuZGVyIHByb3Blcmx5XG4gICAgICAgICAgb3ZlcmZsb3c9XCJoaWRkZW5cIlxuICAgICAgICA+XG4gICAgICAgICAgPE1hcmtkb3duPntwbGFufTwvTWFya2Rvd24+XG4gICAgICAgIDwvQm94PlxuICAgICAgPC9Cb3g+XG4gICAgPC9NZXNzYWdlUmVzcG9uc2U+XG4gIClcbn1cbiJdLCJtYXBwaW5ncyI6IjtBQUFBLE9BQU8sS0FBS0EsS0FBSyxNQUFNLE9BQU87QUFDOUIsU0FBU0MsUUFBUSxRQUFRLDRCQUE0QjtBQUNyRCxTQUFTQyxlQUFlLFFBQVEsbUNBQW1DO0FBQ25FLFNBQVNDLEdBQUcsRUFBRUMsSUFBSSxRQUFRLGlCQUFpQjtBQUUzQyxLQUFLQyxLQUFLLEdBQUc7RUFDWEMsSUFBSSxFQUFFLE1BQU07QUFDZCxDQUFDO0FBRUQsT0FBTyxTQUFBQyxvQkFBQUMsRUFBQTtFQUFBLE1BQUFDLENBQUEsR0FBQUMsRUFBQTtFQUE2QjtJQUFBSjtFQUFBLElBQUFFLEVBQWU7RUFBQSxJQUFBRyxFQUFBO0VBQUEsSUFBQUYsQ0FBQSxRQUFBRyxNQUFBLENBQUFDLEdBQUE7SUFJM0NGLEVBQUEsSUFBQyxJQUFJLENBQU8sS0FBUSxDQUFSLFFBQVEsQ0FBQyw0QkFBaUMsRUFBckQsSUFBSSxDQUF3RDtJQUFBRixDQUFBLE1BQUFFLEVBQUE7RUFBQTtJQUFBQSxFQUFBLEdBQUFGLENBQUE7RUFBQTtFQUFBLElBQUFLLEVBQUE7RUFBQSxJQUFBTCxDQUFBLFFBQUFILElBQUE7SUFGakVRLEVBQUEsSUFBQyxlQUFlLENBQ2QsQ0FBQyxHQUFHLENBQWUsYUFBUSxDQUFSLFFBQVEsQ0FDekIsQ0FBQUgsRUFBNEQsQ0FDNUQsQ0FBQyxHQUFHLENBQ1UsV0FBTyxDQUFQLE9BQU8sQ0FDUCxXQUFVLENBQVYsVUFBVSxDQUNaLFFBQUMsQ0FBRCxHQUFDLENBRUYsUUFBUSxDQUFSLFFBQVEsQ0FFakIsQ0FBQyxRQUFRLENBQUVMLEtBQUcsQ0FBRSxFQUFmLFFBQVEsQ0FDWCxFQVJDLEdBQUcsQ0FTTixFQVhDLEdBQUcsQ0FZTixFQWJDLGVBQWUsQ0FhRTtJQUFBRyxDQUFBLE1BQUFILElBQUE7SUFBQUcsQ0FBQSxNQUFBSyxFQUFBO0VBQUE7SUFBQUEsRUFBQSxHQUFBTCxDQUFBO0VBQUE7RUFBQSxPQWJsQkssRUFha0I7QUFBQSIsImlnbm9yZUxpc3QiOltdfQ==
