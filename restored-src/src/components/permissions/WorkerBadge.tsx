/**
 * WorkerBadge.tsx
 *
 * 【层级一：文件职责说明】
 * 本文件定义了 WorkerBadge 组件，用于在 Claude Code 权限对话框中展示
 * Swarm（多智能体）模式下发起权限请求的 worker 身份标识徽章。
 *
 * 在 Claude Code 的 Swarm 架构中，子 worker 可能代表 team leader 执行操作。
 * 当 worker 请求权限时，权限对话框会在顶部显示此徽章，
 * 以彩色 "● @name" 形式告知用户当前是哪个 worker 在请求授权。
 *
 * 主要职责：
 *   1. 接受 name（worker 名称）和 color（标识色）两个 Props
 *   2. 使用 toInkColor 将颜色字符串转换为 Ink 支持的颜色格式
 *   3. 渲染 `● @<name>` 形式的彩色文本徽章
 *
 * 本文件经过 React Compiler 编译，使用 `_c(7)` 进行 7 槽位的细粒度记忆化缓存。
 */

import { c as _c } from "react/compiler-runtime";
import * as React from 'react';
import { BLACK_CIRCLE } from '../../constants/figures.js';
import { Box, Text } from '../../ink.js';
import { toInkColor } from '../../utils/ink.js';

/** WorkerBadge 组件的 Props 类型定义 */
export type WorkerBadgeProps = {
  /** worker 名称，渲染为 @name 格式 */
  name: string;
  /** worker 标识色，将通过 toInkColor 转换为 Ink 颜色 */
  color: string;
};

/**
 * 【层级二：WorkerBadge 组件说明】
 * 渲染彩色的 worker 身份徽章，用于权限请求对话框中标识发起权限请求的 worker。
 *
 * 渲染结构：
 *   Box（row 布局）
 *     └── Text（color=inkColor）
 *           ├── BLACK_CIRCLE（● 实心圆）
 *           └── Text（bold=true）@{name}
 *
 * React Compiler 优化：
 *   使用 _c(7) 创建 7 个缓存槽位：
 *     - $[0]-$[1]：inkColor 依赖 color
 *     - $[2]-$[3]：@name 粗体节点依赖 name
 *     - $[4]-$[6]：整体 Box 节点依赖 inkColor 和 @name 节点
 *
 * @param props.name  - worker 名称
 * @param props.color - worker 标识色字符串
 */
export function WorkerBadge(t0) {
  // React Compiler 生成的 7 槽位缓存数组
  const $ = _c(7);
  const {
    name,
    color
  } = t0;

  // 【缓存槽 $[0]-$[1]】：将颜色字符串转换为 Ink 支持的颜色格式
  // 仅当 color prop 变化时重新计算
  let t1;
  if ($[0] !== color) {
    t1 = toInkColor(color);
    $[0] = color;
    $[1] = t1;
  } else {
    t1 = $[1];
  }
  const inkColor = t1;

  // 【缓存槽 $[2]-$[3]】：@name 粗体文本节点，仅当 name prop 变化时重新创建
  let t2;
  if ($[2] !== name) {
    t2 = <Text bold={true}>@{name}</Text>;
    $[2] = name;
    $[3] = t2;
  } else {
    t2 = $[3];
  }

  // 【缓存槽 $[4]-$[6]】：整体 Box 节点，依赖 inkColor 和 @name 节点
  // 渲染 "● @name" 格式的彩色徽章
  let t3;
  if ($[4] !== inkColor || $[5] !== t2) {
    // BLACK_CIRCLE 为 "●" 字符，与 @name 组合展示 worker 标识
    t3 = <Box flexDirection="row" gap={1}><Text color={inkColor}>{BLACK_CIRCLE} {t2}</Text></Box>;
    $[4] = inkColor;
    $[5] = t2;
    $[6] = t3;
  } else {
    t3 = $[6];
  }
  return t3;
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJSZWFjdCIsIkJMQUNLX0NJUkNMRSIsIkJveCIsIlRleHQiLCJ0b0lua0NvbG9yIiwiV29ya2VyQmFkZ2VQcm9wcyIsIm5hbWUiLCJjb2xvciIsIldvcmtlckJhZGdlIiwidDAiLCIkIiwiX2MiLCJ0MSIsImlua0NvbG9yIiwidDIiLCJ0MyJdLCJzb3VyY2VzIjpbIldvcmtlckJhZGdlLnRzeCJdLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgKiBhcyBSZWFjdCBmcm9tICdyZWFjdCdcbmltcG9ydCB7IEJMQUNLX0NJUkNMRSB9IGZyb20gJy4uLy4uL2NvbnN0YW50cy9maWd1cmVzLmpzJ1xuaW1wb3J0IHsgQm94LCBUZXh0IH0gZnJvbSAnLi4vLi4vaW5rLmpzJ1xuaW1wb3J0IHsgdG9JbmtDb2xvciB9IGZyb20gJy4uLy4uL3V0aWxzL2luay5qcydcblxuZXhwb3J0IHR5cGUgV29ya2VyQmFkZ2VQcm9wcyA9IHtcbiAgbmFtZTogc3RyaW5nXG4gIGNvbG9yOiBzdHJpbmdcbn1cblxuLyoqXG4gKiBSZW5kZXJzIGEgY29sb3JlZCBiYWRnZSBzaG93aW5nIHRoZSB3b3JrZXIncyBuYW1lIGZvciBwZXJtaXNzaW9uIHByb21wdHMuXG4gKiBVc2VkIHRvIGluZGljYXRlIHdoaWNoIHN3YXJtIHdvcmtlciBpcyByZXF1ZXN0aW5nIHRoZSBwZXJtaXNzaW9uLlxuICovXG5leHBvcnQgZnVuY3Rpb24gV29ya2VyQmFkZ2Uoe1xuICBuYW1lLFxuICBjb2xvcixcbn06IFdvcmtlckJhZGdlUHJvcHMpOiBSZWFjdC5SZWFjdE5vZGUge1xuICBjb25zdCBpbmtDb2xvciA9IHRvSW5rQ29sb3IoY29sb3IpXG4gIHJldHVybiAoXG4gICAgPEJveCBmbGV4RGlyZWN0aW9uPVwicm93XCIgZ2FwPXsxfT5cbiAgICAgIDxUZXh0IGNvbG9yPXtpbmtDb2xvcn0+XG4gICAgICAgIHtCTEFDS19DSVJDTEV9IDxUZXh0IGJvbGQ+QHtuYW1lfTwvVGV4dD5cbiAgICAgIDwvVGV4dD5cbiAgICA8L0JveD5cbiAgKVxufVxuIl0sIm1hcHBpbmdzIjoiO0FBQUEsT0FBTyxLQUFLQSxLQUFLLE1BQU0sT0FBTztBQUM5QixTQUFTQyxZQUFZLFFBQVEsNEJBQTRCO0FBQ3pELFNBQVNDLEdBQUcsRUFBRUMsSUFBSSxRQUFRLGNBQWM7QUFDeEMsU0FBU0MsVUFBVSxRQUFRLG9CQUFvQjtBQUUvQyxPQUFPLEtBQUtDLGdCQUFnQixHQUFHO0VBQzdCQyxJQUFJLEVBQUUsTUFBTTtFQUNaQyxLQUFLLEVBQUUsTUFBTTtBQUNmLENBQUM7O0FBRUQ7QUFDQTtBQUNBO0FBQ0E7QUFDQSxPQUFPLFNBQUFDLFlBQUFDLEVBQUE7RUFBQSxNQUFBQyxDQUFBLEdBQUFDLEVBQUE7RUFBcUI7SUFBQUwsSUFBQTtJQUFBQztFQUFBLElBQUFFLEVBR1Q7RUFBQSxJQUFBRyxFQUFBO0VBQUEsSUFBQUYsQ0FBQSxRQUFBSCxLQUFBO0lBQ0FLLEVBQUEsR0FBQVIsVUFBVSxDQUFDRyxLQUFLLENBQUM7SUFBQUcsQ0FBQSxNQUFBSCxLQUFBO0lBQUFHLENBQUEsTUFBQUUsRUFBQTtFQUFBO0lBQUFBLEVBQUEsR0FBQUYsQ0FBQTtFQUFBO0VBQWxDLE1BQUFHLFFBQUEsR0FBaUJELEVBQWlCO0VBQUEsSUFBQUUsRUFBQTtFQUFBLElBQUFKLENBQUEsUUFBQUosSUFBQTtJQUliUSxFQUFBLElBQUMsSUFBSSxDQUFDLElBQUksQ0FBSixLQUFHLENBQUMsQ0FBQyxDQUFFUixLQUFHLENBQUUsRUFBakIsSUFBSSxDQUFvQjtJQUFBSSxDQUFBLE1BQUFKLElBQUE7SUFBQUksQ0FBQSxNQUFBSSxFQUFBO0VBQUE7SUFBQUEsRUFBQSxHQUFBSixDQUFBO0VBQUE7RUFBQSxJQUFBSyxFQUFBO0VBQUEsSUFBQUwsQ0FBQSxRQUFBRyxRQUFBLElBQUFILENBQUEsUUFBQUksRUFBQTtJQUY1Q0MsRUFBQSxJQUFDLEdBQUcsQ0FBZSxhQUFLLENBQUwsS0FBSyxDQUFNLEdBQUMsQ0FBRCxHQUFDLENBQzdCLENBQUMsSUFBSSxDQUFRRixLQUFRLENBQVJBLFNBQU8sQ0FBQyxDQUNsQlosYUFBVyxDQUFFLENBQUMsQ0FBQWEsRUFBd0IsQ0FDekMsRUFGQyxJQUFJLENBR1AsRUFKQyxHQUFHLENBSUU7SUFBQUosQ0FBQSxNQUFBRyxRQUFBO0lBQUFILENBQUEsTUFBQUksRUFBQTtJQUFBSixDQUFBLE1BQUFLLEVBQUE7RUFBQTtJQUFBQSxFQUFBLEdBQUFMLENBQUE7RUFBQTtFQUFBLE9BSk5LLEVBSU07QUFBQSIsImlnbm9yZUxpc3QiOltdfQ==
