/**
 * AgentNavigationFooter.tsx
 *
 * 【在 Claude Code 系统流程中的位置】
 * 本文件是 Agent 管理界面（AgentsMenu/AgentsList）底部的导航提示组件，
 * 位于 src/components/agents/ 目录下。
 * 它在 AgentsList 和 AgentsMenu 的各个视图底部被渲染，为用户提供
 * 当前界面可用的键盘操作提示（↑↓ 导航、Enter 选择、Esc 返回）。
 *
 * 【主要功能】
 * - 默认显示键盘导航提示：「Press ↑↓ to navigate · Enter to select · Esc to go back」
 * - 支持通过 instructions prop 自定义提示文本
 * - 接入 useExitOnCtrlCDWithKeybindings 钩子：
 *     当用户按下 Ctrl+C 或 Ctrl+D 时，若退出确认处于 pending 状态，
 *     则覆盖提示文本为「Press [key] again to exit」
 * - 使用 React Compiler 的 _c(2) 缓存机制，仅在显示文本变化时重新渲染
 */
import { c as _c } from "react/compiler-runtime";
import * as React from 'react';
import { useExitOnCtrlCDWithKeybindings } from '../../hooks/useExitOnCtrlCDWithKeybindings.js';
import { Box, Text } from '../../ink.js';

// 组件 Props 类型：instructions 为可选的自定义提示文本
type Props = {
  instructions?: string;
};

/**
 * AgentNavigationFooter 组件
 *
 * 渲染底部导航提示栏，仅包含一行灰色小字提示：
 * - 正常状态：显示 instructions（自定义）或默认键盘快捷键说明
 * - Ctrl+C/D 等待确认状态：覆盖显示「Press [key] again to exit」
 *
 * 使用 React Compiler 的 _c(2) 分配2个缓存槽，
 * 当且仅当最终显示文本（t2）变化时才重建 JSX 节点。
 */
export function AgentNavigationFooter(t0) {
  // React Compiler 分配 2 个缓存槽
  const $ = _c(2);

  // 从 props 中解构 instructions，可能为 undefined
  const {
    instructions: t1
  } = t0;

  // 若未传入 instructions，使用默认导航提示文本
  // 默认值：「Press ↑↓ to navigate · Enter to select · Esc to go back」
  const instructions = t1 === undefined ? "Press \u2191\u2193 to navigate \xB7 Enter to select \xB7 Esc to go back" : t1;

  // 订阅 Ctrl+C/D 退出确认状态
  const exitState = useExitOnCtrlCDWithKeybindings();

  // 计算最终显示文本：
  // - 若 exitState.pending=true（用户第一次按下退出键），显示「Press [key] again to exit」
  // - 否则显示 instructions（自定义文本或默认导航提示）
  const t2 = exitState.pending ? `Press ${exitState.keyName} again to exit` : instructions;

  // 缓存渲染结果：仅当 t2（显示文本）变化时重新渲染 Box/Text 节点
  let t3;
  if ($[0] !== t2) {
    // 以 marginLeft=2 的缩进，灰色（dimColor）渲染提示文本
    t3 = <Box marginLeft={2}><Text dimColor={true}>{t2}</Text></Box>;
    $[0] = t2;
    $[1] = t3;
  } else {
    // 显示文本未变化，复用缓存的 JSX 节点
    t3 = $[1];
  }
  return t3;
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJSZWFjdCIsInVzZUV4aXRPbkN0cmxDRFdpdGhLZXliaW5kaW5ncyIsIkJveCIsIlRleHQiLCJQcm9wcyIsImluc3RydWN0aW9ucyIsIkFnZW50TmF2aWdhdGlvbkZvb3RlciIsInQwIiwiJCIsIl9jIiwidDEiLCJ1bmRlZmluZWQiLCJleGl0U3RhdGUiLCJ0MiIsInBlbmRpbmciLCJrZXlOYW1lIiwidDMiXSwic291cmNlcyI6WyJBZ2VudE5hdmlnYXRpb25Gb290ZXIudHN4Il0sInNvdXJjZXNDb250ZW50IjpbImltcG9ydCAqIGFzIFJlYWN0IGZyb20gJ3JlYWN0J1xuaW1wb3J0IHsgdXNlRXhpdE9uQ3RybENEV2l0aEtleWJpbmRpbmdzIH0gZnJvbSAnLi4vLi4vaG9va3MvdXNlRXhpdE9uQ3RybENEV2l0aEtleWJpbmRpbmdzLmpzJ1xuaW1wb3J0IHsgQm94LCBUZXh0IH0gZnJvbSAnLi4vLi4vaW5rLmpzJ1xuXG50eXBlIFByb3BzID0ge1xuICBpbnN0cnVjdGlvbnM/OiBzdHJpbmdcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIEFnZW50TmF2aWdhdGlvbkZvb3Rlcih7XG4gIGluc3RydWN0aW9ucyA9ICdQcmVzcyDihpHihpMgdG8gbmF2aWdhdGUgwrcgRW50ZXIgdG8gc2VsZWN0IMK3IEVzYyB0byBnbyBiYWNrJyxcbn06IFByb3BzKTogUmVhY3QuUmVhY3ROb2RlIHtcbiAgY29uc3QgZXhpdFN0YXRlID0gdXNlRXhpdE9uQ3RybENEV2l0aEtleWJpbmRpbmdzKClcblxuICByZXR1cm4gKFxuICAgIDxCb3ggbWFyZ2luTGVmdD17Mn0+XG4gICAgICA8VGV4dCBkaW1Db2xvcj5cbiAgICAgICAge2V4aXRTdGF0ZS5wZW5kaW5nXG4gICAgICAgICAgPyBgUHJlc3MgJHtleGl0U3RhdGUua2V5TmFtZX0gYWdhaW4gdG8gZXhpdGBcbiAgICAgICAgICA6IGluc3RydWN0aW9uc31cbiAgICAgIDwvVGV4dD5cbiAgICA8L0JveD5cbiAgKVxufVxuIl0sIm1hcHBpbmdzIjoiO0FBQUEsT0FBTyxLQUFLQSxLQUFLLE1BQU0sT0FBTztBQUM5QixTQUFTQyw4QkFBOEIsUUFBUSwrQ0FBK0M7QUFDOUYsU0FBU0MsR0FBRyxFQUFFQyxJQUFJLFFBQVEsY0FBYztBQUV4QyxLQUFLQyxLQUFLLEdBQUc7RUFDWEMsWUFBWSxDQUFDLEVBQUUsTUFBTTtBQUN2QixDQUFDO0FBRUQsT0FBTyxTQUFBQyxzQkFBQUMsRUFBQTtFQUFBLE1BQUFDLENBQUEsR0FBQUMsRUFBQTtFQUErQjtJQUFBSixZQUFBLEVBQUFLO0VBQUEsSUFBQUgsRUFFOUI7RUFETixNQUFBRixZQUFBLEdBQUFLLEVBQXdFLEtBQXhFQyxTQUF3RSxHQUF4RSx5RUFBd0UsR0FBeEVELEVBQXdFO0VBRXhFLE1BQUFFLFNBQUEsR0FBa0JYLDhCQUE4QixDQUFDLENBQUM7RUFLM0MsTUFBQVksRUFBQSxHQUFBRCxTQUFTLENBQUFFLE9BRU0sR0FGZixTQUNZRixTQUFTLENBQUFHLE9BQVEsZ0JBQ2QsR0FGZlYsWUFFZTtFQUFBLElBQUFXLEVBQUE7RUFBQSxJQUFBUixDQUFBLFFBQUFLLEVBQUE7SUFKcEJHLEVBQUEsSUFBQyxHQUFHLENBQWEsVUFBQyxDQUFELEdBQUMsQ0FDaEIsQ0FBQyxJQUFJLENBQUMsUUFBUSxDQUFSLEtBQU8sQ0FBQyxDQUNYLENBQUFILEVBRWMsQ0FDakIsRUFKQyxJQUFJLENBS1AsRUFOQyxHQUFHLENBTUU7SUFBQUwsQ0FBQSxNQUFBSyxFQUFBO0lBQUFMLENBQUEsTUFBQVEsRUFBQTtFQUFBO0lBQUFBLEVBQUEsR0FBQVIsQ0FBQTtFQUFBO0VBQUEsT0FOTlEsRUFNTTtBQUFBIiwiaWdub3JlTGlzdCI6W119
