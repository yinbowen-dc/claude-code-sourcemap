/**
 * 【文件概述】AnimatedAsterisk.tsx
 *
 * 在 Claude Code 系统流程中的位置：
 *   欢迎屏幕（LogoV2）→ 通知类组件（VoiceModeNotice / Opus1mMergeNotice 等）
 *   → 本组件（带动画的星号字符）
 *
 * 主要职责：
 *   渲染一个带彩虹色扫描动画的星号字符。动画完成后静止显示为灰色。
 *   用于在通知条目前面吸引用户注意力。
 *
 * 动画参数：
 *   - SWEEP_DURATION_MS = 1500ms：单次彩虹色扫描时长
 *   - SWEEP_COUNT = 2：扫描次数
 *   - TOTAL_ANIMATION_MS = 3000ms：总动画时长
 *   - SETTLED_GREY：动画结束后的静止灰色（RGB 153,153,153）
 *
 * 关键设计：
 *   - 使用 useRef 保存动画开始时刻，确保色相从 0 起始（不受挂载时机影响）
 *   - 使用 useAnimationFrame（视口感知）防止进入 scrollback 后持续闪烁
 *   - 尊重 prefersReducedMotion 设置，若开启则跳过动画直接显示静止灰色
 */
import * as React from 'react';
import { useEffect, useRef, useState } from 'react';
import { TEARDROP_ASTERISK } from '../../constants/figures.js';
import { Box, Text, useAnimationFrame } from '../../ink.js';
import { getInitialSettings } from '../../utils/settings/settings.js';
import { hueToRgb, toRGBColor } from '../Spinner/utils.js';

// 单次彩虹色扫描持续时间（毫秒）
const SWEEP_DURATION_MS = 1500;
// 扫描次数
const SWEEP_COUNT = 2;
// 总动画时长 = 单次扫描时长 × 扫描次数
const TOTAL_ANIMATION_MS = SWEEP_DURATION_MS * SWEEP_COUNT;
// 动画结束后的静止颜色：中性灰（153, 153, 153）
const SETTLED_GREY = toRGBColor({
  r: 153,
  g: 153,
  b: 153
});

/**
 * AnimatedAsterisk — 彩虹扫描动画星号组件
 *
 * Props：
 *   char — 要显示的字符，默认为 TEARDROP_ASTERISK（✻）
 *
 * 整体流程：
 *   1. 挂载时读取一次 prefersReducedMotion 设置
 *      - 若已设置减弱动画，则直接进入"完成"状态（跳过动画）
 *   2. done 状态控制两条渲染路径：
 *      - done=true：渲染静止灰色星号
 *      - done=false：按当前帧时间计算色相，渲染彩虹色星号
 *   3. useEffect 在 done=false 时设置定时器，TOTAL_ANIMATION_MS 后将 done 设为 true
 *   4. useAnimationFrame(done ? null : 50)：
 *      - done=false 时每 50ms 触发一帧更新色相
 *      - done=true 时传 null 停止动画（防止进入 scrollback 后依然刷新）
 *   5. ref 绑定到 Box，使 useAnimationFrame 的视口感知能检测元素是否在屏幕内
 */
export function AnimatedAsterisk({
  char = TEARDROP_ASTERISK // 默认使用泪滴星号字符
}: {
  char?: string;
}): React.ReactNode {
  // 挂载时一次性读取减弱动画设置，不订阅后续变更（避免设置变更时触发重渲染）
  const [reducedMotion] = useState(() => getInitialSettings().prefersReducedMotion ?? false);

  // done 状态：reducedMotion 为 true 时直接初始化为 true（跳过动画）
  const [done, setDone] = useState(reducedMotion);

  // 记录本组件动画开始时的时间戳
  // useAnimationFrame 的时钟是全局共享的，需要记录相对起点以确保色相从 0 开始
  const startTimeRef = useRef<number | null>(null);

  // 绑定视口感知动画帧：done=true 时传 null 停止；done=false 时以 50ms 间隔刷新
  // ref 用于让 Ink 的视口检测知道此元素位置，进入 scrollback 后自动暂停动画
  const [ref, time] = useAnimationFrame(done ? null : 50);

  // 动画完成计时器：在 TOTAL_ANIMATION_MS 后将 done 设为 true
  useEffect(() => {
    if (done) return; // 已完成（或 reducedMotion 模式）则无需设置计时器
    const t = setTimeout(setDone, TOTAL_ANIMATION_MS, true);
    return () => clearTimeout(t); // 组件卸载时清除定时器
  }, [done]);

  // 渲染路径 1：动画已完成，显示静止灰色星号
  if (done) {
    return <Box ref={ref}>
        <Text color={SETTLED_GREY}>{char}</Text>
      </Box>;
  }

  // 首帧：记录动画开始时间（以当前帧时间为基准）
  if (startTimeRef.current === null) {
    startTimeRef.current = time;
  }

  // 计算自动画开始以来经过的时间（毫秒）
  const elapsed = time - startTimeRef.current;

  // 将 elapsed 映射为 0–360 的色相值（HSV 色相循环）
  // elapsed / SWEEP_DURATION_MS 得到扫描进度（0→1→2…），× 360 得到色相，% 360 循环
  const hue = elapsed / SWEEP_DURATION_MS * 360 % 360;

  // 渲染路径 2：动画进行中，根据当前色相渲染彩虹色星号
  return <Box ref={ref}>
      <Text color={toRGBColor(hueToRgb(hue))}>{char}</Text>
    </Box>;
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJSZWFjdCIsInVzZUVmZmVjdCIsInVzZVJlZiIsInVzZVN0YXRlIiwiVEVBUkRST1BfQVNURVJJU0siLCJCb3giLCJUZXh0IiwidXNlQW5pbWF0aW9uRnJhbWUiLCJnZXRJbml0aWFsU2V0dGluZ3MiLCJodWVUb1JnYiIsInRvUkdCQ29sb3IiLCJTV0VFUF9EVVJBVElPTl9NUyIsIlNXRUVQX0NPVU5UIiwiVE9UQUxfQU5JTUFUSU9OX01TIiwiU0VUVExFRF9HUkVZIiwiciIsImciLCJiIiwiQW5pbWF0ZWRBc3RlcmlzayIsImNoYXIiLCJSZWFjdE5vZGUiLCJyZWR1Y2VkTW90aW9uIiwicHJlZmVyc1JlZHVjZWRNb3Rpb24iLCJkb25lIiwic2V0RG9uZSIsInN0YXJ0VGltZVJlZiIsInJlZiIsInRpbWUiLCJ0Iiwic2V0VGltZW91dCIsImNsZWFyVGltZW91dCIsImN1cnJlbnQiLCJlbGFwc2VkIiwiaHVlIl0sInNvdXJjZXMiOlsiQW5pbWF0ZWRBc3Rlcmlzay50c3giXSwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0ICogYXMgUmVhY3QgZnJvbSAncmVhY3QnXG5pbXBvcnQgeyB1c2VFZmZlY3QsIHVzZVJlZiwgdXNlU3RhdGUgfSBmcm9tICdyZWFjdCdcbmltcG9ydCB7IFRFQVJEUk9QX0FTVEVSSVNLIH0gZnJvbSAnLi4vLi4vY29uc3RhbnRzL2ZpZ3VyZXMuanMnXG5pbXBvcnQgeyBCb3gsIFRleHQsIHVzZUFuaW1hdGlvbkZyYW1lIH0gZnJvbSAnLi4vLi4vaW5rLmpzJ1xuaW1wb3J0IHsgZ2V0SW5pdGlhbFNldHRpbmdzIH0gZnJvbSAnLi4vLi4vdXRpbHMvc2V0dGluZ3Mvc2V0dGluZ3MuanMnXG5pbXBvcnQgeyBodWVUb1JnYiwgdG9SR0JDb2xvciB9IGZyb20gJy4uL1NwaW5uZXIvdXRpbHMuanMnXG5cbmNvbnN0IFNXRUVQX0RVUkFUSU9OX01TID0gMTUwMFxuY29uc3QgU1dFRVBfQ09VTlQgPSAyXG5jb25zdCBUT1RBTF9BTklNQVRJT05fTVMgPSBTV0VFUF9EVVJBVElPTl9NUyAqIFNXRUVQX0NPVU5UXG5jb25zdCBTRVRUTEVEX0dSRVkgPSB0b1JHQkNvbG9yKHsgcjogMTUzLCBnOiAxNTMsIGI6IDE1MyB9KVxuXG5leHBvcnQgZnVuY3Rpb24gQW5pbWF0ZWRBc3Rlcmlzayh7XG4gIGNoYXIgPSBURUFSRFJPUF9BU1RFUklTSyxcbn06IHtcbiAgY2hhcj86IHN0cmluZ1xufSk6IFJlYWN0LlJlYWN0Tm9kZSB7XG4gIC8vIFJlYWQgcHJlZmVyc1JlZHVjZWRNb3Rpb24gb25jZSBhdCBtb3VudCDigJQgbm8gdXNlU2V0dGluZ3MoKSBzdWJzY3JpcHRpb24sXG4gIC8vIHNpbmNlIHRoYXQgd291bGQgcmUtcmVuZGVyIHdoZW5ldmVyIHNldHRpbmdzIGNoYW5nZS5cbiAgY29uc3QgW3JlZHVjZWRNb3Rpb25dID0gdXNlU3RhdGUoXG4gICAgKCkgPT4gZ2V0SW5pdGlhbFNldHRpbmdzKCkucHJlZmVyc1JlZHVjZWRNb3Rpb24gPz8gZmFsc2UsXG4gIClcbiAgY29uc3QgW2RvbmUsIHNldERvbmVdID0gdXNlU3RhdGUocmVkdWNlZE1vdGlvbilcbiAgLy8gdXNlQW5pbWF0aW9uRnJhbWUncyBjbG9jayBpcyBzaGFyZWQg4oCUIGNhcHR1cmUgb3VyIHN0YXJ0IG9mZnNldCBzbyB0aGVcbiAgLy8gc3dlZXAgYWx3YXlzIGJlZ2lucyBhdCBodWUgMCByZWdhcmRsZXNzIG9mIHdoZW4gd2UgbW91bnQuXG4gIGNvbnN0IHN0YXJ0VGltZVJlZiA9IHVzZVJlZjxudW1iZXIgfCBudWxsPihudWxsKVxuICAvLyBXaXJlIHRoZSByZWYgc28gdXNlQW5pbWF0aW9uRnJhbWUncyB2aWV3cG9ydC1wYXVzZSBraWNrcyBpbjogaWYgdGhlXG4gIC8vIHVzZXIgc3VibWl0cyBhIG1lc3NhZ2UgYmVmb3JlIHRoZSBzd2VlcCBmaW5pc2hlcywgdGhlIGNsb2NrIHN0b3BzXG4gIC8vIGF1dG9tYXRpY2FsbHkgb25jZSB0aGlzIHJvdyBlbnRlcnMgc2Nyb2xsYmFjayAocHJldmVudHMgZmxpY2tlcikuXG4gIGNvbnN0IFtyZWYsIHRpbWVdID0gdXNlQW5pbWF0aW9uRnJhbWUoZG9uZSA/IG51bGwgOiA1MClcblxuICB1c2VFZmZlY3QoKCkgPT4ge1xuICAgIGlmIChkb25lKSByZXR1cm5cbiAgICBjb25zdCB0ID0gc2V0VGltZW91dChzZXREb25lLCBUT1RBTF9BTklNQVRJT05fTVMsIHRydWUpXG4gICAgcmV0dXJuICgpID0+IGNsZWFyVGltZW91dCh0KVxuICB9LCBbZG9uZV0pXG5cbiAgaWYgKGRvbmUpIHtcbiAgICByZXR1cm4gKFxuICAgICAgPEJveCByZWY9e3JlZn0+XG4gICAgICAgIDxUZXh0IGNvbG9yPXtTRVRUTEVEX0dSRVl9PntjaGFyfTwvVGV4dD5cbiAgICAgIDwvQm94PlxuICAgIClcbiAgfVxuXG4gIGlmIChzdGFydFRpbWVSZWYuY3VycmVudCA9PT0gbnVsbCkge1xuICAgIHN0YXJ0VGltZVJlZi5jdXJyZW50ID0gdGltZVxuICB9XG4gIGNvbnN0IGVsYXBzZWQgPSB0aW1lIC0gc3RhcnRUaW1lUmVmLmN1cnJlbnRcbiAgY29uc3QgaHVlID0gKChlbGFwc2VkIC8gU1dFRVBfRFVSQVRJT05fTVMpICogMzYwKSAlIDM2MFxuXG4gIHJldHVybiAoXG4gICAgPEJveCByZWY9e3JlZn0+XG4gICAgICA8VGV4dCBjb2xvcj17dG9SR0JDb2xvcihodWVUb1JnYihodWUpKX0+e2NoYXJ9PC9UZXh0PlxuICAgIDwvQm94PlxuICApXG59XG4iXSwibWFwcGluZ3MiOiJBQUFBLE9BQU8sS0FBS0EsS0FBSyxNQUFNLE9BQU87QUFDOUIsU0FBU0MsU0FBUyxFQUFFQyxNQUFNLEVBQUVDLFFBQVEsUUFBUSxPQUFPO0FBQ25ELFNBQVNDLGlCQUFpQixRQUFRLDRCQUE0QjtBQUM5RCxTQUFTQyxHQUFHLEVBQUVDLElBQUksRUFBRUMsaUJBQWlCLFFBQVEsY0FBYztBQUMzRCxTQUFTQyxrQkFBa0IsUUFBUSxrQ0FBa0M7QUFDckUsU0FBU0MsUUFBUSxFQUFFQyxVQUFVLFFBQVEscUJBQXFCO0FBRTFELE1BQU1DLGlCQUFpQixHQUFHLElBQUk7QUFDOUIsTUFBTUMsV0FBVyxHQUFHLENBQUM7QUFDckIsTUFBTUMsa0JBQWtCLEdBQUdGLGlCQUFpQixHQUFHQyxXQUFXO0FBQzFELE1BQU1FLFlBQVksR0FBR0osVUFBVSxDQUFDO0VBQUVLLENBQUMsRUFBRSxHQUFHO0VBQUVDLENBQUMsRUFBRSxHQUFHO0VBQUVDLENBQUMsRUFBRTtBQUFJLENBQUMsQ0FBQztBQUUzRCxPQUFPLFNBQVNDLGdCQUFnQkEsQ0FBQztFQUMvQkMsSUFBSSxHQUFHZjtBQUdULENBRkMsRUFBRTtFQUNEZSxJQUFJLENBQUMsRUFBRSxNQUFNO0FBQ2YsQ0FBQyxDQUFDLEVBQUVuQixLQUFLLENBQUNvQixTQUFTLENBQUM7RUFDbEI7RUFDQTtFQUNBLE1BQU0sQ0FBQ0MsYUFBYSxDQUFDLEdBQUdsQixRQUFRLENBQzlCLE1BQU1LLGtCQUFrQixDQUFDLENBQUMsQ0FBQ2Msb0JBQW9CLElBQUksS0FDckQsQ0FBQztFQUNELE1BQU0sQ0FBQ0MsSUFBSSxFQUFFQyxPQUFPLENBQUMsR0FBR3JCLFFBQVEsQ0FBQ2tCLGFBQWEsQ0FBQztFQUMvQztFQUNBO0VBQ0EsTUFBTUksWUFBWSxHQUFHdkIsTUFBTSxDQUFDLE1BQU0sR0FBRyxJQUFJLENBQUMsQ0FBQyxJQUFJLENBQUM7RUFDaEQ7RUFDQTtFQUNBO0VBQ0EsTUFBTSxDQUFDd0IsR0FBRyxFQUFFQyxJQUFJLENBQUMsR0FBR3BCLGlCQUFpQixDQUFDZ0IsSUFBSSxHQUFHLElBQUksR0FBRyxFQUFFLENBQUM7RUFFdkR0QixTQUFTLENBQUMsTUFBTTtJQUNkLElBQUlzQixJQUFJLEVBQUU7SUFDVixNQUFNSyxDQUFDLEdBQUdDLFVBQVUsQ0FBQ0wsT0FBTyxFQUFFWCxrQkFBa0IsRUFBRSxJQUFJLENBQUM7SUFDdkQsT0FBTyxNQUFNaUIsWUFBWSxDQUFDRixDQUFDLENBQUM7RUFDOUIsQ0FBQyxFQUFFLENBQUNMLElBQUksQ0FBQyxDQUFDO0VBRVYsSUFBSUEsSUFBSSxFQUFFO0lBQ1IsT0FDRSxDQUFDLEdBQUcsQ0FBQyxHQUFHLENBQUMsQ0FBQ0csR0FBRyxDQUFDO0FBQ3BCLFFBQVEsQ0FBQyxJQUFJLENBQUMsS0FBSyxDQUFDLENBQUNaLFlBQVksQ0FBQyxDQUFDLENBQUNLLElBQUksQ0FBQyxFQUFFLElBQUk7QUFDL0MsTUFBTSxFQUFFLEdBQUcsQ0FBQztFQUVWO0VBRUEsSUFBSU0sWUFBWSxDQUFDTSxPQUFPLEtBQUssSUFBSSxFQUFFO0lBQ2pDTixZQUFZLENBQUNNLE9BQU8sR0FBR0osSUFBSTtFQUM3QjtFQUNBLE1BQU1LLE9BQU8sR0FBR0wsSUFBSSxHQUFHRixZQUFZLENBQUNNLE9BQU87RUFDM0MsTUFBTUUsR0FBRyxHQUFLRCxPQUFPLEdBQUdyQixpQkFBaUIsR0FBSSxHQUFHLEdBQUksR0FBRztFQUV2RCxPQUNFLENBQUMsR0FBRyxDQUFDLEdBQUcsQ0FBQyxDQUFDZSxHQUFHLENBQUM7QUFDbEIsTUFBTSxDQUFDLElBQUksQ0FBQyxLQUFLLENBQUMsQ0FBQ2hCLFVBQVUsQ0FBQ0QsUUFBUSxDQUFDd0IsR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUNkLElBQUksQ0FBQyxFQUFFLElBQUk7QUFDMUQsSUFBSSxFQUFFLEdBQUcsQ0FBQztBQUVWIiwiaWdub3JlTGlzdCI6W119
