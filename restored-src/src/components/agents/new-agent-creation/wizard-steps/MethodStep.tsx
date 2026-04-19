/**
 * MethodStep.tsx — Agent 创建向导第一步：选择创建方式
 *
 * 在 Claude Code 系统流程中的位置：
 *   AgentTool → new-agent-creation/AgentWizard → wizard-steps/MethodStep（当前文件）
 *
 * 主要功能：
 *   - 呈现两个互斥选项："用 Claude 生成（推荐）" 和 "手动配置"
 *   - 根据用户选择决定向导的下一步导航路径：
 *       generate → goNext()（前往 GenerateStep，索引 2）
 *       manual   → goToStep(3)（跳过 GenerateStep，直接到 TypeStep，索引 3）
 *   - 将选择结果（method + wasGenerated 标志）写入 wizard 共享数据
 *
 * 依赖：
 *   - react/compiler-runtime (_c)：React 编译器自动生成的记忆化缓存机制
 *   - useWizard：wizard 上下文钩子，提供导航与数据写入能力
 *   - Select：自定义终端下拉/列表选择组件（Ink 生态）
 */
import { c as _c } from "react/compiler-runtime";
import React, { type ReactNode } from 'react';
import { Box } from '../../../../ink.js';
import { ConfigurableShortcutHint } from '../../../ConfigurableShortcutHint.js';
import { Select } from '../../../CustomSelect/select.js';
import { Byline } from '../../../design-system/Byline.js';
import { KeyboardShortcutHint } from '../../../design-system/KeyboardShortcutHint.js';
import { useWizard } from '../../../wizard/index.js';
import { WizardDialogLayout } from '../../../wizard/WizardDialogLayout.js';
import type { AgentWizardData } from '../types.js';

/**
 * MethodStep — 向导第一步，让用户选择 Agent 的创建方式。
 *
 * 整体流程：
 *   1. 从 useWizard 获取 goNext / goBack / updateWizardData / goToStep 方法
 *   2. 构建静态选项数组 methodOptions（React 编译器确保只创建一次）
 *   3. 构建底部快捷键提示栏（静态 JSX，只创建一次）
 *   4. 构建 onChange 回调：
 *      - 将选择写入 wizardData（method + wasGenerated）
 *      - 根据 method 值决定跳转到哪一步
 *   5. 构建 onCancel 回调：调用 goBack()
 *   6. 将上述内容组装为 WizardDialogLayout + Select，返回渲染结果
 */
export function MethodStep() {
  // React 编译器生成的记忆化缓存，共 11 个槽位
  const $ = _c(11);

  // 从向导上下文获取导航和数据更新方法
  const {
    goNext,
    goBack,
    updateWizardData,
    goToStep
  } = useWizard();

  // ── 槽位 $[0]：静态选项数组（仅在首次渲染时初始化）────────────────────
  let t0;
  if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
    // 哨兵值表示该槽未初始化，创建选项数组并缓存
    t0 = [{
      label: "Generate with Claude (recommended)", // 推荐：让 Claude 自动生成 Agent 配置
      value: "generate"
    }, {
      label: "Manual configuration",               // 手动：用户自行填写每个字段
      value: "manual"
    }];
    $[0] = t0; // 写入缓存
  } else {
    t0 = $[0]; // 直接从缓存读取，避免重复创建
  }
  const methodOptions = t0;

  // ── 槽位 $[1]：静态底部快捷键提示 JSX（仅在首次渲染时创建）──────────────
  let t1;
  if ($[1] === Symbol.for("react.memo_cache_sentinel")) {
    // 创建快捷键提示：↑↓ 导航、Enter 选择、Esc 返回
    t1 = <Byline><KeyboardShortcutHint shortcut={"\u2191\u2193"} action="navigate" /><KeyboardShortcutHint shortcut="Enter" action="select" /><ConfigurableShortcutHint action="confirm:no" context="Confirmation" fallback="Esc" description="go back" /></Byline>;
    $[1] = t1;
  } else {
    t1 = $[1];
  }

  // ── 槽位 $[2-5]：onChange 回调（依赖 goNext / goToStep / updateWizardData）──
  let t2;
  if ($[2] !== goNext || $[3] !== goToStep || $[4] !== updateWizardData) {
    // 任意依赖变化时，重新创建回调函数
    t2 = value => {
      // 将 string 值转换为联合类型
      const method = value as 'generate' | 'manual';

      // 将选择的方法和是否由 Claude 生成的标志写入 wizard 共享数据
      updateWizardData({
        method,
        wasGenerated: method === "generate" // generate 方式才视为"由 Claude 生成"
      });

      // 根据选择动态路由
      if (method === "generate") {
        goNext();      // 前往 GenerateStep（wizard 步骤索引 2）
      } else {
        goToStep(3);   // 跳过 GenerateStep，直接到 TypeStep（索引 3）
      }
    };
    // 更新缓存中的依赖项和回调引用
    $[2] = goNext;
    $[3] = goToStep;
    $[4] = updateWizardData;
    $[5] = t2;
  } else {
    t2 = $[5]; // 依赖未变，复用已缓存的回调
  }

  // ── 槽位 $[6-7]：onCancel 回调（依赖 goBack）────────────────────────────
  let t3;
  if ($[6] !== goBack) {
    // goBack 引用变化时，重新包装为箭头函数
    t3 = () => goBack();
    $[6] = goBack;
    $[7] = t3;
  } else {
    t3 = $[7];
  }

  // ── 槽位 $[8-10]：最终渲染的 JSX（依赖 onChange / onCancel）────────────────
  let t4;
  if ($[8] !== t2 || $[9] !== t3) {
    // 任意回调变化时，重新创建整个对话框 JSX
    t4 = <WizardDialogLayout subtitle="Creation method" footerText={t1}><Box><Select key="method-select" options={methodOptions} onChange={t2} onCancel={t3} /></Box></WizardDialogLayout>;
    $[8] = t2;
    $[9] = t3;
    $[10] = t4;
  } else {
    t4 = $[10]; // 结构未变，复用缓存 JSX
  }
  return t4;
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJSZWFjdCIsIlJlYWN0Tm9kZSIsIkJveCIsIkNvbmZpZ3VyYWJsZVNob3J0Y3V0SGludCIsIlNlbGVjdCIsIkJ5bGluZSIsIktleWJvYXJkU2hvcnRjdXRIaW50IiwidXNlV2l6YXJkIiwiV2l6YXJkRGlhbG9nTGF5b3V0IiwiQWdlbnRXaXphcmREYXRhIiwiTWV0aG9kU3RlcCIsIiQiLCJfYyIsImdvTmV4dCIsImdvQmFjayIsInVwZGF0ZVdpemFyZERhdGEiLCJnb1RvU3RlcCIsInQwIiwiU3ltYm9sIiwiZm9yIiwibGFiZWwiLCJ2YWx1ZSIsIm1ldGhvZE9wdGlvbnMiLCJ0MSIsInQyIiwibWV0aG9kIiwid2FzR2VuZXJhdGVkIiwidDMiLCJ0NCJdLCJzb3VyY2VzIjpbIk1ldGhvZFN0ZXAudHN4Il0sInNvdXJjZXNDb250ZW50IjpbImltcG9ydCBSZWFjdCwgeyB0eXBlIFJlYWN0Tm9kZSB9IGZyb20gJ3JlYWN0J1xuaW1wb3J0IHsgQm94IH0gZnJvbSAnLi4vLi4vLi4vLi4vaW5rLmpzJ1xuaW1wb3J0IHsgQ29uZmlndXJhYmxlU2hvcnRjdXRIaW50IH0gZnJvbSAnLi4vLi4vLi4vQ29uZmlndXJhYmxlU2hvcnRjdXRIaW50LmpzJ1xuaW1wb3J0IHsgU2VsZWN0IH0gZnJvbSAnLi4vLi4vLi4vQ3VzdG9tU2VsZWN0L3NlbGVjdC5qcydcbmltcG9ydCB7IEJ5bGluZSB9IGZyb20gJy4uLy4uLy4uL2Rlc2lnbi1zeXN0ZW0vQnlsaW5lLmpzJ1xuaW1wb3J0IHsgS2V5Ym9hcmRTaG9ydGN1dEhpbnQgfSBmcm9tICcuLi8uLi8uLi9kZXNpZ24tc3lzdGVtL0tleWJvYXJkU2hvcnRjdXRIaW50LmpzJ1xuaW1wb3J0IHsgdXNlV2l6YXJkIH0gZnJvbSAnLi4vLi4vLi4vd2l6YXJkL2luZGV4LmpzJ1xuaW1wb3J0IHsgV2l6YXJkRGlhbG9nTGF5b3V0IH0gZnJvbSAnLi4vLi4vLi4vd2l6YXJkL1dpemFyZERpYWxvZ0xheW91dC5qcydcbmltcG9ydCB0eXBlIHsgQWdlbnRXaXphcmREYXRhIH0gZnJvbSAnLi4vdHlwZXMuanMnXG5cbmV4cG9ydCBmdW5jdGlvbiBNZXRob2RTdGVwKCk6IFJlYWN0Tm9kZSB7XG4gIGNvbnN0IHsgZ29OZXh0LCBnb0JhY2ssIHVwZGF0ZVdpemFyZERhdGEsIGdvVG9TdGVwIH0gPVxuICAgIHVzZVdpemFyZDxBZ2VudFdpemFyZERhdGE+KClcblxuICBjb25zdCBtZXRob2RPcHRpb25zID0gW1xuICAgIHtcbiAgICAgIGxhYmVsOiAnR2VuZXJhdGUgd2l0aCBDbGF1ZGUgKHJlY29tbWVuZGVkKScsXG4gICAgICB2YWx1ZTogJ2dlbmVyYXRlJyxcbiAgICB9LFxuICAgIHtcbiAgICAgIGxhYmVsOiAnTWFudWFsIGNvbmZpZ3VyYXRpb24nLFxuICAgICAgdmFsdWU6ICdtYW51YWwnLFxuICAgIH0sXG4gIF1cblxuICByZXR1cm4gKFxuICAgIDxXaXphcmREaWFsb2dMYXlvdXRcbiAgICAgIHN1YnRpdGxlPVwiQ3JlYXRpb24gbWV0aG9kXCJcbiAgICAgIGZvb3RlclRleHQ9e1xuICAgICAgICA8QnlsaW5lPlxuICAgICAgICAgIDxLZXlib2FyZFNob3J0Y3V0SGludCBzaG9ydGN1dD1cIuKGkeKGk1wiIGFjdGlvbj1cIm5hdmlnYXRlXCIgLz5cbiAgICAgICAgICA8S2V5Ym9hcmRTaG9ydGN1dEhpbnQgc2hvcnRjdXQ9XCJFbnRlclwiIGFjdGlvbj1cInNlbGVjdFwiIC8+XG4gICAgICAgICAgPENvbmZpZ3VyYWJsZVNob3J0Y3V0SGludFxuICAgICAgICAgICAgYWN0aW9uPVwiY29uZmlybTpub1wiXG4gICAgICAgICAgICBjb250ZXh0PVwiQ29uZmlybWF0aW9uXCJcbiAgICAgICAgICAgIGZhbGxiYWNrPVwiRXNjXCJcbiAgICAgICAgICAgIGRlc2NyaXB0aW9uPVwiZ28gYmFja1wiXG4gICAgICAgICAgLz5cbiAgICAgICAgPC9CeWxpbmU+XG4gICAgICB9XG4gICAgPlxuICAgICAgPEJveD5cbiAgICAgICAgPFNlbGVjdFxuICAgICAgICAgIGtleT1cIm1ldGhvZC1zZWxlY3RcIlxuICAgICAgICAgIG9wdGlvbnM9e21ldGhvZE9wdGlvbnN9XG4gICAgICAgICAgb25DaGFuZ2U9eyh2YWx1ZTogc3RyaW5nKSA9PiB7XG4gICAgICAgICAgICBjb25zdCBtZXRob2QgPSB2YWx1ZSBhcyAnZ2VuZXJhdGUnIHwgJ21hbnVhbCdcbiAgICAgICAgICAgIHVwZGF0ZVdpemFyZERhdGEoe1xuICAgICAgICAgICAgICBtZXRob2QsXG4gICAgICAgICAgICAgIHdhc0dlbmVyYXRlZDogbWV0aG9kID09PSAnZ2VuZXJhdGUnLFxuICAgICAgICAgICAgfSlcblxuICAgICAgICAgICAgLy8gRHluYW1pYyBuYXZpZ2F0aW9uIGJhc2VkIG9uIG1ldGhvZFxuICAgICAgICAgICAgaWYgKG1ldGhvZCA9PT0gJ2dlbmVyYXRlJykge1xuICAgICAgICAgICAgICBnb05leHQoKSAvLyBHbyB0byBHZW5lcmF0ZVN0ZXAgKGluZGV4IDIpXG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICBnb1RvU3RlcCgzKSAvLyBTa2lwIHRvIFR5cGVTdGVwIChpbmRleCAzKVxuICAgICAgICAgICAgfVxuICAgICAgICAgIH19XG4gICAgICAgICAgb25DYW5jZWw9eygpID0+IGdvQmFjaygpfVxuICAgICAgICAvPlxuICAgICAgPC9Cb3g+XG4gICAgPC9XaXphcmREaWFsb2dMYXlvdXQ+XG4gIClcbn1cbiJdLCJtYXBwaW5ncyI6IjtBQUFBLE9BQU9BLEtBQUssSUFBSSxLQUFLQyxTQUFTLFFBQVEsT0FBTztBQUM3QyxTQUFTQyxHQUFHLFFBQVEsb0JBQW9CO0FBQ3hDLFNBQVNDLHdCQUF3QixRQUFRLHNDQUFzQztBQUMvRSxTQUFTQyxNQUFNLFFBQVEsaUNBQWlDO0FBQ3hELFNBQVNDLE1BQU0sUUFBUSxrQ0FBa0M7QUFDekQsU0FBU0Msb0JBQW9CLFFBQVEsZ0RBQWdEO0FBQ3JGLFNBQVNDLFNBQVMsUUFBUSwwQkFBMEI7QUFDcEQsU0FBU0Msa0JBQWtCLFFBQVEsdUNBQXVDO0FBQzFFLGNBQWNDLGVBQWUsUUFBUSxhQUFhO0FBRWxELE9BQU8sU0FBQUMsV0FBQTtFQUFBLE1BQUFDLENBQUEsR0FBQUMsRUFBQTtFQUNMO0lBQUFDLE1BQUE7SUFBQUMsTUFBQTtJQUFBQyxnQkFBQTtJQUFBQztFQUFBLElBQ0VULFNBQVMsQ0FBa0IsQ0FBQztFQUFBLElBQUFVLEVBQUE7RUFBQSxJQUFBTixDQUFBLFFBQUFPLE1BQUEsQ0FBQUMsR0FBQTtJQUVSRixFQUFBLElBQ3BCO01BQUFHLEtBQUEsRUFDUyxvQ0FBb0M7TUFBQUMsS0FBQSxFQUNwQztJQUNULENBQUMsRUFDRDtNQUFBRCxLQUFBLEVBQ1Msc0JBQXNCO01BQUFDLEtBQUEsRUFDdEI7SUFDVCxDQUFDLENBQ0Y7SUFBQVYsQ0FBQSxNQUFBTSxFQUFE7RUFBQTtJQUFBQSxFQUFBLEdBQUFOLENBQUE7RUFBQTtFQVRELE1BQUFXLGFBQUEsR0FBc0JMLEVBUnJCO0VBQUEsSUFBQU0sRUFBQTtFQUFBLElBQUFaLENBQUEsUUFBQU8sTUFBQSxDQUFBQyxHQUFBO0lBTUtJLEVBQUEsSUFBQyxNQUFNLENBQ0wsQ0FBQyxvQkFBb0IsQ0FBVSxRQUFJLENBQUosZUFBRyxDQUFDLENBQVEsTUFBVSxDQUFWLFVBQVUsR0FDckQsQ0FBQyxvQkFBb0IsQ0FBVSxRQUFPLENBQVAsT0FBTyxDQUFRLE1BQVEsQ0FBUixRQUFRLEdBQ3RELENBQUMsd0JBQXdCLENBQ2hCLE1BQVksQ0FBWixZQUFZLENBQ1gsT0FBYyxDQUFkLGNBQWMsQ0FDYixRQUFLLENBQUwsS0FBSyxDQUNGLFdBQVMsQ0FBVCxTQUFTLEdBRXpCLEVBVEMsTUFBTSxDQVNFO0lBQUFaLENBQUEsTUFBQVksRUFBQTtFQUFBO0lBQUFBLEVBQUEsR0FBQVosQ0FBQTtFQUFBO0VBQUEsSUFBQWEsRUFBQTtFQUFBLElBQUFiLENBQUEsUUFBQUUsTUFBQSxJQUFBRixDQUFBLFFBQUFLLFFBQUEsSUFBQUwsQ0FBQSxRQUFBSSxnQkFBQTtJQU9HUyxFQUFBLEdBQUFILEtBQUE7TUFDUixNQUFBSSxNQUFBLEdBQWVKLEtBQUssSUFBSSxVQUFVLEdBQUcsUUFBUTtNQUM3Q04sZ0JBQWdCLENBQUM7UUFBQVVNQUFBO1FBQUFDLFlBQUEsRUFFREQsTUFBTSxLQUFLO01BQzNCLENBQUMsQ0FBQztNQUdGLElBQUlBLE1BQU0sS0FBSyxVQUFVO1FBQ3ZCWixNQUFNLENBQUMsQ0FBQztNQUFBO1FBRVJHLFFBQVEsQ0FBQyxDQUFDLENBQUM7TUFBQTtJQUNaLENBQ0Y7SUFBQUwsQ0FBQSxNQUFBRSxNQUFBO0lBQUFGLENBQUEsTUFBQUssUUFBQTtJQUFBTCxDQUFBLE1BQUFJLGdCQUFBO0lBQUFKLENBQUEsTUFBQWEsRUFBQTtFQUFBO0lBQUFBLEVBQUEsR0FBQWIsQ0FBQTtFQUFBO0VBQUEsSUFBQWdCLEVBQUE7RUFBQSxJQUFBaEIsQ0FBQSxRQUFBRyxNQUFBO0lBQ1NhLEVBQUEsR0FBQUEsQ0FBQSxLQUFNYixNQUFNLENBQUMsQ0FBQztJQUFBSCxDQUFBLE1BQUFHLk1BQUE7SUFBQUgsQ0FBQSxNQUFBZ0IsRUFBQTtFQUFBO0lBQUFBLEVBQUEsR0FBQWhCLENBQUE7RUFBQTtFQUFBLElBQUFpQixFQUFBO0VBQUEsSUFBQWpCLENBQUEsUUFBQWEsRUFBQSxJQUFBYixDQUFBLFFBQUFnQixFQUFBO0lBakM5QkMsRUFBQSxJQUFDLGtCQUFrQixDQUNSLFFBQWlCLENBQWpCLGlCQUFpQixDQUV4QixVQVNTLENBVFQsQ0FBQUwsRUFTUSxDQUFDLENBR1gsQ0FBQyxHQUFHLENBQ0YsQ0FBQyxNQUFNLENBQ0QsR0FBZSxDQUFmLGVBQWUsQ0FDVkQsT0FBYSxDQUFiQSxjQUFZLENBQUMsQ0FDWixRQWFULENBYlMsQ0FBQUUsRUFhVixDQUFDLENBQ1MsUUFBYyxDQUFkLENBQUFHLEVBQWEsQ0FBQyxHQUU1QixFQXBCQyxHQUFHLENBcUJOLEVBcENDLGtCQUFrQixDQW9DRTtJQUFBaEIsQ0FBQSxNQUFBYSxFQUFBO0lBQUFiLENBQUEsTUFBQWdCLEVBQUE7SUFBQWhCLENBQUEsT0FBQWlCLEVBQUE7RUFBQTtJQUFBQSxFQUFBLEdBQUFqQixDQUFBO0VBQUE7RUFBQSxPQXBDckJpQixFQW9DcUI7QUFBQSIsImlnbm9yZUxpc3QiOltdfQ==
