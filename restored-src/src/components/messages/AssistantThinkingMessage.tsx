/**
 * AssistantThinkingMessage.tsx
 *
 * 【在 Claude Code 系统流程中的位置】
 * 本文件渲染助手消息中的思考块（thinking block）内容。
 * 思考块代表模型在生成最终回答前的内部推理过程（Chain-of-Thought）。
 * 位于：消息列表 → 助手消息行 → 【思考块显示区】
 *
 * 【主要功能】
 * 1. 接收 param（思考块数据）、addMargin（顶部边距）、isTranscriptMode、verbose、
 *    hideInTranscript（是否在转录模式下隐藏）五个属性。
 * 2. 当 thinking 为空或 hideInTranscript 为真时，直接返回 null。
 * 3. 根据 shouldShowFullThinking（isTranscriptMode || verbose）决定渲染模式：
 *    - 折叠模式：只显示"∴ Thinking <Ctrl+O展开>"占位行
 *    - 展开模式：显示"∴ Thinking…"标题 + Markdown 格式的完整思考内容
 */
import { c as _c } from "react/compiler-runtime";
import type { ThinkingBlock, ThinkingBlockParam } from '@anthropic-ai/sdk/resources/index.mjs';
import React from 'react';
import { Box, Text } from '../../ink.js';
import { CtrlOToExpand } from '../CtrlOToExpand.js';
import { Markdown } from '../Markdown.js';
type Props = {
  // Accept either full ThinkingBlock/ThinkingBlockParam or a minimal shape with just type and thinking
  param: ThinkingBlock | ThinkingBlockParam | {
    type: 'thinking';
    thinking: string;
  };
  addMargin: boolean;
  isTranscriptMode: boolean;
  verbose: boolean;
  /** When true, hide this thinking block entirely (used for past thinking in transcript mode) */
  hideInTranscript?: boolean;
};

/**
 * AssistantThinkingMessage 组件
 *
 * 【整体流程】
 * 1. 使用 _c(9) 创建 9 槽缓存数组
 * 2. 解构 param、addMargin（默认 false）、isTranscriptMode、verbose、hideInTranscript（默认 false）
 * 3. 从 param 中提取 thinking 字符串
 * 4. 早退检查：thinking 为空 → null；hideInTranscript 为真 → null
 * 5. 计算 shouldShowFullThinking = isTranscriptMode || verbose
 * 6. 折叠模式（!shouldShowFullThinking）：
 *    - 槽 0：静态"∴ Thinking <CtrlOToExpand/>"文本节点（sentinel 检查）
 *    - 槽 1/2：依据 marginTop 值变化缓存 Box 节点
 * 7. 展开模式（shouldShowFullThinking）：
 *    - 槽 3：静态"∴ Thinking…"标题文本节点（sentinel 检查）
 *    - 槽 4/5：依据 thinking 内容变化缓存 Markdown 内容 Box
 *    - 槽 6/7/8：依据 marginTop + 内容 Box 变化缓存外层 column Box
 *
 * 【设计意图】
 * 折叠模式下仅显示占位行节省终端空间，用户可通过 Ctrl+O 展开查看完整思考；
 * 转录模式或 verbose 模式下直接展示完整思考内容，方便调试和回放。
 */
export function AssistantThinkingMessage(t0) {
  // React Compiler 生成的 9 槽缓存数组
  const $ = _c(9);
  // 解构所有属性，处理 undefined 默认值
  const {
    param: t1,
    addMargin: t2,
    isTranscriptMode,
    verbose,
    hideInTranscript: t3
  } = t0;
  // 从 param 中提取实际思考内容字符串
  const {
    thinking
  } = t1;
  // 将 undefined 归一化为 false
  const addMargin = t2 === undefined ? false : t2;
  const hideInTranscript = t3 === undefined ? false : t3;
  // 早退：thinking 为空时不渲染
  if (!thinking) {
    return null;
  }
  // 早退：转录模式下明确要求隐藏此思考块时不渲染
  if (hideInTranscript) {
    return null;
  }
  // 是否展示完整思考内容：转录模式或 verbose 模式均展开
  const shouldShowFullThinking = isTranscriptMode || verbose;
  if (!shouldShowFullThinking) {
    // ── 折叠模式 ──
    // 计算顶部边距值：true → 1，false → 0
    const t4 = addMargin ? 1 : 0;
    let t5;
    // 槽 0：静态"∴ Thinking <CtrlOToExpand/>"节点，生命周期内只创建一次
    if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
      // dimColor 淡色 + italic 斜体 + CtrlOToExpand 展开提示
      t5 = <Text dimColor={true} italic={true}>{"\u2234 Thinking"} <CtrlOToExpand /></Text>;
      $[0] = t5;
    } else {
      t5 = $[0];
    }
    let t6;
    // 槽 1/2：依据边距值变化缓存 Box 节点
    if ($[1] !== t4) {
      t6 = <Box marginTop={t4}>{t5}</Box>;
      $[1] = t4;
      $[2] = t6;
    } else {
      t6 = $[2];
    }
    return t6;
  }
  // ── 展开模式 ──
  // 计算顶部边距值
  const t4 = addMargin ? 1 : 0;
  let t5;
  // 槽 3：静态"∴ Thinking…"标题文本节点，生命周期内只创建一次
  if ($[3] === Symbol.for("react.memo_cache_sentinel")) {
    // 展开状态下标题末尾用"…"而非展开提示
    t5 = <Text dimColor={true} italic={true}>{"\u2234 Thinking"}…</Text>;
    $[3] = t5;
  } else {
    t5 = $[3];
  }
  let t6;
  // 槽 4/5：依据 thinking 内容变化重建 Markdown 内容 Box
  if ($[4] !== thinking) {
    // paddingLeft=2 实现内容缩进，Markdown 渲染完整思考文本
    t6 = <Box paddingLeft={2}><Markdown dimColor={true}>{thinking}</Markdown></Box>;
    $[4] = thinking;
    $[5] = t6;
  } else {
    t6 = $[5];
  }
  let t7;
  // 槽 6/7/8：依据边距值或内容 Box 变化重建外层容器 Box
  if ($[6] !== t4 || $[7] !== t6) {
    // column 布局，gap=1 在标题与内容间留空行，width=100% 填满终端宽度
    t7 = <Box flexDirection="column" gap={1} marginTop={t4} width="100%">{t5}{t6}</Box>;
    $[6] = t4;
    $[7] = t6;
    $[8] = t7;
  } else {
    t7 = $[8];
  }
  return t7;
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJUaGlua2luZ0Jsb2NrIiwiVGhpbmtpbmdCbG9ja1BhcmFtIiwiUmVhY3QiLCJCb3giLCJUZXh0IiwiQ3RybE9Ub0V4cGFuZCIsIk1hcmtkb3duIiwiUHJvcHMiLCJwYXJhbSIsInR5cGUiLCJ0aGlua2luZyIsImFkZE1hcmdpbiIsImlzVHJhbnNjcmlwdE1vZGUiLCJ2ZXJib3NlIiwiaGlkZUluVHJhbnNjcmlwdCIsIkFzc2lzdGFudFRoaW5raW5nTWVzc2FnZSIsInQwIiwiJCIsIl9jIiwidDEiLCJ0MiIsInQzIiwidW5kZWZpbmVkIiwic2hvdWxkU2hvd0Z1bGxUaGlua2luZyIsInQ0IiwidDUiLCJTeW1ib2wiLCJmb3IiLCJsYWJlbCIsInQ2IiwidDciXSwic291cmNlcyI6WyJBc3Npc3RhbnRUaGlua2luZ01lc3NhZ2UudHN4Il0sInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB0eXBlIHtcbiAgVGhpbmtpbmdCbG9jayxcbiAgVGhpbmtpbmdCbG9ja1BhcmFtLFxufSBmcm9tICdAYW50aHJvcGljLWFpL3Nkay9yZXNvdXJjZXMvaW5kZXgubWpzJ1xuaW1wb3J0IFJlYWN0IGZyb20gJ3JlYWN0J1xuaW1wb3J0IHsgQm94LCBUZXh0IH0gZnJvbSAnLi4vLi4vaW5rLmpzJ1xuaW1wb3J0IHsgQ3RybE9Ub0V4cGFuZCB9IGZyb20gJy4uL0N0cmxPVG9FeHBhbmQuanMnXG5pbXBvcnQgeyBNYXJrZG93biB9IGZyb20gJy4uL01hcmtkb3duLmpzJ1xuXG50eXBlIFByb3BzID0ge1xuICAvLyBBY2NlcHQgZWl0aGVyIGZ1bGwgVGhpbmtpbmdCbG9jay9UaGlua2luZ0Jsb2NrUGFyYW0gb3IgYSBtaW5pbWFsIHNoYXBlIHdpdGgganVzdCB0eXBlIGFuZCB0aGlua2luZ1xuICBwYXJhbTpcbiAgICB8IFRoaW5raW5nQmxvY2tcbiAgICB8IFRoaW5raW5nQmxvY2tQYXJhbVxuICAgIHwgeyB0eXBlOiAndGhpbmtpbmcnOyB0aGlua2luZzogc3RyaW5nIH1cbiAgYWRkTWFyZ2luOiBib29sZWFuXG4gIGlzVHJhbnNjcmlwdE1vZGU6IGJvb2xlYW5cbiAgdmVyYm9zZTogYm9vbGVhblxuICAvKiogV2hlbiB0cnVlLCBoaWRlIHRoaXMgdGhpbmtpbmcgYmxvY2sgZW50aXJlbHkgKHVzZWQgZm9yIHBhc3QgdGhpbmtpbmcgaW4gdHJhbnNjcmlwdCBtb2RlKSAqL1xuICBoaWRlSW5UcmFuc2NyaXB0PzogYm9vbGVhblxufVxuXG5leHBvcnQgZnVuY3Rpb24gQXNzaXN0YW50VGhpbmtpbmdNZXNzYWdlKHtcbiAgcGFyYW06IHsgdGhpbmtpbmcgfSxcbiAgYWRkTWFyZ2luID0gZmFsc2UsXG4gIGlzVHJhbnNjcmlwdE1vZGUsXG4gIHZlcmJvc2UsXG4gIGhpZGVJblRyYW5zY3JpcHQgPSBmYWxzZSxcbn06IFByb3BzKTogUmVhY3QuUmVhY3ROb2RlIHtcbiAgaWYgKCF0aGlua2luZykge1xuICAgIHJldHVybiBudWxsXG4gIH1cblxuICBpZiAoaGlkZUluVHJhbnNjcmlwdCkge1xuICAgIHJldHVybiBudWxsXG4gIH1cblxuICBjb25zdCBzaG91bGRTaG93RnVsbFRoaW5raW5nID0gaXNUcmFuc2NyaXB0TW9kZSB8fCB2ZXJib3NlXG4gIGNvbnN0IGxhYmVsID0gJ+KItCBUaGlua2luZydcblxuICBpZiAoIXNob3VsZFNob3dGdWxsVGhpbmtpbmcpIHtcbiAgICByZXR1cm4gKFxuICAgICAgPEJveCBtYXJnaW5Ub3A9e2FkZE1hcmdpbiA/IDEgOiAwfT5cbiAgICAgICAgPFRleHQgZGltQ29sb3IgaXRhbGljPlxuICAgICAgICAgIHtsYWJlbH0gPEN0cmxPVG9FeHBhbmQgLz5cbiAgICAgICAgPC9UZXh0PlxuICAgICAgPC9Cb3g+XG4gICAgKVxuICB9XG5cbiAgcmV0dXJuIChcbiAgICA8Qm94XG4gICAgICBmbGV4RGlyZWN0aW9uPVwiY29sdW1uXCJcbiAgICAgIGdhcD17MX1cbiAgICAgIG1hcmdpblRvcD17YWRkTWFyZ2luID8gMSA6IDB9XG4gICAgICB3aWR0aD1cIjEwMCVcIlxuICAgID5cbiAgICAgIDxUZXh0IGRpbUNvbG9yIGl0YWxpYz5cbiAgICAgICAge2xhYmVsfeKAplxuICAgICAgPC9UZXh0PlxuICAgICAgPEJveCBwYWRkaW5nTGVmdD17Mn0+XG4gICAgICAgIDxNYXJrZG93biBkaW1Db2xvcj57dGhpbmtpbmd9PC9NYXJrZG93bj5cbiAgICAgIDwvQm94PlxuICAgIDwvQm94PlxuICApXG59XG4iXSwibWFwcGluZ3MiOiI7QUFBQSxjQUNFQSxhQUFhLEVBQ2JDLGtCQUFrQixRQUNiLHVDQUF1QztBQUM5QyxPQUFPQyxLQUFLLE1BQU0sT0FBTztBQUN6QixTQUFTQyxHQUFHLEVBQUVDLElBQUksUUFBUSxjQUFjO0FBQ3hDLFNBQVNDLGFBQWEsUUFBUSxxQkFBcUI7QUFDbkQsU0FBU0MsUUFBUSxRQUFRLGdCQUFnQjtBQUV6QyxLQUFLQyxLQUFLLEdBQUc7RUFDWDtFQUNBQyxLQUFLLEVBQ0RSLGFBQWEsR0FDYkMsa0JBQWtCLEdBQ2xCO0lBQUVRLElBQUksRUFBRSxVQUFVO0lBQUVDLFFBQVEsRUFBRSxNQUFNO0VBQUMsQ0FBQztFQUMxQ0MsU0FBUyxFQUFFLE9BQU87RUFDbEJDLGdCQUFnQixFQUFFLE9BQU87RUFDekJDLE9BQU8sRUFBRSxPQUFPO0VBQ2hCO0VBQ0FDLGdCQUFnQixDQUFDLEVBQUUsT0FBTztBQUM1QixDQUFDO0FBRUQsT0FBTyxTQUFBQyx5QkFBQUMsRUFBQTtFQUFBLE1BQUFDLENBQUEsR0FBQUMsRUFBQTtFQUFrQztJQUFBVixLQUFBLEVBQUFXLEVBQUE7SUFBQVIsU0FBQSxFQUFBUyxFQUFBO0lBQUFSLGdCQUFBO0lBQUFDLE9BQUE7SUFBQUMsZ0JBQUEsRUFBQU87RUFBQSxJQUFBTCxFQU1qQztFQUxDO0lBQUFOO0VBQUEsSUFBQVMsRUFBWTtFQUNuQixNQUFBUixTQUFBLEdBQUFTLEVBQWlCLEtBQWpCRSxTQUFpQixHQUFqQixLQUFpQixHQUFqQkYsRUFBaUI7RUFHakIsTUFBQU4sZ0JBQUEsR0FBQU8sRUFBd0IsS0FBeEJDLFNBQXdCLEdBQXhCLEtBQXdCLEdBQXhCRCxFQUF3QjtFQUV4QixJQUFJLENBQUNYLFFBQVE7SUFBQSxPQUNKLElBQUk7RUFBQTtFQUdiLElBQUlJLGdCQUFnQjtJQUFBLE9BQ1gsSUFBSTtFQUFBO0VBR2IsTUFBQVMsc0JBQUEsR0FBK0JYLGdCQUEyQixJQUEzQkMsT0FBMkI7RUFHMUQsSUFBSSxDQUFDVSxzQkFBc0I7SUFFUCxNQUFBQyxFQUFBLEdBQUFiLFNBQVMsR0FBVCxDQUFpQixHQUFqQixDQUFpQjtJQUFBLElBQUFjLEVBQUE7SUFBQSxJQUFBUixDQUFBLFFBQUFTLE1BQUEsQ0FBQUMsR0FBQTtNQUMvQkYsRUFBQSxJQUFDLElBQUksQ0FBQyxRQUFRLENBQVIsS0FBTyxDQUFDLENBQUMsTUFBTSxDQUFOLEtBQUssQ0FBQyxDQUNsQkcsQ0FOR0EsaUJBTURBLENBQUUsQ0FBQyxDQUFDLGFBQWEsR0FDeEIsRUFGQyxJQUFJLENBRUU7TUFBQVgsQ0FBQSxNQUFBUSxFQUFBO0lBQUE7TUFBQUEsRUFBQSxHQUFBUixDQUFBO0lBQUE7SUFBQSxJQUFBWSxFQUFBO0lBQUEsSUFBQVosQ0FBQSxRQUFBTyxFQUFBO01BSFRLLEVBQUEsSUFBQyxHQUFHLENBQVksU0FBaUIsQ0FBakIsQ0FBQUwsRUFBZ0IsQ0FBQyxDQUMvQixDQUFBQyxFQUVNLENBQ1IsRUFKQyxHQUFHLENBSUU7TUFBQVIsQ0FBQSxNQUFBTyxFQUFE7TUFBQU8sQ0FBQSxNQUFBWSxFQUFBO0lBQUE7TUFBQUEsRUFBQSxHQUFBWixDQUFBO0lBQUE7SUFBQSxPQUpOWSxFQUlNO0VBQUE7RUFRSyxNQUFBTCxFQUFBLEdBQUFiLFNBQVMsR0FBVCxDQUFpQixHQUFqQixDQUFpQjtFQUFBLElBQUFjLEVBQUE7RUFBQSxJQUFBUixDQUFBLFFBQUFTLE1BQUEsQ0FBQUMsR0FBQTtJQUc1QkYsRUFBQSxJQUFDLElBQUksQ0FBQyxRQUFRLENBQVIsS0FBTyxDQUFDLENBQUMsTUFBTSxDQUFOLEtBQUssQ0FBQyxDQUNsQkcsQ0FwQk9BLGlCQW9CSEFDLE1BQUUsQ0FDVCxFQUZDLElBQUksQ0FFRTtJQUFBWCxDQUFBLE1BQUFRLEVBQUE7RUFBQTtJQUFBQSxFQUFBLEdBQUFSLENBQUE7RUFBQTtFQUFBLElBQUFZLEVBQUE7RUFBQSxJQUFBWixDQUFBLFFBQUFQLFFBQUE7SUFDUG1CLEVBQUEsSUFBQyxHQUFHLENBQWMsV0FBQyxDQUFELEdBQUMsQ0FDakIsQ0FBQyxRQUFRLENBQUMsUUFBUSxDQUFSLEtBQU8sQ0FBQyxDQUFFbkIsU0FBTyxDQUFFLEVBQTVCLFFBQVEsQ0FDWCxFQUZDLEdBQUcsQ0FFRTtJQUFBTyxDQUFBLE1BQUFULFFBQUE7SUFBQU8sQ0FBQSxNQUFBWSxFQUFBO0VBQUE7SUFBQUEsRUFBQSxHQUFBWixDQUFBO0VBQUE7RUFBQSxJQUFBYSxFQUFBO0VBQUEsSUFBQWIsQ0FBQSxRQUFBTyxFQUFBLElBQUFQLENBQUEsUUFBQVksRUFBQTtJQVhSQyxFQUFBLElBQUMsR0FBRyxDQUNZLGFBQVEsQ0FBUixRQUFRLENBQ2pCLEdBQUMsQ0FBRCxHQUFDLENBQ0ssU0FBaUIsQ0FBakIsQ0FBQU4sRUFBZ0IsQ0FBQyxDQUN0QixLQUFNLENBQU4sTUFBTSxDQUVaLENBQUFDLEVBRU0sQ0FDTixDQUFBSSxFQUVLLENBQ1AsRUFaQyxHQUFHLENBWUU7SUFBQVosQ0FBQSxNQUFBTyxFQUFBO0lBQUFQLENBQUEsTUFBQVksRUFBQTtJQUFBWixDQUFBLE1BQUFhLEVBQUE7RUFBQTtJQUFBQSxFQUFBLEdBQUFiLENBQUE7RUFBQTtFQUFBLE9BWk5hLEVBWU07QUFBQSIsImlnbm9yZUxpc3QiOltdfQ==
