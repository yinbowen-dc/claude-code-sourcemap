/**
 * DevBar.tsx — 开发者调试状态栏组件
 *
 * 在 Claude Code 系统流程中的位置：
 *   终端 UI 布局层 → 调试/开发辅助栏 → 慢操作监控显示
 *
 * 主要功能：
 *   1. shouldShowDevBar：判断是否应该显示开发调试栏（仅开发构建或 ant 内部用户可见）
 *   2. DevBar：React 组件，在终端顶部或底部渲染最近的慢同步操作列表，
 *      以警告色单行展示，避免占用过多终端行数。
 *   3. _temp（React Compiler 提取的辅助函数）：将操作条目格式化为可读字符串。
 *
 * 注意：在生产构建中，shouldShowDevBar() 始终返回 false（编译时常量比较），
 * 因此 DevBar 在生产环境中永远不会渲染任何内容。
 */
import { c as _c } from "react/compiler-runtime";
import * as React from 'react';
import { useState } from 'react';
import { getSlowOperations } from '../bootstrap/state.js';
import { Text, useInterval } from '../ink.js';

// Show DevBar for dev builds or all ants
/**
 * shouldShowDevBar
 *
 * 整体流程：
 *   - 通过两个编译时常量比较来决定是否显示 DevBar
 *   - "production" === 'development'：构建时注入的环境变量与字面量比较，
 *     生产构建中永远为 false
 *   - "external" === 'ant'：构建时注入的用户类型标识，
 *     仅 ant（内部）用户时为 true
 *   - 两个条件均为 false 时整体返回 false（生产 + 外部用户）
 *
 * 在系统中的角色：
 *   作为 DevBar 渲染门控，避免向外部用户暴露内部调试信息。
 */
function shouldShowDevBar(): boolean {
  // 编译时常量比较：生产构建中两个条件均为 false，结果恒为 false
  return "production" === 'development' || "external" === 'ant';
}

/**
 * DevBar 组件
 *
 * 整体流程：
 *   1. 使用 useState 初始化 slowOps（慢操作列表），初始值来自 getSlowOperations()
 *   2. 注册 useInterval 定时器（仅 dev 模式下每 500ms 轮询一次），
 *      更新 slowOps 状态
 *   3. 若非 dev 模式或慢操作列表为空，直接返回 null（不渲染）
 *   4. 取最近 3 条慢操作，格式化为 "操作名 (耗时ms)" 并用 " · " 连接
 *   5. 渲染单行警告文本 "[ANT-ONLY] slow sync: ..."，末尾截断避免换行
 *
 * React Compiler 缓存槽分配（_c(5)）：
 *   $[0]：interval 回调函数（sentinel 缓存，只创建一次）
 *   $[1]-$[2]：slowOps → recentOps 字符串（依赖 slowOps 变化）
 *   $[3]-$[4]：recentOps → 最终 JSX（依赖 recentOps 变化）
 *
 * 在系统中的角色：
 *   为 ant 内部开发人员提供实时慢操作监控，单行展示减少终端干扰。
 */
export function DevBar() {
  // _c(5)：初始化 5 个 React Compiler 记忆缓存槽
  const $ = _c(5);

  // 初始化慢操作状态，惰性初始化：传入函数引用而非直接调用
  const [slowOps, setSlowOps] = useState(getSlowOperations);

  let t0;
  // $[0] 槽：缓存 interval 回调，sentinel 检测确保只创建一次
  if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
    // 首次渲染：创建并缓存轮询回调，后续复用
    t0 = () => {
      // 每次 interval 触发时重新获取最新慢操作列表并更新状态
      setSlowOps(getSlowOperations());
    };
    $[0] = t0;
  } else {
    // 缓存命中：直接复用已创建的回调引用，避免 interval 重置
    t0 = $[0];
  }
  // 仅在 dev 模式下启用 500ms 轮询；生产环境传入 null 禁用 interval
  useInterval(t0, shouldShowDevBar() ? 500 : null);

  // 非 dev 模式或无慢操作时不渲染任何内容
  if (!shouldShowDevBar() || slowOps.length === 0) {
    return null;
  }

  let t1;
  // $[1]-$[2] 槽：依赖 slowOps，slowOps 变化时重新计算 recentOps 字符串
  if ($[1] !== slowOps) {
    // 取最近 3 条操作，通过 _temp 格式化后用中点符连接成单行字符串
    t1 = slowOps.slice(-3).map(_temp).join(" \xB7 "); // \xB7 = "·"
    $[1] = slowOps; // 存储依赖值
    $[2] = t1;      // 存储计算结果
  } else {
    // slowOps 未变化：复用缓存的 recentOps 字符串
    t1 = $[2];
  }
  const recentOps = t1;

  let t2;
  // $[3]-$[4] 槽：依赖 recentOps，内容变化时重新创建 JSX
  if ($[3] !== recentOps) {
    // 渲染单行警告文本，wrap="truncate-end" 防止内容过长时换行
    t2 = <Text wrap="truncate-end" color="warning">[ANT-ONLY] slow sync: {recentOps}</Text>;
    $[3] = recentOps; // 存储依赖值
    $[4] = t2;        // 存储 JSX 结果
  } else {
    // recentOps 未变化：复用缓存的 JSX 节点
    t2 = $[4];
  }
  return t2;
}

/**
 * _temp（React Compiler 提取的辅助函数）
 *
 * 整体流程：
 *   - 原始源码中为 slowOps.map(op => `...`) 的内联箭头函数
 *   - React Compiler 将其提取到模块作用域，避免每次渲染重新创建函数引用
 *   - 将单个操作条目格式化为 "操作名 (耗时ms)" 字符串，耗时取整毫秒
 *
 * 在系统中的角色：
 *   为 DevBar 中的 .map() 调用提供稳定的格式化函数引用。
 */
function _temp(op) {
  // 格式化输出：操作名称 + 括号内显示取整后的耗时（毫秒）
  return `${op.operation} (${Math.round(op.durationMs)}ms)`;
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJSZWFjdCIsInVzZVN0YXRlIiwiZ2V0U2xvd09wZXJhdGlvbnMiLCJUZXh0IiwidXNlSW50ZXJ2YWwiLCJzaG91bGRTaG93RGV2QmFyIiwiRGV2QmFyIiwiJCIsIl9jIiwic2xvd09wcyIsInNldFNsb3dPcHMiLCJ0MCIsIlN5bWJvbCIsImZvciIsImxlbmd0aCIsInQxIiwic2xpY2UiLCJtYXAiLCJfdGVtcCIsImpvaW4iLCJyZWNlbnRPcHMiLCJ0MiIsIm9wIiwib3BlcmF0aW9uIiwiTWF0aCIsInJvdW5kIiwiZHVyYXRpb25NcyJdLCJzb3VyY2VzIjpbIkRldkJhci50c3giXSwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0ICogYXMgUmVhY3QgZnJvbSAncmVhY3QnXG5pbXBvcnQgeyB1c2VTdGF0ZSB9IGZyb20gJ3JlYWN0J1xuaW1wb3J0IHsgZ2V0U2xvd09wZXJhdGlvbnMgfSBmcm9tICcuLi9ib290c3RyYXAvc3RhdGUuanMnXG5pbXBvcnQgeyBUZXh0LCB1c2VJbnRlcnZhbCB9IGZyb20gJy4uL2luay5qcydcblxuLy8gU2hvdyBEZXZCYXIgZm9yIGRldiBidWlsZHMgb3IgYWxsIGFudHNcbmZ1bmN0aW9uIHNob3VsZFNob3dEZXZCYXIoKTogYm9vbGVhbiB7XG4gIHJldHVybiAoXG4gICAgXCJwcm9kdWN0aW9uXCIgPT09ICdkZXZlbG9wbWVudCcgfHwgXCJleHRlcm5hbFwiID09PSAnYW50J1xuICApXG59XG5cbmV4cG9ydCBmdW5jdGlvbiBEZXZCYXIoKTogUmVhY3QuUmVhY3ROb2RlIHtcbiAgY29uc3QgW3Nsb3dPcHMsIHNldFNsb3dPcHNdID1cbiAgICB1c2VTdGF0ZTxcbiAgICAgIFJlYWRvbmx5QXJyYXk8e1xuICAgICAgICBvcGVyYXRpb246IHN0cmluZ1xuICAgICAgICBkdXJhdGlvbk1zOiBudW1iZXJcbiAgICAgICAgdGltZXN0YW1wOiBudW1iZXJcbiAgICAgIH0+XG4gICAgPihnZXRTbG93T3BlcmF0aW9ucylcblxuICB1c2VJbnRlcnZhbChcbiAgICAoKSA9PiB7XG4gICAgICBzZXRTbG93T3BzKGdldFNsb3dPcGVyYXRpb25zKCkpXG4gICAgfSxcbiAgICBzaG91bGRTaG93RGV2QmFyKCkgPyA1MDAgOiBudWxsLFxuICApXG5cbiAgLy8gT25seSBzaG93IHdoZW4gdGhlcmUncyBzb21ldGhpbmcgdG8gZGlzcGxheVxuICBpZiAoIXNob3VsZFNob3dEZXZCYXIoKSB8fCBzbG93T3BzLmxlbmd0aCA9PT0gMCkge1xuICAgIHJldHVybiBudWxsXG4gIH1cblxuICAvLyBTaW5nbGUtbGluZSBmb3JtYXQgc28gc2hvcnQgdGVybWluYWxzIGRvbid0IGxvc2Ugcm93cyB0byBkZXYgbm9pc2UuXG4gIGNvbnN0IHJlY2VudE9wcyA9IHNsb3dPcHNcbiAgICAuc2xpY2UoLTMpXG4gICAgLm1hcChvcCA9PiBgJHtvcC5vcGVyYXRpb259ICgke01hdGgucm91bmQob3AuZHVyYXRpb25Ncyl9bXMpYClcbiAgICAuam9pbignIMK3ICcpXG5cbiAgcmV0dXJuIChcbiAgICA8VGV4dCB3cmFwPVwidHJ1bmNhdGUtZW5kXCIgY29sb3I9XCJ3YXJuaW5nXCI+XG4gICAgICBbQU5ULU9OTFldIHNsb3cgc3luYzoge3JlY2VudE9wc31cbiAgICA8L1RleHQ+XG4gIClcbn1cbiJdLCJtYXBwaW5ncyI6IjtBQUFBLE9BQU8sS0FBS0EsS0FBSyxNQUFNLE9BQU87QUFDOUIsU0FBU0MsUUFBUSxRQUFRLE9BQU87QUFDaEMsU0FBU0MsaUJBQWlCLFFBQVEsdUJBQXVCO0FBQ3pELFNBQVNDLElBQUksRUFBRUMsV0FBVyxRQUFRLFdBQVc7O0FBRTdDO0FBQ0EsU0FBU0MsZ0JBQWdCQSxDQUFBLENBQUUsRUFBRSxPQUFPLENBQUM7RUFDbkMsT0FDRSxZQUFZLEtBQUssYUFBYSxJQUFJLFVBQVUsS0FBSyxLQUFLO0FBRTFEO0FBRUEsT0FBTyxTQUFBQyxPQUFBO0VBQUEsTUFBQUMsQ0FBQSxHQUFBQyxFQUFBO0VBQ0wsT0FBQUMsT0FBQSxFQUFBQyxVQUFBLElBQ0VULFFBQVEsQ0FNTkMsaUJBQWlCLENBQUM7RUFBQSxJQUFBUyxFQUFBO0VBQUEsSUFBQUosQ0FBQSxRQUFBSyxNQUFBLENBQUFDLEdBQUE7SUFHcEJGLEVBQUEsR0FBQUEsQ0FBQTtNQUNFRCxVQUFVLENBQUNSLGlCQUFpQixDQUFDLENBQUMsQ0FBQztJQUFBLENBQ2hDO0lBQUFLLENBQUEsTUFBQUksRUFBQTtFQUFBO0lBQUFBLEVBQUEsR0FBQUosQ0FBQTtFQUFBO0VBSEhILFdBQVcsQ0FDVE8sRUFFQyxFQUNETixnQkFBZ0IsQ0FBYyxDQUFDLEdBQS9CLEdBQStCLEdBQS9CLElBQ0YsQ0FBQztFQUdELElBQUksQ0FBQ0EsZ0JBQWdCLENBQUMsQ0FBeUIsSUFBcEJJLE9BQU8sQ0FBQUssTUFBTyxLQUFLLENBQUM7SUFBQSxPQUN0QyxJQUFJO0VBQUE7RUFDWixJQUFBQyxFQUFBO0VBQUEsSUFBQVIsQ0FBQSxRQUFBRSxPQUFBO0lBR2lCTSxFQUFBLEdBQUFOLE9BQU8sQ0FBQU8sS0FDakIsQ0FBQyxFQUFFLENBQUMsQ0FBQUMsR0FDTixDQUFDQyxLQUF3RCxDQUFDLENBQUFDLElBQ3pELENBQUMsUUFBSyxDQUFDO0lBQUFaLENBQUEsTUFBQUUsT0FBQTtJQUFBRixDQUFBLE1BQUFRLEVBQUE7RUFBQTtJQUFBQSxFQUFBLEdBQUFSLENBQUE7RUFBQTtFQUhkLE1BQUFhLFNBQUEsR0FBa0JMLEVBR0o7RUFBQSxJQUFBTSxFQUFBO0VBQUEsSUFBQWQsQ0FBQSxRQUFBYSxTQUFBO0lBR1pDLEVBQUEsSUFBQyxJQUFJLENBQU0sSUFBYyxDQUFkLGNBQWMsQ0FBTyxLQUFTLENBQVQsU0FBUyxDQUFDLHNCQUNqQkQsVUFBUSxDQUNqQyxFQUZDLElBQUksQ0FFRTtJQUFBYixDQUFBLE1BQUFhLFNBQUE7SUFBQWIsQ0FBQSxNQUFBYyxFQUFBO0VBQUE7SUFBQUEsRUFBQSxHQUFBZCxDQUFBO0VBQUE7RUFBQSxPQUZQYyxFQUVPO0FBQUE7QUEvQkosU0FBQUgsTUFBQUksRUFBQTtFQUFBLE9BeUJRLEdBQUdBLEVBQUUsQ0FBQUMsU0FBVSxLQUFLQyxJQUFJLENBQUFDLEtBQU0sQ0FBQ0gsRUFBRSxDQUFBSSxVQUFXLENBQUMsS0FBSztBQUFBIiwiaWdub3JlTGlzdCI6W119
