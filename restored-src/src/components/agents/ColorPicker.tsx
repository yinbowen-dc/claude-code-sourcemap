/**
 * ColorPicker.tsx — Agent 颜色选择器组件
 *
 * 【在 Claude Code 系统流程中的位置】
 * 本文件位于 src/components/agents/ 目录下，是 Agent 编辑流程中的颜色选择子界面。
 * 由 AgentEditor（editMode='edit-color' 时）和 ColorStep（新建 Agent 向导中）调用。
 * 渲染颜色列表供用户通过键盘 ↑↓/Enter 进行选择，并实时预览选中颜色效果。
 *
 * 【主要功能】
 * 1. 展示所有可用颜色选项（'automatic' + AGENT_COLORS 枚举列表）
 * 2. 通过 ↑↓ 键循环切换颜色（支持环绕翻页）
 * 3. 按 Enter 确认选中颜色，'automatic' 映射为 undefined（使用主题默认色）
 * 4. 实时预览：在列表下方显示当前选中颜色下 @{agentName} 的外观
 * 5. 使用 React Compiler 的 _c(17) 缓存机制优化渲染性能
 */
import { c as _c } from "react/compiler-runtime";
import figures from 'figures';
import React, { useState } from 'react';
import type { KeyboardEvent } from '../../ink/events/keyboard-event.js';
import { Box, Text } from '../../ink.js';
import { AGENT_COLOR_TO_THEME_COLOR, AGENT_COLORS, type AgentColorName } from '../../tools/AgentTool/agentColorManager.js';
import { capitalize } from '../../utils/stringUtils.js';

// 颜色选项类型：预定义颜色名 或 'automatic'（自动/默认颜色）
type ColorOption = AgentColorName | 'automatic';

// 颜色选项列表：'automatic' 始终排在第一位，其后跟所有预定义颜色
const COLOR_OPTIONS: ColorOption[] = ['automatic', ...AGENT_COLORS];

// Props 类型：Agent 名称（用于预览）、当前颜色（默认 'automatic'）、确认回调
type Props = {
  agentName: string;
  currentColor?: AgentColorName | 'automatic';
  onConfirm: (color: AgentColorName | undefined) => void;
};

/**
 * ColorPicker 组件 — 颜色选择交互界面
 *
 * React Compiler 分配 17 个缓存槽，优化以下依赖项的缓存：
 * - currentColor → 初始选中索引计算（槽 0-1）
 * - onConfirm + selectedIndex → 键盘事件处理器（槽 2-4）
 * - selectedIndex → 颜色列表渲染（槽 5-6）
 * - 静态"Preview:"文本节点（槽 9）
 * - agentName + selectedValue → 预览区域（槽 10-12）
 * - handleKeyDown + 列表 + 预览区 → 根节点（槽 13-16）
 */
export function ColorPicker(t0) {
  // React Compiler 分配 17 个缓存槽
  const $ = _c(17);
  const {
    agentName,
    currentColor: t1,
    onConfirm
  } = t0;
  // currentColor 未传入时默认为 'automatic'
  const currentColor = t1 === undefined ? "automatic" : t1;

  // 缓存初始选中索引的计算：在 COLOR_OPTIONS 中找到 currentColor 的位置
  let t2;
  if ($[0] !== currentColor) {
    t2 = COLOR_OPTIONS.findIndex(opt => opt === currentColor);
    $[0] = currentColor;
    $[1] = t2;
  } else {
    t2 = $[1];
  }
  // selectedIndex 表示当前高亮的颜色在 COLOR_OPTIONS 中的索引
  // Math.max(0, ...) 处理 findIndex 返回 -1 的情况（未找到时默认选第一个）
  const [selectedIndex, setSelectedIndex] = useState(Math.max(0, t2));

  // 缓存键盘事件处理器：当 onConfirm 或 selectedIndex 变化时重新创建
  let t3;
  if ($[2] !== onConfirm || $[3] !== selectedIndex) {
    t3 = e => {
      if (e.key === "up") {
        e.preventDefault();
        // 向上移动：到顶端时环绕到末尾（_temp 函数实现循环）
        setSelectedIndex(_temp);
      } else {
        if (e.key === "down") {
          e.preventDefault();
          // 向下移动：到末尾时环绕到顶端（_temp2 函数实现循环）
          setSelectedIndex(_temp2);
        } else {
          if (e.key === "return") {
            e.preventDefault();
            // Enter 确认：'automatic' 映射为 undefined（使用主题默认色）
            const selected = COLOR_OPTIONS[selectedIndex];
            onConfirm(selected === "automatic" ? undefined : selected);
          }
        }
      }
    };
    $[2] = onConfirm;
    $[3] = selectedIndex;
    $[4] = t3;
  } else {
    t3 = $[4];
  }
  const handleKeyDown = t3;

  // 当前选中的颜色值（用于预览区渲染）
  const selectedValue = COLOR_OPTIONS[selectedIndex];

  // 缓存颜色列表渲染：仅在 selectedIndex 变化时重建列表
  let t4;
  if ($[5] !== selectedIndex) {
    t4 = COLOR_OPTIONS.map((option, index) => {
      const isSelected = index === selectedIndex;
      return <Box key={option} flexDirection="row" gap={1}>
        {/* 选中项前显示指针符号（›），未选中项显示空格 */}
        <Text color={isSelected ? "suggestion" : undefined}>{isSelected ? figures.pointer : " "}</Text>
        {option === "automatic"
          // 'automatic' 选项：纯文本显示，选中时加粗
          ? <Text bold={isSelected}>Automatic color</Text>
          // 其他颜色选项：显示色块 + 颜色名称
          : <Box gap={1}>
              {/* 色块：使用颜色对应的主题色作为背景，显示一个空格方块 */}
              <Text backgroundColor={AGENT_COLOR_TO_THEME_COLOR[option]} color="inverseText">{" "}</Text>
              {/* 颜色名称：首字母大写，选中时加粗 */}
              <Text bold={isSelected}>{capitalize(option)}</Text>
            </Box>
        }
      </Box>;
    });
    $[5] = selectedIndex;
    $[6] = t4;
  } else {
    t4 = $[6];
  }

  // 缓存颜色列表容器节点
  let t5;
  if ($[7] !== t4) {
    t5 = <Box flexDirection="column">{t4}</Box>;
    $[7] = t4;
    $[8] = t5;
  } else {
    t5 = $[8];
  }

  // 静态"Preview:"文本节点，使用 Symbol.for("react.memo_cache_sentinel") 标记为只初始化一次
  let t6;
  if ($[9] === Symbol.for("react.memo_cache_sentinel")) {
    t6 = <Text>Preview: </Text>;
    $[9] = t6;
  } else {
    t6 = $[9];
  }

  // 缓存预览区域：agentName 或 selectedValue 变化时重建
  let t7;
  if ($[10] !== agentName || $[11] !== selectedValue) {
    t7 = <Box marginTop={1}>
      {t6}
      {selectedValue === undefined || selectedValue === "automatic"
        // 'automatic' 或无选中值：使用反色（终端默认反显）展示 @agentName
        ? <Text inverse={true} bold={true}>{" "}@{agentName}{" "}</Text>
        // 有颜色选中：使用对应主题色背景展示 @agentName
        : <Text backgroundColor={AGENT_COLOR_TO_THEME_COLOR[selectedValue]} color="inverseText" bold={true}>{" "}@{agentName}{" "}</Text>
      }
    </Box>;
    $[10] = agentName;
    $[11] = selectedValue;
    $[12] = t7;
  } else {
    t7 = $[12];
  }

  // 缓存根节点：handleKeyDown、颜色列表或预览区变化时重建
  let t8;
  if ($[13] !== handleKeyDown || $[14] !== t5 || $[15] !== t7) {
    t8 = <Box flexDirection="column" gap={1} tabIndex={0} autoFocus={true} onKeyDown={handleKeyDown}>{t5}{t7}</Box>;
    $[13] = handleKeyDown;
    $[14] = t5;
    $[15] = t7;
    $[16] = t8;
  } else {
    t8 = $[16];
  }
  return t8;
}

/**
 * _temp2 — 向下导航时的索引更新函数
 * 到末尾时环绕到 0（循环选择）
 */
function _temp2(prev_0) {
  return prev_0 < COLOR_OPTIONS.length - 1 ? prev_0 + 1 : 0;
}

/**
 * _temp — 向上导航时的索引更新函数
 * 到顶端时环绕到最后一项（循环选择）
 */
function _temp(prev) {
  return prev > 0 ? prev - 1 : COLOR_OPTIONS.length - 1;
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJmaWd1cmVzIiwiUmVhY3QiLCJ1c2VTdGF0ZSIsIktleWJvYXJkRXZlbnQiLCJCb3giLCJUZXh0IiwiQUdFTlRfQ09MT1JfVE9fVEhFTUVfQ09MT1IiLCJBR0VOVF9DT0xPUlMiLCJBZ2VudENvbG9yTmFtZSIsImNhcGl0YWxpemUiLCJDb2xvck9wdGlvbiIsIkNPTE9SX09QVElPTlMiLCJQcm9wcyIsImFnZW50TmFtZSIsImN1cnJlbnRDb2xvciIsIm9uQ29uZmlybSIsImNvbG9yIiwiQ29sb3JQaWNrZXIiLCJ0MCIsIiQiLCJfYyIsInQxIiwidW5kZWZpbmVkIiwidDIiLCJmaW5kSW5kZXgiLCJvcHQiLCJzZWxlY3RlZEluZGV4Iiwic2V0U2VsZWN0ZWRJbmRleCIsIk1hdGgiLCJtYXgiLCJ0MyIsImUiLCJrZXkiLCJwcmV2ZW50RGVmYXVsdCIsIl90ZW1wIiwiX3RlbXAyIiwic2VsZWN0ZWQiLCJoYW5kbGVLZXlEb3duIiwic2VsZWN0ZWRWYWx1ZSIsInQ0IiwibWFwIiwib3B0aW9uIiwiaW5kZXgiLCJpc1NlbGVjdGVkIiwicG9pbnRlciIsInQ1IiwidDYiLCJTeW1ib2wiLCJmb3IiLCJ0NyIsInQ4IiwicHJldl8wIiwicHJldiIsImxlbmd0aCJdLCJzb3VyY2VzIjpbIkNvbG9yUGlja2VyLnRzeCJdLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgZmlndXJlcyBmcm9tICdmaWd1cmVzJ1xuaW1wb3J0IFJlYWN0LCB7IHVzZVN0YXRlIH0gZnJvbSAncmVhY3QnXG5pbXBvcnQgdHlwZSB7IEtleWJvYXJkRXZlbnQgfSBmcm9tICcuLi8uLi9pbmsvZXZlbnRzL2tleWJvYXJkLWV2ZW50LmpzJ1xuaW1wb3J0IHsgQm94LCBUZXh0IH0gZnJvbSAnLi4vLi4vaW5rLmpzJ1xuaW1wb3J0IHtcbiAgQUdFTlRfQ09MT1JfVE9fVEhFTUVfQ09MT1IsXG4gIEFHRU5UX0NPTE9SUyxcbiAgdHlwZSBBZ2VudENvbG9yTmFtZSxcbn0gZnJvbSAnLi4vLi4vdG9vbHMvQWdlbnRUb29sL2FnZW50Q29sb3JNYW5hZ2VyLmpzJ1xuaW1wb3J0IHsgY2FwaXRhbGl6ZSB9IGZyb20gJy4uLy4uL3V0aWxzL3N0cmluZ1V0aWxzLmpzJ1xuXG50eXBlIENvbG9yT3B0aW9uID0gQWdlbnRDb2xvck5hbWUgfCAnYXV0b21hdGljJ1xuXG5jb25zdCBDT0xPUl9PUFRJT05TOiBDb2xvck9wdGlvbltdID0gWydhdXRvbWF0aWMnLCAuLi5BR0VOVF9DT0xPUlNdXG5cbnR5cGUgUHJvcHMgPSB7XG4gIGFnZW50TmFtZTogc3RyaW5nXG4gIGN1cnJlbnRDb2xvcj86IEFnZW50Q29sb3JOYW1lIHwgJ2F1dG9tYXRpYydcbiAgb25Db25maXJtOiAoY29sb3I6IEFnZW50Q29sb3JOYW1lIHwgdW5kZWZpbmVkKSA9PiB2b2lkXG59XG5cbmV4cG9ydCBmdW5jdGlvbiBDb2xvclBpY2tlcih7XG4gIGFnZW50TmFtZSxcbiAgY3VycmVudENvbG9yID0gJ2F1dG9tYXRpYycsXG4gIG9uQ29uZmlybSxcbn06IFByb3BzKTogUmVhY3QuUmVhY3ROb2RlIHtcbiAgY29uc3QgW3NlbGVjdGVkSW5kZXgsIHNldFNlbGVjdGVkSW5kZXhdID0gdXNlU3RhdGUoXG4gICAgTWF0aC5tYXgoXG4gICAgICAwLFxuICAgICAgQ09MT1JfT1BUSU9OUy5maW5kSW5kZXgob3B0ID0+IG9wdCA9PT0gY3VycmVudENvbG9yKSxcbiAgICApLFxuICApXG5cbiAgY29uc3QgaGFuZGxlS2V5RG93biA9IChlOiBLZXlib2FyZEV2ZW50KSA9PiB7XG4gICAgaWYgKGUua2V5ID09PSAndXAnKSB7XG4gICAgICBlLnByZXZlbnREZWZhdWx0KClcbiAgICAgIHNldFNlbGVjdGVkSW5kZXgocHJldiA9PiAocHJldiA+IDAgPyBwcmV2IC0gMSA6IENPTE9SX09QVElPTlMubGVuZ3RoIC0gMSkpXG4gICAgfSBlbHNlIGlmIChlLmtleSA9PT0gJ2Rvd24nKSB7XG4gICAgICBlLnByZXZlbnREZWZhdWx0KClcbiAgICAgIHNldFNlbGVjdGVkSW5kZXgocHJldiA9PiAocHJldiA8IENPTE9SX09QVElPTlMubGVuZ3RoIC0gMSA/IHByZXYgKyAxIDogMCkpXG4gICAgfSBlbHNlIGlmIChlLmtleSA9PT0gJ3JldHVybicpIHtcbiAgICAgIGUucHJldmVudERlZmF1bHQoKVxuICAgICAgY29uc3Qgc2VsZWN0ZWQgPSBDT0xPUl9PUFRJT05TW3NlbGVjdGVkSW5kZXhdXG4gICAgICBvbkNvbmZpcm0oc2VsZWN0ZWQgPT09ICdhdXRvbWF0aWMnID8gdW5kZWZpbmVkIDogc2VsZWN0ZWQpXG4gICAgfVxuICB9XG5cbiAgY29uc3Qgc2VsZWN0ZWRWYWx1ZSA9IENPTE9SX09QVElPTlNbc2VsZWN0ZWRJbmRleF1cblxuICByZXR1cm4gKFxuICAgIDxCb3hcbiAgICAgIGZsZXhEaXJlY3Rpb249XCJjb2x1bW5cIlxuICAgICAgZ2FwPXsxfVxuICAgICAgdGFiSW5kZXg9ezB9XG4gICAgICBhdXRvRm9jdXNcbiAgICAgIG9uS2V5RG93bj17aGFuZGxlS2V5RG93bn1cbiAgICA+XG4gICAgICA8Qm94IGZsZXhEaXJlY3Rpb249XCJjb2x1bW5cIj5cbiAgICAgICAge0NPTE9SX09QVElPTlMubWFwKChvcHRpb24sIGluZGV4KSA9PiB7XG4gICAgICAgICAgY29uc3QgaXNTZWxlY3RlZCA9IGluZGV4ID09PSBzZWxlY3RlZEluZGV4XG5cbiAgICAgICAgICByZXR1cm4gKFxuICAgICAgICAgICAgPEJveCBrZXk9e29wdGlvbn0gZmxleERpcmVjdGlvbj1cInJvd1wiIGdhcD17MX0+XG4gICAgICAgICAgICAgIDxUZXh0IGNvbG9yPXtpc1NlbGVjdGVkID8gJ3N1Z2dlc3Rpb24nIDogdW5kZWZpbmVkfT5cbiAgICAgICAgICAgICAgICB7aXNTZWxlY3RlZCA/IGZpZ3VyZXMucG9pbnRlciA6ICcgJ31cbiAgICAgICAgICAgICAgPC9UZXh0PlxuXG4gICAgICAgICAgICAgIHtvcHRpb24gPT09ICdhdXRvbWF0aWMnID8gKFxuICAgICAgICAgICAgICAgIDxUZXh0IGJvbGQ9e2lzU2VsZWN0ZWR9PkF1dG9tYXRpYyBjb2xvcjwvVGV4dD5cbiAgICAgICAgICAgICAgKSA6IChcbiAgICAgICAgICAgICAgICA8Qm94IGdhcD17MX0+XG4gICAgICAgICAgICAgICAgICA8VGV4dFxuICAgICAgICAgICAgICAgICAgICBiYWNrZ3JvdW5kQ29sb3I9e0FHRU5UX0NPTE9SX1RPX1RIRU1FX0NPTE9SW29wdGlvbl19XG4gICAgICAgICAgICAgICAgICAgIGNvbG9yPVwiaW52ZXJzZVRleHRcIlxuICAgICAgICAgICAgICAgICAgPlxuICAgICAgICAgICAgICAgICAgICB7JyAnfVxuICAgICAgICAgICAgICAgICAgPC9UZXh0PlxuICAgICAgICAgICAgICAgICAgPFRleHQgYm9sZD17aXNTZWxlY3RlZH0+e2NhcGl0YWxpemUob3B0aW9uKX08L1RleHQ+XG4gICAgICAgICAgICAgICAgPC9Cb3g+XG4gICAgICAgICAgICAgICl9XG4gICAgICAgICAgICA8L0JveD5cbiAgICAgICAgICApXG4gICAgICAgIH0pfVxuICAgICAgPC9Cb3g+XG5cbiAgICAgIDxCb3ggbWFyZ2luVG9wPXsxfT5cbiAgICAgICAgPFRleHQ+UHJldmlldzogPC9UZXh0PlxuICAgICAgICB7c2VsZWN0ZWRWYWx1ZSA9PT0gdW5kZWZpbmVkIHx8IHNlbGVjdGVkVmFsdWUgPT09ICdhdXRvbWF0aWMnID8gKFxuICAgICAgICAgIDxUZXh0IGludmVyc2UgYm9sZD5cbiAgICAgICAgICAgIHsnICd9XG4gICAgICAgICAgICBAe2FnZW50TmFtZX17JyAnfVxuICAgICAgICAgIDwvVGV4dD5cbiAgICAgICAgKSA6IChcbiAgICAgICAgICA8VGV4dFxuICAgICAgICAgICAgYmFja2dyb3VuZENvbG9yPXtBR0VOVF9DT0xPUl9UT19USEVNRV9DT0xPUltzZWxlY3RlZFZhbHVlXX1cbiAgICAgICAgICAgIGNvbG9yPVwiaW52ZXJzZVRleHRcIlxuICAgICAgICAgICAgYm9sZFxuICAgICAgICAgID5cbiAgICAgICAgICAgIHsnICd9XG4gICAgICAgICAgICBAe2FnZW50TmFtZX17JyAnfVxuICAgICAgICAgIDwvVGV4dD5cbiAgICAgICAgKX1cbiAgICAgIDwvQm94PlxuICAgIDwvQm94PlxuICApXG59XG4iXSwibWFwcGluZ3MiOiI7QUFBQSxPQUFPQSxPQUFPLE1BQU0sU0FBUztBQUM3QixPQUFPQyxLQUFLLElBQUlDLFFBQVEsUUFBUSxPQUFPO0FBQ3ZDLGNBQWNDLGFBQWEsUUFBUSxvQ0FBb0M7QUFDdkUsU0FBU0MsR0FBRyxFQUFFQyxJQUFJLFFBQVEsY0FBYztBQUN4QyxTQUNFQywwQkFBMEIsRUFDMUJDLFlBQVksRUFDWixLQUFLQyxjQUFjLFFBQ2QsNENBQTRDO0FBQ25ELFNBQVNDLFVBQVUsUUFBUSw0QkFBNEI7QUFFdkQsS0FBS0MsV0FBVyxHQUFHRixjQUFjLEdBQUcsV0FBVztBQUUvQyxNQUFNRyxhQUFhLEVBQUVELFdBQVcsRUFBRSxHQUFHLENBQUMsV0FBVyxFQUFFLEdBQUdILFlBQVksQ0FBQztBQUVuRSxLQUFLSyxLQUFLLEdBQUc7RUFDWEMsU0FBUyxFQUFFLE1BQU07RUFDakJDLFlBQVksQ0FBQyxFQUFFTixjQUFjLEdBQUcsV0FBVztFQUMzQ08sU0FBUyxFQUFFLENBQUNDLEtBQUssRUFBRVIsY0FBYyxHQUFHLFNBQVMsRUFBRSxHQUFHLElBQUk7QUFDeEQsQ0FBQztBQUVELE9BQU8sU0FBQVMsWUFBQUMsRUFBQTtFQUFBLE1BQUFDLENBQUEsR0FBQUMsRUFBQTtFQUFxQjtJQUFBUCxTQUFBO0lBQUFDLFlBQUEsRUFBQU8sRUFBQTtJQUFBTjtFQUFBLElBQUFHLEVBSXBCO0VBRk4sTUFBQUosWUFBQSxHQUFBTyxFQUEwQixLQUExQkMsU0FBMEIsR0FBMUIsV0FBMEIsR0FBMUJELEVBQTBCO0VBQUEsSUFBQUUsRUFBQTtFQUFBLElBQUFKLENBQUEsUUFBQUwsWUFBQTtJQU10QlMsRUFBQSxHQUFBWixhQUFhLENBQUFhLFNBQVUsQ0FBQ0MsR0FBQSxJQUFPQSxHQUFHLEtBQUtYLFlBQVksQ0FBQztJQUFBSyxDQUFBLE1BQUFMLFlBQUE7SUFBQUssQ0FBQSxNQUFBSSxFQUFBO0VBQUE7SUFBQUEsRUFBQSxHQUFBSixDQUFBO0VBQUE7RUFIeEQsT0FBQU8sYUFBQSxFQUFBQyxnQkFBQSxJQUEwQ3pCLFFBQVEsQ0FDaEQwQixJQUFJLENBQUFDLEdBQUksQ0FDTixDQUFDLEVBQ0ROLEVBQ0YsQ0FDRixDQUFDO0VBQUEsSUFBQU8sRUFBQTtFQUFBLElBQUFYLENBQUEsUUFBQUosU0FBQSxJQUFBSSxDQUFBLFFBQUFPLGFBQUE7SUFFcUJJLEVBQUEsR0FBQUMsQ0FBQTtNQUNwQixJQUFJQSxDQUFDLENBQUFDLEdBQUksS0FBSyxJQUFJO1FBQ2hCRCxDQUFDLENBQUFFLGNBQWUsQ0FBQyxDQUFDO1FBQ2xCTixnQkFBZ0IsQ0FBQ08sS0FBd0QsQ0FBQztNQUFBO1FBQ3JFLElBQUlILENBQUMsQ0FBQUMsR0FBSSxLQUFLLE1BQU07VUFDekJELENBQUMsQ0FBQUUsY0FBZSxDQUFDLENBQUM7VUFDbEJOLGdCQUFnQixDQUFDUSxNQUF3RCxDQUFDO1FBQUE7VUFDckUsSUFBSUosQ0FBQyxDQUFBQyxHQUFJLEtBQUssUUFBUTtZQUMzQkQsQ0FBQyxDQUFBRSxjQUFlLENBQUMsQ0FBQztZQUNsQixNQUFBRyxRQUFBLEdBQWlCekIsYUFBYSxDQUFDZSxhQUFhLENBQUM7WUFDN0NYLFNBQVMsQ0FBQ3FCLFFBQVEsS0FBSyxXQUFrQyxHQUEvQ2QsU0FBK0MsR0FBL0NjLFFBQStDLENBQUM7VUFBQTtRQUMzRDtNQUFBO0lBQUEsQ0FDRjtJQUFBakIsQ0FBQSxNQUFBSixTQUFBO0lBQUFJLENBQUEsTUFBQU8sYUFBQTtJQUFBUCxDQUFBLE1BQUFULEVBQUE7RUFBQTtJQUFBQSxFQUFBLEdBQUFYLENBQUE7RUFBQTtFQVpELE1BQUFrQixhQUFBLEdBQXNCUCxFQVlyQjtFQUVELE1BQUFRLGFBQUEsR0FBc0IzQixhQUFhLENBQUNlLGFBQWEsQ0FBQztFQUFBLElBQUFhLEVBQUE7RUFBQSxJQUFBcEIsQ0FBQSxRQUFBTyxhQUFBO0lBVzNDYSxFQUFBLEdBQUE1QixhQUFhLENBQUE2QixHQUFJLENBQUMsQ0FBQU1BQUEsRUFBQUMsS0FBQTtNQUNqQixNQUFBQyxVQUFBLEdBQW1CRCxLQUFLLEtBQUtoQixhQUFhO01BQUEsT0FHeEMsQ0FBQyxHQUFHLENBQU1lLEdBQU0sQ0FBTkEsT0FBSyxDQUFDLENBQWdCLGFBQUssQ0FBTCxLQUFLLENBQU0sR0FBQyxDQUFELEdBQUMsQ0FDMUMsQ0FBQyxJQUFJLENBQVEsS0FBcUMsQ0FBckMsQ0FBQUUsVUFBVSxHQUFWLFlBQXFDLEdBQXJDckIsU0FBb0MsQ0FBQyxDQUMvQyxDQUFBcUIsVUFBVSxHQUFHM0MsT0FBTyxDQUFBNEMsT0FBYyxHQUFsQyxHQUFpQyxDQUNwQyxFQUZDLElBQUkgQ0FJSixDQUFBSCxNQUFNLEtBQUssV0FZWCxHQVhDLENBQUMsSUFBSSxDQUFPRSxJQUFVLENBQVZBLFdBQVMsQ0FBQyxDQUFFLGVBQWUsRUFBdEMsSUFBSSxDQVdOLEdBVEMsQ0FBQyxHQUFHLENBQU0sR0FBQyxDQUFELEdBQUMsQ0FDVCxDQUFDLElBQUksQ0FDYyxlQUFrQyxDQUFsQyxDQUFBckMsMEJBQTBCLENBQUNtQyxNQUFNLEVBQUMsQ0FDN0MsS0FBYSxDQUFiLGFBQWEsQ0FFbEIsSUFBRSxDQUNMLEVBTEMsSUFBSSxDQU1MLENBQUMsSUFBSSxDQUFPRSxJQUFVLENBQVZBLFdBQVMsQ0FBQyxDQUFHLENBQUFsQyxVQUFVLENBQUNnQyxNQUFNLEVBQUUsRUFBM0MsSUFBSSxDQUNQLEVBUkMsR0FBRyxDQVNOLENBQ0YsRUFsQkMsR0FBRyxDQWtCRTtJQUFBLENBRVQsQ0FBQztJQUFBdEIsQ0FBQSxNQUFBTyxhQUFBO0lBQUFQLENBQUEsTUFBQW9CLEVBQUE7RUFBQTtJQUFBQSxFQUFBLEdBQUFwQixDQUFBO0VBQUE7RUFBQSxJQUFBMEIsRUFBQTtFQUFBLElBQUExQixDQUFBLFFBQUFvQixFQUFBO0lBekJKTSxFQUFBLElBQUMsR0FBRyxDQUFlLGFBQVEsQ0FBUixRQUFRLENBQ3hCLENBQUFOLEVBd0JBLENBQ0gsRUExQkMsR0FBRyxDQTBCRTtJQUFBcEIsQ0FBQSxNQUFBb0IsRUFBQTtJQUFBcEIsQ0FBQSxNQUFBMEIsRUFBQTtFQUFBO0lBQUFBLEVBQUEsR0FBQTFCLENBQUE7RUFBQTtFQUFBLElBQUEyQixFQUFBO0VBQUEsSUFBQTNCLENBQUEsUUFBQTRCLE1BQUEsQ0FBQUNDLEdbbbztcbiAgICAgICAgJFsxXSA9IHQzO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgdDMgPSAkWzFdO1xuICAgICAgfVxuICAgICAgcmV0dXJuIHQzO1xuICAgIH0iXSwiaWdub3JlTGlzdCI6W119
