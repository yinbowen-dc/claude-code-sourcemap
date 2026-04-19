/**
 * RejectedToolUseMessage.tsx
 *
 * 【在 Claude Code 系统流中的位置】
 * 属于工具结果消息渲染层，由 UserToolErrorMessage 路由分发。
 * 当工具调用被用户以带原因方式拒绝时（错误内容以 REJECT_MESSAGE_WITH_REASON_PREFIX 开头），
 * 由 UserToolErrorMessage 调用本组件，
 * 在终端 UI 中展示简洁的 "Tool use rejected" 提示。
 *
 * 【主要功能】
 * RejectedToolUseMessage：
 * - 无 Props，纯静态展示组件
 * - 在 MessageResponse 容器中显示暗色 "Tool use rejected" 文本
 * - 整体节点通过 memo_cache_sentinel 一次性初始化，终身复用
 */
import { c as _c } from "react/compiler-runtime";
import * as React from 'react';
import { Text } from '../../../ink.js';
import { MessageResponse } from '../../MessageResponse.js';

/**
 * RejectedToolUseMessage — 工具调用被拒绝的渲染组件
 *
 * 流程：
 * 1. 通过 memo_cache_sentinel 一次性初始化整个节点（$[0]）
 * 2. 后续渲染直接返回缓存节点，无需重建
 *
 * React 编译器优化：_c(1)
 * - $[0]：完整 MessageResponse+Text 节点（memo_cache_sentinel 一次性初始化）
 *
 * 注：无 Props，组件输出完全静态，仅在首次渲染时构建 JSX。
 */
export function RejectedToolUseMessage() {
  // React 编译器注入的缓存数组，共 1 个槽位
  const $ = _c(1);

  // 整体节点：一次性初始化（memo_cache_sentinel）
  let t0;
  if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
    // MessageResponse 提供左侧连接线；高度固定为 1 行；暗色文本显示拒绝提示
    t0 = <MessageResponse height={1}><Text dimColor={true}>Tool use rejected</Text></MessageResponse>;
    $[0] = t0;
  } else {
    t0 = $[0];
  }
  return t0;
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJSZWFjdCIsIlRleHQiLCJNZXNzYWdlUmVzcG9uc2UiLCJSZWplY3RlZFRvb2xVc2VNZXNzYWdlIiwiJCIsIl9jIiwidDAiLCJTeW1ib2wiLCJmb3IiXSwic291cmNlcyI6WyJSZWplY3RlZFRvb2xVc2VNZXNzYWdlLnRzeCJdLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgKiBhcyBSZWFjdCBmcm9tICdyZWFjdCdcbmltcG9ydCB7IFRleHQgfSBmcm9tICcuLi8uLi8uLi9pbmsuanMnXG5pbXBvcnQgeyBNZXNzYWdlUmVzcG9uc2UgfSBmcm9tICcuLi8uLi9NZXNzYWdlUmVzcG9uc2UuanMnXG5cbmV4cG9ydCBmdW5jdGlvbiBSZWplY3RlZFRvb2xVc2VNZXNzYWdlKCk6IFJlYWN0LlJlYWN0Tm9kZSB7XG4gIHJldHVybiAoXG4gICAgPE1lc3NhZ2VSZXNwb25zZSBoZWlnaHQ9ezF9PlxuICAgICAgPFRleHQgZGltQ29sb3I+VG9vbCB1c2UgcmVqZWN0ZWQ8L1RleHQ+XG4gICAgPC9NZXNzYWdlUmVzcG9uc2U+XG4gIClcbn1cbiJdLCJtYXBwaW5ncyI6IjtBQUFBLE9BQU8sS0FBS0EsS0FBSyxNQUFNLE9BQU87QUFDOUIsU0FBU0MsSUFBSSxRQUFRLGlCQUFpQjtBQUN0QyxTQUFTQyxlQUFlLFFBQVEsMEJBQTBCO0FBRTFELE9BQU8sU0FBQUMsdUJBQUE7RUFBQSxNQUFBQyxDQUFBLEdBQUFDLEVBQUE7RUFBQSxJQUFBQyxFQUFBO0VBQUEsSUFBQUYsQ0FBQSxRQUFBRyxNQUFBLENBQUFDLEdBQUE7SUFFSEYsRUFBQSxJQUFDLGVBQWUsQ0FBUyxNQUFDLENBQUQsR0FBQyxDQUN4QixDQUFDLElBQUksQ0FBQyxRQUFRLENBQVIsS0FBTyxDQUFDLENBQUMsaUJBQWlCLEVBQS9CLElBQUksQ0FDUCxFQUZDLGVBQWUsQ0FFRTtJQUFBRixDQUFBLE1BQUFFLEVBQUE7RUFBQTtJQUFBQSxFQUFBLEdBQUFGLENBQUE7RUFBQTtFQUFBLE9BRmxCRSxFQUVrQjtBQUFBIiwiaWdub3JlTGlzdCI6W119
