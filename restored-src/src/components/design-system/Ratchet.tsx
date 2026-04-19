/**
 * 【设计系统 - Ratchet 高度锁定组件】
 *
 * 在 Claude Code 系统流程中的位置：
 * 终端 UI 布局稳定层。防止流式输出或内容收缩时界面高度抖动。
 * 典型使用场景：AI 回复流式渲染过程中保持回复区域高度不缩减，
 * 以及滚出视口后锁住最大高度，避免终端重绘时出现闪烁。
 *
 * 主要功能：
 * 1. 通过 useLayoutEffect + measureElement 持续追踪内容实际高度
 * 2. 将历史最大高度存入 maxHeight ref，用 minHeight state 驱动布局
 * 3. lock='always' 始终应用 minHeight；lock='offscreen' 仅在内容不可见时才锁定
 * 4. 外层 Box 绑定 viewportRef，用于 useTerminalViewport 检测可见性
 */

import { c as _c } from "react/compiler-runtime";
import React, { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { useTerminalSize } from '../../hooks/useTerminalSize.js';
import { useTerminalViewport } from '../../ink/hooks/use-terminal-viewport.js';
import { Box, type DOMElement, measureElement } from '../../ink.js';

type Props = {
  children: React.ReactNode;
  /** 锁定模式：'always' 始终锁定最大高度；'offscreen' 仅在不可见时锁定 */
  lock?: 'always' | 'offscreen';
};

/**
 * 防止 UI 高度收缩的锁定容器组件。
 *
 * 整体流程：
 * 1. useTerminalViewport 获取 viewportRef 和 isVisible 可见性状态
 * 2. useTerminalSize 获取终端行数 rows，作为 minHeight 的上限
 * 3. useLayoutEffect 在每次渲染后测量内容高度，若超过历史最大值则更新 maxHeight 和 minHeight
 * 4. engaged = lock==='always' || !isVisible：计算是否应当生效锁定
 * 5. 渲染双层 Box：外层绑定 outerRef（视口追踪）并设 minHeight，内层为实际内容容器
 *
 * React Compiler 使用 _c(10) 缓存 10 个依赖槽位：
 * - $[0..1]：outerRef 回调（依赖 viewportRef）
 * - $[2..3]：useLayoutEffect 回调（依赖 rows）
 * - $[4..5]：内层 Box（依赖 children）
 * - $[6..9]：外层 Box（依赖 outerRef、minHeight、内层 Box）
 */
export function Ratchet(t0) {
  // React Compiler 缓存数组，共 10 个槽位
  const $ = _c(10);
  const {
    children,
    lock: t1
  } = t0;
  // lock 默认为 "always"
  const lock = t1 === undefined ? "always" : t1;

  // useTerminalViewport 返回 [ref回调, { isVisible }]，用于检测组件是否在终端可见区域内
  const [viewportRef, t2] = useTerminalViewport();
  const {
    isVisible  // 当前组件是否在终端视口中可见
  } = t2;

  // 获取终端总行数，用于限制 minHeight 最大不超过整个终端高度
  const {
    rows
  } = useTerminalSize();

  const innerRef = useRef(null);  // 内层 Box 的 DOM 引用，用于测量实际内容高度
  const maxHeight = useRef(0);    // 追踪历史最大高度（ref，不触发重渲染）
  const [minHeight, setMinHeight] = useState(0);  // 驱动布局的最小高度（state，变化触发重渲染）

  // outerRef 回调：同时将 el 传给 viewportRef，使视口检测生效
  let t3;
  if ($[0] !== viewportRef) {
    t3 = el => {
      viewportRef(el);  // 将外层 Box 注册到视口追踪系统
    };
    $[0] = viewportRef;
    $[1] = t3;
  } else {
    t3 = $[1];
  }
  const outerRef = t3;

  // engaged：是否应该锁定高度（始终锁定 或 内容不可见时锁定）
  const engaged = lock === "always" || !isVisible;

  // useLayoutEffect 回调：每次渲染后测量内容高度，更新 maxHeight 和 minHeight
  let t4;
  if ($[2] !== rows) {
    t4 = () => {
      if (!innerRef.current) {
        return;  // 内层 Box 尚未挂载，跳过
      }
      const {
        height  // 当前内容实际高度（字符行数）
      } = measureElement(innerRef.current);
      if (height > maxHeight.current) {
        // 发现更高的内容：更新最大值，同时不超过终端行数上限
        maxHeight.current = Math.min(height, rows);
        setMinHeight(maxHeight.current);  // 触发重渲染，应用新的最小高度
      }
    };
    $[2] = rows;
    $[3] = t4;
  } else {
    t4 = $[3];
  }
  // 无依赖数组，每次渲染后都执行（useLayoutEffect 无第二参数 = 每次渲染）
  useLayoutEffect(t4);

  // 仅在 engaged 为 true 时传入 minHeight，否则传 undefined（不限制高度）
  const t5 = engaged ? minHeight : undefined;

  // 内层 Box：column 方向排列，包裹实际子内容
  let t6;
  if ($[4] !== children) {
    t6 = <Box ref={innerRef} flexDirection="column">{children}</Box>;
    $[4] = children;
    $[5] = t6;
  } else {
    t6 = $[5];
  }

  // 外层 Box：绑定视口 ref，按需设置 minHeight
  let t7;
  if ($[6] !== outerRef || $[7] !== t5 || $[8] !== t6) {
    t7 = <Box minHeight={t5} ref={outerRef}>{t6}</Box>;
    $[6] = outerRef;
    $[7] = t5;
    $[8] = t6;
    $[9] = t7;
  } else {
    t7 = $[9];
  }
  return t7;
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJSZWFjdCIsInVzZUNhbGxiYWNrIiwidXNlTGF5b3V0RWZmZWN0IiwidXNlUmVmIiwidXNlU3RhdGUiLCJ1c2VUZXJtaW5hbFNpemUiLCJ1c2VUZXJtaW5hbFZpZXdwb3J0IiwiQm94IiwiRE9NRWxlbWVudCIsIm1lYXN1cmVFbGVtZW50IiwiUHJvcHMiLCJjaGlsZHJlbiIsIlJlYWN0Tm9kZSIsImxvY2siLCJSYXRjaGV0IiwidDAiLCIkIiwiX2MiLCJ0MSIsInVuZGVmaW5lZCIsInZpZXdwb3J0UmVmIiwidDIiLCJpc1Zpc2libGUiLCJyb3dzIiwiaW5uZXJSZWYiLCJtYXhIZWlnaHQiLCJtaW5IZWlnaHQiLCJzZXRNaW5IZWlnaHQiLCJ0MyIsImVsIiwib3V0ZXJSZWYiLCJlbmdhZ2VkIiwidDQiLCJjdXJyZW50IiwiaGVpZ2h0IiwiTWF0aCIsIm1pbiIsInQ1IiwidDYiLCJ0NyJdLCJzb3VyY2VzIjpbIlJhdGNoZXQudHN4Il0sInNvdXJjZXNDb250ZW50IjpbImltcG9ydCBSZWFjdCwgeyB1c2VDYWxsYmFjaywgdXNlTGF5b3V0RWZmZWN0LCB1c2VSZWYsIHVzZVN0YXRlIH0gZnJvbSAncmVhY3QnXG5pbXBvcnQgeyB1c2VUZXJtaW5hbFNpemUgfSBmcm9tICcuLi8uLi9ob29rcy91c2VUZXJtaW5hbFNpemUuanMnXG5pbXBvcnQgeyB1c2VUZXJtaW5hbFZpZXdwb3J0IH0gZnJvbSAnLi4vLi4vaW5rL2hvb2tzL3VzZS10ZXJtaW5hbC12aWV3cG9ydC5qcydcbmltcG9ydCB7IEJveCwgdHlwZSBET01FbGVtZW50LCBtZWFzdXJlRWxlbWVudCB9IGZyb20gJy4uLy4uL2luay5qcydcblxudHlwZSBQcm9wcyA9IHtcbiAgY2hpbGRyZW46IFJlYWN0LlJlYWN0Tm9kZVxuICBsb2NrPzogJ2Fsd2F5cycgfCAnb2Zmc2NyZWVuJ1xufVxuXG5leHBvcnQgZnVuY3Rpb24gUmF0Y2hldCh7IGNoaWxkcmVuLCBsb2NrID0gJ2Fsd2F5cycgfTogUHJvcHMpOiBSZWFjdC5SZWFjdE5vZGUge1xuICBjb25zdCBbdmlld3BvcnRSZWYsIHsgaXNWaXNpYmxlIH1dID0gdXNlVGVybWluYWxWaWV3cG9ydCgpXG4gIGNvbnN0IHsgcm93cyB9ID0gdXNlVGVybWluYWxTaXplKClcbiAgY29uc3QgaW5uZXJSZWYgPSB1c2VSZWY8RE9NRWxlbWVudCB8IG51bGw+KG51bGwpXG4gIGNvbnN0IG1heEhlaWdodCA9IHVzZVJlZigwKVxuICBjb25zdCBbbWluSGVpZ2h0LCBzZXRNaW5IZWlnaHRdID0gdXNlU3RhdGUoMClcblxuICBjb25zdCBvdXRlclJlZiA9IHVzZUNhbGxiYWNrKFxuICAgIChlbDogRE9NRWxlbWVudCB8IG51bGwpID0+IHtcbiAgICAgIHZpZXdwb3J0UmVmKGVsKVxuICAgIH0sXG4gICAgW3ZpZXdwb3J0UmVmXSxcbiAgKVxuXG4gIGNvbnN0IGVuZ2FnZWQgPSBsb2NrID09PSAnYWx3YXlzJyB8fCAhaXNWaXNpYmxlXG5cbiAgdXNlTGF5b3V0RWZmZWN0KCgpID0+IHtcbiAgICBpZiAoIWlubmVyUmVmLmN1cnJlbnQpIHtcbiAgICAgIHJldHVyblxuICAgIH1cbiAgICBjb25zdCB7IGhlaWdodCB9ID0gbWVhc3VyZUVsZW1lbnQoaW5uZXJSZWYuY3VycmVudClcbiAgICBpZiAoaGVpZ2h0ID4gbWF4SGVpZ2h0LmN1cnJlbnQpIHtcbiAgICAgIG1heEhlaWdodC5jdXJyZW50ID0gTWF0aC5taW4oaGVpZ2h0LCByb3dzKVxuICAgICAgc2V0TWluSGVpZ2h0KG1heEhlaWdodC5jdXJyZW50KVxuICAgIH1cbiAgfSlcblxuICByZXR1cm4gKFxuICAgIDxCb3ggbWluSGVpZ2h0PXtlbmdhZ2VkID8gbWluSGVpZ2h0IDogdW5kZWZpbmVkfSByZWY9e291dGVyUmVmfT5cbiAgICAgIDxCb3ggcmVmPXtpbm5lclJlZn0gZmxleERpcmVjdGlvbj1cImNvbHVtblwiPlxuICAgICAgICB7Y2hpbGRyZW59XG4gICAgICA8L0JveD5cbiAgICA8L0JveD5cbiAgKVxufVxuIl0sIm1h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
