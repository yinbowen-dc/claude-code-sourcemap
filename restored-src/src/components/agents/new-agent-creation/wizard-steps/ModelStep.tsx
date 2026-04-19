/**
 * ModelStep.tsx — Agent 创建向导：选择 AI 模型步骤
 *
 * 在 Claude Code 系统流程中的位置：
 *   AgentTool → new-agent-creation/AgentWizard → wizard-steps/ModelStep（当前文件）
 *
 * 主要功能：
 *   - 向用户呈现可用的 AI 模型列表（通过 ModelSelector 组件）
 *   - 允许用户从向导共享数据中已有的 selectedModel 继续（编辑模式）
 *   - 确认选择后将 selectedModel 写入 wizardData 并调用 goNext() 进入下一步
 *
 * 依赖：
 *   - react/compiler-runtime (_c)：React 编译器自动生成的记忆化缓存机制
 *   - useWizard：wizard 上下文钩子
 *   - ModelSelector：封装了模型列表展示与选择逻辑的组件
 */
import { c as _c } from "react/compiler-runtime";
import React, { type ReactNode } from 'react';
import { ConfigurableShortcutHint } from '../../../ConfigurableShortcutHint.js';
import { Byline } from '../../../design-system/Byline.js';
import { KeyboardShortcutHint } from '../../../design-system/KeyboardShortcutHint.js';
import { useWizard } from '../../../wizard/index.js';
import { WizardDialogLayout } from '../../../wizard/WizardDialogLayout.js';
import { ModelSelector } from '../../ModelSelector.js';
import type { AgentWizardData } from '../types.js';

/**
 * ModelStep — 向导模型选择步骤。
 *
 * 整体流程：
 *   1. 从 useWizard 获取 goNext / goBack / updateWizardData / wizardData
 *   2. 构建 handleComplete 回调：保存所选模型并前进到下一步
 *   3. 构建静态底部快捷键提示 JSX（React 编译器确保只创建一次）
 *   4. 将上述内容组装为 WizardDialogLayout + ModelSelector 返回
 *
 * 注意：wizardData.selectedModel 可能为 undefined（表示使用默认模型）。
 */
export function ModelStep() {
  // React 编译器生成的记忆化缓存，共 8 个槽位
  const $ = _c(8);

  // 从向导上下文获取导航方法和共享数据
  const {
    goNext,
    goBack,
    updateWizardData,
    wizardData
  } = useWizard();

  // ── 槽位 $[0-2]：handleComplete 回调（依赖 goNext / updateWizardData）─────
  let t0;
  if ($[0] !== goNext || $[1] !== updateWizardData) {
    // 任意依赖变化时，重新创建回调
    t0 = model => {
      // 将用户选择的模型（可选）写入 wizard 共享数据
      updateWizardData({
        selectedModel: model
      });
      // 前进到下一个向导步骤
      goNext();
    };
    $[0] = goNext;
    $[1] = updateWizardData;
    $[2] = t0; // 缓存新回调
  } else {
    t0 = $[2]; // 依赖未变，复用已缓存的回调
  }
  const handleComplete = t0;

  // ── 槽位 $[3]：静态底部快捷键提示 JSX（仅首次渲染时创建）────────────────
  let t1;
  if ($[3] === Symbol.for("react.memo_cache_sentinel")) {
    // 哨兵值说明该槽未初始化，创建快捷键提示：↑↓ 导航、Enter 选择、Esc 返回
    t1 = <Byline><KeyboardShortcutHint shortcut={"\u2191\u2193"} action="navigate" /><KeyboardShortcutHint shortcut="Enter" action="select" /><ConfigurableShortcutHint action="confirm:no" context="Confirmation" fallback="Esc" description="go back" /></Byline>;
    $[3] = t1; // 写入缓存
  } else {
    t1 = $[3]; // 从缓存读取，跳过重复创建
  }

  // ── 槽位 $[4-7]：最终渲染的 JSX（依赖 goBack / handleComplete / selectedModel）
  let t2;
  if ($[4] !== goBack || $[5] !== handleComplete || $[6] !== wizardData.selectedModel) {
    // 任意依赖变化时，重建整个对话框 JSX
    t2 = <WizardDialogLayout subtitle="Select model" footerText={t1}><ModelSelector initialModel={wizardData.selectedModel} onComplete={handleComplete} onCancel={goBack} /></WizardDialogLayout>;
    $[4] = goBack;
    $[5] = handleComplete;
    $[6] = wizardData.selectedModel; // 追踪当前已选模型，用于初始化 ModelSelector
    $[7] = t2;
  } else {
    t2 = $[7]; // 结构未变，复用缓存的 JSX
  }
  return t2;
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJSZWFjdCIsIlJlYWN0Tm9kZSIsIkNvbmZpZ3VyYWJsZVNob3J0Y3V0SGludCIsIkJ5bGluZSIsIktleWJvYXJkU2hvcnRjdXRIaW50IiwidXNlV2l6YXJkIiwiV2l6YXJkRGlhbG9nTGF5b3V0IiwiTW9kZWxTZWxlY3RvciIsIkFnZW50V2l6YXJkRGF0YSIsIk1vZGVsU3RlcCIsIiQiLCJfYyIsImdvTmV4dCIsImdvQmFjayIsInVwZGF0ZVdpemFyZERhdGEiLCJ3aXphcmREYXRhIiwidDAiLCJtb2RlbCIsInNlbGVjdGVkTW9kZWwiLCJoYW5kbGVDb21wbGV0ZSIsInQxIiwiU3ltYm9sIiwiZm9yIiwidDIiXSwic291cmNlcyI6WyJNb2RlbFN0ZXAudHN4Il0sInNvdXJjZXNDb250ZW50IjpbImltcG9ydCBSZWFjdCwgeyB0eXBlIFJlYWN0Tm9kZSB9IGZyb20gJ3JlYWN0J1xuaW1wb3J0IHsgQ29uZmlndXJhYmxlU2hvcnRjdXRIaW50IH0gZnJvbSAnLi4vLi4vLi4vQ29uZmlndXJhYmxlU2hvcnRjdXRIaW50LmpzJ1xuaW1wb3J0IHsgQnlsaW5lIH0gZnJvbSAnLi4vLi4vLi4vZGVzaWduLXN5c3RlbS9CeWxpbmUuanMnXG5pbXBvcnQgeyBLZXlib2FyZFNob3J0Y3V0SGludCB9IGZyb20gJy4uLy4uLy4uL2Rlc2lnbi1zeXN0ZW0vS2V5Ym9hcmRTaG9ydGN1dEhpbnQuanMnXG5pbXBvcnQgeyB1c2VXaXphcmQgfSBmcm9tICcuLi8uLi8uLi93aXphcmQvaW5kZXguanMnXG5pbXBvcnQgeyBXaXphcmREaWFsb2dMYXlvdXQgfSBmcm9tICcuLi8uLi8uLi93aXphcmQvV2l6YXJkRGlhbG9nTGF5b3V0LmpzJ1xuaW1wb3J0IHsgTW9kZWxTZWxlY3RvciB9IGZyb20gJy4uLy4uL01vZGVsU2VsZWN0b3IuanMnXG5pbXBvcnQgdHlwZSB7IEFnZW50V2l6YXJkRGF0YSB9IGZyb20gJy4uL3R5cGVzLmpzJ1xuXG5leHBvcnQgZnVuY3Rpb24gTW9kZWxTdGVwKCk6IFJlYWN0Tm9kZSB7XG4gIGNvbnN0IHsgZ29OZXh0LCBnb0JhY2ssIHVwZGF0ZVdpemFyZERhdGEsIHdpemFyZERhdGEgfSA9XG4gICAgdXNlV2l6YXJkPEFnZW50V2l6YXJkRGF0YT4oKVxuXG4gIGNvbnN0IGhhbmRsZUNvbXBsZXRlID0gKG1vZGVsPzogc3RyaW5nKTogdm9pZCA9PiB7XG4gICAgdXBkYXRlV2l6YXJkRGF0YSh7IHNlbGVjdGVkTW9kZWw6IG1vZGVsIH0pXG4gICAgZ29OZXh0KClcbiAgfVxuXG4gIHJldHVybiAoXG4gICAgPFdpemFyZERpYWxvZ0xheW91dFxuICAgICAgc3VidGl0bGU9XCJTZWxlY3QgbW9kZWxcIlxuICAgICAgZm9vdGVyVGV4dD17XG4gICAgICAgIDxCeWxpbmU+XG4gICAgICAgICAgPEtleWJvYXJkU2hvcnRjdXRIaW50IHNob3J0Y3V0PVwi4oaR4oaTXCIgYWN0aW9uPVwibmF2aWdhdGVcIiAvPlxuICAgICAgICAgIDxLZXlib2FyZFNob3J0Y3V0SGludCBzaG9ydGN1dD1cIkVudGVyXCIgYWN0aW9uPVwic2VsZWN0XCIgLz5cbiAgICAgICAgICA8Q29uZmlndXJhYmxlU2hvcnRjdXRIaW50XG4gICAgICAgICAgICBhY3Rpb249XCJjb25maXJtOm5vXCJcbiAgICAgICAgICAgIGNvbnRleHQ9XCJDb25maXJtYXRpb25cIlxuICAgICAgICAgICAgZmFsbGJhY2s9XCJFc2NcIlxuICAgICAgICAgICAgZGVzY3JpcHRpb249XCJnbyBiYWNrXCJcbiAgICAgICAgICAvPlxuICAgICAgICA8L0J5bGluZT5cbiAgICAgIH1cbiAgICA+XG4gICAgICA8TW9kZWxTZWxlY3RvclxuICAgICAgICBpbml0aWFsTW9kZWw9e3dpemFyZERhdGEuc2VsZWN0ZWRNb2RlbH1cbiAgICAgICAgb25Db21wbGV0ZT17aGFuZGxlQ29tcGxldGV9XG4gICAgICAgIG9uQ2FuY2VsPXtnb0JhY2t9XG4gICAgICAvPlxuICAgIDwvV2l6YXJkRGlhbG9nTGF5b3V0PlxuICApXG59XG4iXSwi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
