/**
 * PromptInputModeIndicator.tsx
 *
 * 【系统流程位置】
 * 本文件位于 Claude Code TUI 输入系统的最左侧提示符渲染层。
 * 整体流程：用户交互 → PromptInput 组件 → PromptInputModeIndicator（本文件）
 *   → PromptChar（渲染 ❯ 或 ! 字符）
 *
 * 【主要功能】
 * 1. 根据当前输入模式（普通/bash/viewing agent）渲染不同样式的提示符字符
 * 2. 在 Agent Swarms 模式下，为本机 teammate 的提示符着色
 * 3. 查看特定 agent 会话时，使用该 agent 对应的主题颜色渲染提示符
 *
 * 三种分支逻辑：
 *   - viewingAgentName 存在 → 使用被查看 agent 的颜色渲染 ❯
 *   - mode === "bash"       → 渲染橙色 !（bash 模式标识）
 *   - 普通模式              → 渲染 ❯，swarms 启用时用本机 teammate 颜色
 */
import { c as _c } from "react/compiler-runtime";
import figures from 'figures';
import * as React from 'react';
import { Box, Text } from 'src/ink.js';
import { AGENT_COLOR_TO_THEME_COLOR, AGENT_COLORS, type AgentColorName } from 'src/tools/AgentTool/agentColorManager.js';
import type { PromptInputMode } from 'src/types/textInputTypes.js';
import { getTeammateColor } from 'src/utils/teammate.js';
import type { Theme } from 'src/utils/theme.js';
import { isAgentSwarmsEnabled } from '../../utils/agentSwarmsEnabled.js';

/** 组件属性类型 */
type Props = {
  mode: PromptInputMode;        // 当前输入模式（"normal" | "bash" | 其他）
  isLoading: boolean;           // 是否处于加载/等待状态（提示符变暗）
  viewingAgentName?: string;    // 正在查看的 agent 名称（存在时进入 viewing 分支）
  viewingAgentColor?: AgentColorName; // 正在查看的 agent 的颜色标识
};

/**
 * getTeammateThemeColor
 *
 * 【功能】
 * 获取当前本机实例（teammate）的主题颜色键名（keyof Theme），
 * 用于在 swarms 模式下为提示符着色，区分不同 teammate 的终端窗口。
 *
 * 【流程】
 * 1. 检查 isAgentSwarmsEnabled()，未启用直接返回 undefined
 * 2. 调用 getTeammateColor() 获取本机分配的颜色名
 * 3. 验证颜色名在 AGENT_COLORS 白名单内
 * 4. 通过 AGENT_COLOR_TO_THEME_COLOR 映射返回对应主题颜色键
 *
 * 【返回值】
 * - keyof Theme（如 "agent1" | "agent2" 等）：成功时返回主题颜色键
 * - undefined：swarms 未启用、颜色未设置、或颜色不在白名单内
 */
function getTeammateThemeColor(): keyof Theme | undefined {
  // swarms 功能未启用时，无需着色
  if (!isAgentSwarmsEnabled()) {
    return undefined;
  }
  // 获取本机实例的颜色名
  const colorName = getTeammateColor();
  if (!colorName) {
    return undefined;
  }
  // 验证颜色名合法后，映射为主题颜色键
  if (AGENT_COLORS.includes(colorName as AgentColorName)) {
    return AGENT_COLOR_TO_THEME_COLOR[colorName as AgentColorName];
  }
  return undefined;
}

/** PromptChar 内部属性类型 */
type PromptCharProps = {
  isLoading: boolean;
  // 死代码消除注意：参数命名为 themeColor 而非 teammateColor，
  // 避免外部构建产物中出现 "teammate" 字符串
  themeColor?: keyof Theme;
};

/**
 * PromptChar
 *
 * 【功能】
 * 渲染提示符字符 ❯（figures.pointer）。
 * 当传入 themeColor 时，使用该颜色；
 * 否则在内部构建（isAnt）下使用 "subtle" 颜色，外部构建使用默认颜色。
 *
 * 【React Compiler 缓存】
 * 使用 _c(3) 三槽缓存，依赖 [color, isLoading] 变化时才重新渲染 JSX。
 */
function PromptChar(t0) {
  // React Compiler 三槽缓存：[color, isLoading, t1(JSX)]
  const $ = _c(3);
  const {
    isLoading,
    themeColor
  } = t0;
  // 将 themeColor 参数重命名为语义更清晰的 teammateColor
  const teammateColor = themeColor;
  // false 为编译时常量（非 "ant" 内部构建），外部构建下 isAnt 永远为 false
  const color = teammateColor ?? (false ? "subtle" : undefined);
  let t1;
  // 仅当 color 或 isLoading 变化时重新构建 JSX
  if ($[0] !== color || $[1] !== isLoading) {
    t1 = <Text color={color} dimColor={isLoading}>{figures.pointer} </Text>;
    $[0] = color;
    $[1] = isLoading;
    $[2] = t1;
  } else {
    t1 = $[2];
  }
  return t1;
}

/**
 * PromptInputModeIndicator
 *
 * 【功能】
 * 根据三种场景渲染不同样式的输入提示符，是 PromptInput 最左侧的视觉元素：
 *   1. 正在查看某 agent 的会话（viewingAgentName 存在）
 *      → 渲染 ❯，颜色为被查看 agent 的主题色
 *   2. bash 模式（mode === "bash"）
 *      → 渲染橙色 !（bashBorder 颜色）
 *   3. 普通模式
 *      → 渲染 ❯，若 swarms 启用则使用本机 teammate 颜色
 *
 * 【React Compiler 缓存】
 * 使用 _c(6) 六槽缓存：
 *   - 槽[0]：getTeammateThemeColor() 结果（仅首次渲染计算一次，Symbol sentinel 模式）
 *   - 槽[1-4]：isLoading、mode、viewedTeammateThemeColor、viewingAgentName
 *   - 槽[5]：最终 JSX 节点
 *
 * getTeammateThemeColor() 只在组件首次渲染时执行（Symbol sentinel 检测），
 * 因为 teammate 颜色在进程生命周期内不变。
 */
export function PromptInputModeIndicator(t0) {
  // React Compiler 六槽缓存
  const $ = _c(6);
  const {
    mode,
    isLoading,
    viewingAgentName,
    viewingAgentColor
  } = t0;
  let t1;
  // Symbol sentinel 模式：仅在首次渲染时调用 getTeammateThemeColor()
  // teammate 颜色由配置文件决定，运行期间不会改变
  if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
    t1 = getTeammateThemeColor();
    $[0] = t1;
  } else {
    t1 = $[0];
  }
  const teammateColor = t1;
  // 将被查看 agent 的 AgentColorName 转换为主题颜色键
  // 若 viewingAgentColor 未定义则回退到 undefined（PromptChar 内部使用默认颜色）
  const viewedTeammateThemeColor = viewingAgentColor ? AGENT_COLOR_TO_THEME_COLOR[viewingAgentColor] : undefined;
  let t2;
  // 任何影响渲染的 prop 变化时重建 JSX
  if ($[1] !== isLoading || $[2] !== mode || $[3] !== viewedTeammateThemeColor || $[4] !== viewingAgentName) {
    // 三分支渲染逻辑
    t2 = <Box alignItems="flex-start" alignSelf="flex-start" flexWrap="nowrap" justifyContent="flex-start">{viewingAgentName ? <PromptChar isLoading={isLoading} themeColor={viewedTeammateThemeColor} /> : mode === "bash" ? <Text color="bashBorder" dimColor={isLoading}>! </Text> : <PromptChar isLoading={isLoading} themeColor={isAgentSwarmsEnabled() ? teammateColor : undefined} />}</Box>;
    $[1] = isLoading;
    $[2] = mode;
    $[3] = viewedTeammateThemeColor;
    $[4] = viewingAgentName;
    $[5] = t2;
  } else {
    t2 = $[5];
  }
  return t2;
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJmaWd1cmVzIiwiUmVhY3QiLCJCb3giLCJUZXh0IiwiQUdFTlRfQ09MT1JfVE9fVEhFTUVfQ09MT1IiLCJBR0VOVF9DT0xPUlMiLCJBZ2VudENvbG9yTmFtZSIsIlByb21wdElucHV0TW9kZSIsImdldFRlYW1tYXRlQ29sb3IiLCJUaGVtZSIsImlzQWdlbnRTd2FybXNFbmFibGVkIiwiUHJvcHMiLCJtb2RlIiwiaXNMb2FkaW5nIiwidmlld2luZ0FnZW50TmFtZSIsInZpZXdpbmdBZ2VudENvbG9yIiwiZ2V0VGVhbW1hdGVUaGVtZUNvbG9yIiwidW5kZWZpbmVkIiwiY29sb3JOYW1lIiwiaW5jbHVkZXMiLCJQcm9tcHRDaGFyUHJvcHMiLCJ0aGVtZUNvbG9yIiwiUHJvbXB0Q2hhciIsInQwIiwiJCIsIl9jIiwidGVhbW1hdGVDb2xvciIsImNvbG9yIiwidDEiLCJwb2ludGVyIiwiUHJvbXB0SW5wdXRNb2RlSW5kaWNhdG9yIiwiU3ltYm9sIiwiZm9yIiwidmlld2VkVGVhbW1hdGVUaGVtZUNvbG9yIiwidDIiXSwic291cmNlcyI6WyJQcm9tcHRJbnB1dE1vZGVJbmRpY2F0b3IudHN4Il0sInNvdXJjZXNDb250ZW50IjpbImltcG9ydCBmaWd1cmVzIGZyb20gJ2ZpZ3VyZXMnXG5pbXBvcnQgKiBhcyBSZWFjdCBmcm9tICdyZWFjdCdcbmltcG9ydCB7IEJveCwgVGV4dCB9IGZyb20gJ3NyYy9pbmsuanMnXG5pbXBvcnQge1xuICBBR0VOVF9DT0xPUl9UT19USEVNRV9DT0xPUixcbiAgQUdFTlRfQ09MT1JTLFxuICB0eXBlIEFnZW50Q29sb3JOYW1lLFxufSBmcm9tICdzcmMvdG9vbHMvQWdlbnRUb29sL2FnZW50Q29sb3JNYW5hZ2VyLmpzJ1xuaW1wb3J0IHR5cGUgeyBQcm9tcHRJbnB1dE1vZGUgfSBmcm9tICdzcmMvdHlwZXMvdGV4dElucHV0VHlwZXMuanMnXG5pbXBvcnQgeyBnZXRUZWFtbWF0ZUNvbG9yIH0gZnJvbSAnc3JjL3V0aWxzL3RlYW1tYXRlLmpzJ1xuaW1wb3J0IHR5cGUgeyBUaGVtZSB9IGZyb20gJ3NyYy91dGlscy90aGVtZS5qcydcbmltcG9ydCB7IGlzQWdlbnRTd2FybXNFbmFibGVkIH0gZnJvbSAnLi4vLi4vdXRpbHMvYWdlbnRTd2FybXNFbmFibGVkLmpzJ1xuXG50eXBlIFByb3BzID0ge1xuICBtb2RlOiBQcm9tcHRJbnB1dE1vZGVcbiAgaXNMb2FkaW5nOiBib29sZWFuXG4gIHZpZXdpbmdBZ2VudE5hbWU/OiBzdHJpbmdcbiAgdmlld2luZ0FnZW50Q29sb3I/OiBBZ2VudENvbG9yTmFtZVxufVxuXG4vKipcbiAqIEdldHMgdGhlIHRoZW1lIGNvbG9yIGtleSBmb3IgdGhlIHRlYW1tYXRlJ3MgYXNzaWduZWQgY29sb3IuXG4gKiBSZXR1cm5zIHVuZGVmaW5lZCBpZiBub3QgYSB0ZWFtbWF0ZSBvciBpZiB0aGUgY29sb3IgaXMgaW52YWxpZC5cbiAqL1xuZnVuY3Rpb24gZ2V0VGVhbW1hdGVUaGVtZUNvbG9yKCk6IGtleW9mIFRoZW1lIHwgdW5kZWZpbmVkIHtcbiAgaWYgKCFpc0FnZW50U3dhcm1zRW5hYmxlZCgpKSB7XG4gICAgcmV0dXJuIHVuZGVmaW5lZFxuICB9XG4gIGNvbnN0IGNvbG9yTmFtZSA9IGdldFRlYW1tYXRlQ29sb3IoKVxuICBpZiAoIWNvbG9yTmFtZSkge1xuICAgIHJldHVybiB1bmRlZmluZWRcbiAgfVxuICBpZiAoQUdFTlRfQ09MT1JTLmluY2x1ZGVzKGNvbG9yTmFtZSBhcyBBZ2VudENvbG9yTmFtZSkpIHtcbiAgICByZXR1cm4gQUdFTlRfQ09MT1JfVE9fVEhFTUVfQ09MT1JbY29sb3JOYW1lIGFzIEFnZW50Q29sb3JOYW1lXVxuICB9XG4gIHJldHVybiB1bmRlZmluZWRcbn1cblxudHlwZSBQcm9tcHRDaGFyUHJvcHMgPSB7XG4gIGlzTG9hZGluZzogYm9vbGVhblxuICAvLyBEZWFkIGNvZGUgZWxpbWluYXRpb246IHBhcmFtZXRlciBuYW1lZCB0aGVtZUNvbG9yIHRvIGF2b2lkIFwidGVhbW1hdGVcIiBzdHJpbmcgaW4gZXh0ZXJuYWwgYnVpbGRzXG4gIHRoZW1lQ29sb3I/OiBrZXlvZiBUaGVtZVxufVxuXG4vKipcbiAqIFJlbmRlcnMgdGhlIHByb21wdCBjaGFyYWN0ZXIgKOKdrykuXG4gKiBUZWFtbWF0ZSBjb2xvciBvdmVycmlkZXMgdGhlIGRlZmF1bHQgY29sb3Igd2hlbiBzZXQuXG4gKi9cbmZ1bmN0aW9uIFByb21wdENoYXIoe1xuICBpc0xvYWRpbmcsXG4gIHRoZW1lQ29sb3IsXG59OiBQcm9tcHRDaGFyUHJvcHMpOiBSZWFjdC5SZWFjdE5vZGUge1xuICAvLyBBc3NpZ24gdG8gb3JpZ2luYWwgbmFtZSBmb3IgY2xhcml0eSB3aXRoaW4gdGhlIGZ1bmN0aW9uXG4gIGNvbnN0IHRlYW1tYXRlQ29sb3IgPSB0aGVtZUNvbG9yXG4gIGNvbnN0IGlzQW50ID0gXCJleHRlcm5hbFwiID09PSAnYW50J1xuICBjb25zdCBjb2xvciA9IHRlYW1tYXRlQ29sb3IgPz8gKGlzQW50ID8gJ3N1YnRsZScgOiB1bmRlZmluZWQpXG5cbiAgcmV0dXJuIChcbiAgICA8VGV4dCBjb2xvcj17Y29sb3J9IGRpbUNvbG9yPXtpc0xvYWRpbmd9PlxuICAgICAge2ZpZ3VyZXMucG9pbnRlcn0mbmJzcDtcbiAgICA8L1RleHQ+XG4gIClcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIFByb21wdElucHV0TW9kZUluZGljYXRvcih7XG4gIG1vZGUsXG4gIGlzTG9hZGluZyxcbiAgdmlld2luZ0FnZW50TmFtZSxcbiAgdmlld2luZ0FnZW50Q29sb3IsXG59OiBQcm9wcyk6IFJlYWN0LlJlYWN0Tm9kZSB7XG4gIGNvbnN0IHRlYW1tYXRlQ29sb3IgPSBnZXRUZWFtbWF0ZVRoZW1lQ29sb3IoKVxuXG4gIC8vIENvbnZlcnQgdmlld2VkIHRlYW1tYXRlJ3MgY29sb3IgdG8gdGhlbWUgY29sb3JcbiAgLy8gRmFsbHMgYmFjayB0byBQcm9tcHRDaGFyJ3MgZGVmYXVsdCAoc3VidGxlIGZvciBhbnRzLCB1bmRlZmluZWQgZm9yIGV4dGVybmFsKVxuICBjb25zdCB2aWV3ZWRUZWFtbWF0ZVRoZW1lQ29sb3IgPSB2aWV3aW5nQWdlbnRDb2xvclxuICAgID8gQUdFTlRfQ09MT1JfVE9fVEhFTUVfQ09MT1Jbdmlld2luZ0FnZW50Q29sb3JdXG4gICAgOiB1bmRlZmluZWRcblxuICByZXR1cm4gKFxuICAgIDxCb3hcbiAgICAgIGFsaWduSXRlbXM9XCJmbGV4LXN0YXJ0XCJcbiAgICAgIGFsaWduU2VsZj1cImZsZXgtc3RhcnRcIlxuICAgICAgZmxleFdyYXA9XCJub3dyYXBcIlxuICAgICAganVzdGlmeUNvbnRlbnQ9XCJmbGV4LXN0YXJ0XCJcbiAgICA+XG4gICAgICB7dmlld2luZ0FnZW50TmFtZSA/IChcbiAgICAgICAgLy8gVXNlIHRlYW1tYXRlJ3MgY29sb3Igb24gdGhlIHN0YW5kYXJkIHByb21wdCBjaGFyYWN0ZXIsIG1hdGNoaW5nIGVzdGFibGlzaGVkIHN0eWxlXG4gICAgICAgIDxQcm9tcHRDaGFyXG4gICAgICAgICAgaXNMb2FkaW5nPXtpc0xvYWRpbmd9XG4gICAgICAgICAgdGhlbWVDb2xvcj17dmlld2VkVGVhbW1hdGVUaGVtZUNvbG9yfVxuICAgICAgICAvPlxuICAgICAgKSA6IG1vZGUgPT09ICdiYXNoJyA/IChcbiAgICAgICAgPFRleHQgY29sb3I9XCJiYXNoQm9yZGVyXCIgZGltQ29sb3I9e2lzTG9hZGluZ30+XG4gICAgICAgICAgISZuYnNwO1xuICAgICAgICA8L1RleHQ+XG4gICAgICApIDogKFxuICAgICAgICA8UHJvbXB0Q2hhclxuICAgICAgICAgIGlzTG9hZGluZz17aXNMb2FkaW5nfVxuICAgICAgICAgIHRoZW1lQ29sb3I9e2lzQWdlbnRTd2FybXNFbmFibGVkKCkgPyB0ZWFtbWF0ZUNvbG9yIDogdW5kZWZpbmVkfVxuICAgICAgICAvPlxuICAgICAgKX1cbiAgICA8L0JveD5cbiAgKVxufVxuIl0sIm1hcHBpbmdzIjoiO0FBQUEsT0FBT0EsT0FBTyxNQUFNLFNBQVM7QUFDN0IsT0FBTyxLQUFLQyxLQUFLLE1B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
