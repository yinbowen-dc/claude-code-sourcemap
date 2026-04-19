/**
 * PermissionRuleExplanation.tsx
 *
 * 【在 Claude Code 系统流程中的位置】
 * 本文件负责将权限决策原因（PermissionDecisionReason）转化为人类可读的解释文本，
 * 位于权限 UI 层的说明文字子组件层。被各类权限请求组件引用，显示在权限弹框内部。
 *
 * 【主要功能】
 * - `stringsForDecisionReason`：将 PermissionDecisionReason 映射为可渲染字符串对象
 *   - 支持 classifier / rule / hook / safetyCheck / other / workingDir 等原因类型
 *   - 特殊处理 auto-mode 分类器（themeColor='error'）和普通分类器
 *   - hook 原因在 auto 权限模式下显示 'warning' 色
 * - `PermissionRuleExplanation`：渲染权限规则说明区域
 *   - 主说明文字：使用 ThemedText（有 themeColor 时）或 <Ansi>（含 ANSI 转义序列时）渲染
 *   - 副说明文字：显示如 "/permissions to update rules" 的操作提示
 * - 通过 React Compiler (_c) 对各子树进行细粒度 memoization 优化
 */
import { c as _c } from "react/compiler-runtime";
import { feature } from 'bun:bundle';
import chalk from 'chalk';
import React from 'react';
import { Ansi, Box, Text } from '../../ink.js';
import { useAppState } from '../../state/AppState.js';
import type { PermissionDecision, PermissionDecisionReason } from '../../utils/permissions/PermissionResult.js';
import { permissionRuleValueToString } from '../../utils/permissions/permissionRuleParser.js';
import type { Theme } from '../../utils/theme.js';
import ThemedText from '../design-system/ThemedText.js';

// 导出的 Props 类型：权限决策结果 + 工具类型（用于生成人类可读说明）
export type PermissionRuleExplanationProps = {
  permissionResult: PermissionDecision;
  toolType: 'tool' | 'command' | 'edit' | 'read';
};

// 决策原因字符串对象：主说明、可选操作提示、可选主题色
type DecisionReasonStrings = {
  reasonString: string;
  configString?: string;
  /** When set, reasonString is plain text rendered with this theme color instead of <Ansi>. */
  themeColor?: keyof Theme;
};

/**
 * stringsForDecisionReason
 *
 * 将 PermissionDecisionReason 转换为可渲染的字符串对象，渲染流程：
 * 1. 若 reason 为空，直接返回 null
 * 2. 若启用 BASH_CLASSIFIER 或 TRANSCRIPT_CLASSIFIER 特性标志，且 reason.type === 'classifier'：
 *    - auto-mode 分类器：返回 error 主题色说明（强调需要手动确认）
 *    - 其他分类器：返回包含分类器名称的 Chalk 粗体说明
 * 3. 按 reason.type switch 分发：
 *    - 'rule'：显示规则值（粗体），若来源非 policySettings 则附加 "/permissions to update rules"
 *    - 'hook'：显示 hook 名（粗体）+ 可选原因 + 可选来源标签（灰色），附加 "/hooks to update"
 *    - 'safetyCheck' / 'other'：直接返回 reason.reason 原始文字
 *    - 'workingDir'：返回 reason.reason + "/permissions to update rules"
 *    - default：返回 null（未知类型）
 *
 * @param reason - 权限决策原因，可为 undefined
 * @param toolType - 工具类型字符串（用于拼接说明文字）
 * @returns 可渲染的字符串对象，或 null（无法生成说明时）
 */
function stringsForDecisionReason(reason: PermissionDecisionReason | undefined, toolType: 'tool' | 'command' | 'edit' | 'read'): DecisionReasonStrings | null {
  // reason 为空则无需说明
  if (!reason) {
    return null;
  }
  // 特性标志 BASH_CLASSIFIER / TRANSCRIPT_CLASSIFIER 开启时，处理分类器原因
  if ((feature('BASH_CLASSIFIER') || feature('TRANSCRIPT_CLASSIFIER')) && reason.type === 'classifier') {
    if (reason.classifier === 'auto-mode') {
      // auto-mode 分类器：使用 error 主题色，强调自动模式下被拦截
      return {
        reasonString: `Auto mode classifier requires confirmation for this ${toolType}.\n${reason.reason}`,
        configString: undefined,
        themeColor: 'error'
      };
    }
    // 普通分类器：使用 Chalk 粗体显示分类器名称
    return {
      reasonString: `Classifier ${chalk.bold(reason.classifier)} requires confirmation for this ${toolType}.\n${reason.reason}`,
      configString: undefined
    };
  }
  switch (reason.type) {
    case 'rule':
      // 规则类型：显示规则值（粗体），非 policySettings 来源附加配置路径提示
      return {
        reasonString: `Permission rule ${chalk.bold(permissionRuleValueToString(reason.rule.ruleValue))} requires confirmation for this ${toolType}.`,
        configString: reason.rule.source === 'policySettings' ? undefined : '/permissions to update rules'
      };
    case 'hook':
      {
        // hook 类型：可选原因拼接（":\n{reason}" 或 "."），可选来源标签（灰色 "[source]"）
        const hookReasonString = reason.reason ? `:\n${reason.reason}` : '.';
        const sourceLabel = reason.hookSource ? ` ${chalk.dim(`[${reason.hookSource}]`)}` : '';
        return {
          reasonString: `Hook ${chalk.bold(reason.hookName)} requires confirmation for this ${toolType}${hookReasonString}${sourceLabel}`,
          configString: '/hooks to update'
        };
      }
    case 'safetyCheck':
    case 'other':
      // 安全检查 / 其他类型：直接使用 reason.reason 原始文字，无配置路径
      return {
        reasonString: reason.reason,
        configString: undefined
      };
    case 'workingDir':
      // 工作目录类型：使用 reason.reason 原始文字，附加配置路径提示
      return {
        reasonString: reason.reason,
        configString: '/permissions to update rules'
      };
    default:
      // 未知类型，返回 null
      return null;
  }
}

/**
 * PermissionRuleExplanation 组件
 *
 * 权限规则说明区域，渲染流程：
 * 1. 从 AppState 读取当前权限模式（auto/manual）
 * 2. 调用 stringsForDecisionReason 生成可渲染字符串；若返回 null 则不渲染
 * 3. 计算 themeColor：
 *    - 优先使用 strings.themeColor（如 error）
 *    - 其次：当 reason.type === 'hook' 且当前权限模式为 'auto' 时，使用 'warning' 色
 * 4. 通过 React Compiler _c(11) 对三段子树分别 memoize：
 *    - 主说明文字节点：有 themeColor→ThemedText，无→<Text><Ansi>...</Ansi></Text>
 *    - 操作提示节点：有 configString→灰色 Text，无→不渲染
 *    - 最外层 Box（marginBottom=1，列方向）
 *
 * @param t0 - 组件 props（由 React Compiler 重写为单一参数形式）
 * @returns 权限规则说明节点，或 null（无法生成说明时）
 */
export function PermissionRuleExplanation(t0) {
  // React Compiler 生成的 memoization 缓存，共 11 个槽位
  const $ = _c(11);
  // 解构 props（React Compiler 将解构统一为单参数 t0）
  const {
    permissionResult,
    toolType
  } = t0;
  // 从 AppState 读取当前工具权限模式（auto / manual）
  const permissionMode = useAppState(_temp);

  // 从 permissionResult 中取出 decisionReason
  const t1 = permissionResult?.decisionReason;

  // ---- memoization 第一段：将 decisionReason 转为字符串对象 ----
  // 依赖：t1（decisionReason）、toolType
  let t2;
  if ($[0] !== t1 || $[1] !== toolType) {
    t2 = stringsForDecisionReason(t1, toolType);
    $[0] = t1;
    $[1] = toolType;
    $[2] = t2;
  } else {
    t2 = $[2];
  }
  const strings = t2;

  // 若无可渲染字符串，直接返回 null（不渲染任何内容）
  if (!strings) {
    return null;
  }

  // 计算主题色：
  // - 优先 strings.themeColor（来自 stringsForDecisionReason，如 error）
  // - 其次：hook 类型 + auto 权限模式 → warning 色
  const themeColor = strings.themeColor ?? (permissionResult?.decisionReason?.type === "hook" && permissionMode === "auto" ? "warning" : undefined);

  // ---- memoization 第二段：主说明文字节点 ----
  // 依赖：strings.reasonString、themeColor
  let t3;
  if ($[3] !== strings.reasonString || $[4] !== themeColor) {
    // 有 themeColor：用 ThemedText 渲染纯文本（无 ANSI 解析）
    // 无 themeColor：用 <Ansi> 解析 ANSI 转义序列后渲染
    t3 = themeColor ? <ThemedText color={themeColor}>{strings.reasonString}</ThemedText> : <Text><Ansi>{strings.reasonString}</Ansi></Text>;
    $[3] = strings.reasonString;
    $[4] = themeColor;
    $[5] = t3;
  } else {
    // 依赖未变，复用缓存节点
    t3 = $[5];
  }

  // ---- memoization 第三段：操作提示文字节点 ----
  // 依赖：strings.configString
  let t4;
  if ($[6] !== strings.configString) {
    // 有 configString：渲染灰色操作提示（如 "/permissions to update rules"）
    t4 = strings.configString && <Text dimColor={true}>{strings.configString}</Text>;
    $[6] = strings.configString;
    $[7] = t4;
  } else {
    // 依赖未变，复用缓存节点
    t4 = $[7];
  }

  // ---- memoization 第四段：最外层列方向容器 ----
  // 依赖：t3（主说明节点）、t4（操作提示节点）
  let t5;
  if ($[8] !== t3 || $[9] !== t4) {
    // marginBottom=1 保证与下方内容间距，列方向依次渲染主说明和操作提示
    t5 = <Box marginBottom={1} flexDirection="column">{t3}{t4}</Box>;
    $[8] = t3;
    $[9] = t4;
    $[10] = t5;
  } else {
    // 依赖未变，复用缓存节点
    t5 = $[10];
  }
  return t5;
}

/**
 * _temp
 *
 * useAppState 的 selector 函数，提取到模块顶层以保持引用稳定（避免每次渲染创建新函数）。
 * 返回 AppState 中 toolPermissionContext.mode 字段，即当前工具权限模式（auto / manual）。
 *
 * @param s - AppState 完整状态对象
 * @returns toolPermissionContext.mode 字符串
 */
function _temp(s) {
  return s.toolPermissionContext.mode;
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJmZWF0dXJlIiwiY2hhbGsiLCJSZWFjdCIsIkFuc2kiLCJCb3giLCJUZXh0IiwidXNlQXBwU3RhdGUiLCJQZXJtaXNzaW9uRGVjaXNpb24iLCJQZXJtaXNzaW9uRGVjaXNpb25SZWFzb24iLCJwZXJtaXNzaW9uUnVsZVZhbHVlVG9TdHJpbmciLCJUaGVtZSIsIlRoZW1lZFRleHQiLCJQZXJtaXNzaW9uUnVsZUV4cGxhbmF0aW9uUHJvcHMiLCJwZXJtaXNzaW9uUmVzdWx0IiwidG9vbFR5cGUiLCJEZWNpc2lvblJlYXNvblN0cmluZ3MiLCJyZWFzb25TdHJpbmciLCJjb25maWdTdHJpbmciLCJ0aGVtZUNvbG9yIiwic3RyaW5nc0ZvckRlY2lzaW9uUmVhc29uIiwicmVhc29uIiwidHlwZSIsImNsYXNzaWZpZXIiLCJ1bmRlZmluZWQiLCJib2xkIiwicnVsZSIsInJ1bGVWYWx1ZSIsInNvdXJjZSIsImhvb2tSZWFzb25TdHJpbmciLCJzb3VyY2VMYWJlbCIsImhvb2tTb3VyY2UiLCJkaW0iLCJob29rTmFtZSIsIlBlcm1pc3Npb25SdWxlRXhwbGFuYXRpb24iLCJ0MCIsIiQiLCJfYyIsInBlcm1pc3Npb25Nb2RlIiwiX3RlbXAiLCJ0MSIsImRlY2lzaW9uUmVhc29uIiwidDIiLCJzdHJpbmdzIiwidDMiLCJ0NCIsInQ1IiwicyIsInRvb2xQZXJtaXNzaW9uQ29udGV4dCIsIm1vZGUiXSwic291cmNlcyI6WyJQZXJtaXNzaW9uUnVsZUV4cGxhbmF0aW9uLnRzeCJdLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyBmZWF0dXJlIH0gZnJvbSAnYnVuOmJ1bmRsZSdcbmltcG9ydCBjaGFsayBmcm9tICdjaGFsaydcbmltcG9ydCBSZWFjdCBmcm9tICdyZWFjdCdcbmltcG9ydCB7IEFuc2ksIEJveCwgVGV4dCB9IGZyb20gJy4uLy4uL2luay5qcydcbmltcG9ydCB7IHVzZUFwcFN0YXRlIH0gZnJvbSAnLi4vLi4vc3RhdGUvQXBwU3RhdGUuanMnXG5pbXBvcnQgdHlwZSB7XG4gIFBlcm1pc3Npb25EZWNpc2lvbixcbiAgUGVybWlzc2lvbkRlY2lzaW9uUmVhc29uLFxufSBmcm9tICcuLi8uLi91dGlscy9wZXJtaXNzaW9ucy9QZXJtaXNzaW9uUmVzdWx0LmpzJ1xuaW1wb3J0IHsgcGVybWlzc2lvblJ1bGVWYWx1ZVRvU3RyaW5nIH0gZnJvbSAnLi4vLi4vdXRpbHMvcGVybWlzc2lvbnMvcGVybWlzc2lvblJ1bGVQYXJzZXIuanMnXG5pbXBvcnQgdHlwZSB7IFRoZW1lIH0gZnJvbSAnLi4vLi4vdXRpbHMvdGhlbWUuanMnXG5pbXBvcnQgVGhlbWVkVGV4dCBmcm9tICcuLi9kZXNpZ24tc3lzdGVtL1RoZW1lZFRleHQuanMnXG5cbmV4cG9ydCB0eXBlIFBlcm1pc3Npb25SdWxlRXhwbGFuYXRpb25Qcm9wcyA9IHtcbiAgcGVybWlzc2lvblJlc3VsdDogUGVybWlzc2lvbkRlY2lzaW9uXG4gIHRvb2xUeXBlOiAndG9vbCcgfCAnY29tbWFuZCcgfCAnZWRpdCcgfCAncmVhZCdcbn1cblxudHlwZSBEZWNpc2lvblJlYXNvblN0cmluZ3MgPSB7XG4gIHJlYXNvblN0cmluZzogc3RyaW5nXG4gIGNvbmZpZ1N0cmluZz86IHN0cmluZ1xuICAvKiogV2hlbiBzZXQsIHJlYXNvblN0cmluZyBpcyBwbGFpbiB0ZXh0IHJlbmRlcmVkIHdpdGggdGhpcyB0aGVtZSBjb2xvciBpbnN0ZWFkIG9mIDxBbnNpPi4gKi9cbiAgdGhlbWVDb2xvcj86IGtleW9mIFRoZW1lXG59XG5cbmZ1bmN0aW9uIHN0cmluZ3NGb3JEZWNpc2lvblJlYXNvbihcbiAgcmVhc29uOiBQZXJtaXNzaW9uRGVjaXNpb25SZWFzb24gfCB1bmRlZmluZWQsXG4gIHRvb2xUeXBlOiAndG9vbCcgfCAnY29tbWFuZCcgfCAnZWRpdCcgfCAncmVhZCcsXG4pOiBEZWNpc2lvblJlYXNvblN0cmluZ3MgfCBudWxsIHtcbiAgaWYgKCFyZWFzb24pIHtcbiAgICByZXR1cm4gbnVsbFxuICB9XG4gIGlmIChcbiAgICAoZmVhdHVyZSgnQkFTSF9DTEFTU0lGSUVSJykgfHwgZmVhdHVyZSgnVFJBTlNDUklQVF9DTEFTU0lGSUVSJykpICYmXG4gICAgcmVhc29uLnR5cGUgPT09ICdjbGFzc2lmaWVyJ1xuICApIHtcbiAgICBpZiAocmVhc29uLmNsYXNzaWZpZXIgPT09ICdhdXRvLW1vZGUnKSB7XG4gICAgICByZXR1cm4ge1xuICAgICAgICByZWFzb25TdHJpbmc6IGBBdXRvIG1vZGUgY2xhc3NpZmllciByZXF1aXJlcyBjb25maXJtYXRpb24gZm9yIHRoaXMgJHt0b29sVHlwZX0uXFxuJHtyZWFzb24ucmVhc29ufWAsXG4gICAgICAgIGNvbmZpZ1N0cmluZzogdW5kZWZpbmVkLFxuICAgICAgICB0aGVtZUNvbG9yOiAnZXJyb3InLFxuICAgICAgfVxuICAgIH1cbiAgICByZXR1cm4ge1xuICAgICAgcmVhc29uU3RyaW5nOiBgQ2xhc3NpZmllciAke2NoYWxrLmJvbGQocmVhc29uLmNsYXNzaWZpZXIpfSByZXF1aXJlcyBjb25maXJtYXRpb24gZm9yIHRoaXMgJHt0b29sVHlwZX0uXFxuJHtyZWFzb24ucmVhc29ufWAsXG4gICAgICBjb25maWdTdHJpbmc6IHVuZGVmaW5lZCxcbiAgICB9XG4gIH1cbiAgc3dpdGNoIChyZWFzb24udHlwZSkge1xuICAgIGNhc2UgJ3J1bGUnOlxuICAgICAgcmV0dXJuIHtcbiAgICAgICAgcmVhc29uU3RyaW5nOiBgUGVybWlzc2lvbiBydWxlICR7Y2hhbGsuYm9sZChcbiAgICAgICAgICBwZXJtaXNzaW9uUnVsZVZhbHVlVG9TdHJpbmcocmVhc29uLnJ1bGUucnVsZVZhbHVlKSxcbiAgICAgICAgKX0gcmVxdWlyZXMgY29uZmlybWF0aW9uIGZvciB0aGlzICR7dG9vbFR5cGV9LmAsXG4gICAgICAgIGNvbmZpZ1N0cmluZzpcbiAgICAgICAgICByZWFzb24ucnVsZS5zb3VyY2UgPT09ICdwb2xpY3lTZXR0aW5ncydcbiAgICAgICAgICAgID8gdW5kZWZpbmVkXG4gICAgICAgICAgICA6ICcvcGVybWlzc2lvbnMgdG8gdXBkYXRlIHJ1bGVzJyxcbiAgICAgIH1cbiAgICBjYXNlICdob29rJzoge1xuICAgICAgY29uc3QgaG9va1JlYXNvblN0cmluZyA9IHJlYXNvbi5yZWFzb24gPyBgOlxcbiR7cmVhc29uLnJlYXNvbn1gIDogJy4nXG4gICAgICBjb25zdCBzb3VyY2VMYWJlbCA9IHJlYXNvbi5ob29rU291cmNlXG4gICAgICAgID8gYCAke2NoYWxrLmRpbShgWyR7cmVhc29uLmhvb2tTb3VyY2V9XWApfWBcbiAgICAgICAgOiAnJ1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgcmVhc29uU3RyaW5nOiBgSG9vayAke2NoYWxrLmJvbGQocmVhc29uLmhvb2tOYW1lKX0gcmVxdWlyZXMgY29uZmlybWF0aW9uIGZvciB0aGlzICR7dG9vbFR5cGV9JHtob29rUmVhc29uU3RyaW5nfSR7c291cmNlTGFiZWx9YCxcbiAgICAgICAgY29uZmlnU3RyaW5nOiAnL2hvb2tzIHRvIHVwZGF0ZScsXG4gICAgICB9XG4gICAgfVxuICAgIGNhc2UgJ3NhZmV0eUNoZWNrJzpcbiAgICBjYXNlICdvdGhlcic6XG4gICAgICByZXR1cm4ge1xuICAgICAgICByZWFzb25TdHJpbmc6IHJlYXNvbi5yZWFzb24sXG4gICAgICAgIGNvbmZpZ1N0cmluZzogdW5kZWZpbmVkLFxuICAgICAgfVxuICAgIGNhc2UgJ3dvcmtpbmdEaXInOlxuICAgICAgcmV0dXJuIHtcbiAgICAgICAgcmVhc29uU3RyaW5nOiByZWFzb24ucmVhc29uLFxuICAgICAgICBjb25maWdTdHJpbmc6ICcvcGVybWlzc2lvbnMgdG8gdXBkYXRlIHJ1bGVzJyxcbiAgICAgIH1cbiAgICBkZWZhdWx0OlxuICAgICAgcmV0dXJuIG51bGxcbiAgfVxufVxuXG5leHBvcnQgZnVuY3Rpb24gUGVybWlzc2lvblJ1bGVFeHBsYW5hdGlvbih7XG4gIHBlcm1pc3Npb25SZXN1bHQsXG4gIHRvb2xUeXBlLFxufTogUGVybWlzc2lvblJ1bGVFeHBsYW5hdGlvblByb3BzKTogUmVhY3QuUmVhY3ROb2RlIHtcbiAgY29uc3QgcGVybWlzc2lvbk1vZGUgPSB1c2VBcHBTdGF0ZShzID0+IHMudG9vbFBlcm1pc3Npb25Db250ZXh0Lm1vZGUpXG4gIGNvbnN0IHN0cmluZ3MgPSBzdHJpbmdzRm9yRGVjaXNpb25SZWFzb24oXG4gICAgcGVybWlzc2lvblJlc3VsdD8uZGVjaXNpb25SZWFzb24sXG4gICAgdG9vbFR5cGUsXG4gIClcbiAgaWYgKCFzdHJpbmdzKSB7XG4gICAgcmV0dXJuIG51bGxcbiAgfVxuXG4gIGNvbnN0IHRoZW1lQ29sb3IgPVxuICAgIHN0cmluZ3MudGhlbWVDb2xvciA/P1xuICAgIChwZXJtaXNzaW9uUmVzdWx0Py5kZWNpc2lvblJlYXNvbj8udHlwZSA9PT0gJ2hvb2snICYmXG4gICAgcGVybWlzc2lvbk1vZGUgPT09ICdhdXRvJ1xuICAgICAgPyAnd2FybmluZydcbiAgICAgIDogdW5kZWZpbmVkKVxuXG4gIHJldHVybiAoXG4gICAgPEJveCBtYXJnaW5Cb3R0b209ezF9IGZsZXhEaXJlY3Rpb249XCJjb2x1bW5cIj5cbiAgICAgIHt0aGVtZUNvbG9yID8gKFxuICAgICAgICA8VGhlbWVkVGV4dCBjb2xvcj17dGhlbWVDb2xvcn0+e3N0cmluZ3MucmVhc29uU3RyaW5nfTwvVGhlbWVkVGV4dD5cbiAgICAgICkgOiAoXG4gICAgICAgIDxUZXh0PlxuICAgICAgICAgIDxBbnNpPntzdHJpbmdzLnJlYXNvblN0cmluZ308L0Fuc2k+XG4gICAgICAgIDwvVGV4dD5cbiAgICAgICl9XG4gICAgICB7c3RyaW5ncy5jb25maWdTdHJpbmcgJiYgPFRleHQgZGltQ29sb3I+e3N0cmluZ3MuY29uZmlnU3RyaW5nfTwvVGV4dD59XG4gICAgPC9Cb3g+XG4gIClcbn1cbiJdLCJtYXBwaW5ncyI6IjtBQUFBLFNBQVNBLE9BQU8sUUFBUSxZQUFZO0FBQ3BDLE9BQU9DLEtBQUssTUFBTSxPQUFPO0FBQ3pCLE9BQU9DLEtBQUssTUFBTSxPQUFPO0FBQ3pCLFNBQVNDLElBQUksRUFBRUMs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
