/**
 * 【文件概述】CondensedLogo.tsx
 *
 * 在 Claude Code 系统流程中的位置：
 *   启动阶段 → Logo 渲染 → 精简 Logo → 本组件（顶部状态栏）
 *
 * 主要职责：
 *   渲染对话列表顶部的精简 Logo 区域，内容包括：
 *     - Clawd 吉祥物（全屏环境用 AnimatedClawd，否则用静态 Clawd）
 *     - 应用名称 + 版本号
 *     - 当前模型名称 + 计费方式（自适应宽度）
 *     - 当前工作目录（可含 Agent 名称前缀）
 *     - 访客 Pass 促销（GuestPassesUpsell）或超额积分促销（OverageCreditUpsell）
 *
 * 与其他模块的关系：
 *   - useTerminalSize：获取终端列宽，用于自适应截断
 *   - useAppState：订阅 agent / effortValue 状态
 *   - useMainLoopModel：获取当前主循环模型
 *   - getLogoDisplayData：读取 version / cwd / billingType / agentName
 *   - formatModelAndBilling / truncatePath / truncate：文本裁剪工具
 *   - GuestPassesUpsell / OverageCreditUpsell：促销组件（互斥显示）
 *   - OffscreenFreeze：防止组件进入 scrollback 后因状态变化触发全屏刷新
 */
import { c as _c } from "react/compiler-runtime";
import * as React from 'react';
import { type ReactNode, useEffect } from 'react';
import { useMainLoopModel } from '../../hooks/useMainLoopModel.js';
import { useTerminalSize } from '../../hooks/useTerminalSize.js';
import { stringWidth } from '../../ink/stringWidth.js';
import { Box, Text } from '../../ink.js';
import { useAppState } from '../../state/AppState.js';
import { getEffortSuffix } from '../../utils/effort.js';
import { truncate } from '../../utils/format.js';
import { isFullscreenEnvEnabled } from '../../utils/fullscreen.js';
import { formatModelAndBilling, getLogoDisplayData, truncatePath } from '../../utils/logoV2Utils.js';
import { renderModelSetting } from '../../utils/model/model.js';
import { OffscreenFreeze } from '../OffscreenFreeze.js';
import { AnimatedClawd } from './AnimatedClawd.js';
import { Clawd } from './Clawd.js';
import { GuestPassesUpsell, incrementGuestPassesSeenCount, useShowGuestPassesUpsell } from './GuestPassesUpsell.js';
import { incrementOverageCreditUpsellSeenCount, OverageCreditUpsell, useShowOverageCreditUpsell } from './OverageCreditUpsell.js';

/**
 * CondensedLogo — 精简 Logo 组件（对话列表顶部状态栏）
 *
 * 整体流程：
 *   1. 订阅 terminalSize / appState(agent/effortValue) / mainLoopModel / logoDisplayData
 *   2. 两个 useEffect：
 *      - 当 showGuestPassesUpsell 为真时，递增访客 Pass 曝光计数（槽 0-2）
 *      - 当 showOverageCreditUpsell 且无访客 Pass 时，递增超额积分曝光计数（槽 3-6）
 *   3. 根据终端宽度计算 textWidth（列宽 - 15，最低 20）
 *   4. 截断版本号、模型名称+计费（可拆成两行 shouldSplit）、工作目录
 *   5. 渲染各区块（所有静态节点和依赖不变的节点均从缓存复用）：
 *      - t4（槽 7）：Clawd 或 AnimatedClawd，静态，仅首次创建
 *      - t5（槽 8）：「Claude Code」粗体，静态
 *      - t6（槽 9-10）：标题行（名称 + 版本）
 *      - t7（槽 11-14）：模型 + 计费行（单行或拆两行）
 *      - t9（槽 15-16）：工作目录行（含可选 agentName 前缀）
 *      - t10（槽 17-18）：访客 Pass 促销
 *      - t11（槽 19-22）：超额积分促销（与访客 Pass 互斥）
 *      - t12（槽 23-28）：OffscreenFreeze 包裹的完整布局
 *
 * React Compiler：共 29 个缓存槽（_c(29)）。
 */
export function CondensedLogo() {
  // 29 槽 memoization 缓存
  const $ = _c(29);

  // 终端列宽（用于自适应裁剪）
  const {
    columns
  } = useTerminalSize();

  // 从 AppState 读取 agent（--agent CLI 参数）和 effortValue（努力程度）
  // _temp / _temp2 是 React Compiler 提取的选择器函数（文件末尾定义）
  const agent = useAppState(_temp);
  const effortValue = useAppState(_temp2);

  // 当前主循环模型对象
  const model = useMainLoopModel();
  // 模型的显示名称字符串
  const modelDisplayName = renderModelSetting(model);

  // 从 logoDisplayData 获取版本号、工作目录、计费类型、设置中的 agentName
  const {
    version,
    cwd,
    billingType,
    agentName: agentNameFromSettings
  } = getLogoDisplayData();

  // 优先使用 AppState.agent（来自 --agent CLI 参数），fallback 到 settings 中的 agentName
  const agentName = agent ?? agentNameFromSettings;

  // 是否显示访客 Pass 促销
  const showGuestPassesUpsell = useShowGuestPassesUpsell();
  // 是否显示超额积分促销
  const showOverageCreditUpsell = useShowOverageCreditUpsell();

  // ── 效果 1（槽 0-2）：访客 Pass 曝光计数 ────────────────────────────────
  // 每次组件挂载且 showGuestPassesUpsell 为真时，递增曝光次数（用于频次控制）
  let t0;
  let t1;
  if ($[0] !== showGuestPassesUpsell) {
    t0 = () => {
      if (showGuestPassesUpsell) {
        incrementGuestPassesSeenCount();
      }
    };
    t1 = [showGuestPassesUpsell];
    $[0] = showGuestPassesUpsell;
    $[1] = t0;
    $[2] = t1;
  } else {
    t0 = $[1];
    t1 = $[2];
  }
  useEffect(t0, t1);

  // ── 效果 2（槽 3-6）：超额积分促销曝光计数 ──────────────────────────────
  // 只有在显示超额积分促销且访客 Pass 未显示时才计数（两者互斥，访客 Pass 优先）
  let t2;
  let t3;
  if ($[3] !== showGuestPassesUpsell || $[4] !== showOverageCreditUpsell) {
    t2 = () => {
      if (showOverageCreditUpsell && !showGuestPassesUpsell) {
        incrementOverageCreditUpsellSeenCount();
      }
    };
    t3 = [showOverageCreditUpsell, showGuestPassesUpsell];
    $[3] = showGuestPassesUpsell;
    $[4] = showOverageCreditUpsell;
    $[5] = t2;
    $[6] = t3;
  } else {
    t2 = $[5];
    t3 = $[6];
  }
  useEffect(t2, t3);

  // ── 宽度计算 ─────────────────────────────────────────────────────────────
  // 文本区可用宽度 = 终端列数 - 15（Clawd 图标宽 11 + gap 2 + padding 2），最低 20
  const textWidth = Math.max(columns - 15, 20);

  // 版本号：截断到 textWidth - "Claude Code v" 前缀长度（最低 6 字符）
  const truncatedVersion = truncate(version, Math.max(textWidth - 13, 6));

  // 努力程度后缀（如 ":thinking" 等）
  const effortSuffix = getEffortSuffix(model, effortValue);

  // 模型 + 计费：若总宽度超出则拆成两行（shouldSplit = true）
  const {
    shouldSplit,
    truncatedModel,
    truncatedBilling
  } = formatModelAndBilling(modelDisplayName + effortSuffix, billingType, textWidth);

  // 工作目录可用宽度：若有 agentName，扣减「@agent · 」的宽度
  const cwdAvailableWidth = agentName ? textWidth - 1 - stringWidth(agentName) - 3 : textWidth;
  // 截断工作目录路径
  const truncatedCwd = truncatePath(cwd, Math.max(cwdAvailableWidth, 10));

  // ── 槽 7：Clawd 图标（静态，仅首次创建）───────────────────────────────────
  // isFullscreenEnvEnabled() 在运行时不变，因此该节点为静态
  let t4;
  if ($[7] === Symbol.for("react.memo_cache_sentinel")) {
    t4 = isFullscreenEnvEnabled() ? <AnimatedClawd /> : <Clawd />;
    $[7] = t4;
  } else {
    t4 = $[7];
  }

  // ── 槽 8：「Claude Code」粗体（纯静态）────────────────────────────────────
  let t5;
  if ($[8] === Symbol.for("react.memo_cache_sentinel")) {
    t5 = <Text bold={true}>Claude Code</Text>;
    $[8] = t5;
  } else {
    t5 = $[8];
  }

  // ── 槽 9-10：标题行（名称 + 版本号）──────────────────────────────────────
  let t6;
  if ($[9] !== truncatedVersion) {
    t6 = <Text>{t5}{" "}<Text dimColor={true}>v{truncatedVersion}</Text></Text>;
    $[9] = truncatedVersion;
    $[10] = t6;
  } else {
    t6 = $[10];
  }

  // ── 槽 11-14：模型 + 计费行（单行或拆两行）────────────────────────────────
  let t7;
  if ($[11] !== shouldSplit || $[12] !== truncatedBilling || $[13] !== truncatedModel) {
    // shouldSplit 为真时拆成两行，否则合并为「模型 · 计费」单行
    t7 = shouldSplit ? <><Text dimColor={true}>{truncatedModel}</Text><Text dimColor={true}>{truncatedBilling}</Text></> : <Text dimColor={true}>{truncatedModel} · {truncatedBilling}</Text>;
    $[11] = shouldSplit;
    $[12] = truncatedBilling;
    $[13] = truncatedModel;
    $[14] = t7;
  } else {
    t7 = $[14];
  }

  // 工作目录显示字符串：有 agentName 时前缀「@agent · 」
  const t8 = agentName ? `@${agentName} · ${truncatedCwd}` : truncatedCwd;

  // ── 槽 15-16：工作目录行 ──────────────────────────────────────────────────
  let t9;
  if ($[15] !== t8) {
    t9 = <Text dimColor={true}>{t8}</Text>;
    $[15] = t8;
    $[16] = t9;
  } else {
    t9 = $[16];
  }

  // ── 槽 17-18：访客 Pass 促销组件（条件渲染）──────────────────────────────
  let t10;
  if ($[17] !== showGuestPassesUpsell) {
    t10 = showGuestPassesUpsell && <GuestPassesUpsell />;
    $[17] = showGuestPassesUpsell;
    $[18] = t10;
  } else {
    t10 = $[18];
  }

  // ── 槽 19-22：超额积分促销（与访客 Pass 互斥，访客 Pass 优先）──────────────
  let t11;
  if ($[19] !== showGuestPassesUpsell || $[20] !== showOverageCreditUpsell || $[21] !== textWidth) {
    t11 = !showGuestPassesUpsell && showOverageCreditUpsell && <OverageCreditUpsell maxWidth={textWidth} twoLine={true} />;
    $[19] = showGuestPassesUpsell;
    $[20] = showOverageCreditUpsell;
    $[21] = textWidth;
    $[22] = t11;
  } else {
    t11 = $[22];
  }

  // ── 槽 23-28：完整布局（OffscreenFreeze 包裹）────────────────────────────
  // OffscreenFreeze 说明：Logo 是消息列表顶部第一个进入 scrollback 的组件，
  // useMainLoopModel() 订阅模型变更，getLogoDisplayData() 读取 cwd/订阅状态——
  // 任何一个在 scrollback 中变化都会触发全屏刷新。OffscreenFreeze 阻止这种情况。
  let t12;
  if ($[23] !== t10 || $[24] !== t11 || $[25] !== t6 || $[26] !== t7 || $[27] !== t9) {
    t12 = <OffscreenFreeze><Box flexDirection="row" gap={2} alignItems="center">{t4}<Box flexDirection="column">{t6}{t7}{t9}{t10}{t11}</Box></Box></OffscreenFreeze>;
    $[23] = t10;
    $[24] = t11;
    $[25] = t6;
    $[26] = t7;
    $[27] = t9;
    $[28] = t12;
  } else {
    t12 = $[28];
  }
  return t12;
}

// React Compiler 提取的 useAppState 选择器函数
// 选取 AppState.effortValue（努力程度值）
function _temp2(s_0) {
  return s_0.effortValue;
}

// 选取 AppState.agent（--agent CLI 参数设置的 agent 名称）
function _temp(s) {
  return s.agent;
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJSZWFjdCIsIlJlYWN0Tm9kZSIsInVzZUVmZmVjdCIsInVzZU1haW5Mb29wTW9kZWwiLCJ1c2VUZXJtaW5hbFNpemUiLCJzdHJpbmdXaWR0aCIsIkJveCIsIlRleHQiLCJ1c2VBcHBTdGF0ZSIsImdldEVmZm9ydFN1ZmZpeCIsInRydW5jYXRlIiwiaXNGdWxsc2NyZWVuRW52RW5hYmxlZCIsImZvcm1hdE1vZGVsQW5kQmlsbGluZyIsImdldExvZ29EaXNwbGF5RGF0YSIsInRydW5jYXRlUGF0aCIsInJlbmRlck1vZGVsU2V0dGluZyIsIk9mZnNjcmVlbkZyZWV6ZSIsIkFuaW1hdGVkQ2xhd2QiLCJDbGF3ZCIsIkd1ZXN0UGFzc2VzVXBzZWxsIiwiaW5jcmVtZW50R3Vlc3RQYXNzZXNTZWVuQ291bnQiLCJ1c2VTaG93R3Vlc3RQYXNzZXNVcHNlbGwiLCJpbmNyZW1lbnRPdmVyYWdlQ3JlZGl0VXBzZWxsU2VlbkNvdW50IiwiT3ZlcmFnZUNyZWRpdFVwc2VsbCIsInVzZVNob3dPdmVyYWdlQ3JlZGl0VXBzZWxsIiwiQ29uZGVuc2VkTG9nbyIsIiQiLCJfYyIsImNvbHVtbnMiLCJhZ2VudCIsIl90ZW1wIiwiZWZmb3J0VmFsdWUiLCJfdGVtcDIiLCJtb2RlbCIsIm1vZGVsRGlzcGxheU5hbWUiLCJ2ZXJzaW9uIiwiY3dkIiwiYmlsbGluZ1R5cGUiLCJhZ2VudE5hbWUiLCJhZ2VudE5hbWVGcm9tU2V0dGluZ3MiLCJzaG93R3Vlc3RQYXNzZXNVcHNlbGwiLCJzaG93T3ZlcmFnZUNyZWRpdFVwc2VsbCIsInQwIiwidDEiLCJ0MiIsInQzIiwidGV4dFdpZHRoIiwiTWF0aCIsIm1heCIsInRydW5jYXRlZFZlcnNpb24iLCJlZmZvcnRTdWZmaXgiLCJzaG91bGRTcGxpdCIsInRydW5jYXRlZE1vZGVsIiwidHJ1bmNhdGVkQmlsbGluZyIsImN3ZEF2YWlsYWJsZVdpZHRoIiwidHJ1bmNhdGVkQ3dkIiwidDQiLCJTeW1ib2wiLCJmb3IiLCJ0NSIsInQ2IiwidDciLCJ0OCIsInQ5IiwidDEwIiwidDExIiwidDEyIiwic18wIiwicyJdLCJzb3VyY2VzIjpbIkNvbmRlbnNlZExvZ28udHN4Il0sInNvdXJjZXNDb250ZW50IjpbImltcG9ydCAqIGFzIFJlYWN0IGZyb20gJ3JlYWN0J1xuaW1wb3J0IHsgdHlwZSBSZWFjdE5vZGUsIHVzZUVmZmVjdCB9IGZyb20gJ3JlYWN0J1xuaW1wb3J0IHsgdXNlTWFpbkxvb3BNb2RlbCB9IGZyb20gJy4uLy4uL2hvb2tzL3VzZU1haW5Mb29wTW9kZWwuanMnXG5pbXBvcnQgeyB1c2VUZXJtaW5hbFNpemUgfSBmcm9tICcuLi8uLi9ob29rcy91c2VUZXJtaW5hbFNpemUuanMnXG5pbXBvcnQgeyBzdHJpbmdXaWR0aCB9IGZyb20gJy4uLy4uL2luay9zdHJpbmdXaWR0aC5qcydcbmltcG9ydCB7IEJveCwgVGV4dCB9IGZyb20gJy4uLy4uL2luay5qcydcbmltcG9ydCB7IHVzZUFwcFN0YXRlIH0gZnJvbSAnLi4vLi4vc3RhdGUvQXBwU3RhdGUuanMnXG5pbXBvcnQgeyBnZXRFZmZvcnRTdWZmaXggfSBmcm9tICcuLi8uLi91dGlscy9lZmZvcnQuanMnXG5pbXBvcnQgeyB0cnVuY2F0ZSB9IGZyb20gJy4uLy4uL3V0aWxzL2Zvcm1hdC5qcydcbmltcG9ydCB7IGlzRnVsbHNjcmVlbkVudkVuYWJsZWQgfSBmcm9tICcuLi8uLi91dGlscy9mdWxsc2NyZWVuLmpzJ1xuaW1wb3J0IHtcbiAgZm9ybWF0TW9kZWxBbmRCaWxsaW5nLFxuICBnZXRMb2dvRGlzcGxheURhdGEsXG4gIHRydW5jYXRlUGF0aCxcbn0gZnJvbSAnLi4vLi4vdXRpbHMvbG9nb1YyVXRpbHMuanMnXG5pbXBvcnQgeyByZW5kZXJNb2RlbFNldHRpbmcgfSBmcm9tICcuLi8uLi91dGlscy9tb2RlbC9tb2RlbC5qcydcbmltcG9ydCB7IE9mZnNjcmVlbkZyZWV6ZSB9IGZyb20gJy4uL09mZnNjcmVlbkZyZWV6ZS5qcydcbmltcG9ydCB7IEFuaW1hdGVkQ2xhd2QgfSBmcm9tICcuL0FuaW1hdGVkQ2xhd2QuanMnXG5pbXBvcnQgeyBDbGF3ZCB9IGZyb20gJy4vQ2xhd2QuanMnXG5pbXBvcnQge1xuICBHdWVzdFBhc3Nlc1Vwc2VsbCxcbiAgaW5jcmVtZW50R3Vlc3RQYXNzZXNTZWVuQ291bnQsXG4gIHVzZVNob3dHdWVzdFBhc3Nlc1Vwc2VsbCxcbn0gZnJvbSAnLi9HdWVzdFBhc3Nlc1Vwc2VsbC5qcydcbmltcG9ydCB7XG4gIGluY3JlbWVudE92ZXJhZ2VDcmVkaXRVcHNlbGxTZWVuQ291bnQsXG4gIE92ZXJhZ2VDcmVkaXRVcHNlbGwsXG4gIHVzZVNob3dPdmVyYWdlQ3JlZGl0VXBzZWxsLFxufSBmcm9tICcuL092ZXJhZ2VDcmVkaXRVcHNlbGwuanMnXG5cbmV4cG9ydCBmdW5jdGlvbiBDb25kZW5zZWRMb2dvKCk6IFJlYWN0Tm9kZSB7XG4gIGNvbnN0IHsgY29sdW1ucyB9ID0gdXNlVGVybWluYWxTaXplKClcbiAgY29uc3QgYWdlbnQgPSB1c2VBcHBTdGF0ZShzID0+IHMuYWdlbnQpXG4gIGNvbnN0IGVmZm9ydFZhbHVlID0gdXNlQXBwU3RhdGUocyA9PiBzLmVmZm9ydFZhbHVlKVxuICBjb25zdCBtb2RlbCA9IHVzZU1haW5Mb29wTW9kZWwoKVxuICBjb25zdCBtb2RlbERpc3BsYXlOYW1lID0gcmVuZGVyTW9kZWxTZXR0aW5nKG1vZGVsKVxuICBjb25zdCB7IHZlcnNpb24sIGN3ZCwgYmlsbGluZ1R5cGUsIGFnZW50TmFtZTogYWdlbnROYW1lRnJvbVNldHRpbmdzIH0gPSBnZXRMb2dvRGlzcGxheURhdGEoKVxuXG4gIC8vIFByZWZlciBBcHBTdGF0ZS5hZ2VudCAoc2V0IGZyb20gLS1hZ2VudCBDTEkgZmxhZykgb3ZlciBzZXR0aW5nc1xuICBjb25zdCBhZ2VudE5hbWUgPSBhZ2VudCA/PyBhZ2VudE5hbWVGcm9tU2V0dGluZ3NcbiAgY29uc3Qgc2hvd0d1ZXN0UGFzc2VzVXBzZWxsID0gdXNlU2hvd0d1ZXN0UGFzc2VzVXBzZWxsKClcbiAgY29uc3Qgc2hvd092ZXJhZ2VDcmVkaXRVcHNlbGwgPSB1c2VTaG93T3ZlcmFnZUNyZWRpdFVwc2VsbCgpXG5cbiAgdXNlRWZmZWN0KCgpID0+IHtcbiAgICBpZiAoc2hvd0d1ZXN0UGFzc2VzVXBzZWxsKSB7XG4gICAgICBpbmNyZW1lbnRHdWVzdFBhc3Nlc1NlZW5Db3VudCgpXG4gICAgfVxuICB9LCBbc2hvd0d1ZXN0UGFzc2VzVXBzZWxsXSlcblxuICB1c2VFZmZlY3QoKCkgPT4ge1xuICAgIGlmIChzaG93T3ZlcmFnZUNyZWRpdFVwc2VsbCAmJiAhc2hvd0d1ZXN0UGFzc2VzVXBzZWxsKSB7XG4gICAgICBpbmNyZW1lbnRPdmVyYWdlQ3JlZGl0VXBzZWxsU2VlbkNvdW50KClcbiAgICB9XG4gIH0sIFtzaG93T3ZlcmFnZUNyZWRpdFVwc2VsbCwgc2hvd0d1ZXN0UGFzc2VzVXBzZWxsXSlcblxuICAvLyBDYWxjdWxhdGUgYXZhaWxhYmxlIHdpZHRoIGZvciB0ZXh0IGNvbnRlbnRcbiAgLy8gQWNjb3VudCBmb3I6IGNvbmRlbnNlZCBjbGF3ZCB3aWR0aCAoMTEgY2hhcnMpICsgZ2FwICgyKSArIHBhZGRpbmcgKDIpID0gMTUgY2hhcnNcbiAgY29uc3QgdGV4dFdpZHRoID0gTWF0aC5tYXgoY29sdW1ucyAtIDE1LCAyMClcblxuICAvLyBUcnVuY2F0ZSB2ZXJzaW9uIHRvIGZpdCB3aXRoaW4gYXZhaWxhYmxlIHdpZHRoLCBhY2NvdW50aW5nIGZvciBcIkNsYXVkZSBDb2RlIHZcIiBwcmVmaXhcbiAgY29uc3QgdmVyc2lvblByZWZpeCA9ICdDbGF1ZGUgQ29kZSB2J1xuICBjb25zdCB0cnVuY2F0ZWRWZXJzaW9uID0gdHJ1bmNhdGUoXG4gICAgdmVyc2lvbixcbiAgICBNYXRoLm1heCh0ZXh0V2lkdGggLSB2ZXJzaW9uUHJlZml4Lmxlbmd0aCwgNiksXG4gIClcblxuICBjb25zdCBlZmZvcnRTdWZmaXggPSBnZXRFZmZvcnRTdWZmaXgobW9kZWwsIGVmZm9ydFZhbHVlKVxuICBjb25zdCB7IHNob3VsZFNwbGl0LCB0cnVuY2F0ZWRNb2RlbCwgdHJ1bmNhdGVkQmlsbGluZyB9ID1cbiAgICBmb3JtYXRNb2RlbEFuZEJpbGxpbmcoXG4gICAgICBtb2RlbERpc3BsYXlOYW1lICsgZWZmb3J0U3VmZml4LFxuICAgICAgYmlsbGluZ1R5cGUsXG4gICAgICB0ZXh0V2lkdGgsXG4gICAgKVxuXG4gIC8vIFRydW5jYXRlIHBhdGgsIGFjY291bnRpbmcgZm9yIGFnZW50IG5hbWUgaWYgcHJlc2VudFxuICBjb25zdCBzZXBhcmF0b3IgPSAnIMK3ICdcbiAgY29uc3QgYXRQcmVmaXggPSAnQCdcbiAgY29uc3QgY3dkQXZhaWxhYmxlV2lkdGggPSBhZ2VudE5hbWVcbiAgICA/IHRleHRXaWR0aCAtIGF0UHJlZml4Lmxlbmd0aCAtIHN0cmluZ1dpZHRoKGFnZW50TmFtZSkgLSBzZXBhcmF0b3IubGVuZ3RoXG4gICAgOiB0ZXh0V2lkdGhcbiAgY29uc3QgdHJ1bmNhdGVkQ3dkID0gdHJ1bmNhdGVQYXRoKGN3ZCwgTWF0aC5tYXgoY3dkQXZhaWxhYmxlV2lkdGgsIDEwKSlcblxuICAvLyBPZmZzY3JlZW5GcmVlemU6IHRoZSBsb2dvIHNpdHMgYXQgdGhlIHRvcCBvZiB0aGUgbWVzc2FnZSBsaXN0IGFuZCBpcyB0aGVcbiAgLy8gZmlyc3QgdGhpbmcgdG8gZW50ZXIgc2Nyb2xsYmFjay4gdXNlTWFpbkxvb3BNb2RlbCgpIHN1YnNjcmliZXMgdG8gbW9kZWxcbiAgLy8gY2hhbmdlcyBhbmQgZ2V0TG9nb0Rpc3BsYXlEYXRhKCkgcmVhZHMgZ2V0Q3dkKCkvc3Vic2NyaXB0aW9uIHN0YXRlIOKAlCBhbnlcbiAgLy8gb2Ygd2hpY2ggY2hhbmdpbmcgd2hpbGUgaW4gc2Nyb2xsYmFjayB3b3VsZCBmb3JjZSBhIGZ1bGwgdGVybWluYWwgcmVzZXQuXG4gIHJldHVybiAoXG4gICAgPE9mZnNjcmVlbkZyZWV6ZT5cbiAgICAgIDxCb3ggZmxleERpcmVjdGlvbj1cInJvd1wiIGdhcD17Mn0gYWxpZ25JdGVtcz1cImNlbnRlclwiPlxuICAgICAge2lzRnVsbHNjcmVlbkVudkVuYWJsZWQoKSA/IDxBbmltYXRlZENsYXdkIC8+IDogPENsYXdkIC8+fVxuXG4gICAgICB7LyogSW5mbyAqL31cbiAgICAgIDxCb3ggZmxleERpcmVjdGlvbj1cImNvbHVtblwiPlxuICAgICAgICA8VGV4dD5cbiAgICAgICAgICA8VGV4dCBib2xkPkNsYXVkZSBDb2RlPC9UZXh0PnsnICd9XG4gICAgICAgICAgPFRleHQgZGltQ29sb3I+dnt0cnVuY2F0ZWRWZXJzaW9ufTwvVGV4dD5cbiAgICAgICAgPC9UZXh0PlxuICAgICAgICB7c2hvdWxkU3BsaXQgPyAoXG4gICAgICAgICAgPD5cbiAgICAgICAgICAgIDxUZXh0IGRpbUNvbG9yPnt0cnVuY2F0ZWRNb2RlbH08L1RleHQ+XG4gICAgICAgICAgICA8VGV4dCBkaW1Db2xvcj57dHJ1bmNhdGVkQmlsbGluZ308L1RleHQ+XG4gICAgICAgICAgPC8+XG4gICAgICAgICkgOiAoXG4gICAgICAgICAgPFRleHQgZGltQ29sb3I+XG4gICAgICAgICAgICB7dHJ1bmNhdGVkTW9kZWx9IMK3IHt0cnVuY2F0ZWRCaWxsaW5nfVxuICAgICAgICAgIDwvVGV4dD5cbiAgICAgICAgKX1cbiAgICAgICAgPFRleHQgZGltQ29sb3I+XG4gICAgICAgICAge2FnZW50TmFtZSA/IGBAJHthZ2VudE5hbWV9IMK3ICR7dHJ1bmNhdGVkQ3dkfWAgOiB0cnVuY2F0ZWRDd2R9XG4gICAgICAgIDwvVGV4dD5cbiAgICAgICAge3Nob3dHdWVzdFBhc3Nlc1Vwc2VsbCAmJiA8R3Vlc3RQYXNzZXNVcHNlbGwgLz59XG4gICAgICAgIHshc2hvd0d1ZXN0UGFzc2VzVXBzZWxsICYmIHNob3dPdmVyYWdlQ3JlZGl0VXBzZWxsICYmIChcbiAgICAgICAgICA8T3ZlcmFnZUNyZWRpdFVwc2VsbCBtYXhXaWR0aD17dGV4dFdpZHRofSB0d29MaW5lIC8+XG4gICAgICAgICl9XG4gICAgICA8L0JveD5cbiAgICAgIDwvQm94PlxuICAgIDwvT2Zmc2NyZWVuRnJlZXplPlxuICApXG59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
