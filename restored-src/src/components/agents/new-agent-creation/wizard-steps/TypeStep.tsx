/**
 * TypeStep.tsx — Agent 创建向导：输入 Agent 类型标识符步骤
 *
 * 在 Claude Code 系统流程中的位置：
 *   AgentTool → new-agent-creation/AgentWizard → wizard-steps/TypeStep（当前文件）
 *
 * 主要功能：
 *   - 提供文本输入框，让用户输入 Agent 的唯一类型标识符（如 "test-runner"）
 *   - 提交前使用 validateAgentType 进行格式校验（正则 /^[a-zA-Z0-9][a-zA-Z0-9-]*[a-zA-Z0-9]$/, 长度 3-50）
 *   - 验证通过后将 agentType 写入 wizardData 并前进到下一步
 *
 * 键盘绑定策略：
 *   - ESC（confirm:no）使用 "Settings" 上下文，避免与输入框中的 'n' 键冲突
 *
 * 依赖：
 *   - react/compiler-runtime (_c)：React 编译器自动生成的记忆化缓存（15 个槽位）
 *   - useKeybinding：注册上下文感知的键盘快捷键
 *   - validateAgentType：Agent 类型标识符格式校验函数
 *   - TextInput：支持光标偏移管理的终端文本输入组件（Ink）
 */
import { c as _c } from "react/compiler-runtime";
import React, { type ReactNode, useState } from 'react';
import { Box, Text } from '../../../../ink.js';
import { useKeybinding } from '../../../../keybindings/useKeybinding.js';
import type { AgentDefinition } from '../../../../tools/AgentTool/loadAgentsDir.js';
import { ConfigurableShortcutHint } from '../../../ConfigurableShortcutHint.js';
import { Byline } from '../../../design-system/Byline.js';
import { KeyboardShortcutHint } from '../../../design-system/KeyboardShortcutHint.js';
import TextInput from '../../../TextInput.js';
import { useWizard } from '../../../wizard/index.js';
import { WizardDialogLayout } from '../../../wizard/WizardDialogLayout.js';
import { validateAgentType } from '../../validateAgent.js';
import type { AgentWizardData } from '../types.js';

// 组件 Props 类型：接收已有 Agent 列表（当前仅用于类型约束，未在组件内使用）
type Props = {
  existingAgents: AgentDefinition[];
};

/**
 * TypeStep — 向导 Agent 类型标识符输入步骤。
 *
 * 整体流程：
 *   1. 从 useWizard 获取 goNext / goBack / updateWizardData / wizardData
 *   2. 初始化本地状态：agentType（预填向导已有值）、error、cursorOffset
 *   3. 注册 ESC 键绑定（Settings 上下文），避免输入 'n' 时误触取消
 *   4. 构建 handleSubmit 回调：trim → validateAgentType → 有错误则设置错误并返回，否则保存并 goNext()
 *   5. 构建静态底部快捷键提示 JSX（React 编译器确保只创建一次）
 *   6. 构建静态说明文字 JSX
 *   7. 构建文本输入框 JSX（依赖 agentType / cursorOffset / handleSubmit）
 *   8. 构建错误提示 JSX（依赖 error）
 *   9. 组装最终布局并返回
 *
 * 注意：_props 参数（含 existingAgents）在此版本中未被使用，
 *       仅通过向导上下文读取和更新数据。
 */
export function TypeStep(_props) {
  // React 编译器生成的记忆化缓存，共 15 个槽位
  const $ = _c(15);

  // 从向导上下文获取导航和数据更新方法
  const {
    goNext,
    goBack,
    updateWizardData,
    wizardData
  } = useWizard();

  // 本地状态：当前输入的 agentType（优先使用已有向导数据）
  const [agentType, setAgentType] = useState(wizardData.agentType || "");
  // 本地状态：验证错误消息（null 表示无错误）
  const [error, setError] = useState(null);
  // 本地状态：光标在文本中的偏移量
  const [cursorOffset, setCursorOffset] = useState(agentType.length);

  // ── 槽位 $[0]：静态 Settings 上下文对象（仅创建一次）─────────────────────
  let t0;
  if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
    t0 = {
      context: "Settings" // 使用 Settings 上下文，避免 'n' 键被截获为确认否
    };
    $[0] = t0;
  } else {
    t0 = $[0];
  }
  // 注册 ESC 键绑定：按 ESC 返回上一步（MethodStep）
  useKeybinding("confirm:no", goBack, t0);

  // ── 槽位 $[1-3]：handleSubmit 回调（依赖 goNext / updateWizardData）──────
  let t1;
  if ($[1] !== goNext || $[2] !== updateWizardData) {
    // 任意依赖变化时，重新创建提交回调
    t1 = value => {
      // 去除首尾空白
      const trimmedValue = value.trim();
      // 调用校验函数，返回 null 表示通过，返回字符串表示错误消息
      const validationError = validateAgentType(trimmedValue);

      if (validationError) {
        // 格式不符合要求时，显示错误并阻止前进
        setError(validationError);
        return;
      }

      // 验证通过：清除错误、写入 wizard 数据、进入下一步
      setError(null);
      updateWizardData({
        agentType: trimmedValue // 保存去空白后的标识符
      });
      goNext();
    };
    $[1] = goNext;
    $[2] = updateWizardData;
    $[3] = t1; // 缓存新回调
  } else {
    t1 = $[3]; // 依赖未变，复用已缓存的回调
  }
  const handleSubmit = t1;

  // ── 槽位 $[4]：静态底部快捷键提示 JSX（仅首次渲染时创建）────────────────
  let t2;
  if ($[4] === Symbol.for("react.memo_cache_sentinel")) {
    // 显示三个操作提示：输入文字、Enter 继续、Esc 返回
    t2 = <Byline><KeyboardShortcutHint shortcut="Type" action="enter text" /><KeyboardShortcutHint shortcut="Enter" action="continue" /><ConfigurableShortcutHint action="confirm:no" context="Settings" fallback="Esc" description="go back" /></Byline>;
    $[4] = t2; // 写入缓存
  } else {
    t2 = $[4]; // 从缓存读取，避免重复创建
  }

  // ── 槽位 $[5]：静态说明文字 JSX（仅首次渲染时创建）──────────────────────
  let t3;
  if ($[5] === Symbol.for("react.memo_cache_sentinel")) {
    t3 = <Text>Enter a unique identifier for your agent:</Text>;
    $[5] = t3; // 写入缓存
  } else {
    t3 = $[5]; // 从缓存读取
  }

  // ── 槽位 $[6-9]：文本输入框 JSX（依赖 agentType / cursorOffset / handleSubmit）
  let t4;
  if ($[6] !== agentType || $[7] !== cursorOffset || $[8] !== handleSubmit) {
    // 任意输入相关状态变化时，重建 TextInput JSX
    t4 = <Box marginTop={1}><TextInput value={agentType} onChange={setAgentType} onSubmit={handleSubmit} placeholder="e.g., test-runner, tech-lead, etc" columns={60} cursorOffset={cursorOffset} onChangeCursorOffset={setCursorOffset} focus={true} showCursor={true} /></Box>;
    $[6] = agentType;
    $[7] = cursorOffset;
    $[8] = handleSubmit;
    $[9] = t4;
  } else {
    t4 = $[9]; // 输入未变，复用缓存
  }

  // ── 槽位 $[10-11]：错误提示 JSX（依赖 error）──────────────────────────
  let t5;
  if ($[10] !== error) {
    // error 变化时重建（null 时不渲染任何内容）
    t5 = error && <Box marginTop={1}><Text color="error">{error}</Text></Box>;
    $[10] = error;
    $[11] = t5;
  } else {
    t5 = $[11];
  }

  // ── 槽位 $[12-14]：最终完整布局（依赖 t4 输入框 / t5 错误提示）───────────
  let t6;
  if ($[12] !== t4 || $[13] !== t5) {
    // 输入框或错误提示变化时，重建整个对话框
    t6 = <WizardDialogLayout subtitle="Agent type (identifier)" footerText={t2}><Box flexDirection="column">{t3}{t4}{t5}</Box></WizardDialogLayout>;
    $[12] = t4;
    $[13] = t5;
    $[14] = t6;
  } else {
    t6 = $[14]; // 两者均未变化，复用缓存的完整 JSX
  }
  return t6;
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJSZWFjdCIsIlJlYWN0Tm9kZSIsInVzZVN0YXRlIiwiQm94IiwiVGV4dCIsInVzZUtleWJpbmRpbmciLCJBZ2VudERlZmluaXRpb24iLCJDb25maWd1cmFibGVTaG9ydGN1dEhpbnQiLCJCeWxpbmUiLCJLZXlib2FyZFNob3J0Y3V0SGludCIsIlRleHRJbnB1dCIsInVzZVdpemFyZCIsIldpemFyZERpYWxvZ0xheW91dCIsInZhbGlkYXRlQWdlbnRUeXBlIiwiQWdlbnRXaXphcmREYXRhIiwiUHJvcHMiLCJleGlzdGluZ0FnZW50cyIsIlR5cGVTdGVwIiwiX3Byb3BzIiwiJCIsIl9jIiwiZ29OZXh0IiwiZ29CYWNrIiwidXBkYXRlV2l6YXJkRGF0YSIsIndpemFyZERhdGEiLCJhZ2VudFR5cGUiLCJzZXRBZ2VudFR5cGUiLCJlcnJvciIsInNldEVycm9yIiwiY3Vyc29yT2Zmc2V0Iiwic2V0Q3Vyc29yT2Zmc2V0IiwibGVuZ3RoIiwidDAiLCJTeW1ib2wiLCJmb3IiLCJjb250ZXh0IiwidDEiLCJ2YWx1ZSIsInRyaW1tZWRWYWx1ZSIsInRyaW0iLCJ2YWxpZGF0aW9uRXJyb3IiLCJoYW5kbGVTdWJtaXQiLCJ0MiIsInQzIiwidDQiLCJ0NSIsInQ2Il0sInNvdXJjZXMiOlsiVHlwZVN0ZXAudHN4Il0sInNvdXJjZXNDb250ZW50IjpbImltcG9ydCBSZWFjdCwgeyB0eXBlIFJlYWN0Tm9kZSwgdXNlU3RhdGUgfSBmcm9tICdyZWFjdCdcbmltcG9ydCB7IEJveCwgVGV4dCB9IGZyb20gJy4uLy4uLy4uLy4uL2luay5qcydcbmltcG9ydCB7IHVzZUtleWJpbmRpbmcgfSBmcm9tICcuLi8uLi8uLi8uLi9rZXliaW5kaW5ncy91c2VLZXliaW5kaW5nLmpzJ1xuaW1wb3J0IHR5cGUgeyBBZ2VudERlZmluaXRpb24gfSBmcm9tICcuLi8uLi8uLi8uLi90b29scy9BZ2VudFRvb2wvbG9hZEFnZW50c0Rpci5qcydcbmltcG9ydCB7IENvbmZpZ3VyYWJsZVNob3J0Y3V0SGludCB9IGZyb20gJy4uLy4uLy4uL0NvbmZpZ3VyYWJsZVNob3J0Y3V0SGludC5qcydcbmltcG9ydCB7IEJ5bGluZSB9IGZyb20gJy4uLy4uLy4uL2Rlc2lnbi1zeXN0ZW0vQnlsaW5lLmpzJ1xuaW1wb3J0IHsgS2V5Ym9hcmRTaG9ydGN1dEhpbnQgfSBmcm9tICcuLi8uLi8uLi9kZXNpZ24tc3lzdGVtL0tleWJvYXJkU2hvcnRjdXRIaW50LmpzJ1xuaW1wb3J0IFRleHRJbnB1dCBmcm9tICcuLi8uLi8uLi9UZXh0SW5wdXQuanMnXG5pbXBvcnQgeyB1c2VXaXphcmQgfSBmcm9tICcuLi8uLi8uLi93aXphcmQvaW5kZXguanMnXG5pbXBvcnQgeyBXaXphcmREaWFsb2dMYXlvdXQgfSBmcm9tICcuLi8uLi8uLi93aXphcmQvV2l6YXJkRGlhbG9nTGF5b3V0LmpzJ1xuaW1wb3J0IHsgdmFsaWRhdGVBZ2VudFR5cGUgfSBmcm9tICcuLi8uLi92YWxpZGF0ZUFnZW50LmpzJ1xuaW1wb3J0IHR5cGUgeyBBZ2VudFdpemFyZERhdGEgfSBmcm9tICcuLi90eXBlcy5qcydcblxudHlwZSBQcm9wcyA9IHtcbiAgZXhpc3RpbmdBZ2VudHM6IEFnZW50RGVmaW5pdGlvbltdXG59XG5cbmV4cG9ydCBmdW5jdGlvbiBUeXBlU3RlcChfcHJvcHM6IFByb3BzKTogUmVhY3ROb2RlIHtcbiAgY29uc3QgeyBnb05leHQsIGdvQmFjaywgdXBkYXRlV2l6YXJkRGF0YSwgd2l6YXJkRGF0YSB9ID1cbiAgICB1c2VXaXphcmQ8QWdlbnRXaXphcmREYXRhPigpXG4gIGNvbnN0IFthZ2VudFR5cGUsIHNldEFnZW50VHlwZV0gPSB1c2VTdGF0ZSh3aXphcmREYXRhLmFnZW50VHlwZSB8fCAnJylcbiAgY29uc3QgW2Vycm9yLCBzZXRFcnJvcl0gPSB1c2VTdGF0ZTxzdHJpbmcgfCBudWxsPihudWxsKVxuICBjb25zdCBbY3Vyc29yT2Zmc2V0LCBzZXRDdXJzb3JPZmZzZXRdID0gdXNlU3RhdGUoYWdlbnRUeXBlLmxlbmd0aClcblxuICAvLyBIYW5kbGUgZXNjYXBlIGtleSAtIEdvIGJhY2sgdG8gTWV0aG9kU3RlcFxuICAvLyBVc2UgU2V0dGluZ3MgY29udGV4dCBzbyAnbicga2V5IGRvZXNuJ3QgY2FuY2VsIChhbGxvd3MgdHlwaW5nICduJyBpbiBpbnB1dClcbiAgdXNlS2V5YmluZGluZygnY29uZmlybTpubycsIGdvQmFjaywgeyBjb250ZXh0OiAnU2V0dGluZ3MnIH0pXG5cbiAgY29uc3QgaGFuZGxlU3VibWl0ID0gKHZhbHVlOiBzdHJpbmcpOiB2b2lkID0+IHtcbiAgICBjb25zdCB0cmltbWVkVmFsdWUgPSB2YWx1ZS50cmltKClcbiAgICBjb25zdCB2YWxpZGF0aW9uRXJyb3IgPSB2YWxpZGF0ZUFnZW50VHlwZSh0cmltbWVkVmFsdWUpXG5cbiAgICBpZiAodmFsaWRhdGlvbkVycm9yKSB7XG4gICAgICBzZXRFcnJvcih2YWxpZGF0aW9uRXJyb3IpXG4gICAgICByZXR1cm5cbiAgICB9XG5cbiAgICBzZXRFcnJvcihudWxsKVxuICAgIHVwZGF0ZVdpemFyZERhdGEoeyBhZ2VudFR5cGU6IHRyaW1tZWRWYWx1ZSB9KVxuICAgIGdvTmV4dCgpXG4gIH1cblxuICByZXR1cm4gKFxuICAgIDxXaXphcmREaWFsb2dMYXlvdXRcbiAgICAgIHN1YnRpdGxlPVwiQWdlbnQgdHlwZSAoaWRlbnRpZmllcilcIlxuICAgICAgZm9vdGVyVGV4dD17XG4gICAgICAgIDxCeWxpbmU+XG4gICAgICAgICAgPEtleWJvYXJkU2hvcnRjdXRIaW50IHNob3J0Y3V0PVwiVHlwZVwiIGFjdGlvbj1cImVudGVyIHRleHRcIiAvPlxuICAgICAgICAgIDxLZXlib2FyZFNob3J0Y3V0SGludCBzaG9ydGN1dD1cIkVudGVyXCIgYWN0aW9uPVwiY29udGludWVcIiAvPlxuICAgICAgICAgIDxDb25maWd1cmFibGVTaG9ydGN1dEhpbnRcbiAgICAgICAgICAgIGFjdGlvbj1cImNvbmZpcm06bm9cIlxuICAgICAgICAgICAgY29udGV4dD1cIlNldHRpbmdzXCJcbiAgICAgICAgICAgIGZhbGxiYWNrPVwiRXNjXCJcbiAgICAgICAgICAgIGRlc2NyaXB0aW9uPVwiZ28gYmFja1wiXG4gICAgICAgICAgLz5cbiAgICAgICAgPC9CeWxpbmU+XG4gICAgICB9XG4gICAgPlxuICAgICAgPEJveCBmbGV4RGlyZWN0aW9uPVwiY29sdW1uXCI+XG4gICAgICAgIDxUZXh0PkVudGVyIGEgdW5pcXVlIGlkZW50aWZpZXIgZm9yIHlvdXIgYWdlbnQ6PC9UZXh0PlxuICAgICAgICA8Qm94IG1hcmdpblRvcD17MX0+XG4gICAgICAgICAgPFRleHRJbnB1dFxuICAgICAgICAgICAgdmFsdWU9e2FnZW50VHlwZX1cbiAgICAgICAgICAgIG9uQ2hhbmdlPXtzZXRBZ2VudFR5cGV9XG4gICAgICAgICAgICBvblN1Ym1pdD17aGFuZGxlU3VibWl0fVxuICAgICAgICAgICAgcGxhY2Vob2xkZXI9XCJlLmcuLCB0ZXN0LXJ1bm5lciwgdGVjaC1sZWFkLCBldGNcIlxuICAgICAgICAgICAgY29sdW1ucz17NjB9XG4gICAgICAgICAgICBjdXJzb3JPZmZzZXQ9e2N1cnNvck9mZnNldH1cbiAgICAgICAgICAgIG9uQ2hhbmdlQ3Vyc29yT2Zmc2V0PXtzZXRDdXJzb3JPZmZzZXR9XG4gICAgICAgICAgICBmb2N1c1xuICAgICAgICAgICAgc2hvd0N1cnNvclxuICAgICAgICAgIC8+XG4gICAgICAgIDwvQm94PlxuXG4gICAgICAgIHtlcnJvciAmJiAoXG4gICAgICAgICAgPEJveCBtYXJnaW5Ub3A9ezF9PlxuICAgICAgICAgICAgPFRleHQgY29sb3I9XCJlcnJvclwiPntlcnJvcn08L1RleHQ+XG4gICAgICAgICAgPC9Cb3g+XG4gICAgICAgICl9XG4gICAgICA8L0JveD5cbiAgICA8L1dpemFyZERpYWxvZ0xheW91dD5cbiAgKVxufVxuIl0sIm1hcHBpbmdzIjoiO0FBQUEsT0FBT0EsS0FBSyxJQUFJLEtBQUtDLFNBQVMsRUFBRUMsUUFBUSxRQUFRLE9BQU87QUFDdkQsU0FBU0MsR0FBRyxFQUFF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
