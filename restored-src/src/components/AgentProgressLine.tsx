/**
 * AgentProgressLine.tsx
 *
 * 在 Claude Code 终端 UI 系统中的位置：
 * 该组件负责在终端界面中渲染单个子代理（Sub-agent）的执行进度行。
 * 它是代理任务树视图的最小叶节点，被上层的代理列表或任务树组件调用，
 * 用于实时展示每个代理的运行状态、工具调用次数和 Token 消耗情况。
 *
 * 主要功能：
 * - 根据代理是否为树中最后一个节点，渲染不同的树形连接符（├─ 或 └─）
 * - 显示代理类型标识、描述信息及颜色高亮
 * - 显示工具调用次数与 Token 数量统计（后台运行模式下隐藏）
 * - 显示状态文本：初始化中 / 正在使用的工具 / 在后台运行 / 完成
 * - 支持"后台运行"模式（isAsync && isResolved），此模式下只显示任务描述，隐藏统计信息
 */
import { c as _c } from "react/compiler-runtime";
import * as React from 'react';
import { Box, Text } from '../ink.js';
import { formatNumber } from '../utils/format.js';
import type { Theme } from '../utils/theme.js';

// 组件属性类型定义
type Props = {
  agentType: string;         // 代理类型标识符（如 "search"、"code" 等）
  description?: string;      // 代理描述（可选，显示在类型标识后面的括号内）
  name?: string;             // 代理显示名称（hideType 模式下优先使用）
  descriptionColor?: keyof Theme; // 描述文字的背景高亮色
  taskDescription?: string;  // 后台运行时显示的任务描述文字
  toolUseCount: number;      // 代理已调用的工具次数
  tokens: number | null;     // 代理消耗的 Token 数量（null 表示未知）
  color?: keyof Theme;       // 代理类型标识的背景高亮色
  isLast: boolean;           // 是否为树结构中最后一个节点（决定树形连接符样式）
  isResolved: boolean;       // 代理是否已执行完毕
  isError: boolean;          // 代理是否执行出错
  isAsync?: boolean;         // 是否为异步（后台）代理
  shouldAnimate: boolean;    // 是否播放动画（暂未在此组件中直接使用）
  lastToolInfo?: string | null; // 最近一次工具调用的信息（用于状态文本）
  hideType?: boolean;        // 是否隐藏代理类型标签，改为显示 name/description
};

/**
 * AgentProgressLine 组件
 *
 * 渲染单条代理进度行，包含两行内容：
 * 1. 主行：树形连接符 + 代理标识/名称 + 统计信息（工具次数、Token 数）
 * 2. 状态行：缩进符 + 状态文本（仅在非后台模式下显示）
 *
 * 使用 React Compiler 的缓存机制（_c）对各 JSX 子树进行细粒度记忆化，
 * 避免在无关 props 变化时重新渲染各个子节点。
 */
export function AgentProgressLine(t0) {
  // React Compiler 分配 32 个缓存槽位用于记忆化各 JSX 子树
  const $ = _c(32);

  // 解构 props，其中 isAsync 和 hideType 提供默认值
  const {
    agentType,
    description,
    name,
    descriptionColor,
    taskDescription,
    toolUseCount,
    tokens,
    color,
    isLast,
    isResolved,
    isAsync: t1,
    lastToolInfo,
    hideType: t2
  } = t0;

  // isAsync 默认为 false（同步代理）
  const isAsync = t1 === undefined ? false : t1;
  // hideType 默认为 false（显示代理类型标签）
  const hideType = t2 === undefined ? false : t2;

  // 根据是否为树的最后节点，选择不同的树形连接符
  // isLast=true  → "└─"（树尾连接符）
  // isLast=false → "├─"（树中连接符）
  const treeChar = isLast ? "\u2514\u2500" : "\u251C\u2500";

  // 后台模式：异步代理且已完成时进入后台模式
  // 后台模式下隐藏工具/Token 统计，只显示任务描述
  const isBackgrounded = isAsync && isResolved;

  // 定义获取状态文本的函数，依据运行状态返回不同文字
  // 使用缓存：当 isBackgrounded/isResolved/lastToolInfo/taskDescription 未变化时复用
  let t3;
  if ($[0] !== isBackgrounded || $[1] !== isResolved || $[2] !== lastToolInfo || $[3] !== taskDescription) {
    t3 = () => {
      if (!isResolved) {
        // 代理未完成：显示最近工具信息，或默认"Initializing…"
        return lastToolInfo || "Initializing\u2026";
      }
      if (isBackgrounded) {
        // 代理已完成且为后台模式：显示任务描述，或默认提示文字
        return taskDescription ?? "Running in the background";
      }
      // 代理已完成且非后台模式：显示"Done"
      return "Done";
    };
    $[0] = isBackgrounded;
    $[1] = isResolved;
    $[2] = lastToolInfo;
    $[3] = taskDescription;
    $[4] = t3;
  } else {
    t3 = $[4];
  }
  const getStatusText = t3;

  // 渲染树形连接符文本节点（灰色显示），缓存以避免 treeChar 不变时重新渲染
  let t4;
  if ($[5] !== treeChar) {
    t4 = <Text dimColor={true}>{treeChar} </Text>;
    $[5] = treeChar;
    $[6] = t4;
  } else {
    t4 = $[6];
  }

  // 未完成时整行显示灰色（dimColor）
  const t5 = !isResolved;

  // 渲染代理标识区域（类型标签 + 描述），缓存以避免相关 props 不变时重新渲染
  let t6;
  if ($[7] !== agentType || $[8] !== color || $[9] !== description || $[10] !== descriptionColor || $[11] !== hideType || $[12] !== name) {
    t6 = hideType
      // hideType 模式：优先显示 name，其次 description，最后 agentType；若有 name 和 description 则在后面附加": description"
      ? <><Text bold={true}>{name ?? description ?? agentType}</Text>{name && description && <Text dimColor={true}>: {description}</Text>}</>
      // 标准模式：显示带背景色高亮的 agentType 标签，若有 description 则在括号中显示
      : <><Text bold={true} backgroundColor={color} color={color ? "inverseText" : undefined}>{agentType}</Text>{description && <>{" ("}<Text backgroundColor={descriptionColor} color={descriptionColor ? "inverseText" : undefined}>{description}</Text>{")"}</>}</>;
    $[7] = agentType;
    $[8] = color;
    $[9] = description;
    $[10] = descriptionColor;
    $[11] = hideType;
    $[12] = name;
    $[13] = t6;
  } else {
    t6 = $[13];
  }

  // 渲染工具调用次数和 Token 统计（后台模式下不显示）
  let t7;
  if ($[14] !== isBackgrounded || $[15] !== tokens || $[16] !== toolUseCount) {
    t7 = !isBackgrounded && <>{" \xB7 "}{toolUseCount} tool {toolUseCount === 1 ? "use" : "uses"}{tokens !== null && <> · {formatNumber(tokens)} tokens</>}</>;
    $[14] = isBackgrounded;
    $[15] = tokens;
    $[16] = toolUseCount;
    $[17] = t7;
  } else {
    t7 = $[17];
  }

  // 组合主行文本：代理标识 + 统计信息，未完成时整体灰色
  let t8;
  if ($[18] !== t5 || $[19] !== t6 || $[20] !== t7) {
    t8 = <Text dimColor={t5}>{t6}{t7}</Text>;
    $[18] = t5;
    $[19] = t6;
    $[20] = t7;
    $[21] = t8;
  } else {
    t8 = $[21];
  }

  // 组合主行容器：树形连接符 + 代理信息文本
  let t9;
  if ($[22] !== t4 || $[23] !== t8) {
    t9 = <Box paddingLeft={3}>{t4}{t8}</Box>;
    $[22] = t4;
    $[23] = t8;
    $[24] = t9;
  } else {
    t9 = $[24];
  }

  // 渲染状态行（仅在非后台模式下显示）
  // 状态行使用 ⏿ 符号（U+23BF）作为分支指示，后跟状态文本
  let t10;
  if ($[25] !== getStatusText || $[26] !== isBackgrounded || $[27] !== isLast) {
    t10 = !isBackgrounded && <Box paddingLeft={3} flexDirection="row"><Text dimColor={true}>{isLast ? "   \u23BF  " : "\u2502  \u23BF  "}</Text><Text dimColor={true}>{getStatusText()}</Text></Box>;
    $[25] = getStatusText;
    $[26] = isBackgrounded;
    $[27] = isLast;
    $[28] = t10;
  } else {
    t10 = $[28];
  }

  // 将主行和状态行垂直排列，组成完整的代理进度行
  let t11;
  if ($[29] !== t10 || $[30] !== t9) {
    t11 = <Box flexDirection="column">{t9}{t10}</Box>;
    $[29] = t10;
    $[30] = t9;
    $[31] = t11;
  } else {
    t11 = $[31];
  }
  return t11;
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJSZWFjdCIsIkJveCIsIlRleHQiLCJmb3JtYXROdW1iZXIiLCJUaGVtZSIsIlByb3BzIiwiYWdlbnRUeXBlIiwiZGVzY3JpcHRpb24iLCJuYW1lIiwiZGVzY3JpcHRpb25Db2xvciIsInRhc2tEZXNjcmlwdGlvbiIsInRvb2xVc2VDb3VudCIsInRva2VucyIsImNvbG9yIiwiaXNMYXN0IiwiaXNSZXNvbHZlZCIsImlzRXJyb3IiLCJpc0FzeW5jIiwic2hvdWxkQW5pbWF0ZSIsImxhc3RUb29sSW5mbyIsImhpZGVUeXBlIiwiQWdlbnRQcm9ncmVzc0xpbmUiLCJ0MCIsIiQiLCJfYyIsInQxIiwidDIiLCJ1bmRlZmluZWQiLCJ0cmVlQ2hhciIsImlzQmFja2dyb3VuZGVkIiwidDMiLCJnZXRTdGF0dXNUZXh0IiwidDQiLCJ0NSIsInQ2IiwidDciLCJ0OCIsInQ5IiwidDEwIiwidDExIl0sInNvdXJjZXMiOlsiQWdlbnRQcm9ncmVzc0xpbmUudHN4Il0sInNvdXJjZXNDb250ZW50IjpbImltcG9ydCAqIGFzIFJlYWN0IGZyb20gJ3JlYWN0J1xuaW1wb3J0IHsgQm94LCBUZXh0IH0gZnJvbSAnLi4vaW5rLmpzJ1xuaW1wb3J0IHsgZm9ybWF0TnVtYmVyIH0gZnJvbSAnLi4vdXRpbHMvZm9ybWF0LmpzJ1xuaW1wb3J0IHR5cGUgeyBUaGVtZSB9IGZyb20gJy4uL3V0aWxzL3RoZW1lLmpzJ1xuXG50eXBlIFByb3BzID0ge1xuICBhZ2VudFR5cGU6IHN0cmluZ1xuICBkZXNjcmlwdGlvbj86IHN0cmluZ1xuICBuYW1lPzogc3RyaW5nXG4gIGRlc2NyaXB0aW9uQ29sb3I/OiBrZXlvZiBUaGVtZVxuICB0YXNrRGVzY3JpcHRpb24/OiBzdHJpbmdcbiAgdG9vbFVzZUNvdW50OiBudW1iZXJcbiAgdG9rZW5zOiBudW1iZXIgfCBudWxsXG4gIGNvbG9yPzoga2V5b2YgVGhlbWVcbiAgaXNMYXN0OiBib29sZWFuXG4gIGlzUmVzb2x2ZWQ6IGJvb2xlYW5cbiAgaXNFcnJvcjogYm9vbGVhblxuICBpc0FzeW5jPzogYm9vbGVhblxuICBzaG91bGRBbmltYXRlOiBib29sZWFuXG4gIGxhc3RUb29sSW5mbz86IHN0cmluZyB8IG51bGxcbiAgaGlkZVR5cGU/OiBib29sZWFuXG59XG5cbmV4cG9ydCBmdW5jdGlvbiBBZ2VudFByb2dyZXNzTGluZSh7XG4gIGFnZW50VHlwZSxcbiAgZGVzY3JpcHRpb24sXG4gIG5hbWUsXG4gIGRlc2NyaXB0aW9uQ29sb3IsXG4gIHRhc2tEZXNjcmlwdGlvbixcbiAgdG9vbFVzZUNvdW50LFxuICB0b2tlbnMsXG4gIGNvbG9yLFxuICBpc0xhc3QsXG4gIGlzUmVzb2x2ZWQsXG4gIGlzRXJyb3I6IF9pc0Vycm9yLFxuICBpc0FzeW5jID0gZmFsc2UsXG4gIHNob3VsZEFuaW1hdGU6IF9zaG91bGRBbmltYXRlLFxuICBsYXN0VG9vbEluZm8sXG4gIGhpZGVUeXBlID0gZmFsc2UsXG59OiBQcm9wcyk6IFJlYWN0LlJlYWN0Tm9kZSB7XG4gIGNvbnN0IHRyZWVDaGFyID0gaXNMYXN0ID8gJ+KUlOKUgCcgOiAn4pSc4pSAJ1xuICBjb25zdCBpc0JhY2tncm91bmRlZCA9IGlzQXN5bmMgJiYgaXNSZXNvbHZlZFxuXG4gIC8vIERldGVybWluZSB0aGUgc3RhdHVzIHRleHRcbiAgY29uc3QgZ2V0U3RhdHVzVGV4dCA9ICgpOiBzdHJpbmcgPT4ge1xuICAgIGlmICghaXNSZXNvbHZlZCkge1xuICAgICAgcmV0dXJuIGxhc3RUb29sSW5mbyB8fCAnSW5pdGlhbGl6aW5n4oCmJ1xuICAgIH1cbiAgICBpZiAoaXNCYWNrZ3JvdW5kZWQpIHtcbiAgICAgIHJldHVybiB0YXNrRGVzY3JpcHRpb24gPz8gJ1J1bm5pbmcgaW4gdGhlIGJhY2tncm91bmQnXG4gICAgfVxuICAgIHJldHVybiAnRG9uZSdcbiAgfVxuXG4gIHJldHVybiAoXG4gICAgPEJveCBmbGV4RGlyZWN0aW9uPVwiY29sdW1uXCI+XG4gICAgICA8Qm94IHBhZGRpbmdMZWZ0PXszfT5cbiAgICAgICAgPFRleHQgZGltQ29sb3I+e3RyZWVDaGFyfSA8L1RleHQ+XG4gICAgICAgIDxUZXh0IGRpbUNvbG9yPXshaXNSZXNvbHZlZH0+XG4gICAgICAgICAge2hpZGVUeXBlID8gKFxuICAgICAgICAgICAgPD5cbiAgICAgICAgICAgICAgPFRleHQgYm9sZD57bmFtZSA/PyBkZXNjcmlwdGlvbiA/PyBhZ2VudFR5cGV9PC9UZXh0PlxuICAgICAgICAgICAgICB7bmFtZSAmJiBkZXNjcmlwdGlvbiAmJiA8VGV4dCBkaW1Db2xvcj46IHtkZXNjcmlwdGlvbn08L1RleHQ+fVxuICAgICAgICAgICAgPC8+XG4gICAgICAgICAgKSA6IChcbiAgICAgICAgICAgIDw+XG4gICAgICAgICAgICAgIDxUZXh0XG4gICAgICAgICAgICAgICAgYm9sZFxuICAgICAgICAgICAgICAgIGJhY2tncm91bmRDb2xvcj17Y29sb3J9XG4gICAgICAgICAgICAgICAgY29sb3I9e2NvbG9yID8gJ2ludmVyc2VUZXh0JyA6IHVuZGVmaW5lZH1cbiAgICAgICAgICAgICAgPlxuICAgICAgICAgICAgICAgIHthZ2VudFR5cGV9XG4gICAgICAgICAgICAgIDwvVGV4dD5cbiAgICAgICAgICAgICAge2Rlc2NyaXB0aW9uICYmIChcbiAgICAgICAgICAgICAgICA8PlxuICAgICAgICAgICAgICAgICAgeycgKCd9XG4gICAgICAgICAgICAgICAgICA8VGV4dFxuICAgICAgICAgICAgICAgICAgICBiYWNrZ3JvdW5kQ29sb3I9e2Rlc2NyaXB0aW9uQ29sb3J9XG4gICAgICAgICAgICAgICAgICAgIGNvbG9yPXtkZXNjcmlwdGlvbkNvbG9yID8gJ2ludmVyc2VUZXh0JyA6IHVuZGVmaW5lZH1cbiAgICAgICAgICAgICAgICAgID5cbiAgICAgICAgICAgICAgICAgICAge2Rlc2NyaXB0aW9ufVxuICAgICAgICAgICAgICAgICAgPC9UZXh0PlxuICAgICAgICAgICAgICAgICAgeycpJ31cbiAgICAgICAgICAgICAgICA8Lz5cbiAgICAgICAgICAgICAgKX1cbiAgICAgICAgICAgIDwvPlxuICAgICAgICAgICl9XG4gICAgICAgICAgeyFpc0JhY2tncm91bmRlZCAmJiAoXG4gICAgICAgICAgICA8PlxuICAgICAgICAgICAgICB7JyDCtyAnfVxuICAgICAgICAgICAgICB7dG9vbFVzZUNvdW50fSB0b29sIHt0b29sVXNlQ291bnQgPT09IDEgPyAndXNlJyA6ICd1c2VzJ31cbiAgICAgICAgICAgICAge3Rva2VucyAhPT0gbnVsbCAmJiA8PiDCtyB7Zm9ybWF0TnVtYmVyKHRva2Vucyl9IHRva2VuczwvPn1cbiAgICAgICAgICAgIDwvPlxuICAgICAgICAgICl9XG4gICAgICAgIDwvVGV4dD5cbiAgICAgIDwvQm94PlxuICAgICAgeyFpc0JhY2tncm91bmRlZCAmJiAoXG4gICAgICAgIDxCb3ggcGFkZGluZ0xlZnQ9ezN9IGZsZXhEaXJlY3Rpb249XCJyb3dcIj5cbiAgICAgICAgICA8VGV4dCBkaW1Db2xvcj57aXNMYXN0ID8gJyAgIOKOvyAgJyA6ICfilIIgIOKOvyAgJ308L1RleHQ+XG4gICAgICAgICAgPFRleHQgZGltQ29sb3I+e2dldFN0YXR1c1RleHQoKX08L1RleHQ+XG4gICAgICAgIDwvQm94PlxuICAgICAgKX1cbiAgICA8L0JveD5cbiAgKVxufVxuIl0sIm1hcHBpbmdzIjoiO0FBQUEsT0FBTyxLQUFLQSxLQUFLLE1BQU0sT0FBTztBQUM5QixTQUFTQyxHQUFHLEVBQUVDLElBQUksUUFBUSxXQUFXO0FBQ3JDLFNBQVNDLFlBQVksUUFBUSxvQkFBb0I7QUFDakQsY0FBY0MsS0FBSyxRQUFRLG1CQUFtQjtBQUU5QyxLQUFLQyxLQUFLLEdBQUc7RUFDWEMsU0FBUyxFQUFFLE1BQU07RUFDakJDLFdBQVcsQ0FBQyxFQUFFLE1BQU07RUFDcEJDLElBQUksQ0FBQyxFQUFFLE1BQU07RUFDYkMsZ0JBQWdCLENBQUMsRUFBRSxNQUFNTCxLQUFLO0VBQzlCTSxlQUFlLENBQUMsRUFBRSxNQUFNO0VBQ3hCQyxZQUFZLEVBQUUsTUFBTTtFQUNwQkMsTUFBTSxF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
