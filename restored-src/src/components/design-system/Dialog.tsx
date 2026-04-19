/**
 * 【设计系统 - Dialog 确认对话框组件】
 *
 * 在 Claude Code 系统流程中的位置：
 * 用户确认交互层。所有需要"确认/取消"决策的场景（权限请求、危险操作、
 * 工作流中断等）均通过此组件呈现。渲染在 <Pane> 框架内（除非 hideBorder），
 * 底部显示可配置的键盘操作提示行。
 *
 * 主要功能：
 * 1. 注册 confirm:no（Esc/n）键绑定，调用 onCancel 回调
 * 2. 通过 useExitOnCtrlCDWithKeybindings 拦截 Ctrl+C/D 退出信号
 * 3. 当 exitState.pending 为 true 时，将操作提示替换为"再按一次退出"提示
 * 4. 支持 isCancelActive 开关，嵌入 TextInput 时可暂停键绑定，避免按键被拦截
 * 5. hideBorder=true 时跳过 <Pane> 包裹，用于嵌套对话框避免双重边框
 * 6. React Compiler 编译优化（_c(27) 缓存）
 */

import { c as _c } from "react/compiler-runtime";
import React from 'react';
import { type ExitState, useExitOnCtrlCDWithKeybindings } from '../../hooks/useExitOnCtrlCDWithKeybindings.js';
import { Box, Text } from '../../ink.js';
import { useKeybinding } from '../../keybindings/useKeybinding.js';
import type { Theme } from '../../utils/theme.js';
import { ConfigurableShortcutHint } from '../ConfigurableShortcutHint.js';
import { Byline } from './Byline.js';
import { KeyboardShortcutHint } from './KeyboardShortcutHint.js';
import { Pane } from './Pane.js';

type DialogProps = {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  children: React.ReactNode;
  onCancel: () => void;
  color?: keyof Theme;
  hideInputGuide?: boolean;
  hideBorder?: boolean;
  /** 自定义操作提示内容，接收 exitState 用于展示 Ctrl+C/D 待确认状态。 */
  inputGuide?: (exitState: ExitState) => React.ReactNode;
  /**
   * 控制 Dialog 内置的 confirm:no（Esc/n）和 app:exit/interrupt（Ctrl-C/D）
   * 键绑定是否激活。当嵌入的 TextInput 正在编辑时设为 false，
   * 使按键（如 'n'）直达文本框而非被 Dialog 消费。
   * TextInput 自带 ctrl+c/d 处理器（取消 / ctrl+d 前删字符）。
   * 默认值：true。
   */
  isCancelActive?: boolean;
};

/**
 * 确认/取消对话框容器。
 *
 * 整体流程：
 * 1. 解构 props，color 默认 "permission"，isCancelActive 默认 true
 * 2. 调用 useExitOnCtrlCDWithKeybindings 注册 Ctrl+C/D 全局退出拦截，
 *    传入 isCancelActive 控制是否激活
 * 3. 调用 useKeybinding("confirm:no", onCancel, {context, isActive}) 注册
 *    Esc/n 取消键绑定；isCancelActive=false 时暂停此绑定
 * 4. 根据 exitState.pending 构建 defaultInputGuide：
 *    - pending=true：显示 "Press {keyName} again to exit"
 *    - pending=false：显示 Byline 快捷键提示（Enter confirm · Esc/n cancel）
 * 5. 构建 content：
 *    - 标题行（bold + color） + 可选 subtitle（dimColor）
 *    - gap=1 的 column Box 包含标题区 + children
 *    - 可选 inputGuide 区（marginTop=1，italic dimColor）
 * 6. 若 hideBorder=true，直接返回 content
 * 7. 否则将 content 包裹在 <Pane color={color}> 中返回
 *
 * @example
 * <Dialog title="Allow file write?" onCancel={handleCancel}>
 *   <Text>The tool wants to write to src/index.ts</Text>
 * </Dialog>
 */
export function Dialog(t0) {
  // React Compiler 缓存数组，共 27 个槽位
  const $ = _c(27);
  const {
    title,
    subtitle,
    children,
    onCancel,
    color: t1,
    hideInputGuide,
    hideBorder,
    inputGuide,
    isCancelActive: t2
  } = t0;
  // color 默认值为 "permission"（蓝紫色，匹配权限请求场景）
  const color = t1 === undefined ? "permission" : t1;
  // isCancelActive 默认为 true，嵌入 TextInput 时可设为 false 避免按键冲突
  const isCancelActive = t2 === undefined ? true : t2;
  // 注册 Ctrl+C/D 全局退出拦截，返回 exitState（含 pending 和 keyName）
  const exitState = useExitOnCtrlCDWithKeybindings(undefined, undefined, isCancelActive);
  let t3;
  // 仅在 isCancelActive 变化时重新构建选项对象（避免不必要的重渲染）
  if ($[0] !== isCancelActive) {
    t3 = {
      context: "Confirmation",    // 键绑定上下文作用域
      isActive: isCancelActive    // 是否激活（TextInput 编辑时传 false）
    };
    $[0] = isCancelActive;
    $[1] = t3;
  } else {
    t3 = $[1];
  }
  // 注册 confirm:no 键绑定（Esc 或 n），触发 onCancel 回调
  useKeybinding("confirm:no", onCancel, t3);
  let t4;
  // 根据 exitState 构建默认操作提示
  if ($[2] !== exitState.keyName || $[3] !== exitState.pending) {
    // pending=true 时提示"再按一次退出"；否则显示正常快捷键提示行
    t4 = exitState.pending ? <Text>Press {exitState.keyName} again to exit</Text> : <Byline><KeyboardShortcutHint shortcut="Enter" action="confirm" /><ConfigurableShortcutHint action="confirm:no" context="Confirmation" fallback="Esc" description="cancel" /></Byline>;
    $[2] = exitState.keyName;
    $[3] = exitState.pending;
    $[4] = t4;
  } else {
    t4 = $[4];
  }
  // 默认操作提示（可被 inputGuide prop 覆盖）
  const defaultInputGuide = t4;
  let t5;
  // 标题文本：加粗 + 主题色
  if ($[5] !== color || $[6] !== title) {
    t5 = <Text bold={true} color={color}>{title}</Text>;
    $[5] = color;
    $[6] = title;
    $[7] = t5;
  } else {
    t5 = $[7];
  }
  let t6;
  // 副标题文本：可选，dimColor 变暗
  if ($[8] !== subtitle) {
    t6 = subtitle && <Text dimColor={true}>{subtitle}</Text>;
    $[8] = subtitle;
    $[9] = t6;
  } else {
    t6 = $[9];
  }
  let t7;
  // 标题区：column 方向的 Box（title + 可选 subtitle）
  if ($[10] !== t5 || $[11] !== t6) {
    t7 = <Box flexDirection="column">{t5}{t6}</Box>;
    $[10] = t5;
    $[11] = t6;
    $[12] = t7;
  } else {
    t7 = $[12];
  }
  let t8;
  // 主内容区：gap=1，包含标题区 + children
  if ($[13] !== children || $[14] !== t7) {
    t8 = <Box flexDirection="column" gap={1}>{t7}{children}</Box>;
    $[13] = children;
    $[14] = t7;
    $[15] = t8;
  } else {
    t8 = $[15];
  }
  let t9;
  // 操作提示区：仅在 hideInputGuide=false 时渲染
  if ($[16] !== defaultInputGuide || $[17] !== exitState || $[18] !== hideInputGuide || $[19] !== inputGuide) {
    // inputGuide prop 优先，否则使用 defaultInputGuide；marginTop=1 与内容区隔开
    t9 = !hideInputGuide && <Box marginTop={1}><Text dimColor={true} italic={true}>{inputGuide ? inputGuide(exitState) : defaultInputGuide}</Text></Box>;
    $[16] = defaultInputGuide;
    $[17] = exitState;
    $[18] = hideInputGuide;
    $[19] = inputGuide;
    $[20] = t9;
  } else {
    t9 = $[20];
  }
  let t10;
  // 将主内容区和操作提示区合并为 Fragment
  if ($[21] !== t8 || $[22] !== t9) {
    t10 = <>{t8}{t9}</>;
    $[21] = t8;
    $[22] = t9;
    $[23] = t10;
  } else {
    t10 = $[23];
  }
  const content = t10;
  // hideBorder=true：直接返回内容，适用于嵌套在已有边框容器内
  if (hideBorder) {
    return content;
  }
  let t11;
  // 默认路径：将内容包裹在带彩色顶部分隔线的 <Pane> 中
  if ($[24] !== color || $[25] !== content) {
    t11 = <Pane color={color}>{content}</Pane>;
    $[24] = color;
    $[25] = content;
    $[26] = t11;
  } else {
    t11 = $[26];
  }
  return t11;
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJSZWFjdCIsIkV4aXRTdGF0ZSIsInVzZUV4aXRPbkN0cmxDRFdpdGhLZXliaW5kaW5ncyIsIkJveCIsIlRleHQiLCJ1c2VLZXliaW5kaW5nIiwiVGhlbWUiLCJDb25maWd1cmFibGVTaG9ydGN1dEhpbnQiLCJCeWxpbmUiLCJLZXlib2FyZFNob3J0Y3V0SGludCIsIlBhbmUiLCJEaWFsb2dQcm9wcyIsInRpdGxlIiwiUmVhY3ROb2RlIiwic3VidGl0bGUiLCJjaGlsZHJlbiIsIm9uQ2FuY2VsIiwiY29sb3IiLCJoaWRlSW5wdXRHdWlkZSIsImhpZGVCb3JkZXIiLCJpbnB1dEd1aWRlIiwiZXhpdFN0YXRlIiwiaXNDYW5jZWxBY3RpdmUiLCJEaWFsb2ciLCJ0MCIsIiQiLCJfYyIsInQxIiwidDIiLCJ1bmRlZmluZWQiLCJ0MyIsImNvbnRleHQiLCJpc0FjdGl2ZSIsInQ0Iiwia2V5TmFtZSIsInBlbmRpbmciLCJkZWZhdWx0SW5wdXRHdWlkZSIsInQ1IiwidDYiLCJ0NyIsInQ4IiwidDkiLCJ0MTAiLCJjb250ZW50IiwidDExIl0sInNvdXJjZXMiOlsiRGlhbG9nLnRzeCJdLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgUmVhY3QgZnJvbSAncmVhY3QnXG5pbXBvcnQge1xuICB0eXBlIEV4aXRTdGF0ZSxcbiAgdXNlRXhpdE9uQ3RybENEV2l0aEtleWJpbmRpbmdzLFxufSBmcm9tICcuLi8uLi9ob29rcy91c2VFeGl0T25DdHJsQ0RXaXRoS2V5YmluZGluZ3MuanMnXG5pbXBvcnQgeyBCb3gsIFRleHQgfSBmcm9tICcuLi8uLi9pbmsuanMnXG5pbXBvcnQgeyB1c2VLZXliaW5kaW5nIH0gZnJvbSAnLi4vLi4va2V5YmluZGluZ3MvdXNlS2V5YmluZGluZy5qcydcbmltcG9ydCB0eXBlIHsgVGhlbWUgfSBmcm9tICcuLi8uLi91dGlscy90aGVtZS5qcydcbmltcG9ydCB7IENvbmZpZ3VyYWJsZVNob3J0Y3V0SGludCB9IGZyb20gJy4uL0NvbmZpZ3VyYWJsZVNob3J0Y3V0SGludC5qcydcbmltcG9ydCB7IEJ5bGluZSB9IGZyb20gJy4vQnlsaW5lLmpzJ1xuaW1wb3J0IHsgS2V5Ym9hcmRTaG9ydGN1dEhpbnQgfSBmcm9tICcuL0tleWJvYXJkU2hvcnRjdXRIaW50LmpzJ1xuaW1wb3J0IHsgUGFuZSB9IGZyb20gJy4vUGFuZS5qcydcblxudHlwZSBEaWFsb2dQcm9wcyA9IHtcbiAgdGl0bGU6IFJlYWN0LlJlYWN0Tm9kZVxuICBzdWJ0aXRsZT86IFJlYWN0LlJlYWN0Tm9kZVxuICBjaGlsZHJlbjogUmVhY3QuUmVhY3ROb2RlXG4gIG9uQ2FuY2VsOiAoKSA9PiB2b2lkXG4gIGNvbG9yPzoga2V5b2YgVGhlbWVcbiAgaGlkZUlucHV0R3VpZGU/OiBib29sZWFuXG4gIGhpZGVCb3JkZXI/OiBib29sZWFuXG4gIC8qKiBDdXN0b20gaW5wdXQgZ3VpZGUgY29udGVudC4gUmVjZWl2ZXMgZXhpdFN0YXRlIGZvciBDdHJsK0MvRCBwZW5kaW5nIGRpc3BsYXkuICovXG4gIGlucHV0R3VpZGU/OiAoZXhpdFN0YXRlOiBFeGl0U3RhdGUpID0+IFJlYWN0LlJlYWN0Tm9kZVxuICAvKipcbiAgICogQ29udHJvbHMgd2hldGhlciBEaWFsb2cncyBidWlsdC1pbiBjb25maXJtOm5vIChFc2Mvbikgb W5kIGFwcDpleGl0L2ludGVycnVwdFxuICAgKiAoQ3RybC1DL0QpIGtleWJpbmRpbmdzIGFyZSBhY3RpdmUuIFNldCB0byBgZmFsc2VgIHdoaWxlIGFuIGVtYmVkZGVkIHRleHRcbiAgICogZmllbGQgaXMgYmVpbmcgZWRpdGVkIHNvIHRob3NlIGtleXMgcmVhY2ggdGhlIGZpZWxkIGluc3RlYWQgb2YgYmVpbmdcbiAgICogY29uc3VtZWQgYnkgRGlhbG9nLiBUZXh0SW5wdXQgaGFzIGl0cyBvd24gY3RybCtjL2QgaGFuZGxlcnMgKGNhbmNlbCBvblxuICAgKiBwcmVzcywgZGVsZXRlLWZvcndhcmQgb24gY3RybCtkIHdpdGggdGV4dCkuIERlZmF1bHRzIHRvIGB0cnVlYC5cbiAgICovXG4gIGlzQ2FuY2VsQWN0aXZlPzogYm9vbGVhblxufVxuXG5leHBvcnQgZnVuY3Rpb24gRGlhbG9nKHtcbiAgdGl0bGUsXG4gIHN1YnRpdGxlLFxuICBjaGlsZHJlbixcbiAgb25DYW5jZWwsXG4gIGNvbG9yID0gJ3Blcm1pc3Npb24nLFxuICBoaWRlSW5wdXRHdWlkZSxcbiAgaGlkZUJvcmRlcixcbiAgaW5wdXRHdWlkZSxcbiAgaXNDYW5jZWxBY3RpdmUgPSB0cnVlLFxufTogRGlhbG9nUHJvcHMpOiBSZWFjdC5SZWFjdE5vZGUge1xuICBjb25zdCBleGl0U3RhdGUgPSB1c2VFeGl0T25DdHJsQ0RXaXRoS2V5YmluZGluZ3MoXG4gICAgdW5kZWZpbmVkLFxuICAgIHVuZGVmaW5lZCxcbiAgICBpc0NhbmNlbEFjdGl2ZSxcbiAgKVxuXG4gIC8vIFVzZSBjb25maWd1cmFibGUga2V5YmluZGluZyBmb3IgRVNDIHRvIGNhbmNlbC5cbiAgLy8gaXNDYW5jZWxBY3RpdmUgbGV0cyBjb25zdW1lcnMgKGUuZy4gRWxpY2l0YXRpb25EaWFsb2cpIGRpc2FibGUgdGhpcyB3aGlsZVxuICAvLyBhbiBlbWJlZGRlZCBUZXh0SW5wdXQgaXMgZm9jdXNlZCwgc28gdGhhdCBrZXlzIGxpa2UgJ24nIHJlYWNoIHRoZSBmaWVsZFxuICAvLyBpbnN0ZWFkIG9mIGJlaW5nIGNvbnN1bWVkIGhlcmUuXG4gIHVzZUtleWJpbmRpbmcoJ2NvbmZpcm06bm8nLCBvbkNhbmNlbCwge1xuICAgIGNvbnRleHQ6ICdDb25maXJtYXRpb24nLFxuICAgIGlzQWN0aXZlOiBpc0NhbmNlbEFjdGl2ZSxcbiAgfSlcblxuICBjb25zdCBkZWZhdWx0SW5wdXRHdWlkZSA9IGV4aXRTdGF0ZS5wZW5kaW5nID8gKFxuICAgIDxUZXh0PlByZXNzIHtleGl0U3RhdGUua2V5TmFtZX0gYWdhaW4gdG8gZXhpdDwvVGV4dD5cbiAgKSA6IChcbiAgICA8QnlsaW5lPlxuICAgICAgPEtleWJvYXJkU2hvcnRjdXRIaW50IHNob3J0Y3V0PVwiRW50ZXJcIiBhY3Rpb249XCJjb25maXJtXCIgLz5cbiAgICAgIDxDb25maWd1cmFibGVTaG9ydGN1dEhpbnRcbiAgICAgICAgYWN0aW9uPVwiY29uZmlybTpub1wiXG4gICAgICAgIGNvbnRleHQ9XCJDb25maXJtYXRpb25cIlxuICAgICAgICBmYWxsYmFjaz1cIkVzY1wiXG4gICAgICAgIGRlc2NyaXB0aW9uPVwiY2FuY2VsXCJcbiAgICAgIC8+XG4gICAgPC9CeWxpbmU+XG4gIClcblxuICBjb25zdCBjb250ZW50ID0gKFxuICAgIDw+XG4gICAgICA8Qm94IGZsZXhEaXJlY3Rpb249XCJjb2x1bW5cIiBnYXA9ezF9PlxuICAgICAgICA8Qm94IGZsZXhEaXJlY3Rpb249XCJjb2x1bW5cIj5cbiAgICAgICAgICA8VGV4dCBib2xkIGNvbG9yPXtjb2xvcn0+XG4gICAgICAgICAgICB7dGl0bGV9XG4gICAgICAgICAgPC9UZXh0PlxuICAgICAgICAgIHtzdWJ0aXRsZSAmJiA8VGV4dCBkaW1Db2xvcj57c3VidGl0bGV9PC9UZXh0Pn1cbiAgICAgICAgPC9Cb3g+XG4gICAgICAgIHtjaGlsZHJlbn1cbiAgICAgIDwvQm94PlxuICAgICAgeyFoaWRlSW5wdXRHdWlkZSAmJiAoXG4gICAgICAgIDxCb3ggbWFyZ2luVG9wPXsxfT5cbiAgICAgICAgICA8VGV4dCBkaW1Db2xvciBpdGFsaWM+XG4gICAgICAgICAgICB7aW5wdXRHdWlkZSA/IGlucHV0R3VpZGUoZXhpdFN0YXRlKSA6IGRlZmF1bHRJbnB1dEd1aWRlfVxuICAgICAgICAgIDwvVGV4dD5cbiAgICAgICAgPC9Cb3g+XG4gICAgICApfVxuICAgIDwvPlxuICApXG5cbiAgaWYgKGhpZGVCb3JkZXIpIHtcbiAgICByZXR1cm4gY29udGVudFxuICB9XG5cbiAgcmV0dXJuIDxQYW5lIGNvbG9yPXtjb2xvcn0+e2NvbnRlbnR9PC9QYW5lPlxufVxuIl0sIm1hcHBpbmdzIjoiO0FBQUEsT0FBT0EsS0FBSyxNQUFNLE9BQU87QUFDekIsU0FDRSxLQUFLQyxTQUFTLEVBQ2RDLDhCQUE4QixRQUN6QiwrQ0FBK0M7QUFDdEQsU0FBU0MsR0FBRyxFQUFFQyxJQUFJLFFBQVEsY0FBYztBQUN4QyxTQUFTQyxhQUFhLFFBQVEsb0NBQW9DO0FBQ2xFLGNBQWNDLEtBQUssUUFBUSxzQkFBc0I7QUFDakQsU0FBU0Msd0JBQXdCLFFBQVEsZ0NBQWdDO0FBQ3pFLFNBQVNDLE1BQU0sUUFBUSxhQUFhO0FBQ3BDLFNBQVNDLG9CQUFvQixRQUFRLDJCQUEyQjtBQUNoRSxTQUFTQyxJQUFJLFFBQVEsV0FBVztBQUVoQyxLQUFLQyxXQUFXLEdBQUc7RUFDakJDLEtBQUssRUFBRVosS0FBSyxDQUFDYSxTQUFTO0VBQ3RCQyxRQUFRLENBQUMsRUFBRWQsS0FBSyxDQUFDYSxTQUFTO0VBQzFCRSxRQUFRLEVBQUVmLEtBQUssQ0FBQ2EsU0FBUztFQUN6QkcsUUFBUSxFQUFFLEdBQUcsR0FBRyxJQUFJO0VBQ3BCQyxLQUFLLENBQUMsRUFBRSxNQUFNWCxLQUFLO0VBQ25CWSxjQUFjLENBQUMsRUFBRSxPQUFPO0VBQ3hCQyxVQUFVLENBQUMsRUFBRSxPQUFPO0VBQ3BCO0VBQ0FDLFVBQVUsQ0FBQyxFQUFFLENBQUNDLFNBQVMsRUFBRXBCLFNBQVMsRUFBRSxHQUFHRCxLQUFLLENBQUNhLFNBQVM7RUFDdEQ7QUFDRjtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7RUFDRVMsY0FBYyxDQUFDLEVBQUUsT0FBTztBQUMxQixDQUFDO0FBRUQsT0FBTyxTQUFBQyxPQUFBQyxFQUFBO0VBQUEsTUFBQUMsQ0FBQSxHQUFBQyxFQUFBO0VBQWdCO0lBQUFkLEtBQUE7SUFBQUUsUUFBQTtJQUFBQyxRQUFBO0lBQUFDLFFBQUE7SUFBQUMsS0FBQSxFQUFBVSxFQUFBO0lBQUFULGNBQUE7SUFBQUMsVUFBQTtJQUFBQyxVQUFBO0lBQUFFLGNBQUEsRUFBQU07RUFBQSxJQUFBSixFQVVUO0VBTFosTUFBQVAsS0FBQSxHQUFBVSxFQUFvQixLQUFwQkUsU0FBb0IsR0FBcEIsWUFBb0IsR0FBcEJGLEVBQW9CO0VBSXBCLE1BQUFMLGNBQUEsR0FBQU0sRUFBcUIsS0FBckJDLFNBQXFCLEdBQXJCLElBQXFCLEdBQXJCRCxFQUFxQjtFQUVyQixNQUFBUCxTQUFBLEdBQWtCbkIsOEJBQThCLENBQzlDMkIsU0FBUyxFQUNUQSxTQUFTLEVBQ1RQLGNBQ0YsQ0FBQztFQUFBLElBQUFRLEVBQUE7RUFBQSxJQUFBTCxDQUFBLFFBQUFILGNBQUE7SUFNcUNRLEVBQUE7TUFBQUMsT0FBQSxFQUMzQixjQUFjO01BQUFDLFFBQUEsRUFDYlY7SUFDWixDQUFDO0lBQUFHLENBQUEsTUFBQUgsY0FBQTtJQUFBRyxDQUFBLE1BQUFLLEVBQUE7RUFBQTtJQUFBQSxFQUFBLEdBQUFMLENBQUE7RUFBQTtFQUhEcEIsYUFBYSxDQUFDLFlBQVksRUFBRVcsUUFBUSxFQUFFYyxFQUdyQyxDQUFDO0VBQUEsSUFBQUcsRUFBQTtFQUFBLElBQUFSLENBQUEsUUFBQUosU0FBQSxDQUFBYSxPQUFBLElBQUFULENBQUEsUUFBQUosU0FBQSxDQUFBYyxPQUFBO0lBRXdCRixFQUFBLEdBQUFaLFNBQVMsQ0FBYW9CWWxCPIGFPENEdCBvZiBleGl0U3RhdGUuS2V5TmFtZSBhZ2FpbiB0byBleGl0PC9UZXh0PlxuICApIDogKFxuICAgIDxCeWxpbmU+XG4gICAgICA8S2V5Ym9hcmRTaG9ydGN1dEhpbnQgc2hvcnRjdXQ9XCJFbnRlclwiIGFjdGlvbj1cImNvbmZpcm1cIiAvPlxuICAgICAgPENvbmZpZ3VyYWJsZVNob3J0Y3V0SGludFxuICAgICAgICBhY3Rpb249XCJjb25maXJtOm5vXCJcbiAgICAgICAgY29udGV4dD1cIkNvbmZpcm1hdGlvblwiXG4gICAgICAgIGZhbGxiYWNrPVwiRXNjXCJcbiAgICAgICAgZGVzY3JpcHRpb249XCJjYW5jZWxcIlxuICAgICAgLz5cbiAgICA8L0J5bGluZT5cbikifQ==
