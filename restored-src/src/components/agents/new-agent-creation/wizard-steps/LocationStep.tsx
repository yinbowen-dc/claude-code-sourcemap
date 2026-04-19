/**
 * LocationStep.tsx — 新建 Agent 向导第一步：存储位置选择
 *
 * 【在 Claude Code 系统流程中的位置】
 * 本文件位于 new-agent-creation/wizard-steps/ 目录下，是 CreateAgentWizard 的第一个步骤（索引 0）。
 * 用户在此选择新 Agent 的存储位置：项目级（.claude/agents/）或用户个人级（~/.claude/agents/）。
 * 选择完成后立即调用 goNext() 进入下一步（MethodStep）。
 *
 * 【主要功能】
 * 1. 提供两个位置选项：projectSettings（项目目录）和 userSettings（用户目录）
 * 2. 使用 Select 组件呈现键盘导航的选择列表
 * 3. onChange 时同步更新向导数据（location 字段）并自动跳转下一步
 * 4. onCancel 时调用 cancel() 退出整个向导
 * 5. 使用 React Compiler 的 _c(11) 缓存机制优化渲染性能
 */
import { c as _c } from "react/compiler-runtime";
import React, { type ReactNode } from 'react';
import { Box } from '../../../../ink.js';
import type { SettingSource } from '../../../../utils/settings/constants.js';
import { ConfigurableShortcutHint } from '../../../ConfigurableShortcutHint.js';
import { Select } from '../../../CustomSelect/select.js';
import { Byline } from '../../../design-system/Byline.js';
import { KeyboardShortcutHint } from '../../../design-system/KeyboardShortcutHint.js';
import { useWizard } from '../../../wizard/index.js';
import { WizardDialogLayout } from '../../../wizard/WizardDialogLayout.js';
import type { AgentWizardData } from '../types.js';

/**
 * LocationStep 组件 — Agent 存储位置选择步骤
 *
 * React Compiler 分配 11 个缓存槽，优化以下依赖项的缓存：
 * - 静态 projectSettings 选项对象（槽 0）
 * - 静态选项数组（槽 1）
 * - 静态页脚提示文本节点（槽 2）
 * - goNext + updateWizardData → onChange 回调（槽 3-5）
 * - cancel → onCancel 回调（槽 6-7）
 * - t3 + t4 → 根节点（槽 8-10）
 */
export function LocationStep() {
  // React Compiler 分配 11 个缓存槽
  const $ = _c(11);
  // 从向导上下文获取跳转、更新和取消方法
  const {
    goNext,
    updateWizardData,
    cancel
  } = useWizard();

  // 缓存 projectSettings 选项对象：仅初始化一次（静态对象）
  let t0;
  if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
    t0 = {
      label: "Project (.claude/agents/)",
      value: "projectSettings" as SettingSource  // 项目目录选项
    };
    $[0] = t0;
  } else {
    t0 = $[0];
  }

  // 缓存选项数组：包含 projectSettings 和 userSettings 两个选项，仅初始化一次
  let t1;
  if ($[1] === Symbol.for("react.memo_cache_sentinel")) {
    t1 = [t0, {
      label: "Personal (~/.claude/agents/)",
      value: "userSettings" as SettingSource  // 用户个人目录选项
    }];
    $[1] = t1;
  } else {
    t1 = $[1];
  }
  const locationOptions = t1;

  // 缓存页脚键盘操作提示：↑↓导航、Enter确认、Esc取消，仅初始化一次
  let t2;
  if ($[2] === Symbol.for("react.memo_cache_sentinel")) {
    t2 = <Byline><KeyboardShortcutHint shortcut={"\u2191\u2193"} action="navigate" /><KeyboardShortcutHint shortcut="Enter" action="select" /><ConfigurableShortcutHint action="confirm:no" context="Confirmation" fallback="Esc" description="cancel" /></Byline>;
    $[2] = t2;
  } else {
    t2 = $[2];
  }

  // 缓存 onChange 回调：goNext 或 updateWizardData 变化时重新创建
  // 选择后同步写入 wizardData.location，再跳转下一步
  let t3;
  if ($[3] !== goNext || $[4] !== updateWizardData) {
    t3 = value => {
      // 将所选位置写入向导共享数据
      updateWizardData({
        location: value as SettingSource
      });
      // 立即进入下一步（MethodStep）
      goNext();
    };
    $[3] = goNext;
    $[4] = updateWizardData;
    $[5] = t3;
  } else {
    t3 = $[5];
  }

  // 缓存 onCancel 回调：cancel 变化时重新创建
  let t4;
  if ($[6] !== cancel) {
    t4 = () => cancel();  // 退出整个向导
    $[6] = cancel;
    $[7] = t4;
  } else {
    t4 = $[7];
  }

  // 缓存根节点：t3 或 t4 变化时重建
  let t5;
  if ($[8] !== t3 || $[9] !== t4) {
    t5 = <WizardDialogLayout subtitle="Choose location" footerText={t2}><Box><Select key="location-select" options={locationOptions} onChange={t3} onCancel={t4} /></Box></WizardDialogLayout>;
    $[8] = t3;
    $[9] = t4;
    $[10] = t5;
  } else {
    t5 = $[10];
  }
  return t5;
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJSZWFjdCIsIlJlYWN0Tm9kZSIsIkJveCIsIlNldHRpbmdTb3VyY2UiLCJDb25maWd1cmFibGVTaG9ydGN1dEhpbnQiLCJTZWxlY3QiLCJCeWxpbmUiLCJLZXlib2FyZFNob3J0Y3V0SGludCIsInVzZVdpemFyZCIsIldpemFyZERpYWxvZ0xheW91dCIsIkFnZW50V2l6YXJkRGF0YSIsIkxvY2F0aW9uU3RlcCIsIiQiLCJfYyIsImdvTmV4dCIsInVwZGF0ZVdpemFyZERhdGEiLCJjYW5jZWwiLCJ0MCIsIlN5bWJvbCIsImZvciIsImxhYmVsIiwidmFsdWUiLCJ0MSIsImxvY2F0aW9uT3B0aW9ucyIsInQyIiwidDMiLCJsb2NhdGlvbiIsInQ0IiwidDUiXSwic291cmNlcyI6WyJMb2NhdGlvblN0ZXAudHN4Il0sInNvdXJjZXNDb250ZW50IjpbImltcG9ydCBSZWFjdCwgeyB0eXBlIFJlYWN0Tm9kZSB9IGZyb20gJ3JlYWN0J1xuaW1wb3J0IHsgQm94IH0gZnJvbSAnLi4vLi4vLi4vLi4vaW5rLmpzJ1xuaW1wb3J0IHR5cGUgeyBTZXR0aW5nU291cmNlIH0gZnJvbSAnLi4vLi4vLi4vLi4vdXRpbHMvc2V0dGluZ3MvY29uc3RhbnRzLmpzJ1xuaW1wb3J0IHsgQ29uZmlndXJhYmxlU2hvcnRjdXRIaW50IH0gZnJvbSAnLi4vLi4vLi4vQ29uZmlndXJhYmxlU2hvcnRjdXRIaW50LmpzJ1xuaW1wb3J0IHsgU2VsZWN0IH0gZnJvbSAnLi4vLi4vLi4vQ3VzdG9tU2VsZWN0L3NlbGVjdC5qcydcbmltcG9ydCB7IEJ5bGluZSB9IGZyb20gJy4uLy4uLy4uL2Rlc2lnbi1zeXN0ZW0vQnlsaW5lLmpzJ1xuaW1wb3J0IHsgS2V5Ym9hcmRTaG9ydGN1dEhpbnQgfSBmcm9tICcuLi8uLi8uLi9kZXNpZ24tc3lzdGVtL0tleWJvYXJkU2hvcnRjdXRIaW50LmpzJ1xuaW1wb3J0IHsgdXNlV2l6YXJkIH0gZnJvbSAnLi4vLi4vLi4vd2l6YXJkL2luZGV4LmpzJ1xuaW1wb3J0IHsgV2l6YXJkRGlhbG9nTGF5b3V0IH0gZnJvbSAnLi4vLi4vLi4vd2l6YXJkL1dpemFyZERpYWxvZ0xheW91dC5qcydcbmltcG9ydCB0eXBlIHsgQWdlbnRXaXphcmREYXRhIH0gZnJvbSAnLi4vdHlwZXMuanMnXG5cbmV4cG9ydCBmdW5jdGlvbiBMb2NhdGlvblN0ZXAoKTogUmVhY3ROb2RlIHtcbiAgY29uc3QgeyBnb05leHQsIHVwZGF0ZVdpemFyZERhdGEsIGNhbmNlbCB9ID0gdXNlV2l6YXJkPEFnZW50V2l6YXJkRGF0YT4oKVxuXG4gIGNvbnN0IGxvY2F0aW9uT3B0aW9ucyA9IFtcbiAgICB7XG4gICAgICBsYWJlbDogJ1Byb2plY3QgKC5jbGF1ZGUvYWdlbnRzLyknLFxuICAgICAgdmFsdWU6ICdwcm9qZWN0U2V0dGluZ3MnIGFzIFNldHRpbmdTb3VyY2UsXG4gICAgfSxcbiAgICB7XG4gICAgICBsYWJlbDogJ1BlcnNvbmFsICh+Ly5jbGF1ZGUvYWdlbnRzLyknLFxuICAgICAgdmFsdWU6ICd1c2VyU2V0dGluZ3MnIGFzIFNldHRpbmdTb3VyY2UsXG4gICAgfSxcbiAgXVxuXG4gIHJldHVybiAoXG4gICAgPFdpemFyZERpYWxvZ0xheW91dFxuICAgICAgc3VidGl0bGU9XCJDaG9vc2UgbG9jYXRpb25cIlxuICAgICAgZm9vdGVyVGV4dD17XG4gICAgICAgIDxCeWxpbmU+XG4gICAgICAgICAgPEtleWJvYXJkU2hvcnRjdXRIaW50IHNob3J0Y3V0PVwi4oaR4oaTXCIgYWN0aW9uPVwibmF2aWdhdGVcIiAvPlxuICAgICAgICAgIDxLZXlib2FyZFNob3J0Y3V0SGludCBzaG9ydGN1dD1cIkVudGVyXCIgYWN0aW9uPVwic2VsZWN0XCIgLz5cbiAgICAgICAgICA8Q29uZmlndXJhYmxlU2hvcnRjdXRIaW50XG4gICAgICAgICAgICBhY3Rpb249XCJjb25maXJtOm5vXCJcbiAgICAgICAgICAgIGNvbnRleHQ9XCJDb25maXJtYXRpb25cIlxuICAgICAgICAgICAgZmFsbGJhY2s9XCJFc2NcIlxuICAgICAgICAgICAgZGVzY3JpcHRpb249XCJjYW5jZWxcIlxuICAgICAgICAgIC8+XG4gICAgICAgIDwvQnlsaW5lPlxuICAgICAgfVxuICAgID5cbiAgICAgIDxCb3g+XG4gICAgICAgIDxTZWxlY3RcbiAgICAgICAgICBrZXk9XCJsb2NhdGlvbi1zZWxlY3RcIlxuICAgICAgICAgIG9wdGlvbnM9e2xvY2F0aW9uT3B0aW9uc31cbiAgICAgICAgICBvbkNoYW5nZT17KHZhbHVlOiBzdHJpbmcpID0+IHtcbiAgICAgICAgICAgIHVwZGF0ZVdpemFyZERhdGEoeyBsb2NhdGlvbjogdmFsdWUgYXMgU2V0dGluZ1NvdXJjZSB9KVxuICAgICAgICAgICAgZ29OZXh0KClcbiAgICAgICAgICB9fVxuICAgICAgICAgIG9uQ2FuY2VsPXsoKSA9PiBjYW5jZWwoKX1cbiAgICAgICAgLz5cbiAgICAgIDwvQm94PlxuICAgIDwvV2l6YXJkRGlhbG9nTGF5b3V0PlxuICApXG59XG4iXSwibWFwcGluZ3MiOiI7QUFBQSxPQUFPQSxLQUFLLElBQUksS0FBS0MsU0FBUyxRQUFRLE9BQU87QUFDN0MsU0FBU0MsR0FBRyxRQUFRLG9CQUFvQjtBQUN4QyxjQUFjQyxhQUFhLFFBQVEseUNBQXlDO0FBQzVFLFNBQVNDLHdCQUF3QixRQUFRLHNDQUFzQztBQUMvRSxTQUFTQyxNQUFNLFFBQVEsaUNBQWlDO0FBQ3hELFNBQVNDLE1BQU0sUUFBUSxrQ0FBa0M7QUFDekQsU0FBU0Msb0JBQW9CLFFBQVEsZ0RBQWdEO0FBQ3JGLFNBQVNDLFNBQVMsUUFBUSwwQkFBMEI7QUFDcEQsU0FBU0Msa0JBQWtCLFFBQVEsdUNBQXVDO0FBQzFFLGNBQWNDLGVBQWUsUUFBUSxhQUFhO0FBRWxELE9BQU8sU0FBQUMsYUFBQTtFQUFBLE1BQUFDLENBQUEsR0FBQUMsRUFBQTtFQUNMO0lBQUFDLE1BQUE7SUFBQUMsZ0JBQUE7SUFBQUM7RUFBQSxJQUE2Q1IsU0FBUyxDQUFrQixDQUFDO0VBQUEsSUFBQVMsRUFBQTtFQUFBLElBQUFMLENBQUEsUUFBQU0s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
