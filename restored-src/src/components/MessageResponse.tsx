/**
 * MessageResponse.tsx
 *
 * 【在 Claude Code 系统流程中的位置】
 * 本文件是消息响应区域的布局容器组件，用于为所有助手响应内容添加统一的
 * 左侧缩进符号（⎿）和滚动保护（Ratchet）。
 * 位于：消息列表 → 消息行 → 【助手响应内容容器】
 *
 * 【主要功能】
 * 1. MessageResponse 组件：
 *    - 检测是否已处于 MessageResponse 嵌套上下文中，若是则直接渲染 children，
 *      避免重复渲染 ⎿ 缩进符号。
 *    - 否则，在左侧渲染淡色的 ⎿ 符号，右侧渲染内容，使用 MessageResponseProvider 包裹。
 *    - 若指定了 height（固定高度模式），直接返回 content；
 *      否则将 content 包裹在 <Ratchet lock="offscreen"> 中，防止已渲染内容闪烁回退。
 * 2. MessageResponseContext：React 上下文，用于检测嵌套渲染，初始值为 false。
 * 3. MessageResponseProvider：将 context 值设为 true 的 Provider，防止子组件重复渲染 ⎿。
 */
import { c as _c } from "react/compiler-runtime";
import * as React from 'react';
import { useContext } from 'react';
import { Box, NoSelect, Text } from '../ink.js';
import { Ratchet } from './design-system/Ratchet.js';
type Props = {
  children: React.ReactNode;
  height?: number;
};

/**
 * MessageResponse 组件
 *
 * 【整体流程】
 * 1. 通过 useContext(MessageResponseContext) 检测是否已在 MessageResponse 子树中
 * 2. 若已在子树中（isMessageResponse === true），直接返回 children（避免嵌套 ⎿）
 * 3. 使用 _c(8) 创建 8 槽缓存数组
 * 4. 槽 0：静态的 <NoSelect> ⎿ 符号节点（只创建一次）
 * 5. 槽 1/2：依据 children 变化缓存右侧内容 Box
 * 6. 槽 3/4/5：依据 height 和内容 Box 变化缓存完整 content（含 Provider 和外层 Box）
 * 7. 若 height !== undefined，直接返回固定高度的 content
 * 8. 否则，将 content 包裹在 Ratchet（屏幕外锁定）中，防止内容回退闪烁；
 *    依据 content 变化缓存 Ratchet 节点（槽 6/7）
 *
 * 【设计意图】
 * 统一为所有助手响应添加左侧树状缩进符号，同时利用 Context 防止嵌套重复渲染；
 * 通过 Ratchet 保证流式输出时界面稳定，不出现内容抖动。
 */
export function MessageResponse(t0) {
  // React Compiler 生成的 8 槽缓存数组
  const $ = _c(8);
  // 解构 children（子节点）和可选的 height（固定高度）
  const {
    children,
    height
  } = t0;
  // 检测是否已处于 MessageResponse 的子树中，避免嵌套渲染 ⎿
  const isMessageResponse = useContext(MessageResponseContext);
  if (isMessageResponse) {
    // 已在嵌套场景中，直接透传 children，不加 ⎿
    return children;
  }
  let t1;
  // 槽 0：静态的左侧 ⎿ 缩进符号节点（首次渲染后永远复用）
  if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
    // NoSelect 防止用户意外选中缩进符号；fromLeftEdge 贴左边缘；flexShrink=0 不压缩
    t1 = <NoSelect fromLeftEdge={true} flexShrink={0}><Text dimColor={true}>{"  "}⎿  </Text></NoSelect>;
    $[0] = t1;
  } else {
    t1 = $[0];
  }
  let t2;
  // 若 children 发生变化，重建内容 Box 并缓存到槽 1/2
  if ($[1] !== children) {
    t2 = <Box flexShrink={1} flexGrow={1}>{children}</Box>;
    $[1] = children; // 缓存 children 引用
    $[2] = t2;       // 缓存内容 Box
  } else {
    t2 = $[2];
  }
  let t3;
  // 若 height 或内容 Box 变化，重建完整 content 并缓存到槽 3/4/5
  if ($[3] !== height || $[4] !== t2) {
    // MessageResponseProvider 将 context 设为 true，防止子组件重复渲染 ⎿
    // overflowY="hidden" 配合固定 height 裁切超出内容
    t3 = <MessageResponseProvider><Box flexDirection="row" height={height} overflowY="hidden">{t1}{t2}</Box></MessageResponseProvider>;
    $[3] = height; // 缓存 height
    $[4] = t2;     // 缓存内容 Box 引用
    $[5] = t3;     // 缓存完整 content
  } else {
    t3 = $[5];
  }
  const content = t3;
  // 若指定了固定高度，直接返回 content（不需要 Ratchet 保护）
  if (height !== undefined) {
    return content;
  }
  let t4;
  // 将 content 包裹在 Ratchet 中，防止流式输出时界面回退闪烁
  // 依据 content 变化缓存 Ratchet 节点到槽 6/7
  if ($[6] !== content) {
    t4 = <Ratchet lock="offscreen">{content}</Ratchet>;
    $[6] = content; // 缓存 content 引用
    $[7] = t4;      // 缓存 Ratchet 节点
  } else {
    t4 = $[7];
  }
  return t4;
}

// This is a context that is used to determine if the message response
// is rendered as a descendant of another MessageResponse. We use it
// to avoid rendering nested ⎿ characters.
// 用于检测是否处于 MessageResponse 子树的 React 上下文，默认值为 false
const MessageResponseContext = React.createContext(false);

/**
 * MessageResponseProvider 组件
 *
 * 【整体流程】
 * 1. 接收 children，将 MessageResponseContext 值设为 true 向下传递
 * 2. 使用 _c(2) 缓存 Provider 节点（槽 0/1）
 *
 * 【设计意图】
 * 确保在 MessageResponse 内部渲染的任何子 MessageResponse 组件
 * 都能通过 Context 感知到已处于嵌套场景，从而跳过重复的 ⎿ 符号渲染。
 */
function MessageResponseProvider(t0) {
  // React Compiler 生成的 2 槽缓存数组
  const $ = _c(2);
  const {
    children
  } = t0;
  let t1;
  // 若 children 变化，重建 Provider 节点并缓存到槽 0/1
  if ($[0] !== children) {
    // value={true} 将 isMessageResponse 设为 true，通知子树已嵌套
    t1 = <MessageResponseContext.Provider value={true}>{children}</MessageResponseContext.Provider>;
    $[0] = children; // 缓存 children 引用
    $[1] = t1;       // 缓存 Provider 节点
  } else {
    t1 = $[1];
  }
  return t1;
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJSZWFjdCIsInVzZUNvbnRleHQiLCJCb3giLCJOb1NlbGVjdCIsIlRleHQiLCJSYXRjaGV0IiwiUHJvcHMiLCJjaGlsZHJlbiIsIlJlYWN0Tm9kZSIsImhlaWdodCIsIk1lc3NhZ2VSZXNwb25zZSIsInQwIiwiJCIsIl9jIiwiaXNNZXNzYWdlUmVzcG9uc2UiLCJNZXNzYWdlUmVzcG9uc2VDb250ZXh0IiwidDEiLCJTeW1ib2wiLCJmb3IiLCJ0MiIsInQzIiwiY29udGVudCIsInVuZGVmaW5lZCIsInQ0IiwiY3JlYXRlQ29udGV4dCIsIk1lc3NhZ2VSZXNwb25zZVByb3ZpZGVyIl0sInNvdXJjZXMiOlsiTWVzc2FnZVJlc3BvbnNlLnRzeCJdLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgKiBhcyBSZWFjdCBmcm9tICdyZWFjdCdcbmltcG9ydCB7IHVzZUNvbnRleHQgfSBmcm9tICdyZWFjdCdcbmltcG9ydCB7IEJveCwgTm9TZWxlY3QsIFRleHQgfSBmcm9tICcuLi9pbmsuanMnXG5pbXBvcnQgeyBSYXRjaGV0IH0gZnJvbSAnLi9kZXNpZ24tc3lzdGVtL1JhdGNoZXQuanMnXG5cbnR5cGUgUHJvcHMgPSB7XG4gIGNoaWxkcmVuOiBSZWFjdC5SZWFjdE5vZGVcbiAgaGVpZ2h0PzogbnVtYmVyXG59XG5cbmV4cG9ydCBmdW5jdGlvbiBNZXNzYWdlUmVzcG9uc2UoeyBjaGlsZHJlbiwgaGVpZ2h0IH06IFByb3BzKTogUmVhY3QuUmVhY3ROb2RlIHtcbiAgY29uc3QgaXNNZXNzYWdlUmVzcG9uc2UgPSB1c2VDb250ZXh0KE1lc3NhZ2VSZXNwb25zZUNvbnRleHQpXG4gIGlmIChpc01lc3NhZ2VSZXNwb25zZSkge1xuICAgIHJldHVybiBjaGlsZHJlblxuICB9XG4gIGNvbnN0IGNvbnRlbnQgPSAoXG4gICAgPE1lc3NhZ2VSZXNwb25zZVByb3ZpZGVyPlxuICAgICAgPEJveCBmbGV4RGlyZWN0aW9uPVwicm93XCIgaGVpZ2h0PXtoZWlnaHR9IG92ZXJmbG93WT1cImhpZGRlblwiPlxuICAgICAgICA8Tm9TZWxlY3QgZnJvbUxlZnRFZGdlIGZsZXhTaHJpbms9ezB9PlxuICAgICAgICAgIDxUZXh0IGRpbUNvbG9yPnsnICAnfeKOvyAmbmJzcDs8L1RleHQ+XG4gICAgICAgIDwvTm9TZWxlY3Q+XG4gICAgICAgIDxCb3ggZmxleFNocmluaz17MX0gZmxleEdyb3c9ezF9PlxuICAgICAgICAgIHtjaGlsZHJlbn1cbiAgICAgICAgPC9Cb3g+XG4gICAgICA8L0JveD5cbiAgICA8L01lc3NhZ2VSZXNwb25zZVByb3ZpZGVyPlxuICApXG4gIGlmIChoZWlnaHQgIT09IHVuZGVmaW5lZCkge1xuICAgIHJldHVybiBjb250ZW50XG4gIH1cbiAgcmV0dXJuIDxSYXRjaGV0IGxvY2s9XCJvZmZzY3JlZW5cIj57Y29udGVudH08L1JhdGNoZXQ+XG59XG5cbi8vIFRoaXMgaXMgYSBjb250ZXh0IHRoYXQgaXMgdXNlZCB0byBkZXRlcm1pbmUgaWYgdGhlIG1lc3NhZ2UgcmVzcG9uc2Vcbi8vIGlzIHJlbmRlcmVkIGFzIGEgZGVzY2VuZGFudCBvZiBhbm90aGVyIE1lc3NhZ2VSZXNwb25zZS4gV2UgdXNlIGl0XG4vLyB0byBhdm9pZCByZW5kZXJpbmcgbmVzdGVkIOKOvyBjaGFyYWN0ZXJzLlxuY29uc3QgTWVzc2FnZVJlc3BvbnNlQ29udGV4dCA9IFJlYWN0LmNyZWF0ZUNvbnRleHQoZmFsc2UpXG5cbmZ1bmN0aW9uIE1lc3NhZ2VSZXNwb25zZVByb3ZpZGVyKHtcbiAgY2hpbGRyZW4sXG59OiB7XG4gIGNoaWxkcmVuOiBSZWFjdC5SZWFjdE5vZGVcbn0pOiBSZWFjdC5SZWFjdE5vZGUge1xuICByZXR1cm4gKFxuICAgIDxNZXNzYWdlUmVzcG9uc2VDb250ZXh0LlByb3ZpZGVyIHZhbHVlPXt0cnVlfT5cbiAgICAgIHtjaGlsZHJlbn1cbiAgICA8L01lc3NhZ2VSZXNwb25zZUNvbnRleHQuUHJvdmlkZXI+XG4gIClcbn1cbiJdLCJtYXBwaW5ncyI6IjtBQUFBLE9BQU8sS0FBS0Es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
