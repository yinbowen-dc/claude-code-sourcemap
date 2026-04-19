/**
 * ToolsStep.tsx — Agent 创建向导：选择工具步骤
 *
 * 在 Claude Code 系统流程中的位置：
 *   AgentTool → new-agent-creation/AgentWizard → wizard-steps/ToolsStep（当前文件）
 *
 * 主要功能：
 *   - 向用户展示所有可用工具，允许多选（通过 ToolSelector 组件）
 *   - 支持 "全部工具" 语义：若 selectedTools 为 undefined，表示 Agent 有权使用所有工具
 *   - 确认选择后将 selectedTools 写入 wizardData 并调用 goNext() 进入下一步
 *
 * 设计注意：
 *   - ToolsStep 本身传递 undefined 以保留 "全部工具" 的语义完整性
 *   - ToolSelector 内部会将 undefined 展开为完整工具列表（仅用于 UI 显示）
 *
 * 依赖：
 *   - react/compiler-runtime (_c)：React 编译器自动生成的记忆化缓存（9 个槽位）
 *   - useWizard：wizard 上下文钩子
 *   - ToolSelector：工具多选 UI 组件
 */
import { c as _c } from "react/compiler-runtime";
import React, { type ReactNode } from 'react';
import type { Tools } from '../../../../Tool.js';
import { ConfigurableShortcutHint } from '../../../ConfigurableShortcutHint.js';
import { Byline } from '../../../design-system/Byline.js';
import { KeyboardShortcutHint } from '../../../design-system/KeyboardShortcutHint.js';
import { useWizard } from '../../../wizard/index.js';
import { WizardDialogLayout } from '../../../wizard/WizardDialogLayout.js';
import { ToolSelector } from '../../ToolSelector.js';
import type { AgentWizardData } from '../types.js';

// 组件 Props 类型：需要传入可用工具列表
type Props = {
  tools: Tools;
};

/**
 * ToolsStep — 向导工具选择步骤。
 *
 * 整体流程：
 *   1. 从 useWizard 获取 goNext / goBack / updateWizardData / wizardData
 *   2. 构建 handleComplete 回调：
 *      - 接收 selectedTools（string[] | undefined）
 *      - 写入 wizardData 并调用 goNext()
 *   3. 从 wizardData 读取 initialTools 作为 ToolSelector 的初始状态
 *   4. 构建静态底部快捷键提示 JSX（React 编译器仅创建一次）
 *   5. 组装 WizardDialogLayout + ToolSelector 并返回
 */
export function ToolsStep(t0) {
  // React 编译器生成的记忆化缓存，共 9 个槽位
  const $ = _c(9);

  // 解构 Props：tools 是可用工具的完整列表
  const {
    tools
  } = t0;

  // 从向导上下文获取导航和数据更新方法
  const {
    goNext,
    goBack,
    updateWizardData,
    wizardData
  } = useWizard();

  // ── 槽位 $[0-2]：handleComplete 回调（依赖 goNext / updateWizardData）─────
  let t1;
  if ($[0] !== goNext || $[1] !== updateWizardData) {
    // 任意依赖变化时，重新创建回调
    t1 = selectedTools => {
      // 将选择的工具数组（或 undefined 表示全部）写入 wizard 共享数据
      updateWizardData({
        selectedTools
      });
      // 进入下一步
      goNext();
    };
    $[0] = goNext;
    $[1] = updateWizardData;
    $[2] = t1; // 缓存回调
  } else {
    t1 = $[2]; // 依赖未变，复用缓存
  }
  const handleComplete = t1;

  // 读取向导已有的工具选择，作为 ToolSelector 的初始值
  // 若为 undefined，ToolSelector 将以"全部已选"状态初始化
  const initialTools = wizardData.selectedTools;

  // ── 槽位 $[3]：静态底部快捷键提示 JSX（仅首次渲染时创建）────────────────
  let t2;
  if ($[3] === Symbol.for("react.memo_cache_sentinel")) {
    // 哨兵值说明该槽未初始化，创建键盘提示：Enter 切换选中、↑↓ 导航、Esc 返回
    t2 = <Byline><KeyboardShortcutHint shortcut="Enter" action="toggle selection" /><KeyboardShortcutHint shortcut={"\u2191\u2193"} action="navigate" /><ConfigurableShortcutHint action="confirm:no" context="Confirmation" fallback="Esc" description="go back" /></Byline>;
    $[3] = t2; // 写入缓存
  } else {
    t2 = $[3]; // 从缓存读取，避免重复创建
  }

  // ── 槽位 $[4-8]：最终渲染的 JSX（依赖 goBack / handleComplete / initialTools / tools）
  let t3;
  if ($[4] !== goBack || $[5] !== handleComplete || $[6] !== initialTools || $[7] !== tools) {
    // 任意依赖变化时，重建整个对话框 JSX
    t3 = <WizardDialogLayout subtitle="Select tools" footerText={t2}><ToolSelector tools={tools} initialTools={initialTools} onComplete={handleComplete} onCancel={goBack} /></WizardDialogLayout>;
    $[4] = goBack;
    $[5] = handleComplete;
    $[6] = initialTools;
    $[7] = tools;
    $[8] = t3;
  } else {
    t3 = $[8]; // 结构未变，复用缓存 JSX
  }
  return t3;
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJSZWFjdCIsIlJlYWN0Tm9kZSIsIlRvb2xzIiwiQ29uZmlndXJhYmxlU2hvcnRjdXRIaW50IiwiQnlsaW5lIiwiS2V5Ym9hcmRTaG9ydGN1dEhpbnQiLCJ1c2VXaXphcmQiLCJXaXphcmREaWFsb2dMYXlvdXQiLCJUb29sU2VsZWN0b3IiLCJBZ2VudFdpemFyZERhdGEiLCJQcm9wcyIsInRvb2xzIiwiVG9vbHNTdGVwIiwidDAiLCIkIiwiX2MiLCJnb05leHQiLCJnb0JhY2siLCJ1cGRhdGVXaXphcmREYXRhIiwid2l6YXJkRGF0YSIsInQxIiwic2VsZWN0ZWRUb29scyIsImhhbmRsZUNvbXBsZXRlIiwiaW5pdGlhbFRvb2xzIiwidDIiLCJTeW1ib2wiLCJmb3IiLCJ0MyJdLCJzb3VyY2VzIjpbIlRvb2xzU3RlcC50c3giXSwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IFJlYWN0LCB7IHR5cGUgUmVhY3ROb2RlIH0gZnJvbSAncmVhY3QnXG5pbXBvcnQgdHlwZSB7IFRvb2xzIH0gZnJvbSAnLi4vLi4vLi4vLi4vVG9vbC5qcydcbmltcG9ydCB7IENvbmZpZ3VyYWJsZVNob3J0Y3V0SGludCB9IGZyb20gJy4uLy4uLy4uL0NvbmZpZ3VyYWJsZVNob3J0Y3V0SGludC5qcydcbmltcG9ydCB7IEJ5bGluZSB9IGZyb20gJy4uLy4uLy4uL2Rlc2lnbi1zeXN0ZW0vQnlsaW5lLmpzJ1xuaW1wb3J0IHsgS2V5Ym9hcmRTaG9ydGN1dEhpbnQgfSBmcm9tICcuLi8uLi8uLi9kZXNpZ24tc3lzdGVtL0tleWJvYXJkU2hvcnRjdXRIaW50LmpzJ1xuaW1wb3J0IHsgdXNlV2l6YXJkIH0gZnJvbSAnLi4vLi4vLi4vd2l6YXJkL2luZGV4LmpzJ1xuaW1wb3J0IHsgV2l6YXJkRGlhbG9nTGF5b3V0IH0gZnJvbSAnLi4vLi4vLi4vd2l6YXJkL1dpemFyZERpYWxvZ0xheW91dC5qcydcbmltcG9ydCB7IFRvb2xTZWxlY3RvciB9IGZyb20gJy4uLy4uL1Rvb2xTZWxlY3Rvci5qcydcbmltcG9ydCB0eXBlIHsgQWdlbnRXaXphcmREYXRhIH0gZnJvbSAnLi4vdHlwZXMuanMnXG5cbnR5cGUgUHJvcHMgPSB7XG4gIHRvb2xzOiBUb29sc1xufVxuXG5leHBvcnQgZnVuY3Rpb24gVG9vbHNTdGVwKHsgdG9vbHMgfTogUHJvcHMpOiBSZWFjdE5vZGUge1xuICBjb25zdCB7IGdvTmV4dCwgZ29CYWNrLCB1cGRhdGVXaXphcmREYXRhLCB3aXphcmREYXRhIH0gPVxuICAgIHVzZVdpemFyZDxBZ2VudFdpemFyZERhdGE+KClcblxuICBjb25zdCBoYW5kbGVDb21wbGV0ZSA9IChzZWxlY3RlZFRvb2xzOiBzdHJpbmdbXSB8IHVuZGVmaW5lZCk6IHZvaWQgPT4ge1xuICAgIHVwZGF0ZVdpemFyZERhdGEoeyBzZWxlY3RlZFRvb2xzIH0pXG4gICAgZ29OZXh0KClcbiAgfVxuXG4gIC8vIFBhc3MgdGhyb3VnaCB1bmRlZmluZWQgdG8gcHJlc2VydmUgXCJhbGwgdG9vbHNcIiBzZW1hbnRpY1xuICAvLyBUb29sU2VsZWN0b3Igd2lsbCBleHBhbmQgaXQgaW50ZXJuYWxseSBmb3IgZGlzcGxheSBwdXJwb3Nlc1xuICBjb25zdCBpbml0aWFsVG9vbHMgPSB3aXphcmREYXRhLnNlbGVjdGVkVG9vbHNcblxuICByZXR1cm4gKFxuICAgIDxXaXphcmREaWFsb2dMYXlvdXRcbiAgICAgIHN1YnRpdGxlPVwiU2VsZWN0IHRvb2xzXCJcbiAgICAgIGZvb3RlclRleHQ9e1xuICAgICAgICA8QnlsaW5lPlxuICAgICAgICAgIDxLZXlib2FyZFNob3J0Y3V0SGludCBzaG9ydGN1dD1cIkVudGVyXCIgYWN0aW9uPVwidG9nZ2xlIHNlbGVjdGlvblwiIC8+XG4gICAgICAgICAgPEtleWJvYXJkU2hvcnRjdXRIaW50IHNob3J0Y3V0PVwi4oaR4oaTXCIgYWN0aW9uPVwibmF2aWdhdGVcIiAvPlxuICAgICAgICAgIDxDb25maWd1cmFibGVTaG9ydGN1dEhpbnRcbiAgICAgICAgICAgIGFjdGlvbj1cImNvbmZpcm06bm9cIlxuICAgICAgICAgICAgY29udGV4dD1cIkNvbmZpcm1hdGlvblwiXG4gICAgICAgICAgICBmYWxsYmFjaz1cIkVzY1wiXG4gICAgICAgICAgICBkZXNjcmlwdGlvbj1cImdvIGJhY2tcIlxuICAgICAgICAgIC8+XG4gICAgICAgIDwvQnlsaW5lPlxuICAgICAgfVxuICAgID5cbiAgICAgIDxUb29sU2VsZWN0b3JcbiAgICAgICAgdG9vbHM9e3Rvb2xzfVxuICAgICAgICBpbml0aWFsVG9vbHM9e2luaXRpYWxUb29sc31cbiAgICAgICAgb25Db21wbGV0ZT17aGFuZGxlQ29tcGxldGV9XG4gICAgICAgIG9uQ2FuY2VsPXtnb0JhY2t9XG4gICAgICAvPlxuICAgIDwvV2l6YXJkRGlhbG9nTGF5b3V0PlxuICApXG59XG4iXSwibWFwcGluZ3MiOiI7QUFBQSxPQUFPQSxLQUFLLElBQUksS0FBS0MsU0FBUyxRQUFRLE9BQU87QUFDN0MsY0FBY0MsS0FBSyxRQUFRLHFCQUFxQjtBQUNoRCxTQUFTQyx3QkFBd0IsUUFBUSxzQ0FBc0M7QUFDL0UsU0FBU0MsTUFBTSxRQUFRLGtDQUFrQztBQUN6RCxTQUFTQyxvQkFBb0IsUUFBUSxnREFBZ0Q7QUFDckYsU0FBU0MsU0FBUyxRQUFRLDBCQUEwQjtBQUNwRCxTQUFTQyxrQkFBa0IsUUFBUSx1Q0FBdUM7QUFDMUUsU0FBU0MsWUFBWSxRQUFRLHVCQUF1QjtBQUNwRCxjQUFjQyxlQUFlLFFBQVEsYUFBYTtBQUVsRCxLQUFLQyxLQUFLLEdBQUc7RUFDWEMsS0FBSyxFQUFFVCxLQUFLO0FBQ2QsQ0FBQztBQUVELE9BQU8sU0FBQVUsVUFBQUMsRUFBQTtFQUFBLE1BQUFDLENBQUEsR0FBQUMsRUFBQTtFQUFtQjtJQUFBSjtFQUFBLElBQUFFLEVBQWdCO0VBQ3hDO0lBQUFHLE1BQUE7SUFBQUMsTUFBQTtJQUFBQyxnQkFBQTtJQUFBQztFQUFBLElBQ0ViLFNBQVMsQ0FBa0IsQ0FBQztFQUFBLElBQUFjLEVBQUE7RUFBQSxJQUFBTixDQUFBLFFBQUFFLE1BQUEsSUFBQUYsQ0FBQSxRQUFBSSxnQkFBQTtJQUVQRSxFQUFBLEdBQUFDLGFBQUE7TUFDckJILGdCQUFnQixDQUFDO1FBQUFHO01BQWdCLENBQUMsQ0FBQztNQUNuQ0wsTUFBTSxDQUFDLENBQUM7SUFBQSxDQUNUO0lBQUFGLENBQUEsTUFBQUUsTUFBQTtJQUFBRixDQUFBLE1BQUFJLGdCQUFBO0lBQUFKLENBQUEsTUFBQU0sRUFBQTtFQUFBO0lBQUFBLEVBQUEsR0FBQU4sQ0FBQTtFQUFBO0VBSEQsTUFBQVEsY0FBQSxHQUF1QkYsRUFHdEI7RUFJRCxNQUFBRyxZQUFBLEdBQXFCSixVQUFVLENBQUFFLGFBQWM7RUFBQSxJQUFBRyxFQUFBO0VBQUEsSUFBQVYsQ0FBQSxRQUFBVyxNQUFBLENBQUFDLEdBQUE7SUFNdkNGLEVBQUEsSUFBQyxNQUFNLENBQ0wsQ0FBQyxvQkFBb0IsQ0FBVSxRQUFPLENBQVAsT0FBTyxDQUFRLE1BQWtCLENBQWxCLGtCQUFrQixHQUNoRSxDQUFDLG9CQUFvQixDQUFVLFFBQUksQ0FBSixlQUFHLENBQUMsQ0FBUSxNQUFVLENBQVYsVUFBVSxHQUNyRCxDQUFDLHdCQUF3QixDQUNoQixNQUFZLENBQVosWUFBWSxDQUNYLE9BQWMsQ0FBZCxjQUFjLENBQ2IsUUFBSyxDQUFMLEtBQUssQ0FDRixXQUFTLENBQVQsU0FBUyxHQUV6QixFQVRDLE1BQU0sQ0FTRTtJQUFBWixDQUFBLE1BQUFRLEVBQUE7RUFBQTtJQUFBQSxFQUFBLEdBQUFaLENBQUE7RUFBQTtFQUFBLElBQUFhLEVBQUE7RUFBQSxJQUFBYixDQUFBLFFBQUFHLE1BQUEsSUFBQUgsQ0FBQSxRQUFBUSxjQUFBLElBQUFSLENBQUEsUUFBQVMsWUFBQSxJQUFBVCxDQUFBLFFBQUFILEtBQUE7SUFaYmdCLEVBQUEsSUFBQyxrQkFBa0IsQ0FDUixRQUFjLENBQWQsY0FBYyxDQUVyQixVQVNTLENBVFQsQ0FBQUgsRUFTUSxDQUFDLENBR1gsQ0FBQyxZQUFZLENBQ0piLEtBQUssQ0FBTEEsTUFBSSxDQUFDLENBQ0VZLFlBQVksQ0FBWkEsYUFBVyxDQUFDLENBQ2RELFVBQWMsQ0FBZEEsZUFBYSxDQUFDLENBQ2hCTCxRQUFNLENBQU5BLE9BQUssQ0FBQyxHQUVwQixFQXJCQyxrQkFBa0IsQ0FxQkU7SUFBQUgsQ0FBQSxNQUFBRyxNQUFBO0lBQUFILENBQUEsTUFBQVEsY0FBQTtJQUFBUixDQUFBLE1BQUFTLFlBQUE7SUFBQVQsQ0FBQSxNQUFBSCxLQUFBO0lBQUFHLENBQUEsTUFBQWEsRUFBQTtFQUFBO0lBQUFBLEVBQUEsR0FBQWIsQ0FBQTtFQUFBO0VBQUEsT0FyQnJCYSxFQXFCcUI7QUFBQSIsImlnbm9yZUxpc3QiOltdfQ==
