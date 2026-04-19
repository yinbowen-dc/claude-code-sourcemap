/**
 * 【设计系统 - 状态图标组件】
 *
 * 在 Claude Code 系统流程中的位置：
 * 设计系统的基础视觉反馈层。整个 CLI 界面中凡需要表示操作结果状态的地方
 * 都使用此组件——工具调用成功/失败、权限请求、加载等待等场景。
 * 通过统一的 STATUS_CONFIG 映射表确保全应用图标与颜色风格一致。
 *
 * 主要功能：
 * 1. 将语义化状态名（success/error/warning/info/pending/loading）映射为对应图标和颜色
 * 2. 支持 withSpace 选项，方便图标后紧跟文字时自动插入空格
 * 3. 使用 React Compiler 编译优化（_c(5) 缓存数组），避免不必要的重渲染
 */

import { c as _c } from "react/compiler-runtime";
import figures from 'figures';
import React from 'react';
import { Text } from '../../ink.js';

/** 支持的状态类型 */
type Status = 'success' | 'error' | 'warning' | 'info' | 'pending' | 'loading';

type Props = {
  /**
   * 要显示的状态。同时决定图标样式和颜色。
   *
   * - `success`: 绿色对勾 (✓)
   * - `error`: 红色叉号 (✗)
   * - `warning`: 黄色警告符 (⚠)
   * - `info`: 蓝色信息符 (ℹ)
   * - `pending`: 暗色圆圈 (○)
   * - `loading`: 暗色省略号 (…)
   */
  status: Status;
  /**
   * 是否在图标后追加一个空格。当图标后紧跟文字时很有用。
   * @default false
   */
  withSpace?: boolean;
};

/**
 * 状态→图标+颜色的静态映射表。
 * 颜色值为主题键名，pending/loading 无颜色（使用 dimColor）。
 */
const STATUS_CONFIG: Record<Status, {
  icon: string;
  color: 'success' | 'error' | 'warning' | 'suggestion' | undefined;
}> = {
  success: {
    icon: figures.tick,   // ✓
    color: 'success'      // 绿色
  },
  error: {
    icon: figures.cross,  // ✗
    color: 'error'        // 红色
  },
  warning: {
    icon: figures.warning, // ⚠
    color: 'warning'       // 黄色
  },
  info: {
    icon: figures.info,   // ℹ
    color: 'suggestion'   // 蓝色
  },
  pending: {
    icon: figures.circle, // ○
    color: undefined      // 无主题色，依靠 dimColor 变暗
  },
  loading: {
    icon: '…',            // 省略号
    color: undefined      // 无主题色，依靠 dimColor 变暗
  }
};

/**
 * 渲染带颜色的状态指示图标。
 *
 * 整体流程：
 * 1. 根据 status 从 STATUS_CONFIG 取出对应的 icon 和 color
 * 2. 若 color 为 undefined，则通过 dimColor 将图标变暗
 * 3. 若 withSpace 为 true，在图标后追加一个空格字符
 * 4. React Compiler 通过 $[0..4] 缓存依赖值，仅在 icon/color/dimColor/withSpace 变化时重新渲染
 *
 * @example
 * // 成功指示器
 * <StatusIcon status="success" />
 *
 * @example
 * // 带尾部空格的错误指示器，后接文字
 * <Text><StatusIcon status="error" withSpace />Failed to connect</Text>
 *
 * @example
 * // 状态行模式
 * <Text>
 *   <StatusIcon status="pending" withSpace />
 *   Waiting for response
 * </Text>
 */
export function StatusIcon(t0) {
  // React Compiler 生成的缓存数组，大小为 5
  const $ = _c(5);
  const {
    status,
    withSpace: t1
  } = t0;
  // withSpace 默认为 false
  const withSpace = t1 === undefined ? false : t1;
  // 从映射表取出当前状态对应的图标配置
  const config = STATUS_CONFIG[status];
  // 若无主题色则开启 dimColor（变暗效果）
  const t2 = !config.color;
  // 仅在 withSpace 为 true 时追加空格，否则 t3 为 false（不渲染）
  const t3 = withSpace && " ";
  let t4;
  // React Compiler 缓存判断：任一依赖项变化才重新创建 JSX
  if ($[0] !== config.color || $[1] !== config.icon || $[2] !== t2 || $[3] !== t3) {
    t4 = <Text color={config.color} dimColor={t2}>{config.icon}{t3}</Text>;
    $[0] = config.color;
    $[1] = config.icon;
    $[2] = t2;
    $[3] = t3;
    $[4] = t4;
  } else {
    // 依赖未变化，直接复用缓存的 JSX 节点
    t4 = $[4];
  }
  return t4;
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJmaWd1cmVzIiwiUmVhY3QiLCJUZXh0IiwiU3RhdHVzIiwiUHJvcHMiLCJzdGF0dXMiLCJ3aXRoU3BhY2UiLCJTVEFUVVNfQ09ORklHIiwiUmVjb3JkIiwiaWNvbiIsImNvbG9yIiwic3VjY2VzcyIsInRpY2siLCJlcnJvciIsImNyb3NzIiwid2FybmluZyIsImluZm8iLCJwZW5kaW5nIiwiY2lyY2xlIiwidW5kZWZpbmVkIiwibG9hZGluZyIsIlN0YXR1c0ljb24iLCJ0MCIsIiQiLCJfYyIsInQxIiwiY29uZmlnIiwidDIiLCJ0MyIsInQ0Il0sInNvdXJjZXMiOlsiU3RhdHVzSWNvbi50c3giXSwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IGZpZ3VyZXMgZnJvbSAnZmlndXJlcydcbmltcG9ydCBSZWFjdCBmcm9tICdyZWFjdCdcbmltcG9ydCB7IFRleHQgfSBmcm9tICcuLi8uLi9pbmsuanMnXG5cbnR5cGUgU3RhdHVzID0gJ3N1Y2Nlc3MnIHwgJ2Vycm9yJyB8ICd3YXJuaW5nJyB8ICdpbmZvJyB8ICdwZW5kaW5nJyB8ICdsb2FkaW5nJ1xuXG50eXBlIFByb3BzID0ge1xuICAvKipcbiAgICogVGhlIHN0YXR1cyB0byBkaXNwbGF5LiBEZXRlcm1pbmVzIGJvdGggdGhlIGljb24gYW5kIGNvbG9yLlxuICAgKlxuICAgKiAtIGBzdWNjZXNzYDogR3JlZW4gY2hlY2ttYXJrICjinJMpXG4gICAqIC0gYGVycm9yYDogUmVkIGNyb3NzICjinJcpXG4gICAqIC0gYHdhcm5pbmdgOiBZZWxsb3cgd2FybmluZyBzeW1ib2wgKOKaoClcbiAgICogLSBgaW5mb2A6IEJsdWUgaW5mbyBzeW1ib2wgKOKEuSlcbiAgICogLSBgcGVuZGluZ2A6IERpbW1lZCBjaXJjbGUgKOKXiylcbiAgICogLSBgbG9hZGluZ2A6IERpbW1lZCBlbGxpcHNpcyAo4oCmKVxuICAgKi9cbiAgc3RhdHVzOiBTdGF0dXNcbiAgLyoqXG4gICAqIEluY2x1ZGUgYSB0cmFpbGluZyBzcGFjZSBhZnRlciB0aGUgaWNvbi4gVXNlZnVsIHdoZW4gZm9sbG93ZWQgYnkgdGV4dC5cbiAgICogQGRlZmF1bHQgZmFsc2VcbiAgICovXG4gIHdpdGhTcGFjZT86IGJvb2xlYW5cbn1cblxuY29uc3QgU1RBVFVTX0NPTkZJRzogUmVjb3JkPFxuICBTdGF0dXMsXG4gIHtcbiAgICBpY29uOiBzdHJpbmdcbiAgICBjb2xvcjogJ3N1Y2Nlc3MnIHwgJ2Vycm9yJyB8ICd3YXJuaW5nJyB8ICdzdWdnZXN0aW9uJyB8IHVuZGVmaW5lZFxuICB9XG4+ID0ge1xuICBzdWNjZXNzOiB7IGljb246IGZpZ3VyZXMudGljaywgY29sb3I6ICdzdWNjZXNzJyB9LFxuICBlcnJvcjogeyBpY29uOiBmaWd1cmVzLmNyb3NzLCBjb2xvcjogJ2Vycm9yJyB9LFxuICB3YXJuaW5nOiB7IGljb246IGZpZ3VyZXMud2FybmluZywgY29sb3I6ICd3YXJuaW5nJyB9LFxuICBpbmZvOiB7IGljb246IGZpZ3VyZXMuaW5mbywgY29sb3I6ICdzdWdnZXN0aW9uJyB9LFxuICBwZW5kaW5nOiB7IGljb246IGZpZ3VyZXMuY2lyY2xlLCBjb2xvcjogdW5kZWZpbmVkIH0sXG4gIGxvYWRpbmc6IHsgaWNvbjogJ+KApicsIGNvbG9yOiB1bmRlZmluZWQgfSxcbn1cblxuLyoqXG4gKiBSZW5kZXJzIGEgc3RhdHVzIGluZGljYXRvciBpY29uIHdpdGggYXBwcm9wcmlhdGUgY29sb3IuXG4gKlxuICogQGV4YW1wbGVcbiAqIC8vIFN1Y2Nlc3MgaW5kaWNhdG9yXG4gKiA8U3RhdHVzSWNvbiBzdGF0dXM9XCJzdWNjZXNzXCIgLz5cbiAqXG4gKiBAZXhhbXBsZVxuICogLy8gRXJyb3Igd2l0aCB0cmFpbGluZyBzcGFjZSBmb3IgdGV4dFxuICogPFRleHQ+PFN0YXR1c0ljb24gc3RhdHVzPVwiZXJyb3JcIiB3aXRoU3BhY2UgLz5GYWlsZWQgdG8gY29ubmVjdDwvVGV4dD5cbiAqXG4gKiBAZXhhbXBsZVxuICogLy8gU3RhdHVzIGxpbmUgcGF0dGVyblxuICogPFRleHQ+XG4gKiAgIDxTdGF0dXNJY29uIHN0YXR1cz1cInBlbmRpbmdcIiB3aXRoU3BhY2UgLz5cbiAqICAgV2FpdGluZyBmb3IgcmVzcG9uc2VcbiAqIDwvVGV4dD5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIFN0YXR1c0ljb24oe1xuICBzdGF0dXMsXG4gIHdpdGhTcGFjZSA9IGZhbHNlLFxufTogUHJvcHMpOiBSZWFjdC5SZWFjdE5vZGUge1xuICBjb25zdCBjb25maWcgPSBTVEFUVVNfQ09ORklHW3N0YXR1c11cblxuICByZXR1cm4gKFxuICAgIDxUZXh0IGNvbG9yPXtjb25maWcuY29sb3J9IGRpbUNvbG9yPXshY29uZmlnLmNvbG9yfT5cbiAgICAgIHtjb25maWcuaWNvbn1cbiAgICAgIHt3aXRoU3BhY2UgJiYgJyAnfVxuICAgIDwvVGV4dD5cbiAgKVxufVxuIl0sIm1hcHBpbmdzIjoiO0FBQUEsT0FBT0EsT0FBTyxNQUFNLFNBQVM7QUFDN0IsT0FBT0MsS0FBSyxNQUFNLE9BQU87QUFDekIsU0FBU0MsSUFBSSxRQUFRLGNBQWM7QUFFbkMsS0FBS0MsTUFBTSxHQUFHLFNBQVMsR0FBRyxPQUFPLEdBQUcsU0FBUyxHQUFHLE1BQU0sR0FBRyxTQUFTLEdBQUcsU0FBUztBQUU5RSxLQUFLQyxLQUFLLEdBQUc7RUFDWDtBQUNGO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtFQUNFQyxNQUFNLEVBQUVGLE1BQU07RUFDZDtBQUNGO0FBQ0E7QUFDQTtFQUNFRyxTQUFTLENBQUMsRUFBRSxPQUFPO0FBQ3JCLENBQUM7QUFFRCxNQUFNQyxhQUFhLEVBQUVDLE1BQU0sQ0FDekJMLE1BQU0sRUFDTjtFQUNFTSxJQUFJLEVBQUUsTUFBTTtFQUNaQyxLQUFLLEVBQUUsU0FBUyxHQUFHLE9BQU8sR0FBRyxTQUFTLEdBQUcsWUFBWSxHQUFHLFNBQVM7QUFDbkUsQ0FBQyxDQUNGLEdBQUc7RUFDRkMsT0FBTyxFQUFFO0lBQUVGLElBQUksRUFBRVQsT0FBTyxDQUFDWSxJQUFJO0lBQUVGLEtBQUssRUFBRTtFQUFVLENBQUM7RUFDakRHLEtBQUssRUFBRTtJQUFFSixJQUFJLEVBQUVULE9BQU8sQ0FBQ2MsS0FBSztJQUFFSixLQUFLLEVBQUU7RUFBUSxDQUFDO0VBQzlDSyxPQUFPLEVBQUU7SUFBRU4sSUFBSSxFQUFFVCxPQUFPLENBQUNlLE9BQU87SUFBRUwsS0FBSyxFQUFFO0VBQVUsQ0FBQztFQUNwRE0sSUFBSSxFQUFFO0lBQUVQLElBQUksRUFBRVQsT0FBTyxDQUFDZ0IsSUFBSTtJQUFFTixLQUFLLEVBQUU7RUFBYSxDQUFDO0VBQ2pETyxPQUFPLEVBQUU7SUFBRVIsSUFBSSxFQUFFVCxPQUFPLENBQUNrQixNQUFNO0lBQUVSLEtBQUssRUFBRVM7RUFBVSxDQUFDO0VBQ25EQyxPQUFPLEVBQUU7SUFBRVgsSUFBSSxFQUFFLEdBQUc7SUFBRUMsS0FBSyxFQUFFUztFQUFVO0FBQ3pDLENBQUM7O0FBSUQ7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBLE9BQU8sU0FBQUUsV0FBQUMsRUFBQTtFQUFBLE1BQUFDLENBQUEsR0FBQUMsRUFBQTtFQUFvQjtJQUFBbkIsTUFBQTtJQUFBQyxTQUFBLEVBQUFtQjtFQUFBLElBQUFILEVBR25CO0VBRE4sTUFBQWhCLFNBQUEsR0FBQW1CLEVBQWlCLEtBQWpCTixTQUFpQixHQUFqQixLQUFpQixHQUFqQk0sRUFBaUI7RUFFakIsTUFBQUMsTUFBQSxHQUFlbkIsYUFBYSxDQUFDRixNQUFNLENBQUM7RUFHRyxNQUFBc0IsRUFBQSxJQUFDRCxNQUFNLENBQUNoQixLQUFNO0VBRS9DLE1BQUFrQixFQUFBLEdBQUF0QixTQUFnQixJQUFoQixHQUFnQjtFQUFBLElBQUF1QixFQUFBO0VBQUEsSUFBQU4sQ0FBQSxRQUFBRyxNQUFBLENBQUFoQixLQUFBLElBQUFhLENBQUEsUUFBQUcsTUFBQSxDQUFBakIsSUFBQSxJQUFBYyxDQUFBLFFBQUFJLEVBQUEsSUFBQUosQ0FBQSxRQUFBSyxFQUFBO0lBRm5CQyxFQUFBLElBQUMsSUFBSSxDQUFRLEtBQVksQ0FBWixDQUFBSCxNQUFNLENBQUNoQixLQUFLLENBQUMsQ0FBWSxRQUFhLENBQWIsQ0FBQWlCLEVBQVksQ0FBQyxDQUMvQyxDQUFBRCxNQUFNLENBQUFqQixJQUFJLENBQ1YsQ0FBQW1CLEVBQWUsQ0FDbEIsRUFIQyxJQUFJLENBR0U7SUFBQUwsQ0FBQSxNQUFBRyxNQUFBLENBQUFoQixLQUFBO0lBQUFhLENBQUEsTUFBQUcsTUFBQSxDQUFBakIsSUFBQTtJQUFBYyxDQUFBLE1BQUFJLEVBQUE7SUFBQUosQ0FBQSxNQUFBSyxFQUFBO0lBQUFMLENBQUEsTUFBQU0sRUFBQTtFQUFBO0lBQUFBLEVBQUEsR0FBQU4sQ0FBQTtFQUFBO0VBQUEsT0FIUE0sRUFHTztBQUFBIiwiaWdub3JlTGlzdCI6W119

