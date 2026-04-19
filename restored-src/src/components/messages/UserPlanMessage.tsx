/**
 * UserPlanMessage.tsx
 *
 * 【在 Claude Code 系统流中的位置】
 * 属于用户消息渲染层，由 UserTextMessage 路由分发。
 * 当系统检测到计划内容（planContent）时调用本组件，
 * 在终端 UI 中以圆角边框样式渲染 Claude 的实现计划。
 *
 * 【主要功能】
 * UserPlanMessage：
 * - 在圆角边框（borderStyle="round"）+ planMode 颜色边框的 Box 中渲染计划内容
 * - 顶部显示固定的粗体标题 "Plan to implement"（planMode 颜色）
 * - 计划正文通过 Markdown 组件渲染，支持富文本格式
 * - 通过 addMargin 控制顶部间距（新消息轮次起始时为 1，否则为 0）
 *
 * 【依赖】
 * - react/compiler-runtime: React 编译器运行时，提供 _c(N) 缓存数组
 * - ink: 终端 UI 框架，Box/Text 组件
 * - components/Markdown: Markdown 渲染组件
 */
import { c as _c } from "react/compiler-runtime";
import * as React from 'react';
import { Box, Text } from '../../ink.js';
import { Markdown } from '../Markdown.js';

// 组件 Props 类型定义
type Props = {
  addMargin: boolean;    // 是否在顶部添加 marginTop=1 的间距
  planContent: string;   // Markdown 格式的计划内容文本
};

/**
 * UserPlanMessage — 计划内容渲染组件
 *
 * 流程：
 * 1. 根据 addMargin 计算顶部间距（1 或 0）
 * 2. 渲染静态标题行（"Plan to implement"），用 memo_cache_sentinel 一次性初始化缓存
 * 3. 渲染 Markdown 格式的计划内容（依赖 planContent）
 * 4. 将标题和内容包裹在圆角边框 Box 中，顶部间距和水平内边距各为 1
 *
 * React 编译器优化：_c(6)，缓存静态标题节点（$[0]）、Markdown 节点（$[1]/$[2]）
 * 和最终外层 Box 节点（$[3]/$[4]/$[5]）
 */
export function UserPlanMessage(t0) {
  // React 编译器注入的缓存数组，共 6 个槽位
  const $ = _c(6);
  const {
    addMargin,
    planContent
  } = t0;

  // 根据 addMargin 计算顶部间距：新消息轮次为 1，紧随消息为 0
  const t1 = addMargin ? 1 : 0;

  // 静态标题行：固定文本，用 memo_cache_sentinel 一次性初始化（$[0]）
  let t2;
  if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
    // "Plan to implement" 以粗体、planMode 颜色渲染，底部有 1 单位间距
    t2 = <Box marginBottom={1}><Text bold={true} color="planMode">Plan to implement</Text></Box>;
    $[0] = t2;
  } else {
    t2 = $[0];
  }

  // Markdown 格式的计划内容节点；依赖 planContent
  let t3;
  if ($[1] !== planContent) {
    t3 = <Markdown>{planContent}</Markdown>;
    $[1] = planContent;
    $[2] = t3;
  } else {
    t3 = $[2];
  }

  // 最终外层容器：圆角边框 Box，依赖 t1（顶部间距）和 t3（Markdown 内容）
  let t4;
  if ($[3] !== t1 || $[4] !== t3) {
    // borderStyle="round" 显示圆角边框，borderColor="planMode" 使用计划模式颜色
    // paddingX={1} 提供左右内边距，marginTop 由 t1 决定
    t4 = <Box flexDirection="column" borderStyle="round" borderColor="planMode" marginTop={t1} paddingX={1}>{t2}{t3}</Box>;
    $[3] = t1;
    $[4] = t3;
    $[5] = t4;
  } else {
    t4 = $[5];
  }
  return t4;
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJSZWFjdCIsIkJveCIsIlRleHQiLCJNYXJrZG93biIsIlByb3BzIiwiYWRkTWFyZ2luIiwicGxhbkNvbnRlbnQiLCJVc2VyUGxhbk1lc3NhZ2UiLCJ0MCIsIiQiLCJfYyIsInQxIiwidDIiLCJTeW1ib2wiLCJmb3IiLCJ0MyIsInQ0Il0sInNvdXJjZXMiOlsiVXNlclBsYW5NZXNzYWdlLnRzeCJdLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgKiBhcyBSZWFjdCBmcm9tICdyZWFjdCdcbmltcG9ydCB7IEJveCwgVGV4dCB9IGZyb20gJy4uLy4uL2luay5qcydcbmltcG9ydCB7IE1hcmtkb3duIH0gZnJvbSAnLi4vTWFya2Rvd24uanMnXG5cbnR5cGUgUHJvcHMgPSB7XG4gIGFkZE1hcmdpbjogYm9vbGVhblxuICBwbGFuQ29udGVudDogc3RyaW5nXG59XG5cbmV4cG9ydCBmdW5jdGlvbiBVc2VyUGxhbk1lc3NhZ2Uoe1xuICBhZGRNYXJnaW4sXG4gIHBsYW5Db250ZW50LFxufTogUHJvcHMpOiBSZWFjdC5SZWFjdE5vZGUge1xuICByZXR1cm4gKFxuICAgIDxCb3hcbiAgICAgIGZsZXhEaXJlY3Rpb249XCJjb2x1bW5cIlxuICAgICAgYm9yZGVyU3R5bGU9XCJyb3VuZFwiXG4gICAgICBib3JkZXJDb2xvcj1cInBsYW5Nb2RlXCJcbiAgICAgIG1hcmdpblRvcD17YWRkTWFyZ2luID8gMSA6IDB9XG4gICAgICBwYWRkaW5nWD17MX1cbiAgICA+XG4gICAgICA8Qm94IG1hcmdpbkJvdHRvbT17MX0+XG4gICAgICAgIDxUZXh0IGJvbGQgY29sb3I9XCJwbGFuTW9kZVwiPlxuICAgICAgICAgIFBsYW4gdG8gaW1wbGVtZW50XG4gICAgICAgIDwvVGV4dD5cbiAgICAgIDwvQm94PlxuICAgICAgPE1hcmtkb3duPntwbGFuQ29udGVudH08L01hcmtkb3duPlxuICAgIDwvQm94PlxuICApXG59XG4iXSwibWFwcGluZ3MiOiI7QUFBQSxPQUFPLEtBQUtBLEtBQUssTUFBTSxPQUFPO0FBQzlCLFNBQVNDLEdBQUcsRUFBRUMsSUFBSSxRQUFRLGNBQWM7QUFDeEMsU0FBU0MsUUFBUSxRQUFRLGdCQUFnQjtBQUV6QyxLQUFLQyxLQUFLLEdBQUc7RUFDWEMsU0FBUyxFQUFFLE9BQU87RUFDbEJDLFdBQVcsRUFBRSxNQUFNO0FBQ3JCLENBQUM7QUFFRCxPQUFPLFNBQUFDLGdCQUFBQyxFQUFBO0VBQUEsTUFBQUMsQ0FBQSxHQUFBQyxFQUFBO0VBQXlCO0lBQUFMLFNBQUE7SUFBQUM7RUFBQSxJQUFBRSxFQUd4QjtFQU1TLE1BQUFHLEVBQUEsR0FBQU4sU0FBUyxHQUFULENBQWlCLEdBQWpCLENBQWlCO0VBQUEsSUFBQU8sRUFBQTtFQUFBLElBQUFILENBQUEsUUFBQUksTUFBQSxDQUFBQyxHQUFBO0lBRzVCRixFQUFBLElBQUMsR0FBRyxDQUFlLFlBQUMsQ0FBRCxHQUFDLENBQ2xCLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBSixLQUFHLENBQUMsQ0FBTyxLQUFVLENBQVYsVUFBVSxDQUFDLGlCQUU1QixFQUZDLElBQUksQ0FHUCxFQUpDLEdBQUcsQ0FJRTtJQUFBSCxDQUFBLE1BQUFHLEVBQUE7RUFBQTtJQUFBQSxFQUFBLEdBQUFILENBQUE7RUFBQTtFQUFBLElBQUFNLEVBQUE7RUFBQSxJQUFBTixDQUFBLFFBQUFILFdBQUE7SUFDTlMsRUFBQSxJQUFDLFFBQVEsQ0FBRVQsWUFBVSxDQUFFLEVBQXRCLFFBQVEsQ0FBeUI7SUFBQUcsQ0FBQSxNQUFBSCxXQUFBO0lBQUFHLENBQUEsTUFBQU0sRUFBQTtFQUFBO0lBQUFBLEVBQUEsR0FBQU4sQ0FBQTtFQUFBO0VBQUEsSUFBQU8sRUFBQTtFQUFBLElBQUFQLENBQUEsUUFBQUUsRUFBQSxJQUFBRixDQUFBLFFBQUFNLEVBQUE7SUFacENDLEVBQUEsSUFBQyxHQUFHLENBQ1ksYUFBUSxDQUFSLFFBQVEsQ0FDVixXQUFPLENBQVAsT0FBTyxDQUNQLFdBQVUsQ0FBVixVQUFVLENBQ1gsU0FBaUIsQ0FBakIsQ0FBQUwsRUFBZ0IsQ0FBQyxDQUNsQixRQUFDLENBQUQsR0FBQyxDQUVYLENBQUFDLEVBSUssQ0FDTCxDQUFBRyxFQUFpQyxDQUNuQyxFQWJDLEdBQUcsQ0FhRTtJQUFBTixDQUFBLE1BQUFFFLEVBQUE7SUFBQUYsQ0FBQSxNQUFBTSxFQUFBO0lBQUFOLENBQUEsTUFBQU8sRUFBQTtFQUFBO0lBQUFBLEVBQUEsR0FBQVAsQ0FBQTtFQUFBO0VBQUEsT0FiTk8sRUFhTTtBQUFBIiwiaWdub3JlTGlzdCI6W119
