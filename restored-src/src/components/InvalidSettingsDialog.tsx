/**
 * 【文件概述】InvalidSettingsDialog.tsx
 *
 * 在 Claude Code 系统流程中的位置：
 *   启动阶段 → 配置加载 → 设置文件校验 → 本组件（错误处理对话框）
 *
 * 主要职责：
 *   当用户的 settings 文件（如 .claude/settings.json）存在 JSON schema
 *   校验错误时，弹出此对话框，让用户选择：
 *     1. 退出并手动修复（"Exit and fix manually"）
 *     2. 跳过有错误的文件，继续运行（"Continue without these settings"）
 *
 * 与其他模块的关系：
 *   - 使用 Dialog 设计系统组件作为容器
 *   - 使用 ValidationErrorsList 展示具体的校验错误列表
 *   - 使用 CustomSelect 提供操作选项
 *   - props.settingsErrors 由上层启动逻辑传入
 */
import { c as _c } from "react/compiler-runtime";
import React from 'react';
import { Text } from '../ink.js';
import type { ValidationError } from '../utils/settings/validation.js';
import { Select } from './CustomSelect/index.js';
import { Dialog } from './design-system/Dialog.js';
import { ValidationErrorsList } from './ValidationErrorsList.js';

// 组件 Props 类型定义
type Props = {
  settingsErrors: ValidationError[]; // 校验错误列表，由外部解析 settings 文件后传入
  onContinue: () => void;            // 用户选择"继续"时的回调
  onExit: () => void;                // 用户选择"退出"时的回调
};

/**
 * InvalidSettingsDialog — 设置文件校验错误对话框
 *
 * 整体流程：
 *   1. 接收 settingsErrors / onContinue / onExit 三个 props
 *   2. 利用 React Compiler 的缓存机制（_c / $[...]）对 handleSelect 回调
 *      做细粒度 memoization，只在 onContinue 或 onExit 引用变化时重建
 *   3. 渲染 Dialog（标题"Settings Error"，颜色"warning"，按 Esc 触发 onExit）
 *      内部依次展示：错误列表 → 提示文本 → 操作选项
 *
 * 编译器优化说明：
 *   此文件经 React Compiler 编译，变量名 t0–t6 对应各个子树的缓存槽位，
 *   Symbol.for("react.memo_cache_sentinel") 是初始化哨兵，表示槽位尚未写入。
 */
export function InvalidSettingsDialog(t0) {
  // React Compiler 注入的 memoization 缓存，共 13 个槽位
  const $ = _c(13);

  // 从 props 对象中解构三个字段
  const {
    settingsErrors,
    onContinue,
    onExit
  } = t0;

  // ── 缓存槽 0-2：handleSelect 回调 ──────────────────────────────────────
  // 只有当 onContinue 或 onExit 发生变化时才重新创建此函数，避免子组件无谓重渲染
  let t1;
  if ($[0] !== onContinue || $[1] !== onExit) {
    // 根据选项 value 决定调用哪个回调
    t1 = function handleSelect(value) {
      if (value === "exit") {
        onExit();      // 用户选择退出并手动修复
      } else {
        onContinue();  // 用户选择跳过错误继续运行
      }
    };
    // 将新的依赖项和函数存入缓存
    $[0] = onContinue;
    $[1] = onExit;
    $[2] = t1;
  } else {
    // 依赖未变，复用缓存中的函数引用
    t1 = $[2];
  }
  const handleSelect = t1;

  // ── 缓存槽 3-4：ValidationErrorsList 子树 ────────────────────────────────
  // 只在 settingsErrors 数组引用变化时重新创建 JSX 节点
  let t2;
  if ($[3] !== settingsErrors) {
    t2 = <ValidationErrorsList errors={settingsErrors} />;
    $[3] = settingsErrors;
    $[4] = t2;
  } else {
    t2 = $[4];
  }

  // ── 缓存槽 5：静态提示文字 ───────────────────────────────────────────────
  // 纯静态内容，仅首次渲染时创建一次
  let t3;
  if ($[5] === Symbol.for("react.memo_cache_sentinel")) {
    // 说明：有错误的文件会被完整跳过，而不只是跳过其中无效的设置项
    t3 = <Text dimColor={true}>Files with errors are skipped entirely, not just the invalid settings.</Text>;
    $[5] = t3;
  } else {
    t3 = $[5];
  }

  // ── 缓存槽 6：操作选项数组 ───────────────────────────────────────────────
  // options 数组是纯静态的，整个生命周期只创建一次
  let t4;
  if ($[6] === Symbol.for("react.memo_cache_sentinel")) {
    t4 = [{
      label: "Exit and fix manually",      // 退出并手动修复
      value: "exit"
    }, {
      label: "Continue without these settings", // 跳过错误文件继续运行
      value: "continue"
    }];
    $[6] = t4;
  } else {
    t4 = $[6];
  }

  // ── 缓存槽 7-8：Select 组件 ───────────────────────────────────────────────
  // handleSelect 变化时重建 Select 节点（options 是静态的，不影响此判断）
  let t5;
  if ($[7] !== handleSelect) {
    t5 = <Select options={t4} onChange={handleSelect} />;
    $[7] = handleSelect;
    $[8] = t5;
  } else {
    t5 = $[8];
  }

  // ── 缓存槽 9-12：整个 Dialog 节点 ────────────────────────────────────────
  // 当 onExit、ValidationErrorsList 或 Select 任一变化时重建 Dialog
  let t6;
  if ($[9] !== onExit || $[10] !== t2 || $[11] !== t5) {
    // Dialog 外层容器：标题"Settings Error"，警告色，Esc 触发 onExit
    t6 = <Dialog title="Settings Error" onCancel={onExit} color="warning">{t2}{t3}{t5}</Dialog>;
    $[9] = onExit;
    $[10] = t2;
    $[11] = t5;
    $[12] = t6;
  } else {
    t6 = $[12];
  }

  // 返回最终 Dialog 节点
  return t6;
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJSZWFjdCIsIlRleHQiLCJWYWxpZGF0aW9uRXJyb3IiLCJTZWxlY3QiLCJEaWFsb2ciLCJWYWxpZGF0aW9uRXJyb3JzTGlzdCIsIlByb3BzIiwic2V0dGluZ3NFcnJvcnMiLCJvbkNvbnRpbnVlIiwib25FeGl0IiwiSW52YWxpZFNldHRpbmdzRGlhbG9nIiwidDAiLCIkIiwiX2MiLCJ0MSIsImhhbmRsZVNlbGVjdCIsInZhbHVlIiwidDIiLCJ0MyIsIlN5bWJvbCIsImZvciIsInQ0IiwibGFiZWwiLCJ0NSIsInQ2Il0sInNvdXJjZXMiOlsiSW52YWxpZFNldHRpbmdzRGlhbG9nLnRzeCJdLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgUmVhY3QgZnJvbSAncmVhY3QnXG5pbXBvcnQgeyBUZXh0IH0gZnJvbSAnLi4vaW5rLmpzJ1xuaW1wb3J0IHR5cGUgeyBWYWxpZGF0aW9uRXJyb3IgfSBmcm9tICcuLi91dGlscy9zZXR0aW5ncy92YWxpZGF0aW9uLmpzJ1xuaW1wb3J0IHsgU2VsZWN0IH0gZnJvbSAnLi9DdXN0b21TZWxlY3QvaW5kZXguanMnXG5pbXBvcnQgeyBEaWFsb2cgfSBmcm9tICcuL2Rlc2lnbi1zeXN0ZW0vRGlhbG9nLmpzJ1xuaW1wb3J0IHsgVmFsaWRhdGlvbkVycm9yc0xpc3QgfSBmcm9tICcuL1ZhbGlkYXRpb25FcnJvcnNMaXN0LmpzJ1xuXG50eXBlIFByb3BzID0ge1xuICBzZXR0aW5nc0Vycm9yczogVmFsaWRhdGlvbkVycm9yW11cbiAgb25Db250aW51ZTogKCkgPT4gdm9pZFxuICBvbkV4aXQ6ICgpID0+IHZvaWRcbn1cblxuLyoqXG4gKiBEaWFsb2cgc2hvd24gd2hlbiBzZXR0aW5ncyBmaWxlcyBoYXZlIHZhbGlkYXRpb24gZXJyb3JzLlxuICogVXNlciBtdXN0IGNob29zZSB0byBjb250aW51ZSAoc2tpcHBpbmcgaW52YWxpZCBmaWxlcykgb3IgZXhpdCB0byBmaXggdGhlbS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIEludmFsaWRTZXR0aW5nc0RpYWxvZyh7XG4gIHNldHRpbmdzRXJyb3JzLFxuICBvbkNvbnRpbnVlLFxuICBvbkV4aXQsXG59OiBQcm9wcyk6IFJlYWN0LlJlYWN0Tm9kZSB7XG4gIGZ1bmN0aW9uIGhhbmRsZVNlbGVjdCh2YWx1ZTogc3RyaW5nKTogdm9pZCB7XG4gICAgaWYgKHZhbHVlID09PSAnZXhpdCcpIHtcbiAgICAgIG9uRXhpdCgpXG4gICAgfSBlbHNlIHtcbiAgICAgIG9uQ29udGludWUoKVxuICAgIH1cbiAgfVxuXG4gIHJldHVybiAoXG4gICAgPERpYWxvZyB0aXRsZT1cIlNldHRpbmdzIEVycm9yXCIgb25DYW5jZWw9e29uRXhpdH0gY29sb3I9XCJ3YXJuaW5nXCI+XG4gICAgICA8VmFsaWRhdGlvbkVycm9yc0xpc3QgZXJyb3JzPXtzZXR0aW5nc0Vycm9yc30gLz5cbiAgICAgIDxUZXh0IGRpbUNvbG9yPlxuICAgICAgICBGaWxlcyB3aXRoIGVycm9ycyBhcmUgc2tpcHBlZCBlbnRpcmVseSwgbm90IGp1c3QgdGhlIGludmFsaWQgc2V0dGluZ3MuXG4gICAgICA8L1RleHQ+XG4gICAgICA8U2VsZWN0XG4gICAgICAgIG9wdGlvbnM9e1tcbiAgICAgICAgICB7IGxhYmVsOiAnRXhpdCBhbmQgZml4IG1hbnVhbGx5JywgdmFsdWU6ICdleGl0JyB9LFxuICAgICAgICAgIHtcbiAgICAgICAgICAgIGxhYmVsOiAnQ29udGludWUgd2l0aG91dCB0aGVzZSBzZXR0aW5ncycsXG4gICAgICAgICAgICB2YWx1ZTogJ2NvbnRpbnVlJyxcbiAgICAgICAgICB9LFxuICAgICAgICBdfVxuICAgICAgICBvbkNoYW5nZT17aGFuZGxlU2VsZWN0fVxuICAgICAgLz5cbiAgICA8L0RpYWxvZz5cbiAgKVxufVxuIl0sIm1hcHBpbmdzIjoiO0FBQUEsT0FBT0EsS0FBSyxNQUFNLE9BQU87QUFDekIsU0FBU0MsSUFBSSxRQUFRLFdBQVc7QUFDaEMsY0FBY0MsZUFBZSxRQUFRLGlDQUFpQztBQUN0RSxTQUFTQyxNQUFNLFFB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
