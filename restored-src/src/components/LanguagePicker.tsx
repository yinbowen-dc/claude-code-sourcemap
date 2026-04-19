/**
 * 【文件概述】LanguagePicker.tsx
 *
 * 在 Claude Code 系统流程中的位置：
 *   设置界面 → 语言设置项 → 本组件（交互式语言选择器）
 *
 * 主要职责：
 *   提供一个基于文本输入的语言选择器，允许用户输入他们期望的回复语言
 *   （同时也用于语音模式的语言设定）。用户可以输入任意语言名称，
 *   留空则恢复默认值（英语）。
 *
 * 关键设计决策：
 *   - 使用 useKeybinding('confirm:no', onCancel, { context: 'Settings' })
 *     绑定取消操作，并指定 'Settings' 上下文，防止用户在输入框中键入 'n'
 *     时误触发取消（普通上下文中 'n' 键会触发 confirm:no 动作）
 *   - cursorOffset 独立状态跟踪光标位置，初始值设为当前语言字符串长度
 *     （即光标定位到末尾）
 *   - onSubmit 时对输入值 trim() 并在空串情况下返回 undefined
 */
import { c as _c } from "react/compiler-runtime";
import figures from 'figures';
import React, { useState } from 'react';
import { Box, Text } from '../ink.js';
import { useKeybinding } from '../keybindings/useKeybinding.js';
import TextInput from './TextInput.js';

// 组件 Props 类型定义
type Props = {
  initialLanguage: string | undefined;                       // 初始语言值（来自已保存的设置）
  onComplete: (language: string | undefined) => void;        // 确认提交时的回调
  onCancel: () => void;                                      // 取消时的回调
};

/**
 * LanguagePicker — 语言选择器组件
 *
 * 整体流程：
 *   1. 初始化 language 状态（来自 initialLanguage prop）
 *   2. 初始化 cursorOffset 状态（初始光标位于字符串末尾）
 *   3. 注册 confirm:no 键位绑定（Settings 上下文），防止 'n' 键干扰输入
 *   4. 构造 handleSubmit：trim 输入值后回调，空值返回 undefined（恢复默认）
 *   5. 渲染：提示文字 → 输入行（指针符号 + TextInput）→ 提示默认值文字
 *
 * React Compiler memoization 策略：
 *   - 静态内容（提示文字、指针符号、keybinding options、底部提示）只创建一次
 *   - TextInput 行在 cursorOffset / handleSubmit / language 任一变化时重建
 *   - 外层 Box 在 TextInput 行变化时重建
 */
export function LanguagePicker(t0) {
  // React Compiler 注入的 memoization 缓存，共 13 个槽位
  const $ = _c(13);

  // 解构 props
  const {
    initialLanguage,
    onComplete,
    onCancel
  } = t0;

  // 语言输入值状态，初始化为 prop 传入的语言值
  const [language, setLanguage] = useState(initialLanguage);

  // 光标偏移量状态，初始化为当前语言字符串的长度（光标置于末尾）
  const [cursorOffset, setCursorOffset] = useState((initialLanguage ?? "").length);

  // ── 缓存槽 0：keybinding options 对象（静态，只创建一次）────────────────
  let t1;
  if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
    // context: 'Settings' 确保在此输入框场景下，'n' 键不会触发 confirm:no
    t1 = {
      context: "Settings"
    };
    $[0] = t1;
  } else {
    t1 = $[0];
  }
  // 注册取消键位绑定（ESC 或 'n'，但受 Settings 上下文约束）
  useKeybinding("confirm:no", onCancel, t1);

  // ── 缓存槽 1-3：handleSubmit 回调 ───────────────────────────────────────
  // language 或 onComplete 变化时重建
  let t2;
  if ($[1] !== language || $[2] !== onComplete) {
    t2 = function handleSubmit() {
      const trimmed = language?.trim(); // 去除首尾空白
      // 若 trim 后为空字符串，则传 undefined（恢复系统默认语言 English）
      onComplete(trimmed || undefined);
    };
    $[1] = language;
    $[2] = onComplete;
    $[3] = t2;
  } else {
    t2 = $[3];
  }
  const handleSubmit = t2;

  // ── 缓存槽 4：静态提示文字 ───────────────────────────────────────────────
  let t3;
  if ($[4] === Symbol.for("react.memo_cache_sentinel")) {
    t3 = <Text>Enter your preferred response and voice language:</Text>;
    $[4] = t3;
  } else {
    t3 = $[4];
  }

  // ── 缓存槽 5：静态指针符号 ───────────────────────────────────────────────
  let t4;
  if ($[5] === Symbol.for("react.memo_cache_sentinel")) {
    // figures.pointer 是当前终端环境下的指针字符（› 或 >）
    t4 = <Text>{figures.pointer}</Text>;
    $[5] = t4;
  } else {
    t4 = $[5];
  }

  // language 有可能为 undefined，此处归一化为空字符串以满足 TextInput 的 value 类型要求
  const t5 = language ?? "";

  // ── 缓存槽 6-9：包含 TextInput 的输入行 ─────────────────────────────────
  // cursorOffset、handleSubmit 或输入值任一变化时重建
  let t6;
  if ($[6] !== cursorOffset || $[7] !== handleSubmit || $[8] !== t5) {
    t6 = <Box flexDirection="row" gap={1}>
      {t4}
      <TextInput
        value={t5}
        onChange={setLanguage}          // 用户输入时同步更新 language 状态
        onSubmit={handleSubmit}         // Enter 键触发提交
        focus={true}                    // 自动聚焦
        showCursor={true}               // 显示光标
        placeholder={`e.g., Japanese, 日本語, Español${figures.ellipsis}`} // 多语言示例占位符
        columns={60}                    // 输入框宽度
        cursorOffset={cursorOffset}
        onChangeCursorOffset={setCursorOffset}
      />
    </Box>;
    $[6] = cursorOffset;
    $[7] = handleSubmit;
    $[8] = t5;
    $[9] = t6;
  } else {
    t6 = $[9];
  }

  // ── 缓存槽 10：静态底部提示文字 ─────────────────────────────────────────
  let t7;
  if ($[10] === Symbol.for("react.memo_cache_sentinel")) {
    // 提示用户留空即可恢复英语默认
    t7 = <Text dimColor={true}>Leave empty for default (English)</Text>;
    $[10] = t7;
  } else {
    t7 = $[10];
  }

  // ── 缓存槽 11-12：外层 Box ───────────────────────────────────────────────
  // 仅在输入行变化时重建外层容器
  let t8;
  if ($[11] !== t6) {
    t8 = <Box flexDirection="column" gap={1}>{t3}{t6}{t7}</Box>;
    $[11] = t6;
    $[12] = t8;
  } else {
    t8 = $[12];
  }

  // 返回最终渲染结果
  return t8;
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJmaWd1cmVzIiwiUmVhY3QiLCJ1c2VTdGF0ZSIsIkJveCIsIlRleHQiLCJ1c2VLZXliaW5kaW5nIiwiVGV4dElucHV0IiwiUHJvcHMiLCJpbml0aWFsTGFuZ3VhZ2UiLCJvbkNvbXBsZXRlIiwibGFuZ3VhZ2UiLCJvbkNhbmNlbCIsIkxhbmd1YWdlUGlja2VyIiwidDAiLCIkIiwiX2MiLCJzZXRMYW5ndWFnZSIsImN1cnNvck9mZnNldCIsInNldEN1cnNvck9mZnNldCIsImxlbmd0aCIsInQxIiwiU3ltYm9sIiwiZm9yIiwiY29udGV4dCIsInQyIiwiaGFuZGxlU3VibWl0IiwidHJpbW1lZCIsInRyaW0iLCJ1bmRlZmluZWQiLCJ0MyIsInQ0IiwicG9pbnRlciIsInQ1IiwidDYiLCJlbGxpcHNpcyIsInQ3IiwidDgiXSwic291cmNlcyI6WyJMYW5ndWFnZVBpY2tlci50c3giXSwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IGZpZ3VyZXMgZnJvbSAnZmlndXJlcydcbmltcG9ydCBSZWFjdCwgeyB1c2VTdGF0ZSB9IGZyb20gJ3JlYWN0J1xuaW1wb3J0IHsgQm94LCBUZXh0IH0gZnJvbSAnLi4vaW5rLmpzJ1xuaW1wb3J0IHsgdXNlS2V5YmluZGluZyB9IGZyb20gJy4uL2tleWJpbmRpbmdzL3VzZUtleWJpbmRpbmcuanMnXG5pbXBvcnQgVGV4dElucHV0IGZyb20gJy4vVGV4dElucHV0LmpzJ1xuXG50eXBlIFByb3BzID0ge1xuICBpbml0aWFsTGFuZ3VhZ2U6IHN0cmluZyB8IHVuZGVmaW5lZFxuICBvbkNvbXBsZXRlOiAobGFuZ3VhZ2U6IHN0cmluZyB8IHVuZGVmaW5lZCkgPT4gdm9pZFxuICBvbkNhbmNlbDogKCkgPT8gdm9pZFxufVxuXG5leHBvcnQgZnVuY3Rpb24gTGFuZ3VhZ2VQaWNrZXIoe1xuICBpbml0aWFsTGFuZ3VhZ2UsXG4gIG9uQ29tcGxldGUsXG4gIG9uQ2FuY2VsLFxufTogUHJvcHMpOiBSZWFjdC5SZWFjdE5vZGUge1xuICBjb25zdCBbbGFuZ3VhZ2UsIHNldExhbmd1YWdlXSA9IHVzZVN0YXRlKGluaXRpYWxMYW5ndWFnZSlcbiAgY29uc3QgW2N1cnNvck9mZnNldCwgc2V0Q3Vyc29yT2Zmc2V0XSA9IHVzZVN0YXRlKFxuICAgIChpbml0aWFsTGFuZ3VhZ2UgPz8gJycpLmxlbmd0aCxcbiAgKVxuXG4gIC8vIFVzZSBjb25maWd1cmFibGUga2V5YmluZGluZyBmb3IgRVNDIHRvIGNhbmNlbFxuICAvLyBVc2UgU2V0dGluZ3MgY29udGV4dCBzbyAnbicga2V5IGRvZXNuJ3QgdHJpZ2dlciBjYW5jZWwgKGFsbG93cyB0eXBpbmcgJ24nIGluIGlucHV0KVxuICB1c2VLZXliaW5kaW5nKCdjb25maXJtOm5vJywgb25DYW5jZWwsIHsgY29udGV4dDogJ1NldHRpbmdzJyB9KVxuXG4gIGZ1bmN0aW9uIGhhbmRsZVN1Ym1pdCgpOiB2b2lkIHtcbiAgICBjb25zdCB0cmltbWVkID0gbGFuZ3VhZ2U/LnRyaW0oKVxuICAgIG9uQ29tcGxldGUodHJpbW1lZCB8fCB1bmRlZmluZWQpXG4gIH1cblxuICByZXR1cm4gKFxuICAgIDxCb3ggZmxleERpcmVjdGlvbj1cImNvbHVtblwiIGdhcD17MX0+XG4gICAgICA8VGV4dD5FbnRlciB5b3VyIHByZWZlcnJlZCByZXNwb25zZSBhbmQgdm9pY2UgbGFuZ3VhZ2U6PC9UZXh0PlxuICAgICAgPEJveCBmbGV4RGlyZWN0aW9uPVwicm93XCIgZ2FwPXsxfT5cbiAgICAgICAgPFRleHQ+e2ZpZ3VyZXMucG9pbnRlcn08L1RleHQ+XG4gICAgICAgIDxUZXh0SW5wdXRcbiAgICAgICAgICB2YWx1ZT17bGFuZ3VhZ2UgPz8gJyd9XG4gICAgICAgICAgb25DaGFuZ2U9e3NldExhbmd1YWdlfVxuICAgICAgICAgIG9uU3VibWl0PXtoYW5kbGVTdWJtaXR9XG4gICAgICAgICAgZm9jdXM9e3RydWV9XG4gICAgICAgICAgc2hvd0N1cnNvcj17dHJ1ZX1cbiAgICAgICAgICBwbGFjZWhvbGRlcj17YGUuZy4sIEphcGFuZXNlLCDml6XmnKzoqp4sIEVzcGHDsW9sJHtmaWd1cmVzLmVsbGlwc2lzfWB9XG4gICAgICAgICAgY29sdW1ucz17NjB9XG4gICAgICAgICAgY3Vyc29yT2Zmc2V0PXtjdXJzb3JPZmZzZXR9XG4gICAgICAgICAgb25DaGFuZ2VDdXJzb3JPZmZzZXQ9e3NldEN1cnNvck9mZnNldH1cbiAgICAgICAgLz5cbiAgICAgIDwvQm94PlxuICAgICAgPFRleHQgZGltQ29sb3I+TGVhdmUgZW1wdHkgZm9yIGRlZmF1bHQgKEVuZ2xpc2gpPC9UZXh0PlxuICAgIDwvQm94PlxuICApXG59XG4iXSwibWFwcGluZ3MiOiI7QUFBQSxPQUFPQSxPQUFPLE1BQU0sU0FBUztBQUM3QixPQUFPQyxLQUFLLElBQUlDLFFBQVEsUUFBUSxPQUFPO0FBQ3ZDLFNBQVNDLEdBQUcsRUFBRUMsSUFBSSxRQUFRLFdBQVc7QUFDckMsU0FBU0MsYUFBYSxRQUFRLGlDQUFpQztBQUMvRCxPQUFPQyxTQUFTLE1BQU0sZ0JBQWdCO0FBRXRDLEtBQUtDLEtBQUssR0FBRztFQUNYQyxlQUFlLEVBQUUsTUFBTSxHQUFHLFNBQVM7RUFDbkNDLFVBQVUsRUFBRSxDQUFDQyxRQUFRLEVBQUUsTUFBTSxHQUFHLFNBQVMsRUFBRSxHQUFHLElBQUk7RUFDbERDLFFBQVEsRUFBRSxHQUFHLEdBQUcsSUFBSTtBQUN0QixDQUFDO0FBRUQsT0FBTyxTQUFBQyxlQUFBQyxFQUFBO0VBQUEsTUFBQUMsQ0FBQSxHQUFBQyxFQUFBO0VBQXdCO0lBQUFQLGVBQUE7SUFBQUMsVUFBQTtJQUFBRTtFQUFBLElBQUFFLEVBSXZCO0VBQ04sT0FBQUgsUUFBQSxFQUFBTSxXQUFBLElBQWdDZCxRQUFRLENBQUNNLGVBQWUsQ0FBQztFQUN6RCxPQUFBUyxZQUFBLEVBQUFDLGVBQUEsSUFBd0NoQixRQUFRLENBQzlDLENBQUNNLGVBQXFCLElBQXJCLEVBQXFCLEVBQUFXLE1BQ3hCLENBQUM7RUFBQSxJQUFBQyxFQUFBO0VBQUEsSUFBQU4sQ0FBQSxRQUFBTyxNQUFBLENBQUFDLEdB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
