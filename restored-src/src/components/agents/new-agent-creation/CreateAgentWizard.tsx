/**
 * CreateAgentWizard.tsx — 新建 Agent 向导主容器组件
 *
 * 【在 Claude Code 系统流程中的位置】
 * 本文件位于 new-agent-creation/ 目录下，是整个新建 Agent 流程的入口和编排器。
 * 由 AgentsMenu 在用户选择"Create new agent"后调用，负责将所有向导步骤组装成线性流程，
 * 通过 WizardProvider 统一管理步骤导航、共享数据（AgentWizardData）和取消逻辑。
 *
 * 【主要功能】
 * 1. 接受 tools（可用工具集）、existingAgents（已有 Agent 列表）、onComplete、onCancel 等外部 Props
 * 2. 使用 React Compiler 的 _c(17) 缓存步骤闭包，避免每次渲染重新创建组件引用
 * 3. 动态组装有序步骤数组（10～11 步，取决于 isAutoMemoryEnabled）：
 *    LocationStep(0) → MethodStep(1) → GenerateStep(2) → TypeStep(3)
 *    → PromptStep(4) → DescriptionStep(5) → ToolsStep(6) → ModelStep(7)
 *    → ColorStep(8) → [MemoryStep(9)] → ConfirmStepWrapper(最后)
 * 4. TypeStep 和 ToolsStep 通过闭包注入外部依赖（existingAgents、tools）
 * 5. MemoryStep 通过 isAutoMemoryEnabled() 条件性展开（Feature Gate）
 * 6. ConfirmStepWrapper 接管最终完成逻辑（实际调用外部 onComplete）
 * 7. WizardProvider 的 onComplete 为空操作（_temp），完成由 ConfirmStepWrapper 处理
 */
import { c as _c } from "react/compiler-runtime";
import React, { type ReactNode } from 'react';
import { isAutoMemoryEnabled } from '../../../memdir/paths.js';
import type { Tools } from '../../../Tool.js';
import type { AgentDefinition } from '../../../tools/AgentTool/loadAgentsDir.js';
import { WizardProvider } from '../../wizard/index.js';
import type { WizardStepComponent } from '../../wizard/types.js';
import type { AgentWizardData } from './types.js';
import { ColorStep } from './wizard-steps/ColorStep.js';
import { ConfirmStepWrapper } from './wizard-steps/ConfirmStepWrapper.js';
import { DescriptionStep } from './wizard-steps/DescriptionStep.js';
import { GenerateStep } from './wizard-steps/GenerateStep.js';
import { LocationStep } from './wizard-steps/LocationStep.js';
import { MemoryStep } from './wizard-steps/MemoryStep.js';
import { MethodStep } from './wizard-steps/MethodStep.js';
import { ModelStep } from './wizard-steps/ModelStep.js';
import { PromptStep } from './wizard-steps/PromptStep.js';
import { ToolsStep } from './wizard-steps/ToolsStep.js';
import { TypeStep } from './wizard-steps/TypeStep.js';

// Props 接口：工具集、已有 Agent 列表、完成回调、取消回调
type Props = {
  tools: Tools;
  existingAgents: AgentDefinition[];
  onComplete: (message: string) => void;
  onCancel: () => void;
};

/**
 * CreateAgentWizard 组件 — 新建 Agent 向导主容器
 *
 * React Compiler 分配 17 个缓存槽，优化以下依赖项的缓存：
 * - existingAgents → TypeStep 闭包（槽 0-1）
 * - tools → ToolsStep 闭包（槽 2-3）
 * - 静态 memorySteps 数组（槽 4，基于 isAutoMemoryEnabled() 在初始化时计算一次）
 * - existingAgents + onComplete + tools → ConfirmStepWrapper 闭包（槽 5-8）
 * - t1 + t2 + t4 → 完整 steps 数组（槽 9-12）
 * - 静态空对象 initialData（槽 13）
 * - onCancel + steps → 根节点（槽 14-16）
 */
export function CreateAgentWizard(t0) {
  // React Compiler 分配 17 个缓存槽
  const $ = _c(17);
  const {
    tools,
    existingAgents,
    onComplete,
    onCancel
  } = t0;

  // 缓存 TypeStep 闭包：existingAgents 变化时重新创建
  // TypeStep 需要 existingAgents 来检验 Agent 标识符唯一性
  let t1;
  if ($[0] !== existingAgents) {
    t1 = () => <TypeStep existingAgents={existingAgents} />;
    $[0] = existingAgents;
    $[1] = t1;
  } else {
    t1 = $[1];
  }

  // 缓存 ToolsStep 闭包：tools 变化时重新创建
  // ToolsStep 需要 tools 来显示可用工具列表
  let t2;
  if ($[2] !== tools) {
    t2 = () => <ToolsStep tools={tools} />;
    $[2] = tools;
    $[3] = t2;
  } else {
    t2 = $[3];
  }

  // 缓存 memorySteps 数组：仅初始化一次（isAutoMemoryEnabled 在运行时为常量）
  // Feature Gate：自动记忆功能启用时插入 MemoryStep，否则为空数组
  let t3;
  if ($[4] === Symbol.for("react.memo_cache_sentinel")) {
    t3 = isAutoMemoryEnabled() ? [MemoryStep] : [];
    $[4] = t3;
  } else {
    t3 = $[4];
  }

  // 缓存 ConfirmStepWrapper 闭包：existingAgents、onComplete 或 tools 变化时重新创建
  // ConfirmStepWrapper 是向导的最后一步，负责实际保存 Agent 并调用 onComplete
  let t4;
  if ($[5] !== existingAgents || $[6] !== onComplete || $[7] !== tools) {
    t4 = () => <ConfirmStepWrapper tools={tools} existingAgents={existingAgents} onComplete={onComplete} />;
    $[5] = existingAgents;
    $[6] = onComplete;
    $[7] = tools;
    $[8] = t4;
  } else {
    t4 = $[8];
  }

  // 缓存完整步骤数组：t1、t2 或 t4 变化时重建
  // 步骤顺序固定：Location(0) → Method(1) → Generate(2) → Type(3)
  // → Prompt(4) → Description(5) → Tools(6) → Model(7) → Color(8)
  // → [...memorySteps] → ConfirmStepWrapper(最后)
  let t5;
  if ($[9] !== t1 || $[10] !== t2 || $[11] !== t4) {
    t5 = [LocationStep, MethodStep, GenerateStep, t1, PromptStep, DescriptionStep, t2, ModelStep, ColorStep, ...t3, t4];
    $[9] = t1;
    $[10] = t2;
    $[11] = t4;
    $[12] = t5;
  } else {
    t5 = $[12];
  }
  const steps = t5;

  // 缓存初始数据对象：仅初始化一次（空对象，WizardProvider 初始化时需要）
  let t6;
  if ($[13] === Symbol.for("react.memo_cache_sentinel")) {
    t6 = {};  // 空对象作为 AgentWizardData 的初始状态
    $[13] = t6;
  } else {
    t6 = $[13];
  }

  // 缓存根节点：onCancel 或 steps 变化时重建
  // 注意：onComplete 传入的是空函数 _temp，实际完成由 ConfirmStepWrapper 内部处理
  let t7;
  if ($[14] !== onCancel || $[15] !== steps) {
    t7 = <WizardProvider steps={steps} initialData={t6} onComplete={_temp} onCancel={onCancel} title="Create new agent" showStepCounter={false} />;
    $[14] = onCancel;
    $[15] = steps;
    $[16] = t7;
  } else {
    t7 = $[16];
  }
  return t7;
}

/**
 * _temp — WizardProvider 的空 onComplete 占位函数
 *
 * 向导的实际完成逻辑由 ConfirmStepWrapper 处理（它会调用外部传入的 onComplete）。
 * WizardProvider 要求传入 onComplete 回调，此处传入空函数以满足接口要求。
 */
function _temp() {}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJSZWFjdCIsIlJlYWN0Tm9kZSIsImlzQXV0b01lbW9yeUVuYWJsZWQiLCJUb29scyIsIkFnZW50RGVmaW5pdGlvbiIsIldpemFyZFByb3ZpZGVyIiwiV2l6YXJkU3RlcENvbXBvbmVudCIsIkFnZW50V2l6YXJkRGF0YSIsIkNvbG9yU3RlcCIsIkNvbmZpcm1TdGVwV3JhcHBlciIsIkRlc2NyaXB0aW9uU3RlcCIsIkdlbmVyYXRlU3RlcCIsIkxvY2F0aW9uU3RlcCIsIk1lbW9yeVN0ZXAiLCJNZXRob2RTdGVwIiwiTW9kZWxTdGVwIiwiUHJvbXB0U3RlcCIsIlRvb2xzU3RlcCIsIlR5cGVTdGVwIiwiUHJvcHMiLCJ0b29scyIsImV4aXN0aW5nQWdlbnRzIiwib25Db21wbGV0ZSIsIm1lc3NhZ2UiLCJvbkNhbmNlbCIsIkNyZWF0ZUFnZW50V2l6YXJkIiwidDAiLCIkIiwiX2MiLCJ0MSIsInQyIiwidDMiLCJTeW1ib2wiLCJmb3IiLCJ0NCIsInQ1Iiwic3RlcHMiLCJ0NiIsInQ3IiwiX3RlbXAiXSwic291cmNlcyI6WyJDcmVhdGVBZ2VudFdpemFyZC50c3giXSwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IFJlYWN0LCB7IHR5cGUgUmVhY3ROb2RlIH0gZnJvbSAncmVhY3QnXG5pbXBvcnQgeyBpc0F1dG9NZW1vcnlFbmFibGVkIH0gZnJvbSAnLi4vLi4vLi4vbWVtZGlyL3BhdGhzLmpzJ1xuaW1wb3J0IHR5cGUgeyBUb29scyB9IGZyb20gJy4uLy4uLy4uL1Rvb2wuanMnXG5pbXBvcnQgdHlwZSB7IEFnZW50RGVmaW5pdGlvbiB9IGZyb20gJy4uLy4uLy4uL3Rvb2xzL0FnZW50VG9vbC9sb2FkQWdlbnRzRGlyLmpzJ1xuaW1wb3J0IHsgV2l6YXJkUHJvdmlkZXIgfSBmcm9tICcuLi8uLi93aXphcmQvaW5kZXguanMnXG5pbXBvcnQgdHlwZSB7IFdpemFyZFN0ZXBDb21wb25lbnQgfSBmcm9tICcuLi8uLi93aXphcmQvdHlwZXMuanMnXG5pbXBvcnQgdHlwZSB7IEFnZW50V2l6YXJkRGF0YSB9IGZyb20gJy4vdHlwZXMuanMnXG5pbXBvcnQgeyBDb2xvclN0ZXAgfSBmcm9tICcuL3dpemFyZC1zdGVwcy9Db2xvclN0ZXAuanMnXG5pbXBvcnQgeyBDb25maXJtU3RlcFdyYXBwZXIgfSBmcm9tICcuL3dpemFyZC1zdGVwcy9Db25maXJtU3RlcFdyYXBwZXIuanMnXG5pbXBvcnQgeyBEZXNjcmlwdGlvblN0ZXAgfSBmcm9tICcuL3dpemFyZC1zdGVwcy9EZXNjcmlwdGlvblN0ZXAuanMnXG5pbXBvcnQgeyBHZW5lcmF0ZVN0ZXAgfSBmcm9tICcuL3dpemFyZC1zdGVwcy9HZW5lcmF0ZVN0ZXAuanMnXG5pbXBvcnQgeyBMb2NhdGlvblN0ZXAgfSBmcm9tICcuL3dpemFyZC1zdGVwcy9Mb2NhdGlvblN0ZXAuanMnXG5pbXBvcnQgeyBNZW1vcnlTdGVwIH0gZnJvbSAnLi93aXphcmQtc3RlcHMvTWVtb3J5U3RlcC5qcydcbmltcG9ydCB7IE1ldGhvZFN0ZXAgfSBmcm9tICcuL3dpemFyZC1zdGVwcy9NZXRob2RTdGVwLmpzJ1xuaW1wb3J0IHsgTW9kZWxTdGVwIH0gZnJvbSAnLi93aXphcmQtc3RlcHMvTW9kZWxTdGVwLmpzJ1xuaW1wb3J0IHsgUHJvbXB0U3RlcCB9IGZyb20gJy4vd2l6YXJkLXN0ZXBzL1Byb21wdFN0ZXAuanMnXG5pbXBvcnQgeyBUb29sc1N0ZXAgfSBmcm9tICcuL3dpemFyZC1zdGVwcy9Ub29sc1N0ZXAuanMnXG5pbXBvcnQgeyBUeXBlU3RlcCB9IGZyb20gJy4vd2l6YXJkLXN0ZXBzL1R5cGVTdGVwLmpzJ1xuXG50eXBlIFByb3BzID0ge1xuICB0b29sczogVG9vbHNcbiAgZXhpc3RpbmdBZ2VudHM6IEFnZW50RGVmaW5pdGlvbltdXG4gIG9uQ29tcGxldGU6IChtZXNzYWdlOiBzdHJpbmcpID0+IHZvaWRcbiAgb25DYW5jZWw6ICgpID0+IHZvaWRcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIENyZWF0ZUFnZW50V2l6YXJkKHtcbiAgdG9vbHMsXG4gIGV4aXN0aW5nQWdlbnRzLFxuICBvbkNvbXBsZXRlLFxuICBvbkNhbmNlbCxcbn06IFByb3BzKTogUmVhY3ROb2RlIHtcbiAgLy8gQ3JlYXRlIHN0ZXAgY29tcG9uZW50cyB3aXRoIHByb3BzXG4gIGNvbnN0IHN0ZXBzOiBXaXphcmRTdGVwQ29tcG9uZW50PEFnZW50V2l6YXJkRGF0YT5bXSA9IFtcbiAgICBMb2NhdGlvblN0ZXAsIC8vIDBcbiAgICBNZXRob2RTdGVwLCAvLyAxXG4gICAgR2VuZXJhdGVTdGVwLCAvLyAyXG4gICAgKCkgPT4gPFR5cGVTdGVwIGV4aXN0aW5nQWdlbnRzPXtleGlzdGluZ0FnZW50c30gLz4sIC8vIDNcbiAgICBQcm9tcHRTdGVwLCAvLyA0XG4gICAgRGVzY3JpcHRpb25TdGVwLCAvLyA1XG4gICAgKCkgPT4gPFRvb2xzU3RlcCB0b29scz17dG9vbHN9IC8+LCAvLyA2XG4gICAgTW9kZWxTdGVwLCAvLyA3XG4gICAgQ29sb3JTdGVwLCAvLyA4XG4gICAgLy8gTWVtb3J5U3RlcCBpcyBjb25kaXRpb25hbGx5IGluY2x1ZGVkIGJhc2VkIG9uIEdyb3d0aEJvb2sgZ2F0ZVxuICAgIC4uLihpc0F1dG9NZW1vcnlFbmFibGVkKCkgPyBbTWVtb3J5U3RlcF0gOiBbXSksXG4gICAgKCkgPT4gKFxuICAgICAgPENvbmZpcm1TdGVwV3JhcHBlclxuICAgICAgICB0b29scz17dG9vbHN9XG4gICAgICAgIGV4aXN0aW5nQWdlbnRzPXtleGlzdGluZ0FnZW50c31cbiAgICAgICAgb25Db21wbGV0ZT17b25Db21wbGV0ZX1cbiAgICAgIC8+XG4gICAgKSxcbiAgXVxuXG4gIHJldHVybiAoXG4gICAgPFdpemFyZFByb3ZpZGVyPEFnZW50V2l6YXJkRGF0YT5cbiAgICAgIHN0ZXBzPXtzdGVwc31cbiAgICAgIGluaXRpYWxEYXRhPXt7fX1cbiAgICAgIG9uQ29tcGxldGU9eygpID0+IHtcbiAgICAgICAgLy8gV2l6YXJkIGNvbXBsZXRpb24gaXMgaGFuZGxlZCBieSBDb25maXJtU3RlcFdyYXBwZXJcbiAgICAgICAgLy8gd2hpY2ggY2FsbHMgb25Db21wbGV0ZSB3aXRoIHRoZSBhcHByb3ByaWF0ZSBtZXNzYWdlXG4gICAgICB9fVxuICAgICAgb25DYW5jZWw9e29uQ2FuY2VsfVxuICAgICAgdGl0bGU9XCJDcmVhdGUgbmV3IGFnZW50XCJcbiAgICAgIHNob3dTdGVwQ291bnRlcj17ZmFsc2V9XG4gICAgLz5cbiAgKVxufVxuIl0sIm1hcHBpbmdzIjoiO0FBQUEsT0FBT0EsS0FBSyxJQUFJLEtBQUtDLFNBQVMsUUFBUSxPQUFPO0FBQzdDLFNBQVNDLG1CQUFtQixRQUFRLDBCQUEwQjtBQUM5RCxjQUFjQyxLQUFLLFFBQVEsa0JBQWtCO0FBQzdDLGNBQWNDLGVBQWUsUUFBUSwyQ0FBMkM7QUFDaEYsU0FBU0MsY0FBYyxRQUFRLHVCQUF1QjtBQUN0RCxjQUFjQyxtQkFBbUIsUUFBUSx1QkFBdUI7QUFDaEUsY0FBY0MsZUFBZSxRQUFRLFlBQVk7QUFDakQsU0FBU0MsU0FBUyxRQUFRLDZCQUE2QjtBQUN2RCxTQUFTQyxrQkFBa0IsUUFBUSxzQ0FBc0M7QUFDekUsU0FBU0MsZUFBZSxRQUFRLG1DQUFtQztBQUNuRSxTQUFTQyxZQUFZLFFBQVEsZ0NBQWdDO0FBQzdELFNBQVNDLFlBQVksUUFBUSxnQ0FBZ0M7QUFDN0QsU0FBU0MsVUFBVSxRQUFRLDhCQUE4QjtBQUN6RCxTQUFTQyxVQUFVLFFBQVEsOEJBQThCO0FBQ3pELFNBQVNDLFNBQVMsUUFBUSw2QkFBNkI7QUFDdkQsU0FBU0MsVUFBVSxRQUFRLDhCQUE4QjtBQUN6RCxTQUFTQyxTQUFTLFFBQVEsNkJBQTZCO0FBQ3ZELFNBQVNDLFFBQVEsUUFBUSw0QkFBNEI7QUFFckQsS0FBS0MsS0FBSyxHQUFHO0VBQ1hDLEtBQUssRUFBRWpCLEtBQUs7RUFDWmtCLGNBQWMsRUFBRWpCLGVBQWUsRUFBRTtFQUNqQ2tCLFVBQVUsRUFBRSxDQUFDQyxPQUFPLEVBQUUsTUFBTSxFQUFFLEdBQUcsSUFBSTtFQUNyQ0MsUUFBUSxFQUFFLEdBQUcsR0FBRyxJ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
