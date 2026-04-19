/**
 * PromptStep.tsx — Agent 创建向导：输入系统提示词步骤
 *
 * 在 Claude Code 系统流程中的位置：
 *   AgentTool → new-agent-creation/AgentWizard → wizard-steps/PromptStep（当前文件）
 *
 * 主要功能：
 *   - 提供文本输入框，让用户输入 Agent 的系统提示词（system prompt）
 *   - 支持通过外部编辑器（$EDITOR / ctrl+g）编辑长文本提示词
 *   - 提交前验证提示词非空（trim 后判断）
 *   - 将验证通过的提示词写入 wizardData.systemPrompt 并前进到下一步
 *
 * 键盘绑定策略：
 *   - ESC（confirm:no）绑定在 "Settings" 上下文，避免与输入框中的 'n' 键冲突
 *   - 外部编辑器快捷键（chat:externalEditor）绑定在 "Chat" 上下文
 *
 * 依赖：
 *   - react/compiler-runtime (_c)：React 编译器自动生成的记忆化缓存（20 个槽位）
 *   - useKeybinding：注册上下文感知的键盘快捷键
 *   - editPromptInEditor：调用系统编辑器编辑文本并返回结果
 *   - TextInput：支持光标偏移管理的终端文本输入组件（Ink）
 */
import { c as _c } from "react/compiler-runtime";
import React, { type ReactNode, useCallback, useState } from 'react';
import { Box, Text } from '../../../../ink.js';
import { useKeybinding } from '../../../../keybindings/useKeybinding.js';
import { editPromptInEditor } from '../../../../utils/promptEditor.js';
import { ConfigurableShortcutHint } from '../../../ConfigurableShortcutHint.js';
import { Byline } from '../../../design-system/Byline.js';
import { KeyboardShortcutHint } from '../../../design-system/KeyboardShortcutHint.js';
import TextInput from '../../../TextInput.js';
import { useWizard } from '../../../wizard/index.js';
import { WizardDialogLayout } from '../../../wizard/WizardDialogLayout.js';
import type { AgentWizardData } from '../types.js';

/**
 * PromptStep — 向导系统提示词输入步骤。
 *
 * 整体流程：
 *   1. 从 useWizard 获取 goNext / goBack / updateWizardData / wizardData
 *   2. 初始化本地状态：systemPrompt（预填 wizardData 中已有值）、cursorOffset、error
 *   3. 注册 ESC 键绑定（Settings 上下文），避免 'n' 字符触发取消
 *   4. 构建 handleExternalEditor：调用外部编辑器，若有内容则更新 systemPrompt 和 cursorOffset
 *   5. 注册外部编辑器快捷键（Chat 上下文）
 *   6. 构建 handleSubmit：trim 后验证非空，再写入 wizardData 并调用 goNext()
 *   7. 构建静态 JSX 片段（React 编译器保证同等输入下复用）
 *   8. 组装最终布局并返回
 */
export function PromptStep() {
  // React 编译器生成的记忆化缓存，共 20 个槽位
  const $ = _c(20);

  // 从向导上下文获取导航和数据更新方法
  const {
    goNext,
    goBack,
    updateWizardData,
    wizardData
  } = useWizard();

  // 本地状态：当前系统提示词文本（优先使用已有向导数据）
  const [systemPrompt, setSystemPrompt] = useState(wizardData.systemPrompt || "");
  // 本地状态：光标在文本中的偏移量（用于 TextInput 光标定位）
  const [cursorOffset, setCursorOffset] = useState(systemPrompt.length);
  // 本地状态：验证错误消息（null 表示无错误）
  const [error, setError] = useState(null);

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
  // 注册 ESC 键绑定：按 ESC 返回上一步（Settings 上下文）
  useKeybinding("confirm:no", goBack, t0);

  // ── 槽位 $[1-2]：handleExternalEditor 回调（依赖 systemPrompt）────────────
  let t1;
  if ($[1] !== systemPrompt) {
    // systemPrompt 变化时，重新创建回调（闭包需要最新值）
    t1 = async () => {
      // 调用外部编辑器（$EDITOR 环境变量指定的编辑器）
      const result = await editPromptInEditor(systemPrompt);
      if (result.content !== null) {
        // 编辑器有返回内容时，同步更新状态和光标位置
        setSystemPrompt(result.content);
        setCursorOffset(result.content.length); // 光标移到文本末尾
      }
    };
    $[1] = systemPrompt;
    $[2] = t1;
  } else {
    t1 = $[2]; // 依赖未变，复用已缓存的回调
  }
  const handleExternalEditor = t1;

  // ── 槽位 $[3]：静态 Chat 上下文对象（仅创建一次）────────────────────────
  let t2;
  if ($[3] === Symbol.for("react.memo_cache_sentinel")) {
    t2 = {
      context: "Chat" // 在 Chat 上下文注册外部编辑器快捷键
    };
    $[3] = t2;
  } else {
    t2 = $[3];
  }
  // 注册外部编辑器快捷键（Chat 上下文，默认 ctrl+g）
  useKeybinding("chat:externalEditor", handleExternalEditor, t2);

  // ── 槽位 $[4-7]：handleSubmit 回调（依赖 goNext / systemPrompt / updateWizardData）
  let t3;
  if ($[4] !== goNext || $[5] !== systemPrompt || $[6] !== updateWizardData) {
    // 任意依赖变化时，重新创建提交回调
    t3 = () => {
      // 去除首尾空白后进行非空验证
      const trimmedPrompt = systemPrompt.trim();
      if (!trimmedPrompt) {
        // 提示词为空时设置错误消息并阻止前进
        setError("System prompt is required");
        return;
      }
      // 验证通过：清除错误、写入 wizard 数据、进入下一步
      setError(null);
      updateWizardData({
        systemPrompt: trimmedPrompt // 保存去空白后的提示词
      });
      goNext();
    };
    $[4] = goNext;
    $[5] = systemPrompt;
    $[6] = updateWizardData;
    $[7] = t3;
  } else {
    t3 = $[7]; // 依赖未变，复用已缓存的回调
  }
  const handleSubmit = t3;

  // ── 槽位 $[8]：静态底部快捷键提示 JSX（仅首次渲染时创建）────────────────
  let t4;
  if ($[8] === Symbol.for("react.memo_cache_sentinel")) {
    // 显示四个操作提示：输入文字、Enter 继续、ctrl+g 打开编辑器、Esc 返回
    t4 = <Byline><KeyboardShortcutHint shortcut="Type" action="enter text" /><KeyboardShortcutHint shortcut="Enter" action="continue" /><ConfigurableShortcutHint action="chat:externalEditor" context="Chat" fallback="ctrl+g" description="open in editor" /><ConfigurableShortcutHint action="confirm:no" context="Settings" fallback="Esc" description="go back" /></Byline>;
    $[8] = t4;
  } else {
    t4 = $[8];
  }

  // ── 槽位 $[9-10]：静态说明文字 JSX（仅首次渲染时创建）──────────────────
  let t5;
  let t6;
  if ($[9] === Symbol.for("react.memo_cache_sentinel")) {
    t5 = <Text>Enter the system prompt for your agent:</Text>; // 主提示文字
    t6 = <Text dimColor={true}>Be comprehensive for best results</Text>; // 辅助提示（暗色）
    $[9] = t5;
    $[10] = t6;
  } else {
    t5 = $[9];
    t6 = $[10];
  }

  // ── 槽位 $[11-14]：文本输入框 JSX（依赖 cursorOffset / handleSubmit / systemPrompt）
  let t7;
  if ($[11] !== cursorOffset || $[12] !== handleSubmit || $[13] !== systemPrompt) {
    // 任意输入相关状态变化时，重建 TextInput JSX
    t7 = <Box marginTop={1}><TextInput value={systemPrompt} onChange={setSystemPrompt} onSubmit={handleSubmit} placeholder="You are a helpful code reviewer who..." columns={80} cursorOffset={cursorOffset} onChangeCursorOffset={setCursorOffset} focus={true} showCursor={true} /></Box>;
    $[11] = cursorOffset;
    $[12] = handleSubmit;
    $[13] = systemPrompt;
    $[14] = t7;
  } else {
    t7 = $[14];
  }

  // ── 槽位 $[15-16]：错误提示 JSX（依赖 error）──────────────────────────
  let t8;
  if ($[15] !== error) {
    // error 变化时重建（error 为 null 时不渲染任何内容）
    t8 = error && <Box marginTop={1}><Text color="error">{error}</Text></Box>;
    $[15] = error;
    $[16] = t8;
  } else {
    t8 = $[16];
  }

  // ── 槽位 $[17-19]：最终完整布局（依赖 t7 文本框 / t8 错误提示）──────────
  let t9;
  if ($[17] !== t7 || $[18] !== t8) {
    // 输入框或错误提示变化时，重建整个对话框
    t9 = <WizardDialogLayout subtitle="System prompt" footerText={t4}><Box flexDirection="column">{t5}{t6}{t7}{t8}</Box></WizardDialogLayout>;
    $[17] = t7;
    $[18] = t8;
    $[19] = t9;
  } else {
    t9 = $[19]; // 两者均未变化，复用缓存的完整 JSX
  }
  return t9;
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJSZWFjdCIsIlJlYWN0Tm9kZSIsInVzZUNhbGxiYWNrIiwidXNlU3RhdGUiLCJCb3giLCJUZXh0IiwidXNlS2V5YmluZGluZyIsImVkaXRQcm9tcHRJbkVkaXRvciIsIkNvbmZpZ3VyYWJsZVNob3J0Y3V0SGludCIsIkJ5bGluZSIsIktleWJvYXJkU2hvcnRjdXRIaW50IiwiVGV4dElucHV0IiwidXNlV2l6YXJkIiwiV2l6YXJkRGlhbG9nTGF5b3V0IiwiQWdlbnRXaXphcmREYXRhIiwiUHJvbXB0U3RlcCIsIiQiLCJfYyIsImdvTmV4dCIsImdvQmFjayIsInVwZGF0ZVdpemFyZERhdGEiLCJ3aXphcmREYXRhIiwic3lzdGVtUHJvbXB0Iiwic2V0U3lzdGVtUHJvbXB0IiwiY3Vyc29yT2Zmc2V0Iiwic2V0Q3Vyc29yT2Zmc2V0IiwibGVuZ3RoIiwiZXJyb3IiLCJzZXRFcnJvciIsInQwIiwiU3ltYm9sIiwiZm9yIiwiY29udGV4dCIsInQxIiwicmVzdWx0IiwiY29udGVudCIsImhhbmRsZUV4dGVybmFsRWRpdG9yIiwidDIiLCJ0MyIsInRyaW1tZWRQcm9tcHQiLCJ0cmltIiwiaGFuZGxlU3VibWl0IiwidDQiLCJ0NSIsInQ2IiwidDciLCJ0OCIsInQ5Il0sInNvdXJjZXMiOlsiUHJvbXB0U3RlcC50c3giXSwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IFJlYWN0LCB7IHR5cGUgUmVhY3ROb2RlLCB1c2VDYWxsYmFjaywgdXNlU3RhdGUgfSBmcm9tICdyZWFjdCdcbmltcG9ydCB7IEJveCwgVGV4dCB9IGZyb20gJy4uLy4uLy4uLy4uL2luay5qcydcbmltcG9ydCB7IHVzZUtleWJpbmRpbmcgfSBmcm9tICcuLi8uLi8uLi8uLi9rZXliaW5kaW5ncy91c2VLZXliaW5kaW5nLmpzJ1xuaW1wb3J0IHsgZWRpdFByb21wdEluRWRpdG9yIH0gZnJvbSAnLi4vLi4vLi4vLi4vdXRpbHMvcHJvbXB0RWRpdG9yLmpzJ1xuaW1wb3J0IHsgQ29uZmlndXJhYmxlU2hvcnRjdXRIaW50IH0gZnJvbSAnLi4vLi4vLi4vQ29uZmlndXJhYmxlU2hvcnRjdXRIaW50LmpzJ1xuaW1wb3J0IHsgQnlsaW5lIH0gZnJvbSAnLi4vLi4vLi4vZGVzaWduLXN5c3RlbS9CeWxpbmUuanMnXG5pbXBvcnQgeyBLZXlib2FyZFNob3J0Y3V0SGludCB9IGZyb20gJy4uLy4uLy4uL2Rlc2lnbi1zeXN0ZW0vS2V5Ym9hcmRTaG9ydGN1dEhpbnQuanMnXG5pbXBvcnQgVGV4dElucHV0IGZyb20gJy4uLy4uLy4uL1RleHRJbnB1dC5qcydcbmltcG9ydCB7IHVzZVdpemFyZCB9IGZyb20gJy4uLy4uLy4uL3dpemFyZC9pbmRleC5qcydcbmltcG9ydCB7IFdpemFyZERpYWxvZ0xheW91dCB9IGZyb20gJy4uLy4uLy4uL3dpemFyZC9XaXphcmREaWFsb2dMYXlvdXQuanMnXG5pbXBvcnQgdHlwZSB7IEFnZW50V2l6YXJkRGF0YSB9IGZyb20gJy4uL3R5cGVzLmpzJ1xuXG5leHBvcnQgZnVuY3Rpb24gUHJvbXB0U3RlcCgpOiBSZWFjdE5vZGUge1xuICBjb25zdCB7IGdvTmV4dCwgZ29CYWNrLCB1cGRhdGVXaXphcmREYXRhLCB3aXphcmREYXRhIH0gPVxuICAgIHVzZVdpemFyZDxBZ2VudFdpemFyZERhdGE+KClcbiAgY29uc3QgW3N5c3RlbVByb21wdCwgc2V0U3lzdGVtUHJvbXB0XSA9IHVzZVN0YXRlKFxuICAgIHdpemFyZERhdGEuc3lzdGVtUHJvbXB0IHx8ICcnLFxuICApXG4gIGNvbnN0IFtjdXJzb3JPZmZzZXQsIHNldEN1cnNvck9mZnNldF0gPSB1c2VTdGF0ZShzeXN0ZW1Qcm9tcHQubGVuZ3RoKVxuICBjb25zdCBbZXJyb3IsIHNldEVycm9yXSA9IHVzZVN0YXRlPHN0cmluZyB8IG51bGw+KG51bGwpXG5cbiAgLy8gSGFuZGxlIGVzY2FwZSBrZXkgLSB1c2UgU2V0dGluZ3MgY29udGV4dCBzbyAnbicga2V5IGRvZXNuJ3QgY2FuY2VsIChhbGxvd3MgdHlwaW5nICduJyBpbiBpbnB1dClcbiAgdXNlS2V5YmluZGluZygnY29uZmlybTpubycsIGdvQmFjaywgeyBjb250ZXh0OiAnU2V0dGluZ3MnIH0pXG5cbiAgY29uc3QgaGFuZGxlRXh0ZXJuYWxFZGl0b3IgPSB1c2VDYWxsYmFjayhhc3luYyAoKSA9PiB7XG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgZWRpdFByb21wdEluRWRpdG9yKHN5c3RlbVByb21wdClcbiAgICBpZiAocmVzdWx0LmNvbnRlbnQgIT09IG51bGwpIHtcbiAgICAgIHNldFN5c3RlbVByb21wdChyZXN1bHQuY29udGVudClcbiAgICAgIHNldEN1cnNvck9mZnNldChyZXN1bHQuY29udGVudC5sZW5ndGgpXG4gICAgfVxuICB9LCBbc3lzdGVtUHJvbXB0XSlcblxuICB1c2VLZXliaW5kaW5nKCdjaGF0OmV4dGVybmFsRWRpdG9yJywgaGFuZGxlRXh0ZXJuYWxFZGl0b3IsIHtcbiAgICBjb250ZXh0OiAnQ2hhdCcsXG4gIH0pXG5cbiAgY29uc3QgaGFuZGxlU3VibWl0ID0gKCk6IHZvaWQgPT4ge1xuICAgIGNvbnN0IHRyaW1tZWRQcm9tcHQgPSBzeXN0ZW1Qcm9tcHQudHJpbSgpXG4gICAgaWYgKCF0cmltbWVkUHJvbXB0KSB7XG4gICAgICBzZXRFcnJvcignU3lzdGVtIHByb21wdCBpcyByZXF1aXJlZCcpXG4gICAgICByZXR1cm5cbiAgICB9XG5cbiAgICBzZXRFcnJvcihudWxsKVxuICAgIHVwZGF0ZVdpemFyZERhdGEoeyBzeXN0ZW1Qcm9tcHQ6IHRyaW1tZWRQcm9tcHQgfSlcbiAgICBnb05leHQoKVxuICB9XG5cbiAgcmV0dXJuIChcbiAgICA8V2l6YXJkRGlhbG9nTGF5b3V0XG4gICAgICBzdWJ0aXRsZT1cIlN5c3RlbSBwcm9tcHRcIlxuICAgICAgZm9vdGVyVGV4dD17XG4gICAgICAgIDxCeWxpbmU+XG4gICAgICAgICAgPEtleWJvYXJkU2hvcnRjdXRIaW50IHNob3J0Y3V0PVwiVHlwZVwiIGFjdGlvbj1cImVudGVyIHRleHRcIiAvPlxuICAgICAgICAgIDxLZXlib2FyZFNob3J0Y3V0SGludCBzaG9ydGN1dD1cIkVudGVyXCIgYWN0aW9uPVwiY29udGludWVcIiAvPlxuICAgICAgICAgIDxDb25maWd1cmFibGVTaG9ydGN1dEhpbnRcbiAgICAgICAgICAgIGFjdGlvbj1cImNoYXQ6ZXh0ZXJuYWxFZGl0b3JcIlxuICAgICAgICAgICAgY29udGV4dD1cIkNoYXRcIlxuICAgICAgICAgICAgZmFsbGJhY2s9XCJjdHJsK2dcIlxuICAgICAgICAgICAgZGVzY3JpcHRpb249XCJvcGVuIGluIGVkaXRvclwiXG4gICAgICAgICAgLz5cbiAgICAgICAgICA8Q29uZmlndXJhYmxlU2hvcnRjdXRIaW50XG4gICAgICAgICAgICBhY3Rpb249XCJjb25maXJtOm5vXCJcbiAgICAgICAgICAgIGNvbnRleHQ9XCJTZXR0aW5nc1wiXG4gICAgICAgICAgICBmYWxsYmFjaz1cIkVzY1wiXG4gICAgICAgICAgICBkZXNjcmlwdGlvbj1cImdvIGJhY2tcIlxuICAgICAgICAgIC8+XG4gICAgICAgIDwvQnlsaW5lPlxuICAgICAgfVxuICAgID5cbiAgICAgIDxCb3ggZmxleERpcmVjdGlvbj1cImNvbHVtblwiPlxuICAgICAgICA8VGV4dD5FbnRlciB0aGUgc3lzdGVtIHByb21wdCBmb3IgeW91ciBhZ2VudDo8L1RleHQ+XG4gICAgICAgIDxUZXh0IGRpbUNvbG9yPkJlIGNvbXByZWhlbnNpdmUgZm9yIGJlc3QgcmVzdWx0czwvVGV4dD5cblxuICAgICAgICA8Qm94IG1hcmdpblRvcD17MX0+XG4gICAgICAgICAgPFRleHRJbnB1dFxuICAgICAgICAgICAgdmFsdWU9e3N5c3RlbVByb21wdH1cbiAgICAgICAgICAgIG9uQ2hhbmdlPXtzZXRTeXN0ZW1Qcm9tcHR9XG4gICAgICAgICAgICBvblN1Ym1pdD17aGFuZGxlU3VibWl0fVxuICAgICAgICAgICAgcGxhY2Vob2xkZXI9XCJZb3UgYXJlIGEgaGVscGZ1bCBjb2RlIHJldmlld2VyIHdoby4uLlwiXG4gICAgICAgICAgICBjb2x1bW5zPXs4MH1cbiAgICAgICAgICAgIGN1cnNvck9mZnNldD17Y3Vyc29yT2Zmc2V0fVxuICAgICAgICAgICAgb25DaGFuZ2VDdXJzb3JPZmZzZXQ9e3NldEN1cnNvck9mZnNldH1cbiAgICAgICAgICAgIGZvY3VzXG4gICAgICAgICAgICBzaG93Q3Vyc29yXG4gICAgICAgICAgLz5cbiAgICAgICAgPC9Cb3g+XG5cbiAgICAgICAge2Vycm9yICYmIChcbiAgICAgICAgICA8Qm94IG1hcmdpblRvcD17MX0+XG4gICAgICAgICAgICA8VGV4dCBjb2xvcj1cImVycm9yXCI+e2Vycm9yfTwvVGV4dD5cbiAgICAgICAgICA8L0JveD5cbiAgICAgICAgKX1cbiAgICAgIDwvQm94PlxuICAgIDwvV2l6YXJkRGlhbG9nTGF5b3V0PlxuICApXG59XG4iXSwibWFwcGluZ3MiOiI7QUFBQSxPQUFPQSxLQUFLLElBQUksS0FBS0MsU0FBUyxFQUFFQyxXQUFXLEVBQUVDLFFBQVEsUUFBUSxPQUFPO0FBQ3BFLFNBQVNDLEdBQUcsRUFBRUMsSUFBSSxRQUFRLG9CQUFvQjtBQUM5QyxTQUFTQyxhQUFhLFFBQVEsMENBQTBDO0FBQ3hFLFNBQVNDLGtCQUFrQixRQUFRLG1DQUFtQztBQUN0RSxTQUFTQyx3QkFBd0IsUUFBUSxzQ0FBc0M7QUFDL0UsU0FBU0MsTUFBTSxRQUFRLGtDQUFrQztBQUN6RCxTQUFTQyxvQkFBb0IsUUFBUSxnREFBZ0Q7QUFDckYsT0FBT0MsU0FBUyxNQUFNLHVCQUF1QjtBQUM3QyxTQUFTQyxTQUFTLFFBQVEsMEJBQTBCO0FBQ3BELFNBQVNDLGtCQUFrQixRQUFRLHVDQUF1QztBQUMxRSxjQUFjQyxlQUFlLFFBQVEsYUFBYTtBQUVsRCxPQUFPLFNBQUFDLFdBQUE7RUFBQSxNQUFBQyxDQUFBLEdBQUFDLEVBQUE7RUFDTDtJQUFBQyxNQUFBO0lBQUFDLE1BQUE7SUFBQUMsZ0JBQUE7SUFBQUM7RUFBQSxJQUNFVCxTQUFTLENBQWtCLENBQUM7RUFDOUIsT0FBQVUsWUFBQSxFQUFBQyxlQUFBLElBQXdD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
