/**
 * PermissionExplanation.tsx
 *
 * 【在 Claude Code 权限系统中的位置】
 * 本文件实现了权限请求对话框中的"AI 解释"功能（Ctrl+E 快捷键触发）。
 * 当用户在等待权限决策时，可通过按 Ctrl+E 向 AI 模型查询当前工具调用的
 * 风险级别与解释说明，帮助用户做出更明智的允许/拒绝决策。
 *
 * 【主要功能】
 * 1. usePermissionExplainerUI - Hook：管理解释器的显示/隐藏状态，懒加载 AI 解释 Promise
 * 2. PermissionExplainerContent - 组件：当可见时，通过 Suspense 展示加载动画或解释结果
 * 3. ExplanationResult - 内部组件：使用 React 19 的 use() Hook 读取 Promise，展示解释内容
 * 4. ShimmerLoadingText - 内部组件：解释加载中时的闪光文字动画
 * 5. createExplanationPromise - 辅助函数：创建调用 AI 解释接口的 Promise，错误时返回 null
 *
 * 【数据流】
 * 用户按 Ctrl+E
 *   → useKeybinding 回调触发
 *   → 首次触发时创建 createExplanationPromise（懒加载，避免浪费 token）
 *   → setVisible(true)，PermissionExplainerContent 渲染
 *   → Suspense fallback 展示 ShimmerLoadingText
 *   → Promise resolve 后 ExplanationResult 展示解释 + 风险等级
 */

import { c as _c } from "react/compiler-runtime";
import React, { Suspense, use, useState } from 'react';
import { Box, Text } from '../../ink.js';
import { useKeybinding } from '../../keybindings/useKeybinding.js';
import { logEvent } from '../../services/analytics/index.js';
import type { Message } from '../../types/message.js';
import { generatePermissionExplanation, isPermissionExplainerEnabled, type PermissionExplanation as PermissionExplanationType, type RiskLevel } from '../../utils/permissions/permissionExplainer.js';
import { ShimmerChar } from '../Spinner/ShimmerChar.js';
import { useShimmerAnimation } from '../Spinner/useShimmerAnimation.js';

// 加载状态提示文本，用于 Suspense fallback 的闪光动画
const LOADING_MESSAGE = 'Loading explanation…';

/**
 * ShimmerLoadingText 组件
 *
 * 在 AI 解释内容加载期间展示带有闪光效果的"Loading explanation…"文字。
 * 利用 useShimmerAnimation 获取当前高亮字符索引，逐字渲染 ShimmerChar。
 * React Compiler 对 glimmerIndex 变化时的字符映射结果进行缓存（7 个槽位）。
 */
function ShimmerLoadingText() {
  // React Compiler 分配 7 个缓存槽
  const $ = _c(7);
  // 获取对 DOM 节点的引用及当前闪光字符索引
  const [ref, glimmerIndex] = useShimmerAnimation("responding", LOADING_MESSAGE, false);

  // ---- 缓存块 1：逐字渲染 ShimmerChar 数组 ----
  // 仅当 glimmerIndex 变化（动画帧更新）时重新映射字符数组
  let t0;
  if ($[0] !== glimmerIndex) {
    t0 = LOADING_MESSAGE.split("").map((char, index) => <ShimmerChar key={index} char={char} index={index} glimmerIndex={glimmerIndex} messageColor="inactive" shimmerColor="text" />);
    $[0] = glimmerIndex;
    $[1] = t0; // 缓存字符节点数组
  } else {
    t0 = $[1]; // 复用已缓存的字符数组
  }

  // ---- 缓存块 2：Text 包装层 ----
  let t1;
  if ($[2] !== t0) {
    t1 = <Text>{t0}</Text>;
    $[2] = t0;
    $[3] = t1;
  } else {
    t1 = $[3];
  }

  // ---- 缓存块 3：Box 根节点（绑定 ref 用于 Ink 尺寸计算）----
  let t2;
  if ($[4] !== ref || $[5] !== t1) {
    t2 = <Box ref={ref}>{t1}</Box>;
    $[4] = ref;
    $[5] = t1;
    $[6] = t2;
  } else {
    t2 = $[6];
  }
  return t2;
}

/**
 * getRiskColor 辅助函数
 *
 * 将风险等级枚举转换为 Ink 主题颜色名称，用于 ExplanationResult 中的风险标签着色。
 * LOW → success（绿色），MEDIUM → warning（黄色），HIGH → error（红色）
 */
function getRiskColor(riskLevel: RiskLevel): 'success' | 'warning' | 'error' {
  switch (riskLevel) {
    case 'LOW':
      return 'success';   // 低风险：绿色
    case 'MEDIUM':
      return 'warning';   // 中风险：黄色
    case 'HIGH':
      return 'error';     // 高风险：红色
  }
}

/**
 * getRiskLabel 辅助函数
 *
 * 将风险等级枚举转换为用户可读的短标签，显示在解释结果的风险区域前缀。
 */
function getRiskLabel(riskLevel: RiskLevel): string {
  switch (riskLevel) {
    case 'LOW':
      return 'Low risk';   // 低风险
    case 'MEDIUM':
      return 'Med risk';   // 中风险
    case 'HIGH':
      return 'High risk';  // 高风险
  }
}

// 传入 usePermissionExplainerUI 和 createExplanationPromise 的 props 类型
type PermissionExplanationProps = {
  toolName: string;          // 工具名称（如 "BashTool"）
  toolInput: unknown;        // 工具调用的输入参数
  toolDescription?: string;  // 工具的描述文本
  messages?: Message[];      // 当前会话消息历史，用于上下文理解
};

// 解释器 UI 的状态类型，由 usePermissionExplainerUI 返回
type ExplainerState = {
  visible: boolean;  // 解释面板是否可见
  enabled: boolean;  // 解释功能是否已启用（由功能开关控制）
  promise: Promise<PermissionExplanationType | null> | null;  // 解释内容的 Promise
};

/**
 * createExplanationPromise 辅助函数
 *
 * 创建一个调用 AI 解释接口的 Promise，并在出错时返回 null（不抛出异常）。
 * 使用 AbortController 创建 signal（但实际不会 abort，因为请求足够快速）。
 * 错误被捕获并静默处理，避免 React Suspense 进入错误边界。
 */
function createExplanationPromise(props: PermissionExplanationProps): Promise<PermissionExplanationType | null> {
  return generatePermissionExplanation({
    toolName: props.toolName,
    toolInput: props.toolInput,
    toolDescription: props.toolDescription,
    messages: props.messages,
    signal: new AbortController().signal // Won't abort - request is fast enough
  }).catch(() => null); // 错误时返回 null，避免 Suspense 触发错误边界
}

/**
 * usePermissionExplainerUI Hook
 *
 * 管理权限解释器的完整状态，供权限请求组件（如 PowerShellPermissionRequest）使用。
 *
 * 工作流程：
 * 1. 通过 isPermissionExplainerEnabled() 检查功能是否开启（React Compiler 缓存，只检查一次）
 * 2. 维护 visible（面板显示状态）和 promise（AI 解释 Promise）两个 state
 * 3. 注册 "confirm:toggleExplanation" 键绑定（默认 Ctrl+E），回调逻辑：
 *    - 若面板当前不可见：记录分析事件，并懒加载创建 Promise（避免未查看时消耗 token）
 *    - 切换 visible 状态（v => !v）
 * 4. 返回 { visible, enabled, promise } 供组件渲染
 */
export function usePermissionExplainerUI(props) {
  // React Compiler 分配 9 个缓存槽
  const $ = _c(9);

  // ---- 缓存块 1：检查功能是否启用（只在组件首次渲染时执行一次）----
  // Symbol.for("react.memo_cache_sentinel") 表示该槽位从未被写入，即首次渲染
  let t0;
  if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
    t0 = isPermissionExplainerEnabled(); // 查询功能开关（通常由配置文件决定）
    $[0] = t0;
  } else {
    t0 = $[0]; // 功能开关状态不变，复用缓存值
  }
  const enabled = t0;

  // 解释面板的显示/隐藏状态，初始为隐藏
  const [visible, setVisible] = useState(false);
  // AI 解释内容的 Promise，初始为 null（懒加载，首次按 Ctrl+E 时才创建）
  const [promise, setPromise] = useState(null);

  // ---- 缓存块 2：键绑定回调函数 ----
  // 当 promise/props/visible 任一变化时重新创建回调（避免闭包过时问题）
  let t1;
  if ($[1] !== promise || $[2] !== props || $[3] !== visible) {
    t1 = () => {
      // 仅在面板从隐藏切换到显示时，才需要触发分析事件和懒加载 Promise
      if (!visible) {
        // 记录用户使用了 Ctrl+E 快捷键的分析事件
        logEvent("tengu_permission_explainer_shortcut_used", {});
        // 懒加载：如果 Promise 还未创建，则在第一次展开时创建
        if (!promise) {
          setPromise(createExplanationPromise(props));
        }
      }
      // 切换面板显示/隐藏（_temp 函数：v => !v）
      setVisible(_temp);
    };
    $[1] = promise;
    $[2] = props;
    $[3] = visible;
    $[4] = t1; // 缓存回调函数
  } else {
    t1 = $[4]; // 复用已缓存的回调函数
  }

  // ---- 缓存块 3：键绑定配置对象 ----
  // 仅在首次渲染时创建（context 和 isActive 不依赖动态值）
  let t2;
  if ($[5] === Symbol.for("react.memo_cache_sentinel")) {
    t2 = {
      context: "Confirmation",  // 键绑定仅在 "Confirmation" 上下文中生效
      isActive: enabled          // 功能未启用时不注册键绑定
    };
    $[5] = t2;
  } else {
    t2 = $[5];
  }
  // 注册 Ctrl+E 键绑定（键名由 keybindings.json 配置文件决定）
  useKeybinding("confirm:toggleExplanation", t1, t2);

  // ---- 缓存块 4：返回值对象 ----
  // 当 promise 或 visible 变化时重新构造返回对象
  let t3;
  if ($[6] !== promise || $[7] !== visible) {
    t3 = {
      visible,
      enabled,
      promise
    };
    $[6] = promise;
    $[7] = visible;
    $[8] = t3; // 缓存返回值对象
  } else {
    t3 = $[8]; // 复用已缓存的返回值对象
  }
  return t3;
}

/**
 * _temp 辅助函数（React Compiler 提取的内联箭头函数）
 *
 * 作为 setVisible 的函数式更新参数，实现布尔值取反（切换显示/隐藏）。
 * React Compiler 将 v => !v 提升为模块级函数以避免每次渲染创建新函数。
 */
function _temp(v) {
  return !v;
}

/**
 * ExplanationResult 内部组件
 *
 * 使用 React 19 的 use() Hook 读取 AI 解释 Promise。
 * 当 Promise 尚未 resolve 时，use() 会挂起（suspend）组件，
 * 由外层 Suspense 显示 fallback（ShimmerLoadingText）。
 *
 * 解释内容结构：
 * - explanation：对工具调用的简要说明
 * - reasoning：AI 的推理过程
 * - riskLevel：风险等级（LOW/MEDIUM/HIGH）
 * - risk：风险描述文本
 */
function ExplanationResult(t0) {
  // React Compiler 分配 21 个缓存槽，覆盖所有子节点的缓存
  const $ = _c(21);
  const {
    promise
  } = t0;
  // use() 读取 Promise：Promise pending → 挂起组件；resolved → 返回值
  const explanation = use(promise);

  // 若 AI 返回 null（接口错误或功能不可用），显示"解释不可用"提示
  if (!explanation) {
    let t1;
    if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
      // 该提示节点永远不变，只创建一次
      t1 = <Box marginTop={1}><Text dimColor={true}>Explanation unavailable</Text></Box>;
      $[0] = t1;
    } else {
      t1 = $[0];
    }
    return t1;
  }

  // ---- 缓存块 1：解释文本节点 ----
  let t1;
  if ($[1] !== explanation.explanation) {
    t1 = <Text>{explanation.explanation}</Text>;
    $[1] = explanation.explanation;
    $[2] = t1;
  } else {
    t1 = $[2];
  }

  // ---- 缓存块 2：推理过程节点 ----
  let t2;
  if ($[3] !== explanation.reasoning) {
    t2 = <Box marginTop={1}><Text>{explanation.reasoning}</Text></Box>;
    $[3] = explanation.reasoning;
    $[4] = t2;
  } else {
    t2 = $[4];
  }

  // ---- 缓存块 3：风险颜色计算 ----
  // 根据 riskLevel 获取对应的 Ink 主题颜色
  let t3;
  if ($[5] !== explanation.riskLevel) {
    t3 = getRiskColor(explanation.riskLevel);
    $[5] = explanation.riskLevel;
    $[6] = t3; // 缓存颜色值
  } else {
    t3 = $[6];
  }

  // ---- 缓存块 4：风险标签文本计算 ----
  let t4;
  if ($[7] !== explanation.riskLevel) {
    t4 = getRiskLabel(explanation.riskLevel);
    $[7] = explanation.riskLevel;
    $[8] = t4; // 缓存标签文本
  } else {
    t4 = $[8];
  }

  // ---- 缓存块 5：风险等级标签节点（彩色"Low risk:"等）----
  let t5;
  if ($[9] !== t3 || $[10] !== t4) {
    t5 = <Text color={t3}>{t4}:</Text>; // 风险标签带冒号，后接风险描述
    $[9] = t3;
    $[10] = t4;
    $[11] = t5;
  } else {
    t5 = $[11];
  }

  // ---- 缓存块 6：风险描述文本节点 ----
  let t6;
  if ($[12] !== explanation.risk) {
    t6 = <Text> {explanation.risk}</Text>; // 前有空格，与标签分隔
    $[12] = explanation.risk;
    $[13] = t6;
  } else {
    t6 = $[13];
  }

  // ---- 缓存块 7：风险行容器（标签 + 描述）----
  let t7;
  if ($[14] !== t5 || $[15] !== t6) {
    t7 = <Box marginTop={1}><Text>{t5}{t6}</Text></Box>;
    $[14] = t5;
    $[15] = t6;
    $[16] = t7;
  } else {
    t7 = $[16];
  }

  // ---- 缓存块 8：整体结果容器（解释 + 推理 + 风险行）----
  let t8;
  if ($[17] !== t1 || $[18] !== t2 || $[19] !== t7) {
    t8 = <Box flexDirection="column" marginTop={1}>{t1}{t2}{t7}</Box>;
    $[17] = t1;
    $[18] = t2;
    $[19] = t7;
    $[20] = t8;
  } else {
    t8 = $[20];
  }
  return t8;
}

/**
 * PermissionExplainerContent 导出组件
 *
 * 解释器内容的对外接口。当 visible=true 且 promise 不为 null 时，
 * 渲染 Suspense 包裹的 ExplanationResult：
 * - 加载中：显示 ShimmerLoadingText 闪光动画（fallback）
 * - 加载完成：显示 ExplanationResult（解释文本 + 推理 + 风险等级）
 *
 * 若 visible=false 或 promise=null，返回 null（不渲染任何内容）。
 */
export function PermissionExplainerContent(t0) {
  // React Compiler 分配 3 个缓存槽
  const $ = _c(3);
  const {
    visible,
    promise
  } = t0;

  // 若未显示或 Promise 未创建，则不渲染任何内容
  if (!visible || !promise) {
    return null;
  }

  // ---- 缓存块 1：Suspense fallback（加载动画）----
  // fallback 节点不依赖任何 props，只创建一次
  let t1;
  if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
    t1 = <Box marginTop={1}><ShimmerLoadingText /></Box>;
    $[0] = t1;
  } else {
    t1 = $[0];
  }

  // ---- 缓存块 2：Suspense + ExplanationResult 组合节点 ----
  // 仅当 promise 变化（通常不会变化）时重新渲染
  let t2;
  if ($[1] !== promise) {
    t2 = <Suspense fallback={t1}><ExplanationResult promise={promise} /></Suspense>;
    $[1] = promise;
    $[2] = t2;
  } else {
    t2 = $[2];
  }
  return t2;
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJSZWFjdCIsIlN1c3BlbnNlIiwidXNlIiwidXNlU3RhdGUiLCJCb3giLCJUZXh0IiwidXNlS2V5YmluZGluZyIsImxvZ0V2ZW50IiwiTWVzc2FnZSIsImdlbmVyYXRlUGVybWlzc2lvbkV4cGxhbmF0aW9uIiwiaXNQZXJtaXNzaW9uRXhwbGFpbmVyRW5hYmxlZCIsIlBlcm1pc3Npb25FeHBsYW5hdGlvbiIsIlBlcm1pc3Npb25FeHBsYW5hdGlvblR5cGUiLCJSaXNrTGV2ZWwiLCJTaGltbWVyQ2hhciIsInVzZVNoaW1tZXJBbmltYXRpb24iLCJMT0FESU5HX01FU1NBR0UiLCJTaGltbWVyTG9hZGluZ1RleHQiLCIkIiwiX2MiLCJyZWYiLCJnbGltbWVySW5kZXgiLCJ0MCIsInNwbGl0IiwibWFwIiwiY2hhciIsImluZGV4IiwidDEiLCJ0MiIsImdldFJpc2tDb2xvciIsInJpc2tMZXZlbCIsImdldFJpc2tMYWJlbCIsIlBlcm1pc3Npb25FeHBsYW5hdGlvblByb3BzIiwidG9vbE5hbWUiLCJ0b29sSW5wdXQiLCJ0b29sRGVzY3JpcHRpb24iLCJtZXNzYWdlcyIsIkV4cGxhaW5lclN0YXRlIiwidmlzaWJsZSIsImVuYWJsZWQiLCJwcm9taXNlIiwiUHJvbWlzZSIsImNyZWF0ZUV4cGxhbmF0aW9uUHJvbWlzZSIsInByb3BzIiwic2lnbmFsIiwiQWJvcnRDb250cm9sbGVyIiwiY2F0Y2giLCJ1c2VQZXJtaXNzaW9uRXhwbGFpbmVyVUkiLCJTeW1ib2wiLCJmb3IiLCJzZXRWaXNpYmxlIiwic2V0UHJvbWlzZSIsIl90ZW1wIiwiY29udGV4dCIsImlzQWN0aXZlIiwidDMiLCJ2IiwiRXhwbGFuYXRpb25SZXN1bHQiLCJleHBsYW5hdGlvbiIsInJlYXNvbmluZyIsInQ0IiwidDUiLCJ0NiIsInJpc2siLCJ0NyIsInQ4IiwiUGVybWlzc2lvbkV4cGxhaW5lckNvbnRlbnQiXSwic291cmNlcyI6WyJQZXJtaXNzaW9uRXhwbGFuYXRpb24udHN4Il0sInNvdXJjZXNDb250ZW50IjpbImltcG9ydCBSZWFjdCwgeyBTdXNwZW5zZSwgdXNlLCB1c2VTdGF0ZSB9IGZyb20gJ3JlYWN0J1xuaW1wb3J0IHsgQm94LCBUZXh0IH0gZnJvbSAnLi4vLi4vaW5rLmpzJ1xuaW1wb3J0IHsgdXNlS2V5YmluZGluZyB9IGZyb20gJy4uLy4uL2tleWJpbmRpbmdzL3VzZUtleWJpbmRpbmcuanMnXG5pbXBvcnQgeyBsb2dFdmVudCB9IGZyb20gJy4uLy4uL3NlcnZpY2VzL2FuYWx5dGljcy9pbmRleC5qcydcbmltcG9ydCB0eXBlIHsgTWVzc2FnZSB9IGZyb20gJy4uLy4uL3R5cGVzL21lc3NhZ2UuanMnXG5pbXBvcnQge1xuICBnZW5lcmF0ZVBlcm1pc3Npb25FeHBsYW5hdGlvbixcbiAgaXNQZXJtaXNzaW9uRXhwbGFpbmVyRW5hYmxlZCxcbiAgdHlwZSBQZXJtaXNzaW9uRXhwbGFuYXRpb24gYXMgUGVybWlzc2lvbkV4cGxhbmF0aW9uVHlwZSxcbiAgdHlwZSBSaXNrTGV2ZWwsXG59IGZyb20gJy4uLy4uL3V0aWxzL3Blcm1pc3Npb25zL3Blcm1pc3Npb25FeHBsYWluZXIuanMnXG5pbXBvcnQgeyBTaGltbWVyQ2hhciB9IGZyb20gJy4uL1NwaW5uZXIvU2hpbW1lckNoYXIuanMnXG5pbXBvcnQgeyB1c2VTaGltbWVyQW5pbWF0aW9uIH0gZnJvbSAnLi4vU3Bpbm5lci91c2VTaGltbWVyQW5pbWF0aW9uLmpzJ1xuXG5jb25zdCBMT0FESU5HX01FU1NBR0UgPSAnTG9hZGluZyBleHBsYW5hdGlvbuKApidcblxuZnVuY3Rpb24gU2hpbW1lckxvYWRpbmdUZXh0KCk6IFJlYWN0LlJlYWN0Tm9kZSB7XG4gIGNvbnN0IFtyZWYsIGdsaW1tZXJJbmRleF0gPSB1c2VTaGltbWVyQW5pbWF0aW9uKFxuICAgICdyZXNwb25kaW5nJyxcbiAgICBMT0FESU5HX01FU1NBR0UsXG4gICAgZmFsc2UsXG4gIClcblxuICByZXR1cm4gKFxuICAgIDxCb3ggcmVmPXtyZWZ9PlxuICAgICAgPFRleHQ+XG4gICAgICAgIHtMT0FESU5HX01FU1NBR0Uuc3BsaXQoJycpLm1hcCgoY2hhciwgaW5kZXgpID0+IChcbiAgICAgICAgICA8U2hpbW1lckNoYXJcbiAgICAgICAgICAgIGtleT17aW5kZXh9XG4gICAgICAgICAgICBjaGFyPXtjaGFyfVxuICAgICAgICAgICAgaW5kZXg9e2luZGV4fVxuICAgICAgICAgICAgZ2xpbW1lckluZGV4PXtnbGltbWVySW5kZXh9XG4gICAgICAgICAgICBtZXNzYWdlQ29sb3I9XCJpbmFjdGl2ZVwiXG4gICAgICAgICAgICBzaGltbWVyQ29sb3I9XCJ0ZXh0XCJcbiAgICAgICAgICAvPlxuICAgICAgICApKX1cbiAgICAgIDwvVGV4dD5cbiAgICA8L0JveD5cbiAgKVxufVxuXG5mdW5jdGlvbiBnZXRSaXNrQ29sb3Iocmlza0xldmVsOiBSaXNrTGV2ZWwpOiAnc3VjY2VzcycgfCAnd2FybmluZycgfCAnZXJyb3InIHtcbiAgc3dpdGNoIChyaXNrTGV2ZWwpIHtcbiAgICBjYXNlICdMT1cnOlxuICAgICAgcmV0dXJuICdzdWNjZXNzJ1xuICAgIGNhc2UgJ01FRElVTSc6XG4gICAgICByZXR1cm4gJ3dhcm5pbmcnXG4gICAgY2FzZSAnSElHSCc6XG4gICAgICByZXR1cm4gJ2Vycm9yJ1xuICB9XG59XG5cbmZ1bmN0aW9uIGdldFJpc2tMYWJlbChyaXNrTGV2ZWw6IFJpc2tMZXZlbCk6IHN0cmluZyB7XG4gIHN3aXRjaCAocmlza0xldmVsKSB7XG4gICAgY2FzZSAnTE9XJzpcbiAgICAgIHJldHVybiAnTG93IHJpc2snXG4gICAgY2FzZSAnTUVESVVNJzpcbiAgICAgIHJldHVybiAnTWVkIHJpc2snXG4gICAgY2FzZSAnSElHSCc6XG4gICAgICByZXR1cm4gJ0hpZ2ggcmlzaydcbiAgfVxufVxuXG50eXBlIFBlcm1pc3Npb25FeHBsYW5hdGlvblByb3BzID0ge1xuICB0b29sTmFtZTogc3RyaW5nXG4gIHRvb2xJbnB1dDogdW5rbm93blxuICB0b29sRGVzY3JpcHRpb24/OiBzdHJpbmdcbiAgbWVzc2FnZXM/OiBNZXNzYWdlW11cbn1cblxudHlwZSBFeHBsYWluZXJTdGF0ZSA9IHtcbiAgdmlzaWJsZTogYm9vbGVhblxuICBlbmFibGVkOiBib29sZWFuXG4gIHByb21pc2U6IFByb21pc2U8UGVybWlzc2lvbkV4cGxhbmF0aW9uVHlwZSB8IG51bGw+IHwgbnVsbFxufVxuXG4vKipcbiAqIENyZWF0ZXMgYW4gZXhwbGFuYXRpb24gcHJvbWlzZSB0aGF0IG5ldmVyIHJlamVjdHMuXG4gKiBFcnJvcnMgYXJlIGNhdWdodCBhbmQgcmV0dXJuZWQgYXMgbnVsbC5cbiAqL1xuZnVuY3Rpb24gY3JlYXRlRXhwbGFuYXRpb25Qcm9taXNlKFxuICBwcm9wczogUGVybWlzc2lvbkV4cGxhbmF0aW9uUHJvcHMsXG4pOiBQcm9taXNlPFBlcm1pc3Npb25FeHBsYW5hdGlvblR5cGUgfCBudWxsPiB7XG4gIHJldHVybiBnZW5lcmF0ZVBlcm1pc3Npb25FeHBsYW5hdGlvbih7XG4gICAgdG9vbE5hbWU6IHByb3BzLnRvb2xOYW1lLFxuICAgIHRvb2xJbnB1dDogcHJvcHMudG9vbElucHV0LFxuICAgIHRvb2xEZXNjcmlwdGlvbjogcHJvcHMudG9vbERlc2NyaXB0aW9uLFxuICAgIG1lc3NhZ2VzOiBwcm9wcy5tZXNzYWdlcyxcbiAgICBzaWduYWw6IG5ldyBBYm9ydENvbnRyb2xsZXIoKS5zaWduYWwsIC8vIFdvbid0IGFib3J0IC0gcmVxdWVzdCBpcyBmYXN0IGVub3VnaFxuICB9KS5jYXRjaCgoKSA9PiBudWxsKVxufVxuXG4vKipcbiAqIEhvb2sgdGhhdCBtYW5hZ2VzIHRoZSBwZXJtaXNzaW9uIGV4cGxhaW5lciBzdGF0ZS5cbiAqIENyZWF0ZXMgdGhlIGZldGNoIHByb21pc2UgbGF6aWx5IChvbmx5IHdoZW4gdXNlciBoaXRzIEN0cmwrRSlcbiAqIHRvIGF2b2lkIGNvbnN1bWluZyB0b2tlbnMgZm9yIGV4cGxhbmF0aW9ucyB1c2VycyBuZXZlciB2aWV3LlxuICovXG5leHBvcnQgZnVuY3Rpb24gdXNlUGVybWlzc2lvbkV4cGxhaW5lclVJKFxuICBwcm9wczogUGVybWlzc2lvbkV4cGxhbmF0aW9uUHJvcHMsXG4pOiBFeHBsYWluZXJTdGF0ZSB7XG4gIGNvbnN0IGVuYWJsZWQgPSBpc1Blcm1pc3Npb25FeHBsYWluZXJFbmFibGVkKClcbiAgY29uc3QgW3Zpc2libGUsIHNldFZpc2libGVdID0gdXNlU3RhdGUoZmFsc2UpXG4gIGNvbnN0IFtwcm9taXNlLCBzZXRQcm9taXNlXSA9XG4gICAgdXNlU3RhdGU8UHJvbWlzZTxQZXJtaXNzaW9uRXhwbGFuYXRpb25UeXBlIHwgbnVsbD4gfCBudWxsPihudWxsKVxuXG4gIC8vIFVzZSBrZXliaW5kaW5nIGZvciBjdHJsK2UgdG9nZ2xlIChjb25maWd1cmFibGUgdmlhIGtleWJpbmRpbmdzLmpzb24pXG4gIHVzZUtleWJpbmRpbmcoXG4gICAgJ2NvbmZpcm06dG9nZ2xlRXhwbGFuYXRpb24nLFxuICAgICgpID0+IHtcbiAgICAgIGlmICghdmlzaWJsZSkge1xuICAgICAgICBsb2dFdmVudCgndGVuZ3VfcGVybWlzc2lvbl9leHBsYWluZXJfc2hvcnRjdXRfdXNlZCcsIHt9KVxuICAgICAgICAvLyBPbmx5IGNyZWF0ZSB0aGUgcHJvbWlzZSBvbiBmaXJzdCB0b2dnbGUgKGxhenkgbG9hZGluZylcbiAgICAgICAgaWYgKCFwcm9taXNlKSB7XG4gICAgICAgICAgc2V0UHJvbWlzZShjcmVhdGVFeHBsYW5hdGlvblByb21pc2UocHJvcHMpKVxuICAgICAgICB9XG4gICAgICB9XG4gICAgICBzZXRWaXNpYmxlKHYgPT4gIXYpXG4gICAgfSxcbiAgICB7IGNvbnRleHQ6ICdDb25maXJtYXRpb24nLCBpc0FjdGl2ZTogZW5hYmxlZCB9LFxuICApXG5cbiAgcmV0dXJuIHsgdmlzaWJsZSwgZW5hYmxlZCwgcHJvbWlzZSB9XG59XG5cbi8qKlxuICogSW5uZXIgY29tcG9uZW50IHRoYXQgdXNlcyBSZWFjdCAxOSdzIHVzZSgpIHRvIHJlYWQgdGhlIHByb21pc2UuXG4gKiBTdXNwZW5kcyB3aGlsZSBsb2FkaW5nLCByZXR1cm5zIG51bGwgb24gZXJyb3IuXG4gKi9cbmZ1bmN0aW9uIEV4cGxhbmF0aW9uUmVzdWx0KHtcbiAgcHJvbWlzZSxcbn06IHtcbiAgcHJvbWlzZTogUHJvbWlzZTxQZXJtaXNzaW9uRXhwbGFuYXRpb25UeXBlIHwgbnVsbD5cbn0pOiBSZWFjdC5SZWFjdE5vZGUge1xuICBjb25zdCBleHBsYW5hdGlvbiA9IHVzZShwcm9taXNlKVxuXG4gIGlmICghZXhwbGFuYXRpb24pIHtcbiAgICByZXR1cm4gKFxuICAgICAgPEJveCBtYXJnaW5Ub3A9ezF9PlxuICAgICAgICA8VGV4dCBkaW1Db2xvcj5FeHBsYW5hdGlvbiB1bmF2YWlsYWJsZTwvVGV4dD5cbiAgICAgIDwvQm94PlxuICAgIClcbiAgfVxuXG4gIHJldHVybiAoXG4gICAgPEJveCBmbGV4RGlyZWN0aW9uPVwiY29sdW1uXCIgbWFyZ2luVG9wPXsxfT5cbiAgICAgIDxUZXh0PntleHBsYW5hdGlvbi5leHBsYW5hdGlvbn08L1RleHQ+XG4gICAgICA8Qm94IG1hcmdpblRvcD17MX0+XG4gICAgICAgIDxUZXh0PntleHBsYW5hdGlvbi5yZWFzb25pbmd9PC9UZXh0PlxuICAgICAgPC9Cb3g+XG4gICAgICA8Qm94IG1hcmdpblRvcD17MX0+XG4gICAgICAgIDxUZXh0PlxuICAgICAgICAgIDxUZXh0IGNvbG9yPXtnZXRSaXNrQ29sb3IoZXhwbGFuYXRpb24ucmlza0xldmVsKX0+XG4gICAgICAgICAgICB7Z2V0Umlza0xhYmVsKGV4cGxhbmF0aW9uLnJpc2tMZXZlbCl9OlxuICAgICAgICAgIDwvVGV4dD5cbiAgICAgICAgICA8VGV4dD4ge2V4cGxhbmF0aW9uLnJpc2t9PC9UZXh0PlxuICAgICAgICA8L1RleHQ+XG4gICAgICA8L0JveD5cbiAgICA8L0JveD5cbiAgKVxufVxuXG4vKipcbiAqIENvbnRlbnQgY29tcG9uZW50IC0gc2hvd3MgbG9hZGluZyAodmlhIFN1c3BlbnNlKSBvciBleHBsYW5hdGlvbiB3aGVuIHZpc2libGVcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIFBlcm1pc3Npb25FeHBsYWluZXJDb250ZW50KHtcbiAgdmlzaWJsZSxcbiAgcHJvbWlzZSxcbn06IHtcbiAgdmlzaWJsZTogYm9vbGVhblxuICBwcm9taXNlOiBQcm9taXNlPFBlcm1pc3Npb25FeHBsYW5hdGlvblR5cGUgfCBudWxsPiB8IG51bGxcbn0pOiBSZWFjdC5SZWFjdE5vZGUge1xuICBpZiAoIXZpc2libGUgfHwgIXByb21pc2UpIHtcbiAgICByZXR1cm4gbnVsbFxuICB9XG5cbiAgcmV0dXJuIChcbiAgICA8U3VzcGVuc2VcbiAgICAgIGZhbGxiYWNrPXtcbiAgICAgICAgPEJveCBtYXJnaW5Ub3A9ezF9PlxuICAgICAgICAgIDxTaGltbWVyTG9hZGluZ1RleHQgLz5cbiAgICAgICAgPC9Cb3g+XG4gICAgICB9XG4gICAgPlxuICAgICAgPEV4cGxhbmF0aW9uUmVzdWx0IHByb21pc2U9e3Byb21pc2V9IC8+XG4gICAgPC9TdXNwZW5zZT5cbiAgKVxufVxuIl0sIm1hcHBpbmdzIjoiO0FBQUEsT0FBT0EsS0FBSyxJQUFJQyxRQUFRLEVBQUVDLEdBQUcsRUFBRUMsUUFBUSxRQUFRLE9BQU87QUFDdEQsU0FBU0MsR0FBRyxFQUFFQyxJQUFJLFFBQVEsY0FBYztBQUN4QyxTQUFTQyxhQUFhLFFBQVEsb0NBQW9DO0FBQ2xFLFNBQVNDLFFBQVEsUUFBUSxtQ0FBbUM7QUFDNUQsY0FBY0MsT0FBTyxRQUFRLHdCQUF3QjtBQUNyRCxTQUNFQyw2QkFBNkIsRUFDN0JDLDRCQUE0QixFQUM1QixLQUFLQyxxQkFBcUIsSUFBSUMseUJBQXlCLEVBQ3ZELEtBQUtDLFNBQVMsUUFDVCxnREFBZ0Q7QUFDdkQsU0FBU0MsV0FBVyxRQUFRLDJCQUEyQjtBQUN2RCxTQUFTQyxtQkFBbUIsUUFBUSxtQ0FBbUM7QUFFdkUsTUFBTUMsZUFBZSxHQUFHLHNCQUFzQjtBQUU5QyxTQUFBQyxtQkFBQTtFQUFBLE1BQUFDLENBQUEsR0FBQUMsRUFBQTtFQUNFLE9BQUFDLEdBQUEsRUFBQUMsWUFBQSxJQUE0Qk4sbUJBQW1CLENBQzdDLFlBQVksRUFDWkMsZUFBZSxFQUNmLEtBQ0YsQ0FBQztFQUFBLElBQUFNLEVBQUE7RUFBQSxJQUFBSixDQUFBLFFBQUFHLFlBQUE7SUFLTUMsRUFBQSxHQUFBTixlQUFlLENBQUFPLEtBQU0sQ0FBQyxFQUFFLENBQUMsQ0FBQUMsR0FBSSxDQUFDLENBQUFDLElBQUEsRUFBQUMsS0FBQSxLQUM3QixDQUFDLFdBQVcsQ0FDTEEsR0FBSyxDQUFMQSxNQUFJLENBQUMsQ0FDSkQsSUFBSSxDQUFKQSxLQUFHLENBQUMsQ0FDSEMsS0FBSyxDQUFMQSxNQUFJLENBQUMsQ0FDRUwsWUFBWSxDQUFaQSxhQUFXLENBQUMsQ0FDYixZQUFVLENBQVYsVUFBVSxDQUNWLFlBQU0sQ0FBTixNQUFNLEdBRXRCLENBQUM7SUFBQUgsQ0FBQSxNQUFBRyxZQUFBO0lBQUFILENBQUEsTUFBQUksRUFBQTtFQUFBO0lBQUFBLEVBQUEsR0FBQUosQ0FBQTtFQUFBO0VBQUEsSUFBQVMsRUFBQTtFQUFBLElBQUFULENBQUEsUUFBQUksRUFBQTtJQVZKSyxFQUFBLElBQUMsSUFBSSxDQUNGLENBQUFMLEVBU0EsQ0FDSCxFQVhDLElBQUksQ0FXRTtJQUFBSixDQUFBLE1BQUFJLEVBQUE7SUFBQUosQ0FBQSxNQUFBUyxFQUFBO0VBQUE7SUFBQUEsRUFBQSxHQUFBVCxDQUFBO0VBQUE7RUFBQSxJQUFBVSxFQUFBO0VBQUEsSUFBQVYsQ0FBQSxRQUFBRSxHQUFBLElBQUFGLENBQUEsUUFBQVMsRUFBQTtJQVpUQyxFQUFBLElBQUMsR0FBRyxDQUFNUixHQUFHLENBQUhBLElBQUUsQ0FBQyxDQUNYLENBQUFPLEVBV00sQ0FDUixFQWJDLEdBQUcsQ0FhRTtJQUFBVCxDQUFBLE1BQUFFLEdBQUE7SUFBQUYsQ0FBQSxNQUFBUyxFQUFE1dbWNJBUUFBQSxDQUFBO0VBQUE7RUFBQSxPQWJOVSxFQWFNO0FBQUE7QUFJVixTQUFTQyxZQUFZQSxDQUFDQyxTQUFTLEVBQUVqQixTQ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UFBQSxJQUFBM0MsQ0FBQSxRQUFBcUMsRUFBQSxJQUFBckMsQ0FBQSxTQUFBMEMsRUFBQTtJQUR0Q0MsRUFBQSxJQUFDLElBQUksQ0FBUSxLQUFtQyxDQUFuQyxDQUFBTixFQUFrQyxDQUFDLENBQzdDLENBQUFLLEVBQWtDLENBQUUsQ0FDdkMsRUFGQyxJQUFJLENBRUU7SUFBQTFDLENBQUEsTUFBQXFDLEVBQUE7SUFBQXJDLENBQUEsT0FBQTBDLEVBQUE7SUFBQTFDLENBQUEsT0FBQTJDLEVBQUQEE7RUFBQTtJQUFBQSxFQUFBLEdBQUEzQyxDQUFBO0VBQUE7RUFBQSxJQUFBNEMsRUFBQTtFQUFBLElBQUE1QyxDQUFBLFNBQUF3QyxXQUFBLENBQUFLLElBQUE7SUFDUEQ7SUFDQ0Q7SUFBQUE7SUFBQUE7RUFBQTtFQUFBLE9BQUFDLEVBQUEsR0FBQTVDLENBQUE7RUFBQTtFQUFBLElBQUE4QyxFQUFBO0VBQUEsSUFBQTlDLENBQUEsU0FBQTJDLEVBQUEsSUFBQTNDLENBQUEsU0FBQTRDLEVBQUE7SUFMcENFLEVBQUEsSUFBQyxHQUFHLENBQVksU0FBQyxDQUFELEdBQUMsQ0FDZixDQUFDLElBQUksQ0FDSCxDQUFBSCxFQUVNLENBQ04sQ0FBQUMsRUFBK0IsQ0FDakMsRUFMQyxJQUFJLENBTVAsRUFQQyxHQUFHLENBT0U7SUFBQTVDLENBQUEsT0FBQTJDLEVBQUE7SUFBQTNDLENBQUEsT0FBQTRDLEVBQUE7SUFBQTVDLENBQUEsT0FBQThDLEVBQUE7RUFBQTtJQUFBQSxFQUFBLEdBQUE5QyxDQUFBO0VBQUE7RUFBQSxJQUFBK0MsRUFBQTtFQUFBLElBQUEvQyxDQUFBLFNBQUFTLEVBQUEsSUFBQVQsQ0FBQSxTQUFBVSxFQUFBLElBQUFWLENBQUEsU0FBQThDLEVBQUE7SUFaUkMsRUFBQSxJQUFDLEdBQUcsQ0FBZSxhQUFRLENBQVIsUUFBUSxDQUFZLFNBQUMsQ0FBRCxHQUFDLENBQ3RDLENBQUF0QyxFQUFxQyxDQUNyQyxDQUFBQyxFQUVLLENBQ0wsQ0FBQW9DLEVBT0ssQ0FDUCxFQWJDLEdBQUcsQ0FhRTtJQUFBOUMsQ0FBQSxPQUFBUyxFQUFBO0lBQUFULENBQUEsT0FBQVUsRUFBQTtJQUFBVixDQUFBLE9BQUE4QyxFQUFBO0lBQUE5QyxDQUFBLE9BQUErQyxFQUFBO0VBQUE7SUFBQUEsRUFBQSxHQUFBL0MsQ0FBQTtFQUFBO0VBQUEsT0FiTitDLEVBYU07QUFBQSIsImlnbm9yZUxpc3QiOltdfQ==
