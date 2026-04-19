/**
 * PromptInputStashNotice.tsx
 *
 * 【系统流程位置】
 * 本文件是 Claude Code TUI 输入系统的暂存状态提示层，位于 PromptInput 组件内部。
 * 整体流程：PromptInput → PromptInputStashNotice（本文件）
 *   当用户触发 stash（暂存输入内容）时，PromptInput 传入 hasStash=true，
 *   本组件在输入框下方显示"已暂存"提示，告知用户内容将在提交后自动恢复。
 *
 * 【主要功能】
 * 当 hasStash=true 时，渲染一行暗色提示文字：
 *   ▸ Stashed (auto-restores after submit)
 * 当 hasStash=false 时，不渲染任何内容（返回 null）。
 *
 * 【React Compiler 缓存】
 * 使用 _c(1) 单槽缓存。JSX 节点不依赖任何 prop（hasStash 为 true 时内容固定），
 * 因此用 Symbol.for("react.memo_cache_sentinel") 标记首次渲染后永久缓存该 JSX。
 */
import { c as _c } from "react/compiler-runtime";
import figures from 'figures';
import * as React from 'react';
import { Box, Text } from 'src/ink.js';

/** 组件属性类型 */
type Props = {
  hasStash: boolean; // 是否存在已暂存的输入内容
};

/**
 * PromptInputStashNotice
 *
 * 【功能】
 * 根据 hasStash 状态决定是否渲染暂存提示：
 * - hasStash=false：直接返回 null，不占用任何屏幕空间
 * - hasStash=true：渲染 "▸ Stashed (auto-restores after submit)" 提示行
 *
 * 【React Compiler 缓存说明】
 * 使用 _c(1) 单槽缓存。
 * 当 hasStash=true 时，JSX 内容完全固定（无动态数据），
 * 首次进入此分支后通过 Symbol sentinel 永久缓存，后续直接复用缓存节点。
 *
 * 【视觉效果】
 * - paddingLeft=2：与输入内容对齐
 * - dimColor=true：使用暗色样式，不喧宾夺主
 * - figures.pointerSmall（▸）：轻量级视觉指示符
 */
export function PromptInputStashNotice(t0) {
  // React Compiler 单槽缓存
  const $ = _c(1);
  const {
    hasStash
  } = t0;
  // 无暂存内容时，不渲染任何东西
  if (!hasStash) {
    return null;
  }
  let t1;
  // Symbol sentinel 模式：hasStash=true 时 JSX 内容固定，首次渲染后永久缓存
  if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
    t1 = <Box paddingLeft={2}><Text dimColor={true}>{figures.pointerSmall} Stashed (auto-restores after submit)</Text></Box>;
    $[0] = t1;
  } else {
    // 直接复用上次缓存的 JSX 节点
    t1 = $[0];
  }
  return t1;
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJmaWd1cmVzIiwiUmVhY3QiLCJCb3giLCJUZXh0IiwiUHJvcHMiLCJoYXNTdGFzaCIsIlByb21wdElucHV0U3Rhc2hOb3RpY2UiLCJ0MCIsIiQiLCJfYyIsInQxIiwiU3ltYm9sIiwiZm9yIiwicG9pbnRlclNtYWxsIl0sInNvdXJjZXMiOlsiUHJvbXB0SW5wdXRTdGFzaE5vdGljZS50c3giXSwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IGZpZ3VyZXMgZnJvbSAnZmlndXJlcydcbmltcG9ydCAqIGFzIFJlYWN0IGZyb20gJ3JlYWN0J1xuaW1wb3J0IHsgQm94LCBUZXh0IH0gZnJvbSAnc3JjL2luay5qcydcblxudHlwZSBQcm9wcyA9IHtcbiAgaGFzU3Rhc2g6IGJvb2xlYW5cbn1cblxuZXhwb3J0IGZ1bmN0aW9uIFByb21wdElucHV0U3Rhc2hOb3RpY2UoeyBoYXNTdGFzaCB9OiBQcm9wcyk6IFJlYWN0LlJlYWN0Tm9kZSB7XG4gIGlmICghaGFzU3Rhc2gpIHtcbiAgICByZXR1cm4gbnVsbFxuICB9XG5cbiAgcmV0dXJuIChcbiAgICA8Qm94IHBhZGRpbmdMZWZ0PXsyfT5cbiAgICAgIDxUZXh0IGRpbUNvbG9yPlxuICAgICAgICB7ZmlndXJlcy5wb2ludGVyU21hbGx9IFN0YXNoZWQgKGF1dG8tcmVzdG9yZXMgYWZ0ZXIgc3VibWl0KVxuICAgICAgPC9UZXh0PlxuICAgIDwvQm94PlxuICApXG59XG4iXSwibWFwcGluZ3MiOiI7QUFBQSxPQUFPQSxPQUFPLE1BQU0sU0FBUztBQUM3QixPQUFPLEtBQUtDLEtBQUssTUFBTSxPQUFPO0FBQzlCLFNBQVNDLEdBQUcsRUFBRUMsSUFBSSxRQUFRLFlBQVk7QUFFdEMsS0FBS0MsS0FBSyxHQUFHO0VBQ1hDLFFBQVEsRUFBRSxPQUFPO0FBQ25CLENBQUM7QUFFRCxPQUFPLFNBQUFDLHVCQUFBQyxFQUFBO0VBQUEsTUFBQUMsQ0FBQSxHQUFBQyxFQUFBO0VBQWdDO0lBQUFKO0VBQUEsSUFBQUUsRUFBbUI7RUFDeEQsSUFBSSxDQUFDRixRQUFRO0lBQUEsT0FDSixJQUFJO0VBQUE7RUFDWixJQUFBSyxFQUFBO0VBQUEsSUFBQUYsQ0FBQSxRQUFBRyxNQUFBLENBQUFDLEdBQUE7SUFHQ0YsRUFBQSxJQUFDLEdBQUcsQ0FBYyxXQUFDLENBQUQsR0FBQyxDQUNqQixDQUFDLElBQUksQ0FBQyxRQUFRLENBQVIsS0FBTyxDQUFDLENBQ1gsQ0FBQVYsT0FBTyxDQUFBYSxZQUFZLENBQUUscUNBQ3hCLEVBRkMsSUFBSSxDQUdQLEVBSkMsR0FBRyxDQUlFO0lBQUFMLENBQUEsTUFBQUUsRUFBQTtFQUFBO0lBQUFBLEVBQUEsR0FBQUYsQ0FBQTtFQUFBO0VBQUEsT0FKTkUsRUFJTTtBQUFBIiwiaWdub3JlTGlzdCI6W119
