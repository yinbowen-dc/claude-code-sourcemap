/**
 * FastIcon.tsx — 快速模式图标组件
 *
 * 在 Claude Code 系统流程中的位置：
 *   提示输入层 → 状态指示 → 快速模式（Fast Mode）图标展示
 *
 * 主要功能：
 *   1. FastIcon：React 组件，在 Ink 终端 UI 中渲染闪电符号（⚡），
 *      用于直观标识当前是否处于 Fast Mode（快速模式）。
 *   2. getFastIconString：非 React 上下文（如纯字符串输出场景）使用的版本，
 *      通过 chalk 直接输出带颜色/暗色的闪电符号字符串。
 *
 * cooldown（冷却）状态：限速期间图标变暗（dim + promptBorder 颜色），
 * 正常快速模式：使用 fastMode 主题色高亮显示。
 */
import { c as _c } from "react/compiler-runtime";
import chalk from 'chalk';
import * as React from 'react';
import { LIGHTNING_BOLT } from '../constants/figures.js';
import { Text } from '../ink.js';
import { getGlobalConfig } from '../utils/config.js';
import { resolveThemeSetting } from '../utils/systemTheme.js';
import { color } from './design-system/color.js';

// 组件 Props 类型定义：cooldown 为可选布尔值，表示是否处于冷却限速状态
type Props = {
  cooldown?: boolean;
};

/**
 * FastIcon 组件
 *
 * 整体流程：
 *   - 接收 cooldown prop，决定图标渲染风格
 *   - 利用 React 编译器运行时（_c）进行记忆化缓存，避免无关渲染
 *   - cooldown=true → 渲染暗色 promptBorder 颜色的闪电，表示冷却中
 *   - cooldown=false/undefined → 渲染 fastMode 颜色的闪电，表示快速模式激活
 *
 * 在系统中的角色：
 *   作为提示区状态徽标嵌入输入框旁，给用户快速的视觉反馈。
 */
export function FastIcon(t0) {
  // _c(2)：初始化大小为 2 的 React 编译器记忆缓存槽
  const $ = _c(2);
  const {
    cooldown
  } = t0;

  // 冷却状态分支：渲染暗色（dimColor）的 promptBorder 色闪电图标
  if (cooldown) {
    let t1;
    // 检查缓存槽 $[0] 是否尚未初始化（sentinel 值）
    if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
      // 首次渲染：创建 JSX 并存入缓存，后续直接复用
      t1 = <Text color="promptBorder" dimColor={true}>{LIGHTNING_BOLT}</Text>;
      $[0] = t1;
    } else {
      // 缓存命中：直接取出上次渲染结果，跳过重新创建
      t1 = $[0];
    }
    return t1;
  }

  // 正常快速模式分支：渲染 fastMode 主题色的闪电图标
  let t1;
  // 检查缓存槽 $[1] 是否尚未初始化
  if ($[1] === Symbol.for("react.memo_cache_sentinel")) {
    // 首次渲染：创建并缓存 JSX
    t1 = <Text color="fastMode">{LIGHTNING_BOLT}</Text>;
    $[1] = t1;
  } else {
    // 缓存命中：复用已有渲染结果
    t1 = $[1];
  }
  return t1;
}

/**
 * getFastIconString
 *
 * 整体流程：
 *   - 适用于非 React 上下文（例如：日志输出、纯文本标题栏）
 *   - applyColor=false → 直接返回原始闪电符号，无颜色
 *   - applyColor=true → 读取全局配置的主题名，通过 color() 工厂函数获取对应颜色函数，
 *     再将 LIGHTNING_BOLT 字符着色后返回
 *   - cooldown=true → 在颜色基础上再叠加 chalk.dim 使图标变暗
 *
 * 在系统中的角色：
 *   供标题栏字符串拼接、测试快照或其他纯文本场景使用，
 *   与 FastIcon 组件保持视觉一致性。
 */
export function getFastIconString(applyColor = true, cooldown = false): string {
  // 不需要颜色时直接返回原始符号（如测试或纯文本环境）
  if (!applyColor) {
    return LIGHTNING_BOLT;
  }

  // 读取全局配置中的主题设置，解析为规范主题名称（如 'dark'/'light'）
  const themeName = resolveThemeSetting(getGlobalConfig().theme);

  // 冷却状态：使用 promptBorder 颜色 + chalk.dim 使图标变暗
  if (cooldown) {
    return chalk.dim(color('promptBorder', themeName)(LIGHTNING_BOLT));
  }

  // 正常快速模式：使用 fastMode 主题颜色高亮图标
  return color('fastMode', themeName)(LIGHTNING_BOLT);
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJjaGFsayIsIlJlYWN0IiwiTElHSFROSU5HX0JPTFQiLCJUZXh0IiwiZ2V0R2xvYmFsQ29uZmlnIiwicmVzb2x2ZVRoZW1lU2V0dGluZyIsImNvbG9yIiwiUHJvcHMiLCJjb29sZG93biIsIkZhc3RJY29uIiwidDAiLCIkIiwiX2MiLCJ0MSIsIlN5bWJvbCIsImZvciIsImdldEZhc3RJY29uU3RyaW5nIiwiYXBwbHlDb2xvciIsInRoZW1lTmFtZSIsInRoZW1lIiwiZGltIl0sInNvdXJjZXMiOlsiRmFzdEljb24udHN4Il0sInNvdXJjZXNDb250ZW50IjpbImltcG9ydCBjaGFsayBmcm9tICdjaGFsaydcbmltcG9ydCAqIGFzIFJlYWN0IGZyb20gJ3JlYWN0J1xuaW1wb3J0IHsgTElHSFROSU5HX0JPTFQgfSBmcm9tICcuLi9jb25zdGFudHMvZmlndXJlcy5qcydcbmltcG9ydCB7IFRleHQgfSBmcm9tICcuLi9pbmsuanMnXG5pbXBvcnQgeyBnZXRHbG9iYWxDb25maWcgfSBmcm9tICcuLi91dGlscy9jb25maWcuanMnXG5pbXBvcnQgeyByZXNvbHZlVGhlbWVTZXR0aW5nIH0gZnJvbSAnLi4vdXRpbHMvc3lzdGVtVGhlbWUuanMnXG5pbXBvcnQgeyBjb2xvciB9IGZyb20gJy4vZGVzaWduLXN5c3RlbS9jb2xvci5qcydcblxudHlwZSBQcm9wcyA9IHtcbiAgY29vbGRvd24/OiBib29sZWFuXG59XG5cbmV4cG9ydCBmdW5jdGlvbiBGYXN0SWNvbih7IGNvb2xkb3duIH06IFByb3BzKTogUmVhY3QuUmVhY3ROb2RlIHtcbiAgaWYgKGNvb2xkb3duKSB7XG4gICAgcmV0dXJuIChcbiAgICAgIDxUZXh0IGNvbG9yPVwicHJvbXB0Qm9yZGVyXCIgZGltQ29sb3I+XG4gICAgICAgIHtMSUdIVE5JTkdfQk9MVH1cbiAgICAgIDwvVGV4dD5cbiAgICApXG4gIH1cbiAgcmV0dXJuIDxUZXh0IGNvbG9yPVwiZmFzdE1vZGVcIj57TElHSFROSU5HX0JPTFR9PC9UZXh0PlxufVxuXG5leHBvcnQgZnVuY3Rpb24gZ2V0RmFzdEljb25TdHJpbmcoYXBwbHlDb2xvciA9IHRydWUsIGNvb2xkb3duID0gZmFsc2UpOiBzdHJpbmcge1xuICBpZiAoIWFwcGx5Q29sb3IpIHtcbiAgICByZXR1cm4gTElHSFROSU5HX0JPTFRcbiAgfVxuICBjb25zdCB0aGVtZU5hbWUgPSByZXNvbHZlVGhlbWVTZXR0aW5nKGdldEdsb2JhbENvbmZpZygpLnRoZW1lKVxuICBpZiAoY29vbGRvd24pIHtcbiAgICByZXR1cm4gY2hhbGsuZGltKGNvbG9yKCdwcm9tcHRCb3JkZXInLCB0aGVtZU5hbWUpKExJR0hUTklOR19CT0xUKSlcbiAgfVxuICByZXR1cm4gY29sb3IoJ2Zhc3RNb2RlJywgdGhlbWVOYW1lKShMSUdIVE5JTkdfQk9MVClcbn1cbiJdLCJtYXBwaW5ncyI6IjtBQUFBLE9BQU9BLEtBQUssTUFBTSxPQUFPO0FBQ3pCLE9BQU8sS0FBS0MsS0FBSyxNQUFNLE9BQU87QUFDOUIsU0FBU0MsY0FBYyxRQUFRLHlCQUF5QjtBQUN4RCxTQUFTQyxJQUFJLFFBQVEsV0FBVztBQUNoQyxTQUFTQyxlQUFlLFFBQVEsb0JBQW9CO0FBQ3BELFNBQVNDLG1CQUFtQixRQUFRLHlCQUF5QjtBQUM3RCxTQUFTQyxLQUFLLFFBQVEsMEJBQTBCO0FBRWhELEtBQUtDLEtBQUssR0FBRztFQUNYQyxRQUFRLENBQUMsRUFBRSxPQUFPO0FBQ3BCLENBQUM7QUFFRCxPQUFPLFNBQUFDLFNBQUFDLEVBQUE7RUFBQSxNQUFBQyxDQUFBLEdBQUFDLEVBQUE7RUFBa0I7SUFBQUo7RUFBQSxJQUFBRSxFQUFtQjtFQUMxQyxJQUFJRixRQUFRO0lBQUEsSUFBQUssRUFBQTtJQUFBLElBQUFGLENBQUEsUUFBQUcsTUFBQSxDQUFBQyxHQUFBO01BRVJGLEVBQUEsSUFBQyxJQUFJLENBQU8sS0FBYyxDQUFkLGNBQWMsQ0FBQyxRQUFRLENBQVIsS0FBTyxDQUFDLENBQ2hDWCxlQUFhLENBQ2hCLEVBRkMsSUFBSSxDQUVFO01BQUFTLENBQUEsTUFBQUUsRUFBQTtJQUFBO01BQUFBLEVBQUEsR0FBQUYsQ0FBQTtJQUFBO0lBQUEsT0FGUEUsRUFFTztFQUFBO0VBRVYsSUFBQUEsRUFBQTtFQUFBLElBQUFGLENBQUEsUUFBQUcsTUFBQSxDQUFBQyxHQUFBO0lBQ01GLEVBQUEsSUFBQyxJQUFJLENBQU8sS0FBVSxDQUFWLFVBQVUsQ0FBRVgsZUFBYSxDQUFFLEVBQXRDLElBQUksQ0FBeUM7SUFBQVMsQ0FBQSxNQUFBRSxFQUFBO0VBQUE7SUFBQUEsRUFBQSxHQUFBRixDQUFBO0VBQUE7RUFBQSxPQUE5Q0UsRUFBOEM7QUFBQTtBQUd2RCxPQUFPLFNBQVNHLGlCQUFpQkEsQ0FBQ0MsVUFBVSxHQUFHLElBQUksRUFBRVQsUUFBUSxHQUFHLEtBQUssQ0FBQyxFQUFFLE1BQU0sQ0FBQztFQUM3RSxJQUFJLENBQUNTLFVBQVUsRUFBRTtJQUNmLE9BQU9mLGNBQWM7RUFDdkI7RUFDQSxNQUFNZ0IsU0FBUyxHQUFHYixtQkFBbUIsQ0FBQ0QsZUFBZSxDQUFDLENBQUMsQ0FBQ2UsS0FBSyxDQUFDO0VBQzlELElBQUlYLFFBQVEsRUFBRTtJQUNaLE9BQU9SLEtBQUssQ0FBQ29CLEdBQUcsQ0FBQ2QsS0FBSyxDQUFDLGNBQWMsRUFBRVksU0FBUyxDQUFDLENBQUNoQixjQUFjLENBQUMsQ0FBQztFQUNwRTtFQUNBLE9BQU9JLEtBQUssQ0FBQyxVQUFVLEVBQUVZLFNBQVMsQ0FBQyxDQUFDaEIsY0FBYyxDQUFDO0FBQ3JEIiwiaWdub3JlTGlzdCI6W119
