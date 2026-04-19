/**
 * 【文件概述】AnimatedClawd.tsx
 *
 * 在 Claude Code 系统流程中的位置：
 *   欢迎界面（LogoV2） → 左侧吉祥物区域 → 本组件（可点击动画版 Clawd）
 *
 * 主要职责：
 *   渲染可交互的 Clawd 吉祥物。用户在全屏模式下点击时，
 *   随机触发两种点击动画之一：
 *     - JUMP_WAVE：蹲下 → 弹起（双臂高举），重复两次
 *     - LOOK_AROUND：向右看 → 向左看 → 回正
 *   容器高度固定为 CLAWD_HEIGHT=3，与普通 <Clawd /> 占位完全相同，
 *   动画过程中布局不会发生偏移。
 *
 * 与其他模块的关系：
 *   - 使用 Clawd 组件渲染具体姿势帧
 *   - 读取 getInitialSettings().prefersReducedMotion 决定是否禁用动画
 *   - 由 LogoV2 / WelcomeV2 等上层组件引用
 */
import { c as _c } from "react/compiler-runtime";
import * as React from 'react';
import { useEffect, useRef, useState } from 'react';
import { Box } from '../../ink.js';
import { getInitialSettings } from '../../utils/settings/settings.js';
import { Clawd, type ClawdPose } from './Clawd.js';

// 单帧数据结构：姿势 + 垂直偏移量
type Frame = {
  pose: ClawdPose;
  offset: number;
};

/**
 * hold — 生成连续 n 帧保持同一姿势的帧数组（每帧 60ms）
 *
 * 用法示例：
 *   hold('arms-up', 0, 3)  =>  [{ pose:'arms-up', offset:0 }, ×3]
 *
 * @param pose   目标姿势
 * @param offset marginTop 偏移量（0=正常，1=蹲下）
 * @param frames 帧数（持续时间 = frames × FRAME_MS）
 */
function hold(pose: ClawdPose, offset: number, frames: number): Frame[] {
  return Array.from({
    length: frames
  }, () => ({
    pose,
    offset
  }));
}

// offset 语义：容器固定高度 3，marginTop=1 时 Clawd 脚部行超出容器被截断，
// 视觉上呈现"蹲下钻入画面底部"的效果，弹起（offset=0）时恢复正常。

// 点击动画一：蹲下 → 弹起（双臂高举），共两次
const JUMP_WAVE: readonly Frame[] = [...hold('default', 1, 2),
// 蹲下
...hold('arms-up', 0, 3),
// 弹起！
...hold('default', 0, 1), ...hold('default', 1, 2),
// 再次蹲下
...hold('arms-up', 0, 3),
// 再次弹起！
...hold('default', 0, 1)];

// 点击动画二：向右看 → 向左看 → 回正
const LOOK_AROUND: readonly Frame[] = [...hold('look-right', 0, 5), ...hold('look-left', 0, 5), ...hold('default', 0, 1)];

// 所有可用的点击动画（随机选取）
const CLICK_ANIMATIONS: readonly (readonly Frame[])[] = [JUMP_WAVE, LOOK_AROUND];

// 静止帧：默认姿势，无偏移
const IDLE: Frame = {
  pose: 'default',
  offset: 0
};

// 每帧时长 60ms
const FRAME_MS = 60;

// frameIndex 递增函数（传给 setTimeout 作为参数，避免在 effect 内创建闭包）
const incrementFrame = (i: number) => i + 1;

// 容器固定高度（行数），与裸 <Clawd /> 占位一致
const CLAWD_HEIGHT = 3;

/**
 * AnimatedClawd — 可点击动画的 Clawd 吉祥物组件
 *
 * 整体流程：
 *   1. 调用 useClawdAnimation() 获取当前帧的 pose / bounceOffset / onClick
 *   2. 用 React Compiler _c(8) 缓存三层 JSX 节点，避免无关重渲染：
 *      - 槽 0-1：<Clawd pose={pose} />（pose 变化时重建）
 *      - 槽 2-4：内层 <Box marginTop={bounceOffset}>（bounceOffset 或 Clawd 节点变化时重建）
 *      - 槽 5-7：外层 <Box height={CLAWD_HEIGHT} onClick={onClick}>（onClick 或内层节点变化时重建）
 *   3. 容器高度固定，动画期间布局不偏移
 *
 * 注意：onClick 仅在终端鼠标追踪启用时（AlternateScreen / 全屏模式）才触发；
 * 非全屏时行为与普通 <Clawd /> 完全一致。
 */
export function AnimatedClawd() {
  // React Compiler 注入的 memoization 缓存，共 8 个槽位
  const $ = _c(8);

  // 从动画 Hook 中获取当前帧状态
  const {
    pose,
    bounceOffset,
    onClick
  } = useClawdAnimation();

  // ── 槽 0-1：Clawd 姿势节点 ─────────────────────────────────────────────
  // 只在 pose 变化时重建 <Clawd /> 节点
  let t0;
  if ($[0] !== pose) {
    t0 = <Clawd pose={pose} />;
    $[0] = pose;
    $[1] = t0;
  } else {
    t0 = $[1];
  }

  // ── 槽 2-4：内层 Box（负责垂直偏移动效）─────────────────────────────────
  // bounceOffset 或 Clawd 节点变化时重建
  let t1;
  if ($[2] !== bounceOffset || $[3] !== t0) {
    t1 = <Box marginTop={bounceOffset} flexShrink={0}>{t0}</Box>;
    $[2] = bounceOffset;
    $[3] = t0;
    $[4] = t1;
  } else {
    t1 = $[4];
  }

  // ── 槽 5-7：外层 Box（固定高度容器 + 点击事件）────────────────────────────
  // onClick 或内层节点变化时重建
  let t2;
  if ($[5] !== onClick || $[6] !== t1) {
    t2 = <Box height={CLAWD_HEIGHT} flexDirection="column" onClick={onClick}>{t1}</Box>;
    $[5] = onClick;
    $[6] = t1;
    $[7] = t2;
  } else {
    t2 = $[7];
  }

  // 返回外层容器节点
  return t2;
}

/**
 * useClawdAnimation — Clawd 动画逻辑 Hook
 *
 * 整体流程：
 *   1. 挂载时一次性读取 prefersReducedMotion 设置（不订阅变化，避免不必要重渲染）
 *   2. frameIndex 状态：-1 = 静止（空闲），≥0 = 动画播放中
 *   3. sequenceRef 持有当前动画帧序列引用
 *   4. onClick：在非简化运动模式且当前未播放动画时，随机选取一个动画序列并启动
 *   5. useEffect 监听 frameIndex：
 *      - frameIndex=-1：不处理
 *      - frameIndex≥序列长度：播放完毕，重置为 -1
 *      - 否则：设置 setTimeout(setFrameIndex, FRAME_MS, incrementFrame)
 *        → 每帧后自动推进到下一帧，cleanup 清除定时器防止内存泄漏
 *   6. 返回当前帧的 pose / bounceOffset / onClick
 */
function useClawdAnimation(): {
  pose: ClawdPose;
  bounceOffset: number;
  onClick: () => void;
} {
  // 挂载时一次性读取 prefersReducedMotion，不使用 useSettings() 订阅
  // 避免任何 settings 变更都触发此组件重渲染
  const [reducedMotion] = useState(() => getInitialSettings().prefersReducedMotion ?? false);

  // frameIndex: -1 = 静止（IDLE），≥0 = 当前动画帧索引
  const [frameIndex, setFrameIndex] = useState(-1);

  // sequenceRef: 持有当前正在播放的帧序列（避免 useEffect 闭包捕获旧序列）
  const sequenceRef = useRef<readonly Frame[]>(JUMP_WAVE);

  // onClick: 点击触发动画
  const onClick = () => {
    // 简化运动模式或正在播放时，忽略点击
    if (reducedMotion || frameIndex !== -1) return;
    // 随机选取一个点击动画并启动
    sequenceRef.current = CLICK_ANIMATIONS[Math.floor(Math.random() * CLICK_ANIMATIONS.length)]!;
    setFrameIndex(0);
  };

  // useEffect：逐帧推进动画
  useEffect(() => {
    // 静止状态，无需处理
    if (frameIndex === -1) return;
    // 播放完毕，重置为静止
    if (frameIndex >= sequenceRef.current.length) {
      setFrameIndex(-1);
      return;
    }
    // 设置定时器：FRAME_MS 后将 frameIndex+1
    // incrementFrame 是稳定引用，不会导致闭包问题
    const timer = setTimeout(setFrameIndex, FRAME_MS, incrementFrame);
    // cleanup：组件卸载或 frameIndex 再次变化时清除定时器
    return () => clearTimeout(timer);
  }, [frameIndex]);

  // 取出当前帧数据（越界或 -1 时回退到 IDLE 静止帧）
  const seq = sequenceRef.current;
  const current = frameIndex >= 0 && frameIndex < seq.length ? seq[frameIndex]! : IDLE;

  return {
    pose: current.pose,
    bounceOffset: current.offset,
    onClick
  };
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJSZWFjdCIsInVzZUVmZmVjdCIsInVzZVJlZiIsInVzZVN0YXRlIiwiQm94IiwiZ2V0SW5pdGlhbFNldHRpbmdzIiwiQ2xhd2QiLCJDbGF3ZFBvc2UiLCJGcmFtZSIsInBvc2UiLCJvZmZzZXQiLCJob2xkIiwiZnJhbWVzIiwiQXJyYXkiLCJmcm9tIiwibGVuZ3RoIiwiSlVNUF9XQVZFIiwiTE9PS19BUk9VTkQiLCJDTElDS19BTklNQVRJT05TIiwiSURMRSIsIkZSQU1FX01TIiwiaW5jcmVtZW50RnJhbWUiLCJpIiwiQ0xBV0RfSEVJR0hUIiwiQW5pbWF0ZWRDbGF3ZCIsIiQiLCJfYyIsImJvdW5jZU9mZnNldCIsIm9uQ2xpY2siLCJ1c2VDbGF3ZEFuaW1hdGlvbiIsInQwIiwidDEiLCJ0MiIsInJlZHVjZWRNb3Rpb24iLCJwcmVmZXJzUmVkdWNlZE1vdGlvbiIsImZyYW1lSW5kZXgiLCJzZXRGcmFtZUluZGV4Iiwic2VxdWVuY2VSZWYiLCJjdXJyZW50IiwiTWF0aCIsImZsb29yIiwicmFuZG9tIiwidGltZXIiLCJzZXRUaW1lb3V0IiwiY2xlYXJUaW1lb3V0Iiwic2VxIl0sInNvdXJjZXMiOlsiQW5pbWF0ZWRDbGF3ZC50c3giXSwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0ICogYXMgUmVhY3QgZnJvbSAncmVhY3QnXG5pbXBvcnQgeyB1c2VFZmZlY3QsIHVzZVJlZiwgdXNlU3RhdGUgfSBmcm9tICdyZWFjdCdcbmltcG9ydCB7IEJveCB9IGZyb20gJy4uLy4uL2luay5qcydcbmltcG9ydCB7IGdldEluaXRpYWxTZXR0aW5ncyB9IGZyb20gJy4uLy4uL3V0aWxzL3NldHRpbmdzL3NldHRpbmdzLmpzJ1xuaW1wb3J0IHsgQ2xhd2QsIHR5cGUgQ2xhd2RQb3NlIH0gZnJvbSAnLi9DbGF3ZC5qcydcblxudHlwZSBGcmFtZSA9IHsgcG9zZTogQ2xhd2RQb3NlOyBvZmZzZXQ6IG51bWJlciB9XG5cbi8qKiBIb2xkIGEgcG9zZSBmb3IgbiBmcmFtZXMgKDYwbXMgZWFjaCkuICovXG5mdW5jdGlvbiBob2xkKHBvc2U6IENsYXdkUG9zZSwgb2Zmc2V0OiBudW1iZXIsIGZyYW1lczogbnVtYmVyKTogRnJhbWVbXSB7XG4gIHJldHVybiBBcnJheS5mcm9tKHsgbGVuZ3RoOiBmcmFtZXMgfSwgKCkgPT4gKHsgcG9zZSwgb2Zmc2V0IH0pKVxufVxuXG4vLyBPZmZzZXQgc2VtYW50aWNzOiBtYXJnaW5Ub3AgaW4gYSBmaXhlZC1oZWlnaHQtMyBjb250YWluZXIuIDAgPSBub3JtYWwsXG4vLyAxID0gY3JvdWNoZWQuIENvbnRhaW5lciBoZWlnaHQgc3RheXMgMyBzbyB0aGUgbGF5b3V0IG5ldmVyIHNoaWZ0czsgZHVyaW5nXG4vLyBhIGNyb3VjaCAob2Zmc2V0PTEpIENsYXdkJ3MgZmVldCByb3cgZGlwcyBiZWxvdyB0aGUgY29udGFpbmVyIGFuZCBnZXRzXG4vLyBjbGlwcGVkIOKAlCByZWFkcyBhcyBcImR1Y2tpbmcgYmVsb3cgdGhlIGZyYW1lXCIgYmVmb3JlIHNwcmluZ2luZyBiYWNrIHVwLlxuXG4vLyBDbGljayBhbmltYXRpb246IGNyb3VjaCwgdGhlbiBzcHJpbmcgdXAgd2l0aCBib3RoIGFybXMgcmFpc2VkLiBUd2ljZS5cbmNvbnN0IEpVTVBfV0FWRTogcmVhZG9ubHkgRnJhbWVbXSA9IFtcbiAgLi4uaG9sZCgnZGVmYXVsdCcsIDEsIDIpLCAvLyBjcm91Y2hcbiAgLi4uaG9sZCgnYXJtcy11cCcsIDAsIDMpLCAvLyBzcHJpbmchXG4gIC4uLmhvbGQoJ2RlZmF1bHQnLCAwLCAxKSxcbiAgLi4uaG9sZCgnZGVmYXVsdCcsIDEsIDIpLCAvLyBjcm91Y2ggYWdhaW5cbiAgLi4uaG9sZCgnYXJtcy11cCcsIDAsIDMpLCAvLyBzcHJpbmchXG4gIC4uLmhvbGQoJ2RlZmF1bHQnLCAwLCAxKSxcbl1cblxuLy8gQ2xpY2sgYW5pbWF0aW9uOiBnbGFuY2UgcmlnaHQsIHRoZW4gbGVmdCwgdGhlbiBiYWNrLlxuY29uc3QgTE9PS19BUk9VTkQ6IHJlYWRvbmx5IEZyYW1lW10gPSBbXG4gIC4uLmhvbGQoJ2xvb2stcmlnaHQnLCAwLCA1KSxcbiAgLi4uaG9sZCgnbG9vay1sZWZ0JywgMCwgNSksXG4gIC4uLmhvbGQoJ2RlZmF1bHQnLCAwLCAxKSxcbl1cblxuY29uc3QgQ0xJQ0tfQU5JTUFUSU9OUzogcmVhZG9ubHkgKHJlYWRvbmx5IEZyYW1lW10pW10gPSBbSlVNUF9XQVZFLCBMT09LX0FST1VORF1cblxuY29uc3QgSURMRTogRnJhbWUgPSB7IHBvc2U6ICdkZWZhdWx0Jywgb2Zmc2V0OiAwIH1cbmNvbnN0IEZSQU1FX01TID0gNjBcbmNvbnN0IGluY3JlbWVudEZyYW1lID0gKGk6IG51bWJlcikgPT4gaSArIDFcbmNvbnN0IENMQVdEX0hFSUdIVCA9IDNcblxuLyoqXG4gKiBDbGF3ZCB3aXRoIGNsaWNrLXRyaWdnZXJlZCBhbmltYXRpb25zIChjcm91Y2gtanVtcCB3aXRoIGFybXMgdXAsIG9yXG4gKiBsb29rLWFyb3VuZCkuIENvbnRhaW5lciBoZWlnaHQgaXMgZml4ZWQgYXQgQ0xBV0RfSEVJR0hUIOKAlCBzYW1lIGZvb3RwcmludFxuICogYXMgYSBiYXJlIGA8Q2xhd2QgLz5gIOKAlCBzbyB0aGUgc3Vycm91bmRpbmcgbGF5b3V0IG5ldmVyIHNoaWZ0cy4gRHVyaW5nIGFcbiAqIGNyb3VjaCBvbmx5IHRoZSBmZWV0IHJvdyBjbGlwcyAoc2VlIGNvbW1lbnQgYWJvdmUpLiBDbGljayBvbmx5IGZpcmVzIHdoZW5cbiAqIG1vdXNlIHRyYWNraW5nIGlzIGVuYWJsZWQgKGkuZS4gaW5zaWRlIGA8QWx0ZXJuYXRlU2NyZWVuPmAgLyBmdWxsc2NyZWVuKTtcbiAqIGVsc2V3aGVyZSB0aGlzIHJlbmRlcnMgYW5kIGJlaGF2ZXMgaWRlbnRpY2FsbHkgdG8gcGxhaW4gYDxDbGF3ZCAvPmAuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBBbmltYXRlZENsYXdkKCk6IFJlYWN0LlJlYWN0Tm9kZSB7XG4gIGNvbnN0IHsgcG9zZSwgYm91bmNlT2Zmc2V0LCBvbkNsaWNrIH0gPSB1c2VDbGF3ZEFuaW1hdGlvbigpXG4gIHJldHVybiAoXG4gICAgPEJveCBoZWlnaHQ9e0NMQVdEX0hFSUdIVH0gZmxleERpcmVjdGlvbj1cImNvbHVtblwiIG9uQ2xpY2s9e29uQ2xpY2t9PlxuICAgICAgPEJveCBtYXJnaW5Ub3A9e2JvdW5jZU9mZnNldH0gZmxleFNocmluaz17MH0+XG4gICAgICAgIDxDbGF3ZCBwb3NlPXtwb3NlfSAvPlxuICAgICAgPC9Cb3g+XG4gICAgPC9Cb3g+XG4gIClcbn1cblxuZnVuY3Rpb24gdXNlQ2xhd2RBbmltYXRpb24oKToge1xuICBwb3NlOiBDbGF3ZFBvc2VcbiAgYm91bmNlT2Zmc2V0OiBudW1iZXJcbiAgb25DbGljazogKCkgPT4gdm9pZFxufSB7XG4gIC8vIFJlYWQgb25jZSBhdCBtb3VudCDigJQgbm8gdXNlU2V0dGluZ3MoKSBzdWJzY3JpcHRpb24sIHNpbmNlIHRoYXQgd291bGRcbiAgLy8gcmUtcmVuZGVyIG9uIGFueSBzZXR0aW5ncyBjaGFuZ2UuXG4gIGNvbnN0IFtyZWR1Y2VkTW90aW9uXSA9IHVzZVN0YXRlKFxuICAgICgpID0+IGdldEluaXRpYWxTZXR0aW5ncygpLnByZWZlcnNSZWR1Y2VkTW90aW9uID8/IGZhbHNlLFxuICApXG4gIGNvbnN0IFtmcmFtZUluZGV4LCBzZXRGcmFtZUluZGV4XSA9IHVzZVN0YXRlKC0xKVxuICBjb25zdCBzZXF1ZW5jZVJlZiA9IHVzZVJlZjxyZWFkb25seSBGcmFtZVtdPihKVU1QX1dBVkUpXG5cbiAgY29uc3Qgb25DbGljayA9ICgpID0+IHtcbiAgICBpZiAocmVkdWNlZE1vdGlvbiB8fCBmcmFtZUluZGV4ICE9PSAtMSkgcmV0dXJuXG4gICAgc2VxdWVuY2VSZWYuY3VycmVudCA9XG4gICAgICBDTElDS19BTklNQVRJT05TW01hdGguZmxvb3IoTWF0aC5yYW5kb20oKSAqIENMSUNLX0FOSU1BVElPTlMubGVuZ3RoKV0hXG4gICAgc2V0RnJhbWVJbmRleCgwKVxuICB9XG5cbiAgdXNlRWZmZWN0KCgpID0+IHtcbiAgICBpZiAoZnJhbWVJbmRleCA9PT0gLTEpIHJldHVyblxuICAgIGlmIChmcmFtZUluZGV4ID49IHNlcXVlbmNlUmVmLmN1cnJlbnQubGVuZ3RoKSB7XG4gICAgICBzZXRGcmFtZUluZGV4KC0xKVxuICAgICAgcmV0dXJuXG4gICAgfVxuICAgIGNvbnN0IHRpbWVyID0gc2V0VGltZW91dChzZXRGcmFtZUluZGV4LCBGUkFNRV9NUywgaW5jcmVtZW50RnJhbWUpXG4gICAgcmV0dXJuICgpID0+IGNsZWFyVGltZW91dCh0aW1lcilcbiAgfSwgW2ZyYW1lSW5kZXhdKVxuXG4gIGNvbnN0IHNlcSA9IHNlcXVlbmNlUmVmLmN1cnJlbnRcbiAgY29uc3QgY3VycmVudCA9XG4gICAgZnJhbWVJbmRleCA+PSAwICYmIGZyYW1lSW5kZXggPCBzZXEubGVuZ3RoID8gc2VxW2ZyYW1lSW5kZXhdISA6IElETEVcbiAgcmV0dXJuIHsgcG9zZTogY3VycmVudC5wb3NlLCBib3VuY2VPZmZzZXQ6IGN1cnJlbnQub2Zmc2V0LCBvbkNsaWNrIH1cbn1cbiJdLCJtYXBwaW5ncyI6IjtBQUFBLE9BQU8sS0FBS0EsS0FBSyxNQUFNLE9BQU87QUFDOUIsU0FBU0MsU0FBUyxFQUFFQyxNQUFNLEVBQUVDLFFBQVEsUUFBUSxPQUFPO0FBQ25ELFNBQVNDLEdBQUcsUUFBUSxjQUFjO0FBQ2xDLFNBQVNDLGtCQUFrQixRQUFRLGtDQUFrQztBQUNyRSxTQUFTQyxLQUFLLEVBQUUsS0FBS0MsU0FBUyxRQUFRLFlBQVk7QUFFbEQsS0FBS0MsS0FBSyxHQUFHO0VBQUVDLElBQUksRUFBRUYsU0FBUztFQUFFRyxNQUFNLEVBQUUsTUFBTTtBQUFDLENBQUM7O0FBRWhEO0FBQ0EsU0FBU0MsSUFBSUEsQ0FBQ0YsSUFBSSxFQUFFRixTQUFTLEVBQUVHLE1BQU0sRUFBRSxNQUFNLEVBQUVFLE1BQU0sRUFBRSxNQUFNLENBQUMsRUFBRUosS0FBSyxFQUFFLENBQUM7RUFDdEUsT0FBT0ssS0FBSyxDQUFDQyxJQUFJLENBQUM7SUFBRUMsTUFBTSxFQUFFSDtFQUFPLENBQUMsRUFBRSxPQUFPO0lBQUVILElBQUk7SUFBRUM7RUFBTyxDQUFDLENBQUMsQ0FBQztBQUNqRTs7QUFFQTtBQUNBO0FBQ0E7QUFDQTs7QUFFQTtBQUNBLE1BQU1NLFNBQVMsRUFBRSxTQUFTUixLQUFLLEVBQUUsR0FBRyxDQUNsQyxHQUFHRyxJQUFJLENBQUMsU0FBUyxFQUFFLENBQUMsRUFBRSxDQUFDLENBQUM7QUFBRTtBQUMxQixHQUFHQSxJQUFJLENBQUMsU0FBUyxFQUFFLENBQUMsRUFBRSxDQUFDLENBQUM7QUFBRTtBQUMxQixHQUFHQSxJQUFJLENBQUMsU0FBUyxFQUFFLENBQUMsRUFBRSxDQUFDLENBQUMsRUFDeEIsR0FBR0EsSUFBSSxDQUFDLFNBQVMsRUFBRSxDQUFDLEVBQUUsQ0FBQyxDQUFDO0FBQUU7QUFDMUIsR0FBR0EsSUFBSSxDQUFDLFNBQVMsRUFBRSxDQUFDLEVBQUUsQ0FBQyxDQUFDO0FBQUU7QUFDMUIsR0FBR0EsSUFBSSxDQUFDLFNBQVMsRUFBRSxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQ3pCOztBQUVEO0FBQ0EsTUFBTU0sV0FBVyxFQUFFLFNBQVNULEtBQUssRUFBRSxHQUFHLENBQ3BDLEdBQUdHLElBQUksQ0FBQyxZQUFZLEVBQUUsQ0FBQyxFQUFFLENBQUMsQ0FBQyxFQUMzQixHQUFHQSxJQUFJLENBQUMsV0FBVyxFQUFFLENBQUMsRUFBRSxDQUFDLENBQUMsRUFDMUIsR0FBR0EsSUFBSSxDQUFDLFNBQVMsRUFBRSxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQ3pCO0FBRUQsTUFBTU8sZ0JBQWdCLEVBQUUsU0FBUyxDQUFDLFNBQVNWLEtBQUssRUFBRSxDQUFDLEVBQUUsR0FBRyxDQUFDUSxTQUFTLEVBQUVDLFdBQVcsQ0FBQztBQUVoRixNQUFNRSxJQUFJLEVBQUVYLEtBQUssR0FBRztFQUFFQyxJQUFJLEVBQUUsU0FBUztFQUFFQyxNQUFNLEVBQUU7QUFBRSxDQUFDO0FBQ2xELE1BQU1VLFFBQVEsR0FBRyxFQUFFO0FBQ25CLE1BQU1DLGNBQWMsR0FBR0EsQ0FBQ0MsQ0FBQyxFQUFFLE1BQU0sS0FBS0EsQ0FBQyxHQUFHLENBQUM7QUFDM0MsTUFBTUMsWUFBWSxHQUFHLENBQUM7O0FBRXRCO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQSxPQUFPLFNBQUFDLGNBQUE7RUFBQSxNQUFBQyxDQUFBLEdBQUFDLEVBQUE7RUFDTDtJQUFBakIsSUFBQTtJQUFBa0IsWUFBQTtJQUFBQztFQUFBLElBQXdDQyxpQkFBaUIsQ0FBQyxDQUFDO0VBQUEsSUFBQUMsRUFBQTtFQUFBLElBQUFMLENBQUEsUUFBQWhCLElBQUE7SUFJckRxQixFQUFBLElBQUMsS0FBSyxDQUFPckIsSUFBSSxDQUFKQSxLQUFHLENBQUMsR0FBSTtJQUFBZ0IsQ0FBQSxNQUFBaEIsSUFBQTtJQUFBZ0IsQ0FBQSxNQUFBSyxFQUFBO0VBQUE7SUFBQUEsRUFBQSxHQUFBTCxDQUFBO0VBQUE7RUFBQSxJQUFBTSxFQUFBO0VBQUEsSUFBQU4sQ0FBQSxRQUFBRSxZQUFBLElBQUFGLENBQUEsUUFBQUssRUFBQTtJQUR2QkMsRUFBQSxJQUFDLEdBQUcsQ0FBWUosU0FBWSxDQUFaQSxhQUFXLENBQUMsQ0FBYyxVQUFDLENBQUQsR0FBQyxDQUN6QyxDQUFBRyxFQUFvQixDQUN0QixFQUZDLEdBQUcsQ0FFRTtJQUFBTCxDQUFBLE1BQUFFLFlBQUE7SUFBQUYsQ0FBQSxNQUFBSyxFQUFBO0lBQUFMLENBQUEsTUFBQU0sRUFBQTtFQUFBO0lBQUFBLEVBQUEsR0FBQU4sQ0FBQTtFQUFBO0VBQUEsSUFBQU8sRUFBQTtFQUFBLElBQUFQLENBQUEsUUFBQUcsT0FBQSxJQUFBSCxDQUFBLFFBQUFNLEVBQUE7SUFIUkMsRUFBQSxJQUFDLEdBQUcsQ0FBU1QsTUFBWSxDQUFaQSxhQUFXLENBQUMsQ0FBZ0IsYUFBUSxDQUFSLFFBQVEsQ0FBVUssT0FBTyxDQUFQQSxRQUFNLENBQUMsQ0FDaEUsQ0FBQUcsRUFFSyxDQUNQLEVBSkMsR0FBRyxDQUlFO0lBQUFOLENBQUEsTUFBQUcsT0FBQTtJQUFBSCxDQUFBLE1BQUBNLEVBQUE7SUFBQU4sQ0FBQSxNQUFBTyxFQUFBO0VBQUE7SUFBQUEsRUFBQSxHQUFBUCxDQUFBO0VBQUE7RUFBQSxPQUpOTyxFQUlNO0FBQUE7QUFJVixTQUFTSCxpQkFBaUJBLENBQUEsQ0FBRSxFQUFFO0VBQzVCcEIsSUFBSSxFQUFFRixTQUFTO0VBQ2ZvQixZQUFZLEVBQUUsTUFBTTtFQUNwQkMsT0FBTyxFQUFFLEdBQUcsR0FBRyxJQUFJO0FBQ3JCLENBQUMsQ0FBQztFQUNBO0VBQ0E7RUFDQSxNQUFNLENBQUNLLGFBQWEsQ0FBQyxHQUFHOUIsUUFBUSxDQUM5QixNQUFNRSxrQkFBa0IsQ0FBQyxDQUFDLENBQUM2QixvQkFBb0IsSUFBSSxLQUNyRCxDQUFDO0VBQ0QsTUFBTSxDQUFDQyxVQUFVLEVBQUVDLGFBQWEsQ0FBQyxHQUFHakMsUUFBUSxDQUFDLENBQUMsQ0FBQyxDQUFDO0VBQ2hELE1BQU1rQyxXQUFXLEdBQUduQyxNQUFNLENBQUMsU0FBU00sS0FBSyxFQUFFLENBQUMsQ0FBQ1EsU0FBUyxDQUFDO0VBRXZELE1BQU1ZLE9BQU8sR0FBR0EsQ0FBQSxLQUFNO0lBQ3BCLElBQUlLLGFBQWEsSUFBSUUsVUFBVSxLQUFLLENBQUMsQ0FBQyxFQUFFO0lBQ3hDRSxXQUFXLENBQUNDLE9BQU8sR0FDakJwQixnQkFBZ0IsQ0FBQ3FCLElBQUksQ0FBQ0MsS0FBSyxDQUFDRCxJQUFJLENBQUNFLE1BQU0sQ0FBQyxDQUFDLEdBQUd2QixnQkFBZ0IsQ0FBQ0gsTUFBTSxDQUFDLENBQUMsQ0FBQztJQUN4RXFCLGFBQWEsQ0FBQyxDQUFDLENBQUM7RUFDbEIsQ0FBQztFQUVEbkMsU0FBUyxDQUFDLE1BQU07SUFDZCxJQUFJa0MsVUFBVSxLQUFLLENBQUMsQ0FBQyxFQUFFO0lBQ3ZCLElBQUlBLFVBQVUsSUFBSUUsV0FBVyxDQUFDQyxPQUFPLENBQUN2QixNQUFNLEVBQUU7TUFDNUNxQixhQUFhLENBQUMsQ0FBQyxDQUFDLENBQUM7TUFDakI7SUFDRjtJQUNBLE1BQU1NLEtBQUssR0FBR0MsVUFBVSxDQUFDUCxhQUFhLEVBQUVoQixRQUFRLEVBQUVDLGNBQWMsQ0FBQztJQUNqRSxPQUFPLE1BQU11QixZQUFZLENBQUNGLEtBQUssQ0FBQztFQUNsQyxDQUFDLEVBQUUsQ0FBQ1AsVUFBVSxDQUFDLENBQUM7RUFFaEIsTUFBTVUsR0FBRyxHQUFHUixXQUFXLENBQUNDLE9BQU87RUFDL0IsTUFBTUEsT0FBTyxHQUNYSCxVQUFVLElBQUksQ0FBQyxJQUFJQSxVQUFVLEdBQUdVLEdBQUcsQ0FBQzlCLE1BQU0sR0FBRzhCLEdBQUcsQ0FBQ1YsVUFBVSxDQUFDLENBQUMsR0FBR2hCLElBQUk7RUFDdEUsT0FBTztJQUFFVixJQUFJLEVBQUU2QixPQUFPLENBQUM3QixJQUFJO0lBQUVrQixZQUFZLEVBQUVXLE9BQU8sQ0FBQzVCLE1BQU07SUFBRWtCO0VBQVEsQ0FBQztBQUN0RSIsImlnbm9yZUxpc3QiOltdfQ==
