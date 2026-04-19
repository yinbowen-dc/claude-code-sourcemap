/**
 * UserMemoryInputMessage.tsx
 *
 * 【在 Claude Code 系统流中的位置】
 * 属于用户消息渲染层，由 UserTextMessage 路由分发。
 * 当系统检测到 <user-memory-input> XML 标签时（即用户请求保存记忆条目），
 * 调用本组件在终端 UI 中以高亮背景色展示记忆内容，并显示随机确认语。
 *
 * 【主要功能】
 * 1. getSavingMessage：随机返回一条保存确认语（"Got it." / "Good to know." / "Noted."）
 * 2. UserMemoryInputMessage：
 *    - 从文本中提取 <user-memory-input> 标签内容（input）
 *    - 一次性初始化随机确认语（savingText），组件生命周期内保持不变
 *    - 以 "#" 徽标 + 高亮背景色文本展示记忆条目
 *    - 在其下方的 MessageResponse 中显示暗色确认语
 *    - 通过 addMargin 控制顶部间距（新消息轮次起始时为 1，否则为 0）
 *
 * 【依赖】
 * - react/compiler-runtime: React 编译器运行时，提供 _c(N) 缓存数组
 * - lodash-es/sample: 从数组中随机取一个元素
 * - react: useMemo（已被编译器优化替换）
 * - ink: 终端 UI 框架，Box/Text 组件
 * - utils/messages: extractTag() 从 XML 字符串提取特定标签内容
 * - components/MessageResponse: 提供与上方消息紧邻的样式容器
 */
import { c as _c } from "react/compiler-runtime";
import sample from 'lodash-es/sample.js';
import * as React from 'react';
import { useMemo } from 'react';
import { Box, Text } from '../../ink.js';
import { extractTag } from '../../utils/messages.js';
import { MessageResponse } from '../MessageResponse.js';

/**
 * getSavingMessage — 生成随机保存确认语
 *
 * 每次调用随机返回以下三条中的一条：
 * - "Got it."（明白了）
 * - "Good to know."（知道了）
 * - "Noted."（已记录）
 *
 * 由 React 编译器的 memo_cache_sentinel 机制保证在组件生命周期内只调用一次。
 */
function getSavingMessage(): string {
  return sample(['Got it.', 'Good to know.', 'Noted.']);
}

// 组件 Props 类型定义
type Props = {
  addMargin: boolean; // 是否在顶部添加 marginTop=1 的间距
  text: string;       // 包含 <user-memory-input> 标签的完整文本
};

/**
 * UserMemoryInputMessage — 记忆输入渲染组件
 *
 * 流程：
 * 1. 提取 <user-memory-input> 标签内容，存为 input
 * 2. 通过 memo_cache_sentinel 一次性初始化 savingText（随机确认语）
 * 3. input 为空则返回 null（不渲染任何内容）
 * 4. 构建记忆条目显示行：以特殊颜色的 "#" 为徽标，高亮背景色文本展示 input
 * 5. 构建确认语行：在 MessageResponse 中显示暗色 savingText
 * 6. 将两行包裹在纵向 Box 中，根据 addMargin 设置顶部间距
 *
 * React 编译器优化：_c(10)，缓存 input 解析结果、savingText、各 JSX 节点
 */
export function UserMemoryInputMessage(t0) {
  // React 编译器注入的缓存数组，共 10 个槽位
  const $ = _c(10);
  const {
    text,
    addMargin
  } = t0;

  // 提取 <user-memory-input> 标签内容；依赖 text
  let t1;
  if ($[0] !== text) {
    t1 = extractTag(text, "user-memory-input");
    $[0] = text;
    $[1] = t1;
  } else {
    t1 = $[1];
  }
  const input = t1;

  // 一次性初始化随机确认语（memo_cache_sentinel 表示槽位从未被写入）
  let t2;
  if ($[2] === Symbol.for("react.memo_cache_sentinel")) {
    t2 = getSavingMessage();
    $[2] = t2;
  } else {
    t2 = $[2];
  }
  const savingText = t2;

  // input 为空则不渲染（标签内容不存在）
  if (!input) {
    return null;
  }

  // 根据 addMargin 计算顶部间距值：新消息轮次时为 1，紧随消息时为 0
  const t3 = addMargin ? 1 : 0;

  // "#" 徽标：静态节点，用 memo_cache_sentinel 做一次性初始化（$[3]）
  let t4;
  if ($[3] === Symbol.for("react.memo_cache_sentinel")) {
    // 使用 "remember" 颜色和 "memoryBackgroundColor" 背景色渲染 # 符号
    t4 = <Text color="remember" backgroundColor="memoryBackgroundColor">#</Text>;
    $[3] = t4;
  } else {
    t4 = $[3];
  }

  // 记忆条目行：徽标 + 高亮背景色文本内容；依赖 input
  let t5;
  if ($[4] !== input) {
    t5 = <Box>{t4}<Text backgroundColor="memoryBackgroundColor" color="text">{" "}{input}{" "}</Text></Box>;
    $[4] = input;
    $[5] = t5;
  } else {
    t5 = $[5];
  }

  // 确认语行：MessageResponse 包裹的暗色文本；savingText 是一次性生成的，用 memo_cache_sentinel 缓存（$[6]）
  let t6;
  if ($[6] === Symbol.for("react.memo_cache_sentinel")) {
    t6 = <MessageResponse height={1}><Text dimColor={true}>{savingText}</Text></MessageResponse>;
    $[6] = t6;
  } else {
    t6 = $[6];
  }

  // 组合两行：纵向排列，宽度 100%，顶部间距由 t3 决定；依赖 t3 和 t5
  let t7;
  if ($[7] !== t3 || $[8] !== t5) {
    t7 = <Box flexDirection="column" marginTop={t3} width="100%">{t5}{t6}</Box>;
    $[7] = t3;
    $[8] = t5;
    $[9] = t7;
  } else {
    t7 = $[9];
  }
  return t7;
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJzYW1wbGUiLCJSZWFjdCIsInVzZU1lbW8iLCJCb3giLCJUZXh0IiwiZXh0cmFjdFRhZyIsIk1lc3NhZ2VSZXNwb25zZSIsImdldFNhdmluZ01lc3NhZ2UiLCJQcm9wcyIsImFkZE1hcmdpbiIsInRleHQiLCJVc2VyTWVtb3J5SW5wdXRNZXNzYWdlIiwidDAiLCIkIiwiX2MiLCJ0MSIsImlucHV0IiwidDIiLCJTeW1ib2wiLCJmb3IiLCJzYXZpbmdUZXh0IiwidDMiLCJ0NCIsInQ1IiwidDYiLCJ0NyJdLCJzb3VyY2VzIjpbIlVzZXJNZW1vcnlJbnB1dE1lc3NhZ2UudHN4Il0sInNvdXJjZXNDb250ZW50IjpbImltcG9ydCBzYW1wbGUgZnJvbSAnbG9kYXNoLWVzL3NhbXBsZS5qcydcbmltcG9ydCAqIGFzIFJlYWN0IGZyb20gJ3JlYWN0J1xuaW1wb3J0IHsgdXNlTWVtbyB9IGZyb20gJ3JlYWN0J1xuaW1wb3J0IHsgQm94LCBUZXh0IH0gZnJvbSAnLi4vLi4vaW5rLmpzJ1xuaW1wb3J0IHsgZXh0cmFjdFRhZyB9IGZyb20gJy4uLy4uL3V0aWxzL21lc3NhZ2VzLmpzJ1xuaW1wb3J0IHsgTWVzc2FnZVJlc3BvbnNlIH0gZnJvbSAnLi4vTWVzc2FnZVJlc3BvbnNlLmpzJ1xuXG5mdW5jdGlvbiBnZXRTYXZpbmdNZXNzYWdlKCk6IHN0cmluZyB7XG4gIHJldHVybiBzYW1wbGUoWydHb3QgaXQuJywgJ0dvb2QgdG8ga25vdy4nLCAnTm90ZWQuJ10pXG59XG5cbnR5cGUgUHJvcHMgPSB7XG4gIGFkZE1hcmdpbjogYm9vbGVhblxuICB0ZXh0OiBzdHJpbmdcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIFVzZXJNZW1vcnlJbnB1dE1lc3NhZ2Uoe1xuICB0ZXh0LFxuICBhZGRNYXJnaW4sXG59OiBQcm9wcyk6IFJlYWN0LlJlYWN0Tm9kZSB7XG4gIGNvbnN0IGlucHV0ID0gZXh0cmFjdFRhZyh0ZXh0LCAndXNlci1tZW1vcnktaW5wdXQnKVxuICBjb25zdCBzYXZpbmdUZXh0ID0gdXNlTWVtbygoKSA9PiBnZXRTYXZpbmdNZXNzYWdlKCksIFtdKVxuXG4gIGlmICghaW5wdXQpIHtcbiAgICByZXR1cm4gbnVsbFxuICB9XG5cbiAgcmV0dXJuIChcbiAgICA8Qm94IGZsZXhEaXJlY3Rpb249XCJjb2x1bW5cIiBtYXJnaW5Ub3A9e2FkZE1hcmdpbiA/IDEgOiAwfSB3aWR0aD1cIjEwMCVcIj5cbiAgICAgIDxCb3g+XG4gICAgICAgIDxUZXh0IGNvbG9yPVwicmVtZW1iZXJcIiBiYWNrZ3JvdW5kQ29sb3I9XCJtZW1vcnlCYWNrZ3JvdW5kQ29sb3JcIj5cbiAgICAgICAgICAjXG4gICAgICAgIDwvVGV4dD5cbiAgICAgICAgPFRleHQgYmFja2dyb3VuZENvbG9yPVwibWVtb3J5QmFja2dyb3VuZENvbG9yXCIgY29sb3I9XCJ0ZXh0XCI+XG4gICAgICAgICAgeycgJ31cbiAgICAgICAgICB7aW5wdXR9eycgJ31cbiAgICAgICAgPC9UZXh0PlxuICAgICAgPC9Cb3g+XG4gICAgICA8TWVzc2FnZVJlc3BvbnNlIGhlaWdodD17MX0+XG4gICAgICAgIDxUZXh0IGRpbUNvbG9yPntzYXZpbmdUZXh0fTwvVGV4dD5cbiAgICAgIDwvTWVzc2FnZVJlc3BvbnNlPlxuICAgIDwvQm94PlxuICApXG59XG4iXSwibWFwcGluZ3MiOiI7QUFBQSxPQUFPQSxNQUFNLE1BQU0scUJBQXFCO0FBQ3hDLE9BQU8sS0FBS0MsS0FBSyxNQUFNLE9BQU87QUFDOUIsU0FBU0MsT0FBTyxRQUFRLE9BQU87QUFDL0IsU0FBU0MsR0FBRyxFQUFFQyxJQUFJLFFBQVEsY0FBYztBQUN4QyxTQUFTQyxVQUFVLFFBQVEseUJBQXlCO0FBQ3BELFNBQVNDLGVBQWUsUUFBUSx1QkFBdUI7QUFFdkQsU0FBU0MsZ0JBQWdCQSxDQUFBLENBQUUsRUFBRSxNQUFNLENBQUM7RUFDbEMsT0FBT1AsTUFBTSxDQUFDLENBQUMsU0FBUyxFQUFFLGVBQWUsRUFBRSxRQUFRLENBQUMsQ0FBQztBQUN2RDtBQUVBLEtBQUtRLEtBQUssR0FB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
