/**
 * ColorStep.tsx — 新建 Agent 向导颜色选择步骤
 *
 * 【在 Claude Code 系统流程中的位置】
 * 本文件位于 new-agent-creation/wizard-steps/ 目录下，是 CreateAgentWizard 的第九步（索引 8）。
 * 用户在此选择 Agent 的背景颜色标识，内嵌 ColorPicker 组件实现实时预览和键盘导航。
 * 选择颜色后，本步骤负责组装完整的 finalAgent 对象（汇总所有向导数据），并推进到下一步（MemoryStep 或 ConfirmStepWrapper）。
 *
 * 【主要功能】
 * 1. 通过 useKeybinding('confirm:no', goBack) 绑定 Esc 键返回上一步
 * 2. handleConfirm 回调：汇总 wizardData 中的所有字段构建 finalAgent 对象
 *    - 必填字段：agentType、whenToUse、getSystemPrompt（包裹为函数）、tools、source（location）
 *    - 可选字段：selectedModel（有值才展开）、color（有值才展开为 AgentColorName）
 * 3. 使用 ColorPicker 组件预览 `@{agentName}` 带颜色背景的效果
 * 4. 使用 React Compiler 的 _c(14) 缓存机制优化渲染性能
 */
import { c as _c } from "react/compiler-runtime";
import React, { type ReactNode } from 'react';
import { Box } from '../../../../ink.js';
import { useKeybinding } from '../../../../keybindings/useKeybinding.js';
import type { AgentColorName } from '../../../../tools/AgentTool/agentColorManager.js';
import { ConfigurableShortcutHint } from '../../../ConfigurableShortcutHint.js';
import { Byline } from '../../../design-system/Byline.js';
import { KeyboardShortcutHint } from '../../../design-system/KeyboardShortcutHint.js';
import { useWizard } from '../../../wizard/index.js';
import { WizardDialogLayout } from '../../../wizard/WizardDialogLayout.js';
import { ColorPicker } from '../../ColorPicker.js';
import type { AgentWizardData } from '../types.js';

/**
 * ColorStep 组件 — Agent 背景颜色选择步骤
 *
 * React Compiler 分配 14 个缓存槽，优化以下依赖项的缓存：
 * - 静态 keybinding 选项对象（槽 0）
 * - goNext + updateWizardData + 多个 wizardData 字段 → handleConfirm（槽 1-9）
 * - 静态页脚提示文本节点（槽 10）
 * - handleConfirm + t3（agentType） → 根节点（槽 11-13）
 */
export function ColorStep() {
  // React Compiler 分配 14 个缓存槽
  const $ = _c(14);
  // 从向导上下文获取跳转、回退、更新和当前数据方法
  const {
    goNext,
    goBack,
    updateWizardData,
    wizardData
  } = useWizard();

  // 缓存 keybinding 配置对象：仅初始化一次（静态对象）
  let t0;
  if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
    t0 = {
      context: "Confirmation"
    };
    $[0] = t0;
  } else {
    t0 = $[0];
  }
  // 绑定 confirm:no（Esc）键，触发 goBack 返回上一步
  // ColorPicker 内部也处理 Esc，此处确保从外部也能触发回退
  useKeybinding("confirm:no", goBack, t0);

  // 缓存 handleConfirm：当任意 wizardData 字段或 goNext/updateWizardData 变化时重建
  // 这是本步骤最核心的逻辑：汇总所有向导数据，组装 finalAgent 对象
  let t1;
  if ($[1] !== goNext || $[2] !== updateWizardData || $[3] !== wizardData.agentType || $[4] !== wizardData.location || $[5] !== wizardData.selectedModel || $[6] !== wizardData.selectedTools || $[7] !== wizardData.systemPrompt || $[8] !== wizardData.whenToUse) {
    t1 = color => {
      updateWizardData({
        selectedColor: color,  // 保存所选颜色
        // 组装完整的 finalAgent 对象，供 ConfirmStepWrapper 使用
        finalAgent: {
          agentType: wizardData.agentType,
          whenToUse: wizardData.whenToUse,
          // systemPrompt 包装为惰性求值函数，避免不必要的字符串拷贝
          getSystemPrompt: () => wizardData.systemPrompt,
          tools: wizardData.selectedTools,
          // 仅在有 selectedModel 时才展开 model 字段
          ...(wizardData.selectedModel ? {
            model: wizardData.selectedModel
          } : {}),
          // 仅在有颜色时才展开 color 字段（类型断言为 AgentColorName）
          ...(color ? {
            color: color as AgentColorName
          } : {}),
          source: wizardData.location  // 存储位置来源
        }
      });
      goNext();  // 进入下一步
    };
    $[1] = goNext;
    $[2] = updateWizardData;
    $[3] = wizardData.agentType;
    $[4] = wizardData.location;
    $[5] = wizardData.selectedModel;
    $[6] = wizardData.selectedTools;
    $[7] = wizardData.systemPrompt;
    $[8] = wizardData.whenToUse;
    $[9] = t1;
  } else {
    t1 = $[9];
  }
  const handleConfirm = t1;

  // 缓存页脚键盘操作提示：↑↓导航、Enter选择、Esc返回，仅初始化一次
  let t2;
  if ($[10] === Symbol.for("react.memo_cache_sentinel")) {
    t2 = <Byline><KeyboardShortcutHint shortcut={"\u2191\u2193"} action="navigate" /><KeyboardShortcutHint shortcut="Enter" action="select" /><ConfigurableShortcutHint action="confirm:no" context="Confirmation" fallback="Esc" description="go back" /></Byline>;
    $[10] = t2;
  } else {
    t2 = $[10];
  }

  // 计算预览名称：有 agentType 则使用，否则默认显示 "agent"
  const t3 = wizardData.agentType || "agent";

  // 缓存根节点：handleConfirm 或预览名称 t3 变化时重建
  let t4;
  if ($[11] !== handleConfirm || $[12] !== t3) {
    t4 = <WizardDialogLayout subtitle="Choose background color" footerText={t2}><Box><ColorPicker agentName={t3} currentColor="automatic" onConfirm={handleConfirm} /></Box></WizardDialogLayout>;
    $[11] = handleConfirm;
    $[12] = t3;
    $[13] = t4;
  } else {
    t4 = $[13];
  }
  return t4;
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJSZWFjdCIsIlJlYWN0Tm9kZSIsIkJveCIsInVzZUtleWJpbmRpbmciLCJBZ2VudENvbG9yTmFtZSIsIkNvbmZpZ3VyYWJsZVNob3J0Y3V0SGludCIsIkJ5bGluZSIsIktleWJvYXJkU2hvcnRjdXRIaW50IiwidXNlV2l6YXJkIiwiV2l6YXJkRGlhbG9nTGF5b3V0IiwiQ29sb3JQaWNrZXIiLCJBZ2VudFdpemFyZERhdGEiLCJDb2xvclN0ZXAiLCIkIiwiX2MiLCJnb05leHQiLCJnb0JhY2siLCJ1cGRhdGVXaXphcmREYXRhIiwid2l6YXJkRGF0YSIsInQwIiwiU3ltYm9sIiwiZm9yIiwiY29udGV4dCIsInQxIiwiYWdlbnRUeXBlIiwibG9jYXRpb24iLCJzZWxlY3RlZE1vZGVsIiwic2VsZWN0ZWRUb29scyIsInN5c3RlbVByb21wdCIsIndoZW5Ub1VzZSIsImNvbG9yIiwic2VsZWN0ZWRDb2xvciIsImZpbmFsQWdlbnQiLCJnZXRTeXN0ZW1Qcm9tcHQiLCJ0b29scyIsIm1vZGVsIiwic291cmNlIiwiaGFuZGxlQ29uZmlybSIsInQyIiwidDMiLCJ0NCJdLCJzb3VyY2VzIjpbIkNvbG9yU3RlcC50c3giXSwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IFJlYWN0LCB7IHR5cGUgUmVhY3ROb2RlIH0gZnJvbSAncmVhY3QnXG5pbXBvcnQgeyBCb3ggfSBmcm9tICcuLi8uLi8uLi8uLi9pbmsuanMnXG5pbXBvcnQgeyB1c2VLZXliaW5kaW5nIH0gZnJvbSAnLi4vLi4vLi4vLi4va2V5YmluZGluZ3MvdXNlS2V5YmluZGluZy5qcydcbmltcG9ydCB0eXBlIHsgQWdlbnRDb2xvck5hbWUgfSBmcm9tICcuLi8uLi8uLi8uLi90b29scy9BZ2VudFRvb2wvYWdlbnRDb2xvck1hbmFnZXIuanMnXG5pbXBvcnQgeyBDb25maWd1cmFibGVTaG9ydGN1dEhpbnQgfSBmcm9tICcuLi8uLi8uLi9Db25maWd1cmFibGVTaG9ydGN1dEhpbnQuanMnXG5pbXBvcnQgeyBCeWxpbmUgfSBmcm9tICcuLi8uLi8uLi9kZXNpZ24tc3lzdGVtL0J5bGluZS5qcydcbmltcG9ydCB7IEtleWJvYXJkU2hvcnRjdXRIaW50IH0gZnJvbSAnLi4vLi4vLi4vZGVzaWduLXN5c3RlbS9LZXlib2FyZFNob3J0Y3V0SGludC5qcydcbmltcG9ydCB7IHVzZVdpemFyZCB9IGZyb20gJy4uLy4uLy4uL3dpemFyZC9pbmRleC5qcydcbmltcG9ydCB7IFdpemFyZERpYWxvZ0xheW91dCB9IGZyb20gJy4uLy4uLy4uL3dpemFyZC9XaXphcmREaWFsb2dMYXlvdXQuanMnXG5pbXBvcnQgeyBDb2xvclBpY2tlciB9IGZyb20gJy4uLy4uL0NvbG9yUGlja2VyLmpzJ1xuaW1wb3J0IHR5cGUgeyBBZ2VudFdpemFyZERhdGEgfSBmcm9tICcuLi90eXBlcy5qcydcblxuZXhwb3J0IGZ1bmN0aW9uIENvbG9yU3RlcCgpOiBSZWFjdE5vZGUge1xuICBjb25zdCB7IGdvTmV4dCwgZ29CYWNrLCB1cGRhdGVXaXphcmREYXRhLCB3aXphcmREYXRhIH0gPVxuICAgIHVzZVdpemFyZDxBZ2VudFdpemFyZERhdGE+KClcblxuICAvLyBIYW5kbGUgZXNjYXBlIGtleSAtIENvbG9yUGlja2VyIGhhbmRsZXMgaXRzIG93biBlc2NhcGUgaW50ZXJuYWxseVxuICB1c2VLZXliaW5kaW5nKCdjb25maXJtOm5vJywgZ29CYWNrLCB7IGNvbnRleHQ6ICdDb25maXJtYXRpb24nIH0pXG5cbiAgY29uc3QgaGFuZGxlQ29uZmlybSA9IChjb2xvcj86IHN0cmluZyk6IHZvaWQgPT4ge1xuICAgIHVwZGF0ZVdpemFyZERhdGEoe1xuICAgICAgc2VsZWN0ZWRDb2xvcjogY29sb3IsXG4gICAgICAvLyBQcmVwYXJlIGZpbmFsIGFnZW50IGZvciBjb25maXJtYXRpb25cbiAgICAgIGZpbmFsQWdlbnQ6IHtcbiAgICAgICAgYWdlbnRUeXBlOiB3aXphcmREYXRhLmFnZW50VHlwZSEsXG4gICAgICAgIHdoZW5Ub1VzZTogd2l6YXJkRGF0YS53aGVuVG9Vc2UhLFxuICAgICAgICBnZXRTeXN0ZW1Qcm9tcHQ6ICgpID0+IHdpemFyZERhdGEuc3lzdGVtUHJvbXB0ISxcbiAgICAgICAgdG9vbHM6IHdpemFyZERhdGEuc2VsZWN0ZWRUb29scyxcbiAgICAgICAgLi4uKHdpemFyZERhdGEuc2VsZWN0ZWRNb2RlbFxuICAgICAgICAgID8geyBtb2RlbDogd2l6YXJkRGF0YS5zZWxlY3RlZE1vZGVsIH1cbiAgICAgICAgICA6IHt9KSxcbiAgICAgICAgLi4uKGNvbG9yID8geyBjb2xvcjogY29sb3IgYXMgQWdlbnRDb2xvck5hbWUgfSA6IHt9KSxcbiAgICAgICAgc291cmNlOiB3aXphcmREYXRhLmxvY2F0aW9uISxcbiAgICAgIH0sXG4gICAgfSlcbiAgICBnb05leHQoKVxuICB9XG5cbiAgcmV0dXJuIChcbiAgICA8V2l6YXJkRGlhbG9nTGF5b3V0XG4gICAgICBzdWJ0aXRsZT1cIkNob29zZSBiYWNrZ3JvdW5kIGNvbG9yXCJcbiAgICAgIGZvb3RlclRleHQ9e1xuICAgICAgICA8QnlsaW5lPlxuICAgICAgICAgIDxLZXlib2FyZFNob3J0Y3V0SGludCBzaG9ydGN1dD1cIuKGkeKGk1wiIGFjdGlvbj1cIm5hdmlnYXRlXCIgLz5cbiAgICAgICAgICA8S2V5Ym9hcmRTaG9ydGN1dEhpbnQgc2hvcnRjdXQ9XCJFbnRlclwiIGFjdGlvbj1cInNlbGVjdFwiIC8+XG4gICAgICAgICAgPENvbmZpZ3VyYWJsZVNob3J0Y3V0SGludFxuICAgICAgICAgICAgYWN0aW9uPVwiY29uZmlybTpub1wiXG4gICAgICAgICAgICBjb250ZXh0PVwiQ29uZmlybWF0aW9uXCJcbiAgICAgICAgICAgIGZhbGxiYWNrPVwiRXNjXCJcbiAgICAgICAgICAgIGRlc2NyaXB0aW9uPVwiZ28gYmFja1wiXG4gICAgICAgICAgLz5cbiAgICAgICAgPC9CeWxpbmU+XG4gICAgICB9XG4gICAgPlxuICAgICAgPEJveD5cbiAgICAgICAgPENvbG9yUGlja2VyXG4gICAgICAgICAgYWdlbnROYW1lPXt3aXphcmREYXRhLmFnZW50VHlwZSB8fCAnYWdlbnQnfVxuICAgICAgICAgIGN1cnJlbnRDb2xvcj1cImF1dG9tYXRpY1wiXG4gICAgICAgICAgb25Db25maXJtPXtoYW5kbGVDb25maXJtfVxuICAgICAgICAvPlxuICAgICAgPC9Cb3g+XG4gICAgPC9XaXphcmREaWFsb2dMYXlvdXQ+XG4gIClcbn1cbiJdLCJtYXBwaW5ncyI6IjtBQUFBLE9BQU9BLEtBQUssSUFBSSxLQUFLQyxTQUFTLFFBQVEsT0FBTztBQUM3QyxTQUFTQyxHQUFHLFFBQVEsb0JBQW9CO0FBQ3hDLFNBQVNDLGFBQWEsUUFBUSwwQ0FBMEM7QUFDeEUsY0FBY0MsY0FBYyxRQUFRLGtEQUFrRDtBQUN0RixTQUFTQyx3QkFBd0IsUUFBUSxzQ0FBc0M7QUFDL0UsU0FBU0MsTUFBTSxRQUFRLGtDQUFrQztBQUN6RCxTQUFTQyxvQkFBb0IsUUFBUSxnREFBZ0Q7QUFDckYsU0FBU0MsU0FBUyxRQUFRLDBCQUEwQjtBQUNwRCxTQUFTQyxrQkFBa0IsUUFBUSx1Q0FBdUM7QUFDMUUsU0FBU0MsV0FBVyxRQUFRLHNCQUFzQjtBQUNsRCxjQUFjQyxlQUFlLFFBQVEsYUFBYTtBQUVsRCxPQUFPLFNBQUFDLFVBQUE7RUFBQSxNQUFBQyxDQUFBLEdBQUFDLEVBQUE7RUFDTDtJQUFBQyxNQUFBO0lBQUFDLE1BQUE7SUFBQUMsZ0JBQUE7SUFBQUM7RUFBQSxJQUNFVixTQUFTLENBQWtCLENBQUM7RUFBQSxJQUFBVyxFQUFBO0VBQUEsSUFBQU4sQ0FBQSxRQUFBTyxNQUFBLENBQUFDLEdBQUE7SUFHTUYsRUFBQTtNQUFBRyxPQUFBLEVBQVc7SUFBZSxDQUFDO0lBQUFULENBQUEsTUFBQU0sRUFBQTtFQUFBO0lBQUFBLEVBQUEsR0FBQU4sQ0FBQTtFQUFBO0VBQS9EVixhQUFhLENBQUMsWUFBWSxFQUFFYSxNQUFNLEVBQUVHLEVBQTJCLENBQUM7RUFBQSxJQUFBSSxFQUFBO0VBQUEsSUFBQVYsQ0FBQSxRQUFBRSxNQUFBLElBQUFGLENBQUEsUUFBQUks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
