/**
 * DevChannelsDialog.tsx — 开发频道加载警告对话框组件
 *
 * 在 Claude Code 系统流程中的位置：
 *   启动引导层 → 频道安全检查 → 开发频道危险性确认对话框
 *
 * 主要功能：
 *   1. DevChannelsDialog：React 组件，当用户使用 --dangerously-load-development-channels
 *      标志启动时展示安全警告弹窗，提示本地开发频道风险，要求用户明确确认或退出。
 *   2. onChange（内联回调）：处理用户在弹窗中的选择——"accept" 调用 onAccept 继续，
 *      "exit" 调用 gracefulShutdownSync(1) 以非零状态退出进程。
 *   3. _temp2（React Compiler 提取的辅助函数）：将 ChannelEntry 格式化为可读字符串，
 *      区分 plugin 和 server 两种频道类型。
 *   4. _temp（React Compiler 提取的辅助函数）：Escape 键处理回调，
 *      调用 gracefulShutdownSync(0) 优雅退出进程。
 *
 * 安全设计：
 *   弹窗使用 color="error" 红色边框高亮，强调危险性；
 *   用户只能选择"我在本地开发中使用"或"退出"，不提供静默跳过选项。
 */
import { c as _c } from "react/compiler-runtime";
import React, { useCallback } from 'react';
import type { ChannelEntry } from '../bootstrap/state.js';
import { Box, Text } from '../ink.js';
import { gracefulShutdownSync } from '../utils/gracefulShutdown.js';
import { Select } from './CustomSelect/index.js';
import { Dialog } from './design-system/Dialog.js';

// Props 类型：channels 为当前加载的开发频道列表，onAccept 为用户确认后的回调
type Props = {
  channels: ChannelEntry[];
  onAccept(): void;
};

/**
 * DevChannelsDialog 组件
 *
 * 整体流程：
 *   1. 解构 channels（频道列表）和 onAccept（确认回调）Props
 *   2. 构建 onChange 处理函数（依赖 onAccept，缓存于 $[0]-$[1]）：
 *      - "accept" → 调用 onAccept() 继续加载
 *      - "exit"   → 调用 gracefulShutdownSync(1) 退出进程
 *   3. handleEscape 绑定到 _temp（Escape 键触发优雅退出）
 *   4. 静态警告文本（sentinel 缓存于 $[2]-$[3]，只创建一次）
 *   5. 将 channels 格式化为逗号分隔字符串（依赖 channels，缓存于 $[4]-$[5]）
 *   6. 构建正文 Box（依赖 t4，缓存于 $[6]-$[7]）
 *   7. 构建静态选项数组（sentinel 缓存于 $[8]，只创建一次）
 *   8. 构建 Select 组件（依赖 onChange，缓存于 $[9]-$[10]）
 *   9. 构建最终 Dialog（依赖 t5 + t7，缓存于 $[11]-$[13]）
 *
 * 在系统中的角色：
 *   作为安全门禁，防止用户无意间加载不受信任的开发频道。
 */
export function DevChannelsDialog(t0) {
  // _c(14)：初始化 14 个 React Compiler 记忆缓存槽
  const $ = _c(14);
  const {
    channels,
    onAccept
  } = t0;

  let t1;
  // $[0]-$[1] 槽：以 onAccept 为依赖缓存 onChange 回调，onAccept 变化时重建
  if ($[0] !== onAccept) {
    // onAccept 变化：重新创建 onChange 处理函数
    t1 = function onChange(value) {
      // 带标签的 switch，用于 React Compiler 生成的跳出语法（bb2 标签）
      bb2: switch (value) {
        case "accept":
          {
            // 用户确认：调用父组件传入的 onAccept 回调继续流程
            onAccept();
            break bb2;
          }
        case "exit":
          {
            // 用户拒绝：以状态码 1 优雅退出进程
            gracefulShutdownSync(1);
          }
      }
    };
    $[0] = onAccept;  // 存储依赖
    $[1] = t1;        // 存储回调结果
  } else {
    // onAccept 未变：复用缓存的 onChange 回调
    t1 = $[1];
  }
  const onChange = t1;

  // handleEscape：Escape 键处理，绑定到提取的 _temp 函数（优雅退出）
  const handleEscape = _temp;

  let t2;
  let t3;
  // $[2]-$[3] 槽：两段静态警告文本，sentinel 缓存确保只创建一次
  if ($[2] === Symbol.for("react.memo_cache_sentinel")) {
    // 首次渲染：创建两段静态文本并缓存
    t2 = <Text>--dangerously-load-development-channels is for local channel development only. Do not use this option to run channels you have downloaded off the internet.</Text>;
    t3 = <Text>Please use --channels to run a list of approved channels.</Text>;
    $[2] = t2;
    $[3] = t3;
  } else {
    // 缓存命中：复用静态文本节点
    t2 = $[2];
    t3 = $[3];
  }

  let t4;
  // $[4]-$[5] 槽：以 channels 为依赖缓存格式化后的频道字符串
  if ($[4] !== channels) {
    // channels 变化：重新格式化所有频道并用逗号连接
    t4 = channels.map(_temp2).join(", ");
    $[4] = channels;  // 存储依赖
    $[5] = t4;        // 存储格式化结果
  } else {
    // channels 未变：复用缓存的字符串
    t4 = $[5];
  }

  let t5;
  // $[6]-$[7] 槽：以 t4（频道字符串）为依赖缓存正文 Box
  if ($[6] !== t4) {
    // 频道字符串变化：重新构建正文布局
    t5 = <Box flexDirection="column" gap={1}>{t2}{t3}<Text dimColor={true}>Channels:{" "}{t4}</Text></Box>;
    $[6] = t4;   // 存储依赖
    $[7] = t5;   // 存储 JSX 结果
  } else {
    // 未变：复用缓存的 Box
    t5 = $[7];
  }

  let t6;
  // $[8] 槽：静态选项数组，sentinel 缓存确保只创建一次
  if ($[8] === Symbol.for("react.memo_cache_sentinel")) {
    // 首次渲染：创建选项列表并缓存
    t6 = [{
      label: "I am using this for local development",
      value: "accept"
    }, {
      label: "Exit",
      value: "exit"
    }];
    $[8] = t6;
  } else {
    // 缓存命中：复用静态选项数组
    t6 = $[8];
  }

  let t7;
  // $[9]-$[10] 槽：以 onChange 为依赖缓存 Select 组件
  if ($[9] !== onChange) {
    // onChange 变化：重新创建 Select 组件（以捕获最新的 onChange 引用）
    t7 = <Select options={t6} onChange={value_0 => onChange(value_0 as 'accept' | 'exit')} />;
    $[9] = onChange;  // 存储依赖
    $[10] = t7;       // 存储 JSX 结果
  } else {
    // onChange 未变：复用缓存的 Select
    t7 = $[10];
  }

  let t8;
  // $[11]-$[13] 槽：以 t5 和 t7 为双重依赖缓存最终 Dialog
  if ($[11] !== t5 || $[12] !== t7) {
    // 正文或选择组件有变：重新构建完整 Dialog
    t8 = <Dialog title="WARNING: Loading development channels" color="error" onCancel={handleEscape}>{t5}{t7}</Dialog>;
    $[11] = t5;   // 存储 t5 依赖
    $[12] = t7;   // 存储 t7 依赖
    $[13] = t8;   // 存储 Dialog JSX
  } else {
    // 均未变：复用缓存的 Dialog
    t8 = $[13];
  }
  return t8;
}

/**
 * _temp2（React Compiler 提取的辅助函数）
 *
 * 整体流程：
 *   - 原始源码中为 channels.map(c => ...) 的内联箭头函数
 *   - React Compiler 将其提取到模块作用域，避免每次渲染重新创建函数引用
 *   - plugin 类型：格式化为 "plugin:名称@市场地址"
 *   - server 类型：格式化为 "server:名称"
 *
 * 在系统中的角色：
 *   为频道列表展示提供可读的格式化字符串，帮助用户识别正在加载的频道。
 */
function _temp2(c) {
  // 根据频道类型选择格式：plugin 包含市场地址，server 仅包含名称
  return c.kind === "plugin" ? `plugin:${c.name}@${c.marketplace}` : `server:${c.name}`;
}

/**
 * _temp（React Compiler 提取的辅助函数）
 *
 * 整体流程：
 *   - 原始源码中为 handleEscape = useCallback(() => gracefulShutdownSync(0), []) 的内联函数
 *   - React Compiler 将其提取到模块作用域（等效于依赖为空的 useCallback）
 *   - 当用户按下 Escape 键时触发，以状态码 0 优雅退出进程
 *
 * 在系统中的角色：
 *   为 Dialog 的 onCancel 提供 Escape 键处理，允许用户安全取消并退出。
 */
function _temp() {
  // 以状态码 0（正常）优雅退出进程
  gracefulShutdownSync(0);
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJSZWFjdCIsInVzZUNhbGxiYWNrIiwiQ2hhbm5lbEVudHJ5IiwiQm94IiwiVGV4dCIsImdyYWNlZnVsU2h1dGRvd25TeW5jIiwiU2VsZWN0IiwiRGlhbG9nIiwiUHJvcHMiLCJjaGFubmVscyIsIm9uQWNjZXB0IiwiRGV2Q2hhbm5lbHNEaWFsb2ciLCJ0MCIsIiQiLCJfYyIsInQxIiwib25DaGFuZ2UiLCJ2YWx1ZSIsImJiMiIsImhhbmRsZUVzY2FwZSIsIl90ZW1wIiwidDIiLCJ0MyIsIlN5bWJvbCIsImZvciIsInQ0IiwibWFwIiwiX3RlbXAyIiwiam9pbiIsInQ1IiwidDYiLCJsYWJlbCIsInQ3IiwidmFsdWVfMCIsInQ4IiwiYyIsImtpbmQiLCJuYW1lIiwibWFya2V0cGxhY2UiXSwic291cmNlcyI6WyJEZXZDaGFubmVsc0RpYWxvZy50c3giXSwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IFJlYWN0LCB7IHVzZUNhbGxiYWNrIH0gZnJvbSAncmVhY3QnXG5pbXBvcnQgdHlwZSB7IENoYW5uZWxFbnRyeSB9IGZyb20gJy4uL2Jvb3RzdHJhcC9zdGF0ZS5qcydcbmltcG9ydCB7IEJveCwgVGV4dCB9IGZyb20gJy4uL2luay5qcydcbmltcG9ydCB7IGdyYWNlZnVsU2h1dGRvd25TeW5jIH0gZnJvbSAnLi4vdXRpbHMvZ3JhY2VmdWxTaHV0ZG93bi5qcydcbmltcG9ydCB7IFNlbGVjdCB9IGZyb20gJy4vQ3VzdG9tU2VsZWN0L2luZGV4LmpzJ1xuaW1wb3J0IHsgRGlhbG9nIH0gZnJvbSAnLi9kZXNpZ24tc3lzdGVtL0RpYWxvZy5qcydcblxudHlwZSBQcm9wcyA9IHtcbiAgY2hhbm5lbHM6IENoYW5uZWxFbnRyeVtdXG4gIG9uQWNjZXB0KCk6IHZvaWRcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIERldkNoYW5uZWxzRGlhbG9nKHtcbiAgY2hhbm5lbHMsXG4gIG9uQWNjZXB0LFxufTogUHJvcHMpOiBSZWFjdC5SZWFjdE5vZGUge1xuICBmdW5jdGlvbiBvbkNoYW5nZSh2YWx1ZTogJ2FjY2VwdCcgfCAnZXhpdCcpIHtcbiAgICBzd2l0Y2ggKHZhbHVlKSB7XG4gICAgICBjYXNlICdhY2NlcHQnOlxuICAgICAgICBvbkFjY2VwdCgpXG4gICAgICAgIGJyZWFrXG4gICAgICBjYXNlICdleGl0JzpcbiAgICAgICAgZ3JhY2VmdWxTaHV0ZG93blN5bmMoMSlcbiAgICAgICAgYnJlYWtcbiAgICB9XG4gIH1cblxuICBjb25zdCBoYW5kbGVFc2NhcGUgPSB1c2VDYWxsYmFjaygoKSA9PiB7XG4gICAgZ3JhY2VmdWxTaHV0ZG93blN5bmMoMClcbiAgfSwgW10pXG5cbiAgcmV0dXJuIChcbiAgICA8RGlhbG9nXG4gICAgICB0aXRsZT1cIldBUk5JTkc6IExvYWRpbmcgZGV2ZWxvcG1lbnQgY2hhbm5lbHNcIlxuICAgICAgY29sb3I9XCJlcnJvclwiXG4gICAgICBvbkNhbmNlbD17aGFuZGxlRXNjYXBlfVxuICAgID5cbiAgICAgIDxCb3ggZmxleERpcmVjdGlvbj1cImNvbHVtblwiIGdhcD17MX0+XG4gICAgICAgIDxUZXh0PlxuICAgICAgICAgIC0tZGFuZ2Vyb3VzbHktbG9hZC1kZXZlbG9wbWVudC1jaGFubmVscyBpcyBmb3IgbG9jYWwgY2hhbm5lbFxuICAgICAgICAgIGRldmVsb3BtZW50IG9ubHkuIERvIG5vdCB1c2UgdGhpcyBvcHRpb24gdG8gcnVuIGNoYW5uZWxzIHlvdSBoYXZlXG4gICAgICAgICAgZG93bmxvYWRlZCBvZmYgdGhlIGludGVybmV0LlxuICAgICAgICA8L1RleHQ+XG4gICAgICAgIDxUZXh0PlBsZWFzZSB1c2UgLS1jaGFubmVscyB0byBydW4gYSBsaXN0IG9mIGFwcHJvdmVkIGNoYW5uZWxzLjwvVGV4dD5cbiAgICAgICAgPFRleHQgZGltQ29sb3I+XG4gICAgICAgICAgQ2hhbm5lbHM6eycgJ31cbiAgICAgICAgICB7Y2hhbm5lbHNcbiAgICAgICAgICAgIC5tYXAoYyA9PlxuICAgICAgICAgICAgICBjLmtpbmQgPT09ICdwbHVnaW4nXG4gICAgICAgICAgICAgICAgPyBgcGx1Z2luOiR7Yy5uYW1lfUAke2MubWFya2V0cGxhY2V9YFxuICAgICAgICAgICAgICAgIDogYHNlcnZlcjoke2MubmFtZX1gLFxuICAgICAgICAgICAgKVxuICAgICAgICAgICAgLmpvaW4oJywgJyl9XG4gICAgICAgIDwvVGV4dD5cbiAgICAgIDwvQm94PlxuXG4gICAgICA8U2VsZWN0XG4gICAgICAgIG9wdGlvbnM9e1tcbiAgICAgICAgICB7IGxhYmVsOiAnSSBhbSB1c2luZyB0aGlzIGZvciBsb2NhbCBkZXZlbG9wbWVudCcsIHZhbHVlOiAnYWNjZXB0JyB9LFxuICAgICAgICAgIHsgbGFiZWw6ICdFeGl0JywgdmFsdWU6ICdleGl0JyB9LFxuICAgICAgICBdfVxuICAgICAgICBvbkNoYW5nZT17dmFsdWUgPT4gb25DaGFuZ2UodmFsdWUgYXMgJ2FjY2VwdCcgfCAnZXhpdCcpfVxuICAgICAgLz5cbiAgICA8L0RpYWxvZz5cbiAgKVxufVxuIl0sIm1hcHBpbmdzIjoiO0FBQUEsT0FBT0EsS0FBSyxJQUFJQyxXQUFXLFFBQVEsT0FBTztBQUMxQyxjQUFjQyxZQUFZLFFBQVEsdUJBQXVCO0FBQ3pELFNBQVNDLEdBQUcsRUFBRUMsSUFBSSxRQUFRLFdBQVc7QUFDckMsU0FBU0Msb0JBQW9CLFFBQVEsOEJBQThCO0FBQ25FLFNBQVNDLE1BQU0sUUFBUSx5QkFBeUI7QUFDaEQsU0FBU0MsTUFBTSxRQUFRLDJCQUEyQjtBQUVsRCxLQUFLQyxLQUFLLEdBQUc7RUFDWEMsUUFBUSxFQUFFUCxZQUFZLEVBQUU7RUFDeEJRLFFBQVEsRUFBRSxFQUFFLElBQUk7QUFDbEIsQ0FBQztBQUVELE9BQU8sU0FBQUMsa0JBQUFDLEVBQUE7RUFBQSxNQUFBQyxDQUFBLEdBQUFDLEVBQUE7RUFBMkI7SUFBQUwsUUFBQTtJQUFBQztFQUFBLElBQUFFLEVBRzFCO0VBQUEsSUFBQUcsRUFBQTtFQUFBLElBQUFGLENBQUEsUUFBQUgsUUFBQTtJQUNOSyxFQUFBLFlBQUFDLFNBQUFDLEtBQUE7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