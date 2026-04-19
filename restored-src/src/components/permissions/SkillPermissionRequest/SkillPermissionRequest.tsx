/**
 * SkillPermissionRequest.tsx
 *
 * 【第一层：文件说明】
 * 本文件实现 Skill 工具（/skill 命令）的权限请求对话框组件。
 * 当 Claude 尝试调用用户定义的 Skill（技能）时，系统会暂停执行并显示此对话框，
 * 等待用户确认是否允许。
 *
 * 在整体权限流程中的位置：
 *   Claude 决定使用某个 Skill
 *     → 权限系统检测到需要用户确认（behavior === "ask"）
 *       → PermissionRequest 路由到本组件
 *         → 用户选择 yes / yes-exact / yes-prefix / no
 *           → 触发 onAllow / onReject 回调，携带可选的永久规则
 *
 * 选项说明：
 *   - yes          仅本次允许，不保存规则
 *   - yes-exact    永久允许该精确 skill 命令（保存至 localSettings）
 *   - yes-prefix   永久允许该命令前缀的所有 skill（保存至 localSettings）
 *   - no           拒绝本次请求
 *
 * 注意：本文件经过 React Compiler 优化，使用 _c() 缓存槽进行细粒度 memoization。
 */

import { c as _c } from "react/compiler-runtime";
import React, { useCallback, useMemo } from 'react';
import { logError } from 'src/utils/log.js';
import { getOriginalCwd } from '../../../bootstrap/state.js';
import { Box, Text } from '../../../ink.js';
import { sanitizeToolNameForAnalytics } from '../../../services/analytics/metadata.js';
import { SKILL_TOOL_NAME } from '../../../tools/SkillTool/constants.js';
import { SkillTool } from '../../../tools/SkillTool/SkillTool.js';
import { env } from '../../../utils/env.js';
import { shouldShowAlwaysAllowOptions } from '../../../utils/permissions/permissionsLoader.js';
import { logUnaryEvent } from '../../../utils/unaryLogging.js';
import { type UnaryEvent, usePermissionRequestLogging } from '../hooks.js';
import { PermissionDialog } from '../PermissionDialog.js';
import { PermissionPrompt, type PermissionPromptOption, type ToolAnalyticsContext } from '../PermissionPrompt.js';
import type { PermissionRequestProps } from '../PermissionRequest.js';
import { PermissionRuleExplanation } from '../PermissionRuleExplanation.js';

// Skill 权限对话框的选项值类型
type SkillOptionValue = 'yes' | 'yes-exact' | 'yes-prefix' | 'no';

/**
 * 【第二层：组件说明】
 * SkillPermissionRequest — Skill 工具权限请求的主组件。
 *
 * 渲染流程：
 *   1. 解析 toolUseConfirm.input 获取 skill 字符串
 *   2. 从 permissionResult.metadata 中读取可选的命令描述（commandObj）
 *   3. 根据 shouldShowAlwaysAllowOptions() 决定是否展示永久允许选项
 *   4. 构建选项列表（baseOptions + alwaysAllowOptions + noOption）
 *   5. 渲染 PermissionDialog，内含说明文字、规则解释和 PermissionPrompt
 *
 * 注意：整个组件体使用 React Compiler 生成的 _c(51) 缓存，
 *       所有依赖发生变化时才重新计算对应的值。
 */
export function SkillPermissionRequest(props) {
  // React Compiler 生成的 51 个缓存槽，用于精细粒度 memoization
  const $ = _c(51);
  const {
    toolUseConfirm,
    onDone,
    onReject,
    workerBadge
  } = props;

  // _temp 是提升到模块级的纯函数（避免每次渲染重新创建），用于解析 skill 输入
  const parseInput = _temp;

  // ── 缓存槽 [0][1]：当 toolUseConfirm.input 变化时重新解析 skill 字符串 ──
  let t0;
  if ($[0] !== toolUseConfirm.input) {
    t0 = parseInput(toolUseConfirm.input);
    $[0] = toolUseConfirm.input;
    $[1] = t0;
  } else {
    t0 = $[1];
  }
  // skill：解析后的技能标识符字符串（如 "search query"）
  const skill = t0;

  // 从 permissionResult 的 metadata 中读取命令对象（如有），用于显示描述文字
  const commandObj = toolUseConfirm.permissionResult.behavior === "ask" && toolUseConfirm.permissionResult.metadata && "command" in toolUseConfirm.permissionResult.metadata ? toolUseConfirm.permissionResult.metadata.command : undefined;

  // ── 缓存槽 [2]：unaryEvent 对象，仅在首次渲染时创建（空依赖） ──
  let t1;
  if ($[2] === Symbol.for("react.memo_cache_sentinel")) {
    t1 = {
      completion_type: "tool_use_single",
      language_name: "none"
    };
    $[2] = t1;
  } else {
    t1 = $[2];
  }
  // unaryEvent：用于 usePermissionRequestLogging 的事件上下文配置
  const unaryEvent = t1;

  // 注册权限请求日志钩子，在组件挂载时记录 "shown" 事件
  usePermissionRequestLogging(toolUseConfirm, unaryEvent);

  // ── 缓存槽 [3]：originalCwd 只读取一次 ──
  let t2;
  if ($[3] === Symbol.for("react.memo_cache_sentinel")) {
    t2 = getOriginalCwd();
    $[3] = t2;
  } else {
    t2 = $[3];
  }
  // originalCwd：启动时的工作目录，显示在 "don't ask again" 标签中
  const originalCwd = t2;

  // ── 缓存槽 [4]：shouldShowAlwaysAllowOptions 只调用一次 ──
  let t3;
  if ($[4] === Symbol.for("react.memo_cache_sentinel")) {
    t3 = shouldShowAlwaysAllowOptions();
    $[4] = t3;
  } else {
    t3 = $[4];
  }
  // showAlwaysAllowOptions：若环境为 allowManagedPermissionRulesOnly 则为 false，
  // 此时不展示 yes-exact / yes-prefix 选项
  const showAlwaysAllowOptions = t3;

  // ── 缓存槽 [5]：baseOptions 固定不变，只有一个 "Yes" 选项 ──
  let t4;
  if ($[5] === Symbol.for("react.memo_cache_sentinel")) {
    t4 = [{
      label: "Yes",
      value: "yes",
      feedbackConfig: {
        type: "accept"
      }
    }];
    $[5] = t4;
  } else {
    t4 = $[5];
  }
  const baseOptions = t4;

  // ── 缓存槽 [6][7]：alwaysAllowOptions 当 skill 变化时重新构建 ──
  let alwaysAllowOptions;
  if ($[6] !== skill) {
    alwaysAllowOptions = [];
    if (showAlwaysAllowOptions) {
      // 构建 yes-exact 选项：精确匹配当前 skill 命令
      const t5 = <Text bold={true}>{skill}</Text>;
      let t6;
      if ($[8] === Symbol.for("react.memo_cache_sentinel")) {
        // originalCwd 不变，对应的 Text 节点也缓存起来
        t6 = <Text bold={true}>{originalCwd}</Text>;
        $[8] = t6;
      } else {
        t6 = $[8];
      }
      let t7;
      if ($[9] !== t5) {
        // t5（skill 文本节点）变化时重建 yes-exact 选项对象
        t7 = {
          label: <Text>Yes, and don't ask again for {t5} in{" "}{t6}</Text>,
          value: "yes-exact"
        };
        $[9] = t5;
        $[10] = t7;
      } else {
        t7 = $[10];
      }
      alwaysAllowOptions.push(t7);

      // 若 skill 包含空格，说明有参数，额外提供 yes-prefix 选项（匹配命令前缀 + :*）
      const spaceIndex = skill.indexOf(" ");
      if (spaceIndex > 0) {
        // 提取命令前缀（空格前的部分），生成 "prefix:*" 通配符规则
        const commandPrefix = skill.substring(0, spaceIndex);
        const t8 = commandPrefix + ":*";
        let t9;
        if ($[11] !== t8) {
          t9 = <Text bold={true}>{t8}</Text>;
          $[11] = t8;
          $[12] = t9;
        } else {
          t9 = $[12];
        }
        let t10;
        if ($[13] === Symbol.for("react.memo_cache_sentinel")) {
          // originalCwd 对应的 Text 节点只创建一次
          t10 = <Text bold={true}>{originalCwd}</Text>;
          $[13] = t10;
        } else {
          t10 = $[13];
        }
        let t11;
        if ($[14] !== t9) {
          // t9（前缀通配符文本）变化时重建 yes-prefix 选项对象
          t11 = {
            label: <Text>Yes, and don't ask again for{" "}{t9} commands in{" "}{t10}</Text>,
            value: "yes-prefix"
          };
          $[14] = t9;
          $[15] = t11;
        } else {
          t11 = $[15];
        }
        alwaysAllowOptions.push(t11);
      }
    }
    $[6] = skill;
    $[7] = alwaysAllowOptions;
  } else {
    alwaysAllowOptions = $[7];
  }

  // ── 缓存槽 [16]：noOption 固定不变 ──
  let t5;
  if ($[16] === Symbol.for("react.memo_cache_sentinel")) {
    t5 = {
      label: "No",
      value: "no",
      feedbackConfig: {
        type: "reject"
      }
    };
    $[16] = t5;
  } else {
    t5 = $[16];
  }
  const noOption = t5;

  // ── 缓存槽 [17][18]：当 alwaysAllowOptions 变化时重新合并完整选项列表 ──
  let t6;
  if ($[17] !== alwaysAllowOptions) {
    t6 = [...baseOptions, ...alwaysAllowOptions, noOption];
    $[17] = alwaysAllowOptions;
    $[18] = t6;
  } else {
    t6 = $[18];
  }
  const options = t6;

  // ── 缓存槽 [19][20]：当工具名称变化时重新生成分析工具名（已过滤 PII）──
  let t7;
  if ($[19] !== toolUseConfirm.tool.name) {
    t7 = sanitizeToolNameForAnalytics(toolUseConfirm.tool.name);
    $[19] = toolUseConfirm.tool.name;
    $[20] = t7;
  } else {
    t7 = $[20];
  }
  // isMcp：是否为 MCP 工具，用于分析事件上下文
  const t8 = toolUseConfirm.tool.isMcp ?? false;

  // ── 缓存槽 [21~23]：当工具名或 isMcp 变化时重建 toolAnalyticsContext ──
  let t9;
  if ($[21] !== t7 || $[22] !== t8) {
    t9 = {
      toolName: t7,
      isMcp: t8
    };
    $[21] = t7;
    $[22] = t8;
    $[23] = t9;
  } else {
    t9 = $[23];
  }
  const toolAnalyticsContext = t9;

  // ── 缓存槽 [24~28]：handleSelect 当关键依赖变化时重新创建 ──
  let t10;
  if ($[24] !== onDone || $[25] !== onReject || $[26] !== skill || $[27] !== toolUseConfirm) {
    /**
     * 【第二层：handleSelect 说明】
     * 用户选择某个选项时的回调。根据选项值执行不同动作：
     *   - yes       → 记录 accept 事件 + 仅本次允许（onAllow 不传规则）
     *   - yes-exact → 记录 accept 事件 + 允许并保存精确匹配规则到 localSettings
     *   - yes-prefix→ 记录 accept 事件 + 允许并保存前缀通配符规则到 localSettings
     *   - no        → 记录 reject 事件 + 调用 onReject
     * 所有分支最终都调用 onDone() 关闭对话框。
     */
    t10 = (value, feedback) => {
      bb33: switch (value) {
        case "yes":
          {
            // 记录用户接受的分析事件（仅本次）
            logUnaryEvent({
              completion_type: "tool_use_single",
              event: "accept",
              metadata: {
                language_name: "none",
                message_id: toolUseConfirm.assistantMessage.message.id,
                platform: env.platform
              }
            });
            // 允许执行，不传永久规则
            toolUseConfirm.onAllow(toolUseConfirm.input, [], feedback);
            onDone();
            break bb33;
          }
        case "yes-exact":
          {
            // 记录接受事件
            logUnaryEvent({
              completion_type: "tool_use_single",
              event: "accept",
              metadata: {
                language_name: "none",
                message_id: toolUseConfirm.assistantMessage.message.id,
                platform: env.platform
              }
            });
            // 允许执行，并将精确 skill 名保存为永久规则
            toolUseConfirm.onAllow(toolUseConfirm.input, [{
              type: "addRules",
              rules: [{
                toolName: SKILL_TOOL_NAME,
                ruleContent: skill // 精确匹配当前 skill 字符串
              }],
              behavior: "allow",
              destination: "localSettings" // 保存到用户本地设置
            }]);
            onDone();
            break bb33;
          }
        case "yes-prefix":
          {
            // 记录接受事件
            logUnaryEvent({
              completion_type: "tool_use_single",
              event: "accept",
              metadata: {
                language_name: "none",
                message_id: toolUseConfirm.assistantMessage.message.id,
                platform: env.platform
              }
            });
            // 提取命令前缀（空格前部分），若无空格则使用完整 skill 名
            const spaceIndex_0 = skill.indexOf(" ");
            const commandPrefix_0 = spaceIndex_0 > 0 ? skill.substring(0, spaceIndex_0) : skill;
            // 允许执行，并将 "prefix:*" 模式保存为永久规则
            toolUseConfirm.onAllow(toolUseConfirm.input, [{
              type: "addRules",
              rules: [{
                toolName: SKILL_TOOL_NAME,
                ruleContent: `${commandPrefix_0}:*` // 前缀通配符，匹配该命令的所有子命令
              }],
              behavior: "allow",
              destination: "localSettings"
            }]);
            onDone();
            break bb33;
          }
        case "no":
          {
            // 记录拒绝事件
            logUnaryEvent({
              completion_type: "tool_use_single",
              event: "reject",
              metadata: {
                language_name: "none",
                message_id: toolUseConfirm.assistantMessage.message.id,
                platform: env.platform
              }
            });
            // 拒绝执行，可选传入用户反馈文字
            toolUseConfirm.onReject(feedback);
            onReject();
            onDone();
          }
      }
    };
    $[24] = onDone;
    $[25] = onReject;
    $[26] = skill;
    $[27] = toolUseConfirm;
    $[28] = t10;
  } else {
    t10 = $[28];
  }
  const handleSelect = t10;

  // ── 缓存槽 [29~32]：handleCancel 当关键依赖变化时重新创建 ──
  let t11;
  if ($[29] !== onDone || $[30] !== onReject || $[31] !== toolUseConfirm) {
    /**
     * 【第二层：handleCancel 说明】
     * 用户按 ESC 或取消对话框时调用。
     * 等价于选择 "no" 但不传入 feedback，直接记录 reject 事件并关闭。
     */
    t11 = () => {
      // 记录取消（reject）事件
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
    $[29] = onDone;
    $[30] = onReject;
    $[31] = toolUseConfirm;
    $[32] = t11;
  } else {
    t11 = $[32];
  }
  const handleCancel = t11;

  // ── 对话框标题：使用模板字符串展示 skill 名 ──
  const t12 = `Use skill "${skill}"?`;

  // ── 缓存槽 [33]：固定的说明文字节点 ──
  let t13;
  if ($[33] === Symbol.for("react.memo_cache_sentinel")) {
    t13 = <Text>Claude may use instructions, code, or files from this Skill.</Text>;
    $[33] = t13;
  } else {
    t13 = $[33];
  }

  // ── 缓存槽 [34][35]：commandObj 描述文字，当 description 变化时重建 ──
  const t14 = commandObj?.description;
  let t15;
  if ($[34] !== t14) {
    // 以灰色（dimColor）显示命令描述，适度降低视觉优先级
    t15 = <Box flexDirection="column" paddingX={2} paddingY={1}><Text dimColor={true}>{t14}</Text></Box>;
    $[34] = t14;
    $[35] = t15;
  } else {
    t15 = $[35];
  }

  // ── 缓存槽 [36][37]：规则解释组件，当 permissionResult 变化时重建 ──
  let t16;
  if ($[36] !== toolUseConfirm.permissionResult) {
    // PermissionRuleExplanation 用于显示当前规则匹配情况（如已有部分规则）
    t16 = <PermissionRuleExplanation permissionResult={toolUseConfirm.permissionResult} toolType="tool" />;
    $[36] = toolUseConfirm.permissionResult;
    $[37] = t16;
  } else {
    t16 = $[37];
  }

  // ── 缓存槽 [38~42]：PermissionPrompt，当相关依赖变化时重建 ──
  let t17;
  if ($[38] !== handleCancel || $[39] !== handleSelect || $[40] !== options || $[41] !== toolAnalyticsContext) {
    // 渲染选项列表和按钮，处理用户的选择和取消事件
    t17 = <PermissionPrompt options={options} onSelect={handleSelect} onCancel={handleCancel} toolAnalyticsContext={toolAnalyticsContext} />;
    $[38] = handleCancel;
    $[39] = handleSelect;
    $[40] = options;
    $[41] = toolAnalyticsContext;
    $[42] = t17;
  } else {
    t17 = $[42];
  }

  // ── 缓存槽 [43~45]：规则解释 + 选项列表的容器 ──
  let t18;
  if ($[43] !== t16 || $[44] !== t17) {
    t18 = <Box flexDirection="column">{t16}{t17}</Box>;
    $[43] = t16;
    $[44] = t17;
    $[45] = t18;
  } else {
    t18 = $[45];
  }

  // ── 缓存槽 [46~50]：最外层 PermissionDialog，当标题/徽章/内容变化时重建 ──
  let t19;
  if ($[46] !== t12 || $[47] !== t15 || $[48] !== t18 || $[49] !== workerBadge) {
    t19 = <PermissionDialog title={t12} workerBadge={workerBadge}>{t13}{t15}{t18}</PermissionDialog>;
    $[46] = t12;
    $[47] = t15;
    $[48] = t18;
    $[49] = workerBadge;
    $[50] = t19;
  } else {
    t19 = $[50];
  }
  return t19;
}

/**
 * 【第二层：_temp 函数说明】
 * 解析 SkillTool 的输入数据，提取 skill 字符串。
 * 该函数被提升到模块顶层（由 React Compiler 优化），避免在组件每次渲染时重新创建。
 *
 * 解析流程：
 *   1. 使用 SkillTool.inputSchema.safeParse 验证输入格式
 *   2. 若解析失败，记录错误日志并返回空字符串（降级处理）
 *   3. 若解析成功，返回 result.data.skill 字段值
 */
function _temp(input) {
  // 使用 Zod schema 安全解析，避免抛出异常
  const result = SkillTool.inputSchema.safeParse(input);
  if (!result.success) {
    // 解析失败时记录错误，UI 仍正常展示（使用空字符串 skill 名）
    logError(new Error(`Failed to parse skill tool input: ${result.error.message}`));
    return "";
  }
  // 返回解析出的 skill 字段（技能标识符字符串）
  return result.data.skill;
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJSZWFjdCIsInVzZUNhbGxiYWNrIiwidXNlTWVtbyIsImxvZ0Vycm9yIiwiZ2V0T3JpZ2luYWxDd2QiLCJCb3giLCJUZXh0Iiwic2FuaXRpemVUb29sTmFtZUZvckFuYWx5dGljcyIsIlNLSUxMX1RPT0xfTkFNRSIsIlNraWxsVG9vbCIsImVudiIsInNob3VsZFNob3dBbHdheXNBbGxvd09wdGlvbnMiLCJsb2dVbmFyeUV2ZW50IiwiVW5hcnlFdmVudCIsInVzZVBlcm1pc3Npb25SZXF1ZXN0TG9nZ2luZyIsIlBlcm1pc3Npb25EaWFsb2ciLCJQZXJtaXNzaW9uUHJvbXB0IiwiUGVybWlzc2lvblByb21wdE9wdGlvbiIsIlRvb2xBbmFseXRpY3NDb250ZXh0IiwiUGVybWlzc2lvblJlcXVlc3RQcm9wcyIsIlBlcm1pc3Npb25SdWxlRXhwbGFuYXRpb24iLCJTa2lsbE9wdGlvblZhbHVlIiwiU2tpbGxQZXJtaXNzaW9uUmVxdWVzdCIsInByb3BzIiwiJCIsIl9jIiwidG9vbFVzZUNvbmZpcm0iLCJvbkRvbmUiLCJvblJlamVjdCIsIndvcmtlckJhZGdlIiwicGFyc2VJbnB1dCIsIl90ZW1wIiwidDAiLCJpbnB1dCIsInNraWxsIiwiY29tbWFuZE9iaiIsInBlcm1pc3Npb25SZXN1bHQiLCJiZWhhdmlvciIsIm1ldGFkYXRhIiwiY29tbWFuZCIsInVuZGVmaW5lZCIsInQxIiwiU3ltYm9sIiwiZm9yIiwiY29tcGxldGlvbl90eXBlIiwibGFuZ3VhZ2VfbmFtZSIsInVuYXJ5RXZlbnQiLCJ0MiIsIm9yaWdpbmFsQ3dkIiwidDMiLCJzaG93QWx3YXlzQWxsb3dPcHRpb25zIiwidDQiLCJsYWJlbCIsInZhbHVlIiwiZmVlZGJhY2tDb25maWciLCJ0eXBlIiwiYmFzZU9wdGlvbnMiLCJhbHdheXNBbGxvd09wdGlvbnMiLCJ0NSIsInQ2IiwidDciLCJwdXNoIiwic3BhY2VJbmRleCIsImluZGV4T2YiLCJjb21tYW5kUHJlZml4Iiwic3Vic3RyaW5nIiwidDgiLCJ0OSIsInQxMCIsInQxMSIsIm5vT3B0aW9uIiwib3B0aW9ucyIsInRvb2wiLCJuYW1lIiwiaXNNY3AiLCJ0b29sTmFtZSIsInRvb2xBbmFseXRpY3NDb250ZXh0IiwiZmVlZGJhY2siLCJiYjMzIiwiZXZlbnQiLCJtZXNzYWdlX2lkIiwiYXNzaXN0YW50TWVzc2FnZSIsIm1lc3NhZ2UiLCJpZCIsInBsYXRmb3JtIiwib25BbGxvdyIsInJ1bGVzIiwicnVsZUNvbnRlbnQiLCJkZXN0aW5hdGlvbiIsInNwYWNlSW5kZXhfMCIsImNvbW1hbmRQcmVmaXhfMCIsImhhbmRsZVNlbGVjdCIsImhhbmRsZUNhbmNlbCIsInQxMiIsInQxMyIsInQxNCIsImRlc2NyaXB0aW9uIiwidDE1IiwidDE2IiwidDE3IiwidDE4IiwidDE5IiwicmVzdWx0IiwiaW5wdXRTY2hlbWEiLCJzYWZlUGFyc2UiLCJzdWNjZXNzIiwiRXJyb3IiLCJlcnJvciIsImRhdGEiXSwic291cmNlcyI6WyJTa2lsbFBlcm1pc3Npb25SZXF1ZXN0LnRzeCJdLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgUmVhY3QsIHsgdXNlQ2FsbGJhY2ssIHVzZU1lbW8gfSBmcm9tICdyZWFjdCdcbmltcG9ydCB7IGxvZ0Vycm9yIH0gZnJvbSAnc3JjL3V0aWxzL2xvZy5qcydcbmltcG9ydCB7IGdldE9yaWdpbmFsQ3dkIH0gZnJvbSAnLi4vLi4vLi4vYm9vdHN0cmFwL3N0YXRlLmpzJ1xuaW1wb3J0IHsgQm94LCBUZXh0IH0gZnJvbSAnLi4vLi4vLi4vaW5rLmpzJ1xuaW1wb3J0IHsgc2FuaXRpemVUb29sTmFtZUZvckFuYWx5dGljcyB9IGZyb20gJy4uLy4uLy4uL3NlcnZpY2VzL2FuYWx5dGljcy9tZXRhZGF0YS5qcydcbmltcG9ydCB7IFNLSUxMX1RPT0xfTkFNRSB9IGZyb20gJy4uLy4uLy4uL3Rvb2xzL1NraWxsVG9vbC9jb25zdGFudHMuanMnXG5pbXBvcnQgeyBTa2lsbFRvb2wgfSBmcm9tICcuLi8uLi8uLi90b29scy9Ta2lsbFRvb2wvU2tpbGxUb29sLmpzJ1xuaW1wb3J0IHsgZW52IH0gZnJvbSAnLi4vLi4vLi4vdXRpbHMvZW52LmpzJ1xuaW1wb3J0IHsgc2hvdWxkU2hvd0Fsd2F5c0FsbG93T3B0aW9ucyB9IGZyb20gJy4uLy4uLy4uL3V0aWxzL3Blcm1pc3Npb25zL3Blcm1pc3Npb25zTG9hZGVyLmpzJ1xuaW1wb3J0IHsgbG9nVW5hcnlFdmVudCB9IGZyb20gJy4uLy4uLy4uL3V0aWxzL3VuYXJ5TG9nZ2luZy5qcydcbmltcG9ydCB7IHR5cGUgVW5hcnlFdmVudCwgdXNlUGVybWlzc2lvblJlcXVlc3RMb2dnaW5nIH0gZnJvbSAnLi4vaG9va3MuanMnXG5pbXBvcnQgeyBQZXJtaXNzaW9uRGlhbG9nIH0gZnJvbSAnLi4vUGVybWlzc2lvbkRpYWxvZy5qcydcbmltcG9ydCB7XG4gIFBlcm1pc3Npb25Qcm9tcHQsXG4gIHR5cGUgUGVybWlzc2lvblByb21wdE9wdGlvbixcbiAgdHlwZSBUb29sQW5hbHl0aWNzQ29udGV4dCxcbn0gZnJvbSAnLi4vUGVybWlzc2lvblByb21wdC5qcydcbmltcG9ydCB0eXBlIHsgUGVybWlzc2lvblJlcXVlc3RQcm9wcyB9IGZyb20gJy4uL1Blcm1pc3Npb25SZXF1ZXN0LmpzJ1xuaW1wb3J0IHsgUGVybWlzc2lvblJ1bGVFeHBsYW5hdGlvbiB9IGZyb20gJy4uL1Blcm1pc3Npb25SdWxlRXhwbGFuYXRpb24uanMnXG5cbnR5cGUgU2tpbGxPcHRpb25WYWx1ZSA9ICd5ZXMnIHwgJ3llcy1leGFjdCcgfCAneWVzLXByZWZpeCcgfCAnbm8nXG5cbmV4cG9ydCBmdW5jdGlvbiBTa2lsbFBlcm1pc3Npb25SZXF1ZXN0KFxuICBwcm9wczogUGVybWlzc2lvblJlcXVlc3RQcm9wcyxcbik6IFJlYWN0LlJlYWN0Tm9kZSB7XG4gIGNvbnN0IHtcbiAgICB0b29sVXNlQ29uZmlybSxcbiAgICBvbkRvbmUsXG4gICAgb25SZWplY3QsXG4gICAgdmVyYm9zZTogX3ZlcmJvc2UsXG4gICAgd29ya2VyQmFkZ2UsXG4gIH0gPSBwcm9wc1xuICBjb25zdCBwYXJzZUlucHV0ID0gKGlucHV0OiB1bmtub3duKTogc3RyaW5nID0+IHtcbiAgICBjb25zdCByZXN1bHQgPSBTa2lsbFRvb2wuaW5wdXRTY2hlbWEuc2FmZVBhcnNlKGlucHV0KVxuICAgIGlmICghcmVzdWx0LnN1Y2Nlc3MpIHtcbiAgICAgIGxvZ0Vycm9yKFxuICAgICAgICBuZXcgRXJyb3IoYEZhaWxlZCB0byBwYXJzZSBza2lsbCB0b29sIGlucHV0OiAke3Jlc3VsdC5lcnJvci5tZXNzYWdlfWApLFxuICAgICAgKVxuICAgICAgcmV0dXJuICcnXG4gICAgfVxuICAgIHJldHVybiByZXN1bHQuZGF0YS5za2lsbFxuICB9XG5cbiAgY29uc3Qgc2tpbGwgPSBwYXJzZUlucHV0KHRvb2xVc2VDb25maXJtLmlucHV0KVxuXG4gIC8vIENoZWNrIGlmIHRoaXMgaXMgYSBjb21tYW5kIHVzaW5nIG1ldGFkYXRhIGZyb20gY2hlY2tQZXJtaXNzaW9uc1xuICBjb25zdCBjb21tYW5kT2JqID1cbiAgICB0b29sVXNlQ29uZmlybS5wZXJtaXNzaW9uUmVzdWx0LmJlaGF2aW9yID09PSAnYXNrJyAmJlxuICAgIHRvb2xVc2VDb25maXJtLnBlcm1pc3Npb25SZXN1bHQubWV0YWRhdGEgJiZcbiAgICAnY29tbWFuZCcgaW4gdG9vbFVzZUNvbmZpcm0ucGVybWlzc2lvblJlc3VsdC5tZXRhZGF0YVxuICAgICAgPyB0b29sVXNlQ29uZmlybS5wZXJtaXNzaW9uUmVzdWx0Lm1ldGFkYXRhLmNvbW1hbmRcbiAgICAgIDogdW5kZWZpbmVkXG5cbiAgY29uc3QgdW5hcnlFdmVudCA9IHVzZU1lbW88VW5hcnlFdmVudD4oXG4gICAgKCkgPT4gKHtcbiAgICAgIGNvbXBsZXRpb25fdHlwZTogJ3Rvb2xfdXNlX3NpbmdsZScsXG4gICAgICBsYW5ndWFnZV9uYW1lOiAnbm9uZScsXG4gICAgfSksXG4gICAgW10sXG4gIClcblxuICB1c2VQZXJtaXNzaW9uUmVxdWVzdExvZ2dpbmcodG9vbFVzZUNvbmZpcm0sIHVuYXJ5RXZlbnQpXG5cbiAgY29uc3Qgb3JpZ2luYWxDd2QgPSBnZXRPcmlnaW5hbEN3ZCgpXG4gIGNvbnN0IHNob3dBbHdheXNBbGxvd09wdGlvbnMgPSBzaG91bGRTaG93QWx3YXlzQWxsb3dPcHRpb25zKClcbiAgY29uc3Qgb3B0aW9ucyA9IHVzZU1lbW8oKCk6IFBlcm1pc3Npb25Qcm9tcHRPcHRpb248U2tpbGxPcHRpb25WYWx1ZT5bXSA9PiB7XG4gICAgY29uc3QgYmFzZU9wdGlvbnM6IFBlcm1pc3Npb25Qcm9tcHRPcHRpb248U2tpbGxPcHRpb25WYWx1ZT5bXSA9IFtcbiAgICAgIHtcbiAgICAgICAgbGFiZWw6ICdZZXMnLFxuICAgICAgICB2YWx1ZTogJ3llcycsXG4gICAgICAgIGZlZWRiYWNrQ29uZmlnOiB7IHR5cGU6ICdhY2NlcHQnIH0sXG4gICAgICB9LFxuICAgIF1cblxuICAgIC8vIE9ubHkgYWRkIFwiYWx3YXlzIGFsbG93XCIgb3B0aW9ucyB3aGVuIG5vdCByZXN0cmljdGVkIGJ5IGFsbG93TWFuYWdlZFBlcm1pc3Npb25SdWxlc09ubHlcbiAgICBjb25zdCBhbHdheXNBbGxvd09wdGlvbnM6IFBlcm1pc3Npb25Qcm9tcHRPcHRpb248U2tpbGxPcHRpb25WYWx1ZT5bXSA9IFtdXG4gICAgaWYgKHNob3dBbHdheXNBbGxvd09wdGlvbnMpIHtcbiAgICAgIC8vIEFkZCBleGFjdCBtYXRjaCBvcHRpb25cbiAgICAgIGFsd2F5c0FsbG93T3B0aW9ucy5wdXNoKHtcbiAgICAgICAgbGFiZWw6IChcbiAgICAgICAgICA8VGV4dD5cbiAgICAgICAgICAgIFllcywgYW5kIGRvbiZhcG9zO3QgYXNrIGFnYWluIGZvciA8VGV4dCBib2xkPntza2lsbH08L1RleHQ+IGlueycgJ31cbiAgICAgICAgICAgIDxUZXh0IGJvbGQ+e29yaWdpbmFsQ3dkfTwvVGV4dD5cbiAgICAgICAgICA8L1RleHQ+XG4gICAgICAgICksXG4gICAgICAgIHZhbHVlOiAneWVzLWV4YWN0JyxcbiAgICAgIH0pXG5cbiAgICAgIC8vIEFkZCBwcmVmaXggb3B0aW9uIGlmIHRoZSBza2lsbCBoYXMgYXJndW1lbnRzXG4gICAgICBjb25zdCBzcGFjZUluZGV4ID0gc2tpbGwuaW5kZXhPZignICcpXG4gICAgICBpZiAoc3BhY2VJbmRleCA+IDApIHtcbiAgICAgICAgY29uc3QgY29tbWFuZFByZWZpeCA9IHNraWxsLnN1YnN0cmluZygwLCBzcGFjZUluZGV4KVxuICAgICAgICBhbHdheXNBbGxvd09wdGlvbnMucHVzaCh7XG4gICAgICAgICAgbGFiZWw6IChcbiAgICAgICAgICAgIDxUZXh0PlxuICAgICAgICAgICAgICBZZXMsIGFuZCBkb24mYXBvczt0IGFzayBhZ2FpbiBmb3J7JyAnfVxuICAgICAgICAgICAgICA8VGV4dCBib2xkPntjb21tYW5kUHJlZml4ICsgJzoqJ308L1RleHQ+IGNvbW1hbmRzIGlueycgJ31cbiAgICAgICAgICAgICAgPFRleHQgYm9sZD57b3JpZ2luYWxDd2R9PC9UZXh0PlxuICAgICAgICAgICAgPC9UZXh0PlxuICAgICAgICAgICksXG4gICAgICAgICAgdmFsdWU6ICd5ZXMtcHJlZml4JyxcbiAgICAgICAgfSlcbiAgICAgIH1cbiAgICB9XG5cbiAgICBjb25zdCBub09wdGlvbjogUGVybWlzc2lvblByb21wdE9wdGlvbjxTa2lsbE9wdGlvblZhbHVlPiA9IHtcbiAgICAgIGxhYmVsOiAnTm8nLFxuICAgICAgdmFsdWU6ICdubycsXG4gICAgICBmZWVkYmFja0NvbmZpZzogeyB0eXBlOiAncmVqZWN0JyB9LFxuICAgIH1cblxuICAgIHJldHVybiBbLi4uYmFzZU9wdGlvbnMsIC4uLmFsd2F5c0FsbG93T3B0aW9ucywgbm9PcHRpb25dXG4gIH0sIFtza2lsbCwgb3JpZ2luYWxDd2QsIHNob3dBbHdheXNBbGxvd09wdGlvbnNdKVxuXG4gIGNvbnN0IHRvb2xBbmFseXRpY3NDb250ZXh0ID0gdXNlTWVtbyhcbiAgICAoKTogVG9vbEFuYWx5dGljc0NvbnRleHQgPT4gKHtcbiAgICAgIHRvb2xOYW1lOiBzYW5pdGl6ZVRvb2xOYW1lRm9yQW5hbHl0aWNzKHRvb2xVc2VDb25maXJtLnRvb2wubmFtZSksXG4gICAgICBpc01jcDogdG9vbFVzZUNvbmZpcm0udG9vbC5pc01jcCA/PyBmYWxzZSxcbiAgICB9KSxcbiAgICBbdG9vbFVzZUNvbmZpcm0udG9vbC5uYW1lLCB0b29sVXNlQ29uZmlybS50b29sLmlzTWNwXSxcbiAgKVxuXG4gIGNvbnN0IGhhbmRsZVNlbGVjdCA9IHVzZUNhbGxiYWNrKFxuICAgICh2YWx1ZTogU2tpbGxPcHRpb25WYWx1ZSwgZmVlZGJhY2s/OiBzdHJpbmcpID0+IHtcbiAgICAgIHN3aXRjaCAodmFsdWUpIHtcbiAgICAgICAgY2FzZSAneWVzJzpcbiAgICAgICAgICB2b2lkIGxvZ1VuYXJ5RXZlbnQoe1xuICAgICAgICAgICAgY29tcGxldGlvbl90eXBlOiAndG9vbF91c2Vfc2luZ2xlJyxcbiAgICAgICAgICAgIGV2ZW50OiAnYWNjZXB0JyxcbiAgICAgICAgICAgIG1ldGFkYXRhOiB7XG4gICAgICAgICAgICAgIGxhbmd1YWdlX25hbWU6ICdub25lJyxcbiAgICAgICAgICAgICAgbWVzc2FnZV9pZDogdG9vbFVzZUNvbmZpcm0uYXNzaXN0YW50TWVzc2FnZS5tZXNzYWdlLmlkLFxuICAgICAgICAgICAgICBwbGF0Zm9ybTogZW52LnBsYXRmb3JtLFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICB9KVxuICAgICAgICAgIHRvb2xVc2VDb25maXJtLm9uQWxsb3codG9vbFVzZUNvbmZpcm0uaW5wdXQsIFtdLCBmZWVkYmFjaylcbiAgICAgICAgICBvbkRvbmUoKVxuICAgICAgICAgIGJyZWFrXG4gICAgICAgIGNhc2UgJ3llcy1leGFjdCc6IHtcbiAgICAgICAgICB2b2lkIGxvZ1VuYXJ5RXZlbnQoe1xuICAgICAgICAgICAgY29tcGxldGlvbl90eXBlOiAndG9vbF91c2Vfc2luZ2xlJyxcbiAgICAgICAgICAgIGV2ZW50OiAnYWNjZXB0JyxcbiAgICAgICAgICAgIG1ldGFkYXRhOiB7XG4gICAgICAgICAgICAgIGxhbmd1YWdlX25hbWU6ICdub25lJyxcbiAgICAgICAgICAgICAgbWVzc2FnZV9pZDogdG9vbFVzZUNvbmZpcm0uYXNzaXN0YW50TWVzc2FnZS5tZXNzYWdlLmlkLFxuICAgICAgICAgICAgICBwbGF0Zm9ybTogZW52LnBsYXRmb3JtLFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICB9KVxuXG4gICAgICAgICAgdG9vbFVzZUNvbmZpcm0ub25BbGxvdyh0b29sVXNlQ29uZmlybS5pbnB1dCwgW1xuICAgICAgICAgICAge1xuICAgICAgICAgICAgICB0eXBlOiAnYWRkUnVsZXMnLFxuICAgICAgICAgICAgICBydWxlczogW1xuICAgICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICAgIHRvb2xOYW1lOiBTS0lMTF9UT09MX05BTUUsXG4gICAgICAgICAgICAgICAgICBydWxlQ29udGVudDogc2tpbGwsXG4gICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgXSxcbiAgICAgICAgICAgICAgYmVoYXZpb3I6ICdhbGxvdycsXG4gICAgICAgICAgICAgIGRlc3RpbmF0aW9uOiAnbG9jYWxTZXR0aW5ncycsXG4gICAgICAgICAgICB9LFxuICAgICAgICAgIF0pXG4gICAgICAgICAgb25Eb25lKClcbiAgICAgICAgICBicmVha1xuICAgICAgICB9XG4gICAgICAgIGNhc2UgJ3llcy1wcmVmaXgnOiB7XG4gICAgICAgICAgdm9pZCBsb2dVbmFyeUV2ZW50KHtcbiAgICAgICAgICAgIGNvbXBsZXRpb25fdHlwZTogJ3Rvb2xfdXNlX3NpbmdsZScsXG4gICAgICAgICAgICBldmVudDogJ2FjY2VwdCcsXG4gICAgICAgICAgICBtZXRhZGF0YToge1xuICAgICAgICAgICAgICBsYW5ndWFnZV9uYW1lOiAnbm9uZScsXG4gICAgICAgICAgICAgIG1lc3NhZ2VfaWQ6IHRvb2xVc2VDb25maXJtLmFzc2lzdGFudE1lc3NhZ2UubWVzc2FnZS5pZCxcbiAgICAgICAgICAgICAgcGxhdGZvcm06IGVudi5wbGF0Zm9ybSxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgfSlcblxuICAgICAgICAgIC8vIEV4dHJhY3QgdGhlIHNraWxsIHByZWZpeCAoZXZlcnl0aGluZyBiZWZvcmUgdGhlIGZpcnN0IHNwYWNlKVxuICAgICAgICAgIGNvbnN0IHNwYWNlSW5kZXggPSBza2lsbC5pbmRleE9mKCcgJylcbiAgICAgICAgICBjb25zdCBjb21tYW5kUHJlZml4ID1cbiAgICAgICAgICAgIHNwYWNlSW5kZXggPiAwID8gc2tpbGwuc3Vic3RyaW5nKDAsIHNwYWNlSW5kZXgpIDogc2tpbGxcblxuICAgICAgICAgIHRvb2xVc2VDb25maXJtLm9uQWxsb3codG9vbFVzZUNvbmZpcm0uaW5wdXQsIFtcbiAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgdHlwZTogJ2FkZFJ1bGVzJyxcbiAgICAgICAgICAgICAgcnVsZXM6IFtcbiAgICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgICB0b29sTmFtZTogU0tJTExfVE9PTF9OQU1FLFxuICAgICAgICAgICAgICAgICAgcnVsZUNvbnRlbnQ6IGAke2NvbW1hbmRQcmVmaXh9OipgLFxuICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgIF0sXG4gICAgICAgICAgICAgIGJlaGF2aW9yOiAnYWxsb3cnLFxuICAgICAgICAgICAgICBkZXN0aW5hdGlvbjogJ2xvY2FsU2V0dGluZ3MnLFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICBdKVxuICAgICAgICAgIG9uRG9uZSgpXG4gICAgICAgICAgYnJlYWtcbiAgICAgICAgfVxuICAgICAgICBjYXNlICdubyc6XG4gICAgICAgICAgdm9pZCBsb2dVbmFyeUV2ZW50KHtcbiAgICAgICAgICAgIGNvbXBsZXRpb25fdHlwZTogJ3Rvb2xfdXNlX3NpbmdsZScsXG4gICAgICAgICAgICBldmVudDogJ3JlamVjdCcsXG4gICAgICAgICAgICBtZXRhZGF0YToge1xuICAgICAgICAgICAgICBsYW5ndWFnZV9uYW1lOiAnbm9uZScsXG4gICAgICAgICAgICAgIG1lc3NhZ2VfaWQ6IHRvb2xVc2VDb25maXJtLmFzc2lzdGFudE1lc3NhZ2UubWVzc2FnZS5pZCxcbiAgICAgICAgICAgICAgcGxhdGZvcm06IGVudi5wbGF0Zm9ybSxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgfSlcbiAgICAgICAgICB0b29sVXNlQ29uZmlybS5vblJlamVjdChmZWVkYmFjaylcbiAgICAgICAgICBvblJlamVjdCgpXG4gICAgICAgICAgb25Eb25lKClcbiAgICAgICAgICBicmVha1xuICAgICAgfVxuICAgIH0sXG4gICAgW3Rvb2xVc2VDb25maXJtLCBvbkRvbmUsIG9uUmVqZWN0LCBza2lsbF0sXG4gIClcblxuICBjb25zdCBoYW5kbGVDYW5jZWwgPSB1c2VDYWxsYmFjaygoKSA9PiB7XG4gICAgdm9pZCBsb2dVbmFyeUV2ZW50KHtcbiAgICAgIGNvbXBsZXRpb25fdHlwZTogJ3Rvb2xfdXNlX3NpbmdsZScsXG4gICAgICBldmVudDogJ3JlamVjdCcsXG4gICAgICBtZXRhZGF0YToge1xuICAgICAgICBsYW5ndWFnZV9uYW1lOiAnbm9uZScsXG4gICAgICAgIG1lc3NhZ2VfaWQ6IHRvb2xVc2VDb25maXJtLmFzc2lzdGFudE1lc3NhZ2UubWVzc2FnZS5pZCxcbiAgICAgICAgcGxhdGZvcm06IGVudi5wbGF0Zm9ybSxcbiAgICAgIH0sXG4gICAgfSlcbiAgICB0b29sVXNlQ29uZmlybS5vblJlamVjdCgpXG4gICAgb25SZWplY3QoKVxuICAgIG9uRG9uZSgpXG4gIH0sIFt0b29sVXNlQ29uZmlybSwgb25Eb25lLCBvblJlamVjdF0pXG5cbiAgcmV0dXJuIChcbiAgICA8UGVybWlzc2lvbkRpYWxvZyB0aXRsZT17YFVzZSBza2lsbCBcIiR7c2tpbGx9XCI/YH0gd29ya2VyQmFkZ2U9e3dvcmtlckJhZGdlfT5cbiAgICAgIDxUZXh0PkNsYXVkZSBtYXkgdXNlIGluc3RydWN0aW9ucywgY29kZSwgb3IgZmlsZXMgZnJvbSB0aGlzIFNraWxsLjwvVGV4dD5cbiAgICAgIDxCb3ggZmxleERpcmVjdGlvbj1cImNvbHVtblwiIHBhZGRpbmdYPXsyfSBwYWRkaW5nWT17MX0+XG4gICAgICAgIDxUZXh0IGRpbUNvbG9yPntjb21tYW5kT2JqPy5kZXNjcmlwdGlvbn08L1RleHQ+XG4gICAgICA8L0JveD5cblxuICAgICAgPEJveCBmbGV4RGlyZWN0aW9uPVwiY29sdW1uXCI+XG4gICAgICAgIDxQZXJtaXNzaW9uUnVsZUV4cGxhbmF0aW9uXG4gICAgICAgICAgcGVybWlzc2lvblJlc3VsdD17dG9vbFVzZUNvbmZpcm0ucGVybWlzc2lvblJlc3VsdH1cbiAgICAgICAgICB0b29sVHlwZT1cInRvb2xcIlxuICAgICAgICAvPlxuICAgICAgICA8UGVybWlzc2lvblByb21wdFxuICAgICAgICAgIG9wdGlvbnM9e29wdGlvbnN9XG4gICAgICAgICAgb25TZWxlY3Q9e2hhbmRsZVNlbGVjdH1cbiAgICAgICAgICBvbkNhbmNlbD17aGFuZGxlQ2FuY2VsfVxuICAgICAgICAgIHRvb2xBbmFseXRpY3NDb250ZXh0PXt0b29sQW5hbHl0aWNzQ29udGV4dH1cbiAgICAgICAgLz5cbiAgICAgIDwvQm94PlxuICAgIDwvUGVybWlzc2lvbkRpYWxvZz5cbiAgKVxufVxuIl0sIm1hcHBpbmdzIjoiO0FBQUEsT0FBT0EsS0FBSyxJQUFJQyxXQUFXLEVBQUVDLE9BQU8sUUFBUSxPQUFPO0FBQ25ELFNBQVNDLFFBQVEsUUFBUSxrQkFBa0I7QUFDM0MsU0FBU0MsY0FBYyxRQUFRLDZCQUE2QjtBQUM1RCxTQUFTQyxHQUFHLEVBQUVDLElBQUksUUFBUSxpQkFBaUI7QUFDM0MsU0FBU0MsNEJBQTRCLFFBQVEseUNBQXlDO0FBQ3RGLFNBQVNDLGVBQWUsUUFBUSx1Q0FBdUM7QUFDdkUsU0FBU0MsU0FBUyxRQUFRLHVDQUF1QztBQUNqRSxTQUFTQyxHQUFHLFFBQVEsdUJBQXVCO0FBQzNDLFNBQVNDLDRCQUE0QixRQUFRLGlEQUFpRDtB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
