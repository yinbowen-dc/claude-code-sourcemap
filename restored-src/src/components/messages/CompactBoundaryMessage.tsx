/**
 * CompactBoundaryMessage.tsx
 *
 * 在 Claude Code 系统流程中的位置：
 * 该组件处于消息渲染管线的尾端，专门用于在对话历史被"压缩"（compacted）
 * 之后，在 UI 中显示一条提示横幅，告知用户对话上下文已被精简。
 *
 * 主要功能：
 * - 当会话上下文超出限制并执行了压缩操作后，渲染一条淡色提示语句
 * - 显示用于查看历史记录的快捷键提示（ctrl+o）
 * - 利用 React Compiler 的缓存机制（_c）避免不必要的重渲染
 */
import { c as _c } from "react/compiler-runtime";
import * as React from 'react';
import { Box, Text } from '../../ink.js';
import { useShortcutDisplay } from '../../keybindings/useShortcutDisplay.js';

/**
 * CompactBoundaryMessage 组件
 *
 * 流程说明：
 * 1. 通过 useShortcutDisplay 获取当前平台下"切换历史记录"动作对应的快捷键显示字符串
 * 2. 利用 React Compiler 生成的 _c(2) 缓存槽对结果进行记忆化，
 *    只有当 historyShortcut 发生变化时才重新构建 JSX 树
 * 3. 返回一个带垂直外边距的 Box，其中包含灰色提示文字，
 *    例如："✻ Conversation compacted (ctrl+o for history)"
 *
 * 在系统流程中的角色：
 * 由上层消息列表组件（Messages.tsx）在检测到压缩边界消息时渲染此组件，
 * 向用户提供可视化的上下文截断提示。
 */
export function CompactBoundaryMessage() {
  // React Compiler 生成的缓存槽，共 2 个槽位
  const $ = _c(2);

  // 获取"切换历史记录"操作对应的快捷键文本（如 "ctrl+o"）
  const historyShortcut = useShortcutDisplay("app:toggleTranscript", "Global", "ctrl+o");

  let t0;
  // 若 historyShortcut 发生变化，重新渲染提示文本；否则使用缓存值
  if ($[0] !== historyShortcut) {
    // 渲染压缩提示横幅，显示快捷键信息
    t0 = <Box marginY={1}><Text dimColor={true}>✻ Conversation compacted ({historyShortcut} for history)</Text></Box>;
    $[0] = historyShortcut;
    $[1] = t0;
  } else {
    // 使用上次缓存的渲染结果，避免重复创建 JSX 对象
    t0 = $[1];
  }
  return t0;
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJSZWFjdCIsIkJveCIsIlRleHQiLCJ1c2VTaG9ydGN1dERpc3BsYXkiLCJDb21wYWN0Qm91bmRhcnlNZXNzYWdlIiwiJCIsIl9jIiwiaGlzdG9yeVNob3J0Y3V0IiwidDAiXSwic291cmNlcyI6WyJDb21wYWN0Qm91bmRhcnlNZXNzYWdlLnRzeCJdLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgKiBhcyBSZWFjdCBmcm9tICdyZWFjdCdcbmltcG9ydCB7IEJveCwgVGV4dCB9IGZyb20gJy4uLy4uL2luay5qcydcbmltcG9ydCB7IHVzZVNob3J0Y3V0RGlzcGxheSB9IGZyb20gJy4uLy4uL2tleWJpbmRpbmdzL3VzZVNob3J0Y3V0RGlzcGxheS5qcydcblxuZXhwb3J0IGZ1bmN0aW9uIENvbXBhY3RCb3VuZGFyeU1lc3NhZ2UoKTogUmVhY3QuUmVhY3ROb2RlIHtcbiAgY29uc3QgaGlzdG9yeVNob3J0Y3V0ID0gdXNlU2hvcnRjdXREaXNwbGF5KFxuICAgICdhcHA6dG9nZ2xlVHJhbnNjcmlwdCcsXG4gICAgJ0dsb2JhbCcsXG4gICAgJ2N0cmwrbycsXG4gIClcblxuICByZXR1cm4gKFxuICAgIDxCb3ggbWFyZ2luWT17MX0+XG4gICAgICA8VGV4dCBkaW1Db2xvcj5cbiAgICAgICAg4py7IENvbnZlcnNhdGlvbiBjb21wYWN0ZWQgKHtoaXN0b3J5U2hvcnRjdXR9IGZvciBoaXN0b3J5KVxuICAgICAgPC9UZXh0PlxuICAgIDwvQm94PlxuICApXG59XG4iXSwibWFwcGluZ3MiOiI7QUFBQSxPQUFPLEtBQUtBLEtBQUssTUFBTSxPQUFPO0FBQzlCLFNBQVNDLEdBQUcsRUFBRUMsSUFBSSxRQUFRLGNBQWM7QUFDeEMsU0FBU0Msa0JBQWtCLFFBQVEseUNBQXlDO0FBRTVFLE9BQU8sU0FBQUMsdUJBQUE7RUFBQSxNQUFBQyxDQUFBLEdBQUFDLEVBQUE7RUFDTCxNQUFBQyxlQUFBLEdBQXdCSixrQkFBa0IsQ0FDeEMsc0JBQXNCLEVBQ3RCLFFBQVEsRUFDUixRQUNGLENBQUM7RUFBQSxJQUFBSyxFQUFBO0VBQUEsSUFBQUgsQ0FBQSxRQUFBRSxlQUFBO0lBR0NDLEVBQUEsSUFBQyxHQUFHLENBQVUsT0FBQyxDQUFELEdBQUMsQ0FDYixDQUFDLElBQUksQ0FBQyxRQUFRLENBQVIsS0FBTyxDQUFDLENBQUMsMEJBQ2NELGdCQUFjLENBQUUsYUFDN0MsRUFGQyxJQUFJLENBR1AsRUFKQyxHQUFHLENBSUU7SUFBQUYsQ0FBQSxNQUFBRSxlQUFBO0lBQUFGLENBQUEsTUFBQUcsRUFBQTtFQUFBO0lBQUFBLEVBQUEsR0FBQUgsQ0FBQTtFQUFBO0VBQUEsT0FKTkcsRUFJTTtBQUFBIiwiaWdub3JlTGlzdCI6W119
