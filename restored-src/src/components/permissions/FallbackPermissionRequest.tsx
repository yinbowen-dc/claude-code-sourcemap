/**
 * FallbackPermissionRequest.tsx
 *
 * 【在 Claude Code 权限系统中的位置】
 * 本文件是权限请求系统的通用兜底组件。当某个工具没有对应的专用权限请求 UI 时，
 * 系统将降级使用本组件展示权限确认对话框。它处理所有非特定工具（如 MCP 工具、
 * 未知工具等）的权限申请，向用户提供"是"、"是且不再询问"、"否"三个选项。
 *
 * 【主要功能】
 * - 定义 FallbackOptionValue 类型（yes / yes-dont-ask-again / no）
 * - 渲染通用"Tool use"权限对话框，展示工具名称和操作描述
 * - 处理"是且不再询问"场景：向 localSettings 添加 addRules 永久允许规则
 * - 通过 usePermissionRequestLogging 上报权限请求的 Analytics 与 Unary 事件
 * - 使用 React Compiler 运行时（_c）对渲染结果进行细粒度缓存
 */

import { c as _c } from "react/compiler-runtime";
import React, { useCallback, useMemo } from 'react';
import { getOriginalCwd } from '../../bootstrap/state.js';
import { Box, Text, useTheme } from '../../ink.js';
import { sanitizeToolNameForAnalytics } from '../../services/analytics/metadata.js';
import { env } from '../../utils/env.js';
import { shouldShowAlwaysAllowOptions } from '../../utils/permissions/permissionsLoader.js';
import { truncateToLines } from '../../utils/stringUtils.js';
import { logUnaryEvent } from '../../utils/unaryLogging.js';
import { type UnaryEvent, usePermissionRequestLogging } from './hooks.js';
import { PermissionDialog } from './PermissionDialog.js';
import { PermissionPrompt, type PermissionPromptOption, type ToolAnalyticsContext } from './PermissionPrompt.js';
import type { PermissionRequestProps } from './PermissionRequest.js';
import { PermissionRuleExplanation } from './PermissionRuleExplanation.js';

// 用户在兜底权限对话框中可以选择的操作值类型
type FallbackOptionValue = 'yes' | 'yes-dont-ask-again' | 'no';

/**
 * FallbackPermissionRequest — 通用工具权限请求组件
 *
 * 【渲染流程】
 * 1. 从 toolUseConfirm 中获取工具面向用户的名称（去除 MCP 后缀）
 * 2. 构建 unaryEvent 元数据（completion_type: tool_use_single）
 * 3. 调用 usePermissionRequestLogging 记录权限弹窗展示事件
 * 4. 构建 handleSelect 回调：
 *    - yes：记录 accept 事件，调用 onAllow（无额外规则），关闭对话框
 *    - yes-dont-ask-again：记录 accept 事件，调用 onAllow 并附带 addRules 永久允许规则，关闭对话框
 *    - no：记录 reject 事件，调用 onReject，关闭对话框
 * 5. 构建 handleCancel 回调（Esc/取消）：记录 reject 事件并关闭对话框
 * 6. 根据 shouldShowAlwaysAllowOptions() 决定是否渲染"是且不再询问"选项
 * 7. 渲染 PermissionDialog > 工具调用信息 + PermissionRuleExplanation + PermissionPrompt
 */
export function FallbackPermissionRequest(t0) {
  // React Compiler 缓存槽，共 58 个槽位，用于细粒度 memoization
  const $ = _c(58);
  const {
    toolUseConfirm,      // 工具使用确认上下文（含工具信息、输入参数、回调等）
    onDone,              // 对话框关闭后的通知回调
    onReject,            // 用户拒绝时的通知回调
    workerBadge          // 可选的 Worker 标识徽章
  } = t0;

  // 获取当前主题，用于渲染工具调用消息时的颜色处理
  const [theme] = useTheme();

  // ── 工具面向用户的名称处理 ──────────────────────────────────────────────
  let originalUserFacingName;
  let t1;
  if ($[0] !== toolUseConfirm.input || $[1] !== toolUseConfirm.tool) {
    // 调用工具的 userFacingName() 方法获取原始展示名
    originalUserFacingName = toolUseConfirm.tool.userFacingName(toolUseConfirm.input as never);
    // MCP 工具名称末尾带有 " (MCP)" 后缀，展示时去除该后缀
    t1 = originalUserFacingName.endsWith(" (MCP)") ? originalUserFacingName.slice(0, -6) : originalUserFacingName;
    $[0] = toolUseConfirm.input;
    $[1] = toolUseConfirm.tool;
    $[2] = originalUserFacingName;
    $[3] = t1;
  } else {
    originalUserFacingName = $[2];
    t1 = $[3];
  }
  const userFacingName = t1;  // 去除 MCP 后缀后的展示名称

  // ── Unary 事件元数据（静态常量，仅初始化一次） ─────────────────────────
  let t2;
  if ($[4] === Symbol.for("react.memo_cache_sentinel")) {
    // completion_type 固定为 tool_use_single，language_name 固定为 none
    t2 = {
      completion_type: "tool_use_single",
      language_name: "none"
    };
    $[4] = t2;
  } else {
    t2 = $[4];
  }
  const unaryEvent = t2;

  // 注册权限请求日志钩子，记录 Analytics 展示事件
  usePermissionRequestLogging(toolUseConfirm, unaryEvent);

  // ── handleSelect：处理用户选择操作 ─────────────────────────────────────
  let t3;
  if ($[5] !== onDone || $[6] !== onReject || $[7] !== toolUseConfirm) {
    t3 = (value, feedback) => {
      // 使用带标签的 switch 语句（标签 bb8:），方便在嵌套块中 break 到外层
      bb8: switch (value) {
        case "yes":
          {
            // 用户选择"是"：记录 accept unary 事件
            logUnaryEvent({
              completion_type: "tool_use_single",
              event: "accept",
              metadata: {
                language_name: "none",
                message_id: toolUseConfirm.assistantMessage.message.id,
                platform: env.platform
              }
            });
            // 允许工具执行，不附加额外权限规则
            toolUseConfirm.onAllow(toolUseConfirm.input, [], feedback);
            onDone();
            break bb8;
          }
        case "yes-dont-ask-again":
          {
            // 用户选择"是且不再询问"：记录 accept unary 事件
            logUnaryEvent({
              completion_type: "tool_use_single",
              event: "accept",
              metadata: {
                language_name: "none",
                message_id: toolUseConfirm.assistantMessage.message.id,
                platform: env.platform
              }
            });
            // 允许工具执行，并向 localSettings 添加针对该工具名的永久允许规则
            toolUseConfirm.onAllow(toolUseConfirm.input, [{
              type: "addRules",      // 添加允许规则
              rules: [{
                toolName: toolUseConfirm.tool.name  // 匹配当前工具名
              }],
              behavior: "allow",     // 行为：允许
              destination: "localSettings"  // 保存到用户本地设置（持久化）
            }]);
            onDone();
            break bb8;
          }
        case "no":
          {
            // 用户选择"否"：记录 reject unary 事件
            logUnaryEvent({
              completion_type: "tool_use_single",
              event: "reject",
              metadata: {
                language_name: "none",
                message_id: toolUseConfirm.assistantMessage.message.id,
                platform: env.platform
              }
            });
            // 拒绝工具执行，可携带用户反馈文本
            toolUseConfirm.onReject(feedback);
            onReject();
            onDone();
          }
      }
    };
    $[5] = onDone;
    $[6] = onReject;
    $[7] = toolUseConfirm;
    $[8] = t3;
  } else {
    t3 = $[8];
  }
  const handleSelect = t3;

  // ── handleCancel：处理用户按 Esc 取消操作 ─────────────────────────────
  let t4;
  if ($[9] !== onDone || $[10] !== onReject || $[11] !== toolUseConfirm) {
    t4 = () => {
      // 取消视同拒绝，记录 reject unary 事件
      logUnaryEvent({
        completion_type: "tool_use_single",
        event: "reject",
        metadata: {
          language_name: "none",
          message_id: toolUseConfirm.assistantMessage.message.id,
          platform: env.platform
        }
      });
      toolUseConfirm.onReject();
      onReject();
      onDone();
    };
    $[9] = onDone;
    $[10] = onReject;
    $[11] = toolUseConfirm;
    $[12] = t4;
  } else {
    t4 = $[12];
  }
  const handleCancel = t4;

  // ── 静态常量：当前工作目录（仅在首次渲染时获取） ──────────────────────
  let t5;
  if ($[13] === Symbol.for("react.memo_cache_sentinel")) {
    t5 = getOriginalCwd();  // 获取原始工作目录路径（用于"不再询问"标签展示）
    $[13] = t5;
  } else {
    t5 = $[13];
  }
  const originalCwd = t5;

  // ── 静态常量：是否显示"始终允许"相关选项 ─────────────────────────────
  let t6;
  if ($[14] === Symbol.for("react.memo_cache_sentinel")) {
    t6 = shouldShowAlwaysAllowOptions();  // 由全局配置决定，allowManagedPermissionRulesOnly 为 true 时返回 false
    $[14] = t6;
  } else {
    t6 = $[14];
  }
  const showAlwaysAllowOptions = t6;

  // ── 构建选项列表 ────────────────────────────────────────────────────────
  let t7;
  if ($[15] === Symbol.for("react.memo_cache_sentinel")) {
    // "是"选项（静态，不依赖任何动态属性）
    t7 = {
      label: "Yes",
      value: "yes",
      feedbackConfig: {
        type: "accept"  // 用户确认后展示 accept 反馈输入框
      }
    };
    $[15] = t7;
  } else {
    t7 = $[15];
  }

  let result;
  if ($[16] !== userFacingName) {
    result = [t7];  // 初始化选项数组，首位为"是"选项

    if (showAlwaysAllowOptions) {
      // 构建"是且不再询问"选项的 JSX 标签，展示工具名和当前工作目录
      const t8 = <Text bold={true}>{userFacingName}</Text>;
      let t9;
      if ($[18] === Symbol.for("react.memo_cache_sentinel")) {
        // 工作目录文本为静态节点，仅构建一次
        t9 = <Text bold={true}>{originalCwd}</Text>;
        $[18] = t9;
      } else {
        t9 = $[18];
      }
      let t10;
      if ($[19] !== t8) {
        // 当工具名变化时重新构建"是且不再询问"选项
        t10 = {
          label: <Text>Yes, and don't ask again for {t8}{" "}commands in {t9}</Text>,
          value: "yes-dont-ask-again"
        };
        $[19] = t8;
        $[20] = t10;
      } else {
        t10 = $[20];
      }
      result.push(t10);  // 追加"是且不再询问"选项
    }

    let t8;
    if ($[21] === Symbol.for("react.memo_cache_sentinel")) {
      // "否"选项（静态）
      t8 = {
        label: "No",
        value: "no",
        feedbackConfig: {
          type: "reject"  // 用户拒绝后展示 reject 反馈输入框
        }
      };
      $[21] = t8;
    } else {
      t8 = $[21];
    }
    result.push(t8);  // 追加"否"选项
    $[16] = userFacingName;
    $[17] = result;
  } else {
    result = $[17];
  }
  const options = result;  // 最终选项列表

  // ── 构建 Analytics 上下文（工具名 + 是否 MCP） ──────────────────────────
  let t8;
  if ($[22] !== toolUseConfirm.tool.name) {
    // 对工具名进行脱敏处理（移除路径和敏感信息）
    t8 = sanitizeToolNameForAnalytics(toolUseConfirm.tool.name);
    $[22] = toolUseConfirm.tool.name;
    $[23] = t8;
  } else {
    t8 = $[23];
  }
  const t9 = toolUseConfirm.tool.isMcp ?? false;  // 是否为 MCP 工具
  let t10;
  if ($[24] !== t8 || $[25] !== t9) {
    t10 = {
      toolName: t8,
      isMcp: t9
    };
    $[24] = t8;
    $[25] = t9;
    $[26] = t10;
  } else {
    t10 = $[26];
  }
  const toolAnalyticsContext = t10;

  // ── 渲染工具调用消息（工具自定义的调用内容展示） ──────────────────────
  let t11;
  if ($[27] !== theme || $[28] !== toolUseConfirm.input || $[29] !== toolUseConfirm.tool) {
    // 调用工具的 renderToolUseMessage 方法生成调用内容的可视化表示
    t11 = toolUseConfirm.tool.renderToolUseMessage(toolUseConfirm.input as never, {
      theme,
      verbose: true  // 开启详细模式，展示完整参数信息
    });
    $[27] = theme;
    $[28] = toolUseConfirm.input;
    $[29] = toolUseConfirm.tool;
    $[30] = t11;
  } else {
    t11 = $[30];
  }

  // ── MCP 后缀标记（原始名称带 " (MCP)" 时渲染灰色标注） ──────────────
  let t12;
  if ($[31] !== originalUserFacingName) {
    // 若工具名以 " (MCP)" 结尾，渲染一个灰色的 "(MCP)" 标注
    t12 = originalUserFacingName.endsWith(" (MCP)") ? <Text dimColor={true}> (MCP)</Text> : "";
    $[31] = originalUserFacingName;
    $[32] = t12;
  } else {
    t12 = $[32];
  }

  // ── 工具调用标题行：toolName(args)(MCP?) ────────────────────────────
  let t13;
  if ($[33] !== t11 || $[34] !== t12 || $[35] !== userFacingName) {
    // 格式：工具名(工具调用消息)(可选 MCP 标注)
    t13 = <Text>{userFacingName}({t11}){t12}</Text>;
    $[33] = t11;
    $[34] = t12;
    $[35] = userFacingName;
    $[36] = t13;
  } else {
    t13 = $[36];
  }

  // ── 工具描述文本（截断到最多 3 行） ───────────────────────────────────
  let t14;
  if ($[37] !== toolUseConfirm.description) {
    t14 = truncateToLines(toolUseConfirm.description, 3);  // 超过 3 行时截断
    $[37] = toolUseConfirm.description;
    $[38] = t14;
  } else {
    t14 = $[38];
  }
  let t15;
  if ($[39] !== t14) {
    t15 = <Text dimColor={true}>{t14}</Text>;  // 灰色展示描述文本
    $[39] = t14;
    $[40] = t15;
  } else {
    t15 = $[40];
  }

  // ── 工具信息区域（标题行 + 描述） ─────────────────────────────────────
  let t16;
  if ($[41] !== t13 || $[42] !== t15) {
    t16 = <Box flexDirection="column" paddingX={2} paddingY={1}>{t13}{t15}</Box>;
    $[41] = t13;
    $[42] = t15;
    $[43] = t16;
  } else {
    t16 = $[43];
  }

  // ── 权限规则说明组件（展示当前决策原因和已有规则） ──────────────────
  let t17;
  if ($[44] !== toolUseConfirm.permissionResult) {
    t17 = <PermissionRuleExplanation permissionResult={toolUseConfirm.permissionResult} toolType="tool" />;
    $[44] = toolUseConfirm.permissionResult;
    $[45] = t17;
  } else {
    t17 = $[45];
  }

  // ── 权限提示组件（渲染选项按钮列表） ──────────────────────────────────
  let t18;
  if ($[46] !== handleCancel || $[47] !== handleSelect || $[48] !== options || $[49] !== toolAnalyticsContext) {
    t18 = <PermissionPrompt options={options} onSelect={handleSelect} onCancel={handleCancel} toolAnalyticsContext={toolAnalyticsContext} />;
    $[46] = handleCancel;
    $[47] = handleSelect;
    $[48] = options;
    $[49] = toolAnalyticsContext;
    $[50] = t18;
  } else {
    t18 = $[50];
  }

  // ── 规则说明 + 提示组件的容器 ─────────────────────────────────────────
  let t19;
  if ($[51] !== t17 || $[52] !== t18) {
    t19 = <Box flexDirection="column">{t17}{t18}</Box>;
    $[51] = t17;
    $[52] = t18;
    $[53] = t19;
  } else {
    t19 = $[53];
  }

  // ── 最终渲染：PermissionDialog 包裹工具信息区 + 交互区 ──────────────
  let t20;
  if ($[54] !== t16 || $[55] !== t19 || $[56] !== workerBadge) {
    // 标题固定为 "Tool use"，工具信息在上，规则说明+选项在下
    t20 = <PermissionDialog title="Tool use" workerBadge={workerBadge}>{t16}{t19}</PermissionDialog>;
    $[54] = t16;
    $[55] = t19;
    $[56] = workerBadge;
    $[57] = t20;
  } else {
    t20 = $[57];
  }
  return t20;
}
