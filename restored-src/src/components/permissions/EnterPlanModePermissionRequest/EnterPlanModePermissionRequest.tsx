/**
 * EnterPlanModePermissionRequest.tsx
 *
 * 【在 Claude Code 权限系统中的位置】
 * 本文件负责渲染"进入计划模式"的权限确认对话框。当 Claude 想要切换到 Plan Mode
 * 进行深度探索与方案设计时，系统会弹出本对话框请求用户授权。用户可以选择进入计划
 * 模式（Yes）或直接开始实现（No）。
 *
 * 【主要功能】
 * - 渲染"Enter plan mode?"确认对话框（使用 planMode 主题色）
 * - 展示计划模式的说明文字：Claude 将探索代码库、识别现有模式、设计实现策略并呈现方案
 * - 强调"在用户批准计划前不会进行任何代码修改"的承诺
 * - 处理用户选择：
 *   - Yes → 记录 Analytics 事件，调用 handlePlanModeTransition 切换模式，通知 onDone，传递 setMode 规则
 *   - No → 直接关闭对话框并通知拒绝
 * - 使用 React Compiler 运行时（_c(18)）对渲染结果进行细粒度缓存
 */

import { c as _c } from "react/compiler-runtime";
import React from 'react';
import { handlePlanModeTransition } from '../../../bootstrap/state.js';
import { Box, Text } from '../../../ink.js';
import { type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS, logEvent } from '../../../services/analytics/index.js';
import { useAppState } from '../../../state/AppState.js';
import { isPlanModeInterviewPhaseEnabled } from '../../../utils/planModeV2.js';
import { Select } from '../../CustomSelect/index.js';
import { PermissionDialog } from '../PermissionDialog.js';
import type { PermissionRequestProps } from '../PermissionRequest.js';

/**
 * EnterPlanModePermissionRequest — 进入计划模式的权限请求组件
 *
 * 【渲染流程】
 * 1. 从全局 AppState 中读取当前 toolPermissionContext.mode（用于后续模式切换）
 * 2. 构建 handleResponse 回调，处理 'yes'/'no' 两种用户选择：
 *    - 'yes'：上报 tengu_plan_enter 事件 → 调用 handlePlanModeTransition 切换至 plan 模式
 *            → 通知 onDone → 传递 setMode 权限更新规则（目标为 session）
 *    - 'no'：依次调用 onDone、onReject、toolUseConfirm.onReject
 * 3. 渲染静态说明文本（React Compiler 静态缓存，仅构建一次）
 * 4. 渲染静态选项列表（Yes/No）
 * 5. 将 handleResponse('no') 绑定为 onCancel（Esc 键取消时等同于"否"）
 * 6. 最终包裹在 PermissionDialog color="planMode" 中渲染
 */
export function EnterPlanModePermissionRequest(t0) {
  // React Compiler 缓存槽，共 18 个槽位，用于细粒度 memoization
  const $ = _c(18);
  const {
    toolUseConfirm,    // 工具使用确认上下文（含工具信息、回调等）
    onDone,            // 对话框关闭后的通知回调
    onReject,          // 用户拒绝时的通知回调
    workerBadge        // 可选的 Worker 标识徽章
  } = t0;

  // 从全局状态中获取当前权限上下文模式（如 'default'/'plan'/'autoEdit' 等）
  // 用于 handlePlanModeTransition 执行正确的模式转换逻辑
  const toolPermissionContextMode = useAppState(_temp);

  // ── handleResponse：处理用户选择（'yes' 进入计划模式 / 'no' 拒绝） ──────────
  let t1;
  if ($[0] !== onDone || $[1] !== onReject || $[2] !== toolPermissionContextMode || $[3] !== toolUseConfirm) {
    t1 = function handleResponse(value) {
      if (value === "yes") {
        // 用户选择进入计划模式：先上报 Analytics 事件，记录进入方式和面试阶段状态
        logEvent("tengu_plan_enter", {
          interviewPhaseEnabled: isPlanModeInterviewPhaseEnabled(),  // 是否开启面试阶段（PlanModeV2 特性）
          entryMethod: "tool" as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS  // 进入方式：通过工具调用触发
        });
        // 执行计划模式切换（更新全局状态和 UI 表现）
        handlePlanModeTransition(toolPermissionContextMode, "plan");
        // 通知父组件对话框已完成（关闭弹窗）
        onDone();
        // 传递 setMode 权限规则，将会话模式设置为 'plan'，生效范围为当前 session
        toolUseConfirm.onAllow({}, [{
          type: "setMode",      // 规则类型：设置模式
          mode: "plan",         // 目标模式：计划模式
          destination: "session"  // 生效范围：仅当前会话（不持久化到 localSettings）
        }]);
      } else {
        // 用户选择不进入计划模式：依次关闭对话框、通知拒绝、告知工具被拒
        onDone();
        onReject();
        toolUseConfirm.onReject();
      }
    };
    // 当任意依赖项变化时，重新构建 handleResponse 并更新缓存
    $[0] = onDone;
    $[1] = onReject;
    $[2] = toolPermissionContextMode;
    $[3] = toolUseConfirm;
    $[4] = t1;
  } else {
    t1 = $[4];
  }
  const handleResponse = t1;

  // ── 静态文本节点（React Compiler 标记为常量，仅在首次渲染时构建） ──────────

  // 主说明文字：告知用户 Claude 想要进入计划模式进行方案设计
  let t2;
  if ($[5] === Symbol.for("react.memo_cache_sentinel")) {
    t2 = <Text>Claude wants to enter plan mode to explore and design an implementation approach.</Text>;
    $[5] = t2;
  } else {
    t2 = $[5];
  }

  // 计划模式行为说明列表（用 · 符号列出 4 项行为说明）
  let t3;
  if ($[6] === Symbol.for("react.memo_cache_sentinel")) {
    t3 = <Box marginTop={1} flexDirection="column">
      <Text dimColor={true}>In plan mode, Claude will:</Text>
      <Text dimColor={true}> · Explore the codebase thoroughly</Text>      {/* 彻底探索代码库 */}
      <Text dimColor={true}> · Identify existing patterns</Text>           {/* 识别已有模式 */}
      <Text dimColor={true}> · Design an implementation strategy</Text>    {/* 设计实现策略 */}
      <Text dimColor={true}> · Present a plan for your approval</Text>     {/* 呈现方案供批准 */}
    </Box>;
    $[6] = t3;
  } else {
    t3 = $[6];
  }

  // 关键承诺说明：在用户批准计划前不会进行任何代码修改
  let t4;
  if ($[7] === Symbol.for("react.memo_cache_sentinel")) {
    t4 = <Box marginTop={1}><Text dimColor={true}>No code changes will be made until you approve the plan.</Text></Box>;
    $[7] = t4;
  } else {
    t4 = $[7];
  }

  // ── 静态选项：Yes（进入计划模式） ────────────────────────────────────────
  let t5;
  if ($[8] === Symbol.for("react.memo_cache_sentinel")) {
    t5 = {
      label: "Yes, enter plan mode",
      value: "yes" as const  // TypeScript 字面量类型
    };
    $[8] = t5;
  } else {
    t5 = $[8];
  }

  // ── 静态选项数组：[Yes, No]（两个选项均为静态常量，仅构建一次） ──────────
  let t6;
  if ($[9] === Symbol.for("react.memo_cache_sentinel")) {
    t6 = [t5, {
      label: "No, start implementing now",  // 否：直接开始实现
      value: "no" as const
    }];
    $[9] = t6;
  } else {
    t6 = $[9];
  }

  // ── onCancel 回调：Esc 取消时等同于选择 'no' ──────────────────────────────
  let t7;
  if ($[10] !== handleResponse) {
    // 将 handleResponse('no') 绑定为取消处理函数
    t7 = () => handleResponse("no");
    $[10] = handleResponse;
    $[11] = t7;
  } else {
    t7 = $[11];
  }

  // ── 完整内容区域：说明文字 + 选项列表 ────────────────────────────────────
  let t8;
  if ($[12] !== handleResponse || $[13] !== t7) {
    t8 = <Box flexDirection="column" marginTop={1} paddingX={1}>
      {t2}   {/* 主说明文字 */}
      {t3}   {/* 计划模式行为说明列表 */}
      {t4}   {/* 无代码修改承诺 */}
      <Box marginTop={1}>
        <Select
          options={t6}           // 静态选项列表 [Yes, No]
          onChange={handleResponse}  // 用户确认时触发
          onCancel={t7}          // Esc 取消时触发（等同于 No）
        />
      </Box>
    </Box>;
    $[12] = handleResponse;
    $[13] = t7;
    $[14] = t8;
  } else {
    t8 = $[14];
  }

  // ── 最终渲染：使用 planMode 主题色的 PermissionDialog 包裹内容 ────────────
  let t9;
  if ($[15] !== t8 || $[16] !== workerBadge) {
    // color="planMode" 使对话框使用计划模式专属主题色渲染
    t9 = <PermissionDialog color="planMode" title="Enter plan mode?" workerBadge={workerBadge}>{t8}</PermissionDialog>;
    $[15] = t8;
    $[16] = workerBadge;
    $[17] = t9;
  } else {
    t9 = $[17];
  }
  return t9;
}

/**
 * _temp — AppState 选择器函数
 *
 * 从全局 AppState 中提取 toolPermissionContext.mode 字段。
 * 作为独立函数定义（而非内联箭头函数），可避免每次渲染时创建新的函数引用，
 * 防止 useAppState 订阅因引用变化而不必要地重新触发。
 */
function _temp(s) {
  return s.toolPermissionContext.mode;
}
