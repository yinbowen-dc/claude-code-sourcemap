/**
 * ModelSelector.tsx — Agent 模型选择器组件
 *
 * 【在 Claude Code 系统流程中的位置】
 * 本文件位于 src/components/agents/ 目录下，是 Agent 编辑流程中的模型选择子界面。
 * 由 AgentEditor（editMode='edit-model' 时）和 ModelStep（新建 Agent 向导中）调用。
 * 提供基于 Select 组件的模型列表，供用户选择 Agent 使用的 Claude 模型版本。
 *
 * 【主要功能】
 * 1. 从 getAgentModelOptions 获取预定义模型别名选项列表
 * 2. 若 Agent 当前使用完整模型 ID（非别名，如 'claude-opus-4-5'），
 *    则将其注入到列表头部，确保其能在列表中显示并被选中
 * 3. 通过 Select 组件提供键盘导航的模型选择交互
 * 4. onCancel 有值时执行 onCancel，否则以 undefined 调用 onComplete（表示"不修改"）
 * 5. 使用 React Compiler 的 _c(11) 缓存机制优化渲染性能
 */
import { c as _c } from "react/compiler-runtime";
import * as React from 'react';
import { Box, Text } from '../../ink.js';
import { getAgentModelOptions } from '../../utils/model/agent.js';
import { Select } from '../CustomSelect/select.js';

// Props 接口：初始模型（可选）、选择完成回调、取消回调（可选）
interface ModelSelectorProps {
  initialModel?: string;
  onComplete: (model?: string) => void;
  onCancel?: () => void;
}

/**
 * ModelSelector 组件 — Agent 模型选择交互界面
 *
 * React Compiler 分配 11 个缓存槽，优化以下依赖项的缓存：
 * - initialModel → 模型选项列表构建（槽 0-1）
 * - 静态说明文本节点（槽 2）
 * - onCancel + onComplete → 取消回调函数（槽 3-5）
 * - defaultModel + modelOptions + onComplete + t3 → 根节点（槽 6-10）
 */
export function ModelSelector(t0) {
  // React Compiler 分配 11 个缓存槽
  const $ = _c(11);
  const {
    initialModel,
    onComplete,
    onCancel
  } = t0;

  // 缓存模型选项列表：仅在 initialModel 变化时重新计算
  let t1;
  if ($[0] !== initialModel) {
    bb0: {
      // 获取预定义模型别名列表（如 'sonnet', 'opus' 等）
      const base = getAgentModelOptions();
      // 若 Agent 当前模型是完整 ID（不在别名列表中），将其注入列表头部
      // 这样用户确认时不会因别名不匹配而覆盖自定义的完整模型 ID
      if (initialModel && !base.some(o => o.value === initialModel)) {
        t1 = [{
          value: initialModel,
          label: initialModel,
          description: "Current model (custom ID)"  // 标注为"当前自定义模型"
        }, ...base];
        break bb0;
      }
      // 默认直接使用预定义列表
      t1 = base;
    }
    $[0] = initialModel;
    $[1] = t1;
  } else {
    t1 = $[1];
  }
  const modelOptions = t1;

  // 默认选中值：优先使用 initialModel，否则默认选 'sonnet'
  const defaultModel = initialModel ?? "sonnet";

  // 静态说明文本：仅初始化一次，使用 react.memo_cache_sentinel 标记
  let t2;
  if ($[2] === Symbol.for("react.memo_cache_sentinel")) {
    t2 = <Box marginBottom={1}><Text dimColor={true}>Model determines the agent's reasoning capabilities and speed.</Text></Box>;
    $[2] = t2;
  } else {
    t2 = $[2];
  }

  // 缓存取消回调：onCancel 或 onComplete 变化时重新创建
  let t3;
  if ($[3] !== onCancel || $[4] !== onComplete) {
    // 有 onCancel 时执行 onCancel；否则以 undefined 调用 onComplete（表示不修改模型）
    t3 = () => onCancel ? onCancel() : onComplete(undefined);
    $[3] = onCancel;
    $[4] = onComplete;
    $[5] = t3;
  } else {
    t3 = $[5];
  }

  // 缓存根节点：任意依赖项变化时重建
  let t4;
  if ($[6] !== defaultModel || $[7] !== modelOptions || $[8] !== onComplete || $[9] !== t3) {
    t4 = <Box flexDirection="column">
      {t2}
      {/* Select 组件：显示模型选项，以 defaultModel 预选，用户选择后触发 onComplete */}
      <Select options={modelOptions} defaultValue={defaultModel} onChange={onComplete} onCancel={t3} />
    </Box>;
    $[6] = defaultModel;
    $[7] = modelOptions;
    $[8] = onComplete;
    $[9] = t3;
    $[10] = t4;
  } else {
    t4 = $[10];
  }
  return t4;
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJSZWFjdCIsIkJveCIsIlRleHQiLCJnZXRBZ2VudE1vZGVsT3B0aW9ucyIsIlNlbGVjdCIsIk1vZGVsU2VsZWN0b3JQcm9wcyIsImluaXRpYWxNb2RlbCIsIm9uQ29tcGxldGUiLCJtb2RlbCIsIm9uQ2FuY2VsIiwiTW9kZWxTZWxlY3RvciIsInQwIiwiJCIsIl9jIiwidDEiLCJiYjAiLCJiYXNlIiwic29tZSIsIm8iLCJ2YWx1ZSIsImxhYmVsIiwiZGVzY3JpcHRpb24iLCJtb2RlbE9wdGlvbnMiLCJkZWZhdWx0TW9kZWwiLCJ0MiIsIlN5bWJvbCIsImZvciIsInQzIiwidW5kZWZpbmVkIiwidDQiXSwic291cmNlcyI6WyJNb2RlbFNlbGVjdG9yLnRzeCJdLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgKiBhcyBSZWFjdCBmcm9tICdyZWFjdCdcbmltcG9ydCB7IEJveCwgVGV4dCB9IGZyb20gJy4uLy4uL2luay5qcydcbmltcG9ydCB7IGdldEFnZW50TW9kZWxPcHRpb25zIH0gZnJvbSAnLi4vLi4vdXRpbHMvbW9kZWwvYWdlbnQuanMnXG5pbXBvcnQgeyBTZWxlY3QgfSBmcm9tICcuLi9DdXN0b21TZWxlY3Qvc2VsZWN0LmpzJ1xuXG5pbnRlcmZhY2UgTW9kZWxTZWxlY3RvclByb3BzIHtcbiAgaW5pdGlhbE1vZGVsPzogc3RyaW5nXG4gIG9uQ29tcGxldGU6IChtb2RlbD86IHN0cmluZykgPT4gdm9pZFxuICBvbkNhbmNlbD86ICgpID0+IHZvaWRcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIE1vZGVsU2VsZWN0b3Ioe1xuICBpbml0aWFsTW9kZWwsXG4gIG9uQ29tcGxldGUsXG4gIG9uQ2FuY2VsLFxufTogTW9kZWxTZWxlY3RvclByb3BzKTogUmVhY3QuUmVhY3ROb2RlIHtcbiAgY29uc3QgbW9kZWxPcHRpb25zID0gUmVhY3QudXNlTWVtbygoKSA9PiB7XG4gICAgY29uc3QgYmFzZSA9IGdldEFnZW50TW9kZWxPcHRpb25zKClcbiAgICAvLyBJZiB0aGUgYWdlbnQncyBjdXJyZW50IG1vZGVsIGlzIGEgZnVsbCBJRCAoZS5nLiAnY2xhdWRlLW9wdXMtNC01Jykgbm90XG4gICAgLy8gaW4gdGhlIGFsaWFzIGxpc3QsIGluamVjdCBpdCBhcyBhbiBvcHRpb24gc28gaXQgY2FuIHJvdW5kLXRyaXAgdGhyb3VnaFxuICAgIC8vIGNvbmZpcm0gd2l0aG91dCBiZWluZyBvdmVyd3JpdHRlbi5cbiAgICBpZiAoaW5pdGlhbE1vZGVsICYmICFiYXNlLnNvbWUobyA9PiBvLnZhbHVlID09PSBpbml0aWFsTW9kZWwpKSB7XG4gICAgICByZXR1cm4gW1xuICAgICAgICB7XG4gICAgICAgICAgdmFsdWU6IGluaXRpYWxNb2RlbCxcbiAgICAgICAgICBsYWJlbDogaW5pdGlhbE1vZGVsLFxuICAgICAgICAgIGRlc2NyaXB0aW9uOiAnQ3VycmVudCBtb2RlbCAoY3VzdG9tIElEKScsXG4gICAgICAgIH0sXG4gICAgICAgIC4uLmJhc2UsXG4gICAgICBdXG4gICAgfVxuICAgIHJldHVybiBiYXNlXG4gIH0sIFtpbml0aWFsTW9kZWxdKVxuXG4gIGNvbnN0IGRlZmF1bHRNb2RlbCA9IGluaXRpYWxNb2RlbCA/PyAnc29ubmV0J1xuXG4gIHJldHVybiAoXG4gICAgPEJveCBmbGV4RGlyZWN0aW9uPVwiY29sdW1uXCI+XG4gICAgICA8Qm94IG1hcmdpbkJvdHRvbT17MX0+XG4gICAgICAgIDxUZXh0IGRpbUNvbG9yPlxuICAgICAgICAgIE1vZGVsIGRldGVybWluZXMgdGhlIGFnZW50JmFwb3M7cyByZWFzb25pbmcgY2FwYWJpbGl0aWVzIGFuZCBzcGVlZC5cbiAgICAgICAgPC9UZXh0PlxuICAgICAgPC9Cb3g+XG4gICAgICA8U2VsZWN0XG4gICAgICAgIG9wdGlvbnM9e21vZGVsT3B0aW9uc31cbiAgICAgICAgZGVmYXVsdFZhbHVlPXtkZWZhdWx0TW9kZWx9XG4gICAgICAgIG9uQ2hhbmdlPXtvbkNvbXBsZXRlfVxuICAgICAgICBvbkNhbmNlbD17KCkgPT4gKG9uQ2FuY2VsID8gb25DYW5jZWwoKSA6IG9uQ29tcGxldGUodW5kZWZpbmVkKSl9XG4gICAgICAvPlxuICAgIDwvQm94PlxuICApXG59XG4iXSwibWFwcGluZ3MiOiI7QUFBQSxPQUFPLEtBQUtBLEtBQUssTUFBTSxPQUFPO0FBQzlCLFNBQVNDLEdBQUcsRUFBRUMsSUFBSSxRQUFRLGNBQWM7QUFDeEMsU0FBU0Msb0JBQW9CLFFBQVEsNEJBQTRCO0FBQ2pFLFNBQVNDLE1BQU0sUUFBUSwyQkFBMkI7QUFFbEQsVUFBVUMsa0JBQWtCLENBQUM7RUFDM0JDLFlBQVksQ0FBQyxFQUFFLE1BQU07RUFDckJDLFVBQVUsRUFBRSxDQUFDQyxLQUFjLENBQVIsRUFBRSxNQUFNLEVBQUUsR0FBRyxJQUFJO0VBQ3BDQyxRQUFRLENBQUMsRUFBRSxHQUFHLEdBQUcsSUFBSTtBQUN2QjtBQUVBLE9BQU8sU0FBQUMsY0FBQUMsRUFBQTtFQUFBLE1BQUFDLENBQUEsR0FBQUMsRUFBQTtFQUF1QjtJQUFBUCxZQUFBO0lBQUFDLFVBQUE7SUFBQUU7RUFBQSxJQUFBRSxFQUlUO0VBQUEsSUFBQUcsRUFBQTtFQUFBLElBQUFGLENBQUEsUUFBQU4sWUFBQTtJQUFBUyxHQUFBO01BRWpCLE1BQUFDLElBQUEsR0FBYWIsb0JBQW9CLENBQUMsQ0FBQztNQUluQyxJQUFJRyxZQUF5RCxJQUF6RCxDQUFpQlUsSUFBSSxDQUFBQyxJQUFLLENBQUNDLENBQUEsSUFBS0EsQ0FBQyxDQUFBQyxLQUFNLEtBQUtiLFlBQVksQ0FBQztRQUMzRFEsRUFBQSxHQUFPLENBQ0w7VUFBQUssS0FBQSxFQUNTYixZQUFZO1VBQUFjLEtBQUEsRUFDWmQsWUFBWTtVQUFBZSxXQUFBLEVBQ047UUFDZixDQUFDLEtBQ0VMLElBQUksQ0FDUjtRQVBELE1BQUFELEdBQUE7TUFPQztNQUVIRCxFQUFBLEdBQU9FLElBQUk7SUFBQTtJQUFBSixDQUFBLE1BQUFOLFlBQUE7SUFBQU0sQ0FBQSxNQUFBRSxFQUFBO0VBQUE7SUFBQUEsRUFBQSxHQUFBRixDQUFBO0VBQUE7RUFmYixNQUFBVSxZQUFBLEdBQXFCUixFQWdCSDtFQUVsQixNQUFBUyxZQUFBLEdBQXFCakIsWUFBd0IsSUFBeEIsUUFBd0I7RUFBQSxJQUFBa0IsRUFBQTtFQUFBLElBQUFaLENBQUEsUUFBQWEsTUFBQSxDQUFBQyxHQUFBO0lBSXpDRixFQUFBLElBQUMsR0FBRyxDQUFlLFlBQUMsQ0FBRCxHQUFDLENBQ2xCLENBQUMsSUFBSSxDQUFDLFFBQVEsQ0FBUixLQUFPLENBQUMsQ0FBQyw4REFFZixFQUZDLElBQUksQ0FHUCxFQUpDLEdBQUcsQ0FJRTtJQUFBWixDQUFBLE1BQUFLLEVBQUE7RUFBQTtJQUFBQSxFQUFBLEdBQUFaLENBQUE7RUFBQTtFQUFBLElBQUFlLEVBQUE7RUFBQSxJQUFBZixDQUFBLFFBQUFILFFBQUEsSUFBQUcsQ0FBQSxRQUFBTCxVQUFBO0lBS01vQixFQUFBLEdBQUFBLENBQUEsS0FBT2xCLFFBQVEsR0FBR0EsUUFBUSxDQUF5QixDQUFDLEdBQXJCRixVQUFVLENBQUNxQixTQUFTLENBQUU7SUFBQWhCLENBQUEsTUFBQUgsUUFBQTtJQUFBRyxDQUFBLE1BQUFMLFVBQUE7SUFBQUssQ0FBQSxNQUFBZSxFQUFBO0VBQUE7SUFBQUEsRUFBQSxHQUFBZixDQUFBO0VBQUE7RUFBQSxJQUFBaUIsRUFBQTtFQUFBLElBQUFqQixDQUFBLFFBQUFXLFlBQUEsSUFBQVgsQ0FBQSxRQUFBVSxZQUFBLElBQUFWLENBQUEsUUFBQUwsVUFBQSxJQUFBSyxDQUFBLFFBQUFlLEVBQUE7SUFWbkVFLEVBQUEsSUFBQyxHQUFHLENBQWUsYUFBUSxDQUFSLFFBQVEsQ0FDekIsQ0FBQUwsRUFJSyxDQUNMLENBQUMsTUFBTSxDQUNJRixPQUFZLENBQVpBLGFBQVcsQ0FBQyxDQUNQQyxZQUFZLENBQVpBLGFBQVcsQ0FBQyxDQUNoQmhCLFFBQVUsQ0FBVkEsV0FBUyxDQUFDLENBQ1YsUUFBcUQsQ0FBckQsQ0FBQW9CLEVBQW9ELENBQUMsR0FFbkUsRUFaQyxHQUFHLENBWUU7SUFBQWYsQ0FBQSxNQUFBVyxZQUFBO0lBQUFYLENBQUEsTUFBQVUsWUFBQTtJQUFBVixDQUFBLE1BQUFMLFVBQUE7SUFBQUssQ0FBQSxNQUFBZSxFQUFBO0lBQUFmLENBQUEsT0FBQWlCLEVBQUE7RUFBQTtJQUFBQSxFQUFBLEdBQUFqQixDQUFBO0VBQUE7RUFBQSxPQVpOaUIsRUFZTTtBQUFBIiwiaWdub3JlTGlzdCI6W119
