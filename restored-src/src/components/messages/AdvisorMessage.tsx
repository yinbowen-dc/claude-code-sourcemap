/**
 * AdvisorMessage.tsx
 *
 * 【在 Claude Code 系统流程中的位置】
 * 本文件负责渲染"顾问（Advisor）"相关的消息块，是 Claude Code 多代理
 * Advisor 功能的 UI 层。Advisor 是一个独立模型，负责审查对话并提供反馈。
 * 位于：消息列表 → 助手消息行 → 【Advisor 内容渲染区】
 *
 * 【主要功能】
 * 处理两大类 AdvisorBlock 的渲染：
 * 1. block.type === "server_tool_use"：渲染 Advisor 正在思考/调用工具的状态行，
 *    包含 ToolUseLoader（加载动画）、"Advising" 标签、可选的模型名称和输入摘要。
 * 2. 其他 block.content 类型（switch bb0）：
 *    - "advisor_tool_result_error"：渲染红色错误提示（Advisor 不可用）
 *    - "advisor_result"：
 *      * verbose 模式：展示完整回复文本
 *      * 普通模式：展示"✓ Advisor has reviewed... <Ctrl+O 展开>"摘要
 *    - "advisor_redacted_result"：展示"✓ Advisor has reviewed..."（无展开按钮，已脱敏）
 * 使用 _c(30) 创建 30 槽缓存数组进行精细化 memoization。
 */
import { c as _c } from "react/compiler-runtime";
import figures from 'figures';
import React from 'react';
import { Box, Text } from '../../ink.js';
import type { AdvisorBlock } from '../../utils/advisor.js';
import { renderModelName } from '../../utils/model/model.js';
import { jsonStringify } from '../../utils/slowOperations.js';
import { CtrlOToExpand } from '../CtrlOToExpand.js';
import { MessageResponse } from '../MessageResponse.js';
import { ToolUseLoader } from '../ToolUseLoader.js';
type Props = {
  block: AdvisorBlock;
  addMargin: boolean;
  resolvedToolUseIDs: Set<string>;
  erroredToolUseIDs: Set<string>;
  shouldAnimate: boolean;
  verbose: boolean;
  advisorModel?: string;
};

/**
 * AdvisorMessage 组件
 *
 * 【整体流程】
 * 1. 解构所有 props：block、addMargin、resolvedToolUseIDs、erroredToolUseIDs、
 *    shouldAnimate、verbose、advisorModel
 * 2. 使用 _c(30) 创建 30 槽缓存数组
 *
 * 【分支 A：block.type === "server_tool_use"（工具调用状态行）】
 * - 槽 0/1：依据 block.input 缓存 JSON 序列化的输入摘要
 * - 计算 t2（顶部边距 0 或 1）
 * - 槽 2/3/4：依据 block.id 和 resolvedToolUseIDs 缓存"是否已解析"布尔值
 * - t4 = !t3（isUnresolved，未解析时显示加载动画）
 * - 槽 5/6/7：依据 block.id 和 erroredToolUseIDs 缓存"是否报错"布尔值
 * - 槽 8-11：依据 shouldAnimate/isUnresolved/isError 缓存 ToolUseLoader 节点
 * - 槽 12：静态"Advising"文本节点（只创建一次）
 * - 槽 13/14：依据 advisorModel 缓存"using <模型名>"文本节点（可为 null）
 * - 槽 15/16：依据 input 缓存"· <input>"文本节点（可为 null）
 * - 槽 17-21：依据 t2/t6/t8/t9 缓存完整状态行 Box
 *
 * 【分支 B：其他 content 类型（结果渲染，labeled switch bb0）】
 * - "advisor_tool_result_error"：槽 22/23 缓存红色错误文本
 * - "advisor_result"：槽 24-26 依据 text 和 verbose 缓存结果文本
 * - "advisor_redacted_result"：槽 27 缓存静态脱敏结果文本
 * - 槽 28/29：依据 body 缓存最终 MessageResponse 容器
 */
export function AdvisorMessage(t0) {
  // React Compiler 生成的 30 槽缓存数组
  const $ = _c(30);
  // 解构所有 props
  const {
    block,
    addMargin,
    resolvedToolUseIDs,
    erroredToolUseIDs,
    shouldAnimate,
    verbose,
    advisorModel
  } = t0;

  // 【分支 A】渲染工具调用进行中的状态行
  if (block.type === "server_tool_use") {
    let t1;
    // 若 block.input 变化，重新序列化输入参数（有非空 key 时才序列化）
    if ($[0] !== block.input) {
      t1 = block.input && Object.keys(block.input).length > 0 ? jsonStringify(block.input) : null;
      $[0] = block.input; // 缓存 input 引用
      $[1] = t1;          // 缓存序列化结果
    } else {
      t1 = $[1];
    }
    const input = t1;
    // 顶部边距：addMargin 为 true 时为 1，否则为 0
    const t2 = addMargin ? 1 : 0;
    let t3;
    // 检查该工具调用是否已在 resolvedToolUseIDs 集合中（已解析完成）
    if ($[2] !== block.id || $[3] !== resolvedToolUseIDs) {
      t3 = resolvedToolUseIDs.has(block.id);
      $[2] = block.id;             // 缓存 block.id
      $[3] = resolvedToolUseIDs;   // 缓存集合引用
      $[4] = t3;                   // 缓存是否已解析
    } else {
      t3 = $[4];
    }
    // isUnresolved = !已解析，未解析时 ToolUseLoader 显示加载动画
    const t4 = !t3;
    let t5;
    // 检查该工具调用是否已在 erroredToolUseIDs 集合中（已报错）
    if ($[5] !== block.id || $[6] !== erroredToolUseIDs) {
      t5 = erroredToolUseIDs.has(block.id);
      $[5] = block.id;            // 缓存 block.id
      $[6] = erroredToolUseIDs;   // 缓存集合引用
      $[7] = t5;                  // 缓存是否报错
    } else {
      t5 = $[7];
    }
    let t6;
    // 依据 shouldAnimate/isUnresolved/isError 缓存 ToolUseLoader 节点
    if ($[8] !== shouldAnimate || $[9] !== t4 || $[10] !== t5) {
      t6 = <ToolUseLoader shouldAnimate={shouldAnimate} isUnresolved={t4} isError={t5} />;
      $[8] = shouldAnimate;
      $[9] = t4;
      $[10] = t5;
      $[11] = t6;
    } else {
      t6 = $[11];
    }
    let t7;
    // 静态"Advising"加粗文本节点，只创建一次（sentinel 检查）
    if ($[12] === Symbol.for("react.memo_cache_sentinel")) {
      t7 = <Text bold={true}>Advising</Text>;
      $[12] = t7;
    } else {
      t7 = $[12];
    }
    let t8;
    // 若 advisorModel 变化，重建"using <模型名>"节点（无模型时为 null）
    if ($[13] !== advisorModel) {
      t8 = advisorModel ? <Text dimColor={true}> using {renderModelName(advisorModel)}</Text> : null;
      $[13] = advisorModel;
      $[14] = t8;
    } else {
      t8 = $[14];
    }
    let t9;
    // 若 input 变化，重建"· <input>"节点（无输入时为 null）
    if ($[15] !== input) {
      t9 = input ? <Text dimColor={true}> · {input}</Text> : null;
      $[15] = input;
      $[16] = t9;
    } else {
      t9 = $[16];
    }
    let t10;
    // 依据 t2/t6/t8/t9 变化，重建完整状态行 Box
    if ($[17] !== t2 || $[18] !== t6 || $[19] !== t8 || $[20] !== t9) {
      t10 = <Box marginTop={t2} paddingRight={2} flexDirection="row">{t6}{t7}{t8}{t9}</Box>;
      $[17] = t2;
      $[18] = t6;
      $[19] = t8;
      $[20] = t9;
      $[21] = t10;
    } else {
      t10 = $[21];
    }
    return t10;
  }

  // 【分支 B】渲染 Advisor 返回结果
  let body;
  bb0: switch (block.content.type) {
    // 工具结果错误：渲染红色"Advisor unavailable (<错误码>)"
    case "advisor_tool_result_error":
      {
        let t1;
        // 依据 error_code 变化缓存错误文本节点
        if ($[22] !== block.content.error_code) {
          t1 = <Text color="error">Advisor unavailable ({block.content.error_code})</Text>;
          $[22] = block.content.error_code;
          $[23] = t1;
        } else {
          t1 = $[23];
        }
        body = t1;
        break bb0;
      }
    // 普通结果：verbose 模式展示完整文本，普通模式展示摘要 + CtrlOToExpand
    case "advisor_result":
      {
        let t1;
        // 依据 text 和 verbose 变化缓存结果节点
        if ($[24] !== block.content.text || $[25] !== verbose) {
          t1 = verbose ? <Text dimColor={true}>{block.content.text}</Text> : <Text dimColor={true}>{figures.tick} Advisor has reviewed the conversation and will apply the feedback <CtrlOToExpand /></Text>;
          $[24] = block.content.text;
          $[25] = verbose;
          $[26] = t1;
        } else {
          t1 = $[26];
        }
        body = t1;
        break bb0;
      }
    // 脱敏结果：只显示"✓ Advisor has reviewed..."，无展开按钮
    case "advisor_redacted_result":
      {
        let t1;
        // 静态脱敏结果节点，只创建一次
        if ($[27] === Symbol.for("react.memo_cache_sentinel")) {
          t1 = <Text dimColor={true}>{figures.tick} Advisor has reviewed the conversation and will apply the feedback</Text>;
          $[27] = t1;
        } else {
          t1 = $[27];
        }
        body = t1;
      }
  }

  let t1;
  // 依据 body 变化，重建最终 MessageResponse 容器（含右侧 padding）
  if ($[28] !== body) {
    t1 = <Box paddingRight={2}><MessageResponse>{body}</MessageResponse></Box>;
    $[28] = body;
    $[29] = t1;
  } else {
    t1 = $[29];
  }
  return t1;
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJmaWd1cmVzIiwiUmVhY3QiLCJCb3giLCJUZXh0IiwiQWR2aXNvckJsb2NrIiwicmVuZGVyTW9kZWxOYW1lIiwianNvblN0cmluZ2lmeSIsIkN0cmxPVG9FeHBhbmQiLCJNZXNzYWdlUmVzcG9uc2UiLCJUb29sVXNlTG9hZGVyIiwiUHJvcHMiLCJibG9jayIsImFkZE1hcmdpbiIsInJlc29sdmVkVG9vbFVzZUlEcyIsIlNldCIsImVycm9yZWRUb29sVXNlSURzIiwic2hvdWxkQW5pbWF0ZSIsInZlcmJvc2UiLCJhZHZpc29yTW9kZWwiLCJBZHZpc29yTWVzc2FnZSIsInQwIiwiJCIsIl9jIiwidHlwZSIsInQxIiwiaW5wdXQiLCJPYmplY3QiLCJrZXlzIiwibGVuZ3RoIiwidDIiLCJ0MyIsImlkIiwiaGFzIiwidDQiLCJ0NSIsInQ2IiwidDciLCJTeW1ib2wiLCJmb3IiLCJ0OCIsInQ5IiwidDEwIiwiYm9keSIsImJiMCIsImNvbnRlbnQiLCJlcnJvcl9jb2RlIiwidGV4dCIsInRpY2siXSwic291cmNlcyI6WyJBZHZpc29yTWVzc2FnZS50c3giXSwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IGZpZ3VyZXMgZnJvbSAnZmlndXJlcydcbmltcG9ydCBSZWFjdCBmcm9tICdyZWFjdCdcbmltcG9ydCB7IEJveCwgVGV4dCB9IGZyb20gJy4uLy4uL2luay5qcydcbmltcG9ydCB0eXBlIHsgQWR2aXNvckJsb2NrIH0gZnJvbSAnLi4vLi4vdXRpbHMvYWR2aXNvci5qcydcbmltcG9ydCB7IHJlbmRlck1vZGVsTmFtZSB9IGZyb20gJy4uLy4uL3V0aWxzL21vZGVsL21vZGVsLmpzJ1xuaW1wb3J0IHsganNvblN0cmluZ2lmeSB9IGZyb20gJy4uLy4uL3V0aWxzL3Nsb3dPcGVyYXRpb25zLmpzJ1xuaW1wb3J0IHsgQ3RybE9Ub0V4cGFuZCB9IGZyb20gJy4uL0N0cmxPVG9FeHBhbmQuanMnXG5pbXBvcnQgeyBNZXNzYWdlUmVzcG9uc2UgfSBmcm9tICcuLi9NZXNzYWdlUmVzcG9uc2UuanMnXG5pbXBvcnQgeyBUb29sVXNlTG9hZGVyIH0gZnJvbSAnLi4vVG9vbFVzZUxvYWRlci5qcydcblxudHlwZSBQcm9wcyA9IHtcbiAgYmxvY2s6IEFkdmlzb3JCbG9ja1xuICBhZGRNYXJnaW46IGJvb2xlYW5cbiAgcmVzb2x2ZWRUb29sVXNlSURzOiBTZXQ8c3RyaW5nPlxuICBlcnJvcmVkVG9vbFVzZUlEczogU2V0PHN0cmluZz5cbiAgc2hvdWxkQW5pbWF0ZTogYm9vbGVhblxuICB2ZXJib3NlOiBib29sZWFuXG4gIGFkdmlzb3JNb2RlbD86IHN0cmluZ1xufVxuXG5leHBvcnQgZnVuY3Rpb24gQWR2aXNvck1lc3NhZ2Uoe1xuICBibG9jayxcbiAgYWRkTWFyZ2luLFxuICByZXNvbHZlZFRvb2xVc2VJRHMsXG4gIGVycm9yZWRUb29sVXNlSURzLFxuICBzaG91bGRBbmltYXRlLFxuICB2ZXJib3NlLFxuICBhZHZpc29yTW9kZWwsXG59OiBQcm9wcyk6IFJlYWN0LlJlYWN0Tm9kZSB7XG4gIGlmIChibG9jay50eXBlID09PSAnc2VydmVyX3Rvb2xfdXNlJykge1xuICAgIGNvbnN0IGlucHV0ID1cbiAgICAgIGJsb2NrLmlucHV0ICYmIE9iamVjdC5rZXlzKGJsb2NrLmlucHV0KS5sZW5ndGggPiAwXG4gICAgICAgID8ganNvblN0cmluZ2lmeShibG9jay5pbnB1dClcbiAgICAgICAgOiBudWxsXG4gICAgcmV0dXJuIChcbiAgICAgIDxCb3ggbWFyZ2luVG9wPXthZGRNYXJnaW4gPyAxIDogMH0gcGFkZGluZ1JpZ2h0PXsyfSBmbGV4RGlyZWN0aW9uPVwicm93XCI+XG4gICAgICAgIDxUb29sVXNlTG9hZGVyXG4gICAgICAgICAgc2hvdWxkQW5pbWF0ZT17c2hvdWxkQW5pbWF0ZX1cbiAgICAgICAgICBpc1VucmVzb2x2ZWQ9eyFyZXNvbHZlZFRvb2xVc2VJRHMuaGFzKGJsb2NrLmlkKX1cbiAgICAgICAgICBpc0Vycm9yPXtlcnJvcmVkVG9vbFVzZUlEcy5oYXMoYmxvY2suaWQpfVxuICAgICAgICAvPlxuICAgICAgICA8VGV4dCBib2xkPkFkdmlzaW5nPC9UZXh0PlxuICAgICAgICB7YWR2aXNvck1vZGVsID8gKFxuICAgICAgICAgIDxUZXh0IGRpbUNvbG9yPiB1c2luZyB7cmVuZGVyTW9kZWxOYW1lKGFkdmlzb3JNb2RlbCl9PC9UZXh0PlxuICAgICAgICApIDogbnVsbH1cbiAgICAgICAge2lucHV0ID8gPFRleHQgZGltQ29sb3I+IMK3IHtpbnB1dH08L1RleHQ+IDogbnVsbH1cbiAgICAgIDwvQm94PlxuICAgIClcbiAgfVxuXG4gIGxldCBib2R5OiBSZWFjdC5SZWFjdE5vZGVcbiAgc3dpdGNoIChibG9jay5jb250ZW50LnR5cGUpIHtcbiAgICBjYXNlICdhZHZpc29yX3Rvb2xfcmVzdWx0X2Vycm9yJzpcbiAgICAgIGJvZHkgPSAoXG4gICAgICAgIDxUZXh0IGNvbG9yPVwiZXJyb3JcIj5cbiAgICAgICAgICBBZHZpc29yIHVuYXZhaWxhYmxlICh7YmxvY2suY29udGVudC5lcnJvcl9jb2RlfSlcbiAgICAgICAgPC9UZXh0PlxuICAgICAgKVxuICAgICAgYnJlYWtcbiAgICBjYXNlICdhZHZpc29yX3Jlc3VsdCc6XG4gICAgICBib2R5ID0gdmVyYm9zZSA/IChcbiAgICAgICAgPFRleHQgZGltQ29sb3I+e2Jsb2NrLmNvbnRlbnQudGV4dH08L1RleHQ+XG4gICAgICApIDogKFxuICAgICAgICA8VGV4dCBkaW1Db2xvcj5cbiAgICAgICAgICB7ZmlndXJlcy50aWNrfSBBZHZpc29yIGhhcyByZXZpZXdlZCB0aGUgY29udmVyc2F0aW9uIGFuZCB3aWxsIGFwcGx5XG4gICAgICAgICAgdGhlIGZlZWRiYWNrIDxDdHJsT1RvRXhwYW5kIC8+XG4gICAgICAgIDwvVGV4dD5cbiAgICAgIClcbiAgICAgIGJyZWFrXG4gICAgY2FzZSAnYWR2aXNvcl9yZWRhY3RlZF9yZXN1bHQnOlxuICAgICAgYm9keSA9IChcbiAgICAgICAgPFRleHQgZGltQ29sb3I+XG4gICAgICAgICAge2ZpZ3VyZXMudGlja30gQWR2aXNvciBoYXMgcmV2aWV3ZWQgdGhlIGNvbnZlcnNhdGlvbiBhbmQgd2lsbCBhcHBseVxuICAgICAgICAgIHRoZSBmZWVkYmFja1xuICAgICAgICA8L1RleHQ+XG4gICAgICApXG4gICAgICBicmVha1xuICB9XG5cbiAgcmV0dXJuIChcbiAgICA8Qm94IHBhZGRpbmdSaWdodD17Mn0+XG4gICAgICA8TWVzc2FnZVJlc3BvbnNlPntib2R5fTwvTWVzc2FnZVJlc3BvbnNlPlxuICAgIDwvQm94PlxuICApXG59XG4iXSwibWFwcGluZ3MiOiI7QUFBQSxPQUFPQSxPQUFPLE1BQU0sU0FBUztBQUM3QixPQUFPQyxLQUFLLE1BQU0sT0FBTztBQUN6QixTQUFTQyxHQUFHLEVBQUVDLElBQUksUUFBUSxjQUFjO0FBQ3hDLGNBQWNDLFlBQVksUUFBUSx3QkFBd0I7QUFDMUQsU0FBU0MsZUFBZSxRQUFRLDRCQUE0QjtBQUM1RCxTQUFTQyxhQUFhLFFBQVEsK0JBQStCO0FBQzdELFNBQVNDLGFBQWEsUUFBUSxxQkFBcUI7QUFDbkQsU0FBU0MsZUFBZSxRQUFRLHVCQUF1QjtBQUN2RCxTQUFTQyxhQUFhLFFBQVEscUJBQXFCO0FBRW5ELEtBQUtDLEtBQUssR0FBRztFQUNYQyxLQUFLLEVBQUVQLFlBQVk7RUFDbkJRLFNBQVMsRUFBRSxPQUFPO0VBQ2xCQyxrQkFBa0IsRUFBRUMsR0FBRyxDQUFDLE1BQU0sQ0FBQztFQUMvQkMsaUJBQWlCLEVBQUVELEdBQUcsQ0FBQyxNQUFNLENBQUM7RUFDOUJFLGFBQWEsRUFBRSxPQUFPO0VBQ3RCQyxPQUFPLEVBQUUsT0FBTztFQUNoQkMsWUFBWSxDQUFDLEVBQUUsTUFBTTtBQUN2QixDQUFDO0FBRUQsT0FBTyxTQUFBQyxlQUFBQyxFQUFBO0VBQUEsTUFBQUMsQ0FBQSxHQUFBQyxFQUFBO0VBQXdCO0lBQUFYLEtBQUE7SUFBQUMsU0FBQTtJQUFBQyxrQkFBQTtJQUFBRSxpQkFBQTtJQUFBQyxhQUFBO0lBQUFDLE9BQUE7SUFBQUM7RUFBQSxJQUFBRSxF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
