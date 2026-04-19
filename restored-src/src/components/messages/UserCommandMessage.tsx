/**
 * UserCommandMessage.tsx
 *
 * 在 Claude Code 系统流程中的位置：
 * 该组件属于用户消息渲染层，专门负责渲染斜杠命令（/command）和技能调用（Skill(name)）
 * 两种交互形式的用户消息。由 UserTextMessage 根据文本内容中是否包含
 * COMMAND_MESSAGE_TAG XML 标签而分派到该组件。
 *
 * 主要功能：
 * 1. 从带 XML 标签的文本块中提取命令名称（COMMAND_MESSAGE_TAG）
 * 2. 提取可选的命令参数（command-args 标签）
 * 3. 检测是否为 Skill 格式（skill-format 标签值为 "true"）
 * 4. 以 "▶ Skill(name)" 或 "▶ /command args" 两种格式渲染到终端
 * 5. 使用 React Compiler 的记忆缓存（_c）进行性能优化
 */

import { c as _c } from "react/compiler-runtime";
import type { TextBlockParam } from '@anthropic-ai/sdk/resources/index.mjs';
import figures from 'figures';
import * as React from 'react';
import { COMMAND_MESSAGE_TAG } from '../../constants/xml.js';
import { Box, Text } from '../../ink.js';
import { extractTag } from '../../utils/messages.js';

// Props 类型：addMargin 控制顶部外边距，param 为 Anthropic SDK 文本块参数
type Props = {
  addMargin: boolean;
  param: TextBlockParam;
};

/**
 * UserCommandMessage — 斜杠命令 / 技能消息渲染组件
 *
 * 完整渲染流程：
 * 1. 使用 extractTag 从 text 中提取命令名称（COMMAND_MESSAGE_TAG）和参数（command-args）
 * 2. 检测 skill-format 标签，判断是否为 Skill 格式
 * 3. 若 commandMessage 为空则返回 null（无效消息，不渲染）
 * 4. 若为 Skill 格式，渲染为 "▶ Skill(commandMessage)" 样式
 * 5. 若为斜杠命令格式，拼接成 "/commandMessage args"，渲染为 "▶ /command args" 样式
 * 6. 所有渲染结果均有用户消息背景色（userMessageBackground）和右侧内边距
 */
export function UserCommandMessage(t0) {
  // React Compiler 自动记忆缓存，共 19 个插槽
  const $ = _c(19);
  const {
    addMargin,
    param: t1
  } = t0;
  const {
    text
  } = t1;

  // 从 XML 文本中提取命令名称，结果缓存到插槽 0-1
  let t2;
  if ($[0] !== text) {
    t2 = extractTag(text, COMMAND_MESSAGE_TAG);
    $[0] = text;
    $[1] = t2;
  } else {
    t2 = $[1];
  }
  const commandMessage = t2;  // 提取出的命令名称字符串

  // 从 XML 文本中提取命令参数，结果缓存到插槽 2-3
  let t3;
  if ($[2] !== text) {
    t3 = extractTag(text, "command-args");
    $[2] = text;
    $[3] = t3;
  } else {
    t3 = $[3];
  }
  const args = t3;  // 提取出的命令参数（可能为 null）

  // 检测是否为 Skill 格式（skill-format 标签值等于 "true"）
  const isSkillFormat = extractTag(text, "skill-format") === "true";

  // 若无命令名称（提取失败），则不渲染任何内容
  if (!commandMessage) {
    return null;
  }

  // 分支一：Skill 格式渲染 — 显示 "▶ Skill(name)"
  if (isSkillFormat) {
    // 根据 addMargin 决定顶部外边距
    const t4 = addMargin ? 1 : 0;
    // 静态箭头指针节点，永久缓存（仅创建一次）
    let t5;
    if ($[4] === Symbol.for("react.memo_cache_sentinel")) {
      t5 = <Text color="subtle">{figures.pointer} </Text>;
      $[4] = t5;
    } else {
      t5 = $[4];
    }
    // 包含命令名称的文本行节点，当 commandMessage 变化时重新渲染
    let t6;
    if ($[5] !== commandMessage) {
      t6 = <Text>{t5}<Text color="text">Skill({commandMessage})</Text></Text>;
      $[5] = commandMessage;
      $[6] = t6;
    } else {
      t6 = $[6];
    }
    // 最外层容器 Box，带有用户消息背景色
    let t7;
    if ($[7] !== t4 || $[8] !== t6) {
      t7 = <Box flexDirection="column" marginTop={t4} backgroundColor="userMessageBackground" paddingRight={1}>{t6}</Box>;
      $[7] = t4;
      $[8] = t6;
      $[9] = t7;
    } else {
      t7 = $[9];
    }
    return t7;
  }

  // 分支二：斜杠命令格式渲染 — 显示 "▶ /command args"
  // 过滤掉 null/undefined 的参数后用空格拼接，构造 "/command args" 字符串
  let t4;
  if ($[10] !== args || $[11] !== commandMessage) {
    t4 = [commandMessage, args].filter(Boolean);
    $[10] = args;
    $[11] = commandMessage;
    $[12] = t4;
  } else {
    t4 = $[12];
  }
  // 以 "/" 开头拼接命令和参数
  const content = `/${t4.join(" ")}`;

  // 根据 addMargin 决定顶部外边距
  const t5 = addMargin ? 1 : 0;

  // 静态箭头指针节点（斜杠命令分支），永久缓存
  let t6;
  if ($[13] === Symbol.for("react.memo_cache_sentinel")) {
    t6 = <Text color="subtle">{figures.pointer} </Text>;
    $[13] = t6;
  } else {
    t6 = $[13];
  }

  // 显示完整命令字符串的文本节点，当 content 变化时重新渲染
  let t7;
  if ($[14] !== content) {
    t7 = <Text>{t6}<Text color="text">{content}</Text></Text>;
    $[14] = content;
    $[15] = t7;
  } else {
    t7 = $[15];
  }

  // 最外层容器 Box，带有用户消息背景色和右侧内边距
  let t8;
  if ($[16] !== t5 || $[17] !== t7) {
    t8 = <Box flexDirection="column" marginTop={t5} backgroundColor="userMessageBackground" paddingRight={1}>{t7}</Box>;
    $[16] = t5;
    $[17] = t7;
    $[18] = t8;
  } else {
    t8 = $[18];
  }
  return t8;
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJUZXh0QmxvY2tQYXJhbSIsImZpZ3VyZXMiLCJSZWFjdCIsIkNPTU1BTkRfTUVTU0FHRV9UQUciLCJCb3giLCJUZXh0IiwiZXh0cmFjdFRhZyIsIlByb3BzIiwiYWRkTWFyZ2luIiwicGFyYW0iLCJVc2VyQ29tbWFuZE1lc3NhZ2UiLCJ0MCIsIiQiLCJfYyIsInQxIiwidGV4dCIsInQyIiwiY29tbWFuZE1lc3NhZ2UiLCJ0MyIsImFyZ3MiLCJpc1NraWxsRm9ybWF0IiwidDQiLCJ0NSIsIlN5bWJvbCIsImZvciIsInBvaW50ZXIiLCJ0NiIsInQ3IiwiZmlsdGVyIiwiQm9vbGVhbiIsImNvbnRlbnQiLCJqb2luIiwidDgiXSwic291cmNlcyI6WyJVc2VyQ29tbWFuZE1lc3NhZ2UudHN4Il0sInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB0eXBlIHsgVGV4dEJsb2NrUGFyYW0gfSBmcm9tICdAYW50aHJvcGljLWFpL3Nkay9yZXNvdXJjZXMvaW5kZXgubWpzJ1xuaW1wb3J0IGZpZ3VyZXMgZnJvbSAnZmlndXJlcydcbmltcG9ydCAqIGFzIFJlYWN0IGZyb20gJ3JlYWN0J1xuaW1wb3J0IHsgQ09NTUFORF9NRVNTQUdFX1RBRyB9IGZyb20gJy4uLy4uL2NvbnN0YW50cy94bWwuanMnXG5pbXBvcnQgeyBCb3gsIFRleHQgfSBmcm9tICcuLi8uLi9pbmsuanMnXG5pbXBvcnQgeyBleHRyYWN0VGFnIH0gZnJvbSAnLi4vLi4vdXRpbHMvbWVzc2FnZXMuanMnXG5cbnR5cGUgUHJvcHMgPSB7XG4gIGFkZE1hcmdpbjogYm9vbGVhblxuICBwYXJhbTogVGV4dEJsb2NrUGFyYW1cbn1cblxuZXhwb3J0IGZ1bmN0aW9uIFVzZXJDb21tYW5kTWVzc2FnZSh7XG4gIGFkZE1hcmdpbixcbiAgcGFyYW06IHsgdGV4dCB9LFxufTogUHJvcHMpOiBSZWFjdC5SZWFjdE5vZGUge1xuICBjb25zdCBjb21tYW5kTWVzc2FnZSA9IGV4dHJhY3RUYWcodGV4dCwgQ09NTUFORF9NRVNTQUdFX1RBRylcbiAgY29uc3QgYXJncyA9IGV4dHJhY3RUYWcodGV4dCwgJ2NvbW1hbmQtYXJncycpXG4gIGNvbnN0IGlzU2tpbGxGb3JtYXQgPSBleHRyYWN0VGFnKHRleHQsICdza2lsbC1mb3JtYXQnKSA9PT0gJ3RydWUnXG5cbiAgaWYgKCFjb21tYW5kTWVzc2FnZSkge1xuICAgIHJldHVybiBudWxsXG4gIH1cblxuICAvLyBTa2lsbHMgdXNlIFwiU2tpbGwobmFtZSlcIiBmb3JtYXRcbiAgaWYgKGlzU2tpbGxGb3JtYXQpIHtcbiAgICByZXR1cm4gKFxuICAgICAgPEJveFxuICAgICAgICBmbGV4RGlyZWN0aW9uPVwiY29sdW1uXCJcbiAgICAgICAgbWFyZ2luVG9wPXthZGRNYXJnaW4gPyAxIDogMH1cbiAgICAgICAgYmFja2dyb3VuZENvbG9yPVwidXNlck1lc3NhZ2VCYWNrZ3JvdW5kXCJcbiAgICAgICAgcGFkZGluZ1JpZ2h0PXsxfVxuICAgICAgPlxuICAgICAgICA8VGV4dD5cbiAgICAgICAgICA8VGV4dCBjb2xvcj1cInN1YnRsZVwiPntmaWd1cmVzLnBvaW50ZXJ9IDwvVGV4dD5cbiAgICAgICAgICA8VGV4dCBjb2xvcj1cInRleHRcIj5Ta2lsbCh7Y29tbWFuZE1lc3NhZ2V9KTwvVGV4dD5cbiAgICAgICAgPC9UZXh0PlxuICAgICAgPC9Cb3g+XG4gICAgKVxuICB9XG5cbiAgLy8gU2xhc2ggY29tbWFuZCBmb3JtYXQ6IHNob3cgYXMgXCLina8gL2NvbW1hbmQgYXJnc1wiXG4gIGNvbnN0IGNvbnRlbnQgPSBgLyR7W2NvbW1hbmRNZXNzYWdlLCBhcmdzXS5maWx0ZXIoQm9vbGVhbikuam9pbignICcpfWBcbiAgcmV0dXJuIChcbiAgICA8Qm94XG4gICAgICBmbGV4RGlyZWN0aW9uPVwiY29sdW1uXCJcbiAgICAgIG1hcmdpblRvcD17YWRkTWFyZ2luID8gMSA6IDB9XG4gICAgICBiYWNrZ3JvdW5kQ29sb3I9XCJ1c2VyTWVzc2FnZUJhY2tncm91bmRcIlxuICAgICAgcGFkZGluZ1JpZ2h0PXsxfVxuICAgID5cbiAgICAgIDxUZXh0PlxuICAgICAgICA8VGV4dCBjb2xvcj1cInN1YnRsZVwiPntmaWd1cmVzLnBvaW50ZXJ9IDwvVGV4dD5cbiAgICAgICAgPFRleHQgY29sb3I9XCJ0ZXh0XCI+e2NvbnRlbnR9PC9UZXh0PlxuICAgICAgPC9UZXh0PlxuICAgIDwvQm94PlxuICApXG59XG4iXSwibWFwcGluZ3MiOiI7QUFBQSxjQUFjQSxjQUFjLFFBQVEsdUNBQXVDO0FBQzNFLE9BQU9DLE9BQU8sTUFBTSxTQUFTO0FBQzdCLE9BQU8sS0FBS0MsS0FBSyxNQUFNLE9BQU87QUFDOUIsU0FBU0MsbUJBQW1CLFFBQVEsd0JBQXdCO0FBQzVELFNBQVNDLEdBQUcsRUFBRUMsSUFBSSxRQUFRLGNBQWM7QUFDeEMsU0FBU0MsVUFBVSxRQUFRLHlCQUF5QjtBQUVwRCxLQUFLQyxLQUFLLEdBQUc7RUFDWEMsU0FBUyxFQUFFLE9BQU87RUFDbEJDLEtBQUssRUFBRVQsY0FBYztBQUN2QixDQUFDO0FBRUQsT0FBTyxTQUFBVSxtQkFBQUMsRUFBQTtFQUFBLE1BQUFDLENBQUEsR0FBQUMsRUFBQTtFQUE0QjtJQUFBTCxTQUFBO0lBQUFDLEtBQUEsRUFBQUs7RUFBQSxJQUFBSCxFQUczQjtFQURDO0lBQUFJO0VBQUEsSUFBQUQsRUFBUTtFQUFBLElBQUFFLEVBQUE7RUFBQSxJQUFBSixDQUFBLFFBQUFHLElBQUE7SUFFUUMsRUFBQSxHQUFBVixVQUFVLENBQUNTLElBQUksRUFBRVosbUJBQW1CLENBQUM7SUFBQVMsQ0FBQSxNQUFBRyxJQUFBO0lBQUFILENBQUEsTUFBQUksRUFBQTtFQUFBO0lBQUFBLEVBQUEsR0FBQUosQ0FBQTtFQUFBO0VBQTVELE1BQUFLLGNBQUEsR0FBdUJELEVBQXFDO0VBQUEsSUFBQUUsRUFBQTtFQUFBLElBQUFOLENBQUEsUUFBQUcsSUFBQTtJQUMvQ0csRUFBQSxHQUFBWixVQUFVLENBQUNTLElBQUksRUFBRSxjQUFjLENBQUM7SUFBQUgsQ0FBQSxNQUFBRyxJQUFBO0lBQUFILENBQUEsTUFBQU0sRUFBQTtFQUFBO0lBQUFBLEVBQUEsR0FBQU4sQ0FBQTtFQUFBO0VBQTdDLE1BQUFPLElBQUEsR0FBYUQsRUFBZ0M7RUFDN0MsTUFBQUUsYUFBQSxHQUFzQmQsVUFBVSxDQUFDUyxJQUFJLEVBQUUsY0FBYyxDQUFDLEtBQUssTUFBTTtFQUVqRSxJQUFJLENBQUNFLGNBQWM7SUFBQSxPQUNWLElBQUk7RUFBQTtFQUliLElBQUlHLGFBQWE7SUFJQSxNQUFBQyxFQUFBLEdBQUFiLFNBQVMsR0FBVCxDQUFpQixHQUFqQixDQUFpQjtJQUFBLElBQUFjLEVBQUE7SUFBQSxJQUFBVixDQUFBLFFBQUFXLE1BQUEsQ0FBQUMsR0FBQTtNQUsxQkYsRUFBQSxJQUFDLElBQUksQ0FBTyxLQUFRLENBQVIsUUFBUSxDQUFFLENBQUFyQixPQUFPLENBQUF3QixPQUFPLENBQUUsQ0FBQyxFQUF0QyxJQUFJLENBQXlDO01BQUFiLENBQUEsTUFBQVUsRUFBQTtJQUFBO01BQUFBLEVBQUEsR0FBQVYsQ0FBQTtJQUFBO0lBQUEsSUFBQWMsRUFBQTtJQUFBLElBQUFkLENBQUEsUUFBQUssY0FBQTtNQURoRFMsRUFBQSxJQUFDLElBQUksQ0FDSCxDQUFBSixFQUE2QyxDQUM3QyxDQUFDLElBQUksQ0FBTyxLQUFNLENBQU4sTUFBTSxDQUFDLE1BQU9MLGVBQWEsQ0FBRSxDQUFDLEVBQXpDLElBQUksQ0FDUCxFQUhDLElBQUksQ0FHRTtNQUFBTCxDQUFBLE1BQUFLLGNBQUE7TUFBQUwsQ0FBQSxNQUFBYyxFQUFBO0lBQUE7TUFBQUEsRUFBQSxHQUFBZCxDQUFBO0lBQUE7SUFBQSxJQUFBZSxFQUFBO0lBQUEsSUFBQWYsQ0FBQSxRQUFBUyxFQUFELElBQUFULENBQUEsUUFBQWMsRUFBQTtNQVRURSxFQUFBLElBQUMsR0FBRyxDQUNZLGFBQVEsQ0FBUixRQUFRLENBQ1gsU0FBaUIsQ0FBakIsQ0FBQU4sRUFBZ0IsQ0FBQyxDQUNaLGVBQXVCLENBQXZCLHVCQUF1QixDQUN6QixZQUFDLENBQUQsR0FBQyxDQUVmLENBQUFLLEVBR00sQ0FDUixFQVZDLEdBQUcsQ0FVRTtNQUFBZCxDQUFBLE1BQUFTLEVBQUE7TUFBQVQsQ0FBQSxNQUFBYyxFQUFE7TUFBQWQsQ0FBQSxNQUFBZSxFQUFBO0lBQUE7TUFBQUEsRUFBQSxHQUFBZixDQUFBO0lBQUE7SUFBQSxPQVZOZSxFQVVNO0VBQUE7RUFFVCxJQUFBTixFQUFBO0VBQUEsSUFBQVQsQ0FBQSxTQUFBTyxJQUFBLElBQUFQLENBQUEsU0FBQUssY0FBQTtJQUdtQkksRUFBQSxJQUFDSixjQUFjLEVBQUVFLElBQUksQ0FBQyxDQUFBUyxNQUFPLENBQUNDLE9BQU8sQ0FBQztJQUFBakIsQ0FBQSxPQUFBTyxJQUFBO0lBQUFQLENBQUEsT0FBQUssY0FBQTtJQUFBTCxDQUFBLE9BQUFTLEVBQUE7RUFBQTtJQUFBQSxFQUFBLEdBQUFULENBQUE7RUFBQTFNQUFBLEFBQTFELE1BQUFrQixPQUFBLEdBQWdCLElBQUlULEVBQXNDLENBQUFVLElBQUssQ0FBQyxHQUFHLENBQUMsRUFBRTtFQUl2RCxNQUFBVCxFQUFBLEdBQUFkLFNBQVMsR0FBVCxDQUFpQixHQUFqQixDQUFpQjtFQUFBLElBQUFrQixFQUFBO0VBQUEsSUFBQWQsQ0FBQSxTQUFBVyxNQUFBLENBQUFDLEdBQUE7SUFLMUJFLEVBQUFJSUF3SUMsSUFBSSxDQUFPLEtBQVEsQ0FBUixRQUFRLENBQUUsQ0FBQXpCLE9BQU8sQ0FBQXdCLE9BQU8sQ0FBRSxDQUFDLEVBQXRDLElBQUksQ0FBeUM7SUFBQWIsQ0FBQSxPQUFBYyxFQUFBO0VBQUE7SUFBQUEsRUFBQSxHQUFBZCxDQUFBO0VBQUE7RUFBQSxJQUFBZSxFQUFBO0VBQUEsSUFBQWYsQ0FBQSxTQUFBa0IsT0FBQTtJQURoREgsRUFBQSxJQUFDLElBQUksQ0FDSCxDQUFBRCxFQUE2QyxDQUM3QyxDQUFDLElBQUksQ0FBTyxLQUFNLENBQU4sTUFBTSxDQUFFSSxRQUFNLENBQUUsRUFBM0IsSUFBSSxDQUNQLEVBSEMsSUFBSSxDQUdFO0lBQUFsQixDQUFBLE9BQUFrQixPQUFBO0lBQUFsQixDQUFBLE9BQUFlLEVBQUQ7RUFBQTtJQUFBQSxFQUFBLEdBQUFmLENBQUE7RUFBQTtFQUFBLElBQUFvQixFQUFBO0VBQUEsSUFBQXBCLENBQUEsU0FBQVUsRUFBQSxJQUFBVixDQUFBLFNBQUFlLEVBQUE7SUFUVFBLLEVBQUFJSUF3SUMsR0FBRyxDQUNZLGFBQVEsQ0FBUixRQUFRLENBQ1gsU0FBaUIsQ0FBakIsQ0FBQVYsRUFBZ0IsQ0FBQyxDQUNaLGVBQXVCLENBQXZCLHVCQUF1QixDQUN6QixZQUFDLENBQUQsR0FBQyxDQUVmLENBQUFLLEVBR00sQ0FDUixFQVZDLEdBQUcsQ0FVRTtJQUFBZixDQUFBLE9BQUFTLEVBQUE7SUFBQVQsQ0FBQSxPQUFBZSxFQUFBO0lBQUFmLENBQUEsT0FBQW9CLEVBQUE7RUFBQTtJQUFBQSxFQUFBLEdBQUFwQixDQUFBO0VBQUE7RUFBQSxPQVZOb0IsRUFVTTtBQUFBIiwiaWdub3JlTGlzdCI6W119
